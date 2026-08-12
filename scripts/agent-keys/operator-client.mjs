import { execFileSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'

const localLoopbackHosts = new Set(['127.0.0.1', '[::1]', 'localhost'])

const requireOperatorConfig = () => {
  const configuredUrl = process.env.AGORA_OPERATOR_SUPABASE_URL
  const configuredKey = process.env.AGORA_OPERATOR_SERVICE_ROLE_KEY

  if (configuredUrl || configuredKey) {
    if (!configuredUrl || !configuredKey) {
      throw new Error('Both Agora operator Supabase variables are required.')
    }

    return { serviceRoleKey: configuredKey, url: configuredUrl }
  }

  const output = execFileSync(
    'npx',
    ['--no-install', 'supabase', 'status', '-o', 'json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  )
  const jsonStart = output.indexOf('{')

  if (jsonStart === -1) {
    throw new Error('Local Supabase operator configuration is unavailable.')
  }

  const status = JSON.parse(output.slice(jsonStart))
  const url = new URL(status.API_URL)

  if (url.protocol !== 'http:' || !localLoopbackHosts.has(url.hostname)) {
    throw new Error('Automatic operator discovery is restricted to local Supabase.')
  }

  if (!status.SERVICE_ROLE_KEY) {
    throw new Error('Local Supabase did not provide an operator service-role key.')
  }

  return { serviceRoleKey: status.SERVICE_ROLE_KEY, url: url.origin }
}

const requireSuccessfulRpc = (result, operation) => {
  if (result.error) {
    throw new Error(`${operation} failed (${result.error.code ?? 'unknown'}).`)
  }

  return result.data
}

const requireIssuance = (data, operation) => {
  if (!Array.isArray(data) || data.length !== 1 || !data[0]?.application_key) {
    throw new Error(`${operation} did not return one application key.`)
  }

  return data[0]
}

export const createOperatorClient = () => {
  const config = requireOperatorConfig()
  const client = createClient(config.url, config.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  })

  return {
    beginRotation: async (principalId, readinessCapabilityId) => requireIssuance(
      requireSuccessfulRpc(
        await client.rpc('begin_agent_application_key_rotation', {
          agent_principal_id_to_rotate: principalId,
          host_readiness_capability_id: readinessCapabilityId
        }),
        'Agent key rotation'
      ),
      'Agent key rotation'
    ),
    completeRotation: async (keyId, fingerprint) => requireSuccessfulRpc(
      await client.rpc('complete_agent_application_key_rotation', {
        replacement_key_id: keyId,
        validated_fingerprint: fingerprint
      }),
      'Agent key rotation completion'
    ),
    deactivateAgent: async (principalId, reason) => requireSuccessfulRpc(
      await client.rpc('deactivate_agent_principal', {
        agent_principal_id_to_deactivate: principalId,
        deactivation_reason_to_use: reason
      }),
      'Agent deactivation'
    ),
    getProvisioningReadiness: async (principalId) => requireSuccessfulRpc(
      await client.rpc('get_agent_provisioning_readiness', {
        agent_principal_id_to_check: principalId
      }),
      'Agent provisioning readiness'
    ),
    issueInitialKey: async (principalId, readinessCapabilityId) => requireIssuance(
      requireSuccessfulRpc(
        await client.rpc('issue_initial_agent_application_key', {
          agent_principal_id_to_issue: principalId,
          host_readiness_capability_id: readinessCapabilityId
        }),
        'Initial agent key issuance'
      ),
      'Initial agent key issuance'
    ),
    prepareAgent: async (displayName) => requireSuccessfulRpc(
      await client.rpc('prepare_agent_principal', {
        display_name_to_use: displayName
      }),
      'Agent preparation'
    ),
    recordProvisioningReadiness: async ({
      agentPrincipalId,
      artifactDigest,
      checkedAt,
      operation,
      service
    }) => requireSuccessfulRpc(
      await client.rpc('record_agent_host_readiness', {
        agent_principal_id_to_check: agentPrincipalId,
        artifact_digest_to_check: artifactDigest,
        host_checked_at: checkedAt,
        operation_to_check: operation,
        service_name_to_check: service
      }),
      'Agent host readiness registration'
    ),
    revokeKey: async (keyId, reason) => requireSuccessfulRpc(
      await client.rpc('revoke_agent_application_key', {
        application_key_id_to_revoke: keyId,
        revocation_reason: reason
      }),
      'Agent key revocation'
    ),
    rollbackRotation: async (keyId) => requireSuccessfulRpc(
      await client.rpc('rollback_agent_application_key_rotation', {
        replacement_key_id: keyId
      }),
      'Agent key rotation rollback'
    )
  }
}
