import { agentApplicationKeyHeader } from '../../../../common/agentApplicationKey.ts'
import { createRlsClient } from './rlsClient.ts'

export const createAgentRlsClient = (applicationKey: string) => createRlsClient({
  [agentApplicationKeyHeader]: applicationKey
})
