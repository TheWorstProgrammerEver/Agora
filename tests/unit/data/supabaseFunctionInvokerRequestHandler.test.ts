import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import {
  createSupabaseFunctionInvokerRequestHandler,
  FunctionRequestError,
  isFunctionAccessDenied
} from '../../../src/data/supabaseFunctionInvokerRequestHandler'

const request = { identifier: 'example', params: { value: true } }

const clientWithResult = (result: unknown) => ({
  functions: {
    invoke: async () => result
  }
}) as unknown as SupabaseClient

describe('Supabase function invocation errors', () => {
  it('preserves the response status needed to revoke protected UI state', async () => {
    const handler = createSupabaseFunctionInvokerRequestHandler(clientWithResult({
      data: null,
      error: {
        context: new Response(JSON.stringify({ error: 'Membership is unavailable.' }), {
          status: 403,
          statusText: 'Forbidden'
        })
      }
    }), 'agora', 1)

    const error = await Promise.resolve(handler(request)).catch((caught: unknown) => caught)

    expect(error).toEqual(expect.objectContaining({
      message: 'Membership is unavailable.',
      status: 403
    }))
    expect(error).toBeInstanceOf(FunctionRequestError)
    expect(isFunctionAccessDenied(error)).toBe(true)
  })

  it('keeps transient failures recoverable without classifying them as revocation', async () => {
    const handler = createSupabaseFunctionInvokerRequestHandler(clientWithResult({
      data: null,
      error: {
        context: new Response(JSON.stringify({ error: 'Try again.' }), { status: 503 })
      }
    }), 'agora', 1)

    const error = await Promise.resolve(handler(request)).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(FunctionRequestError)
    expect(isFunctionAccessDenied(error)).toBe(false)
  })
})
