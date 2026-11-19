import type { GuardLookups } from './rbac'
import type { StrictPrincipalQuery } from './strict-principal'
import { derivePermissionNamespace, inspectPermissionCodesByNamespaceAdmission } from './namespace-admission'

/** Transaction-bound strict readers for the same service operations used by the guard. */
export function strictGuardLookups(query: StrictPrincipalQuery): GuardLookups {
  async function admission(userId: string, code: string): Promise<boolean> {
    if (!derivePermissionNamespace(code)) return true
    const result = await inspectPermissionCodesByNamespaceAdmission(userId, [code], query)
    if (result.unavailable) throw new Error('Admission unavailable')
    return result.codes.includes(code)
  }
  async function isAdmin(userId: string): Promise<boolean> {
    const result = await query('SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = $2 LIMIT 1', [userId, 'admin'])
    return result.rows.length > 0
  }
  async function hasPermission(userId: string, code: string): Promise<boolean> {
    if (!await admission(userId, code)) return false
    const direct = await query('SELECT 1 FROM user_permissions WHERE user_id = $1 AND permission_code = $2 LIMIT 1', [userId, code])
    if (direct.rows.length) return true
    const role = await query(`SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
      WHERE ur.user_id = $1 AND rp.permission_code = $2 LIMIT 1`, [userId, code])
    if (role.rows.length) return true
    const legacy = await query('SELECT permissions FROM users WHERE id = $1', [userId])
    const value = (legacy.rows[0] as { permissions?: unknown } | undefined)?.permissions
    const codes = Array.isArray(value) ? value : []
    return codes.includes(code) || codes.includes(`${code.split(':')[0]}:*`) || codes.includes('*:*')
  }
  async function listPermissions(userId: string): Promise<string[]> {
    const grants = await query(`SELECT DISTINCT permission_code AS code FROM (
      SELECT up.permission_code FROM user_permissions up WHERE up.user_id = $1
      UNION ALL
      SELECT rp.permission_code FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = $1
    ) t`, [userId])
    const legacy = await query('SELECT permissions FROM users WHERE id = $1', [userId])
    const value = (legacy.rows[0] as { permissions?: unknown } | undefined)?.permissions
    const codes = [...new Set([
      ...grants.rows.map(row => (row as { code: string }).code),
      ...(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []),
    ])]
    const inspected = await inspectPermissionCodesByNamespaceAdmission(userId, codes, query)
    if (inspected.unavailable) throw new Error('Admission unavailable')
    return inspected.codes
  }
  return { admission, isAdmin, hasPermission, listPermissions }
}
