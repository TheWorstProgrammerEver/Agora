# Agora

Agora is a Supabase-backed React TypeScript foundation for a private collaboration application for humans and agents.

The app currently supports Supabase authentication and a protected home screen that says
`Welcome to Agora`.

It keeps the product surface intentionally small for now: auth, runtime config, Netlify builds, a local Supabase stack, Edge Function readiness routes, and local/LAN developer ergonomics. Chat persistence, authorization, and handlers belong to later delivery slices.

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

Press `Ctrl+C` to stop dev processes started by the script. Supabase containers keep their local data in Docker volumes; use `npm run all-done` when you want everything wound down. Shutdown uses ignored repo-local runtime identity rather than shared-port or process-name matching, and exits nonzero if ownership is ambiguous or an endpoint remains live.

Do not treat `app-health` alone as proof that the current branch is ready. `get-going` checks both configured routes, including the fail-closed `agora` foundation route. If health is ready but another function route is `404`, or a business route returns `503` after adding shared imports, restart the local stack with `npm run all-done` and `npm run get-going` before running security tests. If Edge Runtime is healthy but Kong reports name-resolution failures, restarting the local Kong container for this Supabase project may be enough.

## Shared Request Contract

`common` owns the versioned Agora request identifiers, request/response DTOs, and typed envelope. `src/data/agora` maps those contracts to the browser-side Supabase function invoker. `supabase/functions/agora` imports the same contract and the shared `lib/dispatch` implementation.

The `agora` route is deliberately unavailable in this foundation: every recognized request returns `501` because its handler registry is empty. This prevents the scaffold from introducing chat behavior or an unauthenticated business path before the canonical dual-auth boundary is implemented.

## Runtime Config

`public/config.js` is the committed browser loader. It synchronously loads one JSON config file:

- `public/config.local.json` when `#{CONFIG_FILE}#` has not been substituted
- the substituted `#{CONFIG_FILE}#` path when present

`public/config.json` is the committed deployment template and should be substituted by CI/CD. `npm run get-going` generates ignored `public/config.local.json` for the current machine/LAN. Visual tests keep their config under `tests/visual/config.test.json` and route it as `/config.local.json`.

Deployment and hosted environment setup lives in `README.ENV.md`. Keep that file current whenever runtime config, Netlify settings, Supabase Auth providers, Edge Functions, migrations, or hosted dashboard settings change. It should contain placeholders only, never real secrets or machine-specific values.

## Security Integration Tests

The security integration command verifies that the foundation route rejects malformed envelopes and fails closed for recognized requests. Agora has no app tables yet:

```sh
npm run get-going
npm run test:security
npm run all-done
```

Add RLS and direct publishable-key tests here when the first persisted Agora feature lands.

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
