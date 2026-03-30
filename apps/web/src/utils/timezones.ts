export interface TimezoneOption {
  value: string
  label: string
  offsetMinutes: number
}

const FALLBACK_TIMEZONES = [
  'UTC',
  'Asia/Shanghai',
  'Asia/Tokyo',
  'Asia/Singapore',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Los_Angeles',
  'Australia/Sydney',
] as const

const formatterCache = new Map<string, Intl.DateTimeFormat>()
const labelCache = new Map<string, string>()
let supportedTimezonesCache: string[] | null = null

function isValidTimezone(timeZone: string): boolean {
  try {
    getFormatter(timeZone)
    return true
  } catch {
    return false
  }
}

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    formatterCache.set(timeZone, formatter)
  }
  return formatter
}

function getSupportedTimezones(): string[] {
  if (supportedTimezonesCache) return supportedTimezonesCache

  const intlWithSupportedValues = globalThis.Intl as unknown as {
    supportedValuesOf?: (key: string) => string[]
  }

  const supported = intlWithSupportedValues.supportedValuesOf?.('timeZone')
  const resolved = supported && supported.length > 0
    ? supported.slice()
    : [...FALLBACK_TIMEZONES]
  supportedTimezonesCache = resolved
  return resolved
}

export function getTimezoneOffsetMinutes(timeZone: string, at = new Date()): number {
  const formatter = getFormatter(timeZone)
  const parts = formatter.formatToParts(at)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  const year = Number(values.year)
  const month = Number(values.month)
  const day = Number(values.day)
  const hour = Number(values.hour)
  const minute = Number(values.minute)
  const second = Number(values.second)

  if ([year, month, day, hour, minute, second].some(value => Number.isNaN(value))) {
    return 0
  }

  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second)
  return Math.round((asUtc - at.getTime()) / 60000)
}

export function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absolute = Math.abs(offsetMinutes)
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0')
  const minutes = String(absolute % 60).padStart(2, '0')
  return `UTC${sign}${hours}:${minutes}`
}

export function formatTimezoneLabel(timeZone: string | null | undefined, at = new Date()): string {
  const normalized = String(timeZone || '').trim()
  if (!normalized) return '--'

  const cacheKey = `${normalized}|${at.toISOString().slice(0, 10)}`
  const cached = labelCache.get(cacheKey)
  if (cached) return cached

  try {
    const offsetMinutes = getTimezoneOffsetMinutes(normalized, at)
    const label = `${formatUtcOffset(offsetMinutes)} · ${normalized}`
    labelCache.set(cacheKey, label)
    return label
  } catch {
    return normalized
  }
}

export function buildTimezoneOptions(
  preferredTimezones: Array<string | null | undefined> = [],
  at = new Date(),
): TimezoneOption[] {
  const supportedTimezones = getSupportedTimezones()
  const deduped = new Set<string>()
  const ordered: string[] = []

  for (const zone of preferredTimezones) {
    const normalized = String(zone || '').trim()
    if (!normalized || deduped.has(normalized) || !isValidTimezone(normalized)) continue
    deduped.add(normalized)
    ordered.push(normalized)
  }

  const remaining = supportedTimezones
    .filter(zone => !deduped.has(zone))
    .map(zone => ({
      value: zone,
      offsetMinutes: getTimezoneOffsetMinutes(zone, at),
    }))
    .sort((left, right) => left.offsetMinutes - right.offsetMinutes || left.value.localeCompare(right.value))
    .map(item => item.value)

  for (const zone of remaining) {
    deduped.add(zone)
    ordered.push(zone)
  }

  return ordered.map(value => {
    const offsetMinutes = getTimezoneOffsetMinutes(value, at)
    return {
      value,
      label: `${formatUtcOffset(offsetMinutes)} · ${value}`,
      offsetMinutes,
    }
  })
}
