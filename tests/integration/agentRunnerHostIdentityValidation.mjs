import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { runCodexHandler } from '../../scripts/agent-runner/codex-handler.mjs'

const required = (name) => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required for host identity validation.`)
  return value
}

const agentHome = required('AGORA_RUNNER_TEST_AGENT_HOME')
const codexBin = required('AGORA_RUNNER_TEST_CODEX_BIN')
const hostFile = required('AGORA_RUNNER_EXPECTED_HOST_FILE')
const durableMarker = required('AGORA_RUNNER_EXPECTED_DURABLE_MARKER')
const issueIdentifier = required('AGORA_RUNNER_ACCEPTANCE_LINEAR_ISSUE')
const issueTitle = required('AGORA_RUNNER_EXPECTED_LINEAR_TITLE')

if (![agentHome, codexBin].every(isAbsolute)
  || !/^[A-Z]+-\d+$/.test(issueIdentifier)
  || [hostFile, durableMarker, issueTitle].some((value) => value.includes('|'))) {
  throw new Error('Host identity validation configuration is invalid.')
}

const root = await mkdtemp(join(tmpdir(), 'agora-host-identity-'))
const credentialDirectory = join(root, 'credentials')
const outputPath = join(root, 'output.json')
let threadId

try {
  await mkdir(credentialDirectory, { mode: 0o700 })
  await writeFile(
    join(credentialDirectory, 'agora-agent-key'),
    `agora_agent_v1_${'A'.repeat(43)}`,
    { mode: 0o400 }
  )
  const result = await runCodexHandler({
    config: {
      agentHome,
      codexBin,
      codexHome: join(agentHome, '.codex'),
      credentialDirectory,
      handlerOutputSchemaPath: join(process.cwd(), 'ops/agent-runner/handler-output.schema.json'),
      handlerTimeoutMs: 10 * 60_000,
      leaseDurationMs: 60_000,
      stateDirectory: root,
      threadBootstrapPromptPath: join(
        process.cwd(),
        'ops/agent-runner/thread-bootstrap-prompt.md'
      ),
      workspace: agentHome
    },
    context: {
      agentPrincipalId: randomUUID(),
      chunkId: 'd'.repeat(64),
      cursor: '0',
      groupId: randomUUID(),
      messages: [],
      through: '1'
    },
    contextAccess: {
      capability: 'c'.repeat(43),
      url: 'http://127.0.0.1:9/context'
    },
    onBootstrapStarted: async () => undefined,
    onHeartbeat: async () => undefined,
    onThreadReady: async (value) => { threadId = value },
    onTurnStarted: async () => undefined,
    outputPath,
    prompt: `# Trusted host identity acceptance validation

This is read-only validation. Do not create, update, or send anything through an
external service. Use your already-loaded host AGENTS.md instructions, inspect the
durable Agora project note those instructions direct you toward, and use authenticated
Linear tooling to read issue ${issueIdentifier}.

Return one Agora action-plan message whose text contains exactly three evidence fields
separated by " | ": (1) the filename that host AGENTS.md says to inspect at the start
of work in the home directory, (2) the identifier of the merged resilient
agent-message-runner issue named in the durable Agora note, and (3) the exact current
title of ${issueIdentifier}. Do not include paths, credentials, commentary, or other
fields.`,
    signal: new AbortController().signal
  })
  const expected = `${hostFile} | ${durableMarker} | ${issueTitle}`
  if (!threadId || result.messages.length !== 1 || result.messages[0].text !== expected) {
    throw new Error('The host identity acceptance evidence did not match.')
  }
} finally {
  await rm(root, { force: true, recursive: true })
}

process.stdout.write('Host identity, durable context, and authenticated Linear validation passed.\n')
