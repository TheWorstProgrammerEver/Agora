import {
  agentApplicationKeyHeader,
  isAgentApplicationKey
} from '../../../../common/agentApplicationKey.ts'

type AgentResolverClient = {
  rpc(name: 'current_agent_principal_id'): PromiseLike<{
    data: unknown
    error: unknown
  }>
}

export type AgentPrincipalContext = {
  kind: 'agent'
  principalId: string
}

export class AgentAuthenticationError extends Error {
  readonly status = 401

  constructor() {
    super('A valid Agora agent key is required.')
  }
}

export const resolveAgentPrincipal = async (
  request: Request,
  createClient: (applicationKey: string) => AgentResolverClient
): Promise<AgentPrincipalContext> => {
  const applicationKey = request.headers.get(agentApplicationKeyHeader)

  if (!isAgentApplicationKey(applicationKey)) {
    throw new AgentAuthenticationError()
  }

  const { data, error } = await createClient(applicationKey).rpc(
    'current_agent_principal_id'
  )

  if (error || typeof data !== 'string') {
    throw new AgentAuthenticationError()
  }

  return { kind: 'agent', principalId: data }
}
