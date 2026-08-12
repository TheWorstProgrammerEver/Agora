import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { handlerPermissionConfig } from '../../scripts/agent-runner/codex-handler.mjs'
import { resolveCodexRuntime } from '../../scripts/agent-runner/codex-runtime.mjs'

const codexBin = process.env.AGORA_RUNNER_TEST_CODEX_BIN?.trim()

if (!codexBin || !isAbsolute(codexBin)) {
  throw new Error('AGORA_RUNNER_TEST_CODEX_BIN must name an absolute installed Codex launcher.')
}

const root = await mkdtemp(join(homedir(), '.agora-global-codex-live-'))
const codexHome = join(root, 'codex-home')
const credentialDirectory = join(root, 'credentials')
const credentialPath = join(credentialDirectory, 'agora-agent-key')
const workspace = join(root, 'workspace')
const groupWorkspace = join(workspace, '.agora-inbox', 'principal', 'group')
const siblingWorkspace = join(workspace, '.agora-inbox', 'principal', 'other-group')
const stateDirectory = join(root, 'state')
const contextCliPath = join(process.cwd(), 'scripts/agent-runner/context-cli.mjs')

try {
  await Promise.all([
    mkdir(join(codexHome, 'sessions'), { mode: 0o700, recursive: true }),
    mkdir(credentialDirectory, { mode: 0o700 }),
    mkdir(stateDirectory, { mode: 0o700 }),
    mkdir(join(workspace, 'project'), { mode: 0o700, recursive: true }),
    mkdir(join(workspace, 'new-project'), { mode: 0o700, recursive: true }),
    mkdir(groupWorkspace, { mode: 0o700, recursive: true }),
    mkdir(siblingWorkspace, { mode: 0o700, recursive: true })
  ])
  await Promise.all([
    writeFile(credentialPath, 'EXAMPLE_DENIED_AGENT_KEY', { mode: 0o400 }),
    writeFile(join(codexHome, 'sessions', 'other-group.jsonl'), 'DENIED_TRANSCRIPT', {
      mode: 0o600
    }),
    writeFile(join(stateDirectory, 'other-group-plan.json'), 'DENIED_GROUP_PLAN', {
      mode: 0o600
    }),
    writeFile(join(workspace, 'AGENTS.md'), 'DENIED_INSTRUCTION_MUTATION', { mode: 0o600 }),
    writeFile(join(siblingWorkspace, 'context.txt'), 'DENIED_OTHER_GROUP', { mode: 0o600 })
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
    ...handlerPermissionConfig(config, { protectedPaths: [siblingWorkspace] })
      .flatMap((value) => ['-c', value]),
    '--permission-profile', 'agora-inbox',
    '--cd', groupWorkspace,
    '--',
    '/bin/sh', '-c', (
      'test ! -r "$1" || exit 21; test -r "$2" || exit 22; '
      + 'test ! -r "$3" || exit 23; test ! -r "$4" || exit 24; '
      + 'test ! -r "$5" || exit 25; ! touch "$6" 2>/dev/null || exit 26; '
      + '! touch "$7" 2>/dev/null || exit 27; '
      + '! mkdir -p "$8" 2>/dev/null || exit 28; touch "$9" || exit 29; '
      + 'test ! -r "$10" || exit 30'
    ),
    'agora-global-codex-check',
    credentialPath,
    contextCliPath,
    join(codexHome, 'sessions', 'other-group.jsonl'),
    join(workspace, 'AGENTS.md'),
    join(stateDirectory, 'other-group-plan.json'),
    join(workspace, 'project', 'AGENTS.md'),
    join(workspace, 'new-project', 'AGENTS.override.md'),
    join(workspace, 'new-project', '.codex', 'rules'),
    join(groupWorkspace, 'ordinary-output'),
    join(siblingWorkspace, 'context.txt')
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
