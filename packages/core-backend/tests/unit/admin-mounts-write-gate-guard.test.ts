/**
 * `/api/admin` 挂载点下、**不经 `admin-routes.ts`** 的 7 个 router（外加 `permissions.ts` 的
 * `/api/admin/**` 切片）的写路由守卫 —— #5680 的扩面。
 *
 * Refreshed 2026-10-10 against main 1b843faee: registry unchanged (67 entries); line refs replaced
 * by self-verifying anchors.（登记表不变，仍是 67 条；文件里不再有任何源码行号，改为能对源码自证的锚点。）
 *
 * 为什么不能照搬 #5680 的「中间件首位必须是门」判据：
 *   本批 67 条写路由里只有 `canary-routes.ts` 的 4 条把门放在中间件位（`requireAdminRole()`）。
 *   其余 63 条的门在**处理器体内**（`ensurePlatformAdmin` / `ensureRoleDelegationAdmin` / `isAdmin` 直调）：
 *   58 条是处理器第一条语句（56 条平台门 + 2 条委派门）；reactivate / force-reactivate / compensate 3 条
 *   先调 helper，helper 的第一条语句是门；restore 1 条先做无副作用的 mode 解析再过门（见登记表注释）；
 *   permissions 1 条先判 pool 与身份再直调 `isAdmin`（2026-10-10 刷新时逐条实读）。
 *   用 `router.stack` 看中间件链，只会看到「首位 = `authenticate`（仅认证）」或「首位 = 唯一的处理器」。照搬结构判据会把这 63 条全判红（假红），进而逼人为了过测试去挪代码。
 *   所以这里换成两条断言，缺一不可：
 *     (A) 行为：逐条写路由，非管理员 -> 该 router 既有的拒绝码，且下游 service / DB / 审计零调用；
 *     (B) 清单双向反查：从 `router.stack` 枚举出的写路由集合，必须与本文件的登记表**双向**相等。
 *   (A) 证明「登记在案的这些路由确实有门」，(B) 证明「没有门的新路由不可能悄悄溜进来」——
 *   只有 (A) 的话，新增写路由不会让任何测试变红；只有 (B) 的话，登记表里的门可以被掏空而不被发现。
 *
 * 盘点来源：`docs/development/admin-mounts-write-gate-inventory-20260912.md`（W4-I，基线
 * `origin/main` @ `9fb29831c`）。设计说明与盲区：`docs/development/admin-mounts-write-gate-guard-design-20260912.md`。
 *
 * 锚点不写行号（行号随每次改 `admin-users.ts` / `index.ts` 漂移，写了就会过期）：挂载点记 `index.ts`
 * 里挂载语句的原文（`MOUNTS[*].source`），登记表记注册文件（`reg`）与门函数名链（`gate`）。「fixture 自检」
 * 逐条对源码核对：挂载语句在 `index.ts` 里恰好一处、其字面路径 = `mountPath`；`(method, path)` 在注册文件里
 * 恰好注册一处；门函数在该注册的处理器区间里被调用（经 helper 的，helper 的第一条语句就是门）。
 *
 * 三个必须显式说明的构造：
 *
 * 1) `middleware/auth` 被 mock 成 pass-through。真实的 `authenticate` 是 `jwtAuthMiddleware`，
 *    在没有 Bearer token 时直接 401 `UNAUTHORIZED`（"Missing Bearer token"）——那样每条
 *    `admin-users` / `permissions` 路由都会在**到达 admin 门之前**就被拦下，测试全绿却一寸也没量到
 *    admin 门（实测过：不 mock 时这 28 条全部返回 401 "Missing Bearer token"）。生产上 `req.user`
 *    由全局 JWT 闸填充（`index.ts` 里「全局 JWT 保护 `/api/**`」那段 `this.app.use`：不在 `isWhitelisted`
 *    豁免表里的 API 路径走 `jwtAuthMiddleware`，`/api/admin` 不在豁免表内），这里用一个 app 级中间件
 *    直接注入 `req.user` 来还原那一步。
 *
 * 2) 注入的非管理员 `req.user` 必须同时不满足 `hasLegacyAdminClaim` 的**四种形态**，否则假绿：
 *    `role === 'admin'` / `roles` 含 `'admin'` / `perms` 含 `'*:*'`（或 `'admin:all'`）/
 *    `permissions` 含 `'*:*'`。两份副本（`routes/admin-directory.ts` 的私有 `hasLegacyAdminClaim`，与
 *    `admin-users.ts` import 的 `rbac/platform-admin.ts` `hasLegacyAdminClaim`——后者是 `admin-users.ts`
 *    原私有副本原样迁出的）认的形态并不完全一致，取并集才安全。下面的
 *    `LEGACY_CLAIM_PREDICATES` 把四种形态写成谓词并对 fixture 自检——fixture 若被改成带 claim，
 *    自检先红，而不是让 67 条 403 断言悄悄变成「门根本没跑」。
 *
 * 3) 下游零调用的探针是「模块级绊线」：把每个 router 直接依赖的 service 模块的函数导出换成记录调用名的
 *    桩（类导出与常量原样保留），再断言记录为空。DB（`db/pg` 的 `query`/`transaction`/`pool.query`）
 *    与审计（`audit/audit`）另算一份预算，按门的族别逐族声明（见 `EFFECT_BUDGET`）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express, { type Express, type NextFunction, type Request, type Response, type Router } from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedServer } from '../utils/pinned-server'

// ---------------------------------------------------------------------------
// 下游效果探针（模块级绊线）
// ---------------------------------------------------------------------------

const probe = vi.hoisted(() => {
  const calls: string[] = []
  const isClassExport = (value: unknown): boolean =>
    typeof value === 'function' && /^class[\s{]/.test(Function.prototype.toString.call(value))
  return {
    calls,
    reset(): void {
      calls.length = 0
    },
    /**
     * 把模块的**函数**导出换成记录调用名的桩；类导出（错误类等，`instanceof` 依赖构造函数身份）、
     * 常量、对象导出原样保留。`keep` 用于放过在模块加载期就会被调用的导出
     * （例如 `access-presets.listAccessPresets`：`admin-users.ts` 在模块作用域初始化 `ATTENDANCE_ROLE_IDS`
     * 时就调用它）。
     */
    wrap(actual: Record<string, unknown>, label: string, keep: string[] = []): Record<string, unknown> {
      const out: Record<string, unknown> = { ...actual }
      for (const [name, value] of Object.entries(actual)) {
        if (typeof value !== 'function' || isClassExport(value) || keep.includes(name)) continue
        out[name] = (..._args: unknown[]) => {
          calls.push(`${label}.${name}`)
          return undefined
        }
      }
      return out
    },
  }
})

const pg = vi.hoisted(() => ({
  query: vi.fn(),
  transaction: vi.fn(),
  poolQuery: vi.fn(),
}))

const rbac = vi.hoisted(() => ({
  isAdmin: vi.fn(),
}))

// `pool` 必须是**真值**：`permissions.ts` 的 `/api/admin/permission-templates/apply` 处理器在身份/权限判定
// 之前有 `if (!pool) return 503`，
// pool=null 会让这条路由在无 DB 环境里答 503 而不是 403——那样这条断言就不是在量门了。
vi.mock('../../src/db/pg', () => ({
  pool: { query: pg.poolQuery },
  query: pg.query,
  transaction: pg.transaction,
  getPoolStats: () => ({ total: 0, idle: 0, waiting: 0 }),
}))

// 见文件头注释 (1)：真实 `authenticate` 会在到达 admin 门之前 401，掩盖掉本文件要量的东西。
vi.mock('../../src/middleware/auth', () => {
  const passThrough = (_req: Request, _res: Response, next: NextFunction) => next()
  return { authenticate: passThrough, authMiddleware: passThrough, default: passThrough }
})

// `isAdmin` 是三套判据共同的兜底（`rbac/service.ts` 的 `isAdmin` -> `user_roles`），由本文件驱动；
// 同模块的其它导出照样上绊线。
vi.mock('../../src/rbac/service', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...probe.wrap(actual, 'rbac/service', ['isAdmin']), isAdmin: rbac.isAdmin }
})

vi.mock('../../src/audit/audit', async (importOriginal) =>
  probe.wrap(await importOriginal<Record<string, unknown>>(), 'audit'))
vi.mock('../../src/directory/directory-sync', async (importOriginal) =>
  probe.wrap(await importOriginal<Record<string, unknown>>(), 'directory-sync'))
vi.mock('../../src/directory/directory-sync-scheduler', async (importOriginal) =>
  probe.wrap(await importOriginal<Record<string, unknown>>(), 'directory-sync-scheduler'))
vi.mock('../../src/directory/directory-sync-alert-delivery', async (importOriginal) =>
  probe.wrap(await importOriginal<Record<string, unknown>>(), 'directory-sync-alert-delivery'))
vi.mock('../../src/directory/deprovision-evidence-api', async (importOriginal) =>
  probe.wrap(await importOriginal<Record<string, unknown>>(), 'deprovision-evidence-api'))
vi.mock('../../src/directory/local-directory-org', async (importOriginal) =>
  probe.wrap(await importOriginal<Record<string, unknown>>(), 'local-directory-org'))
vi.mock('../../src/directory/department-binding-reconciliation', async (importOriginal) =>
  probe.wrap(await importOriginal<Record<string, unknown>>(), 'department-binding-reconciliation'))
vi.mock('../../src/directory/org-transfer-service', async (importOriginal) =>
  probe.wrap(await importOriginal<Record<string, unknown>>(), 'org-transfer-service'))
vi.mock('../../src/directory/access-graph-mutex', async (importOriginal) =>
  probe.wrap(await importOriginal<Record<string, unknown>>(), 'access-graph-mutex'))
vi.mock('../../src/services/ApprovalDirectoryOrg', async (importOriginal) =>
  probe.wrap(await importOriginal<Record<string, unknown>>(), 'approval-directory-org'))
vi.mock('../../src/integrations/dingtalk/work-notification-settings', async (importOriginal) =>
  probe.wrap(await importOriginal<Record<string, unknown>>(), 'dingtalk-work-notification-settings'))
vi.mock('../../src/integrations/dingtalk/approval-card-config', async (importOriginal) =>
  probe.wrap(await importOriginal<Record<string, unknown>>(), 'dingtalk-approval-card-config'))
vi.mock('../../src/auth/permission-templates', async (importOriginal) =>
  probe.wrap(await importOriginal<Record<string, unknown>>(), 'permission-templates'))
vi.mock('../../src/auth/session-revocation', async (importOriginal) =>
  probe.wrap(await importOriginal<Record<string, unknown>>(), 'session-revocation'))
vi.mock('../../src/auth/session-registry', async (importOriginal) =>
  probe.wrap(await importOriginal<Record<string, unknown>>(), 'session-registry'))
vi.mock('../../src/auth/user-activate', async (importOriginal) =>
  probe.wrap(await importOriginal<Record<string, unknown>>(), 'user-activate'))
vi.mock('../../src/auth/login-alias-service', async (importOriginal) =>
  probe.wrap(await importOriginal<Record<string, unknown>>(), 'login-alias-service'))
vi.mock('../../src/auth/invite-ledger', async (importOriginal) =>
  probe.wrap(await importOriginal<Record<string, unknown>>(), 'invite-ledger'))
vi.mock('../../src/auth/invite-tokens', async (importOriginal) =>
  probe.wrap(await importOriginal<Record<string, unknown>>(), 'invite-tokens'))
vi.mock('../../src/rbac/role-assignment', async (importOriginal) =>
  probe.wrap(await importOriginal<Record<string, unknown>>(), 'role-assignment'))
// `deriveDelegatedAdminNamespace` 保持真身：委派管理员口径（`admin-users.ts` 的 `ensureRoleDelegationAdmin`
// -> `deriveDelegableNamespaces`）要用它把
// `user_roles` 行推成命名空间，桩掉它会让「有委派命名空间」的正向控制组永远推不出命名空间。
vi.mock('../../src/rbac/namespace-admission', async (importOriginal) =>
  probe.wrap(await importOriginal<Record<string, unknown>>(), 'namespace-admission', ['deriveDelegatedAdminNamespace']))
// `listAccessPresets` 在 `admin-users.ts` 的模块作用域（`ATTENDANCE_ROLE_IDS` 初始化）被调用，桩掉会让模块加载就炸。
vi.mock('../../src/auth/access-presets', async (importOriginal) =>
  probe.wrap(await importOriginal<Record<string, unknown>>(), 'access-presets', ['listAccessPresets']))

import { CanaryRouter } from '../../src/canary/CanaryRouter'
import { adminDirectoryRouter } from '../../src/routes/admin-directory'
import { adminDirectoryDepartmentBindingsRouter } from '../../src/routes/admin-directory-department-bindings'
import { adminDirectoryLocalRouter } from '../../src/routes/admin-directory-local'
import { adminDirectoryOrgTransfersRouter } from '../../src/routes/admin-directory-org-transfers'
import { adminDirectoryRoutingPolicyRouter } from '../../src/routes/admin-directory-routing-policy'
import { adminUsersRouter } from '../../src/routes/admin-users'
import { canaryRoutes } from '../../src/routes/canary-routes'
import { permissionsRouter } from '../../src/routes/permissions'

// ---------------------------------------------------------------------------
// 挂载点
// ---------------------------------------------------------------------------

type WriteMethod = 'post' | 'put' | 'patch' | 'delete'
const WRITE_METHODS: WriteMethod[] = ['post', 'put', 'patch', 'delete']

/** 门的族别。拒绝码/拒绝形态按族走，不是一刀切 403。 */
type GateFamily =
  /** `ensurePlatformAdmin`（两份副本：`routes/admin-directory.ts` 导出的一份 / `routes/admin-users.ts` 导出的一份） */
  | 'platform'
  /** `ensureRoleDelegationAdmin`（`routes/admin-users.ts`）——有意的委派管理员口径，例外 */
  | 'delegation'
  /** `requireAdminRole()`（`guards/audit-integration.ts`），中间件首位 */
  | 'middleware'
  /** `routes/permissions.ts` 处理器内 `isAdmin` 直调 */
  | 'inline'

/** 每个门族的门函数名：`REGISTRY[*].gate` 里每条分支链的**最后一环**必须是它（自检）。 */
const FAMILY_GATE: Readonly<Record<GateFamily, string>> = {
  platform: 'ensurePlatformAdmin',
  delegation: 'ensureRoleDelegationAdmin',
  middleware: 'requireAdminRole',
  inline: 'isAdmin',
}

interface MountSpec {
  /** `index.ts` 里的挂载路径 */
  readonly mountPath: string
  /**
   * `src/index.ts` 里挂载这个 router 的语句原文（去掉缩进）。自检：`index.ts` 里恰好有一行（trim 后）
   * 与它逐字节相同；语句里的字面路径 = `mountPath`（不带字面路径的根挂载 ↔ `'/'`）；语句里调用的工厂名
   * = `factory.name`。挂载顺序（谁先接管前缀重叠的 URL）也由这些语句在 `index.ts` 里的先后算出。
   */
  readonly source: string
  /** router 工厂（本文件 import 的那个导出）；自检按函数名与 `index.ts` 挂载语句调用的工厂比对 */
  readonly factory: (...args: never[]) => unknown
  /** 注册这个 router 写路由的源文件（相对 `src/`）；`REGISTRY[*].reg` 必须等于它 */
  readonly routeFile: string
  readonly build: () => Router
}

type MountKey =
  | 'admin-users'
  | 'admin-directory-org-transfers'
  | 'admin-directory'
  | 'admin-directory-local'
  | 'admin-directory-department-bindings'
  | 'admin-directory-routing-policy'
  | 'canary'
  | 'permissions'

/**
 * canary 的 router 工厂是唯一带参的（`canaryRoutes(router: CanaryRouter)`）。这里自己造实例并给它的
 * 方法挂上探针——`CanaryRouter` 就是这个 router 的「下游 service」。
 */
function buildCanaryRouter(): Router {
  const instance = new CanaryRouter(false)
  const methods = ['getAllRules', 'getRule', 'updateRule', 'removeRule', 'promote', 'rollback'] as const
  for (const name of methods) {
    const original = instance[name].bind(instance) as (...args: never[]) => unknown
    vi.spyOn(instance, name).mockImplementation(((...args: never[]) => {
      probe.calls.push(`canary-router.${name}`)
      return original(...args)
    }) as never)
  }
  return canaryRoutes(instance)
}

const MOUNTS: Record<MountKey, MountSpec> = {
  // 根挂载，路由自带 `/api/admin/**` 绝对路径
  'admin-users': {
    mountPath: '/',
    source: 'this.app.use(adminUsersRouter())',
    factory: adminUsersRouter,
    routeFile: 'routes/admin-users.ts',
    build: () => adminUsersRouter(),
  },
  'admin-directory-org-transfers': {
    mountPath: '/api/admin/directory/org-transfers',
    source: "this.app.use('/api/admin/directory/org-transfers', adminDirectoryOrgTransfersRouter())",
    factory: adminDirectoryOrgTransfersRouter,
    routeFile: 'routes/admin-directory-org-transfers.ts',
    build: () => adminDirectoryOrgTransfersRouter(),
  },
  'admin-directory': {
    mountPath: '/api/admin/directory',
    source: "this.app.use('/api/admin/directory', adminDirectoryRouter())",
    factory: adminDirectoryRouter,
    routeFile: 'routes/admin-directory.ts',
    build: () => adminDirectoryRouter(),
  },
  'admin-directory-local': {
    mountPath: '/api/admin/directory/local',
    source: "this.app.use('/api/admin/directory/local', adminDirectoryLocalRouter())",
    factory: adminDirectoryLocalRouter,
    routeFile: 'routes/admin-directory-local.ts',
    build: () => adminDirectoryLocalRouter(),
  },
  'admin-directory-department-bindings': {
    mountPath: '/api/admin/directory/department-bindings',
    source: "this.app.use('/api/admin/directory/department-bindings', adminDirectoryDepartmentBindingsRouter())",
    factory: adminDirectoryDepartmentBindingsRouter,
    routeFile: 'routes/admin-directory-department-bindings.ts',
    build: () => adminDirectoryDepartmentBindingsRouter(),
  },
  'admin-directory-routing-policy': {
    mountPath: '/api/admin/directory/routing-policy',
    source: "this.app.use('/api/admin/directory/routing-policy', adminDirectoryRoutingPolicyRouter())",
    factory: adminDirectoryRoutingPolicyRouter,
    routeFile: 'routes/admin-directory-routing-policy.ts',
    build: () => adminDirectoryRoutingPolicyRouter(),
  },
  canary: {
    mountPath: '/api/admin/canary',
    source: "this.app.use('/api/admin/canary', canaryRoutes(canaryRouter))",
    factory: canaryRoutes,
    routeFile: 'routes/canary-routes.ts',
    build: buildCanaryRouter,
  },
  // 根挂载；只有 `/api/admin/permission-templates*` 两条属于本文件的范围（其余 `/api/permissions/**`
  // 不在 `/api/admin` 前缀下，见 W4-I §7「邻接管理面」，不在此判定）。
  permissions: {
    mountPath: '/',
    source: 'this.app.use(permissionsRouter())',
    factory: permissionsRouter,
    routeFile: 'routes/permissions.ts',
    build: () => permissionsRouter(),
  },
}

// ---------------------------------------------------------------------------
// 源码锚点：读真实源码，给「fixture 自检」核对 MOUNTS.source 与 REGISTRY 的 reg/gate
// ---------------------------------------------------------------------------

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src')
const sourceCache = new Map<string, string>()

/** 读 `src/` 下的源文件（统一成 LF，结果缓存）。 */
function readSource(relative: string): string {
  let text = sourceCache.get(relative)
  if (text === undefined) {
    text = fs.readFileSync(path.join(SRC_ROOT, relative), 'utf8').replace(/\r\n/g, '\n')
    sourceCache.set(relative, text)
  }
  return text
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

/** `this.app.use(<'字面路径', >?<工厂>(<实参>?))` —— 只认这一种形状，别的形状一律让自检红。 */
const MOUNT_STATEMENT = /^this\.app\.use\((?:'([^']*)', )?([A-Za-z_$][\w$]*)\((?:[A-Za-z_$][\w$]*)?\)\)$/

/** `index.ts` 里 trim 后与 `statement` 逐字节相同的行号（0 起）。 */
function indexStatementLines(statement: string): number[] {
  const lines = readSource('index.ts').split('\n')
  const hits: number[] = []
  lines.forEach((line, index) => {
    if (line.trim() === statement) hits.push(index)
  })
  return hits
}

/** 按挂载语句在 `index.ts` 里的先后排出的 MountKey（语句缺失时抛错——那时自检也已经红了）。 */
function indexMountOrder(): MountKey[] {
  const position = (mount: MountKey): number => {
    const hits = indexStatementLines(MOUNTS[mount].source)
    if (hits.length !== 1) throw new Error(`mount statement not found exactly once in index.ts: ${mount}`)
    return hits[0]
  }
  return (Object.keys(MOUNTS) as MountKey[]).sort((left, right) => position(left) - position(right))
}

/** 注册文件里 `const <name> = Router()` 的变量名——只有这些变量上的 `.post(...)` 等才算注册。 */
function routerVariables(text: string): string[] {
  return [...text.matchAll(/\bconst ([A-Za-z_$][\w$]*) = (?:express\.)?Router\(\)/g)].map((match) => match[1])
}

/**
 * `(method, path)` 在注册文件里的注册位置（字符偏移）。单行 `router.post('/x', ...)` 与多行
 * `router.post(\n    '/x',` 两种写法都认；路径字面量必须逐字节相同（带收尾引号，前缀不会误中）。
 */
function registrationOffsets(text: string, method: WriteMethod, routePath: string): number[] {
  const receivers = routerVariables(text).map(escapeRegExp).join('|')
  if (!receivers) return []
  const pattern = new RegExp(`\\b(?:${receivers})\\.${method}\\(\\s*(['"\`])${escapeRegExp(routePath)}\\1`, 'g')
  return [...text.matchAll(pattern)].map((match) => match.index ?? -1)
}

/**
 * 一处注册的处理器区间：从注册所在行起，到其后第一条缩进不深于注册行的非空行为止（是 `})` / `)` 收尾行
 * 就把它算进来）。prettier 风格下这正好是这次 `router.<method>(...)` 调用本身——不会延伸到相邻路由，
 * 也不会延伸到同文件里同样调用门函数的 helper，所以「区间里调用了门函数」量的是这条路由自己。
 */
function registrationRegion(text: string, offset: number): string {
  const lines = text.slice(text.lastIndexOf('\n', offset) + 1).split('\n')
  const indentOf = (line: string): number => line.length - line.trimStart().length
  const indent = indentOf(lines[0])
  for (let index = 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim()
    if (trimmed.length === 0 || indentOf(lines[index]) > indent) continue
    return lines.slice(0, /^[})]/.test(trimmed) ? index + 1 : index).join('\n')
  }
  return lines.join('\n')
}

/** helper 函数体的第一条语句（`function <name>(...) {` 之后第一行非空源码）。 */
function helperFirstStatement(text: string, helper: string): string | null {
  const definition = new RegExp(`\\bfunction ${escapeRegExp(helper)}\\(`).exec(text)
  if (!definition) return null
  const bodyStart = text.indexOf('{', definition.index)
  if (bodyStart < 0) return null
  const first = text.slice(bodyStart + 1).split('\n').map((line) => line.trim()).find((line) => line.length > 0)
  return first ?? null
}

/**
 * 解析 `gate`：`routes/<file>.ts <分支>[ / <分支>]`，分支 = `门函数` 或 `helper -> 门函数`；
 * 全角括号 `（…）` 里是说明文字，不参与解析。
 */
function parseGate(gate: string): { file: string; branches: string[][] } | null {
  const match = /^(routes\/[a-z-]+\.ts) (.+)$/.exec(gate)
  if (!match) return null
  const branches = match[2]
    .replace(/（[^）]*）/g, '')
    .split(/\s*\/\s*/)
    .map((branch) => branch.trim().split(/\s*->\s*/))
  if (branches.some((branch) => branch.some((link) => !IDENTIFIER.test(link)))) return null
  return { file: match[1], branches }
}

// ---------------------------------------------------------------------------
// 登记表（67 条）——`reg` = 注册文件，`gate` = 注册文件 + 门函数名链；均由「fixture 自检」对源码自证
// ---------------------------------------------------------------------------

interface WriteRouteEntry {
  readonly mount: MountKey
  readonly method: WriteMethod
  /** 与 `router.stack` 里 `layer.route.path` **逐字节相同**的注册路径 */
  readonly path: string
  /** 注册文件（相对 `src/`，= `MOUNTS[mount].routeFile`）；自检：该文件里 `(method, path)` 恰好注册一处 */
  readonly reg: string
  /**
   * `routes/<file>.ts <分支>[ / <分支>]`，分支 = `门函数` 或 `helper -> 门函数`，全角括号里是说明。
   * 自检：每条分支的第一环在这条注册的处理器区间里被调用；`helper -> 门函数` 的门函数是 helper 的第一条
   * 语句；最后一环 = `FAMILY_GATE[family]`。
   */
  readonly gate: string
  readonly family: GateFamily
}

const P = 'platform' as const
const D = 'delegation' as const

const REGISTRY: readonly WriteRouteEntry[] = [
  // --- routes/admin-users.ts（27 条；门为处理器第一条语句） ---
  { mount: 'admin-users', method: 'post', path: '/api/admin/role-delegation/member-groups', reg: 'routes/admin-users.ts', gate: 'routes/admin-users.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-users', method: 'post', path: '/api/admin/role-delegation/scope-templates', reg: 'routes/admin-users.ts', gate: 'routes/admin-users.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-users', method: 'post', path: '/api/admin/role-delegation/scope-templates/:templateId/departments/:action(assign|unassign)', reg: 'routes/admin-users.ts', gate: 'routes/admin-users.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-users', method: 'post', path: '/api/admin/role-delegation/scope-templates/:templateId/member-groups/:action(assign|unassign)', reg: 'routes/admin-users.ts', gate: 'routes/admin-users.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-users', method: 'post', path: '/api/admin/role-delegation/users/:userId/scopes/:action(assign|unassign)', reg: 'routes/admin-users.ts', gate: 'routes/admin-users.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-users', method: 'post', path: '/api/admin/role-delegation/users/:userId/scope-groups/:action(assign|unassign)', reg: 'routes/admin-users.ts', gate: 'routes/admin-users.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-users', method: 'post', path: '/api/admin/role-delegation/users/:userId/member-groups/:action(assign|unassign)', reg: 'routes/admin-users.ts', gate: 'routes/admin-users.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-users', method: 'post', path: '/api/admin/role-delegation/users/:userId/scope-templates/apply', reg: 'routes/admin-users.ts', gate: 'routes/admin-users.ts ensurePlatformAdmin', family: P },
  // 例外 1/2：委派管理员口径（见 EXCEPTIONS）
  { mount: 'admin-users', method: 'patch', path: '/api/admin/role-delegation/users/:userId/namespaces/:namespace/admission', reg: 'routes/admin-users.ts', gate: 'routes/admin-users.ts ensureRoleDelegationAdmin', family: D },
  // 例外 2/2
  { mount: 'admin-users', method: 'post', path: '/api/admin/role-delegation/users/:userId/roles/:action(assign|unassign)', reg: 'routes/admin-users.ts', gate: 'routes/admin-users.ts ensureRoleDelegationAdmin', family: D },
  { mount: 'admin-users', method: 'post', path: '/api/admin/invites/:inviteId/revoke', reg: 'routes/admin-users.ts', gate: 'routes/admin-users.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-users', method: 'post', path: '/api/admin/invites/:inviteId/resend', reg: 'routes/admin-users.ts', gate: 'routes/admin-users.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-users', method: 'post', path: '/api/admin/users', reg: 'routes/admin-users.ts', gate: 'routes/admin-users.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-users', method: 'patch', path: '/api/admin/users/:userId/profile', reg: 'routes/admin-users.ts', gate: 'routes/admin-users.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-users', method: 'patch', path: '/api/admin/users/:userId/namespaces/:namespace/admission', reg: 'routes/admin-users.ts', gate: 'routes/admin-users.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-users', method: 'post', path: '/api/admin/users/namespaces/:namespace/admission/bulk', reg: 'routes/admin-users.ts', gate: 'routes/admin-users.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-users', method: 'patch', path: '/api/admin/users/:userId/dingtalk-grant', reg: 'routes/admin-users.ts', gate: 'routes/admin-users.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-users', method: 'post', path: '/api/admin/users/dingtalk-grants/bulk', reg: 'routes/admin-users.ts', gate: 'routes/admin-users.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-users', method: 'post', path: '/api/admin/users/:userId/roles/assign', reg: 'routes/admin-users.ts', gate: 'routes/admin-users.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-users', method: 'post', path: '/api/admin/users/:userId/roles/unassign', reg: 'routes/admin-users.ts', gate: 'routes/admin-users.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-users', method: 'patch', path: '/api/admin/users/:userId/status', reg: 'routes/admin-users.ts', gate: 'routes/admin-users.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-users', method: 'post', path: '/api/admin/users/:userId/reset-password', reg: 'routes/admin-users.ts', gate: 'routes/admin-users.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-users', method: 'post', path: '/api/admin/users/:userId/revoke-sessions', reg: 'routes/admin-users.ts', gate: 'routes/admin-users.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-users', method: 'post', path: '/api/admin/users/:userId/sessions/:sessionId/revoke', reg: 'routes/admin-users.ts', gate: 'routes/admin-users.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-users', method: 'post', path: '/api/admin/users/activate/bulk', reg: 'routes/admin-users.ts', gate: 'routes/admin-users.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-users', method: 'post', path: '/api/admin/users/:id/activate', reg: 'routes/admin-users.ts', gate: 'routes/admin-users.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-users', method: 'post', path: '/api/admin/login-aliases/backfill', reg: 'routes/admin-users.ts', gate: 'routes/admin-users.ts ensurePlatformAdmin', family: P },

  // --- routes/admin-directory.ts（20 条） ---
  { mount: 'admin-directory', method: 'post', path: '/dingtalk/work-notification/test', reg: 'routes/admin-directory.ts', gate: 'routes/admin-directory.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-directory', method: 'put', path: '/dingtalk/work-notification', reg: 'routes/admin-directory.ts', gate: 'routes/admin-directory.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-directory', method: 'post', path: '/integrations', reg: 'routes/admin-directory.ts', gate: 'routes/admin-directory.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-directory', method: 'put', path: '/integrations/:integrationId', reg: 'routes/admin-directory.ts', gate: 'routes/admin-directory.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-directory', method: 'post', path: '/integrations/:integrationId/approval-card-config/secret/generate', reg: 'routes/admin-directory.ts', gate: 'routes/admin-directory.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-directory', method: 'put', path: '/integrations/:integrationId/approval-card-config', reg: 'routes/admin-directory.ts', gate: 'routes/admin-directory.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-directory', method: 'post', path: '/integrations/test', reg: 'routes/admin-directory.ts', gate: 'routes/admin-directory.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-directory', method: 'post', path: '/integrations/:integrationId/sync', reg: 'routes/admin-directory.ts', gate: 'routes/admin-directory.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-directory', method: 'post', path: '/integrations/:integrationId/sync/preview', reg: 'routes/admin-directory.ts', gate: 'routes/admin-directory.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-directory', method: 'post', path: '/accounts/:accountId/bind', reg: 'routes/admin-directory.ts', gate: 'routes/admin-directory.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-directory', method: 'post', path: '/accounts/:accountId/admit-user', reg: 'routes/admin-directory.ts', gate: 'routes/admin-directory.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-directory', method: 'post', path: '/accounts/batch-bind', reg: 'routes/admin-directory.ts', gate: 'routes/admin-directory.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-directory', method: 'post', path: '/accounts/batch-admit-users', reg: 'routes/admin-directory.ts', gate: 'routes/admin-directory.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-directory', method: 'post', path: '/accounts/:accountId/unbind', reg: 'routes/admin-directory.ts', gate: 'routes/admin-directory.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-directory', method: 'post', path: '/accounts/batch-unbind', reg: 'routes/admin-directory.ts', gate: 'routes/admin-directory.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-directory', method: 'post', path: '/alerts/:alertId/ack', reg: 'routes/admin-directory.ts', gate: 'routes/admin-directory.ts ensurePlatformAdmin', family: P },
  // 本批唯一一条「门不在处理器第一条语句」的写路由：先跑纯解析 `readCompatibilityRestoreMode`
  // （无 IO 无副作用），mode 非法时处理器内 `ensurePlatformAdmin` 过门后才 400，mode 合法走 helper
  // `restoreDeprovisionEventForRequest`（门是它的第一条语句）。两条分支都在任何副作用之前过门——
  // 下面的 `deprovision restore` 用例把两条分支都打一遍。
  { mount: 'admin-directory', method: 'post', path: '/deprovision/events/:eventId/restore', reg: 'routes/admin-directory.ts', gate: 'routes/admin-directory.ts ensurePlatformAdmin（非法 mode 分支，400 之前） / restoreDeprovisionEventForRequest -> ensurePlatformAdmin（合法 mode 分支）', family: P },
  { mount: 'admin-directory', method: 'post', path: '/deprovision-events/:eventId/reactivate', reg: 'routes/admin-directory.ts', gate: 'routes/admin-directory.ts restoreDeprovisionEventForRequest -> ensurePlatformAdmin', family: P },
  { mount: 'admin-directory', method: 'post', path: '/deprovision-events/:eventId/force-reactivate', reg: 'routes/admin-directory.ts', gate: 'routes/admin-directory.ts restoreDeprovisionEventForRequest -> ensurePlatformAdmin', family: P },
  { mount: 'admin-directory', method: 'post', path: '/deprovision-events/:eventId/compensate-orphan-deny', reg: 'routes/admin-directory.ts', gate: 'routes/admin-directory.ts compensateSupersededDenyGrantForRequest -> ensurePlatformAdmin', family: P },

  // --- routes/admin-directory-local.ts（8 条；门从 ./admin-directory import） ---
  { mount: 'admin-directory-local', method: 'post', path: '/departments', reg: 'routes/admin-directory-local.ts', gate: 'routes/admin-directory-local.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-directory-local', method: 'patch', path: '/departments/:departmentId', reg: 'routes/admin-directory-local.ts', gate: 'routes/admin-directory-local.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-directory-local', method: 'post', path: '/departments/:departmentId/archive', reg: 'routes/admin-directory-local.ts', gate: 'routes/admin-directory-local.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-directory-local', method: 'post', path: '/accounts', reg: 'routes/admin-directory-local.ts', gate: 'routes/admin-directory-local.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-directory-local', method: 'patch', path: '/accounts/:accountId', reg: 'routes/admin-directory-local.ts', gate: 'routes/admin-directory-local.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-directory-local', method: 'post', path: '/accounts/:accountId/archive', reg: 'routes/admin-directory-local.ts', gate: 'routes/admin-directory-local.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-directory-local', method: 'post', path: '/memberships', reg: 'routes/admin-directory-local.ts', gate: 'routes/admin-directory-local.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-directory-local', method: 'patch', path: '/memberships/:membershipId', reg: 'routes/admin-directory-local.ts', gate: 'routes/admin-directory-local.ts ensurePlatformAdmin', family: P },

  // --- routes/admin-directory-department-bindings.ts（1 条） ---
  { mount: 'admin-directory-department-bindings', method: 'post', path: '/sweep', reg: 'routes/admin-directory-department-bindings.ts', gate: 'routes/admin-directory-department-bindings.ts ensurePlatformAdmin', family: P },

  // --- routes/admin-directory-routing-policy.ts（1 条） ---
  { mount: 'admin-directory-routing-policy', method: 'patch', path: '/:purpose', reg: 'routes/admin-directory-routing-policy.ts', gate: 'routes/admin-directory-routing-policy.ts ensurePlatformAdmin', family: P },

  // --- routes/admin-directory-org-transfers.ts（5 条） ---
  { mount: 'admin-directory-org-transfers', method: 'post', path: '/', reg: 'routes/admin-directory-org-transfers.ts', gate: 'routes/admin-directory-org-transfers.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-directory-org-transfers', method: 'post', path: '/:transferId/scan', reg: 'routes/admin-directory-org-transfers.ts', gate: 'routes/admin-directory-org-transfers.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-directory-org-transfers', method: 'post', path: '/:transferId/apply', reg: 'routes/admin-directory-org-transfers.ts', gate: 'routes/admin-directory-org-transfers.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-directory-org-transfers', method: 'post', path: '/:transferId/cancel', reg: 'routes/admin-directory-org-transfers.ts', gate: 'routes/admin-directory-org-transfers.ts ensurePlatformAdmin', family: P },
  { mount: 'admin-directory-org-transfers', method: 'patch', path: '/:transferId/source-sync-freeze', reg: 'routes/admin-directory-org-transfers.ts', gate: 'routes/admin-directory-org-transfers.ts ensurePlatformAdmin', family: P },

  // --- routes/canary-routes.ts（4 条；本批唯一把门放在中间件首位的） ---
  { mount: 'canary', method: 'put', path: '/rules/:topic', reg: 'routes/canary-routes.ts', gate: 'routes/canary-routes.ts requireAdminRole（中间件首位）', family: 'middleware' },
  { mount: 'canary', method: 'delete', path: '/rules/:topic', reg: 'routes/canary-routes.ts', gate: 'routes/canary-routes.ts requireAdminRole（中间件首位）', family: 'middleware' },
  { mount: 'canary', method: 'post', path: '/promote/:topic', reg: 'routes/canary-routes.ts', gate: 'routes/canary-routes.ts requireAdminRole（中间件首位）', family: 'middleware' },
  { mount: 'canary', method: 'post', path: '/rollback/:topic', reg: 'routes/canary-routes.ts', gate: 'routes/canary-routes.ts requireAdminRole（中间件首位）', family: 'middleware' },

  // --- routes/permissions.ts 的 /api/admin 切片（1 条） ---
  // 门在处理器体内，顺序是：`if (!pool)` 503 -> 身份（`req.user` 的 id/sub/userId）缺失 401 ->
  // `isAdmin(adminUserId)` 为假 403。W4-I §3.8 记的是行号（已漂移），本表只记函数名。
  { mount: 'permissions', method: 'post', path: '/api/admin/permission-templates/apply', reg: 'routes/permissions.ts', gate: 'routes/permissions.ts isAdmin（处理器内直调：缺身份 401，非管理员 403）', family: 'inline' },
]

/**
 * 例外登记：`ensureRoleDelegationAdmin`（`routes/admin-users.ts`）是**有意的**委派管理员口径，
 * 不是漏门。对它们的断言口径是「既不是平台管理员、也没有任何委派命名空间的调用者被拒」，
 * 而不是「非平台管理员被拒」——后者会把设计当 bug 钉死。
 */
const EXCEPTIONS = REGISTRY.filter((entry) => entry.family === 'delegation')

// ---------------------------------------------------------------------------
// fixture：身份与 legacy claim 四形态
// ---------------------------------------------------------------------------

/**
 * `hasLegacyAdminClaim` 的四种形态（两份副本的并集）：
 *   - `routes/admin-directory.ts` 的私有 `hasLegacyAdminClaim`：`role==='admin'` / `roles` 含 `'admin'` /
 *     `permissions` 含 `'*:*'` / `perms` 含 `'*:*'`
 *   - `rbac/platform-admin.ts` 的 `hasLegacyAdminClaim`（`admin-users.ts` 用的那份）：`role==='admin'` /
 *     `roles` 含 `'admin'` / `perms` 含 `'*:*'` 或 `'admin:all'`（**不看** `permissions`）
 * 注入的非管理员身份必须四条全不满足，否则 403 断言会在门根本没执行到 RBAC 的情况下假绿。
 */
const LEGACY_CLAIM_PREDICATES: ReadonlyArray<{ form: string; holds: (user: Record<string, unknown>) => boolean }> = [
  { form: "role === 'admin'", holds: (u) => u.role === 'admin' },
  { form: "roles 含 'admin'", holds: (u) => Array.isArray(u.roles) && u.roles.includes('admin') },
  {
    form: "perms 含 '*:*' 或 'admin:all'",
    holds: (u) => Array.isArray(u.perms) && (u.perms.includes('*:*') || u.perms.includes('admin:all')),
  },
  { form: "permissions 含 '*:*'", holds: (u) => Array.isArray(u.permissions) && u.permissions.includes('*:*') },
]

/**
 * 非管理员身份。四种 claim 字段**都存在但都不是管理员形态**——故意留着字段，这样将来有人把
 * fixture 改成带 claim（或把某个字段删掉让"不含"变成"没这字段"）时，自检用例会先红。
 */
const NON_ADMIN_USER: Record<string, unknown> = Object.freeze({
  id: 'u-non-admin',
  sub: 'u-non-admin',
  userId: 'u-non-admin',
  email: 'non-admin@example.test',
  role: 'user',
  roles: ['viewer', 'attendance_viewer'],
  perms: ['multitable:read'],
  permissions: ['multitable:read'],
})

/**
 * 路径参数 fixture。`admin-directory` 的四个 id 形参用 uuid 形状：门之后的处理器会（或将会）对畸形 id
 * 答 400，非管理员用例不受影响（门在前），但只有 uuid 形状的值才能让管理员侧的控制组量到 400 之后的逻辑。
 */
const UUID_SHAPED_PARAMS = ['eventId', 'integrationId', 'accountId', 'alertId'] as const

const PARAM_VALUES: Readonly<Record<string, string>> = {
  templateId: 'tpl-1',
  action: 'assign',
  userId: 'u-target',
  namespace: 'attendance',
  inviteId: 'inv-1',
  id: 'u-target',
  sessionId: 'sess-1',
  integrationId: '22222222-2222-4222-8222-222222222222',
  accountId: '33333333-3333-4333-8333-333333333333',
  alertId: '44444444-4444-4444-8444-444444444444',
  eventId: '11111111-1111-4111-8111-111111111111',
  departmentId: 'dept-1',
  membershipId: 'mem-1',
  transferId: 'tr-1',
  purpose: 'approval',
  topic: 'topic-1',
}

function joinPath(mountPath: string, routePath: string): string {
  const base = mountPath === '/' ? '' : mountPath.replace(/\/+$/, '')
  const tail = routePath === '/' ? '' : routePath
  return `${base}${tail}` || '/'
}

/** 把注册路径里的 `:param` / `:param(regex)` 换成 fixture 值；没有 fixture 值就抛（新参数必须显式登记）。 */
function toUrl(entry: { mount: MountKey; path: string }): string {
  const concrete = entry.path
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment
      const name = segment.slice(1).replace(/\(.*\)$/, '')
      const value = PARAM_VALUES[name]
      if (!value) throw new Error(`registry fixture missing for path param :${name} (${entry.path})`)
      return value
    })
    .join('/')
  return joinPath(MOUNTS[entry.mount].mountPath, concrete)
}

function label(entry: WriteRouteEntry): string {
  return `${entry.method.toUpperCase()} ${joinPath(MOUNTS[entry.mount].mountPath, entry.path)} [${entry.mount}/${entry.family}]`
}

// ---------------------------------------------------------------------------
// 效果预算 & harness
// ---------------------------------------------------------------------------

interface EffectReport {
  downstream: string[]
  query: string[]
  transaction: number
  poolQuery: string[]
}

function firstWords(sql: unknown): string {
  return String(sql).replace(/\s+/g, ' ').trim().slice(0, 44)
}

function effectReport(): EffectReport {
  return {
    downstream: [...probe.calls],
    query: pg.query.mock.calls.map((call) => firstWords(call[0])),
    transaction: pg.transaction.mock.calls.length,
    poolQuery: pg.poolQuery.mock.calls.map((call) => firstWords(call[0])),
  }
}

/**
 * 每个门族在「被拒绝」时允许留下的痕迹。除此之外的任何下游调用都算越过门。
 *  - platform / inline：什么都不许碰。
 *  - delegation：允许 `fetchUserRoleIds`（`routes/admin-users.ts`）那一条**只读** `user_roles` 查询
 *    ——委派口径本来就要先读角色才知道有没有委派命名空间；写与审计仍然零。
 *  - middleware：`requireAdminRole` 拒绝时会 best-effort 写一条 `operation_audit_logs`
 *    （`guards/audit-integration.ts` 里 `requireAdminRole` 的「无 user」与「非 admin」两条拒绝分支
 *    -> `logSafetyOperation` 用 `pool.query`）。
 *    这条 INSERT 本身就是门开火的证据，不是越权写。
 */
function expectDeniedEffects(family: GateFamily, report: EffectReport): void {
  expect(report.downstream).toEqual([])
  expect(report.transaction).toBe(0)
  if (family === 'middleware') {
    expect(report.query).toEqual([])
    expect(report.poolQuery).toHaveLength(1)
    expect(report.poolQuery[0]).toMatch(/^INSERT INTO operation_audit_logs/)
    return
  }
  expect(report.poolQuery).toEqual([])
  if (family === 'delegation') {
    expect(report.query).toHaveLength(1)
    expect(report.query[0]).toMatch(/^SELECT role_id/)
    return
  }
  expect(report.query).toEqual([])
}

function buildApp(mount: MountKey, user: Record<string, unknown> | null): Express {
  const app = express()
  app.use(express.json())
  if (user) {
    app.use((req: Request, _res: Response, next: NextFunction) => {
      ;(req as Request & { user?: unknown }).user = user
      next()
    })
  }
  app.use(MOUNTS[mount].mountPath, MOUNTS[mount].build())
  return app
}

const pinned = usePinnedServer()

function armProbes(): void {
  probe.reset()
  pg.query.mockClear()
  pg.transaction.mockClear()
  pg.poolQuery.mockClear()
}

async function send(
  entry: WriteRouteEntry,
  user: Record<string, unknown> | null,
  body: Record<string, unknown> = {},
) {
  pinned.setApp(buildApp(entry.mount, user))
  armProbes()
  return request(pinned.url())[entry.method](toUrl(entry)).send(body)
}

/** 记录式 response，用于不经 HTTP 的直调（`isAdmin` 抛错时 express 4 不接管 async 拒绝，HTTP 会挂住）。 */
function createRecordingResponse() {
  const state = {
    statusCode: 0,
    body: undefined as unknown,
    written: false,
  }
  const res = {
    status(code: number) {
      state.statusCode = code
      return res
    },
    json(payload: unknown) {
      state.body = payload
      state.written = true
      return res
    },
    setHeader() {
      return res
    },
    end() {
      state.written = true
      return res
    },
  }
  return { res: res as unknown as Response, state }
}

/** 直调路由的终端处理器（本文件里首位 `authenticate` 已是 pass-through）。 */
function invokeTerminalHandler(entry: WriteRouteEntry, user: Record<string, unknown> | null) {
  const router = MOUNTS[entry.mount].build()
  const layer = router.stack.find(
    (candidate: { route?: { path?: string; methods?: Record<string, boolean> } }) =>
      candidate.route?.path === entry.path && candidate.route?.methods?.[entry.method],
  )
  if (!layer?.route) throw new Error(`route not found in stack: ${label(entry)}`)
  const handlers = layer.route.stack as Array<{ handle: (req: Request, res: Response, next: NextFunction) => unknown }>
  const terminal = handlers[handlers.length - 1].handle
  const req = {
    method: entry.method.toUpperCase(),
    url: toUrl(entry),
    originalUrl: toUrl(entry),
    headers: {},
    query: {},
    params: {},
    body: {},
    user: user ?? undefined,
  } as unknown as Request
  const { res, state } = createRecordingResponse()
  armProbes()
  return { result: Promise.resolve(terminal(req, res, () => undefined)), state }
}

beforeEach(() => {
  probe.reset()
  pg.query.mockReset()
  pg.query.mockResolvedValue({ rows: [] })
  pg.transaction.mockReset()
  pg.transaction.mockResolvedValue(undefined)
  pg.poolQuery.mockReset()
  pg.poolQuery.mockResolvedValue({ rows: [] })
  rbac.isAdmin.mockReset()
  rbac.isAdmin.mockResolvedValue(false)
})

// ---------------------------------------------------------------------------
// 0) fixture 自检
// ---------------------------------------------------------------------------

describe('/api/admin 挂载点写路由守卫 — fixture 自检', () => {
  it('非管理员 fixture 不满足 legacy admin claim 的任何一种形态（四种都要检）', () => {
    const held = LEGACY_CLAIM_PREDICATES.filter((predicate) => predicate.holds(NON_ADMIN_USER)).map((p) => p.form)
    expect(held).toEqual([])
    // 四个字段必须都在——"不含"而不是"没这字段"，否则将来把字段删掉会让这层保护悄悄消失。
    expect(Object.keys(NON_ADMIN_USER)).toEqual(
      expect.arrayContaining(['role', 'roles', 'perms', 'permissions', 'id']),
    )
  })

  it('admin-directory 的 id 形参 fixture 是 uuid 形状（见 UUID_SHAPED_PARAMS）', () => {
    for (const name of UUID_SHAPED_PARAMS) {
      expect(PARAM_VALUES[name], name).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    }
  })

  it('登记表条数与分族口径固定：67 条 / 2 条委派例外 / 4 条中间件门 / 1 条 inline', () => {
    expect(REGISTRY).toHaveLength(67)
    expect(REGISTRY.filter((e) => e.family === 'delegation')).toHaveLength(2)
    expect(REGISTRY.filter((e) => e.family === 'middleware')).toHaveLength(4)
    expect(REGISTRY.filter((e) => e.family === 'inline')).toHaveLength(1)
    expect(REGISTRY.filter((e) => e.family === 'platform')).toHaveLength(60)
    // 每条都必须带来源：reg = 该挂载点的注册文件；gate 可解析，且每条分支链的最后一环是本族的门函数
    for (const entry of REGISTRY) {
      expect(entry.reg, label(entry)).toBe(MOUNTS[entry.mount].routeFile)
      const gate = parseGate(entry.gate)
      expect(gate, `${label(entry)} gate 形状不认识：${entry.gate}`).not.toBeNull()
      for (const branch of gate!.branches) {
        expect(branch[branch.length - 1], label(entry)).toBe(FAMILY_GATE[entry.family])
      }
    }
  })

  it('挂载点锚点对 index.ts 自证：挂载语句恰好一处、字面路径 = mountPath、调用的工厂 = factory', () => {
    const problems: string[] = []
    for (const [mount, spec] of Object.entries(MOUNTS) as Array<[MountKey, MountSpec]>) {
      const hits = indexStatementLines(spec.source)
      if (hits.length !== 1) {
        problems.push(`${mount}: index.ts 里与挂载语句逐字节相同的行有 ${hits.length} 处（应恰好 1 处）：${spec.source}`)
      }
      const parsed = MOUNT_STATEMENT.exec(spec.source)
      if (!parsed) {
        problems.push(`${mount}: 挂载语句形状不认识：${spec.source}`)
        continue
      }
      const literalPath = parsed[1] ?? '/'
      if (literalPath !== spec.mountPath) {
        problems.push(`${mount}: 挂载语句的字面路径 ${literalPath} 与 mountPath ${spec.mountPath} 不一致`)
      }
      if (parsed[2] !== spec.factory.name) {
        problems.push(`${mount}: 挂载语句调用的是 ${parsed[2]}，factory 却是 ${spec.factory.name}`)
      }
    }
    expect(problems).toEqual([])
  })

  it('登记表锚点对源码自证：(method, path) 恰好注册一处；门函数在该注册的处理器区间里被调用；helper 的第一条语句是门', () => {
    const problems: string[] = []
    for (const entry of REGISTRY) {
      const text = readSource(entry.reg)
      const offsets = registrationOffsets(text, entry.method, entry.path)
      if (offsets.length !== 1) {
        problems.push(`${label(entry)}: ${entry.reg} 里 .${entry.method}('${entry.path}') 注册了 ${offsets.length} 处（应恰好 1 处）`)
        continue
      }
      const gate = parseGate(entry.gate)
      if (!gate) {
        problems.push(`${label(entry)}: gate 形状不认识：${entry.gate}`)
        continue
      }
      const region = registrationRegion(text, offsets[0])
      const gateText = readSource(gate.file)
      for (const branch of gate.branches) {
        if (!new RegExp(`\\b${escapeRegExp(branch[0])}\\(`).test(region)) {
          problems.push(`${label(entry)}: 处理器区间里没有调用 ${branch[0]}(...)`)
        }
        for (let index = 1; index < branch.length; index += 1) {
          const first = helperFirstStatement(gateText, branch[index - 1])
          if (first === null || !new RegExp(`\\b${escapeRegExp(branch[index])}\\(`).test(first)) {
            problems.push(
              `${label(entry)}: ${gate.file} 里 ${branch[index - 1]} 的第一条语句不是 ${branch[index]}(...)：${first ?? '找不到定义'}`,
            )
          }
        }
      }
    }
    expect(problems).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// (A) 行为断言
// ---------------------------------------------------------------------------

describe('(A) 非管理员（无任何 legacy admin claim，isAdmin 恒 false）逐条写路由被拒且下游零调用', () => {
  const platformOrMiddleware = REGISTRY.filter((entry) => entry.family !== 'delegation')

  it.each(platformOrMiddleware.map((entry) => [label(entry), entry] as const))(
    '%s -> 被门拒绝',
    async (_name, entry) => {
      const response = await send(entry, NON_ADMIN_USER)
      expect(response.status).toBe(403)
      if (entry.family === 'platform') {
        expect(response.body).toEqual({
          ok: false,
          error: { code: 'FORBIDDEN', message: 'Admin access required', details: undefined },
        })
      } else if (entry.family === 'middleware') {
        expect(response.body.code).toBe('ADMIN_REQUIRED')
      } else {
        expect(response.body.error).toBe('Only admins can apply permission templates')
      }
      expectDeniedEffects(entry.family, effectReport())
    },
  )

  it.each(EXCEPTIONS.map((entry) => [label(entry), entry] as const))(
    '%s（委派例外）-> 无委派命名空间的非管理员被拒',
    async (_name, entry) => {
      // `fetchUserRoleIds`（routes/admin-users.ts）读不到任何角色 -> `deriveDelegableNamespaces` 为空 -> 403
      pg.query.mockResolvedValue({ rows: [] })
      const response = await send(entry, NON_ADMIN_USER)
      expect(response.status).toBe(403)
      expect(response.body).toEqual({
        ok: false,
        error: { code: 'FORBIDDEN', message: 'Delegated role-admin access required', details: undefined },
      })
      expectDeniedEffects(entry.family, effectReport())
    },
  )

  it('委派例外不是平台管理员口径：持有委派命名空间的非平台管理员**不**被这道门拒（口径是设计，不是 bug）', async () => {
    // `attendance_admin` -> `deriveDelegatedAdminNamespace`（rbac/namespace-admission.ts）-> 'attendance'
    pg.query.mockResolvedValue({ rows: [{ role_id: 'attendance_admin' }] })
    for (const entry of EXCEPTIONS) {
      const response = await send(entry, NON_ADMIN_USER)
      expect([401, 403], label(entry)).not.toContain(response.status)
    }
  })

  it('POST /api/admin/directory/deprovision/events/:eventId/restore 的两条分支都先过门', async () => {
    const entry = REGISTRY.find((candidate) => candidate.path === '/deprovision/events/:eventId/restore')
    expect(entry).toBeDefined()
    // 非法 mode -> 处理器内 `ensurePlatformAdmin`（400 分支之前）
    const invalidMode = await send(entry!, NON_ADMIN_USER, { mode: 'not-a-mode' })
    expect(invalidMode.status).toBe(403)
    expect(invalidMode.body.error.code).toBe('FORBIDDEN')
    expectDeniedEffects('platform', effectReport())
    // 合法 mode -> helper `restoreDeprovisionEventForRequest` 的门（它的第一条语句）
    const validMode = await send(entry!, NON_ADMIN_USER, { mode: 'rehire' })
    expect(validMode.status).toBe(403)
    expect(validMode.body.error.code).toBe('FORBIDDEN')
    expectDeniedEffects('platform', effectReport())
  })
})

describe('(A) 无身份（req.user 缺失）逐条写路由 fail-closed', () => {
  it.each(REGISTRY.map((entry) => [label(entry), entry] as const))('%s -> 401/403，无副作用', async (_name, entry) => {
    const response = await send(entry, null)
    if (entry.family === 'middleware') {
      // requireAdminRole 对「没有 req.user」也答 403 ADMIN_REQUIRED（guards/audit-integration.ts 的 `!user?.id` 分支）
      expect(response.status).toBe(403)
      expect(response.body.code).toBe('ADMIN_REQUIRED')
    } else if (entry.family === 'inline') {
      expect(response.status).toBe(401)
      expect(response.body.error).toBe('User ID not found in token')
    } else {
      expect(response.status).toBe(401)
      expect(response.body).toEqual({
        ok: false,
        error: { code: 'UNAUTHENTICATED', message: 'Authentication required', details: undefined },
      })
    }
    // 无身份时连 `fetchUserRoleIds` 都不会发生，所以委派族在这一轮的预算与 platform 相同。
    expectDeniedEffects(entry.family === 'delegation' ? 'platform' : entry.family, effectReport())
  })
})

describe('(A) RBAC 判据不可用（isAdmin 抛错）时 fail-closed', () => {
  it('canary（requireAdminRole）-> 503 RBAC_CHECK_FAILED，下游零调用', async () => {
    rbac.isAdmin.mockRejectedValue(new Error('rbac unavailable'))
    for (const entry of REGISTRY.filter((candidate) => candidate.family === 'middleware')) {
      const response = await send(entry, NON_ADMIN_USER)
      expect(response.status, label(entry)).toBe(503)
      expect(response.body.code).toBe('RBAC_CHECK_FAILED')
      expect(probe.calls).toEqual([])
    }
  })

  it('permissions（处理器内 isAdmin 直调）-> 500，不是 2xx，模板与审计零调用', async () => {
    rbac.isAdmin.mockRejectedValue(new Error('rbac unavailable'))
    const entry = REGISTRY.find((candidate) => candidate.family === 'inline')!
    const response = await send(entry, NON_ADMIN_USER, { userId: 'u-target', templateId: 'tpl-1' })
    expect(response.status).toBe(500)
    expect(response.status).not.toBeLessThan(400)
    expect(probe.calls).toEqual([])
    expect(pg.poolQuery.mock.calls).toEqual([])
  })

  it.each(
    (
      [
        'admin-users',
        'admin-directory',
        'admin-directory-local',
        'admin-directory-department-bindings',
        'admin-directory-routing-policy',
        'admin-directory-org-transfers',
      ] as MountKey[]
    ).map((mount) => [mount, REGISTRY.find((entry) => entry.mount === mount && entry.family === 'platform')!] as const),
  )(
    '%s（ensurePlatformAdmin）-> 拒绝传播、无响应、无副作用（express 4 不接管 async 拒绝：这是挂住而不是 503）',
    async (_mount, entry) => {
      rbac.isAdmin.mockRejectedValue(new Error('rbac unavailable'))
      const { result, state } = invokeTerminalHandler(entry, NON_ADMIN_USER)
      await expect(result).rejects.toThrow('rbac unavailable')
      expect(state.written).toBe(false)
      expect(state.statusCode).toBe(0)
      expect(probe.calls).toEqual([])
      expect(pg.transaction.mock.calls).toEqual([])
      expect(pg.poolQuery.mock.calls).toEqual([])
    },
  )
})

// ---------------------------------------------------------------------------
// (A) 控制组 —— 证明上面那些 403 真的是「门」量出来的，而不是别的东西顺手拒的
// ---------------------------------------------------------------------------

describe('(A) 控制组：同一请求、只改门的输入，结论必须翻面', () => {
  interface Control {
    readonly mount: MountKey
    readonly path: string
    readonly expectDownstream?: string
  }
  const CONTROLS: readonly Control[] = [
    { mount: 'admin-directory', path: '/integrations/test', expectDownstream: 'directory-sync.testDirectoryIntegration' },
    { mount: 'admin-directory-local', path: '/departments' },
    { mount: 'admin-directory-department-bindings', path: '/sweep' },
    { mount: 'admin-directory-routing-policy', path: '/:purpose' },
    { mount: 'admin-directory-org-transfers', path: '/' },
    { mount: 'admin-users', path: '/api/admin/login-aliases/backfill', expectDownstream: 'login-alias-service.backfillUserLoginAliases' },
    { mount: 'permissions', path: '/api/admin/permission-templates/apply' },
    { mount: 'canary', path: '/promote/:topic', expectDownstream: 'canary-router.promote' },
  ]

  function entryOf(control: Control): WriteRouteEntry {
    const found = REGISTRY.find((entry) => entry.mount === control.mount && entry.path === control.path)
    if (!found) throw new Error(`control route not in registry: ${control.mount} ${control.path}`)
    return found
  }

  it.each(CONTROLS.map((control) => [`${control.mount} ${control.path}`, control] as const))(
    '%s：isAdmin=true（其余一切不变）-> 不再是 401/403',
    async (_name, control) => {
      const entry = entryOf(control)
      rbac.isAdmin.mockResolvedValue(true)
      const response = await send(entry, NON_ADMIN_USER)
      expect([401, 403], label(entry)).not.toContain(response.status)
      if (control.expectDownstream) {
        expect(probe.calls).toContain(control.expectDownstream)
      }
    },
  )

  /**
   * legacy claim 的正向控制组（**现状**控制组，不是需求）：`role: 'admin'` 是两份
   * `hasLegacyAdminClaim` 副本都认的形态，注入后即便 `isAdmin` 为 false 也会放行。
   * 如果 owner 日后裁决收紧（删掉 legacy claim 分支），这条用例会红——那时应当**更新**它，
   * 而不是把它当成「不能收紧」的理由。
   * 另两种形态（`permissions` 含 `*:*`、`perms` 含 `admin:all`）在两份副本之间口径不一致，
   * 是否收紧待裁决，本文件**不**把那个差异钉成用例（见设计文档 §宽度差）。
   */
  it("legacy claim（role:'admin'）在 isAdmin=false 时仍放行 —— 现状控制组", async () => {
    const legacyAdmin = { ...NON_ADMIN_USER, role: 'admin' }
    expect(LEGACY_CLAIM_PREDICATES.filter((predicate) => predicate.holds(legacyAdmin)).map((p) => p.form)).toEqual([
      "role === 'admin'",
    ])
    const directory = REGISTRY.find((entry) => entry.mount === 'admin-directory' && entry.path === '/integrations/test')!
    const users = REGISTRY.find((entry) => entry.mount === 'admin-users' && entry.path === '/api/admin/login-aliases/backfill')!
    for (const entry of [directory, users]) {
      const response = await send(entry, legacyAdmin)
      expect([401, 403], label(entry)).not.toContain(response.status)
    }
    expect(rbac.isAdmin).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// (B) 清单双向反查
// ---------------------------------------------------------------------------

describe('(B) 清单双向反查：router.stack 枚举出的写路由集合必须与登记表相等', () => {
  interface StackWriteRoute {
    readonly mount: MountKey
    readonly method: WriteMethod
    readonly path: string
    readonly full: string
  }

  function enumerateStack(mount: MountKey): { routes: StackWriteRoute[]; nonRouteLayers: number } {
    const router = MOUNTS[mount].build() as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>
    }
    const routes: StackWriteRoute[] = []
    let nonRouteLayers = 0
    for (const layer of router.stack) {
      if (!layer.route) {
        nonRouteLayers += 1
        continue
      }
      for (const method of WRITE_METHODS) {
        if (!layer.route.methods[method]) continue
        const full = joinPath(MOUNTS[mount].mountPath, layer.route.path)
        // `admin-users` / `permissions` 是根挂载：只有 `/api/admin` 前缀下的才属于本文件的范围。
        if (!full.startsWith('/api/admin')) continue
        routes.push({ mount, method, path: layer.route.path, full })
      }
    }
    return { routes, nonRouteLayers }
  }

  const key = (route: { mount: MountKey; method: WriteMethod; path: string }) =>
    `${route.method.toUpperCase()} ${joinPath(MOUNTS[route.mount].mountPath, route.path)} [${route.mount}]`

  it('没有非 route 层（router.use/子 router 会让这套枚举瞎掉，出现即红）', () => {
    for (const mount of Object.keys(MOUNTS) as MountKey[]) {
      expect(enumerateStack(mount).nonRouteLayers, mount).toBe(0)
    }
  })

  it('stack -> 登记表：每条实际写路由都必须在登记表里（新增未登记的写路由必红）', () => {
    const registered = new Set(REGISTRY.map(key))
    const unregistered: string[] = []
    for (const mount of Object.keys(MOUNTS) as MountKey[]) {
      for (const route of enumerateStack(mount).routes) {
        if (!registered.has(key(route))) unregistered.push(key(route))
      }
    }
    expect(
      unregistered,
      '新增的 /api/admin 写路由没有登记：必须在 REGISTRY 里加一行（带 reg/gate 来源）并补上 (A) 的行为断言',
    ).toEqual([])
  })

  it('登记表 -> stack：登记表里不能有死条目（路由被删/改名/改方法必红）', () => {
    const live = new Set<string>()
    for (const mount of Object.keys(MOUNTS) as MountKey[]) {
      for (const route of enumerateStack(mount).routes) live.add(key(route))
    }
    const dead = REGISTRY.map(key).filter((entryKey) => !live.has(entryKey))
    expect(dead, '登记表里的写路由在 router.stack 里已经不存在了：删行或改行，并同步 W4-I 盘点').toEqual([])
  })

  it('登记表无重复行，且逐条都能构造出请求 URL', () => {
    const keys = REGISTRY.map(key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const entry of REGISTRY) {
      expect(toUrl(entry), label(entry)).toMatch(/^\/api\/admin/)
    }
  })

  it('按 index.ts 真实顺序挂在同一个 app 上时，前缀重叠的挂载点仍各自被自己的门拒', async () => {
    // 同一个 app 里谁接管前缀重叠的 URL 是挂载顺序决定的，逐 router 建 app 看不到。顺序不手写：按
    // `MOUNTS[*].source` 那几条挂载语句在 `index.ts` 里的先后排（目前 org-transfers 在 admin-directory
    // 之前，local/department-bindings/routing-policy 在其后）。
    const app = express()
    app.use(express.json())
    app.use((req: Request, _res: Response, next: NextFunction) => {
      ;(req as Request & { user?: unknown }).user = NON_ADMIN_USER
      next()
    })
    for (const mount of indexMountOrder()) {
      app.use(MOUNTS[mount].mountPath, MOUNTS[mount].build())
    }
    pinned.setApp(app)
    armProbes()

    const overlapping = REGISTRY.filter((entry) =>
      entry.mount === 'admin-directory-org-transfers'
      || entry.mount === 'admin-directory-local'
      || entry.mount === 'admin-directory-department-bindings'
      || entry.mount === 'admin-directory-routing-policy',
    )
    for (const entry of overlapping) {
      const response = await request(pinned.url())[entry.method](toUrl(entry)).send({})
      expect(response.status, label(entry)).toBe(403)
      expect(response.body.error?.code, label(entry)).toBe('FORBIDDEN')
    }
    expect(probe.calls).toEqual([])
  })
})
