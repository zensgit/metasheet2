/**
 * W0-1 L5-wire — authorization primitives for trust-checkpoint ACTIVATION.
 *
 * Two independent preconditions live here, both fail-closed, both extracted out of
 * `routes/univer-meta.ts` (that file is already a mega-file; new logic goes in a sibling module).
 *
 * ## 1. DB-fresh in-transaction authority (the P2 defect this module was created for)
 *
 * The route's OUTER `resolveSheetCapabilities(req, …)` call can be satisfied from JWT CLAIMS ALONE:
 * `resolveRequestAccess` (multitable/access.ts) returns early — WITHOUT touching the database —
 * whenever the token carries `role: 'admin'` / `roles: ['admin']`, and again whenever the token
 * carries a non-empty `perms` / `permissions` array. A user whose grants were REVOKED in the
 * database but whose JWT has not yet expired therefore still cleared the D2 floor, and nothing
 * inside the fenced transaction re-checked it. A trust checkpoint is the trust ANCHOR that
 * destructive recovery (Revert / Reset-to-T) later resolves against, so minting one is exactly the
 * authority a revoked actor must not retain.
 *
 * `assertTrustCheckpointActivationAuthority` re-derives the authority INSIDE the caller's
 * transaction, from CURRENT database rows, using the SAME shared mechanism the exact-anchor
 * recovery routes already use for their in-fence adjudication —
 * `resolveRecoverySheetAuthority` (multitable/recovery-authorization-stability.ts), which
 * intersects the request-claim capabilities with capabilities recomputed from
 * `loadDatabaseFreshRecoveryAccess`. Claims may still IDENTIFY the actor; they can never WIDEN the
 * grant, because the intersection's database half is read fresh under the held fence.
 *
 * Placement matters: the caller must take the canonical writer fence FIRST and only then call this,
 * so a revoke that commits while the activation parks on the fence is observed here rather than
 * missed by a pre-fence closure (the same P1-2 TOCTOU doctrine as `makeFullReadEvaluator`).
 *
 * KNOWN RESIDUAL (disclosed, not closed): the transaction runs at READ COMMITTED, so a revoke that
 * commits in the sliver between this check's reads and the checkpoint write is not observed. That
 * window is bounded by one in-transaction cutover rather than by JWT lifetime, which is the whole
 * point of the change; closing it entirely would need the recovery-authority LEASE mechanism
 * (`acquireRecoveryAuthorityLease`), whose busy/unavailable states and lock-order obligations are
 * deliberately out of scope for this slice.
 *
 * ## 2. Fail-closed canary sheet allowlist
 *
 * The O-2 enablement ladder's L2-C rung provisions a checkpoint for a NAMED synthetic canary sheet
 * only, and explicitly forbids bulk-provisioning customer sheets. That was convention: the route
 * accepted any sheet id. `MULTITABLE_TRUST_CHECKPOINT_SHEET_ALLOWLIST` turns the convention into a
 * precondition by construction — UNSET or EMPTY means activation refuses for EVERY sheet, so an
 * operator must designate the canary explicitly before any checkpoint can be minted anywhere. This
 * module names no sheet; designation is entirely the owner's.
 */
import type { Request } from 'express'

import { resolveRecoverySheetAuthority } from './recovery-authorization-stability'
import type { QueryFn } from './permission-service'

/**
 * Comma-separated list of sheet ids for which trust-checkpoint activation is permitted.
 * Fail-closed: unset / empty / whitespace-only ⇒ NO sheet may be activated.
 */
export const TRUST_CHECKPOINT_SHEET_ALLOWLIST_ENV = 'MULTITABLE_TRUST_CHECKPOINT_SHEET_ALLOWLIST'

export const TRUST_CHECKPOINT_SHEET_NOT_ALLOWLISTED_CODE = 'TRUST_CHECKPOINT_SHEET_NOT_ALLOWLISTED'

/**
 * Values-free refusal message: it names the env var and the required owner action, never the
 * requested sheet id and never the allowlist contents (a refused caller must not learn which
 * sheets ARE designated).
 */
export const TRUST_CHECKPOINT_SHEET_NOT_ALLOWLISTED_MESSAGE =
  'Trust-checkpoint activation is refused for this sheet: it is not in the designated canary allowlist. ' +
  'The owner must designate the canary sheets in MULTITABLE_TRUST_CHECKPOINT_SHEET_ALLOWLIST ' +
  '(comma-separated sheet ids); while that list is unset or empty, activation is refused for every sheet.'

/**
 * Parse the allowlist. Entries are trimmed and empty entries dropped, so `''`, `','`, and `' , , '`
 * all resolve to the empty list (⇒ refuse everything) rather than to a list containing `''`, which
 * would otherwise make a blank sheet id "allowlisted".
 */
export function resolveTrustCheckpointSheetAllowlist(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const raw = env[TRUST_CHECKPOINT_SHEET_ALLOWLIST_ENV]
  if (typeof raw !== 'string') return []
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/**
 * Exact match against the trimmed allowlist. No prefix / glob / case-folding: a designation is for
 * one named sheet. A blank `sheetId` is never allowlisted (the empty-entry filter above guarantees
 * the list cannot contain `''`).
 */
export function isTrustCheckpointSheetAllowlisted(
  sheetId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const candidate = sheetId.trim()
  if (!candidate) return false
  return resolveTrustCheckpointSheetAllowlist(env).includes(candidate)
}

/**
 * Thrown by `assertTrustCheckpointActivationAuthority` when the DB-fresh re-check denies the actor.
 * The caller maps it to the SAME 403 envelope as `sendForbidden` — a revoked actor learns only
 * "forbidden", never whether the sheet exists, is allowlisted, or has a checkpoint.
 */
export class TrustCheckpointActivationForbiddenError extends Error {
  constructor() {
    super('Trust-checkpoint activation forbidden: the actor lacks current sheet-admin authority')
    this.name = 'TrustCheckpointActivationForbiddenError'
  }
}

/**
 * Re-verify sheet-admin authority from CURRENT database rows, inside the caller's transaction.
 *
 * `query` MUST be the transaction's own query function (never the pool's) and the canonical writer
 * fence MUST already be held, or this degrades back into the pre-fence check it replaces.
 *
 * Throws `TrustCheckpointActivationForbiddenError` unless BOTH hold, freshly resolved:
 *   1. the actor is identified (`access.userId`), and
 *   2. `capabilities.canManageSheetAccess` survives the intersection of request claims with
 *      database-fresh authority — i.e. the grant is backed by current rows, not by the token.
 */
export async function assertTrustCheckpointActivationAuthority(
  req: Request,
  query: QueryFn,
  sheetId: string,
): Promise<void> {
  const { access, capabilities } = await resolveRecoverySheetAuthority(req, query, sheetId)
  if (!access.userId || !capabilities.canManageSheetAccess) {
    throw new TrustCheckpointActivationForbiddenError()
  }
}
