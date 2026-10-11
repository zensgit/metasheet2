import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { SourcePlanReadPlan } from '../../../../apps/web/src/services/integration/stockPreparation/sourcePlanDraft'
import { verifyRequiredMainMigrationCatalog } from './stock-preparation-main-migration-contract.ts'

type Query = (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
type ReadPlan = SourcePlanReadPlan

/** Structural contract for the real compiled manager, never a replacement implementation. */
export interface ConfiguredDataSourceManager {
  initialized?: boolean
  db?: unknown
  getScope(id: string): unknown
  getLoadedValidationRevision(id: string): unknown
  getLoadState(id: string): string
  listDataSources(): unknown[]
  dispose(): Promise<void>
}
export interface ConfiguredDataSourceRoutes {
  getDataSourceManager(): ConfiguredDataSourceManager
  dataSourceManager: ConfiguredDataSourceManager | null
}
/** The parent verifies the complete build receipt before and after execution.
 * Only modules inside its marked scratch directory may be loaded here.
 */
export function configuredCoreModulePath(root: string, relative: string): string {
  assert(/^[A-Za-z0-9_/-]+\.ts$/.test(relative) && !relative.split('/').includes('..'),
    'APP_CONFIGURED_CORE_MODULE_PATH_INVALID')
  const scratch = process.env.PLM_FULL_APP_SCRATCH
  const compiledRoot = process.env.PLM_FULL_APP_CORE_ROOT
  assert(scratch && compiledRoot, 'APP_CONFIGURED_COMPILED_ROOT_REQUIRED')
  const scratchRelative = path.relative(root, scratch).replaceAll('\\', '/')
  const matched = scratchRelative.match(/^tmp\/stock-preparation-plm-full-app-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/)
  assert(matched, 'APP_CONFIGURED_COMPILED_ROOT_INVALID')
  assert.equal(compiledRoot, path.join(scratch, 'build/backend/dist'), 'APP_CONFIGURED_COMPILED_ROOT_INVALID')
  for (const entry of [root, scratch, compiledRoot, path.join(scratch, 'owner.json')]) {
    assert.equal(path.relative(realpathSync(entry), entry), '', 'APP_CONFIGURED_COMPILED_PATH_REDIRECTED')
  }
  const marker = JSON.parse(readFileSync(path.join(scratch, 'owner.json'), 'utf8')) as Record<string, unknown>
  assert.deepEqual(Object.keys(marker).sort(), ['nonce', 'owner', 'pid', 'repoRoot'])
  assert.equal(marker.owner, 'PLM_FULL_APP_SCRATCH', 'APP_CONFIGURED_SCRATCH_MARKER_INVALID')
  assert.equal(marker.nonce, matched[1], 'APP_CONFIGURED_SCRATCH_MARKER_INVALID')
  assert.equal(marker.repoRoot, realpathSync(root), 'APP_CONFIGURED_SCRATCH_MARKER_INVALID')
  assert(Number.isSafeInteger(marker.pid) && Number(marker.pid) > 0, 'APP_CONFIGURED_SCRATCH_MARKER_INVALID')
  const modulePath = path.join(compiledRoot, 'src', relative.replace(/\.ts$/, '.js'))
  assert.equal(path.relative(realpathSync(modulePath), modulePath), '', 'APP_CONFIGURED_COMPILED_MODULE_REDIRECTED')
  return modulePath
}
export interface ConfiguredFixture {
  owner: string
  tenantId: string
  systemId: string
  connectionId: string
  projectNo: string
  schema: string
  sourceTables: string[]
  actionId: string
  pluginName: string
  target: { sheetId: string; objectId: string; fieldIdMap: Record<string, string> }
  readPlan: ReadPlan
  b2aRegistrationIds: string[]
}

/** Only synthetic source data and deployment configuration are constructed here.
 * All platform relations already exist from the unmodified full migration provider.
 * No source binding, version, validation receipt, approval or activation is seeded.
 */
export async function seedConfiguredFixture(root: string, scratch: string, query: Query,
  owner: string, tenantId: string): Promise<ConfiguredFixture> {
  const requireCore = createRequire(path.join(root, 'packages/core-backend/package.json'))
  const { STOCK_PREP_PULL_PERMISSION_CODE } = requireCore(configuredCoreModulePath(root,
    'db/migrations/zzzz20261008120000_add_stock_prep_pull_permission.ts')) as { STOCK_PREP_PULL_PERMISSION_CODE: string }
  const { STOCK_PREP_ADMIN_DESCRIPTION_AFTER } = requireCore(configuredCoreModulePath(root,
    'db/migrations/zzzz20261009120000_update_stock_prep_admin_permission_description_project_sheets.ts')) as { STOCK_PREP_ADMIN_DESCRIPTION_AFTER: string }
  await verifyRequiredMainMigrationCatalog(query, { pullCode: STOCK_PREP_PULL_PERMISSION_CODE,
    adminDescriptionAfter: STOCK_PREP_ADMIN_DESCRIPTION_AFTER })
  const { buildStockPreparationTargetDescriptor } = requireCore(path.join(root,
    'plugins/plugin-integration-core/lib/stock-preparation-target-provisioning.cjs')) as {
    buildStockPreparationTargetDescriptor(): { id: string; fields: Array<{ id: string }> }
  }
  const { getObjectSheetId, getObjectFieldId } = requireCore(configuredCoreModulePath(root,
    'multitable/provisioning.ts')) as {
    getObjectSheetId(projectId: string, objectId: string): string
    getObjectFieldId(projectId: string, objectId: string, fieldId: string): string
  }
  const { createB2aRegistry } = requireCore(path.join(root,
    'plugins/plugin-integration-core/lib/b2a-trial-registry.cjs')) as {
    createB2aRegistry(input: { config: { b2aTrialRegistry: unknown } }): { registrationCount: number }
  }
  const nonce = randomUUID().replaceAll('-', '')
  const schema = `plm_full_app_${nonce}`
  assert(/^[a-z][a-z0-9_]+$/.test(schema))
  const connectionId = `plm-full-app-connection-${nonce}`
  const systemId = `plm-full-app-system-${nonce}`
  const actionId = 'plm.stock-preparation.pull-bom.v1'
  const pluginName = 'plugin-integration-core'
  const projectNo = 'SYN-VALIDATION'
  const descriptor = buildStockPreparationTargetDescriptor()
  const projectId = `${tenantId}:integration-core`
  const target = {
    sheetId: getObjectSheetId(projectId, descriptor.id), objectId: descriptor.id,
    fieldIdMap: Object.fromEntries(descriptor.fields.map((field: { id: string }) =>
      [field.id, getObjectFieldId(projectId, descriptor.id, field.id)])),
  }
  assert.equal((await query('SELECT current_schema() AS schema')).rows[0].schema, 'public',
    'APP_CONFIGURED_PLATFORM_PUBLIC_REQUIRED')
  for (const table of ['users', 'meta_sheets', 'meta_fields', 'meta_records', 'plugin_kv',
    'integration_stock_prep_read_plan_validations', 'integration_b2a_operation_claim']) {
    const resolved = await query('SELECT n.nspname AS schema FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=to_regclass($1)', [table])
    assert.equal(resolved.rows[0]?.schema, 'public', 'APP_CONFIGURED_MIGRATED_PLATFORM_REQUIRED')
  }
  await query(`CREATE SCHEMA ${schema}`)
  await query(`
    CREATE TABLE ${schema}.project_links (project_code text, path_ref text);
    CREATE TABLE ${schema}.folders (folder_id text);
    CREATE TABLE ${schema}.sales_headers (order_id text, folder_ref text);
    CREATE TABLE ${schema}.sales_lines (order_ref text, part_ref text, ordered_qty numeric, line_no integer, selected_rev text);
    CREATE TABLE ${schema}.parts (part_id text, drawing_no text, part_name text, browser_synthetic_name text, material_name text, part_rev text);
    CREATE TABLE ${schema}.bom_headers (parent_ref text, bom_id text, bom_rev text, enabled boolean);
    CREATE TABLE ${schema}.bom_lines (header_ref text, child_ref text, per_qty numeric, position_no integer);
    CREATE TABLE ${schema}.bom_lines_alternate (header_ref text, child_ref text, per_qty numeric, position_no integer);
    INSERT INTO ${schema}.project_links VALUES ('SYN-VALIDATION','FOLDER');
    INSERT INTO ${schema}.folders VALUES ('FOLDER');
    INSERT INTO ${schema}.sales_headers VALUES ('ORDER','FOLDER');
    INSERT INTO ${schema}.sales_lines VALUES ('ORDER','ROOT',2,0,'B2');
    INSERT INTO ${schema}.parts VALUES ('ROOT','SYN-ROOT','Synthetic assembly','Synthetic browser assembly','Steel','P1'),
      ('CHILD','SYN-CHILD','Synthetic part','Synthetic browser part','Steel','P1'),
      ('EXTRA','SYN-EXTRA','Synthetic alternate part','Synthetic browser alternate part','Steel','P1');
    INSERT INTO ${schema}.bom_headers VALUES ('ROOT','BOM','B2',true);
    INSERT INTO ${schema}.bom_lines VALUES ('BOM','CHILD',3,0);
    INSERT INTO ${schema}.bom_lines_alternate VALUES ('BOM','CHILD',3,0), ('BOM','EXTRA',1,1);
  `)
  const roles = {
    pathExAttr: { object: `${schema}.project_links`, matchField: 'project_code', pathIdField: 'path_ref' },
    pathInfo: { object: `${schema}.folders`, idField: 'folder_id' },
    orderHead: { object: `${schema}.sales_headers`, idField: 'order_id', pathIdField: 'folder_ref' },
    orderDetail: { object: `${schema}.sales_lines`, orderIdField: 'order_ref', componentIdField: 'part_ref', quantityField: 'ordered_qty', sortField: 'line_no', versionField: 'selected_rev' },
    part: { object: `${schema}.parts`, idField: 'part_id', codeField: 'drawing_no', nameField: 'browser_synthetic_name', materialField: 'material_name', versionField: 'part_rev' },
    bomHead: { object: `${schema}.bom_headers`, parentPartField: 'parent_ref', bomIdField: 'bom_id', versionField: 'bom_rev', activeField: 'enabled' },
    bomDetail: { object: `${schema}.bom_lines_alternate`, bomParentField: 'header_ref', componentIdField: 'child_ref', quantityField: 'per_qty', sortField: 'position_no' },
  }
  // Synthetic review input only. The real production UI imports and compiles
  // this plan before saving; no frontend source module is executed by the harness.
  const readPlan: ReadPlan = { id: 'plm.stock-preparation.bom-read.user-draft.v1',
    sourceKind: 'data-source:sql-readonly', matchField: roles.pathExAttr.matchField,
    maxReadCount: 200, ...roles }
  const b2aRegistrationIds = ['synthetic-configured-validation', 'synthetic-configured-preview', 'synthetic-configured-automation']
  const now = Date.now()
  const registry = { registryId: 'synthetic-configured-app', registryVersion: 1,
    registrations: ['stock-preparation.read-plan-validation', 'stock-preparation.table-action', 'stock-preparation.automation-preview'].map((purpose, i) => ({
      registrationId: b2aRegistrationIds[i], registrationVersion: 1, tenantScope: tenantId,
      sourceSystemType: 'data-source:sql-readonly', sourceBindingRef: systemId,
      projectDataScope: { dataScopeRefs: [projectNo] },
      objectScope: { sourceObjects: Object.values(roles).map(role => role.object) },
      purpose, ownerPrincipalRef: owner, authorizationRef: `synthetic-configured-authorization-${i}`,
      operationRef: `synthetic-configured-operation-${i}`, effectiveAt: new Date(now - 60000).toISOString(),
      expiresAt: new Date(now + 30 * 60000).toISOString(), forbidReuse: true, sourceReadOperationLimit: 1,
      artifactReplayLimit: 0, consumptionState: 'unconsumed', consumedAt: null,
      b2bMigrationCondition: 'Synthetic local full-application acceptance only', expiryHandling: 'deny_replay', status: 'active',
    })),
  }
  assert.equal(createB2aRegistry({ config: { b2aTrialRegistry: registry } }).registrationCount, 3)
  const registryPath = path.join(scratch, 'synthetic-b2a-registry.json')
  await writeFile(registryPath, JSON.stringify(registry) + '\n')
  process.env.INTEGRATION_CORE_B2A_REGISTRY_PATH = registryPath
  process.env.INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON = JSON.stringify([{
    actionId, source: { kind: 'data-source:sql-readonly', externalSystemId: 'synthetic-not-yet-bound' },
    target, rootSelection: { enabled: false },
  }])
  return { owner, tenantId, systemId, connectionId, projectNo, schema, actionId, pluginName, target, readPlan,
    b2aRegistrationIds, sourceTables: ['project_links', 'folders', 'sales_headers', 'sales_lines', 'parts',
      'bom_headers', 'bom_lines', 'bom_lines_alternate'] }
}

export async function configureThroughOwnerHttp(input: { root: string; origin: string; token: string; databaseUrl: string;
  fixture: ConfiguredFixture; query: Query }) {
  const { root, origin, token, fixture: f, query } = input
  const parsed = new URL(input.databaseUrl)
  assert.equal(parsed.hostname, '127.0.0.1', 'APP_CONFIGURED_LOCAL_DATABASE_REQUIRED')
  assert.equal(parsed.pathname, '/plm_full_app_synthetic', 'APP_CONFIGURED_SYNTHETIC_DATABASE_REQUIRED')
  const routeLabels: Record<string, string> = {
    '/api/data-sources': 'connection-create',
    '/api/integration/external-systems': 'external-system-create',
    '/api/integration/stock-preparation/target/ensure': 'target-ensure',
  }
  const post = async (route: string, body: unknown) => {
    const routeLabel = routeLabels[route]
    if (!routeLabel) throw new Error('APP_CONFIGURED_SETUP_ROUTE_INVALID')
    const response = await fetch(origin + route, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000) })
    const envelope = await response.json().catch(() => null) as {
      ok?: boolean; data?: Record<string, unknown>; error?: { code?: unknown }
    } | null
    const rawCode = envelope?.error?.code
    const errorCode = typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{2,79}$/.test(rawCode) ? rawCode : null
    console.log('PLM_FULL_APP_PROBE ' + JSON.stringify({ stage: 'owner-setup-http',
      route: routeLabel, status: response.status, errorCode }))
    if (response.status !== 201) throw new Error('APP_CONFIGURED_SETUP_HTTP_STATUS')
    if (envelope?.ok !== true || !envelope.data || typeof envelope.data !== 'object') {
      throw new Error('APP_CONFIGURED_SETUP_HTTP_ENVELOPE')
    }
    return envelope.data
  }
  const createdConnection = await post('/api/data-sources', { id: f.connectionId, name: 'Synthetic configured PostgreSQL', type: 'postgresql',
    connection: { host: parsed.hostname, port: Number(parsed.port), database: parsed.pathname.slice(1) },
    credentials: { username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) },
    options: { readOnly: true, autoConnect: false }, poolConfig: { min: 0, max: 1, idleTimeout: 1000 },
  })
  // Diagnostic only: inspect the actual HTTP write's persistence, without repairing
  // it or exposing any stored connection, owner, tenant, or revision value.
  const persisted = (await query(`SELECT count(*)::int AS count,
    COALESCE(bool_and(live_id = id), false) AS live_id_equal,
    COALESCE(bool_and(tenant_id = $2), false) AS tenant_matches,
    COALESCE(bool_and(owner_id = $3), false) AS owner_matches
    FROM public.data_sources WHERE id=$1`, [f.connectionId, f.tenantId, f.owner])).rows[0]
  const total = (await query('SELECT count(*)::int AS count FROM public.data_sources')).rows[0]
  const runtimeRequire = createRequire(path.join(root, 'packages/core-backend/package.json'))
  const { getDataSourceManager } = runtimeRequire(configuredCoreModulePath(root,
    'routes/data-sources.ts')) as ConfiguredDataSourceRoutes
  const manager = getDataSourceManager()
  assert.equal(createdConnection.id, f.connectionId, 'APP_CONFIGURED_CONNECTION_RESPONSE_ID_INVALID')
  assert.equal(createdConnection.type, 'postgresql', 'APP_CONFIGURED_CONNECTION_RESPONSE_TYPE_INVALID')
  assert.equal(persisted.count, 1, 'APP_CONFIGURED_COMPILED_CONNECTION_NOT_PERSISTED')
  assert.equal(total.count, 1, 'APP_CONFIGURED_COMPILED_CONNECTION_COUNT_INVALID')
  assert.equal(persisted.live_id_equal, true, 'APP_CONFIGURED_COMPILED_CONNECTION_NOT_LIVE')
  assert.equal(persisted.tenant_matches, true, 'APP_CONFIGURED_COMPILED_CONNECTION_TENANT_INVALID')
  assert.equal(persisted.owner_matches, true, 'APP_CONFIGURED_COMPILED_CONNECTION_OWNER_INVALID')
  assert.equal(manager.listDataSources().length, 1, 'APP_CONFIGURED_COMPILED_MANAGER_COUNT_INVALID')
  assert(manager.getScope(f.connectionId) !== undefined
    && typeof manager.getLoadedValidationRevision(f.connectionId) === 'string',
  'APP_CONFIGURED_COMPILED_MANAGER_SCOPE_REQUIRED')
  await post('/api/integration/external-systems', { id: f.systemId, name: 'Synthetic PLM seven-role source',
    kind: 'data-source:sql-readonly', role: 'source', status: 'active', connectionId: f.connectionId })
  const targetResult = await post('/api/integration/stock-preparation/target/ensure', {})
  assert.equal(targetResult.ready, true, 'APP_CONFIGURED_TARGET_NOT_READY')
  const target = targetResult.targetBinding as typeof f.target
  assert.equal(target.sheetId, f.target.sheetId, 'APP_CONFIGURED_TARGET_SHEET_MISMATCH')
  assert.equal(target.objectId, f.target.objectId, 'APP_CONFIGURED_TARGET_OBJECT_MISMATCH')
  assert.deepEqual(target.fieldIdMap, f.target.fieldIdMap, 'APP_CONFIGURED_TARGET_FIELDS_MISMATCH')
  const connection = (await query('SELECT owner_id,tenant_id,scope_kind,auto_connect FROM data_sources WHERE id=$1', [f.connectionId])).rows[0]
  assert.deepEqual(connection, { owner_id: f.owner, tenant_id: f.tenantId, scope_kind: 'private', auto_connect: false },
    'APP_CONFIGURED_SOURCE_OWNERSHIP_MISMATCH')
  const system = (await query('SELECT tenant_id,workspace_id,connection_id,config FROM integration_external_systems WHERE id=$1', [f.systemId])).rows[0]
  assert.equal(system.tenant_id, f.tenantId)
  assert.equal(system.workspace_id, null)
  assert.equal(system.connection_id, f.connectionId)
  assert.equal((system.config as { dataSourceOwnerId: string }).dataSourceOwnerId, f.owner)
  for (const table of ['integration_stock_prep_source_binding', 'integration_stock_prep_read_plan_versions',
    'integration_stock_prep_read_plan_validations', 'integration_stock_prep_read_plan_activation', 'integration_b2a_operation_claim']) {
    assert.equal((await query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 0,
      'APP_CONFIGURED_BROWSER_MUST_CREATE_AUTHORITY')
  }
}

/** Original source and target relation snapshots establish final-state equality.
 * They do not observe transient writes that are later reverted.
 */
export async function configuredBusinessSnapshot(query: Query, f: ConfiguredFixture) {
  const result: Record<string, unknown> = {}
  for (const table of f.sourceTables) {
    result[`source:${table}`] = (await query(`SELECT to_jsonb(t) AS row FROM ${f.schema}.${table} t ORDER BY to_jsonb(t)::text`)).rows
  }
  for (const table of ['meta_bases', 'meta_sheets', 'meta_fields', 'meta_views', 'meta_records',
    'plugin_multitable_object_registry', 'integration_stock_prep_pack_installs']) {
    result[`target:${table}`] = (await query(`SELECT to_jsonb(t) AS row FROM public.${table} t ORDER BY to_jsonb(t)::text`)).rows
  }
  return result
}

export async function verifyConfiguredBrowserResult(query: Query, f: ConfiguredFixture,
  result: Record<string, unknown>, before: Record<string, unknown>) {
  assert.equal(result.status, 'passed', 'APP_CONFIGURED_BROWSER_RESULT_REQUIRED')
  for (const key of ['versionId', 'validationId', 'dryRunToken']) {
    assert.equal(typeof result[key], 'string', 'APP_CONFIGURED_BROWSER_HANDLE_REQUIRED')
    assert((result[key] as string).length > 0, 'APP_CONFIGURED_BROWSER_HANDLE_EMPTY')
  }
  assert.equal(result.generation, 1, 'APP_CONFIGURED_INITIAL_GENERATION_REQUIRED')
  assert.deepEqual(await configuredBusinessSnapshot(query, f), before, 'APP_CONFIGURED_SOURCE_TARGET_CHANGED')
  const bindings = (await query('SELECT tenant_id,workspace_id,external_system_id,updated_by FROM integration_stock_prep_source_binding WHERE action_id=$1', [f.actionId])).rows
  assert.equal(bindings.length, 2, 'APP_CONFIGURED_BROWSER_BINDINGS_REQUIRED')
  for (const binding of bindings) {
    assert.equal(binding.tenant_id, f.tenantId)
    assert.equal(binding.external_system_id, f.systemId)
    assert.equal(binding.updated_by, f.owner)
  }
  // Both were explicitly created by real UI confirmations. Scope selection alone
  // must not delete/migrate the pre-existing workspace pointer.
  assert.deepEqual(new Set(bindings.map(binding => binding.workspace_id)), new Set([null, f.tenantId]),
    'APP_CONFIGURED_EXACT_TENANT_AND_RETAINED_WORKSPACE_BINDINGS_REQUIRED')
  const version = (await query('SELECT status,system_id,created_by,validation_id,config FROM integration_stock_prep_read_plan_versions WHERE id=$1', [result.versionId])).rows
  assert.equal(version.length, 1)
  assert.equal(version[0].status, 'approved')
  assert.equal(version[0].system_id, f.systemId)
  assert.equal(version[0].created_by, f.owner)
  assert.equal(version[0].validation_id, result.validationId)
  assert.deepEqual((version[0].config as { readPlan: unknown }).readPlan, f.readPlan)
  const activation = (await query(`SELECT version_id,system_id,generation,status,validation_id FROM integration_stock_prep_read_plan_activation
    WHERE tenant_id=$1 AND workspace_id IS NULL AND action_id=$2`, [f.tenantId, f.actionId])).rows
  assert.deepEqual(activation, [{ version_id: result.versionId, system_id: f.systemId,
    generation: 1, status: 'active', validation_id: result.validationId }])
  assert.deepEqual((await query('SELECT status,actor,connection_id FROM integration_stock_prep_read_plan_validations WHERE id=$1',
    [result.validationId])).rows, [{ status: 'confirmed', actor: f.owner, connection_id: f.connectionId }])
  const tokenRows = (await query('SELECT value FROM plugin_kv WHERE plugin=$1 AND key=$2',
    [f.pluginName, `integration:table-action:dry-run-token:${result.dryRunToken}`])).rows
  assert.equal(tokenRows.length, 1, 'APP_CONFIGURED_DURABLE_TOKEN_REQUIRED')
  const token = tokenRows[0].value as { actionId: string; readPlanExecutionIdentity: { versionId: string; systemId: string } }
  assert.equal(token.actionId, f.actionId)
  assert.equal(token.readPlanExecutionIdentity.versionId, result.versionId)
  assert.equal(token.readPlanExecutionIdentity.systemId, f.systemId)
  assert.equal((await query("SELECT count(*)::int AS count FROM plugin_kv WHERE plugin=$1 AND key LIKE 'integration:table-action:dry-run-token:%'", [f.pluginName])).rows[0].count, 1)
  assert.deepEqual((await query('SELECT registration_id FROM integration_b2a_operation_claim ORDER BY registration_id')).rows,
    [...f.b2aRegistrationIds].sort().map(registration_id => ({ registration_id })), 'APP_CONFIGURED_THREE_SEPARATE_ARMED_READS_REQUIRED')
  return { publicPlatformSchema: true, realOwnerHttpConfiguration: true, realPgSource: true,
    sourceAndTargetUnchanged: true, browserCreatedConfirmedApprovedActiveVersion: true,
    explicitTenantBindingCreated: true, existingWorkspaceBindingRetained: true,
    durablePreviewTokenMatchesActivatedVersion: true, b2aArmed: true, b2aDistinctOneShotOperations: 3,
    snapshotProvesFinalStateOnly: true }
}
