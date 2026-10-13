// View-layer-only helpers for the employee overview chrome.
// Do not use these to change punch, policy, approval, or API contracts.

import type { AttendanceOverviewAttentionKey } from './attendanceOverviewPriority'
import type { WorkspaceDisplayIconId } from './attendanceEmployeeWorkspaceCommonIcons'

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

/**
 * Policy seed for `annualLeavePolicy.standardDayMinutes` and leave-type
 * `defaultMinutesPerDay`. Not a display default: the employee balance card
 * folds days only when `/me` sends that live standard day (#5969).
 */
export const ATTENDANCE_LEAVE_DAY_MINUTES = 480

/**
 * Format a leave-balance minute total.
 *
 * Pass a positive integer `minutesPerDay` (the annual bank day) to fold days.
 * Omit it, or pass a non-positive value, to show hours and minutes only —
 * the card must not guess 480 when the wire has no day ruler. Comp time
 * always uses the hours path.
 */
export function formatLeaveBalanceMinutes(
  minutes: number | null | undefined,
  tr: WorkspaceTranslateFn,
  minutesPerDay?: number | null,
): string {
  if (minutes == null || !Number.isFinite(minutes) || minutes < 0) return '—'
  const rounded = Math.round(minutes)
  const perDay = Number(minutesPerDay)
  const canFoldDays = Number.isInteger(perDay) && perDay > 0
  if (!canFoldDays) {
    if (rounded === 0) return tr('0m', '0分')
    return formatWorkDurationMinutes(rounded, tr)
  }
  if (rounded === 0) return tr('0 days', '0天')

  const days = Math.floor(rounded / perDay)
  const leftover = rounded % perDay
  const leftoverLabel = leftover > 0 ? formatWorkDurationMinutes(leftover, tr) : ''
  if (days === 0) return leftoverLabel
  const daysLabel = days === 1 ? tr('1 day', '1天') : tr(`${days} days`, `${days}天`)
  return leftoverLabel ? `${daysLabel} ${leftoverLabel}` : daysLabel
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
): boolean {
  return Boolean(timeline?.checkIn && !timeline.checkOut)
}

export type HeroPunchEmphasis = 'check_in' | 'check_out' | 'complete'

/** Next punch CTA only — never disables a button or changes emit payloads. */
export function resolveHeroPunchEmphasis(
  timeline: { checkIn: string | null; checkOut: string | null } | null | undefined,
): HeroPunchEmphasis {
  if (timeline?.checkIn && timeline.checkOut) return 'complete'
  if (isClockedIn(timeline)) return 'check_out'
  return 'check_in'
}

export type TodoMarkTone = 'makeup' | 'leave' | 'review' | 'setup' | 'clear'

export interface TodoMarkPresentation {
  icon: WorkspaceDisplayIconId
  tone: TodoMarkTone
}

/** 缺卡 / anomaly (and punch-failure) rows keep the makeup 面性 icon. */
export function resolveTodoMark(key: AttendanceOverviewAttentionKey): TodoMarkPresentation {
  switch (key) {
    case 'anomaly':
    case 'punch_failure':
      return { icon: 'clock-plus', tone: 'makeup' }
    case 'request_pending':
    case 'request_rejected':
      return { icon: 'calendar', tone: 'leave' }
    case 'record_review':
    case 'unknown_status':
      return { icon: 'pin', tone: 'review' }
    case 'setup_needed':
      return { icon: 'user', tone: 'setup' }
    case 'all_clear':
    default:
      return { icon: 'check', tone: 'clear' }
  }
}
