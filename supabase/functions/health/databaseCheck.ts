type DatabaseCheckOptions = {
  fetch: typeof globalThis.fetch
  supabaseServiceRoleKey: string
  supabaseUrl: string
  timeoutMs: number
}

export const createDatabaseCheck = ({
  fetch,
  supabaseServiceRoleKey,
  supabaseUrl,
  timeoutMs
}: DatabaseCheckOptions) => async () => {
  if (!supabaseServiceRoleKey || !supabaseUrl) {
    return false
  }

  try {
    const url = new URL('/rest/v1/rpc/agora_health_check', supabaseUrl)
    const response = await fetch(url, {
      headers: {
        apikey: supabaseServiceRoleKey,
        authorization: `Bearer ${supabaseServiceRoleKey}`,
        'cache-control': 'no-store'
      },
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs)
    })

    await response.body?.cancel()
    return response.ok
  } catch {
    return false
  }
}
