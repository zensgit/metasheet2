/**
 * Directory sync membership-write decision.
 *
 * Invariant: directory synchronisation confirms an ACTIVE `user_orgs` membership only for a
 * local account that passes the shared user authentication gate
 * (`evaluateUserAuthenticationGate`). A person who is active in the external directory is
 * not, by that fact alone, a local account that may hold an active organisation membership,
 * nor one whose deprovision evidence may be superseded. Account activation, recycle-bin
 * restore and deprovision-evidence restore keep their own controlled flows; this module only
 * decides whether the sync loop may write.
 *
 * Pure: no database access. The sync loop passes the `users` row it already holds under the
 * access-graph mutex (`lockUsersForAccessGraphWrite`), or the row snapshot of a user it
 * created in the same transaction, so the decision reads the post-lock state.
 */

import { evaluateUserAuthenticationGate } from '../auth/user-activation'

/** The subset of a locked `users` row the decision consumes. */
export type DirectorySyncLocalAccountSnapshot = {
  isActive: boolean
  role: string | null
  activationStatus: string | null
  deletedAt: string | null
  purgedAt: string | null
}

export type DirectorySyncLocalAccountDenial = {
  code: string
}

/**
 * Maps a locked `users` row onto the shared authentication gate's input. Returns the gate's
 * denial code, or `null` when the local account passes.
 */
export function evaluateDirectorySyncLocalAccountGate(
  user: DirectorySyncLocalAccountSnapshot,
): DirectorySyncLocalAccountDenial | null {
  const denial = evaluateUserAuthenticationGate({
    is_active: user.isActive,
    role: user.role,
    activation_status: user.activationStatus,
    deleted_at: user.deletedAt,
    purged_at: user.purgedAt,
  })
  return denial ? { code: denial.code } : null
}

export type DirectorySyncMembershipWriteInput = {
  linkStatus: string
  localUserId: string | null
  /** `directory_accounts.is_active` as of this sync (post-sweep). */
  accountActive: boolean
  /** The account carries applied deprovision evidence that an open rehire must keep. */
  preservesOpenRehireEvidence: boolean
  /** The local `users` row under the access-graph mutex, or the same-transaction creation snapshot. */
  localUser: DirectorySyncLocalAccountSnapshot | undefined
}

export type DirectorySyncMembershipWriteDecision =
  | { write: true }
  | {
      write: false
      reason:
        | 'not_linked'
        | 'account_inactive'
        | 'open_rehire_evidence'
        | 'local_user_missing'
      code?: undefined
    }
  | { write: false; reason: 'local_account_gate'; code: string }

/**
 * Rules, in priority order:
 *  R0 the account is not linked to a local user → no write;
 *  R1 the directory account is inactive → no write;
 *  R2 the account carries open-rehire evidence → no write (restore is a controlled flow);
 *  R4 the local row is not available → no write (fail closed);
 *  R5 the local account fails the shared authentication gate → no write, with the gate's code;
 *  otherwise the membership may be confirmed.
 */
export function resolveDirectorySyncMembershipWrite(
  input: DirectorySyncMembershipWriteInput,
): DirectorySyncMembershipWriteDecision {
  if (input.linkStatus !== 'linked' || !input.localUserId) {
    return { write: false, reason: 'not_linked' }
  }
  if (!input.accountActive) {
    return { write: false, reason: 'account_inactive' }
  }
  if (input.preservesOpenRehireEvidence) {
    return { write: false, reason: 'open_rehire_evidence' }
  }
  if (!input.localUser) {
    return { write: false, reason: 'local_user_missing' }
  }
  const denial = evaluateDirectorySyncLocalAccountGate(input.localUser)
  if (denial) {
    return { write: false, reason: 'local_account_gate', code: denial.code }
  }
  return { write: true }
}
