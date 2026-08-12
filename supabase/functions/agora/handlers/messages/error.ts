export class AgoraMessageRequestError extends Error {
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

export const throwMessageDatabaseError = (error: unknown): never => {
  const code = (error as DatabaseError | null)?.code

  if (code === '42501') {
    throw new AgoraMessageRequestError('This message operation is not permitted.', 403)
  }

  if (code === '23505') {
    throw new AgoraMessageRequestError('This client message identifier is already in use.', 409)
  }

  if (code === '22001'
    || code === '22023'
    || code === '23514') {
    throw new AgoraMessageRequestError('Message request parameters are invalid.', 400)
  }

  throw new Error('Agora message database request failed.')
}
