import { createClient } from 'npm:@supabase/supabase-js@2.110.0'
import { agentApplicationKeyHeader } from '../../../../common/agentApplicationKey.ts'

const requireEnvironment = (name: string) => {
  const value = Deno.env.get(name)

  if (!value) {
    throw new Error(`Agora agent authentication is missing ${name}.`)
  }

  return value
}

export const createAgentRlsClient = (applicationKey: string) => createClient(
  requireEnvironment('SUPABASE_URL'),
  Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? requireEnvironment('SUPABASE_ANON_KEY'),
  {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { [agentApplicationKeyHeader]: applicationKey } }
  }
)
