import { describe, it, expect } from 'vitest'
import { PluginLoader } from '../../src/core/plugin-loader'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const coreAPI: any = { http: { addRoute: () => {} } }

describe('PluginLoader edge cases', () => {
  it('reloadPlugin should return null for non-existent plugin', async () => {
    const loader = new PluginLoader(coreAPI, { pluginDirs: [] })
    const result = await loader.reloadPlugin('any')
    expect(result).toBeNull()
  })
})

