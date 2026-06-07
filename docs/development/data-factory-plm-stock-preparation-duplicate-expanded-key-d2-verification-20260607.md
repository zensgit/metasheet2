# Data Factory PLM Stock Preparation Duplicate Expanded Key D2 Verification - 2026-06-07

## Scope

D2 adds policy review and policy persistence for `duplicate_expanded_key`.

This is not a duplicate-row apply slice. The C3 planner still emits
`manual_confirm` for duplicate expanded keys and C4 still writes nothing for
those rows.

## Implementation

- `plugins/plugin-integration-core/lib/stock-preparation-conflict-policies.cjs`
  adds the values-free policy contract:
  - `run_only` review payloads for the next dry-run.
  - `table_scope` policy list/save/revoke over plugin storage.
  - default `hold` when no matching policy is configured.
  - selected policy evidence with `writeEffect: manual_confirm_held`.
- `plugins/plugin-integration-core/lib/stock-preparation-table-actions.cjs`
  merges run-only and table-scope policies into
  `evidence.plan.conflictPolicyReview` during dry-run.
- `plugins/plugin-integration-core/lib/http-routes.cjs` adds admin-only
  table-scope policy routes and keeps Apply request bodies strict.
- `apps/web/src/views/IntegrationWorkbenchView.vue` adds policy controls to the
  duplicate diagnostics block:
  - `只此次有效` stores an in-memory run-only selection.
  - `保存为本表策略` and `撤销本表策略` are admin-only.
  - A pending run-only selection requires a fresh dry-run before Apply can be
    enabled.

## Guardrails

- No PLM write.
- No external database write.
- No K3 path.
- No target row write.
- No route/client path accepts a C3 plan or C4 payload.
- Apply rejects `conflictPolicyReview`.
- Table-scope save/revoke is admin-only.
- Policy routes do not load the source adapter or target records.
- Public evidence is values-free: no project number, component values, raw
  collision key, target sheet id, field id, approver identity, credential,
  token, payload, raw SQL, or PLM row value.

## Verification

Commands run:

```bash
node plugins/plugin-integration-core/__tests__/stock-preparation-conflict-policies.test.cjs
node plugins/plugin-integration-core/__tests__/stock-preparation-table-actions.test.cjs
node plugins/plugin-integration-core/__tests__/http-routes.test.cjs
pnpm --filter @metasheet/web exec vitest run tests/IntegrationWorkbenchView.spec.ts --watch=false
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

Results:

- conflict-policy unit suite: pass.
- table-action neighbor suite: pass.
- HTTP routes suite: pass.
- Workbench spec: 28/28 pass.
- Vue type-check: pass.

## Negative Controls Locked By Tests

- Invalid policy names are rejected.
- Unknown/stale fingerprints are ignored rather than applied silently.
- A write user cannot persist table-scope policy.
- Apply rejects client-supplied `conflictPolicyReview`.
- A dry-run with selected policy still reports duplicate rows as
  `manual_confirm`.
- A pending run-only policy selection disables Apply until the next dry-run
  binds the selection into evidence.
- Policy route responses hide target sheet id and approver identity.

## Deferred

Actual duplicate-row policy execution remains deferred. Future slices may
implement `keep_multiple_rows`, `merge_quantity`, `select_representative`,
`skip_selected`, or `source_correction_required`, but each must get its own
explicit review because those choices can change the rows written by C4.
