# Approval Wave 2 WP5 Slice 1 — Duration & SLA Development

Scope: WP5 slice 1 adds a per-instance approval metrics pipeline (总耗时 + node breakdown) and a template-level SLA threshold with breach flagging, plus an admin dashboard for 耗时 / SLA 超时率 observability.

## Design

- New table `approval_metrics`, one row per `approval_instances.id`, storing
  started_at, terminal_at, terminal_state, duration_seconds, sla_hours (denormalized from the template at creation time), sla_breached / sla_breached_at, and `node_breakdown JSONB` (array of `{nodeKey, activatedAt, decidedAt, durationSeconds, approverIds}`).
- New column `approval_templates.sla_hours INTEGER` (nullable, CHECK `> 0`). Positive integer hours only; `NULL` disables tracking.
- Writes are driven by hooks in `ApprovalProductService`:
  - `createApproval`: after commit, call `recordInstanceStart` (guarded). The hook populates `started_at = now()` and seeds `node_breakdown` with the first approval node's activation.
  - `dispatchAction`: after commit, emit `recordNodeDecision(currentNodeKey)`. On `approve` that advances, also emit `recordNodeActivation(resolution.currentNodeKey)`. On `approve → 'approved'`, emit `recordTerminal('approved')`. On `reject` / `revoke`, emit `recordTerminal('rejected' | 'revoked')`. On `return`, emit `recordNodeDecision` for the current node and `recordNodeActivation` for the new node.
- All metrics calls are guarded: a local `safeMetricsCall` wraps each invocation so metrics errors are logged but never fail the approval flow. A missing start row is self-healing — subsequent decision/activation/terminal hooks are no-ops for that instance (service methods return silently when `loadBreakdown` finds no row), and the admin dashboard surfaces a 404 on `/api/approvals/metrics/instances/:id` which the UI tolerates.
- Per-node breakdown is maintained by a transaction-wrapped `SELECT … FOR UPDATE` + JSON rewrite. The explicit transaction is load-bearing: without it, a bare `pool.query` would release the row lock immediately after the `SELECT`, allowing concurrent approval events to overwrite each other's `node_breakdown` changes.

### SLA breach scanner

- `ApprovalSlaScheduler` is a 15-minute `setInterval` job started from `src/index.ts` during `initialize`. The tick calls `ApprovalMetricsService.checkSlaBreaches(now)`, which runs a single `UPDATE … SET sla_breached = TRUE, sla_breached_at = now WHERE terminal_at IS NULL AND sla_hours IS NOT NULL AND NOT sla_breached AND started_at + (sla_hours * interval '1 hour') < now RETURNING instance_id`.
- Reentrancy is guarded with an in-memory `running` flag; the timer is `.unref()`-ed so it cannot keep the process alive on its own.
- Multi-pod deployments must disable the scheduler on all-but-one instance via `APPROVAL_SLA_SCHEDULER_DISABLED=1`. A leader-lock wrapper is a follow-up.

### Spec deviations (documented)

The task spec proposed `instance_id UUID NOT NULL` + `tenant_id UUID NOT NULL`. Reality forced two deviations:

1. `approval_instances.id` is declared `TEXT PRIMARY KEY` across every Kysely migration. `approval_metrics.instance_id` is therefore `TEXT NOT NULL UNIQUE REFERENCES approval_instances(id) ON DELETE CASCADE`. The metrics row's own `id` stays `UUID`. `template_id` stays `UUID` (approval_templates.id uses `gen_random_uuid()`).
2. Approvals have no tenancy column. `approval_metrics.tenant_id` is `TEXT NOT NULL DEFAULT 'default'` mirroring the loose TEXT scoping in `integration_*` tables. Routes read `req.user?.tenantId` when present, otherwise fall back to `'default'`.

Terminal states follow the production status enum: `approved | rejected | revoked | returned` (not the spec's `cancelled`). `revoked` is the codebase's name for requester-initiated cancellation.

ApprovalGraphExecutor is pure in-memory; the task description mentioned adding hooks there. Metrics hooks live in `ApprovalProductService` only.

## File list

### Backend
- `packages/core-backend/src/db/migrations/zzzz20260425100000_create_approval_metrics.ts` — Kysely migration (approval_metrics + approval_templates.sla_hours).
- `packages/core-backend/src/services/ApprovalMetricsService.ts` — service with `recordInstanceStart / recordNodeActivation / recordNodeDecision / recordTerminal / checkSlaBreaches / getMetricsSummary / getInstanceMetrics / listActiveBreaches`. Supports dependency-injected `Query` and `TransactionRunner` for unit tests; production breakdown mutations use `pool.connect()` + `BEGIN` / `COMMIT`.
- `packages/core-backend/src/services/ApprovalSlaScheduler.ts` — interval-based breach scanner with start/stop helpers, reentrancy guard, and optional `onBreach` hook.
- `packages/core-backend/src/services/ApprovalProductService.ts` — inject `ApprovalMetricsService`, add `emitNodeDecisionMetric / emitNodeActivationMetric / emitTerminalMetric` helpers, wire hooks into `createApproval` (in-transaction insert) + all `dispatchAction` branches (post-commit). Also expose `sla_hours` through create/update, DTO, and TemplateRow.
- `packages/core-backend/src/routes/approval-metrics.ts` — new router with `/summary`, `/breaches`, `/instances/:id`. Admin-only for the first two. `/instances/:id` requires `approvals:read` plus a participant-or-admin check against `approval_instances.requester_snapshot`, `approval_assignments`, and `approval_records`; non-participants get 403.
- `packages/core-backend/src/types/approval-product.ts` — add `slaHours` to the list/detail DTO and create/update requests.
- `packages/core-backend/src/index.ts` — mount `approvalMetricsRouter`, start/stop `ApprovalSlaScheduler`.
- `packages/core-backend/tests/helpers/approval-schema-bootstrap.ts` — DDL for `approval_metrics` + `approval_templates.sla_hours`, bumped bootstrap version to `20260425-wp5-sla` so integration workers re-seed.

### Tests
- `packages/core-backend/tests/unit/approval-metrics-service.test.ts` — 13 cases covering all service methods via mocked `Query`.
- `packages/core-backend/tests/unit/approval-sla-scheduler.test.ts` — 3 cases covering happy path, error swallow, and reentrancy guard.

### Frontend
- `apps/web/src/views/approval/ApprovalMetricsView.vue` — admin dashboard (summary cards, 模板汇总 table, 超时实例 table).
- `apps/web/src/views/approval/TemplateDetailView.vue` — inline SLA editor under existing category / visibility editors.
- `apps/web/src/router/appRoutes.ts` — `/approvals/metrics` route.
- `apps/web/src/App.vue` — nav link for admins (`canManageUsers`).
- `apps/web/src/approvals/api.ts` — `updateTemplateSlaHours`, `fetchApprovalMetricsSummary`, `fetchApprovalMetricsBreaches`, `fetchApprovalInstanceMetrics`.
- `apps/web/src/types/approval.ts` — add `slaHours` to `ApprovalTemplateListItemDTO`.

## Migration safety

- Additive only. Migration adds one nullable column on `approval_templates` and one new table referencing `approval_instances` via `ON DELETE CASCADE`.
- Idempotent: `ADD COLUMN IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, constraint creation guarded by `DROP … IF EXISTS` + `ADD`.
- Backfill on live data is unnecessary — only future instances collect metrics. Rows missing a metrics companion show up as `null` through `GET /api/approvals/metrics/instances/:id` (404), which the admin dashboard tolerates.

## Rollback

1. Stop writers: `APPROVAL_SLA_SCHEDULER_DISABLED=1` on restart, then revert the service hook commit.
2. Drop data: `DROP TABLE approval_metrics;` (CASCADE is safe — no other objects depend on it).
3. Drop column: `ALTER TABLE approval_templates DROP COLUMN sla_hours;`.
4. Or invoke the Kysely `down()` in the migration which performs steps 2 + 3 plus the trigger and constraint cleanup.

Frontend rollback: redeploy without the `ApprovalMetricsView` route; the sidebar entry is purely additive.

## Review hardening — 2026-04-25

- Changed SLA breach interval SQL from `(sla_hours || ' hours')::interval`
  to `sla_hours * interval '1 hour'` so Postgres does not attempt integer
  text concatenation.
- Removed duplicate global-admin checks from the summary and breaches routes.
  Both routes already use `rbacGuard('approvals:admin')`; the extra
  `isAdminActor()` gate could incorrectly reject users granted
  `approvals:admin` through RBAC tables.
- Exposed `slaCandidateCount` directly in backend and frontend summary DTOs.
  The dashboard now reads the exact denominator instead of reconstructing it
  from `slaBreachCount / slaBreachRate`, which was wrong when rate was zero.
