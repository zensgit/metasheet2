import { describe, expect, it } from 'vitest'
import {
  ATTENDANCE_GROUP_ROUTE_STEPS,
  ATTENDANCE_GROUP_STEP_SURFACES,
} from '../../../../apps/web/src/router/attendanceGroupContextRoute'
import { SCHEDULE_ROUTE_SURFACES } from '../../src/attendance/w6-group-effective-policy-response-contract'

/**
 * W6-R8 — the W6 copy of #4711's ratified closed step/surface table must equal
 * the canonical one, mechanically.
 *
 * The canonical table lives in `apps/web` (frontend package) and the copy in
 * `packages/core-backend`; the duplication is forced by a package boundary
 * with no shared module. This is the same spelling re-declared across that
 * boundary, not a second navigation spelling. Vitest resolves the
 * cross-package relative import, so the equality can be checked without
 * inventing a shared package.
 */
describe('W6-R8 — SCHEDULE_ROUTE_SURFACES equals #4711 ATTENDANCE_GROUP_STEP_SURFACES', () => {
  /** `calendar: null` (W6) and `calendar: []` (#4711) are the same statement —
   * "no surface permitted" — encoded differently. The W6 parser honours it by
   * requiring exactly `{kind, step}` for `calendar`. Normalise, do not exempt. */
  function normalise(table: Record<string, readonly string[] | null>): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const [step, surfaces] of Object.entries(table)) out[step] = [...(surfaces ?? [])]
    return out
  }

  it('the STEP sets are equal', () => {
    expect(Object.keys(SCHEDULE_ROUTE_SURFACES).sort()).toEqual([...ATTENDANCE_GROUP_ROUTE_STEPS].sort())
  })

  it('the SURFACE lists are equal, element for element, for every step', () => {
    expect(normalise(SCHEDULE_ROUTE_SURFACES)).toEqual(normalise(ATTENDANCE_GROUP_STEP_SURFACES))
  })

  it('non-vacuity: the canonical table is actually populated (an empty import would satisfy equality trivially)', () => {
    expect(ATTENDANCE_GROUP_ROUTE_STEPS.length).toBeGreaterThan(0)
    const totalSurfaces = Object.values(ATTENDANCE_GROUP_STEP_SURFACES).reduce((n, list) => n + list.length, 0)
    expect(totalSurfaces).toBeGreaterThan(0)
  })

  it('positive control: the comparison DOES detect a difference (so equality is not being asserted against itself)', () => {
    const drifted = { ...normalise(SCHEDULE_ROUTE_SURFACES), schedule: ['shifts'] }
    expect(drifted).not.toEqual(normalise(ATTENDANCE_GROUP_STEP_SURFACES))
  })
})
