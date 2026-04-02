const FALLBACK_TIMEZONES = [
  'UTC',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Asia/Hong_Kong',
  'Asia/Seoul',
  'Europe/London',
  'Europe/Paris',
  'America/New_York',
  'America/Los_Angeles',
]

let cachedSupportedTimezones: string[] | null = null

const intlWithSupportedValues = Intl as typeof Intl & {
  supportedValuesOf?: (key: string) => string[]
}

export interface TimezoneOptionEntry {
  value: string
  label: string
}

export interface TimezoneOptionGroupEntry {
  id: string
  labelEn: string
  labelZh: string
  options: TimezoneOptionEntry[]
}

const COMMON_TIMEZONES = [
  'UTC',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Asia/Hong_Kong',
  'Asia/Seoul',
  'Europe/London',
  'Europe/Paris',
  'America/New_York',
  'America/Los_Angeles',
]

const TIMEZONE_GROUPS: Array<{
  id: string
  labelEn: string
  labelZh: string
}> = [
  { id: 'common', labelEn: 'Common timezones', labelZh: '常用时区' },
  { id: 'Asia', labelEn: 'Asia', labelZh: '亚洲' },
  { id: 'Europe', labelEn: 'Europe', labelZh: '欧洲' },
  { id: 'America', labelEn: 'Americas', labelZh: '美洲' },
  { id: 'Pacific', labelEn: 'Pacific', labelZh: '太平洋' },
  { id: 'Australia', labelEn: 'Australia', labelZh: '澳洲' },
  { id: 'Africa', labelEn: 'Africa', labelZh: '非洲' },
  { id: 'Atlantic', labelEn: 'Atlantic', labelZh: '大西洋' },
  { id: 'Indian', labelEn: 'Indian Ocean', labelZh: '印度洋' },
  { id: 'Antarctica', labelEn: 'Antarctica', labelZh: '南极洲' },
  { id: 'Arctic', labelEn: 'Arctic', labelZh: '北极' },
  { id: 'Etc', labelEn: 'Etc / UTC', labelZh: 'Etc / UTC' },
  { id: 'custom', labelEn: 'Other / custom', labelZh: '其他 / 自定义' },
]

function loadSupportedTimezones(): string[] {
  if (cachedSupportedTimezones) return cachedSupportedTimezones

  const resolved = (() => {
    try {
      if (typeof intlWithSupportedValues.supportedValuesOf === 'function') {
        const values = intlWithSupportedValues.supportedValuesOf('timeZone')
        if (Array.isArray(values) && values.length > 0) return values.filter((item) => typeof item === 'string')
      }
    } catch {
      // fall through to fallback list
    }
    return FALLBACK_TIMEZONES
  })()

  cachedSupportedTimezones = Array.from(new Set([...resolved, ...FALLBACK_TIMEZONES])).sort((a, b) => a.localeCompare(b))
  return cachedSupportedTimezones
}

function resolveLocalTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  } catch {
    return ''
  }
}

function normalizeTimezoneValue(value?: string | null): string {
  return typeof value === 'string' ? value.trim() : ''
}

function resolveTimezoneGroupId(timezone: string): string {
  if (!timezone) return 'custom'
  if (timezone === 'UTC') return 'common'

  const [region] = timezone.split('/')
  if (TIMEZONE_GROUPS.some((item) => item.id === region)) {
    return region
  }
  return 'custom'
}

export function buildTimezoneOptions(currentValue?: string | null): string[] {
  const normalized = normalizeTimezoneValue(currentValue)
  const options = [...loadSupportedTimezones()]
  if (normalized && !options.includes(normalized)) {
    options.unshift(normalized)
  }
  return options
}

export function formatTimezoneOffsetLabel(timezone?: string | null, date = new Date()): string {
  const normalized = typeof timezone === 'string' ? timezone.trim() : ''
  if (!normalized) return ''

  try {
    const timeZoneName = new Intl.DateTimeFormat('en-US', {
      timeZone: normalized,
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'shortOffset',
    })
      .formatToParts(date)
      .find((part) => part.type === 'timeZoneName')
      ?.value

    if (!timeZoneName) return ''
    if (timeZoneName === 'GMT' || timeZoneName === 'UTC') return 'UTC+00:00'

    const match = timeZoneName.match(/^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/)
    if (!match) return ''

    const [, sign, hours, minutes = '00'] = match
    return `UTC${sign}${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`
  } catch {
    return ''
  }
}

export function formatTimezoneOptionLabel(timezone?: string | null, date = new Date()): string {
  const normalized = normalizeTimezoneValue(timezone)
  if (!normalized) return ''

  const offsetLabel = formatTimezoneOffsetLabel(normalized, date)
  return offsetLabel ? `${normalized} (${offsetLabel})` : normalized
}

export function buildTimezoneOptionEntries(currentValue?: string | null): TimezoneOptionEntry[] {
  return buildTimezoneOptions(currentValue).map((value) => ({
    value,
    label: formatTimezoneOptionLabel(value),
  }))
}

export function buildTimezoneOptionGroups(currentValue?: string | null): TimezoneOptionGroupEntry[] {
  const options = buildTimezoneOptions(currentValue)
  const normalizedCurrent = normalizeTimezoneValue(currentValue)
  const localTimezone = normalizeTimezoneValue(resolveLocalTimezone())
  const optionSet = new Set(options)

  const commonOrder = Array.from(new Set([
    normalizedCurrent,
    localTimezone,
    ...COMMON_TIMEZONES,
  ].filter(Boolean)))

  const commonSet = new Set(commonOrder.filter((item) => optionSet.has(item)))
  const groups = new Map<string, string[]>()

  if (commonSet.size > 0) {
    groups.set('common', commonOrder.filter((item) => commonSet.has(item)))
  }

  for (const option of options) {
    if (commonSet.has(option)) continue
    const groupId = resolveTimezoneGroupId(option)
    const group = groups.get(groupId)
    if (group) {
      group.push(option)
      continue
    }
    groups.set(groupId, [option])
  }

  return TIMEZONE_GROUPS
    .map((group) => {
      const entries = groups.get(group.id) ?? []
      if (entries.length === 0) return null
      return {
        id: group.id,
        labelEn: group.labelEn,
        labelZh: group.labelZh,
        options: entries.map((value) => ({
          value,
          label: formatTimezoneOptionLabel(value),
        })),
      }
    })
    .filter((group): group is TimezoneOptionGroupEntry => Boolean(group))
}
