/**
 * #5861 —— POST /templates/:templateId/install 的安装去重(路由级 + 模块级)。
 *
 * 真实事故(客户反馈 2026-09-18 第 5 条):「使用模板」看起来无响应,用户反复点;服务端零去重,
 * 同一个模板被实例化 4 次,「可访问的 Base」里出现 4 个同名 Base(222 只读核对)。
 *
 * 路由级矩阵(★ = 把去重整段删掉就红的「反回退」用例)。边界用例断言的是「这些情况下**不许**
 * 去重」,光看状态码/响应头的话它们在一个完全没有去重的服务端上也是绿的 —— 所以每条都额外
 * 断言账本里该有几行(回退后账本恒为 0),D3/D4/D4b/D5/D6/D7/D8/D10 因此同样对回退敏感,
 * D9b 则因为要求 500 而天然敏感。唯一在回退后仍绿的是 D9(缺表 fail-open:它断言的就是
 * 「没有账本」这个状态,与回退后的世界同形)—— 这是它的语义,不是漏网:
 *   D1 ★ 窗口内重复安装 → 只建**一个** Base,第二次原样重放第一次的 201(核心断言)。
 *   D2 ★ 两个并发请求 → 只建一个 Base;恰好一边是重放。互斥来自路由发出的
 *      `pg_try_advisory_xact_lock`(下面的 fake 真的实现了这把锁,把那条语句删掉本用例就红)。
 *   D3 窗口过后 → 真的再建一个(去重是窗口,不是永久封印);过期行被清理掉。
 *   D4 第一个 Base 被软删之后再装 → 新建,不会把客户端重放到一个已删的 Base。
 *   D4b 第一个 Base 还在、但模板建出来的那张表被**软删**之后再装 → 新建。
 *      这是产品里**唯一**能消灭一个多余模板 Base 的路径(没有删 Base 的路由,
 *      DELETE /sheets/:id 是软删),也是客户在 #5861 里真正点下去的那个删除;只核对 Base 行
 *      的实现会在这里把一条指向已删表的 201 重放回去,让用户 5 分钟内既看不到 Base、
 *      又跳进一个不存在的 sheetId。
 *   D5 换个人装同一个模板 → 各建各的,谁也重放不到谁的(用户边界)。
 *   D6 换个租户装同一个模板 → 各建各的(租户边界,来源是 req.authenticatedTenantId)。
 *   D7 无租户声明的会话即使 `req.user.tenantId` 被 x-tenant-id 兼容头填成了 tenant_a
 *      (jwt-middleware.ts 的兼容回填就是这么写的),作用域租户仍恒为 null:
 *      既不会被请求头切出一个新桶、也不会窜进真租户的桶,账本里也写不进 tenant_a
 *      (本仓历史上的跨租户值泄漏就出在这个字段上;形状照搬
 *      multitable-custom-template-routes.test.ts 的 C7)。
 *   D8 换个 baseName → 各建各的(不用等窗口过期的逃生口)。
 *   D9 账本表未迁移(42P01)→ fail-open:照常 201 安装,只是不去重。
 *   D10 账本行的租户列被改坏(模拟 sha256 碰撞)→ 逐列核对拦下,不重放。
 *   D19 ★ 重放**不**发 `[multitable.template.install]`,走独立 token —— 否则 H 系列 SOP 的
 *      安装计数(验证 #5861 是否修好的那个指标)会把一次 4 连点照旧数成 4 次安装。
 *
 * 模块级矩阵(runDeduplicatedTemplateInstall 直调):
 *   D11 install() 抛错 → 账本一个字都没写(失败后重试是真的重试)。
 *   D12 ★ 语句顺序:咨询锁是事务里的**第一条**语句,排在读账本之前,且带 `$1::text`。
 *   D2b ★ 两个并发调用共享一个账本 → install() 只被调用一次。
 *   D13 账本缺表 → TemplateInstallLedgerUnavailableError。
 *   D14 指纹把每一段作用域都编进去。
 *   D15 账本里存的 body 不是对象 → 不重放。
 *   D16 有界等待内始终拿不到锁 → **不抛、不 500**,退回「读账本 → 照常安装」(= 改动前行为),
 *      并把 lockHeld=false 报给调用方。阻塞版咨询锁在这里会被连接池的 statement_timeout
 *      砍成一条错误,于是重复点击从 201 变成 500。
 *   D17 锁在第 3 次尝试时拿到 → 期间不读账本(读必须在拿到锁之后)。
 *   D18 query 面没回 `locked` 布尔列 → 立刻抛(假 store 不会静默地退避到上限)。
 *   D20 ★ 五条语句的形状逐条钉死:`$1::text` / `$1::text[]` / `$7::text[]` / `$8::jsonb` 这几个
 *      显式类型转换、两条 `deleted_at IS NULL` 存活谓词、清理语句的 `FOR UPDATE SKIP LOCKED`+`LIMIT`。
 *      这五条在 CI 里没被真 Postgres 解析过(见用例里的说明),文本断言是目前唯一的护栏。
 *
 * Harness 沿用 multitable-template-dryrun-routes.test.ts 的 mock-pool 路由 precedent:
 * 真 express + 真 univerMetaRouter,poolManager.get() 打桩成内存 store —— 不需要真库。
 * 服务器按 usePinnedServer() 起,断言一律走 request(pinned.url())(tests/unit 里
 * `request(app)` 是 CI 零容忍,#4154)。
 *
 * 关于「fake 背书」:
 *   - fake 里的 pg_try_advisory_xact_lock 是一把**真的**按 key 互斥、事务结束才释放的锁。
 *     它证明的是「路由确实在读账本之前、在同一个事务里、按同一个指纹取了这把锁」——
 *     把路由里那条语句删掉,D2 立刻变成两个 Base。它不证明 PG 自己的锁好使(那是 PG 的事)。
 *   - fake 只执行**语句里真的写了的**谓词:`deleted_at IS NULL` 没写在 SQL 里,fake 就不过滤。
 *     所以 D4 / D4b 的绿不是 fake 赏的:把存活核对从产品代码里拿掉(或把谓词删掉),
 *     fake 立刻把已删的 Base/表当成活的返回,两个用例当场变红。
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

/**
 * 账本语句要抛的错。散文一律用**中文**:客户那台 PG 跑的是中文 locale,PG 把
 * `relation "x" does not exist` 翻成「关系 "x" 不存在」。这两个 fixture 的 message 里
 * 因此一个英文单词都没有 —— 任何靠英文散文判「缺表」的实现在 D9 上当场变红,
 * 只有按 SQLSTATE 判的实现能过。
 */
const LEDGER_TABLE_MISSING_ZH = {
  code: '42P01',
  message: '关系 "meta_multitable_template_installs" 不存在',
} as const
const LEDGER_PERMISSION_DENIED_ZH = {
  code: '42501',
  message: '对关系 meta_multitable_template_installs 权限不够',
} as const

type StoreOptions = {
  /** 账本语句抛这个错。42P01 → fail-open;任何别的 SQLSTATE → 必须 fail-closed。 */
  ledgerError?: { code: string; message: string }
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

  // ── 咨询锁:按 key 互斥,事务结束才释放(try 语义,和 PG 的
  // pg_try_advisory_xact_lock 一样:拿不到立刻回 false,同一事务内可重入) ──────
  const heldLocks = new Map<string, TxContext>()
  const tryLock = (key: string, tx: TxContext | null): boolean => {
    if (!tx) throw new Error('pg_try_advisory_xact_lock issued outside a transaction')
    const owner = heldLocks.get(key)
    if (owner && owner !== tx) return false
    if (!owner) {
      heldLocks.set(key, tx)
      tx.releases.push(() => heldLocks.delete(key))
    }
    return true
  }

  const throwLedgerError = (): never => {
    const spec = opts.ledgerError!
    const err = new Error(spec.message) as Error & { code?: string }
    err.code = spec.code
    throw err
  }

  const handler = async (sql: string, params: unknown[] = [], tx: TxContext | null = null): Promise<QueryResult> => {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    sqlLog.push(normalized)

    if (normalized.includes('advisory_xact_lock')) {
      return { rows: [{ locked: tryLock(String(params[0]), tx) }] }
    }

    // ── 去重账本 ────────────────────────────────────────────────────────
    if (normalized.includes('meta_multitable_template_installs')) {
      if (opts.ledgerError) throwLedgerError()

      if (normalized.startsWith('INSERT INTO meta_multitable_template_installs')) {
        const [digest, tenantId, actorId, templateId, workspaceId, baseId, sheetIds, response] =
          params as [string, string | null, string, string, string | null, string, string[], string]
        ledger.set(digest, {
          scope_digest: digest,
          tenant_id: tenantId,
          actor_id: actorId,
          template_id: templateId,
          workspace_id: workspaceId,
          base_id: baseId,
          sheet_ids: sheetIds,
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
    // 谓词只按**语句里真的写了的**执行:SQL 里没写 `deleted_at IS NULL`,fake 就不过滤。
    // 「重放前核对存活」因此必须由产品代码把谓词写出来才成立 —— fake 不代劳、也不背书。
    if (normalized.startsWith('SELECT') && normalized.includes('FROM meta_bases') && normalized.includes('WHERE id = $1')) {
      const [id] = params as [string]
      const wantsLive = normalized.includes('deleted_at IS NULL')
      return { rows: bases.filter((base) => base.id === id && (!wantsLive || base.deleted_at === null)) }
    }
    if (normalized.startsWith('INSERT INTO meta_bases')) {
      if (barrierArmed) {
        barrierArmed = false
        barrierReached = true
        await installBarrier
      }
      const [id, name, icon, color, ownerId, workspaceId] = params as [string, string, string, string, string | null, string | null]
      if (bases.some((base) => base.id === id)) return { rows: [], rowCount: 0 }
      const base = { id, name, icon, color, owner_id: ownerId, workspace_id: workspaceId, deleted_at: null as number | null }
      bases.push(base)
      return { rows: [base], rowCount: 1 }
    }

    // 重放前的 sheet 存活核对:`... WHERE id = ANY($1::text[]) AND deleted_at IS NULL`。
    if (normalized.startsWith('SELECT') && normalized.includes('FROM meta_sheets') && normalized.includes('id = ANY($1::text[])')) {
      const [ids] = params as [string[]]
      const idSet = new Set(ids)
      const wantsLive = normalized.includes('deleted_at IS NULL')
      return {
        rows: sheets.filter((sheet) => idSet.has(sheet.id as string) && (!wantsLive || sheet.deleted_at === null)),
      }
    }
    if (normalized.startsWith('SELECT') && normalized.includes('FROM meta_sheets') && normalized.includes('WHERE id = $1')) {
      const [id] = params as [string]
      return { rows: sheets.filter((sheet) => sheet.id === id) }
    }
    if (normalized.startsWith('INSERT INTO meta_sheets')) {
      const [id, baseId, name, description] = params as [string, string, string, string | null]
      if (sheets.some((sheet) => sheet.id === id)) return { rows: [], rowCount: 0 }
      sheets.push({ id, base_id: baseId, name, description, deleted_at: null as number | null })
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
    /**
     * 软删 Base。产品里**没有**删 Base 的路由,所以这条只用来证明「重放前核对 Base 存活」
     * 那个谓词真的写在 SQL 里;用户实际能走的路径是下面的 softDeleteSheet。
     * 注意这里是软删而不是 splice:硬删是产品造不出来的状态,拿它作证等于没作证。
     */
    softDeleteBase: (baseId: string) => {
      const base = bases.find((row) => row.id === baseId)
      if (!base) throw new Error(`softDeleteBase: no such base ${baseId}`)
      base.deleted_at = clock
    },
    /**
     * 软删一张表 —— 这是产品里**唯一**能消灭一个多余模板 Base 的路径:
     * DELETE /api/multitable/sheets/:id 的处理器写的就是
     * `UPDATE meta_sheets SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`,
     * 也正是 #5861 里客户反复点的那个删除。删完 Base 行还在,但「可访问的 Base」列表
     * 要求 Base 至少还有一张 live 表,所以用户眼里那个 Base 已经没了。
     */
    softDeleteSheet: (sheetId: string) => {
      const sheet = sheets.find((row) => row.id === sheetId)
      if (!sheet) throw new Error(`softDeleteSheet: no such sheet ${sheetId}`)
      sheet.deleted_at = clock
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

type AppIdentity = {
  userId?: string
  /** JWT 校验后写进 req.authenticatedTenantId 的租户 —— 作用域**只**认这个。 */
  authenticatedTenantId?: string | null
  /**
   * 写进 req.user.tenantId 的租户。jwt-middleware 的 x-tenant-id 兼容回填
   * (`if (!user.tenantId && headerTenantId) user.tenantId = headerTenantId`)写的就是这个字段,
   * 所以「请求头串租户」这条回归必须在**这里**钉,光挂一个请求头钉不住:
   * 这个 harness 没有 JWT 中间件,那条回填根本不会跑。形状照搬同目录
   * multitable-custom-template-routes.test.ts 的 C7。
   */
  userTenantId?: string
}

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
    req.user = {
      id: identity.userId ?? ACTOR,
      roles: [],
      permissions: perms,
      perms,
      // x-tenant-id 兼容回填的落点。作用域读的**不是**这里 —— D7 就钉这一点。
      ...(identity.userTenantId ? { tenantId: identity.userTenantId } : {}),
    } as Express.Request['user']
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
    // 过期那行被顺手清掉了,账本里只剩这次的 —— 完全没有去重的服务端这里恒为 0。
    expect(store.ledger.size).toBe(1)
  })

  it('D4: 第一个 Base 被软删之后再装 → 新建,不重放到一个已删的 Base', async () => {
    const store = createStore()
    const { app } = await createApp(store.handler)
    pinned.setApp(app)

    const first = await install({ baseName: 'Deleted Base' })
    expect(first.status).toBe(201)
    const firstBaseId = first.body.data.base.id as string
    store.softDeleteBase(firstBaseId)

    const again = await install({ baseName: 'Deleted Base' })

    expect(again.status).toBe(201)
    expect(again.headers['idempotent-replayed']).toBeUndefined()
    expect(again.body.data.base.id).not.toBe(firstBaseId)
    // 软删不删行:两行都在,但只有新的那个是 live。
    expect(store.bases).toHaveLength(2)
    expect(store.bases.filter((base) => base.deleted_at === null)).toHaveLength(1)
    expect(store.ledger.size).toBe(1)
  })

  it('D4b: 模板建出来的那张表被软删之后再装 → 新建,不重放到一个指向已删表的 201', async () => {
    // 这是产品里**唯一**能消灭一个多余模板 Base 的路径(没有删 Base 的路由,
    // DELETE /sheets/:id 是软删),也是客户在 #5861 里真正点下去的那个删除。
    // 只核对 Base 行的实现在这里会把第一次那条 201 原样重放回去:Base 行确实还在,
    // 但它已经没有 live 表了 —— 前端 router.push 到一个已删的 sheetId,
    // 「可访问的 Base」列表里也什么都不会多出来,整整 5 分钟无法逃脱。
    const store = createStore()
    const { app } = await createApp(store.handler)
    pinned.setApp(app)

    const first = await install({ baseName: 'Sheet Deleted Base' })
    expect(first.status).toBe(201)
    const firstBaseId = first.body.data.base.id as string
    const firstSheetId = first.body.data.sheets[0].id as string
    store.softDeleteSheet(firstSheetId)

    const again = await install({ baseName: 'Sheet Deleted Base' })

    expect(again.status).toBe(201)
    expect(again.headers['idempotent-replayed']).toBeUndefined()
    expect(again.body.data.base.id).not.toBe(firstBaseId)
    // 回给用户的那张表必须是 live 的 —— 这条才是「用户真的能用」的断言。
    const handedBack = again.body.data.sheets[0].id as string
    expect(handedBack).not.toBe(firstSheetId)
    expect(store.sheets.find((sheet) => sheet.id === handedBack)?.deleted_at).toBeNull()
    expect(store.sheets.filter((sheet) => sheet.deleted_at === null)).toHaveLength(1)
    expect(store.ledger.size).toBe(1)
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

  it('D7: req.user.tenantId(x-tenant-id 兼容回填)不参与作用域 —— 既窜不进真租户的桶,也不另开一个桶', async () => {
    // 钉的是这条回归:有人把 resolveTemplateTenantId 写成
    // `req.authenticatedTenantId ?? req.user?.tenantId`(本仓历史上的跨租户值泄漏就出在
    // req.user.tenantId 上,它会被 jwt-middleware 的 x-tenant-id 兼容头回填)。
    // 因此这里预置的是**回填的结果** req.user.tenantId,而不是只挂一个请求头 ——
    // 这个 harness 没装 JWT 中间件,光挂头什么都不会发生,那样的断言钉不住任何东西。
    const store = createStore()

    // ① 真租户 tenant_a 的会话(authenticatedTenantId 来自 JWT)先建一个。
    const real = await createApp(store.handler, { authenticatedTenantId: 'tenant_a' })
    pinned.setApp(real.app)
    const realInstall = await install({ baseName: 'Header Base' })
    expect(realInstall.status).toBe(201)

    // ② 无租户声明的会话:req.authenticatedTenantId 不存在,但 req.user.tenantId 已被
    //    兼容头回填成 tenant_a。同一个人、同一个模板、同一个名字。
    const spoofed = await createApp(store.handler, { userTenantId: 'tenant_a' })
    pinned.setApp(spoofed.app)
    const first = await install({ baseName: 'Header Base' }, { 'x-tenant-id': 'tenant_a' })

    // 窜不进 tenant_a 的桶:拿不到 tenant_a 那个 Base。
    expect(first.status).toBe(201)
    expect(first.headers['idempotent-replayed']).toBeUndefined()
    expect(first.body.data.base.id).not.toBe(realInstall.body.data.base.id)

    // ③ 同一个会话再点一次:落在 null 租户这个桶里,正常重放(不会被请求头切出新桶)。
    const second = await install({ baseName: 'Header Base' }, { 'x-tenant-id': 'tenant_a' })
    expect(second.status).toBe(201)
    expect(second.headers['idempotent-replayed']).toBe('true')
    expect(second.body).toEqual(first.body)

    expect(store.bases).toHaveLength(2)
    // 账本里一行 tenant_a(真会话的)+ 一行 null(被回填的那个会话的)——
    // 请求头/req.user.tenantId 没能把任何一行写成 tenant_a。
    // sort() 按字符串比较,null 参与比较时是 'null' < 'tenant_a',所以顺序是 [null, 'tenant_a']。
    const tenants = [...store.ledger.values()].map((row) => row.tenant_id).sort()
    expect(tenants).toEqual([null, 'tenant_a'])
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
    // 两个名字 = 两个桶;完全没有去重的服务端这里恒为 0。
    expect(store.ledger.size).toBe(2)
  })

  it('D9: 账本表未迁移(42P01)→ fail-open,照常安装(只是不去重)', async () => {
    // 报错散文是**中文**(客户那台 PG 跑中文 locale)。靠英文散文判缺表的实现在这里必红,
    // 只有按 SQLSTATE 判的能过。
    const store = createStore({ ledgerError: LEDGER_TABLE_MISSING_ZH })
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

  it('D9b: 账本报的不是 42P01(42501 权限不足)→ fail-closed,不静默绕过去重', async () => {
    // fail-open **只**认 SQLSTATE 42P01(表没迁移)。别的数据库错误必须原样往上冒:
    // 事务回滚 → 500 INTERNAL_ERROR,一个 Base 都没建出来。
    // 反面(把 fail-open 放宽成「任何账本错误都照常安装」)才是真正危险的那个:
    // 一次权限/超时故障会静默退化成 #5861 的重复 Base 爆发,而日志里只有一条 201。
    // 注意这条错误的散文同样是中文,所以它也是「别拿散文当判据」的第二个哨兵:
    // 任何 `message.includes('does not exist')` 式的实现在 D9 上红,
    // 任何 `message.includes('不存在')` 式的实现会把这条 42501 也当成缺表 → 本用例红。
    const store = createStore({ ledgerError: LEDGER_PERMISSION_DENIED_ZH })
    const { app } = await createApp(store.handler)
    pinned.setApp(app)

    const res = await install({ baseName: 'Permission Denied Base' })

    expect(res.status).toBe(500)
    expect(res.body.ok).toBe(false)
    expect(res.body.error.code).toBe('INTERNAL_ERROR')
    // 关键断言:没有「悄悄不去重地装一个」——一行都没写。
    expect(store.bases).toHaveLength(0)
    expect(store.sheets).toHaveLength(0)
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
    // 被改坏的那行删掉了,换成这次的 —— 完全没有去重的服务端这里恒为 0。
    expect(store.ledger.size).toBe(1)
    expect([...store.ledger.values()][0].tenant_id).toBeNull()
  })

  it('D19: 重放**不**发 [multitable.template.install] 事件(否则 H 系列 SOP 的安装计数会把一次 4 连点数成 4 次安装)', async () => {
    // docs/operations/multitable-h-series-observation-sop-20260519.md §5/§6 的计数命令是
    // `grep -F '[multitable.template.install]' | grep '"ok":true' | ... uniq -c`。
    // 那个计数正是用来验证 #5861「重复 Base 爆发是否停了」的指标 —— 如果重放也发同一个 token,
    // 指标在修复后纹丝不动,这个 PR 看起来就是没生效的。所以重放走**另一个** token。
    // `grep -F` 是定长字符串匹配且包含右括号,所以 `[...install]` 不会匹配 `[...install.replayed]`。
    const store = createStore()
    const { app } = await createApp(store.handler)
    pinned.setApp(app)

    // 路由里的 logger 是 new Logger('MultitableTemplates');打在原型上就能同时截住那个实例。
    // createApp 里 vi.resetModules() 过,所以必须从**同一份**模块注册表里拿 Logger。
    const { Logger } = await import('../../src/core/logger')
    const infoSpy = vi.spyOn(Logger.prototype, 'info').mockImplementation(() => {})

    const first = await install({ baseName: 'SOP Base' })
    expect(first.status).toBe(201)
    const firstEvents = infoSpy.mock.calls.map((call) => call[0])
    expect(firstEvents).toContain('[multitable.template.install]')
    // 新建那条事件必须带 sheetId(SOP §5 把它写成必有字段)。
    const freshMeta = infoSpy.mock.calls.find((call) => call[0] === '[multitable.template.install]')?.[1]
    expect(typeof (freshMeta as Record<string, unknown>)?.sheetId).toBe('string')

    infoSpy.mockClear()
    const second = await install({ baseName: 'SOP Base' })
    expect(second.status).toBe(201)
    expect(second.headers['idempotent-replayed']).toBe('true')

    const replayEvents = infoSpy.mock.calls.map((call) => call[0])
    // 关键断言:这一次**没有**发安装事件。
    expect(replayEvents).not.toContain('[multitable.template.install]')
    expect(replayEvents).toContain('[multitable.template.install.replayed]')
    // 重放事件里没有 sheetId —— 这一次一张表都没建,别给解析器一个 null 去当成「建了一张表」。
    const replayMeta = infoSpy.mock.calls.find((call) => call[0] === '[multitable.template.install.replayed]')?.[1]
    expect(replayMeta).not.toHaveProperty('sheetId')
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

  /** 锁语句:`SELECT pg_try_advisory_xact_lock(hashtextextended($1::text, 0)) AS locked`。 */
  const isLockSql = (normalized: string) => normalized.includes('advisory_xact_lock')
  /** PG 恒回一行一列的 boolean;fake 必须照做(不照做 → D18 那条立刻抛)。 */
  const lockAnswer = (granted: boolean) => ({ rows: [{ locked: granted }] as unknown[] })
  /** 一次成功安装的返回形状:base + 这次建出来的**全部** sheet id。 */
  const freshResult = (baseId: string, sheetIds: string[] = [`sheet_of_${baseId}`]) => ({
    baseId,
    sheetIds,
    body: { ok: true, data: { base: { id: baseId }, sheets: sheetIds.map((id) => ({ id })) } },
  })

  it('D11: install() 抛错 → 账本一个字都没写(失败后重试是真的重试)', async () => {
    const statements: string[] = []
    const query = vi.fn(async (sql: string) => {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      statements.push(normalized)
      if (isLockSql(normalized)) return lockAnswer(true)
      return { rows: [] as unknown[] }
    })

    await expect(runDeduplicatedTemplateInstall({
      query,
      scope,
      install: async () => { throw new Error('install blew up') },
    })).rejects.toThrow('install blew up')

    expect(statements.some((sql) => sql.startsWith('INSERT INTO meta_multitable_template_installs'))).toBe(false)
  })

  it('D12: 咨询锁是事务里的第一条语句,排在读账本之前,且参数显式写了 ::text', async () => {
    const statements: string[] = []
    const query = vi.fn(async (sql: string) => {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      statements.push(normalized)
      if (isLockSql(normalized)) return lockAnswer(true)
      return { rows: [] as unknown[] }
    })

    const result = await runDeduplicatedTemplateInstall({
      query,
      scope,
      install: async () => freshResult('base_module'),
    })

    expect(statements[0]).toContain('pg_try_advisory_xact_lock')
    // 参数类型写死:无类型 $1 依赖 PG 自己推断,而这条语句**不**走 ledgerQuery,
    // 推断失败时既没有 42P01 翻译、也没有 fail-open,整条「使用模板」会变成 500。
    // 先例同形:attendance/w4c0-identity.ts 的 hashtext($1::text)。
    expect(statements[0]).toContain('$1::text')
    const readIndex = statements.findIndex((sql) => sql.startsWith('SELECT base_id'))
    expect(readIndex).toBeGreaterThan(0)
    // 锁的 key 就是作用域指纹本身 —— 同一意图必然同一把锁。
    expect(query.mock.calls[0][1]).toEqual([buildTemplateInstallScopeDigest(scope)])
    expect(result.lockHeld).toBe(true)
  })

  it('D20: 五条语句的形状逐条钉死(显式类型转换 + 存活谓词 + 有界清理)', async () => {
    // 为什么要逐条钉文本:这五条语句在 CI 里**没有**任何一条被真 Postgres 解析过
    // (本仓的 real-DB 泳道都是独立 workflow 文件,而推这条分支的 token 没有 workflow scope ——
    // vitest.config.ts 里 multitable-record-approval-realdb 那条注释记的就是同一个限制)。
    // 于是「类型推断失败 / 忘了谓词 / 清理去等别人的行锁」这三类错在本机是看不见的,
    // 只能用文本断言把形状钉住:少一处,下面就红一条。真库解析这件事记在 owner 项里。
    const statements: string[] = []
    let ledgerRow: Record<string, unknown> | null = null
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      statements.push(normalized)
      if (isLockSql(normalized)) return lockAnswer(true)
      if (normalized.startsWith('INSERT INTO meta_multitable_template_installs')) {
        ledgerRow = {
          base_id: params[5],
          sheet_ids: params[6],
          response: JSON.parse(String(params[7])),
          tenant_id: params[1], actor_id: params[2], template_id: params[3], workspace_id: params[4],
        }
        return { rows: [] as unknown[] }
      }
      if (normalized.startsWith('SELECT base_id')) return { rows: ledgerRow ? [ledgerRow] : [] }
      if (normalized.startsWith('SELECT id FROM meta_bases')) return { rows: [{ id: params[0] }] }
      if (normalized.includes('FROM meta_sheets')) {
        return { rows: ((params[0] as string[]) ?? []).map((id) => ({ id })) }
      }
      return { rows: [] as unknown[] }
    })

    const fresh = await runDeduplicatedTemplateInstall({
      query, scope, install: async () => freshResult('base_shape', ['sheet_a', 'sheet_b']),
    })
    expect(fresh.replayed).toBe(false)
    const replay = await runDeduplicatedTemplateInstall({
      query, scope, install: async () => { throw new Error('must not install on replay') },
    })
    expect(replay.replayed).toBe(true)

    const find = (predicate: (sql: string) => boolean): string => {
      const hit = statements.find(predicate)
      if (!hit) throw new Error(`no statement matched; got:\n${statements.join('\n')}`)
      return hit
    }

    // ① 咨询锁:try 版(阻塞版会被连接池的 statement_timeout 砍成 500)+ 显式 ::text。
    const lock = find((sql) => sql.includes('advisory_xact_lock'))
    expect(lock).toContain('pg_try_advisory_xact_lock')
    expect(lock).toContain('$1::text')
    // ② Base 存活:软删的 Base 不许重放。
    expect(find((sql) => sql.startsWith('SELECT id FROM meta_bases'))).toContain('deleted_at IS NULL')
    // ③ 表存活:重放交还的每一个 sheet id 都要 live;数组参数显式 ::text[]。
    const sheetProbe = find((sql) => sql.includes('FROM meta_sheets'))
    expect(sheetProbe).toContain('id = ANY($1::text[])')
    expect(sheetProbe).toContain('deleted_at IS NULL')
    // ④ 写账本:sheet_ids 是 text[],response 是 jsonb —— 两个都显式转换。
    const insert = find((sql) => sql.startsWith('INSERT INTO meta_multitable_template_installs'))
    expect(insert).toContain('$7::text[]')
    expect(insert).toContain('$8::jsonb')
    expect(insert).toContain('ON CONFLICT (scope_digest) DO UPDATE')
    // ⑤ 过期清理跑在安装事务里(锁还握着),所以**不能**去等别人的行锁:
    //    SKIP LOCKED + LIMIT,永不阻塞,也就不可能和另一个安装事务互相等成死锁。
    const sweep = find((sql) => sql.startsWith('DELETE') && sql.includes('installed_at <'))
    expect(sweep).toContain('FOR UPDATE SKIP LOCKED')
    expect(sweep).toMatch(/LIMIT \d+/)
  })

  it('D16: 有界等待内始终拿不到锁 → 不抛、不 500,退回「读账本 + 照常安装」并报 lockHeld=false', async () => {
    // 阻塞版 pg_advisory_xact_lock 会把整段等待算进**一条语句**,于是连接池的
    // statement_timeout(默认 30s)会把一次重复点击变成 500 —— 改动前那次点击是 201。
    // 有界 try + 退避把最坏情况钉回「和改动前一样」:多建一个 Base,但绝不报错。
    const statements: string[] = []
    const sleeps: number[] = []
    let installs = 0
    const query = vi.fn(async (sql: string) => {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      statements.push(normalized)
      if (isLockSql(normalized)) return lockAnswer(false) // 永远被别人占着
      return { rows: [] as unknown[] }
    })

    const result = await runDeduplicatedTemplateInstall({
      query,
      scope,
      lockWaitMs: 200,
      lockPollMs: 5,
      sleep: async (ms: number) => { sleeps.push(ms); await new Promise((resolve) => setTimeout(resolve, 1)) },
      install: async () => { installs++; return freshResult('base_unlocked') },
    })

    expect(result.replayed).toBe(false)
    expect(result.lockHeld).toBe(false)
    expect(installs).toBe(1)
    // 真的重试过(不是一次就放弃),而且真的停下来了(不是无限等)。
    expect(sleeps.length).toBeGreaterThanOrEqual(2)
    // 退让之后该做的一样都没少:读账本 + 写账本(第 2 层 PK 兜底仍然在)。
    expect(statements.some((sql) => sql.startsWith('SELECT base_id'))).toBe(true)
    expect(statements.some((sql) => sql.startsWith('INSERT INTO meta_multitable_template_installs'))).toBe(true)
  })

  it('D17: 锁在第 3 次尝试时拿到 → 在此之前一条账本语句都没发', async () => {
    const statements: string[] = []
    let attempts = 0
    const query = vi.fn(async (sql: string) => {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      statements.push(normalized)
      if (isLockSql(normalized)) {
        attempts++
        return lockAnswer(attempts >= 3)
      }
      return { rows: [] as unknown[] }
    })

    const result = await runDeduplicatedTemplateInstall({
      query,
      scope,
      lockWaitMs: 5_000,
      lockPollMs: 1,
      sleep: async () => {},
      install: async () => freshResult('base_third_try'),
    })

    expect(attempts).toBe(3)
    expect(result.lockHeld).toBe(true)
    // 前三条全是锁语句:读账本必须发生在**拿到锁之后**,否则「先查后插」的竞态回来了。
    expect(statements.slice(0, 3).every((sql) => isLockSql(sql))).toBe(true)
    expect(statements.findIndex((sql) => sql.startsWith('SELECT base_id'))).toBe(3)
  })

  it('D18: query 面没回 locked 布尔列 → 立刻抛,不静默退避到等待上限', async () => {
    // 假 store 少写一列时,行为必须是「大声失败」,而不是「看起来挂了 15 秒再装一个」。
    let installs = 0
    const query = vi.fn(async () => ({ rows: [{}] as unknown[] }))

    await expect(runDeduplicatedTemplateInstall({
      query,
      scope,
      lockWaitMs: 5_000,
      sleep: async () => { throw new Error('should not sleep') },
      install: async () => { installs++; return freshResult('base_never') },
    })).rejects.toThrow(/locked/)

    expect(installs).toBe(0)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('D2b: 两个并发调用共享一个账本 → install() 只被调用一次(模块级)', async () => {
    // 与 D2 同一件事,去掉 HTTP 那一层:同一把 fake 锁 + 同一个账本 Map。
    // 锁按 pg_try_advisory_xact_lock 的语义实现:被别的事务占着就回 false(调用方退避重试),
    // 事务结束才释放。安装故意慢一拍(await 一个 timer),所以没有锁的话第二个调用必然读到空账本。
    const ledger = new Map<string, Record<string, unknown>>()
    const heldLocks = new Map<string, object>()
    const liveSheets = new Set<string>()
    let installs = 0

    const makeTxQuery = () => {
      const tx = {}
      const releases: Array<() => void> = []
      const query = async (sql: string, params: unknown[] = []) => {
        const normalized = sql.replace(/\s+/g, ' ').trim()
        if (normalized.includes('advisory_xact_lock')) {
          const key = String(params[0])
          const owner = heldLocks.get(key)
          if (owner && owner !== tx) return { rows: [{ locked: false }] as unknown[] }
          if (!owner) {
            heldLocks.set(key, tx)
            releases.push(() => heldLocks.delete(key))
          }
          return { rows: [{ locked: true }] as unknown[] }
        }
        if (normalized.startsWith('INSERT INTO meta_multitable_template_installs')) {
          ledger.set(String(params[0]), {
            base_id: params[5],
            sheet_ids: params[6],
            response: JSON.parse(String(params[7])),
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
        if (normalized.includes('FROM meta_sheets')) {
          const ids = (params[0] as string[]) ?? []
          return { rows: ids.filter((id) => liveSheets.has(id)).map((id) => ({ id })) }
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
          lockWaitMs: 5_000,
          lockPollMs: 1,
          install: async () => {
            installs++
            await new Promise((resolve) => setTimeout(resolve, 25))
            const baseId = `base_${installs}`
            const sheetId = `sheet_of_${baseId}`
            liveSheets.add(sheetId)
            return freshResult(baseId, [sheetId])
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
      if (isLockSql(normalized)) return lockAnswer(true)
      if (normalized.startsWith('SELECT base_id')) {
        return {
          rows: [{
            base_id: 'base_prior',
            // 存活核对故意让它**全过**:Base 在、表也在。于是「不重放」的唯一原因
            // 只剩下 response 不是对象 —— 这条用例钉的就是那一个判断。
            sheet_ids: ['sheet_prior'],
            response: null,
            tenant_id: scope.tenantId,
            actor_id: scope.actorId,
            template_id: scope.templateId,
            workspace_id: scope.workspaceId,
          }],
        }
      }
      if (normalized.startsWith('SELECT id FROM meta_bases')) return { rows: [{ id: params[0] }] }
      if (normalized.includes('FROM meta_sheets')) {
        return { rows: ((params[0] as string[]) ?? []).map((id) => ({ id })) }
      }
      return { rows: [] as unknown[] }
    })

    const result = await runDeduplicatedTemplateInstall({
      query,
      scope,
      install: async () => {
        installs++
        return freshResult('base_fresh')
      },
    })

    expect(result.replayed).toBe(false)
    expect(result.baseId).toBe('base_fresh')
    expect(installs).toBe(1)
  })

  it('D13: 账本缺表 → TemplateInstallLedgerUnavailableError(而不是把 42P01 原样抛给路由)', async () => {
    const query = vi.fn(async (sql: string) => {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      if (isLockSql(normalized)) return lockAnswer(true)
      if (normalized.includes('meta_multitable_template_installs')) {
        const err = new Error('relation does not exist') as Error & { code?: string }
        err.code = '42P01'
        throw err
      }
      return { rows: [] as unknown[] }
    })

    await expect(runDeduplicatedTemplateInstall({
      query,
      scope,
      install: async () => freshResult('base_module'),
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
