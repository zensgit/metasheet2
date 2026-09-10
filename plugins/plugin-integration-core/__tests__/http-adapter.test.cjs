'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  AdapterValidationError,
  UnsupportedAdapterOperationError,
} = require(path.join(__dirname, '..', 'lib', 'contracts.cjs'))
const {
  HttpAdapterError,
  createHttpAdapter,
} = require(path.join(__dirname, '..', 'lib', 'adapters', 'http-adapter.cjs'))
const {
  OUTBOUND_HTTP_WRITE_DISABLED,
  OUTBOUND_HTTP_WRITE_TARGETS_ENV,
  OUTBOUND_HTTP_WRITE_TARGET_NOT_AUTHORIZED,
} = require(path.join(__dirname, '..', 'lib', 'outbound-http-write-gate.cjs'))

// W-1(c) CONVERSION, NOT DELETION (#5247 precedent).
//
// Generic outbound HTTP write became default-deny, so every `upsert` leg below would refuse. The
// suite is NOT weakened to match: it now runs under a SYNTHETIC ALLOWLIST that names this suite's
// synthetic system, which keeps every original assertion about the AUTHORIZED write path live —
// counts, body shape, key fields, values-free failure diagnostics — and adds section 6, which
// proves the refusal itself with ZERO outbound calls.
//
// That pairing is the E4-05 lesson applied to a gate rather than a ban: a gate that refuses
// everything would pass a "nothing was written" test while having broken the product. The authorized
// path working is half the proof.
const ALLOWLISTED_WRITE_OBJECTS = Object.freeze([
  'materials',
  'read_only',
  'unsafe_write',
  'network_sink',
  'network_sink_with_query',
])

function writeSyntheticAllowlist() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-outbound-http-write-'))
  const file = path.join(dir, 'outbound-http-write-targets.json')
  fs.writeFileSync(file, JSON.stringify({
    allowlistId: 'http-adapter-suite-synthetic',
    allowlistVersion: 1,
    targets: [{
      entryId: 'suite-http-plm',
      systemId: 'sys_http',
      // Identity matching, never URL matching: the entry never mentions plm.example.test.
      systemName: 'HTTP PLM',
      kind: 'http',
      objects: [...ALLOWLISTED_WRITE_OBJECTS],
    }],
  }, null, 2), 'utf8')
  return file
}

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
        // W-1(c): configured for write, deliberately ABSENT from the synthetic allowlist. Proves
        // the object scope is enforced and not decoration — same system, same credentials, same
        // reachable endpoint, refused because the file does not name this object.
        unlisted_write: {
          upsertPath: '/api/materials/batch',
          operations: ['upsert'],
        },
      },
    },
    ...overrides,
  }
}

async function main() {
  // --- 0. DEFAULT POSTURE: env unset => every write refused, ZERO outbound calls ---
  // Runs FIRST, before the allowlist is installed, so it observes the real default rather than a
  // state this suite manufactured by deleting something.
  {
    delete process.env[OUTBOUND_HTTP_WRITE_TARGETS_ENV]
    const { calls: deniedCalls, fetchImpl: deniedFetch } = createFetchMock()
    const deniedAdapter = createHttpAdapter({ system: createSystem(), fetchImpl: deniedFetch })

    const refusal = await deniedAdapter.upsert({
      object: 'materials',
      records: [{ code: 'A-01', name: 'Bolt' }],
      keyFields: ['code'],
    }).catch((error) => error)
    assert.ok(refusal instanceof HttpAdapterError, 'unset env refuses the write')
    assert.equal(refusal.code, OUTBOUND_HTTP_WRITE_DISABLED, 'fixed refusal code')
    assert.equal(refusal.details.code, OUTBOUND_HTTP_WRITE_DISABLED, 'code also rides details')
    assert.equal(refusal.status, 403, 'a refused caller cannot fix this by editing the request')
    assert.equal(deniedCalls.length, 0, 'ZERO outbound calls when the capability is unauthorized')
    assert.doesNotMatch(
      JSON.stringify({ message: refusal.message, details: refusal.details, code: refusal.code }),
      /plm\.example\.test|token-1|key-1|\/api\//,
      'the refusal names no host, credential or path',
    )

    // READ is untouched by the gate — the E4-05 control. A blanket deny that also killed the read
    // leg would be a FAIL, not a pass.
    const stillReads = await deniedAdapter.read({ object: 'materials', limit: 5 })
    assert.equal(stillReads.records.length, 2, 'read still works with the write capability disabled')
    assert.equal(deniedCalls.length, 1, 'the read is the only call that reached fetch')
    // So do listObjects/getSchema/testConnection: all GET-or-local, none body-bearing.
    assert.deepEqual((await deniedAdapter.testConnection()), { ok: true, status: 200 }, 'health probe unaffected')
    assert.equal((await deniedAdapter.getSchema({ object: 'materials' })).object, 'materials', 'schema unaffected')
    assert.equal((await deniedAdapter.listObjects()).length > 0, true, 'listObjects unaffected')
  }

  // From here on the suite runs AUTHORIZED, so every original assertion about the write path stays
  // live rather than being deleted.
  process.env[OUTBOUND_HTTP_WRITE_TARGETS_ENV] = writeSyntheticAllowlist()

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

  // --- 6. W-1(c) OUTBOUND WRITE GATE, with the allowlist INSTALLED --------
  // Section 0 proved the unset default. These legs prove the gate still discriminates while it is
  // armed — the property that separates an authorization gate from a blanket deny.
  {
    const before = calls.length

    // 6a. OBJECT SCOPE. Same system, same allowlist, an object the file does not enumerate.
    const outOfScope = await adapter.upsert({
      object: 'unlisted_write',
      records: [{ code: 'A-01' }],
      keyFields: ['code'],
    }).catch((error) => error)
    assert.ok(outOfScope instanceof HttpAdapterError, 'an unlisted object is refused')
    assert.equal(outOfScope.code, OUTBOUND_HTTP_WRITE_TARGET_NOT_AUTHORIZED,
      'an armed gate reports a DISTINCT code from the unset one, so an operator can tell them apart')
    assert.equal(calls.length, before, 'ZERO outbound calls for an out-of-scope object')

    // 6b. SYSTEM IDENTITY. A different system id, everything else identical — including the
    // baseUrl, which the allowlist deliberately does not match on.
    const { calls: otherCalls, fetchImpl: otherFetch } = createFetchMock()
    const otherAdapter = createHttpAdapter({
      system: createSystem({ id: 'sys_http_other' }),
      fetchImpl: otherFetch,
    })
    const otherRefusal = await otherAdapter.upsert({
      object: 'materials',
      records: [{ code: 'A-01' }],
      keyFields: ['code'],
    }).catch((error) => error)
    assert.equal(otherRefusal.code, OUTBOUND_HTTP_WRITE_TARGET_NOT_AUTHORIZED,
      'an unlisted system is refused even though its URL is the authorized one')
    assert.equal(otherCalls.length, 0, 'ZERO outbound calls for an unlisted system')

    // 6c. THE TRANSPORT LAYER (enforcement point 1b). `testConnection` takes its method and path
    // straight off an authenticated request body in http-routes.cjs `externalSystemsTest`, so a
    // request-steered DELETE is a generic outbound write that never goes near `upsert`. The
    // allowlist entry above authorizes the `upsert` entry point only, so this is refused.
    const steered = await adapter.testConnection({ method: 'DELETE', path: '/api/materials/A-01' })
    assert.equal(steered.ok, false, 'a request-steered non-safe method is refused')
    assert.equal(steered.code, OUTBOUND_HTTP_WRITE_TARGET_NOT_AUTHORIZED,
      'armed, but this entry authorizes the `upsert` entry point only, not a request-steered verb')
    assert.doesNotMatch(String(steered.message), /plm\.example\.test|token-1|key-1|A-01/,
      'the surfaced refusal message stays values-free')
    assert.equal(calls.length, before, 'ZERO outbound calls for a request-steered verb')

    // 6d. DISCRIMINATING CONTROL. The same probe with a SAFE method still works, so 6c is
    // attributable to the verb and not to testConnection being broken.
    assert.deepEqual(await adapter.testConnection(), { ok: true, status: 200 }, 'GET health probe still works')
    assert.equal(calls.length, before + 1, 'the safe probe is the only call that reached fetch')
  }

  console.log('✓ http-adapter: config-driven read/upsert tests passed')
}

main().catch((err) => {
  console.error('✗ http-adapter FAILED')
  console.error(err)
  process.exit(1)
})
