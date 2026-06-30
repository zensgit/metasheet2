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

export type ApiTokenScope =
  | 'records:read'
  | 'records:write'
  | 'fields:read'
  | 'comments:read'
  | 'comments:write'
  | 'webhooks:manage'

export const ALL_API_TOKEN_SCOPES: ApiTokenScope[] = [
  'records:read',
  'records:write',
  'fields:read',
  'comments:read',
  'comments:write',
  'webhooks:manage',
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
