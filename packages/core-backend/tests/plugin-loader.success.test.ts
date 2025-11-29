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

describe('PluginLoader success path', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('loads and activates a valid plugin without recording failures', async () => {
    const loader = new PluginLoader(makeCoreAPI())

    // Stub scanning + manifests: one valid manifest
    vi.spyOn<any, any>(loader as any, 'scanPluginDirectories').mockResolvedValue(['/tmp/ok'])
    const manifest: PluginManifest = {
      manifestVersion: '2.0.0',
      name: 'test-plugin-ok',
      version: '1.0.0',
      displayName: 'Test Plugin',
      description: 'A test plugin',
      author: 'Test Author',
      main: 'dist/index.js',
      capabilities: {},
      permissions: {},
      engine: { metasheet: '>=1.0.0' },
      path: '/tmp/ok'
    } as any
    vi.spyOn<any, any>(loader as any, 'loadManifests').mockResolvedValue([manifest])

    // Mock loadPlugin to register an instance
    vi.spyOn<any, any>(loader as any, 'loadPlugin').mockImplementation(async function (this: any, m: PluginManifest) {
      ;(loader as any).plugins.set(m.name, {
        manifest: m,
        plugin: { activate: vi.fn().mockResolvedValue(undefined) },
        context: {} as any,
        status: 'loaded'
      })
      ;(loader as any).loadOrder.push(m.name)
    })

    await loader.loadPlugins()

    const failed = loader.getFailedPlugins()
    expect(failed.size).toBe(0)
    const plugins = loader.getPlugins()
    expect(plugins.has('test-plugin-ok')).toBe(true)
    expect(plugins.get('test-plugin-ok')?.status).toBe('active')
  })
})

