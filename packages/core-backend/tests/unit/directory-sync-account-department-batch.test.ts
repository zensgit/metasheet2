import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildDirectoryAccountDepartmentRows } from '../../src/directory/directory-sync'

/**
 * DT-PERF-01 — (employee × department) is the highest-cardinality write in the sync. A
 * 2,000-employee tenant issued thousands of single-row round trips inside the apply
 * transaction, holding its locks open for the duration. One `unnest` statement replaces
 * them; this pins the semantics the old loop had, so the rewrite cannot drift.
 *
 * `isPrimary` comes from the DT-HARDEN-07 resolver, never from `departmentIds[0]`. Putting the
 * array index back here would silently revert approval routing — the real-DB golden in
 * `tests/integration/directory-primary-department-write.db.test.ts` is what actually catches
 * that, because it drives the writer this builder feeds.
 */
describe('DT-PERF-01 directory account-department batch rows', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const accounts = new Map([
    ['ext-1', { id: 'acct-1' }],
    ['ext-2', { id: 'acct-2' }],
  ])
  const departments = new Map([
    ['d10', 'dept-10'],
    ['d20', 'dept-20'],
  ])

  it('flattens membership into three parallel arrays', () => {
    const rows = buildDirectoryAccountDepartmentRows(
      [{ userId: 'ext-1', departmentIds: ['d10', 'd20'] }],
      accounts,
      departments,
    )
    expect(rows).toEqual({
      accountIds: ['acct-1', 'acct-1'],
      departmentIds: ['dept-10', 'dept-20'],
      isPrimary: [true, false],
      summary: { membershipsWritten: 2, accountsWithPrimary: 1, accountsWithoutKnownDepartment: 0 },
    })
  })

  it('keeps the arrays index-aligned across multiple users', () => {
    const rows = buildDirectoryAccountDepartmentRows(
      [
        { userId: 'ext-1', departmentIds: ['d20'] },
        { userId: 'ext-2', departmentIds: ['d10', 'd20'] },
      ],
      accounts,
      departments,
    )
    expect(rows.accountIds).toEqual(['acct-1', 'acct-2', 'acct-2'])
    expect(rows.departmentIds).toEqual(['dept-20', 'dept-10', 'dept-20'])
    expect(rows.isPrimary).toEqual([true, true, false])
    expect(rows.accountIds).toHaveLength(rows.departmentIds.length)
    expect(rows.accountIds).toHaveLength(rows.isPrimary.length)
  })

  // Flag off: the resolver's fallback IS dept_id_list[0], so this is still the shipped default.
  it('marks exactly the first department of each user primary (order signal off)', () => {
    const rows = buildDirectoryAccountDepartmentRows(
      [{ userId: 'ext-2', departmentIds: ['d20', 'd10'] }],
      accounts,
      departments,
    )
    expect(rows.departmentIds).toEqual(['dept-20', 'dept-10'])
    expect(rows.isPrimary).toEqual([true, false])
    expect(rows.isPrimary.filter(Boolean)).toHaveLength(1)
  })

  it('skips users without a synced account and departments the sync did not see', () => {
    const rows = buildDirectoryAccountDepartmentRows(
      [
        { userId: 'ext-unknown', departmentIds: ['d10'] },
        { userId: 'ext-1', departmentIds: ['d10', 'd-missing'] },
      ],
      accounts,
      departments,
    )
    expect(rows).toEqual({
      accountIds: ['acct-1'],
      departmentIds: ['dept-10'],
      isPrimary: [true],
      summary: { membershipsWritten: 1, accountsWithPrimary: 1, accountsWithoutKnownDepartment: 0 },
    })
  })

  it('collapses a repeated pair to one row (the ON CONFLICT the old loop relied on)', () => {
    const rows = buildDirectoryAccountDepartmentRows(
      [{ userId: 'ext-1', departmentIds: ['d10', 'd10'] }],
      accounts,
      departments,
    )
    expect(rows.accountIds).toEqual(['acct-1'])
    expect(rows.isPrimary).toEqual([true])
  })

  it('produces empty arrays when there is nothing to write (the statement is skipped)', () => {
    expect(buildDirectoryAccountDepartmentRows([], accounts, departments)).toEqual({
      accountIds: [],
      departmentIds: [],
      isPrimary: [],
      summary: { membershipsWritten: 0, accountsWithPrimary: 0, accountsWithoutKnownDepartment: 0 },
    })
  })

  // The anti-revert guard. `departmentIds[0]` is `d20` here; the order signal says `d10`.
  it('takes is_primary from the DT-HARDEN-07 resolver, not from departmentIds[0]', () => {
    vi.stubEnv('DIRECTORY_PRIMARY_DEPT_FROM_ORDER', 'true')
    const rows = buildDirectoryAccountDepartmentRows(
      [{
        userId: 'ext-1',
        departmentIds: ['d20', 'd10'],
        source: { dept_order_list: [{ dept_id: 'd10', order: 1 }, { dept_id: 'd20', order: 9 }] },
      }],
      accounts,
      departments,
    )
    expect(rows.departmentIds).toEqual(['dept-20', 'dept-10'])
    expect(rows.isPrimary).toEqual([false, true]) // d10 is primary, though d20 is first
    expect(rows.summary.accountsWithPrimary).toBe(1)
  })

  it('reports an account whose departments are all unknown to the integration', () => {
    const rows = buildDirectoryAccountDepartmentRows(
      [{ userId: 'ext-1', departmentIds: ['d-missing'] }],
      accounts,
      departments,
    )
    expect(rows.accountIds).toEqual([])
    expect(rows.summary).toEqual({ membershipsWritten: 0, accountsWithPrimary: 0, accountsWithoutKnownDepartment: 1 })
  })
})
