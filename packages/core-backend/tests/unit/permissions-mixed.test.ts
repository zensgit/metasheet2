import { describe, it, expect } from 'vitest'
import { PluginLoader } from '../../src/core/plugin-loader'

const coreAPI: any = { http: { addRoute: () => {} } }

describe('Manifest permissions validation (mixed)', () => {
  it('fails when permissions include invalid entries', async () => {
    const loader = new PluginLoader(coreAPI, { pluginDirs: [] }) as any
    const manifest = {
      name: 'plugin-mixed-perms',
      version: '0.1.0',
      engines: { metasheet: '>=1.0.0' },
      path: process.cwd(),
      permissions: ['http.addRoute', 'websocket.broadcast', 'invalid.perm']
    }
    await expect(loader['loadPlugin'](manifest)).rejects.toThrow(/Permission not allowed/)
  })
})

