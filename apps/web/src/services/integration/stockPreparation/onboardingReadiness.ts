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
//     是不是有一个角色同时持有 stock-prep:read 和 stock-prep:operate,里面有几个人?
//
// 合取,不是并集 (设计稿 线框 B2 硬规则): a role with `read` and a DIFFERENT role with `operate` does
// let a person holding both roles work — but it is not what an administrator is told to build, and
// counting it as ready would report 就绪 for a deployment where nobody has both. This module reports
// only what it can point at: roles that carry both codes themselves.
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
// expects — collapses to ONE state: `unknown`. Never `no_role`, which would tell an administrator to
// redo work they may well have already done. A preload that cannot answer degrades silently (G3):
// this module never throws, so no caller can turn it into a red banner by forgetting a `catch`.
import { apiFetch } from '../../../utils/api'

/** Asserted literally in this module's spec, so a route rename cannot pass unnoticed. */
export const STOCK_PREP_ROLE_CATALOG_ROUTE = '/api/admin/roles'

/** The conjunction 一线 needs. Both, on ONE role. */
export const STOCK_PREP_OPERATOR_PERMISSION_CODES: readonly string[] = Object.freeze([
  'stock-prep:read',
  'stock-prep:operate',
])

/** Reported alongside, never required: 线框 B2's 「○ 没有角色持有 stock-prep:admin(可以不配)」. */
export const STOCK_PREP_ADMIN_PERMISSION_CODE = 'stock-prep:admin'

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
  /** Roles carrying `stock-prep:admin`. Informational only; never part of `state`. */
  adminRoleCount: number
  /** HTTP status when the read did not answer, `null` when it did (or when there was no response). */
  status: number | null
}

/** The one shape every failure collapses to. Exported so callers never retype the literal. */
export function stockPrepOnboardingReadinessUnknown(status: number | null): StockPrepOnboardingReadiness {
  return { state: 'unknown', roles: [], roleCount: 0, memberTotal: 0, adminRoleCount: 0, status }
}

function normalizeRoleName(raw: unknown, fallback: unknown): string | null {
  for (const candidate of [raw, fallback]) {
    if (typeof candidate !== 'string') continue
    const trimmed = candidate.trim()
    if (trimmed.length > 0) return trimmed.slice(0, ROLE_NAME_MAX_LENGTH)
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
  let memberTotal = 0

  for (const entry of items) {
    if (!entry || typeof entry !== 'object') continue
    const row = entry as { id?: unknown; name?: unknown; permissions?: unknown; memberCount?: unknown }
    const codes = permissionCodesOf(row.permissions)
    if (codes.has(STOCK_PREP_ADMIN_PERMISSION_CODE)) adminRoleCount += 1
    if (!STOCK_PREP_OPERATOR_PERMISSION_CODES.every((code) => codes.has(code))) continue
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
