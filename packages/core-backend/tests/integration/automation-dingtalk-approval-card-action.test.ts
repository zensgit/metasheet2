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
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { db } from '../../src/db/db'
import { eventBus as integrationEventBus } from '../../src/integration/events/event-bus'
import { AutomationService } from '../../src/multitable/automation-service'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_card_${TS}`
const SHEET_ID = `sheet_card_${TS}`
const CREATOR = `u_card_creator_${TS}`
const REQUESTER = `u_card_req_${TS}`
const APPROVER = `u_card_appr_${TS}`
import { randomUUID } from 'crypto'
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
let failNextSend = false

const fakeFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  if (url.includes('/gettoken')) {
    return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok', access_token: 'tok_test' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  if (url.includes('/topapi/message/corpconversation/asyncsend_v2')) {
    if (failNextSend) {
      failNextSend = false
      return new Response(JSON.stringify({ errcode: 88, errmsg: 'ding: simulated send failure' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    sentBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
    return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok', task_id: 424242 }), { status: 200, headers: { 'Content-Type': 'application/json' } })
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
    await q(`INSERT INTO directory_integrations (id, name, corp_id) VALUES ($1, 'card-test', 'corp_card_test')`, [DD_INTEGRATION])
    await q(`INSERT INTO directory_accounts (id, integration_id, provider, external_user_id, external_key, name, is_active)
             VALUES ($1, $2, 'dingtalk', $3, $3, 'Card Approver', TRUE)`, [DD_ACCOUNT, DD_INTEGRATION, DD_USER_ID])
    await q(`INSERT INTO directory_account_links (directory_account_id, local_user_id, link_status) VALUES ($1, $2, 'linked')`, [DD_ACCOUNT, APPROVER])

    const rule = await svc.createRule(SHEET_ID, {
      name: 'card bound', triggerType: 'approval.task_created', triggerConfig: { templateId },
      actionType: 'send_dingtalk_approval_card', actionConfig: {}, createdBy: CREATOR,
    } as never)
    ruleIds.push(rule.id)

    sentBodies.length = 0
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
    await svc.deleteRule(rule.id, SHEET_ID)
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
})
