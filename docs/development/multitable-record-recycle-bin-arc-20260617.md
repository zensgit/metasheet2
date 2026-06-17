# Multitable Record Recycle Bin (#15) — ARC note

Record deletion is a hard delete from `meta_records`. This arc adds a recycle bin: on delete the row is
copied into a dedicated `meta_records_trash` table in the **same transaction**, so it can be listed and
restored.

## Design decisions (conservative, reversible)

- **Separate table, not a tombstone column.** Deleted rows land in `meta_records_trash` (surrogate uuid PK
  + `record_id` of the original). Every existing read path is untouched — no `WHERE deleted_at IS NULL`
  guards to add and no fail-open risk. The trash table is independent of the existing
  `meta_record_revisions` delete snapshot.
- **Retention is disabled by default.** Trashed rows are kept until an explicit purge; there is no
  automatic aging. A retention/purge policy can be layered on later without changing this contract.
- **Record-id reuse: reject on conflict.** Record ids are server-generated (`randomUUID`), so collisions
  are essentially nil; if the original id is occupied by a live record at restore time, restore is rejected
  with **409** rather than overwriting the live record.
- **Cascade is best-effort.** Inbound links are not snapshotted (the hard delete already removes
  `meta_links`); a restored record reappears without its former inbound link rows. Documented limitation.

## Surface

- `DELETE /records/:recordId` — unchanged contract; now also copies the row into the trash (txn-local,
  guarded so a pre-migration DB still deletes cleanly).
- `GET /sheets/:sheetId/trash` — list deleted records (newest first, paginated). Gated on
  `canDeleteRecord`, **and under sheet write-own narrowed to the actor's own trash** (see Permissions);
  returned record data is **field-masked** through the same chokepoint as live reads.
- `POST /records/:recordId/restore` — restore the most-recently-deleted trash row for that id. 409 if the
  id is occupied; 403 for a non-deleter **or a write-own actor restoring another user's row**; 404 if there
  is nothing to restore.

## Permissions

`canDeleteRecord` (== `canWrite`) gates both list and restore; a read-only actor receives 403. Beyond that,
the trash API mirrors the live write/read contract (hardened in PR #2794 after the initial cut gated on
`canDeleteRecord` alone):

- **Write-own row policy.** When `requiresOwnWriteRowPolicy(sheetScope, isAdminRole)` holds (write-own, not
  full write/admin), `listDeletedRecords` adds an own-only SQL filter (`created_by = $actor`) to **both** the
  count and rows queries (so total + pagination stay exact), and `restoreRecord` re-checks the trash row's
  `created_by` through `ensureRecordWriteAllowed(..., 'delete')`. A write-own actor therefore sees and
  restores **only their own** trash, never another user's.
- **Field-read mask.** The list handler masks each record's `data` via the live-read chokepoint
  (`maskStoredRecordFieldIds` → `filterRecordDataByFieldIds`), so `field_permissions.visible=false` values do
  not leak through the trash API.
- **Record-level read-deny is out of scope here** by the same `#2787` contract that governs every read path:
  record-read is currently non-gating (`access_level` is CHECK-constrained to `read`/`write`/`admin`, so no
  deny is constructible), and the trash paths deliberately do **not** yet call `requireRecordReadable`. When
  the future private-record / read-deny arc (B) lands, `GET /sheets/:sheetId/trash` and
  `POST /records/:recordId/restore` **must** be included in that read-path sweep (restore can call
  `requireRecordReadable` directly; the list needs batched scope-loading, not a per-record query).

## Verification

Real-DB integration (`multitable-record-recycle-bin.test.ts`, in the `plugin-tests.yml` allowlist):
delete→trash→restore round-trip; restore-into-occupied-id → 409 with the live record untouched;
read-only actor denied (403) for both list and restore. FE composable contract (`multitable-trash-fe.spec.ts`,
in the `multitable-web-guard` lane): load populates list+total; restore is optimistic-on-success and never
throws (409/403 surface via `error`).
