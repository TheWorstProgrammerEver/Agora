# Agora Environment Setup

Use this checklist when deploying Agora to Netlify and a hosted Supabase project. Keep placeholder values in this file; do not commit real secrets, credential values, private hostnames, local IP addresses, or device-specific identifiers.

## Frontend Runtime Config

The browser loads runtime config through `public/config.js`.

- Local development: `npm run get-going` writes ignored `public/config.local.json`.
- Production: `npm run build:netlify` renders `dist/config.js` so it loads `/config.json`, substitutes `public/config.json` tokens into `dist/config.json`, and parses the rendered JSON.
- Netlify build command: `npm run build:netlify`.
- Netlify publish directory: `dist`.
- SPA redirects: keep `public/_redirects` deployed with `/* /index.html 200`.

Set these Netlify environment variables for production:

| Variable | Example placeholder | Notes |
| --- | --- | --- |
| `BUILD_VERSION` | `<git-sha-or-release>` | Display/debug version. |
| `ENVIRONMENT` | `production` | Runtime environment label. |
| `AUTH_PUBLIC_SIGNUP_ENABLED` | `true` | JSON boolean controlling whether the browser offers account creation. Backend Auth settings remain authoritative. |
| `AUTH_EMAIL_PASSWORD_ENABLED` | `true` | JSON boolean, not a quoted string. |
| `AUTH_PASSKEY_ENABLED` | `true` | JSON boolean. Disable if hosted WebAuthn is not configured. |
| `AUTH_OTP_ENABLED` | `true` | JSON boolean. |
| `AUTH_MAGIC_LINK_ENABLED` | `true` | JSON boolean. |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` | Hosted Supabase project API URL. |
| `SUPABASE_PUBLISHABLE_KEY` | `<publishable-key>` | Public browser key. This is not a service role key. |

If a deploy uses a non-default config path, update the deploy-time `#{CONFIG_FILE}#` substitution in `public/config.js` and document the path here.

## Netlify Site Settings

- Build command: `npm run build:netlify`.
- Publish directory: `dist`.
- Node version: use a version that satisfies `package.json` `engines.node`.
- Confirm deploy logs show `Rendered dist/config.js` and `Rendered dist/config.json`.
- Confirm GitHub integration triggers a fresh Netlify build after changes to runtime config, scripts, redirects, or Supabase client code.

Netlify or repo Node settings do not control the Supabase hosted Edge Runtime. Changing `.nvmrc`, `engines.node`, or Netlify `NODE_VERSION` does not change the Deno-based runtime used by hosted Edge Functions.

## Supabase Hosted Auth Settings

Configure these in the hosted Supabase dashboard for the production project. The local `supabase/config.toml` helps local development but does not replace hosted dashboard settings.

- Site URL: `https://<production-domain>`.
- Redirect URLs: include exact production callback and app URLs, for example `https://<production-domain>/**` only if wildcard redirects are intentionally accepted.
- Public signup: set both the project-wide and email-provider signup settings to the intended backend value. Set `AUTH_PUBLIC_SIGNUP_ENABLED` to the same value so a disabled deployment does not advertise account creation. The backend settings are authoritative and must reject direct signup attempts when disabled.
- Email/password: match the product decision for confirmations, password requirements, and SMTP sender settings.
- OTP or magic link: enable only when the UI exposes it; configure email templates, sender identity, rate limits, and provider settings.
- Passkeys/WebAuthn, when enabled:
  - RP ID: `<production-domain-without-scheme>`.
  - RP origins: `https://<production-domain>` and any intentionally supported preview/staging origins.
  - RP display name: `Agora`.
- OAuth/SMS providers, when enabled: configure provider credentials in Supabase dashboard or Supabase-managed secrets, not in this repository.

## Supabase Edge Functions

Configured functions in `supabase/config.toml`:

| Function | JWT verification | Entrypoint | Deploy expectation |
| --- | --- | --- | --- |
| `health` | `verify_jwt = false` | `./functions/health/index.ts` | Anonymous operational health contract; deploy after its database migration. |
| `agora` | `verify_jwt = false` | `./functions/agora/index.ts` | Foundation route only; recognized requests return `501` until the dual-auth handler catalog is implemented. |

The production Supabase project and public hostname are intentionally undecided. Do not link, deploy, or substitute real hosted targets until the deployment issue records Ryan's selections. When that happens, deploy functions through a reviewed command such as `npm run supabase:functions:deploy -- <function-name>` or the selected CI path.

The canonical `agora` function keeps the platform JWT gate disabled because its eventual boundary must explicitly validate either a human Supabase session or an opaque Agora agent credential. The foundation does not implement either path or any business handler; it returns `501` after validating only the public envelope version and identifier.

Edge Function npm imports should be pinned exactly or managed through a function-specific `deno.json`. Avoid floating imports such as `npm:@supabase/supabase-js@2` because hosted functions resolve npm imports independently from `package-lock.json`. For public functions that only need simple Supabase REST reads, consider direct `fetch` to PostgREST with service-role auth stored as a Supabase function secret instead of importing the full Supabase JS client.

### Anonymous health configuration

The public contract is `GET /health`; the standard hosted Supabase URL is
`https://<project-ref>.supabase.co/functions/v1/health`. A custom gateway may
map that function to the shorter contract path. The function uses Supabase's
injected `SUPABASE_URL` and server-only `SUPABASE_SERVICE_ROLE_KEY` to call
only the fixed, parameterless, read-only `public.agora_health_check()` RPC.
That RPC is not executable by `anon` or `authenticated`, preventing direct
callers from bypassing the endpoint's rate limit. The handler never accepts a
database target, SQL, RPC name, human session, or agent key from the request,
and it never returns the server credential or database response body.

Optional Edge Runtime environment variables tune its independent limits:

| Variable | Default | Accepted range | Purpose |
| --- | ---: | ---: | --- |
| `AGORA_HEALTH_DATABASE_TIMEOUT_MS` | `1000` | `100`-`5000` | Aborts the database RPC before the monitor request can hang. |
| `AGORA_HEALTH_RATE_LIMIT` | `10` | `1`-`600` | Requests accepted by each warm function worker per window. |
| `AGORA_HEALTH_RATE_LIMIT_WINDOW_MS` | `10000` | `1000`-`300000` | Monotonic fixed-window duration. |

Invalid or missing optional values fall back to the documented defaults. The
request budget is evaluated before request validation and database access, so
malformed traffic is also bounded. Every worker enforces its own budget; keep
the limit conservative when the hosted platform scales the function across
multiple workers.

Only a body-free GET with no query string is accepted. Success is exactly
`200 {"ok":true}`. Database/configuration failures are exactly
`503 {"ok":false}`; overload is `429 {"ok":false}` with `Retry-After`;
malformed methods or inputs receive `405` or `400` with the same generic
failure body. Every response includes `Cache-Control: no-store`.

After deployment, invoke each function once and inspect hosted function logs for import-time dependency warnings. Repo/build Node versions are separate from hosted Edge Runtime versions.

## Database

The base migration creates `public.principals`, the `human` and `agent` principal kinds, and an Auth trigger that provisions exactly one human principal for every new `auth.users` row. Human sessions can select only their own principal; browser roles cannot insert, update, delete, or cross-read principal rows. Agent-row provisioning and agent credential storage are intentionally absent.

Apply migrations to production with `supabase db push`, a reviewed migration pipeline, or the selected hosted Supabase deployment workflow before enabling public signup or deploying `health`. This ordering is required because the Auth trigger is the only human-principal provisioning path and the health function fails closed until `public.agora_health_check()` exists with its narrow server-only grant.

## Production Smoke Checks

Run these after every production deploy:

- Open the production app and confirm the browser successfully loads `/config.js` and `/config.json`.
- Confirm the browser config object contains the production `SUPABASE_URL`, expected auth flags, and no unresolved `#{...}#` tokens.
- Create a public human account, confirm its principal-backed profile loads, then sign out and back in through every enabled auth method.
- With backend signup disabled in a staging validation, confirm a direct signup request is rejected and the browser reports account creation as disabled without authenticating. Restore the intended deployment setting afterward.
- For auth callbacks, confirm the hosted app returns to the expected route without a redirect allow-list error.
- Visit a deep SPA route directly and confirm Netlify serves `index.html` through `public/_redirects`.
- Invoke `https://<project-ref>.supabase.co/functions/v1/health` anonymously and confirm it returns `200 {"ok":true}` with `Cache-Control: no-store`. Do not attach a human session or agent application key.
- Retry `503` with capped exponential backoff rather than tight-looping; treat repeated `503` responses as database/service unavailability. Obey `Retry-After` on `429`. A monitor request should use a client timeout slightly above the configured database timeout (for the default, 2-3 seconds is sufficient) and must not cache a previous success.
- Before any product handler exists, POST a versioned catalog request to `https://<project-ref>.supabase.co/functions/v1/agora` and confirm the route returns the expected `501` foundation response.
- If a browser call reports a CORS/preflight failure, check whether the deployed function exists and responds outside the browser first. A missing or stale function deployment can surface as a browser CORS error even when the root cause is a `404`, route mismatch, or import-time function failure.
- Check Supabase hosted function logs after invocation for import-time dependency warnings, runtime errors, and unexpected Node compatibility warnings.
