// Display-side helpers shared by every calendar surface that consumes
// /api/attendance/effective-calendar items (multitable Calendar view +
// attendance personal calendar + holiday admin chip badges).
//
// Extracted from MetaCalendarView's PR1 inline helpers so the attendance
// consumers do not duplicate "same logic" (Codex Should-Fix #1 on PR2 plan).
// Pure functions — no DOM, no Vue, no i18n state. Both UIs accept the same
// string outputs and decide for themselves how to localize labels later if
// needed; matching PR1's English fallback convention keeps the contract
// stable until PR3 introduces i18n.

import type {
  CalendarEffectiveChip,
  CalendarEffectiveLayer,
  CalendarEffectiveOverlay,
  CalendarEffectiveSource,
} from './effectiveCalendar'

/**
 * Class fragment for the chip's source border accent. UI surfaces apply this
 * alongside their existing working/rest class; the shared
 * `apps/web/src/styles/calendar-source-palette.css` resolves the CSS variable
 * `--calendar-source-accent` per source token. Returns `undefined` for plain
 * rule/shift/rotation days so an accent is only painted for rows the user
 * should pay attention to.
 */
export function calendarChipSourceClassName(
  source: CalendarEffectiveSource | undefined,
): string | undefined {
  if (!source) return undefined
  switch (source) {
    case 'national':
    case 'manual':
    case 'org':
    case 'group':
    case 'role':
    case 'user':
      return `calendar-source--${source}`
    // rule / shift / rotation: no accent — handled by the calling chip's
    // working/rest class only.
    default:
      return undefined
  }
}

/** Generic chip-name fallback when neither effective.label nor base.name set. */
export function fallbackChipName(chip: CalendarEffectiveChip): string {
  return chip.isWorkingDay ? 'Working day' : 'Holiday'
}

/**
 * Holiday-origin helpers for the admin Holiday CRUD chip badge (PR2 Block B).
 * `national` rows come from /holidays/sync; `manual` rows from admin CRUD.
 * Missing origin (legacy rows or older backends) is treated as `manual` so
 * the badge always has a definite value — matching the backend's Step 2
 * default. The badge letter is intentionally a short single character so it
 * fits inside the existing chip without re-laying out the calendar grid.
 */
export type AttendanceHolidayOrigin = 'national' | 'manual'

export function calendarChipOriginClassName(origin: AttendanceHolidayOrigin | undefined | null): string {
  return origin === 'national' ? 'calendar-source--national' : 'calendar-source--manual'
}

export function calendarChipOriginBadge(origin: AttendanceHolidayOrigin | undefined | null): 'N' | 'M' {
  return origin === 'national' ? 'N' : 'M'
}

/**
 * True when a calendar_policy layer fired on top of the base; UIs use this
 * to add a `--overridden` style (dotted bottom border + cursor:help in PR1).
 */
export function hasCalendarChipOverrideMarker(chip: CalendarEffectiveChip): boolean {
  if (!Array.isArray(chip.layers)) return false
  return chip.layers.some((layer) => layer.kind === 'calendar_policy')
}

function describeLayerForTooltip(layer: CalendarEffectiveLayer): string {
  const verdict = layer.isWorkingDay ? 'work' : 'rest'
  const label = layer.label ? ` ${layer.label}` : ''
  return `${layer.source}:${label} (${verdict})`
}

function describeOverlayForTooltip(overlay: CalendarEffectiveOverlay): string {
  const parts: string[] = [overlay.kind]
  if (typeof overlay.minutes === 'number' && Number.isFinite(overlay.minutes)) {
    parts.push(`${overlay.minutes}m`)
  }
  if (overlay.status) parts.push(overlay.status)
  return parts.join(' · ')
}

/**
 * Build a multi-line text suitable for a native `title` tooltip:
 *   line 1 — "<date> — Working day · <source>" (or Rest day)
 *   line 2 — "Layers: national: National Day (rest) → org: Org swap (work)"
 *   line 3 — "Overlays: personal_leave · 240m · approved; overtime · 180m"
 * Returns undefined for legacy CalendarHoliday payloads that lack the
 * effective-calendar context fields (backward-compat).
 */
export function buildCalendarChipTooltip(chip: CalendarEffectiveChip): string | undefined {
  if (!chip.effective && !chip.base && !chip.layers?.length && !chip.overlays?.length) {
    return undefined
  }
  const lines: string[] = []
  const verdict = chip.effective?.isWorkingDay ?? chip.isWorkingDay
  const verdictWord = verdict === true ? 'Working day' : verdict === false ? 'Rest day' : 'Unknown'
  const sourceTag = chip.effective?.source ? ` · ${chip.effective.source}` : ''
  lines.push(`${chip.date} — ${verdictWord}${sourceTag}`)
  if (chip.layers?.length) {
    lines.push(`Layers: ${chip.layers.map(describeLayerForTooltip).join(' → ')}`)
  }
  if (chip.overlays?.length) {
    lines.push(`Overlays: ${chip.overlays.map(describeOverlayForTooltip).join('; ')}`)
  }
  return lines.join('\n')
}
