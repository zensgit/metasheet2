/**
 * R1 (DT-HARDEN-08 follow-up) — dingtalk_group_deliveries retention sweep (real DB).
 *
 * The table is write-once: every group-robot send attempt (automation-rule
 * firings AND manual test-sends — both source_types) inserts a row with full
 * message content + raw response bodies, and nothing anywhere DELETEs from
 * it, so it grows unbounded. The sweep is a bounded batch DELETE of rows
 * older than a retention window (default 90d, floored at 7d).
 *
 * KEYSTONE: the sweep must delete ONLY rows strictly older than the cutoff
 * and leave everything inside the window untouched — for BOTH source_types
 * (automation and manual_test), since neither gets a carve-out. Seeds rows
 * at cutoff-1d (older → deleted) and cutoff+1d (younger → kept) per
 * source_type, then asserts the exact survivor set by id.
 *
 * Wired into .github/workflows/plugin-tests.yml "Run multitable real-DB
 * integration" step; excluded from packages/core-backend/vitest.config.ts's
 * default (no-DB) job so it cannot skip-green there.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import {
  DINGTALK_GROUP_DELIVERY_TABLE,
  PgDingTalkGroupDeliveryRetentionService,
  sweepDingTalkGroupDeliveryRetention,
} from '../../src/services/dingtalk-group-delivery-retention'
import { LedgerRetentionScheduler } from '../../src/services/LedgerRetentionScheduler'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const DESTINATION_ID = `dtdest_ret_${TS}`
const RECORD_ID = `rec_ret_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

type SeedRow = { id: string; sourceType: 'automation' | 'manual_test'; daysAgo: number }

/** Insert a delivery row, then force its created_at to `daysAgo` days in the past. */
async function seedRow(row: SeedRow): Promise<void> {
  await q(
    `INSERT INTO ${DINGTALK_GROUP_DELIVERY_TABLE} (
       id, destination_id, source_type, subject, content, success,
       http_status, response_body, error_message, record_id, initiated_by
     ) VALUES ($1, $2, $3, 'retention test', 'hello', true, 200, 'ok', NULL, $4, 'tester')`,
    [row.id, DESTINATION_ID, row.sourceType, RECORD_ID],
  )
  await q(
    `UPDATE ${DINGTALK_GROUP_DELIVERY_TABLE} SET created_at = now() - ($2::int * interval '1 day') WHERE id = $1`,
    [row.id, row.daysAgo],
  )
}

async function existingIds(): Promise<string[]> {
  const res = await q(`SELECT id FROM ${DINGTALK_GROUP_DELIVERY_TABLE} WHERE destination_id = $1 ORDER BY id`, [
    DESTINATION_ID,
  ])
  return (res.rows as Array<{ id: string }>).map((r) => r.id)
}

// Rows on either side of a 30-day retention cutoff, for both source_types.
const OLD_AUTOMATION = `${DESTINATION_ID}_old_auto`
const OLD_MANUAL = `${DESTINATION_ID}_old_manual`
const NEW_AUTOMATION = `${DESTINATION_ID}_new_auto`
const NEW_MANUAL = `${DESTINATION_ID}_new_manual`

async function reseed(): Promise<void> {
  await q(`DELETE FROM ${DINGTALK_GROUP_DELIVERY_TABLE} WHERE destination_id = $1`, [DESTINATION_ID])
  await seedRow({ id: OLD_AUTOMATION, sourceType: 'automation', daysAgo: 31 }) // cutoff(30d) - 1d → deleted
  await seedRow({ id: OLD_MANUAL, sourceType: 'manual_test', daysAgo: 31 }) // cutoff(30d) - 1d → deleted
  await seedRow({ id: NEW_AUTOMATION, sourceType: 'automation', daysAgo: 29 }) // cutoff(30d) + 1d → kept
  await seedRow({ id: NEW_MANUAL, sourceType: 'manual_test', daysAgo: 29 }) // cutoff(30d) + 1d → kept
}

describeIfDatabase('DingTalk group-delivery retention sweep (real DB)', () => {
  beforeAll(async () => {
    await q(
      `INSERT INTO dingtalk_group_destinations (id, name, webhook_url, created_by)
       VALUES ($1, 'retention test destination', 'https://oapi.dingtalk.com/robot/send?access_token=ret', 'tester')
       ON CONFLICT (id) DO NOTHING`,
      [DESTINATION_ID],
    )
    await reseed()
  })

  beforeEach(async () => {
    await reseed()
  })

  afterAll(async () => {
    await q(`DELETE FROM ${DINGTALK_GROUP_DELIVERY_TABLE} WHERE destination_id = $1`, [DESTINATION_ID]).catch(() => {})
    await q(`DELETE FROM dingtalk_group_destinations WHERE id = $1`, [DESTINATION_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('KEYSTONE: a 30-day sweep deletes only the >30d rows across BOTH source_types and keeps the rest', async () => {
    expect(await existingIds()).toHaveLength(4)

    const deleted = await sweepDingTalkGroupDeliveryRetention((sql, params) => q(sql, params), {
      retentionDays: 30,
      disabled: false,
    })
    expect(deleted).toBe(2)

    const remaining = await existingIds()
    expect(remaining.sort()).toEqual([NEW_AUTOMATION, NEW_MANUAL].sort())
    expect(remaining).not.toContain(OLD_AUTOMATION)
    expect(remaining).not.toContain(OLD_MANUAL)
  })

  test('idempotence: a second sweep pass over the same window deletes 0', async () => {
    const first = await sweepDingTalkGroupDeliveryRetention((sql, params) => q(sql, params), {
      retentionDays: 30,
      disabled: false,
    })
    expect(first).toBe(2)

    const second = await sweepDingTalkGroupDeliveryRetention((sql, params) => q(sql, params), {
      retentionDays: 30,
      disabled: false,
    })
    expect(second).toBe(0)
    expect(await existingIds()).toHaveLength(2)
  })

  test('disabled config is a no-op (deletes 0, table unchanged)', async () => {
    const deleted = await sweepDingTalkGroupDeliveryRetention((sql, params) => q(sql, params), {
      retentionDays: 30,
      disabled: true,
    })
    expect(deleted).toBe(0)
    expect(await existingIds()).toHaveLength(4)
  })

  test('the batch LIMIT bounds a single pass: batchSize=1 drains the 2 stale rows over two ticks, never one', async () => {
    const first = await sweepDingTalkGroupDeliveryRetention((sql, params) => q(sql, params), {
      retentionDays: 30,
      disabled: false,
      batchSize: 1,
    })
    expect(first).toBe(1) // bounded — NOT both stale rows in one pass
    expect(await existingIds()).toHaveLength(3)

    const second = await sweepDingTalkGroupDeliveryRetention((sql, params) => q(sql, params), {
      retentionDays: 30,
      disabled: false,
      batchSize: 1,
    })
    expect(second).toBe(1)
    expect(await existingIds()).toHaveLength(2)
  })

  test('PgDingTalkGroupDeliveryRetentionService.sweep() (the scheduler-bound path) hits the real DB identically', async () => {
    const service = new PgDingTalkGroupDeliveryRetentionService({ retentionDays: 30, disabled: false })
    const deleted = await service.sweep()
    expect(deleted).toBe(2)
    expect(await existingIds()).toHaveLength(2)
  })

  test('the scheduler tick drives the sweep end-to-end (LedgerRetentionScheduler + PgDingTalkGroupDeliveryRetentionService)', async () => {
    const scheduler = new LedgerRetentionScheduler({
      service: new PgDingTalkGroupDeliveryRetentionService({ retentionDays: 30, disabled: false }),
    })
    expect(scheduler.leader).toBe(true) // no leaderOptions → single-process leader immediately

    const deleted = await scheduler.tick()
    expect(deleted).toBe(2)
    expect(await existingIds()).toHaveLength(2)

    scheduler.stop()
  })
})
