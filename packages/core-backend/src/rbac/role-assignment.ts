/**
 * The single role-assignment boundary.
 *
 * Every production `user_roles` write in `packages/core-backend/src` and `plugins/`
 * goes through this module. That is not a convention — it is asserted mechanically by
 * `tests/unit/role-assignment-boundary.test.ts`, which sweeps both SQL syntaxes over
 * both trees and requires the writer file-set to be exactly this file.
 *
 * WHAT ONE BOUNDARY GIVES THAT A PER-ROUTE CHECK DOES NOT.
 * Role assignment is bounded to the namespaces the caller's own authority grants, in one
 * place, for all four seams that perform it: platform user admin, delegated role admin,
 * the attendance admin router, and directory projected-governance. Because the DML lives
 * in one function, the bound is a property of the write itself rather than something each
 * route restates, and a route added later inherits it by construction.
 *
 * THE THREE PROPERTIES THAT MAKE IT INERT RATHER THAN FILTER-SHAPED.
 *
 *  1. `scope` is required and has no default. `RoleAssignmentScope` is a discriminated
 *     union with no member meaning "unspecified", so a caller cannot compile without
 *     naming the authority it is acting under, and a caller that omits it is denied
 *     rather than admitted.
 *
 *  2. The bounded arm is a DERIVATION, not a list of blessed values. It reuses the
 *     already-exported `roleIdMatchesNamespaces` and `isNamespaceAdmissionControlledResource`
 *     from `./namespace-admission` — the same predicates the delegated role-assign route
 *     and the directory projected-governance validator already use. A role id introduced
 *     next year is admissible exactly when its name places it inside the caller's
 *     namespace, with no table to remember to update.
 *
 *  3. `assertRoleAssignable` is synchronous and performs NO database access. Role-id
 *     *existence* is a separate concern that already lives at its call sites
 *     (`SELECT id FROM roles WHERE id = $1` → 404). Keeping this boundary DB-free keeps
 *     it a pure, cheaply-testable predicate and keeps it out of every caller's error
 *     taxonomy.
 */
import type { Response } from 'express'
import { query as poolQuery } from '../db/pg'
import { jsonError } from '../util/response'
import {
  isNamespaceAdmissionControlledResource,
  normalizeNamespace,
  roleIdMatchesNamespaces,
} from './namespace-admission'

/**
 * Structurally loose, mirroring `AliasQueryClient`: the pool wrapper, a `transaction()`
 * client and a directory-sync client all assign cleanly.
 */
export type RoleAssignmentExecutor = {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>> | unknown[]; rowCount?: number | null }>
}

/**
 * The authority a caller is acting under. Every member is explicit; there is deliberately
 * no member that means "unspecified".
 *
 *  - `platform-admin`  the caller has already been established as a platform administrator
 *                      (`ensurePlatformAdmin`). Unbounded by design: this is the seam that
 *                      creates administrators.
 *  - `namespaces`      the caller's authority is scoped to one or more admission-controlled
 *                      namespaces. Bounded by `roleIdMatchesNamespaces`.
 *  - `fixed`           the caller assigns from a closed set of role ids fixed in source
 *                      (e.g. the self-registration constant). Bounded by that set.
 */
export type RoleAssignmentScope =
  | { kind: 'platform-admin' }
  | { kind: 'namespaces'; namespaces: readonly string[] }
  | { kind: 'fixed'; roleIds: readonly string[] }

/**
 * Base for every typed refusal this boundary raises.
 *
 * `sendIfRoleAssignmentRefused` keys on THIS class and reads `status` and `code` off the
 * instance, so a refusal added to this family later is mapped at every call site that already
 * uses the mapper, with no entry added anywhere. Subclasses carry their own status and code.
 *
 * `instanceof` deliberately, rather than `error.name` or a code prefix: a name- or
 * string-keyed mapper is satisfied by any object that happens to set the field, which makes
 * the mapping decision available to data the boundary did not construct.
 */
export abstract class RoleAssignmentError extends Error {
  /** HTTP status this refusal maps to. */
  abstract readonly status: number
  /** Stable response code. Part of the API contract — not derived from the class name. */
  abstract readonly code: string
}

export class RoleAssignmentForbiddenError extends RoleAssignmentError {
  readonly status = 403
  readonly code = 'ROLE_OUT_OF_SCOPE'
  readonly roleId: string
  readonly scopeKind: RoleAssignmentScope['kind']

  constructor(roleId: string, scope: RoleAssignmentScope) {
    super(`Role "${roleId}" is outside the caller's role-assignment scope`)
    this.name = 'RoleAssignmentForbiddenError'
    this.roleId = roleId
    this.scopeKind = scope.kind
  }
}

/**
 * Response text for every refusal in this family. Fixed and caller-independent: the thrown
 * error's own message names the role id it was constructed with, and that belongs in logs,
 * not in a response body. The response carries the status and the code.
 */
const ROLE_ASSIGNMENT_REFUSED_MESSAGE = "Role is outside the caller's role-assignment scope"

/**
 * Map a boundary refusal onto its response; return false for everything else so a caller's
 * remaining error taxonomy is untouched. Same shape as `sendIfRecoveryConflict`
 * (`db/recovery-conflict.ts`), which maps that module's own typed error the same way.
 *
 *   } catch (error) {
 *     if (sendIfRoleAssignmentRefused(res, error)) return
 *     ...the route's own errors...
 *   }
 *
 * Without this at a call site, a refusal reaches that call site's generic handler and is
 * reported as a server fault rather than as a permission outcome.
 */
export function sendIfRoleAssignmentRefused(res: Response, error: unknown): boolean {
  if (!(error instanceof RoleAssignmentError)) return false
  jsonError(res, error.status, error.code, ROLE_ASSIGNMENT_REFUSED_MESSAGE)
  return true
}

function normalizeRoleId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Reduce a caller-declared namespace list to the namespaces that are actually
 * admission-controlled, using the shipped predicate rather than a local copy.
 *
 * This is what keeps the platform-admin role id unassignable under every `namespaces`
 * scope without naming it: to match it a caller would have to declare the namespace
 * `admin`, and `admin` is not admission-controlled, so it is dropped here. The refusal
 * is a consequence of the shared resource classification, not of a denylist that a
 * future edit could forget to extend.
 */
function admissionControlledNamespaces(namespaces: readonly string[]): string[] {
  const normalized = namespaces
    .map((namespace) => normalizeNamespace(namespace))
    .filter((namespace) => Boolean(namespace) && isNamespaceAdmissionControlledResource(namespace))
  return Array.from(new Set(normalized))
}

/**
 * Throws `RoleAssignmentForbiddenError` unless `roleId` is assignable under `scope`.
 * Synchronous and DB-free by design (see the module header, property 3).
 */
export function assertRoleAssignable(roleId: string, scope: RoleAssignmentScope): void {
  const normalizedRoleId = normalizeRoleId(roleId)
  if (!normalizedRoleId) throw new RoleAssignmentForbiddenError(normalizeRoleId(roleId), scope)

  switch (scope.kind) {
    case 'platform-admin':
      return
    case 'fixed': {
      const allowed = scope.roleIds.map((candidate) => normalizeRoleId(candidate))
      if (allowed.includes(normalizedRoleId)) return
      throw new RoleAssignmentForbiddenError(normalizedRoleId, scope)
    }
    case 'namespaces': {
      const namespaces = admissionControlledNamespaces(scope.namespaces)
      if (namespaces.length > 0 && roleIdMatchesNamespaces(normalizedRoleId, namespaces)) return
      throw new RoleAssignmentForbiddenError(normalizedRoleId, scope)
    }
  }
}

export function isRoleAssignable(roleId: string, scope: RoleAssignmentScope): boolean {
  try {
    assertRoleAssignable(roleId, scope)
    return true
  } catch (error) {
    if (error instanceof RoleAssignmentForbiddenError) return false
    throw error
  }
}

export type RoleAssignmentResult = {
  /** User ids whose membership actually changed. */
  affectedUserIds: string[]
  /** Rows reported changed by the driver, preserving each caller's prior `updated` value. */
  rowCount: number
}

function normalizeUserIds(userIds: readonly string[]): string[] {
  return Array.from(new Set(userIds.map((id) => normalizeRoleId(id)).filter(Boolean)))
}

function readAffectedUserIds(rows: Array<Record<string, unknown>> | unknown[]): string[] {
  return (rows as Array<Record<string, unknown>>)
    .map((row) => normalizeRoleId(row?.user_id))
    .filter(Boolean)
}

function executorOf(executor?: RoleAssignmentExecutor): RoleAssignmentExecutor {
  // Default to the pool wrapper. Callers inside a `transaction()` MUST pass their client:
  // acquiring a second connection while holding one is a lock-order hazard, and the write
  // would land outside the caller's atomic boundary.
  return executor ?? { query: (sql, params) => poolQuery(sql, params as unknown[]) }
}

export async function assignUserRoles(options: {
  userIds: readonly string[]
  roleId: string
  scope: RoleAssignmentScope
  executor?: RoleAssignmentExecutor
}): Promise<RoleAssignmentResult> {
  assertRoleAssignable(options.roleId, options.scope)
  const roleId = normalizeRoleId(options.roleId)
  const userIds = normalizeUserIds(options.userIds)
  if (userIds.length === 0) return { affectedUserIds: [], rowCount: 0 }

  const result = await executorOf(options.executor).query(
    `INSERT INTO user_roles (user_id, role_id)
     SELECT unnest($1::text[]), $2
     ON CONFLICT DO NOTHING
     RETURNING user_id`,
    [userIds, roleId],
  )
  const affectedUserIds = readAffectedUserIds(result.rows)
  return { affectedUserIds, rowCount: result.rowCount ?? affectedUserIds.length }
}

export async function unassignUserRoles(options: {
  userIds: readonly string[]
  roleId: string
  scope: RoleAssignmentScope
  executor?: RoleAssignmentExecutor
}): Promise<RoleAssignmentResult> {
  // Revocation is scoped identically to assignment. Unscoped revocation is its own harm:
  // it can strip authority from an account the caller has no authority over.
  assertRoleAssignable(options.roleId, options.scope)
  const roleId = normalizeRoleId(options.roleId)
  const userIds = normalizeUserIds(options.userIds)
  if (userIds.length === 0) return { affectedUserIds: [], rowCount: 0 }

  const result = await executorOf(options.executor).query(
    `DELETE FROM user_roles
     WHERE role_id = $2 AND user_id = ANY($1::text[])
     RETURNING user_id`,
    [userIds, roleId],
  )
  const affectedUserIds = readAffectedUserIds(result.rows)
  return { affectedUserIds, rowCount: result.rowCount ?? affectedUserIds.length }
}
