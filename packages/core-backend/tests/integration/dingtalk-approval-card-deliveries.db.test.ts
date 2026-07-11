/**
 * A-1 (one-tap design-lock §3) — dingtalk_approval_card_deliveries ledger + accessor (real DB).
 *
 * Locks the load-bearing properties the P1 review correction demanded:
 *   - ledger row binds delivery → instance (FK, CASCADE),
 *   - the acted-claim is ATOMIC on card_state='sent' (idempotency anchor: exactly one winner),
 *   - supersede sweeps only still-`sent` rows of the instance,
 *   - the DB CHECKs reject invalid states and acted-audit inconsistencies.
 */
import { randomUUID } from 'crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pool } from '../../src/db/pg'
import {
  backfillDingTalkApprovalCardDeliveryEpochs,
  claimDingTalkApprovalCardDeliveryActed,
  findDingTalkApprovalCardDeliveriesByTaskId,
  findDingTalkApprovalCardDeliveryById,
  insertDingTalkApprovalCardDelivery,
  markDingTalkApprovalCardDeliverySendFailed,
  markDingTalkApprovalCardDeliverySendOutcomeUnknown,
  markDingTalkApprovalCardDeliverySent,
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

    await markDingTalkApprovalCardDeliverySent(q, row.id, 'task_claim_test') // P2: only delivered cards are claimable

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
    await markDingTalkApprovalCardDeliverySent(q, acted.id, 'task_supersede_test')
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

  it('P2-1: supersede NEVER sweeps a card whose (node,recipient) seat is still ACTIVE (parallel-fork sibling)', async () => {
    // Model a joinMode:'all' parallel fork: two live seats on distinct branch nodes. Approving
    // branch A advances past its own node but branch B's seat stays active — sweeping the instance
    // must NOT false-stale branch B's live card.
    const liveSeatCard = await insertDingTalkApprovalCardDelivery(q, {
      instanceId: INSTANCE_CASCADE,
      nodeKey: 'branch_b',
      recipientUserId: 'user_live',
      recipientDingTalkUserId: 'dd_user_live',
      deliveryKind: 'work_notice_action_card',
    })
    await markDingTalkApprovalCardDeliverySent(q, liveSeatCard.id, 'task_live_seat')
    const deadSeatCard = await insertDingTalkApprovalCardDelivery(q, {
      instanceId: INSTANCE_CASCADE,
      nodeKey: 'branch_a',
      recipientUserId: 'user_dead',
      recipientDingTalkUserId: 'dd_user_dead',
      deliveryKind: 'work_notice_action_card',
    })
    await markDingTalkApprovalCardDeliverySent(q, deadSeatCard.id, 'task_dead_seat')
    // branch B's seat is ACTIVE; branch A's seat was consumed (is_active = FALSE).
    await q(
      `INSERT INTO approval_assignments (instance_id, assignment_type, assignee_id, source_step, node_key, is_active)
       VALUES ($1, 'user', 'user_live', 0, 'branch_b', TRUE), ($1, 'user', 'user_dead', 0, 'branch_a', FALSE)`,
      [INSTANCE_CASCADE],
    )

    const swept = await supersedeDingTalkApprovalCardDeliveriesForInstance(q, INSTANCE_CASCADE)

    // Only the dead-seat card is superseded; the live parallel-sibling card is spared.
    expect(swept).toContain(deadSeatCard.id)
    expect(swept).not.toContain(liveSeatCard.id)
    expect((await findDingTalkApprovalCardDeliveryById(q, liveSeatCard.id))?.card_state).toBe('sent')
    expect((await findDingTalkApprovalCardDeliveryById(q, deadSeatCard.id))?.card_state).toBe('superseded')

    await q(`DELETE FROM approval_assignments WHERE instance_id = $1`, [INSTANCE_CASCADE]).catch(() => {})
  })

  it('P1-1 legacy backfill: a null-epoch sent card with a UNIQUE live non-null seat is backfilled; no-unique-seat and ambiguous cards are superseded (fail-closed); idempotent', async () => {
    // Dedicated instance so the scoped backfill cannot touch sibling fixtures in this shared-DB file.
    const INST = `apv_dacd_backfill_${Date.now()}`
    await q(`INSERT INTO approval_instances (id, status, current_node_key) VALUES ($1, 'pending', 'approval_1') ON CONFLICT (id) DO NOTHING`, [INST])
    try {
      // (a) UNIQUE live non-null-epoch seat for (INST, approval_1, user_match) — epoch 7.
      await q(`INSERT INTO approval_assignments (instance_id, assignment_type, assignee_id, source_step, node_key, is_active, entry_epoch) VALUES ($1,'user','user_match',0,'approval_1',TRUE,7)`, [INST])
      // (c) AMBIGUOUS: two live non-null-epoch seats for (INST, approval_2, user_ambig). The active-seat
      // unique index is (instance, assignment_type, assignee), so ambiguity needs DISTINCT types — the
      // backfill groups by (instance, node, assignee), so COUNT(*)=2 here → HAVING fails → superseded.
      await q(`INSERT INTO approval_assignments (instance_id, assignment_type, assignee_id, source_step, node_key, is_active, entry_epoch) VALUES ($1,'user','user_ambig',0,'approval_2',TRUE,3),($1,'role','user_ambig',0,'approval_2',TRUE,4)`, [INST])
      // (d) NULL-EPOCH-ONLY seat for (INST, approval_3, user_nullseat): a live seat exists but its epoch
      // is NULL, so the backfill (which counts only NON-NULL-epoch seats) finds no unique seat → superseded.
      await q(`INSERT INTO approval_assignments (instance_id, assignment_type, assignee_id, source_step, node_key, is_active, entry_epoch) VALUES ($1,'user','user_nullseat',0,'approval_3',TRUE,NULL)`, [INST])

      const mkNullEpochSent = async (node: string, recipient: string): Promise<string> => {
        const row = await insertDingTalkApprovalCardDelivery(q, { instanceId: INST, nodeKey: node, recipientUserId: recipient, recipientDingTalkUserId: `dd_${recipient}`, deliveryKind: 'work_notice_action_card' })
        await markDingTalkApprovalCardDeliverySent(q, row.id, `task_${recipient}`)
        return row.id
      }
      const matched = await mkNullEpochSent('approval_1', 'user_match')     // → backfilled to 7
      const orphan = await mkNullEpochSent('approval_9', 'user_orphan')     // → superseded (no live seat)
      const ambiguous = await mkNullEpochSent('approval_2', 'user_ambig')   // → superseded (>1 non-null seat)
      const nullseat = await mkNullEpochSent('approval_3', 'user_nullseat') // → superseded (only null-epoch seat)

      // All four start sent + null-epoch.
      for (const id of [matched, orphan, ambiguous, nullseat]) {
        const row = await findDingTalkApprovalCardDeliveryById(q, id)
        expect(row?.card_state).toBe('sent')
        expect(row?.entry_epoch ?? null).toBeNull()
      }

      const result = await backfillDingTalkApprovalCardDeliveryEpochs(q, { instanceIds: [INST] })

      // matched → epoch backfilled from the unique seat (7), still sent (now strictly bindable).
      // RED-before (remove the backfill step): entry_epoch stays null → card unrecoverable.
      expect(result.backfilledIds).toEqual([matched])
      const backfilledRow = await findDingTalkApprovalCardDeliveryById(q, matched)
      expect(backfilledRow?.entry_epoch).toBe(7)
      expect(backfilledRow?.card_state).toBe('sent')

      // orphan + ambiguous + nullseat → superseded (fail-closed). RED-before (remove the supersede step): sent + null.
      expect(result.supersededIds.sort()).toEqual([ambiguous, nullseat, orphan].sort())
      for (const id of [orphan, ambiguous, nullseat]) {
        expect((await findDingTalkApprovalCardDeliveryById(q, id))?.card_state).toBe('superseded')
      }

      // Idempotent: a second run touches neither (no sent + null-epoch rows remain).
      const rerun = await backfillDingTalkApprovalCardDeliveryEpochs(q, { instanceIds: [INST] })
      expect(rerun.backfilledIds).toEqual([])
      expect(rerun.supersededIds).toEqual([])
    } finally {
      await q(`DELETE FROM dingtalk_approval_card_deliveries WHERE instance_id = $1`, [INST]).catch(() => {})
      await q(`DELETE FROM approval_assignments WHERE instance_id = $1`, [INST]).catch(() => {})
      await q(`DELETE FROM approval_instances WHERE id = $1`, [INST]).catch(() => {})
    }
  })

  it('P2: pending/failed sends are NEVER claimable — only a delivered card is actionable', async () => {
    const pending = await insertDingTalkApprovalCardDelivery(q, {
      instanceId: INSTANCE,
      nodeKey: 'approval_1',
      recipientUserId: 'user_p2a',
      recipientDingTalkUserId: 'dd_user_p2a',
      deliveryKind: 'work_notice_action_card',
    })
    expect(await claimDingTalkApprovalCardDeliveryActed(q, pending.id, { action: 'approve', actedBy: 'user_p2a' })).toBeNull()
    expect((await findDingTalkApprovalCardDeliveryById(q, pending.id))?.card_state).toBe('sent')

    const failed = await insertDingTalkApprovalCardDelivery(q, {
      instanceId: INSTANCE,
      nodeKey: 'approval_1',
      recipientUserId: 'user_p2b',
      recipientDingTalkUserId: 'dd_user_p2b',
      deliveryKind: 'work_notice_action_card',
    })
    await markDingTalkApprovalCardDeliverySendFailed(q, failed.id, 'boom')
    expect(await claimDingTalkApprovalCardDeliveryActed(q, failed.id, { action: 'approve', actedBy: 'user_p2b' })).toBeNull()
    expect((await findDingTalkApprovalCardDeliveryById(q, failed.id))?.send_status).toBe('failed')

    // a delivered card claims normally (control)
    const delivered = await insertDingTalkApprovalCardDelivery(q, {
      instanceId: INSTANCE,
      nodeKey: 'approval_1',
      recipientUserId: 'user_p2c',
      recipientDingTalkUserId: 'dd_user_p2c',
      deliveryKind: 'work_notice_action_card',
    })
    await markDingTalkApprovalCardDeliverySent(q, delivered.id, null)
    expect((await claimDingTalkApprovalCardDeliveryActed(q, delivered.id, { action: 'reject', actedBy: 'user_p2c' }))?.card_state).toBe('acted')
  })

  it('PR #4046 Phase B: outcome_unknown persists via the new helper (pending-only guard), IS claimable, and the CHECK still rejects unknown send_status values', async () => {
    const row = await insertDingTalkApprovalCardDelivery(q, {
      instanceId: INSTANCE,
      nodeKey: 'approval_1',
      recipientUserId: 'user_ou',
      recipientDingTalkUserId: 'dd_user_ou',
      deliveryKind: 'work_notice_action_card',
    })
    const marked = await markDingTalkApprovalCardDeliverySendOutcomeUnknown(q, row.id, 'fetch failed (response lost)')
    expect(marked?.send_status).toBe('outcome_unknown')
    expect(marked?.send_error).toBe('fetch failed (response lost)')

    // pending-only guard: a second transition attempt is a no-op (same discipline as markSent/markSendFailed)
    expect(await markDingTalkApprovalCardDeliverySendOutcomeUnknown(q, row.id, 'again')).toBeNull()
    expect(await markDingTalkApprovalCardDeliverySent(q, row.id, 'task_late')).toBeNull()

    // possibly-delivered ⇒ claimable: a valid callback proves the card WAS delivered
    const claimed = await claimDingTalkApprovalCardDeliveryActed(q, row.id, { action: 'approve', actedBy: 'user_ou' })
    expect(claimed?.card_state).toBe('acted')
    expect(claimed?.send_status).toBe('outcome_unknown') // send-time truth is preserved on the audit row

    // widened CHECK stays closed to anything else
    await expect(
      q(`INSERT INTO dingtalk_approval_card_deliveries (id, instance_id, node_key, recipient_user_id, recipient_dingtalk_user_id, delivery_kind, send_status)
         VALUES ('bad_send_status', $1, 'n1', 'u', 'dd', 'interactive_card', 'maybe_sent')`, [INSTANCE]),
    ).rejects.toThrow()
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

  it('DT-R2: integration_id persists through insert + RETURNING, null passes through, and deleting the integration SET NULLs without touching the audit row', async () => {
    const integrationId = randomUUID()
    await q(
      `INSERT INTO directory_integrations (id, name, provider, corp_id) VALUES ($1, $2, 'dingtalk', $3)`,
      [integrationId, `dacd-r2-${Date.now()}`, `corp_dacd_r2_${Date.now()}`],
    )
    try {
      // Linked row: the column round-trips through INSERT + RETURNING and findById.
      const linked = await insertDingTalkApprovalCardDelivery(q, {
        instanceId: INSTANCE,
        nodeKey: 'approval_1',
        recipientUserId: 'user_r2a',
        recipientDingTalkUserId: 'dd_user_r2a',
        deliveryKind: 'work_notice_action_card',
        integrationId,
      })
      expect(linked.integration_id).toBe(integrationId)
      expect((await findDingTalkApprovalCardDeliveryById(q, linked.id))?.integration_id).toBe(integrationId)

      // Unlinked row (env-only / legacy shape): null passthrough, never a guessed integration.
      const unlinked = await insertDingTalkApprovalCardDelivery(q, {
        instanceId: INSTANCE,
        nodeKey: 'approval_1',
        recipientUserId: 'user_r2b',
        recipientDingTalkUserId: 'dd_user_r2b',
        deliveryKind: 'work_notice_action_card',
      })
      expect(unlinked.integration_id).toBeNull()

      // FK rejects an unknown integration — the anchor is never dangling.
      await expect(
        insertDingTalkApprovalCardDelivery(q, {
          instanceId: INSTANCE,
          nodeKey: 'approval_1',
          recipientUserId: 'user_r2c',
          recipientDingTalkUserId: 'dd_user_r2c',
          deliveryKind: 'work_notice_action_card',
          integrationId: randomUUID(),
        }),
      ).rejects.toThrow()

      // ON DELETE SET NULL: removing the integration must NOT delete the approval audit row.
      await q(`DELETE FROM directory_integrations WHERE id = $1`, [integrationId])
      const survivor = await findDingTalkApprovalCardDeliveryById(q, linked.id)
      expect(survivor).not.toBeNull()
      expect(survivor?.integration_id).toBeNull()
    } finally {
      await q(`DELETE FROM directory_integrations WHERE id = $1`, [integrationId]).catch(() => {})
    }
  })

  // §7.6 Delivery Closure — task_id is now queryable: the trace index + lookup-by-task_id accessor
  // let an operator resolve a DingTalk asyncsend_v2 receipt back to the delivery (instance, recipient,
  // send status). task_id was already persisted (insert + markSent); this locks it as queryable.
  it('§7.6 trace: findByTaskId resolves an accepted async message; blank/unknown → []', async () => {
    const taskId = `trace_task_${randomUUID()}`
    const inserted = await insertDingTalkApprovalCardDelivery(q, {
      instanceId: INSTANCE,
      nodeKey: 'approval_1',
      recipientUserId: 'user_trace',
      recipientDingTalkUserId: 'dd_user_trace',
      deliveryKind: 'work_notice_action_card',
      taskId,
    })

    const found = await findDingTalkApprovalCardDeliveriesByTaskId(q, taskId)
    expect(found.map((r) => r.id)).toContain(inserted.id)
    expect(found.every((r) => r.task_id === taskId)).toBe(true)

    // A receipt recorded via markSent (the real asyncsend_v2 success path) is equally traceable.
    const pending = await insertDingTalkApprovalCardDelivery(q, {
      instanceId: INSTANCE,
      nodeKey: 'approval_1',
      recipientUserId: 'user_trace2',
      recipientDingTalkUserId: 'dd_user_trace2',
      deliveryKind: 'interactive_card',
    })
    const markTaskId = `trace_marked_${randomUUID()}`
    await markDingTalkApprovalCardDeliverySent(q, pending.id, markTaskId)
    const foundMarked = await findDingTalkApprovalCardDeliveriesByTaskId(q, markTaskId)
    expect(foundMarked.map((r) => r.id)).toContain(pending.id)

    // Unknown task_id and blank input never match (the partial index excludes NULL task_ids).
    expect(await findDingTalkApprovalCardDeliveriesByTaskId(q, `nope_${randomUUID()}`)).toEqual([])
    expect(await findDingTalkApprovalCardDeliveriesByTaskId(q, '   ')).toEqual([])
  })

  it('§7.6 trace: the partial task_id index exists (migration applied)', async () => {
    const res = await q(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_dacd_task_id' AND tablename = 'dingtalk_approval_card_deliveries'`,
    )
    expect(res.rows.length).toBe(1)
    expect(String((res.rows[0] as { indexdef: string }).indexdef)).toMatch(/task_id/)
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
