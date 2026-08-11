import { execFileSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'
import { Client } from 'pg'

type SupabaseStatus = {
  ANON_KEY?: string
  API_URL?: string
  DB_URL?: string
  PUBLISHABLE_KEY?: string
  SERVICE_ROLE_KEY?: string
}

const loopbackHosts = new Set(['127.0.0.1', '[::1]', 'localhost'])

const getLocalApiOrigin = (value: string) => {
  const url = new URL(value)

  if (url.protocol !== 'http:' || !loopbackHosts.has(url.hostname)) {
    throw new Error('Security integration tests require a local HTTP loopback Supabase URL.')
  }

  return url.origin
}

const getLocalDatabaseUrl = (value: string) => {
  const url = new URL(value)

  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !loopbackHosts.has(url.hostname)) {
    throw new Error('Security integration tests require a local loopback Postgres URL.')
  }

  return url.toString()
}

const getLocalSupabaseConfig = () => {
  const output = execFileSync('npx', ['--no-install', 'supabase', 'status', '-o', 'json'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  })
  const jsonStart = output.indexOf('{')

  if (jsonStart === -1) {
    throw new Error('Security integration tests need local Supabase running. Run npm run get-going first.')
  }

  const status = JSON.parse(output.slice(jsonStart)) as SupabaseStatus
  const publishableKey = status.PUBLISHABLE_KEY ?? status.ANON_KEY

  if (!status.API_URL || !status.DB_URL || !publishableKey || !status.SERVICE_ROLE_KEY) {
    throw new Error('Local Supabase status did not provide the required test configuration.')
  }

  return {
    databaseUrl: getLocalDatabaseUrl(status.DB_URL),
    publishableKey,
    serviceRoleKey: status.SERVICE_ROLE_KEY,
    url: getLocalApiOrigin(status.API_URL)
  }
}

const config = getLocalSupabaseConfig()

const clientOptions = {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
}

export const createAnonymousClient = () => createClient(
  config.url,
  config.publishableKey,
  clientOptions
)

export const createAgentClient = (applicationKey: string, accessToken?: string) => createClient(
  config.url,
  config.publishableKey,
  {
    ...clientOptions,
    global: {
      headers: {
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        'x-agora-agent-key': applicationKey
      }
    }
  }
)

export const createAdminClient = () => createClient(
  config.url,
  config.serviceRoleKey,
  clientOptions
)

export const createDatabaseClient = (applicationName: string) => new Client({
  application_name: applicationName,
  connectionString: config.databaseUrl
})
