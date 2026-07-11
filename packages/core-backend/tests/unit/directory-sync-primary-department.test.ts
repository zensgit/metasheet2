import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isDirectoryPrimaryDepartmentFromOrderEnabled,
  parseDirectoryDepartmentOrderList,
  resolveDirectoryPrimaryDepartmentId,
} from '../../src/directory/directory-sync'

/**
 * DT-HARDEN-07 — the primary department decides approval routing.
 *
 * ApprovalDirectoryOrg anchors `direct_manager` and the whole `continuous_managers`
 * chain on `directory_account_departments.is_primary`. That flag used to be
 * `departmentIds[0]` — wherever DingTalk happened to place the department in
 * `dept_id_list`. A multi-department employee could route up the wrong chain.
 */
describe('DT-HARDEN-07 primary department resolution', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('parseDirectoryDepartmentOrderList', () => {
    it('reads DingTalk dept_order_list entries', () => {
      expect(parseDirectoryDepartmentOrderList({
        dept_order_list: [{ dept_id: 10, order: 5 }, { dept_id: '20', order: 1 }],
      })).toEqual([
        { departmentId: '10', order: 5 },
        { departmentId: '20', order: 1 },
      ])
    })

    it('is total on garbage input', () => {
      expect(parseDirectoryDepartmentOrderList(null)).toEqual([])
      expect(parseDirectoryDepartmentOrderList('nope')).toEqual([])
      expect(parseDirectoryDepartmentOrderList({ dept_order_list: 'nope' })).toEqual([])
      expect(parseDirectoryDepartmentOrderList({ dept_order_list: [{ dept_id: '', order: 1 }, { dept_id: '3' }] })).toEqual([])
    })

    // `Number(null)`, `Number('')`, `Number([])` and `Number(false)` are all 0 — and 0 is the
    // winning order. Coercion here would silently elect a department primary on a malformed
    // entry, re-routing a live approval chain.
    it('drops an entry whose order is not a number, rather than coercing it to 0', () => {
      for (const order of [null, undefined, '', '  ', [], {}, false, true, 'abc', NaN, Infinity]) {
        expect(parseDirectoryDepartmentOrderList({ dept_order_list: [{ dept_id: '10', order }] })).toEqual([])
      }
    })

    it('accepts a numeric string and a zero order', () => {
      expect(parseDirectoryDepartmentOrderList({ dept_order_list: [{ dept_id: '10', order: '3' }] }))
        .toEqual([{ departmentId: '10', order: 3 }])
      expect(parseDirectoryDepartmentOrderList({ dept_order_list: [{ dept_id: '10', order: 0 }] }))
        .toEqual([{ departmentId: '10', order: 0 }])
      expect(parseDirectoryDepartmentOrderList({ dept_order_list: [{ dept_id: '10', order: -1 }] }))
        .toEqual([{ departmentId: '10', order: -1 }])
    })
  })

  describe('default (order signal off — current production behavior preserved)', () => {
    it('is off unless explicitly enabled', () => {
      expect(isDirectoryPrimaryDepartmentFromOrderEnabled()).toBe(false)
      vi.stubEnv('DIRECTORY_PRIMARY_DEPT_FROM_ORDER', 'true')
      expect(isDirectoryPrimaryDepartmentFromOrderEnabled()).toBe(true)
    })

    it('keeps the first department, ignoring dept_order_list', () => {
      expect(resolveDirectoryPrimaryDepartmentId({
        departmentIds: ['10', '20'],
        source: { dept_order_list: [{ dept_id: '20', order: 1 }, { dept_id: '10', order: 9 }] },
      })).toBe('10')
    })
  })

  describe('with DIRECTORY_PRIMARY_DEPT_FROM_ORDER enabled', () => {
    it('picks the lowest-order department', () => {
      vi.stubEnv('DIRECTORY_PRIMARY_DEPT_FROM_ORDER', 'true')
      expect(resolveDirectoryPrimaryDepartmentId({
        departmentIds: ['10', '20'],
        source: { dept_order_list: [{ dept_id: '20', order: 1 }, { dept_id: '10', order: 9 }] },
      })).toBe('20')
    })

    it('ignores departments the user does not belong to', () => {
      vi.stubEnv('DIRECTORY_PRIMARY_DEPT_FROM_ORDER', 'true')
      expect(resolveDirectoryPrimaryDepartmentId({
        departmentIds: ['10', '20'],
        source: { dept_order_list: [{ dept_id: '99', order: 0 }, { dept_id: '10', order: 3 }] },
      })).toBe('10')
    })

    it('breaks ties deterministically by dept_id_list position', () => {
      vi.stubEnv('DIRECTORY_PRIMARY_DEPT_FROM_ORDER', 'true')
      expect(resolveDirectoryPrimaryDepartmentId({
        departmentIds: ['30', '10'],
        source: { dept_order_list: [{ dept_id: '10', order: 1 }, { dept_id: '30', order: 1 }] },
      })).toBe('30')
    })

    it('falls back to the first department when no usable order signal exists', () => {
      vi.stubEnv('DIRECTORY_PRIMARY_DEPT_FROM_ORDER', 'true')
      expect(resolveDirectoryPrimaryDepartmentId({ departmentIds: ['10', '20'], source: {} })).toBe('10')
    })
  })

  it('is a no-op for single-department and department-less users', () => {
    expect(resolveDirectoryPrimaryDepartmentId({ departmentIds: ['7'] })).toBe('7')
    expect(resolveDirectoryPrimaryDepartmentId({ departmentIds: [] })).toBeNull()
  })
})

/*
 * The consumer golden — "a requester in two departments routes to the leader of the primary
 * one" — deliberately does NOT live here.
 *
 * It was written against a mock keyed on the answer (`buildQuery('20')` returned "20 is
 * primary" whatever params it was handed), so it proved only that routing follows whatever
 * the database says. That is a tautology: it stays green no matter what `is_primary` is
 * written as, which is precisely the bug this ticket exists to fix.
 *
 * It now lives in `tests/integration/directory-primary-department-write.db.test.ts`, where
 * `upsertDirectoryAccountDepartments` performs the real write and the real ApprovalDirectoryOrg
 * SQL reads it back — so reverting the write to `departmentIds[0]` turns it red.
 */
