import { createClient } from 'npm:@supabase/supabase-js@2.110.0'

export const requireAuthenticationEnvironment = (name: string) => {
  const value = Deno.env.get(name)

  if (!value) {
    throw new Error(`Agora authentication is missing ${name}.`)
  }

  return value
}

const publicKey = () => (
  Deno.env.get('SUPABASE_PUBLISHABLE_KEY')
    ?? requireAuthenticationEnvironment('SUPABASE_ANON_KEY')
)

export const getPublicProjectKey = publicKey

export const isPublicProjectAuthorization = (authorization: string) => {
  const match = /^Bearer ([^\s,]+)$/i.exec(authorization)

  return Boolean(match && [
    Deno.env.get('SUPABASE_PUBLISHABLE_KEY'),
    Deno.env.get('SUPABASE_ANON_KEY')
  ].some((key) => key && key === match[1]))
}

export const createRlsClient = (headers: Record<string, string>) => createClient(
  requireAuthenticationEnvironment('SUPABASE_URL'),
  publicKey(),
  {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers }
  }
)
