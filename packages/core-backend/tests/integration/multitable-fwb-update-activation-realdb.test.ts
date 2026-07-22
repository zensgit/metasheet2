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
 *   - locked / deleted / write-revoked fail-closed;
 *   - duplicate net-once under a new eventId;
 *   - rollback atomicity (injected post-handler abort erases claim + update + revision + outbox);
 *   - discriminating mutation target (updates bound record A, never sibling record B).
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
  { formFieldId: 'amount', targetFieldId: F_AMOUNT, targetType: 'number' as const },
]

function setFlags(fwb: boolean, durable: boolean) {
  if (fwb) process.env.APPROVAL_FWB_WRITEBACK_ENABLED = 'true'
  else delete process.env.APPROVAL_FWB_WRITEBACK_ENABLED
  if (durable) process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = 'true'
  else delete process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED
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

function approvalTemplateRequest(linkBaseId: string, linkSheetId: string) {
  return {
    key: `fwb2-${TS}`,
    name: 'FWB-2 Update Template',
    formSchema: {
      fields: [
        { id: 'summary', type: 'text', label: 'Summary', required: true },
        { id: 'amount', type: 'number', label: 'Amount', required: true },
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

function completionEvent(instanceId: string, eventId: string) {
  return {
    version: 1,
    source: 'approval-product',
    eventType: 'approval.approved',
    eventId,
    occurredAt: new Date().toISOString(),
    approval: { instanceId, templateId, templateVersionId, status: 'approved' },
    transition: {
      action: 'approve',
      fromStatus: 'pending',
      toStatus: 'approved',
      fromVersion: 1,
      toVersion: 2,
      nodeKey: 'approval_1',
    },
    requester: { id: REQUESTER, name: REQUESTER },
    actor: null,
  } as never
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

    svc = new AutomationService(integrationEventBus, db as never, queryFn)
  })

  afterAll(async () => {
    setFlags(false, false)
    try { svc?.shutdown() } catch { /* noop */ }
    for (const ruleId of ruleIds) {
      await q('DELETE FROM automation_rules WHERE id = $1', [ruleId]).catch(() => {})
      await q('DELETE FROM multitable_automation_executions WHERE rule_id = $1', [ruleId]).catch(() => {})
      await q('DELETE FROM meta_fwb_action_applied WHERE rule_id = $1', [ruleId]).catch(() => {})
    }
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
      expect(await recordData(REC_A)).toMatchObject({ [F_TITLE]: 'updated-A', [F_AMOUNT]: 42 })
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
      expect(await recordData(REC_A)).toMatchObject({ [F_TITLE]: 'primary-applied', [F_AMOUNT]: 73 })
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

  test('locked / deleted fail-closed with stable reasons and zero mutation', async () => {
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
        expect(String(run.steps[0]?.error ?? '')).toBe('fwb_rejected:record_locked')
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
      expect(String(run2.steps[0]?.error ?? '')).toBe('fwb_rejected:record_missing')
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
      expect(String(run.steps[0]?.error ?? '')).toBe('fwb_rejected:record_locked')
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
        [TARGET_SHEET, F_AMOUNT, CREATOR],
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
          [TARGET_SHEET, F_AMOUNT, CREATOR],
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
        [TARGET_SHEET, F_AMOUNT, CREATOR],
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
        [TARGET_SHEET, F_AMOUNT, CREATOR],
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
      expect(await recordData(ownRecord)).toMatchObject({ [F_TITLE]: 'own-updated', [F_AMOUNT]: 1 })

      const foreignInstance = await startInstance({ summary: 'must-not-update', amount: 2, linked: { recordId: foreignRecord } })
      await approveInstance(foreignInstance)
      const foreignRun = await executor.execute(
        executorRule(ruleId, config),
        triggerPayload(foreignInstance, `evt_fwb2_foreign_${TS}`),
      )
      expect(foreignRun.steps[0]?.status).toBe('failed')
      expect(String(foreignRun.steps[0]?.error ?? '')).toBe('fwb_rejected:record_not_writable')
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
      expect(await recordData(REC_A)).toMatchObject({ [F_TITLE]: 'net-once-2', [F_AMOUNT]: 11 })
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
      expect(await recordData(REC_A)).toMatchObject({ [F_TITLE]: 'atomic', [F_AMOUNT]: 7 })
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
})
