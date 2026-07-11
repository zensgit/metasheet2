/**
 * A-2b `send_dingtalk_approval_card` action — real-DB integration (one-tap lock #3594).
 *
 * Chain under test: approval.task_created rule + card action → ledger row written BEFORE the send
 * (the §3 anchor), action_card sent over an injected fetchFn (gettoken + asyncsend_v2 faked),
 * task_id recorded on success, send failures traceable (send_status/send_error), unbound recipients
 * recorded as `skipped` person-delivery telemetry with NO card row and NO guessed mapping, and the
 * deep link carrying ONLY deliveryId + HMAC token (values-free — never the instanceId).
 * Placement gate: the card action saves ONLY on approval.task_created (create + update).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { db } from '../../src/db/db'
import { eventBus as integrationEventBus } from '../../src/integration/events/event-bus'
import {
  DINGTALK_INTERACTIVE_CARD_CLIENT_ID_ENV,
  DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET_ENV,
  DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED_ENV,
  DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID_ENV,
  resolveDingTalkInteractiveCardStreamConfig,
} from '../../src/integrations/dingtalk/interactive-card-stream'
import { AutomationService } from '../../src/multitable/automation-service'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_card_${TS}`
const SHEET_ID = `sheet_card_${TS}`
const CREATOR = `u_card_creator_${TS}`
const REQUESTER = `u_card_req_${TS}`
const APPROVER = `u_card_appr_${TS}`
import { createHmac, randomUUID } from 'crypto'
import { normalizeStoredSecretValue } from '../../src/security/encrypted-secrets'
const DD_INTEGRATION = randomUUID()
const DD_ACCOUNT = randomUUID()
const DD_USER_ID = `dd_ext_${TS}`

const q = (sqlText: string, params?: unknown[]) => poolManager.get().query(sqlText, params)

// DT-HARDEN-06 fault injector: a one-shot flag that makes the NEXT `dingtalk_approval_card_deliveries`
// mark-failed write (the ledger UPDATE ... SET send_status = 'failed' issued from the executor's
// catch block) throw instead of hitting the real pool. Everything else passes through unchanged, so
// this is the fault-injection seam only — assertions read the persisted execution record, not this
// wrapper. `ledgerMarkFailedInjectorFired` proves the matcher actually fired (guards against the
// helper SQL shape drifting and the injector silently going quiet).
let failNextLedgerMarkFailed = false
let ledgerMarkFailedInjectorFired = false
const queryFn = (async (sqlText: string, params?: unknown[]) => {
  if (
    failNextLedgerMarkFailed &&
    sqlText.includes('dingtalk_approval_card_deliveries') &&
    sqlText.includes("send_status = 'failed'")
  ) {
    failNextLedgerMarkFailed = false
    ledgerMarkFailedInjectorFired = true
    throw new Error('simulated ledger outage')
  }
  return poolManager.get().query(sqlText, params)
}) as never

let svc: AutomationService
let approvals: ApprovalProductService
let templateId = ''
const ruleIds: string[] = []
const sentBodies: Array<Record<string, unknown>> = []
const interactiveBodies: Array<Record<string, unknown>> = []
let failNextSend = false
// PR #4046 Phase B: one-shot TRANSPORT-LEVEL failure — the asyncsend fetch REJECTS at network
// level, so the real client + transport seam (send tier: no resend) rethrows the error marked
// isDingTalkOutcomeUnknown. asyncsendCallCount proves the no-second-send-attempt property.
let failNextSendNetwork = false
let fetchCallCount = 0
let asyncsendCallCount = 0

const fakeFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  fetchCallCount += 1
  const url = String(input)
  if (url.includes('/gettoken')) {
    return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok', access_token: 'tok_test' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  if (url.includes('/topapi/message/corpconversation/asyncsend_v2')) {
    asyncsendCallCount += 1
    if (failNextSendNetwork) {
      failNextSendNetwork = false
      throw new TypeError('fetch failed')
    }
    if (failNextSend) {
      failNextSend = false
      return new Response(JSON.stringify({ errcode: 88, errmsg: 'ding: simulated send failure' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    sentBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok', task_id: 424242 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  if (url.includes('/v1.0/card/instances/createAndDeliver')) {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    interactiveBodies.push(body)
    return new Response(JSON.stringify({
      success: true,
      result: {
        outTrackId: body.outTrackId,
        deliverResults: [{
          spaceType: 'IM_ROBOT',
          spaceId: DD_USER_ID,
          success: true,
          carrierId: 'interactive-task-4242',
        }],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  throw new Error(`unexpected fetch ${url}`)
}) as typeof fetch

function cardTemplateRequest() {
  return {
    key: `card-${TS}`,
    name: 'Approval Card Action Template',
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
  }
}

async function cardRows(instanceId: string) {
  const r = await q('SELECT * FROM dingtalk_approval_card_deliveries WHERE instance_id = $1 ORDER BY created_at', [instanceId])
  return r.rows as Array<Record<string, unknown>>
}

async function waitFor<T>(fn: () => Promise<T[]>, timeoutMs = 6000): Promise<T[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const rows = await fn()
    if (rows.length > 0 || Date.now() > deadline) return rows
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function ensureDingTalkBinding(): Promise<void> {
  await q(
    `INSERT INTO directory_integrations (id, name, corp_id)
     VALUES ($1, 'card-test', 'corp_card_test')
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, corp_id = EXCLUDED.corp_id`,
    [DD_INTEGRATION],
  )
  await q(
    `INSERT INTO directory_accounts
       (id, integration_id, provider, external_user_id, external_key, name, is_active)
     VALUES ($1, $2, 'dingtalk', $3, $3, 'Card Approver', TRUE)
     ON CONFLICT (id) DO UPDATE
       SET integration_id = EXCLUDED.integration_id,
           external_user_id = EXCLUDED.external_user_id,
           external_key = EXCLUDED.external_key,
           name = EXCLUDED.name,
           is_active = TRUE`,
    [DD_ACCOUNT, DD_INTEGRATION, DD_USER_ID],
  )
  await q(
    'DELETE FROM directory_account_links WHERE directory_account_id = $1 OR local_user_id = $2',
    [DD_ACCOUNT, APPROVER],
  )
  await q(
    `INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status)
     VALUES ($1, $2, 'linked')`,
    [DD_ACCOUNT, APPROVER],
  )
}

describeIfDatabase('A-2b send_dingtalk_approval_card action (real DB)', () => {
  const savedEnv: Record<string, string | undefined> = {}
  beforeAll(async () => {
    for (const [k, v] of Object.entries({
      DINGTALK_APP_KEY: 'test_app_key',
      DINGTALK_APP_SECRET: 'test_app_secret',
      DINGTALK_AGENT_ID: '1000001',
      PUBLIC_APP_URL: 'https://ms.example.test',
      APPROVAL_CARD_LINK_SECRET: 'card-link-secret-for-tests',
    })) {
      savedEnv[k] = process.env[k]
      process.env[k] = v
    }
    for (const key of [
      DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED_ENV,
      DINGTALK_INTERACTIVE_CARD_CLIENT_ID_ENV,
      DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET_ENV,
      DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID_ENV,
    ]) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'Card Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'Card Sheet'])
    await q(`INSERT INTO permissions (code, name, description) VALUES ('approvals:read','r','t'),('approvals:write','w','t'),('approvals:act','a','t') ON CONFLICT (code) DO NOTHING`)
    for (const uid of [CREATOR, REQUESTER, APPROVER]) {
      await q(`INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
               VALUES ($1,$2,$1,'x','user','[]'::jsonb,TRUE,FALSE) ON CONFLICT (id) DO UPDATE SET is_active = TRUE`, [uid, `${uid}@card.test`])
    }
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,'approvals:read') ON CONFLICT DO NOTHING`, [CREATOR])
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,'approvals:write') ON CONFLICT DO NOTHING`, [REQUESTER])
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,'approvals:act') ON CONFLICT DO NOTHING`, [APPROVER])

    approvals = new ApprovalProductService()
    const template = await approvals.createTemplate(cardTemplateRequest() as never)
    templateId = (template as { id: string }).id
    await approvals.publishTemplate(templateId, { policy: { allowRevoke: true } } as never)

    svc = new AutomationService(integrationEventBus, db as never, queryFn, fakeFetch as never)
    svc.init()
  })

  afterEach(() => {
    delete process.env[DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED_ENV]
    delete process.env[DINGTALK_INTERACTIVE_CARD_CLIENT_ID_ENV]
    delete process.env[DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET_ENV]
    delete process.env[DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID_ENV]
    interactiveBodies.length = 0
  })

  afterAll(async () => {
    try { svc?.shutdown() } catch { /* noop */ }
    const instances = await q('SELECT id FROM approval_instances WHERE template_id = $1', [templateId]).catch(() => ({ rows: [] as unknown[] }))
    for (const row of instances.rows as Array<{ id: string }>) {
      await q('DELETE FROM dingtalk_approval_card_deliveries WHERE instance_id = $1', [row.id]).catch(() => {})
      await q('DELETE FROM approval_assignments WHERE instance_id = $1', [row.id]).catch(() => {})
      await q('DELETE FROM approval_records WHERE instance_id = $1', [row.id]).catch(() => {})
      await q('DELETE FROM approval_instances WHERE id = $1', [row.id]).catch(() => {})
    }
    if (ruleIds.length > 0) {
      await q('DELETE FROM meta_automation_event_fires WHERE rule_id = ANY($1::text[])', [ruleIds]).catch(() => {})
      await q('DELETE FROM multitable_automation_executions WHERE rule_id = ANY($1::text[])', [ruleIds]).catch(() => {})
      await q('DELETE FROM automation_rules WHERE id = ANY($1::text[])', [ruleIds]).catch(() => {})
    }
    await q('DELETE FROM approval_templates WHERE id = $1', [templateId]).catch(() => {})
    await q('DELETE FROM dingtalk_person_deliveries WHERE local_user_id = ANY($1::text[])', [[APPROVER]]).catch(() => {})
    await q('DELETE FROM directory_account_links WHERE local_user_id = $1', [APPROVER]).catch(() => {})
    await q('DELETE FROM directory_accounts WHERE id = $1', [DD_ACCOUNT]).catch(() => {})
    await q('DELETE FROM directory_integrations WHERE id = $1', [DD_INTEGRATION]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
    await q('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[CREATOR, REQUESTER, APPROVER]]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[CREATOR, REQUESTER, APPROVER]]).catch(() => {})
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('placement gate: the card action saves ONLY on approval.task_created (create + update)', async () => {
    const base = {
      name: 'card placement',
      actionType: 'send_dingtalk_approval_card',
      actionConfig: {},
      createdBy: CREATOR,
    }
    await expect(svc.createRule(SHEET_ID, { ...base, triggerType: 'record.created', triggerConfig: {} } as never))
      .rejects.toThrow(/only allowed on approval.task_created rules/)
    await expect(svc.createRule(SHEET_ID, { ...base, triggerType: 'approval.completed', triggerConfig: { templateId } } as never))
      .rejects.toThrow(/not allowed on approval.completed rules/)

    // update-time smuggle: a notify rule on record.created cannot swap its action to the card
    const notifyRule = await svc.createRule(SHEET_ID, {
      name: 'plain notify', triggerType: 'record.created', triggerConfig: {},
      actionType: 'send_notification', actionConfig: { userIds: [CREATOR], message: 'x' }, createdBy: CREATOR,
    } as never)
    ruleIds.push(notifyRule.id)
    await expect(svc.updateRule(notifyRule.id, SHEET_ID, { actionType: 'send_dingtalk_approval_card', actionConfig: {} } as never))
      .rejects.toThrow(/only allowed on approval.task_created rules/)
    await svc.deleteRule(notifyRule.id, SHEET_ID)
  })

  test('unbound recipient: skipped person-delivery telemetry, NO card row, mapping never guessed', async () => {
    const rule = await svc.createRule(SHEET_ID, {
      name: 'card unbound', triggerType: 'approval.task_created', triggerConfig: { templateId },
      actionType: 'send_dingtalk_approval_card', actionConfig: {}, createdBy: CREATOR,
    } as never)
    ruleIds.push(rule.id)

    const dto = await approvals.createApproval({ templateId, formData: { summary: 'unbound run' } }, { userId: REQUESTER, userName: REQUESTER })
    const instanceId = (dto as { id: string }).id
    const skipped = await waitFor(async () => {
      const r = await q(`SELECT status, error_message FROM dingtalk_person_deliveries WHERE local_user_id = $1 AND status = 'skipped'`, [APPROVER])
      return r.rows
    })
    expect(skipped.length).toBeGreaterThan(0)
    expect((skipped[0] as { error_message: string }).error_message).toContain('not linked')
    expect(await cardRows(instanceId)).toHaveLength(0)
    await svc.deleteRule(rule.id, SHEET_ID)
  })

  test('bound recipient: ledger-first send — sent card, task_id, signed values-free deep link', async () => {
    await ensureDingTalkBinding()

    const rule = await svc.createRule(SHEET_ID, {
      name: 'card bound', triggerType: 'approval.task_created', triggerConfig: { templateId },
      actionType: 'send_dingtalk_approval_card', actionConfig: {}, createdBy: CREATOR,
    } as never)
    ruleIds.push(rule.id)

    sentBodies.length = 0
    interactiveBodies.length = 0
    const dto = await approvals.createApproval({ templateId, formData: { summary: 'SECRET-FORM-VALUE' } }, { userId: REQUESTER, userName: REQUESTER })
    const instanceId = (dto as { id: string }).id
    const rows = await waitFor(() => cardRows(instanceId))
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.delivery_kind).toBe('work_notice_action_card')
    expect(row.card_state).toBe('sent')
    expect(row.send_status).toBe('sent')
    expect(row.task_id).toBe('424242')
    expect(row.recipient_user_id).toBe(APPROVER)
    expect(row.recipient_dingtalk_user_id).toBe(DD_USER_ID)

    expect(sentBodies).toHaveLength(1)
    expect(interactiveBodies).toHaveLength(0)
    const body = sentBodies[0]
    expect(body.userid_list).toBe(DD_USER_ID)
    const msg = body.msg as { msgtype: string; action_card: { single_url: string; markdown: string; single_title: string } }
    expect(msg.msgtype).toBe('action_card')
    expect(msg.action_card.single_title).toBe('查看并处理')
    const url = msg.action_card.single_url
    expect(url).toContain(`d=${row.id}`)
    expect(url).toMatch(/t=[0-9a-f]{32}/)
    expect(url).not.toContain(instanceId) // values-free deep link: ledger id + token ONLY
    expect(msg.action_card.markdown).not.toContain('SECRET-FORM-VALUE') // no form values on the card
    await svc.deleteRule(rule.id, SHEET_ID)
  })

  test('B-2 opt-in: interactive card uses the ledger id as outTrackId and stays values-free', async () => {
    await ensureDingTalkBinding()
    process.env[DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED_ENV] = '1'
    process.env[DINGTALK_INTERACTIVE_CARD_CLIENT_ID_ENV] = 'stream-app-key'
    process.env[DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET_ENV] = 'stream-app-secret'
    process.env[DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID_ENV] = 'stream-card-template'

    const rule = await svc.createRule(SHEET_ID, {
      name: 'interactive card bound', triggerType: 'approval.task_created', triggerConfig: { templateId },
      actionType: 'send_dingtalk_approval_card', actionConfig: {}, createdBy: CREATOR,
    } as never)
    ruleIds.push(rule.id)

    sentBodies.length = 0
    interactiveBodies.length = 0
    const dto = await approvals.createApproval(
      { templateId, formData: { summary: 'SECRET-INTERACTIVE-FORM-VALUE' } },
      { userId: REQUESTER, userName: REQUESTER },
    )
    const instanceId = (dto as { id: string }).id
    const rows = await waitFor(async () => (await cardRows(instanceId)).filter((row) => row.send_status !== 'pending'))
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.delivery_kind).toBe('interactive_card')
    expect(row.integration_id).toBe(DD_INTEGRATION)
    expect(row.card_state).toBe('sent')
    expect(row.send_status).toBe('sent')
    expect(row.task_id).toBe('interactive-task-4242')
    // P2-2: the executor MUST persist the task's entry epoch onto the delivery row (this is what
    // powers the wrapper's same-node re-entry binding). Pinned to the live seat's epoch so a
    // regression that drops the capture (persists null) fails HERE, not silently.
    const seatEpoch = await q(
      `SELECT entry_epoch FROM approval_assignments WHERE instance_id = $1 AND is_active = TRUE ORDER BY created_at ASC LIMIT 1`,
      [instanceId],
    )
    const expectedEpoch = (seatEpoch.rows[0] as { entry_epoch: number | null } | undefined)?.entry_epoch ?? null
    expect(expectedEpoch).not.toBeNull()
    expect(row.entry_epoch).toBe(expectedEpoch)

    expect(sentBodies).toHaveLength(0)
    expect(interactiveBodies).toHaveLength(1)
    const body = interactiveBodies[0]
    expect(body.cardTemplateId).toBe('stream-card-template')
    expect(body.outTrackId).toBe(row.id)
    expect(body.callbackType).toBe('STREAM')
    expect(body.callbackRouteKey).toBe('approval_card')
    expect(body.userId).toBe(DD_USER_ID)
    expect(body.openSpaceId).toBe(`dtv1.card//im_robot.${DD_USER_ID}`)
    expect(body.imRobotOpenSpaceModel).toEqual({ supportForward: false })
    expect(body.imRobotOpenDeliverModel).toEqual({ robotCode: 'stream-app-key', spaceType: 'IM_ROBOT' })
    expect(body).not.toHaveProperty('openSpaceModel')
    expect(body).not.toHaveProperty('openDeliverModel')

    const serialized = JSON.stringify(body)
    expect(serialized).toContain('/m/approval-decision')
    expect(serialized).toContain(`d=${row.id}`)
    expect(serialized).toMatch(/t=[0-9a-f]{32}/)
    expect(serialized).not.toContain(instanceId)
    expect(serialized).not.toContain('SECRET-INTERACTIVE-FORM-VALUE')

    await svc.deleteRule(rule.id, SHEET_ID)
  })

  test('P3-3: interactive-card config PARTIALLY set (template id missing) falls back to the legacy OA action-card path — not interactive, not error', async () => {
    await ensureDingTalkBinding()
    // Partial config: flag + client id + client secret are present, but the template id is
    // missing. resolveDingTalkInteractiveCardStreamConfig has no third ("degraded") state —
    // any missing required field returns enabled:false — so the executor must take the exact
    // same legacy OA branch as the fully-flag-off case, not error and not half-send interactive.
    process.env[DINGTALK_INTERACTIVE_CARD_STREAM_ENABLED_ENV] = '1'
    process.env[DINGTALK_INTERACTIVE_CARD_CLIENT_ID_ENV] = 'partial-app-key'
    process.env[DINGTALK_INTERACTIVE_CARD_CLIENT_SECRET_ENV] = 'partial-app-secret'
    delete process.env[DINGTALK_INTERACTIVE_CARD_TEMPLATE_ID_ENV]
    expect(resolveDingTalkInteractiveCardStreamConfig()).toMatchObject({ enabled: false, reason: 'missing_template_id' })

    const rule = await svc.createRule(SHEET_ID, {
      name: 'card partial-config fallback', triggerType: 'approval.task_created', triggerConfig: { templateId },
      actionType: 'send_dingtalk_approval_card', actionConfig: {}, createdBy: CREATOR,
    } as never)
    ruleIds.push(rule.id)

    sentBodies.length = 0
    interactiveBodies.length = 0
    const dto = await approvals.createApproval(
      { templateId, formData: { summary: 'partial config run' } },
      { userId: REQUESTER, userName: REQUESTER },
    )
    const instanceId = (dto as { id: string }).id
    const rows = await waitFor(async () => (await cardRows(instanceId)).filter((row) => row.send_status !== 'pending'))
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.delivery_kind).toBe('work_notice_action_card')
    expect(row.card_state).toBe('sent')
    expect(row.send_status).toBe('sent')

    // The legacy OA send fired exactly once; the interactive createAndDeliver endpoint was never
    // called (no half-sent interactive attempt, no silent double-send).
    expect(sentBodies).toHaveLength(1)
    expect(interactiveBodies).toHaveLength(0)

    await svc.deleteRule(rule.id, SHEET_ID)
  })

  test('send failure is traceable: send_status=failed + send_error on the ledger row', async () => {
    const rule = await svc.createRule(SHEET_ID, {
      name: 'card send-fail', triggerType: 'approval.task_created', triggerConfig: { templateId },
      actionType: 'send_dingtalk_approval_card', actionConfig: {}, createdBy: CREATOR,
    } as never)
    ruleIds.push(rule.id)

    failNextSend = true
    const dto = await approvals.createApproval({ templateId, formData: { summary: 'fail run' } }, { userId: REQUESTER, userName: REQUESTER })
    const instanceId = (dto as { id: string }).id
    const rows = await waitFor(async () => (await cardRows(instanceId)).filter((r) => r.send_status !== 'pending'))
    expect(rows).toHaveLength(1)
    expect(rows[0].send_status).toBe('failed')
    expect(String(rows[0].send_error)).toContain('Failed to send DingTalk action-card work notification')

    // Negative direction of DT-HARDEN-06 (gate hardening, #4009 P2): here the send fails but the
    // ledger mark-failed write SUCCEEDS (no fault injection — failNextLedgerMarkFailed stays
    // false) — send_status='failed' landed on the row above via the ordinary path. deliveryStuckPending
    // /deliveryLedgerError are an exceptional signal reserved for when the bookkeeping write ITSELF
    // failed, not a generic "send failed" flag. Without this assertion, hardcoding
    // `deliveryStuckPending: true` unconditionally on every send-fail output would survive the whole
    // suite: it would make every ordinary, correctly-ledgered failure scream "stuck pending" and kill
    // the flag's signal value for operators chasing real stuck rows.
    const executionRows = await waitFor(async () => {
      const r = await q(
        `SELECT steps FROM multitable_automation_executions WHERE rule_id = $1 ORDER BY created_at DESC`,
        [rule.id],
      )
      return r.rows
    })
    expect(executionRows.length).toBeGreaterThan(0)
    const rawSteps = (executionRows[0] as { steps: unknown }).steps
    const steps = (typeof rawSteps === 'string' ? JSON.parse(rawSteps) : rawSteps) as Array<Record<string, unknown>>
    const cardStep = steps.find((s) => s.actionType === 'send_dingtalk_approval_card') as
      | { status: string; output?: { deliveryId?: string; deliveryStuckPending?: boolean; deliveryLedgerError?: string } }
      | undefined
    expect(cardStep).toBeDefined()
    expect(cardStep!.status).toBe('failed')
    expect(cardStep!.output?.deliveryId).toBeTruthy()
    expect(cardStep!.output?.deliveryStuckPending).toBeUndefined()
    expect(cardStep!.output?.deliveryLedgerError).toBeUndefined()

    await svc.deleteRule(rule.id, SHEET_ID)
  })

  test('PR #4046 Phase B: a transport-level outcome-unknown send failure records send_status=outcome_unknown (NOT failed), the execution output carries deliveryOutcomeUnknown, and there is NO second send attempt', async () => {
    const rule = await svc.createRule(SHEET_ID, {
      name: 'card outcome-unknown', triggerType: 'approval.task_created', triggerConfig: { templateId },
      actionType: 'send_dingtalk_approval_card', actionConfig: {}, createdBy: CREATOR,
    } as never)
    ruleIds.push(rule.id)

    failNextSendNetwork = true
    const asyncsendBefore = asyncsendCallCount
    const dto = await approvals.createApproval({ templateId, formData: { summary: 'outcome-unknown run' } }, { userId: REQUESTER, userName: REQUESTER })
    const instanceId = (dto as { id: string }).id

    // The ledger consumes the marker: the DISTINCT outcome_unknown state, never plain 'failed' —
    // the card may well have been delivered (owner doctrine: no auto-resend on ambiguity; a lost
    // response has no task_id, so DingTalk's result query cannot reconcile it automatically).
    const rows = await waitFor(async () => (await cardRows(instanceId)).filter((r) => r.send_status !== 'pending'))
    expect(rows).toHaveLength(1)
    expect(rows[0].send_status).toBe('outcome_unknown')
    expect(rows[0].task_id).toBeNull()
    expect(String(rows[0].send_error)).toContain('fetch failed')

    // NO second send attempt: exactly one asyncsend fetch for this run (transport send tier
    // never resends; the executor makes exactly one send call).
    expect(asyncsendCallCount).toBe(asyncsendBefore + 1)

    // The persisted execution record carries the flag for the execution ledger/readers.
    const executionRows = await waitFor(async () => {
      const r = await q(
        `SELECT steps FROM multitable_automation_executions WHERE rule_id = $1 ORDER BY created_at DESC`,
        [rule.id],
      )
      return r.rows
    })
    expect(executionRows.length).toBeGreaterThan(0)
    const rawSteps = (executionRows[0] as { steps: unknown }).steps
    const steps = (typeof rawSteps === 'string' ? JSON.parse(rawSteps) : rawSteps) as Array<Record<string, unknown>>
    const cardStep = steps.find((s) => s.actionType === 'send_dingtalk_approval_card') as
      | { status: string; output?: { deliveryId?: string; deliveryOutcomeUnknown?: boolean; deliveryStuckPending?: boolean } }
      | undefined
    expect(cardStep).toBeDefined()
    expect(cardStep!.status).toBe('failed')
    expect(cardStep!.output?.deliveryId).toBe(rows[0].id)
    expect(cardStep!.output?.deliveryOutcomeUnknown).toBe(true)
    expect(cardStep!.output?.deliveryStuckPending).toBeUndefined()

    // Contrast pin (mutation guard both directions): the DEFINITE-rejection path in the previous
    // test stays 'failed' WITHOUT the flag — mapping outcome-unknown back to plain 'failed' turns
    // the assertions above red; mapping all failures to outcome_unknown turns that test red.

    await svc.deleteRule(rule.id, SHEET_ID)
  })

  test('PR #4046 Phase B: dingtalk_person_deliveries accepts the outcome_unknown status (widened CHECK) and still rejects unknown values', async () => {
    // The executor's person-delivery writes go through recordDingTalkPersonDeliverySafely, which
    // swallows insert errors by design — a unit test cannot prove the DB accepts the new status.
    // Prove the widened CHECK against real Postgres here (both directions).
    const inserted = await q(
      `INSERT INTO dingtalk_person_deliveries
         (id, local_user_id, dingtalk_user_id, source_type, subject, content, success, status, error_message)
       VALUES ($1, $2, $3, 'automation', 's', 'c', FALSE, 'outcome_unknown', 'fetch failed')
       RETURNING id, status`,
      [randomUUID(), APPROVER, DD_USER_ID],
    )
    expect((inserted.rows[0] as { status: string }).status).toBe('outcome_unknown')

    let code: string | undefined
    try {
      await q(
        `INSERT INTO dingtalk_person_deliveries
           (id, local_user_id, source_type, subject, content, success, status)
         VALUES ($1, $2, 'automation', 's', 'c', FALSE, 'bogus_status')`,
        [randomUUID(), APPROVER],
      )
    } catch (e) {
      code = (e as { code?: string }).code
    }
    expect(code).toBe('23514')
  })

  test('DT-HARDEN-06: send fails AND the ledger mark-failed write ALSO fails — deliveryStuckPending/deliveryLedgerError surface in the persisted execution record, not swallowed', async () => {
    // Reuses the directory binding established by 'bound recipient' — APPROVER stays
    // linked to DD_USER_ID for the rest of the describe block (cleanup happens in afterAll).
    const rule = await svc.createRule(SHEET_ID, {
      name: 'card ledger-fail', triggerType: 'approval.task_created', triggerConfig: { templateId },
      actionType: 'send_dingtalk_approval_card', actionConfig: {}, createdBy: CREATOR,
    } as never)
    ruleIds.push(rule.id)

    failNextSend = true
    ledgerMarkFailedInjectorFired = false
    failNextLedgerMarkFailed = true
    const dto = await approvals.createApproval({ templateId, formData: { summary: 'ledger-fail run' } }, { userId: REQUESTER, userName: REQUESTER })
    const instanceId = (dto as { id: string }).id

    const executionRows = await waitFor(async () => {
      const r = await q(
        `SELECT steps FROM multitable_automation_executions WHERE rule_id = $1 ORDER BY created_at DESC`,
        [rule.id],
      )
      return r.rows
    })
    expect(executionRows.length).toBeGreaterThan(0)
    const rawSteps = (executionRows[0] as { steps: unknown }).steps
    const steps = (typeof rawSteps === 'string' ? JSON.parse(rawSteps) : rawSteps) as Array<Record<string, unknown>>
    const cardStep = steps.find((s) => s.actionType === 'send_dingtalk_approval_card') as
      | { status: string; output?: { deliveryId?: string; deliveryStuckPending?: boolean; deliveryLedgerError?: string } }
      | undefined
    expect(cardStep).toBeDefined()
    expect(cardStep!.status).toBe('failed')
    expect(cardStep!.output?.deliveryId).toBeTruthy()
    expect(cardStep!.output?.deliveryStuckPending).toBe(true)
    expect(String(cardStep!.output?.deliveryLedgerError)).toContain('simulated ledger outage')

    // Matcher-rot guard: prove the injector actually fired. Without this, a refactor of the
    // mark-failed helper's SQL shape could make the fault injector silently no-op, and this
    // test would then only be exercising the ordinary (never-fails) happy send-fail path.
    expect(ledgerMarkFailedInjectorFired).toBe(true)

    // The real stuck condition the flag simulates: the ledger row never left 'pending' because
    // the mark-failed write — the only thing that flips it to 'failed' — is what the injector broke.
    const rows = await cardRows(instanceId)
    expect(rows).toHaveLength(1)
    expect(rows[0].send_status).toBe('pending')

    await svc.deleteRule(rule.id, SHEET_ID)
  })

  test('DT-R2: the ledger row carries the assignee integration_id resolved via the directory-link lateral', async () => {
    const rule = await svc.createRule(SHEET_ID, {
      name: 'card r2 integration-id', triggerType: 'approval.task_created', triggerConfig: { templateId },
      actionType: 'send_dingtalk_approval_card', actionConfig: {}, createdBy: CREATOR,
    } as never)
    ruleIds.push(rule.id)
    try {
      const dto = await approvals.createApproval({ templateId, formData: { summary: 'r2 anchor run' } }, { userId: REQUESTER, userName: REQUESTER })
      const instanceId = (dto as { id: string }).id
      const rows = await waitFor(() => cardRows(instanceId))
      expect(rows).toHaveLength(1)
      // The callback credential anchor: the row is pinned to the corp the card went through.
      expect(rows[0].integration_id).toBe(DD_INTEGRATION)
      expect(rows[0].send_status).toBe('sent')
    } finally {
      await svc.deleteRule(rule.id, SHEET_ID)
    }
  })

  test('DT-R2 same-source signing: env unset → the deep-link token is HMAC-signed with the ASSIGNEE integration\'s stored secret', async () => {
    const prevSecret = process.env.APPROVAL_CARD_LINK_SECRET
    delete process.env.APPROVAL_CARD_LINK_SECRET
    const corpSecret = `r2-corp-stored-secret-${TS}`
    await q(
      `UPDATE directory_integrations
          SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{approvalCardLinkSecret}', to_jsonb($2::text), true)
        WHERE id = $1`,
      [DD_INTEGRATION, normalizeStoredSecretValue(corpSecret)],
    )
    // Anti-shadowing decoy: a FRESHER active dingtalk integration with a different secret, so the
    // legacy LIMIT-1 global pick (active-first, updated_at DESC) lands on the DECOY — if the
    // executor ever signed with that pick instead of the ASSIGNEE's integration, the token
    // assertion below would go red. Deleted in finally; now() cannot permanently shadow.
    const DECOY = randomUUID()
    await q(
      `INSERT INTO directory_integrations (id, name, provider, status, corp_id, config, updated_at)
       VALUES ($1, $2, 'dingtalk', 'active', $3, $4::jsonb, now())`,
      [DECOY, `card-r2-decoy-${TS}`, `corp_card_r2_decoy_${TS}`, JSON.stringify({ approvalCardLinkSecret: normalizeStoredSecretValue(`r2-decoy-secret-${TS}`) })],
    )
    const rule = await svc.createRule(SHEET_ID, {
      name: 'card r2 corp secret', triggerType: 'approval.task_created', triggerConfig: { templateId },
      actionType: 'send_dingtalk_approval_card', actionConfig: {}, createdBy: CREATOR,
    } as never)
    ruleIds.push(rule.id)
    try {
      sentBodies.length = 0
      const dto = await approvals.createApproval({ templateId, formData: { summary: 'r2 corp secret run' } }, { userId: REQUESTER, userName: REQUESTER })
      const instanceId = (dto as { id: string }).id
      const rows = await waitFor(() => cardRows(instanceId))
      expect(rows).toHaveLength(1)
      const row = rows[0]
      expect(row.integration_id).toBe(DD_INTEGRATION)
      expect(row.send_status).toBe('sent')

      // Same-source proof at the real call site: the token in the sent deep link must be
      // HMAC-SHA256(deliveryId, THAT integration's stored secret) — never a global LIMIT-1 pick.
      expect(sentBodies).toHaveLength(1)
      const msg = sentBodies[0].msg as { action_card: { single_url: string } }
      const tokenMatch = /[?&]t=([0-9a-f]{32})/.exec(msg.action_card.single_url)
      expect(tokenMatch).not.toBeNull()
      const expected = createHmac('sha256', corpSecret).update(String(row.id)).digest('hex').slice(0, 32)
      expect(tokenMatch?.[1]).toBe(expected)
    } finally {
      await svc.deleteRule(rule.id, SHEET_ID).catch(() => {})
      await q('DELETE FROM directory_integrations WHERE id = $1', [DECOY]).catch(() => {})
      await q(
        `UPDATE directory_integrations
            SET config = COALESCE(config, '{}'::jsonb) - 'approvalCardLinkSecret'
          WHERE id = $1`,
        [DD_INTEGRATION],
      ).catch(() => {})
      if (prevSecret === undefined) delete process.env.APPROVAL_CARD_LINK_SECRET
      else process.env.APPROVAL_CARD_LINK_SECRET = prevSecret
    }
  })

  test('DT-R2 fail-close: assignee integration with no stored secret errors BEFORE any DingTalk call, writes NO card row, and the execution ledger records the actionable per-integration error', async () => {
    const prevSecret = process.env.APPROVAL_CARD_LINK_SECRET
    delete process.env.APPROVAL_CARD_LINK_SECRET
    // Belt-and-suspenders: guarantee DD_INTEGRATION has no stored secret regardless of prior
    // test ordering (the "same-source signing" test clears its own in `finally`, but this must
    // not depend on that).
    await q(
      `UPDATE directory_integrations
          SET config = COALESCE(config, '{}'::jsonb) - 'approvalCardLinkSecret'
        WHERE id = $1`,
      [DD_INTEGRATION],
    )
    // Anti-shadowing decoy: a FRESHER active integration WITH a secret. `resolveApprovalCardLinkSecretForIntegration`
    // is scoped by id (no LIMIT-1 rescue — see approval-card-config.ts), so this proves the
    // fail-close does NOT silently succeed by falling back to some other corp's secret: if a
    // future regression reintroduced that rescue, this run would send successfully instead of
    // failing, and the assertions below would go red.
    const DECOY = randomUUID()
    await q(
      `INSERT INTO directory_integrations (id, name, provider, status, corp_id, config, updated_at)
       VALUES ($1, $2, 'dingtalk', 'active', $3, $4::jsonb, now())`,
      [DECOY, `card-r2-failclose-decoy-${TS}`, `corp_card_r2_failclose_decoy_${TS}`, JSON.stringify({ approvalCardLinkSecret: normalizeStoredSecretValue(`r2-failclose-decoy-secret-${TS}`) })],
    )
    const rule = await svc.createRule(SHEET_ID, {
      name: 'card r2 fail-close', triggerType: 'approval.task_created', triggerConfig: { templateId },
      actionType: 'send_dingtalk_approval_card', actionConfig: {}, createdBy: CREATOR,
    } as never)
    ruleIds.push(rule.id)
    try {
      sentBodies.length = 0
      const fetchCountBefore = fetchCallCount
      const dto = await approvals.createApproval({ templateId, formData: { summary: 'r2 fail-close run' } }, { userId: REQUESTER, userName: REQUESTER })
      const instanceId = (dto as { id: string }).id

      const executions = await waitFor(async () => {
        const r = await q(
          `SELECT status, error FROM multitable_automation_executions WHERE rule_id = $1 AND status = 'failed' ORDER BY triggered_at DESC`,
          [rule.id],
        )
        return r.rows as Array<{ status: string; error: string | null }>
      })
      expect(executions).toHaveLength(1)
      expect(String(executions[0].error)).toContain(
        `stored approval-card link secret on the assignee's DingTalk integration (${DD_INTEGRATION})`,
      )

      // No ledger (delivery) row for this instance — the fail-close must fire BEFORE
      // insertDingTalkApprovalCardDelivery, never a "sent" row with an unsignable link.
      expect(await cardRows(instanceId)).toHaveLength(0)

      // No outbound DingTalk call at all — not even /gettoken — since the fail-close short-circuits
      // before token-fetch/send.
      expect(fetchCallCount).toBe(fetchCountBefore)
      expect(sentBodies).toHaveLength(0)
    } finally {
      await svc.deleteRule(rule.id, SHEET_ID).catch(() => {})
      await q('DELETE FROM directory_integrations WHERE id = $1', [DECOY]).catch(() => {})
      if (prevSecret === undefined) delete process.env.APPROVAL_CARD_LINK_SECRET
      else process.env.APPROVAL_CARD_LINK_SECRET = prevSecret
    }
  })
})
