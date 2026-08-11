export type HealthConfig = {
  databaseTimeoutMs: number
  rateLimit: number
  rateLimitWindowMs: number
  supabaseServiceRoleKey: string
  supabaseUrl: string
}

const boundedInteger = (
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
) => {
  const parsed = Number(value)

  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback
}

export const readHealthConfig = (getEnvironment: (name: string) => string | undefined): HealthConfig => ({
  databaseTimeoutMs: boundedInteger(
    getEnvironment('AGORA_HEALTH_DATABASE_TIMEOUT_MS'),
    1000,
    100,
    5000
  ),
  rateLimit: boundedInteger(
    getEnvironment('AGORA_HEALTH_RATE_LIMIT'),
    10,
    1,
    600
  ),
  rateLimitWindowMs: boundedInteger(
    getEnvironment('AGORA_HEALTH_RATE_LIMIT_WINDOW_MS'),
    10000,
    1000,
    300000
  ),
  supabaseServiceRoleKey: getEnvironment('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  supabaseUrl: getEnvironment('SUPABASE_URL') ?? ''
})
