/**
 * 按人查单（管理员）— the ONE builder for "this approval instance involves user X, in sense K".
 *
 * Served by `GET /api/approvals/admin/by-user` (guarded by `approvals:admin`, the same permission
 * as 批量转交) through `ApprovalBridgeService.listApprovals`. It is a client FILTER inside the
 * list's server-determined scope: the scope conjunct (`buildApprovalListScopeCondition`) is still
 * appended unconditionally, so this module can only ever narrow what the caller may already list.
 *
 * THREE KINDS, each an `approval_instances` condition over ONE bound placeholder (the user id):
 *   - `pending`  当前待审批: the user holds an ACTIVE seat on a pending platform instance. The seat
 *                conjunct is `approvalActiveAssigneeConditionSql`, the very text the list's
 *                existing `assignee` filter emits — so this kind and the 批量转交 page's queue
 *                read (`assignee` + `status=pending` + platform) select the same rows.
 *   - `decided`  已审批: the user recorded a decision on the instance (any current status). The
 *                decision set is `APPROVAL_BY_USER_DECISION_ACTIONS`.
 *   - `involved` 参与过: the user is the requester, holds or held a USER seat (active or not), recorded
 *                any participant action, or is a USER-typed CC target.
 *
 * PLATFORM ROWS ONLY. Seats and `approval_records` are platform-side; every kind carries the
 * platform conjunct so an external mirror row can never match on a coincidental id.
 *
 * USER ARMS ONLY, on purpose. A role-typed seat or a role-typed CC names a role, not a person, and
 * the user's role membership at the time cannot be recovered from today's `user_roles`. An instance
 * the user only ever reached through a role, and never acted on, is therefore not counted. Once the
 * user acts on it, the action record counts it.
 */

import { approvalCcTargetMatchSql } from './approval-cc-predicate'
import type { UnifiedApprovalDTO } from './approval-bridge-types'

export const APPROVAL_BY_USER_KINDS = ['pending', 'decided', 'involved'] as const
export type ApprovalByUserKind = typeof APPROVAL_BY_USER_KINDS[number]

export function isApprovalByUserKind(value: unknown): value is ApprovalByUserKind {
  return typeof value === 'string' && (APPROVAL_BY_USER_KINDS as readonly string[]).includes(value)
}

/**
 * 已审批 — the `approval_records.action` values that count as the user having DECIDED: approve,
 * reject, return (退回) and handle (办理提交). Every other action in the records CHECK is excluded:
 * `transfer` / `add_sign` / `reduce_sign` hand the decision to someone else, `revoke` is the
 * requester withdrawing, `comment` / `remind` decide nothing, `created` / `cc` / `sign` / `jump` /
 * `reassign` / `policy_denied` are system or administrator rows.
 */
export const APPROVAL_BY_USER_DECISION_ACTIONS = ['approve', 'reject', 'return', 'handle'] as const

/**
 * 参与过 — actor rows that do NOT make the actor a participant: an administrator moving seats
 * (`reassign`) or the flow (`jump`) is operating on the instance, not taking part in it.
 */
export const APPROVAL_BY_USER_NON_PARTICIPANT_ACTIONS = ['reassign', 'jump'] as const

export const APPROVAL_BY_USER_DEFAULT_PAGE_SIZE = 20
export const APPROVAL_BY_USER_MAX_PAGE_SIZE = 100
export const APPROVAL_BY_USER_MAX_PAGE = 1000
/** Upper bound on the `userId` query value; a users.id is far shorter. */
export const APPROVAL_BY_USER_MAX_USER_ID_LENGTH = 255

const PLATFORM_ROW_SQL = `COALESCE(source_system, 'platform') = 'platform'`

function sqlStringList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ')
}

/**
 * The list's `assignee` filter conjunct: an ACTIVE seat of any type whose `assignee_id` is the
 * bound value. `ApprovalBridgeService.buildListWhere` emits its `assignee` filter through this
 * function, so the text is shared rather than copied.
 */
export function approvalActiveAssigneeConditionSql(userParam: number): string {
  return `id IN (
          SELECT instance_id
          FROM approval_assignments
          WHERE assignee_id = $${userParam}
            AND is_active = TRUE
        )`
}

export function approvalByUserConditionSql(kind: ApprovalByUserKind, userParam: number): string {
  if (kind === 'pending') {
    return `(
          ${PLATFORM_ROW_SQL}
          AND status = 'pending'
          AND ${approvalActiveAssigneeConditionSql(userParam)}
        )`
  }
  if (kind === 'decided') {
    return `(
          ${PLATFORM_ROW_SQL}
          AND id IN (
            SELECT instance_id
            FROM approval_records
            WHERE actor_id = $${userParam}
              AND action IN (${sqlStringList(APPROVAL_BY_USER_DECISION_ACTIONS)})
          )
        )`
  }
  if (kind === 'involved') {
    return `(
          ${PLATFORM_ROW_SQL}
          AND (
            requester_snapshot->>'id' = $${userParam}
            OR id IN (
              SELECT instance_id
              FROM approval_assignments
              WHERE assignment_type = 'user'
                AND assignee_id = $${userParam}
            )
            OR id IN (
              SELECT instance_id
              FROM approval_records
              WHERE actor_id = $${userParam}
                AND action NOT IN (${sqlStringList(APPROVAL_BY_USER_NON_PARTICIPANT_ACTIONS)})
            )
            OR id IN (
              SELECT instance_id
              FROM approval_records
              WHERE action = 'cc'
                AND ${approvalCcTargetMatchSql({ actorParam: userParam, rolesParam: null })}
            )
          )
        )`
  }
  // Enum-strict: an unknown kind is a programming error, never a silent "no filter".
  throw new TypeError('approvalByUserConditionSql: unknown kind')
}

export interface ApprovalByUserQuery {
  userId: string
  kind: ApprovalByUserKind
  page: number
  pageSize: number
}

export type ApprovalByUserQueryParseResult =
  | { ok: true; value: ApprovalByUserQuery }
  | { ok: false; code: string; message: string }

const ALLOWED_QUERY_KEYS = new Set(['userId', 'kind', 'page', 'pageSize'])

function parsePositiveIntParam(
  value: unknown,
  fallback: number,
  max: number,
): number | null {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !/^[0-9]{1,6}$/.test(value)) return null
  const parsed = Number.parseInt(value, 10)
  if (parsed < 1 || parsed > max) return null
  return parsed
}

/**
 * Validates the `GET /api/approvals/admin/by-user` query. Values-free errors (codes and fixed
 * messages only). Unknown keys, repeated / bracketed keys (which arrive as arrays), an empty or
 * over-long `userId`, an unknown `kind`, and out-of-range paging are all refused with 400 rather
 * than coerced.
 */
export function parseApprovalByUserQuery(query: Record<string, unknown>): ApprovalByUserQueryParseResult {
  if (Object.keys(query).some((key) => !ALLOWED_QUERY_KEYS.has(key))) {
    return { ok: false, code: 'VALIDATION_ERROR', message: 'Unsupported query parameter' }
  }
  const rawUserId = query.userId
  const userId = typeof rawUserId === 'string' ? rawUserId.trim() : ''
  if (!userId || userId.length > APPROVAL_BY_USER_MAX_USER_ID_LENGTH) {
    return { ok: false, code: 'APPROVAL_BY_USER_USER_REQUIRED', message: 'userId must be a single non-empty value' }
  }
  const kind = query.kind
  if (!isApprovalByUserKind(kind)) {
    return {
      ok: false,
      code: 'APPROVAL_BY_USER_KIND_INVALID',
      message: `kind must be one of ${APPROVAL_BY_USER_KINDS.join(', ')}`,
    }
  }
  const page = parsePositiveIntParam(query.page, 1, APPROVAL_BY_USER_MAX_PAGE)
  const pageSize = parsePositiveIntParam(query.pageSize, APPROVAL_BY_USER_DEFAULT_PAGE_SIZE, APPROVAL_BY_USER_MAX_PAGE_SIZE)
  if (page === null || pageSize === null) {
    return {
      ok: false,
      code: 'APPROVAL_BY_USER_PAGING_INVALID',
      message: `page must be 1-${APPROVAL_BY_USER_MAX_PAGE} and pageSize 1-${APPROVAL_BY_USER_MAX_PAGE_SIZE}`,
    }
  }
  return { ok: true, value: { userId, kind, page, pageSize } }
}

export interface ApprovalByUserRow {
  id: string
  requestNo: string | null
  title: string | null
  status: string
  templateId: string | null
  requester: { id: string | null; name: string | null }
  createdAt: string
  updatedAt: string
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * The lookup's row shape: enough to identify and open an instance, nothing more. The form
 * snapshot, policy and seat list are left out; opening a row goes through the detail read and its
 * own access check.
 */
export function toApprovalByUserRow(dto: UnifiedApprovalDTO): ApprovalByUserRow {
  const requester = (dto.requester ?? {}) as Record<string, unknown>
  return {
    id: dto.id,
    requestNo: optionalString(dto.requestNo),
    title: optionalString(dto.title),
    status: dto.status,
    templateId: optionalString(dto.templateId),
    requester: { id: optionalString(requester.id), name: optionalString(requester.name) },
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  }
}
