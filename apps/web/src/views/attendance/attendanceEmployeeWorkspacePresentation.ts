// View-layer-only helpers for the employee overview chrome.
// Do not use these to change punch, policy, approval, or API contracts.

export type WorkspaceTranslateFn = (en: string, zh: string) => string

const EMPTY_WINDOW = new Set(['', '—', '-', '–', '—'])

export function parseClockHour(clockTime: string | null | undefined): number | null {
  if (!clockTime) return null
  const match = clockTime.trim().match(/^(\d{1,2}):/)
  if (!match) return null
  const hour = Number(match[1])
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null
  return hour
}

export function greetingHeadline(tr: WorkspaceTranslateFn, clockTime: string | null | undefined): string {
  const hour = parseClockHour(clockTime)
  if (hour != null && hour >= 18) return tr('Good evening', '晚上好')
  if (hour != null && hour >= 12) return tr('Good afternoon', '下午好')
  return tr('Good morning', '早上好')
}

export function formatWorkDurationMinutes(
  minutes: number | null | undefined,
  tr: WorkspaceTranslateFn,
): string {
  if (minutes == null || !Number.isFinite(minutes) || minutes < 0) return '—'
  const rounded = Math.round(minutes)
  const hours = Math.floor(rounded / 60)
  const rest = rounded % 60
  if (hours === 0) return tr(`${rest}m`, `${rest}分`)
  if (rest === 0) return tr(`${hours}h`, `${hours}小时`)
  return tr(`${hours}h ${rest}m`, `${hours}小时${rest}分`)
}

export function formatMinuteCount(minutes: number, tr: WorkspaceTranslateFn): string {
  if (!Number.isFinite(minutes) || minutes < 0) return '—'
  const rounded = Math.round(minutes)
  return tr(`${rounded}m`, `${rounded}分`)
}

/** Reformat a parent "18 / 18" pair in the view only. Other shapes pass through. */
export function formatLateEarlyPair(label: string | null | undefined, tr: WorkspaceTranslateFn): string {
  if (!label) return '—'
  const match = label.trim().match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/)
  if (!match) return label
  return `${formatMinuteCount(Number(match[1]), tr)} / ${formatMinuteCount(Number(match[2]), tr)}`
}

export function workWindowShortLabel(summary: string | null | undefined): string | null {
  if (!summary) return null
  const head = summary.split('·')[0]?.trim() ?? ''
  if (EMPTY_WINDOW.has(head) || !/\d{1,2}:\d{2}/.test(head)) return null
  return head
}

export function suggestOffDutyTime(summary: string | null | undefined): string | null {
  const short = workWindowShortLabel(summary)
  if (!short) return null
  const times = short.match(/\d{1,2}:\d{2}/g)
  return times?.at(-1) ?? null
}

export function isClockedIn(
  timeline: { checkIn: string | null; checkOut: string | null } | null | undefined,
  latestPunchLabel: string | null | undefined,
): boolean {
  if (timeline?.checkIn) return true
  if (!latestPunchLabel || latestPunchLabel === '--:--') return false
  return /\d{1,2}:\d{2}/.test(latestPunchLabel)
}
