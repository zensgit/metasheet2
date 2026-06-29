# T9-W Tier 4 (U-4) config-undelete — development & verification

**Date:** 2026-06-28 · **Design-lock:** `multitable-t9w-tier4-undelete-designlock-20260628.md` (#3338, **ratified + merged**, squash `b3825b08b`; v1 forks ratified: definition-only · original-order · lazy view re-integration). **Flag default-off** (`MULTITABLE_ENABLE_CONFIG_UNDELETE`). Built on the merged Tier 3 un-create (#3335).

## What was built
The inverse of Tier 3: reverting a field/view `delete` revision **recreates** the entity from its `before` config, behind a default-off flag. `classifyRevert` routed `delete`-reverts to `gated`→422; this opens the field/view subset via a pure `isSupportedUndelete`. **Per-revision, definition-only, original-order, lazy view re-integration** (the design-lock's recommended forks).

## Locked decisions → implementation
- **U4-L1 / U4-L4 — per-revision, NOT whole-batch.** Recreates only the one entity; does not auto-reverse the delete's sibling order-shifts/view-cleanups (which would clobber post-delete edits).
- **U4-L2 — recreate from `before`, original order.** `recreateFieldFromConfig` shifts trailing fields `+1` (`UPDATE meta_fields … "order" >= insertOrder` + `recordFieldOrderShifts(…, +1)`) — the inverse of the delete's `−1` — then `INSERT meta_fields` from `before` at `before.order`. `recreateViewFromConfig` `INSERT meta_views` from `before`. Reuses the proven forward-create insert-in-middle pattern.
- **U4-L3 — definition-only, losses stated, lazy views.** Column **values**, **`meta_links`**, and the **auto-number** counter are NOT recovered; the field is NOT re-added to any view's config. The preview `note` says exactly this (no faking). View undelete is the clean, non-lossy case.
- **U4-L5 — plan-hash identity + id-collision + no-oracle.** Disjoint `type:'config-undelete-preview'` binds an opaque **HMAC `undeleteHash`** over the SERVER-SIDE plan `{ idFree, insertOrder, trailingShiftIds, targetConfigHash }` (never a claim/response field). Execute, under a `FOR UPDATE` id check, rejects an **occupied id → 409 `ID_COLLISION`** (also the idempotency guard) and a changed plan → **one generic 409 `PLAN_DRIFT`**. Preview is **undisclosed** (entity name + losses note + a boolean `idCollision`; no counts).
- **U4-L6 — flag + cap + typed confirm + atomicity.** `MULTITABLE_ENABLE_CONFIG_UNDELETE` (preview + execute → 403 when off); the route's entity-type cap (`canManageFields`/`canManageViews` = canWrite) is required (enforced before the branch); typed `confirm:'undelete'`; recreate + order-shift + audit in **one `pool.transaction`** (zero writes on any guard trip; recreate `23505` → 409 `ID_COLLISION` backstop).
- **U4-L7 — append-only forward `create` revision (`source='restore'`, `restoredFromId`=the delete revision id).** The undelete is itself auditable and (future) re-un-creatable.
- **U4-L8 — realtime parity:** `invalidateFieldCache`/`invalidateViewConfigCache` post-commit; no new config realtime event. `classifyRevert` stays pure; `sheet_config`/`permission` deletes still 422.

## Verification
| What | How | Status |
|---|---|---|
| Type-safety | `tsc --noEmit` | ✅ 0 errors |
| Real-DB goldens (a–n, 14 cases) | `multitable-undelete-config-realdb.test.ts`, **registered in `plugin-tests.yml`** | ✅ **green in CI** (`test (20.x)`, head `9d7ccd66`) |
| Coverage | (a) flag-off → 403 · (b) reader → 403 · (c) happy field undelete (row recreated at `before.order`; trailing shifted `+1`; `create` `source='restore'` revision) · (d) happy view undelete · (e) **definition-only** (recreated field has no record values / no `meta_links` / no auto-number) · (f) **id-collision / idempotency** (occupied id → 409, no duplicate) · (g) **plan-drift** (changed trailing set → one generic `PLAN_DRIFT`) · (h) **token/response opacity** (JWT has only `undeleteHash`) · (i) no-oracle (no count) · (j) typed-confirm · (k) **single-txn atomicity** (forced mid-recreate failure → field absent, order-shift rolled back) · (l) audit `create` revision · (m) recreate lands on the revision's `sheet_id` · **(n) held-surface tripwire** (a `permission` delete revision stays `422 RESTORE_NOT_SUPPORTED` with the undelete flag ON — the field/view-only predicate can't silently widen) | ✅ green |
| **Honest gaps** | (1) goldens CI-proven, not local — **watch (c)/(k)** (the recreate write + atomicity). (2) the field-undelete order re-insertion shifts fields created after the delete (`+1`) — faithful to original position but a behavioral choice (vs append-at-end). (3) **flag-on live smoke** before rollout. | ⬜ stated |

## Scope
**field/view `delete`-undelete only, definition-only.** OUT — each its own decision: permission-undelete (= permission-revert, the held last slice) · `sheet_config` · whole delete-batch reversal · value/link/auto-number recovery (impossible) · cross-base · FE. Enabling `MULTITABLE_ENABLE_CONFIG_UNDELETE` stays a runbook step (design-lock #3338 ratified+merged and Tier 3 #3335 on main; a flag-on live smoke remains the last pre-enablement gate).
