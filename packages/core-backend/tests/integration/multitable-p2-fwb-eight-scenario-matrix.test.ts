/**
 * 八场景全链验收矩阵 — P2 durable delivery × action idempotency × FWB (real DB, constructed crash/concurrency).
 *
 * The formal acceptance matrix the month plan gates FWB/attachment/flag enablement on. Each scenario is an
 * explicit end-to-end construction (not a unit re-assertion):
 *   S1 crash BEFORE source commit        → zero rows, zero deliveries ever.
 *   S2 crash AFTER commit, before tick   → rows durable; a restarted worker delivers.
 *   S3 crash AFTER claim, before resolve → lease expiry → reclaim redelivers (at-least-once), identity stable.
 *   S4 zombie + reclaimer double-send    → identical outbound idempotency seed across fences; zombie's
 *                                          terminal write = 0 rows (single persisted writer).
 *   S5 version mismatch (N-1 worker)     → unknown consumer_key stays pending + alerted, never terminated.
 *   S6 FWB net-once                      → a REAL approval instance's completion delivered TWICE (distinct
 *                                          eventIds) through the production trigger dispatch writes ONE record.
 *   S7 crash mid-FWB                     → a Postgres-level fault aborts the production executor's REAL write
 *                                          transaction → claim+record+revision+outbox vanish together; a clean
 *                                          redelivery re-applies.
 *   S8 full chain                        → committed durable outbox row → dispatch tick → the REAL consumer
 *                                          adapters (boot wiring) → approval-trigger fires the FWB rule → the
 *                                          production action writes the record + the chained
 *                                          multitable.record.created outbox row (depth = parent+1, `::fwb::`
 *                                          eventId) → a second tick dispatches the chained row to the
 *                                          record-trigger consumer.
 *
 * PRODUCTION-CHAIN SCOPE (2026-07-20 rewrite; supersedes the helper-seam version REJECTED in #4489 review):
 * S6-S8 run NO fake gates, NO scratch-table seam, NO direct helper calls. The fixture is the real thing end
 * to end — RBAC rows, a published ApprovalProductService template, an FWB rule saved through
 * `AutomationService.createRule` (real save validation incl. the Q6 confirmation hash), real approved
 * instances with real immutable form_snapshots — and execution runs `handleApprovalCompletionTrigger` →
 * `executeRule` → the executor's `write_approval_form_values` case with the production §11 Q6 gate set and
 * the production transaction seam. S7's only construction is the FAULT ITSELF: a run-scoped Postgres trigger
 * (scoped to S7's own chained eventId, per shared-DB failure-injection discipline) raises on the FWB
 * transaction's LAST statement (the chained outbox INSERT — after claim+record+revision), which is exactly
 * the "crash before COMMIT" a process kill would produce, without seam control anywhere in the chain.
 * Stacked on the FWB activation branch (#4491) — the production action, its save gates and its migration
 * come from there; `multitable-fwb-activation-realdb.test.ts` is the per-boundary spec, this matrix is the
 * composed-chain acceptance.
 *
 * Runs on the composed chain against a fresh fully-migrated DB. Every scenario's rows are run-scoped (own
 * ids; ticks never assert on drained foreign rows).
 */
import { randomUUID } from 'node:crypto'

import { afterAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { db as kyselyDb } from '../../src/db/db'
import { eventBus as integrationEventBus } from '../../src/integration/events/event-bus'
import { enqueueOutboxEvent, type TransactionalQueryable } from '../../src/multitable/automation-outbox-enqueue'
import { claimDueConsumers, completeConsumer } from '../../src/multitable/automation-durable-dispatcher'
import { ConsumerAdapterRegistry, runDispatchTick, type AdapterOutcome } from '../../src/multitable/automation-durable-dispatch-loop'
import { buildConsumerAdapterRegistry } from '../../src/multitable/automation-durable-activation'
import { buildDurableConsumerHandlers } from '../../src/multitable/automation-durable-consumer-handlers'
import { deriveOutboundIdempotencyKey } from '../../src/multitable/automation-action-idempotency'
import { deriveFwbConfirmationHash } from '../../src/multitable/approval-fwb-activation'
import { getApprovalRecordProjectionService } from '../../src/multitable/approval-record-projection-service'
import { WebhookService } from '../../src/multitable/webhook-service'
import { AutomationService } from '../../src/multitable/automation-service'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const db = () => poolManager.get()
const RUN = randomUUID()
const cleanupEvt: string[] = []

// ── S6-S8 production fixture identifiers (all run-scoped) ─────────────────────────────────────────
const TS = Date.now()
const BASE_ID = `base_esm_${TS}`
const SHEET_ID = `sheet_esm_${TS}`
const F_TITLE = `fld_esm_title_${TS}`
const F_AMOUNT = `fld_esm_amount_${TS}`
const CREATOR = `u_esm_creator_${TS}`
const REQUESTER = `u_esm_req_${TS}`
const APPROVER = `u_esm_appr_${TS}`
/** S7 fault-injection trigger/function name (identifier-safe run scope). */
const ABORT_FN = `esm_abort_${RUN.replace(/-/g, '')}`

const q = (sqlText: string, params?: unknown[]) => db().query(sqlText, params)
const queryFn = ((sqlText: string, params?: unknown[]) => db().query(sqlText, params)) as never
/** Wrap a checked-out client for the brand-typed enqueue (the REAL enforcement is the runtime xid probe). */
const txn = (client: { query(sql: string, params?: unknown[]): Promise<unknown> }): TransactionalQueryable =>
  ({ isTransaction: true, query: (sql, params) => client.query(sql, params) }) as TransactionalQueryable

let svc: AutomationService
let approvals: ApprovalProductService
let templateId = ''
let templateVersionId = ''
let ruleId = ''

const MAPPINGS = [
  { formFieldId: 'summary', targetFieldId: F_TITLE, targetType: 'text' as const },
]

function setFlags(fwb: boolean, durable: boolean) {
  if (fwb) process.env.APPROVAL_FWB_WRITEBACK_ENABLED = 'true'
  else delete process.env.APPROVAL_FWB_WRITEBACK_ENABLED
  if (durable) process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = 'true'
  else delete process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED
}

function track(e: string): string {
  cleanupEvt.push(e)
  return e
}

function approvalTemplateRequest() {
  return {
    key: `esm-${TS}`,
    name: 'Eight-Scenario Matrix Template',
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
  const dto = await approvals.createApproval({ templateId, formData }, { userId: REQUESTER, userName: REQUESTER })
  return (dto as { id: string }).id
}

async function approveInstance(instanceId: string): Promise<void> {
  await approvals.dispatchAction(instanceId, { action: 'approve', comment: 'ok' } as never, { userId: APPROVER, userName: APPROVER })
}

/** The producer-shaped completion event (same shape the durable adapter redelivers / the bus carried). */
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
    actor: null, // §2.2: system completion carries no human actor — the write identity is the rule creator
  } as never
}

async function sheetRecordCount(): Promise<number> {
  const r = await q('SELECT COUNT(*)::int AS c FROM meta_records WHERE sheet_id = $1', [SHEET_ID])
  return Number((r.rows[0] as { c: number }).c)
}

async function sheetRevisionCount(): Promise<number> {
  const r = await q('SELECT COUNT(*)::int AS c FROM meta_record_revisions WHERE sheet_id = $1 AND action = $2 AND source = $3', [SHEET_ID, 'create', 'automation'])
  return Number((r.rows[0] as { c: number }).c)
}

async function claimsFor(instanceId: string): Promise<number> {
  const r = await q('SELECT COUNT(*)::int AS c FROM meta_fwb_action_applied WHERE instance_id = $1 AND rule_id = $2', [instanceId, ruleId])
  return Number((r.rows[0] as { c: number }).c)
}

async function outboxCountLike(prefix: string): Promise<number> {
  const r = await q('SELECT COUNT(*)::int AS c FROM meta_automation_outbox WHERE event_id LIKE $1', [`${prefix}%`])
  return Number((r.rows[0] as { c: number }).c)
}

async function lastExecution(): Promise<{ status: string; steps: Array<Record<string, unknown>> } | null> {
  const r = await q('SELECT status, steps FROM multitable_automation_executions WHERE rule_id = $1 ORDER BY triggered_at DESC LIMIT 1', [ruleId])
  const row = r.rows[0] as { status?: string; steps?: unknown } | undefined
  if (!row) return null
  const steps = typeof row.steps === 'string' ? JSON.parse(row.steps) as Array<Record<string, unknown>> : (row.steps as Array<Record<string, unknown>> ?? [])
  return { status: String(row.status), steps }
}

async function waitForExecutionCount(expected: number, timeoutMs = 8000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const r = await q('SELECT COUNT(*)::int AS c FROM multitable_automation_executions WHERE rule_id = $1', [ruleId])
    const count = Number((r.rows[0] as { c: number }).c)
    if (count >= expected || Date.now() > deadline) return count
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function consumerStates(outboxId: string): Promise<Array<[string, string]>> {
  const r = await q('SELECT consumer_key, status FROM meta_automation_outbox_consumer WHERE outbox_id = $1 ORDER BY consumer_key', [outboxId])
  return (r.rows as Array<{ consumer_key: string; status: string }>).map((row) => [row.consumer_key, row.status])
}

/** 2026-07-20 acceptance-run adaptation: main's enqueue now MACHINE-ENFORCES a real transaction (the
 * pg_current_xact_id probe rejects pool/autocommit handles — owner-ratified hardening after this spec was
 * written on the rehearsal branch). Same behavior, same assertions — only the handle plumbing adapts. */
async function enqueueCommitted(input: Parameters<typeof enqueueOutboxEvent>[1]) {
  const c = await db().getInternalPool().connect()
  try {
    await c.query('BEGIN')
    const res = await enqueueOutboxEvent(txn(c), input)
    await c.query('COMMIT')
    return res
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}

describeIfDatabase('八场景全链验收矩阵 (P2 × ledger × FWB, real DB)', () => {
  test('setup', async () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })
  afterAll(async () => {
    setFlags(false, false)
    try { svc?.shutdown() } catch { /* noop */ }
    await q(`DROP TRIGGER IF EXISTS ${ABORT_FN} ON meta_automation_outbox`).catch(() => {})
    await q(`DROP FUNCTION IF EXISTS ${ABORT_FN}()`).catch(() => {})
    // every event id this run mints starts with evt_<RUN> — the LIKE also catches the chained ::fwb:: rows;
    // consumer rows cascade on the outbox FK.
    await q('DELETE FROM meta_automation_outbox WHERE event_id = ANY($1)', [cleanupEvt]).catch(() => {})
    await q('DELETE FROM meta_automation_outbox WHERE event_id LIKE $1', [`evt_${RUN}%`]).catch(() => {})
    if (ruleId) {
      await q('DELETE FROM meta_fwb_action_applied WHERE rule_id = $1', [ruleId]).catch(() => {})
      await q('DELETE FROM multitable_automation_executions WHERE rule_id = $1', [ruleId]).catch(() => {})
      await q('DELETE FROM automation_rules WHERE id = $1', [ruleId]).catch(() => {})
    }
    await q(
      `DELETE FROM operation_audit_logs
        WHERE action = 'automation.fwb_confirm'
          AND resource_type = 'automation_fwb_confirmation'
          AND resource_id = $1`,
      [SHEET_ID],
    ).catch(() => {})
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('S1 crash before source commit → zero rows, zero deliveries', async () => {
    const raw = db().getInternalPool()
    const c = await raw.connect()
    const evt = track(`evt_${RUN}_s1`)
    try {
      await c.query('BEGIN')
      await enqueueOutboxEvent(txn(c), { eventType: 'multitable.form.submitted', eventId: evt, payload: {} })
      await c.query('ROLLBACK')
    } finally {
      c.release()
    }
    const r = await db().query('SELECT count(*)::int AS c FROM meta_automation_outbox WHERE event_id=$1', [evt])
    expect(Number(r.rows[0].c)).toBe(0)
  })

  test('S2 crash after commit before tick → durable; restart tick delivers', async () => {
    const evt = track(`evt_${RUN}_s2`)
    // 2026-07-20 adaptation: 'multitable.comment.created' was REMOVED from manifest v1 (no producer exists —
    // owner-ratified); use the single-consumer routed family instead. Same scenario semantics.
    const res = await enqueueCommitted({ eventType: 'multitable.form.submitted', eventId: evt, payload: {} })
    const reg = new ConsumerAdapterRegistry()
    const seen: string[] = []
    reg.register({ key: 'automation-record-trigger', handle: async (e) => (e.eventId === evt ? (seen.push(e.eventId), { outcome: 'success' }) : { outcome: 'retryable_failure', reason: 'unknown' }) as AdapterOutcome })
    await runDispatchTick(db(), reg, { batchSize: 500 })
    expect(seen).toContain(evt)
    const st = await db().query('SELECT status FROM meta_automation_outbox_consumer WHERE outbox_id=$1', [res.outboxId])
    expect(st.rows[0].status).toBe('done')
  })

  test('S3+S4 crash after claim → reclaim redelivers; zombie seed identical, zombie terminal write = 0 rows', async () => {
    const evt = track(`evt_${RUN}_s34`)
    const res = await enqueueCommitted({ eventType: 'multitable.form.submitted', eventId: evt, payload: {} })
    const all = await claimDueConsumers(db(), { consumerKeys: ['automation-record-trigger'], batchSize: 500 })
    const z = all.find((c) => c.outboxId === res.outboxId)
    expect(z).toBeTruthy() // zombie claimed, then "crashes" (never resolves)
    await db().query(`UPDATE meta_automation_outbox_consumer SET lease_expires_at = now() - interval '1 min' WHERE outbox_id=$1`, [res.outboxId])
    const reg = new ConsumerAdapterRegistry()
    const seen: Array<{ id: string; fence: string }> = []
    reg.register({ key: 'automation-record-trigger', handle: async (e) => (e.eventId === evt ? (seen.push({ id: e.eventId, fence: e.fence }), { outcome: 'success' }) : { outcome: 'retryable_failure', reason: 'unknown' }) as AdapterOutcome })
    await runDispatchTick(db(), reg, { batchSize: 500 })
    const r = seen.find((x) => x.id === evt)
    expect(r).toBeTruthy() // at-least-once across the crash
    expect(deriveOutboundIdempotencyKey(evt, 'automation-record-trigger')).toBe(deriveOutboundIdempotencyKey(z!.eventId, z!.consumerKey)) // S4: same seed
    expect(Number(r!.fence)).toBeGreaterThan(Number(z!.fence))
    expect(await completeConsumer(db(), res.outboxId, 'automation-record-trigger', z!.fence)).toBe(false) // zombie: 0 rows
  })

  test('S5 version mismatch: unknown consumer_key stays pending + alerted, never terminated', async () => {
    const evt = track(`evt_${RUN}_s5`)
    const res = await enqueueCommitted({ eventType: 'approval.task_created', eventId: evt, payload: {} }) // routes to approval-task-trigger
    const reg = new ConsumerAdapterRegistry()
    reg.register({ key: `ck_${RUN}_other`, handle: async () => ({ outcome: 'success' }) }) // N-1 worker: doesn't know the key
    const alerted: string[] = []
    await runDispatchTick(db(), reg, { onUnknownConsumerKeys: (k) => alerted.push(...k), batchSize: 500 })
    expect(alerted).toContain('approval-task-trigger')
    const st = await db().query('SELECT status, attempts FROM meta_automation_outbox_consumer WHERE outbox_id=$1', [res.outboxId])
    expect(st.rows[0]).toMatchObject({ status: 'pending', attempts: 0 })
  })

  // ── S6-S8: the production FWB chain (real template + real rule + real instances; NO seams, NO fake gates) ──

  test('S6-S8 fixture: real RBAC + published template + FWB rule saved through the production save gates', async () => {
    setFlags(false, false)
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'ESM Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'ESM Sheet'])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_TITLE, SHEET_ID, 'Title', 'text', '{}', 1])
    await q('INSERT INTO meta_fields (id, sheet_id, name, type, property, "order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [F_AMOUNT, SHEET_ID, 'Amount', 'number', '{}', 2])
    await q(
      `INSERT INTO permissions (code, name, description)
       VALUES ('approvals:read', 'Approvals Read', 'ESM test'),
              ('approvals:write', 'Approvals Write', 'ESM test'),
              ('approvals:act', 'Approvals Act', 'ESM test')
       ON CONFLICT (code) DO NOTHING`,
    )
    for (const uid of [CREATOR, REQUESTER, APPROVER]) {
      await q(
        `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
         VALUES ($1, $2, $1, 'x', 'user', '[]'::jsonb, TRUE, $3)
         ON CONFLICT (id) DO UPDATE SET is_active = TRUE, is_admin = EXCLUDED.is_admin`,
        [uid, `${uid}@esm.test`, uid === CREATOR],
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

    const confirmationHash = deriveFwbConfirmationHash({
      templateId,
      sourceTemplateVersionId: templateVersionId,
      targetBaseId: BASE_ID,
      targetSheetId: SHEET_ID,
      mappings: MAPPINGS,
    })
    await q(
      `INSERT INTO operation_audit_logs
         (actor_id, actor_type, action, resource_type, resource_id, metadata, meta)
       VALUES ($1, 'user', 'automation.fwb_confirm', 'automation_fwb_confirmation', $2, $3::jsonb, $3::jsonb)`,
      [CREATOR, SHEET_ID, JSON.stringify({ confirmationHash })],
    )

    svc = new AutomationService(integrationEventBus, kyselyDb as never, queryFn)
    // REAL save gate: placement, D1 outcome lock, mapping validation, Q6 confirmation hash + creator
    // authority all run inside createRule (the per-boundary negatives live in the FWB activation spec).
    const rule = await svc.createRule(SHEET_ID, {
      name: 'esm fwb writeback',
      triggerType: 'approval.completed',
      triggerConfig: { templateId, outcomes: ['approved'] },
      actionType: 'write_approval_form_values',
      actionConfig: {
        mappings: MAPPINGS,
        sourceTemplateVersionId: templateVersionId,
        confirmationHash,
      },
      createdBy: CREATOR,
    } as never)
    ruleId = (rule as { id: string }).id
    expect(ruleId).toBeTruthy()
  })

  test('S6 FWB net-once through the production chain: completion delivered TWICE (distinct eventIds, same instance) → ONE record, one claim, alreadyApplied', async () => {
    const instanceA = await startInstance({ summary: 'S6 net-once', amount: 42 })
    await approveInstance(instanceA) // real approval; real immutable form_snapshot (lock D4)
    setFlags(true, true)
    try {
      const evtA = track(`evt_${RUN}_s6a`)
      await svc.handleApprovalCompletionTrigger(completionEvent(instanceA, evtA))
      await waitForExecutionCount(1)
      let exec = await lastExecution()
      expect(exec?.steps?.[0]?.status).toBe('success')
      expect(exec?.steps?.[0]?.alreadyApplied).not.toBe(true)
      expect(await sheetRecordCount()).toBe(1)
      expect(await claimsFor(instanceA)).toBe(1)
      const rec = await q('SELECT data FROM meta_records WHERE sheet_id = $1', [SHEET_ID])
      expect((rec.rows[0] as { data: Record<string, unknown> }).data).toMatchObject({ [F_TITLE]: 'S6 net-once' })
      expect((rec.rows[0] as { data: Record<string, unknown> }).data).not.toHaveProperty(F_AMOUNT)
      expect(await sheetRevisionCount()).toBe(1)
      expect(await outboxCountLike(`${evtA}::fwb::`)).toBe(1)

      // redelivery under a NEW eventId (the §2.3 case the event-level ledger cannot catch): the FWB
      // instance-scoped claim dedups — net-once, no new record/claim/outbox.
      const evtB = track(`evt_${RUN}_s6b`)
      await svc.handleApprovalCompletionTrigger(completionEvent(instanceA, evtB))
      await waitForExecutionCount(2)
      exec = await lastExecution()
      expect(exec?.steps?.[0]?.status).toBe('success')
      expect(exec?.steps?.[0]?.alreadyApplied).toBe(true)
      expect(await sheetRecordCount()).toBe(1) // net-once
      expect(await claimsFor(instanceA)).toBe(1)
      expect(await outboxCountLike(`${evtB}::fwb::`)).toBe(0)
    } finally {
      setFlags(false, false)
    }
  })

  test('S7 crash mid-FWB: a Postgres fault on the chained-outbox INSERT aborts the production write transaction → claim+record+revision+outbox vanish together; clean redelivery re-applies', async () => {
    const instanceB = await startInstance({ summary: 'S7 crash', amount: 7 })
    await approveInstance(instanceB)
    const evtCrash = track(`evt_${RUN}_s7a`)
    // Fault injection at the DATABASE, not a seam: the FWB transaction's statement order is claim → record →
    // revision → chained outbox INSERT (approval-fwb-write-action.ts), so raising on that LAST insert aborts
    // the transaction after every business row was written — the same state a process crash before COMMIT
    // leaves. Scoped to THIS scenario's chained eventId only (shared-DB failure-injection discipline).
    await q(`CREATE OR REPLACE FUNCTION ${ABORT_FN}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected mid-FWB crash (matrix S7)'; END $$`)
    await q(`CREATE TRIGGER ${ABORT_FN} BEFORE INSERT ON meta_automation_outbox FOR EACH ROW WHEN (NEW.event_id LIKE '${evtCrash}::fwb::%') EXECUTE FUNCTION ${ABORT_FN}()`)
    setFlags(true, true)
    try {
      await expect(svc.handleApprovalCompletionTrigger(completionEvent(instanceB, evtCrash)))
        .rejects.toThrow('approval_completed_trigger_retryable_failure')
      await waitForExecutionCount(3)
      let exec = await lastExecution()
      expect(exec?.steps?.[0]?.status).toBe('failed')
      expect(exec?.steps?.[0]?.error).toBe('fwb_execution_failed')
      expect(JSON.stringify(exec?.steps?.[0] ?? {})).not.toContain('injected mid-FWB crash')
      // all four gone together: no record, no revision, no claim, no outbox row
      expect(await sheetRecordCount()).toBe(1) // unchanged — only S6's record exists
      expect(await sheetRevisionCount()).toBe(1)
      expect(await claimsFor(instanceB)).toBe(0)
      expect(await outboxCountLike(`${evtCrash}::fwb::`)).toBe(0)

      // fault cleared → a clean redelivery re-applies (no stuck absorbing state)
      await q(`DROP TRIGGER IF EXISTS ${ABORT_FN} ON meta_automation_outbox`)
      const evtRetry = track(`evt_${RUN}_s7b`)
      await svc.handleApprovalCompletionTrigger(completionEvent(instanceB, evtRetry))
      await waitForExecutionCount(4)
      exec = await lastExecution()
      expect(exec?.steps?.[0]?.status).toBe('success')
      expect(exec?.steps?.[0]?.alreadyApplied).not.toBe(true)
      expect(await sheetRecordCount()).toBe(2)
      expect(await sheetRevisionCount()).toBe(2)
      expect(await claimsFor(instanceB)).toBe(1)
      expect(await outboxCountLike(`${evtRetry}::fwb::`)).toBe(1)
    } finally {
      setFlags(false, false)
      await q(`DROP TRIGGER IF EXISTS ${ABORT_FN} ON meta_automation_outbox`).catch(() => {})
      await q(`DROP FUNCTION IF EXISTS ${ABORT_FN}()`).catch(() => {})
    }
  })

  test('S8 full chain: committed outbox row → REAL consumer adapters → FWB rule fires → chained record.created row (depth parent+1, ::fwb:: id) → second tick dispatches it to the record-trigger consumer', async () => {
    const instanceC = await startInstance({ summary: 'S8 chain', amount: 9 })
    await approveInstance(instanceC)
    setFlags(true, true)
    try {
      // 1) the approval completion event enters the REAL durable outbox in a COMMITTED transaction —
      //    manifest v1 fans approval.approved out to approval-bridge/-trigger/-projection.
      const evtS8 = track(`evt_${RUN}_s8`)
      const parent = await enqueueCommitted({ eventType: 'approval.approved', eventId: evtS8, payload: completionEvent(instanceC, evtS8), automationDepth: 0 })

      // 2) the REAL consumer adapters, wired exactly as boot wires them (index.ts durable-delivery block):
      //    buildDurableConsumerHandlers over the live AutomationService + projection + webhook services,
      //    wrapped in the ratified outcome mapping by buildConsumerAdapterRegistry. No hand-rolled fakes.
      const handlers = buildDurableConsumerHandlers({
        automationService: svc,
        projectionService: getApprovalRecordProjectionService(),
        webhookService: new WebhookService(kyselyDb),
      })
      const fullRegistry = buildConsumerAdapterRegistry(handlers) // the boot-identical six-adapter worker
      // Tick 1 runs a worker scoped to the approval-completion keys (the dispatcher's own worker-key
      // contract — a worker claims only the keys it registers; SAME real adapter objects). This keeps the
      // chained row's consumers untouched between ticks so the "durable row first, dispatch second" order
      // is OBSERVABLE — a full worker would drain the chained row in a later slot of the same tick
      // (same machinery, but the intermediate durable state would be unprovable).
      const approvalWorker = new ConsumerAdapterRegistry()
      for (const key of ['approval-bridge', 'approval-trigger', 'approval-projection'] as const) {
        const adapter = fullRegistry.get(key)
        expect(adapter).toBeTruthy()
        approvalWorker.register(adapter!)
      }
      await runDispatchTick(db(), approvalWorker, { batchSize: 500 })

      // 3) tick 1 delivered the completion fan-out: all three REAL consumers resolved 'done', and the
      //    approval-trigger adapter drove handleApprovalCompletionTrigger → executeRule → the production
      //    write_approval_form_values action.
      expect(await consumerStates(parent.outboxId)).toEqual([
        ['approval-bridge', 'done'],
        ['approval-projection', 'done'],
        ['approval-trigger', 'done'],
      ])
      await waitForExecutionCount(5)
      const exec = await lastExecution()
      expect(exec?.steps?.[0]?.status).toBe('success')
      expect(await sheetRecordCount()).toBe(3)
      expect(await claimsFor(instanceC)).toBe(1)

      // 4) the CHAINED multitable.record.created outbox row: EXACTLY one, ::fwb:: eventId shape, and
      //    automation_depth exactly parent+1 (discrimination: a depth-copy or double-enqueue mutant fails here).
      const parentRow = await q('SELECT automation_depth FROM meta_automation_outbox WHERE id = $1', [parent.outboxId])
      const parentDepth = Number((parentRow.rows[0] as { automation_depth: number }).automation_depth)
      expect(parentDepth).toBe(0)
      const chained = await q('SELECT id, event_id, automation_depth, payload FROM meta_automation_outbox WHERE event_id LIKE $1', [`${evtS8}::fwb::%`])
      expect(chained.rows.length).toBe(1) // exactly one — the net-once claim gates the enqueue
      const chainedRow = chained.rows[0] as { id: string; event_id: string; automation_depth: number; payload: { recordId?: string; sheetId?: string } }
      expect(chainedRow.event_id).toMatch(new RegExp(`^${evtS8}::fwb::`))
      expect(Number(chainedRow.automation_depth)).toBe(parentDepth + 1)
      expect(chainedRow.payload.sheetId).toBe(SHEET_ID)
      const s8rec = await q('SELECT id FROM meta_records WHERE sheet_id = $1 AND data->>$2 = $3', [SHEET_ID, F_TITLE, 'S8 chain'])
      expect(chainedRow.payload.recordId).toBe((s8rec.rows[0] as { id: string }).id)

      // 5) between ticks the chained row sits DURABLE with its manifest fan-out pending — proof the record
      //    hop rides the outbox, not the legacy bus (REPLACE contract).
      expect(await consumerStates(chainedRow.id)).toEqual([
        ['automation-record-trigger', 'pending'],
        ['webhook-event-bridge', 'pending'],
      ])

      // 6) a SECOND tick with the FULL boot registry dispatches the chained row to the REAL record-trigger
      //    consumer (automationService.handleEvent) and the webhook bridge.
      await runDispatchTick(db(), fullRegistry, { batchSize: 500 })
      expect(await consumerStates(chainedRow.id)).toEqual([
        ['automation-record-trigger', 'done'],
        ['webhook-event-bridge', 'done'],
      ])
    } finally {
      setFlags(false, false)
    }
  })
})
