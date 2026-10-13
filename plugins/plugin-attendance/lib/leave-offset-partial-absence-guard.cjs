'use strict'

// Single rejection for legacy leave-offset mode `partial_unpaid_absence` (#6009 / #6015 / #6005).
// Final approval and approval-exempt create both call rejectLeaveOffsetPartialAbsence
// before deductLeaveBalance and before any attendance projection. The mode still
// deducts only the available balance and discards the shortfall, while
// loadApprovedMinutes projects the full request as leave. That disagreement is
// not online, so both paths fail closed with the same 422 and write nothing.

const LEAVE_OFFSET_PARTIAL_ABSENCE_NOT_ONLINE_CODE = 'LEAVE_OFFSET_PARTIAL_ABSENCE_NOT_ONLINE'
const LEAVE_OFFSET_PARTIAL_ABSENCE_NOT_ONLINE_MESSAGE = 'Leave offset insufficient mode partial_unpaid_absence is not online: unpaid-absence accounting is not wired. Use insufficient=block. This request was not applied.'

function leaveOffsetRuleDeclaresPartialAbsence(rule) {
  return Boolean(rule && rule.insufficient === 'partial_unpaid_absence')
}

function leaveOffsetPolicyDeclaresPartialAbsence(policy) {
  const rules = Array.isArray(policy?.rules) ? policy.rules : []
  return rules.some((rule) => leaveOffsetRuleDeclaresPartialAbsence(rule))
}

function rejectLeaveOffsetPartialAbsence(rule, HttpError) {
  if (!leaveOffsetRuleDeclaresPartialAbsence(rule)) return
  throw new HttpError(
    422,
    LEAVE_OFFSET_PARTIAL_ABSENCE_NOT_ONLINE_CODE,
    LEAVE_OFFSET_PARTIAL_ABSENCE_NOT_ONLINE_MESSAGE,
  )
}

module.exports = {
  LEAVE_OFFSET_PARTIAL_ABSENCE_NOT_ONLINE_CODE,
  LEAVE_OFFSET_PARTIAL_ABSENCE_NOT_ONLINE_MESSAGE,
  leaveOffsetRuleDeclaresPartialAbsence,
  leaveOffsetPolicyDeclaresPartialAbsence,
  rejectLeaveOffsetPartialAbsence,
}
