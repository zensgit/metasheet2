/**
 * FWB-2 production `write_approval_form_values` mode:'update' wiring (real DB).
 *
 * Proves the production dispatch surface (not pure seams alone):
 *   - save gate: mode contract, recordLinkFieldId, schema-derived target (never client ids),
 *     confirmation-hash binding (update mode + recordLinkFieldId + derived target; create hashes
 *     stay byte-compatible), edit authority (not create) on the derived target;
 *   - same-base update happy path through AutomationExecutor → executeUpdateBoundRecord;
 *   - exact linked-record extraction (malformed → fwb_rejected:linked_record, zero writes);
 *   - cross-base deny (rule creator lacks target base write) / allow;
 *   - locked / deleted / write-revoked fail closed behind one non-oracular error code;
 *   - duplicate net-once under a new eventId;
 *   - rollback atomicity (injected post-handler abort erases claim + update + revision + outbox);
 *   - discriminating mutation target (updates bound record A, never sibling record B).
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
import {
  AutomationExecutor,
  type AutomationDeps,
  type AutomationRule as ExecutorRule,
} from '../../src/multitable/automation-executor'
import {
  buildProductionFwbGateChecks,
  collectPersistedFwbActions,
  deriveFwbConfirmationHash,
} from '../../src/multitable/approval-fwb-activation'
import { recheckFwbPermissionGates, type FwbGateChecks } from '../../src/multitable/approval-fwb-permission-gates'
import { resolveSheetCapabilitiesForUser } from '../../src/multitable/sheet-capabilities'
import { isAdmin as rbacIsAdmin, invalidateUserPerms } from '../../src/rbac/service'
import { isAdminOnQuery } from '../../src/services/approval-record-link-txn-auth'
import { fenceWriterEntriesInOrder } from '../../src/multitable/canonical-sheet-fence'
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

const TS = randomUUID().replace(/-/g, '')
const RULE_BASE = `base_fwb2r_${TS}`
const RULE_SHEET = `sheet_fwb2r_${TS}`
const TARGET_BASE = `base_fwb2t_${TS}`
const TARGET_SHEET = `sheet_fwb2t_${TS}`
const SECONDARY_SHEET = `sheet_fwb2s_${TS}`
const CROSS_BASE = `base_fwb2x_${TS}`
const CROSS_SHEET = `sheet_fwb2x_${TS}`
const F_TITLE = `fld_fwb2_title_${TS}`
const F_AMOUNT = `fld_fwb2_amount_${TS}`
const F_SECONDARY_TITLE = `fld_fwb2s_title_${TS}`
const F_CROSS_TITLE = `fld_fwb2x_title_${TS}`
const CREATOR = `u_fwb2_creator_${TS}`
const REQUESTER = `u_fwb2_req_${TS}`
const APPROVER = `u_fwb2_appr_${TS}`
const REC_A = `rec_fwb2_a_${TS}`
const REC_B = `rec_fwb2_b_${TS}`
const REC_CROSS = `rec_fwb2_x_${TS}`

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

function setFlags(fwb: boolean, durable: boolean) {
  if (fwb) process.env.APPROVAL_FWB_WRITEBACK_ENABLED = 'true'
  else delete process.env.APPROVAL_FWB_WRITEBACK_ENABLED
  if (durable) process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = 'true'
  else delete process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED
}

function setWriterFence(enabled: boolean) {
  if (enabled) process.env.MULTITABLE_ENABLE_WRITER_FENCE = 'true'
  else delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
}

function updateConfirmation(
  mappings: unknown = MAPPINGS,
  sourceVersionId = templateVersionId,
  targetBaseId = TARGET_BASE,
  targetSheetId = TARGET_SHEET,
  recordLinkFieldId = 'linked',
) {
  return deriveFwbConfirmationHash({
    templateId,
    sourceTemplateVersionId: sourceVersionId,
    targetBaseId,
    targetSheetId,
    mappings: mappings as never,
    mode: 'update',
    recordLinkFieldId,
  })
}

function updateConfig(
  over: {
    mappings?: unknown
    sourceVersionId?: string
    targetBaseId?: string
    targetSheetId?: string
    recordLinkFieldId?: string
    confirmationHash?: string
    mode?: unknown
  } = {},
) {
  const mappings = over.mappings ?? MAPPINGS
  const sourceVersionId = over.sourceVersionId ?? templateVersionId
  const recordLinkFieldId = over.recordLinkFieldId ?? 'linked'
  const targetBaseId = over.targetBaseId ?? TARGET_BASE
  const targetSheetId = over.targetSheetId ?? TARGET_SHEET
  return {
    mode: over.mode === undefined ? 'update' : over.mode,
    recordLinkFieldId,
    mappings,
    sourceTemplateVersionId: sourceVersionId,
    confirmationHash: over.confirmationHash ?? updateConfirmation(
      mappings,
      sourceVersionId,
      targetBaseId,
      targetSheetId,
      recordLinkFieldId,
    ),
  }
}

async function recordConfirmationReceipt(
  confirmationHash: string,
  actorId = CREATOR,
): Promise<void> {
  await q(
    `INSERT INTO operation_audit_logs
       (actor_id, actor_type, action, resource_type, resource_id, metadata, meta)
     VALUES ($1, 'user', 'automation.fwb_confirm', 'automation_fwb_confirmation', $2, $3::jsonb, $3::jsonb)`,
    [actorId, RULE_SHEET, JSON.stringify({ confirmationHash })],
  )
}

function approvalTemplateRequest(linkBaseId: string, linkSheetId: string) {
  return {
    key: `fwb2-${TS}`,
    name: 'FWB-2 Update Template',
    formSchema: {
      fields: [
        { id: 'summary', type: 'text', label: 'Summary', required: true },
        // M-1(ii) (approval-lock8-field-vocabulary-20260817.md §3): every L8-C formatted-number
        // display prop, so this file's existing `exact_number_mapping_unavailable` assertion
        // (~:532) doubles as save-time proof that a formatted-number SOURCE field does not weaken
        // the stop rule — props are display-only (M10), invisible to `hasUnavailableFwbNumberMapping`.
        {
          id: 'amount', type: 'number', label: 'Amount', required: true,
          props: { currencySymbol: '¥', thousandsSeparator: true, uppercaseCny: true, precision: 2 },
        },
        {
          id: 'linked',
          type: 'record-link',
          label: 'Bound record',
          required: true,
          props: { baseId: linkBaseId, sheetId: linkSheetId },
        },
        {
          id: 'linked_secondary',
          type: 'record-link',
          label: 'Secondary bound record',
          required: false,
          props: { baseId: TARGET_BASE, sheetId: SECONDARY_SHEET },
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
  await approvals.dispatchAction(
    instanceId,
    { action: 'approve', comment: 'ok' } as never,
    { userId: APPROVER, userName: APPROVER },
  )
}

function executorRule(ruleId: string, actionConfig: Record<string, unknown>): ExecutorRule {
  return {
    id: ruleId,
    name: 'fwb2 update rule',
    sheetId: RULE_SHEET,
    trigger: { type: 'approval.completed', config: { templateId } } as never,
    actions: [{ type: 'write_approval_form_values', config: actionConfig }] as never,
    enabled: true,
    createdBy: CREATOR,
    createdAt: new Date().toISOString(),
  }
}

function triggerPayload(instanceId: string, eventId: string): Record<string, unknown> {
  return {
    sheetId: RULE_SHEET,
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

const productionGateFactory: NonNullable<AutomationDeps['fwbGateChecksFactory']> = (transactionQuery) =>
  buildProductionFwbGateChecks({
    queryFn: transactionQuery,
    isAdminFn: (userId) => isAdminOnQuery(transactionQuery, userId),
    // Source-template visibility is independently covered by the approval.completed trigger suite;
    // this file keeps that leg true while exercising transaction-bound target/field/action authority.
    canReadTemplateFn: async () => true,
  })

const realTransaction: NonNullable<AutomationDeps['transaction']> = async (handler) =>
  poolManager.get().transaction(async ({ query }) => handler({
    query: async (sqlText: string, params?: unknown[]) => {
      const result = await query(sqlText, params)
      return {
        rows: Array.isArray((result as { rows?: unknown[] }).rows) ? (result as { rows: unknown[] }).rows : [],
        rowCount: typeof (result as { rowCount?: number }).rowCount === 'number'
          ? (result as { rowCount: number }).rowCount
          : undefined,
      }
    },
  }))

function buildExecutor(overrides: Partial<AutomationDeps> = {}) {
  const deps: AutomationDeps = {
    eventBus: { emit: () => {}, subscribe: () => () => {} } as never,
    queryFn: (sqlText: string, params?: unknown[]) => poolManager.get().query(sqlText, params) as never,
    transaction: overrides.transaction ?? realTransaction,
    fwbGateChecks: overrides.fwbGateChecks ?? allowAllGates,
    ...overrides,
  }
  return new AutomationExecutor(deps)
}

async function claimCount(instanceId: string, ruleId: string): Promise<number> {
  const r = await q(
    'SELECT COUNT(*)::int AS c FROM meta_fwb_action_applied WHERE instance_id = $1 AND rule_id = $2',
    [instanceId, ruleId],
  )
  return Number((r.rows[0] as { c: number }).c)
}

async function outboxCountLike(prefix: string): Promise<number> {
  const r = await q('SELECT COUNT(*)::int AS c FROM meta_automation_outbox WHERE event_id LIKE $1', [`${prefix}%`])
  return Number((r.rows[0] as { c: number }).c)
}

async function revisionCount(recordId: string, action = 'update'): Promise<number> {
  const r = await q(
    'SELECT COUNT(*)::int AS c FROM meta_record_revisions WHERE record_id = $1 AND action = $2 AND source = $3',
    [recordId, action, 'automation'],
  )
  return Number((r.rows[0] as { c: number }).c)
}

async function recordData(recordId: string): Promise<Record<string, unknown> | null> {
  const r = await q('SELECT data FROM meta_records WHERE id = $1', [recordId])
  const row = r.rows[0] as { data?: unknown } | undefined
  if (!row) return null
  return (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) as Record<string, unknown>
}

async function waitForRecordLockWaiter(holderPid: number): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const result = await q(
      `SELECT COUNT(*)::int AS c
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query ILIKE '%SELECT id FROM meta_records%FOR UPDATE%'
          AND $1 = ANY(pg_blocking_pids(pid))`,
      [holderPid],
    )
    if (Number((result.rows[0] as { c?: unknown } | undefined)?.c ?? 0) > 0) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('FWB-2 executor never blocked on its SELECT ... FOR UPDATE behind the test holder')
}

async function waitForAuthorityLockWaiter(holderPid: number): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const result = await q(
      `SELECT COUNT(*)::int AS c
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query ILIKE '%SELECT permission_code FROM user_permissions%FOR SHARE%'
          AND $1 = ANY(pg_blocking_pids(pid))`,
      [holderPid],
    )
    if (Number((result.rows[0] as { c?: unknown } | undefined)?.c ?? 0) > 0) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('FWB-2 executor never blocked on the transaction-bound authority lock')
}

async function waitForFieldPermissionTableLockWaiter(holderPid: number): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const result = await q(
      `SELECT COUNT(*)::int AS c
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query ILIKE '%LOCK TABLE field_permissions IN SHARE MODE%'
          AND $1 = ANY(pg_blocking_pids(pid))`,
      [holderPid],
    )
    if (Number((result.rows[0] as { c?: unknown } | undefined)?.c ?? 0) > 0) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('FWB-2 executor never blocked behind the field-permission phantom writer')
}

describeIfDatabase('FWB-2 production write_approval_form_values mode:update (real DB)', () => {
  beforeAll(async () => {
    setFlags(false, false)
    // REQUESTER owns target bases so record-link submit base-read passes (owner path) without a
    // multitable:base:read seed that full migrations may not provide.
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1,$2,$3)', [RULE_BASE, 'FWB2 Rule Base', REQUESTER])
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1,$2,$3)', [TARGET_BASE, 'FWB2 Target Base', REQUESTER])
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1,$2,$3)', [CROSS_BASE, 'FWB2 Cross Base', REQUESTER])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [RULE_SHEET, RULE_BASE, 'FWB2 Rule Sheet'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [TARGET_SHEET, TARGET_BASE, 'FWB2 Target Sheet'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SECONDARY_SHEET, TARGET_BASE, 'FWB2 Secondary Sheet'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [CROSS_SHEET, CROSS_BASE, 'FWB2 Cross Sheet'])
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [F_TITLE, TARGET_SHEET, 'Title', 'text', '{}', 1],
    )
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [F_AMOUNT, TARGET_SHEET, 'Amount', 'number', '{}', 2],
    )
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [F_SECONDARY_TITLE, SECONDARY_SHEET, 'Secondary Title', 'text', '{}', 1],
    )
    await q(
      'INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [F_CROSS_TITLE, CROSS_SHEET, 'Title', 'text', '{}', 1],
    )
    // Discriminating targets: A is bound by the form; B must never be mutated.
    await q(
      `INSERT INTO meta_records (id, sheet_id, data, version, created_by)
       VALUES ($1,$2,$3::jsonb,1,$4), ($5,$2,$6::jsonb,1,$4)`,
      [
        REC_A, TARGET_SHEET, JSON.stringify({ [F_TITLE]: 'before-A', [F_AMOUNT]: 1 }), CREATOR,
        REC_B, JSON.stringify({ [F_TITLE]: 'before-B', [F_AMOUNT]: 99 }),
      ],
    )
    await q(
      `INSERT INTO meta_records (id, sheet_id, data, version, created_by)
       VALUES ($1,$2,$3::jsonb,1,$4)`,
      [REC_CROSS, CROSS_SHEET, JSON.stringify({ [F_CROSS_TITLE]: 'cross-before' }), CREATOR],
    )

    await q(
      `INSERT INTO permissions (code, name, description)
       VALUES ('approvals:read', 'Approvals Read', 'FWB2'),
              ('approvals:write', 'Approvals Write', 'FWB2'),
              ('approvals:act', 'Approvals Act', 'FWB2'),
              ('multitable:write', 'Multitable Write', 'FWB2'),
              ('multitable:read', 'Multitable Read', 'FWB2'),
              ('multitable:share', 'Multitable Share', 'FWB2'),
              ('multitable:base:read', 'Multitable Base Read', 'FWB2')
       ON CONFLICT (code) DO NOTHING`,
    )
    for (const uid of [CREATOR, REQUESTER, APPROVER]) {
      await q(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
         VALUES ($1, $2, $1, 'x', 'user', '[]'::jsonb, TRUE, $3)
         ON CONFLICT (id) DO UPDATE SET is_active = TRUE, is_admin = EXCLUDED.is_admin`,
        [uid, `${uid}@fwb2.test`, false],
      )
    }
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:read') ON CONFLICT DO NOTHING`, [CREATOR])
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'multitable:write') ON CONFLICT DO NOTHING`, [CREATOR])
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'multitable:read') ON CONFLICT DO NOTHING`, [CREATOR])
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'multitable:share') ON CONFLICT DO NOTHING`, [CREATOR])
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'multitable:base:read') ON CONFLICT DO NOTHING`, [CREATOR])
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:write') ON CONFLICT DO NOTHING`, [REQUESTER])
    // Lock-11 §10 arm (a) fixture delta: REQUESTER needs exactly one active
    // user_orgs membership or the real createApproval/startApproval call below 422s
    // (APPROVAL_ORG_UNRESOLVED) before this suite's own assertions run.
    await q(`INSERT INTO user_orgs (user_id, org_id, is_active) VALUES ($1, 'default', TRUE) ON CONFLICT (user_id, org_id) DO UPDATE SET is_active = TRUE`, [REQUESTER])
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:read') ON CONFLICT DO NOTHING`, [REQUESTER])
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'multitable:read') ON CONFLICT DO NOTHING`, [REQUESTER])
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:act') ON CONFLICT DO NOTHING`, [APPROVER])
    // Sheet-scoped read for the filler on every record-link target (belt-and-suspenders with multitable:read).
    for (const sheet of [TARGET_SHEET, CROSS_SHEET]) {
      try {
        await q(
          `INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code)
           VALUES ($1, 'user', $2, 'spreadsheet:read')`,
          [sheet, REQUESTER],
        )
      } catch {
        await q(
          `INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code)
           VALUES ($1, $2, 'user', $2, 'spreadsheet:read')`,
          [sheet, REQUESTER],
        )
      }
    }
    invalidateUserPerms(CREATOR)
    invalidateUserPerms(REQUESTER)

    approvals = new ApprovalProductService()
    // Same-base-of-truth for the default template: record-link pins TARGET_SHEET (may differ from rule sheet).
    // TARGET_BASE may equal RULE_BASE for same-base legs — here they differ so cross-base is testable,
    // but same-base path is exercised by evaluating gate when bases match. For same-base update we
    // keep TARGET on its base and place the rule sheet on the same base for the happy path.
    // Re-home rule sheet onto TARGET_BASE so same-base update is the primary happy path.
    await q('UPDATE meta_sheets SET base_id = $1 WHERE id = $2', [TARGET_BASE, RULE_SHEET])

    const template = await approvals.createTemplate(
      approvalTemplateRequest(TARGET_BASE, TARGET_SHEET) as never,
    )
    templateId = (template as { id: string }).id
    await approvals.publishTemplate(templateId, {
      policy: { allowRevoke: true },
      actorUserId: CREATOR,
    } as never)
    const activeVersion = await q('SELECT active_version_id FROM approval_templates WHERE id = $1', [templateId])
    templateVersionId = String((activeVersion.rows[0] as { active_version_id: string }).active_version_id)

    await recordConfirmationReceipt(updateConfirmation())

    svc = new AutomationService(integrationEventBus, db as never, queryFn)
  })

  afterAll(async () => {
    setFlags(false, false)
    setWriterFence(false)
    try { svc?.shutdown() } catch { /* noop */ }
    for (const ruleId of ruleIds) {
      await q('DELETE FROM automation_rules WHERE id = $1', [ruleId]).catch(() => {})
      await q('DELETE FROM multitable_automation_executions WHERE rule_id = $1', [ruleId]).catch(() => {})
      await q('DELETE FROM meta_fwb_action_applied WHERE rule_id = $1', [ruleId]).catch(() => {})
    }
    await q(
      `DELETE FROM operation_audit_logs
        WHERE action = 'automation.fwb_confirm'
          AND resource_type = 'automation_fwb_confirmation'
          AND resource_id = $1`,
      [RULE_SHEET],
    ).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = ANY($1::text[])', [[TARGET_SHEET, SECONDARY_SHEET, CROSS_SHEET, RULE_SHEET]]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[TARGET_SHEET, SECONDARY_SHEET, CROSS_SHEET, RULE_SHEET]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[TARGET_SHEET, SECONDARY_SHEET, CROSS_SHEET, RULE_SHEET]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[TARGET_SHEET, SECONDARY_SHEET, CROSS_SHEET, RULE_SHEET]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[RULE_BASE, TARGET_BASE, CROSS_BASE]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  test('save gate: unknown mode / missing recordLinkFieldId / client target ids ignored / hash binding', async () => {
    const base = {
      name: 'fwb2 update rule',
      triggerType: 'approval.completed',
      triggerConfig: { templateId, outcomes: ['approved'] },
      actionType: 'write_approval_form_values',
      createdBy: CREATOR,
    }
    await expect(svc.createRule(RULE_SHEET, {
      ...base,
      actionConfig: updateConfig({ mode: 'patch' }),
    } as never)).rejects.toThrow(/unknown_mode/)

    await expect(svc.createRule(RULE_SHEET, {
      ...base,
      actionConfig: updateConfig({ mappings: NUMBER_MAPPINGS }),
    } as never)).rejects.toThrow(/exact_number_mapping_unavailable/)

    await expect(svc.createRule(RULE_SHEET, {
      ...base,
      actionConfig: {
        mode: 'update',
        mappings: MAPPINGS,
        sourceTemplateVersionId: templateVersionId,
        confirmationHash: 'deadbeef',
      },
    } as never)).rejects.toThrow(/record_link_field/)

    // Client-supplied target base/sheet must NOT be trusted: hash is derived from schema pin only.
    // A wrong hash that assumes client override is rejected.
    await expect(svc.createRule(RULE_SHEET, {
      ...base,
      actionConfig: updateConfig({
        confirmationHash: deriveFwbConfirmationHash({
          templateId,
          sourceTemplateVersionId: templateVersionId,
          targetBaseId: 'client-smuggled-base',
          targetSheetId: 'client-smuggled-sheet',
          mappings: MAPPINGS,
          mode: 'update',
          recordLinkFieldId: 'linked',
        }),
      }),
    } as never)).rejects.toThrow(/confirmationHash must match/)

    // Create-mode hash (no mode keys) must not satisfy an update config.
    await expect(svc.createRule(RULE_SHEET, {
      ...base,
      actionConfig: updateConfig({
        confirmationHash: deriveFwbConfirmationHash({
          templateId,
          sourceTemplateVersionId: templateVersionId,
          targetBaseId: TARGET_BASE,
          targetSheetId: TARGET_SHEET,
          mappings: MAPPINGS,
        }),
      }),
    } as never)).rejects.toThrow(/confirmationHash must match/)

    const rule = await svc.createRule(RULE_SHEET, {
      ...base,
      actionConfig: updateConfig(),
    } as never)
    ruleIds.push((rule as { id: string }).id)
    expect((rule as { id: string }).id).toBeTruthy()
  })

  test('same-base update: maps form values onto bound record A; sibling B untouched; revision + claim + outbox', async () => {
    setFlags(true, true)
    try {
      const instanceId = await startInstance({
        summary: 'updated-A',
        amount: 42,
        linked: { recordId: REC_A },
      })
      await approveInstance(instanceId)
      const config = updateConfig() as Record<string, unknown>
      const saved = await svc.createRule(RULE_SHEET, {
        name: 'fwb2 production-gate happy path',
        triggerType: 'approval.completed',
        triggerConfig: { templateId, outcomes: ['approved'] },
        actionType: 'write_approval_form_values',
        actionConfig: config,
        createdBy: CREATOR,
      } as never)
      const ruleId = (saved as { id: string }).id
      ruleIds.push(ruleId)
      expect(await rbacIsAdmin(CREATOR)).toBe(false)
      const executor = buildExecutor({
        fwbGateChecks: undefined,
        fwbGateChecksFactory: productionGateFactory,
      })
      const evt = `evt_fwb2_same_${TS}`
      const run = await executor.execute(
        executorRule(ruleId, config),
        triggerPayload(instanceId, evt),
      )
      expect(run.steps[0]?.status).toBe('success')
      expect(await recordData(REC_A)).toMatchObject({ [F_TITLE]: 'updated-A', [F_AMOUNT]: 1 })
      expect(await recordData(REC_B)).toMatchObject({ [F_TITLE]: 'before-B', [F_AMOUNT]: 99 })
      expect(await claimCount(instanceId, ruleId)).toBe(1)
      expect(await revisionCount(REC_A)).toBe(1)
      expect(await outboxCountLike(`${evt}::fwb::`)).toBe(1)
    } finally {
      setFlags(false, false)
    }
  })

  test('action-scoped gates: a stale sibling update on another sheet cannot block the current action', async () => {
    const secondaryMappings = [
      { formFieldId: 'summary', targetFieldId: F_SECONDARY_TITLE, targetType: 'text' as const },
    ]
    const primaryConfig = updateConfig() as Record<string, unknown>
    const secondaryConfig = {
      mode: 'update',
      recordLinkFieldId: 'linked_secondary',
      mappings: secondaryMappings,
      sourceTemplateVersionId: templateVersionId,
      confirmationHash: deriveFwbConfirmationHash({
        templateId,
        sourceTemplateVersionId: templateVersionId,
        targetBaseId: TARGET_BASE,
        targetSheetId: SECONDARY_SHEET,
        mappings: secondaryMappings,
        mode: 'update',
        recordLinkFieldId: 'linked_secondary',
      }),
    }
    await recordConfirmationReceipt(String(secondaryConfig.confirmationHash))
    const saved = await svc.createRule(RULE_SHEET, {
      name: 'fwb2 action-scoped gates',
      triggerType: 'approval.completed',
      triggerConfig: { templateId, outcomes: ['approved'] },
      actionType: 'write_approval_form_values',
      actionConfig: primaryConfig,
      actions: [
        { type: 'write_approval_form_values', config: primaryConfig },
        { type: 'write_approval_form_values', config: secondaryConfig },
      ],
      createdBy: CREATOR,
    } as never)
    const ruleId = (saved as { id: string }).id
    ruleIds.push(ruleId)
    const identities = collectPersistedFwbActions(
      'write_approval_form_values',
      primaryConfig,
      [
        { type: 'write_approval_form_values', config: primaryConfig },
        { type: 'write_approval_form_values', config: secondaryConfig },
      ],
    )
    expect(identities).toHaveLength(2)

    const brokenSecondary = { ...secondaryConfig, confirmationHash: 'stale-sibling-confirmation' }
    await q(
      'UPDATE automation_rules SET actions = $1::jsonb WHERE id = $2',
      [JSON.stringify([
        { type: 'write_approval_form_values', config: primaryConfig },
        { type: 'write_approval_form_values', config: brokenSecondary },
      ]), ruleId],
    )
    const productionGates = buildProductionFwbGateChecks({
      queryFn,
      isAdminFn: (userId) => rbacIsAdmin(userId),
      canReadTemplateFn: async () => true,
    })
    const primary = await recheckFwbPermissionGates(productionGates, {
      configurerUserId: CREATOR,
      ruleId,
      actionKey: identities[0].actionKey,
      sourceTemplateId: templateId,
      targetSheetId: TARGET_SHEET,
      mode: 'update',
    })
    expect(primary).toEqual({ ok: true })

    const secondary = await recheckFwbPermissionGates(productionGates, {
      configurerUserId: CREATOR,
      ruleId,
      actionKey: identities[1].actionKey,
      sourceTemplateId: templateId,
      targetSheetId: SECONDARY_SHEET,
      mode: 'update',
    })
    expect(secondary).toEqual({ ok: false, failed: ['target_fields_writable', 'confirmation_recorded'] })

    const secondaryRecord = `rec_fwb2_secondary_${TS}`
    setFlags(true, true)
    try {
      await q(
        `INSERT INTO meta_records (id, sheet_id, data, version, created_by)
         VALUES ($1,$2,$3::jsonb,1,$4)`,
        [secondaryRecord, SECONDARY_SHEET, JSON.stringify({ [F_SECONDARY_TITLE]: 'secondary-before' }), CREATOR],
      )
      await q(
        `UPDATE meta_records SET data = $1::jsonb, version = 1 WHERE id = $2`,
        [JSON.stringify({ [F_TITLE]: 'primary-before', [F_AMOUNT]: 0 }), REC_A],
      )
      const instanceId = await startInstance({
        summary: 'primary-applied',
        amount: 73,
        linked: { recordId: REC_A },
        linked_secondary: { recordId: secondaryRecord },
      })
      await approveInstance(instanceId)
      const eventId = `evt_fwb2_actions_${TS}`
      const run = await buildExecutor({ fwbGateChecksFactory: productionGateFactory }).execute(
        {
          ...executorRule(ruleId, primaryConfig),
          actions: [
            { type: 'write_approval_form_values', config: primaryConfig },
            { type: 'write_approval_form_values', config: brokenSecondary },
          ] as never,
        },
        triggerPayload(instanceId, eventId),
      )
      expect(run.steps.map((step) => step.status)).toEqual(['success', 'failed'])
      expect(String(run.steps[1]?.error ?? '')).toContain('confirmation_recorded')
      expect(await recordData(REC_A)).toMatchObject({ [F_TITLE]: 'primary-applied', [F_AMOUNT]: 0 })
      expect(await recordData(secondaryRecord)).toMatchObject({ [F_SECONDARY_TITLE]: 'secondary-before' })
      expect(await claimCount(instanceId, ruleId)).toBe(1)
      expect(await outboxCountLike(`${eventId}::fwb::`)).toBe(1)
    } finally {
      await q('DELETE FROM meta_records WHERE id = $1', [secondaryRecord]).catch(() => {})
      setFlags(false, false)
    }
  })

  test('exact linked-record extraction: malformed value → fwb_rejected:linked_record, zero writes', async () => {
    setFlags(true, true)
    try {
      // Bypass form validation by writing a malicious snapshot shape directly (executor contract).
      const instanceId = await startInstance({
        summary: 'bad-link',
        amount: 1,
        linked: { recordId: REC_A },
      })
      await approveInstance(instanceId)
      await q(
        `UPDATE approval_instances SET form_snapshot = $1::jsonb WHERE id = $2`,
        [JSON.stringify({ summary: 'bad-link', amount: 1, linked: { recordId: REC_A, sheetId: 'smuggle' } }), instanceId],
      )
      const beforeA = await recordData(REC_A)
      const ruleId = `rule_fwb2_link_${TS}`
      const run = await buildExecutor({}).execute(
        executorRule(ruleId, updateConfig() as Record<string, unknown>),
        triggerPayload(instanceId, `evt_fwb2_link_${TS}`),
      )
      expect(run.steps[0]?.status).toBe('failed')
      expect(String(run.steps[0]?.error ?? '')).toBe('fwb_rejected:linked_record')
      expect(await recordData(REC_A)).toEqual(beforeA)
      expect(await claimCount(instanceId, ruleId)).toBe(0)
    } finally {
      setFlags(false, false)
    }
  })

  test('locked / deleted fail closed behind one non-oracular reason with zero mutation', async () => {
    setFlags(true, true)
    try {
      // Locked: ensureRecordNotLocked lets locker/owner through. Construct a row whose created_by
      // is NOT the rule creator and locked_by is a third party so the configurer is hard-denied.
      const lockedRec = `rec_fwb2_locked_${TS}`
      await q(
        `INSERT INTO meta_records (id, sheet_id, data, version, created_by, locked, locked_by)
         VALUES ($1,$2,$3::jsonb,1,$4,TRUE,$5)`,
        [lockedRec, TARGET_SHEET, JSON.stringify({ [F_TITLE]: 'locked-before', [F_AMOUNT]: 0 }), 'other_owner', 'other_locker'],
      )
      try {
        const lockedId = await startInstance({
          summary: 'locked',
          amount: 2,
          linked: { recordId: lockedRec },
        })
        await approveInstance(lockedId)
        const ruleId = `rule_fwb2_lock_${TS}`
        const before = await recordData(lockedRec)
        const run = await buildExecutor({}).execute(
          executorRule(ruleId, updateConfig() as Record<string, unknown>),
          triggerPayload(lockedId, `evt_fwb2_lock_${TS}`),
        )
        expect(run.steps[0]?.status).toBe('failed')
        expect(String(run.steps[0]?.error ?? '')).toBe('fwb_rejected:linked_record_unavailable')
        expect(await recordData(lockedRec)).toEqual(before)
        expect(await claimCount(lockedId, ruleId)).toBe(0)
      } finally {
        await q('DELETE FROM meta_records WHERE id = $1', [lockedRec]).catch(() => {})
      }

      // Deleted
      const ghostRec = `rec_fwb2_gone_${TS}`
      await q(
        `INSERT INTO meta_records (id, sheet_id, data, version, created_by) VALUES ($1,$2,$3::jsonb,1,$4)`,
        [ghostRec, TARGET_SHEET, JSON.stringify({ [F_TITLE]: 'ghost' }), CREATOR],
      )
      const delId = await startInstance({
        summary: 'deleted',
        amount: 3,
        linked: { recordId: ghostRec },
      })
      await approveInstance(delId)
      await q('DELETE FROM meta_records WHERE id = $1', [ghostRec])
      const ruleId2 = `rule_fwb2_del_${TS}`
      const run2 = await buildExecutor({}).execute(
        executorRule(ruleId2, updateConfig() as Record<string, unknown>),
        triggerPayload(delId, `evt_fwb2_del_${TS}`),
      )
      expect(run2.steps[0]?.status).toBe('failed')
      expect(String(run2.steps[0]?.error ?? '')).toBe('fwb_rejected:linked_record_unavailable')
      expect(await claimCount(delId, ruleId2)).toBe(0)
    } finally {
      setFlags(false, false)
    }
  })

  test('TOCTOU: a lock applied while FWB waits on the record row is observed before any write', async () => {
    setFlags(true, true)
    const raceRecord = `rec_fwb2_race_${TS}`
    const holder = await poolManager.get().getInternalPool().connect()
    let runPromise: ReturnType<AutomationExecutor['execute']> | undefined
    let holderOpen = false
    try {
      await q(
        `INSERT INTO meta_records (id, sheet_id, data, version, created_by, locked)
         VALUES ($1,$2,$3::jsonb,1,$4,FALSE)`,
        [raceRecord, TARGET_SHEET, JSON.stringify({ [F_TITLE]: 'race-before', [F_AMOUNT]: 0 }), 'other_owner'],
      )
      const instanceId = await startInstance({
        summary: 'must-not-write',
        amount: 88,
        linked: { recordId: raceRecord },
      })
      await approveInstance(instanceId)
      const ruleId = `rule_fwb2_race_${TS}`

      await holder.query('BEGIN')
      holderOpen = true
      const pidResult = await holder.query('SELECT pg_backend_pid() AS pid')
      const holderPid = Number((pidResult.rows[0] as { pid: number }).pid)
      await holder.query('SELECT id FROM meta_records WHERE id = $1 FOR UPDATE', [raceRecord])

      runPromise = buildExecutor({}).execute(
        executorRule(ruleId, updateConfig() as Record<string, unknown>),
        triggerPayload(instanceId, `evt_fwb2_race_${TS}`),
      )
      await waitForRecordLockWaiter(holderPid)
      await holder.query(
        'UPDATE meta_records SET locked = TRUE, locked_by = $1 WHERE id = $2',
        ['other_locker', raceRecord],
      )
      await holder.query('COMMIT')
      holderOpen = false

      const run = await runPromise
      expect(run.steps[0]?.status).toBe('failed')
      expect(String(run.steps[0]?.error ?? '')).toBe('fwb_rejected:linked_record_unavailable')
      expect(await recordData(raceRecord)).toMatchObject({ [F_TITLE]: 'race-before', [F_AMOUNT]: 0 })
      expect(await claimCount(instanceId, ruleId)).toBe(0)
    } finally {
      if (holderOpen) await holder.query('ROLLBACK').catch(() => {})
      holder.release()
      if (runPromise) await runPromise.catch(() => {})
      await q('DELETE FROM meta_records WHERE id = $1', [raceRecord]).catch(() => {})
      setFlags(false, false)
    }
  })

  test('TOCTOU: revoke wins before the authority lock; executor blocks, re-reads denial, and writes nothing', async () => {
    setFlags(true, true)
    const revoker = await poolManager.get().getInternalPool().connect()
    let revokerOpen = false
    let runPromise: ReturnType<AutomationExecutor['execute']> | undefined
    try {
      const config = updateConfig() as Record<string, unknown>
      const saved = await svc.createRule(RULE_SHEET, {
        name: 'fwb2 authority-revoke race',
        triggerType: 'approval.completed',
        triggerConfig: { templateId, outcomes: ['approved'] },
        actionType: 'write_approval_form_values',
        actionConfig: config,
        createdBy: CREATOR,
      } as never)
      const ruleId = (saved as { id: string }).id
      ruleIds.push(ruleId)
      const instanceId = await startInstance({
        summary: 'must-not-write-after-revoke',
        amount: 91,
        linked: { recordId: REC_A },
      })
      await approveInstance(instanceId)
      const before = await recordData(REC_A)

      await revoker.query('BEGIN')
      revokerOpen = true
      const pidResult = await revoker.query('SELECT pg_backend_pid() AS pid')
      const revokerPid = Number((pidResult.rows[0] as { pid: number }).pid)
      const deleted = await revoker.query(
        `DELETE FROM user_permissions
          WHERE user_id = $1 AND permission_code = 'multitable:write'
          RETURNING permission_code`,
        [CREATOR],
      )
      expect(deleted.rowCount).toBe(1)

      runPromise = buildExecutor({ fwbGateChecksFactory: productionGateFactory }).execute(
        executorRule(ruleId, config),
        triggerPayload(instanceId, `evt_fwb2_revoke_${TS}`),
      )
      await waitForAuthorityLockWaiter(revokerPid)
      await revoker.query('COMMIT')
      revokerOpen = false
      invalidateUserPerms(CREATOR)

      const run = await runPromise
      expect(run.steps[0]?.status).toBe('failed')
      expect(String(run.steps[0]?.error ?? '')).toMatch(/fwb_rejected:permission_gates/)
      expect(await recordData(REC_A)).toEqual(before)
      expect(await claimCount(instanceId, ruleId)).toBe(0)
    } finally {
      if (revokerOpen) await revoker.query('ROLLBACK').catch(() => {})
      revoker.release()
      if (runPromise) await runPromise.catch(() => {})
      await q(
        `INSERT INTO user_permissions (user_id, permission_code)
         VALUES ($1, 'multitable:write') ON CONFLICT DO NOTHING`,
        [CREATOR],
      ).catch(() => {})
      invalidateUserPerms(CREATOR)
      setFlags(false, false)
    }
  })

  test('write-revoked (field read-only after save) → permission_gates, zero writes', async () => {
    setFlags(true, true)
    try {
      // Save the rule while fields are still writable, THEN revoke field write before execute.
      const saved = await svc.createRule(RULE_SHEET, {
        name: 'fwb2 revoked field',
        triggerType: 'approval.completed',
        triggerConfig: { templateId, outcomes: ['approved'] },
        actionType: 'write_approval_form_values',
        actionConfig: updateConfig(),
        createdBy: CREATOR,
      } as never)
      const ruleId = (saved as { id: string }).id
      ruleIds.push(ruleId)

      const instanceId = await startInstance({
        summary: 'revoked-field',
        amount: 5,
        linked: { recordId: REC_A },
      })
      await approveInstance(instanceId)
      const before = await recordData(REC_A)
      await q(
        `INSERT INTO field_permissions (sheet_id, field_id, subject_type, subject_id, visible, read_only)
         VALUES ($1,$2,'user',$3,true,true)`,
        [TARGET_SHEET, F_TITLE, CREATOR],
      )
      try {
        // Production §11 Q6 gates (field writability is real).
        const executor = buildExecutor({ fwbGateChecksFactory: productionGateFactory })
        const run = await executor.execute(
          executorRule(ruleId, updateConfig() as Record<string, unknown>),
          triggerPayload(instanceId, `evt_fwb2_field_${TS}`),
        )
        expect(run.steps[0]?.status).toBe('failed')
        expect(String(run.steps[0]?.error ?? '')).toMatch(/fwb_rejected:permission_gates/)
        expect(await recordData(REC_A)).toEqual(before)
        expect(await claimCount(instanceId, ruleId)).toBe(0)
      } finally {
        await q(
          `DELETE FROM field_permissions
            WHERE sheet_id = $1 AND field_id = $2 AND subject_type = 'user' AND subject_id = $3`,
          [TARGET_SHEET, F_TITLE, CREATOR],
        )
      }
    } finally {
      setFlags(false, false)
    }
  })

  test('TOCTOU: concurrent field read-only INSERT wins; table lock blocks then rejects the write', async () => {
    setFlags(true, true)
    const revoker = await poolManager.get().getInternalPool().connect()
    let revokerOpen = false
    let runPromise: ReturnType<AutomationExecutor['execute']> | undefined
    try {
      const config = updateConfig() as Record<string, unknown>
      const saved = await svc.createRule(RULE_SHEET, {
        name: 'fwb2 field-permission phantom race',
        triggerType: 'approval.completed',
        triggerConfig: { templateId, outcomes: ['approved'] },
        actionType: 'write_approval_form_values',
        actionConfig: config,
        createdBy: CREATOR,
      } as never)
      const ruleId = (saved as { id: string }).id
      ruleIds.push(ruleId)
      const instanceId = await startInstance({
        summary: 'must-not-write-after-field-revoke',
        amount: 92,
        linked: { recordId: REC_A },
      })
      await approveInstance(instanceId)
      const before = await recordData(REC_A)

      await revoker.query('BEGIN')
      revokerOpen = true
      const pidResult = await revoker.query('SELECT pg_backend_pid() AS pid')
      const revokerPid = Number((pidResult.rows[0] as { pid: number }).pid)
      await revoker.query(
        `INSERT INTO field_permissions
           (sheet_id, field_id, subject_type, subject_id, visible, read_only)
         VALUES ($1,$2,'user',$3,TRUE,TRUE)`,
        [TARGET_SHEET, F_TITLE, CREATOR],
      )

      runPromise = buildExecutor({ fwbGateChecksFactory: productionGateFactory }).execute(
        executorRule(ruleId, config),
        triggerPayload(instanceId, `evt_fwb2_field_race_${TS}`),
      )
      await waitForFieldPermissionTableLockWaiter(revokerPid)
      await revoker.query('COMMIT')
      revokerOpen = false

      const run = await runPromise
      expect(run.steps[0]?.status).toBe('failed')
      expect(String(run.steps[0]?.error ?? '')).toMatch(/fwb_rejected:permission_gates/)
      expect(await recordData(REC_A)).toEqual(before)
      expect(await claimCount(instanceId, ruleId)).toBe(0)
    } finally {
      if (revokerOpen) await revoker.query('ROLLBACK').catch(() => {})
      revoker.release()
      if (runPromise) await runPromise.catch(() => {})
      await q(
        `DELETE FROM field_permissions
          WHERE sheet_id = $1 AND field_id = $2
            AND subject_type = 'user' AND subject_id = $3`,
        [TARGET_SHEET, F_TITLE, CREATOR],
      ).catch(() => {})
      setFlags(false, false)
    }
  })

  test('record scope: sheet write-own updates creator-owned record but rejects a foreign record', async () => {
    setFlags(true, true)
    const ownRecord = `rec_fwb2_own_${TS}`
    const foreignRecord = `rec_fwb2_foreign_${TS}`
    try {
      await q(
        `INSERT INTO meta_records (id, sheet_id, data, version, created_by)
         VALUES ($1,$3,$4::jsonb,1,$5), ($2,$3,$4::jsonb,1,$6)`,
        [ownRecord, foreignRecord, TARGET_SHEET, JSON.stringify({ [F_TITLE]: 'scope-before', [F_AMOUNT]: 0 }), CREATOR, 'other_owner'],
      )
      await q(
        `DELETE FROM user_permissions
          WHERE user_id = $1 AND permission_code = 'multitable:write'`,
        [CREATOR],
      )
      for (const permCode of ['spreadsheet:read', 'spreadsheet:write-own']) {
        try {
          await q(
            `INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code)
             VALUES ($1, 'user', $2, $3)`,
            [TARGET_SHEET, CREATOR, permCode],
          )
        } catch {
          await q(
            `INSERT INTO spreadsheet_permissions (sheet_id, user_id, subject_type, subject_id, perm_code)
             VALUES ($1, $2, 'user', $2, $3)`,
            [TARGET_SHEET, CREATOR, permCode],
          )
        }
      }
      invalidateUserPerms(CREATOR)
      const resolved = await resolveSheetCapabilitiesForUser(queryFn, TARGET_SHEET, CREATOR)
      expect(resolved.permissions).not.toContain('multitable:write')
      expect(resolved.isAdminRole).toBe(false)
      expect(resolved.sheetScope).toMatchObject({ canRead: true, canWrite: false, canWriteOwn: true })

      const config = updateConfig() as Record<string, unknown>
      const saved = await svc.createRule(RULE_SHEET, {
        name: 'fwb2 record-scope rule',
        triggerType: 'approval.completed',
        triggerConfig: { templateId, outcomes: ['approved'] },
        actionType: 'write_approval_form_values',
        actionConfig: config,
        createdBy: CREATOR,
      } as never)
      const ruleId = (saved as { id: string }).id
      ruleIds.push(ruleId)
      const executor = buildExecutor({ fwbGateChecksFactory: productionGateFactory })

      const ownInstance = await startInstance({ summary: 'own-updated', amount: 1, linked: { recordId: ownRecord } })
      await approveInstance(ownInstance)
      const ownRun = await executor.execute(
        executorRule(ruleId, config),
        triggerPayload(ownInstance, `evt_fwb2_own_${TS}`),
      )
      expect(ownRun.steps[0]?.status).toBe('success')
      expect(await recordData(ownRecord)).toMatchObject({ [F_TITLE]: 'own-updated', [F_AMOUNT]: 0 })

      const foreignInstance = await startInstance({ summary: 'must-not-update', amount: 2, linked: { recordId: foreignRecord } })
      await approveInstance(foreignInstance)
      const foreignRun = await executor.execute(
        executorRule(ruleId, config),
        triggerPayload(foreignInstance, `evt_fwb2_foreign_${TS}`),
      )
      expect(foreignRun.steps[0]?.status).toBe('failed')
      expect(String(foreignRun.steps[0]?.error ?? '')).toBe('fwb_rejected:linked_record_unavailable')
      expect(await recordData(foreignRecord)).toMatchObject({ [F_TITLE]: 'scope-before', [F_AMOUNT]: 0 })
      expect(await claimCount(foreignInstance, ruleId)).toBe(0)
    } finally {
      await q(
        `DELETE FROM spreadsheet_permissions
          WHERE sheet_id = $1 AND subject_type = 'user' AND subject_id = $2
            AND perm_code = ANY($3::text[])`,
        [TARGET_SHEET, CREATOR, ['spreadsheet:read', 'spreadsheet:write-own']],
      ).catch(() => {})
      await q(
        `INSERT INTO user_permissions (user_id, permission_code)
         VALUES ($1, 'multitable:write') ON CONFLICT DO NOTHING`,
        [CREATOR],
      ).catch(() => {})
      invalidateUserPerms(CREATOR)
      await q('DELETE FROM meta_records WHERE id = ANY($1::text[])', [[ownRecord, foreignRecord]]).catch(() => {})
      setFlags(false, false)
    }
  })

  test('duplicate net-once under new eventId; second instance is the positive control', async () => {
    setFlags(true, true)
    try {
      // Reset REC_A for a clean apply.
      await q(
        `UPDATE meta_records SET data = $1::jsonb, version = 1, locked = FALSE WHERE id = $2`,
        [JSON.stringify({ [F_TITLE]: 'net-once', [F_AMOUNT]: 0 }), REC_A],
      )
      const instanceId = await startInstance({
        summary: 'net-once-1',
        amount: 10,
        linked: { recordId: REC_A },
      })
      await approveInstance(instanceId)
      const ruleId = `rule_fwb2_net_${TS}`
      const executor = buildExecutor({})
      const cfg = updateConfig() as Record<string, unknown>
      const run1 = await executor.execute(executorRule(ruleId, cfg), triggerPayload(instanceId, `evt_fwb2_net1_${TS}`))
      expect(run1.steps[0]?.status).toBe('success')
      expect(await claimCount(instanceId, ruleId)).toBe(1)
      const versionAfter = Number(
        ((await q('SELECT version FROM meta_records WHERE id = $1', [REC_A])).rows[0] as { version: number }).version,
      )

      const run2 = await executor.execute(executorRule(ruleId, cfg), triggerPayload(instanceId, `evt_fwb2_net2_${TS}`))
      expect(run2.steps[0]?.status).toBe('success')
      expect(run2.steps[0]?.alreadyApplied).toBe(true)
      expect(await claimCount(instanceId, ruleId)).toBe(1)
      expect(await outboxCountLike(`evt_fwb2_net2_${TS}::fwb::`)).toBe(0)
      const versionDup = Number(
        ((await q('SELECT version FROM meta_records WHERE id = $1', [REC_A])).rows[0] as { version: number }).version,
      )
      expect(versionDup).toBe(versionAfter)

      // Positive control: different instance produces a second claim and mutates again.
      const instanceB = await startInstance({
        summary: 'net-once-2',
        amount: 11,
        linked: { recordId: REC_A },
      })
      await approveInstance(instanceB)
      const run3 = await executor.execute(executorRule(ruleId, cfg), triggerPayload(instanceB, `evt_fwb2_net3_${TS}`))
      expect(run3.steps[0]?.status).toBe('success')
      expect(await claimCount(instanceB, ruleId)).toBe(1)
      expect(await recordData(REC_A)).toMatchObject({ [F_TITLE]: 'net-once-2', [F_AMOUNT]: 0 })
    } finally {
      setFlags(false, false)
    }
  })

  test('ATOMICITY: injected post-handler abort rolls claim + update + revision + outbox back together', async () => {
    setFlags(true, true)
    try {
      await q(
        `UPDATE meta_records SET data = $1::jsonb, version = 1 WHERE id = $2`,
        [JSON.stringify({ [F_TITLE]: 'atomic-before', [F_AMOUNT]: 0 }), REC_A],
      )
      const instanceId = await startInstance({
        summary: 'atomic',
        amount: 7,
        linked: { recordId: REC_A },
      })
      await approveInstance(instanceId)
      const ruleId = `rule_fwb2_atomic_${TS}`
      let inject = true
      const injectingTransaction: NonNullable<AutomationDeps['transaction']> = async (handler) =>
        realTransaction(async (client) => {
          const result = await handler(client)
          if (inject) throw new Error('injected post-handler abort host=db.internal user=secret_owner')
          return result
        })
      const executor = buildExecutor({ transaction: injectingTransaction })
      const before = await recordData(REC_A)
      const run1 = await executor.execute(
        executorRule(ruleId, updateConfig() as Record<string, unknown>),
        triggerPayload(instanceId, `evt_fwb2_atomic1_${TS}`),
      )
      expect(run1.steps[0]?.status).toBe('failed')
      expect(String(run1.steps[0]?.error ?? '')).toBe('fwb_execution_failed')
      expect(String(run1.steps[0]?.error ?? '')).not.toMatch(/db\.internal|secret_owner|injected/)
      expect(await recordData(REC_A)).toEqual(before)
      expect(await claimCount(instanceId, ruleId)).toBe(0)
      expect(await outboxCountLike(`evt_fwb2_atomic1_${TS}::fwb::`)).toBe(0)

      inject = false
      const run2 = await executor.execute(
        executorRule(ruleId, updateConfig() as Record<string, unknown>),
        triggerPayload(instanceId, `evt_fwb2_atomic2_${TS}`),
      )
      expect(run2.steps[0]?.status).toBe('success')
      expect(await recordData(REC_A)).toMatchObject({ [F_TITLE]: 'atomic', [F_AMOUNT]: 0 })
      expect(await claimCount(instanceId, ruleId)).toBe(1)
      expect(await revisionCount(REC_A)).toBeGreaterThanOrEqual(1)
      expect(await outboxCountLike(`evt_fwb2_atomic2_${TS}::fwb::`)).toBe(1)
    } finally {
      setFlags(false, false)
    }
  })

  test('cross-base deny when rule creator lacks target base write; allow when authorized', async () => {
    setFlags(true, true)
    try {
      // Publish a second template that pins CROSS_SHEET, so derivation points at another base.
      const crossTpl = await approvals.createTemplate(
        {
          ...approvalTemplateRequest(CROSS_BASE, CROSS_SHEET),
          key: `fwb2-cross-${TS}`,
          name: 'FWB-2 Cross Template',
          formSchema: {
            fields: [
              { id: 'summary', type: 'text', label: 'Summary', required: true },
              {
                id: 'linked',
                type: 'record-link',
                label: 'Bound',
                required: true,
                props: { baseId: CROSS_BASE, sheetId: CROSS_SHEET },
              },
            ],
          },
        } as never,
      )
      const crossTemplateId = (crossTpl as { id: string }).id
      await approvals.publishTemplate(crossTemplateId, {
        policy: { allowRevoke: true },
        actorUserId: CREATOR,
      } as never)
      const crossVer = await q('SELECT active_version_id FROM approval_templates WHERE id = $1', [crossTemplateId])
      const crossVersionId = String((crossVer.rows[0] as { active_version_id: string }).active_version_id)

      const crossMappings = [
        { formFieldId: 'summary', targetFieldId: F_CROSS_TITLE, targetType: 'text' as const },
      ]
      const crossCfg = {
        mode: 'update',
        recordLinkFieldId: 'linked',
        mappings: crossMappings,
        sourceTemplateVersionId: crossVersionId,
        confirmationHash: deriveFwbConfirmationHash({
          templateId: crossTemplateId,
          sourceTemplateVersionId: crossVersionId,
          targetBaseId: CROSS_BASE,
          targetSheetId: CROSS_SHEET,
          mappings: crossMappings,
          mode: 'update',
          recordLinkFieldId: 'linked',
        }),
      }
      await recordConfirmationReceipt(String(crossCfg.confirmationHash))
      const crossRule = await svc.createRule(RULE_SHEET, {
        name: 'fwb2 production cross-base rule',
        triggerType: 'approval.completed',
        triggerConfig: { templateId: crossTemplateId, outcomes: ['approved'] },
        actionType: 'write_approval_form_values',
        actionConfig: crossCfg,
        createdBy: CREATOR,
      } as never)
      const crossRuleId = (crossRule as { id: string }).id
      ruleIds.push(crossRuleId)

      // Create + approve against the cross template.
      const dto = await approvals.createApproval(
        {
          templateId: crossTemplateId,
          formData: { summary: 'cross-write', linked: { recordId: REC_CROSS } },
        },
        { userId: REQUESTER, userName: REQUESTER },
      )
      const instanceId = (dto as { id: string }).id
      await approveInstance(instanceId)

      // Cross-base authority uses resolveBaseWritable (multitable:base:write / base ownership),
      // NOT sheet multitable:write and NOT users.is_admin. Seed the code, then DENY by stripping it.
      await q(
        `INSERT INTO permissions (code, name, description)
         VALUES ('multitable:base:write', 'Base Write', 'FWB2')
         ON CONFLICT (code) DO NOTHING`,
      )
      await q(
        `DELETE FROM user_permissions WHERE user_id = $1 AND permission_code = 'multitable:base:write'`,
        [CREATOR],
      )
      try {
        const before = await recordData(REC_CROSS)
        const denyRun = await buildExecutor({ fwbGateChecksFactory: productionGateFactory }).execute(
          {
            ...executorRule(crossRuleId, crossCfg as Record<string, unknown>),
            trigger: { type: 'approval.completed', config: { templateId: crossTemplateId } } as never,
            createdBy: CREATOR,
          },
          {
            ...triggerPayload(instanceId, `evt_fwb2_xdeny_${TS}`),
            approval: { instanceId, templateId: crossTemplateId, templateVersionId: crossVersionId },
          },
        )
        expect(denyRun.steps[0]?.status).toBe('failed')
        expect(String(denyRun.steps[0]?.error ?? '')).toBe('fwb_rejected:cross_base')
        expect(await recordData(REC_CROSS)).toEqual(before)
        expect(await claimCount(instanceId, crossRuleId)).toBe(0)
      } finally {
        await q(
          `INSERT INTO user_permissions (user_id, permission_code)
           VALUES ($1, 'multitable:base:write') ON CONFLICT DO NOTHING`,
          [CREATOR],
        )
      }

      // ALLOW: rule creator holds multitable:base:write on the target base path.
      const allowDto = await approvals.createApproval(
        {
          templateId: crossTemplateId,
          formData: { summary: 'cross-write-allow', linked: { recordId: REC_CROSS } },
        },
        { userId: REQUESTER, userName: REQUESTER },
      )
      const allowInstanceId = (allowDto as { id: string }).id
      await approveInstance(allowInstanceId)
      const allowRun = await buildExecutor({ fwbGateChecksFactory: productionGateFactory }).execute(
        {
          ...executorRule(crossRuleId, crossCfg as Record<string, unknown>),
          trigger: { type: 'approval.completed', config: { templateId: crossTemplateId } } as never,
          createdBy: CREATOR,
        },
        {
          ...triggerPayload(allowInstanceId, `evt_fwb2_xallow_${TS}`),
          approval: { instanceId: allowInstanceId, templateId: crossTemplateId, templateVersionId: crossVersionId },
        },
      )
      expect(String(allowRun.steps[0]?.error ?? '')).toBe('')
      expect(allowRun.steps[0]?.status).toBe('success')
      expect(await recordData(REC_CROSS)).toMatchObject({ [F_CROSS_TITLE]: 'cross-write-allow' })
      expect(await claimCount(allowInstanceId, crossRuleId)).toBe(1)
    } finally {
      setFlags(false, false)
    }
  })

  test('flag OFF skips; durable OFF fails closed — zero writes', async () => {
    await q(
      `UPDATE meta_records SET data = $1::jsonb WHERE id = $2`,
      [JSON.stringify({ [F_TITLE]: 'flag-before', [F_AMOUNT]: 0 }), REC_A],
    )
    const instanceId = await startInstance({
      summary: 'flag-test',
      amount: 1,
      linked: { recordId: REC_A },
    })
    await approveInstance(instanceId)
    const ruleId = `rule_fwb2_flag_${TS}`
    const cfg = updateConfig() as Record<string, unknown>
    const before = await recordData(REC_A)

    setFlags(false, false)
    const off = await buildExecutor({}).execute(executorRule(ruleId, cfg), triggerPayload(instanceId, `evt_fwb2_off_${TS}`))
    expect(off.steps[0]?.status).toBe('skipped')
    expect(await recordData(REC_A)).toEqual(before)

    setFlags(true, false)
    const half = await buildExecutor({}).execute(executorRule(ruleId, cfg), triggerPayload(instanceId, `evt_fwb2_half_${TS}`))
    expect(half.steps[0]?.status).toBe('failed')
    expect(String(half.steps[0]?.error ?? '')).toMatch(/AUTOMATION_DURABLE_DELIVERY_ENABLED/)
    expect(await recordData(REC_A)).toEqual(before)
    expect(await claimCount(instanceId, ruleId)).toBe(0)
    setFlags(false, false)
  })

  test('D-H1 FWB-2 fences rule and pinned target, ignores a decoy block, and adds no flag-off preflight read', async () => {
    setFlags(true, true)
    setWriterFence(false)
    const cfg = updateConfig() as Record<string, unknown>
    const executorQuery = async (sqlText: string, params?: unknown[]) => poolManager.get().query(sqlText, params) as never
    let preflightReads = 0
    const countingQuery = async (sqlText: string, params?: unknown[]) => {
      if (sqlText.includes('SELECT v.form_schema')) preflightReads += 1
      return executorQuery(sqlText, params)
    }

    const offInstance = await startInstance({
      summary: 'fence-off',
      amount: 1,
      linked: { recordId: REC_A },
    })
    await approveInstance(offInstance)
    const offRule = `rule_fwb2_fence_off_${TS}`
    ruleIds.push(offRule)
    const offRun = await buildExecutor({ queryFn: countingQuery as never }).execute(
      executorRule(offRule, cfg),
      triggerPayload(offInstance, `evt_fwb2_fence_off_${TS}`),
    )
    expect(offRun.steps[0]?.status).toBe('success')
    expect(preflightReads).toBe(0)

    const blockedLegs = [
      { blockedSheetId: RULE_SHEET, label: 'rule' },
      { blockedSheetId: TARGET_SHEET, label: 'target' },
    ] as const
    setWriterFence(true)
    try {
      for (const leg of blockedLegs) {
        const instanceId = await startInstance({
          summary: `blocked-${leg.label}`,
          amount: 2,
          linked: { recordId: REC_A },
        })
        await approveInstance(instanceId)
        const before = await recordData(REC_A)
        const ruleId = `rule_fwb2_fence_${leg.label}_${TS}`
        ruleIds.push(ruleId)
        await q("UPDATE meta_sheets SET recovery_writer_state = 'applying' WHERE id = $1", [leg.blockedSheetId])
        try {
          const run = await buildExecutor({}).execute(
            executorRule(ruleId, cfg),
            triggerPayload(instanceId, `evt_fwb2_fence_${leg.label}_${TS}`),
          )
          expect(run.steps[0]?.status).toBe('failed')
          expect(run.steps[0]?.error).toBe('fwb_execution_failed')
          expect(await recordData(REC_A)).toEqual(before)
          expect(await claimCount(instanceId, ruleId)).toBe(0)
        } finally {
          await q('UPDATE meta_sheets SET recovery_writer_state = NULL WHERE id = $1', [leg.blockedSheetId])
        }
      }

      const decoyInstance = await startInstance({
        summary: 'decoy-does-not-block',
        amount: 3,
        linked: { recordId: REC_A },
      })
      await approveInstance(decoyInstance)
      const decoyRule = `rule_fwb2_fence_decoy_${TS}`
      ruleIds.push(decoyRule)
      await q("UPDATE meta_sheets SET recovery_writer_state = 'applying' WHERE id = $1", [SECONDARY_SHEET])
      try {
        const run = await buildExecutor({}).execute(
          executorRule(decoyRule, cfg),
          triggerPayload(decoyInstance, `evt_fwb2_fence_decoy_${TS}`),
        )
        expect(run.steps[0]?.status).toBe('success')
        expect(await recordData(REC_A)).toMatchObject({ [F_TITLE]: 'decoy-does-not-block' })
      } finally {
        await q('UPDATE meta_sheets SET recovery_writer_state = NULL WHERE id = $1', [SECONDARY_SHEET])
      }
    } finally {
      setWriterFence(false)
      setFlags(false, false)
    }
  })

  test('D-H1 multi-sheet writer fences order mirrored inputs identically and complete without 40P01', async () => {
    setWriterFence(true)
    await q(
      'UPDATE meta_sheets SET recovery_writer_state = NULL WHERE id = ANY($1::text[])',
      [[RULE_SHEET, TARGET_SHEET]],
    )
    let markFirstHeld!: () => void
    let markSecondStarted!: () => void
    const firstHeld = new Promise<void>((resolve) => { markFirstHeld = resolve })
    const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve })
    const firstOrder: string[] = []
    const secondOrder: string[] = []

    try {
      const first = poolManager.get().transaction(async ({ query }) => {
        let firstFence = true
        await fenceWriterEntriesInOrder(async (sqlText, params) => {
          const result = await query(sqlText, params)
          if (sqlText.includes('pg_advisory_xact_lock')) firstOrder.push(String(params?.[0] ?? ''))
          if (firstFence && sqlText.includes('pg_advisory_xact_lock')) {
            firstFence = false
            markFirstHeld()
            await secondStarted
          }
          return result as never
        }, [RULE_SHEET, TARGET_SHEET])
      })

      const second = (async () => {
        await firstHeld
        return poolManager.get().transaction(async ({ query }) => {
          let firstFence = true
          await fenceWriterEntriesInOrder(async (sqlText, params) => {
            if (firstFence && sqlText.includes('pg_advisory_xact_lock')) {
              firstFence = false
              markSecondStarted()
            }
            const result = await query(sqlText, params)
            if (sqlText.includes('pg_advisory_xact_lock')) secondOrder.push(String(params?.[0] ?? ''))
            return result as never
          }, [TARGET_SHEET, RULE_SHEET])
        })
      })()

      await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
      expect(firstOrder).toEqual(secondOrder)
      expect(firstOrder).toEqual([
        `meta:auto-number:sheet:${RULE_SHEET}`,
        `meta:auto-number:sheet:${TARGET_SHEET}`,
      ])
    } finally {
      setWriterFence(false)
    }
  })
})

describeIfDatabase('SA06AP FWB update after-image', () => {
  const schema = 'automation_approval_image_' + randomBytes(8).toString('hex')
  const identity = randomBytes(8).toString('hex')
  const baseId = 'base_sa06ap_' + identity
  const ruleSheetId = 'sheet_sa06ap_rule_' + identity
  const targetSheetId = 'sheet_sa06ap_target_' + identity
  const fieldId = 'fld_sa06ap_title_' + identity
  const preservedFieldId = 'fld_sa06ap_preserved_' + identity
  const creatorId = 'u_sa06ap_creator_' + identity
  const requesterId = 'u_sa06ap_requester_' + identity
  const approverId = 'u_sa06ap_approver_' + identity
  const mappings = [{ formFieldId: 'summary', targetFieldId: fieldId, targetType: 'text' as const }]
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
    // Only transport is forwarded: retain production transaction BEGIN/COMMIT and gate queries.
    transport.push(vi.spyOn(originalPool, 'connect').mockImplementation(ownedPool.connect.bind(ownedPool)))
    transport.push(vi.spyOn(originalPool, 'query').mockImplementation(ownedPool.query.bind(ownedPool)))
    transport.push(vi.spyOn(infrastructure, 'query').mockImplementation((statement, params) => ownedPool.query(statement, params)))
    transport.push(vi.spyOn(infrastructure, 'getInternalPool').mockReturnValue(ownedPool))
    await bootstrapOwnedApprovalAfterImageSchema({ db: ownedDb, query: (statement, params) => ownedPool.query(statement, params), mode: 'empty' })
    // The real record-link submit/update fence SELECTs grant ids, even with no grants.
    // Complete only this owned fixture's simplified relation, never repair public storage.
    await q('ALTER TABLE record_permissions ADD COLUMN id uuid PRIMARY KEY DEFAULT gen_random_uuid()')
    for (const migration of [addFwbClaims, addFwbAction, addEventFires, addEventFireLease, addAuditLogs, hardenAuditLogs]) {
      await ownedDb.transaction().execute(migration)
    }
    const { getApprovalMetricsService } = await import('../../src/services/ApprovalMetricsService')
    const metrics = getApprovalMetricsService()
    metricsObservers.push(vi.spyOn(metrics, 'recordInstanceStart'), vi.spyOn(metrics, 'recordNodeDecision'), vi.spyOn(metrics, 'recordTerminal'))
    // Requester owns the synthetic base for the real record-link submit read gate.
    await q('INSERT INTO meta_bases(id,name,owner_id) VALUES($1,$2,$3)', [baseId, 'Synthetic update image base', requesterId])
    for (const id of [ruleSheetId, targetSheetId]) {
      await q('INSERT INTO meta_sheets(id,base_id,name) VALUES($1,$2,$3)', [id, baseId, 'Synthetic update image sheet'])
    }
    for (const [index, id] of [fieldId, preservedFieldId].entries()) {
      await q('INSERT INTO meta_fields(id,sheet_id,name,type,property,"order") VALUES($1,$2,$3,$4,$5::jsonb,$6)',
        [id, targetSheetId, 'Synthetic update field', 'string', '{}', index + 1])
    }
    for (const uid of [creatorId, requesterId, approverId]) {
      await q(`INSERT INTO users(id,email,name,password_hash,role,permissions,is_active,is_admin)
        VALUES($1,$2,$1,'synthetic','user','[]',true,$3)`, [uid, uid + '@synthetic.test', uid === creatorId])
    }
    await q("INSERT INTO roles(id,name) VALUES('admin','admin')")
    await q("INSERT INTO user_roles(user_id,role_id) VALUES($1,'admin')", [creatorId])
    // Base ownership passes base-read only; real record-link submit also needs sheet-read.
    for (const [uid, permission] of [[creatorId, 'approvals:read'], [creatorId, 'multitable:read'],
      [requesterId, 'approvals:write'], [requesterId, 'multitable:read'], [approverId, 'approvals:act']]) {
      await q('INSERT INTO user_permissions(user_id,permission_code) VALUES($1,$2)', [uid, permission])
      await invalidateUserPerms(uid)
    }
    await q("INSERT INTO user_orgs(user_id,org_id,is_active) VALUES($1,'default',true)", [requesterId])
    product = new ApprovalProductService()
    // No subscription/init: consume exactly the original persisted approved payload through public API.
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
    const recordId = 'rec_sa06ap_' + randomUUID()
    await q('INSERT INTO meta_records(id,sheet_id,data,version,created_by) VALUES($1,$2,$3::jsonb,3,$4)',
      [recordId, targetSheetId, JSON.stringify({ [fieldId]: 'synthetic before', [preservedFieldId]: 'synthetic untouched' }), requesterId])
    const template = await product.createTemplate({ key: 'sa06ap-' + randomUUID(), name: 'Synthetic FWB update image',
      visibilityScope: { type: 'all', ids: [] }, formSchema: { fields: [
        { id: 'summary', type: 'text', label: 'Summary', required: true },
        { id: 'linked', type: 'record-link', label: 'Bound synthetic record', required: true,
          props: { baseId, sheetId: targetSheetId } },
      ] }, approvalGraph: { nodes: [
        { key: 'start', type: 'start', name: 'Start', config: {} },
        { key: 'approval_1', type: 'approval', name: 'Approver',
          config: { mode: 'any', assigneeSources: [{ kind: 'static_user', userIds: [approverId] }] } },
        { key: 'end', type: 'end', name: 'End', config: {} },
      ], edges: [
        { key: 'edge-start-approval_1', source: 'start', target: 'approval_1' },
        { key: 'edge-approval_1-end', source: 'approval_1', target: 'end' },
      ] } } as never)
    await product.publishTemplate(template.id, { policy: { allowRevoke: true }, actorUserId: creatorId } as never)
    const versionId = String((await q('SELECT active_version_id FROM approval_templates WHERE id=$1', [template.id])).rows[0].active_version_id)
    const confirmationHash = deriveFwbConfirmationHash({ templateId: template.id, sourceTemplateVersionId: versionId,
      targetBaseId: baseId, targetSheetId, mappings, mode: 'update', recordLinkFieldId: 'linked' })
    // Dedicated storage receipt, explicitly not an HTTP confirmation-route claim.
    await q(`INSERT INTO operation_audit_logs(actor_id,actor_type,action,resource_type,resource_id,metadata,meta)
      VALUES($1,'user','automation.fwb_confirm','automation_fwb_confirmation',$2,$3::jsonb,$3::jsonb)`,
    [creatorId, ruleSheetId, JSON.stringify({ confirmationHash })])
    const rule = await service.createRule(ruleSheetId, { name: 'Synthetic FWB update RETURNING',
      triggerType: 'approval.completed', triggerConfig: { templateId: template.id, outcomes: ['approved'] },
      actionType: 'write_approval_form_values', actionConfig: { mode: 'update', recordLinkFieldId: 'linked',
        mappings, sourceTemplateVersionId: versionId, confirmationHash }, createdBy: creatorId } as never)
    const instance = await product.createApproval({ templateId: template.id, formData: { summary, linked: { recordId } } },
      { userId: requesterId, userName: requesterId })
    await product.dispatchAction(instance.id, { action: 'approve', comment: 'synthetic approval' } as never,
      { userId: approverId, userName: approverId })
    const completion = await q(`SELECT payload FROM meta_automation_outbox WHERE event_type='approval.approved'
      AND payload->'approval'->>'instanceId'=$1`, [instance.id])
    expect(completion.rows).toHaveLength(1)
    const event = completion.rows[0].payload as Parameters<AutomationService['handleApprovalCompletionTrigger']>[0]
    expect(event).toMatchObject({ source: 'approval-product', eventType: 'approval.approved',
      approval: { instanceId: instance.id, templateId: template.id, templateVersionId: versionId },
      transition: { toStatus: 'approved' } })
    expect((await q('SELECT status FROM approval_instances WHERE id=$1', [instance.id])).rows).toEqual([{ status: 'approved' }])
    await drainMetrics()
    return { ruleId: rule.id, instanceId: instance.id, recordId, event }
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
      (SELECT count(*)::int FROM meta_automation_outbox WHERE event_type='multitable.record.updated') AS events`)).rows[0]
  }
  async function storedRecord(recordId: string) {
    return (await q('SELECT data,version FROM meta_records WHERE id=$1', [recordId])).rows[0]
  }
  async function imageForRule(ruleId: string) {
    const images = await q(`SELECT i.*,o.payload,o.event_id AS receipt_event_id,o.event_type AS receipt_event_type,
      o.automation_depth,octet_length(i.after_image::text) AS pg_bytes,o.xmin::text AS event_xmin,i.xmin::text AS image_xmin
      FROM meta_automation_record_after_images i JOIN meta_automation_outbox o ON o.id=i.outbox_id
      WHERE o.event_id LIKE $1`, ['%::fwb::' + ruleId + '::%'])
    expect(images.rows).toHaveLength(1)
    return images.rows[0]
  }
  async function condition(image: Record<string, unknown>, value: string) {
    const ruleId = 'sa06ap_condition_' + randomUUID()
    await q(`INSERT INTO automation_rules(id,sheet_id,name,trigger_type,action_type,created_by,conditions)
      VALUES($1,$2,'Synthetic update image condition','record.updated','send_webhook',$3,$4::jsonb)`,
    [ruleId, targetSheetId, creatorId, JSON.stringify({ logic: 'and', conditions: [
      { fieldId, operator: 'equals', value },
      { fieldId: preservedFieldId, operator: 'equals', value: 'synthetic untouched' },
    ] })])
    const conditions = createAutomationReadRecordConditions({ businessTimeZone: 'Asia/Shanghai' })
    return poolManager.get().transaction(async actual => {
      const trx: TransactionalQueryable = { isTransaction: true, query: async (statement, params) => actual.query(statement, params) }
      const locked = await conditions.lock(trx, { actorId: creatorId, ruleId, sheetId: targetSheetId, baseId })
      return conditions.evaluate(trx, locked, { outboxId: String(image.outbox_id), eventId: String(image.event_id), eventType: 'multitable.record.updated' })
    })
  }
  async function dropTrigger(name: string, table: string) {
    await q(`DROP TRIGGER IF EXISTS ${name}_trg ON ${table}`)
    await q(`DROP FUNCTION IF EXISTS ${name}()`)
  }

  test('derived target actual RETURNING image preserves full update revision and all five effects share one xid; new-event claim dedup', async () => {
    const run = await completedApproval('synthetic input')
    const trigger = 'sa06ap_returning_' + randomBytes(6).toString('hex')
    const emits = vi.spyOn(integrationEventBus, 'emit')
    try {
      await q(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN
          IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND relation='meta_fields'::regclass
            AND mode='ShareLock' AND granted) THEN RAISE EXCEPTION 'SA06AP_SCHEMA_NOT_BEFORE_DML'; END IF;
          NEW.data:=NEW.data || jsonb_build_object('${fieldId}','synthetic PG saved',
            'synthetic_extra','not in input','synthetic_capture_xid',pg_current_xact_id()::text);
          NEW.version:=9;
          RETURN NEW;
        END $fn$`)
      await q(`CREATE TRIGGER ${trigger}_trg BEFORE UPDATE ON meta_records FOR EACH ROW EXECUTE FUNCTION ${trigger}()`)
      await service.handleApprovalCompletionTrigger(run.event)
      const exec = await execution(run.ruleId)
      expect(exec.steps, JSON.stringify(exec)).toMatchObject([{ status: 'success', actionType: 'write_approval_form_values' }])
      const image = await imageForRule(run.ruleId)
      const record = (await q('SELECT data,version,xmin::text AS record_xmin FROM meta_records WHERE id=$1', [run.recordId])).rows[0]
      expect(image).toMatchObject({ sheet_id: targetSheetId, record_id: run.recordId, status: 'captured', reason: null,
        record_version: '9', after_image: record.data, capture_xid: record.data.synthetic_capture_xid,
        event_type: 'multitable.record.updated', receipt_event_type: 'multitable.record.updated', automation_depth: 1 })
      expect(record.version).toBe(9)
      expect(record.data).toMatchObject({ [fieldId]: 'synthetic PG saved', [preservedFieldId]: 'synthetic untouched', synthetic_extra: 'not in input' })
      expect(image.captured_bytes).toBe(image.pg_bytes)
      expect(image.captured_bytes).toBeGreaterThan(0)
      expect(image.event_id).toBe(image.receipt_event_id)
      expect(image.payload).toEqual({ sheetId: targetSheetId, recordId: run.recordId })
      const epochs = await q(`SELECT scope->>'id' AS sheet,revision::text FROM automation_read_material_epochs
        WHERE kind='sheet' AND scope->>'id'=ANY($1::text[])`, [[ruleSheetId, targetSheetId]])
      const targetRevision = epochs.rows.find(row => row.sheet === targetSheetId)?.revision
      expect(typeof targetRevision).toBe('string')
      expect(image.schema_revision).toBe(targetRevision)
      expect(image.schema_revision).not.toBe(epochs.rows.find(row => row.sheet === ruleSheetId)?.revision)
      const revisions = await q('SELECT version,patch,snapshot,actor_id,changed_field_ids,xmin::text AS revision_xmin FROM meta_record_revisions WHERE record_id=$1', [run.recordId])
      expect(revisions.rows).toHaveLength(1)
      expect(revisions.rows[0]).toMatchObject({ version: 9, patch: { [fieldId]: 'synthetic input' },
        snapshot: record.data, changed_field_ids: [fieldId], actor_id: creatorId })
      const claims = await q('SELECT xmin::text AS claim_xmin FROM meta_fwb_action_applied WHERE instance_id=$1 AND rule_id=$2', [run.instanceId, run.ruleId])
      expect(claims.rows).toHaveLength(1)
      const xid = (BigInt(String(image.capture_xid)) % 4294967296n).toString()
      expect([record.record_xmin, revisions.rows[0].revision_xmin, image.event_xmin, image.image_xmin, claims.rows[0].claim_xmin])
        .toEqual([xid, xid, xid, xid, xid])
      expect(await condition(image, 'synthetic PG saved')).toEqual({ kind: 'match' })
      expect(emits.mock.calls.filter(call => call[0] === 'multitable.record.updated')).toHaveLength(0)
      const before = await totals(), beforeRecord = await storedRecord(run.recordId)
      // New transport identity deliberately exercises instance/action claim, not event dedup.
      await service.handleApprovalCompletionTrigger({ ...run.event, eventId: 'sa06ap_replay_' + randomUUID() })
      expect(await totals()).toEqual(before)
      expect(await storedRecord(run.recordId)).toEqual(beforeRecord)
      expect((await execution(run.ruleId)).steps).toMatchObject([{ status: 'success', alreadyApplied: true }])
    } finally {
      try { await dropTrigger(trigger, 'meta_records') } finally { emits.mockRestore() }
    }
  }, 20000)

  test('private image INSERT failure rolls back claim/update/revision/outbox/image; manual new-event retry commits once', async () => {
    const run = await completedApproval('synthetic rollback'), before = await totals(), beforeRecord = await storedRecord(run.recordId)
    const trigger = 'sa06ap_failure_' + randomBytes(6).toString('hex')
    try {
      await q(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN RAISE EXCEPTION 'SA06AP_IMAGE_INSERT_FAILURE'; END $fn$`)
      await q(`CREATE TRIGGER ${trigger}_trg BEFORE INSERT ON meta_automation_record_after_images
        FOR EACH ROW EXECUTE FUNCTION ${trigger}()`)
      await expect(service.handleApprovalCompletionTrigger(run.event)).rejects.toThrow('approval_completed_trigger_retryable_failure')
      expect((await execution(run.ruleId)).steps).toMatchObject([{ status: 'failed', error: 'fwb_execution_failed' }])
      expect(await totals()).toEqual(before)
      expect(await storedRecord(run.recordId)).toEqual(beforeRecord)
      expect((await q('SELECT id FROM meta_fwb_action_applied WHERE instance_id=$1 AND rule_id=$2', [run.instanceId, run.ruleId])).rows).toHaveLength(0)
      await dropTrigger(trigger, 'meta_automation_record_after_images')
      // Manual transport-identity change, not proof that an original leased consumer retried.
      await service.handleApprovalCompletionTrigger({ ...run.event, eventId: 'sa06ap_retry_' + randomUUID() })
      expect((await execution(run.ruleId)).steps).toMatchObject([{ status: 'success' }])
      expect(await totals()).toEqual({ ...before, revisions: Number(before.revisions) + 1, claims: Number(before.claims) + 1,
        images: Number(before.images) + 1, events: Number(before.events) + 1 })
      expect(await storedRecord(run.recordId)).toMatchObject({ version: 4, data: { [fieldId]: 'synthetic rollback' } })
      expect((await imageForRule(run.ruleId)).status).toBe('captured')
    } finally { await dropTrigger(trigger, 'meta_automation_record_after_images') }
  }, 20000)

  test.each([{ label: 'RETURN NULL zero-row', body: 'RETURN NULL;', error: 'fwb_rejected:linked_record_unavailable' },
    { label: 'invalid durable version receipt', body: 'NEW.version:=0; RETURN NEW;', error: 'fwb_execution_failed' }])('$label rejects with no success image or effects', async variant => {
    const run = await completedApproval('synthetic no receipt'), before = await totals(), beforeRecord = await storedRecord(run.recordId)
    const trigger = 'sa06ap_receipt_' + randomBytes(6).toString('hex')
    try {
      await q(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN ${variant.body} END $fn$`)
      await q(`CREATE TRIGGER ${trigger}_trg BEFORE UPDATE ON meta_records FOR EACH ROW EXECUTE FUNCTION ${trigger}()`)
      if (variant.error === 'fwb_execution_failed') {
        await expect(service.handleApprovalCompletionTrigger(run.event)).rejects.toThrow('approval_completed_trigger_retryable_failure')
      } else await service.handleApprovalCompletionTrigger(run.event)
      expect((await execution(run.ruleId)).steps).toMatchObject([{ status: 'failed', error: variant.error }])
      expect(await totals()).toEqual(before)
      expect(await storedRecord(run.recordId)).toEqual(beforeRecord)
    } finally { await dropTrigger(trigger, 'meta_records') }
  }, 15000)

  test('real schema NOWAIT 55P03/savepoint permits update but unavailable schema fails condition closed', async () => {
    const run = await completedApproval('synthetic nowait'), holder = await ownedPool.connect()
    const infrastructure = poolManager.get(), originalTransaction = infrastructure.transaction.bind(infrastructure)
    type ActualTransactionClient = Parameters<Parameters<typeof infrastructure.transaction>[0]>[0]
    const observations: Array<{ statement: string; settled: PromiseSettledResult<unknown> }> = []
    const observedTransaction = async <T>(handler: (actual: ActualTransactionClient) => Promise<T>): Promise<T> =>
      originalTransaction(async actual => {
        const originalQuery = actual.query, observationTasks: Promise<void>[] = []
        // Forward the same client and returned promise; errors come from real PostgreSQL.
        const observedQuery: typeof actual.query = (...args: Parameters<typeof actual.query>) => {
          const sqlOrConfig: unknown = args[0]
          const statement = typeof sqlOrConfig === 'string' ? sqlOrConfig
            : sqlOrConfig !== null && typeof sqlOrConfig === 'object' && 'text' in sqlOrConfig
              && typeof sqlOrConfig.text === 'string' ? sqlOrConfig.text : ''
          const returned = originalQuery(...args) as Promise<unknown>
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
      await holder.query('LOCK TABLE meta_fields IN SHARE UPDATE EXCLUSIVE MODE')
      await service.handleApprovalCompletionTrigger(run.event)
      const exec = await execution(run.ruleId)
      expect(exec.steps, JSON.stringify(exec)).toMatchObject([{ status: 'success' }])
      const locks = observations.filter(observed => /LOCK TABLE meta_sheets, meta_fields/u.test(observed.statement))
      expect(locks).toHaveLength(1)
      expect(locks[0].settled).toMatchObject({ status: 'rejected', reason: { code: '55P03' } })
      const rollbacks = observations.filter(observed => observed.statement === 'ROLLBACK TO SAVEPOINT automation_record_schema_capture')
      expect(rollbacks).toHaveLength(1)
      expect(rollbacks[0].settled.status).toBe('fulfilled')
      await holder.query('ROLLBACK')
      const image = await imageForRule(run.ruleId)
      expect(image).toMatchObject({ status: 'captured', schema_revision: null, sheet_id: targetSheetId,
        after_image: { [fieldId]: 'synthetic nowait', [preservedFieldId]: 'synthetic untouched' } })
      expect(await condition(image, 'synthetic nowait')).toEqual({ kind: 'unreadable', reason: 'AFTER_IMAGE_UNAVAILABLE' })
    } finally {
      try { await holder.query('ROLLBACK') } finally {
        try { holder.release() } finally { transactions.mockRestore() }
      }
    }
  }, 20000)

  test.each([{ label: 'OFF', fwb: 'false', durable: 'true', status: 'skipped' },
    { label: 'half-durable', fwb: 'true', durable: 'false', status: 'failed' }])('$label preserves zero-update and zero-image contract', async flags => {
    const run = await completedApproval('synthetic flags'), before = await totals(), beforeRecord = await storedRecord(run.recordId)
    vi.stubEnv('APPROVAL_FWB_WRITEBACK_ENABLED', flags.fwb)
    vi.stubEnv('AUTOMATION_DURABLE_DELIVERY_ENABLED', flags.durable)
    await service.handleApprovalCompletionTrigger(run.event)
    const exec = await execution(run.ruleId)
    expect(exec.steps, JSON.stringify(exec)).toMatchObject([{ status: flags.status }])
    if (flags.status === 'failed') expect(String(exec.steps[0]?.error)).toMatch(/AUTOMATION_DURABLE_DELIVERY_ENABLED/u)
    expect(await totals()).toEqual(before)
    expect(await storedRecord(run.recordId)).toEqual(beforeRecord)
  }, 15000)

  test('real record lock denies before claim/capture/update', async () => {
    const run = await completedApproval('synthetic locked')
    await q('UPDATE meta_records SET locked=true,locked_by=$1 WHERE id=$2', [requesterId, run.recordId])
    const before = await totals(), beforeRecord = await storedRecord(run.recordId)
    await service.handleApprovalCompletionTrigger(run.event)
    expect((await execution(run.ruleId)).steps).toMatchObject([{ status: 'failed', error: 'fwb_rejected:linked_record_unavailable' }])
    expect(await totals()).toEqual(before)
    expect(await storedRecord(run.recordId)).toEqual(beforeRecord)
  }, 15000)

  test('real revoked target write authority fails production permission gates without claim/update/image', async () => {
    const run = await completedApproval('synthetic revoked'), before = await totals(), beforeRecord = await storedRecord(run.recordId)
    try {
      await q('UPDATE users SET is_admin=false WHERE id=$1', [creatorId])
      await q('DELETE FROM user_roles WHERE user_id=$1', [creatorId])
      await invalidateUserPerms(creatorId)
      await service.handleApprovalCompletionTrigger(run.event)
      const exec = await execution(run.ruleId)
      expect(exec.steps).toMatchObject([{ status: 'failed' }])
      expect(String(exec.steps[0]?.error)).toMatch(/^fwb_rejected:permission_gates:.*target_writable/u)
      expect(await totals()).toEqual(before)
      expect(await storedRecord(run.recordId)).toEqual(beforeRecord)
    } finally {
      await q('UPDATE users SET is_admin=true WHERE id=$1', [creatorId])
      await q("INSERT INTO user_roles(user_id,role_id) VALUES($1,'admin')", [creatorId])
      await invalidateUserPerms(creatorId)
    }
  }, 15000)
})
