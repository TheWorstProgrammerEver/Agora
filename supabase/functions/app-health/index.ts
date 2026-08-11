import { withSupabase } from 'npm:@supabase/server@1.3.0'

export default {
  fetch: withSupabase({ auth: 'none' }, () => (
    Response.json({
      ok: true,
      service: 'app-health',
      environment: Deno.env.get('APP_ENVIRONMENT') ?? 'local'
    })
  ))
}
