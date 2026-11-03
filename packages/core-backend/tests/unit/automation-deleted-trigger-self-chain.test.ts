/**
 * 客户反馈 2026-09-24 #3 (裁定 PR #6074) — the rule「记录删除时 → 删除记录（同表）」produced THREE execution logs for
 * ONE user delete.
 *
 * Root cause (automation-executor.ts executeDeleteRecord): under a `record.deleted` trigger a same-base
 * `delete_record` addresses `context.recordId` — the trigger record, which is already gone. The 0-row DELETE was
 * reported `success` AND still enqueued / emitted a fresh `multitable.record.deleted` (new `_eventId`, depth+1),
 * which re-fired the same rule until `MAX_AUTOMATION_DEPTH` (3) dropped it. `update_record` shared the shape (an
 * emit "unconditional on updatedRow"). `lock_record` emits no record event at all, so it has no chain to cut.
 *
 * Pinned here (mock DB, REAL EventBus, and for S6 the REAL AutomationService bus loop):
 *   S1 delete_record, trigger record GONE   → step `skipped` (values-free reason), NO bus emit, NO outbox
 *      enqueue call, NO real-time publish, NO meta_records / meta_links / revision write (the transaction is
 *      abandoned at the signal, BEFORE any write — so the Class-A claim never commits for a no-op either).
 *   S2 delete_record, record PRESENT        → unchanged: success, ONE emit (depth+1), ONE enqueue call, ONE
 *      real-time publish, ONE DELETE, ONE delete revision.
 *   S3 delete_record, the lock SELECT saw the row but the DELETE reports 0 rows (autocommit race) → skipped,
 *      NO emit (belt-and-braces path).
 *   S4 update_record, trigger record GONE   → status STAYS `success` (the pinned same-base 0-row leniency the
 *      executor suites model with empty mock rows) but `output.noop` marks it, and NO emit / enqueue / publish.
 *   S5 update_record, record PRESENT        → unchanged: ONE emit (depth+1).
 *   S6 THE CUSTOMER SCENARIO end to end through AutomationService.init() + handleEvent on a real bus: one
 *      `multitable.record.deleted` for a stored「record.deleted → delete_record」rule ⇒ exactly ONE execution
 *      recorded (status `skipped`) and ZERO chain events. (Before the fix: three executions.)
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

const automationLogMocks = vi.hoisted(() => ({
  record: vi.fn(async (_execution: unknown) => undefined),
  updateRecordedExecution: vi.fn(async (_execution: unknown) => undefined),
  getByRule: vi.fn(async () => []),
  getRecent: vi.fn(async () => []),
  getById: vi.fn(async () => undefined),
  getStats: vi.fn(async () => ({ total: 0, success: 0, failed: 0, skipped: 0, avgDuration: 0 })),
  cleanup: vi.fn(async () => 0),
}))
vi.mock('../../src/multitable/automation-log-service', () => ({
  AutomationLogService: class {
    record = automationLogMocks.record
    updateRecordedExecution = automationLogMocks.updateRecordedExecution
    getByRule = automationLogMocks.getByRule
    getRecent = automationLogMocks.getRecent
    getById = automationLogMocks.getById
    getStats = automationLogMocks.getStats
    cleanup = automationLogMocks.cleanup
  },
}))

import { EventBus } from '../../src/integration/events/event-bus'
import {
  AutomationExecutor,
  TARGET_RECORD_MISSING_SKIP_REASON,
  type AutomationDeps,
  type AutomationExecution,
  type AutomationRule,
} from '../../src/multitable/automation-executor'
import { AutomationService, type AutomationRule as StoredAutomationRule } from '../../src/multitable/automation-service'

const SHEET = 'sheet_chain_1'
const ACTOR = 'u_chain_1'
const GONE = 'rec_gone_1'
const LIVE = 'rec_live_1'

interface MockState {
  /** Does the addressed record exist (lock SELECT returns a row, UPDATE RETURNING returns a row)? */
  recordPresent: boolean
  /** Override the rowCount the DELETE reports (S3 models a driver-reported 0 after a successful lock). */
  deleteRowCount?: number
  sql: string[]
  recordDeletes: number
  recordUpdates: number
  linkDeletes: number
  revisionInserts: number
}

function makeState(recordPresent: boolean): MockState {
  return { recordPresent, sql: [], recordDeletes: 0, recordUpdates: 0, linkDeletes: 0, revisionInserts: 0 }
}

function makeHandle(state: MockState) {
  return async (sql: unknown, _params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> => {
    const s = String(sql)
    state.sql.push(s)
    // Sheet liveness (service path) + base resolution: one live sheet in one base.
    if (/FROM\s+meta_sheets/i.test(s)) return { rows: [{ id: SHEET, base_id: 'base_chain_1', deleted_at: null }], rowCount: 1 }
    if (/meta_record_revisions/i.test(s)) {
      state.revisionInserts++
      return { rows: [], rowCount: 1 }
    }
    if (/DELETE\s+FROM\s+meta_links/i.test(s)) {
      state.linkDeletes++
      return { rows: [], rowCount: 0 }
    }
    if (/DELETE\s+FROM\s+meta_records/i.test(s)) {
      state.recordDeletes++
      return { rows: [], rowCount: state.deleteRowCount ?? (state.recordPresent ? 1 : 0) }
    }
    if (/UPDATE\s+meta_records/i.test(s)) {
      state.recordUpdates++
      return state.recordPresent
        ? { rows: [{ version: 2, data: { status: 'done' } }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    }
    if (/SELECT[\s\S]*FROM\s+meta_records/i.test(s)) {
      // The lock-check SELECT (FOR UPDATE on the delete path): the trigger record is gone ⇒ no row.
      return state.recordPresent
        ? { rows: [{ locked: false, locked_by: null, created_by: ACTOR, version: 1, data: { status: 'open' }, created_at: null, updated_at: null }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
    }
    return { rows: [], rowCount: 0 }
  }
}

/** Executor deps with a REAL bus and a transaction seam that routes through the same handler (so the signal
 *  thrown inside the transaction propagates exactly as a rolled-back pg transaction would). */
function makeDeps(state: MockState, bus: EventBus): AutomationDeps {
  const handle = makeHandle(state)
  return {
    eventBus: bus,
    queryFn: vi.fn(handle),
    transaction: vi.fn(async (handler) => handler({ query: vi.fn(handle) })),
  }
}

function ruleWith(action: { type: string; config: Record<string, unknown> }): AutomationRule {
  return {
    id: 'atr_chain_1',
    name: '记录删除时 → 删除记录',
    sheetId: SHEET,
    trigger: { type: 'record.deleted', config: {} },
    actions: [action as never],
    enabled: true,
    createdBy: ACTOR,
    createdAt: '2026-09-24T00:00:00Z',
  } as AutomationRule
}

/** The event the record-service delete sink publishes for ONE user delete (identity stamped like production). */
function userDeleteEvent(recordId: string): Record<string, unknown> {
  return { sheetId: SHEET, recordId, actorId: ACTOR, data: {}, _eventId: 'evt_user_delete_1' }
}

function emitsOf(emitSpy: ReturnType<typeof vi.spyOn>, eventType: string): unknown[][] {
  return emitSpy.mock.calls.filter((call) => call[0] === eventType)
}

/** Let every microtask + macrotask hop of a would-be chain (bus → tracked handleEvent → executor) settle. */
async function settle(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  delete process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED
  producerEmitMocks.enqueue.mockClear()
  realtimeMocks.publish.mockClear()
  automationLogMocks.record.mockClear()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('客户反馈 2026-09-24 #3 — executor: a same-base action on a GONE trigger record publishes nothing', () => {
  it('S1 delete_record on the gone trigger record → skipped, zero emit / enqueue / publish, zero writes', async () => {
    const bus = new EventBus()
    const emitSpy = vi.spyOn(bus, 'emit')
    const state = makeState(false)

    const exec = await new AutomationExecutor(makeDeps(state, bus)).execute(
      ruleWith({ type: 'delete_record', config: {} }),
      userDeleteEvent(GONE),
    )

    expect(exec.status).toBe('skipped')
    expect(exec.steps).toHaveLength(1)
    expect(exec.steps[0]).toMatchObject({
      actionType: 'delete_record',
      status: 'skipped',
      output: { recordId: GONE, sheetId: SHEET, reason: TARGET_RECORD_MISSING_SKIP_REASON },
    })
    expect(exec.steps[0]?.error).toBeUndefined()

    // The self-chain vector: NO fresh multitable.record.deleted on either delivery path.
    expect(emitsOf(emitSpy, 'multitable.record.deleted')).toHaveLength(0)
    expect(emitSpy).not.toHaveBeenCalled()
    expect(producerEmitMocks.enqueue).not.toHaveBeenCalled()
    expect(realtimeMocks.publish).not.toHaveBeenCalled()

    // Nothing was written: the transaction is abandoned at the lock SELECT, before links / revision / DELETE.
    expect(state.recordDeletes).toBe(0)
    expect(state.linkDeletes).toBe(0)
    expect(state.revisionInserts).toBe(0)
    expect(state.sql.some((s) => /FOR UPDATE/i.test(s))).toBe(true) // the lock SELECT is what decided it
  })

  it('S2 delete_record on a PRESENT record → unchanged: success, ONE emit (depth+1), ONE enqueue, ONE publish', async () => {
    const bus = new EventBus()
    const emitSpy = vi.spyOn(bus, 'emit')
    const state = makeState(true)

    const exec = await new AutomationExecutor(makeDeps(state, bus)).execute(
      ruleWith({ type: 'delete_record', config: {} }),
      userDeleteEvent(LIVE),
    )

    expect(exec.status).toBe('success')
    expect(exec.steps[0]).toMatchObject({ actionType: 'delete_record', status: 'success', output: { recordId: LIVE, sheetId: SHEET } })
    const deletedEmits = emitsOf(emitSpy, 'multitable.record.deleted')
    expect(deletedEmits).toHaveLength(1)
    expect(deletedEmits[0]?.[1]).toMatchObject({ sheetId: SHEET, recordId: LIVE, actorId: ACTOR, _automationDepth: 1 })
    expect(typeof (deletedEmits[0]?.[1] as { _eventId?: unknown })._eventId).toBe('string')
    // Flag OFF ⇒ the durable seam is still CALLED (and returns false); the legacy emit above delivers.
    expect(producerEmitMocks.enqueue).toHaveBeenCalledTimes(1)
    expect(producerEmitMocks.enqueue.mock.calls[0]?.[1]).toBe('multitable.record.deleted')
    expect(realtimeMocks.publish).toHaveBeenCalledTimes(1)
    expect(realtimeMocks.publish.mock.calls[0]?.[0]).toMatchObject({ kind: 'record-deleted', recordId: LIVE, spreadsheetId: SHEET })
    expect(state.recordDeletes).toBe(1)
    expect(state.revisionInserts).toBe(1)
  })

  it('S3 delete_record: lock SELECT saw the row but the DELETE reports 0 rows → skipped, NO emit', async () => {
    const bus = new EventBus()
    const emitSpy = vi.spyOn(bus, 'emit')
    const state = makeState(true)
    state.deleteRowCount = 0

    const exec = await new AutomationExecutor(makeDeps(state, bus)).execute(
      ruleWith({ type: 'delete_record', config: {} }),
      userDeleteEvent(LIVE),
    )

    expect(exec.steps[0]).toMatchObject({ actionType: 'delete_record', status: 'skipped', output: { reason: TARGET_RECORD_MISSING_SKIP_REASON } })
    expect(emitsOf(emitSpy, 'multitable.record.deleted')).toHaveLength(0)
    expect(producerEmitMocks.enqueue).not.toHaveBeenCalled()
    expect(realtimeMocks.publish).not.toHaveBeenCalled()
    expect(state.recordDeletes).toBe(1) // the DELETE ran — and deleted nothing
  })

  it('S4 update_record on the gone trigger record → status kept (leniency) but noop-marked, NO emit / enqueue / publish', async () => {
    const bus = new EventBus()
    const emitSpy = vi.spyOn(bus, 'emit')
    const state = makeState(false)

    const exec = await new AutomationExecutor(makeDeps(state, bus)).execute(
      ruleWith({ type: 'update_record', config: { fields: { status: 'done' } } }),
      userDeleteEvent(GONE),
    )

    expect(exec.steps[0]).toMatchObject({
      actionType: 'update_record',
      status: 'success',
      output: { updatedFields: ['status'], noop: true, reason: TARGET_RECORD_MISSING_SKIP_REASON },
    })
    expect(emitsOf(emitSpy, 'multitable.record.updated')).toHaveLength(0)
    expect(emitSpy).not.toHaveBeenCalled()
    expect(producerEmitMocks.enqueue).not.toHaveBeenCalled()
    expect(realtimeMocks.publish).not.toHaveBeenCalled()
    expect(state.recordUpdates).toBe(1) // the UPDATE ran (0 rows) — no revision was fabricated
    expect(state.revisionInserts).toBe(0)
  })

  it('S5 update_record on a PRESENT record → unchanged: ONE emit (depth+1), ONE enqueue, ONE publish', async () => {
    const bus = new EventBus()
    const emitSpy = vi.spyOn(bus, 'emit')
    const state = makeState(true)

    const exec = await new AutomationExecutor(makeDeps(state, bus)).execute(
      ruleWith({ type: 'update_record', config: { fields: { status: 'done' } } }),
      userDeleteEvent(LIVE),
    )

    expect(exec.steps[0]).toMatchObject({ actionType: 'update_record', status: 'success', output: { updatedFields: ['status'] } })
    expect((exec.steps[0]?.output as { noop?: unknown }).noop).toBeUndefined()
    const updatedEmits = emitsOf(emitSpy, 'multitable.record.updated')
    expect(updatedEmits).toHaveLength(1)
    expect(updatedEmits[0]?.[1]).toMatchObject({ sheetId: SHEET, recordId: LIVE, changes: { status: 'done' }, _automationDepth: 1 })
    expect(producerEmitMocks.enqueue).toHaveBeenCalledTimes(1)
    expect(realtimeMocks.publish).toHaveBeenCalledTimes(1)
    expect(state.revisionInserts).toBe(1)
  })
})

describe('客户反馈 2026-09-24 #3 — the customer scenario through the REAL AutomationService bus loop', () => {
  function storedRule(): StoredAutomationRule {
    return {
      id: 'atr_chain_stored_1',
      sheet_id: SHEET,
      name: '记录删除时 → 删除记录',
      trigger_type: 'record.deleted',
      trigger_config: {},
      action_type: 'delete_record',
      action_config: {},
      enabled: true,
      created_at: '2026-09-24T00:00:00Z',
      updated_at: '2026-09-24T00:00:00Z',
      created_by: ACTOR,
      conditions: null,
      actions: [{ type: 'delete_record', config: {} }],
      execution_mode: null,
    } as StoredAutomationRule
  }

  /** Kysely-shaped mock: every rule query returns the ONE stored rule (loadEnabledRules / getRule). */
  function createMockDb(rules: StoredAutomationRule[]) {
    const chain: Record<string, unknown> = {}
    const chainFn = (..._args: unknown[]) => chain
    for (const method of ['selectAll', 'where', 'orderBy']) chain[method] = vi.fn(chainFn)
    chain.execute = vi.fn(async () => rules)
    chain.executeTakeFirst = vi.fn(async () => rules[0])
    return { selectFrom: vi.fn(() => chain) }
  }

  it('S6 ONE user delete ⇒ exactly ONE execution (skipped) and ZERO chain events', async () => {
    const bus = new EventBus()
    const state = makeState(false)
    const query = vi.fn(makeHandle(state))
    const service = new AutomationService(bus, createMockDb([storedRule()]) as never, query)
    // The executor's write transaction is hard-wired to poolManager.get().transaction — route it through the
    // same mock handler (no Postgres in this suite), mirroring multitable-automation-service.test.ts.
    const { poolManager } = await import('../../src/integration/db/connection-pool')
    vi.spyOn(poolManager, 'get').mockReturnValue({
      query,
      transaction: (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    } as never)
    // The event-dedup ledger is a raw-SQL Kysely write; stub it as "claimed" (and keep the sweep inert) so a
    // chain event — if one were ever emitted — WOULD be admitted and counted. That is what makes this test
    // able to see the pre-fix three executions rather than hiding them behind a failed dedup INSERT.
    const hooks = service as unknown as {
      claimEventDelivery: (ruleId: string, dedupKey: string) => Promise<boolean>
      sweepEventDedupLedger: (nowMs?: number) => Promise<number>
    }
    hooks.claimEventDelivery = vi.fn(async () => true)
    hooks.sweepEventDedupLedger = vi.fn(async () => 0)

    service.init() // subscribe the producer lane to OUR bus — the loop a chain event would travel
    const emitSpy = vi.spyOn(bus, 'emit')
    try {
      await service.handleEvent('multitable.record.deleted', userDeleteEvent(GONE) as never)
      await settle()
    } finally {
      await service.stopProducerAdmissions()
    }

    // Exactly ONE execution was recorded — the customer saw THREE.
    expect(automationLogMocks.record).toHaveBeenCalledTimes(1)
    const recorded = automationLogMocks.record.mock.calls[0]?.[0] as AutomationExecution
    expect(recorded.ruleId).toBe('atr_chain_stored_1')
    expect(recorded.status).toBe('skipped')
    expect(recorded.steps[0]).toMatchObject({ actionType: 'delete_record', status: 'skipped', output: { reason: TARGET_RECORD_MISSING_SKIP_REASON } })
    // …and ZERO chain events on either delivery path.
    expect(emitsOf(emitSpy, 'multitable.record.deleted')).toHaveLength(0)
    expect(producerEmitMocks.enqueue).not.toHaveBeenCalled()
    expect(state.recordDeletes).toBe(0)
  })
})
