// Shared client for GET /api/attendance/effective-calendar (RFC §5).
//
// Lives under apps/web/src/services/attendance/ so PR2 (AttendanceView +
// AttendanceHolidayDataSection origin chip) can reuse the same types and
// fetcher without duplicating; do not move into multitable/api/ even though
// PR1 only wires the multitable Calendar caller.
//
// Behaviors documented for consumers:
//   - Throws if neither/multiple modes are provided (mirrors the route's 400).
//   - Defaults suppressUnauthorizedRedirect=true so calendar widgets do not
//     bounce the whole app to /login when the attendance plugin denies a
//     cross-user query.
//   - Returns the typed data payload; callers translate to their cell shape.

import { apiFetch } from '../../utils/api'

export type CalendarEffectiveMode = 'userId' | 'groupId' | 'orgOnly'

export type CalendarEffectiveBaseSource =
  | 'rule'
  | 'shift'
  | 'rotation'
  | 'national'
  | 'manual'

export type CalendarEffectivePolicySource = 'org' | 'group' | 'role' | 'user'

export type CalendarEffectiveSource =
  | CalendarEffectiveBaseSource
  | CalendarEffectivePolicySource

export interface CalendarEffectiveBase {
  isWorkingDay: boolean
  source: CalendarEffectiveSource
  holidayId?: string
  name?: string | null
}

export interface CalendarEffectiveResult {
  isWorkingDay: boolean
  source: CalendarEffectiveSource
  label?: string
  policyId?: string
}

export type CalendarEffectiveLayerKind = 'base_rule' | 'holiday' | 'calendar_policy'

export interface CalendarEffectiveLayer {
  kind: CalendarEffectiveLayerKind
  source: CalendarEffectiveSource
  isWorkingDay: boolean
  label?: string
  refId?: string
}

export type CalendarEffectiveOverlayKind =
  | 'personal_leave'
  | 'overtime'
  | 'attendance_correction'
  | 'business_trip'
  | 'training'

export type CalendarEffectiveOverlaySource =
  | 'attendance_requests'
  | 'attendance_records'
  | 'reserved'

export type CalendarEffectiveOverlayRequestType =
  | 'leave'
  | 'overtime'
  | 'missed_check_in'
  | 'missed_check_out'
  | 'time_correction'

export interface CalendarEffectiveOverlay {
  kind: CalendarEffectiveOverlayKind
  source: CalendarEffectiveOverlaySource
  requestType?: CalendarEffectiveOverlayRequestType
  minutes?: number
  status?: string
  label?: string
  refId?: string
}

export interface CalendarEffectiveItem {
  date: string
  base: CalendarEffectiveBase
  effective: CalendarEffectiveResult
  layers: CalendarEffectiveLayer[]
  overlays: CalendarEffectiveOverlay[]
}

export interface CalendarEffectiveResponse {
  mode: CalendarEffectiveMode
  from: string
  to: string
  timezone: string
  items: CalendarEffectiveItem[]
}

export interface CalendarEffectiveDraftOverride {
  id?: string
  name?: string
  match?: 'contains' | 'regex' | 'equals'
  date?: string
  from?: string
  to?: string
  dayIndexStart?: number
  dayIndexEnd?: number
  dayIndexList?: number[]
  filters?: {
    userIds?: string[]
    userNames?: string[]
    excludeUserIds?: string[]
    excludeUserNames?: string[]
    attendanceGroups?: string[]
    roles?: string[]
    roleTags?: string[]
  }
  effective: {
    isWorkingDay: boolean
    label?: string
    source: 'org' | 'group' | 'role' | 'user'
  }
}

// UI-facing chip shape: lets calendar components keep treating items as the
// legacy CalendarHoliday tuple (id/date/name/isWorkingDay drives the badge
// text + working/rest class) while also carrying the richer effective fields
// so tooltips / override markers can consult base/effective/layers/overlays
// where present. Callers convert API items via `effectiveCalendarItemToChip`.
export interface CalendarEffectiveChip {
  id: string
  date: string
  name?: string | null
  isWorkingDay?: boolean
  base?: CalendarEffectiveBase
  effective?: CalendarEffectiveResult
  layers?: CalendarEffectiveLayer[]
  overlays?: CalendarEffectiveOverlay[]
}

// Heuristic for "should this day get a chip rendered" — true when the item
// carries any holiday row, any calendar_policy layer that fired, or any
// overlay. Plain rule/shift/rotation working days with no overrides return
// false so the calendar surface stays clean.
export function isCalendarEffectiveItemNoteworthy(item: CalendarEffectiveItem): boolean {
  if (item.base.source === 'national' || item.base.source === 'manual') return true
  if (Array.isArray(item.layers) && item.layers.some((layer) => layer.kind === 'calendar_policy')) return true
  if (Array.isArray(item.overlays) && item.overlays.length > 0) return true
  return false
}

// Short, English fallback label derived from the first overlay. Used by
// effectiveCalendarItemToChip ONLY when neither effective.label nor base.name
// is available (typical case: rule/shift workday with an approved leave or
// overtime overlay and no calendar_policy override). Without this fallback
// the chip would render the generic "Working day" / "Holiday" text from
// MetaCalendarView's fallbackHolidayName, which hides the overlay reason.
// Mirrors the English convention already used by fallbackHolidayName; PR2
// will decide if the i18n surface should localize both together.
const OVERLAY_FALLBACK_LABEL: Record<CalendarEffectiveOverlayKind, string> = {
  personal_leave: 'Leave',
  overtime: 'Overtime',
  attendance_correction: 'Correction',
  business_trip: 'Business trip',
  training: 'Training',
}

function deriveOverlayLabel(overlays: CalendarEffectiveOverlay[] | undefined): string | undefined {
  if (!Array.isArray(overlays) || overlays.length === 0) return undefined
  const first = overlays[0]
  if (typeof first.label === 'string' && first.label.trim()) return first.label.trim()
  return OVERLAY_FALLBACK_LABEL[first.kind] ?? first.kind
}

export function effectiveCalendarItemToChip(item: CalendarEffectiveItem): CalendarEffectiveChip {
  const id = item.base.holidayId
    ?? `${item.date}|${item.effective.source}|${item.effective.policyId ?? ''}`
  const overlayLabel = deriveOverlayLabel(item.overlays)
  return {
    id,
    date: item.date,
    name: item.effective.label ?? item.base.name ?? overlayLabel ?? null,
    isWorkingDay: item.effective.isWorkingDay,
    base: item.base,
    effective: item.effective,
    layers: item.layers,
    overlays: item.overlays,
  }
}

export interface FetchEffectiveCalendarOptions {
  from: string
  to: string
  userId?: string
  groupId?: string
  orgOnly?: boolean
  draftOverrides?: CalendarEffectiveDraftOverride[]
  suppressUnauthorizedRedirect?: boolean
  signal?: AbortSignal
}

export class EffectiveCalendarFetchError extends Error {
  status: number
  code?: string
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.name = 'EffectiveCalendarFetchError'
    this.status = status
    this.code = code
  }
}

export async function fetchEffectiveCalendar(
  options: FetchEffectiveCalendarOptions,
): Promise<CalendarEffectiveResponse> {
  const { from, to, userId, groupId, orgOnly, suppressUnauthorizedRedirect, signal } = options
  if (!from || !to) {
    throw new Error('fetchEffectiveCalendar: "from" and "to" are required.')
  }
  const modeCount = (userId ? 1 : 0) + (groupId ? 1 : 0) + (orgOnly ? 1 : 0)
  if (modeCount !== 1) {
    throw new Error('fetchEffectiveCalendar: provide exactly one of userId, groupId, or orgOnly=true.')
  }

  const useDraftPreview = Array.isArray(options.draftOverrides)
  if (useDraftPreview) {
    const body: Record<string, unknown> = {
      from,
      to,
      calendarPolicy: { overrides: options.draftOverrides ?? [] },
    }
    if (userId) body.userId = userId
    if (groupId) body.groupId = groupId
    if (orgOnly) body.orgOnly = true

    const response = await apiFetch('/api/attendance/effective-calendar/preview', {
      method: 'POST',
      body: JSON.stringify(body),
      suppressUnauthorizedRedirect: suppressUnauthorizedRedirect ?? true,
      signal,
    })
    let data: any = null
    try {
      data = await response.json()
    } catch {
      data = null
    }
    if (!response.ok || data?.ok === false) {
      const message = data?.error?.message
        ?? `Failed to load effective calendar (HTTP ${response.status}).`
      throw new EffectiveCalendarFetchError(message, response.status, data?.error?.code)
    }
    return data?.data as CalendarEffectiveResponse
  }

  const query = new URLSearchParams({ from, to })
  if (userId) query.set('userId', userId)
  if (groupId) query.set('groupId', groupId)
  if (orgOnly) query.set('orgOnly', 'true')

  const response = await apiFetch(`/api/attendance/effective-calendar?${query.toString()}`, {
    suppressUnauthorizedRedirect: suppressUnauthorizedRedirect ?? true,
    signal,
  })
  let data: any = null
  try {
    data = await response.json()
  } catch {
    data = null
  }
  if (!response.ok || data?.ok === false) {
    const message = data?.error?.message
      ?? `Failed to load effective calendar (HTTP ${response.status}).`
    throw new EffectiveCalendarFetchError(message, response.status, data?.error?.code)
  }
  return data?.data as CalendarEffectiveResponse
}
