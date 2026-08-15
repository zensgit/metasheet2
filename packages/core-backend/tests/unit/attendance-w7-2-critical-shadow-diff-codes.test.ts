/**
 * W7-2 (#4556) — §3.4 of the compare rung: the exported critical-code set.
 *
 * Authority: #4556 comments 5293034619 (owner-directed disclosed relay) +
 * 5293478713 (owner first-person confirmation); design lock
 * `attendance-issue-4556-w7-group-policy-cutover-design-lock-20260807.md`
 * §4.2 (`group_eligible` entry: "zero critical diffs
 * (work-date/context/input/review classes)").
 *
 * The set was previously a module-private duplicate inside
 * `AttendanceW4CalculationDetail.ts`. These legs pin: (1) the exported set is a
 * subset of the 12-code domain; (2) its members are EXACTLY the four classes
 * §4.2 names; (3) the W4 backlog reader's `critical` derivation really
 * CONSUMES the exported symbol (behavioral, via a stubbed query — not a
 * source-text grep, which a re-duplication would satisfy).
 */
import { describe, it, expect } from 'vitest'
import {
  ATTENDANCE_W4_SHADOW_DIFF_CODES_V1,
  ATTENDANCE_W4_CRITICAL_SHADOW_DIFF_CODES_V1,
} from '../../src/attendance/w4c2-shadow-expected-differences'
import { readAttendanceW4ShadowBacklog } from '../../src/services/AttendanceW4CalculationDetail'

describe('W7-2 §3.4 — ATTENDANCE_W4_CRITICAL_SHADOW_DIFF_CODES_V1', () => {
  it('non-vacuity: the domain and the critical set are both non-empty and frozen', () => {
    expect(ATTENDANCE_W4_SHADOW_DIFF_CODES_V1.length).toBe(12)
    expect(ATTENDANCE_W4_CRITICAL_SHADOW_DIFF_CODES_V1.length).toBe(4)
    expect(Object.isFrozen(ATTENDANCE_W4_CRITICAL_SHADOW_DIFF_CODES_V1)).toBe(true)
  })

  it('the critical set is a strict subset of the imported 12-code domain', () => {
    for (const code of ATTENDANCE_W4_CRITICAL_SHADOW_DIFF_CODES_V1) {
      expect(ATTENDANCE_W4_SHADOW_DIFF_CODES_V1).toContain(code)
    }
    expect(ATTENDANCE_W4_CRITICAL_SHADOW_DIFF_CODES_V1.length).toBeLessThan(
      ATTENDANCE_W4_SHADOW_DIFF_CODES_V1.length,
    )
  })

  it('its members are exactly the four classes design-lock §4.2 names, no duplicates', () => {
    // Positive exact-set equality (order-insensitive), never a notEqual family.
    expect([...ATTENDANCE_W4_CRITICAL_SHADOW_DIFF_CODES_V1].sort()).toEqual(
      ['context_mismatch', 'input_mismatch', 'review_required', 'work_date_mismatch'].sort(),
    )
    expect(new Set(ATTENDANCE_W4_CRITICAL_SHADOW_DIFF_CODES_V1).size).toBe(
      ATTENDANCE_W4_CRITICAL_SHADOW_DIFF_CODES_V1.length,
    )
  })

  it('readAttendanceW4ShadowBacklog derives `critical` from the exported set for EVERY code (behavioral coupling, both polarities)', async () => {
    // One stubbed backlog row per non-`equal` domain code (the reader's own SQL
    // filters `shadow_diff_code <> 'equal'`, so `equal` never reaches the
    // classification and is exercised via the query-shape assertion below).
    const codes = ATTENDANCE_W4_SHADOW_DIFF_CODES_V1.filter((code) => code !== 'equal')
    const rows = codes.map((code) => ({ entrypoint: 'live', shadow_diff_code: code, item_count: 1 }))
    let sawShadowFilter = false
    const runQuery = (async (sql: string) => {
      // Anchor-hit: the reader must really be querying the shadow partition.
      if (sql.includes("mode = 'shadow'") && sql.includes("shadow_diff_code <> 'equal'")) {
        sawShadowFilter = true
      }
      return { rows } as never
    }) as never
    const backlog = await readAttendanceW4ShadowBacklog('org-w7-2-crit', 50, runQuery)
    expect(sawShadowFilter, 'the backlog reader did not issue the shadow-partition query').toBe(true)
    expect(backlog.length).toBe(codes.length)
    for (const item of backlog) {
      // BOTH polarities per row: critical exactly when the exported set says so.
      expect(
        item.critical,
        `${item.code}: critical flag must equal exported-set membership`,
      ).toBe(ATTENDANCE_W4_CRITICAL_SHADOW_DIFF_CODES_V1.includes(item.code))
    }
    // Positive controls in both directions: at least one true and one false
    // classification really occurred (a constant-true or constant-false
    // derivation cannot pass this pair).
    expect(backlog.some((item) => item.critical === true)).toBe(true)
    expect(backlog.some((item) => item.critical === false)).toBe(true)
  })
})
