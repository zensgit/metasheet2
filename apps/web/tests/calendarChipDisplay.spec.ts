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
  buildCalendarChipTooltip,
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
