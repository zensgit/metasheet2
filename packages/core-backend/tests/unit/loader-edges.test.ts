import { describe, it, expect } from 'vitest'
import { PluginLoader } from '../../src/core/plugin-loader'

const coreAPI: any = { http: { addRoute: () => {} } }

describe('PluginLoader edge cases', () => {
  it('reloadPlugin should throw error for non-existent plugin', async () => {
    const loader = new PluginLoader(coreAPI, { pluginDirs: [] })
    await expect(loader.reloadPlugin('any')).rejects.toThrow('Plugin any not found for reload')
  })
})

