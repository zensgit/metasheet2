import { describePasswordPolicyReasons } from '../utils/createUserValidationCopy'

/**
 * Admin reset-password feedback.
 * Server contract (POST /api/admin/users/:userId/reset-password): trim a string
 * password; empty asks the server to generate one; a typed value must pass the
 * same password policy as create-user, otherwise 400 PASSWORD_POLICY_FAILED with
 * `details.reasons` (one code per failed rule) and `details.details` (English,
 * index-aligned). Older servers answered a short value with 400 PASSWORD_TOO_SHORT;
 * that code is still mapped.
 * The page only pre-checks length; every other rule is the server's answer.
 * Copy here never includes the submitted value.
 */

export const ADMIN_TEMPORARY_PASSWORD_MIN_LENGTH = 8

export const ADMIN_TEMPORARY_PASSWORD_RULE_HINT =
  '临时密码：8–128 位，要同时有大写字母、小写字母和数字，不能包含 123456、password 这类常见片段；留空则自动生成临时密码。'

export const ADMIN_TEMPORARY_PASSWORD_TOO_SHORT = '临时密码不足 8 位，未重置。'

export const ADMIN_TEMPORARY_PASSWORD_POLICY_FAILED_FALLBACK = '临时密码不符合密码规则，未重置。'

export type ManualTemporaryPasswordIntent =
  | { kind: 'generate' }
  | { kind: 'too-short' }
  | { kind: 'submit'; password: string }

export function classifyManualTemporaryPassword(raw: string): ManualTemporaryPasswordIntent {
  const password = raw.trim()
  if (password.length === 0) return { kind: 'generate' }
  if (password.length < ADMIN_TEMPORARY_PASSWORD_MIN_LENGTH) return { kind: 'too-short' }
  return { kind: 'submit', password }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function describeAdminResetPasswordInlineError(
  error: { code?: unknown; details?: unknown } | null | undefined,
): string | null {
  if (error?.code === 'PASSWORD_TOO_SHORT') return ADMIN_TEMPORARY_PASSWORD_TOO_SHORT
  if (error?.code !== 'PASSWORD_POLICY_FAILED') return null
  const details = asRecord(error.details)
  const reasons = Array.isArray(details?.reasons) ? details.reasons as unknown[] : []
  const serverDetails = Array.isArray(details?.details) ? details.details as unknown[] : []
  const fragments = describePasswordPolicyReasons(reasons, 'zh', serverDetails)
  if (fragments.length === 0) return ADMIN_TEMPORARY_PASSWORD_POLICY_FAILED_FALLBACK
  return `临时密码不符合要求：${fragments.join('；')}。未重置。`
}
