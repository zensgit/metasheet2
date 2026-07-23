/**
 * W2 / #4556 — shared AttendanceWorkDateResolver unit coverage.
 *
 * Mutation-sensitive: each named leg below must fail if the corresponding
 * contract regression is reintroduced (grace-as-tail, row-order winner,
 * nullable shiftId, calendar fallback on ambiguity, etc.).
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const attendancePlugin = require('../../../../plugins/plugin-attendance/index.cjs')
const helpers = attendancePlugin.__attendanceWorkDateResolverForTests as {
  lib: typeof import('../../../../plugins/plugin-attendance/lib/attendance-work-date-resolver.cjs')
  adaptersLib: typeof import('../../../../plugins/plugin-attendance/lib/attendance-work-date-adapters.cjs')
  DEFAULT_ATTRIBUTION_TAIL_MINUTES: number
  OVERTIME_ATTRIBUTION_KEY: string
  FROZEN_ATTRIBUTION_KEY: string
  OVERTIME_ATTRIBUTION_SNAPSHOT_REQUIRED: string
  WORK_DATE_REASON: Record<string, string>
  parseOvertimeAttributionV1: (raw: unknown) => unknown
  buildOvertimeAttributionV1: (raw: Record<string, unknown>) => Record<string, unknown>
  normalizeWorkDateAttributionSetting: (raw: unknown) => { postShiftTailMinutes: number }
  clampAttributionTailMinutes: (value: unknown, fallback?: number) => number
}

const {
  createAttendanceWorkDateResolver,
  buildAbsoluteWindow,
  buildAttributionWindow,
  isInstantInWindow,
  selectAmongMatchingCandidates,
  selectSinglePublishedCandidateForOvertime,
  anchorsEqual,
  REASON,
  DEFAULT_ATTRIBUTION_TAIL_MINUTES,
  MAX_ATTRIBUTION_TAIL_MINUTES,
  OVERTIME_ATTRIBUTION_KEY,
} = helpers.lib

const { createAllWorkDateAdapters, OVERTIME_ATTRIBUTION_SNAPSHOT_REQUIRED } = helpers.adaptersLib
const pluginSource = readFileSync(
  new URL('../../../../plugins/plugin-attendance/index.cjs', import.meta.url),
  'utf8',
)

function addDays(dateKey: string, days: number) {
  const d = new Date(`${dateKey}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** Treat wall-clock as UTC for deterministic unit tests (no real TZ DB). */
function buildZonedDate(date: string, time: string, _tz: string) {
  const [h, m] = time.split(':').map(Number)
  return new Date(Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
    h,
    m,
    0,
  ))
}

function toWorkDate(value: Date, _tz: string) {
  return value.toISOString().slice(0, 10)
}

function overnightCandidate(workDate: string, overrides: Record<string, unknown> = {}) {
  const absoluteWindow = buildAbsoluteWindow({
    workDate,
    workStartTime: '22:00',
    workEndTime: '06:00',
    timezone: 'UTC',
    isOvernight: true,
    buildZonedDate,
    addDaysToDateKey: addDays,
  })!
  const attributionWindow = buildAttributionWindow(absoluteWindow, {
    attributionTailMinutes: DEFAULT_ATTRIBUTION_TAIL_MINUTES,
    orgId: 'org-a',
    userId: 'user-a',
    workDate,
    shiftId: 'shift-night',
  })!
  return {
    orgId: 'org-a',
    userId: 'user-a',
    workDate,
    shiftId: 'shift-night',
    segmentIndex: null,
    absoluteWindow,
    attributionWindow,
    source: 'shift' as const,
    assignmentId: 'asg-night',
    isOvernight: true,
    extendedByOvertime: false,
    ...overrides,
  }
}

function dayCandidate(workDate: string, start: string, end: string, overrides: Record<string, unknown> = {}) {
  const absoluteWindow = buildAbsoluteWindow({
    workDate,
    workStartTime: start,
    workEndTime: end,
    timezone: 'UTC',
    isOvernight: false,
    buildZonedDate,
    addDaysToDateKey: addDays,
  })!
  const attributionWindow = buildAttributionWindow(absoluteWindow, {
    attributionTailMinutes: DEFAULT_ATTRIBUTION_TAIL_MINUTES,
    orgId: 'org-a',
    userId: 'user-a',
    workDate,
    shiftId: String(overrides.shiftId || 'shift-day'),
  })!
  return {
    orgId: 'org-a',
    userId: 'user-a',
    workDate,
    shiftId: 'shift-day',
    segmentIndex: null,
    absoluteWindow,
    attributionWindow,
    source: 'shift' as const,
    assignmentId: 'asg-day',
    isOvernight: false,
    extendedByOvertime: false,
    ...overrides,
  }
}

function createResolver(loadPublishedCandidates: (args: unknown) => Promise<unknown[]>, extra: Record<string, unknown> = {}) {
  return createAttendanceWorkDateResolver({
    toWorkDate,
    buildZonedDate,
    addDaysToDateKey: addDays,
    normalizeTimeString: (v: string) => v,
    resolveOvernightFlag: (explicit: unknown, start: string, end: string) =>
      explicit === true || start > end,
    loadPublishedCandidates,
    loadOpenRecords: extra.loadOpenRecords || (async () => []),
    loadApprovedOvertimeWindows: extra.loadApprovedOvertimeWindows || (async () => []),
    getAttributionTailMinutes: extra.getAttributionTailMinutes || (async () => DEFAULT_ATTRIBUTION_TAIL_MINUTES),
  })
}

describe('W2 AttendanceWorkDateResolver — settings & contract primitives', () => {
  it('defaults attribution tail to 120 and never clamps grace into the setting', () => {
    expect(helpers.DEFAULT_ATTRIBUTION_TAIL_MINUTES).toBe(120)
    expect(helpers.normalizeWorkDateAttributionSetting({})).toEqual({ postShiftTailMinutes: 120 })
    expect(helpers.normalizeWorkDateAttributionSetting({ postShiftTailMinutes: 30 })).toEqual({
      postShiftTailMinutes: 30,
    })
    // MUTATION: grace must not be readable as the attribution tail setting
    expect(
      helpers.normalizeWorkDateAttributionSetting({ lateGraceMinutes: 10, earlyGraceMinutes: 10 } as never),
    ).toEqual({ postShiftTailMinutes: 120 })
  })

  it('buildAttributionWindow ignores grace-like fields and only uses bounded tail', () => {
    const abs = {
      startAt: new Date('2026-07-15T09:00:00.000Z'),
      endAt: new Date('2026-07-15T18:00:00.000Z'),
    }
    const withTail = buildAttributionWindow(abs, { attributionTailMinutes: 120 })!
    expect(withTail.endAt.toISOString()).toBe('2026-07-15T20:00:00.000Z')
    // MUTATION: if grace were applied, 30 min would shrink the tail
    const notGrace = buildAttributionWindow(abs, {
      attributionTailMinutes: 120,
      lateGraceMinutes: 30,
      earlyGraceMinutes: 30,
    } as never)!
    expect(notGrace.endAt.toISOString()).toBe('2026-07-15T20:00:00.000Z')
  })

  it('clamps the attribution tail at 360 minutes', () => {
    expect(MAX_ATTRIBUTION_TAIL_MINUTES).toBe(360)
    expect(helpers.clampAttributionTailMinutes(361)).toBe(360)
    expect(helpers.clampAttributionTailMinutes(1440)).toBe(360)
  })

  it('resolved result requires non-null shiftId (hard stop — no nullable widen)', () => {
    expect(() =>
      helpers.lib.resolvedResult({
        workDate: '2026-07-15',
        shiftId: null as never,
        reasonCode: 'X',
      }),
    ).toThrow(/non-null/)
  })

  it('cannot construct or freeze a non-null W2 segment identity', () => {
    expect(() =>
      helpers.lib.resolvedResult({
        workDate: '2026-07-15',
        shiftId: 'shift-segmented',
        segmentIndex: 1,
        reasonCode: 'X',
      }),
    ).toThrow(/null segmentIndex/)

    const forgedResolved = {
      kind: 'resolved',
      workDate: '2026-07-15',
      shiftId: 'shift-segmented',
      segmentIndex: 1,
      reasonCode: 'X',
      evidenceSnapshot: null,
    }
    const frozen = helpers.lib.buildFrozenWorkDateAttribution(forgedResolved, {
      orgId: 'org-a',
      userId: 'user-a',
    })
    expect(frozen).toBeNull()
    expect(helpers.lib.parseFrozenWorkDateAttribution(frozen)).toBeNull()
  })
})

describe('W2 overlap precedence (OD-4556-8) + #4558 fold', () => {
  it('open previous-night record wins over current-day containing shift', () => {
    const calendar = '2026-07-16'
    const previous = overnightCandidate('2026-07-15')
    const current = dayCandidate('2026-07-16', '06:00', '14:00', {
      shiftId: 'shift-morning',
      assignmentId: 'asg-morning',
    })
    // Exact boundary overlap at 06:00 UTC on D+1
    const overlap = new Date('2026-07-16T06:00:00.000Z')
    expect(isInstantInWindow(overlap, previous.absoluteWindow)).toBe(true)
    expect(isInstantInWindow(overlap, current.absoluteWindow)).toBe(true)

    const result = selectAmongMatchingCandidates({
      matching: [previous, current],
      occurredAt: overlap,
      calendarWorkDate: calendar,
      openRecords: [{
        orgId: 'org-a',
        userId: 'user-a',
        workDate: '2026-07-15',
        firstInAt: new Date('2026-07-15T22:05:00.000Z'),
        lastOutAt: null,
      }],
      attributionTailMinutes: 120,
      orgId: 'org-a',
      userId: 'user-a',
    })
    expect(result.kind).toBe('resolved')
    if (result.kind === 'resolved') {
      expect(result.workDate).toBe('2026-07-15')
      expect(result.shiftId).toBe('shift-night')
      expect(result.reasonCode).toBe(REASON.OPEN_PREVIOUS_NIGHT_RECORD)
    }
  })

  it('without open previous-night record, current-day containing shift wins', () => {
    const calendar = '2026-07-16'
    const previous = overnightCandidate('2026-07-15')
    const current = dayCandidate('2026-07-16', '06:00', '14:00', {
      shiftId: 'shift-morning',
      assignmentId: 'asg-morning',
    })
    const overlap = new Date('2026-07-16T06:00:00.000Z')
    const result = selectAmongMatchingCandidates({
      matching: [previous, current],
      occurredAt: overlap,
      calendarWorkDate: calendar,
      openRecords: [],
      attributionTailMinutes: 120,
    })
    expect(result.kind).toBe('resolved')
    if (result.kind === 'resolved') {
      expect(result.workDate).toBe('2026-07-16')
      expect(result.shiftId).toBe('shift-morning')
      expect(result.reasonCode).toBe(REASON.CURRENT_DAY_CONTAINING_SHIFT)
    }
  })

  it('ignores a foreign org/user open record instead of granting previous-night precedence', () => {
    const previous = overnightCandidate('2026-07-15')
    const current = dayCandidate('2026-07-16', '06:00', '14:00', {
      shiftId: 'shift-morning',
      assignmentId: 'asg-morning',
    })
    const result = selectAmongMatchingCandidates({
      matching: [previous, current],
      occurredAt: new Date('2026-07-16T06:00:00.000Z'),
      calendarWorkDate: '2026-07-16',
      openRecords: [{
        orgId: 'org-foreign',
        userId: 'user-foreign',
        workDate: '2026-07-15',
        firstInAt: new Date('2026-07-15T22:05:00.000Z'),
        lastOutAt: null,
      }],
      attributionTailMinutes: 120,
      orgId: 'org-a',
      userId: 'user-a',
    })
    expect(result).toMatchObject({
      kind: 'resolved',
      workDate: '2026-07-16',
      shiftId: 'shift-morning',
      reasonCode: REASON.CURRENT_DAY_CONTAINING_SHIFT,
    })
  })

  it('does not give previous-night precedence to an ordinary day shift with an open record', () => {
    const previousDay = dayCandidate('2026-07-15', '04:00', '08:00', {
      shiftId: 'shift-ordinary',
      assignmentId: 'asg-ordinary',
    })
    const current = dayCandidate('2026-07-16', '06:00', '14:00', {
      shiftId: 'shift-current',
      assignmentId: 'asg-current',
    })
    const overlap = new Date('2026-07-16T06:30:00.000Z')
    previousDay.attributionWindow = {
      startAt: new Date('2026-07-16T06:00:00.000Z'),
      endAt: new Date('2026-07-16T07:00:00.000Z'),
    }
    const result = selectAmongMatchingCandidates({
      matching: [previousDay, current],
      occurredAt: overlap,
      calendarWorkDate: '2026-07-16',
      openRecords: [{
        orgId: 'org-a',
        userId: 'user-a',
        workDate: '2026-07-15',
        firstInAt: new Date('2026-07-15T04:00:00.000Z'),
        lastOutAt: null,
      }],
      attributionTailMinutes: 120,
      orgId: 'org-a',
      userId: 'user-a',
    })
    expect(result.kind).toBe('resolved')
    expect(result.workDate).toBe('2026-07-16')
    expect(result.shiftId).toBe('shift-current')
  })

  it('actionable ambiguity when two current-day slots both contain the punch (no row-order)', () => {
    const a = dayCandidate('2026-07-15', '08:00', '12:00', { shiftId: 's-am', assignmentId: 'a1' })
    const b = dayCandidate('2026-07-15', '08:30', '12:30', { shiftId: 's-overlap', assignmentId: 'a2' })
    const punch = new Date('2026-07-15T09:00:00.000Z')
    const result = selectAmongMatchingCandidates({
      matching: [a, b],
      occurredAt: punch,
      calendarWorkDate: '2026-07-15',
      openRecords: [],
      attributionTailMinutes: 120,
    })
    expect(result.kind).toBe('ambiguous')
    if (result.kind === 'ambiguous') {
      expect(result.candidates).toHaveLength(2)
      expect(result.reasonCode).toBe(REASON.OVERLAPPING_SHIFT_WINDOWS)
      expect(Object.keys(result.candidates[0]).sort()).toEqual([
        'absoluteWindow',
        'segmentIndex',
        'shiftId',
        'workDate',
      ])
      expect(result.candidates.map((candidate: { shiftId: string }) => candidate.shiftId)).toEqual([
        's-am',
        's-overlap',
      ])
    }

    const reversed = selectAmongMatchingCandidates({
      matching: [b, a],
      occurredAt: punch,
      calendarWorkDate: '2026-07-15',
      openRecords: [],
      attributionTailMinutes: 120,
    })
    expect(reversed).toEqual(result)
  })

  it('previous overnight alone re-anchors post-midnight punch (#4558 fold)', () => {
    const previous = overnightCandidate('2026-07-15')
    const checkOut = new Date('2026-07-16T05:55:00.000Z')
    expect(isInstantInWindow(checkOut, previous.absoluteWindow)).toBe(true)
    const result = selectAmongMatchingCandidates({
      matching: [previous],
      occurredAt: checkOut,
      calendarWorkDate: '2026-07-16',
      openRecords: [],
      attributionTailMinutes: 120,
    })
    expect(result.kind).toBe('resolved')
    if (result.kind === 'resolved') {
      expect(result.workDate).toBe('2026-07-15')
      expect(result.reasonCode).toBe(REASON.PREVIOUS_NIGHT_CONTAINING_SHIFT)
    }
  })

  it('post-shift attribution tail (120) matches after end; grace does not', () => {
    const day = dayCandidate('2026-07-15', '09:00', '18:00')
    const inTail = new Date('2026-07-15T19:30:00.000Z') // 90 min after end
    const beyondTail = new Date('2026-07-15T20:30:00.000Z') // 150 min after end
    expect(isInstantInWindow(inTail, day.absoluteWindow)).toBe(false)
    expect(isInstantInWindow(inTail, day.attributionWindow)).toBe(true)
    expect(isInstantInWindow(beyondTail, day.attributionWindow)).toBe(false)
  })
})

describe('W2 free_time / unscheduled / explicit-import hard stop', () => {
  it('free_time returns FREE_TIME_NO_SHIFT and never invents shiftId', async () => {
    const resolver = createResolver(async () => [{
      orgId: 'org-a',
      userId: 'user-a',
      workDate: '2026-07-15',
      shiftId: 'should-not-be-used',
      assignmentId: 'x',
      source: 'shift',
      workStartTime: '09:00',
      workEndTime: '18:00',
      timezone: 'UTC',
    }])
    const result = await resolver.resolve({
      orgId: 'org-a',
      userId: 'user-a',
      occurredAt: new Date('2026-07-15T10:00:00.000Z'),
      timezone: 'UTC',
      channel: 'live',
      groupAttendanceType: 'free_time',
    })
    expect(result.kind).toBe('unresolved')
    if (result.kind === 'unresolved') {
      expect(result.reasonCode).toBe(REASON.FREE_TIME_NO_SHIFT)
      expect(String(result.evidenceSnapshot?.contractConflict || '')).toMatch(/non-null/)
    }
  })

  it('unscheduled (no published candidates) returns UNSCHEDULED_NO_SHIFT', async () => {
    const resolver = createResolver(async () => [])
    const result = await resolver.resolve({
      orgId: 'org-a',
      userId: 'user-a',
      occurredAt: new Date('2026-07-15T10:00:00.000Z'),
      timezone: 'UTC',
      channel: 'live',
    })
    expect(result.kind).toBe('unresolved')
    if (result.kind === 'unresolved') {
      expect(result.reasonCode).toBe(REASON.UNSCHEDULED_NO_SHIFT)
    }
  })

  it('explicit-import workDate-only refuses resolved without shiftId', async () => {
    const resolver = createResolver(async () => [])
    const result = await resolver.resolve({
      orgId: 'org-a',
      userId: 'user-a',
      occurredAt: new Date('2026-07-15T10:00:00.000Z'),
      timezone: 'UTC',
      channel: 'import',
      explicitWorkDate: '2026-07-15',
      explicitWorkDateOnly: true,
    })
    expect(result.kind).toBe('unresolved')
    if (result.kind === 'unresolved') {
      expect(result.reasonCode).toBe(REASON.EXPLICIT_IMPORT_REQUIRES_SHIFT)
    }
  })

  it('cross-org candidate fails closed as MALFORMED_CROSS_ORG_REFERENCE', async () => {
    const resolver = createResolver(async () => [{
      orgId: 'org-foreign',
      userId: 'user-a',
      workDate: '2026-07-15',
      shiftId: 'shift-x',
      assignmentId: 'asg-x',
      source: 'shift',
      workStartTime: '09:00',
      workEndTime: '18:00',
      timezone: 'UTC',
    }])
    const result = await resolver.resolve({
      orgId: 'org-a',
      userId: 'user-a',
      occurredAt: new Date('2026-07-15T10:00:00.000Z'),
      timezone: 'UTC',
      channel: 'live',
    })
    expect(result.kind).toBe('unresolved')
    if (result.kind === 'unresolved') {
      expect(result.reasonCode).toBe(REASON.MALFORMED_CROSS_ORG_REFERENCE)
    }
  })

  it('cross-user candidate fails closed as MALFORMED_CROSS_USER_REFERENCE', async () => {
    const resolver = createResolver(async () => [{
      orgId: 'org-a',
      userId: 'user-foreign',
      workDate: '2026-07-15',
      shiftId: 'shift-x',
      assignmentId: 'asg-x',
      source: 'shift',
      workStartTime: '09:00',
      workEndTime: '18:00',
      timezone: 'UTC',
    }])
    const result = await resolver.resolve({
      orgId: 'org-a',
      userId: 'user-a',
      occurredAt: new Date('2026-07-15T10:00:00.000Z'),
      timezone: 'UTC',
      channel: 'live',
    })
    expect(result.kind).toBe('unresolved')
    expect(result.reasonCode).toBe(REASON.MALFORMED_CROSS_USER_REFERENCE)
  })
})

describe('W2 frozen attribution on correction/recompute', () => {
  it('correction preserves frozen attribution even when schedule candidates change', async () => {
    const resolver = createResolver(async () => [{
      orgId: 'org-a',
      userId: 'user-a',
      workDate: '2026-07-16',
      shiftId: 'shift-new',
      assignmentId: 'asg-new',
      source: 'shift',
      workStartTime: '09:00',
      workEndTime: '18:00',
      timezone: 'UTC',
    }])
    const adapters = createAllWorkDateAdapters(resolver)
    const result = await adapters.correction.resolveCorrectionWorkDate({
      orgId: 'org-a',
      userId: 'user-a',
      occurredAt: new Date('2026-07-16T10:00:00.000Z'),
      timezone: 'UTC',
      frozenAttribution: {
        version: 1,
        orgId: 'org-a',
        userId: 'user-a',
        workDate: '2026-07-15',
        shiftId: 'shift-frozen',
        segmentIndex: null,
        reasonCode: 'OPEN_PREVIOUS_NIGHT_RECORD',
        evidenceSnapshot: { frozen: true },
      },
    })
    expect(result.kind).toBe('resolved')
    if (result.kind === 'resolved') {
      expect(result.workDate).toBe('2026-07-15')
      expect(result.shiftId).toBe('shift-frozen')
      expect(result.reasonCode).toBe(REASON.FROZEN_ATTRIBUTION)
    }
  })

  it('recompute preserves frozen attribution (schedule mutation after request)', async () => {
    const resolver = createResolver(async () => [])
    const adapters = createAllWorkDateAdapters(resolver)
    const result = await adapters.recompute.resolveRecomputeWorkDate({
      orgId: 'org-a',
      userId: 'user-a',
      occurredAt: new Date('2026-07-15T10:00:00.000Z'),
      timezone: 'UTC',
      recordMeta: {
        workDateAttributionV1: {
          version: 1,
          orgId: 'org-a',
          userId: 'user-a',
          workDate: '2026-07-15',
          shiftId: 'shift-original',
          reasonCode: 'CURRENT_DAY_CONTAINING_SHIFT',
        },
      },
    })
    expect(result.kind).toBe('resolved')
    if (result.kind === 'resolved') {
      expect(result.shiftId).toBe('shift-original')
      expect(result.reasonCode).toBe(REASON.FROZEN_ATTRIBUTION)
    }
  })

  it('fails closed instead of re-resolving an invalid or foreign frozen snapshot', async () => {
    const resolver = createResolver(async () => [{
      orgId: 'org-a',
      userId: 'user-a',
      workDate: '2026-07-16',
      shiftId: 'shift-new',
      assignmentId: 'asg-new',
      source: 'shift',
      workStartTime: '09:00',
      workEndTime: '18:00',
      timezone: 'UTC',
    }])
    await expect(resolver.resolve({
      orgId: 'org-a',
      userId: 'user-a',
      occurredAt: new Date('2026-07-16T10:00:00.000Z'),
      timezone: 'UTC',
      channel: 'correction',
      frozenAttribution: {
        workDate: '2026-07-15',
        shiftId: 'legacy-unversioned',
      },
    })).rejects.toThrow('FROZEN_ATTRIBUTION_INVALID')

    await expect(resolver.resolve({
      orgId: 'org-a',
      userId: 'user-a',
      occurredAt: new Date('2026-07-16T10:00:00.000Z'),
      timezone: 'UTC',
      channel: 'recompute',
      frozenAttribution: {
        version: 1,
        orgId: 'org-b',
        userId: 'user-a',
        workDate: '2026-07-15',
        shiftId: 'foreign-shift',
      },
    })).rejects.toThrow('FROZEN_ATTRIBUTION_IDENTITY_MISMATCH')
  })

  it('preserves a valid frozen attribution before evaluating current timezone drift', async () => {
    const resolver = createResolver(async () => {
      throw new Error('candidate loader must not run for frozen attribution')
    })
    const result = await resolver.resolve({
      orgId: 'org-a',
      userId: 'user-a',
      timezone: 'Invalid/Zone',
      channel: 'correction',
      frozenAttribution: {
        version: 1,
        orgId: 'org-a',
        userId: 'user-a',
        workDate: '2026-07-15',
        shiftId: 'shift-frozen',
        segmentIndex: null,
        reasonCode: 'CURRENT_DAY_CONTAINING_SHIFT',
      },
    })
    expect(result).toMatchObject({
      kind: 'resolved',
      workDate: '2026-07-15',
      shiftId: 'shift-frozen',
      reasonCode: REASON.FROZEN_ATTRIBUTION,
    })
  })
})

describe('W2 resolver source failures', () => {
  const base = {
    orgId: 'org-a',
    userId: 'user-a',
    occurredAt: new Date('2026-07-15T10:00:00.000Z'),
    timezone: 'UTC',
    channel: 'live',
  }

  it('propagates candidate, settings, overtime, and open-record source failures', async () => {
    const candidatesFail = createResolver(async () => {
      throw new Error('candidate-db-down')
    })
    await expect(candidatesFail.resolve(base)).rejects.toThrow('candidate-db-down')

    const settingsFail = createResolver(async () => [], {
      getAttributionTailMinutes: async () => {
        throw new Error('settings-db-down')
      },
    })
    await expect(settingsFail.resolve(base)).rejects.toThrow('settings-db-down')

    const overtimeFail = createResolver(async () => [{
      orgId: 'org-a',
      userId: 'user-a',
      workDate: '2026-07-15',
      shiftId: 'shift-day',
      assignmentId: 'asg-day',
      source: 'shift',
      workStartTime: '09:00',
      workEndTime: '18:00',
      timezone: 'UTC',
    }], {
      loadApprovedOvertimeWindows: async () => {
        throw new Error('overtime-db-down')
      },
    })
    await expect(overtimeFail.resolve(base)).rejects.toThrow('overtime-db-down')

    const openFail = createResolver(async () => [{
      orgId: 'org-a',
      userId: 'user-a',
      workDate: '2026-07-15',
      shiftId: 'shift-day',
      assignmentId: 'asg-day',
      source: 'shift',
      workStartTime: '09:00',
      workEndTime: '18:00',
      timezone: 'UTC',
    }], {
      loadOpenRecords: async () => {
        throw new Error('records-db-down')
      },
    })
    await expect(openFail.resolve(base)).rejects.toThrow('records-db-down')
  })
})

describe('W2 production write-path wiring', () => {
  it('routes all four import writers through the shared guard and freezes its result', () => {
    expect(
      pluginSource.match(/const importAttribution = await resolveImportRowWorkDateAttribution\(\{/g),
    ).toHaveLength(4)
    expect(
      pluginSource.match(/meta\[FROZEN_ATTRIBUTION_KEY\] = importAttribution\.frozenAttribution/g),
    ).toHaveLength(4)

    const routeSlices = [
      pluginSource.slice(
        pluginSource.indexOf("'/api/attendance/import/commit'"),
        pluginSource.indexOf("'/api/attendance/import'"),
      ),
      pluginSource.slice(
        pluginSource.indexOf("'/api/attendance/import'"),
        pluginSource.indexOf("'/api/attendance/integrations'"),
      ),
      pluginSource.slice(
        pluginSource.indexOf("'/api/attendance/integrations/:id/sync'"),
      ),
      pluginSource.slice(
        pluginSource.indexOf('const processAsyncImportCommitJob = async'),
        pluginSource.indexOf("'/api/attendance/import/commit'"),
      ),
    ]
    for (const slice of routeSlices) {
      expect(slice).toContain('resolveImportRowWorkDateAttribution({')
      expect(slice).toContain('meta[FROZEN_ATTRIBUTION_KEY] = importAttribution.frozenAttribution')
    }
  })
})

describe('W2 overtimeAttributionV1 freeze / legacy / extend', () => {
  it('freezes versioned anchor from exactly one published candidate', async () => {
    const resolver = createResolver(async () => [{
      orgId: 'org-a',
      userId: 'user-a',
      workDate: '2026-07-15',
      shiftId: 'shift-day',
      assignmentId: 'asg-1',
      source: 'shift',
      workStartTime: '09:00',
      workEndTime: '18:00',
      timezone: 'UTC',
    }])
    const adapters = createAllWorkDateAdapters(resolver)
    const freeze = await adapters.overtime.freezeRequestCreationAnchor({
      orgId: 'org-a',
      userId: 'user-a',
      workDate: '2026-07-15',
    })
    expect(freeze.ok).toBe(true)
    expect(freeze.anchor).toEqual({
      version: 1,
      orgId: 'org-a',
      userId: 'user-a',
      workDate: '2026-07-15',
      shiftId: 'shift-day',
      source: 'shift',
      assignmentId: 'asg-1',
    })
  })

  it('refuses multi-candidate freeze (no row-order inference)', async () => {
    const resolver = createResolver(async () => [
      {
        orgId: 'org-a',
        userId: 'user-a',
        workDate: '2026-07-15',
        shiftId: 's1',
        assignmentId: 'a1',
        source: 'shift',
        workStartTime: '08:00',
        workEndTime: '12:00',
        timezone: 'UTC',
      },
      {
        orgId: 'org-a',
        userId: 'user-a',
        workDate: '2026-07-15',
        shiftId: 's2',
        assignmentId: 'a2',
        source: 'shift',
        workStartTime: '13:00',
        workEndTime: '17:00',
        timezone: 'UTC',
      },
    ])
    const adapters = createAllWorkDateAdapters(resolver)
    const freeze = await adapters.overtime.freezeRequestCreationAnchor({
      orgId: 'org-a',
      userId: 'user-a',
      workDate: '2026-07-15',
    })
    expect(freeze.ok).toBe(false)
    expect(freeze.result.kind).toBe('ambiguous')
  })

  it('legacy pending without anchor fails OVERTIME_ATTRIBUTION_SNAPSHOT_REQUIRED', () => {
    const resolver = createResolver(async () => [])
    const adapters = createAllWorkDateAdapters(resolver)
    const check = adapters.overtime.preserveOrRequirePendingAnchor({})
    expect(check.ok).toBe(false)
    expect(check.code).toBe(OVERTIME_ATTRIBUTION_SNAPSHOT_REQUIRED)
    expect(check.code).toBe(helpers.OVERTIME_ATTRIBUTION_SNAPSHOT_REQUIRED)
  })

  it('pending update preserves existing anchor', () => {
    const resolver = createResolver(async () => [])
    const adapters = createAllWorkDateAdapters(resolver)
    const anchor = helpers.buildOvertimeAttributionV1({
      orgId: 'org-a',
      userId: 'user-a',
      workDate: '2026-07-15',
      shiftId: 'shift-day',
      source: 'shift',
      assignmentId: 'asg-1',
    })
    const check = adapters.overtime.preserveOrRequirePendingAnchor({
      [OVERTIME_ATTRIBUTION_KEY]: anchor,
    })
    expect(check.ok).toBe(true)
    expect(check.preserved).toBe(true)
    expect(check.anchor).toEqual(anchor)
  })

  it('legacy approved without anchor never extends attribution window', () => {
    const abs = {
      startAt: new Date('2026-07-15T09:00:00.000Z'),
      endAt: new Date('2026-07-15T18:00:00.000Z'),
    }
    const withLegacyOt = buildAttributionWindow(abs, {
      attributionTailMinutes: 120,
      orgId: 'org-a',
      userId: 'user-a',
      workDate: '2026-07-15',
      shiftId: 'shift-day',
      approvedOvertimeWindows: [{
        orgId: 'org-a',
        userId: 'user-a',
        workDate: '2026-07-15',
        shiftId: 'shift-day',
        approvedEndAt: new Date('2026-07-15T22:00:00.000Z'),
        anchor: null, // legacy
      }],
    })!
    // Only base end + 120 tail — not 22:00 + 120
    expect(withLegacyOt.endAt.toISOString()).toBe('2026-07-15T20:00:00.000Z')
  })

  it('approved OT with matching frozen anchor extends only same org/user/workDate/shift', () => {
    const abs = {
      startAt: new Date('2026-07-15T09:00:00.000Z'),
      endAt: new Date('2026-07-15T18:00:00.000Z'),
    }
    const anchor = helpers.buildOvertimeAttributionV1({
      orgId: 'org-a',
      userId: 'user-a',
      workDate: '2026-07-15',
      shiftId: 'shift-day',
      source: 'shift',
      assignmentId: 'asg-1',
    })
    const extended = buildAttributionWindow(abs, {
      attributionTailMinutes: 120,
      orgId: 'org-a',
      userId: 'user-a',
      workDate: '2026-07-15',
      shiftId: 'shift-day',
      approvedOvertimeWindows: [{
        orgId: 'org-a',
        userId: 'user-a',
        workDate: '2026-07-15',
        shiftId: 'shift-day',
        approvedEndAt: new Date('2026-07-15T22:00:00.000Z'),
        anchor,
      }],
    })!
    expect(extended.endAt.toISOString()).toBe('2026-07-16T00:00:00.000Z') // 22:00 + 120

    const wrongShift = buildAttributionWindow(abs, {
      attributionTailMinutes: 120,
      orgId: 'org-a',
      userId: 'user-a',
      workDate: '2026-07-15',
      shiftId: 'shift-other',
      approvedOvertimeWindows: [{
        orgId: 'org-a',
        userId: 'user-a',
        workDate: '2026-07-15',
        shiftId: 'shift-day',
        approvedEndAt: new Date('2026-07-15T22:00:00.000Z'),
        anchor,
      }],
    })!
    expect(wrongShift.endAt.toISOString()).toBe('2026-07-15T20:00:00.000Z')
  })

  it('canExtendAttributionWindow copies/compares frozen anchor identity', () => {
    const resolver = createResolver(async () => [])
    const adapters = createAllWorkDateAdapters(resolver)
    const anchor = helpers.buildOvertimeAttributionV1({
      orgId: 'org-a',
      userId: 'user-a',
      workDate: '2026-07-15',
      shiftId: 'shift-day',
      source: 'rotation',
      assignmentId: 'rot-1',
    })
    const ok = adapters.overtime.canExtendAttributionWindow({
      request: { orgId: 'org-a', userId: 'user-a', workDate: '2026-07-15', metadata: { [OVERTIME_ATTRIBUTION_KEY]: anchor } },
      candidate: { orgId: 'org-a', userId: 'user-a', workDate: '2026-07-15', shiftId: 'shift-day' },
      anchor,
    })
    expect(ok.ok).toBe(true)

    const legacy = adapters.overtime.canExtendAttributionWindow({
      request: { orgId: 'org-a', userId: 'user-a', workDate: '2026-07-15', metadata: {} },
      candidate: { orgId: 'org-a', userId: 'user-a', workDate: '2026-07-15', shiftId: 'shift-day' },
      anchor: null,
    })
    expect(legacy.ok).toBe(false)
    expect(legacy.reason).toBe('LEGACY_APPROVED_NO_ANCHOR')
  })
})

describe('W2 adversarial identity and input boundaries', () => {
  it('does not derive a calendar date from an instant when timezone is missing', async () => {
    let candidateLoads = 0
    const resolver = createResolver(async () => {
      candidateLoads += 1
      return []
    })
    const result = await resolver.resolve({
      orgId: 'org-a',
      userId: 'user-a',
      occurredAt: new Date('2026-07-15T16:30:00.000Z'),
      channel: 'live',
    })
    expect(result).toMatchObject({ kind: 'unresolved', reasonCode: REASON.INVALID_INPUT })
    expect(candidateLoads).toBe(0)
  })

  it('rejects a loader that ignores an explicit import shift id', async () => {
    const resolver = createResolver(async () => [{
      orgId: 'org-a',
      userId: 'user-a',
      workDate: '2026-07-15',
      shiftId: 'different-shift',
      assignmentId: 'different-assignment',
      source: 'shift',
      workStartTime: '09:00',
      workEndTime: '18:00',
      timezone: 'UTC',
    }])
    const result = await resolver.resolve({
      orgId: 'org-a',
      userId: 'user-a',
      occurredAt: new Date('2026-07-15T10:00:00.000Z'),
      timezone: 'UTC',
      calendarWorkDate: '2026-07-15',
      explicitWorkDate: '2026-07-15',
      explicitShiftId: 'claimed-shift',
      channel: 'import',
    })
    expect(result).toMatchObject({
      kind: 'unresolved',
      reasonCode: REASON.EXPLICIT_SHIFT_MISMATCH,
    })
  })

  it('rejects an unknown candidate source instead of rewriting it as shift', async () => {
    const resolver = createResolver(async () => [{
      orgId: 'org-a',
      userId: 'user-a',
      workDate: '2026-07-15',
      shiftId: 'shift-day',
      assignmentId: 'assignment-day',
      source: 'untrusted-source',
      workStartTime: '09:00',
      workEndTime: '18:00',
      timezone: 'UTC',
    }])
    const result = await resolver.resolve({
      orgId: 'org-a',
      userId: 'user-a',
      occurredAt: new Date('2026-07-15T10:00:00.000Z'),
      timezone: 'UTC',
      calendarWorkDate: '2026-07-15',
      channel: 'live',
    })
    expect(result).toMatchObject({
      kind: 'unresolved',
      reasonCode: REASON.MALFORMED_CANDIDATE_SOURCE,
    })
  })

  it('rejects a malformed published candidate instead of dropping it beside a valid row', async () => {
    const resolver = createResolver(async () => [
      {
        orgId: 'org-a',
        userId: 'user-a',
        workDate: '2026-07-15',
        shiftId: 'shift-valid',
        assignmentId: 'assignment-valid',
        source: 'shift',
        workStartTime: '09:00',
        workEndTime: '18:00',
        timezone: 'UTC',
      },
      {
        orgId: 'org-a',
        userId: 'user-a',
        workDate: '2026-07-15',
        shiftId: 'shift-malformed',
        assignmentId: 'assignment-malformed',
        source: 'shift',
        workStartTime: '09:00',
        workEndTime: null,
        timezone: 'UTC',
      },
    ])
    const result = await resolver.resolve({
      orgId: 'org-a',
      userId: 'user-a',
      occurredAt: new Date('2026-07-15T10:00:00.000Z'),
      timezone: 'UTC',
      calendarWorkDate: '2026-07-15',
      channel: 'live',
    })
    expect(result).toMatchObject({
      kind: 'unresolved',
      reasonCode: REASON.MALFORMED_CANDIDATE_SHAPE,
      evidenceSnapshot: {
        reason: 'shift_window',
        shiftId: 'shift-malformed',
      },
    })
  })

  it('rejects non-null segment identity until the segment-aware contract exists', async () => {
    const resolver = createResolver(async () => [{
      orgId: 'org-a',
      userId: 'user-a',
      workDate: '2026-07-15',
      shiftId: 'shift-segmented',
      assignmentId: 'assignment-segmented',
      source: 'shift',
      segmentIndex: 1,
      workStartTime: '09:00',
      workEndTime: '18:00',
      timezone: 'UTC',
    }])
    const result = await resolver.resolve({
      orgId: 'org-a',
      userId: 'user-a',
      occurredAt: new Date('2026-07-15T10:00:00.000Z'),
      timezone: 'UTC',
      calendarWorkDate: '2026-07-15',
      channel: 'live',
    })
    expect(result).toMatchObject({
      kind: 'unresolved',
      reasonCode: REASON.MALFORMED_CANDIDATE_SHAPE,
      evidenceSnapshot: {
        reason: 'segment_index',
        shiftId: 'shift-segmented',
      },
    })
  })

  it('does not extend attribution with a partial overtime anchor', () => {
    const abs = {
      startAt: new Date('2026-07-15T09:00:00.000Z'),
      endAt: new Date('2026-07-15T18:00:00.000Z'),
    }
    const result = buildAttributionWindow(abs, {
      attributionTailMinutes: 120,
      orgId: 'org-a',
      userId: 'user-a',
      workDate: '2026-07-15',
      shiftId: 'shift-day',
      approvedOvertimeWindows: [{
        orgId: 'org-a',
        userId: 'user-a',
        workDate: '2026-07-15',
        shiftId: 'shift-day',
        approvedEndAt: new Date('2026-07-15T22:00:00.000Z'),
        anchor: {
          version: 1,
          orgId: 'org-a',
          userId: 'user-a',
          workDate: '2026-07-15',
          shiftId: 'shift-day',
        },
      }],
    })!
    expect(result.endAt.toISOString()).toBe('2026-07-15T20:00:00.000Z')
  })

  it('does not fill missing candidate identity from the overtime request', () => {
    const resolver = createResolver(async () => [])
    const adapters = createAllWorkDateAdapters(resolver)
    const anchor = helpers.buildOvertimeAttributionV1({
      orgId: 'org-a',
      userId: 'user-a',
      workDate: '2026-07-15',
      shiftId: 'shift-day',
      source: 'shift',
      assignmentId: 'assignment-day',
    })
    const result = adapters.overtime.canExtendAttributionWindow({
      request: {
        orgId: 'org-a',
        userId: 'user-a',
        workDate: '2026-07-15',
        metadata: { [OVERTIME_ATTRIBUTION_KEY]: anchor },
      },
      candidate: { shiftId: 'shift-day' },
      anchor,
    })
    expect(result).toMatchObject({ ok: false, reason: 'ORG_MISMATCH' })
  })

  it('rejects malformed frozen segment identity and an explicit unknown channel', async () => {
    expect(helpers.lib.parseFrozenWorkDateAttribution({
      version: 1,
      orgId: 'org-a',
      userId: 'user-a',
      workDate: '2026-07-15',
      shiftId: 'shift-day',
      segmentIndex: 'not-an-index',
    })).toBeNull()
    expect(helpers.lib.parseFrozenWorkDateAttribution({
      version: 1,
      orgId: 'org-a',
      userId: 'user-a',
      workDate: '2026-07-15',
      shiftId: 'shift-day',
      segmentIndex: 1,
    })).toBeNull()

    const resolver = createResolver(async () => [])
    const result = await resolver.resolve({
      orgId: 'org-a',
      userId: 'user-a',
      occurredAt: new Date('2026-07-15T10:00:00.000Z'),
      timezone: 'UTC',
      channel: 'typo-channel',
    })
    expect(result).toMatchObject({ kind: 'unresolved', reasonCode: REASON.INVALID_INPUT })
  })
})

describe('W2 six-adapter parity', () => {
  it('exposes live/import/correction/overtime/recompute/scheduled thin adapters', () => {
    const resolver = createResolver(async () => [])
    const adapters = createAllWorkDateAdapters(resolver)
    expect(adapters.live.channel).toBe('live')
    expect(adapters.import.channel).toBe('import')
    expect(adapters.correction.channel).toBe('correction')
    expect(adapters.overtime.channel).toBe('overtime')
    expect(adapters.recompute.channel).toBe('recompute')
    expect(adapters.scheduled.channel).toBe('scheduled')
    expect(typeof adapters.live.resolvePunchWorkDate).toBe('function')
    expect(typeof adapters.import.resolveImportWorkDate).toBe('function')
    expect(typeof adapters.correction.resolveCorrectionWorkDate).toBe('function')
    expect(typeof adapters.overtime.freezeRequestCreationAnchor).toBe('function')
    expect(typeof adapters.recompute.resolveRecomputeWorkDate).toBe('function')
    expect(typeof adapters.scheduled.resolveScheduledWorkDate).toBe('function')
  })

  it('all six channels share the same unresolved contract for free_time', async () => {
    const resolver = createResolver(async () => [])
    const adapters = createAllWorkDateAdapters(resolver)
    const base = {
      orgId: 'org-a',
      userId: 'user-a',
      occurredAt: new Date('2026-07-15T10:00:00.000Z'),
      timezone: 'UTC',
      groupAttendanceType: 'free_time' as const,
    }
    const results = await Promise.all([
      adapters.live.resolvePunchWorkDate(base),
      adapters.import.resolveImportWorkDate(base),
      adapters.correction.resolveCorrectionWorkDate(base),
      adapters.recompute.resolveRecomputeWorkDate(base),
      adapters.scheduled.resolveScheduledWorkDate(base),
    ])
    for (const result of results) {
      expect(result.kind).toBe('unresolved')
      if (result.kind === 'unresolved') {
        expect(result.reasonCode).toBe(REASON.FREE_TIME_NO_SHIFT)
      }
    }
  })

  it('scheduled resolves by target-date cardinality without a synthetic occurredAt', async () => {
    const rawCandidate = {
      orgId: 'org-a',
      userId: 'user-a',
      workDate: '2026-07-15',
      shiftId: 'shift-day',
      assignmentId: 'assignment-day',
      source: 'shift',
      workStartTime: '09:00',
      workEndTime: '18:00',
      timezone: 'UTC',
    }
    const one = await createAllWorkDateAdapters(
      createResolver(async () => [rawCandidate]),
    ).scheduled.resolveScheduledWorkDate({
      orgId: 'org-a',
      userId: 'user-a',
      timezone: 'UTC',
      calendarWorkDate: '2026-07-15',
    })
    expect(one).toMatchObject({
      kind: 'resolved',
      workDate: '2026-07-15',
      shiftId: 'shift-day',
    })
    expect(Object.keys(one).sort()).toEqual([
      'evidenceSnapshot',
      'kind',
      'reasonCode',
      'segmentIndex',
      'shiftId',
      'workDate',
    ])

    const multiple = await createAllWorkDateAdapters(
      createResolver(async () => [
        rawCandidate,
        { ...rawCandidate, shiftId: 'shift-second', assignmentId: 'assignment-second' },
      ]),
    ).scheduled.resolveScheduledWorkDate({
      orgId: 'org-a',
      userId: 'user-a',
      timezone: 'UTC',
      calendarWorkDate: '2026-07-15',
    })
    expect(multiple).toMatchObject({
      kind: 'ambiguous',
      reasonCode: REASON.MULTIPLE_PUBLISHED_CANDIDATES,
    })

    const zero = await createAllWorkDateAdapters(
      createResolver(async () => []),
    ).scheduled.resolveScheduledWorkDate({
      orgId: 'org-a',
      userId: 'user-a',
      timezone: 'UTC',
      calendarWorkDate: '2026-07-15',
    })
    expect(zero).toMatchObject({
      kind: 'unresolved',
      reasonCode: REASON.UNSCHEDULED_NO_SHIFT,
    })

    const missingTarget = await createAllWorkDateAdapters(
      createResolver(async () => {
        throw new Error('candidate loader must not run without a scheduled target date')
      }),
    ).scheduled.resolveScheduledWorkDate({
      orgId: 'org-a',
      userId: 'user-a',
      timezone: 'UTC',
    })
    expect(missingTarget).toMatchObject({
      kind: 'unresolved',
      reasonCode: REASON.INVALID_INPUT,
    })
  })
})

describe('W2 pure overtime single-candidate selector', () => {
  it('selectSinglePublishedCandidateForOvertime is cardinality-strict', () => {
    const zero = selectSinglePublishedCandidateForOvertime([], { orgId: 'o', userId: 'u', workDate: '2026-07-15' })
    expect(zero.kind).toBe('unresolved')
    const one = selectSinglePublishedCandidateForOvertime([{
      workDate: '2026-07-15',
      shiftId: 's1',
      assignmentId: 'a1',
      source: 'shift',
      orgId: 'o',
      userId: 'u',
      segmentIndex: null,
      absoluteWindow: { startAt: new Date(), endAt: new Date() },
    }], { orgId: 'o', userId: 'u', workDate: '2026-07-15' })
    expect(one.kind).toBe('resolved')
    const two = selectSinglePublishedCandidateForOvertime([
      {
        workDate: '2026-07-15', shiftId: 's1', assignmentId: 'a1', source: 'shift',
        orgId: 'o', userId: 'u', segmentIndex: null,
        absoluteWindow: { startAt: new Date(), endAt: new Date() },
      },
      {
        workDate: '2026-07-15', shiftId: 's2', assignmentId: 'a2', source: 'shift',
        orgId: 'o', userId: 'u', segmentIndex: null,
        absoluteWindow: { startAt: new Date(), endAt: new Date() },
      },
    ], { orgId: 'o', userId: 'u', workDate: '2026-07-15' })
    expect(two.kind).toBe('ambiguous')
  })

  it('anchorsEqual is strict on every field', () => {
    const a = helpers.buildOvertimeAttributionV1({
      orgId: 'o', userId: 'u', workDate: '2026-07-15', shiftId: 's', source: 'shift', assignmentId: 'a',
    })
    const b = { ...a, assignmentId: 'b' }
    expect(anchorsEqual(a, a)).toBe(true)
    expect(anchorsEqual(a, b)).toBe(false)
  })
})
