/**
 * P2 durable-delivery P1 #1 — `multitable_automation_approval_bridges` terminal-early → LEASE upgrade
 * migration (real DB, ISOLATED SCHEMA), via the REAL UPGRADE PATH (not fresh-DB).
 *
 * The load-bearing difference from the S6 event_fires migration: event_fires rows were historical COMPLETED
 * deliveries (backfilled to `done`); a bridge `pending` row is a LIVE in-flight approval still awaiting its
 * completion event. So this migration must NOT touch existing status values — it only ADDS lease columns and
 * WIDENS the CHECKs. The first test proves exactly that: a pre-existing `pending`/`resumed` row keeps its
 * status after the ALTER (a backfill would corrupt live state), and gets lease=NULL / fence=0 / attempts=0.
 *
 * Isolated schema + search_path (house rule for shared-DB integration) — no shared-table pollution.
 */
import { randomUUID } from 'node:crypto'

import { Pool } from 'pg'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { up as migrateUp } from '../../src/db/migrations/zzzz20260717120000_approval_bridge_lease'

const dbUrl = process.env.DATABASE_URL
const describeDb = dbUrl ? describe : describe.skip

describeDb('P1#1 approval-bridge terminal→lease upgrade migration (real DB, isolated schema)', () => {
  let adminPool: Pool
  let schema: string
  let testPool: Pool
  let testDb: Kysely<unknown>

  beforeEach(async () => {
    adminPool = new Pool({ connectionString: dbUrl })
    schema = `p1b_${randomUUID().replace(/-/g, '')}`
    await adminPool.query(`CREATE SCHEMA "${schema}"`)
    testPool = new Pool({ connectionString: dbUrl, options: `-c search_path=${schema}` })
    testDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: testPool }) })
    // OLD schema exactly as zzzz20260610150000_create_automation_approval_bridges (the columns + the two CHECKs
    // this migration touches). No FK/index noise — irrelevant to the ALTER under test.
    await sql`
      CREATE TABLE multitable_automation_approval_bridges (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL,
        root_execution_id TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        sheet_id TEXT,
        record_id TEXT,
        step_index INTEGER NOT NULL,
        approval_instance_id TEXT,
        approval_request_no TEXT,
        approval_template_id TEXT NOT NULL,
        approval_published_definition_id TEXT,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CONSTRAINT chk_mt_auto_approval_bridge_status CHECK (status IN ('creating', 'pending', 'resumed', 'failed')),
        outcome TEXT,
        action_fingerprint JSONB NOT NULL,
        trigger_event JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        resumed_at TIMESTAMPTZ,
        CONSTRAINT chk_mt_auto_approval_bridge_claimable_has_approval
          CHECK (status NOT IN ('pending', 'resumed') OR approval_instance_id IS NOT NULL)
      )
    `.execute(testDb)
  })

  afterEach(async () => {
    await testDb.destroy()
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    await adminPool.end()
  })

  const insertOld = (id: string, status: string, approvalInstanceId: string | null) =>
    sql`
      INSERT INTO multitable_automation_approval_bridges
        (id, execution_id, root_execution_id, rule_id, step_index, approval_instance_id, approval_template_id,
         idempotency_key, status, action_fingerprint)
      VALUES (${id}, 'exec_1', 'exec_1', 'rule_1', 0, ${approvalInstanceId}, 'tpl_1', ${'idem_' + id}, ${status}, '{"count":0,"hash":""}'::jsonb)
    `.execute(testDb)

  const rowOf = async (id: string) =>
    (
      await sql<{ status: string; lease: string | null; attempts: number; fence: string }>`
        SELECT status, lease_expires_at::text AS lease, attempts, fence
        FROM multitable_automation_approval_bridges WHERE id = ${id}
      `.execute(testDb)
    ).rows[0]

  it('UPGRADE PATH: pre-existing rows KEEP their status (a pending row stays pending — NOT backfilled) + new columns land NULL/0', async () => {
    // live in-flight + terminal + creation-time deploy data
    await insertOld('b_pending', 'pending', 'appr_1')
    await insertOld('b_resumed', 'resumed', 'appr_2')
    await insertOld('b_creating', 'creating', null)
    await insertOld('b_failed', 'failed', null)

    await expect(migrateUp(testDb)).resolves.toBeUndefined()

    // status UNCHANGED for every row (the S6 done-backfill trick does NOT apply — pending is live work)
    expect((await rowOf('b_pending')).status).toBe('pending')
    expect((await rowOf('b_resumed')).status).toBe('resumed')
    expect((await rowOf('b_creating')).status).toBe('creating')
    expect((await rowOf('b_failed')).status).toBe('failed')
    // new lease columns default to lease-free / fence 0 / attempts 0 for every existing row
    for (const id of ['b_pending', 'b_resumed', 'b_creating', 'b_failed']) {
      const r = await rowOf(id)
      expect(r.lease).toBeNull()
      expect(r.attempts).toBe(0)
      expect(r.fence).toBe('0')
    }
  })

  it('new lease states land: in_progress requires a lease (biconditional), terminals reject one, bogus rejected', async () => {
    await insertOld('b_x', 'pending', 'appr_x')
    await migrateUp(testDb)
    // pending → in_progress WITHOUT a lease is rejected (unreclaimable)
    await expect(
      sql`UPDATE multitable_automation_approval_bridges SET status='in_progress' WHERE id='b_x'`.execute(testDb),
    ).rejects.toThrow(/chk_mt_auto_approval_bridge_lease_iff_in_progress/)
    // pending → in_progress WITH a lease is accepted (a live, reclaimable claim)
    await expect(
      sql`UPDATE multitable_automation_approval_bridges SET status='in_progress', lease_expires_at = now() + interval '60 s' WHERE id='b_x'`.execute(testDb),
    ).resolves.toBeTruthy()
    // an in_progress row can't drop its lease without leaving in_progress
    await expect(
      sql`UPDATE multitable_automation_approval_bridges SET lease_expires_at = NULL WHERE id='b_x'`.execute(testDb),
    ).rejects.toThrow(/chk_mt_auto_approval_bridge_lease_iff_in_progress/)
    // terminal dead_letter is accepted (with an instance) and is lease-NULL
    await sql`UPDATE multitable_automation_approval_bridges SET status='dead_letter', lease_expires_at = NULL WHERE id='b_x'`.execute(testDb)
    expect((await rowOf('b_x')).status).toBe('dead_letter')
    // a bogus status → closed-set CHECK
    await expect(
      insertOld('b_bogus', 'zombie_state', 'appr_z'),
    ).rejects.toThrow(/chk_mt_auto_approval_bridge_status/)
  })

  it('claimable-has-approval widened: in_progress/dead_letter require an approval_instance_id', async () => {
    await migrateUp(testDb)
    // an in_progress row with NO instance is rejected by the widened claimable CHECK
    await expect(
      sql`
        INSERT INTO multitable_automation_approval_bridges
          (id, execution_id, root_execution_id, rule_id, step_index, approval_instance_id, approval_template_id,
           idempotency_key, status, lease_expires_at, action_fingerprint)
        VALUES ('b_noappr','e','e','r',0, NULL, 't','idem_noappr','in_progress', now() + interval '60 s', '{}'::jsonb)
      `.execute(testDb),
    ).rejects.toThrow(/chk_mt_auto_approval_bridge_claimable_has_approval/)
  })

  it('fence is a monotonic single-writer token: claim/reclaim increment, stale-fence CAS writes 0 rows, bigint round-trips as string past 2^53; attempts/fence CHECKs named', async () => {
    await insertOld('b_f', 'pending', 'appr_f')
    await migrateUp(testDb)
    // claim: fence 0 → 1 via fence-CAS
    const claim = await sql<{ fence: string }>`
      UPDATE multitable_automation_approval_bridges SET fence = fence + 1, status='in_progress', lease_expires_at = now() + interval '60 s'
      WHERE id='b_f' AND fence = 0 RETURNING fence
    `.execute(testDb)
    expect(claim.rows[0].fence).toBe('1')
    // reclaim: fence 1 → 2
    const reclaim = await sql<{ fence: string }>`
      UPDATE multitable_automation_approval_bridges SET fence = fence + 1 WHERE id='b_f' AND fence = 1 RETURNING fence
    `.execute(testDb)
    expect(reclaim.rows[0].fence).toBe('2')
    // zombie holding stale fence 1 tries to write terminal → 0 rows (single-writer)
    const zombie = await sql`
      UPDATE multitable_automation_approval_bridges SET status='resumed', lease_expires_at = NULL WHERE id='b_f' AND fence = 1 AND status='in_progress'
    `.execute(testDb)
    expect(Number(zombie.numAffectedRows ?? 0)).toBe(0)
    // bigint driver boundary: 2^53+1 survives a RAW SELECT (no ::text) as an exact STRING
    const big = '9007199254740993'
    await sql`UPDATE multitable_automation_approval_bridges SET fence = ${big}::bigint WHERE id='b_f' AND fence = 2`.execute(testDb)
    const back = await sql<{ fence: string }>`SELECT fence FROM multitable_automation_approval_bridges WHERE id='b_f'`.execute(testDb)
    expect(typeof back.rows[0].fence).toBe('string')
    expect(back.rows[0].fence).toBe(big)
    // named CHECKs reject negatives
    await expect(
      sql`UPDATE multitable_automation_approval_bridges SET fence = -1 WHERE id='b_f'`.execute(testDb),
    ).rejects.toThrow(/chk_mt_auto_approval_bridge_fence_nonneg/)
    await expect(
      sql`UPDATE multitable_automation_approval_bridges SET attempts = -1 WHERE id='b_f'`.execute(testDb),
    ).rejects.toThrow(/chk_mt_auto_approval_bridge_attempts_nonneg/)
  })
})
