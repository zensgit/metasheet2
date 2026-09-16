/**
 * SHEET LIVENESS on the approval-BRIDGE continuation (#5800).
 *
 * `approval.approved` drives three automation lanes. #5801 closed the two template-keyed ones inside
 * their rule loaders; the third — `resumeApprovalBridgeContinuation`, driven by
 * `multitable_automation_approval_bridges` — never goes through those loaders. Its record read keys
 * `meta_records` on `sheet_id` without joining `meta_sheets`, and a soft delete does not cascade into
 * records, so an approval completing after its sheet was soft-deleted WROTE the result back onto that
 * sheet and ran the rule's remaining actions.
 *
 * What is pinned here:
 *   1. deleted sheet (approved)      → no writeback, no tail, no record read; the run is recorded
 *                                      `failed` with the coded reason, tail steps `skipped`; the bridge
 *                                      ends terminal `resumed` on BOTH the lease and the legacy path;
 *                                      one values-free WARN names the bridge id + reason.
 *   2. deleted sheet (non-approved,  → no writeback either: the check sits BEFORE the outcome branch.
 *      onNonApproved opt-in)
 *   3. bridge.sheetId null           → the rule's sheet is the one checked (same fallback as the read).
 *   4. live sheet                    → unchanged: record read, writeback, tail, bridge `resumed`.
 *   5. absent sheet                  → same as the other lanes (`=== 'deleted'`): the run proceeds.
 *   6. lookup THROWS                 → FAIL-OPEN, like the template-keyed lanes: the run proceeds, the
 *                                      keep is a WARN with the error CLASS only.
 *
 * Zero-DB: the bridge table is an in-memory fake that mirrors the claim / fence-CAS SQL semantics, the
 * write tail is a spy, liveness is answered by a fake queryFn. No supertest / app-mode (CI #4154).
 */
import { EventBus } from '../../src/integration/events/event-bus'
import { Logger } from '../../src/core/logger'
import {
  AutomationService,
  BRIDGE_SHEET_DELETED_MESSAGE,
  toExecutorRule,
} from '../../src/multitable/automation-service'
import { computeActionFingerprint } from '../../src/multitable/automation-suspension-service'
import { SHEET_DELETED_CODE } from '../../src/multitable/sheet-liveness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const LIVENESS_ONE_SQL = /SELECT\s+deleted_at\s+FROM\s+meta_sheets\s+WHERE\s+id\s*=\s*\$1/i
const RECORD_READ_SQL = /SELECT\s+data\s+FROM\s+meta_records\s+WHERE\s+id\s*=\s*\$1\s+AND\s+sheet_id\s*=\s*\$2/i

type SheetState = 'live' | 'deleted' | 'absent' | 'throws'
type BridgeState = 'pending' | 'in_progress' | 'resumed'

const LEASE_ENV = { AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true' } as NodeJS.ProcessEnv
const LEGACY_ENV = {} as NodeJS.ProcessEnv

function ruleFor(sheetId: string, writeback: Record<string, unknown> = { statusField: 'fld_status' }) {
  return {
    id: 'atr_bridge',
    sheet_id: sheetId,
    name: 'Bridge rule',
    trigger_type: 'record.updated',
    trigger_config: {},
    action_type: 'start_approval',
    action_config: {},
    enabled: true,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    created_by: 'u_creator',
    conditions: null,
    actions: [
      {
        type: 'start_approval',
        config: { templateId: 'tpl_1', formDataMapping: { summary: 'x' }, resultWriteback: writeback },
      },
      { type: 'send_notification', config: { userIds: ['u_creator'], message: 'done' } },
      { type: 'update_record', config: { fields: { fld_note: 'n' } } },
    ],
    execution_mode: null,
  }
}

function completion(toStatus: 'approved' | 'rejected' = 'approved') {
  return {
    version: 1,
    source: 'approval-product',
    eventType: toStatus === 'approved' ? 'approval.approved' : 'approval.rejected',
    eventId: 'evt_bridge_1',
    occurredAt: '2026-09-02T00:00:00.000Z',
    approval: {
      instanceId: 'ai_bridge_1',
      requestNo: 'REQ-1',
      templateId: 'tpl_1',
      publishedDefinitionId: 'pd_1',
    },
    transition: { toStatus },
    actor: { id: 'u_approver' },
    requester: { id: 'u_creator' },
  } as never
}

interface Harness {
  service: AutomationService
  /** Every observable effect, in order: liveness lookups, record reads, writes, tail runs. */
  order: string[]
  livenessSheetIds: string[]
  recordReadSheetIds: unknown[]
  bridge: { status: BridgeState; fence: string }
  writes: ReturnType<typeof vi.fn>
  tail: ReturnType<typeof vi.fn>
  persisted: ReturnType<typeof vi.fn>
  onSettled: ReturnType<typeof vi.fn>
  onSkipped: ReturnType<typeof vi.fn>
}

function makeHarness(opts: {
  sheet: SheetState
  bridgeSheetId?: string | null
  ruleSheetId?: string
  writeback?: Record<string, unknown>
}): Harness {
  const ruleSheetId = opts.ruleSheetId ?? 'sheet_a'
  const bridgeSheetId = opts.bridgeSheetId === undefined ? ruleSheetId : opts.bridgeSheetId
  const order: string[] = []
  const livenessSheetIds: string[] = []
  const recordReadSheetIds: unknown[] = []

  const queryFn = vi.fn(async (sqlText: string, params: unknown[]) => {
    if (LIVENESS_ONE_SQL.test(sqlText)) {
      livenessSheetIds.push(String(params?.[0] ?? ''))
      order.push('liveness')
      // The error text carries connection details on purpose: nothing may echo it into a log.
      if (opts.sheet === 'throws') throw new Error('connection terminated: host=db.internal user=svc')
      if (opts.sheet === 'absent') return { rows: [], rowCount: 0 }
      return {
        rows: [{ deleted_at: opts.sheet === 'deleted' ? new Date('2026-09-01T12:00:00Z') : null }],
        rowCount: 1,
      }
    }
    if (RECORD_READ_SQL.test(sqlText)) {
      recordReadSheetIds.push(params?.[1])
      order.push('record-read')
      // Soft delete does not cascade: the record is still there, which is exactly the bug.
      return { rows: [{ data: { fld_title: 't' } }], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  })

  const service = new AutomationService(new EventBus(), {} as never, queryFn as never)
  const internals = service as never as Record<string, unknown>

  const rule = ruleFor(ruleSheetId, opts.writeback)
  const bridgeRow = {
    id: 'aab_bridge_1',
    executionId: 'exec_bridge_1',
    rootExecutionId: 'exec_bridge_1',
    ledgerKind: 'execution',
    ruleId: rule.id,
    sheetId: bridgeSheetId,
    recordId: 'rec_1',
    stepIndex: 0,
    approvalInstanceId: 'ai_bridge_1',
    approvalRequestNo: 'REQ-1',
    approvalTemplateId: 'tpl_1',
    approvalPublishedDefinitionId: 'pd_1',
    idempotencyKey: 'start_approval:exec_bridge_1:0:tpl_1',
    status: 'pending',
    outcome: null,
    fence: '0',
    actionFingerprint: computeActionFingerprint(toExecutorRule(rule as never).actions),
    triggerEvent: { actorId: 'u_creator', recordId: 'rec_1' },
  }

  // In-memory bridge table mirroring the SQL: legacy claim flips pending→resumed (terminal-early); the
  // lease claim flips pending→in_progress with fence+1; markBridgeResumed is a fence-CAS on in_progress.
  const bridge = { status: 'pending' as BridgeState, fence: '0' }
  internals.approvalBridgeService = {
    claimCompletion: vi.fn(async (_event: unknown, env: NodeJS.ProcessEnv) => {
      if (bridge.status !== 'pending') return { kind: 'none' }
      if (env.AUTOMATION_DURABLE_DELIVERY_ENABLED !== 'true') {
        bridge.status = 'resumed'
        return { kind: 'claimed', row: { ...bridgeRow, status: 'resumed' } }
      }
      bridge.status = 'in_progress'
      bridge.fence = String(Number(bridge.fence) + 1)
      return { kind: 'claimed', row: { ...bridgeRow, status: 'in_progress', fence: bridge.fence } }
    }),
    markBridgeResumed: vi.fn(async (id: string, fence: string) => {
      if (id !== bridgeRow.id || fence !== bridge.fence || bridge.status !== 'in_progress') return false
      bridge.status = 'resumed'
      return true
    }),
  }

  const persisted = vi.fn(async (execution: unknown) => {
    order.push(`persist:${(execution as { status: string }).status}`)
  })
  internals.logService = {
    getById: vi.fn(async () => ({
      id: 'exec_bridge_1',
      ruleId: rule.id,
      triggeredBy: 'event',
      triggeredAt: '2026-09-01T00:00:00.000Z',
      status: 'running',
      steps: [],
    })),
    updateRecordedExecution: persisted,
    record: vi.fn(async () => {}),
  }
  const onSettled = vi.fn(async () => {})
  const onSkipped = vi.fn(async () => {})
  internals.jobService = {
    lifecycleFor: vi.fn(() => ({ onStart: vi.fn(async () => {}), onSettled, onSkipped })),
  }

  vi.spyOn(service, 'getRule').mockResolvedValue(rule as never)
  // The field-shape check reads the sheet's field catalogue; not what this suite is about.
  vi.spyOn(internals as never as { assertResultWritebackFields: () => Promise<void> }, 'assertResultWritebackFields')
    .mockResolvedValue(undefined)
  // THE WRITE: the shared tail that UPDATEs meta_records. Asserted on directly, not inferred.
  const writes = vi.fn(async (sheetId: string) => {
    order.push(`write:${sheetId}`)
    return true
  })
  vi.spyOn(internals as never as { applyResultWritebackPatch: typeof writes }, 'applyResultWritebackPatch')
    .mockImplementation(writes as never)
  // THE TAIL: the rule's remaining actions.
  const executor = internals.executor as { continueExecution: (...args: unknown[]) => Promise<unknown> }
  const tail = vi.fn(async (execution: { status: string }) => {
    order.push('tail')
    return { ...execution, status: 'success' }
  })
  vi.spyOn(executor, 'continueExecution').mockImplementation(tail as never)

  return { service, order, livenessSheetIds, recordReadSheetIds, bridge, writes, tail, persisted, onSettled, onSkipped }
}

describe('approval bridge continuation — sheet liveness (soft delete, #5800)', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {}) as ReturnType<typeof vi.spyOn>
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {})
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    vi.spyOn(Logger.prototype, 'info').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const reasonWarns = (reason: string) =>
    warn.mock.calls.filter((call) => (call[1] as { reason?: string } | undefined)?.reason === reason)

  function expectRecordedAsSheetDeleted(h: Harness) {
    expect(h.persisted, 'the refusal must be RECORDED on the execution, not just skipped').toHaveBeenCalledTimes(1)
    const execution = h.persisted.mock.calls[0][0] as {
      status: string
      error?: string
      steps: Array<{ actionType: string; status: string; error?: string; output?: Record<string, unknown> }>
    }
    expect(execution.status).toBe('failed')
    expect(execution.error).toBe(BRIDGE_SHEET_DELETED_MESSAGE)
    expect(execution.error?.startsWith(SHEET_DELETED_CODE)).toBe(true)
    expect(execution.steps.map((s) => [s.actionType, s.status])).toEqual([
      ['start_approval', 'failed'],
      ['send_notification', 'skipped'],
      ['update_record', 'skipped'],
    ])
    // The approval identity rides along so the run history says WHICH outcome was not written back.
    expect(execution.steps[0].output).toMatchObject({ approvalInstanceId: 'ai_bridge_1', eventId: 'evt_bridge_1' })
    expect(h.onSettled).toHaveBeenCalledTimes(1)
    expect(h.onSkipped).toHaveBeenCalledTimes(2)
  }

  it('lease path: a SOFT-DELETED sheet gets no writeback and no tail; the run is recorded failed and the bridge goes terminal', async () => {
    const h = makeHarness({ sheet: 'deleted' })

    await h.service.handleApprovalCompletionEvent(completion(), LEASE_ENV)

    expect(h.writes, 'nothing may be written onto a soft-deleted sheet').not.toHaveBeenCalled()
    expect(h.tail, "the rule's remaining actions must not run").not.toHaveBeenCalled()
    expect(h.order, 'the check precedes every read of and write to the sheet').toEqual(['liveness', 'persist:failed'])
    expectRecordedAsSheetDeleted(h)
    expect(h.bridge.status, 'terminal in place — never "neither run nor recorded"').toBe('resumed')

    const [message, meta] = reasonWarns('sheet_deleted')[0] ?? []
    expect(reasonWarns('sheet_deleted'), 'one WARN per refused bridge').toHaveLength(1)
    expect(String(message)).toContain('aab_bridge_1')
    expect(meta).toEqual({
      bridgeId: 'aab_bridge_1',
      ruleId: 'atr_bridge',
      executionId: 'exec_bridge_1',
      sheetId: 'sheet_a',
      reason: 'sheet_deleted',
    })
  })

  it('legacy path (durable delivery OFF): same refusal, same record; the bridge is already terminal', async () => {
    const h = makeHarness({ sheet: 'deleted' })

    await expect(
      h.service.handleApprovalCompletionEvent(completion(), LEGACY_ENV),
      'a throw here would strand the run under an already-consumed bridge',
    ).resolves.toBeUndefined()

    expect(h.writes).not.toHaveBeenCalled()
    expect(h.tail).not.toHaveBeenCalled()
    expectRecordedAsSheetDeleted(h)
    expect(h.bridge.status).toBe('resumed')
  })

  it('a NON-approved outcome with the onNonApproved opt-in writes nothing either — the check precedes the outcome branch', async () => {
    const h = makeHarness({ sheet: 'deleted', writeback: { statusField: 'fld_status', onNonApproved: true } })

    await h.service.handleApprovalCompletionEvent(completion('rejected'), LEASE_ENV)

    expect(h.writes, 'the non-approved branch writes too; a deleted sheet must stop it').not.toHaveBeenCalled()
    expect(h.tail).not.toHaveBeenCalled()
    expect(h.bridge.status).toBe('resumed')
    const execution = h.persisted.mock.calls[0]?.[0] as { status: string; error?: string }
    expect(execution).toMatchObject({ status: 'failed', error: BRIDGE_SHEET_DELETED_MESSAGE })
    expect(reasonWarns('sheet_deleted')).toHaveLength(1)
  })

  it('control: the SAME non-approved opt-in DOES write on a live sheet (so the case above is not vacuous)', async () => {
    const h = makeHarness({ sheet: 'live', writeback: { statusField: 'fld_status', onNonApproved: true } })

    await h.service.handleApprovalCompletionEvent(completion('rejected'), LEASE_ENV)

    expect(h.writes).toHaveBeenCalledTimes(1)
    expect(h.tail).not.toHaveBeenCalled()
    expect(h.bridge.status).toBe('resumed')
  })

  it('bridge.sheetId null: the RULE sheet is checked — the same fallback the record read uses', async () => {
    const h = makeHarness({ sheet: 'deleted', bridgeSheetId: null, ruleSheetId: 'sheet_rule' })

    await h.service.handleApprovalCompletionEvent(completion(), LEASE_ENV)

    expect(h.livenessSheetIds).toEqual(['sheet_rule'])
    expect(h.tail).not.toHaveBeenCalled()
    expect(h.bridge.status).toBe('resumed')
  })

  it('LIVE sheet: behaviour unchanged — record read, writeback, tail, bridge resumed; the check reads the SAME sheet as the record read', async () => {
    const h = makeHarness({ sheet: 'live' })

    await h.service.handleApprovalCompletionEvent(completion(), LEASE_ENV)

    expect(h.order).toEqual(['liveness', 'record-read', 'write:sheet_a', 'tail', 'persist:success'])
    expect(h.livenessSheetIds).toEqual(['sheet_a'])
    expect(h.recordReadSheetIds, 'the sheet that was checked is the sheet that is read').toEqual(h.livenessSheetIds)
    expect(h.writes).toHaveBeenCalledTimes(1)
    expect(h.tail).toHaveBeenCalledTimes(1)
    expect(h.bridge.status).toBe('resumed')
    expect(warn, 'a live sheet logs nothing').not.toHaveBeenCalled()
  })

  it('LIVE sheet on the legacy path: unchanged too', async () => {
    const h = makeHarness({ sheet: 'live' })

    await h.service.handleApprovalCompletionEvent(completion(), LEGACY_ENV)

    expect(h.writes).toHaveBeenCalledTimes(1)
    expect(h.tail).toHaveBeenCalledTimes(1)
    expect(h.bridge.status).toBe('resumed')
  })

  it("ABSENT sheet: same as the other lanes (`=== 'deleted'`) — the run proceeds", async () => {
    const h = makeHarness({ sheet: 'absent' })

    await h.service.handleApprovalCompletionEvent(completion(), LEASE_ENV)

    expect(h.order).toEqual(['liveness', 'record-read', 'write:sheet_a', 'tail', 'persist:success'])
    expect(reasonWarns('sheet_deleted')).toEqual([])
    expect(h.bridge.status).toBe('resumed')
  })

  it('lookup THROWS: FAIL-OPEN — the run proceeds and the keep is a values-free WARN naming the bridge', async () => {
    const h = makeHarness({ sheet: 'throws' })

    await expect(h.service.handleApprovalCompletionEvent(completion(), LEASE_ENV)).resolves.toBeUndefined()

    expect(h.order, 'a failed lookup is not proof of a delete').toEqual([
      'liveness', 'record-read', 'write:sheet_a', 'tail', 'persist:success',
    ])
    expect(h.bridge.status, 'the continuation completed normally, so the bridge is terminal').toBe('resumed')
    const failOpen = reasonWarns('liveness_lookup_failed')
    expect(failOpen, 'the fail-open keep must be observable').toHaveLength(1)
    const [message, meta] = failOpen[0]
    expect(String(message)).toContain('aab_bridge_1')
    expect(String(message)).toContain('failing OPEN')
    expect(meta).toEqual({
      bridgeId: 'aab_bridge_1',
      ruleId: 'atr_bridge',
      sheetId: 'sheet_a',
      reason: 'liveness_lookup_failed',
      errorClass: 'Error',
    })
    // VALUES-FREE: the error CLASS only, never the text (it carried connection details here).
    const serialized = JSON.stringify(warn.mock.calls)
    expect(serialized).not.toContain('db.internal')
    expect(serialized).not.toContain('connection terminated')
  })

  it('lookup THROWS on the legacy path: also fail-open (a throw there would strand the run under a consumed bridge)', async () => {
    const h = makeHarness({ sheet: 'throws' })

    await expect(h.service.handleApprovalCompletionEvent(completion(), LEGACY_ENV)).resolves.toBeUndefined()

    expect(h.writes).toHaveBeenCalledTimes(1)
    expect(h.tail).toHaveBeenCalledTimes(1)
    expect(reasonWarns('liveness_lookup_failed')).toHaveLength(1)
  })
})
