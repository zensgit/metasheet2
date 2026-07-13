/**
 * R13 Lane C (automation create/update + result-writeback) — site 3:
 *
 *   `automation-service.ts` `applyResultWritebackPatch` (approval-result backwrite, W7-1 same-base +
 *   T3-5 cross-base) — bare UPDATE, no revision.
 *
 * Per the RATIFIED design-lock (docs/development/multitable-global-history-d1c-form-submit-edit-
 * uncaptured-revision-design-lock-20260712.md, §0.5 OD-1..OD-6, §7a A7) this is a bucket-A content path:
 * a shipped, unflagged automation writes into `meta_records.data` on `approval.approved` completion with
 * NO `meta_record_revisions` row, so `reconstructRecordsAtT` never learns the writeback happened — the
 * exact D-1c class of bug (PIT lie / spurious Reset-to-T revert / audit-hole), just triggered by an
 * approval outcome instead of a form-submit edit.
 *
 * Fix: `recordRecordRevision(...)` now runs in the SAME transaction as the patch UPDATE — source
 * ='automation' (OD-2), actorId = OD-3's ratified "chainActorId/lockActorId" (same-base: the APPROVAL
 * actor who dispatched approve/reject; cross-base: the TRIGGER actor per Q1), full post-merge snapshot.
 *
 * Harness fidelity: drives the REAL `AutomationService` → `ApprovalProductService.dispatchAction` →
 * `approval.completed` event → `handleApprovalCompletionEvent` → `writeApprovalResultBack(CrossBase)` →
 * `applyResultWritebackPatch` chain (mirrors `multitable-automation-start-approval.test.ts`'s harness) —
 * NOT a hand-rolled call to `applyResultWritebackPatch`. `AutomationService`'s constructor hard-wires
 * `deps.transaction`/its own `withTransaction` to the REAL `poolManager`, so this exercises a genuine
 * Postgres transaction (same production wiring the executor create/update sites use).
 */
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

import { db } from '../../src/db/db'
import { eventBus } from '../../src/integration/events/event-bus'
import { poolManager } from '../../src/integration/db/connection-pool'
import { AutomationService } from '../../src/multitable/automation-service'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'
import { reconstructRecordsAtT } from '../../src/multitable/record-reconstructor'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const BASE = `base_r13c_rw_${TS}`
const SHEET = `sheet_r13c_rw_${TS}`
const RECORD = `rec_r13c_rw_${TS}`
const RECORD2 = `rec_r13c_rw2_${TS}` // dedicated source for RW-2 — RW-1 already writes back onto RECORD
const FAIL_RECORD = `rec_r13c_rw_txfail_${TS}`
const REQUESTER = `u_r13c_rw_req_${TS}`
const APPROVER = `u_r13c_rw_appr_${TS}`

const XB_BASE = `base_r13c_rwxb_${TS}`
const XB_SHEET = `sheet_r13c_rwxb_${TS}`
const XB_RECORD = `rec_r13c_rwxb_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const executionIds: string[] = []
const approvalIds: string[] = []
const ruleIds: string[] = []
const templateIds: string[] = []
let templateSeq = 0

function makeAutomationService(): AutomationService {
  const svc = new AutomationService(eventBus, db as never, q as never)
  svc.init()
  return svc
}

async function seedUsers(): Promise<void> {
  await q(
    `INSERT INTO permissions (code, name, description)
     VALUES ('approvals:write', 'Approvals Write', 'R13C resultWriteback tests')
     ON CONFLICT (code) DO NOTHING`,
  )
  for (const [id, email] of [[REQUESTER, `${REQUESTER}@example.test`], [APPROVER, `${APPROVER}@example.test`]]) {
    await q(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1, $2, $1, 'x', 'user', '[]'::jsonb, TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE SET is_active = TRUE`,
      [id, email],
    )
  }
  await q(
    `INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, 'approvals:write') ON CONFLICT DO NOTHING`,
    [REQUESTER],
  )
}

function templateRequest() {
  templateSeq += 1
  return {
    key: `r13c-rw-${TS}-${templateSeq}`,
    name: 'R13C ResultWriteback',
    visibilityScope: { type: 'all', ids: [] },
    formSchema: { fields: [{ id: 'summary', type: 'text', label: 'Summary', required: true }] },
    approvalGraph: {
      nodes: [
        { key: 'start', type: 'start', name: 'Start', config: {} },
        { key: 'approval_1', type: 'approval', name: 'Approver', config: { assigneeSources: [{ kind: 'static_user', userIds: [APPROVER] }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'end', type: 'end', name: 'End', config: {} },
      ],
      edges: [
        { key: 'e1', source: 'start', target: 'approval_1' },
        { key: 'e2', source: 'approval_1', target: 'end' },
      ],
    },
  }
}

async function createPublishedTemplate(): Promise<string> {
  const approvals = new ApprovalProductService()
  const template = await approvals.createTemplate(templateRequest() as never)
  templateIds.push(template.id)
  await approvals.publishTemplate(template.id, { policy: { allowRevoke: true } } as never)
  return template.id
}

async function waitForExecutionStatus(svc: AutomationService, id: string, status: string) {
  await vi.waitFor(async () => {
    const execution = await svc.logs.getById(id)
    expect(execution?.status, JSON.stringify(execution)).toBe(status)
  }, { timeout: 5000, interval: 50 })
}

async function seedRecordWithCreateRevision(sheetId: string, recordId: string, data: Record<string, unknown>): Promise<void> {
  await q('INSERT INTO meta_records (id, sheet_id, data, version) VALUES ($1,$2,$3::jsonb,1)', [recordId, sheetId, JSON.stringify(data)])
  await q(
    `INSERT INTO meta_record_revisions (id, sheet_id, record_id, version, action, source, changed_field_ids, patch, snapshot, created_at)
     VALUES (gen_random_uuid(), $1, $2, 1, 'create', 'rest', ARRAY[]::text[], '{}'::jsonb, $3::jsonb, '2026-01-01T00:00:00.000Z')`,
    [sheetId, recordId, JSON.stringify(data)],
  )
}

async function revisionCutoffAfter(sheetId: string, recordId: string, action: 'create' | 'update'): Promise<string> {
  const res = await q(
    `SELECT (created_at + interval '1 microsecond')::text AS as_of
       FROM meta_record_revisions
      WHERE sheet_id = $1 AND record_id = $2 AND action = $3
      ORDER BY created_at DESC, version DESC, id DESC
      LIMIT 1`,
    [sheetId, recordId, action],
  )
  expect(res.rows).toHaveLength(1)
  return String((res.rows[0] as { as_of: string }).as_of)
}

async function revisionsFor(sheetId: string, recordId: string) {
  const res = await q(
    `SELECT action, source, version, actor_id, changed_field_ids, snapshot
       FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2 ORDER BY created_at ASC, id ASC`,
    [sheetId, recordId],
  )
  return res.rows as Array<{ action: string; source: string; version: number; actor_id: string | null; changed_field_ids: string[]; snapshot: Record<string, unknown> | null }>
}

describeIfDatabase('R13 Lane C — automation resultWriteback now emits same-txn revisions (real DB)', () => {
  beforeAll(async () => {
    await ensureApprovalSchemaReady()
    await seedUsers()

    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1,$2,$3)', [BASE, 'R13C RW Base', REQUESTER])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'R13C RW Sheet'])
    for (const [id, name, type, property, order] of [
      ['approval_status', 'Approval Status', 'select', { options: [{ value: 'approved' }, { value: 'rejected' }] }, 10],
      ['approved_by', 'Approved By', 'string', {}, 11],
      ['approved_at', 'Approved At', 'dateTime', {}, 12],
    ] as const) {
      await q(
        `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)
         ON CONFLICT (id) DO NOTHING`,
        [id, SHEET, name, type, JSON.stringify(property), order],
      )
    }
    await seedRecordWithCreateRevision(SHEET, RECORD, { title: 'R13C source', notes: 'untouched-note' })
    await seedRecordWithCreateRevision(SHEET, RECORD2, { title: 'R13C source 2', notes: 'untouched-note-2' })
    await seedRecordWithCreateRevision(SHEET, FAIL_RECORD, { title: 'R13C atomicity source', notes: 'untouched-note' })

    // Cross-base target fixtures — REQUESTER owns XB_BASE, so the TRIGGER actor (REQUESTER) has base-write.
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1,$2,$3)', [XB_BASE, 'R13C RW XB Base', REQUESTER])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [XB_SHEET, XB_BASE, 'R13C RW XB Sheet'])
    for (const [id, name, type, property, order] of [
      ['xb_status', 'XB Status', 'select', { options: [{ value: 'approved' }, { value: 'rejected' }] }, 10],
      ['xb_by', 'XB By', 'string', {}, 11],
      ['xb_at', 'XB At', 'dateTime', {}, 12],
    ] as const) {
      await q(
        `INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
        [id, XB_SHEET, name, type, JSON.stringify(property), order],
      )
    }
    await seedRecordWithCreateRevision(XB_SHEET, XB_RECORD, { xb_notes: 'xb-untouched-note' })

    // Atomicity trigger (mirrors D1-5b / the executor create+update goldens): fail the revision INSERT
    // (the LAST statement in applyResultWritebackPatch's transaction) for the dedicated FAIL_RECORD id —
    // proves the patch UPDATE (which ran BEFORE it, in the SAME transaction) rolls back too.
    await q(
      `CREATE OR REPLACE FUNCTION r13c_rw_revision_fail_${TS}()
       RETURNS trigger AS $$
       BEGIN
         IF NEW.action = 'update' AND NEW.record_id = '${FAIL_RECORD}' THEN
           RAISE EXCEPTION 'forced R13C resultWriteback revision failure';
         END IF;
         RETURN NEW;
       END;
       $$ LANGUAGE plpgsql`,
    )
    await q(`DROP TRIGGER IF EXISTS r13c_rw_revision_fail_trigger ON meta_record_revisions`)
    await q(
      `CREATE TRIGGER r13c_rw_revision_fail_trigger
       BEFORE INSERT ON meta_record_revisions
       FOR EACH ROW EXECUTE FUNCTION r13c_rw_revision_fail_${TS}()`,
    )
  })

  afterAll(async () => {
    await q(`DROP TRIGGER IF EXISTS r13c_rw_revision_fail_trigger ON meta_record_revisions`).catch(() => {})
    await q(`DROP FUNCTION IF EXISTS r13c_rw_revision_fail_${TS}()`).catch(() => {})
    for (const id of executionIds) {
      await q('DELETE FROM multitable_automation_approval_bridges WHERE execution_id = $1', [id]).catch(() => {})
      await q('DELETE FROM multitable_automation_suspensions WHERE execution_id = $1', [id]).catch(() => {})
      await q('DELETE FROM multitable_automation_jobs WHERE execution_id = $1', [id]).catch(() => {})
      await q('DELETE FROM multitable_automation_executions WHERE id = $1', [id]).catch(() => {})
    }
    for (const id of approvalIds) {
      await q('DELETE FROM approval_records WHERE instance_id = $1', [id]).catch(() => {})
      await q('DELETE FROM approval_assignments WHERE instance_id = $1', [id]).catch(() => {})
      await q('DELETE FROM approval_instances WHERE id = $1', [id]).catch(() => {})
    }
    for (const id of ruleIds) {
      await q('DELETE FROM automation_rules WHERE id = $1', [id]).catch(() => {})
    }
    for (const id of templateIds) {
      await q('DELETE FROM approval_published_definitions WHERE template_id = $1::uuid', [id]).catch(() => {})
      await q('DELETE FROM approval_template_versions WHERE template_id = $1::uuid', [id]).catch(() => {})
      await q('DELETE FROM approval_templates WHERE id = $1::uuid', [id]).catch(() => {})
    }
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = ANY($1::text[])', [[SHEET, XB_SHEET]]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [[SHEET, XB_SHEET]]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [[SHEET, XB_SHEET]]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [[SHEET, XB_SHEET]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[BASE, XB_BASE]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => {
    if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
      throw new Error('real-DB allowlist step is missing DATABASE_URL')
    }
    expect(true).toBe(true)
  })

  test('RW-1 (same-base): approved resultWriteback writes a same-txn action=update source=automation revision — actor=APPROVER, FULL merged snapshot (untouched field survives)', async () => {
    const svc = makeAutomationService()
    const templateId = await createPublishedTemplate()
    const RW = { statusField: 'approval_status', approverField: 'approved_by', completedAtField: 'approved_at' }
    const rule = await svc.createRule(SHEET, {
      name: 'R13C RW same-base',
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'start_approval',
      actionConfig: { templateId, formDataMapping: { summary: 'Record {{record.title}} needs approval' }, requester: { mode: 'trigger_actor' }, resultWriteback: RW },
      actions: [{ type: 'start_approval', config: { templateId, formDataMapping: { summary: 'Record {{record.title}} needs approval' }, requester: { mode: 'trigger_actor' }, resultWriteback: RW } }] as never,
      executionMode: 'workflow_job_v1',
      createdBy: REQUESTER,
    })
    ruleIds.push(rule.id)

    const beforeIso = await revisionCutoffAfter(SHEET, RECORD, 'create')

    const execRule = {
      id: rule.id,
      name: 'R13C RW same-base',
      sheetId: SHEET,
      trigger: { type: 'record.created', config: {} },
      actions: [{ type: 'start_approval', config: { templateId, formDataMapping: { summary: 'Record {{record.title}} needs approval' }, requester: { mode: 'trigger_actor' }, resultWriteback: RW } }],
      enabled: true,
      createdBy: REQUESTER,
      createdAt: new Date(TS).toISOString(),
      executionMode: 'workflow_job_v1',
    }
    const execution = await svc.executeRule(execRule as never, { sheetId: SHEET, recordId: RECORD, data: { title: 'R13C source' }, actorId: REQUESTER })
    executionIds.push(execution.id)
    const bridge = await q(`SELECT approval_instance_id FROM multitable_automation_approval_bridges WHERE execution_id = $1`, [execution.id])
    const approvalInstanceId = (bridge.rows[0] as { approval_instance_id: string }).approval_instance_id
    approvalIds.push(approvalInstanceId)

    const approvals = new ApprovalProductService()
    await approvals.dispatchAction(approvalInstanceId, { action: 'approve', comment: 'go' }, { userId: APPROVER, userName: APPROVER })
    await waitForExecutionStatus(svc, execution.id, 'success')

    const revs = await revisionsFor(SHEET, RECORD)
    expect(revs).toHaveLength(2) // seeded create + the writeback update
    const writebackRev = revs[1]!
    expect(writebackRev).toMatchObject({ action: 'update', source: 'automation', version: 2, actor_id: APPROVER })
    expect(new Set(writebackRev.changed_field_ids)).toEqual(new Set(['approval_status', 'approved_by', 'approved_at']))
    // Merge-trap golden: the pre-existing `title`/`notes` fields (never touched by the writeback patch)
    // MUST still be present in the snapshot — a naive `snapshot: patch` would drop them silently.
    expect(writebackRev.snapshot).toMatchObject({ title: 'R13C source', notes: 'untouched-note', approval_status: 'approved', approved_by: APPROVER })

    // PIT: before the writeback, still the pre-approval state (no writeback fields at all).
    const before = await reconstructRecordsAtT(q, SHEET, beforeIso, [RECORD])
    expect(before.get(RECORD)).toMatchObject({ exists: true, version: 1, data: { title: 'R13C source', notes: 'untouched-note' } })

    // PIT: after the writeback, reconstructRecordsAtT sees the NEW value — this is the actual fix; before
    // it, the approval outcome was invisible to PIT/revert/reset forever (the D-1c class of bug, A7).
    const afterIso = await revisionCutoffAfter(SHEET, RECORD, 'update')
    const after = await reconstructRecordsAtT(q, SHEET, afterIso, [RECORD])
    expect(after.get(RECORD)?.exists).toBe(true)
    expect(after.get(RECORD)?.data).toMatchObject({ approval_status: 'approved', approved_by: APPROVER })
  })

  test('RW-2 (cross-base): approved cross-base resultWriteback writes the same-txn revision on the TARGET sheet — actor=REQUESTER (trigger actor, Q1)', async () => {
    const svc = makeAutomationService()
    const templateId = await createPublishedTemplate()
    const RW = { statusField: 'xb_status', approverField: 'xb_by', completedAtField: 'xb_at', targetBaseId: XB_BASE, targetSheetId: XB_SHEET, targetRecordId: XB_RECORD }
    const rule = await svc.createRule(SHEET, {
      name: 'R13C RW cross-base',
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'start_approval',
      actionConfig: { templateId, formDataMapping: { summary: 'Record {{record.title}} needs approval' }, requester: { mode: 'trigger_actor' }, resultWriteback: RW },
      actions: [{ type: 'start_approval', config: { templateId, formDataMapping: { summary: 'Record {{record.title}} needs approval' }, requester: { mode: 'trigger_actor' }, resultWriteback: RW } }] as never,
      executionMode: 'workflow_job_v1',
      createdBy: REQUESTER,
    })
    ruleIds.push(rule.id)

    const execRule = {
      id: rule.id,
      name: 'R13C RW cross-base',
      sheetId: SHEET,
      trigger: { type: 'record.created', config: {} },
      actions: [{ type: 'start_approval', config: { templateId, formDataMapping: { summary: 'Record {{record.title}} needs approval' }, requester: { mode: 'trigger_actor' }, resultWriteback: RW } }],
      enabled: true,
      createdBy: REQUESTER,
      createdAt: new Date(TS).toISOString(),
      executionMode: 'workflow_job_v1',
    }
    // NOTE: RECORD2 is a DEDICATED source (RW-1 already writes back onto RECORD; reusing it here would
    // make the "source untouched" assertion below trivially pass for the wrong reason).
    const execution = await svc.executeRule(execRule as never, { sheetId: SHEET, recordId: RECORD2, data: { title: 'R13C source 2' }, actorId: REQUESTER })
    executionIds.push(execution.id)
    const bridge = await q(`SELECT approval_instance_id FROM multitable_automation_approval_bridges WHERE execution_id = $1`, [execution.id])
    const approvalInstanceId = (bridge.rows[0] as { approval_instance_id: string }).approval_instance_id
    approvalIds.push(approvalInstanceId)

    const approvals = new ApprovalProductService()
    await approvals.dispatchAction(approvalInstanceId, { action: 'approve', comment: 'go' }, { userId: APPROVER, userName: APPROVER })
    await waitForExecutionStatus(svc, execution.id, 'success')

    const revs = await revisionsFor(XB_SHEET, XB_RECORD)
    expect(revs).toHaveLength(2) // seeded create + the writeback update
    const writebackRev = revs[1]!
    // Q1: the effective actor on a CROSS-BASE backwrite is the TRIGGER actor (REQUESTER), NOT the
    // approval actor (APPROVER) — mirrors the executor's cross-base update actor semantics.
    expect(writebackRev).toMatchObject({ action: 'update', source: 'automation', version: 2, actor_id: REQUESTER })
    expect(writebackRev.snapshot).toMatchObject({ xb_notes: 'xb-untouched-note', xb_status: 'approved', xb_by: APPROVER })

    // Source record must remain untouched by the cross-base backwrite (anti-misroute).
    const sourceRevs = await revisionsFor(SHEET, RECORD2)
    expect(sourceRevs.filter((r) => r.action === 'update')).toHaveLength(0)
  })

  test('RW-3 (atomicity, mirrors D1-5b): revision-insert failure rolls back the resultWriteback UPDATE — target unchanged, no half-write', async () => {
    const svc = makeAutomationService()
    const templateId = await createPublishedTemplate()
    const RW = { statusField: 'approval_status', approverField: 'approved_by', completedAtField: 'approved_at' }
    const rule = await svc.createRule(SHEET, {
      name: 'R13C RW atomicity',
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'start_approval',
      actionConfig: { templateId, formDataMapping: { summary: 'Record {{record.title}} needs approval' }, requester: { mode: 'trigger_actor' }, resultWriteback: RW },
      actions: [{ type: 'start_approval', config: { templateId, formDataMapping: { summary: 'Record {{record.title}} needs approval' }, requester: { mode: 'trigger_actor' }, resultWriteback: RW } }] as never,
      executionMode: 'workflow_job_v1',
      createdBy: REQUESTER,
    })
    ruleIds.push(rule.id)

    const execRule = {
      id: rule.id,
      name: 'R13C RW atomicity',
      sheetId: SHEET,
      trigger: { type: 'record.created', config: {} },
      actions: [{ type: 'start_approval', config: { templateId, formDataMapping: { summary: 'Record {{record.title}} needs approval' }, requester: { mode: 'trigger_actor' }, resultWriteback: RW } }],
      enabled: true,
      createdBy: REQUESTER,
      createdAt: new Date(TS).toISOString(),
      executionMode: 'workflow_job_v1',
    }
    const execution = await svc.executeRule(execRule as never, { sheetId: SHEET, recordId: FAIL_RECORD, data: { title: 'R13C atomicity source' }, actorId: REQUESTER })
    executionIds.push(execution.id)
    const bridge = await q(`SELECT approval_instance_id FROM multitable_automation_approval_bridges WHERE execution_id = $1`, [execution.id])
    const approvalInstanceId = (bridge.rows[0] as { approval_instance_id: string }).approval_instance_id
    approvalIds.push(approvalInstanceId)

    const approvals = new ApprovalProductService()
    await approvals.dispatchAction(approvalInstanceId, { action: 'approve', comment: 'go' }, { userId: APPROVER, userName: APPROVER })
    // `tryWriteApprovalResultBack`'s try/catch treats ANY backwrite failure as best-effort-skipped (logs
    // a warning, sets `backwriteSkipped` on the step output) — it does NOT fail the outer execution, so
    // this settles to a terminal status (typically 'success', no tail actions configured) regardless of
    // the injected failure. The correctness bar here is the DB state (rolled back), not the exec status.
    await vi.waitFor(async () => {
      const ex = await svc.logs.getById(execution.id)
      expect(ex?.status, JSON.stringify(ex)).not.toBe('running')
    }, { timeout: 5000, interval: 50 })

    const row = await q('SELECT version, data FROM meta_records WHERE id = $1 AND sheet_id = $2', [FAIL_RECORD, SHEET])
    expect(row.rows[0]).toMatchObject({ version: 1, data: { title: 'R13C atomicity source', notes: 'untouched-note' } })

    const updateRevs = await q(
      `SELECT COUNT(*)::int AS n FROM meta_record_revisions WHERE sheet_id = $1 AND record_id = $2 AND action = 'update'`,
      [SHEET, FAIL_RECORD],
    )
    expect(Number((updateRevs.rows[0] as { n: number }).n)).toBe(0)
  })
})
