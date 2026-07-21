/**
 * FWB activation — production `write_approval_form_values` wiring (real DB, real service surfaces).
 *
 * Drives the REAL boundaries, not seams:
 *   - rule save through `AutomationService.createRule` (the unbypassable persistence gate): placement,
 *     D1 outcome lock, mapping-config negatives (empty/duplicate/unsupported/select/unknown-field),
 *     Q6 confirmation-hash binding, Q6 creator-authority gates — all typed rejections, all while the
 *     FWB flag is OFF (save validates independently of the runtime flag);
 *   - execution through the REAL `AutomationService.handleApprovalCompletionTrigger` → `executeRule` →
 *     `AutomationExecutor` chain against a REAL approval instance (ApprovalProductService template +
 *     createApproval + dispatchAction(approve) — the form_snapshot is the real one, lock D4);
 *   - flag-OFF skip (zero writes), half-durable refusal (FWB ON + durable OFF → failed, zero writes),
 *     happy path (record + revision + FWB ledger claim + outbox row, ONE commit), redelivery net-once
 *     under a NEW eventId (the §2.3 case the event-level ledger cannot catch) with a NEW-instance
 *     positive control, and the V4 revoked-authority leg (save-time authority stripped → execute-time
 *     gate recheck rejects, zero writes);
 *   - executor-level goldens that need seam control: injected-failure atomicity (post-handler abort →
 *     all four rows vanish; no-injection control → all four exist), unbound-gates default-deny,
 *     missing-transaction-seam refusal, ad-hoc dispatch refusal, and the structural-path identity
 *     discriminator (two byte-identical FWB actions in ONE rule → two records, distinct action_keys).
 *
 * Two-point wired (plugin-tests.yml multitable real-DB step + vitest.config.ts exclude).
 */
import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { db } from '../../src/db/db'
import { eventBus as integrationEventBus } from '../../src/integration/events/event-bus'
import { AutomationService } from '../../src/multitable/automation-service'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'
import { AutomationExecutor, type AutomationDeps, type AutomationRule as ExecutorRule } from '../../src/multitable/automation-executor'
import { deriveFwbConfirmationHash } from '../../src/multitable/approval-fwb-activation'
import type { FwbGateChecks } from '../../src/multitable/approval-fwb-permission-gates'
import { invalidateUserPerms } from '../../src/rbac/service'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE_ID = `base_fwbact_${TS}`
const SHEET_ID = `sheet_fwbact_${TS}`
const F_TITLE = `fld_fwbact_title_${TS}`
const F_AMOUNT = `fld_fwbact_amount_${TS}`
const F_STATUS = `fld_fwbact_status_${TS}`
const CREATOR = `u_fwbact_creator_${TS}`
const REQUESTER = `u_fwbact_req_${TS}`
const APPROVER = `u_fwbact_appr_${TS}`

const q = (sqlText: string, params?: unknown[]) => poolManager.get().query(sqlText, params)
const queryFn = ((sqlText: string, params?: unknown[]) => poolManager.get().query(sqlText, params)) as never

let svc: AutomationService
let approvals: ApprovalProductService
let templateId = ''
let templateVersionId = ''
const ruleIds: string[] = []

const MAPPINGS = [
  { formFieldId: 'summary', targetFieldId: F_TITLE, targetType: 'text' as const },
  { formFieldId: 'amount', targetFieldId: F_AMOUNT, targetType: 'number' as const },
]
const confirmation = (mappings: unknown = MAPPINGS, sourceVersionId = templateVersionId) =>
  deriveFwbConfirmationHash({
    templateId,
    sourceTemplateVersionId: sourceVersionId,
    targetBaseId: BASE_ID,
    targetSheetId: SHEET_ID,
    mappings: mappings as never,
  })
const fwbConfig = (
  mappings: unknown = MAPPINGS,
  sourceVersionId = templateVersionId,
  confirmationHash = confirmation(mappings, sourceVersionId),
) => ({ mappings, sourceTemplateVersionId: sourceVersionId, confirmationHash })

function setFlags(fwb: boolean, durable: boolean) {
  if (fwb) process.env.APPROVAL_FWB_WRITEBACK_ENABLED = 'true'
  else delete process.env.APPROVAL_FWB_WRITEBACK_ENABLED
  if (durable) process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = 'true'
  else delete process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED
}

function approvalTemplateRequest() {
  return {
    key: `fwbact-${TS}`,
    name: 'FWB Activation Template',
    formSchema: {
      fields: [
        { id: 'summary', type: 'text', label: 'Summary', required: true },
        { id: 'amount', type: 'number', label: 'Amount', required: true },
      ],
    },
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

async function startInstance(formData: Record<string, unknown>): Promise<string> {
  const dto = await approvals.createApproval(
    { templateId, formData },
    { userId: REQUESTER, userName: REQUESTER },
  )
  return (dto as { id: string }).id
}

async function approveInstance(instanceId: string): Promise<void> {
  await approvals.dispatchAction(instanceId, { action: 'approve', comment: 'ok' } as never, { userId: APPROVER, userName: APPROVER })
}

/** Synthetic completion event mirroring the producer shape the durable adapter redelivers. */
function completionEvent(instanceId: string, eventId: string) {
  return {
    version: 1,
    source: 'approval-product',
    eventType: 'approval.approved',
    eventId,
    occurredAt: new Date().toISOString(),
    approval: { instanceId, templateId, templateVersionId, status: 'approved' },
    transition: { action: 'approve', fromStatus: 'pending', toStatus: 'approved', fromVersion: 1, toVersion: 2, nodeKey: 'approval_1' },
    requester: { id: REQUESTER, name: REQUESTER },
    actor: null, // §2.2: auto/system completion has no human actor — the write identity is the rule creator
  } as never
}

async function stateFor(instanceId: string, ruleId: string) {
  const rec = await q('SELECT id, data FROM meta_records WHERE sheet_id = $1 ORDER BY created_at', [SHEET_ID])
  const led = await q('SELECT action_key FROM meta_fwb_action_applied WHERE instance_id = $1 AND rule_id = $2', [instanceId, ruleId])
  return { records: rec.rows as Array<{ id: string; data: Record<string, unknown> }>, claims: led.rows.length }
}

async function outboxCountLike(prefix: string): Promise<number> {
  const r = await q('SELECT COUNT(*)::int AS c FROM meta_automation_outbox WHERE event_id LIKE $1', [`${prefix}%`])
  return Number((r.rows[0] as { c: number }).c)
}

async function revisionCountFor(recordId: string): Promise<number> {
  const r = await q('SELECT COUNT(*)::int AS c FROM meta_record_revisions WHERE record_id = $1 AND action = $2 AND source = $3', [recordId, 'create', 'automation'])
  return Number((r.rows[0] as { c: number }).c)
}

async function lastExecution(ruleId: string): Promise<{ status: string; steps: Array<Record<string, unknown>> } | null> {
  const r = await q(
    'SELECT status, steps FROM multitable_automation_executions WHERE rule_id = $1 ORDER BY triggered_at DESC LIMIT 1',
    [ruleId],
  )
  const row = r.rows[0] as { status?: string; steps?: unknown } | undefined
  if (!row) return null
  const steps = typeof row.steps === 'string' ? JSON.parse(row.steps) as Array<Record<string, unknown>> : (row.steps as Array<Record<string, unknown>> ?? [])
  return { status: String(row.status), steps }
}

async function waitForExecutionCount(ruleId: string, expected: number, timeoutMs = 6000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const r = await q('SELECT COUNT(*)::int AS c FROM multitable_automation_executions WHERE rule_id = $1', [ruleId])
    const count = Number((r.rows[0] as { c: number }).c)
    if (count >= expected || Date.now() > deadline) return count
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describeIfDatabase('FWB activation — production write_approval_form_values wiring (real DB)', () => {
  beforeAll(async () => {
    setFlags(false, false)
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'FWB Act Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'FWB Act Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_TITLE, SHEET_ID, 'Title', 'text', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_AMOUNT, SHEET_ID, 'Amount', 'number', '{}', 2])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [
      F_STATUS, SHEET_ID, 'Status', 'select', JSON.stringify({ options: [{ value: 'A' }, { value: 'B' }] }), 3,
    ])
    await q(
      `INSERT INTO permissions (code, name, description)
       VALUES ('approvals:read', 'Approvals Read', 'FWBACT test'),
              ('approvals:write', 'Approvals Write', 'FWBACT test'),
              ('approvals:act', 'Approvals Act', 'FWBACT test')
       ON CONFLICT (code) DO NOTHING`,
    )
    for (const uid of [CREATOR, REQUESTER, APPROVER]) {
      await q(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
         VALUES ($1, $2, $1, 'x', 'user', '[]'::jsonb, TRUE, $3)
         ON CONFLICT (id) DO UPDATE SET is_active = TRUE, is_admin = EXCLUDED.is_admin`,
        [uid, `${uid}@fwbact.test`, uid === CREATOR],
      )
    }
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:read') ON CONFLICT DO NOTHING`, [CREATOR])
    // rbac/service.isAdmin reads user_roles(role_id='admin') — the platform-admin leg Q6 G1 binds to.
    await q(`INSERT INTO roles (id, name) VALUES ('admin', 'admin') ON CONFLICT (id) DO NOTHING`).catch(() => {})
    await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`, [CREATOR])
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:write') ON CONFLICT DO NOTHING`, [REQUESTER])
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:act') ON CONFLICT DO NOTHING`, [APPROVER])

    approvals = new ApprovalProductService()
    const template = await approvals.createTemplate(approvalTemplateRequest() as never)
    templateId = (template as { id: string }).id
    await approvals.publishTemplate(templateId, { policy: { allowRevoke: true } } as never)
    const activeVersion = await q('SELECT active_version_id FROM approval_templates WHERE id = $1', [templateId])
    templateVersionId = String((activeVersion.rows[0] as { active_version_id: string }).active_version_id)

    svc = new AutomationService(integrationEventBus, db as never, queryFn)
  })

  afterAll(async () => {
    setFlags(false, false)
    try { svc?.shutdown() } catch { /* noop */ }
    for (const ruleId of ruleIds) {
      await q('DELETE FROM automation_rules WHERE id = $1', [ruleId]).catch(() => {})
      await q('DELETE FROM multitable_automation_executions WHERE rule_id = $1', [ruleId]).catch(() => {})
    }
    await q('DELETE FROM meta_fwb_action_applied WHERE rule_id = ANY($1::text[])', [ruleIds]).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  // ── Save gate (flag OFF throughout — validation is independent of the runtime flag) ─────────────

  test('save gate: placement, D1 outcome lock, mapping negatives, confirmation hash, creator authority', async () => {
    const fwbBase = {
      name: 'fwb rule',
      triggerType: 'approval.completed',
      triggerConfig: { templateId },
      actionType: 'write_approval_form_values',
      createdBy: CREATOR,
    }
    // placement: FWB on a record trigger is rejected regardless of config validity
    await expect(svc.createRule(SHEET_ID, {
      ...fwbBase,
      triggerType: 'record.created',
      triggerConfig: {},
      actionConfig: fwbConfig(),
    } as never)).rejects.toThrow(/only allowed on approval\.completed rules/)
    // D1: outcomes must be exactly ['approved']
    await expect(svc.createRule(SHEET_ID, {
      ...fwbBase,
      triggerConfig: { templateId, outcomes: ['approved', 'rejected'] },
      actionConfig: fwbConfig(),
    } as never)).rejects.toThrow(/outcomes = \["approved"\]/)
    // empty config
    await expect(svc.createRule(SHEET_ID, {
      ...fwbBase,
      actionConfig: fwbConfig([]),
    } as never)).rejects.toThrow(/empty_config/)
    // duplicate target
    const dup = [MAPPINGS[0], { ...MAPPINGS[1], targetFieldId: F_TITLE, targetType: 'text' as const }]
    await expect(svc.createRule(SHEET_ID, {
      ...fwbBase,
      actionConfig: fwbConfig(dup),
    } as never)).rejects.toThrow(/duplicate_target/)
    // non-v1 target type
    const badType = [{ formFieldId: 'summary', targetFieldId: F_TITLE, targetType: 'attachment' }]
    await expect(svc.createRule(SHEET_ID, {
      ...fwbBase,
      actionConfig: fwbConfig(badType),
    } as never)).rejects.toThrow(/unsupported_target_type/)
    // select without options
    const selNoOpts = [{ formFieldId: 'summary', targetFieldId: F_STATUS, targetType: 'select' }]
    await expect(svc.createRule(SHEET_ID, {
      ...fwbBase,
      actionConfig: fwbConfig(selNoOpts),
    } as never)).rejects.toThrow(/select_options_missing/)
    // select option outside the field's configured set (D6: closed vocabulary)
    const selBadOpt = [{ formFieldId: 'summary', targetFieldId: F_STATUS, targetType: 'select', selectOptions: ['NOT_ON_FIELD'] }]
    await expect(svc.createRule(SHEET_ID, {
      ...fwbBase,
      actionConfig: fwbConfig(selBadOpt),
    } as never)).rejects.toThrow(/select_option_not_on_field/)
    // unknown target field
    const unknownTarget = [{ formFieldId: 'summary', targetFieldId: 'fld_does_not_exist', targetType: 'text' }]
    await expect(svc.createRule(SHEET_ID, {
      ...fwbBase,
      actionConfig: fwbConfig(unknownTarget),
    } as never)).rejects.toThrow(/unknown_target_field/)
    // unknown source field is rejected at save, not deferred until an approval completes.
    const unknownSource = [{ formFieldId: 'source_does_not_exist', targetFieldId: F_TITLE, targetType: 'text' }]
    await expect(svc.createRule(SHEET_ID, {
      ...fwbBase,
      actionConfig: fwbConfig(unknownSource),
    } as never)).rejects.toThrow(/unknown_form_field/)
    // The declassification confirmation is version-bound. A newly published schema must be reviewed
    // and confirmed rather than silently inheriting the old template-level hash.
    const staleVersionId = randomUUID()
    await expect(svc.createRule(SHEET_ID, {
      ...fwbBase,
      actionConfig: fwbConfig(MAPPINGS, staleVersionId),
    } as never)).rejects.toThrow(/sourceTemplateVersionId must match/)
    // type mismatch (number field declared text)
    const mismatch = [{ formFieldId: 'amount', targetFieldId: F_AMOUNT, targetType: 'text' }]
    await expect(svc.createRule(SHEET_ID, {
      ...fwbBase,
      actionConfig: fwbConfig(mismatch),
    } as never)).rejects.toThrow(/target_type_mismatch/)
    // Q6 gate 3: confirmation hash must match the server-derived hash of the ACTUAL config
    await expect(svc.createRule(SHEET_ID, {
      ...fwbBase,
      actionConfig: fwbConfig(MAPPINGS, templateVersionId, 'deadbeef'),
    } as never)).rejects.toThrow(/confirmationHash must match/)
    // Q6 gate 1: non-admin creator without canManageSheetAccess (REQUESTER holds approvals:write only —
    // grant approvals:read so the earlier trigger legs pass and THIS gate is the one that rejects)
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:read') ON CONFLICT DO NOTHING`, [REQUESTER])
    await expect(svc.createRule(SHEET_ID, {
      ...fwbBase,
      createdBy: REQUESTER,
      actionConfig: fwbConfig(),
    } as never)).rejects.toThrow(/canManageSheetAccess/)
  })

  test('save gate positive control: a valid FWB rule saves while the flag is OFF', async () => {
    const rule = await svc.createRule(SHEET_ID, {
      name: 'fwb writeback',
      triggerType: 'approval.completed',
      triggerConfig: { templateId, outcomes: ['approved'] },
      actionType: 'write_approval_form_values',
      actionConfig: fwbConfig(),
      createdBy: CREATOR,
    } as never)
    ruleIds.push((rule as { id: string }).id)
    expect((rule as { id: string }).id).toBeTruthy()
  })

  test('save/update gate binds the real modifier and canonical target-field writability', async () => {
    const temp = await svc.createRule(SHEET_ID, {
      name: 'fwb authoring guard',
      triggerType: 'approval.completed',
      triggerConfig: { templateId, outcomes: ['approved'] },
      actionType: 'write_approval_form_values',
      actionConfig: fwbConfig(),
      createdBy: CREATOR,
    } as never)
    const tempId = (temp as { id: string }).id
    ruleIds.push(tempId)

    // REQUESTER can be admitted to the generic PATCH route by canManageAutomation in another deployment,
    // but lacks Q6's stronger admin/canManageSheetAccess authority. An enabled-only patch must still run
    // the resulting-shape gate and bind THIS actor, not silently reuse created_by.
    await expect(svc.updateRule(tempId, SHEET_ID, { enabled: false }, REQUESTER))
      .rejects.toThrow(/creator, modifier, or enabler/)
    const ownerUpdate = await svc.updateRule(tempId, SHEET_ID, { enabled: false }, CREATOR)
    expect(ownerUpdate?.enabled).toBe(false)

    // The same canonical field guard used by record writes rejects a per-subject read-only target.
    await q(
      `INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only)
       VALUES ($1,$2,'user',$3,true,true)`,
      [SHEET_ID, F_AMOUNT, CREATOR],
    )
    try {
      await expect(svc.updateRule(tempId, SHEET_ID, { name: 'must revalidate fields' }, CREATOR))
        .rejects.toThrow(/target fields that are not writable/)
    } finally {
      await q(
        `DELETE FROM field_permissions
          WHERE sheet_id = $1 AND field_id = $2 AND subject_type = 'user' AND subject_id = $3`,
        [SHEET_ID, F_AMOUNT, CREATOR],
      )
    }
    const restored = await svc.updateRule(tempId, SHEET_ID, { name: 'field gate restored' }, CREATOR)
    expect(restored?.name).toBe('field gate restored')

    // A sheet rehome changes the target base while preserving the sheet id. The old confirmation must
    // not survive that move because Q6 binds both base and sheet identifiers.
    const movedBase = `base_fwbact_moved_${TS}`
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [movedBase, 'FWB moved base'])
    await q('UPDATE meta_sheets SET base_id = $1 WHERE id = $2', [movedBase, SHEET_ID])
    try {
      await expect(svc.updateRule(tempId, SHEET_ID, { name: 'stale base confirmation' }, CREATOR))
        .rejects.toThrow(/confirmationHash must match/)
    } finally {
      await q('UPDATE meta_sheets SET base_id = $1 WHERE id = $2', [BASE_ID, SHEET_ID])
      await q('DELETE FROM meta_bases WHERE id = $1', [movedBase])
    }
  })

  // ── Execution through the REAL trigger → executeRule → executor chain ───────────────────────────

  test('flag OFF → step skipped, ZERO writes; FWB ON + durable OFF → failed (no half-durable), ZERO writes; both ON → record+revision+claim+outbox in one commit; net-once redelivery; new-instance positive control', async () => {
    const ruleId = ruleIds[0]
    const instanceId = await startInstance({ summary: 'FWB run', amount: 42 })
    await approveInstance(instanceId) // real approval; real immutable form_snapshot (lock D4)

    // 1) flag OFF (default): the rule fires (trigger side is live) but the FWB step SKIPS — zero writes.
    setFlags(false, false)
    await svc.handleApprovalCompletionTrigger(completionEvent(instanceId, `evt_fwbact_${TS}_off`))
    await waitForExecutionCount(ruleId, 1)
    let exec = await lastExecution(ruleId)
    expect(exec?.steps?.[0]?.status).toBe('skipped')
    let state = await stateFor(instanceId, ruleId)
    expect(state.records.length).toBe(0)
    expect(state.claims).toBe(0)

    // 2) FWB ON + durable OFF: the lock ties FWB to the durable chain (§9-0/D10) — hard fail, zero writes.
    setFlags(true, false)
    await svc.handleApprovalCompletionTrigger(completionEvent(instanceId, `evt_fwbact_${TS}_hd`))
    await waitForExecutionCount(ruleId, 2)
    exec = await lastExecution(ruleId)
    expect(exec?.steps?.[0]?.status).toBe('failed')
    expect(String(exec?.steps?.[0]?.error ?? '')).toMatch(/AUTOMATION_DURABLE_DELIVERY_ENABLED/)
    state = await stateFor(instanceId, ruleId)
    expect(state.records.length).toBe(0)
    expect(state.claims).toBe(0)

    // 3) both ON: applied — record + create-revision + FWB ledger claim + chained outbox row, one commit.
    setFlags(true, true)
    const evtOn = `evt_fwbact_${TS}_on`
    // REPLACE-seam observability: while durable is ON the chained record event must NOT ride the legacy bus.
    let legacyChainedEmits = 0
    const unsubscribeProbe = integrationEventBus.subscribe('multitable.record.created', (payload) => {
      const p = payload as Record<string, unknown>
      if (typeof p._eventId === 'string' && p._eventId.startsWith(`${evtOn}::fwb::`)) legacyChainedEmits += 1
    })
    await svc.handleApprovalCompletionTrigger(completionEvent(instanceId, evtOn))
    await waitForExecutionCount(ruleId, 3)
    exec = await lastExecution(ruleId)
    expect(exec?.steps?.[0]?.status).toBe('success')
    state = await stateFor(instanceId, ruleId)
    expect(state.records.length).toBe(1)
    expect(state.claims).toBe(1)
    expect(state.records[0].data).toMatchObject({ [F_TITLE]: 'FWB run', [F_AMOUNT]: 42 })
    expect(await revisionCountFor(state.records[0].id)).toBe(1)
    expect(await outboxCountLike(`${evtOn}::fwb::`)).toBe(1)
    expect(legacyChainedEmits).toBe(0) // REPLACE, not keep-both
    if (typeof unsubscribeProbe === 'function') unsubscribeProbe()

    // 4) redelivery under a NEW eventId (same instance): the event-level ledger passes, the FWB
    //    instance-scoped claim dedups — net-once, no new record/claim/outbox (lock §2.3 / §9-1).
    const evtDup = `evt_fwbact_${TS}_dup`
    await svc.handleApprovalCompletionTrigger(completionEvent(instanceId, evtDup))
    await waitForExecutionCount(ruleId, 4)
    exec = await lastExecution(ruleId)
    expect(exec?.steps?.[0]?.status).toBe('success')
    expect(exec?.steps?.[0]?.alreadyApplied).toBe(true)
    state = await stateFor(instanceId, ruleId)
    expect(state.records.length).toBe(1)
    expect(state.claims).toBe(1)
    expect(await outboxCountLike(`${evtDup}::fwb::`)).toBe(0)

    // 5) positive control (V1): a DIFFERENT instance MUST produce a second record — proving the
    //    "exactly one" assertions above discriminate.
    const instanceB = await startInstance({ summary: 'FWB second', amount: 7 })
    await approveInstance(instanceB)
    await svc.handleApprovalCompletionTrigger(completionEvent(instanceB, `evt_fwbact_${TS}_b`))
    await waitForExecutionCount(ruleId, 5)
    const stateB = await stateFor(instanceB, ruleId)
    expect(stateB.claims).toBe(1)
    const allRecords = await q('SELECT COUNT(*)::int AS c FROM meta_records WHERE sheet_id = $1', [SHEET_ID])
    expect(Number((allRecords.rows[0] as { c: number }).c)).toBe(2)
    setFlags(false, false)
  })

  test('V4 revoked authority: creator stripped AFTER save → execute-time Q6 recheck rejects, zero writes (real production gate binding)', async () => {
    const ruleId = ruleIds[0]
    const instanceC = await startInstance({ summary: 'revoked', amount: 1 })
    await approveInstance(instanceC)
    const before = await waitForExecutionCount(ruleId, 0)
    // Strip the creator's platform-admin role — with no sheet grants either, Q6 G1 (admin OR
    // canManageSheetAccess) and G3 (canCreateRecord) both fail at the REAL bound gates. The per-sheet
    // legs read permissions through the platform-wide RBAC cache (rbac/service, 60s TTL — the same
    // staleness bound EVERY authorization surface in this codebase has), so the test invalidates the
    // creator's cache entry exactly as a real revocation flow does; in production a revocation takes
    // effect within the cache TTL.
    await q(`DELETE FROM user_roles WHERE user_id = $1 AND role_id = 'admin'`, [CREATOR])
    await q('UPDATE users SET is_admin = FALSE WHERE id = $1', [CREATOR])
    invalidateUserPerms(CREATOR)
    try {
      setFlags(true, true)
      await svc.handleApprovalCompletionTrigger(completionEvent(instanceC, `evt_fwbact_${TS}_rev`))
      await waitForExecutionCount(ruleId, before + 1)
      const exec = await lastExecution(ruleId)
      expect(exec?.steps?.[0]?.status).toBe('failed')
      expect(String(exec?.steps?.[0]?.error ?? '')).toMatch(/fwb_rejected:permission_gates/)
      const state = await stateFor(instanceC, ruleId)
      expect(state.claims).toBe(0)
      const count = await q('SELECT COUNT(*)::int AS c FROM meta_records WHERE sheet_id = $1', [SHEET_ID])
      expect(Number((count.rows[0] as { c: number }).c)).toBe(2) // unchanged from the previous test
    } finally {
      setFlags(false, false)
      await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`, [CREATOR])
      await q('UPDATE users SET is_admin = TRUE WHERE id = $1', [CREATOR])
      invalidateUserPerms(CREATOR)
    }
  })

  test('durable FWB infrastructure failure stays reclaimable instead of being marked done', async () => {
    const ruleId = ruleIds[0]
    const eventId = `evt_fwbact_${TS}_retryable`
    const originalExecuteRule = svc.executeRule.bind(svc)
    ;(svc as unknown as { executeRule: AutomationService['executeRule'] }).executeRule = async () => ({
      id: `axe_${randomUUID()}`,
      ruleId,
      triggeredBy: 'event',
      triggeredAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      duration: 1,
      status: 'failed',
      error: 'fwb_execution_failed',
      steps: [{ actionType: 'write_approval_form_values', status: 'failed', error: 'fwb_execution_failed' }],
    } as never)
    setFlags(true, true)
    try {
      await expect(svc.handleApprovalCompletionTrigger(completionEvent(randomUUID(), eventId)))
        .rejects.toThrow(/approval_completed_trigger_retryable_failure/)
      const fire = await q(
        `SELECT status FROM meta_automation_event_fires
          WHERE rule_id = $1 AND dedup_key = $2`,
        [ruleId, `approval.completed:${eventId}`],
      )
      expect((fire.rows[0] as { status?: string } | undefined)?.status).toBe('in_progress')
    } finally {
      ;(svc as unknown as { executeRule: AutomationService['executeRule'] }).executeRule = originalExecuteRule
      setFlags(false, false)
    }
  })

  // ── Executor-level goldens that require seam control (still real DB, real executor, real FWB core) ──

  function executorRule(ruleId: string, actions: Array<{ type: string; config: Record<string, unknown> }>): ExecutorRule {
    return {
      id: ruleId,
      name: 'fwb executor golden',
      sheetId: SHEET_ID,
      trigger: { type: 'approval.completed', config: { templateId } } as never,
      actions: actions as never,
      enabled: true,
      createdBy: CREATOR,
      createdAt: new Date().toISOString(),
    }
  }

  function triggerPayload(instanceId: string, eventId: string): Record<string, unknown> {
    return {
      sheetId: SHEET_ID,
      recordId: '',
      data: {},
      actorId: null,
      _automationDepth: 0,
      eventId,
      eventType: 'approval.approved',
      approval: { instanceId, templateId, templateVersionId },
      transition: { action: 'approve', fromStatus: 'pending', toStatus: 'approved' },
      requester: { id: REQUESTER, name: REQUESTER },
    }
  }

  const allowAllGates: FwbGateChecks = {
    isAdmin: async () => true,
    canManageSheetAccess: async () => true,
    canReadTemplate: async () => true,
    canWriteSheet: async () => true,
    canWriteTargetFields: async () => true,
    hasRecordedConfirmation: async () => true,
  }

  const realTransaction: NonNullable<AutomationDeps['transaction']> = async (handler) =>
    poolManager.get().transaction(async ({ query }) => handler({
      query: async (sqlText: string, params?: unknown[]) => {
        const result = await query(sqlText, params)
        return {
          rows: Array.isArray((result as { rows?: unknown[] }).rows) ? (result as { rows: unknown[] }).rows : [],
          rowCount: typeof (result as { rowCount?: number }).rowCount === 'number' ? (result as { rowCount: number }).rowCount : undefined,
        }
      },
    }))

  function buildExecutor(overrides: Partial<AutomationDeps> & { omitTransaction?: boolean; omitGates?: boolean } = {}) {
    const deps: AutomationDeps = {
      eventBus: { emit: () => {}, subscribe: () => () => {} } as never,
      queryFn: (sqlText: string, params?: unknown[]) => poolManager.get().query(sqlText, params) as never,
      ...(overrides.omitTransaction ? {} : { transaction: overrides.transaction ?? realTransaction }),
      ...(overrides.omitGates ? {} : { fwbGateChecks: overrides.fwbGateChecks ?? allowAllGates }),
    }
    return new AutomationExecutor(deps)
  }

  const fwbAction = () => ({
    type: 'write_approval_form_values',
    config: fwbConfig() as Record<string, unknown>,
  })

  test('ATOMICITY golden: injected post-handler abort erases record + revision + claim + outbox together; no-injection control commits all four', async () => {
    setFlags(true, true)
    try {
      const instanceD = await startInstance({ summary: 'atomic', amount: 3 })
      await approveInstance(instanceD)
      const ruleId = `rule_fwbact_atomic_${TS}`
      let inject = true
      const injectingTransaction: NonNullable<AutomationDeps['transaction']> = async (handler) =>
        realTransaction(async (client) => {
          const result = await handler(client)
          if (inject) throw new Error('injected post-handler abort host=db.internal user=secret_owner')
          return result
        })
      const executor = buildExecutor({ transaction: injectingTransaction })

      const beforeCount = Number(((await q('SELECT COUNT(*)::int AS c FROM meta_records WHERE sheet_id = $1', [SHEET_ID])).rows[0] as { c: number }).c)
      const run1 = await executor.execute(executorRule(ruleId, [fwbAction()]), triggerPayload(instanceD, `evt_fwbact_${TS}_atomic1`))
      expect(run1.steps[0]?.status).toBe('failed')
      expect(String(run1.steps[0]?.error ?? '')).toBe('fwb_execution_failed')
      expect(String(run1.steps[0]?.error ?? '')).not.toMatch(/db\.internal|secret_owner|injected/)
      // all four gone together: no record, no revision (checked via record absence), no claim, no outbox
      const afterAbort = Number(((await q('SELECT COUNT(*)::int AS c FROM meta_records WHERE sheet_id = $1', [SHEET_ID])).rows[0] as { c: number }).c)
      expect(afterAbort).toBe(beforeCount)
      expect((await stateFor(instanceD, ruleId)).claims).toBe(0)
      expect(await outboxCountLike(`evt_fwbact_${TS}_atomic1::fwb::`)).toBe(0)

      // positive control on the SAME identity: without injection the retry commits all four together
      inject = false
      const run2 = await executor.execute(executorRule(ruleId, [fwbAction()]), triggerPayload(instanceD, `evt_fwbact_${TS}_atomic2`))
      expect(run2.steps[0]?.status).toBe('success')
      const state = await stateFor(instanceD, ruleId)
      expect(state.claims).toBe(1)
      const created = (run2.steps[0]?.output as { recordId?: string })?.recordId ?? ''
      expect(created).toBeTruthy()
      expect(await revisionCountFor(created)).toBe(1)
      expect(await outboxCountLike(`evt_fwbact_${TS}_atomic2::fwb::`)).toBe(1)
      await q('DELETE FROM meta_records WHERE id = $1', [created])
      await q('DELETE FROM meta_record_revisions WHERE record_id = $1', [created])
      await q('DELETE FROM meta_fwb_action_applied WHERE rule_id = $1', [ruleId])
    } finally {
      setFlags(false, false)
    }
  })

  test('fail-closed defaults: unbound gates → permission_gates reject; missing transaction seam → refusal; ad-hoc dispatch (no identity) → refusal — all with zero writes', async () => {
    setFlags(true, true)
    try {
      const instanceE = await startInstance({ summary: 'failclosed', amount: 9 })
      await approveInstance(instanceE)
      const before = Number(((await q('SELECT COUNT(*)::int AS c FROM meta_records WHERE sheet_id = $1', [SHEET_ID])).rows[0] as { c: number }).c)

      // (a) NO fwbGateChecks injected → DEFAULT_DENY_FWB_GATES: every leg denies (kills a default-allow mutant)
      const noGates = buildExecutor({ omitGates: true })
      const runA = await noGates.execute(executorRule(`rule_fwbact_nogates_${TS}`, [fwbAction()]), triggerPayload(instanceE, `evt_fwbact_${TS}_ng`))
      expect(runA.steps[0]?.status).toBe('failed')
      expect(String(runA.steps[0]?.error ?? '')).toMatch(/fwb_rejected:permission_gates/)

      // (b) NO transaction seam → hard refusal BEFORE any statement (withTransaction autocommit fallback hazard)
      const noTxn = buildExecutor({ omitTransaction: true })
      const runB = await noTxn.execute(executorRule(`rule_fwbact_notxn_${TS}`, [fwbAction()]), triggerPayload(instanceE, `evt_fwbact_${TS}_nt`))
      expect(runB.steps[0]?.status).toBe('failed')
      expect(String(runB.steps[0]?.error ?? '')).toMatch(/transaction seam/)

      // (c) ad-hoc single-action dispatch carries no Class-A identity → out of contract (lock D11)
      const executor = buildExecutor({})
      const runC = await executor.runSingleAction(fwbAction() as never, {
        executionId: `axe_${randomUUID()}`,
        ruleId: `rule_fwbact_adhoc_${TS}`,
        sheetId: SHEET_ID,
        recordId: '',
        recordData: {},
        ruleCreatedBy: CREATOR,
        actorId: null,
        triggerEvent: triggerPayload(instanceE, `evt_fwbact_${TS}_ah`),
      })
      expect(runC.status).toBe('failed')
      expect(String(runC.error ?? '')).toMatch(/rule-execution identity/)

      // (d) the event's frozen template version must match the explicitly confirmed config version.
      const staleEvent = triggerPayload(instanceE, `evt_fwbact_${TS}_stale_version`)
      ;(staleEvent.approval as Record<string, unknown>).templateVersionId = randomUUID()
      const runD = await executor.execute(
        executorRule(`rule_fwbact_stalever_${TS}`, [fwbAction()]),
        staleEvent,
      )
      expect(runD.steps[0]?.status).toBe('failed')
      expect(String(runD.steps[0]?.error ?? '')).toBe('fwb_rejected:source_template_version')

      const after = Number(((await q('SELECT COUNT(*)::int AS c FROM meta_records WHERE sheet_id = $1', [SHEET_ID])).rows[0] as { c: number }).c)
      expect(after).toBe(before)
      expect((await stateFor(instanceE, `rule_fwbact_nogates_${TS}`)).claims).toBe(0)
    } finally {
      setFlags(false, false)
    }
  })

  test('structural-path identity: two byte-identical FWB actions in ONE rule claim DISTINCT action_keys and both apply (config-hash identity would dedup one)', async () => {
    setFlags(true, true)
    try {
      const instanceF = await startInstance({ summary: 'twins', amount: 5 })
      await approveInstance(instanceF)
      const ruleId = `rule_fwbact_twins_${TS}`
      const executor = buildExecutor({})
      const run = await executor.execute(
        executorRule(ruleId, [fwbAction(), fwbAction()]), // byte-identical configs
        triggerPayload(instanceF, `evt_fwbact_${TS}_tw`),
      )
      expect(run.steps[0]?.status).toBe('success')
      expect(run.steps[1]?.status).toBe('success')
      expect(run.steps[1]?.alreadyApplied).not.toBe(true)
      const led = await q('SELECT action_key FROM meta_fwb_action_applied WHERE instance_id = $1 AND rule_id = $2', [instanceF, ruleId])
      expect(led.rows.length).toBe(2)
      const keys = led.rows.map((r) => (r as { action_key: string }).action_key)
      expect(new Set(keys).size).toBe(2) // distinct structural paths → distinct keys
      const ids = run.steps.map((s) => (s.output as { recordId?: string })?.recordId).filter(Boolean) as string[]
      expect(new Set(ids).size).toBe(2)
      for (const id of ids) {
        await q('DELETE FROM meta_record_revisions WHERE record_id = $1', [id])
        await q('DELETE FROM meta_records WHERE id = $1', [id])
      }
      await q('DELETE FROM meta_fwb_action_applied WHERE rule_id = $1', [ruleId])
    } finally {
      setFlags(false, false)
    }
  })

  test('cross-rule event identity: two rules at the same structural path emit distinct chained event ids', async () => {
    setFlags(true, true)
    try {
      const instanceG = await startInstance({ summary: 'two rules', amount: 6 })
      await approveInstance(instanceG)
      const eventId = `evt_fwbact_${TS}_two_rules`
      const executor = buildExecutor({})
      const ruleA = `rule_fwbact_a_${TS}`
      const ruleB = `rule_fwbact_b_${TS}`
      const runA = await executor.execute(executorRule(ruleA, [fwbAction()]), triggerPayload(instanceG, eventId))
      const runB = await executor.execute(executorRule(ruleB, [fwbAction()]), triggerPayload(instanceG, eventId))
      expect(runA.steps[0]?.status).toBe('success')
      expect(runB.steps[0]?.status).toBe('success')
      const outbox = await q(
        'SELECT event_id FROM meta_automation_outbox WHERE event_id LIKE $1 ORDER BY event_id',
        [`${eventId}::fwb::%`],
      )
      const eventIds = outbox.rows.map((row) => String((row as { event_id: string }).event_id))
      expect(eventIds).toHaveLength(2)
      expect(new Set(eventIds).size).toBe(2)
      expect(eventIds.some((id) => id.includes(`::${ruleA}::`))).toBe(true)
      expect(eventIds.some((id) => id.includes(`::${ruleB}::`))).toBe(true)

      const recordIds = [runA, runB]
        .map((run) => (run.steps[0]?.output as { recordId?: string } | undefined)?.recordId)
        .filter((id): id is string => typeof id === 'string')
      for (const recordId of recordIds) {
        await q('DELETE FROM meta_record_revisions WHERE record_id = $1', [recordId])
        await q('DELETE FROM meta_records WHERE id = $1', [recordId])
      }
      await q('DELETE FROM meta_fwb_action_applied WHERE rule_id = ANY($1::text[])', [[ruleA, ruleB]])
    } finally {
      setFlags(false, false)
    }
  })
})
