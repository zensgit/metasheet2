/**
 * Classification of the tenant claim on a signature-verified JWT payload.
 * Attached only after jwt.verify succeeds. Never produced from an unverified decode,
 * a header, req.user, or a request body.
 *
 * `absent` is the only kind that may become the service's explicit null legacy tenant,
 * and only when the authenticated tenant binding is also empty.
 * Blank, malformed, and rejected claims must not be collapsed into `absent`.
 */
export type VerifiedTenantClaim =
  | { kind: 'absent' }
  | { kind: 'blank' }
  | { kind: 'malformed' }
  | { kind: 'rejected' }
  | { kind: 'present'; value: string }

const verifiedTenantClaim = Symbol('verifiedTenantClaim')

/** Classify the raw payload field. Do not trim before deciding the kind. */
export function classifyVerifiedTenantClaim(value: unknown): VerifiedTenantClaim {
  if (value === undefined) return { kind: 'absent' }
  if (typeof value !== 'string') return { kind: 'malformed' }
  if (value.trim().length === 0) return { kind: 'blank' }
  return { kind: 'present', value: value.trim() }
}

export function attachVerifiedTenantClaim(user: object, claim: VerifiedTenantClaim): void {
  Object.defineProperty(user, verifiedTenantClaim, {
    value: claim,
    enumerable: false,
    configurable: true,
    writable: false,
  })
}

export function readVerifiedTenantClaim(user: object | null | undefined): VerifiedTenantClaim | null {
  if (!user || typeof user !== 'object') return null
  const value = (user as Record<symbol, unknown>)[verifiedTenantClaim]
  if (!value || typeof value !== 'object') return null
  const kind = (value as { kind?: unknown }).kind
  if (kind === 'absent' || kind === 'blank' || kind === 'malformed' || kind === 'rejected') {
    return { kind }
  }
  if (kind === 'present') {
    const present = (value as { value?: unknown }).value
    if (typeof present === 'string' && present.length > 0) return { kind: 'present', value: present }
  }
  return null
}

/** Copy the claim off the user object so a later JSON response cannot observe it. */
export function takeVerifiedTenantClaim(user: object | null | undefined): VerifiedTenantClaim | null {
  const claim = readVerifiedTenantClaim(user)
  if (user && typeof user === 'object' && claim) {
    delete (user as Record<symbol, unknown>)[verifiedTenantClaim]
  }
  return claim
}
