import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDingTalkUserInfoByAuthCode, listDingTalkDepartments } from '../../src/integrations/dingtalk/client'

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

  it('E1: getuserinfo-by-authCode posts {code} to topapi and unwraps result', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        errcode: 0,
        errmsg: 'ok',
        result: { userid: 'emp-1', unionid: 'union-1', sys_level: 1 },
      }),
    })
    global.fetch = fetchMock as typeof fetch

    const info = await getDingTalkUserInfoByAuthCode('token-abc', 'auth-code-xyz')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://oapi.dingtalk.com/topapi/v2/user/getuserinfo?access_token=token-abc',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ code: 'auth-code-xyz' }),
      }),
    )
    expect(info).toMatchObject({ userId: 'emp-1', unionId: 'union-1', sysLevel: 1 })
  })

  it('E1: getuserinfo business errcode surfaces as an error', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ errcode: 40078, errmsg: 'invalid code' }),
    })
    global.fetch = fetchMock as typeof fetch

    await expect(getDingTalkUserInfoByAuthCode('token-abc', 'bad-code')).rejects.toThrow(/Failed to exchange DingTalk container auth code/)
  })

  it('E1: getuserinfo without userid hard-fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ errcode: 0, result: { unionid: 'union-only' } }),
    })
    global.fetch = fetchMock as typeof fetch

    await expect(getDingTalkUserInfoByAuthCode('token-abc', 'code')).rejects.toThrow(/no userid/)
  })
})
