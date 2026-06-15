# Multitable Bidirectional / Mirror Links — DESIGN-LOCK (docs-only)

- Date: 2026-06-14
- Branch: `runtime/multitable-bidirectional-links-20260614` (off `origin/main` 9179c65bb)
- Status: design-lock for a single tight MVP slice. NO code in this PR. Owner reviews → then impl is launched.
- Scope guard: own-principles framing; no external-product names.

## 1. What exists today (file:line grounded)

A `link` field is **strictly one-directional**. Recon confirms there is no mirror / inverse / paired / symmetric / two-way concept anywhere in the multitable backend or the OpenAPI contract today (the only `bidirectional` token in the repo is the unrelated integration-direction enum in `src/platform/app-manifest.ts:46`).

- **Config shape** — `LinkFieldConfig` at `packages/core-backend/src/routes/univer-meta.ts:870`: `{ foreignSheetId, limitSingleRecord, foreignBaseId? }`. Parsed by `parseLinkFieldConfig` (`:900`), which tolerates aliases (`foreignDatasheetId`/`datasheetId`). The codec at `:1538` promotes `foreignBaseId` explicitly so it round-trips the wire (wire-vs-fixture rule).
- **The relation store** — `meta_links` table, DDL at `packages/core-backend/src/db/migrations/zzz20251231_create_meta_schema.ts:54`: columns `(id, field_id, record_id, foreign_record_id, created_at)`. Critically, a row is anchored to **the forward field only** (`field_id`). Three indexes exist (`:67-69`): `idx_meta_links_field`, `idx_meta_links_record`, and — load-bearing for this design — **`idx_meta_links_foreign` on `foreign_record_id` (`:69`)**.
- **Forward write paths** (`packages/core-backend/src/multitable/record-service.ts`): insert at `:590` (one `INSERT INTO meta_links ... ON CONFLICT DO NOTHING` per forward id); update diff at `:999` (compute `toDelete`/`toInsert` against current rows, then DELETE/INSERT, scoped `WHERE field_id=$1 AND record_id=$2`). `limitSingleRecord` is enforced authoring-side at `:815`.
- **Delete cascade** — `record-service.ts:714`: `DELETE FROM meta_links WHERE record_id = $1 OR foreign_record_id = $1`. The `OR foreign_record_id` clause means deleting a record **already** removes edges where it is the target. Plus FK `onDelete('cascade')` on `field_id`/`record_id`.
- **Read-side summaries** — `buildLinkSummaries` (`univer-meta.ts:3605`). Resolves the foreign-record `display` for each forward link, behind the perm chokepoints: `resolveReadableSheetIds` (`:3632`), the cross-base base-read Sink B-1 gate (`:3634`), and foreign display-field masking from the foreign sheet's own layer-2 ∧ layer-3 allowed set (`:3652`). Consumed by `/view`, single-record read (`:9007`), `link-options` (`:9169`), and write-echo.
- **Cross-sheet propagation** — `RecordWriteServiceHooks.computeDependentLookupRollupRecords` (`record-write-service.ts:298`) does one-hop related-record recompute + FOL-1 realtime fan-out; Yjs invalidation wires through `record-service.ts:423` (`setYjsInvalidator`) → `post-commit-hooks.ts`.
- **The ②a / ②b wall** — `validateLinkFieldConfig` (`univer-meta.ts:1097`): a link is same-base by default; cross-base is allowed **only** with an explicit `foreignBaseId` equal to the foreign sheet's actual `base_id` (`:1121`–`:1132`), and that claim is immutable after create (`:6008`).

## 2. Core decision (the spine): single-edge derived reverse, NOT a materialized mirror row

A `meta_links` row `(field_id=F_A, record_id=A, foreign_record_id=B)` is the **single canonical edge**. Both fields are *projections of the same edge*, never two stored copies:

| Field | Query against the existing edge |
|---|---|
| Forward — A's field `F_A` | `WHERE field_id=F_A AND record_id=A` → `B` (today's read) |
| **Reverse — B's mirror field** | `WHERE field_id=F_A AND foreign_record_id=B` → `A` (new read path) |

The reverse read is served by the **already-present `idx_meta_links_foreign` index** (migration `:69`) — no schema migration is required to read the mirror.

Two facts from §1 make single-edge the structurally tighter slice:

1. **Delete is already correct.** `record-service.ts:714`'s `OR foreign_record_id = $1` clause cleans the reverse projection with **zero new code**. A materialized second row would need its own cascade handling.
2. **Loops are structurally impossible.** There is only one stored edge and one writer of it (the forward path). A materialized mirror row would require an origin/skip flag to stop `forward-write → mirror-write → forward-write` recursion; single-edge has no second write to loop. **We reject the materialized-mirror alternative explicitly.**

## 3. Contract — how a field declares it is bidirectional

Extend the **existing `link` field type** (`LinkFieldConfig`, `univer-meta.ts:870`) — do **not** add a new field type. Reusing the type keeps codecs, `buildLinkSummaries`, and the frontend link renderer (`apps/web/src/multitable/components/MetaLinkPicker.vue`, `MetaFieldManager.vue`) all reusable; a new type would multiply the surface and break the tight-slice goal.

Added config (both promoted explicitly in the codec at `:1538`, same as `foreignBaseId`, so they round-trip the wire):

- **Forward field `F_A`** (on sheet 1): `twoWay: true` + `mirrorFieldId: <id of B's mirror field>`.
- **Mirror field `F_B`** (on sheet 2): a `link` field with `foreignSheetId = <sheet 1>`, `twoWay: true`, `mirrorFieldId: <F_A>`, and a **read-only marker** `mirrorOf: <F_A>` distinguishing it as the *derived* side.

**Pairing lifecycle (MVP): explicit pairing, not auto-create.** The mirror field `F_B` is created/referenced by an explicit authoring step that writes both `mirrorFieldId` cross-references at once (validated symmetric: `F_A.mirrorFieldId === F_B.id` ∧ `F_B.mirrorFieldId === F_A.id`). Auto-create-on-toggle UX is deferred (§7). This makes the MVP a pure contract + read-projection slice with no field-mutation UX surface.

## 4. Sync semantics + loop-prevention (task point 2)

Under single-edge there is **no data to "sync"** — the forward write path (`record-service.ts:590`/`:999`) is **unchanged**, and the mirror is computed on read. So this requirement reduces to **realtime consistency**, not write-back:

> A write to A's link changes what B's mirror *resolves to*, so the affected mirrored records must be invalidated.

- **Where:** at the forward link-write sites (`record-service.ts:590` insert and `:999` update diff), collect the affected `foreign_record_id`s (the `toInsert` ∪ `toDelete` set for a `twoWay` field) and feed them into the **existing FOL-1 related-record invalidation fan-out** — `computeDependentLookupRollupRecords` (`record-write-service.ts:298`) and the Yjs invalidator (`record-service.ts:423`). Those records live on the mirror's sheet (sheet 2); their mirror projection changed.
- **Why no loop:** that fan-out is **read-invalidation, not a write-back**. It re-publishes / invalidates the mirrored records' cached state; it never issues a forward link write. The recursion that a materialized mirror would need to guard against simply does not arise.

## 5. MVP slice scope (the FIRST reviewable PR)

**One-liner:** paired-field schema + read-only reverse resolution on the mirror (a read-projection of the existing edge) + forward-write invalidation fan-out to the mirrored records.

In scope:
1. `LinkFieldConfig` extension (`twoWay`, `mirrorFieldId`, `mirrorOf`) + explicit codec promotion at `:1538`.
2. Symmetric-pairing validation in the field create/patch path (alongside `validateLinkFieldConfig`, `:1097`): both `mirrorFieldId` references must agree and point at `link` fields on each other's sheets.
3. **Read-side reverse resolution**: when loading a mirror field, resolve `WHERE field_id=mirrorOf AND foreign_record_id=<this record>` and surface the resulting source records through the **same `buildLinkSummaries` machinery** (with foreign/source roles swapped — see §6).
4. Forward-write invalidation fan-out to mirrored records (§4).
5. OpenAPI parity update (the new config fields hit `verify:multitable-openapi:parity`) + a wire round-trip test.

Explicitly deferred (note as later slices, each its own opt-in):
- **Editing from the mirror side** (post-MVP). Because the edge is single, the write-through is "edit the same edge from B's perspective" (`record_id=B`-style insert under `F_A`) — still no loop. MVP mirror is **read-only**.
- **Auto-create-on-toggle UX** for the mirror field.
- **Cross-base bidirectional** (mirror across the ②a/②b wall).
- **Delete / unpair edge cases** beyond what the existing `record-service.ts:714` cascade already covers (e.g. deleting `F_A` should also unset `F_B.mirrorFieldId` — flagged, deferred).
- **Rollup / lookup over a mirror field.**

## 6. Interactions

- **②a / ②b wall + cross-base (MVP = same-base only).** The reverse read makes **sheet 1 the "foreign" sheet from B's side**. It must reuse `buildLinkSummaries`' gates with source/foreign roles swapped: `resolveReadableSheetIds` (`:3632`), the Sink B-1 cross-base base-read gate (`:3634`), and display-field masking (`:3652`). **Same-base MVP** makes the cross-base base-read gate trivially pass, so the swap is exercised but the cross-base branch stays untouched/deferred. The pairing validator rejects a `twoWay` link whose two sides are cross-base.
- **Permissions / mirror visibility.** The mirror is the same `link` field type, so it inherits field-level `field_permissions` (visible/editable) for free. The *content* it surfaces (source records on sheet 1) is gated by the swapped `buildLinkSummaries` chain above — an actor without read on sheet 1 sees a **masked** mirror, not a leak. (Mirror is read-only in MVP, so no editable concern.)
- **Lookup / rollup over a mirror.** A mirror field *is* a `link` field, so in principle a lookup/rollup could target it. **Deferred and out of MVP scope** — the FOL fan-out is wired for the *forward* link's dependents; a rollup-over-mirror would need the reverse-edge dependency graph, which is a later slice. The MVP does not claim it works.

## 7. Decisions + defaults (for adoption under delegation)

1. **Pairing: explicit pairing — DEFAULT.** Mirror field references `F_A`'s id and `F_A` references it back; both written/validated together. (Rejected for MVP: auto-create-on-toggle — deferred as UX.) Rationale: keeps the first PR a pure schema + read-projection slice, no field-mutation UX.
2. **Base scope: same-base only — DEFAULT.** Defer cross-base bidirectional behind the ②a/②b wall. Rationale: the base-read gate is trivially satisfied; cross-base reverse needs the full Sink B-1 swap proven, which is its own gated slice.
3. **Cardinality / many-to-many: mirror is inherently multi-value — DEFAULT.** Many A's may link one B, so B's mirror is always a multi-value list. `limitSingleRecord` constrains **only the authoring (forward) side**; the mirror ignores it. Rationale: it's a read-projection of however many edges point at B; capping it would hide real relationships.

## 8. Fail-first test matrix (MVP)

1. **Reverse resolves.** A (sheet 1) links B (sheet 2) via two-way `F_A` ⇒ reading B surfaces A through B's mirror field `F_B`.
2. **Add-then-remove reflects, no stale.** Remove the A→B link ⇒ B's mirror no longer shows A (no stale projection).
3. **Forward write fans invalidation.** A forward link write to `F_A` triggers the FOL-1 invalidation fan-out for the affected mirrored records on sheet 2 (assert the invalidation/recompute set includes B), and issues **no** forward link write back (loop-free).
4. **Wire round-trip.** Create a two-way link field, read it back ⇒ `twoWay` + `mirrorFieldId` (and `mirrorOf` on the mirror) survive serialization (wire-vs-fixture: real create→read, not a hand-built fixture).
5. **Cross-base pairing rejected.** Attempting to pair two `link` fields whose sheets are cross-base ⇒ rejected (400), and a cross-base reverse summary is masked/omitted (Sink B-1 swap), never leaked.
6. **Delete clears the edge.** Deleting B ⇒ A's forward `F_A` no longer lists B (relies on `record-service.ts:714` cascade) — and the symmetric reverse is gone.
7. **Masked mirror.** An actor without read on sheet 1 reading B ⇒ B's mirror is masked (no source-record id/display leak), per the swapped `buildLinkSummaries` perm chain.

## 9. Deferred summary (do NOT build without a named opt-in)

Editing from the mirror side · auto-create-on-toggle UX · cross-base bidirectional · `F_A`-delete → `F_B.mirrorFieldId` unset & delete/unpair edge cases · rollup/lookup over a mirror field.
