import {
  getPublicProjectKey,
  requireAuthenticationEnvironment
} from './rlsClient.ts'

const humanSessionTimeoutMs = 5000

export const validateHumanSession = async (accessToken: string) => {
  try {
    const response = await fetch(new URL(
      '/auth/v1/user',
      requireAuthenticationEnvironment('SUPABASE_URL')
    ), {
      headers: {
        apikey: getPublicProjectKey(),
        authorization: `Bearer ${accessToken}`
      },
      signal: AbortSignal.timeout(humanSessionTimeoutMs)
    })

    if (!response.ok) {
      await response.body?.cancel()
      return null
    }

    const body = await response.json() as { id?: unknown }

    return typeof body.id === 'string' ? { userId: body.id } : null
  } catch {
    return null
  }
}
