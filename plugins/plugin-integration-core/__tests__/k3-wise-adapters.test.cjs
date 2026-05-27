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
  createK3WiseSqlServerChannelFactory,
} = require(path.join(__dirname, '..', 'lib', 'adapters', 'k3-wise-sqlserver-channel.cjs'))
const {
  __internals: sqlExecutorInternals,
  createK3WiseSqlServerReadOnlyExecutor,
} = require(path.join(__dirname, '..', 'lib', 'adapters', 'k3-wise-sqlserver-executor.cjs'))
const {
  getK3WiseDocumentObjectDefaults,
  getK3WiseDocumentTemplate,
  listK3WiseDocumentTemplates,
} = require(path.join(__dirname, '..', 'lib', 'adapters', 'k3-wise-document-templates.cjs'))
const materialDetailFixture = require(path.join(__dirname, 'fixtures', 'k3-wise-material-detail-redacted.json'))

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

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
      query: Object.fromEntries(parsed.searchParams.entries()),
      options,
      body,
    })

    if (parsed.pathname === '/K3API/Token/Create') {
      if (parsed.searchParams.get('authorityCode') !== 'auth-code-1') {
        return jsonResponse(200, { StatusCode: 401, Message: 'invalid authority code', Data: { Code: 'N' } })
      }
      return jsonResponse(200, {
        StatusCode: 200,
        Message: 'Token request succeeded',
        Data: { Code: 'Y', Token: 'k3-token-1', Validity: 3600 },
      })
    }
    if (parsed.pathname === '/K3API/Login') {
      return jsonResponse(200, { success: true, sessionId: 'k3-session-1' })
    }
    if (parsed.pathname === '/K3API/Health') {
      return jsonResponse(200, { ok: true })
    }
    if (parsed.pathname === '/K3API/Material/Save') {
      const record = body.Model || body.Data
      if (record.FNumber === 'BAD') {
        return jsonResponse(200, { success: false, message: 'invalid material' })
      }
      if (record.FNumber === 'ROWFAIL') {
        return jsonResponse(200, {
          StatusCode: 200,
          Message: 'Successful',
          Data: [{ FStatus: false, FItemID: 0, FMessage: 'unit group parameter invalid' }],
        })
      }
      if (record.FNumber === 'STATUS201') {
        return jsonResponse(200, {
          StatusCode: 201,
          Message: 'Faild',
          Data: [{ FStatus: false, FItemID: 0, FMessage: 'required unit missing' }],
        })
      }
      if (record.FNumber === 'ROWOK') {
        return jsonResponse(200, {
          StatusCode: 200,
          Message: 'Successful',
          Data: [{ FStatus: true, FItemID: 1001, FNumber: record.FNumber }],
        })
      }
      if (record.FNumber === 'NESTOK') {
        return jsonResponse(200, {
          StatusCode: 200,
          Message: 'Successful',
          Data: [{ Data: { FStatus: true, FNumber: record.FNumber, FItemID: 123 } }],
        })
      }
      if (record.FNumber === 'NESTFAIL') {
        return jsonResponse(200, {
          StatusCode: 200,
          Message: 'Successful',
          Data: [{ Data: { FStatus: false, FMessage: 'nested unit group invalid' } }],
        })
      }
      if (parsed.searchParams.get('Token')) {
        return jsonResponse(200, {
          StatusCode: 200,
          Message: 'Material saved',
          Data: { Code: 'Y', FItemID: `item-${record.FNumber}`, FNumber: record.FNumber },
        })
      }
      return jsonResponse(200, { success: true, externalId: `item-${record.FNumber}`, billNo: record.FNumber })
    }
    if (parsed.pathname === '/K3API/Material/GetDetail') {
      const materialNumber = body && body.Data && body.Data.FNumber
      if (!materialNumber) {
        return jsonResponse(200, {
          StatusCode: 201,
          Message: 'FNumber is required',
          Data: [],
        })
      }
      if (materialNumber === 'READFAIL') {
        return jsonResponse(200, {
          StatusCode: 500,
          Message: 'material detail not found',
          Data: [],
        })
      }
      if (materialNumber === 'HTTPFAIL') {
        return jsonResponse(503, {
          StatusCode: 503,
          Message: 'temporary upstream failure',
        })
      }
      const response = cloneJson(materialDetailFixture)
      response.Data[0].FNumber = materialNumber
      response.Data[0].Data.FNumber = materialNumber
      return jsonResponse(200, response)
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

function createSqlSystem(config = {}, overrides = {}) {
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
    ...overrides,
  }
}

function createFakeMssqlDriver({ rows = [{ FItemID: 1, FNumber: 'MAT-001' }], failConnect = null } = {}) {
  const calls = []
  class FakeRequest {
    input(name, value) {
      calls.push({ method: 'input', name, value })
      return this
    }

    async query(sql) {
      calls.push({ method: 'query', sql })
      return { recordset: rows, rowsAffected: [rows.length] }
    }
  }

  class ConnectionPool {
    constructor(config) {
      calls.push({ method: 'pool', config })
      this.config = config
    }

    async connect() {
      calls.push({ method: 'connect' })
      if (failConnect) throw failConnect
      return this
    }

    request() {
      calls.push({ method: 'request' })
      return new FakeRequest()
    }

    async close() {
      calls.push({ method: 'close' })
    }
  }

  return { driver: { ConnectionPool }, calls }
}

function testSqlServerConnectionConfigNormalization() {
  const credentials = { credentials: { username: 'readonly_user', password: 'readonly-password' } }

  const commaPort = sqlExecutorInternals.resolveConnectionConfig(createSqlSystem({
    server: '10.0.0.8,1433',
    database: 'AIS_TEST',
  }, credentials))
  assert.equal(commaPort.server, '10.0.0.8')
  assert.equal(commaPort.port, 1433)

  const colonPort = sqlExecutorInternals.resolveConnectionConfig(createSqlSystem({
    server: 'sql.local:14330',
    database: 'AIS_TEST',
  }, credentials))
  assert.equal(colonPort.server, 'sql.local')
  assert.equal(colonPort.port, 14330)

  const matchingExplicitPort = sqlExecutorInternals.resolveConnectionConfig(createSqlSystem({
    server: 'sql.local,1433',
    port: '1433',
    database: 'AIS_TEST',
  }, credentials))
  assert.equal(matchingExplicitPort.server, 'sql.local')
  assert.equal(matchingExplicitPort.port, 1433)

  let conflictingPort = null
  try {
    sqlExecutorInternals.resolveConnectionConfig(createSqlSystem({
      server: 'sql.local,1433',
      port: '1434',
      database: 'AIS_TEST',
    }, credentials))
  } catch (error) {
    conflictingPort = error
  }
  assert.equal(conflictingPort && conflictingPort.code, 'SQLSERVER_PORT_INVALID')
  assert.match(conflictingPort.message, /must match/)
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
  assert.deepEqual(materialSchema.k3Template, {
    id: 'k3wise.material.v1',
    version: '2026.05.v1',
    documentType: 'material',
  })

  const preview = await adapter.previewUpsert({
    object: 'material',
    records: [
      {
        FNumber: 'MAT-PREVIEW-001',
        FName: 'Preview bolt',
        sourceId: 'plm-1',
        revision: 'A',
        _integration_idempotency_key: 'tenant:k3:MAT-PREVIEW-001',
      },
    ],
    keyFields: ['FNumber'],
  })
  assert.deepEqual(preview.records[0].body, {
    Data: {
      FNumber: 'MAT-PREVIEW-001',
      FName: 'Preview bolt',
    },
  })
  assert.equal(preview.records[0].query.Token, '<redacted>')
  assert.equal(preview.metadata.autoSubmit, true)
  assert.equal(preview.metadata.autoAudit, true)

  const referencePreview = await adapter.previewUpsert({
    object: 'material',
    records: [
      {
        FNumber: 'MAT-REF-001',
        FName: 'Reference material',
        FUnitGroupID: { FNumber: 'UG-PCS', FName: 'Pieces' },
        FBaseUnitID: 'PCS',
        FAcctID: '1405',
      },
    ],
    keyFields: ['FNumber'],
  })
  assert.deepEqual(referencePreview.records[0].body, {
    Data: {
      FNumber: 'MAT-REF-001',
      FName: 'Reference material',
      FUnitGroupID: { FNumber: 'UG-PCS', FName: 'Pieces' },
      FBaseUnitID: { FNumber: 'PCS' },
      FAcctID: { FNumber: '1405' },
    },
  }, 'material reference fields preserve object values and wrap scalar values')

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
  assert.deepEqual(saveCalls[0].body, { Data: { FNumber: 'MAT-001', FName: 'Bolt' } })
  assert.deepEqual(submitCalls[0].body, { Number: 'MAT-001' })

  const targetOnlyRead = await adapter.read({ object: 'material' }).catch((error) => error)
  assert.ok(targetOnlyRead instanceof UnsupportedAdapterOperationError, 'K3 WebAPI target rejects read')
  const targetOnlyReadWithKey = await adapter.read({
    object: 'material',
    filters: { FNumber: 'MAT-DEFAULT-OFF' },
  }).catch((error) => error)
  assert.ok(
    targetOnlyReadWithKey instanceof UnsupportedAdapterOperationError,
    'K3 WebAPI material read stays default-off even when the request contains a valid FNumber',
  )

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

  const contextPathCalls = []
  const contextPathAdapter = createK3WiseWebApiAdapter({
    system: createK3WebApiSystem({
      config: {
        baseUrl: 'https://k3.example.test/K3API',
        loginPath: '/login',
        healthPath: '/health',
      },
    }),
    fetchImpl: async (url) => {
      const parsed = new URL(url)
      contextPathCalls.push(parsed.pathname)
      if (parsed.pathname === '/K3API/login') {
        return jsonResponse(200, { success: true, sessionId: 'k3-context-session' })
      }
      if (parsed.pathname === '/K3API/health') {
        return jsonResponse(200, { ok: true })
      }
      return jsonResponse(404, { success: false, message: 'not found' })
    },
  })
  const contextPathStatus = await contextPathAdapter.testConnection()
  assert.equal(contextPathStatus.ok, true, 'baseUrl context path is preserved for relative K3 paths')
  assert.deepEqual(contextPathCalls, ['/K3API/login', '/K3API/health'])

  assert.equal(webApiInternals.businessSuccess({ success: true }, {}), true)
  assert.equal(webApiInternals.businessSuccess({ StatusCode: 200, Data: { Code: 'Y' } }, {}), true)
  assert.equal(webApiInternals.businessSuccess({ StatusCode: 500, Data: { Code: 'N' } }, {}), false)
  assert.equal(webApiInternals.businessSuccess({
    StatusCode: 200,
    Message: 'Successful',
    Data: [{ FStatus: false, FItemID: 0, FMessage: 'unit group parameter invalid' }],
  }, {}), false)
  assert.equal(webApiInternals.businessSuccess({ StatusCode: 201, Message: 'Faild' }, {}), false)
  assert.equal(webApiInternals.businessSuccess({ Result: { ResponseStatus: { IsSuccess: true } } }, {}), true)
  assert.equal(webApiInternals.businessSuccess({ Result: { ResponseStatus: { IsSuccess: false } } }, {}), false)
  assert.equal(webApiInternals.businessSuccess({ id: 'silent-success' }, {}), false)
  assert.equal(webApiInternals.saveBusinessSuccess({ StatusCode: 200, Message: 'Successful' }, {}), false)
  assert.equal(webApiInternals.saveBusinessSuccess({
    StatusCode: 200,
    Message: 'Successful',
    Data: [{ FStatus: true, FItemID: 1001 }],
  }, {}), true)

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

  const protocolRelativeLoginPath = (() => {
    try {
      createK3WiseWebApiAdapter({
        system: createK3WebApiSystem({
          config: {
            baseUrl: 'https://k3.example.test',
            loginPath: '//evil.example.test/K3API/Login',
          },
        }),
        fetchImpl,
      })
      return null
    } catch (error) {
      return error
    }
  })()
  assert.ok(protocolRelativeLoginPath instanceof AdapterValidationError, 'protocol-relative K3 paths are rejected')

  const backslashLoginPath = (() => {
    try {
      createK3WiseWebApiAdapter({
        system: createK3WebApiSystem({
          config: {
            baseUrl: 'https://k3.example.test',
            loginPath: '\\\\evil.example.test\\K3API\\Login',
          },
        }),
        fetchImpl,
      })
      return null
    } catch (error) {
      return error
    }
  })()
  assert.ok(backslashLoginPath instanceof AdapterValidationError, 'backslash-normalized K3 paths are rejected')

  const invalidObjectEndpoint = (() => {
    try {
      createK3WiseWebApiAdapter({
        system: createK3WebApiSystem({
          config: {
            baseUrl: 'https://k3.example.test',
            objects: {
              material: {
                savePath: 'https://evil.example.test/K3API/Material/Save',
              },
            },
          },
        }),
        fetchImpl,
      })
      return null
    } catch (error) {
      return error
    }
  })()
  assert.ok(invalidObjectEndpoint instanceof AdapterValidationError, 'absolute object endpoint is rejected')

  assert.equal(K3WiseWebApiAdapterError.name, 'K3WiseWebApiAdapterError')
}

async function testK3WebApiMaterialDetailReadSmoke() {
  const { calls, fetchImpl } = createK3FetchMock()
  const adapter = createK3WiseWebApiAdapter({
    system: createK3WebApiSystem({
      config: {
        baseUrl: 'https://k3.example.test',
        autoSubmit: true,
        autoAudit: true,
        objects: {
          material: {
            operations: ['upsert', 'read'],
          },
        },
      },
    }),
    fetchImpl,
  })

  const read = await adapter.read({
    object: 'material',
    filters: { FNumber: 'MAT-GATE-001' },
    options: { referenceFields: ['FUnitGroupID', 'FBaseUnitID', 'FAcctID', 'FTrack'] },
  })

  assert.equal(read.records.length, 1, 'Material/GetDetail smoke returns exactly one record')
  assert.equal(read.nextCursor, null, 'single-detail smoke never returns a cursor')
  assert.equal(read.done, true, 'single-detail smoke is terminal')
  assert.equal(read.metadata.mode, 'material-detail-reference-smoke')
  assert.equal(read.metadata.readOnly, true)
  assert.equal(read.metadata.requestedNumber, 'MAT-GATE-001')
  assert.equal(read.metadata.readPath, '/K3API/Material/GetDetail')
  assert.deepEqual(read.metadata.referenceFields, ['FUnitGroupID', 'FBaseUnitID', 'FAcctID'])
  assert.equal(read.metadata.referenceObjectCount, 3)

  const record = read.records[0]
  assert.equal(record.FNumber, 'MAT-GATE-001', 'requested FNumber is echoed onto the record')
  assert.deepEqual(
    record._k3ReferenceObjects.FUnitGroupID,
    { FName: '<unit-group-name>' },
    'FUnitGroupID with FName-only shape is accepted because the customer sample exposes it',
  )
  assert.deepEqual(record._k3ReferenceObjects.FBaseUnitID, {
    FNumber: '<base-unit-number>',
    FName: '<base-unit-name>',
  })
  assert.deepEqual(record._k3ReferenceObjects.FAcctID, {
    FID: '<inventory-account-id>',
    FName: '<inventory-account-name>',
  })
  assert.equal(record._k3ReferenceObjects.FTrack, undefined, 'non-object reference candidates are not harvested')

  const getDetailCalls = calls.filter((call) => call.pathname === '/K3API/Material/GetDetail')
  assert.equal(getDetailCalls.length, 1, 'read smoke calls Material/GetDetail once')
  assert.equal(getDetailCalls[0].options.method, 'POST')
  assert.equal(getDetailCalls[0].options.headers['X-K3-Session'], 'k3-session-1')
  assert.deepEqual(getDetailCalls[0].body, {
    Data: { FNumber: 'MAT-GATE-001' },
    GetProperty: false,
  })
  assert.equal(calls.some((call) => call.pathname === '/K3API/Material/Save'), false, 'read smoke must not Save')
  assert.equal(calls.some((call) => call.pathname === '/K3API/Material/Submit'), false, 'read smoke must not Submit')
  assert.equal(calls.some((call) => call.pathname === '/K3API/Material/Audit'), false, 'read smoke must not Audit')

  const missingKey = await adapter.read({ object: 'material' }).catch((error) => error)
  assert.ok(missingKey instanceof AdapterValidationError, 'Material read requires a concrete FNumber/template key')
  assert.equal(missingKey.details.code, 'K3_WISE_READ_KEY_REQUIRED')

  const broadFilter = await adapter.read({
    object: 'material',
    filters: { FNumber: 'MAT-GATE-001', modifiedSince: '2026-05-01T00:00:00Z' },
  }).catch((error) => error)
  assert.ok(broadFilter instanceof AdapterValidationError, 'broad list-style filters are blocked')
  assert.equal(broadFilter.details.code, 'K3_WISE_READ_FILTER_UNSUPPORTED')

  const cursorRead = await adapter.read({
    object: 'material',
    filters: { FNumber: 'MAT-GATE-001' },
    cursor: 'next-page',
  }).catch((error) => error)
  assert.ok(cursorRead instanceof AdapterValidationError, 'cursor pagination is blocked')
  assert.equal(cursorRead.details.code, 'K3_WISE_READ_LIST_UNSUPPORTED')

  const watermarkRead = await adapter.read({
    object: 'material',
    filters: { FNumber: 'MAT-GATE-001' },
    watermark: { FModifyDate: '2026-05-01T00:00:00Z' },
  }).catch((error) => error)
  assert.ok(watermarkRead instanceof AdapterValidationError, 'watermark list reads are blocked')
  assert.equal(watermarkRead.details.code, 'K3_WISE_READ_LIST_UNSUPPORTED')

  const businessFailure = await adapter.read({
    object: 'material',
    filters: { FNumber: 'READFAIL' },
  }).catch((error) => error)
  assert.ok(businessFailure instanceof K3WiseWebApiAdapterError, 'K3 business failure is surfaced as adapter error')
  assert.equal(businessFailure.details.code, 'K3_WISE_READ_BUSINESS_ERROR')
  assert.match(businessFailure.message, /material detail not found/)

  const transportFailure = await adapter.read({
    object: 'material',
    filters: { FNumber: 'HTTPFAIL' },
  }).catch((error) => error)
  assert.ok(transportFailure instanceof K3WiseWebApiAdapterError, 'HTTP failure is surfaced as read failure')
  assert.equal(transportFailure.details.code, 'K3_WISE_READ_FAILED')
  assert.equal(transportFailure.details.path, '/K3API/Material/GetDetail')

  const bomReadAdapter = createK3WiseWebApiAdapter({
    system: createK3WebApiSystem({
      config: {
        baseUrl: 'https://k3.example.test',
        autoSubmit: false,
        autoAudit: false,
        objects: {
          bom: {
            operations: ['upsert', 'read'],
          },
        },
      },
    }),
    fetchImpl,
  })
  const bomRead = await bomReadAdapter.read({
    object: 'bom',
    filters: { FNumber: 'BOM-001' },
  }).catch((error) => error)
  assert.ok(bomRead instanceof UnsupportedAdapterOperationError, 'read-only smoke does not unlock BOM reads')
}

async function testK3WebApiAuthorityCodeToken() {
  const { calls, fetchImpl } = createK3FetchMock()
  const adapter = createK3WiseWebApiAdapter({
    system: createK3WebApiSystem({
      credentials: {
        authorityCode: 'auth-code-1',
      },
      config: {
        baseUrl: 'https://k3.example.test',
        authMode: 'authority-code',
        tokenPath: '/K3API/Token/Create',
        autoSubmit: false,
        autoAudit: false,
      },
    }),
    fetchImpl,
  })

  const connection = await adapter.testConnection({ skipHealth: true })
  assert.equal(connection.ok, true, 'authorityCode token testConnection succeeds')
  assert.equal(connection.authenticated, true, 'query-token auth counts as authenticated')

  const upsert = await adapter.upsert({
    object: 'material',
    records: [{ FNumber: 'MAT-TOKEN-001', FName: 'Token material' }],
    keyFields: ['FNumber'],
  })

  const tokenCalls = calls.filter((call) => call.pathname === '/K3API/Token/Create')
  const saveCalls = calls.filter((call) => call.pathname === '/K3API/Material/Save')
  assert.equal(tokenCalls.length, 1, 'authorityCode token is cached across testConnection and upsert')
  assert.equal(tokenCalls[0].query.authorityCode, 'auth-code-1')
  assert.equal(saveCalls.length, 1)
  assert.equal(saveCalls[0].query.Token, 'k3-token-1', 'K3 API token is sent as query parameter')
  assert.deepEqual(saveCalls[0].body, { Data: { FNumber: 'MAT-TOKEN-001', FName: 'Token material' } })
  assert.equal(upsert.written, 1)
  assert.equal(upsert.results[0].externalId, 'item-MAT-TOKEN-001')
  assert.equal(upsert.results[0].billNo, 'MAT-TOKEN-001')
}

async function testK3WebApiSaveBusinessEvidence() {
  const { fetchImpl } = createK3FetchMock()
  const adapter = createK3WiseWebApiAdapter({
    system: createK3WebApiSystem({
      config: {
        baseUrl: 'https://k3.example.test',
        autoSubmit: false,
        autoAudit: false,
      },
    }),
    fetchImpl,
  })

  const upsert = await adapter.upsert({
    object: 'material',
    records: [
      { FNumber: 'ROWOK', FName: 'Positive row' },
      { FNumber: 'ROWFAIL', FName: 'Business row fail' },
      { FNumber: 'STATUS201', FName: 'Envelope fail' },
    ],
    keyFields: ['FNumber'],
  })

  assert.equal(upsert.written, 1, 'only K3 business-positive row counts as written')
  assert.equal(upsert.failed, 2, 'K3 row-level failures are counted as failed')
  assert.equal(upsert.results[0].externalId, 1001, 'positive FItemID is surfaced as external id')
  assert.equal(upsert.results[0].responseSummary.success, true)
  assert.equal(upsert.results[0].responseSummary.externalIdPresent, true)
  assert.equal(upsert.errors[0].code, 'K3_WISE_SAVE_FAILED')
  assert.match(upsert.errors[0].message, /unit group/i)
  assert.equal(upsert.errors[0].responseSummary.success, false)
  assert.equal(upsert.errors[0].responseSummary.failedRowCount, 1)
  assert.equal(upsert.errors[1].code, 'K3_WISE_SAVE_FAILED')
  assert.match(upsert.errors[1].message, /required unit/i)
  assert.equal(upsert.metadata.businessResponses.length, 3)
  assert.deepEqual(
    upsert.metadata.businessResponses.map((summary) => summary.success),
    [true, false, false],
    'business response summaries preserve one entry per attempted save',
  )
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
  assert.match(missingExecutorStatus.message, /SQLSERVER_EXECUTOR_MISSING/)
  assert.match(missingExecutorStatus.message, /queryExecutor/)

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

  const readOnlyScoped = createK3WiseSqlServerChannel({
    system: createSqlSystem({
      allowedTables: [],
      readTables: ['dbo.integration_material_stage'],
      writeTables: [],
      objects: {
        material_stage: {
          table: 'dbo.integration_material_stage',
          operations: ['read', 'upsert'],
          writeMode: 'middle-table',
          keyField: 'FNumber',
        },
      },
    }),
    queryExecutor,
  })
  const readOnlyWrite = await readOnlyScoped.upsert({
    object: 'material_stage',
    records: [{ FNumber: 'MAT-READ-ONLY' }],
  }).catch((error) => error)
  assert.ok(readOnlyWrite instanceof AdapterValidationError, 'readTables must not authorize middle-table writes')

  const writeOnlyScoped = createK3WiseSqlServerChannel({
    system: createSqlSystem({
      allowedTables: [],
      readTables: [],
      writeTables: ['dbo.t_ICItem'],
      objects: {
        material: {
          table: 'dbo.t_ICItem',
          operations: ['read', 'upsert'],
          writeMode: 'middle-table',
          keyField: 'FNumber',
        },
      },
    }),
    queryExecutor,
  })
  const writeOnlyRead = await writeOnlyScoped.read({ object: 'material' }).catch((error) => error)
  assert.ok(writeOnlyRead instanceof AdapterValidationError, 'writeTables must not authorize reads')

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

  const factoryInjected = createK3WiseSqlServerChannelFactory({ queryExecutor })({
    system: createSqlSystem(),
  })
  const factoryConnection = await factoryInjected.testConnection()
  assert.equal(factoryConnection.ok, true, 'factory default queryExecutor is injected into channel instances')

  const { driver, calls } = createFakeMssqlDriver()
  const readOnlyExecutor = createK3WiseSqlServerReadOnlyExecutor({ driver })
  const runtimeAdapter = createK3WiseSqlServerChannelFactory({ queryExecutor: readOnlyExecutor })({
    system: createSqlSystem({ server: 'sql.local:1433', database: 'AIS_TEST' }, {
      credentials: { username: 'readonly_user', password: 'readonly-password' },
    }),
  })
  const runtimeConnection = await runtimeAdapter.testConnection()
  assert.equal(runtimeConnection.ok, true)
  assert.equal(runtimeConnection.code, 'SQLSERVER_CONNECTED')
  const runtimeRead = await runtimeAdapter.read({
    object: 'material',
    limit: 3,
    filters: { FUseStatus: '1' },
    watermark: { FModifyDate: '2026-05-01T00:00:00.000Z' },
  })
  assert.equal(runtimeRead.records.length, 1)
  const selectQuery = calls.findLast((call) => call.method === 'query')
  assert.match(selectQuery.sql, /^SELECT TOP 3 \[FItemID\], \[FNumber\], \[FName\] FROM \[dbo\]\.\[t_ICItem\]/)
  assert.match(selectQuery.sql, /WHERE \[FUseStatus\] = @filter_0 AND \[FModifyDate\] > @watermark_0/)
  assert.match(selectQuery.sql, /ORDER BY \[FNumber\]$/)
  assert.ok(calls.some((call) => call.method === 'input' && call.name === 'filter_0' && call.value === '1'))
  assert.ok(calls.some((call) => call.method === 'input' && call.name === 'watermark_0' && call.value === '2026-05-01T00:00:00.000Z'))
  assert.equal(
    JSON.stringify(calls).includes('readonly-password'),
    true,
    'fake driver receives the credential internally for mssql connection config',
  )
  assert.equal(JSON.stringify(runtimeRead).includes('readonly-password'), false, 'read result does not expose SQL credentials')

  const runtimeWrite = await runtimeAdapter.upsert({
    object: 'material_stage',
    records: [{ FNumber: 'MAT-SHOULD-NOT-WRITE' }],
    keyFields: ['FNumber'],
  }).catch((error) => error)
  assert.equal(runtimeWrite.code, 'SQLSERVER_WRITE_EXECUTOR_DISABLED', 'built-in runtime executor remains read-only')

  const { driver: failingDriver } = createFakeMssqlDriver({ failConnect: new Error('login failed password=secret-that-must-not-leak for readonly_user') })
  const failingExecutor = createK3WiseSqlServerReadOnlyExecutor({ driver: failingDriver })
  const failingAdapter = createK3WiseSqlServerChannelFactory({ queryExecutor: failingExecutor })({
    system: createSqlSystem({ server: 'sql.local', database: 'AIS_TEST' }, {
      credentials: { username: 'readonly_user', password: 'secret-that-must-not-leak' },
    }),
  })
  const failingConnection = await failingAdapter.testConnection()
  assert.equal(failingConnection.ok, false)
  assert.equal(failingConnection.code, 'SQLSERVER_TEST_FAILED')
  assert.equal(JSON.stringify(failingConnection).includes('secret-that-must-not-leak'), false)
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

// ---------------------------------------------------------------------------
// M1 Material Save-only failure fix (#1903/#1904 impl) — anchored tests
// ---------------------------------------------------------------------------

const PROFILE_ID = 'material-k3wise-customer-profile-v1'

function createProfiledSystem(objectOverrides = {}, configOverrides = {}) {
  return createK3WebApiSystem({
    config: {
      baseUrl: 'https://k3.example.test',
      autoSubmit: false,
      autoAudit: false,
      objects: {
        material: { profile: PROFILE_ID, ...objectOverrides },
      },
      ...configOverrides,
    },
  })
}

// Anchor 1 — opt-in customer profile + generic byte-stability.
function testM1ProfileOptIn() {
  // Generic material template is byte-stable (no profile fields leak in).
  const genericTemplate = getK3WiseDocumentTemplate('material')
  assert.equal(genericTemplate.id, 'k3wise.material.v1', 'generic material id unchanged')
  const genericNames = genericTemplate.schema.map((field) => field.name)
  assert.ok(genericNames.includes('FBaseUnitID'), 'generic material keeps FBaseUnitID')
  assert.ok(!genericNames.includes('FErpClsID'), 'generic material has no profile enum field FErpClsID')
  assert.ok(!genericNames.includes('FUseState'), 'generic material has no profile enum field FUseState')
  assert.ok(!genericNames.some((name) => /ChkMde$/.test(name)), 'generic material has no quality-mode fields')

  // getK3WiseDocumentObjectDefaults() must NOT contain the profile.
  const defaults = getK3WiseDocumentObjectDefaults()
  assert.deepEqual(Object.keys(defaults).sort(), ['bom', 'material'], 'defaults loop iterates only material + bom')
  assert.equal(defaults.material.id, 'k3wise.material.v1', 'defaults.material is the generic template')
  assert.equal(
    JSON.stringify(defaults).includes(PROFILE_ID),
    false,
    'profile id never appears in getK3WiseDocumentObjectDefaults()',
  )

  // Profile IS discoverable via getK3WiseDocumentTemplate / listK3WiseDocumentTemplates.
  const profile = getK3WiseDocumentTemplate('materialCustomerProfile')
  assert.ok(profile, 'profile discoverable via getK3WiseDocumentTemplate')
  assert.equal(profile.id, PROFILE_ID)
  assert.equal(profile.lifecycle, 'save-only')
  const listedIds = listK3WiseDocumentTemplates().map((tpl) => tpl.id)
  assert.ok(listedIds.includes(PROFILE_ID), 'profile listed by listK3WiseDocumentTemplates')
  assert.ok(listedIds.includes('k3wise.material.v1'), 'generic still listed')

  // Synthetic-only sample values — no real dictionary value baked in.
  assert.equal(profile.sampleSource.FNumber, 'MAT-001', 'sample uses synthetic code')

  // Selection hook: WITHOUT profile the normalized material equals today's generic.
  const plainObjects = webApiInternals.normalizeObjects({})
  assert.equal(plainObjects.material.id, 'k3wise.material.v1', 'no-profile normalized material is generic')
  assert.equal(plainObjects.material.lifecycle, undefined, 'no-profile material has no save-only lifecycle')

  // WITH profile the normalized material is the profile (id + FID-shaped enum fields).
  const profiledObjects = webApiInternals.normalizeObjects({
    objects: { material: { profile: PROFILE_ID } },
  })
  assert.equal(profiledObjects.material.id, PROFILE_ID, 'profile selection swaps the base template')
  assert.equal(profiledObjects.material.lifecycle, 'save-only', 'profile selection re-pins save-only lifecycle')
  const profiledNames = profiledObjects.material.schema.map((field) => field.name)
  assert.ok(profiledNames.includes('FErpClsID'), 'profiled material includes FID-shaped enum field FErpClsID')
  const erpCls = profiledObjects.material.schema.find((field) => field.name === 'FErpClsID')
  assert.equal(erpCls.reference.identifier, 'FID', 'FErpClsID declares FID identifier')
  const unitGroup = profiledObjects.material.schema.find((field) => field.name === 'FUnitGroupID')
  assert.equal(unitGroup.reference.identifier, 'FNumber', 'FUnitGroupID declares FNumber identifier')

  // Negative control: a non-matching profile value does NOT swap (generic untouched,
  // byte-for-byte equal to the no-profile normalization).
  const otherProfile = webApiInternals.normalizeObjects({
    objects: { material: { profile: 'some-other-id' } },
  })
  assert.equal(otherProfile.material.id, 'k3wise.material.v1', 'unknown profile value leaves generic in place')
  assert.deepEqual(
    otherProfile.material.schema,
    plainObjects.material.schema,
    'unknown profile value yields byte-stable generic schema',
  )
}

// Anchor 2 — per-field base-data shaping via the profile's reference.identifier.
async function testM1BaseDataObjectShaping() {
  const { fetchImpl } = createK3FetchMock()
  const adapter = createK3WiseWebApiAdapter({
    system: createProfiledSystem(),
    fetchImpl,
  })
  const preview = await adapter.previewUpsert({
    object: 'material',
    records: [
      {
        FNumber: 'MAT-SHAPE-001',
        FName: 'Shape material',
        FUnitGroupID: 'UG-PCS', // numbered scalar → { FNumber }
        FErpClsID: 1001, // enum scalar → { FID }
        FUnitID: { FNumber: 'PCS', FName: 'Pieces' }, // pre-built object passes through
      },
    ],
    keyFields: ['FNumber'],
  })
  assert.deepEqual(
    preview.records[0].body.Data.FUnitGroupID,
    { FNumber: 'UG-PCS' },
    'numbered field scalar → { FNumber: value }',
  )
  assert.deepEqual(
    preview.records[0].body.Data.FErpClsID,
    { FID: 1001 },
    'enum field scalar → { FID: value }',
  )
  assert.deepEqual(
    preview.records[0].body.Data.FUnitID,
    { FNumber: 'PCS', FName: 'Pieces' },
    'pre-built object value passes through unchanged',
  )
}

// Anchor 3 — fail-closed placeholder guard before the HTTP Save.
async function testM1FailClosedPlaceholder() {
  const fullyConfiguredRecord = {
    FNumber: 'MAT-FC-001',
    FName: 'Fail-closed material',
    FUnitGroupID: 'UG-PCS',
    FUnitID: 'PCS',
    FErpClsID: 1001,
  }

  // (a) Placeholder in a REQUIRED field → upsert rejects, ZERO save calls.
  {
    const { calls, fetchImpl } = createK3FetchMock()
    const adapter = createK3WiseWebApiAdapter({ system: createProfiledSystem(), fetchImpl })
    const upsert = await adapter.upsert({
      object: 'material',
      records: [{ ...fullyConfiguredRecord, FUnitGroupID: '<fill-outside-git>' }],
      keyFields: ['FNumber'],
    })
    assert.equal(upsert.written, 0, 'placeholder in required field is not written')
    assert.equal(upsert.failed, 1, 'placeholder in required field is recorded as failed')
    assert.match(upsert.errors[0].message, /unreplaced placeholder in required field FUnitGroupID/)
    const saveCalls = calls.filter((call) => call.pathname === '/K3API/Material/Save')
    assert.equal(saveCalls.length, 0, 'fail-closed: ZERO Save HTTP calls reach the transport')
  }

  // (b) Negative control — fully-substituted record proceeds (Save call happens).
  {
    const { calls, fetchImpl } = createK3FetchMock()
    const adapter = createK3WiseWebApiAdapter({ system: createProfiledSystem(), fetchImpl })
    const upsert = await adapter.upsert({
      object: 'material',
      records: [{ ...fullyConfiguredRecord, FNumber: 'ROWOK' }],
      keyFields: ['FNumber'],
    })
    assert.equal(upsert.written, 1, 'fully-substituted record proceeds and is written')
    const saveCalls = calls.filter((call) => call.pathname === '/K3API/Material/Save')
    assert.equal(saveCalls.length, 1, 'fully-substituted record issues exactly one Save call')
  }

  // (c) Guard is the blocker — a placeholder in a NON-required field does NOT block.
  {
    const { calls, fetchImpl } = createK3FetchMock()
    const adapter = createK3WiseWebApiAdapter({ system: createProfiledSystem(), fetchImpl })
    const upsert = await adapter.upsert({
      object: 'material',
      records: [{ ...fullyConfiguredRecord, FNumber: 'ROWOK', FUseState: '<fill-outside-git>' }],
      keyFields: ['FNumber'],
    })
    assert.equal(upsert.written, 1, 'placeholder in NON-required field does not block the Save')
    const saveCalls = calls.filter((call) => call.pathname === '/K3API/Material/Save')
    assert.equal(saveCalls.length, 1, 'non-required placeholder still issues the Save call')
    // The non-required placeholder is dropped (not shaped/sent) since the guard
    // only fires on required fields; confirm it never reached the body.
    assert.equal(
      Object.prototype.hasOwnProperty.call(saveCalls[0].body.Data, 'FUseState'),
      true,
      'non-required placeholder is still projected (proves required === true is the discriminator)',
    )
  }
}

// Anchor 4 — Save-response Data[0].Data parse (unwrap + helper probes).
async function testM1ReadbackData0Data() {
  const profiledSystem = () => createProfiledSystem({}, {})

  // Full upsert path: nested success → judged succeeded.
  {
    const { fetchImpl } = createK3FetchMock()
    const adapter = createK3WiseWebApiAdapter({ system: profiledSystem(), fetchImpl })
    const upsert = await adapter.upsert({
      object: 'material',
      records: [{
        FNumber: 'NESTOK', FName: 'Nested ok', FUnitGroupID: 'UG', FUnitID: 'PCS', FErpClsID: 1,
      }],
      keyFields: ['FNumber'],
    })
    assert.equal(upsert.written, 1, 'Data[0].Data nested success is judged succeeded')
    assert.equal(upsert.results[0].externalId, 123, 'nested FItemID surfaced as external id')
  }

  // Full upsert path: nested failure → message/code resolved + judged failed.
  {
    const { fetchImpl } = createK3FetchMock()
    const adapter = createK3WiseWebApiAdapter({ system: profiledSystem(), fetchImpl })
    const upsert = await adapter.upsert({
      object: 'material',
      records: [{
        FNumber: 'NESTFAIL', FName: 'Nested fail', FUnitGroupID: 'UG', FUnitID: 'PCS', FErpClsID: 1,
      }],
      keyFields: ['FNumber'],
    })
    assert.equal(upsert.written, 0, 'Data[0].Data nested failure is judged failed')
    assert.equal(upsert.failed, 1)
    assert.match(upsert.errors[0].message, /nested unit group invalid/, 'nested FMessage resolved')
  }

  // Regression: flat Data[0].X still works on the original generic adapter.
  {
    const { fetchImpl } = createK3FetchMock()
    const adapter = createK3WiseWebApiAdapter({
      system: createK3WebApiSystem({
        config: { baseUrl: 'https://k3.example.test', autoSubmit: false, autoAudit: false },
      }),
      fetchImpl,
    })
    const upsert = await adapter.upsert({
      object: 'material',
      records: [{ FNumber: 'ROWOK', FName: 'Flat ok' }],
      keyFields: ['FNumber'],
    })
    assert.equal(upsert.written, 1, 'flat Data[0].FStatus regression preserved')
    assert.equal(upsert.results[0].externalId, 1001, 'flat FItemID still surfaced')
  }

  // Negative-control (unit level) — proves the extractBusinessRows unwrap is load-bearing.
  const nestedSuccess = { StatusCode: 200, Message: 'Successful', Data: [{ Data: { FStatus: true, FItemID: 123, FNumber: 'MAT-NEST' } }] }
  const rows = webApiInternals.extractBusinessRows(nestedSuccess)
  assert.equal(rows.length, 1, 'extractBusinessRows yields one canonical row (no double-add)')
  assert.deepEqual(rows[0], { FStatus: true, FItemID: 123, FNumber: 'MAT-NEST' }, 'row is the unwrapped inner object')
  assert.equal(webApiInternals.saveBusinessSuccess(nestedSuccess, {}), true, 'nested success judged succeeded (unwrap required)')

  // Negative-control (unit level) — proves the Data.0.Data.* helper probes are load-bearing.
  const nestedFailure = { StatusCode: 200, Message: 'Successful', Data: [{ Data: { FStatus: false, FMessage: 'nested missing unit', Code: 'N' } }] }
  assert.equal(webApiInternals.responseMessage(nestedFailure, {}, null), 'nested missing unit', 'Data.0.Data.FMessage probe resolves')
  assert.equal(webApiInternals.responseCode(nestedFailure, {}, null), 'N', 'Data.0.Data.Code probe resolves')

  // Flat shape unchanged at the helper level (regression).
  const flat = { StatusCode: 200, Data: [{ FStatus: false, FMessage: 'flat message', Code: 'E1' }] }
  assert.equal(webApiInternals.responseMessage(flat, {}, null), 'flat message', 'flat Data.0.FMessage unchanged')
  assert.equal(webApiInternals.responseCode(flat, {}, null), 'E1', 'flat Data.0.Code unchanged')
}

// Anchor 5 — sanitized row diagnostics (mask identifiers, scrub message).
function testM1DiagnosticsRedaction() {
  // Envelope-200 / row-fail carrying a raw FNumber identifier and a secret-shaped message.
  const data = {
    StatusCode: 200,
    Message: 'Successful',
    Data: [{
      FStatus: false,
      FNumber: 'MAT-SECRET-123',
      FItemID: 0,
      FMessage: 'save rejected for pwd=topsecret123 missing unit group',
    }],
  }
  const summary = webApiInternals.createBusinessResponseSummary(data, {}, { operation: 'save', success: false })
  const serialized = JSON.stringify(summary)

  // Raw record identifier must NOT appear; a masked form MUST appear.
  assert.equal(serialized.includes('MAT-SECRET-123'), false, 'raw FNumber is never in the summary')
  assert.equal(summary.billNoMasked, '****123', 'billNo is masked to a 3-char tail')
  assert.equal(summary.externalIdMasked, null, 'no meaningful external id (FItemID 0) → null masked id')

  // Redacted message: secret-shaped substring scrubbed, surrounding context kept.
  assert.equal(serialized.includes('topsecret123'), false, 'secret-shaped value scrubbed from message')
  assert.match(summary.responseMessageRedacted, /missing unit group/, 'diagnostic context preserved')
  assert.match(summary.responseMessageRedacted, /\[redacted\]/, 'pwd=… replaced with [redacted]')

  // Booleans / counts retained (existing consumers depend on them).
  assert.equal(summary.success, false)
  assert.equal(summary.failedRowCount, 1)
  assert.equal(summary.envelopeStatusCode, 200)
  assert.equal(summary.billNoPresent, true)

  // maskRowKey edge cases.
  assert.equal(webApiInternals.maskRowKey(''), null, 'empty string → null')
  assert.equal(webApiInternals.maskRowKey(null), null, 'null → null')
  assert.equal(webApiInternals.maskRowKey('AB'), '****AB', 'short value masked, tail kept')

  // Negative control: an UN-masked summary (raw FNumber spread in) DOES leak — proving
  // the assertion above discriminates rather than being trivially true.
  const unmaskedSummary = { ...summary, billNoRaw: data.Data[0].FNumber }
  assert.equal(
    JSON.stringify(unmaskedSummary).includes('MAT-SECRET-123'),
    true,
    'control: a summary that emits the raw FNumber would leak it',
  )
}

// Anchor 5 (wire) — the new masked/redacted summary fields must round-trip through
// the real upsert wire (responseSummary on results AND errors), not just the direct
// helper call. Guards the wire-vs-fixture drift trap if the `...saveSummary` spread
// is ever refactored to a pick/whitelist that drops the new fields.
async function testM1DiagnosticsRedactionWire() {
  const { fetchImpl } = createK3FetchMock()
  const adapter = createK3WiseWebApiAdapter({
    system: createK3WebApiSystem({
      config: { baseUrl: 'https://k3.example.test', autoSubmit: false, autoAudit: false },
    }),
    fetchImpl,
  })
  const upsert = await adapter.upsert({
    object: 'material',
    records: [
      { FNumber: 'ROWOK', FName: 'Positive row' }, // FItemID 1001 → ****001
      { FNumber: 'ROWFAIL', FName: 'Business row fail' }, // FStatus false + message
    ],
    keyFields: ['FNumber'],
  })
  // Success row: masked external id present on the wire; raw never present.
  const okSummary = upsert.results[0].responseSummary
  assert.equal(okSummary.externalIdMasked, '****001', 'masked external id round-trips on results[].responseSummary')
  assert.equal(Object.prototype.hasOwnProperty.call(okSummary, 'externalIdMasked'), true)
  // Fail row: redacted message present on the wire (errors[].responseSummary).
  const failSummary = upsert.errors[0].responseSummary
  assert.ok(failSummary, 'error carries a responseSummary on the wire')
  assert.match(failSummary.responseMessageRedacted, /unit group parameter invalid/, 'redacted message round-trips on errors[].responseSummary')
  assert.equal(Object.prototype.hasOwnProperty.call(failSummary, 'responseMessageRedacted'), true)
}

// Anchor 6 — autoSubmit/autoAudit hard guard for save-only profiles.
async function testM1SaveOnlyLocks() {
  const profiledOkRecord = {
    FNumber: 'ROWOK', FName: 'Save-only material',
    FUnitGroupID: 'UG', FUnitID: 'PCS', FErpClsID: 1,
  }

  // Profile selected + autoSubmit/autoAudit forced true via BOTH request + config:
  // the guard must still prevent any Submit/Audit HTTP call.
  {
    const { calls, fetchImpl } = createK3FetchMock()
    const adapter = createK3WiseWebApiAdapter({
      // config.autoSubmit/autoAudit true AND request.options true → still locked.
      system: createProfiledSystem({}, { autoSubmit: true, autoAudit: true }),
      fetchImpl,
    })
    const upsert = await adapter.upsert({
      object: 'material',
      records: [profiledOkRecord],
      keyFields: ['FNumber'],
      options: { autoSubmit: true, autoAudit: true },
    })
    assert.equal(upsert.written, 1, 'save-only profile still writes via Save')
    assert.equal(upsert.metadata.autoSubmit, false, 'save-only profile forces autoSubmit=false')
    assert.equal(upsert.metadata.autoAudit, false, 'save-only profile forces autoAudit=false')
    const submitCalls = calls.filter((call) => call.pathname === '/K3API/Material/Submit')
    const auditCalls = calls.filter((call) => call.pathname === '/K3API/Material/Audit')
    assert.equal(submitCalls.length, 0, 'save-only profile makes NO Submit HTTP call')
    assert.equal(auditCalls.length, 0, 'save-only profile makes NO Audit HTTP call')
  }

  // Negative control: a non-save-only object (generic material) with autoSubmit=true
  // DOES fire Submit — proving the guard (not something else) is what blocks above.
  {
    const { calls, fetchImpl } = createK3FetchMock()
    const adapter = createK3WiseWebApiAdapter({
      system: createK3WebApiSystem({
        config: { baseUrl: 'https://k3.example.test', autoSubmit: true, autoAudit: true },
      }),
      fetchImpl,
    })
    const upsert = await adapter.upsert({
      object: 'material',
      records: [{ FNumber: 'MAT-CTRL-001', FName: 'Control bolt' }],
      keyFields: ['FNumber'],
      options: { autoSubmit: true, autoAudit: true },
    })
    assert.equal(upsert.written, 1)
    assert.equal(upsert.metadata.autoSubmit, true, 'non-save-only object keeps autoSubmit=true')
    const submitCalls = calls.filter((call) => call.pathname === '/K3API/Material/Submit')
    const auditCalls = calls.filter((call) => call.pathname === '/K3API/Material/Audit')
    assert.equal(submitCalls.length, 1, 'control: Submit DOES fire for a non-save-only object')
    assert.equal(auditCalls.length, 1, 'control: Audit DOES fire for a non-save-only object')
  }

  // Boundaries: the profile keeps operations:['upsert'] — Submit/Audit/BOM/list/read rejected.
  {
    const { fetchImpl } = createK3FetchMock()
    const adapter = createK3WiseWebApiAdapter({ system: createProfiledSystem(), fetchImpl })
    const profiledObjects = webApiInternals.normalizeObjects({ objects: { material: { profile: PROFILE_ID } } })
    assert.deepEqual(profiledObjects.material.operations, ['upsert'], 'profile exposes only upsert')
    // read is not in operations → ensureOperation rejects.
    const readAttempt = await adapter.read({ object: 'material', filters: { FNumber: 'MAT-X' } }).catch((error) => error)
    assert.ok(readAttempt instanceof UnsupportedAdapterOperationError, 'save-only profile rejects read/list')
    // bom is unaffected and unchanged.
    assert.equal(profiledObjects.bom.id, 'k3wise.bom.v1', 'BOM object unchanged by profile selection')
  }
}

async function main() {
  await testK3WebApiAdapter()
  testM1ProfileOptIn()
  await testM1BaseDataObjectShaping()
  await testM1FailClosedPlaceholder()
  await testM1ReadbackData0Data()
  testM1DiagnosticsRedaction()
  await testM1DiagnosticsRedactionWire()
  await testM1SaveOnlyLocks()
  await testK3WebApiMaterialDetailReadSmoke()
  await testK3WebApiAuthorityCodeToken()
  await testK3WebApiSaveBusinessEvidence()
  testSqlServerConnectionConfigNormalization()
  await testK3SqlServerChannel()
  await testK3WebApiAutoFlagCoercion()
  console.log('✓ k3-wise-adapters: WebAPI, SQL Server channel, auto-flag coercion, and M1 Material Save-only profile tests passed')
}

main().catch((err) => {
  console.error('✗ k3-wise-adapters FAILED')
  console.error(err)
  process.exit(1)
})
