/**
 * P2 durable-delivery — slice S1 schema + flag golden (real DB).
 *
 * Verifies the additive migration `zzzz20260715120000_create_automation_outbox` landed the two new tables
 * with the shape the later slices depend on, that the `status` CHECK enforces the four-state machine, that
 * the FK cascade deletes per-consumer rows with their outbox event, and that the master flag is OFF by
 * default (so S1 changes byte-for-byte nothing at runtime). No behavior of the existing automation path is
 * exercised — these tables are unused until the dispatcher (S2) wires them behind the flag.
 *
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI's real-DB lane; two-point wired into
 * plugin-tests.yml + excluded from the no-DB default job in vitest.config.ts so it cannot skip-green).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { isDurableDeliveryEnabled, RESOLVE_PERMITTING_STATUSES } from '../../src/multitable/automation-durable-delivery'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

// Outbox rows carry no rule FK, so the schema goldens need only two synthetic outbox ids, cleaned up after.
const OB1 = `ob_s1_${Math.floor(Date.now() % 1e9)}_a`
const OB2 = `ob_s1_${Math.floor(Date.now() % 1e9)}_b`

describeIfDatabase('P2 durable-delivery S1 — automation outbox schema + flag (real DB)', () => {
  beforeAll(async () => {
    await q('DELETE FROM meta_automation_outbox WHERE id = ANY($1)', [[OB1, OB2]]).catch(() => {})
  })
  afterAll(async () => {
    await q('DELETE FROM meta_automation_outbox WHERE id = ANY($1)', [[OB1, OB2]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('both tables exist with the expected columns', async () => {
    const cols = async (table: string) =>
      (await q('SELECT column_name FROM information_schema.columns WHERE table_name = $1', [table])).rows.map(
        (r) => (r as { column_name: string }).column_name,
      )
    const outbox = await cols('meta_automation_outbox')
    for (const c of ['id', 'event_type', 'payload', 'automation_depth', 'manifest_version', 'event_id', 'created_at']) {
      expect(outbox).toContain(c)
    }
    const consumer = await cols('meta_automation_outbox_consumer')
    for (const c of ['outbox_id', 'consumer_key', 'status', 'lease_expires_at', 'fence', 'attempts', 'last_error', 'updated_at']) {
      expect(consumer).toContain(c)
    }
  })

  test('status CHECK enforces the four-state machine (rejects an unknown status; accepts each valid one)', async () => {
    await q(
      `INSERT INTO meta_automation_outbox (id, event_type, payload, manifest_version) VALUES ($1,$2,$3::jsonb,1)`,
      [OB1, 'approval.approved', JSON.stringify({ any: 'payload' })],
    )
    // positive control: every valid status inserts. There are exactly four — NO persistent `failed`
    // (a transient failure only bumps attempts and stays reclaimable; exhaustion → dead_letter). `in_progress`
    // must carry a lease (the in_progress-needs-lease CHECK), so give it one; the others take a NULL lease.
    for (const s of ['pending', 'in_progress', 'done', 'dead_letter'] as const) {
      const lease = s === 'in_progress' ? "now() + interval '5 minutes'" : 'NULL'
      await q(
        `INSERT INTO meta_automation_outbox_consumer (outbox_id, consumer_key, status, lease_expires_at)
         VALUES ($1,$2,$3,${lease})
         ON CONFLICT (outbox_id, consumer_key) DO UPDATE SET status = EXCLUDED.status, lease_expires_at = EXCLUDED.lease_expires_at`,
        [OB1, `ck_${s}`, s],
      )
    }
    // negative: a bogus status is rejected by the CHECK.
    await expect(
      q(
        `INSERT INTO meta_automation_outbox_consumer (outbox_id, consumer_key, status) VALUES ($1,'ck_bad','bogus')`,
        [OB1],
      ),
    ).rejects.toThrow()
  })

  test('in_progress REQUIRES a lease: NULL-lease in_progress is rejected, leased in_progress is accepted', async () => {
    await q(
      `INSERT INTO meta_automation_outbox (id, event_type, payload, manifest_version) VALUES ($1,'approval.approved','{}'::jsonb,1)
       ON CONFLICT (id) DO NOTHING`,
      [OB1],
    )
    // negative control: an in_progress row with NULL lease is unreclaimable — the CHECK must reject it.
    await expect(
      q(
        `INSERT INTO meta_automation_outbox_consumer (outbox_id, consumer_key, status, lease_expires_at)
         VALUES ($1,'ck_inprog_nolease','in_progress',NULL)`,
        [OB1],
      ),
    ).rejects.toThrow()
    // positive control: the SAME row with a lease is accepted (proves the CHECK gates on the lease, not the status).
    await expect(
      q(
        `INSERT INTO meta_automation_outbox_consumer (outbox_id, consumer_key, status, lease_expires_at)
         VALUES ($1,'ck_inprog_leased','in_progress',now() + interval '5 minutes')`,
        [OB1],
      ),
    ).resolves.toBeTruthy()
  })

  test('fence/attempts non-negative CHECKs reject a negative fence', async () => {
    await q(
      `INSERT INTO meta_automation_outbox (id, event_type, payload, manifest_version) VALUES ($1,'approval.approved','{}'::jsonb,1)
       ON CONFLICT (id) DO NOTHING`,
      [OB1],
    )
    await expect(
      q(
        `INSERT INTO meta_automation_outbox_consumer (outbox_id, consumer_key, status, fence) VALUES ($1,'ck_negfence','pending',-1)`,
        [OB1],
      ),
    ).rejects.toThrow()
  })

  test('FK cascade: deleting an outbox event removes its per-consumer lease rows', async () => {
    await q(
      `INSERT INTO meta_automation_outbox (id, event_type, payload, manifest_version) VALUES ($1,'approval.approved','{}'::jsonb,1)`,
      [OB2],
    )
    await q(
      `INSERT INTO meta_automation_outbox_consumer (outbox_id, consumer_key, status, lease_expires_at, fence, attempts)
       VALUES ($1,'approval-trigger','in_progress',now() + interval '5 minutes',3,2)`,
      [OB2],
    )
    const before = await q('SELECT count(*)::int AS c FROM meta_automation_outbox_consumer WHERE outbox_id = $1', [OB2])
    expect(Number(before.rows[0].c)).toBe(1)
    await q('DELETE FROM meta_automation_outbox WHERE id = $1', [OB2])
    const after = await q('SELECT count(*)::int AS c FROM meta_automation_outbox_consumer WHERE outbox_id = $1', [OB2])
    expect(Number(after.rows[0].c)).toBe(0) // cascaded
  })

  test('column defaults: a fresh consumer row is pending, fence 0, attempts 0', async () => {
    await q(
      `INSERT INTO meta_automation_outbox (id, event_type, payload, manifest_version) VALUES ($1,'approval.approved','{}'::jsonb,1)
       ON CONFLICT (id) DO NOTHING`,
      [OB1],
    )
    await q(
      `INSERT INTO meta_automation_outbox_consumer (outbox_id, consumer_key) VALUES ($1,'ck_defaults')
       ON CONFLICT (outbox_id, consumer_key) DO NOTHING`,
      [OB1],
    )
    const r = await q(
      `SELECT status, fence, attempts FROM meta_automation_outbox_consumer WHERE outbox_id=$1 AND consumer_key='ck_defaults'`,
      [OB1],
    )
    expect(r.rows[0]).toMatchObject({ status: 'pending', fence: '0', attempts: 0 })
  })

  test('master flag is OFF by default and robust to whitespace/case (no S1 behavior while OFF)', () => {
    expect(isDurableDeliveryEnabled({} as NodeJS.ProcessEnv)).toBe(false)
    expect(isDurableDeliveryEnabled({ AUTOMATION_DURABLE_DELIVERY_ENABLED: 'false' } as unknown as NodeJS.ProcessEnv)).toBe(false)
    expect(isDurableDeliveryEnabled({ AUTOMATION_DURABLE_DELIVERY_ENABLED: '1' } as unknown as NodeJS.ProcessEnv)).toBe(false)
    // positive control: only exactly-true (trim/case-insensitive) enables.
    expect(isDurableDeliveryEnabled({ AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv)).toBe(true)
    expect(isDurableDeliveryEnabled({ AUTOMATION_DURABLE_DELIVERY_ENABLED: '  TRUE ' } as unknown as NodeJS.ProcessEnv)).toBe(true)
  })

  test('RESOLVE_PERMITTING_STATUSES = {done, dead_letter} (a poisoned rule does not block adapter resolve forever)', () => {
    expect([...RESOLVE_PERMITTING_STATUSES].sort()).toEqual(['dead_letter', 'done'])
  })
})
