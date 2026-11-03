/**
 * 一个项目一张备料表 — S3 fix round 2 (F2 / F7a; register R-37): APPROVAL WRITE-BACKS cannot write the
 * stock-preparation project overview.
 *
 * F2. `start_approval.resultWriteback` with a cross-base target (`targetBaseId` + `targetSheetId` +
 * `targetRecordId`) ends in a bare `UPDATE meta_records` (`applyResultWritebackPatch`), and its only authority
 * check was the executor's cross-base write gate — which checked base write, never the overview stamp. A trigger
 * actor with base write on the overview's base could therefore have an approval outcome written onto the
 * overview. Closed three times, each pinned by its own case so removing any one is observable:
 *   - G-01/G-02: `evaluateCrossBaseWriteGate` refuses an overview target FIRST (no addressing read, no
 *     authority read, no quota slot) — every consumer of the gate inherits it; an ordinary sheet with the same
 *     derived-id shape is still authorized;
 *   - W-01/W-02: the write-back end to end through the REAL gate (only the field-shape check stubbed): the
 *     overview target writes nothing and the step reports `backwriteSkipped`; the same rule at an ordinary
 *     target writes exactly once;
 *   - W-03/W-04: the sink (`applyResultWritebackPatch`) refuses the overview on its own, with the gate
 *     stubbed to "authorized" and on the same-base leg the gate never sees;
 *   - S-01…S-04: rule SAVE (createRule AND updateRule) refuses a write-back whose literal target is the
 *     overview with the typed code and writes no rule row; ordinary and non-derived ids pass the check.
 * F7a. `write_approval_form_values` in UPDATE mode writes the record on the sheet named by the pinned FORM
 *   SCHEMA's record-link field — invisible to the pre-dispatch guard. F-01: refused with
 *   `fwb_rejected:stock_prep_overview_read_only` right after the target is derived (before the gate's own
 *   refusal, which would answer `fwb_rejected:cross_base`); F-02 control: an ordinary derived target is not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/multitable/automation-producer-emit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/multitable/automation-producer-emit')>()
  return { ...actual, enqueueRecordEventIfDurable: vi.fn(async () => false) }
})
vi.mock('../../src/multitable/realtime-publish', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/multitable/realtime-publish')>()
  return { ...actual, publishMultitableSheetRealtime: vi.fn(() => undefined) }
})

import { EventBus } from '../../src/integration/events/event-bus'
import { Logger } from '../../src/core/logger'
import { poolManager } from '../../src/integration/db/connection-pool'
import {
  AutomationRuleValidationError,
  AutomationService,
  STOCK_PREP_OVERVIEW_RESULT_WRITEBACK_SAVE_REFUSAL,
  validateStockPrepOverviewResultWritebackTargets,
} from '../../src/multitable/automation-service'
import { AutomationExecutor, type AutomationDeps, type AutomationRule } from '../../src/multitable/automation-executor'

// Synthetic ids. Both "sheet_ + 24 hex" (the derived-id shape every overview has); only OVERVIEW is stamped.
const OVERVIEW = 'sheet_0123456789abcdef01234567'
const ORDINARY = 'sheet_fedcba9876543210fedcba98'
const TRIGGER_SHEET = 'sheet_f2_trigger'
const TRIGGER_BASE = 'base_f2_trigger'
const TARGET_BASE = 'base_f2_target'
const TARGET_RECORD = 'rec_f2_target'
const TRIGGER_ACTOR = 'u_f2_trigger'
const OVERVIEW_SQL = "SELECT id FROM meta_sheets WHERE id = ANY($1::text[]) AND (to_jsonb(meta_sheets) ->> 'system_kind') = $2"
const norm = (sql: unknown) => String(sql).replace(/\s+/g, ' ').trim()

interface DbState {
  statements: string[]
  overviewLookups: string[][]
  updates: Array<{ sheetId: unknown; recordId: unknown }>
}

/** One handler for the service's queryFn, the pool transaction and the executor's queryFn. */
function makeHandler(state: DbState) {
  return async (sql: unknown, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> => {
    const s = norm(sql)
    state.statements.push(s)
    if (s === OVERVIEW_SQL) {
      const ids = (((params ?? [])[0]) as string[]) ?? []
      state.overviewLookups.push(ids)
      const rows = ids.filter((id) => id === OVERVIEW).map((id) => ({ id }))
      return { rows, rowCount: rows.length }
    }
    if (/^SELECT base_id FROM meta_sheets/i.test(s)) {
      const id = String(params?.[0])
      if (id === TRIGGER_SHEET) return { rows: [{ base_id: TRIGGER_BASE }], rowCount: 1 }
      if (id === OVERVIEW || id === ORDINARY) return { rows: [{ base_id: TARGET_BASE }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    }
    if (/^SELECT owner_id FROM meta_bases/i.test(s)) {
      // The trigger actor OWNS the target base: base write is granted — the overview stamp is the only refusal.
      return { rows: [{ owner_id: TRIGGER_ACTOR }], rowCount: 1 }
    }
    if (/INSERT\s+INTO\s+meta_record_revisions/i.test(s)) return { rows: [{ seq: '1' }], rowCount: 1 }
    if (/^UPDATE meta_records/i.test(s)) {
      state.updates.push({ recordId: params?.[1], sheetId: params?.[2] })
      return { rows: [{ version: 2, data: {} }], rowCount: 1 }
    }
    if (/SELECT[\s\S]*FROM meta_records/i.test(s)) {
      return { rows: [{ locked: false, locked_by: null, created_by: TRIGGER_ACTOR }], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  }
}

const freshState = (): DbState => ({ statements: [], overviewLookups: [], updates: [] })

type BridgeLike = { id: string; sheetId: string | null; recordId: string | null; triggerEvent: Record<string, unknown> | null }
type Internals = {
  writeApprovalResultBack(bridge: BridgeLike, config: Record<string, unknown>, event: unknown): Promise<unknown>
  tryWriteApprovalResultBack(bridge: BridgeLike, config: Record<string, unknown>, event: unknown, result: { actionType: string; status: string; output?: Record<string, unknown> }): Promise<unknown>
  assertResultWritebackFields: (...args: unknown[]) => Promise<void>
  executor: AutomationExecutor
}

function makeService(state: DbState): { service: AutomationService; internals: Internals } {
  const query = vi.fn(makeHandler(state))
  const service = new AutomationService(new EventBus(), {} as never, query as never)
  vi.spyOn(poolManager, 'get').mockReturnValue({
    query,
    transaction: (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  } as never)
  const internals = service as unknown as Internals
  // The target field catalogue is not the subject; the gate and the sink are REAL.
  vi.spyOn(internals, 'assertResultWritebackFields').mockResolvedValue(undefined)
  return { service, internals }
}

function bridge(sheetId = TRIGGER_SHEET): BridgeLike {
  return { id: 'aab_f2', sheetId, recordId: 'rec_f2_source', triggerEvent: { actorId: TRIGGER_ACTOR, recordId: 'rec_f2_source', _automationDepth: 0 } }
}

function approvedEvent() {
  return {
    version: 1,
    source: 'approval-product',
    eventType: 'approval.approved',
    eventId: 'evt_f2',
    occurredAt: '2026-10-09T00:00:00.000Z',
    approval: { instanceId: 'ai_f2', requestNo: 'REQ-F2', templateId: 'tpl_f2', publishedDefinitionId: 'pd_f2' },
    transition: { toStatus: 'approved' },
    actor: { id: 'u_f2_approver' },
    requester: { id: TRIGGER_ACTOR },
  }
}

const crossBaseConfig = (targetSheetId: string) => ({
  templateId: 'tpl_f2',
  resultWriteback: { statusField: 'fld_status', targetBaseId: TARGET_BASE, targetSheetId, targetRecordId: TARGET_RECORD },
})

beforeEach(() => {
  delete process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED
  delete process.env.MULTITABLE_ENABLE_WRITER_FENCE
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
  vi.spyOn(Logger.prototype, 'info').mockImplementation(() => {})
  vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.APPROVAL_FWB_WRITEBACK_ENABLED
  delete process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED
})

describe('S3 fix round 2 F2 — the executor cross-base write gate refuses the overview', () => {
  it('G-01 an overview target is refused FIRST: values-free STOCK_PREP_OVERVIEW_READ_ONLY, no base / authority read', async () => {
    const state = freshState()
    const executor = new AutomationExecutor({ eventBus: new EventBus(), queryFn: vi.fn(makeHandler(state)) } as AutomationDeps)
    const gate = await executor.evaluateCrossBaseWriteGate(
      vi.fn(makeHandler(state)) as AutomationDeps['queryFn'], TRIGGER_ACTOR, TRIGGER_SHEET, OVERVIEW, TARGET_BASE,
    )
    expect(gate).toMatchObject({ crossBase: true, ok: false })
    expect((gate as { error: string }).error).toMatch(/^STOCK_PREP_OVERVIEW_READ_ONLY: /)
    expect((gate as { error: string }).error).not.toContain(OVERVIEW)
    expect(state.statements).toEqual([OVERVIEW_SQL])
  })

  it('G-02 control: an ordinary sheet of the same id shape, same base, same actor → authorized (one lookup, then the usual gate)', async () => {
    const state = freshState()
    const executor = new AutomationExecutor({ eventBus: new EventBus(), queryFn: vi.fn(makeHandler(state)) } as AutomationDeps)
    const gate = await executor.evaluateCrossBaseWriteGate(
      vi.fn(makeHandler(state)) as AutomationDeps['queryFn'], TRIGGER_ACTOR, TRIGGER_SHEET, ORDINARY, TARGET_BASE,
    )
    expect(gate).toEqual({ crossBase: true, ok: true })
    expect(state.overviewLookups).toEqual([[ORDINARY]])
    expect(state.statements.some((s) => /^SELECT owner_id FROM meta_bases/i.test(s))).toBe(true)
  })
})

describe('S3 fix round 2 F2 — approval result write-back to another base cannot write the overview', () => {
  it('W-01 a rule whose resultWriteback targets the overview in another base writes NOTHING (real gate) and the step says backwriteSkipped', async () => {
    const state = freshState()
    const { internals } = makeService(state)
    await expect(internals.writeApprovalResultBack(bridge(), crossBaseConfig(OVERVIEW), approvedEvent()))
      .rejects.toThrow(/^STOCK_PREP_OVERVIEW_READ_ONLY: /)
    expect(state.updates).toEqual([])

    const state2 = freshState()
    const { internals: internals2 } = makeService(state2)
    const step = { actionType: 'start_approval', status: 'success', output: {} as Record<string, unknown> }
    await internals2.tryWriteApprovalResultBack(bridge(), crossBaseConfig(OVERVIEW), approvedEvent(), step)
    expect(state2.updates).toEqual([])
    expect(JSON.stringify(step.output)).toMatch(/backwriteSkipped/)
    expect(JSON.stringify(step.output)).not.toContain(OVERVIEW)
  })

  it('W-02 control: the SAME rule at an ordinary sheet in that base still writes the target record once', async () => {
    const state = freshState()
    const { internals } = makeService(state)
    const outcome = await internals.writeApprovalResultBack(bridge(), crossBaseConfig(ORDINARY), approvedEvent())
    expect(outcome).toMatchObject({ kind: 'cross-base', target: { targetSheetId: ORDINARY, targetRecordId: TARGET_RECORD } })
    expect(state.updates).toEqual([{ sheetId: ORDINARY, recordId: TARGET_RECORD }])
  })

  it('W-03 the sink refuses on its own: gate stubbed to "authorized", the overview target still gets no UPDATE', async () => {
    const state = freshState()
    const { internals } = makeService(state)
    vi.spyOn(internals.executor, 'evaluateCrossBaseWriteGate').mockResolvedValue({ crossBase: true, ok: true })
    await expect(internals.writeApprovalResultBack(bridge(), crossBaseConfig(OVERVIEW), approvedEvent()))
      .rejects.toThrow(/^STOCK_PREP_OVERVIEW_READ_ONLY: /)
    expect(state.updates).toEqual([])
    expect(state.overviewLookups).toEqual([[OVERVIEW]])
  })

  it('W-04 the same-base leg (never gated): a write-back onto a source record ON the overview writes nothing; an ordinary source still writes', async () => {
    const state = freshState()
    const { internals } = makeService(state)
    const sameBase = { templateId: 'tpl_f2', resultWriteback: { statusField: 'fld_status' } }
    await expect(internals.writeApprovalResultBack(bridge(OVERVIEW), sameBase, approvedEvent()))
      .rejects.toThrow(/^STOCK_PREP_OVERVIEW_READ_ONLY: /)
    expect(state.updates).toEqual([])

    const control = freshState()
    const { internals: internals2 } = makeService(control)
    await expect(internals2.writeApprovalResultBack(bridge(ORDINARY), sameBase, approvedEvent())).resolves.toMatchObject({ kind: 'same-base' })
    expect(control.updates).toEqual([{ sheetId: ORDINARY, recordId: 'rec_f2_source' }])
  })
})

describe('S3 fix round 2 F2 — rule save refuses a result write-back that targets the overview', () => {
  function makeKysely(stored?: Record<string, unknown>) {
    const inserted: unknown[] = []
    const sets: unknown[] = []
    const chain: Record<string, unknown> = {}
    const chainFn = () => chain
    for (const m of ['selectFrom', 'selectAll', 'select', 'where', 'orderBy', 'limit', 'offset', 'groupBy', 'onConflict', 'columns', 'doUpdateSet', 'returningAll', 'leftJoin', 'insertInto', 'updateTable', 'deleteFrom']) {
      chain[m] = vi.fn(chainFn)
    }
    chain.values = vi.fn((row: unknown) => { inserted.push(row); return chain })
    chain.set = vi.fn((row: unknown) => { sets.push(row); return chain })
    chain.execute = vi.fn(async () => [])
    chain.executeTakeFirst = vi.fn(async () => stored)
    return { chain, inserted, sets }
  }
  const startApproval = (targetSheetId: string) => ({
    type: 'start_approval',
    config: {
      templateId: 'tpl_f2',
      formDataMapping: { title: 'fld_title' },
      resultWriteback: { statusField: 'fld_status', targetBaseId: TARGET_BASE, targetSheetId, targetRecordId: TARGET_RECORD },
    },
  })

  it('S-01 createRule: refused with code STOCK_PREP_OVERVIEW_READ_ONLY, no rule row written', async () => {
    const state = freshState()
    const { chain, inserted } = makeKysely()
    const service = new AutomationService(new EventBus(), chain as never, vi.fn(makeHandler(state)) as never)
    const err = await service.createRule(TRIGGER_SHEET, {
      name: 'F2 save',
      triggerType: 'record.created',
      triggerConfig: {},
      actionType: 'start_approval',
      actionConfig: startApproval(OVERVIEW).config,
      actions: [startApproval(OVERVIEW)] as never,
      executionMode: 'workflow_job_v1',
      createdBy: 'u_f2_author',
    } as never).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AutomationRuleValidationError)
    expect(err).toMatchObject({ code: 'STOCK_PREP_OVERVIEW_READ_ONLY', message: STOCK_PREP_OVERVIEW_RESULT_WRITEBACK_SAVE_REFUSAL })
    expect((err as Error).message).not.toContain(OVERVIEW)
    expect(inserted).toEqual([])
  })

  it('S-02 updateRule: an action edit pointing the write-back at the overview is refused the same way, no row updated', async () => {
    const state = freshState()
    const stored = {
      id: 'atr_f2', sheet_id: TRIGGER_SHEET, name: 'F2', trigger_type: 'record.created', trigger_config: {},
      action_type: 'start_approval', action_config: startApproval(ORDINARY).config, enabled: true,
      created_at: '2026-10-09T00:00:00.000Z', updated_at: '2026-10-09T00:00:00.000Z', created_by: 'u_f2_author',
      conditions: null, actions: [startApproval(ORDINARY)], execution_mode: 'workflow_job_v1',
    }
    const { chain, sets } = makeKysely(stored)
    const service = new AutomationService(new EventBus(), chain as never, vi.fn(makeHandler(state)) as never)
    const err = await service.updateRule('atr_f2', TRIGGER_SHEET, {
      actionConfig: startApproval(OVERVIEW).config,
      actions: [startApproval(OVERVIEW)] as never,
    } as never, 'u_f2_author').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AutomationRuleValidationError)
    expect(err).toMatchObject({ code: 'STOCK_PREP_OVERVIEW_READ_ONLY' })
    expect(sets).toEqual([])
  })

  it('S-03 the save check itself: overview → refusal; ordinary derived id → null after one lookup; non-derived ids → null with no statement', async () => {
    const state = freshState()
    const q = vi.fn(makeHandler(state))
    await expect(validateStockPrepOverviewResultWritebackTargets(q, 'start_approval', startApproval(OVERVIEW).config, [])).resolves.toBe(STOCK_PREP_OVERVIEW_RESULT_WRITEBACK_SAVE_REFUSAL)
    // Nested (the collected action list) is read too.
    await expect(validateStockPrepOverviewResultWritebackTargets(q, 'condition_branch', {}, [startApproval(OVERVIEW)] as never)).resolves.toBe(STOCK_PREP_OVERVIEW_RESULT_WRITEBACK_SAVE_REFUSAL)
    await expect(validateStockPrepOverviewResultWritebackTargets(q, 'start_approval', startApproval(ORDINARY).config, [])).resolves.toBeNull()
    expect(state.overviewLookups).toEqual([[OVERVIEW], [OVERVIEW], [ORDINARY]])
    const before = q.mock.calls.length
    await expect(validateStockPrepOverviewResultWritebackTargets(q, 'start_approval', startApproval('sheet_plain').config, [])).resolves.toBeNull()
    await expect(validateStockPrepOverviewResultWritebackTargets(q, 'start_approval', { templateId: 't', resultWriteback: { statusField: 'f' } }, [])).resolves.toBeNull()
    expect(q.mock.calls.length).toBe(before)
  })
})

describe('S3 fix round 2 F7a — the approval-form write-back UPDATE target (from the form schema) cannot be the overview', () => {
  function fwbRule(): AutomationRule {
    return {
      id: 'rule_f7a',
      name: 'F7a',
      sheetId: TRIGGER_SHEET,
      trigger: { type: 'approval.completed', config: { templateId: 'tpl_f7a' } },
      actions: [{
        type: 'write_approval_form_values',
        config: {
          mode: 'update',
          recordLinkFieldId: 'linked_record',
          sourceTemplateVersionId: 'tv_f7a',
          mappings: [{ formFieldId: 'amount', targetFieldId: 'total', targetType: 'text' }],
        },
      } as never],
      enabled: true,
      createdBy: TRIGGER_ACTOR,
      createdAt: '2026-10-09T00:00:00Z',
    } as AutomationRule
  }
  function fwbDeps(state: DbState, derivedSheetId: string): AutomationDeps {
    const base = makeHandler(state)
    const handle = async (sql: unknown, params?: unknown[]) => {
      const s = norm(sql)
      if (/FROM approval_instances i JOIN approval_template_versions v/i.test(s)) {
        state.statements.push(s)
        return {
          rows: [{
            form_snapshot: { linked_record: { recordId: TARGET_RECORD }, amount: '1' },
            form_schema: { fields: [{ id: 'linked_record', type: 'record-link', props: { baseId: TARGET_BASE, sheetId: derivedSheetId } }] },
          }],
          rowCount: 1,
        }
      }
      return base(sql, params)
    }
    return {
      eventBus: new EventBus(),
      queryFn: vi.fn(handle),
      transaction: vi.fn(async (handler) => handler({ query: vi.fn(handle) })),
    } as AutomationDeps
  }
  const trigger = {
    recordId: 'rec_f7a_source',
    actorId: TRIGGER_ACTOR,
    eventId: 'evt_f7a',
    approval: { instanceId: 'ai_f7a', templateId: 'tpl_f7a', templateVersionId: 'tv_f7a' },
    transition: { toStatus: 'approved' },
  }

  it('F-01 a form whose record-link points at the overview → fwb_rejected:stock_prep_overview_read_only, right after the target is derived, no write', async () => {
    process.env.APPROVAL_FWB_WRITEBACK_ENABLED = 'true'
    process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = 'true'
    const state = freshState()
    const exec = await new AutomationExecutor(fwbDeps(state, OVERVIEW)).execute(fwbRule(), trigger)
    expect(exec.steps[0]).toMatchObject({ actionType: 'write_approval_form_values', status: 'failed', error: 'fwb_rejected:stock_prep_overview_read_only' })
    expect(state.updates).toEqual([])
    // The refusal is the statement right after the snapshot read: no gate base read, no record read.
    const snapshotAt = state.statements.findIndex((s) => /FROM approval_instances/i.test(s))
    expect(state.statements[snapshotAt + 1]).toBe(OVERVIEW_SQL)
    expect(state.statements.slice(snapshotAt + 2)).toEqual([])
  })

  it('F-02 control: an ordinary derived target is looked up, not refused by this check (the run goes on to the usual gates)', async () => {
    process.env.APPROVAL_FWB_WRITEBACK_ENABLED = 'true'
    process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = 'true'
    const state = freshState()
    const exec = await new AutomationExecutor(fwbDeps(state, ORDINARY)).execute(fwbRule(), trigger)
    expect(exec.steps[0]?.error).not.toBe('fwb_rejected:stock_prep_overview_read_only')
    expect(state.overviewLookups[0]).toEqual([ORDINARY])
    expect(state.statements.some((s) => /^SELECT base_id FROM meta_sheets/i.test(s))).toBe(true)
  })
})
