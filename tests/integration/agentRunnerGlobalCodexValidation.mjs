import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { handlerPermissionConfig } from '../../scripts/agent-runner/codex-handler.mjs'
import { resolveCodexRuntime } from '../../scripts/agent-runner/codex-runtime.mjs'

const codexBin = process.env.AGORA_RUNNER_TEST_CODEX_BIN?.trim()

if (!codexBin || !isAbsolute(codexBin)) {
  throw new Error('AGORA_RUNNER_TEST_CODEX_BIN must name an absolute global npm launcher.')
}

const root = await mkdtemp(join(tmpdir(), 'agora-global-codex-live-'))
const codexHome = join(root, 'codex-home')
const credentialDirectory = join(root, 'credentials')
const credentialPath = join(credentialDirectory, 'agora-agent-key')
const workspace = join(root, 'workspace')
const contextCliPath = join(process.cwd(), 'scripts/agent-runner/context-cli.mjs')

try {
  await Promise.all([
    mkdir(codexHome, { mode: 0o700 }),
    mkdir(credentialDirectory, { mode: 0o700 }),
    mkdir(workspace, { mode: 0o700 })
  ])
  await writeFile(credentialPath, 'EXAMPLE_DENIED_AGENT_KEY', { mode: 0o400 })
  const config = {
    codexBin,
    credentialDirectory,
    workspace
  }
  const runtime = resolveCodexRuntime(codexBin)

  if (!runtime.executable.endsWith('/codex.js')
    || runtime.readableDirectories.length !== 2
    || !runtime.readableDirectories.some((path) => path.includes('/vendor/'))) {
    throw new Error('The configured Codex launcher is not a supported global npm layout.')
  }

  execFileSync(runtime.executable, [
    'sandbox',
    ...handlerPermissionConfig(config).flatMap((value) => ['-c', value]),
    '--permission-profile', 'agora-handler',
    '--cd', workspace,
    '--',
    '/bin/sh', '-c', 'test ! -r "$1" && test -r "$2"',
    'agora-global-codex-check',
    credentialPath,
    contextCliPath
  ], {
    env: {
      CODEX_HOME: codexHome,
      HOME: root,
      LANG: process.env.LANG ?? 'C.UTF-8',
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 30_000
  })
} catch {
  throw new Error('The global npm Codex launcher failed its final-path sandbox validation.')
} finally {
  await rm(root, { force: true, recursive: true })
}

process.stdout.write('Global npm Codex launcher and sandbox runtime validation passed.\n')
