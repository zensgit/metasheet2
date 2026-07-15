/**
 * P2 durable-delivery — slice S1 schema + flag golden (real DB).
 *
 * Verifies the additive migration `zzzz20260715120000_create_automation_outbox` landed the two new tables
 * with the shape the later slices depend on:
 *   - `status` CHECK enforces the FOUR-state machine `pending|in_progress|done|dead_letter` (no persistent
 *     `failed` — a stuck absorbing state);
 *   - the lease is a BICONDITIONAL of `status='in_progress'` (in_progress ⇒ leased; NOT in_progress ⇒ no
 *     lease) — all four corners are exercised;
 *   - `event_id` is NOT NULL (the stable original-event identity the dispatcher forwards downstream, #4203);
 *   - fence/attempts/manifest_version/automation_depth carry the documented non-negative / positive CHECKs;
 *   - `fence` is `bigint` and round-trips as a STRING past 2^53 (no JS-number precision loss — S2's CAS
 *     depends on this);
 *   - the FK cascade deletes per-consumer rows with their outbox event; and the master flag is OFF by
 *     default (so S1 changes byte-for-byte nothing at runtime).
 *
 * Each named CHECK has a negative control that asserts the SPECIFIC constraint name in the rejection, so
 * deleting/loosening that one constraint turns exactly its test red (mutation-resistant, not a blanket
 * `.rejects.toThrow()` that any error would satisfy).
 *
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI's real-DB lane; two-point wired into
 * plugin-tests.yml + excluded from the no-DB default job in vitest.config.ts so it cannot skip-green).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { isDurableDeliveryEnabled, RESOLVE_PERMITTING_STATUSES } from '../../src/multitable/automation-durable-delivery'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

// Synthetic outbox ids for this run (Date.now()-scoped so parallel files/runs never collide); cleaned up after.
const RUN = Math.floor(Date.now() % 1e9)
const OB1 = `ob_s1_${RUN}_a`
const OB2 = `ob_s1_${RUN}_b`
const OB_MV = `ob_s1_${RUN}_mv` // manifest_version=0 negative control (insert must fail → no row persists)
const OB_DEPTH = `ob_s1_${RUN}_depth` // automation_depth=-1 negative control (insert must fail → no row persists)
const ALL_OB = [OB1, OB2, OB_MV, OB_DEPTH]

// A fully-valid outbox row — every NOT NULL column supplied, INCLUDING the now-required event_id.
const insertOutbox = (id: string) =>
  q(
    `INSERT INTO meta_automation_outbox (id, event_type, payload, automation_depth, manifest_version, event_id)
     VALUES ($1,'approval.approved','{}'::jsonb,0,1,$2)
     ON CONFLICT (id) DO NOTHING`,
    [id, `evt_${id}`],
  )

describeIfDatabase('P2 durable-delivery S1 — automation outbox schema + flag (real DB)', () => {
  beforeAll(async () => {
    await q('DELETE FROM meta_automation_outbox WHERE id = ANY($1)', [ALL_OB]).catch(() => {})
  })
  afterAll(async () => {
    await q('DELETE FROM meta_automation_outbox WHERE id = ANY($1)', [ALL_OB]).catch(() => {})
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

  test('event_id is NOT NULL (stable original-event identity forwarded as the downstream dedup key)', async () => {
    // Otherwise-valid row; the ONLY violation is a NULL event_id → the not-null constraint must reject it.
    await expect(
      q(
        `INSERT INTO meta_automation_outbox (id, event_type, payload, automation_depth, manifest_version, event_id)
         VALUES ($1,'approval.approved','{}'::jsonb,0,1,NULL)`,
        [OB_MV],
      ),
    ).rejects.toThrow(/event_id|not-null/i)
  })

  test('manifest_version CHECK rejects 0 (must be >= 1) — by constraint name', async () => {
    await expect(
      q(
        `INSERT INTO meta_automation_outbox (id, event_type, payload, automation_depth, manifest_version, event_id)
         VALUES ($1,'approval.approved','{}'::jsonb,0,0,$2)`,
        [OB_MV, `evt_${OB_MV}`],
      ),
    ).rejects.toThrow(/automation_outbox_manifest_version_positive/)
  })

  test('automation_depth CHECK rejects a negative depth — by constraint name', async () => {
    await expect(
      q(
        `INSERT INTO meta_automation_outbox (id, event_type, payload, automation_depth, manifest_version, event_id)
         VALUES ($1,'approval.approved','{}'::jsonb,-1,1,$2)`,
        [OB_DEPTH, `evt_${OB_DEPTH}`],
      ),
    ).rejects.toThrow(/automation_outbox_depth_nonneg/)
  })

  test('status CHECK enforces the four-state machine (rejects an unknown status; accepts each valid one)', async () => {
    await insertOutbox(OB1)
    // positive control: exactly FOUR valid statuses — NO persistent `failed`. `in_progress` MUST carry a lease
    // (the lease-iff-in_progress biconditional); the other three MUST NOT — so give in_progress a lease, others NULL.
    for (const s of ['pending', 'in_progress', 'done', 'dead_letter'] as const) {
      const lease = s === 'in_progress' ? "now() + interval '5 minutes'" : 'NULL'
      await q(
        `INSERT INTO meta_automation_outbox_consumer (outbox_id, consumer_key, status, lease_expires_at)
         VALUES ($1,$2,$3,${lease})
         ON CONFLICT (outbox_id, consumer_key) DO UPDATE SET status = EXCLUDED.status, lease_expires_at = EXCLUDED.lease_expires_at`,
        [OB1, `ck_${s}`, s],
      )
    }
    // negative: a bogus status (valid lease shape) → only the status CHECK can fire.
    await expect(
      q(
        `INSERT INTO meta_automation_outbox_consumer (outbox_id, consumer_key, status, lease_expires_at) VALUES ($1,'ck_bad','bogus',NULL)`,
        [OB1],
      ),
    ).rejects.toThrow(/automation_outbox_consumer_status_valid/)
  })

  test('lease is a BICONDITIONAL of in_progress — all four corners enforced', async () => {
    await insertOutbox(OB1)
    // (a) in_progress + NULL lease → rejected (would be unreclaimable).
    await expect(
      q(
        `INSERT INTO meta_automation_outbox_consumer (outbox_id, consumer_key, status, lease_expires_at)
         VALUES ($1,'ck_ip_nolease','in_progress',NULL)`,
        [OB1],
      ),
    ).rejects.toThrow(/automation_outbox_consumer_lease_iff_in_progress/)
    // (b) in_progress + lease → accepted.
    await expect(
      q(
        `INSERT INTO meta_automation_outbox_consumer (outbox_id, consumer_key, status, lease_expires_at)
         VALUES ($1,'ck_ip_leased','in_progress',now() + interval '5 minutes')`,
        [OB1],
      ),
    ).resolves.toBeTruthy()
    // (c) NOT-in_progress + lease → rejected (the OTHER half the review flagged: a stale lease on done/pending
    //     would be spuriously matched by the reclaim scan).
    await expect(
      q(
        `INSERT INTO meta_automation_outbox_consumer (outbox_id, consumer_key, status, lease_expires_at)
         VALUES ($1,'ck_done_leased','done',now() + interval '5 minutes')`,
        [OB1],
      ),
    ).rejects.toThrow(/automation_outbox_consumer_lease_iff_in_progress/)
    await expect(
      q(
        `INSERT INTO meta_automation_outbox_consumer (outbox_id, consumer_key, status, lease_expires_at)
         VALUES ($1,'ck_pending_leased','pending',now() + interval '5 minutes')`,
        [OB1],
      ),
    ).rejects.toThrow(/automation_outbox_consumer_lease_iff_in_progress/)
    // (d) NOT-in_progress + NULL lease → accepted.
    await expect(
      q(
        `INSERT INTO meta_automation_outbox_consumer (outbox_id, consumer_key, status, lease_expires_at)
         VALUES ($1,'ck_pending_nolease','pending',NULL)`,
        [OB1],
      ),
    ).resolves.toBeTruthy()
  })

  test('fence/attempts non-negative CHECKs reject negatives — each by its own constraint name', async () => {
    await insertOutbox(OB1)
    await expect(
      q(
        `INSERT INTO meta_automation_outbox_consumer (outbox_id, consumer_key, status, fence) VALUES ($1,'ck_negfence','pending',-1)`,
        [OB1],
      ),
    ).rejects.toThrow(/automation_outbox_consumer_fence_nonneg/)
    await expect(
      q(
        `INSERT INTO meta_automation_outbox_consumer (outbox_id, consumer_key, status, attempts) VALUES ($1,'ck_negattempts','pending',-1)`,
        [OB1],
      ),
    ).rejects.toThrow(/automation_outbox_consumer_attempts_nonneg/)
  })

  test('fence is bigint and round-trips as a STRING beyond 2^53 (no JS-number precision loss)', async () => {
    await insertOutbox(OB1)
    const big = '9007199254740993' // 2^53 + 1 — the first integer a JS number cannot represent exactly.
    expect(BigInt(big) > 2n ** 53n).toBe(true) // it is genuinely past the JS-number safe-integer boundary.
    // Pass as a text param (never a JS number, which would corrupt it before it reached pg).
    await q(
      `INSERT INTO meta_automation_outbox_consumer (outbox_id, consumer_key, status, lease_expires_at, fence)
       VALUES ($1,'ck_bigfence','pending',NULL,$2)
       ON CONFLICT (outbox_id, consumer_key) DO UPDATE SET fence = EXCLUDED.fence`,
      [OB1, big],
    )
    const r = await q(
      `SELECT fence FROM meta_automation_outbox_consumer WHERE outbox_id=$1 AND consumer_key='ck_bigfence'`,
      [OB1],
    )
    // The node-postgres driver returns bigint as a string; the exact value survives (a JS number would
    // have collapsed 9007199254740993 → 9007199254740992). This is why OutboxConsumerRow.fence is `string`.
    expect(typeof r.rows[0].fence).toBe('string')
    expect(r.rows[0].fence).toBe(big)
  })

  test('FK cascade: deleting an outbox event removes its per-consumer lease rows', async () => {
    await insertOutbox(OB2)
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

  test('column defaults: a fresh consumer row is pending, fence 0 (string), attempts 0, no lease', async () => {
    await insertOutbox(OB1)
    await q(
      `INSERT INTO meta_automation_outbox_consumer (outbox_id, consumer_key) VALUES ($1,'ck_defaults')
       ON CONFLICT (outbox_id, consumer_key) DO NOTHING`,
      [OB1],
    )
    const r = await q(
      `SELECT status, fence, attempts, lease_expires_at FROM meta_automation_outbox_consumer WHERE outbox_id=$1 AND consumer_key='ck_defaults'`,
      [OB1],
    )
    expect(r.rows[0]).toMatchObject({ status: 'pending', fence: '0', attempts: 0, lease_expires_at: null })
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
