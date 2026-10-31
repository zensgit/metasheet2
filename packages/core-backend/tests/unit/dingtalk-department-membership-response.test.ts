import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/integrations/dingtalk/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/integrations/dingtalk/client')>(),
  fetchDingTalkAppAccessToken: vi.fn().mockResolvedValue('synthetic-token'),
}))

import {
  DingTalkIncompleteResponseError,
  getDingTalkUserDetail,
  listDingTalkDepartmentUsers,
} from '../../src/integrations/dingtalk/client'
import { buildDirectoryAccountDepartmentRows, fetchAllUsers } from '../../src/directory/directory-sync'

let listRow: Record<string, unknown>
let detailRow: Record<string, unknown>

beforeEach(() => {
  listRow = { userid: 'u1', name: 'Synthetic person', dept_id_list: [2] }
  detailRow = { userid: 'u1', name: 'Synthetic person', dept_id_list: [2] }
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
    ok: true,
    status: 200,
    json: async () => ({
      errcode: 0,
      result: input.includes('/user/list?')
        ? { list: [listRow], has_more: false }
        : detailRow,
    }),
  })))
})

afterEach(() => vi.unstubAllGlobals())

const reads = {
  list: async () => (await listDingTalkDepartmentUsers('synthetic-token', '2', 0, 100)).users[0],
  detail: async () => getDingTalkUserDetail('synthetic-token', 'u1'),
}

describe.each(['list', 'detail'] as const)('%s department membership response', (endpoint) => {
  const row = () => endpoint === 'list' ? listRow : detailRow

  it.each([{}, '2', true, 2])('rejects a supplied non-array membership list', async (value) => {
    row().dept_id_list = value
    await expect(reads[endpoint]()).rejects.toBeInstanceOf(DingTalkIncompleteResponseError)
  })

  it.each([
    { label: 'an object', value: {} },
    { label: 'an array', value: [] },
    { label: 'a boolean', value: true },
    { label: 'a negative number', value: -1 },
    { label: 'a fractional number', value: 1.5 },
    { label: 'an unsafe number', value: Number.MAX_SAFE_INTEGER + 1 },
    { label: 'an empty string', value: '' },
    { label: 'a blank string', value: ' ' },
    { label: 'null', value: null },
  ])('rejects $label membership without dropping just that element', async ({ value }) => {
    row().dept_id_list = [2, value]
    await expect(reads[endpoint]()).rejects.toBeInstanceOf(DingTalkIncompleteResponseError)
  })

  it('preserves valid IDs, ordering and well-formed IDs outside the selected department map', async () => {
    row().dept_id_list = [2, ' 3 ', 'outside-scope']
    expect((await reads[endpoint]()).departmentIds).toEqual(['2', '3', 'outside-scope'])
  })

  it('preserves an explicitly empty list', async () => {
    row().dept_id_list = []
    expect((await reads[endpoint]()).departmentIds).toEqual([])
  })

  it.each([undefined, null])('preserves the existing omitted/null fallback', async (value) => {
    row().dept_id_list = value
    expect((await reads[endpoint]()).departmentIds).toEqual(endpoint === 'list' ? ['2'] : [])
  })

  it('keeps malformed membership values out of the thrown error', async () => {
    row().dept_id_list = [{ private: 'PRIVATE_MEMBERSHIP_SENTINEL' }]
    const error = await reads[endpoint]().catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(DingTalkIncompleteResponseError)
    expect(String(error)).not.toContain('PRIVATE_MEMBERSHIP_SENTINEL')
    expect(JSON.stringify(error)).not.toContain('PRIVATE_MEMBERSHIP_SENTINEL')
  })
})

const config = { appKey: 'synthetic-key', appSecret: 'synthetic-secret' } as Parameters<typeof fetchAllUsers>[0]
const departments = () => new Map([
  ['2', { id: '2', parentId: null, name: 'Synthetic department', order: 0, source: {} }],
])

it.each(['list', 'detail'] as const)('real user pull rejects malformed %s membership before returning an apply snapshot', async (endpoint) => {
  const row = endpoint === 'list' ? listRow : detailRow
  row.dept_id_list = [{}, 2]
  await expect(fetchAllUsers(config, departments())).rejects.toBeInstanceOf(DingTalkIncompleteResponseError)
})

it('preserves valid merged membership order and the existing primary-department rows', async () => {
  listRow.dept_id_list = [2, '3']
  detailRow.dept_id_list = ['3', 2]
  const users = await fetchAllUsers(config, departments())
  expect(users.get('u1')?.departmentIds).toEqual(['3', '2'])
  expect(buildDirectoryAccountDepartmentRows(
    users.values(),
    new Map([['u1', { id: 'account-1' }]]),
    new Map([['2', 'department-2'], ['3', 'department-3']]),
  )).toEqual({
    accountIds: ['account-1', 'account-1'],
    departmentIds: ['department-3', 'department-2'],
    isPrimary: [true, false],
    summary: { membershipsWritten: 2, accountsWithPrimary: 1, accountsWithoutKnownDepartment: 0 },
  })
})
