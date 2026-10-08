/**
 * W7-1a (#4556) STEP 3 gate — the single core-owned group-effective V2
 * issuance boundary (design-lock red line W7-R1).
 *
 * Ratified per #4556 comments 5293034619 (owner-directed disclosed relay) + 5293478713 (owner
 * first-person confirmation) — ruling 10 (OD-W7-6 = (a)).
 *
 * ORIGIN and CONTENT are tested as SEPARATE proofs throughout, because
 * conflating them is the specific error W7-R1 calls out: a valid fingerprint
 * is content integrity, never origin.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import type { AttendanceW7GroupEffectiveFactsV1 } from '../../src/attendance/w7-resolver/w7-group-effective-facts-resolver'
import {
  ATTENDANCE_W7_CONTEXT_FACTS_INVALID,
  ATTENDANCE_W7_CONTEXT_FINGERPRINT_MISMATCH,
  ATTENDANCE_W7_CONTEXT_SHAPE_INVALID,
  computeAttendanceW7GroupEffectiveContextFingerprintV1,
  coreIssueGroupEffectiveContextV2,
  coreRehydrateGroupEffectiveContextV2,
  isCoreIssuedGroupEffectiveContextV2,
} from '../../src/attendance/w7-resolver/w7-group-effective-context-issuance'

function facts(overrides: Partial<AttendanceW7GroupEffectiveFactsV1> = {}): AttendanceW7GroupEffectiveFactsV1 {
  return {
    orgId: 'org-w7-fixture',
    userId: '11111111-1111-4111-8111-111111111111',
    workDate: '2026-08-14',
    timezone: 'Asia/Shanghai',
    calculationGroupId: '22222222-2222-4222-8222-222222222222',
    shiftId: '33333333-3333-4333-8333-333333333333',
    isWorkday: true,
    holidayKind: null,
    roundingMinutes: 5,
    severeLateThresholdMinutes: 60,
    absenceLateThresholdMinutes: 240,
    segments: [
      {
        index: 0,
        startTime: '09:00',
        endTime: '18:00',
        startDayOffset: 0,
        endDayOffset: 0,
        lateGraceMinutes: 5,
        earlyLeaveGraceMinutes: 5,
      },
    ],
    ...overrides,
  }
}

/** Every assertion below reads `.code`, never `.name` and never a bare
 *  `instanceof`: a judge that keys off a class name is itself the hole. */
function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return (error as { code?: string }).code ?? '<no code>'
  }
  return '<did not throw>'
}

describe('W7-R1 operation (i): mint a group-effective V2 from resolver facts', () => {
  it('mints a v2 context with the fixed discriminants and a non-empty calculationGroupId', () => {
    const context = coreIssueGroupEffectiveContextV2(facts())
    expect(context.schemaVersion).toBe(2)
    expect(context.selector).toBe('group_effective')
    expect(context.calculationGroupId).toBe('22222222-2222-4222-8222-222222222222')
    expect(typeof context.calculationGroupId === 'string' && context.calculationGroupId.length > 0).toBe(true)
  })

  it('the minted context has EXACTLY the 14 v2 keys — no more, no fewer', () => {
    const context = coreIssueGroupEffectiveContextV2(facts())
    expect(Object.getOwnPropertyNames(context).sort()).toEqual(
      [
        'absenceLateThresholdMinutes',
        'calculationGroupId',
        'holidayKind',
        'isWorkday',
        'orgId',
        'roundingMinutes',
        'schemaVersion',
        'segments',
        'selector',
        'severeLateThresholdMinutes',
        'shiftId',
        'timezone',
        'userId',
        'workDate',
      ].sort(),
    )
  })

  it('emits NO provenance value — the 1a-M widening is a separate slice', () => {
    // Mechanical, not a promise: `projectionOwner` and a trace `source.kind`
    // are simply not members of the v2 key set, so operation (i) structurally
    // cannot write `w4_group` or `group_policy_snapshot`.
    const keys = Object.getOwnPropertyNames(coreIssueGroupEffectiveContextV2(facts()))
    expect(keys).not.toContain('projectionOwner')
    expect(keys).not.toContain('source')
    expect(JSON.stringify(coreIssueGroupEffectiveContextV2(facts()))).not.toContain('w4_group')
    expect(JSON.stringify(coreIssueGroupEffectiveContextV2(facts()))).not.toContain('group_policy_snapshot')
  })

  it('the minted context is DEEP frozen (segments too, not just the top level)', () => {
    const context = coreIssueGroupEffectiveContextV2(facts())
    expect(Object.isFrozen(context)).toBe(true)
    expect(Object.isFrozen(context.segments)).toBe(true)
    expect(Object.isFrozen(context.segments[0])).toBe(true)
    // A shallow freeze would let this mutation land; assert the VALUE, not
    // just that the write "did not throw".
    try {
      ;(context.segments[0] as { startTime: string }).startTime = '23:59'
    } catch {
      /* strict mode throws; sloppy mode silently ignores — both are fine */
    }
    expect(context.segments[0].startTime).toBe('09:00')
  })

  it('ORIGIN: the minted object is registered; a structurally identical clone is NOT', () => {
    const context = coreIssueGroupEffectiveContextV2(facts())
    expect(isCoreIssuedGroupEffectiveContextV2(context)).toBe(true)

    // The clone carries every field AND would compute the same fingerprint —
    // and still fails the origin leg. That is the separation W7-R1 requires.
    const clone = JSON.parse(JSON.stringify(context)) as unknown
    expect(clone).toEqual(context)
    expect(computeAttendanceW7GroupEffectiveContextFingerprintV1(clone)).toBe(
      computeAttendanceW7GroupEffectiveContextFingerprintV1(context),
    )
    expect(isCoreIssuedGroupEffectiveContextV2(clone)).toBe(false)

    // Spread and Object.assign destroy it too.
    expect(isCoreIssuedGroupEffectiveContextV2({ ...context })).toBe(false)
    expect(isCoreIssuedGroupEffectiveContextV2(Object.assign({}, context))).toBe(false)
  })

  it('a hand-written object literal is never registered, however well-formed', () => {
    const forged = {
      schemaVersion: 2,
      selector: 'group_effective',
      orgId: 'org-w7-fixture',
      userId: '11111111-1111-4111-8111-111111111111',
      workDate: '2026-08-14',
      timezone: 'Asia/Shanghai',
      shiftId: '33333333-3333-4333-8333-333333333333',
      isWorkday: true,
      holidayKind: null,
      calculationGroupId: '22222222-2222-4222-8222-222222222222',
      roundingMinutes: 5,
      severeLateThresholdMinutes: 60,
      absenceLateThresholdMinutes: 240,
      segments: [
        {
          index: 0,
          startTime: '09:00',
          endTime: '18:00',
          startDayOffset: 0,
          endDayOffset: 0,
          lateGraceMinutes: 5,
          earlyLeaveGraceMinutes: 5,
        },
      ],
    }
    expect(isCoreIssuedGroupEffectiveContextV2(forged)).toBe(false)
  })

  it('fail-closes on an empty calculationGroupId (the boundary re-checks, not assumes)', () => {
    expect(codeOf(() => coreIssueGroupEffectiveContextV2(facts({ calculationGroupId: '' })))).toBe(
      ATTENDANCE_W7_CONTEXT_FACTS_INVALID,
    )
  })

  it('fail-closes on facts whose values cannot form a valid v2 (negative control on the shape gate)', () => {
    expect(codeOf(() => coreIssueGroupEffectiveContextV2(facts({ roundingMinutes: 0 })))).toBe(
      ATTENDANCE_W7_CONTEXT_FACTS_INVALID,
    )
    expect(codeOf(() => coreIssueGroupEffectiveContextV2(facts({ timezone: '' })))).toBe(
      ATTENDANCE_W7_CONTEXT_FACTS_INVALID,
    )
    expect(codeOf(() => coreIssueGroupEffectiveContextV2(facts({ segments: [] })))).toBe(
      ATTENDANCE_W7_CONTEXT_FACTS_INVALID,
    )
    // POSITIVE CONTROL for the three negatives above: the unmodified fixture
    // must NOT throw, otherwise every leg would "pass" for the wrong reason.
    expect(() => coreIssueGroupEffectiveContextV2(facts())).not.toThrow()
  })
})

describe('W7-R1 operation (ii): rehydrate an already-frozen serialized context', () => {
  it('an UNCHANGED serialized snapshot rehydrates — the positive control', () => {
    const original = coreIssueGroupEffectiveContextV2(facts())
    const fingerprint = computeAttendanceW7GroupEffectiveContextFingerprintV1(original)
    const serialized = JSON.parse(JSON.stringify(original)) as unknown

    const rehydrated = coreRehydrateGroupEffectiveContextV2(serialized, fingerprint)
    expect(rehydrated).toEqual(original)
    expect(isCoreIssuedGroupEffectiveContextV2(rehydrated)).toBe(true)
    expect(Object.isFrozen(rehydrated.segments[0])).toBe(true)
  })

  it('CONTENT: altering payload bytes after serialization fails the fingerprint leg', () => {
    const original = coreIssueGroupEffectiveContextV2(facts())
    const fingerprint = computeAttendanceW7GroupEffectiveContextFingerprintV1(original)
    const tampered = JSON.parse(JSON.stringify(original)) as Record<string, unknown>
    tampered.roundingMinutes = 15

    expect(codeOf(() => coreRehydrateGroupEffectiveContextV2(tampered, fingerprint))).toBe(
      ATTENDANCE_W7_CONTEXT_FINGERPRINT_MISMATCH,
    )
  })

  it('a tampered SEGMENT also fails the content leg (nested bytes are covered)', () => {
    const original = coreIssueGroupEffectiveContextV2(facts())
    const fingerprint = computeAttendanceW7GroupEffectiveContextFingerprintV1(original)
    const tampered = JSON.parse(JSON.stringify(original)) as { segments: { startTime: string }[] }
    tampered.segments[0].startTime = '10:00'

    expect(codeOf(() => coreRehydrateGroupEffectiveContextV2(tampered, fingerprint))).toBe(
      ATTENDANCE_W7_CONTEXT_FINGERPRINT_MISMATCH,
    )
  })

  it('rehydration rejects an unknown schemaVersion and an unknown selector — never a default', () => {
    const original = coreIssueGroupEffectiveContextV2(facts())
    const fingerprint = computeAttendanceW7GroupEffectiveContextFingerprintV1(original)

    const wrongVersion = { ...JSON.parse(JSON.stringify(original)), schemaVersion: 3 }
    expect(codeOf(() => coreRehydrateGroupEffectiveContextV2(wrongVersion, fingerprint))).toBe(
      ATTENDANCE_W7_CONTEXT_SHAPE_INVALID,
    )

    const wrongSelector = { ...JSON.parse(JSON.stringify(original)), selector: 'group_shadow' }
    expect(codeOf(() => coreRehydrateGroupEffectiveContextV2(wrongSelector, fingerprint))).toBe(
      ATTENDANCE_W7_CONTEXT_SHAPE_INVALID,
    )
  })

  it('rehydration rejects an EXTRA key — including a v1 `flexPolicy` on a v2 object', () => {
    const original = coreIssueGroupEffectiveContextV2(facts())
    const fingerprint = computeAttendanceW7GroupEffectiveContextFingerprintV1(original)
    const withFlex = {
      ...JSON.parse(JSON.stringify(original)),
      flexPolicy: { mode: 'flex_required_duration' },
    }
    expect(codeOf(() => coreRehydrateGroupEffectiveContextV2(withFlex, fingerprint))).toBe(
      ATTENDANCE_W7_CONTEXT_SHAPE_INVALID,
    )
  })

  it('P3-1 carry-forward: the v2 exact-key rule is NOT applied to any v1 object here', () => {
    // W7-1a wires no discriminant into the live validator, so there is no v1
    // branch in this module to test. What IS assertable — and is the whole
    // point of recording the carry-forward — is that these functions reject a
    // v1-tagged object outright rather than silently validating it under v2
    // rules and stripping its optional `flexPolicy`.
    const v1Like = {
      schemaVersion: 1,
      selector: 'legacy',
      orgId: 'org-w7-fixture',
      userId: '11111111-1111-4111-8111-111111111111',
      workDate: '2026-08-14',
      timezone: 'Asia/Shanghai',
      shiftId: '33333333-3333-4333-8333-333333333333',
      isWorkday: true,
      holidayKind: null,
      calculationGroupId: null,
      roundingMinutes: 5,
      severeLateThresholdMinutes: 60,
      absenceLateThresholdMinutes: 240,
      segments: [
        {
          index: 0,
          startTime: '09:00',
          endTime: '18:00',
          startDayOffset: 0,
          endDayOffset: 0,
          lateGraceMinutes: 5,
          earlyLeaveGraceMinutes: 5,
        },
      ],
    }
    expect(codeOf(() => computeAttendanceW7GroupEffectiveContextFingerprintV1(v1Like))).toBe(
      ATTENDANCE_W7_CONTEXT_SHAPE_INVALID,
    )
    expect(codeOf(() => coreRehydrateGroupEffectiveContextV2(v1Like, 'x'.repeat(64)))).toBe(
      ATTENDANCE_W7_CONTEXT_SHAPE_INVALID,
    )
  })

  it('rehydration performs no read of any kind — it is a pure function of its two arguments', () => {
    // W7-R6 depends on this: a `frozen_prior` replay must consume only the
    // snapshot. Proven structurally — the module imports exactly one thing,
    // `node:crypto`, and takes no client/pool/query argument.
    const source = readIssuanceModuleSource()
    const imports = [...source.matchAll(/^import[^\n]*from\s+'([^']+)'/gm)].map((m) => m[1])
    expect(imports.sort()).toEqual(['./w7-group-effective-facts-resolver', 'node:crypto'])
    // The resolver import is `import type` (compile-erased), so no runtime edge.
    expect(source).toContain("import type { AttendanceW7GroupEffectiveFactsV1 } from './w7-group-effective-facts-resolver'")
    expect(source).not.toMatch(/\btrx\b|\bpool\b|\.query\s*\(/)
  })
})

describe('W7-R1 fingerprint: the domain separator is PINNED, not decorative', () => {
  /**
   * GOLDEN VECTOR. The expected digest was computed INDEPENDENTLY with
   * python3 `hashlib` from the written spec — sha256(domain-utf8 ||
   * canonical-payload-utf8), hex — never by calling the function under test.
   * A digest harvested from the implementation would pin whatever the
   * implementation happens to do, which is the tautology this exists to avoid.
   *
   * Why it is needed: every other fingerprint assertion in this file is
   * SELF-REFERENTIAL (`compute(clone)` vs `compute(context)`, or a digest fed
   * straight back into rehydration). An independent gate proved the domain
   * separator could be replaced wholesale and the entire battery stayed green
   * — a guard that can be neutered green is an untested guard.
   *
   * Forward-looking, and the real reason this matters: rehydration exists so a
   * `frozen_prior` snapshot that crossed a DATABASE boundary can be re-admitted
   * (W7-R6). Once W7-1b wires a producer, a domain that silently drifts between
   * write and read makes every stored snapshot fail
   * `W7_CONTEXT_FINGERPRINT_MISMATCH`. This pin is what keeps that from being
   * discovered in production instead of here.
   */
  const GOLDEN_FIXTURE_CONTEXT = coreIssueGroupEffectiveContextV2(
    facts({
      orgId: 'org-w7-golden',
      calculationGroupId: '22222222-2222-4222-8222-222222222222',
      shiftId: '33333333-3333-4333-8333-333333333333',
    }),
  )
  const GOLDEN_FINGERPRINT = '4b79ae1e47a0713602ac103f758390e00c4cf45e5a124b6ae5c675055b50fc21'

  it('a fixed context produces the independently-computed golden digest', () => {
    expect(computeAttendanceW7GroupEffectiveContextFingerprintV1(GOLDEN_FIXTURE_CONTEXT)).toBe(
      GOLDEN_FINGERPRINT,
    )
  })

  it('the domain separator literal is pinned by exact code units and length', () => {
    // Read from source, so changing the constant reds here even if some future
    // refactor stopped the golden above from covering it.
    const source = readIssuanceModuleSource()
    const match = source.match(/const W7_V2_FINGERPRINT_DOMAIN = '([^']*)'/)
    expect(match, 'domain constant not found — the pin is pointing at nothing').not.toBeNull()

    // The source must spell the terminator as the ESCAPE, never as a raw byte:
    // a literal U+0000 makes the whole file binary to git/grep/the PR diff.
    // (Repo-wide enforcement: tests/unit/source-files-no-raw-control-bytes.test.ts.)
    expect(match?.[1]).toBe('metasheet.attendance.w7.frozen-context.v2\\u0000')
    expect(source).not.toContain('\u0000')

    // ...and the RUNTIME value is the 42-char name plus the single NUL.
    const expectedDomain = `metasheet.attendance.w7.frozen-context.v2\u0000`
    expect(expectedDomain).toHaveLength(42)
    expect(expectedDomain.codePointAt(41)).toBe(0)
  })

  it('SENSITIVITY CONTROL: the golden really is a function of the domain', () => {
    // Reproduces the construction from the spec and shows that changing ONLY
    // the domain changes the digest. Without this, the golden could be passing
    // for a reason unrelated to the domain (e.g. if the domain were dropped
    // entirely and the digest happened to be pinned to the payload alone).
    const payload = JSON.stringify([
      2,
      'group_effective',
      'org-w7-golden',
      '11111111-1111-4111-8111-111111111111',
      '2026-08-14',
      'Asia/Shanghai',
      '33333333-3333-4333-8333-333333333333',
      true,
      null,
      '22222222-2222-4222-8222-222222222222',
      5,
      60,
      240,
      [[0, '09:00', '18:00', 0, 0, 5, 5]],
    ])

    const withDomain = createHash('sha256')
      .update(`metasheet.attendance.w7.frozen-context.v2\u0000`, 'utf8')
      .update(payload, 'utf8')
      .digest('hex')
    expect(withDomain).toBe(GOLDEN_FINGERPRINT)

    // Drop the NUL terminator only — one code unit — and the digest moves.
    const withoutNul = createHash('sha256')
      .update('metasheet.attendance.w7.frozen-context.v2', 'utf8')
      .update(payload, 'utf8')
      .digest('hex')
    expect(withoutNul).not.toBe(GOLDEN_FINGERPRINT)

    // Replace the domain wholesale — the exact mutation the gate used.
    const otherDomain = createHash('sha256')
      .update('REVIEW-MUTATION-DOMAIN-CHANGED', 'utf8')
      .update(payload, 'utf8')
      .digest('hex')
    expect(otherDomain).not.toBe(GOLDEN_FINGERPRINT)
  })

  it('the golden fixture is a genuine minted context, not a hand-built stub', () => {
    // Guards the fixture itself: if `facts()` drifted so the golden context
    // stopped being what op(i) produces, the pin would be pinning a fiction.
    expect(isCoreIssuedGroupEffectiveContextV2(GOLDEN_FIXTURE_CONTEXT)).toBe(true)
    expect(GOLDEN_FIXTURE_CONTEXT.orgId).toBe('org-w7-golden')
    expect(Object.getOwnPropertyNames(GOLDEN_FIXTURE_CONTEXT)).toHaveLength(14)
  })
})

function readIssuanceModuleSource(): string {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  return fs.readFileSync(
    path.resolve(__dirname, '../../src/attendance/w7-resolver/w7-group-effective-context-issuance.ts'),
    'utf8',
  )
}
