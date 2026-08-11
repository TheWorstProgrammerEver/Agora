import type { IRequest } from '../../../lib/dispatch/dispatch.ts'
import {
  agoraContractVersion,
  isAgoraRequestIdentifier
} from '../../../common/agoraRequestIdentifiers.ts'

export class AgoraRequestParseError extends Error {
  readonly status = 400
}

type UntrustedRequestEnvelope = {
  identifier?: unknown
  params?: unknown
  version?: unknown
}

export const parseAgoraRequest = async (
  request: Request
): Promise<IRequest<unknown, unknown>> => {
  let untrustedBody: unknown

  try {
    untrustedBody = await request.json()
  } catch {
    throw new AgoraRequestParseError('Agora request body must be JSON.')
  }

  if (!untrustedBody || typeof untrustedBody !== 'object' || Array.isArray(untrustedBody)) {
    throw new AgoraRequestParseError('Agora request body must be an object.')
  }

  const body = untrustedBody as UntrustedRequestEnvelope

  if (body.version !== agoraContractVersion) {
    throw new AgoraRequestParseError(`Agora contract version ${agoraContractVersion} is required.`)
  }

  if (!isAgoraRequestIdentifier(body.identifier)) {
    throw new AgoraRequestParseError('Agora request identifier is not supported.')
  }

  return {
    identifier: body.identifier,
    params: body.params
  }
}
