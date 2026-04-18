# Yjs Backend Build Baseline Fix Development

- Date: 2026-04-18
- Scope: unblock current `main` backend build so Yjs rollout work can continue from a clean baseline

## Problem

`pnpm --filter @metasheet/core-backend build` was failing on current `main` before any new Yjs rollout work:

- `packages/core-backend/src/db/types.ts`
- `packages/core-backend/src/multitable/api-token-service.ts`
- `packages/core-backend/src/multitable/webhook-service.ts`
- `packages/core-backend/src/multitable/automation-log-service.ts`
- `packages/core-backend/src/multitable/dashboard-service.ts`

The failures were not Yjs feature logic regressions. They were TypeScript/Kysely typing mismatches in recently-added multitable JSON columns.

## Root Cause

Two issues were mixed together:

1. JSON column schema types were too loose or used `JSONColumnType<T>` defaults that implied string insert/update types.
2. Service code wrote JSON columns by `JSON.stringify(...) as unknown as ...`, which no longer matched Kysely's typed `ValueExpression` expectations.

There was also one non-JSON issue:

- `AutomationLogService.cleanup()` used a raw interval SQL expression that no longer matched the typed `created_at` operand.

## Changes

### 1. Normalize DB JSON column typings

Updated `packages/core-backend/src/db/types.ts`:

- added `JsonStringArrayColumn`
- added `JsonValueColumn`
- switched these multitable columns to explicit aliases:
  - `multitable_automation_executions.steps`
  - `multitable_charts.data_source`
  - `multitable_charts.display`
  - `multitable_dashboards.panels`
  - `multitable_api_tokens.scopes`
  - `multitable_webhooks.events`
  - `multitable_webhook_deliveries.payload`

This makes Kysely treat insert/update payloads as actual JSON arrays/objects instead of default string JSON text.

### 2. Stop stringifying JSON before insert/update

Updated `packages/core-backend/src/multitable/automation-log-service.ts`:

- `steps` now writes the execution step array directly

Updated `packages/core-backend/src/multitable/dashboard-service.ts`:

- chart `data_source` now writes the structured object directly
- chart `display` now writes the structured object directly
- dashboard `panels` now writes structured arrays directly

This removed the `JSON.stringify(... as unknown as Record<string, unknown>)` pattern that was only satisfying runtime, not the type system.

### 3. Replace raw retention cutoff SQL with typed cutoff date

Updated `packages/core-backend/src/multitable/automation-log-service.ts`:

- `cleanup(retentionDays)` now computes a JS `Date` cutoff and compares `created_at < cutoff`

That keeps the behavior equivalent for retention cleanup while matching the typed timestamp operand.

## Outcome

Current `main` backend build is unblocked again without replaying old mixed-branch Yjs commits. This restores a usable baseline for:

- producing a real Yjs-ready GHCR image
- continuing remote rollout validation
- keeping multitable JSON persistence code type-safe on current `main`

## Delivery Notes

- The repair was committed on branch `codex/yjs-main-clean-20260418`
- Code commit:
  - `0f10cd181 fix(collab): restore backend build baseline on main`
- A clean exported build context was used for Docker verification so local `node_modules` noise in the worktree would not affect image build results
