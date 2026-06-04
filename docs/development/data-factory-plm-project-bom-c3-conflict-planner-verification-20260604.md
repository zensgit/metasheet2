# Data Factory #2253 C3 conflict planner verification (2026-06-04)

## Scope

PR scope: C3 conflict planner for PLM stock-preparation refreshes.

This slice adds a pure planner helper that consumes:

- C2 `expandedRows`;
- existing stock-preparation rows;
- C2 `rowErrors`;
- run metadata.

It outputs a write-free plan with `add`, `update`, `skip`, `inactive`, and
`manual_confirm` decisions for a later C4 apply writer.

No PLM read, route, UI, MetaSheet write, external database write, migration,
or K3 Save / Submit / Audit / BOM path is added.

## Verification run

Command:

```bash
pnpm --filter plugin-integration-core test:stock-preparation-conflict-planner
```

Result:

```text
stock-preparation-conflict-planner.test.cjs OK
```

## Test locks

- missing target row -> `add`;
- changed PLM/system fields -> `update`;
- unchanged row -> `skip`;
- PLM-missing existing row -> `inactive`, never delete;
- already inactive missing row -> `skip`;
- `add`, `update`, and `inactive` payloads do not include human-preserved
  fields;
- C2 `rowErrors` become `manual_confirm` while valid expanded rows still plan
  normally;
- duplicate expanded keys and duplicate existing keys fail closed as
  `manual_confirm` and never pick first;
- lineage mismatch and component identity conflict fail closed as
  `manual_confirm`;
- missing idempotency keys fail closed as `manual_confirm`;
- unsupported strategies (`deleteByDefault`, non-`mark_inactive` missing
  policy, or overwriting human fields) reject;
- values-free evidence summary contains counts, field names, and conflict
  types only, never project/component/material values.

## Boundary notes

C3 is not apply/write. It prepares a decision plan for C4.

The plan can contain business values in decision records because C4 will need
them to write PLM/system fields. The issue/customer evidence helper is separate
and values-free.
