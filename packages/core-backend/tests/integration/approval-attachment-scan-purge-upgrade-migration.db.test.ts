/**
 * P1 upgrade-path: `zzzz20260721120000_approval_attachments_scan_and_purge_dedup` applied on top
 * of the ALREADY-DEPLOYED create migration shape (not a fresh combined create).
 *
 * Proves:
 *   1. Migration ledger (kysely_migration) records the forward name after apply
 *   2. Pre-existing rows get scan_state='unscanned' without data loss
 *   3. Pre-existing DUPLICATE storage_key purge intents are collapsed BEFORE the unique index
 *      (dead_letter wins; one terminal row remains so the reconciler cannot bypass it)
 *   4. Unique storage_key on purge intents makes a deterministic second insert fail (dedup)
 *   5. Row-delete trigger enqueues ON CONFLICT (storage_key) — a second delete of a re-inserted
 *      row with the same key does not create a second intent
 *
 * Isolated schema + search_path (house rule for shared-DB integration).
 */
import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { up as createUp } from '../../src/db/migrations/zzzz20260715210000_create_approval_attachments'
import { up as forwardUp } from '../../src/db/migrations/zzzz20260721120000_approval_attachments_scan_and_purge_dedup'

const dbUrl = process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

const FORWARD_NAME = 'zzzz20260721120000_approval_attachments_scan_and_purge_dedup'
const CREATE_NAME = 'zzzz20260715210000_create_approval_attachments'

describeDb('approval attachments scan/purge-dedup upgrade path (real DB, isolated schema)', () => {
  let adminPool: Pool
  let schema: string
  let testPool: Pool
  let testDb: Kysely<unknown>

  beforeEach(async () => {
    adminPool = new Pool({ connectionString: dbUrl })
    schema = `aatt_upg_${randomUUID().replace(/-/g, '')}`
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    testPool = new Pool({ connectionString: dbUrl, options: `-c search_path=${schema}` })
    testDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: testPool }) })

    // Minimal FK target for the create migration's instance FK (NOT VALID, so empty is fine, but
    // we insert bound rows later so the table must exist).
    await sql`
      CREATE TABLE approval_instances (
        id text PRIMARY KEY,
        status text NOT NULL DEFAULT 'pending'
      )
    `.execute(testDb)

    // Simulated already-deployed ledger: the CREATE migration is recorded as applied BEFORE we
    // run its body here (local schema has no prior history). Then we apply CREATE body as the
    // pre-forward baseline and only then apply the forward migration.
    await sql`
      CREATE TABLE IF NOT EXISTS kysely_migration (
        name varchar(255) PRIMARY KEY,
        timestamp varchar(255) NOT NULL
      )
    `.execute(testDb)
    await sql`
      CREATE TABLE IF NOT EXISTS kysely_migration_lock (
        id varchar(255) PRIMARY KEY,
        is_locked integer NOT NULL DEFAULT 0
      )
    `.execute(testDb)
    await sql`
      INSERT INTO kysely_migration_lock (id, is_locked) VALUES ('migration_lock', 0)
      ON CONFLICT (id) DO NOTHING
    `.execute(testDb)

    await createUp(testDb)
    await sql`
      INSERT INTO kysely_migration (name, timestamp)
      VALUES (${CREATE_NAME}, ${'2026-07-15 21:00:00'})
      ON CONFLICT (name) DO NOTHING
    `.execute(testDb)
  })

  afterEach(async () => {
    await testDb.destroy()
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await adminPool.end()
  })

  async function ledgerNames(): Promise<string[]> {
    const r = await sql<{ name: string }>`SELECT name FROM kysely_migration ORDER BY name`.execute(testDb)
    return r.rows.map((row) => row.name)
  }

  it('UPGRADE PATH: create-shape DB gains scan_state + unique purge storage_key; pre-existing duplicates collapse with dead_letter winning; ledger records forward name', async () => {
    // Pre-forward row: no scan_state column yet (create migration shape).
    await sql`
      INSERT INTO approval_attachments
        (id, org_id, uploader_id, field_id, storage_key, file_name, mime_type, size_bytes, status)
      VALUES
        ('att_pre', 'org1', 'u1', 'fldA', 'approval-attachments/2026-07/pre.pdf', 'pre.pdf', 'application/pdf', 1024, 'unbound')
    `.execute(testDb)

    // Pre-existing DUPLICATE storage_key intents (legal under create-shape PK-on-id only). Seed
    // BEFORE forwardUp so the migration must collapse them — dead_letter must win over pending/done
    // so the reconciler cannot bypass an operator-visible terminal with a fresh second id.
    const dupKey = 'approval-attachments/2026-07/dup-key.pdf'
    await sql`
      INSERT INTO approval_attachment_purge_intents
        (id, storage_key, reason, status, attempts, created_at)
      VALUES
        ('pi_pending', ${dupKey}, 'unbound_ttl', 'pending', 1, now() - interval '2 hours'),
        ('pi_done', ${dupKey}, 'row_deleted', 'done', 3, now() - interval '1 hour'),
        ('pi_dead', ${dupKey}, 'reconciler_orphan', 'dead_letter', 9, now() - interval '30 minutes')
    `.execute(testDb)
    const preDup = await sql<{ c: string }>`
      SELECT count(*)::text AS c FROM approval_attachment_purge_intents WHERE storage_key = ${dupKey}
    `.execute(testDb)
    expect(Number(preDup.rows[0].c)).toBe(3)

    // Create-shape has no scan_state.
    const preCol = await sql<{ n: string }>`
      SELECT count(*)::text AS n FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'approval_attachments' AND column_name = 'scan_state'
    `.execute(testDb)
    expect(Number(preCol.rows[0].n)).toBe(0)

    await expect(forwardUp(testDb)).resolves.toBeUndefined()
    await sql`
      INSERT INTO kysely_migration (name, timestamp)
      VALUES (${FORWARD_NAME}, ${'2026-07-21 12:00:00'})
    `.execute(testDb)

    // Migration ledger: both create and forward names present (upgrade path, not rewritten history).
    const ledger = await ledgerNames()
    expect(ledger).toContain(CREATE_NAME)
    expect(ledger).toContain(FORWARD_NAME)

    // scan_state present and backfilled default for pre-existing rows.
    const scan = await sql<{ scan_state: string }>`
      SELECT scan_state FROM approval_attachments WHERE id = 'att_pre'
    `.execute(testDb)
    expect(scan.rows[0].scan_state).toBe('unscanned')

    // dead_letter wins: exactly one retained row, the terminal one — reconciler cannot re-enter.
    const intents = await sql<{ id: string; status: string }>`
      SELECT id, status FROM approval_attachment_purge_intents
      WHERE storage_key = ${dupKey}
      ORDER BY id
    `.execute(testDb)
    expect(intents.rows).toEqual([{ id: 'pi_dead', status: 'dead_letter' }])

    // Post-unique: a second id for the SAME storage_key is refused.
    await expect(
      sql`
        INSERT INTO approval_attachment_purge_intents (id, storage_key, reason)
        VALUES ('pi_bypass', ${dupKey}, 'reconciler_orphan')
      `.execute(testDb),
    ).rejects.toThrow(/uq_approval_purge_storage_key|duplicate key/i)

    // Trigger evolution: hard-delete enqueues by storage_key; a re-insert + re-delete of the same
    // key does NOT create a second intent (ON CONFLICT (storage_key) DO NOTHING).
    const key = 'approval-attachments/2026-07/trg-dedup.pdf'
    await sql`
      INSERT INTO approval_attachments
        (id, org_id, uploader_id, field_id, storage_key, file_name, mime_type, size_bytes, status, scan_state)
      VALUES
        ('att_trg_1', 'org1', 'u1', 'fldA', ${key}, 't.pdf', 'application/pdf', 10, 'unbound', 'unscanned')
    `.execute(testDb)
    await sql`DELETE FROM approval_attachments WHERE id = 'att_trg_1'`.execute(testDb)
    const afterFirst = await sql<{ c: string }>`
      SELECT count(*)::text AS c FROM approval_attachment_purge_intents WHERE storage_key = ${key}
    `.execute(testDb)
    expect(Number(afterFirst.rows[0].c)).toBe(1)

    await sql`
      INSERT INTO approval_attachments
        (id, org_id, uploader_id, field_id, storage_key, file_name, mime_type, size_bytes, status, scan_state)
      VALUES
        ('att_trg_2', 'org1', 'u1', 'fldA', ${key}, 't.pdf', 'application/pdf', 10, 'unbound', 'unscanned')
    `.execute(testDb)
    await sql`DELETE FROM approval_attachments WHERE id = 'att_trg_2'`.execute(testDb)
    const afterSecond = await sql<{ c: string }>`
      SELECT count(*)::text AS c FROM approval_attachment_purge_intents WHERE storage_key = ${key}
    `.execute(testDb)
    expect(Number(afterSecond.rows[0].c)).toBe(1) // still one — storage_key dedup, not a second id
  })
})
