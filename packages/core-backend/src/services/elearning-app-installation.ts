import type { ElearningAdminAccessDb, ElearningAdminAccessQueryable } from './elearning-admin-access'

export interface ElearningAppInstallation {
  status: 'not-installed' | 'inactive' | 'active'
  notificationsEnabled: boolean
}

export class ElearningAppInstallationError extends Error {
  constructor(readonly code: 'forbidden' | 'not_installed' | 'unavailable') {
    super(code)
  }
}

/** Both tenant and workspace must match; the registry's workspace key alone is not authority. */
export async function readElearningAppInstallation(
  db: ElearningAdminAccessQueryable,
  orgId: string,
): Promise<ElearningAppInstallation> {
  if (!orgId || orgId !== orgId.trim()) throw new ElearningAppInstallationError('forbidden')
  const result = await db.query(
    `SELECT status, config_json FROM platform_app_instances
     WHERE tenant_id = $1 AND workspace_id = $1
       AND app_id = 'elearning' AND plugin_id = 'plugin-elearning'
       AND instance_key = 'primary'`, [orgId],
  )
  if (result.rows.length === 0) return { status: 'not-installed', notificationsEnabled: false }
  const row = result.rows[0]
  if (result.rows.length !== 1 || !row || (row.status !== 'active' && row.status !== 'inactive')) {
    throw new ElearningAppInstallationError('unavailable')
  }
  const config = row.config_json
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || typeof (config as Record<string, unknown>).notificationsEnabled !== 'boolean') {
    throw new ElearningAppInstallationError('unavailable')
  }
  return {
    status: row.status,
    notificationsEnabled: row.status === 'active'
      && (config as Record<string, unknown>).notificationsEnabled === true,
  }
}

export async function changeElearningAppInstallation(
  db: ElearningAdminAccessDb,
  input: { orgId: string; actorId: string; isGlobalAdmin: boolean },
  configuration?: { enabled: boolean; notificationsEnabled: boolean },
): Promise<ElearningAppInstallation> {
  if (input.isGlobalAdmin !== true || !input.orgId || !input.actorId
    || input.orgId !== input.orgId.trim() || input.actorId !== input.actorId.trim()) {
    throw new ElearningAppInstallationError('forbidden')
  }
  return db.transaction(async (tx) => {
    // SHARE also serializes a concurrent non-key membership deactivation.
    const membership = await tx.query(
      `SELECT user_id FROM user_orgs WHERE org_id = $1 AND user_id = $2
       AND is_active = true FOR SHARE`, [input.orgId, input.actorId],
    )
    if (membership.rows.length !== 1) throw new ElearningAppInstallationError('forbidden')
    if (configuration === undefined) {
      await tx.query(
        `INSERT INTO platform_app_instances
           (tenant_id, workspace_id, app_id, plugin_id, instance_key, project_id,
            display_name, status, config_json, metadata_json)
         VALUES ($1, $1, 'elearning', 'plugin-elearning', 'primary', $1,
           '学习中心', 'inactive', '{"notificationsEnabled":false}'::jsonb,
           jsonb_build_object('installedBy', $2::text))
         ON CONFLICT (workspace_id, app_id, instance_key) DO NOTHING`,
        [input.orgId, input.actorId],
      )
    } else {
      if (typeof configuration.enabled !== 'boolean'
        || typeof configuration.notificationsEnabled !== 'boolean') {
        throw new ElearningAppInstallationError('forbidden')
      }
      const changed = await tx.query(
        `UPDATE platform_app_instances SET status = $3,
           config_json = jsonb_build_object('notificationsEnabled', $4::boolean),
           metadata_json = metadata_json || jsonb_build_object('configuredBy', $2::text),
           updated_at = now()
         WHERE tenant_id = $1 AND workspace_id = $1
           AND app_id = 'elearning' AND plugin_id = 'plugin-elearning'
           AND instance_key = 'primary' RETURNING id`,
        [input.orgId, input.actorId, configuration.enabled ? 'active' : 'inactive',
          configuration.enabled && configuration.notificationsEnabled],
      )
      if (changed.rows.length !== 1) throw new ElearningAppInstallationError('not_installed')
    }
    const current = await readElearningAppInstallation(tx, input.orgId)
    if (current.status === 'not-installed') throw new ElearningAppInstallationError('unavailable')
    return current
  })
}
