# Data Factory PLM Stock Preparation Duplicate Expanded Key D4 Source Correction Design - 2026-06-08

## Purpose

Define the design contract for `source_correction_required`, the conservative
D4 policy candidate for duplicate-expanded-key groups that remain held with
`missing_stable_discriminator`.

The D4-1 runtime slice implements only the held-only part of this contract:
`source_correction_required` can be selected and reported as its own held
reason. It still does not authorize another Apply, production rollout,
checkpoint writer work, K3 write, PLM write, external database write, raw SQL,
migration, route, UI, package change, or any source repair.

## Baseline

D3 `keep_multiple_rows` validation closed as a clean partial pass for groups
with a stable discriminator:

- clean rows remained idempotent on re-pull;
- one reviewed duplicate group resolved and wrote once;
- re-pull showed the resolved rows as existing rows, not another add;
- the remaining groups stayed held fail-closed.

The remaining D3 held reason is `missing_stable_discriminator`. That means the
system does not have a safe row identity for those groups. For such groups, an
automatic merge, automatic pick-one, or automatic skip can create stock
preparation errors.

## Definition

`source_correction_required` means:

- the duplicate group stays held;
- Data Factory does not write target rows for that group;
- Data Factory does not write or repair PLM/source data;
- the operator/customer must resolve the source-side duplicate or provide an
  explicit owner-approved decision in a later strategy slice;
- evidence reports counts, fingerprints, and reason tokens only.

It is not:

- a delete;
- a skip;
- a merge;
- a representative selection;
- a PLM correction action;
- a way to make held rows disappear from evidence.

## When It Is The Default

Use `source_correction_required` as the default when any of these is true:

- legacy stock-preparation behavior is unknown;
- legacy behavior rejects or reports this duplicate shape;
- no stable row discriminator exists;
- quantity shape is `varied` and additive semantics are not confirmed;
- the duplicate looks like contradictory source data rather than additive
  demand;
- the run is bounded by a large-BOM scale halt, so duplicate evidence is not
  authoritative.

If a future D4 evidence packet later proves that legacy behavior is dedup,
skip, or additive merge, that must open the corresponding strategy slice. This
design does not pre-approve that switch.

## Evidence Shape

Allowed public evidence for this policy:

```text
policy=source_correction_required
scope=decision_only | run_only | table_scope
heldGroupCount=<count>
heldRowCount=<count>
heldReasonCounts:
  missing_stable_discriminator=<count>
quantityShapeCounts:
  all_equal=<count>
  varied=<count>
  unknown=<count>
legacyBehavior=unknown | reject_or_report | other_token
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

## D4-1 Runtime Contract

This policy is held-only:

- affected duplicate groups remain `manual_confirm` / held;
- no `add`, `update`, `skip`, or `inactive` decision is produced for affected
  rows;
- no target write is attempted for affected rows;
- apply result, if other clean rows are allowed by existing gates, reports
  the source-correction groups as held;
- evidence must distinguish `source_correction_required` from generic
  `default_hold` so the operator understands the required next action.

This runtime contract must not weaken existing gates:

- fresh dry-run required;
- fresh token required;
- reviewed policy evidence required;
- explicit owner acknowledgement required before any non-held rows are applied;
- values-free evidence only.

## Operator Wording

Use wording that keeps the data boundary precise:

```text
Source correction required. Data Factory did not write these held groups.
The source/legacy owner must correct or explicitly decide the duplicate shape
before another strategy can be applied.
```

Avoid wording that implies Data Factory can repair PLM/source data.

## Acceptance Locks

- D4-1 only adds held-only evidence/runtime handling for
  `source_correction_required`; it does not change routes, UI, migration,
  package, C2 expansion, idempotency-key generation, K3, PLM write, or external
  DB write behavior.
- Unknown legacy behavior defaults to `source_correction_required`.
- `source_correction_required` must keep demand visible as held evidence; it
  must never silently drop demand.
- It must never create target rows.
- It must never write PLM/source data.
- It must never be treated as successful resolution of a duplicate group.
- Any further strategy implementation must be a separate opt-in with tests
  proving its held/write behavior and values-free evidence.

## Verification

Implementation is pinned by tests for:

1. `missing_stable_discriminator` + unknown legacy behavior produces
   `source_correction_required` held evidence.
2. Affected rows produce no target create/patch calls.
3. The held reason is distinct from `default_hold`.
4. Evidence contains policy, counts, and fingerprints but no project/component,
   parent/path, raw row, idempotency key, target id, or secret-shaped values.
5. Applying unrelated clean rows, if allowed by the then-current gate, leaves
   source-correction groups held and visible.
6. Large-BOM bounded runs cannot use this policy to make duplicate evidence
   authoritative.

Runtime coverage added in D4-1:

- planner-level test: a selected `source_correction_required` policy remains
  fail-closed and reports `heldReasonCounts.source_correction_required`;
- planner-level test: `merge_quantity`, `select_representative`, and
  `skip_selected` still remain held as `unsupported_policy`;
- table-action test: a saved table-scope `source_correction_required` policy
  dry-runs as held, applies with zero create/patch calls, and emits values-free
  evidence.
