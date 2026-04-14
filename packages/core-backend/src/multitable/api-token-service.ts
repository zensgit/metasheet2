/**
 * API Token Service
 * In-memory token management for multitable open API access.
 * V1: in-memory store — tokens are lost on restart.
 */

import { createHash, randomBytes } from 'crypto'
import { Logger } from '../core/logger'
import type {
  ApiToken,
  ApiTokenCreateInput,
  ApiTokenCreateResult,
  ApiTokenScope,
} from './api-tokens'

const logger = new Logger('ApiTokenService')

const TOKEN_PREFIX = 'mst_'

function generateTokenId(): string {
  return randomBytes(16).toString('hex')
}

function generatePlainTextToken(): string {
  return TOKEN_PREFIX + randomBytes(16).toString('hex')
}

function hashToken(plainText: string): string {
  return createHash('sha256').update(plainText).digest('hex')
}

export class ApiTokenService {
  /** tokenId -> ApiToken */
  private tokens = new Map<string, ApiToken>()
  /** tokenHash -> tokenId (reverse index for validation) */
  private hashIndex = new Map<string, string>()

  /**
   * Create a new API token. The plain-text token is returned only once.
   */
  createToken(userId: string, input: ApiTokenCreateInput): ApiTokenCreateResult {
    if (!input.name || input.name.trim().length === 0) {
      throw new Error('Token name is required')
    }
    if (!input.scopes || input.scopes.length === 0) {
      throw new Error('At least one scope is required')
    }

    const plainTextToken = generatePlainTextToken()
    const tokenHashValue = hashToken(plainTextToken)
    const tokenPrefix = plainTextToken.slice(0, 8)
    const id = generateTokenId()
    const now = new Date().toISOString()

    const token: ApiToken = {
      id,
      name: input.name.trim(),
      tokenHash: tokenHashValue,
      tokenPrefix,
      scopes: [...input.scopes],
      createdBy: userId,
      createdAt: now,
      expiresAt: input.expiresAt,
      revoked: false,
    }

    this.tokens.set(id, token)
    this.hashIndex.set(tokenHashValue, id)

    logger.info(`API token created: ${tokenPrefix}... by user ${userId}`)

    return { token, plainTextToken }
  }

  /**
   * List all tokens belonging to a user. Token hashes are redacted.
   */
  listTokens(userId: string): Omit<ApiToken, 'tokenHash'>[] {
    const result: Omit<ApiToken, 'tokenHash'>[] = []
    for (const token of this.tokens.values()) {
      if (token.createdBy === userId) {
        const { tokenHash: _hash, ...rest } = token
        result.push(rest)
      }
    }
    return result
  }

  /**
   * Soft-revoke a token. Only the token owner can revoke.
   */
  revokeToken(tokenId: string, userId: string): void {
    const token = this.tokens.get(tokenId)
    if (!token) {
      throw new Error('Token not found')
    }
    if (token.createdBy !== userId) {
      throw new Error('Not authorized to revoke this token')
    }
    if (token.revoked) {
      return // already revoked, idempotent
    }

    token.revoked = true
    token.revokedAt = new Date().toISOString()

    logger.info(`API token revoked: ${token.tokenPrefix}... by user ${userId}`)
  }

  /**
   * Validate a plain-text token. Returns the token with its scopes if valid.
   */
  validateToken(
    plainTextToken: string,
  ): { valid: true; token: ApiToken } | { valid: false; reason: string } {
    if (!plainTextToken || !plainTextToken.startsWith(TOKEN_PREFIX)) {
      return { valid: false, reason: 'Invalid token format' }
    }

    const tokenHashValue = hashToken(plainTextToken)
    const tokenId = this.hashIndex.get(tokenHashValue)
    if (!tokenId) {
      return { valid: false, reason: 'Token not found' }
    }

    const token = this.tokens.get(tokenId)
    if (!token) {
      return { valid: false, reason: 'Token not found' }
    }

    if (token.revoked) {
      return { valid: false, reason: 'Token has been revoked' }
    }

    if (token.expiresAt && new Date(token.expiresAt) < new Date()) {
      return { valid: false, reason: 'Token has expired' }
    }

    // Update last used timestamp
    token.lastUsedAt = new Date().toISOString()

    return { valid: true, token }
  }

  /**
   * Rotate a token: revoke the old one and create a new one with the same scopes.
   */
  rotateToken(tokenId: string, userId: string): ApiTokenCreateResult {
    const token = this.tokens.get(tokenId)
    if (!token) {
      throw new Error('Token not found')
    }
    if (token.createdBy !== userId) {
      throw new Error('Not authorized to rotate this token')
    }

    // Revoke old token
    this.revokeToken(tokenId, userId)

    // Create new token with same name and scopes
    return this.createToken(userId, {
      name: token.name,
      scopes: token.scopes,
      expiresAt: token.expiresAt,
    })
  }

  /**
   * Check if a token has the required scope.
   */
  static hasScope(token: ApiToken, requiredScope: ApiTokenScope): boolean {
    return token.scopes.includes(requiredScope)
  }

  /**
   * Get a token by ID (for internal use).
   */
  getTokenById(tokenId: string): ApiToken | undefined {
    return this.tokens.get(tokenId)
  }
}

/** Singleton instance for V1 in-memory usage */
export const apiTokenService = new ApiTokenService()
