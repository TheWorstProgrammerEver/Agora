import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { platform } from 'node:os'

const terminalProcessStates = new Set(['X', 'Z'])
let cachedBootId

const readLinuxBootId = () => {
  cachedBootId ??= readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
  return cachedBootId
}

const parseLinuxProcessStat = (pid, source) => {
  const commandEnd = source.lastIndexOf(')')

  if (commandEnd < 0) {
    throw new Error('Could not parse Linux process identity.')
  }

  const fields = source.slice(commandEnd + 1).trim().split(/\s+/)
  const processGroupId = Number(fields[2])
  const sessionId = Number(fields[3])
  const startTimeTicks = fields[19]

  if (
    fields.length < 20
    || !Number.isSafeInteger(processGroupId)
    || !Number.isSafeInteger(sessionId)
    || !/^\d+$/.test(startTimeTicks ?? '')
  ) {
    throw new Error('Could not parse Linux process identity.')
  }

  return {
    bootId: readLinuxBootId(),
    pid,
    platform: 'linux',
    processGroupId,
    sessionId,
    startTimeTicks,
    state: fields[0]
  }
}

const readLinuxProcessIdentity = (pid) => {
  try {
    const identity = parseLinuxProcessStat(pid, readFileSync(`/proc/${pid}/stat`, 'utf8'))
    const title = readFileSync(`/proc/${pid}/cmdline`)
      .toString('utf8')
      .split('\0')
      .find(Boolean)

    return { ...identity, title }
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') {
      return undefined
    }

    throw new Error('Could not validate Agora process identity.')
  }
}

export const parseDarwinProcessLine = (source) => {
  const match = source.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/)

  if (!match) {
    throw new Error('Could not parse macOS process identity.')
  }

  return {
    pid: Number(match[1]),
    platform: 'darwin',
    processGroupId: Number(match[2]),
    startTime: match[4].replace(/\s+/g, ' '),
    state: match[3],
    title: match[5].trim()
  }
}

const readDarwinProcessIdentity = (pid) => {
  try {
    const source = execFileSync('ps', [
      '-p', String(pid),
      '-o', 'pid=',
      '-o', 'pgid=',
      '-o', 'state=',
      '-o', 'lstart=',
      '-o', 'command='
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

    return source ? parseDarwinProcessLine(source) : undefined
  } catch (error) {
    if (error?.status === 1) {
      return undefined
    }

    throw new Error('Could not validate Agora process identity.')
  }
}

export const readProcessIdentity = (pid) => {
  if (platform() === 'linux') {
    return readLinuxProcessIdentity(pid)
  }

  if (platform() === 'darwin') {
    return readDarwinProcessIdentity(pid)
  }

  throw new Error('Agora local process management supports Linux and macOS only.')
}

export const isProcessExecuting = (identity) => (
  identity !== undefined && !terminalProcessStates.has(identity.state?.[0])
)

export const stableProcessIdentityMatches = (left, right) => {
  if (!left || !right || left.platform !== right.platform || left.pid !== right.pid) {
    return false
  }

  return left.platform === 'linux'
    ? left.bootId === right.bootId && left.startTimeTicks === right.startTimeTicks
    : left.startTime === right.startTime
}

const readLinuxProcessGroupMembers = (processGroupId) => readdirSync('/proc', {
  withFileTypes: true
})
  .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
  .flatMap((entry) => {
    const pid = Number(entry.name)

    try {
      const identity = parseLinuxProcessStat(pid, readFileSync(`/proc/${pid}/stat`, 'utf8'))
      return identity.processGroupId === processGroupId && isProcessExecuting(identity)
        ? [identity]
        : []
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ESRCH') {
        return []
      }

      throw error
    }
  })

const readDarwinProcessGroupMembers = (processGroupId) => {
  let source

  try {
    source = execFileSync('ps', [
      'ax',
      '-o', 'pid=',
      '-o', 'pgid=',
      '-o', 'state=',
      '-o', 'lstart=',
      '-o', 'command='
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    throw new Error('Could not inspect Agora process-group ownership.')
  }

  return source
    .split('\n')
    .filter((line) => line.trim())
    .map(parseDarwinProcessLine)
    .filter((identity) => (
      identity.processGroupId === processGroupId && isProcessExecuting(identity)
    ))
}

export const readProcessGroupMembers = (processGroupId) => {
  if (platform() === 'linux') {
    return readLinuxProcessGroupMembers(processGroupId)
  }

  if (platform() === 'darwin') {
    return readDarwinProcessGroupMembers(processGroupId)
  }

  throw new Error('Agora local process management supports Linux and macOS only.')
}

export const processGroupMembersMatch = (expected, actual) => actual.every((member) => (
  expected.some((candidate) => stableProcessIdentityMatches(candidate, member))
))
