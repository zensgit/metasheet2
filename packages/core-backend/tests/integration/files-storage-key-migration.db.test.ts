import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import { randomUUID } from 'crypto'
import {
  up as migrateUp,
  QUARANTINE_PREFIX,
} from '../../src/db/migrations/zzzz20260710140000_add_files_storage_key'

// F3 files-storage-integrity design-lock (2026-07-10), owner guards D/G: real-DB coverage for the
// storage_key backfill migration's TWO failure classes.
//   - poison (ratified default): a recognized data anomaly (collision / traversal / unparseable url) →
//     the whole colliding/unsafe set is quarantined to a DISTINCT `!f3-collision:<id>` key, url preserved,
//     and the migration SUCCEEDS with an intact schema (column + partial-UNIQUE index).
//   - abort (owner guard G core): an UNRECOGNIZED failure mid-migration → the whole transaction rolls
//     back, leaving NO column, NO index, NO backfilled rows (schema + data both untouched).
//
// Each test runs against its OWN throwaway Postgres schema (search_path-scoped Kysely) so it never
// touches the shared `public.files` the parallel describeIfDatabase suites in this gate depend on — the
// house rule for shared-DB integration. The migration's own helpers resolve `files` via current_schema(),
// so a search_path-scoped connection lands entirely inside the test schema.

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

const BASE_URL_PREFIX = (process.env.STORAGE_BASE_URL || 'http://localhost:8900/files').replace(/\/+$/, '')

describeDb('F3 add_files_storage_key migration (real DB, isolated schema)', () => {
  let adminPool: Pool
  let schema: string
  let testPool: Pool
  let testDb: Kysely<unknown>

  beforeEach(async () => {
    adminPool = new Pool({ connectionString: dbUrl })
    schema = `f3mig_${randomUUID().replace(/-/g, '')}`
    await adminPool.query(`CREATE SCHEMA "${schema}"`)

    testPool = new Pool({ connectionString: dbUrl, options: `-c search_path=${schema}` })
    testDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: testPool }) })

    // Mirror the real `files` table BEFORE storage_key (id/url/owner_id/meta/created_at + F2 deleted_at).
    await sql`
      CREATE TABLE files (
        id TEXT PRIMARY KEY,
        url TEXT NULL,
        owner_id TEXT NULL,
        meta JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        deleted_at TIMESTAMPTZ NULL
      )
    `.execute(testDb)
  })

  afterEach(async () => {
    // Kysely's destroy() ends the underlying testPool — do NOT end it again.
    await testDb.destroy()
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await adminPool.end()
  })

  async function insertRow(id: string, urlKey: string | null, deletedAt: Date | null = null): Promise<void> {
    const url = urlKey === null ? null : `${BASE_URL_PREFIX}/${urlKey}`
    await sql`
      INSERT INTO files (id, url, owner_id, meta, created_at, deleted_at)
      VALUES (${id}, ${url}, ${'owner-' + id}, '{}'::jsonb, now(), ${deletedAt})
    `.execute(testDb)
  }

  async function storageKeyOf(id: string): Promise<string | null> {
    const r = await sql<{ storage_key: string | null }>`SELECT storage_key FROM files WHERE id = ${id}`.execute(testDb)
    return r.rows[0]?.storage_key ?? null
  }

  async function urlOf(id: string): Promise<string | null> {
    const r = await sql<{ url: string | null }>`SELECT url FROM files WHERE id = ${id}`.execute(testDb)
    return r.rows[0]?.url ?? null
  }

  async function columnExists(): Promise<boolean> {
    const r = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = ${schema} AND table_name = 'files' AND column_name = 'storage_key'
    `.execute(testDb)
    return (r.rows[0]?.n ?? 0) > 0
  }

  async function uniqueIndexExists(): Promise<boolean> {
    const r = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM pg_indexes
      WHERE schemaname = ${schema} AND tablename = 'files' AND indexname = 'idx_files_storage_key_active'
    `.execute(testDb)
    return (r.rows[0]?.n ?? 0) > 0
  }

  it('POISON path — collision group is fully quarantined (distinct, no winner), url preserved, safe rows backfilled, schema intact', async () => {
    // two rows collide on the same derived key (same-name overwrite legacy bug)
    await insertRow('coll-a', 'photo.jpg')
    await insertRow('coll-b', 'photo.jpg')
    // an unrelated safe row + a traversal-url row + a tombstoned collision partner (exempt: not servable)
    await insertRow('safe-1', 'unique/report.pdf')
    await insertRow('trav-1', '../escape.txt')
    await insertRow('del-1', 'photo.jpg', new Date())

    await expect(migrateUp(testDb)).resolves.toBeUndefined()

    // schema intact (migration SUCCEEDED): column + partial-UNIQUE index both present
    expect(await columnExists()).toBe(true)
    expect(await uniqueIndexExists()).toBe(true)

    // rule 1 — BOTH colliding rows poisoned, each DISTINCT, no keep-one-winner
    const ka = await storageKeyOf('coll-a')
    const kb = await storageKeyOf('coll-b')
    expect(ka).toBe(`${QUARANTINE_PREFIX}coll-a`)
    expect(kb).toBe(`${QUARANTINE_PREFIX}coll-b`)
    expect(ka).not.toBe(kb)

    // traversal row poisoned too
    expect(await storageKeyOf('trav-1')).toBe(`${QUARANTINE_PREFIX}trav-1`)

    // rule 3 — url column left INTACT on poisoned rows (audit + manual repair)
    expect(await urlOf('coll-a')).toBe(`${BASE_URL_PREFIX}/photo.jpg`)
    expect(await urlOf('trav-1')).toBe(`${BASE_URL_PREFIX}/../escape.txt`)

    // safe row backfilled to its real derived key
    expect(await storageKeyOf('safe-1')).toBe('unique/report.pdf')

    // the tombstoned partner is not servable → not part of the active collision set → left NULL
    expect(await storageKeyOf('del-1')).toBeNull()
  })

  it('POISON path — a clean DB (no anomalies) backfills every active row and builds the index', async () => {
    await insertRow('a', 'a.jpg')
    await insertRow('b', 'sub/b.png')

    await expect(migrateUp(testDb)).resolves.toBeUndefined()
    expect(await columnExists()).toBe(true)
    expect(await uniqueIndexExists()).toBe(true)
    expect(await storageKeyOf('a')).toBe('a.jpg')
    expect(await storageKeyOf('b')).toBe('sub/b.png')
  })

  it('ABORT path (owner guard G core) — an UNRECOGNIZED mid-migration failure rolls the WHOLE migration back: no column, no index, no backfill', async () => {
    await insertRow('a', 'a.jpg')

    // Inject an unrecognized DB error: a BEFORE UPDATE trigger that raises. The migration's backfill
    // UPDATE fires it, so the failure is NOT one of the recognized (poison-handled) data anomalies.
    await sql`
      CREATE FUNCTION f3_raise() RETURNS trigger AS $fn$
      BEGIN RAISE EXCEPTION 'injected unrecognized failure'; END;
      $fn$ LANGUAGE plpgsql
    `.execute(testDb)
    await sql`CREATE TRIGGER f3_raise_trg BEFORE UPDATE ON files FOR EACH ROW EXECUTE FUNCTION f3_raise()`.execute(testDb)

    await expect(migrateUp(testDb)).rejects.toThrow()

    // full rollback: the ADD COLUMN, the (attempted) backfill, and the index all rolled back together
    expect(await columnExists()).toBe(false)
    expect(await uniqueIndexExists()).toBe(false)
    // and the row is untouched (its only column set that could change is the one that no longer exists)
    const r = await sql<{ n: number }>`SELECT count(*)::int AS n FROM files WHERE id = 'a'`.execute(testDb)
    expect(r.rows[0]?.n).toBe(1)
  })
})
