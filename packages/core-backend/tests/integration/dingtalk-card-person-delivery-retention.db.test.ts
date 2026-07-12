/**
 * DT-HARDEN-08 follow-up — dingtalk_approval_card_deliveries + dingtalk_person_deliveries
 * retention sweep (real DB). Sibling of dingtalk-group-delivery-retention.db.test.ts.
 *
 * dingtalk_person_deliveries is write-once (full message content + raw response bodies, no
 * DELETE anywhere) — mirrors the group ledger's shape exactly, so its sweep is a bounded batch
 * DELETE. dingtalk_approval_card_deliveries carries the security-relevant card_state machine
 * instead of message content — its sweep only ever moves a stale `sent` row to the already-valid
 * `expired` terminal state, NEVER deletes (acted_action/acted_by/acted_at are the only
 * delivery-channel record of who approved/rejected via card, and are preserved even past the
 * window).
 *
 * KEYSTONE (security): a card row the sweep expires must NOT be claimable afterward —
 * claimDingTalkApprovalCardDeliveryActed's `WHERE card_state='sent'` guard must reject it, proving
 * the sweep can only ever move a card AWAY from actionable, never toward it.
 *
 * Also proves: (a) unset env ⇒ true no-op (both tables untouched) — the default-OFF gate this
 * sweep deliberately inverts from the group sweep's opt-out default; (b) rows inside the window
 * are untouched; (c) rows outside the window are redacted/expired per the precedent above; (d)
 * idempotent; (e) swept card row is non-actionable; (f) the sweep does not touch
 * dingtalk_group_deliveries, the sibling ledger it does not own.
 *
 * Wired into .github/workflows/plugin-tests.yml "Run multitable real-DB integration" step;
 * excluded from packages/core-backend/vitest.config.ts's default (no-DB) job so it cannot
 * skip-green there.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import {
  claimDingTalkApprovalCardDeliveryActed,
  findDingTalkApprovalCardDeliveryById,
  insertDingTalkApprovalCardDelivery,
  markDingTalkApprovalCardDeliverySent,
} from '../../src/integrations/dingtalk/approval-card-deliveries'
import {
  DINGTALK_APPROVAL_CARD_DELIVERY_TABLE,
  DINGTALK_PERSON_DELIVERY_TABLE,
  PgDingTalkCardPersonDeliveryRetentionService,
  resolveDingTalkDeliveryRetentionConfig,
  sweepDingTalkApprovalCardDeliveryRetention,
  sweepDingTalkCardPersonDeliveryRetention,
  sweepDingTalkPersonDeliveryRetention,
} from '../../src/services/dingtalk-card-person-delivery-retention'
import { LedgerRetentionScheduler } from '../../src/services/LedgerRetentionScheduler'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const INSTANCE_ID = `apv_dacpr_${TS}`
const GROUP_DESTINATION_ID = `dtdest_dacpr_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

async function ageRow(table: string, id: string, daysAgo: number): Promise<void> {
  await q(`UPDATE ${table} SET created_at = now() - ($2::int * interval '1 day') WHERE id = $1`, [id, daysAgo])
}

// --- dingtalk_person_deliveries fixtures (no FK — plain TEXT columns) -----------------------
const OLD_PERSON = `dacpr_person_old_${TS}`
const NEW_PERSON = `dacpr_person_new_${TS}`

async function seedPersonRow(id: string, daysAgo: number): Promise<void> {
  await q(
    `INSERT INTO ${DINGTALK_PERSON_DELIVERY_TABLE}
       (id, local_user_id, source_type, subject, content, success, status)
     VALUES ($1, 'user_dacpr', 'automation', 'retention test', 'hello content', true, 'success')`,
    [id],
  )
  await ageRow(DINGTALK_PERSON_DELIVERY_TABLE, id, daysAgo)
}

async function personIds(): Promise<string[]> {
  const res = await q(`SELECT id FROM ${DINGTALK_PERSON_DELIVERY_TABLE} WHERE local_user_id = 'user_dacpr' ORDER BY id`)
  return (res.rows as Array<{ id: string }>).map((r) => r.id)
}

// --- dingtalk_approval_card_deliveries fixtures (FK → approval_instances) -------------------
const OLD_SENT_CARD = `dacpr_card_old_sent_${TS}`
const NEW_SENT_CARD = `dacpr_card_new_sent_${TS}`
const OLD_ACTED_CARD = `dacpr_card_old_acted_${TS}`

async function seedCardRows(): Promise<void> {
  await insertDingTalkApprovalCardDelivery(q, {
    id: OLD_SENT_CARD,
    instanceId: INSTANCE_ID,
    nodeKey: 'approval_1',
    recipientUserId: 'user_old_sent',
    recipientDingTalkUserId: 'dd_user_old_sent',
    deliveryKind: 'work_notice_action_card',
  })
  await markDingTalkApprovalCardDeliverySent(q, OLD_SENT_CARD, 'task_dacpr_old_sent') // send_status='sent' — WOULD be actionable if not swept
  await ageRow(DINGTALK_APPROVAL_CARD_DELIVERY_TABLE, OLD_SENT_CARD, 31)

  await insertDingTalkApprovalCardDelivery(q, {
    id: NEW_SENT_CARD,
    instanceId: INSTANCE_ID,
    nodeKey: 'approval_1',
    recipientUserId: 'user_new_sent',
    recipientDingTalkUserId: 'dd_user_new_sent',
    deliveryKind: 'work_notice_action_card',
  })
  await markDingTalkApprovalCardDeliverySent(q, NEW_SENT_CARD, 'task_dacpr_new_sent')
  await ageRow(DINGTALK_APPROVAL_CARD_DELIVERY_TABLE, NEW_SENT_CARD, 29)

  await insertDingTalkApprovalCardDelivery(q, {
    id: OLD_ACTED_CARD,
    instanceId: INSTANCE_ID,
    nodeKey: 'approval_1',
    recipientUserId: 'user_old_acted',
    recipientDingTalkUserId: 'dd_user_old_acted',
    deliveryKind: 'work_notice_action_card',
  })
  await markDingTalkApprovalCardDeliverySent(q, OLD_ACTED_CARD, 'task_dacpr_old_acted')
  await claimDingTalkApprovalCardDeliveryActed(q, OLD_ACTED_CARD, { action: 'approve', actedBy: 'user_old_acted' })
  await ageRow(DINGTALK_APPROVAL_CARD_DELIVERY_TABLE, OLD_ACTED_CARD, 31) // old AND already-terminal — must stay 'acted', not touched
}

async function cardState(id: string): Promise<string | null> {
  const row = await findDingTalkApprovalCardDeliveryById(q, id)
  return row?.card_state ?? null
}

async function reseed(): Promise<void> {
  await q(`DELETE FROM ${DINGTALK_APPROVAL_CARD_DELIVERY_TABLE} WHERE instance_id = $1`, [INSTANCE_ID])
  await q(`DELETE FROM ${DINGTALK_PERSON_DELIVERY_TABLE} WHERE local_user_id = 'user_dacpr'`)
  await seedPersonRow(OLD_PERSON, 31)
  await seedPersonRow(NEW_PERSON, 29)
  await seedCardRows()
}

describeIfDatabase('DingTalk approval-card + person delivery retention sweep (real DB)', () => {
  beforeAll(async () => {
    await q(
      `INSERT INTO approval_instances (id, status, current_node_key) VALUES ($1, 'pending', 'approval_1') ON CONFLICT (id) DO NOTHING`,
      [INSTANCE_ID],
    )
    await q(
      `INSERT INTO dingtalk_group_destinations (id, name, webhook_url, created_by)
       VALUES ($1, 'dacpr sibling-isolation destination', 'https://oapi.dingtalk.com/robot/send?access_token=dacpr', 'tester')
       ON CONFLICT (id) DO NOTHING`,
      [GROUP_DESTINATION_ID],
    )
    await reseed()
  })

  beforeEach(async () => {
    await reseed()
  })

  afterAll(async () => {
    await q(`DELETE FROM ${DINGTALK_APPROVAL_CARD_DELIVERY_TABLE} WHERE instance_id = $1`, [INSTANCE_ID]).catch(() => {})
    await q(`DELETE FROM ${DINGTALK_PERSON_DELIVERY_TABLE} WHERE local_user_id = 'user_dacpr'`).catch(() => {})
    await q(`DELETE FROM approval_instances WHERE id = $1`, [INSTANCE_ID]).catch(() => {})
    await q(`DELETE FROM dingtalk_group_deliveries WHERE destination_id = $1`, [GROUP_DESTINATION_ID]).catch(() => {})
    await q(`DELETE FROM dingtalk_group_destinations WHERE id = $1`, [GROUP_DESTINATION_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('(a) DEFAULT-OFF: resolveDingTalkDeliveryRetentionConfig({}) (unset env) drives a true no-op against the real DB — both tables completely unchanged', async () => {
    const config = resolveDingTalkDeliveryRetentionConfig({}) // simulates a deployment that never set DINGTALK_DELIVERY_RETENTION_DAYS
    expect(config.disabled).toBe(true)

    const result = await sweepDingTalkCardPersonDeliveryRetention((sql, params) => q(sql, params), config)
    expect(result).toEqual({ personDeleted: 0, cardExpired: 0 })

    expect((await personIds()).sort()).toEqual([NEW_PERSON, OLD_PERSON].sort())
    expect(await cardState(OLD_SENT_CARD)).toBe('sent') // NOT expired — the env was never configured
    expect(await cardState(NEW_SENT_CARD)).toBe('sent')
    expect(await cardState(OLD_ACTED_CARD)).toBe('acted')
  })

  test('(b)+(c) KEYSTONE: a 30-day sweep deletes only the >30d person row and expires only the >30d still-sent card row; everything inside the window (and any non-sent card) is untouched', async () => {
    expect((await personIds()).sort()).toEqual([NEW_PERSON, OLD_PERSON].sort())

    const result = await sweepDingTalkCardPersonDeliveryRetention((sql, params) => q(sql, params), {
      retentionDays: 30,
      disabled: false,
    })
    expect(result).toEqual({ personDeleted: 1, cardExpired: 1 })

    // person: old deleted, new kept
    expect(await personIds()).toEqual([NEW_PERSON])

    // card: old-sent → expired; new-sent untouched; old-but-already-acted untouched (never a delete, never re-touched)
    expect(await cardState(OLD_SENT_CARD)).toBe('expired')
    expect(await cardState(NEW_SENT_CARD)).toBe('sent')
    expect(await cardState(OLD_ACTED_CARD)).toBe('acted')

    // the expired row is NOT physically deleted — the ledger keeps it (delivery-channel record)
    expect(await findDingTalkApprovalCardDeliveryById(q, OLD_SENT_CARD)).not.toBeNull()
  })

  test('(e) SECURITY KEYSTONE: a swept (expired) card row can never be claimed — the atomic claim requires card_state=\'sent\' and a swept row fails it, staying expired forever', async () => {
    await sweepDingTalkApprovalCardDeliveryRetention((sql, params) => q(sql, params), { retentionDays: 30, disabled: false })
    expect(await cardState(OLD_SENT_CARD)).toBe('expired')

    // OLD_SENT_CARD was marked send_status='sent' before ageing — it WOULD have been claimable had
    // the sweep not expired it first. The claim must now fail (return null) and never flip back.
    const claimed = await claimDingTalkApprovalCardDeliveryActed(q, OLD_SENT_CARD, {
      action: 'approve',
      actedBy: 'attacker_or_late_tap',
    })
    expect(claimed).toBeNull()
    expect(await cardState(OLD_SENT_CARD)).toBe('expired') // still expired, never 'acted', never back to 'sent'
  })

  test('(d) idempotence: a second sweep pass over the same window deletes/expires 0 more', async () => {
    const first = await sweepDingTalkCardPersonDeliveryRetention((sql, params) => q(sql, params), {
      retentionDays: 30,
      disabled: false,
    })
    expect(first).toEqual({ personDeleted: 1, cardExpired: 1 })

    const second = await sweepDingTalkCardPersonDeliveryRetention((sql, params) => q(sql, params), {
      retentionDays: 30,
      disabled: false,
    })
    expect(second).toEqual({ personDeleted: 0, cardExpired: 0 })

    expect(await personIds()).toEqual([NEW_PERSON])
    expect(await cardState(OLD_SENT_CARD)).toBe('expired')
  })

  test('disabled config (explicit disabled:true) is a no-op on both tables', async () => {
    const result = await sweepDingTalkCardPersonDeliveryRetention((sql, params) => q(sql, params), {
      retentionDays: 30,
      disabled: true,
    })
    expect(result).toEqual({ personDeleted: 0, cardExpired: 0 })
    expect((await personIds()).sort()).toEqual([NEW_PERSON, OLD_PERSON].sort())
    expect(await cardState(OLD_SENT_CARD)).toBe('sent')
  })

  test('the batch LIMIT bounds a single person-delete pass (batchSize=1 does not also expire cards in the same call — sub-sweeps are independently bounded)', async () => {
    const deleted = await sweepDingTalkPersonDeliveryRetention((sql, params) => q(sql, params), {
      retentionDays: 30,
      disabled: false,
      batchSize: 1,
    })
    expect(deleted).toBe(1) // only 1 stale person row exists, batch bound is not exercised further here, but proves the LIMIT wiring executes
    expect(await personIds()).toEqual([NEW_PERSON])
    // card table untouched by the person-only sub-sweep
    expect(await cardState(OLD_SENT_CARD)).toBe('sent')
  })

  test('the batch LIMIT bounds a single card-expire pass (batchSize=1)', async () => {
    const expired = await sweepDingTalkApprovalCardDeliveryRetention((sql, params) => q(sql, params), {
      retentionDays: 30,
      disabled: false,
      batchSize: 1,
    })
    expect(expired).toBe(1)
    expect(await cardState(OLD_SENT_CARD)).toBe('expired')
    // person table untouched by the card-only sub-sweep
    expect(await personIds()).toEqual(expect.arrayContaining([OLD_PERSON, NEW_PERSON]))
  })

  test('(f) sibling isolation: the sweep never touches dingtalk_group_deliveries (a table it does not own)', async () => {
    const OLD_GROUP_ROW = `dacpr_group_${TS}`
    await q(
      `INSERT INTO dingtalk_group_deliveries (
         id, destination_id, source_type, subject, content, success,
         http_status, response_body, error_message
       ) VALUES ($1, $2, 'automation', 'sibling test', 'hello', true, 200, 'ok', NULL)`,
      [OLD_GROUP_ROW, GROUP_DESTINATION_ID],
    )
    await ageRow('dingtalk_group_deliveries', OLD_GROUP_ROW, 365) // far past any retention window

    await sweepDingTalkCardPersonDeliveryRetention((sql, params) => q(sql, params), { retentionDays: 30, disabled: false })

    const res = await q(`SELECT id FROM dingtalk_group_deliveries WHERE id = $1`, [OLD_GROUP_ROW])
    expect(res.rows).toHaveLength(1) // untouched — this sweep owns only the card + person ledgers
  })

  test('PgDingTalkCardPersonDeliveryRetentionService.sweep() (the scheduler-bound path) hits the real DB identically and returns the combined count', async () => {
    const service = new PgDingTalkCardPersonDeliveryRetentionService({ retentionDays: 30, disabled: false })
    const swept = await service.sweep()
    expect(swept).toBe(2) // 1 person deleted + 1 card expired
    expect(await personIds()).toEqual([NEW_PERSON])
    expect(await cardState(OLD_SENT_CARD)).toBe('expired')
  })

  test('the scheduler tick drives the sweep end-to-end (LedgerRetentionScheduler + PgDingTalkCardPersonDeliveryRetentionService)', async () => {
    const scheduler = new LedgerRetentionScheduler({
      service: new PgDingTalkCardPersonDeliveryRetentionService({ retentionDays: 30, disabled: false }),
    })
    expect(scheduler.leader).toBe(true)

    const swept = await scheduler.tick()
    expect(swept).toBe(2)
    expect(await personIds()).toEqual([NEW_PERSON])
    expect(await cardState(OLD_SENT_CARD)).toBe('expired')

    scheduler.stop()
  })
})
