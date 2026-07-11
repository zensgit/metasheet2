import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetWeComAppAccessTokenCacheForTests,
  clampWeComByteLengthUtf8,
  clampWeComCharLength,
  fetchWeComAppAccessToken,
  invalidateWeComAppAccessTokenCache,
  readWeComMessageConfigFromEnv,
  resolveWeComMessageConfigReadiness,
  sendWeComTextCardMessage,
  sendWeComTextMessage,
  WeComBusinessError,
  WeComRequestError,
  WECOM_TEXTCARD_DESCRIPTION_MAX_CHARS,
  WECOM_TEXTCARD_TITLE_MAX_CHARS,
  WECOM_TEXT_CONTENT_MAX_BYTES,
} from '../../src/integrations/wecom/client'

describe('WeCom client — app access-token cache (S4 design-lock 20260710, independent of the DingTalk cache)', () => {
  const originalFetch = global.fetch
  const CONFIG = { corpId: 'corp-1', corpSecret: 'secret-1', agentId: '1000002' }

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  const tokenResponse = (token: string, expiresIn?: number) => ({
    ok: true,
    status: 200,
    json: async () => ({ errcode: 0, errmsg: 'ok', access_token: token, ...(expiresIn !== undefined ? { expires_in: expiresIn } : {}) }),
  })

  it('serves the cached token within TTL (one fetch for two calls)', async () => {
    __resetWeComAppAccessTokenCacheForTests()
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse('tok-1', 7200))
    global.fetch = fetchMock as typeof fetch

    expect(await fetchWeComAppAccessToken(CONFIG)).toBe('tok-1')
    expect(await fetchWeComAppAccessToken(CONFIG)).toBe('tok-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=corp-1&corpsecret=secret-1',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('refetches after expiry (TTL = expires_in - 120s margin)', async () => {
    __resetWeComAppAccessTokenCacheForTests()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse('tok-old', 7200))
      .mockResolvedValueOnce(tokenResponse('tok-new', 7200))
    global.fetch = fetchMock as typeof fetch

    expect(await fetchWeComAppAccessToken(CONFIG)).toBe('tok-old')
    // Still within the 120s margin -> cached.
    const withinMargin = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + (7200 - 121) * 1000)
    expect(await fetchWeComAppAccessToken(CONFIG)).toBe('tok-old')
    withinMargin.mockRestore()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Past expiry - margin -> refetch.
    const pastExpiry = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 7200 * 1000)
    try {
      expect(await fetchWeComAppAccessToken(CONFIG)).toBe('tok-new')
    } finally {
      pastExpiry.mockRestore()
    }
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not cross corp ids (cache key = corpid|baseUrl)', async () => {
    __resetWeComAppAccessTokenCacheForTests()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse('tok-a', 7200))
      .mockResolvedValueOnce(tokenResponse('tok-b', 7200))
    global.fetch = fetchMock as typeof fetch

    expect(await fetchWeComAppAccessToken({ corpId: 'corp-a', corpSecret: 's', agentId: '1' })).toBe('tok-a')
    expect(await fetchWeComAppAccessToken({ corpId: 'corp-b', corpSecret: 's', agentId: '1' })).toBe('tok-b')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('never caches failures', async () => {
    __resetWeComAppAccessTokenCacheForTests()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ errcode: 40001, errmsg: 'invalid secret' }) })
      .mockResolvedValueOnce(tokenResponse('tok-2', 7200))
    global.fetch = fetchMock as typeof fetch

    await expect(fetchWeComAppAccessToken(CONFIG)).rejects.toThrow(WeComBusinessError)
    expect(await fetchWeComAppAccessToken(CONFIG)).toBe('tok-2')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('deduplicates concurrent callers into one request', async () => {
    __resetWeComAppAccessTokenCacheForTests()
    let release!: (value: unknown) => void
    const fetchMock = vi.fn().mockReturnValue(new Promise((resolve) => { release = resolve }))
    global.fetch = fetchMock as typeof fetch

    const first = fetchWeComAppAccessToken(CONFIG)
    const second = fetchWeComAppAccessToken(CONFIG)
    release(tokenResponse('tok-shared', 7200))
    expect(await first).toBe('tok-shared')
    expect(await second).toBe('tok-shared')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('invalidate forces the next call to refetch', async () => {
    __resetWeComAppAccessTokenCacheForTests()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse('tok-3', 7200))
      .mockResolvedValueOnce(tokenResponse('tok-4', 7200))
    global.fetch = fetchMock as typeof fetch

    expect(await fetchWeComAppAccessToken(CONFIG)).toBe('tok-3')
    invalidateWeComAppAccessTokenCache(CONFIG)
    expect(await fetchWeComAppAccessToken(CONFIG)).toBe('tok-4')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('WeCom client — send request shape', () => {
  const originalFetch = global.fetch
  const CONFIG = { corpId: 'corp-1', corpSecret: 'secret-1', agentId: '1000002', baseUrl: 'https://qyapi.weixin.qq.com' }

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('sendWeComTextMessage posts touser/agentid(int)/msgtype=text', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ errcode: 0, errmsg: 'ok', msgid: 'msg-1' }),
    })
    global.fetch = fetchMock as typeof fetch

    const result = await sendWeComTextMessage('tok', { userIds: ['u1'], content: 'hello' }, CONFIG)

    expect(fetchMock).toHaveBeenCalledWith(
      'https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=tok',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ touser: 'u1', agentid: 1000002, msgtype: 'text', text: { content: 'hello' } }),
      }),
    )
    expect(result).toMatchObject({ errcode: 0, msgId: 'msg-1', invalidUserIds: [] })
  })

  it('sendWeComTextCardMessage posts touser/agentid(int)/msgtype=textcard', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ errcode: 0, errmsg: 'ok', msgid: 'msg-2' }),
    })
    global.fetch = fetchMock as typeof fetch

    await sendWeComTextCardMessage(
      'tok',
      { userIds: ['u1'], title: 'T', description: 'D', url: 'https://app.example.test/attendance', btnTxt: '打开考勤' },
      CONFIG,
    )

    expect(fetchMock).toHaveBeenCalledWith(
      'https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=tok',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          touser: 'u1',
          agentid: 1000002,
          msgtype: 'textcard',
          textcard: { title: 'T', description: 'D', url: 'https://app.example.test/attendance', btntxt: '打开考勤' },
        }),
      }),
    )
  })

  it('parses invaliduser (|-joined) on an errcode=0 response into invalidUserIds', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ errcode: 0, errmsg: 'ok', invaliduser: 'u1|u2' }),
    })
    global.fetch = fetchMock as typeof fetch

    const result = await sendWeComTextMessage('tok', { userIds: ['u1'], content: 'hello' }, CONFIG)
    expect(result.invalidUserIds).toEqual(['u1', 'u2'])
  })

  it('empty invaliduser -> empty array (not [""])', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ errcode: 0, errmsg: 'ok', invaliduser: '' }),
    })
    global.fetch = fetchMock as typeof fetch

    const result = await sendWeComTextMessage('tok', { userIds: ['u1'], content: 'hello' }, CONFIG)
    expect(result.invalidUserIds).toEqual([])
  })

  it('non-2xx HTTP -> WeComRequestError with status code', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({ errmsg: 'bad gateway' }),
    })
    global.fetch = fetchMock as typeof fetch

    await expect(sendWeComTextMessage('tok', { userIds: ['u1'], content: 'x' }, CONFIG))
      .rejects.toMatchObject({ name: 'WeComRequestError', statusCode: 502 })
  })

  it('errcode!=0 JSON body -> WeComBusinessError carrying the errcode', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ errcode: 45009, errmsg: 'reach max api call' }),
    })
    global.fetch = fetchMock as typeof fetch

    await expect(sendWeComTextMessage('tok', { userIds: ['u1'], content: 'x' }, CONFIG))
      .rejects.toMatchObject({ name: 'WeComBusinessError', errcode: 45009 })
  })

  it('empty userIds hard-fails before any network call', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as typeof fetch
    await expect(sendWeComTextMessage('tok', { userIds: [], content: 'x' }, CONFIG)).rejects.toThrow(/userId/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('empty content hard-fails before any network call', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as typeof fetch
    await expect(sendWeComTextMessage('tok', { userIds: ['u1'], content: '   ' }, CONFIG)).rejects.toThrow(/content/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('missing textcard url hard-fails before any network call', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as typeof fetch
    await expect(sendWeComTextCardMessage('tok', { userIds: ['u1'], title: 'T', description: 'D', url: '', btnTxt: 'X' }, CONFIG))
      .rejects.toThrow(/url/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('WeCom client — field-length clamp helpers (design-lock G4)', () => {
  it('clampWeComCharLength: leaves short strings untouched', () => {
    expect(clampWeComCharLength('short title', WECOM_TEXTCARD_TITLE_MAX_CHARS)).toBe('short title')
  })

  it('clampWeComCharLength: truncates to exactly maxChars characters', () => {
    const long = 'x'.repeat(WECOM_TEXTCARD_TITLE_MAX_CHARS + 50)
    const clamped = clampWeComCharLength(long, WECOM_TEXTCARD_TITLE_MAX_CHARS)
    expect(clamped.length).toBe(WECOM_TEXTCARD_TITLE_MAX_CHARS)
  })

  it('clampWeComCharLength: description clamps to 512 chars', () => {
    const long = 'd'.repeat(1000)
    expect(clampWeComCharLength(long, WECOM_TEXTCARD_DESCRIPTION_MAX_CHARS).length).toBe(WECOM_TEXTCARD_DESCRIPTION_MAX_CHARS)
  })

  it('clampWeComByteLengthUtf8: leaves short ascii strings untouched', () => {
    expect(clampWeComByteLengthUtf8('hello', WECOM_TEXT_CONTENT_MAX_BYTES)).toBe('hello')
  })

  it('clampWeComByteLengthUtf8: clamps multibyte (Chinese) text WITHOUT splitting a codepoint', () => {
    // Each '考' is 3 bytes in UTF-8; 1000 of them = 3000 bytes > 2048. A naive .slice(0, N) by
    // character count would pass a .length check while still overflowing the byte budget — that is
    // exactly the failure mode this test exists to catch.
    const long = '考'.repeat(1000)
    expect(Buffer.byteLength(long, 'utf8')).toBeGreaterThan(WECOM_TEXT_CONTENT_MAX_BYTES)
    const clamped = clampWeComByteLengthUtf8(long, WECOM_TEXT_CONTENT_MAX_BYTES)
    expect(Buffer.byteLength(clamped, 'utf8')).toBeLessThanOrEqual(WECOM_TEXT_CONTENT_MAX_BYTES)
    // No replacement/mangled characters from a mid-codepoint cut — every character in the result is
    // still a clean '考'.
    expect(clamped).toBe('考'.repeat(clamped.length))
    expect(clamped).not.toContain('�')
  })

  it('clampWeComByteLengthUtf8: boundary at exactly maxBytes is untouched', () => {
    const exact = 'a'.repeat(WECOM_TEXT_CONTENT_MAX_BYTES)
    expect(clampWeComByteLengthUtf8(exact, WECOM_TEXT_CONTENT_MAX_BYTES)).toBe(exact)
  })
})

describe('WeCom client — env config readiness (design-lock G2/G7: env-only, synchronous)', () => {
  it('readWeComMessageConfigFromEnv throws a specific message for each missing field', () => {
    expect(() => readWeComMessageConfigFromEnv({} as NodeJS.ProcessEnv)).toThrow(/WECOM_CORP_ID/)
    expect(() => readWeComMessageConfigFromEnv({ WECOM_CORP_ID: 'c' } as NodeJS.ProcessEnv)).toThrow(/WECOM_CORP_SECRET/)
    expect(() => readWeComMessageConfigFromEnv({ WECOM_CORP_ID: 'c', WECOM_CORP_SECRET: 's' } as NodeJS.ProcessEnv)).toThrow(/WECOM_AGENT_ID/)
  })

  it('readWeComMessageConfigFromEnv returns a trimmed config when all three are present', () => {
    const config = readWeComMessageConfigFromEnv({
      WECOM_CORP_ID: '  corp-1  ',
      WECOM_CORP_SECRET: 'secret-1',
      WECOM_AGENT_ID: '1000002',
    } as NodeJS.ProcessEnv)
    expect(config).toEqual({ corpId: 'corp-1', corpSecret: 'secret-1', agentId: '1000002', baseUrl: undefined })
  })

  it('resolveWeComMessageConfigReadiness: ok:false + config:null when anything is missing', () => {
    expect(resolveWeComMessageConfigReadiness({} as NodeJS.ProcessEnv)).toEqual({ ok: false, config: null })
    expect(resolveWeComMessageConfigReadiness({ WECOM_CORP_ID: 'c', WECOM_CORP_SECRET: 's' } as NodeJS.ProcessEnv)).toEqual({ ok: false, config: null })
  })

  it('resolveWeComMessageConfigReadiness: ok:true + config populated when complete', () => {
    const readiness = resolveWeComMessageConfigReadiness({
      WECOM_CORP_ID: 'corp-1',
      WECOM_CORP_SECRET: 'secret-1',
      WECOM_AGENT_ID: '1000002',
    } as NodeJS.ProcessEnv)
    expect(readiness).toEqual({ ok: true, config: { corpId: 'corp-1', corpSecret: 'secret-1', agentId: '1000002', baseUrl: undefined } })
  })
})
