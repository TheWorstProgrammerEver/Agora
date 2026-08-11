import type { SupabaseClient } from '@supabase/supabase-js'
import type { IRequest, RequestHandler } from '../../lib/dispatch/dispatch'

const messageFromFunctionError = async (error: unknown) => {
  const context = typeof error === 'object' && error && 'context' in error
    ? error.context
    : undefined

  if (context instanceof Response) {
    try {
      const body = await context.json() as { error?: string }

      if (body.error) {
        return body.error
      }
    } catch {
      return context.statusText
    }
  }

  return error instanceof Error ? error.message : 'Function request failed.'
}

export const createSupabaseFunctionInvokerRequestHandler = (
  client: SupabaseClient,
  functionName: string,
  contractVersion: number
): RequestHandler => async (request: IRequest<unknown, unknown>) => {
  const { data, error } = await client.functions.invoke(functionName, {
    body: {
      identifier: request.identifier,
      params: request.params,
      version: contractVersion
    }
  })

  if (error) {
    throw new Error(await messageFromFunctionError(error))
  }

  if (!data) {
    throw new Error(`${functionName} did not return data.`)
  }

  return data
}
