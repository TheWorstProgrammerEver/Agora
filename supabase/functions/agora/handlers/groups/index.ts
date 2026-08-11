import type { AgoraRequestHandlerFactory } from '../factory.ts'
import { createGroupHandlerFactory } from './createGroup.ts'
import { deleteGroupHandlerFactory } from './deleteGroup.ts'
import { getGroupHandlerFactory } from './getGroup.ts'
import { listGroupsHandlerFactory } from './listGroups.ts'

export const groupHandlerFactories: AgoraRequestHandlerFactory[] = [
  createGroupHandlerFactory,
  deleteGroupHandlerFactory,
  getGroupHandlerFactory,
  listGroupsHandlerFactory
]
