import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, chown, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { runCommand } from '../../scripts/agent-keys/command.mjs'

if (process.getuid?.() !== 0) {
  throw new Error('The live systemd runner handoff test must run as root.')
}

const [repositorySource, uidSource, gidSource, nodeSource] = process.argv.slice(2)
const repository = resolve(repositorySource ?? '')
const uid = Number(uidSource)
const gid = Number(gidSource)
const nodePath = resolve(nodeSource ?? '')

if (!Number.isSafeInteger(uid)
  || uid < 1
  || !Number.isSafeInteger(gid)
  || gid < 1
  || !repository.startsWith('/home/')
  || !nodePath.startsWith('/')) {
  throw new Error('The live systemd runner handoff arguments are invalid.')
}

const testRoot = await mkdtemp('/run/agora-agent-runner-test-')
const stateDirectory = join(testRoot, 'state')
const handlerWorkspace = join(testRoot, 'handler-workspace')
const credentialDirectory = join(testRoot, 'credstore.encrypted')
const credentialPath = join(credentialDirectory, 'agora-agent-key.cred')
const unitName = `agora-agent-runner-test-${randomUUID()}.service`
const unitPath = join('/run/systemd/system', unitName)
const cliPath = join(repository, 'scripts/agent-runner/cli.mjs')
const credentialProbePath = join(repository, 'tests/fixtures/agentRunnerCredentialProbe.mjs')
const key = `agora_agent_v1_${randomBytes(32).toString('base64url')}`
let requestCount = 0
let server

const checked = async (file, args, options) => {
  if (JSON.stringify(args).includes(key)) {
    throw new Error('A raw agent key entered a process argument.')
  }
  return runCommand(file, args, options)
}

const waitFor = async (predicate, message, timeoutMs = 10_000) => {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
  throw new Error(message)
}

const systemctl = (...args) => checked('/usr/bin/systemctl', args)
const show = async (property) => (
  await checked('/usr/bin/systemctl', [
    'show',
    '--property', property,
    '--value',
    unitName
  ], { output: 'buffer' })
).toString('utf8').trim()

const assertAbsentFromArguments = async () => {
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      if ((await readFile(`/proc/${entry}/cmdline`)).includes(key)) {
        throw new Error('A raw agent key entered a process argument.')
      }
    } catch (error) {
      if (!['EACCES', 'ENOENT', 'EPERM'].includes(error.code)) throw error
    }
  }
}

const startServer = () => new Promise((resolveServer, reject) => {
  const candidate = createServer((request, response) => {
    const body = []
    let bytes = 0
    request.on('data', (chunk) => {
      bytes += chunk.byteLength
      if (bytes <= 64 * 1024) body.push(chunk)
    })
    request.on('end', () => {
      let valid = bytes <= 64 * 1024
        && request.method === 'POST'
        && request.url === '/functions/v1/agora'
        && request.headers['x-agora-agent-key'] === key
      try {
        const envelope = JSON.parse(Buffer.concat(body).toString('utf8'))
        valid = valid
          && envelope.identifier === 'listGroups'
          && envelope.version === 1
      } catch {
        valid = false
      }

      if (!valid) {
        response.writeHead(403, { 'content-type': 'application/json' })
        response.end('{"error":"denied"}')
        return
      }

      requestCount += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"items":[]}')
    })
  })
  candidate.once('error', reject)
  candidate.listen(0, '127.0.0.1', () => {
    server = candidate
    resolveServer(candidate.address().port)
  })
})

const closeServer = () => new Promise((resolveClose, reject) => {
  if (!server) {
    resolveClose()
    return
  }
  server.close((error) => error ? reject(error) : resolveClose())
})

try {
  await chmod(testRoot, 0o755)
  await mkdir(credentialDirectory, { mode: 0o700 })
  await mkdir(stateDirectory, { mode: 0o700 })
  await mkdir(handlerWorkspace, { mode: 0o700 })
  await chown(stateDirectory, uid, gid)
  await chown(handlerWorkspace, uid, gid)
  await checked('/usr/bin/systemd-creds', [
    '--allow-null',
    '--with-key=null',
    '--newline=no',
    '--name=agora-agent-key',
    'encrypt',
    '-',
    credentialPath
  ], { input: Buffer.from(key) })
  await chmod(credentialPath, 0o600)

  const credentialProbe = await checked('/usr/bin/systemd-run', [
    '--wait',
    '--pipe',
    '--collect',
    '--quiet',
    `--unit=agora-runner-credential-probe-${randomUUID()}`,
    `--uid=${uid}`,
    `--gid=${gid}`,
    `--property=LoadCredentialEncrypted=agora-agent-key:${credentialPath}`,
    nodePath,
    credentialProbePath
  ], { output: 'buffer' })
  const credentialEvidence = JSON.parse(credentialProbe.toString('utf8'))
  if (!credentialEvidence.ok
    || !/^sha256:[a-f0-9]{16}$/.test(credentialEvidence.fingerprint)) {
    throw new Error(`The runner could not consume the systemd credential binding: ${JSON.stringify(credentialEvidence)}.`)
  }

  const port = await startServer()
  const apiUrl = `http://127.0.0.1:${port}/functions/v1/agora`
  const supabaseUrl = `http://127.0.0.1:${port}`
  const unit = `[Unit]
Description=Agora agent runner live validation
After=network.target

[Service]
Type=simple
User=${uid}
Group=${gid}
WorkingDirectory=${repository}
Environment=AGORA_RUNNER_API_URL=${apiUrl}
Environment=AGORA_RUNNER_CODEX_BIN=/bin/false
Environment=AGORA_RUNNER_POLL_INTERVAL_MS=1000
Environment=AGORA_RUNNER_REQUEST_ATTEMPTS=1
Environment=AGORA_RUNNER_RETRY_BASE_MS=10
Environment=AGORA_RUNNER_STATE_DIRECTORY=${stateDirectory}
Environment=AGORA_RUNNER_SUPABASE_PUBLISHABLE_KEY=public-validation-key
Environment=AGORA_RUNNER_SUPABASE_URL=${supabaseUrl}
Environment=AGORA_RUNNER_WORKSPACE=${handlerWorkspace}
LoadCredentialEncrypted=agora-agent-key:${credentialPath}
ExecStart=${nodePath} ${cliPath} run
Restart=always
RestartSec=100ms
TimeoutStopSec=5s
KillMode=control-group
UMask=0077
`
  await writeFile(unitPath, unit, { flag: 'wx', mode: 0o644 })
  await chmod(unitPath, 0o644)
  await chown(testRoot, 0, 0)
  await systemctl('daemon-reload')
  await systemctl('start', unitName)
  await waitFor(async () => requestCount >= 1 && await show('ActiveState') === 'active', (
    'The live systemd runner did not become healthy.'
  ))
  await assertAbsentFromArguments()

  const firstPid = await show('MainPID')
  const beforeCrash = requestCount
  await systemctl('kill', '--kill-whom=main', '--signal=SIGKILL', unitName)
  await waitFor(async () => (
    await show('MainPID') !== firstPid && requestCount > beforeCrash
  ), 'The live systemd runner did not restart after a crash.')

  const beforeRestart = requestCount
  await systemctl('restart', unitName)
  await waitFor(async () => requestCount > beforeRestart, (
    'The live systemd runner did not complete an explicit restart.'
  ))

  await systemctl('stop', unitName)
  await waitFor(async () => await show('ActiveState') === 'inactive', (
    'The live systemd runner did not stop.'
  ))
  const beforeResume = requestCount
  await systemctl('start', unitName)
  await waitFor(async () => requestCount > beforeResume, (
    'The live systemd runner did not resume from its existing state.'
  ))

  const status = JSON.parse((await checked('/usr/bin/setpriv', [
    `--reuid=${uid}`,
    `--regid=${gid}`,
    '--clear-groups',
    '/usr/bin/env',
    `AGORA_RUNNER_STATE_DIRECTORY=${stateDirectory}`,
    nodePath,
    cliPath,
    'status'
  ], { output: 'buffer' })).toString('utf8'))
  if (status.version !== 1
    || status.groups.length !== 0
    || status.principal !== null
    || status.lastActivity?.code !== 'realtime_connected') {
    throw new Error('The live systemd runner did not expose bounded health state.')
  }

  const journal = await checked('/usr/bin/journalctl', [
    '--no-pager',
    '--output=cat',
    '--unit',
    unitName
  ], { output: 'buffer' })
  if (journal.includes(key) || unit.includes(key) || (await readFile(credentialPath)).includes(key)) {
    throw new Error('The live systemd runner leaked its raw credential.')
  }
} finally {
  await systemctl('stop', unitName).catch(() => undefined)
  await rm(unitPath, { force: true })
  await systemctl('daemon-reload').catch(() => undefined)
  await systemctl('reset-failed', unitName).catch(() => undefined)
  await closeServer().catch(() => undefined)
  await rm(testRoot, { force: true, recursive: true })
}
