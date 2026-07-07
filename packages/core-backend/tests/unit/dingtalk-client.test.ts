import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetDingTalkAppAccessTokenCacheForTests,
  fetchDingTalkAppAccessToken,
  getDingTalkUserInfoByAuthCode,
  invalidateDingTalkAppAccessTokenCache,
  listDingTalkDepartments,
} from '../../src/integrations/dingtalk/client'

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

  describe('app access-token cache (design-lock 20260707)', () => {
    const CONFIG = { appKey: 'k1', appSecret: 's1' }
    const tokenResponse = (token: string, expiresIn?: number) => ({
      ok: true,
      status: 200,
      json: async () => ({ errcode: 0, access_token: token, ...(expiresIn !== undefined ? { expires_in: expiresIn } : {}) }),
    })

    it('serves the cached token within TTL (one fetch for two calls)', async () => {
      __resetDingTalkAppAccessTokenCacheForTests()
      const fetchMock = vi.fn().mockResolvedValue(tokenResponse('tok-1', 7200))
      global.fetch = fetchMock as typeof fetch

      expect(await fetchDingTalkAppAccessToken(CONFIG)).toBe('tok-1')
      expect(await fetchDingTalkAppAccessToken(CONFIG)).toBe('tok-1')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('refetches after expiry (tiny expires_in is clamped to the 30s floor, so simulate via invalidate + real expiry math)', async () => {
      __resetDingTalkAppAccessTokenCacheForTests()
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(tokenResponse('tok-old', 7200))
        .mockResolvedValueOnce(tokenResponse('tok-new', 7200))
      global.fetch = fetchMock as typeof fetch

      expect(await fetchDingTalkAppAccessToken(CONFIG)).toBe('tok-old')
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 7200 * 1000)
      try {
        expect(await fetchDingTalkAppAccessToken(CONFIG)).toBe('tok-new')
      } finally {
        nowSpy.mockRestore()
      }
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('does not cross app keys', async () => {
      __resetDingTalkAppAccessTokenCacheForTests()
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(tokenResponse('tok-a', 7200))
        .mockResolvedValueOnce(tokenResponse('tok-b', 7200))
      global.fetch = fetchMock as typeof fetch

      expect(await fetchDingTalkAppAccessToken({ appKey: 'ka', appSecret: 's' })).toBe('tok-a')
      expect(await fetchDingTalkAppAccessToken({ appKey: 'kb', appSecret: 's' })).toBe('tok-b')
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('never caches failures', async () => {
      __resetDingTalkAppAccessTokenCacheForTests()
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ errcode: 40001, errmsg: 'invalid secret' }) })
        .mockResolvedValueOnce(tokenResponse('tok-2', 7200))
      global.fetch = fetchMock as typeof fetch

      await expect(fetchDingTalkAppAccessToken(CONFIG)).rejects.toThrow()
      expect(await fetchDingTalkAppAccessToken(CONFIG)).toBe('tok-2')
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('deduplicates concurrent callers into one request', async () => {
      __resetDingTalkAppAccessTokenCacheForTests()
      let release!: (value: unknown) => void
      const fetchMock = vi.fn().mockReturnValue(new Promise((resolve) => { release = resolve }))
      global.fetch = fetchMock as typeof fetch

      const first = fetchDingTalkAppAccessToken(CONFIG)
      const second = fetchDingTalkAppAccessToken(CONFIG)
      release(tokenResponse('tok-shared', 7200))
      expect(await first).toBe('tok-shared')
      expect(await second).toBe('tok-shared')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('invalidate forces the next call to refetch', async () => {
      __resetDingTalkAppAccessTokenCacheForTests()
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(tokenResponse('tok-3', 7200))
        .mockResolvedValueOnce(tokenResponse('tok-4', 7200))
      global.fetch = fetchMock as typeof fetch

      expect(await fetchDingTalkAppAccessToken(CONFIG)).toBe('tok-3')
      invalidateDingTalkAppAccessTokenCache(CONFIG)
      expect(await fetchDingTalkAppAccessToken(CONFIG)).toBe('tok-4')
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })
  })
})
