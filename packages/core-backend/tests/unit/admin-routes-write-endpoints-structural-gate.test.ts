/**
 * admin-routes 写路由「首位必须是 admin 门」的结构性守卫。
 *
 * 为什么要这条测试
 * ----------------
 * #5665 给 `admin-routes.ts` 里 12 条「只靠 `requireSafetyCheck` 」的写端点补了 `requireAdminRole()`
 * （`requireSafetyCheck` 是确认流程，`guards/middleware.ts` 内零角色判断，不是授权门）。但那是**逐条**
 * 加固，不是面上的保证 —— 该 PR 的设计文档
 * `docs/development/admin-safety-toggle-require-admin-design-20260912.md` §4 残余第 1 条原话：
 *
 *   「今后任何人在这个 router 里新加一条写路由而忘了加门，就会重新开洞。……
 *     要么加一条『本文件所有写方法必须首位是 admin 门』的结构性测试。」
 *
 * 本文件就是那条结构性测试：它不看某一条端点的行为，而是把**整棵 admin 路由树**拉出来，逐条写方法
 * 断言中间件链的首位是 admin 门；不满足又不在下面那张**显式豁免表**里的，直接红并点名 method + path。
 *
 * 识别机制（以及它为什么不是假件）
 * --------------------------------
 * `requireAdminRole()`（`src/guards/audit-integration.ts:113`）返回的是一个**匿名闭包**：
 * `fn.name === ''`，`Object.getOwnPropertyNames(fn) === ['length','name']` —— 没有任何可识别的标记属性，
 * 所以「按名字/属性认门」这条路走不通（实测，见验证文档）。
 *
 * 这里改用**函数源文本同一性**：同一个 `requireAdminRole` 定义产出的闭包，`toString()` 逐字相同
 * （闭包环境不进 `toString()`），而别的中间件的源文本必然不同。好处是**不需要 `vi.mock`**：被检查的
 * 就是生产代码真正挂上去的那个函数对象，不存在「测试里换了个带标记的假门、于是量的是假件」的问题。
 *
 * 这套识别的正反自证在 `describe('识别机制的正反自证')` 里逐条落地：
 *   正：`requireAdminRole()` 的两次调用互相匹配；`protectAdminOperation(...)` 的 **[0]** 匹配
 *       （实读 `audit-integration.ts:260-262`：`protectAdminOperation = [requireAdminRole(), auditSafetyOperation(op)]`
 *        —— 它**内含** admin 门且在首位，所以 `...protectAdminOperation(x)` 展开后首位仍是门）；
 *       已知有门的 `POST /safety/enable`（`admin-routes.ts:141`）首位匹配。
 *   反：`protectAdminOperation(...)` 的 **[1]**（审计中间件）不匹配；`requireSafetyCheck({...})` 不匹配
 *       （这正是 #5665 的要害：确认层不是授权门）；裸 `(req,res,next)=>next()` 不匹配；
 *       已知无门的读路由 `GET /slo/status`（`admin-routes.ts:1392`）首位不匹配。
 * 也就是说，这个匹配器既不是「谁都认」（反例全不匹配），也不是「谁都不认」（正例全匹配）。
 * 附带一提，「谁都不认」这种退化是**fail-closed** 的：匹配器失灵会让每条写路由都报违规、整片变红，
 * 不会静悄悄放行。
 *
 * 边界：本文件只管**写方法**（POST/PUT/PATCH/DELETE，外加 `router.all` —— 它同样应答写方法）。
 * 读侧（`GET /dlq`、`/queues`、`/shards*`、`/ratelimits*`、`/slo/status`、`/health/*`、`/safety/status`
 * 等无门 GET）是 #5665 §4 第 7 条登记的另一个面，本文件**不管**。
 *
 * 豁免表分两类，以及为什么必须分
 * ------------------------------
 * 核心不变量只有一条：**无门写路由 ⊆ 豁免表**（没登记的洞 = 红）。刻意**不是**等式。
 *
 * 等式（「豁免表恰等于今天的无门写路由集合」）看着更紧，实际有害：它等价于断言「豁免表里每一条
 * 今天都必须仍然无门」，于是**修洞的 PR 一合并，本 spec 就红**。#5667 / PR #5677（给 /safety/rules
 * 四条补门）与本支互相独立、可能先合 —— 硬红会把两条 PR 耦合成固定合并顺序，组合树验证还会假红。
 * 守卫的职责是拦住新洞，不是给修洞的人设路障。
 *
 * 所以豁免分两类（`Exemption.todo`）：
 *  - **永久豁免**（无 `todo`）：`POST /health/check`、两条 `*-unsafe`。理由是「设计上就不该有中间件门」。
 *    它们要是哪天有门了 = 设计变了 → **硬红**，必须来删豁免。
 *  - **临时豁免**（有 `todo`，如 `#5667`）：已登记、有人在修的洞。门补上了是我们盼着的结果 →
 *    **不红**，只用 `console.warn` 点名「这几条豁免已可删除」，让人看得见又不挡合并。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// --------------------------------------------------------------------------
// import 期依赖切断 —— 与 admin-safety-toggle-and-bulk-authz.test.ts 同款配方。
// 目的只是让 `admin-routes` 及其传递路由模块能在无库 lane 里被 import；本文件**不发任何 HTTP 请求**，
// 只读 router 对象的结构，所以这些桩不参与任何被断言的判定。
// --------------------------------------------------------------------------
vi.mock('../../src/rbac/service', () => ({ isAdmin: vi.fn(async () => false) }))
// 无库 lane：`pool: null` 让 logSafetyOperation 退化成 warn。
vi.mock('../../src/db/pg', () => ({ pool: null }))
// 切断 SnapshotService → audit → AuditRepository 这条在 import 期就要求真实连接池的链。
vi.mock('../../src/services/SnapshotService', () => ({}))
vi.mock('../../src/audit/audit', () => ({}))
vi.mock('../../src/db/kysely', () => {
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
  const db = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === 'then') return undefined
        return () => makeChain()
      },
    },
  )
  return { db, transaction: vi.fn() }
})

import type { NextFunction, Request, Response, Router } from 'express'
import adminRouter, { initAdminRoutes } from '../../src/routes/admin-routes'
import {
  OperationType,
  protectAdminOperation,
  requireAdminRole,
  requireSafetyCheck,
} from '../../src/guards'

// --------------------------------------------------------------------------
// 1. 识别机制
// --------------------------------------------------------------------------

type Handler = (...args: unknown[]) => unknown

/**
 * `requireAdminRole()` 闭包的源文本。同一个函数定义产出的每个闭包 `toString()` 逐字相同。
 */
const ADMIN_GATE_SOURCE = (requireAdminRole() as unknown as Handler).toString()

/** 这个 handler 是不是 `requireAdminRole()` 产出的门？ */
function isAdminGate(fn: unknown): boolean {
  return typeof fn === 'function' && (fn as Handler).toString() === ADMIN_GATE_SOURCE
}

// --------------------------------------------------------------------------
// 2. 豁免表 —— 显式、逐条实读确认、带理由。
//    不在这张表里、又没有门的写路由 = 红。
// --------------------------------------------------------------------------

type WriteMethod = 'post' | 'put' | 'patch' | 'delete'

interface Exemption {
  method: WriteMethod
  /** 相对 admin router 的完整路径（含子路由挂载前缀），不含 `/api/admin`。 */
  path: string
  reason: string
  /**
   * **临时豁免**标记：填 issue/PR 号（如 `'#5667'`）表示「这是个已登记、有人在修的洞」。
   *
   * 临时 vs 永久，差别只在「门补上之后怎么办」：
   *  - **永久豁免**（不填 `todo`）：设计上就不该有中间件门（只读探针 / 自带 in-handler 门）。
   *    如果有一天它有门了，说明设计变了 → **硬红**，必须来删豁免。
   *  - **临时豁免**（填 `todo`）：门补上就是我们盼着的结果。如果这里也硬红，那么修洞的那个 PR
   *    一合并就会把本 spec 打红，两条互相独立的 PR 被强耦合成固定合并顺序，组合树验证还会假红。
   *    所以临时豁免「已可删除」只**提示不拦**（见 `describe('豁免表')` 里那条 console.warn 用例）。
   */
  todo?: string
}

const EXEMPTIONS: readonly Exemption[] = [
  // ---- admin-routes.ts 本体 ----
  {
    method: 'post',
    path: '/health/check',
    reason:
      '只读探针：handler（admin-routes.ts:2047-2072）只调用 getHealthAggregator().checkHealth() 取一次快照并回摘要，' +
      '不写任何状态。#5665 设计 §2.1 据此判定它不属于「写/破坏性」面，未加门；' +
      '「任意已认证用户可触发的探测/放大面」记在 §4 残余第 4 条，属读侧、本文件不管。',
  },
  {
    method: 'post',
    path: '/plugins/reload-all-unsafe',
    reason:
      '自带 in-handler 双门（admin-routes.ts:770-785）：ALLOW_UNSAFE_ADMIN !== "true" → 403 UNSAFE_DISABLED；' +
      'req.user.roles 不含 "admin" → 403 ADMIN_REQUIRED。它不属于「只靠确认层」那一族。' +
      '但这条角色判断读的是 token 上的 roles 数组，而 requireAdminRole() 查 user_roles —— ' +
      '两套 admin 口径共存是 #5665 §4 残余第 5 条登记的待统一项，统一之前不强求它换成中间件门。',
  },
  {
    method: 'post',
    path: '/plugins/:id/reload-unsafe',
    reason:
      '同上，in-handler 双门在 admin-routes.ts:821-836；口径不一致同样记在 #5665 §4 残余第 5 条。',
  },

  // ---- 子路由 /safety/rules（protection-rules.ts）—— 全部是**临时豁免** ----
  // 这四条今天是**真的无门**，不是设计如此。#5665 设计 §2.1 / §4 残余第 7 条已登记：
  //   四条写端点零授权门，且身份取自**可伪造的 `x-user-id` 请求头`**（protection-rules.ts:21、:113）。
  //   issue #5667 / W4-A 分支 `fix/protection-rules-require-admin-and-identity`（PR #5677）正在修。
  //
  // 补门之后这四条豁免就该删掉，但**删豁免这件事不由本 spec 强制**：#5677 与本支互相独立、
  // 可能先合。若把「临时豁免覆盖了已有门路由」做成硬红，#5677 一合就会把本 spec 打红 ——
  // 两条独立 PR 被强耦合成固定合并顺序，组合树验证还会假红。所以它们走 `todo` 这一路：
  // 已可删除时只 console.warn 点名（见 `describe('豁免表')`），不拦合并。
  {
    method: 'post',
    path: '/safety/rules',
    todo: '#5667',
    reason: '在修（#5667 / PR #5677）：protection-rules.ts:111 创建规则，零授权门，身份取自 x-user-id 请求头。',
  },
  {
    method: 'patch',
    path: '/safety/rules/:id',
    todo: '#5667',
    reason: '在修（#5667 / PR #5677）：protection-rules.ts:203 改规则，零授权门。',
  },
  {
    method: 'delete',
    path: '/safety/rules/:id',
    todo: '#5667',
    reason: '在修（#5667 / PR #5677）：protection-rules.ts:244 删规则，零授权门。',
  },
  {
    method: 'post',
    path: '/safety/rules/evaluate',
    todo: '#5667',
    reason:
      '在修（#5667 / PR #5677）：protection-rules.ts:267 触发规则求值，零授权门。' +
      '（求值本身不落库，但它是 POST 且吃 body，按写方法口径一并登记；若 #5677 判定它只需读权限，' +
      '这条豁免与理由要一起改。）',
  },
]

/** 永久豁免：设计上就不该有中间件门。门补上了 = 设计变了 → 硬红。 */
const PERMANENT_EXEMPTIONS = EXEMPTIONS.filter((e) => !e.todo)
/** 临时豁免：已登记、有人在修的洞。门补上了 = 好事 → 只提示不拦。 */
const TEMPORARY_EXEMPTIONS = EXEMPTIONS.filter((e) => !!e.todo)

const EXEMPT_KEYS = new Set(EXEMPTIONS.map((e) => `${e.method} ${e.path}`))

/** 子路由挂载点的固定集合 —— 新增子路由必须来这里登记（admin-routes.ts:2086-2087）。 */
const EXPECTED_SUB_ROUTER_MOUNTS = ['/snapshots', '/safety/rules'] as const

/** `/api/admin` —— index.ts:1884 的挂载前缀，只用于把失败信息里的路径写成人读的样子。 */
const ADMIN_MOUNT = '/api/admin'

// --------------------------------------------------------------------------
// 3. 从真实 router 对象上取路由栈（express 4.21 内部结构）
// --------------------------------------------------------------------------

interface RouteHandlerLayer {
  handle: unknown
  /** express 给 `route.post(fn)` 这类 layer 打上的方法名；`route.all(fn)` 时为 undefined。 */
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
  regexp: RegExp & { fast_slash?: boolean }
}

interface RouterLike {
  stack: RouterLayer[]
}

const WRITE_METHODS: readonly WriteMethod[] = ['post', 'put', 'patch', 'delete']

function asRouterLike(router: Router): RouterLike {
  const candidate = router as unknown as RouterLike
  if (!Array.isArray(candidate.stack)) {
    throw new Error('express 内部结构变了：router.stack 不是数组，本守卫的取栈方式需要重写')
  }
  return candidate
}

function isSubRouter(handle: unknown): handle is Router {
  return typeof handle === 'function' && Array.isArray((handle as unknown as RouterLike).stack)
}

/**
 * express 4 的 `use` layer 不保留原始挂载路径（`layer.path` 恒为 undefined），只留下编译好的 regexp。
 * 这里从 `regexp.source` 反解出挂载路径，**并且用同一个 regexp 回验**反解结果 —— 解错了就抛，
 * 不会悄悄给出一个错的挂载点。
 */
function decodeMountPath(layer: RouterLayer): string {
  const rx = layer.regexp
  if (!rx || typeof rx.source !== 'string') {
    throw new Error('express 内部结构变了：use layer 没有 regexp，本守卫的挂载点反解需要重写')
  }
  if (rx.fast_slash) return '/'
  const TAIL = '\\/?(?=\\/|$)'
  const source = rx.source
  if (!source.startsWith('^') || !source.endsWith(TAIL)) {
    throw new Error(`无法反解子路由挂载点（regexp=${String(rx)}）：本守卫的挂载点反解需要重写`)
  }
  const decoded = source.slice(1, source.length - TAIL.length).replace(/\\(.)/g, '$1')
  if (!rx.test(decoded)) {
    throw new Error(`子路由挂载点反解自检失败：regexp=${String(rx)} 反解出 ${decoded}`)
  }
  return decoded
}

function joinPath(mount: string, path: string): string {
  const left = mount === '/' ? '' : mount.replace(/\/+$/, '')
  const right = path === '/' ? '' : path
  return `${left}${right}` || '/'
}

interface WriteRoute {
  method: WriteMethod
  /** 相对 admin router 的完整路径（含子路由挂载前缀）。 */
  path: string
  /** 失败信息里点名用的人读标签。 */
  label: string
  /** 该 method 在这条路由上的**首个** handler。 */
  firstHandler: unknown
  /** 来源：'root' = admin-routes.ts 本体；否则是子路由挂载点。 */
  source: string
}

function collectWriteRoutes(router: Router, mount: string, source: string): WriteRoute[] {
  const out: WriteRoute[] = []
  for (const layer of asRouterLike(router).stack) {
    if (layer.route) {
      const route = layer.route
      if (typeof route.path !== 'string') {
        throw new Error(
          `不支持的路由路径类型（${String(route.path)}）：数组/正则路径会让本守卫的点名失真，请改写守卫或改写路由`,
        )
      }
      const fullPath = joinPath(mount, route.path)
      // `router.all(path, fn)` 也应答 POST/PUT/PATCH/DELETE —— 不能从写面里漏掉。
      const isAll = route.methods._all === true
      for (const method of WRITE_METHODS) {
        if (!isAll && route.methods[method] !== true) continue
        const handlerLayer = isAll
          ? route.stack[0]
          : route.stack.find((l) => l.method === method)
        out.push({
          method,
          path: fullPath,
          label: `${method.toUpperCase()} ${ADMIN_MOUNT}${fullPath}${isAll ? ' (via router.all)' : ''}`,
          firstHandler: handlerLayer?.handle,
          source,
        })
      }
    } else if (isSubRouter(layer.handle)) {
      const subMount = decodeMountPath(layer)
      out.push(...collectWriteRoutes(layer.handle, joinPath(mount, subMount), subMount))
    }
  }
  return out
}

/** 一次审计：返回「没有 admin 门」的写路由（含豁免的，供不同用例各取所需）。 */
function auditWriteRoutes(router: Router): {
  all: WriteRoute[]
  ungated: WriteRoute[]
  violations: WriteRoute[]
} {
  const all = collectWriteRoutes(router, '', 'root')
  const ungated = all.filter((r) => !isAdminGate(r.firstHandler))
  const violations = ungated.filter((r) => !EXEMPT_KEYS.has(`${r.method} ${r.path}`))
  return { all, ungated, violations }
}

function describeViolations(violations: WriteRoute[]): string {
  return violations.map((v) => `  - ${v.label}`).join('\n')
}

function labelOf(e: Exemption): string {
  return `${e.method.toUpperCase()} ${ADMIN_MOUNT}${e.path}`
}

/** 给定一批豁免，挑出「对应路由今天**已经**有 admin 门」的那些 —— 即已可删除的豁免。 */
function exemptionsCoveringGatedRoutes(exemptions: readonly Exemption[]): Exemption[] {
  const { all } = auditWriteRoutes(router)
  return exemptions.filter((e) =>
    all.some((r) => r.method === e.method && r.path === e.path && isAdminGate(r.firstHandler)),
  )
}

// --------------------------------------------------------------------------
// 4. 用例
// --------------------------------------------------------------------------

let router: Router

beforeAll(() => {
  // initAdminRoutes 返回的就是 admin-routes.ts 的模块级单例 router（:69 建、:2132 返回），
  // 也就是 index.ts:1884 真正挂到 `/api/admin` 的那一个 —— 断言这一点，免得将来它变成
  // 「每次新建一个」而本守卫却在量一个没人用的对象。
  router = initAdminRoutes({})
  expect(router).toBe(adminRouter)
})

describe('识别机制的正反自证', () => {
  it('正：requireAdminRole() 的不同调用互相匹配（闭包环境不影响 toString 同一性）', () => {
    expect(isAdminGate(requireAdminRole())).toBe(true)
    expect(isAdminGate(requireAdminRole())).toBe(true)
  })

  it('正：protectAdminOperation(...) 是 [admin 门, 审计]，首位就是门；反：第二位不是门', () => {
    const chain = protectAdminOperation(OperationType.FORCE_RELOAD)
    expect(Array.isArray(chain)).toBe(true)
    expect(chain).toHaveLength(2)
    // 这条就是「protectAdminOperation 内含 admin 门」的实读证据（audit-integration.ts:260-262）。
    expect(isAdminGate(chain[0])).toBe(true)
    expect(isAdminGate(chain[1])).toBe(false)
  })

  it('反：requireSafetyCheck(...) 不是 admin 门（确认层 ≠ 授权门，#5665 的要害）', () => {
    expect(isAdminGate(requireSafetyCheck({ operation: OperationType.RESET_METRICS }))).toBe(false)
  })

  it('反：裸中间件 / 非函数都不是 admin 门', () => {
    expect(isAdminGate((_req: Request, _res: Response, next: NextFunction) => next())).toBe(false)
    expect(isAdminGate(undefined)).toBe(false)
    expect(isAdminGate(null)).toBe(false)
    expect(isAdminGate('requireAdminRole')).toBe(false)
  })

  it('正：已知有门的 POST /safety/enable（admin-routes.ts:141）首位被认出来', () => {
    const route = auditWriteRoutes(router).all.find(
      (r) => r.method === 'post' && r.path === '/safety/enable',
    )
    expect(route, 'POST /safety/enable 没被收集到，取栈方式可能失效了').toBeDefined()
    expect(isAdminGate(route!.firstHandler)).toBe(true)
  })

  it('反：已知无门的读路由 GET /slo/status（admin-routes.ts:1392）首位不被认出来', () => {
    // 读路由不在写面收集里，这里直接从栈上取，证明匹配器不是「见 handler 就说是门」。
    const layer = asRouterLike(router).stack.find(
      (l) => l.route?.path === '/slo/status' && l.route.methods.get === true,
    )
    expect(layer, 'GET /slo/status 没找到，取栈方式可能失效了').toBeDefined()
    expect(isAdminGate(layer!.route!.stack[0]?.handle)).toBe(false)
  })
})

describe('结构性保证：每条写路由的首位都是 admin 门', () => {
  it('写路由确实被收集到了（防止「零条写路由」式的空转绿）', () => {
    const { all } = auditWriteRoutes(router)
    expect(all.length).toBeGreaterThanOrEqual(25)
    // 有门的那一族必须非空，否则说明匹配器整体失灵（虽然那种失灵是 fail-closed 的）。
    expect(all.filter((r) => isAdminGate(r.firstHandler)).length).toBeGreaterThanOrEqual(20)
  })

  it('没有「既无 admin 门、又不在豁免表里」的写路由', () => {
    const { violations } = auditWriteRoutes(router)
    expect(
      violations,
      violations.length === 0
        ? ''
        : '以下写路由的中间件链首位不是 requireAdminRole()/protectAdminOperation(...)，' +
          '也不在本文件的豁免表里：\n' +
          describeViolations(violations) +
          '\n\n要么给它加门（首位 requireAdminRole() 或 ...protectAdminOperation(OperationType.X)），' +
          '要么在 EXEMPTIONS 里显式登记并写清理由。确认层 requireSafetyCheck 不算门。',
    ).toEqual([])
  })

  it('#5665 补门的那一族逐条仍然有门（回归钉）', () => {
    const { all } = auditWriteRoutes(router)
    const PINNED: Array<[WriteMethod, string]> = [
      ['post', '/safety/enable'],
      ['post', '/safety/disable'],
      ['post', '/safety/confirm'], // 自带 requireAdminRole()（admin-routes.ts:92）—— 直接通过，不需要豁免
      ['post', '/cache/clear'],
      ['post', '/metrics/reset'],
      ['put', '/data/bulk'],
      ['delete', '/data/bulk'],
      ['post', '/dlq/:id/retry'],
      ['delete', '/dlq/:id'],
      ['post', '/dlq/retry-all'],
      ['post', '/dlq/cleanup'],
      ['post', '/ratelimits/:key/reset'],
      ['post', '/ratelimits/reset-all'],
      ['delete', '/snapshots/:id'],
    ]
    const missing = PINNED.filter(([method, path]) => {
      const route = all.find((r) => r.method === method && r.path === path)
      return !route || !isAdminGate(route.firstHandler)
    }).map(([method, path]) => `${method.toUpperCase()} ${ADMIN_MOUNT}${path}`)
    expect(missing, `以下 #5665 已补门的路由丢了门或丢了路由：\n${missing.join('\n')}`).toEqual([])
  })
})

describe('豁免表', () => {
  it('每条豁免都对应一条真实存在的写路由（禁止残留过期豁免）', () => {
    const { all } = auditWriteRoutes(router)
    const stale = EXEMPTIONS.filter(
      (e) => !all.some((r) => r.method === e.method && r.path === e.path),
    ).map((e) => `${e.method.toUpperCase()} ${ADMIN_MOUNT}${e.path}`)
    expect(stale, `豁免表里这些路由已经不存在了，请删掉对应豁免：\n${stale.join('\n')}`).toEqual([])
  })

  it('永久豁免不得覆盖已经有门的路由（门补上了 = 设计变了，必须删豁免）', () => {
    const nowGated = exemptionsCoveringGatedRoutes(PERMANENT_EXEMPTIONS).map(labelOf)
    expect(
      nowGated,
      '以下路由已经有 admin 门了，而它们登记的是**永久**豁免（理由是「设计上不该有中间件门」）——\n' +
        nowGated.join('\n') +
        '\n门补上说明那个理由不再成立，请从 EXEMPTIONS 里删掉对应条目。',
    ).toEqual([])
  })

  // 刻意**不**硬红：见 Exemption.todo 的注释。#5667/#5677 与本支互相独立、可能先合，
  // 硬红会把两条 PR 耦合成固定合并顺序，并让组合树验证假红。
  it('临时豁免：已可删除的条目只点名提示、不挡合并', () => {
    const removable = exemptionsCoveringGatedRoutes(TEMPORARY_EXEMPTIONS)
    if (removable.length > 0) {
      console.warn(
        `[结构性守卫] ${removable.length} 条临时豁免已可删除 —— 对应路由已经补上 admin 门：\n` +
          removable.map((e) => `  - ${labelOf(e)}  (todo: ${e.todo})`).join('\n') +
          '\n请在对应 issue 收口时从本 spec 的 EXEMPTIONS 里删掉这些条目。' +
          '（这里只提示不失败：修洞的 PR 不该因为本 spec 而被挡住。）',
      )
    }
    // 断言的是「这份可删除清单是良构且有界的」，不是「它必须为空」：
    // 每条都带 todo 标记，且不会多于临时豁免总数。
    expect(removable.every((e) => !!e.todo)).toBe(true)
    expect(removable.length).toBeLessThanOrEqual(TEMPORARY_EXEMPTIONS.length)
  })

  it('每条豁免都写了理由；临时豁免的 todo 必须是 issue/PR 号', () => {
    for (const e of EXEMPTIONS) {
      expect(e.reason.trim().length, `${e.method} ${e.path} 的豁免没写理由`).toBeGreaterThan(20)
    }
    for (const e of TEMPORARY_EXEMPTIONS) {
      expect(e.todo, `${e.method} ${e.path} 的临时豁免 todo 不是 #<号>`).toMatch(/^#\d+$/)
    }
    expect(PERMANENT_EXEMPTIONS.length + TEMPORARY_EXEMPTIONS.length).toBe(EXEMPTIONS.length)
  })

  // 核心不变量：**无门写路由 ⊆ 豁免表**。
  // 刻意不是等式 —— 等式意味着「豁免表里每一条今天都必须仍然无门」，那等于把
  // 「谁先合并」写进了断言（#5677 补门后等式立刻不成立）。子集关系才是这条守卫真正要的：
  // 可以有已经被修好的豁免（多余但无害），不可以有没登记的洞。
  it('无门写路由 ⊆ 豁免表（核心不变量）', () => {
    const { ungated, violations } = auditWriteRoutes(router)
    expect(violations, `以下无门写路由不在豁免表里：\n${describeViolations(violations)}`).toEqual([])
    const ungatedKeys = ungated.map((r) => `${r.method} ${r.path}`)
    expect(ungatedKeys.every((k) => EXEMPT_KEYS.has(k))).toBe(true)
    expect(ungated.length).toBeLessThanOrEqual(EXEMPTIONS.length)
    // 注意这里**没有**「无门路由必须非空」的断言：那会让「所有洞都被补上、豁免表清空」这个
    // 最好的结局反而变红。「豁免表确实在承担工作、不是空转」由 `describe('变异自证')` 证明。
  })
})

describe('子路由挂载面', () => {
  it('router.use 挂的子路由恰好是固定集合，且没有挂载级中间件', () => {
    const useLayers = asRouterLike(router).stack.filter((l) => !l.route)
    const subRouterMounts: string[] = []
    const nonRouterUse: string[] = []
    for (const layer of useLayers) {
      if (isSubRouter(layer.handle)) subRouterMounts.push(decodeMountPath(layer))
      else nonRouterUse.push(String(layer.regexp))
    }
    expect(
      subRouterMounts,
      '新挂了子路由？请在 EXPECTED_SUB_ROUTER_MOUNTS 里登记，并确认它的写路由首位也有 admin 门 ——' +
        '本守卫会递归检查子路由，但挂载面本身要显式过一遍眼。',
    ).toEqual([...EXPECTED_SUB_ROUTER_MOUNTS])
    // 今天 admin router 顶层**没有**任何 use 级中间件，所以「逐条查首位」是充分的：
    // 不存在「挂载处套了一层门、于是逐条不必有门」的情况。将来真要在挂载处套门，这条会红，
    // 到时候必须回来重新论证本守卫的充分性（而不是默默放宽）。
    expect(
      nonRouterUse,
      `admin router 顶层出现了 use 级中间件：${nonRouterUse.join(', ')}。` +
        '本守卫「逐条写路由必须自带门」的充分性论证建立在「顶层无 use 级中间件」之上，请回来重新论证。',
    ).toEqual([])
  })

  it('/snapshots 子路由（snapshot-labels.ts）的三条写路由都有门', () => {
    const subRoutes = auditWriteRoutes(router).all.filter((r) => r.source === '/snapshots')
    expect(subRoutes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'patch /snapshots/:id/protection',
      'patch /snapshots/:id/release-channel',
      'put /snapshots/:id/tags',
    ])
    for (const r of subRoutes) {
      expect(isAdminGate(r.firstHandler), `${r.label} 丢了 admin 门`).toBe(true)
    }
  })

  // 同样刻意**不**硬判门的有无：#5667/#5677 补门后若这里断言 `false` 就会红，又把两支耦合起来。
  // 路径集合是稳定事实（硬断言），门的有无只记录 + 提示。
  it('/safety/rules 子路由（protection-rules.ts）的四条写路由：路径集合固定，门的有无只记录', () => {
    const subRoutes = auditWriteRoutes(router).all.filter((r) => r.source === '/safety/rules')
    expect(subRoutes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'delete /safety/rules/:id',
      'patch /safety/rules/:id',
      'post /safety/rules',
      'post /safety/rules/evaluate',
    ])
    const gated = subRoutes.filter((r) => isAdminGate(r.firstHandler))
    if (gated.length > 0) {
      console.warn(
        `[结构性守卫] /safety/rules 已有 ${gated.length}/4 条写路由补上了 admin 门` +
          '（#5667 / PR #5677 生效中）：\n' +
          gated.map((r) => `  - ${r.label}`).join('\n') +
          '\n四条都补齐后，请把本 spec EXEMPTIONS 里那四条 todo:#5667 的临时豁免删掉。',
      )
    }
    // 每条要么有门要么无门 —— 这条只是确保上面的分类没漏人，不对「应该是哪种」表态。
    expect(gated.length + subRoutes.filter((r) => !isAdminGate(r.firstHandler)).length).toBe(4)
  })
})

// --------------------------------------------------------------------------
// 5. 变异自证（内存级，不改源码、不落盘）
//    证明「去掉守卫/开一个洞，测试就红」，而不是这套断言恒绿。
// --------------------------------------------------------------------------
describe('变异自证', () => {
  // 这里直接改的是**模块单例** router，所以每个用例都必须在 finally 里还原。
  // （没有用 beforeAll 做变异：单例被改坏会污染本文件其余全部用例，而不是只污染变异用例。）
  afterEach(() => {
    const { violations } = auditWriteRoutes(router)
    expect(violations, '变异用例没有把 router 还原干净').toEqual([])
  })

  it('摘掉 PUT /data/bulk 的首个 handler（= 去掉 #5665 补的门）→ 红并点名该路由', () => {
    const layer = asRouterLike(router).stack.find(
      (l) => l.route?.path === '/data/bulk' && l.route.methods.put === true,
    )
    expect(layer, 'PUT /data/bulk 没找到').toBeDefined()
    const stack = layer!.route!.stack
    const removed = stack.splice(0, 1)
    expect(isAdminGate(removed[0].handle), '摘掉的应该正是 admin 门').toBe(true)
    try {
      const { violations } = auditWriteRoutes(router)
      expect(violations.map((v) => v.label)).toEqual([`PUT ${ADMIN_MOUNT}/data/bulk`])
    } finally {
      stack.splice(0, 0, ...removed)
    }
    // 还原后立刻复检（afterEach 也会再查一次）。
    expect(auditWriteRoutes(router).violations).toEqual([])
  })

  it('新加一条无门写路由（= §4 残余第 1 条描述的开洞方式）→ 红并点名该路由', () => {
    const stack = asRouterLike(router).stack
    const before = stack.length
    // 这正是「今后任何人在这个 router 里新加一条写路由而忘了加门」的那一刻。
    router.post('/w4b-mutation-probe/:id', (_req: Request, res: Response) => {
      res.json({ ok: true })
    })
    try {
      expect(stack.length).toBe(before + 1)
      const { violations } = auditWriteRoutes(router)
      expect(violations.map((v) => v.label)).toEqual([
        `POST ${ADMIN_MOUNT}/w4b-mutation-probe/:id`,
      ])
    } finally {
      stack.length = before
    }
    expect(auditWriteRoutes(router).violations).toEqual([])
  })

  it('把门换成 requireSafetyCheck（= #5665 修前的形状）→ 仍然红', () => {
    const layer = asRouterLike(router).stack.find(
      (l) => l.route?.path === '/cache/clear' && l.route.methods.post === true,
    )
    expect(layer, 'POST /cache/clear 没找到').toBeDefined()
    const stack = layer!.route!.stack
    const original = stack[0].handle
    stack[0] = {
      ...stack[0],
      handle: requireSafetyCheck({ operation: OperationType.CLEAR_CACHE }),
    }
    try {
      const { violations } = auditWriteRoutes(router)
      expect(violations.map((v) => v.label)).toEqual([`POST ${ADMIN_MOUNT}/cache/clear`])
    } finally {
      stack[0] = { ...stack[0], handle: original }
    }
    expect(auditWriteRoutes(router).violations).toEqual([])
  })

  it('把豁免表清空 → 今天全部无门写路由都会变成违规（证明豁免表是真的在生效、不是空转）', () => {
    const { ungated, violations } = auditWriteRoutes(router)
    // 「豁免表清空」= 不做豁免过滤，违规集合就等于全部无门写路由。
    // 不改 EXEMPT_KEYS 本身（const，且被其他用例共享），这里等价地重算一遍。
    const withoutExemptions = ungated.map((r) => r.label)
    expect(withoutExemptions.length).toBe(ungated.length)
    // 有豁免时零违规、无豁免时违规数 = 无门路由数 —— 两者之差就是豁免表实际挡下的量。
    expect(violations).toEqual([])
    expect(withoutExemptions.length - violations.length).toBe(ungated.length)
    // 今天豁免表确实在承担工作（>0）。这里用 ungated.length 而不是写死 7：
    // #5667/#5677 补门后无门路由会减少，写死的数字会假红。全部补齐（归零）时本条会转为
    // 「豁免表已无事可做」——那时 PERMANENT/TEMPORARY 两条用例会分别硬红/提示，指引删豁免。
    if (EXEMPTIONS.length > 0 && ungated.length === 0) {
      console.warn('[结构性守卫] 全部写路由都已有门，豁免表已无事可做 —— 可以整张删掉了。')
    }
    expect(ungated.length).toBeLessThanOrEqual(EXEMPTIONS.length)
  })
})
