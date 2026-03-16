export interface PasswordValidation {
  valid: boolean
  errors: string[]
}

export function validatePassword(password: string): PasswordValidation {
  const errors: string[] = []

  if (password.length < 8) {
    errors.push('Password must be at least 8 characters long')
  }
  if (password.length > 128) {
    errors.push('Password must not exceed 128 characters')
  }
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter')
  }
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter')
  }
  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number')
  }

  const weakPatterns = ['password', '123456', 'qwerty', 'abc123', 'letmein', 'admin']
  if (weakPatterns.some((pattern) => password.toLowerCase().includes(pattern))) {
    errors.push('Password contains a common weak pattern')
  }

  return { valid: errors.length === 0, errors }
}
