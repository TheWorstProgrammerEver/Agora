# Agora

Agora is a Supabase-backed React TypeScript foundation for a private collaboration application for humans and agents.

The app supports backend-configurable public human signup, Supabase email/password,
OTP, magic-link and passkey capabilities, and a protected home screen that says
`Welcome to Agora`.

It keeps the product surface intentionally small for now: auth, server-created human principals, runtime config, Netlify builds, a local Supabase stack, Edge Function readiness routes, and local/LAN developer ergonomics. Group membership, chat persistence, and chat handlers belong to later delivery slices.

## Get Going

Prerequisites:

- Node.js 22.12.0 or newer, with npm
- Docker Engine with a running daemon on Linux, or Docker Desktop on macOS
- Playwright Chromium plus its platform runtime libraries

The committed Vite/Vitest/Supabase toolchain is pinned in `package.json` and `package-lock.json`. Refresh direct dependency versions and the Node engine floor together when deliberately updating the starter toolchain.

From a fresh clone:

```sh
npm install
npm run preflight
npm run get-going
```

The read-only preflight checks Docker daemon access and launches headless Playwright Chromium once. On Linux, `npx playwright install --with-deps chromium` installs the browser and OS libraries; `npx playwright install chromium` installs only the browser bundle.

`get-going` installs npm dependencies when needed, opens and waits for Docker Desktop on macOS, starts the local Supabase stack, starts local Edge Functions, validates each enabled function route from `supabase/config.toml`, starts Vite on LAN, writes ignored local developer config to `public/config.local.json`, verifies reachable ports, and prints the localhost and LAN endpoint sheet.

Press `Ctrl+C` to stop dev processes started by the script. Supabase containers keep their local data in Docker volumes; use `npm run all-done` when you want everything wound down. Lifecycle state transitions are serialized by a short-lived kernel-owned loopback coordinator, so concurrent stale recovery or delayed release cannot remove a replacement owner. Shutdown uses ignored repo-local runtime identity rather than shared-port or process-name matching, verifies the complete managed process groups before success, removes stale or unowned state without signaling its referenced process, and exits nonzero if a live owner is ambiguous or an endpoint remains live.

Do not treat `health` alone as proof that the current branch is ready. `get-going` checks both configured routes, including the authenticated, fail-closed `agora` route. If health is ready but another function route is `404`, or a business route returns `503` after adding shared imports, restart the local stack with `npm run all-done` and `npm run get-going` before running security tests. If Edge Runtime is healthy but Kong reports name-resolution failures, restarting the local Kong container for this Supabase project may be enough.

## Operational Health

Agora's anonymous `GET /health` contract is deployed by Supabase at
`/functions/v1/health`. It performs a read-only database RPC before returning
`{"ok":true}` and sends `Cache-Control: no-store` on success and failure. It
does not inspect caller credentials, expose application data, grant direct
database access, or share the canonical chat dispatcher.

The function rejects suffix paths, alternate methods, and probe parameters,
maps database errors to `503 {"ok":false}`, and applies an independent
per-worker request budget before database access. See `README.ENV.md` for
deployment variables, timeout bounds, and monitor retry guidance.

## Shared Request Contract

`common` owns the versioned Agora request identifiers, request/response DTOs, and typed envelope. `src/data/agora` maps those contracts to the browser-side Supabase function invoker. `supabase/functions/agora` imports the same contract and the shared `lib/dispatch` implementation.

The `agora` route explicitly validates either a human Supabase session or one opaque Agora agent application key with the platform JWT gate disabled. Both adapters produce the same server-derived `PrincipalContext` and an RLS-only RPC capability before the versioned envelope, strict request DTO, and typed handler catalog run. Recognized requests whose owning delivery slice has not landed return `501`; anonymous and invalid credentials fail before request parsing or handler dispatch.

## Runtime Config

`public/config.js` is the committed browser loader. It synchronously loads one JSON config file:

- `public/config.local.json` when `#{CONFIG_FILE}#` has not been substituted
- the substituted `#{CONFIG_FILE}#` path when present

`public/config.json` is the committed deployment template and should be substituted by CI/CD. `npm run get-going` generates ignored `public/config.local.json` for the current machine/LAN. Visual tests keep their config under `tests/visual/config.test.json` and route it as `/config.local.json`.

Authentication methods and signup visibility are runtime capabilities. Supabase Auth's project-wide and email-provider signup settings are the authoritative deployment controls: disable both backend settings to reject direct public signup, and align `AUTH_PUBLIC_SIGNUP_ENABLED` so the UI does not advertise it.

Deployment and hosted environment setup lives in `README.ENV.md`. Keep that file current whenever runtime config, Netlify settings, Supabase Auth providers, Edge Functions, migrations, or hosted dashboard settings change. It should contain placeholders only, never real secrets or machine-specific values.

## Security Integration Tests

The security integration command verifies the anonymous database-backed health contract, public signup and server-controlled human-principal provisioning, direct-table RLS/grants, duplicate and forged-row denial, principal-kind constraints, memberless cross-user isolation, and the dual-auth dispatcher boundary:

```sh
npm run get-going
npm run test:security
npm run all-done
```

The backend-disabled signup test is deliberately opt-in because it requires a local Auth instance started with both `auth.enable_signup` and `auth.email.enable_signup` set to `false`. On a disposable local stack, stop Supabase, set those two values, restart it, run `npm run test:security:signup-disabled`, then restore the committed `true` values and restart before ordinary development. The test makes a direct public Auth request and requires Supabase's `signup_disabled` denial with no user or session.

## Validation Commands

```sh
npm run lint
npm test
npm run build
npm run preflight
npm run get-going
npm run test:security
npm run test:visual
npm run all-done
```

`npm run build:netlify` additionally validates deploy-time runtime-config substitution when supplied with the placeholder variables documented in `README.ENV.md`.

The `Validate` GitHub Actions workflow runs lint, unit, and production-build checks on Linux and macOS. The unit suite includes the real graceful-shutdown and resistant-descendant escalation fixture on both advertised local-development platforms.
