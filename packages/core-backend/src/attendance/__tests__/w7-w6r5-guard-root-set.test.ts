/**
 * W7-0 (#4556) — W6-R5 guard ROOT SET record (W7-R10). See
 * `../w7-w6r5-guard-root-set.ts` header and
 * `docs/development/attendance-issue-4556-w7-group-policy-cutover-design-lock-20260807.md`
 * §3 row W7-R10.
 *
 * DELIBERATELY DECLARATION-ONLY: this suite asserts shape (root strings are
 * globs not files, non-empty reasons, no duplicates, exact count, the
 * `presentAtW7Zero` split) and asserts NOTHING about the real filesystem —
 * no `fs.existsSync`, no directory walk, no non-empty-domain check. Root 3
 * (`packages/core-backend/src/attendance/w7-resolver/**`) genuinely resolves
 * to zero files at the W7-0 baseline (design-lock §1.4); asserting that here
 * would either red this byte-inert PR over an expected fact or force this
 * suite to special-case it, both of which belong to W7-1's guard (the first
 * head where the non-empty-domain leg is meaningful), not to this record.
 *
 * This module is not imported by any production path (W7-R9 byte-inert).
 */
import { describe, expect, it } from 'vitest'
import {
  ATTENDANCE_W7_W6R5_GUARD_ROOTS_V1,
  type AttendanceW7GuardRootV1,
} from '../w7-w6r5-guard-root-set'

describe('W7-0 W6-R5 guard root set: declaration shape (not the walking guard)', () => {
  it('has exactly three pinned roots', () => {
    expect(ATTENDANCE_W7_W6R5_GUARD_ROOTS_V1).toHaveLength(3)
  })

  it('every root is a directory glob (ends with /**), never a single file path', () => {
    for (const entry of ATTENDANCE_W7_W6R5_GUARD_ROOTS_V1) {
      expect(entry.root.endsWith('/**')).toBe(true)
      expect(entry.root.endsWith('.ts')).toBe(false)
      expect(entry.root.endsWith('.cjs')).toBe(false)
      expect(entry.root.endsWith('.js')).toBe(false)
    }
  })

  it('every reason is a non-empty, non-trivial string (not a placeholder)', () => {
    for (const entry of ATTENDANCE_W7_W6R5_GUARD_ROOTS_V1) {
      expect(typeof entry.reason).toBe('string')
      expect(entry.reason.length).toBeGreaterThan(40)
    }
  })

  it('root strings are unique (no duplicate roots pinned twice)', () => {
    const roots = ATTENDANCE_W7_W6R5_GUARD_ROOTS_V1.map((entry) => entry.root)
    expect(new Set(roots).size).toBe(roots.length)
  })

  it('roots are exactly the two design-lock-named existing roots plus the resolver placeholder', () => {
    const roots = ATTENDANCE_W7_W6R5_GUARD_ROOTS_V1.map((entry) => entry.root)
    expect(roots).toEqual([
      'plugins/plugin-attendance/**',
      'packages/core-backend/src/attendance/**',
      'packages/core-backend/src/attendance/w7-resolver/**',
    ])
  })

  it('presentAtW7Zero is true for the two existing roots and false for the not-yet-created resolver root', () => {
    const byRoot = new Map<string, AttendanceW7GuardRootV1>(
      ATTENDANCE_W7_W6R5_GUARD_ROOTS_V1.map((entry) => [entry.root, entry]),
    )
    expect(byRoot.get('plugins/plugin-attendance/**')?.presentAtW7Zero).toBe(true)
    expect(byRoot.get('packages/core-backend/src/attendance/**')?.presentAtW7Zero).toBe(true)
    expect(byRoot.get('packages/core-backend/src/attendance/w7-resolver/**')?.presentAtW7Zero).toBe(false)
  })

  it('exactly one root is not-yet-present (the future guard is expected to see exactly one root flip false->true)', () => {
    const notYetPresent = ATTENDANCE_W7_W6R5_GUARD_ROOTS_V1.filter((entry) => !entry.presentAtW7Zero)
    expect(notYetPresent).toHaveLength(1)
    expect(notYetPresent[0]?.root).toBe('packages/core-backend/src/attendance/w7-resolver/**')
  })

  it('every entry is frozen (Object.freeze) — a mutation attempt is a no-op, not a silent record change', () => {
    for (const entry of ATTENDANCE_W7_W6R5_GUARD_ROOTS_V1) {
      expect(Object.isFrozen(entry)).toBe(true)
    }
    expect(Object.isFrozen(ATTENDANCE_W7_W6R5_GUARD_ROOTS_V1)).toBe(true)
  })
})
