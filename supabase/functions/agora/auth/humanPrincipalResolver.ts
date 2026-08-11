import { AgoraAuthenticationError } from './authenticationError.ts'
import {
  createPrincipalDatabase,
  type AuthorizedPrincipalContext
} from './principalContext.ts'

type HumanRlsClient = {
  rpc(name: string, params?: Record<string, unknown>): PromiseLike<{
    data: unknown
    error: unknown
  }>
}

const bearerPattern = /^Bearer ([^\s,]+)$/i

export class HumanAuthenticationError extends AgoraAuthenticationError {
  constructor() {
    super('A valid human session is required.')
  }
}

export const authenticateHumanPrincipal = async (
  request: Request,
  validateSession: (accessToken: string) => Promise<{ userId: string } | null>,
  createClient: (accessToken: string) => HumanRlsClient
): Promise<AuthorizedPrincipalContext> => {
  const match = bearerPattern.exec(request.headers.get('authorization') ?? '')
  const accessToken = match?.[1]

  if (!accessToken || accessToken.length > 8192) {
    throw new HumanAuthenticationError()
  }

  const user = await validateSession(accessToken)

  if (!user) {
    throw new HumanAuthenticationError()
  }

  const client = createClient(accessToken)
  const principalResult = await client.rpc('current_principal_id')

  if (principalResult.error || typeof principalResult.data !== 'string') {
    throw new HumanAuthenticationError()
  }

  return {
    database: createPrincipalDatabase(client),
    principal: {
      kind: 'human',
      principalId: principalResult.data
    }
  }
}
