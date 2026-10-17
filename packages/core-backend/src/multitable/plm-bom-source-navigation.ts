import { evaluateUserAuthenticationGate } from '../auth/user-activation'
import { matchesPermission } from '../auth/permission-match'
import { filterPermissionCodesByNamespaceAdmission } from '../rbac/namespace-admission'
import {
  isAdminOnQuery,
  listUserPermissionsOnQuery,
} from '../services/approval-record-link-txn-auth'
import type { PlmQuery } from './plm-bom-review-db'
import { hash } from './plm-bom-review-wire'

type SourceFingerprintInput = {
  id: string
  type: string
  config: unknown
  owner_id: string
  is_active: boolean
  workspace_id: unknown
  tenant_id: unknown
  scope_kind: unknown
}

// Hash the persisted configuration, including encrypted credential bytes; never decrypt for navigation.
export function bomReviewSourceFingerprint(row: SourceFingerprintInput): string {
  return hash({
    id: row.id,
    type: row.type,
    config: row.config,
    owner: row.owner_id,
    active: row.is_active,
    workspace: row.workspace_id,
    tenant: row.tenant_id,
    scope: row.scope_kind,
  })
}

// Only called after the native selected-sheet read gate. This is a navigation hint, not a grant;
// explicit Load at the destination still checks current data-source ownership and Yuantus authority.
export async function loadPlmBomSourceNavigation(
  query: PlmQuery,
  actor: string,
  sheetId: string,
): Promise<{ dataSourceId: string; partId: string } | undefined> {
  if (process.env.PLM_BOM_REVIEW_ENABLED !== 'true' || !actor || !sheetId) return undefined
  try {
    const user = (await query(
      'SELECT is_active,role,activation_status,local_password_set FROM users WHERE id=$1',
      [actor],
    )).rows[0]
    if (!user || evaluateUserAuthenticationGate(user)) return undefined
    // The same fresh namespace filter used by AuthService's effective permission path.
    // It reads the process RBAC pool (the native route's authority DB), without its list cache.
    const permissions = await filterPermissionCodesByNamespaceAdmission(
      actor, await listUserPermissionsOnQuery(query, actor),
    )
    // Same admin shortcuts as useAuth.getAccessSnapshot, and the shared route permission algebra.
    // Read current DB authority rather than stale request/token permission snapshots.
    const admin = user.role === 'admin' || await isAdminOnQuery(query, actor)
      || ['*:*', 'admin:all', 'users:write', 'roles:write', 'permissions:write'].some((code) => permissions.includes(code))
    if (!admin && !matchesPermission(permissions, 'integration:write')) return undefined
    const row = (await query(
      `SELECT d.id,d.type,d.config,d.owner_id,d.is_active,d.workspace_id,d.tenant_id,d.scope_kind,
              b.part_id,b.source_fingerprint
       FROM meta_plm_bom_review_bindings b JOIN data_sources d ON d.id=b.data_source_id
       WHERE b.sheet_id=$1 AND d.owner_id=$2 AND d.is_active=true AND d.deleted_at IS NULL AND d.type='plm'`,
      [sheetId, actor],
    )).rows[0] as (SourceFingerprintInput & { part_id: string; source_fingerprint: string }) | undefined
    if (!row || bomReviewSourceFingerprint(row) !== row.source_fingerprint) return undefined
    return { dataSourceId: row.id, partId: row.part_id }
  } catch {
    // Optional provenance must fail closed without breaking ordinary snapshot reads.
    return undefined
  }
}
