import type { PrincipalDatabase } from '../../auth/principalContext.ts'
import { throwGroupDatabaseError } from './error.ts'

type DatabaseResult = {
  data: unknown
  error: unknown
}

export const runGroupRpc = async (
  database: PrincipalDatabase,
  name: string,
  params: Record<string, unknown>
) => {
  const { data, error } = await database.rpc(name, params) as DatabaseResult

  if (error) {
    throwGroupDatabaseError(error)
  }

  if (!Array.isArray(data)) {
    throw new Error('Agora group database response is invalid.')
  }

  return data as Record<string, unknown>[]
}
