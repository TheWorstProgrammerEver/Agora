import { randomBytes, randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  AgentAuthenticationError,
  resolveAgentPrincipal
} from '../../../../supabase/functions/agora/auth/agentPrincipalResolver'

const createKey = () => `agora_agent_v1_${randomBytes(32).toString('base64url')}`

const requestWithKey = (applicationKey?: string) => new Request('http://localhost', {
  headers: applicationKey ? { 'x-agora-agent-key': applicationKey } : {}
})

describe('agent principal resolver contract', () => {
  it('maps one well-formed valid key to its resolved agent principal', async () => {
    const key = createKey()
    const principalId = randomUUID()
    const rpc = vi.fn(async () => ({ data: principalId, error: null }))
    const createClient = vi.fn(() => ({ rpc }))

    await expect(resolveAgentPrincipal(
      requestWithKey(key),
      createClient
    )).resolves.toEqual({ kind: 'agent', principalId })

    expect(createClient).toHaveBeenCalledWith(key)
    expect(rpc).toHaveBeenCalledWith('current_agent_principal_id')
  })

  it('rejects missing and malformed keys before database access', async () => {
    const createClient = vi.fn()

    for (const key of [undefined, '', 'sb_publishable_example', 'agora_agent_v1_short']) {
      await expect(resolveAgentPrincipal(
        requestWithKey(key),
        createClient
      )).rejects.toBeInstanceOf(AgentAuthenticationError)
    }

    expect(createClient).not.toHaveBeenCalled()
  })

  it('projects invalid, revoked, and resolver failures to the same denial', async () => {
    const key = createKey()

    for (const result of [
      { data: null, error: null },
      { data: null, error: { code: 'resolver_failed' } },
      { data: { principalId: randomUUID() }, error: null }
    ]) {
      await expect(resolveAgentPrincipal(
        requestWithKey(key),
        () => ({ rpc: async () => result })
      )).rejects.toEqual(expect.objectContaining({
        message: 'A valid Agora agent key is required.',
        status: 401
      }))
    }
  })
})
