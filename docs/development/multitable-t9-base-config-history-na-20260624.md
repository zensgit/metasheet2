# Base-level config history — N/A until base-config mutation routes exist (T9)

**Date:** 2026-06-24
**Status:** NOT BUILT (intentionally). Records the investigation behind the decision.
**Scope:** the BASE-scoped analogue of the existing SHEET-scoped config history (`meta_config_revisions` +
`recordConfigRevision`, wired in `packages/core-backend/src/routes/univer-meta.ts`).

## Verdict

There is **no base-config mutation chokepoint to record today**. Base-level config history is **N/A until
base-config mutation routes (rename / settings / base-level permissions / base automation config) exist**.
Building it now would mean inventing storage and a read surface for change events that no route can ever
produce — i.e. forcing it. We do not.

## What sheet-config history actually records (the bar a base analogue must clear)

`recordConfigRevision` (`packages/core-backend/src/multitable/config-revision-recorder.ts`) appends one
`meta_config_revisions` row inside the mutation's own transaction. The table is **sheet-keyed**:
`sheet_id text NOT NULL`, **no `base_id` column**
(`packages/core-backend/src/db/migrations/zzzz20260624120000_create_meta_config_revisions.ts:13`), and the
`entity_type` CHECK is `IN ('field','permission','view','sheet_config')`.

Crucially, the `sheet_config` rows it records are **settings UPDATEs** — entries in a change lifecycle, not
one-off creations:

- `PATCH .../row-level-read-deny flag` toggle — `univer-meta.ts:6582` does `UPDATE meta_sheets SET
  row_level_read_permissions_enabled = …`, then records `entity_type: 'sheet_config'`, `action: 'update'`
  with a before/after diff (`univer-meta.ts:6585`).
- `PUT /sheets/:sheetId/conditional-rules` — `univer-meta.ts:6667` does `UPDATE meta_sheets SET
  conditional_read_rules = …`, then records `entity_type: 'sheet_config'`, `action: 'update'`
  (`univer-meta.ts:6670`).

A field gets recorded because a field has a **full create → update → delete lifecycle through routes**; the
create is entry #1 of many. "Config history" is the accumulation of that lifecycle.

## Routes that touch base config — and why each is not a recordable chokepoint

Every `/bases…` route was enumerated
(`grep -rEn "(router|app)\.(get|post|put|patch|delete)\(['\"]/bases" packages/core-backend/src/routes`).
The base config columns are `meta_bases(name, icon, color, owner_id, workspace_id)`
(`zzzz20260318110000_add_multitable_bases_and_permissions.ts:8`).

### 1. `POST /bases` — CREATE only (terminal)

`univer-meta.ts:5835` → the only write is `INSERT INTO meta_bases (…)` (`univer-meta.ts:5856`). It is the
sole route that sets a base's `name/icon/color/owner/workspace`.

### 2. `POST /templates/:templateId/install` — CREATE only (terminal)

`univer-meta.ts:5884` → `installMultitableTemplate(...)`, whose base write is again `INSERT INTO meta_bases`
(`packages/core-backend/src/multitable/provisioning.ts:203`, `template-library.ts:584`). Also create-only.

**A base create can never have an entry #2.** There is **no route that mutates a base's config after it is
created**:

- **No rename / settings UPDATE.** `grep -rEn "UPDATE meta_bases|meta_bases.*SET" packages --include="*.ts"`
  (excluding migrations / tests) returns **nothing**. There is no `PATCH/PUT /bases/:baseId`.
- **No base soft-delete.** `meta_bases.deleted_at` exists in the schema but is, per the resolver docstring,
  **"Soft-delete is runtime-unreachable today; this hardens against a future base soft-delete feature"**
  (`packages/core-backend/src/multitable/permission-service.ts:1540`). No `DELETE /bases/:baseId` route
  exists.
- **No base-level permission mutation.** There is **no `base_permissions` table** — base readability/writability
  derive from admin role / a global grant / `meta_bases.owner_id`, not a base-scoped permission row
  (`permission-service.ts:1514`). So there is no base-permission edit to record.
- **No base-scoped automation config.** Automation rules are authored per **sheet**
  (`POST/PATCH/DELETE /sheets/:sheetId/automations`, `univer-meta.ts:14345/14383/14431`), not per base. They
  already flow through sheet-scoped routes; they are not base config.

### Adjacent base-scoped writes that are deliberately NOT in scope

`POST /bases/:baseId/history-audit-grants` (`univer-meta.ts:7497`) and
`DELETE /bases/:baseId/history-audit-grants/:grantId` (`univer-meta.ts:7726`) DO mutate base-scoped state, but
they are **not base config/schema**:

- They write `meta_history_audit_grants`, an access-grant store that **already carries its own in-table
  lineage** (`granted_by`, `revoked_by`, `reason`, `ticket`; revoked rows retained — see
  `zzzz20260621100000_create_meta_history_audit_grants.ts:37`). Re-recording it into config history would be
  redundant double-bookkeeping.
- It is a **different governance domain**: issued ONLY by the standalone
  `multitable:history-field-audit:grant` platform capability, with **no base-admin / `multitable:admin`
  bypass** by design (`univer-meta.ts:7488`). Folding it under config history (which is gated by
  `canManageSheetAccess` et al.) would cross that wall.

## Why a minimal "record the create" build still doesn't fit

Even ignoring the lifecycle argument, the prescribed recipe ("extend the `entity_type` CHECK to include
`base_config`") does **not** fit the storage:

- `meta_config_revisions.sheet_id` is `NOT NULL` with **no `base_id`** — a base row has no sheet to key on, so
  recording one needs a **new column** (and a relaxed/conditional NOT NULL), beyond a CHECK edit.
- The read path is sheet-keyed end to end: `GET /sheets/:sheetId/config-history` filters `sheet_id = $1` and
  gates per entity type via `resolveSheetCapabilities` (`univer-meta.ts:7558` / WHERE at 7583). A base row
  would surface **nowhere** without a new base-scoped read route and a new base-admin gate.

So even the smallest base build would require schema surgery + a new read surface — for a single terminal
creation event. That is the definition of forcing it.

## When this becomes buildable (re-entry conditions)

Build base-config history **only after** at least one true base-config mutation chokepoint lands — i.e. a
route that does `UPDATE meta_bases SET …` (rename / icon / color / owner / settings), a base soft-delete, or a
real base-scoped permission table with mutation routes. At that point:

1. Add a migration extending the CHECK to include `base_config` **and** add a `base_id text` column (relaxing
   the `sheet_id NOT NULL` to a "sheet_id XOR base_id" shape, or a separate base-keyed table) — a CHECK edit
   alone is insufficient.
2. Wire `recordConfigRevision` into the new base-mutation chokepoint(s), additive and in-transaction,
   mirroring the `sheet_config` UPDATE recording at `univer-meta.ts:6585/6670` (diff-first via
   `configUpdateDiff`; a no-op diff records nothing).
3. **Read side (do not build until then):** the base-config read API MUST gate visibility by a **base-admin
   capability** (the base analogue of `canManageSheetAccess`), in the WHERE clause — never reuse the
   sheet-scoped `config-history` gate or the record-history mask.

## Evidence index (paths checked)

- `packages/core-backend/src/routes/univer-meta.ts` — all `/bases…` routes (`POST /bases` 5835/5856; template
  install 5884; history-audit-grants 7497/7726); sheet-config recording sites 6585/6670; read API 7558.
- `packages/core-backend/src/multitable/config-revision-recorder.ts` — `recordConfigRevision`, sheet-keyed.
- `packages/core-backend/src/db/migrations/zzzz20260624120000_create_meta_config_revisions.ts` — table shape /
  CHECK / `sheet_id NOT NULL`, no `base_id`.
- `packages/core-backend/src/db/migrations/zzzz20260318110000_add_multitable_bases_and_permissions.ts` —
  `meta_bases` columns.
- `packages/core-backend/src/multitable/permission-service.ts:1514,1540` — no `base_permissions` table; base
  soft-delete runtime-unreachable.
- `packages/core-backend/src/multitable/provisioning.ts:203`, `template-library.ts:584` — template install =
  `INSERT INTO meta_bases` (create-only).
- `packages/core-backend/src/db/migrations/zzzz20260621100000_create_meta_history_audit_grants.ts` —
  audit-grant store with its own lineage (out of scope).
- Negative searches: `UPDATE meta_bases` / `meta_bases … SET` (excl. migrations/tests) → none.
