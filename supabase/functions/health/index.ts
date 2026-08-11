import { readHealthConfig } from './config.ts'
import { createDatabaseCheck } from './databaseCheck.ts'
import { createHealthHandler } from './handler.ts'
import { createRateLimiter } from './rateLimiter.ts'

const config = readHealthConfig((name) => Deno.env.get(name))

export default {
  fetch: createHealthHandler({
    checkDatabase: createDatabaseCheck({
      fetch,
      supabaseServiceRoleKey: config.supabaseServiceRoleKey,
      supabaseUrl: config.supabaseUrl,
      timeoutMs: config.databaseTimeoutMs
    }),
    takeRateLimit: createRateLimiter(config.rateLimit, config.rateLimitWindowMs)
  })
}
