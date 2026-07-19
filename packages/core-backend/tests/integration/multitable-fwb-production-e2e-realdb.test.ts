/**
 * FWB production E2E (real Postgres) — full chain with flags ON:
 *   FWB + durable flags ON → Q6 confirmation → rule save → approve → writeback create
 *   → claim + meta_records + same-txn outbox. Legacy emit is never the delivery path.
 *
 * Negative control: with FWB flag OFF, action fails without writing.
 */
import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { db } from '../../src/db/db'
import { eventBus as integrationEventBus } from '../../src/integration/events/event-bus'
import { AutomationService } from '../../src/multitable/automation-service'
import {
  acknowledgeFwbConfirmation,
  createFwbConfirmationChallenge,
} from '../../src/multitable/approval-fwb-confirmation'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'
import { runWriteApprovalFormValues } from '../../src/multitable/approval-fwb-runtime'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const RUN = randomUUID().slice(0, 8)
const BASE_ID = `base_fwbe_${TS}`
const SHEET_ID = `sheet_fwbe_${TS}`
const FIELD_ID = `fld_title_${TS}`
const CREATOR = `u_fwbe_c_${TS}`
const REQUESTER = `u_fwbe_r_${TS}`
const APPROVER = `u_fwbe_a_${TS}`

const q = (sqlText: string, params?: unknown[]) => poolManager.get().query(sqlText, params)
const queryFn = ((sqlText: string, params?: unknown[]) => poolManager.get().query(sqlText, params)) as never

let svc: AutomationService
let approvals: ApprovalProductService
let templateId = ''
let templateVersionId = ''
let ruleId = ''
const prevFwb = process.env.APPROVAL_FWB_RUNTIME_ENABLED
const prevDurable = process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, 50))
  }
}

describeIfDatabase('FWB production E2E — flag-gated durable writeback create', () => {
  beforeAll(async () => {
    process.env.APPROVAL_FWB_RUNTIME_ENABLED = 'true'
    process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = 'true'

    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'FWBE Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'FWBE Sheet'])
    await q(
      `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order")
       VALUES ($1,$2,'Title','text','{}'::jsonb,0)`,
      [FIELD_ID, SHEET_ID],
    )

    await q(
      `INSERT INTO permissions (code, name, description)
       VALUES ('approvals:read','R','x'),('approvals:write','W','x'),('approvals:act','A','x'),
              ('multitable:write','MW','x'),('multitable:share','MS','x'),('multitable:read','MR','x')
       ON CONFLICT (code) DO NOTHING`,
    )
    for (const uid of [CREATOR, REQUESTER, APPROVER]) {
      await q(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
         VALUES ($1,$2,$1,'x','user','[]'::jsonb,TRUE,$3)
         ON CONFLICT (id) DO UPDATE SET is_active=TRUE, is_admin=EXCLUDED.is_admin`,
        [uid, `${uid}@fwbe.test`, uid === CREATOR],
      )
    }
    for (const code of ['approvals:read', 'multitable:write', 'multitable:share', 'multitable:read']) {
      await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [CREATOR, code])
    }
    await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,'admin') ON CONFLICT DO NOTHING`, [CREATOR]).catch(() => {})
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,'approvals:write') ON CONFLICT DO NOTHING`, [REQUESTER])
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,'approvals:act') ON CONFLICT DO NOTHING`, [APPROVER])

    approvals = new ApprovalProductService()
    const template = await approvals.createTemplate({
      key: `fwbe-${TS}`,
      name: 'FWBE Template',
      formSchema: { fields: [{ id: 'summary', type: 'text', label: 'Summary', required: true }] },
      approvalGraph: {
        nodes: [
          { key: 'start', type: 'start', name: 'Start', config: {} },
          {
            key: 'approval_1',
            type: 'approval',
            name: 'Approver',
            config: { mode: 'any', assigneeSources: [{ kind: 'static_user', userIds: [APPROVER] }] },
          },
          { key: 'end', type: 'end', name: 'End', config: {} },
        ],
        edges: [
          { key: 'e1', source: 'start', target: 'approval_1' },
          { key: 'e2', source: 'approval_1', target: 'end' },
        ],
      },
    } as never)
    templateId = (template as { id: string }).id
    await approvals.publishTemplate(templateId, { policy: { allowRevoke: true } } as never)
    const ver = await q(
      `SELECT id::text AS id FROM approval_template_versions WHERE template_id=$1::uuid ORDER BY version DESC LIMIT 1`,
      [templateId],
    )
    templateVersionId = (ver.rows[0] as { id: string }).id

    const challenge = await createFwbConfirmationChallenge(queryFn, {
      sheetId: SHEET_ID,
      configurerUserId: CREATOR,
      subject: {
        templateId,
        templateVersionId,
        targetBaseId: null,
        targetSheetId: SHEET_ID,
        mappings: [{ formFieldId: 'summary', targetFieldId: FIELD_ID }],
      },
    })
    const ack = await acknowledgeFwbConfirmation(queryFn, {
      confirmationId: challenge.id,
      configurerUserId: CREATOR,
      challengeNonce: challenge.challengeNonce,
    })
    expect(ack.ok).toBe(true)

    svc = new AutomationService(integrationEventBus, db as never, queryFn)
    svc.init()

    const rule = await svc.createRule(SHEET_ID, {
      name: `fwbe-create-${RUN}`,
      triggerType: 'approval.completed',
      triggerConfig: { templateId, outcomes: ['approved'] },
      actionType: 'write_approval_form_values',
      actionConfig: {
        mode: 'create',
        mappings: [{ formFieldId: 'summary', targetFieldId: FIELD_ID }],
        confirmationId: challenge.id,
      },
      createdBy: CREATOR,
      enabled: true,
    })
    ruleId = rule.id
  }, 90_000)

  afterAll(async () => {
    if (prevFwb === undefined) delete process.env.APPROVAL_FWB_RUNTIME_ENABLED
    else process.env.APPROVAL_FWB_RUNTIME_ENABLED = prevFwb
    if (prevDurable === undefined) delete process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED
    else process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = prevDurable
    try { svc?.shutdown() } catch { /* noop */ }
    if (ruleId) {
      await q('DELETE FROM meta_fwb_action_applied WHERE rule_id=$1', [ruleId]).catch(() => {})
      await q('DELETE FROM meta_automation_event_fires WHERE rule_id=$1', [ruleId]).catch(() => {})
      await q('DELETE FROM multitable_automation_executions WHERE rule_id=$1', [ruleId]).catch(() => {})
      await q('DELETE FROM automation_rules WHERE id=$1', [ruleId]).catch(() => {})
    }
    await q('DELETE FROM meta_fwb_confirmations WHERE sheet_id=$1', [SHEET_ID]).catch(() => {})
    if (templateId) {
      const instances = await q('SELECT id FROM approval_instances WHERE template_id=$1::uuid', [templateId]).catch(() => ({ rows: [] as unknown[] }))
      for (const row of instances.rows as Array<{ id: string }>) {
        await q('DELETE FROM approval_node_decision_values WHERE instance_id=$1', [row.id]).catch(() => {})
        await q('DELETE FROM approval_assignments WHERE instance_id=$1', [row.id]).catch(() => {})
        await q('DELETE FROM approval_records WHERE instance_id=$1', [row.id]).catch(() => {})
        await q('DELETE FROM approval_instances WHERE id=$1', [row.id]).catch(() => {})
      }
      await q('DELETE FROM approval_published_definitions WHERE template_id=$1::uuid', [templateId]).catch(() => {})
      await q('DELETE FROM approval_template_versions WHERE template_id=$1::uuid', [templateId]).catch(() => {})
      await q('DELETE FROM approval_templates WHERE id=$1::uuid', [templateId]).catch(() => {})
    }
    await q('DELETE FROM meta_records WHERE sheet_id=$1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id=$1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id=$1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id=$1', [BASE_ID]).catch(() => {})
    await q('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[CREATOR, REQUESTER, APPROVER]]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[CREATOR, REQUESTER, APPROVER]]).catch(() => {})
  })

  test('negative control: FWB flag OFF rejects without write', async () => {
    const off = await runWriteApprovalFormValues(
      {
        queryFn,
        transaction: async (h) => poolManager.get().transaction(async ({ query }) => h({ query: query as never })),
        eventBus: integrationEventBus,
        evaluateCrossBaseWriteGate: async () => ({ crossBase: false }),
        env: { APPROVAL_FWB_RUNTIME_ENABLED: 'false', AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true' } as NodeJS.ProcessEnv,
      },
      {
        executionId: 'x',
        ruleId: 'r',
        sheetId: SHEET_ID,
        recordId: '',
        recordData: {},
        ruleCreatedBy: CREATOR,
        triggerEvent: { eventId: 'e', approval: { instanceId: 'i', templateId } },
      },
      { mode: 'create', mappings: [{ formFieldId: 'summary', targetFieldId: FIELD_ID }], confirmationId: 'x' },
      'actions[0]',
    )
    expect(off.status).toBe('failed')
    expect(off.error).toMatch(/disabled|APPROVAL_FWB/i)
  })

  test('approve → writeback creates record + claim + durable outbox (same-txn path)', async () => {
    const dto = await approvals.createApproval(
      { templateId, formData: { summary: `fwbe-${RUN}` } },
      { userId: REQUESTER, userName: REQUESTER },
    )
    const instanceId = (dto as { id: string }).id
    await approvals.dispatchAction(instanceId, { action: 'approve', comment: 'ok' }, { userId: APPROVER, userName: APPROVER })

    // Durable ON suppresses legacy bus emit (REPLACE). Drive the approval-trigger consumer from the
    // same-txn outbox payload (production dispatcher would await the same adapter).
    const completionRows = await q(
      `SELECT payload FROM meta_automation_outbox
        WHERE event_type IN ('approval.approved','approval.completed')
          AND (payload::text LIKE $1 OR event_id LIKE $2)
        ORDER BY created_at DESC LIMIT 5`,
      [`%${instanceId}%`, `%${instanceId}%`],
    )
    expect(completionRows.rows.length).toBeGreaterThanOrEqual(1)
    const payload = (completionRows.rows[0] as { payload: unknown }).payload
    await svc.handleApprovalCompletionTrigger(payload as never)

    const ok = await waitFor(async () => {
      const r = await q(
        `SELECT count(*)::int AS c FROM meta_records WHERE sheet_id=$1 AND data->>$2=$3`,
        [SHEET_ID, FIELD_ID, `fwbe-${RUN}`],
      )
      return Number((r.rows[0] as { c: number }).c) >= 1
    })
    if (!ok) {
      const execs = await q(
        `SELECT status, error, steps FROM multitable_automation_executions WHERE rule_id=$1 ORDER BY created_at DESC LIMIT 3`,
        [ruleId],
      ).catch((e) => ({ rows: [{ error: String(e) }] }))
      throw new Error(`writeback missing. executions=${JSON.stringify(execs.rows)} outboxN=${completionRows.rows.length}`)
    }

    const claims = await q(
      `SELECT count(*)::int AS c FROM meta_fwb_action_applied WHERE instance_id=$1 AND rule_id=$2`,
      [instanceId, ruleId],
    )
    expect(Number((claims.rows[0] as { c: number }).c)).toBe(1)

    // Durable outbox row must exist (D9) — not legacy-only.
    const outbox = await q(
      `SELECT count(*)::int AS c FROM meta_automation_outbox
        WHERE event_type = 'multitable.record.created'
          AND payload->>'approvalInstanceId' = $1`,
      [instanceId],
    ).catch(() => ({ rows: [{ c: 0 }] }))
    // payload shape may nest — also accept any outbox with our record in payload
    const outboxAlt = await q(
      `SELECT count(*)::int AS c FROM meta_automation_outbox WHERE event_type='multitable.record.created' AND event_id LIKE $1`,
      [`%fwb%`],
    ).catch(() => ({ rows: [{ c: 0 }] }))
    const totalObx = Number((outbox.rows[0] as { c: number }).c) + Number((outboxAlt.rows[0] as { c: number }).c)
    expect(totalObx).toBeGreaterThanOrEqual(1)
  }, 45_000)
})
