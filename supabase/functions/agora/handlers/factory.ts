import type {
  AgoraRequestParams,
  AgoraRequestResult
} from '../../../../common/agoraRequestContract.ts'
import type { AgoraRequestIdentifier } from '../../../../common/agoraRequestIdentifiers.ts'
import type {
  IRequest,
  RequestHandler
} from '../../../../lib/dispatch/dispatch.ts'
import type { AuthorizedPrincipalContext } from '../auth/principalContext.ts'

type AgoraRequest<TIdentifier extends AgoraRequestIdentifier> = IRequest<
  AgoraRequestResult<TIdentifier>,
  AgoraRequestParams<TIdentifier>
> & {
  readonly identifier: TIdentifier
}

type AgoraRequestHandler<TIdentifier extends AgoraRequestIdentifier> = (
  request: AgoraRequest<TIdentifier>
) => AgoraRequestResult<TIdentifier> | Promise<AgoraRequestResult<TIdentifier>>

export type AgoraRequestHandlerFactory = {
  readonly identifier: AgoraRequestIdentifier
  create(context: AuthorizedPrincipalContext): RequestHandler
}

export const createAgoraRequestHandlerFactory = <
  TIdentifier extends AgoraRequestIdentifier
>(
  identifier: TIdentifier,
  create: (context: AuthorizedPrincipalContext) => AgoraRequestHandler<TIdentifier>
): AgoraRequestHandlerFactory => ({
    identifier,
    create: (context) => create(context) as RequestHandler
  })
