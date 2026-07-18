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
 *   3. attendance focus mode  → exact-path allowlist, else redirect /attendance
 *   4. plm-workbench focus    → prefix allowlist, else redirect /plm
 *   5. allow
 */
import { isRoutePermitted } from './routeAccess'

/** Attendance focus mode allows EXACT paths only (no prefixes — '/attendance/x' redirects). */
export const ATTENDANCE_FOCUS_ALLOWED_PATHS: readonly string[] = Object.freeze([
  '/attendance',
  '/p/plugin-attendance/attendance',
  '/settings',
])

/**
 * plm-workbench focus mode allows these prefixes (exact match or `${prefix}/…`).
 * '/stock-prep': the stock-preparation operator shell is the natural companion of the PLM workbench
 * audience (#4468, owner-confirmed gap). Routes keep their own permission gates — this list only
 * governs reachability inside the focus mode. Every entry must be a non-empty absolute path: an
 * empty string would prefix-match EVERY route (behavior-tested).
 */
export const PLM_WORKBENCH_ALLOWED_PREFIXES: readonly string[] = Object.freeze([
  '/plm',
  '/workflows',
  '/approvals',
  '/integrations',
  '/stock-prep',
])

const KNOWN_REQUIRED_FEATURES = ['attendance', 'workflow', 'attendanceAdmin', 'attendanceImport', 'plm'] as const
type KnownRequiredFeature = (typeof KNOWN_REQUIRED_FEATURES)[number]

export type RouteGuardDecision = { action: 'allow' } | { action: 'redirect'; target: string }

export interface RouteGuardPolicyContext {
  hasFeature: (feature: KnownRequiredFeature) => boolean
  hasPermission: (permission: string) => boolean
  attendanceFocused: boolean
  plmWorkbenchFocused: boolean
  resolveHomePath: () => string
}


/**
 * Executable runtime adapter (round-13): builds the policy context from the live auth/flags stores.
 * Extracted so its wiring is BEHAVIOR-testable with injected fakes — hasPermission must delegate to
 * auth.hasPermission (a constant () => true here would disable real route permissions, which the
 * adapter tests pin), and the plm-focus typeof tolerance lives here, not inline in main.ts.
 */
export interface RouteGuardRuntimeDeps {
  auth: { hasPermission: (permission: string) => boolean }
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
export function buildRouteGuardInput(to: { path?: unknown; meta?: unknown }): { path: string; meta: unknown } {
  return { path: String((to && to.path) || ''), meta: to ? to.meta : undefined }
}

export function buildRouteGuardContext(deps: RouteGuardRuntimeDeps): RouteGuardPolicyContext {
  return {
    hasFeature: (feature) => deps.flags.hasFeature(feature),
    hasPermission: (permission) => deps.auth.hasPermission(permission),
    attendanceFocused: deps.flags.isAttendanceFocused(),
    plmWorkbenchFocused:
      typeof deps.flags.isPlmWorkbenchFocused === 'function' &&
      (deps.flags.isPlmWorkbenchFocused as () => boolean)(),
    resolveHomePath: () => deps.flags.resolveHomePath(),
  }
}

export function resolveRouteGuardDecision(
  input: { path: string; meta: unknown },
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

  // 3. attendance focus: exact-path set.
  if (ctx.attendanceFocused && !ATTENDANCE_FOCUS_ALLOWED_PATHS.includes(path)) {
    return { action: 'redirect', target: '/attendance' }
  }

  // 4. plm-workbench focus: prefix allowlist.
  if (ctx.plmWorkbenchFocused) {
    const allowed = PLM_WORKBENCH_ALLOWED_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    )
    if (!allowed) {
      return { action: 'redirect', target: '/plm' }
    }
  }

  return { action: 'allow' }
}
