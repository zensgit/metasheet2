# Data Factory PLM project BOM -> stock-preparation - execution plan + gated TODO (2026-06-04)

> Companion to
> `data-factory-plm-project-bom-stock-preparation-design-20260604.md`.
> This file is the trackable execution ladder for issue #2253. It is **not**
> an authorization to implement runtime.
>
> Markers: ✅ done · ⬜ open / ready (still needs its own opt-in) · 🔒 gated
> (blocked on a prior gate and a separate explicit opt-in).

## Non-negotiables

- No raw SQL and no user-authored SQL.
- Source is `data-source:sql-readonly` in v1.
- Project match is single `projectNo` exact on `FileCode`.
- Apply writes MetaSheet stock-preparation main table only.
- No external database write.
- No K3 Save / Submit / Audit / BOM.
- Human-owned fields preserve by default.
- PLM-missing rows mark inactive; no default delete.
- Issue/customer evidence stays values-free.
- Every phase is a separate named opt-in; never auto-start the next slice.

## Relationship to the datasource bridge track

#2250 / #2254 datasource bridge smoke and packaging can continue in parallel.
That track proves the generic SQL source is deployable. This #2253 ladder starts
only the downstream business action that consumes the source. A bridge smoke
regression blocks #2253 runtime, but it does not change the C0 design scope.

## Current #2253 v1 boundary

| Question | Locked answer |
|---|---|
| PLM source | `data-source:sql-readonly` / readonly SQL source. |
| Query | Parameterized `projectNo`; no raw SQL. |
| Match | Single exact `FileCode = projectNo`; no fuzzy/prefix/batch. |
| No-hit | Dry-run `0 rows` + not-found summary; no project row write. |
| Identity | `projectNo + componentSourceId(OBJ_ID) + parentSourceId/path`. |
| Same component under different parent | Keep as separate BOM rows. |
| Expansion | Recursive quantity multiplication; keep raw qty, total qty, depth, path. |
| Guards | `maxDepth`, `maxRows`, cycle guard fail closed. |
| Target | Stock-preparation main table only in v1. |
| Procurement/warehouse | Views or later slices, not separate v1 tables. |
| Conflict default | Add missing, refresh PLM/system fields, preserve human fields, skip/mark duplicates, inactive not delete. |
| Permissions | Dry-run read/source-read; apply write/admin. |
| Boundary | MetaSheet write only; no K3. |
| Scale | Dozens to thousands of rows; threshold overflow fails closed or moves to later background/paged execution. |

## Phase ladder

### ✅ C0 - Design + TODO (DONE - PR #2258, `313a31d31`)

Docs-only.

- [x] Lock v1 source/match/identity/target/conflict/permission boundaries from #2253.
- [x] Define table model ownership classes: PLM/system-owned vs human-owned fields.
- [x] Define recursive expansion contract and fail-closed guards.
- [x] Define dry-run evidence shape and values-free issue evidence rule.
- [x] Decompose implementation into C1-C6.
- [x] Review/accept C0 before any runtime starts.

Definition of done:

- Docs-only diff.
- No runtime, route, migration, UI, package, or K3 change.
- #2253 linked from the PR.

### 🟡 C1 - Stock-preparation table template / field model manifest (this PR)

Gated on: C0 accepted + explicit opt-in.

Scope:

- Confirm the BOM-read feasibility gate: recursive BOM must be reachable
  through flat, parameterized readonly SQL reads that the app can expand. If it
  requires a recursive CTE, stored procedure, or vendor API, pause this v1 and
  pivot to a customer-provided flat BOM view or the deferred PLM adapter/API
  track.
- Add schema-only manifest(s) for the stock-preparation main table.
- Pin exact PLM/system-owned field list.
- Pin exact human-owned preserve whitelist.
- Define select/dropdown fields that later C6 syncs from `config_info`.
- No PLM read.
- No MetaSheet write.
- No UI.

Acceptance locks:

- Field ownership is explicit; unclassified field = fail closed in later planner.
- BOM-read feasibility is confirmed without raw SQL or stored-procedure calls.
- Manifest contains idempotency key fields.
- Manifest contains run/decision/conflict fields.
- Procurement/warehouse stay views or deferred; no child-table generation.

Implementation note: C1 does **not** claim live PLM feasibility is already
confirmed, because the customer PLM table/view and relation descriptors are not
available in this repo. Instead, this slice turns the feasibility gate into a
schema-only contract (`requires_customer_schema`) that C2 must satisfy before
runtime can proceed.

### 🔒 C2 - `projectNo -> PLM BOM` dry-run expansion helper

Gated on: C1 + explicit opt-in.

Scope:

- Build a pure or service-layer helper that reads through `data-source:sql-readonly`.
- Accept parameterized `projectNo`.
- Match exact `FileCode`.
- Expand recursive BOM rows into normalized logical rows.
- No MetaSheet write.

Acceptance locks:

- Blank `projectNo` rejects.
- No-hit returns `0 rows` + not-found summary.
- Recursive quantity multiplication preserves raw quantity and total quantity.
- Same component under different parents produces distinct rows.
- Idempotency key includes project number, component source id, and parent/path.
- `maxDepth`, `maxRows`, and cycle guard fail closed.
- No raw SQL is accepted; read plan is configured/known.
- Values-free dry-run summary can be emitted.

### 🔒 C3 - Conflict planner

Gated on: C2 + explicit opt-in.

Scope:

- Compare expanded rows with existing stock-preparation rows.
- Compute decisions: `add`, `update`, `skip`, `inactive`, `manual_confirm`.
- Preserve human-owned fields.
- No write.

Acceptance locks:

- PLM/system fields refresh only in `add/update`.
- Human-owned fields are preserved by whitelist.
- Duplicate/conflicting rows never pick-first silently.
- PLM-missing existing rows become `inactive`, not deleted.
- Dry-run counts include add/update/skip/inactive/manual-confirm.
- Planner output includes run id, decision, conflict summary shape for C4.

### 🔒 C4 - Apply writer to stock-preparation main table

Gated on: C3 + explicit opt-in.

Scope:

- Apply an accepted plan to the MetaSheet stock-preparation main table.
- Use keyed create/patch by idempotency key.
- Record run id, decision, and conflict summary.
- No external database write.
- No K3 write.

Acceptance locks:

- Apply requires Data Factory write/admin.
- Apply writes only configured MetaSheet object(s).
- Human-owned fields are not overwritten.
- Inactive marking patches status/active fields; no delete.
- Partial failure is reported with row-level decisions.
- Re-running the same accepted plan is idempotent.

### 🔒 C5 - Workbench UI action

Gated on: C4 + explicit opt-in.

Scope:

- Add a named PLM project BOM stock-preparation action in the workbench.
- Operator enters `projectNo`.
- UI shows dry-run summary and conflict counts.
- Apply confirmation calls C4 only when allowed.

Acceptance locks:

- No raw SQL textarea.
- Dry-run and apply permissions are visibly separated.
- Values shown in the tenant UI are not copied to issue evidence.
- No K3 button/action is introduced.
- No batch/multi-project mode in v1.

### 🔒 C6 - `config_info` -> select/dropdown option sync

Gated on: C5 + explicit opt-in.

Scope:

- Sync selected option sets used by stock-preparation fields.
- Keep options aligned for fields such as material type / blank type / status.
- This is MetaSheet configuration sync only.

Acceptance locks:

- No PLM write.
- No K3 write.
- Option evidence is values-free when posted to issues.
- Missing/ambiguous option mapping fails closed.

## Deferred tracks

- PLM adapter/API source instead of readonly SQL.
- Fuzzy/prefix/multi-project matching.
- Procurement/warehouse child-table generation.
- Background/paged execution for very large BOMs.
- SQL bridge C3 watermark/incremental implementation.
- External DB write.
- K3 Save / Submit / Audit / BOM.

## Open details to confirm in C1/C2

These are not blockers for C0, but they must be pinned before runtime:

- **Feasibility gate:** exact PLM table/view object and relation descriptors
  must support app-side recursion over flat parameterized reads. If not, pivot
  to a flat customer BOM view or deferred PLM adapter/API.
- Exact PLM source id column when `OBJ_ID` is absent or aliased.
- Exact parent/child relation columns.
- Default `maxDepth` and `maxRows` values.
- Exact stock-preparation field ids and labels.
- Exact human-owned preserve whitelist.
- Exact `config_info` option source and target fields.
- Which critical conflicts require manual confirmation in v1.

## Sequencing rule

C0 must be reviewed before C1 starts. After C0, the next buildable slice is
C1 (schema-only stock-preparation field model manifest). C2-C6 remain locked
until their predecessor lands and the owner explicitly opts in.
