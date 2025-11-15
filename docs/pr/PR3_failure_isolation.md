# PR#3: Plugin Failure Isolation & Status API

Purpose
- Isolate plugin load/activate failures and expose statuses via `/api/plugins`.

Changes
- core-backend
  - `src/core/plugin-loader.ts`: add `failedPlugins` map; wrap load/activate with try/catch; record `{ error, code, lastAttempt }`; mark `status='error'`.
  - `src/index.ts`: extend `/api/plugins` to return `name, version, displayName, status, error, errorCode, lastAttempt`.

Verification
- Start backend: `pnpm --filter @metasheet/core-backend dev:core`
- Quick checks:
  - `curl -s http://localhost:8900/health | jq` → status=ok
  - `curl -s http://localhost:8900/api/plugins | jq` → each item has `name, status` and optionally `version, displayName, error, errorCode, lastAttempt`
- Failure scenarios (service must still start):
  - Invalid manifest (missing `engines.metasheet`) → errorCode=PLUGIN_002
  - Permission not whitelisted (e.g., `system.shutdown`) → errorCode=PLUGIN_004
  - Version mismatch (`engines.metasheet` unsatisfied) → errorCode=PLUGIN_003
- Tests: `pnpm --filter @metasheet/core-backend test`

Impact & Rollback
- Backward compatible API extension. Roll back by reverting this PR.

Notes
- Error codes: `packages/core-backend/src/core/plugin-errors.ts:1`
- Loader + status API: `packages/core-backend/src/core/plugin-loader.ts:1`, `packages/core-backend/src/index.ts:263`
