import type { IRequest } from '../../../lib/dispatch/dispatch.ts'
import type {
  AgoraRequestParams,
  AgoraRequestResult
} from '../../../common/agoraRequestContract.ts'
import {
  agoraContractVersion,
  isAgoraRequestIdentifier,
  type AgoraRequestIdentifier
} from '../../../common/agoraRequestIdentifiers.ts'
import { isAgoraRequestParams } from '../../../common/agoraRequestValidation.ts'

const maximumRequestBytes = 64 * 1024

export class AgoraRequestParseError extends Error {
  readonly status = 400
}

type UntrustedRequestEnvelope = {
  identifier?: unknown
  params?: unknown
  version?: unknown
}

export type AgoraDispatchRequest = {
  [TIdentifier in AgoraRequestIdentifier]: IRequest<
    AgoraRequestResult<TIdentifier>,
    AgoraRequestParams<TIdentifier>
  > & { readonly identifier: TIdentifier }
}[AgoraRequestIdentifier]

const hasExactEnvelopeKeys = (value: Record<string, unknown>) => {
  const keys = Object.keys(value)

  return keys.length === 3
    && ['identifier', 'params', 'version'].every((key) => Object.hasOwn(value, key))
}

const readBoundedRequestText = async (request: Request) => {
  const reader = request.body?.getReader()

  if (!reader) {
    return ''
  }

  const chunks: Uint8Array[] = []
  let byteLength = 0

  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) {
        break
      }

      byteLength += value.byteLength

      if (byteLength > maximumRequestBytes) {
        try {
          await reader.cancel()
        } catch {
          // Preserve the bounded-request error even if stream cancellation fails.
        }

        throw new AgoraRequestParseError('Agora request body is too large.')
      }

      chunks.push(value)
    }
  } catch (error) {
    if (error instanceof AgoraRequestParseError) {
      throw error
    }

    throw new AgoraRequestParseError('Agora request body could not be read.')
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(byteLength)
  let offset = 0

  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  return new TextDecoder().decode(bytes)
}

export const parseAgoraRequest = async (
  request: Request
): Promise<AgoraDispatchRequest> => {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()

  if (contentType !== 'application/json') {
    throw new AgoraRequestParseError('Agora request content type must be application/json.')
  }

  let requestText: string

  try {
    requestText = await readBoundedRequestText(request)
  } catch (error) {
    if (error instanceof AgoraRequestParseError) {
      throw error
    }

    throw new AgoraRequestParseError('Agora request body could not be read.')
  }

  let untrustedBody: unknown

  try {
    untrustedBody = JSON.parse(requestText)
  } catch {
    throw new AgoraRequestParseError('Agora request body must be JSON.')
  }

  if (!untrustedBody || typeof untrustedBody !== 'object' || Array.isArray(untrustedBody)) {
    throw new AgoraRequestParseError('Agora request body must be an object.')
  }

  const body = untrustedBody as UntrustedRequestEnvelope

  if (!hasExactEnvelopeKeys(body)) {
    throw new AgoraRequestParseError('Agora request envelope is invalid.')
  }

  if (body.version !== agoraContractVersion) {
    throw new AgoraRequestParseError(`Agora contract version ${agoraContractVersion} is required.`)
  }

  if (!isAgoraRequestIdentifier(body.identifier)) {
    throw new AgoraRequestParseError('Agora request identifier is not supported.')
  }

  if (!isAgoraRequestParams(body.identifier, body.params)) {
    throw new AgoraRequestParseError('Agora request parameters are invalid.')
  }

  return {
    identifier: body.identifier,
    params: body.params
  } as AgoraDispatchRequest
}
