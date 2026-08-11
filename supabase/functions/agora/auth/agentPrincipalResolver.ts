import {
  agentApplicationKeyHeader,
  isAgentApplicationKey
} from '../../../../common/agentApplicationKey.ts'
import { AgoraAuthenticationError } from './authenticationError.ts'
import {
  createPrincipalDatabase,
  type AuthorizedPrincipalContext,
  type PrincipalContext
} from './principalContext.ts'

type AgentResolverClient = {
  rpc(name: string, params?: Record<string, unknown>): PromiseLike<{
    data: unknown
    error: unknown
  }>
}

export type AgentPrincipalContext = PrincipalContext & { kind: 'agent' }

export class AgentAuthenticationError extends AgoraAuthenticationError {
  constructor() {
    super('A valid Agora agent key is required.')
  }
}

export const resolveAgentPrincipal = async (
  request: Request,
  createClient: (applicationKey: string) => AgentResolverClient
): Promise<AgentPrincipalContext> => (
  await authenticateAgentPrincipal(request, createClient)
).principal as AgentPrincipalContext

export const authenticateAgentPrincipal = async (
  request: Request,
  createClient: (applicationKey: string) => AgentResolverClient
): Promise<AuthorizedPrincipalContext> => {
  const applicationKey = request.headers.get(agentApplicationKeyHeader)

  if (!isAgentApplicationKey(applicationKey)) {
    throw new AgentAuthenticationError()
  }

  const client = createClient(applicationKey)
  const { data, error } = await client.rpc('current_agent_principal_id')

  if (error || typeof data !== 'string') {
    throw new AgentAuthenticationError()
  }

  return {
    database: createPrincipalDatabase(client),
    principal: { kind: 'agent', principalId: data }
  }
}
