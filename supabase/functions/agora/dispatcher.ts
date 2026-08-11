import { createDispatcher } from '../../../lib/dispatch/dispatch.ts'
import { createAgoraRequestHandlers } from './handlers/index.ts'

export const createAgoraDispatcher = () => createDispatcher(createAgoraRequestHandlers())
