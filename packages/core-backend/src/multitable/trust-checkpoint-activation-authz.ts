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
 * ## 1b. The actor authority LEASE (this slice) — closing the READ COMMITTED window
 *
 * §1's residual was: the transaction runs at READ COMMITTED, so a revoke that commits in the sliver
 * between the DB-fresh check's reads and the checkpoint write is not observed. `acquireRecoveryAuthorityLease`
 * (recovery-authorization-stability.ts) is the EXISTING mechanism that closes it — the SAME lease the
 * exact-anchor destructive apply already takes, on the SAME lock keys. Nothing new is minted here: no
 * new lock key, no second protocol, no second lease helper.
 *
 * `acquireTrustCheckpointActivationLease` is a thin, named adapter that
 *   1. derives the lease subject from the AUTHENTICATED PRINCIPAL ONLY (`resolveRequestAccess(req)`),
 *      never from the request body, the sheet id, or the canary allowlist — by construction, since it
 *      accepts no other value from which a subject could be taken;
 *   2. calls `acquireRecoveryAuthorityLease` once, with no retry (L2-C is an owner operation; an
 *      explicit retry after a `busy` refusal is the operator's, never this route's — an in-transaction
 *      re-poll would hold the canonical fence across attempts and starve every writer of that sheet);
 *   3. converts the three-valued outcome into two THROWN, named refusals so the caller's transaction
 *      ROLLS BACK immediately and can never reach `activateCheckpoint`:
 *        ready       → return the leased subject id (the caller proceeds);
 *        busy        → `TrustCheckpointAuthorityBusyError`        (retryable, values-free 409);
 *        unavailable → `TrustCheckpointAuthorityUnavailableError` (fail closed, values-free 409).
 *
 * ORDER IS LOAD-BEARING, and it is the caller's obligation (see the route):
 *   BEGIN → canonical sheet fence → THIS lease → DB-fresh FINAL authorization
 *         → durable-block / allowlist / existence adjudication → activateCheckpoint → COMMIT
 * The canonical fence must remain the FIRST lock the transaction takes: the activation, while holding
 * the fence, takes a blocking `FOR KEY SHARE` on `meta_sheets(S)` through the checkpoint FK, and seven
 * production sites take `meta_sheets(S) FOR UPDATE` / delete the row. None of them acquires the fence
 * afterwards, so no cycle exists today — taking any `meta_sheets` row lock BEFORE the fence here would
 * construct one (a real 40P01, reproduced by the lock-order census and by this slice's
 * FENCE-FIRST-ORDER golden).
 *
 * The lease itself contributes NO blocking edge: it is `LOCK TABLE … IN ROW EXCLUSIVE MODE NOWAIT`
 * plus `pg_try_advisory_xact_lock` in both the exclusive (this caller) and shared (the nine writer
 * triggers) direction. A loser gets a VERDICT, never a queue slot, so it can never participate in a
 * deadlock cycle. That is why fence → lease is safe while lease → fence would not be.
 *
 * FAIL-CLOSED ON A NON-CANONICAL SUBSTRATE — INTENTIONAL, NOT A DEFECT. `acquireRecoveryAuthorityLease`
 * returns `'unavailable'` unless the canonical authority substrate is exactly 9/9 ARMED (nine writer
 * triggers `tgenabled='O'` plus six matching function fingerprints). The migration ships all nine
 * DISABLED, so on a default database trust-checkpoint activation REFUSES. That is rung precedence: the
 * lease is what makes the window closed, and on a disabled rung it would exclude nothing — the eight
 * table locks are ROW EXCLUSIVE (self-compatible with ordinary DML) and the per-subject exclusive keys
 * are uncontended because the triggers are the only shared-lock acquirers. Degrading to `'ready'` there
 * would not ship a weaker lease, it would ship a lease that protects NOTHING while still holding eight
 * platform-wide table locks to COMMIT. No escape hatch, no env bypass, and no "if the triggers are
 * disabled, skip the lease" branch may be added.
 *
 * DO NOT reorder the lease's internals to reduce false-busy: `LOCK TABLE … NOWAIT` runs BEFORE the
 * substrate fingerprint check on purpose — lock-then-verify is the DDL TOCTOU defense.
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
// REVOCATION SURFACE NOTE: the DB-fresh resolver reads users.role / users.is_active / user_roles /
// user_permissions / role_permissions AND the legacy users.permissions JSON column (see
// recovery-authorization-stability.ts loadDatabaseFreshRecoveryAccess). A revocation that only
// deletes user_permissions rows while leaving a grant in the legacy JSON column is INCOMPLETE and
// this gate will still admit it — shared semantics inherited from the resolver, not widened here.
import type { Request } from 'express'

import { resolveRequestAccess } from './access'
import {
  acquireRecoveryAuthorityLease,
  resolveRecoverySheetAuthority,
} from './recovery-authorization-stability'
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

// ── 1b. actor authority lease ─────────────────────────────────────────────────────────────────────

/**
 * Named, RETRYABLE refusal: the actor's authority keys are held by a concurrent permission writer or
 * recovery, or one of the eight authority tables is table-locked by another session. Nothing was
 * written; an explicit operator retry is the correct response. Deliberately NOT the platform-wide
 * `RECOVERY_AUTHORITY_BUSY` code: univer-meta.ts's file-local `sendRecoveryAuthorityBusy` publishes
 * that code with NO `details`, while the shared `db/recovery-conflict.ts` adapters publish it WITH
 * `error.details.retryable = true`. tests/unit/recovery-conflict-census.test.ts records that
 * divergence verbatim and states that reconciling the two bodies is "a response-contract change
 * across five L1-armed routes — an owner call, deliberately not taken here". Emitting a SIXTH
 * `RECOVERY_AUTHORITY_BUSY` from the same file with a third body shape would deepen exactly that
 * divergence, so this surface carries its own code and states `retryable` explicitly.
 */
export const TRUST_CHECKPOINT_AUTHORITY_BUSY_CODE = 'TRUST_CHECKPOINT_AUTHORITY_BUSY'
export const TRUST_CHECKPOINT_AUTHORITY_BUSY_MESSAGE =
  'Trust-checkpoint activation could not take the actor authority lease: the recovery-authority ' +
  'substrate is busy. Nothing was written. Retry this activation.'

/**
 * Named, NON-retryable refusal: the canonical recovery-authority substrate is not exactly 9/9 ARMED
 * (or a required lock function is missing / drifted). Fail closed — activation is unavailable until an
 * operator arms the substrate. Values-free: it names the operator action, never which trigger, which
 * table, which function, or how many are armed (a refused caller must not be able to fingerprint the
 * deployment's rung from the response).
 */
export const TRUST_CHECKPOINT_AUTHORITY_UNAVAILABLE_CODE = 'TRUST_CHECKPOINT_AUTHORITY_UNAVAILABLE'
export const TRUST_CHECKPOINT_AUTHORITY_UNAVAILABLE_MESSAGE =
  'Trust-checkpoint activation is unavailable: the recovery-authority substrate is not armed on this ' +
  'deployment, so the actor authority lease cannot be taken and no checkpoint may be minted. Nothing ' +
  'was written. An operator must complete the recovery-authority enablement rung first.'

/** Thrown when the lease returns `'busy'`. Retryable; the caller maps it to a values-free 409. */
export class TrustCheckpointAuthorityBusyError extends Error {
  readonly code = TRUST_CHECKPOINT_AUTHORITY_BUSY_CODE
  readonly retryable = true
  constructor() {
    super(TRUST_CHECKPOINT_AUTHORITY_BUSY_MESSAGE)
    this.name = 'TrustCheckpointAuthorityBusyError'
  }
}

/** Thrown when the lease returns `'unavailable'`. NOT retryable; the caller maps it to a values-free 409. */
export class TrustCheckpointAuthorityUnavailableError extends Error {
  readonly code = TRUST_CHECKPOINT_AUTHORITY_UNAVAILABLE_CODE
  readonly retryable = false
  constructor() {
    super(TRUST_CHECKPOINT_AUTHORITY_UNAVAILABLE_MESSAGE)
    this.name = 'TrustCheckpointAuthorityUnavailableError'
  }
}

/**
 * Take the actor authority lease for a trust-checkpoint activation, inside the caller's transaction.
 *
 * MUST be called AFTER the canonical sheet fence (the fence stays the transaction's first lock) and
 * BEFORE the DB-fresh final authorization (the lease is what makes that authorization's result stable
 * to COMMIT). Returns the leased subject id on `'ready'`; THROWS on every other outcome so the caller
 * rolls back with zero checkpoint/baseline writes — an outcome value that flowed onward could reach
 * COMMIT, which is precisely the failure this ordering exists to prevent.
 *
 * The subject is the authenticated principal and nothing else: this function takes `req` and `query`
 * only, so there is no request body, sheet id, or allowlist entry in scope from which a subject could
 * be derived. Exactly ONE attempt — no hidden auto-retry.
 */
export async function acquireTrustCheckpointActivationLease(
  req: Request,
  query: QueryFn,
): Promise<string> {
  const { userId } = await resolveRequestAccess(req)
  const subject = userId.trim()
  // An unauthenticated caller has no principal to lease. Refuse with the same uniform forbidden
  // envelope rather than leasing an empty subject (which the lease itself would call 'unavailable',
  // conflating "no actor" with "substrate not armed").
  if (!subject) throw new TrustCheckpointActivationForbiddenError()

  const outcome = await acquireRecoveryAuthorityLease(query, [subject])
  if (outcome === 'ready') return subject
  if (outcome === 'busy') throw new TrustCheckpointAuthorityBusyError()
  throw new TrustCheckpointAuthorityUnavailableError()
}

// ── 2b. post-lease target adjudication ────────────────────────────────────────────────────────────

/**
 * Thrown by `assertTrustCheckpointSheetAllowlisted`. Carries no sheet id: the refusal envelope must
 * name neither the requested sheet nor the designated ones.
 */
export class TrustCheckpointSheetNotAllowlistedError extends Error {
  readonly code = TRUST_CHECKPOINT_SHEET_NOT_ALLOWLISTED_CODE
  constructor() {
    super(TRUST_CHECKPOINT_SHEET_NOT_ALLOWLISTED_MESSAGE)
    this.name = 'TrustCheckpointSheetNotAllowlistedError'
  }
}

/** Thrown when the target sheet does not exist. Adjudicated only AFTER the post-lease final authorization. */
export class TrustCheckpointSheetMissingError extends Error {
  readonly code = 'NOT_FOUND'
  constructor() {
    super('Trust-checkpoint activation target sheet does not exist')
    this.name = 'TrustCheckpointSheetMissingError'
  }
}

/**
 * Throwing form of `isTrustCheckpointSheetAllowlisted`, for use INSIDE the activation transaction.
 *
 * The allowlist / 404 / durable-block adjudications are differentiated responses, so they must run
 * only after an actor's authority has been confirmed against a STABLE database state — i.e. after the
 * lease and the post-lease final authorization. Adjudicating them before that (as the pre-transaction
 * ordering did) leaves a post-revocation state oracle: an actor revoked in the sliver after the
 * pre-transaction check could still tell 409 (designated canary missing) from 404 (no such sheet) and
 * enumerate the owner's designations.
 */
export function assertTrustCheckpointSheetAllowlisted(
  sheetId: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isTrustCheckpointSheetAllowlisted(sheetId, env)) {
    throw new TrustCheckpointSheetNotAllowlistedError()
  }
}

/** Existence adjudication, in-transaction, after the final authorization. */
export async function assertTrustCheckpointSheetExists(
  query: QueryFn,
  sheetId: string,
): Promise<void> {
  const exists = await query('SELECT 1 FROM meta_sheets WHERE id = $1', [sheetId])
  if (exists.rows.length === 0) throw new TrustCheckpointSheetMissingError()
}
