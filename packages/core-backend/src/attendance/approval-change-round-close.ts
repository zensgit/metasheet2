/**
 * One pending-round close. The action path and the sweep path both call this
 * statement: `UPDATE ... WHERE outcome = 'pending' RETURNING`. A second closer
 * sees zero rows. `outcome` stays inside the six CHECK values; finer reasons
 * such as `superseded_by_revision` live in `block_reason`. `kind` stays `cancel`.
 */

export const APPROVAL_ROUND_OUTCOMES_V1 = Object.freeze([
  'pending',
  'applied',
  'rejected',
  'withdrawn',
  'expired',
  'blocked',
] as const)

export type ApprovalRoundOutcomeV1 = (typeof APPROVAL_ROUND_OUTCOMES_V1)[number]

export const APPROVAL_ROUND_BLOCK_REASONS_V1 = Object.freeze([
  'event_started',
  'superseded_by_revision',
] as const)

const TERMINAL_OUTCOMES = new Set<ApprovalRoundOutcomeV1>([
  'applied',
  'rejected',
  'withdrawn',
  'expired',
  'blocked',
])

export interface ClosePendingApprovalRoundInputV1 {
  readonly engineInstanceId: string
  readonly outcome: ApprovalRoundOutcomeV1
  readonly blockReason: string | null
  readonly policySnapshotAtDecision: string | null
}

export interface ApprovalRoundQueryClientV1 {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: ReadonlyArray<{ id?: string }>; rowCount?: number | null }>
}

export const CLOSE_PENDING_APPROVAL_ROUND_SQL_V1 = `UPDATE approval_rounds
        SET outcome = $2,
            ended_at = now(),
            block_reason = $3,
            policy_snapshot_at_decision = $4
      WHERE engine_instance_id = $1 AND outcome = 'pending'
      RETURNING id`

export async function closePendingApprovalRoundV1(
  client: ApprovalRoundQueryClientV1,
  input: ClosePendingApprovalRoundInputV1,
): Promise<{ id: string } | null> {
  if (!TERMINAL_OUTCOMES.has(input.outcome)) {
    throw new Error('APPROVAL_ROUND_CLOSE_OUTCOME_INVALID')
  }
  const result = await client.query(CLOSE_PENDING_APPROVAL_ROUND_SQL_V1, [
    input.engineInstanceId,
    input.outcome,
    input.blockReason,
    input.policySnapshotAtDecision,
  ])
  const id = result.rows[0]?.id
  return typeof id === 'string' ? { id } : null
}

/** Same function as the action path. A sweep must not grow a second UPDATE. */
export const closePendingApprovalRoundFromSweepV1 = closePendingApprovalRoundV1

export class ApprovalRoundAlreadyPendingError extends Error {
  readonly code = 'CANCEL_ROUND_ALREADY_PENDING'
  readonly httpStatus = 409

  constructor() {
    super('CANCEL_ROUND_ALREADY_PENDING')
    this.name = 'ApprovalRoundAlreadyPendingError'
  }
}

function isPendingDocumentUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const pg = error as { code?: unknown; constraint?: unknown }
  return pg.code === '23505' && pg.constraint === 'uq_approval_rounds_pending_document'
}

/**
 * Revision swap: close the old pending round, then insert the new one, in the
 * caller's transaction. The partial unique index allows only one pending round
 * per document, so the close has to land first. A 23505 on that index is
 * `CANCEL_ROUND_ALREADY_PENDING`.
 */
export async function supersedePendingRoundThenInsertV1(
  client: ApprovalRoundQueryClientV1,
  input: {
    readonly engineInstanceId: string
    readonly policySnapshotAtDecision: string
    readonly insertPending: () => Promise<void>
  },
): Promise<{ closedRoundId: string }> {
  const closed = await closePendingApprovalRoundV1(client, {
    engineInstanceId: input.engineInstanceId,
    outcome: 'blocked',
    blockReason: 'superseded_by_revision',
    policySnapshotAtDecision: input.policySnapshotAtDecision,
  })
  if (!closed) throw new ApprovalRoundAlreadyPendingError()
  try {
    await input.insertPending()
  } catch (error) {
    if (isPendingDocumentUniqueViolation(error)) throw new ApprovalRoundAlreadyPendingError()
    throw error
  }
  return { closedRoundId: closed.id }
}
