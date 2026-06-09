# Data Factory PLM Stock Preparation Source Snapshot Diff C0 Design - 2026-06-08

## Purpose

Define the C0 contract for issue #2388: before a PLM stock-preparation refresh
can become an incremental Apply, Data Factory must create a source snapshot,
diff it against the last applied source snapshot, classify lifecycle risk, and
require a fresh dry-run/apply gate.

This is design-only. It adds no runtime helper, route, UI, migration, package,
MetaSheet write, PLM write, external database write, raw SQL path, K3 path, or
production rollout.

## Scope Split

### Already-Shipped Invariants To Verify

These are already enforced by the #2253 stock-preparation path and must be
verified when #2388 runtime lands. They are not rebuilt by this track:

- source-missing rows are planned as `inactive`, not physically deleted
  (`missingFromPlmPolicy=mark_inactive`);
- human-owned fields are omitted from PLM refresh payloads and guarded by
  `assertNoHumanFields`;
- Apply requires a server-generated dry-run token and revision match.

### New #2388 Scope

The genuinely new work is:

- private in-tenant `SourceSnapshot` storage for each PLM pull;
- `SourceDiffResult`: latest source snapshot vs last applied source snapshot;
- `missing_child_bom` detection and held behavior;
- values-free public evidence for the snapshot/diff gate;
- a PLM-BOM pilot over generic seams.

## Generic Seam, PLM Pilot

Design the reusable contract, but implement only the PLM-BOM pilot first.

Generic seam:

```text
external source read
  -> SourceSnapshot
  -> SourceDiffResult
  -> category policy / owner review
  -> fresh dry-run token
  -> incremental Apply
```

Generic model names:

- `SourceSnapshot`;
- `SourceDiffResult`;
- `SourceDiffCategory`;
- `SourceDiffPolicy`.

Generic categories:

- `added`;
- `removed`;
- `changed`;
- `unchanged`;
- `source_incomplete`;
- `duplicate_conflict`;
- `manual_field_conflict`;
- `schema_changed`.

PLM-BOM domain extensions:

- `hierarchy_changed`;
- `quantity_changed`;
- `removed_from_latest_snapshot`;
- `source_fields_completed`;
- `source_fields_changed`;
- `missing_child_bom`;
- `manual_fields_protected`;
- `held_conflicts`.

Full cross-source generalization is deferred until a second real source needs
the same gate. Do not build ERP/SRM/CRM/HR/generic-SQL sync abstractions from
the PLM case alone.

## Private Snapshot / Public Evidence Split

The private snapshot must contain enough in-tenant structure to diff correctly:

- component identity;
- parent-child edge identity;
- quantities;
- hierarchy/path context;
- source revision markers when available;
- source completeness markers;
- row/edge status.

Public evidence must remain values-free:

- snapshot id presence, not raw snapshot payload;
- row/edge/node counts;
- safe hashes or deterministic fingerprints;
- category counts;
- policy names;
- held reason tokens;
- error codes.

Public evidence must not expose project number, component code/name/source id,
parent/path/idempotency key, PLM row payload, source detail id, target sheet id,
field id, raw SQL, credentials, tokens, connection strings, or stack traces
containing business values.

## PLM BOM Node / Edge Snapshot Model

The snapshot layer uses a graph-shaped model internally:

### `ComponentNode`

Represents component/material identity and source-owned attributes:

- source component id;
- component code/name/material/source version;
- source revision markers when available;
- source completeness markers;
- assembly/has-BOM/expected-child marker when available.

### `BomEdge` / `BomLine`

Represents parent-child usage:

- parent component id;
- child component id;
- quantity on that edge;
- sort/order/line marker when available;
- hierarchy/path context;
- source snapshot id;
- active/held/inactive state.

Quantity changes belong to the edge. Hierarchy changes are edge changes. The
same component under multiple parents is not automatically a duplicate
component.

This node/edge model is for the snapshot/diff layer only. It must not migrate
the existing flat target-table idempotency key in this pilot. The apply path
continues to map each reviewed edge into the existing flat stock-preparation
row model.

## Snapshot Baselines

The snapshot diff baseline is latest source pull vs last applied source
snapshot.

This is different from the existing C3 planner baseline:

- snapshot diff: "how did the source change since the last applied source
  snapshot?";
- C3 plan: "what writes would bring the target table in line with the current
  expanded source and policies?".

Both are required. They must not be conflated.

## `missing_child_bom`

`missing_child_bom` is the load-bearing PLM-specific category.

Today a childless component can look like a leaf. #2388 requires distinguishing
a true leaf from an incomplete assembly. The pilot must use an explicit PLM
signal, for example:

- `isAssembly`;
- `hasBom`;
- expected-child marker;
- equivalent customer-confirmed PLM field.

If the signal says a component should have children but the child BOM is not
available, the branch is held as `missing_child_bom`.

If the signal is unavailable or ambiguous for a component that may be an
assembly, the pilot must fail closed with a values-free held reason. It must
not assume a complete leaf.

`missing_child_bom` is the part of #2388 that must be resolved before large
background expansion (#2342 C3/C4) becomes authoritative at scale. Without it,
a large expansion can incorrectly treat incomplete assemblies as complete leaf
demands.

## Diff Categories And Defaults

| Category | Default policy | Write posture |
|---|---|---|
| `added` | review under current C3 policy | add only after fresh dry-run/apply gate |
| `removed_from_latest_snapshot` | mark inactive | patch existing row `active=false`, never delete |
| `quantity_changed` | require review | update source-owned quantity fields only after review |
| `hierarchy_changed` | require review | hold or update edge-derived row after review |
| `source_fields_completed` | safe source-owned refresh | update source-owned fields only |
| `source_fields_changed` | require review if downstream demand changes | update source-owned fields only after review |
| `missing_child_bom` | hold | no downstream Apply for that branch |
| `manual_fields_protected` | preserve | never overwrite human-owned fields |
| `held_conflicts` | hold | no write for held rows |

`source_fields_completed` is distinct from a blind overwrite: it may fill
source-owned fields that were previously missing, but it still must preserve
human-owned fields and must use the fresh dry-run token/revision gate.

## Apply Gate

Every Apply must be bound to:

- the latest source snapshot id;
- the diff result / policy review;
- target table revision inputs used by the current C3 planner;
- the existing dry-run token / revision check.

If a newer source snapshot exists after the operator reviewed an older dry-run,
Apply fails closed and requires a fresh dry-run.

The browser must not send snapshot payloads, diff payloads, target sheet ids,
field maps, plans, or write payloads. The server recomputes/loads trusted
state.

## Relationship To Existing Tracks

- #2343 duplicates: separate. Duplicate strategy remains driven by
  `duplicate_expanded_key` evidence. Node/edge snapshots explain duplicate
  causes but do not change duplicate policy execution in this C0.
- #2342 large BOM: background expansion/checkpointed apply should consume the
  #2388 missing-child semantics before treating a large expansion as
  authoritative. If #2342 must proceed first as an emergency, it still needs a
  minimal fail-closed incomplete-assembly guard.
- C3/C4 existing planner/writer: keep mark-inactive, human-field protection,
  find-then-patch, manual-confirm holds, and dry-run token/revision binding.

## Decomposition

### #2388 C1 - Snapshot model + invariant verification

- Add private in-tenant snapshot storage contract / helper.
- Verify shipped invariants: mark inactive, manual-field protection, fresh
  token/revision.
- No diff policy execution yet.

### #2388 C2 - PLM-BOM snapshot builder

- Convert current expanded PLM pull into `ComponentNode` + `BomEdge` snapshot
  records.
- Keep public evidence values-free.
- Do not change flat apply keys.

### #2388 C3 - Snapshot diff + category evidence

- Diff latest snapshot vs last applied snapshot.
- Emit category counts and safe fingerprints.
- Keep write behavior unchanged.

### #2388 C4 - `missing_child_bom` held branch

- Require explicit PLM assembly/expected-child signal.
- Hold incomplete branches with `missing_child_bom`.
- Ensure downstream quantity propagation does not treat held branches as
  complete leaf demand.

### #2388 C5 - Apply gate integration

- Bind Apply to the latest snapshot/diff result plus existing dry-run token.
- Reject stale snapshot/diff review.
- Keep write behavior scoped to existing C3/C4 decisions.

### Later Genericization

Only after a second real source needs the same pattern, extract the generic
Source Snapshot Diff Gate beyond PLM-BOM.

## Acceptance Locks

- C0 is docs-only.
- Do not add runtime, route, UI, migration, package, snapshot storage, PLM
  write, external DB write, raw SQL, K3, or production rollout.
- Do not rebuild shipped invariants; verify them in future runtime slices.
- The snapshot layer stores private in-tenant structure; public evidence is
  values-free.
- Node/edge identity is internal to snapshot/diff. It must not migrate the
  flat target idempotency key in this pilot.
- `missing_child_bom` requires an explicit PLM signal or fails closed.
- Source snapshot diff and C3 target-table plan remain distinct.
- Removed source rows become inactive, never physically deleted.
- Human-owned fields remain protected by default.
- Apply always requires a fresh server dry-run token/revision and current
  snapshot/diff review.
