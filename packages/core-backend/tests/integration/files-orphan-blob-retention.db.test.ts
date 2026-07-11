import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool, type QueryResultRow } from 'pg'
import { randomUUID } from 'crypto'
import * as fsp from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {
  up as migrateUp,
  down as migrateDown,
} from '../../src/db/migrations/zzzz20260710150000_add_files_blob_purged_at'
import { sweepOrphanFileBlobs } from '../../src/services/files-orphan-blob-retention'
import { StorageServiceImpl } from '../../src/services/StorageService'

// F5 files-orphan-blob-retention design-lock (2026-07-10), GF5-8: real-Postgres coverage for the
// `blob_purged_at` migration AND the sweep's full 8-item matrix + GF5-3b, run against a throwaway
// isolated schema (mirrors tests/integration/files-storage-key-migration.db.test.ts — the house rule for
// shared-DB integration: never touch the shared `public.files` other describeIfDatabase suites in this
// gate depend on) with a REAL local-filesystem StorageServiceImpl (temp dir) so `deleteByKey`'s actual
// fs.unlink / ENOENT semantics are exercised, not mocked.

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

describeDb('F5 files-orphan-blob-retention (real DB, isolated schema)', () => {
  let adminPool: Pool
  let schema: string
  let testPool: Pool
  let testDb: Kysely<unknown>
  let storageRoot: string
  let storage: StorageServiceImpl

  function queryFn<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) {
    return testPool.query<T>(text, params as unknown[])
  }

  beforeEach(async () => {
    adminPool = new Pool({ connectionString: dbUrl })
    schema = `f5orph_${randomUUID().replace(/-/g, '')}`
    await adminPool.query(`CREATE SCHEMA "${schema}"`)

    testPool = new Pool({ connectionString: dbUrl, options: `-c search_path=${schema}` })
    testDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: testPool }) })

    // Mirror the real `files` table at the F3 layout (storage_key present, blob_purged_at NOT yet) —
    // exactly what a real DB looks like immediately before this migration runs.
    await sql`
      CREATE TABLE files (
        id TEXT PRIMARY KEY,
        url TEXT NULL,
        owner_id TEXT NULL,
        meta JSONB NOT NULL DEFAULT '{}'::jsonb,
        storage_key TEXT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        deleted_at TIMESTAMPTZ NULL
      )
    `.execute(testDb)

    storageRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'f5-orphan-blob-'))
    storage = StorageServiceImpl.createLocalService(storageRoot, 'http://localhost:8900/files')
  })

  afterEach(async () => {
    await testDb.destroy()
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await adminPool.end()
    await fsp.rm(storageRoot, { recursive: true, force: true })
  })

  describe('zzzz20260710150000_add_files_blob_purged_at migration', () => {
    async function columnExists(): Promise<boolean> {
      const r = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_schema = ${schema} AND table_name = 'files' AND column_name = 'blob_purged_at'
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
      await sql`INSERT INTO files (id, url, owner_id) VALUES ('pre-1', 'http://x/y', 'owner-1')`.execute(testDb)
      await migrateUp(testDb)
      const r = await sql<{ blob_purged_at: Date | null }>`SELECT blob_purged_at FROM files WHERE id = 'pre-1'`.execute(testDb)
      expect(r.rows[0]?.blob_purged_at ?? null).toBeNull()
    })
  })

  describe('sweepOrphanFileBlobs (GF5-8 matrix)', () => {
    beforeEach(async () => {
      await migrateUp(testDb)
    })

    async function insertRow(row: {
      id: string
      storageKey: string | null
      deletedAt: Date | null
    }): Promise<void> {
      await sql`
        INSERT INTO files (id, url, owner_id, meta, storage_key, created_at, deleted_at)
        VALUES (${row.id}, ${'http://x/' + row.id}, ${'owner-' + row.id}, '{}'::jsonb, ${row.storageKey}, now(), ${row.deletedAt})
      `.execute(testDb)
    }

    async function blobPurgedAtOf(id: string): Promise<Date | null> {
      const r = await sql<{ blob_purged_at: Date | null }>`SELECT blob_purged_at FROM files WHERE id = ${id}`.execute(testDb)
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

    it('#1 — tombstoned row past grace with a real blob on disk: sweep deletes the blob and stamps blob_purged_at', async () => {
      const key = `${randomUUID()}/photo.jpg`
      const full = await writePhysical(key)
      await insertRow({ id: 'row-1', storageKey: key, deletedAt: hoursAgo(48) })

      const result = await sweepOrphanFileBlobs({ queryFn, storage, graceHours: 24 })

      expect(result).toEqual({ inspected: 1, purged: 1, skipped: 0 })
      expect(await pathExists(full)).toBe(false)
      expect(await blobPurgedAtOf('row-1')).not.toBeNull()
    })

    it('#2 — idempotent: a second sweep after a purge selects nothing (recon\'s "无限循环守卫" proof)', async () => {
      const key = `${randomUUID()}/photo.jpg`
      await writePhysical(key)
      await insertRow({ id: 'row-2', storageKey: key, deletedAt: hoursAgo(48) })

      const first = await sweepOrphanFileBlobs({ queryFn, storage, graceHours: 24 })
      expect(first.purged).toBe(1)

      const deleteSpy = vi.spyOn(storage, 'deleteByKey')
      const second = await sweepOrphanFileBlobs({ queryFn, storage, graceHours: 24 })

      expect(second).toEqual({ inspected: 0, purged: 0, skipped: 0 })
      expect(deleteSpy).not.toHaveBeenCalled()
    })

    it('#3 — ENOENT (blob already gone on disk) is treated as success: stamped, no error', async () => {
      const key = `${randomUUID()}/never-written.bin` // deliberately never written to disk
      await insertRow({ id: 'row-3', storageKey: key, deletedAt: hoursAgo(48) })

      const result = await sweepOrphanFileBlobs({ queryFn, storage, graceHours: 24 })

      expect(result).toEqual({ inspected: 1, purged: 1, skipped: 0 })
      expect(await blobPurgedAtOf('row-3')).not.toBeNull()
    })

    it('#4 — within grace period: not swept, blob left intact, blob_purged_at stays NULL', async () => {
      const key = `${randomUUID()}/fresh.jpg`
      const full = await writePhysical(key)
      await insertRow({ id: 'row-4', storageKey: key, deletedAt: hoursAgo(1) }) // well within 24h grace

      const result = await sweepOrphanFileBlobs({ queryFn, storage, graceHours: 24 })

      expect(result).toEqual({ inspected: 0, purged: 0, skipped: 0 })
      expect(await pathExists(full)).toBe(true)
      expect(await blobPurgedAtOf('row-4')).toBeNull()
    })

    it('#5 — an ACTIVE row (deleted_at NULL) is never swept', async () => {
      const key = `${randomUUID()}/active.jpg`
      const full = await writePhysical(key)
      await insertRow({ id: 'row-5', storageKey: key, deletedAt: null })

      const result = await sweepOrphanFileBlobs({ queryFn, storage, graceHours: 24 })

      expect(result).toEqual({ inspected: 0, purged: 0, skipped: 0 })
      expect(await pathExists(full)).toBe(true)
      expect(await blobPurgedAtOf('row-5')).toBeNull()
    })

    it('#6 — a POISONED storage_key row is excluded at the SQL candidate stage (GF9-4): never a candidate, never deleted, blob_purged_at stays NULL', async () => {
      const deleteSpy = vi.spyOn(storage, 'deleteByKey')
      await insertRow({ id: 'row-6', storageKey: '!f3-collision:row-6', deletedAt: hoursAgo(48) })

      const result = await sweepOrphanFileBlobs({ queryFn, storage, graceHours: 24 })

      // F9 design-lock GF9-4 (owner CHANGES-REQUESTED P2-3): the poisoned key is now excluded by the
      // `NOT starts_with(storage_key, ...)` SQL predicate itself — it is no longer a SQL-level candidate
      // at all (inspected=0, skipped=0), unlike the pre-fix behavior where it WAS selected and then
      // skipped inside the loop (inspected=1, skipped=1). This is the fix for the head-of-line-blocking
      // bug: a batch of nothing but poison rows used to starve out older-but-purgeable rows behind them.
      expect(result).toEqual({ inspected: 0, purged: 0, skipped: 0 })
      expect(deleteSpy).not.toHaveBeenCalled()
      expect(await blobPurgedAtOf('row-6')).toBeNull()
    })

    it('#7 — a NULL storage_key row is excluded at the query level: never a candidate', async () => {
      await insertRow({ id: 'row-7', storageKey: null, deletedAt: hoursAgo(48) })

      const result = await sweepOrphanFileBlobs({ queryFn, storage, graceHours: 24 })

      expect(result).toEqual({ inspected: 0, purged: 0, skipped: 0 })
      expect(await blobPurgedAtOf('row-7')).toBeNull()
    })

    it('#8 — a non-ENOENT physical delete failure is NOT stamped and is retried on the next sweep', async () => {
      const key = `${randomUUID()}/locked-dir`
      // A DIRECTORY at the storage key path, not a file: fs.unlink on a directory fails with a
      // non-ENOENT error (EISDIR/EPERM) — the real-world analogue of a permission/IO failure.
      await fsp.mkdir(path.resolve(storageRoot, key), { recursive: true })
      await insertRow({ id: 'row-8', storageKey: key, deletedAt: hoursAgo(48) })

      const result = await sweepOrphanFileBlobs({ queryFn, storage, graceHours: 24 })
      expect(result).toEqual({ inspected: 1, purged: 0, skipped: 1 })
      expect(await blobPurgedAtOf('row-8')).toBeNull()

      // retried on the next tick: still selected, still not stamped
      const retry = await sweepOrphanFileBlobs({ queryFn, storage, graceHours: 24 })
      expect(retry).toEqual({ inspected: 1, purged: 0, skipped: 1 })
    })

    it('GF5-3b — two un-purged rows sharing one storage_key are BOTH skipped (no keep-one-winner delete)', async () => {
      const key = `${randomUUID()}/shared-legacy.jpg`
      const full = await writePhysical(key)
      await insertRow({ id: 'dup-a', storageKey: key, deletedAt: hoursAgo(48) })
      await insertRow({ id: 'dup-b', storageKey: key, deletedAt: hoursAgo(48) })

      const result = await sweepOrphanFileBlobs({ queryFn, storage, graceHours: 24 })

      expect(result).toEqual({ inspected: 2, purged: 0, skipped: 2 })
      expect(await pathExists(full)).toBe(true)
      expect(await blobPurgedAtOf('dup-a')).toBeNull()
      expect(await blobPurgedAtOf('dup-b')).toBeNull()
    })

    it('GF9-4 owner-named test — batchSize=1 + oldest-row-is-poison + newer-row-is-valid: the valid row is still processed (poison no longer head-of-line-blocks)', async () => {
      const validKey = `${randomUUID()}/ok.jpg`
      const validFull = await writePhysical(validKey)
      // Oldest (deletedAt further in the past) is poison; a newer, genuinely purgeable row follows it.
      // Pre-GF9-4, `ORDER BY deleted_at ASC LIMIT 1` would select ONLY the poison row every tick (it
      // satisfies every other predicate), so the valid row behind it would never be reached — this test
      // fails on the pre-fix query (poison would occupy the sole batch slot; valid would show
      // inspected:0, purged:0, skipped:0 forever). Post-fix, poison is excluded at the SQL stage, so with
      // batchSize=1 the single slot goes to the valid row.
      await insertRow({ id: 'poison-oldest', storageKey: '!f3-collision:poison-oldest', deletedAt: hoursAgo(72) })
      await insertRow({ id: 'valid-newer', storageKey: validKey, deletedAt: hoursAgo(48) })

      const result = await sweepOrphanFileBlobs({ queryFn, storage, graceHours: 24, batchSize: 1 })

      expect(result).toEqual({ inspected: 1, purged: 1, skipped: 0 })
      expect(await pathExists(validFull)).toBe(false)
      expect(await blobPurgedAtOf('valid-newer')).not.toBeNull()
      expect(await blobPurgedAtOf('poison-oldest')).toBeNull()

      // second sweep: valid row already purged and dropped out of the candidate set; poison row is
      // permanently excluded by the SQL predicate — nothing left to inspect.
      const second = await sweepOrphanFileBlobs({ queryFn, storage, graceHours: 24, batchSize: 1 })
      expect(second).toEqual({ inspected: 0, purged: 0, skipped: 0 })
    })

    it('a batch mixes a purgeable row and a within-grace row: only the eligible one is swept', async () => {
      const eligibleKey = `${randomUUID()}/eligible.jpg`
      const graceKey = `${randomUUID()}/in-grace.jpg`
      const eligibleFull = await writePhysical(eligibleKey)
      const graceFull = await writePhysical(graceKey)
      await insertRow({ id: 'batch-eligible', storageKey: eligibleKey, deletedAt: hoursAgo(48) })
      await insertRow({ id: 'batch-grace', storageKey: graceKey, deletedAt: hoursAgo(1) })

      const result = await sweepOrphanFileBlobs({ queryFn, storage, graceHours: 24 })

      expect(result).toEqual({ inspected: 1, purged: 1, skipped: 0 })
      expect(await pathExists(eligibleFull)).toBe(false)
      expect(await pathExists(graceFull)).toBe(true)
      expect(await blobPurgedAtOf('batch-eligible')).not.toBeNull()
      expect(await blobPurgedAtOf('batch-grace')).toBeNull()
    })

    describe('GF9-3 atomic tombstone write-back (owner CHANGES-REQUESTED P2-2, real Postgres COALESCE semantics)', () => {
      async function storageKeyOf(id: string): Promise<string | null> {
        const r = await sql<{ storage_key: string | null }>`SELECT storage_key FROM files WHERE id = ${id}`.execute(testDb)
        return r.rows[0]?.storage_key ?? null
      }

      async function deletedAtOf(id: string): Promise<Date | null> {
        const r = await sql<{ deleted_at: Date | null }>`SELECT deleted_at FROM files WHERE id = ${id}`.execute(testDb)
        return r.rows[0]?.deleted_at ?? null
      }

      // Mirrors the EXACT SQL shape `routes/files.ts`'s delete route now runs (GF9-3): a single atomic
      // UPDATE that tombstones AND folds a url-derived fallback key into `storage_key` via COALESCE,
      // guarded by `deleted_at IS NULL` so it only ever fires against an active row.
      async function runAtomicTombstone(id: string, derivedKey: string | null): Promise<void> {
        await sql`
          UPDATE files SET deleted_at = now(), storage_key = COALESCE(storage_key, ${derivedKey})
          WHERE id = ${id} AND deleted_at IS NULL
        `.execute(testDb)
      }

      it('a NULL storage_key row: the atomic tombstone UPDATE persists the derived key (COALESCE fallback applies)', async () => {
        await insertRow({ id: 'p22-null', storageKey: null, deletedAt: null })

        await runAtomicTombstone('p22-null', 'legacy/derived-key.jpg')

        expect(await storageKeyOf('p22-null')).toBe('legacy/derived-key.jpg')
        expect(await deletedAtOf('p22-null')).not.toBeNull()
      })

      it('a row with an EXISTING persisted storage_key: COALESCE keeps it — the fallback param never overwrites a real key', async () => {
        await insertRow({ id: 'p22-persisted', storageKey: 'uuid-real/photo.jpg', deletedAt: null })

        // The route computes derivedKey=null whenever resolveActiveStorageKey found a persisted
        // (non-poisoned) key (derivedFromUrl === false) — this call mirrors that.
        await runAtomicTombstone('p22-persisted', null)

        expect(await storageKeyOf('p22-persisted')).toBe('uuid-real/photo.jpg')
      })

      it('an ALREADY-TOMBSTONED row: the `deleted_at IS NULL` guard makes a repeat call a no-op (never double-tombstones, never re-derives)', async () => {
        await insertRow({ id: 'p22-repeat', storageKey: null, deletedAt: null })
        await runAtomicTombstone('p22-repeat', 'first-derived.jpg')
        const firstDeletedAt = await deletedAtOf('p22-repeat')

        // A second call (simulating what a POST-tombstone separate writeback UPDATE using the SAME
        // `deleted_at IS NULL` guard would have silently no-op'd on for the FIRST call too — the exact bug
        // GF9-3 closes) must not overwrite anything on an already-tombstoned row.
        await runAtomicTombstone('p22-repeat', 'second-derived-should-not-apply.jpg')

        expect(await storageKeyOf('p22-repeat')).toBe('first-derived.jpg')
        expect(await deletedAtOf('p22-repeat')).toEqual(firstDeletedAt)
      })

      it('end-to-end with the sweep: a NULL-storage_key row tombstoned via the atomic write-back is later picked up and purged by sweepOrphanFileBlobs (proves the row is no longer permanently excluded by `storage_key IS NOT NULL`)', async () => {
        const derivedKey = `${randomUUID()}/recovered.jpg`
        const full = await writePhysical(derivedKey)
        await insertRow({ id: 'p22-e2e', storageKey: null, deletedAt: null })

        await runAtomicTombstone('p22-e2e', derivedKey)
        // Backdate deleted_at past grace — the route's `now()` tombstone would otherwise be within grace.
        await sql`UPDATE files SET deleted_at = ${hoursAgo(48)} WHERE id = ${'p22-e2e'}`.execute(testDb)

        expect(await storageKeyOf('p22-e2e')).toBe(derivedKey)
        expect(await blobPurgedAtOf('p22-e2e')).toBeNull()

        const result = await sweepOrphanFileBlobs({ queryFn, storage, graceHours: 24 })

        expect(result.purged).toBeGreaterThanOrEqual(1)
        expect(await pathExists(full)).toBe(false)
        expect(await blobPurgedAtOf('p22-e2e')).not.toBeNull()
      })
    })
  })
})
