import type { PrincipalDatabase } from '../../auth/principalContext.ts'
import { throwMessageDatabaseError } from './error.ts'

type DatabaseResult = {
  data: unknown
  error: unknown
}

export const runMessageRpc = async (
  database: PrincipalDatabase,
  name: string,
  params: Record<string, unknown>
) => {
  const { data, error } = await database.rpc(name, params) as DatabaseResult

  if (error) {
    throwMessageDatabaseError(error)
  }

  if (!Array.isArray(data)) {
    throw new Error('Agora message database response is invalid.')
  }

  return data as Record<string, unknown>[]
}
