/**
 * The client half of the DB-backed "approval administrator" capability
 * (`GET /api/approvals/admin/capability`; see
 * `packages/core-backend/src/services/approval-admin-capability.ts` for why the three admin
 * predicates in this system disagree and which one that route answers).
 *
 * THREE STATES, NOT TWO. `unavailable` is deliberately NOT folded into `denied`. Folding it in
 * would reproduce the defect this closes at one level up: a real administrator hitting a transport
 * failure would be shown a state asserting something about their rights that the read never
 * established. Every consumer must render `unavailable` as "the server did not confirm", never as
 * "you are not an administrator".
 *
 * CACHING. A definitive answer (`granted` / `denied`) is cached for the page's lifetime, so the
 * nav entry and the page itself share ONE request. `unavailable` is NOT cached — a transient blip
 * must not hide an administrator's entry for the rest of the session. Both logout paths in this
 * app are full navigations (`window.location.assign` / `.replace`), so the cache cannot outlive
 * the principal it was resolved for.
 */
import { apiGet } from '../utils/api'

export type ApprovalAdminCapability = 'granted' | 'denied' | 'unavailable'

export const APPROVAL_ADMIN_CAPABILITY_PATH = '/api/approvals/admin/capability'

let cached: Promise<ApprovalAdminCapability> | null = null

/** Uncached single read. Exported for tests and for a caller that must not reuse a prior answer. */
export async function fetchApprovalAdminCapability(): Promise<ApprovalAdminCapability> {
  try {
    const response = await apiGet<unknown>(APPROVAL_ADMIN_CAPABILITY_PATH)
    const root = response && typeof response === 'object' ? response as Record<string, unknown> : null
    if (!root) return 'unavailable'
    const data = root.data && typeof root.data === 'object' ? root.data as Record<string, unknown> : root
    const value = data.isApprovalAdmin
    // Anything that is not a boolean is an answer this client does not understand — reported as
    // "could not determine", never coerced.
    if (typeof value !== 'boolean') return 'unavailable'
    return value ? 'granted' : 'denied'
  } catch {
    return 'unavailable'
  }
}

export function resolveApprovalAdminCapability(): Promise<ApprovalAdminCapability> {
  if (cached) return cached
  const pending = fetchApprovalAdminCapability().then((result) => {
    if (result === 'unavailable') cached = null
    return result
  })
  cached = pending
  return pending
}

/** Test seam; also the correct call for a surface that has just changed principal. */
export function resetApprovalAdminCapabilityCache(): void {
  cached = null
}
