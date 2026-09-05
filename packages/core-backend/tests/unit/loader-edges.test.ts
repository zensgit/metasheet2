import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginLoader } from '../../src/core/plugin-loader'
import type { LoadedPlugin } from '../../src/core/plugin-loader'
import { metrics, registry } from '../../src/metrics/metrics'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const coreAPI: any = { http: { addRoute: () => {} } }

type PluginLoaderInternals = {
  loadedPlugins: Map<string, LoadedPlugin>
}

function loadedPlugin(name: string): LoadedPlugin {
  return {
    manifest: { name, version: '1.0.0' },
    plugin: { activate: async () => {} },
    path: `/synthetic/${name}`,
    loadedAt: new Date(),
  }
}

function installLoadedPlugin(loader: PluginLoader, plugin: LoadedPlugin): void {
  (loader as unknown as PluginLoaderInternals).loadedPlugins.set(plugin.manifest.name, plugin)
}

async function metricExposition(): Promise<string> {
  return registry.metrics()
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PluginLoader edge cases', () => {
  it('reloadPlugin should return null for non-existent plugin', async () => {
    const loader = new PluginLoader(coreAPI, { pluginDirs: [] })
    const result = await loader.reloadPlugin('any')
    expect(result).toBeNull()
    expect(await metricExposition()).not.toContain('plugin_name="any"')
  })

  it('observes one successful reload in seconds in the registered histogram', async () => {
    const loader = new PluginLoader(coreAPI, { pluginDirs: [] })
    const original = loadedPlugin('reload-metrics-success')
    const reloaded = loadedPlugin('reload-metrics-success')
    installLoadedPlugin(loader, original)
    vi.spyOn(loader, 'unload').mockReturnValue(true)
    vi.spyOn(loader, 'load').mockResolvedValue(reloaded)
    vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_250)

    await expect(loader.reloadPlugin(original.manifest.name)).resolves.toBe(reloaded)

    const exposition = await metricExposition()
    expect(exposition.match(/metasheet_plugin_reload_duration_seconds_count\{plugin_name="reload-metrics-success"\} 1/g)).toHaveLength(1)
    expect(exposition).toContain('metasheet_plugin_reload_duration_seconds_sum{plugin_name="reload-metrics-success"} 0.25')
  })

  it('does not observe a failed reload and preserves cascade failure callback semantics', async () => {
    const loader = new PluginLoader(coreAPI, { pluginDirs: [] })
    const original = loadedPlugin('reload-metrics-failed')
    installLoadedPlugin(loader, original)
    vi.spyOn(loader, 'unload').mockReturnValue(true)
    vi.spyOn(loader, 'load').mockResolvedValue(null)
    const onPluginReloaded = vi.fn()

    const result = await loader.cascadeReload(original.manifest.name, { onPluginReloaded })

    expect(result.reloadedPlugins).toEqual([])
    expect(result.failedPlugins).toEqual([{ pluginId: original.manifest.name, error: 'reloadPlugin returned null' }])
    expect(onPluginReloaded).toHaveBeenCalledWith(original.manifest.name, false, expect.any(Error))
    expect(await metricExposition()).not.toContain('plugin_name="reload-metrics-failed"')
  })

  it('does not replace a successful reload when the histogram observer throws', async () => {
    const loader = new PluginLoader(coreAPI, { pluginDirs: [] })
    const original = loadedPlugin('reload-metrics-observer-throws')
    const reloaded = loadedPlugin('reload-metrics-observer-throws')
    installLoadedPlugin(loader, original)
    vi.spyOn(loader, 'unload').mockReturnValue(true)
    vi.spyOn(loader, 'load').mockResolvedValue(reloaded)
    vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_250)
    const observe = vi.spyOn(metrics.pluginReloadDuration, 'observe').mockImplementation(() => {
      throw new Error('observer unavailable')
    })

    await expect(loader.reloadPlugin(original.manifest.name)).resolves.toBe(reloaded)
    expect(observe).toHaveBeenCalledWith({ plugin_name: original.manifest.name }, 0.25)
  })
})
