import { describe, expect, it } from 'vitest'
import {
  getPlatformAppInstance,
  listPlatformAppInstances,
  upsertPlatformAppInstance,
} from '../src/services/PlatformAppInstanceRegistryService'

describe('PlatformAppInstanceRegistryService', () => {
  it('upserts a primary app instance with normalized defaults', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = []
    const record = await upsertPlatformAppInstance(
      async (sql, params) => {
        queries.push({ sql, params })
        return {
          rows: [{
            id: 'instance-1',
            tenant_id: 'tenant-a',
            workspace_id: 'tenant-a',
            app_id: 'after-sales',
            plugin_id: 'plugin-after-sales',
            instance_key: 'primary',
            project_id: 'tenant-a:after-sales',
            display_name: 'After Sales',
            status: 'active',
            config_json: { locale: 'zh-CN' },
            metadata_json: { source: 'installer' },
            created_at: '2026-04-13T00:00:00Z',
            updated_at: '2026-04-13T00:00:00Z',
          }],
        }
      },
      {
        tenantId: 'tenant-a',
        workspaceId: 'tenant-a',
        appId: 'after-sales',
        pluginId: 'plugin-after-sales',
        projectId: 'tenant-a:after-sales',
        displayName: 'After Sales',
        config: { locale: 'zh-CN' },
        metadata: { source: 'installer' },
      },
    )

    expect(queries).toHaveLength(1)
    expect(String(queries[0].sql)).toContain('ON CONFLICT (workspace_id, app_id, instance_key)')
    expect(record).toMatchObject({
      id: 'instance-1',
      tenantId: 'tenant-a',
      workspaceId: 'tenant-a',
      appId: 'after-sales',
      instanceKey: 'primary',
      status: 'active',
      projectId: 'tenant-a:after-sales',
    })
  })

  it('gets a single app instance by workspace/app/key', async () => {
    const createdAt = new Date('2026-04-13T00:00:00Z')
    const updatedAt = new Date('2026-04-13T01:00:00Z')
    const record = await getPlatformAppInstance(
      async () => ({
        rows: [{
          id: 'instance-1',
          tenant_id: 'tenant-a',
          workspace_id: 'tenant-a',
          app_id: 'after-sales',
          plugin_id: 'plugin-after-sales',
          instance_key: 'primary',
          project_id: 'tenant-a:after-sales',
          display_name: '',
          status: 'active',
          config_json: '{}',
          metadata_json: 'not-valid-json',
          created_at: createdAt,
          updated_at: updatedAt,
        }],
      }),
      {
        workspaceId: 'tenant-a',
        appId: 'after-sales',
      },
    )

    expect(record?.workspaceId).toBe('tenant-a')
    expect(record?.appId).toBe('after-sales')
    expect(record?.metadata).toEqual({})
    expect(record?.createdAt).toBe(createdAt.toISOString())
    expect(record?.updatedAt).toBe(updatedAt.toISOString())
  })

  it('lists instances and filters by app ids when provided', async () => {
    const queries: Array<{ sql: string; params?: unknown[] }> = []
    const records = await listPlatformAppInstances(
      async (sql, params) => {
        queries.push({ sql, params })
        return {
          rows: [{
            id: 'instance-1',
            tenant_id: 'tenant-a',
            workspace_id: 'tenant-a',
            app_id: 'after-sales',
            plugin_id: 'plugin-after-sales',
            instance_key: 'primary',
            project_id: 'tenant-a:after-sales',
            display_name: 'After Sales',
            status: 'active',
            config_json: '{}',
            metadata_json: '{}',
          }],
        }
      },
      {
        workspaceId: 'tenant-a',
        appIds: ['after-sales'],
      },
    )

    expect(String(queries[0].sql)).toContain('app_id = ANY($2::text[])')
    expect(records).toHaveLength(1)
    expect(records[0].appId).toBe('after-sales')
  })
})
