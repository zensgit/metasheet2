/**
 * O2-S2 — single 40001 recovery-conflict classifier + boundary adapters.
 *
 * Exact-anchor recovery (P23) holds a per-subject advisory lease across the eight
 * recovery-authority tables (users, user_roles, user_permissions, role_permissions,
 * field_permissions, record_permissions, spreadsheet_permissions,
 * platform_member_group_members). A write against one of those tables under a held lease
 * fails fast with Postgres SQLSTATE 40001 and message RECOVERY_AUTHORITY_BUSY_MARKER —
 * a transient, retryable condition that must surface as a retryable 409 (or a named
 * retryable service error), never as an unclassified 500.
 *
 * Lesson constraint (枚举陷阱不收敛): individual try/catch traps per write site do not
 * converge — every audit finds a new unclassified writer. This module is the ONE
 * classifier; a mechanical census test
 * (tests/unit/recovery-conflict-census.test.ts) asserts every enumerated write surface
 * routes through it.
 *
 * The discriminator is REUSED, not re-derived: `isRecoveryAuthorityBusyError`
 * (multitable/recovery-authorization-stability.ts) is the same predicate admin-users and
 * AuthService already use — code '40001' AND the exact marker message. A bare 40001
 * without the marker (a genuine serialization_failure outside the recovery lease) is
 * deliberately NOT classified here: those keep their original, byte-identical error
 * paths. This module only ADDS a mapping for the lease-marker family; it loosens
 * nothing.
 */

import type { Response } from 'express'
import { isRecoveryAuthorityBusyError } from '../multitable/recovery-authorization-stability'
import { jsonError } from '../util/response'

/**
 * Reuses the SAME error code (and message) the platform already publishes for this
 * condition — univer-meta.ts sendRecoveryAuthorityBusy and admin-users.ts introduced
 * `RECOVERY_AUTHORITY_BUSY` at 409; no new marker/constant/code is minted here.
 */
export const RECOVERY_CONFLICT_HTTP_STATUS = 409
export const RECOVERY_CONFLICT_HTTP_CODE = 'RECOVERY_AUTHORITY_BUSY'
export const RECOVERY_CONFLICT_HTTP_MESSAGE =
  'Recovery is stabilizing permissions; retry this change.'

/**
 * `assignUserRoles` (auth/AuthService.ts) already converts an exhausted 40001 retry loop
 * into its own named error carrying this code. The classifier recognises it BY CODE —
 * importing the class from AuthService here would invert the auth→db layering and risk a
 * module cycle. tests/unit/recovery-conflict-classifier.test.ts constructs the real class
 * and pins this string against rename/code drift.
 */
const USER_ROLE_ASSIGNMENT_RECOVERY_BUSY_CODE = 'USER_ROLE_ASSIGNMENT_RECOVERY_BUSY'

/**
 * Named retryable error for SERVICE layers (modules that throw coded errors rather than
 * writing HTTP responses). Carries the same published code, plus `retryable: true`, so
 * any express boundary — including ones that only switch on `.code` — can map it without
 * an instanceof (dual-copy/realm-safe: `classifyRecoveryConflict` discriminates by
 * code+retryable, never by identity of this class).
 */
export class RecoveryConflictError extends Error {
  readonly code = RECOVERY_CONFLICT_HTTP_CODE
  readonly retryable = true

  constructor(cause: unknown) {
    // Values-free fixed message: never echo driver text.
    super(RECOVERY_CONFLICT_HTTP_MESSAGE)
    this.name = 'RecoveryConflictError'
    if (cause !== undefined) {
      Object.assign(this, { cause })
    }
  }
}

function readErrorShape(error: unknown): { code?: unknown; retryable?: unknown } | null {
  if (typeof error !== 'object' || error === null) return null
  return error as { code?: unknown; retryable?: unknown }
}

/**
 * THE single classifier. Returns 'recovery_conflict' when (and only when) the error is a
 * member of the recovery-authority-busy family:
 *   1. the raw Postgres error — SQLSTATE 40001 with the exact lease marker message
 *      (the EXISTING discriminator, reused verbatim);
 *   2. a service-layer `RecoveryConflictError` re-raise (code + retryable, realm-safe);
 *   3. AuthService's `UserRoleAssignmentRecoveryBusyError` (an already-retried,
 *      exhausted member of the same family — recognised by ITS code + retryable).
 * Everything else → null: callers must leave every other error path untouched.
 */
export function classifyRecoveryConflict(error: unknown): 'recovery_conflict' | null {
  if (isRecoveryAuthorityBusyError(error)) return 'recovery_conflict'
  const shape = readErrorShape(error)
  if (!shape || shape.retryable !== true) return null
  if (shape.code === RECOVERY_CONFLICT_HTTP_CODE) return 'recovery_conflict'
  if (shape.code === USER_ROLE_ASSIGNMENT_RECOVERY_BUSY_CODE) return 'recovery_conflict'
  return null
}

/**
 * SERVICE-layer adapter: run a write operation; a recovery conflict is re-raised as the
 * named retryable `RecoveryConflictError`, every other outcome (value or error) passes
 * through unchanged — the original error OBJECT is rethrown, so non-40001 behaviour is
 * byte-for-byte identical for callers.
 */
export async function translateRecoveryConflict<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op()
  } catch (error) {
    if (error instanceof RecoveryConflictError) throw error
    if (classifyRecoveryConflict(error) === 'recovery_conflict') {
      throw new RecoveryConflictError(error)
    }
    throw error
  }
}

/**
 * EXPRESS-boundary adapter: if the error is a recovery conflict, write the uniform
 * retryable 409 (same status/code/message/details shape admin-users.ts already
 * publishes) and return true; otherwise write NOTHING and return false so the caller's
 * existing error path runs unchanged.
 *
 * Body is values-free: fixed code/message/retryable flag, no user- or request-derived
 * data (审计面禁止编造值 applies — nothing from the thrown error is echoed).
 */
export function sendIfRecoveryConflict(res: Response, error: unknown): boolean {
  if (classifyRecoveryConflict(error) !== 'recovery_conflict') return false
  jsonError(
    res,
    RECOVERY_CONFLICT_HTTP_STATUS,
    RECOVERY_CONFLICT_HTTP_CODE,
    RECOVERY_CONFLICT_HTTP_MESSAGE,
    { retryable: true },
  )
  return true
}
