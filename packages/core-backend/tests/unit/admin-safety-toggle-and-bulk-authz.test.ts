/**
 * #5655 — admin-routes 的安全开关与 bulk 写/删必须是「平台 admin」，而不是「过了确认层」。
 *
 * 越权面（修前实读）：
 *  - `POST /api/admin/safety/enable`  (admin-routes.ts) 零中间件。
 *  - `POST /api/admin/safety/disable` 只挂 `requireSafetyCheck({ operation: RESET_METRICS })`，
 *    而 RESET_METRICS 在 SafetyGuard 的 RISK_MAP 里是 LOW，`requiresConfirmation` 只对
 *    MEDIUM/HIGH/CRITICAL 为真 —— 也就是说这条端点「一次请求、零令牌」即可通过，任何已认证的
 *    非 admin 都能把全局确认层关掉（`SafetyGuard.checkOperation`：disabled 时对一切 allowed:true）。
 *  - 关掉之后，`PUT /api/admin/data/bulk` 与 `DELETE /api/admin/data/bulk` 对任意已认证用户开放，
 *    表名白名单含 `data_sources` 等，过滤条件完全由 `req.body.filters` 给、无租户注入。
 *
 * `requireSafetyCheck`（guards/middleware.ts）内没有任何角色判断 —— 它是确认流程，不是授权门。
 * 本 spec 断言这些端点的 **第一个** 中间件是 fail-closed 的 `requireAdminRole()`：非 admin 拿到
 * 403 `ADMIN_REQUIRED`（而不是 403 `SAFETY_CHECK_REQUIRED` + 一枚可用令牌），且 kysely 的
 * `updateTable` / `deleteFrom` 一次都不会被调用。
 *
 * 对 admin 的行为必须不变：admin 打 bulk 仍是 403 `SAFETY_CHECK_REQUIRED` 并回令牌（确认层照旧）。
 */
import express, { type Express, type NextFunction, type Router } from 'express'
import request from 'supertest'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

// --------------------------------------------------------------------------
// Hoisted mock state
// --------------------------------------------------------------------------
const rbacState = vi.hoisted(() => ({
  isAdmin: vi.fn(async (_userId: string) => false),
}))

const dbState = vi.hoisted(() => {
  const makeChain = (): Record<string, unknown> => {
    const chain: Record<string, unknown> = {}
    chain.set = () => chain
    chain.where = () => chain
    chain.values = () => chain
    chain.returning = () => chain
    chain.returningAll = () => chain
    chain.selectAll = () => chain
    chain.select = () => chain
    chain.execute = async () => []
    chain.executeTakeFirst = async () => undefined
    return chain
  }
  return {
    makeChain,
    updateTable: vi.fn(() => makeChain()),
    deleteFrom: vi.fn(() => makeChain()),
  }
})

vi.mock('../../src/rbac/service', () => ({
  isAdmin: rbacState.isAdmin,
}))

// No database in this lane: `pool: null` makes logSafetyOperation a no-op warn and keeps
// isAdmin's real implementation irrelevant (it is mocked above anyway).
vi.mock('../../src/db/pg', () => ({ pool: null }))

// 与 admin-snapshot-delete-authz.test.ts 同款：切断 SnapshotService → audit → AuditRepository 这条
// 在 import 期就要求真实连接池的链（`new AuditRepository(pool!)` 会直接抛 'Database pool not initialized'）。
vi.mock('../../src/services/SnapshotService', () => ({}))
vi.mock('../../src/audit/audit', () => ({}))

// Spy on the two write entry points the bulk routes use; every other kysely method degrades to an
// inert chainable so that importing admin-routes (and its transitive route modules) still works.
vi.mock('../../src/db/kysely', () => {
  const db = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === 'updateTable') return dbState.updateTable
        if (prop === 'deleteFrom') return dbState.deleteFrom
        if (prop === 'then') return undefined
        return () => dbState.makeChain()
      },
    },
  )
  return { db, transaction: vi.fn() }
})

import {
  OperationType,
  getSafetyGuard,
  initSafetyGuard,
  protectAdminOperation,
  requireAdminRole,
  requireSafetyCheck,
} from '../../src/guards'
import adminRouter, { initAdminRoutes } from '../../src/routes/admin-routes'

const NON_ADMIN = { id: 'u-non-admin', email: 'non-admin@example.invalid' }

function buildApp(user: { id: string; email: string } = NON_ADMIN): Express {
  const app = express()
  app.use(express.json())
  // Authenticated, but NOT an admin — exactly the caller this fix is about.
  app.use((req, _res, next) => {
    ;(req as express.Request & { user?: unknown }).user = user
    next()
  })
  app.use('/api/admin', initAdminRoutes({}))
  return app
}

const BULK_UPDATE_BODY = {
  table: 'data_sources',
  updates: { name: 'pwned' },
  filters: { id: 'ds-1' },
  estimatedCount: 1,
}
const BULK_DELETE_BODY = {
  table: 'data_sources',
  filters: { id: 'ds-1' },
  estimatedCount: 1,
}

describe('#5655 admin 安全开关与 bulk 写/删的授权门', () => {
  const pinned = usePinnedServer()

  beforeEach(() => {
    vi.clearAllMocks()
    rbacState.isAdmin.mockResolvedValue(false)
    // initAdminRoutes 内部会按环境变量重建 SafetyGuard 单例；这里显式钉死 enabled:true，
    // 并且每个用例重建一次（单例会跨用例污染，尤其是 /safety/disable 那条）。
    const app = buildApp()
    initSafetyGuard({ enabled: true })
    pinned.setApp(app)
  })

  describe('非 admin', () => {
    it('POST /safety/disable → 403 ADMIN_REQUIRED，且确认层仍然开着', async () => {
      const res = await request(pinned.url()).post('/api/admin/safety/disable').send({})
      expect(res.status).toBe(403)
      expect(res.body?.code).toBe('ADMIN_REQUIRED')
      // 关键：确认层没有被关掉。
      expect(getSafetyGuard().isEnabled()).toBe(true)
    })

    it('POST /safety/enable → 403 ADMIN_REQUIRED', async () => {
      const res = await request(pinned.url()).post('/api/admin/safety/enable').send({})
      expect(res.status).toBe(403)
      expect(res.body?.code).toBe('ADMIN_REQUIRED')
    })

    it('PUT /data/bulk (data_sources) → 403 ADMIN_REQUIRED 且 updateTable 零调用', async () => {
      const res = await request(pinned.url()).put('/api/admin/data/bulk').send(BULK_UPDATE_BODY)
      expect(res.status).toBe(403)
      // 必须是授权门先答，而不是确认层答 SAFETY_CHECK_REQUIRED（后者会回一枚可用令牌）。
      expect(res.body?.code).toBe('ADMIN_REQUIRED')
      expect(res.body?.confirmation).toBeUndefined()
      expect(dbState.updateTable).not.toHaveBeenCalled()
    })

    it('DELETE /data/bulk (data_sources) → 403 ADMIN_REQUIRED 且 deleteFrom 零调用', async () => {
      const res = await request(pinned.url()).delete('/api/admin/data/bulk').send(BULK_DELETE_BODY)
      expect(res.status).toBe(403)
      expect(res.body?.code).toBe('ADMIN_REQUIRED')
      expect(res.body?.confirmation).toBeUndefined()
      expect(dbState.deleteFrom).not.toHaveBeenCalled()
    })

    // 修前基线（整链复现）：非 admin 先 POST /safety/disable 拿到 200 把确认层关掉，
    // 随后 PUT /data/bulk 直达 `updateTable(...).set(updates)`。修后这条整链必须在第一步就断。
    it('整链：先关确认层再 bulk 写 —— 两步都被授权门挡住，updateTable 零调用', async () => {
      const disable = await request(pinned.url()).post('/api/admin/safety/disable').send({})
      expect(disable.status).toBe(403)
      expect(disable.body?.code).toBe('ADMIN_REQUIRED')
      expect(getSafetyGuard().isEnabled()).toBe(true)

      const bulk = await request(pinned.url()).put('/api/admin/data/bulk').send(BULK_UPDATE_BODY)
      expect(bulk.status).toBe(403)
      expect(bulk.body?.code).toBe('ADMIN_REQUIRED')
      expect(dbState.updateTable).not.toHaveBeenCalled()
    })

    // 同文件其余「只靠 requireSafetyCheck」的写/破坏性端点：一并补门。
    // 其中 RESET_METRICS 组（LOW 风险）修前连令牌都不需要，是彻底敞开的。
    const OTHER_WRITE_ENDPOINTS: Array<[string, 'post' | 'delete', string]> = [
      ['POST /cache/clear', 'post', '/api/admin/cache/clear'],
      ['POST /metrics/reset', 'post', '/api/admin/metrics/reset'],
      ['POST /dlq/:id/retry', 'post', '/api/admin/dlq/m-1/retry'],
      ['DELETE /dlq/:id', 'delete', '/api/admin/dlq/m-1'],
      ['POST /dlq/retry-all', 'post', '/api/admin/dlq/retry-all'],
      ['POST /dlq/cleanup', 'post', '/api/admin/dlq/cleanup'],
      ['POST /ratelimits/:key/reset', 'post', '/api/admin/ratelimits/tenant-a/reset'],
      ['POST /ratelimits/reset-all', 'post', '/api/admin/ratelimits/reset-all'],
    ]

    it.each(OTHER_WRITE_ENDPOINTS)('%s → 403 ADMIN_REQUIRED', async (_label, method, path) => {
      const res = await request(pinned.url())[method](path).send({})
      expect(res.status).toBe(403)
      expect(res.body?.code).toBe('ADMIN_REQUIRED')
    })
  })

  describe('admin —— 行为不变', () => {
    beforeEach(() => {
      rbacState.isAdmin.mockResolvedValue(true)
    })

    it('PUT /data/bulk 仍然是 403 SAFETY_CHECK_REQUIRED 并回确认令牌', async () => {
      const res = await request(pinned.url()).put('/api/admin/data/bulk').send(BULK_UPDATE_BODY)
      expect(res.status).toBe(403)
      expect(res.body?.code).toBe('SAFETY_CHECK_REQUIRED')
      expect(res.body?.assessment?.riskLevel).toBe('high')
      expect(typeof res.body?.confirmation?.token).toBe('string')
      expect(dbState.updateTable).not.toHaveBeenCalled()
    })

    it('DELETE /data/bulk 仍然是 403 SAFETY_CHECK_REQUIRED 并回确认令牌', async () => {
      const res = await request(pinned.url()).delete('/api/admin/data/bulk').send(BULK_DELETE_BODY)
      expect(res.status).toBe(403)
      expect(res.body?.code).toBe('SAFETY_CHECK_REQUIRED')
      expect(typeof res.body?.confirmation?.token).toBe('string')
      expect(dbState.deleteFrom).not.toHaveBeenCalled()
    })

    it('POST /safety/disable 对 admin 仍然放行（LOW 风险、无需确认）', async () => {
      const res = await request(pinned.url()).post('/api/admin/safety/disable').send({})
      expect(res.status).toBe(200)
      expect(res.body?.success).toBe(true)
      expect(getSafetyGuard().isEnabled()).toBe(false)
    })

    it('POST /safety/enable 对 admin 仍然放行', async () => {
      initSafetyGuard({ enabled: false })
      const res = await request(pinned.url()).post('/api/admin/safety/enable').send({})
      expect(res.status).toBe(200)
      expect(res.body?.success).toBe(true)
      expect(getSafetyGuard().isEnabled()).toBe(true)
    })
  })

  describe('fail-closed', () => {
    it('RBAC 抛错时 PUT /data/bulk 答 503 而不是放行', async () => {
      rbacState.isAdmin.mockRejectedValue(new Error('rbac down'))
      const res = await request(pinned.url()).put('/api/admin/data/bulk').send(BULK_UPDATE_BODY)
      expect(res.status).toBe(503)
      expect(res.body?.code).toBe('RBAC_CHECK_FAILED')
      expect(dbState.updateTable).not.toHaveBeenCalled()
    })
  })
})

// ==========================================================================
// 闭世界用例（2026-09-20 rebase 到 main 时补）
//
// 上面那些用例是**逐条点名**的（12 条写端点 + 越权整链 + fail-closed）。点名是开世界的：
// 今天全绿并不排除「明天有人往 admin-routes.ts 里新加一条没有门的写路由」。本节把口径翻过来 ——
// 枚举 admin-routes.ts **根 router 上全部** POST/PUT/PATCH/DELETE 路由，要求每一条中间件链的
// **首位**是 `requireAdminRole()`（`protectAdminOperation(...)` 展开后首位也是它），否则必须
// 出现在下面这张显式豁免表里并写清理由。没登记的洞 = 红。
//
// 范围刻意只到**根路由**（`admin-routes.ts` 里 `router.post/put/patch/delete` 直接注册的那些），
// 不含两个子路由挂载点 `router.use('/snapshots', ...)` / `router.use('/safety/rules', ...)`
// （admin-routes.ts:2377-2378）。理由是子路由各有自己的 owner 与 spec，把它们拉进本 spec 会把
// 互相独立的 PR 强耦合成固定合并顺序。
//
// 2026-09-20 复核：`/safety/rules` 那四条写端点在 2026-09-12 的设计稿里还是「零授权门」，
// 现在已经补上了 —— protection-rules.ts:236 `POST /`、:328 `PATCH /:id`、:369 `DELETE /:id`、
// :392 `POST /evaluate` 首位都是 `requireAdminRole()`（#5667 / PR #5677 已合，见 #5710 的
// 「叠 #5677」）。所以今天即便把子路由算进来也不会红；范围仍然收在根路由，是为了让本 spec
// 的边界与它断言的对象一致，而不是因为子路由有洞。
//
// 整棵树（含子路由、含「临时豁免只提示不拦」机制）的结构性守卫是 PR #5680 的活，
// 本节与它口径一致（同一个 `requireAdminRole()` toString 识别器、同三条永久豁免）、范围更窄。
// ==========================================================================

type Handler = (...args: unknown[]) => unknown
type WriteMethod = 'post' | 'put' | 'patch' | 'delete'

const WRITE_METHODS: readonly WriteMethod[] = ['post', 'put', 'patch', 'delete']
/** index.ts 把本 router 挂在 `/api/admin`；只用于把失败信息写成人读的样子。 */
const ADMIN_MOUNT = '/api/admin'

/**
 * `requireAdminRole()` 闭包的源文本 —— 同一个函数定义产出的每个闭包 `toString()` 逐字相同。
 * 用源文本而不是引用相等，是因为路由注册时每条路由各自调了一次 `requireAdminRole()`。
 */
const ADMIN_GATE_SOURCE = (requireAdminRole() as unknown as Handler).toString()

function isAdminGate(fn: unknown): boolean {
  return typeof fn === 'function' && (fn as Handler).toString() === ADMIN_GATE_SOURCE
}

interface RouteHandlerLayer {
  handle: unknown
  /** express 给 `route.post(fn)` 这类 layer 打的方法名；`route.all(fn)` 时为 undefined。 */
  method?: string
}
interface RouteLike {
  path: unknown
  methods: Record<string, boolean | undefined>
  stack: RouteHandlerLayer[]
}
interface RouterLayer {
  route?: RouteLike
  handle: unknown
}
interface RouterLike {
  stack: RouterLayer[]
}

function asRouterLike(r: Router): RouterLike {
  const candidate = r as unknown as RouterLike
  if (!Array.isArray(candidate.stack)) {
    throw new Error('express 内部结构变了：router.stack 不是数组，本用例的取栈方式需要重写')
  }
  return candidate
}

interface RootWriteRoute {
  method: WriteMethod
  path: string
  label: string
  /** 该 method 在这条路由上的**首个** handler。 */
  firstHandler: unknown
}

/** 只收根 router 上直接注册的写路由；`layer.route` 为空的（即子路由 use layer）跳过。 */
function collectRootWriteRoutes(r: Router): RootWriteRoute[] {
  const out: RootWriteRoute[] = []
  for (const layer of asRouterLike(r).stack) {
    const route = layer.route
    if (!route) continue
    if (typeof route.path !== 'string') {
      throw new Error(
        `不支持的路由路径类型（${String(route.path)}）：数组/正则路径会让点名失真，请改写本用例或改写路由`,
      )
    }
    // `router.all(path, fn)` 也应答写方法 —— 不能从写面里漏掉。
    const isAll = route.methods._all === true
    for (const method of WRITE_METHODS) {
      if (!isAll && route.methods[method] !== true) continue
      const handlerLayer = isAll ? route.stack[0] : route.stack.find((l) => l.method === method)
      out.push({
        method,
        path: route.path,
        label: `${method.toUpperCase()} ${ADMIN_MOUNT}${route.path}${isAll ? ' (via router.all)' : ''}`,
        firstHandler: handlerLayer?.handle,
      })
    }
  }
  return out
}

/**
 * 显式豁免表：**永久豁免**，理由是「设计上就不该有中间件门」。
 * 三条都是逐条实读确认过的；行号按 2026-09-20 的 main + 本支改动。
 * 它们哪天有门了 = 设计变了，应当来删豁免（不在本 spec 里做硬红，那条硬红在 #5680）。
 */
const ROOT_EXEMPTIONS: ReadonlyArray<{ method: WriteMethod; path: string; reason: string }> = [
  {
    method: 'post',
    path: '/health/check',
    reason:
      '只读探针：handler 只调 getHealthAggregator().checkHealth() 取一次快照并回摘要，不写任何状态；' +
      '本 PR 设计 §2.1 据此判定它不属于「写/破坏性」面。「任意已认证用户可触发的探测/放大面」' +
      '记在设计 §4 残余第 4 条，属读侧，不由本 spec 管。',
  },
  {
    method: 'post',
    path: '/plugins/reload-all-unsafe',
    reason:
      '自带 in-handler 双门：ALLOW_UNSAFE_ADMIN !== "true" → 403 UNSAFE_DISABLED；' +
      'req.user.roles 不含 "admin" → 403 ADMIN_REQUIRED。不属于「只靠确认层」那一族。' +
      '但它读的是 token 上的 roles 数组，而 requireAdminRole() 查 user_roles —— 两套 admin 口径' +
      '共存是设计 §4 残余第 5 条登记的待统一项，统一之前不强求它换成中间件门。',
  },
  {
    method: 'post',
    path: '/plugins/:id/reload-unsafe',
    reason: '同上，in-handler 双门同款；admin 口径不一致同样记在设计 §4 残余第 5 条。',
  },
]

const ROOT_EXEMPT_KEYS = new Set(ROOT_EXEMPTIONS.map((e) => `${e.method} ${e.path}`))

describe('闭世界：admin-routes.ts 根路由的写面没有未登记的无门端点', () => {
  let router: Router

  beforeAll(() => {
    // initAdminRoutes 返回的就是 admin-routes.ts 的模块级单例 router（:73 建、:2380 default 导出），
    // 也就是 index.ts 真正挂到 `/api/admin` 的那一个 —— 断言这一点，免得将来它变成「每次新建一个」
    // 而本用例却在量一个没人用的对象。
    router = initAdminRoutes({})
    expect(router).toBe(adminRouter)
  })

  // ---- 识别机制的正反自证：先证「门识别器」不是个恒真/恒假的假件 ----
  it('正：requireAdminRole() 的不同调用互相匹配（闭包环境不影响 toString 同一性）', () => {
    expect(isAdminGate(requireAdminRole())).toBe(true)
    expect(isAdminGate(requireAdminRole())).toBe(true)
  })

  it('正：protectAdminOperation(...) 展开后首位就是 admin 门；反：第二位不是', () => {
    const chain = protectAdminOperation(OperationType.FORCE_RELOAD)
    expect(Array.isArray(chain)).toBe(true)
    expect(chain).toHaveLength(2)
    expect(isAdminGate(chain[0])).toBe(true)
    expect(isAdminGate(chain[1])).toBe(false)
  })

  it('反：requireSafetyCheck(...) 不是 admin 门（确认层 ≠ 授权门，本 PR 的要害）', () => {
    expect(isAdminGate(requireSafetyCheck({ operation: OperationType.RESET_METRICS }))).toBe(false)
  })

  it('反：裸中间件 / 非函数都不是 admin 门', () => {
    expect(isAdminGate((_req: express.Request, _res: express.Response, next: NextFunction) => next())).toBe(
      false,
    )
    expect(isAdminGate(undefined)).toBe(false)
    expect(isAdminGate(null)).toBe(false)
    expect(isAdminGate('requireAdminRole')).toBe(false)
  })

  // ---- 防「零条写路由」式的空转绿 ----
  it('根路由的写面确实被收集到了，且有门的那一族非空', () => {
    const all = collectRootWriteRoutes(router)
    expect(all.length).toBeGreaterThanOrEqual(20)
    expect(all.filter((r) => isAdminGate(r.firstHandler)).length).toBeGreaterThanOrEqual(15)
  })

  // ---- 闭世界主张 ----
  it('每条根写路由的中间件链首位都是 requireAdminRole()，否则必须在豁免表里', () => {
    const violations = collectRootWriteRoutes(router).filter(
      (r) => !isAdminGate(r.firstHandler) && !ROOT_EXEMPT_KEYS.has(`${r.method} ${r.path}`),
    )
    expect(
      violations.map((v) => v.label),
      violations.length === 0
        ? ''
        : '以下 admin-routes.ts 根写路由的中间件链首位不是 requireAdminRole()/protectAdminOperation(...)，' +
          '也不在本文件的 ROOT_EXEMPTIONS 里：\n' +
          violations.map((v) => `  - ${v.label}`).join('\n') +
          '\n\n要么给它加门（首位 requireAdminRole() 或 ...protectAdminOperation(OperationType.X)），' +
          '要么在 ROOT_EXEMPTIONS 里显式登记并写清理由。确认层 requireSafetyCheck 不算门。',
    ).toEqual([])
  })

  it('豁免表里没有已经不存在的路由（禁止残留过期豁免）', () => {
    const all = collectRootWriteRoutes(router)
    const stale = ROOT_EXEMPTIONS.filter(
      (e) => !all.some((r) => r.method === e.method && r.path === e.path),
    ).map((e) => `${e.method.toUpperCase()} ${ADMIN_MOUNT}${e.path}`)
    expect(stale, `豁免表里这些路由已经不存在了，请删掉对应豁免：\n${stale.join('\n')}`).toEqual([])
  })
})
