import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  writeFileSync
} from 'node:fs'
import { fileURLToPath } from 'node:url'

const runtimeDirectory = fileURLToPath(new URL('../.agora-runtime/', import.meta.url))
const runtimeStatePath = fileURLToPath(new URL('../.agora-runtime/get-going.json', import.meta.url))
const processMarkerPattern = /^agora:[a-f0-9]{16}$/
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const validateRuntimeIdentity = (value) => {
  if (
    typeof value !== 'object'
    || value === null
    || value.version !== 1
    || !Number.isSafeInteger(value.pid)
    || value.pid <= 1
    || typeof value.marker !== 'string'
    || !processMarkerPattern.test(value.marker)
  ) {
    throw new Error('Agora managed-runtime state is malformed; refusing to signal any process.')
  }

  return {
    marker: value.marker,
    pid: value.pid,
    version: value.version
  }
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

const readProcessTitle = (pid) => new Promise((resolve, reject) => {
  execFile('ps', ['-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
    windowsHide: true
  }, (error, stdout) => {
    if (!error) {
      resolve(stdout.trim() || undefined)
      return
    }

    if (error.code === 1 && !stdout.trim()) {
      resolve(undefined)
      return
    }

    reject(new Error('Could not validate Agora managed-runtime process identity.'))
  })
})

export const inspectRuntimeProcess = async (identity, readTitle = readProcessTitle) => {
  const title = await readTitle(identity.pid)

  if (title === undefined) {
    return 'stopped'
  }

  return title === identity.marker ? 'owned' : 'unowned'
}

const runtimeIdentityMatches = (left, right) => (
  left?.version === right.version
  && left?.pid === right.pid
  && left?.marker === right.marker
)

export const clearRuntimeIdentity = (identity) => {
  const current = readRuntimeIdentity()

  if (current && runtimeIdentityMatches(current, identity)) {
    rmSync(runtimeStatePath, { force: true })

    try {
      rmdirSync(runtimeDirectory)
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') {
        throw error
      }
    }
  }
}

export const claimRuntimeIdentity = async () => {
  const existing = readRuntimeIdentity()

  if (existing) {
    const status = await inspectRuntimeProcess(existing)
    const detail = status === 'owned'
      ? 'another Agora get-going process is active'
      : 'stale or unowned runtime state needs reconciliation'

    throw new Error(`Cannot start Agora: ${detail}. Run npm run all-done and inspect the reported state.`)
  }

  const identity = {
    marker: `agora:${randomBytes(8).toString('hex')}`,
    pid: process.pid,
    version: 1
  }

  process.title = identity.marker
  mkdirSync(runtimeDirectory, { mode: 0o700, recursive: true })
  writeFileSync(runtimeStatePath, `${JSON.stringify(identity)}\n`, {
    flag: 'wx',
    mode: 0o600
  })

  return identity
}

export const stopManagedRuntime = async (identity, overrides = {}) => {
  const inspectProcess = overrides.inspectProcess ?? inspectRuntimeProcess
  const sendSignal = overrides.sendSignal ?? ((pid, signal) => process.kill(pid, signal))
  const wait = overrides.sleep ?? sleep
  const maxChecks = overrides.maxChecks ?? 60
  const checkIntervalMs = overrides.checkIntervalMs ?? 250
  const initialStatus = await inspectProcess(identity)

  if (initialStatus === 'stopped') {
    clearRuntimeIdentity(identity)
    return 'already-stopped'
  }

  if (initialStatus !== 'owned') {
    throw new Error('Agora managed-runtime state does not own its recorded process; refusing to signal it.')
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
      clearRuntimeIdentity(identity)
      return 'stopped'
    }
  }

  throw new Error('Agora managed-runtime process did not terminate within the shutdown deadline.')
}
