/**
 * T3-6 — Approval data as first-class multitable records (read-model projection) · real-DB integration.
 *
 * Design-lock: docs/development/t3-6-approvals-as-multitable-records-design-lock-20260703.md (§7 plan).
 *
 * Real chain over real Postgres + the real in-process eventBus:
 *   ApprovalProductService.createApproval → awaited create hook → ApprovalRecordProjectionService.reconcile
 *     (direct SQL, EVENT-SILENT materialization on meta_records + the approval_record_projection mapping);
 *   ApprovalProductService.dispatchAction(approve/reject/revoke) → emitApprovalCompletionEvent
 *     → projection subscription → reconcile (SAME row, version-guarded, idempotent).
 *
 * Covers §7: create→pending row · each terminal outcome→same row (no 2nd) · auto-approve→one row ·
 * redelivery idempotent · §6a event-silence (no record.* automation fires) · §6b reconcile+sweep after a
 * dropped/stale row · no write-back · visibility (admin/owner-scoped) · best-effort (failure never fails
 * the approval flow).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { db } from '../../src/db/db'
import { eventBus as integrationEventBus } from '../../src/integration/events/event-bus'
import { withAutomationEventId } from '../../src/multitable/automation-event-dedup'
import { AutomationService } from '../../src/multitable/automation-service'
import { resolveSheetCapabilitiesForUser } from '../../src/multitable/sheet-capabilities'
import {
  ApprovalRecordProjectionService,
  APPROVAL_PROJECTION_BASE_ID,
  deriveProjectionFieldId,
  deriveProjectionRecordId,
  deriveProjectionSheetId,
  getApprovalRecordProjectionService,
  setApprovalRecordProjectionServiceForTests,
} from '../../src/multitable/approval-record-projection-service'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const REQUESTER = `u_prj_req_${TS}`
const APPROVER = `u_prj_appr_${TS}`
const ADMIN = `u_prj_admin_${TS}`
const NONADMIN = `u_prj_none_${TS}`

const q = (sqlText: string, params?: unknown[]) => poolManager.get().query(sqlText, params)
const queryFn = ((sqlText: string, params?: unknown[]) => poolManager.get().query(sqlText, params)) as never

let approvals: ApprovalProductService
let projection: ApprovalRecordProjectionService
let automation: AutomationService | undefined
let normalTemplateId = ''
let autoTemplateId = ''
const ruleIds: string[] = []
const notifications: Array<{ message: string; sheetId: string }> = []
const recordEventSheetIds: string[] = []

function normalTemplateRequest() {
  return {
    key: `prj-normal-${TS}`,
    name: 'Projection Normal Template',
    formSchema: { fields: [{ id: 'summary', type: 'text', label: 'Summary', required: true }] },
    approvalGraph: {
      nodes: [
        { key: 'start', type: 'start', name: 'Start', config: {} },
        {
          key: 'approval_1',
          type: 'approval',
          name: 'Approver',
          config: { assigneeType: 'user', assigneeIds: [APPROVER], approvalMode: 'single' },
        },
        { key: 'end', type: 'end', name: 'End', config: {} },
      ],
      edges: [
        { key: 'e-start-a', source: 'start', target: 'approval_1' },
        { key: 'e-a-end', source: 'approval_1', target: 'end' },
      ],
    },
  }
}

function autoTemplateRequest() {
  return {
    key: `prj-auto-${TS}`,
    name: 'Projection Auto-Approve Template',
    formSchema: { fields: [{ id: 'summary', type: 'text', label: 'Summary', required: true }] },
    approvalGraph: {
      nodes: [
        { key: 'start', type: 'start', name: 'Start', config: {} },
        {
          key: 'approval_empty',
          type: 'approval',
          name: 'Auto',
          config: { assigneeType: 'user', assigneeIds: [], approvalMode: 'single', emptyAssigneePolicy: 'auto-approve' },
        },
        { key: 'end', type: 'end', name: 'End', config: {} },
      ],
      edges: [
        { key: 'e-start-a', source: 'start', target: 'approval_empty' },
        { key: 'e-a-end', source: 'approval_empty', target: 'end' },
      ],
    },
  }
}

const requesterActor = () => ({ userId: REQUESTER, userName: REQUESTER })
const approverActor = () => ({ userId: APPROVER, userName: APPROVER })

async function createNormal(): Promise<string> {
  const dto = await approvals.createApproval({ templateId: normalTemplateId, formData: { summary: 's' } }, requesterActor())
  return (dto as { id: string }).id
}

interface ProjectionRow {
  instance_id: string
  base_id: string
  sheet_id: string
  record_id: string
  projected_version: number
  last_error: string | null
}

async function getMapping(instanceId: string): Promise<ProjectionRow | null> {
  const r = await q('SELECT * FROM approval_record_projection WHERE instance_id = $1', [instanceId])
  return (r.rows[0] as ProjectionRow | undefined) ?? null
}

async function getProjectedRecord(instanceId: string): Promise<{ data: Record<string, unknown>; version: number } | null> {
  const r = await q('SELECT data, version FROM meta_records WHERE id = $1', [deriveProjectionRecordId(instanceId)])
  const row = r.rows[0] as { data: Record<string, unknown>; version: number } | undefined
  return row ? { data: row.data, version: Number(row.version) } : null
}

function col(data: Record<string, unknown>, sheetId: string, key: string): string {
  const value = data[deriveProjectionFieldId(sheetId, key)]
  return typeof value === 'string' ? value : ''
}

async function countRecordsForSheet(sheetId: string): Promise<number> {
  const r = await q('SELECT COUNT(*)::int AS count FROM meta_records WHERE sheet_id = $1', [sheetId])
  return (r.rows[0] as { count: number }).count
}

async function waitForProjectedStatus(instanceId: string, expected: string, timeoutMs = 6000): Promise<Record<string, unknown>> {
  const sheetId = deriveProjectionSheetId(normalTemplateId)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const rec = await getProjectedRecord(instanceId)
    if (rec && col(rec.data, sheetId, 'status') === expected) return rec.data
    if (Date.now() > deadline) return rec?.data ?? {}
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
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

describeIfDatabase('T3-6 approval record projection (real DB)', () => {
  beforeAll(async () => {
    await q(
      `INSERT INTO permissions (code, name, description)
       VALUES ('approvals:read','Approvals Read','prj'),('approvals:write','Approvals Write','prj'),('approvals:act','Approvals Act','prj')
       ON CONFLICT (code) DO NOTHING`,
    )
    for (const uid of [REQUESTER, APPROVER, ADMIN, NONADMIN]) {
      const isAdminFlag = uid === ADMIN
      await q(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
         VALUES ($1, $2, $1, 'x', $3, '[]'::jsonb, TRUE, $4)
         ON CONFLICT (id) DO UPDATE SET is_active = TRUE, is_admin = EXCLUDED.is_admin, role = EXCLUDED.role`,
        [uid, `${uid}@prj.test`, isAdminFlag ? 'admin' : 'user', isAdminFlag],
      )
    }
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,'approvals:write') ON CONFLICT DO NOTHING`, [REQUESTER])
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,'approvals:act') ON CONFLICT DO NOTHING`, [APPROVER])
    // isAdmin() is resolved from user_roles (not users.is_admin), so make ADMIN a real admin there.
    await q(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, 'admin') ON CONFLICT DO NOTHING`, [ADMIN])

    approvals = new ApprovalProductService()
    const normal = await approvals.createTemplate(normalTemplateRequest() as never)
    normalTemplateId = (normal as { id: string }).id
    await approvals.publishTemplate(normalTemplateId, { policy: { allowRevoke: true } } as never)
    const auto = await approvals.createTemplate(autoTemplateRequest() as never)
    autoTemplateId = (auto as { id: string }).id
    await approvals.publishTemplate(autoTemplateId, { policy: { allowRevoke: true } } as never)

    // The projection service is the module singleton (the create hook inside createApproval uses it) —
    // wire the SAME instance to the completion bus for the terminal projection trigger.
    projection = new ApprovalRecordProjectionService()
    setApprovalRecordProjectionServiceForTests(projection)
    projection.subscribe(integrationEventBus)

    integrationEventBus.subscribe('automation.notification', (payload) => {
      notifications.push(payload as (typeof notifications)[number])
    })
    integrationEventBus.subscribe('multitable.record.created', (payload) => {
      const sheetId = (payload as { sheetId?: string }).sheetId
      if (sheetId) recordEventSheetIds.push(sheetId)
    })
    integrationEventBus.subscribe('multitable.record.updated', (payload) => {
      const sheetId = (payload as { sheetId?: string }).sheetId
      if (sheetId) recordEventSheetIds.push(sheetId)
    })
  })

  afterAll(async () => {
    try { projection?.unsubscribe(integrationEventBus) } catch { /* noop */ }
    try { automation?.shutdown() } catch { /* noop */ }
    setApprovalRecordProjectionServiceForTests(null)
    const templateIds = [normalTemplateId, autoTemplateId].filter(Boolean)
    const instances = await q('SELECT id FROM approval_instances WHERE template_id = ANY($1::uuid[])', [templateIds]).catch(() => ({ rows: [] as unknown[] }))
    for (const row of instances.rows as Array<{ id: string }>) {
      await q('DELETE FROM approval_record_projection WHERE instance_id = $1', [row.id]).catch(() => {})
      await q('DELETE FROM approval_assignments WHERE instance_id = $1', [row.id]).catch(() => {})
      await q('DELETE FROM approval_records WHERE instance_id = $1', [row.id]).catch(() => {})
      await q('DELETE FROM approval_instances WHERE id = $1', [row.id]).catch(() => {})
    }
    if (ruleIds.length > 0) {
      await q('DELETE FROM meta_automation_event_fires WHERE rule_id = ANY($1::text[])', [ruleIds]).catch(() => {})
      await q('DELETE FROM multitable_automation_executions WHERE rule_id = ANY($1::text[])', [ruleIds]).catch(() => {})
      await q('DELETE FROM automation_rules WHERE id = ANY($1::text[])', [ruleIds]).catch(() => {})
    }
    // System sheets (deterministic per family) + their records/fields cascade; then the shared base.
    await q('DELETE FROM meta_sheets WHERE base_id = $1', [APPROVAL_PROJECTION_BASE_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [APPROVAL_PROJECTION_BASE_ID]).catch(() => {})
    for (const tid of templateIds) {
      await q('DELETE FROM approval_templates WHERE id = $1', [tid]).catch(() => {})
    }
    await q('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[REQUESTER, APPROVER, ADMIN, NONADMIN]]).catch(() => {})
    await q('DELETE FROM user_roles WHERE user_id = ANY($1::text[])', [[REQUESTER, APPROVER, ADMIN, NONADMIN]]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[REQUESTER, APPROVER, ADMIN, NONADMIN]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('create → one projected PENDING row with the §3 columns + a mapping row', async () => {
    const sheetId = deriveProjectionSheetId(normalTemplateId)
    const instanceId = await createNormal()

    const mapping = await getMapping(instanceId)
    expect(mapping, 'mapping row links instance→record').toBeTruthy()
    expect(mapping!.base_id).toBe(APPROVAL_PROJECTION_BASE_ID)
    expect(mapping!.sheet_id).toBe(sheetId)
    expect(mapping!.record_id).toBe(deriveProjectionRecordId(instanceId))
    expect(mapping!.projected_version).toBe(0)
    expect(mapping!.last_error).toBeNull()

    const rec = await getProjectedRecord(instanceId)
    expect(rec, 'projected record exists after the awaited create hook').toBeTruthy()
    expect(col(rec!.data, sheetId, 'status')).toBe('pending')
    expect(col(rec!.data, sheetId, 'outcome')).toBe('')
    expect(col(rec!.data, sheetId, 'requesterId')).toBe(REQUESTER)
    expect(col(rec!.data, sheetId, 'approverId')).toBe('')
    expect(col(rec!.data, sheetId, 'templateId')).toBe(normalTemplateId)
    expect(col(rec!.data, sheetId, 'templateName')).toBe('Projection Normal Template')
    expect(col(rec!.data, sheetId, 'requestNo').length).toBeGreaterThan(0)
    expect(col(rec!.data, sheetId, 'createdAt').length).toBeGreaterThan(0)
    expect(col(rec!.data, sheetId, 'completedAt')).toBe('')
    // NO form_snapshot column is projected (§3 allowlist).
    expect(Object.keys(rec!.data)).not.toContain(deriveProjectionFieldId(sheetId, 'form_snapshot'))
  })

  test('terminal APPROVED → SAME row updated (no 2nd row), approverId + completedAt set', async () => {
    const sheetId = deriveProjectionSheetId(normalTemplateId)
    const instanceId = await createNormal()
    const before = await countRecordsForSheet(sheetId)

    await approvals.dispatchAction(instanceId, { action: 'approve', comment: 'ok' } as never, approverActor())
    const data = await waitForProjectedStatus(instanceId, 'approved')

    expect(col(data, sheetId, 'status')).toBe('approved')
    expect(col(data, sheetId, 'outcome')).toBe('approved')
    expect(col(data, sheetId, 'approverId')).toBe(APPROVER)
    expect(col(data, sheetId, 'completedAt').length).toBeGreaterThan(0)
    // Same row: sheet record count did not grow for this instance's update.
    expect(await countRecordsForSheet(sheetId)).toBe(before)
    const mapping = await getMapping(instanceId)
    expect(mapping!.projected_version).toBeGreaterThan(0)
  })

  test('terminal REJECTED → same row, outcome rejected', async () => {
    const sheetId = deriveProjectionSheetId(normalTemplateId)
    const instanceId = await createNormal()
    await approvals.dispatchAction(instanceId, { action: 'reject', comment: 'no' } as never, approverActor())
    const data = await waitForProjectedStatus(instanceId, 'rejected')
    expect(col(data, sheetId, 'status')).toBe('rejected')
    expect(col(data, sheetId, 'outcome')).toBe('rejected')
    expect(col(data, sheetId, 'approverId')).toBe(APPROVER)
  })

  test('terminal REVOKED → same row, outcome revoked', async () => {
    const sheetId = deriveProjectionSheetId(normalTemplateId)
    const instanceId = await createNormal()
    await approvals.dispatchAction(instanceId, { action: 'revoke', comment: 'recall' } as never, requesterActor())
    const data = await waitForProjectedStatus(instanceId, 'revoked')
    expect(col(data, sheetId, 'status')).toBe('revoked')
    expect(col(data, sheetId, 'outcome')).toBe('revoked')
  })

  test('terminal CANCELLED derivation → same row via reconcile (product API has no cancel path in this slice)', async () => {
    const sheetId = deriveProjectionSheetId(normalTemplateId)
    const instanceId = await createNormal()
    const before = await countRecordsForSheet(sheetId)
    // Simulate the authoritative cancel + a monotonic version bump, then reconcile (the SAME core the
    // completion-event subscription runs). cancelled has no decider record → approverId stays ''.
    await q(`UPDATE approval_instances SET status = 'cancelled', version = version + 1, updated_at = now() WHERE id = $1`, [instanceId])
    const outcome = await projection.reconcile(instanceId)
    expect(outcome.status).toBe('projected')
    const rec = await getProjectedRecord(instanceId)
    expect(col(rec!.data, sheetId, 'status')).toBe('cancelled')
    expect(col(rec!.data, sheetId, 'outcome')).toBe('cancelled')
    expect(col(rec!.data, sheetId, 'approverId')).toBe('')
    expect(await countRecordsForSheet(sheetId)).toBe(before)
  })

  test('auto-approve-at-create → exactly ONE row, terminal', async () => {
    const sheetId = deriveProjectionSheetId(autoTemplateId)
    const dto = await approvals.createApproval({ templateId: autoTemplateId, formData: { summary: 'auto' } }, requesterActor())
    const instanceId = (dto as { id: string; status: string }).id
    expect((dto as { status: string }).status).toBe('approved')

    // Give the completion-event reconcile a chance to (no-op) run — must NOT create a second row.
    await new Promise((resolve) => setTimeout(resolve, 300))

    const recs = await q('SELECT id FROM meta_records WHERE sheet_id = $1', [sheetId])
    const forInstance = (recs.rows as Array<{ id: string }>).filter((r) => r.id === deriveProjectionRecordId(instanceId))
    expect(forInstance.length, 'auto-approve maps to exactly one row').toBe(1)
    const rec = await getProjectedRecord(instanceId)
    expect(col(rec!.data, sheetId, 'status')).toBe('approved')
    expect(col(rec!.data, sheetId, 'outcome')).toBe('approved')
    // approverId reflects the AUTHORITATIVE decider record. An empty-assignee auto-approve writes a
    // `system:auto-approval` decision record, so the read-model records the system as the approver
    // (richer + reconcile-consistent — sweep and live derive it identically from approval_records).
    expect(col(rec!.data, sheetId, 'approverId')).toBe('system:auto-approval')
    const mapping = await getMapping(instanceId)
    expect(mapping!.projected_version).toBe(0)
  })

  test('redelivery of create + terminal is idempotent (no dup row, no double-update)', async () => {
    const sheetId = deriveProjectionSheetId(normalTemplateId)
    const instanceId = await createNormal()
    await approvals.dispatchAction(instanceId, { action: 'approve', comment: 'ok' } as never, approverActor())
    await waitForProjectedStatus(instanceId, 'approved')

    const recBefore = await getProjectedRecord(instanceId)
    const mappingBefore = await getMapping(instanceId)
    const countBefore = await countRecordsForSheet(sheetId)

    // Re-run reconcile several times (models create + terminal event redelivery). All must be no-ops.
    for (let i = 0; i < 3; i += 1) {
      const outcome = await projection.reconcile(instanceId)
      expect(outcome.status).toBe('noop')
    }

    const recAfter = await getProjectedRecord(instanceId)
    const mappingAfter = await getMapping(instanceId)
    expect(await countRecordsForSheet(sheetId)).toBe(countBefore)
    expect(recAfter!.version, 'record version unchanged (no double-write)').toBe(recBefore!.version)
    expect(mappingAfter!.projected_version).toBe(mappingBefore!.projected_version)
  })

  test('§6a event-silence: a record.created rule on the system sheet does NOT fire on a projection write', async () => {
    const sheetId = deriveProjectionSheetId(normalTemplateId)
    // Ensure the system sheet exists (a prior create already provisioned it).
    expect(await countRecordsForSheet(sheetId)).toBeGreaterThan(0)

    automation = new AutomationService(integrationEventBus, db as never, queryFn)
    automation.init()
    const rule = await automation.createRule(sheetId, {
      name: 'silence probe',
      triggerType: 'record.created',
      actionType: 'send_notification',
      actionConfig: { userIds: [APPROVER], message: 'SILENCE_PROBE' },
      createdBy: ADMIN,
    } as never)
    const ruleId = (rule as { id: string }).id
    ruleIds.push(ruleId)

    recordEventSheetIds.length = 0
    const notifBefore = notifications.filter((n) => n.message === 'SILENCE_PROBE').length

    // Projection write (create → pending, then terminal → update) targeting the SAME system sheet.
    const instanceId = await createNormal()
    await approvals.dispatchAction(instanceId, { action: 'approve', comment: 'ok' } as never, approverActor())
    await waitForProjectedStatus(instanceId, 'approved')
    await new Promise((resolve) => setTimeout(resolve, 400))

    expect(await executionCount(ruleId), 'projection write must not execute the system-sheet rule').toBe(0)
    expect(notifications.filter((n) => n.message === 'SILENCE_PROBE').length).toBe(notifBefore)
    expect(recordEventSheetIds.filter((s) => s === sheetId), 'projection emits NO record.* bus event for the system sheet').toEqual([])

    // Positive control: a GENUINE record.created bus event for the same sheet DOES fire the rule — so the
    // zero above is event-silence, not a dead rule.
    integrationEventBus.emit('multitable.record.created', withAutomationEventId({
      sheetId,
      recordId: deriveProjectionRecordId(instanceId),
      data: {},
      actorId: 'sys-control',
    }))
    expect(await waitForExecutionCount(ruleId, 1), 'the rule IS live on a real bus event').toBe(1)
  })

  test('§6b reconcile: a dropped projected row is restored idempotently; a newer live projection is never clobbered', async () => {
    const sheetId = deriveProjectionSheetId(normalTemplateId)
    const instanceId = await createNormal()
    await approvals.dispatchAction(instanceId, { action: 'approve', comment: 'ok' } as never, approverActor())
    await waitForProjectedStatus(instanceId, 'approved')
    const liveVersion = (await getMapping(instanceId))!.projected_version

    // Simulate a lost write: drop BOTH the projected record and the mapping row.
    await q('DELETE FROM approval_record_projection WHERE instance_id = $1', [instanceId])
    await q('DELETE FROM meta_records WHERE id = $1', [deriveProjectionRecordId(instanceId)])
    expect(await getProjectedRecord(instanceId)).toBeNull()

    // Reconcile restores it to the authoritative §3 columns.
    const restored = await projection.reconcile(instanceId)
    expect(restored.status).toBe('projected')
    const rec = await getProjectedRecord(instanceId)
    expect(col(rec!.data, sheetId, 'status')).toBe('approved')
    expect((await getMapping(instanceId))!.projected_version).toBe(liveVersion)

    // Re-run → idempotent no-op (guarded by projected_version).
    expect((await projection.reconcile(instanceId)).status).toBe('noop')

    // Never-clobber: stale the mapping to a LOWER version, keep the newer live record; reconcile must NOT
    // overwrite the newer record body (source version is not strictly newer than the live projection).
    await createNormal() // unrelated, keeps the sweep predicate exercised below
    const recVersionBefore = (await getProjectedRecord(instanceId))!.version
    await q('UPDATE approval_record_projection SET projected_version = projected_version + 5 WHERE instance_id = $1', [instanceId])
    const clobberAttempt = await projection.reconcile(instanceId)
    expect(clobberAttempt.status).toBe('noop')
    expect((await getProjectedRecord(instanceId))!.version, 'record body not clobbered by a stale reconcile').toBe(recVersionBefore)
  })

  test('§6b sweep: an instance ahead of its projection is found + reconciled', async () => {
    const sheetId = deriveProjectionSheetId(normalTemplateId)
    const instanceId = await createNormal() // projected pending at v0
    // Advance authoritative state past the projection WITHOUT going through the event (models a missed event).
    await q(`UPDATE approval_instances SET status = 'approved', version = version + 1, updated_at = now() WHERE id = $1`, [instanceId])
    await q(
      `INSERT INTO approval_records (instance_id, action, actor_id, actor_name, from_status, to_status, to_version, occurred_at)
       VALUES ($1, 'approve', $2, $2, 'pending', 'approved', (SELECT version FROM approval_instances WHERE id = $1), now())`,
      [instanceId, APPROVER],
    )

    const result = await projection.sweep({ limit: 500 })
    expect(result.reconciled).toBeGreaterThanOrEqual(1)
    const rec = await getProjectedRecord(instanceId)
    expect(col(rec!.data, sheetId, 'status')).toBe('approved')
    expect(col(rec!.data, sheetId, 'approverId')).toBe(APPROVER)
  })

  test('no write-back: editing the projected record does not mutate the approval instance', async () => {
    const instanceId = await createNormal()
    const before = await q('SELECT status, version FROM approval_instances WHERE id = $1', [instanceId])
    const beforeRow = before.rows[0] as { status: string; version: number }

    const recordId = deriveProjectionRecordId(instanceId)
    await q(`UPDATE meta_records SET data = data || '{"tampered":"yes"}'::jsonb WHERE id = $1`, [recordId])

    const after = await q('SELECT status, version FROM approval_instances WHERE id = $1', [instanceId])
    const afterRow = after.rows[0] as { status: string; version: number }
    expect(afterRow.status).toBe(beforeRow.status)
    expect(Number(afterRow.version)).toBe(Number(beforeRow.version))
  })

  test('visibility: system sheet is admin/owner-scoped (admin canRead; a non-privileged non-admin cannot)', async () => {
    const sheetId = deriveProjectionSheetId(normalTemplateId)
    const adminCaps = await resolveSheetCapabilitiesForUser(queryFn, sheetId, ADMIN)
    expect(adminCaps.capabilities.canRead, 'admin can read the system sheet').toBe(true)

    const nonAdminCaps = await resolveSheetCapabilitiesForUser(queryFn, sheetId, NONADMIN)
    expect(nonAdminCaps.isAdminRole).toBe(false)
    expect(nonAdminCaps.capabilities.canRead, 'a non-privileged non-admin cannot read the system sheet').toBe(false)
  })

  test('best-effort: a projection failure at the create hook never fails the approval flow', async () => {
    class ThrowingProjection extends ApprovalRecordProjectionService {
      override async reconcile(): Promise<never> {
        throw new Error('forced projection failure')
      }
    }
    setApprovalRecordProjectionServiceForTests(new ThrowingProjection())
    try {
      const dto = await approvals.createApproval({ templateId: normalTemplateId, formData: { summary: 'be' } }, requesterActor())
      const instanceId = (dto as { id: string }).id
      expect(instanceId, 'createApproval succeeds despite a throwing projection').toBeTruthy()
      const exists = await q('SELECT 1 FROM approval_instances WHERE id = $1', [instanceId])
      expect(exists.rows.length).toBe(1)
    } finally {
      setApprovalRecordProjectionServiceForTests(projection)
    }
  })
})
