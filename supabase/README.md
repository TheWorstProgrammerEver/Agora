# Supabase

Agora uses Supabase for authentication, local development services, and Edge Functions. Product tables and Row Level Security policies will be added with the first persisted app feature.

## Local Commands

Run the stack:

```sh
npm run supabase:start
```

Inspect local URLs and keys:

```sh
npm run supabase:status
```

Reset the local database from migrations:

```sh
npm run supabase:reset
```

Generate a migration from changes made in the local Supabase UI:

```sh
npm run supabase:migration -- add_some_change
```

This runs `supabase db diff --local --file add_some_change` and writes a timestamped migration under `supabase/migrations`.

Serve Edge Functions locally:

```sh
npm run supabase:functions:serve
```

The `health` function is public locally and should respond at:

```txt
http://127.0.0.1:54321/functions/v1/health
```

It returns success to an anonymous request only after the read-only
`public.agora_health_check()` RPC executes. `npm run get-going` also validates
every enabled `[functions.*]` route in `supabase/config.toml`, including the
fail-closed `agora` route, so a stale Edge Runtime cannot hide the canonical
function behind a passing health check.
If a business route is `404`, or `503` after adding shared imports, restart the
local Supabase stack before running security tests. If Kong reports
name-resolution failures while Edge Runtime is healthy, restarting the local
Kong container for this Supabase project may be enough.

Stop the stack:

```sh
npm run supabase:stop
```

## Shape

Current split:

- Supabase Auth owns sign-in, sign-up, OTP, and magic-link flows.
- `health` is the anonymous database-backed operational endpoint. Its server-only credential can execute one parameterless boolean RPC that direct anonymous callers cannot invoke; it has no chat handler, caller identity, or application-table read path.
- `agora` is the canonical versioned request route, but its handler registry is deliberately empty and fail-closed in this foundation.
- Product migrations, RLS policies, principal authentication, and command/query handlers should be added by their owning delivery slices.
- Both the browser and the Edge Function import the contract from `common` and the dispatcher implementation from `lib/dispatch`; do not duplicate either boundary.
- Browser runtime configuration is loaded by `public/config.js` from JSON payloads. Local development uses generated, ignored `public/config.local.json`; deploys should substitute committed `public/config.json`.

## Environment Promotion

The React bundle should continue using runtime config rather than Vite build-time env vars:

- `#{SUPABASE_URL}#`
- `#{SUPABASE_PUBLISHABLE_KEY}#`
- `#{ENVIRONMENT}#`
- `#{BUILD_VERSION}#`
- `#{AUTH_EMAIL_PASSWORD_ENABLED}#`
- `#{AUTH_OTP_ENABLED}#`
- `#{AUTH_MAGIC_LINK_ENABLED}#`
- optionally `#{CONFIG_FILE}#` in `public/config.js` if a deploy needs to load a non-default JSON config path

That gives test and production the same build artifact with environment-specific values replaced at deployment time.
