import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { MetaSheetServer } from '../../src/index'
import { ELEARNING_FLAG_NAMES, resolveElearningCatalogFeature } from '../../src/elearning/feature-flags'
import type { LoadedPlugin } from '../../src/core/plugin-loader'
import { parsePlatformAppManifest } from '../../src/platform/app-manifest'
import { collectPlatformApps } from '../../src/platform/app-registry'
import type { PluginLifecycle } from '../../src/types/plugin'

const require = createRequire(import.meta.url)
const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../plugins/plugin-elearning')
const PLUGIN_NAME = 'plugin-elearning'
const LOOKALIKES = ['TRUE', 'True', '1', 'yes', 'on', 'true ', ' true'] as const

type ElearningPluginModule = PluginLifecycle & {
  CANONICAL_METHOD: string
  CANONICAL_PATH: string
}

type PluginRouteRegistration = {
  active: boolean
  method: string
  path: string
}

type PluginHostSeam = {
  pluginLoader: { loadedPlugins: Map<string, unknown> }
  pluginRouteRegistrations: Map<string, PluginRouteRegistration>
  activatePluginByName(name: string): Promise<unknown>
  deactivatePluginByName(name: string): Promise<unknown>
}

const plugin = require(path.join(PLUGIN_DIR, 'index.cjs')) as ElearningPluginModule

function installLoadedPlugin(server: MetaSheetServer, name: string, pluginModule: Record<string, unknown>) {
  const loader = (server as unknown as { pluginLoader: { loadedPlugins: Map<string, unknown> } }).pluginLoader
  loader.loadedPlugins.set(name, {
    manifest: {
      name,
      version: '1.0.0',
      displayName: name,
      description: `${name} test plugin`,
    },
    plugin: pluginModule,
    path: PLUGIN_DIR,
    loadedAt: new Date(),
  })
}

function hostSeam(server: MetaSheetServer): PluginHostSeam {
  return server as unknown as PluginHostSeam
}

function listPluginRouteRegistrations(server: MetaSheetServer): PluginRouteRegistration[] {
  return Array.from(hostSeam(server).pluginRouteRegistrations.values())
}

function snapshotFlags(): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {}
  for (const name of ELEARNING_FLAG_NAMES) {
    snapshot[name] = Object.prototype.hasOwnProperty.call(process.env, name)
      ? process.env[name]
      : undefined
  }
  return snapshot
}

function restoreFlags(snapshot: Record<string, string | undefined>): void {
  for (const name of ELEARNING_FLAG_NAMES) {
    if (snapshot[name] === undefined) delete process.env[name]
    else process.env[name] = snapshot[name]
  }
}

function clearFlags(): void {
  for (const name of ELEARNING_FLAG_NAMES) {
    delete process.env[name]
  }
}

function setFlags(map: Record<string, string | undefined>): void {
  clearFlags()
  for (const [name, value] of Object.entries(map)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

describe('elearning plugin runtime host (real addRoute seam)', () => {
  const flagSnapshot = snapshotFlags()
  let activeServer: MetaSheetServer | undefined

  afterEach(async () => {
    if (activeServer) {
      await hostSeam(activeServer).deactivatePluginByName(PLUGIN_NAME)
      activeServer = undefined
    }
    restoreFlags(flagSnapshot)
  })

  async function activateActualPlugin(flagMap: Record<string, string | undefined>): Promise<PluginRouteRegistration[]> {
    setFlags(flagMap)
    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    activeServer = server
    installLoadedPlugin(server, PLUGIN_NAME, plugin as unknown as Record<string, unknown>)
    await hostSeam(server).activatePluginByName(PLUGIN_NAME)
    return listPluginRouteRegistrations(server)
  }

  it('master exact true registers exactly one unprefixed GET /api/elearning/capabilities route', async () => {
    const registrations = await activateActualPlugin({ ELEARNING_ENABLED: 'true' })
    expect(plugin.CANONICAL_METHOD).toBe('GET')
    expect(plugin.CANONICAL_PATH).toBe('/api/elearning/capabilities')
    expect(registrations).toHaveLength(1)
    expect(registrations[0]).toEqual({
      active: true,
      method: 'GET',
      path: '/api/elearning/capabilities',
    })
    expect(registrations[0].path.startsWith('/plugins')).toBe(false)
    expect(registrations[0].path.includes('/plugins/')).toBe(false)
  })

  it('master missing registers zero plugin routes on the real host', async () => {
    const registrations = await activateActualPlugin({})
    expect(registrations).toEqual([])
  })

  it('master false registers zero plugin routes on the real host', async () => {
    const registrations = await activateActualPlugin({ ELEARNING_ENABLED: 'false' })
    expect(registrations).toEqual([])
  })

  it.each([...LOOKALIKES])(
    'master lookalike %j registers zero plugin routes on the real host',
    async (lookalike) => {
      const registrations = await activateActualPlugin({ ELEARNING_ENABLED: lookalike })
      expect(registrations).toEqual([])
    },
  )

  it('parsePlatformAppManifest accepts plugin-elearning app.manifest.json', async () => {
    const raw = JSON.parse(readFileSync(path.join(PLUGIN_DIR, 'app.manifest.json'), 'utf8'))
    const parsed = parsePlatformAppManifest(raw)
    expect(parsed.id).toBe('elearning')
    expect(parsed.pluginId).toBe('plugin-elearning')
    expect(parsed.runtimeModel).toBe('direct')
    expect(parsed.featureFlags).toEqual(['elearning'])
    expect(parsed.navigation).toEqual([
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
    ])
    expect(parsed.objects).toEqual([])
    expect(parsed.workflows).toEqual([])
    expect(parsed.integrations).toEqual([])

    const loaded: LoadedPlugin = {
      manifest: {
        name: PLUGIN_NAME,
        version: '0.1.0',
        displayName: '学习中心',
      },
      plugin,
      path: PLUGIN_DIR,
      loadedAt: new Date(),
    }
    const apps = await collectPlatformApps({ loadedPlugins: [loaded] })
    expect(apps).toHaveLength(1)
    expect(apps[0]?.id).toBe('elearning')
    expect(apps[0]?.pluginId).toBe('plugin-elearning')
    expect(apps[0]?.featureFlags).toEqual(['elearning'])
    expect(apps[0]?.navigation).toEqual([
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
    ])
    expect(apps[0]?.entryPath).toBe('/learn')
  })

  it('catalog predicate hides the real elearning app unless master is exact true', async () => {
    const loaded: LoadedPlugin = {
      manifest: {
        name: PLUGIN_NAME,
        version: '0.1.0',
        displayName: '学习中心',
      },
      plugin,
      path: PLUGIN_DIR,
      loadedAt: new Date(),
    }

    setFlags({})
    expect(
      await collectPlatformApps({
        loadedPlugins: [loaded],
        isCatalogFeatureEnabled: resolveElearningCatalogFeature,
      }),
    ).toEqual([])

    setFlags({ ELEARNING_ENABLED: 'true' })
    const visible = await collectPlatformApps({
      loadedPlugins: [loaded],
      isCatalogFeatureEnabled: resolveElearningCatalogFeature,
    })
    expect(visible).toHaveLength(1)
    expect(visible[0]?.id).toBe('elearning')
  })

  it('index injects the elearning catalog predicate at the platform apps router', () => {
    const indexSource = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/index.ts'),
      'utf8',
    )
    expect(indexSource).toMatch(/isCatalogFeatureEnabled:\s*resolveElearningCatalogFeature/)
    expect(indexSource).toContain("from './elearning/feature-flags'")
  })
})
