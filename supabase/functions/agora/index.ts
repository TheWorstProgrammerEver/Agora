import { authenticatePrincipal } from './auth/authenticatePrincipal.ts'
import { createAgentRlsClient } from './auth/agentRlsClient.ts'
import {
  authenticateAgentPrincipal
} from './auth/agentPrincipalResolver.ts'
import { authenticateHumanPrincipal } from './auth/humanPrincipalResolver.ts'
import { createHumanRlsClient } from './auth/humanRlsClient.ts'
import { validateHumanSession } from './auth/humanSessionValidator.ts'
import { isPublicProjectAuthorization } from './auth/rlsClient.ts'
import { createAgoraDispatcher } from './dispatcher.ts'
import { createAgoraHandler } from './handler.ts'
import { parseAgoraRequest } from './request.ts'

export default {
  fetch: createAgoraHandler({
    authenticate: (request) => authenticatePrincipal(request, {
      authenticateAgent: (agentRequest) => authenticateAgentPrincipal(
        agentRequest,
        createAgentRlsClient
      ),
      authenticateHuman: (humanRequest) => authenticateHumanPrincipal(
        humanRequest,
        validateHumanSession,
        createHumanRlsClient
      ),
      isPublicProjectAuthorization
    }),
    createDispatcher: createAgoraDispatcher,
    parseRequest: parseAgoraRequest
  })
}
