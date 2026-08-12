import type { AuthorizedPrincipalContext } from './auth/principalContext.ts'
import { AgoraAuthenticationError } from './auth/authenticationError.ts'
import type { AgoraDispatchRequest } from './request.ts'
import { AgoraRequestParseError } from './request.ts'
import { AgoraHandlerUnavailableError } from './handlers/unavailable.ts'
import { AgoraGroupRequestError } from './handlers/groups/error.ts'
import { AgoraMessageRequestError } from './handlers/messages/error.ts'
import { AgoraRealtimeRequestError } from './handlers/realtime/error.ts'

type AgoraDispatcher = {
  dispatch(request: AgoraDispatchRequest): Promise<unknown>
}

type AgoraHandlerOptions = {
  authenticate(request: Request): Promise<AuthorizedPrincipalContext>
  createDispatcher(context: AuthorizedPrincipalContext): AgoraDispatcher
  parseRequest(request: Request): Promise<AgoraDispatchRequest>
}

const baseHeaders = {
  'access-control-allow-origin': '*',
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff'
}

const jsonResponse = (status: number, body: unknown, extraHeaders = {}) => new Response(
  JSON.stringify(body),
  {
    headers: { ...baseHeaders, ...extraHeaders },
    status
  }
)

const requestHasCanonicalPath = (request: Request) => {
  const url = new URL(request.url)

  return url.pathname === '/agora' && url.search.length === 0
}

export const createAgoraHandler = ({
  authenticate,
  createDispatcher,
  parseRequest
}: AgoraHandlerOptions) => async (request: Request) => {
  if (!requestHasCanonicalPath(request)) {
    return jsonResponse(400, { error: 'Agora request path is invalid.' })
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        ...baseHeaders,
        'access-control-allow-headers': [
          'apikey',
          'authorization',
          'content-type',
          'x-agora-agent-key',
          'x-client-info'
        ].join(', '),
        'access-control-allow-methods': 'POST, OPTIONS'
      },
      status: 204
    })
  }

  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed.' }, { allow: 'POST, OPTIONS' })
  }

  try {
    const context = await authenticate(request)
    const agoraRequest = await parseRequest(request)
    const result = await createDispatcher(context).dispatch(agoraRequest)

    return jsonResponse(200, result)
  } catch (error) {
    if (error instanceof AgoraAuthenticationError
      || error instanceof AgoraRequestParseError
      || error instanceof AgoraGroupRequestError
      || error instanceof AgoraMessageRequestError
      || error instanceof AgoraRealtimeRequestError
      || error instanceof AgoraHandlerUnavailableError) {
      return jsonResponse(error.status, { error: error.message })
    }

    return jsonResponse(500, { error: 'Agora request failed.' })
  }
}
