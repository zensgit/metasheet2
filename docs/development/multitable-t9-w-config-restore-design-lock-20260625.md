# T9-W — config restore / rollback (write side) — design-lock (PROPOSED) — 2026-06-25

> **Design-lock (PROPOSED).** The T9 read side is complete (R1–R4 record + the gated, redacted
> `/config-history` read). T9-W adds the WRITE side: reverting a config entity to a recorded past
> state. This is design-heavy and **security-sensitive** — a config restore can re-grant
> permissions, resurrect a deleted field, or revert a row-deny — so it gets its own lock before any
> code. No implementation yet. Review this first.

## Scope — v1 is SINGLE-REVISION REVERT (not PIT reconstruct)

`meta_config_revisions` is **diff-first** (each row is `before`/`after` for one change, not a full
snapshot). Reconstructing a whole sheet's config at an arbitrary time T = replaying every diff —
complex and high-blast-radius. **v1 restores ONE entity from ONE revision**: take a chosen
revision's `before` (for an update/delete) and re-apply it as the entity's new config. That is the
minimal safe, auditable unit.

- **IN v1:** revert a single `field` / `view` / `sheet_config` / `permission` entity to the `before`
  of a chosen `meta_config_revisions` row (i.e. undo that one change). Restoring a `delete` recreates
  the entity from its `before`; restoring a `create` removes it; restoring an `update` re-applies the
  pre-change values.
- **OUT (deferred, separate opt-ins):** point-in-time reconstruct of a whole sheet; batch/multi-entity
  restore; cross-sheet/base; FE. Each is its own design-lock after v1.

## Locks

- **W-L1 append-only / forward-only.** A restore is a NEW config write that records a NEW
  `meta_config_revisions` row (action reflecting the applied change; a marker noting it was a restore
  of revision X). It NEVER edits or deletes history. History is immutable (consistent with T9-L1).
- **W-L2 gate口径 — write-symmetric, per entity type / permission subtype.** Restoring requires the
  SAME capability that gates writing that config (identical to the R3 read gate, because restore IS a
  write): `field`→`canManageFields`, `view`→`canManageViews`, `sheet_config`→`canManageSheetAccess`,
  `permission` by scope (`field:`→`canManageFields`, `view:`→`canManageViews`,
  `sheet:`→`canManageSheetAccess`). Fail-closed on unknown entity_type / unparseable permission scope
  (reuse the read-side derivation; one source of truth).
- **W-L3 dry-run preview → execute, bound.** Two steps, mirroring record-restore: `restore-preview`
  returns the EXACT config change that would be applied (the diff: current → target) and mints a
  bound identity (`mintRestorePreviewIdentity`-style, hashing the precise change); `restore-execute`
  verifies that token + re-derives the diff and applies ONLY if it still matches. The actor executes
  exactly what they previewed; a stale preview (config changed since) fails closed.
- **W-L4 same-transaction.** The config write + its new history row commit/roll back together (the
  R1/R2 L4 invariant; the BAR-1 rollback goldens are the model).
- **W-L5 security-relevant changes are surfaced + separately gated.** A restore that re-grants a
  permission, resurrects a deleted field, or flips `row-level-read-deny` is the dangerous case. The
  preview MUST render these explicitly (especially permission re-grants and row-deny flips), and the
  per-subtype gate (W-L2) means e.g. resurrecting a field-permission needs `canManageFields`, flipping
  sheet row-deny needs `canManageSheetAccess`. No coarse "restore anything" capability.
- **W-L6 idempotent / no-op-safe.** If the entity already equals the target (nothing to change),
  execute is a no-op that records nothing (diff-first; mirrors the read side's no-op discipline). The
  bound token is single-use / TTL'd so a replay can't double-apply.
- **W-L7 view restore reuses the read redaction in the PREVIEW.** The preview of a `view` restore
  shows `filterInfo` — its literals are field-read-sensitive (#2052/R9), so the PREVIEW payload runs
  through `loadAllowedFieldIds` + `redactViewConfigFilterLiterals` (as the read does). The EXECUTE
  applies the real (unredacted) stored target server-side — a field-denied restorer can apply the
  revert without ever seeing the denied literal.

## Reuse (mirror, don't reinvent)
Record-restore is the template: `restore-preview` / `restore-execute` route shape,
`mintRestorePreviewIdentity` / `verifyRestorePreviewIdentity` / `hashPreviewChanges` for the bound
two-step, and the config-history gate derivation for W-L2. The DIFFERENCE is the payload is config
(not record values) and the gate is the config-manage cap (not the record mask).

## Open questions for review (decide before impl)
1. v1 = single-revision revert — agreed, or is a bounded multi-entity "restore this batch" needed day one?
2. Restore of a `permission` re-grant: allowed in v1, or hold permission restore for a later slice
   (highest blast radius)?
3. The new history row's `action`/marker shape for "this was a restore of revision X" (provenance).

## TODO (gated)
- 🔒 **W-0** this design-lock — review/approve scope (single-revision revert) + the locks (esp. W-L2 gate, W-L5 security surfacing, W-L7 preview redaction).
- ⬜ **W-1** restore-preview (per-entity) — gate + diff (current→target) + redacted view preview + bound token.
- ⬜ **W-2** restore-execute — verify token + re-derive diff + apply in one txn + record the restore as a new revision (W-L1/L4).
- ⬜ **W-3** real-DB goldens — gate (cross-cap 403), bound-token (stale preview fails closed), no-op idempotency, permission re-grant surfaced + gated, view preview redaction, history-immutability (restore appends, never edits).
- ⬜ **W-4** register goldens; verification MD.

> Each step is a separate explicit opt-in after W-0 is approved. PIT reconstruct, batch, and FE remain
> deferred behind v1.
