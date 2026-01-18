import { describe, it, expect } from 'vitest'
import { PluginLoader } from '../../src/core/plugin-loader'

// Minimal CoreAPI stub for tests
const coreAPI: any = {
  http: {
    addRoute: () => true
  }
}

describe('PluginLoader failure paths', () => {
  it('handles circular dependencies gracefully (warns, does not throw)', async () => {
    const loader = new PluginLoader(coreAPI, {
      pluginDirs: [__dirname + '/fixtures/cycle-a', __dirname + '/fixtures/cycle-b']
    })
    // Current strategy: log warning and continue loading without throwing
    await expect(loader.loadPlugins()).resolves.toEqual(expect.any(Array))
  })
  it('marks plugin as failed when permission not in whitelist', async () => {
    const loader = new PluginLoader(coreAPI, {
      pluginDirs: [__dirname + '/fixtures/perm-denied']
    })
    await loader.loadPlugins()
    const failed = loader.getFailedPlugins()
    const keys = Array.from(failed.keys())
    expect(keys).toContain('plugin-perm-denied')
  })

  it('marks plugin as failed when metasheet version is incompatible', async () => {
    const loader = new PluginLoader(coreAPI, {
      pluginDirs: [__dirname + '/fixtures/version-mismatch']
    })
    await loader.loadPlugins()
    const failed = loader.getFailedPlugins()
    const keys = Array.from(failed.keys())
    expect(keys).toContain('plugin-bad-version')
  })
})
