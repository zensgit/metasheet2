/**
 * Machine-readable reason codes, one per rule, parallel to the English `errors` strings.
 * Clients localise by code; the English strings stay byte-identical for existing callers.
 */
export type PasswordPolicyReason =
  | 'too_short'
  | 'too_long'
  | 'no_lowercase'
  | 'no_uppercase'
  | 'no_digit'
  | 'weak_pattern'

export interface PasswordValidation {
  valid: boolean
  errors: string[]
  reasons: PasswordPolicyReason[]
}

export function validatePassword(password: string): PasswordValidation {
  const errors: string[] = []
  const reasons: PasswordPolicyReason[] = []

  if (password.length < 8) {
    errors.push('Password must be at least 8 characters long')
    reasons.push('too_short')
  }
  if (password.length > 128) {
    errors.push('Password must not exceed 128 characters')
    reasons.push('too_long')
  }
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter')
    reasons.push('no_lowercase')
  }
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter')
    reasons.push('no_uppercase')
  }
  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number')
    reasons.push('no_digit')
  }

  const weakPatterns = ['password', '123456', 'qwerty', 'abc123', 'letmein', 'admin']
  if (weakPatterns.some((pattern) => password.toLowerCase().includes(pattern))) {
    errors.push('Password contains a common weak pattern')
    reasons.push('weak_pattern')
  }

  return { valid: errors.length === 0, errors, reasons }
}
