import {
  createRequestHandlers,
  type RequestHandlerRegistration
} from '../../../../lib/dispatch/dispatch.ts'
import { agoraRequestNames } from '../../../../common/agoraRequestIdentifiers.ts'
import type { AuthorizedPrincipalContext } from '../auth/principalContext.ts'
import type { AgoraRequestHandlerFactory } from './factory.ts'
import { groupHandlerFactories } from './groups/index.ts'
import { membershipHandlerFactories } from './memberships/index.ts'
import { messageHandlerFactories } from './messages/index.ts'
import { realtimeHandlerFactories } from './realtime/index.ts'
import { unavailableHandlerFactories } from './unavailable.ts'

const mergeFactories = (overrides: AgoraRequestHandlerFactory[]) => {
  const overrideIdentifiers = overrides.map(({ identifier }) => identifier)

  if (new Set(overrideIdentifiers).size !== overrideIdentifiers.length) {
    throw new Error('Agora handler factory overrides must have unique identifiers.')
  }

  const byIdentifier = new Map(unavailableHandlerFactories.map((factory) => [
    factory.identifier,
    factory
  ]))

  for (const factory of groupHandlerFactories) {
    byIdentifier.set(factory.identifier, factory)
  }

  for (const factory of membershipHandlerFactories) {
    byIdentifier.set(factory.identifier, factory)
  }

  for (const factory of messageHandlerFactories) {
    byIdentifier.set(factory.identifier, factory)
  }

  for (const factory of realtimeHandlerFactories) {
    byIdentifier.set(factory.identifier, factory)
  }

  for (const override of overrides) {
    byIdentifier.set(override.identifier, override)
  }

  const factories = agoraRequestNames.map((identifier) => byIdentifier.get(identifier))

  if (factories.some((factory) => !factory)) {
    throw new Error('Agora handler factory catalog is incomplete.')
  }

  return factories as AgoraRequestHandlerFactory[]
}

export const createAgoraRequestHandlers = (
  context: AuthorizedPrincipalContext,
  overrides: AgoraRequestHandlerFactory[] = []
) => createRequestHandlers(mergeFactories(overrides).map((factory) => ({
  handler: factory.create(context),
  identifier: factory.identifier
}) satisfies RequestHandlerRegistration))
