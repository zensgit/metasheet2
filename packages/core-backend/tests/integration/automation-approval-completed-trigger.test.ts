/**
 * T1-3 `approval.completed` automation trigger — real-DB integration (first-batch ballot 2026-07-01).
 *
 * Real event chain over real Postgres + the real in-process eventBus:
 *   ApprovalProductService.dispatchAction(approve/reject) → emitApprovalCompletionEvent
 *     → AutomationService subscription → handleApprovalCompletionTrigger (template-routed, cross-sheet)
 *       → T2-6 ledger claim (`approval.completed:{eventId}`) → executeRule (record-less)
 *         → send_notification → eventBus 'automation.notification' (the fixture-free oracle).
 *
 * Ballot coverage: Q1 templateId routing + null-template out-of-contract · Q2 creator approvals:read at
 * save AND fire (deny+skip) · Q3 record-less action allowlist (save-reject) · Q5 eventId dedup via the
 * T2-6 ledger (redelivery = no-op) · Q6 outcomes filter (default approved-only) · Q8 conditions rejected.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { db } from '../../src/db/db'
import { eventBus as integrationEventBus } from '../../src/integration/events/event-bus'
import { AutomationService } from '../../src/multitable/automation-service'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'
import type { ApprovalCompletionEventV1 } from '../../src/services/ApprovalCompletionEvent'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_act_${TS}`
const SHEET_ID = `sheet_act_${TS}`
// #5780 characterization fixture: a SECOND base, so the cross-base case below cannot pass merely
// because everything happens to live in one base. See the last test in this file.
const BASE_B_ID = `base_act_b_${TS}`
const SHEET_B_ID = `sheet_act_b_${TS}`
const CREATOR = `u_act_creator_${TS}`
const REQUESTER = `u_act_req_${TS}`
const APPROVER = `u_act_appr_${TS}`
const OUTSIDER = `u_act_out_${TS}`

const q = (sqlText: string, params?: unknown[]) => poolManager.get().query(sqlText, params)
const queryFn = ((sqlText: string, params?: unknown[]) => poolManager.get().query(sqlText, params)) as never

let svc: AutomationService
let approvals: ApprovalProductService
let templateId = ''
const extraTemplateIds: string[] = []
const ruleIds: string[] = []
const notifications: Array<{ userIds: string[]; message: string; sheetId: string; recordId: string }> = []

function approvalTemplateRequest() {
  return {
    key: `act-${TS}`,
    name: 'approval.completed Trigger Template',
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
        { key: 'edge-start-approval_1', source: 'start', target: 'approval_1' },
        { key: 'edge-approval_1-end', source: 'approval_1', target: 'end' },
      ],
    },
  }
}

const requesterActor = () => ({ userId: REQUESTER, userName: REQUESTER })
const approverActor = () => ({ userId: APPROVER, userName: APPROVER })

async function startApprovalInstance(): Promise<string> {
  const dto = await approvals.createApproval(
    { templateId, formData: { summary: 'trigger test' } },
    requesterActor(),
  )
  return (dto as { id: string }).id
}

async function executionCount(ruleId: string): Promise<number> {
  const r = await q('SELECT COUNT(*)::int AS count FROM multitable_automation_executions WHERE rule_id = $1', [ruleId])
  return (r.rows[0] as { count: number }).count
}

async function waitForExecutionCount(ruleId: string, expected: number, timeoutMs = 6000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const count = await executionCount(ruleId)
    if (count >= expected || Date.now() > deadline) return count
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describeIfDatabase('T1-3 approval.completed automation trigger (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'ACT Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'ACT Sheet'])
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_B_ID, 'ACT Base B'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_B_ID, BASE_B_ID, 'ACT Sheet B'])

    await q(
      `INSERT INTO permissions (code, name, description)
       VALUES ('approvals:read', 'Approvals Read', 'ACT test'),
              ('approvals:write', 'Approvals Write', 'ACT test'),
              ('approvals:act', 'Approvals Act', 'ACT test')
       ON CONFLICT (code) DO NOTHING`,
    )
    for (const uid of [CREATOR, REQUESTER, APPROVER, OUTSIDER]) {
      await q(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
         VALUES ($1, $2, $1, 'x', 'user', '[]'::jsonb, TRUE, FALSE)
         ON CONFLICT (id) DO UPDATE SET is_active = TRUE`,
        [uid, `${uid}@act.test`],
      )
    }
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:read') ON CONFLICT DO NOTHING`, [CREATOR])
    // F9b: the notify oracle's recipient must be a sheet member (loadSheetMemberUserIdSet) or the
    // send_notification step fail-closes before its durable write — and the oracle would go silent.
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'multitable:read') ON CONFLICT DO NOTHING`, [CREATOR])
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:write') ON CONFLICT DO NOTHING`, [REQUESTER])
    // Lock-11 §10 arm (a) fixture delta: REQUESTER needs exactly one active
    // user_orgs membership or the real createApproval/startApproval call below 422s
    // (APPROVAL_ORG_UNRESOLVED) before this suite's own assertions run.
    await q(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, 'default', TRUE) ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = TRUE`, [REQUESTER])
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:act') ON CONFLICT DO NOTHING`, [APPROVER])

    approvals = new ApprovalProductService()
    const template = await approvals.createTemplate(approvalTemplateRequest() as never)
    templateId = (template as { id: string }).id
    await approvals.publishTemplate(templateId, { policy: { allowRevoke: true } } as never)

    integrationEventBus.subscribe('automation.notification', (payload) => {
      notifications.push(payload as (typeof notifications)[number])
    })

    svc = new AutomationService(integrationEventBus, db as never, queryFn)
    svc.init()
  })

  afterAll(async () => {
    try { svc?.shutdown() } catch { /* noop */ }
    const allTemplateIds = [templateId, ...extraTemplateIds].filter(Boolean)
    const instances = await q('SELECT id FROM approval_instances WHERE template_id = ANY($1::uuid[])', [allTemplateIds]).catch(() => ({ rows: [] as unknown[] }))
    for (const row of instances.rows as Array<{ id: string }>) {
      await q('DELETE FROM approval_assignments WHERE instance_id = $1', [row.id]).catch(() => {})
      await q('DELETE FROM approval_records WHERE instance_id = $1', [row.id]).catch(() => {})
      await q('DELETE FROM approval_instances WHERE id = $1', [row.id]).catch(() => {})
    }
    if (ruleIds.length > 0) {
      await q('DELETE FROM meta_automation_event_fires WHERE rule_id = ANY($1::text[])', [ruleIds]).catch(() => {})
      await q('DELETE FROM multitable_automation_executions WHERE rule_id = ANY($1::text[])', [ruleIds]).catch(() => {})
      await q('DELETE FROM automation_rules WHERE id = ANY($1::text[])', [ruleIds]).catch(() => {})
    }
    for (const tid of allTemplateIds) {
      await q('DELETE FROM approval_templates WHERE id = $1', [tid]).catch(() => {})
    }
    // F9b: the rule path now writes durable notification rows for this sheet — clean them up too.
    await q('DELETE FROM meta_record_subscription_notifications WHERE sheet_id = ANY($1::text[])', [[SHEET_ID, SHEET_B_ID]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[SHEET_ID, SHEET_B_ID]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[BASE_ID, BASE_B_ID]]).catch(() => {})
    await q('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[CREATOR, REQUESTER, APPROVER, OUTSIDER]]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[CREATOR, REQUESTER, APPROVER, OUTSIDER]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('save gate: templateId / outcomes / actions / conditions / creator permission all fail-closed', async () => {
    const base = {
      name: 'approval completed rule',
      triggerType: 'approval.completed',
      actionType: 'send_notification',
      actionConfig: { userIds: [CREATOR], message: 'done' },
      createdBy: CREATOR,
    }
    await expect(svc.createRule(SHEET_ID, { ...base, triggerConfig: {} } as never))
      .rejects.toThrow(/templateId is required/)
    await expect(svc.createRule(SHEET_ID, { ...base, triggerConfig: { templateId: '00000000-0000-4000-8000-000000000000' } } as never))
      .rejects.toThrow(/must reference an existing approval template/)
    await expect(svc.createRule(SHEET_ID, { ...base, triggerConfig: { templateId, outcomes: ['maybe'] } } as never))
      .rejects.toThrow(/invalid outcome/)
    await expect(svc.createRule(SHEET_ID, { ...base, triggerConfig: { templateId, outcomes: [] } } as never))
      .rejects.toThrow(/non-empty array/)
    await expect(svc.createRule(SHEET_ID, {
      ...base,
      triggerConfig: { templateId },
      actionType: 'update_record',
      actionConfig: { fieldId: 'x', value: 1 },
    } as never)).rejects.toThrow(/not allowed on approval.completed rules/)
    await expect(svc.createRule(SHEET_ID, {
      ...base,
      triggerConfig: { templateId },
      conditions: { logic: 'and', conditions: [{ fieldId: 'x', operator: 'equals', value: 1 }] },
    } as never)).rejects.toThrow(/cannot carry conditions/)
    await expect(svc.createRule(SHEET_ID, { ...base, triggerConfig: { templateId }, createdBy: OUTSIDER } as never))
      .rejects.toThrow(/approvals:read/)
    await expect(svc.createRule(SHEET_ID, { ...base, triggerConfig: { templateId }, createdBy: null } as never))
      .rejects.toThrow(/authenticated creator/)
  })

  test('fires on approval completion: template-routed, record-less, notification delivered, exactly once', async () => {
    const rule = await svc.createRule(SHEET_ID, {
      name: 'notify on approval completed',
      triggerType: 'approval.completed',
      triggerConfig: { templateId },
      actionType: 'send_notification',
      actionConfig: { userIds: [CREATOR], message: 'approval finished' },
      createdBy: CREATOR,
    } as never)
    const ruleId = (rule as { id: string }).id
    ruleIds.push(ruleId)

    const instanceId = await startApprovalInstance()
    await approvals.dispatchAction(instanceId, { action: 'approve', comment: 'ok' } as never, approverActor())

    const count = await waitForExecutionCount(ruleId, 1)
    expect(count, 'the approval.completed rule should have executed exactly once').toBe(1)

    const exec = await q(
      `SELECT status FROM multitable_automation_executions WHERE rule_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [ruleId],
    )
    expect((exec.rows[0] as { status: string }).status).toBe('success')

    const notified = notifications.find((n) => n.message === 'approval finished')
    expect(notified, 'send_notification should have emitted the oracle event').toBeTruthy()
    expect(notified!.userIds).toEqual([CREATOR])
    expect(notified!.sheetId).toBe(SHEET_ID)
    expect(notified!.recordId, 'record-less v1 executes with an empty recordId').toBe('')

    // Q5: the T2-6 ledger row exists under the approval.completed:{eventId} key shape.
    const ledger = await q(
      `SELECT dedup_key FROM meta_automation_event_fires WHERE rule_id = $1`,
      [ruleId],
    )
    expect((ledger.rows as Array<{ dedup_key: string }>).some((r) =>
      r.dedup_key.startsWith(`approval.completed:approval:${instanceId}:`))).toBe(true)

    // Q5 redelivery: re-deliver the SAME completion event → ledger claim loses → still exactly 1 execution.
    const eventsRow = await q(
      `SELECT dedup_key FROM meta_automation_event_fires WHERE rule_id = $1 LIMIT 1`,
      [ruleId],
    )
    const dedupKey = (eventsRow.rows[0] as { dedup_key: string }).dedup_key
    const eventId = dedupKey.replace(/^approval\.completed:/, '')
    const replay: ApprovalCompletionEventV1 = {
      version: 1,
      eventId,
      eventType: 'approval.approved',
      occurredAt: new Date().toISOString(),
      source: 'approval-product',
      approval: {
        instanceId,
        requestNo: null,
        templateId,
        templateVersionId: null,
        publishedDefinitionId: null,
        businessKey: null,
        workflowKey: null,
      },
      transition: { action: 'approve', fromStatus: 'pending', toStatus: 'approved', fromVersion: 1, toVersion: 2, nodeKey: 'approval_1' },
      actor: { id: APPROVER, name: APPROVER },
      requester: { id: REQUESTER },
    }
    await svc.handleApprovalCompletionTrigger(replay)
    expect(await executionCount(ruleId)).toBe(1)
  })

  test('Q6 outcomes filter: a rejected-only rule ignores approvals and fires on rejection', async () => {
    const rule = await svc.createRule(SHEET_ID, {
      name: 'notify on rejection',
      triggerType: 'approval.completed',
      triggerConfig: { templateId, outcomes: ['rejected'] },
      actionType: 'send_notification',
      actionConfig: { userIds: [CREATOR], message: 'approval rejected' },
      createdBy: CREATOR,
    } as never)
    const ruleId = (rule as { id: string }).id
    ruleIds.push(ruleId)

    const approvedId = await startApprovalInstance()
    await approvals.dispatchAction(approvedId, { action: 'approve', comment: 'ok' } as never, approverActor())
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(await executionCount(ruleId), 'rejected-only rule must not fire on approve').toBe(0)

    const rejectedId = await startApprovalInstance()
    await approvals.dispatchAction(rejectedId, { action: 'reject', comment: 'no' } as never, approverActor())
    const count = await waitForExecutionCount(ruleId, 1)
    expect(count, 'rejected-only rule should fire once on rejection').toBe(1)
  })

  test('Q2 fire-time re-check: creator who lost approvals:read is denied + skipped', async () => {
    const rule = await svc.createRule(SHEET_ID, {
      name: 'authz revoke probe',
      triggerType: 'approval.completed',
      triggerConfig: { templateId },
      actionType: 'send_notification',
      actionConfig: { userIds: [CREATOR], message: 'should not fire' },
      createdBy: CREATOR,
    } as never)
    const ruleId = (rule as { id: string }).id
    ruleIds.push(ruleId)

    await q(`DELETE FROM user_permissions WHERE user_id = $1 AND permission_code = 'approvals:read'`, [CREATOR])
    try {
      const instanceId = await startApprovalInstance()
      await approvals.dispatchAction(instanceId, { action: 'approve', comment: 'ok' } as never, approverActor())
      await new Promise((resolve) => setTimeout(resolve, 600))
      expect(await executionCount(ruleId), 'revoked creator must be denied at fire time').toBe(0)
    } finally {
      await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:read') ON CONFLICT DO NOTHING`, [CREATOR])
    }
  })

  test('Q2 visibility leg: hidden template rejected at save; visibility revoked after save → fire-skip', async () => {
    // Save gate: a template whose visibility_scope excludes CREATOR must be rejected even though the
    // template EXISTS and CREATOR holds approvals:read — otherwise its completions could be exfiltrated.
    const hidden = await approvals.createTemplate({
      ...approvalTemplateRequest(),
      key: `act-hidden-${TS}`,
      visibilityScope: { type: 'user', ids: [OUTSIDER] },
    } as never)
    const hiddenId = (hidden as { id: string }).id
    extraTemplateIds.push(hiddenId)
    await approvals.publishTemplate(hiddenId, { policy: { allowRevoke: true } } as never)
    await expect(svc.createRule(SHEET_ID, {
      name: 'hidden template probe',
      triggerType: 'approval.completed',
      triggerConfig: { templateId: hiddenId },
      actionType: 'send_notification',
      actionConfig: { userIds: [CREATOR], message: 'leak' },
      createdBy: CREATOR,
    } as never)).rejects.toThrow(/visible to the rule creator/)

    // Visible-scoped template (CREATOR in scope) saves fine; then the scope flips to exclude CREATOR
    // BEFORE the approval completes → the fire-time visibility re-check must deny + skip.
    const scoped = await approvals.createTemplate({
      ...approvalTemplateRequest(),
      key: `act-scoped-${TS}`,
      visibilityScope: { type: 'user', ids: [CREATOR, REQUESTER, APPROVER] },
    } as never)
    const scopedId = (scoped as { id: string }).id
    extraTemplateIds.push(scopedId)
    await approvals.publishTemplate(scopedId, { policy: { allowRevoke: true } } as never)
    const rule = await svc.createRule(SHEET_ID, {
      name: 'scoped template rule',
      triggerType: 'approval.completed',
      triggerConfig: { templateId: scopedId },
      actionType: 'send_notification',
      actionConfig: { userIds: [CREATOR], message: 'scoped fire' },
      createdBy: CREATOR,
    } as never)
    const ruleId = (rule as { id: string }).id
    ruleIds.push(ruleId)

    const dto = await approvals.createApproval({ templateId: scopedId, formData: { summary: 'scoped' } }, requesterActor())
    const instanceId = (dto as { id: string }).id
    await q(
      `UPDATE approval_templates SET visibility_scope = $2::jsonb WHERE id = $1`,
      [scopedId, JSON.stringify({ type: 'user', ids: [OUTSIDER] })],
    )
    await approvals.dispatchAction(instanceId, { action: 'approve', comment: 'ok' } as never, approverActor())
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(await executionCount(ruleId), 'creator lost template visibility → fire must skip').toBe(0)
  })

  test('Q1: a templateId-null completion is out-of-contract — no crash, no execution', async () => {
    const before = await q('SELECT COUNT(*)::int AS count FROM multitable_automation_executions WHERE rule_id = ANY($1::text[])', [ruleIds])
    const nullTemplateEvent: ApprovalCompletionEventV1 = {
      version: 1,
      eventId: `approval:null-template-${TS}:1:approval.approved`,
      eventType: 'approval.approved',
      occurredAt: new Date().toISOString(),
      source: 'approval-product',
      approval: {
        instanceId: `inst-null-${TS}`,
        requestNo: null,
        templateId: null,
        templateVersionId: null,
        publishedDefinitionId: null,
        businessKey: null,
        workflowKey: null,
      },
      transition: { action: 'approve', fromStatus: 'pending', toStatus: 'approved', fromVersion: 1, toVersion: 2, nodeKey: 'approval_1' },
      actor: { id: APPROVER, name: APPROVER },
      requester: { id: REQUESTER },
    }
    await svc.handleApprovalCompletionTrigger(nullTemplateEvent)
    const after = await q('SELECT COUNT(*)::int AS count FROM multitable_automation_executions WHERE rule_id = ANY($1::text[])', [ruleIds])
    expect((after.rows[0] as { count: number }).count).toBe((before.rows[0] as { count: number }).count)
  })

  /**
   * #5780 — CURRENT BEHAVIOUR, PINNED DELIBERATELY. THIS IS NOT AN ENDORSEMENT.
   *
   * `loadEnabledApprovalCompletedRules` (and its `approval.task_created` twin) filter on
   * trigger_type + enabled + trigger_config.templateId and NOTHING ELSE. There is no base, workspace
   * or tenant predicate anywhere on the approval lane, so one completion for template T fires EVERY
   * enabled rule bound to T ANYWHERE in the deployment: a rule sitting on a sheet in base A fires for
   * a completion raised in base B whose only relationship to base A is that both name the same
   * template. That is what this test asserts — as the bug it is, not as a contract.
   *
   * Note what "raised in base B" can even mean today: nothing, structurally. The completion event
   * (`ApprovalCompletionEventV1.approval`) carries instanceId / requestNo / templateId /
   * templateVersionId / publishedDefinitionId / businessKey / workflowKey and NO base or tenant
   * discriminator at all — asserted below, because that absence is precisely why the predicate cannot
   * merely be "added". `automation_rules` carries only `sheet_id` and `approval_templates` carries no
   * owning-org column either, so WHICH column expresses ownership is a design decision: that is #5780,
   * and it belongs to the owner, not to a liveness bug fix.
   *
   * WHEN #5780 LANDS, THIS ASSERTION IS EXPECTED TO INVERT: the loader will return only the rules that
   * belong to the completion's own base, `routedBases` will collapse to ONE, and the base-A rule will
   * NOT execute. That inversion is the SIGNAL that the fix arrived — flip the expectations here and
   * delete this note. Do NOT read a red here as a regression, and above all do NOT "repair" it by
   * widening the loader again.
   */
  test('#5780 current behaviour, pinned deliberately: the approval rule loaders have NO base/tenant predicate — a rule on a base-A sheet fires for a completion raised in base B', async () => {
    const makeCrossBaseRule = async (sheetId: string, name: string): Promise<string> => {
      const rule = await svc.createRule(sheetId, {
        name,
        triggerType: 'approval.completed',
        triggerConfig: { templateId },
        actionType: 'send_notification',
        actionConfig: { userIds: [CREATOR], message: `cross-base probe ${name}` },
        createdBy: CREATOR,
      } as never)
      const id = (rule as { id: string }).id
      ruleIds.push(id)
      return id
    }
    // The rule under test lives in base A. The base-B rule is the completion's only base-local anchor,
    // i.e. the rule a per-base predicate would keep — it exists so this case cannot be satisfied by a
    // single-base fixture, where "spans every base" and "spans its own base" are indistinguishable.
    const ruleInBaseA = await makeCrossBaseRule(SHEET_ID, 'cross-base probe (base A)')
    const ruleInBaseB = await makeCrossBaseRule(SHEET_B_ID, 'cross-base probe (base B)')

    // (1) LOADER level. Assert on the DISTINCT BASE IDS behind the routed rules rather than on a rule
    // count: a count could be satisfied by two rules in one base, which would prove nothing.
    const routed = await svc.loadEnabledApprovalCompletedRules(templateId)
    const routedSheetIds = routed.map((r) => r.sheet_id)
    expect(routedSheetIds, 'the base-A rule is routed by templateId alone').toContain(SHEET_ID)
    expect(routedSheetIds, 'so is the base-B rule — same template, different base').toContain(SHEET_B_ID)
    const baseRows = await q(
      'SELECT DISTINCT base_id FROM meta_sheets WHERE id = ANY($1::text[])',
      [Array.from(new Set(routedSheetIds))],
    )
    const routedBases = (baseRows.rows as Array<{ base_id: string }>).map((r) => r.base_id)
    expect(
      new Set(routedBases).size,
      '#5780 pin: template-keyed routing spans EVERY base today; when the ownership predicate lands this becomes 1 and this expectation inverts',
    ).toBeGreaterThan(1)

    // (2) WHY it spans every base: the completion event carries no base/tenant key to filter on.
    const completionEvents: ApprovalCompletionEventV1[] = []
    integrationEventBus.subscribe('approval.approved', (payload) => {
      completionEvents.push(payload as ApprovalCompletionEventV1)
    })

    // (3) END TO END: one completion, and the rule that lives in base A executes.
    const instanceId = await startApprovalInstance()
    await approvals.dispatchAction(instanceId, { action: 'approve', comment: 'ok' } as never, approverActor())

    expect(
      await waitForExecutionCount(ruleInBaseA, 1),
      '#5780 pin: the base-A rule executes for a completion it has no base relationship to',
    ).toBeGreaterThanOrEqual(1)
    expect(
      await waitForExecutionCount(ruleInBaseB, 1),
      'control: the base-local rule executes too, so a zero above would mean a broken fixture rather than a fixed loader',
    ).toBeGreaterThanOrEqual(1)

    const observed = completionEvents.find((e) => e.approval.instanceId === instanceId)
    expect(observed, 'the completion must have reached the bus for the routing above to be the real path').toBeTruthy()
    const approvalKeys = Object.keys(observed!.approval)
    expect(
      approvalKeys.filter((k) => /base|tenant|workspace|org/i.test(k)),
      '#5780: the completion event carries NO base/tenant discriminator — this is why the loader has no predicate to apply. When #5780 lands, expect this list to become non-empty (or ownership to arrive on another column) and the pin above to invert.',
    ).toEqual([])
  })
})
