/**
 * Employee leave-card duration display (2026-08-28).
 *
 * Display-only conversion for the dedicated 请假申请 card. Backend minutes stay
 * the write-path source of truth. Hours are shown in 0.5-hour steps only
 * (8, 8.5, 9 — never 8.3). 8.5 hours = 510 minutes.
 *
 * This module does NOT invent a leave-day length. Day length continues to come
 * from each leave type's `defaultMinutesPerDay` via `halfDayLeaveHelper.ts`.
 * The only constant here is 60 minutes per hour (30-minute half steps).
 */

export const LEAVE_DURATION_HALF_HOUR_MINUTES = 30

export type LeaveDurationDisplayUnit = 'hours' | 'minutes'

export function parseDateTimeLocalMs(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text.length === 0) return null
  const ms = new Date(text).getTime()
  return Number.isFinite(ms) ? ms : null
}

export function snapMinutesToHalfHour(minutes: number): number {
  if (!Number.isFinite(minutes) || minutes < 0) return 0
  return Math.round(minutes / LEAVE_DURATION_HALF_HOUR_MINUTES) * LEAVE_DURATION_HALF_HOUR_MINUTES
}

/** Wall-clock span between two `datetime-local` values, snapped to 0.5 hours. */
export function minutesFromDateTimeRange(
  startLocal: string | null | undefined,
  endLocal: string | null | undefined,
): number | null {
  const start = parseDateTimeLocalMs(startLocal)
  const end = parseDateTimeLocalMs(endLocal)
  if (start === null || end === null || end <= start) return null
  return snapMinutesToHalfHour((end - start) / 60_000)
}

export function hoursFromLeaveMinutes(
  minutes: number | string | null | undefined,
): number | null {
  const text = typeof minutes === 'number' ? String(minutes) : String(minutes ?? '').trim()
  if (text.length === 0) return null
  const value = Number(text)
  if (!Number.isFinite(value) || value < 0) return null
  return Math.round(value / LEAVE_DURATION_HALF_HOUR_MINUTES) / 2
}

export function formatLeaveDurationHours(
  minutes: number | string | null | undefined,
): string {
  const hours = hoursFromLeaveMinutes(minutes)
  if (hours === null) return ''
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1)
}

export function workDateFromDateTimeLocal(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})/)
  return match ? match[1] : null
}
