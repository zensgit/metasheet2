// BOM备料 接入向导第⑤步「谁能用」的真实检测 (P1-3).
//
// THE QUESTION THIS ANSWERS, AND WHY IT IS THE ONLY ONE ASKED.
// 2026-09-08 on the customer host: a permission code granted DIRECTLY on a user — ticked in 用户管理
// without any role behind it — does not work. `listUserPermissions` merges the direct grants and the
// role grants and then runs them through `filterPermissionCodesByNamespaceAdmission`, whose
// `controlledNamespaces` are derived from `user_roles JOIN role_permissions` ALONE
// (`rbac/namespace-admission.ts` `fetchUserNamespaceRoleContext`). A `stock-prep:*` code with no role
// carrying it therefore derives no namespace, fails the admission filter, and the account opens 备料
// to a flat 403. So the only readiness question worth asking is the one below:
//
//     是不是有一个角色让一线满足备料网关,里面有几个人?
//
// 合取,不是并集 (设计稿 线框 B2 硬规则): a role with `read` and a DIFFERENT role with `operate` does
// let a person holding both roles work — but it is not what an administrator is told to build, and
// counting it as ready would report 就绪 for a deployment where nobody has both. This module reports
// only what it can point at: roles that satisfy the gate on their own.
//
// THE LADDER IS THE GATE'S LADDER, NOT A LITERAL `includes` PAIR.
// `plugins/plugin-integration-core/lib/stock-preparation-workbench-access.cjs`
// `satisfiesStockPrepAccess` is the authority, and its order is:
//     `role:admin` | `integration:admin`  -> every code
//     `stock-prep:admin`                  -> read AND operate
//     `stock-prep:read`                   -> read
//     `stock-prep:operate` AND `:read`    -> operate
// So a role carrying ONLY `stock-prep:admin` already lets its members open the queue, confirm and
// export. An earlier cut of this module tested for the two literal codes alone and answered
// `no_role` for exactly that role — telling an administrator to go build something already built,
// the one answer 设计稿 §8.1 R7 says this step must never produce. `roleGrantsStockPrepAccess`
// below is that ladder, restated over ONE ROLE'S permission codes.
//
// TWO CODES THE LADDER DELIBERATELY DOES **NOT** HONOUR, and why:
//   · `stock-prep:*` — `satisfiesStockPrepAccess` matches code strings LITERALLY (`held.includes`),
//     so the server refuses a principal whose only stock-prep grant is the wildcard, even though
//     `useAuth().hasPermission` (`apps/web/src/composables/useAuth.ts`) would expand it and render
//     the controls. That divergence is a platform-level misalignment, not this page's to paper
//     over: counting such a role as 「能用」 would promise access the server then refuses.
//   · `*:*` on a role that is not the platform-admin role — members get `*:*` in their permission
//     list but NOT the `role:admin` pseudo-code (`http-routes.cjs` `listUserPermissions` synthesises
//     `role:<id>` from role IDS), so `satisfiesStockPrepAccess` refuses them too.
// Platform-admin roles (`id === 'admin'`, or holding `integration:admin`) DO satisfy the gate, but
// they are 平台管理员, not 一线, and every fresh deployment has one with a member in it — counting
// them would make this step read ✔ on a host where the floor cannot open anything. They are
// reported on their own line instead, and never touch `state`.
//
// THE THIRD LEG THIS PAGE CANNOT SEE — 命名空间准入.
// A role carrying the codes and a person inside it are only TWO of the three conditions. The third
// is per-user: `packages/core-backend/src/rbac/namespace-admission.ts`
// `filterPermissionCodesByNamespaceAdmission` keeps a `stock-prep:*` code only when the user has an
// ENABLED `user_namespace_admissions` row for `stock-prep` (the namespace is admission-controlled —
// `stock-prep` is absent from `NON_NAMESPACED_PERMISSION_RESOURCES`). Adding an EXISTING user to a
// role does not write that row: `routes/admin-users.ts` `/roles/assign` calls `assignUserRoles`,
// which only INSERTs `user_roles`, and the sole caller of `grantNamespaceAdmissions` is the
// user-CREATION path. So the third leg is a separate switch in 用户管理 →「插件使用」, this catalog
// read cannot see it, and NOTHING in this module or its view may claim 「已完成」 on two legs out of
// three. The wizard says the third leg out loud in every actionable verdict, and the map badge for
// this step is never `done`.
//
// PLATFORM-LEVEL, NOT PER-TENANT (F9). `GET /api/admin/roles` runs `fetchRoleCatalog`
// (`packages/core-backend/src/routes/admin-users.ts`), whose SQL is
// `FROM roles LEFT JOIN role_permissions / user_roles GROUP BY r.id` with NO tenant predicate
// anywhere. What comes back is the WHOLE PLATFORM's role catalog. Every sentence this module feeds
// the wizard therefore says 平台的角色目录 and never 「贵司/本租户配置」 — an earlier draft of the
// design said the latter and it was simply wrong.
//
// VALUES-FREE, AND ZERO USER IDENTITY. The route's envelope carries `items[]` (id/name/permissions/
// memberCount) and an `actorId` — the CALLER's own user id. Nothing below reads `actorId`, and
// nothing below reads or returns a user id, an email, or a display name: the projection is
// deliberately narrowed to a role NAME and an integer COUNT before it leaves this file, so the view
// physically cannot render an identity it was never handed.
//
// 「看不到」≠「没完成」 (G4). Every way this read can fail to answer — 403 because the caller is a
// 备料 admin rather than a platform admin (the route is `ensurePlatformAdmin`), a 500, a network
// error, an HTML sign-in page where JSON was expected, a payload whose shape is not what this file
// expects — collapses to ONE state: `unknown`, never `no_role`. That is a claim about UNANSWERED
// reads only, and it is the whole of what this module guarantees: `no_role` remains reachable, and
// is correct, when the catalog IS read and holds no role that satisfies the gate. A preload that
// cannot answer degrades silently (G3): this module never throws, so no caller can turn it into a
// red banner by forgetting a `catch`.
import { apiFetch } from '../../../utils/api'

/** Asserted literally in this module's spec, so a route rename cannot pass unnoticed. */
export const STOCK_PREP_ROLE_CATALOG_ROUTE = '/api/admin/roles'

/** The conjunction 一线 needs. Both, on ONE role. */
export const STOCK_PREP_OPERATOR_PERMISSION_CODES: readonly string[] = Object.freeze([
  'stock-prep:read',
  'stock-prep:operate',
])

/**
 * The workbench-scoped ceiling. NOT optional decoration: the gate's ladder makes it satisfy BOTH
 * read and operate, so a role carrying only this code is a QUALIFYING role here.
 */
export const STOCK_PREP_ADMIN_PERMISSION_CODE = 'stock-prep:admin'

/** The admission-controlled namespace whose per-user switch this page cannot read (see the header). */
export const STOCK_PREP_ADMISSION_NAMESPACE = 'stock-prep'

/** `role:admin` is synthesised from this role ID, and short-circuits the gate for its members. */
export const STOCK_PREP_PLATFORM_ADMIN_ROLE_ID = 'admin'

/** The other half of the gate's platform-admin short-circuit, carried as a real permission code. */
export const STOCK_PREP_PLATFORM_ADMIN_PERMISSION_CODE = 'integration:admin'

/**
 * Does ONE role's permission list satisfy the备料 gate for its members? The ladder from
 * `satisfiesStockPrepAccess`, minus the platform-admin short-circuit (reported separately, see
 * `roleIsPlatformAdmin`). Literal matching on purpose — the server matches literally too.
 */
export function roleGrantsStockPrepAccess(codes: ReadonlySet<string>): boolean {
  if (codes.has(STOCK_PREP_ADMIN_PERMISSION_CODE)) return true
  return STOCK_PREP_OPERATOR_PERMISSION_CODES.every((code) => codes.has(code))
}

/**
 * Are this role's members platform administrators? Both halves of the gate's short-circuit:
 * `role:admin` (synthesised from the role ID) and the `integration:admin` permission code.
 */
export function roleIsPlatformAdmin(roleId: unknown, codes: ReadonlySet<string>): boolean {
  if (typeof roleId === 'string' && roleId.trim() === STOCK_PREP_PLATFORM_ADMIN_ROLE_ID) return true
  return codes.has(STOCK_PREP_PLATFORM_ADMIN_PERMISSION_CODE)
}

/**
 * How many qualifying role NAMES the projection keeps. A catalog with dozens of matching roles is a
 * real possibility on a shared platform, and the wizard's job is to say 「有这样的角色」 plus enough
 * detail to find it — not to reproduce 角色管理. `roleCount` always carries the TRUE total, so the
 * view can say 「还有 N 个」 rather than silently truncating.
 */
export const STOCK_PREP_READINESS_ROLE_NAME_CAP = 5

/** Defensive clamp on a name that reaches the DOM. Operator-authored text, but not unbounded. */
const ROLE_NAME_MAX_LENGTH = 60

export type StockPrepOnboardingReadinessState =
  /** 有角色同时持有两码,且里面有人。 */
  | 'ready'
  /** 有角色同时持有两码,但一个人都没放进去 —— 一线依然打不开,所以这不是 ✔。 */
  | 'no_members'
  /** 没有任何角色同时持有两码。 */
  | 'no_role'
  /** 读不到 / 读回来的形状不认识 —— 无法判断,不是「没完成」。 */
  | 'unknown'

export interface StockPrepOnboardingRoleSummary {
  /**
   * The role's own name, falling back to its id, and `null` when the catalog carries neither. NEVER a
   * person. A nameless row is still COUNTED — dropping it would understate `roleCount` and could turn
   * a configured deployment into a confident 「还没有这样的角色」, which is the one answer this step
   * must never give by accident. The view labels it rather than this file inventing a name.
   */
  name: string | null
  /** `COUNT(DISTINCT user_roles.user_id)` for that role, as the server computed it. */
  memberCount: number
}

export interface StockPrepOnboardingReadiness {
  state: StockPrepOnboardingReadinessState
  /** Qualifying roles, capped at `STOCK_PREP_READINESS_ROLE_NAME_CAP`. Empty unless `ready`/`no_members`. */
  roles: readonly StockPrepOnboardingRoleSummary[]
  /** The TRUE number of qualifying roles, uncapped. */
  roleCount: number
  /**
   * Sum of the qualifying roles' member counts. A person who is in TWO qualifying roles is counted
   * twice — the catalog answers per role and carries no user ids to de-duplicate against, and this
   * module will not invent an identity read to fix that. The view says so whenever `roleCount > 1`
   * rather than presenting a sum as a headcount.
   */
  memberTotal: number
  /**
   * How many of the QUALIFYING roles qualify by carrying `stock-prep:admin`. A subset of
   * `roleCount`, never a separate population: the ladder makes that code satisfy read and operate,
   * so such a role is counted like any other. Informational — it changes no verdict, it only lets
   * the view say what that code actually confers.
   */
  adminRoleCount: number
  /**
   * Roles whose members are PLATFORM ADMINISTRATORS (`id === 'admin'`, or holding
   * `integration:admin`). They satisfy the gate, and they are deliberately NOT counted in `state`:
   * they are not 一线, and every deployment has one from the moment it is installed. Reported so
   * the view can say 「他们本来就能打开,但那不是一线能用」 instead of silently ignoring them.
   */
  platformAdminRoleCount: number
  /** HTTP status when the read did not answer, `null` when it did (or when there was no response). */
  status: number | null
}

/** The one shape every failure collapses to. Exported so callers never retype the literal. */
export function stockPrepOnboardingReadinessUnknown(status: number | null): StockPrepOnboardingReadiness {
  return { state: 'unknown', roles: [], roleCount: 0, memberTotal: 0, adminRoleCount: 0, platformAdminRoleCount: 0, status }
}

function normalizeRoleName(raw: unknown, fallback: unknown): string | null {
  for (const candidate of [raw, fallback]) {
    if (typeof candidate !== 'string') continue
    const trimmed = candidate.trim()
    if (trimmed.length === 0) continue
    // Truncation is MARKED. An administrator reads this name and then goes looking for it in
    // 角色管理; a silently shortened name is one they may not find.
    return trimmed.length > ROLE_NAME_MAX_LENGTH ? `${trimmed.slice(0, ROLE_NAME_MAX_LENGTH)}…` : trimmed
  }
  return null
}

function normalizeMemberCount(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

function permissionCodesOf(raw: unknown): Set<string> {
  if (!Array.isArray(raw)) return new Set()
  const codes = new Set<string>()
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.trim().length > 0) codes.add(entry.trim())
  }
  return codes
}

/**
 * THE PROJECTION, as a pure function over whatever `data` the route returned.
 *
 * `data.items` missing, not an array, or holding entries this file cannot read is `unknown`, NOT
 * 「没有这样的角色」: an unrecognised shape means the question was not answered, and answering it
 * anyway with a confident 「还没配」 is the one failure mode this step exists to avoid. An `items: []`
 * that IS an array, on the other hand, is a real answer — a platform with no roles at all genuinely
 * has no role holding both codes.
 */
export function stockPrepOnboardingReadinessFromPayload(data: unknown): StockPrepOnboardingReadiness {
  if (!data || typeof data !== 'object') return stockPrepOnboardingReadinessUnknown(null)
  const items = (data as { items?: unknown }).items
  if (!Array.isArray(items)) return stockPrepOnboardingReadinessUnknown(null)

  const qualifying: StockPrepOnboardingRoleSummary[] = []
  let adminRoleCount = 0
  let platformAdminRoleCount = 0
  let memberTotal = 0

  for (const entry of items) {
    if (!entry || typeof entry !== 'object') continue
    const row = entry as { id?: unknown; name?: unknown; permissions?: unknown; memberCount?: unknown }
    const codes = permissionCodesOf(row.permissions)
    // Checked FIRST and `continue`d: a platform-admin role satisfies the gate through the
    // short-circuit, not through the stock-prep namespace, and its members are not 一线.
    if (roleIsPlatformAdmin(row.id, codes)) {
      platformAdminRoleCount += 1
      continue
    }
    if (!roleGrantsStockPrepAccess(codes)) continue
    if (codes.has(STOCK_PREP_ADMIN_PERMISSION_CODE)) adminRoleCount += 1
    // Only two fields cross this line, on purpose (see the header): a name and an integer.
    const name = normalizeRoleName(row.name, row.id)
    const memberCount = normalizeMemberCount(row.memberCount)
    memberTotal += memberCount
    qualifying.push({ name, memberCount })
  }

  const roleCount = qualifying.length
  const state: StockPrepOnboardingReadinessState = roleCount === 0
    ? 'no_role'
    : memberTotal > 0
      ? 'ready'
      // 设计稿 line B2 / 验收 4: a role that exists with nobody in it does NOT let one person on the
      // floor open the page, so it is a ⚠, never a ✔.
      : 'no_members'

  return {
    state,
    roles: Object.freeze(qualifying.slice(0, STOCK_PREP_READINESS_ROLE_NAME_CAP)),
    roleCount,
    memberTotal,
    adminRoleCount,
    platformAdminRoleCount,
    status: null,
  }
}

/**
 * THE READ. One GET, no query string, no scope: the catalog is platform-wide and takes no filter.
 *
 * `suppressUnauthorizedRedirect` is deliberate. This is a PRELOAD on a page the caller is already
 * authorised to be on; bouncing them to the sign-in screen because a background probe of a
 * platform-admin route came back 401 would be a worse lie than 「看不到」. G3: a preload's refusal
 * degrades to a state, never to navigation and never to a banner.
 *
 * Never rejects. Every throw — fetch failure, a mocked client returning nothing, a body that is not
 * JSON — is caught and reported as `unknown`.
 */
export async function readStockPrepOnboardingReadiness(): Promise<StockPrepOnboardingReadiness> {
  try {
    const response = await apiFetch(STOCK_PREP_ROLE_CATALOG_ROUTE, { suppressUnauthorizedRedirect: true })
    const status = typeof response?.status === 'number' ? response.status : null
    if (!response || response.ok !== true) return stockPrepOnboardingReadinessUnknown(status)
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      // A 200 carrying an HTML sign-in page is a refusal wearing a success code.
      return stockPrepOnboardingReadinessUnknown(status)
    }
    if (!body || typeof body !== 'object' || (body as { ok?: unknown }).ok !== true) {
      return stockPrepOnboardingReadinessUnknown(status)
    }
    return stockPrepOnboardingReadinessFromPayload((body as { data?: unknown }).data)
  } catch {
    return stockPrepOnboardingReadinessUnknown(null)
  }
}
