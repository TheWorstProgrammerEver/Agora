import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  agoraContractVersion,
  agoraRequestIdentifiers
} from '../../../common/agoraRequestIdentifiers'
import {
  beginAgentRotation,
  deleteAgentFixtures,
  provisionAgentFixture,
  type AgentFixture
} from './agentFixture'
import {
  cleanupGroupSecurityFixture,
  createGroupSecurityFixture,
  type GroupSecurityFixture
} from './groupFixture'
import {
  createAdminClient,
  createAgentClient,
  createAnonymousClient,
  createDatabaseClient
} from './localSupabase'

const admin = createAdminClient()
const agoraFunctionUrl = 'http://127.0.0.1:54321/functions/v1/agora'
let groupFixture: GroupSecurityFixture | undefined

const requireGroupFixture = () => {
  if (!groupFixture) {
    throw new Error('Group security fixture was not created.')
  }

  return groupFixture
}

const withAgent = async (run: (agent: AgentFixture) => Promise<void>) => {
  const agent = await provisionAgentFixture(`Security agent ${randomUUID()}`)

  try {
    await run(agent)
  } finally {
    await deleteAgentFixtures([agent])
  }
}

const resolvePrincipalId = async (agent: AgentFixture) => {
  const { data, error } = await agent.client.rpc('current_agent_principal_id')

  expect(error).toBeNull()

  return data as string | null
}

const postAgentRequest = (applicationKey: string) => fetch(agoraFunctionUrl, {
  body: JSON.stringify({
    identifier: agoraRequestIdentifiers.listGroups,
    params: {},
    version: agoraContractVersion
  }),
  headers: {
    'content-type': 'application/json',
    'x-agora-agent-key': applicationKey
  },
  method: 'POST'
})

const assertAbsentFromLocalServiceLogs = (applicationKey: string) => {
  for (const container of [
    'supabase_db_agora',
    'supabase_edge_runtime_agora',
    'supabase_kong_agora',
    'supabase_rest_agora'
  ]) {
    const result = spawnSync('docker', ['logs', container], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024
    })

    if (result.status !== 0) {
      throw new Error('Local Supabase logs could not be inspected safely.')
    }

    if (`${result.stdout}${result.stderr}`.includes(applicationKey)) {
      throw new Error('A raw Agora agent key appeared in local service logs.')
    }
  }
}

beforeAll(async () => {
  groupFixture = await createGroupSecurityFixture()
})

afterAll(async () => {
  await cleanupGroupSecurityFixture(groupFixture)
})

describe('agent principal issuance', () => {
  it('requires active group membership before initial key issuance', async () => {
    const source = requireGroupFixture()
    const prepared = await admin.rpc('prepare_agent_principal', {
      display_name_to_use: `Staged security agent ${randomUUID()}`
    })
    const principalId = prepared.data?.[0]?.agent_principal_id as string

    expect(prepared.error).toBeNull()
    expect(principalId).toBeTruthy()

    try {
      const denied = await admin.rpc('issue_initial_agent_application_key', {
        agent_principal_id_to_issue: principalId
      })
      expect(denied.error?.code).toBe('55000')

      const readinessBefore = await admin.rpc('get_agent_provisioning_readiness', {
        agent_principal_id_to_check: principalId
      })
      expect(readinessBefore.data).toMatchObject([{
        authorized_group_count: 0,
        live_key_count: 0,
        ready_for_initial_key: false
      }])

      const membership = await admin.from('memberships').insert({
        group_id: source.groups.visible,
        principal_id: principalId,
        role: 'member'
      })
      expect(membership.error).toBeNull()

      const readinessAfter = await admin.rpc('get_agent_provisioning_readiness', {
        agent_principal_id_to_check: principalId
      })
      expect(readinessAfter.data).toMatchObject([{
        authorized_group_count: 1,
        live_key_count: 0,
        ready_for_initial_key: true
      }])

      const issuance = await admin.rpc('issue_initial_agent_application_key', {
        agent_principal_id_to_issue: principalId
      })
      expect(issuance.error).toBeNull()
      expect(issuance.data).toHaveLength(1)
      expect(issuance.data?.[0]?.application_key).toMatch(/^agora_agent_v1_[A-Za-z0-9_-]{43}$/)
    } finally {
      await deleteAgentFixtures([{ principalId } as AgentFixture])
    }
  })

  it('stores only a strong digest and exposes audit-safe metadata after issuance', async () => {
    await withAgent(async (agent) => {
      const database = createDatabaseClient('agora-agent-digest-validation')
      const expectedDigest = createHash('sha256').update(agent.applicationKey).digest('hex')

      try {
        await database.connect()
        const { rows } = await database.query<{
          digest: string
          fingerprint: string
        }>(`
          select encode(key_digest, 'hex') as digest, fingerprint
          from public.agent_application_keys
          where id = $1
        `, [agent.keyId])

        expect(rows).toEqual([{
          digest: expectedDigest,
          fingerprint: `sha256:${expectedDigest.slice(0, 16)}`
        }])
      } finally {
        await database.end()
      }

      const auditResult = await admin
        .from('agent_application_key_audit')
        .select('*')
        .eq('application_key_id', agent.keyId)
        .single()
      const baseTableResult = await admin
        .from('agent_application_keys')
        .select('*')
        .eq('id', agent.keyId)

      expect(auditResult.error).toBeNull()
      expect(auditResult.data).toMatchObject({
        agent_principal_id: agent.principalId,
        application_key_id: agent.keyId,
        fingerprint: agent.fingerprint,
        state: 'active'
      })
      expect(Object.keys(auditResult.data ?? {})).not.toContain('key_digest')
      expect(JSON.stringify(auditResult.data)).not.toContain(agent.applicationKey)
      expect(baseTableResult.error).not.toBeNull()
      expect(agent.applicationKey).toMatch(/^agora_agent_v1_[A-Za-z0-9_-]{43}$/)
      expect(process.argv).not.toContain(agent.applicationKey)
      assertAbsentFromLocalServiceLogs(agent.applicationKey)
    })
  })

  it('denies provisioning and lifecycle RPCs to anonymous, human, and agent callers', async () => {
    await withAgent(async (agent) => {
      const source = requireGroupFixture()
      const callers = [
        createAnonymousClient(),
        source.humans.owner.client,
        agent.client
      ]

      for (const caller of callers) {
        const provision = await caller.rpc('prepare_agent_principal', {
          display_name_to_use: 'Unauthorized agent'
        })
        const rotation = await caller.rpc('begin_agent_application_key_rotation', {
          agent_principal_id_to_rotate: agent.principalId
        })
        const revocation = await caller.rpc('revoke_agent_application_key', {
          application_key_id_to_revoke: agent.keyId,
          revocation_reason: 'Unauthorized revocation'
        })

        expect(provision.error).not.toBeNull()
        expect(rotation.error).not.toBeNull()
        expect(revocation.error).not.toBeNull()
      }

      const directPrincipalInsert = await agent.client.from('principals').insert({
        auth_user_id: null,
        display_name: 'Unauthorized agent',
        kind: 'agent'
      })
      const keyAuditRead = await agent.client.from('agent_application_key_audit').select('*')

      expect(directPrincipalInsert.error).not.toBeNull()
      expect(keyAuditRead.error).not.toBeNull()
      await expect(resolvePrincipalId(agent)).resolves.toBe(agent.principalId)
    })
  })
})

describe('agent key resolver', () => {
  it('maps valid keys to exactly their own principal and group memberships', async () => {
    const first = await provisionAgentFixture(`First resolver agent ${randomUUID()}`)
    const second = await provisionAgentFixture(`Second resolver agent ${randomUUID()}`)
    const source = requireGroupFixture()

    try {
      const membershipResults = await Promise.all([
        admin.from('memberships').insert({
          group_id: source.groups.visible,
          principal_id: first.principalId,
          role: 'member'
        }),
        admin.from('memberships').insert({
          group_id: source.groups.hidden,
          principal_id: second.principalId,
          role: 'member'
        })
      ])

      for (const result of membershipResults) {
        expect(result.error).toBeNull()
      }

      const [firstResolution, secondResolution, firstGroups, secondGroups] = await Promise.all([
        resolvePrincipalId(first),
        resolvePrincipalId(second),
        first.client.from('groups').select('id'),
        second.client.from('groups').select('id')
      ])

      expect(firstResolution).toBe(first.principalId)
      expect(secondResolution).toBe(second.principalId)
      expect(firstResolution).not.toBe(secondResolution)
      expect(firstGroups.error).toBeNull()
      expect(firstGroups.data).toEqual([{ id: source.groups.visible }])
      expect(secondGroups.error).toBeNull()
      expect(secondGroups.data).toEqual([{ id: source.groups.hidden }])
    } finally {
      await admin.from('memberships').delete().in('principal_id', [first.principalId, second.principalId])
      await deleteAgentFixtures([first, second])
    }
  })

  it('fails closed for missing, invalid, and malformed keys', async () => {
    const missing = await createAnonymousClient().rpc('current_agent_principal_id')
    const invalid = await createAgentClient(
      `agora_agent_v1_${'A'.repeat(43)}`
    ).rpc('current_agent_principal_id')
    const malformedValues = [
      '',
      'agora_agent_v1_short',
      `agora_agent_v1_${'A'.repeat(44)}`,
      `agora_agent_v1_${'A'.repeat(42)}!`,
      'sb_secret_example'
    ]

    expect(missing.error).toBeNull()
    expect(missing.data).toBeNull()
    expect(invalid.error).toBeNull()
    expect(invalid.data).toBeNull()
    expect((await postAgentRequest(`agora_agent_v1_${'A'.repeat(43)}`)).status).toBe(401)

    for (const malformed of malformedValues) {
      const result = await createAgentClient(malformed).rpc('current_agent_principal_id')

      expect(result.error).toBeNull()
      expect(result.data).toBeNull()
    }
  })

  it('does not let a signed-in human switch principals by adding an agent key', async () => {
    await withAgent(async (agent) => {
      const human = requireGroupFixture().humans.owner
      const session = await human.client.auth.getSession()

      expect(session.error).toBeNull()
      expect(session.data.session?.access_token).toBeTruthy()

      const combined = createAgentClient(
        agent.applicationKey,
        session.data.session?.access_token
      )
      const currentPrincipal = await combined.rpc('current_principal_id')
      const directAgentResolver = await combined.rpc('current_agent_principal_id')
      const visiblePrincipals = await combined.from('principals').select('id')

      expect(currentPrincipal.error).toBeNull()
      expect(currentPrincipal.data).toBe(human.principalId)
      expect(directAgentResolver.error).not.toBeNull()
      expect(visiblePrincipals.error).toBeNull()
      expect(visiblePrincipals.data).toEqual([{ id: human.principalId }])
    })
  })

  it('denies a revoked key immediately on the next request', async () => {
    await withAgent(async (agent) => {
      await expect(resolvePrincipalId(agent)).resolves.toBe(agent.principalId)
      expect((await postAgentRequest(agent.applicationKey)).status).toBe(200)

      const revocation = await admin.rpc('revoke_agent_application_key', {
        application_key_id_to_revoke: agent.keyId,
        revocation_reason: 'Security test revocation'
      })

      expect(revocation.error).toBeNull()
      await expect(resolvePrincipalId(agent)).resolves.toBeNull()
      const deniedResponse = await postAgentRequest(agent.applicationKey)

      expect(deniedResponse.status).toBe(401)
      await expect(deniedResponse.json()).resolves.toEqual({
        error: 'A valid Agora agent key is required.'
      })
      assertAbsentFromLocalServiceLogs(agent.applicationKey)
    })
  })
})

describe('agent key rotation', () => {
  it('keeps the old key valid until a validated replacement is activated', async () => {
    await withAgent(async (agent) => {
      const replacement = await beginAgentRotation(agent.principalId)

      await expect(resolvePrincipalId(agent)).resolves.toBe(agent.principalId)
      await expect(resolvePrincipalId(replacement)).resolves.toBe(agent.principalId)

      const duplicateRotation = await admin.rpc('begin_agent_application_key_rotation', {
        agent_principal_id_to_rotate: agent.principalId
      })
      const wrongFingerprint = await admin.rpc('complete_agent_application_key_rotation', {
        replacement_key_id: replacement.keyId,
        validated_fingerprint: agent.fingerprint
      })

      expect(duplicateRotation.error).not.toBeNull()
      expect(wrongFingerprint.error).not.toBeNull()
      await expect(resolvePrincipalId(agent)).resolves.toBe(agent.principalId)
      await expect(resolvePrincipalId(replacement)).resolves.toBe(agent.principalId)

      const completion = await admin.rpc('complete_agent_application_key_rotation', {
        replacement_key_id: replacement.keyId,
        validated_fingerprint: replacement.fingerprint
      })

      expect(completion.error).toBeNull()
      await expect(resolvePrincipalId(agent)).resolves.toBeNull()
      await expect(resolvePrincipalId(replacement)).resolves.toBe(agent.principalId)

      const audit = await admin
        .from('agent_application_key_audit')
        .select('application_key_id, state, replaces_key_id, rotation_completed_at, revoked_reason')
        .in('application_key_id', [agent.keyId, replacement.keyId])

      expect(audit.error).toBeNull()
      expect(audit.data).toEqual(expect.arrayContaining([
        expect.objectContaining({
          application_key_id: agent.keyId,
          revoked_reason: 'rotated',
          state: 'revoked'
        }),
        expect.objectContaining({
          application_key_id: replacement.keyId,
          replaces_key_id: agent.keyId,
          rotation_completed_at: expect.any(String),
          state: 'active'
        })
      ]))
    })
  })

  it('rolls back a pending replacement without revoking the old key', async () => {
    await withAgent(async (agent) => {
      const replacement = await beginAgentRotation(agent.principalId)
      const rollback = await admin.rpc('rollback_agent_application_key_rotation', {
        replacement_key_id: replacement.keyId
      })

      expect(rollback.error).toBeNull()
      await expect(resolvePrincipalId(agent)).resolves.toBe(agent.principalId)
      await expect(resolvePrincipalId(replacement)).resolves.toBeNull()
    })
  })

  it('deactivates an agent and all overlapping rotation keys atomically', async () => {
    await withAgent(async (agent) => {
      const replacement = await beginAgentRotation(agent.principalId)
      const deactivation = await admin.rpc('deactivate_agent_principal', {
        agent_principal_id_to_deactivate: agent.principalId,
        deactivation_reason_to_use: 'x'.repeat(200)
      })

      expect(deactivation.error).toBeNull()
      await expect(resolvePrincipalId(agent)).resolves.toBeNull()
      await expect(resolvePrincipalId(replacement)).resolves.toBeNull()
    })
  })
})
