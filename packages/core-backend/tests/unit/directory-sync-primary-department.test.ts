import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isDirectoryPrimaryDepartmentFromOrderEnabled,
  parseDirectoryDepartmentOrderList,
  resolveDirectoryPrimaryDepartmentId,
} from '../../src/directory/directory-sync'
import { resolveApprovalRequesterOrgRelations } from '../../src/services/ApprovalDirectoryOrg'

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

/**
 * The consumer golden: a requester in TWO departments, each with a different leader.
 * Approval routing must follow the department flagged is_primary — not the other one.
 */
describe('DT-HARDEN-07 multi-department approval routing golden', () => {
  const REQUESTER = 'user-requester'

  function buildQuery(primaryExternalDeptId: string) {
    // Mirrors the SQL shapes ApprovalDirectoryOrg issues, keyed by the primary department.
    return (async (text: string) => {
      if (text.includes('FROM directory_account_links l') && text.includes('ad.is_primary = true')) {
        return {
          rows: [{
            integration_id: 'dir-1',
            account_id: 'acct-requester',
            external_user_id: 'ext-requester',
            raw: {},
            title: 'Engineer',
            primary_external_department_id: primaryExternalDeptId,
            primary_department_raw: { dept_manager_userid_list: [`head-of-${primaryExternalDeptId}`] },
            primary_department_name: `Dept ${primaryExternalDeptId}`,
          }],
        }
      }
      // Candidate leaders inside the requester's primary department.
      if (text.includes('FROM directory_accounts a') && text.includes('d.external_department_id = $2')) {
        return {
          rows: [{
            account_id: `acct-leader-${primaryExternalDeptId}`,
            raw: { leader_in_dept: [{ dept_id: primaryExternalDeptId, leader: true }] },
          }],
        }
      }
      if (text.includes('FROM directory_account_links') && text.includes('directory_account_id = $1::uuid')) {
        return { rows: [{ local_user_id: `manager-of-${primaryExternalDeptId}` }] }
      }
      if (text.includes('JOIN directory_account_links l') && text.includes('a.external_user_id = $2')) {
        return { rows: [{ local_user_id: `depthead-of-${primaryExternalDeptId}` }] }
      }
      return { rows: [] }
    }) as Parameters<typeof resolveApprovalRequesterOrgRelations>[1]
  }

  it('resolves the manager from department 20 when 20 is primary', async () => {
    const relations = await resolveApprovalRequesterOrgRelations(REQUESTER, buildQuery('20'))
    expect(relations.managerId).toBe('manager-of-20')
    expect(relations.deptHeadId).toBe('depthead-of-20')
    expect(relations.primaryDepartmentName).toBe('Dept 20')
  })

  it('resolves a DIFFERENT manager when department 10 is primary — the routing the flag decides', async () => {
    const relations = await resolveApprovalRequesterOrgRelations(REQUESTER, buildQuery('10'))
    expect(relations.managerId).toBe('manager-of-10')
    expect(relations.deptHeadId).toBe('depthead-of-10')
    expect(relations.primaryDepartmentName).toBe('Dept 10')
  })
})
