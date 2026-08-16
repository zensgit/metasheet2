/**
 * W7-2 (#4556) — §3.3 roster + fail-closed probe legs (brief matrix T-B0..T-B6).
 *
 * Authority: #4556 comments 5293034619 + 5293478713; design lock §4.2/§4.3.
 *
 * The production roster is EMPTY at this head ([OWNER-CONFIRM B-1, OPEN] — no
 * owner-authored artifact ratifies any legacy-vs-group divergence yet, and the
 * ratification's fail-close rulings 5/6/11 are recorded outcomes, never roster
 * entries). The brief's per-entry legs (T-B2/T-B3) therefore run against a
 * SYNTHETIC roster fed through the SAME exported derivation the production
 * predicate uses — the mechanism is proven load-bearing without inventing a
 * production entry, and a dedicated leg pins the production array's emptiness
 * so a silently added (unratified) entry reds this suite.
 */
import { describe, it, expect } from 'vitest'
import {
  ATTENDANCE_W4_SHADOW_DIFF_CODES_V1,
  ATTENDANCE_W4_CRITICAL_SHADOW_DIFF_CODES_V1,
} from '../../src/attendance/w4c2-shadow-expected-differences'
import {
  ATTENDANCE_W7_ROSTER_ELIGIBLE_SHADOW_DIFF_CODES_V1,
  ATTENDANCE_W7_ALWAYS_REAL_SHADOW_DIFF_CODES_V1,
  ATTENDANCE_W7_NON_DIFF_SHADOW_CODES_V1,
  ATTENDANCE_W7_EXPECTED_SHADOW_DIFFERENCES_V1,
  ATTENDANCE_W7_COMPARE_ENTRYPOINTS_V1,
  ATTENDANCE_W7_GROUP_PROJECTED_STATUSES_V1,
  assertAttendanceW7ShadowDiffCodePartitionV1,
  deriveAcceptedAttendanceW7ShadowProbesV1,
  isExpectedAttendanceW7ShadowDifferenceV1,
  AttendanceW7ShadowExpectedDifferenceError,
  type AttendanceW7ExpectedShadowDifferenceEntryV1,
  type AttendanceW7ShadowDifferenceProbeV1,
} from '../../src/attendance/w7-shadow-expected-differences'

/** A well-formed synthetic entry (NOT a production entry — see the header). */
const SYNTHETIC_PROBE: AttendanceW7ShadowDifferenceProbeV1 = Object.freeze({
  shadowDiffCode: 'status_changed',
  entrypoint: 'live',
  groupOutcome: 'completed',
  groupProjectedStatus: 'adjusted',
})
const SYNTHETIC_ENTRY: AttendanceW7ExpectedShadowDifferenceEntryV1 = Object.freeze({
  id: 'synthetic_status_changed_case',
  shadowDiffCode: 'status_changed',
  ratifiedBy: '#0000 synthetic mechanism-exercise fixture (test-only, not a ratified entry)',
  expectedProbe: SYNTHETIC_PROBE,
})
const SYNTHETIC_ROSTER = Object.freeze([SYNTHETIC_ENTRY])

function expectProbeThrow(fn: () => unknown, code: string): void {
  let thrown: unknown = null
  try {
    fn()
  } catch (error) {
    thrown = error
  }
  expect(thrown, 'expected a fail-closed throw, got a return').toBeInstanceOf(
    AttendanceW7ShadowExpectedDifferenceError,
  )
  expect((thrown as AttendanceW7ShadowExpectedDifferenceError).code).toBe(code)
}

describe('W7-2 §3.3 — roster + fail-closed probe', () => {
  // -------------------------------------------------------------------------
  // T-B0 — non-vacuity of the machinery (adapted: the PRODUCTION roster is
  // deliberately empty; the derivation's non-vacuity is proven synthetically).
  // -------------------------------------------------------------------------
  it('T-B0: the imported domain is non-empty; the derivation really iterates (synthetic anchor matched exactly once)', () => {
    expect(ATTENDANCE_W4_SHADOW_DIFF_CODES_V1.length).toBe(12)
    expect(ATTENDANCE_W7_ROSTER_ELIGIBLE_SHADOW_DIFF_CODES_V1.length).toBeGreaterThan(0)
    expect(ATTENDANCE_W7_ALWAYS_REAL_SHADOW_DIFF_CODES_V1.length).toBeGreaterThan(0)
    expect(ATTENDANCE_W7_NON_DIFF_SHADOW_CODES_V1.length).toBeGreaterThan(0)
    expect(ATTENDANCE_W7_COMPARE_ENTRYPOINTS_V1.length).toBe(2)
    expect(ATTENDANCE_W7_GROUP_PROJECTED_STATUSES_V1.length).toBe(7)
    // The derivation over a one-entry roster yields exactly one accepted probe.
    const accepted = deriveAcceptedAttendanceW7ShadowProbesV1(SYNTHETIC_ROSTER)
    expect(accepted.length).toBe(1)
    expect(accepted[0]).toEqual(SYNTHETIC_PROBE)
  })

  it('T-B0b: the PRODUCTION roster is EMPTY — B-1 is OPEN; an entry added without owner ratification reds here', () => {
    expect(ATTENDANCE_W7_EXPECTED_SHADOW_DIFFERENCES_V1.length).toBe(0)
    // With the roster empty, EVERY well-formed divergence probe is off-roster.
    expect(isExpectedAttendanceW7ShadowDifferenceV1(SYNTHETIC_PROBE)).toBe(false)
  })

  // -------------------------------------------------------------------------
  // T-B1 — domain completeness with NO default bucket.
  // -------------------------------------------------------------------------
  it('T-B1: the four buckets are pairwise disjoint and their union EQUALS the imported domain', () => {
    const buckets = [
      ATTENDANCE_W4_CRITICAL_SHADOW_DIFF_CODES_V1,
      ATTENDANCE_W7_ROSTER_ELIGIBLE_SHADOW_DIFF_CODES_V1,
      ATTENDANCE_W7_ALWAYS_REAL_SHADOW_DIFF_CODES_V1,
      ATTENDANCE_W7_NON_DIFF_SHADOW_CODES_V1,
    ]
    const union = buckets.flat()
    expect(new Set(union).size, 'pairwise disjointness').toBe(union.length)
    expect([...union].sort()).toEqual([...ATTENDANCE_W4_SHADOW_DIFF_CODES_V1].sort())
    // And the module-load assert accepts the real domain (positive control for
    // the 13th-member leg below — a partition check that throws on everything
    // would also "catch" the 13th member).
    expect(() => assertAttendanceW7ShadowDiffCodePartitionV1()).not.toThrow()
    expect(() =>
      assertAttendanceW7ShadowDiffCodePartitionV1([...ATTENDANCE_W4_SHADOW_DIFF_CODES_V1]),
    ).not.toThrow()
  })

  it('T-B1b (the 13th-member control): a new domain code belongs to NO bucket and reds by construction, without anyone updating a count', () => {
    // A LOCAL copy of the domain gains a 13th member. The partition must
    // refuse it — this is what "no default bucket" buys: an "everything else"
    // bucket would swallow the new code silently.
    const widened = [...ATTENDANCE_W4_SHADOW_DIFF_CODES_V1, 'w7_novel_code_13']
    expectProbeThrow(
      () => assertAttendanceW7ShadowDiffCodePartitionV1(widened),
      'W7_SHADOW_DIFF_CODE_PARTITION_INVALID',
    )
  })

  // -------------------------------------------------------------------------
  // T-B2 — pass side (synthetic roster through the SAME derivation).
  // -------------------------------------------------------------------------
  it('T-B2: an entry’s exact expectedProbe returns true through the production predicate', () => {
    expect(isExpectedAttendanceW7ShadowDifferenceV1({ ...SYNTHETIC_PROBE }, SYNTHETIC_ROSTER)).toBe(true)
  })

  // -------------------------------------------------------------------------
  // T-B3 — departure side, one field at a time.
  // -------------------------------------------------------------------------
  it('T-B3: every representable single-field departure returns false; pairing-breaking departures fail CLOSED (throw)', () => {
    // shadowDiffCode departure (still a valid roster-eligible code): false.
    expect(
      isExpectedAttendanceW7ShadowDifferenceV1(
        { ...SYNTHETIC_PROBE, shadowDiffCode: 'work_minutes_mismatch' },
        SYNTHETIC_ROSTER,
      ),
    ).toBe(false)
    // entrypoint departure: false.
    expect(
      isExpectedAttendanceW7ShadowDifferenceV1(
        { ...SYNTHETIC_PROBE, entrypoint: 'scheduled' },
        SYNTHETIC_ROSTER,
      ),
    ).toBe(false)
    // groupProjectedStatus departure (completed kept, status moved): false.
    expect(
      isExpectedAttendanceW7ShadowDifferenceV1(
        { ...SYNTHETIC_PROBE, groupProjectedStatus: 'late' },
        SYNTHETIC_ROSTER,
      ),
    ).toBe(false)
    // The paired outcome/status departure (both fields move together — the only
    // representable review-shaped probe): false, not expected.
    expect(
      isExpectedAttendanceW7ShadowDifferenceV1(
        { ...SYNTHETIC_PROBE, groupOutcome: 'review_required', groupProjectedStatus: null },
        SYNTHETIC_ROSTER,
      ),
    ).toBe(false)
    // A SINGLE-field flip of either paired field describes no persistable row
    // (`chk_arc_review_shape` pairing) and fails CLOSED rather than false.
    expectProbeThrow(
      () =>
        isExpectedAttendanceW7ShadowDifferenceV1(
          { ...SYNTHETIC_PROBE, groupOutcome: 'review_required' },
          SYNTHETIC_ROSTER,
        ),
      'W7_SHADOW_DIFF_PROBE_INVALID',
    )
    expectProbeThrow(
      () =>
        isExpectedAttendanceW7ShadowDifferenceV1(
          { ...SYNTHETIC_PROBE, groupProjectedStatus: null },
          SYNTHETIC_ROSTER,
        ),
      'W7_SHADOW_DIFF_PROBE_INVALID',
    )
  })

  // -------------------------------------------------------------------------
  // T-B4 — malformed fails closed: throw, never a silent false.
  // -------------------------------------------------------------------------
  it('T-B4: non-object, null, array, missing key, extra key, out-of-enum, wrong type — each throws the closed code', () => {
    const malformed: readonly unknown[] = [
      undefined,
      null,
      42,
      'status_changed',
      [],
      [SYNTHETIC_PROBE],
      {},
      // missing key
      (() => {
        const { entrypoint: _dropped, ...rest } = SYNTHETIC_PROBE
        return rest
      })(),
      // extra key
      { ...SYNTHETIC_PROBE, extra: true },
      // caller-assertable override attempt is just an extra key — fail closed
      { ...SYNTHETIC_PROBE, expected: true },
      // out-of-enum values
      { ...SYNTHETIC_PROBE, shadowDiffCode: 'not_a_code' },
      { ...SYNTHETIC_PROBE, entrypoint: 'recompute' },
      { ...SYNTHETIC_PROBE, groupOutcome: 'baseline' },
      { ...SYNTHETIC_PROBE, groupProjectedStatus: 'off' },
      // wrong types
      { ...SYNTHETIC_PROBE, shadowDiffCode: 3 },
      { ...SYNTHETIC_PROBE, groupProjectedStatus: undefined },
    ]
    for (const input of malformed) {
      expectProbeThrow(
        () => isExpectedAttendanceW7ShadowDifferenceV1(input, SYNTHETIC_ROSTER),
        'W7_SHADOW_DIFF_PROBE_INVALID',
      )
    }
  })

  // -------------------------------------------------------------------------
  // T-B5 — the roster DRIVES the predicate, both directions.
  // -------------------------------------------------------------------------
  it('T-B5: the accepted-probe set is derived from the roster — every entry accepted, nothing else accepted', () => {
    const secondEntry: AttendanceW7ExpectedShadowDifferenceEntryV1 = {
      id: 'synthetic_break_exclusion_case',
      shadowDiffCode: 'expected_break_exclusion',
      ratifiedBy: '#0000 synthetic mechanism-exercise fixture (test-only, not a ratified entry)',
      expectedProbe: {
        shadowDiffCode: 'expected_break_exclusion',
        entrypoint: 'scheduled',
        groupOutcome: 'completed',
        groupProjectedStatus: 'normal',
      },
    }
    const roster = [SYNTHETIC_ENTRY, secondEntry]
    const accepted = deriveAcceptedAttendanceW7ShadowProbesV1(roster)
    // Direction 1: the accepted set is exactly the roster's probes, in order.
    expect(accepted.length).toBe(roster.length)
    expect(accepted).toEqual(roster.map((entry) => entry.expectedProbe))
    // Direction 2: every derived probe passes the predicate…
    for (const probe of accepted) {
      expect(isExpectedAttendanceW7ShadowDifferenceV1({ ...probe }, roster)).toBe(true)
    }
    // …and a probe matching NO entry does not (nothing accepted beyond the roster).
    expect(
      isExpectedAttendanceW7ShadowDifferenceV1(
        {
          shadowDiffCode: 'late_minutes_mismatch',
          entrypoint: 'live',
          groupOutcome: 'completed',
          groupProjectedStatus: 'late',
        },
        roster,
      ),
    ).toBe(false)
  })

  // -------------------------------------------------------------------------
  // T-B6 — provenance and entry validation.
  // -------------------------------------------------------------------------
  it('T-B6: an entry with an empty, artifact-free or self-referential ratifiedBy is itself the defect (derivation throws)', () => {
    const bad = (patch: Partial<AttendanceW7ExpectedShadowDifferenceEntryV1>) =>
      deriveAcceptedAttendanceW7ShadowProbesV1([{ ...SYNTHETIC_ENTRY, ...patch }])
    expectProbeThrow(() => bad({ ratifiedBy: '' }), 'W7_SHADOW_EXPECTED_DIFFERENCE_ENTRY_INVALID')
    expectProbeThrow(() => bad({ ratifiedBy: '   ' }), 'W7_SHADOW_EXPECTED_DIFFERENCE_ENTRY_INVALID')
    expectProbeThrow(
      () => bad({ ratifiedBy: 'because the compare window showed it' }),
      'W7_SHADOW_EXPECTED_DIFFERENCE_ENTRY_INVALID',
    )
    expectProbeThrow(
      () => bad({ ratifiedBy: 'w7-shadow-expected-differences.ts #123 (self)' }),
      'W7_SHADOW_EXPECTED_DIFFERENCE_ENTRY_INVALID',
    )
  })

  it('T-B6b: a critical-code entry is rejected — the roster can never soften §4.2’s unconditional criteria', () => {
    expectProbeThrow(
      () =>
        deriveAcceptedAttendanceW7ShadowProbesV1([
          {
            id: 'illegal_critical_entry',
            shadowDiffCode: 'context_mismatch',
            ratifiedBy: '#0000 synthetic fixture',
            expectedProbe: {
              shadowDiffCode: 'context_mismatch',
              entrypoint: 'live',
              groupOutcome: 'completed',
              groupProjectedStatus: 'normal',
            },
          },
        ]),
      'W7_SHADOW_EXPECTED_DIFFERENCE_ENTRY_INVALID',
    )
  })

  it('T-B6c: entry/probe code mismatch and duplicate ids are rejected', () => {
    expectProbeThrow(
      () =>
        deriveAcceptedAttendanceW7ShadowProbesV1([
          { ...SYNTHETIC_ENTRY, shadowDiffCode: 'work_minutes_mismatch' },
        ]),
      'W7_SHADOW_EXPECTED_DIFFERENCE_ENTRY_INVALID',
    )
    expectProbeThrow(
      () => deriveAcceptedAttendanceW7ShadowProbesV1([SYNTHETIC_ENTRY, { ...SYNTHETIC_ENTRY }]),
      'W7_SHADOW_EXPECTED_DIFFERENCE_ENTRY_INVALID',
    )
  })
})
