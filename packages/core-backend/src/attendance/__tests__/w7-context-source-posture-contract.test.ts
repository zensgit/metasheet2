/**
 * W7-0 (#4556) — context-source posture contract: legal-transition matrix
 * and the two-part posture-read function. See
 * `../w7-context-source-posture-contract.ts` header and
 * `docs/development/attendance-issue-4556-w7-group-policy-cutover-design-lock-20260807.md`
 * §4.2, §7 OD-W7-3.
 *
 * This module is not imported by any production path (W7-R9 byte-inert).
 * Deleting both files leaves every other suite green.
 */
import { describe, expect, it } from 'vitest'
import {
  ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_LEGAL_TRANSITIONS_V1,
  ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1,
  isAttendanceW7ContextSourcePostureLegalTransitionV1,
  resolveAttendanceW7ContextSourcePostureFromPartsV1,
  type AttendanceW7ContextSourcePostureStateV1,
} from '../w7-context-source-posture-contract'

describe('W7-0 context-source posture: state set + legal-transition matrix', () => {
  it('states are exactly the five OD-W7-3(a) values, in order', () => {
    expect(ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1).toEqual([
      'off',
      'group_shadow',
      'group_eligible',
      'group_authoritative',
      'suspended',
    ])
  })

  it('legal transitions are exactly the seven pairs the design-lock text fixes', () => {
    expect(ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_LEGAL_TRANSITIONS_V1).toEqual([
      ['off', 'group_shadow'],
      ['group_shadow', 'off'],
      ['group_shadow', 'group_eligible'],
      ['group_eligible', 'group_shadow'],
      ['group_eligible', 'group_authoritative'],
      ['group_authoritative', 'suspended'],
      ['suspended', 'group_authoritative'],
    ])
  })

  it('every pair over the full 5x5 state space is legal iff it is one of the seven pinned pairs', () => {
    const states = ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1
    const legalSet = new Set(
      ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_LEGAL_TRANSITIONS_V1.map(([a, b]) => `${a}->${b}`),
    )
    let legalCount = 0
    let illegalCount = 0
    for (const from of states) {
      for (const to of states) {
        const expectedLegal = legalSet.has(`${from}->${to}`)
        expect(isAttendanceW7ContextSourcePostureLegalTransitionV1(from, to)).toBe(expectedLegal)
        if (expectedLegal) legalCount += 1
        else illegalCount += 1
      }
    }
    // 5x5 = 25 pairs total; exactly 7 legal (matching the pinned list), 18 illegal
    // (including all 5 self-pairs, which are never legal).
    expect(legalCount).toBe(7)
    expect(illegalCount).toBe(18)
  })

  it('no self-transition is legal (off->off etc. all rejected)', () => {
    for (const state of ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1) {
      expect(isAttendanceW7ContextSourcePostureLegalTransitionV1(state, state)).toBe(false)
    }
  })
})

describe('W7-0 context-source posture: two-part posture-read contract', () => {
  it('no persisted row -> off, regardless of capability/allowlist', () => {
    expect(
      resolveAttendanceW7ContextSourcePostureFromPartsV1({
        persistedRow: null,
        implementationCapability: true,
        orgExactlyAllowlisted: true,
      }),
    ).toBe('off')
  })

  it('persisted suspended -> ALWAYS suspended, even with capability+allowlist both false', () => {
    expect(
      resolveAttendanceW7ContextSourcePostureFromPartsV1({
        persistedRow: { state: 'suspended', scope: 'synthetic_staging' },
        implementationCapability: false,
        orgExactlyAllowlisted: false,
      }),
    ).toBe('suspended')
  })

  it('persisted suspended -> still suspended even with capability+allowlist both true (cannot be evaded upward either)', () => {
    expect(
      resolveAttendanceW7ContextSourcePostureFromPartsV1({
        persistedRow: { state: 'suspended', scope: 'synthetic_staging' },
        implementationCapability: true,
        orgExactlyAllowlisted: true,
      }),
    ).toBe('suspended')
  })

  it('row alone (capability false) is insufficient for a non-suspended state -> off', () => {
    expect(
      resolveAttendanceW7ContextSourcePostureFromPartsV1({
        persistedRow: { state: 'group_shadow', scope: 'synthetic_staging' },
        implementationCapability: false,
        orgExactlyAllowlisted: true,
      }),
    ).toBe('off')
  })

  it('row + capability without exact allowlist is insufficient -> off (this is the two-part condition)', () => {
    expect(
      resolveAttendanceW7ContextSourcePostureFromPartsV1({
        persistedRow: { state: 'group_shadow', scope: 'synthetic_staging' },
        implementationCapability: true,
        orgExactlyAllowlisted: false,
      }),
    ).toBe('off')
  })

  it.each<AttendanceW7ContextSourcePostureStateV1>(['group_shadow', 'group_eligible', 'group_authoritative'])(
    'row + capability + exact allowlist all true -> advertises the persisted state (%s)',
    (state) => {
      expect(
        resolveAttendanceW7ContextSourcePostureFromPartsV1({
          persistedRow: { state, scope: 'synthetic_staging' },
          implementationCapability: true,
          orgExactlyAllowlisted: true,
        }),
      ).toBe(state)
    },
  )

  it('positive control: the exact same probe (row present) DOES flip sourcing once capability+allowlist are both true (proves the two-part gate is live, not a no-op)', () => {
    const base = { persistedRow: { state: 'group_eligible' as const, scope: 'synthetic_staging' as const } }
    const gated = resolveAttendanceW7ContextSourcePostureFromPartsV1({
      ...base,
      implementationCapability: false,
      orgExactlyAllowlisted: false,
    })
    const flipped = resolveAttendanceW7ContextSourcePostureFromPartsV1({
      ...base,
      implementationCapability: true,
      orgExactlyAllowlisted: true,
    })
    expect(gated).toBe('off')
    expect(flipped).toBe('group_eligible')
    expect(flipped).not.toBe(gated)
  })
})
