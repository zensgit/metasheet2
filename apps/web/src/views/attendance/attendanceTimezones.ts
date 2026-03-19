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
