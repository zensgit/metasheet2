'use strict'

const BUSINESS_TIMEZONE_ENV_KEY = 'MULTITABLE_BUSINESS_TIMEZONE'
const DEFAULT_BUSINESS_TIMEZONE = 'Asia/Shanghai'

// Mirror of packages/core-backend/src/multitable/automation-timezone.ts isValidIanaTimeZone.
function isValidIanaTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone.trim()) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timeZone.trim() }).format(0)
    return true
  } catch {
    return false
  }
}

// Mirror of packages/core-backend/src/multitable/business-timezone.ts resolveMultitableBusinessTimezone
// (trim; unset / blank / rejected by Intl → Asia/Shanghai). Equivalence is pinned by
// packages/core-backend/tests/unit/yida-issue-confirm-writeback-migration.test.ts.
function resolveIssueConfirmBusinessTimeZone(env = process.env) {
  const raw = env ? env[BUSINESS_TIMEZONE_ENV_KEY] : undefined
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  if (!trimmed) return DEFAULT_BUSINESS_TIMEZONE
  if (isValidIanaTimeZone(trimmed)) return trimmed
  return DEFAULT_BUSINESS_TIMEZONE
}

module.exports = { BUSINESS_TIMEZONE_ENV_KEY, DEFAULT_BUSINESS_TIMEZONE, isValidIanaTimeZone, resolveIssueConfirmBusinessTimeZone }
