# Data Factory issue #1542 P2 prerequisite guidance - design notes - 2026-05-15

## Purpose

Issue #1542 is mainly an onboarding problem: users can reach the Data Factory Workbench, but when a source, target, mapping, or saved pipeline is missing, the page can feel like a dead end.

P0 fixed pipeline persistence. P1 made staging-as-source and blocked SQL executor states visible. This P2 slice tightens the next operator-facing gap: do not let users click `保存 Pipeline` when the Workbench already knows the pipeline cannot be saved yet.

This is a frontend-only guardrail. It does not add a backend API, migration, SQL executor, K3 template, or new integration behavior.

## Scope

Changed:

- `apps/web/src/views/IntegrationWorkbenchView.vue`
- `apps/web/tests/IntegrationWorkbenchView.spec.ts`
- This design MD
- Companion verification MD

Out of scope:

- No `plugins/plugin-integration-core` changes.
- No migration.
- No real SQL Server query executor.
- No Save-only behavior change.
- No route change for `/integrations/workbench`.
- No new connection-management page.

## Problem

Before this slice, the page already rendered a `Dry-run 前置条件` checklist and disabled the dry-run button until all required conditions were ready.

However, `保存 Pipeline` was still enabled unless a save request was already in flight:

```html
<button :disabled="savingPipeline">保存 Pipeline</button>
```

If source object, target object, field mappings, or idempotency keys were missing, clicking the button fell through to `buildPipelinePayload()` and surfaced one error at a time.

That behavior was safe, but poor for deployed trial users. It made the page reactive instead of guiding:

1. User clicks save.
2. UI reports the first missing item.
3. User fixes that item.
4. User clicks again.
5. UI reports the next missing item.

The issue asked for a clear checklist of missing prerequisites instead of generic late errors.

## Design

### 1. Separate save readiness from dry-run readiness

The page now computes save readiness independently:

```ts
const savePipelineReadinessItems = computed(() => [
  source system,
  source object,
  target system,
  target object,
  mapping,
  idempotency,
])
```

`canSavePipeline` is true only when every save prerequisite is ready.

`savePipelineBlockedSummary` renders either:

- `已满足保存条件。保存只写入 pipeline 配置，不调用外部系统。`
- `还缺 N 项：...`

This intentionally does not require a successful live connection test. Saving pipeline configuration is a metadata operation. Runtime availability is still handled by dry-run readiness and backend execution errors.

### 2. Disable Save Pipeline until prerequisites are complete

The save button now uses:

```html
:disabled="savingPipeline || !canSavePipeline"
```

The existing `buildPipelinePayload()` validation remains as a defensive guard for programmatic calls and unexpected UI states. The UI guard is a product affordance, not the only validation layer.

### 3. Preserve dry-run semantics

`dryRunReadinessItems` remains stricter than save readiness. It still requires:

- active readable source,
- selected source object,
- active target,
- selected target object,
- mappings,
- idempotency,
- saved pipeline ID.

This keeps the distinction visible:

- `保存 Pipeline`: writes only pipeline config.
- `Dry-run`: runs the pipeline preview path and requires a saved pipeline.

### 4. Keep copy deployment-friendly

The new copy avoids implying that payload preview equals dry-run or that saving writes to K3:

- Save summary explicitly says saving only writes pipeline config.
- Dry-run summary still says dry-run only generates preview and does not write external systems.

## Compatibility

- Existing route: unchanged.
- Existing API calls: unchanged.
- Existing backend validation: unchanged.
- Existing complete Workbench happy path: preserved.
- Existing source-empty and SQL blocked guidance: preserved.

The only UX behavior change is that `保存 Pipeline` cannot be clicked before the minimum config shape exists.

## Deployment impact

No deployment-side impact:

- no new env,
- no database migration,
- no Docker/package change,
- no workflow change,
- no Windows on-prem packaging change.

This can ship as a normal frontend update.

## GATE status

This does not lift the K3 customer GATE. It only makes the internal/bridge trial Workbench clearer while GATE data is still pending.

## Risk

Low. The main risk is an overly strict save gate. To avoid that, save readiness only checks that IDs/objects/mappings/idempotency are present; it does not require connection status to be active.

Dry-run remains the stricter runtime gate.

