import { describe, it, expect } from 'vitest'
import { PluginLoader } from '../../src/core/plugin-loader'
import { PluginErrorCode } from '../../src/core/plugin-errors'

const coreAPI: any = { http: { addRoute: () => {} } }

describe('PluginLoader edge cases', () => {
  it('reloadPlugin should throw HOT_RELOAD_UNSUPPORTED (PLUGIN_008)', async () => {
    const loader = new PluginLoader(coreAPI, { pluginDirs: [] })
    await expect(loader.reloadPlugin('any')).rejects.toMatchObject({ code: PluginErrorCode.HOT_RELOAD_UNSUPPORTED })
  })
})

