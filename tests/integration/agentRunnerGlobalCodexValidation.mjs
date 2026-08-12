import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { handlerPermissionConfig } from '../../scripts/agent-runner/codex-handler.mjs'
import { resolveCodexRuntime } from '../../scripts/agent-runner/codex-runtime.mjs'

const codexBin = process.env.AGORA_RUNNER_TEST_CODEX_BIN?.trim()

if (!codexBin || !isAbsolute(codexBin)) {
  throw new Error('AGORA_RUNNER_TEST_CODEX_BIN must name an absolute installed Codex launcher.')
}

const root = await mkdtemp(join(tmpdir(), 'agora-global-codex-live-'))
const codexHome = join(root, 'codex-home')
const credentialDirectory = join(root, 'credentials')
const credentialPath = join(credentialDirectory, 'agora-agent-key')
const workspace = join(root, 'workspace')
const stateDirectory = join(root, 'state')
const contextCliPath = join(process.cwd(), 'scripts/agent-runner/context-cli.mjs')

try {
  await Promise.all([
    mkdir(join(codexHome, 'sessions'), { mode: 0o700, recursive: true }),
    mkdir(credentialDirectory, { mode: 0o700 }),
    mkdir(stateDirectory, { mode: 0o700 }),
    mkdir(join(workspace, '.git'), { mode: 0o700, recursive: true })
  ])
  await Promise.all([
    writeFile(credentialPath, 'EXAMPLE_DENIED_AGENT_KEY', { mode: 0o400 }),
    writeFile(join(codexHome, 'sessions', 'other-group.jsonl'), 'DENIED_TRANSCRIPT', {
      mode: 0o600
    }),
    writeFile(join(stateDirectory, 'other-group-plan.json'), 'DENIED_GROUP_PLAN', {
      mode: 0o600
    }),
    writeFile(join(workspace, 'AGENTS.md'), 'DENIED_INSTRUCTION_MUTATION', { mode: 0o600 })
  ])
  const config = {
    codexBin,
    codexHome,
    credentialDirectory,
    stateDirectory,
    workspace
  }
  const runtime = resolveCodexRuntime(codexBin)

  if (process.env.AGORA_RUNNER_REQUIRE_NPM_CODEX === 'true'
    && (!runtime.executable.endsWith('/codex.js')
      || !runtime.readableDirectories.some((path) => path.includes('/vendor/')))) {
    throw new Error('The configured Codex launcher is not the required global npm layout.')
  }

  execFileSync(runtime.executable, [
    'sandbox',
    ...handlerPermissionConfig(config).flatMap((value) => ['-c', value]),
    '--permission-profile', 'agora-inbox',
    '--cd', workspace,
    '--',
    '/bin/sh', '-c', (
      'test ! -r "$1" && test -r "$2" && test ! -r "$3" '
      + '&& test ! -r "$4" && test ! -r "$5" && touch "$6"'
    ),
    'agora-global-codex-check',
    credentialPath,
    contextCliPath,
    join(codexHome, 'sessions', 'other-group.jsonl'),
    join(workspace, 'AGENTS.md'),
    join(stateDirectory, 'other-group-plan.json'),
    join(workspace, 'ordinary-output')
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
} catch (error) {
  throw new Error('The installed Codex launcher failed its final-path sandbox validation.', {
    cause: error
  })
} finally {
  await rm(root, { force: true, recursive: true })
}

process.stdout.write('Installed Codex launcher and host inbox sandbox validation passed.\n')
