# Global History / Time Machine — Program Capstone (T5-2 verification + program summary)

> The capstone for the /goal「完成 timemachine 剩余开发，给设计及验证MD」. Records the final read-only leaf
> (T5-2 restore-preview) and ties together the whole program: **read-only half BUILT + verified, write half
> DESIGNED + gated.**

## 1. The final leaf — T5-2 record-version restore preview (BUILT)

`POST /sheets/:sheetId/records/:recordId/restore-preview` { targetVersion } → the masked diff a Layer-1 restore
WOULD apply, **write-free**.

- **MIRROR not extract** (deliberate): the preview re-implements the restore route's set ∪ unset diff (scalar +
  link-as-report) read-only, rather than refactoring the destructive write path. Worst-case failure is a wrong
  *preview* (display), not data corruption. The small diff helpers duplicate the restore route's route-local
  copies — a **noted P3** (unify in a follow-up); the **preview→restore consistency golden** guards against drift.
- **PV-1 write-free**: writes nothing (golden: record version + data unchanged after a preview).
- **PV-2 mask** (the security axis): the diff is filtered to the actor's allowed fields (the SAME
  `loadAllowedFieldIds` + `maskStoredRecordFieldIds` chain as history detail), so a hidden field that WOULD change
  never appears. Mutation-checked: drop the mask → the denied field leaks into the preview.
- **No-oracle**: a row-denied record previews as 404 — the same shape as missing (no existence oracle), via the
  `loadDeniedRecordIds` seam.
- **D5**: the preview is gated on the RESTORE capability (`canEditRecord`), so it isn't teased to someone who
  could never execute.
- **Reveal never composes** (no reveal path).
- **v1 scope** (D2 record-version + batch first): record-version, full-record. OUT of v1 (follow-ups): batch
  scope, strategy=reset, the reconstructor-based as-of-T preview (uses T5-1, a follow-up).
- **Verification**: 6 real-DB goldens; restore boundary **34/34 unchanged** (the route was added before restore,
  not into it); tsc 0; no migration.

## 2. The program (T5–T9) — built vs designed

| Slice | What | Status |
|---|---|---|
| **T5-1** reconstructor | as-of-T `reconstructRecordsAtT` (LOCK-9 delete-aware + LOCK-11) — the shared read root | ✅ BUILT (#2993) — 8 goldens incl. delete-at-T pin + version-null + scoped sentinel |
| **T7** PIT read-only view | "table as of T", current-deny by reuse, oracle-safe | ✅ BUILT (#3000) — 7 goldens incl. oracle-negative + mutation |
| **T5-2** restore preview | record-version preview, masked, write-free | ✅ BUILT (this PR) — 6 goldens incl. write-free + mask-mutation + preview↔restore consistency |
| **T6** scoped restore | the first WRITE; batch fan-out is a NEW permission surface (SR-2) | 🔒 DESIGN-LOCK (#2994) — gated on D1–D4 + opt-in |
| **T8** PIT restore | destructive sheet rollback; Revert vs Reset | 🔒 DESIGN-LOCK (#2994) — gated; Reset needs a SEPARATE rollback-semantics sign-off |
| **T9** config history | separate program; read-only first | 🔒 DESIGN-LOCK (#2994) — separate opt-in |

## 3. The permission spine (proven across the program)

Every read surface reuses the SAME boundary — **never re-derived**:
- row-deny = `loadDeniedRecordIds` (grant-deny ∪ 2b conditional read-deny), current-deny, admin-bypassed;
- field-mask = `loadAllowedFieldIds` + `maskStoredRecordFieldIds` (visible ∧ field_permissions, taint-dropped);
- field-audit reveal NEVER composes with reconstruct / preview / restore (LOCK-7 by construction);
- the **oracle rule** (T7): current-deny, so a record public-at-T-but-denied-now is never an oracle.

Load-bearing security goldens are each **mutation-checked**: T7 oracle (disable current-deny → leak), T5-2 mask
(drop mask → leak), plus the reconstructor's delete-at-T and version contract.

## 4. The discipline (why the write half is design-locked, not built)

The destructive slices (T6 scoped restore, T8 sheet rollback) are the dangerous half — T6 introduces a new
batch-fan-out permission surface, T8 deletes data. The /goal asked for 设计**及**验证MD: so the read-only half is
**built + verified**, and the write half is delivered as **design-locks** (the 设计 artifact) + held for explicit
ratification. Self-authorizing a destructive sheet rollback off a goal is the one line not crossed.

## 5. Named follow-ups (each a separate opt-in)

- T5-2: batch-scope preview, strategy=reset preview, reconstructor-based as-of-T preview; unify the mirrored
  diff helpers with the restore route (the P3 dup).
- T7: deleted-since-T records (out of v1 — needs its own deny decision); pagination cursor.
- T6 / T8 / T9: ratify their design-locks (D-decisions) then build, each gated; T8 Reset needs a separate sign-off.
