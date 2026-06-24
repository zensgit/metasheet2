# Multitable Restore — Write-Chain Closeout

> A single source of truth for what is **SHIPPED** vs **GATED** on the record-restore line, so the
> design-lock / developed / merged states never blur again. Everything in §1–§3 is merged on `main`;
> everything in §4 is gated behind a separate explicit opt-in and has **no code**.

## 1. Shipped — the full restore line (read + write)

| Slice | What shipped | PR | Merge SHA |
|---|---|---|---|
| T5-1 record reconstruction | `reconstructRecordsAtT` (delete-aware, LOCK-11 order) | — | (read half) |
| T5-2 / T7 | record-version restore **preview** + PIT view (read-only) | — | (read half) |
| T6-1 | single-record restore preview-**identity** contract (mint/verify, `changesHash`) | — | (read half) |
| T6-2 | single-record restore **execute** (verify → forward-revision write) | — | (write) |
| **BS-1** | scoped (multi-record) identity contract — `scopeHash`, discriminated `type` | #3073 | `d8b88965` |
| **BS-2** | scoped batch-**preview** (read-only fan-out; restorable scope; null on empty) | #3078 | `df9daabe` |
| **BS-3** | scoped batch-**execute** (the multi-record write, PARTIAL) + 2 [P1] fixes | #3085 | `6b39ac08` |
| layer-3 follow-up | per-subject write gate on the single-record `restore-execute` (T6-2) | #3091 | `53250d5d` |

## 2. The security model (locks that hold across every write path)

- **Layer-3 per-subject write gate.** `allowed` (visible ∧ field_permissions-visible) is a READ mask; `patchRecords`
  enforces only field-DEFINITION readonly. A per-subject visible-but-readOnly field is gated at the route before any
  write (`staticOk ∧ layer3Ok`; forbidden ids never echoed). Holds in **all three** write paths: legacy `/restore`,
  single `restore-execute` (#3091), BS-3 batch fan-out (#3085).
- **Identity binds what executes.** A restore execute verifies a minted preview identity BEFORE any 2xx (including an
  all-noop set — no noop short-circuit ahead of verify). Single: `changesHash`. Scoped: `scopeHash` over
  `[recordId, changesHash, version]` per record.
- **Filter-then-hash, three axes.** `fieldIds` (field subset) folds into `changesHash`; the record set folds into
  `scopeHash`; the per-record **version** folds into `scopeHash` from the CLIENT-SUBMITTED value (never a fresh read).
  A narrowed/widened scope (BS-7), a tampered field selection, or a submitted-version mismatch all diverge the hash → reject.
- **Two-layer rejection (batch).** DIFF-LEVEL (a record missing / drifted / changed / empty since preview) → the
  recomputed `scopeHash` diverges → **whole-batch 409, re-preview**. WRITE-LEVEL (row-deny / version-conflict /
  field-forbidden in the fan-out) → **PARTIAL skip + report** (`denied` / `conflict` / `forbidden`).
- **Per-record fresh gates + authoritative CAS.** Each record re-checks row-deny + the in-transaction
  `expectedVersion` CAS under `SELECT FOR UPDATE` + the field-write gate. A denied/forbidden record is never written
  and never leaks via counts.
- **Forward-only, disjoint, bounded.** Every restore is a forward revision (`source='restore'`); no destructive
  delete. Single and scoped identities are disjoint by `type` (a single token can't drive a batch). Scope bounded ≤100,
  fail-closed.

## 3. Wire contract (for the FE / API client — BS-4 consumes this as-is)

- `restore-batch-preview` → `{ records: [{ recordId, status, changes?, affectedFieldCount?, previewVersion?, skipReason? }], scope, restorableCount, skippedCount, targetVersion, previewIdentity }`.
- `restore-batch-execute` ← `{ targetVersion, recordIds, expectedVersions: {recordId: previewVersion}, previewIdentity, fieldIds? }` → `{ records: [{ recordId, status: restored|skipped, newVersion?, restoredFieldIds?, skipReason? }], restoredCount, skippedCount, targetVersion }`.
- The FE is a **faithful client** of the model: submit each record's `previewVersion` back as `expectedVersions`,
  surface the skip-reason taxonomy verbatim, never reinterpret the identity. Reinterpreting any of these is the
  wire-drift risk, not a feature.

## 4. Gated — not built (each a separate explicit opt-in)

- **BS-4 — FE batch-restore panel.** The natural next step: grid multi-select → batch-preview → per-record
  restorable/skipped table → confirm → execute → per-record restored/skipped(reason) results. Risk is UX + wire-drift,
  not the security model. **Next up.**
- **BS-3.1 — all-or-nothing mode.** A product-semantic choice (better for API / admin bulk). PARTIAL default already
  ships; `patchRecords`' single-call path is already atomic, so this is a small follow-up — decide the entry point
  after the UI runs. Behind a named need.
- **T8 — destructive PIT restore.** Needs its own rollback-semantics sign-off (it deletes post-T records). Not folded
  into anything.
- **T9 — config / schema history.** An independent program. Not folded into anything.

## 5. Status discipline

Shipped = merged on `main` with a SHA in §1. Gated = §4, no code, opt-in required. There is no "design-locked but
half-built" state on this line: the batch/scope design-lock was ratified (BS-0) and fully built out as BS-1→BS-3;
T8/T9 remain design-locked with no implementation. When in doubt, this table — not memory — is the source of truth.
