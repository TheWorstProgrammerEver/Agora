export class AgoraGroupRequestError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

type DatabaseError = {
  code?: string
}

export const throwGroupDatabaseError = (error: unknown): never => {
  const code = (error as DatabaseError | null)?.code

  if (code === '42501') {
    throw new AgoraGroupRequestError('This group operation is not permitted.', 403)
  }

  if (code === '22001'
    || code === '22007'
    || code === '22008'
    || code === '22023'
    || code === '23514') {
    throw new AgoraGroupRequestError('Group request parameters are invalid.', 400)
  }

  throw new Error('Agora group database request failed.')
}
