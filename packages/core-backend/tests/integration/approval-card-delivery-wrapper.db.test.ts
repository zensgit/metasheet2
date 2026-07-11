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
  markDingTalkApprovalCardDeliverySendFailed,
  markDingTalkApprovalCardDeliverySendOutcomeUnknown,
  markDingTalkApprovalCardDeliverySent,
} from '../../src/integrations/dingtalk/approval-card-deliveries'
import { normalizeStoredSecretValue } from '../../src/security/encrypted-secrets'
import {
  generateApprovalCardLinkSecret,
  resolveApprovalCardLinkSecret,
} from '../../src/integrations/dingtalk/approval-card-config'
import { updateDirectoryIntegration } from '../../src/directory/directory-sync'
import { createHmac } from 'crypto'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const CREATOR = `u_cdw_creator_${TS}`
const REQUESTER = `u_cdw_req_${TS}`
const APPROVER = `u_cdw_appr_${TS}`

const q = (sqlText: string, params?: unknown[]) => poolManager.get().query(sqlText, params)

let approvals: ApprovalProductService
let templateId = ''
// P1-1: a linear TWO-approval-node template (node1 → node2, SAME assignee) — the shape the
// stale-card node-binding fix is proven against (a card issued for node1 must not approve node2).
let twoNodeTemplateId = ''
const SECRET = 'cdw-test-secret'

function tokenFor(deliveryId: string): string {
  return createHmac('sha256', SECRET).update(deliveryId).digest('hex').slice(0, 32)
}

async function newInstance(tid: string = templateId): Promise<string> {
  const dto = await approvals.createApproval(
    { templateId: tid, formData: { summary: 'wrapper test' } },
    { userId: REQUESTER, userName: REQUESTER },
  )
  return (dto as { id: string }).id
}

async function newSentDelivery(
  instanceId: string,
  opts: { nodeKey?: string; entryEpoch?: number | null } = {},
): Promise<string> {
  const nodeKey = opts.nodeKey ?? 'approval_1'
  // P1-1 STRICT epoch: an actionable card MUST carry the round's non-null epoch (the real send path
  // now persists it). Default to the live seat's epoch so a plain newSentDelivery is actionable, and
  // let callers pass an explicit epoch (or null) to exercise the stale/legacy paths.
  const entryEpoch = opts.entryEpoch === undefined ? await activeEpoch(instanceId, nodeKey) : opts.entryEpoch
  const row = await insertDingTalkApprovalCardDelivery(q, {
    instanceId,
    nodeKey,
    recipientUserId: APPROVER,
    recipientDingTalkUserId: `dd_${APPROVER}`,
    deliveryKind: 'work_notice_action_card',
    entryEpoch,
  })
  await markDingTalkApprovalCardDeliverySent(q, row.id, 'task_cdw')
  return row.id
}

/** The live entry_epoch of the node's still-active assignment for APPROVER (the round a card binds to). */
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

    // P1-1 two-node linear template: node1 → node2, SAME approver on both nodes.
    const twoNode = await approvals.createTemplate({
      key: `cdw2-${TS}`,
      name: 'Card Wrapper Two-Node Template',
      formSchema: { fields: [{ id: 'summary', type: 'text', label: 'Summary', required: true }] },
      approvalGraph: {
        nodes: [
          { key: 'start', type: 'start', name: 'Start', config: {} },
          { key: 'approval_1', type: 'approval', name: 'First', config: { mode: 'any', assigneeSources: [{ kind: 'static_user', userIds: [APPROVER] }] } },
          { key: 'approval_2', type: 'approval', name: 'Second', config: { mode: 'any', assigneeSources: [{ kind: 'static_user', userIds: [APPROVER] }] } },
          { key: 'end', type: 'end', name: 'End', config: {} },
        ],
        edges: [
          { key: 'edge-start-approval_1', source: 'start', target: 'approval_1' },
          { key: 'edge-approval_1-approval_2', source: 'approval_1', target: 'approval_2' },
          { key: 'edge-approval_2-end', source: 'approval_2', target: 'end' },
        ],
      },
    } as never)
    twoNodeTemplateId = (twoNode as { id: string }).id
    await approvals.publishTemplate(twoNodeTemplateId, { policy: { allowRevoke: true } } as never)
  })

  afterAll(async () => {
    const instances = await q('SELECT id FROM approval_instances WHERE template_id = ANY($1::text[])', [[templateId, twoNodeTemplateId]]).catch(() => ({ rows: [] as unknown[] }))
    for (const row of instances.rows as Array<{ id: string }>) {
      await q('DELETE FROM dingtalk_approval_card_deliveries WHERE instance_id = $1', [row.id]).catch(() => {})
      await q('DELETE FROM approval_assignments WHERE instance_id = $1', [row.id]).catch(() => {})
      await q('DELETE FROM approval_records WHERE instance_id = $1', [row.id]).catch(() => {})
      await q('DELETE FROM approval_instances WHERE id = $1', [row.id]).catch(() => {})
    }
    await q('DELETE FROM approval_templates WHERE id = ANY($1::text[])', [[templateId, twoNodeTemplateId]]).catch(() => {})
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

  test('CFG-2 closed loop: generate → resolver → sign → wrapper verifies; generic integration save does NOT wipe the secret', async () => {
    const instanceId = await newInstance()
    const deliveryId = await newSentDelivery(instanceId)
    const prev = process.env.APPROVAL_CARD_LINK_SECRET
    delete process.env.APPROVAL_CARD_LINK_SECRET
    const fixtureName = `cdw-cfg2-${TS}`
    const inserted = await q(
      `INSERT INTO directory_integrations (name, provider, status, corp_id, config, updated_at)
       VALUES ($1, 'dingtalk', 'active', $2, $3::jsonb, now())
       RETURNING id`,
      [fixtureName, `corp_cfg2_${TS}`, JSON.stringify({ appKey: 'cfg2-key', appSecret: normalizeStoredSecretValue('cfg2-secret') })],
    )
    const integrationId = (inserted.rows[0] as { id: string }).id
    try {
      // Generate server-side: response carries presence only, never the value.
      const status = await generateApprovalCardLinkSecret(integrationId, q)
      expect(status?.linkSecret).toMatchObject({ configured: true, source: 'stored', valuePrinted: false })
      expect(JSON.stringify(status)).not.toMatch(/[0-9a-f]{64}/)

      // Same-source closed loop: what the resolver yields signs a token the wrapper verifies.
      const secret = await resolveApprovalCardLinkSecret(q)
      expect(secret).toMatch(/^[0-9a-f]{64}$/)
      const token = createHmac('sha256', secret).update(deliveryId).digest('hex').slice(0, 32)
      expect(await verifyApprovalCardLinkToken(deliveryId, token, q)).toBe(true)
      expect((await getApprovalCardDeliverySummary({ query: q }, { deliveryId, token, viewerUserId: APPROVER })).status).toBe('ok')

      // WIPE REGRESSION (carry-through proof): the generic integration-form save rebuilds the
      // config JSONB from a whitelist — without carry-through it would silently drop the secret
      // and every in-flight card link would die. RED-before: remove the carry-through in
      // updateDirectoryIntegration and this assertion fails.
      const updatedSummary = await updateDirectoryIntegration(integrationId, {
        name: fixtureName,
        corpId: `corp_cfg2_${TS}`,
        appKey: 'cfg2-key',
      } as never)
      expect(updatedSummary?.config.approvalCardLinkSecretConfigured).toBe(true)
      expect(await resolveApprovalCardLinkSecret(q)).toBe(secret)
      expect(await verifyApprovalCardLinkToken(deliveryId, token, q)).toBe(true)
    } finally {
      await q('DELETE FROM directory_integrations WHERE id = $1', [integrationId]).catch(() => {})
      if (prev === undefined) delete process.env.APPROVAL_CARD_LINK_SECRET
      else process.env.APPROVAL_CARD_LINK_SECRET = prev
    }
  })

  test('DT-R2 per-corp verify: a token signed under corp A fail-closes against a delivery pinned to corp B; the pinned corp verifies; env override still wins', async () => {
    const instanceId = await newInstance()
    const prev = process.env.APPROVAL_CARD_LINK_SECRET
    delete process.env.APPROVAL_CARD_LINK_SECRET
    const secretA = `cdw-r2-corp-a-secret-${TS}`
    const secretB = `cdw-r2-corp-b-secret-${TS}`
    const mkIntegration = async (label: string, secret: string, updatedAtSql: string): Promise<string> => {
      const inserted = await q(
        `INSERT INTO directory_integrations (name, provider, status, corp_id, config, updated_at)
         VALUES ($1, 'dingtalk', 'active', $2, $3::jsonb, ${updatedAtSql})
         RETURNING id`,
        [`cdw-r2-${label}-${TS}`, `corp_cdw_r2_${label}_${TS}`, JSON.stringify({ approvalCardLinkSecret: normalizeStoredSecretValue(secret) })],
      )
      return (inserted.rows[0] as { id: string }).id
    }
    // Anti-shadowing: corp A is deliberately the FRESHEST integration, so the legacy LIMIT-1
    // global pick (active-first, updated_at DESC) lands on corp A — if verify ever fell back to
    // that pick instead of the DELIVERY row's pinned corp B, corp A's token would verify and
    // corp B's would fail, turning every assertion below red. now()-1min on corp B keeps both
    // rows behind any real integration if a crash skips the finally.
    const corpA = await mkIntegration('a', secretA, `now()`)
    const corpB = await mkIntegration('b', secretB, `now() - interval '1 minute'`)
    try {
      const row = await insertDingTalkApprovalCardDelivery(q, {
        instanceId,
        nodeKey: 'approval_1',
        recipientUserId: APPROVER,
        recipientDingTalkUserId: `dd_${APPROVER}`,
        deliveryKind: 'work_notice_action_card',
        integrationId: corpB,
      })
      await markDingTalkApprovalCardDeliverySent(q, row.id, 'task_r2')
      expect(row.integration_id).toBe(corpB)

      const signWith = (secret: string) => createHmac('sha256', secret).update(row.id).digest('hex').slice(0, 32)

      // Fail-closed cross-corp: corp A's secret must never open a corp-B delivery.
      expect(await verifyApprovalCardLinkToken(row.id, signWith(secretA), q, corpB)).toBe(false)
      expect((await getApprovalCardDeliverySummary({ query: q }, { deliveryId: row.id, token: signWith(secretA), viewerUserId: APPROVER })).status).toBe('not_found')
      const crossCorpAction = await executeApprovalActionFromCardDelivery(
        { query: q, approvals },
        { deliveryId: row.id, token: signWith(secretA), decision: 'approve', comment: '越权', actor: approverActor },
      )
      expect(crossCorpAction.status).toBe('not_found')

      // Same-source: the DELIVERY row's own integration secret verifies through the real wrapper.
      expect(await verifyApprovalCardLinkToken(row.id, signWith(secretB), q, corpB)).toBe(true)
      expect((await getApprovalCardDeliverySummary({ query: q }, { deliveryId: row.id, token: signWith(secretB), viewerUserId: APPROVER })).status).toBe('ok')

      // Env override is global and unchanged: with env set, the env-signed token wins even on a pinned row.
      process.env.APPROVAL_CARD_LINK_SECRET = SECRET
      expect((await getApprovalCardDeliverySummary({ query: q }, { deliveryId: row.id, token: tokenFor(row.id), viewerUserId: APPROVER })).status).toBe('ok')
      delete process.env.APPROVAL_CARD_LINK_SECRET

      // A pinned integration with NO stored secret fail-closes (no LIMIT-1 fallback, no cross-corp rescue).
      await q(`UPDATE directory_integrations SET config = COALESCE(config, '{}'::jsonb) - 'approvalCardLinkSecret' WHERE id = $1`, [corpB])
      expect(await verifyApprovalCardLinkToken(row.id, signWith(secretB), q, corpB)).toBe(false)
      expect(await verifyApprovalCardLinkToken(row.id, signWith(secretA), q, corpB)).toBe(false)
    } finally {
      await q('DELETE FROM directory_integrations WHERE id = ANY($1::uuid[])', [[corpA, corpB]]).catch(() => {})
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

  test('PR #4046 Phase B: send_status=failed stays stale — the possibly-delivered widening is EXACTLY (sent, outcome_unknown), nothing else', async () => {
    const instanceId = await newInstance()
    const row = await insertDingTalkApprovalCardDelivery(q, {
      instanceId, nodeKey: 'approval_1', recipientUserId: APPROVER, recipientDingTalkUserId: `dd_${APPROVER}`, deliveryKind: 'work_notice_action_card',
    })
    await markDingTalkApprovalCardDeliverySendFailed(q, row.id, 'ding: definite rejection')
    const summary = await getApprovalCardDeliverySummary({ query: q }, { deliveryId: row.id, token: tokenFor(row.id), viewerUserId: APPROVER })
    expect(summary.status).toBe('ok')
    if (summary.status === 'ok') expect(summary.summary.actionable).toBe(false)
    const outcome = await executeApprovalActionFromCardDelivery(
      { query: q, approvals },
      { deliveryId: row.id, token: tokenFor(row.id), decision: 'approve', actor: approverActor },
    )
    expect(outcome.status).toBe('stale')
    // and the claim SQL is equally closed: the card was never claimed
    const card = await q(`SELECT card_state, send_status FROM dingtalk_approval_card_deliveries WHERE id = $1`, [row.id])
    expect(card.rows[0]).toMatchObject({ card_state: 'sent', send_status: 'failed' })
  })

  test('PR #4046 Phase B: outcome_unknown + valid HMAC token IS actionable — the token proves delivery; approve proceeds and claims the card', async () => {
    // A card whose send outcome the client could not observe MAY have been delivered — and a
    // valid deep-link token only ever existed inside the delivered card, so the callback is the
    // delivery proof. The ledger's send-time uncertainty must not make the card inoperable.
    const instanceId = await newInstance()
    const row = await insertDingTalkApprovalCardDelivery(q, {
      // P1-1 STRICT epoch: bind to the live round so actionability turns on send_status, not a null epoch.
      instanceId, nodeKey: 'approval_1', recipientUserId: APPROVER, recipientDingTalkUserId: `dd_${APPROVER}`, deliveryKind: 'work_notice_action_card',
      entryEpoch: await activeEpoch(instanceId, 'approval_1'),
    })
    await markDingTalkApprovalCardDeliverySendOutcomeUnknown(q, row.id, 'fetch failed (response lost)')

    const summary = await getApprovalCardDeliverySummary({ query: q }, { deliveryId: row.id, token: tokenFor(row.id), viewerUserId: APPROVER })
    expect(summary.status).toBe('ok')
    if (summary.status === 'ok') {
      expect(summary.summary.sendStatus).toBe('outcome_unknown')
      expect(summary.summary.actionable).toBe(true)
    }

    const outcome = await executeApprovalActionFromCardDelivery(
      { query: q, approvals },
      { deliveryId: row.id, token: tokenFor(row.id), decision: 'approve', comment: '同意', actor: approverActor },
    )
    expect(outcome.status).toBe('ok')
    if (outcome.status === 'ok') {
      expect(outcome.summary.cardState).toBe('acted')
      expect(outcome.summary.actedAction).toBe('approve')
      expect(outcome.summary.approval.status).toBe('approved')
      // the send-time record keeps its truth: uncertainty at send time is history, acted is the proof of delivery
      expect(outcome.summary.sendStatus).toBe('outcome_unknown')
    }

    // engine untouched beyond the one approve; channel attribution intact (guards NOT restructured)
    const record = await q(
      `SELECT metadata FROM approval_records WHERE instance_id = $1 AND action = 'approve' ORDER BY created_at DESC LIMIT 1`,
      [instanceId],
    )
    const metadata = (record.rows[0] as { metadata: Record<string, unknown> }).metadata
    expect(metadata.channel).toBe('dingtalk_card')
    expect(metadata.cardDeliveryId).toBe(row.id)

    // an INVALID token against the same outcome_unknown delivery is still not_found — HMAC stays the authority
    const forged = await executeApprovalActionFromCardDelivery(
      { query: q, approvals },
      { deliveryId: row.id, token: 'f'.repeat(32), decision: 'approve', actor: approverActor },
    )
    expect(forged.status).toBe('not_found')
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

  // ─── P1-1 stale-card node/epoch binding — RED-before goldens (real two-node state) ────────────
  //
  // The class this closes was missed by mock-only review: on origin/main a card issued for NODE 1,
  // after node 1 is approved and the instance advances to NODE 2 (where the recipient is ALSO the
  // assignee), returns `ok` and silently approves node 2 — the approver never saw node 2's context.
  // These construct REAL two-node / re-entry state and assert `stale` + zero cross-node writes.

  test('P1-1 TWO-NODE web-first: a node1 card is STALE after the instance advances to node2 (same assignee) — never approves node2', async () => {
    const instanceId = await newInstance(twoNodeTemplateId)
    // The card is issued for node1's round (persist its live epoch, exactly as the send path does).
    const node1Epoch = await activeEpoch(instanceId, 'approval_1')
    const deliveryId = await newSentDelivery(instanceId, { nodeKey: 'approval_1', entryEpoch: node1Epoch })

    // While node1 is still active the card IS actionable (baseline — the binding matches the live seat).
    const before = await getApprovalCardDeliverySummary({ query: q }, { deliveryId, token: tokenFor(deliveryId), viewerUserId: APPROVER })
    expect(before.status).toBe('ok')
    if (before.status === 'ok') expect(before.summary.actionable).toBe(true)

    // Approve node1 through the ENGINE (web-first) → the instance advances to node2, where APPROVER is
    // ALSO the active assignee. node1's assignment flips is_active=FALSE.
    await approvals.dispatchAction(instanceId, { action: 'approve', comment: '同意' }, { userId: APPROVER, userName: APPROVER, roles: [] })
    const advanced = await q('SELECT status, current_node_key FROM approval_instances WHERE id = $1', [instanceId])
    expect(advanced.rows[0]).toMatchObject({ status: 'pending', current_node_key: 'approval_2' })

    // Defense-in-depth: the post-commit supersede sweep flipped the still-sent node1 card to superseded.
    const swept = await q('SELECT card_state FROM dingtalk_approval_card_deliveries WHERE id = $1', [deliveryId])
    expect((swept.rows[0] as { card_state: string }).card_state).toBe('superseded')

    // ISOLATE THE BINDING (must stand alone even if supersede never runs): force the card back to
    // 'sent' so card_state cannot mask the read-time active-assignment binding. RED-before: with the
    // binding reverted this card is actionable and dispatchAction approves node2.
    await q(`UPDATE dingtalk_approval_card_deliveries SET card_state = 'sent' WHERE id = $1`, [deliveryId])
    const summary = await getApprovalCardDeliverySummary({ query: q }, { deliveryId, token: tokenFor(deliveryId), viewerUserId: APPROVER })
    expect(summary.status).toBe('ok')
    if (summary.status === 'ok') expect(summary.summary.actionable).toBe(false) // node1 seat is gone

    const outcome = await executeApprovalActionFromCardDelivery(
      { query: q, approvals },
      { deliveryId, token: tokenFor(deliveryId), decision: 'approve', comment: '同意', actor: approverActor },
    )
    expect(outcome.status).toBe('stale')

    // node2 was NEVER approved by the stale node1 card: instance still pending at node2, and there is
    // ZERO approve record carrying node2's key.
    const post = await q('SELECT status, current_node_key FROM approval_instances WHERE id = $1', [instanceId])
    expect(post.rows[0]).toMatchObject({ status: 'pending', current_node_key: 'approval_2' })
    const node2Approves = await q(
      `SELECT COUNT(*)::int AS c FROM approval_records WHERE instance_id = $1 AND action = 'approve' AND metadata->>'nodeKey' = 'approval_2'`,
      [instanceId],
    )
    expect((node2Approves.rows[0] as { c: number }).c).toBe(0)
  })

  test('P1-1 SAME-NODE re-entry: an old-epoch card is STALE after the same node re-activates with a fresh epoch (needs the persisted delivery epoch)', async () => {
    const instanceId = await newInstance()
    const e1 = await activeEpoch(instanceId, 'approval_1')
    expect(typeof e1).toBe('number')
    // Card carries the FIRST round's epoch.
    const deliveryId = await newSentDelivery(instanceId, { nodeKey: 'approval_1', entryEpoch: e1 })

    // Matching-epoch baseline: while round e1 is the live round, the card is actionable.
    const before = await getApprovalCardDeliverySummary({ query: q }, { deliveryId, token: tokenFor(deliveryId), viewerUserId: APPROVER })
    expect(before.status).toBe('ok')
    if (before.status === 'ok') expect(before.summary.actionable).toBe(true)

    // Model a loop-back that RE-ENTERS the SAME node_key on a FRESH epoch: deactivate the current
    // seat and mint a new active seat at approval_1 with epoch e1+1 (what a real return/jump does),
    // and advance the instance's activation sequence to match. node_key is unchanged; only the epoch is.
    const e2 = (e1 as number) + 1
    await q(`UPDATE approval_assignments SET is_active = FALSE, updated_at = now() WHERE instance_id = $1 AND node_key = 'approval_1' AND is_active = TRUE`, [instanceId])
    await q(
      `INSERT INTO approval_assignments (instance_id, assignment_type, assignee_id, source_step, node_key, is_active, entry_epoch, metadata, created_at, updated_at)
       VALUES ($1, 'user', $2, 1, 'approval_1', TRUE, $3, '{}'::jsonb, now(), now())`,
      [instanceId, APPROVER, e2],
    )
    await q(`UPDATE approval_instances SET node_activation_seq = $2, updated_at = now() WHERE id = $1`, [instanceId, e2])

    // The old-epoch card (e1) no longer matches the live seat (e2) → stale. RED-before: with the
    // epoch clause reverted the card is actionable and approves the NEW round it never belonged to.
    const summary = await getApprovalCardDeliverySummary({ query: q }, { deliveryId, token: tokenFor(deliveryId), viewerUserId: APPROVER })
    expect(summary.status).toBe('ok')
    if (summary.status === 'ok') expect(summary.summary.actionable).toBe(false)

    const outcome = await executeApprovalActionFromCardDelivery(
      { query: q, approvals },
      { deliveryId, token: tokenFor(deliveryId), decision: 'approve', comment: '同意', actor: approverActor },
    )
    expect(outcome.status).toBe('stale')
    // No approve record was written for this instance (the stale card never reached the engine).
    const approves = await q(`SELECT COUNT(*)::int AS c FROM approval_records WHERE instance_id = $1 AND action = 'approve'`, [instanceId])
    expect((approves.rows[0] as { c: number }).c).toBe(0)
  })

  test('P1-1 POSITIVE (happy path unchanged): a node1 card whose persisted epoch matches the live active seat still approves node1', async () => {
    const instanceId = await newInstance()
    const e1 = await activeEpoch(instanceId, 'approval_1')
    const deliveryId = await newSentDelivery(instanceId, { nodeKey: 'approval_1', entryEpoch: e1 })

    const summary = await getApprovalCardDeliverySummary({ query: q }, { deliveryId, token: tokenFor(deliveryId), viewerUserId: APPROVER })
    expect(summary.status).toBe('ok')
    if (summary.status === 'ok') expect(summary.summary.actionable).toBe(true)

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
  })
})
