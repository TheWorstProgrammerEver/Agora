import { agoraRequestNames } from '../../../../common/agoraRequestIdentifiers.ts'
import { createAgoraRequestHandlerFactory } from './factory.ts'

export class AgoraHandlerUnavailableError extends Error {
  readonly status = 501

  constructor() {
    super('Agora request handler is not implemented yet.')
  }
}

export const unavailableHandlerFactories = agoraRequestNames.map((identifier) => (
  createAgoraRequestHandlerFactory(identifier, () => async () => {
    throw new AgoraHandlerUnavailableError()
  })
))
