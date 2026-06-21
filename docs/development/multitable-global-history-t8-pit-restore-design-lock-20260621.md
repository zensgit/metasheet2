# Multitable Global History — T8 Point-In-Time Restore (DESIGN-LOCK)

> Status: **DESIGN-LOCK, docs-only. OWNER-GATED — the single most dangerous slice in the program.** Runtime
> requires a SEPARATE explicit owner ratification of the rollback semantics (§6), beyond ratifying this doc.
> Prerequisites (per the canonical plan T8): T7 point-in-time read-only view PROVEN, T5 restore-preview PROVEN,
> async/max-size decided. **No T8 runtime is built until all of those + owner ratification.**
> Basis: canonical design-lock LOCK-9/10/11/12; the T5 preview lock; the T6 scoped-restore lock (T8 is the
> sheet-wide generalization of T6's write, over the T7/T5-1 as-of-T reconstruction).

## 1. Problem + the two strategies (LOCK-10)

T8 restores a whole sheet (or a permission-filtered subset) to its state as of time T. Two named modes — the
distinction is the whole safety story:

- **Revert-to-T (default, NON-destructive):** undo post-T changes, undelete post-T deletions; **records created
  after T are KEPT** (flagged in preview). Result = "data as of T, plus anything new since." Zero data loss —
  fully expressible as a large T6 scoped restore (forward revisions only).
- **Reset-to-T (explicit, DESTRUCTIVE, hard-gated):** the above PLUS **delete records created after T** → the
  table exactly as of T. This is the only mode that destroys data, and it is the reason T8 is owner-gated.

## 2. Locks (T8; PIT-* are point-in-time-restore-specific)

- **PIT-1 — Preview-first, always (no blind rollback).** T8 execution requires a T5 preview + preview identity
  (SR-3) for the FULL computed change set. There is no "reset to T" endpoint that skips the dry-run.
- **PIT-2 — Reset is all-or-nothing with a full permission preflight (LOCK-10).** Before any destructive write,
  EVERY record/field to be deleted/updated/undeleted is permission-checked in the dry-run; ANY failure blocks
  the entire Reset (no partial skip, no fail-halfway). Revert may partial-skip; Reset may not.
- **PIT-3 — Counts never leak (LOCK-3), reset is the leak-prone mode (PV-4).** The post-T-created delete-candidate
  set ranges over records the actor may not see; its count is `visibleAffected*` (post-filter), and a record the
  actor cannot read must not be inferable from any count delta.
- **PIT-4 — As-of-T reconstruction is the T5-1 primitive (LOCK-9/11).** T8 reconstructs over the SAME delete-aware,
  deterministic `reconstructRecordsAtT`; it does not re-derive "state at T" (the failure mode is three slices
  encoding three subtly-different semantics).
- **PIT-5 — The rollback is itself recorded + inspectable.** T8 writes forward revisions + a `source=restore`
  batch (LOCK-12) describing the rollback; the rollback can be understood in history (and, for Revert, itself
  reverted).
- **PIT-6 — Bounded + async above a threshold.** A rollback over more than the ratified max-size runs async
  (job) with progress; it never holds a giant synchronous transaction open. Above the hard ceiling it is
  refused (fail-closed), not truncated (a truncated rollback breaks atomicity).
- **PIT-7 — Reveal never composes (SR-4 / field-audit LOCK-7).** A reveal grant never widens what a rollback
  writes or deletes.

## 3. Forward-constraints / reuse

Reuses T5-1 (reconstructor), T5-2 (preview), T6 (the per-record forward-revision write + per-record gate
re-application SR-2, generalized sheet-wide). Adds only: the post-T-created enumeration (Reset), the async job
runner + size ceiling, and the destructive delete path (the one genuinely new, hard-gated capability).

## 4. Test plan (when built)

Real-DB: full-sheet Revert dry-run keeps post-T-created; full-sheet Reset dry-run lists post-T-created as delete
candidates; Reset all-or-nothing blocks on any single permission failure (PIT-2); no count/existence leak under
Reset (PIT-3); forward revisions + restore batch created (PIT-5); the rollback is inspectable; conflict handling;
above-ceiling refusal (PIT-6, fail-closed); reveal-doesn't-compose (PIT-7). Browser evidence for the rollback
confirmation UX. Mutation-checks on PIT-2 (drop a preflight check → a denied target slips into the destructive set).

## 5. Decisions to ratify (the heavy ones — SEPARATE owner sign-off, not just doc approval)

- **D1 — Reset (destructive) at all, in v1?** Recommend: ship **Revert-only first** (zero data loss); Reset as a
  later, separately-ratified slice. This de-risks the whole program — Revert covers most "go back to T" needs.
- **D2 — Who may execute a sheet rollback.** A capability strictly ABOVE normal record-write (e.g. a base-admin
  or a dedicated `multitable:history-restore` capability), since one call rewrites a whole table. Recommend: a
  dedicated capability, never plain `canEditRecord`.
- **D3 — Async threshold + hard max size.** The record/field-count above which the rollback runs async, and the
  ceiling above which it is refused. Recommend: sync under a few hundred records, async above, hard-refuse above
  a configured ceiling.
- **D4 — Confirmation / two-step + audit.** A destructive Reset requires an explicit typed confirmation + is
  audited with actor/T/scope (never values). Recommend: yes.
- **D5 — Scope granularity.** Whole sheet only, or a permission-filtered subset (a view/filter)? Recommend:
  whole sheet first; subset is a follow-up.

## 6. Gated TODO

- ⬜ **T8-0 — ratify** this doc AND the rollback semantics (D1–D5) as a SEPARATE explicit owner sign-off.
- 🔒 **T8-1 — Revert-to-T** (non-destructive, owner-opt-in) over T7 + T6's write. Real-DB goldens + browser UX.
- 🔒 **T8-2 — Reset-to-T** (destructive, SEPARATE owner ratification, only after Revert proven). The hard-gated
  delete path + async runner + ceiling. Reviewed alone, most adversarial test pass in the program.

## 7. Out of scope / anti-goals

Config/schema rollback (T9); any rollback without a preview + preview identity; a synchronous unbounded rollback;
Reset before Revert is proven; composing a reveal into a rollback.
