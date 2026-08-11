import { agentApplicationKeyHeader } from '../../../../common/agentApplicationKey.ts'
import { AgoraAuthenticationError } from './authenticationError.ts'
import type { AuthorizedPrincipalContext } from './principalContext.ts'

type PrincipalAuthenticator = (request: Request) => Promise<AuthorizedPrincipalContext>

type PrincipalAuthenticatorOptions = {
  authenticateAgent: PrincipalAuthenticator
  authenticateHuman: PrincipalAuthenticator
  isPublicProjectAuthorization?(authorization: string): boolean
}

export class MissingAuthenticationError extends AgoraAuthenticationError {
  constructor() {
    super('A human session or Agora agent key is required.')
  }
}

export const authenticatePrincipal = (
  request: Request,
  {
    authenticateAgent,
    authenticateHuman,
    isPublicProjectAuthorization = () => false
  }: PrincipalAuthenticatorOptions
) => {
  const authorization = request.headers.get('authorization')

  if (authorization && !isPublicProjectAuthorization(authorization)) {
    return authenticateHuman(request)
  }

  if (request.headers.has(agentApplicationKeyHeader)) {
    return authenticateAgent(request)
  }

  throw new MissingAuthenticationError()
}
