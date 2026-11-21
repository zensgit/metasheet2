/**
 * Pure route-guard decision policy (round-12 terminal state of the #4468/#4469 review line).
 *
 * Eleven review rounds showed that source/AST pinning of guard semantics inside main.ts trends
 * toward interpreter complexity: every "the structure exists" assertion admitted one more decoy
 * (import-vs-call, bare call, whole-file walk, dead-branch copies, coerced allowlists…). The stable
 * fix is the one the review prescribed: the DECISION logic is a directly executable pure function,
 * pinned by BEHAVIOR tests (permission → focus → redirect), and main.ts keeps only side-effectful
 * loading plus a thin, structurally-pinned delegation to this module.
 *
 * Ordering contract (behavior-tested; do not reorder):
 *   1. required-feature gate  → redirect home
 *   2. route permission gate  → redirect home
 *   3. attendance focus mode  → exact-path allowlist + '/attendance/admin/groups/' prefix
 *      (#4711 R0) + exact /learn and /admin/elearning (reachability only)
 *      + role-delegation (matched name, or canonical /admin/role-delegation)
 *      when canManageScope, else redirect /attendance
 *   4. plm-workbench focus    → prefix allowlist + exact /learn and /admin/elearning
 *      + role-delegation (matched name, or canonical /admin/role-delegation)
 *      when canManageScope, else redirect /plm
 *   5. ordinary shell         → role-delegation only when canManageScope;
 *      permission-management only when canManagePermissions.
 *      Identity is the matched route name, or the canonical path when the
 *      caller has no name. A longer path is not these routes.
 *   6. allow
 */
import { adminAccessCapabilitiesState, reconcileAdminAccessCapabilities } from '../composables/adminAccessCapabilities'
import { isRoutePermitted } from './routeAccess'
import { isAttendanceGroupContextPath } from './attendanceGroupContextRoute'
import {
  STOCK_PREP_PERMISSION_CODES,
  satisfiesStockPrepAccess,
  type StockPrepAccessSnapshot,
} from '../services/integration/stockPreparation/workbenchAccess'

/**
 * Attendance focus mode allows these EXACT paths, plus — since #4711 R0 — paths exactly
 * under '/attendance/admin/groups/' via isAttendanceFocusAllowedPath. No other prefixes:
 * '/attendance/x' still redirects.
 */
export const ATTENDANCE_FOCUS_ALLOWED_PATHS: readonly string[] = Object.freeze([
  '/attendance',
  '/p/plugin-attendance/attendance',
  '/settings',
])

/**
 * Cloud-classroom exact paths reachable inside attendance and plm-workbench focus
 * modes. Reachability only — required-feature and route permission gates still run
 * first. Sibling and prefix-neighbor paths stay redirected.
 * '/elearning/grading': the L3 manual-grading surface — without this entry a
 * grader working inside an attendance- or plm-focused org would be silently
 * bounced to that focus mode's home instead of reaching a route they hold
 * elearning:grade permission for.
 */
export const ELEARNING_FOCUS_EXACT_PATHS: readonly string[] = Object.freeze([
  '/learn',
  '/admin/elearning',
  '/elearning/grading',
])

export function isElearningFocusExactPath(path: string): boolean {
  return ELEARNING_FOCUS_EXACT_PATHS.includes(path)
}

/**
 * Attendance-focus reachability predicate (design lock §3.3, #4711 R0). The exact legacy
 * set is unchanged; a path is additionally reachable only when it is exactly under
 * '/attendance/admin/groups/'. Prefix neighbors such as '/attendance/admin/groups-evil/…'
 * remain rejected. This grants reachability ONLY — the required-feature and route
 * permission gates run before it and it confers no permission.
 */
export function isAttendanceFocusAllowedPath(path: string): boolean {
  return ATTENDANCE_FOCUS_ALLOWED_PATHS.includes(path) || isAttendanceGroupContextPath(path)
}

/**
 * plm-workbench focus mode allows these prefixes (exact match or `${prefix}/…`).
 * '/stock-prep': the stock-preparation operator shell is the natural companion of the PLM workbench
 * audience (#4468, owner-confirmed gap). Routes keep their own permission gates — this list only
 * governs reachability inside the focus mode. Every entry must be a non-empty absolute path: an
 * empty string would prefix-match EVERY route (behavior-tested).
 *
 * O2 / R-11: '/stock-prep' stays here unchanged. Focus-mode reachability confers NO permission — step
 * 2 of resolveRouteGuardDecision has already run by the time this list is consulted, so the route's
 * own `stock-prep:read` gate decides access and this entry only keeps the page from being bounced to
 * /plm for someone who already passed it.
 */
export const PLM_WORKBENCH_ALLOWED_PREFIXES: readonly string[] = Object.freeze([
  '/plm',
  '/workflows',
  '/approvals',
  '/integrations',
  '/stock-prep',
])

/**
 * Exported since O2 / R-11 so a suite can pin what is NOT here as well as what is.
 *
 * `/stock-prep` deliberately declares no `requiredFeature`, and the O2 permission work deliberately
 * did not add one. A product-feature flag is a SECOND, independent gate: with the flag off, step 1
 * redirects everyone — platform admins included — before the permission gate is ever consulted. That
 * would be a privilege regression on every deployment that has not turned the flag on, in a change
 * whose whole point is that admins lose nothing. The workbench's access story is therefore carried
 * entirely by the permission gate (step 2) and the shared vocabulary behind it.
 */
export const KNOWN_REQUIRED_FEATURES = ['attendance', 'workflow', 'attendanceAdmin', 'attendanceImport', 'plm', 'elearning', 'tasks'] as const
type KnownRequiredFeature = (typeof KNOWN_REQUIRED_FEATURES)[number]

export type RouteGuardDecision = { action: 'allow' } | { action: 'redirect'; target: string }

export interface RouteGuardPolicyContext {
  hasFeature: (feature: KnownRequiredFeature) => boolean
  hasPermission: (permission: string) => boolean
  attendanceFocused: boolean
  plmWorkbenchFocused: boolean
  resolveHomePath: () => string
  /**
   * Matched name `role-delegation`, or canonical `/admin/role-delegation` when
   * the caller has no name, in the ordinary shell and in attendance or PLM
   * focus. Omitted or false does not open that route, and it never opens any
   * other `/admin` path. The API flag is reachability: live platform admin, or
   * at least one delegable namespace.
   */
  canManageScope?: boolean
  /**
   * Matched name `permission-management`, or canonical `/admin/permissions`
   * when the caller has no name. Omitted or false denies that route. A legacy
   * `users.role` admin is not enough.
   */
  canManagePermissions?: boolean
}

const ROLE_DELEGATION_NAME = 'role-delegation'
const PERMISSION_SOURCE_NAME = 'permission-management'
const ROLE_DELEGATION_PATH = '/admin/role-delegation'
const PERMISSION_SOURCE_PATH = '/admin/permissions'

export interface RouteGuardDecisionInput {
  path: string
  meta: unknown
  /** Leaf route name when the caller has one. Harness objects may omit it. */
  name?: string
  /** Leaf name plus any matched record names. Absent when the caller has none. */
  matchedNames?: readonly string[]
}

function matchesKnownRoute(
  input: { path: string; name?: unknown; matchedNames?: readonly unknown[] },
  name: string,
  canonicalPath: string,
): boolean {
  if (input.name === name) return true
  if (Array.isArray(input.matchedNames) && input.matchedNames.some((candidate) => candidate === name)) {
    return true
  }
  return input.path === canonicalPath
}

function focusedRoleDelegationAllowed(
  ctx: RouteGuardPolicyContext,
  input: { path: string; name?: unknown; matchedNames?: readonly unknown[] },
): boolean {
  return ctx.canManageScope === true && matchesKnownRoute(input, ROLE_DELEGATION_NAME, ROLE_DELEGATION_PATH)
}


/**
 * Executable runtime adapter (round-13): builds the policy context from the live auth/flags stores.
 * Extracted so its wiring is BEHAVIOR-testable with injected fakes — hasPermission must delegate to
 * auth.hasPermission (a constant () => true here would disable real route permissions, which the
 * adapter tests pin), and the plm-focus typeof tolerance lives here, not inline in main.ts.
 */
export interface RouteGuardRuntimeDeps {
  auth: {
    hasPermission: (permission: string) => boolean
    /**
     * REQUIRED, and required for a reason. The three `stock-prep:*` codes are answered by the
     * server's own literal ladder rather than by `hasPermission` (see
     * `buildStockPrepAwarePermissionProbe`), and that ladder needs the `{ roles, permissions }`
     * principal, not a yes/no probe. Declaring it non-optional makes the TWO TYPED src call sites
     * (`main.ts`, `MyAppsLandingView.vue`) a compile error if they forget it, rather than a silent,
     * quieter-in-the-wrong-direction fallback.
     *
     * SCOPED CLAIM, said out loud: that is a guarantee about those call sites, NOT about every
     * caller. A spec assembling a deps literal, or any untyped JS caller, is not reached by the
     * type at all — which is why `buildStockPrepAwarePermissionProbe` ALSO fails closed at runtime
     * when the snapshot cannot be read, instead of trusting the type to have prevented it.
     */
    getAccessSnapshot: () => StockPrepAccessSnapshot
  }
  flags: {
    hasFeature: (feature: KnownRequiredFeature) => boolean
    isAttendanceFocused: () => boolean
    isPlmWorkbenchFocused?: unknown
    resolveHomePath: () => string
  }
}


/**
 * Executable input adapter (round-14): path/meta passthrough from the live route object. Extracted
 * so the wiring is behavior-testable — meta must be passed through IDENTICALLY (an inline `meta: {}`
 * would bypass every route's requiredFeature and permissions), and path folds to a string.
 */
export function buildRouteGuardInput(to: {
  path?: unknown
  meta?: unknown
  name?: unknown
  matched?: unknown
}): RouteGuardDecisionInput {
  const path = String((to && to.path) || '')
  const meta = to ? to.meta : undefined
  const matchedNames: string[] = []
  const addName = (value: unknown) => {
    if (typeof value !== 'string' || value.length === 0 || matchedNames.includes(value)) return
    matchedNames.push(value)
  }
  if (to) {
    addName(to.name)
    if (Array.isArray(to.matched)) {
      for (const record of to.matched) {
        if (record && typeof record === 'object') addName((record as { name?: unknown }).name)
      }
    }
  }
  if (matchedNames.length === 0) return { path, meta }
  const name = typeof to?.name === 'string' && to.name.length > 0 ? to.name : matchedNames[0]
  return { path, meta, name, matchedNames }
}

/**
 * THE ROUTE PROBE, with the three stock-prep codes answered by the workbench's own gate.
 *
 * `useAuth().hasPermission` is the app-wide probe and it EXPANDS: `stock-prep:*` and `*:*` both
 * satisfy `stock-prep:read`, `:write` implies `:read`, and `users:write` counts as admin. The
 * stock-prep server gate (`stock-preparation-workbench-access.cjs`, mirrored expression-for-
 * expression by `satisfiesStockPrepAccess`) matches LITERALLY and does none of that — so before this
 * wrapper, `/stock-prep` admitted three principals every panel behind it then refused, and
 * redirected one (a bare `integration:admin`) the server serves in full.
 *
 * SCOPE IS EXACTLY THREE CODES. Every other permission on every other route still goes to
 * `hasPermission`, byte for byte; `/stock-prep` is the only route in `appRoutes.ts` whose
 * `meta.permissions` names one of these, so nothing else changes behaviour. FAIL-CLOSED on a
 * snapshot that cannot be read: an unreadable principal is an empty one, and an empty principal
 * satisfies nothing.
 */
export function buildStockPrepAwarePermissionProbe(
  hasPermission: (permission: string) => boolean,
  getAccessSnapshot: () => StockPrepAccessSnapshot,
): (permission: string) => boolean {
  return (permission) => {
    if (!STOCK_PREP_PERMISSION_CODES.includes(permission)) return hasPermission(permission)
    let snapshot: StockPrepAccessSnapshot
    try {
      snapshot = getAccessSnapshot()
    } catch {
      // No principal readable -> no stock-prep code held. Never falls through to the wider probe:
      // a fallback that widens on failure is how a gate quietly stops being one.
      return false
    }
    return satisfiesStockPrepAccess(snapshot, permission)
  }
}

export function buildRouteGuardContext(deps: RouteGuardRuntimeDeps): RouteGuardPolicyContext {
  const permissionProbe = buildStockPrepAwarePermissionProbe(
    (permission) => deps.auth.hasPermission(permission),
    () => deps.auth.getAccessSnapshot(),
  )
  reconcileAdminAccessCapabilities()
  return {
    hasFeature: (feature) => deps.flags.hasFeature(feature),
    hasPermission: (permission) => permissionProbe(permission),
    attendanceFocused: deps.flags.isAttendanceFocused(),
    plmWorkbenchFocused:
      typeof deps.flags.isPlmWorkbenchFocused === 'function' &&
      (deps.flags.isPlmWorkbenchFocused as () => boolean)(),
    resolveHomePath: () => deps.flags.resolveHomePath(),
    canManageScope:
      adminAccessCapabilitiesState.loaded === true && adminAccessCapabilitiesState.canManageScope === true,
    canManagePermissions:
      adminAccessCapabilitiesState.loaded === true && adminAccessCapabilitiesState.canManagePermissions === true,
  }
}

export function resolveRouteGuardDecision(
  input: RouteGuardDecisionInput,
  ctx: RouteGuardPolicyContext,
): RouteGuardDecision {
  const meta = (input.meta ?? {}) as Record<string, unknown>

  // 1. required-feature gate (unknown feature strings are ignored, same as the pre-extraction guard).
  const required = meta.requiredFeature
  const requiredFeature = KNOWN_REQUIRED_FEATURES.includes(required as KnownRequiredFeature)
    ? (required as KnownRequiredFeature)
    : null
  if (requiredFeature && !ctx.hasFeature(requiredFeature)) {
    return { action: 'redirect', target: ctx.resolveHomePath() }
  }

  // 2. route permission gate — runs BEFORE any focus allowlist (an allowlist can restore
  //    reachability but never grant permission).
  if (!isRoutePermitted(input.meta as Parameters<typeof isRoutePermitted>[0], ctx.hasPermission)) {
    return { action: 'redirect', target: ctx.resolveHomePath() }
  }

  const path = String(input.path || '')

  // 3. attendance focus: exact-path set + bounded #4711 group-context prefix
  //    + exact cloud-classroom paths + role-delegation (matched name or canonical
  //    path) when canManageScope. A longer path is not that route.
  if (
    ctx.attendanceFocused
    && !isAttendanceFocusAllowedPath(path)
    && !isElearningFocusExactPath(path)
    && !focusedRoleDelegationAllowed(ctx, input)
  ) {
    return { action: 'redirect', target: '/attendance' }
  }

  // 4. plm-workbench focus: prefix allowlist + exact cloud-classroom paths
  //    + role-delegation (matched name or canonical path) when canManageScope.
  if (ctx.plmWorkbenchFocused) {
    const allowed = PLM_WORKBENCH_ALLOWED_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    ) || isElearningFocusExactPath(path) || focusedRoleDelegationAllowed(ctx, input)
    if (!allowed) {
      return { action: 'redirect', target: '/plm' }
    }
  }

  // Ordinary shell. Focus mode already redirected these routes to its own home.
  // Name match covers trailing-slash and case variants whose to.path stays raw.
  if (
    !ctx.attendanceFocused
    && !ctx.plmWorkbenchFocused
    && matchesKnownRoute(input, ROLE_DELEGATION_NAME, ROLE_DELEGATION_PATH)
    && ctx.canManageScope !== true
  ) {
    return { action: 'redirect', target: ctx.resolveHomePath() }
  }
  if (
    matchesKnownRoute(input, PERMISSION_SOURCE_NAME, PERMISSION_SOURCE_PATH)
    && ctx.canManagePermissions !== true
  ) {
    return { action: 'redirect', target: ctx.resolveHomePath() }
  }

  return { action: 'allow' }
}
