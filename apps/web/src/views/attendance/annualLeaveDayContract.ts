/**
 * Employee-visible annual/comp day contract (#5969).
 *
 * Annual bank days use `annualLeavePolicy.standardDayMinutes`.
 * A leave request's "≈ N days" uses the leave type's `defaultMinutesPerDay`.
 * Comp time has no day ruler. This module does not touch the ledger.
 */

export const ANNUAL_LEAVE_SETTLE_ERROR_CODES = [
  'ANNUAL_LEAVE_DEDUCTION_AMOUNT_INVALID',
  'ANNUAL_LEAVE_MULTI_DAY_UNSUPPORTED',
  'ANNUAL_LEAVE_DEDUCTION_NOT_WHOLE',
  'ANNUAL_LEAVE_BALANCE_INSUFFICIENT',
] as const

export type AnnualLeaveSettleErrorCode = (typeof ANNUAL_LEAVE_SETTLE_ERROR_CODES)[number]

type TranslateFn = (en: string, zh: string) => string

export function isAnnualLeaveSettleErrorCode(code: string): code is AnnualLeaveSettleErrorCode {
  return (ANNUAL_LEAVE_SETTLE_ERROR_CODES as readonly string[]).includes(code)
}

/** v1 annual leave is one leave-type day. Wall-clock spans longer than that are blocked before submit. */
export function annualLeaveMinutesExceedTypeDay(
  leaveType: { code?: string | null; defaultMinutesPerDay?: number | null } | null | undefined,
  minutes: number | null | undefined,
): boolean {
  if (leaveType?.code !== 'annual') return false
  const perDay = Number(leaveType.defaultMinutesPerDay)
  if (!Number.isInteger(perDay) || perDay <= 0) return false
  if (minutes == null || !Number.isFinite(minutes)) return false
  return minutes > perDay
}

export function annualLeaveExceedsTypeDayMessage(
  perDay: number,
  minutes: number,
  tr: TranslateFn,
): string {
  const requested = Math.round(minutes)
  return tr(
    `Annual leave is a single leave-type day in v1 (${perDay} min). This request is ${requested} min and was not submitted.`,
    `年假 v1 只支持一个假种标准日（${perDay} 分钟）。本次 ${requested} 分钟，未提交。`,
  )
}

/**
 * Keep the server sentence. zh UI otherwise replaces Latin-only errors with a
 * generic fallback, which hides the settle reason behind the code chip.
 */
export function annualLeaveSettleStatusCopy(
  originalMessage: string,
  context: 'request-submit' | 'request-resolve',
  tr: TranslateFn,
): { message: string; hint: string } {
  const hint = context === 'request-submit'
    ? tr(
      'The request was not saved. Annual leave balance days use the policy standard day; the request uses the leave type day.',
      '申请未保存。年假余额按策略标准日折天，请假时长按假种标准日。',
    )
    : tr(
      'Approval did not change this request. Annual leave balance days use the policy standard day; the request uses the leave type day.',
      '批准未改变该申请。年假余额按策略标准日折天，请假时长按假种标准日。',
    )
  return { message: originalMessage, hint }
}
