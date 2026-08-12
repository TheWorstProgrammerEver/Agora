export class AgoraRealtimeRequestError extends Error {
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

export const throwRealtimeDatabaseError = (error: unknown): never => {
  const code = (error as DatabaseError | null)?.code

  if (code === '42501') {
    throw new AgoraRealtimeRequestError('This Realtime session is not permitted.', 403)
  }

  if (code === '22003' || code === '22023' || code === '22P02') {
    throw new AgoraRealtimeRequestError('Realtime session parameters are invalid.', 400)
  }

  throw new Error('Agora Realtime database request failed.')
}
