import { Router, type Request, type Response } from 'express'
import { poolManager } from '../integration/db/connection-pool'
import { tenantContext } from '../db/sharding/tenant-context'
import type { PluginLoader } from '../core/plugin-loader'
import {
  collectPlatformApps,
  type PlatformAppPluginState,
  type PlatformAppSummary,
} from '../platform/app-registry'
import {
  getPlatformAppInstance,
  listPlatformAppInstances,
  type PlatformAppInstanceRecord,
} from '../services/PlatformAppInstanceRegistryService'

export interface PlatformAppsRouterOptions {
  pluginLoader: PluginLoader
  pluginStatus?: Map<string, PlatformAppPluginState>
}

type PlatformAppResponse = PlatformAppSummary & {
  instance: PlatformAppInstanceRecord | null
}

function resolveTenantId(req: Request): string {
  if (typeof req.user?.tenantId === 'string' && req.user.tenantId.trim().length > 0) {
    return req.user.tenantId.trim()
  }
  const currentTenantId = tenantContext.getTenantId()
  if (typeof currentTenantId === 'string' && currentTenantId.trim().length > 0) {
    return currentTenantId.trim()
  }
  return ''
}

async function queryPlatformAppInstances(
  tenantId: string,
  sql: string,
  params?: unknown[],
): Promise<{ rows: unknown[]; rowCount?: number | null }> {
  const shardedPoolManager = tenantContext.getPoolManager()
  const result = tenantId && shardedPoolManager
    ? await shardedPoolManager.queryForTenant(tenantId, sql, params)
    : await poolManager.get().query(sql, params)

  return {
    rows: Array.isArray((result as { rows?: unknown[] }).rows)
      ? (result as { rows: unknown[] }).rows
      : [],
    rowCount: typeof (result as { rowCount?: number }).rowCount === 'number'
      ? (result as { rowCount: number }).rowCount
      : undefined,
  }
}

async function attachInstance(
  req: Request,
  app: PlatformAppSummary,
): Promise<PlatformAppResponse> {
  const tenantId = resolveTenantId(req)
  if (!tenantId) return { ...app, instance: null }

  const instance = await getPlatformAppInstance(
    async (sql, params) => queryPlatformAppInstances(tenantId, sql, params),
    {
      workspaceId: tenantId,
      appId: String(app.id || ''),
    },
  )
  return {
    ...app,
    instance,
  }
}

export function createPlatformAppsRouter(options: PlatformAppsRouterOptions): Router {
  const router = Router()

  router.get('/', async (req: Request, res: Response) => {
    try {
      const apps = await collectPlatformApps({
        loadedPlugins: options.pluginLoader.getPlugins().values(),
        pluginStatus: options.pluginStatus,
      })
      const tenantId = resolveTenantId(req)
      if (!tenantId) {
        return res.json({
          list: apps.map((item) => ({
            ...item,
            instance: null,
          })),
        })
      }

      const instances = await listPlatformAppInstances(
        async (sql, params) => queryPlatformAppInstances(tenantId, sql, params),
        {
          workspaceId: tenantId,
          appIds: apps.map((item) => item.id),
        },
      )
      const instanceByAppId = new Map(instances.map((item) => [item.appId, item]))
      return res.json({
        list: apps.map((item) => ({
          ...item,
          instance: instanceByAppId.get(item.id) ?? null,
        })),
      })
    } catch (error) {
      return res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to load platform apps',
      })
    }
  })

  router.get('/:appId', async (req: Request, res: Response) => {
    try {
      const apps = await collectPlatformApps({
        loadedPlugins: options.pluginLoader.getPlugins().values(),
        pluginStatus: options.pluginStatus,
      })
      const app = apps.find((item) => item.id === req.params.appId)
      if (!app) {
        return res.status(404).json({ error: 'Platform app not found' })
      }
      return res.json(await attachInstance(req, app))
    } catch (error) {
      return res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to load platform app',
      })
    }
  })

  return router
}
