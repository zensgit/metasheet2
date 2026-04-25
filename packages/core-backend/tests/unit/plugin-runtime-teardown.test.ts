import { describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import { MetaSheetServer } from '../../src/index'

function installLoadedPlugin(server: MetaSheetServer, name: string, plugin: Record<string, unknown>) {
  const loader = (server as unknown as { pluginLoader: { loadedPlugins: Map<string, unknown> } }).pluginLoader
  loader.loadedPlugins.set(name, {
    manifest: {
      name,
      version: '1.0.0',
      displayName: name,
      description: `${name} test plugin`,
    },
    plugin,
    path: `/tmp/${name}`,
    loadedAt: new Date(),
  })
}

describe('MetaSheetServer plugin runtime teardown', () => {
  it('disables plugin-owned routes and communication namespaces on deactivate, then allows clean reactivation', async () => {
    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    const pluginName = 'plugin-runtime-teardown-probe'
    const routePath = '/internal/plugin-runtime-teardown-probe'
    const deactivateV1 = vi.fn()

    installLoadedPlugin(server, pluginName, {
      async activate(context: any) {
        context.api.http.addRoute('GET', routePath, (_req: unknown, res: any) => {
          res.json({ version: 1 })
        })
        context.communication.register(pluginName, {
          ping: async () => ({ version: 1 }),
        })
      },
      deactivate: deactivateV1,
    })

    await (server as any).activatePluginByName(pluginName)

    await expect(request((server as any).app).get(routePath)).resolves.toMatchObject({
      status: 200,
      body: { version: 1 },
    })
    await expect((server as any).pluginApis.get(pluginName).ping()).resolves.toEqual({ version: 1 })

    await (server as any).deactivatePluginByName(pluginName)

    expect(deactivateV1).toHaveBeenCalledTimes(1)
    expect((server as any).pluginApis.has(pluginName)).toBe(false)
    await expect(request((server as any).app).get(routePath)).resolves.toMatchObject({
      status: 404,
    })

    installLoadedPlugin(server, pluginName, {
      async activate(context: any) {
        context.api.http.addRoute('GET', routePath, (_req: unknown, res: any) => {
          res.json({ version: 2 })
        })
        context.communication.register(pluginName, {
          ping: async () => ({ version: 2 }),
        })
      },
      deactivate: vi.fn(),
    })

    await (server as any).activatePluginByName(pluginName)

    await expect(request((server as any).app).get(routePath)).resolves.toMatchObject({
      status: 200,
      body: { version: 2 },
    })
    await expect((server as any).pluginApis.get(pluginName).ping()).resolves.toEqual({ version: 2 })
  })

  it('cleans partially registered runtime resources when activation fails', async () => {
    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    const pluginName = 'plugin-runtime-activation-failure-probe'
    const routePath = '/internal/plugin-runtime-activation-failure-probe'

    installLoadedPlugin(server, pluginName, {
      async activate(context: any) {
        context.api.http.addRoute('GET', routePath, (_req: unknown, res: any) => {
          res.json({ stale: true })
        })
        context.communication.register(pluginName, {
          ping: async () => ({ stale: true }),
        })
        throw new Error('boom')
      },
      deactivate: vi.fn(),
    })

    const state = await (server as any).activatePluginByName(pluginName)

    expect(state).toMatchObject({ status: 'failed', error: 'boom' })
    expect((server as any).pluginApis.has(pluginName)).toBe(false)
    await expect(request((server as any).app).get(routePath)).resolves.toMatchObject({
      status: 404,
    })
  })

  it('rejects communication namespace collisions without deleting the original owner', async () => {
    const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
    const namespace = 'shared-runtime-namespace'

    installLoadedPlugin(server, 'plugin-runtime-owner-a', {
      async activate(context: any) {
        context.communication.register(namespace, {
          ping: async () => 'owner-a',
        })
      },
      deactivate: vi.fn(),
    })
    installLoadedPlugin(server, 'plugin-runtime-owner-b', {
      async activate(context: any) {
        context.communication.register(namespace, {
          ping: async () => 'owner-b',
        })
      },
      deactivate: vi.fn(),
    })

    await (server as any).activatePluginByName('plugin-runtime-owner-a')
    const state = await (server as any).activatePluginByName('plugin-runtime-owner-b')

    expect(state).toMatchObject({ status: 'failed' })
    await expect((server as any).pluginApis.get(namespace).ping()).resolves.toBe('owner-a')

    await (server as any).deactivatePluginByName('plugin-runtime-owner-b')
    await expect((server as any).pluginApis.get(namespace).ping()).resolves.toBe('owner-a')
  })
})
