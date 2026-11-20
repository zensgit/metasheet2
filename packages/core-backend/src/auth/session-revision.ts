type RevocationClaims = {
  sid?: unknown
  iat?: unknown
  sessionRevision?: unknown
  revocationIat?: unknown
}

type RevocationRow = { revision?: unknown; revoked_after?: unknown }

export function isSessionRevision(value: unknown): value is string {
  return value === 'none' || (typeof value === 'string'
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value))
}

export function sessionRevisionAllows(claims: RevocationClaims, row: RevocationRow | undefined): boolean {
  const issuedAt = claims.iat
  if (typeof issuedAt !== 'number' || !Number.isSafeInteger(issuedAt) || issuedAt <= 0) return false
  if ((claims.sessionRevision !== undefined || claims.revocationIat !== undefined)
    && (typeof claims.sid !== 'string' || !claims.sid.trim())) return false
  if (claims.sessionRevision !== undefined) {
    if (!isSessionRevision(claims.sessionRevision) || claims.revocationIat !== undefined) return false
    return row === undefined ? claims.sessionRevision === 'none'
      : claims.sessionRevision !== 'none' && claims.sessionRevision === row.revision
  }
  const original = claims.revocationIat === undefined ? issuedAt : claims.revocationIat
  if (typeof original !== 'number' || !Number.isSafeInteger(original) || original <= 0 || original > issuedAt) return false
  if (!row) return true
  const cutoff = row.revoked_after
  if (!(cutoff instanceof Date) && typeof cutoff !== 'string') return false
  return original * 1000 > new Date(cutoff).getTime()
}
