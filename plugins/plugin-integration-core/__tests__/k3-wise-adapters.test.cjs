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
  __internals: auditInternals,
  K3_WISE_CALL_AUDIT_OPERATIONS,
  getK3WiseCallAuditSnapshot,
} = require(path.join(__dirname, '..', 'lib', 'adapters', 'k3-wise-call-audit.cjs'))
const {
  createK3WiseSqlServerChannel,
  createK3WiseSqlServerChannelFactory,
} = require(path.join(__dirname, '..', 'lib', 'adapters', 'k3-wise-sqlserver-channel.cjs'))
const {
  __internals: sqlExecutorInternals,
  createK3WiseSqlServerReadOnlyExecutor,
} = require(path.join(__dirname, '..', 'lib', 'adapters', 'k3-wise-sqlserver-executor.cjs'))
const {
  buildReadSmokeRequest,
  getReadSmokePreset,
} = require(path.join(__dirname, '..', 'lib', 'read-smoke.cjs'))
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
      if (record.FNumber === 'AMBIGUOUSFAIL') {
        return jsonResponse(200, {
          StatusCode: 200,
          Message: 'Successful',
          Data: [{ FStatus: false, FItemID: 0 }],
        })
      }
      if (record.FNumber === 'CHINESENEGFAIL') {
        return jsonResponse(200, {
          StatusCode: 200,
          Message: 'Successful',
          Data: [{ FStatus: false, FItemID: 0, FMessage: '操作不成功' }],
        })
      }
      if (record.FNumber === 'ROWOK') {
        return jsonResponse(200, {
          StatusCode: 200,
          Message: 'Successful',
          Data: [{ FStatus: true, FItemID: 1001, FNumber: record.FNumber }],
        })
      }
      if (record.FNumber === 'NESTEDOK') {
        // Customer K3 that nests the per-row payload under Data[0].Data
        return jsonResponse(200, {
          StatusCode: 200,
          Message: 'Successful',
          Data: [{ FNumber: record.FNumber, Data: { FStatus: true, FItemID: 2002, FNumber: record.FNumber } }],
        })
      }
      if (record.FNumber === 'NESTEDFAIL') {
        return jsonResponse(200, {
          StatusCode: 200,
          Message: 'Successful',
          Data: [{ FNumber: record.FNumber, Data: { FStatus: false, FItemID: 0, FMessage: 'nested unit group parameter invalid' } }],
        })
      }
      if (record.FNumber === 'SECRETFAIL') {
        return jsonResponse(200, {
          StatusCode: 200,
          Message: 'Successful',
          Data: [{ FStatus: false, FItemID: 0, FMessage: 'save failed: postgres://k3user:s3cretpw@db.internal/erp rejected the request' }],
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
    if (parsed.pathname === '/K3API/Material/GetList') {
      const pageSize = body && body.Data && body.Data.PageSize
      const top = body && body.Data && body.Data.Top
      if (!pageSize || !top) {
        return jsonResponse(200, {
          StatusCode: 201,
          Message: 'PageSize and Top are required',
          Data: {},
        })
      }
      return jsonResponse(200, {
        StatusCode: 200,
        Message: 'Material list succeeded',
        Data: {
          ROWCOUNT: 3,
          PAGESIZE: pageSize,
          PAGEINDEX: body.Data.PageIndex,
          DATA: [
            { FNumber: 'MAT-LIST-001', FName: 'Material 1' },
            { FNumber: 'MAT-LIST-002', FName: 'Material 2' },
            { FNumber: 'MAT-LIST-003', FName: 'Material 3' },
          ],
        },
      })
    }
    if (parsed.pathname === '/K3API/Material/Submit') {
      return jsonResponse(200, { success: true, submitted: body.Number })
    }
    if (parsed.pathname === '/K3API/Material/Audit') {
      return jsonResponse(200, { success: true, audited: body.Number })
    }
    // BOM write mechanics mirror Material's (same Save/Submit/Audit shape), keyed on
    // FParentItemNumber (the BOM keyField) instead of FNumber — BOM is NOT behind the
    // material profile guard, so these back the "pure write-mechanics" cases migrated off
    // material (tri-state autoSubmit/autoAudit, Submit-after-Save ordering, etc).
    if (parsed.pathname === '/K3API/BOM/Save') {
      const record = body.Model || body.Data
      const parentKey = record.FParentItemNumber
      if (parentKey === 'BAD') {
        return jsonResponse(200, { success: false, message: 'invalid bom' })
      }
      return jsonResponse(200, { success: true, externalId: `item-${parentKey}`, billNo: parentKey })
    }
    if (parsed.pathname === '/K3API/BOM/Submit') {
      return jsonResponse(200, { success: true, submitted: body.Number })
    }
    if (parsed.pathname === '/K3API/BOM/Audit') {
      return jsonResponse(200, { success: true, audited: body.Number })
    }
    return jsonResponse(404, { success: false, message: 'not found' })
  }
  return { calls, fetchImpl }
}

function createK3WebApiSystem(overrides = {}) {
  return {
    id: 'k3_webapi_1',
    tenantId: 'tenant_1',
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
  assert.equal(commaPort.options.encrypt, false, 'K3 SQL Server default encrypt posture stays unchanged')
  assert.equal(commaPort.options.cryptoCredentialsDetails, undefined, 'K3 SQL Server has no legacy TLS options by default')

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

  const namedInstancePort = sqlExecutorInternals.resolveConnectionConfig(createSqlSystem({
    server: 'sql.local\\WISE,14330',
    database: 'AIS_TEST',
  }, credentials))
  assert.equal(namedInstancePort.server, 'sql.local\\WISE')
  assert.equal(namedInstancePort.port, 14330)

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

  const legacyTls = sqlExecutorInternals.resolveConnectionConfig(createSqlSystem({
    server: 'sql.local',
    database: 'AIS_TEST',
    legacyTls: true,
  }, credentials))
  assert.equal(legacyTls.options.encrypt, true, 'legacy TLS keeps the K3 wire encrypted when explicitly enabled')
  assert.deepEqual(legacyTls.options.cryptoCredentialsDetails, {
    minVersion: 'TLSv1',
    ciphers: 'DEFAULT@SECLEVEL=0',
  })

  const explicitLegacyTls = sqlExecutorInternals.resolveConnectionConfig(createSqlSystem({
    server: 'sql.local',
    database: 'AIS_TEST',
    legacyTls: true,
    tlsMinVersion: 'TLSv1.1',
    tlsCiphers: 'HIGH',
  }, credentials))
  assert.equal(explicitLegacyTls.options.encrypt, true)
  assert.deepEqual(explicitLegacyTls.options.cryptoCredentialsDetails, {
    minVersion: 'TLSv1.1',
    ciphers: 'HIGH',
  })

  assert.throws(
    () => sqlExecutorInternals.resolveConnectionConfig(createSqlSystem({
      server: 'sql.local',
      database: 'AIS_TEST',
      legacyTls: true,
      encrypt: false,
    }, credentials)),
    (error) => error && error.code === 'SQLSERVER_TLS_CONFLICT',
    'K3 SQL Server rejects plaintext combined with the legacy TLS downgrade lever',
  )
  assert.throws(
    () => sqlExecutorInternals.resolveConnectionConfig(createSqlSystem({
      server: 'sql.local',
      database: 'AIS_TEST',
      tlsMinVersion: 'TLSv1',
      encrypt: false,
    }, credentials)),
    (error) => error && error.code === 'SQLSERVER_TLS_CONFLICT',
    'K3 SQL Server rejects plaintext combined with an explicit TLS min version',
  )
  assert.throws(
    () => sqlExecutorInternals.resolveConnectionConfig(createSqlSystem({
      server: 'sql.local',
      database: 'AIS_TEST',
      tlsCiphers: 'DEFAULT@SECLEVEL=0',
      encrypt: false,
    }, credentials)),
    (error) => error && error.code === 'SQLSERVER_TLS_CONFLICT',
    'K3 SQL Server rejects plaintext combined with explicit TLS ciphers',
  )
}

function testK3SqlServerExecutorKeepsK3IdentifierPolicy() {
  assert.equal(sqlExecutorInternals.quoteIdentifier('dbo.t_ICItem'), '[dbo].[t_ICItem]')

  assert.throws(
    () => sqlExecutorInternals.quoteIdentifier('tenant.dbo.t_ICItem'),
    (error) => error && error.code === 'SQLSERVER_IDENTIFIER_INVALID',
    'K3 executor must not inherit generic helper multi-part identifier policy',
  )
  assert.throws(
    () => sqlExecutorInternals.quoteIdentifier('2024_orders'),
    (error) => error && error.code === 'SQLSERVER_IDENTIFIER_INVALID',
    'K3 executor must not inherit generic helper numeric-leading identifier policy',
  )

  const request = {
    input() {
      return request
    },
  }
  assert.throws(
    () => sqlExecutorInternals.buildSelectQuery({
      request,
      table: 'tenant.dbo.t_ICItem',
      columns: ['FItemID'],
    }),
    (error) => error && error.code === 'SQLSERVER_IDENTIFIER_INVALID',
    'K3 select builder keeps the K3 table allowlist shape before calling the helper',
  )
  assert.throws(
    () => sqlExecutorInternals.buildSelectQuery({
      request,
      table: 'dbo.t_ICItem',
      columns: ['2024_orders'],
    }),
    (error) => error && error.code === 'SQLSERVER_IDENTIFIER_INVALID',
    'K3 select builder keeps the K3 column shape before calling the helper',
  )
  assert.throws(
    () => sqlExecutorInternals.buildSelectQuery({
      request,
      table: 'dbo.t_ICItem',
      columns: ['FItemID'],
      orderBy: '2024_orders',
    }),
    (error) => error && error.code === 'SQLSERVER_IDENTIFIER_INVALID',
    'K3 select builder keeps the K3 orderBy shape before calling the helper',
  )
  assert.throws(
    () => sqlExecutorInternals.buildSelectQuery({
      request,
      table: 'dbo.t_ICItem',
      columns: ['FItemID'],
      filters: { 'tenant.dbo.FNumber': 'MAT-001' },
    }),
    (error) => error && error.code === 'SQLSERVER_IDENTIFIER_INVALID',
    'K3 select builder keeps the K3 filter field shape before calling the helper',
  )
  assert.throws(
    () => sqlExecutorInternals.buildSelectQuery({
      request,
      table: 'dbo.t_ICItem',
      columns: ['FItemID'],
      watermark: { '2024_updated': '2026-01-01T00:00:00.000Z' },
    }),
    (error) => error && error.code === 'SQLSERVER_IDENTIFIER_INVALID',
    'K3 select builder keeps the K3 watermark field shape before calling the helper',
  )
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

  // [MIGRATED off material, review P2-D1] This case tested the OBJECT-AGNOSTIC previewUpsert
  // mechanism: schema projection dropping client-only fields not in the schema (sourceId,
  // revision, the idempotency key), Token redaction in the preview query, and
  // metadata.autoSubmit/autoAudit passthrough from config. None of that is material business
  // logic — it is the same generic code path BOM goes through. Now that material previewUpsert
  // requires the named customer profile (guard below), a profile-less material call like this
  // one would be refused before it could exercise the mechanism at all, so — same precedent as
  // the write-mechanics cases already migrated off material onto BOM (see the BOM comment
  // above) — this moved to BOM, which is not behind the profile guard. Assertions below are the
  // actual previewUpsert output for BOM (verified by running, not guessed).
  const bomPreview = await adapter.previewUpsert({
    object: 'bom',
    records: [
      {
        FParentItemNumber: 'BOM-PREVIEW-001',
        FChildItemNumber: 'MAT-001',
        FQty: 2,
        FUnitID: 'PCS',
        FEntryID: 1,
        sourceId: 'plm-1',
        revision: 'A',
        _integration_idempotency_key: 'tenant:k3:BOM-PREVIEW-001',
      },
    ],
    keyFields: ['FParentItemNumber'],
  })
  assert.deepEqual(bomPreview.records[0].body, {
    Data: {
      FParentItemNumber: 'BOM-PREVIEW-001',
      FChildItemNumber: 'MAT-001',
      FQty: 2,
      FUnitID: 'PCS',
      FEntryID: 1,
    },
  }, 'preview schema projection drops client-only fields not declared in the BOM schema')
  assert.equal(bomPreview.records[0].query.Token, '<redacted>')
  assert.equal(bomPreview.metadata.autoSubmit, true)
  assert.equal(bomPreview.metadata.autoAudit, true)

  // [KEPT on material, now PROFILED, review P2-D1] This case tests material-specific
  // reference-field projection (k3Template `type: 'reference'` fields: an object value like
  // {FNumber,FName} passes through verbatim; a scalar value is wrapped {[identifier]: value}) —
  // genuine material business semantics (G3), not generic mechanism, so it stays on material.
  // The profile guard now requires the named customer profile before material previewUpsert
  // will even run, so this uses a DEDICATED profiled adapter — `profileSystem()` (defined below,
  // reused here for the same customer-profile config the M1 Save suite exercises) — rather than
  // the shared `adapter` above, which is deliberately kept profile-less to back the guard
  // rejection case right below it. The customer profile's schema differs from the generic
  // default template it replaces: FBaseUnitID is intentionally NOT declared in the profile (see
  // k3-wise-document-templates.cjs) — the projected body below has no FBaseUnitID key, and
  // metadata.k3Template is undefined (k3Template is a profile-forbidden overlay key, deleted by
  // the same sweep that pins savePath/readPath). Both confirmed by actually running this, not
  // assumed.
  const profiledPreviewAdapter = createK3WiseWebApiAdapter({ system: profileSystem(), fetchImpl })
  const referencePreview = await profiledPreviewAdapter.previewUpsert({
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
      FAcctID: { FNumber: '1405' },
    },
  }, 'material reference fields preserve object values, wrap scalar values, and the profile schema drops FBaseUnitID')
  assert.equal(referencePreview.metadata.k3Template, undefined, 'k3Template is a profile-forbidden overlay key — deleted in preview metadata too')

  // RATIFIED GUARD (owner, 20260805): a material upsert with no named customer profile must
  // be refused before any network call — login itself never fires. Legacy/unprofiled configs
  // hit this the first time they try to write.
  const callsBeforeGuardRejection = calls.length
  const guardRejection = await adapter.upsert({
    object: 'material',
    records: [{ FNumber: 'MAT-001', FName: 'Bolt' }],
    keyFields: ['FNumber'],
  }).catch((error) => error)
  assert.ok(guardRejection instanceof AdapterValidationError, 'unprofiled material upsert is refused')
  assert.equal(guardRejection.details.code, 'K3_WISE_MATERIAL_PROFILE_REQUIRED')
  assert.equal(calls.length, callsBeforeGuardRejection, 'unprofiled material upsert makes zero K3 calls (not even login)')

  // NEW GUARD CASE (review P2-D1): previewUpsert must refuse an unprofiled material exactly like
  // upsert does, and just as fast — before ANY network call, not even login. This is the
  // preview-side twin of the RATIFIED GUARD case just above. It runs against the SAME
  // profile-less `adapter` used for that case (the reference-projection case above deliberately
  // used a SEPARATE, profiled adapter instance to arm the guard — it cannot stand in for this
  // negative case, which needs the guard UNarmed).
  const callsBeforePreviewGuardRejection = calls.length
  const previewGuardRejection = await adapter.previewUpsert({
    object: 'material',
    records: [{ FNumber: 'MAT-002', FName: 'Bolt 2' }],
    keyFields: ['FNumber'],
  }).catch((error) => error)
  assert.ok(previewGuardRejection instanceof AdapterValidationError, 'unprofiled material previewUpsert is refused')
  assert.equal(previewGuardRejection.details.code, 'K3_WISE_MATERIAL_PROFILE_REQUIRED')
  assert.equal(
    calls.length,
    callsBeforePreviewGuardRejection,
    'unprofiled material previewUpsert makes zero K3 calls (refusal precedes any network activity)',
  )

  // CONVERTED (G-4, go-live gate: K3 Save/Submit/Audit external write-back is permanently
  // banned). This block drove a BOM upsert to exercise the write mechanics — tri-state
  // autoSubmit/autoAudit, Submit-after-Save ordering, session header, body assembly. The ban is
  // CONNECTOR-WIDE, not material-only (BOM write was already off by owner boundary), so the whole
  // lifecycle-write leg of the adapter is now unreachable and none of those wire-observable facts
  // can be produced any more. What replaces it is the fact that actually matters after G-4: the
  // call is refused, and nothing at all reaches K3.
  //
  // The body-assembly half of the old coverage is NOT lost — it survives on the preview leg,
  // asserted a few lines above for this same BOM object (`bomPreview.records[0].body`), which
  // composes through the identical `buildSaveBody`.
  const callsBeforeBomWrite = calls.length
  const bomWriteRefusal = await adapter.upsert({
    object: 'bom',
    records: [
      { FParentItemNumber: 'BOM-001', FChildItemNumber: 'MAT-001', FQty: 1, FUnitID: 'PCS', FEntryID: 1 },
      { FParentItemNumber: 'BAD', FChildItemNumber: 'MAT-002', FQty: 1, FUnitID: 'PCS', FEntryID: 2 },
    ],
    keyFields: ['FParentItemNumber'],
  }).catch((error) => error)
  assert.ok(bomWriteRefusal instanceof AdapterValidationError, 'G-4: BOM upsert is refused, not written')
  assert.equal(bomWriteRefusal.details.code, 'K3_WISE_EXTERNAL_WRITE_DISABLED')
  assert.equal(calls.length, callsBeforeBomWrite, 'G-4: 0 login calls (the refusal precedes login)')
  assert.equal(calls.filter((call) => call.pathname === '/K3API/BOM/Save').length, 0, 'G-4: 0 Save calls')
  assert.equal(calls.filter((call) => call.pathname === '/K3API/BOM/Submit').length, 0, 'G-4: 0 Submit calls')
  assert.equal(calls.filter((call) => call.pathname === '/K3API/BOM/Audit').length, 0, 'G-4: 0 Audit calls')

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
  assert.equal(
    webApiInternals.responseFailureMessage(
      { StatusCode: 200, Message: '操作成功', Data: [{ FStatus: false, FItemID: 0 }] },
      {},
      { failedRowCount: 1 },
    ),
    'K3 WISE save failed row-level success gate (failedRowCount=1)',
    'Chinese success-like envelope message is synthesized when row-level success fails',
  )
  assert.equal(
    webApiInternals.responseFailureMessage(
      { StatusCode: 200, Message: '未成功', Data: [{ FStatus: false, FItemID: 0 }] },
      {},
      { failedRowCount: 1 },
    ),
    '未成功',
    'Chinese negated-success message is preserved as a real failure message',
  )

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
  assert.equal(auditInternals.classifyK3WiseCall('/K3API/Material/GetDetail', 'read'), 'materialGetDetail')
  assert.equal(auditInternals.classifyK3WiseCall('/K3API/Material/GetList', 'read'), 'materialGetList')
  assert.equal(auditInternals.classifyK3WiseCall('/K3API/Material/Save.ashx', 'lifecycle-write'), 'materialSave')
  assert.equal(auditInternals.classifyK3WiseCall('/K3API/Material/Submit', 'lifecycle-write'), 'materialSubmit')
  assert.equal(auditInternals.classifyK3WiseCall('/K3API/Material/Audit', 'lifecycle-write'), 'materialAudit')
  assert.equal(auditInternals.classifyK3WiseCall('/K3API/BOM/Save', 'lifecycle-write'), 'otherLifecycleWrite')
  assert.equal(auditInternals.classifyK3WiseCall('/K3API/Token/Create', 'read'), 'otherRead')
  const { calls, fetchImpl } = createK3FetchMock()
  const auditBefore = getK3WiseCallAuditSnapshot({ tenantId: 'tenant_1' })
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

  const auditAfter = getK3WiseCallAuditSnapshot({ tenantId: 'tenant_1' })
  assert.match(auditAfter.processEpoch, /^[0-9a-f]{32}$/)
  assert.equal(auditAfter.processEpoch, auditBefore.processEpoch, 'same-process snapshots carry the same epoch')
  assert.deepEqual(
    Object.keys(auditAfter.counts),
    [...K3_WISE_CALL_AUDIT_OPERATIONS],
    'the operational evidence uses a closed values-free key set',
  )
  assert.equal(auditAfter.counts.materialGetDetail - auditBefore.counts.materialGetDetail, 1)
  assert.equal(auditAfter.counts.materialSave - auditBefore.counts.materialSave, 0)
  assert.equal(auditAfter.counts.materialSubmit - auditBefore.counts.materialSubmit, 0)
  assert.equal(auditAfter.counts.materialAudit - auditBefore.counts.materialAudit, 0)
  const auditText = JSON.stringify(auditAfter)
  for (const forbidden of ['MAT-GATE-001', 'k3.example.test', 'k3-session-1', 'k3-token-1']) {
    assert.equal(auditText.includes(forbidden), false, `call-audit snapshot must not expose ${forbidden}`)
  }
  const otherTenantAudit = getK3WiseCallAuditSnapshot({ tenantId: 'tenant_other' })
  assert.ok(Object.values(otherTenantAudit.counts).every((count) => count === 0), 'another tenant sees an isolated partition')

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

async function testK3WebApiMaterialListReadSmoke() {
  const { calls, fetchImpl } = createK3FetchMock()
  const listPreset = getReadSmokePreset('k3wise.material-list.v1')
  const buildMarkedListRequest = (contract = { object: 'material', mode: 'list' }, limit = 2) => {
    const request = buildReadSmokeRequest(listPreset, contract)
    request.limit = limit
    return request
  }
  const markedListRequestWith = (patch, limit = 2) => Object.assign(buildMarkedListRequest({ object: 'material', mode: 'list' }, limit), patch)
  const adapter = createK3WiseWebApiAdapter({
    system: createK3WebApiSystem({
      config: {
        baseUrl: 'https://k3.example.test',
        autoSubmit: false,
        autoAudit: false,
        objects: {
          material: {
            operations: ['read'],
            readPath: '/K3API/Material/GetList',
            readMethod: 'POST',
            readMode: 'list',
            readListBodyTemplate: { Data: { Top: 10, PageIndex: 1 } },
            readListFields: ['FNumber', 'FName', 'FModel', 'FUnitID'],
            readListOrderBy: 'FNumber',
            readListFilterField: 'FNumber',
            readListFilterMode: 'contains_like',
            readListFilterEscape: 'k3_freeform',
            topField: 'Top',
            pageIndexField: 'PageIndex',
            pageSizeField: 'PageSize',
            maxListLimit: 3,
          },
        },
      },
    }),
    fetchImpl,
  })

  const unmarked = await adapter.read({
    object: 'material',
    limit: 2,
    options: { k3ReadMode: 'list' },
  }).catch((error) => error)
  assert.ok(unmarked instanceof AdapterValidationError, 'LIST cannot be triggered outside the read-smoke route')
  assert.equal(unmarked.details.code, 'K3_WISE_READ_LIST_ROUTE_UNSUPPORTED')
  assert.equal(calls.some((call) => call.pathname === '/K3API/Material/GetList'), false, 'unmarked LIST fails before the K3 GetList call')

  const read = await adapter.read(buildMarkedListRequest())

  assert.equal(read.records.length, 2, 'Material/GetList smoke returns only the bounded requested count')
  assert.equal(read.nextCursor, null, 'bounded LIST smoke is a one-page probe with no cursor')
  assert.equal(read.done, true, 'bounded LIST smoke is terminal')
  assert.equal(read.metadata.mode, 'material-list-smoke')
  assert.equal(read.metadata.readOnly, true)
  assert.equal(read.metadata.requestedLimit, 2)
  assert.equal(read.metadata.returnedRecordCount, 2)
  assert.equal(read.metadata.dataDataPresent, true)
  assert.equal(read.metadata.dataRowCount, 3)
  // Paging echo (#1709): K3 echoes the page size/index it applied; we surface requested-vs-echoed (values-free).
  assert.equal(read.metadata.dataPageSize, 2, 'LIST surfaces K3-echoed Data.PAGESIZE')
  assert.equal(read.metadata.dataPageIndex, 1, 'LIST surfaces K3-echoed Data.PAGEINDEX')
  assert.equal(read.metadata.requestedLimit, 2, 'LIST surfaces requested page size/Top')
  assert.equal(read.metadata.requestedPageIndex, 1, 'LIST surfaces requested PageIndex')
  assert.deepEqual(read.metadata.listShapeProbe, {
    dataData: true,
    dataLowerData: false,
    dataPascalData: false,
    dataRows: false,
    resultData: false,
    resultRows: false,
    rows: false,
    topLevelArray: false,
  })
  assert.deepEqual(read.metadata.responseShapeProbe, {
    dataObjectPresent: true,
    dataRowCountPresent: true,
    dataPageSizePresent: true,
    dataPageIndexPresent: true,
    dataDataType: 'array',
    dataDataArrayLength: 3,
    fixedContainers: {
      dataData: { type: 'array', arrayLength: 3 },
      dataLowerData: { type: 'missing', arrayLength: null },
      dataPascalData: { type: 'missing', arrayLength: null },
      dataRows: { type: 'missing', arrayLength: null },
      dataList: { type: 'missing', arrayLength: null },
      dataItems: { type: 'missing', arrayLength: null },
      resultData: { type: 'missing', arrayLength: null },
      resultRows: { type: 'missing', arrayLength: null },
      rows: { type: 'missing', arrayLength: null },
      topLevel: { type: 'object', arrayLength: null },
    },
  }, 'LIST response-shape probe surfaces fixed container types/counts only')
  assert.equal(read.metadata.readPath, '/K3API/Material/GetList')

  const listCalls = calls.filter((call) => call.pathname === '/K3API/Material/GetList')
  assert.equal(listCalls.length, 1, 'LIST smoke calls Material/GetList once')
  assert.equal(listCalls[0].options.method, 'POST')
  assert.equal(listCalls[0].options.headers['X-K3-Session'], 'k3-session-1')
  assert.deepEqual(listCalls[0].body, {
    Data: {
      Top: 2,
      PageIndex: 1,
      PageSize: 2,
      Fields: 'FNumber,FName,FModel,FUnitID',
      OrderBy: 'FNumber',
    },
  })
  const filteredByKey = await adapter.read(buildMarkedListRequest({ object: 'material', mode: 'list', key: "MAT-'A" }))
  assert.equal(filteredByKey.records.length, 2, 'LIST key is an internal bounded filter input, not a caller raw filter')
  const filteredCall = calls.filter((call) => call.pathname === '/K3API/Material/GetList').at(-1)
  assert.equal(filteredCall.body.Data.Filter, "FNumber like '%MAT-''A%'", 'LIST key is mapped to the documented K3 contains-like filter')
  const wildcardKey = await adapter.read(buildMarkedListRequest({ object: 'material', mode: 'list', key: 'MAT_001' }))
  assert.equal(wildcardKey.records.length, 2, 'LIST wildcard-shaped key still runs as a bounded internal input')
  const wildcardCall = calls.filter((call) => call.pathname === '/K3API/Material/GetList').at(-1)
  assert.equal(wildcardCall.body.Data.Filter, "FNumber like '%MAT_001%'", 'LIST key uses K3 freeform quoting instead of T-SQL bracket escaping')
  // Bounded pageIndex (#3703): the requested page reaches the K3 body and the values-free paging echo.
  const pagedRead = await adapter.read(buildMarkedListRequest({ object: 'material', mode: 'list', pageIndex: 3 }))
  const pagedCall = calls.filter((call) => call.pathname === '/K3API/Material/GetList').at(-1)
  assert.equal(pagedCall.body.Data.PageIndex, 3, 'bounded pageIndex reaches the K3 request body')
  assert.equal(pagedCall.body.Data.Top, 2, 'paged LIST keeps the bounded Top')
  assert.equal(pagedCall.body.Data.PageSize, 2, 'paged LIST keeps the bounded PageSize')
  assert.equal(pagedRead.metadata.requestedPageIndex, 3, 'paged LIST surfaces the requested page in the echo')
  // Out-of-bound / non-integer pageIndex fails closed BEFORE any K3 call (defense-in-depth re-guard).
  for (const badPage of [0, 11, 1.5, '3', null]) {
    const before = calls.filter((call) => call.pathname === '/K3API/Material/GetList').length
    const rejected = await adapter.read(markedListRequestWith({ options: Object.assign(buildMarkedListRequest().options, { listPageIndex: badPage }) })).catch((error) => error)
    assert.ok(rejected instanceof AdapterValidationError, `pageIndex ${JSON.stringify(badPage)} must be rejected`)
    assert.equal(rejected.details.code, 'K3_WISE_READ_LIST_PAGE_INDEX_INVALID')
    assert.equal(calls.filter((call) => call.pathname === '/K3API/Material/GetList').length, before, 'rejected pageIndex produces no K3 GetList call')
  }
  assert.equal(calls.some((call) => call.pathname === '/K3API/Material/Save'), false, 'LIST smoke must not Save')
  assert.equal(calls.some((call) => call.pathname === '/K3API/Material/Submit'), false, 'LIST smoke must not Submit')
  assert.equal(calls.some((call) => call.pathname === '/K3API/Material/Audit'), false, 'LIST smoke must not Audit')

  const filtered = await adapter.read(markedListRequestWith({
    filters: { FNumber: 'MAT-LIST-001' },
  })).catch((error) => error)
  assert.ok(filtered instanceof AdapterValidationError, 'LIST smoke rejects request-supplied filters')
  assert.equal(filtered.details.code, 'K3_WISE_READ_LIST_FILTER_UNSUPPORTED')

  const cursorRead = await adapter.read(markedListRequestWith({
    cursor: 'next-page',
  })).catch((error) => error)
  assert.ok(cursorRead instanceof AdapterValidationError, 'LIST smoke rejects cursor pagination')
  assert.equal(cursorRead.details.code, 'K3_WISE_READ_LIST_CURSOR_UNSUPPORTED')

  const watermarkRead = await adapter.read(markedListRequestWith({
    watermark: { FModifyDate: '2026-05-01T00:00:00Z' },
  })).catch((error) => error)
  assert.ok(watermarkRead instanceof AdapterValidationError, 'LIST smoke rejects watermark reads')
  assert.equal(watermarkRead.details.code, 'K3_WISE_READ_LIST_WATERMARK_UNSUPPORTED')

  const tooLarge = await adapter.read(buildMarkedListRequest({ object: 'material', mode: 'list' }, 4)).catch((error) => error)
  assert.ok(tooLarge instanceof AdapterValidationError, 'LIST smoke rejects limits above the preset bound')
  assert.equal(tooLarge.details.code, 'K3_WISE_READ_LIST_LIMIT_EXCEEDED')

  // C3 LIST paging-echo diagnostic (#1709): the live no-key signature — K3 reports rows exist (ROWCOUNT>0) but
  // returns a null DATA page and echoes a page size/index that does NOT match what we requested. Surfacing
  // requested-vs-echoed paging (values-free counts) localizes a paging-param mismatch with no customer round-trip.
  const pagingEchoFetchImpl = async (url, options) => {
    const parsed = new URL(url)
    if (parsed.pathname === '/K3API/Material/GetList') {
      return jsonResponse(200, {
        StatusCode: 200,
        Message: 'Material list succeeded',
        Data: { ROWCOUNT: 30134, PAGESIZE: 0, PAGEINDEX: 0, DATA: null },
      })
    }
    return fetchImpl(url, options)
  }
  const pagingEchoAdapter = createK3WiseWebApiAdapter({
    system: createK3WebApiSystem({
      config: {
        baseUrl: 'https://k3.example.test',
        objects: {
          material: {
            operations: ['read'],
            readPath: '/K3API/Material/GetList',
            readMethod: 'POST',
            readMode: 'list',
            readListBodyTemplate: { Data: { Top: 10, PageIndex: 1 } },
            pageIndexField: 'PageIndex',
            pageSizeField: 'PageSize',
            maxListLimit: 3,
          },
        },
      },
    }),
    fetchImpl: pagingEchoFetchImpl,
  })
  const pagingEcho = await pagingEchoAdapter.read(buildMarkedListRequest({ object: 'material', mode: 'list' }, 2))
  assert.equal(pagingEcho.records.length, 0, 'paging-echo list returns an empty bounded page, not a crash')
  assert.equal(pagingEcho.metadata.dataRowCount, 30134, 'K3 reports rows exist via Data.ROWCOUNT')
  assert.equal(pagingEcho.metadata.dataPageSize, 0, 'K3 echoes the page size it applied (0 here = did not accept requested page)')
  assert.equal(pagingEcho.metadata.dataPageIndex, 0, 'K3 echoes the page index it applied')
  assert.equal(pagingEcho.metadata.requestedLimit, 2, 'requested page size/Top surfaced for the requested-vs-echoed comparison')
  assert.equal(pagingEcho.metadata.requestedPageIndex, 1, 'requested page index surfaced for the comparison')
  assert.deepEqual(pagingEcho.metadata.responseShapeProbe, {
    dataObjectPresent: true,
    dataRowCountPresent: true,
    dataPageSizePresent: true,
    dataPageIndexPresent: true,
    dataDataType: 'null',
    dataDataArrayLength: null,
    fixedContainers: {
      dataData: { type: 'null', arrayLength: null },
      dataLowerData: { type: 'missing', arrayLength: null },
      dataPascalData: { type: 'missing', arrayLength: null },
      dataRows: { type: 'missing', arrayLength: null },
      dataList: { type: 'missing', arrayLength: null },
      dataItems: { type: 'missing', arrayLength: null },
      resultData: { type: 'missing', arrayLength: null },
      resultRows: { type: 'missing', arrayLength: null },
      rows: { type: 'missing', arrayLength: null },
      topLevel: { type: 'object', arrayLength: null },
    },
  }, 'paging-echo response-shape probe makes DATA=null explicit without changing extraction')

  // C3 LIST PascalCase row container (#1709): the live K3 instance returns rows at Data.Data (PascalCase) with
  // PascalCase RowCount/PageSize/PageIndex. Confirm extraction + that dataDataPresent reflects Data.Data (no
  // recordPresent=true with dataDataPresent=false), without removing the Data.DATA / Data.data compat paths.
  const pascalFetchImpl = async (url, options) => {
    const parsed = new URL(url)
    if (parsed.pathname === '/K3API/Material/GetList') {
      return jsonResponse(200, {
        StatusCode: 200,
        Message: 'Material list succeeded',
        Data: {
          RowCount: 30134,
          PageSize: 10,
          PageIndex: 1,
          Top: 10,
          Data: [
            { FNumber: 'MAT-PASCAL-001', FName: 'P1' },
            { FNumber: 'MAT-PASCAL-002', FName: 'P2' },
          ],
        },
      })
    }
    return fetchImpl(url, options)
  }
  const pascalAdapter = createK3WiseWebApiAdapter({
    system: createK3WebApiSystem({
      config: {
        baseUrl: 'https://k3.example.test',
        objects: {
          material: {
            operations: ['read'],
            readPath: '/K3API/Material/GetList',
            readMethod: 'POST',
            readMode: 'list',
            readListBodyTemplate: { Data: { Top: 10, PageIndex: 1 } },
            pageIndexField: 'PageIndex',
            pageSizeField: 'PageSize',
            maxListLimit: 3,
          },
        },
      },
    }),
    fetchImpl: pascalFetchImpl,
  })
  const pascal = await pascalAdapter.read(buildMarkedListRequest({ object: 'material', mode: 'list' }, 2))
  assert.equal(pascal.records.length, 2, 'rows extracted from the PascalCase Data.Data container (bounded to limit)')
  assert.equal(pascal.records[0].FNumber, 'MAT-PASCAL-001', 'PascalCase Data.Data rows are returned')
  assert.equal(pascal.metadata.dataDataPresent, true, 'dataDataPresent reflects Data.Data (no recordPresent-true / dataDataPresent-false split)')
  assert.equal(pascal.metadata.dataRowCount, 30134, 'PascalCase Data.RowCount surfaced')
  assert.equal(pascal.metadata.dataPageSize, 10, 'PascalCase Data.PageSize surfaced')
  assert.equal(pascal.metadata.dataPageIndex, 1, 'PascalCase Data.PageIndex surfaced')
  assert.equal(pascal.metadata.listShapeProbe.dataPascalData, true, 'shape probe flags the PascalCase container')
  assert.equal(pascal.metadata.listShapeProbe.dataData, false, 'all-caps Data.DATA absent in the PascalCase response')
  assert.equal(pascal.metadata.responseShapeProbe.fixedContainers.dataPascalData.type, 'array', 'response-shape probe localizes Data.Data as an array')
  assert.equal(pascal.metadata.responseShapeProbe.fixedContainers.dataPascalData.arrayLength, 2)

  const missingRowsFetchImpl = async (url, options) => {
    const parsed = new URL(url)
    if (parsed.pathname === '/K3API/Material/GetList') {
      return jsonResponse(200, {
        StatusCode: 200,
        Message: 'Material list succeeded',
        Data: { ROWCOUNT: 0, DATA: null },
      })
    }
    return fetchImpl(url, options)
  }
  const missingRowsAdapter = createK3WiseWebApiAdapter({
    system: createK3WebApiSystem({
      config: {
        baseUrl: 'https://k3.example.test',
        objects: {
          material: {
            operations: ['read'],
            readPath: '/K3API/Material/GetList',
            readMethod: 'POST',
            readMode: 'list',
            readListBodyTemplate: { Data: { Top: 10, PageIndex: 1 } },
            pageIndexField: 'PageIndex',
            pageSizeField: 'PageSize',
            maxListLimit: 3,
          },
        },
      },
    }),
    fetchImpl: missingRowsFetchImpl,
  })
  const missingRows = await missingRowsAdapter.read(buildMarkedListRequest({ object: 'material', mode: 'list' }, 2))
  assert.equal(missingRows.records.length, 0, 'LIST success envelope with ROWCOUNT=0 and DATA=null remains an empty bounded page')
  assert.equal(missingRows.metadata.dataDataPresent, false, 'LIST success evidence carries a values-free rows-shape diagnostic')
  assert.equal(missingRows.metadata.dataRowCount, 0, 'LIST success evidence carries values-free Data.ROWCOUNT')
  assert.deepEqual(missingRows.metadata.listShapeProbe, {
    dataData: false,
    dataLowerData: false,
    dataPascalData: false,
    dataRows: false,
    resultData: false,
    resultRows: false,
    rows: false,
    topLevelArray: false,
  })
  assert.equal(missingRows.metadata.responseShapeProbe.dataRowCountPresent, true)
  assert.equal(missingRows.metadata.responseShapeProbe.dataDataType, 'null')
  assert.deepEqual(missingRows.metadata.responseShapeProbe.fixedContainers.dataData, { type: 'null', arrayLength: null })

  const alternateRowsFetchImpl = async (url, options) => {
    const parsed = new URL(url)
    if (parsed.pathname === '/K3API/Material/GetList') {
      return jsonResponse(200, {
        StatusCode: 200,
        Message: 'Material list succeeded',
        Result: { Rows: [{ FNumber: 'SECRET-MAT' }] },
      })
    }
    return fetchImpl(url, options)
  }
  const alternateRowsAdapter = createK3WiseWebApiAdapter({
    system: createK3WebApiSystem({
      config: {
        baseUrl: 'https://k3.example.test',
        objects: {
          material: {
            operations: ['read'],
            readPath: '/K3API/Material/GetList',
            readMethod: 'POST',
            readMode: 'list',
            readListBodyTemplate: { Data: { Top: 10, PageIndex: 1 } },
            pageIndexField: 'PageIndex',
            pageSizeField: 'PageSize',
            maxListLimit: 3,
          },
        },
      },
    }),
    fetchImpl: alternateRowsFetchImpl,
  })
  const alternateRows = await alternateRowsAdapter.read(buildMarkedListRequest({ object: 'material', mode: 'list' }, 2))
  assert.equal(alternateRows.records.length, 0, 'shape probe does not silently widen the extractor')
  assert.equal(alternateRows.metadata.dataDataPresent, false)
  assert.equal(alternateRows.metadata.dataRowCount, null)
  assert.deepEqual(alternateRows.metadata.listShapeProbe, {
    dataData: false,
    dataLowerData: false,
    dataPascalData: false,
    dataRows: false,
    resultData: false,
    resultRows: true,
    rows: false,
    topLevelArray: false,
  }, 'LIST shape probe localizes rows under a fixed allowlisted alternate container')
  assert.deepEqual(alternateRows.metadata.responseShapeProbe.fixedContainers.resultRows, { type: 'array', arrayLength: 1 })
  assert.deepEqual(alternateRows.metadata.responseShapeProbe.fixedContainers.topLevel, { type: 'object', arrayLength: null })
  assert.equal(alternateRows.metadata.responseShapeProbe.dataDataType, 'missing')

  const rejectedFetchImpl = async (url, options) => {
    const parsed = new URL(url)
    if (parsed.pathname === '/K3API/Material/GetList') {
      return jsonResponse(200, {
        StatusCode: 200,
        Message: 'Material list rejected',
        Data: { Code: 'N', DATA: [{ FNumber: 'SECRET-MAT' }] },
      })
    }
    return fetchImpl(url, options)
  }
  const rejectedAdapter = createK3WiseWebApiAdapter({
    system: createK3WebApiSystem({
      config: {
        baseUrl: 'https://k3.example.test',
        objects: {
          material: {
            operations: ['read'],
            readPath: '/K3API/Material/GetList',
            readMethod: 'POST',
            readMode: 'list',
            readListBodyTemplate: { Data: { Top: 10, PageIndex: 1 } },
            pageIndexField: 'PageIndex',
            pageSizeField: 'PageSize',
            maxListLimit: 3,
          },
        },
      },
    }),
    fetchImpl: rejectedFetchImpl,
  })
  const rejected = await rejectedAdapter.read(buildMarkedListRequest({ object: 'material', mode: 'list' }, 2)).catch((error) => error)
  assert.ok(rejected instanceof K3WiseWebApiAdapterError, 'LIST explicit failure marker is rejected before row extraction')
  assert.equal(rejected.details.code, 'K3_WISE_READ_LIST_REJECTED')
  assert.equal(rejected.details.dataDataPresent, true)
  assert.equal(rejected.details.dataRowCount, null)
  assert.deepEqual(rejected.details.listShapeProbe, {
    dataData: true,
    dataLowerData: false,
    dataPascalData: false,
    dataRows: false,
    resultData: false,
    resultRows: false,
    rows: false,
    topLevelArray: false,
  })
  assert.equal(rejected.details.responseShapeProbe.dataDataType, 'array')
  assert.deepEqual(rejected.details.responseShapeProbe.fixedContainers.dataData, { type: 'array', arrayLength: 1 })

  const unrecognizedFetchImpl = async (url, options) => {
    const parsed = new URL(url)
    if (parsed.pathname === '/K3API/Material/GetList') {
      return jsonResponse(200, {
        Message: 'Material list payload with no success marker',
        Data: { DATA: [{ FNumber: 'SECRET-MAT' }] },
      })
    }
    return fetchImpl(url, options)
  }
  const unrecognizedAdapter = createK3WiseWebApiAdapter({
    system: createK3WebApiSystem({
      config: {
        baseUrl: 'https://k3.example.test',
        objects: {
          material: {
            operations: ['read'],
            readPath: '/K3API/Material/GetList',
            readMethod: 'POST',
            readMode: 'list',
            readListBodyTemplate: { Data: { Top: 10, PageIndex: 1 } },
            pageIndexField: 'PageIndex',
            pageSizeField: 'PageSize',
            maxListLimit: 3,
          },
        },
      },
    }),
    fetchImpl: unrecognizedFetchImpl,
  })
  const unrecognized = await unrecognizedAdapter.read(buildMarkedListRequest({ object: 'material', mode: 'list' }, 2)).catch((error) => error)
  assert.ok(unrecognized instanceof K3WiseWebApiAdapterError, 'LIST rows under Data.DATA with an unrecognized envelope gets a response-shape diagnostic')
  assert.equal(unrecognized.details.code, 'K3_WISE_READ_LIST_ENVELOPE_UNRECOGNIZED')
  assert.equal(unrecognized.details.dataDataPresent, true)
  assert.equal(unrecognized.details.dataRowCount, null)
  assert.deepEqual(unrecognized.details.listShapeProbe, {
    dataData: true,
    dataLowerData: false,
    dataPascalData: false,
    dataRows: false,
    resultData: false,
    resultRows: false,
    rows: false,
    topLevelArray: false,
  })
  assert.equal(unrecognized.details.responseShapeProbe.dataDataType, 'array')
  assert.deepEqual(unrecognized.details.responseShapeProbe.fixedContainers.dataData, { type: 'array', arrayLength: 1 })

  const modeMismatch = await adapter.read({
    object: 'material',
    filters: { FNumber: 'MAT-LIST-001' },
    options: { k3ReadMode: 'single_record_detail' },
  }).catch((error) => error)
  assert.ok(modeMismatch instanceof AdapterValidationError, 'list-mode object config cannot be used as a detail read')
  assert.equal(modeMismatch.details.code, 'K3_WISE_READ_MODE_MISMATCH')

  const detailConfigAdapter = createK3WiseWebApiAdapter({
    system: createK3WebApiSystem({
      config: {
        baseUrl: 'https://k3.example.test',
        objects: {
          material: {
            operations: ['read'],
            readPath: '/K3API/Material/GetDetail',
          },
        },
      },
    }),
    fetchImpl,
  })
  const listWithoutConfig = await detailConfigAdapter.read(buildMarkedListRequest({ object: 'material', mode: 'list' }, 2)).catch((error) => error)
  assert.ok(listWithoutConfig instanceof AdapterValidationError, 'LIST cannot be activated by request option without list-mode config')
  assert.equal(listWithoutConfig.details.code, 'K3_WISE_READ_LIST_NOT_CONFIGURED')
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
        objects: { material: { profile: 'material-k3wise-customer-profile-v1' } },
      },
    }),
    fetchImpl,
  })

  const connection = await adapter.testConnection({ skipHealth: true })
  assert.equal(connection.ok, true, 'authorityCode token testConnection succeeds')
  assert.equal(connection.authenticated, true, 'query-token auth counts as authenticated')

  // CONVERTED (G-4). The authorityCode token was previously proven to be CACHED across
  // testConnection and a subsequent write — the write is what re-used the token. The write leg
  // is now permanently refused before login, so no second token acquisition can be triggered
  // from it, and the caching property is asserted on the surface that still exists: two
  // consecutive testConnection calls must still share ONE Token/Create.
  const tokensAfterFirstConnection = calls.filter((call) => call.pathname === '/K3API/Token/Create').length
  assert.equal(tokensAfterFirstConnection, 1, 'testConnection acquires exactly one authorityCode token')
  await adapter.testConnection({ skipHealth: true })
  assert.equal(
    calls.filter((call) => call.pathname === '/K3API/Token/Create').length,
    1,
    'the authorityCode token is CACHED — a second testConnection does not re-acquire it',
  )
  assert.equal(calls.filter((call) => call.pathname === '/K3API/Token/Create')[0].query.authorityCode, 'auth-code-1')

  const callsBeforeTokenWrite = calls.length
  const tokenWriteRefusal = await adapter.upsert({
    object: 'material',
    records: [{ FNumber: 'MAT-TOKEN-001', FName: 'Token material' }],
    keyFields: ['FNumber'],
  }).catch((error) => error)
  assert.ok(tokenWriteRefusal instanceof AdapterValidationError, 'G-4: a token-authenticated write is refused too')
  assert.equal(tokenWriteRefusal.details.code, 'K3_WISE_EXTERNAL_WRITE_DISABLED')
  assert.equal(calls.length, callsBeforeTokenWrite, 'G-4: 0 further calls — no token refresh, no login')
  assert.equal(calls.filter((call) => call.pathname === '/K3API/Material/Save').length, 0, 'G-4: 0 Save calls')

  // The Save body / query composition the old assertions read off the wire is still proven, on
  // the preview leg, which builds both through the same code the Save leg used.
  const tokenPreview = await adapter.previewUpsert({
    object: 'material',
    records: [{ FNumber: 'MAT-TOKEN-001', FName: 'Token material' }],
    keyFields: ['FNumber'],
  })
  assert.deepEqual(tokenPreview.records[0].body, { Data: { FNumber: 'MAT-TOKEN-001', FName: 'Token material' } })
  assert.equal(tokenPreview.records[0].query.Token, '<redacted>', 'the token rides the query param, redacted in preview')
}

async function testK3WebApiSaveBusinessEvidence() {
  const { calls, fetchImpl } = createK3FetchMock()
  const adapter = createK3WiseWebApiAdapter({
    system: createK3WebApiSystem({
      config: {
        baseUrl: 'https://k3.example.test',
        autoSubmit: false,
        autoAudit: false,
        objects: { material: { profile: 'material-k3wise-customer-profile-v1' } },
      },
    }),
    fetchImpl,
  })

  // CONVERTED (G-4). This used to drive two real Save batches and read the row-level
  // business-response parsing off the returned `results`/`errors`/`metadata.businessResponses`.
  // The Save leg is permanently refused now, so the ONLY honest way to keep the parsing coverage
  // is to feed the very same K3 envelopes (copied from this file's own fetch mock above, so the
  // fixtures cannot drift apart) straight into the exported parsers the Save leg called.
  //
  // STATED EXACTLY — what this conversion keeps and what it drops:
  //   KEPT  the row-level success gate (an envelope that says "Successful" while its row says
  //         FStatus:false is a FAILURE), the failure-message extraction, and the externalId
  //         extraction — all three via the module's existing `__internals` surface.
  //   DROPS (a) the `metadata.businessResponses` per-attempt AGGREGATION assertions, built by
  //         `createBusinessResponseSummary`; (b) the row failure-code mapping, via
  //         `responseFailureCode`. NEITHER function is on the module's test surface, and both
  //         only ever described a batch of Saves — with no Save possible they describe nothing.
  //         Deliberately NOT re-derived by adding new production exports: widening a production
  //         surface to keep testing permanently-dead code is the wrong trade. The closed-token
  //         disposition a K3 row failure surfaces upward is separately pinned, on live code, in
  //         k3-wise-c6-write-profile.test.cjs.
  const saveConfig = {}
  const envelopes = {
    ROWOK: { StatusCode: 200, Message: 'Successful', Data: [{ FStatus: true, FItemID: 1001, FNumber: 'ROWOK' }] },
    ROWFAIL: { StatusCode: 200, Message: 'Successful', Data: [{ FStatus: false, FItemID: 0, FMessage: 'unit group parameter invalid' }] },
    STATUS201: { StatusCode: 201, Message: 'Faild', Data: [{ FStatus: false, FItemID: 0, FMessage: 'required unit missing' }] },
    AMBIGUOUSFAIL: { StatusCode: 200, Message: 'Successful', Data: [{ FStatus: false, FItemID: 0 }] },
    CHINESENEGFAIL: { StatusCode: 200, Message: 'Successful', Data: [{ FStatus: false, FItemID: 0, FMessage: '操作不成功' }] },
  }
  assert.equal(webApiInternals.saveBusinessSuccess(envelopes.ROWOK, saveConfig), true, 'a genuinely positive row is a success')
  assert.equal(webApiInternals.saveBusinessSuccess(envelopes.ROWFAIL, saveConfig), false, 'FStatus:false is a failure')
  assert.equal(webApiInternals.saveBusinessSuccess(envelopes.STATUS201, saveConfig), false, 'a non-2xx envelope is a failure')
  assert.equal(
    webApiInternals.saveBusinessSuccess(envelopes.AMBIGUOUSFAIL, saveConfig),
    false,
    'ROW-LEVEL SUCCESS GATE: "Successful" at the envelope must not override FStatus:false on the row',
  )
  assert.equal(webApiInternals.saveBusinessSuccess(envelopes.CHINESENEGFAIL, saveConfig), false, 'a Chinese negated success row is a failure')
  assert.equal(webApiInternals.responseExternalId(envelopes.ROWOK, saveConfig), 1001, 'positive FItemID is surfaced as external id')
  assert.match(webApiInternals.responseFailureMessage(envelopes.ROWFAIL, saveConfig, null), /unit group/i)
  assert.match(webApiInternals.responseFailureMessage(envelopes.STATUS201, saveConfig, null), /required unit/i)
  assert.equal(webApiInternals.responseFailureMessage(envelopes.CHINESENEGFAIL, saveConfig, null), '操作不成功')
  assert.match(
    webApiInternals.responseFailureMessage(envelopes.AMBIGUOUSFAIL, saveConfig, { failedRowCount: 1 }),
    /row-level success gate.*failedRowCount=1/,
    'a row failure with no message falls back to the gate wording plus values-free counts',
  )

  // And the write leg those envelopes would have travelled on: permanently refused, zero calls.
  const callsBeforeEvidenceWrite = calls.length
  const evidenceRefusal = await adapter.upsert({
    object: 'material',
    records: [
      { FNumber: 'ROWOK', FName: 'Positive row' },
      { FNumber: 'ROWFAIL', FName: 'Business row fail' },
      { FNumber: 'STATUS201', FName: 'Envelope fail' },
    ],
    keyFields: ['FNumber'],
  }).catch((error) => error)
  assert.ok(evidenceRefusal instanceof AdapterValidationError, 'G-4: refused')
  assert.equal(evidenceRefusal.details.code, 'K3_WISE_EXTERNAL_WRITE_DISABLED')
  assert.equal(calls.length, callsBeforeEvidenceWrite, 'G-4: 0 login calls')
  assert.equal(calls.filter((call) => call.pathname === '/K3API/Material/Save').length, 0, 'G-4: 0 Save calls')
}

// Keystone (M1 fix): a customer K3 that nests the per-row payload under Data[0].Data
// must have its success/message/id parsed from the nested object, not the bare wrapper.
// Pre-fix this was a parse-induced false-negative (a real success read as failed).
async function testK3WebApiNestedDataSaveParse() {
  const { calls, fetchImpl } = createK3FetchMock()
  const adapter = createK3WiseWebApiAdapter({
    system: createK3WebApiSystem({
      config: {
        baseUrl: 'https://k3.example.test',
        autoSubmit: false,
        autoAudit: false,
        objects: { material: { profile: 'material-k3wise-customer-profile-v1' } },
      },
    }),
    fetchImpl,
  })

  // CONVERTED (G-4), same disposition and same reasoning as testK3WebApiSaveBusinessEvidence
  // above: the KEYSTONE property here is a PARSE property (a customer K3 that nests the per-row
  // payload one level deeper must have success/message/id read from the nested object, not the
  // bare wrapper — pre-fix a real success was read as a failure). That property lives entirely in
  // the exported parsers and is reproduced against the identical envelopes the fetch mock above
  // returns, so the keystone regression stays covered without a Save.
  const nestedConfig = {}
  const nestedOk = { StatusCode: 200, Message: 'Successful', Data: [{ FNumber: 'NESTEDOK', Data: { FStatus: true, FItemID: 2002, FNumber: 'NESTEDOK' } }] }
  const nestedFail = { StatusCode: 200, Message: 'Successful', Data: [{ FNumber: 'NESTEDFAIL', Data: { FStatus: false, FItemID: 0, FMessage: 'nested unit group parameter invalid' } }] }
  const flatOk = { StatusCode: 200, Message: 'Successful', Data: [{ FStatus: true, FItemID: 1001, FNumber: 'ROWOK' }] }

  assert.equal(webApiInternals.saveBusinessSuccess(nestedOk, nestedConfig), true, 'nested Data[0].Data success is recognized (pre-fix: false-negative)')
  assert.equal(webApiInternals.saveBusinessSuccess(nestedFail, nestedConfig), false, 'nested Data[0].Data failure is recognized')
  assert.equal(webApiInternals.responseExternalId(nestedOk, nestedConfig), 2002, 'externalId resolved from Data[0].Data.FItemID')
  assert.match(
    webApiInternals.responseFailureMessage(nestedFail, nestedConfig, null),
    /nested unit group/i,
    'nested failure message comes from Data[0].Data.FMessage, not the envelope fallback',
  )
  // Regression: flat Data[0].X rows are unchanged by the unwrap.
  assert.equal(webApiInternals.saveBusinessSuccess(flatOk, nestedConfig), true, 'flat Data[0].X success still recognized')
  assert.equal(webApiInternals.responseExternalId(flatOk, nestedConfig), 1001, 'flat externalId unchanged')

  // The Save leg that would have carried those envelopes: permanently refused, zero calls.
  const nestedRefusal = await adapter.upsert({
    object: 'material',
    records: [
      { FNumber: 'NESTEDOK', FName: 'Nested success row' },
      { FNumber: 'NESTEDFAIL', FName: 'Nested failure row' },
    ],
    keyFields: ['FNumber'],
  }).catch((error) => error)
  assert.ok(nestedRefusal instanceof AdapterValidationError, 'G-4: refused')
  assert.equal(nestedRefusal.details.code, 'K3_WISE_EXTERNAL_WRITE_DISABLED')
  assert.equal(calls.length, 0, 'G-4: 0 login calls, 0 Save calls — nothing at all reached K3')
}

// Customer-profiled Material Save: base-data shaping (G3), fail-closed placeholder guard,
// save-only locks, and conservative redacted row diagnostics (M1 fix §4/§5).
function profileSystem() {
  return createK3WebApiSystem({
    config: {
      baseUrl: 'https://k3.example.test',
      autoSubmit: false,
      autoAudit: false,
      objects: { material: { profile: 'material-k3wise-customer-profile-v1' } },
    },
  })
}

async function testK3WebApiCustomerProfile() {
  // ----- base-data object shaping (G3): numbered -> {FNumber}, enum/category -> {FID} -----
  // CONVERTED (G-4): read off the composed body instead of off the wire. Same `buildSaveBody`,
  // same merged objectConfig — the shaping rule under test is untouched.
  {
    const { calls, fetchImpl } = createK3FetchMock()
    const adapter = createK3WiseWebApiAdapter({ system: profileSystem(), fetchImpl })
    const preview = await adapter.previewUpsert({
      object: 'material',
      records: [{ FNumber: 'SHAPE01', FName: 'Shaped', FUnitGroupID: '10', FErpClsID: '1001' }],
      keyFields: ['FNumber'],
    })
    const composed = preview.records[0]
    assert.deepEqual(composed.body.Data.FUnitGroupID, { FNumber: '10' }, 'numbered base data wrapped {FNumber}')
    assert.deepEqual(composed.body.Data.FErpClsID, { FID: '1001' }, 'enum/category wrapped {FID}')
    assert.match(composed.path, /\/Material\/Save$/, 'and it is composed for the profile Save endpoint')
    assert.equal(calls.length, 0, 'composition touches no network')
  }

  // ----- fail-closed placeholder: unreplaced <fill-outside-git> never reaches K3 -----
  // CONVERTED (G-4): the guard is `buildSaveBody`'s and is reached through the preview leg. The
  // throw propagates instead of being collected per-row, because the collecting caller (`upsert`)
  // is now permanently fenced off. The zero-Save fact is asserted the same way as before.
  {
    const { calls, fetchImpl } = createK3FetchMock()
    const adapter = createK3WiseWebApiAdapter({ system: profileSystem(), fetchImpl })
    const placeholderRefusal = await adapter.previewUpsert({
      object: 'material',
      records: [{ FNumber: 'PH01', FName: 'Has placeholder', FUnitGroupID: '<fill-outside-git>' }],
      keyFields: ['FNumber'],
    }).catch((error) => error)
    assert.ok(placeholderRefusal instanceof AdapterValidationError, 'placeholder row fails closed')
    assert.equal(placeholderRefusal.details.code, 'K3_WISE_PRESET_PLACEHOLDER_UNFILLED')
    assert.equal(
      calls.some((call) => call.pathname === '/K3API/Material/Save'),
      false,
      'fail-closed: NO Material/Save HTTP call was made for the placeholder row',
    )
  }

  // ----- save-only locks -> no Submit/Audit -----
  // CONVERTED (G-4). This used to prove "Save attempted, Submit/Audit not". The Save is now
  // permanently refused as well, so the assertion strengthens from "no Submit/Audit" to "no
  // lifecycle-write call of ANY kind, login included".
  {
    const { calls, fetchImpl } = createK3FetchMock()
    const adapter = createK3WiseWebApiAdapter({ system: profileSystem(), fetchImpl })
    const saveOnlyRefusal = await adapter.upsert({
      object: 'material',
      records: [{ FNumber: 'NESTEDOK', FName: 'Save only' }],
      keyFields: ['FNumber'],
    }).catch((error) => error)
    assert.equal(saveOnlyRefusal.details.code, 'K3_WISE_EXTERNAL_WRITE_DISABLED')
    assert.equal(calls.some((call) => call.pathname === '/K3API/Material/Save'), false, 'no Save call')
    assert.equal(calls.some((call) => call.pathname === '/K3API/Material/Submit'), false, 'no Submit call')
    assert.equal(calls.some((call) => call.pathname === '/K3API/Material/Audit'), false, 'no Audit call')
    assert.equal(calls.length, 0, 'not even a login')
  }

  // ----- conservative redacted row diagnostics (G5 / R-REDACT) -----
  // CONVERTED (G-4): `buildRowSaveDiagnostic` is the unit under test and is on the module's
  // existing test surface, so it is driven DIRECTLY with the same row/key/message triples the
  // (now refused) Save-failure path used to hand it. Every redaction assertion is preserved
  // verbatim; only the transport that used to produce the inputs is gone.
  {
    const rawMessage = 'save failed: postgres://k3user:s3cretpw@db.internal/erp rejected the request'
    const diag = webApiInternals.buildRowSaveDiagnostic({
      status: 'failed',
      record: { FNumber: 'SECRETFAIL', FName: 'a', sourceId: 'plm-code-9' },
      key: 'SECRETFAIL',
      rawMessage,
      code: 'K3_WISE_SAVE_FAILED',
    })
    assert.deepEqual(Object.keys(diag).sort(), ['responseCode', 'rowKeys', 'rowStatus', 'validationMessage'])
    assert.equal(diag.rowStatus, 'failed')
    assert.match(diag.rowKeys.k3Key, /^sha12:[0-9a-f]{12}$/, 'K3 key is hashed, never raw')
    assert.match(diag.rowKeys.sourceId, /^sha12:/, 'non-UUID sourceId is hashed')
    // Second row: a confirmed internal UUID sourceId is kept in full.
    const uuidDiag = webApiInternals.buildRowSaveDiagnostic({
      status: 'failed',
      record: { FNumber: 'SECRETFAIL', FName: 'b', sourceId: '550e8400-e29b-41d4-a716-446655440000' },
      key: 'SECRETFAIL',
      rawMessage,
      code: 'K3_WISE_SAVE_FAILED',
    })
    assert.equal(uuidDiag.rowKeys.sourceId, '550e8400-e29b-41d4-a716-446655440000')
    // Secret-shaped value in the K3 message is scrubbed; benign text survives.
    const serialized = JSON.stringify(diag)
    assert.equal(serialized.includes('SECRETFAIL'), false, 'raw FNumber absent from diagnostic')
    assert.equal(serialized.includes('s3cretpw'), false, 'secret scrubbed from validation message')
    assert.match(diag.validationMessage, /save failed/i, 'benign diagnostic text survives')
    assert.ok(diag.validationMessage, 'validationMessage is populated when the error has a message')
  }

  // ----- HARD save-only lock: config + request + overlay paths cannot enable Submit/Audit -----
  {
    const { calls, fetchImpl } = createK3FetchMock()
    const adapter = createK3WiseWebApiAdapter({
      system: createK3WebApiSystem({
        config: {
          baseUrl: 'https://k3.example.test',
          autoSubmit: true, // operator tries to enable via config
          autoAudit: true,
          objects: {
            material: {
              profile: 'material-k3wise-customer-profile-v1',
              submitPath: '/K3API/Material/Submit', // overlay tries to re-inject the endpoints
              auditPath: '/K3API/Material/Audit',
            },
          },
        },
      }),
      fetchImpl,
    })
    // CONVERTED (G-4), and this is the Submit/Audit REGRESSION PIN — the one that must not be
    // allowed to weaken. Three enablement attempts are stacked in the config/overlay above and a
    // fourth on the request below: config.autoSubmit/autoAudit true, overlay submitPath/auditPath
    // re-injected, and request options autoSubmit/autoAudit true.
    //
    // The pin now has TWO live halves, because the half it used to have — reading
    // `upsert.metadata.autoSubmit === false` off a successful Save — sits behind the permanent
    // fence and is no longer observable. Stated plainly rather than quietly dropped:
    //
    //   (1) STRUCTURAL, still live: the profiled object config REFUSES the overlay-injected
    //       submit/audit endpoints outright (they are forbidden overlay keys), so the endpoints
    //       do not exist to be called. Weakening that sweep turns this red.
    //   (2) BEHAVIOURAL, still live: `previewUpsert` — what a human actually approves — mirrors
    //       the save-only auto-flag hard lock and must report both flags false against all four
    //       enablement attempts. Weakening `previewUpsert`'s `previewSaveOnly ? false : …` turns
    //       this red.
    //
    //   (3) And the write itself is refused with ZERO Submit/Audit calls, which is now the
    //       strongest form of the original claim.
    const effective = webApiInternals.normalizeObjects({
      autoSubmit: true,
      autoAudit: true,
      objects: {
        material: {
          profile: 'material-k3wise-customer-profile-v1',
          submitPath: '/K3API/Material/Submit',
          auditPath: '/K3API/Material/Audit',
        },
      },
    }).material
    assert.equal(effective.submitPath, undefined, 'HARD LOCK (1): an overlay cannot re-inject a Submit endpoint')
    assert.equal(effective.auditPath, undefined, 'HARD LOCK (1): an overlay cannot re-inject an Audit endpoint')
    assert.equal(effective.lifecycle, 'save-only', 'the save-only lifecycle marker is profile-pinned')

    const hardLockPreview = await adapter.previewUpsert({
      object: 'material',
      records: [{ FNumber: 'NESTEDOK', FName: 'Hard lock' }],
      keyFields: ['FNumber'],
      options: { autoSubmit: true, autoAudit: true }, // request tries too
    })
    assert.equal(hardLockPreview.metadata.autoSubmit, false, 'HARD LOCK (2): autoSubmit forced false (config+request+overlay all tried)')
    assert.equal(hardLockPreview.metadata.autoAudit, false, 'HARD LOCK (2): autoAudit forced false (config+request+overlay all tried)')

    const hardLockRefusal = await adapter.upsert({
      object: 'material',
      records: [{ FNumber: 'NESTEDOK', FName: 'Hard lock' }],
      keyFields: ['FNumber'],
      options: { autoSubmit: true, autoAudit: true }, // request tries too
    }).catch((error) => error)
    assert.equal(hardLockRefusal.details.code, 'K3_WISE_EXTERNAL_WRITE_DISABLED', 'HARD LOCK (3): the write is refused outright')
    assert.equal(calls.some((call) => call.pathname === '/K3API/Material/Submit'), false, 'Submit refused (config+request+overlay)')
    assert.equal(calls.some((call) => call.pathname === '/K3API/Material/Audit'), false, 'Audit refused (config+request+overlay)')
    assert.equal(calls.length, 0, 'and no login either')
  }

  // ----- object-value passthrough fidelity: two-field {FNumber,FName}/{FID,FName} preserved -----
  {
    const { calls, fetchImpl } = createK3FetchMock()
    const adapter = createK3WiseWebApiAdapter({ system: profileSystem(), fetchImpl })
    // CONVERTED (G-4): read off the composed body instead of off the wire — same composer.
    const passthrough = await adapter.previewUpsert({
      object: 'material',
      records: [{
        FNumber: 'OBJ01',
        FName: 'Object passthrough',
        FUnitGroupID: { FNumber: '10', FName: 'Each' },
        FErpClsID: { FID: '1001', FName: 'Raw materials' },
      }],
      keyFields: ['FNumber'],
    })
    const composedBody = passthrough.records[0].body
    assert.deepEqual(composedBody.Data.FUnitGroupID, { FNumber: '10', FName: 'Each' }, 'two-field {FNumber,FName} preserved verbatim')
    assert.deepEqual(composedBody.Data.FErpClsID, { FID: '1001', FName: 'Raw materials' }, 'two-field {FID,FName} preserved verbatim')
    assert.equal(calls.length, 0, 'composition touches no network')
  }

  // ----- fail-closed: a present-but-empty / non-string profile must throw, not fall back -----
  {
    const { fetchImpl } = createK3FetchMock()
    for (const bad of ['', '   ', 123]) {
      assert.throws(
        () => createK3WiseWebApiAdapter({
          system: createK3WebApiSystem({
            config: { baseUrl: 'https://k3.example.test', objects: { material: { profile: bad } } },
          }),
          fetchImpl,
        }),
        /profile must be a non-empty string/,
        `profile=${JSON.stringify(bad)} fails closed`,
      )
    }
  }

  // ----- diagnostic message fallback: an error without .message still yields a message -----
  {
    const diag = webApiInternals.buildRowSaveDiagnostic({
      status: 'failed',
      record: { sourceId: 'plm-9' },
      key: 'MAT-X',
      rawMessage: String({ toString: () => 'opaque adapter failure' }),
      code: 'K3_WISE_UPSERT_FAILED',
    })
    assert.equal(diag.validationMessage, 'opaque adapter failure', 'falls back to String(error), not null')
    assert.match(diag.rowKeys.k3Key, /^sha12:/)
  }
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

  // BOM is unaffected by the material profile guard and shares material's write mechanism
  // (Save/Submit/Audit) — used here because this scenario set is about generic tri-state
  // autoSubmit/autoAudit resolution, not material semantics.
  //
  // CONVERTED (G-4): this helper drove `upsert` and read `metadata.autoSubmit/autoAudit`. `upsert`
  // is permanently refused now, so it reads them off `previewUpsert` instead. Every scenario below
  // is UNCHANGED and every one still exercises the same code: for a non-save-only object the
  // preview leg resolves both flags through the very same `resolveAutoFlag(request.options.X,
  // config.X, 'X')` calls — including the two invalid-value throws (scenarios H and I).
  async function upsertOne(adapter, options = {}) {
    return adapter.previewUpsert({
      object: 'bom',
      records: [{ FParentItemNumber: 'BOM-COERCE-001', FChildItemNumber: 'MAT-COERCE-002', FQty: 1, FUnitID: 'PCS', FEntryID: 1 }],
      keyFields: ['FParentItemNumber'],
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
    const submitCalls = calls.filter((call) => call.pathname === '/K3API/BOM/Submit')
    const auditCalls = calls.filter((call) => call.pathname === '/K3API/BOM/Audit')
    assert.equal(submitCalls.length, 0, 'Submit must NOT fire when operator hand-edited "false"')
    assert.equal(auditCalls.length, 0, 'Audit must NOT fire when operator hand-edited "否"')
    // G-4: and the write leg those flags would have driven is refused outright, so the
    // "must not fire" claim above is now structural rather than conditional on the coercion.
    const coercionRefusal = await adapter.upsert({
      object: 'bom',
      records: [{ FParentItemNumber: 'BOM-COERCE-001', FChildItemNumber: 'MAT-COERCE-002', FQty: 1, FUnitID: 'PCS', FEntryID: 1 }],
      keyFields: ['FParentItemNumber'],
      options: { autoSubmit: 'true', autoAudit: 'true' },
    }).catch((error) => error)
    assert.equal(coercionRefusal.details.code, 'K3_WISE_EXTERNAL_WRITE_DISABLED',
      'even a request that coerces BOTH flags to true cannot reach a write')
    assert.equal(calls.length, 0, 'G-4: 0 login, 0 Save, 0 Submit, 0 Audit')
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

async function testK3WebApiMaterialBomReadSmoke() {
  const { calls, fetchImpl } = createK3FetchMock()
  const bomPreset = getReadSmokePreset('k3wise.material-bom.v1')
  // Operator-confirmed live BOM/GetDetail shape (#1709): Data is an object with a header array Data.Page1
  // and a sub-item line array Data.Page2 (no paging). Rows carry leak-bait VALUES to prove the route layer
  // (read-smoke.test / http-routes.test) scrubs them; the adapter surfaces only counts/types/flags.
  const bomCalls = []
  const bomFetchImpl = async (url, options) => {
    const parsed = new URL(url)
    if (parsed.pathname === '/K3API/BOM/GetDetail') {
      bomCalls.push({ method: options.method, body: options.body ? JSON.parse(options.body) : undefined })
      return jsonResponse(200, {
        StatusCode: 200,
        Message: 'BOM detail succeeded',
        Data: {
          Page1: [
            { FBOMNumber: 'BOM-SECRET-001', FNumber: 'MAT-SECRET-PARENT', FVersion: 'V1' },
          ],
          Page2: [
            { FNumber: 'MAT-SECRET-CHILD-1', FItemName: 'secret-name-1', FQty: 2 },
            { FNumber: 'MAT-SECRET-CHILD-2', FItemName: 'secret-name-2', FQty: 5 },
            { FNumber: 'MAT-SECRET-CHILD-3', FItemName: 'secret-name-3', FQty: 1 },
          ],
        },
      })
    }
    return fetchImpl(url, options)
  }
  const adapter = createK3WiseWebApiAdapter({
    system: createK3WebApiSystem({
      config: {
        baseUrl: 'https://k3.example.test',
        objects: {
          'material-bom': {
            operations: ['read'],
            readPath: '/K3API/BOM/GetDetail',
            readMethod: 'POST',
            readMode: 'bom',
            readBomBodyTemplate: { Data: {} },
            readBomBodyKey: 'Data',
            readBomParentKeyField: 'FBillNo',
          },
        },
      },
    }),
    fetchImpl: bomFetchImpl,
  })

  // Route-marker gating: a BOM read without the internal read-smoke marker is rejected before any K3 call.
  const unmarked = await adapter.read({
    object: 'material-bom',
    options: { k3ReadMode: 'bom', bomKey: 'BOM-1' },
  }).catch((error) => error)
  assert.ok(unmarked instanceof AdapterValidationError, 'BOM read cannot be triggered outside the read-smoke route')
  assert.equal(unmarked.details.code, 'K3_WISE_BOM_READ_ROUTE_UNSUPPORTED')
  assert.equal(bomCalls.length, 0, 'unmarked BOM read fails before the K3 GetDetail call')

  // O2 bound-value lock: feed a parent key containing a quote; it must reach the body verbatim, NOT escaped.
  const read = await adapter.read(buildReadSmokeRequest(bomPreset, { object: 'material-bom', mode: 'bom', key: "BOM'1" }))

  assert.equal(read.records.length, 3, 'BOM smoke returns the Data.Page2 line rows')
  assert.equal(read.metadata.mode, 'material-bom-smoke')
  assert.equal(read.metadata.readOnly, true)
  assert.equal(read.metadata.returnedRecordCount, 3)
  assert.equal(read.metadata.bomHeaderPresent, true)
  assert.equal(read.metadata.bomLinePresent, true)
  assert.equal(read.metadata.bomHeaderCount, 1, 'Data.Page1 header count surfaced (values-free)')
  assert.equal(read.metadata.bomLineCount, 3, 'Data.Page2 line count surfaced (values-free)')
  assert.equal(read.metadata.readPath, '/K3API/BOM/GetDetail')
  assert.deepEqual(read.metadata.bomShapeProbe, {
    dataPage1: true,
    dataPage2: true,
    dataLowerPage1: false,
    dataLowerPage2: false,
  })
  assert.equal(read.metadata.bomResponseShapeProbe.dataObjectPresent, true)
  assert.equal(read.metadata.bomResponseShapeProbe.headerPresent, true)
  assert.equal(read.metadata.bomResponseShapeProbe.linePresent, true)
  assert.deepEqual(read.metadata.bomResponseShapeProbe.fixedContainers, {
    dataPage1: { type: 'array', arrayLength: 1 },
    dataPage2: { type: 'array', arrayLength: 3 },
    dataLowerPage1: { type: 'missing', arrayLength: null },
    dataLowerPage2: { type: 'missing', arrayLength: null },
    topLevel: { type: 'object', arrayLength: null },
  }, 'BOM response-shape probe surfaces fixed container types/counts only')

  assert.equal(bomCalls.length, 1, 'BOM smoke calls BOM/GetDetail exactly once (no recursion, no resolver fan-out)')
  assert.equal(bomCalls[0].method, 'POST')
  // THE O2 fix, locked: the parent bill key is a bound JSON value — quote preserved (not "BOM''1"), and the
  // body carries nothing else (requiredFlags=[]; no Filter/Fields/escaping). A refactor that re-routes FBillNo
  // through k3_freeform or adds flags fails here.
  assert.deepEqual(bomCalls[0].body, { Data: { FBillNo: "BOM'1" } })
}

async function main() {
  await testK3WebApiAdapter()
  await testK3WebApiMaterialDetailReadSmoke()
  await testK3WebApiMaterialListReadSmoke()
  await testK3WebApiMaterialBomReadSmoke()
  await testK3WebApiAuthorityCodeToken()
  await testK3WebApiSaveBusinessEvidence()
  await testK3WebApiNestedDataSaveParse()
  await testK3WebApiCustomerProfile()
  testSqlServerConnectionConfigNormalization()
  testK3SqlServerExecutorKeepsK3IdentifierPolicy()
  await testK3SqlServerChannel()
  await testK3WebApiAutoFlagCoercion()
  console.log('✓ k3-wise-adapters: WebAPI, SQL Server channel, and auto-flag coercion tests passed')
}

main().catch((err) => {
  console.error('✗ k3-wise-adapters FAILED')
  console.error(err)
  process.exit(1)
})
