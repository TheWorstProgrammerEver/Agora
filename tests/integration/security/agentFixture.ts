import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient, createAgentClient, createDatabaseClient } from './localSupabase'

type AgentIssuance = {
  agent_principal_id: string
  application_key: string
  application_key_id: string
  issued_at: string
  key_fingerprint: string
}

export type AgentFixture = {
  applicationKey: string
  client: SupabaseClient
  fingerprint: string
  keyId: string
  principalId: string
}

const requireSingleIssuance = (
  data: AgentIssuance[] | null,
  error: { message: string } | null,
  operation: string
) => {
  if (error || data?.length !== 1) {
    throw error ?? new Error(`${operation} did not return one application key.`)
  }

  return data[0]
}

export const provisionAgentFixture = async (displayName: string): Promise<AgentFixture> => {
  const { data, error } = await createAdminClient().rpc('provision_agent_principal', {
    display_name_to_use: displayName
  })
  const issuance = requireSingleIssuance(
    data as AgentIssuance[] | null,
    error,
    'Agent provisioning'
  )

  return {
    applicationKey: issuance.application_key,
    client: createAgentClient(issuance.application_key),
    fingerprint: issuance.key_fingerprint,
    keyId: issuance.application_key_id,
    principalId: issuance.agent_principal_id
  }
}

export const beginAgentRotation = async (principalId: string) => {
  const { data, error } = await createAdminClient().rpc(
    'begin_agent_application_key_rotation',
    { agent_principal_id_to_rotate: principalId }
  )
  const issuance = requireSingleIssuance(
    data as AgentIssuance[] | null,
    error,
    'Agent key rotation'
  )

  return {
    applicationKey: issuance.application_key,
    client: createAgentClient(issuance.application_key),
    fingerprint: issuance.key_fingerprint,
    keyId: issuance.application_key_id,
    principalId: issuance.agent_principal_id
  }
}

export const deleteAgentFixtures = async (fixtures: AgentFixture[]) => {
  const principalIds = fixtures.map((fixture) => fixture.principalId)

  if (principalIds.length === 0) {
    return
  }

  const database = createDatabaseClient('agora-agent-fixture-cleanup')

  try {
    await database.connect()
    await database.query(
      'delete from public.principals where id = any($1::uuid[])',
      [principalIds]
    )
  } finally {
    await database.end()
  }
}
