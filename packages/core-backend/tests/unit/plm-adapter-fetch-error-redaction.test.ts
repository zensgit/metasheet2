import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'
import type { DataSourceConfig } from '../../src/data-adapters/BaseAdapter'

/**
 * #5648 F01 ①a(日志/错误面打码),叠在 #5679 上。
 *
 * 泄漏链(为什么 fetch 腿是独立的一条):
 *   PLMAdapter 里有两处绕开 axios 直接用 Node 内置 fetch 的腿 ——
 *     fetchYuantusToken()      -> fetch(`${baseUrl}/api/v1/auth/login`)
 *     yuantusDiscussionFetch() -> fetch(`${baseUrl}${path}`)
 *   当 connection.baseURL / connection.url 形如 `scheme://user:pass@host` 时,fetch 在
 *   **Request 构造阶段**(还没发包)就抛 TypeError,而该 TypeError 的 message 把 URL 原样嵌了进去:
 *     "Request cannot be constructed from a URL that includes credentials: http://u:pw@host/..."
 *     "Failed to parse URL from http://u:pw@host/..."(斜杠形口令走这条,且 cause.input 也带原文)
 *   于是:
 *     - 登录腿:catch 整个吞掉,connect() 打一条「check PLM_USERNAME/PLM_PASSWORD…」的**误导**告警
 *       (请求根本没发出去,凭据压根没被验证),且没有任何可定位信息;
 *     - discussion 腿:`err instanceof Error ? err : …` 把原对象塞进 QueryResult.error 往外带,
 *       明文口令随之离开适配器边界(relay 路由当前不回显 message,但这是消费者的选择,不是适配器的保证)。
 *
 * 本 spec 钉住:两条腿的错误文本一律经 userinfo 打码 + 只留错误类型名;正常 URL 的行为一字不变。
 * 功能问题(fetch 腿根本不支持 userinfo URL)不在本单里,留给 F01 迁移设计裁决。
 *
 * 纯单测:起一个本机 http 服务当上游 PLM(构造阶段就抛的用例连包都不会发),不需要数据库,不需要外网。
 */

// 全部为显式假值:用例断言的是"这些串不得出现在任何错误面上"。
const FAKE_USER = 'plm-fake-user'
const FAKE_PW = 'FAKE-PW-NEVER-REAL-7x9'
const FAKE_PW_SPACED = 'FAKE PW WITH SPACE'
const FAKE_PW_SLASHED = 'FAKE/PW/WITH/SLASH'
const FAKE_LOGIN_TOKEN = 'fake-login-token-for-tests-0002'
const FAKE_SESSION_TOKEN = 'fake-discussion-session-token-0003'
const FAKE_EMBED_TOKEN = 'fake-embed-token-0004'
const FAKE_UPSTREAM_DETAIL = 'fake upstream detail: embed token expired'

// tests/setup.ts:26 全局把 fetch 换成 vi.fn(),而两条腿走的就是全局 fetch。
// 模块求值早于 setup 的 beforeAll,所以这里抓到的还是真 fetch;每个用例里再装回去。
const REAL_FETCH = globalThis.fetch

const PLM_ENV_KEYS = [
  'PLM_BASE_URL',
  'PLM_URL',
  'PLM_API_TOKEN',
  'PLM_AUTH_TOKEN',
  'PLM_TOKEN',
  'PLM_API_KEY',
  'PLM_KEY',
  'PLM_API_MODE',
  'PLM_TENANT_ID',
  'PLM_ORG_ID',
  'PLM_USERNAME',
  'PLM_PASSWORD',
  'PLM_ITEM_TYPE',
]

/**
 * 把一个错误对象的**每一层**(含不可枚举的 message/stack、以及 cause 链)摊平成一个串。
 * 只断言 `error.message` 会漏掉两个真实泄漏面:`cause`(Node 的 "Failed to parse URL" 变体把原
 * TypeError 挂在 cause 上,其 `input` 属性就是原始 URL)和 `stack`(首行复制 message)。
 */
const flattenDeep = (value: unknown, depth = 0): string => {
  if (value === null || value === undefined) return String(value)
  if (typeof value !== 'object') return String(value)
  if (depth > 4) return '[depth]'
  const parts: string[] = []
  for (const key of Object.getOwnPropertyNames(value)) {
    let child: unknown
    try {
      child = (value as Record<string, unknown>)[key]
    } catch {
      continue
    }
    parts.push(key, flattenDeep(child, depth + 1))
  }
  return parts.join('|')
}

describe('PLM fetch 腿的错误文本经 userinfo 打码(#5648 F01 ①a,叠 #5679)', () => {
  const savedEnv: Record<string, string | undefined> = {}
  let server: http.Server
  let baseUrl: string
  let loginStatus: number
  let discussionStatus: number
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

  const makeAdapter = (settings: Record<string, string | boolean | undefined>): PLMAdapter => {
    // connect() 的 mock 判定看 configService('plm.url')(:1076-1078),不是 connection.url;
    // 且 :1080-1084 会把它同时写进 connection.url 与 connection.baseURL —— 两条 fetch 腿读的正是后者。
    const resolved: Record<string, string | boolean | undefined> = { 'plm.url': baseUrl, ...settings }
    const configService = { get: vi.fn(async (key: string) => resolved[key]) }
    const config = {
      id: 'plm-f01a',
      name: 'PLM',
      type: 'plm',
      connection: { url: baseUrl },
      options: {},
    } as unknown as DataSourceConfig
    return new PLMAdapter(configService as never, logger as never, config)
  }

  /** 带 userinfo 的本机 URL —— 形如落库行里真会出现的 `scheme://user:pass@host:port`。 */
  const userinfoUrl = (password: string): string =>
    `http://${FAKE_USER}:${password}@127.0.0.1:${(server.address() as AddressInfo).port}`

  const warnTexts = (): string[] => logger.warn.mock.calls.map((args) => String(args[0]))
  const allLogTexts = (): string =>
    [logger.info, logger.warn, logger.error, logger.debug]
      .flatMap((sink) => sink.mock.calls.map((args) => args.map((a: unknown) => String(a)).join(' ')))
      .join('\n')

  beforeEach(async () => {
    for (const key of PLM_ENV_KEYS) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    logger.info.mockClear()
    logger.warn.mockClear()
    logger.error.mockClear()
    logger.debug.mockClear()
    vi.stubGlobal('fetch', REAL_FETCH)
    loginStatus = 200
    discussionStatus = 200
    server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/v1/auth/login') {
        res.writeHead(loginStatus, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(loginStatus === 200 ? { access_token: FAKE_LOGIN_TOKEN } : { detail: 'invalid credentials' }))
        return
      }
      if (req.method === 'POST' && req.url === '/api/v1/auth/embed/discussion-session') {
        res.writeHead(discussionStatus, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify(
            discussionStatus === 200
              ? { access_token: FAKE_SESSION_TOKEN, token_type: 'bearer', expires_in: 300, aud: 'discussion' }
              : { detail: FAKE_UPSTREAM_DETAIL },
          ),
        )
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    for (const key of PLM_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  // ---------------------------------------------------------------- 登录腿(fetchYuantusToken)

  it('登录腿:URL 带 userinfo 时告警不含口令、不再误导性地指向 PLM_USERNAME/PLM_PASSWORD,并点名错误类型', async () => {
    const adapter = makeAdapter({
      'plm.apiMode': 'yuantus',
      'plm.username': 'plm-test-user',
      'plm.password': 'not-a-real-password',
      'plm.url': userinfoUrl(FAKE_PW),
    })
    await adapter.connect()

    const warns = warnTexts()
    expect(warns.length).toBeGreaterThan(0)
    const joined = warns.join('\n')
    // 1) 明文口令不得出现在告警里
    expect(joined).not.toContain(FAKE_PW)
    // 2) 请求压根没发出去 —— 不得把操作员支使去检查凭据环境变量
    expect(joined).not.toContain('PLM_PASSWORD')
    // 3) 仍要可定位:点名错误类型
    expect(joined).toContain('TypeError')
  })

  it('登录腿:info/warn/error/debug 四个汇里都不出现 URL 口令', async () => {
    const adapter = makeAdapter({
      'plm.apiMode': 'yuantus',
      'plm.username': 'plm-test-user',
      'plm.password': 'not-a-real-password',
      'plm.url': userinfoUrl(FAKE_PW),
    })
    await adapter.connect()

    expect(allLogTexts()).not.toContain(FAKE_PW)
  })

  it('不回归:URL 不带 userinfo 而服务端拒登时,仍打原来那条凭据告警', async () => {
    loginStatus = 401
    const adapter = makeAdapter({
      'plm.apiMode': 'yuantus',
      'plm.username': 'plm-test-user',
      'plm.password': 'not-a-real-password',
    })
    await adapter.connect()

    // 这一支的语义没变:请求确实发出去了、确实被服务端拒了,指向凭据才是对的。
    expect(warnTexts().join('\n')).toContain('PLM_PASSWORD')
  })

  it('不回归:URL 不带 userinfo 时登录照常成功,一条告警都不打', async () => {
    const adapter = makeAdapter({
      'plm.apiMode': 'yuantus',
      'plm.username': 'plm-test-user',
      'plm.password': 'not-a-real-password',
    })
    await adapter.connect()

    expect(warnTexts()).toEqual([])
  })

  // ------------------------------------------------- discussion 腿(yuantusDiscussionFetch)

  it('discussion 腿:QueryResult.error 不含口令,仍带错误类型名', async () => {
    const adapter = makeAdapter({ 'plm.apiMode': 'yuantus', 'plm.url': userinfoUrl(FAKE_PW) })
    await adapter.connect()

    const result = await adapter.exchangeDiscussionSession(FAKE_EMBED_TOKEN)
    expect(result.error).toBeDefined()
    expect(result.error?.message).not.toContain(FAKE_PW)
    expect(result.error?.message).toContain('TypeError')
  })

  it('discussion 腿:错误对象的任何一层(message/stack/cause)都不含口令', async () => {
    const adapter = makeAdapter({ 'plm.apiMode': 'yuantus', 'plm.url': userinfoUrl(FAKE_PW) })
    await adapter.connect()

    const result = await adapter.exchangeDiscussionSession(FAKE_EMBED_TOKEN)
    expect(flattenDeep(result.error)).not.toContain(FAKE_PW)
    // 原错误不得以 cause 形式挂回来:"Failed to parse URL" 变体的 cause 自带原始 URL(input 属性)。
    expect((result.error as { cause?: unknown } | undefined)?.cause).toBeUndefined()
  })

  it('discussion 腿:口令含空格/斜杠(纯 userinfo 正则打不掉的形状)时仍不泄漏', async () => {
    // 为什么不走 plm.url:这两种形状会让 axios 在 connect() 阶段先炸,遮住被测的 fetch 腿。
    // 直接改 connection.baseURL 反而更贴近现实 —— 落库行本来就可能存着这种 URL,而
    // yuantusDiscussionFetch 读的正是 `connection.baseURL || connection.url`。
    for (const password of [FAKE_PW_SPACED, FAKE_PW_SLASHED]) {
      logger.warn.mockClear()
      const adapter = makeAdapter({ 'plm.apiMode': 'yuantus' })
      await adapter.connect()
      // getConfig() 是浅拷贝,connection 与实例内是同一个对象引用(见 #5679 spec 开头的落库链)
      ;(adapter.getConfig().connection as Record<string, unknown>).baseURL = userinfoUrl(password)

      const result = await adapter.exchangeDiscussionSession(FAKE_EMBED_TOKEN)
      expect(result.error, `password shape: ${password}`).toBeDefined()
      expect(flattenDeep(result.error), `password shape: ${password}`).not.toContain(password)
      expect(result.error?.message, `password shape: ${password}`).toContain('TypeError')
    }
  })

  it('不回归:URL 不带 userinfo 时 discussion 腿照常拿到 200 载荷', async () => {
    const adapter = makeAdapter({ 'plm.apiMode': 'yuantus' })
    await adapter.connect()

    const result = await adapter.exchangeDiscussionSession(FAKE_EMBED_TOKEN)
    expect(result.error).toBeUndefined()
    expect(result.data[0]?.access_token).toBe(FAKE_SESSION_TOKEN)
  })

  it('不回归:URL 不带 userinfo 时上游 detail 原样回传(打码只对 URL 形状生效)', async () => {
    discussionStatus = 401
    const adapter = makeAdapter({ 'plm.apiMode': 'yuantus' })
    await adapter.connect()

    const result = await adapter.exchangeDiscussionSession(FAKE_EMBED_TOKEN)
    expect(result.error?.message).toBe(FAKE_UPSTREAM_DETAIL)
    // 上游状态码仍挂在错误上 —— relay 的 providerErrorStatus 靠它把 401 透出去,不能被本次改动动到
    expect((result.error as { response?: { status?: number } }).response?.status).toBe(401)
  })
})
