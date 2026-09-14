import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Router } from 'express'
import type { LoadedPlugin } from '../../src/core/plugin-loader'

const queryMock = vi.fn()
const queryForTenantMock = vi.fn()

vi.mock('../../src/integration/db/connection-pool', () => ({
  poolManager: {
    get: () => ({
      query: queryMock,
    }),
  },
}))

vi.mock('../../src/db/sharding/tenant-context', () => ({
  tenantContext: {
    getTenantId: () => undefined,
    getPoolManager: () => ({
      queryForTenant: queryForTenantMock,
    }),
  },
}))

import { createPlatformAppsRouter } from '../../src/routes/platform-apps'
import { ELEARNING_FLAG_NAMES, resolveElearningCatalogFeature } from '../../src/elearning/feature-flags'

const tempDirs: string[] = []

function createLoadedPlugin(pluginName: string, manifest: Record<string, unknown>): LoadedPlugin {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `metasheet-platform-router-${pluginName}-`))
  tempDirs.push(dir)
  fs.writeFileSync(path.join(dir, 'app.manifest.json'), JSON.stringify(manifest, null, 2))
  return {
    manifest: {
      name: pluginName,
      version: '1.0.0',
      displayName: `${pluginName} display`,
    } as any,
    plugin: {} as any,
    path: dir,
    loadedAt: new Date(),
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function getRouteHandler(router: Router, method: 'get', routePath: string) {
  const layer = (router as unknown as {
    stack?: Array<{
      route?: {
        path?: string
        methods?: Record<string, boolean>
        stack?: Array<{ handle: (req: any, res: any) => Promise<void> | void }>
      }
    }>
  }).stack?.find((item) => item.route?.path === routePath && item.route?.methods?.[method])

  const handler = layer?.route?.stack?.[0]?.handle
  if (!handler) {
    throw new Error(`Route handler not found for ${method.toUpperCase()} ${routePath}`)
  }
  return handler
}

function createMockResponse() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(payload: unknown) {
      this.body = payload
      return this
    },
  }
}

describe('platform apps router', () => {
  beforeEach(() => {
    queryMock.mockReset()
    queryForTenantMock.mockReset()
  })

  it('returns app list with tenant-scoped instance state', async () => {
    const loaded = createLoadedPlugin('plugin-after-sales', {
      id: 'after-sales',
      version: '0.1.0',
      displayName: 'After Sales',
      pluginId: 'plugin-after-sales',
      boundedContext: { code: 'after-sales', description: 'Support ops' },
      platformDependencies: ['multitable', 'comments'],
      navigation: [
        { id: 'home', title: 'After Sales', path: '/p/plugin-after-sales/after-sales', location: 'main-nav', order: 1 },
      ],
      permissions: [],
      featureFlags: ['afterSales'],
      objects: [],
      workflows: [],
      integrations: [],
    })

    queryForTenantMock.mockResolvedValue({
      rows: [{
        id: 'pai_1',
        tenant_id: 'tenant_42',
        workspace_id: 'tenant_42',
        app_id: 'after-sales',
        plugin_id: 'plugin-after-sales',
        instance_key: 'primary',
        project_id: 'tenant_42:after-sales',
        display_name: 'Acme Support',
        status: 'active',
        config_json: JSON.stringify({ defaultSlaHours: 24 }),
        metadata_json: JSON.stringify({ source: 'after-sales-installer' }),
        created_at: '2026-04-13T00:00:00.000Z',
        updated_at: '2026-04-13T00:00:00.000Z',
      }],
      rowCount: 1,
    })

    const router = createPlatformAppsRouter({
      pluginLoader: {
        getPlugins: () => new Map([['plugin-after-sales', loaded]]),
      } as any,
      pluginStatus: new Map([
        ['plugin-after-sales', { status: 'active' as const }],
      ]),
    })
    const handler = getRouteHandler(router, 'get', '/')
    const response = createMockResponse()

    await handler({
      headers: { 'x-tenant-id': 'tenant_ignored' },
      user: { tenantId: 'tenant_42' },
    }, response)

    expect(response.statusCode).toBe(200)
    expect((response.body as any).list).toHaveLength(1)
    expect((response.body as any).list[0]).toMatchObject({
      id: 'after-sales',
      pluginStatus: 'active',
      entryPath: '/p/plugin-after-sales/after-sales',
      instance: {
        workspaceId: 'tenant_42',
        projectId: 'tenant_42:after-sales',
        displayName: 'Acme Support',
        status: 'active',
      },
    })
    expect(queryForTenantMock).toHaveBeenCalledWith(
      'tenant_42',
      expect.stringContaining('FROM platform_app_instances'),
      ['tenant_42', ['after-sales']],
    )
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('returns a single app with null instance when tenant context is absent', async () => {
    const loaded = createLoadedPlugin('plugin-after-sales', {
      id: 'after-sales',
      version: '0.1.0',
      displayName: 'After Sales',
      pluginId: 'plugin-after-sales',
      boundedContext: { code: 'after-sales' },
      platformDependencies: ['multitable'],
      navigation: [
        { id: 'home', title: 'After Sales', path: '/p/plugin-after-sales/after-sales', location: 'main-nav', order: 1 },
      ],
      permissions: [],
      featureFlags: [],
      objects: [],
      workflows: [],
      integrations: [],
    })

    const router = createPlatformAppsRouter({
      pluginLoader: {
        getPlugins: () => new Map([['plugin-after-sales', loaded]]),
      } as any,
    })
    const handler = getRouteHandler(router, 'get', '/:appId')
    const response = createMockResponse()

    await handler({
      params: { appId: 'after-sales' },
      headers: {},
      user: undefined,
    }, response)

    expect(response.statusCode).toBe(200)
    expect(response.body).toMatchObject({
      id: 'after-sales',
      instance: null,
    })
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('does not trust raw tenant headers when authenticated tenant context is absent', async () => {
    const loaded = createLoadedPlugin('plugin-after-sales', {
      id: 'after-sales',
      version: '0.1.0',
      displayName: 'After Sales',
      pluginId: 'plugin-after-sales',
      boundedContext: { code: 'after-sales' },
      platformDependencies: ['multitable'],
      navigation: [
        { id: 'home', title: 'After Sales', path: '/p/plugin-after-sales/after-sales', location: 'main-nav', order: 1 },
      ],
      permissions: [],
      featureFlags: [],
      objects: [],
      workflows: [],
      integrations: [],
    })

    const router = createPlatformAppsRouter({
      pluginLoader: {
        getPlugins: () => new Map([['plugin-after-sales', loaded]]),
      } as any,
    })
    const handler = getRouteHandler(router, 'get', '/')
    const response = createMockResponse()

    await handler({
      headers: { 'x-tenant-id': 'tenant_42' },
      user: undefined,
    }, response)

    expect(response.statusCode).toBe(200)
    expect((response.body as any).list[0]).toMatchObject({
      id: 'after-sales',
      instance: null,
    })
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('returns null instance for authenticated users without a tenant scope', async () => {
    const loaded = createLoadedPlugin('plugin-after-sales', {
      id: 'after-sales',
      version: '0.1.0',
      displayName: 'After Sales',
      pluginId: 'plugin-after-sales',
      boundedContext: { code: 'after-sales' },
      platformDependencies: ['multitable'],
      navigation: [
        { id: 'home', title: 'After Sales', path: '/p/plugin-after-sales/after-sales', location: 'main-nav', order: 1 },
      ],
      permissions: [],
      featureFlags: [],
      objects: [],
      workflows: [],
      integrations: [],
    })

    const router = createPlatformAppsRouter({
      pluginLoader: {
        getPlugins: () => new Map([['plugin-after-sales', loaded]]),
      } as any,
    })
    const handler = getRouteHandler(router, 'get', '/:appId')
    const response = createMockResponse()

    await handler({
      params: { appId: 'after-sales' },
      headers: {},
      user: { id: 'user_42' },
    }, response)

    expect(response.statusCode).toBe(200)
    expect(response.body).toMatchObject({
      id: 'after-sales',
      instance: null,
    })
    expect(queryForTenantMock).not.toHaveBeenCalled()
  })
})

describe('platform apps router catalog feature predicate', () => {
  const flagSnapshot: Record<string, string | undefined> = {}

  beforeEach(() => {
    queryMock.mockReset()
    queryForTenantMock.mockReset()
    for (const name of ELEARNING_FLAG_NAMES) {
      flagSnapshot[name] = Object.prototype.hasOwnProperty.call(process.env, name)
        ? process.env[name]
        : undefined
    }
  })

  afterEach(() => {
    for (const name of ELEARNING_FLAG_NAMES) {
      if (flagSnapshot[name] === undefined) delete process.env[name]
      else process.env[name] = flagSnapshot[name]
    }
  })

  function readPluginAppManifest(pluginDirName: string): Record<string, unknown> {
    return JSON.parse(
      fs.readFileSync(
        path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          `../../../../plugins/${pluginDirName}/app.manifest.json`,
        ),
        'utf8',
      ),
    ) as Record<string, unknown>
  }

  function createCatalogLoader() {
    const elearning = createLoadedPlugin('plugin-elearning', readPluginAppManifest('plugin-elearning'))
    const afterSales = createLoadedPlugin('plugin-after-sales', readPluginAppManifest('plugin-after-sales'))
    const attendance = createLoadedPlugin('plugin-attendance', readPluginAppManifest('plugin-attendance'))

    return {
      pluginLoader: {
        getPlugins: () => new Map([
          ['plugin-elearning', elearning],
          ['plugin-after-sales', afterSales],
          ['plugin-attendance', attendance],
        ]),
      } as any,
      pluginStatus: new Map([
        ['plugin-elearning', { status: 'active' as const }],
        ['plugin-after-sales', { status: 'active' as const }],
        ['plugin-attendance', { status: 'active' as const }],
      ]),
      isCatalogFeatureEnabled: resolveElearningCatalogFeature,
    }
  }

  async function invoke(routePath: string, params?: Record<string, string>, admin = false) {
    const router = createPlatformAppsRouter(createCatalogLoader())
    const handler = getRouteHandler(router, 'get', routePath)
    const response = createMockResponse()
    await handler({
      params: params ?? {},
      headers: {},
      // Non-admin caller for the feature-flag cases. It deliberately holds a read code for EVERY
      // app in this catalog, elearning included: these cases exist to prove the FLAG hides
      // elearning, so their 404 must not be over-determined by the new permission gate.
      user: admin
        ? { id: 'app-admin', role: 'admin' }
        : { id: 'app-reader', role: 'user', permissions: ['after_sales:read', 'attendance:read', 'elearning:read'] },
      authenticatedTenantId: admin ? 'app-org' : undefined,
    }, response)
    return response
  }

  function assertValuesFree(body: unknown) {
    const serialized = JSON.stringify(body)
    expect(serialized).not.toMatch(/ELEARNING/)
    expect(serialized).not.toContain('ELEARNING_ENABLED')
  }

  it.each([
    ['missing', undefined],
    ['false', 'false'],
    ['TRUE', 'TRUE'],
    ['true-space', 'true '],
  ] as const)('hides elearning from list and 404s detail when master is %s', async (_label, value) => {
    if (value === undefined) delete process.env.ELEARNING_ENABLED
    else process.env.ELEARNING_ENABLED = value

    const list = await invoke('/')
    expect(list.statusCode).toBe(200)
    const ids = ((list.body as { list: Array<{ id: string }> }).list ?? []).map((item) => item.id).sort()
    expect(ids).toEqual(['after-sales', 'attendance'])
    expect(JSON.stringify(list.body)).not.toContain('学习中心')
    assertValuesFree(list.body)

    const detail = await invoke('/:appId', { appId: 'elearning' })
    expect(detail.statusCode).toBe(404)
    expect(detail.body).toEqual({ error: 'Platform app not found' })
    assertValuesFree(detail.body)

    const afterSales = await invoke('/:appId', { appId: 'after-sales' })
    expect(afterSales.statusCode).toBe(200)
    expect((afterSales.body as { id: string }).id).toBe('after-sales')

    const attendance = await invoke('/:appId', { appId: 'attendance' })
    expect(attendance.statusCode).toBe(200)
    expect((attendance.body as { id: string }).id).toBe('attendance')
  })

  it('exposes installation to an authenticated administrator', async () => {
    process.env.ELEARNING_ENABLED = 'true'

    const list = await invoke('/', undefined, true)
    expect(list.statusCode).toBe(200)
    const ids = ((list.body as { list: Array<{ id: string; displayName: string }> }).list ?? []).map((item) => item.id).sort()
    expect(ids).toEqual(['after-sales', 'attendance', 'elearning'])
    expect(JSON.stringify(list.body)).toContain('学习中心')

    const detail = await invoke('/:appId', { appId: 'elearning' }, true)
    expect(detail.statusCode).toBe(200)
    expect(detail.body).toMatchObject({
      id: 'elearning',
      displayName: '学习中心',
      pluginStatus: 'active',
      navigation: [
        {
          id: 'elearning-learner',
          title: '学习中心',
          path: '/learn',
          icon: 'book',
          order: 70,
          location: 'main-nav',
        },
        {
          id: 'elearning-admin',
          title: '云课堂管理',
          path: '/admin/elearning',
          icon: 'settings',
          order: 10,
          location: 'admin',
        },
      ],
      featureFlags: ['elearning'],
      instance: null,
    })
    assertValuesFree(detail.body)

    const afterSales = await invoke('/:appId', { appId: 'after-sales' })
    expect(afterSales.statusCode).toBe(200)
    expect((afterSales.body as { id: string }).id).toBe('after-sales')
  })
})

/**
 * G-7 (4): the App Center visibility gate. Before this suite the two routes did ZERO permission
 * work -- every authenticated account saw every app and every app's full manifest projection --
 * while `app.manifest.json` had been declaring `permissions` and `app-registry.ts` had been
 * projecting them to the browser all along. Each case below names the single guard line it would
 * catch: `routes/platform-apps.ts#canSeePlatformApp` (and `#isPlatformAppAdminRequest`).
 */
describe('platform apps router permission filter', () => {
  beforeEach(() => {
    queryMock.mockReset()
    queryForTenantMock.mockReset()
  })

  function appManifest(id: string, permissions: string[]): Record<string, unknown> {
    return {
      id,
      version: '0.1.0',
      displayName: `${id} display`,
      pluginId: `plugin-${id}`,
      boundedContext: { code: id },
      platformDependencies: ['multitable'],
      navigation: [
        { id: `${id}-home`, title: id, path: `/p/plugin-${id}/${id}`, location: 'main-nav', order: 1 },
      ],
      permissions,
      featureFlags: [],
      objects: [],
      workflows: [],
      integrations: [],
    }
  }

  /** A stock-prep app (three declared codes) plus a public app (zero declared codes). */
  function createRouter() {
    const gated = createLoadedPlugin('plugin-stock-prep', appManifest('stock-preparation', [
      'stock-prep:read',
      'stock-prep:operate',
      'stock-prep:admin',
    ]))
    const open = createLoadedPlugin('plugin-open-app', appManifest('open-app', []))
    return createPlatformAppsRouter({
      pluginLoader: {
        getPlugins: () => new Map([
          ['plugin-stock-prep', gated],
          ['plugin-open-app', open],
        ]),
      } as any,
      pluginStatus: new Map([
        ['plugin-stock-prep', { status: 'active' as const }],
        ['plugin-open-app', { status: 'active' as const }],
      ]),
    })
  }

  async function list(user: unknown) {
    const handler = getRouteHandler(createRouter(), 'get', '/')
    const response = createMockResponse()
    await handler({ params: {}, headers: {}, user }, response)
    return response
  }

  async function detail(appId: string, user: unknown) {
    const handler = getRouteHandler(createRouter(), 'get', '/:appId')
    const response = createMockResponse()
    await handler({ params: { appId }, headers: {}, user }, response)
    return response
  }

  function listedIds(response: { body: unknown }): string[] {
    return ((response.body as { list?: Array<{ id: string }> }).list ?? []).map((item) => item.id).sort()
  }

  it('hides an app whose declared codes the caller holds none of', async () => {
    const response = await list({ id: 'u_1', role: 'user', permissions: ['elearning:read'] })

    expect(response.statusCode).toBe(200)
    expect(listedIds(response)).toEqual(['open-app'])
    // Not merely absent from `list`: no field of the hidden app's manifest projection leaks either.
    expect(JSON.stringify(response.body)).not.toContain('stock-preparation')
  })

  it('404s the detail route for an app the caller may not see, and reads no instance row', async () => {
    const response = await detail('stock-preparation', {
      id: 'u_1',
      role: 'user',
      permissions: ['elearning:read'],
      tenantId: 'tenant_42',
    })

    expect(response.statusCode).toBe(404)
    expect(response.body).toEqual({ error: 'Platform app not found' })
    expect(queryForTenantMock).not.toHaveBeenCalled()
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('answers a refused app and a nonexistent app identically (no existence oracle)', async () => {
    const user = { id: 'u_1', role: 'user', permissions: ['elearning:read'] }
    const refused = await detail('stock-preparation', user)
    const missing = await detail('no-such-app', user)

    expect(refused.statusCode).toBe(missing.statusCode)
    expect(refused.body).toEqual(missing.body)
  })

  it('shows the app on ANY ONE of its declared codes, not on all of them', async () => {
    for (const code of ['stock-prep:read', 'stock-prep:operate', 'stock-prep:admin']) {
      const response = await list({ id: 'u_1', role: 'user', permissions: [code] })
      expect(listedIds(response)).toEqual(['open-app', 'stock-preparation'])
    }
  })

  it('runs the same code algebra the browser runs (resource wildcard, resource admin, write implies read)', async () => {
    const readOnlyApp = createLoadedPlugin('plugin-stock-prep', appManifest('stock-preparation', ['stock-prep:read']))
    async function listWith(permissions: string[]) {
      const router = createPlatformAppsRouter({
        pluginLoader: { getPlugins: () => new Map([['plugin-stock-prep', readOnlyApp]]) } as any,
        pluginStatus: new Map([['plugin-stock-prep', { status: 'active' as const }]]),
      })
      const response = createMockResponse()
      await getRouteHandler(router, 'get', '/')(
        { params: {}, headers: {}, user: { id: 'u_1', role: 'user', permissions } },
        response,
      )
      return listedIds(response)
    }

    expect(await listWith(['stock-prep:*'])).toEqual(['stock-preparation'])
    expect(await listWith(['stock-prep:admin'])).toEqual(['stock-preparation'])
    expect(await listWith(['stock-prep:write'])).toEqual(['stock-preparation'])
    // The asymmetric half: a neighbouring resource never leaks in (R-11: integration:write is not a
    // stock-prep scope), and a code with no action grants nothing.
    expect(await listWith(['integration:write'])).toEqual([])
    expect(await listWith(['stock-prep'])).toEqual([])
  })

  it('treats an app that declares no codes as public to any authenticated caller', async () => {
    const response = await list({ id: 'u_1', role: 'user' })

    expect(listedIds(response)).toEqual(['open-app'])
    const detailResponse = await detail('open-app', { id: 'u_1', role: 'user' })
    expect(detailResponse.statusCode).toBe(200)
    expect((detailResponse.body as { id: string }).id).toBe('open-app')
  })

  it.each([
    ['role admin', { id: 'u_admin', role: 'admin' }],
    ['a roles list containing admin', { id: 'u_admin', role: 'user', roles: ['admin'] }],
    ['the *:* code', { id: 'u_admin', role: 'user', permissions: ['*:*'] }],
    ['the users.is_admin flag', { id: 'u_admin', role: 'user', is_admin: true }],
  ] as const)('lets a platform admin through by %s', async (_label, user) => {
    const response = await list(user)
    expect(listedIds(response)).toEqual(['open-app', 'stock-preparation'])

    const detailResponse = await detail('stock-preparation', user)
    expect(detailResponse.statusCode).toBe(200)
  })

  it('narrows the instance read to the apps that survived the gate', async () => {
    queryForTenantMock.mockResolvedValue({ rows: [], rowCount: 0 })
    const response = await list({ id: 'u_1', tenantId: 'tenant_42' })

    expect(listedIds(response)).toEqual(['open-app'])
    expect(queryForTenantMock).toHaveBeenCalledTimes(1)
    expect(queryForTenantMock).toHaveBeenCalledWith(
      'tenant_42',
      expect.stringContaining('FROM platform_app_instances'),
      ['tenant_42', ['open-app']],
    )
  })

  it('never widens the instance read to every workspace row when the caller may see nothing', async () => {
    const onlyGated = createLoadedPlugin('plugin-stock-prep', appManifest('stock-preparation', ['stock-prep:read']))
    const router = createPlatformAppsRouter({
      pluginLoader: { getPlugins: () => new Map([['plugin-stock-prep', onlyGated]]) } as any,
      pluginStatus: new Map([['plugin-stock-prep', { status: 'active' as const }]]),
    })
    const response = createMockResponse()
    await getRouteHandler(router, 'get', '/')({
      params: {},
      headers: {},
      user: { id: 'u_1', role: 'user', permissions: ['elearning:read'], tenantId: 'tenant_42' },
    }, response)

    expect(response.statusCode).toBe(200)
    expect((response.body as { list: unknown[] }).list).toEqual([])
    // An empty appIds list makes listPlatformAppInstances fall back to "every instance in this
    // workspace" (services/PlatformAppInstanceRegistryService.ts:142-149). It must never be reached.
    expect(queryForTenantMock).not.toHaveBeenCalled()
    expect(queryMock).not.toHaveBeenCalled()
  })

  it('gates the shipped stock-prep manifest on the codes it actually declares', async () => {
    const manifestPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../plugins/plugin-integration-core/app.manifest.json',
    )
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { id: string; permissions: string[] }

    // The gate is only as real as the data it consumes: were this manifest to ship an empty
    // `permissions`, owner decision 3 would turn the app public, and this line says so out loud.
    expect(raw.id).toBe('stock-preparation')
    expect(raw.permissions).toEqual(['stock-prep:read', 'stock-prep:operate', 'stock-prep:admin'])

    const loaded = createLoadedPlugin('plugin-integration-core', raw as unknown as Record<string, unknown>)
    const router = createPlatformAppsRouter({
      pluginLoader: { getPlugins: () => new Map([['plugin-integration-core', loaded]]) } as any,
      pluginStatus: new Map([['plugin-integration-core', { status: 'active' as const }]]),
    })

    const denied = createMockResponse()
    await getRouteHandler(router, 'get', '/')(
      { params: {}, headers: {}, user: { id: 'u_1', role: 'user', permissions: ['integration:write'] } },
      denied,
    )
    expect((denied.body as { list: unknown[] }).list).toEqual([])

    const allowed = createMockResponse()
    await getRouteHandler(router, 'get', '/')(
      { params: {}, headers: {}, user: { id: 'u_2', role: 'user', permissions: ['stock-prep:operate'] } },
      allowed,
    )
    expect(listedIds(allowed)).toEqual(['stock-preparation'])
  })
})
