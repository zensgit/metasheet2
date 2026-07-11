import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool, type QueryResultRow } from 'pg'
import { randomUUID } from 'crypto'
import * as fsp from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {
  up as migrateUp,
} from '../../src/db/migrations/zzzz20260711090000_add_multitable_attachments_blob_purged_at'
import {
  sweepMultitableAttachmentBlobPurge,
  cleanupOrphanMultitableAttachments,
} from '../../src/multitable/attachment-orphan-retention'

// F10 design-lock (2026-07-11), GF10-1/GF10-2 — owner P1 finding: the two *default* deleters
// (`deleteLocalAttachment` / `deleteLocalAttachmentByKey`) in attachment-orphan-retention.ts used a bare
// `path.join(base, storagePath)` before this fix, which let a `storage_path` containing `../` resolve
// OUTSIDE the attachment storage root and `fs.unlink` an arbitrary file on the host — reproduced by the
// owner with `storage_path='../victim.txt'` (sweep reported purged=1, victim deleted).
//
// CRITICAL for this test file: unlike multitable-attachment-blob-purge.db.test.ts (which always injects a
// real `StorageServiceImpl` via the `storage` option), every test below calls
// `sweepMultitableAttachmentBlobPurge` / `cleanupOrphanMultitableAttachments` WITHOUT a `storage` option —
// exercising the module's own default deleters (gated only via `ATTACHMENT_PATH`). Injecting
// `StorageServiceImpl` would only prove the already-safe `resolveWithinBase`-backed path is safe (it
// always was) — a false green that does not touch the P1 finding at all.
const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

describeDb('F10 multitable-attachments default-deleter root-escape containment (real DB + real fs, default storage — NOT injected)', () => {
  let adminPool: Pool
  let schema: string
  let testPool: Pool
  let testDb: Kysely<unknown>
  let tmpRoot: string
  let attachmentsDir: string
  let originalAttachmentPath: string | undefined

  function queryFn<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) {
    return testPool.query<T>(text, params)
  }

  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000)
  const pathExists = async (p: string): Promise<boolean> => fsp.access(p).then(() => true).catch(() => false)

  beforeEach(async () => {
    adminPool = new Pool({ connectionString: dbUrl })
    schema = `f10escape_${randomUUID().replace(/-/g, '')}`
    await adminPool.query(`CREATE SCHEMA "${schema}"`)

    testPool = new Pool({ connectionString: dbUrl, options: `-c search_path=${schema}` })
    testDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: testPool }) })

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
    await migrateUp(testDb)

    // `<tmp>/attachments` is the containment base (`ATTACHMENT_PATH`); `<tmp>/victim*.txt` sits ONE level
    // above it, so a `storage_path` of `../victim.txt` resolves to exactly that file — the owner's repro.
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'f10-root-escape-'))
    attachmentsDir = path.join(tmpRoot, 'attachments')
    await fsp.mkdir(attachmentsDir, { recursive: true })

    originalAttachmentPath = process.env.ATTACHMENT_PATH
    process.env.ATTACHMENT_PATH = attachmentsDir
  })

  afterEach(async () => {
    if (originalAttachmentPath === undefined) {
      delete process.env.ATTACHMENT_PATH
    } else {
      process.env.ATTACHMENT_PATH = originalAttachmentPath
    }

    await testDb.destroy()
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await adminPool.end()
    await fsp.rm(tmpRoot, { recursive: true, force: true })
  })

  async function insertBlobPurgeRow(row: { id: string; storagePath: string; deletedAt: Date }): Promise<void> {
    await sql`
      INSERT INTO multitable_attachments
        (id, sheet_id, record_id, field_id, storage_file_id, filename, mime_type, storage_path, created_by, deleted_at)
      VALUES
        (${row.id}, 'sheet-1', 'rec-1', 'fld-1', ${row.id + '-file'}, 'a.txt', 'text/plain', ${row.storagePath}, 'user-1', ${row.deletedAt})
    `.execute(testDb)
  }

  async function insertDraftRow(row: { id: string; storagePath: string; createdAt: Date }): Promise<void> {
    await sql`
      INSERT INTO multitable_attachments
        (id, sheet_id, record_id, field_id, storage_file_id, filename, mime_type, storage_path, created_by, created_at, deleted_at)
      VALUES
        (${row.id}, 'sheet-1', NULL, NULL, ${row.id + '-file'}, 'a.txt', 'text/plain', ${row.storagePath}, 'user-1', ${row.createdAt}, NULL)
    `.execute(testDb)
  }

  async function attachmentRowState(id: string): Promise<{ deletedAt: Date | null; blobPurgedAt: Date | null }> {
    const r = await sql<{ deleted_at: Date | null; blob_purged_at: Date | null }>`
      SELECT deleted_at, blob_purged_at FROM multitable_attachments WHERE id = ${id}
    `.execute(testDb)
    return { deletedAt: r.rows[0]?.deleted_at ?? null, blobPurgedAt: r.rows[0]?.blob_purged_at ?? null }
  }

  it('#1 compensating sweep — a root-escaping storage_path (../victim.txt) is NOT deleted and the row is NOT stamped (default storage, no injection)', async () => {
    const victim = path.join(tmpRoot, 'victim.txt')
    await fsp.writeFile(victim, 'do-not-delete-me')

    await insertBlobPurgeRow({ id: 'esc-sweep-1', storagePath: '../victim.txt', deletedAt: hoursAgo(48) })

    const result = await sweepMultitableAttachmentBlobPurge({ queryFn, graceHours: 24 })

    expect(result).toEqual({ inspected: 1, purged: 0, skipped: 1 })
    expect(await pathExists(victim)).toBe(true)
    expect((await attachmentRowState('esc-sweep-1')).blobPurgedAt).toBeNull()
  })

  it('#2 draft-orphan cleanup — a root-escaping storage_path (../victim2.txt) is NOT deleted and the row is NOT tombstoned (default storage, no injection, default-ON production path)', async () => {
    const victim2 = path.join(tmpRoot, 'victim2.txt')
    await fsp.writeFile(victim2, 'do-not-delete-me-either')

    await insertDraftRow({ id: 'esc-draft-1', storagePath: '../victim2.txt', createdAt: hoursAgo(48) })

    const result = await cleanupOrphanMultitableAttachments({ queryFn, retentionHours: 24 })

    expect(result).toEqual({ inspected: 1, deleted: 0, skipped: 1 })
    expect(await pathExists(victim2)).toBe(true)
    const state = await attachmentRowState('esc-draft-1')
    expect(state.deletedAt).toBeNull()
    expect(state.blobPurgedAt).toBeNull()
  })

  it('#3 positive path (compensating sweep) — a contained storage_path is still deleted and stamped by the default deleter (no regression)', async () => {
    const key = 'sub/ok.txt'
    const full = path.join(attachmentsDir, key)
    await fsp.mkdir(path.dirname(full), { recursive: true })
    await fsp.writeFile(full, 'ok-bytes')

    await insertBlobPurgeRow({ id: 'ok-sweep-1', storagePath: key, deletedAt: hoursAgo(48) })

    const result = await sweepMultitableAttachmentBlobPurge({ queryFn, graceHours: 24 })

    expect(result).toEqual({ inspected: 1, purged: 1, skipped: 0 })
    expect(await pathExists(full)).toBe(false)
    expect((await attachmentRowState('ok-sweep-1')).blobPurgedAt).not.toBeNull()
  })

  it('#4 positive path (draft-orphan cleanup) — a contained storage_path is still deleted and the row is tombstoned by the default deleter (no regression)', async () => {
    const key = 'sub/ok2.txt'
    const full = path.join(attachmentsDir, key)
    await fsp.mkdir(path.dirname(full), { recursive: true })
    await fsp.writeFile(full, 'ok-bytes-2')

    await insertDraftRow({ id: 'ok-draft-1', storagePath: key, createdAt: hoursAgo(48) })

    const result = await cleanupOrphanMultitableAttachments({ queryFn, retentionHours: 24 })

    expect(result).toEqual({ inspected: 1, deleted: 1, skipped: 0 })
    expect(await pathExists(full)).toBe(false)
    const state = await attachmentRowState('ok-draft-1')
    expect(state.deletedAt).not.toBeNull()
    expect(state.blobPurgedAt).not.toBeNull()
  })
})
