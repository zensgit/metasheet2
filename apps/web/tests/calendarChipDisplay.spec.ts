// Layer-1 unit coverage for the shared chip-display helpers extracted from
// MetaCalendarView (PR1) into apps/web/src/services/attendance/calendarChipDisplay.ts
// for PR2. The contract pinned here is:
//   - source class derivation maps API source values 1:1 to CSS hooks
//   - override marker only fires when a calendar_policy layer is present
//   - tooltip stays empty for legacy CalendarHoliday payloads
//   - tooltip composes date/effective/layers/overlays in a stable order
//   - holiday origin badge defaults to manual when missing

import { describe, expect, it } from 'vitest'
import {
  buildCalendarChipDisplay,
  buildCalendarChipTooltip,
  calendarChipEmployeeSourceClassName,
  calendarChipOriginBadge,
  calendarChipOriginClassName,
  calendarChipSourceClassName,
  fallbackChipName,
  hasCalendarChipOverrideMarker,
} from '../src/services/attendance/calendarChipDisplay'
import type {
  CalendarEffectiveChip,
} from '../src/services/attendance/effectiveCalendar'

describe('calendarChipSourceClassName', () => {
  it('maps each calendar_policy/base source to the matching CSS hook', () => {
    expect(calendarChipSourceClassName('national')).toBe('calendar-source--national')
    expect(calendarChipSourceClassName('manual')).toBe('calendar-source--manual')
    expect(calendarChipSourceClassName('org')).toBe('calendar-source--org')
    expect(calendarChipSourceClassName('group')).toBe('calendar-source--group')
    expect(calendarChipSourceClassName('role')).toBe('calendar-source--role')
    expect(calendarChipSourceClassName('user')).toBe('calendar-source--user')
  })
  it('returns undefined for plain rule/shift/rotation days so no accent is painted', () => {
    expect(calendarChipSourceClassName('rule')).toBeUndefined()
    expect(calendarChipSourceClassName('shift')).toBeUndefined()
    expect(calendarChipSourceClassName('rotation')).toBeUndefined()
    expect(calendarChipSourceClassName(undefined)).toBeUndefined()
  })
})

describe('employee calendar chip display', () => {
  it('collapses non-national sources into the employee company-policy accent', () => {
    expect(calendarChipEmployeeSourceClassName('national')).toBe('calendar-source--national')
    for (const source of ['manual', 'org', 'group', 'role', 'user'] as const) {
      expect(calendarChipEmployeeSourceClassName(source)).toBe('calendar-source--company-policy')
    }
    expect(calendarChipEmployeeSourceClassName('rule')).toBeUndefined()
  })

  it('shows the stripped festival anchor on dayIndex=1 across backend suffix formats', () => {
    for (const name of ['国庆节-1', '国庆节第1天', '国庆节 DAY1']) {
      const display = buildCalendarChipDisplay({
        id: name,
        date: '2026-10-01',
        name,
        isWorkingDay: false,
        base: { isWorkingDay: false, source: 'national', name, dayIndex: 1 },
        effective: { isWorkingDay: false, source: 'national', label: name },
      } as CalendarEffectiveChip, { isZh: true })
      expect(display.title).toBe('国庆节')
      expect(display.dayBadge?.text).toBe('休')
      expect(display.visibleText).toBe('国庆节 休')
      expect(display.sourceClass).toBe('calendar-source--national')
    }
  })

  it('uses only the rest badge for generated holiday continuation days', () => {
    const display = buildCalendarChipDisplay({
      id: 'national-2',
      date: '2026-10-02',
      name: '国庆节-2',
      isWorkingDay: false,
      base: { isWorkingDay: false, source: 'national', name: '国庆节-2', dayIndex: 2 },
      effective: { isWorkingDay: false, source: 'national', label: '国庆节-2' },
    } as CalendarEffectiveChip, { isZh: true })
    expect(display.title).toBeUndefined()
    expect(display.dayBadge?.text).toBe('休')
    expect(display.visibleText).toBe('休')
    expect(display.tooltip).toContain('国庆节-2')
  })

  it('renders overlay as a secondary badge without reading overlay-derived chip.name', () => {
    const display = buildCalendarChipDisplay({
      id: 'leave-1',
      date: '2026-10-06',
      name: 'Leave',
      isWorkingDay: true,
      base: { isWorkingDay: true, source: 'rule' },
      effective: { isWorkingDay: true, source: 'rule' },
      overlays: [{ kind: 'personal_leave', source: 'attendance_requests', minutes: 240, status: 'approved' }],
    } as CalendarEffectiveChip, { isZh: true })
    expect(display.title).toBeUndefined()
    expect(display.dayBadge?.text).toBe('班')
    expect(display.overlayBadges[0]).toMatchObject({
      kind: 'leave',
      text: '假 4h',
      label: '请假',
      fullDay: false,
    })
    expect(display.visibleText).toBe('班 假 4h')
    expect(display.tooltip).toContain('个人状态: 请假 · 240m')
  })

  it('hides overlay duration when minutes equals the configured full-day threshold', () => {
    const display = buildCalendarChipDisplay({
      id: 'leave-2',
      date: '2026-10-07',
      isWorkingDay: true,
      base: { isWorkingDay: true, source: 'rule' },
      effective: { isWorkingDay: true, source: 'rule' },
      overlays: [{ kind: 'personal_leave', source: 'attendance_requests', minutes: 480 }],
    } as CalendarEffectiveChip, { isZh: true, fullDayMinutes: 480 })
    expect(display.overlayBadges[0]?.text).toBe('假')
    expect(display.overlayBadges[0]?.fullDay).toBe(true)
  })

  it('keeps English short badges empty while preserving tooltip detail', () => {
    const display = buildCalendarChipDisplay({
      id: 'ot-1',
      date: '2026-10-08',
      name: 'Overtime',
      isWorkingDay: true,
      base: { isWorkingDay: true, source: 'rule' },
      effective: { isWorkingDay: true, source: 'rule' },
      overlays: [{ kind: 'overtime', source: 'attendance_requests', minutes: 120 }],
    } as CalendarEffectiveChip, { isZh: false })
    expect(display.dayBadge?.text).toBe('')
    expect(display.overlayBadges[0]?.text).toBe('')
    expect(display.visibleText).toBe('')
    expect(display.tooltip).toContain('Overlays: Overtime · 120m')
  })

  it('falls back to legacy chip name when no effective-calendar fields are present', () => {
    const display = buildCalendarChipDisplay({
      id: 'legacy',
      date: '2026-01-01',
      isWorkingDay: false,
    } as CalendarEffectiveChip, { isZh: false })
    expect(display.title).toBe('Holiday')
    expect(display.visibleText).toBe('Holiday')
  })
})

describe('hasCalendarChipOverrideMarker', () => {
  it('returns true only when at least one calendar_policy layer fired', () => {
    expect(hasCalendarChipOverrideMarker({
      id: '1', date: '2026-10-05',
      layers: [
        { kind: 'holiday', source: 'national', isWorkingDay: false },
        { kind: 'calendar_policy', source: 'org', isWorkingDay: true },
      ],
    } as CalendarEffectiveChip)).toBe(true)
  })
  it('returns false for chips with only base layers', () => {
    expect(hasCalendarChipOverrideMarker({
      id: '1', date: '2026-10-05',
      layers: [{ kind: 'holiday', source: 'national', isWorkingDay: false }],
    } as CalendarEffectiveChip)).toBe(false)
    expect(hasCalendarChipOverrideMarker({ id: '1', date: '2026-10-05' } as CalendarEffectiveChip)).toBe(false)
  })
})

describe('buildCalendarChipTooltip', () => {
  it('returns undefined for a legacy CalendarHoliday payload (no effective/base/layers/overlays)', () => {
    expect(buildCalendarChipTooltip({
      id: 'h1', date: '2026-02-17', name: 'Spring Festival', isWorkingDay: false,
    } as CalendarEffectiveChip)).toBeUndefined()
  })
  it('composes date + verdict + source on line 1', () => {
    const text = buildCalendarChipTooltip({
      id: '1', date: '2026-10-01',
      effective: { isWorkingDay: false, source: 'national', label: 'National Day' },
      layers: [{ kind: 'holiday', source: 'national', isWorkingDay: false, label: 'National Day' }],
      overlays: [],
    } as CalendarEffectiveChip) ?? ''
    expect(text.split('\n')[0]).toBe('2026-10-01 — Rest day · national')
  })
  it('renders layer chain on line 2 and overlay summary on line 3 in stable order', () => {
    const text = buildCalendarChipTooltip({
      id: '1', date: '2026-10-05',
      effective: { isWorkingDay: true, source: 'org', label: 'Org swap' },
      layers: [
        { kind: 'holiday', source: 'national', isWorkingDay: false, label: 'National Day' },
        { kind: 'calendar_policy', source: 'org', isWorkingDay: true, label: 'Org swap' },
      ],
      overlays: [
        { kind: 'personal_leave', source: 'attendance_requests', minutes: 240, status: 'approved' },
        { kind: 'overtime', source: 'attendance_requests', minutes: 180 },
      ],
    } as CalendarEffectiveChip) ?? ''
    const lines = text.split('\n')
    expect(lines[1]).toContain('Layers:')
    expect(lines[1]).toContain('national:')
    expect(lines[1]).toContain('National Day')
    expect(lines[1]).toContain('org:')
    expect(lines[2]).toContain('Overlays:')
    expect(lines[2]).toContain('personal_leave · 240m · approved')
    expect(lines[2]).toContain('overtime · 180m')
  })
})

describe('fallbackChipName', () => {
  it('returns "Working day" / "Holiday" by isWorkingDay', () => {
    expect(fallbackChipName({ id: '1', date: '2026-01-01', isWorkingDay: true } as CalendarEffectiveChip)).toBe('Working day')
    expect(fallbackChipName({ id: '1', date: '2026-01-01', isWorkingDay: false } as CalendarEffectiveChip)).toBe('Holiday')
  })
})

describe('attendance holiday origin helpers', () => {
  it('maps origin=national/manual to the matching shared palette class', () => {
    expect(calendarChipOriginClassName('national')).toBe('calendar-source--national')
    expect(calendarChipOriginClassName('manual')).toBe('calendar-source--manual')
  })
  it('defaults to manual when origin is missing (legacy rows / older backends)', () => {
    expect(calendarChipOriginClassName(undefined)).toBe('calendar-source--manual')
    expect(calendarChipOriginClassName(null)).toBe('calendar-source--manual')
  })
  it('returns the short N/M badge letter for the chip', () => {
    expect(calendarChipOriginBadge('national')).toBe('N')
    expect(calendarChipOriginBadge('manual')).toBe('M')
    expect(calendarChipOriginBadge(undefined)).toBe('M')
    expect(calendarChipOriginBadge(null)).toBe('M')
  })
})
