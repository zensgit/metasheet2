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
import { randomBytes, randomUUID } from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { db } from '../../src/db/db'
import { eventBus as integrationEventBus } from '../../src/integration/events/event-bus'
import { AutomationService } from '../../src/multitable/automation-service'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'
import { AutomationExecutor, type AutomationDeps, type AutomationRule as ExecutorRule } from '../../src/multitable/automation-executor'
import { deriveFwbConfirmationHash } from '../../src/multitable/approval-fwb-activation'
import { canReadApprovalTemplateForAutomation } from '../../src/multitable/automation-approval-template-access'
import type { FwbGateChecks } from '../../src/multitable/approval-fwb-permission-gates'
import { invalidateUserPerms } from '../../src/rbac/service'
import type { TransactionalQueryable } from '../../src/multitable/pg-transaction-guard'
import { createAutomationReadRecordConditions } from '../../src/integration/automation-read-record-conditions'
import { bootstrapOwnedApprovalAfterImageSchema } from '../utils/automation-approval-after-image-schema'
import { up as addFwbClaims } from '../../src/db/migrations/zzzz20260715200000_create_fwb_action_applied'
import { up as addFwbAction } from '../../src/db/migrations/zzzz20260720120000_add_write_approval_form_values_automation_action'
import { up as addEventFires } from '../../src/db/migrations/zzzz20260701120000_create_automation_event_fires'
import { up as addEventFireLease } from '../../src/db/migrations/zzzz20260716140000_event_fires_lease'
import { up as addAuditLogs } from '../../src/db/migrations/20250926_create_operation_audit_logs'
import { up as hardenAuditLogs } from '../../src/db/migrations/zzzz20260209100000_fix_operation_audit_logs_schema'

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
const SOURCE_READER = `u_fwbact_source_reader_${TS}`

const q = (sqlText: string, params?: unknown[]) => poolManager.get().query(sqlText, params)
const queryFn = ((sqlText: string, params?: unknown[]) => poolManager.get().query(sqlText, params)) as never

let svc: AutomationService
let approvals: ApprovalProductService
let templateId = ''
let templateVersionId = ''
const ruleIds: string[] = []

const MAPPINGS = [
  { formFieldId: 'summary', targetFieldId: F_TITLE, targetType: 'text' as const },
]
const NUMBER_MAPPINGS = [
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

async function recordConfirmationReceipt(
  actorId = CREATOR,
  mappings: unknown = MAPPINGS,
  sourceVersionId = templateVersionId,
): Promise<void> {
  const confirmationHash = confirmation(mappings, sourceVersionId)
  await q(
    `INSERT INTO operation_audit_logs
       (actor_id, actor_type, action, resource_type, resource_id, metadata, meta)
     VALUES ($1, 'user', 'automation.fwb_confirm', 'automation_fwb_confirmation', $2, $3::jsonb, $3::jsonb)`,
    [actorId, SHEET_ID, JSON.stringify({ confirmationHash })],
  )
}

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
        // M-1(ii) (approval-lock8-field-vocabulary-20260817.md §3): carries every L8-C
        // formatted-number display prop so the file's EXISTING number-mapping assertions below
        // (save gate ~:371, setRuleEnabled bypass ~:543, execute-time guard ~:714) double as
        // real save+execute proof that a formatted-number SOURCE field does not weaken the
        // `exact_number_mapping_unavailable` stop rule — props are display-only (M10) and never
        // reach `hasUnavailableFwbNumberMapping`, which only inspects the mapping's `targetType`.
        {
          id: 'amount', type: 'number', label: 'Amount', required: true,
          props: { currencySymbol: '¥', thousandsSeparator: true, uppercaseCny: true, precision: 2 },
        },
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
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_TITLE, SHEET_ID, 'Title', 'string', '{}', 1])
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
    for (const uid of [CREATOR, REQUESTER, APPROVER, SOURCE_READER]) {
      await q(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
         VALUES ($1, $2, $1, 'x', 'user', '[]'::jsonb, TRUE, $3)
         ON CONFLICT (id) DO UPDATE SET is_active = TRUE, is_admin = EXCLUDED.is_admin`,
        [uid, `${uid}@fwbact.test`, uid === CREATOR],
      )
    }
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:read') ON CONFLICT DO NOTHING`, [CREATOR])
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:read') ON CONFLICT DO NOTHING`, [SOURCE_READER])
    // rbac/service.isAdmin reads user_roles(role_id='admin') — the platform-admin leg Q6 G1 binds to.
    await q(`INSERT INTO roles (id, name) VALUES ('admin', 'admin') ON CONFLICT (id) DO NOTHING`).catch(() => {})
    await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`, [CREATOR])
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
    const activeVersion = await q('SELECT active_version_id FROM approval_templates WHERE id = $1', [templateId])
    templateVersionId = String((activeVersion.rows[0] as { active_version_id: string }).active_version_id)

    await recordConfirmationReceipt()

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
    await q(
      `DELETE FROM operation_audit_logs
        WHERE action = 'automation.fwb_confirm' AND resource_type = 'automation_fwb_confirmation' AND resource_id = $1`,
      [SHEET_ID],
    ).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('save gate requires an actor-bound server receipt, not a reproducible digest alone', async () => {
    const hash = confirmation()
    await q(
      `DELETE FROM operation_audit_logs
        WHERE actor_id = $1
          AND action = 'automation.fwb_confirm'
          AND resource_type = 'automation_fwb_confirmation'
          AND resource_id = $2
          AND metadata->>'confirmationHash' = $3`,
      [CREATOR, SHEET_ID, hash],
    )
    try {
      await expect(svc.createRule(SHEET_ID, {
        name: 'calculated digest without receipt',
        triggerType: 'approval.completed',
        triggerConfig: { templateId, outcomes: ['approved'] },
        actionType: 'write_approval_form_values',
        actionConfig: fwbConfig(),
        createdBy: CREATOR,
      } as never)).rejects.toThrow(/actor-bound server confirmation receipt/)
    } finally {
      await recordConfirmationReceipt()
    }
  })

  test('source-template authorization uses one injected DB view for permission and visibility', async () => {
    try {
      expect(await canReadApprovalTemplateForAutomation(queryFn, templateId, SOURCE_READER)).toBe(true)

      await q(
        'UPDATE approval_templates SET visibility_scope = $2::jsonb WHERE id = $1',
        [templateId, JSON.stringify({ type: 'user', ids: [REQUESTER] })],
      )
      expect(await canReadApprovalTemplateForAutomation(queryFn, templateId, SOURCE_READER)).toBe(false)

      await q(
        'UPDATE approval_templates SET visibility_scope = $2::jsonb WHERE id = $1',
        [templateId, JSON.stringify({ type: 'all', ids: [] })],
      )
      await q(
        `DELETE FROM user_permissions WHERE user_id = $1 AND permission_code = 'approvals:read'`,
        [SOURCE_READER],
      )
      expect(await canReadApprovalTemplateForAutomation(queryFn, templateId, SOURCE_READER)).toBe(false)

      await q(
        `INSERT INTO user_permissions (user_id, permission_code)
         VALUES ($1, 'approvals:read') ON CONFLICT DO NOTHING`,
        [SOURCE_READER],
      )
      expect(await canReadApprovalTemplateForAutomation(queryFn, 'missing-template', SOURCE_READER)).toBe(false)
    } finally {
      await q(
        'UPDATE approval_templates SET visibility_scope = $2::jsonb WHERE id = $1',
        [templateId, JSON.stringify({ type: 'all', ids: [] })],
      )
      await q(
        `INSERT INTO user_permissions (user_id, permission_code)
         VALUES ($1, 'approvals:read') ON CONFLICT DO NOTHING`,
        [SOURCE_READER],
      )
    }
  })

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
    const dup = [MAPPINGS[0], { ...MAPPINGS[0] }]
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
    // Exact decimal semantics are not yet end-to-end across ordinary multitable
    // writers/readers, so number mappings stay server-disabled independently of flags.
    await expect(svc.createRule(SHEET_ID, {
      ...fwbBase,
      actionConfig: fwbConfig(NUMBER_MAPPINGS),
    } as never)).rejects.toThrow(/exact_number_mapping_unavailable/)
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
    await expect(svc.updateRule(tempId, SHEET_ID, { enabled: false }))
      .rejects.toThrow(/authenticated authoring actor/)
    await expect(svc.updateRule(tempId, SHEET_ID, { enabled: false }, REQUESTER))
      .rejects.toThrow(/creator, modifier, or enabler/)
    const ownerUpdate = await svc.updateRule(tempId, SHEET_ID, { enabled: false }, CREATOR)
    expect(ownerUpdate?.enabled).toBe(false)

    // Audit receipts are retention-bounded. An unchanged, server-validated persisted hash remains
    // maintainable after its receipt expires, while any changed confirmation subject still requires
    // a fresh actor-bound receipt.
    const persistedHash = confirmation()
    await q(
      `DELETE FROM operation_audit_logs
        WHERE actor_id = $1
          AND action = 'automation.fwb_confirm'
          AND resource_type = 'automation_fwb_confirmation'
          AND resource_id = $2
          AND COALESCE(meta->>'confirmationHash', metadata->>'confirmationHash') = $3`,
      [CREATOR, SHEET_ID, persistedHash],
    )
    try {
      const maintained = await svc.updateRule(tempId, SHEET_ID, { name: 'receipt expired, config unchanged' }, CREATOR)
      expect(maintained?.name).toBe('receipt expired, config unchanged')
      await expect(svc.updateRule(tempId, SHEET_ID, { enabled: true }, CREATOR))
        .rejects.toThrow(/actor-bound server confirmation receipt/)

      const changedMappings = [
        { formFieldId: 'summary', targetFieldId: F_STATUS, targetType: 'select' as const, selectOptions: ['A'] },
      ]
      await expect(svc.updateRule(tempId, SHEET_ID, {
        actionConfig: fwbConfig(changedMappings),
      }, CREATOR)).rejects.toThrow(/actor-bound server confirmation receipt/)
    } finally {
      await recordConfirmationReceipt()
    }
    const reenabled = await svc.updateRule(tempId, SHEET_ID, { enabled: true }, CREATOR)
    expect(reenabled?.enabled).toBe(true)
    const disabledAgain = await svc.updateRule(tempId, SHEET_ID, { enabled: false }, CREATOR)
    expect(disabledAgain?.enabled).toBe(false)

    // The same canonical field guard used by record writes rejects a per-subject read-only target.
    await q(
      `INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only)
       VALUES ($1,$2,'user',$3,true,true)`,
      [SHEET_ID, F_TITLE, CREATOR],
    )
    try {
      await expect(svc.updateRule(tempId, SHEET_ID, { name: 'must revalidate fields' }, CREATOR))
        .rejects.toThrow(/target fields that are not writable/)
    } finally {
      await q(
        `DELETE FROM field_permissions
          WHERE sheet_id = $1 AND field_id = $2 AND subject_type = 'user' AND subject_id = $3`,
        [SHEET_ID, F_TITLE, CREATOR],
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

  test('legacy number-mapped rule cannot bypass the resulting-shape gate through setRuleEnabled', async () => {
    const ruleId = `atr_fwbact_legacy_number_${TS}`
    ruleIds.push(ruleId)
    await q(
      `INSERT INTO automation_rules
        (id, sheet_id, name, trigger_type, trigger_config, action_type, action_config, enabled, created_by)
       VALUES ($1,$2,$3,'approval.completed',$4::jsonb,'write_approval_form_values',$5::jsonb,false,$6)`,
      [
        ruleId,
        SHEET_ID,
        'legacy exact-number rule',
        JSON.stringify({ templateId, outcomes: ['approved'] }),
        JSON.stringify(fwbConfig(NUMBER_MAPPINGS)),
        CREATOR,
      ],
    )

    await expect(svc.setRuleEnabled(ruleId, SHEET_ID, true, CREATOR))
      .rejects.toThrow(/exact_number_mapping_unavailable/)
    const persisted = await q('SELECT enabled FROM automation_rules WHERE id = $1', [ruleId])
    expect(persisted.rows[0]).toMatchObject({ enabled: false })
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
    const probeSubscriptionId = integrationEventBus.subscribe('multitable.record.created', (payload) => {
      const p = payload as Record<string, unknown>
      if (typeof p._eventId === 'string' && p._eventId.startsWith(`${evtOn}::fwb::`)) legacyChainedEmits += 1
    })
    try {
      await svc.handleApprovalCompletionTrigger(completionEvent(instanceId, evtOn))
      await waitForExecutionCount(ruleId, 3)
      exec = await lastExecution(ruleId)
      expect(exec?.steps?.[0]?.status).toBe('success')
      state = await stateFor(instanceId, ruleId)
      expect(state.records.length).toBe(1)
      expect(state.claims).toBe(1)
      expect(state.records[0].data).toMatchObject({ [F_TITLE]: 'FWB run' })
      expect(state.records[0].data).not.toHaveProperty(F_AMOUNT)
      expect(await revisionCountFor(state.records[0].id)).toBe(1)
      expect(await outboxCountLike(`${evtOn}::fwb::`)).toBe(1)
      expect(legacyChainedEmits).toBe(0) // REPLACE, not keep-both
    } finally {
      integrationEventBus.unsubscribe(probeSubscriptionId)
    }

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

  test('execute-time canonical target-field gate rejects a field made read-only after save, with zero writes', async () => {
    const ruleId = ruleIds[0]
    const instanceId = await startInstance({ summary: 'field revoked', amount: 4 })
    await approveInstance(instanceId)
    const beforeExecutions = await waitForExecutionCount(ruleId, 0)
    const beforeRecords = Number(((await q(
      'SELECT COUNT(*)::int AS c FROM meta_records WHERE sheet_id = $1',
      [SHEET_ID],
    )).rows[0] as { c: number }).c)
    await q(
      `INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only)
       VALUES ($1,$2,'user',$3,true,true)`,
      [SHEET_ID, F_TITLE, CREATOR],
    )
    try {
      setFlags(true, true)
      await svc.handleApprovalCompletionTrigger(completionEvent(instanceId, `evt_fwbact_${TS}_field_revoked`))
      await waitForExecutionCount(ruleId, beforeExecutions + 1)
      const exec = await lastExecution(ruleId)
      expect(exec?.steps?.[0]?.status).toBe('failed')
      expect(String(exec?.steps?.[0]?.error ?? '')).toMatch(/fwb_rejected:permission_gates/)
      expect((await stateFor(instanceId, ruleId)).claims).toBe(0)
      const afterRecords = Number(((await q(
        'SELECT COUNT(*)::int AS c FROM meta_records WHERE sheet_id = $1',
        [SHEET_ID],
      )).rows[0] as { c: number }).c)
      expect(afterRecords).toBe(beforeRecords)
    } finally {
      setFlags(false, false)
      await q(
        `DELETE FROM field_permissions
          WHERE sheet_id = $1 AND field_id = $2 AND subject_type = 'user' AND subject_id = $3`,
        [SHEET_ID, F_TITLE, CREATOR],
      )
    }
  })

  test('execute-time guard rejects a legacy persisted number mapping before claim or record write', async () => {
    const ruleId = ruleIds[0]
    const instanceId = await startInstance({ summary: 'number stop rule', amount: 12.345 })
    await approveInstance(instanceId)
    const beforeExecutions = await waitForExecutionCount(ruleId, 0)
    const beforeRecords = Number(((await q(
      'SELECT COUNT(*)::int AS c FROM meta_records WHERE sheet_id = $1',
      [SHEET_ID],
    )).rows[0] as { c: number }).c)
    await q('UPDATE automation_rules SET action_config = $1::jsonb WHERE id = $2', [
      JSON.stringify(fwbConfig(NUMBER_MAPPINGS)),
      ruleId,
    ])
    try {
      setFlags(true, true)
      await svc.handleApprovalCompletionTrigger(completionEvent(instanceId, `evt_fwbact_${TS}_number_stop`))
      await waitForExecutionCount(ruleId, beforeExecutions + 1)
      const exec = await lastExecution(ruleId)
      expect(exec?.steps?.[0]?.status).toBe('failed')
      expect(String(exec?.steps?.[0]?.error ?? '')).toBe('fwb_rejected:exact_number_mapping_unavailable')
      expect((await stateFor(instanceId, ruleId)).claims).toBe(0)
      const afterRecords = Number(((await q(
        'SELECT COUNT(*)::int AS c FROM meta_records WHERE sheet_id = $1',
        [SHEET_ID],
      )).rows[0] as { c: number }).c)
      expect(afterRecords).toBe(beforeRecords)
    } finally {
      setFlags(false, false)
      await q('UPDATE automation_rules SET action_config = $1::jsonb WHERE id = $2', [
        JSON.stringify(fwbConfig(MAPPINGS)),
        ruleId,
      ])
    }
  })

  test('execute-time select recheck uses confirmed-current intersection; additions require re-confirmation (D6/Q6)', async () => {
    // A dedicated rule whose select mapping's SAVED selectOptions include 'B' (valid at save time).
    const selectMappings = [{ formFieldId: 'summary', targetFieldId: F_STATUS, targetType: 'select' as const, selectOptions: ['A', 'B'] }]
    await recordConfirmationReceipt(CREATOR, selectMappings)
    const rule = await svc.createRule(SHEET_ID, {
      name: 'fwb select staleness',
      triggerType: 'approval.completed',
      triggerConfig: { templateId, outcomes: ['approved'] },
      actionType: 'write_approval_form_values',
      actionConfig: fwbConfig(selectMappings),
      createdBy: CREATOR,
    } as never)
    const ruleId = (rule as { id: string }).id
    ruleIds.push(ruleId)
    // Per-rule write observability: the main MAPPINGS rule fires on the SAME completions, so sheet-wide
    // record counts and unqualified outbox prefixes are NOT discriminating — every "zero writes" and
    // "exactly one record" assertion below is scoped to THIS rule via the ledger (instance-scoped claim
    // precedes the record write in the same txn) and the rule-qualified outbox event id.
    const ruleOutbox = async (eventPrefix: string) => {
      const r = await q('SELECT payload FROM meta_automation_outbox WHERE event_id LIKE $1', [`${eventPrefix}::fwb::${ruleId}::%`])
      return r.rows as Array<{ payload: { recordId?: string } }>
    }
    const before = await waitForExecutionCount(ruleId, 0)
    setFlags(true, true)
    try {
      // 1) option REMOVED from the field after save: the stale saved mapping still lists 'B', but the
      //    execute-time recheck re-derives options from meta_fields → 'B' is rejected, zero writes.
      await q('UPDATE meta_fields SET property = $1::jsonb WHERE id = $2', [JSON.stringify({ options: [{ value: 'A' }] }), F_STATUS])
      const removedInstance = await startInstance({ summary: 'B', amount: 1 })
      await approveInstance(removedInstance)
      await svc.handleApprovalCompletionTrigger(completionEvent(removedInstance, `evt_fwbact_${TS}_sel_removed`))
      await waitForExecutionCount(ruleId, before + 1)
      let exec = await lastExecution(ruleId)
      expect(exec?.steps?.[0]?.status).toBe('failed')
      expect(String(exec?.steps?.[0]?.error ?? '')).toBe('fwb_rejected:mapping')
      expect((await stateFor(removedInstance, ruleId)).claims).toBe(0)
      expect(await ruleOutbox(`evt_fwbact_${TS}_sel_removed`)).toEqual([])

      // 2) an option ADDED after save is not in the confirmation subject and must reject. Replacing
      //    the saved options with the complete current set would silently widen a confirmed mapping.
      await q('UPDATE meta_fields SET property = $1::jsonb WHERE id = $2', [JSON.stringify({ options: [{ value: 'A' }, { value: 'C' }] }), F_STATUS])
      const addedInstance = await startInstance({ summary: 'C', amount: 2 })
      await approveInstance(addedInstance)
      await svc.handleApprovalCompletionTrigger(completionEvent(addedInstance, `evt_fwbact_${TS}_sel_added`))
      await waitForExecutionCount(ruleId, before + 2)
      exec = await lastExecution(ruleId)
      expect(exec?.steps?.[0]?.status).toBe('failed')
      expect(String(exec?.steps?.[0]?.error ?? '')).toBe('fwb_rejected:mapping')
      expect((await stateFor(addedInstance, ruleId)).claims).toBe(0)
      expect(await ruleOutbox(`evt_fwbact_${TS}_sel_added`)).toEqual([])

      // Positive control: update the persisted mapping to include C with a fresh server-derived
      // confirmation hash. The same value is now authorized and writes exactly once.
      const reconfirmedMappings = [{ formFieldId: 'summary', targetFieldId: F_STATUS, targetType: 'select' as const, selectOptions: ['A', 'C'] }]
      await recordConfirmationReceipt(CREATOR, reconfirmedMappings)
      await svc.updateRule(ruleId, SHEET_ID, {
        actionConfig: fwbConfig(reconfirmedMappings),
      }, CREATOR)
      const reconfirmedInstance = await startInstance({ summary: 'C', amount: 2 })
      await approveInstance(reconfirmedInstance)
      await svc.handleApprovalCompletionTrigger(completionEvent(reconfirmedInstance, `evt_fwbact_${TS}_sel_reconfirmed`))
      await waitForExecutionCount(ruleId, before + 3)
      exec = await lastExecution(ruleId)
      expect(exec?.steps?.[0]?.status).toBe('success')
      expect((await stateFor(reconfirmedInstance, ruleId)).claims).toBe(1)
      const reconfirmedOutbox = await ruleOutbox(`evt_fwbact_${TS}_sel_reconfirmed`)
      expect(reconfirmedOutbox.length).toBe(1)
      const recordId = reconfirmedOutbox[0].payload.recordId
      const record = await q('SELECT data FROM meta_records WHERE id = $1', [recordId])
      expect((record.rows[0] as { data: Record<string, unknown> }).data).toEqual({ [F_STATUS]: 'C' })

      // 3) options ABSENT from the field metadata → fail closed BEFORE the claim (no open vocabulary).
      await q('UPDATE meta_fields SET property = $1::jsonb WHERE id = $2', ['{}', F_STATUS])
      const absentInstance = await startInstance({ summary: 'A', amount: 3 })
      await approveInstance(absentInstance)
      await svc.handleApprovalCompletionTrigger(completionEvent(absentInstance, `evt_fwbact_${TS}_sel_absent`))
      await waitForExecutionCount(ruleId, before + 4)
      exec = await lastExecution(ruleId)
      expect(exec?.steps?.[0]?.status).toBe('failed')
      expect(String(exec?.steps?.[0]?.error ?? '')).toBe('fwb_rejected:mapping_target_changed')
      expect((await stateFor(absentInstance, ruleId)).claims).toBe(0)
      expect(await ruleOutbox(`evt_fwbact_${TS}_sel_absent`)).toEqual([])
    } finally {
      setFlags(false, false)
      await q('UPDATE meta_fields SET property = $1::jsonb WHERE id = $2', [JSON.stringify({ options: [{ value: 'A' }, { value: 'B' }] }), F_STATUS])
    }
  })

  test('durable FWB infrastructure failure stays reclaimable instead of being marked done', async () => {
    const ruleId = ruleIds[0]
    const eventId = `evt_fwbact_${TS}_retryable`
    const originalExecuteRule = svc.executeRule.bind(svc)
    const executionSubject = svc as unknown as { executeRule: AutomationService['executeRule'] }
    executionSubject.executeRule = async () => ({
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
      executionSubject.executeRule = originalExecuteRule
      setFlags(false, false)
    }
  })

  test('deterministic missing-instance refusal settles instead of retrying forever', async () => {
    const ruleId = ruleIds[0]
    const eventId = `evt_fwbact_${TS}_missing_instance`
    setFlags(true, true)
    try {
      await expect(svc.handleApprovalCompletionTrigger(completionEvent(randomUUID(), eventId)))
        .resolves.toBeUndefined()
      const fire = await q(
        `SELECT status FROM meta_automation_event_fires
          WHERE rule_id = $1 AND dedup_key = $2`,
        [ruleId, `approval.completed:${eventId}`],
      )
      expect((fire.rows[0] as { status?: string } | undefined)?.status).toBe('done')
      const exec = await lastExecution(ruleId)
      expect(exec?.steps?.[0]?.status).toBe('failed')
      expect(String(exec?.steps?.[0]?.error ?? '')).toBe('fwb_rejected:instance_not_found')
    } finally {
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

/** Producer/public-trigger boundary: completion bytes come from a real durable approval, not the
 * synthetic completionEvent helper above. The confirmation receipt is synthetic test storage;
 * owner HTTP admission and durable consumer-to-preview routing are covered by the authority suite.
 * This group deliberately does not claim the original migrated-database group ran on an empty DB.
 */
describeIfDatabase('SA06AM FWB create after-image', () => {
  const schema = 'automation_approval_image_' + randomBytes(8).toString('hex')
  const transport: Array<{ mockRestore(): void }> = []
  const metricsObservers: Array<{ mock: { results: Array<{ type: string; value: unknown }> }; mockRestore(): void }> = []
  let ownedPool: Pool, ownedDb: Kysely<unknown>, created = false
  let service: AutomationService, product: ApprovalProductService

  async function drainMetrics(): Promise<void> {
    let observedCount: number
    do {
      const returned = metricsObservers.flatMap(observed => observed.mock.results
        .filter(result => result.type === 'return' && result.value instanceof Promise)
        .map(result => result.value as Promise<unknown>))
      observedCount = returned.length
      await Promise.allSettled(returned)
    } while (metricsObservers.reduce((count, observed) => count + observed.mock.results
      .filter(result => result.type === 'return' && result.value instanceof Promise).length, 0) !== observedCount)
  }

  beforeAll(async () => {
    ownedPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8,
      options: '-c search_path=' + schema + ' -c statement_timeout=8000' })
    await ownedPool.query('CREATE SCHEMA "' + schema + '"')
    created = true
    ownedDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: ownedPool }) })
    const infrastructure = poolManager.get(), originalPool = infrastructure.getInternalPool()
    // Forward actual IO, retaining production transaction BEGIN/COMMIT and the exact seam object.
    transport.push(vi.spyOn(originalPool, 'connect').mockImplementation(ownedPool.connect.bind(ownedPool)))
    transport.push(vi.spyOn(originalPool, 'query').mockImplementation(ownedPool.query.bind(ownedPool)))
    transport.push(vi.spyOn(infrastructure, 'query').mockImplementation((statement, params) => ownedPool.query(statement, params)))
    transport.push(vi.spyOn(infrastructure, 'getInternalPool').mockReturnValue(ownedPool))
    await bootstrapOwnedApprovalAfterImageSchema({ db: ownedDb, query: (statement, params) => ownedPool.query(statement, params), mode: 'empty' })
    for (const migration of [addFwbClaims, addFwbAction, addEventFires, addEventFireLease, addAuditLogs, hardenAuditLogs]) {
      await ownedDb.transaction().execute(migration)
    }
    const { getApprovalMetricsService } = await import('../../src/services/ApprovalMetricsService')
    const metrics = getApprovalMetricsService()
    // Observe through: original methods, original returned promises, no fabricated metric results.
    metricsObservers.push(vi.spyOn(metrics, 'recordInstanceStart'), vi.spyOn(metrics, 'recordNodeDecision'), vi.spyOn(metrics, 'recordTerminal'))
    await q('INSERT INTO meta_bases(id,name,owner_id) VALUES($1,$2,$3)', [BASE_ID, 'Synthetic FWB image base', CREATOR])
    await q('INSERT INTO meta_sheets(id,base_id,name) VALUES($1,$2,$3)', [SHEET_ID, BASE_ID, 'Synthetic FWB image sheet'])
    await q('INSERT INTO meta_fields(id,sheet_id,name,type,property,"order") VALUES($1,$2,$3,$4,$5::jsonb,1)',
      [F_TITLE, SHEET_ID, 'Synthetic title', 'string', '{}'])
    for (const uid of [CREATOR, REQUESTER, APPROVER]) {
      await q(`INSERT INTO users(id,email,name,password_hash,role,permissions,is_active,is_admin)
        VALUES($1,$2,$1,'synthetic','user','[]',true,$3)`, [uid, uid + '@synthetic.test', uid === CREATOR])
    }
    await q("INSERT INTO roles(id,name) VALUES('admin','admin')")
    await q("INSERT INTO user_roles(user_id,role_id) VALUES($1,'admin')", [CREATOR])
    for (const [uid, permission] of [[CREATOR, 'approvals:read'], [CREATOR, 'multitable:read'],
      [REQUESTER, 'approvals:write'], [APPROVER, 'approvals:act']]) {
      await q('INSERT INTO user_permissions(user_id,permission_code) VALUES($1,$2)', [uid, permission])
      await invalidateUserPerms(uid)
    }
    await q("INSERT INTO user_orgs(user_id,org_id,is_active) VALUES($1,'default',true)", [REQUESTER])
    product = new ApprovalProductService()
    // No init/subscription: invoke the public trigger once using the persisted approval receipt.
    service = new AutomationService(integrationEventBus, db as never, queryFn)
    metricsObservers.push(vi.spyOn(service, 'sweepEventDedupLedger'))
  }, 30000)
  beforeEach(() => {
    vi.stubEnv('APPROVAL_FWB_WRITEBACK_ENABLED', 'true')
    vi.stubEnv('AUTOMATION_DURABLE_DELIVERY_ENABLED', 'true')
  })
  afterEach(async () => { try { await drainMetrics() } finally { vi.unstubAllEnvs() } })
  afterAll(async () => {
    try {
      await service?.shutdown()
      await drainMetrics()
      if (created) {
        expect(schema).toMatch(/^automation_approval_image_[a-f0-9]{16}$/u)
        expect((await ownedPool.query('SELECT current_schema() AS schema')).rows).toEqual([{ schema }])
        await ownedPool.query('DROP SCHEMA "' + schema + '" CASCADE')
      }
    } finally {
      for (const observed of metricsObservers.reverse()) observed.mockRestore()
      for (const spy of transport.reverse()) spy.mockRestore()
      if (ownedDb) await ownedDb.destroy()
      else await ownedPool?.end()
    }
  })

  async function completedApproval(summary: string) {
    const template = await product.createTemplate({ ...approvalTemplateRequest(),
      key: 'sa06am-' + randomUUID(), visibilityScope: { type: 'all', ids: [] } } as never)
    await product.publishTemplate(template.id, { policy: { allowRevoke: true } } as never)
    const versionId = String((await q('SELECT active_version_id FROM approval_templates WHERE id=$1', [template.id])).rows[0].active_version_id)
    const confirmationHash = deriveFwbConfirmationHash({ templateId: template.id, sourceTemplateVersionId: versionId,
      targetBaseId: BASE_ID, targetSheetId: SHEET_ID, mappings: MAPPINGS })
    await q(`INSERT INTO operation_audit_logs(actor_id,actor_type,action,resource_type,resource_id,metadata,meta)
      VALUES($1,'user','automation.fwb_confirm','automation_fwb_confirmation',$2,$3::jsonb,$3::jsonb)`,
    [CREATOR, SHEET_ID, JSON.stringify({ confirmationHash })])
    const rule = await service.createRule(SHEET_ID, { name: 'Synthetic FWB RETURNING',
      triggerType: 'approval.completed', triggerConfig: { templateId: template.id, outcomes: ['approved'] },
      actionType: 'write_approval_form_values', actionConfig: { mappings: MAPPINGS, sourceTemplateVersionId: versionId, confirmationHash },
      createdBy: CREATOR } as never)
    const instance = await product.createApproval({ templateId: template.id, formData: { summary, amount: 1 } },
      { userId: REQUESTER, userName: REQUESTER })
    await product.dispatchAction(instance.id, { action: 'approve', comment: 'synthetic approval' } as never,
      { userId: APPROVER, userName: APPROVER })
    const completion = await q(`SELECT payload FROM meta_automation_outbox WHERE event_type='approval.approved'
      AND payload->'approval'->>'instanceId'=$1`, [instance.id])
    expect(completion.rows).toHaveLength(1)
    const event = completion.rows[0].payload as Parameters<AutomationService['handleApprovalCompletionTrigger']>[0]
    expect(event).toMatchObject({ source: 'approval-product', eventType: 'approval.approved',
      approval: { instanceId: instance.id, templateId: template.id, templateVersionId: versionId },
      transition: { toStatus: 'approved' } })
    expect((await q('SELECT status FROM approval_instances WHERE id=$1', [instance.id])).rows)
      .toEqual([{ status: 'approved' }])
    await drainMetrics()
    return { ruleId: rule.id, instanceId: instance.id, event }
  }
  async function execution(ruleId: string) {
    const result = await q(`SELECT status,error,steps FROM multitable_automation_executions
      WHERE rule_id=$1 ORDER BY triggered_at DESC,id DESC LIMIT 1`, [ruleId])
    expect(result.rows).toHaveLength(1)
    return result.rows[0] as { status: string; error: string | null; steps: Array<Record<string, unknown>> }
  }
  async function totals() {
    return (await q(`SELECT (SELECT count(*)::int FROM meta_records) AS records,
      (SELECT count(*)::int FROM meta_record_revisions) AS revisions,
      (SELECT count(*)::int FROM meta_fwb_action_applied) AS claims,
      (SELECT count(*)::int FROM meta_automation_record_after_images) AS images,
      (SELECT count(*)::int FROM meta_automation_outbox WHERE event_type='multitable.record.created') AS events`)).rows[0]
  }
  async function imageForRule(ruleId: string) {
    const images = await q(`SELECT i.*,o.payload,o.event_id AS receipt_event_id,o.event_type AS receipt_event_type,
      o.automation_depth,octet_length(i.after_image::text) AS pg_bytes,o.xmin::text AS event_xmin
      FROM meta_automation_record_after_images i JOIN meta_automation_outbox o ON o.id=i.outbox_id
      WHERE o.event_id LIKE $1`, ['%::fwb::' + ruleId + '::%'])
    expect(images.rows).toHaveLength(1)
    return images.rows[0]
  }
  async function condition(image: Record<string, unknown>, value: string) {
    const ruleId = 'sa06am_condition_' + randomUUID()
    await q(`INSERT INTO automation_rules(id,sheet_id,name,trigger_type,action_type,created_by,conditions)
      VALUES($1,$2,'Synthetic image condition','record.created','send_webhook',$3,$4::jsonb)`,
    [ruleId, SHEET_ID, CREATOR, JSON.stringify({ logic: 'and', conditions: [{ fieldId: F_TITLE, operator: 'equals', value }] })])
    const conditions = createAutomationReadRecordConditions({ businessTimeZone: 'Asia/Shanghai' })
    return poolManager.get().transaction(async actual => {
      const trx: TransactionalQueryable = { isTransaction: true, query: async (statement, params) => actual.query(statement, params) }
      const locked = await conditions.lock(trx, { actorId: CREATOR, ruleId, sheetId: SHEET_ID, baseId: BASE_ID })
      return conditions.evaluate(trx, locked, { outboxId: String(image.outbox_id), eventId: String(image.event_id), eventType: 'multitable.record.created' })
    })
  }
  async function dropTrigger(name: string, table: string) {
    await q(`DROP TRIGGER IF EXISTS ${name}_trg ON ${table}`)
    await q(`DROP FUNCTION IF EXISTS ${name}()`)
  }

  test('actual RETURNING full image, receipt bytes/version/schema-before-DML and one-xid commit; duplicate has no new effects', async () => {
    const run = await completedApproval('synthetic input')
    const trigger = 'sa06am_returning_' + randomBytes(6).toString('hex')
    const emits = vi.spyOn(integrationEventBus, 'emit')
    try {
      await q(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN
          IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND relation='meta_fields'::regclass
            AND mode='ShareLock' AND granted) THEN RAISE EXCEPTION 'SA06AM_SCHEMA_NOT_BEFORE_DML'; END IF;
          NEW.data:=NEW.data || jsonb_build_object('${F_TITLE}','synthetic PG returned',
            'synthetic_extra','not in input','synthetic_capture_xid',pg_current_xact_id()::text);
          NEW.version:=7;
          RETURN NEW;
        END $fn$`)
      await q(`CREATE TRIGGER ${trigger}_trg BEFORE INSERT ON meta_records FOR EACH ROW EXECUTE FUNCTION ${trigger}()`)
      await service.handleApprovalCompletionTrigger(run.event)
      const exec = await execution(run.ruleId)
      expect(exec.steps, JSON.stringify(exec)).toMatchObject([{ status: 'success', actionType: 'write_approval_form_values' }])
      const image = await imageForRule(run.ruleId)
      const record = (await q('SELECT data,version,xmin::text AS record_xmin FROM meta_records WHERE id=$1', [image.record_id])).rows[0]
      expect(image).toMatchObject({ status: 'captured', reason: null, record_version: '7', after_image: record.data,
        capture_xid: record.data.synthetic_capture_xid, event_type: 'multitable.record.created',
        receipt_event_type: 'multitable.record.created', automation_depth: 1 })
      expect(record.version).toBe(7)
      expect(record.data).toMatchObject({ [F_TITLE]: 'synthetic PG returned', synthetic_extra: 'not in input' })
      expect(image.captured_bytes).toBe(image.pg_bytes)
      expect(image.captured_bytes).toBeGreaterThan(0)
      expect(image.event_id).toBe(image.receipt_event_id)
      expect(image.payload).toEqual({ sheetId: SHEET_ID, recordId: image.record_id })
      expect(image.schema_revision).toBe((await q(`SELECT revision::text FROM automation_read_material_epochs
        WHERE kind='sheet' AND scope=jsonb_build_object('id',$1::text)`, [SHEET_ID])).rows[0].revision)
      const revisions = await q('SELECT version,patch,snapshot,actor_id,xmin::text AS revision_xmin FROM meta_record_revisions WHERE record_id=$1', [image.record_id])
      expect(revisions.rows).toHaveLength(1)
      // Birth history deliberately retains existing input semantics; only the private image is RETURNING.
      expect(revisions.rows[0]).toMatchObject({ version: 1, patch: { [F_TITLE]: 'synthetic input' },
        snapshot: { [F_TITLE]: 'synthetic input' }, actor_id: CREATOR })
      const claims = await q('SELECT xmin::text AS claim_xmin FROM meta_fwb_action_applied WHERE instance_id=$1 AND rule_id=$2', [run.instanceId, run.ruleId])
      expect(claims.rows).toHaveLength(1)
      const xid = (BigInt(String(image.capture_xid)) % 4294967296n).toString()
      expect([record.record_xmin, revisions.rows[0].revision_xmin, image.event_xmin, claims.rows[0].claim_xmin])
        .toEqual([xid, xid, xid, xid])
      expect(await condition(image, 'synthetic PG returned')).toEqual({ kind: 'match' })
      expect(emits.mock.calls.filter(call => call[0] === 'multitable.record.created')).toHaveLength(0)
      const before = await totals()
      // New transport identity bypasses event-level dedup and exercises the real instance/action claim.
      await service.handleApprovalCompletionTrigger({ ...run.event, eventId: 'sa06am_replay_' + randomUUID() })
      expect(await totals()).toEqual(before)
      expect((await execution(run.ruleId)).steps).toMatchObject([{ status: 'success', alreadyApplied: true }])
    } finally {
      try { await dropTrigger(trigger, 'meta_records') } finally { emits.mockRestore() }
    }
  }, 20000)

  test('private image INSERT failure rolls back five effects; manual new-event retry after recovery commits once', async () => {
    const run = await completedApproval('synthetic rollback'), before = await totals()
    const trigger = 'sa06am_failure_' + randomBytes(6).toString('hex')
    try {
      await q(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN RAISE EXCEPTION 'SA06AM_IMAGE_INSERT_FAILURE'; END $fn$`)
      await q(`CREATE TRIGGER ${trigger}_trg BEFORE INSERT ON meta_automation_record_after_images
        FOR EACH ROW EXECUTE FUNCTION ${trigger}()`)
      await expect(service.handleApprovalCompletionTrigger(run.event)).rejects.toThrow('approval_completed_trigger_retryable_failure')
      expect((await execution(run.ruleId)).steps).toMatchObject([{ status: 'failed', error: 'fwb_execution_failed' }])
      expect(await totals()).toEqual(before)
      expect((await q('SELECT id FROM meta_fwb_action_applied WHERE instance_id=$1 AND rule_id=$2', [run.instanceId, run.ruleId])).rows).toHaveLength(0)
      expect((await q('SELECT status FROM meta_automation_event_fires WHERE rule_id=$1 AND dedup_key=$2',
        [run.ruleId, 'approval.completed:' + run.event.eventId])).rows).toEqual([{ status: 'in_progress' }])
      await dropTrigger(trigger, 'meta_automation_record_after_images')
      // Explicit manual transport-identity change, NOT proof the original leased consumer retried.
      // The same instance/action business claim was rolled back and is still eligible to apply.
      await service.handleApprovalCompletionTrigger({ ...run.event, eventId: 'sa06am_retry_' + randomUUID() })
      expect((await execution(run.ruleId)).steps).toMatchObject([{ status: 'success' }])
      expect(await totals()).toEqual(Object.fromEntries(Object.entries(before).map(([key, count]) => [key, Number(count) + 1])))
      expect((await imageForRule(run.ruleId)).status).toBe('captured')
    } finally { await dropTrigger(trigger, 'meta_automation_record_after_images') }
  }, 20000)

  test('real schema NOWAIT 55P03 preserves ordinary create but NULL schema cannot supply condition evidence', async () => {
    const run = await completedApproval('synthetic nowait'), holder = await ownedPool.connect()
    const infrastructure = poolManager.get()
    const originalTransaction = infrastructure.transaction.bind(infrastructure)
    type ActualTransactionClient = Parameters<Parameters<typeof infrastructure.transaction>[0]>[0]
    const observations: Array<{ statement: string; settled: PromiseSettledResult<unknown> }> = []
    const queryTrace: Array<{ statement: string; promiseReturn: boolean; thenableReturn: boolean }> = []
    // ConnectionPool.transaction wraps the actual PG client's query(config), whose concrete Client
    // prototype may differ from pg's named export. Observe its real promise-returning transaction
    // query instead, forwarding the unchanged callback object and original return/error semantics.
    const observedTransaction = async <T>(handler: (actual: ActualTransactionClient) => Promise<T>): Promise<T> =>
      originalTransaction(async actual => {
        const originalQuery = actual.query
        const observationTasks: Promise<void>[] = []
        // Vitest may retain a settled value/throw in mock.results instead of the original promise.
        // Attach observation at invocation time, returning that exact original promise unchanged.
        const observedQuery: typeof actual.query = (...args: Parameters<typeof actual.query>) => {
          const sqlOrConfig: unknown = args[0]
          const statement = typeof sqlOrConfig === 'string' ? sqlOrConfig
            : sqlOrConfig !== null && typeof sqlOrConfig === 'object' && 'text' in sqlOrConfig
              && typeof sqlOrConfig.text === 'string' ? sqlOrConfig.text : ''
          const returned = originalQuery(...args) as Promise<unknown>
          queryTrace.push({ statement, promiseReturn: returned instanceof Promise,
            thenableReturn: returned !== null && typeof returned === 'object' && 'then' in returned })
          if (/LOCK TABLE meta_sheets, meta_fields|ROLLBACK TO SAVEPOINT automation_record_schema_capture/u.test(statement)) {
            observationTasks.push(returned.then(value => {
              observations.push({ statement, settled: { status: 'fulfilled', value } })
            }, reason => {
              observations.push({ statement, settled: { status: 'rejected', reason } })
            }))
          }
          return returned
        }
        const queries = vi.spyOn(actual, 'query').mockImplementation(observedQuery)
        try { return await handler(actual) } finally {
          try { await Promise.allSettled(observationTasks) } finally { queries.mockRestore() }
        }
      })
    const transactions = vi.spyOn(infrastructure, 'transaction').mockImplementation(observedTransaction)
    try {
      await holder.query('BEGIN')
      // Compatible with existing FOR SHARE's ROW SHARE; conflicts only with capture SHARE.
      await holder.query('LOCK TABLE meta_fields IN SHARE UPDATE EXCLUSIVE MODE')
      await service.handleApprovalCompletionTrigger(run.event)
      const exec = await execution(run.ruleId)
      const imageState = await q(`SELECT i.status,i.schema_revision FROM meta_automation_record_after_images i
        JOIN meta_automation_outbox o ON o.id=i.outbox_id WHERE o.event_id LIKE $1`, ['%::fwb::' + run.ruleId + '::%'])
      const diagnostic = JSON.stringify({ execution: { status: exec.status, error: exec.error,
        steps: exec.steps.map(step => ({ actionType: step.actionType, status: step.status, error: step.error })) },
      images: imageState.rows, calls: { transactions: transactions.mock.calls.length, queries: queryTrace.length,
        captureLocks: queryTrace.filter(call => /LOCK TABLE meta_sheets, meta_fields/u.test(call.statement)).length,
        rollbacks: queryTrace.filter(call => call.statement === 'ROLLBACK TO SAVEPOINT automation_record_schema_capture').length,
        promiseReturns: queryTrace.filter(call => call.promiseReturn).length,
        thenableReturns: queryTrace.filter(call => call.thenableReturn).length, settled: observations.length },
      stages: observations.map(observed => ({
        stage: /LOCK TABLE meta_sheets, meta_fields/u.test(observed.statement) ? 'capture_lock' : 'capture_rollback',
        status: observed.settled.status,
        code: observed.settled.status === 'rejected' ? (observed.settled.reason as { code?: unknown })?.code : undefined,
      })) })
      expect(exec.steps, diagnostic).toMatchObject([{ status: 'success' }])
      expect(imageState.rows, diagnostic).toEqual([{ status: 'captured', schema_revision: null }])
      const locks = observations.filter(observed => /LOCK TABLE meta_sheets, meta_fields/u.test(observed.statement))
      expect(locks, diagnostic).toHaveLength(1)
      expect(locks[0].settled, diagnostic).toMatchObject({ status: 'rejected', reason: { code: '55P03' } })
      const rollbacks = observations.filter(observed => observed.statement === 'ROLLBACK TO SAVEPOINT automation_record_schema_capture')
      expect(rollbacks, diagnostic).toHaveLength(1)
      expect(rollbacks[0].settled.status, diagnostic).toBe('fulfilled')
      await holder.query('ROLLBACK')
      const image = await imageForRule(run.ruleId)
      expect(image).toMatchObject({ status: 'captured', schema_revision: null, after_image: { [F_TITLE]: 'synthetic nowait' } })
      expect(await condition(image, 'synthetic nowait')).toEqual({ kind: 'unreadable', reason: 'AFTER_IMAGE_UNAVAILABLE' })
    } finally {
      try { await holder.query('ROLLBACK') } finally {
        try { holder.release() } finally { transactions.mockRestore() }
      }
    }
  }, 20000)

  test.each([{ label: 'OFF', fwb: 'false', durable: 'true', status: 'skipped' },
    { label: 'half-durable', fwb: 'true', durable: 'false', status: 'failed' }])('$label preserves the old zero-write contract', async flags => {
    const run = await completedApproval('synthetic flag control'), before = await totals()
    vi.stubEnv('APPROVAL_FWB_WRITEBACK_ENABLED', flags.fwb)
    vi.stubEnv('AUTOMATION_DURABLE_DELIVERY_ENABLED', flags.durable)
    await service.handleApprovalCompletionTrigger(run.event)
    const exec = await execution(run.ruleId)
    expect(exec.steps, JSON.stringify(exec)).toMatchObject([{ status: flags.status }])
    if (flags.status === 'failed') expect(String(exec.steps[0]?.error)).toMatch(/AUTOMATION_DURABLE_DELIVERY_ENABLED/u)
    expect(await totals()).toEqual(before)
  }, 15000)
})
