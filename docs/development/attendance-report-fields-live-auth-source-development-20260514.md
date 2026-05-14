# Attendance Report Fields Live Auth Source Development

Date: 2026-05-14

## Background

The attendance report fields live harness already supports three credential inputs:

- `AUTH_TOKEN` / `TOKEN`
- `AUTH_TOKEN_FILE` / `TOKEN_FILE`
- `ALLOW_DEV_TOKEN=1`

The default priority is useful for simple local runs, but it is ambiguous in long-running staging sessions where an old environment token and a fresh local token file may both be present. The previous failure mode could reach the network first and only then reveal that the intended credential source was not the one being exercised.

This slice makes the auth source explicit and moves token-file validation ahead of remote health checks in live mode.

## Changes

`scripts/ops/attendance-report-fields-live-acceptance.mjs`

- Adds `AUTH_SOURCE` / `TOKEN_SOURCE`.
- Accepts `AUTH_TOKEN`, `AUTH_TOKEN_FILE`, and `ALLOW_DEV_TOKEN`.
- Normalizes aliases:
  - `token` -> `AUTH_TOKEN`
  - `token-file` / `TOKEN_FILE` -> `AUTH_TOKEN_FILE`
  - `dev-token` / `DEV_TOKEN` -> `ALLOW_DEV_TOKEN`
- Rejects unknown explicit sources during config validation.
- Requires the matching credential when an explicit source is requested.
- Records a `config.auth-source` check with:
  - `selected`
  - `present`
  - `ignored`
  - `requested`
- Adds `Auth source` to the Markdown evidence summary.
- Resolves the configured live auth input before `/api/health`, so unreadable or unsafe token files fail locally.
- Preserves `API_HOST_HEADER` handling for 142 reverse-proxy access.

`scripts/ops/attendance-report-fields-live-acceptance.test.mjs`

- Covers explicit source normalization.
- Covers unavailable and unknown explicit source validation.
- Covers `AUTH_SOURCE=AUTH_TOKEN_FILE` taking precedence over a simultaneously present `AUTH_TOKEN`.
- Covers preflight not reading token files.
- Covers token-file failures stopping before `/api/health`.
- Covers Markdown auth-source evidence without leaking token values.

## Runtime Behavior

Without `AUTH_SOURCE`, the harness keeps the existing priority:

```text
AUTH_TOKEN > AUTH_TOKEN_FILE > ALLOW_DEV_TOKEN
```

With `AUTH_SOURCE`, the selected source is mandatory. Examples:

```bash
AUTH_SOURCE=AUTH_TOKEN AUTH_TOKEN=... pnpm run verify:attendance-report-fields:live
AUTH_SOURCE=AUTH_TOKEN_FILE AUTH_TOKEN_FILE=/tmp/metasheet-142-main-admin-72h.jwt pnpm run verify:attendance-report-fields:live
AUTH_SOURCE=ALLOW_DEV_TOKEN ALLOW_DEV_TOKEN=1 pnpm run verify:attendance-report-fields:live
```

If `AUTH_SOURCE=AUTH_TOKEN_FILE` is set and `AUTH_TOKEN` is also present, the token file wins and the env token is reported as ignored. The token value itself is not written to JSON or Markdown artifacts.

## 142 Use Case

The 142 deployment requires the host override from the previous harness slice:

```bash
API_BASE=http://142.171.239.56:8081
API_HOST_HEADER=localhost
AUTH_SOURCE=AUTH_TOKEN_FILE
AUTH_TOKEN_FILE=/tmp/metasheet-142-main-admin-72h.jwt
CONFIRM_SYNC=1
```

This combination now produces deterministic evidence that the local file token was selected before remote requests are made.

## Boundaries

- No attendance business API behavior changed.
- No token generation or token refresh behavior changed.
- No changes to `scripts/multitable-auth.mjs`.
- Preflight mode still avoids credential resolution and sync calls.
- Token contents and bearer headers remain excluded from generated artifacts.
