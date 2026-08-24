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

  async function invoke(routePath: string, params?: Record<string, string>) {
    const router = createPlatformAppsRouter(createCatalogLoader())
    const handler = getRouteHandler(router, 'get', routePath)
    const response = createMockResponse()
    await handler({
      params: params ?? {},
      headers: {},
      user: undefined,
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

  it('exposes elearning in list and detail when master is exact true', async () => {
    process.env.ELEARNING_ENABLED = 'true'

    const list = await invoke('/')
    expect(list.statusCode).toBe(200)
    const ids = ((list.body as { list: Array<{ id: string; displayName: string }> }).list ?? []).map((item) => item.id).sort()
    expect(ids).toEqual(['after-sales', 'attendance', 'elearning'])
    expect(JSON.stringify(list.body)).toContain('学习中心')

    const detail = await invoke('/:appId', { appId: 'elearning' })
    expect(detail.statusCode).toBe(200)
    expect(detail.body).toMatchObject({
      id: 'elearning',
      displayName: '学习中心',
      pluginStatus: 'active',
      navigation: [],
      featureFlags: ['elearning'],
      instance: null,
    })
    assertValuesFree(detail.body)

    const afterSales = await invoke('/:appId', { appId: 'after-sales' })
    expect(afterSales.statusCode).toBe(200)
    expect((afterSales.body as { id: string }).id).toBe('after-sales')
  })
})
