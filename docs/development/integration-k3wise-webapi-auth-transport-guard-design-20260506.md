# K3 WISE WebAPI Auth Transport Guard Design - 2026-05-06

## Goal

Make K3 WISE WebAPI connection testing fail early when the login endpoint reports business success but does not return any auth material the Node adapter can reuse for later Save-only writes.

Before this guard, `login()` could return an empty auth-header object after a successful login body with no `Set-Cookie` and no session id. In that case:

- `testConnection({ skipHealth: true })` could report `ok: true` with `authenticated: false`.
- A later material/BOM Save-only run would call K3 without session headers.
- The operator would see a misleading green connection check before hitting unauthorized write failures.

## Scope

Changed files:

- `plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs`
- `plugins/plugin-integration-core/__tests__/k3-wise-adapters.test.cjs`
- `scripts/ops/fixtures/integration-k3wise/mock-k3-webapi-server.mjs`
- `scripts/ops/fixtures/integration-k3wise/mock-k3-webapi-server.test.mjs`
- `package.json`

## Adapter Contract

`login()` now requires one of these auth transports:

- A configured `credentials.sessionId`, which is converted to the configured session header.
- A `Set-Cookie` header from the login response.
- A session id in the login response body, including `config.sessionIdPath`, `sessionId`, `SessionId`, or `Result.SessionId`.

If the login response is otherwise successful but none of those transports are present, the adapter throws `K3WiseWebApiAdapterError` with:

- `code: "K3_WISE_AUTH_TRANSPORT_MISSING"`
- the redaction-safe login response body in details for diagnosis.

`testConnection()` surfaces that as a failed connection check, so customer GATE/live PoC work stops at setup instead of failing later during Save-only writes.

## Mock Fixture Tightening

The in-process mock K3 server now models two extra pieces of real endpoint behavior:

- Method contracts:
  - `POST /K3API/Login`
  - `GET /K3API/Health`
  - `POST /K3API/Material/{Save,Submit,Audit}`
  - `POST /K3API/BOM/{Save,Submit,Audit}`
- Auth-transport variants:
  - Default behavior still returns `Set-Cookie` and `sessionId`.
  - Tests can set `includeSessionCookie: false` and `includeSessionId: false` to model a bad login response.

This keeps the offline PoC mock useful without letting it hide HTTP method or session transport mistakes.

## Out Of Scope

- Adding a cookie jar to the adapter.
- Supporting implicit browser-style cookie persistence in Node fetch.
- Changing K3 business success parsing.
- Changing live customer credentials or GATE packet shape.
