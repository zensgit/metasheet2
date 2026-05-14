# Data Factory Onboarding Readiness Verification - 2026-05-14

## Scope

This verification covers the first issue #1542 Data Factory onboarding slice:

- K3 WISE preset is discoverable from Data Factory;
- connection inventory can be expanded;
- empty source state gives an actionable next step;
- SQL read-channel runtime blocker is visible;
- dry-run and Save-only are disabled until prerequisites are complete;
- K3 setup page regression remains green.

## Frontend Focused Tests

Command:

```bash
pnpm --filter @metasheet/web exec vitest run \
  tests/IntegrationWorkbenchView.spec.ts \
  tests/IntegrationK3WiseSetupView.spec.ts \
  --watch=false
```

Result:

```text
Test Files  2 passed (2)
Tests       6 passed (6)
```

Coverage:

- Data Factory workbench renders `连接新系统` and `使用 K3 WISE 预设`.
- Inventory summary renders loaded connection, adapter, and staging counts.
- Inventory expansion renders configured systems, adapters, staging tables, and
  the SQL `queryExecutor` blocker.
- Advanced SQL connector stays hidden until the operator enables advanced
  connectors.
- K3 SQL read + K3 WebAPI write guidance remains visible.
- Source-empty state explains PLM / HTTP / SQL source onboarding.
- Dry-run readiness checklist reports missing prerequisites.
- Dry-run is disabled when no readable source exists.
- Error-state source and target systems are not treated as dry-run ready.
- Saved pipeline path reports `已满足 dry-run 前置条件`.
- K3 WISE setup page tests remain green.

## Review Hardening Coverage

The focused workbench test now includes an error-state source and an
error-state target:

- source system `status: error` with a generic network timeout is shown as
  `异常：network timeout`;
- target system `status: error` with a generic ERP endpoint failure is shown as
  `异常：ERP endpoint unavailable`;
- neither selected system satisfies dry-run readiness;
- the dry-run button remains disabled.

This covers the reviewer concern that selected-but-broken systems should not be
reported as ready.

## Production Build

Command:

```bash
pnpm --filter @metasheet/web build
```

Result:

```text
PASS - vue-tsc -b and vite build completed.
```

Notes:

- Vite emitted existing large chunk / dynamic import warnings.
- No new build failure or type error was introduced by this slice.

## Static Check

Command:

```bash
git diff --check
```

Result:

```text
PASS - no whitespace errors or conflict markers.
```

## K3 Offline PoC Regression

Command:

```bash
pnpm verify:integration-k3wise:poc
```

Result:

```text
PASS - K3 WISE PoC mock chain verified end-to-end.
```

Coverage:

- live PoC preflight packet tests passed;
- live evidence compiler tests passed;
- K3 fixture contract tests passed;
- mock K3 WebAPI tests passed;
- mock SQL Server executor tests passed;
- mock material and BOM Save-only chain completed with 0 Submit / Audit calls.

## Manual Review Checklist

1. Open `/integrations/workbench`.
2. Confirm the page title remains Data Factory.
3. Confirm the onboarding block offers K3 WISE preset, connection guidance, and
   SQL advanced guidance.
4. Expand the inventory overview and confirm configured connections, adapters,
   and staging tables are visible.
5. Use a backend response where K3 SQL source has `lastError` containing
   `queryExecutor`; confirm the blocker appears in the overview and source
   panel.
6. Use a backend response with no source systems; confirm the empty state
   explains how to add a readable source.
7. Confirm `Dry-run` is disabled until source, source dataset, target, target
   dataset, mapping, idempotency, and saved pipeline are all present.
8. Confirm `Save-only 推送` remains disabled unless Save-only is explicitly
   checked and the dry-run prerequisites are satisfied.

## Deployment Impact

- No migration.
- No backend route change.
- No package script change.
- No K3 live Submit / Audit enablement.
- No secrets are rendered or stored by this UX-only slice.

## Remaining Work

This slice intentionally does not resolve the deeper blockers from issue #1542:

- a real generic connection wizard;
- SQL allowlisted `queryExecutor` deployment;
- staging multitable rows as a readable source fallback;
- full live K3 pipeline execution after customer GATE.

Those should be separate PRs because they change backend execution semantics.
