# Multitable Global History — T6 Scoped Restore (DESIGN-LOCK)

> Status: **DESIGN-LOCK, docs-only. Runtime GATED behind ratification of §6 (D1–D4) + an explicit owner opt-in.**
> T6 is the first WRITE slice of the restore program — it executes a previewed restore by writing forward
> revisions. This doc is the 设计 deliverable; **no T6 runtime is built until ratified**.
> Basis: the canonical global-history design-lock (`...-pit-restore-design-lock-20260619.md`, LOCK-9/10/11/12)
> and the T5 restore-preview design-lock (`...-t5-restore-preview-design-lock-20260621.md`, PV-1..PV-7). T6
> CONSUMES T5's preview; it references those locks, does not re-derive them.

## 1. Problem + why T6 is NOT "just Layer-1, batch-scoped"

A scoped restore re-applies a previously-recorded value to a selected set of records/fields, by writing a NEW
forward revision (history is append-only — restore never rewrites the past). The per-record restore (Layer 1,
`POST /sheets/:sheetId/records/:recordId/restore`) already does exactly this for ONE record the actor named.

**The trap (load-bearing):** Layer-1's write path does NOT check row-level rule-deny — it never needed to,
because the actor named one record they could already edit. T6 fans across MANY records at once, which is
exactly where a record the actor cannot read/write gets silently restored if the gate is not re-applied
**per record across the fan-out**. So T6 is Layer-1's mechanism PLUS a new permission surface. That surface
is the reason T6 is design-locked, not a mechanical extension.

## 2. Locks (T6; SR-* are scoped-restore-specific)

- **SR-1 — Forward-only, append-only (non-destructive write).** A restore writes new revisions (`action='update'`
  / `action='create'` for undelete) that bring records to the restored values; it NEVER deletes or rewrites
  prior revisions. The restore is itself a `source='restore'` batch (LOCK-12), inspectable in history, and can
  be restored again (re-restore must not corrupt history).
- **SR-2 — Per-record permission re-application across the fan-out (THE new lock).** For EVERY record in the
  scope, T6 re-applies, at write time: (a) row-level rule-deny (`loadDeniedRecordIds` — NOT in the Layer-1 write
  path today; T6 adds it), (b) the per-field write gate (`FieldMutationGuard`: not hidden/read-only + the
  field_permissions `visible/readOnly` mask), (c) optimistic `expected_version`. A denied record or a denied
  field is dropped from the applied set in `revert`/scoped mode; in any all-or-nothing mode it BLOCKS the whole
  execution (SR-5). The preview already computed the visible/permitted set (T5 PV-2); T6 RE-VERIFIES at write
  time — never trusts the preview's permission verdict (the world may have changed since preview).
- **SR-3 — Execution matches the preview (preview-identity required).** T6 requires a server-verifiable preview
  identity (the T5-deferred token) that BINDS the strategy + scope + the computed diff. The executed change set
  is the previewed one; a record/field not in the preview cannot be restored, and a `revert` token cannot drive
  a `reset` (and vice versa). A stale preview (data changed since) is rejected or re-previewed, never silently
  applied. (The token mechanism itself is D1.)
- **SR-4 — Reveal never composes with restore (field-audit LOCK-7, cross-arc).** A history field-audit reveal
  widens only what history SHOWS; it can never widen what a restore WRITES. The T6 write path never consults
  `resolveActiveRevealGrant`/`loadRevealedFieldIds`; the restorable field set is the actor's NORMAL (masked)
  write-permitted set. Verifiable by construction (grep).
- **SR-5 — Optional all-or-nothing scoped mode; T6 NEVER deletes (the T6/T8 boundary, LOCK-10).** T6 writes
  ONLY forward revisions over the selected scope — it has **no destructive mode and never deletes post-T-created
  records** (sheet-wide reset / delete-post-T-created is **T8's Reset, not T6**). The default scoped restore may
  partial-skip denied targets (and reports them); an OPTIONAL all-or-nothing scoped mode instead blocks the
  ENTIRE restore if any selected target is denied (no partial skip, no fail-halfway) — but still writes only
  forward revisions (set/unset/undelete), never a delete.
- **SR-6 — Atomic, idempotent execution.** The whole scoped restore commits in ONE transaction (forward
  revisions + the `source=restore` batch row). Re-submitting the same preview identity must not double-apply
  (idempotency key = the preview identity); a retry after a partial failure leaves the table unchanged.

## 3. What T6 reuses (no re-derivation)

`RecordWriteService.patchRecords` (the forward-revision write + `recordRecordRevision` chokepoint, already used
by Layer-1 restore with `source:'restore'`); `FieldMutationGuard` (per-field write gate); `loadDeniedRecordIds`
(row-deny — newly wired into the write path per SR-2); the optimistic `expected_version` check; T5's computed
diff + preview identity.

## 4. Forward-constraints (NOT T6)

The destructive POINT-IN-TIME rollback (delete post-T-created records across a whole sheet) is **T8**, not T6 —
T6 restores a SELECTED scope (records/fields/changes/a batch subset), never a sheet-wide reset. Config/schema
restore is T9.

## 5. Test plan (when built)

Real-DB: selected-field restore writes a forward revision; partial-batch restore; **a row-denied record in the
scope is NOT restored (SR-2)**; **a denied/hidden field is NOT restored (SR-2)**; **a reveal grant does not let
a denied field be restored (SR-4, mutation/grep)**; the restore appears as a `source=restore` batch in history
and is itself inspectable; re-restore doesn't corrupt history; a forged/mismatched/stale preview identity is
rejected (SR-3); `reset`-scope all-or-nothing blocks on any single failure (SR-5); idempotent retry (SR-6).
Mutation-checks: drop the per-record row-deny re-application → the denied-record golden leaks a write.

## 6. Decisions to ratify (before any T6 build)

- **D1 — Preview identity mechanism.** Signed short-lived payload (binds strategy+scope+diff-hash+actor) vs a
  persisted preview row vs a cache entry. Recommend: **signed payload + a freshness check** (cheap, stateless,
  binds execution to the exact previewed diff).
- **D2 — Conflict policy when live data changed since preview.** Reject-and-re-preview (safest) vs apply-anyway
  for non-conflicting fields. Recommend: **reject-and-re-preview** for v1.
- **D3 — Who may execute a scoped restore.** The sheet write/`canEditRecord` capability (same as Layer-1), plus
  the restore is audited. Recommend: yes, gate on `canEditRecord` + audit.
- **D4 — Undelete in scope.** Does T6 support restoring a deleted record (write an `action='create'` undelete)
  in a scoped restore, or is undelete deferred? Recommend: **support undelete** (it is the high-value case), with
  the same per-record gate.

## 7. Gated TODO

- ⬜ **T6-0 — ratify** this doc (D1–D4) + explicit owner opt-in to open the first write slice.
- 🔒 **T6-1 — preview-identity contract** (D1): mint at preview (T5-2), verify at execute. Contract + goldens.
- 🔒 **T6-2 — scoped-restore execute** (read the identity → re-verify per-record gates SR-2 → atomic forward
  revisions SR-6 → `source=restore` batch). Real-DB goldens (§5) + mutation checks. **The dangerous slice —
  reviewed alone.**
- 🔒 **T6-3 — FE restore panel** (select scope → preview → confirm → execute), separate gated slice.

## 8. Out of scope / anti-goals

Sheet-wide point-in-time reset (T8); config/schema restore (T9); composing a field-audit reveal into a restore
(SR-4 forbids it); any write before T5 preview + a preview identity exist.
