/**
 * Admin reset-password feedback.
 * Server contract (POST /api/admin/users/:userId/reset-password): trim a string
 * password; empty asks the server to generate one; trimmed length under 8 is
 * 400 PASSWORD_TOO_SHORT. There is no other complexity rule on that handler.
 * Copy here never includes the submitted value.
 */

export const ADMIN_TEMPORARY_PASSWORD_MIN_LENGTH = 8

export const ADMIN_TEMPORARY_PASSWORD_RULE_HINT = '至少 8 位。留空则自动生成临时密码。'

export const ADMIN_TEMPORARY_PASSWORD_TOO_SHORT = '临时密码不足 8 位，未重置。'

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

export function describeAdminResetPasswordInlineError(
  error: { code?: unknown } | null | undefined,
): string | null {
  if (error?.code !== 'PASSWORD_TOO_SHORT') return null
  return ADMIN_TEMPORARY_PASSWORD_TOO_SHORT
}
