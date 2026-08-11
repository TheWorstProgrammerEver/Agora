import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const supabaseBin = process.platform === 'win32'
  ? 'node_modules/.bin/supabase.cmd'
  : 'node_modules/.bin/supabase'
const supabaseCommand = process.platform === 'win32'
  ? { args: ['status', '-o', 'json'], file: supabaseBin }
  : { args: [supabaseBin, 'status', '-o', 'json'], file: process.execPath }
const visualConfigPath = 'tests/visual/config.test.json'
const defaultPageSize = 1000
const defaultMaxPages = 1000

type SupabaseStatus = {
  API_URL?: string
  SERVICE_ROLE_KEY?: string
}

type AdminConfig = {
  serviceRoleKey: string
  url: string
}

type ListedUser = {
  email?: string
  id: string
}

type ListUsersResult = {
  data: {
    nextPage?: unknown
    users: ListedUser[]
  }
  error: unknown
}

type ListUsers = (params: { page: number; perPage: number }) => Promise<ListUsersResult>
type AdminClientFactory = (url: string, serviceRoleKey: string) => SupabaseClient

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

const getVisualSupabaseUrl = () => {
  const config = JSON.parse(readFileSync(visualConfigPath, 'utf8')) as {
    supabase?: { url?: unknown }
  }

  if (typeof config.supabase?.url !== 'string') {
    throw new Error('Visual test config needs a Supabase URL.')
  }

  return config.supabase.url
}

const getLocalOrigin = (value: string, label: string) => {
  let url

  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label} is not a valid URL.`)
  }

  const loopbackHosts = new Set(['127.0.0.1', '[::1]', 'localhost'])

  if (url.protocol !== 'http:' || !loopbackHosts.has(url.hostname)) {
    throw new Error(`${label} must use an explicit local HTTP loopback origin.`)
  }

  return url.origin
}

export const resolveLocalAdminConfig = (
  browserSupabaseUrl: string,
  status: SupabaseStatus
): AdminConfig => {
  if (!status.API_URL || !status.SERVICE_ROLE_KEY) {
    throw new Error('Local Supabase status did not provide cleanup credentials.')
  }

  const browserOrigin = getLocalOrigin(browserSupabaseUrl, 'Visual test Supabase URL')
  const adminOrigin = getLocalOrigin(status.API_URL, 'Admin cleanup Supabase URL')

  if (browserOrigin !== adminOrigin) {
    throw new Error('Visual test and admin cleanup Supabase origins must match exactly.')
  }

  return {
    serviceRoleKey: status.SERVICE_ROLE_KEY,
    url: status.API_URL
  }
}

export const createLocalAdminClient = (
  browserSupabaseUrl: string,
  status: SupabaseStatus,
  clientFactory: AdminClientFactory = (url, serviceRoleKey) => createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  })
) => {
  const { url, serviceRoleKey } = resolveLocalAdminConfig(browserSupabaseUrl, status)

  return clientFactory(url, serviceRoleKey)
}

export const getSupabaseAdminClient = () => {
  if (!cachedAdminClient) {
    cachedAdminClient = createLocalAdminClient(
      getVisualSupabaseUrl(),
      getLocalSupabaseStatus()
    )
  }

  return cachedAdminClient
}

export const findSupabaseUsersByEmail = async (
  listUsers: ListUsers,
  emails: string[],
  options: { maxPages?: number; pageSize?: number } = {}
) => {
  const pageSize = options.pageSize ?? defaultPageSize
  const maxPages = options.maxPages ?? defaultMaxPages
  const remainingEmails = new Set(emails)
  const matchedUsers: ListedUser[] = []
  const visitedPages = new Set<number>()
  let page = 1

  for (let pageCount = 0; pageCount < maxPages; pageCount += 1) {
    if (visitedPages.has(page)) {
      throw new Error('Supabase user cleanup pagination repeated a page.')
    }

    visitedPages.add(page)
    const { data, error } = await listUsers({ page, perPage: pageSize })

    if (error) {
      throw error
    }

    if (!Array.isArray(data?.users) || data.users.length > pageSize) {
      throw new Error('Supabase user cleanup received malformed page data.')
    }

    for (const user of data.users) {
      if (user.email && remainingEmails.delete(user.email)) {
        matchedUsers.push(user)
      }
    }

    if (remainingEmails.size === 0 || data.nextPage === null) {
      return matchedUsers
    }

    if (!Number.isSafeInteger(data.nextPage) || data.nextPage !== page + 1) {
      throw new Error('Supabase user cleanup pagination did not advance safely.')
    }

    page = data.nextPage
  }

  throw new Error('Supabase user cleanup exceeded its pagination safety bound.')
}

export const deleteSupabaseUsersByEmail = async (emails: string[]) => {
  if (emails.length === 0) {
    return
  }

  const admin = getSupabaseAdminClient()
  const users = await findSupabaseUsersByEmail(
    (params) => admin.auth.admin.listUsers(params),
    emails
  )
  const results = await Promise.all(users.map((user) => admin.auth.admin.deleteUser(user.id)))
  const deleteError = results.find((result) => result.error)?.error

  if (deleteError) {
    throw deleteError
  }
}
