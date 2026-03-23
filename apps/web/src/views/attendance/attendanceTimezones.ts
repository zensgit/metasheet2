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

export interface TimezoneOptionEntry {
  value: string
  label: string
}

function loadSupportedTimezones(): string[] {
  if (cachedSupportedTimezones) return cachedSupportedTimezones

  const resolved = (() => {
    try {
      if (typeof Intl.supportedValuesOf === 'function') {
        const values = Intl.supportedValuesOf('timeZone')
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

export function buildTimezoneOptions(currentValue?: string | null): string[] {
  const normalized = typeof currentValue === 'string' ? currentValue.trim() : ''
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
  const normalized = typeof timezone === 'string' ? timezone.trim() : ''
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
