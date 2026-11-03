import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DingTalkIncompleteResponseError,
  listDingTalkDepartments,
  listDingTalkDepartmentUsers,
} from '../../src/integrations/dingtalk/client'

afterEach(() => vi.unstubAllGlobals())

function reply(result: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ errcode: 0, result }),
  }))
}

describe('DingTalk directory pull response completeness', () => {
  it.each([undefined, null, {}, { list: null }, { list: 'not-a-list' }])(
    'rejects a missing or malformed department list instead of treating it as empty',
    async (result) => {
      reply(result)
      await expect(listDingTalkDepartments('synthetic-token', '1')).rejects.toBeInstanceOf(DingTalkIncompleteResponseError)
    },
  )

  it.each([undefined, null, {}, { list: null }, { list: 'not-a-list' }])(
    'rejects a missing or malformed user list instead of treating it as empty',
    async (result) => {
      reply(result)
      await expect(listDingTalkDepartmentUsers('synthetic-token', '1', 0, 100)).rejects.toBeInstanceOf(DingTalkIncompleteResponseError)
    },
  )

  it.each([null, 'invalid-row', {}, { dept_id: '2' }, { name: 'Synthetic department' }])(
    'rejects an incomplete department row instead of silently dropping it',
    async (row) => {
      reply([{ dept_id: '2', name: 'Synthetic department' }, row])
      await expect(listDingTalkDepartments('synthetic-token', '1')).rejects.toBeInstanceOf(DingTalkIncompleteResponseError)
    },
  )

  it.each([null, 'invalid-row', {}, { userid: 'u1' }, { name: 'Synthetic person' }])(
    'rejects an incomplete user row instead of silently dropping it',
    async (row) => {
      reply({ list: [{ userid: 'u1', name: 'Synthetic person' }, row], has_more: false })
      await expect(listDingTalkDepartmentUsers('synthetic-token', '1', 0, 100)).rejects.toBeInstanceOf(DingTalkIncompleteResponseError)
    },
  )

  it.each([[], { list: [] }])('keeps both documented department empty-list shapes', async (result) => {
    reply(result)
    expect(await listDingTalkDepartments('synthetic-token', '1')).toEqual([])
  })

  it('keeps an explicitly empty final user list', async () => {
    reply({ list: [], has_more: false })
    expect(await listDingTalkDepartmentUsers('synthetic-token', '1', 0, 100)).toEqual({
      users: [], nextCursor: null, hasMore: false,
    })
  })

  it('keeps valid user fields and the enterprise-email fallback', async () => {
    const user = { userid: 'u1', name: 'Synthetic person', org_email: 'synthetic@example.test', dept_id_list: [2] }
    reply({ list: [user], has_more: true, next_cursor: 100 })
    expect(await listDingTalkDepartmentUsers('synthetic-token', '1', 0, 100)).toEqual({
      users: [{
        userId: 'u1', name: 'Synthetic person', unionId: undefined, mobile: undefined,
        email: 'synthetic@example.test', title: undefined, avatarUrl: undefined,
        departmentIds: ['2'], source: user,
      }],
      nextCursor: 100,
      hasMore: true,
    })
  })

  it('does not expose provider row values through the thrown error', async () => {
    reply({ list: [{ userid: 'PRIVATE_PAYLOAD_SENTINEL', name: '' }], has_more: false })
    const error = await listDingTalkDepartmentUsers('synthetic-token', '1', 0, 100).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(DingTalkIncompleteResponseError)
    expect((error as Error).message).not.toContain('PRIVATE_PAYLOAD_SENTINEL')
    expect(JSON.stringify(error)).not.toContain('PRIVATE_PAYLOAD_SENTINEL')
  })
  it.each([undefined, null, 0, 1, 'false', 'true', {}, []])(
    'rejects a missing or non-boolean pagination flag',
    async (hasMore) => {
      reply({ list: [{ userid: 'u1', name: 'Synthetic person' }], has_more: hasMore, next_cursor: 100 })
      await expect(listDingTalkDepartmentUsers('synthetic-token', '1', 0, 100)).rejects.toBeInstanceOf(DingTalkIncompleteResponseError)
    },
  )

  it.each([
    { label: 'object identity', fields: { userid: {} } },
    { label: 'array identity', fields: { userid: [] } },
    { label: 'boolean identity', fields: { userid: true } },
    { label: 'unsafe identity', fields: { userid: Number.MAX_SAFE_INTEGER + 1 } },
    { label: 'fractional identity', fields: { userid: 0.5 } },
    { label: 'object name', fields: { name: {} } },
    { label: 'array name', fields: { name: [] } },
    { label: 'boolean name', fields: { name: true } },
    { label: 'numeric name', fields: { name: 12 } },
  ])('rejects $label in a user row', async ({ fields }) => {
    reply({ list: [{ userid: 'u1', name: 'Synthetic person', ...fields }], has_more: false })
    await expect(listDingTalkDepartmentUsers('synthetic-token', '1', 0, 100)).rejects.toBeInstanceOf(DingTalkIncompleteResponseError)
  })

  it.each([
    { label: 'object identity', fields: { dept_id: {} } },
    { label: 'array identity', fields: { dept_id: [] } },
    { label: 'boolean identity', fields: { dept_id: true } },
    { label: 'unsafe identity', fields: { dept_id: Number.MAX_SAFE_INTEGER + 1 } },
    { label: 'fractional identity', fields: { dept_id: 0.5 } },
    { label: 'object name', fields: { name: {} } },
    { label: 'array name', fields: { name: [] } },
    { label: 'boolean name', fields: { name: true } },
    { label: 'numeric name', fields: { name: 12 } },
  ])('rejects $label in a department row', async ({ fields }) => {
    reply([{ dept_id: 2, parent_id: 1, name: 'Synthetic department', ...fields }])
    await expect(listDingTalkDepartments('synthetic-token', '1')).rejects.toBeInstanceOf(DingTalkIncompleteResponseError)
  })

  it('preserves safe numeric department IDs and trims a valid department name', async () => {
    const entry = { dept_id: 2, parent_id: 1, name: ' Synthetic department ' }
    reply([entry])
    expect(await listDingTalkDepartments('synthetic-token', '1')).toEqual([
      { id: '2', parentId: '1', name: 'Synthetic department', order: 0, source: entry },
    ])
  })

})
