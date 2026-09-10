import {
  claimElearningCreditInTransaction,
  ElearningCreditLedgerError,
  isElearningCreditSurfaceEnabled,
  type ElearningCreditClaimResult,
  type ElearningCreditDecisionRow,
  type ElearningCreditEffectClaimInput,
  type ElearningCreditEffectClaimResult,
  type ElearningCreditExistingEffect,
  type ElearningCreditLedgerStore,
  type ElearningCreditLedgerTx,
} from './elearning-credit-ledger'
import type {
  ElearningCreditBehavior,
  ElearningCreditRuleSnapshotInput,
} from './elearning-credit-policy'

export interface ElearningCreditPgResult<Row> {
  rows: Row[]
  rowCount: number | null
}

export type ElearningCreditPgQuery = <Row extends Record<string, unknown>>(
  text: string,
  values?: unknown[],
) => Promise<ElearningCreditPgResult<Row>>

export type ElearningCreditPgTransactionRunner = <T>(
  handler: (query: ElearningCreditPgQuery) => Promise<T>,
) => Promise<T>

export interface ElearningCreditTransactionQuery {
  query(
    text: string,
    values?: unknown[],
  ): Promise<ElearningCreditPgResult<Record<string, unknown>>>
}

export interface ElearningPassExamCreditInput {
  attemptId: string
  gradedAt: Date
  orgId: string
  userId: string
}

export type ElearningPassExamCreditAward = (
  tx: ElearningCreditTransactionQuery,
  input: ElearningPassExamCreditInput,
  env?: NodeJS.ProcessEnv,
) => Promise<ElearningCreditClaimResult | null>

export interface ElearningPassExamAwardOptions {
  awardPassExam?: ElearningPassExamCreditAward
  env?: NodeJS.ProcessEnv
}

function unavailable(): never {
  throw new Error('ELEARNING_CREDIT_STORE_UNAVAILABLE')
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

function nullableInteger(value: unknown): number | null {
  return value === null ? null : integer(value)
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value === '') unavailable()
  return value
}

function existingEffect(row: Record<string, unknown>): ElearningCreditExistingEffect {
  return {
    awardedPoints: integer(row.awarded_points),
    id: text(row.id),
    requestHash: text(row.request_hash),
    requestHashVersion: integer(row.request_hash_version),
    status: text(row.status) as ElearningCreditExistingEffect['status'],
  }
}

class PostgresElearningCreditLedgerTx implements ElearningCreditLedgerTx {
  constructor(private readonly query: ElearningCreditPgQuery) {}

  async claimEffect(
    input: ElearningCreditEffectClaimInput,
  ): Promise<ElearningCreditEffectClaimResult> {
    const claimed = await this.query<{ decision_id: string }>(
      `INSERT INTO elearning_credit_effect_claims (
         org_id, user_id, behavior, effect_key,
         request_hash, request_hash_version, decision_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::uuid)
       ON CONFLICT ON CONSTRAINT elearning_credit_effect_claims_effect_identity_key
       DO NOTHING
       RETURNING decision_id::text AS decision_id`,
      [
        input.orgId,
        input.userId,
        input.behavior,
        input.effectKey,
        input.requestHash,
        input.requestHashVersion,
        input.decisionId,
      ],
    )
    if (claimed.rows.length === 1 && claimed.rows[0]?.decision_id === input.decisionId) {
      return { kind: 'claimed' }
    }
    if (claimed.rows.length !== 0) unavailable()

    // READ COMMITTED takes a fresh statement snapshot here. ON CONFLICT has already
    // waited for the winning transaction, so a committed claim must have its deferred
    // decision FK satisfied before this joined read can observe it.
    const persisted = await this.query<Record<string, unknown>>(
      `SELECT
         decision.id::text AS id,
         decision.request_hash,
         decision.request_hash_version,
         decision.awarded_points,
         decision.status
       FROM elearning_credit_effect_claims claim
       JOIN elearning_credit_decisions decision
         ON decision.org_id = claim.org_id
        AND decision.id = claim.decision_id
      WHERE claim.org_id = $1
        AND claim.user_id = $2
        AND claim.behavior = $3
        AND claim.effect_key = $4`,
      [input.orgId, input.userId, input.behavior, input.effectKey],
    )
    if (persisted.rows.length !== 1 || !persisted.rows[0]) unavailable()
    return { effect: existingEffect(persisted.rows[0]), kind: 'existing' }
  }

  async resolveActiveRule(input: {
    orgId: string
    behavior: ElearningCreditBehavior
  }): Promise<ElearningCreditRuleSnapshotInput | null> {
    const result = await this.query<Record<string, unknown>>(
      `SELECT id, version, points, daily_cap, time_zone
         FROM elearning_credit_rules
        WHERE org_id = $1
          AND behavior = $2
          AND status = 'active'
        FOR SHARE`,
      [input.orgId, input.behavior],
    )
    if (result.rows.length === 0) return null
    if (result.rows.length !== 1 || !result.rows[0]) unavailable()
    return {
      dailyCap: nullableInteger(result.rows[0].daily_cap),
      id: text(result.rows[0].id),
      points: integer(result.rows[0].points),
      timeZone: text(result.rows[0].time_zone),
      version: integer(result.rows[0].version),
    }
  }

  async lockBucket(input: {
    orgId: string
    userId: string
    behavior: ElearningCreditBehavior
    localDay: string
  }): Promise<void> {
    await this.query(
      `INSERT INTO elearning_credit_daily_buckets (
         org_id, user_id, behavior, local_day
       ) VALUES ($1, $2, $3, $4::date)
       ON CONFLICT (org_id, user_id, behavior, local_day) DO NOTHING`,
      [input.orgId, input.userId, input.behavior, input.localDay],
    )
    const locked = await this.query<{ locked: number }>(
      `SELECT 1 AS locked
         FROM elearning_credit_daily_buckets
        WHERE org_id = $1
          AND user_id = $2
          AND behavior = $3
          AND local_day = $4::date
        FOR UPDATE`,
      [input.orgId, input.userId, input.behavior, input.localDay],
    )
    if (locked.rows.length !== 1) unavailable()
  }

  async sumPositiveAwards(input: {
    orgId: string
    userId: string
    behavior: ElearningCreditBehavior
    localDay: string
  }): Promise<number> {
    const result = await this.query<{ total: string }>(
      `SELECT COALESCE(SUM(awarded_points), 0)::text AS total
         FROM elearning_credit_decisions
        WHERE org_id = $1
          AND user_id = $2
          AND behavior = $3
          AND local_day = $4::date
          AND awarded_points > 0`,
      [input.orgId, input.userId, input.behavior, input.localDay],
    )
    if (result.rows.length !== 1) unavailable()
    const total = integer(result.rows[0]?.total)
    if (total < 0) unavailable()
    return total
  }

  async appendDecision(row: ElearningCreditDecisionRow): Promise<void> {
    const result = await this.query<{ id: string }>(
      `INSERT INTO elearning_credit_decisions (
         id, org_id, user_id, behavior, effect_key,
         request_hash, request_hash_version, occurred_at, local_day,
         rule_id, rule_version, rule_points, rule_daily_cap, rule_time_zone,
         requested_points, awarded_points, remaining_daily_cap, status
       ) VALUES (
         $1::uuid, $2, $3, $4, $5,
         $6, $7, $8::timestamptz, $9::date,
         $10, $11, $12, $13, $14,
         $15, $16, $17, $18
       )
       RETURNING id::text AS id`,
      [
        row.id,
        row.orgId,
        row.userId,
        row.behavior,
        row.effectKey,
        row.requestHash,
        row.requestHashVersion,
        row.occurredAt,
        row.localDay,
        row.rule.id,
        row.rule.version,
        row.rule.points,
        row.rule.dailyCap,
        row.rule.timeZone,
        row.requestedPoints,
        row.awardedPoints,
        row.remainingDailyCap,
        row.status,
      ],
    )
    if (result.rows.length !== 1 || result.rows[0]?.id !== row.id) unavailable()
  }

  async applyBalanceDelta(input: {
    orgId: string
    userId: string
    delta: number
  }): Promise<void> {
    const result = await this.query<{ balance_points: number }>(
      `INSERT INTO elearning_credit_balances (
         org_id, user_id, balance_points
       ) VALUES ($1, $2, $3)
       ON CONFLICT (org_id, user_id) DO UPDATE
         SET balance_points = elearning_credit_balances.balance_points + EXCLUDED.balance_points,
             updated_at = now()
       RETURNING balance_points`,
      [input.orgId, input.userId, input.delta],
    )
    if (result.rows.length !== 1 || integer(result.rows[0]?.balance_points) < 0) unavailable()
  }
}

function creditQuery(tx: ElearningCreditTransactionQuery): ElearningCreditPgQuery {
  return async <Row extends Record<string, unknown>>(textValue: string, values?: unknown[]) => {
    const result = await tx.query(textValue, values)
    return {
      rowCount: result.rowCount,
      rows: result.rows as Row[],
    }
  }
}

export const awardElearningPassExamCreditInTransaction: ElearningPassExamCreditAward = async (
  tx,
  input,
  env = process.env,
) => {
  if (!isElearningCreditSurfaceEnabled(env)) return null

  try {
    if (!(input.gradedAt instanceof Date) || !Number.isFinite(input.gradedAt.getTime())) {
      throw new ElearningCreditLedgerError('unavailable')
    }
    const isolation = await tx.query(
      `/* elearning-credit:assert-transaction-isolation */
       SELECT current_setting('transaction_isolation') AS transaction_isolation`,
    )
    if (
      isolation.rows.length !== 1
      || isolation.rows[0]?.transaction_isolation !== 'read committed'
    ) {
      throw new ElearningCreditLedgerError('unavailable')
    }

    return await claimElearningCreditInTransaction(
      new PostgresElearningCreditLedgerTx(creditQuery(tx)),
      {
        behavior: 'pass_exam',
        effectKey: `attempt:${input.attemptId}`,
        occurredAt: input.gradedAt.toISOString(),
        orgId: input.orgId,
        reference: { attemptId: input.attemptId },
        userId: input.userId,
      },
      env,
    )
  } catch (error) {
    if (error instanceof ElearningCreditLedgerError) throw error
    throw new ElearningCreditLedgerError('unavailable')
  }
}

export class PostgresElearningCreditLedgerStore implements ElearningCreditLedgerStore {
  constructor(private readonly runTransaction: ElearningCreditPgTransactionRunner) {}

  transaction<T>(handler: (tx: ElearningCreditLedgerTx) => Promise<T>): Promise<T> {
    return this.runTransaction(async (query) => {
      // The losing INSERT waits for the winner, then the joined SELECT must take a
      // new statement snapshot. Enforce that contract instead of inheriting a
      // caller-selected REPEATABLE READ snapshot that cannot observe the winner.
      await query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
      return handler(new PostgresElearningCreditLedgerTx(query))
    })
  }
}
