/**
 * PR #4142 P2-1 HARDENING GOLDEN — the sweep's actual security invariant, tested on the REAL
 * production surfaces (reviewer-authored; EXECUTED and PASSING against real Postgres on the merge
 * result of origin/main + PR #4142).
 *
 * Suggested landing path:
 *   packages/core-backend/tests/integration/dingtalk-card-delivery-retention-actionability.db.test.ts
 * and add that path to the `Run multitable real-DB integration` run-list in .github/workflows/plugin-tests.yml
 * (next to dingtalk-card-person-delivery-retention.db.test.ts), plus the exclude list in vitest.config.ts.
 *
 * WHY THIS EXISTS: PR #4142's own test (e) ("SECURITY KEYSTONE") asserts only the low-level
 * claimDingTalkApprovalCardDeliveryActed helper. Neutering the ACTUAL guard —
 * `delivery.card_state === 'sent'` in ApprovalCardDeliveryAction.buildSummary — leaves the entire
 * repo suite GREEN (43/43) while a swept `expired` card becomes fully actionable again. The sweep
 * creates the first state in the system where a non-`sent` card coexists with a still-`pending`
 * instance AND a still-live matching seat, i.e. where card_state is the SOLE load-bearing guard.
 * This file is RED under that mutation.
 *
 * The CONTROL test is load-bearing: without it, `actionable:false` could mean a broken fixture
 * rather than a working guard.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createHmac } from 'crypto'

import { poolManager } from '../../src/integration/db/connection-pool'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'
import {
  executeApprovalActionFromCardDelivery,
  getApprovalCardDeliverySummary,
} from '../../src/services/ApprovalCardDeliveryAction'
import {
  insertDingTalkApprovalCardDelivery,
  markDingTalkApprovalCardDeliverySent,
  findDingTalkApprovalCardDeliveryById,
} from '../../src/integrations/dingtalk/approval-card-deliveries'
import {
  sweepDingTalkApprovalCardDeliveryRetention,
  sweepDingTalkCardPersonDeliveryRetention,
  resolveDingTalkDeliveryRetentionConfig,
} from '../../src/services/dingtalk-card-person-delivery-retention'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const REQUESTER = `u_ret_req_${TS}`
const APPROVER = `u_ret_appr_${TS}`
const SECRET = 'retention-actionability-secret'

const q = (sqlText: string, params?: unknown[]) => poolManager.get().query(sqlText, params)
const qf = (sqlText: string, params?: unknown[]) => q(sqlText, params)

function tokenFor(deliveryId: string): string {
  return createHmac('sha256', SECRET).update(deliveryId).digest('hex').slice(0, 32)
}

let approvals: ApprovalProductService
let templateId = ''

async function newInstance(): Promise<string> {
  const dto = await approvals.createApproval(
    { templateId, formData: { summary: 'retention actionability' } },
    { userId: REQUESTER, userName: REQUESTER },
  )
  return (dto as { id: string }).id
}

/** The live entry_epoch of the node's still-active seat — the round a card binds to (#4112). */
async function activeEpoch(instanceId: string, nodeKey: string): Promise<number | null> {
  const r = await q(
    `SELECT entry_epoch FROM approval_assignments
      WHERE instance_id = $1 AND node_key = $2 AND assignee_id = $3 AND is_active = TRUE
      ORDER BY created_at DESC LIMIT 1`,
    [instanceId, nodeKey, APPROVER],
  )
  const raw = (r.rows[0] as { entry_epoch: number | string | null } | undefined)?.entry_epoch
  return raw === null || raw === undefined ? null : Number(raw)
}

/** A card that is GENUINELY actionable right now: sent + epoch bound to the LIVE active seat. */
async function newActionableCard(instanceId: string): Promise<string> {
  const epoch = await activeEpoch(instanceId, 'approval_1')
  expect(epoch).not.toBeNull()
  const row = await insertDingTalkApprovalCardDelivery(q, {
    instanceId,
    nodeKey: 'approval_1',
    recipientUserId: APPROVER,
    recipientDingTalkUserId: `dd_${APPROVER}`,
    deliveryKind: 'work_notice_action_card',
    entryEpoch: epoch,
  })
  await markDingTalkApprovalCardDeliverySent(q, row.id, `task_ret_${row.id}`)
  return row.id
}

async function ageCard(id: string, daysAgo: number): Promise<void> {
  await q(
    `UPDATE dingtalk_approval_card_deliveries SET created_at = now() - ($2::int * interval '1 day') WHERE id = $1`,
    [id, daysAgo],
  )
}

async function decisionRecordCount(instanceId: string): Promise<number> {
  const r = await q(
    `SELECT COUNT(*)::int AS c FROM approval_records WHERE instance_id = $1 AND action IN ('approve','reject')`,
    [instanceId],
  )
  return (r.rows[0] as { c: number }).c
}

const actor = { userId: APPROVER, userName: APPROVER }

describeIfDatabase('DingTalk card retention sweep — actionability invariant (real DB)', () => {
  beforeAll(async () => {
    process.env.APPROVAL_CARD_LINK_SECRET = SECRET
    await q(`INSERT INTO permissions (code, name, description) VALUES ('approvals:read','r','t'),('approvals:write','w','t'),('approvals:act','a','t') ON CONFLICT (code) DO NOTHING`)
    for (const uid of [REQUESTER, APPROVER]) {
      await q(`INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
               VALUES ($1,$2,$1,'x','user','[]'::jsonb,TRUE,FALSE) ON CONFLICT (id) DO UPDATE SET is_active = TRUE`, [uid, `${uid}@ret.test`])
    }
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,'approvals:write') ON CONFLICT DO NOTHING`, [REQUESTER])
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,'approvals:act') ON CONFLICT DO NOTHING`, [APPROVER])

    approvals = new ApprovalProductService()
    const template = await approvals.createTemplate({
      key: `ret-act-${TS}`,
      name: 'Retention Actionability Template',
      formSchema: { fields: [{ id: 'summary', type: 'text', label: 'Summary', required: true }] },
      approvalGraph: {
        nodes: [
          { key: 'start', type: 'start', name: 'Start', config: {} },
          { key: 'approval_1', type: 'approval', name: 'First', config: { mode: 'any', assigneeSources: [{ kind: 'static_user', userIds: [APPROVER] }] } },
          { key: 'end', type: 'end', name: 'End', config: {} },
        ],
        edges: [
          { key: 'edge-start-approval_1', source: 'start', target: 'approval_1' },
          { key: 'edge-approval_1-end', source: 'approval_1', target: 'end' },
        ],
      },
    } as never)
    templateId = (template as { id: string }).id
    await approvals.publishTemplate(templateId, { policy: { allowRevoke: true, rejectCommentRequired: false } } as never)
  })

  afterAll(async () => {
    const instances = await q('SELECT id FROM approval_instances WHERE template_id = $1', [templateId]).catch(() => ({ rows: [] as unknown[] }))
    for (const row of instances.rows as Array<{ id: string }>) {
      await q('DELETE FROM dingtalk_approval_card_deliveries WHERE instance_id = $1', [row.id]).catch(() => {})
      await q('DELETE FROM approval_assignments WHERE instance_id = $1', [row.id]).catch(() => {})
      await q('DELETE FROM approval_records WHERE instance_id = $1', [row.id]).catch(() => {})
      await q('DELETE FROM approval_instances WHERE id = $1', [row.id]).catch(() => {})
    }
    await q('DELETE FROM approval_templates WHERE id = $1', [templateId]).catch(() => {})
    await q('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[REQUESTER, APPROVER]]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[REQUESTER, APPROVER]]).catch(() => {})
  })

  test('CONTROL: an UNSWEPT past-window sent card w/ a live seat IS actionable and DOES approve', async () => {
    const instanceId = await newInstance()
    const cardId = await newActionableCard(instanceId)
    await ageCard(cardId, 31) // past the window — but we do NOT sweep

    const summary = await getApprovalCardDeliverySummary({ query: qf }, {
      deliveryId: cardId, token: tokenFor(cardId), viewerUserId: APPROVER,
    })
    expect(summary.status).toBe('ok')
    expect((summary as { summary: { actionable: boolean } }).summary.actionable).toBe(true)

    const outcome = await executeApprovalActionFromCardDelivery({ query: qf, approvals }, {
      deliveryId: cardId, token: tokenFor(cardId), decision: 'approve', actor,
    })
    expect(outcome.status).toBe('ok')
    expect(await decisionRecordCount(instanceId)).toBe(1)
  })

  test('SECURITY: a SWEPT (expired) card whose seat is STILL LIVE is NOT actionable on either production surface — ZERO approval records', async () => {
    const instanceId = await newInstance()
    const cardId = await newActionableCard(instanceId)
    await ageCard(cardId, 31)

    const expired = await sweepDingTalkApprovalCardDeliveryRetention(qf, { retentionDays: 30, disabled: false })
    expect(expired).toBe(1)
    expect((await findDingTalkApprovalCardDeliveryById(q, cardId))?.card_state).toBe('expired')

    // The state this sweep newly creates: seat STILL live, epoch STILL matching, instance STILL pending.
    // card_state is the SOLE remaining guard here — that is exactly what this test pins.
    const seat = await q(
      `SELECT entry_epoch FROM approval_assignments WHERE instance_id=$1 AND node_key='approval_1' AND assignee_id=$2 AND is_active=TRUE`,
      [instanceId, APPROVER],
    )
    expect(seat.rows.length).toBe(1)
    const del = await findDingTalkApprovalCardDeliveryById(q, cardId)
    expect(Number(del?.entry_epoch)).toBe(Number((seat.rows[0] as { entry_epoch: number }).entry_epoch))
    const inst = await q(`SELECT status FROM approval_instances WHERE id=$1`, [instanceId])
    expect((inst.rows[0] as { status: string }).status).toBe('pending')

    // READ surface
    const summary = await getApprovalCardDeliverySummary({ query: qf }, {
      deliveryId: cardId, token: tokenFor(cardId), viewerUserId: APPROVER,
    })
    expect(summary.status).toBe('ok')
    expect((summary as { summary: { actionable: boolean } }).summary.actionable).toBe(false)

    // EXECUTION surface — the sole path used by BOTH the Slice-A route and the Slice-B stream callback
    const outcome = await executeApprovalActionFromCardDelivery({ query: qf, approvals }, {
      deliveryId: cardId, token: tokenFor(cardId), decision: 'approve', actor,
    })
    expect(outcome.status).toBe('stale')
    expect(await decisionRecordCount(instanceId)).toBe(0)
    expect((await findDingTalkApprovalCardDeliveryById(q, cardId))?.card_state).toBe('expired')
  })

  test('BLAST: the sweep mutates ONLY card_state (+updated_at) — every binding/provenance column is immutable, approval_* untouched', async () => {
    const instanceId = await newInstance()
    const cardId = await newActionableCard(instanceId)
    await ageCard(cardId, 31)

    const cols = `id, instance_id, node_key, recipient_user_id, recipient_dingtalk_user_id, delivery_kind,
                  task_id, integration_id, entry_epoch, card_state, acted_action, acted_by, acted_at,
                  send_status, send_error, created_at`
    const before = await q(`SELECT ${cols} FROM dingtalk_approval_card_deliveries WHERE id = $1`, [cardId])
    const asgBefore = await q(`SELECT id, is_active, entry_epoch, node_key, assignee_id FROM approval_assignments WHERE instance_id=$1 ORDER BY id`, [instanceId])
    const instBefore = await q(`SELECT status, current_node_key, version FROM approval_instances WHERE id=$1`, [instanceId])

    await sweepDingTalkCardPersonDeliveryRetention(qf, { retentionDays: 30, disabled: false })

    const after = await q(`SELECT ${cols} FROM dingtalk_approval_card_deliveries WHERE id = $1`, [cardId])
    const asgAfter = await q(`SELECT id, is_active, entry_epoch, node_key, assignee_id FROM approval_assignments WHERE instance_id=$1 ORDER BY id`, [instanceId])
    const instAfter = await q(`SELECT status, current_node_key, version FROM approval_instances WHERE id=$1`, [instanceId])

    const b = before.rows[0] as Record<string, unknown>
    const a = after.rows[0] as Record<string, unknown>
    for (const col of Object.keys(b)) {
      if (col === 'card_state') continue
      expect({ col, v: a[col] }).toEqual({ col, v: b[col] }) // binding + provenance immutable
    }
    expect(b.card_state).toBe('sent')
    expect(a.card_state).toBe('expired')
    expect(asgAfter.rows).toEqual(asgBefore.rows)
    expect(instAfter.rows).toEqual(instBefore.rows)
  })

  test('DEFAULT-OFF: unset/invalid/zero/negative/non-numeric DAYS never sweeps — a past-window card sits untouched', async () => {
    const instanceId = await newInstance()
    const cardId = await newActionableCard(instanceId)
    await ageCard(cardId, 400)

    const cfg = resolveDingTalkDeliveryRetentionConfig({} as NodeJS.ProcessEnv)
    expect(cfg.disabled).toBe(true)
    expect(await sweepDingTalkCardPersonDeliveryRetention(qf, cfg)).toEqual({ personDeleted: 0, cardExpired: 0 })

    for (const bad of ['0', '-5', 'abc', '', 'NaN', '1e999x']) {
      const c = resolveDingTalkDeliveryRetentionConfig({ DINGTALK_DELIVERY_RETENTION_DAYS: bad } as NodeJS.ProcessEnv)
      expect({ bad, disabled: c.disabled }).toEqual({ bad, disabled: true }) // never falls back to a default window
      expect({ bad, r: await sweepDingTalkCardPersonDeliveryRetention(qf, c) })
        .toEqual({ bad, r: { personDeleted: 0, cardExpired: 0 } })
    }

    const killed = resolveDingTalkDeliveryRetentionConfig({
      DINGTALK_DELIVERY_RETENTION_DAYS: '30', DINGTALK_DELIVERY_RETENTION_DISABLED: '1',
    } as NodeJS.ProcessEnv)
    expect(killed.disabled).toBe(true)
    expect(await sweepDingTalkCardPersonDeliveryRetention(qf, killed)).toEqual({ personDeleted: 0, cardExpired: 0 })

    expect((await findDingTalkApprovalCardDeliveryById(q, cardId))?.card_state).toBe('sent')
  })

  test('an ACTED card past the window is never swept (dacd_acted_consistency safety) and keeps its provenance', async () => {
    const instanceId = await newInstance()
    const cardId = await newActionableCard(instanceId)
    const outcome = await executeApprovalActionFromCardDelivery({ query: qf, approvals }, {
      deliveryId: cardId, token: tokenFor(cardId), decision: 'approve', actor,
    })
    expect(outcome.status).toBe('ok')
    await ageCard(cardId, 999)

    await expect(sweepDingTalkApprovalCardDeliveryRetention(qf, { retentionDays: 30, disabled: false }))
      .resolves.toBeGreaterThanOrEqual(0)
    const row = await findDingTalkApprovalCardDeliveryById(q, cardId)
    expect(row?.card_state).toBe('acted')
    expect(row?.acted_by).toBe(APPROVER)
  })
})
