# Data Factory #2388 C0 - PLM BOM source snapshot + diff gate design (2026-06-08)

## Scope

This is a design-only slice for issue #2388.

It defines the source snapshot + snapshot-diff lifecycle gate for PLM-driven
stock-preparation refreshes:

```text
external source read -> private source snapshot -> diff against last applied
snapshot -> values-free risk summary -> policy/owner review -> fresh Apply gate
```

This slice adds no runtime, route, UI, migration, package, worker, MetaSheet
row write, PLM write, external database write, K3 path, raw SQL, or production
rollout. It does not authorize Apply. It does not change the existing flat
target-table key scheme.

## Current grounding

Three safety invariants are already implemented and should be verified, not
rebuilt:

- PLM-missing target rows are planned as inactive, not physically deleted. The
  current conflict planner accepts only `missingFromPlmPolicy='mark_inactive'`
  for v1.
- Human-owned fields are protected. The current planner/writer constructs
  PLM-system payloads and rejects human-preserved fields defensively.
- Apply requires a fresh dry-run token/revision gate. The current table-action
  apply consumes the server-issued dry-run token and rejects revision mismatch.

The genuinely new #2388 scope is:

- private in-tenant source snapshots for PLM pulls;
- snapshot-to-snapshot diff: latest pull vs last applied snapshot;
- `missing_child_bom` detection and held behavior.

The current C2 expansion is app-side over flat equality reads. Today, a
component with no active BOM head/details is effectively treated as a leaf. That
is safe only when the source says it is a real leaf. #2388 adds the missing
distinction: a component expected to have children but missing its child BOM is
source-incomplete and must be held.

The current C3 plan compares current expansion rows against the target table:

```text
latest pull -> expanded rows -> target rows -> add/update/skip/inactive/manual_confirm
```

#2388 adds a separate review baseline:

```text
latest source snapshot -> last applied source snapshot -> source diff categories
```

Both are useful. They must not be conflated.

## Generic seam, PLM pilot

The model should be reusable across Data Factory source refreshes, but v1 should
implement only the PLM-BOM pilot.

Generic seam:

- `SourceSnapshot`;
- `SourceDiffResult`;
- category-to-policy mapping;
- values-free public evidence.

PLM pilot:

- stock-preparation project BOM;
- `ComponentNode` + `BomEdge` internal graph representation;
- PLM-specific diff categories such as `quantity_changed`,
  `hierarchy_changed`, and `missing_child_bom`.

Full cross-source generalization is deferred until at least a second real source
needs it. Do not build an abstract framework for ERP/SRM/CRM/HR/generic SQL sync
from PLM assumptions alone.

## Private / public split

Snapshots have two projections.

### Private tenant snapshot

The private snapshot must store enough source data to diff correctly:

- tenant/workspace/project/action scope;
- action config revision;
- source binding revision;
- read plan revision;
- source pull timestamp;
- parameter fingerprint and private parameter values;
- component identities and source-owned attributes;
- parent-child BOM edges with quantities, sort/order, hierarchy/path context,
  source version, and active/held state;
- source completeness markers;
- read diagnostics;
- schema/read-plan version.

Private snapshot data may contain PLM business values because the tenant runtime
needs them to diff and plan. It must stay in tenant runtime storage and must not
be copied into issue/customer evidence.

### Public evidence

Public evidence exposes only values-free summaries:

- snapshot id present/absent;
- action/source kind;
- row/node/edge counts;
- hierarchy count;
- source revision marker presence;
- category counts;
- policy names;
- held reason tokens;
- deterministic non-reversible fingerprints when correlation is required;
- error codes and status tokens.

Public evidence must not expose:

- project number;
- component code/name/material/source id;
- parent/path/idempotency key;
- raw PLM rows;
- target row values;
- target sheet id or field id;
- raw SQL;
- credentials, tokens, connection strings, or value-bearing stack traces.

## SourceSnapshot contract

Minimum generic shape:

```json
{
  "snapshotId": "opaque",
  "sourceSystemId": "private",
  "sourceKind": "data-source:sql-readonly",
  "sourceObject": "private",
  "schemaVersion": "source-snapshot.v1",
  "actionConfigRevision": "opaque",
  "sourceBindingRevision": "opaque",
  "readPlanRevision": "opaque",
  "pulledAt": "2026-06-08T00:00:00.000Z",
  "rowCount": 0,
  "nodeCount": 0,
  "edgeCount": 0,
  "status": "complete",
  "evidence": {
    "projectNoPresent": true,
    "sourceRevisionPresent": true,
    "nodeCount": 0,
    "edgeCount": 0,
    "heldReasonCounts": {}
  }
}
```

Private storage may include values. The public `evidence` object must not.

Snapshot statuses:

| Status | Meaning | Diffable? | Applyable? |
|---|---|---:|---:|
| `complete` | Source pull completed and passed source-completeness checks. | Yes | Maybe, after dry-run/review |
| `source_incomplete` | Source rows exist but source completeness failed. | Yes for evidence | No |
| `bounded` | Large-BOM cap produced a subset only. | No authoritative diff | No |
| `failed` | Read/validation failed. | No | No |
| `expired` | Private snapshot payload expired. | No | No |

Only `complete` snapshots may become the "last applied snapshot" baseline.

## PLM node/edge model

The PLM pilot should preserve graph shape internally.

### ComponentNode

`ComponentNode` represents the component/material identity and source-owned
attributes:

- component source id;
- component code/name/material;
- source version/revision;
- source completeness markers;
- whether the source says the component is an assembly / should have a child
  BOM, when available.

### BomEdge / BomLine

`BomEdge` represents the parent-child usage relation:

- parent component source id;
- child component source id;
- edge quantity;
- cumulative quantity context;
- sort/order/source-detail discriminator when available;
- hierarchy/path context;
- source snapshot id;
- active/held/inactive state;
- held reason token.

This split matters:

- quantity changes belong to the edge/line;
- hierarchy changes are edge changes;
- the same component under multiple parents is not necessarily a duplicate
  component;
- missing child BOM is a held expansion state for a node/edge context, not a
  normal leaf;
- removed parent-child relationships become inactive without deleting prior
  operator history.

## Key-scheme boundary

The node/edge model is internal to the snapshot/diff layer in this pilot.

It must not automatically change the flat stock-preparation target
`idempotencyKey` scheme. Edge identity as a future row key would be a migration
event for already-applied rows and must be a separate explicit decision.

For #2388 v1:

- target rows stay flat;
- the current planner/writer key behavior remains unchanged;
- D3 surgical duplicate keys remain the only approved duplicate key extension;
- snapshot edge identity can be used for diff/evidence, not for silent target
  re-keying.

## SourceDiffResult contract

Generic categories:

| Category | Meaning | Default policy |
|---|---|---|
| `added` | Present in latest snapshot, absent from last applied snapshot. | review/add if complete |
| `removed` | Present in last applied snapshot, absent from latest snapshot. | mark inactive, never delete |
| `changed` | Source-owned fields changed. | review/update source-owned fields |
| `unchanged` | No source-owned change. | skip |
| `source_incomplete` | Latest source cannot prove completeness. | hold |
| `duplicate_conflict` | Source rows collide without safe policy. | hold |
| `manual_field_conflict` | Would affect human-owned fields. | hold/protect |
| `schema_changed` | Source shape/read plan changed unexpectedly. | hold |

PLM-BOM domain extensions:

- `added_rows`;
- `removed_from_latest_snapshot`;
- `quantity_changed`;
- `hierarchy_changed`;
- `source_fields_completed`;
- `source_fields_changed`;
- `missing_child_bom`;
- `manual_fields_protected`;
- `held_conflicts`.

Public evidence shape:

```json
{
  "snapshotDiffPresent": true,
  "latestSnapshotPresent": true,
  "lastAppliedSnapshotPresent": true,
  "counts": {
    "added_rows": 0,
    "removed_from_latest_snapshot": 0,
    "quantity_changed": 0,
    "hierarchy_changed": 0,
    "source_fields_completed": 0,
    "source_fields_changed": 0,
    "missing_child_bom": 0,
    "manual_fields_protected": 0,
    "held_conflicts": 0
  },
  "applyBlockedReasons": []
}
```

The private diff may include row/node/edge values. Public evidence must not.

## `missing_child_bom` contract

`missing_child_bom` requires a source signal that a component should have
children.

Accepted signal shapes are read-plan/domain-specific, for example:

- `isAssembly`;
- `hasBom`;
- expected child count;
- expected BOM marker;
- source lifecycle state that explicitly says child BOM should exist.

If the signal says "should have child BOM" and the child BOM head/details are
missing or empty, the snapshot/diff must emit `missing_child_bom` and hold that
branch. It must not treat the component as a complete leaf.

If the signal is unavailable or ambiguous, v1 must fail closed for that branch
with a values-free held reason such as `missing_child_signal_unavailable` or
`missing_child_signal_ambiguous`. It must not guess that the component is a
leaf merely because no child rows were found.

If the signal says the component is a leaf, childless is valid and no
`missing_child_bom` is emitted.

Acceptance lock:

```text
childless component + explicit leaf signal -> complete leaf
childless component + explicit assembly/has-BOM signal -> missing_child_bom held
childless component + no usable signal -> held, not complete leaf
```

This is the part of #2388 most tightly coupled to #2342 C3 background
expansion. Large background expansion must not produce authoritative "complete"
artifacts for a data set whose incomplete-assembly semantics are unresolved.

## Policy defaults

Default category behavior:

- `added_rows`: add only after fresh dry-run and policy review.
- `removed_from_latest_snapshot`: mark inactive, never delete.
- `quantity_changed`: review; update source-owned quantity only when complete.
- `hierarchy_changed`: review; do not silently re-key existing target rows.
- `source_fields_completed`: update source-owned fields; human fields preserve.
- `source_fields_changed`: review/update source-owned fields; human fields
  preserve.
- `missing_child_bom`: hold; no downstream demand Apply for that branch.
- `manual_fields_protected`: hold/protect; never overwrite by default.
- `held_conflicts`: hold until the relevant D4/source policy is reviewed.

Manual/human fields remain protected by default. No snapshot/diff policy may
silently overwrite stock-preparation, purchase, warehouse, or operator-entered
fields.

## Apply gate

Apply must be based on a fresh dry-run against the current snapshot/diff result.

The future apply token/revision must bind at least:

- action id;
- parameters hash;
- latest snapshot id/revision;
- last applied snapshot id/revision;
- source diff revision;
- conflict plan revision;
- duplicate policy review revision when present;
- target binding revision;
- owner approval/confirmation flags required by policy.

Browser input must not supply:

- snapshot payloads;
- source/target binding;
- sheet id or field id;
- diff result;
- conflict plan;
- Apply payload;
- raw SQL or query body.

After a successful Apply, the applied snapshot id becomes the new last-applied
snapshot baseline only for the categories actually accepted by policy. Held
branches must remain held and must not be silently marked as applied.

## Relationship to existing tracks

### Relationship to #2253 C2/C3/C4

The existing pull-vs-target planner remains the write planner. #2388 adds
pull-vs-pull source-diff evidence before the planner/write gate.

The current mark-inactive, human-field protection, and dry-run token behavior
remain invariants.

### Relationship to #2343 duplicate handling

Duplicate-expanded-key policy remains separate.

#2388's node/edge model explains why duplicate-expanded-key collisions happen,
but it must not silently choose a duplicate policy. D4 remains the place for
`source_correction_required`, `select_representative`, `skip_selected`,
`merge_quantity`, or future duplicate decisions.

### Relationship to #2342 large BOM

C3 background expansion can produce authoritative source snapshots only when the
source is complete. If large-BOM expansion is bounded, duplicate/lifecycle diff
counts are subset-only. If missing-child semantics are unresolved, large-BOM
background completion must not imply a complete source snapshot for production
rollout.

### Relationship to generic Data Factory sync

The generic seam is intentionally narrow in this C0. Implementing a reusable
cross-source snapshot-diff framework is deferred until a second real source
needs the same capability.

## Future decomposition

### C1 - snapshot contract + invariant verification

- Add latent source snapshot data contracts/helpers.
- Verify existing invariants: mark-inactive, human-field protection, fresh
  dry-run token.
- No route/UI/write.

### C2 - PLM node/edge snapshot builder

- Build private `ComponentNode` + `BomEdge` snapshots from the PLM expansion
  inputs.
- Preserve source values privately and public values-free evidence separately.
- No Apply.

### C3 - `missing_child_bom` detection

- Add read-plan support for explicit leaf/assembly/has-BOM signal.
- Hold missing/ambiguous child-BOM branches.
- Prove childless assembly is not treated as a complete leaf.

### C4 - snapshot diff + policy mapping

- Diff latest snapshot against last applied snapshot.
- Produce values-free category counts.
- Keep apply blocked for held/source-incomplete categories.

### C5 - dry-run/apply gate integration

- Bind dry-run/apply token to snapshot/diff revision.
- Persist last applied snapshot only after accepted Apply.
- No client-supplied snapshot/diff/plan/payload.

### C6 - entity-machine validation

- Validate a lifecycle sample:
  - added edge;
  - removed edge -> inactive;
  - quantity changed;
  - hierarchy changed;
  - source fields completed;
  - missing child BOM held;
  - manual fields preserved;
  - fresh token required.

Each slice is a separate explicit opt-in.

## Acceptance locks for this C0

- Docs-only.
- No runtime, route, UI, migration, package, worker, MetaSheet write, PLM
  write, external database write, K3, raw SQL, or production rollout.
- Do not rebuild shipped invariants; verify them in future tests.
- Generic `SourceSnapshot` / `SourceDiffResult` seams are designed, but the
  first implementation is PLM-BOM only.
- Private snapshots may store PLM values; public evidence is values-free.
- Snapshot diff baseline is latest pull vs last applied snapshot, distinct from
  the existing pull-vs-target planner.
- PLM snapshot internals use `ComponentNode` + `BomEdge`.
- Node/edge identity must not silently migrate the flat target
  `idempotencyKey` scheme.
- `missing_child_bom` requires an explicit source signal; missing or ambiguous
  signal fails closed.
- Missing child BOM branches are held and do not generate downstream demand
  Apply.
- Removed source relationships are marked inactive, not deleted.
- Human-owned fields remain protected by default.
- Apply requires a fresh snapshot/diff-bound dry-run token.
- No silent delete, silent merge, silent keep-first, silent re-key, or silent
  incomplete-leaf behavior.
