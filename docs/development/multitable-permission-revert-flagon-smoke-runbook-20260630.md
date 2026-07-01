# Permission-revert flag-on smoke — runbook + verification

**Date:** 2026-06-30  **Grounding:** `origin/main @ f14be042e` (includes #3402 forward-route lock + #3414 legacy-route lock)
**Flag:** `MULTITABLE_ENABLE_PERMISSION_REVERT`
**Scope:** staging/sandbox enablement only. **Prod flag is NOT changed by this work.** This document is a runbook + verification evidence; the staging flip itself is an operator action gated on owner sign-off.

> What enabling this flag turns on: reverting a `permission` config-revision via `POST /sheets/:id/config-restore-preview` + `…/config-restore-execute`. It is **de-escalation-only**, on top of the `canManageSheetAccess` capability floor, a typed `revert-permission` confirm, a server-minted preview-identity token, and (now) two-sided concurrency serialization across all `spreadsheet_permissions` writers.

---

## 1. Pre-enable state (what the gate protects)

With the flag **off** (default), both routes return `403 PERMISSION_REVERT_DISABLED`. The flag is the *outermost* gate; underneath it the path is constrained by, in order:

1. **Capability floor** — `canManageSheetAccess` (admin or `multitable:share`); precedes the flag check, so a non-privileged actor 403s even with the flag on.
2. **Typed confirm** — body must carry `confirm: "revert-permission"`, else `400 CONFIRM_REQUIRED`.
3. **Preview identity** — execute requires a server-minted `previewToken` binding the live grant hash; a changed grant → `409 GRANT_DRIFT`, an expired token → `410`.
4. **De-escalation-only** — the apply re-checks `permissionRevertDirection(before, LIVE)` against the **current** live grant; escalation/no-op → `422 RESTORE_NOT_SUPPORTED`.
5. **Concurrency serialization** — the execute path holds `meta_sheets … FOR UPDATE`; **all** forward writers of the grant tables now take the same lock (multitable forward routes #3402, legacy grant/revoke #3414), so no concurrent write can interleave a re-checked de-escalation into a net escalation.

## 2. Verification (the 5 smoke points) — evidence

Run on a fresh real Postgres at current main; the goldens self-set the flag per test, so one run exercises both flag-on and flag-off contracts. **Three-PR combined integration** (`multitable-permission-revert-realdb.test.ts` which contains #3402's `(m)`, plus `multitable-legacy-permission-route-lock-realdb.test.ts` = #3414) — **17/17 passed** in a single invocation (the first time the three PRs are verified together post-#3414-merge).

| # | Smoke requirement | Verified by | Result |
|---|---|---|---|
| 1 | de-escalation **executable** | (c) sheet admin→read, (d) revoke (before=null), (i) field read-write→read-only, (j) view admin→read | 200 + grant lowered/removed |
| 2 | escalation / noop **still 422** | (e) escalation, (f) noop, (g) live-recheck (deceptively-high recorded `after`) | 422 `RESTORE_NOT_SUPPORTED`, grant unchanged |
| 3 | typed confirm **effective** | (k) missing/wrong confirm → 400 `CONFIRM_REQUIRED`; `revert-permission` → 200 applied | pass |
| 4 | audit / `source=restore` **correct** | (c) asserts a `source='restore'` permission revision back-referencing the reverted revision (`restored_from_id`) | `restoreRevCount = 1` |
| 5 | **concurrency gate does not regress** | (h) `GRANT_DRIFT` on drift; (m) #3402 forward grant parks under a held `FOR KEY SHARE`; #3414 legacy (a) grant + (b) revoke park | pass |
| — | flag-**OFF** contract still holds | (a) flag-off → 403 both routes; (b) capability floor 403 even with flag on | pass |

The concurrency row is the load-bearing addition: it confirms the three independently-merged locking PRs **coexist** and the never-escalate-under-concurrency property holds end-to-end on current main, not just per-PR at merge time.

## 3. Operator runbook — enable in staging/sandbox

**Enablement detail that changes restart assumptions:** the flag is read **per-request directly from `process.env`** (`univer-meta.ts:8084` preview, `:8297` execute) — there is **no in-app config cache**. So:

1. **Enable:** set `MULTITABLE_ENABLE_PERMISSION_REVERT=true` in the staging service's environment/deployment config and **restart/redeploy** the service (the value is captured at process launch; a running process won't pick up a newly-set env var without restart). No cache-bust step is needed beyond the restart.
2. **Smoke (post-enable, against the running staging instance):** as a `canManageSheetAccess` actor, on a throwaway sheet —
   - preview + execute a **de-escalation** (e.g. admin→read) → expect 200 + the grant lowered;
   - attempt an **escalation** revert → expect 422 `RESTORE_NOT_SUPPORTED`, grant unchanged;
   - execute **without** the typed confirm → expect 400 `CONFIRM_REQUIRED`;
   - confirm a `source='restore'` permission revision was recorded for the de-escalation;
   - re-preview then change the grant out-of-band before execute → expect 409 `GRANT_DRIFT`.
3. **Rollback:** unset `MULTITABLE_ENABLE_PERMISSION_REVERT` (or set to anything other than `true`) and restart → both routes return to `403 PERMISSION_REVERT_DISABLED`. The flag toggles behavior only; it persists no state, so rollback is clean and immediate (no data migration, no cleanup).

## 4. Scope / guards / recommendation

- **Staging/sandbox only.** Do **not** change the prod flag as part of this; prod enablement is a separate, later owner decision.
- Enabling exposes a **narrow, de-escalation-only** capability (it can only *reduce* a subject's access, never raise it), behind four independent gates + the capability floor — not a broad new surface.
- No schema change, no migration, no default change. The flag is the only lever; rollback is unset+restart.

**Recommendation:** the runtime, the four gates, and the cross-PR concurrency serialization are verified; the flag is **ready for staging/sandbox enablement on the operator's go**. Prod remains a separate decision. No code change ships with this runbook — it is verification + procedure only.
