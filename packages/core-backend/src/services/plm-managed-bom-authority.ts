/** Shared current browser identity/source locks. Each product caller keeps its own purpose gate. */
import type { Request } from 'express'
import type { PlmQuery } from '../multitable/plm-bom-review-db'
import { evaluateUserAuthenticationGate } from '../auth/user-activation'
import { currentManagedRequest } from './plm-managed-request-context'
import { ManagedCompanionRefusal as Refusal, bindingFingerprintMatches, isPlmManagedCompanionEnabled,
  registrationFor, type ManagedBindingRow } from './plm-managed-companion'

/** Called inside the publication transaction. Read delegation IDs are not share authority. */
export async function lockManagedBomAuthority(q: PlmQuery, req: Request, sourceId: string, partId: string) {
  if (!isPlmManagedCompanionEnabled()) throw new Refusal(403, 'PLM_MANAGED_COMPANION_DISABLED')
  const store = currentManagedRequest()
  const actor = req.user?.id
  if (!actor || !store?.sessionId || store.conflict || store.userId !== actor) {
    throw new Refusal(403, 'PLM_SNAPSHOT_SHARE_SESSION_REQUIRED')
  }
  const link = (await q('SELECT link_id FROM plm_managed_sessions WHERE id=$1', [store.sessionId])).rows[0]
  if (!link) throw new Refusal(403, 'PLM_SNAPSHOT_SHARE_SESSION_REQUIRED')
  // The existing unlink writer locks the link before bindings and sessions.
  await q('SELECT id FROM plm_managed_identity_links WHERE id=$1 FOR SHARE', [link.link_id])
  const row = (await q(`SELECT l.*, l.id AS link_id, l.status AS link_status, l.generation AS link_generation,l.source_fingerprint AS link_source_fingerprint,
    b.status AS binding_status,b.generation,b.frozen_origin,b.frozen_root_part_id,b.source_fingerprint,
    s.id AS session_id,s.meta_user_id AS session_user,s.meta_tenant_id AS session_tenant,
    s.meta_org_id AS session_org,s.native_subject,s.native_tenant_id AS session_native_tenant,
    s.native_org_id AS session_native_org,s.root_part_id AS session_root,s.client_id AS session_client,
    s.client_origin AS session_origin,s.installation_issuer AS session_issuer,s.generation AS session_generation,
    d.type AS source_type,d.owner_id,d.config,d.is_active,d.deleted_at,d.tenant_id,d.workspace_id,d.scope_kind
    FROM plm_managed_sessions s
    JOIN plm_managed_source_bindings b ON b.data_source_id=s.data_source_id
    JOIN plm_managed_identity_links l ON l.id=s.link_id AND l.id=b.link_id
    JOIN data_sources d ON d.id=s.data_source_id
    WHERE s.id=$1 AND s.data_source_id=$2 AND s.meta_user_id=$3
      AND s.revoked_at IS NULL AND s.expires_at>now()
    FOR SHARE OF s,b,l,d`, [store.sessionId, sourceId, actor])).rows[0]
  if (!row || req.authenticatedTenantId !== row.meta_tenant_id || row.meta_user_id !== actor
      || row.session_user !== actor || row.session_tenant !== row.meta_tenant_id || row.session_org !== row.meta_org_id
      || row.session_generation !== row.generation || row.session_native_tenant !== row.native_tenant_id
      || row.session_native_org !== row.native_org_id || row.native_subject !== row.native_auth_user_id
      || row.session_root !== partId || row.root_part_id !== partId || row.session_origin !== row.client_origin
      || row.session_issuer !== row.installation_issuer || row.session_client !== row.client_id
      || row.source_fingerprint !== row.link_source_fingerprint
      || row.tenant_id !== null && row.tenant_id !== row.meta_tenant_id
      || !bindingFingerprintMatches({ ...row, data_source_id: sourceId } as ManagedBindingRow)) {
    throw new Refusal(403, 'PLM_SNAPSHOT_SHARE_IDENTITY_CHANGED')
  }
  const user = (await q('SELECT is_active,role,activation_status,must_change_password,local_password_set FROM users WHERE id=$1 FOR SHARE', [actor])).rows[0]
  if (!user || user.must_change_password === true || evaluateUserAuthenticationGate(user)) throw new Refusal(403, 'PLM_SNAPSHOT_SHARE_USER_REFUSED')
  for (const org of [row.meta_tenant_id, row.meta_org_id]) {
    const membership = await q('SELECT org_id FROM user_orgs WHERE user_id=$1 AND org_id=$2 AND is_active=true FOR SHARE', [actor, org])
    if (!membership.rows.length) throw new Refusal(403, 'PLM_SNAPSHOT_SHARE_MEMBERSHIP_REFUSED')
  }
  const reg = registrationFor({ issuer: row.installation_issuer, nativeTenantId: row.native_tenant_id, nativeOrgId: row.native_org_id })
  if (reg.clientId !== row.client_id || reg.callback !== row.callback || reg.origin !== row.client_origin) {
    throw new Refusal(403, 'PLM_SNAPSHOT_SHARE_REGISTRATION_CHANGED')
  }
  return { row, reg, actor, source: { tenant_id: row.native_tenant_id as string, org_id: row.native_org_id as string,
    auth_user_id: row.native_auth_user_id as string, part_id: partId } }
}
