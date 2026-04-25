import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const pluginDir = path.resolve(__dirname, '..')
const pluginLoaderModuleUrl = new URL('../../../packages/core-backend/src/core/plugin-loader.ts', import.meta.url)

async function loadPluginLoaderClass() {
  process.env.METASHEET_VERSION = process.env.METASHEET_VERSION || '2.5.0'
  const mod = await import(pluginLoaderModuleUrl.href)
  const candidate = mod.PluginLoader || mod.default?.PluginLoader || mod.default
  assert.equal(typeof candidate, 'function', 'PluginLoader export resolves to a class/function')
  return candidate
}

function createHostContext() {
  const routes = []
  const namespaces = new Map()
  const logs = []

  const context = {
    api: {
      http: {
        addRoute(method, routePath, handler) {
          routes.push({ method, path: routePath, handler })
        },
      },
      database: {
        async query() {
          return []
        },
      },
      multitable: {
        provisioning: {
          async ensureObject() {
            throw new Error('not used in host-loader smoke')
          },
        },
      },
      events: {
        emit() {},
        on() {},
      },
    },
    communication: {
      register(name, api) {
        namespaces.set(name, api)
      },
      async call(name, method, ...args) {
        const api = namespaces.get(name)
        if (!api || typeof api[method] !== 'function') {
          throw new Error(`missing communication method ${name}.${method}`)
        }
        return api[method](...args)
      },
      on() {},
      emit() {},
    },
    logger: {
      info(message) { logs.push(String(message)) },
      warn(message) { logs.push(String(message)) },
      error(message) { logs.push(String(message)) },
    },
    storage: {
      async get() { return null },
      async set() {},
      async delete() {},
      async list() { return [] },
    },
    services: {
      security: {
        async encrypt(value) { return `enc:${Buffer.from(value, 'utf8').toString('base64')}` },
        async decrypt(value) { return Buffer.from(value.slice(4), 'base64').toString('utf8') },
        async hash(value) { return `hash:${value}` },
      },
    },
    config: {},
  }

  return { context, routes, namespaces, logs }
}

async function main() {
  const PluginLoader = await loadPluginLoaderClass()
  const loader = new PluginLoader({}, { pluginDirs: [pluginDir] })
  const discovered = await loader.discover()

  assert.deepEqual(discovered, [pluginDir], 'PluginLoader discovers plugin-integration-core directory')

  const loaded = await loader.load(discovered[0], { basePath: '/' })
  assert.ok(loaded, 'PluginLoader loads plugin-integration-core')
  assert.equal(loaded.manifest.name, 'plugin-integration-core')
  assert.equal(typeof loaded.plugin.activate, 'function')
  assert.equal(typeof loaded.plugin.deactivate, 'function')

  const host = createHostContext()
  await loaded.plugin.activate(host.context)

  assert.ok(host.routes.length >= 1, 'activate registers at least one route')
  const healthRoute = host.routes.find((route) => route.method === 'GET' && route.path === '/api/integration/health')
  assert.ok(healthRoute, 'health route registered')
  assert.ok(host.namespaces.has('integration-core'), 'activate registers communication namespace')

  let responseBody = null
  await healthRoute.handler({}, { json(value) { responseBody = value } })
  assert.equal(responseBody?.ok, true)
  assert.equal(responseBody?.plugin, 'plugin-integration-core')

  const ping = await host.context.communication.call('integration-core', 'ping')
  assert.equal(ping.ok, true)
  assert.equal(ping.plugin, 'plugin-integration-core')

  const status = await host.context.communication.call('integration-core', 'getStatus')
  assert.equal(status.plugin, 'plugin-integration-core')
  assert.equal(status.routesRegistered, host.routes.length)
  assert.deepEqual(status.credentialStore, { source: 'host-security', format: 'enc' })
  assert.equal(status.externalSystems, true)
  assert.equal(typeof host.namespaces.get('integration-core').upsertExternalSystem, 'function')
  assert.deepEqual(status.adapters, ['http'])
  assert.deepEqual(
    await host.context.communication.call('integration-core', 'listAdapterKinds'),
    ['http'],
  )

  await loaded.plugin.deactivate()
  assert.ok(host.logs.some((line) => line.includes('activated')), 'activation logged')
  assert.ok(host.logs.some((line) => line.includes('deactivated')), 'deactivation logged')

  console.log('✓ host-loader-smoke: PluginLoader load + activate path passed')
}

main().catch((err) => {
  console.error('✗ host-loader-smoke FAILED')
  console.error(err)
  process.exit(1)
})
