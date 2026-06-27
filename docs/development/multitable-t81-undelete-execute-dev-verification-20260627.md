# T8-1 undelete-execute (PIT Revert undelete) — development & verification

**Date:** 2026-06-27 · **Design-lock:** `multitable-t81-undelete-execute-designlock-20260627.md` (#3307, ratified; test-matrix hotfix #3310). **Flag default-off** (`MULTITABLE_ENABLE_PIT_UNDELETE`).

## What was built
PIT **Revert**-to-T now resurrects records that existed at T but are deleted now. The path **already classified** these (`computeSheetRevert` counted them; `revert-preview` reported `undeleteSupported:false`; `revert-execute` ignored them) — this enables their execute behind the flag, non-breaking when off.

- **`computeSheetRevert`**: collects a **resurrect-set** `{recordId, snapshot, snapshotHash}` from `reconstructRecordsAtT`'s **full unmasked T-snapshot** (not the masked revert diff — undelete re-creates the whole record; read-masking still applies on later reads). Denied records are skipped (no oracle).
- **Identity (L2)**: `mintPitRevertPreviewIdentity` now also binds **`resurrectScopeHash`** (`hashResurrectSet` = recordId + T-snapshot hash; a deleted record has **no live version**, so the snapshot hash is the per-record anchor). Execute re-enumerates → **409** on any drift to the resurrect set.
- **`revert-execute`**: when resurrects present → default-off flag (403 `UNDELETE_DISABLED`) + **`canDeleteRecord`** floor (403 `FORBIDDEN`; never `canEditRecord` — `canDeleteRecord===canWrite`, tested via a share-only actor) + typed **`confirm:'undelete'`** (400 `CONFIRM_REQUIRED`). Then resurrect each in **one `pool.transaction`** (L6 all-or-nothing): `FOR UPDATE` id-collision reject + `INSERT` full T-snapshot under the **original id** (unique-violation → 409 `UNDELETE_CONFLICT`, no overwrite) + **outbound** `meta_links` rebuild from the snapshot (L3) + a `'rest'` create-revision; realtime create events post-commit (L7). **No inbound** rebuild (L4 A).

## Two design-lock corrections the implementation grounding surfaced
1. **Inbound (already corrected in #3307/#3310):** #3306's repair-on-read *filters* dangling edges; it does **not** re-create the inbound edges delete removed. Inbound re-appears when the **linking record is next saved** — golden (f) pins this (undelete writes zero inbound edges; the linking record's data still references the resurrected id).
2. **Resurrect from T-snapshot, NOT `restoreRecord` (trash):** `restoreRecord` resurrects the *delete-time* trash state (≠ T-state for a modified-then-deleted record) and opens its own txn. So the resurrect inserts `reconstructRecordsAtT`'s **T-snapshot** directly, reusing `restoreRecord`'s collision/outbound/revision *pattern* inside the execute txn. (Avoids a latent data-loss + trash-retention dependency.)

## Mixed semantics (real behavioral note)
The handler is now **mixed**: field-**reverts** stay best-effort per-record (skip-on-conflict, as before); **resurrects** are atomic all-or-nothing. A resurrect-set failure rolls back only the resurrects (reverts already applied stand). Documented here, not buried.

## Verification
| What | How | Status |
|---|---|---|
| Impl + golden type-safety | `tsc --noEmit` | ✅ 0 errors (local) |
| Real-DB goldens (a–h) | `multitable-undelete-pit-realdb.test.ts`, **registered in `plugin-tests.yml`** (multitable real-DB job) | ⏳ run in CI (no local postgres) |
| Coverage | (a) flag-gated preview signal + `undeleteRecordIds` · (b) flag-off → 403 · (c) `canDeleteRecord` floor → 403 (share-only) · (d) typed-confirm 400-then-OK · (e) happy resurrect: original id + **full T-snapshot** + create-revision · (f) **inbound (A)**: zero inbound edges written, data still references · (g) id-collision → 409, no overwrite · (h) drift (re-execute after live) → 409 | ✅ written |
| **Honest gaps** | (1) goldens are CI-proven, not local (no postgres) — same as #3301. (2) **Atomicity-across-multiple-resurrects forced-failure golden** (T8-2-style trigger) is a recommended follow-up — the single `pool.transaction` makes it all-or-nothing by construction, but it isn't golden-pinned yet. (3) **Flag-on live smoke** before rollout. | ⬜ stated |

## Scope
**PIT Revert undelete only.** Single-record / batch restore undelete · PIT **Reset** undelete · T9-W Tier 3 un-create / Tier 4 field-undelete / permission-revert — each a separate gated slice. Enabling `MULTITABLE_ENABLE_PIT_UNDELETE` stays a runbook step.
