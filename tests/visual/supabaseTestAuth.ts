import { execFileSync } from 'node:child_process'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const supabaseBin = process.platform === 'win32'
  ? 'node_modules/.bin/supabase.cmd'
  : 'node_modules/.bin/supabase'
const supabaseCommand = process.platform === 'win32'
  ? { args: ['status', '-o', 'json'], file: supabaseBin }
  : { args: [supabaseBin, 'status', '-o', 'json'], file: process.execPath }

type SupabaseStatus = {
  API_URL?: string
  SERVICE_ROLE_KEY?: string
}

type AdminConfig = {
  serviceRoleKey: string
  url: string
}

let cachedAdminConfig: AdminConfig | undefined
let cachedAdminClient: SupabaseClient | undefined

const getLocalSupabaseStatus = (): SupabaseStatus => {
  const output = execFileSync(supabaseCommand.file, supabaseCommand.args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  })
  const jsonStart = output.indexOf('{')

  if (jsonStart === -1) {
    throw new Error('Could not read local Supabase status.')
  }

  return JSON.parse(output.slice(jsonStart)) as SupabaseStatus
}

const getAdminConfig = () => {
  if (cachedAdminConfig) {
    return cachedAdminConfig
  }

  const status = process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SUPABASE_URL
    ? undefined
    : getLocalSupabaseStatus()
  const url = process.env.SUPABASE_URL ?? status?.API_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? status?.SERVICE_ROLE_KEY

  if (!url || !serviceRoleKey) {
    throw new Error('Supabase test cleanup needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.')
  }

  cachedAdminConfig = { url, serviceRoleKey }

  return cachedAdminConfig
}

export const getSupabaseAdminClient = () => {
  if (cachedAdminClient) {
    return cachedAdminClient
  }

  const { url, serviceRoleKey } = getAdminConfig()
  cachedAdminClient = createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  })

  return cachedAdminClient
}

export const deleteSupabaseUsersByEmail = async (emails: string[]) => {
  if (emails.length === 0) {
    return
  }

  const emailSet = new Set(emails)
  const admin = getSupabaseAdminClient()
  const { data, error } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 1000
  })

  if (error) {
    throw error
  }

  const users = data.users.filter((user) => user.email && emailSet.has(user.email))
  const results = await Promise.all(users.map((user) => admin.auth.admin.deleteUser(user.id)))
  const deleteError = results.find((result) => result.error)?.error

  if (deleteError) {
    throw deleteError
  }
}
