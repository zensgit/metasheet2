export function resolvePostLoginRedirect(rawRedirect: unknown, fallbackPath: string): string {
  const fallback = normalizeInternalPath(fallbackPath) || '/attendance'
  const redirect = typeof rawRedirect === 'string' ? rawRedirect.trim() : ''

  if (!redirect) return fallback

  const normalized = normalizeInternalPath(redirect)
  if (!normalized || normalized === '/' || normalized === '/login') {
    return fallback
  }

  return normalized
}

function normalizeInternalPath(candidate: string): string {
  const text = String(candidate || '').trim()
  if (!text.startsWith('/') || text.startsWith('//')) return ''
  return text
}
