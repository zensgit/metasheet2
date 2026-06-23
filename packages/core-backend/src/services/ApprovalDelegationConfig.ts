/**
 * Approval delegation (委托) — config CRUD (WRITE path).
 *
 * Manages rows in `approval_delegations` for the 委托设置 surface — ADMIN-managed (via
 * approval-templates:manage at the route): an admin creates / lists / patches / disables
 * time-boxed delegations for any user (the delegator is a chosen field). Kept separate
 * from the read-only resolve seam (ApprovalDelegations.ts) so the convergence-guarded
 * create-approval path stays write-free.
 */

import { randomUUID } from 'node:crypto'
import { ServiceError } from './ApprovalBridgeService'

type QueryFn = <Row>(text: string, params?: unknown[]) => Promise<{ rows: Row[] }>

export interface DelegationRecord {
  id: string
  delegatorUserId: string
  delegateeUserId: string
  scope: 'all' | 'template'
  scopeTemplateId: string | null
  startAt: string
  endAt: string
  active: boolean
}

export interface CreateDelegationInput {
  delegatorUserId: string
  delegateeUserId: string
  scope: 'all' | 'template'
  scopeTemplateId?: string | null
  startAt: string
  endAt: string
}

interface DelegationRow {
  id: string
  delegator_user_id: string
  delegatee_user_id: string
  scope: string
  scope_template_id: string | null
  start_at: string | Date
  end_at: string | Date
  active: boolean
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

function rowToRecord(row: DelegationRow): DelegationRecord {
  return {
    id: row.id,
    delegatorUserId: row.delegator_user_id,
    delegateeUserId: row.delegatee_user_id,
    scope: row.scope === 'template' ? 'template' : 'all',
    scopeTemplateId: row.scope_template_id ?? null,
    startAt: toIso(row.start_at),
    endAt: toIso(row.end_at),
    active: row.active,
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505'
}

/**
 * Create an active delegation owned by `delegatorUserId`. Deterministic validation
 * (enum-strict, never silently defaulted); the table CHECKs are a second line of
 * defense. An overlapping active row (unique index) surfaces as a 409 — the v1 rule
 * is one active delegation per scope target.
 */
export async function createDelegation(query: QueryFn, input: CreateDelegationInput): Promise<DelegationRecord> {
  const delegator = input.delegatorUserId?.trim()
  const delegatee = input.delegateeUserId?.trim()
  if (!delegator) throw new ServiceError('delegatorUserId is required', 400, 'VALIDATION_ERROR')
  if (!delegatee) throw new ServiceError('delegateeUserId is required', 400, 'VALIDATION_ERROR')
  if (delegator === delegatee) throw new ServiceError('cannot delegate to yourself', 400, 'VALIDATION_ERROR')
  if (input.scope !== 'all' && input.scope !== 'template') {
    throw new ServiceError("scope must be 'all' or 'template'", 400, 'VALIDATION_ERROR')
  }
  const scopeTemplateId = input.scope === 'template' ? input.scopeTemplateId?.trim() || null : null
  if (input.scope === 'template' && !scopeTemplateId) {
    throw new ServiceError("scope 'template' requires scopeTemplateId", 400, 'VALIDATION_ERROR')
  }
  const start = new Date(input.startAt)
  const end = new Date(input.endAt)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new ServiceError('startAt and endAt must be valid dates', 400, 'VALIDATION_ERROR')
  }
  if (end.getTime() <= start.getTime()) {
    throw new ServiceError('endAt must be after startAt', 400, 'VALIDATION_ERROR')
  }

  const id = randomUUID()
  try {
    const row = (
      await query<DelegationRow>(
        `INSERT INTO approval_delegations
           (id, delegator_user_id, delegatee_user_id, scope, scope_template_id, start_at, end_at, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
         RETURNING *`,
        [id, delegator, delegatee, input.scope, scopeTemplateId, start.toISOString(), end.toISOString()],
      )
    ).rows[0]
    return rowToRecord(row)
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ServiceError(
        'an active delegation already exists for this scope target; disable it first',
        409,
        'DELEGATION_CONFLICT',
      )
    }
    throw error
  }
}

/**
 * List active delegations (admin view), newest window first; optionally filtered to one
 * delegator. Admin-managed — returns all delegators' rows, not just one caller's.
 */
export async function listDelegations(query: QueryFn, filter: { delegatorUserId?: string } = {}): Promise<DelegationRecord[]> {
  const delegator = filter.delegatorUserId?.trim()
  const rows = delegator
    ? (await query<DelegationRow>(`SELECT * FROM approval_delegations WHERE active AND delegator_user_id = $1 ORDER BY start_at DESC`, [delegator])).rows
    : (await query<DelegationRow>(`SELECT * FROM approval_delegations WHERE active ORDER BY start_at DESC`)).rows
  return rows.map(rowToRecord)
}

/**
 * Disable (soft-delete) a delegation by id. Admin-managed (gated by
 * approval-templates:manage at the route); returns false for an unknown/already-inactive id.
 */
export async function disableDelegation(query: QueryFn, id: string): Promise<boolean> {
  const res = await query<{ id: string }>(
    `UPDATE approval_delegations SET active = FALSE, updated_at = NOW() WHERE id = $1 AND active RETURNING id`,
    [id],
  )
  return res.rows.length > 0
}

export interface UpdateDelegationInput {
  delegateeUserId?: string
  scope?: 'all' | 'template'
  scopeTemplateId?: string | null
  startAt?: string
  endAt?: string
  active?: boolean
}

/**
 * Patch a delegation by id (admin-managed): merge the patch onto the existing row,
 * re-validate (no self-delegation, valid window, scope/target), and write. The delegator
 * is immutable (re-create to change it). Returns null for an unknown id; a unique-active
 * conflict (e.g. re-activating a duplicate scope target) surfaces as 409.
 */
export async function updateDelegation(query: QueryFn, id: string, patch: UpdateDelegationInput): Promise<DelegationRecord | null> {
  const existing = (await query<DelegationRow>(`SELECT * FROM approval_delegations WHERE id = $1`, [id])).rows[0]
  if (!existing) return null

  const delegatee = (patch.delegateeUserId ?? existing.delegatee_user_id).trim()
  if (!delegatee) throw new ServiceError('delegateeUserId cannot be empty', 400, 'VALIDATION_ERROR')
  if (delegatee === existing.delegator_user_id) throw new ServiceError('cannot delegate to yourself', 400, 'VALIDATION_ERROR')

  const scope = patch.scope ?? (existing.scope === 'template' ? 'template' : 'all')
  if (scope !== 'all' && scope !== 'template') throw new ServiceError("scope must be 'all' or 'template'", 400, 'VALIDATION_ERROR')
  const scopeTemplateId = scope === 'template'
    ? (patch.scopeTemplateId !== undefined ? patch.scopeTemplateId?.trim() || null : existing.scope_template_id)
    : null
  if (scope === 'template' && !scopeTemplateId) throw new ServiceError("scope 'template' requires scopeTemplateId", 400, 'VALIDATION_ERROR')

  const start = new Date(patch.startAt ?? toIso(existing.start_at))
  const end = new Date(patch.endAt ?? toIso(existing.end_at))
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new ServiceError('startAt and endAt must be valid dates', 400, 'VALIDATION_ERROR')
  if (end.getTime() <= start.getTime()) throw new ServiceError('endAt must be after startAt', 400, 'VALIDATION_ERROR')

  const active = patch.active ?? existing.active
  try {
    const row = (
      await query<DelegationRow>(
        `UPDATE approval_delegations
           SET delegatee_user_id = $2, scope = $3, scope_template_id = $4, start_at = $5, end_at = $6, active = $7, updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [id, delegatee, scope, scopeTemplateId, start.toISOString(), end.toISOString(), active],
      )
    ).rows[0]
    return rowToRecord(row)
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ServiceError('an active delegation already exists for this scope target', 409, 'DELEGATION_CONFLICT')
    }
    throw error
  }
}
