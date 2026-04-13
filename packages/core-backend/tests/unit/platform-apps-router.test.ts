import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Router } from 'express'
import type { LoadedPlugin } from '../../src/core/plugin-loader'

const queryMock = vi.fn()

vi.mock('../../src/integration/db/connection-pool', () => ({
  poolManager: {
    get: () => ({
      query: queryMock,
    }),
  },
}))

import { createPlatformAppsRouter } from '../../src/routes/platform-apps'

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

    queryMock.mockResolvedValue({
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
})
