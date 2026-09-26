/**
 * 客户反馈 2026-09-24 #3 (裁定 PR #6074 A1) — same-shape sweep, approval-result writeback lane.
 *
 * `AutomationService.applyResultWritebackPatch` (the shared tail of the same-base AND cross-base
 * `start_approval.resultWriteback`) had the SAME "still emits on a 0-row UPDATE" shape the executor's
 * `update_record` / `delete_record` had: its lock-check SELECT takes no row lock, so a record deleted between
 * that SELECT and the UPDATE makes the UPDATE affect 0 rows — and the tail still enqueued / emitted a fresh
 * `multitable.record.updated` (new `_eventId`, depth+1) and published a realtime invalidation for a record
 * nobody wrote. D-1c slice ④ had already stopped the spurious REVISION on that path; the EVENT leg was
 * documented as "unchanged" (automation-service.ts, the ZERO-ROW paragraph above the method).
 *
 * Pinned here (mock DB through the real `withTransaction` seam, REAL EventBus, producer enqueue + realtime
 * publish spied, revision writes counted):
 *   W1 same-base, SELECT sees the row, UPDATE 0 rows → `writeApprovalResultBack` returns null; ZERO enqueue,
 *      ZERO legacy emit, ZERO realtime publish, ZERO revision INSERT (the UPDATE itself DID run).
 *   W2 same-base control, UPDATE 1 row     → `{ kind: 'same-base', patch }`; ONE enqueue call, ONE legacy emit
 *      (depth = trigger depth + 1, approval actor), ONE realtime publish (actor surfaced), ONE revision.
 *   W3 same-base, SELECT already sees no row → null, nothing published, and NO UPDATE sent (the pre-existing
 *      gone-record branch, unchanged).
 *   W4 cross-base, SELECT sees the row, UPDATE 0 rows → the caller's `onMissing: 'throw'` policy applies
 *      exactly as for a not-found target: rejects with the not-found message, nothing published, no revision;
 *      `tryWriteApprovalResultBack` turns it into `backwriteSkipped` on the step output (a handled
 *      deterministic path — never an escaping crash that would cost the bridge lease).
 *   W5 cross-base control, UPDATE 1 row    → `{ kind: 'cross-base', target }`; ONE enqueue + ONE emit carrying
 *      the TRIGGER actor; the realtime publish OMITS the actor (cross-base privacy posture, unchanged).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const producerEmitMocks = vi.hoisted(() => ({
  enqueue: vi.fn(async (..._args: unknown[]) => false),
}))
vi.mock('../../src/multitable/automation-producer-emit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/multitable/automation-producer-emit')>()
  return { ...actual, enqueueRecordEventIfDurable: producerEmitMocks.enqueue }
})

const realtimeMocks = vi.hoisted(() => ({
  publish: vi.fn((..._args: unknown[]) => undefined),
}))
vi.mock('../../src/multitable/realtime-publish', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/multitable/realtime-publish')>()
  return { ...actual, publishMultitableSheetRealtime: realtimeMocks.publish }
})

import { EventBus } from '../../src/integration/events/event-bus'
import { Logger } from '../../src/core/logger'
import { poolManager } from '../../src/integration/db/connection-pool'
import { AutomationService } from '../../src/multitable/automation-service'

const SRC_SHEET = 'sheet_wb_src_1'
const SRC_RECORD = 'rec_wb_src_1'
const TGT_BASE = 'base_wb_tgt_1'
const TGT_SHEET = 'sheet_wb_tgt_1'
const TGT_RECORD = 'rec_wb_tgt_1'
const APPROVER = 'u_wb_approver_1'
const TRIGGER_ACTOR = 'u_wb_trigger_1'
const TRIGGER_DEPTH = 1

interface MockState {
  /** Does the (non-locking) lock-check SELECT see the row? */
  selectHits: boolean
  /** Does the UPDATE ... RETURNING affect a row? (false = the record vanished in between) */
  updateHits: boolean
  sql: string[]
  updates: number
  revisionInserts: number
}

function makeState(selectHits: boolean, updateHits: boolean): MockState {
  return { selectHits, updateHits, sql: [], updates: 0, revisionInserts: 0 }
}

function makeHandle(state: MockState) {
  return async (sql: unknown, _params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> => {
    const s = String(sql)
    state.sql.push(s)
    if (/INSERT\s+INTO\s+meta_record_revisions/i.test(s)) {
      state.revisionInserts++
      return { rows: [{ seq: '1' }], rowCount: 1 }
    }
    if (/UPDATE\s+meta_records/i.test(s)) {
      state.updates++
      return state.updateHits
        ? { rows: [{ version: 2, data: { fld_status: 'approved' } }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    }
    if (/SELECT[\s\S]*FROM\s+meta_records/i.test(s)) {
      return state.selectHits
        ? { rows: [{ locked: false, locked_by: null, created_by: TRIGGER_ACTOR }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    }
    return { rows: [], rowCount: 0 }
  }
}

type BridgeLike = {
  id: string
  sheetId: string | null
  recordId: string | null
  triggerEvent: Record<string, unknown> | null
}

type StepResultLike = { actionType: string; status: string; output?: Record<string, unknown> }

type Internals = {
  writeApprovalResultBack(bridge: BridgeLike, config: Record<string, unknown>, event: unknown): Promise<unknown>
  tryWriteApprovalResultBack(bridge: BridgeLike, config: Record<string, unknown>, event: unknown, result: StepResultLike): Promise<unknown>
  assertResultWritebackFields: (...args: unknown[]) => Promise<void>
  executor: { evaluateCrossBaseWriteGate: (...args: unknown[]) => Promise<unknown> }
}

function bridge(): BridgeLike {
  return {
    id: 'aab_wb_1',
    sheetId: SRC_SHEET,
    recordId: SRC_RECORD,
    triggerEvent: { actorId: TRIGGER_ACTOR, recordId: SRC_RECORD, _automationDepth: TRIGGER_DEPTH },
  }
}

function approvedEvent() {
  return {
    version: 1,
    source: 'approval-product',
    eventType: 'approval.approved',
    eventId: 'evt_wb_1',
    occurredAt: '2026-09-25T00:00:00.000Z',
    approval: { instanceId: 'ai_wb_1', requestNo: 'REQ-1', templateId: 'tpl_1', publishedDefinitionId: 'pd_1' },
    transition: { toStatus: 'approved' },
    actor: { id: APPROVER },
    requester: { id: TRIGGER_ACTOR },
  }
}

const SAME_BASE_CONFIG = { templateId: 'tpl_1', resultWriteback: { statusField: 'fld_status' } }
const CROSS_BASE_CONFIG = {
  templateId: 'tpl_1',
  resultWriteback: { statusField: 'fld_status', targetBaseId: TGT_BASE, targetSheetId: TGT_SHEET, targetRecordId: TGT_RECORD },
}

function makeService(state: MockState, bus: EventBus): { service: AutomationService; internals: Internals; gate: ReturnType<typeof vi.fn> } {
  const query = vi.fn(makeHandle(state))
  const service = new AutomationService(bus, {} as never, query as never)
  // `withTransaction` is hard-wired to poolManager.get().transaction — route it through the same handler.
  vi.spyOn(poolManager, 'get').mockReturnValue({
    query,
    transaction: (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  } as never)
  const internals = service as unknown as Internals
  // The field-shape check reads the sheet's field catalogue; not what this suite is about.
  vi.spyOn(internals, 'assertResultWritebackFields').mockResolvedValue(undefined)
  // Cross-base gate: authorized (the record-level 0-row guard is what is under test, not the gate).
  const gate = vi.fn(async () => ({ crossBase: true, ok: true }))
  vi.spyOn(internals.executor, 'evaluateCrossBaseWriteGate').mockImplementation(gate as never)
  return { service, internals, gate }
}

function updatedEmits(emitSpy: { mock: { calls: unknown[][] } }): unknown[][] {
  return emitSpy.mock.calls.filter((call) => call[0] === 'multitable.record.updated')
}

beforeEach(() => {
  delete process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED // flag OFF ⇒ the legacy bus emit is the delivery leg
  delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
  producerEmitMocks.enqueue.mockClear()
  realtimeMocks.publish.mockClear()
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
  vi.spyOn(Logger.prototype, 'info').mockImplementation(() => {})
  vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('客户反馈 2026-09-24 #3 — approval resultWriteback: a 0-row UPDATE publishes nothing', () => {
  it('W1 same-base: SELECT sees the row, UPDATE affects 0 rows → null, ZERO enqueue / emit / publish / revision', async () => {
    const bus = new EventBus()
    const emitSpy = vi.spyOn(bus, 'emit')
    const state = makeState(true, false)
    const { internals } = makeService(state, bus)

    const outcome = await internals.writeApprovalResultBack(bridge(), SAME_BASE_CONFIG, approvedEvent())

    // The self-chain vector first: NO fresh multitable.record.updated on either delivery leg, no realtime.
    expect(producerEmitMocks.enqueue).not.toHaveBeenCalled()
    expect(updatedEmits(emitSpy)).toHaveLength(0)
    expect(emitSpy).not.toHaveBeenCalled()
    expect(realtimeMocks.publish).not.toHaveBeenCalled()
    // Then the outcome the resume sees: "nothing written" (leniency: the caller treats null as handled).
    expect(outcome).toBeNull()
    expect(state.updates).toBe(1) // the UPDATE ran — and touched nothing
    expect(state.revisionInserts).toBe(0)
  })

  it('W2 same-base control: UPDATE affects 1 row → patch outcome, ONE enqueue, ONE emit (depth+1, approval actor), ONE publish, ONE revision', async () => {
    const bus = new EventBus()
    const emitSpy = vi.spyOn(bus, 'emit')
    const state = makeState(true, true)
    const { internals } = makeService(state, bus)

    const outcome = await internals.writeApprovalResultBack(bridge(), SAME_BASE_CONFIG, approvedEvent())

    expect(outcome).toEqual({ kind: 'same-base', patch: { fld_status: 'approved' } })
    expect(state.updates).toBe(1)
    expect(state.revisionInserts).toBe(1)
    const emits = updatedEmits(emitSpy)
    expect(emits).toHaveLength(1)
    expect(emits[0]?.[1]).toMatchObject({
      sheetId: SRC_SHEET,
      recordId: SRC_RECORD,
      changes: { fld_status: 'approved' },
      actorId: APPROVER,
      _automationDepth: TRIGGER_DEPTH + 1,
    })
    expect(typeof (emits[0]?.[1] as { _eventId?: unknown })._eventId).toBe('string')
    // Flag OFF ⇒ the durable seam is still CALLED (and returns false); the legacy emit above delivers.
    expect(producerEmitMocks.enqueue).toHaveBeenCalledTimes(1)
    expect(producerEmitMocks.enqueue.mock.calls[0]?.[1]).toBe('multitable.record.updated')
    expect(realtimeMocks.publish).toHaveBeenCalledTimes(1)
    expect(realtimeMocks.publish.mock.calls[0]?.[0]).toMatchObject({
      kind: 'record-updated',
      spreadsheetId: SRC_SHEET,
      recordId: SRC_RECORD,
      actorId: APPROVER,
    })
  })

  it('W3 same-base: SELECT already sees no row → null, no UPDATE sent, nothing published (pre-existing branch unchanged)', async () => {
    const bus = new EventBus()
    const emitSpy = vi.spyOn(bus, 'emit')
    const state = makeState(false, false)
    const { internals } = makeService(state, bus)

    const outcome = await internals.writeApprovalResultBack(bridge(), SAME_BASE_CONFIG, approvedEvent())

    expect(outcome).toBeNull()
    expect(state.updates).toBe(0)
    expect(state.revisionInserts).toBe(0)
    expect(emitSpy).not.toHaveBeenCalled()
    expect(producerEmitMocks.enqueue).not.toHaveBeenCalled()
    expect(realtimeMocks.publish).not.toHaveBeenCalled()
  })

  it('W4 cross-base: SELECT sees the row, UPDATE affects 0 rows → fails closed like a not-found target (onMissing=throw), nothing published; surfaced as backwriteSkipped', async () => {
    const bus = new EventBus()
    const emitSpy = vi.spyOn(bus, 'emit')
    const state = makeState(true, false)
    const { internals, gate } = makeService(state, bus)

    await expect(internals.writeApprovalResultBack(bridge(), CROSS_BASE_CONFIG, approvedEvent()))
      .rejects.toThrow(`cross-base resultWriteback target record not found: ${TGT_RECORD} ∉ ${TGT_SHEET}`)

    expect(gate).toHaveBeenCalledTimes(1)
    expect(state.updates).toBe(1)
    expect(state.revisionInserts).toBe(0)
    expect(emitSpy).not.toHaveBeenCalled()
    expect(producerEmitMocks.enqueue).not.toHaveBeenCalled()
    expect(realtimeMocks.publish).not.toHaveBeenCalled()

    // The handled path the resume actually takes: a deterministic `backwriteSkipped`, not an escaping throw.
    const result: StepResultLike = { actionType: 'start_approval', status: 'success', output: { outcome: 'approved' } }
    const backwritten = await internals.tryWriteApprovalResultBack(bridge(), CROSS_BASE_CONFIG, approvedEvent(), result)
    expect(backwritten).toBeNull()
    expect(result.output).toMatchObject({ outcome: 'approved', backwriteSkipped: expect.stringContaining('target record not found') })
    expect(emitSpy).not.toHaveBeenCalled()
    expect(producerEmitMocks.enqueue).not.toHaveBeenCalled()
    expect(realtimeMocks.publish).not.toHaveBeenCalled()
  })

  it('W5 cross-base control: UPDATE affects 1 row → target outcome, ONE enqueue + ONE emit (TRIGGER actor), realtime publish OMITS the actor', async () => {
    const bus = new EventBus()
    const emitSpy = vi.spyOn(bus, 'emit')
    const state = makeState(true, true)
    const { internals } = makeService(state, bus)

    const outcome = await internals.writeApprovalResultBack(bridge(), CROSS_BASE_CONFIG, approvedEvent())

    expect(outcome).toEqual({ kind: 'cross-base', target: { targetBaseId: TGT_BASE, targetSheetId: TGT_SHEET, targetRecordId: TGT_RECORD } })
    expect(state.revisionInserts).toBe(1)
    const emits = updatedEmits(emitSpy)
    expect(emits).toHaveLength(1)
    expect(emits[0]?.[1]).toMatchObject({ sheetId: TGT_SHEET, recordId: TGT_RECORD, actorId: TRIGGER_ACTOR, _automationDepth: TRIGGER_DEPTH + 1 })
    expect(producerEmitMocks.enqueue).toHaveBeenCalledTimes(1)
    expect(realtimeMocks.publish).toHaveBeenCalledTimes(1)
    expect(realtimeMocks.publish.mock.calls[0]?.[0]).toMatchObject({ kind: 'record-updated', spreadsheetId: TGT_SHEET, recordId: TGT_RECORD })
    expect((realtimeMocks.publish.mock.calls[0]?.[0] as { actorId?: unknown }).actorId).toBeUndefined()
  })
})
