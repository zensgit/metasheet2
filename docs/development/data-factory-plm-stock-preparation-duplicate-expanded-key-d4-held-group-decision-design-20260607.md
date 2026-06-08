# Data Factory PLM Stock Preparation Duplicate Expanded Key D4 Held-Group Decision Design - 2026-06-07

## Purpose

Define the D4 decision contract for the duplicate groups that remained held
after D3 `keep_multiple_rows` validation on the #2340 sample.

This is design-only input. It does not authorize runtime changes, Apply, K3
write, PLM write, external database write, production rollout, checkpoint
writer work, or any new duplicate policy execution.

## Grounded Baseline

D3 is a clean partial pass:

- the #2340 sample expanded completely with `rowsExpanded=246`;
- the already-written clean rows remained idempotent on re-pull;
- one reviewed duplicate group resolved through `keep_multiple_rows`;
- the resolved rows wrote once, then re-pulled as existing rows;
- the remaining held groups stayed fail-closed.

Values-free closeout shape:

```text
prePolicyDryRun:
  rowsExpanded=246
  existingRows=190
  add/update/skip/inactive/manual_confirm=0/0/190/0/56

postPolicyDryRun:
  add/update/skip/inactive/manual_confirm=2/0/190/0/54
  resolvedGroupCount=1
  resolvedRowCount=2
  heldGroupCount=27
  heldRowCount=54
  heldReasonCounts=missing_stable_discriminator
  runOnlyResolvedGroupCount=1
  tableScopeResolvedGroupCount=0

apply:
  status=partial
  created/patched/failed/held=2/0/0/27
  skipped=190

rePull:
  existingRows=192
  add/update/skip/manual_confirm=0/0/192/54
  resolvedGroupCount=1
  resolvedRowCount=2
  heldGroupCount=27
  heldRowCount=54
  heldReasonCounts=missing_stable_discriminator
  rowErrors=0
```

Interpretation:

- Dry-run decision counts are row-level. Held group counts are tracked
  separately through `heldGroupCount`, so 27 held groups with 54 held rows
  produce `manual_confirm=54`.
- `keep_multiple_rows` is proven only for duplicate groups with a stable row
  discriminator.
- The remaining 27 groups are not resolvable multi-row cases under D3. Their
  observed held reason is `missing_stable_discriminator`.
- The remaining groups must not be forced through `keep_multiple_rows`.
- No additional Apply should run until D4 diagnostics and an owner-approved
  policy decision are complete.

## D4 Decision Inputs

D4 must decide from evidence, not from speculation.

### 1. Legacy Stock-Preparation Behavior

The legacy stock-preparation system is the source of truth for the duplicate
shape because this track replaces that system.

Before implementing a policy, confirm how the legacy system handles the same
duplicate shape:

- reject or report the duplicate;
- deduplicate or keep one row;
- merge quantity;
- skip selected demand;
- another explicit behavior.

If legacy behavior cannot be confirmed, the default D4 posture is
`source_correction_required` and no Apply.

### 2. Existing Values-Free Diagnostics

D4 should reuse the values-free D1/D3 diagnostics already available in the dry
run evidence:

- `heldGroupCount`;
- `heldRowCount`;
- `heldReasonCounts`;
- rows-per-group distribution;
- same-parent vs cross-parent shape counts when present;
- `quantityShapeCounts` (`all_equal` vs `varied`);
- `stableDiscriminatorCounts`;
- attribute-shape counts when present;
- deterministic collision fingerprints.

These diagnostics identify which policy family is even safe to consider. They
do not authorize a policy by themselves.

### 3. Complete Expansion Requirement

Duplicate diagnosis is authoritative only on a complete expansion. If a run is
bounded by the large-BOM track (`largeBom=true`, `max_rows_exceeded`, or another
scale halt), D4 must route back to #2342 before choosing a duplicate strategy
for that sample.

The #2340 validation sample had complete expansion, so its remaining
`missing_stable_discriminator` held groups are valid D4 inputs.

## Policy Decision Matrix

### `source_correction_required`

Default for:

- missing legacy behavior;
- `missing_stable_discriminator` groups where the legacy system rejects or
  reports duplicates;
- varied quantity groups where merging is not explicitly confirmed as the
  legacy behavior;
- any group where the source appears contradictory and no safe row identity can
  be established.

Effect:

- keep the group held;
- report a values-free reason that source correction is required;
- do not write MetaSheet rows;
- do not attempt to write or correct PLM.

### `select_representative`

Candidate only when:

- the legacy system deduplicates or keeps one row for the same duplicate shape;
- the owner supplies an explicit reviewed representative rule or selection;
- skipped demand remains visible in values-free evidence as counts and
  fingerprints.

Locks:

- never auto-pick the first row;
- never infer representative choice from component code alone;
- never hide which collision fingerprints were not written.

### `skip_selected`

Candidate only when:

- the owner explicitly selects which duplicate demand is intentionally ignored;
- the skipped demand is recorded in values-free evidence.

Locks:

- no silent drop;
- no default skip;
- no Apply without fresh dry-run evidence and explicit owner acknowledgement.

### `merge_quantity`

Not the default for the remaining 27 groups.

Candidate only when:

- legacy behavior confirms that the same duplicate shape is merged as additive
  demand;
- business semantics confirm that summing does not double-count
  stock-preparation demand;
- varied quantities receive explicit owner review.

Locks:

- varied quantity is not automatically mergeable;
- merging must sum path quantities, not pick one row;
- if the source-data shape suggests a conflict rather than additive demand,
  default back to `source_correction_required`.

### `keep_multiple_rows`

Already covered by D3. It remains valid only when the duplicate group has a
stable discriminator that can produce surgical, deterministic keys.

For the remaining #2340 held groups, the observed reason is
`missing_stable_discriminator`, so D4 must not choose `keep_multiple_rows`
unless future evidence proves a stable discriminator exists for a specific
group.

## Acceptance Locks

- D4 is a decision/design track only. It must not change C2 expansion, C3
  planner output, C4 apply behavior, idempotency-key generation, target writes,
  package contents, migrations, routes, or UI behavior.
- Remaining held groups stay held fail-closed until a future implementation
  slice is explicitly approved.
- No additional Apply is authorized from D3 partial-pass evidence.
- `merge_quantity` is not the default next policy for
  `missing_stable_discriminator`.
- Unknown legacy behavior defaults to `source_correction_required`.
- `select_representative` and `skip_selected` require explicit owner selection
  and values-free skipped-demand evidence.
- Any future executable policy requires a fresh dry-run, fresh token, reviewed
  policy evidence, and explicit owner acknowledgement.
- Public evidence must not expose project number, component code/name/source
  id, parent/path/idempotency key, raw PLM rows, target sheet id, field id,
  payload JSON, raw SQL, credentials, tokens, or stack traces with business
  values.

## Future Slices

D4 should lead to one or more separately opted implementation slices only after
the legacy-system behavior and quantity-shape evidence are confirmed:

- `source_correction_required` evidence/runtime handling;
- `select_representative` or dedup/keep-one handling;
- `skip_selected` handling;
- `merge_quantity` handling, only if legacy behavior confirms additive demand;
- additional runbook/operator validation.

None of those slices are started by this design.
