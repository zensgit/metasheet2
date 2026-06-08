# Data Factory PLM Stock Preparation Duplicate Expanded Key D4 Skip Selected Design - 2026-06-08

## Purpose

Define the design contract for `skip_selected`, a D4 duplicate policy candidate
for held duplicate-expanded-key groups where the owner explicitly decides that
specific duplicate demand rows should not become stock-preparation rows.

This is design-only. It does not authorize runtime changes, another Apply,
production rollout, checkpoint writer work, K3 write, PLM write, external
database write, raw SQL, migration, route, UI, package change, or any planner
decision change.

## Baseline

D3 `keep_multiple_rows` validation proved that duplicate groups with a stable
discriminator can resolve safely. The remaining held groups have
`missing_stable_discriminator`, so Data Factory cannot safely turn every row
into an independent target row.

`skip_selected` is the highest-friction policy by design: skipping demand can
under-prepare stock if it is wrong. Therefore it must be explicit,
owner-reviewed, values-free in evidence, and never the default.

## Definition

`skip_selected` means:

- the owner explicitly selects which demand rows in a duplicate group are not
  written;
- skipped demand remains visible in evidence as counts/fingerprints;
- non-skipped rows are handled only by a separately valid policy or remain held;
- Data Factory does not write PLM/source data;
- Data Factory does not infer skipped rows from array order, component code, or
  planner convenience.

It is not:

- a default duplicate policy;
- an automatic drop;
- an automatic pick-first/skip-rest policy;
- a merge;
- a source correction;
- a way to hide demand from evidence.

## When It Is Allowed

This policy is allowed only when all are true:

- legacy stock-preparation behavior or owner policy confirms that selected
  duplicate demand is intentionally ignored for the same duplicate shape;
- the owner explicitly selects the skipped demand or approves a legacy-backed
  skip rule;
- the skipped demand count is visible before any future apply;
- the operator reviews a fresh dry-run after the skip selection;
- values-free evidence shows the selected scope and skipped-demand counts.

If legacy behavior is unknown, default to `source_correction_required`.

## Selection Contract

The future runtime selector must be explicit and revision-bound.

Allowed selection inputs:

- collision fingerprint plus selected row ordinal inside the fresh dry-run
  group;
- a legacy-backed skip rule token, only when the legacy behavior is confirmed;
- owner-approved values-free row-rank metadata shown in dry-run evidence.

Forbidden selection inputs:

- component code/name/source id;
- raw parent/path/source detail id/source line/sort line values;
- raw idempotency key;
- PLM array order without a legacy-backed ordering rule;
- implicit "skip all but first";
- implicit "skip rows that look duplicate";
- stale UI row position from a previous dry-run.

Any change to collision group shape, row count, selected ordinal, held reason,
quantity shape, or legacy behavior evidence must invalidate the prior skip
selection.

## Evidence Shape

Allowed public evidence:

```text
policy=skip_selected
scope=decision_only | run_only | table_scope
selectedGroupCount=<count>
skippedDemandRowCount=<count>
remainingHeldGroupCount=<count>
selectorKind=operator_selected | legacy_rule
legacyBehavior=skip_selected | other_confirmed_token
quantityShapeCounts:
  all_equal=<count>
  varied=<count>
  unknown=<count>
collisionFingerprintsPresent=true
applyAuthorizedNow=false
```

Forbidden evidence:

- project number;
- component code, component name, or component source id;
- parent, path, PLM row id, source detail id, source line, or sort line;
- raw idempotency key or base key;
- raw PLM rows;
- payload preview JSON;
- target sheet id or field id;
- credentials, tokens, connection strings, raw SQL, or stack traces containing
  business values.

## Future Runtime Contract

If implemented later, the future planner must:

- mark selected rows as intentionally skipped/held evidence, not as invisible
  rows;
- produce no target write for selected skipped rows;
- fail closed if the skip selection no longer matches the fresh dry-run group
  shape;
- fail closed if owner approval or legacy behavior evidence is missing;
- keep unselected rows held unless another separately valid policy applies;
- preserve row counts so skipped demand can be audited values-free.

The future apply path must:

- require a fresh dry-run token;
- require reviewed skip evidence;
- require explicit owner acknowledgement;
- write no PLM/source data;
- preserve existing target-scoped write and idempotency locks.

## Operator Wording

Use wording that makes the risk visible:

```text
Selected duplicate demand will not be written. Data Factory will keep this
skipped demand visible in values-free evidence. Confirm only if the legacy
stock-preparation behavior or owner decision says this demand should be ignored.
```

Avoid wording such as "remove duplicate" or "clean duplicate" without naming
that stock-preparation demand is being skipped.

## Acceptance Locks

- Design-only: no runtime, route, UI, migration, package, C2 expansion, C3
  planner, C4 apply, idempotency-key, K3, PLM write, or external DB write
  change.
- `skip_selected` must never be the default for
  `missing_stable_discriminator`.
- It is allowed only with confirmed legacy skip behavior or explicit owner
  selection.
- It must never silently drop demand.
- It must never silently pick skipped rows.
- It must never write PLM/source data.
- It must report skipped demand as values-free evidence.
- Future implementation must be a separate opt-in with tests proving
  explicit selection, stale-selection fail-closed behavior, no target writes for
  skipped rows, and values-free skipped-demand evidence.

## Future Test Plan

When implementation is explicitly approved, add tests for:

1. Unknown legacy behavior defaults away from `skip_selected` and keeps the
   group held.
2. Explicit selected skipped rows produce skipped-demand evidence and no target
   create/patch calls.
3. Implicit skip-all-but-first is rejected.
4. A stale skip selection fails closed when fresh dry-run group shape changes.
5. Skipped-demand counts remain visible in apply evidence if unrelated rows are
   written.
6. Unselected rows remain held unless another separately valid policy applies.
7. Evidence omits project/component, parent/path, raw row, raw key, target id,
   and secret-shaped values.

None of these tests are added by this design slice because no runtime behavior
is introduced here.
