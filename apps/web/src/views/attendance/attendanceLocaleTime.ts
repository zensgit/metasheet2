export type LocaleTimePeriod = 'am' | 'pm'

export interface LocaleTimeParts {
  hour12: number
  minute: number
  period: LocaleTimePeriod
}

const PERIOD_PM = /下午|晚上|pm/i
const PERIOD_AM = /上午|凌晨|早上|am/i

export function parseStoredTime(value: string): LocaleTimeParts | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec((value || '').trim())
  if (!match) return null
  const hour24 = Number(match[1])
  const minute = Number(match[2])
  if (hour24 > 23 || minute > 59) return null
  const period: LocaleTimePeriod = hour24 >= 12 ? 'pm' : 'am'
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12
  return { hour12, minute, period }
}

export function composeStoredTime(hour12: number, minute: number, period: LocaleTimePeriod): string {
  let hour24 = hour12 % 12
  if (period === 'pm') hour24 += 12
  return `${String(hour24).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export function formatLocaleTimeInput(value: string, locale: 'zh' | 'en'): string {
  const parts = parseStoredTime(value)
  if (!parts) return ''
  const period = locale === 'zh'
    ? (parts.period === 'pm' ? '下午' : '上午')
    : (parts.period === 'pm' ? 'PM' : 'AM')
  return `${parts.hour12}:${String(parts.minute).padStart(2, '0')} ${period}`
}

/** Accepts 9:00, 18:00, 9:00上午, 上午9:00, 6:00 PM. Returns 24-hour HH:mm, or null. */
export function parseLocaleTimeInput(raw: string): string | null {
  const compact = raw.trim().replace(/：/g, ':').replace(/\s+/g, '')
  if (!compact) return null
  let period: LocaleTimePeriod | null = null
  let rest = compact
  if (PERIOD_PM.test(rest)) {
    period = 'pm'
    rest = rest.replace(PERIOD_PM, '')
  } else if (PERIOD_AM.test(rest)) {
    period = 'am'
    rest = rest.replace(PERIOD_AM, '')
  }
  const match = /^(\d{1,2})(?::(\d{1,2}))?$/.exec(rest)
  if (!match) return null
  let hour = Number(match[1])
  const minute = match[2] === undefined ? 0 : Number(match[2])
  if (minute > 59 || hour > 23) return null
  if (period) {
    if (hour === 0) hour = 0
    else if (hour > 12) {
      // 18:00下午 still means 18:00.
    } else if (hour === 12) hour = period === 'am' ? 0 : 12
    else if (period === 'pm') hour += 12
  }
  if (hour > 23) return null
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}
