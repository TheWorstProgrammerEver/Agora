import { randomBytes } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  writeFileSync
} from 'node:fs'
import { platform } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  isProcessExecuting,
  readProcessIdentity,
  stableProcessIdentityMatches
} from './process-identity.mjs'
import { withRuntimeStateCoordinator } from './runtime-state-coordinator.mjs'

const runtimeDirectory = fileURLToPath(new URL('../.agora-runtime/', import.meta.url))
const runtimeStatePath = fileURLToPath(new URL('../.agora-runtime/get-going.json', import.meta.url))
const processMarkerPattern = /^agora:[a-f0-9]{16}$/
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const validateRuntimeIdentity = (value) => {
  if (
    typeof value !== 'object'
    || value === null
    || !Number.isSafeInteger(value.pid)
    || value.pid <= 1
    || typeof value.marker !== 'string'
    || !processMarkerPattern.test(value.marker)
  ) {
    throw new Error('Agora managed-runtime state is malformed; refusing to signal any process.')
  }

  if (value.version === 1) {
    return {
      marker: value.marker,
      pid: value.pid,
      version: value.version
    }
  }

  if (
    value.version === 2
    && value.platform === 'linux'
    && typeof value.bootId === 'string'
    && /^[a-f0-9-]{16,64}$/.test(value.bootId)
    && typeof value.startTimeTicks === 'string'
    && /^\d+$/.test(value.startTimeTicks)
  ) {
    return {
      bootId: value.bootId,
      marker: value.marker,
      pid: value.pid,
      platform: value.platform,
      startTimeTicks: value.startTimeTicks,
      version: value.version
    }
  }

  if (
    value.version === 2
    && value.platform === 'darwin'
    && typeof value.startTime === 'string'
    && /^\S{3}\s+\S{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/.test(value.startTime)
  ) {
    return {
      marker: value.marker,
      pid: value.pid,
      platform: value.platform,
      startTime: value.startTime,
      version: value.version
    }
  }

  throw new Error('Agora managed-runtime state is malformed; refusing to signal any process.')
}

const runtimeIdentityFromSnapshot = (marker, snapshot) => {
  if (!isProcessExecuting(snapshot) || snapshot.title !== marker) {
    throw new Error('Could not capture Agora managed-runtime process identity.')
  }

  if (snapshot.platform === 'linux') {
    return validateRuntimeIdentity({
      bootId: snapshot.bootId,
      marker,
      pid: snapshot.pid,
      platform: snapshot.platform,
      startTimeTicks: snapshot.startTimeTicks,
      version: 2
    })
  }

  if (snapshot.platform === 'darwin') {
    return validateRuntimeIdentity({
      marker,
      pid: snapshot.pid,
      platform: snapshot.platform,
      startTime: snapshot.startTime,
      version: 2
    })
  }

  throw new Error('Agora local process management supports Linux and macOS only.')
}

const createCurrentRuntimeIdentity = async () => {
  const marker = `agora:${randomBytes(8).toString('hex')}`
  process.title = marker
  return runtimeIdentityFromSnapshot(marker, await readProcessIdentity(process.pid))
}

const persistRuntimeIdentity = (identity) => {
  mkdirSync(runtimeDirectory, { mode: 0o700, recursive: true })
  writeFileSync(runtimeStatePath, `${JSON.stringify(identity)}\n`, {
    flag: 'wx',
    mode: 0o600
  })
}

const removeRuntimeIdentity = () => {
  rmSync(runtimeStatePath, { force: true })

  try {
    rmdirSync(runtimeDirectory)
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') {
      throw error
    }
  }
}

const runtimeIdentityMatches = (left, right) => {
  if (
    !left
    || left.version !== right.version
    || left.pid !== right.pid
    || left.marker !== right.marker
  ) {
    return false
  }

  if (right.version === 1) {
    return true
  }

  return right.platform === 'linux'
    ? left.platform === right.platform
      && left.bootId === right.bootId
      && left.startTimeTicks === right.startTimeTicks
    : left.platform === right.platform && left.startTime === right.startTime
}

export const inspectRuntimeProcess = async (
  identity,
  readIdentity = readProcessIdentity
) => {
  const current = await readIdentity(identity.pid)

  if (!isProcessExecuting(current)) {
    return 'stopped'
  }

  if (current.title !== identity.marker) {
    return 'unowned'
  }

  if (identity.version === 1) {
    return 'legacy-owned'
  }

  return stableProcessIdentityMatches(identity, current) ? 'owned' : 'unowned'
}

const clearRuntimeIdentityIfCurrent = (identity, overrides = {}) => {
  const readIdentity = overrides.readIdentity ?? readRuntimeIdentity
  const removeIdentity = overrides.removeIdentity ?? removeRuntimeIdentity
  const current = readIdentity()

  if (current && runtimeIdentityMatches(current, identity)) {
    removeIdentity()
    return true
  }

  return false
}

const coordinateRuntimeState = (operation, overrides = {}) => (
  withRuntimeStateCoordinator(runtimeStatePath, operation, overrides)
)

export const withManagedRuntimeState = (operation, overrides) => (
  coordinateRuntimeState(operation, overrides)
)

export const clearRuntimeIdentity = async (identity, overrides = {}) => {
  const coordinate = overrides.coordinate
    ?? ((operation) => coordinateRuntimeState(operation, overrides.coordinatorOptions))

  return coordinate(() => clearRuntimeIdentityIfCurrent(identity, overrides))
}

export const claimRuntimeIdentity = async (overrides = {}) => {
  if (platform() !== 'linux' && platform() !== 'darwin') {
    throw new Error('Agora local process management supports Linux and macOS only.')
  }

  const readIdentity = overrides.readIdentity ?? readRuntimeIdentity
  const inspectProcess = overrides.inspectProcess ?? inspectRuntimeProcess
  const clearIdentity = overrides.clearIdentity
    ?? ((identity) => clearRuntimeIdentityIfCurrent(identity, {
      readIdentity,
      removeIdentity: overrides.removeIdentity
    }))
  const createIdentity = overrides.createIdentity ?? createCurrentRuntimeIdentity
  const writeIdentity = overrides.writeIdentity ?? persistRuntimeIdentity
  const coordinate = overrides.coordinate
    ?? ((operation) => coordinateRuntimeState(operation, overrides.coordinatorOptions))

  return coordinate(async () => {
    const existing = readIdentity()

    if (existing) {
      const status = await inspectProcess(existing)

      if (status === 'owned') {
        throw new Error('Cannot start Agora: another Agora get-going process is active.')
      }

      if (status === 'legacy-owned') {
        throw new Error('Cannot start Agora: a live legacy runtime cannot be signaled safely. Stop that get-going process, then run npm run all-done.')
      }

      if (!await clearIdentity(existing)) {
        throw new Error('Cannot start Agora: runtime state changed during recovery.')
      }
    }

    const identity = await createIdentity()

    try {
      await writeIdentity(identity)
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error('Cannot start Agora: another get-going process claimed the runtime state.')
      }

      throw error
    }

    return {
      ...identity
    }
  })
}

export const readRuntimeIdentity = () => {
  let source

  try {
    source = readFileSync(runtimeStatePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return undefined
    }

    throw error
  }

  try {
    return validateRuntimeIdentity(JSON.parse(source))
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Agora managed-runtime state is malformed; refusing to signal any process.')
    }

    throw error
  }
}

export const stopManagedRuntime = async (identity, overrides = {}) => {
  const inspectProcess = overrides.inspectProcess ?? inspectRuntimeProcess
  const sendSignal = overrides.sendSignal ?? ((pid, signal) => process.kill(pid, signal))
  const clearIdentity = overrides.clearIdentity ?? clearRuntimeIdentity
  const wait = overrides.sleep ?? sleep
  const maxChecks = overrides.maxChecks ?? 60
  const killChecks = overrides.killChecks ?? 20
  const checkIntervalMs = overrides.checkIntervalMs ?? 250
  const initialStatus = await inspectProcess(identity)

  if (initialStatus === 'stopped') {
    return await clearIdentity(identity) ? 'already-stopped' : 'state-changed'
  }

  if (initialStatus === 'unowned') {
    return await clearIdentity(identity) ? 'stale-record-cleared' : 'state-changed'
  }

  if (initialStatus === 'legacy-owned') {
    throw new Error('Agora legacy runtime state describes a live process but lacks stable identity; refusing to signal it.')
  }

  const immediateStatus = await inspectProcess(identity)

  if (immediateStatus !== 'owned') {
    throw new Error('Agora managed-runtime identity changed before shutdown; refusing to signal it.')
  }

  try {
    sendSignal(identity.pid, 'SIGTERM')
  } catch (error) {
    if (error?.code !== 'ESRCH' || await inspectProcess(identity) === 'owned') {
      throw new Error('Could not signal the owned Agora managed-runtime process.')
    }
  }

  for (let check = 0; check < maxChecks; check += 1) {
    await wait(checkIntervalMs)

    if (await inspectProcess(identity) !== 'owned') {
      return await clearIdentity(identity) ? 'stopped' : 'state-changed'
    }
  }

  if (await inspectProcess(identity) !== 'owned') {
    return await clearIdentity(identity) ? 'stopped' : 'state-changed'
  }

  try {
    sendSignal(identity.pid, 'SIGKILL')
  } catch (error) {
    if (error?.code !== 'ESRCH' || await inspectProcess(identity) === 'owned') {
      throw new Error('Could not force-stop the owned Agora managed-runtime process.')
    }
  }

  for (let check = 0; check < killChecks; check += 1) {
    await wait(checkIntervalMs)

    if (await inspectProcess(identity) !== 'owned') {
      return await clearIdentity(identity) ? 'stopped' : 'state-changed'
    }
  }

  throw new Error('Agora managed-runtime process did not terminate within the shutdown deadline.')
}
