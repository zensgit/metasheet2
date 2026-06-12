'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const {
  AdapterValidationError,
  UnsupportedAdapterOperationError,
} = require(path.join(__dirname, '..', 'lib', 'contracts.cjs'))
const {
  HttpAdapterError,
  createHttpAdapter,
} = require(path.join(__dirname, '..', 'lib', 'adapters', 'http-adapter.cjs'))

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
    calls.push({
      url,
      pathname: parsed.pathname,
      searchParams: Object.fromEntries(parsed.searchParams.entries()),
      options,
      body: options.body ? JSON.parse(options.body) : undefined,
    })

    if (parsed.pathname === '/health') {
      return jsonResponse(200, { ok: true })
    }
    if (parsed.pathname === '/api/materials' && options.method === 'GET') {
      return jsonResponse(200, {
        payload: {
          items: [
            { code: 'A-01', name: 'Bolt' },
            { code: 'B-02', name: 'Nut' },
          ],
          next: 'cursor-2',
        },
      })
    }
    if (parsed.pathname === '/api/materials/batch' && options.method === 'POST') {
      return jsonResponse(200, {
        written: 2,
        skipped: 0,
        failed: 0,
        results: [
          { code: 'A-01', externalId: 'k3_1' },
          { code: 'B-02', externalId: 'k3_2' },
        ],
      })
    }
    if (parsed.pathname === '/api/network-sink' && options.method === 'POST') {
      throw new TypeError('fetch failed')
    }
    if (parsed.pathname === '/api/body-read-fail') {
      return {
        ok: true,
        status: 200,
        async text() {
          throw new TypeError('socket closed token=raw-secret')
        },
      }
    }
    if (parsed.pathname === '/api/fail') {
      return jsonResponse(500, { error: 'boom' })
    }
    return jsonResponse(404, { error: 'not found' })
  }
  return { calls, fetchImpl }
}

function createSystem(overrides = {}) {
  return {
    id: 'sys_http',
    name: 'HTTP PLM',
    kind: 'http',
    role: 'bidirectional',
    credentials: {
      bearerToken: 'token-1',
      apiKey: 'key-1',
    },
    config: {
      baseUrl: 'https://plm.example.test/root/',
      healthPath: '/health',
      apiKeyHeader: 'X-Test-Key',
      headers: {
        'X-Tenant': 'tenant_1',
      },
      objects: {
        materials: {
          label: 'Materials',
          path: '/api/materials',
          upsertPath: '/api/materials/batch',
          recordsPath: 'payload.items',
          nextCursorPath: 'payload.next',
          operations: ['read', 'upsert'],
          schema: [
            { name: 'code', type: 'string', required: true },
            { name: 'name', type: 'string' },
          ],
        },
        read_only: {
          path: '/api/materials',
          operations: ['read'],
        },
        failing: {
          path: '/api/fail',
          operations: ['read'],
        },
        network_sink: {
          path: '/api/network-sink',
          operations: ['upsert'],
        },
        network_sink_with_query: {
          upsertPath: '/api/network-sink?token=raw-secret#frag',
          operations: ['upsert'],
        },
        body_read_failing: {
          path: '/api/body-read-fail?token=raw-secret',
          operations: ['read'],
        },
      },
    },
    ...overrides,
  }
}

async function main() {
  const { calls, fetchImpl } = createFetchMock()
  const adapter = createHttpAdapter({
    system: createSystem(),
    fetchImpl,
  })

  // --- 1. testConnection uses baseUrl, headers, and credential headers ---
  const connection = await adapter.testConnection()
  assert.deepEqual(connection, { ok: true, status: 200 })
  assert.equal(calls[0].pathname, '/health')
  assert.equal(calls[0].options.headers.Authorization, 'Bearer token-1')
  assert.equal(calls[0].options.headers['X-Test-Key'], 'key-1')
  assert.equal(calls[0].options.headers['X-Tenant'], 'tenant_1')

  // --- 2. listObjects/getSchema read local config -----------------------
  const objects = await adapter.listObjects()
  assert.deepEqual(objects.find((object) => object.name === 'materials').operations, ['read', 'upsert'])
  assert.deepEqual(objects.find((object) => object.name === 'network_sink').operations, ['upsert'])

  const schema = await adapter.getSchema({ object: 'materials' })
  assert.equal(schema.object, 'materials')
  assert.deepEqual(schema.fields.map((field) => field.name), ['code', 'name'])

  // --- 3. read() parses nested records and cursor -----------------------
  const read = await adapter.read({
    object: 'materials',
    limit: 25,
    cursor: 'cursor-1',
    filters: { status: 'approved' },
    watermark: { updated_at: '2026-04-24T00:00:00Z' },
  })
  assert.equal(read.records.length, 2)
  assert.equal(read.nextCursor, 'cursor-2')
  assert.equal(read.done, false)
  const readCall = calls.find((call) => call.pathname === '/api/materials' && call.options.method === 'GET')
  assert.equal(readCall.searchParams.limit, '25')
  assert.equal(readCall.searchParams.cursor, 'cursor-1')
  assert.equal(readCall.searchParams.status, 'approved')
  assert.equal(readCall.searchParams.updated_at, '2026-04-24T00:00:00Z')

  await adapter.read({
    object: 'materials',
    limit: 50000,
    cursor: 'safe-cursor',
    filters: { status: 'approved' },
    watermark: { updated_at: '2026-04-24T00:00:00Z' },
    options: {
      query: {
        limit: 999999,
        cursor: 'evil-cursor',
        vendorFlag: 'yes',
      },
    },
  })
  const guardedReadCall = calls.filter((call) => call.pathname === '/api/materials' && call.options.method === 'GET').at(-1)
  assert.equal(guardedReadCall.searchParams.limit, '10000', 'options.query cannot override normalized MAX_READ_LIMIT cap')
  assert.equal(guardedReadCall.searchParams.cursor, 'safe-cursor', 'options.query cannot override normalized cursor')
  assert.equal(guardedReadCall.searchParams.vendorFlag, 'yes', 'non-reserved vendor query options still pass through')

  // --- 4. upsert() posts normalized records and parses counts -----------
  const upsert = await adapter.upsert({
    object: 'materials',
    records: [
      { code: 'A-01', name: 'Bolt' },
      { code: 'B-02', name: 'Nut' },
    ],
    keyFields: ['code'],
  })
  assert.equal(upsert.written, 2)
  assert.equal(upsert.failed, 0)
  assert.equal(upsert.results[0].externalId, 'k3_1')
  const upsertCall = calls.find((call) => call.pathname === '/api/materials/batch' && call.options.method === 'POST')
  assert.deepEqual(upsertCall.body.keyFields, ['code'])
  assert.deepEqual(upsertCall.body.records.map((record) => record.code), ['A-01', 'B-02'])

  // --- 5. Unsupported and invalid configs fail with typed errors --------
  let unsupported = null
  try {
    await adapter.upsert({ object: 'read_only', records: [{ code: 'A-01' }] })
  } catch (error) {
    unsupported = error
  }
  assert.ok(unsupported instanceof UnsupportedAdapterOperationError, 'read-only object rejects upsert')

  let invalidConfig = null
  try {
    createHttpAdapter({
      system: createSystem({
        config: {
          baseUrl: 'file:///tmp/nope',
          objects: {},
        },
      }),
      fetchImpl,
    })
  } catch (error) {
    invalidConfig = error
  }
  assert.ok(invalidConfig instanceof AdapterValidationError, 'non-http baseUrl rejected')

  const unsafePaths = [
    { label: 'absolute http path', healthPath: 'https://evil.example.test/health' },
    { label: 'protocol-relative path', healthPath: '//evil.example.test/health' },
    { label: 'non-http scheme path', healthPath: 'file:///tmp/health' },
    { label: 'backslash path', healthPath: '\\\\evil.example.test\\health' },
    { label: 'control-character path', healthPath: '/health\nX-Injected: yes' },
  ]
  for (const { label, healthPath } of unsafePaths) {
    const beforeCalls = calls.length
    const unsafeAdapter = createHttpAdapter({
      system: createSystem({
        config: {
          ...createSystem().config,
          healthPath,
        },
      }),
      fetchImpl,
    })
    const unsafe = await unsafeAdapter.testConnection().catch((error) => error)
    assert.equal(unsafe.ok, false, `${label} is rejected by testConnection`)
    assert.equal(unsafe.code, 'HTTP_TEST_FAILED', `${label} reports HTTP_TEST_FAILED`)
    assert.equal(calls.length, beforeCalls, `${label} is rejected before fetch`)
  }

  const unsafeObjectAdapter = createHttpAdapter({
    system: createSystem({
      config: {
        ...createSystem().config,
        objects: {
          unsafe_read: {
            path: '//evil.example.test/materials',
            operations: ['read'],
          },
          unsafe_write: {
            path: '/api/materials',
            upsertPath: 'javascript:alert(1)',
            operations: ['upsert'],
          },
        },
      },
    }),
    fetchImpl,
  })
  const unsafeRead = await unsafeObjectAdapter.read({ object: 'unsafe_read' }).catch((error) => error)
  assert.ok(unsafeRead instanceof AdapterValidationError, 'protocol-relative read path is rejected')
  const unsafeWrite = await unsafeObjectAdapter.upsert({
    object: 'unsafe_write',
    records: [{ code: 'A-01' }],
  }).catch((error) => error)
  assert.ok(unsafeWrite instanceof AdapterValidationError, 'scheme-bearing upsert path is rejected')

  let httpFailure = null
  try {
    await adapter.read({ object: 'failing' })
  } catch (error) {
    httpFailure = error
  }
  assert.ok(httpFailure instanceof HttpAdapterError, 'non-2xx response rejects with HttpAdapterError')
  assert.equal(httpFailure.status, 500)

  const networkFailure = await adapter.upsert({
    object: 'network_sink',
    records: [{ code: 'A-01' }],
    keyFields: ['code'],
  }).catch((error) => error)
  assert.ok(networkFailure instanceof HttpAdapterError, 'fetch-layer failure rejects with HttpAdapterError')
  assert.equal(networkFailure.details.code, 'FETCH_FAILED')
  assert.equal(networkFailure.details.method, 'POST')
  assert.equal(networkFailure.details.path, '/api/network-sink')
  assert.equal(networkFailure.details.causeName, 'TypeError')
  assert.match(networkFailure.message, /HTTP adapter request failed before response: POST \/api\/network-sink/)
  assert.doesNotMatch(
    JSON.stringify({ message: networkFailure.message, details: networkFailure.details }),
    /plm\.example\.test|token-1|key-1/,
    'fetch failure details stay values-free',
  )

  const queryNetworkFailure = await adapter.upsert({
    object: 'network_sink_with_query',
    records: [{ code: 'A-01' }],
    keyFields: ['code'],
  }).catch((error) => error)
  assert.ok(queryNetworkFailure instanceof HttpAdapterError, 'query-bearing path still reaches fetch')
  assert.equal(queryNetworkFailure.details.code, 'FETCH_FAILED')
  assert.equal(queryNetworkFailure.details.path, '/api/network-sink')
  assert.doesNotMatch(
    JSON.stringify({ message: queryNetworkFailure.message, details: queryNetworkFailure.details }),
    /raw-secret|#frag|\?/,
    'query-bearing fetch failure diagnostics strip query and fragment',
  )

  const responseReadFailure = await adapter.read({ object: 'body_read_failing' }).catch((error) => error)
  assert.ok(responseReadFailure instanceof HttpAdapterError, 'response body read failure rejects with HttpAdapterError')
  assert.equal(responseReadFailure.details.code, 'RESPONSE_READ_FAILED')
  assert.equal(responseReadFailure.details.status, 200)
  assert.equal(responseReadFailure.details.path, '/api/body-read-fail')
  assert.equal(responseReadFailure.details.causeName, 'TypeError')
  assert.doesNotMatch(
    JSON.stringify({ message: responseReadFailure.message, details: responseReadFailure.details }),
    /raw-secret|socket closed|\?/,
    'response body read failure diagnostics avoid raw cause messages and query values',
  )

  console.log('✓ http-adapter: config-driven read/upsert tests passed')
}

main().catch((err) => {
  console.error('✗ http-adapter FAILED')
  console.error(err)
  process.exit(1)
})
