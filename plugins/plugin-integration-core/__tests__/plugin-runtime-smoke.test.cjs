'use strict'

// ---------------------------------------------------------------------------
// plugin-integration-core · M0 spike smoke test
//
// Verifies:
//   1. plugin.json is a valid v2 manifest with required fields
//   2. index.cjs exports { activate, deactivate }
//   3. activate(context) registers GET /api/integration/health
//   4. activate(context) registers a cross-plugin communication namespace
//      that exposes { ping, getStatus }
//   5. deactivate() clears internal state cleanly
//
// Runs as plain Node (no vitest/jest required):
//   node plugins/plugin-integration-core/__tests__/plugin-runtime-smoke.test.cjs
// ---------------------------------------------------------------------------

const assert = require('node:assert/strict')
const path = require('node:path')

const PLUGIN_DIR = path.join(__dirname, '..')
const MANIFEST_PATH = path.join(PLUGIN_DIR, 'plugin.json')
const ENTRY_PATH = path.join(PLUGIN_DIR, 'index.cjs')

function createMockContext() {
  const routes = []
  const registeredNamespaces = new Map()
  const logs = []
  const databaseCalls = []

  return {
    context: {
      api: {
        http: {
          addRoute: (method, path, handler) => {
            assert.equal(typeof method, 'string', 'addRoute method must be string')
            assert.equal(typeof path, 'string', 'addRoute path must be string')
            assert.equal(typeof handler, 'function', 'addRoute handler must be function')
            routes.push({ method, path, handler })
          },
        },
        database: {
          async query(sql, params) {
            databaseCalls.push({ sql, params })
            return []
          },
        },
      },
      communication: {
        register: (namespace, api) => {
          assert.equal(typeof namespace, 'string', 'namespace must be string')
          assert.equal(typeof api, 'object', 'api must be object')
          registeredNamespaces.set(namespace, api)
        },
        call: async () => { throw new Error('mock: call not implemented') },
        on: () => {},
        emit: () => {},
      },
      logger: {
        info: (msg) => logs.push(['info', msg]),
        warn: (msg) => logs.push(['warn', msg]),
        error: (msg) => logs.push(['error', msg]),
      },
      services: {
        security: {
          async encrypt(value) { return `enc:${Buffer.from(value, 'utf8').toString('base64')}` },
          async decrypt(value) { return Buffer.from(value.slice(4), 'base64').toString('utf8') },
          async hash(value) { return `hash:${value}` },
        },
      },
    },
    inspect: { routes, namespaces: registeredNamespaces, logs, databaseCalls },
  }
}

async function runMockResponse(handler) {
  return new Promise((resolve, reject) => {
    const res = {
      _body: undefined,
      json(body) {
        this._body = body
        resolve(body)
      },
    }
    try {
      const maybePromise = handler({}, res)
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.catch(reject)
      }
    } catch (err) {
      reject(err)
    }
  })
}

async function main() {
  // --- 1. Manifest structural checks -----------------------------------
  const manifest = require(MANIFEST_PATH)
  assert.equal(manifest.manifestVersion, '2.0.0', 'manifest.manifestVersion must be 2.0.0')
  assert.equal(manifest.name, 'plugin-integration-core', 'manifest.name')
  assert.ok(/^\d+\.\d+\.\d+/.test(manifest.version), 'manifest.version semver')
  assert.equal(manifest.main, 'index.cjs', 'manifest.main')
  assert.ok(Array.isArray(manifest.permissions), 'manifest.permissions is array')
  for (const required of ['http.addRoute', 'events.emit', 'events.listen', 'database.read', 'database.write']) {
    assert.ok(manifest.permissions.includes(required), `permissions must include ${required}`)
  }

  // --- 2. Entry module shape -------------------------------------------
  const entry = require(ENTRY_PATH)
  assert.equal(typeof entry.activate, 'function', 'entry.activate is a function')
  assert.equal(typeof entry.deactivate, 'function', 'entry.deactivate is a function')

  // --- 3. activate() registers route + namespace -----------------------
  const { context, inspect } = createMockContext()
  await entry.activate(context)

  assert.equal(inspect.routes.length, 1, 'exactly one route registered')
  assert.equal(inspect.routes[0].method, 'GET', 'route method')
  assert.equal(inspect.routes[0].path, '/api/integration/health', 'health route path')

  assert.ok(inspect.namespaces.has('integration-core'), 'integration-core namespace registered')
  const commApi = inspect.namespaces.get('integration-core')
  assert.equal(typeof commApi.ping, 'function', 'comm api exposes ping')
  assert.equal(typeof commApi.getStatus, 'function', 'comm api exposes getStatus')

  // --- 4. Health route returns expected shape --------------------------
  const healthBody = await runMockResponse(inspect.routes[0].handler)
  assert.equal(healthBody.ok, true, 'health.ok')
  assert.equal(healthBody.plugin, 'plugin-integration-core', 'health.plugin')
  assert.equal(typeof healthBody.ts, 'number', 'health.ts is number')

  // --- 5. Comm API returns expected shape ------------------------------
  const pingResult = await commApi.ping()
  assert.equal(pingResult.ok, true, 'ping.ok')
  const statusResult = await commApi.getStatus()
  assert.equal(statusResult.plugin, 'plugin-integration-core', 'status.plugin')
  assert.equal(statusResult.routesRegistered, 1, 'status.routesRegistered')
  assert.deepEqual(
    statusResult.credentialStore,
    { source: 'host-security', format: 'enc' },
    'status reports host-backed credential store',
  )
  assert.equal(statusResult.externalSystems, true, 'external-system registry initialized')

  // --- 5b. Comm API exposes external-system registry methods ------------
  assert.equal(typeof commApi.upsertExternalSystem, 'function', 'comm api exposes upsertExternalSystem')
  assert.equal(typeof commApi.getExternalSystem, 'function', 'comm api exposes getExternalSystem')
  assert.equal(typeof commApi.listExternalSystems, 'function', 'comm api exposes listExternalSystems')

  // --- 6. Activation logged --------------------------------------------
  const hasActivationLog = inspect.logs.some(
    ([level, msg]) => level === 'info' && /activated/.test(msg),
  )
  assert.ok(hasActivationLog, 'startup log written at info level')

  // --- 7. Deactivate clears state --------------------------------------
  await entry.deactivate()
  // After deactivate, a re-activation must work with clean slate
  const { context: context2, inspect: inspect2 } = createMockContext()
  await entry.activate(context2)
  assert.equal(inspect2.routes.length, 1, 'routes cleanly re-registered after deactivate')
  await entry.deactivate()

  console.log('✓ plugin-runtime-smoke: all assertions passed')
}

main().catch((err) => {
  console.error('✗ plugin-runtime-smoke FAILED')
  console.error(err)
  process.exit(1)
})
