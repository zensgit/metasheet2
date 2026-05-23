// Display-side helpers shared by every calendar surface that consumes
// /api/attendance/effective-calendar items (multitable Calendar view +
// attendance personal calendar + holiday admin chip badges).
//
// Extracted from MetaCalendarView's PR1 inline helpers so the attendance
// consumers do not duplicate "same logic" (Codex Should-Fix #1 on PR2 plan).
// Pure functions — no DOM, no Vue, no i18n state. Both UIs accept the same
// string outputs and provide the current locale explicitly so we do not bind
// calendar rendering to a Vue composable from this service module.

import type {
  CalendarEffectiveChip,
  CalendarEffectiveLayer,
  CalendarEffectiveOverlay,
  CalendarEffectiveOverlayKind,
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

export type CalendarChipEmployeeSourceCategory = 'national' | 'company-policy'
export type CalendarChipDayBadgeKind = 'work' | 'rest'
export type CalendarChipOverlayBadgeKind =
  | 'leave'
  | 'overtime'
  | 'correction'
  | 'business-trip'
  | 'training'

export interface BuildCalendarChipDisplayOptions {
  isZh?: boolean
  fullDayMinutes?: number
}

export interface CalendarChipDayBadge {
  kind: CalendarChipDayBadgeKind
  text: string
  label: string
}

export interface CalendarChipOverlayBadge {
  kind: CalendarChipOverlayBadgeKind
  className: string
  text: string
  label: string
  minutes?: number
  fullDay: boolean
}

export interface CalendarChipDisplayModel {
  title?: string
  dayBadge?: CalendarChipDayBadge
  overlayBadges: CalendarChipOverlayBadge[]
  sourceClass?: string
  tooltip?: string
  ariaLabel: string
  visibleText: string
  hasOverlay: boolean
  hasOverride: boolean
}

const GENERATED_DAY_INDEX_NAME_RE = /^(.*?)(?:\s*-\s*|第|\s+DAY\s*)(\d+)(?:天)?$/i

const OVERLAY_DISPLAY: Record<
  CalendarEffectiveOverlayKind,
  {
    kind: CalendarChipOverlayBadgeKind
    zhShort: string
    zhLabel: string
    enLabel: string
  }
> = {
  personal_leave: {
    kind: 'leave',
    zhShort: '假',
    zhLabel: '请假',
    enLabel: 'Leave',
  },
  overtime: {
    kind: 'overtime',
    zhShort: '加',
    zhLabel: '加班',
    enLabel: 'Overtime',
  },
  attendance_correction: {
    kind: 'correction',
    zhShort: '补',
    zhLabel: '补卡',
    enLabel: 'Correction',
  },
  business_trip: {
    kind: 'business-trip',
    zhShort: '出',
    zhLabel: '出差',
    enLabel: 'Business trip',
  },
  training: {
    kind: 'training',
    zhShort: '训',
    zhLabel: '培训',
    enLabel: 'Training',
  },
}

function normalizedText(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function parseGeneratedDayIndexName(name: string | undefined): { title: string; dayIndex: number } | undefined {
  if (!name) return undefined
  const match = name.match(GENERATED_DAY_INDEX_NAME_RE)
  if (!match) return undefined
  const dayIndex = Number.parseInt(match[2] ?? '', 10)
  const title = (match[1] ?? '').trim()
  if (!Number.isFinite(dayIndex) || dayIndex <= 0 || !title) return undefined
  return { title, dayIndex }
}

function hasGeneratedContinuationName(chip: CalendarEffectiveChip): boolean {
  const baseName = normalizedText(chip.base?.name)
  const parsed = parseGeneratedDayIndexName(baseName)
  const dayIndex = chip.base?.dayIndex
  return Boolean(parsed && typeof dayIndex === 'number' && parsed.dayIndex === dayIndex && dayIndex > 1)
}

function resolveBaseTitle(chip: CalendarEffectiveChip): string | undefined {
  const baseName = normalizedText(chip.base?.name)
  if (!baseName) return undefined
  const parsed = parseGeneratedDayIndexName(baseName)
  const dayIndex = chip.base?.dayIndex
  if (typeof dayIndex === 'number' && parsed?.dayIndex === dayIndex) {
    if (dayIndex === 1) return parsed.title
    return undefined
  }
  return baseName
}

function hasCalendarPolicyLayer(chip: CalendarEffectiveChip): boolean {
  return Array.isArray(chip.layers) && chip.layers.some((layer) => layer.kind === 'calendar_policy')
}

function resolveTitleLabel(chip: CalendarEffectiveChip): string | undefined {
  if (!chip.effective && !chip.base && !chip.layers?.length && !chip.overlays?.length) {
    return normalizedText(chip.name) ?? fallbackChipName(chip)
  }

  const effectiveLabel = normalizedText(chip.effective?.label)
  if (hasCalendarPolicyLayer(chip) && effectiveLabel) return effectiveLabel

  const baseTitle = resolveBaseTitle(chip)
  if (baseTitle) return baseTitle

  if (chip.overlays?.length || hasGeneratedContinuationName(chip)) return undefined
  return effectiveLabel ?? normalizedText(chip.name)
}

function resolveEffectiveWorkingDay(chip: CalendarEffectiveChip): boolean | undefined {
  if (typeof chip.effective?.isWorkingDay === 'boolean') return chip.effective.isWorkingDay
  if (typeof chip.isWorkingDay === 'boolean') return chip.isWorkingDay
  if (typeof chip.base?.isWorkingDay === 'boolean') return chip.base.isWorkingDay
  return undefined
}

function sourceCategory(source: CalendarEffectiveSource | undefined): CalendarChipEmployeeSourceCategory | undefined {
  if (source === 'national') return 'national'
  if (source === 'manual' || source === 'org' || source === 'group' || source === 'role' || source === 'user') {
    return 'company-policy'
  }
  return undefined
}

export function calendarChipEmployeeSourceClassName(
  source: CalendarEffectiveSource | undefined,
): string | undefined {
  const category = sourceCategory(source)
  if (category === 'national') return 'calendar-source--national'
  if (category === 'company-policy') return 'calendar-source--company-policy'
  return undefined
}

function dayBadgeLabel(kind: CalendarChipDayBadgeKind, isZh: boolean): string {
  if (kind === 'work') return isZh ? '工作日' : 'Working day'
  return isZh ? '休息日' : 'Rest day'
}

function buildDayBadge(chip: CalendarEffectiveChip, isZh: boolean): CalendarChipDayBadge | undefined {
  const isWorkingDay = resolveEffectiveWorkingDay(chip)
  if (typeof isWorkingDay !== 'boolean') return undefined
  const kind: CalendarChipDayBadgeKind = isWorkingDay ? 'work' : 'rest'
  return {
    kind,
    text: isZh ? (kind === 'work' ? '班' : '休') : '',
    label: dayBadgeLabel(kind, isZh),
  }
}

function normalizeFullDayMinutes(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 480
}

function formatDuration(minutes: number): string {
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

function buildOverlayBadge(
  overlay: CalendarEffectiveOverlay,
  isZh: boolean,
  fullDayMinutes: number,
): CalendarChipOverlayBadge {
  const display = OVERLAY_DISPLAY[overlay.kind]
  const minutes = typeof overlay.minutes === 'number' && Number.isFinite(overlay.minutes)
    ? overlay.minutes
    : undefined
  const fullDay = typeof minutes === 'number' && minutes === fullDayMinutes
  const label = normalizedText(overlay.label) ?? (isZh ? display.zhLabel : display.enLabel)
  const durationText = typeof minutes === 'number' && !fullDay ? ` ${formatDuration(minutes)}` : ''
  return {
    kind: display.kind,
    className: `calendar-overlay--${display.kind}`,
    text: isZh ? `${display.zhShort}${durationText}` : '',
    label,
    minutes,
    fullDay,
  }
}

function describeEmployeeSource(source: CalendarEffectiveSource | undefined, isZh: boolean): string | undefined {
  switch (source) {
    case 'national':
      return isZh ? '法定节假日' : 'Statutory holiday'
    case 'manual':
      return isZh ? '公司节假日 · 手动设置' : 'Company calendar · manual'
    case 'org':
      return isZh ? '公司节假日 · 组织级日历政策' : 'Company calendar · org policy'
    case 'group':
      return isZh ? '公司节假日 · 班组日历政策' : 'Company calendar · group policy'
    case 'role':
      return isZh ? '公司节假日 · 角色日历政策' : 'Company calendar · role policy'
    case 'user':
      return isZh ? '公司节假日 · 个人日历政策' : 'Company calendar · user policy'
    default:
      return undefined
  }
}

function describeLayerForLocalizedTooltip(layer: CalendarEffectiveLayer, isZh: boolean): string {
  const verdict = layer.isWorkingDay ? (isZh ? '班' : 'work') : (isZh ? '休' : 'rest')
  const label = layer.label ? ` ${layer.label}` : ''
  return `${layer.source}:${label} (${verdict})`
}

function buildDisplayTooltip(
  chip: CalendarEffectiveChip,
  display: {
    title?: string
    dayBadge?: CalendarChipDayBadge
    overlayBadges: CalendarChipOverlayBadge[]
  },
  isZh: boolean,
): string | undefined {
  if (!chip.effective && !chip.base && !chip.layers?.length && !chip.overlays?.length) {
    return undefined
  }
  const lines: string[] = []
  const sourceLabel = describeEmployeeSource(chip.effective?.source ?? chip.base?.source, isZh)
  const verdictLabel = display.dayBadge?.label
  const headlineParts = [display.title, verdictLabel, sourceLabel].filter(Boolean)
  lines.push(`${chip.date}${headlineParts.length ? ` — ${headlineParts.join(' · ')}` : ''}`)
  const rawBaseName = normalizedText(chip.base?.name)
  if (!display.title && rawBaseName) {
    lines.push(`${isZh ? '节日' : 'Holiday'}: ${rawBaseName}`)
  }
  if (chip.layers?.length) {
    lines.push(`${isZh ? '层级' : 'Layers'}: ${chip.layers.map((layer) => describeLayerForLocalizedTooltip(layer, isZh)).join(' → ')}`)
  }
  if (display.overlayBadges.length) {
    const overlayText = display.overlayBadges.map((badge) => {
      const minutes = typeof badge.minutes === 'number' ? ` · ${badge.minutes}m` : ''
      return `${badge.label}${minutes}`
    }).join('; ')
    lines.push(`${isZh ? '个人状态' : 'Overlays'}: ${overlayText}`)
  }
  return lines.join('\n')
}

function buildAriaLabel(display: {
  title?: string
  dayBadge?: CalendarChipDayBadge
  overlayBadges: CalendarChipOverlayBadge[]
}, chip: CalendarEffectiveChip): string {
  const parts = [
    chip.date,
    display.title,
    display.dayBadge?.label,
    ...display.overlayBadges.map((badge) => badge.label),
  ].filter(Boolean)
  return parts.join(' · ')
}

export function buildCalendarChipDisplay(
  chip: CalendarEffectiveChip,
  options: BuildCalendarChipDisplayOptions = {},
): CalendarChipDisplayModel {
  const isZh = options.isZh === true
  const fullDayMinutes = normalizeFullDayMinutes(options.fullDayMinutes)
  const title = resolveTitleLabel(chip)
  const dayBadge = buildDayBadge(chip, isZh)
  const overlayBadges = (chip.overlays ?? []).map((overlay) => buildOverlayBadge(overlay, isZh, fullDayMinutes))
  const partialDisplay = { title, dayBadge, overlayBadges }
  const visibleText = [
    title,
    dayBadge?.text,
    ...overlayBadges.map((badge) => badge.text),
  ].filter(Boolean).join(' ')
  return {
    title,
    dayBadge,
    overlayBadges,
    sourceClass: calendarChipEmployeeSourceClassName(chip.effective?.source ?? chip.base?.source),
    tooltip: buildDisplayTooltip(chip, partialDisplay, isZh),
    ariaLabel: buildAriaLabel(partialDisplay, chip),
    visibleText,
    hasOverlay: overlayBadges.length > 0,
    hasOverride: hasCalendarChipOverrideMarker(chip),
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
