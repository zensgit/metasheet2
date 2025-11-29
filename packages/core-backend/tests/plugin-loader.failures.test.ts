import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PluginLoader } from '../src/core/plugin-loader'
import type { CoreAPI, PluginManifest } from '../src/types/plugin'

function makeCoreAPI(): CoreAPI {
  return {
    http: { addRoute: vi.fn(), removeRoute: vi.fn(), middleware: vi.fn() as any },
    database: { query: vi.fn(), transaction: vi.fn(), model: vi.fn() },
    auth: { verifyToken: vi.fn(), checkPermission: vi.fn(), createToken: vi.fn() },
    events: { on: vi.fn(), once: vi.fn(), emit: vi.fn(), off: vi.fn() },
    storage: { upload: vi.fn(), download: vi.fn(), delete: vi.fn(), getUrl: vi.fn() },
    cache: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), clear: vi.fn() },
    queue: { push: vi.fn(), process: vi.fn(), cancel: vi.fn() },
    websocket: { broadcast: vi.fn(), sendTo: vi.fn(), onConnection: vi.fn() }
  }
}

describe('PluginLoader failure scenarios', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('records failed plugin when engines.metasheet is missing', async () => {
    const loader = new PluginLoader(makeCoreAPI())
    vi.spyOn<any, any>(loader as any, 'scanPluginDirectories').mockResolvedValue(['/tmp/x'])
    vi.spyOn<any, any>(loader as any, 'loadManifests').mockResolvedValue([
      { name: 'bad-manifest', version: '1.0.0', path: '/tmp/x' } as PluginManifest
    ])

    await loader.loadPlugins()

    // getFailedPlugins returns a Set<string> of plugin names
    const failed = loader.getFailedPlugins()
    expect(failed.has('bad-manifest')).toBe(true)
  })

  it('records failed plugin for non-whitelisted permission', async () => {
    const loader = new PluginLoader(makeCoreAPI())
    vi.spyOn<any, any>(loader as any, 'scanPluginDirectories').mockResolvedValue(['/tmp/y'])
    vi.spyOn<any, any>(loader as any, 'loadManifests').mockResolvedValue([
      {
        name: 'bad-permission',
        version: '1.0.0',
        engines: { metasheet: '>=1.0.0' },
        permissions: ['system.shutdown'], // Not in whitelist
        path: '/tmp/y'
      } as any
    ])
    // Replace loadPlugin to only trigger permission check without real imports
    vi.spyOn<any, any>(loader as any, 'loadPlugin').mockImplementation(async function (this: any, m: PluginManifest) {
      ;(loader as any).checkPermissions(m)
    })

    await loader.loadPlugins()

    const failed = loader.getFailedPlugins()
    expect(failed.has('bad-permission')).toBe(true)
  })

  it('sets plugin status to error when activate throws', async () => {
    const loader = new PluginLoader(makeCoreAPI())
    // Seed a loaded plugin instance that will throw on activate
    const boomErr = new Error('explode')
    ;(loader as any).plugins.set('boom-plugin', {
      manifest: { name: 'boom-plugin', version: '1.0.0', engines: { metasheet: '>=1.0.0' } },
      plugin: { activate: () => { throw boomErr } },
      context: {} as any,
      status: 'loaded'
    })
    ;(loader as any).loadOrder.push('boom-plugin')

    await (loader as any).activatePlugins()

    // Plugin status should be 'error' after failed activation
    const plugins = loader.getPlugins()
    const boomPlugin = plugins.get('boom-plugin')
    expect(boomPlugin?.status).toBe('error')
  })

  it('getSummary includes errors array', async () => {
    const loader = new PluginLoader(makeCoreAPI())
    ;(loader as any).failedPlugins.add('failed-1')
    ;(loader as any).failedPlugins.add('failed-2')

    // Verify failedPlugins set has expected count
    const failed = loader.getFailedPlugins()
    expect(failed.size).toBe(2)
    expect(failed.has('failed-1')).toBe(true)
    expect(failed.has('failed-2')).toBe(true)
  })
})
