# Data Factory field polish design - 2026-05-19

## Purpose

This slice follows the latest issue #651 UX feedback after the Data Factory main
path was verified on the entity machine. The prior package proved the route,
K3 WISE test, source/target selection, pipeline save, and dry-run path work. The
remaining problem is comprehension: the field-mapping and run sections still
look too much like raw technical configuration.

This change is frontend-only and keeps the existing API contract, route, payload
shape, and Stage 1 GATE boundary unchanged.

## Changes

### Mapping rules as business rows

The old mapping table has been replaced with one expandable card per cleansing
item:

- Summary line: `source -> target`
- Secondary detail: transform, required flag, range validation, dictionary map
- Expanded editor: source field, target field, transform, dictionary map, required,
  min/max, delete

The underlying `EditableMapping` model and generated `fieldMappings` payload are
unchanged. Existing tests still interact with the same `source-field-*`,
`target-field-*`, `transform-fn-*`, `required-*`, and validation test IDs.

### Custom cleansing items

The add button now says `新增自定义清洗项` instead of the more technical
`新增映射`. It still calls the same `addMapping()` function.

### Run and push explanation

The run section now explains:

- Dry-run only reads source data and generates payload preview.
- Save-only writes to the target save endpoint, with Submit/Audit still off.
- Source multitable data is not overwritten by run actions.
- Failures go to dead letters.
- Export uses redacted preview output.

### Pipeline name and field help

The pipeline name input now shows the generated default name and offers a
one-click `使用自动名称` action. The default remains editable.

Additional help text explains:

- Pipeline mode: `manual`, `incremental`, `full`
- Idempotency fields: prevent duplicate writes
- Saved pipeline ID: generated after save, reusable for reruns/debugging

## Non-goals

- No backend changes.
- No migration changes.
- No K3 WebAPI read/list runtime.
- No SQL executor injection.
- No Save / Submit / Audit behavior change.

