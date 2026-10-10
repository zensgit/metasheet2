import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { Kysely, PostgresDialect } from 'kysely'
import { Client, Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AuthService } from '../../src/auth/AuthService'
import type { DataSourceConfig } from '../../src/data-adapters/BaseAdapter'
import type { DataSourceManager } from '../../src/data-adapters/DataSourceManager'
import type { DataSourceReadOnlyFacade } from '../../src/data-adapters/data-source-plugin-facade'
import type { LoadedPlugin, PluginLoader } from '../../src/core/plugin-loader'
import type { MetaSheetServer } from '../../src/index'
import type { PluginRuntimeSecurityService } from '../../src/security/plugin-runtime-security-service'
import type { PluginContext } from '../../src/types/plugin'
import { up as createDataSources } from '../../src/db/migrations/20251206000001_create_data_sources_table'
import { up as addConnectionBinding } from '../../src/db/migrations/zzzz20260902120000_add_integration_connection_binding'
import { up as addLiveBindingLock } from '../../src/db/migrations/zzzz20260920120000_data_source_live_id_binding_lock'
import { up as addSourceValidationRevisions } from '../../src/db/migrations/zzzz20261001120001_stock_prep_validation_source_revisions'
import { up as addValidationLedger } from '../../src/db/migrations/zzzz20261001121000_stock_prep_read_plan_validation_ledger'
import { up as widenPluginKvKey } from '../../src/db/migrations/zzzz20260610140000_widen_plugin_kv_key'
import { getObjectFieldId, getObjectSheetId } from '../../src/multitable/provisioning'
import {
  compileSourcePlanDraft,
  createEmptySourcePlanDraft,
} from '../../../../apps/web/src/services/integration/stockPreparation/sourcePlanDraft'

// This is an explicit real-DB lane: absence of its fixture is a failure, never a skip.
if (!process.env.DATABASE_URL || (process.env.EXPECT_DB !== '1' && process.env.METASHEET_REAL_DB_TEST_STEP !== '1')) {
  throw new Error('SA-02L host composition requires DATABASE_URL and EXPECT_DB=1 or METASHEET_REAL_DB_TEST_STEP=1')
}

// Only expose existing private composition seams. No fabricated plugin context, loader entry,
// capability, request user, database transport, or full-platform start() is used by this suite.
type HostSeam = {
  httpServer: Server
  pluginLoader: PluginLoader
  pluginRuntimeSecurityService: PluginRuntimeSecurityService
  createPluginContext(loaded: LoadedPlugin): PluginContext
  activatePluginByName(name: string): Promise<{ status: string }>
  deactivatePluginByName(name: string): Promise<{ status: string }>
}
type Reply = {
  status: number
  ok: boolean
  data?: Record<string, unknown>
  error?: { code: string }
}
type SyntheticExpansion = {
  valid: boolean
  status: string
  errors: unknown[]
  rowErrors: unknown[]
  rows: Array<{
    componentSourceId: string
    parentSourceId: string | null
    totalQuantity: number
    sourceVersion: string
    orderBomVersion?: string
  }>
}
type TargetDescriptor = {
  id: string
  name: string
  description: string
  fields: Array<{ id: string; name: string; type: string; order: number; property: Record<string, unknown> }>
}

function observedSql(call: unknown[]): { text: string; values: unknown } | null {
  const query = call[0]
  if (typeof query === 'string') return { text: query, values: call[1] }
  // ConnectionPool's transaction wrapper passes pg a QueryConfig, whereas the
  // outer host wrapper receives a SQL string. Both observers call through.
  if (query && typeof query === 'object' && 'text' in query && typeof query.text === 'string') {
    return { text: query.text, values: 'values' in query ? query.values : undefined }
  }
  return null
}

describe.sequential('SA-02L real MetaSheetServer composition: metadata-only read-plan management', () => {
  const nonce = randomUUID().replaceAll('-', '')
  const schema = `sa02l_host_${nonce}`
  const tenant = `sa02l-tenant-${nonce}`
  const foreignTenant = `sa02l-foreign-tenant-${nonce}`
  const owner = `sa02l-owner-${nonce}`
  const otherAdmin = `sa02l-admin-${nonce}`
  const foreignOwner = `sa02l-foreign-owner-${nonce}`
  const connection = `sa02l-connection-${nonce}`
  const foreignConnection = `sa02l-foreign-connection-${nonce}`
  const system = `sa02l-system-${nonce}`
  const foreignSystem = `sa02l-foreign-system-${nonce}`
  const pluginName = 'plugin-integration-core'
  const actionId = 'plm.stock-preparation.pull-bom.v1'
  const projectId = `${tenant}:integration-core`
  const requireCjs = createRequire(import.meta.url)
  const { buildStockPreparationTargetDescriptor } = requireCjs('../../../../plugins/plugin-integration-core/lib/stock-preparation-target-provisioning.cjs') as {
    buildStockPreparationTargetDescriptor(): TargetDescriptor
  }
  const targetDescriptor = buildStockPreparationTargetDescriptor()
  const targetSheetId = getObjectSheetId(projectId, targetDescriptor.id)
  const targetFieldIdMap = Object.fromEntries(targetDescriptor.fields.map(field =>
    [field.id, getObjectFieldId(projectId, targetDescriptor.id, field.id)]))
  const basePath = '/api/integration/stock-preparation/read-plan-configs'
  const savedEnv = new Map<string, string | undefined>()
  const observers: Array<{ mockClear(): unknown; mockRestore(): unknown }> = []
  let adminPool: Pool | undefined
  let fixtureDb: Kysely<unknown> | undefined
  let fixturePool: Pool
  let schemaCreated = false
  let host: MetaSheetServer | undefined
  let seam: HostSeam
  let manager: DataSourceManager | undefined
  let poolManager: typeof import('../../src/integration/db/connection-pool')['poolManager'] | undefined
  let authService: AuthService
  let facade: DataSourceReadOnlyFacade
  let resolveRegistration: DataSourceReadOnlyFacade['resolveConnectionRegistration']
  let origin = ''
  let ownerToken = ''
  let otherToken = ''
  let portableReviewJson = ''
  let foreignToken = ''
  let version = ''
  let sourceObservers: Array<{ mock: { calls: unknown[] } }> = []
  let explicitValidationRead = false
  let expansionObserver: {
    mock: { calls: unknown[][]; results: Array<{ value: Promise<SyntheticExpansion> }> }
  }
  let hostQueryObserver: { mock: { calls: unknown[][] } }
  let transactionQueryObserver: { mock: { calls: unknown[][] } }

  function setEnv(name: string, value?: string) {
    if (!savedEnv.has(name)) savedEnv.set(name, process.env[name])
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }

  function config(systemId = system) {
    const draft = createEmptySourcePlanDraft()
    const roles = {
      pathExAttr: { object: `${schema}.project_links`, matchField: 'project_code', pathIdField: 'path_ref' },
      pathInfo: { object: `${schema}.folders`, idField: 'folder_id' },
      orderHead: { object: `${schema}.sales_headers`, idField: 'order_id', pathIdField: 'folder_ref' },
      orderDetail: { object: `${schema}.sales_lines`, orderIdField: 'order_ref', componentIdField: 'part_ref', quantityField: 'ordered_qty', sortField: 'line_no', versionField: 'selected_rev' },
      part: { object: `${schema}.parts`, idField: 'part_id', codeField: 'drawing_no', nameField: 'part_name', materialField: 'material_name', versionField: 'part_rev' },
      bomHead: { object: `${schema}.bom_headers`, parentPartField: 'parent_ref', bomIdField: 'bom_id', versionField: 'bom_rev', activeField: 'enabled' },
      bomDetail: { object: `${schema}.bom_lines`, bomParentField: 'header_ref', componentIdField: 'child_ref', quantityField: 'per_qty', sortField: 'position_no' },
    }
    for (const role of Object.keys(roles) as Array<keyof typeof roles>) Object.assign(draft.roles[role], roles[role])
    const compiled = compileSourcePlanDraft(draft)
    expect(compiled.ok).toBe(true)
    return { schemaVersion: 1, actionId, systemId, readPlan: compiled.envelope!.readPlan }
  }

  async function request(method: 'GET' | 'POST', path: string, body?: unknown, token = ownerToken, headers: Record<string, string> = {}): Promise<Reply> {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, ...await response.json() as Omit<Reply, 'status'> }
  }

  function save(systemId = system, token = ownerToken, headers: Record<string, string> = {}) {
    return request('POST', basePath, { managementScope: 'tenant', config: config(systemId) }, token, headers)
  }

  function mutate(operation: string, expectedGeneration?: number, token = ownerToken) {
    const path = operation === 'deactivate' ? `${basePath}/deactivate` : `${basePath}/${version}/${operation}`
    return request('POST', path, { managementScope: 'tenant', systemId: system,
      ...(expectedGeneration === undefined ? {} : { expectedGeneration }),
    }, token)
  }

  function list(systemId = system, token = ownerToken, headers: Record<string, string> = {}) {
    return request('GET', `${basePath}?managementScope=tenant&systemId=${systemId}`, undefined, token, headers)
  }

  async function ledgerSnapshot() {
    const result: Record<string, unknown> = {}
    for (const table of ['versions', 'activation', 'audit', 'validations']) {
      result[table] = (await fixturePool.query(
        `SELECT to_jsonb(t) AS row FROM integration_stock_prep_read_plan_${table} t ORDER BY id`,
      )).rows
    }
    return result
  }

  async function businessSnapshot() {
    const result: Record<string, unknown> = {}
    for (const table of ['project_links', 'folders', 'sales_headers', 'sales_lines', 'parts', 'bom_headers', 'bom_lines', 'bom_lines_alternate',
      'meta_sheets', 'meta_fields', 'meta_records', 'plugin_multitable_object_registry', 'integration_stock_prep_pack_installs']) {
      result[table] = (await fixturePool.query(
        `SELECT to_jsonb(t) AS row FROM ${schema}.${table} t ORDER BY to_jsonb(t)::text`,
      )).rows
    }
    return result
  }

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL!
    // A unique owned schema avoids mutating the CI database's migrated public tables. pg's URL
    // options establish search_path on EVERY real host connection, including transactions/RBAC.
    adminPool = new Pool({ connectionString: databaseUrl })
    await adminPool.query(`CREATE SCHEMA ${schema}`)
    schemaCreated = true
    const scopedUrl = new URL(databaseUrl)
    scopedUrl.searchParams.set('options', `-c search_path=${schema},public`)
    setEnv('DATABASE_URL', scopedUrl.toString())
    for (const name of ['JWT_SECRET', 'ENCRYPTION_KEY', 'ENCRYPTION_SALT']) setEnv(name, randomBytes(32).toString('hex'))
    for (const name of Object.keys(process.env)) {
      if (name.startsWith('INTEGRATION_CORE_') && (name.endsWith('_PATH') || name.endsWith('_JSON'))) setEnv(name)
    }
    for (const [name, value] of Object.entries({
      NODE_ENV: 'production', SECRET_PROVIDER: 'env', ALLOW_SECRET_FALLBACK: 'false',
      RBAC_TOKEN_TRUST: 'false', RBAC_BYPASS: 'false', RBAC_OPTIONAL: '0',
      ALLOW_UNSAFE_ADMIN: 'false', ENABLE_FALLBACK_TEST: 'false', ENABLE_MESSAGE_DEDUP: 'false',
      ENABLE_BPMN_RUNTIME: 'false', ENABLE_BPMN_TIMER_POLLER: 'false', DISABLE_WORKFLOW: 'true',
      DISABLE_EVENT_BUS: 'true', FEATURE_CACHE: 'false', FEATURE_CACHE_REDIS: 'false',
      MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_ENABLED: 'false',
      ELEARNING_ENABLED: 'false', ENABLE_YJS_COLLAB: 'false', ENABLE_PLM: 'false',
      DINGTALK_TODO_MIRROR_ENABLED: 'false', AUTOMATION_DURABLE_DELIVERY_ENABLED: 'false',
      DB_SSL: 'false', DB_POOL_MIN: '0', DB_POOL_MAX: '3',
    })) setEnv(name, value)
    setEnv('REDIS_URL')
    fixturePool = new Pool({ connectionString: scopedUrl.toString() })
    fixtureDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: fixturePool }) })
    for (const migration of ['057_create_integration_core_tables.sql', '066_create_integration_stock_prep_audit.sql',
      '076_create_integration_stock_prep_pack_installs.sql', '079_create_integration_stock_prep_source_binding.sql',
      '080_extend_stock_prep_audit_source_binding_action.sql', '089_create_integration_stock_prep_read_plan_versions.sql']) {
      await fixturePool.query(await readFile(new URL(`../../migrations/${migration}`, import.meta.url), 'utf8'))
    }
    await createDataSources(fixtureDb)
    await addConnectionBinding(fixtureDb)
    await addLiveBindingLock(fixtureDb)
    await addSourceValidationRevisions(fixtureDb)
    await addValidationLedger(fixtureDb)
    // Owned seven-role SQL fixture; explicit validation, preflight and preview tests may
    // read it. No customer database or source connection is ever used.
    await fixturePool.query(`
      CREATE TABLE project_links (project_code text, path_ref text);
      CREATE TABLE folders (folder_id text);
      CREATE TABLE sales_headers (order_id text, folder_ref text);
      CREATE TABLE sales_lines (order_ref text, part_ref text, ordered_qty numeric, line_no integer, selected_rev text);
      CREATE TABLE parts (part_id text, drawing_no text, part_name text, browser_synthetic_name text, material_name text, part_rev text);
      CREATE TABLE bom_headers (parent_ref text, bom_id text, bom_rev text, enabled boolean);
      CREATE TABLE bom_lines (header_ref text, child_ref text, per_qty numeric, position_no integer);
      CREATE TABLE bom_lines_alternate (header_ref text, child_ref text, per_qty numeric, position_no integer);
      INSERT INTO project_links VALUES ('SYN-VALIDATION','FOLDER');
      INSERT INTO folders VALUES ('FOLDER');
      INSERT INTO sales_headers VALUES ('ORDER','FOLDER');
      INSERT INTO sales_lines VALUES ('ORDER','ROOT',2,0,'B2');
      INSERT INTO parts VALUES ('ROOT','SYN-ROOT','Synthetic assembly','Synthetic browser assembly','Steel','P1'),
        ('CHILD','SYN-CHILD','Synthetic part','Synthetic browser part','Steel','P1'),
        ('EXTRA','SYN-EXTRA','Synthetic alternate part','Synthetic browser alternate part','Steel','P1');
      INSERT INTO bom_headers VALUES ('ROOT','BOM','B2',true);
      INSERT INTO bom_lines VALUES ('BOM','CHILD',3,0);
      INSERT INTO bom_lines_alternate VALUES ('BOM','CHILD',3,0), ('BOM','EXTRA',1,1);
    `)
    // Seed canonical metadata with the production descriptor and ID derivation. The
    // real host still enforces registry ownership, reads fields/records and persists
    // tokens; none of those production surfaces are replaced by test implementations.
    await fixturePool.query(`
      CREATE TABLE ${schema}.meta_sheets (id text PRIMARY KEY, base_id text, name text NOT NULL,
        description text, deleted_at timestamptz, copied_from_kind text);
      CREATE TABLE ${schema}.meta_fields (id text PRIMARY KEY, sheet_id text NOT NULL REFERENCES ${schema}.meta_sheets(id),
        name text NOT NULL, type text NOT NULL, property jsonb NOT NULL, "order" integer NOT NULL);
      CREATE TABLE ${schema}.meta_records (id text PRIMARY KEY, sheet_id text NOT NULL REFERENCES ${schema}.meta_sheets(id),
        version integer NOT NULL DEFAULT 1, data jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        created_by text, modified_by text, locked boolean NOT NULL DEFAULT false, locked_by text, locked_at timestamptz);
      CREATE TABLE ${schema}.plugin_multitable_object_registry (sheet_id text PRIMARY KEY REFERENCES ${schema}.meta_sheets(id),
        project_id text NOT NULL, object_id text NOT NULL, plugin_name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (project_id, object_id));
      CREATE TABLE ${schema}.plugin_kv (plugin varchar(255) NOT NULL, key varchar(255) NOT NULL, value jsonb,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (plugin,key));
    `)
    await widenPluginKvKey(fixtureDb)
    await fixturePool.query('INSERT INTO meta_sheets (id,base_id,name,description) VALUES ($1,$2,$3,$4)',
      [targetSheetId, projectId, targetDescriptor.name, targetDescriptor.description])
    for (const field of targetDescriptor.fields) {
      await fixturePool.query('INSERT INTO meta_fields (id,sheet_id,name,type,property,"order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
        [targetFieldIdMap[field.id], targetSheetId, field.name, field.type, JSON.stringify(field.property), field.order])
    }
    await fixturePool.query('INSERT INTO plugin_multitable_object_registry (sheet_id,project_id,object_id,plugin_name) VALUES ($1,$2,$3,$4)',
      [targetSheetId, projectId, targetDescriptor.id, pluginName])
    for (const table of ['meta_sheets', 'meta_fields', 'meta_records', 'plugin_multitable_object_registry', 'plugin_kv', 'integration_stock_prep_pack_installs']) {
      // search_path includes public for extensions, but every business/storage lookup
      // must resolve to our owned schema rather than an existing public table.
      expect((await fixturePool.query('SELECT n.nspname AS schema FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=to_regclass($1)', [table])).rows)
        .toEqual([{ schema }])
    }
    setEnv('INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON', JSON.stringify([{
      actionId, source: { kind: 'data-source:sql-readonly', externalSystemId: system },
      target: { sheetId: targetSheetId, objectId: targetDescriptor.id, fieldIdMap: targetFieldIdMap }, rootSelection: { enabled: false },
    }]))
    await fixturePool.query(`
      CREATE TABLE users (id text PRIMARY KEY, email text, username text, mobile text, name text,
        role text NOT NULL, permissions jsonb NOT NULL DEFAULT '[]', password_hash text,
        is_active boolean NOT NULL, must_change_password boolean NOT NULL,
        activation_status text NOT NULL, local_password_set boolean NOT NULL,
        created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
      CREATE TABLE user_orgs (user_id text REFERENCES users(id), org_id text, is_active boolean NOT NULL);
      CREATE TABLE user_roles (user_id text REFERENCES users(id), role_id text);
      CREATE TABLE role_permissions (role_id text, permission_code text);
      CREATE TABLE user_permissions (user_id text REFERENCES users(id), permission_code text);
      CREATE TABLE user_namespace_admissions (user_id text, namespace text, enabled boolean,
        source text, granted_by text, updated_by text, created_at timestamptz, updated_at timestamptz);
      CREATE TABLE user_session_revocations (user_id text PRIMARY KEY REFERENCES users(id),
        revoked_after timestamptz, updated_at timestamptz, updated_by text, reason text);
      INSERT INTO role_permissions VALUES ('admin','integration:admin');
    `)
    for (const [id, tenantId] of [[owner, tenant], [otherAdmin, tenant], [foreignOwner, foreignTenant]]) {
      await fixturePool.query(`INSERT INTO users (id,email,name,role,is_active,must_change_password,activation_status,local_password_set)
        VALUES ($1,$2,'Synthetic host user','user',true,false,'activated',true)`, [id, `${id}@example.invalid`])
      await fixturePool.query('INSERT INTO user_orgs VALUES ($1,$2,true)', [id, tenantId])
      await fixturePool.query("INSERT INTO user_roles VALUES ($1,'admin')", [id])
    }
    // All host/auth/singleton imports occur AFTER synthetic env and schema setup. No transport
    // replacement: host CoreAPI.database and AuthService use their actual production pool.
    // Install before the plugin imports its destructured expander. This observer
    // calls through; HTTP intentionally exposes only values-free preview evidence.
    const expansionModule = requireCjs('../../../../plugins/plugin-integration-core/lib/stock-preparation-bom-expansion.cjs') as {
      expandPlmProjectBom(input: unknown): Promise<SyntheticExpansion>
    }
    const expansionSpy = vi.spyOn(expansionModule, 'expandPlmProjectBom')
    expansionObserver = expansionSpy
    observers.push(expansionSpy)
    const hostModule = await import('../../src/index')
    poolManager = (await import('../../src/integration/db/connection-pool')).poolManager
    const hostQuerySpy = vi.spyOn(poolManager.get(), 'query')
    hostQueryObserver = hostQuerySpy
    // Provisioning uses the host's genuine PostgreSQL transaction client instead
    // of its outer query wrapper. Observe that SQL too without replacing transport.
    const transactionQuerySpy = vi.spyOn(Client.prototype, 'query')
    transactionQueryObserver = transactionQuerySpy
    observers.push(hostQuerySpy, transactionQuerySpy)
    const hostDb = (await import('../../src/db/db')).db
    const dataSources = await import('../../src/routes/data-sources')
    const { DataSourceManager: RealDataSourceManager } = await import('../../src/data-adapters/DataSourceManager')
    const provisioningManager = new RealDataSourceManager()
    // Same schema-agnostic boundary as initializeDataSourceManager: Kysely is invariant
    // in its schema, while DataSourceManager deliberately accepts Kysely<unknown>.
    await provisioningManager.initialize(hostDb as unknown as Kysely<unknown>)
    expect((await poolManager.get().query('SELECT current_schema() AS schema')).rows).toEqual([{ schema }])
    for (const [id, ownerId, tenantId, systemId] of [
      [connection, owner, tenant, system], [foreignConnection, foreignOwner, foreignTenant, foreignSystem],
    ]) {
      const parsed = new URL(databaseUrl)
      const sourceConfig: DataSourceConfig = {
        id, name: 'Synthetic metadata-only source', type: 'postgresql',
        connection: { host: parsed.hostname, port: Number(parsed.port || 5432), database: parsed.pathname.slice(1) },
        credentials: { username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) },
        options: { readOnly: true, autoConnect: false },
        poolConfig: { min: 0, max: 1, idleTimeout: 1000 },
      }
      await provisioningManager.addDataSource(sourceConfig, { ownerId, tenantId, scopeKind: 'private', persist: true })
      // Canonical Binding is explicitly a DB fixture, NOT HTTP Connection/Binding registration proof.
      await fixturePool.query(`INSERT INTO integration_external_systems
        (id,tenant_id,name,kind,role,status,connection_id,config)
        VALUES ($1,$2,$1,'data-source:sql-readonly','source','active',$3,$4::jsonb)`,
      [systemId, tenantId, id, JSON.stringify({ dataSourceOwnerId: ownerId })])
      await fixturePool.query(`INSERT INTO integration_stock_prep_source_binding
        (id,tenant_id,action_id,external_system_id,updated_by) VALUES ($1,$2,$3,$4,$5)`,
      [`sa02l-binding-${id}`, tenantId, actionId, systemId, ownerId])
    }
    // Exercise the actual production load path with encrypted persisted sources, not just add().
    await provisioningManager.dispose()
    manager = await dataSources.initializeDataSourceManager(hostDb)
    expect(manager).toBe(dataSources.getDataSourceManager())
    for (const [id, ownerId, tenantId] of [[connection, owner, tenant], [foreignConnection, foreignOwner, foreignTenant]]) {
      expect(manager.getLoadState(id)).toBe('loaded')
      expect(manager.getScope(id)).toEqual({ ownerId, tenantId, workspaceId: null, scopeKind: 'private' })
      expect((await fixturePool.query('SELECT auto_connect FROM data_sources WHERE id=$1', [id])).rows).toEqual([{ auto_connect: false }])
    }
    authService = (await import('../../src/auth/AuthService')).authService
    const sign = (id: string, tenantId?: string) => authService.createToken({
      id, email: `${id}@example.invalid`, name: 'Synthetic host user', role: 'user', permissions: [],
      ...(tenantId ? { tenantId } : {}), created_at: new Date(), updated_at: new Date(),
    })
    ownerToken = sign(owner, tenant)
    otherToken = sign(otherAdmin, tenant)
    foreignToken = sign(foreignOwner, foreignTenant)
    host = new hostModule.MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [], manageProcessSignals: false })
    seam = host as unknown as HostSeam
    const contextObserver = vi.spyOn(seam, 'createPluginContext')
    const pluginDir = fileURLToPath(new URL('../../../../plugins/plugin-integration-core/', import.meta.url))
    const loaded = await seam.pluginLoader.load(pluginDir)
    expect(loaded?.manifest).toMatchObject({ name: pluginName, main: 'index.cjs' })
    expect(await seam.activatePluginByName(pluginName)).toMatchObject({ status: 'active' })
    expect(contextObserver).toHaveBeenCalledTimes(1)
    expect(contextObserver).toHaveBeenCalledWith(loaded)
    const actualContext = contextObserver.mock.results[0].value
    facade = actualContext.api.dataSources!
    expect(facade).toBeDefined()
    // Retain the real host method before installing the call-through observer.
    // Vitest does not expose that original via getMockImplementation().
    resolveRegistration = facade.resolveConnectionRegistration.bind(facade)
    contextObserver.mockRestore()
    const { PostgresAdapter } = await import('../../src/data-adapters/PostgresAdapter')
    const managerSecrets = manager as unknown as { decryptCredentials(credentials?: Record<string, unknown>): unknown }
    const reads = [vi.spyOn(PostgresAdapter.prototype, 'select'), vi.spyOn(PostgresAdapter.prototype, 'query'),
      vi.spyOn(manager, 'select'), vi.spyOn(facade, 'select'), vi.spyOn(managerSecrets, 'decryptCredentials'),
      vi.spyOn(seam.pluginRuntimeSecurityService, 'decrypt'), vi.spyOn(manager, 'connectDataSource'),
      vi.spyOn(manager.getDataSource(connection)!, 'getConfig'),
      vi.spyOn(manager.getDataSource(foreignConnection)!, 'getConfig')]
    sourceObservers = reads
    observers.push(...reads, vi.spyOn(facade, 'resolveConnectionRegistration'))
    await new Promise<void>((resolve, reject) => {
      seam.httpServer.once('error', reject)
      seam.httpServer.listen(0, '127.0.0.1', () => { seam.httpServer.off('error', reject); resolve() })
    })
    const address = host.getAddress()
    if (!address || typeof address === 'string') throw new Error('SA-02L missing own host listener')
    origin = `http://127.0.0.1:${address.port}`
  }, 60000)

  beforeEach(() => { for (const observer of observers) observer.mockClear() })
  afterEach(() => {
    // Save/list/confirm/approve/activate remain metadata-only. Only tests of the
    // explicit validation/preflight/preview tests opt into synthetic source IO and assert its calls.
    if (!explicitValidationRead) for (const observer of sourceObservers) expect(observer.mock.calls).toHaveLength(0)
    explicitValidationRead = false
  })

  afterAll(async () => {
    try {
      if (host) {
        await seam.deactivatePluginByName(pluginName)
        await manager?.dispose()
        // stop() drains the host-owned listener and loader; no platform start() was performed.
        await host.stop('SA02L_TEST_COMPLETE')
      } else await manager?.dispose()
    } finally {
      for (const observer of observers.reverse()) observer.mockRestore()
      if (poolManager) {
        const mainConnection = poolManager.get()
        mainConnection.stopMetricsCollection()
        // db/db's Kysely and db/pg.pool share this exact pool. stop() normally ends it;
        // close it explicitly if setup/stop failed, without swallowing end() failures or
        // calling PoolManager.close()'s logged-and-caught second end() on an ended pool.
        const mainPool = mainConnection.getInternalPool()
        if (!mainPool.ended) await mainPool.end()
        expect(mainPool.ended).toBe(true)
      }
      await fixtureDb?.destroy()
      if (adminPool) {
        // Only this random schema, created by this suite, may be removed.
        if (schemaCreated) await adminPool.query(`DROP SCHEMA ${schema} CASCADE`)
        await adminPool.end()
      }
      for (const [name, value] of savedEnv) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  }, 30000)

  it('uses DB-refreshed JWT roles and the canonical facade registered by the actual host', async () => {
    expect(await authService.verifyToken(ownerToken)).toMatchObject({ id: owner, role: 'admin', tenantId: tenant, permissions: ['integration:admin'] })
    expect(await facade.resolveConnectionRegistration(connection, { principal: owner, tenantId: tenant, workspaceId: null, runAs: 'user' }))
      .toMatchObject({ id: connection, type: 'postgresql', tenantId: tenant, scopeKind: 'private', validationRevision: expect.any(String) })
    vi.mocked(facade.resolveConnectionRegistration).mockClear()
    expect(await list()).toMatchObject({ status: 200, ok: true, data: { versions: [], activation: null } })
    expect(facade.resolveConnectionRegistration).toHaveBeenCalledWith(connection,
      { principal: owner, tenantId: tenant, workspaceId: null, runAs: 'user' })
  })

  it('saves a draft through the host mount and retrieves its config through the real HTTP list', async () => {
    const saved = await save()
    expect(saved).toMatchObject({ status: 201, ok: true, data: { status: 'draft', tenantId: tenant, createdBy: owner, config: config() } })
    version = String(saved.data!.id)
    expect(await list()).toMatchObject({ status: 200, data: { versions: [expect.objectContaining({ id: version, status: 'draft', config: config() })] } })
    expect((await fixturePool.query('SELECT created_by,status FROM integration_stock_prep_read_plan_versions WHERE id=$1', [version])).rows)
      .toEqual([{ created_by: owner, status: 'draft' }])
  })

  it('new explicit endpoints reject client attestations and unauthorized callers before any source IO or evidence write', async () => {
    const before = await ledgerSnapshot()
    const operations = [
      ['validate', { projectNo: 'SYN-VALIDATION' }],
      ['confirm-sample', { validationId: 'synthetic-not-a-receipt' }],
    ] as const
    for (const [operation, body] of operations) {
      const path = `${basePath}/${version}/${operation}`
      const payload = { managementScope: 'tenant', systemId: system, ...body }
      for (const extra of [{ passed: true }, { actor: owner }, { tenantId: tenant }, { connectionId: connection }, { catalog: [] }]) {
        expect(await request('POST', path, { ...payload, ...extra }))
          .toMatchObject({ status: 400, error: { code: 'READ_PLAN_REQUEST_INVALID' } })
      }
      expect(await request('POST', path, payload, otherToken)).toMatchObject({ status: 403 })
      expect(await request('POST', path, payload, foreignToken)).toMatchObject({ status: 403 })
      expect(await request('POST', path, payload, '')).toMatchObject({ status: 401 })
    }
    expect(await ledgerSnapshot()).toEqual(before)
  })

  it('rejects approval without measured and confirmed evidence, then validates a complete synthetic BOM through real host adapters', async () => {
    explicitValidationRead = true
    const before = await ledgerSnapshot()
    expect(await mutate('activate', 0)).toMatchObject({ status: 409, error: { code: 'READ_PLAN_NOT_APPROVED' } })
    expect(await mutate('approve')).toMatchObject({ status: 409, error: { code: 'READ_PLAN_VALIDATION_REQUIRED' } })
    expect(await ledgerSnapshot()).toEqual(before)
    const validated = await request('POST', `${basePath}/${version}/validate`, {
      managementScope: 'tenant', systemId: system, projectNo: 'SYN-VALIDATION',
    })
    expect(validated).toMatchObject({ status: 200, data: {
      validation: { status: 'passed', counts: { sampleCount: 2, objectCount: 7 } },
      sample: { totalRows: 2, rows: [expect.objectContaining({ componentCode: 'SYN-ROOT', sourceVersion: 'P1', orderBomVersion: 'B2' }),
        expect.objectContaining({ componentCode: 'SYN-CHILD', totalQuantity: 6 })] },
      canApply: false, tokenIssued: false, authorizesExecution: false,
    } })
    expect(vi.mocked(facade.select).mock.calls.length).toBeGreaterThan(0)
    expect(vi.mocked(facade.select).mock.calls.every(call => call[3] === owner
      && call[5]?.expectedValidationRevision === manager!.getLoadedValidationRevision(connection))).toBe(true)
    for (const observer of sourceObservers) observer.mock.calls.length = 0
    expect(await mutate('approve')).toMatchObject({ status: 409, error: { code: 'READ_PLAN_VALIDATION_REQUIRED' } })
    const validationId = (validated.data!.validation as { validationId: string }).validationId
    expect(await request('POST', `${basePath}/${version}/confirm-sample`, {
      managementScope: 'tenant', systemId: system, validationId,
    })).toMatchObject({ status: 200, data: { status: 'confirmed', validationId } })
    expect(await mutate('approve')).toMatchObject({ status: 200, data: { id: version, status: 'approved' } })
    for (const observer of sourceObservers) expect(observer.mock.calls).toHaveLength(0)
    expect((await fixturePool.query('SELECT status,updated_by FROM integration_stock_prep_read_plan_versions WHERE id=$1', [version])).rows)
      .toEqual([{ status: 'approved', updated_by: owner }])
  })

  it('activates the approved version with generation zero and persists the host transaction pointer', async () => {
    expect(await mutate('activate', 0)).toMatchObject({ status: 200, data: { versionId: version, status: 'active', generation: 1 } })
    expect((await fixturePool.query('SELECT version_id,generation,status FROM integration_stock_prep_read_plan_activation WHERE tenant_id=$1', [tenant])).rows)
      .toEqual([{ version_id: version, generation: 1, status: 'active' }])
    expect(await list()).toMatchObject({ status: 200, data: { activation: { versionId: version, generation: 1, status: 'active' } } })
  })

  it('rejects stale activation and deactivation generations without moving the pointer or audit', async () => {
    const before = await ledgerSnapshot()
    for (const operation of ['activate', 'deactivate']) {
      expect(await mutate(operation, 0)).toMatchObject({ status: 409, error: { code: 'READ_PLAN_GENERATION_CONFLICT' } })
      expect(await ledgerSnapshot()).toEqual(before)
    }
  })

  it('preflights the activated plan through the real host and binds every read to its measured connection revision', async () => {
    explicitValidationRead = true
    const before = await ledgerSnapshot()
    const result = await request('GET', '/api/integration/stock-preparation/source-preflight')
    expect(result).toMatchObject({ status: 200 })
    const calls = vi.mocked(facade.select).mock.calls
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every(call => call[0] === connection && call[3] === owner
      && call[5]?.expectedValidationRevision === manager!.getLoadedValidationRevision(connection))).toBe(true)
    expect(await ledgerSnapshot()).toEqual(before)
  })

  it('previews the activated synthetic BOM through actual host source, target and durable token storage', async () => {
    explicitValidationRead = true
    const ledgerBefore = await ledgerSnapshot()
    const businessBefore = await businessSnapshot()
    const storageBefore = (await fixturePool.query('SELECT to_jsonb(t) AS row FROM plugin_kv t ORDER BY plugin,key')).rows
    const result = await request('POST', `/api/integration/table-actions/${actionId}/dry-run`, {
      parameters: { projectNo: 'SYN-VALIDATION' },
    })
    expect(result).toMatchObject({ status: 200, ok: true, data: {
      status: 'ready', canApply: true, counts: { add: 2, update: 0, skip: 0, manual_confirm: 0 },
      dryRunToken: expect.any(String), revision: expect.any(String),
    } })
    expect(expansionObserver.mock.calls).toHaveLength(1)
    const expanded = await expansionObserver.mock.results[0].value
    expect(expanded).toMatchObject({ valid: true, status: 'expanded', errors: [], rowErrors: [] })
    // Fixed independent oracle: ordered ROOT quantity 2, CHILD per-parent 3 -> 6.
    expect(expanded.rows.map(row => [row.componentSourceId, row.parentSourceId, row.totalQuantity, row.sourceVersion]).sort())
      .toEqual([['CHILD', 'ROOT', 6, 'P1'], ['ROOT', null, 2, 'P1']])
    expect(expanded.rows.find(row => row.componentSourceId === 'ROOT')?.orderBomVersion).toBe('B2')
    const sourceCalls = vi.mocked(facade.select).mock.calls
    expect(sourceCalls.length).toBeGreaterThan(0)
    expect(sourceCalls.every(call => call[0] === connection && call[3] === owner
      && call[5]?.expectedValidationRevision === manager!.getLoadedValidationRevision(connection))).toBe(true)
    expect(new Set(sourceCalls.map(call => call[1]))).toEqual(new Set([
      'project_links', 'folders', 'sales_headers', 'sales_lines', 'parts', 'bom_headers', 'bom_lines',
    ].map(table => `${schema}.${table}`)))
    const targetReads = hostQueryObserver.mock.calls.filter(call =>
      typeof call[0] === 'string' && /SELECT\b.*FROM meta_records\b/s.test(call[0]))
    expect(targetReads.length).toBeGreaterThan(0)
    expect(targetReads.every(call => Array.isArray(call[1]) && call[1][0] === targetSheetId)).toBe(true)
    expect(transactionQueryObserver.mock.calls.map(observedSql).some(call =>
      call?.text.startsWith('SELECT id FROM meta_fields WHERE sheet_id = $1')
      && Array.isArray(call.values) && call.values[0] === targetSheetId)).toBe(true)
    expect(await ledgerSnapshot()).toEqual(ledgerBefore)
    expect(await businessSnapshot()).toEqual(businessBefore)
    // A preview is read-only for business rows, but a successful preview genuinely
    // issues one durable host token. Account for that write instead of claiming zero writes.
    const tokenKey = `integration:table-action:dry-run-token:${result.data!.dryRunToken}`
    const token = (await fixturePool.query('SELECT plugin,key,value FROM plugin_kv WHERE plugin=$1 AND key=$2',
      [pluginName, tokenKey])).rows
    expect(token).toEqual([{ plugin: pluginName, key: tokenKey, value: expect.objectContaining({
      actionId, revision: result.data!.revision,
      readPlanExecutionIdentity: expect.objectContaining({ versionId: version }),
    }) }])
    expect((await fixturePool.query('SELECT to_jsonb(t) AS row FROM plugin_kv t WHERE NOT (plugin=$1 AND key=$2) ORDER BY plugin,key',
      [pluginName, tokenKey])).rows).toEqual(storageBefore)
    expect((await fixturePool.query('SELECT count(*)::int AS total FROM plugin_kv')).rows)
      .toEqual([{ total: storageBefore.length + 1 }])
  })

  it('rejects an incomplete canonical target before facade source selects or target row reads', async () => {
    explicitValidationRead = true
    const ledgerBefore = await ledgerSnapshot()
    const businessBefore = await businessSnapshot()
    const storageBefore = (await fixturePool.query('SELECT to_jsonb(t) AS row FROM plugin_kv t ORDER BY plugin,key')).rows
    const missingField = targetDescriptor.fields.find(field => field.id === 'componentCode')!
    expect(missingField).toBeDefined()
    const fieldId = targetFieldIdMap[missingField.id]
    await fixturePool.query('DELETE FROM meta_fields WHERE id=$1 AND sheet_id=$2', [fieldId, targetSheetId])
    try {
      expect(await request('POST', `/api/integration/table-actions/${actionId}/dry-run`, {
        parameters: { projectNo: 'SYN-VALIDATION' },
      })).toMatchObject({ status: 422, error: { code: 'TARGET_SCHEMA_INCOMPLETE' } })
      expect(facade.select).not.toHaveBeenCalled()
      expect(sourceObservers[0].mock.calls).toHaveLength(0)
      expect(sourceObservers[1].mock.calls).toHaveLength(0)
      expect(expansionObserver.mock.calls).toHaveLength(0)
      expect(transactionQueryObserver.mock.calls.map(observedSql).some(call =>
        call?.text.startsWith('SELECT id FROM meta_fields WHERE sheet_id = $1')
        && Array.isArray(call.values) && call.values[0] === targetSheetId)).toBe(true)
      expect(hostQueryObserver.mock.calls.filter(call => typeof call[0] === 'string'
        && /SELECT\b.*FROM meta_records\b/s.test(call[0]))).toHaveLength(0)
      expect(await ledgerSnapshot()).toEqual(ledgerBefore)
      expect((await fixturePool.query('SELECT to_jsonb(t) AS row FROM plugin_kv t ORDER BY plugin,key')).rows).toEqual(storageBefore)
    } finally {
      await fixturePool.query('INSERT INTO meta_fields (id,sheet_id,name,type,property,"order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
        [fieldId, targetSheetId, missingField.name, missingField.type, JSON.stringify(missingField.property), missingField.order])
    }
    expect(await businessSnapshot()).toEqual(businessBefore)
  })

  it('refuses a same-tenant DB admin who does not own the Connection on reads and mutations', async () => {
    const before = await ledgerSnapshot()
    for (const reply of [await save(system, otherToken), await list(system, otherToken),
      await mutate('approve', undefined, otherToken), await mutate('retire', undefined, otherToken),
      await mutate('activate', 1, otherToken), await mutate('deactivate', 1, otherToken)]) {
      expect(reply).toMatchObject({ status: 403, error: { code: 'READ_PLAN_SOURCE_UNAVAILABLE' } })
    }
    expect(await ledgerSnapshot()).toEqual(before)
  })

  it('rejects cross-tenant systems and version handles despite real foreign-owner admin credentials', async () => {
    const before = await ledgerSnapshot()
    expect(await save(foreignSystem)).toMatchObject({ status: 403, error: { code: 'READ_PLAN_SOURCE_UNAVAILABLE' } })
    expect(await list(system, foreignToken)).toMatchObject({ status: 403, error: { code: 'READ_PLAN_SOURCE_UNAVAILABLE' } })
    expect(await mutate('approve', undefined, foreignToken)).toMatchObject({ status: 403, error: { code: 'READ_PLAN_SOURCE_UNAVAILABLE' } })
    // A valid foreign owner can manage its own source but still cannot load this tenant's
    // version handle. Reach version lookup rather than relying only on the source-owner gate.
    expect(await list(foreignSystem, foreignToken)).toMatchObject({ status: 200, data: { versions: [], activation: null } })
    vi.mocked(facade.resolveConnectionRegistration).mockClear()
    expect(await request('POST', `${basePath}/${version}/approve`,
      { managementScope: 'tenant', systemId: foreignSystem }, foreignToken))
      .toMatchObject({ status: 404, error: { code: 'READ_PLAN_NOT_FOUND' } })
    expect(facade.resolveConnectionRegistration).toHaveBeenCalledWith(foreignConnection,
      { principal: foreignOwner, tenantId: foreignTenant, workspaceId: null, runAs: 'user' })
    expect(await ledgerSnapshot()).toEqual(before)
  })

  it('does not promote a tenant header to verified identity after actual DB membership is revoked', async () => {
    const before = await ledgerSnapshot()
    await fixturePool.query('UPDATE user_orgs SET is_active=false WHERE user_id=$1', [owner])
    try {
      expect(await save(system, ownerToken, { 'x-tenant-id': tenant })).toMatchObject({ status: 403 })
      expect(await list(system, ownerToken, { 'x-tenant-id': tenant })).toMatchObject({ status: 403 })
      expect(await ledgerSnapshot()).toEqual(before)
    } finally { await fixturePool.query('UPDATE user_orgs SET is_active=true WHERE user_id=$1', [owner]) }
  })

  it('blocks absent, malformed, expired and DB-revoked sessions at the real host JWT mount', async () => {
    const before = await ledgerSnapshot()
    const jwt = await import('jsonwebtoken')
    const expired = jwt.sign({ userId: owner, tenantId: tenant }, process.env.JWT_SECRET!, { expiresIn: -1 })
    for (const token of ['', `invalid-${nonce}`, expired]) {
      expect(await save(system, token)).toMatchObject({ status: 401, error: { code: 'UNAUTHORIZED' } })
    }
    await fixturePool.query("INSERT INTO user_session_revocations VALUES ($1,now()+interval '1 hour',now(),$1,'synthetic revocation')", [owner])
    try {
      expect(await save()).toMatchObject({ status: 401, error: { code: 'UNAUTHORIZED' } })
      expect(await list()).toMatchObject({ status: 401, error: { code: 'UNAUTHORIZED' } })
      expect(await ledgerSnapshot()).toEqual(before)
    } finally { await fixturePool.query('DELETE FROM user_session_revocations WHERE user_id=$1', [owner]) }
  })

  it('rechecks current DB admin authority even when the real Connection owner keeps a valid signed token', async () => {
    const before = await ledgerSnapshot()
    const { invalidateUserPerms } = await import('../../src/rbac/service')
    await fixturePool.query('DELETE FROM user_roles WHERE user_id=$1', [owner])
    invalidateUserPerms(owner)
    try {
      expect(await save()).toMatchObject({ status: 403 })
      expect(await list()).toMatchObject({ status: 403 })
      expect(await ledgerSnapshot()).toEqual(before)
    } finally {
      await fixturePool.query("INSERT INTO user_roles VALUES ($1,'admin')", [owner])
      invalidateUserPerms(owner)
    }
  })

  it('rolls back a newly inserted version when a real PostgreSQL audit trigger rejects its host transaction', async () => {
    const before = await ledgerSnapshot()
    await fixturePool.query(`
      CREATE FUNCTION ${schema}.reject_synthetic_read_plan_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic audit refusal'; END $$;
      CREATE TRIGGER reject_synthetic_read_plan_audit BEFORE INSERT
        ON ${schema}.integration_stock_prep_read_plan_audit
        FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_synthetic_read_plan_audit();
    `)
    try {
      const distinctConfig = config()
      distinctConfig.readPlan.part.nameField = 'alternate_synthetic_name'
      expect(await request('POST', basePath, { managementScope: 'tenant', config: distinctConfig }))
        .toMatchObject({ status: 500, error: { code: 'READ_PLAN_MANAGEMENT_FAILED' } })
      expect(await ledgerSnapshot()).toEqual(before)
    } finally {
      await fixturePool.query(`DROP TRIGGER reject_synthetic_read_plan_audit ON ${schema}.integration_stock_prep_read_plan_audit`)
      await fixturePool.query(`DROP FUNCTION ${schema}.reject_synthetic_read_plan_audit()`)
    }
  })

  it('deactivates without deleting the generation fence and leaves a values-free durable audit', async () => {
    expect(await mutate('deactivate', 1)).toMatchObject({ status: 200, data: { generation: 2, status: 'disabled' } })
    expect(await list()).toMatchObject({ status: 200, data: { activation: { versionId: version, generation: 2, status: 'disabled' } } })
    const audit = await fixturePool.query('SELECT action,actor,detail FROM integration_stock_prep_read_plan_audit WHERE version_id=$1 ORDER BY action', [version])
    expect(audit.rows.map(row => row.action)).toEqual(['activate', 'deactivate', 'save_version', 'status_change',
      'validation_begin', 'validation_confirm', 'validation_finish'])
    expect(audit.rows.every(row => row.actor === owner)).toBe(true)
    expect(JSON.stringify(audit.rows)).not.toMatch(/password|credentials|authorityCode|appKey|Bearer|postgres(?:ql)?:\/\//i)
  })

  it('manages immutable versions from the real browser panel through the actual host and database', async () => {
    explicitValidationRead = true
    const { runStockPreparationReadPlanBrowserAcceptance } = await import('../utils/stock-preparation-read-plan-browser-acceptance')
    // Sign the UI snapshot from current DB-refreshed users, never from fabricated local roles.
    // Backend JWT validation still refreshes authority on each request.
    const currentOwner = await authService.verifyToken(ownerToken)
    const currentOther = await authService.verifyToken(otherToken)
    if (!currentOwner || !currentOther) throw new Error('SA02M_SYNTHETIC_USERS_UNAVAILABLE')
    expect(currentOwner.role).toBe('admin')
    expect(currentOther.role).toBe('admin')
    const browserConfig = config()
    browserConfig.readPlan.part.nameField = 'browser_synthetic_name'
    // Source data and target metadata stay fixed. The first preview has an empty
    // target: only the activated plan changes baseline add=2 to add=3. The later
    // populated-target phase inserts and removes its own explicit fixture rows.
    browserConfig.readPlan.bomDetail.object = `${schema}.bom_lines_alternate`
    const businessBefore = await businessSnapshot()
    const storageBefore = (await fixturePool.query('SELECT to_jsonb(t) AS row FROM plugin_kv t ORDER BY plugin,key')).rows
    const artifactDir = fileURLToPath(new URL(`../../../../artifacts/reviews/sa02m-browser-${nonce}/`, import.meta.url))
    const cacheDir = fileURLToPath(new URL(`../../../../tmp/sa02m-browser-${nonce}/`, import.meta.url))
    await mkdir(artifactDir, { recursive: true })
    await mkdir(cacheDir, { recursive: true })
    const result = await runStockPreparationReadPlanBrowserAcceptance({
      apiOrigin: origin, tenantId: tenant, systemId: system,
      ownerToken: authService.createToken(currentOwner), otherToken: authService.createToken(currentOther),
      readPlan: browserConfig.readPlan, artifactDir, cacheDir,
      preparePopulatedTarget: async (activeVersionId) => {
        // Independent fixed contract values, never copied from expansion/planner
        // output. ROOT is exact, CHILD differs ONLY in totalQuantity (5 vs 6),
        // EXTRA is absent, and an obsolete same-project active row must be inactive.
        const fixtureRows = [
          { id: `sa02q-populated-root-${nonce}`, version: 7, data: {
            projectNo: 'SYN-VALIDATION',
            idempotencyKey: '{"projectNo":"SYN-VALIDATION","componentSourceId":"ROOT","parentSourceId":null,"path":["ROOT"]}',
            componentSourceId: 'ROOT', parentSourceId: null, path: '["ROOT"]', depth: 0,
            componentCode: 'SYN-ROOT', componentName: 'Synthetic', componentSpec: 'browser assembly',
            material: 'Steel', sourceVersion: 'P1', rawQuantity: 2, totalQuantity: 2, active: true,
            notes: 'Synthetic preserved root note',
          } },
          { id: `sa02q-populated-child-${nonce}`, version: 11, data: {
            projectNo: 'SYN-VALIDATION',
            idempotencyKey: '{"projectNo":"SYN-VALIDATION","componentSourceId":"CHILD","parentSourceId":"ROOT","path":["ROOT","CHILD"]}',
            componentSourceId: 'CHILD', parentSourceId: 'ROOT', path: '["ROOT","CHILD"]', depth: 1,
            componentCode: 'SYN-CHILD', componentName: 'Synthetic', componentSpec: 'browser part',
            parentComponentCode: 'SYN-ROOT', parentComponentName: 'Synthetic browser assembly',
            material: 'Steel', sourceVersion: 'P1', rawQuantity: 3, totalQuantity: 5, active: true,
            notes: 'Synthetic preserved child note',
          } },
          { id: `sa02q-populated-obsolete-${nonce}`, version: 13, data: {
            projectNo: 'SYN-VALIDATION',
            idempotencyKey: '{"projectNo":"SYN-VALIDATION","componentSourceId":"OBSOLETE","parentSourceId":null,"path":["OBSOLETE"]}',
            componentSourceId: 'OBSOLETE', parentSourceId: null, path: '["OBSOLETE"]', depth: 0,
            componentCode: 'SYN-OBSOLETE', componentName: 'Synthetic', componentSpec: 'obsolete part',
            material: 'Steel', sourceVersion: 'P1', rawQuantity: 1, totalQuantity: 1, active: true,
            notes: 'Synthetic preserved obsolete note',
          } },
        ]
        const recordIds = fixtureRows.map(row => row.id)
        const cleanup = async () => {
          await fixturePool.query('DELETE FROM meta_records WHERE sheet_id=$1 AND id=ANY($2::text[])', [targetSheetId, recordIds])
        }
        const storageBeforePopulated = (await fixturePool.query('SELECT to_jsonb(t) AS row FROM plugin_kv t ORDER BY plugin,key')).rows
        try {
          for (const row of fixtureRows) {
            const physicalData = Object.fromEntries(Object.entries(row.data).map(([field, value]) => {
              expect(targetFieldIdMap[field]).toBeDefined()
              return [targetFieldIdMap[field], value]
            }))
            await fixturePool.query('INSERT INTO meta_records (id,sheet_id,version,data) VALUES ($1,$2,$3,$4::jsonb)',
              [row.id, targetSheetId, row.version, JSON.stringify(physicalData)])
          }
          const recordsBefore = (await fixturePool.query('SELECT id,version,data FROM meta_records WHERE sheet_id=$1 ORDER BY id', [targetSheetId])).rows
          expect(recordsBefore).toHaveLength(3)
          expect(recordsBefore.map(row => row.version).sort((a, b) => a - b)).toEqual([7, 11, 13])
          expect(recordsBefore.every(row => !(Object.hasOwn(row.data, 'projectNo')) && Object.hasOwn(row.data, targetFieldIdMap.projectNo))).toBe(true)
          const populatedBusinessBefore = await businessSnapshot()
          return {
            assertUnchanged: async (token: string) => {
              expect((await fixturePool.query('SELECT id,version,data FROM meta_records WHERE sheet_id=$1 ORDER BY id', [targetSheetId])).rows)
                .toEqual(recordsBefore)
              expect(await businessSnapshot()).toEqual(populatedBusinessBefore)
              const key = `integration:table-action:dry-run-token:${token}`
              expect((await fixturePool.query('SELECT plugin,key,value FROM plugin_kv WHERE plugin=$1 AND key=$2', [pluginName, key])).rows)
                .toEqual([{ plugin: pluginName, key, value: expect.objectContaining({ actionId,
                  readPlanExecutionIdentity: expect.objectContaining({ versionId: activeVersionId }),
                }) }])
              expect((await fixturePool.query('SELECT to_jsonb(t) AS row FROM plugin_kv t WHERE NOT (plugin=$1 AND key=$2) ORDER BY plugin,key',
                [pluginName, key])).rows).toEqual(storageBeforePopulated)
              expect((await fixturePool.query('SELECT count(*)::int AS total FROM plugin_kv')).rows)
                .toEqual([{ total: storageBeforePopulated.length + 1 }])
            },
            cleanup,
          }
        } catch (error) {
          await cleanup()
          throw error
        }
      },
    })
    expect(result.createdVersionId).not.toBe(version)
    portableReviewJson = result.portableReviewJson
    expect(result.counts.businessPreviewPosts).toBe(2)
    expect(result.evidence.previewDidNotSync).toBe(true)
    expect(result.preview.plannedAdd).toBe(3)
    expect(result.populatedPreview.counts).toEqual({ add: 1, update: 1, skip: 1, inactive: 1, manual_confirm: 0 })
    expect(result.evidence.populatedTargetPreviewDidNotWrite).toBe(true)
    expect(await businessSnapshot()).toEqual(businessBefore)
    const previewTokenKey = `integration:table-action:dry-run-token:${result.preview.token}`
    expect((await fixturePool.query('SELECT plugin,key,value FROM plugin_kv WHERE plugin=$1 AND key=$2', [pluginName, previewTokenKey])).rows)
      .toEqual([{ plugin: pluginName, key: previewTokenKey, value: expect.objectContaining({
        actionId, readPlanExecutionIdentity: expect.objectContaining({ versionId: result.createdVersionId }),
      }) }])
    const populatedPreviewTokenKey = `integration:table-action:dry-run-token:${result.populatedPreview.token}`
    expect((await fixturePool.query('SELECT plugin,key,value FROM plugin_kv WHERE plugin=$1 AND key=$2', [pluginName, populatedPreviewTokenKey])).rows)
      .toEqual([{ plugin: pluginName, key: populatedPreviewTokenKey, value: expect.objectContaining({
        actionId, readPlanExecutionIdentity: expect.objectContaining({ versionId: result.createdVersionId }),
      }) }])
    expect((await fixturePool.query('SELECT to_jsonb(t) AS row FROM plugin_kv t WHERE NOT (plugin=$1 AND key=ANY($2::text[])) ORDER BY plugin,key',
      [pluginName, [previewTokenKey, populatedPreviewTokenKey]])).rows).toEqual(storageBefore)
    expect((await fixturePool.query('SELECT count(*)::int AS total FROM plugin_kv')).rows)
      .toEqual([{ total: storageBefore.length + 2 }])
    expect((await fixturePool.query(`SELECT v.status,v.created_by,v.config,v.content_key,a.version_id,a.generation,a.status AS activation_status
      FROM integration_stock_prep_read_plan_versions v JOIN integration_stock_prep_read_plan_activation a ON a.version_id=v.id
      WHERE v.id=$1`, [result.createdVersionId])).rows).toEqual([{
      status: 'approved', created_by: owner, version_id: result.createdVersionId, generation: 4, activation_status: 'disabled',
      config: browserConfig, content_key: result.createdContentKey,
    }])
    expect((await fixturePool.query('SELECT count(*)::int AS total FROM integration_stock_prep_read_plan_versions')).rows)
      .toEqual([{ total: 2 }])
    expect((await fixturePool.query('SELECT action FROM integration_stock_prep_read_plan_audit WHERE version_id=$1 ORDER BY action', [result.createdVersionId])).rows)
      .toEqual(['activate', 'deactivate', 'save_version', 'status_change',
        'validation_begin', 'validation_confirm', 'validation_finish'].map(action => ({ action })))
    process.stdout.write(`SA02M_BROWSER_ACCEPTANCE ${JSON.stringify({ counts: result.counts, evidence: result.evidence })}\n`)
  }, 90000)

  it('database triggers rotate opaque source/binding nonces on material edits and ABA, not health checks or caller assigned revisions', async () => {
    const revisionOf = async (table: 'data_sources' | 'integration_external_systems', id: string) =>
      String((await fixturePool.query(`SELECT validation_revision FROM ${table} WHERE id=$1`, [id])).rows[0].validation_revision)
    const sourceRevision = await revisionOf('data_sources', foreignConnection)
    await fixturePool.query("UPDATE data_sources SET status='error',updated_at=now(),validation_revision=$2 WHERE id=$1", [foreignConnection, randomUUID()])
    expect(await revisionOf('data_sources', foreignConnection)).toBe(sourceRevision)
    const before = (await fixturePool.query('SELECT config FROM data_sources WHERE id=$1', [foreignConnection])).rows[0].config
    await fixturePool.query("UPDATE data_sources SET config=config || '{\"syntheticRevisionProbe\":1}'::jsonb WHERE id=$1", [foreignConnection])
    const changed = await revisionOf('data_sources', foreignConnection)
    expect(changed).not.toBe(sourceRevision)
    await fixturePool.query('UPDATE data_sources SET config=$2::jsonb,validation_revision=$3 WHERE id=$1', [foreignConnection, JSON.stringify(before), sourceRevision])
    const restored = await revisionOf('data_sources', foreignConnection)
    expect(restored).not.toBe(sourceRevision); expect(restored).not.toBe(changed)
    expect((await fixturePool.query('SELECT validation_revision FROM integration_data_source_validation_revisions WHERE data_source_id=$1', [foreignConnection])).rows[0].validation_revision).toBe(restored)
    const bindingRevision = await revisionOf('integration_external_systems', foreignSystem)
    await fixturePool.query('UPDATE integration_external_systems SET last_tested_at=now(),validation_revision=$2 WHERE id=$1', [foreignSystem, randomUUID()])
    expect(await revisionOf('integration_external_systems', foreignSystem)).toBe(bindingRevision)
    await fixturePool.query("UPDATE integration_external_systems SET status='inactive' WHERE id=$1", [foreignSystem])
    await fixturePool.query("UPDATE integration_external_systems SET status='active',validation_revision=$2 WHERE id=$1", [foreignSystem, bindingRevision])
    expect(await revisionOf('integration_external_systems', foreignSystem)).not.toBe(bindingRevision)
    const recreatedId = `synthetic-recreated-${nonce}`
    const create = () => fixturePool.query(`INSERT INTO data_sources (id,name,type,config,owner_id,tenant_id,scope_kind,auto_connect,validation_revision)
      SELECT $1,$1,type,config,owner_id,tenant_id,'private',false,$3::uuid FROM data_sources WHERE id=$2`, [recreatedId, foreignConnection, sourceRevision])
    await create()
    const first = await revisionOf('data_sources', recreatedId)
    expect(first).not.toBe(sourceRevision)
    await fixturePool.query('DELETE FROM data_sources WHERE id=$1', [recreatedId])
    expect((await fixturePool.query('SELECT is_active,deleted_at FROM integration_data_source_validation_revisions WHERE data_source_id=$1', [recreatedId])).rows[0])
      .toMatchObject({ is_active: false, deleted_at: expect.any(Date) })
    await create()
    expect(await revisionOf('data_sources', recreatedId)).not.toBe(first)
  })

  it('concurrent source edit blocks the actual activation transaction, then refuses old proof after commit and after restoring values', async () => {
    const before = await ledgerSnapshot()
    const sourceBefore = (await fixturePool.query('SELECT config,validation_revision FROM data_sources WHERE id=$1', [connection])).rows[0]
    const writer = await fixturePool.connect()
    let pending: Promise<Reply> | undefined
    try {
      await writer.query('BEGIN')
      await writer.query("UPDATE data_sources SET config=config || '{\"syntheticConcurrentRevisionProbe\":1}'::jsonb WHERE id=$1", [connection])
      pending = mutate('activate', 4)
      // Attach rejection immediately so teardown cannot leave a request orphan.
      void pending.catch(() => {})
      const until = Date.now() + 5000
      let blocked = false
      while (Date.now() < until) {
        const result = await fixturePool.query(`SELECT count(*)::int AS total FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock'
            AND query LIKE '%integration_data_source_validation_revisions%'`)
        if (result.rows[0].total > 0) { blocked = true; break }
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(blocked).toBe(true)
      await writer.query('COMMIT')
      expect(await pending).toMatchObject({ status: 409, error: { code: 'READ_PLAN_VALIDATION_SOURCE_CHANGED' } })
      expect(await ledgerSnapshot()).toEqual(before)
      await fixturePool.query('UPDATE data_sources SET config=$2::jsonb,validation_revision=$3 WHERE id=$1', [connection, JSON.stringify(sourceBefore.config), sourceBefore.validation_revision])
      expect(await mutate('activate', 4)).toMatchObject({ status: 409, error: { code: 'READ_PLAN_VALIDATION_SOURCE_CHANGED' } })
      expect(await ledgerSnapshot()).toEqual(before)
    } finally {
      await writer.query('ROLLBACK')
      writer.release()
      if (pending) await pending
    }
  }, 10000)

  it('refuses to disclose another owner action pointer even when the requested source belongs to the caller', async () => {
    const privateConnection = `sa02q-private-${nonce}`
    const privateSystem = `sa02q-private-system-${nonce}`
    const parsed = new URL(process.env.DATABASE_URL!)
    await manager!.addDataSource({ id: privateConnection, name: 'Synthetic isolated owner source', type: 'postgresql',
      connection: { host: parsed.hostname, port: Number(parsed.port), database: parsed.pathname.slice(1) },
      credentials: { username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) },
      options: { readOnly: true, autoConnect: false }, poolConfig: { min: 0, max: 1, idleTimeout: 1000 },
    }, { ownerId: otherAdmin, tenantId: tenant, scopeKind: 'private', persist: true })
    await fixturePool.query(`INSERT INTO integration_external_systems
      (id,tenant_id,name,kind,role,status,connection_id,config)
      VALUES ($1,$2,$1,'data-source:sql-readonly','source','active',$3,$4::jsonb)`,
    [privateSystem, tenant, privateConnection, JSON.stringify({ dataSourceOwnerId: otherAdmin })])
    expect(await facade.resolveConnectionRegistration(privateConnection,
      { principal: otherAdmin, tenantId: tenant, workspaceId: null, runAs: 'user' })).toMatchObject({ id: privateConnection })
    const before = await ledgerSnapshot()
    expect(await list(privateSystem, otherToken)).toMatchObject({ status: 403, error: { code: 'READ_PLAN_SOURCE_UNAVAILABLE' } })
    expect(await ledgerSnapshot()).toEqual(before)
  })

  it('metadata writes wait on a concurrent binding rebind and reject the former owner after commit', async () => {
    const privateConnection = `sa02q-private-${nonce}`
    const bindingBefore = (await fixturePool.query('SELECT connection_id,config FROM integration_external_systems WHERE id=$1', [system])).rows[0]
    const versionConfig = (await fixturePool.query('SELECT config FROM integration_stock_prep_read_plan_versions WHERE id=$1', [version])).rows[0].config
    for (const operation of ['save-new', 'save-reuse', 'retire', 'deactivate']) {
      const before = await ledgerSnapshot()
      const writer = await fixturePool.connect()
      let pending: Promise<Reply> | undefined
      try {
        await writer.query('BEGIN')
        await writer.query('UPDATE integration_external_systems SET connection_id=$2 WHERE id=$1', [system, privateConnection])
        const changedConfig = structuredClone(versionConfig)
        changedConfig.readPlan.maxReadCount -= 1
        pending = operation.startsWith('save')
          ? request('POST', basePath, { managementScope: 'tenant', config: operation === 'save-new' ? changedConfig : versionConfig })
          : mutate(operation, operation === 'deactivate' ? 4 : undefined)
        void pending.catch(() => {})
        // The unlocked request precheck sees the committed A-owned binding. The
        // actual metadata transaction must wait on EXT before touching the ledger.
        const until = Date.now() + 5000
        let blocked = false
        while (Date.now() < until) {
          const result = await fixturePool.query(`SELECT count(*)::int AS total FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event_type='Lock'
              AND query LIKE '%integration_external_systems%' AND query ILIKE '%FOR UPDATE%'`)
          if (result.rows[0].total > 0) { blocked = true; break }
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        expect(blocked, operation).toBe(true)
        await writer.query('COMMIT')
        expect(await pending, operation).toMatchObject({ status: 409, error: { code: 'READ_PLAN_SOURCE_INELIGIBLE' } })
        expect(await ledgerSnapshot()).toEqual(before)
      } finally {
        await writer.query('ROLLBACK')
        writer.release()
        if (pending) await pending
        await fixturePool.query('UPDATE integration_external_systems SET connection_id=$2,config=$3::jsonb WHERE id=$1',
          [system, bindingBefore.connection_id, JSON.stringify(bindingBefore.config)])
      }
    }
  }, 30000)

  it('production externalSystemsUpsert rebind revokes an already admitted metadata request without creator privilege', async () => {
    const privateConnection = `sa02q-private-${nonce}`
    const before = await ledgerSnapshot()
    const bindingBefore = (await fixturePool.query('SELECT connection_id,config,validation_revision FROM integration_external_systems WHERE id=$1', [system])).rows[0]
    const registration = vi.mocked(facade.resolveConnectionRegistration)
    expect(typeof resolveRegistration).toBe('function')
    let admitted!: () => void
    const precheck = new Promise<void>(resolve => { admitted = resolve })
    let resume!: () => void
    const paused = new Promise<void>(resolve => { resume = resolve })
    registration.mockImplementation(async (id, options) => {
      const result = await resolveRegistration(id, options)
      if (id === connection && options.principal === owner) { admitted(); await paused }
      return result
    })
    let pending: Promise<Reply> | undefined
    try {
      pending = mutate('retire')
      void pending.catch(() => {})
      let deadline: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([precheck, new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error('metadata owner precheck did not reach the production facade')), 5000)
        })])
      } finally { if (deadline) clearTimeout(deadline) }
      const rebound = await request('POST', '/api/integration/external-systems', {
        id: system, name: 'Synthetic concurrent owner rebind', kind: 'data-source:sql-readonly',
        role: 'source', status: 'active', connectionId: privateConnection,
      }, otherToken)
      expect(rebound).toMatchObject({ status: 201, ok: true })
      const binding = (await fixturePool.query('SELECT connection_id,validation_revision FROM integration_external_systems WHERE id=$1', [system])).rows[0]
      expect(binding.connection_id).toBe(privateConnection)
      expect(binding.validation_revision).not.toBe(bindingBefore.validation_revision)
      resume()
      expect(await pending).toMatchObject({ status: 409, error: { code: 'READ_PLAN_SOURCE_INELIGIBLE' } })
      expect(await ledgerSnapshot()).toEqual(before)
    } finally {
      resume()
      registration.mockImplementation(resolveRegistration)
      if (pending) await pending
      await fixturePool.query('UPDATE integration_external_systems SET connection_id=$2,config=$3::jsonb WHERE id=$1',
        [system, bindingBefore.connection_id, JSON.stringify(bindingBefore.config)])
    }
  }, 15000)

  it('reuses the first browser download in an independent second deployment with a new owner and physical field layout', async () => {
    explicitValidationRead = true
    expect(portableReviewJson).not.toBe('')
    const secondConnection = `sa02q-connection-${nonce}`
    const secondSystem = `sa02q-system-${nonce}`
    // This is a sequential second deployment, not a fabricated tenant router:
    // a real lifecycle reactivation reads the new deploy-global target below.
    await fixturePool.query(`
      CREATE TABLE ${schema}.reuse_links (project_ref text, flow_ref text);
      CREATE TABLE ${schema}.reuse_nodes (flow_key text);
      CREATE TABLE ${schema}.reuse_orders (head_ref text, flow_ref text);
      CREATE TABLE ${schema}.reuse_order_rows (order_ref text, part_ref text, units numeric, ordinal integer, wanted_bom text);
      CREATE TABLE ${schema}.reuse_parts (part_key text, item_number text, label text, substance text, part_revision text);
      CREATE TABLE ${schema}.reuse_boms (parent_ref text, bom_key text, bom_revision text, enabled boolean);
      CREATE TABLE ${schema}.reuse_children (bom_ref text, child_ref text, units numeric, ordinal integer);
      INSERT INTO ${schema}.reuse_links VALUES ('SYN-REUSE','REUSE-PATH');
      INSERT INTO ${schema}.reuse_nodes VALUES ('REUSE-PATH');
      INSERT INTO ${schema}.reuse_orders VALUES ('REUSE-ORDER','REUSE-PATH');
      INSERT INTO ${schema}.reuse_order_rows VALUES ('REUSE-ORDER','REUSE-ROOT',4,1,'B7');
      INSERT INTO ${schema}.reuse_parts VALUES ('REUSE-ROOT','SYN-REUSE-ROOT','Synthetic reuse root','Steel','P9'),
        ('REUSE-CHILD','SYN-REUSE-CHILD','Synthetic reuse child','Steel','P3');
      INSERT INTO ${schema}.reuse_boms VALUES ('REUSE-ROOT','REUSE-BOM','B7',true);
      INSERT INTO ${schema}.reuse_children VALUES ('REUSE-BOM','REUSE-CHILD',5,1);
    `)
    const roles = {
      pathExAttr: { object: `${schema}.reuse_links`, matchField: 'project_ref', pathIdField: 'flow_ref' },
      pathInfo: { object: `${schema}.reuse_nodes`, idField: 'flow_key' },
      orderHead: { object: `${schema}.reuse_orders`, idField: 'head_ref', pathIdField: 'flow_ref' },
      orderDetail: { object: `${schema}.reuse_order_rows`, orderIdField: 'order_ref', componentIdField: 'part_ref', quantityField: 'units', sortField: 'ordinal', versionField: 'wanted_bom' },
      part: { object: `${schema}.reuse_parts`, idField: 'part_key', codeField: 'item_number', nameField: 'label', materialField: 'substance', versionField: 'part_revision' },
      bomHead: { object: `${schema}.reuse_boms`, parentPartField: 'parent_ref', bomIdField: 'bom_key', versionField: 'bom_revision', activeField: 'enabled' },
      bomDetail: { object: `${schema}.reuse_children`, bomParentField: 'bom_ref', componentIdField: 'child_ref', quantityField: 'units', sortField: 'ordinal' },
    }
    const draft = createEmptySourcePlanDraft()
    for (const role of Object.keys(roles) as Array<keyof typeof roles>) Object.assign(draft.roles[role], roles[role])
    const compiled = compileSourcePlanDraft(draft)
    expect(compiled.ok).toBe(true)
    const parsed = new URL(process.env.DATABASE_URL!)
    await manager!.addDataSource({ id: secondConnection, name: 'Synthetic second owner source', type: 'postgresql',
      connection: { host: parsed.hostname, port: Number(parsed.port), database: parsed.pathname.slice(1) },
      credentials: { username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) },
      options: { readOnly: true, autoConnect: false }, poolConfig: { min: 0, max: 1, idleTimeout: 1000 },
    }, { ownerId: foreignOwner, tenantId: foreignTenant, scopeKind: 'private', persist: true })
    await fixturePool.query(`INSERT INTO integration_external_systems
      (id,tenant_id,name,kind,role,status,connection_id,config)
      VALUES ($1,$2,$1,'data-source:sql-readonly','source','active',$3,$4::jsonb)`,
    [secondSystem, foreignTenant, secondConnection, JSON.stringify({ dataSourceOwnerId: foreignOwner })])
    const secondProject = `${foreignTenant}:integration-core`
    const secondSheet = getObjectSheetId(secondProject, targetDescriptor.id)
    const secondFields = Object.fromEntries(targetDescriptor.fields.map(field =>
      [field.id, getObjectFieldId(secondProject, targetDescriptor.id, field.id)]))
    await fixturePool.query('INSERT INTO meta_sheets (id,base_id,name,description) VALUES ($1,$2,$3,$4)',
      [secondSheet, secondProject, targetDescriptor.name, targetDescriptor.description])
    for (const field of targetDescriptor.fields) {
      await fixturePool.query('INSERT INTO meta_fields (id,sheet_id,name,type,property,"order") VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
        [secondFields[field.id], secondSheet, field.name, field.type, JSON.stringify(field.property), field.order])
    }
    await fixturePool.query('INSERT INTO plugin_multitable_object_registry (sheet_id,project_id,object_id,plugin_name) VALUES ($1,$2,$3,$4)',
      [secondSheet, secondProject, targetDescriptor.id, pluginName])
    expect(await seam.deactivatePluginByName(pluginName)).toMatchObject({ status: 'inactive' })
    setEnv('INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON', JSON.stringify([{
      actionId, source: { kind: 'data-source:sql-readonly', externalSystemId: secondSystem },
      target: { sheetId: secondSheet, objectId: targetDescriptor.id, fieldIdMap: secondFields }, rootSelection: { enabled: false },
    }]))
    const reactivation = vi.spyOn(seam, 'createPluginContext')
    expect(await seam.activatePluginByName(pluginName)).toMatchObject({ status: 'active' })
    expect(reactivation).toHaveBeenCalledTimes(1)
    facade = reactivation.mock.results[0].value.api.dataSources!
    reactivation.mockRestore()
    observers.push(vi.spyOn(facade, 'select'))
    const bindingPath = `/api/integration/stock-preparation/source-binding?tenantId=${foreignTenant}`
    expect(await request('POST', bindingPath, { externalSystemId: secondSystem }, foreignToken)).toMatchObject({ status: 200, ok: true })
    expect(await list(secondSystem, ownerToken)).toMatchObject({ status: 403 })
    const snapshot = async () => ({ business: await businessSnapshot(), sources: await Promise.all(Object.values(roles).map(async role =>
      (await fixturePool.query(`SELECT to_jsonb(t) AS row FROM ${role.object} t ORDER BY to_jsonb(t)::text`)).rows)) })
    const before = await snapshot()
    const tokenCount = (await fixturePool.query('SELECT count(*)::int AS n FROM plugin_kv')).rows[0].n
    const existingVersions = (await fixturePool.query('SELECT to_jsonb(t) AS row FROM integration_stock_prep_read_plan_versions t ORDER BY id')).rows
    const { runStockPreparationReadPlanReuseAcceptance } = await import('../utils/stock-preparation-read-plan-browser-acceptance')
    const originalActivation = (await fixturePool.query('SELECT to_jsonb(t) AS row FROM integration_stock_prep_read_plan_activation t WHERE tenant_id=$1 ORDER BY id', [tenant])).rows
    const currentOwner = await authService.verifyToken(foreignToken)
    if (!currentOwner) throw new Error('SA02Q_SECOND_USER_UNAVAILABLE')
    const result = await runStockPreparationReadPlanReuseAcceptance({ apiOrigin: origin, tenantId: foreignTenant, systemId: secondSystem,
      ownerToken: authService.createToken(currentOwner), portableReviewJson, readPlan: compiled.envelope!.readPlan,
      cacheDir: fileURLToPath(new URL(`../../../../tmp/sa02q-reuse-${nonce}/`, import.meta.url)),
      artifactDir: fileURLToPath(new URL(`../../../../artifacts/reviews/sa02q-reuse-${nonce}/`, import.meta.url)),
    })
    expect(await snapshot()).toEqual(before)
    expect(result.posts).toBe(6)
    expect(result.generation).toBe(1)
    expect((await fixturePool.query(`SELECT version_id,system_id,generation,status,validation_id
      FROM integration_stock_prep_read_plan_activation WHERE tenant_id=$1 AND workspace_id IS NULL AND action_id=$2`,
    [foreignTenant, actionId])).rows).toEqual([{ version_id: result.versionId, system_id: secondSystem,
      generation: 1, status: 'active', validation_id: result.validationId }])
    expect((await fixturePool.query(`SELECT status,actor,connection_id FROM integration_stock_prep_read_plan_validations WHERE id=$1`,
      [result.validationId])).rows).toEqual([{ status: 'confirmed', actor: foreignOwner, connection_id: secondConnection }])
    expect((await fixturePool.query('SELECT to_jsonb(t) AS row FROM integration_stock_prep_read_plan_versions t WHERE id<>$1 ORDER BY id',
      [result.versionId])).rows).toEqual(existingVersions)
    expect((await fixturePool.query('SELECT status,system_id,created_by,validation_id FROM integration_stock_prep_read_plan_versions WHERE id=$1',
      [result.versionId])).rows).toEqual([{ status: 'approved', system_id: secondSystem, created_by: foreignOwner, validation_id: result.validationId }])
    expect((await fixturePool.query('SELECT to_jsonb(t) AS row FROM integration_stock_prep_read_plan_activation t WHERE tenant_id=$1 ORDER BY id', [tenant])).rows).toEqual(originalActivation)
    expect((await fixturePool.query('SELECT count(*)::int AS n FROM plugin_kv')).rows[0].n).toBe(tokenCount + 1)
    expect((await fixturePool.query('SELECT value FROM plugin_kv WHERE plugin=$1 AND key=$2',
      [pluginName, `integration:table-action:dry-run-token:${result.token}`])).rows[0].value)
      .toMatchObject({ actionId, readPlanExecutionIdentity: { versionId: result.versionId, systemId: secondSystem } })
    expect(vi.mocked(facade.select).mock.calls.every(call => call[3] === foreignOwner
      && call[0] === secondConnection)).toBe(true)
    expect(vi.mocked(facade.select).mock.calls.length).toBeGreaterThan(0)
    const targetReads = hostQueryObserver.mock.calls.filter(call =>
      typeof call[0] === 'string' && /SELECT\b.*FROM meta_records\b/s.test(call[0]))
    expect(targetReads.length).toBeGreaterThan(0)
    expect(targetReads.every(call => Array.isArray(call[1]) && call[1][0] === secondSheet)).toBe(true)
    expect(transactionQueryObserver.mock.calls.map(observedSql).some(call =>
      call?.text.startsWith('SELECT id FROM meta_fields WHERE sheet_id = $1')
      && Array.isArray(call.values) && call.values[0] === secondSheet)).toBe(true)
    process.stdout.write('SA02Q_SECOND_OWNER_REUSE source/target unchanged; fresh owner-bound receipt and activated version; one durable preview token; no apply\n')
  }, 90000)
})
