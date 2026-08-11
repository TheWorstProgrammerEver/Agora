import { createDispatcher } from '../../../lib/dispatch/dispatch.ts'
import type { AuthorizedPrincipalContext } from './auth/principalContext.ts'
import type { AgoraRequestHandlerFactory } from './handlers/factory.ts'
import { createAgoraRequestHandlers } from './handlers/index.ts'

export const createAgoraDispatcher = (
  context: AuthorizedPrincipalContext,
  overrides: AgoraRequestHandlerFactory[] = []
) => createDispatcher(createAgoraRequestHandlers(context, overrides))
