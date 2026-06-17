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
  `canDeleteRecord` (whoever may delete may view + restore the trash).
- `POST /records/:recordId/restore` — restore the most-recently-deleted trash row for that id. 409 if the
  id is occupied; 403 for a non-deleter; 404 if there is nothing to restore.

## Permissions

`canDeleteRecord` (== `canWrite`) gates both list and restore. A read-only actor receives 403.

## Verification

Real-DB integration (`multitable-record-recycle-bin.test.ts`, in the `plugin-tests.yml` allowlist):
delete→trash→restore round-trip; restore-into-occupied-id → 409 with the live record untouched;
read-only actor denied (403) for both list and restore. FE composable contract (`multitable-trash-fe.spec.ts`,
in the `multitable-web-guard` lane): load populates list+total; restore is optimistic-on-success and never
throws (409/403 surface via `error`).
