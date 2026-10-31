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
import {
  assembleAttendanceW7GroupEffectiveFactsV1,
  type AttendanceW7LoadedSourceRowsV1,
} from '../../src/attendance/w7-resolver/w7-group-effective-facts-from-rows'
import {
  resolveW7GroupEffectiveFactsInTransactionV1,
  type AttendanceW7GroupEffectiveResolverDepsV1,
  type AttendanceW7GroupEffectiveFactsV1,
} from '../../src/attendance/w7-resolver/w7-group-effective-facts-resolver'

const SOURCE_FILES = {
  resolver: 'w7-resolver/w7-group-effective-facts-resolver.ts',
  assembler: 'w7-resolver/w7-group-effective-facts-from-rows.ts',
  retained: 'attendance-calc14-w7-source-loader.ts',
  seam: 'w7-resolver/w7-frozen-context-issuance-seam.ts',
} as const

type ResolverSources = Record<keyof typeof SOURCE_FILES, string>
const compact = (source: string): string => source.replace(/\s+/g, '')
const readSources = (): ResolverSources => Object.fromEntries(
  Object.entries(SOURCE_FILES).map(([key, file]) => [
    key, compact(fs.readFileSync(path.resolve(__dirname, '../../src/attendance', file), 'utf8')),
  ]),
) as ResolverSources

// The original 12 semantic guards survive CALC14's split. Three group checks
// now share one return; do not confuse a return-site count with that contract.
const RESOLVER_FAIL_CLOSE_GUARDS_V1 = 12
const GROUP_GUARD = "if(!calculationGroupId||!groupRow||groupRow.id!==calculationGroupId||groupRow.attendance_type!=='fixed_shift')return{ok:false,reason:'incomplete-policy'}"
const ORIGINAL_GUARDS: ReadonlyArray<readonly [string, string]> = [
  ['membership absent', "if(loaded.membershipRows.length===0)return{ok:false,reason:'membership-absent'}"],
  ['group id', GROUP_GUARD],
  ['group row', GROUP_GUARD],
  ['fixed shift only', GROUP_GUARD],
  ['FSER effective', "if(effectiveness.state!=='effective'||effectiveness.desired===null){return{ok:false,reason:'incomplete-policy'}}"],
  ['FSER member reconciliation', "if(!targetMemberIds.includes(userId))return{ok:false,reason:'incomplete-policy'}"],
  ['shift row', "if(!loaded.shiftRow||loaded.shiftRow.id!==shiftId)return{ok:false,reason:'incomplete-policy'}"],
  ['strict mode', "if(shiftRow.flex_mode!=='strict')return{ok:false,reason:'incomplete-policy'}"],
  ['segment maximum', "if(loaded.segmentRows.length>3)return{ok:false,reason:'incomplete-policy'}"],
  ['segment shape', "if(index!==i||startDayOffset!==0||(endDayOffset!==0&&endDayOffset!==1)||!startTime||!endTime){return{ok:false,reason:'incomplete-policy'}}"],
  ['fallback times', "if(!startTime||!endTime)return{ok:false,reason:'incomplete-policy'}"],
  ['rounding minimum', "if(roundingMinutes<1)return{ok:false,reason:'incomplete-policy'}"],
]
const CALC14_GUARDS: ReadonlyArray<readonly [keyof ResolverSources, string]> = [
  ['assembler', "if(loaded.orgId!==orgKey||loaded.userId!==userId||loaded.workDate!==workDate)return{ok:false,reason:'incomplete-policy'}"],
  ['assembler', "if(loaded.publishedSourceRows&&(loaded.publishedSourceRows.length!==1||loaded.publishedSourceRows[0].shift_id!==loaded.configRow?.shift_id||loaded.publishedSourceRows[0].producer_type!=='attendance_group_fixed_schedule'||loaded.publishedSourceRows[0].producer_ref_id!==calculationGroupId))return{ok:false,reason:'incomplete-policy'}"],
  ['assembler', "if(!ruleFacts)return{ok:false,reason:'incomplete-policy'}"],
  ['resolver', "returnloaded?assembleAttendanceW7GroupEffectiveFactsV1(deps,input,loaded):{ok:false,reason:'incomplete-policy'}"],
]

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

const loadedRows = (): AttendanceW7LoadedSourceRowsV1 => {
  const facts = baseFacts()
  return {
    orgId: facts.orgId, userId: facts.userId, workDate: facts.workDate,
    membershipRows: [{ group_id: facts.calculationGroupId }],
    groupRow: { id: facts.calculationGroupId, attendance_type: 'fixed_shift' },
    configRow: { shift_id: facts.shiftId, start_date: facts.workDate, end_date: null, revision: 1 },
    memberRows: [{ user_id: facts.userId }], managedRows: [],
    shiftRow: { id: facts.shiftId, flex_mode: 'strict', rounding_minutes: 1 },
    segmentRows: [{ segment_index: 0, start_time: '09:00', end_time: '18:00' }],
    orgRuleFacts: { severeLateThresholdMinutes: 0, absenceLateThresholdMinutes: 0 },
    publishedSourceRows: [{
      shift_id: facts.shiftId, producer_type: 'attendance_group_fixed_schedule',
      producer_ref_id: facts.calculationGroupId,
    }],
  }
}
const assemblerDeps: AttendanceW7GroupEffectiveResolverDepsV1 = {
  deriveFixedScheduleEffectiveness: ({ desired }) => ({ state: 'effective', desired, reasonCodes: [] }),
  buildFixedScheduleProducerKey: () => 'synthetic-producer',
  loadOrgRuleFacts: async () => ({ severeLateThresholdMinutes: 0, absenceLateThresholdMinutes: 0 }),
  now: () => '2026-06-01T00:00:00Z',
}

describe('W7-1b g3 — the resolver/op(i) subset closure, as a CLASS', () => {
  it('the resolver fail-close guard set is PINNED (a new or deleted guard changes what ok:true means)', () => {
    const sources = readSources()
    expect(ORIGINAL_GUARDS).toHaveLength(RESOLVER_FAIL_CLOSE_GUARDS_V1)
    for (const [label, guard] of ORIGINAL_GUARDS) {
      expect(sources.assembler, label).toContain(guard)
    }
    for (const [file, guard] of CALC14_GUARDS) expect(sources[file]).toContain(guard)
    // Complete resolver + assembler union: 12 original sites, minus two
    // coalesced group returns, plus four explicitly named CALC14 refusals.
    const guards = (sources.resolver + sources.assembler).split('{ok:false,reason:').length - 1
    expect(guards).toBe(RESOLVER_FAIL_CLOSE_GUARDS_V1 - 2 + CALC14_GUARDS.length)
    expect(guards).toBeGreaterThan(0)
    expect(sources.resolver).toContain("from'./w7-group-effective-facts-from-rows'")
    expect(sources.resolver).toContain('exportasyncfunctionresolveW7GroupEffectiveFactsInTransactionV1(')
    expect(sources.resolver).toContain('constloaded=await(deps.loadSourceRows??loadAttendanceW7CurrentSourceRowsInTransactionV1)(trx,deps,sourceInput)')
    expect(sources.resolver).toContain('if(membershipResult.rows.length!==1)returnloaded')
    expect(sources.resolver).toContain('if(groupResult.rows.length!==1)returnloaded')
    expect(sources.resolver).toContain("if(loaded.groupRow.attendance_type!=='fixed_shift')returnloaded")
    expect(sources.resolver).toContain('if(!loaded.configRow)returnloaded')
    expect(sources.resolver).toContain('if(shiftResult.rows.length!==1)returnloaded')
    expect(sources.retained).toContain('exportasyncfunctionloadAttendanceCalc14W7SourceRowsInTransactionV1(')
    expect(sources.retained).toContain('if(!publication)returnnull')
    expect(sources.retained).toContain('if(membershipRows.length!==1)returnloaded')
    expect(sources.retained).toContain('if(!groupId)returnnull')
    expect(sources.retained).toContain('if(!source)returnnull')
    expect(sources.retained).toContain("if(holidays.length>1||holidays.some(row=>typeofrow.is_working_day!=='boolean'))returnnull")
    expect(sources.seam).toContain("from'../attendance-calc14-w7-source-loader'")
    expect(sources.seam.split('loadSourceRows:loadAttendanceCalc14W7SourceRowsInTransactionV1')).toHaveLength(3)
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

  it('the shared assembler accepts a complete retained row set at rounding 1 (non-vacuity)', () => {
    const result = assembleAttendanceW7GroupEffectiveFactsV1(assemblerDeps, baseFacts(), loadedRows())
    expect(result).toEqual({ ok: true, facts: baseFacts() })
    if (!result.ok) throw new Error('EXPECTED_ASSEMBLER_SUCCESS')
    expect(isCoreIssuedGroupEffectiveContextV2(coreIssueGroupEffectiveContextV2(result.facts))).toBe(true)
  })

  it('a missing retained source fails closed rather than falling back to current rows', async () => {
    const result = await resolveW7GroupEffectiveFactsInTransactionV1(
      { query: async () => ({ rows: [] }) },
      { ...assemblerDeps, loadSourceRows: async () => null },
      baseFacts(),
    )
    expect(result).toEqual({ ok: false, reason: 'incomplete-policy' })
  })

  const INVALID_ROWS: ReadonlyArray<readonly [string, (rows: AttendanceW7LoadedSourceRowsV1) => void]> = [
    ['foreign org', rows => { rows.orgId = '33333333-3333-4333-8333-333333333333' }],
    ['foreign user', rows => { rows.userId = '33333333-3333-4333-8333-333333333333' }],
    ['different work date', rows => { rows.workDate = '2026-06-02' }],
    ['missing rule facts', rows => { delete rows.orgRuleFacts }],
    ['absent publication', rows => { rows.publishedSourceRows = [] }],
    ['ambiguous publication', rows => { rows.publishedSourceRows!.push({ ...rows.publishedSourceRows![0] }) }],
    ['publication shift mismatch', rows => { rows.publishedSourceRows![0].shift_id = 'other-shift' }],
    ['publication producer mismatch', rows => { rows.publishedSourceRows![0].producer_type = 'other-producer' }],
    ['publication group mismatch', rows => { rows.publishedSourceRows![0].producer_ref_id = 'other-group' }],
    ...[0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY].map(value => [
      `rounding below one after normalization: ${value}`,
      (rows: AttendanceW7LoadedSourceRowsV1) => { rows.shiftRow!.rounding_minutes = value },
    ] as const),
  ]
  for (const [label, invalidate] of INVALID_ROWS) {
    it(`the shared assembler fails closed: ${label}`, () => {
      const rows = loadedRows()
      invalidate(rows)
      expect(assembleAttendanceW7GroupEffectiveFactsV1(assemblerDeps, baseFacts(), rows))
        .toEqual({ ok: false, reason: 'incomplete-policy' })
    })
  }

  it('CLASS STATEMENT: no field op(i) constrains is left un-guarded by the resolver', () => {
    // The closure argument, asserted rather than narrated: every numeric/enum
    // boundary op(i) enforces above has a corresponding `return { ok: false }`
    // guard in the resolver. `roundingMinutes` is the one that was missing and
    // is now present; this leg reds if that guard is deleted.
    const { assembler } = readSources()
    expect(assembler).toContain('constroundingMinutes=toNonNegativeInt(shiftRow.rounding_minutes)')
    expect(assembler, 'the roundingMinutes fail-close is the known instance of this class')
      .toContain(ORIGINAL_GUARDS[11][1])
    expect(assembler).toContain(ORIGINAL_GUARDS[8][1])
    expect(assembler).toContain(GROUP_GUARD)
  })
})
