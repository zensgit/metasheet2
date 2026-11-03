/**
 * SHEET LIVENESS on the TEMPLATE-keyed approval rule loaders (#5780, doable half).
 *
 * `loadEnabledApprovalCompletedRules` / `loadEnabledApprovalTaskCreatedRules` select on
 * trigger_type + enabled + trigger_config.templateId and NOTHING else. The record lane
 * (`loadEnabledRules`) and the scheduled lane both ask `loadSheetLiveness` and suppress on exactly
 * `'deleted'`; these two did not, so a rule attached to a soft-deleted sheet stayed armed on the
 * approval channels: it could still send a webhook / email / DingTalk message, and — only with the
 * default-OFF `APPROVAL_FWB_WRITEBACK_ENABLED` flag AND durable delivery on — still write to a live
 * target sheet via `write_approval_form_values`. Every other record-writing action is save-rejected on
 * these two channels, so in a default deployment an armed dead-sheet rule is an outbound-message bug.
 *
 * What is pinned here:
 *   1. deleted sheet  → the rule is NOT returned, on BOTH channels (the fix).
 *   2. live sheet     → the rule IS still returned, on BOTH channels (the fix is not an outage).
 *   3. mixed batch    → the DECISION is per rule (one call spans many sheets), while the LOOKUP is ONE
 *                       batched round trip carrying the distinct sheet ids — asserted, not assumed,
 *                       because this runs inside a durable consumer's lease.
 *   4. absent sheet   → still returned. `=== 'deleted'`, NOT `!== 'live'` — the same comparison the
 *                       sibling record lane makes. Widening it here would be a second, stricter rule
 *                       that nobody chose.
 *   5. lookup THROWS  → FAIL-OPEN: the rule stays armed and the keep is logged with the rule ids and a
 *                       coded reason. This is a DELIBERATE DIVERGENCE from the sibling lanes, which do
 *                       not catch at all — case 9 pins both sides of it so the difference cannot be
 *                       read as an accident (or silently removed from one side).
 *   6. log volume     → aggregated: one WARN per distinct dead sheet / one per failed call, carrying
 *                       `ruleCount` + a capped id sample; the per-rule line is DEBUG. A 50-rule
 *                       template must not write 50 warn lines per approval event.
 *   7. housekeeping   → the dedup-ledger sweep is still kicked when the filter empties the rule list
 *                       (it used to be reached on every such event, before the filter existed).
 *   8. parity (verdict) → the SAME deleted sheet is refused identically by the sibling record lane AND
 *                       by the scheduled-dispatch lane, so the three lanes share one "live".
 *   9. parity (errors)  → and they deliberately DIFFER on a failed lookup: record lane propagates
 *                       (nothing runs, durable delivery redelivers), approval lane catches and keeps.
 *
 * Zero-DB: the kysely chain is a stub and liveness is answered by a fake queryFn, so the suite runs
 * anywhere. No supertest / app-mode here (CI tripwire #4154).
 */
import pg from 'pg'
import { EventBus } from '../../src/integration/events/event-bus'
import { Logger } from '../../src/core/logger'
import { AutomationService } from '../../src/multitable/automation-service'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const LIVENESS_ONE_SQL = /SELECT\s+deleted_at\s+FROM\s+meta_sheets\s+WHERE\s+id\s*=\s*\$1/i
const LIVENESS_BATCH_SQL = /SELECT\s+id,\s*deleted_at\s+FROM\s+meta_sheets\s+WHERE\s+id\s*=\s*ANY/i

type SheetState = 'live' | 'deleted' | 'absent' | 'throws'
/** One entry per liveness ROUND TRIP: `one` = the per-sheet sibling form, `batch` = the loader form. */
type LivenessCall = { kind: 'one' | 'batch'; ids: string[] }

function ruleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'atr_live',
    sheet_id: 'sheet_live',
    name: 'Rule',
    trigger_type: 'approval.completed',
    trigger_config: { templateId: 'tpl_1' },
    action_type: 'send_notification',
    action_config: { userIds: ['u1'], message: 'x' },
    enabled: true,
    created_at: new Date(),
    updated_at: new Date(),
    created_by: 'u1',
    conditions: null,
    actions: null,
    execution_mode: null,
    ...overrides,
  }
}

/**
 * The db stub returns `rows` for every `.execute()`, so the SAME fixture drives the completed loader,
 * the task_created loader and the sibling record loader — that is what makes the parity cases (8, 9)
 * real rather than three fixtures that happen to agree.
 */
function makeService(rows: Record<string, unknown>[], sheets: Record<string, SheetState>) {
  const livenessCalls: LivenessCall[] = []
  const stateOf = (sheetId: string): SheetState => sheets[sheetId] ?? 'absent'
  const rowFor = (sheetId: string, withId: boolean) => ({
    ...(withId ? { id: sheetId } : {}),
    deleted_at: stateOf(sheetId) === 'deleted' ? new Date('2026-09-01T00:00:00Z') : null,
  })
  const queryFn = vi.fn(async (sqlText: string, params: unknown[]) => {
    if (LIVENESS_ONE_SQL.test(sqlText)) {
      const sheetId = String(params?.[0] ?? '')
      livenessCalls.push({ kind: 'one', ids: [sheetId] })
      // The error text carries connection details on purpose: nothing may echo it into a log.
      if (stateOf(sheetId) === 'throws') throw new Error('connection terminated: host=db.internal user=svc')
      if (stateOf(sheetId) === 'absent') return { rows: [], rowCount: 0 }
      return { rows: [rowFor(sheetId, false)], rowCount: 1 }
    }
    if (LIVENESS_BATCH_SQL.test(sqlText)) {
      const ids = (params?.[0] as string[]) ?? []
      livenessCalls.push({ kind: 'batch', ids: [...ids] })
      if (ids.some((id) => stateOf(id) === 'throws')) {
        throw new Error('connection terminated: host=db.internal user=svc')
      }
      const found = ids.filter((id) => stateOf(id) !== 'absent').map((id) => rowFor(id, true))
      return { rows: found, rowCount: found.length }
    }
    return { rows: [], rowCount: 0 }
  })

  const chain: Record<string, unknown> = {}
  const chainFn = (..._args: unknown[]) => chain
  for (const m of [
    'selectFrom', 'selectAll', 'select', 'where', 'orderBy', 'limit', 'offset',
    'groupBy', 'insertInto', 'values', 'onConflict', 'columns', 'doUpdateSet',
    'updateTable', 'set', 'deleteFrom', 'returningAll', 'leftJoin',
  ]) chain[m] = vi.fn(chainFn)
  chain.execute = vi.fn(async () => rows)
  chain.executeTakeFirst = vi.fn(async () => rows[0])

  const service = new AutomationService(new EventBus(), chain as never, queryFn as never)
  return { service, livenessCalls, queryFn }
}

/** A minimal, in-contract `approval.approved` completion — enough to reach the dispatch body. */
function completionEvent(templateId = 'tpl_1') {
  return {
    version: 1,
    source: 'approval-product',
    eventType: 'approval.approved',
    eventId: 'evt_1',
    occurredAt: new Date().toISOString(),
    approval: { instanceId: 'ai_1', templateId },
    transition: { toStatus: 'approved' },
    requester: { id: 'u1' },
  } as never
}

/**
 * A minimal, in-contract `ApprovalTaskCreatedEventV1` — same envelope shape the real emitter builds
 * (`buildApprovalTaskCreatedEvent` in `services/ApprovalTaskCreatedEvent.ts`), enough to clear the
 * handler's version/source/eventType/templateId gates and reach the dispatch body.
 */
function taskCreatedEvent(templateId = 'tpl_1') {
  return {
    version: 1,
    eventId: 'evt_tc_1',
    eventType: 'approval.task_created',
    occurredAt: new Date().toISOString(),
    source: 'approval-product',
    approval: {
      instanceId: 'ai_1',
      requestNo: null,
      templateId,
      templateVersionId: null,
      publishedDefinitionId: null,
      businessKey: null,
      workflowKey: null,
    },
    task: { nodeKey: 'node_1', entryEpoch: 1, assigneeUserId: 'u1', sourceStep: 0 },
    requester: { id: 'u1' },
  } as never
}

describe('approval rule loaders — sheet liveness (soft delete)', () => {
  let warn: ReturnType<typeof vi.spyOn>
  let debug: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {}) as ReturnType<typeof vi.spyOn>
    debug = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {}) as ReturnType<typeof vi.spyOn>
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** A log line is "about" a rule when the rule id is in the message OR in the structured meta. */
  const mentions = (spy: ReturnType<typeof vi.spyOn>, id: string) =>
    spy.mock.calls.filter((call) => JSON.stringify([call[0], call[1] ?? null]).includes(id))

  it('completed: a rule on a SOFT-DELETED sheet is not returned, and the skip names the rule + reason', async () => {
    const { service, livenessCalls } = makeService(
      [ruleRow({ id: 'atr_dead', sheet_id: 'sheet_dead' })],
      { sheet_dead: 'deleted' },
    )

    const rules = await service.loadEnabledApprovalCompletedRules('tpl_1')

    expect(rules, 'a soft-deleted sheet must contribute NO rules to the approval.completed channel').toEqual([])
    expect(livenessCalls, 'the loader must actually ask about the rule sheet').toEqual([
      { kind: 'batch', ids: ['sheet_dead'] },
    ])
    const [message, meta] = mentions(warn, 'atr_dead')[0] ?? []
    expect(message, 'the skip must be observable and name the channel + sheet').toContain('approval.completed')
    expect(String(message)).toContain('sheet_dead')
    expect(meta).toMatchObject({
      channel: 'approval.completed',
      sheetId: 'sheet_dead',
      reason: 'sheet_deleted',
      ruleCount: 1,
      ruleIds: ['atr_dead'],
    })
  })

  it('task_created: a rule on a SOFT-DELETED sheet is not returned either', async () => {
    const { service } = makeService(
      [ruleRow({ id: 'atr_dead_tc', sheet_id: 'sheet_dead', trigger_type: 'approval.task_created' })],
      { sheet_dead: 'deleted' },
    )

    const rules = await service.loadEnabledApprovalTaskCreatedRules('tpl_1')

    expect(rules, 'a soft-deleted sheet must contribute NO rules to the approval.task_created channel').toEqual([])
    const [message, meta] = mentions(warn, 'atr_dead_tc')[0] ?? []
    expect(String(message)).toContain('approval.task_created')
    expect(meta).toMatchObject({ sheetId: 'sheet_dead', reason: 'sheet_deleted', ruleIds: ['atr_dead_tc'] })
  })

  it('a rule on a LIVE sheet is still returned on both channels (the guard is not an outage)', async () => {
    const completed = makeService([ruleRow({ id: 'atr_ok', sheet_id: 'sheet_live' })], { sheet_live: 'live' })
    expect((await completed.service.loadEnabledApprovalCompletedRules('tpl_1')).map((r) => r.id)).toEqual(['atr_ok'])

    const taskCreated = makeService(
      [ruleRow({ id: 'atr_ok_tc', sheet_id: 'sheet_live', trigger_type: 'approval.task_created' })],
      { sheet_live: 'live' },
    )
    expect((await taskCreated.service.loadEnabledApprovalTaskCreatedRules('tpl_1')).map((r) => r.id)).toEqual(['atr_ok_tc'])

    expect(mentions(warn, 'atr_ok'), 'a live sheet logs nothing').toEqual([])
  })

  it('the DECISION is per rule: one call mixing a live and a deleted sheet keeps only the live one', async () => {
    // These loaders are template-keyed, so a single call spans many sheets — a once-per-call decision
    // would either keep the dead rule or drop the live one. Both failures are covered by this case.
    const { service, livenessCalls } = makeService(
      [
        ruleRow({ id: 'atr_a', sheet_id: 'sheet_dead' }),
        ruleRow({ id: 'atr_b', sheet_id: 'sheet_live' }),
        ruleRow({ id: 'atr_c', sheet_id: 'sheet_dead' }),
      ],
      { sheet_dead: 'deleted', sheet_live: 'live' },
    )

    const rules = await service.loadEnabledApprovalCompletedRules('tpl_1')

    expect(rules.map((r) => r.id)).toEqual(['atr_b'])
    // ARITY, pinned rather than described: ONE round trip, naming each DISTINCT sheet exactly once.
    expect(
      livenessCalls,
      'one batched lookup per call — a per-sheet (or per-rule) loop runs inside a durable lease',
    ).toEqual([{ kind: 'batch', ids: ['sheet_dead', 'sheet_live'] }])
    // Both affected rules are still individually named — at DEBUG, with the WARN aggregated.
    expect(mentions(debug, 'atr_a')).toHaveLength(1)
    expect(mentions(debug, 'atr_c')).toHaveLength(1)
  })

  it('ONE round trip even when a template routes many rules across many distinct sheets', async () => {
    // The cost of an approval event must not scale with the number of distinct sheets: these loaders
    // have no base/tenant predicate (#5780), so that count is deployment-wide for the template.
    const sheets: Record<string, SheetState> = {}
    const rows = Array.from({ length: 12 }, (_unused, i) => {
      sheets[`sheet_${i}`] = i % 2 === 0 ? 'live' : 'deleted'
      return ruleRow({ id: `atr_${i}`, sheet_id: `sheet_${i}` })
    })
    const { service, livenessCalls } = makeService(rows, sheets)

    const rules = await service.loadEnabledApprovalCompletedRules('tpl_1')

    expect(rules.map((r) => r.sheet_id)).toEqual(['sheet_0', 'sheet_2', 'sheet_4', 'sheet_6', 'sheet_8', 'sheet_10'])
    expect(livenessCalls, '12 distinct sheets, ONE query').toHaveLength(1)
    expect(livenessCalls[0].ids).toHaveLength(12)
  })

  it('LOG VOLUME is bounded by the call, not the rule count: 50 rules on one dead sheet warn ONCE', async () => {
    // A failing/deleted sheet must not multiply the log by the template's rule count on every approval
    // event. The aggregate carries the count and a capped id sample; the per-rule line is DEBUG.
    const rows = Array.from({ length: 50 }, (_unused, i) => ruleRow({ id: `atr_n${i}`, sheet_id: 'sheet_dead' }))
    const { service } = makeService(rows, { sheet_dead: 'deleted' })

    expect(await service.loadEnabledApprovalCompletedRules('tpl_1')).toEqual([])

    const warnsAboutSheet = warn.mock.calls.filter((c) => String(c[0]).includes('sheet_dead'))
    expect(warnsAboutSheet, 'one WARN per distinct dead sheet — not one per rule').toHaveLength(1)
    const meta = warnsAboutSheet[0][1] as { ruleCount: number; ruleIds: string[] }
    expect(meta.ruleCount, 'the aggregate carries the exact count').toBe(50)
    expect(meta.ruleIds, 'the id sample is capped, with the remainder counted').toEqual([
      'atr_n0', 'atr_n1', 'atr_n2', 'atr_n3', 'atr_n4', '+45 more',
    ])
    expect(debug.mock.calls.filter((c) => String(c[0]).includes('skipped')), 'per-rule detail survives at DEBUG').toHaveLength(50)
  })

  it("an ABSENT sheet still fires — `=== 'deleted'`, the same comparison the record lane makes", async () => {
    // Deliberately NOT `!== 'live'`. Matching the sibling exactly is the point: a stricter rule here
    // would be a behaviour change nobody asked for, hiding inside a bug fix.
    const { service } = makeService([ruleRow({ id: 'atr_absent', sheet_id: 'sheet_gone' })], {})

    const rules = await service.loadEnabledApprovalCompletedRules('tpl_1')

    expect(rules.map((r) => r.id)).toEqual(['atr_absent'])
    const sibling = makeService([ruleRow({ id: 'atr_absent', sheet_id: 'sheet_gone' })], {})
    expect(
      (await sibling.service.loadEnabledRules('sheet_gone')).map((r) => r.id),
      'the record lane keeps an absent-sheet rule too — the two lanes must agree',
    ).toEqual(['atr_absent'])
  })

  it('FAIL-OPEN: when the liveness lookup THROWS the rules stay armed, and the keep is logged ONCE', async () => {
    // The alternative (swallow and drop) is a silent, deployment-wide outage: fewer rules returned, no
    // error raised, no execution row written, and no dedup claim to drive a redelivery. This assertion
    // IS the decision — inverting the choice in dropRulesOnDeletedSheets must turn this case red.
    const { service } = makeService(
      [
        ruleRow({ id: 'atr_blip', sheet_id: 'sheet_unreadable' }),
        ruleRow({ id: 'atr_blip2', sheet_id: 'sheet_other' }),
      ],
      { sheet_unreadable: 'throws' },
    )

    const rules = await service.loadEnabledApprovalCompletedRules('tpl_1')

    expect(
      rules.map((r) => r.id),
      'a transient liveness failure must not silently disarm the rules',
    ).toEqual(['atr_blip', 'atr_blip2'])
    const failOpenWarns = warn.mock.calls.filter((c) => String((c[1] as { reason?: string })?.reason) === 'liveness_lookup_failed')
    expect(failOpenWarns, 'one failed query, one WARN — even mid-incident with many rules').toHaveLength(1)
    const [message, meta] = failOpenWarns[0]
    expect(message, 'the fail-open keep must be observable, not inferred from absent runs').toContain('failing OPEN')
    expect(meta).toMatchObject({
      channel: 'approval.completed',
      reason: 'liveness_lookup_failed',
      ruleCount: 2,
      ruleIds: ['atr_blip', 'atr_blip2'],
      errorClass: 'Error',
    })
    // VALUES-FREE: the error CLASS is logged, never the error text (it carried connection details here).
    const serialized = JSON.stringify([...warn.mock.calls, ...debug.mock.calls])
    expect(serialized).not.toContain('db.internal')
    expect(serialized).not.toContain('connection terminated')
  })

  it('FAIL-OPEN holds on the task_created channel too', async () => {
    const { service } = makeService(
      [ruleRow({ id: 'atr_blip_tc', sheet_id: 'sheet_unreadable', trigger_type: 'approval.task_created' })],
      { sheet_unreadable: 'throws' },
    )

    const rules = await service.loadEnabledApprovalTaskCreatedRules('tpl_1')

    expect(rules.map((r) => r.id)).toEqual(['atr_blip_tc'])
    expect(mentions(warn, 'atr_blip_tc')[0]?.[1]).toMatchObject({ reason: 'liveness_lookup_failed' })
  })

  it('FAIL-OPEN on a real pg server error: the WARN carries the driver class + SQLSTATE (not "error"), never the text', async () => {
    // node-postgres's DatabaseError sets `name` to the protocol message type 'error', so logging
    // `err.name` made a statement timeout, a permission failure and a connection cap all read the same.
    const { service, queryFn } = makeService([ruleRow({ id: 'atr_pg', sheet_id: 'sheet_live' })], { sheet_live: 'live' })
    const inner = queryFn.getMockImplementation()!
    queryFn.mockImplementation(async (sqlText: string, params: unknown[]) => {
      if (LIVENESS_BATCH_SQL.test(sqlText)) {
        const err = new pg.DatabaseError('permission denied for table meta_sheets: host=db.internal', 80, 'error')
        err.code = '42501'
        throw err
      }
      return inner(sqlText, params)
    })

    const rules = await service.loadEnabledApprovalCompletedRules('tpl_1')

    expect(rules.map((r) => r.id)).toEqual(['atr_pg'])
    const failOpenWarns = warn.mock.calls.filter((c) => String((c[1] as { reason?: string })?.reason) === 'liveness_lookup_failed')
    expect(failOpenWarns).toHaveLength(1)
    expect(failOpenWarns[0][1]).toMatchObject({ errorClass: 'DatabaseError', errorCode: '42501' })
    const serialized = JSON.stringify([...warn.mock.calls, ...debug.mock.calls])
    expect(serialized).not.toContain('db.internal')
    expect(serialized).not.toContain('permission denied')
  })

  it('parity (verdict): the record lane AND the scheduled lane refuse the SAME deleted sheet', async () => {
    const { service } = makeService([ruleRow({ id: 'atr_dead', sheet_id: 'sheet_dead' })], {
      sheet_dead: 'deleted',
      sheet_live: 'live',
    })
    expect(await service.loadEnabledRules('sheet_dead'), 'record lane').toEqual([])

    // SCHEDULED lane: the dispatch callback the scheduler fires on its own clock. Reached directly so
    // this pin does not depend on timers — without it, deleting the scheduler's `=== 'deleted'` check
    // leaves every case in this file green while a cron rule on a dead sheet keeps firing.
    const scheduled = (service as never as { scheduler: { callback: (rule: unknown) => Promise<void> } }).scheduler
    const execute = vi.spyOn(service, 'executeRule').mockResolvedValue({} as never)

    await scheduled.callback({ id: 'sch_dead', sheetId: 'sheet_dead', trigger: { type: 'schedule.cron' }, actions: [] })
    expect(execute, 'scheduled lane: a soft-deleted sheet must not fire').not.toHaveBeenCalled()

    await scheduled.callback({ id: 'sch_live', sheetId: 'sheet_live', trigger: { type: 'schedule.cron' }, actions: [] })
    expect(execute, 'control: a live sheet still fires, so the assertion above is not vacuous').toHaveBeenCalledTimes(1)
  })

  it('parity (errors): the record lane PROPAGATES a failed lookup, the approval lane catches it — a deliberate divergence', async () => {
    // The two lanes agree on the VERDICT and disagree on the ERROR, on purpose. Pinned from BOTH sides:
    // aligning either one silently (making the record lane fail-open, or removing the catch here) turns
    // this case red, so the divergence can only be changed on purpose.
    const recordLane = makeService([ruleRow({ id: 'atr_blip', sheet_id: 'sheet_unreadable' })], {
      sheet_unreadable: 'throws',
    })
    await expect(
      recordLane.service.loadEnabledRules('sheet_unreadable'),
      'record lane: the throw propagates — no rule of that sheet runs, and under durable delivery the handler throw is a retryable adapter_error that redelivers',
    ).rejects.toThrow()

    const approvalLane = makeService([ruleRow({ id: 'atr_blip', sheet_id: 'sheet_unreadable' })], {
      sheet_unreadable: 'throws',
    })
    await expect(
      approvalLane.service.loadEnabledApprovalCompletedRules('tpl_1'),
      'approval lane: caught and kept armed (durable delivery is default OFF here, so a propagated throw would be a lost event on the legacy bus)',
    ).resolves.toHaveLength(1)
  })

  it('housekeeping still runs when the filter empties the rule list', async () => {
    // Before the filter existed, every completion with a matched rule reached the dedup-ledger sweep.
    // A dead-sheet-only template must not quietly stop that sweep: the kick sits ABOVE the empty guard.
    const { service } = makeService([ruleRow({ id: 'atr_dead', sheet_id: 'sheet_dead' })], { sheet_dead: 'deleted' })
    const kick = vi.spyOn(
      service as never as { kickEventDedupLedgerSweepIfDue: (nowMs: number) => void },
      'kickEventDedupLedgerSweepIfDue',
    ).mockImplementation(() => {})

    await service.handleApprovalCompletionTrigger(completionEvent())

    expect(kick, 'the retention sweep must not become conditional on this channel contributing rules').toHaveBeenCalledTimes(1)
  })

  it('housekeeping still runs when the filter empties the rule list — task_created channel too', async () => {
    // Mirrors the completion-channel case above: the same sweep-kick hoist was made on the task_created
    // twin (`handleApprovalTaskCreatedTrigger`), above ITS empty-list return. A dead-sheet-only template
    // must not quietly stop the sweep on this channel either — pinned separately because the two dispatch
    // methods are independent hoists, not one shared code path.
    const { service } = makeService(
      [ruleRow({ id: 'atr_dead_tc', sheet_id: 'sheet_dead', trigger_type: 'approval.task_created' })],
      { sheet_dead: 'deleted' },
    )
    const kick = vi.spyOn(
      service as never as { kickEventDedupLedgerSweepIfDue: (nowMs: number) => void },
      'kickEventDedupLedgerSweepIfDue',
    ).mockImplementation(() => {})

    await service.handleApprovalTaskCreatedTrigger(taskCreatedEvent())

    expect(
      kick,
      'the retention sweep must not become conditional on the task_created channel contributing rules',
    ).toHaveBeenCalledTimes(1)
  })
})
