/**
 * A-1 (one-tap design-lock §3) — dingtalk_approval_card_deliveries ledger + accessor (real DB).
 *
 * Locks the load-bearing properties the P1 review correction demanded:
 *   - ledger row binds delivery → instance (FK, CASCADE),
 *   - the acted-claim is ATOMIC on card_state='sent' (idempotency anchor: exactly one winner),
 *   - supersede sweeps only still-`sent` rows of the instance,
 *   - the DB CHECKs reject invalid states and acted-audit inconsistencies.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pool } from '../../src/db/pg'
import {
  claimDingTalkApprovalCardDeliveryActed,
  findDingTalkApprovalCardDeliveryById,
  insertDingTalkApprovalCardDelivery,
  supersedeDingTalkApprovalCardDeliveriesForInstance,
} from '../../src/integrations/dingtalk/approval-card-deliveries'

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => pool.query(sql, params)

const INSTANCE = `apv_dacd_test_${Date.now()}`
const INSTANCE_CASCADE = `apv_dacd_cascade_${Date.now()}`

describeIfDb('A-1 — dingtalk approval card delivery ledger (real DB)', () => {
  beforeAll(async () => {
    await q(`INSERT INTO approval_instances (id, status, current_node_key) VALUES ($1, 'pending', 'approval_1') ON CONFLICT (id) DO NOTHING`, [INSTANCE])
    await q(`INSERT INTO approval_instances (id, status, current_node_key) VALUES ($1, 'pending', 'approval_1') ON CONFLICT (id) DO NOTHING`, [INSTANCE_CASCADE])
  })

  afterAll(async () => {
    await q(`DELETE FROM dingtalk_approval_card_deliveries WHERE instance_id = ANY($1::text[])`, [[INSTANCE, INSTANCE_CASCADE]]).catch(() => {})
    await q(`DELETE FROM approval_instances WHERE id = ANY($1::text[])`, [[INSTANCE, INSTANCE_CASCADE]]).catch(() => {})
  })

  it('sentinel: DATABASE_URL is set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('insert → findById round-trip; defaults card_state=sent and generates an id (the outTrackId)', async () => {
    const row = await insertDingTalkApprovalCardDelivery(q, {
      instanceId: INSTANCE,
      nodeKey: 'approval_1',
      recipientUserId: 'user_a',
      recipientDingTalkUserId: 'dd_user_a',
      deliveryKind: 'work_notice_action_card',
      taskId: 'task_123',
    })
    expect(row.id).toBeTruthy()
    expect(row.card_state).toBe('sent')
    expect(row.task_id).toBe('task_123')

    const found = await findDingTalkApprovalCardDeliveryById(q, row.id)
    expect(found?.instance_id).toBe(INSTANCE)
    expect(found?.node_key).toBe('approval_1')
    expect(found?.recipient_dingtalk_user_id).toBe('dd_user_a')
  })

  it('acted-claim is atomic: exactly one winner, the duplicate sees null and re-reads the terminal state', async () => {
    const row = await insertDingTalkApprovalCardDelivery(q, {
      instanceId: INSTANCE,
      nodeKey: 'approval_1',
      recipientUserId: 'user_b',
      recipientDingTalkUserId: 'dd_user_b',
      deliveryKind: 'interactive_card',
    })

    const [first, second] = await Promise.all([
      claimDingTalkApprovalCardDeliveryActed(q, row.id, { action: 'approve', actedBy: 'user_b' }),
      claimDingTalkApprovalCardDeliveryActed(q, row.id, { action: 'approve', actedBy: 'user_b' }),
    ])
    const winners = [first, second].filter(Boolean)
    expect(winners).toHaveLength(1) // exactly one claim wins the WHERE card_state='sent' race
    expect(winners[0]?.card_state).toBe('acted')
    expect(winners[0]?.acted_action).toBe('approve')

    // the loser re-reads the real terminal state
    const reread = await findDingTalkApprovalCardDeliveryById(q, row.id)
    expect(reread?.card_state).toBe('acted')
    expect(reread?.acted_by).toBe('user_b')
    expect(reread?.acted_at).toBeTruthy()

    // a third claim after the terminal state is a clean null, not an error
    expect(await claimDingTalkApprovalCardDeliveryActed(q, row.id, { action: 'reject', actedBy: 'user_x' })).toBeNull()
  })

  it('supersede sweeps only still-sent rows of the instance and honours excludeId', async () => {
    const acted = await insertDingTalkApprovalCardDelivery(q, {
      instanceId: INSTANCE_CASCADE,
      nodeKey: 'approval_1',
      recipientUserId: 'user_c',
      recipientDingTalkUserId: 'dd_user_c',
      deliveryKind: 'work_notice_action_card',
    })
    await claimDingTalkApprovalCardDeliveryActed(q, acted.id, { action: 'approve', actedBy: 'user_c' })

    const keep = await insertDingTalkApprovalCardDelivery(q, {
      instanceId: INSTANCE_CASCADE,
      nodeKey: 'approval_1',
      recipientUserId: 'user_d',
      recipientDingTalkUserId: 'dd_user_d',
      deliveryKind: 'work_notice_action_card',
    })
    const sweep1 = await insertDingTalkApprovalCardDelivery(q, {
      instanceId: INSTANCE_CASCADE,
      nodeKey: 'approval_1',
      recipientUserId: 'user_e',
      recipientDingTalkUserId: 'dd_user_e',
      deliveryKind: 'interactive_card',
    })

    const swept = await supersedeDingTalkApprovalCardDeliveriesForInstance(q, INSTANCE_CASCADE, { excludeId: keep.id })
    expect(swept).toEqual([sweep1.id]) // acted row untouched, excluded row spared

    expect((await findDingTalkApprovalCardDeliveryById(q, acted.id))?.card_state).toBe('acted')
    expect((await findDingTalkApprovalCardDeliveryById(q, keep.id))?.card_state).toBe('sent')
    expect((await findDingTalkApprovalCardDeliveryById(q, sweep1.id))?.card_state).toBe('superseded')

    // full sweep (no exclude) takes the remaining sent row
    const sweptAll = await supersedeDingTalkApprovalCardDeliveriesForInstance(q, INSTANCE_CASCADE)
    expect(sweptAll).toEqual([keep.id])
  })

  it('DB CHECKs reject invalid delivery_kind / card_state / acted-audit inconsistency; FK rejects unknown instances', async () => {
    await expect(
      q(`INSERT INTO dingtalk_approval_card_deliveries (id, instance_id, node_key, recipient_user_id, recipient_dingtalk_user_id, delivery_kind)
         VALUES ('bad_kind', $1, 'n1', 'u', 'dd', 'carrier_pigeon')`, [INSTANCE]),
    ).rejects.toThrow()

    await expect(
      q(`INSERT INTO dingtalk_approval_card_deliveries (id, instance_id, node_key, recipient_user_id, recipient_dingtalk_user_id, delivery_kind, card_state)
         VALUES ('bad_state', $1, 'n1', 'u', 'dd', 'interactive_card', 'teleported')`, [INSTANCE]),
    ).rejects.toThrow()

    // acted without audit columns violates dacd_acted_consistency
    await expect(
      q(`INSERT INTO dingtalk_approval_card_deliveries (id, instance_id, node_key, recipient_user_id, recipient_dingtalk_user_id, delivery_kind, card_state)
         VALUES ('bad_acted', $1, 'n1', 'u', 'dd', 'interactive_card', 'acted')`, [INSTANCE]),
    ).rejects.toThrow()

    // audit columns without acted state violate the same CHECK from the other side
    await expect(
      q(`INSERT INTO dingtalk_approval_card_deliveries (id, instance_id, node_key, recipient_user_id, recipient_dingtalk_user_id, delivery_kind, acted_action, acted_by, acted_at)
         VALUES ('bad_audit', $1, 'n1', 'u', 'dd', 'interactive_card', 'approve', 'u', NOW())`, [INSTANCE]),
    ).rejects.toThrow()

    await expect(
      insertDingTalkApprovalCardDelivery(q, {
        instanceId: 'apv_does_not_exist',
        nodeKey: 'n1',
        recipientUserId: 'u',
        recipientDingTalkUserId: 'dd',
        deliveryKind: 'interactive_card',
      }),
    ).rejects.toThrow()
  })

  it('ON DELETE CASCADE removes ledger rows with their instance', async () => {
    const doomedInstance = `apv_dacd_doomed_${Date.now()}`
    await q(`INSERT INTO approval_instances (id, status, current_node_key) VALUES ($1, 'pending', 'approval_1')`, [doomedInstance])
    const row = await insertDingTalkApprovalCardDelivery(q, {
      instanceId: doomedInstance,
      nodeKey: 'approval_1',
      recipientUserId: 'user_f',
      recipientDingTalkUserId: 'dd_user_f',
      deliveryKind: 'work_notice_action_card',
    })
    await q(`DELETE FROM approval_instances WHERE id = $1`, [doomedInstance])
    expect(await findDingTalkApprovalCardDeliveryById(q, row.id)).toBeNull()
  })
})
