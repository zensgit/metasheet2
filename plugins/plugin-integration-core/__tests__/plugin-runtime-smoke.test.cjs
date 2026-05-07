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
  const deadLetterRow = {
    id: 'dl_1',
    tenant_id: 'tenant_1',
    workspace_id: null,
    run_id: 'run_1',
    pipeline_id: 'pipe_1',
    idempotency_key: 'idem_1',
    source_payload: { FNumber: 'MAT-001', password: 'secret' },
    transformed_payload: { FNumber: 'MAT-001', token: 'secret' },
    error_code: 'VALIDATION_FAILED',
    error_message: 'field FName is required',
    retry_count: 0,
    status: 'open',
    last_replay_run_id: null,
    created_at: '2026-05-07T00:00:00.000Z',
    updated_at: '2026-05-07T00:00:00.000Z',
  }

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
            if (String(sql).includes('FROM "integration_dead_letters"')) {
              return [deadLetterRow]
            }
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

  assert.ok(inspect.routes.length >= 1, 'at least one route registered')
  const healthRoute = inspect.routes.find((route) => route.method === 'GET' && route.path === '/api/integration/health')
  assert.ok(healthRoute, 'health route registered')

  assert.ok(inspect.namespaces.has('integration-core'), 'integration-core namespace registered')
  const commApi = inspect.namespaces.get('integration-core')
  assert.equal(typeof commApi.ping, 'function', 'comm api exposes ping')
  assert.equal(typeof commApi.getStatus, 'function', 'comm api exposes getStatus')

  // --- 4. Health route returns expected shape --------------------------
  const healthBody = await runMockResponse(healthRoute.handler)
  assert.equal(healthBody.ok, true, 'health.ok')
  assert.equal(healthBody.plugin, 'plugin-integration-core', 'health.plugin')
  assert.equal(healthBody.version, manifest.version, 'health.version follows manifest')
  assert.equal(healthBody.phase, 'integration-core-mvp', 'health.phase')
  assert.equal(healthBody.milestone, 'integration-core-mvp', 'health.milestone')
  assert.equal(typeof healthBody.ts, 'number', 'health.ts is number')
  assert.equal(healthBody.capabilities.externalSystems, true, 'health capabilities report external systems')
  assert.equal(healthBody.capabilities.runner, true, 'health capabilities report runner')
  assert.equal(healthBody.capabilities.deadLetterReplay, true, 'health capabilities report dead-letter replay')

  // --- 5. Comm API returns expected shape ------------------------------
  const pingResult = await commApi.ping()
  assert.equal(pingResult.ok, true, 'ping.ok')
  const statusResult = await commApi.getStatus()
  assert.equal(statusResult.plugin, 'plugin-integration-core', 'status.plugin')
  assert.equal(statusResult.version, manifest.version, 'status.version follows manifest')
  assert.equal(statusResult.phase, 'integration-core-mvp', 'status.phase')
  assert.equal(statusResult.milestone, 'integration-core-mvp', 'status.milestone')
  assert.equal(statusResult.routesRegistered, inspect.routes.length, 'status.routesRegistered matches registered routes')
  assert.deepEqual(
    statusResult.credentialStore,
    { source: 'host-security', format: 'enc' },
    'status reports host-backed credential store',
  )
  assert.equal(statusResult.externalSystems, true, 'external-system registry initialized')
  assert.ok(statusResult.adapters.includes('http'), 'status reports http adapter')
  assert.ok(statusResult.adapters.includes('erp:k3-wise-webapi'), 'status reports K3 WISE WebAPI adapter')
  assert.ok(statusResult.adapters.includes('erp:k3-wise-sqlserver'), 'status reports K3 WISE SQL Server adapter')
  assert.equal(statusResult.deadLetters, true, 'status reports dead-letter store')
  assert.equal(statusResult.deadLetterReplay, true, 'status reports dead-letter replay')
  assert.deepEqual(statusResult.capabilities, {
    externalSystems: statusResult.externalSystems,
    adapters: statusResult.adapters,
    pipelines: statusResult.pipelines,
    runner: statusResult.runner,
    erpFeedback: statusResult.erpFeedback,
    deadLetters: statusResult.deadLetters,
    deadLetterReplay: statusResult.deadLetterReplay,
    staging: statusResult.staging,
  }, 'status capabilities mirror flat readiness fields')

  // --- 5b. Comm API exposes registry methods ----------------------------
  assert.equal(typeof commApi.upsertExternalSystem, 'function', 'comm api exposes upsertExternalSystem')
  assert.equal(typeof commApi.getExternalSystem, 'function', 'comm api exposes getExternalSystem')
  assert.equal(typeof commApi.listExternalSystems, 'function', 'comm api exposes listExternalSystems')
  assert.equal(typeof commApi.listAdapterKinds, 'function', 'comm api exposes listAdapterKinds')
  assert.deepEqual(await commApi.listAdapterKinds(), statusResult.adapters, 'comm api adapter kinds match status')

  // --- 5c. Comm API exposes redacted dead-letter control methods ---------
  assert.equal(typeof commApi.listDeadLetters, 'function', 'comm api exposes listDeadLetters')
  assert.equal(typeof commApi.getDeadLetter, 'function', 'comm api exposes getDeadLetter')
  assert.equal(typeof commApi.replayDeadLetter, 'function', 'comm api exposes replayDeadLetter')
  const deadLetters = await commApi.listDeadLetters({
    tenantId: 'tenant_1',
    workspaceId: null,
    status: 'open',
  })
  assert.equal(deadLetters.length, 1, 'comm api lists dead letters')
  assert.equal(deadLetters[0].id, 'dl_1', 'comm api maps dead-letter id')
  assert.equal(deadLetters[0].payloadRedacted, true, 'comm api marks dead-letter payload redacted')
  assert.equal('sourcePayload' in deadLetters[0], false, 'comm api does not expose sourcePayload by default')
  assert.equal('transformedPayload' in deadLetters[0], false, 'comm api does not expose transformedPayload by default')
  const deadLetter = await commApi.getDeadLetter({
    tenantId: 'tenant_1',
    workspaceId: null,
    id: 'dl_1',
  })
  assert.equal(deadLetter.id, 'dl_1', 'comm api gets a single dead letter')
  assert.equal(deadLetter.payloadRedacted, true, 'comm api redacts single dead-letter payload')
  assert.equal('sourcePayload' in deadLetter, false, 'comm api single dead-letter omits sourcePayload')
  assert.equal('transformedPayload' in deadLetter, false, 'comm api single dead-letter omits transformedPayload')

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
  assert.ok(inspect2.routes.length >= 1, 'routes cleanly re-registered after deactivate')
  await entry.deactivate()

  console.log('✓ plugin-runtime-smoke: all assertions passed')
}

main().catch((err) => {
  console.error('✗ plugin-runtime-smoke FAILED')
  console.error(err)
  process.exit(1)
})
