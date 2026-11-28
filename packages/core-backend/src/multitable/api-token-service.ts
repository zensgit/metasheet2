/**
 * API Token Service
 * PostgreSQL-backed token management for multitable open API access.
 * V2: persistent store via Kysely — tokens survive restarts.
 */

import { createHash, randomBytes } from 'crypto'
import { CompiledQuery, sql, type Kysely } from 'kysely'
import { Logger } from '../core/logger'
import { refuseZeroReturning } from '../auth/strict-credential-chain'
import { evaluateUserAuthenticationGate } from '../auth/user-activation'
import { isSessionRenewalBusyError, lockUserAccessShared } from '../auth/user-access-lock'
import type { Database } from '../db/types'
import { nowTimestamp, toJsonValue } from '../db/type-helpers'
import type {
  ApiToken,
  ApiTokenCreateInput,
  ApiTokenCreateResult,
  ApiTokenScope,
} from './api-tokens'
import {
  issuanceAuthenticationChanged,
  issuanceBusy,
  issuanceUnavailable,
  requireIssuanceCredential,
  type ApiTokenIssuanceCredential,
} from './api-token-issuance'

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

type IssuanceClient = {
  query: (text: string, args?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
}

/** Raw statements on the connection of the issuance transaction itself. */
function issuanceClient(trx: Kysely<Database>): IssuanceClient {
  return {
    async query(text: string, args: unknown[] = []) {
      const result = await trx.executeQuery(CompiledQuery.raw(text, args))
      return { rows: result.rows as Record<string, unknown>[] }
    },
  }
}

const ISSUANCE_ISOLATION = 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED'
const ISSUANCE_ISOLATION_PROBE = "SELECT current_setting('transaction_isolation') AS isolation"
// One live session row with this id for this user. Read only, not locked.
const ISSUANCE_SESSION_ROW = `SELECT 1 AS present
  FROM user_sessions
 WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`
// Dated token: any watermark at or after its iat revokes it.
const ISSUANCE_DATED_WATERMARK = `SELECT EXISTS (
  SELECT 1 FROM user_session_revocations
   WHERE user_id = $1 AND revoked_after >= to_timestamp($2::double precision)
) AS revoked`
// Undated token: any watermark other than the epoch placeholder revokes it.
const ISSUANCE_UNDATED_WATERMARK = `SELECT EXISTS (
  SELECT 1 FROM user_session_revocations
   WHERE user_id = $1 AND revoked_after <> TIMESTAMPTZ '1970-01-01 00:00:00+00'
) AS revoked`

/**
 * OAPI-4a — normalize an optional per-base/sheet scope list for PERSISTENCE: trim, drop empties, dedupe;
 * an empty/absent list → `null` so "unscoped" (creator-wide) is unambiguous in the column (never `[]`).
 */
function normalizeScopeArray(v: readonly string[] | undefined | null): string[] | null {
  if (!v || v.length === 0) return null
  const cleaned = [...new Set(v.map((s) => s.trim()).filter((s) => s.length > 0))]
  return cleaned.length > 0 ? cleaned : null
}

/** Read a Postgres `text[]` scope column back to the optional domain shape (NULL/empty → undefined). */
function readScopeArray(v: string[] | null | undefined): string[] | undefined {
  return v && v.length > 0 ? v : undefined
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
  base_ids?: string[] | null
  sheet_ids?: string[] | null
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
    baseIds: readScopeArray(row.base_ids),
    sheetIds: readScopeArray(row.sheet_ids),
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
   * Issuance fence shared by create and rotate. Runs first in the issuance transaction:
   * 1. pin READ COMMITTED, then confirm it;
   * 2. take the shared user access lock and the users row FOR SHARE, then compare activity and
   *    access generation with the authenticated user;
   * 3. after the lock, re-read the session row (when the token has a sid) and then the session
   *    watermark, each as its own statement on this connection.
   * Any refusal or read error ends the transaction before a token row is written.
   */
  private async fenceCredentialIssuance(trx: Kysely<Database>, userId: string, credential: ApiTokenIssuanceCredential): Promise<void> {
    const client = issuanceClient(trx)
    await client.query(ISSUANCE_ISOLATION)
    const isolation = await client.query(ISSUANCE_ISOLATION_PROBE)
    if (isolation.rows.length !== 1 || isolation.rows[0].isolation !== 'read committed') throw issuanceUnavailable()
    let account: Awaited<ReturnType<typeof lockUserAccessShared>>
    try {
      account = await lockUserAccessShared(client, userId)
    } catch (error) {
      if (isSessionRenewalBusyError(error)) throw issuanceBusy()
      throw error
    }
    if (!account || account.is_active !== true || Number(account.access_generation) !== credential.expectedAccessGeneration) {
      throw issuanceAuthenticationChanged()
    }
    if (credential.sessionId !== null) {
      const session = await client.query(ISSUANCE_SESSION_ROW, [credential.sessionId, userId])
      if (session.rows.length !== 1) throw issuanceAuthenticationChanged()
    }
    const watermark = credential.issuedAt !== null
      ? await client.query(ISSUANCE_DATED_WATERMARK, [userId, credential.issuedAt])
      : await client.query(ISSUANCE_UNDATED_WATERMARK, [userId])
    if (watermark.rows.length !== 1 || watermark.rows[0].revoked !== false) throw issuanceAuthenticationChanged()
  }

  /**
   * Create a new API token. The plain-text token is returned only once.
   */
  async createToken(
    userId: string,
    input: ApiTokenCreateInput,
    credential: ApiTokenIssuanceCredential,
  ): Promise<ApiTokenCreateResult> {
    const issuance = requireIssuanceCredential(credential)
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

    const baseIds = normalizeScopeArray(input.baseIds)
    const sheetIds = normalizeScopeArray(input.sheetIds)

    await this.db.transaction().execute(async trx => {
      await this.fenceCredentialIssuance(trx, userId, issuance)
      await trx
      .insertInto('multitable_api_tokens')
      .values({
        id,
        name: input.name.trim(),
        token_hash: tokenHashValue,
        token_prefix: tokenPrefix,
        scopes: toJsonValue([...input.scopes]),
        created_by: userId,
        created_at: now,
        expires_at: input.expiresAt ?? undefined,
        revoked: false,
        base_ids: baseIds,
        sheet_ids: sheetIds,
      })
      .execute()
    })

    const token: ApiToken = {
      id,
      name: input.name.trim(),
      tokenHash: tokenHashValue,
      tokenPrefix,
      scopes: [...input.scopes],
      baseIds: baseIds ?? undefined,
      sheetIds: sheetIds ?? undefined,
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

    const revokedRows = await this.db
      .updateTable('multitable_api_tokens')
      .set({ revoked: true, revoked_at: nowTimestamp() })
      .where('id', '=', tokenId)
      .where('revoked', '=', false)
      .returning('id')
      .execute()
    refuseZeroReturning(revokedRows.length, 'API token was revoked concurrently')

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

    const creator = await this.db
      .selectFrom('users')
      .select([
        'id',
        'is_active',
        'role',
        'activation_status',
        'local_password_set',
        sql<string | null>`(to_jsonb(users) ->> 'deleted_at')`.as('deleted_at'),
        sql<string | null>`(to_jsonb(users) ->> 'purged_at')`.as('purged_at'),
      ])
      .where('id', '=', row.created_by)
      .executeTakeFirst()

    if (!creator) {
      return { valid: false, reason: 'Token creator not found' }
    }

    const gate = evaluateUserAuthenticationGate({
      is_active: creator.is_active,
      role: creator.role,
      activation_status: creator.activation_status,
      local_password_set: creator.local_password_set,
      deleted_at: creator.deleted_at,
      purged_at: creator.purged_at,
    })
    if (gate) {
      return { valid: false, reason: gate.message }
    }

    const touched = await this.db
      .updateTable('multitable_api_tokens')
      .set({ last_used_at: nowTimestamp() })
      .where('id', '=', row.id)
      .where('revoked', '=', false)
      .returning('id')
      .execute()
    if (touched.length === 0) {
      return { valid: false, reason: 'Token has been revoked' }
    }

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
    credential: ApiTokenIssuanceCredential,
  ): Promise<ApiTokenCreateResult> {
    const issuance = requireIssuanceCredential(credential)
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
      await this.fenceCredentialIssuance(trx, userId, issuance)
      const revokedRows = await trx
        .updateTable('multitable_api_tokens')
        .set({ revoked: true, revoked_at: nowTimestamp() })
        .where('id', '=', tokenId)
        .where('revoked', '=', false)
        .returning('id')
        .execute()
      refuseZeroReturning(revokedRows.length, 'API token was revoked concurrently')

      // Create new token with same name and scopes
      const plainTextToken = generatePlainTextToken()
      const tokenHashValue = hashToken(plainTextToken)
      const tokenPrefix = plainTextToken.slice(0, 8)
      const id = generateTokenId()
      const now = new Date().toISOString()

      // A rotated token KEEPS its per-base/sheet scope — never silently widen to creator-wide.
      const baseIds = normalizeScopeArray(token.baseIds)
      const sheetIds = normalizeScopeArray(token.sheetIds)

      await trx
        .insertInto('multitable_api_tokens')
        .values({
          id,
          name: token.name,
          token_hash: tokenHashValue,
          token_prefix: tokenPrefix,
          scopes: toJsonValue([...token.scopes]),
          created_by: userId,
          created_at: now,
          expires_at: token.expiresAt ?? undefined,
          revoked: false,
          base_ids: baseIds,
          sheet_ids: sheetIds,
        })
        .execute()

      const newToken: ApiToken = {
        id,
        name: token.name,
        tokenHash: tokenHashValue,
        tokenPrefix,
        scopes: [...token.scopes],
        baseIds: baseIds ?? undefined,
        sheetIds: sheetIds ?? undefined,
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
