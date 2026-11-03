/**
 * 一个项目一张备料表 — S3 fix round 1 (R4; ADR adr-stock-prep-project-sheets-20261008 §5
 * 「对所有人生效，含管理员」): AUTOMATIONS cannot write the stock-preparation project overview. The record
 * actions write through bare SQL with no person capability in front of them — a same-base create has no gate
 * at all and the cross-base gate checks base write only — so the clamp the capability resolvers apply never
 * saw them. Pinned with the real AutomationExecutor over a mocked query function:
 *
 *   - create / update / delete / lock / form write-back whose target is the overview — same-base (the
 *     trigger sheet IS the overview) and cross-base (`sheetId` / `targetSheetId`) — fail with the typed
 *     values-free STOCK_PREP_OVERVIEW_READ_ONLY step error and NO record mutation;
 *   - the same actions on an ordinary sheet run exactly as before (one mutation each), and issue no
 *     overview lookup at all (the derived-id prefilter);
 *   - a NON-record action (send_notification is not touched; record_click) on the overview's trigger is not
 *     refused by this guard.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AutomationExecutor,
  type AutomationDeps,
  type AutomationRule,
} from '../../src/multitable/automation-executor'
import { EventBus } from '../../src/integration/events/event-bus'

const OVERVIEW = 'sheet_0123456789abcdef01234567'
const PLAIN = 'sheet_plain_r4'
const OVERVIEW_SQL = "SELECT id FROM meta_sheets WHERE id = ANY($1::text[]) AND (to_jsonb(meta_sheets) ->> 'system_kind') = $2"

interface State { recordMutations: number; overviewLookups: unknown[][]; statements: string[] }

function makeDeps(state: State): AutomationDeps {
  const handle = async (sql: unknown, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> => {
    const s = String(sql).replace(/\s+/g, ' ').trim()
    state.statements.push(s)
    if (s === OVERVIEW_SQL) {
      state.overviewLookups.push(params ?? [])
      const ids = ((params ?? [])[0] as string[]) ?? []
      return { rows: ids.filter((id) => id === OVERVIEW).map((id) => ({ id })), rowCount: 0 }
    }
    if (/meta_record_revisions/i.test(s)) return { rows: [], rowCount: 1 }
    if (/UPDATE\s+meta_records|INSERT\s+INTO\s+meta_records|DELETE\s+FROM\s+meta_records/i.test(s)) {
      state.recordMutations += 1
      return { rows: [{ version: 2, data: {} }], rowCount: 1 }
    }
    if (/SELECT[\s\S]*FROM\s+meta_records/i.test(s)) {
      return { rows: [{ locked: false, locked_by: null, created_by: 'user_1', version: 1, data: {} }], rowCount: 1 }
    }
    if (/FROM\s+meta_fields/i.test(s)) return { rows: [], rowCount: 0 }
    return { rows: [], rowCount: 1 }
  }
  return {
    eventBus: new EventBus(),
    queryFn: vi.fn(handle),
    transaction: vi.fn(async (handler) => handler({ query: vi.fn(handle) })),
  }
}

function ruleOn(sheetId: string, action: { type: string; config: Record<string, unknown> }): AutomationRule {
  return {
    id: 'rule_r4',
    name: 'R4 rule',
    sheetId,
    trigger: { type: 'record.created', config: {} },
    actions: [action as never],
    enabled: true,
    createdBy: 'user_1',
    createdAt: '2026-01-01T00:00:00Z',
  } as AutomationRule
}

const fresh = (): State => ({ recordMutations: 0, overviewLookups: [], statements: [] })

afterEach(() => vi.restoreAllMocks())

describe('S3 fix round 1 — automations cannot write the overview (R4)', () => {
  const SAME_BASE_ON_OVERVIEW = [
    { type: 'update_record', config: { fields: { status: 'done' } } },
    { type: 'create_record', config: { data: { title: 'x' } } },
    { type: 'delete_record', config: {} },
    { type: 'lock_record', config: { locked: true } },
    { type: 'write_approval_form_values', config: {} },
  ]
  for (const action of SAME_BASE_ON_OVERVIEW) {
    it(`${action.type} on a rule whose trigger sheet IS the overview → failed STOCK_PREP_OVERVIEW_READ_ONLY, no mutation`, async () => {
      const state = fresh()
      const exec = await new AutomationExecutor(makeDeps(state)).execute(ruleOn(OVERVIEW, action), { recordId: 'rec_1', sheetId: OVERVIEW, actorId: 'user_1', data: {} })
      expect(exec.steps[0]?.status).toBe('failed')
      expect(exec.steps[0]?.error).toMatch(/^STOCK_PREP_OVERVIEW_READ_ONLY: /)
      expect(exec.steps[0]?.error).not.toContain(OVERVIEW)
      expect(state.recordMutations).toBe(0)
      expect(state.overviewLookups).toHaveLength(1)
    })
  }

  const TARGETING_OVERVIEW = [
    { type: 'create_record', config: { sheetId: OVERVIEW, data: { title: 'x' } } },
    { type: 'create_record', config: { sheetId: OVERVIEW, targetBaseId: 'base_other', data: { title: 'x' } } },
    { type: 'update_record', config: { targetBaseId: 'base_other', targetSheetId: OVERVIEW, targetRecordId: 'rec_9', fields: { status: 'done' } } },
    { type: 'delete_record', config: { targetBaseId: 'base_other', targetSheetId: OVERVIEW, targetRecordId: 'rec_9' } },
    { type: 'lock_record', config: { targetBaseId: 'base_other', targetSheetId: OVERVIEW, targetRecordId: 'rec_9', locked: true } },
  ]
  for (const action of TARGETING_OVERVIEW) {
    it(`${action.type} from an ordinary sheet AT the overview (${JSON.stringify(Object.keys(action.config))}) → refused before any write or base lookup`, async () => {
      const state = fresh()
      const exec = await new AutomationExecutor(makeDeps(state)).execute(ruleOn(PLAIN, action), { recordId: 'rec_1', sheetId: PLAIN, actorId: 'user_1', data: {} })
      expect(exec.steps[0]?.status).toBe('failed')
      expect(exec.steps[0]?.error).toMatch(/^STOCK_PREP_OVERVIEW_READ_ONLY: /)
      expect(state.recordMutations).toBe(0)
      // The refusal is the FIRST statement: no base lookup, no field read, no transaction work before it.
      expect(state.statements[0]).toBe(OVERVIEW_SQL)
      expect(state.statements).toHaveLength(1)
    })
  }

  const ORDINARY = [
    { type: 'update_record', config: { fields: { status: 'done' } } },
    { type: 'create_record', config: { sheetId: PLAIN, data: { title: 'x' } } },
    { type: 'delete_record', config: {} },
    { type: 'lock_record', config: { locked: true } },
  ]
  for (const action of ORDINARY) {
    it(`control: ${action.type} on ordinary sheets runs as before (one mutation) and issues NO overview lookup`, async () => {
      const state = fresh()
      const exec = await new AutomationExecutor(makeDeps(state)).execute(ruleOn(PLAIN, action), { recordId: 'rec_1', sheetId: PLAIN, actorId: 'user_1', data: {} })
      expect(exec.steps[0]?.status).toBe('success')
      expect(state.recordMutations).toBe(1)
      expect(state.overviewLookups).toEqual([])
    })
  }

  it('a non-record action (record_click) on the overview trigger is not this guard\'s business', async () => {
    const state = fresh()
    const exec = await new AutomationExecutor(makeDeps(state)).execute(ruleOn(OVERVIEW, { type: 'record_click', config: {} }), { recordId: 'rec_1', sheetId: OVERVIEW, actorId: 'user_1', data: {} })
    expect(exec.steps[0]?.status).toBe('success')
    expect(state.overviewLookups).toEqual([])
  })
})
