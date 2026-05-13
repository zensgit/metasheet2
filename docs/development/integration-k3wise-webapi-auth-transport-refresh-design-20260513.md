# K3 WISE WebAPI Auth Transport Refresh Design - 2026-05-13

## Context

PR #1352 carried useful K3 WISE adapter hardening, but it was stale and
conflicting against current `main`. Current `main` already added credential
redaction to the mock K3 WebAPI fixture, so this refresh ports the remaining
auth and URL hardening while preserving that redaction behavior.

## Goals

- Fail K3 WebAPI connection testing when login reports business success but
  returns no reusable auth transport for later Save-only writes.
- Reject unsafe endpoint path forms that can escape `config.baseUrl`.
- Preserve `baseUrl` context paths such as `https://k3.example.test/K3API` when
  joined with endpoint paths such as `/login`.
- Keep the mock K3 WebAPI fixture close to the real endpoint method contract.
- Keep mock call logs redacted so credential values do not leak into artifacts.

## Adapter Changes

`plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs`
continues to accept normal relative K3 paths, but now rejects:

- any leading URL scheme such as `http:`, `https:`, or `k3api:`
- protocol-relative paths beginning with `//`
- paths containing backslashes

Request URL construction now uses an adapter-local join helper. If the base URL
contains a context path, the helper preserves that context unless the configured
endpoint path already includes it.

After credential login succeeds, the adapter requires at least one reusable auth
transport:

- `Set-Cookie` response header
- configured or response-derived session id header

If neither exists, `testConnection()` returns code
`K3_WISE_AUTH_TRANSPORT_MISSING` and does not continue to health checks.
Authority-code token mode is unchanged because it authenticates through a query
token rather than cookie/session headers.

## Mock Fixture Changes

`scripts/ops/fixtures/integration-k3wise/mock-k3-webapi-server.mjs` now supports:

- optional login responses with no cookie and no session id
- method checks for login, health, material, and BOM endpoints
- existing redacted call logging for credential-bearing request bodies

The full K3 WISE offline PoC gate now runs the mock K3 WebAPI contract test
before the SQL Server mock contract and end-to-end mock PoC demo.

## Compatibility

This is integration tooling and adapter hardening only. It does not change
database schema, production routes, frontend UI, or customer credentials.

## Superseded Work

This refresh supersedes PR #1352. The refreshed version is based on current
`main`, preserves later mock redaction work, and records current verification
output.
