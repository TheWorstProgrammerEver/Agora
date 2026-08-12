import type { AgoraRequestHandlerFactory } from '../factory.ts'
import { getGroupMessagesHandlerFactory } from './getGroupMessages.ts'
import { getUnreadMessagesHandlerFactory } from './getUnreadMessages.ts'
import { markGroupReadHandlerFactory } from './markGroupRead.ts'
import { sendMessageHandlerFactory } from './sendMessage.ts'

export const messageHandlerFactories: AgoraRequestHandlerFactory[] = [
  getGroupMessagesHandlerFactory,
  getUnreadMessagesHandlerFactory,
  markGroupReadHandlerFactory,
  sendMessageHandlerFactory
]
