import { describe, expect, it } from 'vitest'
import { isAgentApplicationKey } from '../../../common/agentApplicationKey'
import { applicationKeyPattern } from '../../../scripts/agent-keys/key-format.mjs'

describe('agent application-key format', () => {
  it('keeps the Edge and host validators in parity', () => {
    const values = [
      `agora_agent_v1_${'A'.repeat(43)}`,
      `agora_agent_v1_${'A'.repeat(42)}`,
      `agora_agent_v1_${'A'.repeat(44)}`,
      `agora_agent_v1_${'A'.repeat(42)}!`,
      'sb_publishable_example',
      '',
      undefined
    ]

    for (const value of values) {
      expect(isAgentApplicationKey(value)).toBe(
        typeof value === 'string' && applicationKeyPattern.test(value)
      )
    }
  })
})
