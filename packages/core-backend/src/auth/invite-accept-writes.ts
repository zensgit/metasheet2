/**
 * Invite accept durable writes (T1 / PR #4559).
 *
 * Ledger-first conditional consume + user password write in ONE transaction:
 * - markInviteAccepted requires status='pending' and RETURNING non-empty
 * - user UPDATE requires activation_status='activated' and RETURNING non-empty
 * - either zero-row aborts and rolls back the other
 *
 * Extracted so real-DB concurrency/rollback goldens exercise the same path as /invite/accept.
 */

import { transaction } from '../db/pg'
import { markInviteAccepted } from './invite-ledger'

export const INVITE_LEDGER_CONSUME_FAILED = 'INVITE_LEDGER_CONSUME_FAILED'
export const INVITE_TARGET_UPDATE_MISMATCH = 'INVITE_TARGET_UPDATE_MISMATCH'

export type InviteAcceptWriteInput = {
  inviteToken: string
  userId: string
  email: string
  passwordHash: string
  /** Empty string leaves name unchanged. */
  requestedName: string
}

export function inviteAcceptWriteErrorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code
}

/**
 * Consume pending invite ledger row, then set password on the activated user.
 * Throws with code INVITE_LEDGER_CONSUME_FAILED or INVITE_TARGET_UPDATE_MISMATCH.
 */
export async function applyInviteAcceptanceWrites(input: InviteAcceptWriteInput): Promise<void> {
  await transaction(async (client) => {
    const ledger = await markInviteAccepted(input.inviteToken, {
      consumedBy: input.userId,
      client,
    })
    if (!ledger) {
      throw Object.assign(new Error('Invite ledger could not be consumed'), {
        code: INVITE_LEDGER_CONSUME_FAILED,
      })
    }

    const updated = await client.query(
      `UPDATE users
       SET password_hash = $1,
           must_change_password = FALSE,
           local_password_set = TRUE,
           is_active = true,
           name = COALESCE(NULLIF($2, ''), name),
           updated_at = NOW()
       WHERE id = $3 AND email = $4
         AND activation_status = 'activated'
       RETURNING id`,
      [input.passwordHash, input.requestedName, input.userId, input.email],
    )
    if (!updated.rows[0]) {
      throw Object.assign(new Error('Invite target could not be updated'), {
        code: INVITE_TARGET_UPDATE_MISMATCH,
      })
    }
  })
}
