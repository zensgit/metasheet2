/**
 * P2 durable-delivery P1#2e — producer family 1 (approval completion + approval.task_created) REPLACE goldens
 * (real DB, through the REAL `ApprovalProductService` methods — createApproval / dispatchAction).
 *
 * Family 3's goldens covered the shared seam; family 2's the executor sites; THESE prove the approval SITE
 * wiring end-to-end over real Postgres, for BOTH event families in family 1:
 *
 *   F1-G1  flag ON + approve-to-terminal (dispatchAction approve on a single-node template) → ONE
 *          `approval.approved` outbox row fanned to EXACTLY [approval-bridge, approval-projection,
 *          approval-trigger] (sorted, all pending), committed WITH the terminal transition; the legacy
 *          `emitApprovalCompletionEvent` bus emit is SUPPRESSED (shared-bus spy sees nothing).
 *   F1-G2  flag ON + createApproval with a pending assignment → per-recipient `approval.task_created` outbox
 *          row to EXACTLY [approval-task-trigger], `event_id` BYTE-EQUAL to the legacy quad formula
 *          (`approval-task:instanceId:nodeKey:entryEpoch:assigneeUserId`); legacy emit SUPPRESSED (spy silent).
 *   F1-G3  flag ON + auto-approve-at-entry (requester-merge terminal at create) → ONE `approval.approved`
 *          outbox row (fanned to the 3 completion consumers) and ZERO `approval.task_created` rows; spy silent.
 *          NOTE (honest scope): in the current pure-cascade architecture the entry assignment is removed from
 *          the resolution BEFORE `insertAssignments`, so `createdTaskEvents` is EMPTY here (verified) — this
 *          golden proves the terminal fan-out + that no spurious task event is enqueued, but it does NOT
 *          exercise a row that is inserted THEN deactivated in-txn. That live-then-deactivated recheck parity
 *          is proven precisely by the shared-collector unit test (`approval-task-created-collector.test.ts`),
 *          which is also the load-bearing catch for the "skip is_active recheck" mutation.
 *   F1-G4  flag OFF → the legacy emits fire exactly as before (spy sees `approval.task_created` at create and
 *          `approval.approved` at approve) and ZERO outbox rows exist — the REPLACE guard's other leg.
 *   F1-G5  ATOMICITY: a Postgres-level failure injected into the completion outbox INSERT (a BEFORE-INSERT
 *          trigger scoped to this instance's approval event_id) aborts the whole transaction — the terminal
 *          transition AND the enqueue roll back together (instance stays pending, zero outbox rows). Mirrors
 *          multitable-4196-classa-claim-realdb.test.ts's injectTrigger.
 *
 * Rows are asserted by this run's own instance ids (`payload->'approval'->>'instanceId'`) — never drained — so
 * this suite cannot claim a sibling suite's rows on the shared CI DB. Two-point wired (vitest.config exclude +
 * plugin-tests.yml run-list).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { eventBus as integrationEventBus } from '../../src/integration/events/event-bus'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const DURABLE_FLAG = 'AUTOMATION_DURABLE_DELIVERY_ENABLED'

const TS = Date.now()
const BASE = `base_f1_${TS}`
const SHEET = `sheet_f1_${TS}`
const REQUESTER = `u_f1_req_${TS}`
const APPROVER = `u_f1_appr_${TS}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

let approvals: ApprovalProductService
let manualTemplateId = ''
let autoTemplateId = ''

/** Spy on the SHARED bus the approval emitters use (ApprovalCompletionEvent / ApprovalTaskCreatedEvent import
 * the module-singleton `eventBus`; ApprovalProductService injects no bus). This observes exactly what a real
 * post-commit subscriber would receive — so a SUPPRESSED (flag-ON) emit shows up as an empty spy. */
const spy: Array<{ type: string; payload: Record<string, unknown> }> = []
function resetSpy(): void { spy.length = 0 }

/** This run's outbox rows for an instance id — joined to their consumer fan-out, never drained. */
interface OutboxRow { id: string; event_type: string; event_id: string; payload: Record<string, unknown>; consumers: string[] }
const outboxRowsForInstance = async (instanceId: string): Promise<OutboxRow[]> =>
  (
    await q(
      `SELECT o.id, o.event_type, o.event_id, o.payload,
              ARRAY(SELECT c.consumer_key FROM meta_automation_outbox_consumer c
                     WHERE c.outbox_id = o.id ORDER BY c.consumer_key) AS consumers
         FROM meta_automation_outbox o
        WHERE o.payload->'approval'->>'instanceId' = $1
        ORDER BY o.event_type, o.created_at`,
      [instanceId],
    )
  ).rows as unknown as OutboxRow[]

const consumerStatuses = async (outboxId: string): Promise<string[]> =>
  ((await q('SELECT status FROM meta_automation_outbox_consumer WHERE outbox_id = $1 ORDER BY consumer_key', [outboxId])).rows as Array<{ status: string }>).map((r) => r.status)

const instanceStatus = async (id: string): Promise<string> =>
  ((await q('SELECT status FROM approval_instances WHERE id = $1', [id])).rows[0] as { status: string }).status

function manualTemplateRequest() {
  return {
    key: `f1-manual-${TS}`,
    name: 'F1 Manual Single Node',
    formSchema: { fields: [{ id: 'summary', type: 'text', label: 'Summary', required: true }] },
    approvalGraph: {
      nodes: [
        { key: 'start', type: 'start', name: 'Start', config: {} },
        { key: 'approval_1', type: 'approval', name: 'Only', config: { mode: 'any', assigneeSources: [{ kind: 'static_user', userIds: [APPROVER] }] } },
        { key: 'end', type: 'end', name: 'End', config: {} },
      ],
      edges: [
        { key: 'e-start-approval_1', source: 'start', target: 'approval_1' },
        { key: 'e-approval_1-end', source: 'approval_1', target: 'end' },
      ],
    },
  }
}

function autoTemplateRequest() {
  return {
    key: `f1-auto-${TS}`,
    name: 'F1 Auto Approve At Entry',
    formSchema: { fields: [{ id: 'summary', type: 'text', label: 'Summary', required: true }] },
    approvalGraph: {
      nodes: [
        { key: 'start', type: 'start', name: 'Start', config: {} },
        { key: 'approval_1', type: 'approval', name: 'Auto', config: { assigneeSources: [{ kind: 'requester' }], approvalMode: 'single', emptyAssigneePolicy: 'error' } },
        { key: 'end', type: 'end', name: 'End', config: {} },
      ],
      edges: [
        { key: 'e-start-approval_1', source: 'start', target: 'approval_1' },
        { key: 'e-approval_1-end', source: 'approval_1', target: 'end' },
      ],
    },
  }
}

const requesterActor = () => ({ userId: REQUESTER, userName: REQUESTER })
const approverActor = () => ({ userId: APPROVER, userName: APPROVER })

async function createManualInstance(): Promise<string> {
  const dto = await approvals.createApproval({ templateId: manualTemplateId, formData: { summary: 'f1' } }, requesterActor())
  return (dto as { id: string }).id
}

async function injectOutboxFailure(name: string, instanceId: string): Promise<void> {
  await q(`CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger AS $fn$
           BEGIN
             RAISE EXCEPTION 'F1 injected completion outbox failure' USING ERRCODE = 'P0001';
           END $fn$ LANGUAGE plpgsql`)
  await q(`CREATE TRIGGER ${name}_trg BEFORE INSERT ON meta_automation_outbox
           FOR EACH ROW WHEN (NEW.event_id LIKE 'approval:${instanceId}:%') EXECUTE FUNCTION ${name}()`)
}
async function dropOutboxFailure(name: string): Promise<void> {
  await q(`DROP TRIGGER IF EXISTS ${name}_trg ON meta_automation_outbox`).catch(() => {})
  await q(`DROP FUNCTION IF EXISTS ${name}()`).catch(() => {})
}

describeIfDatabase('P1#2e — producer family 1: approval completion + task_created REPLACE (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE, 'F1 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET, BASE, 'F1 Sheet'])
    await q(
      `INSERT INTO permissions (code, name, description)
       VALUES ('approvals:read','Approvals Read','F1'),('approvals:write','Approvals Write','F1'),('approvals:act','Approvals Act','F1')
       ON CONFLICT (code) DO NOTHING`,
    )
    for (const uid of [REQUESTER, APPROVER]) {
      await q(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
         VALUES ($1,$2,$1,'x','user','[]'::jsonb,TRUE,FALSE) ON CONFLICT (id) DO UPDATE SET is_active = TRUE`,
        [uid, `${uid}@f1.test`],
      )
    }
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,'approvals:write') ON CONFLICT DO NOTHING`, [REQUESTER])
    await q(`INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,'approvals:act') ON CONFLICT DO NOTHING`, [APPROVER])

    approvals = new ApprovalProductService()
    const manual = await approvals.createTemplate(manualTemplateRequest() as never)
    manualTemplateId = (manual as { id: string }).id
    await approvals.publishTemplate(manualTemplateId, { policy: { allowRevoke: true } } as never)
    const auto = await approvals.createTemplate(autoTemplateRequest() as never)
    autoTemplateId = (auto as { id: string }).id
    await approvals.publishTemplate(autoTemplateId, { policy: { allowRevoke: true, autoApproval: { mergeWithRequester: true } } } as never)

    for (const t of ['approval.approved', 'approval.rejected', 'approval.revoked', 'approval.cancelled', 'approval.task_created']) {
      integrationEventBus.subscribe(t, (payload) => { spy.push({ type: t, payload: payload as Record<string, unknown> }) })
    }
  })

  afterEach(() => {
    delete process.env[DURABLE_FLAG]
    resetSpy()
  })

  afterAll(async () => {
    for (const tid of [manualTemplateId, autoTemplateId]) {
      const instances = await q('SELECT id FROM approval_instances WHERE template_id = $1', [tid]).catch(() => ({ rows: [] as unknown[] }))
      for (const row of instances.rows as Array<{ id: string }>) {
        await q(`DELETE FROM meta_automation_outbox_consumer WHERE outbox_id IN (SELECT id FROM meta_automation_outbox WHERE payload->'approval'->>'instanceId' = $1)`, [row.id]).catch(() => {})
        await q(`DELETE FROM meta_automation_outbox WHERE payload->'approval'->>'instanceId' = $1`, [row.id]).catch(() => {})
        await q('DELETE FROM approval_assignments WHERE instance_id = $1', [row.id]).catch(() => {})
        await q('DELETE FROM approval_records WHERE instance_id = $1', [row.id]).catch(() => {})
        await q('DELETE FROM approval_instances WHERE id = $1', [row.id]).catch(() => {})
      }
      await q('DELETE FROM approval_templates WHERE id = $1', [tid]).catch(() => {})
    }
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE]).catch(() => {})
    await q('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[REQUESTER, APPROVER]]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[REQUESTER, APPROVER]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL is set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  // F1-G1 — approve to terminal ────────────────────────────────────────────────────────────────────────
  test('F1-G1 flag ON approve-to-terminal: one approval.approved outbox row fanned to 3; legacy emit SUPPRESSED', async () => {
    const id = await createManualInstance() // create runs flag-OFF: no outbox rows, spy sees the task event
    resetSpy()
    process.env[DURABLE_FLAG] = 'true'
    await approvals.dispatchAction(id, { action: 'approve', comment: 'ok' } as never, approverActor())

    expect(await instanceStatus(id)).toBe('approved')
    const rows = await outboxRowsForInstance(id)
    expect(rows).toHaveLength(1)
    expect(rows[0].event_type).toBe('approval.approved')
    expect(rows[0].consumers).toEqual(['approval-bridge', 'approval-projection', 'approval-trigger'])
    expect(await consumerStatuses(rows[0].id)).toEqual(['pending', 'pending', 'pending'])
    expect(rows[0].event_id).toBe(rows[0].payload.eventId)
    expect((rows[0].payload.transition as { toStatus: string }).toStatus).toBe('approved')
    // REPLACE leg: the durable enqueue is the ONLY path — the legacy post-commit completion emit stayed silent.
    expect(spy).toHaveLength(0)
  })

  // F1-G2 — task_created at create ─────────────────────────────────────────────────────────────────────
  test('F1-G2 flag ON create: per-recipient approval.task_created outbox row, eventId byte-equal to legacy quad', async () => {
    process.env[DURABLE_FLAG] = 'true'
    const id = await createManualInstance()

    expect(await instanceStatus(id)).toBe('pending')
    const rows = await outboxRowsForInstance(id)
    expect(rows).toHaveLength(1)
    expect(rows[0].event_type).toBe('approval.task_created')
    expect(rows[0].consumers).toEqual(['approval-task-trigger'])
    expect(await consumerStatuses(rows[0].id)).toEqual(['pending'])
    // Byte-equality to the legacy quad formula, reconstructed from the durable assignment row itself.
    const asg = (await q(
      `SELECT node_key, entry_epoch, assignee_id FROM approval_assignments WHERE instance_id = $1 AND assignment_type = 'user' AND is_active = TRUE`,
      [id],
    )).rows[0] as { node_key: string; entry_epoch: number | string | null; assignee_id: string }
    const expectedEventId = `approval-task:${id}:${asg.node_key}:${asg.entry_epoch === null ? 'null' : String(Number(asg.entry_epoch))}:${asg.assignee_id}`
    expect(rows[0].event_id).toBe(expectedEventId)
    expect(rows[0].payload.eventId).toBe(expectedEventId)
    expect(asg.assignee_id).toBe(APPROVER)
    // Legacy emit SUPPRESSED (flag ON) — the in-txn enqueue is the only delivery path.
    expect(spy).toHaveLength(0)
  })

  // F1-G3 — auto-approve-at-entry (same-txn terminal) ──────────────────────────────────────────────────
  test('F1-G3 flag ON auto-approve-at-entry: one approval.approved row, ZERO task_created rows; spy silent', async () => {
    process.env[DURABLE_FLAG] = 'true'
    const dto = await approvals.createApproval({ templateId: autoTemplateId, formData: { summary: 'auto' } }, requesterActor())
    const id = (dto as { id: string }).id

    expect(await instanceStatus(id)).toBe('approved')
    const rows = await outboxRowsForInstance(id)
    expect(rows).toHaveLength(1)
    expect(rows[0].event_type).toBe('approval.approved')
    expect(rows[0].consumers).toEqual(['approval-bridge', 'approval-projection', 'approval-trigger'])
    // No pending assignment survived the cascade → NO task_created row was enqueued (the recheck's intent).
    expect(rows.filter((r) => r.event_type === 'approval.task_created')).toHaveLength(0)
    expect(spy).toHaveLength(0)
  })

  // F1-G4 — flag OFF: legacy fires, zero outbox ────────────────────────────────────────────────────────
  test('F1-G4 flag OFF: legacy emits fire (task_created at create, approval.approved at approve); ZERO outbox rows', async () => {
    const id = await createManualInstance() // flag OFF
    expect(spy.filter((e) => e.type === 'approval.task_created')).toHaveLength(1)
    await approvals.dispatchAction(id, { action: 'approve', comment: 'ok' } as never, approverActor())
    expect(spy.filter((e) => e.type === 'approval.approved')).toHaveLength(1)
    expect(await outboxRowsForInstance(id)).toHaveLength(0)
  })

  // F1-G5 — atomicity: transition + enqueue roll back together ──────────────────────────────────────────
  test('F1-G5 atomicity: injected completion-outbox failure rolls back the transition AND the enqueue', async () => {
    const id = await createManualInstance() // flag OFF setup: pending, APPROVER assigned
    process.env[DURABLE_FLAG] = 'true'
    const trg = `f1g5_${TS}`
    await injectOutboxFailure(trg, id)
    try {
      await expect(
        approvals.dispatchAction(id, { action: 'approve', comment: 'ok' } as never, approverActor()),
      ).rejects.toThrow(/injected completion outbox failure/)
    } finally {
      await dropOutboxFailure(trg)
    }
    // The WHOLE transaction rolled back: the terminal transition did NOT persist and NO outbox row survives.
    expect(await instanceStatus(id)).toBe('pending')
    expect(await outboxRowsForInstance(id)).toHaveLength(0)
    // A clean retry (trigger gone) now commits both the transition and the enqueue atomically.
    await approvals.dispatchAction(id, { action: 'approve', comment: 'ok' } as never, approverActor())
    expect(await instanceStatus(id)).toBe('approved')
    const rows = await outboxRowsForInstance(id)
    expect(rows).toHaveLength(1)
    expect(rows[0].event_type).toBe('approval.approved')
  })
})
