# Global History / point-in-time-restore line — remaining-dev plan, design & verification

Grounding: `origin/main` 2026-06-25, after the non-destructive line + the debrand/runbook closeout. This doc answers
"what dev remains, planned for parallel work, with design + verification" — and is the **sign-off vehicle** for the two
items that stay gated.

## 0. Completable-vs-gated split (the discipline that governs this plan)

Destructive / irreversible items get an **explicit, item-specific sign-off**, not a general "complete everything"
directive — the rule the whole line has followed (T8-2 was authorised by a specific "开T8-2", not by any `/goal`).
So this plan **completes what's authorised or non-destructive** and **plans + presents for sign-off** what isn't.

| Item | Nature | This plan |
|---|---|---|
| T8-2 Reset-to-T | destructive (deletes post-T-created) | **BUILT** — authorised by "开T8-2"; PR #3214, default-OFF flag |
| record-history `hasMore` keyset | non-destructive (read perf) | **BUILDING** — completable, no semantics change (§3) |
| Undelete-execute (resurrect + link-rebuild) | irreversible-adjacent / corruption-risk | **GATED** — plan + sign-off ask (§4a) |
| T9-W data-loss config ops (field undelete / lossy retype) | irreversible | **GATED** — plan + sign-off ask (§4b) |

## 1. Line status — all non-destructive dev merged

Read (record history T1–T7 + config history T9 R3/R4 + retention + config-history `hasMore`); write (config-restore
T9-W signed-identity-gated + non-destructive T8-1 Revert, `canManageSheetAccess` + size-ceiling); hardening (both [P1]
fixes, BS-3.1 all-or-nothing batch restore, R4 diff-render + wire test); docs (canonical design+verification #3178,
debranded historical docs #3192, acceptance runbook #3196). base-config history resolved N/A.

## 2. T8-2 Reset-to-T — BUILT (PR #3214, behind default-OFF flag)

**Design.** Reset = T8-1 Revert (revert survivors to their state at T) **+ soft-delete the records created after T**.
Routes `reset-preview` / `reset-execute` alongside the revert routes. D1 default-OFF flag `MULTITABLE_ENABLE_PIT_RESET`
(off → 403 `RESET_DISABLED`); D2 `canManageSheetAccess`; D3 reuse `SHEET_REVERT_MAX_RECORDS` ceiling (413); D4 typed
`confirm:'reset'` (400 if absent); D5 whole-sheet.

**Safety properties.**
- *Soft-delete, not raw DELETE* — post-T-created records → `meta_records_trash` via `RecordService.deleteRecord`
  (recoverable, writes a revision), matching the recycle-bin convention.
- *Identity binds the delete-set* — the signed `restore-preview-pit-reset` identity binds `revertScopeHash` +
  `deleteScopeHash`; execute re-enumerates the delete-set and compares → a record created between preview and execute
  diverges → 409, nothing deleted. Prevents deleting a record the actor never saw.
- *PIT-2 all-or-nothing preflight* — every revert AND every delete target permission/lock-checked before any write;
  one blocker → 409 `RESET_BLOCKED`, zero writes (no partial-skip, unlike Revert).
- *Atomicity — honest* — revert-first (one `patchRecords` txn) / delete-second (`deleteRecord` per target).
  `patchRecords` owns its txn, so this is **not** single-tx "untouched"; a delete-phase failure → 500
  `RESET_DELETE_INCOMPLETE`, sheet **data-safe** (reverts applied + remaining post-T records intact-or-in-trash,
  re-runnable to convergence). Stated as such, not overclaimed.

**Verification.** 10/10 real-DB goldens (flag-off inert · flag-on soft-delete+revert · PIT-2 zero-writes · ceiling 413 ·
confirm-absent 400 · delete-set-divergence 409 · revert-first atomicity · PIT-7 no-reveal · D2 editor-forbidden). T8-1
revert suite 8/8 unregressed. tsc 0. Independently reviewed; the **PIT-2 golden is mutation-proven** (neutering the
lock check makes golden (c) fail). **Status: awaiting owner review/merge of #3214 + a separate decision to flip the
flag in any real env.**

## 3. record-history `hasMore` keyset estimate — BUILDING (completable, no semantics change)

The estimate path early-stops a keyset scan to answer "more than offset+limit VISIBLE batches?" without the exact
total. The deferred parity bug (estimate walks µs-DESC; exact path orders same-millisecond batches by
ms-truncated-time + batchId) is resolved **without changing shipped behavior**: the estimate collects the *complete*
same-millisecond cluster at the page boundary, then sorts by the **existing** exact-path comparator and slices — so its
page matches the exact path's, no ordering "decision" required. LOCK-3 leak-guard preserved (mutation-checked).
*(Verification to be appended on landing.)*

## 4. GATED remaining dev — plan + sign-off ask

### 4a. Undelete-execute (resurrect + `meta_links` rebuild)
**What** — execute the deferred T8-1 *undelete* (records that existed at T, deleted since): resurrect from
`meta_records_trash` + rebuild `meta_links`. **Why gated** — link-rebuild mutates the live link graph; resurrecting
against since-deleted or since-changed targets can create dangling refs / stale relationships (corruption risk), so it
needs its own design pass, not a parallel fork. The canonical readiness doc files it under "adjacent
destructive/irreversible items, same gate, same ask." **Ask** — explicit sign-off + a link-integrity design (how to
handle targets that no longer exist at resurrection time) before any build.

### 4b. T9-W data-loss config ops (field undelete / lossy retype)
**What** — field *undelete* and *lossy retype* in config-restore. **Why gated** — field undelete is largely
*impossible* as a true undo (the column data is already gone, not recoverable); lossy retype is irreversible
data-loss. Refused `422` today. **Ask** — explicit sign-off; field-undelete likely depends on the wider undelete slice
(4a) and may be only partially achievable (schema restored, values not).

## 5. Bottom line
T8-2 (authorised) is built + verified + behind a default-OFF flag awaiting your review/merge; `hasMore` (non-destructive)
is being completed in parallel. Undelete-execute and T9-W data-loss remain **gated on an explicit, item-specific
sign-off** — this doc resolves their design questions so each is a concrete yes/no when you choose.
