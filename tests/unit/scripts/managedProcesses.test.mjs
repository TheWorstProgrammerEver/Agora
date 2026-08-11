import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  mkdtempSync,
  readFileSync,
  rmSync
} from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  startManagedProcess,
  stopManagedProcesses
} from '../../../scripts/managed-processes.mjs'
import {
  isProcessExecuting,
  parseDarwinProcessLine,
  processGroupMembersMatch,
  readProcessIdentity,
  stableProcessIdentityMatches
} from '../../../scripts/process-identity.mjs'

const waitFor = async (check, timeoutMs = 3000) => {
  const deadline = performance.now() + timeoutMs

  while (performance.now() < deadline) {
    const result = check()

    if (result) {
      return result
    }

    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  throw new Error('Timed out waiting for the process fixture.')
}

const readFixturePid = (path) => {
  try {
    return Number(readFileSync(path, 'utf8')) || undefined
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return undefined
    }

    throw error
  }
}

describe('managed process groups', () => {
  it('parses macOS process identity fields used by lifecycle checks', () => {
    expect(parseDarwinProcessLine(
      ' 4242 4242 S+ Tue Aug 12 10:11:12 2026 agora:0123456789abcdef'
    )).toEqual({
      pid: 4242,
      platform: 'darwin',
      processGroupId: 4242,
      startTime: 'Tue Aug 12 10:11:12 2026',
      state: 'S+',
      title: 'agora:0123456789abcdef'
    })

    expect(() => parseDarwinProcessLine('not a process row')).toThrow(
      'Could not parse macOS process identity.'
    )
  })

  it('rejects a reused member identity before escalation', () => {
    const expected = [{
      bootId: 'fixture-boot',
      pid: 4242,
      platform: 'linux',
      startTimeTicks: '123'
    }]

    expect(processGroupMembersMatch(expected, [{
      ...expected[0],
      startTimeTicks: '456'
    }])).toBe(false)
  })

  it.runIf(platform() === 'linux' || platform() === 'darwin')(
    'escalates when the direct child exits but a same-group descendant resists SIGTERM',
    async () => {
      const fixtureDirectory = mkdtempSync(join(tmpdir(), 'agora-managed-processes-'))
      const descendantPidPath = join(fixtureDirectory, 'descendant.pid')
      const managedProcesses = []
      let descendantIdentity
      let launcherIdentity

      try {
        const resistantDescendant = [
          "const { writeFileSync } = require('node:fs')",
          "process.on('SIGTERM', () => {})",
          "writeFileSync(process.argv[1], String(process.pid))",
          'setInterval(() => {}, 1000)'
        ].join(';')
        const launcher = [
          "const { spawn } = require('node:child_process')",
          `spawn(process.execPath, ['-e', ${JSON.stringify(resistantDescendant)}, process.argv[1]], { stdio: 'ignore' })`,
          'setInterval(() => {}, 1000)'
        ].join(';')

        startManagedProcess(
          managedProcesses,
          'resistant descendant fixture',
          process.execPath,
          ['-e', launcher, descendantPidPath]
        )

        launcherIdentity = await waitFor(() => {
          const current = readProcessIdentity(managedProcesses[0].child.pid)
          return isProcessExecuting(current) ? current : undefined
        })

        const descendantPid = await waitFor(() => readFixturePid(descendantPidPath))
        descendantIdentity = await waitFor(() => {
          const current = readProcessIdentity(descendantPid)
          return isProcessExecuting(current) ? current : undefined
        })

        await stopManagedProcesses(managedProcesses, {
          graceMs: 100,
          killWaitMs: 2000,
          pollIntervalMs: 20
        })

        const remaining = readProcessIdentity(descendantPid)
        expect(isProcessExecuting(remaining)).toBe(false)
      } finally {
        await stopManagedProcesses(managedProcesses, {
          graceMs: 100,
          killWaitMs: 2000,
          pollIntervalMs: 20
        }).catch(() => {})

        if (descendantIdentity) {
          const current = readProcessIdentity(descendantIdentity.pid)

          if (
            isProcessExecuting(current)
            && stableProcessIdentityMatches(descendantIdentity, current)
          ) {
            process.kill(descendantIdentity.pid, 'SIGKILL')
          }

          await waitFor(() => !isProcessExecuting(
            readProcessIdentity(descendantIdentity.pid)
          )).catch(() => {})
        }

        if (launcherIdentity) {
          const current = readProcessIdentity(launcherIdentity.pid)

          if (
            isProcessExecuting(current)
            && stableProcessIdentityMatches(launcherIdentity, current)
          ) {
            process.kill(-launcherIdentity.processGroupId, 'SIGKILL')
          }

          await waitFor(() => !isProcessExecuting(
            readProcessIdentity(launcherIdentity.pid)
          )).catch(() => {})
        }

        rmSync(fixtureDirectory, { force: true, recursive: true })
      }
    },
    10000
  )
})
