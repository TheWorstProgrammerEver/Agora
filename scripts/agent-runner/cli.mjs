#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { loadRunnerConfig, loadStateDirectory } from './config.mjs'
import { DurableRunnerStore } from './durable-store.mjs'
import { createRunnerLogger, errorCodeFor } from './redacted-log.mjs'
import { createAgoraRunner, withExclusiveRunner } from './runner.mjs'
import { resetFailedLeases } from './state-machine.mjs'
import { runnerStatus } from './status.mjs'
import { acquireRuntimeStateCoordinator } from '../runtime-state-coordinator.mjs'

const usage = `Usage:
  agora-agent-runner run
  agora-agent-runner poll
  agora-agent-runner status
  agora-agent-runner retry-failed
`

const installationCheck = () => {
  process.stdout.write(`${JSON.stringify({
    entrypoint: 'canonical',
    runner: 'agora-agent-runner',
    version: 1
  })}\n`)
}

const runStatus = async (environment) => {
  const store = new DurableRunnerStore(loadStateDirectory(environment))
  await store.initialize()
  process.stdout.write(`${JSON.stringify(runnerStatus(await store.read()), null, 2)}\n`)
}

const retryFailed = async (environment) => {
  const store = new DurableRunnerStore(loadStateDirectory(environment))
  await store.initialize()
  const release = await acquireRuntimeStateCoordinator(store.statePath, {
    busyMessage: 'Agora agent runner is already active.',
    timeoutMs: 1000
  })
  try {
    const reset = await store.update(resetFailedLeases)
    process.stdout.write(`${JSON.stringify({ reset })}\n`)
  } finally {
    await release()
  }
}

const runWorker = async (mode, environment) => {
  const config = loadRunnerConfig(environment)
  const logger = createRunnerLogger()
  const runner = createAgoraRunner({ config, logger })
  const controller = new AbortController()
  const stop = () => controller.abort()

  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    await withExclusiveRunner(runner, () => (
      mode === 'realtime'
        ? runner.runRealtime(controller.signal)
        : runner.runOnce(controller.signal)
    ))
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}

export const main = async (
  args = process.argv.slice(2),
  environment = process.env
) => {
  process.umask(0o077)
  const [command, ...rest] = args

  if (rest.length > 0) throw new Error('Agora runner arguments are invalid.')
  if (command === 'run') return runWorker('realtime', environment)
  if (command === 'poll') return runWorker('poll', environment)
  if (command === 'status') return runStatus(environment)
  if (command === 'retry-failed') return retryFailed(environment)
  if (command === 'installation-check') return installationCheck()
  if (command === '--help' || command === '-h') {
    process.stdout.write(usage)
    return
  }

  throw new Error('Agora runner command is required.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const code = errorCodeFor(error)
    process.stderr.write(`${JSON.stringify({ code, event: 'runner_exit' })}\n`)
    process.exitCode = code === 'canceled' ? 0 : 1
  })
}
