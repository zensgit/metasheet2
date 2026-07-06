/**
 * A-4 core wrapper — real-DB integration (one-tap lock #3594 §4).
 *
 * Locks the owner matrix for the card-delivery decision path:
 * ledger-only resolution (bad token/unknown id → not_found, no existence oracle) · undelivered
 * (send_status='pending') card → stale · approve funnels through dispatchAction with SERVER-side
 * channelOrigin (approval_records.metadata.channel='dingtalk_card' + cardDeliveryId) and claims the
 * card acted · reject-comment-required surfaces as engine_rejected and the card STAYS claimable ·
 * a second approve on the acted card → stale with the real terminal summary.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { randomUUID } from 'crypto'

import { poolManager } from '../../src/integration/db/connection-pool'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'
import {
  executeApprovalActionFromCardDelivery,
  getApprovalCardDeliverySummary,
  verifyApprovalCardLinkToken,
} from '../../src/services/ApprovalCardDeliveryAction'
import {
  insertDingTalkApprovalCardDelivery,
  markDingTalkApprovalCardDeliverySent,
} from '../../src/integrations/dingtalk/approval-card-deliveries'
import { normalizeStoredSecretValue } from '../../src/security/encrypted-secrets'
import { createHmac } from 'crypto'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const CREATOR = `u_cdw_creator_${TS}`
const REQUESTER = `u_cdw_req_${TS}`
const APPROVER = `u_cdw_appr_${TS}`

const q = (sqlText: string, params?: unknown[]) => poolManager.get().query(sqlText, params)

let approvals: ApprovalProductService
let templateId = ''
const SECRET = 'cdw-test-secret'

function tokenFor(deliveryId: string): string {
  return createHmac('sha256', SECRET).update(deliveryId).digest('hex').slice(0, 32)
}

async function newInstance(): Promise<string> {
  const dto = await approvals.createApproval(
    { templateId, formData: { summary: 'wrapper test' } },
    { userId: REQUESTER, userName: REQUESTER },
  )
  return (dto as { id: string }).id
}

async function newSentDelivery(instanceId: string): Promise<string> {
  const row = await insertDingTalkApprovalCardDelivery(q, {
    instanceId,
    nodeKey: 'approval_1',
    recipientUserId: APPROVER,
    recipientDingTalkUserId: `dd_${APPROVER}`,
    deliveryKind: 'work_notice_action_card',
  })
  await markDingTalkApprovalCardDeliverySent(q, row.id, 'task_cdw')
  return row.id
}

const approverActor = { userId: '', userName: '' }

describeIfDatabase('A-4 card-delivery wrapper (real DB)', () => {
  let savedSecret: string | undefined
  beforeAll(async () => {
    savedSecret = process.env.APPROVAL_CARD_LINK_SECRET
    process.env.APPROVAL_CARD_LINK_SECRET = SECRET
    approverActor.userId = APPROVER
    approverActor.userName = APPROVER

    await q(`INSERT INTO permissions (code, name, description) VALUES ('approvals:read','r','t'),('approvals:write','w','t'),('approvals:act','a','t') ON CONFLICT (code) DO NOTHING`)
    for (const uid of [CREATOR, REQUESTER, APPROVER]) {
      await q(`INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
               VALUES ($1,$2,$1,'x','user','[]'::jsonb,TRUE,FALSE) ON CONFLICT (id) DO UPDATE SET is_active = TRUE`, [uid, `${uid}@cdw.test`])
    }
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,'approvals:write') ON CONFLICT DO NOTHING`, [REQUESTER])
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,'approvals:act') ON CONFLICT DO NOTHING`, [APPROVER])

    approvals = new ApprovalProductService()
    const template = await approvals.createTemplate({
      key: `cdw-${TS}`,
      name: 'Card Wrapper Template',
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
    await approvals.publishTemplate(templateId, { policy: { allowRevoke: true } } as never)
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
    await q('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[CREATOR, REQUESTER, APPROVER]]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[CREATOR, REQUESTER, APPROVER]]).catch(() => {})
    if (savedSecret === undefined) delete process.env.APPROVAL_CARD_LINK_SECRET
    else process.env.APPROVAL_CARD_LINK_SECRET = savedSecret
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('token discipline: bad token / unknown id / missing secret are all not_found (no existence oracle)', async () => {
    const instanceId = await newInstance()
    const deliveryId = await newSentDelivery(instanceId)

    expect(await verifyApprovalCardLinkToken(deliveryId, tokenFor(deliveryId))).toBe(true)
    expect(await verifyApprovalCardLinkToken(deliveryId, 'f'.repeat(32))).toBe(false)

    expect((await getApprovalCardDeliverySummary({ query: q }, { deliveryId, token: 'f'.repeat(32), viewerUserId: APPROVER })).status).toBe('not_found')
    const ghost = randomUUID()
    expect((await getApprovalCardDeliverySummary({ query: q }, { deliveryId: ghost, token: tokenFor(ghost), viewerUserId: APPROVER })).status).toBe('not_found')

    const prev = process.env.APPROVAL_CARD_LINK_SECRET
    delete process.env.APPROVAL_CARD_LINK_SECRET
    try {
      expect((await getApprovalCardDeliverySummary({ query: q }, { deliveryId, token: tokenFor(deliveryId), viewerUserId: APPROVER })).status).toBe('not_found')
    } finally {
      process.env.APPROVAL_CARD_LINK_SECRET = prev
    }
  })

  test('CFG-1 stored-secret fallback: env unset → wrapper verifies a token signed with the stored (encrypted) secret', async () => {
    const instanceId = await newInstance()
    const deliveryId = await newSentDelivery(instanceId)
    const storedSecret = `cdw-stored-secret-${TS}`
    const prev = process.env.APPROVAL_CARD_LINK_SECRET
    delete process.env.APPROVAL_CARD_LINK_SECRET
    // Freshest updated_at (now()) so the resolver's "active first, most recent" pick lands on this
    // row in the shared plugin-tests database; removed in finally (shared-DB fixture discipline).
    // Deliberately NOT far-future: if a crash ever skips the finally, a now() row cannot
    // permanently shadow later-updated real integrations.
    const inserted = await q(
      `INSERT INTO directory_integrations (name, provider, status, corp_id, config, updated_at)
       VALUES ($1, 'dingtalk', 'active', $2, $3::jsonb, now())
       RETURNING id`,
      [`cdw-card-config-${TS}`, `corp_cdw_${TS}`, JSON.stringify({ approvalCardLinkSecret: normalizeStoredSecretValue(storedSecret) })],
    )
    const integrationId = (inserted.rows[0] as { id: string }).id
    try {
      const storedToken = createHmac('sha256', storedSecret).update(deliveryId).digest('hex').slice(0, 32)
      // Same-source invariant at the DB level: sign with the stored secret, verify through the wrapper.
      expect(await verifyApprovalCardLinkToken(deliveryId, storedToken, q)).toBe(true)
      expect((await getApprovalCardDeliverySummary({ query: q }, { deliveryId, token: storedToken, viewerUserId: APPROVER })).status).toBe('ok')
      // The env-signed token no longer matches — stored source is authoritative when env is unset.
      expect(await verifyApprovalCardLinkToken(deliveryId, tokenFor(deliveryId), q)).toBe(false)
    } finally {
      await q('DELETE FROM directory_integrations WHERE id = $1', [integrationId]).catch(() => {})
      if (prev === undefined) delete process.env.APPROVAL_CARD_LINK_SECRET
      else process.env.APPROVAL_CARD_LINK_SECRET = prev
    }
  })

  test('undelivered card (send_status=pending) is stale — never actionable', async () => {
    const instanceId = await newInstance()
    const row = await insertDingTalkApprovalCardDelivery(q, {
      instanceId, nodeKey: 'approval_1', recipientUserId: APPROVER, recipientDingTalkUserId: `dd_${APPROVER}`, deliveryKind: 'work_notice_action_card',
    })
    const outcome = await executeApprovalActionFromCardDelivery(
      { query: q, approvals },
      { deliveryId: row.id, token: tokenFor(row.id), decision: 'approve', actor: approverActor },
    )
    expect(outcome.status).toBe('stale')
  })

  test('approve: engine gates apply, channel attribution lands on approval_records, card claims acted', async () => {
    const instanceId = await newInstance()
    const deliveryId = await newSentDelivery(instanceId)

    const summary = await getApprovalCardDeliverySummary({ query: q }, { deliveryId, token: tokenFor(deliveryId), viewerUserId: APPROVER })
    expect(summary.status).toBe('ok')
    if (summary.status === 'ok') {
      expect(summary.summary.actionable).toBe(true)
      expect(summary.summary.viewerIsRecipient).toBe(true)
      expect(summary.summary.approval.rejectCommentRequired).toBe(true)
    }

    const outcome = await executeApprovalActionFromCardDelivery(
      { query: q, approvals },
      { deliveryId, token: tokenFor(deliveryId), decision: 'approve', comment: '同意', actor: approverActor },
    )
    expect(outcome.status).toBe('ok')
    if (outcome.status === 'ok') {
      expect(outcome.summary.cardState).toBe('acted')
      expect(outcome.summary.actedAction).toBe('approve')
      expect(outcome.summary.approval.status).toBe('approved')
    }

    const record = await q(
      `SELECT metadata FROM approval_records WHERE instance_id = $1 AND action = 'approve' ORDER BY created_at DESC LIMIT 1`,
      [instanceId],
    )
    const metadata = (record.rows[0] as { metadata: Record<string, unknown> }).metadata
    expect(metadata.channel).toBe('dingtalk_card')
    expect(metadata.cardDeliveryId).toBe(deliveryId)

    // duplicate tap after the terminal state → stale with the REAL summary, engine untouched
    const dup = await executeApprovalActionFromCardDelivery(
      { query: q, approvals },
      { deliveryId, token: tokenFor(deliveryId), decision: 'approve', actor: approverActor },
    )
    expect(dup.status).toBe('stale')
    if (dup.status === 'stale') expect(dup.summary.cardState).toBe('acted')
  })

  test('reject without a comment: engine_rejected (comment required), card STAYS actionable', async () => {
    const instanceId = await newInstance()
    const deliveryId = await newSentDelivery(instanceId)
    const outcome = await executeApprovalActionFromCardDelivery(
      { query: q, approvals },
      { deliveryId, token: tokenFor(deliveryId), decision: 'reject', actor: approverActor },
    )
    expect(outcome.status).toBe('engine_rejected')
    if (outcome.status === 'engine_rejected') {
      expect(outcome.httpStatus).toBeGreaterThanOrEqual(400)
      expect(outcome.summary.cardState).toBe('sent') // NOT claimed — retry with a comment succeeds
    }
    const retry = await executeApprovalActionFromCardDelivery(
      { query: q, approvals },
      { deliveryId, token: tokenFor(deliveryId), decision: 'reject', comment: '材料不全', actor: approverActor },
    )
    expect(retry.status).toBe('ok')
    if (retry.status === 'ok') {
      expect(retry.summary.actedAction).toBe('reject')
      expect(retry.summary.approval.status).toBe('rejected')
    }
  })

  test('CONCURRENCY tripwire: two simultaneous approves — exactly one engine action, one claim, loser gets the real terminal state', async () => {
    // The wrapper is dispatch-THEN-claim, so in a true concurrent window BOTH requests can enter
    // the engine — the engine's own gates (FOR UPDATE + status/version) must reduce them to one.
    // A sequential duplicate-tap test cannot prove this; Promise.all does.
    const instanceId = await newInstance()
    const deliveryId = await newSentDelivery(instanceId)

    const [first, second] = await Promise.all([
      executeApprovalActionFromCardDelivery(
        { query: q, approvals },
        { deliveryId, token: tokenFor(deliveryId), decision: 'approve', comment: '并发A', actor: approverActor },
      ),
      executeApprovalActionFromCardDelivery(
        { query: q, approvals },
        { deliveryId, token: tokenFor(deliveryId), decision: 'approve', comment: '并发B', actor: approverActor },
      ),
    ])
    const outcomes = [first, second]
    const winners = outcomes.filter((o) => o.status === 'ok')
    expect(winners).toHaveLength(1)
    // the loser is engine_rejected (raced into the engine) or stale (arrived after the claim) —
    // either way it carries the REAL terminal summary, never a dead form
    const loser = outcomes.find((o) => o.status !== 'ok')!
    expect(['engine_rejected', 'stale']).toContain(loser.status)
    if (loser.status === 'engine_rejected' || loser.status === 'stale') {
      expect(loser.summary.approval.status).toBe('approved')
    }

    // exactly ONE engine approve record, exactly ONE channel attribution
    const records = await q(
      `SELECT metadata FROM approval_records WHERE instance_id = $1 AND action = 'approve'`,
      [instanceId],
    )
    expect(records.rows).toHaveLength(1)
    const channelRecords = (records.rows as Array<{ metadata: Record<string, unknown> }>)
      .filter((r) => r.metadata?.channel === 'dingtalk_card')
    expect(channelRecords).toHaveLength(1)

    // exactly ONE acted claim on the card
    const card = await q(`SELECT card_state, acted_by, acted_action FROM dingtalk_approval_card_deliveries WHERE id = $1`, [deliveryId])
    expect((card.rows[0] as { card_state: string }).card_state).toBe('acted')
    expect((card.rows[0] as { acted_action: string }).acted_action).toBe('approve')
  })

    test('non-assignee actor is rejected by the ENGINE (zero bypass), card stays claimable', async () => {
    const instanceId = await newInstance()
    const deliveryId = await newSentDelivery(instanceId)
    const outcome = await executeApprovalActionFromCardDelivery(
      { query: q, approvals },
      { deliveryId, token: tokenFor(deliveryId), decision: 'approve', actor: { userId: REQUESTER, userName: REQUESTER } },
    )
    expect(outcome.status).toBe('engine_rejected')
    if (outcome.status === 'engine_rejected') expect(outcome.summary.cardState).toBe('sent')
  })
})
