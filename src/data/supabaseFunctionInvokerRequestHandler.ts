import type { SupabaseClient } from '@supabase/supabase-js'
import type { IRequest, RequestHandler } from '../../lib/dispatch/dispatch'

type FunctionErrorDetails = {
  message: string
  status?: number
}

export class FunctionRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
  }
}

const detailsFromFunctionError = async (error: unknown): Promise<FunctionErrorDetails> => {
  const context = typeof error === 'object' && error && 'context' in error
    ? error.context
    : undefined

  if (context instanceof Response) {
    try {
      const body = await context.json() as { error?: string }

      if (body.error) {
        return { message: body.error, status: context.status }
      }
    } catch {
      return { message: context.statusText, status: context.status }
    }

    return { message: context.statusText, status: context.status }
  }

  return {
    message: error instanceof Error ? error.message : 'Function request failed.'
  }
}

export const isFunctionAccessDenied = (error: unknown) => (
  error instanceof FunctionRequestError && (error.status === 403 || error.status === 404)
)

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
    const details = await detailsFromFunctionError(error)
    throw new FunctionRequestError(details.message, details.status)
  }

  if (!data) {
    throw new Error(`${functionName} did not return data.`)
  }

  return data
}
