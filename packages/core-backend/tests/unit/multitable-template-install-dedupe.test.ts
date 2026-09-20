/**
 * #5861 —— POST /templates/:templateId/install 的安装去重(路由级 + 模块级)。
 *
 * 真实事故(客户反馈 2026-09-18 第 5 条):「使用模板」看起来无响应,用户反复点;服务端零去重,
 * 同一个模板被实例化 4 次,「可访问的 Base」里出现 4 个同名 Base(222 只读核对)。
 *
 * 路由级矩阵:
 *   D1 窗口内重复安装 → 只建**一个** Base,第二次原样重放第一次的 201(核心断言)。
 *   D2 两个并发请求 → 只建一个 Base;恰好一边是重放。互斥来自路由发出的
 *      `pg_advisory_xact_lock`(下面的 fake 真的实现了这把锁,把那条语句删掉本用例就红)。
 *   D3 窗口过后 → 真的再建一个(去重是窗口,不是永久封印)。
 *   D4 第一个 Base 被删掉之后再装 → 新建,不会把客户端重放到一个已不存在的 Base。
 *   D5 换个人装同一个模板 → 各建各的,谁也重放不到谁的(用户边界)。
 *   D6 换个租户装同一个模板 → 各建各的(租户边界,来源是 req.authenticatedTenantId)。
 *   D7 `x-tenant-id` 兼容头**不**参与作用域:带头与不带头落在同一个桶里,
 *      既不会被请求头切出一个新桶、也不会窜进真租户的桶(本仓历史上的跨租户洞就出在这个头上)。
 *   D8 换个 baseName → 各建各的(不用等窗口过期的逃生口)。
 *   D9 账本表未迁移(42P01)→ fail-open:照常 201 安装,只是不去重。
 *   D10 账本行的租户列被改坏(模拟 sha256 碰撞)→ 逐列核对拦下,不重放。
 *
 * 模块级矩阵(runDeduplicatedTemplateInstall 直调):
 *   D11 install() 抛错 → 账本一个字都没写(失败后重试是真的重试)。
 *   D12 语句顺序:咨询锁是事务里的**第一条**语句,排在读账本之前。
 *
 * Harness 沿用 multitable-template-dryrun-routes.test.ts 的 mock-pool 路由 precedent:
 * 真 express + 真 univerMetaRouter,poolManager.get() 打桩成内存 store —— 不需要真库。
 * 服务器按 usePinnedServer() 起,断言一律走 request(pinned.url())(tests/unit 里
 * `request(app)` 是 CI 零容忍,#4154)。
 *
 * 关于「fake 背书」:fake 里的 pg_advisory_xact_lock 是一把**真的**按 key 互斥、事务结束才
 * 释放的锁。它证明的是「路由确实在读账本之前、在同一个事务里、按同一个指纹取了这把锁」——
 * 把路由里那条语句删掉,D2 立刻变成两个 Base。它不证明 PG 自己的锁好使(那是 PG 的事)。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'

import {
  TemplateInstallLedgerUnavailableError,
  buildTemplateInstallScopeDigest,
  runDeduplicatedTemplateInstall,
} from '../../src/multitable/template-install-dedupe'
import { usePinnedServer } from '../utils/pinned-server'

type QueryResult = { rows: any[]; rowCount?: number }

const TEMPLATE_ID = 'project-tracker'
const ACTOR = 'user_5861'

type StoreOptions = {
  /** true → 账本表报 42P01(未迁移)。 */
  ledgerMissing?: boolean
  /**
   * true → 第一条 `INSERT INTO meta_bases` 停在闸口上,直到测试调用 releaseInstall()。
   * D2 用它把并发窗口撑开:没有这个闸口,两个 supertest 请求很可能一前一后跑完,
   * 于是「删掉咨询锁」的变异体也能绿 —— 那样的并发用例什么都没证明。
   */
  barrierOnFirstBaseInsert?: boolean
}

type TxContext = { releases: Array<() => void> }

/**
 * 覆盖安装 SQL 面 + 去重账本 + 咨询锁的内存 store。
 *
 * 时钟由 store 自己持有(`advanceClock`),因为窗口判定在 SQL 里写的是 `now()` ——
 * fake 必须自己算这个 now。
 */
function createStore(opts: StoreOptions = {}) {
  const bases: Array<Record<string, unknown>> = []
  const sheets: Array<Record<string, unknown>> = []
  const fields: Array<Record<string, unknown>> = []
  const views: Array<Record<string, unknown>> = []
  const ledger = new Map<string, Record<string, unknown>>()
  const sqlLog: string[] = []
  let clock = 1_700_000_000_000

  let releaseInstall: () => void = () => {}
  const installBarrier = new Promise<void>((resolve) => { releaseInstall = resolve })
  let barrierArmed = opts.barrierOnFirstBaseInsert === true
  let barrierReached = false

  // ── 咨询锁:按 key 的 FIFO 互斥,事务结束才释放 ──────────────────────────
  const lockChains = new Map<string, Promise<void>>()
  const acquireLock = async (key: string, tx: TxContext | null): Promise<void> => {
    if (!tx) throw new Error('pg_advisory_xact_lock issued outside a transaction')
    const prev = lockChains.get(key) ?? Promise.resolve()
    let release!: () => void
    const mine = new Promise<void>((resolve) => { release = resolve })
    lockChains.set(key, prev.then(() => mine))
    await prev
    tx.releases.push(release)
  }

  const undefinedTable = (table: string): never => {
    const err = new Error(`relation "${table}" does not exist`) as Error & { code?: string }
    err.code = '42P01'
    throw err
  }

  const handler = async (sql: string, params: unknown[] = [], tx: TxContext | null = null): Promise<QueryResult> => {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    sqlLog.push(normalized)

    if (normalized.includes('pg_advisory_xact_lock')) {
      await acquireLock(String(params[0]), tx)
      return { rows: [{}] }
    }

    // ── 去重账本 ────────────────────────────────────────────────────────
    if (normalized.includes('meta_multitable_template_installs')) {
      if (opts.ledgerMissing) undefinedTable('meta_multitable_template_installs')

      if (normalized.startsWith('INSERT INTO meta_multitable_template_installs')) {
        const [digest, tenantId, actorId, templateId, workspaceId, baseId, response] =
          params as [string, string | null, string, string, string | null, string, string]
        ledger.set(digest, {
          scope_digest: digest,
          tenant_id: tenantId,
          actor_id: actorId,
          template_id: templateId,
          workspace_id: workspaceId,
          base_id: baseId,
          response: JSON.parse(response),
          installed_at: clock,
        })
        return { rows: [], rowCount: 1 }
      }
      if (normalized.startsWith('DELETE') && normalized.includes('WHERE scope_digest = $1')) {
        const [digest] = params as [string]
        return { rows: [], rowCount: ledger.delete(digest) ? 1 : 0 }
      }
      if (normalized.startsWith('DELETE') && normalized.includes('installed_at <')) {
        const [windowMs] = params as [number]
        let removed = 0
        for (const [digest, row] of ledger) {
          if ((row.installed_at as number) < clock - windowMs) { ledger.delete(digest); removed++ }
        }
        return { rows: [], rowCount: removed }
      }
      if (normalized.startsWith('SELECT')) {
        // 窗口过滤由**被测 SQL 自己**决定要不要生效:fake 只在语句里真的写了
        // `installed_at >` 时才照做。把窗口条件从 SQL 里删掉,D3 就会红。
        const [digest, windowMs] = params as [string, number]
        const row = ledger.get(digest)
        if (!row) return { rows: [] }
        if (normalized.includes('installed_at >') && (row.installed_at as number) <= clock - windowMs) {
          return { rows: [] }
        }
        return { rows: [row] }
      }
      throw new Error(`Unhandled ledger SQL in test: ${normalized}`)
    }

    // ── 安装 SQL 面 ─────────────────────────────────────────────────────
    if (normalized.startsWith('SELECT') && normalized.includes('FROM meta_bases') && normalized.includes('WHERE id = $1')) {
      const [id] = params as [string]
      return { rows: bases.filter((base) => base.id === id) }
    }
    if (normalized.startsWith('INSERT INTO meta_bases')) {
      if (barrierArmed) {
        barrierArmed = false
        barrierReached = true
        await installBarrier
      }
      const [id, name, icon, color, ownerId, workspaceId] = params as [string, string, string, string, string | null, string | null]
      if (bases.some((base) => base.id === id)) return { rows: [], rowCount: 0 }
      const base = { id, name, icon, color, owner_id: ownerId, workspace_id: workspaceId }
      bases.push(base)
      return { rows: [base], rowCount: 1 }
    }

    if (normalized.startsWith('SELECT') && normalized.includes('FROM meta_sheets') && normalized.includes('WHERE id = $1')) {
      const [id] = params as [string]
      return { rows: sheets.filter((sheet) => sheet.id === id) }
    }
    if (normalized.startsWith('INSERT INTO meta_sheets')) {
      const [id, baseId, name, description] = params as [string, string, string, string | null]
      if (sheets.some((sheet) => sheet.id === id)) return { rows: [], rowCount: 0 }
      sheets.push({ id, base_id: baseId, name, description })
      return { rows: [], rowCount: 1 }
    }

    if (normalized.startsWith('INSERT INTO meta_fields')) {
      const [id, sheetId, name, type, propertyJson, order] = params as [string, string, string, string, string, number]
      fields.push({ id, sheet_id: sheetId, name, type, property: JSON.parse(propertyJson), order })
      return { rows: [], rowCount: 1 }
    }
    if (normalized.includes('FROM meta_fields') && normalized.includes('WHERE id = $1 AND sheet_id = $2')) {
      const [fieldId, ownerSheetId] = params as [string, string]
      return { rows: fields.filter((field) => field.id === fieldId && field.sheet_id === ownerSheetId) }
    }
    if (normalized.includes('FROM meta_fields') && normalized.includes('id = ANY($2::text[])')) {
      const [sheetId, ids] = params as [string, string[]]
      const idSet = new Set(ids)
      return {
        rows: fields
          .filter((field) => field.sheet_id === sheetId && idSet.has(field.id as string))
          .sort((a, b) => (a.order as number) - (b.order as number)),
      }
    }

    if (normalized.startsWith('SELECT') && normalized.includes('FROM meta_views') && normalized.includes('WHERE id = $1')) {
      const [id] = params as [string]
      return { rows: views.filter((view) => view.id === id) }
    }
    if (normalized.startsWith('INSERT INTO meta_views')) {
      const [id, sheetId, name, type, filterInfoJson, sortInfoJson, groupInfoJson, hiddenFieldIdsJson, configJson] = params as [
        string, string, string, string, string, string, string, string, string,
      ]
      if (views.some((view) => view.id === id)) return { rows: [], rowCount: 0 }
      views.push({
        id,
        sheet_id: sheetId,
        name,
        type,
        filter_info: JSON.parse(filterInfoJson),
        sort_info: JSON.parse(sortInfoJson),
        group_info: JSON.parse(groupInfoJson),
        hidden_field_ids: JSON.parse(hiddenFieldIdsJson),
        config: JSON.parse(configJson),
      })
      return { rows: [], rowCount: 1 }
    }

    throw new Error(`Unhandled SQL in test: ${normalized}`)
  }

  return {
    bases,
    sheets,
    fields,
    views,
    ledger,
    sqlLog,
    handler,
    advanceClock: (ms: number) => { clock += ms },
    releaseInstall: () => releaseInstall(),
    barrierReached: () => barrierReached,
    deleteBase: (baseId: string) => {
      const index = bases.findIndex((base) => base.id === baseId)
      if (index >= 0) bases.splice(index, 1)
    },
  }
}

function createMockPool(handler: (sql: string, params: unknown[], tx: TxContext | null) => Promise<QueryResult>) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => handler(sql, params ?? [], null))
  // 进入过几个事务 —— D2 用它判定「第二个请求已经进到事务里了」,而不是睡一个固定的毫秒数。
  // 有锁时第二个请求卡在锁上、无锁时它径直往下读账本,两种情况下这个计数都会到 2,
  // 所以这个等待在变异体上也不会挂死。
  let started = 0
  const transaction = vi.fn(async (fn: (client: { query: any }) => Promise<unknown>) => {
    started++
    const tx: TxContext = { releases: [] }
    const txQuery = vi.fn(async (sql: string, params?: unknown[]) => handler(sql, params ?? [], tx))
    try {
      return await fn({ query: txQuery })
    } finally {
      // 事务级咨询锁在 commit/rollback 时由 PG 释放 —— fake 照做。
      for (const release of tx.releases) release()
      tx.releases.length = 0
    }
  })
  return { query, transaction, transactionsStarted: () => started }
}

type AppIdentity = { userId?: string; authenticatedTenantId?: string | null }

async function createApp(
  handler: (sql: string, params: unknown[], tx: TxContext | null) => Promise<QueryResult>,
  identity: AppIdentity = {},
) {
  const perms = ['multitable:read', 'multitable:write']
  vi.resetModules()
  vi.doMock('../../src/rbac/service', () => ({
    isAdmin: vi.fn().mockResolvedValue(false),
    userHasPermission: vi.fn().mockResolvedValue(false),
    listUserPermissions: vi.fn().mockResolvedValue(perms),
    invalidateUserPerms: vi.fn(),
    getPermCacheStatus: vi.fn(),
  }))

  const { poolManager } = await import('../../src/integration/db/connection-pool')
  const { univerMetaRouter } = await import('../../src/routes/univer-meta')
  const mockPool = createMockPool(handler)
  vi.spyOn(poolManager, 'get').mockReturnValue(mockPool as any)

  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    // rbacGuard 读 user.permissions;安装路由的 resolveRequestAccess 读 user.perms。
    req.user = { id: identity.userId ?? ACTOR, roles: [], permissions: perms, perms } as Express.Request['user']
    // 只有 JWT 校验会挂这个字段 —— 测试里显式模拟它,x-tenant-id 兼容头永远碰不到它。
    if (identity.authenticatedTenantId) req.authenticatedTenantId = identity.authenticatedTenantId
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  return { app, mockPool }
}

const pinned = usePinnedServer()

/** 轮询等待一个条件成立(替代固定 sleep —— 固定 sleep 在变异体上要么假绿要么假红)。 */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function install(body: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const req = request(pinned.url()).post(`/api/multitable/templates/${TEMPLATE_ID}/install`)
  for (const [name, value] of Object.entries(headers)) req.set(name, value)
  return req.send(body)
}

describe('#5861 — POST /templates/:templateId/install 安装去重', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('D1: 窗口内重复安装只建一个 Base,第二次原样重放第一次的 201', async () => {
    const store = createStore()
    const { app } = await createApp(store.handler)
    pinned.setApp(app)

    const first = await install({ baseName: 'bom备料 Base' })
    expect(first.status).toBe(201)
    expect(first.headers['idempotent-replayed']).toBeUndefined()

    store.advanceClock(45_000)
    const second = await install({ baseName: 'bom备料 Base' })

    expect(second.status).toBe(201)
    expect(second.headers['idempotent-replayed']).toBe('true')
    expect(second.body).toEqual(first.body)
    // 事故指标本身:建出来的 Base / 表各只有一个。
    expect(store.bases).toHaveLength(1)
    expect(store.sheets).toHaveLength(1)
    expect(store.bases[0].name).toBe('bom备料 Base')
  })

  it('D2: 两个并发请求 → 只建一个 Base,恰好一边是重放(互斥来自咨询锁)', async () => {
    // 闸口把并发窗口撑开:第一个请求停在 `INSERT INTO meta_bases` 上,第二个请求这时才进场。
    // 有锁 → 第二个卡在锁上,等第一个的事务结束后读到账本 → 重放,一个 Base。
    // 无锁 → 第二个径直读到空账本,自己也装一遍 → 两个 Base(这就是变异探针要红的那一下)。
    const store = createStore({ barrierOnFirstBaseInsert: true })
    const { app, mockPool } = await createApp(store.handler)
    pinned.setApp(app)

    // `.then(...)` 不是装饰:supertest 的 Test 是**惰性**的,不碰 then 就一个字节都不发。
    const first = install({ baseName: 'Concurrent Base' }).then((res) => res)
    await waitFor(() => store.barrierReached())

    const second = install({ baseName: 'Concurrent Base' }).then((res) => res)
    await waitFor(() => mockPool.transactionsStarted() >= 2)

    store.releaseInstall()
    const [left, right] = await Promise.all([first, second])

    expect(left.status).toBe(201)
    expect(right.status).toBe(201)
    expect(left.body).toEqual(right.body)
    expect(store.bases).toHaveLength(1)
    expect(store.sheets).toHaveLength(1)
    const replayed = [left, right].filter((res) => res.headers['idempotent-replayed'] === 'true')
    expect(replayed).toHaveLength(1)
  })

  it('D3: 窗口过后再装 → 真的再建一个', async () => {
    const store = createStore()
    const { app } = await createApp(store.handler)
    pinned.setApp(app)

    expect((await install({ baseName: 'Later Base' })).status).toBe(201)
    store.advanceClock(300_001)
    const later = await install({ baseName: 'Later Base' })

    expect(later.status).toBe(201)
    expect(later.headers['idempotent-replayed']).toBeUndefined()
    expect(store.bases).toHaveLength(2)
  })

  it('D4: 第一个 Base 被删掉之后再装 → 新建,不重放到已不存在的 Base', async () => {
    const store = createStore()
    const { app } = await createApp(store.handler)
    pinned.setApp(app)

    const first = await install({ baseName: 'Deleted Base' })
    expect(first.status).toBe(201)
    const firstBaseId = first.body.data.base.id as string
    store.deleteBase(firstBaseId)

    const again = await install({ baseName: 'Deleted Base' })

    expect(again.status).toBe(201)
    expect(again.headers['idempotent-replayed']).toBeUndefined()
    expect(again.body.data.base.id).not.toBe(firstBaseId)
    expect(store.bases).toHaveLength(1)
  })

  it('D5: 另一个用户装同一个模板 → 各建各的,重放不到别人的 Base', async () => {
    const store = createStore()
    const mine = await createApp(store.handler, { userId: ACTOR })
    pinned.setApp(mine.app)
    const first = await install({ baseName: 'Shared Name' })
    expect(first.status).toBe(201)

    const theirs = await createApp(store.handler, { userId: 'user_other' })
    pinned.setApp(theirs.app)
    const second = await install({ baseName: 'Shared Name' })

    expect(second.status).toBe(201)
    expect(second.headers['idempotent-replayed']).toBeUndefined()
    expect(second.body.data.base.id).not.toBe(first.body.data.base.id)
    expect(store.bases).toHaveLength(2)
    expect(store.ledger.size).toBe(2)
  })

  it('D6: 另一个租户装同一个模板 → 各建各的(作用域来自 authenticatedTenantId)', async () => {
    const store = createStore()
    const tenantA = await createApp(store.handler, { authenticatedTenantId: 'tenant_a' })
    pinned.setApp(tenantA.app)
    const first = await install({ baseName: 'Shared Name' })
    expect(first.status).toBe(201)

    const tenantB = await createApp(store.handler, { authenticatedTenantId: 'tenant_b' })
    pinned.setApp(tenantB.app)
    const second = await install({ baseName: 'Shared Name' })

    expect(second.status).toBe(201)
    expect(second.headers['idempotent-replayed']).toBeUndefined()
    expect(second.body.data.base.id).not.toBe(first.body.data.base.id)
    expect(store.bases).toHaveLength(2)
    const tenants = [...store.ledger.values()].map((row) => row.tenant_id).sort()
    expect(tenants).toEqual(['tenant_a', 'tenant_b'])
  })

  it('D7: x-tenant-id 兼容头不参与作用域 —— 既不另开一个桶,也窜不进真租户的桶', async () => {
    const store = createStore()
    // 无租户声明的部署:req.authenticatedTenantId 不存在,作用域租户恒为 null。
    const { app } = await createApp(store.handler)
    pinned.setApp(app)

    const first = await install({ baseName: 'Header Base' })
    expect(first.status).toBe(201)

    // 同一个人、同一个模板、同一个名字,只是多带了一个 x-tenant-id 头。
    const withHeader = await install({ baseName: 'Header Base' }, { 'x-tenant-id': 'tenant_a' })

    expect(withHeader.status).toBe(201)
    expect(withHeader.headers['idempotent-replayed']).toBe('true')
    expect(withHeader.body).toEqual(first.body)
    expect(store.bases).toHaveLength(1)
    // 账本里只有 null 租户那一行 —— 请求头没能把任何东西写成 tenant_a。
    expect([...store.ledger.values()].map((row) => row.tenant_id)).toEqual([null])
  })

  it('D8: 换一个 baseName → 各建各的(不必等窗口过期的逃生口)', async () => {
    const store = createStore()
    const { app } = await createApp(store.handler)
    pinned.setApp(app)

    expect((await install({ baseName: 'First Copy' })).status).toBe(201)
    const second = await install({ baseName: 'Second Copy' })

    expect(second.status).toBe(201)
    expect(second.headers['idempotent-replayed']).toBeUndefined()
    expect(store.bases).toHaveLength(2)
  })

  it('D9: 账本表未迁移(42P01)→ fail-open,照常安装(只是不去重)', async () => {
    const store = createStore({ ledgerMissing: true })
    const { app } = await createApp(store.handler)
    pinned.setApp(app)

    const first = await install({ baseName: 'Unmigrated Base' })
    expect(first.status).toBe(201)
    expect(first.body.ok).toBe(true)
    // 缺表既不能变成 503,也不能变成 500。
    const second = await install({ baseName: 'Unmigrated Base' })
    expect(second.status).toBe(201)
    expect(store.bases).toHaveLength(2)
    expect(store.ledger.size).toBe(0)
  })

  it('D10: 账本行的租户列对不上(模拟指纹碰撞)→ 逐列核对拦下,不重放', async () => {
    const store = createStore()
    const { app } = await createApp(store.handler)
    pinned.setApp(app)

    const first = await install({ baseName: 'Collision Base' })
    expect(first.status).toBe(201)
    // 指纹不变,但行里的租户被改成别人的 —— 只信指纹的实现会把别人的 Base 重放给我。
    for (const row of store.ledger.values()) row.tenant_id = 'tenant_somebody_else'

    const second = await install({ baseName: 'Collision Base' })

    expect(second.status).toBe(201)
    expect(second.headers['idempotent-replayed']).toBeUndefined()
    expect(second.body.data.base.id).not.toBe(first.body.data.base.id)
    expect(store.bases).toHaveLength(2)
  })
})

describe('#5861 — runDeduplicatedTemplateInstall(模块级)', () => {
  const scope = {
    tenantId: null,
    actorId: ACTOR,
    templateId: TEMPLATE_ID,
    workspaceId: null,
    baseName: 'Module Base',
  }

  it('D11: install() 抛错 → 账本一个字都没写(失败后重试是真的重试)', async () => {
    const statements: string[] = []
    const query = vi.fn(async (sql: string) => {
      statements.push(sql.replace(/\s+/g, ' ').trim())
      return { rows: [] as unknown[] }
    })

    await expect(runDeduplicatedTemplateInstall({
      query,
      scope,
      install: async () => { throw new Error('install blew up') },
    })).rejects.toThrow('install blew up')

    expect(statements.some((sql) => sql.startsWith('INSERT INTO meta_multitable_template_installs'))).toBe(false)
  })

  it('D12: 咨询锁是事务里的第一条语句,排在读账本之前', async () => {
    const statements: string[] = []
    const query = vi.fn(async (sql: string) => {
      statements.push(sql.replace(/\s+/g, ' ').trim())
      return { rows: [] as unknown[] }
    })

    await runDeduplicatedTemplateInstall({
      query,
      scope,
      install: async () => ({ baseId: 'base_module', body: { ok: true } }),
    })

    expect(statements[0]).toContain('pg_advisory_xact_lock')
    const readIndex = statements.findIndex((sql) => sql.startsWith('SELECT base_id'))
    expect(readIndex).toBeGreaterThan(0)
    // 锁的 key 就是作用域指纹本身 —— 同一意图必然同一把锁。
    expect(query.mock.calls[0][1]).toEqual([buildTemplateInstallScopeDigest(scope)])
  })

  it('D2b: 两个并发调用共享一个账本 → install() 只被调用一次(模块级)', async () => {
    // 与 D2 同一件事,去掉 HTTP 那一层:同一把 fake 锁 + 同一个账本 Map。
    // 安装故意慢一拍(await 一个 timer),所以没有锁的话第二个调用必然读到空账本。
    const ledger = new Map<string, Record<string, unknown>>()
    const chains = new Map<string, Promise<void>>()
    let installs = 0

    const makeTxQuery = () => {
      const releases: Array<() => void> = []
      const query = async (sql: string, params: unknown[] = []) => {
        const normalized = sql.replace(/\s+/g, ' ').trim()
        if (normalized.includes('pg_advisory_xact_lock')) {
          const key = String(params[0])
          const prev = chains.get(key) ?? Promise.resolve()
          let release!: () => void
          const mine = new Promise<void>((resolve) => { release = resolve })
          chains.set(key, prev.then(() => mine))
          await prev
          releases.push(release)
          return { rows: [] as unknown[] }
        }
        if (normalized.startsWith('INSERT INTO meta_multitable_template_installs')) {
          ledger.set(String(params[0]), {
            base_id: params[5],
            response: JSON.parse(String(params[6])),
            tenant_id: params[1], actor_id: params[2], template_id: params[3], workspace_id: params[4],
          })
          return { rows: [] as unknown[] }
        }
        if (normalized.startsWith('SELECT base_id')) {
          const row = ledger.get(String(params[0]))
          return { rows: row ? [row] : [] }
        }
        if (normalized.startsWith('SELECT id FROM meta_bases')) {
          return { rows: [{ id: params[0] }] }
        }
        return { rows: [] as unknown[] }
      }
      const commit = () => { for (const release of releases) release() }
      return { query, commit }
    }

    const run = async () => {
      const tx = makeTxQuery()
      try {
        return await runDeduplicatedTemplateInstall({
          query: tx.query,
          scope,
          install: async () => {
            installs++
            await new Promise((resolve) => setTimeout(resolve, 25))
            return { baseId: `base_${installs}`, body: { ok: true, data: { base: { id: `base_${installs}` } } } }
          },
        })
      } finally {
        tx.commit()
      }
    }

    const [left, right] = await Promise.all([run(), run()])

    expect(installs).toBe(1)
    expect(left.baseId).toBe(right.baseId)
    expect([left.replayed, right.replayed].filter(Boolean)).toHaveLength(1)
  })

  it('D15: 账本里存的 body 不是对象 → 不重放,正常安装', async () => {
    // jsonb 列是 NOT NULL,所以 `'null'::jsonb` 只可能来自将来某次写入回归。
    // 真撞上了宁可再装一个,也不能把一个 null body 当成 201 回给客户端。
    let installs = 0
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      if (normalized.startsWith('SELECT base_id')) {
        return {
          rows: [{
            base_id: 'base_prior',
            response: null,
            tenant_id: scope.tenantId,
            actor_id: scope.actorId,
            template_id: scope.templateId,
            workspace_id: scope.workspaceId,
          }],
        }
      }
      if (normalized.startsWith('SELECT id FROM meta_bases')) return { rows: [{ id: params[0] }] }
      return { rows: [] as unknown[] }
    })

    const result = await runDeduplicatedTemplateInstall({
      query,
      scope,
      install: async () => {
        installs++
        return { baseId: 'base_fresh', body: { ok: true } }
      },
    })

    expect(result.replayed).toBe(false)
    expect(result.baseId).toBe('base_fresh')
    expect(installs).toBe(1)
  })

  it('D13: 账本缺表 → TemplateInstallLedgerUnavailableError(而不是把 42P01 原样抛给路由)', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('meta_multitable_template_installs')) {
        const err = new Error('relation does not exist') as Error & { code?: string }
        err.code = '42P01'
        throw err
      }
      return { rows: [] as unknown[] }
    })

    await expect(runDeduplicatedTemplateInstall({
      query,
      scope,
      install: async () => ({ baseId: 'base_module', body: { ok: true } }),
    })).rejects.toBeInstanceOf(TemplateInstallLedgerUnavailableError)
  })

  it('D14: 指纹把每一段作用域都编进去 —— 任一段变了指纹就变', async () => {
    const base = buildTemplateInstallScopeDigest(scope)
    const variants = [
      { ...scope, tenantId: 'tenant_a' },
      { ...scope, actorId: 'user_other' },
      { ...scope, templateId: 'sales-crm' },
      { ...scope, workspaceId: 'ws_1' },
      { ...scope, baseName: 'Other Name' },
    ]
    for (const variant of variants) {
      expect(buildTemplateInstallScopeDigest(variant)).not.toBe(base)
    }
    // 分隔符不可伪造:把值拼在一起不会撞上另一组值的指纹。
    expect(buildTemplateInstallScopeDigest({ ...scope, actorId: 'a', templateId: 'bc' }))
      .not.toBe(buildTemplateInstallScopeDigest({ ...scope, actorId: 'ab', templateId: 'c' }))
  })
})
