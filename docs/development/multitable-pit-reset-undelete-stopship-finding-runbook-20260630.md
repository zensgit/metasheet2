# PIT Reset / Undelete — STOP-SHIP determination, T-source decision, flag-on smoke, runbook

**Date:** 2026-06-30  **Grounding:** `origin/main @ f14be042e`
**Flags:** `MULTITABLE_ENABLE_PIT_RESET`, `MULTITABLE_ENABLE_PIT_UNDELETE`
**Scope:** staging/sandbox; **prod flags NOT changed.** Phase 3 of the flag-enablement sequence — the highest-risk tier, gated on a data-loss STOP-SHIP determination *before* any smoke is treated as "ready."

> The directive was to **determine** whether trash-retention is a genuine STOP-SHIP for PIT_RESET before producing a reassuring smoke. This is a finding-gate, not a checklist tick. The determination below was adversarially refuted (an independent agent tried to find a data-loss path and could not).

---

## 1. STOP-SHIP determination — NOT a data-loss stop-ship today (with a sharpened, conditional future-gate)

**PIT_RESET is recoverable on today's default config; it is NOT a data-loss stop-ship.** A reset-to-T does two things, both recoverable:

- **Records created after T → soft-deleted to the recycle bin.** `reset-execute` (`univer-meta.ts:9701-9733`), in one transaction, writes a `delete` revision *with the full data snapshot*, **inserts the record into `meta_records_trash` with its full snapshot**, then removes it from the live table. The trash INSERT is **fail-closed** (not error-swallowed, surrogate-uuid PK, no `ON CONFLICT`), so a live delete without a trash row is unreachable — if the trash write fails, the whole txn rolls back. A working restore route (`POST /records/:recordId/restore`) brings trashed records back.
- **Records modified after T → reverted (UPDATE) to their at-T values**, recording a `source='restore'` revision.

**No trash purge exists.** Exhaustively confirmed: the only `DELETE FROM meta_records_trash` in production is the per-record restore op (`record-service.ts:1029`, inside the restore txn, after a successful re-insert). The three retention starters wired in `src/index.ts` (operation-audit, attachment-orphan, meta-revision) **none** touch `meta_records_trash`; the create migration states explicitly "rows live here until an explicit purge; no automatic aging." So reset-deleted records persist **indefinitely**.

### The recoverability asymmetry (the load-bearing nuance)

| Reset effect | Recovery source | Recoverable today? | Future-gate |
|---|---|---|---|
| **delete** (created-after-T) | `meta_records_trash` snapshot (+ delete-revision snapshot as a 2nd copy) | **Yes, unconditionally** | None — no sweep ever touches trash |
| **revert** (modified-after-T) | the **prior** `meta_record_revisions` row (the post-T edit's revision, now at rn≥2 after the revert) | Yes (revision retention is **off** by default) | **Conditional** — becomes purgeable if `MULTITABLE_META_REVISION_RETENTION_ENABLED` is enabled |

The revert's *own* `source='restore'` revision stores the *reverted-to* (at-T) value, not the pre-reset value it overwrote. So **undo of a revert** relies on the prior revision, which the retention sweep's "never delete the latest per record" invariant does **not** protect (it sits at rn≥2). Today both retention flags default off, so it persists.

**Refinement of the "trash-retention STOP-SHIP" framing:** the future stop-ship is **`MULTITABLE_META_REVISION_RETENTION_ENABLED`** (it can age out the revision a *revert-undo* needs), **not** trash-retention — `meta_records_trash` is unconditionally safe (no purge exists). The conditional rule for enablement is therefore: **do not enable revision-retention purging while PIT_RESET is enabled** (or accept that revert-undo gains a finite window), whereas delete-recovery is safe regardless.

### Operational residuals (real, but not data-loss stop-ships)

1. **No atomic "undo reset."** Undoing a reset is piecemeal: restore each trashed record + revert each value-change via record history. No single button. Worth a follow-up if resets become routine.
2. **Orphan trash if a sheet is later hard-deleted** — the trash row persists but is un-restorable (sheet gone). Independent of reset; pre-existing.
3. **Unbounded trash growth.** No purge means large/repeated resets bloat `meta_records_trash` indefinitely (storage/operational). The `idx_meta_records_trash(sheet_id, deleted_at DESC)` index suggests a retention purge is anticipated — *that* is the moment delete-recoverability would also gain a window, and must be re-evaluated against PIT_RESET then.

## 2. Reset T-source — product decision (owner's call, not made here)

The current T-source is a **free `datetime-local` picker** (`ResetToPointPicker.vue`): the operator picks any past instant T. `reconstructRecordsAtT` resolves state at T = the **latest revision with `created_at ≤ T`** — so picking "3:47pm" when the last change was 2:00pm silently yields the **2:00pm** state.

| Option | Pros | Cons |
|---|---|---|
| **datetime-local** (shipped) | Minimal, flexible (any instant), already works | The resulting state isn't self-evident — T snaps to the last revision ≤ T; for a *destructive* op the operator may not realize which state they'll get |
| **history-anchored picker** (deferred) | Operator selects an actual, visible change-point (HistoryCenter batch timestamps) → predictable, self-documenting, safer for a destructive op | More UI; surface + wire the history timestamps |

The `asOf` derivation is explicitly the **single swappable seam**, so the upgrade is a localized change. **Recommendation (for the owner to decide):** upgrade to the history-anchored picker before broad enablement — for a destructive reset, picking a real visible historical point is materially safer than an arbitrary instant that snaps. It is **not a hard blocker** (datetime-local is correct, just less self-documenting). This is a product decision and is left to the owner.

## 3. Flag-on smoke — evidence

PIT goldens run flag-on against a fresh real Postgres at current main (`multitable-reset-pit-realdb`, `multitable-revert-pit-realdb`, `multitable-undelete-pit-realdb`, `multitable-pit-view-realdb`) → **41/41 passed**. (The "rs injected" / "rv injected" / "forced … insert failure" lines are *intentional* injected-failure atomicity goldens — they assert reset/undelete roll back cleanly mid-apply — inside passing tests.) Coverage includes: flag-off 403; reset preview→typed-`confirm:"reset"`→execute (reverts + soft-deletes to trash); too-large refusal (record ceiling); all-or-nothing block on a forbidden/locked target; preview-identity drift (409/410); and apply-atomicity rollback.

## 4. Operator runbook (gated on §1 + §2)

Both PIT flags are read **per-request from `process.env`** (`PIT_RESET_ENABLED()` `:9516`, `PIT_UNDELETE_ENABLED()` `:9359`) — no in-app cache.

- **Pre-enable condition (from §1):** keep `MULTITABLE_META_REVISION_RETENTION_ENABLED` **off** while PIT_RESET is on (so revert-undo stays recoverable); delete-recovery is safe regardless. If revision-retention is ever enabled alongside, document that revert-undo gains a finite window.
- **Enable:** set `MULTITABLE_ENABLE_PIT_RESET=true` / `MULTITABLE_ENABLE_PIT_UNDELETE=true` in staging env + **restart/redeploy**.
- **Smoke (live):** on a throwaway sheet, make post-T edits + a post-T record, then reset-preview→`confirm:"reset"`→execute → at-T edits reverted, post-T record gone from live; verify it sits in `GET /sheets/:id/trash`; restore it via `POST /records/:id/restore` → back on live. Verify a too-large sheet 413s and a drifted preview 409s.
- **Rollback:** unset (or ≠ `true`) + restart → 403. No persisted flag state.

## 5. Recommendation

- **PIT_RESET / PIT_UNDELETE are flag-on-smoke-verified and recoverable today** (adversarially confirmed) — **enable-able in staging/sandbox on the operator's go, under the §1 condition** (revision-retention stays off ↔ revert-undo recoverable). Prod is a separate, later decision.
- **The T-source datetime-local→history-anchored upgrade is a product decision left to the owner** (recommended before broad enablement, not a hard blocker).
- **Follow-ups (not blockers):** an atomic "undo reset"; a trash-retention purge policy (which, when added, re-opens the delete-recoverability question and must be re-evaluated against PIT_RESET). No code ships with this doc.
