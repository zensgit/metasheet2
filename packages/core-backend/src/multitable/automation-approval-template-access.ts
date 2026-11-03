import {
  applyTemplateVisibilityFilter,
  type ApprovalTemplateVisibilityActor,
} from '../services/ApprovalProductService'
import {
  hasPermissionCode,
} from './automation-approval-bridge-service'
import type { QueryFn } from './permission-service'

async function listPermissionCodes(query: QueryFn, userId: string): Promise<string[]> {
  // Approval permissions are intentionally non-namespaced. Keep this query on the injected DB view
  // so permission and template visibility cannot observe different transaction snapshots.
  const result = await query(
    `SELECT permission_code
       FROM user_permissions
      WHERE user_id = $1
      UNION
     SELECT rp.permission_code
       FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
      WHERE ur.user_id = $1`,
    [userId],
  )
  return result.rows
    .map((row) => (row as { permission_code?: unknown }).permission_code)
    .filter((code): code is string => typeof code === 'string')
}

export async function automationUserHasApprovalRead(
  query: QueryFn,
  userId: string | null | undefined,
): Promise<boolean> {
  const normalizedUserId = typeof userId === 'string' ? userId.trim() : ''
  if (!normalizedUserId) return false
  try {
    const codes = await listPermissionCodes(query, normalizedUserId)
    return hasPermissionCode(codes, 'approvals:read')
  } catch {
    return false
  }
}

/** One user's template-visibility actor plus the `approvals:read` verdict from the SAME code fetch. */
export interface ApprovalTemplateReader {
  actor: ApprovalTemplateVisibilityActor
  /** True iff the user holds `approvals:read` — the code `canReadApprovalTemplateForAutomation` requires. */
  hasApprovalRead: boolean
}

/**
 * Build the template-visibility ACTOR for one user, ONCE: the users row, the role union and the
 * permission codes (three statements, in that order — unchanged from the per-template path this was
 * extracted from). Returns null when the user row is gone or deactivated, which is fail-closed: an
 * absent actor can see no template.
 *
 * Extracted (2026-09-15 review) so a caller with MANY template ids can hold ONE actor and push the
 * visibility predicate into a single IN-query, instead of re-deriving it per template. THROWS on driver
 * failure — the two wrappers below keep their historical `catch → false`; a caller that wants a
 * different degradation decides for itself.
 */
export async function loadApprovalTemplateReader(
  query: QueryFn,
  userId: string | null | undefined,
): Promise<ApprovalTemplateReader | null> {
  const normalizedUserId = typeof userId === 'string' ? userId.trim() : ''
  if (!normalizedUserId) return null

  const userResult = await query(
    'SELECT role, department, is_admin FROM users WHERE id = $1 AND is_active = TRUE',
    [normalizedUserId],
  )
  const user = userResult.rows[0] as {
    role?: string | null
    department?: string | null
    is_admin?: boolean | null
  } | undefined
  if (!user) return null

  const roleRows = await query(
    'SELECT ur.role_id, r.name FROM user_roles ur LEFT JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1',
    [normalizedUserId],
  )
  const roles = new Set<string>()
  if (typeof user.role === 'string' && user.role.trim()) roles.add(user.role.trim())
  for (const row of roleRows.rows as Array<{ role_id?: string | null; name?: string | null }>) {
    if (typeof row.role_id === 'string' && row.role_id.trim()) roles.add(row.role_id.trim())
    if (typeof row.name === 'string' && row.name.trim()) roles.add(row.name.trim())
  }

  const codes = await listPermissionCodes(query, normalizedUserId)
  const actor: ApprovalTemplateVisibilityActor = {
    userId: normalizedUserId,
    departmentIds: typeof user.department === 'string' && user.department.trim()
      ? [user.department.trim()]
      : [],
    roles: [...roles],
    permissions: codes,
    isTemplateManager:
      hasPermissionCode(codes, 'approval-templates:manage')
      || user.is_admin === true
      || roles.has('admin'),
  }
  return { actor, hasApprovalRead: hasPermissionCode(codes, 'approvals:read') }
}

export async function automationTemplateVisibleToUser(
  query: QueryFn,
  templateId: string,
  userId: string | null | undefined,
): Promise<boolean> {
  const normalizedTemplateId = templateId.trim()
  const normalizedUserId = typeof userId === 'string' ? userId.trim() : ''
  if (!normalizedTemplateId || !normalizedUserId) return false

  try {
    const reader = await loadApprovalTemplateReader(query, normalizedUserId)
    if (!reader) return false
    const conditions: string[] = ['id = $1']
    const params: unknown[] = [normalizedTemplateId]
    applyTemplateVisibilityFilter(conditions, params, 2, reader.actor)
    const visible = await query(
      `SELECT 1 FROM approval_templates WHERE ${conditions.join(' AND ')} LIMIT 1`,
      params,
    )
    return visible.rows.length > 0
  } catch {
    return false
  }
}

/**
 * `templateId → name` for a SET of template ids, under the SAME gate a single-template read passes:
 * `approvals:read` AND the template's own `visibility_scope`. One IN-query for the whole set (plus the
 * three actor statements), never one round trip per id.
 *
 * WHY THE GATE IS HERE AND NOT AT THE CALL SITE (2026-09-15 adversarial review): the record-approval LIST
 * hands these names to a caller that has only passed the multitable RECORD read gate, and `canRead` is
 * derived from `multitable:read`/`multitable:write`/admin alone — entirely independent of `approvals:read`
 * (multitable/access.ts). Without this gate the list would hand a plain grid viewer the display name of a
 * template that the very same router refuses it on POST (RECORD_APPROVAL_TEMPLATE_FORBIDDEN) and that
 * `/api/approval-templates` refuses it too. A caller that fails the gate gets NO name (the id it already
 * had is unchanged), never a refusal — names are decoration, not the payload.
 *
 * Keys are lowercased template ids: `approval_templates.id` is UUID (rendered canonical-lowercase by
 * `id::text`) while multitable stores the id as TEXT exactly as the submit call sent it. The join is made
 * on TEXT on purpose — `id = ANY($1::uuid[])` raises 22P02 for ONE malformed stored id and would take the
 * whole page down with it.
 *
 * THROWS like `loadApprovalTemplateReader` (no `catch → false` here): the caller decides which driver
 * errors are survivable for it.
 */
export async function loadReadableApprovalTemplateNames(
  query: QueryFn,
  templateIds: Array<string | null | undefined>,
  userId: string | null | undefined,
): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  const ids = [
    ...new Set(
      templateIds
        .map((id) => String(id ?? '').trim().toLowerCase())
        .filter((id) => id.length > 0),
    ),
  ]
  if (ids.length === 0) return names

  const reader = await loadApprovalTemplateReader(query, userId)
  // Fail-closed on BOTH halves of the gate: no actor (user gone/inactive) or no `approvals:read` → the
  // template query is not even issued.
  if (!reader || !reader.hasApprovalRead) return names

  const conditions: string[] = ['lower(id::text) = ANY($1::text[])']
  const params: unknown[] = [ids]
  applyTemplateVisibilityFilter(conditions, params, 2, reader.actor)
  const result = await query(
    `SELECT id::text AS id, name FROM approval_templates WHERE ${conditions.join(' AND ')}`,
    params,
  )
  for (const raw of result.rows as Array<Record<string, unknown>>) {
    const id = typeof raw.id === 'string' ? raw.id.trim().toLowerCase() : ''
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (id && name) names.set(id, name)
  }
  return names
}

export async function canReadApprovalTemplateForAutomation(
  query: QueryFn,
  templateId: string,
  userId: string | null | undefined,
): Promise<boolean> {
  if (!(await automationUserHasApprovalRead(query, userId))) return false
  return automationTemplateVisibleToUser(query, templateId, userId)
}
