# Data Factory #2342 C1 - large-BOM bounded readiness verification (2026-06-06)

## Scope

This slice implements the C1 runtime readiness shape from
`data-factory-plm-stock-preparation-large-bom-c0-design-20260606.md`.

It changes only the PLM stock-preparation table-action dry-run path:

- scale caps become an explicit bounded readiness state;
- Apply remains blocked;
- no dry-run token is issued;
- evidence stays values-free.

No UI, route redesign, background worker, checkpoint writer, package change,
MetaSheet row write, PLM write, external database write, K3 path, or production
rollout is included.

## Runtime shape

When expansion hits a scale-class cap, dry-run now returns:

```json
{
  "status": "large_bom_bounded",
  "largeBom": true,
  "canApply": false,
  "dryRunToken": null,
  "boundedPreview": {
    "complete": false,
    "authoritative": false,
    "rowsExpanded": 500,
    "readCount": 1068,
    "errorTypes": ["max_rows_exceeded"]
  }
}
```

The exact counts vary by run. The important invariants are:

- `largeBom=true` means the plan is not authoritative.
- `canApply=false` is mandatory.
- `dryRunToken` is absent/null.
- C3 counts are bounded/subset counts only.
- issue/customer evidence must copy only the values-free evidence object, never
  row payloads or tenant-visible preview values.

## Scale caps

C1 treats these error types as bounded large-BOM scale failures:

- `max_rows_exceeded`
- `read_page_limit_exceeded`
- `read_count_exceeded`
- `read_time_limit_exceeded`

`read_page_limit_exceeded` is preserved from the read helper instead of being
collapsed into `read_failed`. This matters because a wide object exceeding page
budget is a scale condition, while a driver/query failure is a source failure.

The helper also accepts server-side `maxReadCount` and `maxElapsedMs` options.
They are not browser-controlled and do not unlock Apply.

## Hard failures stay hard

These are not converted into `largeBom=true`:

- `max_depth_exceeded`
- `cycle_detected`
- `read_failed`
- invalid quantities or other row-level correctness issues
- mixed scale + hard global errors
- mixed scale + row-level correctness errors

That keeps runaway/correctness/source failures distinct from bounded scale
diagnostics.

## Verification

Commands:

```bash
pnpm --filter plugin-integration-core test:stock-preparation-bom-expansion
pnpm --filter plugin-integration-core test:stock-preparation-table-actions
pnpm --filter plugin-integration-core test
```

Covered assertions:

- `max_rows_exceeded` dry-run returns `status='large_bom_bounded'`,
  `largeBom=true`, `canApply=false`, `dryRunToken=null`, and stores no token.
- `read_page_limit_exceeded` is preserved as a bounded scale error and reported
  through `boundedPreview.errorTypes`.
- `maxReadCount` produces `read_count_exceeded` with values-free diagnostics.
- `maxElapsedMs` produces `read_time_limit_exceeded` with values-free
  diagnostics.
- `max_depth_exceeded` remains `status='failed'` and `largeBom=false`.
- a scale cap mixed with a row-level correctness error remains
  `largeBom=false` and does not expose `boundedPreview`.
- evidence does not contain project number, component source id, component
  display value, PLM path id, dry-run token, sheet id, field id, raw SQL, or
  secret material.

## Remaining gates

- C2: UI display for summary-first bounded review.
- C3: background full-expansion design.
- C4: checkpointed large apply design.
- C5: entity-machine validation with values-free evidence.

Duplicate handling for large samples (#2343 D1) should wait until full expansion
is available for those large samples, because bounded/subset duplicate counts are
not authoritative.
