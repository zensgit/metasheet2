# Data Factory PLM Stock Preparation Duplicate Expanded Key D4 Merge Quantity Design - 2026-06-08

## Purpose

Define the design contract for `merge_quantity`, a D4 duplicate policy candidate
for held duplicate-expanded-key groups where the legacy stock-preparation system
or owner-approved rule confirms that duplicate rows represent additive demand.

This is design-only. It does not authorize runtime changes, another Apply,
production rollout, checkpoint writer work, K3 write, PLM write, external
database write, raw SQL, migration, route, UI, package change, or any planner
decision change.

## Baseline

D3 proved `keep_multiple_rows` only for duplicate groups with a stable
discriminator. The remaining held groups have `missing_stable_discriminator`,
so Data Factory cannot safely create independent rows for each duplicate.

`merge_quantity` is not the default answer for those groups. It is valid only
when the duplicate rows are known to be additive stock-preparation demand.
Otherwise, summing can double-count demand and turn a source-data conflict into
an apparently valid row.

## Definition

`merge_quantity` means:

- multiple duplicate demand rows collapse into one target demand row;
- the merged row's quantity is the sum of the source path quantities;
- non-quantity business fields are selected only through an explicit reviewed
  rule;
- all merged input rows remain visible as values-free counts/fingerprints;
- Data Factory does not write or repair PLM/source data.

It is not:

- a default policy for `missing_stable_discriminator`;
- pick-one with a larger quantity unless the quantity rule is explicitly sum;
- a way to hide source duplicates;
- a repair of PLM/source data;
- safe for varied quantity groups without explicit owner review.

## When It Is Allowed

This policy is allowed only when all are true:

- legacy stock-preparation behavior confirms that this duplicate shape is
  merged as additive demand, or the owner explicitly approves additive merge for
  this target table/action;
- quantity-shape evidence is reviewed;
- the merge quantity rule is sum of path quantities;
- non-quantity field selection is explicit and values-free;
- the operator reviews a fresh dry-run before any future apply.

If legacy behavior is unknown, default to `source_correction_required`.

## Quantity Contract

The future runtime quantity rule must be:

```text
mergedTotalQuantity = sum(each duplicate row path totalQuantity)
```

It must never:

- pick one quantity;
- average quantities;
- choose max/min quantity;
- treat varied quantities as equal;
- merge rows from a bounded/partial large-BOM expansion;
- merge across unrelated collision fingerprints.

If any input quantity is invalid, missing, non-finite, or not reviewable in
values-free evidence, the group stays held.

## Non-Quantity Field Contract

Because multiple rows collapse into one row, non-quantity fields need an
explicit rule. A future implementation must define this before any write:

- source lineage evidence stays values-free;
- representative non-quantity fields must come from a legacy-backed rule or
  owner-reviewed selector;
- human-preserved target fields remain untouched;
- PLM/source data is never written.

If non-quantity fields differ and no rule exists, the group stays held under
`source_correction_required` or a future manual-review token.

## Evidence Shape

Allowed public evidence:

```text
policy=merge_quantity
scope=decision_only | run_only | table_scope
mergedGroupCount=<count>
mergedInputRowCount=<count>
mergedOutputRowCount=<count>
quantityShapeCounts:
  all_equal=<count>
  varied=<count>
  unknown=<count>
nonQuantityFieldShape:
  all_equal=<count>
  varied=<count>
  unknown=<count>
legacyBehavior=merge_quantity | other_confirmed_token
collisionFingerprintsPresent=true
applyAuthorizedNow=false
```

Forbidden evidence:

- project number;
- component code, component name, or component source id;
- parent, path, PLM row id, source detail id, source line, or sort line;
- raw idempotency key or base key;
- raw PLM rows;
- raw quantity values;
- payload preview JSON;
- target sheet id or field id;
- credentials, tokens, connection strings, raw SQL, or stack traces containing
  business values.

## Future Runtime Contract

If implemented later, the future planner must:

- produce one write-eligible decision per merged duplicate group;
- sum path quantities only after legacy/owner approval;
- keep merged input row count visible in values-free evidence;
- fail closed if quantity shape changes after review;
- fail closed if non-quantity field selection is ambiguous;
- fail closed if the run is large-BOM bounded or otherwise incomplete;
- keep unmerged groups held.

The future apply path must:

- require a fresh dry-run token;
- require reviewed merge evidence;
- require explicit owner acknowledgement;
- write no PLM/source data;
- preserve existing target-scoped write and idempotency locks;
- never write human-preserved fields.

## Operator Wording

Use wording that makes the quantity semantics explicit:

```text
Quantity merge selected. Data Factory will produce one reviewed demand row for
this duplicate group and use summed path quantities. Confirm only if the legacy
stock-preparation behavior or owner decision says these rows are additive
demand.
```

Avoid wording such as "combine duplicates" without naming that quantities are
summed and that non-quantity field selection is reviewed separately.

## Acceptance Locks

- Design-only: no runtime, route, UI, migration, package, C2 expansion, C3
  planner, C4 apply, idempotency-key, K3, PLM write, or external DB write
  change.
- `merge_quantity` must never be the default for
  `missing_stable_discriminator`.
- It is allowed only with confirmed legacy additive-merge behavior or explicit
  owner approval.
- It must sum path quantities, not pick one.
- It must fail closed on invalid, missing, non-finite, unknown, or bounded-run
  quantity evidence.
- It must never silently drop merged input rows from evidence.
- It must never write PLM/source data.
- Future implementation must be a separate opt-in with tests proving quantity
  sum semantics, non-quantity ambiguity handling, large-BOM bounded fail-closed
  behavior, no target writes for held groups, and values-free evidence.

## Future Test Plan

When implementation is explicitly approved, add tests for:

1. Unknown legacy behavior defaults away from `merge_quantity` and keeps the
   group held.
2. Confirmed additive legacy behavior produces one write-eligible merged
   decision with summed path quantity.
3. Pick-one, max/min, and average quantity rules are impossible.
4. Varied quantity groups require explicit owner approval and values-free
   quantity-shape evidence.
5. Non-quantity field variation without a selector fails closed.
6. Large-BOM bounded runs cannot merge duplicate groups.
7. Evidence exposes counts/fingerprints/policy but not raw quantity values,
   project/component, parent/path, raw row, raw key, target id, or
   secret-shaped values.

None of these tests are added by this design slice because no runtime behavior
is introduced here.
