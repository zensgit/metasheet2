/**
 * SHEET LIVENESS on the TEMPLATE-keyed approval rule loaders (#5780, doable half).
 *
 * `loadEnabledApprovalCompletedRules` / `loadEnabledApprovalTaskCreatedRules` select on
 * trigger_type + enabled + trigger_config.templateId and NOTHING else. The record lane
 * (`loadEnabledRules`) and the scheduled lane both ask `loadSheetLiveness` and suppress on exactly
 * `'deleted'`; these two did not, so a rule attached to a soft-deleted sheet stayed armed on the
 * approval channels — it could still send a webhook / email / DingTalk message, and could still reach
 * OTHER live sheets through a cross-sheet action.
 *
 * What is pinned here:
 *   1. deleted sheet  → the rule is NOT returned, on BOTH channels (the fix).
 *   2. live sheet     → the rule IS still returned, on BOTH channels (the fix is not an outage).
 *   3. mixed batch    → the question is asked PER RULE, not once per call (one call spans many sheets).
 *   4. absent sheet   → still returned. `=== 'deleted'`, NOT `!== 'live'` — the same comparison the
 *                       sibling record lane makes. Widening it here would be a second, stricter rule
 *                       that nobody chose.
 *   5. lookup THROWS  → FAIL-OPEN: the rule stays armed and the keep is logged with the rule id and a
 *                       coded reason. Fail-closed would turn a transient DB error into a silent,
 *                       deployment-wide outage of every approval automation — no error, no execution
 *                       row, and (because a dropped rule never reaches its per-rule dedup claim) no
 *                       redelivery to repair it.
 *   6. parity         → the same deleted sheet is refused identically by the sibling `loadEnabledRules`,
 *                       so the three lanes cannot drift into three definitions of "live".
 *
 * Zero-DB: the kysely chain is a stub and liveness is answered by a fake queryFn, so the suite runs
 * anywhere. No supertest / app-mode here (CI tripwire #4154).
 */
import { EventBus } from '../../src/integration/events/event-bus'
import { Logger } from '../../src/core/logger'
import { AutomationService } from '../../src/multitable/automation-service'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const LIVENESS_SQL = /SELECT\s+deleted_at\s+FROM\s+meta_sheets\s+WHERE\s+id\s*=\s*\$1/i

type SheetState = 'live' | 'deleted' | 'absent' | 'throws'

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
 * the task_created loader and the sibling record loader — that is what makes the parity case (6) real
 * rather than three fixtures that happen to agree.
 */
function makeService(rows: Record<string, unknown>[], sheets: Record<string, SheetState>) {
  const livenessCalls: string[] = []
  const queryFn = vi.fn(async (sqlText: string, params: unknown[]) => {
    if (!LIVENESS_SQL.test(sqlText)) return { rows: [], rowCount: 0 }
    const sheetId = String(params?.[0] ?? '')
    livenessCalls.push(sheetId)
    const state = sheets[sheetId] ?? 'absent'
    if (state === 'throws') throw new Error('connection terminated: host=db.internal user=svc')
    if (state === 'absent') return { rows: [], rowCount: 0 }
    return {
      rows: [{ deleted_at: state === 'deleted' ? new Date('2026-09-01T00:00:00Z') : null }],
      rowCount: 1,
    }
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

describe('approval rule loaders — sheet liveness (soft delete)', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {}) as ReturnType<typeof vi.spyOn>
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const warnedAbout = (ruleId: string) =>
    warn.mock.calls.filter((call) => String(call[0]).includes(ruleId))

  it('completed: a rule on a SOFT-DELETED sheet is not returned, and the skip names the rule + reason', async () => {
    const { service, livenessCalls } = makeService(
      [ruleRow({ id: 'atr_dead', sheet_id: 'sheet_dead' })],
      { sheet_dead: 'deleted' },
    )

    const rules = await service.loadEnabledApprovalCompletedRules('tpl_1')

    expect(rules, 'a soft-deleted sheet must contribute NO rules to the approval.completed channel').toEqual([])
    expect(livenessCalls, 'the loader must actually ask about the rule sheet').toContain('sheet_dead')
    const [message, meta] = warnedAbout('atr_dead')[0] ?? []
    expect(message, 'the skip must be observable and name the rule').toContain('atr_dead')
    expect(String(message)).toContain('approval.completed')
    expect(meta).toMatchObject({ ruleId: 'atr_dead', sheetId: 'sheet_dead', reason: 'sheet_deleted' })
  })

  it('task_created: a rule on a SOFT-DELETED sheet is not returned either', async () => {
    const { service } = makeService(
      [ruleRow({ id: 'atr_dead_tc', sheet_id: 'sheet_dead', trigger_type: 'approval.task_created' })],
      { sheet_dead: 'deleted' },
    )

    const rules = await service.loadEnabledApprovalTaskCreatedRules('tpl_1')

    expect(rules, 'a soft-deleted sheet must contribute NO rules to the approval.task_created channel').toEqual([])
    const [message, meta] = warnedAbout('atr_dead_tc')[0] ?? []
    expect(String(message)).toContain('approval.task_created')
    expect(meta).toMatchObject({ ruleId: 'atr_dead_tc', sheetId: 'sheet_dead', reason: 'sheet_deleted' })
  })

  it('a rule on a LIVE sheet is still returned on both channels (the guard is not an outage)', async () => {
    const completed = makeService([ruleRow({ id: 'atr_ok', sheet_id: 'sheet_live' })], { sheet_live: 'live' })
    expect((await completed.service.loadEnabledApprovalCompletedRules('tpl_1')).map((r) => r.id)).toEqual(['atr_ok'])

    const taskCreated = makeService(
      [ruleRow({ id: 'atr_ok_tc', sheet_id: 'sheet_live', trigger_type: 'approval.task_created' })],
      { sheet_live: 'live' },
    )
    expect((await taskCreated.service.loadEnabledApprovalTaskCreatedRules('tpl_1')).map((r) => r.id)).toEqual(['atr_ok_tc'])

    expect(warn.mock.calls.filter((c) => String(c[0]).includes('atr_ok')), 'a live sheet logs nothing').toEqual([])
  })

  it('the question is asked PER RULE: one call mixing a live and a deleted sheet keeps only the live one', async () => {
    // These loaders are template-keyed, so a single call spans many sheets — a once-per-call check
    // would either keep the dead rule or drop the live one. Both failures are covered by this case.
    const { service } = makeService(
      [
        ruleRow({ id: 'atr_a', sheet_id: 'sheet_dead' }),
        ruleRow({ id: 'atr_b', sheet_id: 'sheet_live' }),
        ruleRow({ id: 'atr_c', sheet_id: 'sheet_dead' }),
      ],
      { sheet_dead: 'deleted', sheet_live: 'live' },
    )

    const rules = await service.loadEnabledApprovalCompletedRules('tpl_1')

    expect(rules.map((r) => r.id)).toEqual(['atr_b'])
    // Per-rule LOG even though the deleted sheet is looked up once: both affected rules are named.
    expect(warnedAbout('atr_a')).toHaveLength(1)
    expect(warnedAbout('atr_c')).toHaveLength(1)
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

  it('FAIL-OPEN: when the liveness lookup THROWS the rule stays armed, and the keep is logged', async () => {
    // The alternative (fail-closed) is a silent, deployment-wide outage: fewer rules returned, no error
    // raised, no execution row written, and no dedup claim to drive a redelivery. This assertion IS the
    // decision — inverting the choice in dropRulesOnDeletedSheets must turn this case red.
    const { service } = makeService([ruleRow({ id: 'atr_blip', sheet_id: 'sheet_unreadable' })], {
      sheet_unreadable: 'throws',
    })

    const rules = await service.loadEnabledApprovalCompletedRules('tpl_1')

    expect(rules.map((r) => r.id), 'a transient liveness failure must not silently disarm the rule').toEqual(['atr_blip'])
    const [message, meta] = warnedAbout('atr_blip')[0] ?? []
    expect(message, 'the fail-open keep must be observable, not inferred from absent runs').toContain('atr_blip')
    expect(meta).toMatchObject({
      ruleId: 'atr_blip',
      sheetId: 'sheet_unreadable',
      reason: 'liveness_lookup_failed',
      errorClass: 'Error',
    })
    // VALUES-FREE: the error CLASS is logged, never the error text (it carried connection details here).
    const serialized = JSON.stringify({ message, meta })
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
    expect(warnedAbout('atr_blip_tc')[0]?.[1]).toMatchObject({ reason: 'liveness_lookup_failed' })
  })

  it('parity: the sibling record lane refuses the SAME deleted sheet, so the lanes share one definition', async () => {
    const { service } = makeService([ruleRow({ id: 'atr_dead', sheet_id: 'sheet_dead' })], { sheet_dead: 'deleted' })
    expect(await service.loadEnabledRules('sheet_dead')).toEqual([])
  })
})
