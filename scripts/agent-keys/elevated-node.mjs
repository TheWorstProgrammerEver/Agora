import { spawn } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import path from 'node:path'

const sudoPath = '/usr/bin/sudo'
const minimumEnvironment = Object.freeze({
  LANG: 'C',
  LC_ALL: 'C',
  PATH: '/usr/bin:/bin'
})

const validateExecutable = (candidate, label) => {
  if (!path.isAbsolute(candidate)) {
    throw new Error(`${label} must be an absolute path.`)
  }

  const resolved = realpathSync(candidate)
  const metadata = statSync(resolved)

  if (!metadata.isFile() || (metadata.mode & 0o111) === 0) {
    throw new Error(`${label} must be an executable regular file.`)
  }

  return resolved
}

export const elevatedNodeInvocation = ({
  args,
  entrypoint,
  nodePath = process.execPath,
  uid = process.getuid?.()
}) => {
  const runtime = validateExecutable(nodePath, 'Node runtime')

  if (!path.isAbsolute(entrypoint)) {
    throw new Error('Elevated Node entrypoint must be an absolute path.')
  }

  if (uid === 0) {
    return { args: [entrypoint, ...args], file: runtime }
  }

  return {
    args: ['-n', '--', runtime, entrypoint, ...args],
    file: sudoPath
  }
}

export const runAsRoot = ({
  args = [],
  entrypoint,
  spawnProcess = spawn
}) => new Promise((resolve, reject) => {
  let invocation

  try {
    invocation = elevatedNodeInvocation({ args, entrypoint })
  } catch {
    reject(new Error('Approved Node runtime could not be resolved for elevation.'))
    return
  }

  const child = spawnProcess(invocation.file, invocation.args, {
    env: minimumEnvironment,
    stdio: 'inherit'
  })

  child.once('error', () => {
    reject(new Error('Elevated host command could not be started.'))
  })
  child.once('close', (code, signal) => {
    if (signal) {
      reject(new Error('Elevated host command was interrupted.'))
      return
    }

    resolve(code ?? 1)
  })
})
