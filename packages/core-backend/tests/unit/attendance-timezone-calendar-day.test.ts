import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { canonicalContextFingerprint: fingerprint } = require(
  '../../../../plugins/plugin-attendance/lib/attendance-timezone-runtime.cjs',
) as { canonicalContextFingerprint(value: unknown): string }
const { buildCalendarTimezoneDay } = require(
  '../../../../plugins/plugin-attendance/lib/attendance-timezone-calendar-day.cjs',
) as { buildCalendarTimezoneDay(windows: ReturnType<typeof window>[], options: {
  candidateOrder: string[], fingerprint(value: unknown): string,
}): (ReturnType<typeof window> & { calendarWindows: ReturnType<typeof window>[] }) | null }

function window(id: string, start: string, end: string, isWorkingDay = true) {
  const timezoneContext = {
    timezone: 'UTC', source: 'system_default', mode: 'default_only', referenceId: 'owned-rule',
    version: 1, policyVersion: 0, calculationGroupMembership: null,
  }
  return {
    workDate: '2026-07-08', source: 'shift', assignmentId: id,
    startAt: new Date(`2026-07-08T${start}:00.000Z`), endAt: new Date(`2026-07-08T${end}:00.000Z`),
    timezone: 'UTC', timezoneContext, isWorkingDay,
    sourceContext: { rule: { id: `shift-${id}` }, isWorkingDay },
    contextFingerprint: fingerprint({ id, start, end, timezoneContext, isWorkingDay }),
  }
}
const morning = () => window('morning', '08:00', '12:00')
const evening = () => window('evening', '13:00', '17:00')
const options = { candidateOrder: ['shift:morning', 'shift:evening'], fingerprint }

describe('fresh calendar day timezone proof', () => {
  it('keeps both same-authority slots in actual selector order and hashes both', () => {
    const a = morning(), b = evening()
    const day = buildCalendarTimezoneDay([b, a], options)
    expect(day?.calendarWindows).toEqual([a, b])
    expect(day?.sourceContext.rule).toEqual(a.sourceContext.rule)
    expect(day?.startAt).toEqual(a.startAt)
    expect(day?.endAt).toEqual(b.endAt)
    expect(day?.contextFingerprint).toBe(fingerprint({ kind: 'calendar_day', windows: [a.contextFingerprint, b.contextFingerprint] }))
    expect(day?.contextFingerprint).not.toBe(a.contextFingerprint)
    expect(day?.contextFingerprint).not.toBe(b.contextFingerprint)
  })

  it('preserves the single-slot timezone target fields exactly', () => {
    const original = morning()
    const day = buildCalendarTimezoneDay([original], { candidateOrder: ['shift:morning'], fingerprint })
    expect(day?.contextFingerprint).toBe(original.contextFingerprint)
    expect(day?.timezoneContext).toEqual(original.timezoneContext)
    expect(day?.timezone).toBe(original.timezone)
    expect(day?.isWorkingDay).toBe(original.isWorkingDay)
    expect(day?.startAt).toEqual(original.startAt)
    expect(day?.endAt).toEqual(original.endAt)
    expect(day?.sourceContext).toEqual(original.sourceContext)
  })

  it('changes the display proof when the second slot changes', () => {
    const original = buildCalendarTimezoneDay([morning(), evening()], options)
    const changed = buildCalendarTimezoneDay([morning(), window('evening', '13:00', '18:00')], options)
    expect(changed?.contextFingerprint).not.toBe(original?.contextFingerprint)
  })

  it('uses any selected working slot while preserving individual nonworking slots', () => {
    const a = window('morning', '08:00', '12:00', false), b = evening()
    const day = buildCalendarTimezoneDay([a, b], options)
    expect(day?.isWorkingDay).toBe(true)
    expect(day?.sourceContext.isWorkingDay).toBe(true)
    expect(day?.calendarWindows.map(slot => slot.isWorkingDay)).toEqual([false, true])
  })

  it('keeps only the temporary replacement selected by the existing overlay selector', () => {
    const replacement = window('temporary', '09:00', '17:00')
    const day = buildCalendarTimezoneDay([replacement], { candidateOrder: ['shift:temporary'], fingerprint })
    expect(day?.calendarWindows).toEqual([replacement])
    expect(day?.contextFingerprint).toBe(replacement.contextFingerprint)
    expect(buildCalendarTimezoneDay([morning(), replacement], { candidateOrder: ['shift:temporary'], fingerprint })).toBeNull()
  })

  it.each(['timezone', 'source', 'mode', 'referenceId', 'version', 'policyVersion', 'calculationGroupMembership'])(
    'rejects a changed governed %s even when slot geometry is valid', field => {
      const b = evening()
      const changed = { ...b, timezoneContext: { ...b.timezoneContext, [field]: field === 'timezone' ? 'Asia/Tokyo' : 'different' } } as unknown as typeof b
      expect(buildCalendarTimezoneDay([morning(), changed], options)).toBeNull()
    },
  )

  it('rejects missing, duplicate, and unselected candidate identities', () => {
    expect(buildCalendarTimezoneDay([morning()], options)).toBeNull()
    expect(buildCalendarTimezoneDay([morning(), evening()], { ...options, candidateOrder: ['shift:morning', 'shift:morning'] })).toBeNull()
    expect(buildCalendarTimezoneDay([morning(), evening(), window('extra', '18:00', '20:00')], options)).toBeNull()
  })

  it('rejects changing context for the same selected assignment across source intervals', () => {
    expect(buildCalendarTimezoneDay([morning(), { ...morning(), contextFingerprint: fingerprint('changed') }, evening()], options)).toBeNull()
  })

  it('requires one default fallback when no published calendar source is selected', () => {
    const fallback = { ...morning(), source: 'rule', assignmentId: null, rule: { id: 'owned-rule' } }
    expect(buildCalendarTimezoneDay([fallback] as unknown as ReturnType<typeof window>[], { candidateOrder: [], fingerprint })?.calendarWindows).toEqual([fallback])
    expect(buildCalendarTimezoneDay([morning()], { candidateOrder: [], fingerprint })).toBeNull()
    expect(buildCalendarTimezoneDay([], { candidateOrder: [], fingerprint })).toBeNull()
  })
})
