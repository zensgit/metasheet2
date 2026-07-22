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

export async function automationTemplateVisibleToUser(
  query: QueryFn,
  templateId: string,
  userId: string | null | undefined,
): Promise<boolean> {
  const normalizedTemplateId = templateId.trim()
  const normalizedUserId = typeof userId === 'string' ? userId.trim() : ''
  if (!normalizedTemplateId || !normalizedUserId) return false

  try {
    const userResult = await query(
      'SELECT role, department, is_admin FROM users WHERE id = $1 AND is_active = TRUE',
      [normalizedUserId],
    )
    const user = userResult.rows[0] as {
      role?: string | null
      department?: string | null
      is_admin?: boolean | null
    } | undefined
    if (!user) return false

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
    const conditions: string[] = ['id = $1']
    const params: unknown[] = [normalizedTemplateId]
    applyTemplateVisibilityFilter(conditions, params, 2, actor)
    const visible = await query(
      `SELECT 1 FROM approval_templates WHERE ${conditions.join(' AND ')} LIMIT 1`,
      params,
    )
    return visible.rows.length > 0
  } catch {
    return false
  }
}

export async function canReadApprovalTemplateForAutomation(
  query: QueryFn,
  templateId: string,
  userId: string | null | undefined,
): Promise<boolean> {
  if (!(await automationUserHasApprovalRead(query, userId))) return false
  return automationTemplateVisibleToUser(query, templateId, userId)
}
