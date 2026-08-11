type RateLimitResult = {
  allowed: boolean
  retryAfterSeconds?: number
}

export const createRateLimiter = (
  limit: number,
  windowMs: number,
  now = () => performance.now()
) => {
  let count = 0
  let resetAt = 0

  return (): RateLimitResult => {
    const currentTime = now()

    if (currentTime >= resetAt) {
      count = 0
      resetAt = currentTime + windowMs
    }

    if (count >= limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((resetAt - currentTime) / 1000))
      }
    }

    count += 1
    return { allowed: true }
  }
}
