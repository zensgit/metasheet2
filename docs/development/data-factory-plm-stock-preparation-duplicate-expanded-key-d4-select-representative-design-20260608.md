# Data Factory PLM Stock Preparation Duplicate Expanded Key D4 Select Representative Design - 2026-06-08

## Purpose

Define the design contract for `select_representative`, a D4 duplicate policy
candidate for held duplicate-expanded-key groups when the legacy
stock-preparation system explicitly deduplicates or keeps one row for the same
duplicate shape.

This is design-only. It does not authorize runtime changes, another Apply,
production rollout, checkpoint writer work, K3 write, PLM write, external
database write, raw SQL, migration, route, UI, package change, or any planner
decision change.

## Baseline

D3 proved `keep_multiple_rows` only for duplicate groups with a stable
discriminator. Remaining held groups with `missing_stable_discriminator` do not
have safe independent row identity.

`select_representative` is the opposite shape from `keep_multiple_rows`:

- it does not create multiple target rows;
- it keeps exactly one reviewed representative demand row;
- it keeps all non-representative demand visible as skipped/held evidence;
- it is valid only when legacy behavior or owner-reviewed evidence confirms
  that keeping one row is the correct stock-preparation behavior.

## Definition

`select_representative` means:

- the owner chooses one representative row from a duplicate group;
- the chosen representative can become the only demand row for that group in a
  future implementation;
- unchosen rows are not silently dropped; they are counted and reported as
  intentionally not written;
- Data Factory does not write PLM/source data;
- Data Factory does not infer the representative from component code alone.

It is not:

- an automatic pick-first policy;
- a merge;
- a skip-all policy;
- a source correction;
- a way to hide non-representative demand from evidence.

## When It Is Allowed

This policy is allowed only when all are true:

- legacy stock-preparation behavior confirms dedup/keep-one for the same
  duplicate shape, or the owner explicitly approves a keep-one rule for this
  target table/action;
- quantity-shape evidence does not indicate additive demand that must be
  summed;
- a values-free representative selector is available;
- skipped demand is reported as counts/fingerprints;
- the operator reviews a fresh dry-run before any future apply.

If legacy behavior is unknown, default to `source_correction_required`.

## Representative Selector Contract

The future runtime selector must be explicit and deterministic.

Allowed selector inputs:

- operator-selected collision fingerprint plus representative ordinal within
  that fingerprint;
- owner-approved legacy rule token, such as `legacy_first_by_sequence`, only
  when that rule is confirmed by legacy behavior;
- values-free row-rank metadata that is reviewed in dry-run evidence.

Forbidden selector inputs:

- component code/name/source id;
- raw parent/path/source detail id/source line/sort line values;
- raw idempotency key;
- array order from PLM/read results without a legacy-backed ordering rule;
- implicit "first row wins";
- UI row position without a fresh dry-run/revision binding.

The selector must be bound to a fresh dry-run revision. A later dry-run that
changes the collision group count, row count, representative ordinal, or held
reason must invalidate the earlier selection.

## Evidence Shape

Allowed public evidence:

```text
policy=select_representative
scope=decision_only | run_only | table_scope
selectedGroupCount=<count>
selectedRepresentativeCount=<count>
skippedDemandRowCount=<count>
heldGroupCount=<count>
selectorKind=operator_selected | legacy_rule
legacyBehavior=dedup_keep_one | other_confirmed_token
quantityShapeCounts.all_equal=<count>
quantityShapeCounts.varied=<count>
quantityShapeCounts.unknown=<count>
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

- produce at most one write-eligible decision per selected duplicate group;
- keep non-representative rows out of target writes;
- report non-representative rows as skipped/held evidence, never silently
  discard them;
- fail closed if the selector no longer matches the fresh dry-run group shape;
- fail closed if legacy behavior or owner approval is missing;
- fail closed if quantity-shape evidence suggests additive demand and no
  explicit keep-one decision exists.

The future apply path must:

- require a fresh dry-run token;
- require reviewed representative evidence;
- require explicit owner acknowledgement;
- write no PLM/source data;
- preserve existing idempotency locks and target-scoped writes.

## Operator Wording

Use wording that names the skipped demand:

```text
Representative selected. Data Factory will keep one reviewed demand row for
this duplicate group. Non-representative rows are intentionally not written and
remain visible in values-free skipped-demand evidence.
```

Do not call non-representative rows "duplicates removed" without showing
skipped-demand counts.

## Acceptance Locks

- Design-only: no runtime, route, UI, migration, package, C2 expansion, C3
  planner, C4 apply, idempotency-key, K3, PLM write, or external DB write
  change.
- `select_representative` must never be the default for
  `missing_stable_discriminator`.
- It is allowed only with confirmed legacy dedup/keep-one behavior or explicit
  owner approval.
- It must never silently pick the first row.
- It must never silently drop non-representative demand.
- It must never write PLM/source data.
- Future implementation must be a separate opt-in with tests proving
  deterministic selection, fresh-revision binding, no target writes for
  non-representative rows, and values-free skipped-demand evidence.

## Future Test Plan

When implementation is explicitly approved, add tests for:

1. Unknown legacy behavior defaults away from `select_representative` and keeps
   the group held.
2. A selected representative emits one write-eligible decision and values-free
   skipped-demand counts for the rest.
3. An implicit pick-first selector is rejected.
4. A stale selector fails closed when fresh dry-run group shape changes.
5. Varied quantity groups require explicit owner approval before keep-one.
6. Target create/patch calls are never made for non-representative rows.
7. Evidence omits project/component, parent/path, raw row, raw key, target id,
   and secret-shaped values.

None of these tests are added by this design slice because no runtime behavior
is introduced here.
