import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PluginLoader } from '../src/core/plugin-loader'
import type { CoreAPI } from '../src/types/plugin'

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

describe('PluginLoader failure isolation', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('continues when a manifest is invalid', async () => {
    const loader = new PluginLoader(makeCoreAPI())
    // Spy on internal methods to simulate an invalid manifest followed by valid
    const scan = vi.spyOn<any, any>(loader as any, 'scanPluginDirectories').mockResolvedValue([
      // two fake plugin dirs (paths won't be used below as we stub loadManifests)
      '/tmp/p1',
      '/tmp/p2'
    ])
    vi.spyOn<any, any>(loader as any, 'loadManifests').mockResolvedValue([
      { name: 'bad', version: '', path: '/tmp/p1' } as any,
      { name: '@test/ok', version: '1.0.0', path: '/tmp/p2' } as any
    ])
    const validate = vi.spyOn<any, any>(loader as any, 'validateManifest')
      .mockImplementationOnce(() => false)
      .mockImplementationOnce(() => true)

    // prevent actual import execution
    vi.spyOn<any, any>(loader as any, 'loadPlugin').mockResolvedValue(undefined)
    vi.spyOn<any, any>(loader as any, 'activatePlugins').mockResolvedValue(undefined)

    await loader.loadPlugins()

    expect(scan).toHaveBeenCalled()
    expect(validate).toHaveBeenCalledTimes(2)
    // bad plugin recorded as failed
    const failed = loader.getFailedPlugins()
    expect(failed.has('bad')).toBe(true)
  })
})

