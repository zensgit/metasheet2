export type CalendarPolicySource = 'org' | 'group' | 'role' | 'user'
export type CalendarPolicyMatch = 'contains' | 'regex' | 'equals'

export interface CalendarPolicyOverrideWire {
  id?: string
  name?: string
  match?: CalendarPolicyMatch
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
    source: CalendarPolicySource
  }
}

export interface CalendarPolicyOverrideFormState {
  id?: string
  name: string
  match: CalendarPolicyMatch
  date: string
  from: string
  to: string
  dayIndexStart?: number | null
  dayIndexEnd?: number | null
  dayIndexList?: string
  source: CalendarPolicySource
  isWorkingDay: boolean
  label: string
  attendanceGroups?: string
  roles?: string
  roleTags?: string
  userIds?: string
  userNames?: string
  excludeUserIds?: string
  excludeUserNames?: string
}

export type CalendarPolicyOverrideDiagnosticCode =
  | 'missing_scope'
  | 'invalid_date_range'
  | 'shadowed_same_source'

export interface CalendarPolicyOverrideDiagnostic {
  key: string
  code: CalendarPolicyOverrideDiagnosticCode
  severity: 'warning'
  primaryIndex: number
  secondaryIndex?: number
  source: CalendarPolicySource
}

function listToText(list?: Array<string | number>): string {
  return Array.isArray(list) ? list.join(',') : ''
}

function splitListText(value?: string): string[] {
  if (!value) return []
  return value
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function splitNumberList(value?: string): number[] {
  if (!value) return []
  return value
    .split(/[\n,\s]+/)
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item >= 1)
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) && num >= 1 ? num : undefined
}

function normalizeListKey(value?: string): string {
  return splitListText(value)
    .map((item) => item.toLocaleLowerCase())
    .sort((left, right) => left.localeCompare(right))
    .join(',')
}

function normalizeTextKey(value?: string): string {
  return (value ?? '').trim().toLocaleLowerCase()
}

function dateKey(value?: string): string {
  const trimmed = (value ?? '').trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : ''
}

function getDateSpan(form: CalendarPolicyOverrideFormState): { start: string; end: string } | null {
  const singleDate = dateKey(form.date)
  if (singleDate) return { start: singleDate, end: singleDate }
  const from = dateKey(form.from)
  const to = dateKey(form.to)
  if (!from || !to || from > to) return null
  return { start: from, end: to }
}

function hasInvalidDateRange(form: CalendarPolicyOverrideFormState): boolean {
  const from = dateKey(form.from)
  const to = dateKey(form.to)
  return Boolean(from && to && from > to)
}

function dateSpansOverlap(
  left: { start: string; end: string },
  right: { start: string; end: string },
): boolean {
  return left.start <= right.end && right.start <= left.end
}

function dayIndexKey(form: CalendarPolicyOverrideFormState): string {
  return [
    normalizeOptionalNumber(form.dayIndexStart) ?? '',
    normalizeOptionalNumber(form.dayIndexEnd) ?? '',
    splitNumberList(form.dayIndexList).sort((left, right) => left - right).join(','),
  ].join(':')
}

function calendarPolicyTargetKey(form: CalendarPolicyOverrideFormState): string {
  const source = normalizeCalendarPolicySource(form.source)
  return [
    source,
    normalizeTextKey(form.name),
    normalizeCalendarPolicyMatch(form.match),
    dayIndexKey(form),
    normalizeListKey(form.attendanceGroups),
    normalizeListKey(form.roles),
    normalizeListKey(form.roleTags),
    normalizeListKey(form.userIds),
    normalizeListKey(form.userNames),
    normalizeListKey(form.excludeUserIds),
    normalizeListKey(form.excludeUserNames),
  ].join('|')
}

function effectiveValueKey(form: CalendarPolicyOverrideFormState): string {
  return `${form.isWorkingDay === true ? 'work' : 'rest'}:${normalizeTextKey(form.label)}`
}

function normalizeCalendarPolicySource(value: unknown): CalendarPolicySource {
  return value === 'group' || value === 'role' || value === 'user' ? value : 'org'
}

function normalizeCalendarPolicyMatch(value: unknown): CalendarPolicyMatch {
  return value === 'regex' || value === 'equals' ? value : 'contains'
}

export function createDefaultCalendarPolicyOverrideForm(): CalendarPolicyOverrideFormState {
  return {
    name: '',
    match: 'contains',
    date: '',
    from: '',
    to: '',
    dayIndexStart: null,
    dayIndexEnd: null,
    dayIndexList: '',
    source: 'org',
    isWorkingDay: true,
    label: '',
    attendanceGroups: '',
    roles: '',
    roleTags: '',
    userIds: '',
    userNames: '',
    excludeUserIds: '',
    excludeUserNames: '',
  }
}

export function calendarPolicyOverridesToForm(
  overrides: CalendarPolicyOverrideWire[] | undefined,
): CalendarPolicyOverrideFormState[] {
  if (!Array.isArray(overrides)) return []
  return overrides.map((override) => ({
    id: typeof override.id === 'string' && override.id.trim() ? override.id.trim() : undefined,
    name: typeof override.name === 'string' ? override.name : '',
    match: normalizeCalendarPolicyMatch(override.match),
    date: typeof override.date === 'string' ? override.date : '',
    from: typeof override.from === 'string' ? override.from : '',
    to: typeof override.to === 'string' ? override.to : '',
    dayIndexStart: override.dayIndexStart ?? null,
    dayIndexEnd: override.dayIndexEnd ?? null,
    dayIndexList: listToText(override.dayIndexList),
    source: normalizeCalendarPolicySource(override.effective?.source),
    isWorkingDay: override.effective?.isWorkingDay === true,
    label: typeof override.effective?.label === 'string' ? override.effective.label : '',
    attendanceGroups: listToText(override.filters?.attendanceGroups),
    roles: listToText(override.filters?.roles),
    roleTags: listToText(override.filters?.roleTags),
    userIds: listToText(override.filters?.userIds),
    userNames: listToText(override.filters?.userNames),
    excludeUserIds: listToText(override.filters?.excludeUserIds),
    excludeUserNames: listToText(override.filters?.excludeUserNames),
  }))
}

function hasCalendarPolicyConstraint(form: CalendarPolicyOverrideFormState): boolean {
  return Boolean(
    form.date?.trim()
    || form.from?.trim()
    || form.to?.trim()
    || form.name?.trim()
    || normalizeOptionalNumber(form.dayIndexStart)
    || normalizeOptionalNumber(form.dayIndexEnd)
    || splitNumberList(form.dayIndexList).length > 0,
  )
}

function hasRequiredSourceFilter(form: CalendarPolicyOverrideFormState): boolean {
  if (form.source === 'group') return splitListText(form.attendanceGroups).length > 0
  if (form.source === 'role') {
    return splitListText(form.roles).length > 0 || splitListText(form.roleTags).length > 0
  }
  if (form.source === 'user') {
    return splitListText(form.userIds).length > 0 || splitListText(form.userNames).length > 0
  }
  return true
}

export function buildCalendarPolicyOverrideDiagnostics(
  forms: CalendarPolicyOverrideFormState[] | undefined,
): CalendarPolicyOverrideDiagnostic[] {
  if (!Array.isArray(forms)) return []

  const diagnostics: CalendarPolicyOverrideDiagnostic[] = []
  const comparableRows: Array<{
    index: number
    source: CalendarPolicySource
    span: { start: string; end: string }
    targetKey: string
    effectiveKey: string
  }> = []

  forms.forEach((form, index) => {
    if (!hasCalendarPolicyConstraint(form)) return
    const source = normalizeCalendarPolicySource(form.source)
    if (!hasRequiredSourceFilter(form)) {
      diagnostics.push({
        key: `missing-scope:${index}`,
        code: 'missing_scope',
        severity: 'warning',
        primaryIndex: index,
        source,
      })
      return
    }
    if (hasInvalidDateRange(form)) {
      diagnostics.push({
        key: `invalid-date-range:${index}`,
        code: 'invalid_date_range',
        severity: 'warning',
        primaryIndex: index,
        source,
      })
      return
    }
    const span = getDateSpan(form)
    if (!span) return
    comparableRows.push({
      index,
      source,
      span,
      targetKey: calendarPolicyTargetKey(form),
      effectiveKey: effectiveValueKey(form),
    })
  })

  for (let leftIndex = 0; leftIndex < comparableRows.length; leftIndex += 1) {
    const left = comparableRows[leftIndex]
    if (!left) continue
    for (let rightIndex = leftIndex + 1; rightIndex < comparableRows.length; rightIndex += 1) {
      const right = comparableRows[rightIndex]
      if (!right) continue
      if (left.source !== right.source) continue
      if (left.targetKey !== right.targetKey) continue
      if (left.effectiveKey === right.effectiveKey) continue
      if (!dateSpansOverlap(left.span, right.span)) continue
      diagnostics.push({
        key: `shadowed-same-source:${left.index}:${right.index}`,
        code: 'shadowed_same_source',
        severity: 'warning',
        primaryIndex: left.index,
        secondaryIndex: right.index,
        source: left.source,
      })
    }
  }

  return diagnostics
}

export function calendarPolicyOverridesFromForm(
  forms: CalendarPolicyOverrideFormState[] | undefined,
): CalendarPolicyOverrideWire[] {
  if (!Array.isArray(forms)) return []
  return forms
    .filter((form) => hasCalendarPolicyConstraint(form) && hasRequiredSourceFilter(form))
    .map((form) => {
      const filters: NonNullable<CalendarPolicyOverrideWire['filters']> = {}
      const userIds = splitListText(form.userIds)
      const userNames = splitListText(form.userNames)
      const excludeUserIds = splitListText(form.excludeUserIds)
      const excludeUserNames = splitListText(form.excludeUserNames)
      const attendanceGroups = splitListText(form.attendanceGroups)
      const roles = splitListText(form.roles)
      const roleTags = splitListText(form.roleTags)
      if (userIds.length) filters.userIds = userIds
      if (userNames.length) filters.userNames = userNames
      if (excludeUserIds.length) filters.excludeUserIds = excludeUserIds
      if (excludeUserNames.length) filters.excludeUserNames = excludeUserNames
      if (attendanceGroups.length) filters.attendanceGroups = attendanceGroups
      if (roles.length) filters.roles = roles
      if (roleTags.length) filters.roleTags = roleTags

      return {
        id: form.id?.trim() || undefined,
        name: form.name?.trim() || undefined,
        match: form.name?.trim() ? form.match || 'contains' : undefined,
        date: form.date?.trim() || undefined,
        from: form.from?.trim() || undefined,
        to: form.to?.trim() || undefined,
        dayIndexStart: normalizeOptionalNumber(form.dayIndexStart),
        dayIndexEnd: normalizeOptionalNumber(form.dayIndexEnd),
        dayIndexList: splitNumberList(form.dayIndexList),
        filters: Object.keys(filters).length > 0 ? filters : undefined,
        effective: {
          isWorkingDay: form.isWorkingDay === true,
          label: form.label?.trim() || undefined,
          source: normalizeCalendarPolicySource(form.source),
        },
      }
    })
}
