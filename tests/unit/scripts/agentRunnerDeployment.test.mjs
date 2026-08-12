import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { validateHandlerPlan } from '../../../scripts/agent-runner/api-validation.mjs'
import { loadRunnerConfig } from '../../../scripts/agent-runner/config.mjs'
import { selectHandlerProfile } from '../../../scripts/agent-runner/handler-profile.mjs'
import { validateAvailability } from '../../../scripts/agent-runner/realtime-transport.mjs'
import { isIsoTimestamp } from '../../../scripts/agent-runner/value-validation.mjs'

const validEnvironment = (overrides = {}) => ({
  AGORA_RUNNER_API_URL: 'https://example.supabase.co/functions/v1/agora',
  AGORA_RUNNER_STATE_DIRECTORY: '/var/lib/agora-agent-runner-test',
  AGORA_RUNNER_SUPABASE_PUBLISHABLE_KEY: 'public-project-key',
  AGORA_RUNNER_SUPABASE_URL: 'https://example.supabase.co',
  AGORA_RUNNER_WORKSPACE: '/srv/agora',
  CREDENTIALS_DIRECTORY: '/run/credentials/agora-agent-runner@test.service',
  ...overrides
})

describe('agent runner deployment contract', () => {
  it('loads public configuration without accepting embedded credentials', () => {
    const config = loadRunnerConfig(validEnvironment())

    expect(config.apiUrl).toBe('https://example.supabase.co/functions/v1/agora')
    expect(config.supabaseUrl).toBe('https://example.supabase.co')
    expect(config.stateDirectory).toBe('/var/lib/agora-agent-runner-test')
    expect(() => loadRunnerConfig(validEnvironment({
      AGORA_RUNNER_API_URL: 'https://agent:secret@example.supabase.co/functions/v1/agora'
    }))).toThrow('AGORA_RUNNER_API_URL is invalid')
    expect(() => loadRunnerConfig(validEnvironment({
      AGORA_RUNNER_API_URL: 'https://example.supabase.co/functions/v1/another-api'
    }))).toThrow('AGORA_RUNNER_API_URL is invalid')
    expect(() => loadRunnerConfig(validEnvironment({
      AGORA_RUNNER_STATE_DIRECTORY: undefined,
      STATE_DIRECTORY: '/one:/two'
    }))).toThrow('must name one path')
    expect(() => loadRunnerConfig(validEnvironment({
      AGORA_RUNNER_WORKSPACE: undefined,
      HOME: '/must-not-be-used-as-handler-workspace'
    }))).toThrow('workspace is required')
  })

  it('chooses bounded model and reasoning profiles from message context', () => {
    const config = loadRunnerConfig(validEnvironment())

    expect(selectHandlerProfile([{ text: 'Please acknowledge this.' }], config)).toEqual({
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low'
    })
    expect(selectHandlerProfile([{
      text: 'Review the production authorization architecture and migration plan.'
    }], config)).toEqual({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'xhigh'
    })
  })

  it('accepts only the exact private Realtime availability payload', () => {
    const groupId = '11111111-1111-4111-8111-111111111111'
    const payload = {
      groupId,
      highWatermarkSequence: '42',
      id: 'signal-id'
    }

    expect(validateAvailability(payload, groupId)).toBe(true)
    expect(validateAvailability({ ...payload, text: 'must not be transported' }, groupId)).toBe(false)
    expect(validateAvailability({ ...payload, highWatermarkSequence: '0042' }, groupId)).toBe(false)
    expect(validateAvailability(payload, '22222222-2222-4222-8222-222222222222')).toBe(false)
  })

  it('accepts canonical JavaScript and PostgreSQL RFC 3339 timestamps', () => {
    expect(isIsoTimestamp('2026-08-12T04:48:18.239Z')).toBe(true)
    expect(isIsoTimestamp('2026-08-12T12:48:18.239123+08:00')).toBe(true)
    expect(isIsoTimestamp('2026-08-12')).toBe(false)
  })

  it('binds the production service to encrypted credentials and restart supervision', async () => {
    const unit = await readFile(
      new URL('../../../ops/systemd/agora-agent-runner@.service', import.meta.url),
      'utf8'
    )

    expect(unit).toContain(
      'LoadCredentialEncrypted=agora-agent-key:/etc/credstore.encrypted/agora-agent-key.cred'
    )
    expect(unit).toContain('Environment=AGORA_RUNNER_STATE_DIRECTORY=/var/lib/agora-agent-runner-%i')
    expect(unit).toContain('Environment=AGORA_RUNNER_WORKSPACE=/run/agora-agent-runner-handler-%i')
    expect(unit).toContain('Environment=CODEX_HOME=/var/lib/agora-agent-runner-%i/codex')
    expect(unit).toContain('WorkingDirectory=/run/agora-agent-runner-handler-%i')
    expect(unit).toContain('RuntimeDirectory=agora-agent-runner-handler-%i')
    expect(unit).toContain('ExecStart=/usr/local/bin/agora-agent-runner run')
    expect(unit).toContain('Restart=always')
    expect(unit).toContain('KillMode=control-group')
    expect(unit).toContain('UMask=0077')
    expect(unit).not.toContain('%h')
    expect(unit).not.toMatch(/Environment=.*(?:AGENT_KEY|SECRET|TOKEN)=/)
  })

  it('provides a strict handler schema accepted by the Codex response format', async () => {
    const schema = JSON.parse(await readFile(
      new URL('../../../ops/agent-runner/handler-output.schema.json', import.meta.url),
      'utf8'
    ))

    expect(schema).toMatchObject({
      additionalProperties: false,
      properties: {
        messages: {
          items: { additionalProperties: false, type: 'object' },
          maxItems: 4,
          type: 'array'
        },
        version: { const: 1, type: 'integer' }
      },
      required: ['messages', 'version'],
      type: 'object'
    })
    expect(() => validateHandlerPlan({
      messages: [{ text: `agora_agent_v1_${'A'.repeat(43)}` }],
      version: 1
    })).toThrow('handler output is invalid')
  })
})
