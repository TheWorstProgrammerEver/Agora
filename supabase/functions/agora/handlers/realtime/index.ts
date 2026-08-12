import type { AgoraRequestHandlerFactory } from '../factory.ts'
import { createRealtimeSessionHandlerFactoryDefault } from './createRealtimeSession.ts'

export const realtimeHandlerFactories: AgoraRequestHandlerFactory[] = [
  createRealtimeSessionHandlerFactoryDefault
]
