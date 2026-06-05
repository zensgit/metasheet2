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

### ✅ C1b-0 - Canonical target provisioning / binding design (DONE - PR #2305, `3e0a37e3a`)

Gated on: C5-3b entity-machine finding + explicit opt-in.

Scope:

- Design the target readiness path discovered by the C5-3b onsite retest:
  the existing onsite stock-preparation table is a business/manual table and is
  not a canonical C1 target.
- Prefer a canonical C1 target table over retrofitting a large explicit
  deployment-env `fieldIdMap`.
- Define create/bind modes for a stock-preparation main table that carries all
  C1 PLM/system fields and human-preserved fields.
- Keep this slice docs-only; no route, UI, table creation, PLM read, MetaSheet
  row write, or K3 path.
- Keep the PLM source gate separate: full C5 smoke still needs a real PLM source
  registered/bound as `data-source:sql-readonly`, or a separate Bridge-source
  design pivot.

Acceptance locks:

- The C1 manifest remains the single source of truth for target fields.
- Canonical targets may omit `target.fieldIdMap`; logical field ids are used.
- Legacy/non-canonical targets with partial explicit maps still fail as
  `TARGET_SCHEMA_INCOMPLETE`.
- Any create/bind implementation is admin-only and metadata-only; it writes no
  business rows.
- C6 custom option sync remains a later separate opt-in; C1b only carries
  `optionSource` metadata.
- Issue evidence is values-free: field names/counts and readiness status only.

### ✅ C1b-1 - Canonical target provisioning helper (DONE - PR #2307, `61633c634`)

Gated on: C1b-0 + explicit opt-in.

Scope:

- Add a latent backend helper that builds a canonical MetaSheet target descriptor
  from `STOCK_PREPARATION_MAIN_TABLE_TEMPLATE`.
- Bind an existing canonical target only when every logical C1 field is present.
- Create a missing canonical target through
  `context.api.multitable.provisioning.ensureObject`; metadata only, no rows.
- Return the server-side target binding shape with empty `fieldIdMap` for
  canonical targets.
- Emit values-free readiness evidence.

Acceptance locks:

- Admin permission is required before any provisioning read/create call.
- Missing provisioning API fails closed.
- Existing incomplete canonical targets fail closed as
  `TARGET_SCHEMA_INCOMPLETE` and are not repaired in place.
- Creation verifies logical fields with `resolveFieldIds` after `ensureObject`.
- Helper never uses `context.api.multitable.records`, reads PLM, writes K3, or
  writes to an external database.
- C1b-2 UI/runbook, C1b-3 entity-machine readiness smoke, and C6 option sync
  remain separate opt-ins.

### 🟡 C1b-2 - Admin target readiness/provisioning workflow (this PR)

Gated on: C1b-1 + explicit opt-in.

Scope:

- Expose a narrow admin-only backend workflow:
  - `GET /api/integration/stock-preparation/target/readiness`
  - `POST /api/integration/stock-preparation/target/ensure`
- Derive admin permission from `requireAccess(req, 'admin')`; never accept
  client-supplied permission, sheet id, field map, target config, PLM source, or
  action payload.
- Use the C1b-1 helper to inspect/bind/create only table/field metadata.
- Return a private `targetBinding` for admin config and a separate values-free
  `evidence` object for issue/customer evidence.
- Add an operator runbook for entity-machine target readiness.

Acceptance locks:

- Non-admin users cannot inspect or ensure the target.
- Unsupported client fields fail closed before provisioning.
- Missing target creates canonical metadata only; no records API, PLM read, K3,
  or external DB write.
- Existing complete canonical target binds without recreating.
- Existing incomplete canonical target fails closed as
  `TARGET_SCHEMA_INCOMPLETE` and is not repaired in place.
- Issue evidence must copy only `data.evidence`, never `data.targetBinding`.
- C1b-3 entity-machine target readiness smoke, the PLM source gate, and C6
  option sync remain separate opt-ins.

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

### ✅ C5-3a - On-prem action config injection unblocker (DONE - PR #2293)

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

### ✅ C5-3b - Target schema/config preflight (DONE - PR #2298, `17feef2fa`)

Gated on: C5-3a entity-machine smoke finding + explicit opt-in.

Scope:

- Add a route/helper-level target config preflight for
  `plm.stock-preparation.pull-bom.v1`.
- When a deployment uses explicit `target.fieldIdMap`, require it to map every
  PLM/system field from the C1 stock-preparation template.
- Return a values-free `422 TARGET_SCHEMA_INCOMPLETE` before PLM source adapter
  creation when the target binding is partial.
- Keep canonical logical-id target tables working when `target.fieldIdMap` is
  empty.
- Keep the C5 source kind unchanged: `data-source:sql-readonly` only. Do not
  widen this slice to `bridge:legacy-sql-readonly`.

Acceptance locks:

- Incomplete explicit target maps fail before PLM reads, target reads, target
  writes, or dry-run token consumption.
- HTTP dry-run fails before `getExternalSystemForAdapter` / `createAdapter`.
- Error details expose logical field names only; no source external-system id,
  target sheet id, PLM row value, or MetaSheet row value.
- No PLM read, MetaSheet write, K3, UI, migration, raw SQL, or permission model
  change.

### ⬜ C5-3 - Operator validation runbook / entity-machine smoke

Gated on: C5-1/C5-2 + C5-3a package deployed + C5-3b package deployed +
C1b target readiness + real PLM `data-source:sql-readonly` binding + explicit
opt-in.

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

Current entity-machine state after C5-3b:

- C5-3b target-schema preflight PASSed: partial explicit `fieldIdMap` returns
  values-free `422 TARGET_SCHEMA_INCOMPLETE` before any source read.
- Full C5 smoke remains blocked on target readiness and source binding, not on
  the preflight code.
- Target readiness: use a canonical C1 target table or a complete explicit
  field map. The recommended next path is C1b canonical target
  provisioning/binding.
- Source readiness: bind the real PLM SQL Server source as
  `data-source:sql-readonly`; `bridge:legacy-sql-readonly` support is a
  separate source-design pivot, not a silent fallback.

### 🔒 C6 - `config_info` -> select/dropdown option sync

Gated on: C5 + explicit opt-in.

Scope:

- Sync selected option sets used by stock-preparation fields.
- Keep options aligned for fields such as material type / blank type / status.
- Support a controlled user-facing/admin-facing "sync options" action after the
  target table exists.
- This is MetaSheet configuration sync only.

Acceptance locks:

- No PLM write.
- No K3 write.
- Option evidence is values-free when posted to issues.
- Missing/ambiguous option mapping fails closed.
- C6 must not auto-create unknown options during C5 apply.

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

C0, C1, C2-0, C2, C3, C4, C5-0, C5-1, C5-2, C5-3a, and C5-3b are complete.
C5-3b closed the target-schema fail-closed bug found during C5-3 smoke. The next
target-side blocker is C1b canonical target provisioning/binding; the next
source-side blocker is binding the real PLM source as `data-source:sql-readonly`
or explicitly opening a Bridge-source design.

1. C5-0 design locks the reusable parameterized action contract.
2. C5-1 adds backend action routes and server-side recompute/apply wiring.
3. C5-2 adds the workbench operator surface.
4. C5-3a injects server-owned plugin action config for on-prem deployment.
5. C5-3b rejects incomplete target schema/config before any PLM read.
6. C1b prepares a canonical target table/binding so full C5 smoke no longer
   depends on a large explicit legacy `fieldIdMap`.
7. C5-3 validates the flow on an entity machine.

C6 option sync remains after C1b/C5 target readiness. All later slices still
require their predecessor to land and the owner to explicitly opt in. K3 Save /
Submit / Audit / BOM, external database write, and multi-project/batch mode
remain out of scope.
