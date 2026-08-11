import { randomBytes, randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { authenticatePrincipal } from '../../../../supabase/functions/agora/auth/authenticatePrincipal'
import { authenticateAgentPrincipal } from '../../../../supabase/functions/agora/auth/agentPrincipalResolver'
import {
  authenticateHumanPrincipal,
  HumanAuthenticationError
} from '../../../../supabase/functions/agora/auth/humanPrincipalResolver'

const createAgentKey = () => `agora_agent_v1_${randomBytes(32).toString('base64url')}`

describe('principal credential selection', () => {
  it('gives an explicit human credential precedence without consulting an agent key', async () => {
    const humanContext = {
      database: { rpc: vi.fn() },
      principal: { kind: 'human' as const, principalId: randomUUID() }
    }
    const authenticateHuman = vi.fn().mockResolvedValue(humanContext)
    const authenticateAgent = vi.fn()
    const request = new Request('http://localhost/agora', {
      headers: {
        authorization: 'Bearer human-token',
        'x-agora-agent-key': createAgentKey()
      }
    })

    await expect(authenticatePrincipal(request, {
      authenticateAgent,
      authenticateHuman
    })).resolves.toBe(humanContext)
    expect(authenticateHuman).toHaveBeenCalledOnce()
    expect(authenticateAgent).not.toHaveBeenCalled()
  })

  it('selects only an explicit agent key and rejects anonymous requests', async () => {
    const agentContext = {
      database: { rpc: vi.fn() },
      principal: { kind: 'agent' as const, principalId: randomUUID() }
    }
    const authenticateAgent = vi.fn().mockResolvedValue(agentContext)
    const authenticateHuman = vi.fn()

    await expect(authenticatePrincipal(new Request('http://localhost/agora', {
      headers: { 'x-agora-agent-key': createAgentKey() }
    }), {
      authenticateAgent,
      authenticateHuman
    })).resolves.toBe(agentContext)
    expect(authenticateAgent).toHaveBeenCalledOnce()

    expect(() => authenticatePrincipal(new Request('http://localhost/agora'), {
      authenticateAgent,
      authenticateHuman
    })).toThrow('A human session or Agora agent key is required.')
  })

  it('never treats the gateway public project authorization as a human principal', async () => {
    const authenticateAgent = vi.fn().mockResolvedValue({
      database: { rpc: vi.fn() },
      principal: { kind: 'agent' as const, principalId: randomUUID() }
    })
    const authenticateHuman = vi.fn()
    const options = {
      authenticateAgent,
      authenticateHuman,
      isPublicProjectAuthorization: (value: string) => value === 'Bearer public-project-key'
    }

    await expect(authenticatePrincipal(new Request('http://localhost/agora', {
      headers: {
        authorization: 'Bearer public-project-key',
        'x-agora-agent-key': createAgentKey()
      }
    }), options)).resolves.toMatchObject({ principal: { kind: 'agent' } })
    expect(authenticateHuman).not.toHaveBeenCalled()

    expect(() => authenticatePrincipal(new Request('http://localhost/agora', {
      headers: { authorization: 'Bearer public-project-key' }
    }), options)).toThrow('A human session or Agora agent key is required.')
  })
})

describe('principal credential adapters', () => {
  it('validates a human session and exposes only its RLS RPC capability', async () => {
    const principalId = randomUUID()
    const rpc = vi.fn(async () => ({ data: principalId, error: null }))
    const validateSession = vi.fn(async () => ({ userId: randomUUID() }))
    const createClient = vi.fn(() => ({ rpc }))
    const context = await authenticateHumanPrincipal(new Request('http://localhost/agora', {
      headers: { authorization: 'Bearer human-session' }
    }), validateSession, createClient)

    expect(context.principal).toEqual({ kind: 'human', principalId })
    expect(Object.keys(context.database)).toEqual(['rpc'])
    expect(createClient).toHaveBeenCalledWith('human-session')
    expect(validateSession).toHaveBeenCalledWith('human-session')
    expect(rpc).toHaveBeenCalledWith('current_principal_id')
  })

  it('rejects malformed and invalid human tokens before handler context exists', async () => {
    const validateSession = vi.fn(async () => null)
    const createClient = vi.fn(() => ({ rpc: vi.fn() }))

    await expect(authenticateHumanPrincipal(
      new Request('http://localhost/agora', { headers: { authorization: 'invalid' } }),
      validateSession,
      createClient
    )).rejects.toBeInstanceOf(HumanAuthenticationError)
    expect(validateSession).not.toHaveBeenCalled()
    expect(createClient).not.toHaveBeenCalled()

    await expect(authenticateHumanPrincipal(
      new Request('http://localhost/agora', {
        headers: { authorization: 'Bearer invalid-token' }
      }),
      validateSession,
      createClient
    )).rejects.toBeInstanceOf(HumanAuthenticationError)
    expect(validateSession).toHaveBeenCalledOnce()
    expect(createClient).not.toHaveBeenCalled()
  })

  it('validates an agent key and exposes no raw key or generic client surface', async () => {
    const applicationKey = createAgentKey()
    const principalId = randomUUID()
    const rpc = vi.fn(async () => ({ data: principalId, error: null }))
    const context = await authenticateAgentPrincipal(new Request('http://localhost/agora', {
      headers: { 'x-agora-agent-key': applicationKey }
    }), () => ({ rpc }))

    expect(context.principal).toEqual({ kind: 'agent', principalId })
    expect(Object.keys(context.database)).toEqual(['rpc'])
    expect(JSON.stringify(context)).not.toContain(applicationKey)
  })
})
