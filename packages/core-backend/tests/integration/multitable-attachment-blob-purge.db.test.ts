import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool, type QueryResultRow } from 'pg'
import { randomUUID } from 'crypto'
import * as fsp from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {
  up as migrateUp,
  down as migrateDown,
} from '../../src/db/migrations/zzzz20260711090000_add_multitable_attachments_blob_purged_at'
import {
  readAttachmentForDelete,
  deleteAttachmentBinary,
} from '../../src/multitable/attachment-service'
import {
  sweepMultitableAttachmentBlobPurge,
  cleanupOrphanMultitableAttachments,
} from '../../src/multitable/attachment-orphan-retention'
import { StorageServiceImpl } from '../../src/services/StorageService'

// F9 storage-integrity owner CHANGES-REQUESTED design-lock (2026-07-10), GF9-1/GF9-2: real-Postgres +
// real-filesystem coverage for the `multitable_attachments.blob_purged_at` migration, the interactive
// delete path's index-free physical delete (`deleteAttachmentBinary` via `storage_path`), and the
// compensating sweep (`sweepMultitableAttachmentBlobPurge`) that reconciles a genuine physical-delete
// failure on an already-tombstoned row. Run against a throwaway isolated schema (mirrors
// tests/integration/files-orphan-blob-retention.db.test.ts's house rule for shared-DB integration: never
// touch the shared `public.multitable_attachments` other describeIfDatabase suites in this gate depend
// on) with a REAL local-filesystem StorageServiceImpl (temp dir) so `deleteByKey`'s actual fs.unlink /
// ENOENT semantics — and the in-memory `fileIndex`'s ABSENCE of drift-prone entries — are exercised, not
// mocked.

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

describeDb('F9 multitable-attachments blob-purge compensation (real DB, isolated schema)', () => {
  let adminPool: Pool
  let schema: string
  let testPool: Pool
  let testDb: Kysely<unknown>
  let storageRoot: string
  let storage: StorageServiceImpl

  // Mirrors files-orphan-blob-retention.db.test.ts's `queryFn` helper exactly — a generic function
  // wrapping the isolated-schema `testPool`, structurally compatible with both `AttachmentQueryFn`
  // (attachment-service.ts) and `typeof query` (attachment-orphan-retention.ts's queryFn option).
  function queryFn<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) {
    return testPool.query<T>(text, params)
  }

  beforeEach(async () => {
    adminPool = new Pool({ connectionString: dbUrl })
    schema = `f9blob_${randomUUID().replace(/-/g, '')}`
    await adminPool.query(`CREATE SCHEMA "${schema}"`)

    testPool = new Pool({ connectionString: dbUrl, options: `-c search_path=${schema}` })
    testDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: testPool }) })

    // Standalone `multitable_attachments` mirror at the pre-GF9-2 layout (`blob_purged_at` NOT yet
    // present) — no FK constraints to meta_sheets/meta_records (this isolated schema only needs the
    // attachment row itself; the columns those FKs guard are irrelevant to blob-purge behavior, exactly
    // like files-orphan-blob-retention.db.test.ts's standalone `files` mirror).
    await sql`
      CREATE TABLE multitable_attachments (
        id TEXT PRIMARY KEY,
        sheet_id TEXT NOT NULL,
        record_id TEXT NULL,
        field_id TEXT NULL,
        storage_file_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        original_name TEXT NULL,
        mime_type TEXT NOT NULL,
        size BIGINT NOT NULL DEFAULT 0,
        storage_path TEXT NOT NULL,
        storage_provider TEXT NOT NULL DEFAULT 'local',
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        deleted_at TIMESTAMPTZ NULL
      )
    `.execute(testDb)

    storageRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'f9-attachment-blob-'))
    storage = StorageServiceImpl.createLocalService(storageRoot, 'http://localhost:8900/files')
  })

  afterEach(async () => {
    await testDb.destroy()
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await adminPool.end()
    await fsp.rm(storageRoot, { recursive: true, force: true })
  })

  describe('zzzz20260711090000_add_multitable_attachments_blob_purged_at migration', () => {
    async function columnExists(): Promise<boolean> {
      const r = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = ${schema} AND table_name = 'multitable_attachments' AND column_name = 'blob_purged_at'
      `.execute(testDb)
      return (r.rows[0]?.n ?? 0) > 0
    }

    it('adds the column additively and is idempotent on re-run', async () => {
      expect(await columnExists()).toBe(false)
      await expect(migrateUp(testDb)).resolves.toBeUndefined()
      expect(await columnExists()).toBe(true)
      await expect(migrateUp(testDb)).resolves.toBeUndefined()
      expect(await columnExists()).toBe(true)
    })

    it('down() removes the column and is a no-op when already absent', async () => {
      await migrateUp(testDb)
      expect(await columnExists()).toBe(true)
      await expect(migrateDown(testDb)).resolves.toBeUndefined()
      expect(await columnExists()).toBe(false)
      await expect(migrateDown(testDb)).resolves.toBeUndefined()
      expect(await columnExists()).toBe(false)
    })

    it('no backfill — a pre-existing row gets blob_purged_at = NULL, not a value', async () => {
      await sql`
        INSERT INTO multitable_attachments (id, sheet_id, storage_file_id, filename, mime_type, storage_path)
        VALUES ('pre-1', 'sheet-1', 'file-1', 'a.txt', 'text/plain', 'file-1/a.txt')
      `.execute(testDb)
      await migrateUp(testDb)
      const r = await sql<{ blob_purged_at: Date | null }>`
        SELECT blob_purged_at FROM multitable_attachments WHERE id = 'pre-1'
      `.execute(testDb)
      expect(r.rows[0]?.blob_purged_at ?? null).toBeNull()
    })
  })

  describe('GF9-1/GF9-2: interactive delete path (readAttachmentForDelete + deleteAttachmentBinary, real DB + real fs)', () => {
    beforeEach(async () => {
      await migrateUp(testDb)
    })

    async function insertRow(row: {
      id: string
      storageFileId: string
      storagePath: string
      deletedAt?: Date | null
    }): Promise<void> {
      await sql`
        INSERT INTO multitable_attachments
          (id, sheet_id, record_id, field_id, storage_file_id, filename, mime_type, storage_path, created_by, deleted_at)
        VALUES
          (${row.id}, 'sheet-1', 'rec-1', 'fld-1', ${row.storageFileId}, 'a.txt', 'text/plain', ${row.storagePath}, 'user-1', ${row.deletedAt ?? null})
      `.execute(testDb)
    }

    async function rowState(id: string): Promise<{ deletedAt: Date | null; blobPurgedAt: Date | null }> {
      const r = await sql<{ deleted_at: Date | null; blob_purged_at: Date | null }>`
        SELECT deleted_at, blob_purged_at FROM multitable_attachments WHERE id = ${id}
      `.execute(testDb)
      return { deletedAt: r.rows[0]?.deleted_at ?? null, blobPurgedAt: r.rows[0]?.blob_purged_at ?? null }
    }

    async function writePhysical(key: string, content = 'blob-bytes'): Promise<string> {
      const full = path.resolve(storageRoot, key)
      await fsp.mkdir(path.dirname(full), { recursive: true })
      await fsp.writeFile(full, content)
      return full
    }
    const pathExists = async (p: string): Promise<boolean> => fsp.access(p).then(() => true).catch(() => false)

    it('readAttachmentForDelete reads storage_path from a real row', async () => {
      const key = `${randomUUID()}/report.pdf`
      await insertRow({ id: 'att-1', storageFileId: 'file-1', storagePath: key })

      const result = await readAttachmentForDelete({ query: queryFn, attachmentId: 'att-1' })

      expect(result?.storagePath).toBe(key)
    })

    it('GF9-1 (owner CHANGES-REQUESTED P2-1①) — deletes the blob by storage_path via a storage instance whose in-memory index never saw this file: index-free, no restart-drift 404', async () => {
      const key = `${randomUUID()}/report.pdf`
      const full = await writePhysical(key)
      await insertRow({ id: 'att-1', storageFileId: 'file-restart-drift', storagePath: key })

      // `storage`'s fileIndex was built fresh for this test's storageRoot and its `upload()` was never
      // called for this id — it has NO entry for `file-restart-drift`, exactly the state a NEW process /
      // restarted instance / rebuilt (md5-keyed) index would be in. `storage.delete(id)` (the pre-GF9-1
      // path) throws here; `deleteByKey(storage_path)` never consults the index, so it is unaffected.
      await expect(storage.delete('file-restart-drift')).rejects.toThrow('File not found')
      expect(await pathExists(full)).toBe(true) // the failed id-based delete left the blob untouched

      const attachmentRow = await readAttachmentForDelete({ query: queryFn, attachmentId: 'att-1' })
      await deleteAttachmentBinary({
        storage,
        storageFileId: 'file-restart-drift',
        storagePath: attachmentRow?.storagePath ?? null,
      })

      expect(await pathExists(full)).toBe(false)
    })

    it('GF9-2 (owner CHANGES-REQUESTED P2-1②, Option A) — a resolved delete (with query + attachmentId) stamps blob_purged_at on the real row', async () => {
      const key = `${randomUUID()}/report.pdf`
      await writePhysical(key)
      await insertRow({ id: 'att-2', storageFileId: 'file-2', storagePath: key, deletedAt: new Date() })

      await deleteAttachmentBinary({
        storage,
        storageFileId: 'file-2',
        storagePath: key,
        query: queryFn,
        attachmentId: 'att-2',
      })

      expect((await rowState('att-2')).blobPurgedAt).not.toBeNull()
    })

    it('GF9-2 — ENOENT (blob already gone on disk) is treated as success and still stamps blob_purged_at', async () => {
      const key = `${randomUUID()}/never-written.bin` // deliberately never written to disk
      await insertRow({ id: 'att-3', storageFileId: 'file-3', storagePath: key, deletedAt: new Date() })

      await deleteAttachmentBinary({
        storage,
        storageFileId: 'file-3',
        storagePath: key,
        query: queryFn,
        attachmentId: 'att-3',
      })

      expect((await rowState('att-3')).blobPurgedAt).not.toBeNull()
    })

    it('GF9-2 — a genuine (non-ENOENT) physical delete failure leaves blob_purged_at NULL for the compensating sweep to retry', async () => {
      const key = `${randomUUID()}/locked-dir`
      // A DIRECTORY at the storage_path, not a file: fs.unlink fails with a non-ENOENT error
      // (EISDIR/EPERM) — the real-world analogue of a permission/IO failure.
      await fsp.mkdir(path.resolve(storageRoot, key), { recursive: true })
      await insertRow({ id: 'att-4', storageFileId: 'file-4', storagePath: key, deletedAt: new Date() })

      await deleteAttachmentBinary({
        storage,
        storageFileId: 'file-4',
        storagePath: key,
        query: queryFn,
        attachmentId: 'att-4',
      })

      expect((await rowState('att-4')).blobPurgedAt).toBeNull()
    })
  })

  describe('GF9-2: sweepMultitableAttachmentBlobPurge (compensating sweep, real DB + real fs)', () => {
    beforeEach(async () => {
      await migrateUp(testDb)
    })

    async function insertRow(row: {
      id: string
      storagePath: string
      deletedAt: Date | null
    }): Promise<void> {
      await sql`
        INSERT INTO multitable_attachments
          (id, sheet_id, record_id, field_id, storage_file_id, filename, mime_type, storage_path, created_by, deleted_at)
        VALUES
          (${row.id}, 'sheet-1', 'rec-1', 'fld-1', ${row.id + '-file'}, 'a.txt', 'text/plain', ${row.storagePath}, 'user-1', ${row.deletedAt})
      `.execute(testDb)
    }

    async function blobPurgedAtOf(id: string): Promise<Date | null> {
      const r = await sql<{ blob_purged_at: Date | null }>`
        SELECT blob_purged_at FROM multitable_attachments WHERE id = ${id}
      `.execute(testDb)
      return r.rows[0]?.blob_purged_at ?? null
    }

    async function writePhysical(key: string, content = 'blob-bytes'): Promise<string> {
      const full = path.resolve(storageRoot, key)
      await fsp.mkdir(path.dirname(full), { recursive: true })
      await fsp.writeFile(full, content)
      return full
    }
    const pathExists = async (p: string): Promise<boolean> => fsp.access(p).then(() => true).catch(() => false)
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000)

    it('#1 — a soft-deleted row past grace with a real blob on disk: sweep deletes the blob and stamps blob_purged_at', async () => {
      const key = `${randomUUID()}/photo.jpg`
      const full = await writePhysical(key)
      await insertRow({ id: 'row-1', storagePath: key, deletedAt: hoursAgo(48) })

      const result = await sweepMultitableAttachmentBlobPurge({ queryFn, storage, graceHours: 24 })

      expect(result).toEqual({ inspected: 1, purged: 1, skipped: 0 })
      expect(await pathExists(full)).toBe(false)
      expect(await blobPurgedAtOf('row-1')).not.toBeNull()
    })

    it('#2 — idempotent: a second sweep after a purge selects nothing', async () => {
      const key = `${randomUUID()}/photo.jpg`
      await writePhysical(key)
      await insertRow({ id: 'row-2', storagePath: key, deletedAt: hoursAgo(48) })

      const first = await sweepMultitableAttachmentBlobPurge({ queryFn, storage, graceHours: 24 })
      expect(first.purged).toBe(1)

      const second = await sweepMultitableAttachmentBlobPurge({ queryFn, storage, graceHours: 24 })
      expect(second).toEqual({ inspected: 0, purged: 0, skipped: 0 })
    })

    it('#3 — ENOENT (blob already gone) is treated as success: stamped, no error', async () => {
      const key = `${randomUUID()}/never-written.bin`
      await insertRow({ id: 'row-3', storagePath: key, deletedAt: hoursAgo(48) })

      const result = await sweepMultitableAttachmentBlobPurge({ queryFn, storage, graceHours: 24 })

      expect(result).toEqual({ inspected: 1, purged: 1, skipped: 0 })
      expect(await blobPurgedAtOf('row-3')).not.toBeNull()
    })

    it('#4 — within grace period: not swept, blob left intact, blob_purged_at stays NULL', async () => {
      const key = `${randomUUID()}/fresh.jpg`
      const full = await writePhysical(key)
      await insertRow({ id: 'row-4', storagePath: key, deletedAt: hoursAgo(1) })

      const result = await sweepMultitableAttachmentBlobPurge({ queryFn, storage, graceHours: 24 })

      expect(result).toEqual({ inspected: 0, purged: 0, skipped: 0 })
      expect(await pathExists(full)).toBe(true)
      expect(await blobPurgedAtOf('row-4')).toBeNull()
    })

    it('#5 — an ACTIVE row (deleted_at NULL) is never swept', async () => {
      const key = `${randomUUID()}/active.jpg`
      const full = await writePhysical(key)
      await insertRow({ id: 'row-5', storagePath: key, deletedAt: null })

      const result = await sweepMultitableAttachmentBlobPurge({ queryFn, storage, graceHours: 24 })

      expect(result).toEqual({ inspected: 0, purged: 0, skipped: 0 })
      expect(await pathExists(full)).toBe(true)
      expect(await blobPurgedAtOf('row-5')).toBeNull()
    })

    it('#6 — a non-ENOENT physical delete failure is NOT stamped and is retried on the next sweep', async () => {
      const key = `${randomUUID()}/locked-dir`
      await fsp.mkdir(path.resolve(storageRoot, key), { recursive: true })
      await insertRow({ id: 'row-6', storagePath: key, deletedAt: hoursAgo(48) })

      const result = await sweepMultitableAttachmentBlobPurge({ queryFn, storage, graceHours: 24 })
      expect(result).toEqual({ inspected: 1, purged: 0, skipped: 1 })
      expect(await blobPurgedAtOf('row-6')).toBeNull()

      const retry = await sweepMultitableAttachmentBlobPurge({ queryFn, storage, graceHours: 24 })
      expect(retry).toEqual({ inspected: 1, purged: 0, skipped: 1 })
    })

    it('a batch mixes a purgeable row and a within-grace row: only the eligible one is swept', async () => {
      const eligibleKey = `${randomUUID()}/eligible.jpg`
      const graceKey = `${randomUUID()}/in-grace.jpg`
      const eligibleFull = await writePhysical(eligibleKey)
      const graceFull = await writePhysical(graceKey)
      await insertRow({ id: 'batch-eligible', storagePath: eligibleKey, deletedAt: hoursAgo(48) })
      await insertRow({ id: 'batch-grace', storagePath: graceKey, deletedAt: hoursAgo(1) })

      const result = await sweepMultitableAttachmentBlobPurge({ queryFn, storage, graceHours: 24 })

      expect(result).toEqual({ inspected: 1, purged: 1, skipped: 0 })
      expect(await pathExists(eligibleFull)).toBe(false)
      expect(await pathExists(graceFull)).toBe(true)
      expect(await blobPurgedAtOf('batch-eligible')).not.toBeNull()
      expect(await blobPurgedAtOf('batch-grace')).toBeNull()
    })

    it('GF9-2 ⚠ connected change — the DRAFT-orphan sweep (cleanupOrphanMultitableAttachments) also stamps blob_purged_at, so the row it just tombstoned is NOT re-selected by this compensating sweep on the next tick', async () => {
      const key = `${randomUUID()}/draft.jpg`
      const full = await writePhysical(key)
      // A never-linked draft attachment (record_id IS NULL), old enough for the draft sweep's own
      // retention window, and NOT yet soft-deleted — this is cleanupOrphanMultitableAttachments's entry
      // condition (`record_id IS NULL AND deleted_at IS NULL AND created_at < now() - retention`).
      await sql`
        INSERT INTO multitable_attachments
          (id, sheet_id, record_id, field_id, storage_file_id, filename, mime_type, storage_path, created_by, created_at, deleted_at)
        VALUES
          ('draft-1', 'sheet-1', NULL, NULL, 'draft-1-file', 'a.txt', 'text/plain', ${key}, 'user-1', now() - interval '48 hours', NULL)
      `.execute(testDb)

      const draftStorage = {
        delete: async (_storageFileId: string, storagePath: string) => {
          await fsp.unlink(path.resolve(storageRoot, storagePath))
        },
      }
      const draftResult = await cleanupOrphanMultitableAttachments({
        queryFn,
        storage: draftStorage,
        retentionHours: 24,
      })
      expect(draftResult).toEqual({ inspected: 1, deleted: 1, skipped: 0 })
      expect(await pathExists(full)).toBe(false)

      const draftRow = await sql<{ deleted_at: Date | null; blob_purged_at: Date | null }>`
        SELECT deleted_at, blob_purged_at FROM multitable_attachments WHERE id = 'draft-1'
      `.execute(testDb)
      expect(draftRow.rows[0]?.deleted_at).not.toBeNull()
      // the connected change under test: the draft sweep's own tombstone UPDATE also stamps
      // blob_purged_at, so the compensating sweep's `blob_purged_at IS NULL` entry condition already
      // excludes it — without this, deleted_at just flipped NULL→NOT NULL and the row would become a
      // FRESH candidate for the compensating sweep below, re-attempting an already-done delete forever.
      expect(draftRow.rows[0]?.blob_purged_at).not.toBeNull()

      const compensatingResult = await sweepMultitableAttachmentBlobPurge({ queryFn, storage, graceHours: 0 })
      expect(compensatingResult).toEqual({ inspected: 0, purged: 0, skipped: 0 })
    })
  })
})
