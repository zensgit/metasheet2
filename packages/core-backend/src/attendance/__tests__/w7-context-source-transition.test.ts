/**
 * W7-3 (#4556) — pure-side gate for the context-source transition boundary.
 *
 * Everything here is provable WITHOUT a database. The real-PG legs (the 25-pair
 * trigger sweep, the writer end-to-end, the plan reporter's zero-write proof,
 * the two-connection contention proof, migration replay) live in
 * `tests/integration/attendance-w7-3-context-source-transition.db.test.ts`.
 *
 * Discipline for every leg: assert POSITIVE equalities (a `notEqual` cannot
 * distinguish "correct" from "failed for another reason"); give every
 * "asserts nothing happened" leg a named positive control; mutate a
 * conjunction one conjunct at a time and a disjunction one disjunct at a time.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_LEGAL_TRANSITIONS_V1,
  ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1,
  isAttendanceW7ContextSourcePostureLegalTransitionV1,
  type AttendanceW7ContextSourcePostureStateV1,
} from '../w7-context-source-posture-contract'
import {
  ATTENDANCE_W7_COMPARE_PREDICATE_CODES_V1,
  readAttendanceW7CompareWindowStatusV1,
} from '../w7-compare-window-status'
import {
  ATTENDANCE_W7_BLOCKED_ARM_STATES_V1,
  ATTENDANCE_W7_GROUP_ARM_STATES_V1,
  ATTENDANCE_W7_SHADOW_COMPARE_STATES_V1,
} from '../w7-resolver/w7-frozen-context-issuance-seam'
import {
  ATTENDANCE_W7_CONTEXT_SOURCE_COMPARE_EVIDENCE_PROBES_V1,
  ATTENDANCE_W7_CONTEXT_SOURCE_DELIVERY_DECLARATIONS_V1,
  ATTENDANCE_W7_CONTEXT_SOURCE_GROUP_PRODUCER_STATES_V1,
  attendanceW7ContextSourceUndeliveredCompareEvidenceCountV1,
  attendanceW7ContextSourceUndeliveredStateProducerCountV1,
  isAttendanceW7ContextSourceCompareEvidenceDeliveredV1,
  isAttendanceW7ContextSourceStateProducerDeliveredV1,
  __setAttendanceW7ContextSourceCompareEvidenceDeliveryOverrideForTests,
  __setAttendanceW7ContextSourceStateProducerDeliveryOverrideForTests,
} from '../w7-context-source-delivery'
import {
  ATTENDANCE_W7_CONTEXT_SOURCE_TRANSITION_INPUT_KEYS_V1,
  ATTENDANCE_W7_CONTEXT_SOURCE_TRANSITION_PREDICATE_CODES_V1,
  ATTENDANCE_W7_CONTEXT_SOURCE_TRANSITION_REFUSAL_CODES_V1,
  ATTENDANCE_W7_CONTEXT_SOURCE_TRANSITION_ROWS_V1,
  attendanceW7ContextSourceApplicablePredicatesV1,
  attendanceW7ContextSourceOneStepTargetsV1,
  buildAttendanceW7ContextSourceAdvisoryKeyV1,
  findAttendanceW7ContextSourceTransitionRowV1,
  transitionAttendanceW7ContextSourceV1,
  type AttendanceW7ContextSourceTransitionInputV1,
} from '../w7-context-source-transition'
import {
  buildAttendanceCalculationRolloutAdvisoryKey,
  parseCanonicalAttendanceRolloutOrgKeyV1,
  type AttendanceW4TransactionClientV1,
} from '../w4c0-identity'
import { ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV } from '../w7-resolver/w7-context-source-posture-resolver'

const REPO_ROOT = path.resolve(__dirname, '../../../../../')

const ORG_A = '3f9a1c2e-0000-4000-8000-000000000001'
const ORG_B = '3f9a1c2e-0000-4000-8000-000000000002'
const CORRELATION = '3f9a1c2e-0000-4000-8000-0000000000aa'
const MANIFEST = 'a'.repeat(64)

const BASE_REFS = Object.freeze({
  imageSha: 'sha256:aaaa',
  ownerAuthorizationRef: 'owner-ref-1',
  syntheticOrgRef: 'synthetic-org-1',
})

const RESUME_REFS = Object.freeze({
  ...BASE_REFS,
  ownerIncidentReviewRef: 'incident-1',
  offlineReplayArtifactRef: 'replay-1',
})

function pairKey(from: string, to: string): string {
  return `${from}->${to}`
}

function codeOf(error: unknown): string {
  return (error as { code?: string }).code ?? `<no code: ${String(error)}>`
}

/**
 * A connection whose `query` THROWS on its very first call, and counts calls.
 * Any leg using it proves a refusal happened with ZERO database access — not
 * merely that the refusal happened before a write.
 */
function explodingConnection(): AttendanceW4TransactionClientV1 & { calls: number } {
  const connection = {
    calls: 0,
    query: async () => {
      connection.calls += 1
      throw new Error('THE CONNECTION MUST NOT BE TOUCHED')
    },
  }
  return connection as AttendanceW4TransactionClientV1 & { calls: number }
}

function baseInput(
  overrides: Partial<AttendanceW7ContextSourceTransitionInputV1> = {},
): AttendanceW7ContextSourceTransitionInputV1 {
  return {
    orgId: ORG_A,
    actorId: 'operator-1',
    correlationId: CORRELATION,
    engineVersion: 'w7-engine-1',
    targetState: 'group_shadow',
    expectedState: 'off',
    expectedVersion: 1,
    evidenceManifestSha256: MANIFEST,
    evidenceReferences: BASE_REFS,
    reasonCode: 'context_source_transition',
    ...overrides,
  } as AttendanceW7ContextSourceTransitionInputV1
}

async function refusalCodeFor(
  input: AttendanceW7ContextSourceTransitionInputV1,
): Promise<{ code: string; calls: number }> {
  const connection = explodingConnection()
  try {
    await transitionAttendanceW7ContextSourceV1(connection, input)
    return { code: '<no throw>', calls: connection.calls }
  } catch (error) {
    return { code: codeOf(error), calls: connection.calls }
  }
}

// ---------------------------------------------------------------------------

describe('W7-3 matrix closure: one source, no second hand-maintained copy', () => {
  it('NON-VACUITY: the ratified constant is non-empty and every state is a distinct string', () => {
    // Without this, every sweep below could iterate an empty list and pass.
    expect(ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_LEGAL_TRANSITIONS_V1.length).toBe(7)
    expect(ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1.length).toBe(5)
    expect(new Set(ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1).size).toBe(5)
  })

  it('T-M6 side-table completeness, BOTH directions', () => {
    // The side table is hand-written precisely so this leg has teeth: a table
    // derived by mapping over the constant would equal it trivially.
    const fromConstant = ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_LEGAL_TRANSITIONS_V1.map(([f, t]) =>
      pairKey(f, t),
    ).sort()
    const fromSideTable = ATTENDANCE_W7_CONTEXT_SOURCE_TRANSITION_ROWS_V1.map((row) =>
      pairKey(row.from, row.to),
    ).sort()

    // Direction 1: a pair in the constant with no row reds.
    expect(fromSideTable).toEqual(fromConstant)
    // Direction 2: a row with no pair in the constant reds. (Same equality
    // asserted from the other side deliberately: an accidental change to one
    // sort or one map would otherwise be invisible.)
    expect(fromConstant).toEqual(fromSideTable)
    // No duplicate rows hiding a missing one behind an equal length.
    expect(new Set(fromSideTable).size).toBe(fromSideTable.length)
  })

  it('every side-table row carries a ladder role from the closed union', () => {
    const roles = new Set(['advance', 'rollback', 'suspend', 'resume'])
    for (const row of ATTENDANCE_W7_CONTEXT_SOURCE_TRANSITION_ROWS_V1) {
      expect(roles.has(row.ladderRole), `${pairKey(row.from, row.to)}`).toBe(true)
    }
    // The two exit roles exist exactly once each — the shape OD-W7-4(a) names.
    const byRole = ATTENDANCE_W7_CONTEXT_SOURCE_TRANSITION_ROWS_V1.map((r) => r.ladderRole)
    expect(byRole.filter((r) => r === 'suspend').length).toBe(1)
    expect(byRole.filter((r) => r === 'resume').length).toBe(1)
  })

  it('the row finder and the ratified predicate agree on ALL 25 ordered pairs', () => {
    // This is the in-process half of the trigger sweep: the boundary's own
    // lookup must never accept a pair the ratified predicate rejects.
    let checked = 0
    for (const from of ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1) {
      for (const to of ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1) {
        checked += 1
        expect(
          findAttendanceW7ContextSourceTransitionRowV1(from, to) !== undefined,
          pairKey(from, to),
        ).toBe(isAttendanceW7ContextSourcePostureLegalTransitionV1(from, to))
      }
    }
    expect(checked, 'the 25-pair sweep did not really run 25 pairs').toBe(25)
  })

  it('T-M5 GRAPH PROPERTY (OD-W7-4(a)): the asymmetry, computed — never a re-spelled list', () => {
    // Adding `['group_authoritative','off']` to the constant reds this WITHOUT
    // anyone remembering to update a count.
    expect(attendanceW7ContextSourceOneStepTargetsV1('group_authoritative')).toEqual(['suspended'])
    expect(attendanceW7ContextSourceOneStepTargetsV1('suspended')).toEqual(['group_authoritative'])

    // POSITIVE CONTROL on the computation itself: a state that DOES have two
    // one-step targets reports both, so the function is not simply returning
    // singletons.
    expect(attendanceW7ContextSourceOneStepTargetsV1('group_shadow')).toEqual([
      'group_eligible',
      'off',
    ])
  })

  it('no edge enters `off` from the authoritative arm — the OD-W7-4(a) closure, stated as an edge ban', () => {
    const intoOff = ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_LEGAL_TRANSITIONS_V1.filter(
      ([, to]) => to === 'off',
    ).map(([from]) => from)
    expect(intoOff).toEqual(['group_shadow'])
  })
})

describe('W7-3 advisory keyspace: the W7 key is NOT the W4 rollout key', () => {
  it('the same org yields two different advisory keys for the two machines', () => {
    for (const org of [ORG_A, ORG_B]) {
      const canonical = parseCanonicalAttendanceRolloutOrgKeyV1(org)
      const w7 = buildAttendanceW7ContextSourceAdvisoryKeyV1(canonical)
      const w4 = buildAttendanceCalculationRolloutAdvisoryKey(canonical)
      expect(typeof w7).toBe('bigint')
      expect(w7).not.toBe(w4)
    }
  })

  it('the key is deterministic, org-scoped, and inside the class-`00` range', () => {
    const first = buildAttendanceW7ContextSourceAdvisoryKeyV1(ORG_A)
    expect(buildAttendanceW7ContextSourceAdvisoryKeyV1(ORG_A)).toBe(first)
    expect(buildAttendanceW7ContextSourceAdvisoryKeyV1(ORG_B)).not.toBe(first)
    // Top two bits cleared, matching the W4 rollout key's class.
    expect(first >= 0n && first < 2n ** 62n).toBe(true)
  })

  it('the key derivation canonicalizes: an upper-cased org yields the SAME key', () => {
    expect(buildAttendanceW7ContextSourceAdvisoryKeyV1(ORG_A.toUpperCase())).toBe(
      buildAttendanceW7ContextSourceAdvisoryKeyV1(ORG_A),
    )
  })
})

describe('W7-3 phase 0: illegal input is refused with ZERO database access', () => {
  it('T-W1 an illegal pair refuses before the connection is touched even once', async () => {
    const { code, calls } = await refusalCodeFor(
      baseInput({ expectedState: 'group_authoritative', targetState: 'off' }),
    )
    expect(code).toBe('W7_CONTEXT_SOURCE_TRANSITION_ILLEGAL_TRANSITION')
    expect(calls, 'the matrix check ran AFTER touching the connection').toBe(0)
  })

  it('POSITIVE CONTROL: a LEGAL pair does reach the connection (so the leg above is not vacuous)', async () => {
    const { calls } = await refusalCodeFor(baseInput())
    expect(calls, 'a legal pair never reached the connection — the probe is dead').toBeGreaterThan(0)
  })

  it('every illegal ordered pair refuses with the illegal-transition code, zero DB access', async () => {
    let illegalChecked = 0
    for (const from of ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1) {
      for (const to of ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1) {
        if (isAttendanceW7ContextSourcePostureLegalTransitionV1(from, to)) continue
        illegalChecked += 1
        const refs = from === 'suspended' && to === 'group_authoritative' ? RESUME_REFS : BASE_REFS
        const { code, calls } = await refusalCodeFor(
          baseInput({ expectedState: from, targetState: to, evidenceReferences: refs }),
        )
        expect(code, pairKey(from, to)).toBe('W7_CONTEXT_SOURCE_TRANSITION_ILLEGAL_TRANSITION')
        expect(calls, pairKey(from, to)).toBe(0)
      }
    }
    // 25 ordered pairs minus the 7 legal ones.
    expect(illegalChecked).toBe(18)
  })

  it('T-P5 NO caller-supplied readiness: the input key set is exact and carries no such flag', async () => {
    expect([...ATTENDANCE_W7_CONTEXT_SOURCE_TRANSITION_INPUT_KEYS_V1].sort()).toEqual(
      [
        'actorId',
        'correlationId',
        'engineVersion',
        'evidenceManifestSha256',
        'evidenceReferences',
        'expectedState',
        'expectedVersion',
        'orgId',
        'reasonCode',
        'targetState',
      ].sort(),
    )
    // Enumerable absence, asserted rather than assumed.
    for (const banned of ['ready', 'force', 'skipPredicates', 'override']) {
      expect(ATTENDANCE_W7_CONTEXT_SOURCE_TRANSITION_INPUT_KEYS_V1).not.toContain(banned)
    }
    // ...and a probe adding one is REJECTED by exact-key validation, not ignored.
    const withReady = { ...baseInput(), ready: true } as unknown as AttendanceW7ContextSourceTransitionInputV1
    const { code, calls } = await refusalCodeFor(withReady)
    expect(code).toBe('W7_CONTEXT_SOURCE_TRANSITION_INPUT_INVALID')
    expect(calls).toBe(0)
  })

  it('a MISSING key is rejected too — the count check alone would not catch a swap', async () => {
    const missing = { ...baseInput() } as Record<string, unknown>
    delete missing.engineVersion
    missing.somethingElse = 'x' // same key COUNT, different key set
    const { code } = await refusalCodeFor(missing as AttendanceW7ContextSourceTransitionInputV1)
    expect(code).toBe('W7_CONTEXT_SOURCE_TRANSITION_INPUT_INVALID')
  })

  it('a foreign-prototype input object is rejected', async () => {
    const exotic = Object.assign(Object.create({ inherited: 1 }), baseInput())
    const { code } = await refusalCodeFor(exotic as AttendanceW7ContextSourceTransitionInputV1)
    expect(code).toBe('W7_CONTEXT_SOURCE_TRANSITION_INPUT_INVALID')
  })

  it('the reasonCode literal is enforced', async () => {
    const { code } = await refusalCodeFor(
      baseInput({ reasonCode: 'rollout_transition' as never }),
    )
    expect(code).toBe('W7_CONTEXT_SOURCE_TRANSITION_INPUT_INVALID')
  })

  it('expectedVersion must be a safe integer >= 1 — each rejection asserted individually', async () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, '1' as never]) {
      const { code } = await refusalCodeFor(baseInput({ expectedVersion: bad as number }))
      expect(code, `expectedVersion=${String(bad)}`).toBe(
        'W7_CONTEXT_SOURCE_TRANSITION_EXPECTED_VERSION_INVALID',
      )
    }
  })

  it('an out-of-union state is rejected before the matrix, with its own code', async () => {
    expect((await refusalCodeFor(baseInput({ targetState: 'shadow' as never }))).code).toBe(
      'W7_CONTEXT_SOURCE_TRANSITION_INPUT_INVALID',
    )
    expect((await refusalCodeFor(baseInput({ expectedState: 'legacy' as never }))).code).toBe(
      'W7_CONTEXT_SOURCE_TRANSITION_EXPECTED_STATE_INVALID',
    )
  })
})

describe('W7-3 evidence manifest: nine hardening steps, each independently red-able', () => {
  const CODE = 'W7_CONTEXT_SOURCE_TRANSITION_EVIDENCE_REFERENCE_INVALID'

  it('POSITIVE CONTROL: the exact base key set passes the reference validator', async () => {
    // It gets past validation and dies on the connection instead — which is
    // what proves the eight refusals below are about the references and not
    // about something else in the input.
    const { calls } = await refusalCodeFor(baseInput({ evidenceReferences: BASE_REFS }))
    expect(calls).toBeGreaterThan(0)
  })

  it('1. an ARRAY is rejected', async () => {
    expect((await refusalCodeFor(baseInput({ evidenceReferences: [] as never }))).code).toBe(CODE)
  })

  it('1b. null is rejected', async () => {
    expect((await refusalCodeFor(baseInput({ evidenceReferences: null as never }))).code).toBe(CODE)
  })

  it('2. a FOREIGN PROTOTYPE is rejected', async () => {
    const foreign = Object.assign(Object.create({ imageSha: 'inherited' }), BASE_REFS)
    expect((await refusalCodeFor(baseInput({ evidenceReferences: foreign }))).code).toBe(CODE)
  })

  it('2b. a NULL-prototype object is ACCEPTED (the check is "not exotic", not "must be Object.prototype")', async () => {
    const nullProto = Object.assign(Object.create(null), BASE_REFS)
    const { calls } = await refusalCodeFor(baseInput({ evidenceReferences: nullProto }))
    expect(calls, 'a null-prototype reference set was wrongly refused').toBeGreaterThan(0)
  })

  it('3. a SYMBOL key is rejected', async () => {
    const withSymbol = { ...BASE_REFS, [Symbol('x')]: 'y' }
    expect((await refusalCodeFor(baseInput({ evidenceReferences: withSymbol }))).code).toBe(CODE)
  })

  it('4. a MISSING required key is rejected', async () => {
    const { syntheticOrgRef: _dropped, ...missing } = BASE_REFS
    expect((await refusalCodeFor(baseInput({ evidenceReferences: missing as never }))).code).toBe(
      CODE,
    )
  })

  it('5. an EXTRA key is rejected', async () => {
    const extra = { ...BASE_REFS, unexpectedRef: 'x' }
    expect((await refusalCodeFor(baseInput({ evidenceReferences: extra as never }))).code).toBe(CODE)
  })

  it('6. an INHERITED (non-own) key is rejected', async () => {
    const { syntheticOrgRef, ...ownOnly } = BASE_REFS
    const inherited = Object.create({ syntheticOrgRef })
    Object.assign(inherited, ownOnly)
    expect((await refusalCodeFor(baseInput({ evidenceReferences: inherited }))).code).toBe(CODE)
  })

  it('7. a GETTER-valued key is rejected', async () => {
    const withGetter: Record<string, unknown> = { ...BASE_REFS }
    delete withGetter.imageSha
    Object.defineProperty(withGetter, 'imageSha', {
      get: () => 'sha256:aaaa',
      enumerable: true,
      configurable: true,
    })
    expect((await refusalCodeFor(baseInput({ evidenceReferences: withGetter as never }))).code).toBe(
      CODE,
    )
  })

  it('8. a NON-STRING value is rejected', async () => {
    expect(
      (await refusalCodeFor(baseInput({ evidenceReferences: { ...BASE_REFS, imageSha: 7 } as never })))
        .code,
    ).toBe(CODE)
  })

  it('8b. a REGEX-VIOLATING value is rejected (leading punctuation, spaces, over-length)', async () => {
    for (const bad of ['-leading-dash', 'has space', '', 'x'.repeat(129), 'semi;colon']) {
      expect(
        (await refusalCodeFor(baseInput({ evidenceReferences: { ...BASE_REFS, imageSha: bad } })))
          .code,
        `value=${bad.slice(0, 12)}`,
      ).toBe(CODE)
    }
  })

  it('9. RESUME WIDENING: the resume pair demands 5 keys; the 3-key base set refuses', async () => {
    const resume = { expectedState: 'suspended' as const, targetState: 'group_authoritative' as const }
    expect((await refusalCodeFor(baseInput({ ...resume, evidenceReferences: BASE_REFS }))).code).toBe(
      CODE,
    )
    // POSITIVE CONTROL: the widened set gets through validation.
    const { calls } = await refusalCodeFor(baseInput({ ...resume, evidenceReferences: RESUME_REFS }))
    expect(calls).toBeGreaterThan(0)
  })

  it('9b. the widening is RESUME-ONLY: a non-resume pair with the 5-key set is refused', async () => {
    expect((await refusalCodeFor(baseInput({ evidenceReferences: RESUME_REFS }))).code).toBe(CODE)
  })

  it('T-W8 the manifest hash is a SEPARATE gate from the references, proven in both directions', async () => {
    // Good refs + bad hash -> manifest code (NOT the reference code).
    expect(
      (await refusalCodeFor(baseInput({ evidenceManifestSha256: 'not-a-sha' }))).code,
    ).toBe('W7_CONTEXT_SOURCE_TRANSITION_MANIFEST_INVALID')
    expect(
      (await refusalCodeFor(baseInput({ evidenceManifestSha256: 'A'.repeat(64) }))).code,
      'upper-case hex must be refused — HEX64 is lower-case only',
    ).toBe('W7_CONTEXT_SOURCE_TRANSITION_MANIFEST_INVALID')
    // Bad refs + good hash -> reference code. Neither door covers for the other.
    expect((await refusalCodeFor(baseInput({ evidenceReferences: {} as never }))).code).toBe(CODE)
  })
})

describe('W7-3 predicates: totality, derived applicability, closed refusal mapping', () => {
  it('T-P2 the code enumeration is closed, non-empty and duplicate-free', () => {
    expect(ATTENDANCE_W7_CONTEXT_SOURCE_TRANSITION_PREDICATE_CODES_V1.length).toBe(12)
    expect(new Set(ATTENDANCE_W7_CONTEXT_SOURCE_TRANSITION_PREDICATE_CODES_V1).size).toBe(12)
  })

  it('every predicate code maps to a refusal code — total over the enumeration', () => {
    for (const code of ATTENDANCE_W7_CONTEXT_SOURCE_TRANSITION_PREDICATE_CODES_V1) {
      const refusal = ATTENDANCE_W7_CONTEXT_SOURCE_TRANSITION_REFUSAL_CODES_V1[code]
      expect(typeof refusal, code).toBe('string')
      expect(refusal.startsWith('W7_CONTEXT_SOURCE_TRANSITION_'), code).toBe(true)
    }
    expect(Object.keys(ATTENDANCE_W7_CONTEXT_SOURCE_TRANSITION_REFUSAL_CODES_V1).sort()).toEqual(
      [...ATTENDANCE_W7_CONTEXT_SOURCE_TRANSITION_PREDICATE_CODES_V1].sort(),
    )
  })

  it('T-P3 applicability is DERIVED from the pair — asserted for each of the 7 legal pairs', () => {
    const expected: Record<string, readonly string[]> = {
      'off->group_shadow': [
        'ORG_ALLOWLISTED',
        'CONTEXT_SOURCE_ROW_RESOLVABLE',
        'LEGAL_TRANSITION_PAIR',
        'W7_STATE_PRODUCER_DELIVERED',
        'W4_POSTURE_COHERENT',
      ],
      'group_shadow->off': [
        'ORG_ALLOWLISTED',
        'CONTEXT_SOURCE_ROW_RESOLVABLE',
        'LEGAL_TRANSITION_PAIR',
      ],
      'group_shadow->group_eligible': [
        'ORG_ALLOWLISTED',
        'CONTEXT_SOURCE_ROW_RESOLVABLE',
        'LEGAL_TRANSITION_PAIR',
        'W7_STATE_PRODUCER_DELIVERED',
        'W4_POSTURE_COHERENT',
        'INCOMPLETE_OPERATION',
        'UNRESOLVED_INGRESS_REVIEW',
        'DEFECTIVE_REQUEST_SNAPSHOT',
        'W7_CRITICAL_SHADOW_DIFF',
        'W7_OFF_ROSTER_DIFF',
      ],
      'group_eligible->group_shadow': [
        'ORG_ALLOWLISTED',
        'CONTEXT_SOURCE_ROW_RESOLVABLE',
        'LEGAL_TRANSITION_PAIR',
        'W7_STATE_PRODUCER_DELIVERED',
        'W4_POSTURE_COHERENT',
      ],
      'group_eligible->group_authoritative': [
        'ORG_ALLOWLISTED',
        'CONTEXT_SOURCE_ROW_RESOLVABLE',
        'LEGAL_TRANSITION_PAIR',
        'W7_STATE_PRODUCER_DELIVERED',
        'W4_POSTURE_COHERENT',
        'INCOMPLETE_OPERATION',
        'UNRESOLVED_INGRESS_REVIEW',
        'DEFECTIVE_REQUEST_SNAPSHOT',
      ],
      'group_authoritative->suspended': [
        'ORG_ALLOWLISTED',
        'CONTEXT_SOURCE_ROW_RESOLVABLE',
        'LEGAL_TRANSITION_PAIR',
        'SUSPEND_SOURCE_WRITERS_SERIALIZED',
      ],
      'suspended->group_authoritative': [
        'ORG_ALLOWLISTED',
        'CONTEXT_SOURCE_ROW_RESOLVABLE',
        'LEGAL_TRANSITION_PAIR',
        'W7_STATE_PRODUCER_DELIVERED',
        'W4_POSTURE_COHERENT',
        'INCOMPLETE_OPERATION',
        'UNRESOLVED_INGRESS_REVIEW',
        'DEFECTIVE_REQUEST_SNAPSHOT',
        'RESUME_REPLAY_ARTIFACT',
      ],
    }

    // Anchor check: the expectation table covers exactly the ratified pairs, so
    // a pair added to the constant reds here rather than being skipped.
    expect(Object.keys(expected).sort()).toEqual(
      ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_LEGAL_TRANSITIONS_V1.map(([f, t]) => pairKey(f, t)).sort(),
    )

    for (const [from, to] of ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_LEGAL_TRANSITIONS_V1) {
      const actual = attendanceW7ContextSourceApplicablePredicatesV1(from, to)
      expect([...actual], pairKey(from, to)).toEqual(expected[pairKey(from, to)])
      // Emitted in enumeration order, never insertion order.
      const order = ATTENDANCE_W7_CONTEXT_SOURCE_TRANSITION_PREDICATE_CODES_V1.filter((c) =>
        actual.includes(c),
      )
      expect([...actual], `${pairKey(from, to)} ordering`).toEqual([...order])
    }
  })

  it('the two W7-2-fed compare predicates apply to EXACTLY the compare-window pair', () => {
    for (const [from, to] of ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_LEGAL_TRANSITIONS_V1) {
      const applicable = attendanceW7ContextSourceApplicablePredicatesV1(from, to)
      const isCompareWindow = from === 'group_shadow' && to === 'group_eligible'
      for (const probe of ATTENDANCE_W7_CONTEXT_SOURCE_COMPARE_EVIDENCE_PROBES_V1) {
        expect(applicable.includes(probe), `${pairKey(from, to)} / ${probe}`).toBe(isCompareWindow)
      }
    }
  })

  it('the producer gate is NOT applied to the two exits — a stuck org can always leave', () => {
    // The W4 Gate D keying decision, carried over: applying the gate to `-> off`
    // or `-> suspended` would turn a delivery declaration into a trap.
    for (const [from, to] of ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_LEGAL_TRANSITIONS_V1) {
      if (to !== 'off' && to !== 'suspended') continue
      expect(
        attendanceW7ContextSourceApplicablePredicatesV1(from, to),
        pairKey(from, to),
      ).not.toContain('W7_STATE_PRODUCER_DELIVERED')
    }
  })
})

describe('W7-3 declared delivery: mechanical over the enumeration, honest at this head', () => {
  afterEach(() => {
    __setAttendanceW7ContextSourceStateProducerDeliveryOverrideForTests(null)
    __setAttendanceW7ContextSourceCompareEvidenceDeliveryOverrideForTests(null)
  })

  it('the group-producer set is DERIVED: the states enumeration minus the two exits', () => {
    expect([...ATTENDANCE_W7_CONTEXT_SOURCE_GROUP_PRODUCER_STATES_V1]).toEqual([
      'group_shadow',
      'group_eligible',
      'group_authoritative',
    ])
    // Derived, not hand-listed: it is exactly the enumeration minus {off, suspended}.
    expect([...ATTENDANCE_W7_CONTEXT_SOURCE_GROUP_PRODUCER_STATES_V1].sort()).toEqual(
      ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1.filter(
        (s) => s !== 'off' && s !== 'suspended',
      )
        .slice()
        .sort(),
    )
  })

  it('the SHIPPED declaration at this POST-W7-2 head: every state delivered, undelivered count 0', () => {
    // RE-DERIVED, NOT DELETED. This leg asserted the pre-1b/pre-W7-2 reality
    // ("all three group states NOT delivered") and it was correct then. The
    // merge to post-W7-2 main changed reality: the seam serves
    // `group_authoritative`, W7-2's dual-run produces `group_shadow` /
    // `group_eligible`, and `suspended` has a blocked arm. The correspondence
    // leg above is what proves those values against the seam; this leg pins the
    // resulting SHIPPED numbers so a silent flip in either direction is visible.
    for (const state of ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1) {
      expect(isAttendanceW7ContextSourceStateProducerDeliveredV1(state), state).toBe(true)
    }
    expect(attendanceW7ContextSourceUndeliveredStateProducerCountV1()).toBe(0)
  })

  it('both W7-2-fed compare probes are DELIVERED at this head (W7-2 shipped the counter reader)', () => {
    // RE-DERIVED: these were declared-undelivered with `count: null` at the
    // pre-W7-2 base, explicitly "until W7-2 delivers them". W7-2 shipped
    // `readAttendanceW7CompareWindowStatusV1`, so continuing to report `null`
    // would be the dishonest direction — a criterion that CAN be counted
    // reported as uncountable.
    for (const probe of ATTENDANCE_W7_CONTEXT_SOURCE_COMPARE_EVIDENCE_PROBES_V1) {
      expect(isAttendanceW7ContextSourceCompareEvidenceDeliveredV1(probe), probe).toBe(true)
    }
    expect(attendanceW7ContextSourceUndeliveredCompareEvidenceCountV1()).toBe(0)
  })

  it('COMPARE CORRESPONDENCE: declared delivered IFF the counter reader is IMPORT-REACHABLE from the writer', () => {
    // REACHABILITY, NOT TREE PRESENCE — and the distinction is load-bearing.
    //
    // Presence would say "the module exists, so flip the probes true", which
    // would unlock a promotion gate on evidence THE WRITER CANNOT READ. That is
    // exactly the state this tree was in before this slice wired the reader in:
    // `w7-compare-window-status.ts` existed, but its only production importer
    // was `w4c2-live-scheduled-boundary.ts` and no import path carried it to the
    // writer. Presence is also the criterion that reports 29 bogus "producers"
    // for `suspended`; encoding it on a gate imports that weakness onto the gate.
    //
    // So the criterion is the one that actually matters: can the writer REACH
    // the counters. Wiring the reader is therefore a deliberate act with its own
    // leg, never a declaration flip.
    const COMPARE_READER = 'packages/core-backend/src/attendance/w7-compare-window-status.ts'
    const WRITER = 'packages/core-backend/src/attendance/w7-context-source-transition.ts'
    const SPECIFIER_RE = /(?:\bimport\s*\(|\brequire\s*\(|\bfrom\s+)\s*['"]([^'"]+)['"]/g

    function resolvedTargetsOf(rel: string): string[] {
      const abs = path.join(REPO_ROOT, rel)
      if (!fs.existsSync(abs)) return []
      const out: string[] = []
      for (const match of fs.readFileSync(abs, 'utf8').matchAll(SPECIFIER_RE)) {
        const specifier = match[1]
        if (!specifier.startsWith('.')) continue
        const base = path.resolve(path.dirname(abs), specifier)
        for (const candidate of [base, `${base}.ts`, `${base}.cjs`, `${base}.js`, `${base}.mjs`]) {
          if (fs.existsSync(candidate) && fs.lstatSync(candidate).isFile()) {
            out.push(path.relative(REPO_ROOT, candidate).split(path.sep).join('/'))
            break
          }
        }
      }
      return out
    }

    function reachableFrom(root: string): Set<string> {
      const seen = new Set<string>([root])
      const stack = [root]
      while (stack.length > 0) {
        for (const target of resolvedTargetsOf(stack.pop() as string)) {
          if (!seen.has(target)) {
            seen.add(target)
            stack.push(target)
          }
        }
      }
      return seen
    }

    const graph = reachableFrom(WRITER)
    // NON-VACUITY: the walk really traversed a graph and really found the
    // writer's known neighbours — a broken resolver would report "unreachable"
    // for everything and make the biconditional pass by accident.
    expect(graph.size).toBeGreaterThan(20)
    expect(graph).toContain('packages/core-backend/src/attendance/w7-context-source-delivery.ts')
    expect(graph).toContain('packages/core-backend/src/attendance/w4c0-identity.ts')

    const readerReachable = graph.has(COMPARE_READER)
    for (const probe of ATTENDANCE_W7_CONTEXT_SOURCE_COMPARE_EVIDENCE_PROBES_V1) {
      expect(
        isAttendanceW7ContextSourceCompareEvidenceDeliveredV1(probe),
        `${probe}: declared delivery must equal reader reachability ` +
          `(reachable=${readerReachable}). Flipping the declaration without wiring the reader — ` +
          `or wiring it without flipping — is the drift this leg exists to catch.`,
      ).toBe(readerReachable)
    }

    // ...and the reader really produces THESE codes, so "reachable" is not
    // satisfied by reaching some unrelated module.
    expect(typeof readAttendanceW7CompareWindowStatusV1).toBe('function')
    expect(ATTENDANCE_W7_COMPARE_PREDICATE_CODES_V1).toEqual(
      expect.arrayContaining([...ATTENDANCE_W7_CONTEXT_SOURCE_COMPARE_EVIDENCE_PROBES_V1]),
    )
  })

  it('T-P8 the counts are MECHANICAL over their enumerations, not hand-coded', () => {
    // RE-DERIVED for the post-W7-2 baseline. The shipped baseline is now 0
    // undelivered on both enumerations, so the discriminating direction
    // inverted: withdraw delivery one key at a time and assert the count RISES
    // by exactly one. Same mechanical property, same one-at-a-time discipline;
    // a hand-coded constant still cannot track it.
    for (let i = 0; i < ATTENDANCE_W7_CONTEXT_SOURCE_GROUP_PRODUCER_STATES_V1.length; i += 1) {
      const withdrawn = ATTENDANCE_W7_CONTEXT_SOURCE_GROUP_PRODUCER_STATES_V1.slice(0, i + 1)
      __setAttendanceW7ContextSourceStateProducerDeliveryOverrideForTests(
        Object.fromEntries(withdrawn.map((s) => [s, false])) as never,
      )
      expect(attendanceW7ContextSourceUndeliveredStateProducerCountV1()).toBe(i + 1)
    }
    for (let i = 0; i < ATTENDANCE_W7_CONTEXT_SOURCE_COMPARE_EVIDENCE_PROBES_V1.length; i += 1) {
      const withdrawn = ATTENDANCE_W7_CONTEXT_SOURCE_COMPARE_EVIDENCE_PROBES_V1.slice(0, i + 1)
      __setAttendanceW7ContextSourceCompareEvidenceDeliveryOverrideForTests(
        Object.fromEntries(withdrawn.map((p) => [p, false])) as never,
      )
      expect(attendanceW7ContextSourceUndeliveredCompareEvidenceCountV1()).toBe(i + 1)
    }
  })

  it('an UNKNOWN key reads as undelivered — a sixth state added tomorrow fails closed', () => {
    expect(
      isAttendanceW7ContextSourceStateProducerDeliveredV1(
        'group_future' as AttendanceW7ContextSourcePostureStateV1,
      ),
    ).toBe(false)
  })

  it('the override seam is PARTIAL: an unmentioned key falls through to the shipped value', () => {
    // RE-DERIVED: with the shipped baseline now all-delivered, the partial
    // override is exercised by WITHDRAWING one key — the unmentioned ones must
    // still fall through to the shipped `true`.
    __setAttendanceW7ContextSourceStateProducerDeliveryOverrideForTests({ group_shadow: false })
    expect(isAttendanceW7ContextSourceStateProducerDeliveredV1('group_shadow')).toBe(false)
    expect(isAttendanceW7ContextSourceStateProducerDeliveredV1('group_authoritative')).toBe(true)
    expect(isAttendanceW7ContextSourceStateProducerDeliveredV1('off')).toBe(true)
  })

  it('CORRESPONDENCE: every declared value equals what the SEAM\'s exported arrays actually say', () => {
    // REBUILT AT THE POST-W7-2 MERGE. This leg used to scan production files for
    // the state LITERAL and treat a hit as "a producer exists". That proxy did
    // its job — it caught the merge and refused to let a stale declaration ship
    // — but it is weak in both directions: it cannot tell a module that SERVES a
    // state from one that merely mentions the word, and for the common words
    // `off` and `suspended` it matches 26 and 29 unrelated modules (multitable
    // job status, DingTalk OAuth, k3 adapters...). Measured, not guessed.
    //
    // The seam publishes the truth as three CLOSED, EXPORTED arrays, and its own
    // T-A4 leg proves they partition the state enumeration exactly. So this leg
    // now asserts the thing that is actually this module's business: THE
    // DECLARATION AGREES WITH THE SEAM. The seam's partition proof is consumed,
    // not restated.
    //
    // The tests may import the seam; the production delivery module must NOT —
    // it stays a leaf so the ops CLI and the server read the identical const.
    const servedByGroupArm = new Set<string>(ATTENDANCE_W7_GROUP_ARM_STATES_V1)
    const runsShadowCompare = new Set<string>(ATTENDANCE_W7_SHADOW_COMPARE_STATES_V1)
    const blocked = new Set<string>(ATTENDANCE_W7_BLOCKED_ARM_STATES_V1)

    // Anchor check: the seam's arrays are non-empty and really name W7 states,
    // so a renamed/emptied export cannot make every assertion below vacuous.
    expect(servedByGroupArm.size).toBeGreaterThan(0)
    expect(runsShadowCompare.size).toBeGreaterThan(0)
    expect(blocked.size).toBeGreaterThan(0)
    for (const state of [...servedByGroupArm, ...runsShadowCompare, ...blocked]) {
      expect(ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1).toContain(state)
    }

    // COLLECT-THEN-ASSERT, deliberately. The previous shape asserted inside the
    // loop, so it ABORTED on the first stale state and reported one failure
    // while two more hid behind it — the merged tree had all three group states
    // stale and CI showed exactly one. A fix guided by that output reds twice
    // more. One run must now name every mismatch.
    const mismatches: string[] = []
    const kindMismatches: string[] = []
    for (const state of ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1) {
      const expected =
        servedByGroupArm.has(state) ||
        runsShadowCompare.has(state) ||
        blocked.has(state) ||
        state === 'off'
      const declared = isAttendanceW7ContextSourceStateProducerDeliveredV1(state)
      const entry = ATTENDANCE_W7_CONTEXT_SOURCE_DELIVERY_DECLARATIONS_V1[state]
      if (declared !== expected) {
        mismatches.push(
          `'${state}' declared ${declared ? 'DELIVERED' : 'undelivered'} but the seam says ` +
            `${expected ? 'routed' : 'NOT routed'} ` +
            `(groupArm=${servedByGroupArm.has(state)} compare=${runsShadowCompare.has(state)} ` +
            `blocked=${blocked.has(state)}); reason: "${entry.reason}"`,
        )
      }
      // The KIND must match the seam's own partition too — "delivered" is not
      // one thing, and a served cutover must never be recorded as an unserved
      // dual-run (or the reverse). Tree presence cannot tell these apart; this
      // can.
      const expectedKind = servedByGroupArm.has(state)
        ? 'served'
        : runsShadowCompare.has(state)
          ? 'unserved_comparison'
          : blocked.has(state)
            ? 'blocked'
            : 'legacy'
      if (entry.kind !== expectedKind) {
        kindMismatches.push(`'${state}' kind=${entry.kind} but the seam implies ${expectedKind}`)
      }
      expect(entry.reason.length, `'${state}' has no reason`).toBeGreaterThan(20)
    }
    expect(mismatches, 'delivery declaration disagrees with the seam').toEqual([])
    expect(kindMismatches, 'delivery KIND disagrees with the seam').toEqual([])
  })

  it('CORRESPONDENCE (forward-looking): a group-producer state routed NOWHERE by the seam must red', () => {
    // The failure mode the previous version could not see: a future ruling that
    // NARROWS the seam — the seam's own [OWNER-CONFIRM B-3] would remove
    // `group_eligible` from the shadow-compare array — leaves that state routed
    // nowhere while this module still declares it delivered. Simulated here by
    // removing it from the derived sets rather than by editing the seam.
    const narrowedCompare = ATTENDANCE_W7_SHADOW_COMPARE_STATES_V1.filter(
      (state) => state !== 'group_eligible',
    )
    const routedUnderNarrowing = new Set<string>([
      ...ATTENDANCE_W7_GROUP_ARM_STATES_V1,
      ...narrowedCompare,
      ...ATTENDANCE_W7_BLOCKED_ARM_STATES_V1,
      'off',
    ])
    // Anchor: the narrowing really removed something, or this proves nothing.
    expect(narrowedCompare.length).toBe(ATTENDANCE_W7_SHADOW_COMPARE_STATES_V1.length - 1)
    expect(routedUnderNarrowing.has('group_eligible')).toBe(false)

    // Under that narrowing the CURRENT declaration would be wrong for exactly
    // one state — which is what the correspondence leg above would report.
    const wouldMismatch = ATTENDANCE_W7_CONTEXT_SOURCE_POSTURE_STATES_V1.filter(
      (state) =>
        isAttendanceW7ContextSourceStateProducerDeliveredV1(state) !==
        routedUnderNarrowing.has(state),
    )
    expect(wouldMismatch).toEqual(['group_eligible'])
  })

  it('the group-producer set is exactly the states the seam treats as group-arm or compare', () => {
    // Ties THIS module's gate domain to the seam's partition: a state that the
    // seam starts serving must not silently stay outside the producer gate.
    const seamGroupStates = [
      ...new Set([
        ...ATTENDANCE_W7_GROUP_ARM_STATES_V1,
        ...ATTENDANCE_W7_SHADOW_COMPARE_STATES_V1,
      ]),
    ].sort()
    expect([...ATTENDANCE_W7_CONTEXT_SOURCE_GROUP_PRODUCER_STATES_V1].sort()).toEqual(seamGroupStates)
  })
})

describe('T-W11 single-writer inventory: no DML on either W7 table outside this module', () => {
  // Driven by the REAL repo-wide DML collector (the one the CI gate runs), not
  // by a local regex: a private sweep could disagree with the gate, and the gate
  // is what actually blocks a merge. Both query syntaxes (raw SQL and the
  // builder) are covered because the collector covers both.
  const TOOL_DIR = path.join(REPO_ROOT, 'scripts/attendance/w4c0-dml-inventory')
  const WRITER = 'packages/core-backend/src/attendance/w7-context-source-transition.ts'
  const W7_TABLES = [
    'attendance_calculation_context_source_state',
    'attendance_calculation_context_source_events',
  ]

  function collectSites(): Array<{ relPath: string; table: string; verb: string; symbol: string }> {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const { createWorktreeSource } = require(path.join(TOOL_DIR, 'sources.cjs'))
    const { buildRawCensus } = require(path.join(TOOL_DIR, 'collector.cjs'))
    /* eslint-enable @typescript-eslint/no-var-requires */
    const { sites } = buildRawCensus(createWorktreeSource(REPO_ROOT))
    return (sites as Array<Record<string, string>>).map((site) => ({
      relPath: site.relPath,
      table: site.table,
      verb: site.verb,
      symbol: site.enclosingSymbol,
    }))
  }

  it('every DML site against either W7 context-source table lives in the single writer', () => {
    const sites = collectSites()

    // NON-VACUITY, first: the census really walked the repo and really found
    // this module's sites. An empty or misdirected scan would otherwise satisfy
    // the exclusion assertion below trivially.
    expect(sites.length).toBeGreaterThan(100)
    const w7Sites = sites.filter((site) => W7_TABLES.includes(site.table))
    expect(
      w7Sites.map((s) => `${s.relPath}::${s.symbol}::${s.table}::${s.verb}`).sort(),
    ).toEqual([
      `${WRITER}::lockContextSourceRowForBootstrapOrRead::attendance_calculation_context_source_state::insert`,
      `${WRITER}::transitionAttendanceW7ContextSourceV1::attendance_calculation_context_source_events::insert`,
      `${WRITER}::transitionAttendanceW7ContextSourceV1::attendance_calculation_context_source_state::update`,
    ])

    // Stated as the property, not just as the list: EXACTLY three sites, all in
    // one file. A second writer anywhere reds this even if someone updates the
    // list above carelessly.
    expect(new Set(w7Sites.map((s) => s.relPath))).toEqual(new Set([WRITER]))
  })

  it('exactly TWO of the three sites touch the STATE table — one writer, and it is the boundary', () => {
    // The W4 NIT-4 precision made checkable: the STATE table has exactly one
    // writing module, and (in this slice) the EVENT table does too. A future
    // second EVENT-only writer would change the second number and must be
    // reviewed as such rather than slipping in.
    const sites = collectSites().filter((site) => W7_TABLES.includes(site.table))
    const stateSites = sites.filter(
      (s) => s.table === 'attendance_calculation_context_source_state',
    )
    const eventSites = sites.filter(
      (s) => s.table === 'attendance_calculation_context_source_events',
    )
    expect(stateSites.length).toBe(2)
    expect(eventSites.length).toBe(1)
    expect(new Set([...stateSites, ...eventSites].map((s) => s.relPath)).size).toBe(1)
    // No DELETE path exists on either table at all.
    expect(sites.map((s) => s.verb).sort()).toEqual(['insert', 'insert', 'update'])
  })
})

describe('W7-3 allowlist: the ONE landed predicate, exact org only', () => {
  let saved: string | undefined

  beforeEach(() => {
    saved = process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV]
  })

  afterEach(() => {
    if (saved === undefined) delete process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV]
    else process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV] = saved
  })

  it('T-W6 the writer imports the LANDED predicate — no second allowlist copy in the module', () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, 'packages/core-backend/src/attendance/w7-context-source-transition.ts'),
      'utf8',
    )
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    // It imports the one predicate...
    expect(code).toContain('isAttendanceW7ContextSourceOrgAllowlistedV1')
    expect(code).toContain("from './w7-resolver/w7-context-source-posture-resolver'")
    // ...and holds NO second copy of the parsing rules or of the env name.
    expect(code).not.toContain('ATTENDANCE_W7_CONTEXT_SOURCE_ENABLED')
    expect(code).not.toContain('process.env')
    expect(code).not.toContain('.split(\',\')')
    // POSITIVE CONTROL on the comment stripper: it must not have eaten the file.
    expect(code).toContain('transitionAttendanceW7ContextSourceV1')
  })

  it('T-W5 the allowlist predicate: exact org only, `*` never counts', async () => {
    // Asserted against the PREDICATE, positively, in both directions. The
    // boundary's ORDERING (that a non-allowlisted org is refused before the row
    // read) is a DB-visible property and is proven in the real-PG suite, not
    // inferred here from an exploding-connection probe.
    const { isAttendanceW7ContextSourceOrgAllowlistedV1: allowlisted } = await import(
      '../w7-resolver/w7-context-source-posture-resolver'
    )
    // Each negative asserted individually rather than as one disjunction, so a
    // single broken case cannot hide behind a sibling.
    for (const value of ['', '*', '*,*', ORG_B, `${ORG_B},*`]) {
      process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV] = value
      expect(allowlisted(ORG_A), `allowlist=${value}`).toBe(false)
    }
    // A PREFIX/SUBSTRING of the org must not count — the exact-match property.
    process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV] = ORG_A.slice(0, 20)
    expect(allowlisted(ORG_A)).toBe(false)
    process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV] = `${ORG_A}extra`
    expect(allowlisted(ORG_A)).toBe(false)
    // POSITIVE CONTROLS: the exact org passes, alone and among others, and
    // surrounding whitespace is trimmed.
    process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV] = ORG_A
    expect(allowlisted(ORG_A)).toBe(true)
    process.env[ATTENDANCE_W7_CONTEXT_SOURCE_ALLOWLIST_ENV] = `${ORG_B}, ${ORG_A} `
    expect(allowlisted(ORG_A)).toBe(true)
    expect(allowlisted(ORG_B)).toBe(true)
  })
})
