import {
  createRequestHandlers,
  type RequestHandlerRegistration
} from '../../../../lib/dispatch/dispatch.ts'

const handlerRegistrations = [] satisfies RequestHandlerRegistration[]

export const createAgoraRequestHandlers = () => createRequestHandlers(handlerRegistrations)
