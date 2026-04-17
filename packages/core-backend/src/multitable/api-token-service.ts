/**
 * API Token Service
 * PostgreSQL-backed token management for multitable open API access.
 * V2: persistent store via Kysely — tokens survive restarts.
 */

import { createHash, randomBytes } from 'crypto'
import type { Kysely } from 'kysely'
import { Logger } from '../core/logger'
import type { Database } from '../db/types'
import { nowTimestamp } from '../db/type-helpers'
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

/** Map a DB row to the domain ApiToken. */
function rowToToken(row: {
  id: string
  name: string
  token_hash: string
  token_prefix: string
  scopes: string | string[]
  created_by: string
  created_at: string | Date
  last_used_at?: string | Date | null
  expires_at?: string | Date | null
  revoked: boolean
  revoked_at?: string | Date | null
}): ApiToken {
  const scopes =
    typeof row.scopes === 'string'
      ? (JSON.parse(row.scopes) as ApiTokenScope[])
      : (row.scopes as ApiTokenScope[])
  return {
    id: row.id,
    name: row.name,
    tokenHash: row.token_hash,
    tokenPrefix: row.token_prefix,
    scopes,
    createdBy: row.created_by,
    createdAt:
      row.created_at instanceof Date
        ? row.created_at.toISOString()
        : row.created_at,
    lastUsedAt: row.last_used_at
      ? row.last_used_at instanceof Date
        ? row.last_used_at.toISOString()
        : row.last_used_at
      : undefined,
    expiresAt: row.expires_at
      ? row.expires_at instanceof Date
        ? row.expires_at.toISOString()
        : row.expires_at
      : undefined,
    revoked: row.revoked,
    revokedAt: row.revoked_at
      ? row.revoked_at instanceof Date
        ? row.revoked_at.toISOString()
        : row.revoked_at
      : undefined,
  }
}

export class ApiTokenService {
  private db: Kysely<Database>

  constructor(db: Kysely<Database>) {
    this.db = db
  }

  /**
   * Create a new API token. The plain-text token is returned only once.
   */
  async createToken(
    userId: string,
    input: ApiTokenCreateInput,
  ): Promise<ApiTokenCreateResult> {
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

    await this.db
      .insertInto('multitable_api_tokens')
      .values({
        id,
        name: input.name.trim(),
        token_hash: tokenHashValue,
        token_prefix: tokenPrefix,
        scopes: JSON.stringify([...input.scopes]),
        created_by: userId,
        created_at: now,
        expires_at: input.expiresAt ?? undefined,
        revoked: false,
      })
      .execute()

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

    logger.info(`API token created: ${tokenPrefix}... by user ${userId}`)

    return { token, plainTextToken }
  }

  /**
   * List all tokens belonging to a user (non-revoked). Token hashes are redacted.
   */
  async listTokens(userId: string): Promise<Omit<ApiToken, 'tokenHash'>[]> {
    const rows = await this.db
      .selectFrom('multitable_api_tokens')
      .selectAll()
      .where('created_by', '=', userId)
      .where('revoked', '=', false)
      .execute()

    return rows.map((row) => {
      const t = rowToToken(row as Parameters<typeof rowToToken>[0])
      const { tokenHash: _hash, ...rest } = t
      return rest
    })
  }

  /**
   * Soft-revoke a token. Only the token owner can revoke.
   */
  async revokeToken(tokenId: string, userId: string): Promise<void> {
    const row = await this.db
      .selectFrom('multitable_api_tokens')
      .selectAll()
      .where('id', '=', tokenId)
      .executeTakeFirst()

    if (!row) {
      throw new Error('Token not found')
    }
    if (row.created_by !== userId) {
      throw new Error('Not authorized to revoke this token')
    }
    if (row.revoked) {
      return // already revoked, idempotent
    }

    await this.db
      .updateTable('multitable_api_tokens')
      .set({ revoked: true, revoked_at: nowTimestamp() })
      .where('id', '=', tokenId)
      .execute()

    logger.info(
      `API token revoked: ${row.token_prefix}... by user ${userId}`,
    )
  }

  /**
   * Validate a plain-text token. Returns the token with its scopes if valid.
   */
  async validateToken(
    plainTextToken: string,
  ): Promise<{ valid: true; token: ApiToken } | { valid: false; reason: string }> {
    if (!plainTextToken || !plainTextToken.startsWith(TOKEN_PREFIX)) {
      return { valid: false, reason: 'Invalid token format' }
    }

    const tokenHashValue = hashToken(plainTextToken)

    const row = await this.db
      .selectFrom('multitable_api_tokens')
      .selectAll()
      .where('token_hash', '=', tokenHashValue)
      .executeTakeFirst()

    if (!row) {
      return { valid: false, reason: 'Token not found' }
    }

    if (row.revoked) {
      return { valid: false, reason: 'Token has been revoked' }
    }

    if (row.expires_at && new Date(row.expires_at as unknown as string) < new Date()) {
      return { valid: false, reason: 'Token has expired' }
    }

    // Update last used timestamp
    await this.db
      .updateTable('multitable_api_tokens')
      .set({ last_used_at: nowTimestamp() })
      .where('id', '=', row.id)
      .execute()

    const token = rowToToken(row as Parameters<typeof rowToToken>[0])
    // Re-read to get updated last_used_at
    token.lastUsedAt = new Date().toISOString()

    return { valid: true, token }
  }

  /**
   * Rotate a token: revoke the old one and create a new one with the same scopes.
   */
  async rotateToken(
    tokenId: string,
    userId: string,
  ): Promise<ApiTokenCreateResult> {
    const row = await this.db
      .selectFrom('multitable_api_tokens')
      .selectAll()
      .where('id', '=', tokenId)
      .executeTakeFirst()

    if (!row) {
      throw new Error('Token not found')
    }
    if (row.created_by !== userId) {
      throw new Error('Not authorized to rotate this token')
    }

    const token = rowToToken(row as Parameters<typeof rowToToken>[0])

    // Revoke old + create new in a transaction
    return this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('multitable_api_tokens')
        .set({ revoked: true, revoked_at: nowTimestamp() })
        .where('id', '=', tokenId)
        .execute()

      // Create new token with same name and scopes
      const plainTextToken = generatePlainTextToken()
      const tokenHashValue = hashToken(plainTextToken)
      const tokenPrefix = plainTextToken.slice(0, 8)
      const id = generateTokenId()
      const now = new Date().toISOString()

      await trx
        .insertInto('multitable_api_tokens')
        .values({
          id,
          name: token.name,
          token_hash: tokenHashValue,
          token_prefix: tokenPrefix,
          scopes: JSON.stringify([...token.scopes]),
          created_by: userId,
          created_at: now,
          expires_at: token.expiresAt ?? undefined,
          revoked: false,
        })
        .execute()

      const newToken: ApiToken = {
        id,
        name: token.name,
        tokenHash: tokenHashValue,
        tokenPrefix,
        scopes: [...token.scopes],
        createdBy: userId,
        createdAt: now,
        expiresAt: token.expiresAt,
        revoked: false,
      }

      logger.info(
        `API token rotated: ${row.token_prefix}... -> ${tokenPrefix}... by user ${userId}`,
      )

      return { token: newToken, plainTextToken }
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
  async getTokenById(tokenId: string): Promise<ApiToken | undefined> {
    const row = await this.db
      .selectFrom('multitable_api_tokens')
      .selectAll()
      .where('id', '=', tokenId)
      .executeTakeFirst()

    if (!row) return undefined
    return rowToToken(row as Parameters<typeof rowToToken>[0])
  }
}
