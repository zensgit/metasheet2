# Approval Wave 2 WP5 Slice 1 — Verification

## Commands

```bash
# Backend unit tests (focused)
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approval-metrics-service.test.ts tests/unit/approval-sla-scheduler.test.ts --reporter=dot

# Backend regression unit sweep (related approval surfaces)
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/approval-metrics-service.test.ts tests/unit/approval-product-service.test.ts tests/unit/approval-realtime.test.ts tests/unit/approvals-routes.test.ts tests/unit/approval-template-routes.test.ts --reporter=dot

# Full backend unit suite
pnpm --filter @metasheet/core-backend exec vitest run tests/unit --reporter=dot

# Backend typecheck
pnpm --filter @metasheet/core-backend exec tsc --noEmit

# Frontend typecheck
pnpm --filter web exec vue-tsc -b
```

## Results

Focused service + scheduler:

```
 Test Files  2 passed (2)
      Tests  16 passed (16)
```

Related approval suites:

```
 Test Files  5 passed (5)
      Tests  39 passed (39)
```

Full backend unit sweep:

```
 Test Files  139 passed (139)
      Tests  1715 passed (1715)
```

Backend `tsc --noEmit`: exit 0.

Frontend `vue-tsc -b`: exit 0.

## Review hardening — 2026-04-25

- Fixed template route wiring: `POST /api/approval-templates` and `PATCH /api/approval-templates/:id` now forward `slaHours` into `ApprovalProductService`, so the inline SLA editor and API create path persist the new column.
- Fixed tenant propagation: platform approval creation now passes `req.user.tenantId` into `ApprovalProductService.createApproval`, and metrics start rows store that tenant instead of always falling back to `default`.
- Fixed initially auto-approved flows: when `resolveInitialState()` returns `approved`, the metrics hook writes `recordInstanceStart` and then `recordTerminal('approved')`, preventing those rows from remaining incorrectly `running`.
- Fixed `node_breakdown` race risk: `recordNodeActivation` / `recordNodeDecision` now use an injected transaction runner; production wraps `SELECT ... FOR UPDATE` and JSON rewrite in `BEGIN` / `COMMIT`.

Additional focused test added and run after review hardening:

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/approval-metrics-service.test.ts \
  tests/unit/approval-product-service.test.ts \
  tests/unit/approval-sla-scheduler.test.ts \
  --reporter=verbose
```

Result:

```
 Test Files  3 passed (3)
      Tests  24 passed (24)
```

Typecheck:

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Result: exit 0.

Local note: `/tmp/ms2-wp5-sla` initially had no `node_modules/.bin/vitest`; `pnpm install --offline --ignore-scripts` could not complete because `bcryptjs@3.0.3` was missing from the local pnpm store. To avoid network access, the focused test reused the already-installed sibling workspace symlinks from `/tmp/ms2-correlation-id`. No tracked dependency files were changed.

## Manual smoke path

1. Run migrations (`pnpm --filter @metasheet/core-backend run db:migrate`). Confirm `approval_metrics` exists and `approval_templates.sla_hours` column is present.
2. As admin, open `/approval-templates/:id`. Set `SLA (小时)` to `1`.
3. Start a new approval from that template. Verify a row in `approval_metrics` appears with `sla_hours = 1` and `started_at` ~= now.
4. Wait for the scheduler tick (or set `APPROVAL_SLA_SCHEDULER_DISABLED=0` and trigger `ApprovalSlaScheduler.tick()` manually via REPL). Confirm `sla_breached = TRUE` after ~1 hour (or set a smaller test interval via SQL: `UPDATE approval_metrics SET started_at = now() - interval '2 hours' WHERE instance_id = ...;`).
5. Open `/approvals/metrics` as admin. Verify summary cards render, 按模板汇总 has the row, 超时实例 list contains the instance.
6. Approve or reject the instance. Confirm `terminal_state`, `terminal_at`, `duration_seconds` are filled; the instance drops off 超时实例 list (terminal_at IS NULL filter).

## Known caveats / follow-ups

- Multi-pod deployments must set `APPROVAL_SLA_SCHEDULER_DISABLED=1` on all-but-one instance; leader-lock integration is a follow-up.
- `tenant_id` still falls back to `'default'` when the token has no `tenantId`, but routed platform approval creation now preserves `req.user.tenantId` when present. When approvals become first-class tenant-scoped rows, backfill existing default rows and tighten the fallback.
- `node_breakdown` is best-effort — existing instances predate metrics so their first nodes won't have activation timestamps. New instances created after this change are fully instrumented.
- Breach notifications are not emitted yet; the scheduler has an `onBreach(ids)` hook that future work can wire to email / 站内消息 once the approval notification service surface stabilizes.
- We did not add an integration test. The `ensureApprovalSchemaReady()` helper was updated so any future integration test can rely on the new tables; kept the slice unit-only to avoid the historical DDL race issues.
