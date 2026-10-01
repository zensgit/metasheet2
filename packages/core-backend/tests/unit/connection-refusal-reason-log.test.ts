/**
 * WHY a connection was refused reaches the SERVER LOG, and nothing a caller can observe changes
 * (docs/development/takeover-beiliao-20260821/stock-prep-connection-canonical-unavailable-diagnosis-20260925.md §5 R1).
 *
 * The integration plugin answers about twelve different states of a data source with ONE error
 * code, on purpose: a caller who is not the owner must not learn whether an id exists. The cost was
 * that an operator could not tell the states apart either. This file pins both halves of the fix
 * against the REAL chain — DataSourceManager, the host facade, the plugin's connection resolver,
 * its external-system registry and its route table, over HTTP through one pinned listener:
 *
 *   1. RESPONSE BYTES. Every refusal answers with the literal status, headers and body pinned
 *      below. They were captured from the code as it stood before the reason existed, and they are
 *      the same bytes for every state — that is the non-disclosure the reason must not break.
 *   2. THE LINE. Each refused request writes exactly one `connection refused` line with the phase,
 *      the connection error code and the reason, synchronously before the route-failure line that
 *      was already there.
 *   3. VALUES-FREE. Every id, owner, tenant, host and credential below carries a marker, and so
 *      does every error text the chain produces; no log line may contain it.
 *   4. THE ACCESSOR. `DataSourceManager.getLoadState` answers from memory: no database read, no
 *      promise, the same lookups for every id.
 *   5. PARITY. The plugin cannot import the host's list, so it keeps a copy; the two are compared.
 *
 * No `request(app)`: one pinned listener for the file (#4154).
 */
import { createRequire } from 'node:module'

import express from 'express'
import { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { DataSourceManager } from '../../src/data-adapters/DataSourceManager'
import {
  createDataSourcePluginFacade,
  createDataSourceSealedSnapshotConnectionFacade,
  DATA_SOURCE_REFUSAL_REASON_KEY,
  DATA_SOURCE_REFUSAL_REASONS,
} from '../../src/data-adapters/data-source-plugin-facade'
import { encryptStoredSecretValue } from '../../src/security/encrypted-secrets'
import { usePinnedServer } from '../utils/pinned-server'

const require_ = createRequire(__filename)
const PLUGIN_LIB = '../../../../plugins/plugin-integration-core/lib'
const resolverModule = require_(`${PLUGIN_LIB}/connection-resolver.cjs`) as {
  createConnectionResolver: (deps: Record<string, unknown>) => unknown
  FACADE_REFUSAL_REASONS: readonly string[]
  RESOLVER_REFUSAL_REASONS: readonly string[]
  CONNECTION_REFUSAL_LOG_MESSAGE: string
}
const { createExternalSystemRegistry } = require_(`${PLUGIN_LIB}/external-systems.cjs`) as {
  createExternalSystemRegistry: (deps: Record<string, unknown>) => Record<string, (input: unknown) => Promise<unknown>>
}
const { registerIntegrationRoutes } = require_(`${PLUGIN_LIB}/http-routes.cjs`) as {
  registerIntegrationRoutes: (input: Record<string, unknown>) => string[]
}

// ── synthetic values; every one of them carries the marker ──
const MARK = 'zq9mark'
const TENANT = `tenant-${MARK}-a`
const OTHER_TENANT = `tenant-${MARK}-z`
const REQUESTER = `user-${MARK}-requester`
const OTHER_OWNER = `user-${MARK}-owner`
const PASSWORD = `password-${MARK}`

const DS = {
  loaded: `ds-${MARK}-loaded`,
  ownerMismatch: `ds-${MARK}-owner`,
  tenantMismatch: `ds-${MARK}-tenant`,
  tenantlessScope: `ds-${MARK}-tenantless-private`,
  tenantlessLegacy: `ds-${MARK}-tenantless-legacy`,
  credentialsUnreadable: `ds-${MARK}-credentials`,
  unsupportedType: `ds-${MARK}-type`,
  loadFailed: `ds-${MARK}-broken`,
  absent: `ds-${MARK}-absent`,
  sealedLoaded: `ds-${MARK}-sealed`,
  sealedWritable: `ds-${MARK}-sealed-writable`,
} as const

// ── encryption material: rows sealed under PREVIOUS cannot be read under CURRENT ──
const PREVIOUS = { key: 'refusal-reason-previous-key-0123456789abcdef', salt: 'refusal-reason-previous-salt-0123456' }
const CURRENT = { key: 'refusal-reason-current-key-fedcba9876543210', salt: 'refusal-reason-current-salt-9876543' }
const savedMaterial = { key: process.env.ENCRYPTION_KEY, salt: process.env.ENCRYPTION_SALT }

function useMaterial(material: { key: string; salt: string }): void {
  process.env.ENCRYPTION_KEY = material.key
  process.env.ENCRYPTION_SALT = material.salt
}

function sealedUnderPreviousMaterial(plaintext: string): string {
  useMaterial(PREVIOUS)
  try {
    return encryptStoredSecretValue(plaintext)
  } finally {
    useMaterial(CURRENT)
  }
}

type Row = Record<string, unknown>

function dataSourceRow(id: string, overrides: Row = {}): Row {
  const at = new Date('2026-09-01T00:00:00.000Z')
  return {
    id,
    name: `name ${id}`,
    type: 'postgresql',
    description: null,
    config: {
      connection: { host: `${MARK}.example.test`, port: 5432, database: `db_${MARK}` },
      credentials: { username: `login-${MARK}`, password: PASSWORD },
      options: { readOnly: true, autoConnect: false },
    },
    status: 'disconnected',
    last_connected_at: null,
    last_error: null,
    owner_id: REQUESTER,
    workspace_id: null,
    tenant_id: TENANT,
    scope_kind: 'private',
    is_active: true,
    auto_connect: false,
    metadata: null,
    tags: null,
    created_at: at,
    updated_at: at,
    deleted_at: null,
    ...overrides,
  }
}

function sqlServerConfig(readOnly: boolean): Row {
  return {
    connection: { server: `${MARK}.example.test`, database: `db_${MARK}`, encrypt: true, trustServerCertificate: false },
    credentials: { username: `login-${MARK}`, password: PASSWORD },
    options: { readOnly, autoConnect: false },
  }
}

function dataSourceRows(): Row[] {
  return [
    dataSourceRow(DS.loaded),
    dataSourceRow(DS.ownerMismatch, { owner_id: OTHER_OWNER }),
    dataSourceRow(DS.tenantMismatch, { tenant_id: OTHER_TENANT }),
    dataSourceRow(DS.tenantlessScope, { tenant_id: null, scope_kind: 'private' }),
    dataSourceRow(DS.tenantlessLegacy, { tenant_id: null, scope_kind: 'legacy_private' }),
    dataSourceRow(DS.credentialsUnreadable, {
      config: {
        connection: { host: `${MARK}.example.test`, port: 5432, database: `db_${MARK}` },
        credentials: { username: `login-${MARK}`, password: sealedUnderPreviousMaterial(PASSWORD) },
        options: { readOnly: true, autoConnect: false },
      },
    }),
    dataSourceRow(DS.unsupportedType, { type: `type-${MARK}` }),
    dataSourceRow(DS.loadFailed, { config: null }),
    dataSourceRow(DS.sealedLoaded, { type: 'sqlserver', config: sqlServerConfig(true) }),
    dataSourceRow(DS.sealedWritable, { type: 'sqlserver', config: sqlServerConfig(false) }),
  ]
}

/** A Kysely whose only modelled statement is the startup load. Counts every statement it is given. */
function memoryDataSourcesDb(rows: Row[]) {
  const statements: string[] = []
  const connection = {
    async executeQuery(compiled: { sql: string; parameters: readonly unknown[] }) {
      statements.push(compiled.sql)
      if (compiled.sql === 'select * from "data_sources" where "is_active" = $1 and "deleted_at" is null') {
        return { rows: rows.filter((row) => row.is_active === compiled.parameters[0] && row.deleted_at === null).map((row) => ({ ...row })) }
      }
      throw new Error(`memory data_sources: statement not modelled (${MARK})`)
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('memory data_sources: no stream')
    },
  }
  const driver = {
    async init() {},
    async acquireConnection() { return connection },
    async beginTransaction() {},
    async commitTransaction() {},
    async rollbackTransaction() {},
    async releaseConnection() {},
    async destroy() {},
  }
  const db = new Kysely<unknown>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver as never,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  })
  return { db, statements }
}

// ── the plugin's own table, in memory ──
const SYSTEM = {
  canonical: (dataSourceId: string) => `sys-${MARK}-canonical-${dataSourceId}`,
  legacy: (dataSourceId: string) => `sys-${MARK}-legacy-${dataSourceId}`,
}

function externalSystemRow(id: string, overrides: Row): Row {
  return {
    id,
    tenant_id: TENANT,
    workspace_id: null,
    project_id: null,
    name: `binding ${id}`,
    kind: 'data-source:sql-readonly',
    role: 'source',
    capabilities: {},
    status: 'active',
    last_tested_at: null,
    last_error: null,
    credentials_encrypted: null,
    created_at: '2026-08-15T00:00:00.000Z',
    updated_at: '2026-08-15T00:00:00.000Z',
    ...overrides,
  }
}

function externalSystemRows(): Row[] {
  const rows: Row[] = []
  for (const dataSourceId of Object.values(DS)) {
    rows.push(externalSystemRow(SYSTEM.canonical(dataSourceId), {
      config: { schema: `schema_${MARK}` },
      connection_id: dataSourceId,
      legacy_connection_fallback_eligible: false,
    }))
    rows.push(externalSystemRow(SYSTEM.legacy(dataSourceId), {
      config: { dataSourceId, schema: `schema_${MARK}` },
      connection_id: null,
      legacy_connection_fallback_eligible: true,
    }))
  }
  return rows
}

function memoryPluginDb(rows: Row[]) {
  const inserted: Row[] = []
  return {
    inserted,
    db: {
      async selectOne(_table: string, where: Row) {
        return rows.find((row) => Object.entries(where).every(([key, value]) => (
          value === null || value === undefined ? row[key] == null : row[key] === value
        ))) ?? null
      },
      async select() { return [] },
      async insertOne(_table: string, row: Row) {
        inserted.push(row)
        return [{ ...row, created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z' }]
      },
      async updateRow() { throw new Error(`plugin db: update is not part of this suite (${MARK})`) },
      async deleteRows() { throw new Error(`plugin db: delete is not part of this suite (${MARK})`) },
      async countRows() { return 0 },
    },
  }
}

function unused(name: string) {
  return async () => { throw new Error(`${name} is not part of this suite (${MARK})`) }
}

function inert(methods: string[]): Record<string, () => Promise<never>> {
  return Object.fromEntries(methods.map((method) => [method, unused(method)]))
}

interface LogCall {
  level: 'info' | 'warn' | 'error'
  args: unknown[]
}

interface Harness {
  app: express.Express
  manager: DataSourceManager
  statements: string[]
  calls: LogCall[]
  registry: Record<string, (input: unknown) => Promise<unknown>>
  inserted: Row[]
  user: { current: Record<string, unknown> | null }
}

async function buildHarness(options: { facade?: 'none' } = {}): Promise<Harness> {
  const { db, statements } = memoryDataSourcesDb(dataSourceRows())
  const manager = new DataSourceManager()
  // The manager reports skipped rows on the console, error text and all. That is its own log and
  // not the subject of this file; the plugin logger below is.
  const silenced = [
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
  ]
  try {
    await manager.initialize(db)
  } finally {
    for (const spy of silenced) spy.mockRestore()
  }

  const calls: LogCall[] = []
  const logger = {
    info: (...args: unknown[]) => { calls.push({ level: 'info', args }) },
    warn: (...args: unknown[]) => { calls.push({ level: 'warn', args }) },
    error: (...args: unknown[]) => { calls.push({ level: 'error', args }) },
  }
  // Wired the way plugins/plugin-integration-core/index.cjs wires it: one logger, handed to the
  // resolver and to the route table.
  const connectionResolver = resolverModule.createConnectionResolver({
    facade: options.facade === 'none' ? undefined : createDataSourcePluginFacade(() => manager),
    sealedSnapshotFacade: options.facade === 'none' ? undefined : createDataSourceSealedSnapshotConnectionFacade(() => manager),
    logger,
  })
  const plugin = memoryPluginDb(externalSystemRows())
  const registry = createExternalSystemRegistry({
    db: plugin.db,
    credentialStore: { encrypt: unused('encrypt'), decrypt: unused('decrypt'), fingerprint: async () => null },
    connectionResolver,
  })

  const user: Harness['user'] = { current: { id: REQUESTER, tenantId: TENANT, permissions: ['integration:write'] } }
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    const carrier = req as unknown as Record<string, unknown>
    if (user.current) {
      carrier.user = { ...user.current }
      carrier.authenticatedTenantId = user.current.tenantId
    }
    next()
  })
  const mount = app as unknown as Record<string, (path: string, handler: express.RequestHandler) => void>
  registerIntegrationRoutes({
    context: {
      api: { http: { addRoute(method: string, path: string, handler: express.RequestHandler) { mount[method.toLowerCase()](path, handler) } } },
      storage: { async get() { return null }, async set() {}, async delete() {} },
      config: {},
    },
    logger,
    services: {
      externalSystemRegistry: registry,
      adapterRegistry: {
        createAdapter() {
          return { async testConnection() { return { ok: true } } }
        },
        listAdapterKinds() { return [] },
      },
      pipelineRegistry: inert(['upsertPipeline', 'getPipeline', 'listPipelines', 'listPipelineRuns']),
      pipelineRunner: inert(['runPipeline']),
      deadLetterStore: inert(['listDeadLetters']),
      stagingInstaller: inert(['installStaging', 'listStagingDescriptors']),
      templateRegistry: inert(['upsertTemplate', 'getTemplate', 'listTemplates', 'deleteTemplate', 'instantiateTemplate']),
      readSourceConfigStore: inert(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
      readSourceCompositionConfigStore: inert(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
      bridgeAgentChecklistStore: inert(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForApply']),
    },
  })
  return { app, manager, statements, calls, registry, inserted: plugin.inserted, user }
}

// ── what a caller can observe of one response ──
interface Observed {
  status: number
  contentType: string | undefined
  contentLength: string | undefined
  etag: string | undefined
  headerNames: string[]
  body: string
}

function observe(response: request.Response): Observed {
  return {
    status: response.status,
    contentType: response.headers['content-type'],
    contentLength: response.headers['content-length'],
    etag: response.headers.etag,
    // `date` changes by the second; the connection headers belong to the transport, not the handler.
    headerNames: Object.keys(response.headers).filter((name) => !['date', 'connection', 'keep-alive'].includes(name)).sort(),
    body: response.text,
  }
}

// THE PINNED BYTES. Captured from the code as it stood before the reason existed (the same requests,
// against the same harness): one response per phase, identical for every state behind it.
const CANONICAL_REFUSAL_BODY =
  '{"ok":false,"error":{"code":"CONNECTION_CANONICAL_UNAVAILABLE","message":"canonical connection is unavailable","details":{"field":"connectionId","code":"CONNECTION_CANONICAL_UNAVAILABLE"}}}'
const LEGACY_REFUSAL_BODY =
  '{"ok":false,"error":{"code":"CONNECTION_LEGACY_UNAVAILABLE","message":"legacy connection is unavailable","details":{"field":"connectionId","code":"CONNECTION_LEGACY_UNAVAILABLE"}}}'

function refusalResponse(body: string, etag: string): Observed {
  return {
    status: 400,
    contentType: 'application/json; charset=utf-8',
    contentLength: String(Buffer.byteLength(body, 'utf8')),
    etag,
    headerNames: ['content-length', 'content-type', 'etag', 'x-powered-by'],
    body,
  }
}

const CANONICAL_REFUSAL = refusalResponse(CANONICAL_REFUSAL_BODY, 'W/"bd-jIzE3zBeopIsGB6IkbHS8FzCd6c"')
const LEGACY_REFUSAL = refusalResponse(LEGACY_REFUSAL_BODY, 'W/"b4-PSaIQl2HsWtMqnvtECXqT7+qV7A"')

const REFUSAL_LINE = '[plugin-integration-core] connection refused'
const ROUTE_FAILED = (method: string, path: string) => `[plugin-integration-core] route failed: ${method} ${path}`

// The states a caller can put behind one request, and the word each of them writes.
const HTTP_STATES: Array<{ label: string; dataSourceId: string; reason: string }> = [
  { label: 'loaded, owned by someone else', dataSourceId: DS.ownerMismatch, reason: 'owner_mismatch' },
  { label: 'loaded, another tenant', dataSourceId: DS.tenantMismatch, reason: 'tenant_mismatch' },
  { label: 'loaded, tenantless and not legacy_private', dataSourceId: DS.tenantlessScope, reason: 'tenantless_scope' },
  { label: 'not loaded: credential cannot be decrypted', dataSourceId: DS.credentialsUnreadable, reason: 'not_loaded_credentials_unreadable' },
  { label: 'not loaded: type has no adapter', dataSourceId: DS.unsupportedType, reason: 'not_loaded_unsupported_type' },
  { label: 'not loaded: the row is malformed', dataSourceId: DS.loadFailed, reason: 'not_loaded_load_failed' },
  { label: 'not loaded: no such id', dataSourceId: DS.absent, reason: 'not_loaded_absent' },
]

function expectValuesFree(calls: LogCall[]): void {
  const written = JSON.stringify(calls)
  expect(written).not.toContain(MARK)
  for (const text of ['not found', 'Data source with id', 'decrypt', 'ENCRYPTION_KEY', 'Unsupported', '    at ']) {
    expect(written).not.toContain(text)
  }
}

describe('connection refusal reason — the real chain over HTTP', () => {
  const pinned = usePinnedServer()
  let harness: Harness

  beforeAll(async () => {
    useMaterial(CURRENT)
    harness = await buildHarness()
    pinned.setApp(harness.app)
  })

  afterAll(() => {
    if (savedMaterial.key === undefined) delete process.env.ENCRYPTION_KEY
    else process.env.ENCRYPTION_KEY = savedMaterial.key
    if (savedMaterial.salt === undefined) delete process.env.ENCRYPTION_SALT
    else process.env.ENCRYPTION_SALT = savedMaterial.salt
  })

  function bind(dataSourceId: string) {
    return request(pinned.url())
      .post('/api/integration/external-systems')
      .send({ kind: 'data-source:sql-readonly', name: `probe ${MARK}`, role: 'source', connectionId: dataSourceId })
  }

  function test(systemId: string) {
    return request(pinned.url()).post(`/api/integration/external-systems/${systemId}/test`).send({})
  }

  it('the registry is in the states this file claims', () => {
    expect(harness.manager.getLoadState(DS.loaded)).toBe('loaded')
    expect(harness.manager.getLoadState(DS.ownerMismatch)).toBe('loaded')
    expect(harness.manager.getLoadState(DS.tenantMismatch)).toBe('loaded')
    expect(harness.manager.getLoadState(DS.tenantlessScope)).toBe('loaded')
    expect(harness.manager.getLoadState(DS.credentialsUnreadable)).toBe('credentials_unreadable')
    expect(harness.manager.getLoadState(DS.unsupportedType)).toBe('unsupported_type')
    expect(harness.manager.getLoadState(DS.loadFailed)).toBe('load_failed')
    expect(harness.manager.getLoadState(DS.absent)).toBe('absent')
  })

  it('control: a connection the requester owns binds, and writes no refusal line', async () => {
    harness.calls.length = 0
    const response = await bind(DS.loaded)
    expect(response.status).toBe(201)
    expect(harness.inserted.at(-1)).toMatchObject({ connection_id: DS.loaded, kind: 'data-source:sql-readonly' })
    expect(harness.calls).toEqual([])
  })

  describe.each(HTTP_STATES)('$label', ({ dataSourceId, reason }) => {
    it(`canonical, bind: the pinned response, and one line saying ${reason}`, async () => {
      harness.calls.length = 0
      const observed = observe(await bind(dataSourceId))
      expect(observed).toEqual(CANONICAL_REFUSAL)
      expect(harness.calls).toEqual([
        { level: 'warn', args: [REFUSAL_LINE, { phase: 'canonical', code: 'CONNECTION_CANONICAL_UNAVAILABLE', reason }] },
        { level: 'warn', args: [ROUTE_FAILED('POST', '/api/integration/external-systems'), { code: 'CONNECTION_CANONICAL_UNAVAILABLE' }] },
      ])
      expectValuesFree(harness.calls)
    })

    it(`canonical, stored binding: the pinned response, and one line saying ${reason}`, async () => {
      harness.calls.length = 0
      const observed = observe(await test(SYSTEM.canonical(dataSourceId)))
      expect(observed).toEqual(CANONICAL_REFUSAL)
      expect(harness.calls).toEqual([
        { level: 'warn', args: [REFUSAL_LINE, { phase: 'canonical', code: 'CONNECTION_CANONICAL_UNAVAILABLE', reason }] },
        { level: 'warn', args: [ROUTE_FAILED('POST', '/api/integration/external-systems/:id/test'), { code: 'CONNECTION_CANONICAL_UNAVAILABLE' }] },
      ])
      expectValuesFree(harness.calls)
    })

    it(`legacy, stored binding: the pinned response, and one line saying ${reason}`, async () => {
      harness.calls.length = 0
      const observed = observe(await test(SYSTEM.legacy(dataSourceId)))
      expect(observed).toEqual(LEGACY_REFUSAL)
      expect(harness.calls).toEqual([
        { level: 'warn', args: [REFUSAL_LINE, { phase: 'legacy', code: 'CONNECTION_LEGACY_UNAVAILABLE', reason }] },
        { level: 'warn', args: [ROUTE_FAILED('POST', '/api/integration/external-systems/:id/test'), { code: 'CONNECTION_LEGACY_UNAVAILABLE' }] },
      ])
      expectValuesFree(harness.calls)
    })
  })

  it('every state answers with the SAME bytes: the response tells a caller nothing about the id', async () => {
    const canonical = new Set<string>()
    const legacy = new Set<string>()
    for (const { dataSourceId } of HTTP_STATES) {
      canonical.add(JSON.stringify(observe(await bind(dataSourceId))))
      canonical.add(JSON.stringify(observe(await test(SYSTEM.canonical(dataSourceId)))))
      legacy.add(JSON.stringify(observe(await test(SYSTEM.legacy(dataSourceId)))))
    }
    expect([...canonical]).toEqual([JSON.stringify(CANONICAL_REFUSAL)])
    expect([...legacy]).toEqual([JSON.stringify(LEGACY_REFUSAL)])
    for (const body of [CANONICAL_REFUSAL_BODY, LEGACY_REFUSAL_BODY]) {
      expect(body).not.toContain(MARK)
      for (const word of [...DATA_SOURCE_REFUSAL_REASONS, ...resolverModule.RESOLVER_REFUSAL_REASONS]) {
        expect(body).not.toContain(word)
      }
    }
  })

  it('a requester with no id and no email is refused as principal_missing, with the pinned response', async () => {
    harness.calls.length = 0
    harness.user.current = { tenantId: TENANT, permissions: ['integration:write'] }
    try {
      expect(observe(await bind(DS.loaded))).toEqual(CANONICAL_REFUSAL)
    } finally {
      harness.user.current = { id: REQUESTER, tenantId: TENANT, permissions: ['integration:write'] }
    }
    expect(harness.calls[0]).toEqual({
      level: 'warn',
      args: [REFUSAL_LINE, { phase: 'canonical', code: 'CONNECTION_CANONICAL_UNAVAILABLE', reason: 'principal_missing' }],
    })
    expect(harness.calls).toHaveLength(2)
  })

  it('no facade injected: the pinned response, and facade_unavailable', async () => {
    const bare = await buildHarness({ facade: 'none' })
    pinned.setApp(bare.app)
    try {
      expect(observe(await bind(DS.loaded))).toEqual(CANONICAL_REFUSAL)
      expect(observe(await test(SYSTEM.legacy(DS.loaded)))).toEqual(LEGACY_REFUSAL)
    } finally {
      pinned.setApp(harness.app)
    }
    expect(bare.calls.filter((call) => call.args[0] === REFUSAL_LINE)).toEqual([
      { level: 'warn', args: [REFUSAL_LINE, { phase: 'canonical', code: 'CONNECTION_CANONICAL_UNAVAILABLE', reason: 'facade_unavailable' }] },
      { level: 'warn', args: [REFUSAL_LINE, { phase: 'legacy', code: 'CONNECTION_LEGACY_UNAVAILABLE', reason: 'facade_unavailable' }] },
    ])
  })

  it('refusing reads the database zero times: the registry was loaded once, at startup', async () => {
    const before = harness.statements.length
    for (const { dataSourceId } of HTTP_STATES) {
      await bind(dataSourceId)
      await test(SYSTEM.canonical(dataSourceId))
      await test(SYSTEM.legacy(dataSourceId))
    }
    expect(harness.statements.length).toBe(before)
    expect(harness.statements).toEqual(['select * from "data_sources" where "is_active" = $1 and "deleted_at" is null'])
  })
})

describe('connection refusal reason — through the registry, for what HTTP cannot reach', () => {
  let harness: Harness

  beforeAll(async () => {
    useMaterial(CURRENT)
    harness = await buildHarness()
  })

  async function refusalOf(action: () => Promise<unknown>): Promise<Record<string, unknown>> {
    try {
      await action()
    } catch (error) {
      return error as Record<string, unknown>
    }
    throw new Error('expected a refusal, the call resolved')
  }

  // What the registry raised for a refused resolution before the reason existed.
  function expectRegistryRefusal(error: Record<string, unknown>, code: string, message: string): void {
    expect(error.name).toBe('ExternalSystemValidationError')
    expect(error.message).toBe(message)
    expect(error.details).toEqual({ field: 'connectionId', code })
    expect(error.code).toBe(code)
    expect(Object.getOwnPropertySymbols(error)).toEqual([])
    expect('reason' in error).toBe(false)
    expect('cause' in error).toBe(false)
    expect(JSON.stringify(error)).not.toContain(MARK)
  }

  it.each([
    { label: 'no principal', input: { principal: undefined, runAs: 'user' }, dataSourceId: DS.loaded, reason: 'principal_missing' },
    { label: 'a blank principal', input: { principal: '   ', runAs: 'user' }, dataSourceId: DS.loaded, reason: 'principal_missing' },
    { label: 'a runAs outside the three', input: { principal: REQUESTER, runAs: `run-${MARK}` }, dataSourceId: DS.loaded, reason: 'run_as_invalid' },
    { label: 'a service run on a tenantless legacy source', input: { principal: REQUESTER, runAs: 'service' }, dataSourceId: DS.tenantlessLegacy, reason: 'tenantless_service' },
    { label: 'a service run on a tenantless private source', input: { principal: REQUESTER, runAs: 'service' }, dataSourceId: DS.tenantlessScope, reason: 'tenantless_scope' },
  ])('canonical: $label → $reason', async ({ input, dataSourceId, reason }) => {
    harness.calls.length = 0
    const error = await refusalOf(() => harness.registry.getExternalSystemForAdapter({
      tenantId: TENANT,
      id: SYSTEM.canonical(dataSourceId),
      ...input,
    }))
    expectRegistryRefusal(error, 'CONNECTION_CANONICAL_UNAVAILABLE', 'canonical connection is unavailable')
    expect(harness.calls).toEqual([
      { level: 'warn', args: [REFUSAL_LINE, { phase: 'canonical', code: 'CONNECTION_CANONICAL_UNAVAILABLE', reason }] },
    ])
    expectValuesFree(harness.calls)
  })

  it.each([
    { label: 'a postgres source', dataSourceId: DS.loaded, reason: 'sealed_type_unsupported' },
    { label: 'a writable SQL Server source', dataSourceId: DS.sealedWritable, reason: 'sealed_not_read_only' },
  ])('sealed snapshot: $label → $reason', async ({ dataSourceId, reason }) => {
    harness.calls.length = 0
    const error = await refusalOf(() => harness.registry.getExternalSystemForSealedSnapshot({
      tenantId: TENANT,
      id: SYSTEM.canonical(dataSourceId),
      principal: REQUESTER,
      runAs: 'user',
    }))
    expectRegistryRefusal(error, 'CONNECTION_SEALED_SNAPSHOT_UNAVAILABLE', 'sealed snapshot connection is unavailable')
    expect(harness.calls).toEqual([
      { level: 'warn', args: [REFUSAL_LINE, { phase: 'sealed_snapshot', code: 'CONNECTION_SEALED_SNAPSHOT_UNAVAILABLE', reason }] },
    ])
    expectValuesFree(harness.calls)
  })

  it('sealed snapshot: a refusal of the canonical stage is the canonical line, once', async () => {
    harness.calls.length = 0
    const error = await refusalOf(() => harness.registry.getExternalSystemForSealedSnapshot({
      tenantId: TENANT,
      id: SYSTEM.canonical(DS.credentialsUnreadable),
      principal: REQUESTER,
      runAs: 'user',
    }))
    expectRegistryRefusal(error, 'CONNECTION_CANONICAL_UNAVAILABLE', 'canonical connection is unavailable')
    expect(harness.calls).toEqual([
      { level: 'warn', args: [REFUSAL_LINE, { phase: 'canonical', code: 'CONNECTION_CANONICAL_UNAVAILABLE', reason: 'not_loaded_credentials_unreadable' }] },
    ])
  })

  it('sealed snapshot control: a read-only SQL Server source the requester owns resolves, and writes nothing', async () => {
    harness.calls.length = 0
    const resolved = await harness.registry.getExternalSystemForSealedSnapshot({
      tenantId: TENANT,
      id: SYSTEM.canonical(DS.sealedLoaded),
      principal: REQUESTER,
      runAs: 'user',
    }) as { config: Record<string, unknown> }
    expect(resolved.config.dataSourceId).toBe(DS.sealedLoaded)
    expect(harness.calls).toEqual([])
  })
})

describe('DataSourceManager.getLoadState — memory only', () => {
  let harness: Harness

  beforeAll(async () => {
    useMaterial(CURRENT)
    harness = await buildHarness()
  })

  it('answers from the closed set, and only `loaded` when adapter AND scope are present', () => {
    const internals = harness.manager as unknown as { scopes: Map<string, unknown>; adapters: Map<string, unknown> }
    expect(harness.manager.getLoadState(DS.loaded)).toBe('loaded')
    // Half registered: the adapter is there, the scope is not. assertAccess refuses such an id as
    // not found, so the accessor must not call it loaded.
    const scope = internals.scopes.get(DS.loaded)
    internals.scopes.delete(DS.loaded)
    try {
      expect(harness.manager.getLoadState(DS.loaded)).toBe('absent')
    } finally {
      internals.scopes.set(DS.loaded, scope)
    }
    // ... and the other half: a scope without an adapter.
    const adapter = internals.adapters.get(DS.ownerMismatch)
    internals.adapters.delete(DS.ownerMismatch)
    try {
      expect(harness.manager.getLoadState(DS.ownerMismatch)).toBe('absent')
    } finally {
      internals.adapters.set(DS.ownerMismatch, adapter)
    }
    expect(harness.manager.getLoadState(DS.loaded)).toBe('loaded')
    for (const odd of ['', ' ', 'constructor', '__proto__', 'toString', `${DS.loaded} `]) {
      expect(harness.manager.getLoadState(odd)).toBe('absent')
    }
  })

  it('takes the id and nothing else, returns a word and not a promise, and reads no database', () => {
    expect(harness.manager.getLoadState.length).toBe(1)
    const before = harness.statements.length
    for (const dataSourceId of Object.values(DS)) {
      const state = harness.manager.getLoadState(dataSourceId) as unknown
      expect(typeof state).toBe('string')
      expect(['loaded', 'credentials_unreadable', 'unsupported_type', 'load_failed', 'absent']).toContain(state)
    }
    expect(harness.statements.length).toBe(before)
  })

  it('structure: no await, no promise, no database, no timer in the accessor', () => {
    const source = DataSourceManager.prototype.getLoadState.toString()
    expect(source.startsWith('getLoadState(')).toBe(true)
    for (const token of [
      'await', 'async', 'Promise', '.then(', 'this.db', 'selectFrom', '.execute', 'setImmediate', 'setTimeout',
      'queueMicrotask', 'nextTick', 'require(', 'import(', 'readFile', 'console.',
    ]) {
      expect(source, `the accessor must not contain ${token}`).not.toContain(token)
    }
    // The same three lookups for every id, before any verdict.
    const lookups = ['this.adapters.has(id)', 'this.scopes.has(id)', 'this.loadFailures.get(id)']
    const positions = lookups.map((lookup) => source.indexOf(lookup))
    for (const position of positions) expect(position).toBeGreaterThan(0)
    expect(Math.max(...positions)).toBeLessThan(source.indexOf('return'))
    for (const lookup of lookups) expect(source.split(lookup).length - 1).toBe(1)
  })
})

describe('refusal reason vocabulary — the host list and the plugin copy agree', () => {
  it('same words, same order, and the same registered symbol', () => {
    expect([...resolverModule.FACADE_REFUSAL_REASONS]).toEqual([...DATA_SOURCE_REFUSAL_REASONS])
    expect(DATA_SOURCE_REFUSAL_REASON_KEY).toBe(Symbol.for('metasheet.dataSource.refusalReason'))
    expect(resolverModule.CONNECTION_REFUSAL_LOG_MESSAGE).toBe(REFUSAL_LINE)
  })

  it('the words the resolver writes itself are not words the host can send', () => {
    expect([...resolverModule.RESOLVER_REFUSAL_REASONS]).toEqual(['facade_unavailable', 'unclassified'])
    for (const word of resolverModule.RESOLVER_REFUSAL_REASONS) {
      expect(DATA_SOURCE_REFUSAL_REASONS as readonly string[]).not.toContain(word)
    }
  })
})
