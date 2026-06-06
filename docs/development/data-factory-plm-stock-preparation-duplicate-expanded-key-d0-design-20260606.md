# Data Factory #2343 D0 - duplicate-expanded-key handling design (2026-06-06)

## Scope

This is a design-only slice for issue #2343. It defines how the PLM
stock-preparation action should diagnose and resolve `duplicate_expanded_key`
rows after #2340 proved the clean-row path:

- fresh dry-run produced `rowsExpanded=246`;
- `add=190` rows were applied once with explicit owner approval;
- `manual_confirm=28` duplicate rows stayed held;
- post-apply dry-run showed `add=0`, `skip=190`, `manual_confirm=28`.

This slice does not add runtime, routes, UI, package changes, PLM reads,
MetaSheet writes, external database writes, K3 actions, or another apply.

## Current behavior

C3 already fails closed for duplicate expanded keys:

- duplicate expanded rows are excluded from `add/update/skip`;
- they become `manual_confirm`;
- clean rows can still apply when the owner explicitly accepts
  `manual_confirm` hold;
- C4 never silently picks, merges, or writes the duplicate rows.

So #2343 is not a silent-write bug. It is a policy and operator-review gap.

## General conflict-strategy frame

The immediate use case is `duplicate_expanded_key`, but the design should use a
generic conflict-strategy envelope so later manual-confirm classes can reuse the
same review/apply machinery.

First supported conflict type:

```text
duplicate_expanded_key
```

Likely later conflict types:

- duplicate target key;
- missing required lineage;
- ambiguous source match;
- incompatible human/system field ownership;
- row-level C2 validation errors;
- large-BOM bounded-preview conflicts after #2342 defines that path.

The generic envelope should carry:

- `conflictType`;
- values-free `diagnostics`;
- allowed `policies`;
- selected `policy`;
- `scope`;
- approval metadata;
- dry-run revision/token binding;
- values-free result counts.

The resolver implementation should stay type-specific. Do not generalize so far
that a policy safe for one conflict type silently applies to another.

## Policy scope

Operators/admins should be able to choose how long a conflict policy applies.
D0 locks two initial scopes:

1. **`run_only`**: applies only to the current dry-run revision/token. This is
   the safest default and is required for first-time handling.
2. **`table_scope`**: applies to the current action plus target table/object.
   This is appropriate only after the owner confirms the table's row identity and
   expected duplicate semantics.

Deferred scope:

- `template_default` / global defaults. These are intentionally not v1 because
  row identity differs across tables and actions. A global default can turn a
  safe duplicate policy in one table into an unsafe silent merge/drop in another.

Scope rules:

- `run_only` policies must not persist after token/revision expiry.
- `table_scope` policies must be admin/owner-approved, auditable, and revocable.
- Policy lookup must include action id and target object/table identity.
- Policy application must still rerun a fresh dry-run; stored policy never means
  "apply without review".
- Public evidence may show policy name and scope, never row values or raw keys.

## First D0 gate: values-free duplicate cause diagnosis

`duplicate_expanded_key` has at least two very different causes:

1. **Cross-parent reuse**: the same component appears under different parent
   assemblies or BOM paths. These are usually real position-specific
   preparation needs. The likely policy is `keep_multiple_rows` with a more
   granular idempotency key.
2. **Same-parent true duplicate**: the source carries repeated detail lines in
   the same parent/path context. The likely policy is `merge_quantity`,
   `skip_selected`, or source correction.

D0 must require a values-free diagnostic summary before choosing a policy:

- collided group count;
- rows-per-group distribution;
- same-parent vs cross-parent group counts;
- attribute-consistency counts, for example whether unit/material/version fields
  are equal within the group;
- quantity-shape counts, not raw quantities;
- count of groups that have a stable source detail discriminator available.

Issue/customer evidence must not expose raw idempotency keys, project numbers,
component ids, parent ids, paths, quantities, materials, PLM row values, target
row values, request payloads, source ids, sheet ids, field ids, target bindings,
credentials, or Bridge secrets. In public evidence, duplicate groups should be
identified only by ordinal or values-free group tokens. Authorized tenant UI may
show business values to the operator.

## Legacy row model is the source of truth

#2253 is replacing a legacy stock-preparation workflow, not inventing a new
inventory-planning model. D0 must confirm the legacy stock-preparation main-table
row identity before changing keys.

The existing v1 manifest already carries `parentSourceId`, `path`,
`componentSourceId`, and `totalQuantity`; the original issue context also points
to a parent-component field in the legacy table. That strongly suggests a
per-position row model:

```text
project + parent/path position + component + position demand
```

If the legacy system treats the same component under different parents as
different preparation rows, the product should preserve that identity. A
collapse-to-one merge would be a semantic change and needs explicit owner
approval.

## Quantity semantics

C2 computes:

```text
totalQuantity = parent.totalQuantity * edgeQuantity
```

That is a path-cumulative quantity.

Policy implications:

- `keep_multiple_rows`: each row keeps its own position-specific
  `totalQuantity`.
- `merge_quantity`: the merged row's quantity is the sum of all path quantities
  in the accepted group.
- `select_representative`: only one source line contributes quantity; the
  skipped demand must be explicitly recorded because this can under-prepare
  stock.
- `skip_selected`: skipped rows are intentionally not prepared; this is never a
  silent default.

No policy may pick the first row's quantity silently.

## Supported policy candidates

### 1. `hold` - keep manual confirmation

Default fail-closed state. No duplicate row is written. This remains the fallback
when D0 cannot prove a safe resolution.

### 2. `keep_multiple_rows` - operator-facing "show all"

Preserve every duplicate row as a separate stock-preparation row by adding a
stable discriminator to the idempotency key.

Allowed discriminators, in priority order:

1. source-native detail row id, if stable;
2. BOM path plus parent context;
3. source detail sort line only when stable and scoped by parent/path;
4. another owner-reviewed source-native line identity.

Not allowed:

- material/component code alone;
- display name;
- unstable list index without source context;
- random id generated per run.

This is the likely default for cross-parent reuse and legacy per-position row
models.

### 3. `merge_quantity`

Merge duplicate rows into one preparation row only when the group is same-parent
or owner-confirmed mergeable, and key business attributes match.

Minimum merge checks:

- same parent/path context, or explicit owner acceptance;
- same component identity;
- compatible unit/material/version attributes;
- quantity rule = sum of path quantities;
- evidence records merged group count and merged row count, values-free.

### 4. `select_representative` - operator-facing "replace / choose one"

Choose exactly one duplicate row to represent the group. This is risky because it
drops the other demands. It should be allowed only as an explicit operator
decision with a reason, and the skipped rows remain visible in evidence counts.

This policy should not be the default.

### 5. `skip_selected` - operator-facing "ignore selected"

Skip selected duplicate rows. This must be explicit, recorded, and reversible in
the sense that the next dry-run still exposes what was skipped unless a durable
policy says otherwise.

Silent skip is forbidden. In stock preparation, silently dropping a duplicate can
mean under-preparation.

### 6. `source_correction_required`

Block apply for the duplicate group and ask the operator/customer to correct PLM
source data or the read-plan/key mapping.

This is the safest answer when D0 cannot determine whether a group is
cross-parent reuse, same-parent duplicate, or bad source data.

## UI / operator contract

The first UI should be a grouped duplicate review, not a raw row dump.

For each duplicate group, show in-tenant:

- group size;
- whether parent/path contexts differ;
- whether key stock-preparation attributes match;
- quantity summary;
- recommended policy;
- policy selector.

Public issue evidence stays values-free:

- duplicate group count;
- rows-per-group distribution;
- policy counts;
- skipped/merged/kept/blocked counts;
- conflict types;
- no raw values.

## Apply contract

Duplicate-resolution apply is a later slice. D0 only locks the contract:

- rerun a fresh dry-run before applying resolved duplicate rows;
- use a fresh dry-run token;
- apply only owner-approved policies;
- keep unresolved groups held;
- never retry automatically;
- preserve already-written clean rows idempotently;
- report values-free results by policy and status.

## Relationship to #2342 large-BOM strategy

Duplicate analysis is authoritative only on a complete expansion
(`status=expanded`). If a run hits `max_rows_exceeded`, C3 sees only the bounded
subset and duplicate counts are not authoritative for the whole BOM.

Therefore:

- the #2340 28 held rows can proceed through #2343 because that sample completed
  expansion below the cap;
- capped large-BOM samples must go through #2342 before their duplicate analysis
  is considered authoritative.

For a 20,000-row BOM, the intended direction is not to render every row in the
normal workbench panel or allow synchronous one-click apply. The large-BOM path
should show a bounded/virtualized summary and keep apply disabled until a
separate large-BOM strategy approves full expansion and a checkpointed writer.

## Completion criteria

D0 is complete when it locks:

- values-free duplicate-cause diagnostic shape;
- legacy row identity confirmation as a hard input;
- selected policy vocabulary and defaults;
- totalQuantity semantics for keep vs merge;
- no silent pick;
- no silent drop;
- no material-code-only identity;
- fresh-dry-run/fresh-token apply precondition for any future duplicate apply;
- separation from #2342 large-BOM handling.

## Boundaries

- No apply for the #2340 held rows in D0.
- No production rollout.
- No batch/multi-project mode.
- No K3 Save / Submit / Audit / BOM.
- No PLM or external database write.
- No raw SQL, CTE, stored procedure, or vendor API escape hatch.
- No automatic retry loops.
