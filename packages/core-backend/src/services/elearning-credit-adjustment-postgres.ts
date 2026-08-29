import {
  adjustElearningCreditInTransaction,
  ElearningCreditAdjustmentError,
  type AdjustElearningCreditInput,
  type ElearningCreditAdjustmentExisting,
  type ElearningCreditAdjustmentResult,
  type ElearningCreditAdjustmentTx,
} from './elearning-credit-adjustment'
import { isElearningCreditSurfaceEnabled } from './elearning-credit-ledger'
import type {
  ElearningCreditSurfaceDb,
  ElearningCreditSurfaceQueryable,
} from './elearning-credit-surface'

function unavailable(): never {
  throw new ElearningCreditAdjustmentError('unavailable')
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value === '') unavailable()
  return value
}

function integer(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^-?\d+$/.test(value)
      ? Number(value)
      : Number.NaN
  if (!Number.isSafeInteger(parsed)) unavailable()
  return parsed
}

function date(value: unknown): string {
  const parsed = value instanceof Date
    ? value
    : typeof value === 'string'
      ? new Date(value)
      : null
  if (!parsed || !Number.isFinite(parsed.getTime())) unavailable()
  return parsed.toISOString()
}

class PostgresElearningCreditAdjustmentTx implements ElearningCreditAdjustmentTx {
  constructor(private readonly db: ElearningCreditSurfaceQueryable) {}

  async lockRequest(input: { orgId: string; requestId: string }): Promise<void> {
    await this.db.query(
      `/* elearning-credit-adjustment:request-lock */
       SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
      ['elearning-credit-adjustment-request', `${input.orgId}:${input.requestId}`],
    )
  }

  async loadRequest(input: {
    orgId: string
    requestId: string
  }): Promise<ElearningCreditAdjustmentExisting | null> {
    const result = await this.db.query(
      `/* elearning-credit-adjustment:load-request */
       SELECT
         id::text AS adjustment_id, request_hash, request_hash_version,
         user_id, points, balance_after, created_at
       FROM elearning_credit_adjustments
       WHERE org_id = $1 AND source_key = $2
       FOR SHARE`,
      [input.orgId, input.requestId],
    )
    if (result.rows.length === 0) return null
    if (result.rows.length !== 1 || !result.rows[0]) unavailable()
    const row = result.rows[0]
    return {
      adjustmentId: text(row.adjustment_id),
      requestHash: text(row.request_hash),
      requestHashVersion: integer(row.request_hash_version),
      userId: text(row.user_id),
      points: integer(row.points),
      balancePoints: integer(row.balance_after),
      createdAt: date(row.created_at),
    }
  }

  async hasActiveMembership(input: { orgId: string; userId: string }): Promise<boolean> {
    const result = await this.db.query(
      `/* elearning-credit-adjustment:membership */
       SELECT 1 AS ok
       FROM user_orgs membership
       JOIN users account ON account.id = membership.user_id
       WHERE membership.org_id = $1
         AND membership.user_id = $2
         AND membership.is_active = true
         AND account.is_active = true
       FOR SHARE OF membership, account`,
      [input.orgId, input.userId],
    )
    if (result.rows.length > 1) unavailable()
    return result.rows.length === 1
  }

  async lockBalance(input: { orgId: string; userId: string }): Promise<number> {
    await this.db.query(
      `/* elearning-credit-adjustment:ensure-balance */
       INSERT INTO elearning_credit_balances (org_id, user_id, balance_points)
       VALUES ($1, $2, 0)
       ON CONFLICT (org_id, user_id) DO NOTHING`,
      [input.orgId, input.userId],
    )
    const result = await this.db.query(
      `/* elearning-credit-adjustment:lock-balance */
       SELECT balance_points
       FROM elearning_credit_balances
       WHERE org_id = $1 AND user_id = $2
       FOR UPDATE`,
      [input.orgId, input.userId],
    )
    if (result.rows.length !== 1) unavailable()
    return integer(result.rows[0]?.balance_points)
  }

  async setBalance(input: {
    orgId: string
    userId: string
    previousBalance: number
    balancePoints: number
  }): Promise<void> {
    const result = await this.db.query(
      `/* elearning-credit-adjustment:set-balance */
       UPDATE elearning_credit_balances
       SET balance_points = $3, updated_at = now()
       WHERE org_id = $1 AND user_id = $2 AND balance_points = $4
       RETURNING balance_points`,
      [input.orgId, input.userId, input.balancePoints, input.previousBalance],
    )
    if (
      result.rows.length !== 1
      || integer(result.rows[0]?.balance_points) !== input.balancePoints
    ) unavailable()
  }

  async appendAdjustment(input: {
    adjustmentId: string
    orgId: string
    actorId: string
    requestId: string
    requestHash: string
    requestHashVersion: number
    userId: string
    points: number
    reason: string
    balancePoints: number
  }): Promise<{ createdAt: string }> {
    const result = await this.db.query(
      `/* elearning-credit-adjustment:append */
       INSERT INTO elearning_credit_adjustments (
         id, org_id, actor_id, source_key, request_hash, request_hash_version,
         user_id, points, reason, balance_after
       ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING created_at`,
      [
        input.adjustmentId,
        input.orgId,
        input.actorId,
        input.requestId,
        input.requestHash,
        input.requestHashVersion,
        input.userId,
        input.points,
        input.reason,
        input.balancePoints,
      ],
    )
    if (result.rows.length !== 1) unavailable()
    return { createdAt: date(result.rows[0]?.created_at) }
  }
}

export async function adjustElearningCreditPostgres(
  db: ElearningCreditSurfaceDb,
  input: AdjustElearningCreditInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ElearningCreditAdjustmentResult> {
  if (!isElearningCreditSurfaceEnabled(env)) {
    throw new ElearningCreditAdjustmentError('disabled')
  }
  try {
    return await db.transaction(async (tx) => {
      await tx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      return adjustElearningCreditInTransaction(
        new PostgresElearningCreditAdjustmentTx(tx),
        input,
        env,
      )
    })
  } catch (error) {
    if (error instanceof ElearningCreditAdjustmentError) throw error
    unavailable()
  }
}
