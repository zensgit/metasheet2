import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/integrations/dingtalk/client', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/integrations/dingtalk/client')>(),
  fetchDingTalkAppAccessToken: vi.fn().mockResolvedValue('synthetic-token'),
}))

import { DingTalkIncompleteResponseError, getDingTalkUserDetail } from '../../src/integrations/dingtalk/client'
import { fetchAllUsers } from '../../src/directory/directory-sync'

let detail: Record<string, unknown>

beforeEach(() => {
  detail = { userid: 'u1', name: 'Synthetic person', dept_id_list: [2] }
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: string) => ({
    ok: true,
    status: 200,
    json: async () => ({
      errcode: 0,
      result: input.includes('/user/list?')
        ? { list: [{ userid: 'u1', name: 'Synthetic person', dept_id_list: [2] }], has_more: false }
        : detail,
    }),
  })))
})

afterEach(() => vi.unstubAllGlobals())

describe('directory user detail identity consistency', () => {
  it('rejects another user identity returned by user/get', async () => {
    detail.userid = 'other-user'
    await expect(getDingTalkUserDetail('synthetic-token', 'u1')).rejects.toBeInstanceOf(DingTalkIncompleteResponseError)
  })

  it('rejects the entire real user pull when a detail response belongs to another user', async () => {
    detail.userid = 'other-user'
    const config = { appKey: 'synthetic-key', appSecret: 'synthetic-secret' } as Parameters<typeof fetchAllUsers>[0]
    const departments = new Map([['2', { id: '2', parentId: null, name: 'Synthetic department', order: 0, source: {} }]])

    await expect(fetchAllUsers(config, departments)).rejects.toBeInstanceOf(DingTalkIncompleteResponseError)
    expect(vi.mocked(fetch).mock.calls.map((call) => String(call[0]).split('?')[0].split('/').pop())).toEqual(['list', 'get'])
  })

  it.each([
    { label: 'object identity', fields: { userid: {} } },
    { label: 'array identity', fields: { userid: [] } },
    { label: 'boolean identity', fields: { userid: true } },
    { label: 'unsafe identity', fields: { userid: Number.MAX_SAFE_INTEGER + 1 } },
    { label: 'object name', fields: { name: {} } },
    { label: 'array name', fields: { name: [] } },
    { label: 'boolean name', fields: { name: true } },
    { label: 'numeric name', fields: { name: 12 } },
  ])('rejects $label in user/get', async ({ fields }) => {
    Object.assign(detail, fields)
    await expect(getDingTalkUserDetail('synthetic-token', 'u1')).rejects.toBeInstanceOf(DingTalkIncompleteResponseError)
  })

  it('keeps the requested identity fallback when the detail omits its userid', async () => {
    delete detail.userid
    const user = await getDingTalkUserDetail('synthetic-token', 'u1')
    expect(user.userId).toBe('u1')
    expect(user.departmentIds).toEqual(['2'])
  })

  it('accepts a matching alias identity and preserves email and manager metadata', async () => {
    detail = {
      userId: 'u1', name: ' Synthetic person ', org_email: 'synthetic@example.test',
      dept_id_list: [2], leader_in_dept: [{ dept_id: 2, leader: true }],
    }
    const user = await getDingTalkUserDetail('synthetic-token', 'u1')
    expect({ userId: user.userId, name: user.name, email: user.email, departmentIds: user.departmentIds, source: user.source }).toEqual({
      userId: 'u1', name: 'Synthetic person', email: 'synthetic@example.test',
      departmentIds: ['2'], source: detail,
    })
  })

  it('keeps safe numeric identities when they match the requested user', async () => {
    detail.userid = 7
    expect((await getDingTalkUserDetail('synthetic-token', '7')).userId).toBe('7')
  })

  it('does not expose mismatching identity values in the error', async () => {
    detail.userid = 'PRIVATE_WRONG_ID_SENTINEL'
    const error = await getDingTalkUserDetail('synthetic-token', 'u1').catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(DingTalkIncompleteResponseError)
    expect((error as Error).message).not.toContain('PRIVATE_WRONG_ID_SENTINEL')
    expect(JSON.stringify(error)).not.toContain('PRIVATE_WRONG_ID_SENTINEL')
  })
})
