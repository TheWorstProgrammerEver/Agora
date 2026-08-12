import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { runAsRoot } from '../../scripts/agent-keys/elevated-node.mjs'
import { fingerprintApplicationKey } from '../../scripts/agent-keys/key-format.mjs'

const launcherPath = fileURLToPath(new URL(
  '../../scripts/agent-keys/systemd-credential-launcher.mjs',
  import.meta.url
))
const facilityPath = fileURLToPath(new URL(
  './systemdCredentialHandoff.mjs',
  import.meta.url
))
const minimumEnvironment = {
  LANG: 'C',
  LC_ALL: 'C',
  PATH: '/usr/bin:/bin'
}
const commandArgs = (fingerprint) => [
  launcherPath,
  'install',
  '--service',
  'agora-agent-runner@test.service',
  '--fingerprint',
  fingerprint
]

const terminateGroup = (child, signal) => {
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') {
      throw error
    }
  }
}

const runCaptured = (file, args, { afterOutput, input } = {}) => new Promise((resolve, reject) => {
  const child = spawn(file, args, {
    detached: true,
    env: minimumEnvironment,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const output = []
  let acted = false
  let settled = false
  const timeout = setTimeout(() => {
    terminateGroup(child, 'SIGKILL')
    reject(new Error('Credential entrypoint test exceeded its deadline.'))
  }, 15_000)
  const observe = async (chunk) => {
    output.push(chunk)

    if (!acted && afterOutput) {
      const current = Buffer.concat(output).toString('utf8')

      if (current.includes('Agora agent key: ')) {
        acted = true

        try {
          await afterOutput(child)
        } catch (error) {
          terminateGroup(child, 'SIGKILL')
          reject(error)
        }
      }
    }
  }

  child.stdout.on('data', observe)
  child.stderr.on('data', observe)
  child.once('error', () => {
    clearTimeout(timeout)
    reject(new Error('Credential entrypoint test could not start.'))
  })
  child.once('close', (code, signal) => {
    if (settled) {
      return
    }

    settled = true
    clearTimeout(timeout)
    resolve({ code, output: Buffer.concat(output).toString('utf8'), signal })
  })

  if (input) {
    child.stdin.end(input)
  }
})

const assertAbsentFromProcessArguments = async (marker) => {
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) {
      continue
    }

    try {
      const commandLine = await readFile(`/proc/${entry}/cmdline`)

      if (commandLine.includes(marker)) {
        throw new Error('A raw agent key entered a process argument.')
      }
    } catch (error) {
      if (!['EACCES', 'ENOENT', 'EPERM'].includes(error.code)) {
        throw error
      }
    }
  }
}

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`

const ptyCommand = (fingerprint) => {
  const command = [process.execPath, ...commandArgs(fingerprint)]
    .map(shellQuote)
    .join(' ')

  return [
    'before=$(/bin/stty -g) || exit 90',
    command,
    'status=$?',
    'after=$(/bin/stty -g) || exit 91',
    'if [ "$before" != "$after" ]; then echo TTY_STATE_NOT_RESTORED >&2; exit 92; fi',
    'echo TTY_STATE_RESTORED >&2',
    'exit "$status"'
  ].join('; ')
}

const runPtyScenario = (fingerprint, respond) => runCaptured('/usr/bin/script', [
  '--quiet',
  '--return',
  '--flush',
  '--command',
  ptyCommand(fingerprint),
  '/dev/null'
], { afterOutput: respond })

const assertNonTtyDenial = async () => {
  const marker = `agora_agent_v1_${randomBytes(32).toString('base64url')}`
  const result = await runCaptured(process.execPath, commandArgs(
    fingerprintApplicationKey(marker)
  ), { input: Buffer.from(`${marker}\n`) })

  if (result.code === 0 || !result.output.includes('"code":"tty_required"')) {
    throw new Error('Production host entrypoint did not reject redirected input.')
  }

  if (result.output.includes(marker)) {
    throw new Error('Redirected raw agent key appeared in entrypoint output.')
  }
}

const assertPtySuccessBoundary = async () => {
  const marker = `agora_agent_v1_${randomBytes(32).toString('base64url')}`
  const result = await runPtyScenario('sha256:0000000000000000', async (child) => {
    child.stdin.write(marker)
    await assertAbsentFromProcessArguments(marker)
    child.stdin.write('\n')
  })

  if (
    result.code === 0
    || !result.output.includes('"code":"fingerprint_mismatch"')
    || !result.output.includes('TTY_STATE_RESTORED')
  ) {
    throw new Error('Production PTY success boundary did not fail safely after input.')
  }

  if (result.output.includes(marker)) {
    throw new Error('Raw agent key was echoed or logged by the production PTY entrypoint.')
  }
}

const assertPtyCancellation = async () => {
  const result = await runPtyScenario('sha256:0000000000000000', async (child) => {
    child.stdin.write(Buffer.from([3]))
  })

  if (
    result.code === 0
    || !result.output.includes('"code":"entry_canceled"')
    || !result.output.includes('TTY_STATE_RESTORED')
  ) {
    throw new Error('Production PTY cancellation did not restore terminal state.')
  }
}

await assertNonTtyDenial()
await assertPtySuccessBoundary()
await assertPtyCancellation()

const facilityCode = await runAsRoot({ entrypoint: facilityPath })

if (facilityCode !== 0) {
  throw new Error('Live systemd encrypted-credential facility failed.')
}

process.stdout.write('Production launcher, PTY, and live systemd credential validation passed.\n')
