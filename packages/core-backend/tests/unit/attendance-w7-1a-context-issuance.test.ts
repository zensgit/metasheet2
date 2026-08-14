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

function readIssuanceModuleSource(): string {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  return fs.readFileSync(
    path.resolve(__dirname, '../../src/attendance/w7-resolver/w7-group-effective-context-issuance.ts'),
    'utf8',
  )
}
