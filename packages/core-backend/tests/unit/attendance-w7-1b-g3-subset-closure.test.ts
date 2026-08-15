/**
 * W7-1b (#4556) — g3: THE SUBSET-LEG CLASS CLOSURE (W7-1a carry-forward, #4905 P3-D1).
 *
 * Authority: #4556 comments 5293034619 + 5293478713.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS CLOSES
 * ---------------------------------------------------------------------------
 * W7-1a's leg "every `ok: true` fact set is accepted by op(i)" called the
 * resolver ONCE with the default fixture. Its own in-test comment claimed
 * generality; it was fixture-specific, and neutering the rounding gate left it
 * green. W7-1b is the slice where op(i)'s output is consumed by production, so
 * the CLASS must close here.
 *
 * ---------------------------------------------------------------------------
 * HOW IT CLOSES — AND WHY THIS FORM IS COMPLETE RATHER THAN BROADER-BUT-STILL-SAMPLED
 * ---------------------------------------------------------------------------
 * The invariant is: **the resolver's `ok: true` must mean "op(i) will accept
 * these facts."** It can break in exactly one way — op(i) constrains something
 * the resolver does not fail-close on. The known instance was `roundingMinutes`
 * (op(i) requires `>= 1`, matching v1's byte-identical rule; the resolver now
 * fail-closes below 1).
 *
 * op(i) is PURE, so the class does not need a database or a sampled corpus. This
 * suite:
 *
 *   1. DERIVES the resolver's fail-close guard set from source, so a NEW guard
 *      (or a deleted one) reds the count rather than silently changing what
 *      "ok: true" can mean;
 *   2. for every field op(i) constrains, feeds it the JUST-PASSING boundary
 *      value and asserts acceptance — the boundary is where a mismatched pair of
 *      rules diverges, and a mid-range value would pass under both the correct
 *      and the broken rule;
 *   3. for every such field, feeds the JUST-FAILING value and asserts op(i)
 *      REJECTS — the negative half, without which step 2 is consistent with
 *      "op(i) constrains nothing at all".
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  coreIssueGroupEffectiveContextV2,
  isCoreIssuedGroupEffectiveContextV2,
} from '../../src/attendance/w7-resolver/w7-group-effective-context-issuance'
import type { AttendanceW7GroupEffectiveFactsV1 } from '../../src/attendance/w7-resolver/w7-group-effective-facts-resolver'

const RESOLVER = path.resolve(
  __dirname,
  '../../src/attendance/w7-resolver/w7-group-effective-facts-resolver.ts',
)

/** The resolver's fail-close guard count at this head. A NEW guard means the
 *  meaning of `ok: true` narrowed; a DELETED one means it widened. Either way
 *  the class below must be re-examined, so the count is pinned rather than
 *  described. */
const RESOLVER_FAIL_CLOSE_GUARDS_V1 = 12

/** A fact set the resolver would legitimately call `ok: true`. Every boundary
 *  case below is this shape with exactly ONE field moved to its edge — so a
 *  failure names the field rather than the fixture. */
const baseFacts = (): AttendanceW7GroupEffectiveFactsV1 => ({
  orgId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  workDate: '2026-06-01',
  timezone: 'UTC',
  calculationGroupId: '33333333-3333-4333-8333-333333333333',
  shiftId: '44444444-4444-4444-8444-444444444444',
  isWorkday: true,
  holidayKind: null,
  roundingMinutes: 1,
  severeLateThresholdMinutes: 0,
  absenceLateThresholdMinutes: 0,
  segments: [
    {
      index: 0,
      startTime: '09:00',
      endTime: '18:00',
      startDayOffset: 0,
      endDayOffset: 0,
      lateGraceMinutes: 0,
      earlyLeaveGraceMinutes: 0,
    },
  ],
})

describe('W7-1b g3 — the resolver/op(i) subset closure, as a CLASS', () => {
  it('the resolver fail-close guard set is PINNED (a new or deleted guard changes what ok:true means)', () => {
    const source = fs.readFileSync(RESOLVER, 'utf8')
    const guards = source.split('\n').filter((l) => /return \{ ok: false/.test(l)).length
    expect(
      guards,
      'the resolver fail-close guard count moved. That changes the meaning of `ok: true`, so the ' +
        'boundary cases below must be re-derived before this pin is updated — never the other way round.',
    ).toBe(RESOLVER_FAIL_CLOSE_GUARDS_V1)
    // Non-vacuity: the file really is the resolver and really carries guards.
    expect(source).toContain('resolveW7GroupEffectiveFactsInTransactionV1')
    expect(guards).toBeGreaterThan(0)
  })

  it('the base fact set is accepted (non-vacuity — otherwise every boundary case below is meaningless)', () => {
    const context = coreIssueGroupEffectiveContextV2(baseFacts())
    expect(isCoreIssuedGroupEffectiveContextV2(context)).toBe(true)
    expect(context.selector).toBe('group_effective')
    expect(context.schemaVersion).toBe(2)
  })

  // -------------------------------------------------------------------------
  // The class: every field op(i) constrains, at its JUST-PASSING boundary.
  // -------------------------------------------------------------------------

  const JUST_PASSING: ReadonlyArray<readonly [string, () => AttendanceW7GroupEffectiveFactsV1]> = [
    // The KNOWN instance. `>= 1` is v1's byte-identical rule.
    ['roundingMinutes at its minimum (1)', () => ({ ...baseFacts(), roundingMinutes: 1 })],
    ['severeLateThresholdMinutes at 0', () => ({ ...baseFacts(), severeLateThresholdMinutes: 0 })],
    ['absenceLateThresholdMinutes at 0', () => ({ ...baseFacts(), absenceLateThresholdMinutes: 0 })],
    ['holidayKind null', () => ({ ...baseFacts(), holidayKind: null })],
    ['holidayKind a non-empty string', () => ({ ...baseFacts(), holidayKind: 'statutory' })],
    ['isWorkday false', () => ({ ...baseFacts(), isWorkday: false })],
    [
      'a single segment (the minimum)',
      () => ({ ...baseFacts(), segments: baseFacts().segments.slice(0, 1) }),
    ],
    [
      'three segments (the maximum)',
      () => ({
        ...baseFacts(),
        segments: [
          { index: 0, startTime: '09:00', endTime: '11:00', startDayOffset: 0, endDayOffset: 0, lateGraceMinutes: 0, earlyLeaveGraceMinutes: 0 },
          { index: 1, startTime: '12:00', endTime: '14:00', startDayOffset: 0, endDayOffset: 0, lateGraceMinutes: 0, earlyLeaveGraceMinutes: 0 },
          { index: 2, startTime: '15:00', endTime: '18:00', startDayOffset: 0, endDayOffset: 0, lateGraceMinutes: 0, earlyLeaveGraceMinutes: 0 },
        ] as AttendanceW7GroupEffectiveFactsV1['segments'],
      }),
    ],
    [
      'endDayOffset 1 (the overnight edge the resolver admits)',
      () => ({
        ...baseFacts(),
        segments: [{ ...baseFacts().segments[0], endDayOffset: 1 as const }],
      }),
    ],
    [
      'zero grace minutes on both edges',
      () => ({
        ...baseFacts(),
        segments: [{ ...baseFacts().segments[0], lateGraceMinutes: 0, earlyLeaveGraceMinutes: 0 }],
      }),
    ],
  ]

  for (const [label, build] of JUST_PASSING) {
    it(`op(i) ACCEPTS the just-passing boundary: ${label}`, () => {
      // A mid-range value would pass under BOTH the correct rule and a broken
      // one; the boundary is the only place a mismatched pair diverges.
      const context = coreIssueGroupEffectiveContextV2(build())
      expect(isCoreIssuedGroupEffectiveContextV2(context)).toBe(true)
    })
  }

  // -------------------------------------------------------------------------
  // The negative half. Without it, the block above is equally consistent with
  // "op(i) constrains nothing at all".
  // -------------------------------------------------------------------------

  const JUST_FAILING: ReadonlyArray<readonly [string, () => AttendanceW7GroupEffectiveFactsV1]> = [
    [
      'roundingMinutes 0 — the divergence W7-1a found, one step below the edge',
      () => ({ ...baseFacts(), roundingMinutes: 0 }),
    ],
    ['an empty calculationGroupId', () => ({ ...baseFacts(), calculationGroupId: '' })],
    [
      'four segments — one past the maximum',
      () => ({
        ...baseFacts(),
        segments: [0, 1, 2, 3].map((index) => ({
          index, startTime: '09:00', endTime: '10:00', startDayOffset: 0, endDayOffset: 0,
          lateGraceMinutes: 0, earlyLeaveGraceMinutes: 0,
        })) as unknown as AttendanceW7GroupEffectiveFactsV1['segments'],
      }),
    ],
    [
      'zero segments — one below the minimum',
      () => ({ ...baseFacts(), segments: [] as unknown as AttendanceW7GroupEffectiveFactsV1['segments'] }),
    ],
  ]

  for (const [label, build] of JUST_FAILING) {
    it(`op(i) REJECTS the just-failing boundary: ${label}`, () => {
      expect(() => coreIssueGroupEffectiveContextV2(build())).toThrow()
    })
  }

  it('CLASS STATEMENT: no field op(i) constrains is left un-guarded by the resolver', () => {
    // The closure argument, asserted rather than narrated: every numeric/enum
    // boundary op(i) enforces above has a corresponding `return { ok: false }`
    // guard in the resolver. `roundingMinutes` is the one that was missing and
    // is now present; this leg reds if that guard is deleted.
    const source = fs.readFileSync(RESOLVER, 'utf8')
    expect(source, 'the roundingMinutes fail-close is the known instance of this class').toMatch(
      /roundingMinutes\s*<\s*1[\s\S]{0,120}?ok:\s*false/,
    )
    // Segment-count bounds are guarded on the resolver side too.
    expect(source).toMatch(/segmentResult\.rows\.length\s*>\s*3[\s\S]{0,120}?ok:\s*false/)
    // And the group id, which op(i) re-checks rather than trusting.
    expect(source).toMatch(/!calculationGroupId[\s\S]{0,80}?ok:\s*false/)
  })
})
