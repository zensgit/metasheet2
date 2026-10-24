/**
 * Employee/admin early check for overtime rule min/max (#5985).
 *
 * Lockstep with `resolveOvertimeWriteMinutes` in `plugins/plugin-attendance/index.cjs`.
 * The server remains the write-path source of truth. This module only mirrors that
 * contract so the form can reject the same values before POST.
 *
 * `applyOvertimeRule` still raises and clamps for segmentation snapshots. This helper
 * does not: below min and above max (including after rounding) are rejections.
 */

export const OVERTIME_MINUTES_BELOW_MIN = 'OVERTIME_MINUTES_BELOW_MIN'
export const OVERTIME_MINUTES_ABOVE_MAX = 'OVERTIME_MINUTES_ABOVE_MAX'
export const OVERTIME_RULE_BOUNDS_INVALID = 'OVERTIME_RULE_BOUNDS_INVALID'

export interface OvertimeRuleBounds {
  minMinutes?: number | null
  roundingMinutes?: number | null
  maxMinutesPerDay?: number | null
}

export interface OvertimeWriteMinutesOk {
  ok: true
  minutes: number
}

export interface OvertimeWriteMinutesRejected {
  ok: false
  code: string
  submittedMinutes: number
  limit: number | null
  roundedMinutes: number | null
}

export type OvertimeWriteMinutesResult = OvertimeWriteMinutesOk | OvertimeWriteMinutesRejected

export function overtimeRuleBoundNumbers(rule: OvertimeRuleBounds | null | undefined): {
  minMinutes: number
  roundingMinutes: number
  maxMinutesPerDay: number
} {
  const minRaw = Math.max(0, Number(rule?.minMinutes ?? 0))
  const roundingRaw = Math.max(1, Number(rule?.roundingMinutes ?? 1))
  const maxRaw = Math.max(0, Number(rule?.maxMinutesPerDay ?? 0))
  return {
    minMinutes: Number.isFinite(minRaw) ? minRaw : 0,
    roundingMinutes: Number.isFinite(roundingRaw) ? roundingRaw : 1,
    maxMinutesPerDay: Number.isFinite(maxRaw) ? maxRaw : 0,
  }
}

function roundOvertimeMinutes(minutes: number, roundingMinutes: number): number {
  if (Number.isFinite(roundingMinutes) && roundingMinutes > 1) {
    return Math.ceil(minutes / roundingMinutes) * roundingMinutes
  }
  return minutes
}

export function resolveOvertimeWriteMinutes(
  minutes: number,
  rule: OvertimeRuleBounds | null | undefined,
): OvertimeWriteMinutesResult {
  const submitted = Number(minutes)
  if (!rule) return { ok: true, minutes: submitted }
  const { minMinutes, roundingMinutes, maxMinutesPerDay } = overtimeRuleBoundNumbers(rule)
  if (maxMinutesPerDay > 0 && minMinutes > maxMinutesPerDay) {
    return {
      ok: false,
      code: OVERTIME_RULE_BOUNDS_INVALID,
      submittedMinutes: submitted,
      limit: null,
      roundedMinutes: null,
    }
  }
  if (minMinutes > 0 && submitted < minMinutes) {
    return {
      ok: false,
      code: OVERTIME_MINUTES_BELOW_MIN,
      submittedMinutes: submitted,
      limit: minMinutes,
      roundedMinutes: null,
    }
  }
  if (maxMinutesPerDay > 0 && submitted > maxMinutesPerDay) {
    return {
      ok: false,
      code: OVERTIME_MINUTES_ABOVE_MAX,
      submittedMinutes: submitted,
      limit: maxMinutesPerDay,
      roundedMinutes: null,
    }
  }
  const rounded = roundOvertimeMinutes(submitted, roundingMinutes)
  if (maxMinutesPerDay > 0 && rounded > maxMinutesPerDay) {
    return {
      ok: false,
      code: OVERTIME_MINUTES_ABOVE_MAX,
      submittedMinutes: submitted,
      limit: maxMinutesPerDay,
      roundedMinutes: rounded,
    }
  }
  return { ok: true, minutes: rounded }
}

export function effectiveOvertimeSubmittedMinutes(input: {
  minutes?: string | number | null
  requestedInAt?: string | null
  requestedOutAt?: string | null
}): number | null {
  const text = input.minutes === undefined || input.minutes === null ? '' : String(input.minutes).trim()
  if (text.length > 0) {
    const parsed = Number(text)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  const start = input.requestedInAt ? new Date(input.requestedInAt).getTime() : Number.NaN
  const end = input.requestedOutAt ? new Date(input.requestedOutAt).getTime() : Number.NaN
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
  return Math.floor((end - start) / 60000)
}

export function overtimeWriteBoundsCopy(result: OvertimeWriteMinutesRejected): { en: string; zh: string } {
  if (result.code === OVERTIME_RULE_BOUNDS_INVALID) {
    return {
      en: 'This overtime rule is misconfigured: the minimum is higher than the daily maximum. Ask an admin to fix the rule.',
      zh: '该加班规则配置无效：最小分钟数高于每日上限。请联系管理员修正规则。',
    }
  }
  if (result.code === OVERTIME_MINUTES_BELOW_MIN) {
    return {
      en: `Overtime must be at least ${result.limit} minutes (submitted ${result.submittedMinutes}).`,
      zh: `加班时长不能少于 ${result.limit} 分钟（本次填写 ${result.submittedMinutes}）。`,
    }
  }
  if (result.roundedMinutes !== null && result.roundedMinutes !== result.submittedMinutes) {
    return {
      en: `Overtime rounds up to ${result.roundedMinutes} minutes, which exceeds the daily maximum of ${result.limit} (submitted ${result.submittedMinutes}).`,
      zh: `加班时长向上取整后为 ${result.roundedMinutes} 分钟，超过每日上限 ${result.limit} 分钟（本次填写 ${result.submittedMinutes}）。`,
    }
  }
  return {
    en: `Overtime cannot exceed ${result.limit} minutes per day (submitted ${result.submittedMinutes}).`,
    zh: `加班时长不能超过每日上限 ${result.limit} 分钟（本次填写 ${result.submittedMinutes}）。`,
  }
}

export function overtimeRuleBoundsHintCopy(rule: OvertimeRuleBounds): { en: string; zh: string } {
  const { minMinutes, roundingMinutes, maxMinutesPerDay } = overtimeRuleBoundNumbers(rule)
  if (maxMinutesPerDay > 0 && minMinutes > maxMinutesPerDay) {
    return {
      en: 'This overtime rule is misconfigured: the minimum is higher than the daily maximum.',
      zh: '该加班规则配置无效：最小分钟数高于每日上限。',
    }
  }
  const roundingEn = roundingMinutes > 1
    ? `Accepted durations round up to ${roundingMinutes}-minute steps.`
    : 'Accepted durations are stored as submitted whole minutes.'
  const roundingZh = roundingMinutes > 1
    ? `通过校验的时长会按 ${roundingMinutes} 分钟向上取整。`
    : '通过校验的时长按填写的整分钟保存。'
  if (maxMinutesPerDay > 0 && minMinutes > 0) {
    return {
      en: `Hard limits: ${minMinutes}–${maxMinutesPerDay} minutes. ${roundingEn} Values outside the limits are rejected, not adjusted.`,
      zh: `硬门槛：${minMinutes}–${maxMinutesPerDay} 分钟。${roundingZh}超出范围会被拒绝，不会被自动改写。`,
    }
  }
  if (maxMinutesPerDay > 0) {
    return {
      en: `Hard daily maximum: ${maxMinutesPerDay} minutes. No minimum. ${roundingEn} Longer requests are rejected, not cut down.`,
      zh: `硬门槛：每日最多 ${maxMinutesPerDay} 分钟。没有最小分钟。${roundingZh}超出上限会被拒绝，不会被截断。`,
    }
  }
  if (minMinutes > 0) {
    return {
      en: `Hard minimum: ${minMinutes} minutes. No daily maximum. ${roundingEn} Shorter requests are rejected, not raised.`,
      zh: `硬门槛：至少 ${minMinutes} 分钟。没有每日上限。${roundingZh}不足最小分钟会被拒绝，不会被抬高。`,
    }
  }
  return {
    en: `No minimum and no daily maximum. ${roundingEn}`,
    zh: `没有最小分钟，也没有每日上限。${roundingZh}`,
  }
}
