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
}

export interface ApiTokenCreateResult {
  token: ApiToken
  plainTextToken: string   // only returned once at creation
}
