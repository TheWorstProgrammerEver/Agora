import { agoraContractVersion } from '../../../common/agoraRequestIdentifiers'
import { createDispatcher, createRequestHandlers } from '../../../lib/dispatch/dispatch'
import { createSupabaseFunctionInvokerRequestHandler } from '../supabaseFunctionInvokerRequestHandler'
import { supabase } from '../supabaseClient'
import { agoraRequestTypes } from './requests'

const agoraFunctionInvoker = createSupabaseFunctionInvokerRequestHandler(
  supabase,
  'agora',
  agoraContractVersion
)

const handlers = createRequestHandlers(agoraRequestTypes.map((requestType) => ({
  handler: agoraFunctionInvoker,
  identifier: requestType.identifier
})))

export const agoraDispatcher = createDispatcher(handlers)
