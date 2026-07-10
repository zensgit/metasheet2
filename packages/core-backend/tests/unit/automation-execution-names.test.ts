/**
 * B3-11 — batched ruleName/sheetName resolution for the automation-execution
 * monitoring list. Pure-function tests against a fake kysely-shaped `db` (no
 * real Postgres): verifies the batching (2 queries max, empty id sets skip
 * their query), and — load-bearing — the honest degrade-to-id fallback when a
 * rule/sheet was DELETED (its id is simply absent from the DB rows) or the
 * execution never had a sheetId at all.
 */
import { describe, it, expect, vi } from 'vitest'
import { executionDisplayNames, resolveExecutionNameMaps } from '../../src/multitable/automation-execution-names'

type FakeRow = { id: string; name: string | null }

/** A minimal fake kysely `db` — only the chain shape resolveExecutionNameMaps calls. */
function makeFakeDb(tableRows: Record<string, FakeRow[]>) {
  const selectFrom = vi.fn((table: string) => {
    const rows = tableRows[table] ?? []
    const where = vi.fn((_col: string, _op: string, ids: string[]) => ({
      execute: vi.fn(async () => rows.filter((r) => ids.includes(r.id))),
    }))
    return { select: vi.fn(() => ({ where })) }
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { selectFrom } as any
}

describe('resolveExecutionNameMaps', () => {
  it('resolves BOTH rule and sheet names in exactly one query per table (batched, not N+1)', async () => {
    const db = makeFakeDb({
      automation_rules: [
        { id: 'rule-1', name: 'Notify Customers' },
        { id: 'rule-2', name: 'Archive Old Records' },
      ],
      sheets: [{ id: 'sheet-a', name: 'Orders' }],
    })
    const maps = await resolveExecutionNameMaps(db, ['rule-1', 'rule-1', 'rule-2'], ['sheet-a', 'sheet-a'])
    // selectFrom called exactly once per table, regardless of how many executions reference it
    expect(db.selectFrom).toHaveBeenCalledTimes(2)
    expect(db.selectFrom).toHaveBeenCalledWith('automation_rules')
    expect(db.selectFrom).toHaveBeenCalledWith('sheets')
    expect(maps.ruleNames.get('rule-1')).toBe('Notify Customers')
    expect(maps.ruleNames.get('rule-2')).toBe('Archive Old Records')
    expect(maps.sheetNames.get('sheet-a')).toBe('Orders')
  })

  it('skips a table query entirely when its id set is empty (e.g. every execution is sheet-less)', async () => {
    const db = makeFakeDb({ automation_rules: [{ id: 'rule-1', name: 'Notify' }], sheets: [] })
    const maps = await resolveExecutionNameMaps(db, ['rule-1'], [null, undefined])
    expect(db.selectFrom).toHaveBeenCalledTimes(1)
    expect(db.selectFrom).toHaveBeenCalledWith('automation_rules')
    expect(maps.sheetNames.size).toBe(0)
  })

  it('a rule with a NULL name (schema allows it) is absent from the map, not mapped to null', async () => {
    const db = makeFakeDb({ automation_rules: [{ id: 'rule-1', name: null }], sheets: [] })
    const maps = await resolveExecutionNameMaps(db, ['rule-1'], [])
    expect(maps.ruleNames.has('rule-1')).toBe(false)
  })

  it('a DELETED rule/sheet (no matching row at all) is absent from the map', async () => {
    const db = makeFakeDb({ automation_rules: [], sheets: [] })
    const maps = await resolveExecutionNameMaps(db, ['rule-deleted'], ['sheet-deleted'])
    expect(maps.ruleNames.has('rule-deleted')).toBe(false)
    expect(maps.sheetNames.has('sheet-deleted')).toBe(false)
  })
})

describe('executionDisplayNames — honest fallback (load-bearing)', () => {
  it('returns the resolved name when present in the map', () => {
    const maps = { ruleNames: new Map([['rule-1', 'Notify Customers']]), sheetNames: new Map([['sheet-a', 'Orders']]) }
    expect(executionDisplayNames('rule-1', 'sheet-a', maps)).toEqual({ ruleName: 'Notify Customers', sheetName: 'Orders' })
  })

  it('DEGRADES to the raw ruleId when the rule was deleted (no throw, no undefined)', () => {
    const maps = { ruleNames: new Map<string, string>(), sheetNames: new Map<string, string>() }
    const { ruleName } = executionDisplayNames('rule-deleted', 'sheet-a', maps)
    expect(ruleName).toBe('rule-deleted')
  })

  it('DEGRADES to the raw sheetId when the sheet was deleted (no throw, no undefined)', () => {
    const maps = { ruleNames: new Map<string, string>(), sheetNames: new Map<string, string>() }
    const { sheetName } = executionDisplayNames('rule-1', 'sheet-deleted', maps)
    expect(sheetName).toBe('sheet-deleted')
  })

  it('sheetName is null (not an id) when the execution never had a sheetId to begin with', () => {
    const maps = { ruleNames: new Map<string, string>(), sheetNames: new Map<string, string>() }
    expect(executionDisplayNames('rule-1', null, maps).sheetName).toBeNull()
    expect(executionDisplayNames('rule-1', undefined, maps).sheetName).toBeNull()
  })
})
