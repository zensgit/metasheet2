# T8-1 undelete-execute (PIT Revert undelete) — development & verification

**Date:** 2026-06-27 · **Design-lock:** `multitable-t81-undelete-execute-designlock-20260627.md` (#3307, ratified; test-matrix hotfix #3310). **Flag default-off** (`MULTITABLE_ENABLE_PIT_UNDELETE`).

## What was built
PIT **Revert**-to-T now resurrects records that existed at T but are deleted now. The path **already classified** these (`computeSheetRevert` counted them; `revert-preview` reported `undeleteSupported:false`; `revert-execute` ignored them) — this enables their execute behind the flag, non-breaking when off.

- **`computeSheetRevert`**: collects a **resurrect-set** `{recordId, snapshot, snapshotHash}` from `reconstructRecordsAtT`'s **full unmasked T-snapshot** (not the masked revert diff — undelete re-creates the whole record; read-masking still applies on later reads). Denied records are skipped (no oracle).
- **Identity (L2)**: `mintPitRevertPreviewIdentity` now also binds **`resurrectScopeHash`** (`hashResurrectSet` = recordId + T-snapshot hash; a deleted record has **no live version**, so the snapshot hash is the per-record anchor). Execute re-enumerates → **409** on any drift to the resurrect set.
- **`revert-execute`**: when resurrects present → default-off flag (403 `UNDELETE_DISABLED`) + **`canDeleteRecord`** floor (403 `FORBIDDEN`; never `canEditRecord` — `canDeleteRecord===canWrite`, tested via a share-only actor) + typed **`confirm:'undelete'`** (400 `CONFIRM_REQUIRED`). Then resurrect each in **one `pool.transaction`** (L6 all-or-nothing): `FOR UPDATE` id-collision reject + `INSERT` full T-snapshot under the **original id** (unique-violation → 409 `UNDELETE_CONFLICT`, no overwrite) + **outbound** `meta_links` rebuild from the snapshot (L3) + a `'restore'` create-revision; realtime create events post-commit (L7). **No inbound** rebuild (L4 A). *(Resurrect runs FIRST — see the pre-rollout fixes below.)*

## Two design-lock corrections the implementation grounding surfaced
1. **Inbound (already corrected in #3307/#3310):** #3306's repair-on-read *filters* dangling edges; it does **not** re-create the inbound edges delete removed. Inbound re-appears when the **linking record is next saved** — golden (f) pins this (undelete writes zero inbound edges; the linking record's data still references the resurrected id).
2. **Resurrect from T-snapshot, NOT `restoreRecord` (trash):** `restoreRecord` resurrects the *delete-time* trash state (≠ T-state for a modified-then-deleted record) and opens its own txn. So the resurrect inserts `reconstructRecordsAtT`'s **T-snapshot** directly, reusing `restoreRecord`'s collision/outbound/revision *pattern* inside the execute txn. (Avoids a latent data-loss + trash-retention dependency.)

## Pre-rollout review fixes (follow-up PR — required before enabling the flag)
Post-merge adversarial review of #3311 found 4 issues (flag-off on main was safe; these gate enablement). All fixed:
1. **Unified cap** — the ceiling counted live rows only; few-live + large-deleted-history could resurrect past `SHEET_REVERT_MAX_RECORDS`. Now `reverts+resurrects` is re-checked post-scan → 413.
2. **Resurrect schema-drift guard** — the resurrect branch lacked the revert path's drift check, so a T-snapshot with a removed field could write a stale key into `meta_records.data`. Now drift-rejected (excluded → re-preview), parity with reverts.
3. **`source:'restore'`** (was `'rest'`) — Time-Machine undeletes no longer show as plain REST creates in history/audit (`RecordRevisionSource` allows it via `| string`).
4. **No partial / reorder** — the resurrect transaction now runs **FIRST**; a resurrect failure aborts the request (409/500) with **zero writes**, *before* any field-revert is applied. Eliminates the "reverts applied + undelete failed" partial.

New goldens (i)–(l): source=restore · drift-not-resurrected · unified-cap 413 · undelete-fails→revert-not-applied.

## Mixed semantics (real behavioral note)
After the reorder: **resurrects run first, atomically** (all-or-nothing; a failure aborts the whole request with zero writes). Field-**reverts** then run best-effort per-record (skip-on-conflict). The only residual is the *forward* direction — if resurrects succeed and a later revert skips on conflict, the request returns 200 with that record marked `skipped` (never a silent partial of the destructive-adjacent resurrect).

## Verification
| What | How | Status |
|---|---|---|
| Impl + golden type-safety | `tsc --noEmit` | ✅ 0 errors (local) |
| Real-DB goldens (a–l, 13 tests) | `multitable-undelete-pit-realdb.test.ts`, **registered in `plugin-tests.yml`** (multitable real-DB job) | ⏳ run in CI (no local postgres) |
| Coverage | (a) flag-gated preview signal + `undeleteRecordIds` · (b) flag-off → 403 · (c) `canDeleteRecord` floor → 403 (share-only) · (d) typed-confirm 400-then-OK · (e) happy resurrect: original id + **full T-snapshot** + create-revision · (f) **inbound (A)**: outbound (U→L) **rebuilt** (proves the rebuild ran) while inbound (→U) **stays absent** despite the other record's data referencing U (a naive inbound-rebuild would fail this) · (g) id occupied between preview/execute → 409, no overwrite (via re-enumeration drift; in-txn `FOR UPDATE` is the TOCTOU backstop) · (h) drift (re-execute after live) → 409 · **(i)** resurrect revision `source='restore'` (fix#3) · **(j)** schema-drift T-snapshot **not** resurrected (fix#2) · **(k)** unified cap: live=1 passes the early ceiling, 3 resurrects exceed it → 413 (fix#1) · **(l)** forced resurrect failure aborts **before** the field-reverts → revert candidate R stays `'B'` (fix#4 reorder) | ✅ written |
| (k) right-reason | ceiling pinned to **2 at router creation** (`beforeAll`, before `univerMetaRouter()` — it's captured once, not per-request); (k) seeds 3 resurrects against **1** live row, so the **only** route to 413 is the post-scan unified check, not the early live-count ceiling. (l)'s trigger fires `WHEN (NEW.id = U)` → fails the *resurrect* specifically; R is a genuine revert candidate (`A`@T ≠ `B`now) | ✅ verified |
| Revision version | checked `meta_record_revisions` — **no `UNIQUE(record_id, version)`** (only PK on `id` + a non-unique index), so the fresh `v1` resurrect revision doesn't collide with U's existing v1/v2 (matches `restoreRecord`) | ✅ verified |
| **Honest gaps** | (1) goldens are CI-proven, not local (no postgres) — same as #3301; **watch golden (e)** specifically (the resurrect write). (2) **Atomicity-across-multiple-resurrects forced-failure golden** (T8-2-style trigger) is a recommended follow-up — the single `pool.transaction` makes it all-or-nothing by construction, but it isn't golden-pinned yet. (3) the in-txn `FOR UPDATE`/unique-violation→409 path is the TOCTOU backstop, not golden-covered (drift catches the common case). (4) **Flag-on live smoke** before rollout. | ⬜ stated |

## Scope
**PIT Revert undelete only.** Single-record / batch restore undelete · PIT **Reset** undelete · T9-W Tier 3 un-create / Tier 4 field-undelete / permission-revert — each a separate gated slice. Enabling `MULTITABLE_ENABLE_PIT_UNDELETE` stays a runbook step.
