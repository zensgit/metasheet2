'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const {
  AdapterValidationError,
  UnsupportedAdapterOperationError,
} = require(path.join(__dirname, '..', 'lib', 'contracts.cjs'))
const {
  __internals: webApiInternals,
  K3WiseWebApiAdapterError,
  createK3WiseWebApiAdapter,
} = require(path.join(__dirname, '..', 'lib', 'adapters', 'k3-wise-webapi-adapter.cjs'))
const {
  createK3WiseSqlServerChannel,
} = require(path.join(__dirname, '..', 'lib', 'adapters', 'k3-wise-sqlserver-channel.cjs'))

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return headers[String(name).toLowerCase()] || null
      },
    },
    async text() {
      return JSON.stringify(body)
    },
  }
}

function createK3FetchMock() {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url)
    const body = options.body ? JSON.parse(options.body) : undefined
    calls.push({
      pathname: parsed.pathname,
      options,
      body,
    })

    if (parsed.pathname === '/K3API/Login') {
      return jsonResponse(200, { success: true, sessionId: 'k3-session-1' })
    }
    if (parsed.pathname === '/K3API/Health') {
      return jsonResponse(200, { ok: true })
    }
    if (parsed.pathname === '/K3API/Material/Save') {
      if (body.Model.FNumber === 'BAD') {
        return jsonResponse(200, { success: false, message: 'invalid material' })
      }
      return jsonResponse(200, { success: true, externalId: `item-${body.Model.FNumber}`, billNo: body.Model.FNumber })
    }
    if (parsed.pathname === '/K3API/Material/Submit') {
      return jsonResponse(200, { success: true, submitted: body.Number })
    }
    if (parsed.pathname === '/K3API/Material/Audit') {
      return jsonResponse(200, { success: true, audited: body.Number })
    }
    return jsonResponse(404, { success: false, message: 'not found' })
  }
  return { calls, fetchImpl }
}

function createK3WebApiSystem(overrides = {}) {
  return {
    id: 'k3_webapi_1',
    name: 'K3 WISE WebAPI',
    kind: 'erp:k3-wise-webapi',
    role: 'target',
    credentials: {
      username: 'demo',
      password: 'secret',
      acctId: '001',
    },
    config: {
      baseUrl: 'https://k3.example.test',
      healthPath: '/K3API/Health',
      autoSubmit: true,
      autoAudit: true,
    },
    ...overrides,
  }
}

function createSqlSystem(config = {}) {
  return {
    id: 'k3_sql_1',
    name: 'K3 WISE SQL Server',
    kind: 'erp:k3-wise-sqlserver',
    role: 'bidirectional',
    config: {
      allowedTables: [
        'dbo.t_ICItem',
        'dbo.integration_material_stage',
      ],
      objects: {
        material: {
          table: 'dbo.t_ICItem',
          operations: ['read'],
          columns: ['FItemID', 'FNumber', 'FName'],
          keyField: 'FNumber',
        },
        material_stage: {
          table: 'dbo.integration_material_stage',
          operations: ['upsert'],
          writeMode: 'middle-table',
          keyField: 'FNumber',
          schema: [
            { name: 'FNumber', type: 'string', required: true },
            { name: 'FName', type: 'string' },
          ],
        },
      },
      ...config,
    },
  }
}

async function testK3WebApiAdapter() {
  const { calls, fetchImpl } = createK3FetchMock()
  const adapter = createK3WiseWebApiAdapter({
    system: createK3WebApiSystem(),
    fetchImpl,
  })

  const connection = await adapter.testConnection()
  assert.equal(connection.ok, true, 'K3 WebAPI testConnection succeeds')
  assert.equal(connection.authenticated, true, 'K3 WebAPI uses credential login')
  assert.deepEqual(calls.map((call) => call.pathname), ['/K3API/Login', '/K3API/Health'])

  const objects = await adapter.listObjects()
  assert.deepEqual(objects.map((object) => object.name), ['material', 'bom'])
  const materialSchema = await adapter.getSchema({ object: 'material' })
  assert.deepEqual(materialSchema.fields.map((field) => field.name).slice(0, 2), ['FNumber', 'FName'])

  const upsert = await adapter.upsert({
    object: 'material',
    records: [
      { FNumber: 'MAT-001', FName: 'Bolt' },
      { FNumber: 'BAD', FName: 'Broken' },
    ],
    keyFields: ['FNumber'],
  })
  assert.equal(upsert.written, 1)
  assert.equal(upsert.failed, 1)
  assert.equal(upsert.results[0].key, 'MAT-001')
  assert.equal(upsert.results[0].externalId, 'item-MAT-001')
  assert.equal(upsert.results[0].billNo, 'MAT-001')
  assert.equal(upsert.results[0].responseMessage, 'K3 WISE save succeeded')
  assert.equal(upsert.errors[0].code, 'K3_WISE_SAVE_FAILED')
  assert.equal(upsert.metadata.autoSubmit, true)
  assert.equal(upsert.metadata.autoAudit, true)

  const saveCalls = calls.filter((call) => call.pathname === '/K3API/Material/Save')
  const submitCalls = calls.filter((call) => call.pathname === '/K3API/Material/Submit')
  const auditCalls = calls.filter((call) => call.pathname === '/K3API/Material/Audit')
  assert.equal(saveCalls.length, 2)
  assert.equal(submitCalls.length, 1, 'submit runs only after successful save')
  assert.equal(auditCalls.length, 1, 'audit runs only after successful save')
  assert.equal(saveCalls[0].options.headers['X-K3-Session'], 'k3-session-1')
  assert.deepEqual(saveCalls[0].body, { Model: { FNumber: 'MAT-001', FName: 'Bolt' } })
  assert.deepEqual(submitCalls[0].body, { Number: 'MAT-001' })

  const targetOnlyRead = await adapter.read({ object: 'material' }).catch((error) => error)
  assert.ok(targetOnlyRead instanceof UnsupportedAdapterOperationError, 'K3 WebAPI target rejects read')

  const failingLogin = createK3WiseWebApiAdapter({
    system: createK3WebApiSystem({
      config: {
        baseUrl: 'https://k3.example.test',
        loginPath: '/missing-login',
      },
    }),
    fetchImpl,
  })
  const failedConnection = await failingLogin.testConnection({ skipHealth: true })
  assert.equal(failedConnection.ok, false, 'failed login reports test failure')
  assert.equal(failedConnection.code, 'K3_WISE_TEST_FAILED')

  const configCredentials = createK3WiseWebApiAdapter({
    system: createK3WebApiSystem({
      credentials: {},
      config: {
        baseUrl: 'https://k3.example.test',
        username: 'config-user',
        password: 'config-secret',
      },
    }),
    fetchImpl,
  })
  const unauthenticated = await configCredentials.testConnection({ skipHealth: true })
  assert.equal(unauthenticated.ok, false)
  assert.equal(unauthenticated.code, 'K3_WISE_CREDENTIALS_MISSING')

  const missingAcctId = createK3WiseWebApiAdapter({
    system: createK3WebApiSystem({
      credentials: {
        username: 'demo',
        password: 'secret',
      },
    }),
    fetchImpl,
  })
  const missingAcctIdStatus = await missingAcctId.testConnection({ skipHealth: true })
  assert.equal(missingAcctIdStatus.ok, false)
  assert.equal(missingAcctIdStatus.code, 'K3_WISE_CREDENTIALS_MISSING')
  assert.match(missingAcctIdStatus.message, /acctId/)

  const loginWithoutAuthTransportCalls = []
  const loginWithoutAuthTransport = createK3WiseWebApiAdapter({
    system: createK3WebApiSystem(),
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url)
      loginWithoutAuthTransportCalls.push({ pathname: parsed.pathname, options })
      if (parsed.pathname === '/K3API/Login') {
        return jsonResponse(200, { success: true })
      }
      return jsonResponse(200, { ok: true })
    },
  })
  const missingAuthTransportStatus = await loginWithoutAuthTransport.testConnection({ skipHealth: true })
  assert.equal(missingAuthTransportStatus.ok, false)
  assert.equal(missingAuthTransportStatus.code, 'K3_WISE_AUTH_TRANSPORT_MISSING')
  assert.match(missingAuthTransportStatus.message, /session cookie or session id/)
  assert.deepEqual(
    loginWithoutAuthTransportCalls.map((call) => call.pathname),
    ['/K3API/Login'],
    'missing auth transport fails at login and does not continue to health checks',
  )

  assert.equal(webApiInternals.businessSuccess({ success: true }, {}), true)
  assert.equal(webApiInternals.businessSuccess({ Result: { ResponseStatus: { IsSuccess: true } } }, {}), true)
  assert.equal(webApiInternals.businessSuccess({ Result: { ResponseStatus: { IsSuccess: false } } }, {}), false)
  assert.equal(webApiInternals.businessSuccess({ id: 'silent-success' }, {}), false)

  const invalidBaseUrl = (() => {
    try {
      createK3WiseWebApiAdapter({
        system: createK3WebApiSystem({ config: { baseUrl: 'file:///tmp/k3' } }),
        fetchImpl,
      })
      return null
    } catch (error) {
      return error
    }
  })()
  assert.ok(invalidBaseUrl instanceof AdapterValidationError, 'non-http K3 baseUrl rejected')

  assert.equal(K3WiseWebApiAdapterError.name, 'K3WiseWebApiAdapterError')
}

async function testK3SqlServerChannel() {
  const executorCalls = []
  const queryExecutor = {
    async testConnection() {
      executorCalls.push({ method: 'testConnection' })
      return { ok: true, version: 'SQL Server mock' }
    },
    async select(input) {
      executorCalls.push({ method: 'select', input })
      return {
        records: [
          { FItemID: 1, FNumber: 'MAT-001', FName: 'Bolt' },
        ],
        nextCursor: null,
      }
    },
    async insertMany(input) {
      executorCalls.push({ method: 'insertMany', input })
      return {
        written: input.records.length,
        failed: 0,
        results: input.records.map((record, index) => ({ index, key: record.FNumber, status: 'staged' })),
      }
    },
  }

  const adapter = createK3WiseSqlServerChannel({
    system: createSqlSystem(),
    queryExecutor,
  })

  const connection = await adapter.testConnection()
  assert.equal(connection.ok, true)

  const objects = await adapter.listObjects()
  assert.ok(objects.some((object) => object.name === 'material'))
  assert.ok(objects.some((object) => object.name === 'material_stage'))

  const schema = await adapter.getSchema({ object: 'material_stage' })
  assert.equal(schema.table, 'dbo.integration_material_stage')

  const read = await adapter.read({
    object: 'material',
    limit: 10,
    filters: { FUseStatus: '1' },
  })
  assert.equal(read.records.length, 1)
  assert.equal(read.metadata.table, 'dbo.t_ICItem')
  const selectCall = executorCalls.find((call) => call.method === 'select')
  assert.deepEqual(selectCall.input.columns, ['FItemID', 'FNumber', 'FName'])
  assert.deepEqual(selectCall.input.filters, { FUseStatus: '1' })

  const staged = await adapter.upsert({
    object: 'material_stage',
    records: [
      { FNumber: 'MAT-002', FName: 'Nut' },
    ],
    keyFields: ['FNumber'],
  })
  assert.equal(staged.written, 1)
  assert.equal(staged.metadata.mode, 'sqlserver-middle-table')
  const insertCall = executorCalls.find((call) => call.method === 'insertMany')
  assert.equal(insertCall.input.table, 'dbo.integration_material_stage')

  const directWriteAdapter = createK3WiseSqlServerChannel({
    system: createSqlSystem({
      objects: {
        material: {
          table: 'dbo.t_ICItem',
          operations: ['read', 'upsert'],
          keyField: 'FNumber',
        },
      },
    }),
    queryExecutor,
  })
  const directWrite = await directWriteAdapter.upsert({
    object: 'material',
    records: [{ FNumber: 'MAT-003' }],
  }).catch((error) => error)
  assert.ok(directWrite instanceof UnsupportedAdapterOperationError, 'direct K3 table write is blocked')

  const missingExecutor = createK3WiseSqlServerChannel({ system: createSqlSystem() })
  const missingExecutorStatus = await missingExecutor.testConnection()
  assert.equal(missingExecutorStatus.ok, false)
  assert.equal(missingExecutorStatus.code, 'SQLSERVER_EXECUTOR_MISSING')

  const disallowed = createK3WiseSqlServerChannel({
    system: createSqlSystem({
      allowedTables: ['dbo.integration_material_stage'],
      objects: {
        material: {
          table: 'dbo.t_ICItem',
          operations: ['read'],
        },
      },
    }),
    queryExecutor,
  })
  const disallowedRead = await disallowed.read({ object: 'material' }).catch((error) => error)
  assert.ok(disallowedRead instanceof AdapterValidationError, 'read table must be allowlisted')

  const rawIdentifier = (() => {
    try {
      createK3WiseSqlServerChannel({
        system: createSqlSystem({
          allowedTables: ['dbo.t_ICItem;DROP TABLE users'],
        }),
        queryExecutor,
      })
      return null
    } catch (error) {
      return error
    }
  })()
  assert.ok(rawIdentifier instanceof AdapterValidationError, 'raw SQL-like identifiers are rejected')
}

async function testK3WebApiAutoFlagCoercion() {
  // ----- helper: build adapter with custom autoSubmit/autoAudit config -----
  function buildAdapter(systemConfigOverrides) {
    const { calls, fetchImpl } = createK3FetchMock()
    const system = createK3WebApiSystem({
      config: {
        baseUrl: 'https://k3.example.test',
        healthPath: '/K3API/Health',
        ...systemConfigOverrides,
      },
    })
    const adapter = createK3WiseWebApiAdapter({ system, fetchImpl })
    return { adapter, calls }
  }

  async function upsertOne(adapter, options = {}) {
    return adapter.upsert({
      object: 'material',
      records: [{ FNumber: 'MAT-COERCE-001', FName: 'Coercion test bolt' }],
      keyFields: ['FNumber'],
      options,
    })
  }

  // ----- Scenario A: hand-edited string "true" config respects intent -----
  {
    const { adapter } = buildAdapter({ autoSubmit: 'true', autoAudit: '是' })
    const upsert = await upsertOne(adapter)
    assert.equal(upsert.metadata.autoSubmit, true, 'config.autoSubmit="true" → resolved as true')
    assert.equal(upsert.metadata.autoAudit, true, 'config.autoAudit="是" → resolved as true')
  }

  // ----- Scenario B: numeric 1 / 0 in config (spreadsheet booleans) -----
  {
    const { adapter } = buildAdapter({ autoSubmit: 1, autoAudit: 0 })
    const upsert = await upsertOne(adapter)
    assert.equal(upsert.metadata.autoSubmit, true, 'config.autoSubmit=1 → true')
    assert.equal(upsert.metadata.autoAudit, false, 'config.autoAudit=0 → false')
  }

  // ----- Scenario C: HEADLINE FIX — request override "false" disables config truthy -----
  {
    const { adapter, calls } = buildAdapter({ autoSubmit: true, autoAudit: true })
    const upsert = await upsertOne(adapter, { autoSubmit: 'false', autoAudit: '否' })
    assert.equal(upsert.metadata.autoSubmit, false, 'request.options.autoSubmit="false" overrides config true')
    assert.equal(upsert.metadata.autoAudit, false, 'request.options.autoAudit="否" overrides config true')
    const submitCalls = calls.filter((call) => call.pathname === '/K3API/Material/Submit')
    const auditCalls = calls.filter((call) => call.pathname === '/K3API/Material/Audit')
    assert.equal(submitCalls.length, 0, 'Submit must NOT fire when operator hand-edited "false"')
    assert.equal(auditCalls.length, 0, 'Audit must NOT fire when operator hand-edited "否"')
  }

  // ----- Scenario D: request override "true" enables when config is false -----
  {
    const { adapter } = buildAdapter({ autoSubmit: false, autoAudit: false })
    const upsert = await upsertOne(adapter, { autoSubmit: 'true', autoAudit: 1 })
    assert.equal(upsert.metadata.autoSubmit, true, 'request.options.autoSubmit="true" overrides config false')
    assert.equal(upsert.metadata.autoAudit, true, 'request.options.autoAudit=1 overrides config false')
  }

  // ----- Scenario E: request unset, config drives (positive) -----
  {
    const { adapter } = buildAdapter({ autoSubmit: true, autoAudit: false })
    const upsert = await upsertOne(adapter, {})
    assert.equal(upsert.metadata.autoSubmit, true, 'unset request + config true → true')
    assert.equal(upsert.metadata.autoAudit, false, 'unset request + config false → false')
  }

  // ----- Scenario F: both unset → default safe (false) -----
  {
    const { adapter } = buildAdapter({})
    const upsert = await upsertOne(adapter, {})
    assert.equal(upsert.metadata.autoSubmit, false, 'unset request + unset config → false (default safe)')
    assert.equal(upsert.metadata.autoAudit, false, 'unset request + unset config → false (default safe)')
  }

  // ----- Scenario G: empty string treated as unset (falls through to config) -----
  {
    const { adapter } = buildAdapter({ autoSubmit: true })
    const upsert = await upsertOne(adapter, { autoSubmit: '' })
    assert.equal(upsert.metadata.autoSubmit, true, 'empty-string request → falls back to config (true)')
  }

  // ----- Scenario H: invalid value throws AdapterValidationError with field name -----
  {
    const { adapter } = buildAdapter({ autoSubmit: 'maybe' })
    let threw = null
    try {
      await upsertOne(adapter)
    } catch (error) {
      threw = error
    }
    assert.ok(threw instanceof AdapterValidationError, 'unknown string boolean should throw AdapterValidationError')
    assert.ok(/autoSubmit/.test(threw.message), 'error message includes field name autoSubmit')
  }

  // ----- Scenario I: NaN / non-finite number throws -----
  {
    const { adapter } = buildAdapter({ autoSubmit: NaN })
    let threw = null
    try {
      await upsertOne(adapter)
    } catch (error) {
      threw = error
    }
    assert.ok(threw instanceof AdapterValidationError, 'NaN config should throw AdapterValidationError')
    assert.ok(/finite/.test(threw.message), 'error message mentions "finite"')
  }

  // ----- Scenario J: number 2 (not 0/1) throws -----
  {
    const { adapter } = buildAdapter({ autoSubmit: 2 })
    let threw = null
    try {
      await upsertOne(adapter)
    } catch (error) {
      threw = error
    }
    assert.ok(threw instanceof AdapterValidationError, 'numeric 2 should throw')
    assert.ok(/0 or 1/.test(threw.message), 'error message mentions "0 or 1"')
  }
}

async function main() {
  await testK3WebApiAdapter()
  await testK3SqlServerChannel()
  await testK3WebApiAutoFlagCoercion()
  console.log('✓ k3-wise-adapters: WebAPI, SQL Server channel, and auto-flag coercion tests passed')
}

main().catch((err) => {
  console.error('✗ k3-wise-adapters FAILED')
  console.error(err)
  process.exit(1)
})
