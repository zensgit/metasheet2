export type PlatformAppInstanceRegistryQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: unknown[]; rowCount?: number | null }>

export interface PlatformAppInstanceRecord {
  id: string
  tenantId: string
  workspaceId: string
  appId: string
  pluginId: string
  instanceKey: string
  projectId: string
  displayName: string
  status: 'active' | 'inactive' | 'failed'
  config: Record<string, unknown>
  metadata: Record<string, unknown>
  createdAt?: string
  updatedAt?: string
}

export interface UpsertPlatformAppInstanceInput {
  tenantId: string
  workspaceId: string
  appId: string
  pluginId: string
  projectId: string
  displayName?: string
  status?: PlatformAppInstanceRecord['status']
  instanceKey?: string
  config?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface GetPlatformAppInstanceInput {
  workspaceId: string
  appId: string
  instanceKey?: string
}

export interface ListPlatformAppInstancesInput {
  workspaceId: string
  appIds?: string[]
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required`)
  }
  return value.trim()
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeStatus(value: unknown): PlatformAppInstanceRecord['status'] {
  return value === 'inactive' || value === 'failed' ? value : 'active'
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    const parsed = JSON.parse(value) as Record<string, unknown> | null
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function mapRow(row: Record<string, unknown>): PlatformAppInstanceRecord {
  return {
    id: requiredString(row.id, 'id'),
    tenantId: requiredString(row.tenant_id, 'tenant_id'),
    workspaceId: requiredString(row.workspace_id, 'workspace_id'),
    appId: requiredString(row.app_id, 'app_id'),
    pluginId: requiredString(row.plugin_id, 'plugin_id'),
    instanceKey: requiredString(row.instance_key, 'instance_key'),
    projectId: requiredString(row.project_id, 'project_id'),
    displayName: optionalString(row.display_name) || '',
    status: normalizeStatus(row.status),
    config: parseJsonObject(row.config_json),
    metadata: parseJsonObject(row.metadata_json),
    createdAt: optionalString(row.created_at),
    updatedAt: optionalString(row.updated_at),
  }
}

export async function getPlatformAppInstance(
  query: PlatformAppInstanceRegistryQueryFn,
  input: GetPlatformAppInstanceInput,
): Promise<PlatformAppInstanceRecord | null> {
  const workspaceId = requiredString(input?.workspaceId, 'workspaceId')
  const appId = requiredString(input?.appId, 'appId')
  const instanceKey = optionalString(input?.instanceKey) || 'primary'

  const result = await query(
    `SELECT id, tenant_id, workspace_id, app_id, plugin_id, instance_key, project_id,
            display_name, status, config_json, metadata_json, created_at, updated_at
     FROM platform_app_instances
     WHERE workspace_id = $1
       AND app_id = $2
       AND instance_key = $3
     LIMIT 1`,
    [workspaceId, appId, instanceKey],
  )

  const row = Array.isArray(result.rows) ? result.rows[0] : undefined
  return row ? mapRow(row as Record<string, unknown>) : null
}

export async function listPlatformAppInstances(
  query: PlatformAppInstanceRegistryQueryFn,
  input: ListPlatformAppInstancesInput,
): Promise<PlatformAppInstanceRecord[]> {
  const workspaceId = requiredString(input?.workspaceId, 'workspaceId')
  const appIds = Array.isArray(input?.appIds)
    ? input.appIds.map((value) => requiredString(value, 'appIds[]'))
    : []

  const result = appIds.length > 0
    ? await query(
      `SELECT id, tenant_id, workspace_id, app_id, plugin_id, instance_key, project_id,
              display_name, status, config_json, metadata_json, created_at, updated_at
       FROM platform_app_instances
       WHERE workspace_id = $1
         AND app_id = ANY($2::text[])
       ORDER BY app_id ASC, instance_key ASC`,
      [workspaceId, appIds],
    )
    : await query(
      `SELECT id, tenant_id, workspace_id, app_id, plugin_id, instance_key, project_id,
              display_name, status, config_json, metadata_json, created_at, updated_at
       FROM platform_app_instances
       WHERE workspace_id = $1
       ORDER BY app_id ASC, instance_key ASC`,
      [workspaceId],
    )

  return (Array.isArray(result.rows) ? result.rows : []).map((row) => mapRow(row as Record<string, unknown>))
}

export async function upsertPlatformAppInstance(
  query: PlatformAppInstanceRegistryQueryFn,
  input: UpsertPlatformAppInstanceInput,
): Promise<PlatformAppInstanceRecord> {
  const tenantId = requiredString(input?.tenantId, 'tenantId')
  const workspaceId = requiredString(input?.workspaceId, 'workspaceId')
  const appId = requiredString(input?.appId, 'appId')
  const pluginId = requiredString(input?.pluginId, 'pluginId')
  const projectId = requiredString(input?.projectId, 'projectId')
  const instanceKey = optionalString(input?.instanceKey) || 'primary'
  const displayName = optionalString(input?.displayName) || ''
  const status = normalizeStatus(input?.status)
  const config = input?.config && typeof input.config === 'object' && !Array.isArray(input.config) ? input.config : {}
  const metadata = input?.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? input.metadata : {}

  const result = await query(
    `INSERT INTO platform_app_instances (
       tenant_id, workspace_id, app_id, plugin_id, instance_key, project_id,
       display_name, status, config_json, metadata_json
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9::jsonb, $10::jsonb
     )
     ON CONFLICT (workspace_id, app_id, instance_key) DO UPDATE SET
       tenant_id = EXCLUDED.tenant_id,
       plugin_id = EXCLUDED.plugin_id,
       project_id = EXCLUDED.project_id,
       display_name = EXCLUDED.display_name,
       status = EXCLUDED.status,
       config_json = EXCLUDED.config_json,
       metadata_json = EXCLUDED.metadata_json,
       updated_at = now()
     RETURNING id, tenant_id, workspace_id, app_id, plugin_id, instance_key, project_id,
               display_name, status, config_json, metadata_json, created_at, updated_at`,
    [
      tenantId,
      workspaceId,
      appId,
      pluginId,
      instanceKey,
      projectId,
      displayName,
      status,
      JSON.stringify(config),
      JSON.stringify(metadata),
    ],
  )

  const row = Array.isArray(result.rows) ? result.rows[0] : undefined
  if (!row) {
    throw new Error('Failed to upsert platform app instance')
  }
  return mapRow(row as Record<string, unknown>)
}
