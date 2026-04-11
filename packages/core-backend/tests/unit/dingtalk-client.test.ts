import { afterEach, describe, expect, it, vi } from 'vitest'
import { listDingTalkDepartments } from '../../src/integrations/dingtalk/client'

describe('DingTalk client department parsing', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('parses department/listsub responses when result is an array', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        errcode: 0,
        errmsg: 'ok',
        result: [
          { dept_id: 1068569133, parent_id: 1, name: '产品部' },
          { dept_id: 1068569134, parent_id: 1, name: '技术部' },
        ],
      }),
    })
    global.fetch = fetchMock as typeof fetch

    const departments = await listDingTalkDepartments('token-123', '1')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://oapi.dingtalk.com/topapi/v2/department/listsub?access_token=token-123',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ dept_id: 1 }),
      }),
    )
    expect(departments).toEqual([
      expect.objectContaining({ id: '1068569133', parentId: '1', name: '产品部' }),
      expect.objectContaining({ id: '1068569134', parentId: '1', name: '技术部' }),
    ])
  })

  it('keeps supporting object-wrapped department lists', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        errcode: 0,
        errmsg: 'ok',
        result: {
          list: [
            { dept_id: 2001, parent_id: 1, name: '运营部' },
          ],
        },
      }),
    })
    global.fetch = fetchMock as typeof fetch

    const departments = await listDingTalkDepartments('token-456', '1')

    expect(departments).toEqual([
      expect.objectContaining({ id: '2001', parentId: '1', name: '运营部' }),
    ])
  })
})
