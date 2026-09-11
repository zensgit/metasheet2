import { Router, type Request, type Response } from 'express'
import { poolManager } from '../integration/db/connection-pool'
import { tenantContext } from '../db/sharding/tenant-context'
import { isElearningGlobalAdminRequest } from './elearning-admin-access'
import { matchesAnyPermission, normalizePermissionCodes } from '../auth/permission-match'
import type { PluginLoader } from '../core/plugin-loader'
import {
  collectPlatformApps,
  type PlatformAppCatalogFeaturePredicate,
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
  isCatalogFeatureEnabled?: PlatformAppCatalogFeaturePredicate
}

type PlatformAppResponse = PlatformAppSummary & {
  instance: PlatformAppInstanceRecord | null
}

function visibleInstallation(req: Request, app: PlatformAppResponse): boolean {
  if (app.id !== 'elearning') return true
  const orgId = req.authenticatedTenantId
  if (typeof orgId !== 'string' || !orgId) return false
  if (isElearningGlobalAdminRequest(req)) return true
  return app.instance?.tenantId === orgId && app.instance.workspaceId === orgId
    && app.instance.status === 'active'
    && typeof app.instance.config.notificationsEnabled === 'boolean'
}

/**
 * Platform-admin bypass, read ONLY from what the auth middleware hydrated onto `req.user`
 * (`auth/jwt-middleware.ts` → `AuthService#verifyToken` → `mapAuthUserRow`, whose `role` is already
 * resolved through `rbac/service#isAdmin` and whose `permissions` are already resolved through
 * `rbac/service#listUserPermissions`). Raw token claims are NOT consulted — same discipline, and the
 * same three markers, as `isElearningGlobalAdminRequest` in `elearning-admin-access.ts`.
 *
 * `is_admin` is the users-table column (`db/types.ts:761`); today's `mapAuthUserRow` does not project
 * it onto `req.user`, so it is inert on this path — it is honoured here so that a hydration which
 * later does project it cannot silently demote a platform admin.
 */
function isPlatformAppAdminRequest(req: Request): boolean {
  if (req.user?.role === 'admin') return true
  if (normalizePermissionCodes(req.user?.roles).includes('admin')) return true
  if (req.user?.is_admin === true) return true
  return normalizePermissionCodes(req.user?.permissions).includes('*:*')
}

/**
 * THE App Center visibility gate. Before it, `GET /` and `GET /:appId` did zero permission work:
 * any authenticated account saw every app and every app's full manifest projection, while the
 * manifests had been declaring their `permissions` codes all along and `app-registry.ts` had been
 * projecting them to the browser. This consumes that already-parsed data; it introduces no new
 * source of truth and issues no new SQL.
 *
 * ANY-OF over `app.permissions` (see `matchesAnyPermission`): the array names the codes the app
 * uses, not a set its users must all hold. Admins bypass. An app that declares no codes is public.
 */
function canSeePlatformApp(req: Request, app: PlatformAppSummary): boolean {
  if (isPlatformAppAdminRequest(req)) return true
  return matchesAnyPermission(
    normalizePermissionCodes(req.user?.permissions),
    Array.isArray(app.permissions) ? app.permissions : [],
  )
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
      const catalog = await collectPlatformApps({
        loadedPlugins: options.pluginLoader.getPlugins().values(),
        pluginStatus: options.pluginStatus,
        isCatalogFeatureEnabled: (flag) => flag === 'elearning' && isElearningGlobalAdminRequest(req)
          ? true : options.isCatalogFeatureEnabled?.(flag),
      })
      // Permission filter FIRST, before any instance lookup: an app the caller may not see must not
      // even reach the tenant-scoped `platform_app_instances` query as an id.
      const apps = catalog.filter((item) => canSeePlatformApp(req, item))
      if (apps.length === 0) {
        // Not an optimisation — a scope guard. `listPlatformAppInstances` with an EMPTY appIds list
        // falls back to "every instance in this workspace"
        // (services/PlatformAppInstanceRegistryService.ts:142-149). A caller permitted to see no app
        // must not be the one who widens that read.
        return res.json({ list: [] })
      }
      const tenantId = resolveTenantId(req)
      if (!tenantId) {
        return res.json({
          list: apps.map((item) => ({
            ...item,
            instance: null,
          })).filter((app) => visibleInstallation(req, app)),
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
        })).filter((app) => visibleInstallation(req, app)),
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
        isCatalogFeatureEnabled: (flag) => flag === 'elearning' && isElearningGlobalAdminRequest(req)
          ? true : options.isCatalogFeatureEnabled?.(flag),
      })
      const app = apps.find((item) => item.id === req.params.appId)
      // No existence oracle: "you may not see it" and "it is not there" are the SAME 404 with the
      // same body, so the detail route cannot be used to enumerate installed apps. Checked before
      // `attachInstance`, so a refused caller triggers no instance query either.
      if (!app || !canSeePlatformApp(req, app)) {
        return res.status(404).json({ error: 'Platform app not found' })
      }
      const attached = await attachInstance(req, app)
      if (!visibleInstallation(req, attached)) return res.status(404).json({ error: 'Platform app not found' })
      return res.json(attached)
    } catch (error) {
      return res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to load platform app',
      })
    }
  })

  return router
}
