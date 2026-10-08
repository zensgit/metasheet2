import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import {
  ATTENDANCE_GROUP_ROUTE_DEFAULT_RETURN_TO,
  ATTENDANCE_GROUP_ROUTE_PATH_PREFIX,
  ATTENDANCE_GROUP_ROUTE_STEPS,
  buildAttendanceGroupRouteHref,
  isAttendanceGroupContextPath,
  isAttendanceGroupId,
  normalizeAttendanceGroupReturnTo,
  parseAttendanceGroupRouteStep,
  parseAttendanceGroupRouteSurface,
  resolveAttendanceGroupRouteContext,
  resolveAttendanceGroupRouteTarget,
} from '../src/router/attendanceGroupContextRoute'
import {
  ATTENDANCE_FOCUS_ALLOWED_PATHS,
  isAttendanceFocusAllowedPath,
  resolveRouteGuardDecision,
  type RouteGuardPolicyContext,
} from '../src/router/guardPolicy'

/**
 * #4711 R0 — frontend/pure-contract half of the group-context route lock
 * (docs/development/attendance-4711-group-context-routes-design-lock-20260801.md,
 * ratified 8806e967, OD-4711-1..7 recommended values).
 *
 * Covers: the three canonical route declarations (permission-neutral), closed step and
 * step-scoped surface parsers (every legal/illegal pair), the safe returnTo normalizer
 * (schemes, protocol-relative, recursion, in-app targets), valid/invalid UUIDs, the
 * bounded attendance-focus prefix predicate (exact/prefix/near-prefix, groups-evil
 * negatives), guard ordering, and legacy /attendance compatibility.
 *
 * R0 pins NO content mounting, scoped fetching, permission grants, hash ownership, or
 * drawer rewiring — those are R1/R2.
 */

const VALID_UUID = '2f6b1d2c-9a3e-4c5b-8d7e-1a2b3c4d5e6f'
const VALID_UUID_UPPER = '2F6B1D2C-9A3E-4C5B-8D7E-1A2B3C4D5E6F'
const NIL_UUID = '00000000-0000-0000-0000-000000000000'

describe('attendance group-context route declarations (appRoutes source)', () => {
  // Asserted on SOURCE, not an import — appRoutes top-level imports real .vue views, which
  // pull in Element Plus CSS that vitest can't transform (same pattern as
  // myDelegationRoute.spec.ts / approvalDelegationRoute.spec.ts).
  const routesSrc = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/router/appRoutes.ts'),
    'utf8',
  )

  const routeBlock = (routePath: string): string => {
    const start = routesSrc.indexOf(`path: '${routePath}'`)
    expect(start, `route ${routePath} is not declared`).toBeGreaterThanOrEqual(0)
    const rest = routesSrc.slice(start)
    const nextRoute = rest.indexOf("path: '", 1)
    return nextRoute === -1 ? rest : rest.slice(0, nextRoute)
  }

  it.each(['schedule', 'calendar', 'rules'])(
    'declares the canonical /attendance/admin/groups/:groupId/%s route on the attendance shell',
    (step) => {
      const block = routeBlock(`/attendance/admin/groups/:groupId/${step}`)
      expect(block).toContain('AttendanceExperienceView')
      expect(block).toContain('requiresAuth: true')
    },
  )

  it.each(['schedule', 'calendar', 'rules'])(
    'keeps /attendance/admin/groups/:groupId/%s permission-neutral (attendanceAdmin feature only; no permissions/roles/requiresAdmin gate)',
    (step) => {
      const block = routeBlock(`/attendance/admin/groups/:groupId/${step}`)
      expect(block).not.toContain('permissions')
      expect(block).not.toContain('roles')
      expect(block).not.toContain('requiresAdmin')
      // Design lock §3.2 / OD-4711-2: the v1 audience is attendance administrators — the route
      // requires the attendanceAdmin feature while staying inside the attendance shell. The
      // route itself grants nothing new.
      expect(block).toContain("requiredFeature: 'attendanceAdmin'")
    },
  )

  it('closes the step union: no dynamic :step segment and no basics/people routes', () => {
    expect(routesSrc).not.toContain('/attendance/admin/groups/:groupId/:step')
    expect(routesSrc).not.toContain('/attendance/admin/groups/:groupId/basics')
    expect(routesSrc).not.toContain('/attendance/admin/groups/:groupId/people')
  })

  it('keeps the legacy /attendance route untouched', () => {
    const block = routeBlock('/attendance')
    expect(block).toContain("name: 'attendance'")
    expect(block).toContain('AttendanceExperienceView')
    expect(block).toContain("requiredFeature: 'attendance'")
  })
})

describe('isAttendanceGroupId (UUID shape)', () => {
  it.each([VALID_UUID, VALID_UUID_UPPER, NIL_UUID])('accepts UUID-shaped %s', (value) => {
    expect(isAttendanceGroupId(value)).toBe(true)
  })

  it.each([
    'not-a-uuid',
    '',
    '123',
    '2f6b1d2c9a3e4c5b8d7e1a2b3c4d5e6f', // missing dashes
    '2f6b1d2c-9a3e-4c5b-8d7e-1a2b3c4d5e6f00', // wrong length
    '2f6b1d2c-9a3e-4c5b-8d7e-1a2b3c4d5e6x', // non-hex
    ` ${VALID_UUID}`, // surrounding whitespace is not trimmed away
    `${VALID_UUID}/extra`,
  ])('rejects invalid group id %j', (value) => {
    expect(isAttendanceGroupId(value)).toBe(false)
  })

  it.each([undefined, null, 123, [VALID_UUID], {}])('rejects non-string group id %j', (value) => {
    expect(isAttendanceGroupId(value)).toBe(false)
  })
})

describe('parseAttendanceGroupRouteStep (closed union)', () => {
  it.each(['schedule', 'calendar', 'rules'] as const)('accepts %s', (step) => {
    expect(parseAttendanceGroupRouteStep(step)).toBe(step)
  })

  it('pins the step union to exactly schedule|calendar|rules', () => {
    expect([...ATTENDANCE_GROUP_ROUTE_STEPS]).toEqual(['schedule', 'calendar', 'rules'])
  })

  it.each([
    'basics', // group editor stage, outside the route family
    'people', // group editor stage, outside the route family
    'policies', // internal stage name, not a public step
    'holidays', // internal surface name, not a public step
    'Schedule', // case-sensitive
    '',
    'schedule/extra',
  ])('rejects unknown step %j', (value) => {
    expect(parseAttendanceGroupRouteStep(value)).toBeNull()
  })

  it.each([undefined, null, 1, ['schedule']])('rejects non-string step %j', (value) => {
    expect(parseAttendanceGroupRouteStep(value)).toBeNull()
  })
})

describe('parseAttendanceGroupRouteSurface + resolveAttendanceGroupRouteTarget (closed table)', () => {
  const legalPairs: Array<[string, string | null, unknown]> = [
    ['schedule', null, { kind: 'group-stage', stage: 'schedule' }],
    ['schedule', 'shifts', { kind: 'admin-section', section: 'attendance-admin-shifts' }],
    ['schedule', 'assignments', { kind: 'admin-section', section: 'attendance-admin-assignments' }],
    [
      'schedule',
      'advanced-scheduling',
      { kind: 'admin-section', section: 'attendance-admin-advanced-scheduling-workbench' },
    ],
    ['calendar', null, { kind: 'admin-section', section: 'attendance-admin-holidays' }],
    ['rules', null, { kind: 'group-stage', stage: 'policies' }],
    ['rules', 'rule-sets', { kind: 'admin-section', section: 'attendance-admin-rule-sets' }],
  ]

  it.each(legalPairs)(
    'legal pair %s?surface=%s parses and maps to the fixed target',
    (step, surface, target) => {
      const typedStep = step as 'schedule' | 'calendar' | 'rules'
      const parsed = parseAttendanceGroupRouteSurface(typedStep, surface === null ? undefined : surface)
      expect(parsed).toEqual({ ok: true, surface })
      expect(resolveAttendanceGroupRouteTarget(typedStep, surface as never)).toEqual(target)
    },
  )

  const illegalPairs: Array<[string, unknown]> = [
    ['schedule', 'rule-sets'], // surface from another step's row
    ['schedule', 'basics'],
    ['schedule', ''],
    ['schedule', 'SHIFTS'], // case-sensitive
    ['calendar', 'shifts'], // calendar accepts NO surface
    ['calendar', 'rule-sets'],
    ['calendar', 'advanced-scheduling'],
    ['rules', 'shifts'],
    ['rules', 'assignments'],
    ['rules', 'advanced-scheduling'],
    ['rules', 'attendance-admin-rule-sets'], // raw section ids are not surfaces
    ['schedule', 'attendance-admin-shifts'],
    ['schedule', ['shifts']], // array query values are invalid
    ['rules', 1],
  ]

  it.each(illegalPairs)('illegal pair %s?surface=%j is rejected (not-found, no silent fallback)', (step, surface) => {
    const typedStep = step as 'schedule' | 'calendar' | 'rules'
    expect(parseAttendanceGroupRouteSurface(typedStep, surface)).toEqual({ ok: false })
    if (typeof surface === 'string' || surface === null) {
      expect(resolveAttendanceGroupRouteTarget(typedStep, surface as never)).toBeNull()
    }
  })

  it('only an omitted surface means the step default host; a valueless query is rejected', () => {
    expect(parseAttendanceGroupRouteSurface('schedule', undefined)).toEqual({ ok: true, surface: null })
    expect(parseAttendanceGroupRouteSurface('rules', null)).toEqual({ ok: false })
    expect(parseAttendanceGroupRouteSurface('calendar', undefined)).toEqual({ ok: true, surface: null })
  })
})

describe('buildAttendanceGroupRouteHref (R2 entry points)', () => {
  it.each([
    ['schedule', 'shifts', 'schedule?surface=shifts'],
    ['schedule', 'assignments', 'schedule?surface=assignments'],
    ['schedule', 'advanced-scheduling', 'schedule?surface=advanced-scheduling'],
    ['calendar', null, 'calendar?returnTo='],
    ['rules', 'rule-sets', 'rules?surface=rule-sets'],
  ] as const)('builds the canonical %s/%s destination', (step, surface, expectedFragment) => {
    const href = buildAttendanceGroupRouteHref({
      groupId: VALID_UUID,
      step,
      surface,
      returnTo: '/attendance?tab=admin&section=attendance-admin-groups',
    })
    expect(href).toContain(`/attendance/admin/groups/${VALID_UUID}/${expectedFragment}`)
    expect(href).toContain('returnTo=%2Fattendance%3Ftab%3Dadmin%26section%3Dattendance-admin-groups')
  })

  it('fails closed for an invalid group id or illegal step/surface pair', () => {
    expect(buildAttendanceGroupRouteHref({
      groupId: 'group-a',
      step: 'schedule',
      surface: 'assignments',
      returnTo: '/attendance',
    })).toBeNull()
    expect(buildAttendanceGroupRouteHref({
      groupId: VALID_UUID,
      step: 'calendar',
      surface: 'shifts',
      returnTo: '/attendance',
    })).toBeNull()
  })
})

describe('normalizeAttendanceGroupReturnTo (safe return target, OD-4711-5)', () => {
  const FALLBACK = ATTENDANCE_GROUP_ROUTE_DEFAULT_RETURN_TO

  it('pins the fallback to the attendance group list section', () => {
    expect(FALLBACK).toBe('/attendance?tab=admin&section=attendance-admin-groups')
  })

  it.each([
    '/attendance',
    '/attendance?tab=admin&section=attendance-admin-groups',
    '/attendance?tab=admin&section=attendance-admin-shifts',
    '/attendance#attendance-admin-groups',
    `/attendance/admin/groups/${VALID_UUID}/rules`, // a DIFFERENT group route is a safe in-app target
  ])('accepts safe in-app return target %j', (value) => {
    expect(normalizeAttendanceGroupReturnTo(value, '/attendance/admin/groups/11111111-2222-4333-8444-555555555555/schedule'))
      .toBe(value)
  })

  it.each([
    '//evil.example/attendance', // protocol-relative
    '//attendance',
    '/attendance/%2e%2e/login', // encoded dot traversal
    '/attendance%2f..%2flogin', // encoded slash traversal
    '/attendance/..\\login', // backslash traversal
    'https://evil.example/attendance', // scheme
    'http://evil.example',
    'javascript:alert(1)',
    'attendance', // not absolute
    'relative/path',
    '',
    '   ',
    '/',
    '/login', // login route
    '/login?redirect=/attendance',
    '/multitable',
    '/attendance-evil', // near-prefix is NOT under /attendance
    '/attendancex',
    '/settings',
  ])('rejects unsafe or out-of-scope target %j', (value) => {
    expect(normalizeAttendanceGroupReturnTo(value)).toBe(FALLBACK)
  })

  it.each([undefined, null, 42, ['/attendance'], {}])(
    'rejects non-string returnTo %j',
    (value) => {
      expect(normalizeAttendanceGroupReturnTo(value)).toBe(FALLBACK)
    },
  )

  it.each([
    '/attendance?returnTo=/attendance', // nested returnTo recursion
    '/attendance?tab=admin&returnTo=https://evil.example',
    `/attendance/admin/groups/${VALID_UUID}/rules?returnTo=/attendance`,
  ])('rejects recursive returnTo %j', (value) => {
    expect(normalizeAttendanceGroupReturnTo(value)).toBe(FALLBACK)
  })

  it('rejects the current group route itself (return loop)', () => {
    const current = `/attendance/admin/groups/${VALID_UUID}/schedule`
    expect(normalizeAttendanceGroupReturnTo(current, current)).toBe(FALLBACK)
    // Same path with a trailing query is still the current route.
    expect(normalizeAttendanceGroupReturnTo(`${current}?surface=shifts`, current)).toBe(FALLBACK)
    // A different step on the SAME group is a different route and stays valid.
    const other = `/attendance/admin/groups/${VALID_UUID}/rules`
    expect(normalizeAttendanceGroupReturnTo(other, current)).toBe(other)
  })
})

describe('resolveAttendanceGroupRouteContext (combined pure parse)', () => {
  it('resolves a fully valid route with surface and safe returnTo', () => {
    expect(
      resolveAttendanceGroupRouteContext({
        groupId: VALID_UUID,
        step: 'schedule',
        surface: 'shifts',
        returnTo: '/attendance?tab=admin',
        currentPath: `/attendance/admin/groups/${VALID_UUID}/schedule`,
      }),
    ).toEqual({
      groupId: VALID_UUID,
      step: 'schedule',
      surface: 'shifts',
      target: { kind: 'admin-section', section: 'attendance-admin-shifts' },
      returnTo: '/attendance?tab=admin',
    })
  })

  it('defaults absent surface/returnTo without failing', () => {
    const resolved = resolveAttendanceGroupRouteContext({ groupId: NIL_UUID, step: 'calendar' })
    expect(resolved).toEqual({
      groupId: NIL_UUID,
      step: 'calendar',
      surface: null,
      target: { kind: 'admin-section', section: 'attendance-admin-holidays' },
      returnTo: ATTENDANCE_GROUP_ROUTE_DEFAULT_RETURN_TO,
    })
  })

  it.each([
    [{ groupId: 'not-a-uuid', step: 'schedule' }, 'invalid UUID'],
    [{ groupId: VALID_UUID, step: 'basics' }, 'unknown step'],
    [{ groupId: VALID_UUID, step: 'calendar', surface: 'shifts' }, 'illegal step/surface pair'],
    [{ groupId: VALID_UUID, step: 'schedule', surface: ['shifts'] }, 'non-string surface'],
  ])('returns null (route-level not-found) for %j (%s)', (input, _why) => {
    expect(resolveAttendanceGroupRouteContext(input)).toBeNull()
  })

  it('an unsafe returnTo never fails the resolution — it falls back', () => {
    const resolved = resolveAttendanceGroupRouteContext({
      groupId: VALID_UUID,
      step: 'rules',
      returnTo: '//evil.example',
    })
    expect(resolved?.returnTo).toBe(ATTENDANCE_GROUP_ROUTE_DEFAULT_RETURN_TO)
  })
})

describe('attendance-focus reachability predicate (bounded prefix, design lock §3.3)', () => {
  it('keeps the exact legacy allowed-path set unchanged', () => {
    expect([...ATTENDANCE_FOCUS_ALLOWED_PATHS]).toEqual([
      '/attendance',
      '/p/plugin-attendance/attendance',
      '/settings',
    ])
  })

  it('pins the group-context prefix with its load-bearing trailing slash', () => {
    expect(ATTENDANCE_GROUP_ROUTE_PATH_PREFIX).toBe('/attendance/admin/groups/')
  })

  it.each([
    `/attendance/admin/groups/${VALID_UUID}/schedule`,
    `/attendance/admin/groups/${VALID_UUID}/calendar`,
    `/attendance/admin/groups/${VALID_UUID}/rules`,
    `/attendance/admin/groups/${VALID_UUID}/rules/anything`, // reachability only; the router still 404s non-canonical shapes
  ])('allows path exactly under the prefix: %s', (path) => {
    expect(isAttendanceGroupContextPath(path)).toBe(true)
    expect(isAttendanceFocusAllowedPath(path)).toBe(true)
  })

  it.each([
    '/attendance/admin/groups-evil', // near-prefix neighbor
    '/attendance/admin/groups-evil/2f6b1d2c-9a3e-4c5b-8d7e-1a2b3c4d5e6f/schedule',
    '/attendance/admin/groups', // no trailing slash: not UNDER the prefix
    '/attendance/admin/group/2f6b1d2c-9a3e-4c5b-8d7e-1a2b3c4d5e6f/schedule',
    '/attendance/admin',
    '/attendance/sub',
    '/attendancex/admin/groups/2f6b1d2c-9a3e-4c5b-8d7e-1a2b3c4d5e6f/schedule',
    '/evil/attendance/admin/groups/x',
    '',
  ])('rejects exact/prefix/near-prefix negative: %j', (path) => {
    expect(isAttendanceGroupContextPath(path)).toBe(false)
    expect(isAttendanceFocusAllowedPath(path)).toBe(false)
  })
})

describe('guard decision behavior with the group-context prefix (ordering contract)', () => {
  const ctx = (over: Partial<RouteGuardPolicyContext> = {}): RouteGuardPolicyContext => ({
    hasFeature: () => true,
    hasPermission: () => true,
    attendanceFocused: false,
    plmWorkbenchFocused: false,
    resolveHomePath: () => '/HOME',
    ...over,
  })
  const decide = (path: string, meta: unknown, over: Partial<RouteGuardPolicyContext> = {}) =>
    resolveRouteGuardDecision({ path, meta }, ctx(over))

  const GROUP_PATH = `/attendance/admin/groups/${VALID_UUID}/schedule`

  it('allows group-context paths in attendance focus mode', () => {
    for (const step of ['schedule', 'calendar', 'rules']) {
      expect(
        decide(`/attendance/admin/groups/${VALID_UUID}/${step}`, {}, { attendanceFocused: true }),
      ).toEqual({ action: 'allow' })
    }
  })

  it('still redirects non-allowlisted paths in focus mode (exact set + bounded prefix only)', () => {
    for (const path of [
      '/attendance/admin/groups-evil/x',
      '/attendance/admin/groups',
      '/attendance/sub',
      '/multitable',
      '/settings/extra',
    ]) {
      expect(decide(path, {}, { attendanceFocused: true })).toEqual({
        action: 'redirect',
        target: '/attendance',
      })
    }
  })

  it('keeps legacy exact paths reachable in focus mode (legacy /attendance compatibility)', () => {
    for (const path of ATTENDANCE_FOCUS_ALLOWED_PATHS) {
      expect(decide(path, {}, { attendanceFocused: true })).toEqual({ action: 'allow' })
    }
    expect(decide('/attendance', {}, { attendanceFocused: false })).toEqual({ action: 'allow' })
    expect(decide(GROUP_PATH, {}, { attendanceFocused: false })).toEqual({ action: 'allow' })
  })

  it('permission denial still wins over the focus predicate — the predicate grants no permission', () => {
    expect(
      decide(GROUP_PATH, { permissions: ['attendance:admin'] }, {
        hasPermission: () => false,
        attendanceFocused: true,
      }),
    ).toEqual({ action: 'redirect', target: '/HOME' })
  })

  it('required-feature denial redirects home before the focus predicate runs', () => {
    expect(
      decide(GROUP_PATH, { requiredFeature: 'attendanceAdmin' }, {
        hasFeature: () => false,
        attendanceFocused: true,
      }),
    ).toEqual({ action: 'redirect', target: '/HOME' })
  })

  it('feature denial on a group path short-circuits before the permission probe (ordering)', () => {
    let permissionProbed = false
    expect(
      decide(GROUP_PATH, { requiredFeature: 'attendanceAdmin', permissions: ['x:y'] }, {
        hasFeature: () => false,
        hasPermission: () => {
          permissionProbed = true
          return true
        },
        attendanceFocused: true,
      }),
    ).toEqual({ action: 'redirect', target: '/HOME' })
    expect(permissionProbed, 'feature denial must short-circuit before the permission probe').toBe(false)
  })
})
