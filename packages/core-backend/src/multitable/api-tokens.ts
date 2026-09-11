/**
 * API Token Types
 * Type definitions for the multitable open API token system.
 */

export interface ApiToken {
  id: string
  name: string
  tokenHash: string        // SHA-256 hash, never store plaintext
  tokenPrefix: string      // first 8 chars for display: "mst_abc1..."
  scopes: ApiTokenScope[]
  createdBy: string        // userId
  createdAt: string
  lastUsedAt?: string
  expiresAt?: string       // optional expiry
  revoked: boolean
  revokedAt?: string
  // OAPI-4a per-base/sheet scope whitelists. Both absent/empty = unscoped (creator-wide, legacy).
  // The §3 AND-composition is enforced at request time by `oapiScopeGuard`.
  baseIds?: string[]
  sheetIds?: string[]
}

/**
 * G44: `integration:read` is the FIRST scope on this list that does not name a multitable/comments
 * surface. It is READ-ONLY by construction and there is deliberately no `integration:write` sibling:
 * the integration (data-factory) write surface — `POST :id/run`, every dry-run, every apply — is
 * unreachable by any token, because no allowlist entry admits a non-GET method on `/api/integration`
 * (see `integration/oapi-integration-read-allowlist.ts`). Holding this scope is NECESSARY but never
 * SUFFICIENT: `middleware/integration-api-token-gate.ts` additionally requires the token's CREATOR to
 * hold the `integration:read` RBAC permission code in the database, and derives the tenant from that
 * creator's server-side membership rather than from the request.
 */
export type ApiTokenScope =
  | 'records:read'
  | 'records:write'
  | 'fields:read'
  | 'comments:read'
  | 'comments:write'
  | 'webhooks:manage'
  | 'integration:read'

export const ALL_API_TOKEN_SCOPES: ApiTokenScope[] = [
  'records:read',
  'records:write',
  'fields:read',
  'comments:read',
  'comments:write',
  'webhooks:manage',
  'integration:read',
]

export interface ApiTokenCreateInput {
  name: string
  scopes: ApiTokenScope[]
  expiresAt?: string
  // OAPI-4a optional per-base/sheet scope. Empty/absent → unscoped (creator-wide). Normalized
  // (trim/dedupe/empty→NULL) by ApiTokenService.createToken.
  baseIds?: string[]
  sheetIds?: string[]
}

export interface ApiTokenCreateResult {
  token: ApiToken
  plainTextToken: string   // only returned once at creation
}
