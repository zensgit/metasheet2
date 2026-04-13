import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectPlatformApps } from '../src/platform/app-registry'
import type { LoadedPlugin } from '../src/core/plugin-loader'

const tempDirs: string[] = []

function createLoadedPlugin(pluginName: string, manifest: Record<string, unknown> | null): LoadedPlugin {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `metasheet-platform-app-${pluginName}-`))
  tempDirs.push(dir)
  if (manifest) {
    fs.writeFileSync(path.join(dir, 'app.manifest.json'), JSON.stringify(manifest, null, 2))
  }
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

describe('collectPlatformApps', () => {
  it('collects valid app manifests and derives entry path', async () => {
    const loaded = createLoadedPlugin('plugin-after-sales', {
      id: 'after-sales',
      version: '0.1.0',
      displayName: 'After Sales',
      pluginId: 'plugin-after-sales',
      boundedContext: { code: 'after-sales' },
      platformDependencies: ['multitable', 'comments'],
      navigation: [
        { id: 'hidden-entry', title: 'Hidden', path: '/hidden', location: 'hidden', order: 1 },
        { id: 'home', title: 'After Sales', path: '/p/plugin-after-sales/after-sales', location: 'main-nav', order: 2 },
      ],
      permissions: [],
      featureFlags: ['afterSales'],
      objects: [],
      workflows: [],
      integrations: [],
    })

    const result = await collectPlatformApps({
      loadedPlugins: [loaded],
      pluginStatus: new Map([
        ['plugin-after-sales', { status: 'active' as const }],
      ]),
    })

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      id: 'after-sales',
      pluginName: 'plugin-after-sales',
      pluginStatus: 'active',
      runtimeModel: 'instance',
      entryPath: '/p/plugin-after-sales/after-sales',
      runtimeBindings: undefined,
    })
  })

  it('prefers main-nav entry path over admin entry path even when admin order is smaller', async () => {
    const loaded = createLoadedPlugin('plugin-after-sales', {
      id: 'after-sales',
      version: '0.1.0',
      displayName: 'After Sales',
      pluginId: 'plugin-after-sales',
      boundedContext: { code: 'after-sales' },
      runtimeBindings: {
        currentPath: '/api/after-sales/projects/current',
        installPath: '/api/after-sales/projects/install',
        installPayload: {
          templateId: 'after-sales-default',
        },
      },
      platformDependencies: ['multitable', 'comments'],
      navigation: [
        { id: 'runtime-admin', title: 'Runtime admin', path: '/p/plugin-after-sales/after-sales#after-sales-runtime-admin', location: 'admin', order: 10 },
        { id: 'home', title: 'After Sales', path: '/p/plugin-after-sales/after-sales', location: 'main-nav', order: 60 },
      ],
      permissions: [],
      featureFlags: ['afterSales'],
      objects: [],
      workflows: [],
      integrations: [],
    })

    const result = await collectPlatformApps({
      loadedPlugins: [loaded],
      pluginStatus: new Map([
        ['plugin-after-sales', { status: 'active' as const }],
      ]),
    })

    expect(result).toHaveLength(1)
    expect(result[0].entryPath).toBe('/p/plugin-after-sales/after-sales')
    expect(result[0].runtimeBindings).toEqual({
      currentPath: '/api/after-sales/projects/current',
      installPath: '/api/after-sales/projects/install',
      installPayload: {
        templateId: 'after-sales-default',
      },
    })
  })

  it('skips plugins without app manifest', async () => {
    const loaded = createLoadedPlugin('plugin-no-app', null)
    const result = await collectPlatformApps({ loadedPlugins: [loaded] })
    expect(result).toEqual([])
  })

  it('skips invalid app manifests', async () => {
    const loaded = createLoadedPlugin('plugin-invalid-app', {
      id: 'broken-app',
      version: '0.1.0',
      displayName: 'Broken App',
    })
    const result = await collectPlatformApps({ loadedPlugins: [loaded] })
    expect(result).toEqual([])
  })

  it('collects direct-runtime manifests without requiring tenant instances', async () => {
    const loaded = createLoadedPlugin('plugin-attendance', {
      id: 'attendance',
      version: '0.1.0',
      displayName: 'Attendance',
      pluginId: 'plugin-attendance',
      runtimeModel: 'direct',
      boundedContext: { code: 'attendance' },
      platformDependencies: ['workflow'],
      navigation: [
        { id: 'home', title: 'Attendance', path: '/attendance', location: 'main-nav', order: 50 },
      ],
      permissions: [],
      featureFlags: ['attendance'],
      objects: [],
      workflows: [],
      integrations: [],
    })

    const result = await collectPlatformApps({
      loadedPlugins: [loaded],
      pluginStatus: new Map([
        ['plugin-attendance', { status: 'active' as const }],
      ]),
    })

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      id: 'attendance',
      pluginName: 'plugin-attendance',
      pluginStatus: 'active',
      runtimeModel: 'direct',
      entryPath: '/attendance',
    })
  })
})
