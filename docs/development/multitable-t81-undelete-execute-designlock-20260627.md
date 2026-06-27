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
- **L4 — Inbound links → LOCKED = (A) lazy** (owner-ratified 2026-06-27; **(A) mechanism corrected by the post-merge #3306 re-check — see the corrected sub-bullet**). Delete drops **both** directions in-txn (`record-service.ts:795`: `DELETE FROM meta_links WHERE record_id=$1 OR foreign_record_id=$1`); the resurrected record's snapshot carries **only outbound**, and the deleted inbound edges live only in the OTHER records' data. The undelete txn restores **only the deleted record itself + its snapshot's outbound links** — it does **NOT** re-materialize inbound.
  - **(A) re-appearance — CORRECTED by the #3306 re-check (was over-stated):** `loadLinkValuesByRecord` reads from `meta_links`, not data, and the inbound edges were *deleted* on delete. So an inbound link re-materializes when the **linking record is next SAVED** (its data→`meta_links` outbound rebuild) — **NOT** via #3306's repair-on-read. #3306's repair-on-read only **filters** still-dangling edges (no ghost id surfaces in the interim); it does **NOT re-create** edges that delete removed. **v1 behavior to accept:** after undelete, inbound links *to* the resurrected record stay absent until each linking record is re-saved (a later eager/rematerialize slice could close this — explicitly out of v1).
  - **Rejected: (B) eager re-materialize** (scan + re-insert inbound edges in-txn) — it would turn T8-1 into a cross-table link-repair subsystem; risk/cost disproportionate, and it overlaps #3306's repair scope (double-handling).
  - **HARD DEPENDENCY — #3306 NOW MERGED (`c39ebc2b4`), re-check DONE:** repair-on-read + sheet-delete cascade landed and tested (its test (a): a dangling inbound edge is NOT surfaced as a ghost id). The re-check corrected the (A) mechanism above; **no remaining #3306 code blocker**, but the *v1 inbound-absent-until-resave* behavior needs an explicit owner OK before runtime.
- **L5 — Permission + flag + typed confirm (LOCKED, owner-ratified 2026-06-27).** Default-OFF flag **`MULTITABLE_ENABLE_PIT_UNDELETE`**. Permission: the PIT Revert route's existing **`canManageSheetAccess` is retained**, AND the undelete-specific floor is **`canDeleteRecord`** (delete-equivalent) — **never lowered to `canEditRecord`** (this is anti-delete / record resurrection, not normal edit). Reuse the T8-2 preview→typed-confirm pattern (resurrecting data is destructive-adjacent).
- **L6 — Single-transaction atomicity.** Resurrect + outbound rebuild + (L4 inbound) + audit/revision in ONE `pool.transaction`; any guard trip → zero writes.
- **L7 — Append-only forward record + realtime.** Append an undelete revision (`source='restore'`, `restoredFromId`, action reflecting the resurrect); emit the realtime create event for the resurrected record (+ link invalidation per L4).

## Test matrix (gated on ratification)
flag-off → refused · permission gate → 403 (incl. a `canEditRecord`-only actor → 403; floor is `canDeleteRecord`) · happy resurrect (original id kept, outbound rebuilt) · **id-collision → reject/409, no overwrite** · **preview-identity drift** (resurrect-set changed between preview & execute) → 409 · **inbound (A): remains absent after undelete until the linking record is re-saved; no ghost id surfaces; undelete txn writes no inbound edge** · single-transaction atomicity rollback (forced mid-write failure → zero writes) · audit/undelete revision appended · realtime create event · **idempotency** (undelete a live record → no-op/reject).

## Out of scope
single-record / batch restore undelete · PIT Reset undelete · T9-W Tier 3 un-create / Tier 4 field-undelete / permission-revert · base-delete cascade (no product-level base-delete route).

## Decisions — RESOLVED (owner-ratified 2026-06-27)
1. **L4 inbound** = **(A) lazy / repair-on-read** (no eager cross-table rebuild). Precondition: #3306 merged + re-checked.
2. **L5** = flag **`MULTITABLE_ENABLE_PIT_UNDELETE`** + existing PIT-Revert **`canManageSheetAccess`** retained + undelete floor **`canDeleteRecord`** (never `canEditRecord`).

No open design questions remain. Scope is ratified; this lock holds pending the runtime gate below.

## Runtime gate (implementation may NOT start until all hold)
1. Lock ratified ✅ — **plus a new owner OK** on the corrected v1 inbound behavior (inbound links stay absent until the linking records are re-saved; not auto-restored by undelete or by #3306's repair-on-read).
2. #3306 merged + re-checked ✅ — **DONE**: merged `c39ebc2b4`; the re-check corrected the L4 (A) mechanism (above). No remaining #3306 code blocker.
3. No live parallel undelete session — `claude/t8-1-revert-to-t-20260624` is merged #3165 / stale; re-confirm no *fresh* session before opening runtime.
