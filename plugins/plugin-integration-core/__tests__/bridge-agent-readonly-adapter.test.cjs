'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const {
  AdapterValidationError,
  UnsupportedAdapterOperationError,
} = require(path.join(__dirname, '..', 'lib', 'contracts.cjs'))
const {
  BridgeAgentReadonlyAdapterError,
  createBridgeAgentReadonlyAdapter,
} = require(path.join(__dirname, '..', 'lib', 'adapters', 'bridge-agent-readonly-adapter.cjs'))

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body)
    },
  }
}

function createFetchMock() {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url)
    const body = options.body ? JSON.parse(options.body) : undefined
    calls.push({
      url,
      pathname: parsed.pathname,
      options,
      body,
    })

    if (parsed.pathname === '/health') {
      return jsonResponse(200, {
        ok: true,
        service: 'metasheet-legacy-sql-readonly-bridge',
        databaseReachable: true,
      })
    }
    if (parsed.pathname === '/objects') {
      return jsonResponse(200, {
        objects: [
          { id: 'material', label: 'Material', readonly: true, fieldCount: 4 },
          { id: 'bom', label: 'BOM Header', readonly: true, fieldCount: 3 },
          { id: 'bom_child', label: 'BOM Child', readonly: true, fieldCount: 3 },
        ],
      })
    }
    if (parsed.pathname === '/schema/material') {
      return jsonResponse(200, {
        object: 'material',
        fields: [
          { name: 'FItemID', type: 'number', required: false },
          { name: 'FNumber', type: 'string', required: true },
          { name: 'FName', type: 'string', required: true },
        ],
      })
    }
    if (parsed.pathname === '/query/material' && options.method === 'POST') {
      return jsonResponse(200, {
        object: 'material',
        records: [
          { FItemID: 1, FNumber: 'MAT-001', FName: 'Bolt' },
          { FItemID: 2, FNumber: 'MAT-002', FName: 'Nut' },
        ].slice(0, body.limit),
        limit: body.limit,
        nextCursor: null,
        done: true,
      })
    }
    if (parsed.pathname === '/schema/failing') {
      return jsonResponse(500, {
        error: {
          code: 'BRIDGE_AGENT_ERROR',
          message: 'Pass' + 'word=leak-token access_' + 'token=raw-token Bearer ' + 'abcdefghijk',
        },
      })
    }
    return jsonResponse(404, {
      error: {
        code: 'UNKNOWN_OBJECT',
        message: 'Object is not allowlisted.',
      },
    })
  }
  return { calls, fetchImpl }
}

function createSystem(overrides = {}) {
  return {
    id: 'bridge_1',
    name: 'Readonly Bridge Agent',
    kind: 'bridge:legacy-sql-readonly',
    role: 'source',
    config: {
      baseUrl: 'http://127.0.0.1:19091/',
      sampleLimit: 3,
      maxLimit: 20,
      authHeaderName: 'X-MetaSheet-Bridge-Secret',
    },
    credentials: {
      sharedSecret: 'bridge-secret-1',
    },
    ...overrides,
  }
}

async function main() {
  const { calls, fetchImpl } = createFetchMock()
  const adapter = createBridgeAgentReadonlyAdapter({
    system: createSystem(),
    fetchImpl,
  })

  // --- 1. testConnection hits health + object discovery with auth header -
  const connection = await adapter.testConnection()
  assert.equal(connection.ok, true)
  assert.equal(connection.connected, true)
  assert.equal(connection.authenticated, true)
  assert.match(connection.message, /3 objects/)
  assert.deepEqual(calls.slice(0, 2).map((call) => call.pathname), ['/health', '/objects'])
  assert.equal(calls[0].options.headers['X-MetaSheet-Bridge-Secret'], 'bridge-secret-1')
  assert.equal(calls[0].options.headers.Authorization, undefined, 'Bridge adapter does not create bearer/basic auth')

  const dbDownAdapter = createBridgeAgentReadonlyAdapter({
    system: createSystem(),
    fetchImpl: async (url) => {
      const parsed = new URL(url)
      if (parsed.pathname === '/health') {
        return jsonResponse(200, { ok: true, databaseReachable: false })
      }
      return jsonResponse(200, { objects: [] })
    },
  })
  const dbDown = await dbDownAdapter.testConnection()
  assert.equal(dbDown.ok, false, 'databaseReachable=false keeps the connection test red')
  assert.equal(dbDown.connected, false)

  // --- 2. listObjects/getSchema map the Bridge allowlist into Data Factory -
  const objects = await adapter.listObjects()
  assert.deepEqual(objects.map((object) => object.name), ['material', 'bom', 'bom_child'])
  assert.deepEqual(objects.find((object) => object.name === 'material'), {
    name: 'material',
    label: 'Material',
    operations: ['read'],
    source: 'bridge:legacy-sql-readonly',
    readonly: true,
    fieldCount: 4,
  })

  const schema = await adapter.getSchema({ object: 'material' })
  assert.equal(schema.object, 'material')
  assert.deepEqual(schema.fields.map((field) => field.name), ['FItemID', 'FNumber', 'FName'])
  assert.equal(schema.fields.find((field) => field.name === 'FNumber').required, true)
  assert.deepEqual(schema.raw, { source: 'bridge:legacy-sql-readonly' })

  // --- 3. read() posts capped limit + allowlisted equality filters, never SQL state --------
  const preview = await adapter.read({ object: 'material' })
  assert.equal(preview.records.length, 2)
  assert.equal(preview.metadata.limit, 3)
  const previewCall = calls.find((call) => call.pathname === '/query/material')
  assert.deepEqual(previewCall.body, { limit: 3 })

  const capped = await adapter.read({ object: 'material', limit: 999 })
  assert.equal(capped.metadata.limit, 20)
  const cappedCall = calls.filter((call) => call.pathname === '/query/material').at(-1)
  assert.deepEqual(cappedCall.body, { limit: 20 }, 'adapter caps reads to Bridge Agent maxLimit before sending')

  const filtered = await adapter.read({ object: 'material', limit: 5, filters: { FNumber: 'MAT-001', active: true, optional: null } })
  const filteredCall = calls.filter((call) => call.pathname === '/query/material').at(-1)
  assert.deepEqual(
    filteredCall.body,
    { limit: 5, filters: { FNumber: 'MAT-001', active: true, optional: null } },
    'adapter forwards primitive equality filters to the Bridge Agent',
  )
  assert.equal(filtered.metadata.filtersApplied, true)
  assert.deepEqual(filtered.metadata.filterFields, ['FNumber', 'active', 'optional'])

  await assert.rejects(
    () => adapter.read({ object: 'material', filters: { FNumber: { $like: 'MAT%' } } }),
    (error) => error instanceof AdapterValidationError && /equality primitives/.test(error.message),
    'operator-shaped filters stay rejected',
  )
  await assert.rejects(
    () => adapter.read({ object: 'material', filters: { FNumber: ['MAT-001'] } }),
    (error) => error instanceof AdapterValidationError && /equality primitives/.test(error.message),
    'array filters stay rejected',
  )
  await assert.rejects(
    () => adapter.read({ object: 'material', options: { sql: 'SELECT * FROM t' } }),
    (error) => error instanceof AdapterValidationError && /raw SQL/.test(error.message),
  )

  // --- 4. Unsafe config and object names fail before network I/O ---------
  assert.throws(
    () => createBridgeAgentReadonlyAdapter({
      system: createSystem({ config: { baseUrl: 'https://db.example.test:19091/' } }),
      fetchImpl,
    }),
    AdapterValidationError,
  )
  await assert.rejects(
    () => adapter.getSchema({ object: '../material' }),
    (error) => error instanceof AdapterValidationError && /allowlisted identifier/.test(error.message),
  )

  // --- 5. Bridge errors are typed and redacted ---------------------------
  await assert.rejects(
    () => adapter.getSchema({ object: 'failing' }),
    (error) => {
      assert.ok(error instanceof BridgeAgentReadonlyAdapterError)
      assert.equal(error.code, 'BRIDGE_AGENT_ERROR')
      assert.doesNotMatch(error.message, /leak-token|raw-token|abcdefghijk/)
      assert.match(error.message, /Password=\[redacted\]/)
      assert.match(error.message, new RegExp('access_' + 'token=\\[redacted\\]'))
      assert.match(error.message, /Bearer \[redacted\]/)
      return true
    },
  )

  // --- 6. Writes stay impossible through the adapter contract ------------
  await assert.rejects(
    () => adapter.upsert({ object: 'material', records: [{ FNumber: 'MAT-001' }] }),
    UnsupportedAdapterOperationError,
  )

  // --- 7. A down Bridge Agent (unreachable localhost) → clear operator message, not generic fetch fail (#2223)
  // The fixture throws the VERIFIED real undici shape on a dead port: `TypeError: fetch failed`
  // (cause.code / cause.errors are NOT populated on every Node version → detection keys on the message,
  // with codes as enrichment; the fixture matches the verified shape so test ≡ production).
  {
    const fetchFailed = () => {
      const err = new TypeError('fetch failed')
      err.cause = new Error('connect ECONNREFUSED 127.0.0.1:19091')
      throw err
    }
    const downAgent = createBridgeAgentReadonlyAdapter({ system: createSystem(), fetchImpl: fetchFailed })

    const test = await downAgent.testConnection()
    assert.equal(test.ok, false, 'unreachable agent → connection test red')
    assert.equal(test.connected, false)
    assert.equal(test.code, 'BRIDGE_AGENT_UNREACHABLE', 'unreachable surfaces a specific code, not a generic fetch failure')
    assert.match(test.message, /not reachable/i, 'message names the unreachable agent')
    assert.match(test.message, /retest the source connection/i, 'message names the recovery action')

    // The same clear error reaches the objects read path (operators hit it there too, not only on test).
    const objErr = await downAgent.listObjects().then(() => null, (e) => e)
    assert.ok(objErr instanceof BridgeAgentReadonlyAdapterError, 'objects read wraps unreachable in the adapter error')
    assert.equal(objErr.code, 'BRIDGE_AGENT_UNREACHABLE')

    // Enrichment shapes also detected: code-bearing cause (older Node) and dual-stack AggregateError.
    for (const [label, impl] of [
      ['cause.code', () => { const e = new Error('boom'); e.cause = { code: 'ECONNREFUSED' }; throw e }],
      ['cause.errors[]', () => { const e = new TypeError('x'); e.cause = { errors: [{ code: 'ECONNREFUSED' }] }; throw e }],
    ]) {
      const t = await createBridgeAgentReadonlyAdapter({ system: createSystem(), fetchImpl: impl }).testConnection()
      assert.equal(t.code, 'BRIDGE_AGENT_UNREACHABLE', `unreachable detected via ${label}`)
    }

    // Negative control: a genuine HTTP error from a REACHABLE agent must NOT be mislabeled unreachable.
    const http500 = createBridgeAgentReadonlyAdapter({
      system: createSystem(),
      fetchImpl: async () => jsonResponse(500, { error: { code: 'BRIDGE_DB_ERROR', message: 'boom' } }),
    })
    const httpErr = await http500.listObjects().then(() => null, (e) => e)
    assert.ok(httpErr, 'a 500 from a reachable agent still errors')
    assert.notEqual(httpErr.code, 'BRIDGE_AGENT_UNREACHABLE', 'a reachable-agent HTTP error is NOT labeled unreachable')
  }

  console.log('✓ bridge-agent-readonly-adapter: BA-M2 source contract tests passed')
}

main().catch((err) => {
  console.error('✗ bridge-agent-readonly-adapter FAILED')
  console.error(err)
  process.exit(1)
})
