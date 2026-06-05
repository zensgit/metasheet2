# Data Factory PLM project BOM -> stock-preparation - execution plan + gated TODO (2026-06-04)

> Companion to
> `data-factory-plm-project-bom-stock-preparation-design-20260604.md`.
> This file is the trackable execution ladder for issue #2253. It is **not**
> an authorization to implement runtime.
>
> Markers: ✅ done · 🟡 in design / active review · ⬜ open / ready (still
> needs its own opt-in) · 🔒 gated (blocked on a prior gate and a separate
> explicit opt-in).

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

### ✅ C1 - Stock-preparation table template / field model manifest (DONE - PR #2260, `3ffe6f32c`)

Gated on: C0 accepted + explicit opt-in. Done in #2260.

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

### ✅ C2-0 - Filtered readonly SQL bridge for PLM lookups (DONE - PR #2265, `2be099bd8`)

Gated on: C1 + explicit opt-in.

Scope:

- Thread `read.filters` through `data-source:sql-readonly` as structured
  `where` filters.
- Keep filters equality-only: string / number / boolean / null.
- No raw SQL, joins, stored procedures, operator objects, arrays, UI, PLM BOM
  expansion, MetaSheet write, or K3.

Acceptance locks:

- `FileCode` / parent-id filters reach `DataSourceManager.select(..., { where })`.
- Invalid structured filters fail closed before any data-source read.
- Existing offset pagination remains unchanged.

### ✅ C2 - `projectNo -> PLM BOM` dry-run expansion helper (DONE - PR #2268, `2e41927c9`)

Gated on: C2-0 + confirmed customer PLM relation descriptors + explicit opt-in.

Scope:

- Build a pure or service-layer helper that reads through `data-source:sql-readonly`.
- Accept parameterized `projectNo`.
- Match exact `FileCode`.
- Expand recursive BOM rows into normalized logical rows.
- No MetaSheet write.
- Use the #2253 relation candidate as the default read plan:
  - project path: `DN_PDM_PathExAttrInfo.FileCode` ->
    `DN_PDM_PathExAttrInfo.Parent_OBJ_ID` ->
    `DN_PDM_PathInfo.OBJ_ID`;
  - root BOM: `DN_PDM_OrderHeadInfo.path_id` ->
    `DN_PDM_OrderHeadInfo.OBJ_ID` ->
    `DN_PDM_OrderDetailInfo.order_id`;
  - component lookup: `DN_PDM_OrderDetailInfo.part_id` /
    `DN_PDM_BomDetailsInfo.part_id` ->
    `DN_PDM_PartLibraryInfo.OBJ_ID`;
  - child recursion: `DN_PDM_BomHeadInfo.part_id` +
    optional `DN_PDM_BomHeadInfo.SysVer` ->
    `DN_PDM_BomHeadInfo.bom_id` ->
    `DN_PDM_BomDetailsInfo.bom_pid`;
  - quantity fields: root `DN_PDM_OrderDetailInfo.quantity`, child
    `DN_PDM_BomDetailsInfo.Bom_ExAttr1`;
  - display fields: `IdentityNo`, `IdentityName`, `Material`, `SysVer`.

Acceptance locks:

- Blank `projectNo` rejects.
- No-hit returns `0 rows` + not-found summary.
- Recursive quantity multiplication preserves raw quantity and total quantity.
- Same component under different parents produces distinct rows.
- Idempotency key includes project number, component source id, and parent/path.
- `maxDepth`, `maxRows`, and cycle guard fail closed.
- No raw SQL / joins / stored procedures / vendor API calls are accepted; the
  read plan is object + equality-filter only.
- Values-free dry-run summary can be emitted.
- Conflict actions are not computed in C2; `candidateRows` is exposed and C3 is
  still responsible for `add/update/skip/inactive/manual_confirm`.

### ✅ C3 - Conflict planner (DONE - PR #2269, `e0e3ffe30`; hardening #2271, `734893342`)

Gated on: C2 + explicit opt-in.

Scope:

- Compare expanded rows with existing stock-preparation rows.
- Compute decisions: `add`, `update`, `skip`, `inactive`, `manual_confirm`.
- Preserve human-owned fields.
- No write.
- Accept C2 `expandedRows`, existing stock-preparation rows, and C2
  `rowErrors`.
- Produce a write-free plan for C4 with per-row decision records and counts.

Acceptance locks:

- PLM/system fields refresh only in `add/update`.
- Human-owned fields are preserved by whitelist.
- Duplicate/conflicting rows never pick-first silently.
- PLM-missing existing rows become `inactive`, not deleted.
- Dry-run counts include add/update/skip/inactive/manual-confirm.
- Planner output includes run id, decision, conflict summary shape for C4.
- C2 `rowErrors` are planned as `manual_confirm` while valid expanded rows are
  still eligible for add/update/skip planning; one bad row must not abort the
  whole conflict plan.
- `add`, `update`, and `inactive` payloads never include human-preserved fields.
- Unsupported conflict strategies (`deleteByDefault`, non-`mark_inactive`
  missing policy, or overwriting human fields) reject fail-closed.

Follow-up hardening in #2271:

- `plannedAt` string inputs validate and canonicalize to ISO;
- human-preserved field whitelist comparison is order-independent and rejects
  duplicate/missing pseudo-matches;
- primitive value comparison no longer relies on `JSON.stringify` for common
  scalar fields while preserving legacy null/undefined equivalence.

### ✅ C4 - Apply writer to stock-preparation main table (DONE - PR #2275, `75d3a44a1`)

Gated on: C3 + explicit opt-in. Done in #2275.

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

### ✅ C5-0 - Parameterized workbench action design (DONE - PR #2280, `d48936b2f`)

Gated on: C4 + explicit opt-in. Done in #2280.

Scope:

- Design the reusable parameterized table action surface.
- Use the PLM project BOM pull as the first configured action instance.
- Lock the route/UI/apply safety contracts before runtime starts.
- Split runtime into C5-1/C5-2/C5-3.
- No route, UI, helper, migration, package, MetaSheet write, PLM write, or K3.

Acceptance locks:

- Browser requests carry only `actionId`, allowlisted parameters, and apply
  confirmation metadata; never target `sheetId`, source bindings, raw filters,
  C3 plan payloads, or C4 writer payloads.
- Apply recomputes C2/C3 server-side before calling C4.
- Apply derives C4 permission from the authenticated user; no hardcoded
  `"write"`.
- Apply injects a records API scoped to the configured stock-preparation target.
- Apply requires a fresh server-generated dry-run token / revision marker; no
  caller can jump directly to apply.
- Target sheet authorization is action-as-authorization: Data Factory write/admin
  may run the configured action, and only admins may create/edit the action
  config that binds the target sheet.
- Dry-run/read and apply/write permissions are separated.
- Issue/customer evidence stays values-free.

### ✅ C5-1 - Backend parameterized action routes (DONE - PR #2284)

Gated on: C5-0 accepted + explicit opt-in. Done in #2284.

Scope:

- Add generic table-action route contract:
  - `GET /api/integration/table-actions`;
  - `POST /api/integration/table-actions/:actionId/dry-run`;
  - `POST /api/integration/table-actions/:actionId/apply`.
- Add the static first action config: `plm.stock-preparation.pull-bom.v1`.
- Dry-run: validate allowlisted parameters, run C2 expansion, read current
  stock-preparation rows, run C3 planner, return summary.
- Apply: validate parameters again, recompute C2/C3 server-side, then call C4
  through a scoped records API.

Acceptance locks:

- No client-supplied source, target, raw SQL, filter field, `sheetId`, C3 plan,
  or C4 payload is accepted.
- Dry-run uses `requireAccess(read)`.
- Apply uses `requireAccess(write)` and passes the real write/admin permission
  into C4.
- Dry-run direct source reads use the request user's principal; missing
  principal fails closed.
- Target records API is server-scoped to the configured stock-preparation
  sheet/object.
- Action config create/edit is admin-only; normal operators cannot rebind source
  systems, read plans, or target sheets.
- Apply requires a server-generated dry-run token / revision marker and
  recomputes the plan before writing.
- Manual-confirm rows are held while clean rows can still apply.
- Values-free summary is available for issue evidence.

### ✅ C5-2 - Workbench parameterized action UI (DONE - PR #2288)

Gated on: C5-1 + explicit opt-in. Done in #2288.

Scope:

- Add a reusable parameterized table action panel in the workbench, with the PLM
  project BOM pull as the first configured action instance.
- Operator enters only `projectNo`.
- UI shows dry-run status, conflict counts, a token-present state, and
  values-free evidence.
- Apply confirmation uses the dry-run token and calls C4 only when allowed.

Acceptance locks:

- No raw SQL textarea.
- Normal users fill only admin-allowed parameters; they cannot change source,
  object, mappings, or filter fields.
- v1 parameters remain equality-filtered and allowlist-driven.
- Apply wiring must pass the authenticated user's real Data Factory write/admin
  authorization into C4; no hardcoded `"write"` permission.
- Apply wiring must inject a records API scoped to the intended
  stock-preparation sheet/object; normal users must not be able to point C4 at
  an arbitrary `sheetId`.
- Dry-run and apply permissions are visibly separated.
- Values shown in the tenant UI are not copied to issue evidence.
- No K3 button/action is introduced.
- No batch/multi-project mode in v1.
- Request-body wire test asserts dry-run/apply send no browser-supplied
  `sheetId`, source/target binding, C3 plan, or C4 payload.

### 🟡 C5-3a - On-prem action config injection unblocker (this PR)

Gated on: C5-1/C5-2 + entity-machine smoke finding + explicit opt-in.

Scope:

- Inject server-owned `plugin-integration-core` table-action config into the
  plugin host context from deployment environment JSON.
- Keep the PLM action config non-secret: it may contain the integration
  external-system id, readonly SQL object/read-plan references, target stock
  sheet id/object id, field maps, and limits; it must not contain datasource
  credentials or raw PLM/customer row values.
- Preserve C5's server-side action ownership: the browser still receives only
  public action metadata and never receives source bindings or target sheet ids.
- No PLM read, MetaSheet write, UI, K3, migration, raw SQL, or permission model
  change.

Acceptance locks:

- Without configured action JSON, `GET /api/integration/table-actions` remains
  fail-closed with `configured:false`.
- With valid server-side action JSON, the existing route consumer exposes the
  action as `configured:true` while redacting source/target bindings from public
  metadata.
- Invalid JSON or non-object/non-array config fails closed at plugin host
  startup; no silent empty config.
- The deployment config path is scoped to `plugin-integration-core`; unrelated
  plugins do not receive the table-action config.

### ⬜ C5-3 - Operator validation runbook / entity-machine smoke

Gated on: C5-1/C5-2 + C5-3a package deployed + explicit opt-in.

Scope:

- Document a values-free entity-machine smoke for the workbench action.
- Validate one project dry-run and, only with explicit approval, one apply to
  the configured MetaSheet stock-preparation main table.
- Capture evidence using summary counts/status/error codes only.

Acceptance locks:

- No raw PLM rows, component values, materials, quantities, target row values,
  or apply payloads in issues.
- K3 remains not invoked.
- External DB write remains not invoked.
- Manual-confirm rows remain held.

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

## Details carried forward

Some C0/C1 details are now encoded by C2/C3/C4 helpers. The remaining live
operator checks stay in later validation slices:

- **Live PLM feasibility:** C2 has a default DN-PDM read plan, but entity-machine
  validation still must prove the customer schema supports the configured flat
  reads without raw SQL, stored procedures, or vendor API calls.
- **Target binding:** C5 route wiring must scope C4 to the intended
  stock-preparation sheet/object; browser-supplied sheet ids are forbidden.
- **Option sources:** exact `config_info` option source and target fields remain
  deferred to C6.
- **Validation evidence:** tenant UI may show values to authorized users, but
  issue/customer evidence must stay values-free.

## Sequencing rule

C0, C1, C2-0, C2, C3, C4, C5-0, C5-1, and C5-2 are complete. C5-3a is the
current entity-machine unblocker found during C5-3 smoke: the host must inject
server-owned action config so the plugin can report the PLM action as
`configured:true`.

1. C5-0 design locks the reusable parameterized action contract.
2. C5-1 adds backend action routes and server-side recompute/apply wiring.
3. C5-2 adds the workbench operator surface.
4. C5-3a injects server-owned plugin action config for on-prem deployment.
5. C5-3 validates the flow on an entity machine.

C6 option sync remains after C5. All later slices still require their
predecessor to land and the owner to explicitly opt in. K3 Save / Submit /
Audit / BOM, external database write, and multi-project/batch mode remain out
of scope.
