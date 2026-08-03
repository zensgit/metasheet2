/**
 * #4711 R0 — attendance group-context route contract (pure, no I/O).
 *
 * Design lock: docs/development/attendance-4711-group-context-routes-design-lock-20260801.md
 * (ratified at 8806e9679e3e7a19ba57d310f799c2962dd01680, OD-4711-1..7 recommended values).
 *
 * This module owns ONLY the closed parsing/mapping rules for the canonical route family
 *
 *   /attendance/admin/groups/:groupId/{schedule,calendar,rules}
 *
 * - `groupId` must be a UUID-shaped string; anything else is the not-found posture.
 * - The public step union is closed: `schedule | calendar | rules`. It is NOT the group
 *   editor's `basics | people | schedule | policies` stage union.
 * - The optional `surface` query is parsed through a closed table keyed by the step
 *   (OD-4711-7). Unknown steps and illegal step/surface pairs never fall back silently —
 *   they resolve to null here, i.e. the route-level not-found posture.
 * - `returnTo` is optional query state normalized to a safe local path under `/attendance`,
 *   falling back to the group list section (OD-4711-5).
 *
 * R0 scope: this module performs no data loading, mounts no content, and grants no
 * permission. The guardPolicy focus predicate grants reachability only; feature and
 * permission gates still run before it.
 */

/** Path prefix of the group-context route family. The trailing slash is load-bearing:
 *  '/attendance/admin/groups-evil/…' must NOT match (mutation proof #7). */
export const ATTENDANCE_GROUP_ROUTE_PATH_PREFIX = '/attendance/admin/groups/'

/** Closed public route-step union (design lock §3.1). */
export const ATTENDANCE_GROUP_ROUTE_STEPS = Object.freeze(['schedule', 'calendar', 'rules'] as const)
export type AttendanceGroupRouteStep = (typeof ATTENDANCE_GROUP_ROUTE_STEPS)[number]

/** Closed step-scoped surface table (design lock §3.1, OD-4711-7). `calendar` has none. */
export const ATTENDANCE_GROUP_STEP_SURFACES: Readonly<Record<AttendanceGroupRouteStep, readonly string[]>> =
  Object.freeze({
    schedule: Object.freeze(['shifts', 'assignments', 'advanced-scheduling'] as const),
    calendar: Object.freeze([] as const),
    rules: Object.freeze(['rule-sets'] as const),
  })
export type AttendanceGroupRouteSurface = 'shifts' | 'assignments' | 'advanced-scheduling' | 'rule-sets'

/**
 * Fixed route-to-host mapping targets (design lock §3.1). Values reference EXISTING group
 * stages / admin section identifiers only; no caller-supplied section id is ever selected.
 */
export type AttendanceGroupRouteTarget =
  | { kind: 'group-stage'; stage: 'schedule' | 'policies' }
  | {
      kind: 'admin-section'
      section:
        | 'attendance-admin-shifts'
        | 'attendance-admin-assignments'
        | 'attendance-admin-advanced-scheduling-workbench'
        | 'attendance-admin-holidays'
        | 'attendance-admin-rule-sets'
    }

/** Safe return fallback (OD-4711-5): the attendance group list section. */
export const ATTENDANCE_GROUP_ROUTE_DEFAULT_RETURN_TO =
  '/attendance?tab=admin&section=attendance-admin-groups'

const GROUP_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** UUID shape check for the `:groupId` route param. */
export function isAttendanceGroupId(value: unknown): value is string {
  return typeof value === 'string' && GROUP_ID_PATTERN.test(value)
}

/**
 * Attendance-focus reachability predicate (design lock §3.3): a path is part of the
 * group-context family only when it is EXACTLY under '/attendance/admin/groups/'.
 * Prefix neighbors such as '/attendance/admin/groups-evil/…' are rejected. This grants
 * reachability only — never permission.
 */
export function isAttendanceGroupContextPath(path: unknown): boolean {
  return typeof path === 'string' && path.startsWith(ATTENDANCE_GROUP_ROUTE_PATH_PREFIX)
}

/** Closed step parser. `basics`/`people` and anything unknown return null (not-found). */
export function parseAttendanceGroupRouteStep(value: unknown): AttendanceGroupRouteStep | null {
  return typeof value === 'string' &&
    (ATTENDANCE_GROUP_ROUTE_STEPS as readonly string[]).includes(value)
    ? (value as AttendanceGroupRouteStep)
    : null
}

export type AttendanceGroupRouteSurfaceParse =
  | { ok: true; surface: AttendanceGroupRouteSurface | null }
  | { ok: false }

/**
 * Step-scoped closed surface parser. Absent (`undefined`/`null`) means the step's default
 * host (`{ ok: true, surface: null }`). A present value must be in the step's row of the
 * closed table; anything else — including non-string query values — is `{ ok: false }`.
 */
export function parseAttendanceGroupRouteSurface(
  step: AttendanceGroupRouteStep,
  value: unknown,
): AttendanceGroupRouteSurfaceParse {
  if (value === undefined || value === null) return { ok: true, surface: null }
  if (typeof value !== 'string') return { ok: false }
  return (ATTENDANCE_GROUP_STEP_SURFACES[step] as readonly string[]).includes(value)
    ? { ok: true, surface: value as AttendanceGroupRouteSurface }
    : { ok: false }
}

/**
 * Fixed step/surface → host mapping (design lock §3.1 table). Returns null for illegal
 * pairs; callers normally reach this only after `parseAttendanceGroupRouteSurface` has
 * already accepted the pair, so null here means the contract was bypassed.
 */
export function resolveAttendanceGroupRouteTarget(
  step: AttendanceGroupRouteStep,
  surface: AttendanceGroupRouteSurface | null,
): AttendanceGroupRouteTarget | null {
  switch (step) {
    case 'schedule':
      switch (surface) {
        case null:
          return { kind: 'group-stage', stage: 'schedule' }
        case 'shifts':
          return { kind: 'admin-section', section: 'attendance-admin-shifts' }
        case 'assignments':
          return { kind: 'admin-section', section: 'attendance-admin-assignments' }
        case 'advanced-scheduling':
          return { kind: 'admin-section', section: 'attendance-admin-advanced-scheduling-workbench' }
        default:
          return null
      }
    case 'calendar':
      return surface === null ? { kind: 'admin-section', section: 'attendance-admin-holidays' } : null
    case 'rules':
      switch (surface) {
        case null:
          return { kind: 'group-stage', stage: 'policies' }
        case 'rule-sets':
          return { kind: 'admin-section', section: 'attendance-admin-rule-sets' }
        default:
          return null
      }
    default:
      return null
  }
}

function pathPartOnly(value: string): string {
  return value.split('#', 1)[0]?.split('?', 1)[0] || ''
}

/**
 * Safe `returnTo` normalizer (design lock §3.4). Accepts only a local path under
 * `/attendance`; rejects protocol-relative (`//…`) values, anything not under
 * `/attendance` (which subsumes schemes and login routes), the current group route
 * itself, and nested `returnTo` recursion. Every rejection falls back to
 * ATTENDANCE_GROUP_ROUTE_DEFAULT_RETURN_TO.
 */
export function normalizeAttendanceGroupReturnTo(value: unknown, currentPath?: unknown): string {
  if (typeof value !== 'string') return ATTENDANCE_GROUP_ROUTE_DEFAULT_RETURN_TO
  const candidate = value.trim()
  if (!candidate) return ATTENDANCE_GROUP_ROUTE_DEFAULT_RETURN_TO
  // Local path only: single leading slash, never protocol-relative, never a scheme.
  if (!candidate.startsWith('/') || candidate.startsWith('//')) {
    return ATTENDANCE_GROUP_ROUTE_DEFAULT_RETURN_TO
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) return ATTENDANCE_GROUP_ROUTE_DEFAULT_RETURN_TO

  const pathOnly = pathPartOnly(candidate)
  if (pathOnly.includes('\\') || /%(?:2e|2f|5c)/i.test(pathOnly)) {
    return ATTENDANCE_GROUP_ROUTE_DEFAULT_RETURN_TO
  }
  let parsed: URL
  try {
    parsed = new URL(candidate, 'http://attendance.local')
  } catch {
    return ATTENDANCE_GROUP_ROUTE_DEFAULT_RETURN_TO
  }
  const normalizedPath = parsed.pathname
  // Under /attendance exactly ('/attendance' or '/attendance/…' — '/attendance-evil' fails).
  if (normalizedPath !== '/attendance' && !normalizedPath.startsWith('/attendance/')) {
    return ATTENDANCE_GROUP_ROUTE_DEFAULT_RETURN_TO
  }
  // Never return to the current group route itself (return loop).
  if (typeof currentPath === 'string' && currentPath.trim()) {
    if (normalizedPath === pathPartOnly(currentPath.trim())) return ATTENDANCE_GROUP_ROUTE_DEFAULT_RETURN_TO
  }
  // No nested returnTo recursion.
  const queryStart = candidate.indexOf('?')
  if (queryStart >= 0) {
    const queryPart = candidate.slice(queryStart + 1).split('#', 1)[0] ?? ''
    if (new URLSearchParams(queryPart).has('returnTo')) {
      return ATTENDANCE_GROUP_ROUTE_DEFAULT_RETURN_TO
    }
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`
}

/** Fully parsed group-context route, or null for the not-found posture. */
export interface AttendanceGroupRouteContext {
  groupId: string
  step: AttendanceGroupRouteStep
  surface: AttendanceGroupRouteSurface | null
  target: AttendanceGroupRouteTarget
  returnTo: string
}

/**
 * Combined pure parser for one route resolution (design lock §3.3 hydration step 1 — parse
 * only, no data loading). Any invalid groupId, unknown step, or illegal step/surface pair
 * yields null (route-level not-found); `returnTo` never fails, it falls back.
 */
export function resolveAttendanceGroupRouteContext(input: {
  groupId?: unknown
  step?: unknown
  surface?: unknown
  returnTo?: unknown
  currentPath?: unknown
}): AttendanceGroupRouteContext | null {
  if (!isAttendanceGroupId(input.groupId)) return null
  const step = parseAttendanceGroupRouteStep(input.step)
  if (!step) return null
  const parsedSurface = parseAttendanceGroupRouteSurface(step, input.surface)
  if (!parsedSurface.ok) return null
  const target = resolveAttendanceGroupRouteTarget(step, parsedSurface.surface)
  if (!target) return null
  return {
    groupId: input.groupId,
    step,
    surface: parsedSurface.surface,
    target,
    returnTo: normalizeAttendanceGroupReturnTo(input.returnTo, input.currentPath),
  }
}
