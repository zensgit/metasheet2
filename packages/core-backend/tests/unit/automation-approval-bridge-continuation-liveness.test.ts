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
 *   1. deleted sheet (approved)      → no writeback, no tail, no record read; the ONLY statement sent is
 *                                      the liveness read; the run is recorded `failed` with the coded
 *                                      reason (outcome + what was withheld), tail steps `skipped`; the
 *                                      bridge ends terminal `resumed` on BOTH the lease and the legacy
 *                                      path; one values-free WARN names the bridge id, outcome + reason.
 *   2. deleted sheet (non-approved,  → no writeback either: the check sits BEFORE the outcome branch.
 *      onNonApproved opt-in)
 *   3. deleted sheet, CROSS-BASE     → the cross-base gate is never evaluated (no quota slot spent) and
 *      writeback                      the target base's record is never written; live controls prove
 *                                      the same config does reach the gate and the target.
 *   4. the refusal reason            → keeps the outcome; says "nothing was pending" when nothing was
 *                                      (rejected, no opt-in), so it is not read as a lost write.
 *   5. bridge.sheetId null           → the rule's sheet is the one checked (same fallback as the read).
 *   6. live sheet                    → unchanged: record read, writeback, tail, bridge `resumed`.
 *   7. absent sheet                  → same as the other lanes (`=== 'deleted'`): the run proceeds.
 *   8. lookup THROWS                 → FAIL-OPEN, like the template-keyed lanes: the run proceeds, the
 *                                      keep is a WARN with the error CLASS and driver code only.
 *
 * Zero-DB: the bridge table is an in-memory fake that mirrors the claim / fence-CAS SQL semantics, the
 * write tail is a spy, liveness is answered by a fake queryFn that RECORDS every statement it is sent.
 * No supertest / app-mode (CI #4154).
 */
import pg from 'pg'
import { EventBus } from '../../src/integration/events/event-bus'
import { Logger } from '../../src/core/logger'
import {
  AutomationService,
  BRIDGE_SHEET_DELETED_MESSAGE,
  approvalOutcomeLabel,
  bridgeSheetDeletedMessage,
  describeLookupError,
  toExecutorRule,
} from '../../src/multitable/automation-service'
import { redactString } from '../../src/multitable/automation-log-redact'
import { computeActionFingerprint } from '../../src/multitable/automation-suspension-service'
import { SHEET_DELETED_CODE, SheetNotLiveError } from '../../src/multitable/sheet-liveness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const LIVENESS_ONE_SQL = /SELECT\s+deleted_at\s+FROM\s+meta_sheets\s+WHERE\s+id\s*=\s*\$1/i
const RECORD_READ_SQL = /SELECT\s+data\s+FROM\s+meta_records\s+WHERE\s+id\s*=\s*\$1\s+AND\s+sheet_id\s*=\s*\$2/i
const WRITE_SQL = /^\s*(UPDATE|INSERT|DELETE)\b/i

type SheetState = 'live' | 'deleted' | 'absent' | 'throws'
type BridgeState = 'pending' | 'in_progress' | 'resumed'
type Outcome = 'approved' | 'rejected' | 'revoked' | 'cancelled'

const LEASE_ENV = { AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true' } as NodeJS.ProcessEnv
const LEGACY_ENV = {} as NodeJS.ProcessEnv

const SAME_BASE_WRITEBACK = { statusField: 'fld_status' }
const CROSS_BASE_WRITEBACK = {
  statusField: 'fld_status',
  targetBaseId: 'base_b',
  targetSheetId: 'sheet_b',
  targetRecordId: 'rec_b',
}

/** `writeback: null` omits `resultWriteback` from the start_approval config entirely. */
function ruleFor(sheetId: string, writeback: Record<string, unknown> | null = SAME_BASE_WRITEBACK) {
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
        config: {
          templateId: 'tpl_1',
          formDataMapping: { summary: 'x' },
          ...(writeback === null ? {} : { resultWriteback: writeback }),
        },
      },
      { type: 'send_notification', config: { userIds: ['u_creator'], message: 'done' } },
      { type: 'update_record', config: { fields: { fld_note: 'n' } } },
    ],
    execution_mode: null,
  }
}

function completion(toStatus: Outcome = 'approved') {
  return {
    version: 1,
    source: 'approval-product',
    eventType: `approval.${toStatus}`,
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

/** A REAL node-postgres server error (statement timeout), as the driver builds it. */
function pgStatementTimeout(): Error {
  const err = new pg.DatabaseError('canceling statement due to statement timeout: host=db.internal', 120, 'error')
  err.code = '57014'
  return err
}

interface Harness {
  service: AutomationService
  /** Every observable effect, in order: liveness lookups, record reads, raw writes, gate, writes, tail runs. */
  order: string[]
  /** EVERY statement sent through queryFn, classified — an unrecognised one is recorded, never swallowed. */
  sql: string[]
  livenessSheetIds: string[]
  recordReadSheetIds: unknown[]
  bridge: { status: BridgeState; fence: string }
  writes: ReturnType<typeof vi.fn>
  gate: ReturnType<typeof vi.fn>
  tail: ReturnType<typeof vi.fn>
  persisted: ReturnType<typeof vi.fn>
  onSettled: ReturnType<typeof vi.fn>
  onSkipped: ReturnType<typeof vi.fn>
}

function makeHarness(opts: {
  sheet: SheetState
  sheetError?: () => unknown
  bridgeSheetId?: string | null
  ruleSheetId?: string
  writeback?: Record<string, unknown> | null
}): Harness {
  const ruleSheetId = opts.ruleSheetId ?? 'sheet_a'
  const bridgeSheetId = opts.bridgeSheetId === undefined ? ruleSheetId : opts.bridgeSheetId
  const order: string[] = []
  const sql: string[] = []
  const livenessSheetIds: string[] = []
  const recordReadSheetIds: unknown[] = []

  const queryFn = vi.fn(async (sqlText: string, params: unknown[]) => {
    if (LIVENESS_ONE_SQL.test(sqlText)) {
      sql.push('liveness')
      livenessSheetIds.push(String(params?.[0] ?? ''))
      order.push('liveness')
      if (opts.sheet === 'throws') {
        // The error text carries connection details on purpose: nothing may echo it into a log.
        throw opts.sheetError ? opts.sheetError() : new Error('connection terminated: host=db.internal user=svc')
      }
      if (opts.sheet === 'absent') return { rows: [], rowCount: 0 }
      return {
        rows: [{ deleted_at: opts.sheet === 'deleted' ? new Date('2026-09-01T12:00:00Z') : null }],
        rowCount: 1,
      }
    }
    if (RECORD_READ_SQL.test(sqlText)) {
      sql.push('record-read')
      recordReadSheetIds.push(params?.[1])
      order.push('record-read')
      // Soft delete does not cascade: the record is still there, which is exactly the bug.
      return { rows: [{ data: { fld_title: 't' } }], rowCount: 1 }
    }
    // Anything else is RECORDED (never silently accepted) so a new statement — above all a raw write
    // slipped in before the check — shows up in the assertions below.
    const head = sqlText.trim().split(/\s+/).slice(0, 3).join(' ')
    sql.push(`other:${head}`)
    if (WRITE_SQL.test(sqlText)) order.push(`raw-write:${head}`)
    return { rows: [], rowCount: 0 }
  })

  const service = new AutomationService(new EventBus(), {} as never, queryFn as never)
  const internals = service as never as Record<string, unknown>

  const rule = ruleFor(ruleSheetId, opts.writeback === undefined ? SAME_BASE_WRITEBACK : opts.writeback)
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
  // THE WRITE: the shared tail that UPDATEs meta_records (same-base AND cross-base). Asserted on directly.
  const writes = vi.fn(async (sheetId: string) => {
    order.push(`write:${sheetId}`)
    return true
  })
  vi.spyOn(internals as never as { applyResultWritebackPatch: typeof writes }, 'applyResultWritebackPatch')
    .mockImplementation(writes as never)
  const executor = internals.executor as {
    continueExecution: (...args: unknown[]) => Promise<unknown>
    evaluateCrossBaseWriteGate: (...args: unknown[]) => Promise<unknown>
  }
  // THE CROSS-BASE GATE: an authorized evaluation CONSUMES a per-target-base quota slot.
  const gate = vi.fn(async () => {
    order.push('xb-gate')
    return { crossBase: true, ok: true }
  })
  vi.spyOn(executor, 'evaluateCrossBaseWriteGate').mockImplementation(gate as never)
  // THE TAIL: the rule's remaining actions.
  const tail = vi.fn(async (execution: { status: string }) => {
    order.push('tail')
    return { ...execution, status: 'success' }
  })
  vi.spyOn(executor, 'continueExecution').mockImplementation(tail as never)

  return {
    service, order, sql, livenessSheetIds, recordReadSheetIds, bridge, writes, gate, tail, persisted, onSettled, onSkipped,
  }
}

type PersistedExecution = {
  status: string
  error?: string
  steps: Array<{ actionType: string; status: string; error?: string; output?: Record<string, unknown> }>
}

const APPROVED_WITHHELD =
  `${BRIDGE_SHEET_DELETED_MESSAGE} (approval outcome: approved; declared result writeback not applied, remaining actions not run)`

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

  const persistedExecution = (h: Harness) => h.persisted.mock.calls[0]?.[0] as PersistedExecution

  /** Nothing but the liveness read reaches the database; no gate, no write, no tail. */
  function expectNothingTouched(h: Harness) {
    expect(h.sql, 'the ONLY statement a deleted-sheet refusal sends is the liveness read').toEqual(['liveness'])
    expect(h.writes, 'nothing may be written for a soft-deleted sheet').not.toHaveBeenCalled()
    expect(h.gate, 'the cross-base gate must not be evaluated (it would spend a quota slot)').not.toHaveBeenCalled()
    expect(h.tail, "the rule's remaining actions must not run").not.toHaveBeenCalled()
    expect(h.bridge.status, 'terminal in place — never "neither run nor recorded"').toBe('resumed')
  }

  function expectRecordedAsSheetDeleted(h: Harness, reason = APPROVED_WITHHELD, outcome: Outcome = 'approved') {
    expect(h.persisted, 'the refusal must be RECORDED on the execution, not just skipped').toHaveBeenCalledTimes(1)
    const execution = persistedExecution(h)
    expect(execution.status).toBe('failed')
    expect(execution.error).toBe(reason)
    expect(execution.error?.startsWith(`${SHEET_DELETED_CODE}:`)).toBe(true)
    expect(execution.steps.map((s) => [s.actionType, s.status])).toEqual([
      ['start_approval', 'failed'],
      ['send_notification', 'skipped'],
      ['update_record', 'skipped'],
    ])
    expect(execution.steps[0].error).toBe(reason)
    // The approval identity AND outcome ride along so the run history says WHICH outcome was withheld.
    expect(execution.steps[0].output).toMatchObject({ approvalInstanceId: 'ai_bridge_1', eventId: 'evt_bridge_1', outcome })
    expect(h.onSettled).toHaveBeenCalledTimes(1)
    expect(h.onSkipped).toHaveBeenCalledTimes(2)
  }

  it('lease path: a SOFT-DELETED sheet gets no writeback and no tail; the run is recorded failed and the bridge goes terminal', async () => {
    const h = makeHarness({ sheet: 'deleted' })

    await h.service.handleApprovalCompletionEvent(completion(), LEASE_ENV)

    expect(h.order, 'the check precedes every read of and write to the sheet').toEqual(['liveness', 'persist:failed'])
    expectNothingTouched(h)
    expectRecordedAsSheetDeleted(h)

    const [message, meta] = reasonWarns('sheet_deleted')[0] ?? []
    expect(reasonWarns('sheet_deleted'), 'one WARN per refused bridge').toHaveLength(1)
    expect(String(message)).toContain('aab_bridge_1')
    expect(meta).toEqual({
      bridgeId: 'aab_bridge_1',
      ruleId: 'atr_bridge',
      executionId: 'exec_bridge_1',
      sheetId: 'sheet_a',
      outcome: 'approved',
      reason: 'sheet_deleted',
    })
  })

  it('legacy path (durable delivery OFF): same refusal, same record; the bridge is already terminal', async () => {
    const h = makeHarness({ sheet: 'deleted' })

    await expect(
      h.service.handleApprovalCompletionEvent(completion(), LEGACY_ENV),
      'a throw here would strand the run under an already-consumed bridge',
    ).resolves.toBeUndefined()

    expectNothingTouched(h)
    expectRecordedAsSheetDeleted(h)
  })

  it('a NON-approved outcome with the onNonApproved opt-in writes nothing either — the check precedes the outcome branch', async () => {
    const h = makeHarness({ sheet: 'deleted', writeback: { statusField: 'fld_status', onNonApproved: true } })

    await h.service.handleApprovalCompletionEvent(completion('rejected'), LEASE_ENV)

    expectNothingTouched(h)
    // The tail never runs on a non-approved outcome, so the reason names only the withheld writeback.
    expectRecordedAsSheetDeleted(
      h,
      `${BRIDGE_SHEET_DELETED_MESSAGE} (approval outcome: rejected; declared result writeback not applied)`,
      'rejected',
    )
    expect(reasonWarns('sheet_deleted')).toHaveLength(1)
    expect(reasonWarns('sheet_deleted')[0][1]).toMatchObject({ outcome: 'rejected' })
  })

  it('control: the SAME non-approved opt-in DOES write on a live sheet (so the case above is not vacuous)', async () => {
    const h = makeHarness({ sheet: 'live', writeback: { statusField: 'fld_status', onNonApproved: true } })

    await h.service.handleApprovalCompletionEvent(completion('rejected'), LEASE_ENV)

    expect(h.writes).toHaveBeenCalledTimes(1)
    expect(h.tail).not.toHaveBeenCalled()
    expect(h.bridge.status).toBe('resumed')
  })

  describe('the refusal reason keeps the outcome and names only what was actually withheld', () => {
    it('rejected WITHOUT the opt-in: nothing was pending, and the reason says so (not a lost write)', async () => {
      const h = makeHarness({ sheet: 'deleted' })

      await h.service.handleApprovalCompletionEvent(completion('rejected'), LEASE_ENV)

      expectNothingTouched(h)
      expectRecordedAsSheetDeleted(
        h,
        `${BRIDGE_SHEET_DELETED_MESSAGE} (approval outcome: rejected; nothing was pending to write back or run)`,
        'rejected',
      )
    })

    it.each(['revoked', 'cancelled'] as const)('%s without the opt-in: same — the outcome is kept, nothing claimed lost', async (outcome) => {
      const h = makeHarness({ sheet: 'deleted' })

      await h.service.handleApprovalCompletionEvent(completion(outcome), LEGACY_ENV)

      expectNothingTouched(h)
      expectRecordedAsSheetDeleted(
        h,
        `${BRIDGE_SHEET_DELETED_MESSAGE} (approval outcome: ${outcome}; nothing was pending to write back or run)`,
        outcome,
      )
    })

    it('approved with NO resultWriteback declared: only the tail is named as withheld', async () => {
      const h = makeHarness({ sheet: 'deleted', writeback: null })

      await h.service.handleApprovalCompletionEvent(completion(), LEASE_ENV)

      expectNothingTouched(h)
      expectRecordedAsSheetDeleted(h, `${BRIDGE_SHEET_DELETED_MESSAGE} (approval outcome: approved; remaining actions not run)`)
    })

    it('control: the old outcome-only text is what a LIVE sheet still records for a rejected run', async () => {
      const h = makeHarness({ sheet: 'live' })

      await h.service.handleApprovalCompletionEvent(completion('rejected'), LEASE_ENV)

      expect(persistedExecution(h)).toMatchObject({ status: 'failed', error: 'Approval completed with rejected' })
      expect(h.writes).not.toHaveBeenCalled()
    })

    it('the outcome is a closed label (values-free), and every reason shape survives the persistence redactor verbatim', () => {
      expect(approvalOutcomeLabel('approved')).toBe('approved')
      expect(approvalOutcomeLabel('rejected; host=db.internal')).toBe('unknown')
      expect(approvalOutcomeLabel(undefined)).toBe('unknown')
      expect(bridgeSheetDeletedMessage('x<y>', { writeback: false, tail: false })).toBe(
        `${BRIDGE_SHEET_DELETED_MESSAGE} (approval outcome: unknown; nothing was pending to write back or run)`,
      )
      for (const writeback of [false, true]) {
        for (const tail of [false, true]) {
          const reason = bridgeSheetDeletedMessage('approved', { writeback, tail })
          expect(reason.startsWith(`${SHEET_DELETED_CODE}: `)).toBe(true)
          expect(redactString(reason), 'the stored error must keep its SHEET_DELETED prefix and text').toBe(reason)
        }
      }
    })
  })

  describe('cross-base resultWriteback (the write lands in ANOTHER base)', () => {
    it('deleted sheet, approved: the cross-base gate is never evaluated and the target record is never written', async () => {
      const h = makeHarness({ sheet: 'deleted', writeback: CROSS_BASE_WRITEBACK })

      await h.service.handleApprovalCompletionEvent(completion(), LEASE_ENV)

      expect(h.order).toEqual(['liveness', 'persist:failed'])
      expectNothingTouched(h)
      expectRecordedAsSheetDeleted(h)
    })

    it('deleted sheet, rejected + onNonApproved: same — no gate, no write', async () => {
      const h = makeHarness({ sheet: 'deleted', writeback: { ...CROSS_BASE_WRITEBACK, onNonApproved: true } })

      await h.service.handleApprovalCompletionEvent(completion('rejected'), LEGACY_ENV)

      expect(h.order).toEqual(['liveness', 'persist:failed'])
      expectNothingTouched(h)
      expectRecordedAsSheetDeleted(
        h,
        `${BRIDGE_SHEET_DELETED_MESSAGE} (approval outcome: rejected; declared result writeback not applied)`,
        'rejected',
      )
    })

    it('control: on a LIVE sheet the same approved config reaches the gate and writes the TARGET record', async () => {
      const h = makeHarness({ sheet: 'live', writeback: CROSS_BASE_WRITEBACK })

      await h.service.handleApprovalCompletionEvent(completion(), LEASE_ENV)

      expect(h.order).toEqual(['liveness', 'record-read', 'xb-gate', 'write:sheet_b', 'tail', 'persist:success'])
      expect(h.gate).toHaveBeenCalledTimes(1)
      expect(h.gate.mock.calls[0].slice(1)).toEqual(['u_creator', 'sheet_a', 'sheet_b', 'base_b'])
      expect(h.writes.mock.calls[0].slice(0, 2)).toEqual(['sheet_b', 'rec_b'])
    })

    it('control: on a LIVE sheet the same rejected + onNonApproved config reaches the gate and writes the target', async () => {
      const h = makeHarness({ sheet: 'live', writeback: { ...CROSS_BASE_WRITEBACK, onNonApproved: true } })

      await h.service.handleApprovalCompletionEvent(completion('rejected'), LEGACY_ENV)

      expect(h.order).toEqual(['liveness', 'xb-gate', 'write:sheet_b', 'persist:failed'])
      expect(h.writes.mock.calls[0].slice(0, 2)).toEqual(['sheet_b', 'rec_b'])
    })
  })

  it('bridge.sheetId null: the RULE sheet is checked — the same fallback the record read uses', async () => {
    const h = makeHarness({ sheet: 'deleted', bridgeSheetId: null, ruleSheetId: 'sheet_rule' })

    await h.service.handleApprovalCompletionEvent(completion(), LEASE_ENV)

    expect(h.livenessSheetIds).toEqual(['sheet_rule'])
    expect(h.sql).toEqual(['liveness'])
    expect(h.tail).not.toHaveBeenCalled()
    expect(h.bridge.status).toBe('resumed')
  })

  it('LIVE sheet: behaviour unchanged — record read, writeback, tail, bridge resumed; the check reads the SAME sheet as the record read', async () => {
    const h = makeHarness({ sheet: 'live' })

    await h.service.handleApprovalCompletionEvent(completion(), LEASE_ENV)

    expect(h.order).toEqual(['liveness', 'record-read', 'write:sheet_a', 'tail', 'persist:success'])
    expect(h.sql, 'a live run sends exactly the liveness read and the record read').toEqual(['liveness', 'record-read'])
    expect(h.livenessSheetIds).toEqual(['sheet_a'])
    expect(h.recordReadSheetIds, 'the sheet that was checked is the sheet that is read').toEqual(h.livenessSheetIds)
    expect(h.writes).toHaveBeenCalledTimes(1)
    expect(h.gate, 'a same-base writeback never consults the cross-base gate').not.toHaveBeenCalled()
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

  it('lookup THROWS a real pg server error: the WARN names the driver class and SQLSTATE, not "error", and never the text', async () => {
    const h = makeHarness({ sheet: 'throws', sheetError: pgStatementTimeout })

    await expect(h.service.handleApprovalCompletionEvent(completion(), LEASE_ENV)).resolves.toBeUndefined()

    expect(h.writes).toHaveBeenCalledTimes(1)
    const failOpen = reasonWarns('liveness_lookup_failed')
    expect(failOpen).toHaveLength(1)
    expect(failOpen[0][1]).toEqual({
      bridgeId: 'aab_bridge_1',
      ruleId: 'atr_bridge',
      sheetId: 'sheet_a',
      reason: 'liveness_lookup_failed',
      errorClass: 'DatabaseError',
      errorCode: '57014',
    })
    const serialized = JSON.stringify(warn.mock.calls)
    expect(serialized).not.toContain('db.internal')
    expect(serialized).not.toContain('statement timeout')
  })

  it('lookup THROWS on the legacy path: also fail-open (a throw there would strand the run under a consumed bridge)', async () => {
    const h = makeHarness({ sheet: 'throws' })

    await expect(h.service.handleApprovalCompletionEvent(completion(), LEGACY_ENV)).resolves.toBeUndefined()

    expect(h.writes).toHaveBeenCalledTimes(1)
    expect(h.tail).toHaveBeenCalledTimes(1)
    expect(reasonWarns('liveness_lookup_failed')).toHaveLength(1)
  })
})

describe('describeLookupError — values-free error description shared by both approval liveness lanes', () => {
  it('pg DatabaseError: its `name` is the protocol type "error", so the CONSTRUCTOR name and SQLSTATE are used', () => {
    const err = pgStatementTimeout()
    expect(err.name, 'precondition: this is why `err.name` alone was useless').toBe('error')
    expect(describeLookupError(err)).toEqual({ errorClass: 'DatabaseError', errorCode: '57014' })
  })

  it('distinct server failures are told apart by code', () => {
    const denied = new pg.DatabaseError('permission denied for table meta_sheets', 60, 'error')
    denied.code = '42501'
    const tooMany = new pg.DatabaseError('sorry, too many clients already', 40, 'error')
    tooMany.code = '53300'
    expect(describeLookupError(denied)).toEqual({ errorClass: 'DatabaseError', errorCode: '42501' })
    expect(describeLookupError(tooMany)).toEqual({ errorClass: 'DatabaseError', errorCode: '53300' })
  })

  it('Node errno codes and coded app errors pass; anything not identifier-shaped is dropped', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432'), { code: 'ECONNREFUSED' })
    expect(describeLookupError(refused)).toEqual({ errorClass: 'Error', errorCode: 'ECONNREFUSED' })
    expect(describeLookupError(new SheetNotLiveError('sheet_x', 'deleted'))).toEqual({
      errorClass: 'SheetNotLiveError',
      errorCode: SHEET_DELETED_CODE,
    })
    const valueish = Object.assign(new Error('boom'), { code: 'host=db.internal user=svc' })
    expect(describeLookupError(valueish)).toEqual({ errorClass: 'Error' })
    expect(describeLookupError(Object.assign(new Error('boom'), { code: 57014 }))).toEqual({ errorClass: 'Error' })
  })

  it('a class name that is not identifier-shaped is never logged: falls back to `name`, then to "Error"', () => {
    class Weird extends Error {}
    Object.defineProperty(Weird, 'name', { value: 'host=db.internal user=svc' })
    const named = new Weird('boom')
    named.name = 'WeirdError'
    expect(describeLookupError(named)).toEqual({ errorClass: 'WeirdError' })
    const unnamed = new Weird('boom')
    unnamed.name = 'user=svc host=db.internal'
    expect(describeLookupError(unnamed)).toEqual({ errorClass: 'Error' })
  })

  it('non-Error throws are described by type only', () => {
    expect(describeLookupError('connection terminated: host=db.internal')).toEqual({ errorClass: 'string' })
    expect(describeLookupError(undefined)).toEqual({ errorClass: 'undefined' })
    expect(describeLookupError({ code: '57014' })).toEqual({ errorClass: 'object', errorCode: '57014' })
  })
})
