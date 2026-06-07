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
- Source is an explicitly configured readonly PLM source:
  `data-source:sql-readonly` or `bridge:legacy-sql-readonly`. The two paths
  must never silently fall back to each other.
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
| PLM source | Explicit readonly SQL source: `data-source:sql-readonly` or `bridge:legacy-sql-readonly`. |
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
  registered/bound through an explicitly configured readonly source. Onsite
  validation later chose the Bridge-source path because the PLM SQL Server is
  represented as `bridge:legacy-sql-readonly`.

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

### ✅ C1b-2 - Admin target readiness/provisioning workflow (DONE - PR #2309, `8bf7b38a6`)

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

- Build a pure or service-layer helper that reads through the configured
  readonly PLM source adapter.
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

Historical note: that source-kind boundary was correct for C5-3b. A later
onsite source inventory showed the PLM SQL Server source is available as
`bridge:legacy-sql-readonly`, so the explicit C5-source-gate slice below widens
the source contract deliberately rather than silently falling back.

Acceptance locks:

- Incomplete explicit target maps fail before PLM reads, target reads, target
  writes, or dry-run token consumption.
- HTTP dry-run fails before `getExternalSystemForAdapter` / `createAdapter`.
- Error details expose logical field names only; no source external-system id,
  target sheet id, PLM row value, or MetaSheet row value.
- No PLM read, MetaSheet write, K3, UI, migration, raw SQL, or permission model
  change.

### ✅ C5-3 - Operator validation / entity-machine closeout (CLOSED - #2253, 2026-06-06)

Gated on: C5-1/C5-2 + C5-3a package deployed + C5-3b package deployed +
C1b target readiness + explicit PLM readonly source binding
(`data-source:sql-readonly` or `bridge:legacy-sql-readonly`) + explicit opt-in.
This gate is satisfied for the closed #2253 sample; future samples still need
their own validation/approval.

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

Final entity-machine state after the #2253 closeout chain:

- C5-3b target-schema preflight PASSed: partial explicit `fieldIdMap` returns
  values-free `422 TARGET_SCHEMA_INCOMPLETE` before any source read.
- C1b-2 target readiness PASSed on the entity machine: admin readiness/ensure
  works, non-admin returns 403, and no PLM/C2/C3/C4/K3/row writes occur.
- C5-source-gate PASSed with an explicitly configured
  `bridge:legacy-sql-readonly` source.
- C2 expansion PASSed with `rowsExpanded=44` and no error types.
- C3 planner PASSed before apply with `add=44`, `manual_confirm=0`.
- C4 apply was run once for the approved sample only; onsite evidence reported
  `created=44`, `failed=0`.
- Readback after apply PASSed with `recordCount=44`.
- The final #2335 package retest PASSed: dry-run returned `status=ready`,
  `planValid=true`, `existingRows=44`, `rowsExpanded=44`, `add=0`, `update=0`,
  `skip=44`, `inactive=0`, `manual_confirm=0`.
- Stop rule: do not run another C4 apply for this same sample. Future applies
  require a new sample/project, a new explicit approval, or a production rollout
  gate.

### ✅ C5-source-gate - Explicit Bridge readonly source support (DONE - PR #2311, `2d9281cdf`; fixes #2313, `61b13a95b`; receipt #2320, `352ff069e`)

Gated on: C1b-2 entity-machine target readiness PASS + onsite source inventory
showing the PLM source is `bridge:legacy-sql-readonly` + explicit opt-in.

Scope:

- Allow `plm.stock-preparation.pull-bom.v1` to use
  `bridge:legacy-sql-readonly` only when the server-side action config names
  that source kind.
- Require `source.readPlan.sourceKind` to match `source.kind`; no
  `data-source`/Bridge drift.
- Keep the route's saved external-system kind check before adapter creation.
- Teach the readonly Bridge Agent and adapter to accept structured equality
  filters over allowlisted object fields.
- Keep Bridge filters primitive-only and parameterized; no raw SQL, operator
  objects, arrays, joins, CTEs, stored procedures, or vendor API calls.
- Update package verification and the Bridge Agent runbook so future packages
  validate the new filter contract instead of the retired
  `UNSUPPORTED_FILTERS` behavior.

Acceptance locks:

- Bridge C5 dry-run reaches the source adapter through equality-filtered flat
  reads.
- A source-kind mismatch returns 422 before adapter creation.
- Invalid Bridge filters fail closed before SQL execution.
- Bridge Agent SQL uses allowlisted identifiers and bound parameters.
- No PLM write, MetaSheet apply, K3, external database write, raw SQL, or
  source credential copy is introduced.

### ✅ C6 - `config_info` -> select/dropdown option sync + predefined option-action binding (DONE - PR #2326, `fdec5af1c`)

Gated on: C5 + target readiness + explicit opt-in.

Scope:

- Sync selected option sets used by stock-preparation fields.
- Keep options aligned for fields such as material type / blank type / status.
- Support a controlled admin-facing "sync options" action after the canonical
  target table exists.
- Let admins customize option values/labels/colors and bind an option to a
  backend predefined action id.
- Store bindings as field metadata (`stockPreparation.optionActionBindings`);
  they do not execute directly. Execution still goes through the existing
  table-action dry-run/apply token and permission gates.
- This is MetaSheet configuration sync only: field `property.options` and
  stock-preparation field metadata.

Acceptance locks:

- No PLM write.
- No K3 write.
- Option evidence is values-free when posted to issues.
- Missing/ambiguous option mapping fails closed.
- C6 must not auto-create unknown options during C5 apply.
- No arbitrary SQL, JS, URL, handler/function body, payload, or external call
  can be supplied by the browser/admin config.
- Option-action binding must name a predefined backend action from the allowlist;
  unknown action ids fail closed.
- Admin-only route/UI. Read/write non-admin users cannot sync options.

### ✅ Large-BOM C0 - strategy design for #2342 (DONE - PR #2351, `b7998d73d`)

Gated on: #2340 large-sample dry-run evidence + explicit opt-in.

Scope:

- Design the large-BOM strategy before implementing more runtime.
- Preserve the current fail-closed behavior for capped dry-runs:
  `max_rows_exceeded` / bounded rows / `canApply=false` / no dry-run token.
- Define a future `largeBom=true` bounded-preview readiness shape that exposes
  values-free counts/status while clearly saying the plan is not authoritative.
- Decide that large apply is not unlocked by raising a synchronous cap. Large
  apply needs a separate background/checkpointed execution mode with explicit
  owner approval.
- Lock the relationship to #2343: duplicate analysis on a capped subset is not
  authoritative; complete expansion is required before duplicate policies are
  trusted on large samples.
- Keep this slice docs-only.

Acceptance locks:

- No runtime, route, UI, migration, package, MetaSheet row write, PLM write,
  external database write, C4 Apply, K3, production rollout, or retry worker.
- `largeBom=true` always blocks Apply.
- No dry-run token is issued for bounded/failed large-BOM state.
- Bounded C3 counts may be shown only as subset/non-authoritative counts.
- Browser input cannot raise caps or choose Apply mode.
- Values-free evidence only.
- #2343 D1 remains ready but should run after #2342 C0 for large samples,
  because complete expansion is upstream of authoritative duplicate analysis.

### ✅ Large-BOM C1 - bounded dry-run readiness shape (DONE - PR #2361, `e096b1a41`)

Gated on: Large-BOM C0 accepted + explicit opt-in.

Scope:

- Preserve sync dry-run as bounded and read-only.
- Surface scale-class caps as a values-free bounded state:
  `status='large_bom_bounded'`, `largeBom=true`, `boundedPreview.complete=false`.
- Keep Apply blocked: `canApply=false`, no dry-run token, no MetaSheet row
  write.
- Treat only scale caps as large-BOM bounded:
  `max_rows_exceeded`, `read_page_limit_exceeded`, `read_count_exceeded`, and
  `read_time_limit_exceeded`.
- Preserve hard failures as hard failures: `max_depth_exceeded`, cycles, source
  read failures, invalid rows, and other correctness errors must not be
  relabeled as large BOM.
- Keep issue/customer evidence values-free: counts, cap fields, read diagnostics,
  and error types only.

Acceptance locks:

- `largeBom=true` always blocks Apply.
- No dry-run token is issued for bounded large-BOM states.
- C3 counts over bounded rows are subset/non-authoritative.
- Browser input cannot raise caps or choose Apply mode.
- No UI, route shape redesign, background job, checkpoint writer, package,
  PLM write, external database write, K3, or production rollout.

### ✅ Large-BOM C2 - bounded large-BOM workbench display (DONE - PR #2362, `a0ff04e91`)

Gated on: Large-BOM C1 response shape + explicit opt-in.

Scope:

- Render the C1 bounded state in `IntegrationWorkbenchView`.
- Show summary-first bounded diagnostics:
  rows expanded, read count, configured cap fields, and scale error types.
- Keep Apply disabled because `canApply=false` and no dry-run token exists.
- Keep the issue/customer evidence path values-free.
- Do not add browser-controlled caps or Apply mode.

Acceptance locks:

- UI-only; no backend route change, expansion helper change, writer change,
  background job, checkpoint writer, package, PLM write, external database
  write, K3, or production rollout.
- `large_bom_bounded` is displayed as non-authoritative.
- Apply remains disabled and sends no apply request.
- The bounded block renders counters/error types only, not project/component
  values or dry-run tokens.

### ✅ Large-BOM C3 - background full-expansion design (DONE - PR #2363, `41c56b7c4`)

Gated on: Large-BOM C0/C1/C2 + explicit opt-in.

Scope:

- Design the background full-expansion lane for large BOMs.
- Define job lifecycle, durable checkpoint requirements, values-free progress
  evidence, budget policy, and authoritative completion criteria.
- Preserve app-side recursion over flat reads through the configured source
  adapter.
- Require the authenticated read principal; missing principal fails closed with
  no system/admin/service fallback.
- Keep C3 read-only and design-only: no runtime, route, UI, worker, migration,
  MetaSheet row write, PLM write, external database write, K3, or C4 Apply.

Acceptance locks:

- Background mode is a separate job/checkpoint lane, not a longer single HTTP
  request.
- Job/checkpoint storage must be durable; memory-only storage is forbidden.
- Browser input cannot supply caps, source, target, read plan, raw SQL, C3 plan,
  C4 payload, sheet id, or field id.
- Scale budget exhaustion does not produce an authoritative artifact.
- Hard failures (`max_depth_exceeded`, cycles, source failures, invalid rows)
  stay hard and are not relabeled as large BOM success.
- Public progress/evidence is values-free.
- Resume must not duplicate expanded rows.
- C3 completion alone does not write rows and does not unlock C4 Apply.
- #2343 duplicate counts on large samples are authoritative only after C3
  completes a full expansion artifact.

### ✅ Large-BOM C4 - checkpointed apply writer design (DONE - PR #2365, `42eda7ac3`)

Gated on: Large-BOM C3 design accepted + explicit opt-in.

Scope:

- Design large-BOM Apply as a resumable/checkpointed writer, not a synchronous
  one-request C4 loop.
- Consume only a completed authoritative C3 expansion/plan plus explicit owner
  approval and fresh revision binding.
- Preserve C4 find-then-create/patch idempotency, manual-confirm holds, and
  human-field preservation.
- Require authenticated write/admin approval; no hardcoded permission and no
  browser-supplied target scope.
- Record per-row failures without retry storms and without erasing clean-row
  progress.

Acceptance locks:

- No runtime, route, UI, worker, migration, package, MetaSheet row write, PLM
  write, external database write, K3, or production rollout.
- Large Apply cannot start from `largeBom=true` bounded preview.
- Large Apply cannot start without a completed authoritative C3 artifact/plan.
- Browser input cannot supply plan, payload, source, target, caps, sheet id, or
  field id.
- Permission is derived from the authenticated approver, never hardcoded.
- Durable checkpoint storage is required; memory-only storage is forbidden.
- Resume after interruption must not duplicate target rows.
- `update`/`inactive` never create on miss.
- `manual_confirm` decisions are held and write nothing.
- Human-preserved fields are never written.
- Row-level failures are values-free and do not erase clean-row progress.

### ✅ Duplicate-expanded-key D0 - conflict strategy design (DONE - PR #2346, `14d6c2ca1`)

Gated on: #2340 onsite held-duplicate evidence + explicit opt-in.

Scope:

- Design the generic conflict-strategy frame with `duplicate_expanded_key` as
  the first supported conflict type.
- Lock values-free duplicate-cause diagnostics before any policy choice.
- Lock policy candidates: `hold`, `keep_multiple_rows`, `merge_quantity`,
  `select_representative`, `skip_selected`, `source_correction_required`.
- Lock policy scopes: `run_only` and `table_scope`; global/template defaults
  remain deferred.
- Lock no silent pick, no silent drop, no material-code-only identity, and
  fresh dry-run/token before any future duplicate apply.
- Lock #2342 dependency: duplicate evidence on large samples is authoritative
  only after complete expansion.

### ✅ Duplicate-expanded-key D1 - grouped dry-run evidence/UI (DONE - PR #2366, `68ea283ef`)

Gated on: Duplicate D0 + Large-BOM C1-C4 chain + explicit opt-in.

Scope:

- Extend C3 conflict-plan evidence with values-free
  `duplicateExpandedKeyDiagnostics`.
- Diagnose duplicate groups without exposing row values:
  group count, rows-per-group distribution, same-parent vs cross-parent counts,
  quantity-shape counts, attribute-shape counts, stable-discriminator counts,
  deterministic collision fingerprints, and allowed policy names.
- Render a grouped review block in the workbench dry-run panel.
- Keep duplicate rows held as `manual_confirm`; no policy persistence and no
  duplicate apply in D1.

Acceptance locks:

- No MetaSheet write, PLM write, external database write, K3, route change,
  package, migration, policy persistence, or Apply unlock.
- Public evidence never exposes project number, raw idempotency key, component
  source id/code/name/material, parent id/path, source detail id, target values,
  sheet id, field id, raw SQL, credentials, or tokens.
- Collision fingerprints are deterministic and do not expose raw keys.
- Default recommendation is `hold`.
- `keep_multiple_rows`, `merge_quantity`, `select_representative`,
  `skip_selected`, and `source_correction_required` are displayed as candidates
  only; no writer infers or applies them.

### ✅ Duplicate-expanded-key D2 - run/table-scoped policy review (DONE - PR #2368, `1bcbfdc97`)

Gated on: Duplicate D1 + explicit opt-in.

Scope:

- Add a values-free policy-review contract for `duplicate_expanded_key`.
- Support `run_only` policy choices in the dry-run request body. These choices
  are bound into the next dry-run evidence only; they do not change C3 decisions
  or unlock C4 writes.
- Support admin-only `table_scope` policy persistence with list/save/revoke
  routes keyed to the server-configured table-action target scope.
- Render policy selectors in the workbench duplicate review block:
  “只此次有效” and “保存/撤销本表策略”.
- Preserve default fail-closed `hold` when no policy is selected or when a saved
  policy no longer matches the current duplicate fingerprint.

Acceptance locks:

- Duplicate rows remain `manual_confirm` held. D2 must not apply
  `keep_multiple_rows`, `merge_quantity`, `select_representative`,
  `skip_selected`, or `source_correction_required`.
- Apply request bodies continue to reject `conflictPolicyReview`; future
  duplicate apply must be a separate explicit slice.
- Table-scope policy save/revoke is admin-only; read/write users cannot persist
  policies.
- Policy routes must not load the source adapter, PLM, target records, K3, or
  external databases.
- Public evidence exposes only conflict type, deterministic fingerprints,
  selected policy, scope, counts, and presence flags. It must not expose project
  number, raw idempotency key, component values, target sheet id, field id,
  approver identity, credentials, tokens, payloads, or raw SQL.
- A pending run-only choice requires a fresh dry-run before Apply can be
  enabled.

### ✅ Duplicate-expanded-key D3 - keep-multiple resolver + reviewed apply (DONE - PR #2372, `b40f0f769`)

Gated on: Duplicate D2 + explicit opt-in.

Scope:

- Implement the first executable duplicate policy: `keep_multiple_rows`.
- Resolve only duplicate groups that have an explicit `keep_multiple_rows`
  policy and a stable row discriminator.
- Use surgical idempotency keys only for the resolved collision group rows.
  Clean rows and already-written clean keys keep their original key.
- Carry the default fail-closed posture forward: no policy, unsupported policy,
  stale fingerprint, missing stable discriminator, duplicate existing target
  key, or clean-to-collision transition all stay held.
- Make previously saved `table_scope` policies become active only through a
  fresh dry-run that explicitly reports the resolved group count before apply.
- Require a fresh dry-run token and explicit duplicate-resolution
  acknowledgement before applying any resolved duplicate groups.

Acceptance locks:

- `keep_multiple_rows` is the only policy that can change C3 decisions in D3.
  `merge_quantity`, `select_representative`, `skip_selected`, and
  `source_correction_required` remain review-only/held.
- A stored `table_scope` policy must not silently activate. The next dry-run
  must values-free report how many groups it resolves, split by table/run
  scope, before Apply can proceed.
- Surgical keys apply only to rows inside the resolved collision group.
  Non-collision rows preserve their original `idempotencyKey`.
- Clean-to-collision transitions default to hold. D3 must not silently re-key,
  orphan, deactivate, or duplicate a row that was previously written under the
  clean/base key.
- Apply recomputes from the reviewed dry-run token. Run-only policy choices are
  token-bound; table-scope policy changes after dry-run invalidate the token.
- Resolved duplicate groups require an explicit apply acknowledgement; a token
  alone is not enough.
- Public evidence remains values-free: fingerprints, policies, scopes,
  discriminator type, counts, and hold reasons only. It must not expose project
  number, raw idempotency key, component values, parent/path values,
  discriminator values, target sheet id, field id, credentials, tokens,
  payloads, or raw SQL.
- No PLM write, external database write, K3 path, migration, package, or new
  policy execution beyond `keep_multiple_rows`.

### 🟡 Duplicate-expanded-key D3 validation - #2340 sample keep-multiple closeout (PENDING - validation runbook)

Gated on: D3 runtime (#2372) + explicit operator validation.

Scope:

- Validate the #2340 246-row sample against the landed `keep_multiple_rows`
  resolver.
- Confirm saved `table_scope` or selected `run_only` policies become active
  only through fresh dry-run evidence.
- Confirm resolved duplicate groups require explicit
  `acceptDuplicateResolution` acknowledgement before apply.
- Confirm post-apply re-pull is idempotent: resolved duplicate rows become
  `skip` or `update`, not another `add`.
- Keep evidence values-free and never paste payload preview JSON or business
  values.

Acceptance locks:

- A package containing #2372 or later is deployed before validation.
- Pre-policy dry-run confirms already-written clean rows do not become new
  `add` decisions.
- Post-policy dry-run reports `resolvedGroupCount`, `resolvedRowCount`,
  `heldGroupCount`, `heldReasonCounts`, and scope split
  (`tableScopeResolvedGroupCount` / `runOnlyResolvedGroupCount`) before apply.
- Apply without duplicate-resolution acknowledgement is blocked.
- Apply after owner approval writes only resolved duplicate rows; unresolved
  groups remain held.
- Re-pull after apply reports `add=0` for the resolved set and no
  `clean_to_collision_requires_review` for the resolved-key rows.
- Any remaining held groups drive the next duplicate strategy decision; no
  speculative runtime strategy starts from this validation PR.

## Deferred tracks

- New project/sample C4 apply validation after separate explicit approval.
- Production rollout for PLM stock-preparation apply.
- PLM adapter/API source instead of readonly SQL.
- Fuzzy/prefix/multi-project matching.
- Procurement/warehouse child-table generation.
- Large-BOM runtime beyond C1: UI affordance, background full expansion, and
  checkpointed apply remain separate opt-ins.
- SQL bridge C3 watermark/incremental implementation.
- External DB write.
- K3 Save / Submit / Audit / BOM.

## Details carried forward

Some C0/C1 details are now encoded by C2/C3/C4/C5/C6 helpers and were also
validated in the #2253 entity-machine closeout. Remaining live checks are for
new scenarios, not for the closed sample:

- **Live PLM feasibility:** the closed sample proved the configured flat reads
  work through the explicit Bridge source without raw SQL, stored procedures, or
  vendor API calls. A different customer schema or source kind still needs its
  own feasibility gate.
- **Target binding:** C5 route wiring scopes C4 to the server-configured
  stock-preparation sheet/object; browser-supplied sheet ids remain forbidden.
- **Option sources:** C6 sync is implemented for the configured stock-preparation
  option fields and predefined action binding metadata. Richer option authoring
  or option-trigger execution polish is separate.
- **Validation evidence:** tenant UI may show values to authorized users, but
  issue/customer evidence must stay values-free.

## Sequencing rule

C0, C1, C2-0, C2, C3, C4, C5-0, C5-1, C5-2, C5-3a, C5-3b, C1b-1, C1b-2,
C5-source-gate, C6, and the #2253 entity-machine closeout are complete for the
approved sample.

1. C5-0 design locks the reusable parameterized action contract.
2. C5-1 adds backend action routes and server-side recompute/apply wiring.
3. C5-2 adds the workbench operator surface.
4. C5-3a injects server-owned plugin action config for on-prem deployment.
5. C5-3b rejects incomplete target schema/config before any PLM read.
6. C1b prepares and validates a canonical target table/binding so full C5 smoke
   no longer depends on a large explicit legacy `fieldIdMap`.
7. C5-source-gate enables the explicitly configured Bridge readonly source path
   with parameterized equality filters.
8. C5-3 validates the flow on an entity machine.
9. C6 syncs configured select/dropdown option sets and predefined
   option-action bindings into the canonical target field metadata.
10. #2332/#2334/#2335 close the onsite apply diagnostics, type-normalization,
    and post-create planner normalization follow-ups.

After the #2253 closeout, do not repeat C4 apply for the same sample. Any new
project/sample apply, production rollout, richer option authoring UI,
option-bound action execution polish, or multi-project/batch mode remains a
separate gate with owner opt-in. K3 Save / Submit / Audit / BOM and external
database write remain out of scope.
