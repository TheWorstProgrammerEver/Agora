import { withSupabase } from 'npm:@supabase/server@1.3.0'
import { createAgoraDispatcher } from './dispatcher.ts'
import { AgoraRequestParseError, parseAgoraRequest } from './request.ts'

const unavailableResponse = () => Response.json(
  { error: 'Agora request handlers are not implemented yet.' },
  { status: 501 }
)

export default {
  fetch: withSupabase({ auth: 'none' }, async (request) => {
    if (request.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 })
    }

    try {
      const dispatcher = createAgoraDispatcher()
      const agoraRequest = await parseAgoraRequest(request)

      await dispatcher.dispatch(agoraRequest)

      return unavailableResponse()
    } catch (error) {
      if (error instanceof AgoraRequestParseError) {
        return Response.json({ error: error.message }, { status: error.status })
      }

      return unavailableResponse()
    }
  })
}
