import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import {
  up as triggerUp,
  down as triggerDown,
  AUDIT_TABLE,
  DENY_TRIGGER,
} from '../../src/db/migrations/zzzz20260712120000_stock_prep_audit_immutable_trigger'

// Stock-prep T5 — real-DB proof that `integration_stock_prep_audit` (066) is immutable at the DB
// layer, not just by application-layer discipline. See the migration's header comment for WHY a
// trigger (not REVOKE) is the correct mechanism here: this repo's app connection and its migration
// runner share ONE role (see connection-pool.ts / db.ts), so that role always ends up owning the
// table it creates — and REVOKE against an owner is a documented no-op (verified separately against
// a throwaway container before writing this migration). A BEFORE UPDATE OR DELETE trigger has no such
// owner exemption, which is exactly what these tests exercise end-to-end against a real Postgres.
//
// Each test runs against its OWN throwaway schema (search_path-scoped Kysely), mirroring the
// F3 storage-key precedent (files-storage-key-migration.db.test.ts) — never touches the shared
// `public` schema the parallel describeIfDatabase suites depend on.

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

const MIGRATION_066_SQL = readFileSync(
  resolve(__dirname, '../../migrations/066_create_integration_stock_prep_audit.sql'),
  'utf8',
)

describeDb('stock-prep T5 — integration_stock_prep_audit DB-layer immutability trigger (real DB, isolated schema)', () => {
  let adminPool: Pool
  let schema: string
  let testPool: Pool
  let testDb: Kysely<unknown>

  beforeEach(async () => {
    adminPool = new Pool({ connectionString: dbUrl })
    schema = `t5audit_${randomUUID().replace(/-/g, '')}`
    await adminPool.query(`CREATE SCHEMA "${schema}"`)

    testPool = new Pool({ connectionString: dbUrl, options: `-c search_path=${schema}` })
    testDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: testPool }) })

    // Apply the REAL 066 migration SQL verbatim (idempotent CREATE TABLE IF NOT EXISTS) so the test
    // exercises the actual production table shape, not a hand-mirrored approximation.
    await sql.raw(MIGRATION_066_SQL).execute(testDb)
  })

  afterEach(async () => {
    await testDb.destroy()
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await adminPool.end()
  })

  async function insertRow(id: string, action = 'mapping_confirm'): Promise<void> {
    await sql`
      INSERT INTO integration_stock_prep_audit (id, tenant_id, action, detail)
      VALUES (${id}, ${'tenant-1'}, ${action}, '{}'::jsonb)
    `.execute(testDb)
  }

  async function rowCount(): Promise<number> {
    const r = await sql<{ n: number }>`SELECT count(*)::int AS n FROM integration_stock_prep_audit`.execute(testDb)
    return r.rows[0]?.n ?? 0
  }

  async function tenantOf(id: string): Promise<string | null> {
    const r = await sql<{ tenant_id: string | null }>`
      SELECT tenant_id FROM integration_stock_prep_audit WHERE id = ${id}
    `.execute(testDb)
    return r.rows[0]?.tenant_id ?? null
  }

  async function connectingRoleOwnsTable(): Promise<boolean> {
    const r = await sql<{ is_owner: boolean }>`
      SELECT (tableowner = current_user) AS is_owner
      FROM pg_tables
      WHERE schemaname = ${schema} AND tablename = ${AUDIT_TABLE}
    `.execute(testDb)
    return r.rows[0]?.is_owner ?? false
  }

  // pg_trigger is NOT schema-scoped by tgname alone (the same trigger name can legitimately exist on
  // relations of the same name in OTHER schemas — e.g. the real `public.integration_stock_prep_audit`
  // this same migration creates outside tests). Join through pg_class/pg_namespace so the count is
  // scoped to THIS test's isolated schema only.
  async function triggerCountInSchema(): Promise<number> {
    const r = await sql<{ n: number }>`
      SELECT count(*)::int AS n
      FROM pg_trigger t
      JOIN pg_class c ON t.tgrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE n.nspname = ${schema} AND t.tgname = ${DENY_TRIGGER}
    `.execute(testDb)
    return r.rows[0]?.n ?? 0
  }

  it('precondition: the test connection owns the table it just created (mirrors prod\'s single-role app+migration connection — this is WHY REVOKE would be a no-op here)', async () => {
    expect(await connectingRoleOwnsTable()).toBe(true)
  })

  it('append (INSERT) is completely unaffected before the trigger is installed', async () => {
    await insertRow('pre-1')
    expect(await rowCount()).toBe(1)
  })

  it('BEFORE the trigger is installed, UPDATE/DELETE succeed unguarded (proves the trigger — not some other artifact — is what blocks them)', async () => {
    await insertRow('unguarded-1')
    await sql`UPDATE integration_stock_prep_audit SET tenant_id = 'hacked' WHERE id = 'unguarded-1'`.execute(testDb)
    expect(await tenantOf('unguarded-1')).toBe('hacked')
    await sql`DELETE FROM integration_stock_prep_audit WHERE id = 'unguarded-1'`.execute(testDb)
    expect(await rowCount()).toBe(0)
  })

  it('AFTER the trigger is installed: INSERT still succeeds, UPDATE is rejected, DELETE is rejected, and the row is left untouched — even though the connection OWNS the table', async () => {
    expect(await connectingRoleOwnsTable()).toBe(true)
    await triggerUp(testDb)

    // append path (the store's ONLY write) is unaffected by the new trigger.
    await insertRow('r1')
    await insertRow('r2', 'mapping_candidates_sync')
    expect(await rowCount()).toBe(2)

    // UPDATE rejected
    await expect(
      sql`UPDATE integration_stock_prep_audit SET tenant_id = 'hacked' WHERE id = 'r1'`.execute(testDb),
    ).rejects.toThrow(/append-only/i)
    expect(await tenantOf('r1')).toBe('tenant-1') // untouched

    // DELETE rejected
    await expect(
      sql`DELETE FROM integration_stock_prep_audit WHERE id = 'r1'`.execute(testDb),
    ).rejects.toThrow(/append-only/i)
    expect(await rowCount()).toBe(2) // untouched

    // append still works AFTER the rejected mutations (trigger only guards UPDATE/DELETE)
    await insertRow('r3', 'exception_resolve')
    expect(await rowCount()).toBe(3)
  })

  it('is idempotent: running the trigger migration up() twice does not error and the guard still holds', async () => {
    await triggerUp(testDb)
    await triggerUp(testDb)

    expect(await triggerCountInSchema()).toBe(1) // no duplicate trigger from re-running up()

    await insertRow('idem-1')
    await expect(
      sql`UPDATE integration_stock_prep_audit SET tenant_id = 'x' WHERE id = 'idem-1'`.execute(testDb),
    ).rejects.toThrow(/append-only/i)
  })

  it('down() removes the trigger and function; UPDATE/DELETE succeed again afterward (confirms causality: the trigger — nothing else — was the guard)', async () => {
    await triggerUp(testDb)
    await insertRow('down-1')
    await expect(
      sql`UPDATE integration_stock_prep_audit SET tenant_id = 'x' WHERE id = 'down-1'`.execute(testDb),
    ).rejects.toThrow(/append-only/i)

    await triggerDown(testDb)

    expect(await triggerCountInSchema()).toBe(0)

    await sql`UPDATE integration_stock_prep_audit SET tenant_id = 'unguarded-again' WHERE id = 'down-1'`.execute(testDb)
    expect(await tenantOf('down-1')).toBe('unguarded-again')
    await sql`DELETE FROM integration_stock_prep_audit WHERE id = 'down-1'`.execute(testDb)
    expect(await rowCount()).toBe(0)
  })
})
