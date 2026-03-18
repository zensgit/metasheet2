const DEFAULT_AUTH_HOME_PATH = '/attendance'

function isSafeInAppRedirect(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//')
}

export function normalizePostLoginRedirect(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!isSafeInAppRedirect(normalized)) return null
  if (normalized === '/' || normalized.startsWith('/login')) return null
  return normalized
}

export function normalizePreLoginRedirect(value: unknown, fallback = DEFAULT_AUTH_HOME_PATH): string {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim()
  if (!isSafeInAppRedirect(normalized)) return fallback
  if (normalized === '/' || normalized.startsWith('/login')) return fallback
  return normalized
}
