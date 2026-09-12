import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PLMAdapter } from '../../src/data-adapters/PLMAdapter'
import { DataSourceManager } from '../../src/data-adapters/DataSourceManager'
import type { DataSourceConfig } from '../../src/data-adapters/BaseAdapter'

/**
 * #5648 §6 后续单 F02:PLM 适配器的 Bearer 令牌不得写回 `config.connection`。
 *
 * 落库链(为什么 connection 是"公共半边"):
 *   PLMAdapter.connect()            -> 曾把 `Authorization: Bearer …` 写进 this.config.connection.headers
 *   BaseAdapter.getConfig():547-549 -> `{ ...this.config }` 浅拷贝,connection 是同一个对象引用
 *   routes/data-sources.ts:634      -> PUT /api/data-sources/:id 取 existing.getConfig() 作 oldConfig
 *   routes/data-sources.ts:656      -> connection: { ...oldConfig.connection, ...body.connection } 深合并,
 *                                      body 里没有 headers 时旧 headers(含令牌)原样留下
 *   DataSourceManager.configToRecord:395-412 -> config.connection 原样进 record.config,只有 credentials 走加密
 *   persistDataSource:750-780       -> 该 record 明文 upsert 进 data_sources 行
 * 于是"PUT 一次就把进程内令牌落库一次";同一份 connection 还经 sanitizeConfig(只剥 credentials)
 * 进 PUT 响应体与 audit_logs.meta。
 *
 * 本 spec 钉住:令牌只活在实例私有字段上,请求头照旧带 Authorization,x-tenant-id 行为不变。
 * 纯单测:起一个本机 http 服务当上游 PLM,不需要数据库(无库 CI 收得下)。
 */

const FAKE_STATIC_TOKEN = 'fake-static-token-for-tests-0001'
const FAKE_LOGIN_TOKEN = 'fake-login-token-for-tests-0002'

// tests/setup.ts:26 全局把 fetch 换成 vi.fn(),而 yuantus 登录(PLMAdapter.fetchYuantusToken)走的就是
// 全局 fetch。模块求值早于 setup 的 beforeAll,所以这里抓到的还是真 fetch;每个用例里再装回去。
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

interface RecordedRequest {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
}

describe('PLMAdapter Bearer 令牌不落 config.connection(#5648 F02)', () => {
  const savedEnv: Record<string, string | undefined> = {}
  let server: http.Server
  let baseUrl: string
  let requests: RecordedRequest[]
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

  const makeAdapter = (
    settings: Record<string, string | boolean | undefined>,
    connection: Record<string, unknown> = {},
    options: Record<string, unknown> = {},
  ): PLMAdapter => {
    // connect() 的 mock 判定看的是 configService('plm.url')/PLM_BASE_URL(:1065-1067),不是 connection.url,
    // 所以必须给 plm.url 才走真实(非 mock)连接路径。
    const resolved: Record<string, string | boolean | undefined> = { 'plm.url': baseUrl, ...settings }
    const configService = { get: vi.fn(async (key: string) => resolved[key]) }
    const config = {
      id: 'plm-f02',
      name: 'PLM',
      type: 'plm',
      connection: { url: baseUrl, ...connection },
      options,
    } as unknown as DataSourceConfig
    return new PLMAdapter(configService as never, logger as never, config)
  }

  const authHeadersOf = (config: DataSourceConfig): string[] => {
    const headers = (config.connection.headers ?? {}) as Record<string, unknown>
    return Object.keys(headers).filter((key) => key.toLowerCase() === 'authorization')
  }

  beforeEach(async () => {
    for (const key of PLM_ENV_KEYS) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    logger.info.mockClear()
    logger.warn.mockClear()
    vi.stubGlobal('fetch', REAL_FETCH)
    requests = []
    server = http.createServer((req, res) => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers })
      if (req.method === 'POST' && req.url === '/api/v1/auth/login') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ access_token: FAKE_LOGIN_TOKEN }))
        return
      }
      if (req.url === '/health' || req.url === '/api/v1/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok' }))
        return
      }
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ detail: 'not found' }))
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

  it('legacy 模式:认证后 getConfig().connection 里没有 Authorization,也不含令牌串', async () => {
    const adapter = makeAdapter({ 'plm.apiToken': FAKE_STATIC_TOKEN })
    await adapter.connect()

    const config = adapter.getConfig()
    expect(authHeadersOf(config)).toEqual([])
    expect(JSON.stringify(config.connection)).not.toContain(FAKE_STATIC_TOKEN)
  })

  it('legacy 模式:请求仍带 Authorization: Bearer …(不回归认证)', async () => {
    const adapter = makeAdapter({ 'plm.apiToken': FAKE_STATIC_TOKEN })
    await adapter.connect()

    const result = await adapter.query('/health')
    expect(result.error).toBeUndefined()
    const sent = requests.find((r) => r.url === '/health')
    expect(sent?.headers.authorization).toBe(`Bearer ${FAKE_STATIC_TOKEN}`)
  })

  it('legacy 模式:连接里遗留的旧 Authorization 头不得盖掉刚解析出的令牌(落库遗留行的回读)', async () => {
    // 修复前:connect() 在同一个 headers 对象上覆写;修复后:客户端默认头覆写同一个扁平槽位。
    // 两种实现下"配置解析出的令牌"都必须赢过连接里手工/遗留写入的值,否则老行里的过期令牌会顶掉新令牌。
    const adapter = makeAdapter(
      { 'plm.apiToken': FAKE_STATIC_TOKEN },
      { headers: { authorization: 'Bearer stale-token-from-a-persisted-row' } },
    )
    await adapter.connect()

    await adapter.query('/health')
    const sent = requests.find((r) => r.url === '/health')
    expect(sent?.headers.authorization).toBe(`Bearer ${FAKE_STATIC_TOKEN}`)
  })

  it('yuantus 模式:登录拿到的令牌只进请求头,不进 connection;x-tenant-id 行为不变', async () => {
    const adapter = makeAdapter({
      'plm.apiMode': 'yuantus',
      'plm.username': 'plm-test-user',
      'plm.password': 'not-a-real-password',
      'plm.tenantId': 'tenant-a',
    })
    await adapter.connect()

    const login = requests.find((r) => r.url === '/api/v1/auth/login')
    expect(login?.headers['x-tenant-id']).toBe('tenant-a')

    const config = adapter.getConfig()
    expect(authHeadersOf(config)).toEqual([])
    expect(JSON.stringify(config.connection)).not.toContain(FAKE_LOGIN_TOKEN)
    // 租户头仍旧写在 connection.headers 上 —— getEffectiveTenantId 的事实来源,不能被本次改动动到
    expect((config.connection.headers as Record<string, string>)['x-tenant-id']).toBe('tenant-a')
    expect(adapter.getEffectiveTenantId()).toBe('tenant-a')

    await adapter.query('/api/v1/health')
    const sent = requests.find((r) => r.url === '/api/v1/health')
    expect(sent?.headers.authorization).toBe(`Bearer ${FAKE_LOGIN_TOKEN}`)
    expect(sent?.headers['x-tenant-id']).toBe('tenant-a')
  })

  it('手工设置的 x-tenant-id 仍然是服务租户(getEffectiveTenantId 不变)', async () => {
    const adapter = makeAdapter(
      { 'plm.apiToken': FAKE_STATIC_TOKEN, 'plm.tenantId': 'tenant-b' },
      { headers: { 'x-tenant-id': 'tenant-a' } },
    )
    await adapter.connect()

    expect(adapter.getEffectiveTenantId()).toBe('tenant-a')
    await adapter.query('/health')
    const sent = requests.find((r) => r.url === '/health')
    expect(sent?.headers['x-tenant-id']).toBe('tenant-a')
  })

  it('整链:PUT 的深合并 + configToRecord 之后,落库 JSON 里没有令牌', async () => {
    const adapter = makeAdapter({ 'plm.apiToken': FAKE_STATIC_TOKEN, 'plm.tenantId': 'tenant-a' })
    await adapter.connect()

    // routes/data-sources.ts:634 -> oldConfig;:648-660 -> newConfig(connection 深合并,请求体只改名字)
    const oldConfig = adapter.getConfig()
    const body = { name: 'PLM 生产环境' } as Partial<DataSourceConfig>
    const newConfig = {
      ...oldConfig,
      ...body,
      connection: { ...oldConfig.connection, ...body.connection },
      options: { ...oldConfig.options, ...body.options },
      poolConfig: { ...oldConfig.poolConfig, ...body.poolConfig },
      id: oldConfig.id,
    } as DataSourceConfig

    // DataSourceManager.configToRecord:395-412 —— 真函数,connection 原样入库,只有 credentials 加密
    const manager = new DataSourceManager()
    const record = (
      manager as unknown as {
        configToRecord: (
          c: DataSourceConfig,
          ownerId: string,
          workspaceId: string | null,
          tenantId: string | null,
          scopeKind: string,
        ) => { config: unknown }
      }
    ).configToRecord(newConfig, 'owner-1', null, null, 'private')

    expect(JSON.stringify(record.config)).not.toContain(FAKE_STATIC_TOKEN)
    // 租户头照旧落库(它本来就是配置的一部分)
    expect(JSON.stringify(record.config)).toContain('tenant-a')

    // 同一份 connection 还会经 sanitizeConfig(routes/data-sources.ts:321-327,只剥 credentials)
    // 进 PUT 响应体与 audit_logs.meta
    const { credentials: _credentials, ...sanitized } = newConfig
    expect(JSON.stringify(sanitized)).not.toContain(FAKE_STATIC_TOKEN)
  })

  it('连接日志不得回显 URL 里的 userinfo(#5648 F01 相邻点)', async () => {
    const adapter = makeAdapter({
      'plm.apiToken': FAKE_STATIC_TOKEN,
      'plm.url': `http://plm-user:not-a-real-secret@127.0.0.1:${(server.address() as AddressInfo).port}`,
    })
    await adapter.connect()

    const connectLog = logger.info.mock.calls.map((args) => String(args[0])).find((m) => m.includes('connecting to'))
    expect(connectLog).toBeDefined()
    expect(connectLog).not.toContain('not-a-real-secret')
    expect(connectLog).toContain('<redacted>@')
  })
})
