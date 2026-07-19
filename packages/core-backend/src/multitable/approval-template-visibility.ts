/**
 * Shared approval-template visibility predicate for trusted-actor reconstruction.
 *
 * Used by:
 *   - AutomationService save/fire (`approval.completed` / `approval.task_created`)
 *   - FWB Q6 challenge / execute-time G2 `canReadTemplate`
 *   - FWB retry paths that must recheck source template visibility
 *
 * There is no request token at fire/retry, so the visibility actor is rebuilt from
 * trusted DB state (users.role/department/is_admin + user_roles + RBAC permission codes)
 * and evaluated through the SAME `applyTemplateVisibilityFilter` predicate the template
 * list/detail routes enforce. Fail-closed on any lookup error and on a missing/inactive user.
 */
import { Logger } from '../core/logger'
import {
  applyTemplateVisibilityFilter,
  type ApprovalTemplateVisibilityActor,
} from '../services/ApprovalProductService'
import { hasPermissionCode, listRbacPermissionCodes } from './automation-approval-bridge-service'

const logger = new Logger('ApprovalTemplateVisibility')

export type TemplateVisibilityQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

/**
 * True iff `userId` can see `templateId` under approval_templates.visibility_scope.
 * Fail-closed: missing user, inactive user, or any error → false.
 */
export async function isApprovalTemplateVisibleToUser(
  queryFn: TemplateVisibilityQueryFn,
  templateId: string,
  userId: string | null | undefined,
): Promise<boolean> {
  if (!userId || !/[!-~]/.test(userId) || !templateId || !/[!-~]/.test(templateId)) return false
  try {
    const userResult = await queryFn(
      `SELECT role, department, is_admin FROM users WHERE id = $1 AND is_active = TRUE`,
      [userId],
    )
    const user = userResult.rows[0] as {
      role?: string | null
      department?: string | null
      is_admin?: boolean | null
    } | undefined
    if (!user) return false

    const roleRows = await queryFn(
      `SELECT ur.role_id, r.name FROM user_roles ur LEFT JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
      [userId],
    )
    const roles = new Set<string>()
    if (typeof user.role === 'string' && user.role.trim()) roles.add(user.role.trim())
    for (const row of roleRows.rows as Array<{ role_id?: string | null; name?: string | null }>) {
      if (typeof row.role_id === 'string' && row.role_id.trim()) roles.add(row.role_id.trim())
      if (typeof row.name === 'string' && row.name.trim()) roles.add(row.name.trim())
    }

    const codes = await listRbacPermissionCodes(userId)
    const actor: ApprovalTemplateVisibilityActor = {
      userId,
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
    const params: unknown[] = [templateId]
    applyTemplateVisibilityFilter(conditions, params, 2, actor)
    const visible = await queryFn(
      `SELECT 1 FROM approval_templates WHERE ${conditions.join(' AND ')} LIMIT 1`,
      params,
    )
    return visible.rows.length > 0
  } catch (err) {
    logger.warn(
      'approval template visibility check failed; denying (fail-closed)',
      err instanceof Error ? err : undefined,
    )
    return false
  }
}

/**
 * Resolve the template's authoritative active published version id.
 * Prefer `approval_templates.active_version_id`; fail-closed if missing/inactive.
 */
export async function resolveActiveTemplateVersionId(
  queryFn: TemplateVisibilityQueryFn,
  templateId: string,
): Promise<string | null> {
  if (!templateId || !/[!-~]/.test(templateId)) return null
  try {
    const res = await queryFn(
      `SELECT t.active_version_id::text AS active_version_id, t.status
         FROM approval_templates t
        WHERE t.id = $1`,
      [templateId],
    )
    const row = res.rows[0] as { active_version_id?: string | null; status?: string } | undefined
    if (!row?.active_version_id) return null
    // Published templates only for FWB Q6 / save binding.
    if (row.status && row.status !== 'published') return null
    // Confirm the version row still exists and belongs to this template.
    const ver = await queryFn(
      `SELECT id::text AS id FROM approval_template_versions
        WHERE id = $1 AND template_id = $2 LIMIT 1`,
      [row.active_version_id, templateId],
    )
    const id = (ver.rows[0] as { id?: string } | undefined)?.id
    return typeof id === 'string' && id ? id : null
  } catch {
    return null
  }
}

/**
 * Load form_schema + graph from the template's active version (authoritative for authoring/Q6).
 */
export async function loadActiveTemplateVersionBundle(
  queryFn: TemplateVisibilityQueryFn,
  templateId: string,
): Promise<{
  templateVersionId: string
  formSchema: Record<string, unknown>
  approvalGraph: Record<string, unknown> | null
} | null> {
  const templateVersionId = await resolveActiveTemplateVersionId(queryFn, templateId)
  if (!templateVersionId) return null
  try {
    const res = await queryFn(
      `SELECT form_schema, approval_graph
         FROM approval_template_versions
        WHERE id = $1 AND template_id = $2`,
      [templateVersionId, templateId],
    )
    const row = res.rows[0] as {
      form_schema?: unknown
      approval_graph?: unknown
    } | undefined
    if (!row || typeof row.form_schema !== 'object' || row.form_schema === null || Array.isArray(row.form_schema)) {
      return null
    }
    return {
      templateVersionId,
      formSchema: row.form_schema as Record<string, unknown>,
      approvalGraph:
        row.approval_graph && typeof row.approval_graph === 'object' && !Array.isArray(row.approval_graph)
          ? (row.approval_graph as Record<string, unknown>)
          : null,
    }
  } catch {
    return null
  }
}
