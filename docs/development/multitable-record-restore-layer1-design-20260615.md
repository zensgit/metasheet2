# Multitable Record-Level Version Restore Design (Layer 1, Gate 0)

Status: design-lock — Gate 0 (all three open decisions resolved + maintainer review findings P1–P3 folded + pre-landing boundary patch locked, 2026-06-15). Ready for Slice 1 contracts on owner confirmation of landing. No code written yet.

Grounding: read against `origin/main` @ `c71b7dd12` on 2026-06-15 (revised after maintainer review; the restore/write/history core has no material drift from the earlier `e37f7bc12` read). Builds directly on the record-history arc — the append-only `meta_record_revisions` store (migration `zzzz20260430172000_create_meta_record_revisions.ts`) and the F1 history-egress field mask (`#2144`, `multitable-record-history-field-mask-design-20260530.md`) — and on the canonical `RecordWriteService` write path. Today record history is **observable but not restorable**: the history endpoint lists revisions read-only; there is no server-side revert, and the frontend drawer timeline has no restore affordance.

## 0. Decision

Add a server-side restore for a single multitable record back to one of its prior revisions, as a tightly scoped first slice:

```text
POST /api/multitable/sheets/:sheetId/records/:recordId/restore
body: { targetVersion: number, expectedVersion: number }
```

Five principles are locked here and must hold for every later layer (the forward-change/no-op rule, plus Locks A–D):

- **A value-changing restore is a forward change, never a destructive time-rewind.** A restore that changes data produces a *new* revision (`action='update'`, `source='restore'`, `version = current + 1`); `meta_record_revisions` stays append-only, no history row is mutated or deleted. A restore whose restorable diff is **empty** (current already equals the target over restorable fields) is a **no-op**: it writes nothing, bumps no version, and emits no revision (it returns `{ noop: true, newVersion: current }`). This reconciles with the canonical spine, which already skips when `applied === 0` (see §1); "every restore emits a revision" would otherwise contradict it.
- **Faithful value reproduction, not patch replay (Lock A).** Restore reproduces version N's *recorded field values*: set fields whose current value differs from N to N's value, and clear fields that did not exist at N. It is computed as a `set ∪ unset` diff against the target snapshot — it must **not** re-apply the stored incremental `patch` through the merge write (`data || patch`), which would leave post-N fields intact and silently fail to reproduce version N. Source of truth is the target revision's stored after-image `snapshot` (reliably populated at all capture sites on current main — see §1); restore guards an absent snapshot explicitly (`SNAPSHOT_UNAVAILABLE`) rather than assuming presence, and never silently falls back to patch replay.
- **Scalar user-data fields only (Lock D).** Slice 1 restores only fields whose authoritative value is a user-written scalar in `meta_records.data`. Excluded **by field type** (not by relying on the `readOnly` guard catching them):
  - computed: `formula` / `lookup` / `rollup` (derived server-side, recomputed afterward);
  - `link` (authoritative in `meta_links` with twoWay/mirror fan-out, only mirrored into `data` — a `data`-only write desyncs the join table; → Slice 2);
  - system/auto-assigned: `autoNumber` / `createdTime` / `modifiedTime` / `createdBy` / `modifiedBy` (system owns these; restoring an old `autoNumber` would corrupt the sequence, and if such a field is only soft-`readOnly` it would otherwise block the whole atomic restore — so exclude up front);
  - `attachment`: Gate-0 call, recommended deferral (ids reference externally-retained blobs — see §2).
  Restorable set is therefore the plain scalar types (text/number/boolean/date/dateTime/select/multiSelect/currency/percent/rating/url/email/phone/barcode/qrcode/location/longText).
- **Write-gated, not read-gated, and the layer-3 gate is restore's own (Lock B).** Restore reads the **unmasked server-side snapshot** as its source, but must authorize each differing field on **write**. Two gates apply, and they are NOT the same code: (1) the canonical spine already rejects the static `FieldMutationGuard` (`field.hidden` / `field.readOnly`) and computed types — restore inherits this; (2) but the spine **deliberately does not execute the per-subject layer-3 `field_permissions` write gate** (`fieldById` is built from ALL fields so a write-only-no-read field stays writable — see §1) — so restore **must implement the layer-3 pre-check itself**, exactly as the AI-shortcut run path does (`multitable-ai.ts:530`): reject a field whose `fieldPermissions[fieldId]` is missing, `visible === false`, or `readOnly === true`. Net policy: restore only writes fields the actor can both read and write; masked / read-only / unknown-permission fields are never written or read back. Default behavior is **atomic reject** if any restorable (non-computed, non-link) differing field fails either gate; per-field partial-skip is a deferred opt-in.
- **Update-restore only; undelete is out of scope (Lock C).** The endpoint operates on a **live** record: if the current record no longer exists in `meta_records` (hard-deleted), it returns `404 NOT_FOUND` first — undelete (resurrect + rebuild `meta_links`) is Slice 2. `targetVersion` resolution must be explicit because `(sheet_id, record_id, version)` is **not unique** (a `delete` revision reuses the pre-delete `serverVersion` without bumping — see §1): restore selects `WHERE version = $target AND action <> 'delete' ORDER BY created_at DESC LIMIT 1`; if none but a `delete` revision exists at that version → `RESTORE_UNSUPPORTED`; if no revision at all → `VERSION_NOT_FOUND`.

Reuse the canonical bulk write spine end-to-end (transaction + optimistic version check + static `FieldMutationGuard` + revision emit + `recalculateFormulaFields` + Yjs invalidation). Add exactly two restore-owned pieces on top: the layer-3 write pre-check (Lock B) and the unset primitive (§3). Introduce no parallel permission primitive and no second write path.

### Resolved Gate-0 decisions (owner sign-off 2026-06-15)

- **Write-gate conflict → atomic reject.** Slice 1 is fail-closed: any restorable differing field failing the static or layer-3 gate fails the whole restore (`RESTORE_FORBIDDEN`). `skippedFieldIds` stays in the contract but is **always `[]`** this slice; per-field partial restore is a separate future Gate.
- **Unset → faithful key removal.** Extend the bulk spine with `unsetFieldIds` and write `data = (data - unsetKeys) || setPatch` in one statement. Set-to-empty is rejected — it would erode Lock A (filter/formula and the empty/null/absent distinctions all come back to bite).
- **No revision-uniqueness migration in Slice 1.** Rely on the resolution rule (non-`delete` first; `delete`-only → `RESTORE_UNSUPPORTED`). A future hardening may add a **partial** unique index `… WHERE action <> 'delete'` (a blanket `(sheet_id, record_id, version)` unique is wrong — `delete` deliberately reuses the version).

### Pre-landing boundary patch (must be locked before Slice 1 implementation)

- **`source: 'restore'` extends `RecordWriteSource`.** `post-commit-hooks.ts:1` types it `'rest' | 'yjs-bridge'`; add `'restore'`. The invalidator skip is `=== 'yjs-bridge'`, so `'restore'` correctly **fires** the Yjs invalidation (it is not bridge-origin). The revision `source` column stores `'restore'` too.
- **No-op still validates `expectedVersion` first.** The optimistic-concurrency check runs before the empty-diff no-op returns (a stale caller must get `VERSION_CONFLICT`, not a misleading `noop: true`). See §3 algorithm ordering.
- **Schema drift is explicit, not silent.** A snapshot field id that no longer exists in the current sheet schema, or whose type changed since capture, → reject with `SCHEMA_DRIFT` (fail-closed; Slice 1 does not do cross-schema restore). Type-based exclusions (Lock D: computed/link/system-auto/attachment) are handled by type and are *not* drift.

## 1. Evidence

Revision capture is already transaction-inline on every write path, storing a full after-image `snapshot` plus the incremental `patch` and `changedFieldIds`:

- `packages/core-backend/src/multitable/record-service.ts:627` (create, `snapshot = patch`) and `:744` (delete, `snapshot = ` pre-delete data, `patch = {}`).
- `packages/core-backend/src/multitable/record-write-service.ts:735` (update, `snapshot = { ...previousData, ...patch }`).
- Store + read API: `packages/core-backend/src/multitable/record-history-service.ts` (`recordRecordRevision`, `listRecordRevisions`).

The version counter is the same optimistic-concurrency field the write paths already bump:

- `meta_records.version` — `packages/core-backend/src/db/migrations/zzz20251231_create_meta_schema.ts:48` (`NOT NULL DEFAULT 1`).
- `record-write-service.ts:726`: `SET data = data || $1::jsonb, ... version = version + 1`. This shallow JSONB **merge** is exactly why Lock A is needed.

The canonical write path fail-closes only on the **static** field guard — the per-subject layer-3 gate is deliberately NOT in it, which is why Lock B has restore enforce layer-3 itself:

- `record-write-service.ts:429-443`: `validateChanges` rejects `field.hidden` (`FIELD_HIDDEN`), `field.readOnly === true` (the static `FieldMutationGuard`, not per-subject), and computed types (`formula`/`lookup`/`rollup`).
- `univer-meta.ts:3181-3190`: the `/patch` context builds `fieldById` (the write gate) from **ALL** fields "so a write-only-no-read field remains writable", and states `patchRecords` itself **never executes the layer-3 write gate**; `fieldPermissions` is exposed for callers that need a layer-3 pre-check.
- `multitable-ai.ts:530`: the AI-shortcut run path IS such a caller — it pre-checks `fieldPermissions[fieldId]` (`visible === false || readOnly === true` → `403 FIELD_FORBIDDEN`) before delegating. Restore follows this exact precedent.
- Per-subject permission source: `permission-service.ts` `loadFieldPermissionScopeMap` (~`:807-848`) reads `field_permissions.visible` + `read_only` into `{ visible, readOnly }`. Columns: `zzzz20260411140100_create_field_permissions.ts` (`visible`, `read_only`).

The history read endpoint is **read-masked**, which is precisely why restore must source from the unmasked snapshot and gate on writes instead:

- `univer-meta.ts` `router.get('/sheets/:sheetId/records/:recordId/history')` (~`:5562`) → `maskStoredRecordFieldIds` + `redactRecordRevisionEntry` filter `patch`/`snapshot`/`changedFieldIds` by the actor's readable set.

Bulk writes to `meta_records.data` already have a realtime-collab reconciliation that restore must trigger:

- `index.ts:2370-2380`: REST→Yjs invalidator — `yjsBridge.cancelPending(recordIds)` + `yjsSyncService.invalidateDocs(recordIds)`; bridge-origin writes (`source:'yjs-bridge'`, `index.ts:2351-2356`) intentionally skip it.

Formula recompute on the bulk spine (so restored source values re-derive dependent computed fields):

- `record-write-service.ts:1021` `helpers.recalculateFormulaFields(...)` — this is the recompute the bulk `patchRecords` path uses. (Do **not** cite `record-service.ts` `formulaRecalcHook` / `:409` / `:650` — that is the create/single-service hook, a different path; restore is built on the bulk spine.)

Link values are mirrored into `data`, not exclusive to it (why Lock D excludes them):

- `record-write-service.ts:641`: `patch[fieldId] = ids` writes the link id array into `patch` → `data` → the after-image `snapshot`, while `:755-818` syncs `meta_links` separately. A `data`-only restore would leave `meta_links` (and its mirror projection) stale.

Snapshot is reliably populated; the "often null" comment is stale:

- All four capture sites pass a (possibly empty `{}`, never `null`) snapshot object: `record-service.ts:636` (create), `:753` (delete), `:1009` (update), `record-write-service.ts:744` (bulk update). yjs-bridge and automation writes route through these same sites, so they populate it too.
- The column is nullable and the F1-era comment `univer-meta.ts:5611` ("snapshot capture is often null anyway") is stale for current writes — restore still guards `S == null` defensively but keeps snapshot-read primary.

The spine skips zero-change writes, and the revision row has no native deletion marker (why §3 must lock unset + no-op semantics):

- `record-write-service.ts:687`: `if (applied === 0) continue` — a change set that mutates nothing produces no write and no revision.
- `record-history-service.ts:63`: the revision `patch` is stored as a plain JSON object (`JSON.stringify(input.patch ?? {})`); `changed_field_ids` is a separate `text[]`. There is no built-in representation for "field removed" — §3 defines one (`null` in `patch` = cleared; the field id still appears in `changedFieldIds`).

Delete revisions reuse the pre-delete version, and the table has no version uniqueness (why Lock C pins `targetVersion` resolution):

- `record-service.ts:744-747`: the `delete` revision is written with `version: serverVersion` (not bumped).
- `zzzz20260430172000_create_meta_record_revisions.ts`: only `id uuid PRIMARY KEY` — no unique constraint on `(sheet_id, record_id, version)`, so an `update` and a `delete` revision can share a version.

Gap that couples to retention: nothing prunes `meta_record_revisions` — the log grows unbounded and has no aging policy. Any "restore to any version" promise is only as durable as the (currently absent) retention rule.

## 2. Non-Goals

- No undelete / deleted-record resurrection, and no `meta_links` reconstruction (Slice 2).
- No link-field value restore (Lock D): link fields are excluded from the Slice 1 diff and restored together with `meta_links` handling in Slice 2.
- No attachment-field restore unless Gate 0 decides otherwise. Recommended deferral: attachment ids in `data` reference externally-retained blobs (attachment-orphan-retention), so an old attachment set may point at GC'd files; restoring it cleanly needs retention-aware handling, not a raw `data` write.
- No set-to-empty unset (decided): unset is faithful key removal (§3), so version-N reproduction is exact, not merely observable.
- No restore of computed / link / system-auto (`autoNumber`/`createdTime`/`modifiedTime`/`createdBy`/`modifiedBy`) fields — excluded by type (Lock D).
- No cross-schema restore: drifted field ids / changed types → `SCHEMA_DRIFT`, not a silent partial restore.
- No per-field partial-skip restore in this slice; atomic reject is the default (`skippedFieldIds` always `[]`). Partial restore is a deferred opt-in.
- No new permission model, no RBAC/auth central-file changes — endpoint-scoped kernel polish under the standing K3 lock.
- No base/sheet-level or schema-inclusive snapshot (Layer 2). No revival or repointing of the dormant view-level `SnapshotService`.
- No frontend in this slice (Slice 3); existing clients keep using the read-only timeline until the FE opt-in.
- No retention/prune implementation here, but its contract (see §3) is co-designed so the restore guarantee cannot silently rot.

## 3. Implementation Shape

### Contract (contracts-first; lock before runtime)

Request `{ targetVersion, expectedVersion }`; response `{ recordId, newVersion, noop, restoredFieldIds, skippedFieldIds }` (`noop: true` ⇒ empty restorable diff, `newVersion === current`, no revision). Error enum:

- `VERSION_NOT_FOUND` — no revision at `targetVersion` for this (sheet, record).
- `VERSION_CONFLICT` — `expectedVersion` ≠ current server version (optimistic concurrency).
- `RESTORE_UNSUPPORTED` — `targetVersion` resolves only to a `delete` revision (→ Slice 2). (A hard-deleted current record is `404 NOT_FOUND`, not this.)
- `RESTORE_FORBIDDEN` — a restorable differing field fails the static guard or the layer-3 pre-check (atomic-reject default).
- `SNAPSHOT_UNAVAILABLE` — resolved revision has a `null` snapshot (legacy/edge rows); restore cannot source values and refuses rather than guessing.
- `SCHEMA_DRIFT` — the snapshot references a field absent from the current schema, or a field whose type changed since capture; Slice 1 does not do cross-schema restore.
- `VERSION_EXPIRED` — reserved: target older than the retention floor once retention lands.

OpenAPI: add the path + all seven error codes + the `noop` response field, parity-locked with `packages/openapi`. Lock that `patch` values MAY be `null` to denote field removal (see the unset primitive below).

### Restore algorithm (the runtime contract)

Given current record (`data = C`, server version `Vcur`) and target revision N (full after-image `S`, read **unmasked** server-side):

1. Existence: if the current record is absent from `meta_records` → `404 NOT_FOUND` (undelete is Slice 2). Resolve the target: `WHERE version = $targetVersion AND action <> 'delete' ORDER BY created_at DESC LIMIT 1`; none but a `delete` at that version → `RESTORE_UNSUPPORTED`; no revision at all → `VERSION_NOT_FOUND`. If the resolved revision's snapshot is `null` → `SNAPSHOT_UNAVAILABLE` (do not fall back to patch replay).
2. **Concurrency pre-check (before any no-op):** read current `(C, Vcur)`; if `expectedVersion !== Vcur` → `VERSION_CONFLICT`. This runs for the no-op path too, so a stale caller never gets a misleading `noop: true`.
3. Compute the **restore diff** over restorable fields only. Exclude **by type** (Lock D): computed (`formula`/`lookup`/`rollup`), `link`, system/auto (`autoNumber`/`createdTime`/`modifiedTime`/`createdBy`/`modifiedBy`), and `attachment` (unless Gate 0 opts in). **Schema drift:** if `S` carries a field id absent from the current schema, or whose type changed since capture → `SCHEMA_DRIFT` (do not silently skip).
   - field in `S` and `C[f] !== S[f]` → **set** f to `S[f]`.
   - field in `C` but not in `S` → **unset** f (it did not exist at version N).
   - (An all-empty `S = {}` is valid — every current restorable field becomes an unset, gated below; it is not a null and not an error.)
4. Gate each differing field through **both** gates: (a) the static `FieldMutationGuard` the spine already enforces (`!hidden ∧ !readOnly`); (b) restore's own **layer-3 pre-check**, following `multitable-ai.ts:530` — reject if `fieldPermissions[fieldId]` is missing, `visible === false`, or `readOnly === true`. Any restorable differing field failing either → `RESTORE_FORBIDDEN` (atomic; nothing written). Masked / read-only fields are thereby never written or read back (Lock B).
5. If the gated diff is empty → **no-op**: return `{ noop: true, newVersion: Vcur, restoredFieldIds: [], skippedFieldIds: [] }` (no write, no revision; concurrency already checked in step 2). Otherwise apply within the canonical spine: `SELECT … FOR UPDATE` → **re-assert** `expectedVersion` (authoritative, anti-TOCTOU) → write the set ∪ unset diff (unsets must count toward `applied` so the write is not skipped — see the unset primitive) → `version = version + 1` → `recordRecordRevision({ action:'update', source:'restore', actorId, changedFieldIds: diff (incl. removed), patch (removed ⇒ null), snapshot: newAfterImage })`.
6. Recompute dependent computed fields via the bulk spine's `recalculateFormulaFields` (NOT `formulaRecalcHook`); trigger the REST→Yjs invalidator for `recordId` (a non-bridge write — `source:'restore'` is not skipped).
7. Return `{ recordId, newVersion: Vcur + 1, noop: false, restoredFieldIds: gatedDiff, skippedFieldIds: [] }` (`skippedFieldIds` always `[]` under atomic reject; meaningful only under the deferred partial-skip opt-in).

### The one new primitive: unset (mechanism decided — faithful key removal)

The canonical update is merge-only (`data || patch`) and cannot remove a key, short-circuits when `applied === 0` (`record-write-service.ts:687`), and the revision row has no deletion marker (`record-history-service.ts:63`). The unset primitive locks three things:

1. **Mechanism (decided): faithful key removal.** Extend the bulk spine to accept `unsetFieldIds` and write `data = (data - unsetKeys) || setPatch` in one statement — exact version-N reproduction. Set-to-empty is rejected: it erodes Lock A (filter/formula behavior and the empty/null/absent distinctions diverge from a true version-N state).
2. **`applied` accounting** — an unset-only restore must NOT hit the `applied === 0` skip: removals count toward `applied` so the write + revision happen. (The step-5 no-op path filters the empty diff out *before* the spine, so the skip never fires spuriously.)
3. **Revision representation** — a removed field appears in `changedFieldIds`, and its `patch` value is the locked sentinel `null` (= "cleared/removed"). The after-image `snapshot` simply omits the key. OpenAPI documents `null`-as-removal.

The extended write stays on the canonical validation + revision-emit path; no second write path is created (avoids wire-vs-fixture / parallel-primitive drift).

### Retention coupling (co-designed, may ship separately)

Lock the guarantee shape now even if prune lands later: "restore is guaranteed for the most recent N versions / D days; older points are restorable only if captured by a Layer-2 base snapshot." When retention prunes a target, restore returns `VERSION_EXPIRED`, never a silent half-restore. This is also the cleanest justification for Layer 2 existing.

## 4. Tests

Real-DB integration test (`describeIfDatabase`), wired into the Node 20 multitable real-DB CI step, mirroring `multitable-record-history-field-mask.test.ts`.

Seed: a record with a visible-writable field, a `read_only` field (layer-3), a computed (`formula`) field, a **link** field, and an `autoNumber` field — plus at least three versions so a non-trivial diff and a post-N-added field exist.

- `T1` faithful set+unset (Lock A): restore to N reproduces N's values exactly; a field added after N is **removed** (key absent, via `unsetFieldIds`), not set to empty; a blind `data || patch` would leave it and must fail this test.
- `T2` forward change: a new revision appears (`action='update'`, `source='restore'`, `version = Vcur+1`); the prior versions remain in history.
- `T3` undo of a restore: restoring to N creates revision M (= N's after-image at version `Vcur+1`); to undo it, restoring to the **pre-restore** version (the revision that was current before the restore) returns to that state. Re-restoring M itself is a redo/no-op, NOT a return to the pre-restore state — assert both.
- `T4` layer-3 write-gate (Lock B): a field with `field_permissions.read_only=true` (or `visible=false`) that differs between versions → atomic `RESTORE_FORBIDDEN`; nothing written; the value never appears in the response. (Proves restore's own layer-3 pre-check, since the spine does not enforce it.)
- `T4b` static-guard: a `property.readOnly`/`hidden` differing field is likewise refused.
- `T5` computed exclusion: a formula field differing between versions does not block restore and is recomputed, not written verbatim.
- `T5b` system/auto exclusion (Lock D): an `autoNumber` field differing between versions neither blocks restore nor is overwritten — it is excluded by type, and the live `autoNumber` value is unchanged.
- `T6` link exclusion (Lock D): a link field differing between versions is not written by restore, and `meta_links` for the record is left exactly as-is (no desync); the response reports it neither restored nor as a hard failure.
- `T6b` schema drift: a snapshot field id absent from the current schema (or whose type changed) → `SCHEMA_DRIFT`; nothing written, no silent partial.
- `T7` delete boundary + resolution (Lock C): a version that resolves only to a `delete` revision → `RESTORE_UNSUPPORTED`; a hard-deleted current record → `404`; a version shared by an `update` and a `delete` revision resolves to the `update` after-image.
- `T8` null-snapshot guard: a resolved revision with `snapshot = null` returns `SNAPSHOT_UNAVAILABLE`; no write, no patch-replay fallback.
- `T9` empty diff no-op: restoring to the current state with a correct `expectedVersion` writes nothing, bumps no version, emits no revision, returns `noop: true`. A no-op restore with a **stale** `expectedVersion` still returns `VERSION_CONFLICT` (the concurrency check precedes the no-op).
- `T10` concurrency: a competing write between read and apply → `VERSION_CONFLICT`.
- `T11` Yjs reconciliation: restore invalidates the record's Y.Doc (cancel pending bridge flush + invalidate), so a live editor re-seeds from the restored DB row.
- `T12` authz floor: a non-writer (sheet/record-level) is rejected before any field logic.

CI wiring is explicit, not glob-based: the new `tests/integration/multitable-record-restore.test.ts` must be added to the **enumerated `vitest ... run \` file list** in the Node 20 multitable real-DB step (`.github/workflows/plugin-tests.yml:~170`), and its suite added to that step's descriptive name. Without both edits it will not run in CI.

## 5. Review Checklist

- No code path re-applies the stored `patch` through `data || patch` to restore (Lock A enforced).
- Restore sources the unmasked snapshot but runs its **own** layer-3 pre-check (the spine does not); no `visible=false` / `read_only=true` / unknown-permission field is ever written or echoed (Lock B enforced).
- Computed, `link`, and system-auto (`autoNumber`/`createdTime`/`modifiedTime`/`createdBy`/`modifiedBy`) fields are excluded **by type** (Lock D); `meta_links` is never mutated by Slice 1; dependent computed fields are recomputed via `recalculateFormulaFields` (not `formulaRecalcHook`).
- Unset is faithful key removal (`unsetFieldIds`), not set-to-empty; removed fields are `null` in the revision `patch` and listed in `changedFieldIds`.
- Drifted field ids / changed types → `SCHEMA_DRIFT`; a `null` resolved snapshot → `SNAPSHOT_UNAVAILABLE`; neither falls back to patch replay or silent partial.
- A value-changing restore emits exactly one new revision and bumps `version`; an empty-diff restore is a no-op (no revision, no bump) filtered before the `applied===0` skip — but the `expectedVersion` concurrency check still runs (stale no-op → `VERSION_CONFLICT`).
- `targetVersion` resolution excludes `delete` revisions; hard-deleted record → `404`; ambiguous version resolves to the `update` after-image.
- `RecordWriteSource` includes `'restore'`; the invalidator skip (`=== 'yjs-bridge'`) leaves restore firing the Yjs invalidator — no live-editor stale-overwrite.
- One write path only; no parallel permission or write primitive introduced.
- Endpoint-scoped; no RBAC/auth central-file change (K3 lock).

## 6. Follow-Ups (each a separate gated opt-in)

- **Slice 2** — link-aware restore: (a) restore link-field values for live records by re-syncing `meta_links` + mirror fan-out (deferred from Slice 1 by Lock D); (b) undelete deleted records and rebuild their `meta_links` edges — first close the data gap (edges were hard-deleted and never captured in the snapshot).
- **Slice 3** — frontend: "restore to this version" + per-field (column-level) restore in the record drawer timeline; the natural re-home for `plugin-intelligent-restore` (else delete that unwired scaffold).
- **Retention** — implement the aging/prune policy co-designed in §3 and wire `VERSION_EXPIRED`.
- **Revision integrity hardening** — consider a **partial** unique index `(sheet_id, record_id, version) WHERE action <> 'delete'` (a blanket unique is wrong — `delete` reuses the version) plus link-value restore (Slice 2); not a Slice 1 migration.
- **Layer 2** — native `MetaSnapshotService`: base/sheet-level, schema-inclusive (`meta_fields`/`meta_views`/`meta_links`) checkpoints, borrowing the governance surface (lock / protection level / protection-rule block / expiry / tags / checksum / restore_log / metrics / audit) from the dormant view-level `SnapshotService` while keeping a multitable-native capture/restore core.
