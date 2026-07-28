/**
 * T2 — single normalizeLoginIdentifier for claim / migration / login (design lock Rev 4.2 §4.3).
 * All login-namespace writers and readers MUST call this; no private trim/lower paths.
 */

export type LoginAliasKind = 'email' | 'mobile' | 'username'

/** Rough email shape after trim (contains @ with local + domain). */
function looksLikeEmail(raw: string): boolean {
  const at = raw.indexOf('@')
  if (at <= 0 || at !== raw.lastIndexOf('@')) return false
  const domain = raw.slice(at + 1)
  return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.')
}

/**
 * Mobile-like: digits with optional leading +, spaces, dashes, parentheses.
 * Not treated as email (no @).
 */
function looksLikeMobile(raw: string): boolean {
  if (raw.includes('@')) return false
  const compact = raw.replace(/[\s\-()]/g, '')
  if (!/^\+?\d{7,15}$/.test(compact)) return false
  // Prefer mobile when mostly digits; pure short digit usernames stay username if <7 handled above
  return true
}

/**
 * Normalize a free-form login identifier into the global unique alias namespace.
 */
export function normalizeLoginIdentifier(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const nfkc = trimmed.normalize('NFKC')

  if (looksLikeEmail(nfkc)) {
    return nfkc.toLowerCase()
  }

  if (looksLikeMobile(nfkc)) {
    let digits = nfkc.replace(/[\s\-()]/g, '')
    if (digits.startsWith('+')) {
      // keep + and digits only
      digits = '+' + digits.slice(1).replace(/\D/g, '')
    } else {
      digits = digits.replace(/\D/g, '')
      // Mainland CN 11-digit starting with 1 → +86 prefix
      if (/^1\d{10}$/.test(digits)) {
        digits = `+86${digits}`
      }
    }
    return digits.length >= 7 ? digits : null
  }

  // username: case-insensitive
  return nfkc.toLowerCase()
}

export function inferLoginAliasKind(raw: string): LoginAliasKind {
  const trimmed = raw.trim().normalize('NFKC')
  if (looksLikeEmail(trimmed)) return 'email'
  if (looksLikeMobile(trimmed)) return 'mobile'
  return 'username'
}
