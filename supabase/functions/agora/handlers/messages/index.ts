import type { AgoraRequestHandlerFactory } from '../factory.ts'
import { sendMessageHandlerFactory } from './sendMessage.ts'

export const messageHandlerFactories: AgoraRequestHandlerFactory[] = [
  sendMessageHandlerFactory
]
