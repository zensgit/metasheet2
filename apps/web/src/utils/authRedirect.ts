export function normalizePostLoginRedirect(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized.startsWith('/') || normalized.startsWith('//')) return null
  if (normalized === '/' || normalized.startsWith('/login')) return null
  return normalized
}
