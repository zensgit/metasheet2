# Yjs Staging Invalidation Smoke Tool

- Branch: `codex/yjs-staging-invalidation-smoke-20260421`
- Date: 2026-04-21
- Base: `origin/main` after PR `#979`
- Scope: provide a repeatable remote/staging check for the Yjs invalidation
  event added by PR `#979`.

## Context

PR `#979` made live Yjs clients disconnect and fall back to REST after a REST
write invalidates the server-side Y.Doc. The remaining rollout gap was
operational: staging validation still required a manual two-browser flow.

This change adds a CLI smoke tool that exercises the same contract through real
HTTP + Socket.IO:

1. Connect to `${BASE_URL}/yjs` with a JWT.
2. Subscribe to the target record.
3. Wait for the initial `yjs:message` sync response.
4. PATCH the target record through the canonical REST route.
5. Assert the subscribed socket receives `yjs:invalidated` with
   `reason: "rest-write"`.

## Files Added

- `scripts/ops/yjs-invalidation-smoke.mjs`
  - Remote/staging smoke runner.
  - Writes JSON and Markdown reports.
  - Resolves `socket.io-client` from `apps/web/package.json`, avoiding a new
    root dependency.
- `scripts/ops/yjs-invalidation-smoke.test.mjs`
  - Node built-in test coverage for config parsing, URL construction, safety
    gates, and Markdown rendering.

## Safety Gates

The tool is intentionally write-safe by default:

- Requires `CONFIRM_WRITE=1` before it sends any PATCH request.
- Requires `AUTH_TOKEN` / `TOKEN` by default.
- Only uses `/api/auth/dev-token` when `ALLOW_DEV_TOKEN=1` is explicitly set.
- Fails during config validation if required inputs are missing, while still
  writing a failure report.

## Required Environment

```bash
BASE_URL="http://<staging-host>:<port>"
AUTH_TOKEN="<jwt>"
RECORD_ID="<record-id>"
FIELD_ID="<string-field-id>"
CONFIRM_WRITE=1
```

Optional:

```bash
SHEET_ID="<sheet-id>"
PATCH_VALUE="manual-smoke-$(date -u +%Y%m%dT%H%M%SZ)"
PATCH_URL="http://<host>/api/multitable/records/<record-id>"
OUTPUT_DIR="output/yjs-invalidation-smoke/<run-id>"
TIMEOUT_MS=10000
ALLOW_DEV_TOKEN=1
```

## Usage

```bash
BASE_URL="http://142.171.239.56:<api-port>" \
AUTH_TOKEN="<jwt>" \
RECORD_ID="<record-id>" \
FIELD_ID="<string-field-id>" \
CONFIRM_WRITE=1 \
OUTPUT_DIR="output/yjs-invalidation-smoke/$(date -u +%Y%m%d-%H%M%S)" \
node scripts/ops/yjs-invalidation-smoke.mjs
```

Expected successful checks:

- `config.required-env`
- `auth.token-present` or `auth.dev-token`
- `api.health`
- `api.record.get`
- `socket.connect`
- `socket.subscribe-sync`
- `api.record.patch`
- `socket.invalidated`

## Notes

- The smoke mutates the target record field. Use a dedicated staging/test sheet
  and a disposable text field.
- The script validates the backend event contract, not the browser UI. The
  browser click test remains useful after deployment, but this CLI gives ops a
  fast deterministic gate before manual trial.
