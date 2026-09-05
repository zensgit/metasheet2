/**
 * Employee 补卡申请 card prefill (2026-08-29).
 *
 * Display / form-UX only. Mirrors the existing
 * `openMissingPunchQuickAction` rule: first non-pending anomaly wins;
 * pending-only / empty lists stay hand-fill. Do not invent an anomaly type.
 *
 * Makeup time writes the same `requestedInAt` / `requestedOutAt` fields the
 * shared request form already POSTs to `/api/attendance/requests`.
 */

export type MakeupRequestTypeField = 'requestedInAt' | 'requestedOutAt'

export interface MakeupAnomalyPrefillItem {
  recordId: string
  workDate: string
  state?: string | null
  suggestedRequestType?: string | null
}

type TranslateFn = (en: string, zh: string) => string

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

const MAKEUP_TYPE_LABELS: Record<string, [string, string]> = {
  missed_check_in: ['Missing check-in', '上班缺卡'],
  missed_check_out: ['Missing check-out', '下班缺卡'],
  time_correction: ['Time correction', '时间更正'],
}

export function isEligibleMakeupAnomaly(item: { state?: string | null } | null | undefined): boolean {
  return Boolean(item) && item?.state !== 'pending'
}

export function firstEligibleMakeupAnomaly<T extends { state?: string | null }>(
  items: readonly T[] | null | undefined,
): T | null {
  if (!items) return null
  return items.find(isEligibleMakeupAnomaly) ?? null
}

export function makeupAnomalyKey(item: Pick<MakeupAnomalyPrefillItem, 'recordId' | 'workDate'>): string {
  return `${item.recordId}::${item.workDate}`
}

export function resolveMakeupRequestType(item: Pick<MakeupAnomalyPrefillItem, 'suggestedRequestType'> | null): string {
  const suggested = String(item?.suggestedRequestType ?? '').trim()
  return suggested.length > 0 ? suggested : 'time_correction'
}

export function resolveMakeupCardPrefill(
  items: readonly MakeupAnomalyPrefillItem[] | null | undefined,
  fallbackWorkDate: string,
): { workDate: string; requestType: string; anomaly: MakeupAnomalyPrefillItem | null } {
  const anomaly = firstEligibleMakeupAnomaly(items ?? [])
  if (!anomaly) {
    return {
      workDate: fallbackWorkDate,
      requestType: 'missed_check_in',
      anomaly: null,
    }
  }
  return {
    workDate: anomaly.workDate,
    requestType: resolveMakeupRequestType(anomaly),
    anomaly,
  }
}

export function makeupTimeFieldForRequestType(requestType: string | null | undefined): MakeupRequestTypeField {
  return requestType === 'missed_check_out' ? 'requestedOutAt' : 'requestedInAt'
}

export function workDateFromDateTimeLocal(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})/)
  return match ? match[1] : null
}

export function shiftDateOnlyKey(dateKey: string, dayDelta: number): string | null {
  const match = dateKey.match(DATE_ONLY)
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + dayDelta)
  if (Number.isNaN(date.getTime())) return null
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export function formatMakeupAnomalyDateLabel(
  workDate: string,
  todayKey: string,
  tr: TranslateFn,
): string {
  if (workDate === todayKey) return tr('Today', '今天')
  const yesterday = shiftDateOnlyKey(todayKey, -1)
  if (yesterday && workDate === yesterday) return tr('Yesterday', '昨天')
  const match = workDate.match(DATE_ONLY)
  if (!match) return workDate
  const month = Number(match[2])
  const day = Number(match[3])
  return tr(`${month}/${day}`, `${month}月${day}日`)
}

export function formatMakeupAnomalyTypeLabel(
  requestType: string | null | undefined,
  tr: TranslateFn,
): string {
  const type = String(requestType ?? '').trim()
  const pair = MAKEUP_TYPE_LABELS[type]
  if (!pair) return type
  return tr(pair[0], pair[1])
}

export function formatMakeupAnomalyOptionLabel(
  item: Pick<MakeupAnomalyPrefillItem, 'workDate' | 'suggestedRequestType'>,
  todayKey: string,
  tr: TranslateFn,
): string {
  const dateLabel = formatMakeupAnomalyDateLabel(item.workDate, todayKey, tr)
  const typeLabel = formatMakeupAnomalyTypeLabel(resolveMakeupRequestType(item), tr)
  return `${dateLabel} · ${typeLabel}`
}
