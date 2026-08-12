import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { acquireRuntimeStateCoordinator } from '../runtime-state-coordinator.mjs'
import { createAgoraApiClient, AgoraApiError } from './api-client.mjs'
import { abortableDelay, RunnerCanceledError, throwIfAborted } from './abort.mjs'
import {
  acknowledgeRange,
  fetchExactChunk,
  reconcileSnapshot,
  sendPlannedMessages
} from './agora-operations.mjs'
import { runCodexHandler, HandlerExecutionError } from './codex-handler.mjs'
import { startContextBroker } from './context-broker.mjs'
import { readAgentCredential } from './credential.mjs'
import { DurableRunnerStore } from './durable-store.mjs'
import { selectHandlerProfile } from './handler-profile.mjs'
import { settleRecoveredHandler } from './handler-process.mjs'
import { buildHandlerPrompt } from './prompt.mjs'
import { connectRealtime, earliestRefreshAt } from './realtime-transport.mjs'
import { errorCodeFor, opaqueLabel } from './redacted-log.mjs'
import {
  attachPlan,
  commitLease,
  commitSelfOnlyLease,
  createDurablePlan,
  failLease,
  markLeaseHandling,
  observeHighWatermark,
  prepareLease,
  reconcileGroups,
  recoverLease,
  releaseUnplannedLease,
  renewLease
} from './state-machine.mjs'

const apiCliPath = fileURLToPath(new URL('./context-cli.mjs', import.meta.url))
const activity = (status, code) => ({
  at: new Date().toISOString(),
  code,
  status
})

const retryAt = (config, attempt) => new Date(
  Date.now() + config.retryBaseMs * (2 ** Math.max(0, attempt - 1))
).toISOString()

const leaseExpiresAt = (config) => new Date(Date.now() + config.leaseDurationMs).toISOString()

class WakeLatch {
  #pending = false
  #resolve

  notify() {
    this.#pending = true
    this.#resolve?.()
  }

  async wait(milliseconds, signal) {
    if (this.#pending) {
      this.#pending = false
      return
    }

    await new Promise((resolve, reject) => {
      let settled = false
      const finish = (callback) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.#resolve = undefined
        callback()
      }
      const onAbort = () => finish(() => reject(new RunnerCanceledError()))
      const timer = setTimeout(() => finish(resolve), Math.max(0, milliseconds))
      this.#resolve = () => finish(resolve)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
    })
    this.#pending = false
  }
}

export class AgoraRunner {
  constructor({
    api,
    config,
    handler = runCodexHandler,
    logger,
    realtimeConnector = connectRealtime,
    store = new DurableRunnerStore(config.stateDirectory)
  }) {
    this.api = api
    this.config = config
    this.handler = handler
    this.logger = logger
    this.realtimeConnector = realtimeConnector
    this.runId = randomUUID()
    this.store = store
  }

  async initialize({ storeReady = false } = {}) {
    if (!storeReady) await this.store.initialize()
    await this.store.update((state) => {
      state.lastActivity = activity('starting', 'startup')
    })
    const state = await this.store.read()

    for (const [groupId, group] of Object.entries(state.groups)) {
      if (group.lease?.ownerRunId === this.runId) continue
      await settleRecoveredHandler(group.lease?.child)
      await this.store.update((current) => recoverLease(current, groupId, {
        leaseDurationMs: this.config.leaseDurationMs,
        maximumAttempts: this.config.maximumHandlerAttempts,
        now: Date.now(),
        ownerPid: process.pid,
        ownerRunId: this.runId,
        retryAt: new Date().toISOString()
      }))
    }

    await this.store.cleanupInterruptedFiles()
    await this.store.cleanupOrphanPlans(await this.store.read())
  }

  async refresh(signal) {
    const snapshot = await reconcileSnapshot(this.api, signal)
    const previous = await this.store.read()
    const principalId = snapshot.principalId ?? previous.principalId

    if (!principalId) return snapshot
    const removedPlans = await this.store.update((state) => reconcileGroups(state, {
      groups: snapshot.groups,
      principalId
    }))
    await Promise.all(removedPlans.map((chunkId) => this.store.deletePlan(chunkId)))
    return { ...snapshot, principalId }
  }

  async observe(groupId, highWatermarkSequence) {
    const changed = await this.store.update((state) => (
      observeHighWatermark(state, groupId, highWatermarkSequence)
    ))
    if (changed) {
      this.logger.event('watermark_observed', { group: opaqueLabel(groupId) })
    }
    return changed
  }

  async #markFailure(groupId, lease, code) {
    return this.store.update((state) => {
      const current = state.groups[groupId]?.lease
      if (!current || current.chunkId !== lease.chunkId || current.phase === 'planned') {
        return current ? { phase: current.phase, retryAt: current.retryAt } : undefined
      }
      failLease(state, groupId, lease.chunkId, this.runId, {
        code,
        maximumAttempts: this.config.maximumHandlerAttempts,
        retryAt: retryAt(this.config, lease.attempt)
      })
      return {
        phase: state.groups[groupId].lease.phase,
        retryAt: state.groups[groupId].lease.retryAt
      }
    })
  }

  async #executePlan(groupId, lease, principalId, signal) {
    const plan = await this.store.readPlan(lease.chunkId, lease.plan.digest)
    if (plan.groupId !== groupId
      || plan.fromExclusive !== lease.fromExclusive
      || plan.through !== lease.through
      || plan.messages.length !== lease.plan.actionCount) {
      throw new Error('Agora runner durable plan does not match its lease.')
    }

    await sendPlannedMessages(this.api, {
      chunkId: lease.chunkId,
      groupId,
      messages: plan.messages,
      principalId
    }, signal)
    await acknowledgeRange(this.api, groupId, lease.through, signal)
    await this.store.update((state) => commitLease(
      state,
      groupId,
      lease.chunkId,
      this.runId
    ))
    await this.store.deletePlan(lease.chunkId)
    this.logger.event('chunk_committed', {
      actions: plan.messages.length,
      group: opaqueLabel(groupId),
      through: lease.through
    })
  }

  async #handleLease(groupId, lease, principalId, signal) {
    if (lease.phase === 'planned') {
      await this.#executePlan(groupId, lease, principalId, signal)
      return
    }

    let messages
    try {
      messages = await fetchExactChunk(this.api, groupId, lease, signal)
    } catch (error) {
      if (error instanceof AgoraApiError) {
        await this.store.update((state) => releaseUnplannedLease(
          state,
          groupId,
          lease.chunkId,
          this.runId
        ))
        throw error
      }
      const failure = await this.#markFailure(groupId, lease, 'range_unavailable')
      if (error instanceof RunnerCanceledError) throw error
      if (failure?.phase === 'retryable') {
        await abortableDelay(Math.max(0, Date.parse(failure.retryAt) - Date.now()), signal)
        return
      }
      throw error
    }

    if (messages.every(({ sender }) => sender.id === principalId)) {
      try {
        await acknowledgeRange(this.api, groupId, lease.through, signal)
        await this.store.update((state) => commitSelfOnlyLease(
          state,
          groupId,
          lease.chunkId,
          this.runId
        ))
        this.logger.event('self_chunk_committed', {
          group: opaqueLabel(groupId),
          through: lease.through
        })
        return
      } catch (error) {
        if (error instanceof AgoraApiError) {
          await this.store.update((state) => releaseUnplannedLease(
            state,
            groupId,
            lease.chunkId,
            this.runId
          ))
          throw error
        }
        await this.#markFailure(groupId, lease, 'range_unavailable')
        throw error
      }
    }

    const context = {
      agentPrincipalId: principalId,
      chunkId: lease.chunkId,
      cursor: lease.fromExclusive,
      groupId,
      messages,
      through: lease.through
    }
    const profile = selectHandlerProfile(messages, this.config)
    const prompt = await buildHandlerPrompt({
      apiCli: {
        arguments: [apiCliPath, 'get-group-messages'],
        executable: process.execPath
      },
      context,
      profile,
      promptPath: this.config.handlerPromptPath
    })
    const outputPath = this.store.handlerOutputPath(lease.chunkId)
    let contextAccess

    try {
      contextAccess = await startContextBroker({ api: this.api, groupId, signal })
      const output = await this.handler({
        config: this.config,
        context,
        contextAccess,
        onHeartbeat: () => this.store.update((state) => renewLease(
          state,
          groupId,
          lease.chunkId,
          this.runId,
          leaseExpiresAt(this.config)
        )),
        onStarted: (identity) => this.store.update((state) => markLeaseHandling(
          state,
          groupId,
          lease.chunkId,
          this.runId,
          identity,
          leaseExpiresAt(this.config)
        )),
        outputPath,
        profile,
        prompt,
        signal
      })
      if (output.messages.some(({ text }) => text.includes(contextAccess.capability))) {
        throw new HandlerExecutionError('handler_output_invalid')
      }
      await contextAccess.close()
      contextAccess = undefined
      const durablePlan = createDurablePlan(lease, groupId, output.messages)
      const planIdentity = await this.store.writePlan(durablePlan)
      await this.store.update((state) => attachPlan(
        state,
        groupId,
        lease.chunkId,
        this.runId,
        planIdentity
      ))
      const plannedLease = (await this.store.read()).groups[groupId].lease
      await this.#executePlan(groupId, plannedLease, principalId, signal)
    } catch (error) {
      if (!(error instanceof AgoraApiError)) {
        const code = error instanceof RunnerCanceledError
          ? 'canceled'
          : error instanceof HandlerExecutionError
            ? error.code
            : 'handler_failed'
        const failure = await this.#markFailure(groupId, lease, code)
        if (error instanceof RunnerCanceledError) throw error
        if (failure?.phase === 'retryable') {
          await abortableDelay(Math.max(0, Date.parse(failure.retryAt) - Date.now()), signal)
          return
        }
      }
      throw error
    } finally {
      await contextAccess?.close()
      await this.store.removeHandlerOutput(outputPath)
    }
  }

  async processAvailable(principalId, signal) {
    const state = await this.store.read()
    let handlerFailure

    for (const groupId of Object.keys(state.groups).sort()) {
      while (true) {
        throwIfAborted(signal)
        const lease = await this.store.update((current) => prepareLease(current, groupId, {
          chunkSize: this.config.chunkSize,
          leaseDurationMs: this.config.leaseDurationMs,
          maximumAttempts: this.config.maximumHandlerAttempts,
          now: Date.now(),
          ownerPid: process.pid,
          ownerRunId: this.runId
        }))
        if (!lease) break

        try {
          await this.#handleLease(groupId, lease, principalId, signal)
        } catch (error) {
          if (error instanceof HandlerExecutionError) {
            handlerFailure = error
            break
          }
          throw error
        }
      }
    }

    const failed = Object.values((await this.store.read()).groups).some((group) => (
      group.lease?.phase === 'failed'
    ))
    if (failed) throw handlerFailure ?? new HandlerExecutionError('handler_failed')
  }

  async runOnce(signal) {
    const snapshot = await this.refresh(signal)
    if (snapshot.principalId) await this.processAvailable(snapshot.principalId, signal)
    await this.store.update((state) => {
      state.lastActivity = activity('healthy', 'poll_complete')
    })
  }

  async runRealtime(signal) {
    let retryAttempt = 0
    let shutdownCleanupFailed = false

    while (!signal.aborted) {
      let closeRealtime = async () => undefined
      try {
        const snapshot = await this.refresh(signal)
        const wake = new WakeLatch()
        let disconnected = false

        if (snapshot.sessions.length > 0) {
          closeRealtime = await this.realtimeConnector({
            onDisconnect: () => {
              disconnected = true
              wake.notify()
            },
            onWatermark: async (groupId, sequence) => {
              if (await this.observe(groupId, sequence)) wake.notify()
            },
            publishableKey: this.config.publishableKey,
            sessions: snapshot.sessions,
            signal,
            supabaseUrl: this.config.supabaseUrl
          })
        }

        if (snapshot.principalId) await this.processAvailable(snapshot.principalId, signal)
        await this.store.update((state) => {
          state.lastActivity = activity('healthy', 'realtime_connected')
        })
        retryAttempt = 0
        const refreshAt = snapshot.sessions.length > 0
          ? earliestRefreshAt(snapshot.sessions)
          : Number.POSITIVE_INFINITY
        const deadline = Math.min(Date.now() + this.config.pollIntervalMs, refreshAt)

        while (!disconnected && Date.now() < deadline) {
          await wake.wait(deadline - Date.now(), signal)
          if (!disconnected && snapshot.principalId) {
            await this.processAvailable(snapshot.principalId, signal)
          }
        }
      } catch (error) {
        if (error instanceof RunnerCanceledError || signal.aborted) break
        retryAttempt = Math.min(retryAttempt + 1, 6)
        const code = errorCodeFor(error)
        this.logger.event('runner_degraded', { code })
        await this.store.update((state) => {
          state.lastActivity = activity('degraded', code)
        })
        await abortableDelay(
          Math.min(30_000, this.config.retryBaseMs * (2 ** (retryAttempt - 1))),
          signal
        ).catch((delayError) => {
          if (!(delayError instanceof RunnerCanceledError)) throw delayError
        })
      } finally {
        try {
          await closeRealtime()
        } catch {
          shutdownCleanupFailed = true
          this.logger.event('realtime_cleanup_failed')
        }
      }
    }

    await this.store.update((state) => {
      state.lastActivity = activity(
        'stopped',
        shutdownCleanupFailed ? 'shutdown_cleanup_failed' : 'shutdown'
      )
    })
  }
}

export const createAgoraRunner = ({ config, logger, ...overrides }) => {
  const api = overrides.api ?? createAgoraApiClient({
    apiUrl: config.apiUrl,
    credentialReader: () => readAgentCredential(config.credentialDirectory),
    maximumAttempts: config.maximumRequestAttempts,
    publishableKey: config.publishableKey,
    retryBaseMs: config.retryBaseMs,
    timeoutMs: config.apiTimeoutMs
  })
  return new AgoraRunner({ api, config, logger, ...overrides })
}

export const withExclusiveRunner = async (runner, operation) => {
  await runner.store.initialize()
  const release = await acquireRuntimeStateCoordinator(runner.store.statePath, {
    busyMessage: 'Agora agent runner is already active.',
    timeoutMs: 1000
  })
  try {
    await runner.initialize({ storeReady: true })
    return await operation()
  } finally {
    await release()
  }
}
