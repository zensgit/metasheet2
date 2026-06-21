# Multitable Global History — T5 Restore-Preview (DESIGN-LOCK)

> Status: **DESIGN-LOCK, docs-only. Runtime GATED behind ratification of §6 (D1–D5).**
> **T5 = READ-ONLY preview only.** The actual restore write (T6) stays a SEPARATE gated slice with its own
> opt-in. Owner opted into this design-lock as the safest continue-path (read-only, writes no data) and
> explicitly NOT T6/T8 restore runtime.
> Basis: the canonical global-history design-lock
> `multitable-global-history-pit-restore-design-lock-20260619.md` already specifies the high-level
> restore-preview contract (`POST /history/restore-preview`, `strategy: revert|reset`, LOCK-3 count safety,
> LOCK-9 delete-state, LOCK-10 Revert/Reset, preview-before-mutation). This doc makes the PREVIEW HALF
> implementation-ready and ties in the field-audit cross-arc constraint. It REFERENCES those locks, does not
> re-derive them.

## 1. Problem + the scope boundary

The read-only MVP shipped the history CENTER (batch listing + detail). The next safe slice is a restore
PREVIEW: given a target (a record version, a batch, or a point-in-time T) + a strategy, compute — **without
writing** — what a restore WOULD change, permission-safely. The destructive/atomic write is T6 and stays
gated.

**Scope finding (verified, not assumed):** an as-of-T state reconstructor (LOCK-9 delete-aware, LOCK-11
ordering) does NOT exist today — the MVP built batch *listing* (`loadHistoryBatchSummaries` /
`loadHistoryBatchDetail`), and per-record restore (Layer 1) is *version*-based (`targetVersion`), not
time-based. So **T5 includes building the reconstructor**, then the preview diff over it. This makes T5
"build PIT reconstruction + read-only preview," not "wire a preview over existing machinery."

## 2. Positioning

The **safe half** of restore: everything a restore needs to SHOW, nothing it needs to WRITE. The dangerous
half — the guarantee that execution matches the preview, atomicity, the destructive reset, the preview
identity/token — is T6, and appears here ONLY as named forward-constraints (§4).

## 3. Locks (T5; PV-* are preview-specific, referencing the global-history LOCKs by name)

- **PV-1 — Ruthlessly read-only (the defining invariant).** The preview path computes + returns a diff and
  writes NOTHING: no INSERT/UPDATE/DELETE on any table, no side effect, no token persisted. Tested as an
  invariant, not asserted in a comment: a golden asserts the `meta_record_revisions` + `meta_records` row counts
  AND the target records' `version` are **unchanged (equal) before and after** a preview call (a state
  invariant — not a byte-level DB snapshot).
- **PV-2 — Permission-safety is REUSE, not re-derivation (LOCK-3).** The preview diff runs through the SAME
  machinery the history *detail* already uses — row-deny (`loadDeniedRecordIds` / the projection's deny pass)
  + the field-mask (`buildHistoryAllowedFieldsBySheet`) + `visibleAffected*` counts. **Boundary correctness
  statement:** a record or field absent from the history DETAIL is absent from the PREVIEW, by construction
  (same resolver). Writing fresh permission logic in the preview path is the bug this lock forbids.
- **PV-3 — Reveal NEVER composes with preview (field-audit LOCK-7, the load-bearing cross-arc lock).** The
  preview computes restorability + the diff from the actor's NORMAL (masked) permissions. The preview path
  **never calls `loadRevealedFieldIds` / `resolveActiveRevealGrant`**, and `?reveal` is ignored on the preview
  route. A field-audit reveal therefore CANNOT widen what the preview shows or what a restore would touch.
  Verifiable **by construction** (grep: the reveal functions have no caller in the preview path) — the same
  move that earned LOCK-7 in the field-audit A2.
- **PV-4 — Counts are `visibleAffected*`, and RESET is the leak-prone strategy.** Both strategies report
  `visibleAffectedRecordCount` / `visibleAffectedFieldCount` (post-permission-filter), never the raw count
  (LOCK-3). RESET additionally enumerates records CREATED AFTER T (delete candidates), which range over
  records the actor may not be able to read — so **reset preview is MORE leak-prone than revert**: its
  delete-candidate count MUST be the *visible* count, and a record the actor cannot read must not be inferable
  from any count delta (same class as the 2b-trash / affected-count leak the base design-lock already flags).
- **PV-5 — As-of-T reconstruction is delete-aware + deterministic (LOCK-9 + LOCK-11).** A record's state at T
  = the latest revision with `created_at <= T` under the LOCK-11 order (`created_at DESC, version DESC, id
  DESC`); if that latest revision is `action='delete'`, the record does NOT exist at T and is excluded (a
  delete revision stores the *pre-delete* snapshot, so a naive "latest snapshot" resurrects deleted records).
  This reconstructor is NEW, is the load-bearing compute primitive T5 builds, and is what T6 will reuse.
- **PV-6 — Strategy diff is computed, the destructive enforcement is NOT (LOCK-10).** `revert`: enumerate
  post-T changes to undo + post-T deletions to undelete; records created after T are KEPT (flagged). `reset`:
  the above + records created after T as DELETE candidates. The reset preview ALSO computes the all-or-nothing
  permission preflight (permission-check every delete/update/undelete target) and reports "executable" vs
  "blocked (and why)" — but it **writes nothing and enforces nothing**. T6 re-verifies and enforces
  all-or-nothing atomically at execution.
- **PV-7 — Over-limit preview FAILS CLOSED (no truncated preview).** A preview whose target set exceeds the
  configured cap returns an explicit "too large to preview safely" error, NOT a truncated diff. Truncation is
  not ordinary pagination here: a truncated preview would let T6 later execute records the preview never showed,
  breaking execution-matches-preview. (The alternative — bind T6 to execute ONLY the preview-enumerated set — is
  a T6 design; T5 picks fail-closed.) The cap is configurable; hitting it is an error, never a silent drop.

## 4. Forward-constraints (T6 — named here, NOT designed here)

The dangerous half lives in T6 and must NOT migrate into this doc:
- the **preview identity / token** (it exists only to be CONSUMED by the write; binds strategy + scope + the
  computed diff so execution can't diverge from preview) — a T6 design, deferred (§6 D1);
- the guarantee that **execution matches the preview**; the single atomic transaction; forward-only revisions;
  reset's all-or-nothing **enforcement** at write time; restore-created batches linking back to the source.

T5 returns a permission-safe diff (+ the would-be preflight result). How a confirmed preview authorizes an
execution is entirely T6.

## 5. Decisions to ratify (resolve before T5-1)

- **D1 — Preview identity/token → DEFERRED to T6.** T5 ships no token (it would be scaffolding for an unbuilt
  consumer and would drag T6's replay/binding/TTL threat model into a read-only slice). T5 returns the diff;
  the signed-payload-vs-persisted-row-vs-cache choice is T6's. [recommend: deferred — keeps T5 read-only]
- **D2 — Target granularity for v1.** record-version / batch / full point-in-time T? Recommend: record-version
  + batch first; full-table point-in-time T (heaviest reconstruction) as a T5 follow-up.
- **D3 — Over-limit handling → RESOLVED (owner review): FAIL-CLOSED (now PV-7).** A preview whose target set
  exceeds the cap does NOT return a truncated diff — it fails closed. Truncation is not ordinary pagination
  here: a truncated preview would let T6 later execute records the preview never showed, breaking
  execution-matches-preview. (The alternative — T6 may execute ONLY the complete set the preview/token
  enumerated — is a T6 binding; T5 picks fail-closed as the clean default.) See PV-7.
- **D4 — Conflict CATEGORIES (clarified, owner review).** "The live record changed since T" is NOT a conflict —
  that is just the diff (every diff is a change-since-T). The preview must classify genuine BLOCKERS distinctly
  from ordinary value diffs: (b) **schema-drift** (a field/type changed since T so the T-value can't be
  restored), (c) **permission / write-gate conflict** (the actor cannot write the target now), (d)
  **deleted/missing target** (the record no longer exists). T5 enumerates (b)(c)(d) at preview time; (a)
  **concurrent-after-preview** (the target changed between preview and would-be execution) is inherently a T6
  execution-time freshness check, not detectable at preview. To ratify: the exact set surfaced + their wire
  shape.
- **D5 — Who may preview.** The history read gate, or the eventual restore capability? Recommend: gate preview
  on the SAME capability the restore will need (don't tease a preview to someone who could never execute) —
  preview stays read-only either way (PV-1/PV-2), this only narrows WHO sees it.

## 6. Gated TODO (each a separate opt-in; design-lock first)

- ⬜ **T5-0 — ratify** — this doc; resolve D1–D5.
- 🔒 **T5-1 — as-of-T reconstructor** — delete-aware (LOCK-9), deterministic (LOCK-11); pure compute. Unit +
  real-DB goldens: delete-state-at-T excludes the record, ordering determinism, version/T equivalence.
- 🔒 **T5-2 — `POST /history/restore-preview` (READ-ONLY)** over the reconstructor: strategy diff (revert/reset),
  PV-2 LOCK-3 reuse, PV-4 visibleAffected* + reset enumeration, PV-6 reset preflight computation. Real-DB
  goldens: **non-destructive (PV-1 byte-identical row-counts)**, **reveal-doesn't-compose (PV-3, mutation/grep)**,
  denied record/field absent from preview (PV-2 boundary), reset count-leak safety (PV-4).
- 🔒 **T5-3 — FE preview panel** (read-only "what would change") — separate gated slice.
- 🔒 **T6 — the restore WRITE** — SEPARATE gated slice, its own opt-in + own design-lock detail (token,
  atomic execution, reset enforcement). NOT T5.

## 7. Out of scope / anti-goals

- Any write / execution (T6); the preview token (T6); destructive reset enforcement (T6); config/schema
  restore (T9); composing a field-audit reveal into preview (PV-3 forbids it).
