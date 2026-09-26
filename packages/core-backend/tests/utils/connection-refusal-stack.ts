/**
 * Shared harness for the connection-refusal diagnostics suites (R1/R2/R3/R7 of
 * docs/development/takeover-beiliao-20260821/stock-prep-connection-canonical-unavailable-diagnosis-20260925.md §5).
 *
 * Everything on the refusal path is the REAL module: DataSourceManager (loaded through a Kysely
 * instance), the host facade, the plugin's connection resolver, the plugin's external-system
 * registry and the plugin's own HTTP route table, mounted on a real express app behind a real HTTP
 * listener. Only storage differs between the two callers: the no-DB suite
 * (tests/unit/stock-prep-connection-refusal-diagnostics.test.ts) hands in an in-memory Kysely driver
 * and an in-memory plugin db; the real-DB suite
 * (tests/integration/stock-prep-connection-refusal-diagnostics.db.test.ts) hands in PostgreSQL with
 * the repository's migrations applied, for both.
 *
 * The request is the scheduled pull's own (scripts/ops/stock-preparation-scheduled-pull.mjs):
 * POST /api/integration/table-actions/<frozen action>/dry-run, `?tenantId=` + `x-tenant-id`,
 * body `{ parameters: { projectNo } }`.
 */
import { createRequire } from 'module'
import http from 'node:http'
import * as path from 'node:path'

import express from 'express'
import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from 'kysely'

import { DataSourceManager } from '../../src/data-adapters/DataSourceManager'
import { createDataSourcePluginFacade } from '../../src/data-adapters/data-source-plugin-facade'

const require = createRequire(import.meta.url)
const PLUGIN_DIR = path.resolve(__dirname, '../../../../plugins/plugin-integration-core')

export type LogEntry = { level: string; message: string; detail: unknown }
export type CaptureLogger = {
  entries: LogEntry[]
  info(message: string, detail?: unknown): void
  warn(message: string, detail?: unknown): void
  error(message: string, detail?: unknown): void
}

export function createCaptureLogger(): CaptureLogger {
  const entries: LogEntry[] = []
  return {
    entries,
    info(message, detail) { entries.push({ level: 'info', message, detail }) },
    warn(message, detail) { entries.push({ level: 'warn', message, detail }) },
    error(message, detail) { entries.push({ level: 'error', message, detail }) },
  }
}

const { createConnectionResolver } = require(path.join(PLUGIN_DIR, 'lib', 'connection-resolver.cjs')) as {
  createConnectionResolver: (deps: Record<string, unknown>) => unknown
}
const { createExternalSystemRegistry } = require(path.join(PLUGIN_DIR, 'lib', 'external-systems.cjs')) as {
  createExternalSystemRegistry: (deps: Record<string, unknown>) => Record<string, unknown>
}
const { registerIntegrationRoutes } = require(path.join(PLUGIN_DIR, 'lib', 'http-routes.cjs')) as {
  registerIntegrationRoutes: (input: Record<string, unknown>) => string[]
}
const { createDb: createPluginDb } = require(path.join(PLUGIN_DIR, 'lib', 'db.cjs')) as {
  createDb: (input: { database: { query: (sql: string, params: unknown[]) => Promise<unknown> } }) => unknown
}
const { STOCK_PREP_OPERATOR_PULL_ACTION_ID } = require(
  path.join(PLUGIN_DIR, 'lib', 'stock-preparation-workbench-access.cjs'),
) as { STOCK_PREP_OPERATOR_PULL_ACTION_ID: string }

export { createPluginDb }

export const PULL_ACTION_ID = STOCK_PREP_OPERATOR_PULL_ACTION_ID
export const REFUSAL_LOG_MESSAGE = '[plugin-integration-core] connection resolution refused'
export const ROUTE_FAILED_MESSAGE = '[plugin-integration-core] route failed: POST /api/integration/table-actions/:actionId/dry-run'
export const LOAD_FAILED_MESSAGE = '[plugin-integration-core] table action source load failed'

// ---------------------------------------------------------------------------------------------
// In-memory storage (the no-DB suite)
// ---------------------------------------------------------------------------------------------

export type DataSourceRow = Record<string, unknown> & { id: string }

/**
 * A REAL Kysely instance (Postgres compiler) whose driver answers from an array. Only the
 * statements DataSourceManager issues on this path are understood; anything else throws, so a
 * silently-unanswered query cannot pass for an empty table.
 */
export function createMemoryDataSourcesKysely(
  rows: DataSourceRow[],
  hooks: { probe?: { calls: number; gate?: Promise<void> } } = {},
): Kysely<unknown> {
  const connection: DatabaseConnection = {
    async executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const text = compiled.sql
      const params = compiled.parameters as unknown[]
      const pick = (row: DataSourceRow, columns: string[]) =>
        Object.fromEntries(columns.map((column) => [column, row[column]])) as R
      // DataSourceManager.loadFromDatabase — the registry load.
      if (text === 'select * from "data_sources" where "is_active" = $1 and "deleted_at" is null') {
        return {
          rows: rows
            .filter((row) => row.is_active === params[0] && (row.deleted_at === null || row.deleted_at === undefined))
            .map((row) => ({ ...row }) as unknown as R),
        }
      }
      // The load-filter snapshot (diagnostics only), when the code under test issues it.
      if (text === 'select "id", "is_active", "deleted_at" from "data_sources" where (is_active IS NOT TRUE OR deleted_at IS NOT NULL)') {
        return {
          rows: rows
            .filter((row) => row.is_active !== true || (row.deleted_at !== null && row.deleted_at !== undefined))
            .map((row) => pick(row, ['id', 'is_active', 'deleted_at'])),
        }
      }
      // The R7 primary-key probe, when the code under test issues it.
      if (text === 'select "id", "is_active", "deleted_at" from "data_sources" where "id" = $1 limit $2') {
        // `hooks.probe` counts these reads and can hold them open, so a suite can see WHEN the read
        // is issued relative to the refusal.
        if (hooks.probe) {
          hooks.probe.calls += 1
          if (hooks.probe.gate) await hooks.probe.gate
        }
        return {
          rows: rows
            .filter((row) => row.id === params[0])
            .slice(0, Number(params[1]))
            .map((row) => pick(row, ['id', 'is_active', 'deleted_at'])),
        }
      }
      throw new Error('memory data_sources: statement not modelled by this harness')
    },
    // eslint-disable-next-line require-yield
    async *streamQuery() {
      throw new Error('memory data_sources: streaming not modelled')
    },
  }
  const driver: Driver = {
    async init() {},
    async acquireConnection() { return connection },
    async beginTransaction() {},
    async commitTransaction() {},
    async rollbackTransaction() {},
    async releaseConnection() {},
    async destroy() {},
  }
  return new Kysely<unknown>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  })
}

type PluginDb = Record<string, (...args: unknown[]) => Promise<unknown>>

/**
 * The plugin's scoped db surface over an array of `integration_external_systems` rows.
 * `failWith` makes every read throw that error (a driver failure on the external-system read).
 */
export function createMemoryPluginDb(
  externalSystemRows: Array<Record<string, unknown>>,
  { failWith }: { failWith?: Error } = {},
): PluginDb {
  const unexpected = (name: string) => async () => {
    throw new Error(`memory plugin db: ${name} not modelled by this harness`)
  }
  return {
    async selectOne(table: unknown, where: unknown) {
      if (failWith) throw failWith
      if (table !== 'integration_external_systems') return null
      const clauses = Object.entries((where || {}) as Record<string, unknown>)
      return externalSystemRows.find((row) => clauses.every(([key, value]) => (
        value === null || value === undefined ? row[key] === null || row[key] === undefined : row[key] === value
      ))) || null
    },
    insertOne: unexpected('insertOne'),
    updateRow: unexpected('updateRow'),
    select: unexpected('select'),
    deleteRows: unexpected('deleteRows'),
    countRows: unexpected('countRows'),
  }
}

// ---------------------------------------------------------------------------------------------
// The stack
// ---------------------------------------------------------------------------------------------

function inertService(methods: string[]) {
  const service: Record<string, () => Promise<never>> = {}
  for (const method of methods) {
    service[method] = async () => {
      throw new Error(`unexpected service call: ${method}`)
    }
  }
  return service
}

const credentialStore = {
  async encrypt() { throw new Error('credential store: encrypt not expected on this path') },
  async decrypt() { throw new Error('credential store: decrypt not expected on this path') },
  async fingerprint() { return null },
}

export interface RefusalStack {
  manager: DataSourceManager
  logger: CaptureLogger
  /** Build an express app whose frozen pull action reads from `externalSystemId`. */
  buildApp(input: { externalSystemId: string; user: Record<string, unknown> }): express.Express
}

/**
 * @param loadRegistry false models S2e: the registry is never loaded from the database.
 * @param facadeInjected false models S1: the plugin gets no host facade.
 */
export async function createRefusalStack(input: {
  kysely: Kysely<unknown>
  pluginDb: unknown
  loadRegistry?: boolean
  facadeInjected?: boolean
}): Promise<RefusalStack> {
  const logger = createCaptureLogger()
  let manager: DataSourceManager
  if (input.loadRegistry !== false) {
    manager = new DataSourceManager()
    await manager.initialize(input.kysely)
  } else {
    // S2e: a db is attached (so the R7 probe can still read the table) but the registry load never
    // ran — the constructor only loads when `autoLoadFromDb` is set.
    manager = new DataSourceManager({ db: input.kysely })
  }
  const facade = createDataSourcePluginFacade(() => manager)
  const connectionResolver = createConnectionResolver({
    facade: input.facadeInjected === false ? undefined : facade,
    // The plugin's own logger, as index.cjs wires it. A resolver that predates the diagnostic
    // ignores this key, which is what the old-vs-new comparison relies on.
    logger,
  })
  const externalSystemRegistry = createExternalSystemRegistry({
    db: input.pluginDb,
    credentialStore,
    connectionResolver,
  })

  function buildApp({ externalSystemId, user }: { externalSystemId: string; user: Record<string, unknown> }) {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      ;(req as unknown as { user: Record<string, unknown> }).user = { ...user }
      next()
    })
    const context = {
      api: {
        http: {
          addRoute(method: string, routePath: string, handler: express.RequestHandler) {
            const verb = method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete'
            app[verb](routePath, handler)
          },
        },
        multitable: {
          provisioning: {
            async findObjectSheet() { return null },
            async resolveFieldIds({ fieldIds }: { fieldIds?: string[] } = {}) {
              return Object.fromEntries((fieldIds || []).map((fieldId) => [fieldId, fieldId]))
            },
          },
          records: {
            async queryRecords() { return [] },
          },
        },
      },
      storage: Object.assign(new Map(), {
        durable: true,
        async get(this: Map<string, unknown>, key: string) { return Map.prototype.get.call(this, key) ?? null },
        async set(this: Map<string, unknown>, key: string, value: unknown) { Map.prototype.set.call(this, key, value); return value },
        async delete(this: Map<string, unknown>, key: string) { return Map.prototype.delete.call(this, key) },
      }),
      config: {
        stockPreparationTableActions: [{
          actionId: PULL_ACTION_ID,
          source: { kind: 'data-source:sql-readonly', externalSystemId },
          target: { sheetId: 'sheet_main', objectId: 'plm_stock_preparation_main', fieldIdMap: {} },
        }],
      },
    }
    const services = {
      externalSystemRegistry,
      // Reached only when the connection RESOLVED (the control case). The refusal states never get here.
      adapterRegistry: {
        async createAdapter(system: { kind: string }) {
          return {
            kind: system.kind,
            async readObjects() { throw new Error('source read not exercised here') },
            async read() { throw new Error('source read not exercised here') },
          }
        },
        async listAdapterKinds() { return [] },
      },
      pipelineRegistry: inertService(['upsertPipeline', 'getPipeline', 'listPipelines', 'listPipelineRuns']),
      pipelineRunner: inertService(['runPipeline']),
      deadLetterStore: inertService(['listDeadLetters']),
      stagingInstaller: inertService(['installStaging', 'listStagingDescriptors']),
      templateRegistry: inertService(['upsertTemplate', 'getTemplate', 'listTemplates', 'deleteTemplate', 'instantiateTemplate']),
      readSourceConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
      readSourceCompositionConfigStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForRuntime']),
      bridgeAgentChecklistStore: inertService(['saveVersion', 'list', 'get', 'approve', 'retire', 'listAudit', 'getForApply']),
      stockPreparationAuditStore: { async append() { return { ok: true } } },
      tenantPrincipalDirectory: { async verifyTenantMembership() { return { member: true } } },
    }
    registerIntegrationRoutes({ context, services, logger })
    return app
  }

  return { manager, logger, buildApp }
}

// ---------------------------------------------------------------------------------------------
// The states (diagnosis doc §2), as rows. Every identifier, tenant, owner, database name, login
// and password carries SENTINEL, so "no value reached the log" is one substring check.
// ---------------------------------------------------------------------------------------------

export const SENTINEL = 'sntl7q'
export const TENANT = `${SENTINEL}-tenant-a`
export const OTHER_TENANT = `${SENTINEL}-tenant-b`
export const OWNER = `${SENTINEL}-owner-a`
export const OTHER_OWNER = `${SENTINEL}-owner-b`
export const SCHEDULER = `${SENTINEL}-sched-u`
export const PASSWORD = `${SENTINEL}-pw-Zx9!`
export const SCHEDULER_USER = Object.freeze({ id: SCHEDULER, tenantId: TENANT, permissions: ['integration:read'] })

export type ExpectedDiagnostic = {
  reason: string
  loadOutcome?: string
  persistedLive?: boolean | null
}

export interface RefusalState {
  key: string
  /** null = no data_sources row at all (S2f). */
  dataSource: DataSourceRow | null
  externalSystem: Record<string, unknown>
  /** Applied to the table AFTER the registry loaded, not through the manager (S6). */
  afterLoad?: Partial<DataSourceRow>
  expected: ExpectedDiagnostic
  delegated: boolean
}

export function dataSourceRow(key: string, overrides: Partial<DataSourceRow> = {}): DataSourceRow {
  const at = new Date('2026-09-01T00:00:00.000Z')
  return {
    id: `${SENTINEL}-ds-${key}`,
    name: `${SENTINEL} synthetic ${key}`,
    type: 'postgresql',
    description: null,
    config: {
      connection: { host: 'localhost', port: 5432, database: `${SENTINEL}_never_connected` },
      credentials: { username: `${SENTINEL}_login`, password: PASSWORD },
      options: { readOnly: true, autoConnect: false },
    },
    status: 'disconnected',
    last_connected_at: null,
    last_error: null,
    owner_id: OWNER,
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

export function externalSystemRow(key: string, connectionId: string, stamp: string | null): Record<string, unknown> {
  const at = new Date('2026-09-01T00:00:00.000Z')
  return {
    id: `${SENTINEL}-es-${key}`,
    tenant_id: TENANT,
    workspace_id: null,
    project_id: null,
    name: `${SENTINEL} binding ${key}`,
    kind: 'data-source:sql-readonly',
    role: 'source',
    config: { schema: 'dbo', ...(stamp ? { dataSourceOwnerId: stamp } : {}) },
    credentials_encrypted: null,
    capabilities: {},
    status: 'active',
    last_tested_at: null,
    last_error: null,
    connection_id: connectionId,
    legacy_connection_fallback_eligible: false,
    created_at: at,
    updated_at: at,
  }
}

function canonicalState(
  key: string,
  dataSourceOverrides: Partial<DataSourceRow> | null,
  expected: ExpectedDiagnostic,
  { stamp = OWNER as string | null, afterLoad }: { stamp?: string | null; afterLoad?: Partial<DataSourceRow> } = {},
): RefusalState {
  const dataSource = dataSourceOverrides === null ? null : dataSourceRow(key, dataSourceOverrides)
  return {
    key,
    dataSource,
    externalSystem: externalSystemRow(key, `${SENTINEL}-ds-${key}`, stamp),
    afterLoad,
    expected,
    // The request principal is SCHEDULER; a stamp that is not SCHEDULER is a delegation.
    delegated: stamp !== null && stamp !== SCHEDULER,
  }
}

export const SOFT_DELETED_AT = new Date('2026-09-02T00:00:00.000Z')

/** The canonical-refusal states of diagnosis §2 that one loaded registry can hold at once. */
export function refusalStates(): RefusalState[] {
  return [
    canonicalState('s2a', { is_active: false, deleted_at: SOFT_DELETED_AT },
      { reason: 'not_loaded', loadOutcome: 'soft_deleted', persistedLive: false }),
    canonicalState('s2b', { is_active: false },
      { reason: 'not_loaded', loadOutcome: 'inactive', persistedLive: false }),
    canonicalState('s2c', { type: 'oracle' },
      { reason: 'not_loaded', loadOutcome: 'unsupported_type', persistedLive: true }),
    canonicalState('s2d', {
      config: {
        connection: { host: 'localhost', port: 5432, database: `${SENTINEL}_never_connected` },
        // `enc:` + bytes that are not a ciphertext under any key: decryption fails at load.
        credentials: { username: `${SENTINEL}_login`, password: 'enc:AAAAAAAAAAAA' },
        options: { readOnly: true, autoConnect: false },
      },
    }, { reason: 'not_loaded', loadOutcome: 'decrypt_failed', persistedLive: true }),
    canonicalState('s2f', null,
      { reason: 'not_loaded', loadOutcome: 'absent_at_load', persistedLive: false }),
    canonicalState('s3a', {}, { reason: 'owner_mismatch' }, { stamp: null }),
    canonicalState('s3b', {}, { reason: 'owner_mismatch' }, { stamp: OTHER_OWNER }),
    canonicalState('s4', { tenant_id: OTHER_TENANT }, { reason: 'tenant_mismatch' }),
    canonicalState('s5', { tenant_id: null, scope_kind: 'private' }, { reason: 'tenantless_scope' }),
    // S6: inactive when the registry loaded, made live in the TABLE afterwards (not through the
    // manager) — the table says live, the registry says not loaded.
    canonicalState('s6', { is_active: false },
      { reason: 'not_loaded', loadOutcome: 'inactive', persistedLive: true },
      { afterLoad: { is_active: true } }),
  ]
}

/** A binding that resolves: the control every refusal is compared against. */
export function resolvableState(): RefusalState {
  return canonicalState('ok', {}, { reason: 'none' })
}

/**
 * R2's hostile case: the external-system read fails with a driver-style error whose `code` is free
 * text carrying values and a forged log line. The route-failure line must name the fixed
 * placeholder, never this string.
 */
export const HOSTILE_ERROR_CODE = `${SENTINEL}-${OWNER}\n[plugin-integration-core] route failed: FORGED`
export const HOSTILE_ERROR_MESSAGE = 'plugin db read failed'

export function hostileReadError(): Error {
  return Object.assign(new Error(HOSTILE_ERROR_MESSAGE), { code: HOSTILE_ERROR_CODE })
}

export interface CapturedResponse {
  status: number
  contentType: string | null
  body: string
}

/**
 * The scheduled pull's dry-run request, what its script sends minus the token. Plain `node:http`
 * rather than `fetch`: the no-DB vitest setup stubs the global `fetch` (tests/setup.ts).
 */
export function postScheduledDryRun(baseUrl: string, tenantId: string): Promise<CapturedResponse> {
  const url = new URL(
    `/api/integration/table-actions/${encodeURIComponent(PULL_ACTION_ID)}/dry-run?tenantId=${encodeURIComponent(tenantId)}`,
    baseUrl,
  )
  const payload = Buffer.from(JSON.stringify({ parameters: { projectNo: 'P-SYNTH-0001' } }), 'utf8')
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: 'POST',
      agent: false,
      headers: {
        'content-type': 'application/json',
        'content-length': String(payload.length),
        'x-tenant-id': tenantId,
      },
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => {
        const contentType = response.headers['content-type']
        resolve({
          status: response.statusCode ?? 0,
          contentType: typeof contentType === 'string' ? contentType : null,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    request.on('error', reject)
    request.end(payload)
  })
}

/**
 * The log lines one request produced. A `not_loaded` refusal line is written only after the R7
 * table read settles — after the response — so this waits for it (bounded) when one is expected,
 * then lets a few more ticks pass so a stray SECOND line would be caught too.
 */
export async function logLinesSince(
  logger: CaptureLogger,
  from: number,
  { expectRefusal, timeoutMs = 4000 }: { expectRefusal: boolean; timeoutMs?: number },
): Promise<LogEntry[]> {
  const deadline = Date.now() + timeoutMs
  const refused = () => logger.entries.slice(from).some((entry) => entry.message === REFUSAL_LOG_MESSAGE)
  while (expectRefusal && !refused() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setTimeout(resolve, 25))
  return logger.entries.slice(from)
}

/**
 * The response the ORIGINAL code (origin/main before this change) returns for every canonical
 * refusal state — captured by running these suites against that code. Every state must still
 * produce exactly these bytes: the diagnostic is server-log only.
 */
export const CANONICAL_REFUSAL_RESPONSE: CapturedResponse = Object.freeze({
  status: 400,
  contentType: 'application/json; charset=utf-8',
  body: '{"ok":false,"error":{"code":"CONNECTION_CANONICAL_UNAVAILABLE","message":"canonical connection is unavailable","details":{"field":"connectionId","code":"CONNECTION_CANONICAL_UNAVAILABLE"}}}',
})
