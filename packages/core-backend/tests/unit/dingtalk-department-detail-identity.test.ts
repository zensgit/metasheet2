import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DingTalkIncompleteResponseError,
  getDingTalkDepartmentDetail,
  type DingTalkDepartment,
} from '../../src/integrations/dingtalk/client'
import {
  enrichDepartmentsWithManagers,
  mergeDeptManagerIntoRaw,
  resolveManagerListForDept,
} from '../../src/directory/department-manager-enrichment'

const fetchMock = vi.fn()
let result: Record<string, unknown>

beforeEach(() => {
  result = { dept_id: 101, dept_manager_userid_list: ' fresh-a, fresh-b , ' }
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => ({
    ok: true, status: 200, json: async () => ({ errcode: 0, result }),
  }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => vi.unstubAllGlobals())

describe('DingTalk department detail identity', () => {
  it.each([
    { label: 'another department', id: 202 },
    { label: 'object', id: { private: 'PRIVATE_DEPARTMENT' } },
    { label: 'array', id: [101] },
    { label: 'boolean', id: true },
    { label: 'negative number', id: -1 },
    { label: 'fractional number', id: 101.5 },
    { label: 'unsafe integer', id: Number.MAX_SAFE_INTEGER + 1 },
    { label: 'empty string', id: '' },
    { label: 'blank string', id: '  ' },
  ])('rejects $label identity', async ({ id }) => {
    result.dept_id = id

    await expect(getDingTalkDepartmentDetail('synthetic-token', '101')).rejects.toMatchObject({
      name: 'DingTalkIncompleteResponseError',
      message: 'Failed to read DingTalk department detail',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    { label: 'numeric', departmentId: '101', identity: { dept_id: 101 } },
    { label: 'string', departmentId: '101', identity: { dept_id: '101' } },
    { label: 'trimmed string', departmentId: '101', identity: { dept_id: ' 101 ' } },
    { label: 'legacy alias', departmentId: '101', identity: { id: 101 } },
    { label: 'matching aliases', departmentId: '101', identity: { dept_id: 101, id: '101' } },
    { label: 'null secondary alias', departmentId: '101', identity: { dept_id: 101, id: null } },
    { label: 'null primary alias', departmentId: '101', identity: { dept_id: null, id: 101 } },
    { label: 'canonical wire number', departmentId: '00101', identity: { dept_id: 101 } },
    { label: 'omitted', departmentId: '101', identity: {} },
    { label: 'null', departmentId: '101', identity: { dept_id: null } },
    { label: 'zero', departmentId: '0', identity: { dept_id: 0 } },
    { label: 'non-numeric', departmentId: 'department-a', identity: { dept_id: 'department-a' } },
  ])('preserves $label identity and manager normalization', async ({ departmentId, identity }) => {
    result = { ...identity, dept_manager_userid_list: ' fresh-a, fresh-b , ' }

    await expect(getDingTalkDepartmentDetail('synthetic-token', departmentId)).resolves.toEqual({
      deptManagerUserIdList: ['fresh-a', 'fresh-b'],
    })
    const expectedId = Number.isNaN(Number(departmentId)) ? departmentId : Number(departmentId)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ dept_id: expectedId })
  })

  it.each([
    { label: 'conflicting', id: 202 },
    { label: 'object', id: {} },
    { label: 'array', id: [101] },
    { label: 'boolean', id: true },
    { label: 'empty', id: '' },
    { label: 'unsafe', id: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects a $label secondary alias even when the primary matches', async ({ id }) => {
    result = { dept_id: 101, id, dept_manager_userid_list: ['wrong-manager'] }
    await expect(getDingTalkDepartmentDetail('synthetic-token', '101')).rejects.toBeInstanceOf(DingTalkIncompleteResponseError)
  })

  it.each(['Infinity', '-Infinity', '1e309', '-1e309'])('rejects unrepresentable wire identity %s', async (departmentId) => {
    result = { dept_id: String(Number(departmentId)), dept_manager_userid_list: ['wrong-manager'] }
    await expect(getDingTalkDepartmentDetail('synthetic-token', departmentId)).rejects.toBeInstanceOf(DingTalkIncompleteResponseError)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ dept_id: null })
  })

  it('refuses a non-finite request even when the response omits its legacy identity', async () => {
    result = { dept_manager_userid_list: [] }
    await expect(getDingTalkDepartmentDetail('synthetic-token', '1e309')).rejects.toBeInstanceOf(DingTalkIncompleteResponseError)
  })

  it('rejects a conflicting primary identity instead of trusting its alias', async () => {
    result = { dept_id: 202, id: 101, dept_manager_userid_list: ['wrong-manager'] }
    await expect(getDingTalkDepartmentDetail('synthetic-token', '101')).rejects.toBeInstanceOf(DingTalkIncompleteResponseError)
  })

  it.each([
    { label: 'mismatched primary', firstDepartmentId: '101', invalidDetail: { dept_id: 999 } },
    { label: 'conflicting secondary', firstDepartmentId: '101', invalidDetail: { dept_id: 101, id: 999 } },
    { label: 'malformed secondary', firstDepartmentId: '101', invalidDetail: { dept_id: 101, id: {} } },
    { label: 'non-finite wire identity', firstDepartmentId: '1e309', invalidDetail: { dept_id: 'Infinity' } },
  ])('keeps prior managers after a mismatched detail ($label) and continues other departments', async ({ firstDepartmentId, invalidDetail }) => {
    const departments: DingTalkDepartment[] = [firstDepartmentId, '102'].map((id) => ({
      id, parentId: null, name: 'Synthetic department', order: 0, source: { dept_id: id },
    }))
    const onError = vi.fn()
    fetchMock.mockImplementation(async (_input: string, init: RequestInit) => {
      const id = JSON.parse(String(init.body)).dept_id
      return {
        ok: true, status: 200, json: async () => ({
          errcode: 0,
          result: { ...(id === 102 ? { dept_id: 102 } : invalidDetail), dept_manager_userid_list: ['fresh-manager'] },
        }),
      }
    })

    await expect(enrichDepartmentsWithManagers(
      departments, (id) => getDingTalkDepartmentDetail('synthetic-token', id), onError,
    )).resolves.toBeUndefined()
    expect(departments[0].managerUserIds).toBeUndefined()
    expect(mergeDeptManagerIntoRaw(
      departments[0].source, resolveManagerListForDept(departments[0].managerUserIds, ['prior-manager']),
    )).toEqual({ dept_id: firstDepartmentId, dept_manager_userid_list: ['prior-manager'] })
    expect(departments[1].managerUserIds).toEqual(['fresh-manager'])
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(firstDepartmentId, expect.any(DingTalkIncompleteResponseError))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps a matching success-empty authoritative instead of carrying prior managers', async () => {
    result = { dept_id: 101, dept_manager_userid_list: [] }
    const department: DingTalkDepartment = {
      id: '101', parentId: null, name: 'Synthetic department', order: 0, source: {},
    }
    await enrichDepartmentsWithManagers([department], (id) => getDingTalkDepartmentDetail('synthetic-token', id))

    expect(department.managerUserIds).toEqual([])
    expect(resolveManagerListForDept(department.managerUserIds, ['prior-manager'])).toEqual([])
  })

  it('keeps mismatched department and manager values out of the error', async () => {
    result = { dept_id: 'PRIVATE_DEPARTMENT', dept_manager_userid_list: ['PRIVATE_MANAGER'] }
    const error = await getDingTalkDepartmentDetail('synthetic-token', '101').catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(DingTalkIncompleteResponseError)
    expect((error as Error).message).toBe('Failed to read DingTalk department detail')
    expect(JSON.stringify(error)).not.toMatch(/PRIVATE_DEPARTMENT|PRIVATE_MANAGER/)
    expect((error as DingTalkIncompleteResponseError).responseBody).toEqual({})
  })
})
