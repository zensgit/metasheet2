/**
 * Revision-content swap for one cancel-round attempt.
 *
 * A legal edit closes the pending round, inserts one new engine row, and
 * inserts one new pending round. The phase deadline is the earlier of the
 * inherited deadline and a new BEFORE start. A later start does not extend it.
 * An applicable round lifetime is copied, not recomputed. At either limit the
 * old round is expired and no successor is created. The same attempt id
 * returns the committed result.
 *
 * This does not copy seats or votes, and it does not re-run seat eligibility.
 */

import { randomUUID } from 'node:crypto'
import { closePendingApprovalRoundV1 } from './approval-change-round-close'

interface SwapQueryV1 {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>
}

export type RevisionSwapPlanV1 =
  | { readonly action: 'close_only'; readonly reason: 'phase_deadline_reached' | 'round_lifetime_reached' }
  | { readonly action: 'swap'; readonly phaseDeadlineAt: Date; readonly roundLifetimeEndsAt: Date | null }

export function planRevisionContentSwapV1(input: {
  readonly now: Date
  readonly inheritedPhaseDeadlineAt: Date
  readonly newBeforeStartAt: Date | null
  readonly roundLifetimeEndsAt: Date | null
}): RevisionSwapPlanV1 {
  if (
    input.roundLifetimeEndsAt !== null
    && input.now.getTime() >= input.roundLifetimeEndsAt.getTime()
  ) {
    return { action: 'close_only', reason: 'round_lifetime_reached' }
  }
  let deadline = input.inheritedPhaseDeadlineAt
  if (input.newBeforeStartAt !== null && input.newBeforeStartAt.getTime() < deadline.getTime()) {
    deadline = input.newBeforeStartAt
  }
  if (input.now.getTime() >= deadline.getTime()) {
    return { action: 'close_only', reason: 'phase_deadline_reached' }
  }
  return {
    action: 'swap',
    phaseDeadlineAt: deadline,
    roundLifetimeEndsAt: input.roundLifetimeEndsAt,
  }
}

export class RevisionSwapError extends Error {
  readonly code: 'REVISION_SWAP_NO_PENDING_ROUND' | 'REVISION_SWAP_ENGINE_MISSING'
  readonly httpStatus = 409

  constructor(code: RevisionSwapError['code']) {
    super(code)
    this.name = 'RevisionSwapError'
    this.code = code
  }
}

export type RevisionSwapResultV1 =
  | { readonly action: 'closed_only'; readonly roundId: string; readonly reason: 'phase_deadline_reached' | 'round_lifetime_reached' }
  | {
      readonly action: 'swapped'
      readonly predecessorRoundId: string
      readonly roundId: string
      readonly engineInstanceId: string
      readonly phaseDeadlineAt: string
    }

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function snapshotAttempt(value: unknown): string | null {
  let snapshot = value
  if (typeof snapshot === 'string') {
    try {
      snapshot = JSON.parse(snapshot) as unknown
    } catch {
      return null
    }
  }
  if (typeof snapshot !== 'object' || snapshot === null) return null
  return asString((snapshot as { revisionAttemptId?: unknown }).revisionAttemptId)
}

export async function applyRevisionContentSwapV1(
  db: SwapQueryV1,
  input: {
    readonly documentId: string
    readonly attemptId: string
    readonly revisionId: string
    readonly now: Date
    readonly inheritedPhaseDeadlineAt: Date
    readonly newBeforeStartAt: Date | null
    readonly roundLifetimeEndsAt: Date | null
  },
): Promise<RevisionSwapResultV1> {
  const locked = await db.query(
    `SELECT id FROM approval_instances WHERE id = $1 FOR UPDATE`,
    [input.documentId],
  )
  if (locked.rows.length !== 1) throw new RevisionSwapError('REVISION_SWAP_NO_PENDING_ROUND')

  const existing = await db.query(
    `SELECT id, engine_instance_id, outcome, requested_by, policy_snapshot_at_create, policy_snapshot_at_decision
       FROM approval_rounds
      WHERE document_id = $1`,
    [input.documentId],
  )
  const successor = existing.rows.find((row) => snapshotAttempt(row.policy_snapshot_at_create) === input.attemptId)
  if (successor) {
    const created = successor.policy_snapshot_at_create
    const parsed = typeof created === 'string'
      ? JSON.parse(created) as { phaseDeadlineAt?: unknown; predecessorRoundId?: unknown }
      : created as { phaseDeadlineAt?: unknown; predecessorRoundId?: unknown }
    return {
      action: 'swapped',
      predecessorRoundId: asString(parsed.predecessorRoundId) ?? String(successor.id),
      roundId: String(successor.id),
      engineInstanceId: String(successor.engine_instance_id),
      phaseDeadlineAt: asString(parsed.phaseDeadlineAt) ?? input.inheritedPhaseDeadlineAt.toISOString(),
    }
  }
  const closedOnly = existing.rows.find((row) => (
    row.outcome === 'expired' && snapshotAttempt(row.policy_snapshot_at_decision) === input.attemptId
  ))
  if (closedOnly) {
    const decision = closedOnly.policy_snapshot_at_decision
    const parsed = typeof decision === 'string'
      ? JSON.parse(decision) as { reason?: unknown }
      : decision as { reason?: unknown }
    return {
      action: 'closed_only',
      roundId: String(closedOnly.id),
      reason: parsed?.reason === 'round_lifetime_reached' ? 'round_lifetime_reached' : 'phase_deadline_reached',
    }
  }

  const pending = existing.rows.find((row) => row.outcome === 'pending')
  const engineId = asString(pending?.engine_instance_id)
  const requestedBy = asString(pending?.requested_by)
  if (!pending || !engineId || !requestedBy) throw new RevisionSwapError('REVISION_SWAP_NO_PENDING_ROUND')

  const plan = planRevisionContentSwapV1(input)
  if (plan.action === 'close_only') {
    const closed = await closePendingApprovalRoundV1({
      query: async (sql, params) => {
        const result = await db.query(sql, params)
        return { rows: result.rows.map((row) => ({ id: asString(row.id) ?? undefined })) }
      },
    }, {
      engineInstanceId: engineId,
      outcome: 'expired',
      blockReason: null,
      policySnapshotAtDecision: JSON.stringify({
        revisionAttemptId: input.attemptId,
        revisionId: input.revisionId,
        reason: plan.reason,
      }),
    })
    if (!closed?.id) throw new RevisionSwapError('REVISION_SWAP_NO_PENDING_ROUND')
    return { action: 'closed_only', roundId: closed.id, reason: plan.reason }
  }

  const closed = await closePendingApprovalRoundV1({
    query: async (sql, params) => {
      const result = await db.query(sql, params)
      return { rows: result.rows.map((row) => ({ id: asString(row.id) ?? undefined })) }
    },
  }, {
    engineInstanceId: engineId,
    outcome: 'blocked',
    blockReason: 'superseded_by_revision',
    policySnapshotAtDecision: JSON.stringify({ revisionAttemptId: input.attemptId, revisionId: input.revisionId }),
  })
  if (!closed?.id) throw new RevisionSwapError('REVISION_SWAP_NO_PENDING_ROUND')

  const newEngineId = randomUUID()
  const insertedEngine = await db.query(
    `INSERT INTO approval_instances (id, status, workflow_key, business_key, org_id, title)
     SELECT $1, 'pending', workflow_key, business_key, org_id, title
       FROM approval_instances
      WHERE id = $2
     RETURNING id`,
    [newEngineId, engineId],
  )
  if (insertedEngine.rows.length !== 1) throw new RevisionSwapError('REVISION_SWAP_ENGINE_MISSING')
  await db.query(
    `UPDATE approval_instances
        SET status = 'cancelled', updated_at = now()
      WHERE id = $1 AND status = 'pending'`,
    [engineId],
  )

  const newRoundId = `apr_${randomUUID()}`
  const phaseDeadlineAt = plan.phaseDeadlineAt.toISOString()
  await db.query(
    `INSERT INTO approval_rounds
       (id, document_id, kind, engine_instance_id, requested_by, outcome, policy_snapshot_at_create)
     VALUES ($1, $2, 'cancel', $3, $4, 'pending', $5::jsonb)`,
    [
      newRoundId,
      input.documentId,
      newEngineId,
      requestedBy,
      JSON.stringify({
        revisionAttemptId: input.attemptId,
        revisionId: input.revisionId,
        predecessorRoundId: closed.id,
        phaseDeadlineAt,
        inheritedPhaseDeadlineAt: input.inheritedPhaseDeadlineAt.toISOString(),
        newBeforeStartAt: input.newBeforeStartAt ? input.newBeforeStartAt.toISOString() : null,
        roundLifetimeEndsAt: plan.roundLifetimeEndsAt ? plan.roundLifetimeEndsAt.toISOString() : null,
      }),
    ],
  )
  return {
    action: 'swapped',
    predecessorRoundId: closed.id,
    roundId: newRoundId,
    engineInstanceId: newEngineId,
    phaseDeadlineAt,
  }
}
