/**
 * Thrown by service-layer writers (which cannot answer HTTP themselves) when a requested password
 * fails `validatePassword()` (auth/password-policy.ts). Routes recognise it by type and answer 400
 * `PASSWORD_POLICY_FAILED` with the English policy strings in `details.details` — the same field
 * `POST /api/admin/users` uses. The message is the first failed rule (or the generic sentence), so
 * code that only reads `error.message` keeps seeing exactly what it saw before #6259.
 */
export const PASSWORD_POLICY_ERROR_CODE = 'PASSWORD_POLICY_FAILED'

export class PasswordPolicyError extends Error {
  readonly code = PASSWORD_POLICY_ERROR_CODE
  readonly errors: readonly string[]

  constructor(errors: readonly string[]) {
    super(errors[0] || 'Password does not meet requirements')
    this.name = 'PasswordPolicyError'
    this.errors = [...errors]
  }
}
