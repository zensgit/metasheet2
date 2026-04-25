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
  assert.equal(objects.length, 3)
  assert.deepEqual(objects.find((object) => object.name === 'materials').operations, ['read', 'upsert'])

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

  let httpFailure = null
  try {
    await adapter.read({ object: 'failing' })
  } catch (error) {
    httpFailure = error
  }
  assert.ok(httpFailure instanceof HttpAdapterError, 'non-2xx response rejects with HttpAdapterError')
  assert.equal(httpFailure.status, 500)

  console.log('✓ http-adapter: config-driven read/upsert tests passed')
}

main().catch((err) => {
  console.error('✗ http-adapter FAILED')
  console.error(err)
  process.exit(1)
})
