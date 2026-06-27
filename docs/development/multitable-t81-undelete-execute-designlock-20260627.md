# T8-1 undelete-execute (PIT Revert undelete) — DESIGN-LOCK (PROPOSED)

**Date:** 2026-06-27 · **Type:** Time Machine write-slice design-lock, narrowed v1. Locks scope + the per-decision bars **before any runtime code**. Docs-only.

## The gap
The version / PIT-restore path currently **refuses** to resurrect a deleted record:
- `univer-meta.ts:8000` — "Version … is a delete revision; undelete preview is not supported in this slice"
- `univer-meta.ts:8102` — `if (rev.action === 'delete') … skipReason:'unsupported'  // undelete is a later slice`
- `univer-meta.ts:8238` — `RESTORE_UNSUPPORTED` ("undelete is not supported in this slice")

T8-1 turns the **PIT Revert** path's undelete-refusal into a real resurrect-execute. It reuses existing machinery (the restore outbound-link rebuild + the bound-token preview→confirm discipline) — it is *wiring a gated resurrect*, not inventing restore. This is the foundation for T9-W Tier 4 (field undelete).

## v1 surface — LOCKED NARROW (do not blanket-open undelete)
- **IN:** **PIT Revert undelete only** — a sheet Revert-to-T where a record's target state at T is "exists" but it is currently deleted → resurrect it.
- **OUT — each a separate, explicit later decision (NOT opened here):** single-record restore undelete · batch restore undelete · **PIT Reset** undelete.

## Locked decisions
- **L1 — Resurrect the ORIGINAL record id** (so inbound references can resolve). **id-collision → reject** (id re-created since delete → 409/abort; never overwrite a live record).
- **L2 — Preview-identity binds the resurrect-set + target snapshot/version/hash**, separately from the revert hash. Execute **re-enumerates** the resurrect-set; any drift (a record un/re-deleted, snapshot moved) → **409**. **MUST NOT reuse the existing revert hash** — it does not cover the resurrect-set.
- **L3 — Outbound links rebuilt from the resurrected snapshot** — reuse the existing restore rebuild (`record-service.ts:990`, "rebuild outbound meta_links from the restored snapshot").
- **L4 — Inbound links = THE core locked decision, gated on #3306.** Delete drops **both** directions in-txn (`record-service.ts:793`: `DELETE FROM meta_links WHERE record_id=$1 OR foreign_record_id=$1`); the resurrected record's own snapshot carries **only outbound**. Inbound edges (other records that linked *to* it) are gone and live in the OTHER records' data. Decide:
  - **(A) Lazy / repair-on-read (recommended, lightest):** don't re-materialize inbound in the undelete txn. The other records still hold the id in their link-field data; once resurrected, that reference is valid again. **Relies on #3306's repair-on-read** (`loadLinkValuesByRecord` filters dangling edges by `foreign_record_id EXISTS`), so the reference re-surfaces correctly on the other records' next read/write.
  - **(B) Eager re-materialize:** scan records whose link-field data references the resurrected id and re-insert `meta_links` edges in the undelete txn. Heavier; **overlaps #3306's repair scope** (double-handling risk).
  - **HARD DEPENDENCY:** **re-check #3306 (cross-base dangling-link repair — repair-on-read + sheet-delete cascade, currently OPEN/BLOCKED) before runtime.** It moves the dangling/ghost boundary that (A) depends on: if #3306 lands, (A) is clean; if not, (A) can leave unfiltered ghosts. (Note: #3306 already established `deleteRecord` cascades both directions, and `foreign_record_id` has no FK — deliberate.)
- **L5 — Permission + flag + typed confirm.** Default-OFF flag (proposed `MULTITABLE_ENABLE_PIT_UNDELETE`); cap = `canDeleteRecord`/`canEditRecord` (lock the exact one); reuse the T8-2 preview→typed-confirm pattern (resurrecting data is destructive-adjacent).
- **L6 — Single-transaction atomicity.** Resurrect + outbound rebuild + (L4 inbound) + audit/revision in ONE `pool.transaction`; any guard trip → zero writes.
- **L7 — Append-only forward record + realtime.** Append an undelete revision (`source='restore'`, `restoredFromId`, action reflecting the resurrect); emit the realtime create event for the resurrected record (+ link invalidation per L4).

## Test matrix (gated on ratification)
flag-off → refused · permission gate → 403 · happy resurrect (original id kept, outbound rebuilt) · **id-collision → reject/409, no overwrite** · **preview-identity drift** (resurrect-set changed between preview & execute) → 409 · **inbound per the L4 decision** (ghost-then-valid under (A), or re-materialized under (B)) · single-transaction atomicity rollback (forced mid-write failure → zero writes) · audit/undelete revision appended · realtime create event · **idempotency** (undelete a live record → no-op/reject).

## Out of scope
single-record / batch restore undelete · PIT Reset undelete · T9-W Tier 3 un-create / Tier 4 field-undelete / permission-revert · base-delete cascade (no product-level base-delete route).

## Open questions (owner)
1. **L4 inbound** — (A) lazy/repair-on-read (recommended) vs (B) eager re-materialize?
2. **L5** — exact cap (`canDeleteRecord` vs `canEditRecord`) + flag name.

## Runtime gate (implementation may NOT start until all hold)
1. This lock ratified — especially the **L4** inbound decision.
2. **#3306 re-checked / merged** (it moves the inbound/dangling boundary).
3. No live parallel undelete session (the named `claude/t8-1-revert-to-t-20260624` is merged #3165 / stale — not a competitor).
