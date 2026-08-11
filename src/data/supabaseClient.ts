import { createClient } from '@supabase/supabase-js'

const unresolvedPlaceholder = (value: string) => value.includes('#{')

const getSupabaseConfig = () => {
  const url = window.config?.supabase?.url?.trim()
  const publishableKey = window.config?.supabase?.publishableKey?.trim()

  if (!url || !publishableKey || unresolvedPlaceholder(url) || unresolvedPlaceholder(publishableKey)) {
    throw new Error('Supabase runtime config is missing. Check public/config.js.')
  }

  return { url, publishableKey }
}

const { url, publishableKey } = getSupabaseConfig()

export const supabase = createClient(url, publishableKey, {
  auth: {
    autoRefreshToken: true,
    detectSessionInUrl: true,
    experimental: {
      passkey: true
    },
    persistSession: true
  }
})
