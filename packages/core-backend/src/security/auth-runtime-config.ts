export const DEV_FALLBACK_JWT_SECRET = 'fallback-development-secret-change-in-production'

const INSECURE_JWT_SECRET_VALUES = new Set([
  'test',
  'dev-secret',
  'dev-secret-key',
  'fallback-development-secret-change-in-production',
  'change-me',
  'change-me-in-production',
  'your-secret-key-here',
  'your-dev-secret-key-here',
])

type EnvShape = Record<string, string | undefined>

function normalizeEnvString(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function isProductionRuntime(env: EnvShape = process.env): boolean {
  return normalizeEnvString(env.NODE_ENV) === 'production'
}

export function getJwtSecretValidationIssues(secretValue: string | undefined | null): string[] {
  const issues: string[] = []
  const normalized = normalizeEnvString(secretValue)

  if (!normalized) {
    issues.push('JWT_SECRET environment variable not set')
    return issues
  }

  if (INSECURE_JWT_SECRET_VALUES.has(normalized)) {
    issues.push('JWT_SECRET uses an insecure placeholder value')
  }

  if (normalized.length < 32) {
    issues.push('JWT_SECRET is too short (minimum 32 characters required)')
  }

  return issues
}

export function resolveRuntimeJwtSecret(secretValue: string | undefined | null, env: EnvShape = process.env): string {
  const normalized = normalizeEnvString(secretValue)

  if (!isProductionRuntime(env)) {
    return normalized ?? DEV_FALLBACK_JWT_SECRET
  }

  const issues = getJwtSecretValidationIssues(normalized)
  if (issues.length > 0) {
    throw new Error(`Invalid JWT_SECRET for production: ${issues.join('; ')}`)
  }

  return normalized as string
}

export function getBcryptSaltRounds(env: EnvShape = process.env): number {
  const fallback = isProductionRuntime(env) ? 12 : 10
  const raw = normalizeEnvString(env.BCRYPT_SALT_ROUNDS)
  if (!raw) return fallback

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback

  return parsed
}

export function getProductionAuthSecurityIssues(env: EnvShape = process.env): string[] {
  if (!isProductionRuntime(env)) return []

  const issues = getJwtSecretValidationIssues(env.JWT_SECRET)
  const saltRounds = getBcryptSaltRounds(env)
  if (saltRounds < 12) {
    issues.push(`BCRYPT_SALT_ROUNDS too low for production (${saltRounds}, required: >=12)`)
  }

  if (env.RBAC_TOKEN_TRUST === 'true' || env.RBAC_TOKEN_TRUST === '1') {
    issues.push('RBAC_TOKEN_TRUST is ignored in production and must remain disabled')
  }

  return issues
}
