/**
 * W4C-1/W4C-2 (#4556, #4612) — GOLDEN regression gate for the fingerprint
 * DEFINITION itself: fixed input → fixed 64-hex literal.
 *
 * Why this file exists (gap both the external review and our own M2a probe
 * converged on): none of the 16 assertion terminators in
 * `w4c1-fingerprint-gates.test.ts` pins a fixed output value (8 are
 * relational between live computations, 5 are HEX64 shape checks, 2
 * nullability, 1 throw — inventory in PR #4612 body), so a change to a
 * domain-separator constant or to the canonical JSON serialization moves
 * the implementation and the tests TOGETHER — mutating
 * `SOURCE_DEFINITION_DOMAIN` to `…:vMUTANT` left that whole file green
 * (9 passed). The hard-coded literals below are constants and therefore
 * cannot move with the implementation.
 *
 * What the frozen literals pin (verified by mutation, red/green, in the PR
 * body of #4612):
 *   - both domain-separator strings (`SOURCE_DEFINITION_DOMAIN` and
 *     `OUTER_COMPARABLE_SOURCE_DEFINITION_DOMAIN`) and the NUL-byte
 *     domain/payload framing;
 *   - the canonical JSON serialization (`canonicalAttendanceJsonV1` key
 *     sort order and value encoding);
 *   - the FROZEN exclusion sets: storage projects out {resolvedAt}, the
 *     outer-comparable domain {resolvedAt, reasonCode}. Scope of the pin:
 *     removing either current member flips a literal, and so does adding
 *     any key that APPEARS in the golden input (all current exclusion-set
 *     members plus seven other representative keys do) — excluding a key
 *     absent from the input is a no-op on these hashes and is not
 *     witnessed here.
 *
 * DO NOT regenerate these literals to make a red run green: a red here means
 * the fingerprint definition changed, which invalidates every stored
 * `attendance_record_calculations.source_definition_fingerprint` value and
 * every outer-vs-inner equality comparison. That requires a NEW fingerprint
 * version (v2 constants + migration posture decided by the owner), not a
 * literal refresh.
 *
 * The expected values were computed ONCE from the v1 implementation at
 * #4612 head f0fe4a4a6 and are intentionally hard-coded — the test must
 * never derive them from the function under test.
 */
import { describe, expect, it } from 'vitest'
import { canonicalAttendanceJsonV1 } from '../w4c0-fingerprints'
import {
  computeAttendanceOuterComparableSourceDefinitionFingerprintV1,
  computeAttendanceSourceDefinitionFingerprintV1,
} from '../w4c1-fingerprints'

// Frozen golden input. Object keys are DELIBERATELY inserted out of
// alphabetical order (workDate before schemaVersion, timezone first, ...)
// so the literals also witness that canonicalisation sorts keys: a
// serializer mutation that respects insertion order instead of sorted
// order changes both hashes.
function goldenInput(valueOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attribution: {
      posture: 'resolved_v2',
      value: {
        workDate: '2026-07-01',
        schemaVersion: 2,
        resolverVersion: 'w2-resolver@3',
        userId: 'user-golden-1',
        orgId: 'org-golden-1',
        shiftId: 'shift-golden-1',
        reasonCode: 'PREVIOUS_NIGHT_CONTAINING_SHIFT',
        resolvedAt: '2026-07-01T01:23:45.678Z',
        attributionWindow: { startAt: '2026-06-30T18:00:00Z', endAt: '2026-07-01T21:00:00Z' },
        ...valueOverrides,
      },
    },
    context: {
      timezone: 'Asia/Shanghai',
      schemaVersion: 1,
      selector: 'legacy',
      orgId: 'org-golden-1',
      userId: 'user-golden-1',
      workDate: '2026-07-01',
      shiftId: 'shift-golden-1',
      isWorkday: true,
      holidayKind: null,
      calculationGroupId: null,
      roundingMinutes: 15,
      severeLateThresholdMinutes: 45,
      absenceLateThresholdMinutes: 90,
      segments: [
        {
          startTime: '09:00',
          index: 0,
          endTime: '18:00',
          startDayOffset: 0,
          endDayOffset: 0,
          lateGraceMinutes: 5,
          earlyLeaveGraceMinutes: 5,
        },
      ],
    },
  }
}

// Frozen literals — see file header before ever editing these.
const GOLDEN_STORAGE_FINGERPRINT = 'c9cc6690367944c2c6678d964e29dcee2083c18b737fb93175c24ca0b4d75073'
const GOLDEN_OUTER_COMPARABLE_FINGERPRINT = 'fb4a6b6854af57b46e8639d22dfef503f0775e9f3c5d4ea27cc153b1551ea665'
const GOLDEN_STORAGE_FINGERPRINT_REASON_SWAP = 'ba4597e31974eecc11a8de27a084e2ec10f5ced2e95664d685e57878f07d67ee'
const GOLDEN_CANONICAL_JSON = '{"a":[true,null,"x"],"b":1,"c":{"y":-2.5,"z":"zz"}}'

describe('W4C-1 fingerprint golden regression gate (fixed input → fixed hash)', () => {
  it('storage domain: fixed input hashes to the frozen literal', () => {
    expect(computeAttendanceSourceDefinitionFingerprintV1(goldenInput())).toBe(GOLDEN_STORAGE_FINGERPRINT)
  })

  it('outer-comparable domain: same fixed input hashes to its own distinct frozen literal', () => {
    expect(computeAttendanceOuterComparableSourceDefinitionFingerprintV1(goldenInput())).toBe(
      GOLDEN_OUTER_COMPARABLE_FINGERPRINT,
    )
    // Domain separation witnessed on literals (not on live computations):
    expect(GOLDEN_OUTER_COMPARABLE_FINGERPRINT).not.toBe(GOLDEN_STORAGE_FINGERPRINT)
  })

  it('canonical JSON serialization: fixed value serialises to the frozen string (sorted keys, exact encoding)', () => {
    expect(canonicalAttendanceJsonV1({ b: 1, a: [true, null, 'x'], c: { z: 'zz', y: -2.5 } })).toBe(
      GOLDEN_CANONICAL_JSON,
    )
  })

  it('frozen exclusion sets, pinned against the literals: storage excludes resolvedAt yet still includes reasonCode; outer excludes both', () => {
    // resolvedAt is excluded from BOTH domains: swapping it must reproduce
    // the same frozen literals.
    const resolvedAtSwap = goldenInput({ resolvedAt: '2026-07-02T09:00:00.000Z' })
    expect(computeAttendanceSourceDefinitionFingerprintV1(resolvedAtSwap)).toBe(GOLDEN_STORAGE_FINGERPRINT)
    expect(computeAttendanceOuterComparableSourceDefinitionFingerprintV1(resolvedAtSwap)).toBe(
      GOLDEN_OUTER_COMPARABLE_FINGERPRINT,
    )
    // reasonCode is excluded ONLY from the outer-comparable domain: swapping
    // it keeps the outer literal but moves the storage hash to a second,
    // also-frozen literal (so silently ADDING reasonCode to the storage
    // exclusion set flips this leg red).
    const reasonSwap = goldenInput({ reasonCode: 'OPEN_PREVIOUS_NIGHT_RECORD' })
    expect(computeAttendanceOuterComparableSourceDefinitionFingerprintV1(reasonSwap)).toBe(
      GOLDEN_OUTER_COMPARABLE_FINGERPRINT,
    )
    expect(computeAttendanceSourceDefinitionFingerprintV1(reasonSwap)).toBe(GOLDEN_STORAGE_FINGERPRINT_REASON_SWAP)
  })
})
