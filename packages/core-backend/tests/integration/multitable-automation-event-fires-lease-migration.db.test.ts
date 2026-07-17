/**
 * S6 — `meta_automation_event_fires` tombstone→lease UPGRADE migration (real DB, ISOLATED SCHEMA).
 *
 * Verifies the design-lock item 5 ("迁移回填 — 关键") via the REAL UPGRADE PATH, NOT fresh-DB:
 *   1. create the OLD-schema table ((rule_id, dedup_key, fired_at), no state columns) in an isolated schema;
 *   2. write historical rows (existing, un-backfilled deploy data);
 *   3. run the REAL migration's up() (the ALTER);
 *   4. assert every historical row is backfilled to status='done' (else it would be re-fired on next scan) —
 *      lease NULL, attempts 0 — and a reclaim scan (in_progress + expired lease) returns NONE for them.
 * A fresh-DB full migrate would create the historical rows already-backfilled and never exercise the ALTER's
 * backfill statement, so this test deliberately reconstructs the pre-migration schema by hand.
 *
 * Also asserts the lease biconditional CHECK (a done/pending row can't carry a lease; an in_progress row must).
 * Isolated schema + search_path (house rule for shared-DB integration) — no shared-table pollution.
 */
import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { up as migrateUp } from '../../src/db/migrations/zzzz20260716140000_event_fires_lease'

const dbUrl = process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

describeDb('S6 event_fires tombstone→lease upgrade migration (real DB, isolated schema)', () => {
  let adminPool: Pool
  let schema: string
  let testPool: Pool
  let testDb: Kysely<unknown>

  beforeEach(async () => {
    adminPool = new Pool({ connectionString: dbUrl })
    schema = `s6ef_${randomUUID().replace(/-/g, '')}`
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    testPool = new Pool({ connectionString: dbUrl, options: `-c search_path=${schema}` })
    testDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: testPool }) })
    // OLD schema exactly as zzzz20260701120000_create_automation_event_fires (minus the automation_rules FK,
    // which is irrelevant to the ALTER backfill and would drag the whole rules table into the isolated schema).
    await sql`
      CREATE TABLE meta_automation_event_fires (
        rule_id text NOT NULL,
        dedup_key text NOT NULL,
        fired_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (rule_id, dedup_key)
      )
    `.execute(testDb)
  })

  afterEach(async () => {
    await testDb.destroy()
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await adminPool.end()
  })

  const insertOld = (ruleId: string, dedupKey: string) =>
    sql`INSERT INTO meta_automation_event_fires (rule_id, dedup_key) VALUES (${ruleId}, ${dedupKey})`.execute(testDb)

  const rowsOf = async (ruleId: string) =>
    (
      await sql<{ dedup_key: string; status: string; lease: string | null; attempts: number; fence: string }>`
        SELECT dedup_key, status, lease_expires_at::text AS lease, attempts, fence
        FROM meta_automation_event_fires WHERE rule_id = ${ruleId} ORDER BY dedup_key
      `.execute(testDb)
    ).rows

  it('UPGRADE PATH: pre-existing tombstone rows are backfilled to done (not re-fired); new columns + CHECKs land', async () => {
    // existing, un-backfilled deploy data (historical, already-completed deliveries)
    await insertOld('rule_A', 'record.created:evt_1')
    await insertOld('rule_A', 'record.updated:evt_2')
    await insertOld('rule_B', 'approval.completed:evt_3')

    // run the REAL migration up() — the ALTER + backfill
    await expect(migrateUp(testDb)).resolves.toBeUndefined()

    // every historical row is backfilled to done, lease-free, attempts 0, fence 0 — so it is NOT re-fired
    for (const ruleId of ['rule_A', 'rule_B']) {
      for (const r of await rowsOf(ruleId)) {
        expect(r.status).toBe('done')
        expect(r.lease).toBeNull()
        expect(r.attempts).toBe(0)
        expect(r.fence).toBe('0')
      }
    }
    // a reclaim scan (in_progress + expired lease) sees NONE of them — no historical re-fire
    const reclaimable = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM meta_automation_event_fires
      WHERE status = 'in_progress' AND lease_expires_at < now()
    `.execute(testDb)
    expect(reclaimable.rows[0].n).toBe(0)
  })

  it('FENCE is a monotonic single-writer token: claim increments, a stale-fence CAS writes 0 rows, bigint round-trips as string past 2^53', async () => {
    await insertOld('rule_F', 'record.created:evt_f')
    await migrateUp(testDb)
    // claim: fence 0 → 1 via fence-CAS (WHERE fence = current). RAW `RETURNING fence` (no ::text) — the driver
    // must hand back the bigint as it will at runtime.
    const claim = await sql<{ fence: string }>`
      UPDATE meta_automation_event_fires SET fence = fence + 1, status='in_progress', lease_expires_at = now() + interval '30 s'
      WHERE rule_id='rule_F' AND fence = 0 RETURNING fence
    `.execute(testDb)
    expect(claim.rows[0].fence).toBe('1')
    // reclaim: fence 1 → 2
    const reclaim = await sql<{ fence: string }>`
      UPDATE meta_automation_event_fires SET fence = fence + 1 WHERE rule_id='rule_F' AND fence = 1 RETURNING fence
    `.execute(testDb)
    expect(reclaim.rows[0].fence).toBe('2')
    // a ZOMBIE holding the stale fence 1 tries to write a terminal — fence-CAS hits 0 rows (single-writer)
    const zombie = await sql`
      UPDATE meta_automation_event_fires SET status='done', lease_expires_at = NULL WHERE rule_id='rule_F' AND fence = 1
    `.execute(testDb)
    expect(Number(zombie.numAffectedRows ?? 0)).toBe(0)
    // bigint DRIVER BOUNDARY: a fence past 2^53 must survive a RAW `SELECT fence` (NO ::text cast — the cast
    // would make Postgres itself return text and prove nothing). node-postgres returns int8 as a STRING to
    // preserve precision; a JS number would corrupt 2^53+1. Assert BOTH the type and the exact value.
    const big = '9007199254740993' // 2^53 + 1
    await sql`UPDATE meta_automation_event_fires SET fence = ${big}::bigint WHERE rule_id='rule_F' AND fence = 2`.execute(testDb)
    const back = await sql<{ fence: string }>`SELECT fence FROM meta_automation_event_fires WHERE rule_id='rule_F'`.execute(testDb)
    expect(typeof back.rows[0].fence).toBe('string')
    expect(back.rows[0].fence).toBe(big)
    // fence CHECK: negative rejected by the named constraint
    await expect(
      sql`UPDATE meta_automation_event_fires SET fence = -1 WHERE rule_id='rule_F'`.execute(testDb),
    ).rejects.toThrow(/automation_event_fires_fence_nonneg/)
  })

  it('the FOUR ratified terminals done|outcome_unknown|failed|dead_letter are accepted and are lease-NULL', async () => {
    await migrateUp(testDb)
    for (const term of ['done', 'outcome_unknown', 'failed', 'dead_letter']) {
      // a terminal row inserts cleanly (closed-set accepts it) and carries NO lease (biconditional)
      await expect(
        sql`INSERT INTO meta_automation_event_fires (rule_id, dedup_key, status) VALUES ('rule_T', ${term}, ${term})`.execute(testDb),
      ).resolves.toBeTruthy()
      // attaching a lease to a terminal is rejected — a settled row can never carry ownership
      await expect(
        sql`UPDATE meta_automation_event_fires SET lease_expires_at = now() + interval '30 s' WHERE rule_id='rule_T' AND dedup_key=${term}`.execute(testDb),
      ).rejects.toThrow(/automation_event_fires_lease_iff_in_progress/)
    }
  })

  it('attempts CHECK: a negative attempts is rejected by the named constraint', async () => {
    await migrateUp(testDb)
    await expect(
      sql`INSERT INTO meta_automation_event_fires (rule_id, dedup_key, attempts) VALUES ('rule_N','k', -1)`.execute(testDb),
    ).rejects.toThrow(/automation_event_fires_attempts_nonneg/)
  })

  it('lease biconditional CHECK: a done/pending row rejects a lease; an in_progress row requires one', async () => {
    await insertOld('rule_C', 'record.created:evt_c')
    await migrateUp(testDb)
    // done row + a lease → rejected (settled row can never carry ownership)
    await expect(
      sql`UPDATE meta_automation_event_fires SET lease_expires_at = now() + interval '30 s' WHERE rule_id='rule_C'`.execute(testDb),
    ).rejects.toThrow(/automation_event_fires_lease_iff_in_progress/)
    // in_progress WITHOUT a lease → rejected (unreclaimable)
    await expect(
      sql`UPDATE meta_automation_event_fires SET status='in_progress' WHERE rule_id='rule_C'`.execute(testDb),
    ).rejects.toThrow(/automation_event_fires_lease_iff_in_progress/)
    // in_progress WITH a lease → accepted (a live, reclaimable claim)
    await expect(
      sql`UPDATE meta_automation_event_fires SET status='in_progress', lease_expires_at = now() + interval '30 s' WHERE rule_id='rule_C'`.execute(testDb),
    ).resolves.toBeTruthy()
    // bad status value → rejected by the closed-set CHECK
    await expect(
      sql`INSERT INTO meta_automation_event_fires (rule_id, dedup_key, status) VALUES ('rule_C','k','bogus')`.execute(testDb),
    ).rejects.toThrow(/automation_event_fires_status_valid/)
  })

  it('a NEW claim inserted after the upgrade defaults to done unless it opts into the lease lifecycle', async () => {
    await migrateUp(testDb)
    // the bare INSERT shape the OLD claimEventDelivery used still works (DEFAULT 'done') — cutover-safe
    await sql`INSERT INTO meta_automation_event_fires (rule_id, dedup_key) VALUES ('rule_D','k1')`.execute(testDb)
    const [row] = await rowsOf('rule_D')
    expect(row).toMatchObject({ status: 'done', lease: null, attempts: 0 })
  })
})
