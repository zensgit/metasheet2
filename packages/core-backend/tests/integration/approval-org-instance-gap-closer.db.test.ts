import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { up as recovery09GapUp } from '../../src/db/migrations/zzzz20260823149900_recovery09_close_approval_org_gap'
import { up as gapCloserUp } from '../../src/db/migrations/zzzz20260823150000_close_approval_instance_org_id_gap_window'

/**
 * Lock-11 §10.3 gap-closer (seventh by-reference ruling, item 1, AUTHORIZED 2026-08-22) — real-DB
 * acceptance for `zzzz20260823150000_close_approval_instance_org_id_gap_window.ts`.
 *
 * Harness shape copied from `approval-instance-org-backfill-b.db.test.ts` (itself copied from
 * `approval-attachment-scan-purge-upgrade-migration.db.test.ts`): an isolated
 * `CREATE SCHEMA "<rand>"` + a `Pool` with `options: '-c search_path=<schema>'` + a per-schema
 * `Kysely`, minimal hand-built tables, the migration under test imported and run DIRECTLY (this is
 * NOT a re-run of a recorded migration — kysely never does that; it is calling the function body
 * against a fresh isolated schema, which is what every sibling `.db.test.ts` in this repo does),
 * `DROP SCHEMA ... CASCADE` in `afterEach`.
 *
 * The hand-built `approval_instances` table already carries the `org_id` column (this suite does
 * not exercise the "Phase 1 hasn't run yet" guard — that guard is byte-identical to Migration B's
 * own, already covered there) and a `kysely_migration` table the fixtures seed directly to control
 * the window boundary, since real prod history (two separate deploys) cannot be reproduced inside
 * one test run.
 */

const dbUrl = process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

// Top-level anti-skip-green sentinel — copied VERBATIM from
// `approval-instance-org-backfill-b.db.test.ts:40-42`. Deliberately OUTSIDE describeIfDatabase.
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

const BACKFILL_MIGRATION_NAME = 'zzzz20260823100000_backfill_approval_instance_org_id'
const BOUNDARY = '2026-08-22T17:16:20.000Z' // Migration B's real recorded prod execution instant.
const BEFORE_BOUNDARY = '2026-08-22T17:16:19.000Z' // 1s before — pre-window (Migration B's own population).
const AFTER_BOUNDARY = '2026-08-22T17:16:21.000Z' // 1s after — in-window (this migration's population).

describeIfDatabase('Lock-11 §10.3 gap-closer — org_id backfill over the Migration-B->W1W2 creation window (real DB, isolated schema)', () => {
  let adminPool: Pool
  let schema: string
  let testPool: Pool
  let testDb: Kysely<unknown>

  beforeEach(async () => {
    adminPool = new Pool({ connectionString: dbUrl })
    schema = `gapc_${randomUUID().replace(/-/g, '')}`
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    testPool = new Pool({ connectionString: dbUrl, options: `-c search_path=${schema}` })
    testDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: testPool }) })

    await sql`
      CREATE TABLE approval_instances (
        id text PRIMARY KEY,
        status text NOT NULL DEFAULT 'pending',
        source_system text NOT NULL DEFAULT 'platform',
        requester_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
        org_id text,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `.execute(testDb)
    await sql`
      CREATE TABLE user_orgs (
        user_id text NOT NULL,
        org_id text NOT NULL,
        is_active boolean NOT NULL DEFAULT true,
        PRIMARY KEY (user_id, org_id)
      )
    `.execute(testDb)
    await sql`CREATE TABLE users (id text PRIMARY KEY, is_active boolean NOT NULL DEFAULT true)`.execute(testDb)
    await sql`
      CREATE TABLE approval_attachments (
        id text PRIMARY KEY,
        instance_id text REFERENCES approval_instances(id) ON DELETE CASCADE,
        org_id text NOT NULL
      )
    `.execute(testDb)
    await sql`
      CREATE TABLE directory_integrations (
        id text PRIMARY KEY,
        org_id text NOT NULL,
        status text NOT NULL DEFAULT 'active'
      )
    `.execute(testDb)
    await sql`
      CREATE TABLE kysely_migration (
        name varchar(255) PRIMARY KEY,
        timestamp varchar(255) NOT NULL
      )
    `.execute(testDb)
  })

  afterEach(async () => {
    await testDb.destroy()
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await adminPool.end()
  })

  // ---- fixture helpers ----------------------------------------------------------------------

  async function seedBackfillRecord(ts = BOUNDARY): Promise<void> {
    await sql`INSERT INTO kysely_migration (name, timestamp) VALUES (${BACKFILL_MIGRATION_NAME}, ${ts})`.execute(testDb)
  }

  async function seedInstance(opts: {
    id: string
    createdAt: string
    sourceSystem?: string
    requesterId?: string | null
    orgId?: string | null
  }): Promise<void> {
    const { id, createdAt, sourceSystem = 'platform', requesterId = null, orgId = null } = opts
    const requesterSnapshot = requesterId ? { id: requesterId } : {}
    await sql`
      INSERT INTO approval_instances (id, status, source_system, requester_snapshot, org_id, created_at)
      VALUES (${id}, 'pending', ${sourceSystem}, ${JSON.stringify(requesterSnapshot)}::jsonb, ${orgId}, ${createdAt}::timestamptz)
    `.execute(testDb)
  }

  async function seedUserOrg(userId: string, orgId: string, isActive = true): Promise<void> {
    await sql`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES (${userId}, ${orgId}, ${isActive})`.execute(testDb)
  }

  async function orgIdOf(id: string): Promise<string | null> {
    const r = await sql<{ org_id: string | null }>`SELECT org_id FROM approval_instances WHERE id = ${id}`.execute(testDb)
    return r.rows[0]?.org_id ?? null
  }

  it('R09-G1: multi-org window is closed source-first, then the older single-org closer sees zero work', async () => {
    await seedBackfillRecord()
    await sql`INSERT INTO directory_integrations (id, org_id) VALUES ('r09_di', 'default')`.execute(testDb)
    await sql`INSERT INTO users (id, is_active) VALUES ('r09_default', TRUE), ('r09_member', TRUE)`.execute(testDb)
    await seedUserOrg('r09_default', 'default')
    await seedUserOrg('r09_member', 'synth_a')
    await seedUserOrg('r09_synth_b', 'synth_b')
    await seedUserOrg('r09_synth_c', 'synth_c')

    await seedInstance({ id: 'r09_gap_member', createdAt: AFTER_BOUNDARY, requesterId: 'r09_member' })
    await seedInstance({ id: 'r09_gap_attachment', createdAt: AFTER_BOUNDARY, requesterId: 'missing_attachment_actor' })
    await seedInstance({ id: 'r09_gap_fallback', createdAt: AFTER_BOUNDARY, requesterId: 'missing_fallback_actor' })
    await sql`
      INSERT INTO approval_attachments (id, instance_id, org_id)
      VALUES ('r09_att', 'r09_gap_attachment', 'synth_b')
    `.execute(testDb)

    await expect(recovery09GapUp(testDb)).resolves.toBeUndefined()
    await expect(gapCloserUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf('r09_gap_member')).toBe('synth_a')
    expect(await orgIdOf('r09_gap_attachment')).toBe('synth_b')
    expect(await orgIdOf('r09_gap_fallback')).toBe('default')
  })

  it('R09-G2: unsupported deactivated-only requester aborts before any source-resolvable row is updated', async () => {
    await seedBackfillRecord()
    await sql`INSERT INTO directory_integrations (id, org_id) VALUES ('r09_di_g2', 'default')`.execute(testDb)
    await sql`INSERT INTO users (id, is_active) VALUES ('r09_default_g2', TRUE), ('r09_deactivated_g2', TRUE)`.execute(testDb)
    await seedUserOrg('r09_default_g2', 'default')
    await seedUserOrg('r09_deactivated_g2', 'default', false)
    await seedInstance({ id: 'r09_gap_unsupported', createdAt: AFTER_BOUNDARY, requesterId: 'r09_deactivated_g2' })
    await seedInstance({ id: 'r09_gap_missing', createdAt: AFTER_BOUNDARY, requesterId: 'missing_r09_g2' })

    await expect(recovery09GapUp(testDb)).rejects.toThrow(/outside the bounded legacy fallback/i)
    expect(await orgIdOf('r09_gap_unsupported')).toBeNull()
    expect(await orgIdOf('r09_gap_missing')).toBeNull()
  })

  // ---- G1: the core positive — window row, single active org -> stamped ---------------------

  it('G1: platform row created AFTER the backfill boundary, single active org -> stamped with that org', async () => {
    await seedBackfillRecord()
    await seedInstance({ id: 'g1', createdAt: AFTER_BOUNDARY })
    await seedUserOrg('u1', 'orgA', true)

    await expect(gapCloserUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf('g1')).toBe('orgA')
  })

  // ---- G2: the temporal guard is load-bearing — pre-window row stays untouched --------------

  it('G2: platform row created BEFORE the backfill boundary (Migration B\'s own population, e.g. class-1 residue) -> NOT touched, even with a single active org', async () => {
    await seedBackfillRecord()
    await seedInstance({ id: 'g2', createdAt: BEFORE_BOUNDARY })
    await seedUserOrg('u2', 'orgA', true)

    await expect(gapCloserUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf('g2')).toBeNull()
  })

  it('positive control for G2: the SAME row shape, moved to AFTER the boundary, DOES get stamped', async () => {
    await seedBackfillRecord()
    await seedInstance({ id: 'g2_pc', createdAt: AFTER_BOUNDARY })
    await seedUserOrg('u2pc', 'orgA', true)

    await expect(gapCloserUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf('g2_pc')).toBe('orgA')
  })

  // ---- G3: two-org fixture -> ABORT before any UPDATE, values-free --------------------------

  it('G3: window row present, but TWO distinct active orgs exist repo-wide -> ABORT before any UPDATE, no id leaked, row left NULL', async () => {
    await seedBackfillRecord()
    await seedInstance({ id: 'g3', createdAt: AFTER_BOUNDARY })
    await seedUserOrg('u3', 'orgA', true)
    await seedUserOrg('u3', 'orgB', true) // two DISTINCT active orgs repo-wide

    await expect(gapCloserUp(testDb)).rejects.toThrow(/2 distinct active/)
    let threw = false
    try {
      await gapCloserUp(testDb)
    } catch (e) {
      threw = true
      const msg = String((e as Error).message)
      expect(msg).not.toMatch(/g3/) // values-free: the instance id is never interpolated
      expect(msg).not.toMatch(/orgA|orgB/) // values-free: no org id either
    }
    expect(threw).toBe(true)
    expect(await orgIdOf('g3')).toBeNull() // no partial write
  })

  it('G3b: window row present, ZERO active orgs repo-wide -> ABORT (the other half of "does not hold")', async () => {
    await seedBackfillRecord()
    await seedInstance({ id: 'g3b', createdAt: AFTER_BOUNDARY })
    // no seedUserOrg at all

    await expect(gapCloserUp(testDb)).rejects.toThrow(/0 distinct active/)
    expect(await orgIdOf('g3b')).toBeNull()
  })

  // ---- G4: idempotent — a second run never re-touches an already-resolved row ---------------

  it('G4: idempotent — a second run (even with a DIFFERENT single active org) does not overwrite the first stamp', async () => {
    await seedBackfillRecord()
    await seedInstance({ id: 'g4', createdAt: AFTER_BOUNDARY })
    await seedUserOrg('u4', 'orgA', true)

    await expect(gapCloserUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf('g4')).toBe('orgA')

    // The active-org population changes AFTER the first stamp (orgA deactivated, orgB is now the
    // sole active org) — a re-run must be a no-op on the already-stamped row, not a re-stamp.
    await sql`UPDATE user_orgs SET is_active = FALSE WHERE org_id = 'orgA'`.execute(testDb)
    await seedUserOrg('u4b', 'orgB', true)

    await expect(gapCloserUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf('g4')).toBe('orgA') // unchanged — org_id IS NULL scoping held
  })

  // ---- G5 / G6: prefix guards — plm:/afs: rows are NEVER touched, even in-window ------------

  it('G5: plm:-prefixed row in-window is NEVER stamped (source_system left at "platform" so ONLY the prefix guard is under test)', async () => {
    await seedBackfillRecord()
    await seedInstance({ id: 'plm:g5', createdAt: AFTER_BOUNDARY, sourceSystem: 'platform' })
    await seedUserOrg('u5', 'orgA', true)

    await expect(gapCloserUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf('plm:g5')).toBeNull()
  })

  it('G6: afs:-prefixed row in-window is NEVER stamped (source_system left at "platform" so ONLY the prefix guard is under test)', async () => {
    await seedBackfillRecord()
    await seedInstance({ id: 'afs:g6', createdAt: AFTER_BOUNDARY, sourceSystem: 'platform' })
    await seedUserOrg('u6', 'orgA', true)

    await expect(gapCloserUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf('afs:g6')).toBeNull()
  })

  // ---- G7: source_system guard — a non-platform, non-prefixed row is left alone -------------

  it('G7: non-"platform" source_system, unprefixed id, in-window -> NOT touched', async () => {
    await seedBackfillRecord()
    await seedInstance({ id: 'g7', createdAt: AFTER_BOUNDARY, sourceSystem: 'erp' })
    await seedUserOrg('u7', 'orgA', true)

    await expect(gapCloserUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf('g7')).toBeNull()
  })

  // ---- G8: no boundary recorded -> safe no-op, never a false ABORT and never a blanket stamp ---

  it('G8: Migration B is not recorded in kysely_migration on this database -> safe no-op (not an abort, not a stamp)', async () => {
    // Deliberately no seedBackfillRecord() call.
    await seedInstance({ id: 'g8', createdAt: AFTER_BOUNDARY })
    await seedUserOrg('u8', 'orgA', true)

    await expect(gapCloserUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf('g8')).toBeNull()
  })

  // ---- G9: already-stamped rows outside the window population are never re-derived ----------

  it('G9: an already-stamped in-window row is left exactly as stamped, not re-derived from a different org — with a SEPARATE genuinely-NULL window row present so the census still reports n>0 and the STAMP statement actually runs (a fixture with ONLY the pre-stamped row would short-circuit at n=0 and never exercise the STAMP UPDATE\'s own org_id-IS-NULL scoping at all)', async () => {
    await seedBackfillRecord()
    await seedInstance({ id: 'g9', createdAt: AFTER_BOUNDARY, orgId: 'orgPreStamped' })
    await seedInstance({ id: 'g9_null', createdAt: AFTER_BOUNDARY }) // forces n>0 so the STAMP UPDATE runs
    await seedUserOrg('u9', 'orgA', true) // single active org differs from the pre-stamped value

    await expect(gapCloserUp(testDb)).resolves.toBeUndefined()
    expect(await orgIdOf('g9')).toBe('orgPreStamped') // untouched
    expect(await orgIdOf('g9_null')).toBe('orgA') // the genuinely-NULL sibling DOES get stamped
  })
})
