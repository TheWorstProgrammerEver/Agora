type HealthHandlerOptions = {
  checkDatabase: () => Promise<boolean>
  takeRateLimit: () => {
    allowed: boolean
    retryAfterSeconds?: number
  }
}

const responseHeaders = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
  'x-content-type-options': 'nosniff'
}

const healthPath = '/health'

const healthResponse = (status: number, ok: boolean, extraHeaders = {}) => new Response(
  JSON.stringify({ ok }),
  {
    headers: { ...responseHeaders, ...extraHeaders },
    status
  }
)

const requestIsMalformed = (request: Request) => {
  const url = new URL(request.url)
  const contentLength = request.headers.get('content-length')

  return url.pathname !== healthPath
    || url.search.length > 0
    || request.headers.has('transfer-encoding')
    || (contentLength !== null && contentLength !== '0')
}

export const createHealthHandler = ({
  checkDatabase,
  takeRateLimit
}: HealthHandlerOptions) => async (request: Request) => {
  const rateLimit = takeRateLimit()

  if (!rateLimit.allowed) {
    return healthResponse(429, false, {
      'retry-after': String(rateLimit.retryAfterSeconds ?? 1)
    })
  }

  if (request.method !== 'GET') {
    return healthResponse(405, false, { allow: 'GET' })
  }

  if (requestIsMalformed(request)) {
    return healthResponse(400, false)
  }

  try {
    return await checkDatabase()
      ? healthResponse(200, true)
      : healthResponse(503, false)
  } catch {
    return healthResponse(503, false)
  }
}
