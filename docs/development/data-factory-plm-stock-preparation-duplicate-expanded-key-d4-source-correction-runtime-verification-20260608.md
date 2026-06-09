# Data Factory PLM Stock Preparation Duplicate Expanded Key D4 Source Correction Runtime Verification - 2026-06-08

## Scope

D4-1 implements `source_correction_required` as a held-only runtime reason for
reviewed duplicate-expanded-key groups.

It does not implement `merge_quantity`, `select_representative`, or
`skip_selected`. Those strategies remain held as `unsupported_policy`.

## Behavior

- A selected `source_correction_required` policy keeps the duplicate group
  fail-closed as `manual_confirm` / held.
- The conflict plan emits values-free evidence with
  `heldReasonCounts.source_correction_required`.
- A table-scoped `source_correction_required` policy can be persisted and
  reviewed, but Apply writes nothing for the held duplicate group.
- Applying a run that contains only the held source-correction group returns a
  held result with zero `createRecord` and zero `patchRecord` calls.

## Boundary

- No C2 expansion change.
- No idempotency-key change.
- No route, UI, migration, package, or OpenAPI change.
- No PLM write, external database write, K3 path, or production rollout.
- No source repair. Data Factory only reports that source correction is
  required.

## Values-Free Evidence

Public evidence may contain:

- policy name;
- scope;
- counts;
- deterministic collision fingerprints;
- held reason tokens.

It must not contain:

- project number;
- component code, component name, component source id, or material;
- parent, path, source detail id, source line, sort line, or raw PLM row;
- raw idempotency key or base key;
- target sheet id or field id;
- payload JSON, raw SQL, credentials, tokens, or stack traces with business
  values.

## Verification Commands

```bash
node plugins/plugin-integration-core/__tests__/stock-preparation-conflict-planner.test.cjs
node plugins/plugin-integration-core/__tests__/stock-preparation-table-actions.test.cjs
```

## Test Locks

- `source_correction_required` is distinct from `default_hold` and
  `unsupported_policy`.
- `source_correction_required` does not produce `add`, `update`, `skip`, or
  `inactive` decisions.
- Unimplemented policies (`merge_quantity`, `select_representative`,
  `skip_selected`) still remain held as `unsupported_policy`.
- Saved table-scope `source_correction_required` policy keeps the group held
  and makes no target records API write calls.
- Evidence serialization does not include sensitive project/component/source
  values from the fixtures.
