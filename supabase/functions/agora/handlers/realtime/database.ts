import type { PrincipalDatabase } from '../../auth/principalContext.ts'
import { throwRealtimeDatabaseError } from './error.ts'

type DatabaseResult = {
  data: unknown
  error: unknown
}

export const authorizeRealtimeTopics = async (
  database: PrincipalDatabase,
  groupIds: string[]
) => {
  const { data, error } = await database.rpc('authorize_agora_realtime_topics', {
    group_ids_to_authorize: groupIds
  }) as DatabaseResult

  if (error) {
    throwRealtimeDatabaseError(error)
  }

  if (!Array.isArray(data)) {
    throw new Error('Agora Realtime database response is invalid.')
  }

  return data as Record<string, unknown>[]
}
