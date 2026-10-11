/** SA-06N: actual private authority -> actual read ledger in owned PostgreSQL.
 * All source lifecycle, profile, rule, target and epoch validators are production
 * implementations. Earlier metadata cases supply synthetic preview COUNTS.
 * Executable cases below use the actual manager/facade/SQL adapter, canonical
 * resolver, B2a DB claim/KV, native PostgreSQL, BOM expansion and preview planner.
 * SA-06P cases additionally use the actual host runtime, v4 adapter registration
 * and real dispatcher. SA-06Q adds real JWT/DB roles and HTTP owner controls.
 * SA-06R saves through the actual parser/service before HTTP discovery. The
 * migration CHECK has separate evidence; this suite permits deliberate corruption.
 * SA-06S drives the production owner panel/service in real Chromium before the
 * same JWT/SQL authority, runtime/dispatcher and native synthetic source path.
 * SA-06T adds the real public rule router and Editor/composable/client CRUD before
 * that same owner path. It is an isolated component mount, not full app boot.
 * SA-06U adds actual execution audit migration/projection and public log reads;
 * SA-06V adds owner activation and the real durable record producer's two legs;
 * SA-06W drives explicit record consent in the real owner DOM before that producer;
 * the ordinary executor remains unavailable for integration reads.
 * Schema/data remain synthetic; no customer IO.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { createAutomationReadScheduleObservation } from '../utils/automation-read-schedule-observation'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient, type QueryResult as PgQueryResult } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { up as addRegistry } from '../../src/db/migrations/zzzz20260408123000_create_plugin_multitable_object_registry'
import { up as addSourceRevisions } from '../../src/db/migrations/zzzz20261001120001_stock_prep_validation_source_revisions'
import { up as addValidation } from '../../src/db/migrations/zzzz20261001121000_stock_prep_read_plan_validation_ledger'
import { up as addRuleRevision } from '../../src/db/migrations/zzzz20261001122000_automation_rule_authority_revision'
import { up as addLedger } from '../../src/db/migrations/zzzz20261001123000_automation_read_ledger'
import { up as addPointerRevision } from '../../src/db/migrations/zzzz20261001124000_stock_prep_source_pointer_revisions'
import { up as addProfiles } from '../../src/db/migrations/zzzz20261001125000_automation_read_profiles'
import { up as addMaterialEpochs } from '../../src/db/migrations/zzzz20261001130000_automation_read_material_epochs'
import { up as addSourceEpochs } from '../../src/db/migrations/zzzz20261001131000_stock_prep_automation_source_epochs'
import { up as addOwnerIndexes } from '../../src/db/migrations/zzzz20261001132000_automation_read_owner_controls'
import { up as addReadPreviewAction } from '../../src/db/migrations/zzzz20261001133000_add_automation_read_preview_action'
import { up as addFwbClaims } from '../../src/db/migrations/zzzz20260715200000_create_fwb_action_applied'
import { up as addFwbAction } from '../../src/db/migrations/zzzz20260720120000_add_write_approval_form_values_automation_action'
import { up as addOperationAudit } from '../../src/db/migrations/20250926_create_operation_audit_logs'
import { up as fixOperationAudit } from '../../src/db/migrations/zzzz20260209100000_fix_operation_audit_logs_schema'
import { up as addExecutionAudit } from '../../src/db/migrations/zzzz20261001134000_automation_read_execution_audit'
import { up as addRecordActivation } from '../../src/db/migrations/zzzz20261001135000_automation_read_record_activation'
import { up as addScheduleActivation } from '../../src/db/migrations/zzzz20261001136000_automation_read_schedule_activation'
import { up as addUpdatedRecordActivation } from '../../src/db/migrations/zzzz20261001137000_automation_read_record_updated_activation'
import { up as addRecordAfterImage } from '../../src/db/migrations/zzzz20261001138000_automation_record_after_image'
import { up as addRecordSchemaRevision } from '../../src/db/migrations/zzzz20261001139000_automation_record_schema_revision'
import { up as addRecordConditions } from '../../src/db/migrations/zzzz20261001140000_automation_read_record_conditions'
import { up as addIntervalSchedule } from '../../src/db/migrations/zzzz20261001141000_automation_read_interval_schedule_activation'
import { up as addLinkedRetry } from '../../src/db/migrations/zzzz20261002142000_automation_read_linked_retry'
import { up as addDateSchedule } from '../../src/db/migrations/zzzz20261002143000_automation_read_date_schedule_activation'
import { up as addDateRetry } from '../../src/db/migrations/zzzz20261002144000_automation_read_date_linked_retry'
import { up as addOutbox } from '../../src/db/migrations/zzzz20260715120000_create_automation_outbox'
import { up as addEventFires } from '../../src/db/migrations/zzzz20260701120000_create_automation_event_fires'
import { up as addEventFireLease } from '../../src/db/migrations/zzzz20260716140000_event_fires_lease'
import { createAutomationReadAuthority, type AutomationReadAuthorityCodec } from '../../src/integration/automation-read-authority'
import { createAutomationReadLedger } from '../../src/integration/automation-read-ledger'
import { createAutomationReadExecutor, type AutomationReadExecutionDiagnostic, type AutomationReadExecutorOptions } from '../../src/integration/automation-read-executor'
import * as automationReadExecutorModule from '../../src/integration/automation-read-executor'
import { createAutomationReadSourceExecution } from '../../src/integration/automation-read-source-execution'
import { createAutomationReadRuntime } from '../../src/integration/automation-read-runtime'
import { createAutomationReadDelivery } from '../../src/integration/automation-read-delivery'
import { createAutomationReadManagement } from '../../src/integration/automation-read-management'
import { createAutomationReadHttpAcceptance } from '../utils/automation-read-http-acceptance'
import { runAutomationReadBrowserAcceptance } from '../utils/automation-read-browser-acceptance'
import { createAutomationReadExecutionLogSchema } from '../utils/automation-read-execution-schema'
import { bootstrapOwnedApprovalAfterImageSchema } from '../utils/automation-approval-after-image-schema'
import { bootstrapOwnedRecoveryAfterImageSchema } from '../utils/automation-recovery-after-image-schema'
import { activateCheckpoint } from '../../src/multitable/history-trust-checkpoint'
import { acquireCanonicalSheetFence } from '../../src/multitable/canonical-sheet-fence'
import { mintOperation, sealOperation } from '../../src/multitable/operation-ledger'
import { recordRecordRevision } from '../../src/multitable/record-history-service'
import { ApprovalProductService } from '../../src/services/ApprovalProductService'
import { EventBus } from '../../src/integration/events/event-bus'
import { AutomationService, parseCreateRuleInput } from '../../src/multitable/automation-service'
import { AutomationExecutor, type AutomationRule } from '../../src/multitable/automation-executor'
import { RecordService } from '../../src/multitable/record-service'
import { DataSourceManager } from '../../src/data-adapters/DataSourceManager'
import { PostgresAdapter } from '../../src/data-adapters/PostgresAdapter'
import { createDataSourcePluginFacade } from '../../src/data-adapters/data-source-plugin-facade'
import { createPluginDurableStorage } from '../../src/plugins/plugin-durable-storage'
import { activateAutomationReadProfiles, deactivateAutomationReadProducer, lockAutomationReadProducerForRead, renewAutomationReadProducer, type PreparedAutomationReadProfile,
  type AutomationReadProducerIdentity } from '../../src/integration/automation-read-profiles'
import * as automationReadProfileModule from '../../src/integration/automation-read-profiles'
import { AUTOMATION_READ_ACTION_TYPE, AUTOMATION_READ_OPERATION } from '../../src/integration/automation-read-operation-policy'
import { AUTOMATION_READ_CONSUMER, AUTOMATION_READ_EVENT, AutomationReadLedgerError,
  type ReadBudget, type ReadGrantInput, type ReadPreview, type ReadSelector, type ReadScheduleOccurrence } from '../../src/integration/automation-read-contracts'
import { AutomationActorAuthorityError, type AutomationIntegrationActor } from '../../src/integration/automation-live-authority'
import { claimDueConsumers, type Queryable } from '../../src/multitable/automation-durable-dispatcher'
import type { TransactionalQueryable } from '../../src/multitable/pg-transaction-guard'
import { CURRENT_ROUTING_MANIFEST, assertManifestCompleteness, type RoutingManifest } from '../../src/multitable/automation-routing-manifest'
import { buildConsumerAdapterRegistry, type DurableConsumerHandlers } from '../../src/multitable/automation-durable-activation'
import { buildDurableConsumerHandlers } from '../../src/multitable/automation-durable-consumer-handlers'
import { enqueueOutboxEvent } from '../../src/multitable/automation-outbox-enqueue'
import { captureAutomationRecordSchema } from '../../src/multitable/automation-record-schema'
import { persistAutomationRecordAfterImage } from '../../src/multitable/automation-record-after-image'
import { ConsumerAdapterRegistry, runDispatchTick } from '../../src/multitable/automation-durable-dispatch-loop'

const describeDb = process.env.DATABASE_URL ? describe : describe.skip
const expectDb = process.env.EXPECT_DB === '1' ? it : it.skip
expectDb('EXPECT_DB supplies a database for the complete private authority suite', () => { expect(process.env.DATABASE_URL).toBeTruthy() })
type Row = Record<string, unknown>
type MetadataPhase = 'connect' | 'begin' | 'work' | 'query' | 'after-query-hook' | 'commit' | 'rollback' | 'source-lock'
type MetadataSqlStage = 'isolation' | 'transaction-probe' | 'clock' | 'request' | 'grant' | 'producer'
  | 'metadata-table-lock' | 'acl-table-lock' | 'source-pointer-table-lock' | 'other-table-lock'
  | 'profile' | 'actor-role' | 'role-permission' | 'direct-permission' | 'actor-user' | 'actor-membership'
  | 'namespace-admission' | 'source-activation' | 'source-version' | 'source-validation' | 'source-mirror'
  | 'source-system' | 'source-connection' | 'source-pointer' | 'material-epoch' | 'target-binding'
  | 'target-registry' | 'target-install' | 'target-field' | 'target-sheet' | 'target-base' | 'rule'
  | 'sheet-permission' | 'field-permission' | 'record-permission' | 'other'
type MetadataFact = { phase: MetadataPhase; outcome: 'returned' | 'rejected'; elapsedMs: number; code: string;
  sqlStage?: MetadataSqlStage; query?: number; lock?: 'table-nowait' | 'row-nowait' | 'share' | 'update' | 'none' }
type MetadataTransaction = { ordinal: number; queryCount: number; queryReturned: number;
  phases: MetadataFact[]; queryTail: MetadataFact[]; queryFailures: MetadataFact[]; overflow: boolean;
  queryTailTruncated?: boolean; metadataTableLocks?: number }
type RuntimeMetadataTransaction = MetadataTransaction & { outcome: 'pending' | 'returned' | 'rejected'; code: string; elapsedMs: number }
type MetadataCheckpoint = { checkpoint: number; elapsedMs: number; outcome: 'pending' | 'returned' | 'rejected';
  code: string; transactionCount: number; transactions: MetadataTransaction[]; dependencies: MetadataFact[]; overflow: boolean }
const metadataErrorCodes = new Set(['55P03', '40001', '40P01', '23503', '23505', '23514', '57014', '25P02',
  '42P01', '42703', '42501', '08000', '08001', '08003', '08006', '57P01', '57P02', '57P03', '53300',
  'AUTOMATION_READ_DENIED', 'AUTOMATION_READ_SCOPE_CHANGED', 'AUTOMATION_READ_BUDGET_EXHAUSTED',
  'AUTOMATION_READ_FENCE_LOST', 'AUTOMATION_READ_UNAVAILABLE', 'AUTOMATION_READ_TRANSACTION_REQUIRED',
  'AUTOMATION_ACTOR_AUTHORITY_DENIED', 'AUTOMATION_ACTOR_AUTHORITY_UNAVAILABLE', 'AUTOMATION_ACTOR_TRANSACTION_REQUIRED'])
function metadataErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined
  return typeof code === 'string' && metadataErrorCodes.has(code) ? code : 'unknown'
}
function metadataSqlStage(statement: string): MetadataSqlStage {
  // Classification consumes only the already-issued statement. Diagnostics never
  // retain it, its parameters, identities, receipts, driver message or stack.
  if (statement.includes("current_setting('transaction_isolation')")) return 'isolation'
  if (/pg_(?:current_xact_id|xact_status)/u.test(statement)) return 'transaction-probe'
  if (/\b(?:clock_timestamp|extract\(epoch)/u.test(statement) && !/\bFROM\b/iu.test(statement)) return 'clock'
  if (/^\s*LOCK TABLE\b/iu.test(statement)) {
    if (statement.includes('plugin_multitable_object_registry')) return 'metadata-table-lock'
    if (statement.includes('user_roles')) return 'acl-table-lock'
    if (statement.includes('integration_stock_prep_source_binding')) return 'source-pointer-table-lock'
    return 'other-table-lock'
  }
  const tables: Array<[string, MetadataSqlStage]> = [
    ['integration_automation_read_requests', 'request'], ['integration_automation_read_grants', 'grant'],
    ['automation_read_producer_slot', 'producer'], ['automation_read_target_profiles', 'profile'],
    ['user_roles', 'actor-role'], ['role_permissions', 'role-permission'], ['user_permissions', 'direct-permission'],
    ['user_orgs', 'actor-membership'], ['user_namespace_admissions', 'namespace-admission'], ['users', 'actor-user'],
    ['integration_stock_prep_read_plan_activation', 'source-activation'], ['integration_stock_prep_read_plan_versions', 'source-version'],
    ['integration_stock_prep_read_plan_validations', 'source-validation'], ['integration_data_source_validation_revisions', 'source-mirror'],
    ['integration_external_systems', 'source-system'], ['data_sources', 'source-connection'],
    ['integration_stock_prep_source_pointer_revisions', 'source-pointer'], ['integration_stock_prep_source_binding', 'source-pointer'],
    ['automation_read_material_epochs', 'material-epoch'], ['automation_read_target_bindings', 'target-binding'],
    ['plugin_multitable_object_registry', 'target-registry'], ['integration_stock_prep_pack_installs', 'target-install'],
    ['meta_fields', 'target-field'], ['meta_sheets', 'target-sheet'], ['meta_bases', 'target-base'], ['automation_rules', 'rule'],
    ['spreadsheet_permissions', 'sheet-permission'], ['field_permissions', 'field-permission'], ['record_permissions', 'record-permission'],
  ]
  return tables.find(([table]) => statement.includes(table))?.[1] ?? 'other'
}
type Version = { id: string; contentKey: string; config: Row; status: string }
type Activation = { id: string; generation: number; validationId: string }
type Receipt = { validationId: string }
type Store = {
  saveVersion(input: Row): Promise<Version>
  beginValidation(input: Row): Promise<Receipt>
  finishValidation(input: Row): Promise<Receipt>
  confirmValidation(input: Row): Promise<Receipt>
  approve(input: Row): Promise<Version>
  activate(input: Row): Promise<Activation>
  lockActiveForAutomation: Parameters<typeof createAutomationReadAuthority>[0]['sourceStore']['lockActiveForAutomation']
}
const plugin = createRequire(import.meta.url)
const lib = path.resolve(__dirname, '../../../../plugins/plugin-integration-core/lib')
const { createDb } = plugin(path.join(lib, 'db.cjs')) as { createDb(input: {
  database: Queryable & { transaction<T>(work: (trx: Queryable) => Promise<T>): Promise<T> }
}): unknown }
const { createStockPreparationReadPlanStore } = plugin(path.join(lib, 'stock-preparation-read-plan-store.cjs')) as {
  createStockPreparationReadPlanStore(input: { db: unknown; now(): number; idGenerator(): string }): Store
}
const { prepareStockPreparationAutomationProfiles: prepare, restoreStockPreparationAutomationProfileMaterial,
  composeStockPreparationAutomationExecution } = plugin(path.join(lib, 'stock-preparation-automation-profile.cjs')) as {
  prepareStockPreparationAutomationProfiles(input: { config: unknown }): readonly PreparedAutomationReadProfile[]
} & Pick<AutomationReadAuthorityCodec, 'restoreStockPreparationAutomationProfileMaterial' | 'composeStockPreparationAutomationExecution'>
const { deriveAutomationReadTargetContract } = plugin(path.join(lib, 'stock-preparation-automation-target-contract.cjs')) as
  Pick<AutomationReadAuthorityCodec, 'deriveAutomationReadTargetContract'>
const { validateStockPreparationReadPlanConfig } = plugin(path.join(lib, 'stock-preparation-read-plan-config.cjs')) as {
  validateStockPreparationReadPlanConfig(input: unknown): Row
}
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE: template } = plugin(path.join(lib, 'stock-preparation-templates.cjs')) as {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE: { objectId: string; fields: Array<{ id: string }> }
}
const { createStockPreparationAutomationPreview } = plugin(path.join(lib, 'stock-preparation-automation-preview.cjs')) as {
  createStockPreparationAutomationPreview(options: Row): AutomationReadExecutorOptions['preview']
}
const { createConnectionResolver } = plugin(path.join(lib, 'connection-resolver.cjs')) as {
  createConnectionResolver(options: Row): object
}
const { createExternalSystemRegistry } = plugin(path.join(lib, 'external-systems.cjs')) as {
  createExternalSystemRegistry(options: Row): object
}
const { createCredentialStore } = plugin(path.join(lib, 'credential-store.cjs')) as {
  createCredentialStore(options: Row): object
}
type AdapterRegistry = { registerAdapter(kind: string, factory: unknown, options: Row): AdapterRegistry }
const { createAdapterRegistry } = plugin(path.join(lib, 'contracts.cjs')) as {
  createAdapterRegistry(): AdapterRegistry
}
const { createDataSourceSqlReadonlySourceAdapterFactory, DATA_SOURCE_SQL_READONLY_ADAPTER_METADATA } =
  plugin(path.join(lib, 'adapters/data-source-sql-readonly-source-adapter.cjs')) as {
    createDataSourceSqlReadonlySourceAdapterFactory(options: Row): unknown
    DATA_SOURCE_SQL_READONLY_ADAPTER_METADATA: object
  }
const { createB2aRegistry, createB2aOperationClaim } = plugin(path.join(lib, 'b2a-trial-registry.cjs')) as {
  createB2aRegistry(options: Row): object
  createB2aOperationClaim(options: Row): { claim(input: Row): Promise<{ held: boolean; claimed: boolean; holderRunId: string | null }> }
}
const codec: AutomationReadAuthorityCodec = { restoreStockPreparationAutomationProfileMaterial,
  deriveAutomationReadTargetContract, composeStockPreparationAutomationExecution }
const actor: AutomationIntegrationActor = { actorId: 'synthetic-owner', tenantId: 'synthetic-tenant', workspaceId: null }
const actionId = 'plm.stock-preparation.pull-bom.v1', systemId = 'synthetic-system', connectionId = 'synthetic-connection'
const projectId = 'synthetic-deployment', sheetId = 'synthetic-sheet', baseId = 'synthetic-base-not-deployment', ruleId = 'synthetic-rule'
const scope = { tenantId: actor.tenantId, workspaceId: null }
const ceiling: ReadBudget = { maxRows: 80, maxPages: 4, maxReadCount: 90, timeoutMs: 60000 }
const requestBudget: ReadBudget = { maxRows: 20, maxPages: 2, maxReadCount: 30, timeoutMs: 5000 }
const fixtureManifest: RoutingManifest = { version: 1901, routes: { [AUTOMATION_READ_EVENT]: [AUTOMATION_READ_CONSUMER] } }
const preview: ReadPreview = { status: 'ready', counts: { add: 1, update: 2, skip: 0, inactive: 0, manual_confirm: 0 }, canApply: false }
const ruleConfig = { operation: AUTOMATION_READ_OPERATION, allowManual: true }
const sourceTables = ['integration_stock_prep_read_plan_versions', 'integration_stock_prep_read_plan_validations',
  'integration_stock_prep_read_plan_activation'] as const
function config(selectedSystem = systemId, objectPrefix = ''): Row {
  const role = (object: string, fields: string[]) => ({ object: objectPrefix + (objectPrefix ? object.toLowerCase() : object),
    ...Object.fromEntries(fields.map(field => [field, objectPrefix ? field.toLowerCase() : field])) })
  return validateStockPreparationReadPlanConfig({ schemaVersion: 1, actionId, systemId: selectedSystem,
    readPlan: { id: 'plm.stock-preparation.bom-read.user-draft.v1', sourceKind: 'data-source:sql-readonly',
      matchField: objectPrefix ? 'matchfield' : 'matchField', maxReadCount: 60,
      pathExAttr: role('SYN_PathLink', ['matchField', 'pathIdField']), pathInfo: role('SYN_Path', ['idField']),
      orderHead: role('SYN_Order', ['idField', 'pathIdField']),
      orderDetail: role('SYN_OrderLine', ['orderIdField', 'componentIdField', 'quantityField']),
      part: role('SYN_Part', ['idField']), bomHead: role('SYN_Bom', ['parentPartField', 'bomIdField']),
      bomDetail: role('SYN_BomLine', ['bomParentField', 'componentIdField', 'quantityField']),
    } })
}
async function refusal(work: Promise<unknown>, code?: string) {
  const error: unknown = await work.then(() => undefined, caught => caught)
  expect(error).toBeInstanceOf(AutomationReadLedgerError)
  expect(error).toMatchObject({ code: code ?? expect.stringMatching(/^AUTOMATION_READ_/u) })
  expect(error).not.toHaveProperty('cause')
  expect(error).not.toHaveProperty('details')
  expect(String(error)).not.toContain('synthetic-private-driver-detail')
}

describeDb('Automation authority: actual source, rule, profile, target and ledger composition', () => {
  const schema = 'automation_authority_' + randomBytes(8).toString('hex')
  let pool: Pool, db: Kysely<unknown>, admin: PoolClient, reader: PoolClient, writer: PoolClient, observer: PoolClient
  let created = false, sequence = 0, resetOrdinal = 0, approvalSchemaReady = false, fwbSchemaReady = false
  let createdNamespace: { namespaceOid: string; ownerOid: string } | undefined
  let store: Store, version: Version, activation: Activation, receipt: Receipt
  let producer: AutomationReadProducerIdentity, selector: ReadSelector, fieldMap: Record<string, string>
  let authority: ReturnType<typeof createAutomationReadAuthority>, ledger: ReturnType<typeof createAutomationReadLedger>
  let deploymentConfig: Row
  const statements: string[] = []
  let afterMetadataQuery: ((statement: string) => Promise<void>) | undefined
  const metadataCheckpoint = new AsyncLocalStorage<MetadataCheckpoint>()
  const fixtureEnvironment = new Map<string, string | undefined>()
  const executionManagers = new Set<DataSourceManager>()
  const maintenanceIsolatedTables = ['users', 'user_roles', 'user_permissions', 'role_permissions',
    'platform_member_group_members', 'spreadsheet_permissions', 'field_permissions', 'record_permissions',
    'meta_bases', 'meta_sheets', 'meta_fields', 'plugin_multitable_object_registry',
    'integration_stock_prep_pack_installs', 'integration_stock_prep_source_binding'] as const
  async function ownedMaintenanceNamespace() {
    if (!created || !/^automation_authority_[a-f0-9]{16}$/u.test(schema)) throw new Error('Unowned maintenance schema')
    const namespaces = (await admin.query(`SELECT n.oid::text AS namespace_oid,n.nspname AS namespace_name,
      n.nspowner::text AS owner_oid,n.nspowner=(SELECT r.oid FROM pg_catalog.pg_roles r WHERE r.rolname=current_user) AS owned
      FROM pg_catalog.pg_namespace n WHERE n.nspname=$1`, [schema])).rows
    if (namespaces.length !== 1 || namespaces[0].namespace_name !== schema || namespaces[0].owned !== true
      || !/^[1-9][0-9]*$/u.test(String(namespaces[0].namespace_oid))
      || !/^[1-9][0-9]*$/u.test(String(namespaces[0].owner_oid))) throw new Error('Unowned maintenance namespace identity')
    return namespaces[0]
  }
  async function isolateOwnedMaintenanceTables() {
    const namespace = await ownedMaintenanceNamespace()
    if (!createdNamespace || namespace.namespace_oid !== createdNamespace.namespaceOid
      || namespace.owner_oid !== createdNamespace.ownerOid) throw new Error('Maintenance namespace creation identity changed')
    const identities = async () => (await admin.query(`SELECT c.oid::text AS relation_oid,c.relname AS relation_name,
      c.relnamespace::text AS namespace_oid,c.relowner::text AS owner_oid,c.relkind,c.reloptions,
      pg_catalog.to_regclass(pg_catalog.format('%I.%I',n.nspname,c.relname))::oid::text AS qualified_oid,
      pg_catalog.to_regclass(pg_catalog.quote_ident(c.relname))::oid::text AS unqualified_oid
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND c.relname=ANY($2::text[])`, [schema, maintenanceIsolatedTables])).rows
    const before = await identities()
    const sameOwnedIdentity = (row: Row) => row.namespace_oid === namespace.namespace_oid
      && row.owner_oid === namespace.owner_oid && row.relkind === 'r'
      && /^[1-9][0-9]*$/u.test(String(row.relation_oid))
      && row.qualified_oid === row.relation_oid && row.unqualified_oid === row.relation_oid
    if (before.length !== maintenanceIsolatedTables.length || !before.every(sameOwnedIdentity)
      || !maintenanceIsolatedTables.every(table => before.filter(row => row.relation_name === table).length === 1)) {
      throw new Error('Unowned or shadowed maintenance relation identity')
    }
    // This removes autonomous maintenance from fourteen test-created guard
    // tables only. It does not identify any historical lock holder or cause.
    for (const table of maintenanceIsolatedTables) await admin.query(
      `ALTER TABLE ONLY "${schema}"."${table}" SET (autovacuum_enabled = false)`)
    const after = await identities()
    if (after.length !== before.length || !after.every(row => sameOwnedIdentity(row)
      && before.some(original => original.relation_name === row.relation_name && original.relation_oid === row.relation_oid)
      && Array.isArray(row.reloptions) && row.reloptions.includes('autovacuum_enabled=false'))) {
      throw new Error('Maintenance relation identity or options changed unexpectedly')
    }
  }
  async function observeMetadata<T>(phase: MetadataPhase, work: () => Promise<T>, record?: (fact: MetadataFact) => void,
    query?: { sqlStage: MetadataSqlStage; query: number; lock: MetadataFact['lock'] }): Promise<T> {
    if (!record) return work()
    const started = performance.now()
    let outcome: MetadataFact['outcome'] = 'returned', code = 'none'
    try { return await work() }
    catch (error) { outcome = 'rejected'; code = metadataErrorCode(error); throw error }
    finally { record({ phase, outcome, elapsedMs: performance.now() - started, code, ...query }) }
  }
  async function tx<T>(client: PoolClient, work: (trx: PoolClient) => Promise<T>, observed?: MetadataTransaction): Promise<T> {
    const phase = observed ? (fact: MetadataFact) => {
      if (observed.phases.length < 8) observed.phases.push(fact)
      else observed.overflow = true
    } : undefined
    await observeMetadata('begin', () => client.query('BEGIN ISOLATION LEVEL READ COMMITTED'), phase)
    try {
      const result = await observeMetadata('work', () => work(client), phase)
      await observeMetadata('commit', () => client.query('COMMIT'), phase)
      return result
    } catch (error) {
      await observeMetadata('rollback', () => client.query('ROLLBACK'), phase)
      throw error
    }
  }
  async function transaction<T>(work: (trx: TransactionalQueryable) => Promise<T>, explicitObservation?: MetadataTransaction): Promise<T> {
    const checkpoint = metadataCheckpoint.getStore()
    let observed = explicitObservation
    if (checkpoint && !observed) {
      observed = { ordinal: ++checkpoint.transactionCount, queryCount: 0, queryReturned: 0,
        phases: [], queryTail: [], queryFailures: [], overflow: false }
      if (checkpoint.transactions.length < 4) checkpoint.transactions.push(observed)
      else checkpoint.overflow = true
    }
    const phase = observed ? (fact: MetadataFact) => {
      if (observed!.phases.length < 8) observed!.phases.push(fact)
      else observed!.overflow = true
    } : undefined
    const client = await observeMetadata('connect', () => pool.connect(), phase)
    try { return await tx(client, trx => work({ isTransaction: true, async query(sql, params) {
      statements.push(sql)
      const query = observed ? { sqlStage: metadataSqlStage(sql), query: ++observed.queryCount,
        lock: /\bNOWAIT\b/iu.test(sql) ? /^\s*LOCK TABLE\b/iu.test(sql) ? 'table-nowait' as const : 'row-nowait' as const
          : /\bFOR SHARE\b/iu.test(sql) ? 'share' as const
          : /\bFOR UPDATE\b/iu.test(sql) ? 'update' as const : 'none' as const } : undefined
      if (observed?.metadataTableLocks !== undefined && query?.sqlStage === 'metadata-table-lock') observed.metadataTableLocks++
      const record = observed ? (fact: MetadataFact) => {
        if (fact.outcome === 'returned') observed!.queryReturned++
        else if (observed!.queryFailures.length < 4) observed!.queryFailures.push(fact)
        else observed!.overflow = true
        observed!.queryTail.push(fact)
        if (observed!.queryTail.length > 16) { observed!.queryTail.shift(); observed!.queryTailTruncated = true }
      } : undefined
      const result = await observeMetadata('query', () => trx.query(sql, params), record, query)
      if (afterMetadataQuery) await observeMetadata('after-query-hook', () => afterMetadataQuery!(sql), phase)
      return result
    } }), observed) } finally { client.release() }
  }
  function build(selectedCeiling = ceiling) {
    // Preserve the original authority dependency's capture time and function
    // identity; observing it must not make a later mutable store authoritative.
    const actualSourceLock = store.lockActiveForAutomation
    return createAutomationReadAuthority({ producer, codec, sourceStore: { lockActiveForAutomation(trx, input) {
      const checkpoint = metadataCheckpoint.getStore()
      return observeMetadata('source-lock', () => actualSourceLock(trx, input), checkpoint ? fact => {
        if (checkpoint.dependencies.length < 4) checkpoint.dependencies.push(fact)
        else checkpoint.overflow = true
      } : undefined)
    } }, budgetCeiling: selectedCeiling })
  }
  async function capture(selected = selector, port = authority, principal = actor) {
    return tx(reader, trx => port.lockExecution(trx, principal, selected))
  }
  async function prepareConditionalRule(
    fields: Array<{ id: string; type: string; property?: Row }>,
    conditions: unknown = { conjunction: 'AND', conditions: fields.map(field => ({
      fieldId: field.id, operator: 'in', value: ['synthetic-member'],
    })) },
  ) {
    for (const field of fields) await admin.query(
      'INSERT INTO meta_fields(id,sheet_id,name,type,property) VALUES ($1,$2,$1,$3,$4::jsonb)',
      [field.id, sheetId, field.type, JSON.stringify(field.property ?? {})],
    )
    await admin.query('UPDATE automation_rules SET conditions=$2::jsonb WHERE id=$1', [ruleId, JSON.stringify(conditions)])
  }
  async function captureConditional() {
    return tx(reader, trx => authority.lockRecordExecution(trx, actor, selector))
  }
  async function grant(overrides: Partial<ReadGrantInput> = {}) {
    return ledger.grant(actor, { selector, budget: requestBudget, projects: ['SYN-PROJECT'], triggers: ['manual', 'record'],
      maxExecutions: 3, expiresAt: '2099-01-01T00:00:00.000Z', ...overrides })
  }
  async function queued() {
    const { grantId } = await grant()
    const request = await ledger.submit(actor, { grantId, invocationId: randomUUID(), projectNo: 'SYN-PROJECT', trigger: 'manual' })
    return { grantId, ...request }
  }
  async function running() {
    const request = await queued(), claim = await ledger.claim(request.requestId)
    expect(claim).toMatchObject({ status: 'running', fence: expect.any(String) })
    if (!('fence' in claim) || typeof claim.fence !== 'string') throw new Error('Expected real authority claim')
    return { ...request, fence: claim.fence }
  }
  async function counts() {
    return (await admin.query(`SELECT (SELECT count(*)::int FROM integration_automation_read_grants) AS grants,
      (SELECT count(*)::int FROM integration_automation_read_requests) AS requests,
      (SELECT count(*)::int FROM meta_automation_outbox) AS outbox`)).rows[0]
  }
  type ProducerRetirementProof = Readonly<{
    identity: AutomationReadProducerIdentity
    profiles: readonly Readonly<{ targetId: string; revision: string }>[]
  }>
  type ProducerSlotReceipt = { generation: string; nonce: string | null; live: boolean | null; unleased: boolean }
  type ProducerProfileReceipt = { target_id: string; revision: string; enabled: boolean }
  async function producerSlot(): Promise<ProducerSlotReceipt> {
    const slots = (await admin.query<ProducerSlotReceipt>(`SELECT generation::text,nonce::text,
      expires_at>pg_catalog.clock_timestamp() AS live,expires_at IS NULL AS unleased
      FROM automation_read_producer_slot WHERE slot_id=1`)).rows
    // Identity receipts stay private even when an assertion fails.
    expect(slots.length).toBe(1)
    return slots[0]
  }
  async function originalProducerProfiles(identity: AutomationReadProducerIdentity) {
    return (await admin.query<ProducerProfileReceipt>(`SELECT target_id::text,revision::text,enabled FROM automation_read_target_profiles
      WHERE producer_generation=$1::bigint AND producer_nonce=$2::uuid ORDER BY target_id`,
    [identity.generation, identity.nonce])).rows
  }
  async function captureProducerRetirementProof(): Promise<ProducerRetirementProof> {
    const slot = await producerSlot()
    expect(typeof slot.generation === 'string' && /^[1-9][0-9]*$/u.test(slot.generation)).toBe(true)
    expect(typeof slot.nonce === 'string' && /^[a-f0-9-]{36}$/u.test(slot.nonce)).toBe(true)
    expect(slot.live).toBe(true)
    const identity = Object.freeze({ generation: String(slot.generation), nonce: String(slot.nonce) })
    const profiles = await originalProducerProfiles(identity)
    expect(profiles.length).toBeGreaterThan(0)
    expect(profiles.every(profile => profile.enabled === true
      && typeof profile.target_id === 'string' && typeof profile.revision === 'string')).toBe(true)
    return Object.freeze({ identity, profiles: Object.freeze(profiles.map(profile => Object.freeze({
      targetId: String(profile.target_id), revision: String(profile.revision),
    }))) })
  }
  async function expectProducerDrainState(proof: ProducerRetirementProof, retired: boolean) {
    const slot = await producerSlot()
    if (retired) {
      expect(typeof slot.generation === 'string' && /^[1-9][0-9]*$/u.test(slot.generation)).toBe(true)
      expect(BigInt(slot.generation) > BigInt(proof.identity.generation)).toBe(true)
      expect(typeof slot.nonce === 'string' && /^[a-f0-9-]{36}$/u.test(slot.nonce)
        && slot.nonce !== proof.identity.nonce).toBe(true)
      expect(slot.unleased).toBe(true)
    } else {
      expect(slot.generation === proof.identity.generation && slot.nonce === proof.identity.nonce).toBe(true)
      expect(slot.live).toBe(true)
    }
    const profiles = await originalProducerProfiles(proof.identity)
    expect(profiles.length).toBe(proof.profiles.length)
    expect(profiles.every((profile, index) => profile.target_id === proof.profiles[index].targetId
      && profile.enabled === !retired && (retired || profile.revision === proof.profiles[index].revision))).toBe(true)
    if (retired) {
      await expect(transaction(trx => lockAutomationReadProducerForRead(trx, proof.identity)))
        .rejects.toMatchObject({ code: 'AUTOMATION_PROFILE_FENCE_LOST' })
      await expect(transaction(trx => renewAutomationReadProducer(trx, proof.identity)))
        .rejects.toMatchObject({ code: 'AUTOMATION_PROFILE_FENCE_LOST' })
    }
  }
  function observeRuntimeStopOrder() {
    type Event = 'drain-entered' | 'drain-returned' | 'drain-rejected'
      | 'retire-entered' | 'retire-returned' | 'retire-rejected'
    const events: Event[] = []
    let factoryCalls = 0, executeUnchanged = true, overflow = false
    const record = (event: Event) => { if (events.length < 8) events.push(event); else overflow = true }
    const actualFactory = automationReadExecutorModule.createAutomationReadExecutor
    const actualRetire = automationReadProfileModule.deactivateAutomationReadProducer
    const factorySpy = vi.spyOn(automationReadExecutorModule, 'createAutomationReadExecutor').mockImplementation(options => {
      factoryCalls++
      const actual = actualFactory(options)
      const observed = Object.freeze({ ...actual, async drainPendingWork() {
        record('drain-entered')
        try { await actual.drainPendingWork(); record('drain-returned') }
        catch (error) { record('drain-rejected'); throw error }
      } })
      executeUnchanged &&= observed.execute === actual.execute
      return observed
    })
    try {
      const retirementSpy = vi.spyOn(automationReadProfileModule, 'deactivateAutomationReadProducer')
        .mockImplementation(async (trx, identity) => {
          record('retire-entered')
          try { await actualRetire(trx, identity); record('retire-returned') }
          catch (error) { record('retire-rejected'); throw error }
        })
      return {
        snapshot: () => ({ factoryCalls, executeUnchanged, events: [...events], overflow }),
        restoreFactory() { factorySpy.mockRestore() },
        restore() { factorySpy.mockRestore(); retirementSpy.mockRestore() },
      }
    } catch (error) { factorySpy.mockRestore(); throw error }
  }
  function expectRuntimeStopOrder(observation: ReturnType<ReturnType<typeof observeRuntimeStopOrder>['snapshot']>) {
    expect(observation).toEqual({ factoryCalls: 1, executeUnchanged: true, overflow: false,
      events: ['drain-entered', 'drain-returned', 'retire-entered', 'retire-returned'] })
  }
  async function observeResetTruncate<T>(work: () => Promise<T>): Promise<T> {
    const ordinal = ++resetOrdinal
    const backendPid: unknown = Object.getOwnPropertyDescriptor(admin, 'processID')?.value
    if (!Number.isSafeInteger(ordinal) || ordinal > 128 || typeof backendPid !== 'number'
      || !Number.isSafeInteger(backendPid) || backendPid <= 0 || backendPid > 2147483647) {
      throw new Error('Invalid owned reset diagnostic identity')
    }
    const started = performance.now()
    const report = (outcome: 'begin' | 'returned' | 'rejected', code = 'none') => console.info(
      'automation-read-owned-reset', JSON.stringify({ resetOrdinal: ordinal, backendPid, stage: 'truncate',
        outcome, elapsedMs: outcome === 'begin' ? 0 : performance.now() - started, code }))
    // Observe this unchanged batch call only: no SQL, binds, rows, driver details,
    // extra database probes, retries, or reset/timeout changes enter diagnostics.
    report('begin')
    try { const result = await work(); report('returned'); return result }
    catch (error) { report('rejected', metadataErrorCode(error)); throw error }
  }
  async function executionAudit(requestId: string, expectedRule: string, status: 'queued' | 'succeeded' | 'outcome_unknown') {
    const rows = (await admin.query(`SELECT e.*,l.request_id,l.step_index,l.rule_revision
      FROM integration_automation_read_executions l JOIN multitable_automation_executions e ON e.id=l.execution_id
      WHERE l.request_id=$1`, [requestId])).rows
    expect(rows).toHaveLength(1)
    const row = rows[0]
    const completedStatus = status === 'outcome_unknown' ? 'failed' : 'success'
    expect(row).toMatchObject({ rule_id: expectedRule, sheet_id: sheetId, step_index: 0,
      triggered_by: 'integration-read-owner', integration_read: { requestId, status },
      status: status === 'queued' ? 'running' : completedStatus, trigger_event: null, rule_snapshot: null })
    expect(row.rule_revision).toBe((await admin.query('SELECT integration_authority_revision FROM automation_rules WHERE id=$1', [expectedRule])).rows[0].integration_authority_revision)
    expect(row.steps).toEqual(status === 'queued' ? [] : [{ actionType: AUTOMATION_READ_ACTION_TYPE,
      status: completedStatus, output: { requestId, status },
      ...(status === 'outcome_unknown' ? { error: 'AUTOMATION_READ_OUTCOME_UNKNOWN' } : {}) }])
    if (status === 'outcome_unknown') expect(row.error).toBe('AUTOMATION_READ_OUTCOME_UNKNOWN')
    for (const secret of [projectId, 'SYN-PROJECT', systemId, connectionId, 'counts', 'selector', 'canApply']) {
      expect(JSON.stringify({ marker: row.integration_read, steps: row.steps, snapshot: row.rule_snapshot, event: row.trigger_event })).not.toContain(secret)
    }
    return row
  }
  async function sourceLifecycle(selectedSystem = systemId, expectedGeneration = 0, sourceConfig = config(selectedSystem)) {
    version = await store.saveVersion({ ...scope, actor: actor.actorId, config: sourceConfig })
    const binding = (await admin.query('SELECT connection_id,validation_revision FROM integration_external_systems WHERE id=$1', [selectedSystem])).rows[0]
    const mirror = (await admin.query('SELECT validation_revision FROM integration_data_source_validation_revisions WHERE data_source_id=$1', [binding.connection_id])).rows[0]
    const input = { ...scope, actor: actor.actorId, id: version.id,
      source: { connectionId: binding.connection_id, connectionRevision: mirror.validation_revision } }
    receipt = await store.beginValidation(input)
    await store.finishValidation({ ...input, validationId: receipt.validationId, counts: { sampleCount: 2, readCount: 7, objectCount: 7 } })
    await store.confirmValidation({ ...input, validationId: receipt.validationId })
    version = await store.approve({ ...scope, actor: actor.actorId, id: version.id })
    activation = await store.activate({ ...scope, actor: actor.actorId, id: version.id, expectedGeneration })
  }
  async function installProfile(layout = 'layout-a', defaultSystem = systemId, executionBounds: Row = {}) {
    await admin.query('DELETE FROM meta_fields')
    fieldMap = Object.fromEntries(template.fields.map((field, index) => [field.id, `${layout}-${index}`]))
    for (const field of template.fields) await admin.query('INSERT INTO meta_fields(id,sheet_id,name,type,property) VALUES ($1,$2,$3,$4,$5::jsonb)',
      [fieldMap[field.id], sheetId, field.id, 'string', '{}'])
    deploymentConfig = {
      stockPreparationAutomationProfiles: [{ ...scope, projectId, actionId }],
      stockPreparationTableActions: [{ actionId, source: { externalSystemId: defaultSystem },
        target: { sheetId, objectId: template.objectId, fieldIdMap: fieldMap },
        maxRows: 70, maxPages: 3, maxReadCount: 75, maxElapsedMs: 20000, ...executionBounds }],
    }
    const prepared = prepare({ config: deploymentConfig })
    const registered = await tx(admin, trx => activateAutomationReadProfiles(trx, prepared, 120000))
    producer = registered.producer
    selector = { ruleId, actionId, systemId, targetId: registered.targets[0].targetId }
    authority = build()
    ledger = createAutomationReadLedger({ transaction, authority, manifest: fixtureManifest })
  }
  async function insertPointer(system = systemId) {
    await admin.query(`INSERT INTO integration_stock_prep_source_binding(id,tenant_id,workspace_id,action_id,external_system_id)
      VALUES ('synthetic-pointer',$1,NULL,$2,$3)`, [actor.tenantId, actionId, system])
  }
  async function newConnection(id: string) {
    await admin.query(`INSERT INTO data_sources(id,type,owner_id,tenant_id,workspace_id,scope_kind,is_active)
      VALUES ($1,'postgresql',$2,$3,NULL,'private',true)`, [id, actor.actorId, actor.tenantId])
  }

  async function executionFixture(sourceType = 'postgresql', budgetOverrides: Partial<ReadBudget> = {}, queue = true, sourceOperations: 1 | 2 = 1) {
    const databaseUrl = process.env.DATABASE_URL
    if (!databaseUrl) throw new Error('Owned synthetic PostgreSQL is required')
    const parsed = new URL(databaseUrl)
    const databaseName = parsed.pathname.slice(1)
    // Match the isolated local runner and the existing required CI PostgreSQL
    // test lane. Neither branch supplies a default or discovers a customer DB.
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost'].includes(parsed.hostname)
      || !['sa06a_synthetic', 'metasheet_test'].includes(databaseName) || !/^\d+$/u.test(parsed.port)) {
      throw new Error('Executable fixture requires an explicit loopback test database')
    }
    // Only the disposable runner credentials enter this owned database. Never
    // emit config or connection material in assertions, diagnostics or public DTOs.
    const driverConfig = {
      connection: { host: parsed.hostname, port: Number(parsed.port), database: databaseName },
      credentials: { username: decodeURIComponent(parsed.username), password: decodeURIComponent(parsed.password) },
      options: { readOnly: true, autoConnect: false },
      poolConfig: { min: 0, max: 1 },
    }
    await admin.query('UPDATE data_sources SET config=$2::jsonb,type=$3 WHERE id=$1', [connectionId, JSON.stringify(driverConfig), sourceType])
    await admin.query(`INSERT INTO syn_pathlink VALUES ('SYN-PROJECT','SYN-PATH');
      INSERT INTO syn_path VALUES ('SYN-PATH');
      INSERT INTO syn_order VALUES ('SYN-ORDER','SYN-PATH');
      INSERT INTO syn_orderline VALUES ('SYN-ORDER','SYN-PART',2);
      INSERT INTO syn_part VALUES ('SYN-PART')`)
    const executableConfig = config(systemId, schema + '.')
    const executablePlan = executableConfig.readPlan as Row
    executablePlan.maxReadCount = 200
    await sourceLifecycle(systemId, activation.generation, executableConfig)
    await tx(admin, trx => renewAutomationReadProducer(trx, producer, 1))
    await new Promise(resolve => setTimeout(resolve, 15))
    await installProfile('layout-a', systemId, { maxPages: 30, maxReadCount: 200, maxElapsedMs: 60000 })
    authority = build({ ...ceiling, maxPages: 40, maxReadCount: 200 })
    ledger = createAutomationReadLedger({ transaction, authority, manifest: fixtureManifest })
    const manager = new DataSourceManager({ db })
    executionManagers.add(manager)
    await manager.loadFromDatabase()
    const adapter = manager.getDataSource(connectionId)
    expect(adapter).toBeInstanceOf(PostgresAdapter)
    expect(manager.getLoadedValidationRevision(connectionId, adapter)).toBe((await admin.query(
      'SELECT validation_revision FROM data_sources WHERE id=$1', [connectionId])).rows[0].validation_revision)
    // Connect this task's native source pool once; execution still traverses the
    // guarded real adapter for every catalog and row query below.
    await manager.connectDataSource(connectionId)
    const native = (adapter as unknown as { pool: {
      query(statement: string, params?: unknown[]): Promise<PgQueryResult>
    } }).pool
    const nativeQuery = native.query.bind(native)
    const nativeStatements: string[] = []
    let nativeSucceeded = 0, nativeFailed = 0, nativeElapsedMs = 0
    let afterNative: (() => Promise<void>) | undefined
    const nativeSpy = vi.spyOn(native, 'query').mockImplementation(async (statement, params) => {
      nativeStatements.push(statement)
      let result: PgQueryResult
      const started = performance.now()
      try { result = await nativeQuery(statement, params); nativeSucceeded++ }
      catch (error) { nativeFailed++; throw error }
      finally { nativeElapsedMs += performance.now() - started }
      await afterNative?.()
      return result
    })
    const facade = createDataSourcePluginFacade(() => manager)
    const resolver = createConnectionResolver({ facade })
    let afterPluginQuery: ((stage: 'metadata' | 'claim-store') => Promise<void>) | undefined
    const database = { async query(statement: string, params?: unknown[]) {
      const result = await admin.query(statement, params)
      // Call-through receipt gate only: the actual owned PG result stays intact.
      if (/^\s*SELECT\b/iu.test(statement)) {
        if (statement.includes('integration_external_systems')) await afterPluginQuery?.('metadata')
        else if (statement.includes('plugin_kv')) await afterPluginQuery?.('claim-store')
      }
      return result
    },
      transaction: <T>(work: (trx: Queryable) => Promise<T>) => tx(admin, trx => work(trx)) }
    const scopedDb = createDb({ database })
    const externalSystems = createExternalSystemRegistry({ db: scopedDb,
      credentialStore: createCredentialStore({ logger: { warn() {} } }),
      dataSourceBinder: facade, connectionResolver: resolver })
    const adapterRegistry = createAdapterRegistry().registerAdapter('data-source:sql-readonly',
      createDataSourceSqlReadonlySourceAdapterFactory({ context: { api: { dataSources: facade } } }),
      { metadata: DATA_SOURCE_SQL_READONLY_ADAPTER_METADATA })
    const sourceObjects = ['SYN_PathLink', 'SYN_Path', 'SYN_Order', 'SYN_OrderLine', 'SYN_Part', 'SYN_Bom', 'SYN_BomLine']
      .map(table => schema + '.' + table.toLowerCase())
    const b2aTrialRegistry = createB2aRegistry({ config: { b2aTrialRegistry: {
      registryId: 'synthetic-automation-execution', registryVersion: 1,
      // Retry positive controls explicitly pre-authorize TWO independent source
      // operations. A new ledger budget never manufactures a B2a authorization.
      registrations: Array.from({ length: sourceOperations }, (_, operation) => ({ registrationId: 'synthetic-automation-preview' + (operation ? '-second' : ''), registrationVersion: 1,
        tenantScope: actor.tenantId, sourceSystemType: 'data-source:sql-readonly', sourceBindingRef: systemId,
        projectDataScope: { dataScopeRefs: ['SYN-PROJECT'] }, objectScope: { sourceObjects },
        purpose: 'stock-preparation.automation-preview', ownerPrincipalRef: 'synthetic-owner-reference',
        authorizationRef: 'synthetic-authorization-reference', operationRef: 'synthetic-operation-reference' + (operation ? '-second' : ''),
        effectiveAt: new Date(Date.now() - 60000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(),
        forbidReuse: true, sourceReadOperationLimit: 1, artifactReplayLimit: 0, consumptionState: 'unconsumed',
        consumedAt: null, b2bMigrationCondition: 'Synthetic integration fixture only', expiryHandling: 'deny_replay', status: 'active' })),
    } } })
    const b2aClaimStore = createPluginDurableStorage({ pluginName: 'plugin-integration-core', query: database.query })
    const actualClaim = createB2aOperationClaim({ db: scopedDb })
    const claimObservations: Array<{ held: boolean; claimed: boolean; holderSameRun: boolean }> = []
    const preview = createStockPreparationAutomationPreview({ externalSystems, adapterRegistry, b2aTrialRegistry,
      b2aClaimStore, b2aOperationClaim: { async claim(input: Row) {
        const result = await actualClaim.claim(input)
        claimObservations.push({ held: result.held, claimed: result.claimed, holderSameRun: result.holderRunId === input.runId })
        return result
      } } })
    let previewFailure: string | null = null
    let previewEntered = 0, previewReturned = 0, previewElapsedMs = 0
    let previewSignalAborted = false
    let checkpointCount = 0, checkpointReturned = 0, checkpointFailure: string | null = null
    let checkpointElapsedMs = 0, checkpointMaximumMs = 0, lastRemainingMs: number | null = null
    let metadataTransactionCount = 0, metadataQueryCount = 0, metadataQueryReturned = 0
    let metadataCommitted = 0, metadataRolledBack = 0, metadataOverflow = false
    const metadataTail: MetadataCheckpoint[] = [], metadataFailures: MetadataCheckpoint[] = []
    const actualCheckpoint = ledger.checkpoint.bind(ledger)
    const observedLedger: typeof ledger = { ...ledger, async checkpoint(input) {
      checkpointCount++
      const metadata: MetadataCheckpoint = { checkpoint: checkpointCount, elapsedMs: 0, outcome: 'pending', code: 'none',
        transactionCount: 0, transactions: [], dependencies: [], overflow: false }
      const started = performance.now()
      try {
        const result = await metadataCheckpoint.run(metadata, () => actualCheckpoint(input))
        metadata.outcome = 'returned'
        checkpointReturned++
        lastRemainingMs = result.remainingMs
        return result
      } catch (error) {
        // Observe the original receipt/error only. No extra query, lease renewal,
        // retry, authority replacement or raw driver diagnostics.
        checkpointFailure = error instanceof AutomationReadLedgerError || error instanceof AutomationActorAuthorityError
          ? error.code : 'UNCLASSIFIED_PRIVATE_FAILURE'
        metadata.outcome = 'rejected'; metadata.code = metadataErrorCode(error)
        throw error
      } finally {
        const elapsed = performance.now() - started
        metadata.elapsedMs = elapsed
        metadataTransactionCount += metadata.transactionCount
        for (const observed of metadata.transactions) {
          metadataQueryCount += observed.queryCount; metadataQueryReturned += observed.queryReturned
          metadataCommitted += observed.phases.filter(fact => fact.phase === 'commit' && fact.outcome === 'returned').length
          metadataRolledBack += observed.phases.filter(fact => fact.phase === 'rollback' && fact.outcome === 'returned').length
          metadataOverflow ||= observed.overflow
        }
        metadataOverflow ||= metadata.overflow
        if (metadata.outcome === 'rejected') {
          if (metadataFailures.length < 2) metadataFailures.push(metadata)
          else metadataOverflow = true
        } else {
          metadataTail.push(metadata)
          if (metadataTail.length > 2) metadataTail.shift()
        }
        checkpointElapsedMs += elapsed; checkpointMaximumMs = Math.max(checkpointMaximumMs, elapsed)
      }
    } }
    const observedPreview: typeof preview = async input => {
      previewEntered++
      const started = performance.now()
      try { const result = await preview(input); previewReturned++; return result }
      catch (error) {
        const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined
        previewFailure = [
          'AUTOMATION_READ_DENIED', 'AUTOMATION_READ_SCOPE_CHANGED', 'AUTOMATION_READ_BUDGET_EXHAUSTED',
          'AUTOMATION_READ_FENCE_LOST', 'AUTOMATION_READ_UNAVAILABLE',
          'AUTOMATION_PREVIEW_DENIED', 'AUTOMATION_PREVIEW_INPUT_INVALID', 'AUTOMATION_PREVIEW_UNAVAILABLE',
          'AUTOMATION_PREVIEW_ABORTED', 'AUTOMATION_PREVIEW_TIMEOUT', 'AUTOMATION_PREVIEW_BUDGET_EXCEEDED',
          'DATA_SOURCE_READ_EXECUTION_CLOSED', 'DATA_SOURCE_READ_EXECUTION_ABORTED',
          'DATA_SOURCE_READ_EXECUTION_ADAPTER_MISMATCH', 'DATA_SOURCE_READ_EXECUTION_NESTED',
          'DATA_SOURCE_READ_EXECUTION_OPERATION_UNSUPPORTED', 'DATA_SOURCE_READ_EXECUTION_CHECKPOINT_FAILED',
          'DATA_SOURCE_READ_EXECUTION_IO_FAILED',
        ].includes(code) ? code : 'UNCLASSIFIED_PRIVATE_FAILURE'
        throw error
      } finally { previewElapsedMs += performance.now() - started; previewSignalAborted = input.signal.aborted }
    }
    const executor = createAutomationReadExecutor({ ledger: observedLedger, authority, transaction,
      sourceExecution: createAutomationReadSourceExecution(() => manager), preview: observedPreview })
    let grantId = '', requestId = ''
    if (queue) {
      grantId = (await grant({ budget: { maxRows: 60, maxPages: 20, maxReadCount: 200, timeoutMs: 60000, ...budgetOverrides } })).grantId
      requestId = (await ledger.submit(actor, { grantId, invocationId: randomUUID(), projectNo: 'SYN-PROJECT', trigger: 'manual' })).requestId
    }
    return { executor, manager, preview: observedPreview, checkpoint: observedLedger.checkpoint,
      grantId, requestId, nativeStatements, claimObservations,
      diagnostic() { return { previewFailure, previewEntered, previewReturned, previewElapsedMs, previewSignalAborted,
        checkpointCount, checkpointReturned, checkpointFailure, checkpointElapsedMs, checkpointMaximumMs, lastRemainingMs,
        checkpointMetadata: { transactionCount: metadataTransactionCount, queryCount: metadataQueryCount,
          queryReturned: metadataQueryReturned, committed: metadataCommitted, rolledBack: metadataRolledBack,
          overflow: metadataOverflow, tail: metadataTail, failures: metadataFailures },
        nativeQueries: nativeStatements.length, nativeSucceeded, nativeFailed, nativeElapsedMs } },
      afterNative(callback?: () => Promise<void>) { afterNative = callback },
      afterPluginQuery(callback?: (stage: 'metadata' | 'claim-store') => Promise<void>) { afterPluginQuery = callback },
      async close() {
        await executor.drainPendingWork()
        nativeSpy.mockRestore()
        await manager.disconnectDataSource(connectionId)
        executionManagers.delete(manager)
      },
    }
  }

  async function runtimeFixture(queueInitial = true, sourceOperations: 1 | 2 = 1, observeStopOrder = false) {
    const fixture = await executionFixture('postgresql', {}, false, sourceOperations)
    await transaction(trx => deactivateAutomationReadProducer(trx, producer))
    const unavailable = vi.fn()
    let renewalLockConflicts = 0
    const scheduleObservations: Array<{ candidates: number; facts: Row[] }> = []
    let clockReference: number | undefined
    const clockReadiness: number[] = []
    const scheduleDenials: string[] = []
    const queryFailures: Array<{ stage: 'producer-renewal' | 'producer-read' | 'other'; code: string }> = []
    const executionObservations: Array<{ outcome: 'pending' | 'returned' | 'rejected';
      aborted: boolean; elapsedMs: number; status?: string; code?: string }> = []
    const executionDiagnostics: AutomationReadExecutionDiagnostic[] = []
    const scheduleSqlObservation = createAutomationReadScheduleObservation()
    const pendingRuntimeTransactions = new Set<Promise<unknown>>()
    let runtimeTransactionCount = 0, runtimeQueryCount = 0, runtimeQueryReturned = 0
    let runtimeCommitted = 0, runtimeRolledBack = 0, runtimeMetadataTableLocks = 0
    let runtimeTransactionOverflow = false, runtimeTailTruncated = false, runtimeQueryTailTruncated = false
    const runtimeTransactionTail: RuntimeMetadataTransaction[] = [], runtimeTransactionFailures: RuntimeMetadataTransaction[] = []
    let latestRejected: RuntimeMetadataTransaction | undefined, slowestCompleted: RuntimeMetadataTransaction | undefined
    const copyRuntimeTransaction = (record: RuntimeMetadataTransaction): RuntimeMetadataTransaction => ({
      ordinal: record.ordinal, outcome: record.outcome, code: record.code, elapsedMs: record.elapsedMs,
      queryCount: record.queryCount, queryReturned: record.queryReturned, overflow: record.overflow,
      queryTailTruncated: record.queryTailTruncated, metadataTableLocks: record.metadataTableLocks,
      phases: record.phases.map(fact => ({ ...fact })), queryTail: record.queryTail.map(fact => ({ ...fact })),
      queryFailures: record.queryFailures.map(fact => ({ ...fact })),
    })
    let observationOverflow = false
    const runtimeTransaction: typeof transaction = work => {
      const observation = scheduleSqlObservation.startTransaction()
      const metadata: RuntimeMetadataTransaction = { ordinal: ++runtimeTransactionCount, outcome: 'pending', code: 'none',
        elapsedMs: 0, queryCount: 0, queryReturned: 0, phases: [], queryTail: [], queryFailures: [], overflow: false,
        metadataTableLocks: 0 }
      const started = performance.now()
      const running = transaction(trx => work({ isTransaction: true, async query(sql, params) {
      try {
        const result = await trx.query(sql, params)
        observation.observe(sql, result)
        if (clockReference !== undefined && sql === 'SELECT extract(epoch FROM pg_catalog.clock_timestamp()) * 1000 AS now_ms') {
          // Observe only the unchanged real PG receipt; never substitute time.
          if (clockReadiness.length < 128) clockReadiness.push(clockReference - Number(result.rows[0]?.now_ms))
          else observationOverflow = true
        }
        if (sql.startsWith('SELECT a.id,a.cron_config,a.trigger_type,a.interval_anchor_ms,a.date_field_confirmation FROM integration_automation_read_schedule_activations a')) {
          // Observe the unchanged production result. Only after an empty result,
          // sample fixed booleans/relative milliseconds to distinguish temporal
          // refusal from changed scope; do not retry or change the occurrence.
          // This second statement is later evidence, not the original query's
          // predicate snapshot; races cannot be diagnosed from it alone.
          const facts = result.rows.length ? [] : (await trx.query(`SELECT
            $2::double precision-extract(epoch FROM pg_catalog.clock_timestamp())*1000 AS planned_minus_db_ms,
            $2::double precision-extract(epoch FROM a.activated_at)*1000 AS planned_minus_activation_ms,
            g.status='active' AS active, g.expires_at>pg_catalog.clock_timestamp() AS unexpired,
            g.used_executions<g.max_executions AS budget_available, r.enabled AS enabled,
            r.created_by=a.owner_id AS owner_matches,
            r.integration_authority_revision=a.rule_revision AS revision_matches,
            r.trigger_type='schedule.cron' AS cron, (r.conditions IS NULL OR r.conditions='null'::jsonb) AS unconditional,
            r.trigger_config=a.cron_config AS config_matches
            FROM integration_automation_read_schedule_activations a
            JOIN integration_automation_read_grants g ON g.id=a.grant_id
            JOIN automation_rules r ON r.id=a.rule_id WHERE a.rule_id=$1 LIMIT 2`,
          // This observation uses only rule/time; the production candidate query
          // also binds a third family argument, which is not part of this SQL.
          [params?.[0], params?.[1]])).rows
          if (scheduleObservations.length < 128) scheduleObservations.push({ candidates: result.rows.length, facts })
          else observationOverflow = true
        }
        return result
      }
      catch (error) {
        const rawCode = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined
        const code = ['55P03', '40001', '40P01', '23503', '23505', '23514', '57014', '25P02'].includes(rawCode) ? rawCode : 'unknown'
        const stage = sql.includes('WHERE slot_id = 1 FOR UPDATE NOWAIT') ? 'producer-renewal'
          : sql.includes('WHERE slot_id = 1 FOR SHARE') ? 'producer-read' : 'other'
        if (queryFailures.length < 128) queryFailures.push({ stage, code })
        else observationOverflow = true
        // Observe only PostgreSQL's real NOWAIT collision at the renewal lock;
        // do not swallow/rewrite the error or accept other unavailable causes.
        if (sql.includes('WHERE slot_id = 1 FOR UPDATE NOWAIT')
          && typeof error === 'object' && error !== null && 'code' in error && error.code === '55P03') renewalLockConflicts++
        throw error
      }
    } }), metadata).then(result => {
      // transaction() above has awaited the real PostgreSQL COMMIT already.
      metadata.outcome = 'returned'
      observation.finish(true)
      return result
    }).catch(error => {
      metadata.outcome = 'rejected'; metadata.code = metadataErrorCode(error)
      observation.finish(false, error)
      if (error instanceof AutomationReadLedgerError || error instanceof AutomationActorAuthorityError) {
        if (scheduleDenials.length < 128) scheduleDenials.push(error.code)
        else observationOverflow = true
      }
      throw error
    }).finally(() => {
      metadata.elapsedMs = performance.now() - started
      runtimeQueryCount += metadata.queryCount; runtimeQueryReturned += metadata.queryReturned
      runtimeCommitted += metadata.phases.filter(fact => fact.phase === 'commit' && fact.outcome === 'returned').length
      runtimeRolledBack += metadata.phases.filter(fact => fact.phase === 'rollback' && fact.outcome === 'returned').length
      runtimeMetadataTableLocks += metadata.metadataTableLocks ?? 0
      runtimeTransactionOverflow ||= metadata.overflow
      runtimeQueryTailTruncated ||= metadata.queryTailTruncated === true
      // Keep bounded settled snapshots in addition to the original first failures
      // and success tail. "Completed" includes both returned and rejected work.
      const completed = copyRuntimeTransaction(metadata)
      if (metadata.outcome === 'rejected') latestRejected = completed
      if (!slowestCompleted || completed.elapsedMs > slowestCompleted.elapsedMs) slowestCompleted = completed
      if (metadata.outcome === 'rejected') {
        if (runtimeTransactionFailures.length < 2) runtimeTransactionFailures.push(metadata)
        else runtimeTransactionOverflow = true
      } else {
        runtimeTransactionTail.push(metadata)
        if (runtimeTransactionTail.length > 2) { runtimeTransactionTail.shift(); runtimeTailTruncated = true }
      }
      pendingRuntimeTransactions.delete(running)
    })
      pendingRuntimeTransactions.add(running)
      return running
    }
    const runtime = createAutomationReadRuntime({ transaction: runtimeTransaction, manifest: CURRENT_ROUTING_MANIFEST,
      getManager: () => fixture.manager, enabled: () => true, onUnavailable: unavailable,
      onExecutionDiagnostic(diagnostic) {
        if (executionDiagnostics.length < 128) executionDiagnostics.push(diagnostic)
        else observationOverflow = true
      } })
    let stopOrderObservation: ReturnType<typeof observeRuntimeStopOrder> | undefined
    try {
      // The direct fixture executor was constructed and its initial producer
      // retirement completed above. Only this runtime's factory/drain/retirement are
      // observed; every execution function and SQL implementation stays intact.
      if (observeStopOrder) stopOrderObservation = observeRuntimeStopOrder()
      await runtime.createPluginCapability(deploymentConfig).activate({ prepareProfiles: prepare, codec,
        sourceStore: { lockActiveForAutomation: store.lockActiveForAutomation }, preview: fixture.preview })
      stopOrderObservation?.restoreFactory()
      const rows = (await admin.query(`SELECT target_id FROM automation_read_target_profiles
        WHERE tenant_id=$1 AND sheet_id=$2 AND action_id=$3 AND enabled=true`, [actor.tenantId, sheetId, actionId])).rows
      expect(rows).toHaveLength(1)
      const runtimeSelector = { ruleId, actionId, systemId, targetId: String(rows[0].target_id) }
      let grantId = '', request = { requestId: '' }
      if (queueInitial) {
        grantId = (await runtime.grant(actor, { selector: runtimeSelector,
          budget: { maxRows: 60, maxPages: 20, maxReadCount: 200, timeoutMs: 25000 },
          projects: ['SYN-PROJECT'], triggers: ['manual'], maxExecutions: 1, expiresAt: '2099-01-01T00:00:00.000Z' })).grantId
        request = await runtime.submit(actor, { grantId, invocationId: randomUUID(), projectNo: 'SYN-PROJECT', trigger: 'manual' })
      }
      const executeObserved: typeof runtime.execute = async (requestId, signal) => {
        const started = performance.now()
        const observed: (typeof executionObservations)[number] = { outcome: 'pending', aborted: signal.aborted, elapsedMs: 0 }
        if (executionObservations.length < 128) executionObservations.push(observed)
        else observationOverflow = true
        try {
          const result = await runtime.execute(requestId, signal)
          observed.outcome = 'returned'; observed.status = result.status
          return result
        } catch (error) {
          observed.outcome = 'rejected'
          const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined
          observed.code = ['AUTOMATION_READ_DENIED', 'AUTOMATION_READ_SCOPE_CHANGED', 'AUTOMATION_READ_BUDGET_EXHAUSTED',
            'AUTOMATION_READ_FENCE_LOST', 'AUTOMATION_READ_UNAVAILABLE', 'AUTOMATION_READ_RUNTIME_INACTIVE',
            'AUTOMATION_ACTOR_AUTHORITY_DENIED', 'AUTOMATION_ACTOR_AUTHORITY_UNAVAILABLE'].includes(code) ? code : 'unknown'
          throw error
        } finally { observed.aborted = signal.aborted; observed.elapsedMs = performance.now() - started }
      }
      const delivery = createAutomationReadDelivery({ transaction, execute: executeObserved })
      // Legacy handlers are intentionally unreachable for this single v4 route;
      // production read admission/outcome handling is never substituted.
      const unexpected = async (): Promise<void> => {
        throw new Error('Unexpected legacy event in private read fixture')
      }
      const legacy: DurableConsumerHandlers = {
        'approval-bridge': unexpected, 'approval-trigger': unexpected,
        'approval-projection': unexpected, 'approval-task-trigger': unexpected,
        'automation-record-trigger': unexpected, 'webhook-event-bridge': unexpected,
        'multitable-record-approval': unexpected, 'dingtalk-todo-mirror': unexpected,
      }
      const registry = buildConsumerAdapterRegistry(legacy, delivery)
      assertManifestCompleteness(registry)
      const runtimeDiagnostics = () => {
        const { previewFailure, previewEntered, previewReturned, previewElapsedMs, previewSignalAborted,
          nativeQueries, nativeSucceeded, nativeFailed, nativeElapsedMs } = fixture.diagnostic()
        return { runtimeTransactions: { transactionCount: runtimeTransactionCount, queryCount: runtimeQueryCount,
          queryReturned: runtimeQueryReturned, committed: runtimeCommitted, rolledBack: runtimeRolledBack,
          pending: pendingRuntimeTransactions.size,
          metadataTableLocks: runtimeMetadataTableLocks, producerRenewalLockConflicts: renewalLockConflicts,
          overflow: runtimeTransactionOverflow,
          tailTruncated: runtimeTailTruncated, queryTailTruncated: runtimeQueryTailTruncated,
          tail: runtimeTransactionTail.map(copyRuntimeTransaction), failures: runtimeTransactionFailures.map(copyRuntimeTransaction),
          latestRejected: latestRejected && copyRuntimeTransaction(latestRejected),
          slowestCompleted: slowestCompleted && copyRuntimeTransaction(slowestCompleted) },
        execution: executionObservations.map(observation => ({ ...observation })),
        executionDiagnostics: executionDiagnostics.map(diagnostic => ({ ...diagnostic })),
        observationOverflow, preview: { previewFailure, previewEntered, previewReturned, previewElapsedMs, previewSignalAborted,
          nativeQueries, nativeSucceeded, nativeFailed, nativeElapsedMs } }
      }
      return { ...fixture, runtime, executeObserved, registry, grantId, requestId: request.requestId, unavailable, selector: runtimeSelector,
        stopOrder: () => stopOrderObservation?.snapshot() ?? {
          factoryCalls: 0, executeUnchanged: false, events: [], overflow: false,
        },
        runtimeDiagnostics,
        executionDiagnostics: () => executionDiagnostics.map(diagnostic => ({ ...diagnostic })),
        async drainObservedTransactions() { await Promise.allSettled([...pendingRuntimeTransactions]) },
        observeClockAt(scheduledAtMs: number) { clockReference = scheduledAtMs },
        renewalLockConflicts: () => renewalLockConflicts,
        scheduleDiagnostics: () => ({ observations: scheduleObservations, denials: scheduleDenials,
          observationOverflow, sql: scheduleSqlObservation.snapshot(), queryFailures, clockReadiness: [...clockReadiness],
          unavailableCalls: unavailable.mock.calls.length, renewalLockConflicts,
          execution: executionObservations, preview: fixture.diagnostic(), runtime: runtimeDiagnostics() }),
        async snapshot() {
          return (await admin.query(`SELECT r.status,r.result,r.fence,g.used_executions,
            o.payload,o.event_type,o.event_id,o.manifest_version,c.status AS delivery_status
            FROM integration_automation_read_requests r JOIN integration_automation_read_grants g ON g.id=r.grant_id
            JOIN meta_automation_outbox o ON o.id=r.outbox_id
            JOIN meta_automation_outbox_consumer c ON c.outbox_id=o.id WHERE r.id=$1`, [request.requestId])).rows[0]
        },
        async redeliver() {
          await admin.query(`UPDATE meta_automation_outbox_consumer SET status='pending',lease_expires_at=NULL
            WHERE outbox_id=(SELECT outbox_id FROM integration_automation_read_requests WHERE id=$1)`, [request.requestId])
          return runDispatchTick(pool, registry, { batchSize: 1 })
        },
        async close() {
          try {
            await runtime.stop()
            // An unknown result can precede a cancelled metadata transaction's
            // settlement. Drain the actual observed Promises before test reset.
            while (pendingRuntimeTransactions.size) {
              await Promise.allSettled([...pendingRuntimeTransactions])
            }
            await fixture.close()
            expect(pendingRuntimeTransactions.size).toBe(0)
          } finally { stopOrderObservation?.restore() }
        },
      }
    } catch (error) {
      try { await runtime.stop(); await fixture.close() }
      finally { stopOrderObservation?.restore() }
      throw error
    }
  }

  async function ownerHttpFixture(automationService?: AutomationService, queueInitial = true, sourceOperations: 1 | 2 = 1,
    fwbConfirmation: boolean | string = false, recoverySheetId?: string) {
    const fixture = await runtimeFixture(queueInitial, sourceOperations)
    const management = createAutomationReadManagement({ transaction, manifest: CURRENT_ROUTING_MANIFEST })
    try {
      const http = await createAutomationReadHttpAcceptance({ pool, automationService,
        ...(recoverySheetId ? { recoverySheetId } : {}),
        ...(fwbConfirmation ? { fwbConfirmationSheetId: typeof fwbConfirmation === 'string' ? fwbConfirmation : sheetId } : {}), port: {
        options: fixture.runtime.options,
        grant: fixture.runtime.grant, submit: fixture.runtime.submit, activateRecord: fixture.runtime.activateRecord,
        activateSchedule: fixture.runtime.activateSchedule,
        retry: fixture.runtime.retry, retryContext: management.retryContext,
        grantDetail: management.grantDetail, listGrants: management.listGrants,
        listRequests: management.listRequests, observe: management.observe,
        cancel: management.cancel, revoke: management.revoke,
      } })
      return { ...fixture, management, http, token: http.token({ actorId: actor.actorId, tenantId: actor.tenantId }),
        async close() { await http.close(); await management.stop(); await fixture.close() } }
    } catch (error) { await management.stop(); await fixture.close(); throw error }
  }
  const ownerPath = '/api/integration/automation-read'
  const rulesPath = '/api/multitable/sheets/' + sheetId + '/automations'
  const responseData = (reply: { body: unknown }): Row => {
    expect(reply.body).toMatchObject({ ok: true })
    return (reply.body as { data: Row }).data
  }
  async function optionRule(id: string, owner = actor.actorId, selectedSheet = sheetId) {
    await admin.query(`INSERT INTO automation_rules(id,sheet_id,name,trigger_type,action_type,action_config,created_by)
      VALUES ($1,$2,'Synthetic option','record.created',$3,$4::jsonb,$5)`,
    [id, selectedSheet, AUTOMATION_READ_ACTION_TYPE, JSON.stringify(ruleConfig), owner])
  }
  async function authorizeRuleAuthoring() {
    await admin.query('INSERT INTO user_permissions VALUES ($1,$2)', [actor.actorId, 'workflow:create'])
    await admin.query('INSERT INTO spreadsheet_permissions VALUES ($1,$2,$3,$4)',
      [sheetId, 'user', actor.actorId, 'spreadsheet:write'])
  }

  beforeAll(async () => {
    if (!/^automation_authority_[a-f0-9]{16}$/u.test(schema)) throw new Error('Unowned schema')
    // CI runs this whole file without the local wrapper. Mint ephemeral material
    // before any real manager/JWT fixture; never inherit deployment credentials.
    for (const name of ['JWT_SECRET', 'ENCRYPTION_KEY', 'ENCRYPTION_SALT']) {
      fixtureEnvironment.set(name, process.env[name])
      process.env[name] = randomBytes(32).toString('hex')
    }
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8, options: '-c search_path=' + schema + ' -c statement_timeout=8000' })
    db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) })
    admin = await pool.connect()
    await admin.query('CREATE SCHEMA "' + schema + '"'); created = true
    const namespace = await ownedMaintenanceNamespace()
    createdNamespace = { namespaceOid: namespace.namespace_oid, ownerOid: namespace.owner_oid }
    // Exact prerequisite columns consumed by production guards, no synthetic
    // authority table or substituted authorization callback exists in this suite.
    await admin.query([
      `CREATE TABLE users(id text PRIMARY KEY,role text,permissions jsonb,is_active boolean,activation_status text,
        email text,username text,mobile text,name text,password_hash text,must_change_password boolean DEFAULT false,
        local_password_set boolean DEFAULT true,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now())`,
      'CREATE TABLE user_roles(user_id text,role_id text)', 'CREATE TABLE role_permissions(role_id text,permission_code text)',
      'CREATE TABLE user_permissions(user_id text,permission_code text)', 'CREATE TABLE user_orgs(user_id text,org_id text,is_active boolean)',
      'CREATE TABLE user_namespace_admissions(user_id text,namespace text,enabled boolean,source text,granted_by text,updated_by text,created_at timestamptz,updated_at timestamptz)',
      'CREATE TABLE user_session_revocations(user_id text PRIMARY KEY,revoked_after timestamptz,updated_at timestamptz,updated_by text,reason text)',
      'CREATE TABLE platform_member_group_members(user_id text,group_id uuid)',
      'CREATE TABLE spreadsheet_permissions(sheet_id text,subject_type text,subject_id text,perm_code text)',
      'CREATE TABLE field_permissions(sheet_id text,field_id text,subject_type text,subject_id text,visible boolean,read_only boolean)',
      'CREATE TABLE record_permissions(sheet_id text,record_id text,subject_type text,subject_id text,access_level text)',
      'CREATE TABLE meta_bases(id text PRIMARY KEY,deleted_at timestamptz)',
      'CREATE TABLE meta_sheets(id text PRIMARY KEY,base_id text REFERENCES meta_bases(id) ON DELETE SET NULL,deleted_at timestamptz,row_level_read_permissions_enabled boolean NOT NULL DEFAULT false)',
      'CREATE TABLE meta_fields(id text PRIMARY KEY,sheet_id text NOT NULL REFERENCES meta_sheets(id) ON DELETE CASCADE,name text NOT NULL,type text NOT NULL,property jsonb NOT NULL,"order" integer DEFAULT 0,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now())',
      "CREATE TABLE meta_records(id text PRIMARY KEY,sheet_id text,data jsonb NOT NULL DEFAULT '{}',version integer NOT NULL DEFAULT 1,created_at timestamptz,updated_at timestamptz,created_by text,modified_by text,locked boolean NOT NULL DEFAULT false,locked_by text)",
      'CREATE TABLE meta_record_revisions(id uuid PRIMARY KEY,sheet_id text,record_id text,version integer,action text,source text,actor_id text,changed_field_ids text[],patch jsonb,snapshot jsonb,batch_id text,created_at timestamptz DEFAULT now())',
      "CREATE TABLE automation_rules(id text PRIMARY KEY,sheet_id text NOT NULL,name text,trigger_type text NOT NULL,trigger_config jsonb DEFAULT '{}',action_type text NOT NULL,action_config jsonb DEFAULT '{}',enabled boolean DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),created_by text,conditions jsonb,actions jsonb,execution_mode text)",
      "CREATE TABLE data_sources(id text PRIMARY KEY,name text NOT NULL DEFAULT 'Synthetic PostgreSQL',config jsonb NOT NULL DEFAULT '{}',type text NOT NULL,owner_id text NOT NULL,tenant_id text,workspace_id text,scope_kind text NOT NULL,is_active boolean NOT NULL DEFAULT true,deleted_at timestamptz,auto_connect boolean NOT NULL DEFAULT false,status text DEFAULT 'disconnected',last_connected_at timestamptz,last_error text,updated_at timestamptz DEFAULT now())",
      "CREATE TABLE integration_external_systems(id text PRIMARY KEY,tenant_id text NOT NULL,workspace_id text,kind text NOT NULL,role text NOT NULL,status text NOT NULL,connection_id text,config jsonb NOT NULL DEFAULT '{}',credentials_encrypted text)",
      'CREATE TABLE plugin_kv(plugin text,key text,value jsonb,updated_at timestamptz,PRIMARY KEY(plugin,key))',
      'CREATE TABLE syn_pathlink(matchfield text,pathidfield text)',
      'CREATE TABLE syn_path(idfield text)',
      'CREATE TABLE syn_order(idfield text,pathidfield text)',
      'CREATE TABLE syn_orderline(orderidfield text,componentidfield text,quantityfield numeric)',
      'CREATE TABLE syn_part(idfield text)',
      'CREATE TABLE syn_bom(parentpartfield text,bomidfield text)',
      'CREATE TABLE syn_bomline(bomparentfield text,componentidfield text,quantityfield numeric)',
    ].join(';'))
    await createAutomationReadExecutionLogSchema(admin)
    for (const name of ['076_create_integration_stock_prep_pack_installs.sql', '079_create_integration_stock_prep_source_binding.sql',
      '089_create_integration_stock_prep_read_plan_versions.sql', '078_create_integration_b2a_operation_claim.sql']) await admin.query(readFileSync(path.resolve(__dirname, '../../migrations', name), 'utf8'))
    for (const migration of [addOutbox, addEventFires, addEventFireLease, addRegistry, addSourceRevisions, addValidation, addRuleRevision, addLedger,
      addPointerRevision, addProfiles, addMaterialEpochs, addSourceEpochs, addOwnerIndexes, addExecutionAudit, addRecordActivation, addScheduleActivation,
      addUpdatedRecordActivation, addRecordAfterImage, addRecordSchemaRevision, addRecordConditions, addIntervalSchedule, addLinkedRetry, addDateSchedule, addDateRetry]) await db.transaction().execute(migration)
    await isolateOwnedMaintenanceTables()
    reader = await pool.connect(); writer = await pool.connect(); observer = await pool.connect()
    const database = { query: (statement: string, params?: unknown[]) => admin.query(statement, params),
      transaction: <T>(work: (trx: Queryable) => Promise<T>) => tx(admin, trx => work(trx)) }
    store = createStockPreparationReadPlanStore({ db: createDb({ database }), now: () => Date.parse('2026-10-01T00:00:00.000Z'),
      idGenerator: () => 'synthetic-source-' + ++sequence })
  })
  afterAll(async () => {
    try {
      for (const client of [reader, writer, observer]) if (client) { await client.query('ROLLBACK').catch(() => {}); client.release() }
      if (admin) { await admin.query('ROLLBACK').catch(() => {}); if (created) await admin.query('DROP SCHEMA "' + schema + '" CASCADE'); admin.release() }
      if (db) await db.destroy(); else await pool?.end()
    } finally {
      for (const [name, value] of fixtureEnvironment) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
  afterEach(async () => {
    afterMetadataQuery = undefined
    vi.restoreAllMocks()
    for (const manager of executionManagers) await manager.disconnectDataSource(connectionId)
    executionManagers.clear()
  })
  beforeEach(async () => {
    for (const client of [admin, reader, writer, observer]) await client.query('ROLLBACK')
    if (fwbSchemaReady) {
      await admin.query('DELETE FROM meta_fwb_action_applied')
      await admin.query('DELETE FROM operation_audit_logs')
    }
    if (approvalSchemaReady) {
      // The approval fixture adds real FK children and continuation storage.
      // Reset only this owned schema, with production guards left enabled.
      for (const table of ['multitable_automation_approval_bridges', 'multitable_automation_suspensions',
        'multitable_automation_jobs', 'meta_automation_action_applied', 'meta_automation_outbound_intent',
        'approval_form_field_revisions', 'approval_delegations', 'approval_records', 'approval_assignments',
        'approval_reads', 'approval_comments', 'approval_metrics', 'approval_instances', 'approval_templates',
        'permissions', 'roles']) await admin.query('DELETE FROM ' + table)
    }
    const protectedTables = ['automation_read_material_epochs', 'automation_read_producer_slot', 'automation_read_target_profiles',
      'automation_read_target_bindings', 'integration_stock_prep_source_binding', 'integration_stock_prep_source_pointer_revisions',
      'integration_automation_read_executions', 'integration_automation_read_record_activations', 'integration_automation_read_schedule_activations',
      'integration_automation_read_retries', 'integration_automation_read_date_occurrences']
    // Only this schema's test superuser resets permanent histories. Every test
    // below executes with all production triggers reenabled.
    for (const table of protectedTables) await admin.query('ALTER TABLE ' + table + ' DISABLE TRIGGER USER')
    try {
      await observeResetTruncate(() => admin.query('TRUNCATE meta_bases,meta_sheets,meta_fields,meta_records,meta_record_revisions,plugin_multitable_object_registry,integration_stock_prep_pack_installs,'
        + 'users,user_roles,role_permissions,user_permissions,user_orgs,user_namespace_admissions,user_session_revocations,platform_member_group_members,spreadsheet_permissions,field_permissions,record_permissions,'
        + 'automation_rules,data_sources,integration_external_systems,integration_data_source_validation_revisions,'
        + sourceTables.join(',') + ',integration_stock_prep_read_plan_audit,integration_stock_prep_source_binding,integration_stock_prep_source_pointer_revisions,'
        + 'automation_read_material_epochs,automation_read_target_profiles,automation_read_target_bindings,integration_automation_read_requests,integration_automation_read_grants,'
        + 'integration_automation_read_record_activations,integration_automation_read_schedule_activations,integration_automation_read_retries,integration_automation_read_date_occurrences,integration_automation_read_executions,multitable_automation_executions,'
        + 'meta_automation_record_after_images,meta_automation_outbox_consumer,meta_automation_outbox,meta_automation_event_fires,plugin_kv,integration_b2a_operation_claim,'
        + 'syn_pathlink,syn_path,syn_order,syn_orderline,syn_part,syn_bom,syn_bomline'))
      await admin.query('UPDATE automation_read_producer_slot SET generation=0,nonce=NULL,expires_at=NULL')
    } finally { for (const table of protectedTables) await admin.query('ALTER TABLE ' + table + ' ENABLE TRIGGER USER') }
    sequence = 0; statements.length = 0; afterMetadataQuery = undefined
    await admin.query("INSERT INTO users(id,role,permissions,is_active,activation_status) VALUES ($1,'user','[]',true,'activated')", [actor.actorId])
    await admin.query("INSERT INTO user_roles VALUES ($1,'integration_admin')", [actor.actorId])
    await admin.query("INSERT INTO role_permissions VALUES ('integration_admin','integration:admin')")
    await admin.query('INSERT INTO user_orgs VALUES ($1,$2,true)', [actor.actorId, actor.tenantId])
    await admin.query("INSERT INTO user_namespace_admissions(user_id,namespace,enabled) VALUES ($1,'integration',true)", [actor.actorId])
    await admin.query("INSERT INTO user_permissions VALUES ($1,'multitable:read')", [actor.actorId])
    await admin.query('INSERT INTO meta_bases(id) VALUES ($1)', [baseId])
    await admin.query('INSERT INTO meta_sheets(id,base_id) VALUES ($1,$2)', [sheetId, baseId])
    await admin.query("INSERT INTO plugin_multitable_object_registry(sheet_id,project_id,object_id,plugin_name) VALUES ($1,$2,$3,'plugin-integration-core')",
      [sheetId, projectId, template.objectId])
    await admin.query(`INSERT INTO automation_rules(id,sheet_id,name,trigger_type,action_type,action_config,created_by,conditions,actions)
      VALUES ($1,$2,'Synthetic preview','record.created',$3,$4::jsonb,$5,'{"all":[]}',NULL)`,
    [ruleId, sheetId, AUTOMATION_READ_ACTION_TYPE, JSON.stringify(ruleConfig), actor.actorId])
    await newConnection(connectionId)
    await admin.query(`INSERT INTO integration_external_systems(id,tenant_id,workspace_id,kind,role,status,connection_id)
      VALUES ($1,$2,NULL,'data-source:sql-readonly','source','active',$3)`, [systemId, actor.tenantId, connectionId])
    await sourceLifecycle()
    await installProfile()
  })

  it('returns frozen real source identity, stable complete key, narrowed budget and exact rule policy without source/record IO', async () => {
    const queries: string[] = []
    const result = await tx(reader, trx => authority.lockExecution({ async query(statement, params) {
      queries.push(statement); return trx.query(statement, params)
    } }, actor, selector))
    expect(result).toMatchObject({ ...actor, key: expect.stringMatching(/^[a-f0-9]{64}$/u),
      budget: { maxRows: 70, maxPages: 3, maxReadCount: 60, timeoutMs: 20000 }, allowedTriggers: ['manual', 'record'],
      sourceReference: { connectionId, connectionIncarnation: expect.stringMatching(/^[a-f0-9-]{36}$/u) } })
    expect(result).toEqual(await capture())
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.sourceReference)).toBe(true)
    expect(Object.isFrozen(result.allowedTriggers)).toBe(true)
    expect(queries.some(statement => /\bmeta_records\b/u.test(statement))).toBe(false)
    expect(queries.some(statement => /\bSYN_(Path|Order|Part|Bom)/u.test(statement))).toBe(false)
    expect(queries.some(statement => /\b(INSERT|DELETE|UPDATE)\s+(INTO|FROM|[a-z_]+\s+SET)/iu.test(statement))).toBe(false)
  })
  it('material lookup accepts only the original proof minted by this actual authority instance', async () => {
    const proof = await capture()
    expect(Object.keys(proof).sort()).toEqual(['actorId', 'allowedTriggers', 'budget', 'key', 'sourceReference', 'tenantId', 'workspaceId'])
    const material = authority.materialFor(proof)
    expect(material.action).toMatchObject({ actionId, source: { externalSystemId: systemId, readPlan: config().readPlan } })
    const source = (await admin.query('SELECT validation_revision FROM data_sources WHERE id=$1', [connectionId])).rows[0]
    const binding = (await admin.query('SELECT validation_revision FROM integration_external_systems WHERE id=$1', [systemId])).rows[0]
    expect(material.sourceValidation).toEqual({ connectionId, connectionRevision: source.validation_revision,
      bindingRevision: binding.validation_revision })
    // This installation has all template fields and no extension pack ledger;
    // the full installed extension-property material is correctly empty.
    expect(material.installedFieldProperties).toEqual([])
    expect(material.target.targetContract.projection.fieldIds).toEqual(expect.arrayContaining([
      fieldMap.projectNo, fieldMap.active, fieldMap.notes,
    ]))
    expect(Object.hasOwn(material, 'extFieldMapping')).toBe(true)
    for (const value of [material, material.action, material.installedFieldProperties, material.sourceValidation]) expect(Object.isFrozen(value)).toBe(true)
    const other = build()
    const otherProof = await capture(selector, other)
    for (const counterfeit of [{ ...proof }, JSON.parse(JSON.stringify(proof)) as typeof proof, otherProof]) {
      expect(() => authority.materialFor(counterfeit)).toThrow(AutomationReadLedgerError)
    }
    expect(() => other.materialFor(proof)).toThrow(AutomationReadLedgerError)
    expect(other.materialFor(otherProof).sourceValidation).toEqual(material.sourceValidation)
  })
  // Conditional-record PREPARATION only: actual source/owner/target/field ACL and schema/rule proof.
  // The metadata cases do not read an after-image. The final helper-composition case below also uses
  // actual 138/139 storage; neither kind of case claims conditional automatic admission or REST origin.
  it('conditional preparation: reads extra person/user/link metadata through actual ACL without expanding the public proof', async () => {
    const extra = ['person', 'user', 'link'].map(type => ({ id: 'condition-' + type, type }))
    await prepareConditionalRule(extra)
    const queries: Array<{ sql: string; params?: unknown[] }> = []
    await tx(reader, async client => {
      const tracked: Queryable = { async query(sql, params) {
        queries.push({ sql, params })
        return client.query(sql, params)
      } }
      const ordinary = await authority.lockExecution(tracked, actor, selector)
      const prepared = await authority.lockRecordExecution(tracked, actor, selector)
      expect(prepared.key).not.toBe(ordinary.key)
      expect(Object.keys(prepared).sort()).toEqual(['actorId', 'allowedTriggers', 'budget', 'key', 'sourceReference', 'tenantId', 'workspaceId'])
      expect(Object.isFrozen(prepared)).toBe(true)
      const projection = authority.materialFor(prepared).target.targetContract.projection.fieldIds
      for (const { id } of extra) expect(projection).not.toContain(id)
      expect(queries.some(({ sql, params }) => sql.includes('AS property_json') && sql.includes('FROM meta_fields')
        && JSON.stringify(params?.[1]) === JSON.stringify(extra.map(field => field.id).sort()))).toBe(true)
      expect(queries.some(({ sql }) => sql.includes('field_permissions'))).toBe(true)
      const beforeInvalid = queries.length
      for (const proof of [ordinary, { ...prepared }, JSON.parse(JSON.stringify(prepared)) as typeof prepared]) {
        expect(await authority.evaluateRecordConditions(tracked, proof, {
          outboxId: 'synthetic-condition-outbox', eventId: 'synthetic-condition-event', eventType: 'multitable.record.created',
        })).toEqual({ kind: 'unreadable', reason: 'CONTEXT_INVALID' })
      }
      expect(await build().evaluateRecordConditions(tracked, prepared, {
        outboxId: 'synthetic-condition-outbox', eventId: 'synthetic-condition-event', eventType: 'multitable.record.created',
      })).toEqual({ kind: 'unreadable', reason: 'CONTEXT_INVALID' })
      expect(queries).toHaveLength(beforeInvalid)
    })
    expect(queries.some(({ sql }) => /\bmeta_records\b|\bmeta_automation_record_after_images\b/u.test(sql))).toBe(false)
    expect(await counts()).toEqual({ grants: 0, requests: 0, outbox: 0 })
    const revision = (await admin.query('SELECT integration_authority_revision FROM automation_rules WHERE id=$1', [ruleId])).rows[0].integration_authority_revision as string
    const current = await captureConditional()
    await ledger.activateRecord(actor, { activationKey: randomUUID(), expectedRuleRevision: revision,
      expectedRecordCondition: authority.recordConditionFor(current),
      selector, projectNo: 'SYN-PROJECT', budget: requestBudget, maxExecutions: 1, expiresAt: '2099-01-01T00:00:00.000Z' })
    expect(await counts()).toEqual({ grants: 1, requests: 0, outbox: 0 }) // Explicit current condition consent, no event yet.
  })
  it.each(['property-hidden', 'field-acl-deny'] as const)('conditional preparation: %s extra field refuses preparation while ordinary manual proof remains compatible', async mode => {
    const id = 'condition-person'
    await prepareConditionalRule([{ id, type: 'person' }])
    await expect(captureConditional()).resolves.toMatchObject({ key: expect.any(String) })
    if (mode === 'property-hidden') await admin.query('UPDATE meta_fields SET property=$2::jsonb WHERE id=$1', [id, '{"hidden":true}'])
    else await admin.query("INSERT INTO field_permissions VALUES ($1,$2,'user',$3,false,false)", [sheetId, id, actor.actorId])
    await refusal(captureConditional())
    const ordinary = await capture()
    expect(ordinary.allowedTriggers).toContain('manual')
    expect(authority.materialFor(ordinary).target.targetContract.projection.fieldIds).not.toContain(id)
    expect(await counts()).toEqual({ grants: 0, requests: 0, outbox: 0 })
  })
  it('conditional preparation: readOnly property and field ACL remain readable without granting writes', async () => {
    const id = 'condition-readonly-person'
    await prepareConditionalRule([{ id, type: 'person', property: { readOnly: true } }])
    await admin.query("INSERT INTO field_permissions VALUES ($1,$2,'user',$3,true,true)", [sheetId, id, actor.actorId])
    const prepared = await captureConditional()
    expect(prepared).toMatchObject({ actorId: actor.actorId, key: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    expect(authority.materialFor(prepared).target.targetContract.projection.fieldIds).not.toContain(id)
    expect((await admin.query('SELECT visible,read_only FROM field_permissions WHERE field_id=$1', [id])).rows)
      .toEqual([{ visible: true, read_only: true }])
    expect(await counts()).toEqual({ grants: 0, requests: 0, outbox: 0 })
  })
  it('conditional preparation: retains real Connection ownership and the complete target field ACL', async () => {
    await prepareConditionalRule([{ id: 'condition-person', type: 'person' }])
    await expect(captureConditional()).resolves.toMatchObject({ key: expect.any(String) })
    await admin.query("INSERT INTO field_permissions VALUES ($1,$2,'user',$3,false,false)", [sheetId, fieldMap.notes, actor.actorId])
    await refusal(captureConditional())
    await refusal(capture())
    await admin.query('DELETE FROM field_permissions WHERE sheet_id=$1 AND field_id=$2', [sheetId, fieldMap.notes])
    await expect(captureConditional()).resolves.toMatchObject({ key: expect.any(String) })
    // Mutate the source last: restoring its owner would not restore the old validation revision.
    await admin.query("UPDATE data_sources SET owner_id='foreign-owner' WHERE id=$1", [connectionId])
    await refusal(captureConditional())
    expect(await counts()).toEqual({ grants: 0, requests: 0, outbox: 0 })
  })
  it('conditional preparation: refuses original JSONB numeric rounding rather than compiling its decoded replacement', async () => {
    const id = 'condition-number'
    await prepareConditionalRule([{ id, type: 'number' }], {
      conjunction: 'AND', conditions: [{ fieldId: id, operator: 'equals', value: 0.1 }],
    })
    await expect(captureConditional()).resolves.toMatchObject({ key: expect.any(String) })
    // Preserve the original PG numeric lexeme; JSON.stringify of a JS number would weaken this probe.
    const raw = '{"conjunction":"AND","conditions":[{"fieldId":"condition-number","operator":"equals","value":1.0000000000000001}]}'
    await admin.query('UPDATE automation_rules SET conditions=$2::jsonb WHERE id=$1', [ruleId, raw])
    expect((await admin.query('SELECT conditions::text AS raw FROM automation_rules WHERE id=$1', [ruleId])).rows[0].raw)
      .toContain('1.0000000000000001')
    await refusal(captureConditional())
    await expect(capture()).resolves.toMatchObject({ allowedTriggers: ['manual', 'record'] })
    expect(await counts()).toEqual({ grants: 0, requests: 0, outbox: 0 })
  })
  it('conditional preparation: real rule and schema ABA invalidate the retained context and change the next key', async () => {
    const id = 'condition-person'
    await prepareConditionalRule([{ id, type: 'person' }])
    const event = { outboxId: 'synthetic-condition-outbox', eventId: 'synthetic-condition-event', eventType: 'multitable.record.created' as const }
    for (const kind of ['rule', 'schema'] as const) {
      const queries: string[] = []
      const previous = await tx(reader, async client => {
        const tracked: Queryable = { async query(sql, params) { queries.push(sql); return client.query(sql, params) } }
        const proof = await authority.lockRecordExecution(tracked, actor, selector)
        if (kind === 'rule') {
          await client.query("UPDATE automation_rules SET name='Synthetic changed' WHERE id=$1", [ruleId])
          await client.query("UPDATE automation_rules SET name='Synthetic preview' WHERE id=$1", [ruleId])
        } else {
          await client.query("UPDATE meta_fields SET name='Synthetic changed' WHERE id=$1", [id])
          await client.query('UPDATE meta_fields SET name=id WHERE id=$1', [id])
        }
        expect(await authority.evaluateRecordConditions(tracked, proof, event)).toEqual({ kind: 'unreadable',
          reason: kind === 'rule' ? 'RULE_CHANGED' : 'SCHEMA_CHANGED' })
        return proof
      })
      expect(queries.some(sql => sql.includes('meta_automation_record_after_images'))).toBe(false)
      expect((await captureConditional()).key).not.toBe(previous.key)
    }
    expect(await counts()).toEqual({ grants: 0, requests: 0, outbox: 0 })
  })
  it('conditional preparation: actual authority evaluates the committed private snapshot from the synthetic producer helpers', async () => {
    const fieldId = 'condition-person'
    await prepareConditionalRule([{ id: fieldId, type: 'person' }])
    const eventId = randomUUID(), recordId = 'synthetic-condition-record'
    const eventType = 'multitable.record.created' as const
    const payload = { sheetId, recordId, _eventId: eventId }
    // This is an owned synthetic helper producer, not RecordService/REST or a proof of DML origin.
    // The capture/enqueue/persist implementations and their same-transaction DB guards are real.
    const produced = await transaction(async trx => {
      const schemaToken = await captureAutomationRecordSchema(trx, sheetId, { AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true' })
      expect(schemaToken).toBeDefined()
      const event = await enqueueOutboxEvent(trx, { eventType, eventId, payload })
      await persistAutomationRecordAfterImage(trx, event, { sheetId, recordId, recordVersion: 1,
        schema: schemaToken, data: undefined, rawJson: JSON.stringify({ [fieldId]: ['synthetic-member'] }) })
      return event
    })
    const queries: string[] = []
    await tx(reader, async client => {
      const tracked: Queryable = { async query(sql, params) { queries.push(sql); return client.query(sql, params) } }
      const ordinary = await authority.lockExecution(tracked, actor, selector)
      const prepared = await authority.lockRecordExecution(tracked, actor, selector)
      expect(authority.materialFor(prepared).target.targetContract.projection.fieldIds).not.toContain(fieldId)
      expect(Object.keys(prepared).sort()).toEqual(['actorId', 'allowedTriggers', 'budget', 'key', 'sourceReference', 'tenantId', 'workspaceId'])
      const event = { outboxId: produced.outboxId, eventId, eventType }
      expect(await authority.evaluateRecordConditions(tracked, prepared, event)).toEqual({ kind: 'match' })
      const afterMatch = queries.length
      for (const proof of [ordinary, { ...prepared }]) {
        expect(await authority.evaluateRecordConditions(tracked, proof, event))
          .toEqual({ kind: 'unreadable', reason: 'CONTEXT_INVALID' })
      }
      expect(queries).toHaveLength(afterMatch)
    })
    expect(queries.some(sql => sql.includes('meta_automation_record_after_images') && sql.includes('AS identity_valid'))).toBe(true)
    expect(queries.some(sql => sql.includes('meta_automation_record_after_images') && sql.includes('p.projected=$3::jsonb AS exact'))).toBe(true)
    expect(queries.some(sql => /\bmeta_records\b|\bsyn_(?:path|order|part|bom)/iu.test(sql))).toBe(false)
    expect((await admin.query('SELECT event_type,event_id,payload FROM meta_automation_outbox')).rows)
      .toEqual([{ event_type: eventType, event_id: eventId, payload }])
    expect((await admin.query(`SELECT outbox_id,status,schema_revision,after_image
      FROM meta_automation_record_after_images`)).rows).toEqual([{ outbox_id: produced.outboxId,
      status: 'captured', schema_revision: expect.stringMatching(/^[a-f0-9-]{36}$/u),
      after_image: { [fieldId]: ['synthetic-member'] } }])
    expect(await counts()).toEqual({ grants: 0, requests: 0, outbox: 1 })
    expect((await admin.query('SELECT count(*)::int AS count FROM integration_automation_read_record_activations')).rows)
      .toEqual([{ count: 0 }])
  })
  it.each(['before-submit', 'before-claim', 'before-checkpoint', 'before-publish'] as const)('conditional automatic admission: actual condition-field read revocation refuses %s after a successful sibling', async stage => {
      const fieldId = 'condition-stage-person'
      await prepareConditionalRule([{ id: fieldId, type: 'person' }])
      const prepared = await captureConditional(), expectedRecordCondition = authority.recordConditionFor(prepared)
      expect(expectedRecordCondition).toMatchObject({ mode: 'saved_conditions', schemaRevision: expect.any(String), businessTimeZone: expect.any(String) })
      if (expectedRecordCondition.mode !== 'saved_conditions') throw new Error('SYNTHETIC_SAVED_CONDITION_DESCRIPTION_MISSING')
      expect(authority.materialFor(prepared).target.targetContract.projection.fieldIds).not.toContain(fieldId)
      const revision = String((await admin.query('SELECT integration_authority_revision FROM automation_rules WHERE id=$1', [ruleId])).rows[0].integration_authority_revision)
      const port = createAutomationReadLedger({ transaction, authority, manifest: CURRENT_ROUTING_MANIFEST })
      const pair = await port.activateRecord(actor, { activationKey: randomUUID(), expectedRuleRevision: revision,
        expectedRecordCondition, selector, projectNo: 'SYN-PROJECT', budget: requestBudget,
        expiresAt: '2099-01-01T00:00:00.000Z', maxExecutions: 3 })
      expect((await admin.query('SELECT condition_confirmation FROM integration_automation_read_record_activations WHERE id=$1', [pair.activationId])).rows)
        .toEqual([{ condition_confirmation: expectedRecordCondition }])
      const produceMatching = async () => {
        const eventId = randomUUID(), recordId = 'synthetic-condition-stage-' + eventId
        const event = await transaction(async trx => {
          const schemaToken = await captureAutomationRecordSchema(trx, sheetId, { AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true' })
          expect(schemaToken).toBeDefined()
          const event = await enqueueOutboxEvent(trx, { eventType: 'multitable.record.created', eventId,
            payload: { sheetId, recordId, _eventId: eventId } })
          await persistAutomationRecordAfterImage(trx, event, { sheetId, recordId, recordVersion: 1, schema: schemaToken,
            data: undefined, rawJson: JSON.stringify({ [fieldId]: ['synthetic-member'] }) })
          return event
        })
        expect((await admin.query('SELECT status,schema_revision,after_image FROM meta_automation_record_after_images WHERE outbox_id=$1', [event.outboxId])).rows)
          .toEqual([{ status: 'captured', schema_revision: expectedRecordCondition.schemaRevision,
            after_image: { [fieldId]: ['synthetic-member'] } }])
        const delivered = (await claimDueConsumers(admin, { consumerKeys: ['automation-record-trigger'], batchSize: 100, leaseMs: 60000 }))
          .find(row => row.outboxId === event.outboxId)
        if (!delivered) throw new Error('SYNTHETIC_CONDITION_DELIVERY_MISSING')
        return { outboxId: delivered.outboxId, eventId: delivered.eventId, fence: delivered.fence, attempts: delivered.attempts }
      }
      const positiveEvent = await produceMatching()
      const positive = await port.submitRecord(pair.activationId, positiveEvent, new AbortController().signal)
      if (!positive) throw new Error('SYNTHETIC_CONDITION_POSITIVE_REQUEST_MISSING')
      const positiveClaim = await port.claim(positive.requestId)
      if (!('fence' in positiveClaim) || typeof positiveClaim.fence !== 'string') throw new Error('SYNTHETIC_CONDITION_POSITIVE_FENCE_MISSING')
      expect(await port.checkpoint({ requestId: positive.requestId, fence: positiveClaim.fence })).toMatchObject({ actor, selector, projectNo: 'SYN-PROJECT' })
      expect(await port.complete({ requestId: positive.requestId, fence: positiveClaim.fence, result: preview }))
        .toEqual({ requestId: positive.requestId, status: 'succeeded' })
      await executionAudit(positive.requestId, ruleId, 'succeeded')
      await admin.query('DELETE FROM meta_automation_record_after_images WHERE outbox_id=$1', [positiveEvent.outboxId])
      expect(await port.submitRecord(pair.activationId, positiveEvent, new AbortController().signal))
        .toEqual({ requestId: positive.requestId, status: 'succeeded' })
      const event = await produceMatching()
      const negative = stage === 'before-submit' ? null : await port.submitRecord(pair.activationId, event, new AbortController().signal)
      if (stage !== 'before-submit' && !negative) throw new Error('SYNTHETIC_CONDITION_NEGATIVE_REQUEST_MISSING')
      const claim = negative && ['before-checkpoint', 'before-publish'].includes(stage) ? await port.claim(negative.requestId) : null
      const fence = claim && 'fence' in claim && typeof claim.fence === 'string' ? claim.fence : null
      if (stage === 'before-publish') {
        if (!fence || !negative) throw new Error('SYNTHETIC_CONDITION_NEGATIVE_FENCE_MISSING')
        await expect(port.checkpoint({ requestId: negative.requestId, fence })).resolves.toMatchObject({ actor, selector })
      }
      const before = await counts()
      await admin.query("INSERT INTO field_permissions VALUES ($1,$2,'user',$3,false,false)", [sheetId, fieldId, actor.actorId])
      // Only ACL changed: no rule revision/schema rotation can mask removal of the actual read gate.
      expect((await admin.query('SELECT integration_authority_revision FROM automation_rules WHERE id=$1', [ruleId])).rows[0].integration_authority_revision).toBe(revision)
      expect((await admin.query("SELECT revision FROM automation_read_material_epochs WHERE kind='sheet' AND scope=jsonb_build_object('id',$1::text)", [sheetId])).rows[0].revision)
        .toBe(expectedRecordCondition.schemaRevision)
      expect((await admin.query('SELECT visible FROM field_permissions WHERE sheet_id=$1 AND field_id=$2 AND subject_id=$3', [sheetId, fieldId, actor.actorId])).rows)
        .toEqual([{ visible: false }])
      await refusal(captureConditional(), 'AUTOMATION_READ_DENIED')
      // This extra field is not silently promoted into the ordinary/manual target projection.
      await expect(capture()).resolves.toMatchObject({ actorId: actor.actorId })
      if (stage === 'before-submit') await refusal(port.submitRecord(pair.activationId, event, new AbortController().signal), 'AUTOMATION_READ_DENIED')
      else if (stage === 'before-claim') await refusal(port.claim(negative!.requestId), 'AUTOMATION_READ_DENIED')
      else if (stage === 'before-checkpoint') await refusal(port.checkpoint({ requestId: negative!.requestId, fence: fence! }), 'AUTOMATION_READ_DENIED')
      else await refusal(port.complete({ requestId: negative!.requestId, fence: fence!, result: preview }), 'AUTOMATION_READ_DENIED')
      expect(await counts()).toEqual(before)
      expect((await admin.query('SELECT used_executions FROM integration_automation_read_grants WHERE id=$1', [pair.grantId])).rows)
        .toEqual([{ used_executions: stage === 'before-submit' || stage === 'before-claim' ? 1 : 2 }])
      if (negative) expect((await admin.query('SELECT status,result FROM integration_automation_read_requests WHERE id=$1', [negative.requestId])).rows)
        .toEqual([{ status: stage === 'before-claim' ? 'queued' : 'running', result: null }])
      expect(statements.some(sql => /\bsyn_(?:path|order|part|bom)/iu.test(sql))).toBe(false)
    })

  it.each(['schema-ABA', 'timezone', 'rule-ABA'] as const)('conditional automatic consent: stale %s rejects fresh binding while original-key recovery preserves its saved descriptor', async changed => {
      const fieldId = 'condition-confirm-person'
      await prepareConditionalRule([{ id: fieldId, type: 'person' }])
      const prepared = await captureConditional(), expectedRecordCondition = authority.recordConditionFor(prepared)
      if (expectedRecordCondition.mode !== 'saved_conditions') throw new Error('SYNTHETIC_SAVED_CONDITION_DESCRIPTION_MISSING')
      const expectedRuleRevision = String((await admin.query('SELECT integration_authority_revision FROM automation_rules WHERE id=$1', [ruleId])).rows[0].integration_authority_revision)
      const port = createAutomationReadLedger({ transaction, authority, manifest: CURRENT_ROUTING_MANIFEST })
      const original = { activationKey: randomUUID(), expectedRuleRevision, expectedRecordCondition, selector,
        projectNo: 'SYN-PROJECT', budget: requestBudget, maxExecutions: 2, expiresAt: '2099-01-01T00:00:00.000Z' }
      const pair = await port.activateRecord(actor, original)
      if (changed === 'schema-ABA') {
        await admin.query("UPDATE meta_fields SET name='Synthetic temporary condition name' WHERE id=$1", [fieldId])
        await admin.query('UPDATE meta_fields SET name=id WHERE id=$1', [fieldId])
      } else if (changed === 'rule-ABA') {
        await admin.query("UPDATE automation_rules SET name='Synthetic temporary rule name' WHERE id=$1", [ruleId])
        await admin.query("UPDATE automation_rules SET name='Synthetic preview' WHERE id=$1", [ruleId])
      }
      const confirmed = changed === 'timezone' ? { ...expectedRecordCondition,
        businessTimeZone: expectedRecordCondition.businessTimeZone === 'UTC' ? 'Asia/Tokyo' : 'UTC' } : expectedRecordCondition
      const before = await counts()
      await refusal(port.activateRecord(actor, { ...original, activationKey: randomUUID(), expectedRecordCondition: confirmed }), 'AUTOMATION_READ_SCOPE_CHANGED')
      expect(await counts()).toEqual(before)
      expect(await port.activateRecord(actor, original)).toEqual(pair)
      await refusal(port.activateRecord(actor, { ...original, expectedRecordCondition: changed === 'schema-ABA'
        ? authority.recordConditionFor(await captureConditional()) : changed === 'timezone' ? confirmed : expectedRecordCondition,
      expectedRuleRevision: changed === 'rule-ABA'
        ? String((await admin.query('SELECT integration_authority_revision FROM automation_rules WHERE id=$1', [ruleId])).rows[0].integration_authority_revision)
        : expectedRuleRevision }), 'AUTOMATION_READ_IDEMPOTENCY_CONFLICT')
      expect((await admin.query('SELECT condition_confirmation,rule_revision FROM integration_automation_read_record_activations WHERE id=$1', [pair.activationId])).rows)
        .toEqual([{ condition_confirmation: expectedRecordCondition, rule_revision: expectedRuleRevision }])
      expect((await admin.query('SELECT used_executions,status FROM integration_automation_read_grants WHERE id=$1', [pair.grantId])).rows)
        .toEqual([{ used_executions: 0, status: 'active' }])
      expect(await counts()).toEqual(before)
      expect(statements.some(sql => /\bsyn_(?:path|order|part|bom)/iu.test(sql))).toBe(false)
    })
  it.each(['layout-a', 'layout-b'])('runs real grant→submit→claim→complete→observe over %s', async layout => {
    if (layout !== 'layout-a') {
      await tx(admin, trx => renewAutomationReadProducer(trx, producer, 1)); await new Promise(resolve => setTimeout(resolve, 15))
      await installProfile(layout)
    }
    const run = await running()
    expect(await ledger.complete({ requestId: run.requestId, fence: run.fence, result: preview })).toEqual({ requestId: run.requestId, status: 'succeeded' })
    expect(await ledger.observe(actor, run.requestId)).toEqual({ requestId: run.requestId, status: 'succeeded', result: preview })
    const grantRow = (await admin.query('SELECT * FROM integration_automation_read_grants WHERE id=$1', [run.grantId])).rows[0]
    expect(grantRow.used_executions).toBe(1)
    expect(grantRow.source_reference).toEqual((await capture()).sourceReference)
    const events = (await admin.query('SELECT event_type,payload,manifest_version FROM meta_automation_outbox')).rows
    expect(events).toEqual([{ event_type: AUTOMATION_READ_EVENT, payload: { requestId: run.requestId }, manifest_version: fixtureManifest.version }])
    expect((await admin.query('SELECT consumer_key FROM meta_automation_outbox_consumer')).rows).toEqual([{ consumer_key: AUTOMATION_READ_CONSUMER }])
  })
  it.each([
    ['inactive actor', 'UPDATE users SET is_active=false'], ['tenant membership', 'DELETE FROM user_orgs'],
    ['integration admin', 'DELETE FROM role_permissions'], ['namespace admission', 'UPDATE user_namespace_admissions SET enabled=false'],
  ])('refuses the actual %s prerequisite with its precise actor error before grant persistence', async (_name, statement) => {
    await admin.query(statement)
    const error: unknown = await grant().then(() => undefined, caught => caught)
    expect(error).toBeInstanceOf(AutomationActorAuthorityError)
    expect(error).toMatchObject({ code: 'AUTOMATION_ACTOR_AUTHORITY_DENIED' })
    expect(error).not.toHaveProperty('cause')
    expect(error).not.toHaveProperty('details')
    expect(String(error)).not.toContain('synthetic-private-driver-detail')
    expect(await counts()).toEqual({ grants: 0, requests: 0, outbox: 0 })
  })
  it.each([
    ['target read', 'DELETE FROM user_permissions'], ['row-scoped read', 'UPDATE meta_sheets SET row_level_read_permissions_enabled=true'],
    ['base liveness', 'UPDATE meta_bases SET deleted_at=clock_timestamp()'], ['sheet liveness', 'UPDATE meta_sheets SET deleted_at=clock_timestamp()'],
    ['registry', "UPDATE plugin_multitable_object_registry SET plugin_name='foreign-plugin'"],
    ['profile', 'UPDATE automation_read_target_profiles SET enabled=false'], ['rule enabled', 'UPDATE automation_rules SET enabled=false'],
    ['rule owner', "UPDATE automation_rules SET created_by='foreign-owner'"], ['rule sheet', "UPDATE automation_rules SET sheet_id='foreign-sheet'"],
    ['source owner', "UPDATE data_sources SET owner_id='foreign-owner'"], ['source tenant', "UPDATE data_sources SET tenant_id='foreign-tenant'"],
    ['source private', "UPDATE data_sources SET scope_kind='shared'"], ['source live', 'UPDATE data_sources SET is_active=false'],
    ['binding active', "UPDATE integration_external_systems SET status='disabled'"],
    ['version approved', "UPDATE integration_stock_prep_read_plan_versions SET status='retired'"],
    ['receipt actor', "UPDATE integration_stock_prep_read_plan_validations SET actor='foreign-owner'"],
    ['activation', "UPDATE integration_stock_prep_read_plan_activation SET status='disabled'"],
  ])('refuses the actual %s authority boundary before grant persistence', async (_name, statement) => {
    await admin.query(statement)
    await refusal(grant())
    expect(await counts()).toEqual({ grants: 0, requests: 0, outbox: 0 })
  })
  it.each(['hidden', 'missing', 'direct-deny'])('cannot omit a required notes field when %s', async mode => {
    if (mode === 'hidden') await admin.query('UPDATE meta_fields SET property=$2::jsonb WHERE id=$1', [fieldMap.notes, '{"hidden":true}'])
    if (mode === 'missing') await admin.query('DELETE FROM meta_fields WHERE id=$1', [fieldMap.notes])
    if (mode === 'direct-deny') await admin.query("INSERT INTO field_permissions VALUES ($1,$2,'user',$3,false,false)", [sheetId, fieldMap.notes, actor.actorId])
    await refusal(grant())
    expect((await counts()).grants).toBe(0)
  })
  it.each(['action_type', 'action_config', 'actions', 'execution_mode', 'trigger_type'])('does not accept invalid rule policy %s', async column => {
    const updates: Record<string, string> = { action_type: "'notify'", action_config: "'{\"operation\":\"apply\",\"allowManual\":true}'::jsonb",
      actions: "'[{\"type\":\"send_webhook\",\"config\":{}}]'::jsonb", execution_mode: "'workflow_job_v1'", trigger_type: "'webhook.received'" }
    await admin.query('UPDATE automation_rules SET ' + column + '=' + updates[column])
    await refusal(grant(), 'AUTOMATION_READ_DENIED')
  })
  it('rejects schedule grant for record rule and manual when explicit allowManual is false', async () => {
    await refusal(grant({ triggers: ['schedule'] }), 'AUTOMATION_READ_DENIED')
    await admin.query('UPDATE automation_rules SET action_config=$1::jsonb', [JSON.stringify({ ...ruleConfig, allowManual: false })])
    await refusal(grant({ triggers: ['manual'] }), 'AUTOMATION_READ_DENIED')
    await expect(grant({ triggers: ['record'] })).resolves.toMatchObject({ grantId: expect.any(String) })
  })
  it('requires source/action selectors to agree with active plan, profile and exact default', async () => {
    await refusal(capture({ ...selector, actionId: 'foreign-action' }))
    await refusal(capture({ ...selector, systemId: 'foreign-system' }))
    await refusal(capture({ ...selector, targetId: randomUUID() }))
  })
  it('binds an explicit stricter host ceiling into authority key', async () => {
    const before = await capture(), after = await capture(selector, build({ ...ceiling, maxRows: 25 }))
    expect(after.budget.maxRows).toBe(25)
    expect(after.key).not.toBe(before.key)
    await refusal(grant({ budget: { ...requestBudget, maxReadCount: 61 } }), 'AUTOMATION_READ_DENIED')
  })
  it('rule raw row A→B→A never restores old key and old grant cannot submit', async () => {
    const before = await capture(), { grantId } = await grant()
    await admin.query("UPDATE automation_rules SET name='Changed'")
    await admin.query("UPDATE automation_rules SET name='Synthetic preview'")
    expect((await capture()).key).not.toBe(before.key)
    await refusal(ledger.submit(actor, { grantId, invocationId: randomUUID(), projectNo: 'SYN-PROJECT', trigger: 'manual' }), 'AUTOMATION_READ_SCOPE_CHANGED')
    expect((await counts()).outbox).toBe(0)
  })
  it.each(sourceTables)('actual source %s full-row A→B→A rotates the key with identical restored content', async table => {
    const before = await capture(), { grantId } = await grant()
    const column = table === 'integration_stock_prep_read_plan_validations' ? 'counts' : 'updated_by'
    const original = (await admin.query('SELECT to_jsonb(t)-\'automation_authority_revision\' AS content FROM ' + table + ' t')).rows[0].content as Row
    const old = original[column], changed = column === 'counts' ? { sampleCount: 3, readCount: 7, objectCount: 7 } : 'synthetic-different-editor'
    await admin.query('UPDATE ' + table + ' SET ' + column + '=$1' + (column === 'counts' ? '::jsonb' : ''), [column === 'counts' ? JSON.stringify(changed) : changed])
    await admin.query('UPDATE ' + table + ' SET ' + column + '=$1' + (column === 'counts' ? '::jsonb' : ''), [column === 'counts' ? JSON.stringify(old) : old])
    expect((await admin.query('SELECT to_jsonb(t)-\'automation_authority_revision\' AS content FROM ' + table + ' t')).rows[0].content).toEqual(original)
    expect((await capture()).key).not.toBe(before.key)
    await refusal(ledger.submit(actor, { grantId, invocationId: randomUUID(), projectNo: 'SYN-PROJECT', trigger: 'manual' }), 'AUTOMATION_READ_SCOPE_CHANGED')
  })
  it('079 never-bound→insert→delete retains a tombstone and invalidates old default-source grant', async () => {
    const before = await capture(), { grantId } = await grant()
    await insertPointer()
    await admin.query('DELETE FROM integration_stock_prep_source_binding')
    expect((await capture()).key).not.toBe(before.key)
    expect((await admin.query('SELECT binding_id,external_system_id,revision FROM integration_stock_prep_source_pointer_revisions')).rows)
      .toEqual([{ binding_id: null, external_system_id: null, revision: expect.any(String) }])
    await refusal(ledger.submit(actor, { grantId, invocationId: randomUUID(), projectNo: 'SYN-PROJECT', trigger: 'manual' }), 'AUTOMATION_READ_SCOPE_CHANGED')
  })
  it('explicit 079 override permits a live approved system different from the profile default; absence does not', async () => {
    const otherSystem = 'synthetic-other-system'
    await admin.query(`INSERT INTO integration_external_systems(id,tenant_id,workspace_id,kind,role,status,connection_id)
      VALUES ($1,$2,NULL,'data-source:sql-readonly','source','active',$3)`, [otherSystem, actor.tenantId, connectionId])
    await sourceLifecycle(otherSystem, activation.generation)
    const selected = { ...selector, systemId: otherSystem }
    await refusal(capture(selected), 'AUTOMATION_READ_DENIED')
    await insertPointer(otherSystem)
    expect((await capture(selected)).sourceReference.connectionId).toBe(connectionId)
    await admin.query('DELETE FROM integration_stock_prep_source_binding')
    await refusal(capture(selected), 'AUTOMATION_READ_DENIED')
  })
  it.each(['base', 'field', 'registry'])('target %s content ABA invalidates old key through actual material epoch', async part => {
    const before = await capture()
    if (part === 'base') {
      await admin.query('UPDATE meta_bases SET deleted_at=clock_timestamp()'); await admin.query('UPDATE meta_bases SET deleted_at=NULL')
    } else if (part === 'field') {
      await admin.query("UPDATE meta_fields SET name=name||'x'"); await admin.query('UPDATE meta_fields SET name=left(name,length(name)-1)')
    } else {
      await admin.query("UPDATE plugin_multitable_object_registry SET plugin_name='temporary'")
      await admin.query("UPDATE plugin_multitable_object_registry SET plugin_name='plugin-integration-core'")
    }
    expect((await capture()).key).not.toBe(before.key)
  })
  it('complete reauthorizes current rule before publishing any preview counts', async () => {
    const run = await running()
    await admin.query('UPDATE automation_rules SET enabled=false')
    await refusal(ledger.complete({ requestId: run.requestId, fence: run.fence, result: preview }))
    expect((await admin.query('SELECT status,result FROM integration_automation_read_requests WHERE id=$1', [run.requestId])).rows)
      .toEqual([{ status: 'running', result: null }])
  })
  it('observation ignores old rule/active-source state but rechecks the original current Connection owner', async () => {
    const run = await running()
    await ledger.complete({ requestId: run.requestId, fence: run.fence, result: preview })
    await admin.query('UPDATE automation_rules SET enabled=false')
    await admin.query("UPDATE integration_stock_prep_read_plan_activation SET status='disabled'")
    await newConnection('synthetic-replacement')
    await admin.query("UPDATE integration_external_systems SET connection_id='synthetic-replacement'")
    expect((await ledger.observe(actor, run.requestId)).result).toEqual(preview)
    await admin.query("UPDATE data_sources SET owner_id='foreign-owner' WHERE id=$1", [connectionId])
    await refusal(ledger.observe(actor, run.requestId), 'AUTOMATION_READ_DENIED')
  })
  it('observation tolerates ordinary source revision drift, never same-ID resurrection', async () => {
    const run = await queued()
    await admin.query("UPDATE data_sources SET config='{\"synthetic\":2}'")
    expect((await ledger.observe(actor, run.requestId)).status).toBe('queued')
    await admin.query('DELETE FROM data_sources WHERE id=$1', [connectionId]); await newConnection(connectionId)
    await refusal(ledger.observe(actor, run.requestId), 'AUTOMATION_READ_DENIED')
  })
  it('final producer check rejects expiry after the real final rule locking query', async () => {
    let delayed = false
    await reader.query('BEGIN ISOLATION LEVEL READ COMMITTED')
    try {
      const tracked: Queryable = { async query(statement, params) {
        const result = await reader.query(statement, params)
        if (!delayed && statement.includes('FROM automation_rules r')) {
          delayed = true
          // All previous actual gates already returned. Test-owned shortening
          // and pg_sleep happen on this same real handle, not a forged proof.
          await reader.query("UPDATE automation_read_producer_slot SET expires_at=clock_timestamp()+interval '1 millisecond'")
          await reader.query('SELECT pg_sleep(0.02)')
        }
        return result
      } }
      await refusal(authority.lockExecution(tracked, actor, selector))
      expect(delayed).toBe(true)
    } finally { await reader.query('ROLLBACK') }
  })
  it('requires real RC transactions, not an autocommit or repeatable-read handle', async () => {
    await refusal(authority.lockExecution(reader, actor, selector), 'AUTOMATION_READ_TRANSACTION_REQUIRED')
    await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    try { await refusal(authority.lockExecution(reader, actor, selector), 'AUTOMATION_READ_TRANSACTION_REQUIRED') }
    finally { await reader.query('ROLLBACK') }
  })

  it.each(['postgresql', 'postgres'])('executes genuine %s PLM preview once through current authority, canonical resolver, B2a and native adapter', async sourceType => {
    const fixture = await executionFixture(sourceType)
    try {
      const before = (await admin.query('SELECT id,data FROM meta_records ORDER BY id')).rows
      const result = await fixture.executor.execute(fixture.requestId, new AbortController().signal)
      process.stderr.write(`SA06AH_NATIVE_PREVIEW ${JSON.stringify({ sourceType, status: result.status, ...fixture.diagnostic() })}\n`)
      expect(result.status, JSON.stringify(fixture.diagnostic())).toBe('succeeded')
      const diagnostic = fixture.diagnostic(), metadata = diagnostic.checkpointMetadata
      expect(diagnostic.checkpointCount).toBeGreaterThan(0)
      expect(metadata.transactionCount).toBe(diagnostic.checkpointCount)
      expect(metadata.queryCount).toBeGreaterThan(diagnostic.checkpointCount)
      expect(metadata.queryReturned).toBe(metadata.queryCount)
      expect(metadata.committed).toBe(diagnostic.checkpointReturned)
      expect(metadata.rolledBack).toBe(0)
      expect(metadata.overflow).toBe(false)
      expect(metadata.failures).toEqual([])
      expect(metadata.tail.length).toBeGreaterThan(0)
      for (const checkpoint of metadata.tail) {
        expect(checkpoint.outcome).toBe('returned')
        expect(checkpoint.transactions).toHaveLength(1)
        expect(checkpoint.transactions[0].phases.map(fact => [fact.phase, fact.outcome]))
          .toEqual([['connect', 'returned'], ['begin', 'returned'], ['work', 'returned'], ['commit', 'returned']])
        expect(checkpoint.transactions[0].queryTail.length).toBeGreaterThan(0)
        expect(checkpoint.transactions[0].queryTail.every(fact => fact.phase === 'query' && fact.outcome === 'returned')).toBe(true)
      }
      expect(result).toEqual({ requestId: fixture.requestId, status: 'succeeded' })
      expect(await ledger.observe(actor, fixture.requestId)).toEqual({ requestId: fixture.requestId, status: 'succeeded',
        result: { status: 'ready', counts: { add: 1, update: 0, skip: 0, inactive: 0, manual_confirm: 0 }, canApply: false } })
      expect(fixture.nativeStatements.some(statement => statement.includes('information_schema.columns'))).toBe(true)
      expect(fixture.nativeStatements.some(statement => statement.includes('.syn_orderline'))).toBe(true)
      expect(fixture.nativeStatements.every(statement => /^\s*SELECT\b/iu.test(statement))).toBe(true)
      const reads = fixture.nativeStatements.length
      expect(reads).toBeGreaterThan(7)
      expect(await fixture.executor.execute(fixture.requestId, new AbortController().signal)).toEqual(result)
      expect(fixture.nativeStatements).toHaveLength(reads)
      expect((await admin.query('SELECT id,data FROM meta_records ORDER BY id')).rows).toEqual(before)
      expect((await admin.query('SELECT payload FROM meta_automation_outbox')).rows).toEqual([{ payload: { requestId: fixture.requestId } }])
      expect((await admin.query('SELECT used_executions FROM integration_automation_read_grants WHERE id=$1', [fixture.grantId])).rows)
        .toEqual([{ used_executions: 1 }])
      expect((await admin.query('SELECT run_id FROM integration_b2a_operation_claim')).rows)
        .toEqual([{ run_id: 'automation-read:' + fixture.requestId }])
      const keys = (await admin.query('SELECT key FROM plugin_kv')).rows.map(row => String(row.key))
      expect(keys.length).toBeGreaterThan(0)
      expect(keys.every(key => key.startsWith('integration:b2a:'))).toBe(true)
      expect(JSON.stringify(result)).not.toMatch(/counts|token|project|selector|sourceReference|authorityKey|connection|password/iu)
    } finally { await fixture.close() }
  }, 90000)

  it('metadata checkpoint lock diagnostic: real maintenance-mode contention refuses then releases the same fence without source IO', async () => {
    const fixture = await executionFixture('postgresql')
    let lockHeld = false
    try {
      const claim = await ledger.claim(fixture.requestId)
      expect(claim).toMatchObject({ status: 'running', fence: expect.any(String) })
      if (!('fence' in claim) || typeof claim.fence !== 'string') throw new Error('Expected real authority claim')
      const input = { requestId: fixture.requestId, fence: claim.fence }
      const initial = await fixture.checkpoint(input)
      expect(initial.remainingMs).toBeGreaterThan(0)
      expect(fixture.nativeStatements).toEqual([])

      await writer.query('BEGIN ISOLATION LEVEL READ COMMITTED')
      lockHeld = true
      // The second real transaction uses VACUUM's table-lock mode. This proves
      // the conflict mechanism, not which actor caused any historical failure.
      await writer.query('LOCK TABLE meta_fields IN SHARE UPDATE EXCLUSIVE MODE')
      await refusal(fixture.checkpoint(input), 'AUTOMATION_READ_UNAVAILABLE')
      const blocked = fixture.diagnostic(), failed = blocked.checkpointMetadata.failures
      expect(blocked.checkpointCount).toBe(2)
      expect(blocked.checkpointReturned).toBe(1)
      expect(blocked.checkpointFailure).toBe('AUTOMATION_READ_UNAVAILABLE')
      expect(failed).toHaveLength(1)
      expect(failed[0]).toMatchObject({ checkpoint: 2, outcome: 'rejected', code: 'AUTOMATION_READ_UNAVAILABLE',
        transactionCount: 1, overflow: false })
      expect(failed[0].transactions).toHaveLength(1)
      expect(failed[0].transactions[0].queryFailures).toEqual([expect.objectContaining({
        phase: 'query', sqlStage: 'metadata-table-lock', lock: 'table-nowait', outcome: 'rejected', code: '55P03',
      })])
      expect(failed[0].transactions[0].phases.map(fact => [fact.phase, fact.outcome]))
        .toEqual([['connect', 'returned'], ['begin', 'returned'], ['work', 'rejected'], ['rollback', 'returned']])
      expect(blocked.checkpointMetadata.committed).toBe(1)
      expect(blocked.checkpointMetadata.rolledBack).toBe(1)
      expect(blocked.checkpointMetadata.queryReturned).toBe(blocked.checkpointMetadata.queryCount - 1)
      expect(blocked.checkpointMetadata.overflow).toBe(false)
      expect(blocked.nativeQueries).toBe(0)
      expect(blocked.previewEntered).toBe(0)

      await writer.query('ROLLBACK')
      lockHeld = false
      // This is a distinct explicit checkpoint after releasing the lock, with
      // the original fence and budget. No retry policy or lease is changed.
      const released = await fixture.checkpoint(input)
      expect(released.remainingMs).toBeGreaterThan(0)
      expect(released.remainingMs).toBeLessThanOrEqual(initial.remainingMs)
      expect(released.budget).toEqual(initial.budget)
      const diagnostic = fixture.diagnostic(), metadata = diagnostic.checkpointMetadata
      process.stderr.write(`SA06AL_METADATA_LOCK_CONTROL ${JSON.stringify(diagnostic)}\n`)
      expect(diagnostic.checkpointCount).toBe(3)
      expect(diagnostic.checkpointReturned).toBe(2)
      expect(metadata.transactionCount).toBe(3)
      expect(metadata.committed).toBe(2)
      expect(metadata.rolledBack).toBe(1)
      expect(metadata.queryReturned).toBe(metadata.queryCount - 1)
      expect(metadata.tail.map(checkpoint => [checkpoint.checkpoint, checkpoint.outcome]))
        .toEqual([[1, 'returned'], [3, 'returned']])
      expect(metadata.failures).toHaveLength(1)
      expect(metadata.overflow).toBe(false)
      expect(fixture.nativeStatements).toEqual([])
      expect(fixture.claimObservations).toEqual([])
      expect((await admin.query('SELECT count(*)::int AS claims FROM integration_b2a_operation_claim')).rows)
        .toEqual([{ claims: 0 }])
      const reservation = (await admin.query(`SELECT r.status,r.fence,g.used_executions
        FROM integration_automation_read_requests r JOIN integration_automation_read_grants g ON g.id=r.grant_id
        WHERE r.id=$1`, [fixture.requestId])).rows[0]
      expect(reservation.status).toBe('running')
      expect(reservation.fence === input.fence).toBe(true)
      expect(reservation.used_executions).toBe(1)
    } finally {
      try { if (lockHeld) await writer.query('ROLLBACK') }
      finally { await fixture.close() }
    }
  }, 30000)

  it.each([1, 2] as const)('real owner HTTP linked retry: %i independent source operations keep one-time admission separate from new budget', async sourceOperations => {
    const fixture = await ownerHttpFixture(undefined, true, sourceOperations)
    const token = fixture.token
    let cancelled = false
    fixture.afterNative(async () => {
      const statement = fixture.nativeStatements.at(-1) ?? ''
      if (!cancelled && statement.includes('.syn_orderline')) {
        cancelled = true
        await fixture.management.cancel(actor, fixture.requestId)
      }
    })
    try {
      const businessBefore = (await admin.query('SELECT id,data FROM meta_records ORDER BY id')).rows
      expect(await fixture.runtime.execute(fixture.requestId, new AbortController().signal))
        .toEqual({ requestId: fixture.requestId, status: 'outcome_unknown' })
      expect(cancelled).toBe(true)
      const priorReads = fixture.nativeStatements.length
      // Pin the observed guarded native IO count after columns-only metadata,
      // rather than retaining the old broad full-schema-read lower bound.
      expect(priorReads).toBe(11)
      const parentBefore = (await admin.query('SELECT * FROM integration_automation_read_requests WHERE id=$1', [fixture.requestId])).rows[0]
      const parentGrantBefore = (await admin.query('SELECT * FROM integration_automation_read_grants WHERE id=$1', [fixture.grantId])).rows[0]
      const parentClaims = (await admin.query('SELECT * FROM integration_b2a_operation_claim')).rows
      expect(parentClaims).toHaveLength(1)
      const context = await fixture.http.request('GET', ownerPath + '/requests/' + fixture.requestId + '/retry-context', { token })
      expect(context.status).toBe(200)
      expect(responseData(context)).toMatchObject({ request: { requestId: fixture.requestId, status: 'outcome_unknown' },
        grant: { grantId: fixture.grantId, usedExecutions: 1 }, nextAttempt: null })
      const input = { retryKey: randomUUID(), budget: { maxRows: 60, maxPages: 20, maxReadCount: 200, timeoutMs: 25000 },
        expiresAt: '2099-01-01T00:00:00.000Z', acknowledgeNewRead: true }
      const path = ownerPath + '/requests/' + fixture.requestId + '/retry'
      const reply = await fixture.http.request('POST', path, { token, body: input })
      expect(reply.status).toBe(202)
      const child = responseData(reply)
      expect(child).toEqual({ parentRequestId: fixture.requestId, requestId: expect.any(String), grantId: expect.any(String), status: 'queued' })
      expect(child.requestId).not.toBe(fixture.requestId)
      expect(child.grantId).not.toBe(fixture.grantId)
      expect(fixture.nativeStatements).toHaveLength(priorReads)
      expect(responseData(await fixture.http.request('POST', path, { token, body: input }))).toEqual(child)
      expect((await fixture.http.request('POST', path, { token, body: { ...input, retryKey: randomUUID() } })).status).toBe(409)
      const childResult = await fixture.runtime.execute(String(child.requestId), new AbortController().signal)
      const expectedStatus = sourceOperations === 2 ? 'succeeded' : 'outcome_unknown'
      expect(childResult, JSON.stringify({ ...fixture.diagnostic(), claims: fixture.claimObservations }))
        .toEqual({ requestId: child.requestId, status: expectedStatus })
      const afterReads = fixture.nativeStatements.length
      expect(afterReads - priorReads).toBe(sourceOperations === 2 ? 20 : 0)
      expect(fixture.claimObservations).toContainEqual({ held: false, claimed: false, holderSameRun: false })
      const claims = (await admin.query('SELECT * FROM integration_b2a_operation_claim')).rows
      expect(claims).toHaveLength(sourceOperations)
      expect(claims).toContainEqual(parentClaims[0])
      expect(new Set(claims.map(row => row.run_id)).size).toBe(sourceOperations)
      expect(new Set(claims.map(row => row.registration_id)).size).toBe(sourceOperations)
      expect(responseData(await fixture.http.request('POST', path, { token, body: input })))
        .toEqual({ ...child, status: expectedStatus })
      expect(await fixture.runtime.execute(String(child.requestId), new AbortController().signal))
        .toEqual({ requestId: child.requestId, status: expectedStatus })
      expect(fixture.nativeStatements).toHaveLength(afterReads)
      expect((await admin.query('SELECT * FROM integration_b2a_operation_claim ORDER BY claim_key')).rows)
        .toEqual([...claims].sort((a, b) => String(a.claim_key).localeCompare(String(b.claim_key))))
      expect((await admin.query('SELECT * FROM integration_automation_read_requests WHERE id=$1', [fixture.requestId])).rows[0]).toEqual(parentBefore)
      expect((await admin.query('SELECT * FROM integration_automation_read_grants WHERE id=$1', [fixture.grantId])).rows[0]).toEqual(parentGrantBefore)
      expect((await admin.query('SELECT used_executions FROM integration_automation_read_grants ORDER BY created_at')).rows)
        .toEqual([{ used_executions: 1 }, { used_executions: 1 }])
      expect((await admin.query('SELECT request_id,grant_id,parent_request_id FROM integration_automation_read_retries')).rows)
        .toEqual([{ request_id: child.requestId, grant_id: child.grantId, parent_request_id: fixture.requestId }])
      expect((await admin.query('SELECT count(*)::int AS count FROM integration_automation_read_executions')).rows).toEqual([{ count: 2 }])
      expect((await admin.query('SELECT rerun_of_execution_id FROM multitable_automation_executions')).rows)
        .toEqual([{ rerun_of_execution_id: null }, { rerun_of_execution_id: null }])
      expect((await admin.query('SELECT id,data FROM meta_records ORDER BY id')).rows).toEqual(businessBefore)
      await fixture.runtime.stop()
      const stopped = await fixture.http.request('GET', ownerPath + '/requests/' + fixture.requestId + '/retry-context', { token })
      expect(stopped.status).toBe(200)
      expect(responseData(stopped).nextAttempt).toEqual({ requestId: child.requestId, grantId: child.grantId })
      expect((await fixture.http.request('POST', path, { token, body: input })).status).toBe(503)
      expect(fixture.nativeStatements).toHaveLength(afterReads)
    } finally { await fixture.close() }
  }, 90000)

  it('synthetic post-schema drift after a successful native row read leaves unknown without publishing or rereading', async () => {
    // Deliberate owned-fixture fault simulation, NOT a reproduction or diagnosis
    // of the historical unavailable preview. No receipt, guard or clock is replaced.
    const fixture = await executionFixture()
    const adapter = fixture.manager.getDataSource(connectionId)
    if (!(adapter instanceof PostgresAdapter)) throw new Error('Synthetic native adapter is required')
    const actualGetColumns = adapter.getColumns.bind(adapter)
    let alterationAttempted = false, altered = false, hookCalls = 0, nativeAtAlteration = 0
    const partSchemaObservations: boolean[] = []
    const postSchemaObjects = new Set<string>()
    const schemaSpy = vi.spyOn(adapter, 'getColumns').mockImplementation(async (table, selectedSchema) => {
      const result = await actualGetColumns(table, selectedSchema)
      if (selectedSchema === schema) {
        if (table === 'syn_part') partSchemaObservations.push(result.some(column => column.name === 'synthetic_post_schema_probe'))
        if (altered) postSchemaObjects.add(table)
      }
      return result
    })
    fixture.afterNative(async () => {
      const statement = fixture.nativeStatements[fixture.nativeStatements.length - 1]
      if (alterationAttempted || !/^\s*SELECT\b/iu.test(statement) || !statement.includes('.syn_orderline')) return
      // This hook runs only after the genuine native query has returned. The
      // pre-read schema is already pinned; only the later source-schema check
      // sees this new nullable column. Canonical authorization metadata is untouched.
      alterationAttempted = true; hookCalls++
      nativeAtAlteration = fixture.nativeStatements.length
      await admin.query('ALTER TABLE syn_part ADD COLUMN synthetic_post_schema_probe text NULL')
      altered = true
    })
    try {
      const before = (await admin.query('SELECT id,data FROM meta_records ORDER BY id')).rows
      const authorityBefore = await capture()
      const result = await fixture.executor.execute(fixture.requestId, new AbortController().signal)
      const diagnostic = fixture.diagnostic()
      expect(hookCalls).toBe(1)
      expect(altered).toBe(true)
      expect(partSchemaObservations).toEqual([false, true])
      expect(postSchemaObjects.size).toBe(7)
      expect(diagnostic.nativeQueries).toBeGreaterThan(nativeAtAlteration)
      expect(diagnostic).toMatchObject({ previewFailure: 'AUTOMATION_PREVIEW_UNAVAILABLE', previewEntered: 1,
        previewReturned: 0, checkpointFailure: null, nativeSucceeded: diagnostic.nativeQueries, nativeFailed: 0 })
      expect(diagnostic.checkpointCount).toBeGreaterThan(0)
      expect(diagnostic.checkpointReturned).toBe(diagnostic.checkpointCount)
      expect(diagnostic.lastRemainingMs).toBeGreaterThan(0)
      expect((await capture()).key).toBe(authorityBefore.key)
      expect(result).toEqual({ requestId: fixture.requestId, status: 'outcome_unknown' })
      expect(await ledger.observe(actor, fixture.requestId)).toEqual({ ...result, result: null })
      expect((await admin.query('SELECT status,result FROM integration_automation_read_requests WHERE id=$1', [fixture.requestId])).rows)
        .toEqual([{ status: 'outcome_unknown', result: null }])
      expect((await admin.query('SELECT used_executions FROM integration_automation_read_grants WHERE id=$1', [fixture.grantId])).rows)
        .toEqual([{ used_executions: 1 }])
      expect((await admin.query('SELECT id,data FROM meta_records ORDER BY id')).rows).toEqual(before)
      expect((await admin.query('SELECT payload FROM meta_automation_outbox')).rows).toEqual([{ payload: { requestId: fixture.requestId } }])
      expect(fixture.nativeStatements.every(statement => /^\s*SELECT\b/iu.test(statement))).toBe(true)
      const reads = fixture.nativeStatements.length
      expect(await fixture.executor.execute(fixture.requestId, new AbortController().signal)).toEqual(result)
      expect(fixture.nativeStatements).toHaveLength(reads)
      expect(hookCalls).toBe(1)
    } finally {
      schemaSpy.mockRestore()
      try { await fixture.close() }
      finally {
        // This suite reuses its owned schema and truncates rows between cases.
        if (alterationAttempted) await admin.query('ALTER TABLE syn_part DROP COLUMN IF EXISTS synthetic_post_schema_probe')
      }
    }
  }, 90000)

  it('the granted native query budget stops within one schema detail call before a second PostgreSQL query', async () => {
    const fixture = await executionFixture('postgresql', { maxReadCount: 1 })
    try {
      expect(await fixture.executor.execute(fixture.requestId, new AbortController().signal))
        .toEqual({ requestId: fixture.requestId, status: 'outcome_unknown' })
      expect(fixture.nativeStatements).toHaveLength(1)
      expect(fixture.nativeStatements[0]).toContain('information_schema.columns')
      expect((await admin.query('SELECT status,result FROM integration_automation_read_requests WHERE id=$1', [fixture.requestId])).rows)
        .toEqual([{ status: 'outcome_unknown', result: null }])
      expect((await admin.query('SELECT id FROM meta_records')).rows).toEqual([])
    } finally { await fixture.close() }
  }, 30000)

  it.each(['revoke', 'rule-aba'] as const)('actual %s after the first native schema query stops further IO and leaves unknown', async mode => {
    const fixture = await executionFixture()
    let changed = false
    fixture.afterNative(async () => {
      if (changed) return
      changed = true
      if (mode === 'revoke') await ledger.revoke(actor, fixture.grantId)
      else {
        await admin.query("UPDATE automation_rules SET name='Temporary execution edit' WHERE id=$1", [ruleId])
        await admin.query("UPDATE automation_rules SET name='Synthetic preview' WHERE id=$1", [ruleId])
      }
    })
    try {
      expect(await fixture.executor.execute(fixture.requestId, new AbortController().signal))
        .toEqual({ requestId: fixture.requestId, status: 'outcome_unknown' })
      expect(changed).toBe(true)
      expect(fixture.nativeStatements).toHaveLength(1)
      expect(fixture.nativeStatements[0]).toContain('information_schema.columns')
      expect((await admin.query('SELECT status,result FROM integration_automation_read_requests WHERE id=$1', [fixture.requestId])).rows)
        .toEqual([{ status: 'outcome_unknown', result: null }])
      expect((await admin.query('SELECT id FROM meta_records')).rows).toEqual([])
      expect((await admin.query('SELECT used_executions FROM integration_automation_read_grants WHERE id=$1', [fixture.grantId])).rows)
        .toEqual([{ used_executions: 1 }])
    } finally { await fixture.close() }
  }, 30000)

  it('current DB authorization cannot adopt an adapter loaded with an older validation revision', async () => {
    const fixture = await executionFixture()
    try {
      await admin.query(`UPDATE data_sources SET config=jsonb_set(config,'{options,syntheticRotation}','true'::jsonb) WHERE id=$1`, [connectionId])
      const refreshed = config(systemId, schema + '.')
      const refreshedPlan = refreshed.readPlan as Row
      refreshedPlan.maxReadCount = 199
      await sourceLifecycle(systemId, activation.generation, refreshed)
      const { grantId } = await grant({ budget: { maxRows: 60, maxPages: 20, maxReadCount: 199, timeoutMs: 60000 } })
      const request = await ledger.submit(actor, { grantId, invocationId: randomUUID(), projectNo: 'SYN-PROJECT', trigger: 'manual' })
      expect(await fixture.executor.execute(request.requestId, new AbortController().signal))
        .toEqual({ requestId: request.requestId, status: 'outcome_unknown' })
      expect(fixture.nativeStatements).toEqual([])
      expect((await admin.query('SELECT status,result FROM integration_automation_read_requests WHERE id=$1', [request.requestId])).rows)
        .toEqual([{ status: 'outcome_unknown', result: null }])
      expect((await admin.query('SELECT run_id FROM integration_b2a_operation_claim')).rows).toEqual([])
    } finally { await fixture.close() }
  }, 30000)

  it.each(['parent-abort', 'deadline'] as const)('%s fences a non-cooperative native completion and discards its late result without rereading', async mode => {
    // The approved synthetic window must allow the real authorization graph to
    // reach SQL before the held native completion expires. This still waits for
    // the actual finite deadline; no clock, checkpoint or expiry is bypassed.
    const fixture = await executionFixture('postgresql', mode === 'deadline' ? { timeoutMs: 10000 } : {})
    let nativeEntered = false
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    let lateFinished!: () => void
    const finished = new Promise<void>(resolve => { lateFinished = resolve })
    fixture.afterNative(async () => { nativeEntered = true; entered(); await held; lateFinished() })
    const controller = new AbortController()
    const executing = fixture.executor.execute(fixture.requestId, controller.signal)
    // A normal early unknown is still terminal; it must not strand the fixture
    // waiting for a native hook that will never run. Do not pretend zero IO
    // proved late-native cancellation: the explicit assertion below stays red.
    void executing.then(() => entered(), () => entered())
    try {
      await started
      expect(nativeEntered, 'SYNTHETIC_NATIVE_START_' + JSON.stringify(fixture.diagnostic())).toBe(true)
      if (mode === 'parent-abort') controller.abort()
      expect(await executing).toEqual({ requestId: fixture.requestId, status: 'outcome_unknown' })
      expect(fixture.nativeStatements).toHaveLength(1)
      release()
      await finished
      // The actual pg query completed before this test held its returned promise.
      // Holding completion models a non-cooperative driver, not an alternate SQL
      // reader or a production cancellation guarantee.
      await new Promise(resolve => setTimeout(resolve, 20))
      expect((await admin.query('SELECT status,result FROM integration_automation_read_requests WHERE id=$1', [fixture.requestId])).rows)
        .toEqual([{ status: 'outcome_unknown', result: null }])
      expect(await fixture.executor.execute(fixture.requestId, new AbortController().signal))
        .toEqual({ requestId: fixture.requestId, status: 'outcome_unknown' })
      expect(fixture.nativeStatements).toHaveLength(1)
      expect((await admin.query('SELECT id FROM meta_records')).rows).toEqual([])
    } finally { release(); await Promise.allSettled([executing]); await fixture.close() }
  }, 30000)

  it('actual runtime activation → owner grant/submit → v4 registry → dispatcher → native PG preview reaches one durable ready result', async () => {
    const fixture = await runtimeFixture()
    try {
      const before = (await admin.query('SELECT id,data FROM meta_records ORDER BY id')).rows
      const outcome = await runDispatchTick(pool, fixture.registry, { batchSize: 1, adapterTimeoutMs: 30000 })
      expect(outcome).toMatchObject({ completed: 1, rescheduled: 0, poisoned: 0 })
      expect(await fixture.snapshot()).toMatchObject({ status: 'succeeded', used_executions: 1, delivery_status: 'done',
        result: { status: 'ready', counts: { add: 1, update: 0, skip: 0, inactive: 0, manual_confirm: 0 }, canApply: false },
        payload: { requestId: fixture.requestId }, event_type: AUTOMATION_READ_EVENT,
        event_id: `integration-read:${fixture.requestId}`, manifest_version: 4 })
      expect(fixture.nativeStatements.some(statement => statement.includes('.syn_orderline'))).toBe(true)
      expect(fixture.nativeStatements.every(statement => /^\s*SELECT\b/iu.test(statement))).toBe(true)
      const reads = fixture.nativeStatements.length
      expect(reads).toBeGreaterThan(7)
      expect(await fixture.redeliver()).toMatchObject({ completed: 1 })
      expect(fixture.nativeStatements).toHaveLength(reads)
      expect((await admin.query('SELECT id,data FROM meta_records ORDER BY id')).rows).toEqual(before)
      expect((await admin.query('SELECT run_id FROM integration_b2a_operation_claim')).rows)
        .toEqual([{ run_id: 'automation-read:' + fixture.requestId }])
      expect((await admin.query('SELECT key FROM plugin_kv')).rows.every(row => String(row.key).startsWith('integration:b2a:'))).toBe(true)
      expect(JSON.stringify(outcome)).not.toMatch(/counts|token|selector|projectNo|sourceReference|authorityKey|connection|password/iu)
      expect(fixture.unavailable).not.toHaveBeenCalled()
    } finally { await fixture.close() }
  }, 90000)

  it('actual runtime stop during native IO drains unknown, not late preview success or another source attempt', async () => {
    const fixture = await runtimeFixture(true, 1, true)
    let entered!: () => void, release!: () => void, lateFinished!: () => void
    const enteredPromise = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const finished = new Promise<void>(resolve => { lateFinished = resolve })
    fixture.afterNative(async () => { entered(); await held; lateFinished() })
    const dispatch = runDispatchTick(pool, fixture.registry, { batchSize: 1, adapterTimeoutMs: 10000 })
    void dispatch.then(() => entered(), () => entered())
    let stopping: Promise<void> | undefined, stopped = false
    try {
      const originalProducer = await captureProducerRetirementProof()
      await enteredPromise
      expect(fixture.nativeStatements).toHaveLength(1)
      // This stop is the real runtime's combined shutdown signal. The native
      // completion is held AFTER actual SQL and remains unreleased while stop drains.
      stopping = fixture.runtime.stop().then(() => { stopped = true })
      expect(await dispatch).toMatchObject({ completed: 1, rescheduled: 0 })
      const before = await fixture.snapshot()
      expect(before).toMatchObject({ status: 'outcome_unknown', result: null, used_executions: 1, delivery_status: 'done' })
      expect(stopped).toBe(false)
      await expectProducerDrainState(originalProducer, false)
      await expect(fixture.runtime.execute(fixture.requestId, new AbortController().signal)).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
      expect(stopped).toBe(false)
      release()
      await finished
      await stopping
      expect(stopped).toBe(true)
      expectRuntimeStopOrder(fixture.stopOrder())
      await expectProducerDrainState(originalProducer, true)
      expect(await fixture.redeliver()).toMatchObject({ completed: 1 })
      expect(await fixture.snapshot()).toEqual(before)
      expect(fixture.nativeStatements).toHaveLength(1)
      expect((await admin.query('SELECT id FROM meta_records')).rows).toEqual([])
      expect(fixture.unavailable).not.toHaveBeenCalled()
    } finally { release(); await Promise.allSettled([dispatch, ...(stopping ? [stopping] : [])]); await fixture.close() }
  }, 30000)

  it.each(['metadata', 'claim-store'] as const)('actual runtime stop drains the real %s receipt tail with zero source IO', async stage => {
    const fixture = await runtimeFixture(true, 1, true)
    let enter!: () => void, release!: () => void, gated = false, stopped = false
    const entered = new Promise<void>(resolve => { enter = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    fixture.afterPluginQuery(async current => {
      if (current !== stage || gated) return
      gated = true; enter(); await held
    })
    const dispatch = runDispatchTick(pool, fixture.registry, { batchSize: 1, adapterTimeoutMs: 10000 })
    void dispatch.then(() => enter(), () => enter())
    let stopping: Promise<void> | undefined
    try {
      const originalProducer = await captureProducerRetirementProof()
      await entered
      expect(gated).toBe(true); expect(fixture.nativeStatements).toEqual([])
      stopping = fixture.runtime.stop().then(() => { stopped = true })
      expect(await dispatch).toMatchObject({ completed: 1, rescheduled: 0 })
      const before = await fixture.snapshot()
      expect(before).toMatchObject({ status: 'outcome_unknown', result: null, used_executions: 1, delivery_status: 'done' })
      expect(stopped).toBe(false)
      await expectProducerDrainState(originalProducer, false)
      await expect(fixture.runtime.execute(fixture.requestId, new AbortController().signal)).rejects.toThrow('AUTOMATION_READ_RUNTIME_INACTIVE')
      expect(stopped).toBe(false)
      release(); await stopping
      expect(stopped).toBe(true)
      expectRuntimeStopOrder(fixture.stopOrder())
      await expectProducerDrainState(originalProducer, true)
      expect(await fixture.redeliver()).toMatchObject({ completed: 1 })
      expect(await fixture.snapshot()).toEqual(before)
      expect(fixture.nativeStatements).toEqual([])
      expect((await admin.query('SELECT id FROM meta_records')).rows).toEqual([])
      expect(fixture.unavailable).not.toHaveBeenCalled()
    } finally { release(); await Promise.allSettled([dispatch, ...(stopping ? [stopping] : [])]); await fixture.close() }
  }, 30000)

  it('an inactive actual runtime remains registered and closes queued admission as blocked with zero source IO', async () => {
    const fixture = await runtimeFixture()
    try {
      await fixture.runtime.stop()
      assertManifestCompleteness(fixture.registry)
      expect(fixture.registry.keys()).toContain(AUTOMATION_READ_CONSUMER)
      expect(await runDispatchTick(pool, fixture.registry, { batchSize: 1 })).toMatchObject({ completed: 1, rescheduled: 0 })
      expect(await fixture.snapshot()).toMatchObject({ status: 'blocked', result: null, fence: null, used_executions: 0, delivery_status: 'done' })
      expect(fixture.nativeStatements).toEqual([])
      expect((await admin.query('SELECT run_id FROM integration_b2a_operation_claim')).rows).toEqual([])
    } finally { await fixture.close() }
  }, 30000)

  it('actual JWT owner activates record consent; the production durable two-leg handler queues then previews without business writes', async () => {
    await admin.query("UPDATE automation_rules SET conditions=NULL,trigger_config='{}' WHERE id=$1", [ruleId])
    const rules = new AutomationService(new EventBus(), db as never, async (statement, params) => admin.query(statement, params))
    const fixture = await ownerHttpFixture(rules, false)
    const ordinary = vi.spyOn(rules, 'handleDurableRecordEvent')
    const genericExecute = vi.spyOn(rules, 'executeRule')
    try {
      const business = (await admin.query('SELECT id,data FROM meta_records ORDER BY id')).rows
      const consent = { activationKey: randomUUID(), selector: fixture.selector, projectNo: 'SYN-PROJECT',
        expectedRecordCondition: { mode: 'unconditional' },
        expectedRuleRevision: (await admin.query('SELECT integration_authority_revision FROM automation_rules WHERE id=$1', [ruleId])).rows[0].integration_authority_revision as string,
        budget: { maxRows: 60, maxPages: 20, maxReadCount: 200, timeoutMs: 25000 },
        maxExecutions: 1, expiresAt: '2099-01-01T00:00:00.000Z' }
      expect((await fixture.http.request('POST', ownerPath + '/record-activations', { body: consent })).status).toBe(401)
      expect((await fixture.http.request('POST', ownerPath + '/record-activations',
        { token: fixture.token, body: { ...consent, grantId: randomUUID() } })).status).toBe(400)
      const authorized = await fixture.http.request('POST', ownerPath + '/record-activations', { token: fixture.token, body: consent })
      expect(authorized.status).toBe(201)
      const pair = responseData(authorized)
      expect(Object.keys(pair).sort()).toEqual(['activationId', 'grantId'])
      expect(await counts()).toEqual({ grants: 1, requests: 0, outbox: 0 })
      expect(fixture.nativeStatements).toEqual([])
      expect((await admin.query('SELECT purpose,triggers FROM integration_automation_read_grants WHERE id=$1', [pair.grantId])).rows)
        .toEqual([{ purpose: 'automatic', triggers: ['record'] }])

      // Only these two real adapters are dispatched here. The current manifest's
      // unrelated webhook delivery remains pending; no sender is substituted or
      // invoked. Other service methods below are unreachable fail-fast guards.
      const unexpected = async (): Promise<never> => { throw new Error('SYNTHETIC_UNEXPECTED_UNRELATED_CONSUMER') }
      const handlers = buildDurableConsumerHandlers({ automationService: rules,
        automationReadRecord: { produce: fixture.runtime.produceRecord }, projectionService: { reconcile: unexpected },
        webhookService: { deliverEvent: unexpected }, recordApprovalService: { handleApprovalCompletion: unexpected },
        todoMirrorService: { handleApprovalTaskCreated: unexpected, handleApprovalCompletion: unexpected } })
      const all = buildConsumerAdapterRegistry(handlers, createAutomationReadDelivery({ transaction, execute: fixture.runtime.execute }))
      const recordOnly = new ConsumerAdapterRegistry(), readOnly = new ConsumerAdapterRegistry()
      recordOnly.register(all.get('automation-record-trigger')!)
      readOnly.register(all.get(AUTOMATION_READ_CONSUMER)!)
      const eventId = randomUUID()
      const produced = await transaction(trx => enqueueOutboxEvent(trx, { eventType: 'multitable.record.created', eventId,
        payload: { sheetId, recordId: 'synthetic-durable-record', data: { ignored: 'synthetic-event-value' } } }, CURRENT_ROUTING_MANIFEST))
      expect(await runDispatchTick(pool, recordOnly, { batchSize: 1 })).toMatchObject({ completed: 1, rescheduled: 0 })
      expect(ordinary).toHaveBeenCalledTimes(1)
      expect(ordinary.mock.calls[0][1]).toMatchObject({ sheetId, _eventId: eventId })
      expect(genericExecute).not.toHaveBeenCalled()
      const request = (await admin.query('SELECT id,status,trigger_type,grant_id FROM integration_automation_read_requests')).rows[0]
      expect(request).toMatchObject({ status: 'queued', trigger_type: 'record', grant_id: pair.grantId })
      await executionAudit(String(request.id), ruleId, 'queued')
      expect(fixture.nativeStatements).toEqual([])
      expect((await admin.query('SELECT consumer_key,status FROM meta_automation_outbox_consumer WHERE outbox_id=$1 ORDER BY consumer_key', [produced.outboxId])).rows)
        .toEqual([{ consumer_key: 'automation-record-trigger', status: 'done' }, { consumer_key: 'webhook-event-bridge', status: 'pending' }])

      expect(await runDispatchTick(pool, readOnly, { batchSize: 1 })).toMatchObject({ completed: 1, rescheduled: 0 })
      const observed = await fixture.http.request('GET', ownerPath + '/requests/' + request.id, { token: fixture.token })
      expect(observed.status).toBe(200)
      expect(responseData(observed)).toMatchObject({ requestId: request.id, status: 'succeeded',
        result: { status: 'ready', counts: { add: 1 }, canApply: false } })
      const execution = await executionAudit(String(request.id), ruleId, 'succeeded')
      const publicDetail = await fixture.http.request('GET', '/api/multitable/automation-executions/' + execution.id, { token: fixture.token })
      // Public execution endpoints remain platform-admin gated. The private
      // owner is not promoted just because it activated a background grant.
      expect(publicDetail.status).toBe(403)
      expect(fixture.nativeStatements.length).toBeGreaterThan(0)
      const readCount = fixture.nativeStatements.length
      await admin.query("UPDATE meta_automation_outbox_consumer SET status='pending',lease_expires_at=NULL WHERE outbox_id=$1 AND consumer_key='automation-record-trigger'", [produced.outboxId])
      expect(await runDispatchTick(pool, recordOnly, { batchSize: 1 })).toMatchObject({ completed: 1, rescheduled: 0 })
      expect(ordinary).toHaveBeenCalledTimes(2)
      expect(await counts()).toEqual({ grants: 1, requests: 1, outbox: 2 })
      expect(fixture.nativeStatements).toHaveLength(readCount)
      expect((await admin.query('SELECT id,data FROM meta_records ORDER BY id')).rows).toEqual(business)
    } finally { await rules.shutdown(); await fixture.close() }
  }, 60000)

  async function ordinaryConditionalChain(actionType: 'create_record' | 'update_record', maintenanceContention?: 'meta_fields' | 'user_roles') {
    const previousDurableFlag = process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED
    process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = 'true'
    const rules = new AutomationService(new EventBus(), db as never, async (statement, params) => admin.query(statement, params))
    const fixture = await ownerHttpFixture(rules, false)
    let holder: PoolClient | undefined, holderOpen = false, lockHeld = false
    try {
      const conditionField = 'synthetic-automation-producer-condition'
      const triggerType = actionType === 'create_record' ? 'record.created' : 'record.updated'
      const eventType = 'multitable.' + triggerType
      await admin.query('INSERT INTO meta_fields(id,sheet_id,name,type,property) VALUES ($1,$2,$1,\'string\',\'{}\')',
        [conditionField, sheetId])
      await admin.query(`UPDATE automation_rules SET trigger_type=$2,trigger_config='{}',conditions=$3::jsonb WHERE id=$1`,
        [ruleId, triggerType, JSON.stringify({ logic: 'and', conditions: [{ fieldId: conditionField, operator: 'equals', value: 'accepted' }] })])
      const options = await fixture.http.request('GET', ownerPath + '/options?sheetId=' + sheetId, { token: fixture.token })
      expect(options.status).toBe(200)
      const option = (responseData(options).items as Row[]).find(item => (item.selector as ReadSelector).ruleId === ruleId)
      expect(option).toMatchObject({ recordActivationEligible: true, recordTriggerType: triggerType,
        recordCondition: { mode: 'saved_conditions' } })
      const authorized = await fixture.http.request('POST', ownerPath + '/record-activations', { token: fixture.token, body: {
        activationKey: randomUUID(), selector: fixture.selector, projectNo: 'SYN-PROJECT',
        expectedRecordCondition: option!.recordCondition, expectedRuleRevision: option!.recordRuleRevision,
        budget: { maxRows: 60, maxPages: 20, maxReadCount: 200, timeoutMs: 25000 },
        maxExecutions: 1, expiresAt: '2099-01-01T00:00:00.000Z',
      } })
      expect(authorized.status).toBe(201)
      const pair = responseData(authorized)
      const unexpected = async (): Promise<never> => { throw new Error('SYNTHETIC_UNEXPECTED_UNRELATED_CONSUMER') }
      const handlers = buildDurableConsumerHandlers({ automationService: rules,
        automationReadRecord: { produce: fixture.runtime.produceRecord }, projectionService: { reconcile: unexpected },
        webhookService: { deliverEvent: unexpected }, recordApprovalService: { handleApprovalCompletion: unexpected },
        todoMirrorService: { handleApprovalTaskCreated: unexpected, handleApprovalCompletion: unexpected } })
      const adapters = buildConsumerAdapterRegistry(handlers, createAutomationReadDelivery({ transaction, execute: fixture.executeObserved }))
      const recordOnly = new ConsumerAdapterRegistry(), readOnly = new ConsumerAdapterRegistry()
      recordOnly.register(adapters.get('automation-record-trigger')!)
      readOnly.register(adapters.get(AUTOMATION_READ_CONSUMER)!)
      // Direct PUBLIC executor entry, not a simulated service/JWT write. The real
      // original transaction owns record/revision/outbox/image; no producer fake.
      const writer = new AutomationExecutor({ eventBus: new EventBus(),
        queryFn: (statement, params) => pool.query(statement, params),
        transaction: work => transaction(trx => work({ query: trx.query })),
      })
      const sourceEvents: string[] = []
      const write = async (value: string) => {
        const recordId = 'synthetic-automation-chain-' + randomUUID()
        if (actionType === 'update_record') await admin.query(
          'INSERT INTO meta_records(id,sheet_id,data,version) VALUES($1,$2,$3::jsonb,1)',
          [recordId, sheetId, JSON.stringify({ [conditionField]: 'before' })])
        const data = { [conditionField]: value }
        const ordinary: AutomationRule = { id: 'synthetic-direct-writer', name: 'Synthetic writer', sheetId,
          trigger: { type: 'record.created', config: {} }, actions: [{ type: actionType, config: actionType === 'create_record' ? { data } : { fields: data } }],
          enabled: true, createdBy: actor.actorId, createdAt: '2026-01-01T00:00:00.000Z' }
        const executed = await writer.execute(ordinary, { sheetId, recordId, actorId: actor.actorId, _automationDepth: 0 })
        expect(executed.status).toBe('success')
        expect(executed.steps).toHaveLength(1)
        // Existing update output reports fields, not a record identity. Preserve
        // that production contract instead of inventing a return value for it.
        if (actionType === 'create_record') expect(executed.steps[0].output).toMatchObject({ recordId: expect.any(String) })
        const changedId = actionType === 'create_record' ? String((executed.steps[0].output as Row).recordId) : recordId
        const rows = (await admin.query(`SELECT o.id,o.event_id,o.automation_depth,i.after_image,i.schema_revision,
            i.record_id,i.record_version,(i.after_image=r.data) AS exact_stored_image,v.source,v.action
          FROM meta_automation_outbox o JOIN meta_automation_record_after_images i ON i.outbox_id=o.id
          JOIN meta_records r ON r.id=i.record_id JOIN meta_record_revisions v ON v.record_id=r.id
          WHERE i.record_id=$1 AND o.event_type=$2`, [changedId, eventType])).rows
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ automation_depth: 1, after_image: data, exact_stored_image: true,
          schema_revision: (option!.recordCondition as Row).schemaRevision, source: 'automation',
          action: actionType === 'create_record' ? 'create' : 'update' })
        expect(Number(rows[0].record_version)).toBe(actionType === 'create_record' ? 1 : 2)
        sourceEvents.push(String(rows[0].id))
        return rows[0]
      }
      await write('rejected')
      expect(await runDispatchTick(pool, recordOnly, { batchSize: 1 })).toMatchObject({ completed: 1, rescheduled: 0 })
      expect(await counts()).toEqual({ grants: 1, requests: 0, outbox: 1 })
      expect(fixture.nativeStatements).toEqual([])
      const matched = await write('accepted')
      // The condition is event-time evidence, not a current-record read. Change
      // this row after its source commit, without emitting another fixture event.
      await admin.query('UPDATE meta_records SET data=$2::jsonb,version=version+1 WHERE id=$1',
        [matched.record_id, JSON.stringify({ [conditionField]: 'changed-after-event' })])
      const readBusiness = async () => (await admin.query(`SELECT id,sheet_id,data,version,
        created_by,modified_by,created_at,updated_at FROM meta_records ORDER BY id`)).rows
      const beforePreview = await readBusiness()
      expect(await runDispatchTick(pool, recordOnly, { batchSize: 1 })).toMatchObject({ completed: 1, rescheduled: 0 })
      expect(await counts()).toEqual({ grants: 1, requests: 1, outbox: 3 })
      const request = (await admin.query('SELECT id,status,trigger_type,grant_id FROM integration_automation_read_requests')).rows[0]
      expect(request).toMatchObject({ status: 'queued', trigger_type: 'record', grant_id: pair.grantId })
      expect(fixture.nativeStatements).toEqual([])
      if (maintenanceContention) fixture.afterNative(async () => {
        if (lockHeld) return
        // Enter only after the unchanged first native SQL receipt succeeded.
        // A separate owned transaction holds the real maintenance lock mode;
        // this demonstrates a control, not the cause of an earlier failure.
        holder = await pool.connect()
        await holder.query('BEGIN ISOLATION LEVEL READ COMMITTED'); holderOpen = true
        const lockStatement = maintenanceContention === 'meta_fields'
          ? `LOCK TABLE ONLY "${schema}"."meta_fields" IN SHARE UPDATE EXCLUSIVE MODE`
          : `LOCK TABLE ONLY "${schema}"."user_roles" IN SHARE UPDATE EXCLUSIVE MODE`
        await holder.query(lockStatement); lockHeld = true
      })
      expect(await runDispatchTick(pool, readOnly, { batchSize: 1, adapterTimeoutMs: 30000 }))
        .toMatchObject({ completed: 1, rescheduled: 0 })
      await fixture.drainObservedTransactions()
      const observed = await fixture.http.request('GET', ownerPath + '/requests/' + request.id, { token: fixture.token })
      expect(observed.status).toBe(200)
      // These observe the runtime's actual transactions/execution, rather than
      // the separate executionFixture ledger's unused checkpoint decorator.
      const diagnostic = fixture.runtimeDiagnostics(), metadata = diagnostic.runtimeTransactions
      const context = JSON.stringify({ actionType, maintenanceContention, ...diagnostic })
      expect(diagnostic.execution, context).toEqual([expect.objectContaining({ outcome: 'returned',
        status: maintenanceContention ? 'outcome_unknown' : 'succeeded' })])
      expect(metadata.transactionCount, context).toBeGreaterThan(0)
      expect(metadata.queryCount, context).toBeGreaterThan(metadata.transactionCount)
      expect(metadata.committed, context).toBeGreaterThan(0)
      expect(metadata.metadataTableLocks, context).toBeGreaterThan(0)
      expect(metadata.tail, context).toHaveLength(2)
      expect(metadata.tail.every(row => row.outcome === 'returned'
        && row.phases.some(fact => fact.phase === 'commit' && fact.outcome === 'returned')), context).toBe(true)
      expect(metadata.committed + metadata.rolledBack + metadata.pending, context).toBe(metadata.transactionCount)
      expect(metadata.queryReturned, context)
        .toBe(metadata.queryCount - metadata.producerRenewalLockConflicts - (maintenanceContention ? 1 : 0))
      expect(metadata.rolledBack, context).toBe(metadata.producerRenewalLockConflicts + (maintenanceContention ? 1 : 0))
      expect(metadata.failures.length, context).toBeLessThanOrEqual(2)
      for (const failed of metadata.failures) {
        expect(failed.queryTail.length, context).toBeLessThanOrEqual(16)
        expect(failed.phases.length, context).toBeLessThanOrEqual(8)
        expect(failed.queryFailures.length, context).toBeLessThanOrEqual(4)
      }
      expect(diagnostic.observationOverflow, context).toBe(false)
      if (maintenanceContention) {
        expect(lockHeld, context).toBe(true)
        expect(responseData(observed), context).toEqual({ requestId: request.id, status: 'outcome_unknown', result: null })
        expect((await admin.query('SELECT status,result FROM integration_automation_read_requests WHERE id=$1', [request.id])).rows)
          .toEqual([{ status: 'outcome_unknown', result: null }])
        expect(diagnostic.preview, context).toMatchObject({ previewEntered: 1, previewReturned: 0,
          previewFailure: 'AUTOMATION_PREVIEW_UNAVAILABLE', nativeQueries: 1, nativeSucceeded: 1, nativeFailed: 0 })
        const lockStage = maintenanceContention === 'meta_fields' ? 'metadata-table-lock' : 'acl-table-lock'
        const lockFailures = metadata.failures.filter(row => row.queryFailures.some(fact => fact.sqlStage === lockStage))
        expect(lockFailures, context).toHaveLength(1)
        expect(lockFailures[0], context).toMatchObject({ outcome: 'rejected', code: 'AUTOMATION_READ_UNAVAILABLE' })
        expect(lockFailures[0].queryFailures, context).toEqual([expect.objectContaining({
          phase: 'query', sqlStage: lockStage, lock: 'table-nowait', outcome: 'rejected', code: '55P03',
        })])
        expect(lockFailures[0].phases.map(fact => [fact.phase, fact.outcome]), context)
          .toEqual([['connect', 'returned'], ['begin', 'returned'], ['work', 'rejected'], ['rollback', 'returned']])
        expect(fixture.nativeStatements).toHaveLength(1)
        expect((await admin.query(`SELECT c.status FROM meta_automation_outbox_consumer c
          JOIN integration_automation_read_requests r ON r.outbox_id=c.outbox_id
          WHERE r.id=$1 AND c.consumer_key=$2`, [request.id, AUTOMATION_READ_CONSUMER])).rows)
          .toEqual([{ status: 'done' }])
        const executions = diagnostic.execution.length
        expect(await runDispatchTick(pool, readOnly, { batchSize: 1 })).toMatchObject({ completed: 0, rescheduled: 0 })
        await holder!.query('ROLLBACK'); holderOpen = false; lockHeld = false
        fixture.afterNative()
        // Release alone cannot requeue a terminal ACK or spend another read.
        expect(await runDispatchTick(pool, readOnly, { batchSize: 1 })).toMatchObject({ completed: 0, rescheduled: 0 })
        await fixture.drainObservedTransactions()
        expect(fixture.runtimeDiagnostics().execution).toHaveLength(executions)
        expect(fixture.nativeStatements).toHaveLength(1)
        const afterRelease = await fixture.http.request('GET', ownerPath + '/requests/' + request.id, { token: fixture.token })
        expect(afterRelease.status).toBe(200)
        expect(responseData(afterRelease)).toEqual(responseData(observed))
        expect(await counts()).toEqual({ grants: 1, requests: 1, outbox: 3 })
      } else {
        expect(responseData(observed), context)
          .toMatchObject({ status: 'succeeded', result: { status: 'ready', canApply: false } })
        for (const failed of metadata.failures) expect(failed.queryFailures, context).toEqual([expect.objectContaining({
          phase: 'query', sqlStage: 'producer', lock: 'row-nowait', outcome: 'rejected', code: '55P03',
        })])
        expect(diagnostic.preview, context).toMatchObject({ previewEntered: 1, previewReturned: 1,
          previewFailure: null, nativeSucceeded: diagnostic.preview.nativeQueries, nativeFailed: 0 })
      }
      expect(fixture.nativeStatements.length).toBeGreaterThan(0)
      expect(await readBusiness()).toEqual(beforePreview)
      expect((await admin.query('SELECT used_executions FROM integration_automation_read_grants WHERE id=$1', [pair.grantId])).rows)
        .toEqual([{ used_executions: 1 }])
      for (const id of sourceEvents) expect((await admin.query(`SELECT consumer_key,status FROM meta_automation_outbox_consumer
        WHERE outbox_id=$1 ORDER BY consumer_key`, [id])).rows)
        .toEqual([{ consumer_key: 'automation-record-trigger', status: 'done' }, { consumer_key: 'webhook-event-bridge', status: 'pending' }])
    } finally {
      fixture.afterNative()
      try {
        if (holderOpen) await holder!.query('ROLLBACK')
      } finally {
        try { holder?.release() }
        finally {
          try { await rules.shutdown() }
          finally {
            try { await fixture.close() }
            finally {
              try { await fixture.drainObservedTransactions() }
              finally {
                if (previousDurableFlag === undefined) delete process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED
                else process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = previousDurableFlag
              }
            }
          }
        }
      }
    }
  }
  it.each(['create_record', 'update_record'] as const)('automation producer conditional chain: actual %s transaction → owner-consented record admission → native readonly preview',
    async actionType => ordinaryConditionalChain(actionType), 60000)

  it('ordinary update runtime diagnostic: real maintenance contention after source IO fails closed without retry',
    async () => ordinaryConditionalChain('update_record', 'meta_fields'), 60000)

  it('ordinary update runtime diagnostic: real ACL maintenance contention after source IO fails closed without retry',
    async () => ordinaryConditionalChain('update_record', 'user_roles'), 60000)

  it('actual owner options revision rejects changed-type and ABA consent before minting; recovery keeps the original immutable pair', async () => {
    await admin.query("UPDATE automation_rules SET conditions=NULL,trigger_config='{}' WHERE id=$1", [ruleId])
    const rules = new AutomationService(new EventBus(), db as never, async (statement, params) => admin.query(statement, params))
    const fixture = await ownerHttpFixture(rules, false)
    try {
      const opts = { token: fixture.token }
      const discover = async () => {
        const response = await fixture.http.request('GET', ownerPath + '/options?sheetId=' + sheetId, opts)
        expect(response.status).toBe(200)
        const option = (responseData(response).items as Array<Record<string, unknown>>)
          .find(item => (item.selector as ReadSelector).ruleId === ruleId)
        expect(option).toMatchObject({ recordActivationEligible: true, recordTriggerType: 'record.created' })
        expect(option?.recordRuleRevision).toMatch(/^[a-f0-9-]{36}$/u)
        return String(option!.recordRuleRevision)
      }
      const originalRevision = await discover()
      const consent = { activationKey: randomUUID(), selector: fixture.selector, projectNo: 'SYN-PROJECT',
        expectedRecordCondition: { mode: 'unconditional' },
        expectedRuleRevision: originalRevision,
        budget: { maxRows: 60, maxPages: 20, maxReadCount: 200, timeoutMs: 25000 },
        maxExecutions: 1, expiresAt: '2099-01-01T00:00:00.000Z' }
      await admin.query("UPDATE automation_rules SET trigger_type='record.updated' WHERE id=$1", [ruleId])
      expect((await fixture.http.request('POST', ownerPath + '/record-activations', { ...opts, body: consent })).status).toBe(409)
      await admin.query("UPDATE automation_rules SET trigger_type='record.created' WHERE id=$1", [ruleId])
      expect((await fixture.http.request('POST', ownerPath + '/record-activations', { ...opts, body: consent })).status).toBe(409)
      expect(await counts()).toEqual({ grants: 0, requests: 0, outbox: 0 })
      const newRevision = await discover()
      expect(newRevision).not.toBe(originalRevision)
      const renewedConsent = { ...consent, activationKey: randomUUID(), expectedRuleRevision: newRevision }
      const authorized = await fixture.http.request('POST', ownerPath + '/record-activations', { ...opts, body: renewedConsent })
      expect(authorized.status).toBe(201)
      const pair = responseData(authorized)
      await admin.query("UPDATE automation_rules SET trigger_type='record.updated' WHERE id=$1", [ruleId])
      const recovered = await fixture.http.request('POST', ownerPath + '/record-activations', { ...opts, body: renewedConsent })
      expect(recovered.status).toBe(201)
      expect(responseData(recovered)).toEqual(pair)
      expect((await fixture.http.request('POST', ownerPath + '/record-activations',
        { ...opts, body: { ...renewedConsent, expectedRuleRevision: originalRevision } })).status).toBe(409)
      expect((await admin.query('SELECT rule_revision FROM integration_automation_read_record_activations')).rows)
        .toEqual([{ rule_revision: newRevision }])
      expect(await counts()).toEqual({ grants: 1, requests: 0, outbox: 0 })
      expect(fixture.nativeStatements).toEqual([])
    } finally { await rules.shutdown(); await fixture.close() }
  }, 60000)

  it.each(['hold', 'release', 'stop'] as const)('producer renewal diagnostic: real lease-only writer held across afterIO, mode=%s', async mode => {
    const fixture = await runtimeFixture()
    let renewalEntered = false, writerOpen = false, dispatchSettled = false, sawBlockedReader = false
    let dispatch: ReturnType<typeof runDispatchTick> | undefined
    let stopping: Promise<void> | undefined
    const before = (await admin.query('SELECT generation::text,nonce::text FROM automation_read_producer_slot WHERE slot_id=1')).rows[0]
    const profilesBefore = (await admin.query('SELECT target_id,revision FROM automation_read_target_profiles ORDER BY target_id')).rows
    const business = (await admin.query('SELECT id,data FROM meta_records ORDER BY id')).rows
    const writerPid = Number((await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
    try {
      fixture.afterNative(async () => {
        if (renewalEntered) return
        renewalEntered = true
        await writer.query('BEGIN ISOLATION LEVEL READ COMMITTED'); writerOpen = true
        // Actual renewal of THIS runtime's identity (not the superseded fixture
        // producer). Only expiry changes; UPDATE has returned, COMMIT is held.
        await renewAutomationReadProducer(writer, { generation: before.generation, nonce: before.nonce }, 60000)
        await reader.query('BEGIN ISOLATION LEVEL READ COMMITTED')
        try {
          await expect(reader.query('SELECT slot_id FROM automation_read_producer_slot WHERE slot_id=1 FOR SHARE NOWAIT'))
            .rejects.toMatchObject({ code: '55P03' })
        } finally { await reader.query('ROLLBACK') }
      })
      dispatch = runDispatchTick(pool, fixture.registry, { batchSize: 1, adapterTimeoutMs: 30000 })
        .finally(() => { dispatchSettled = true })
      if (mode !== 'hold') {
        const until = performance.now() + 3000
        while (!dispatchSettled && performance.now() < until) {
          // Real PG lock-graph evidence, not a timer guess or query-result stub.
          const waiting = (await observer.query(`SELECT count(*)::int AS count FROM pg_catalog.pg_stat_activity
            WHERE datname=current_database() AND $1=ANY(pg_catalog.pg_blocking_pids(pid))
              AND query LIKE '%automation_read_producer_slot%' AND query LIKE '%FOR SHARE%'`, [writerPid])).rows[0]
          if (Number(waiting.count) > 0) {
            sawBlockedReader = true
            // The real runtime aborts synchronously, while the actual checkpoint
            // SQL is blocked. Releasing the lock must not resume source IO or publish.
            if (mode === 'stop') stopping = fixture.runtime.stop()
            await writer.query('COMMIT'); writerOpen = false
            break
          }
          await new Promise(resolve => setTimeout(resolve, 5))
        }
      }
      expect(await dispatch).toMatchObject({ completed: 1, rescheduled: 0 })
      expect(renewalEntered).toBe(true)
      const result = await fixture.snapshot()
      // The real executor reports its actual local branch. This does not derive
      // the 25-second full-app incident's cause from a smaller lock fixture.
      expect(fixture.executionDiagnostics()).toHaveLength(1)
      const diagnostic = fixture.executionDiagnostics()[0]
      expect(diagnostic).toMatchObject({ cleanupCount: 1 })
      expect(diagnostic.checkpointCount).toBeGreaterThanOrEqual(3)
      expect(Number.isInteger(diagnostic.elapsedMs)).toBe(true)
      if (mode === 'release') {
        expect(result.status, 'SYNTHETIC_RENEWAL_FACTS_' + JSON.stringify(fixture.scheduleDiagnostics())).toBe('succeeded')
        expect(sawBlockedReader).toBe(true)
        expect(result.result).toMatchObject({ status: 'ready', counts: { add: 1 }, canApply: false })
        expect(fixture.scheduleDiagnostics().queryFailures).toEqual([])
        expect(diagnostic).toMatchObject({ phase: 'complete', firstStop: 'none', outcome: 'succeeded' })
      } else {
        expect(result.status).toBe('outcome_unknown')
        expect(result.result).toBeNull()
        if (mode === 'hold') {
          expect(fixture.scheduleDiagnostics().queryFailures).toContainEqual({ stage: 'producer-read', code: '55P03' })
          expect(diagnostic).toMatchObject({ phase: 'source-checkpoint', firstStop: 'executor-failure', outcome: 'outcome_unknown' })
        } else {
          expect(sawBlockedReader).toBe(true); await stopping
          expect(diagnostic).toMatchObject({ phase: 'source-checkpoint', firstStop: 'upstream-abort', outcome: 'outcome_unknown' })
        }
        // No retry of the completed native read after a failed checkpoint.
        expect(fixture.diagnostic()).toMatchObject({ nativeQueries: 1, nativeSucceeded: 1, nativeFailed: 0 })
      }
      if (writerOpen) { await writer.query('COMMIT'); writerOpen = false }
      const after = (await admin.query('SELECT generation::text,nonce::text,expires_at>clock_timestamp() AS live FROM automation_read_producer_slot WHERE slot_id=1')).rows[0]
      if (mode !== 'stop') {
        expect(after.generation === before.generation && after.nonce === before.nonce && after.live === true).toBe(true)
        expect((await admin.query('SELECT target_id,revision FROM automation_read_target_profiles ORDER BY target_id')).rows).toEqual(profilesBefore)
      } else {
        // Stop closes local admission synchronously. DB deactivation is already
        // best-effort/NOWAIT and may lose to the late checkpoint SHARE. Do not
        // confuse a retained lease (left to expire) with an active local runtime.
        await fixture.drainObservedTransactions()
        await expect(fixture.runtime.execute(fixture.requestId, new AbortController().signal))
          .rejects.toMatchObject({ code: 'AUTOMATION_READ_RUNTIME_INACTIVE' })
        expect(await fixture.redeliver()).toMatchObject({ completed: 1 })
        expect(fixture.diagnostic()).toMatchObject({ nativeQueries: 1, nativeSucceeded: 1, nativeFailed: 0 })
        expect((await fixture.snapshot()).result).toBeNull()
      }
      expect((await admin.query('SELECT id,data FROM meta_records ORDER BY id')).rows).toEqual(business)
      expect((await admin.query('SELECT used_executions FROM integration_automation_read_grants')).rows).toEqual([{ used_executions: 1 }])
    } finally {
      if (writerOpen) await writer.query('ROLLBACK')
      await dispatch?.catch(() => {})
      await stopping?.catch(() => {})
      await fixture.close()
    }
  })

  /** Admission-only diagnostics: actual runtime/authority/ledger/PG, but a
   * deliberately elapsed activation floor in this owned synthetic schema.
   * These probes do NOT claim scheduler or real-minute cutover evidence. The
   * two wall-clock cases below keep their untouched DB-minted activation time.
   */
  async function scheduleAdmissionFixture() {
    await admin.query("UPDATE automation_rules SET conditions=NULL,trigger_type='schedule.cron',trigger_config=$2 WHERE id=$1",
      [ruleId, JSON.stringify({ expression: '* * * * *', timezone: 'UTC' })])
    const fixture = await runtimeFixture(false)
    try {
      const pair = await fixture.runtime.activateSchedule(actor, { activationKey: randomUUID(), selector: fixture.selector,
        expectedRuleRevision: (await admin.query('SELECT integration_authority_revision FROM automation_rules WHERE id=$1', [ruleId])).rows[0].integration_authority_revision as string,
        projectNo: 'SYN-PROJECT', budget: { maxRows: 60, maxPages: 20, maxReadCount: 200, timeoutMs: 25000 },
        maxExecutions: 1, expiresAt: '2099-01-01T00:00:00.000Z' })
      const databaseNow = Number((await admin.query('SELECT extract(epoch FROM clock_timestamp()) * 1000 AS now_ms')).rows[0].now_ms)
      const scheduledAtMs = Math.floor(databaseNow / 60000) * 60000 - 3 * 60000
      expect((await admin.query('SELECT current_schema() AS name')).rows).toEqual([{ name: schema }])
      const table = 'integration_automation_read_schedule_activations'
      // The trigger change, fixture-only timestamp arrangement and restoration
      // are atomic. No admission runs while immutability is disabled.
      await tx(admin, async client => {
        await client.query('ALTER TABLE ' + table + ' DISABLE TRIGGER automation_read_schedule_activation_immutable')
        const changed = await client.query('UPDATE ' + table + ' SET activated_at=$2::timestamptz WHERE id=$1',
          [pair.activationId, new Date(scheduledAtMs - 60000).toISOString()])
        expect(changed.rowCount).toBe(1)
        await client.query('ALTER TABLE ' + table + ' ENABLE TRIGGER automation_read_schedule_activation_immutable')
      })
      expect((await admin.query(`SELECT tgenabled FROM pg_catalog.pg_trigger
        WHERE tgrelid=$1::regclass AND tgname='automation_read_schedule_activation_immutable'`, [table])).rows)
        .toEqual([{ tgenabled: 'O' }])
      return { ...fixture, ...pair, occurrence: { ruleId, scheduledAtMs }, databaseNow }
    } catch (error) { await fixture.close(); throw error }
  }

  async function scheduleAdmissionEffects() {
    return (await admin.query(`SELECT
      (SELECT count(*)::int FROM integration_automation_read_requests) AS requests,
      (SELECT count(*)::int FROM meta_automation_outbox) AS outbox,
      (SELECT count(*)::int FROM integration_automation_read_executions) AS audit_links,
      (SELECT count(*)::int FROM multitable_automation_executions) AS executions`)).rows[0]
  }

  it('schedule admission diagnostic: a far-future planned minute rejects without candidate or effects; an elapsed minute still queues', async () => {
    const fixture = await scheduleAdmissionFixture()
    try {
      // A full extra minute removes near-boundary timing from this negative
      // probe. No JS/PG clock, query result, authority or ledger is substituted.
      const future = { ruleId, scheduledAtMs: Math.floor(fixture.databaseNow / 60000) * 60000 + 2 * 60000 }
      await expect(fixture.runtime.produceSchedule(future, new AbortController().signal))
        .rejects.toMatchObject({ code: 'AUTOMATION_READ_UNAVAILABLE' })
      expect(fixture.scheduleDiagnostics().observations).toEqual([])
      expect(fixture.scheduleDiagnostics().denials).toEqual([])
      expect(fixture.scheduleDiagnostics().sql).toEqual({ overflow: false, transactions: [] })
      expect(await scheduleAdmissionEffects()).toEqual({ requests: 0, outbox: 0, audit_links: 0, executions: 0 })
      expect(fixture.nativeStatements).toEqual([])
      await fixture.runtime.produceSchedule(fixture.occurrence, new AbortController().signal)
      expect(fixture.scheduleDiagnostics().observations.map(row => row.candidates)).toEqual([1])
      expect(await scheduleAdmissionEffects()).toEqual({ requests: 1, outbox: 1, audit_links: 1, executions: 1 })
      expect(fixture.nativeStatements).toEqual([])
    } finally { await fixture.close() }
  })

  it('schedule admission diagnostic: live permission revoked after the real candidate query resolves without enqueue; restoration is a positive control', async () => {
    const fixture = await scheduleAdmissionFixture()
    let revoked = 0
    try {
      afterMetadataQuery = async sql => {
        if (!sql.startsWith('SELECT a.id,a.cron_config,a.trigger_type,a.interval_anchor_ms,a.date_field_confirmation FROM integration_automation_read_schedule_activations a')) return
        afterMetadataQuery = undefined
        const changed = await admin.query("DELETE FROM role_permissions WHERE permission_code='integration:admin'")
        revoked = changed.rowCount ?? 0
      }
      await expect(fixture.runtime.produceSchedule(fixture.occurrence, new AbortController().signal)).resolves.toBeUndefined()
      expect(revoked).toBe(1)
      expect(fixture.scheduleDiagnostics().observations.map(row => row.candidates)).toEqual([1])
      expect(fixture.scheduleDiagnostics().denials).toEqual(['AUTOMATION_ACTOR_AUTHORITY_DENIED'])
      expect(fixture.scheduleDiagnostics().sql.overflow).toBe(false)
      expect(fixture.scheduleDiagnostics().sql.transactions.at(-1))
        .toMatchObject({ outcome: 'rejected', errorCode: 'AUTOMATION_ACTOR_AUTHORITY_DENIED' })
      expect(await scheduleAdmissionEffects()).toEqual({ requests: 0, outbox: 0, audit_links: 0, executions: 0 })
      expect(fixture.nativeStatements).toEqual([])
      await admin.query("INSERT INTO role_permissions VALUES ('integration_admin','integration:admin')")
      await fixture.runtime.produceSchedule(fixture.occurrence, new AbortController().signal)
      expect(await scheduleAdmissionEffects()).toEqual({ requests: 1, outbox: 1, audit_links: 1, executions: 1 })
      expect(fixture.nativeStatements).toEqual([])
    } finally { afterMetadataQuery = undefined; await fixture.close() }
  })

  it('schedule admission diagnostic: a queued reservation with used zero rejects another minute but recovers an exact replay', async () => {
    const fixture = await scheduleAdmissionFixture()
    try {
      await fixture.runtime.produceSchedule(fixture.occurrence, new AbortController().signal)
      const first = (await admin.query('SELECT id,status FROM integration_automation_read_requests')).rows
      expect(first).toEqual([{ id: expect.any(String), status: 'queued' }])
      const next = { ruleId, scheduledAtMs: fixture.occurrence.scheduledAtMs + 60000 }
      await expect(fixture.runtime.produceSchedule(next, new AbortController().signal)).resolves.toBeUndefined()
      // Durable effects are checked before diagnostic codes: a missing budget
      // fence must fail for the extra request, not merely a changed observer.
      expect((await admin.query('SELECT id,status FROM integration_automation_read_requests')).rows).toEqual(first)
      expect(await scheduleAdmissionEffects()).toEqual({ requests: 1, outbox: 1, audit_links: 1, executions: 1 })
      expect(fixture.scheduleDiagnostics().observations.map(row => row.candidates)).toEqual([1, 1])
      expect(fixture.scheduleDiagnostics().denials).toEqual(['AUTOMATION_READ_BUDGET_EXHAUSTED'])
      expect(fixture.scheduleDiagnostics().sql.overflow).toBe(false)
      expect(fixture.scheduleDiagnostics().sql.transactions.at(-1)).toMatchObject({
        outcome: 'rejected', errorCode: 'AUTOMATION_READ_BUDGET_EXHAUSTED',
        stages: expect.arrayContaining([{ stage: 'reservation', rows: 1, count: 1 }]),
      })
      expect((await admin.query('SELECT used_executions,max_executions FROM integration_automation_read_grants')).rows)
        .toEqual([{ used_executions: 0, max_executions: 1 }])
      expect((await admin.query('SELECT id,status FROM integration_automation_read_requests')).rows).toEqual(first)
      expect(await scheduleAdmissionEffects()).toEqual({ requests: 1, outbox: 1, audit_links: 1, executions: 1 })
      await fixture.runtime.produceSchedule(fixture.occurrence, new AbortController().signal)
      expect(fixture.scheduleDiagnostics().observations.map(row => row.candidates)).toEqual([1, 1, 1])
      expect(fixture.scheduleDiagnostics().denials).toEqual(['AUTOMATION_READ_BUDGET_EXHAUSTED'])
      expect((await admin.query('SELECT id,status FROM integration_automation_read_requests')).rows).toEqual(first)
      expect(await scheduleAdmissionEffects()).toEqual({ requests: 1, outbox: 1, audit_links: 1, executions: 1 })
      expect(fixture.nativeStatements).toEqual([])
    } finally { await fixture.close() }
  })

  it('database clock readiness: an early original minute waits for actual PG time then queues exactly once without source IO', async () => {
    const coarseDeadline = performance.now() + 60000
    await admin.query("UPDATE automation_rules SET conditions=NULL,trigger_type='schedule.cron',trigger_config=$2 WHERE id=$1",
      [ruleId, JSON.stringify({ expression: '* * * * *', timezone: 'UTC' })])
    const fixture = await runtimeFixture(false)
    try {
      const business = (await admin.query('SELECT id,data FROM meta_records ORDER BY id')).rows
      const pair = await fixture.runtime.activateSchedule(actor, { activationKey: randomUUID(), selector: fixture.selector,
        expectedRuleRevision: (await admin.query('SELECT integration_authority_revision FROM automation_rules WHERE id=$1', [ruleId])).rows[0].integration_authority_revision as string,
        projectNo: 'SYN-PROJECT', budget: { maxRows: 60, maxPages: 20, maxReadCount: 200, timeoutMs: 25000 },
        maxExecutions: 2, expiresAt: '2099-01-01T00:00:00.000Z' })
      const readClock = async () => Number((await admin.query('SELECT extract(epoch FROM pg_catalog.clock_timestamp()) * 1000 AS ms')).rows[0].ms)
      let now = await readClock()
      const occurrence = { ruleId, scheduledAtMs: Math.floor(now / 60000) * 60000 + 60000 }
      const birth = (await admin.query('SELECT activated_at FROM integration_automation_read_schedule_activations WHERE id=$1', [pair.activationId])).rows[0]
      expect(occurrence.scheduledAtMs).toBeGreaterThan(new Date(birth.activated_at).getTime())
      // Wait outside production until genuinely just before the next DB minute.
      // No host/PG fake clock, backdated activation, query rewrite or source IO.
      // Bounded observations reject missed windows; never silently skip or retry
      // a different occurrence to manufacture the required positive first lag.
      // Finish the coarse wait early; a long timer aimed at -750ms can resume
      // after the minute under Windows/VM scheduling. Approach the SAME minute
      // with bounded short samples, retaining both positive-first-lag assertions.
      for (let attempt = 0; occurrence.scheduledAtMs - now > 2500
        && attempt < 256 && performance.now() < coarseDeadline; attempt++) {
        const lag = occurrence.scheduledAtMs - now
        await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(1, Math.ceil(lag - 2500)))))
        now = await readClock()
      }
      now = await readClock()
      expect(occurrence.scheduledAtMs - now).toBeGreaterThan(0)
      expect(occurrence.scheduledAtMs - now).toBeLessThanOrEqual(2500)
      const approachDeadline = performance.now() + 10000
      for (let attempt = 0; occurrence.scheduledAtMs - now > 800
        && attempt < 256 && performance.now() < approachDeadline; attempt++) {
        const lag = occurrence.scheduledAtMs - now
        await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, Math.ceil(lag - 800)))))
        now = await readClock()
      }
      // Preparation stays bounded if VM wall-clock and timers progress
      // differently. Missing the SAME positive window still fails; neither
      // the production budget nor this test's 800ms ceiling is relaxed.
      expect(occurrence.scheduledAtMs - now).toBeGreaterThan(0)
      expect(occurrence.scheduledAtMs - now).toBeLessThanOrEqual(800)
      fixture.observeClockAt(occurrence.scheduledAtMs)
      await fixture.runtime.produceSchedule(occurrence, new AbortController().signal)
      // Durable effects are the primary assertion, not a diagnostic spelling.
      expect(await scheduleAdmissionEffects()).toEqual({ requests: 1, outbox: 1, audit_links: 1, executions: 1 })
      const first = (await admin.query(`SELECT id,status,invocation_id,extract(epoch FROM created_at)*1000 AS created_ms
        FROM integration_automation_read_requests`)).rows
      const expectedInvocation = 'schedule-read:' + createHash('sha256').update(JSON.stringify([
        pair.activationId, 'schedule.cron', new Date(occurrence.scheduledAtMs).toISOString(),
      ])).digest('hex')
      expect(first).toHaveLength(1)
      expect(first[0]).toMatchObject({ status: 'queued', invocation_id: expectedInvocation })
      expect(Number(first[0].created_ms)).toBeGreaterThanOrEqual(occurrence.scheduledAtMs)
      const diagnostics = fixture.scheduleDiagnostics()
      expect(diagnostics.observationOverflow).toBe(false)
      expect(diagnostics.clockReadiness.length).toBeGreaterThanOrEqual(2)
      expect(diagnostics.clockReadiness.length).toBeLessThanOrEqual(4)
      expect(diagnostics.clockReadiness[0]).toBeGreaterThan(0)
      expect(diagnostics.clockReadiness[0]).toBeLessThanOrEqual(1000)
      expect(diagnostics.clockReadiness.at(-1)).toBeLessThanOrEqual(0)
      expect(diagnostics.observations.map(row => row.candidates)).toEqual([1])
      await fixture.runtime.produceSchedule(occurrence, new AbortController().signal)
      expect((await admin.query(`SELECT id,status,invocation_id,extract(epoch FROM created_at)*1000 AS created_ms
        FROM integration_automation_read_requests`)).rows).toEqual(first)
      expect(await scheduleAdmissionEffects()).toEqual({ requests: 1, outbox: 1, audit_links: 1, executions: 1 })
      expect((await admin.query('SELECT used_executions FROM integration_automation_read_grants')).rows)
        .toEqual([{ used_executions: 0 }])
      expect((await admin.query('SELECT id,data FROM meta_records ORDER BY id')).rows).toEqual(business)
      expect(fixture.nativeStatements).toEqual([])
    } finally { await fixture.runtime.stopScheduleAdmissions(); await fixture.close() }
  }, 75000)

  it.each([0, 1, 2] as const)('date field native chain: %i retry source permits; real JWT consent → scheduler → private receipt → readonly native preview', async retrySourcePermits => {
    const fixture = await ownerHttpFixture(undefined, false, retrySourcePermits === 2 ? 2 : 1)
    let rules: AutomationService | undefined, timer: ReturnType<typeof setTimeout> | undefined
    try {
      // Bootstrap above owns the template replacement. Add the reminder field
      // afterward, then discover its actual schema revision through HTTP.
      const dateFieldId = 'synthetic-controlled-due', dateRecordId = 'synthetic-controlled-date-record'
      await admin.query("INSERT INTO meta_fields(id,sheet_id,name,type,property) VALUES ($1,$2,$1,'date','{}')", [dateFieldId, sheetId])
      const dbNow = Number((await admin.query('SELECT extract(epoch FROM clock_timestamp())*1000 AS ms')).rows[0].ms)
      const dueAt = Math.ceil((dbNow + 15000) / 60000) * 60000
      const dueIso = new Date(dueAt).toISOString()
      const dateConfig = { dateFieldId, offsetDays: 0, direction: 'before', timeOfDay: dueIso.slice(11, 16), timezone: 'UTC' }
      await admin.query("UPDATE automation_rules SET conditions=NULL,trigger_type='schedule.date_field',trigger_config=$2,action_config=action_config||'{\"allowManual\":false}'::jsonb WHERE id=$1", [ruleId, JSON.stringify(dateConfig)])
      await admin.query('INSERT INTO meta_records(id,sheet_id,data,version) VALUES($1,$2,$3::jsonb,1)',
        [dateRecordId, sheetId, JSON.stringify({ [dateFieldId]: dueIso.slice(0, 10) })])
      const opts = { token: fixture.token }
      const options = await fixture.http.request('GET', ownerPath + '/options?sheetId=' + encodeURIComponent(sheetId), opts)
      expect(options.status).toBe(200)
      const item = (responseData(options).items as Row[]).find(row => (row.selector as Row).ruleId === ruleId)!
      expect(item).toMatchObject({ scheduleActivationEligible: true, scheduleDefinition: { triggerType: 'schedule.date_field',
        config: dateConfig, dateField: { fieldId: dateFieldId, fieldType: 'date' } } })
      const dateField = (item.scheduleDefinition as Row).dateField
      const consent = { activationKey: randomUUID(), selector: fixture.selector, expectedRuleRevision: item.scheduleRuleRevision,
        expectedDateField: dateField, projectNo: 'SYN-PROJECT',
        budget: { maxRows: 60, maxPages: 20, maxReadCount: 200, timeoutMs: 25000 }, maxExecutions: 1, expiresAt: '2099-01-01T00:00:00.000Z' }
      const missing = { ...consent }; Reflect.deleteProperty(missing, 'expectedDateField')
      expect((await fixture.http.request('POST', ownerPath + '/schedule-activations', { ...opts, body: missing })).status).toBe(400)
      const activated = await fixture.http.request('POST', ownerPath + '/schedule-activations', { ...opts, body: consent })
      expect(activated.status).toBe(201)
      const pair = responseData(activated)
      expect(responseData(await fixture.http.request('POST', ownerPath + '/schedule-activations', { ...opts, body: consent }))).toEqual(pair)
      expect(fixture.nativeStatements).toEqual([])
      const birth = (await admin.query('SELECT extract(epoch FROM activated_at)*1000 AS ms FROM integration_automation_read_schedule_activations WHERE id=$1', [pair.activationId])).rows[0]
      expect(Number(birth.ms)).toBeLessThan(dueAt)
      const business = (await admin.query('SELECT id,data,version FROM meta_records ORDER BY id')).rows
      let wake: ReadScheduleOccurrence | undefined, resolve!: () => void, reject!: (error: unknown) => void
      const admitted = new Promise<void>((yes, no) => { resolve = yes; reject = no }); void admitted.catch(() => {})
      rules = new AutomationService(new EventBus(), db as never, async (statement, params) => admin.query(statement, params),
        undefined, null, {}, undefined, { async produce(occurrence, signal) {
          try {
            await fixture.runtime.produceSchedule(occurrence, signal)
            // Classify by the immutable wake, never completion time or global
            // rows another concurrent timer may already have committed.
            if (occurrence.scheduledAtMs < dueAt) return
            expect(occurrence).toEqual({ ruleId, triggerType: 'schedule.date_field', scheduledAtMs: dueAt })
            const receipts = (await admin.query(`SELECT d.request_id,d.record_id,d.occurrence_at_utc
              FROM integration_automation_read_date_occurrences d
              JOIN integration_automation_read_requests r ON r.id=d.request_id AND r.grant_id=$2 AND r.status='queued'
              JOIN meta_automation_outbox o ON o.id=r.outbox_id AND o.payload->>'requestId'=r.id::text
              WHERE d.activation_id=$1`, [pair.activationId, pair.grantId])).rows
            expect(receipts).toEqual([{ request_id: expect.any(String), record_id: dateRecordId, occurrence_at_utc: dueIso }])
            wake = occurrence
            resolve()
          }
          catch (error) { reject(error); throw error }
        } })
      const ordinary = vi.spyOn(rules, 'executeRule')
      await rules.loadAndRegisterAllScheduled()
      await Promise.race([admitted, new Promise<never>((_resolve, no) => {
        timer = setTimeout(() => no(new Error('SYNTHETIC_DATE_NATIVE_TIMEOUT')), 85000)
      })])
      clearTimeout(timer); timer = undefined
      await rules.stopProducerAdmissions()
      expect(wake).toEqual({ ruleId, triggerType: 'schedule.date_field', scheduledAtMs: dueAt })
      expect(ordinary).not.toHaveBeenCalled()
      const receipt = (await admin.query('SELECT request_id,record_id,occurrence_at_utc FROM integration_automation_read_date_occurrences')).rows
      expect(receipt).toEqual([{ request_id: expect.any(String), record_id: dateRecordId, occurrence_at_utc: dueIso }])
      const requestId = String(receipt[0].request_id)
      expect(await counts()).toEqual({ grants: 1, requests: 1, outbox: 1 })
      await fixture.runtime.produceSchedule(wake!, new AbortController().signal)
      expect(await counts()).toEqual({ grants: 1, requests: 1, outbox: 1 })
      expect(fixture.nativeStatements).toEqual([])
      let cancelled = false
      if (retrySourcePermits) fixture.afterNative(async () => {
        if (!cancelled && fixture.nativeStatements.at(-1)?.includes('.syn_orderline')) {
          cancelled = true
          await fixture.management.cancel(actor, requestId)
        }
      })
      const dateDispatch = await runDispatchTick(pool, fixture.registry, { batchSize: 1 })
      expect(dateDispatch, 'SA06_DATE_DISPATCH_COUNTERS ' + JSON.stringify({
        claimed: dateDispatch.claimed, completed: dateDispatch.completed, rescheduled: dateDispatch.rescheduled,
        poisoned: dateDispatch.poisoned, lostLease: dateDispatch.lostLease, heartbeatErrors: dateDispatch.heartbeatErrors,
        claimTimePoisoned: dateDispatch.claimTimePoisoned, unknownKeyCount: dateDispatch.unknownKeys.length,
      })).toMatchObject({ completed: 1, rescheduled: 0 })
      const result = await fixture.http.request('GET', ownerPath + '/requests/' + requestId, opts)
      expect(result.status).toBe(200)
      expect(responseData(result)).toMatchObject(retrySourcePermits
        ? { requestId, status: 'outcome_unknown', result: null }
        : { requestId, status: 'succeeded', result: { status: 'ready', canApply: false } })
      expect(fixture.nativeStatements.length).toBeGreaterThan(0)
      expect((await admin.query('SELECT id,data,version FROM meta_records ORDER BY id')).rows).toEqual(business)
      expect((await admin.query('SELECT used_executions FROM integration_automation_read_grants')).rows).toEqual([{ used_executions: 1 }])
      if (retrySourcePermits) {
        expect(cancelled).toBe(true)
        const before = (await admin.query(`SELECT to_jsonb(g) AS grant,to_jsonb(q) AS request,to_jsonb(d) AS receipt
          FROM integration_automation_read_requests q JOIN integration_automation_read_grants g ON g.id=q.grant_id
          JOIN integration_automation_read_date_occurrences d ON d.request_id=q.id WHERE q.id=$1`, [requestId])).rows
        const reads = fixture.nativeStatements.length, path = ownerPath + '/requests/' + requestId + '/retry'
        const context = responseData(await fixture.http.request('GET', ownerPath + '/requests/' + requestId + '/retry-context', opts))
        expect(context).toMatchObject({ request: { trigger: 'schedule', status: 'outcome_unknown' },
          grant: { purpose: 'automatic', maxExecutions: 1, usedExecutions: 1, triggers: ['schedule'] },
          dateScheduleOrigin: { definition: item.scheduleDefinition, ruleRevision: item.scheduleRuleRevision } })
        const command = { retryKey: randomUUID(), budget: consent.budget, expiresAt: consent.expiresAt, acknowledgeNewRead: true }
        expect((await fixture.http.request('POST', path, { body: command })).status).toBe(401)
        expect((await fixture.http.request('POST', path, { ...opts, body: { ...command, dateScheduleOrigin: context.dateScheduleOrigin } })).status).toBe(400)
        const reply = await fixture.http.request('POST', path, { ...opts, body: command })
        expect(reply.status).toBe(202)
        const child = responseData(reply)
        expect(responseData(await fixture.http.request('POST', path, { ...opts, body: command }))).toEqual(child)
        expect(fixture.nativeStatements).toHaveLength(reads)
        expect(await runDispatchTick(pool, fixture.registry, { batchSize: 1 })).toMatchObject({ completed: 1, rescheduled: 0 })
        const status = retrySourcePermits === 2 ? 'succeeded' : 'outcome_unknown'
        expect(responseData(await fixture.http.request('GET', ownerPath + '/requests/' + String(child.requestId), opts)))
          .toMatchObject({ status, result: retrySourcePermits === 2 ? { status: 'ready', canApply: false } : null })
        expect(fixture.nativeStatements.length - reads).toBe(retrySourcePermits === 2 ? 20 : 0)
        expect((await admin.query('SELECT count(*)::int AS count FROM integration_b2a_operation_claim')).rows).toEqual([{ count: retrySourcePermits }])
        expect((await admin.query(`SELECT to_jsonb(g) AS grant,to_jsonb(q) AS request,to_jsonb(d) AS receipt
          FROM integration_automation_read_requests q JOIN integration_automation_read_grants g ON g.id=q.grant_id
          JOIN integration_automation_read_date_occurrences d ON d.request_id=q.id WHERE q.id=$1`, [requestId])).rows).toEqual(before)
        expect((await admin.query('SELECT purpose,triggers,used_executions FROM integration_automation_read_grants WHERE id=$1', [child.grantId])).rows)
          .toEqual([{ purpose: 'retry', triggers: ['schedule'], used_executions: 1 }])
        expect((await admin.query('SELECT id,data,version FROM meta_records ORDER BY id')).rows).toEqual(business)
        const completedReads = fixture.nativeStatements.length
        expect(await fixture.runtime.execute(String(child.requestId), new AbortController().signal)).toMatchObject({ status })
        expect(fixture.nativeStatements).toHaveLength(completedReads)
      }
      // Schema ABA invalidates the live authority. Receipt/history remain
      // observable; no second source read or fabricated replacement grant.
      await admin.query("UPDATE meta_fields SET type='dateTime' WHERE id=$1", [dateFieldId])
      await admin.query("UPDATE meta_fields SET type='date' WHERE id=$1", [dateFieldId])
      await fixture.runtime.produceSchedule(wake!, new AbortController().signal)
      expect(await counts()).toEqual(retrySourcePermits ? { grants: 2, requests: 2, outbox: 2 } : { grants: 1, requests: 1, outbox: 1 })
      expect((await fixture.http.request('GET', ownerPath + '/requests/' + requestId, opts)).status).toBe(200)
    } finally {
      if (timer) clearTimeout(timer)
      try { await rules?.shutdown() }
      finally { await fixture.close() }
    }
  }, 120000)

  it('real JWT cron consent → actual wall-clock scheduler/service → private queue → native preview, without clock or authority substitutes', async () => {
    await admin.query("UPDATE automation_rules SET conditions=NULL,trigger_type='schedule.cron',trigger_config=$2 WHERE id=$1",
      [ruleId, JSON.stringify({ expression: '* * * * *', timezone: 'UTC' })])
    const fixture = await ownerHttpFixture(undefined, false)
    let rules: AutomationService | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const business = (await admin.query('SELECT id,data FROM meta_records ORDER BY id')).rows
      const consent = { activationKey: randomUUID(), selector: fixture.selector, projectNo: 'SYN-PROJECT',
        budget: { maxRows: 60, maxPages: 20, maxReadCount: 200, timeoutMs: 25000 },
        maxExecutions: 2, expiresAt: '2099-01-01T00:00:00.000Z' }
      const confirmedConsent = { ...consent, expectedRuleRevision: (await admin.query(
        'SELECT integration_authority_revision FROM automation_rules WHERE id=$1', [ruleId])).rows[0].integration_authority_revision as string }
      expect((await fixture.http.request('POST', ownerPath + '/schedule-activations', { body: consent })).status).toBe(401)
      expect((await fixture.http.request('POST', ownerPath + '/schedule-activations',
        { token: fixture.token, body: { ...consent, scheduledAtMs: Date.now() } })).status).toBe(400)
      const authorized = await fixture.http.request('POST', ownerPath + '/schedule-activations', { token: fixture.token, body: confirmedConsent })
      expect(authorized.status).toBe(201)
      const pair = responseData(authorized)
      expect(Object.keys(pair).sort()).toEqual(['activationId', 'grantId'])
      expect(await counts()).toEqual({ grants: 1, requests: 0, outbox: 0 })
      expect(fixture.nativeStatements).toEqual([])
      const birth = (await admin.query('SELECT activated_at FROM integration_automation_read_schedule_activations WHERE id=$1', [pair.activationId])).rows[0]
      const activationMs = new Date(birth.activated_at).getTime()
      expect(Number.isFinite(activationMs)).toBe(true)
      // A real host clock can lag the PG clock across a minute boundary. That first host
      // minute is legitimately before consent and MUST remain ineligible, not be admitted
      // just because produceSchedule resolves. Prove the negative with the actual DB birth.
      await fixture.runtime.produceSchedule({ ruleId, scheduledAtMs: Math.floor(activationMs / 60000) * 60000 },
        new AbortController().signal)
      expect(await counts()).toEqual({ grants: 1, requests: 0, outbox: 0 })
      expect(fixture.nativeStatements).toEqual([])
      const preConsentObservation = fixture.scheduleDiagnostics().observations
      expect(preConsentObservation).toHaveLength(1)
      expect(preConsentObservation[0]?.candidates).toBe(0)
      expect(preConsentObservation[0]?.facts).toHaveLength(1)
      expect(Number(preConsentObservation[0]?.facts[0]?.planned_minus_activation_ms)).toBeLessThanOrEqual(0)
      // Establish the positive fixture's prerequisite before registering the real scheduler.
      // No clock/occurrence rewriting, activation backdating, or increased callback timeout.
      const alignmentStarted = performance.now()
      while (Date.now() <= activationMs && performance.now() - alignmentStarted < 2000) {
        await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, activationMs - Date.now() + 1))))
      }
      expect(Date.now(), 'SYNTHETIC_HOST_CLOCK_HAS_NOT_PASSED_ACTIVATION').toBeGreaterThan(activationMs)
      let planned: ReadScheduleOccurrence | undefined
      const callbackFacts: Array<{ sameRule: boolean; minuteDelta: number; completionOrder: number; resolved: boolean }> = []
      let callbackCount = 0, completedCallbacks = 0
      let accept!: () => void, reject!: (error: unknown) => void
      const admitted = new Promise<void>((resolve, fail) => { accept = resolve; reject = fail })
      void admitted.catch(() => {})
      rules = new AutomationService(new EventBus(), db as never, async (statement, params) => admin.query(statement, params),
        undefined, null, {}, undefined, { async produce(occurrence, signal) {
          // Observation wrapper only: it forwards the original production
          // occurrence/signal to the actual runtime and awaits the real tx.
          planned ??= occurrence
          callbackCount++
          const fact = { sameRule: occurrence.ruleId === ruleId,
            minuteDelta: (occurrence.scheduledAtMs - planned.scheduledAtMs) / 60000, completionOrder: 0, resolved: false }
          if (callbackFacts.length < 2) callbackFacts.push(fact)
          try {
            await fixture.runtime.produceSchedule(occurrence, signal)
            fact.completionOrder = ++completedCallbacks; fact.resolved = true; accept()
          } catch (error) { fact.completionOrder = ++completedCallbacks; reject(error); throw error }
        } })
      const ordinary = vi.spyOn(rules, 'executeRule')
      await rules.loadAndRegisterAllScheduled()
      // Real minute rollover (<=60s), not JS fake time or a backdated activation.
      // This establishes scheduler -> service -> runtime -> actual PG cutover.
      await Promise.race([admitted, new Promise<never>((_resolve, fail) => {
        timeout = setTimeout(() => fail(new Error('SYNTHETIC_CRON_ADMISSION_TIMEOUT')), 65000)
      })])
      clearTimeout(timeout); timeout = undefined
      await rules.stopProducerAdmissions()
      expect({ callbackCount, callbackFacts }, 'SYNTHETIC_CRON_CALLBACK_FACTS')
        .toEqual({ callbackCount: 1, callbackFacts: [{ sameRule: true, minuteDelta: 0, completionOrder: 1, resolved: true }] })
      expect(planned?.ruleId).toBe(ruleId)
      expect(planned!.scheduledAtMs % 60000).toBe(0)
      expect(planned!.scheduledAtMs).toBeGreaterThan(new Date(birth.activated_at).getTime())
      expect(ordinary).not.toHaveBeenCalled()
      const request = (await admin.query('SELECT id,status,trigger_type,grant_id FROM integration_automation_read_requests')).rows[0]
      expect(request, 'SYNTHETIC_SCHEDULE_FACTS_' + JSON.stringify(fixture.scheduleDiagnostics()))
        .toMatchObject({ status: 'queued', trigger_type: 'schedule', grant_id: pair.grantId })
      expect(await counts()).toEqual({ grants: 1, requests: 1, outbox: 1 })
      expect(fixture.nativeStatements).toEqual([])
      await executionAudit(String(request.id), ruleId, 'queued')
      // Replay a second callback for this exact planned occurrence; it must
      // recover the durable identity without another request/allowance.
      await fixture.runtime.produceSchedule(planned!, new AbortController().signal)
      expect(await counts()).toEqual({ grants: 1, requests: 1, outbox: 1 })
      // Existing ledger reserves queued capacity; used_executions advances only
      // when the durable worker claims, not when the scheduler enqueues.
      expect((await admin.query('SELECT used_executions FROM integration_automation_read_grants')).rows).toEqual([{ used_executions: 0 }])
      expect(await runDispatchTick(pool, fixture.registry, { batchSize: 1 })).toMatchObject({ completed: 1, rescheduled: 0 })
      const observed = await fixture.http.request('GET', ownerPath + '/requests/' + request.id, { token: fixture.token })
      expect(observed.status).toBe(200)
      expect(responseData(observed), 'SYNTHETIC_SCHEDULE_EXECUTION_FACTS_' + JSON.stringify(fixture.scheduleDiagnostics()))
        .toMatchObject({ requestId: request.id, status: 'succeeded',
        result: { status: 'ready', counts: { add: 1 }, canApply: false } })
      expect(fixture.nativeStatements.length).toBeGreaterThan(0)
      await executionAudit(String(request.id), ruleId, 'succeeded')
      const detail = await fixture.http.request('GET', ownerPath + '/grants/' + pair.grantId, { token: fixture.token })
      expect(detail.status).toBe(200)
      expect(responseData(detail)).toMatchObject({ purpose: 'automatic', triggers: ['schedule'], usedExecutions: 1 })
      expect((await admin.query('SELECT id,data FROM meta_records ORDER BY id')).rows).toEqual(business)
      expect((await fixture.http.request('POST', ownerPath + '/grants/' + pair.grantId + '/revoke', { token: fixture.token })).status).toBe(200)
      const readCount = fixture.nativeStatements.length
      await fixture.runtime.produceSchedule(planned!, new AbortController().signal)
      expect(fixture.nativeStatements).toHaveLength(readCount)
      // Drain renewal before comparing its query observation with the later
      // diagnostic callback, including any retirement failure in the assertion.
      await fixture.runtime.stop()
      // This real-minute test keeps renewal running. Authority SHARE locks may
      // collide with its UPDATE NOWAIT; every diagnostic must be accounted for
      // by that exact real SQLSTATE, never by an expiry or another DB failure.
      expect(fixture.unavailable).toHaveBeenCalledTimes(fixture.renewalLockConflicts())
    } finally {
      if (timeout) clearTimeout(timeout)
      await rules?.shutdown()
      await fixture.runtime.stopScheduleAdmissions()
      await fixture.close()
    }
  }, 90000)

  it('public rule CRUD uses actual JWT, live workflow permission and sheet scope without source reads', async () => {
    const rules = new AutomationService(new EventBus(), db as never, async (statement, params) => admin.query(statement, params))
    const fixture = await ownerHttpFixture(rules)
    try {
      const before = await counts()
      const business = (await admin.query('SELECT id,data FROM meta_records ORDER BY id')).rows
      const originalRules = (await admin.query('SELECT * FROM automation_rules ORDER BY id')).rows
      const body = { name: 'Synthetic public rule', triggerType: 'record.created', actionType: AUTOMATION_READ_ACTION_TYPE,
        actionConfig: ruleConfig, enabled: true, createdBy: 'untrusted-body-owner' }
      const endpoints = [['GET', rulesPath, undefined], ['POST', rulesPath, body],
        ['PATCH', rulesPath + '/' + ruleId, { name: 'Denied update' }], ['DELETE', rulesPath + '/' + ruleId, undefined]] as const
      for (const [method, route, candidate] of endpoints) {
        expect((await fixture.http.request(method, route, { body: candidate })).status).toBe(401)
        // Integration administration is not Automation management permission.
        expect((await fixture.http.request(method, route, { token: fixture.token, body: candidate })).status).toBe(403)
      }
      expect((await admin.query('SELECT * FROM automation_rules ORDER BY id')).rows).toEqual(originalRules)
      await authorizeRuleAuthoring()
      await admin.query("UPDATE spreadsheet_permissions SET perm_code='spreadsheet:read' WHERE sheet_id=$1", [sheetId])
      for (const [method, route, candidate] of endpoints) {
        expect((await fixture.http.request(method, route, { token: fixture.token, body: candidate })).status).toBe(403)
      }
      expect((await admin.query('SELECT * FROM automation_rules ORDER BY id')).rows).toEqual(originalRules)
      await admin.query("UPDATE spreadsheet_permissions SET perm_code='spreadsheet:write' WHERE sheet_id=$1", [sheetId])
      const created = await fixture.http.request('POST', rulesPath, { token: fixture.token, body })
      expect(created.status).toBe(200)
      const saved = responseData(created).rule as Row
      expect(saved).toMatchObject({ sheetId, name: body.name, createdBy: actor.actorId,
        actionType: AUTOMATION_READ_ACTION_TYPE, actionConfig: ruleConfig })
      expect(saved.id).toEqual(expect.any(String))
      expect((await admin.query('SELECT created_by,action_config FROM automation_rules WHERE id=$1', [saved.id])).rows)
        .toEqual([{ created_by: actor.actorId, action_config: ruleConfig }])
      const listed = await fixture.http.request('GET', rulesPath, { token: fixture.token })
      expect(listed.status).toBe(200)
      expect((responseData(listed).rules as Row[]).some(rule => rule.id === saved.id)).toBe(true)
      const updated = await fixture.http.request('PATCH', rulesPath + '/' + saved.id,
        { token: fixture.token, body: { name: 'Public rule updated', actionConfig: { ...ruleConfig, allowManual: false } } })
      expect(updated.status).toBe(200)
      expect(responseData(updated).rule).toMatchObject({ id: saved.id, name: 'Public rule updated',
        actionConfig: { ...ruleConfig, allowManual: false } })
      await admin.query("DELETE FROM user_permissions WHERE user_id=$1 AND permission_code='workflow:create'", [actor.actorId])
      // The exact same signed session is rechecked against the actual DB.
      expect((await fixture.http.request('PATCH', rulesPath + '/' + saved.id,
        { token: fixture.token, body: { name: 'Must not persist' } })).status).toBe(403)
      expect((await admin.query('SELECT name FROM automation_rules WHERE id=$1', [saved.id])).rows[0].name).toBe('Public rule updated')
      await admin.query('INSERT INTO user_permissions VALUES ($1,$2)', [actor.actorId, 'workflow:create'])
      await admin.query('UPDATE meta_sheets SET deleted_at=now() WHERE id=$1', [sheetId])
      expect((await fixture.http.request('GET', rulesPath, { token: fixture.token })).status).toBe(404)
      expect((await fixture.http.request('POST', rulesPath, { token: fixture.token, body })).status).toBe(404)
      await admin.query('UPDATE meta_sheets SET deleted_at=NULL WHERE id=$1', [sheetId])
      expect((await fixture.http.request('DELETE', rulesPath + '/' + saved.id, { token: fixture.token })).status).toBe(200)
      expect((await admin.query('SELECT id FROM automation_rules WHERE id=$1', [saved.id])).rows).toEqual([])
      expect((await admin.query('SELECT * FROM automation_rules ORDER BY id')).rows).toEqual(originalRules)
      expect(await counts()).toEqual(before)
      expect(fixture.nativeStatements).toEqual([])
      expect((await admin.query('SELECT id,data FROM meta_records ORDER BY id')).rows).toEqual(business)
      expect((await admin.query('SELECT key FROM plugin_kv')).rows).toEqual([])
    } finally { await rules.shutdown(); await fixture.close() }
  }, 60000)

  it('public rule parser and effective update reject malformed read policy and invalid fields before persistence', async () => {
    const rules = new AutomationService(new EventBus(), db as never, async (statement, params) => admin.query(statement, params))
    const fixture = await ownerHttpFixture(rules)
    try {
      await authorizeRuleAuthoring()
      const before = await counts()
      const body = { name: 'Synthetic validated public rule', triggerType: 'record.created',
        actionType: AUTOMATION_READ_ACTION_TYPE, actionConfig: ruleConfig, enabled: true }
      const invalid = [
        { actionConfig: { ...ruleConfig, endpoint: 'synthetic-untrusted-endpoint' } },
        { actionConfig: { ...ruleConfig, allowManual: 'true' } },
        { executionMode: 'workflow_job_v1' },
        { actions: [{ type: AUTOMATION_READ_ACTION_TYPE, config: ruleConfig }, { type: 'update_record', config: { fields: {} } }] },
        { triggerType: 'form.submitted' },
        { conditions: { conjunction: 'AND', conditions: [{ fieldId: 'missing-field', operator: 'equals', value: 'synthetic' }] } },
      ]
      for (const candidate of invalid) {
        expect((await fixture.http.request('POST', rulesPath, { token: fixture.token, body: { ...body, ...candidate } })).status).toBe(400)
      }
      expect((await admin.query('SELECT id FROM automation_rules')).rows).toEqual([{ id: ruleId }])
      const created = await fixture.http.request('POST', rulesPath, { token: fixture.token, body })
      expect(created.status).toBe(200)
      const saved = responseData(created).rule as Row
      const persisted = (await admin.query('SELECT * FROM automation_rules WHERE id=$1', [saved.id])).rows
      for (const candidate of invalid) {
        expect((await fixture.http.request('PATCH', rulesPath + '/' + saved.id, { token: fixture.token, body: candidate })).status).toBe(400)
        expect((await admin.query('SELECT * FROM automation_rules WHERE id=$1', [saved.id])).rows).toEqual(persisted)
      }
      await admin.query('INSERT INTO meta_sheets(id,base_id) VALUES ($1,$2)', ['synthetic-other-sheet', baseId])
      const wrongSheet = '/api/multitable/sheets/synthetic-other-sheet/automations/' + saved.id
      expect((await fixture.http.request('PATCH', wrongSheet, { token: fixture.token, body: { name: 'Must not cross sheet' } })).status).toBe(404)
      expect((await admin.query('SELECT * FROM automation_rules WHERE id=$1', [saved.id])).rows).toEqual(persisted)
      expect(await counts()).toEqual(before)
      expect(fixture.nativeStatements).toEqual([])
      expect((await admin.query('SELECT key FROM plugin_kv')).rows).toEqual([])
    } finally { await rules.shutdown(); await fixture.close() }
  }, 60000)

  it('actual rule parser/service -> JWT options -> grant -> request -> native preview preserves business rows', async () => {
    const fixture = await ownerHttpFixture()
    const rules = new AutomationService(new EventBus(), db as never, async (statement, params) => admin.query(statement, params))
    try {
      // The existing lifecycle fixture's request is cancelled, never executed.
      await fixture.management.cancel(actor, fixture.requestId)
      const opts = { token: fixture.token }
      const parsed = parseCreateRuleInput({ name: 'Synthetic owner-authored read', triggerType: 'record.created',
        actionType: AUTOMATION_READ_ACTION_TYPE, actionConfig: ruleConfig, enabled: true }, actor.actorId)
      const saved = await rules.createRule(sheetId, parsed)
      expect(saved.created_by).toBe(actor.actorId)
      expect(saved.action_config).toEqual(ruleConfig)
      const metadataStart = statements.length
      const beforeDiscovery = await counts()
      const kvBefore = (await admin.query('SELECT key,value FROM plugin_kv ORDER BY key')).rows
      const options = await fixture.http.request('GET', ownerPath + '/options?sheetId=' + sheetId, opts)
      expect(options.status).toBe(200)
      expect(options.headers['cache-control']).toBe('no-store')
      const selected = (responseData(options).items as Array<{ selector: ReadSelector }>).find(item => item.selector.ruleId === saved.id)
      expect(selected).toMatchObject({ selector: { ...fixture.selector, ruleId: saved.id }, ruleName: saved.name,
        budget: { maxRows: 70, maxPages: 30, maxReadCount: 200, timeoutMs: 25000 }, allowedTriggers: ['manual', 'record'],
        recordActivationEligible: true, recordTriggerType: 'record.created', scheduleActivationEligible: false })
      expect(await counts()).toEqual(beforeDiscovery)
      expect((await admin.query('SELECT key,value FROM plugin_kv ORDER BY key')).rows).toEqual(kvBefore)
      expect(fixture.nativeStatements).toEqual([])
      expect(statements.slice(metadataStart).some(statement => /\bmeta_records\b|\bsyn_(?:path|order|part|bom)/iu.test(statement))).toBe(false)
      expect(JSON.stringify(options.body)).not.toMatch(/material|nonce|generation|authority|sourceReference|password|token|receipt/iu)
      const created = await fixture.http.request('POST', ownerPath + '/grants', { ...opts, body: {
        selector: selected!.selector, projects: ['SYN-PROJECT'], triggers: ['manual'],
        budget: { maxRows: 60, maxPages: 20, maxReadCount: 200, timeoutMs: 25000 },
        expiresAt: '2099-01-01T00:00:00.000Z', maxExecutions: 1,
      } })
      expect(created.status).toBe(201)
      expect(created.headers['cache-control']).toBe('no-store')
      const grantId = String(responseData(created).grantId)
      const input = { grantId, invocationId: randomUUID(), projectNo: 'SYN-PROJECT' }
      const submitted = await fixture.http.request('POST', ownerPath + '/requests', { ...opts, body: input })
      expect(submitted.status).toBe(202)
      const requestId = String(responseData(submitted).requestId)
      expect(responseData(submitted)).toEqual({ requestId, status: 'queued' })
      const before = (await admin.query('SELECT id,data FROM meta_records ORDER BY id')).rows
      const dispatch = await runDispatchTick(pool, fixture.registry, { batchSize: 2, adapterTimeoutMs: 30000 })
      expect(dispatch).toMatchObject({ completed: 2, rescheduled: 0 })
      const details = await fixture.http.request('GET', ownerPath + '/requests/' + requestId, opts)
      expect(details.status).toBe(200)
      expect(responseData(details)).toEqual({ requestId, status: 'succeeded', result: {
        status: 'ready', counts: { add: 1, update: 0, skip: 0, inactive: 0, manual_confirm: 0 }, canApply: false,
      } })
      const reads = fixture.nativeStatements.length
      expect(reads).toBeGreaterThan(7)
      const duplicate = await fixture.http.request('POST', ownerPath + '/requests', { ...opts, body: input })
      expect(duplicate.status).toBe(202)
      expect(responseData(duplicate)).toEqual({ requestId, status: 'succeeded' })
      expect(fixture.nativeStatements).toHaveLength(reads)
      const grants = await fixture.http.request('GET', ownerPath + '/grants?limit=20', opts)
      const requests = await fixture.http.request('GET', ownerPath + '/requests?grantId=' + grantId, opts)
      expect(grants.status).toBe(200); expect(requests.status).toBe(200)
      expect(responseData(requests).items).toEqual([expect.objectContaining({ requestId, grantId, status: 'succeeded' })])
      expect(JSON.stringify(requests.body)).not.toMatch(/result|counts|authority|sourceReference|source_reference|fence|outbox|invocationId|password/iu)
      expect(JSON.stringify(details.body)).not.toMatch(/token|authority|sourceReference|source_reference|fence|outbox|password/iu)
      expect((await admin.query('SELECT id,data FROM meta_records ORDER BY id')).rows).toEqual(before)
      expect((await admin.query('SELECT key FROM plugin_kv')).rows.every(row => String(row.key).startsWith('integration:b2a:'))).toBe(true)
    } finally { await rules.shutdown(); await fixture.close() }
  }, 90000)

  it('parallel owner metadata requests each execute real JWT/RBAC SQL without a cache-race evidence gap', async () => {
    const fixture = await ownerHttpFixture()
    try {
      const before = await counts()
      await admin.query(`INSERT INTO users(id,role,permissions,is_active,activation_status)
        VALUES ('synthetic-empty-history-admin','admin','[]',true,'activated')`)
      await admin.query("INSERT INTO user_roles VALUES ('synthetic-empty-history-admin','admin')")
      await admin.query('INSERT INTO user_orgs VALUES ($1,$2,true)', ['synthetic-empty-history-admin', actor.tenantId])
      const token = fixture.http.token({ actorId: 'synthetic-empty-history-admin', tenantId: actor.tenantId })
      // Empty owner history isolates the HTTP fixture's real RBAC evidence from
      // legitimate FOR UPDATE NOWAIT conflicts on a shared grant. The real panel
      // serializes metadata calls; this deliberately concurrent fixture probe
      // does not promise arbitrary concurrent private-ledger reads always succeed.
      const replies = await Promise.all([
        '/options?sheetId=' + sheetId, '/grants', '/requests',
      ].map(endpoint => fixture.http.request('GET', ownerPath + endpoint, { token })))
      for (const reply of replies) {
        expect(reply.status).toBe(200)
        expect(reply.headers['cache-control']).toBe('no-store')
        expect(responseData(reply).items).toHaveLength(0)
      }
      expect(await counts()).toEqual(before)
      expect(fixture.nativeStatements).toEqual([])
    } finally { await fixture.close() }
  }, 30000)

  it('real owner DOM linked retry: explicit new consent follows an unknown native attempt through JWT and dispatcher', async () => {
    const fixture = await ownerHttpFixture(undefined, false, 2)
    let parentId = '', parentGrantId = '', childId = '', cancelled = false, parentReads = 0
    let parentBefore: Row | undefined, parentGrantBefore: Row | undefined
    fixture.afterNative(async () => {
      if (!cancelled && parentId && (fixture.nativeStatements.at(-1) ?? '').includes('.syn_orderline')) {
        cancelled = true
        await fixture.management.cancel(actor, parentId)
      }
    })
    try {
      await optionRule('synthetic-retry-alternate')
      await admin.query(`INSERT INTO users(id,role,permissions,is_active,activation_status)
        VALUES ('synthetic-retry-browser-other','admin','[]',true,'activated')`)
      await admin.query("INSERT INTO user_roles VALUES ('synthetic-retry-browser-other','admin')")
      await admin.query('INSERT INTO user_orgs VALUES ($1,$2,true)', ['synthetic-retry-browser-other', actor.tenantId])
      const otherToken = fixture.http.token({ actorId: 'synthetic-retry-browser-other', tenantId: actor.tenantId })
      const before = (await admin.query('SELECT id,data FROM meta_records ORDER BY id')).rows
      const result = await runAutomationReadBrowserAcceptance({
        apiOrigin: fixture.http.apiOrigin, ownerToken: fixture.token, otherToken,
        sheetId, projectNo: 'SYN-PROJECT', expectedRuleId: ruleId,
        cacheDir: path.resolve(__dirname, '../../../../tmp/sa06ai-browser-' + randomUUID()),
        async afterSubmit(requestId, grantId) {
          parentId = requestId; parentGrantId = grantId
          expect(await fixture.runtime.execute(parentId, new AbortController().signal))
            .toEqual({ requestId: parentId, status: 'outcome_unknown' })
          expect(cancelled).toBe(true)
          parentReads = fixture.nativeStatements.length
          expect(parentReads).toBe(11)
          parentBefore = (await admin.query('SELECT * FROM integration_automation_read_requests WHERE id=$1', [parentId])).rows[0]
          parentGrantBefore = (await admin.query('SELECT * FROM integration_automation_read_grants WHERE id=$1', [parentGrantId])).rows[0]
        },
        manualLinkedRetry: { async afterRetry(requestId, grantId, originalId) {
          childId = requestId
          expect(originalId).toBe(parentId)
          expect(grantId).not.toBe(parentGrantId)
          expect(fixture.nativeStatements).toHaveLength(parentReads)
          expect(await runDispatchTick(pool, fixture.registry, { batchSize: 2, adapterTimeoutMs: 30000 }))
            .toMatchObject({ completed: 2, rescheduled: 0 })
          expect((await admin.query('SELECT status FROM integration_automation_read_requests WHERE id=$1', [childId])).rows[0].status).toBe('succeeded')
          expect(fixture.nativeStatements.length - parentReads).toBe(20)
        } },
        async observeCounters() { return { nativeReads: fixture.nativeStatements.length } },
        async beforeDenial() { await admin.query("DELETE FROM role_permissions WHERE permission_code='integration:admin'") },
        async beforeHistoryOnly() {
          await admin.query("INSERT INTO role_permissions VALUES ('integration_admin','integration:admin')")
          await fixture.runtime.stop()
        },
      })
      expect(result.requestId).toBe(childId)
      expect(result.linkedRetry).toEqual({ parentRequestId: parentId, parentGrantId, retryPosts: 1 })
      expect(result.preview).toEqual({ status: 'ready', counts: { add: 1, update: 0, skip: 0, inactive: 0, manual_confirm: 0 }, canApply: false })
      expect((await admin.query('SELECT * FROM integration_automation_read_requests WHERE id=$1', [parentId])).rows[0]).toEqual(parentBefore)
      expect((await admin.query('SELECT * FROM integration_automation_read_grants WHERE id=$1', [parentGrantId])).rows[0]).toEqual(parentGrantBefore)
      const claims = (await admin.query('SELECT run_id,registration_id FROM integration_b2a_operation_claim')).rows
      expect(claims).toHaveLength(2)
      expect(new Set(claims.map(row => row.registration_id)).size).toBe(2)
      expect(new Set(claims.map(row => row.run_id))).toEqual(new Set(['automation-read:' + parentId, 'automation-read:' + childId]))
      expect((await admin.query('SELECT used_executions FROM integration_automation_read_grants ORDER BY created_at')).rows)
        .toEqual([{ used_executions: 1 }, { used_executions: 1 }])
      expect(await counts()).toEqual({ grants: 2, requests: 2, outbox: 2 })
      expect((await admin.query('SELECT id,data FROM meta_records ORDER BY id')).rows).toEqual(before)
      expect((await admin.query('SELECT key FROM plugin_kv')).rows.every(row => String(row.key).startsWith('integration:b2a:'))).toBe(true)
    } finally { await fixture.close() }
  }, 120000)

  it.each(['service', 'public-editor'] as const)('real %s authoring -> owner DOM -> JWT/live roles -> dispatch -> native readonly preview', async (authoring) => {
    const rules = new AutomationService(new EventBus(), db as never, async (statement, params) => admin.query(statement, params))
    const fixture = await ownerHttpFixture(authoring === 'public-editor' ? rules : undefined)
    try {
      await fixture.management.cancel(actor, fixture.requestId)
      const saved = { id: '' }
      if (authoring === 'public-editor') await authorizeRuleAuthoring()
      else saved.id = (await rules.createRule(sheetId, parseCreateRuleInput({
        name: 'Synthetic browser-authored read', triggerType: 'record.created',
        actionType: AUTOMATION_READ_ACTION_TYPE, actionConfig: ruleConfig, enabled: true,
      }, actor.actorId))).id
      // The second session is an actual tenant member/admin, but not the source
      // owner or rule creator. Empty discovery must never expose the first owner.
      await admin.query(`INSERT INTO users(id,role,permissions,is_active,activation_status)
        VALUES ('synthetic-browser-other','admin','[]',true,'activated')`)
      await admin.query("INSERT INTO user_roles VALUES ('synthetic-browser-other','admin')")
      await admin.query('INSERT INTO user_orgs VALUES ($1,$2,true)', ['synthetic-browser-other', actor.tenantId])
      const publicAdminToken = fixture.http.token({ actorId: 'synthetic-browser-other', tenantId: actor.tenantId })
      const publicExecution = async (requestId: string, status: 'queued' | 'succeeded') => {
        const row = await executionAudit(requestId, saved.id, status)
        if (authoring !== 'public-editor') return
        const logs = await fixture.http.request('GET', '/api/multitable/sheets/' + sheetId + '/automations/' + saved.id + '/logs', { token: fixture.token })
        expect(logs.status).toBe(200)
        const ruleLog = (logs.body as { executions: Row[] }).executions.find(item => item.id === row.id)
        expect(ruleLog).toMatchObject({ integrationRead: { requestId, status }, status: row.status, steps: row.steps })
        expect(ruleLog).not.toHaveProperty('ruleSnapshot')
        expect(ruleLog).not.toHaveProperty('triggerEvent')
        // The public cross-rule API intentionally remains platform-admin-only;
        // the owner token does not gain that role merely by holding a read grant.
        const runs = '/api/multitable/automation-executions'
        expect((await fixture.http.request('GET', runs, { token: fixture.token })).status).toBe(403)
        const list = await fixture.http.request('GET', runs + '?ruleId=' + saved.id, { token: publicAdminToken })
        expect(list.status).toBe(200)
        const listed = (list.body as { executions: Row[] }).executions.find(item => item.id === row.id)
        const detail = await fixture.http.request('GET', runs + '/' + row.id, { token: publicAdminToken })
        expect(detail.status).toBe(200)
        expect(listed).toMatchObject({ integrationRead: { requestId, status }, statusLegacy: row.status })
        expect(detail.body).toMatchObject({ integrationRead: { requestId, status }, statusLegacy: row.status,
          triggerEvent: null, ruleSnapshot: null })
        for (const view of [ruleLog!, listed!, detail.body as Row]) {
          expect(Object.keys(view.integrationRead as Row).sort()).toEqual(['requestId', 'status'])
          for (const privateValue of ['SYN-PROJECT', systemId, connectionId, projectId, 'counts', 'canApply', 'selector']) {
            expect(JSON.stringify(view)).not.toContain(privateValue)
          }
        }
        const detailSteps = (detail.body as { steps: Row[] }).steps
        expect(detailSteps).toHaveLength(status === 'queued' ? 0 : 1)
        if (status === 'succeeded') expect(detailSteps[0].result).toEqual({ requestId, status })
      }
      const before = (await admin.query('SELECT id,data FROM meta_records ORDER BY id')).rows
      let dispatchedRequest = ''
      const result = await runAutomationReadBrowserAcceptance({
        apiOrigin: fixture.http.apiOrigin, ownerToken: fixture.token,
        otherToken: publicAdminToken,
        sheetId, projectNo: 'SYN-PROJECT', expectedRuleId: saved.id,
        cacheDir: path.resolve(__dirname, '../../../../tmp/sa06s-browser-' + randomUUID()),
        ...(authoring === 'public-editor' ? { authoring: { async afterSave(id: string) {
          saved.id = id
          expect((await admin.query(`SELECT name,created_by,action_type,action_config,actions FROM automation_rules WHERE id=$1`, [id])).rows)
            .toEqual([{ name: 'Synthetic DOM-authored readonly rule updated', created_by: actor.actorId,
              action_type: AUTOMATION_READ_ACTION_TYPE, action_config: ruleConfig,
              actions: [{ type: AUTOMATION_READ_ACTION_TYPE, config: ruleConfig }] }])
          expect(await counts()).toEqual({ grants: 1, requests: 1, outbox: 1 })
          expect(fixture.nativeStatements).toEqual([])
          expect((await admin.query('SELECT id,data FROM meta_records ORDER BY id')).rows).toEqual(before)
        } } } : {}),
        async afterSubmit(requestId, grantId) {
          dispatchedRequest = requestId
          expect(requestId).not.toBe(fixture.requestId)
          expect(grantId).not.toBe(fixture.grantId)
          expect(fixture.nativeStatements).toEqual([])
          const grant = (await admin.query(`SELECT selector,projects,triggers,max_executions,used_executions
            FROM integration_automation_read_grants WHERE id=$1`, [grantId])).rows[0]
          expect(grant).toMatchObject({ selector: { ruleId: saved.id }, projects: ['SYN-PROJECT'], triggers: ['manual'],
            max_executions: 1, used_executions: 0 })
          expect(await counts()).toEqual({ grants: 2, requests: 2, outbox: 2 })
          await publicExecution(requestId, 'queued')
          expect(await runDispatchTick(pool, fixture.registry, { batchSize: 2, adapterTimeoutMs: 30000 }))
            .toMatchObject({ completed: 2, rescheduled: 0 })
          await publicExecution(requestId, 'succeeded')
          expect((await admin.query('SELECT id,data FROM meta_records ORDER BY id')).rows).toEqual(before)
          expect((await admin.query('SELECT used_executions FROM integration_automation_read_grants WHERE id=$1', [grantId]))
            .rows[0].used_executions).toBe(1)
        },
        async observeCounters() { return { nativeReads: fixture.nativeStatements.length } },
        async beforeDenial() {
          // A genuine live permission loss, not a stubbed 403 or client claims
          // edit. AuthService cache invalidation is performed by the HTTP fixture.
          await admin.query("DELETE FROM role_permissions WHERE permission_code='integration:admin'")
        },
        async beforeHistoryOnly() {
          await admin.query("INSERT INTO role_permissions VALUES ('integration_admin','integration:admin')")
          await fixture.runtime.stop()
        },
      })
      expect(result.requestId).toBe(dispatchedRequest)
      if (authoring === 'public-editor') {
        expect(result.authoredRuleId).toBe(saved.id)
        expect(result.publicCrud).toEqual({ creates: 1, updates: 1, reads: 1, defaultTenantHint: true })
      }
      expect(result.preview).toEqual({ status: 'ready',
        counts: { add: 1, update: 0, skip: 0, inactive: 0, manual_confirm: 0 }, canApply: false })
      expect(fixture.nativeStatements.length).toBeGreaterThan(7)
      expect(await counts()).toEqual({ grants: 2, requests: 2, outbox: 2 })
      expect((await admin.query('SELECT id,data FROM meta_records ORDER BY id')).rows).toEqual(before)
      expect((await admin.query('SELECT run_id FROM integration_b2a_operation_claim')).rows).toHaveLength(1)
      // No apply token is minted; only the independently durable B2a consumption
      // ledger is permitted in plugin KV after this readonly preview.
      expect((await admin.query('SELECT key FROM plugin_kv')).rows
        .every(row => String(row.key).startsWith('integration:b2a:'))).toBe(true)
      // The real renewal timer may lose NOWAIT to an authority SHARE reader.
      // stop() was awaited by beforeHistoryOnly, so this is a settled count:
      // accept only those observed SQL collisions, never arbitrary diagnostics.
      const diagnostics = fixture.scheduleDiagnostics()
      expect(diagnostics.observationOverflow).toBe(false)
      expect(diagnostics.queryFailures).toEqual(Array.from({ length: fixture.renewalLockConflicts() },
        () => ({ stage: 'producer-renewal', code: '55P03' })))
      expect(fixture.unavailable, 'SYNTHETIC_AUTHORING_FACTS_' + JSON.stringify({
        queryFailures: diagnostics.queryFailures, execution: diagnostics.execution, preview: diagnostics.preview,
      })).toHaveBeenCalledTimes(fixture.renewalLockConflicts())
    } finally { await rules.shutdown(); await fixture.close() }
  }, 120000)

  it.each([
    ['record.created', false], ['record.updated', false], ['record.created', true], ['record.updated', true],
  ] as const)('real owner DOM explicitly activates a record-only rule (%s, saved conditions=%s); durable record admission and read worker produce only a readonly preview', async (triggerType, conditional) => {
    const rules = new AutomationService(new EventBus(), db as never, async (statement, params) => admin.query(statement, params))
    const fixture = await ownerHttpFixture(rules, false)
    try {
      const conditionField = 'synthetic-automatic-condition'
      if (conditional) await admin.query('INSERT INTO meta_fields(id,sheet_id,name,type,property) VALUES ($1,$2,$1,\'string\',\'{}\')',
        [conditionField, sheetId])
      const saved = await rules.createRule(sheetId, parseCreateRuleInput({
        name: 'Synthetic browser record-only read', triggerType,
        ...(conditional ? { conditions: { logic: 'and', conditions: [{ fieldId: conditionField, operator: 'equals', value: 'accepted' }] } } : {}),
        actionType: AUTOMATION_READ_ACTION_TYPE, actionConfig: { ...ruleConfig, allowManual: false }, enabled: true,
      }, actor.actorId))
      await admin.query(`INSERT INTO users(id,role,permissions,is_active,activation_status)
        VALUES ('synthetic-record-browser-other','admin','[]',true,'activated')`)
      await admin.query("INSERT INTO user_roles VALUES ('synthetic-record-browser-other','admin')")
      await admin.query('INSERT INTO user_orgs VALUES ($1,$2,true)', ['synthetic-record-browser-other', actor.tenantId])
      const otherToken = fixture.http.token({ actorId: 'synthetic-record-browser-other', tenantId: actor.tenantId })
      let business = (await admin.query('SELECT id,data FROM meta_records ORDER BY id')).rows
      const unexpected = async (): Promise<never> => { throw new Error('SYNTHETIC_UNEXPECTED_UNRELATED_CONSUMER') }
      const handlers = buildDurableConsumerHandlers({ automationService: rules,
        automationReadRecord: { produce: fixture.runtime.produceRecord }, projectionService: { reconcile: unexpected },
        webhookService: { deliverEvent: unexpected }, recordApprovalService: { handleApprovalCompletion: unexpected },
        todoMirrorService: { handleApprovalTaskCreated: unexpected, handleApprovalCompletion: unexpected } })
      const all = buildConsumerAdapterRegistry(handlers, createAutomationReadDelivery({ transaction, execute: fixture.runtime.execute }))
      const recordOnly = new ConsumerAdapterRegistry(), readOnly = new ConsumerAdapterRegistry()
      recordOnly.register(all.get('automation-record-trigger')!)
      readOnly.register(all.get(AUTOMATION_READ_CONSUMER)!)
      const ordinary = vi.spyOn(rules, 'handleDurableRecordEvent')
      const genericExecute = vi.spyOn(rules, 'executeRule')
      let activatedId = '', dispatchedRequest = ''
      const result = await runAutomationReadBrowserAcceptance({
        apiOrigin: fixture.http.apiOrigin, ownerToken: fixture.token, otherToken,
        sheetId, projectNo: 'SYN-PROJECT', expectedRuleId: saved.id,
        cacheDir: path.resolve(__dirname, '../../../../tmp/sa06w-browser-' + randomUUID()),
        recordActivation: { triggerType, async afterActivate(activationId, grantId) {
          activatedId = activationId
          expect(await counts()).toEqual({ grants: 1, requests: 0, outbox: 0 })
          expect(fixture.nativeStatements).toEqual([])
          expect((await admin.query(`SELECT purpose,selector,projects,triggers,max_executions,used_executions
            FROM integration_automation_read_grants WHERE id=$1`, [grantId])).rows[0])
            .toMatchObject({ purpose: 'automatic', selector: { ruleId: saved.id }, projects: ['SYN-PROJECT'],
              triggers: ['record'], max_executions: 1, used_executions: 0 })
          expect((await admin.query('SELECT id,grant_id FROM integration_automation_read_record_activations')).rows)
            .toEqual([{ id: activationId, grant_id: grantId }])
          if (conditional) expect((await admin.query('SELECT condition_confirmation FROM integration_automation_read_record_activations')).rows[0])
            .toMatchObject({ condition_confirmation: { mode: 'saved_conditions', schemaRevision: expect.any(String), businessTimeZone: expect.any(String) } })
          const eventId = randomUUID()
          // The updated event is a committed zero-field patch, not a full-row
          // snapshot or a proof of a changed value. Neither form chooses project.
          // This conditional fixture uses actual INSERT/UPDATE RETURNING and
          // production snapshot helpers, not an HTTP record-write endpoint.
          const produceImage = async (id: string, data: Row) => transaction(async trx => {
            const schemaToken = await captureAutomationRecordSchema(trx, sheetId, { AUTOMATION_DURABLE_DELIVERY_ENABLED: 'true' })
            const recordId = 'synthetic-condition-' + randomUUID()
            if (triggerType === 'record.updated') await trx.query('INSERT INTO meta_records(id,sheet_id,data) VALUES ($1,$2,\'{}\')', [recordId, sheetId])
            const written = triggerType === 'record.created'
              ? await trx.query('INSERT INTO meta_records(id,sheet_id,data) VALUES ($1,$2,$3::jsonb) RETURNING data::text AS raw,version', [recordId, sheetId, JSON.stringify(data)])
              : await trx.query('UPDATE meta_records SET data=$2::jsonb,version=version+1 WHERE id=$1 RETURNING data::text AS raw,version', [recordId, JSON.stringify(data)])
            const receipt = await enqueueOutboxEvent(trx, { eventType: `multitable.${triggerType}`, eventId: id,
              payload: { sheetId, recordId, data: {} } }, CURRENT_ROUTING_MANIFEST)
            await persistAutomationRecordAfterImage(trx, receipt, { sheetId, recordId, schema: schemaToken,
              recordVersion: Number(written.rows[0].version), data: undefined, rawJson: written.rows[0].raw as string })
            return receipt
          })
          if (conditional) {
            for (const data of [{ [conditionField]: 'rejected' }, {}]) {
              await produceImage(randomUUID(), data)
              expect(await runDispatchTick(pool, recordOnly, { batchSize: 1 })).toMatchObject({ completed: 1, rescheduled: 0 })
              expect((await counts()).requests).toBe(0)
              expect((await admin.query('SELECT used_executions FROM integration_automation_read_grants WHERE id=$1', [grantId])).rows)
                .toEqual([{ used_executions: 0 }])
              expect((await admin.query('SELECT request_id FROM integration_automation_read_executions')).rows).toEqual([])
              expect(fixture.nativeStatements).toEqual([])
            }
          }
          const produced = conditional ? await produceImage(eventId, { [conditionField]: 'accepted' })
            : await transaction(trx => enqueueOutboxEvent(trx, { eventType: `multitable.${triggerType}`, eventId,
              payload: { sheetId, recordId: 'synthetic-browser-record',
                data: triggerType === 'record.updated' ? {} : { projectNo: 'IGNORED-EVENT-PROJECT' } } }, CURRENT_ROUTING_MANIFEST))
          business = (await admin.query('SELECT id,data FROM meta_records ORDER BY id')).rows
          expect(await runDispatchTick(pool, recordOnly, { batchSize: 1 })).toMatchObject({ completed: 1, rescheduled: 0 })
          expect(ordinary).toHaveBeenCalledTimes(conditional ? 3 : 1)
          expect(genericExecute).not.toHaveBeenCalled()
          const request = (await admin.query(`SELECT id,status,trigger_type,grant_id,project_no
            FROM integration_automation_read_requests`)).rows[0]
          expect(request).toMatchObject({ status: 'queued', trigger_type: 'record', grant_id: grantId, project_no: 'SYN-PROJECT' })
          expect((await admin.query('SELECT invocation_id FROM integration_automation_read_requests WHERE id=$1', [request.id])).rows[0])
            .toEqual({ invocation_id: `record-read:${createHash('sha256').update(JSON.stringify([
              activationId, `multitable.${triggerType}`, eventId,
            ])).digest('hex')}` })
          expect(fixture.nativeStatements).toEqual([])
          await executionAudit(String(request.id), saved.id, 'queued')
          expect((await admin.query('SELECT consumer_key,status FROM meta_automation_outbox_consumer WHERE outbox_id=$1 ORDER BY consumer_key', [produced.outboxId])).rows)
            .toEqual([{ consumer_key: 'automation-record-trigger', status: 'done' }, { consumer_key: 'webhook-event-bridge', status: 'pending' }])
          if (conditional) {
            // Admitted replay depends on the saved request, not snapshot retention.
            await admin.query('DELETE FROM meta_automation_record_after_images WHERE outbox_id=$1', [produced.outboxId])
            await admin.query("UPDATE meta_automation_outbox_consumer SET status='pending',lease_expires_at=NULL WHERE outbox_id=$1 AND consumer_key='automation-record-trigger'", [produced.outboxId])
            expect(await runDispatchTick(pool, recordOnly, { batchSize: 1 })).toMatchObject({ completed: 1, rescheduled: 0 })
            expect((await counts()).requests).toBe(1)
          }
          return { requestId: String(request.id) }
        } },
        async afterSubmit(requestId, grantId) {
          dispatchedRequest = requestId
          expect(await counts()).toEqual({ grants: 1, requests: 1, outbox: conditional ? 4 : 2 })
          expect(fixture.nativeStatements).toEqual([])
          expect(await runDispatchTick(pool, readOnly, { batchSize: 1, adapterTimeoutMs: 30000 }))
            .toMatchObject({ completed: 1, rescheduled: 0 })
          await executionAudit(requestId, saved.id, 'succeeded')
          expect((await admin.query('SELECT used_executions FROM integration_automation_read_grants WHERE id=$1', [grantId]))
            .rows[0].used_executions).toBe(1)
          expect((await admin.query('SELECT id,data FROM meta_records ORDER BY id')).rows).toEqual(business)
        },
        async observeCounters() { return { nativeReads: fixture.nativeStatements.length } },
        async beforeDenial() { await admin.query("DELETE FROM role_permissions WHERE permission_code='integration:admin'") },
        async beforeHistoryOnly() {
          await admin.query("INSERT INTO role_permissions VALUES ('integration_admin','integration:admin')")
          await fixture.runtime.stop()
        },
      })
      expect(result.requestId).toBe(dispatchedRequest)
      expect(result.recordActivation).toEqual({ activationId: activatedId, activationPosts: 1, automaticPurpose: true })
      expect(result.counts).toMatchObject({ apiPosts: 2, grantPosts: 0, submitPosts: 0, revokePosts: 1,
        ownerDeniedGets: 1, nonOwnerPosts: 0, unexpectedRequests: 0, pageErrors: 0 })
      expect(result.preview).toEqual({ status: 'ready',
        counts: { add: 1, update: 0, skip: 0, inactive: 0, manual_confirm: 0 }, canApply: false })
      expect(await counts()).toEqual({ grants: 1, requests: 1, outbox: conditional ? 4 : 2 })
      expect((await admin.query('SELECT status,purpose,used_executions FROM integration_automation_read_grants')).rows)
        .toEqual([{ status: 'revoked', purpose: 'automatic', used_executions: 1 }])
      expect((await admin.query('SELECT id,data FROM meta_records ORDER BY id')).rows).toEqual(business)
      expect((await admin.query('SELECT key FROM plugin_kv')).rows
        .every(row => String(row.key).startsWith('integration:b2a:'))).toBe(true)
      const diagnostics = fixture.scheduleDiagnostics()
      expect(diagnostics.observationOverflow).toBe(false)
      expect(diagnostics.queryFailures).toEqual(Array.from({ length: fixture.renewalLockConflicts() },
        () => ({ stage: 'producer-renewal', code: '55P03' })))
      expect(fixture.unavailable, 'SYNTHETIC_RECORD_FACTS_' + JSON.stringify({
        queryFailures: diagnostics.queryFailures,
        unavailableCalls: fixture.unavailable.mock.calls.length, renewalLockConflicts: fixture.renewalLockConflicts(),
        execution: diagnostics.execution, preview: fixture.diagnostic(),
      })).toHaveBeenCalledTimes(fixture.renewalLockConflicts())
    } finally { await rules.shutdown(); await fixture.close() }
  }, 120000)

  it('real HTTP record creation: owner DOM conditional consent → production REST save → durable record admission → native readonly preview', async () => {
    const previousDurableFlag = process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED
    process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = 'true'
    const rules = new AutomationService(new EventBus(), db as never, async (statement, params) => admin.query(statement, params))
    try {
      // This is the production sheet-scoped write permission, established before
      // discovery/consent. Integration administration is not record write access.
      await authorizeRuleAuthoring()
      const fixture = await ownerHttpFixture(rules, false)
      try {
        const conditionField = 'synthetic-http-record-condition'
        await admin.query('INSERT INTO meta_fields(id,sheet_id,name,type,property) VALUES ($1,$2,$1,\'string\',\'{}\')',
          [conditionField, sheetId])
        const { invalidateSheetDisplayNameCaches } = await import('../../src/routes/univer-meta')
        invalidateSheetDisplayNameCaches(sheetId)
        const saved = await rules.createRule(sheetId, parseCreateRuleInput({
          name: 'Synthetic HTTP conditional record read', triggerType: 'record.created',
          conditions: { logic: 'and', conditions: [{ fieldId: conditionField, operator: 'equals', value: 'accepted' }] },
          actionType: AUTOMATION_READ_ACTION_TYPE, actionConfig: { ...ruleConfig, allowManual: false }, enabled: true,
        }, actor.actorId))
        await admin.query(`INSERT INTO users(id,role,permissions,is_active,activation_status)
          VALUES ('synthetic-http-record-other','admin','[]',true,'activated')`)
        await admin.query("INSERT INTO user_roles VALUES ('synthetic-http-record-other','admin')")
        await admin.query('INSERT INTO user_orgs VALUES ($1,$2,true)', ['synthetic-http-record-other', actor.tenantId])
        const otherToken = fixture.http.token({ actorId: 'synthetic-http-record-other', tenantId: actor.tenantId })
        const unexpected = async (): Promise<never> => { throw new Error('SYNTHETIC_UNEXPECTED_UNRELATED_CONSUMER') }
        const handlers = buildDurableConsumerHandlers({ automationService: rules,
          automationReadRecord: { produce: fixture.runtime.produceRecord }, projectionService: { reconcile: unexpected },
          webhookService: { deliverEvent: unexpected }, recordApprovalService: { handleApprovalCompletion: unexpected },
          todoMirrorService: { handleApprovalTaskCreated: unexpected, handleApprovalCompletion: unexpected } })
        const all = buildConsumerAdapterRegistry(handlers, createAutomationReadDelivery({ transaction, execute: fixture.runtime.execute }))
        const recordOnly = new ConsumerAdapterRegistry(), readOnly = new ConsumerAdapterRegistry()
        recordOnly.register(all.get('automation-record-trigger')!)
        readOnly.register(all.get(AUTOMATION_READ_CONSUMER)!)
        const ordinary = vi.spyOn(rules, 'handleDurableRecordEvent')
        const genericExecute = vi.spyOn(rules, 'executeRule')
        let business: Row[] = [], activatedId = '', dispatchedRequest = ''
        const readBusiness = async (): Promise<Row[]> => (await admin.query(`SELECT id,sheet_id,data,version,
          created_by,modified_by,created_at,updated_at FROM meta_records ORDER BY id`)).rows
        const sourceOutboxIds: string[] = []
        const result = await runAutomationReadBrowserAcceptance({
          apiOrigin: fixture.http.apiOrigin, ownerToken: fixture.token, otherToken,
          sheetId, projectNo: 'SYN-PROJECT', expectedRuleId: saved.id,
          cacheDir: path.resolve(__dirname, '../../../../tmp/sa06af-browser-' + randomUUID()),
          recordActivation: { triggerType: 'record.created', async afterActivate(activationId, grantId) {
            activatedId = activationId
            expect(await counts()).toEqual({ grants: 1, requests: 0, outbox: 0 })
            expect((await admin.query('SELECT purpose,triggers,projects,used_executions FROM integration_automation_read_grants WHERE id=$1', [grantId])).rows)
              .toEqual([{ purpose: 'automatic', triggers: ['record'], projects: ['SYN-PROJECT'], used_executions: 0 }])
            const confirmation = (await admin.query(`SELECT condition_confirmation,rule_revision,activated_at
              FROM integration_automation_read_record_activations WHERE id=$1`, [activationId])).rows[0]
            expect(confirmation.condition_confirmation).toEqual({ mode: 'saved_conditions',
              schemaRevision: expect.stringMatching(/^[a-f0-9-]{36}$/u), businessTimeZone: expect.any(String) })
            expect(confirmation.rule_revision).toBe((await admin.query('SELECT integration_authority_revision FROM automation_rules WHERE id=$1', [saved.id])).rows[0].integration_authority_revision)
            const beforeDenied = await counts()
            expect((await fixture.http.request('POST', '/api/multitable/records', {
              body: { sheetId, data: { [conditionField]: 'accepted' } },
            })).status).toBe(401)
            expect(await counts()).toEqual(beforeDenied)
            expect((await admin.query('SELECT id FROM meta_records')).rows).toEqual([])
            expect((await admin.query('SELECT id FROM meta_record_revisions')).rows).toEqual([])
            const createThroughHttp = async (value: string) => {
              // No test INSERT/enqueue/persist: the real JWT router/RecordService
              // owns the DML, revision, source event and private schema evidence.
              const reply = await fixture.http.request('POST', '/api/multitable/records', {
                token: fixture.token, body: { sheetId, data: { [conditionField]: value } },
              })
              expect(reply.status).toBe(200)
              const record = responseData(reply).record as Row
              expect(record).toEqual({ id: expect.stringMatching(/^rec_[a-f0-9-]{36}$/u), version: 1,
                data: { [conditionField]: value } })
              if (typeof record.id !== 'string') throw new Error('SYNTHETIC_HTTP_RECORD_RECEIPT_REQUIRED')
              const rows = (await admin.query(`SELECT r.id,r.data,r.version,r.created_by,
                o.id AS outbox_id,o.event_type,o.event_id,o.payload,o.created_at AS event_created_at,
                i.outbox_id AS image_outbox_id,i.event_id AS image_event_id,i.event_type AS image_event_type,
                i.sheet_id AS image_sheet_id,i.record_id AS image_record_id,i.record_version,i.format_version,
                i.status AS image_status,i.reason,i.after_image,i.schema_revision,
                v.action AS revision_action,v.source AS revision_source,v.version AS revision_version,
                v.actor_id,v.changed_field_ids,v.patch,v.snapshot
                FROM meta_records r JOIN meta_automation_outbox o ON o.payload->>'recordId'=r.id
                JOIN meta_automation_record_after_images i ON i.outbox_id=o.id
                JOIN meta_record_revisions v ON v.record_id=r.id AND v.sheet_id=r.sheet_id
                WHERE r.id=$1 AND o.event_type='multitable.record.created'`, [record.id])).rows
              expect(rows).toHaveLength(1)
              const source = rows[0]
              expect(source).toMatchObject({ id: record.id, data: record.data, version: 1, created_by: actor.actorId,
                outbox_id: expect.any(String), event_type: 'multitable.record.created', event_id: expect.any(String),
                payload: { sheetId, recordId: record.id, data: record.data, actorId: actor.actorId },
                image_sheet_id: sheetId, image_record_id: record.id, format_version: 1,
                image_status: 'captured', reason: null, after_image: record.data,
                schema_revision: (confirmation.condition_confirmation as Row).schemaRevision,
                revision_action: 'create', revision_source: 'rest', revision_version: 1,
                actor_id: actor.actorId, changed_field_ids: [conditionField], patch: record.data, snapshot: record.data })
              expect(Number(source.record_version)).toBe(1)
              expect(source.image_outbox_id).toBe(source.outbox_id)
              expect(source.image_event_id).toBe(source.event_id)
              expect(source.image_event_type).toBe(source.event_type)
              expect(new Date(source.event_created_at).getTime()).toBeGreaterThan(new Date(confirmation.activated_at).getTime())
              expect((await admin.query("SELECT revision FROM automation_read_material_epochs WHERE kind='sheet' AND scope=jsonb_build_object('id',$1::text)", [sheetId])).rows[0].revision)
                .toBe(source.schema_revision)
              sourceOutboxIds.push(String(source.outbox_id))
              return source
            }
            await createThroughHttp('rejected')
            expect(await runDispatchTick(pool, recordOnly, { batchSize: 1 })).toMatchObject({ completed: 1, rescheduled: 0 })
            expect(await counts()).toEqual({ grants: 1, requests: 0, outbox: 1 })
            expect((await admin.query('SELECT used_executions FROM integration_automation_read_grants WHERE id=$1', [grantId])).rows)
              .toEqual([{ used_executions: 0 }])
            expect((await admin.query('SELECT request_id FROM integration_automation_read_executions')).rows).toEqual([])
            expect(fixture.nativeStatements).toEqual([])
            const matched = await createThroughHttp('accepted')
            // Compare against the committed HTTP saves, not the pre-write empty
            // table. Only the worker must be readonly; these writes are intended.
            business = await readBusiness()
            expect(await runDispatchTick(pool, recordOnly, { batchSize: 1 })).toMatchObject({ completed: 1, rescheduled: 0 })
            expect(ordinary).toHaveBeenCalledTimes(2)
            expect(genericExecute).not.toHaveBeenCalled()
            expect(await counts()).toEqual({ grants: 1, requests: 1, outbox: 3 })
            const request = (await admin.query('SELECT id,status,trigger_type,grant_id,project_no,invocation_id FROM integration_automation_read_requests')).rows[0]
            expect(request).toMatchObject({ status: 'queued', trigger_type: 'record', grant_id: grantId, project_no: 'SYN-PROJECT',
              invocation_id: `record-read:${createHash('sha256').update(JSON.stringify([
                activationId, 'multitable.record.created', matched.event_id,
              ])).digest('hex')}` })
            expect((await admin.query('SELECT used_executions FROM integration_automation_read_grants WHERE id=$1', [grantId])).rows)
              .toEqual([{ used_executions: 0 }])
            expect(fixture.nativeStatements).toEqual([])
            await executionAudit(String(request.id), saved.id, 'queued')
            return { requestId: String(request.id) }
          } },
          async afterSubmit(requestId, grantId) {
            dispatchedRequest = requestId
            expect(await runDispatchTick(pool, readOnly, { batchSize: 1, adapterTimeoutMs: 30000 }))
              .toMatchObject({ completed: 1, rescheduled: 0 })
            await executionAudit(requestId, saved.id, 'succeeded')
            expect(fixture.nativeStatements.length).toBeGreaterThan(0)
            expect((await admin.query('SELECT used_executions FROM integration_automation_read_grants WHERE id=$1', [grantId])).rows)
              .toEqual([{ used_executions: 1 }])
            expect(await readBusiness()).toEqual(business)
            for (const outboxId of sourceOutboxIds) expect((await admin.query(`SELECT consumer_key,status
              FROM meta_automation_outbox_consumer WHERE outbox_id=$1 ORDER BY consumer_key`, [outboxId])).rows)
              .toEqual([{ consumer_key: 'automation-record-trigger', status: 'done' }, { consumer_key: 'webhook-event-bridge', status: 'pending' }])
          },
          async observeCounters() { return { nativeReads: fixture.nativeStatements.length } },
          async beforeDenial() { await admin.query("DELETE FROM role_permissions WHERE permission_code='integration:admin'") },
          async beforeHistoryOnly() {
            await admin.query("INSERT INTO role_permissions VALUES ('integration_admin','integration:admin')")
            await fixture.runtime.stop()
          },
        })
        expect(result.requestId).toBe(dispatchedRequest)
        expect(result.recordActivation).toEqual({ activationId: activatedId, activationPosts: 1, automaticPurpose: true })
        expect(result.counts).toMatchObject({ apiPosts: 2, grantPosts: 0, submitPosts: 0, revokePosts: 1,
          ownerDeniedGets: 1, nonOwnerPosts: 0, unexpectedRequests: 0, pageErrors: 0 })
        expect(result.preview).toEqual({ status: 'ready',
          counts: { add: 1, update: 0, skip: 0, inactive: 0, manual_confirm: 0 }, canApply: false })
        expect(await counts()).toEqual({ grants: 1, requests: 1, outbox: 3 })
        expect((await admin.query('SELECT status,purpose,used_executions FROM integration_automation_read_grants')).rows)
          .toEqual([{ status: 'revoked', purpose: 'automatic', used_executions: 1 }])
        expect(await readBusiness()).toEqual(business)
      } finally { await fixture.close() }
    } finally {
      await rules.shutdown()
      if (previousDurableFlag === undefined) delete process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED
      else process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = previousDurableFlag
    }
  }, 120000)

  it('real HTTP record creation: close drains the actual postcommit handler after its socket is forcibly closed', async () => {
    const previousDurableFlag = process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED
    process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = 'true'
    const rules = new AutomationService(new EventBus(), db as never, async (statement, params) => admin.query(statement, params))
    const { poolManager } = await import('../../src/integration/db/connection-pool')
    const infrastructure = poolManager.get()
    // Capture the real underlying pool before the fixture replaces its getter.
    // Cleanup may re-pin its transport, but never sends it a probe query.
    const originalInternalPool = infrastructure.getInternalPool()
    try {
      await authorizeRuleAuthoring()
      const fixture = await ownerHttpFixture(rules, false)
      let releaseHeld!: () => void, entered!: () => void
      const held = new Promise<void>(resolve => { releaseHeld = resolve })
      const enteredHandler = new Promise<void>(resolve => { entered = resolve })
      const originalCreate = RecordService.prototype.createRecord
      const createdRecords: string[] = []
      const createSpy = vi.spyOn(RecordService.prototype, 'createRecord').mockImplementation(async function(this: RecordService, input) {
        const result = await originalCreate.call(this, input)
        createdRecords.push(result.recordId)
        // The original production method has really committed its DML/revision/
        // event. Do not replace its result; delay only delivery to the route,
        // whose response masking/echo SQL is still outstanding.
        entered()
        await held
        return result
      })
      let closing: Promise<void> | undefined
      let closeSettled = false
      let requestOutcome: Promise<{ kind: 'reply'; status: number } | { kind: 'rejected' }> | undefined
      const cleanupSpies: Array<{ mockRestore(): void }> = []
      try {
        const { invalidateSheetDisplayNameCaches } = await import('../../src/routes/univer-meta')
        invalidateSheetDisplayNameCaches(sheetId)
        // Capture rejection immediately; the real socket fallback is expected
        // to reject this client while the actual server handler remains held.
        requestOutcome = fixture.http.request('POST', '/api/multitable/records', {
          token: fixture.token, body: { sheetId, data: { [fieldMap.notes]: 'synthetic-close-drain' } },
        }).then(reply => ({ kind: 'reply' as const, status: reply.status }), () => ({ kind: 'rejected' as const }))
        await Promise.race([enteredHandler, requestOutcome.then(() => {
          throw new Error('SYNTHETIC_HTTP_HANDLER_NOT_HELD')
        })])
        expect(createdRecords).toHaveLength(1)
        expect(fixture.http.pendingHandlerCount()).toBeGreaterThan(0)
        closing = fixture.http.close()
        void closing.catch(() => {})
        void closing.then(() => { closeSettled = true }, () => { closeSettled = true })
        expect(await requestOutcome).toEqual({ kind: 'rejected' })
        // Let already-ready close callbacks settle; no guessed fixed sleep is
        // used to infer drain completion after the real socket rejection.
        await new Promise<void>(resolve => setImmediate(resolve))
        expect(closeSettled).toBe(false)
        expect(infrastructure.getInternalPool()).toBe(pool)
        // Only after the owned-pool identity check may this test inspect SQL.
        expect((await admin.query('SELECT id,version,data FROM meta_records')).rows)
          .toEqual([{ id: createdRecords[0], version: 1, data: { [fieldMap.notes]: 'synthetic-close-drain' } }])
        expect((await admin.query('SELECT record_id,action,source FROM meta_record_revisions')).rows)
          .toEqual([{ record_id: createdRecords[0], action: 'create', source: 'rest' }])
        releaseHeld()
        // This waits for the actual route Promise, including its postcommit
        // echo/masking, not merely createRecord or the destroyed response.
        await fixture.http.drainHandlers()
        await closing
        expect(fixture.http.pendingHandlerCount()).toBe(0)
        expect(closeSettled).toBe(true)
        expect(fixture.nativeStatements).toEqual([])
      } finally {
        // Mutation-safe cleanup: a missing drain can restore the original DB
        // transports early. Re-pin BEFORE releasing the held result, then wait
        // for the complete route tail. No probe ever touches the original pool.
        if (fixture.http.pendingHandlerCount() > 0) {
          if (originalInternalPool !== pool) cleanupSpies.push(vi.spyOn(originalInternalPool, 'connect')
            .mockImplementation(pool.connect.bind(pool)))
          cleanupSpies.push(vi.spyOn(infrastructure, 'query').mockImplementation((sql, params) => pool.query(sql, params)))
          cleanupSpies.push(vi.spyOn(infrastructure, 'getInternalPool').mockReturnValue(pool))
          const pgModule = await import('../../src/db/pg')
          if (pgModule.pool && pgModule.pool !== pool) cleanupSpies.push(vi.spyOn(pgModule.pool, 'query')
            .mockImplementation(pool.query.bind(pool)))
        }
        releaseHeld()
        try {
          await fixture.http.drainHandlers()
          await (closing ?? fixture.http.close())
          await requestOutcome
        } finally {
          createSpy.mockRestore()
          for (const spy of cleanupSpies.reverse()) spy.mockRestore()
          await fixture.close()
        }
      }
    } finally {
      await rules.shutdown()
      if (previousDurableFlag === undefined) delete process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED
      else process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = previousDurableFlag
    }
  }, 60000)

  it('real interval create registration: persisted creation phase reaches native preview without reload or update', async () => {
    const fixture = await runtimeFixture(false)
    let timeout: ReturnType<typeof setTimeout> | undefined
    let produced!: () => void, rejected!: (error: unknown) => void
    const admitted = new Promise<void>((resolve, reject) => { produced = resolve; rejected = reject })
    void admitted.catch(() => {})
    let admittedPlan: ReadScheduleOccurrence | undefined
    const rules = new AutomationService(new EventBus(), db as never, async (statement, params) => admin.query(statement, params),
      undefined, null, {}, undefined, { async produce(occurrence, signal) {
        try {
          await fixture.runtime.produceSchedule(occurrence, signal)
          const queued = (await admin.query("SELECT id FROM integration_automation_read_requests WHERE status='queued'")).rows
          if (queued.length === 1) { admittedPlan = occurrence; produced() }
        } catch (error) { rejected(error); throw error }
      } })
    try {
      const business = (await admin.query('SELECT id,data,version,modified_by,updated_at FROM meta_records ORDER BY id')).rows
      const saved = await rules.createRule(sheetId, parseCreateRuleInput({ name: 'Synthetic immediate interval read',
        triggerType: 'schedule.interval', triggerConfig: { intervalMs: 1501 }, actionType: AUTOMATION_READ_ACTION_TYPE,
        actionConfig: { ...ruleConfig, allowManual: false }, enabled: true,
      }, actor.actorId))
      const row = (await admin.query(`SELECT integration_authority_revision::text AS revision,
        floor(extract(epoch FROM created_at)*1000)::text AS anchor FROM automation_rules WHERE id=$1`, [saved.id])).rows[0]
      expect(new Date(saved.created_at).getTime()).toBe(Number(row.anchor))
      expect(await counts()).toEqual({ grants: 0, requests: 0, outbox: 0 })
      const pair = await fixture.runtime.activateSchedule(actor, { activationKey: randomUUID(), expectedRuleRevision: String(row.revision),
        selector: { ...fixture.selector, ruleId: saved.id }, projectNo: 'SYN-PROJECT',
        budget: { maxRows: 60, maxPages: 20, maxReadCount: 200, timeoutMs: 25000 },
        maxExecutions: 1, expiresAt: '2099-01-01T00:00:00.000Z' })
      await Promise.race([admitted, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('SYNTHETIC_IMMEDIATE_INTERVAL_TIMEOUT')), 10000)
      })])
      clearTimeout(timeout); timeout = undefined
      await rules.stopProducerAdmissions()
      expect(admittedPlan).toMatchObject({ ruleId: saved.id, triggerType: 'schedule.interval', intervalMs: 1501, anchorMs: Number(row.anchor) })
      expect((admittedPlan!.scheduledAtMs - Number(row.anchor)) % 1501).toBe(0)
      expect(await counts()).toEqual({ grants: 1, requests: 1, outbox: 1 })
      expect(fixture.nativeStatements).toEqual([])
      expect(await runDispatchTick(pool, fixture.registry, { batchSize: 1, adapterTimeoutMs: 30000 })).toMatchObject({ completed: 1, rescheduled: 0 })
      const request = (await admin.query('SELECT id FROM integration_automation_read_requests WHERE grant_id=$1', [pair.grantId])).rows[0]
      const management = createAutomationReadManagement({ transaction, manifest: CURRENT_ROUTING_MANIFEST })
      expect(await management.observe(actor, String(request.id))).toMatchObject({ status: 'succeeded', result: { status: 'ready', canApply: false } })
      expect(fixture.nativeStatements.length).toBeGreaterThan(0)
      expect((await admin.query('SELECT id,data,version,modified_by,updated_at FROM meta_records ORDER BY id')).rows).toEqual(business)
    } finally {
      if (timeout) clearTimeout(timeout)
      await rules.shutdown()
      await fixture.close()
    }
  }, 45000)

  it.each(['cron', 'interval', 'date_field'] as const)('real owner DOM explicitly activates %s; the actual wall-clock scheduler and read worker produce only a readonly preview', async family => {
    const authoring = new AutomationService(new EventBus(), db as never, async (statement, params) => admin.query(statement, params))
    let fixture: Awaited<ReturnType<typeof ownerHttpFixture>>
    try {
      if (family === 'interval') await authorizeRuleAuthoring()
      fixture = await ownerHttpFixture(family === 'interval' ? authoring : undefined, false)
    } catch (error) {
      try { await authoring.shutdown() }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'SYNTHETIC_SCHEDULE_SETUP_CLEANUP_FAILED') }
      throw error
    }
    let scheduled: AutomationService | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const dateFieldId = 'synthetic-browser-due', dateRecordId = 'synthetic-browser-date-record'
      let dateDueAt = 0, dateDueIso = ''
      let dateConfig: { dateFieldId: string; offsetDays: number; direction: 'before'; timeOfDay: string; timezone: string } | undefined
      if (family === 'date_field') {
        // Keep actual DB time, immutable activation cutover and real timers.
        // Allow headroom for the real browser build/consent, not a backdated grant.
        await admin.query("INSERT INTO meta_fields(id,sheet_id,name,type,property) VALUES ($1,$2,$1,'date','{}')", [dateFieldId, sheetId])
        const dbNow = Number((await admin.query('SELECT extract(epoch FROM clock_timestamp())*1000 AS ms')).rows[0].ms)
        dateDueAt = Math.ceil((dbNow + 90000) / 60000) * 60000
        dateDueIso = new Date(dateDueAt).toISOString()
        dateConfig = { dateFieldId, offsetDays: 0, direction: 'before', timeOfDay: dateDueIso.slice(11, 16), timezone: 'UTC' }
        await admin.query('INSERT INTO meta_records(id,sheet_id,data,version) VALUES($1,$2,$3::jsonb,1)',
          [dateRecordId, sheetId, JSON.stringify({ [dateFieldId]: dateDueIso.slice(0, 10) })])
      }
      let saved: { id: string } = family === 'interval' ? { id: ruleId } : await authoring.createRule(sheetId, parseCreateRuleInput({
        name: 'Synthetic browser schedule-only read', triggerType: family === 'date_field' ? 'schedule.date_field' : 'schedule.cron',
        triggerConfig: dateConfig ?? { expression: '* * * * *', timezone: 'UTC' },
        actionType: AUTOMATION_READ_ACTION_TYPE, actionConfig: { ...ruleConfig, allowManual: false }, enabled: true,
      }, actor.actorId))
      // Actual authoring can register schedules. Shut that instance down before
      // the DOM consent, then use a fresh production service after activation.
      if (family !== 'interval') await authoring.shutdown()
      await admin.query(`INSERT INTO users(id,role,permissions,is_active,activation_status)
        VALUES ('synthetic-cron-browser-other','admin','[]',true,'activated')`)
      await admin.query("INSERT INTO user_roles VALUES ('synthetic-cron-browser-other','admin')")
      await admin.query('INSERT INTO user_orgs VALUES ($1,$2,true)', ['synthetic-cron-browser-other', actor.tenantId])
      const otherToken = fixture.http.token({ actorId: 'synthetic-cron-browser-other', tenantId: actor.tenantId })
      const business = (await admin.query('SELECT id,data FROM meta_records ORDER BY id')).rows
      const dateBusinessTables = ['meta_bases', 'meta_sheets', 'meta_fields', 'meta_records', 'meta_record_revisions',
        'syn_pathlink', 'syn_path', 'syn_order', 'syn_orderline', 'syn_part', 'syn_bom', 'syn_bomline'] as const
      const snapshotDateBusiness = async () => {
        const snapshot: Row = {}
        if (family === 'date_field') for (const table of dateBusinessTables) snapshot[table] = (await admin.query(
          'SELECT row_to_json(b) AS row FROM ' + table + ' b ORDER BY row_to_json(b)::text COLLATE "C"')).rows
        return snapshot
      }
      const dateBusiness = await snapshotDateBusiness()
      let activatedId = '', dispatchedRequest = ''
      const result = await runAutomationReadBrowserAcceptance({
        apiOrigin: fixture.http.apiOrigin, ownerToken: fixture.token, otherToken,
        sheetId, projectNo: 'SYN-PROJECT', expectedRuleId: saved.id,
        cacheDir: path.resolve(__dirname, '../../../../tmp/sa06y-browser-' + randomUUID()),
        screenshotDir: path.resolve(__dirname, family === 'date_field'
          ? '../../../../artifacts/automation-read-sa06at' : '../../../../artifacts/automation-read-sa06y'),
        ...(family === 'interval' ? { authoring: { intervalSeconds: '1.501', async afterSave(id: string) {
          saved = { id }
          const row = (await admin.query('SELECT trigger_type,trigger_config,action_config FROM automation_rules WHERE id=$1', [id])).rows[0]
          expect(row).toMatchObject({ trigger_type: 'schedule.interval', trigger_config: { intervalMs: 1501 },
            action_config: { allowManual: false } })
          await authoring.shutdown()
        } } } : {}),
        scheduleActivation: { expectedTriggerType: `schedule.${family}` as const, async afterActivate(activationId, grantId) {
          activatedId = activationId
          expect(await counts()).toEqual({ grants: 1, requests: 0, outbox: 0 })
          expect(fixture.nativeStatements).toEqual([])
          expect((await admin.query(`SELECT purpose,selector,projects,triggers,max_executions,used_executions
            FROM integration_automation_read_grants WHERE id=$1`, [grantId])).rows[0])
            .toMatchObject({ purpose: 'automatic', selector: { ruleId: saved.id }, projects: ['SYN-PROJECT'],
              triggers: ['schedule'], max_executions: 1, used_executions: 0 })
          const activationRow = (await admin.query(`SELECT id,grant_id,activated_at,trigger_type,interval_anchor_ms,cron_config,date_field_confirmation
            FROM integration_automation_read_schedule_activations`)).rows
          expect(activationRow).toHaveLength(1)
          expect(activationRow[0]).toMatchObject({ id: activationId, grant_id: grantId })
          expect(activationRow[0].trigger_type).toBe('schedule.' + family)
          if (family === 'date_field') {
            expect(activationRow[0]).toMatchObject({ interval_anchor_ms: null,
              date_field_confirmation: { fieldId: dateFieldId, fieldType: 'date', schemaRevision: expect.any(String) },
              cron_config: dateConfig })
            expect(new Date(activationRow[0].activated_at).getTime()).toBeLessThan(dateDueAt)
            // If the environment missed the real future boundary, fail honestly.
            // Never alter the saved rule/cutover after the owner's confirmation.
            expect(Date.now()).toBeLessThan(dateDueAt)
          }
          expect((await admin.query('SELECT id FROM integration_automation_read_record_activations')).rows).toEqual([])
          let planned: ReadScheduleOccurrence | undefined
          const callbackFacts: Array<{ sameRule: boolean; minuteDelta: number; completionOrder: number; resolved: boolean }> = []
          let callbackCount = 0, completedCallbacks = 0
          let acceptedDateWake: ReadScheduleOccurrence | undefined
          let accept!: () => void, reject!: (error: unknown) => void
          const admitted = new Promise<void>((resolve, fail) => { accept = resolve; reject = fail })
          void admitted.catch(() => {})
          scheduled = new AutomationService(new EventBus(), db as never,
            async (statement, params) => admin.query(statement, params), undefined, null, {}, undefined,
            { async produce(occurrence, signal) {
              // Observe/forward only, never synthesize a minute or substitute
              // the actual runtime, authority, SQL transaction or producer.
              planned ??= occurrence
              callbackCount++
              const fact = { sameRule: occurrence.ruleId === saved.id,
                minuteDelta: (occurrence.scheduledAtMs - planned.scheduledAtMs) / 60000, completionOrder: 0, resolved: false }
              if (callbackFacts.length < 2) callbackFacts.push(fact)
              fixture.observeClockAt(occurrence.scheduledAtMs)
              const admissionStarted = performance.now()
              try {
                await fixture.runtime.produceSchedule(occurrence, signal)
                fact.completionOrder = ++completedCallbacks; fact.resolved = true
                if (family === 'date_field') {
                  // Startup is identified by its original wake. It never
                  // resolves admission, even if a timer commits while it drains.
                  if (occurrence.scheduledAtMs < dateDueAt) return
                  expect(occurrence).toEqual({ ruleId: saved.id, triggerType: 'schedule.date_field', scheduledAtMs: dateDueAt })
                  const receipts = (await admin.query(`SELECT d.request_id,d.record_id,d.occurrence_at_utc
                    FROM integration_automation_read_date_occurrences d
                    JOIN integration_automation_read_requests r ON r.id=d.request_id AND r.grant_id=$2 AND r.status='queued'
                    JOIN meta_automation_outbox o ON o.id=r.outbox_id AND o.payload->>'requestId'=r.id::text
                    WHERE d.activation_id=$1`, [activationId, grantId])).rows
                  expect(receipts).toEqual([{ request_id: expect.any(String), record_id: dateRecordId, occurrence_at_utc: dateDueIso }])
                  acceptedDateWake = occurrence
                }
                accept()
              } catch (error) {
                // Test-only, bounded/values-free observation of the ORIGINAL
                // refusal. No extra clock query, retry, replacement or tolerance.
                if (callbackCount <= 2) process.stderr.write('SA06AG_SCHEDULE_REFUSAL ' + JSON.stringify({
                  family, callbackCount, signalAborted: signal.aborted,
                  elapsedMs: performance.now() - admissionStarted,
                  hostLateByMs: Date.now() - occurrence.scheduledAtMs,
                  diagnostics: fixture.scheduleDiagnostics(),
                }) + '\n')
                fact.completionOrder = ++completedCallbacks; reject(error); throw error
              }
            } })
          const genericExecute = vi.spyOn(scheduled, 'executeRule')
          await scheduled.loadAndRegisterAllScheduled()
          await Promise.race([admitted, new Promise<never>((_resolve, fail) => {
            timeout = setTimeout(() => fail(new Error('SYNTHETIC_BROWSER_SCHEDULE_TIMEOUT')), family === 'date_field' ? 185000 : 65000)
          })])
          clearTimeout(timeout); timeout = undefined
          await scheduled.stopProducerAdmissions()
          if (family === 'date_field') {
            expect(acceptedDateWake).toBeDefined()
            expect(callbackCount).toBeGreaterThanOrEqual(1)
            expect(callbackCount).toBeLessThanOrEqual(2)
            expect(callbackFacts).toHaveLength(callbackCount)
            expect(callbackFacts.every(fact => fact.sameRule && fact.resolved)).toBe(true)
            expect(completedCallbacks).toBe(callbackCount)
          } else expect({ callbackCount, callbackFacts }, 'SYNTHETIC_BROWSER_CRON_CALLBACK_FACTS')
            .toEqual({ callbackCount: 1, callbackFacts: [{ sameRule: true, minuteDelta: 0, completionOrder: 1, resolved: true }] })
          expect(planned?.ruleId).toBe(saved.id)
          if (family === 'cron') expect(planned!.scheduledAtMs % 60000).toBe(0)
          else if (family === 'interval') {
            const anchorMs = Number(activationRow[0].interval_anchor_ms)
            expect(planned).toMatchObject({ triggerType: 'schedule.interval', intervalMs: 1501, anchorMs })
            expect((planned!.scheduledAtMs - anchorMs) % 1501).toBe(0)
            expect(planned!.scheduledAtMs).toBeGreaterThan(anchorMs)
            const phase = (await admin.query('SELECT floor(extract(epoch FROM created_at)*1000)::text AS anchor FROM automation_rules WHERE id=$1', [saved.id])).rows[0]
            expect(Number(phase.anchor)).toBe(anchorMs)
          }
          expect((acceptedDateWake ?? planned)!.scheduledAtMs).toBeGreaterThan(new Date(activationRow[0].activated_at).getTime())
          expect(genericExecute).not.toHaveBeenCalled()
          const request = (await admin.query(`SELECT id,status,trigger_type,grant_id,project_no
            FROM integration_automation_read_requests`)).rows[0]
          expect(request, 'SYNTHETIC_SCHEDULE_FACTS_' + JSON.stringify(fixture.scheduleDiagnostics()))
            .toMatchObject({ status: 'queued', trigger_type: 'schedule', grant_id: grantId, project_no: 'SYN-PROJECT' })
          expect(await counts()).toEqual({ grants: 1, requests: 1, outbox: 1 })
          expect(fixture.nativeStatements).toEqual([])
          if (family === 'date_field') {
            const initial = (await admin.query(`SELECT request_id,record_id,occurrence_at_utc
              FROM integration_automation_read_date_occurrences`)).rows
            // Explicit replay of the scheduler's own immutable wake is deduped;
            // the first request above still came only from the actual timer.
            await fixture.runtime.produceSchedule(acceptedDateWake!, new AbortController().signal)
            expect((await admin.query(`SELECT request_id,record_id,occurrence_at_utc
              FROM integration_automation_read_date_occurrences`)).rows).toEqual(initial)
            expect(initial).toEqual([{ request_id: request.id, record_id: dateRecordId, occurrence_at_utc: dateDueIso }])
            expect(await counts()).toEqual({ grants: 1, requests: 1, outbox: 1 })
            expect(await snapshotDateBusiness()).toEqual(dateBusiness)
          }
          await executionAudit(String(request.id), saved.id, 'queued')
          return { requestId: String(request.id) }
        } },
        async afterSubmit(requestId, grantId) {
          dispatchedRequest = requestId
          expect(fixture.nativeStatements).toEqual([])
          expect(await runDispatchTick(pool, fixture.registry, { batchSize: 1, adapterTimeoutMs: 30000 }))
            .toMatchObject({ completed: 1, rescheduled: 0 })
          await executionAudit(requestId, saved.id, 'succeeded')
          expect((await admin.query('SELECT used_executions FROM integration_automation_read_grants WHERE id=$1', [grantId]))
            .rows[0].used_executions).toBe(1)
          expect((await admin.query('SELECT id,data FROM meta_records ORDER BY id')).rows).toEqual(business)
          expect(await snapshotDateBusiness()).toEqual(dateBusiness)
        },
        async observeCounters() { return { nativeReads: fixture.nativeStatements.length } },
        async beforeDenial() { await admin.query("DELETE FROM role_permissions WHERE permission_code='integration:admin'") },
        async beforeHistoryOnly() {
          await admin.query("INSERT INTO role_permissions VALUES ('integration_admin','integration:admin')")
          await fixture.runtime.stop()
        },
      })
      expect(result.requestId).toBe(dispatchedRequest)
      expect(result.scheduleActivation).toEqual({ activationId: activatedId, activationPosts: 1, automaticPurpose: true,
        ...(family === 'date_field' ? { dateFieldConsent: true } : {}) })
      expect(result.recordActivation).toBeUndefined()
      if (family === 'interval') expect(result.authoredRuleId).toBe(saved.id)
      expect(result.counts).toMatchObject({ apiPosts: 2, grantPosts: 0, submitPosts: 0, revokePosts: 1,
        ownerDeniedGets: 1, nonOwnerPosts: 0, unexpectedRequests: 0, pageErrors: 0 })
      expect(result.preview).toEqual({ status: 'ready',
        counts: { add: 1, update: 0, skip: 0, inactive: 0, manual_confirm: 0 }, canApply: false })
      expect(await counts()).toEqual({ grants: 1, requests: 1, outbox: 1 })
      expect((await admin.query('SELECT status,purpose,used_executions FROM integration_automation_read_grants')).rows)
        .toEqual([{ status: 'revoked', purpose: 'automatic', used_executions: 1 }])
      expect((await admin.query('SELECT id,data FROM meta_records ORDER BY id')).rows).toEqual(business)
      expect(await snapshotDateBusiness()).toEqual(dateBusiness)
      expect((await admin.query('SELECT key FROM plugin_kv')).rows
        .every(row => String(row.key).startsWith('integration:b2a:'))).toBe(true)
      await fixture.runtime.stop()
      expect(fixture.unavailable).toHaveBeenCalledTimes(fixture.renewalLockConflicts())
    } finally {
      if (timeout) clearTimeout(timeout)
      try { await scheduled?.shutdown() }
      finally {
        try { await authoring.shutdown() }
        finally {
          try { await fixture.runtime.stopScheduleAdmissions() }
          finally { await fixture.close() }
        }
      }
    }
  }, 240000)

  it('real owner DOM date linked retry: explicit new consent uses a second independent source permit after an unknown native date attempt', async () => {
    const authoring = new AutomationService(new EventBus(), db as never, async (statement, params) => admin.query(statement, params))
    let fixture: Awaited<ReturnType<typeof ownerHttpFixture>>
    try {
      // Both one-use source permissions exist before the owner opens the UI.
      // Neither the retry POST nor the new budget issues another permission.
      fixture = await ownerHttpFixture(undefined, false, 2)
    } catch (error) {
      try { await authoring.shutdown() }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'SYNTHETIC_DATE_RETRY_SETUP_CLEANUP_FAILED') }
      throw error
    }
    let scheduled: AutomationService | undefined, timer: ReturnType<typeof setTimeout> | undefined
    let activationId = '', parentId = '', parentGrantId = '', childId = '', childGrantId = ''
    let cancelled = false, parentNativeReads = 0
    let acceptedWake: ReadScheduleOccurrence | undefined, parentBefore: Row[] | undefined
    const parentSnapshot = async () => (await admin.query(`SELECT to_jsonb(g) AS grant,to_jsonb(r) AS request,
      to_jsonb(a) AS activation,to_jsonb(d) AS receipt
      FROM integration_automation_read_requests r JOIN integration_automation_read_grants g ON g.id=r.grant_id
      JOIN integration_automation_read_date_occurrences d ON d.request_id=r.id
      JOIN integration_automation_read_schedule_activations a ON a.id=d.activation_id WHERE r.id=$1`, [parentId])).rows
    fixture.afterNative(async () => {
      // The call-through observer runs only after the actual native driver has
      // returned this first source row query. Cancellation cannot undo that IO.
      if (!cancelled && parentId && fixture.nativeStatements.at(-1)?.includes('.syn_orderline')) {
        cancelled = true
        const reply = await fixture.http.request('POST', ownerPath + '/requests/' + parentId + '/cancel', { token: fixture.token })
        expect(reply.status).toBe(200)
        expect(responseData(reply)).toEqual({ requestId: parentId, status: 'outcome_unknown' })
      }
    })
    try {
      const dateFieldId = 'synthetic-browser-retry-due', dateRecordId = 'synthetic-browser-retry-date-record'
      await admin.query("INSERT INTO meta_fields(id,sheet_id,name,type,property) VALUES ($1,$2,$1,'date','{}')", [dateFieldId, sheetId])
      const dbNow = Number((await admin.query('SELECT extract(epoch FROM clock_timestamp())*1000 AS ms')).rows[0].ms)
      // Real DB time and unchanged activation cutover, with browser build and
      // consent headroom. A missed boundary fails instead of backdating history.
      const dueAt = Math.ceil((dbNow + 90000) / 60000) * 60000, dueIso = new Date(dueAt).toISOString()
      const dateConfig = { dateFieldId, offsetDays: 0, direction: 'before', timeOfDay: dueIso.slice(11, 16), timezone: 'UTC' }
      await admin.query('INSERT INTO meta_records(id,sheet_id,data,version) VALUES($1,$2,$3::jsonb,1)',
        [dateRecordId, sheetId, JSON.stringify({ [dateFieldId]: dueIso.slice(0, 10) })])
      const saved = await authoring.createRule(sheetId, parseCreateRuleInput({
        name: 'Synthetic browser date linked retry', triggerType: 'schedule.date_field', triggerConfig: dateConfig,
        actionType: AUTOMATION_READ_ACTION_TYPE, actionConfig: { ...ruleConfig, allowManual: false }, enabled: true,
      }, actor.actorId))
      await authoring.shutdown()
      expect((await admin.query('SELECT trigger_type,trigger_config,action_config FROM automation_rules WHERE id=$1', [saved.id])).rows[0])
        .toMatchObject({ trigger_type: 'schedule.date_field', trigger_config: dateConfig, action_config: { allowManual: false } })
      await admin.query(`INSERT INTO users(id,role,permissions,is_active,activation_status)
        VALUES ('synthetic-date-retry-browser-other','admin','[]',true,'activated')`)
      await admin.query("INSERT INTO user_roles VALUES ('synthetic-date-retry-browser-other','admin')")
      await admin.query('INSERT INTO user_orgs VALUES ($1,$2,true)', ['synthetic-date-retry-browser-other', actor.tenantId])
      const otherToken = fixture.http.token({ actorId: 'synthetic-date-retry-browser-other', tenantId: actor.tenantId })
      const businessTables = ['meta_bases', 'meta_sheets', 'meta_fields', 'meta_records', 'meta_record_revisions',
        'syn_pathlink', 'syn_path', 'syn_order', 'syn_orderline', 'syn_part', 'syn_bom', 'syn_bomline'] as const
      const snapshotBusiness = async () => {
        const snapshot: Row = {}
        for (const table of businessTables) snapshot[table] = (await admin.query(
          'SELECT row_to_json(b) AS row FROM ' + table + ' b ORDER BY row_to_json(b)::text COLLATE "C"')).rows
        return snapshot
      }
      const business = await snapshotBusiness()
      const result = await runAutomationReadBrowserAcceptance({
        apiOrigin: fixture.http.apiOrigin, ownerToken: fixture.token, otherToken,
        sheetId, projectNo: 'SYN-PROJECT', expectedRuleId: saved.id,
        cacheDir: path.resolve(__dirname, '../../../../tmp/sa06av-browser-' + randomUUID()),
        screenshotDir: path.resolve(__dirname, '../../../../artifacts/automation-read-sa06av'),
        scheduleActivation: { expectedTriggerType: 'schedule.date_field', async afterActivate(id, grantId) {
          activationId = id; parentGrantId = grantId
          expect(await counts()).toEqual({ grants: 1, requests: 0, outbox: 0 })
          expect(fixture.nativeStatements).toEqual([])
          const activation = (await admin.query(`SELECT id,grant_id,activated_at,trigger_type,cron_config,date_field_confirmation
            FROM integration_automation_read_schedule_activations WHERE id=$1`, [id])).rows[0]
          expect(activation).toMatchObject({ id, grant_id: grantId, trigger_type: 'schedule.date_field', cron_config: dateConfig,
            date_field_confirmation: { fieldId: dateFieldId, fieldType: 'date', schemaRevision: expect.any(String) } })
          expect(new Date(activation.activated_at).getTime()).toBeLessThan(dueAt)
          expect(Date.now()).toBeLessThan(dueAt)
          let accept!: () => void, reject!: (error: unknown) => void
          const admitted = new Promise<void>((resolve, fail) => { accept = resolve; reject = fail })
          void admitted.catch(() => {})
          scheduled = new AutomationService(new EventBus(), db as never,
            async (statement, params) => admin.query(statement, params), undefined, null, {}, undefined,
            { async produce(occurrence, signal) {
              try {
                fixture.observeClockAt(occurrence.scheduledAtMs)
                await fixture.runtime.produceSchedule(occurrence, signal)
                // Classify the original wake, never callback completion time or
                // a startup query observing a later timer's committed request.
                if (occurrence.scheduledAtMs < dueAt) return
                expect(occurrence).toEqual({ ruleId: saved.id, triggerType: 'schedule.date_field', scheduledAtMs: dueAt })
                const receipts = (await admin.query(`SELECT d.request_id,d.record_id,d.occurrence_at_utc
                  FROM integration_automation_read_date_occurrences d
                  JOIN integration_automation_read_requests r ON r.id=d.request_id AND r.grant_id=$2 AND r.status='queued'
                  JOIN meta_automation_outbox o ON o.id=r.outbox_id AND o.payload->>'requestId'=r.id::text
                  WHERE d.activation_id=$1`, [id, grantId])).rows
                expect(receipts).toEqual([{ request_id: expect.any(String), record_id: dateRecordId, occurrence_at_utc: dueIso }])
                acceptedWake = occurrence
                parentId = String(receipts[0].request_id)
                accept()
              } catch (error) { reject(error); throw error }
            } })
          const ordinary = vi.spyOn(scheduled, 'executeRule')
          await scheduled.loadAndRegisterAllScheduled()
          await Promise.race([admitted, new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('SYNTHETIC_BROWSER_DATE_RETRY_SCHEDULE_TIMEOUT')), 185000)
          })])
          clearTimeout(timer); timer = undefined
          await scheduled.stopProducerAdmissions()
          expect(acceptedWake).toEqual({ ruleId: saved.id, triggerType: 'schedule.date_field', scheduledAtMs: dueAt })
          expect(ordinary).not.toHaveBeenCalled()
          expect(await counts()).toEqual({ grants: 1, requests: 1, outbox: 1 })
          expect(fixture.nativeStatements).toEqual([])
          expect(await snapshotBusiness()).toEqual(business)
          await executionAudit(parentId, saved.id, 'queued')
          return { requestId: parentId }
        } },
        async afterSubmit(requestId, grantId) {
          expect(requestId).toBe(parentId); expect(grantId).toBe(parentGrantId)
          expect(await runDispatchTick(pool, fixture.registry, { batchSize: 1, adapterTimeoutMs: 30000 }))
            .toMatchObject({ completed: 1, rescheduled: 0 })
          expect(cancelled).toBe(true)
          fixture.afterNative()
          expect(await fixture.management.observe(actor, parentId)).toEqual({ requestId: parentId, status: 'outcome_unknown', result: null })
          await executionAudit(parentId, saved.id, 'outcome_unknown')
          parentNativeReads = fixture.nativeStatements.length
          expect(parentNativeReads).toBe(11)
          expect(fixture.nativeStatements.filter(statement => statement.includes('.syn_orderline'))).toHaveLength(1)
          expect((await admin.query('SELECT run_id,registration_id FROM integration_b2a_operation_claim')).rows)
            .toEqual([{ run_id: 'automation-read:' + parentId, registration_id: 'synthetic-automation-preview' }])
          parentBefore = await parentSnapshot()
          expect(parentBefore).toHaveLength(1)
          expect(parentBefore[0]).toMatchObject({ grant: { purpose: 'automatic', triggers: ['schedule'], max_executions: 1, used_executions: 1 },
            request: { status: 'outcome_unknown', trigger_type: 'schedule', project_no: 'SYN-PROJECT' },
            activation: { id: activationId }, receipt: { request_id: parentId, record_id: dateRecordId, occurrence_at_utc: dueIso } })
          expect(await snapshotBusiness()).toEqual(business)
        },
        dateLinkedRetry: { async afterRetry(requestId, grantId, originalId) {
          childId = requestId; childGrantId = grantId
          expect(originalId).toBe(parentId); expect(childId).not.toBe(parentId); expect(childGrantId).not.toBe(parentGrantId)
          expect(fixture.nativeStatements).toHaveLength(parentNativeReads)
          expect((await admin.query('SELECT parent_request_id,date_parent_request_id FROM integration_automation_read_retries WHERE request_id=$1', [childId])).rows)
            .toEqual([{ parent_request_id: parentId, date_parent_request_id: parentId }])
          expect(await runDispatchTick(pool, fixture.registry, { batchSize: 1, adapterTimeoutMs: 30000 }))
            .toMatchObject({ completed: 1, rescheduled: 0 })
          await executionAudit(childId, saved.id, 'succeeded')
          expect(await fixture.management.observe(actor, childId)).toMatchObject({ requestId: childId, status: 'succeeded',
            result: { status: 'ready', canApply: false } })
          expect(fixture.nativeStatements.length - parentNativeReads).toBe(20)
          expect((await admin.query('SELECT purpose,triggers,max_executions,used_executions FROM integration_automation_read_grants WHERE id=$1', [childGrantId])).rows)
            .toEqual([{ purpose: 'retry', triggers: ['schedule'], max_executions: 1, used_executions: 1 }])
          const claims = (await admin.query('SELECT run_id,registration_id FROM integration_b2a_operation_claim ORDER BY registration_id')).rows
          expect(claims).toEqual([
            { run_id: 'automation-read:' + parentId, registration_id: 'synthetic-automation-preview' },
            { run_id: 'automation-read:' + childId, registration_id: 'synthetic-automation-preview-second' },
          ])
          expect(await parentSnapshot()).toEqual(parentBefore)
          expect(await snapshotBusiness()).toEqual(business)
          const reads = fixture.nativeStatements.length
          // Redeliver the exact committed child outbox through the dispatcher;
          // do not replace the runtime or manufacture a fresh request/permit.
          expect((await admin.query(`UPDATE meta_automation_outbox_consumer SET status='pending',lease_expires_at=NULL
            WHERE outbox_id=(SELECT outbox_id FROM integration_automation_read_requests WHERE id=$1)
              AND consumer_key=$2 AND status='done'`, [childId, AUTOMATION_READ_CONSUMER])).rowCount).toBe(1)
          expect(await runDispatchTick(pool, fixture.registry, { batchSize: 1, adapterTimeoutMs: 30000 }))
            .toMatchObject({ completed: 1, rescheduled: 0 })
          expect(fixture.nativeStatements).toHaveLength(reads)
          expect((await admin.query('SELECT run_id,registration_id FROM integration_b2a_operation_claim ORDER BY registration_id')).rows).toEqual(claims)
          await fixture.runtime.produceSchedule(acceptedWake!, new AbortController().signal)
          expect(fixture.nativeStatements).toHaveLength(reads)
          expect(await counts()).toEqual({ grants: 2, requests: 2, outbox: 2 })
          expect(await parentSnapshot()).toEqual(parentBefore)
          expect(await snapshotBusiness()).toEqual(business)
        } },
        async observeCounters() { return { nativeReads: fixture.nativeStatements.length } },
        async beforeDenial() { await admin.query("DELETE FROM role_permissions WHERE permission_code='integration:admin'") },
        async beforeHistoryOnly() {
          await admin.query("INSERT INTO role_permissions VALUES ('integration_admin','integration:admin')")
          await fixture.runtime.stop()
        },
      })
      expect(result.requestId).toBe(childId); expect(result.grantId).toBe(childGrantId)
      expect(result.scheduleActivation).toEqual({ activationId, activationPosts: 1, automaticPurpose: true, dateFieldConsent: true })
      expect(result.linkedRetry).toEqual({ parentRequestId: parentId, parentGrantId, retryPosts: 1, dateLinkedRetryConsent: true })
      expect(result.recordActivation).toBeUndefined()
      expect(result.screenshots?.retryConsent).toEqual(expect.any(String))
      expect(result.counts).toMatchObject({ apiPosts: 3, grantPosts: 0, submitPosts: 0, revokePosts: 1,
        ownerDeniedGets: 1, nonOwnerPosts: 0, unexpectedRequests: 0, pageErrors: 0 })
      expect(result.preview).toEqual({ status: 'ready', counts: { add: 1, update: 0, skip: 0, inactive: 0, manual_confirm: 0 }, canApply: false })
      expect(await parentSnapshot()).toEqual(parentBefore)
      expect((await admin.query('SELECT request_id FROM integration_automation_read_date_occurrences')).rows).toEqual([{ request_id: parentId }])
      expect((await admin.query('SELECT status,purpose,triggers,used_executions FROM integration_automation_read_grants ORDER BY created_at')).rows)
        .toEqual([{ status: 'active', purpose: 'automatic', triggers: ['schedule'], used_executions: 1 },
          { status: 'revoked', purpose: 'retry', triggers: ['schedule'], used_executions: 1 }])
      expect(await counts()).toEqual({ grants: 2, requests: 2, outbox: 2 })
      expect(await snapshotBusiness()).toEqual(business)
      expect((await admin.query('SELECT key FROM plugin_kv')).rows.every(row => String(row.key).startsWith('integration:b2a:'))).toBe(true)
      expect(fixture.unavailable).toHaveBeenCalledTimes(fixture.renewalLockConflicts())
    } finally {
      fixture.afterNative()
      if (timer) clearTimeout(timer)
      try { await scheduled?.shutdown() }
      finally {
        try { await authoring.shutdown() }
        finally {
          try { await fixture.runtime.stopScheduleAdmissions() }
          finally { await fixture.close() }
        }
      }
    }
  }, 240000)

  it('real JWT authentication and all thirteen owner routes reject nonowners, claimless headers, and revoked membership', async () => {
    const fixture = await ownerHttpFixture()
    try {
      const endpoints = [
        ['GET', '/options?sheetId=' + sheetId],
        ['POST', '/grants', { selector: fixture.selector, projects: ['SYN-PROJECT'], triggers: ['manual'],
          budget: { maxRows: 60, maxPages: 20, maxReadCount: 200, timeoutMs: 25000 },
          expiresAt: '2099-01-01T00:00:00.000Z', maxExecutions: 1 }],
        ['POST', '/record-activations', { activationKey: randomUUID(), selector: fixture.selector, projectNo: 'SYN-PROJECT',
          expectedRecordCondition: { mode: 'unconditional' },
          expectedRuleRevision: (await admin.query('SELECT integration_authority_revision FROM automation_rules WHERE id=$1', [ruleId])).rows[0].integration_authority_revision as string,
          budget: { maxRows: 60, maxPages: 20, maxReadCount: 200, timeoutMs: 25000 },
          expiresAt: '2099-01-01T00:00:00.000Z', maxExecutions: 1 }],
        ['POST', '/schedule-activations', { activationKey: randomUUID(), selector: fixture.selector, projectNo: 'SYN-PROJECT',
          expectedRuleRevision: (await admin.query('SELECT integration_authority_revision FROM automation_rules WHERE id=$1', [ruleId])).rows[0].integration_authority_revision as string,
          budget: { maxRows: 60, maxPages: 20, maxReadCount: 200, timeoutMs: 25000 },
          expiresAt: '2099-01-01T00:00:00.000Z', maxExecutions: 1 }],
        ['POST', '/requests', { grantId: fixture.grantId, invocationId: randomUUID(), projectNo: 'SYN-PROJECT' }],
        ['GET', '/grants'], ['GET', '/grants/' + fixture.grantId],
        ['GET', '/requests'], ['GET', '/requests/' + fixture.requestId],
        ['POST', '/grants/' + fixture.grantId + '/revoke'], ['POST', '/requests/' + fixture.requestId + '/cancel'],
        ['GET', '/requests/' + fixture.requestId + '/retry-context'],
        ['POST', '/requests/' + fixture.requestId + '/retry', { retryKey: randomUUID(),
          budget: { maxRows: 60, maxPages: 20, maxReadCount: 200, timeoutMs: 25000 },
          expiresAt: '2099-01-01T00:00:00.000Z', acknowledgeNewRead: true }],
      ] as const
      expect((await fixture.http.request('GET', ownerPath + '/grants')).status).toBe(401)
      expect((await fixture.http.request('GET', ownerPath + '/grants', { token: 'invalid-synthetic-token' })).status).toBe(401)
      const claimless = fixture.http.token({ actorId: actor.actorId })
      for (const [method, endpoint, body] of endpoints) {
        const fakeTenant = await fixture.http.request(method, ownerPath + endpoint, {
          token: claimless, body, headers: { 'x-tenant-id': actor.tenantId },
        })
        expect(fakeTenant.status).toBe(403)
        expect(fakeTenant.headers['cache-control']).toBe('no-store')
      }
      await admin.query(`INSERT INTO users(id,role,permissions,is_active,activation_status)
        VALUES ('synthetic-other-admin','admin','[]',true,'activated')`)
      await admin.query("INSERT INTO user_roles VALUES ('synthetic-other-admin','admin')")
      await admin.query('INSERT INTO user_orgs VALUES ($1,$2,true)', ['synthetic-other-admin', actor.tenantId])
      const other = fixture.http.token({ actorId: 'synthetic-other-admin', tenantId: actor.tenantId })
      for (const [method, endpoint, body] of endpoints) {
        const response = await fixture.http.request(method, ownerPath + endpoint, { token: other, body })
        if (method === 'GET' && (endpoint === '/grants' || endpoint === '/requests' || endpoint.startsWith('/options?'))) {
          // A valid other owner can list their own empty namespace, not ours.
          expect(response.status).toBe(200)
          expect(responseData(response)).toEqual({ items: [], nextCursor: null })
        } else if (method === 'POST' && (endpoint === '/grants' || endpoint === '/record-activations' || endpoint === '/schedule-activations')) {
          // The source receipt belongs to the original validating owner. Its
          // private refusal is deliberately collapsed by the authority adapter,
          // not projected as a source-store error to a different administrator.
          expect(response.status).toBe(503)
          expect(response.body).toEqual({ ok: false, error: { code: 'AUTOMATION_READ_UNAVAILABLE' } })
        } else expect(response.status, method + ' ' + endpoint).toBe(403)
        expect(JSON.stringify(response.body)).not.toContain(fixture.requestId)
        expect(JSON.stringify(response.body)).not.toContain(fixture.grantId)
      }
      await admin.query('UPDATE user_orgs SET is_active=false WHERE user_id=$1', [actor.actorId])
      for (const [method, endpoint, body] of endpoints) {
        // AuthService retains the user but drops the now-inactive tenant claim;
        // the owner router rejects the missing trusted tenant with 403.
        expect((await fixture.http.request(method, ownerPath + endpoint, { token: fixture.token, body })).status).toBe(403)
      }
      expect((await admin.query('SELECT count(*)::int AS count FROM integration_automation_read_grants')).rows[0].count).toBe(1)
      expect((await admin.query('SELECT id FROM integration_automation_read_record_activations')).rows).toEqual([])
      expect((await admin.query('SELECT id FROM integration_automation_read_schedule_activations')).rows).toEqual([])
      expect((await admin.query('SELECT count(*)::int AS count FROM integration_automation_read_requests')).rows[0].count).toBe(1)
      expect((await admin.query('SELECT count(*)::int AS count FROM meta_automation_outbox')).rows[0].count).toBe(1)
      expect(fixture.nativeStatements).toEqual([])
    } finally { await fixture.close() }
  }, 60000)

  it('options uses current-sheet owner keysets, reauthorizes cursors and makes zero execution writes', async () => {
    const fixture = await ownerHttpFixture()
    try {
      await optionRule('000-foreign-rule', 'synthetic-unrelated-owner')
      await optionRule('001-owner-option')
      await optionRule('002-owner-option')
      await admin.query("UPDATE automation_rules SET name=NULL WHERE id='001-owner-option'")
      const before = await counts(), opts = { token: fixture.token }
      const page = await fixture.http.request('GET', ownerPath + '/options?sheetId=' + sheetId + '&limit=1', opts)
      expect(page.status).toBe(200)
      expect(responseData(page)).toMatchObject({ items: [{ selector: { ruleId: '001-owner-option' }, ruleName: '' }], nextCursor: '001-owner-option' })
      expect(responseData(page).items).toHaveLength(1)
      const next = await fixture.http.request('GET', ownerPath + '/options?sheetId=' + sheetId + '&limit=1&after=001-owner-option', opts)
      expect(next.status).toBe(200)
      expect(responseData(next)).toMatchObject({ items: [{ selector: { ruleId: '002-owner-option' } }], nextCursor: '002-owner-option' })
      const otherSheet = await fixture.http.request('GET', ownerPath + '/options?sheetId=synthetic-other-sheet', opts)
      expect(otherSheet.status).toBe(200)
      expect(responseData(otherSheet)).toEqual({ items: [], nextCursor: null })
      expect((await fixture.http.request('GET', ownerPath + '/options?sheetId=' + sheetId + '&after=000-foreign-rule', opts)).status).toBe(403)
      await admin.query("UPDATE automation_rules SET enabled=false WHERE id='001-owner-option'")
      expect((await fixture.http.request('GET', ownerPath + '/options?sheetId=' + sheetId + '&after=001-owner-option', opts)).status).toBe(403)
      expect(await counts()).toEqual(before)
      expect(fixture.nativeStatements).toEqual([])
      expect((await admin.query('SELECT key FROM plugin_kv')).rows).toEqual([])
      await admin.query('DELETE FROM role_permissions')
      // Empty candidate sets never bypass the current integration-admin proof.
      expect((await fixture.http.request('GET', ownerPath + '/options?sheetId=synthetic-other-sheet', opts)).status).toBe(403)
    } finally { await fixture.close() }
  }, 60000)

  it('options proves the lookahead item and refuses a stale choice after connection ownership changes', async () => {
    const fixture = await ownerHttpFixture()
    try {
      await optionRule('001-owner-option')
      await optionRule('002-owner-option')
      // This older/corrupt-row fixture intentionally does not install the new
      // authoring CHECK: discovery must still enforce its own runtime policy.
      // Actual migrated rule persistence is covered in authoring-realdb.
      await admin.query("UPDATE automation_rules SET action_config='{}' WHERE id='002-owner-option'")
      const before = await counts(), opts = { token: fixture.token }
      const rejected = await fixture.http.request('GET', ownerPath + '/options?sheetId=' + sheetId + '&limit=1', opts)
      expect(rejected.status).toBe(403)
      expect(JSON.stringify(rejected.body)).not.toContain('001-owner-option')
      await admin.query('UPDATE automation_rules SET action_config=$1::jsonb WHERE id=$2', [JSON.stringify(ruleConfig), '002-owner-option'])
      const listed = await fixture.http.request('GET', ownerPath + '/options?sheetId=' + sheetId + '&limit=1', opts)
      expect(listed.status).toBe(200)
      const selected = (responseData(listed).items as Array<{ selector: ReadSelector }>)[0].selector
      await admin.query("UPDATE data_sources SET owner_id='synthetic-next-owner' WHERE id=$1", [connectionId])
      const stale = await fixture.http.request('POST', ownerPath + '/grants', { ...opts, body: {
        selector: selected, projects: ['SYN-PROJECT'], triggers: ['manual'], budget: requestBudget,
        expiresAt: '2099-01-01T00:00:00.000Z', maxExecutions: 1,
      } })
      expect(stale.status).toBe(503)
      expect(stale.body).toEqual({ ok: false, error: { code: 'AUTOMATION_READ_UNAVAILABLE' } })
      expect(await counts()).toEqual(before)
      expect(fixture.nativeStatements).toEqual([])
      expect((await admin.query('SELECT key FROM plugin_kv')).rows).toEqual([])
    } finally { await fixture.close() }
  }, 60000)

  it('options rejects a pointer changed after the real hint query and never follows it automatically', async () => {
    const fixture = await ownerHttpFixture()
    try {
      const before = await counts()
      let hits = 0
      // Transport checkpoint after a real completed SELECT, before the actual
      // authority lock. No authorization callback or query result is replaced.
      afterMetadataQuery = async statement => {
        if (statement.includes('JOIN automation_read_target_profiles p') && statement.includes('LIMIT')) {
          afterMetadataQuery = undefined
          hits++
          await insertPointer('synthetic-new-unavailable-source')
        }
      }
      const response = await fixture.http.request('GET', ownerPath + '/options?sheetId=' + sheetId, { token: fixture.token })
      expect(hits).toBe(1)
      expect(response.status).toBe(403)
      expect(response.body).toEqual({ ok: false, error: { code: 'AUTOMATION_READ_DENIED' } })
      expect(await counts()).toEqual(before)
      expect(fixture.nativeStatements).toEqual([])
      expect((await admin.query('SELECT key FROM plugin_kv')).rows).toEqual([])
    } finally { afterMetadataQuery = undefined; await fixture.close() }
  }, 60000)

  it('real HTTP malformed paths and unsupported body encodings stay inside the fixed owner error boundary', async () => {
    const fixture = await ownerHttpFixture()
    try {
      const malformed = await fixture.http.request('GET', ownerPath + '/requests/%E0%A4%A', { token: fixture.token })
      const charset = await fixture.http.request('POST', ownerPath + '/grants', { token: fixture.token, body: {},
        headers: { 'content-type': 'application/json; charset=synthetic-unsupported' } })
      const encoding = await fixture.http.request('POST', ownerPath + '/requests', { token: fixture.token, body: {},
        headers: { 'content-encoding': 'synthetic-unsupported' } })
      for (const [response, status] of [[malformed, 400], [charset, 415], [encoding, 415]] as const) {
        expect(response.status).toBe(status)
        expect(response.headers['cache-control']).toBe('no-store')
        expect(response.body).toEqual({ ok: false, error: { code: 'AUTOMATION_READ_INPUT_INVALID' } })
      }
      expect((await admin.query('SELECT count(*)::int AS count FROM integration_automation_read_grants')).rows[0].count).toBe(1)
      expect((await admin.query('SELECT count(*)::int AS count FROM integration_automation_read_requests')).rows[0].count).toBe(1)
      expect((await admin.query('SELECT count(*)::int AS count FROM meta_automation_outbox')).rows[0].count).toBe(1)
      expect(fixture.nativeStatements).toEqual([])
    } finally { await fixture.close() }
  }, 60000)

  it('owner history, revoke and cancel survive plugin stop; current owner/admin changes still deny them', async () => {
    const fixture = await ownerHttpFixture()
    try {
      const opts = { token: fixture.token }
      await fixture.runtime.stop()
      expect((await fixture.http.request('GET', ownerPath + '/options?sheetId=' + sheetId, opts)).status).toBe(503)
      expect((await fixture.http.request('GET', ownerPath + '/grants/' + fixture.grantId, opts)).status).toBe(200)
      expect((await fixture.http.request('GET', ownerPath + '/requests/' + fixture.requestId, opts)).status).toBe(200)
      expect((await fixture.http.request('POST', ownerPath + '/requests', { ...opts,
        body: { grantId: fixture.grantId, invocationId: randomUUID(), projectNo: 'SYN-PROJECT' } })).status).toBe(503)
      const cancelled = await fixture.http.request('POST', ownerPath + '/requests/' + fixture.requestId + '/cancel', opts)
      expect(cancelled.status).toBe(200)
      expect(responseData(cancelled)).toEqual({ requestId: fixture.requestId, status: 'cancelled' })
      const revoked = await fixture.http.request('POST', ownerPath + '/grants/' + fixture.grantId + '/revoke', opts)
      expect(revoked.status).toBe(200)
      expect(responseData(revoked)).toEqual({ grantId: fixture.grantId, status: 'revoked' })
      await admin.query('DELETE FROM role_permissions')
      expect((await fixture.http.request('GET', ownerPath + '/requests/' + fixture.requestId, opts)).status).toBe(403)
      await admin.query("INSERT INTO role_permissions VALUES ('integration_admin','integration:admin')")
      await admin.query("UPDATE data_sources SET owner_id='synthetic-next-owner' WHERE id=$1", [connectionId])
      expect((await fixture.http.request('GET', ownerPath + '/grants/' + fixture.grantId, opts)).status).toBe(403)
      expect((await fixture.http.request('POST', ownerPath + '/requests/' + fixture.requestId + '/cancel', opts)).status).toBe(403)
      expect(fixture.nativeStatements).toEqual([])
      expect((await admin.query('SELECT status FROM integration_automation_read_requests WHERE id=$1', [fixture.requestId])).rows[0].status).toBe('cancelled')
    } finally { await fixture.close() }
  }, 60000)

  // Keep this actual migration/approval case last: earlier corruption cases
  // intentionally predate the rule-shape CHECK; this case installs that CHECK.
  it('approval writeback conditional chain: actual published approval → durable bridge writeback → owner-consented record admission → native readonly preview', async () => {
    const previousDurableFlag = process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED
    process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = 'true'
    const rules = new AutomationService(new EventBus(), db as never, (statement, params) => pool.query(statement, params))
    // Capture identities before the HTTP fixture forwards infrastructure transport.
    const { poolManager } = await import('../../src/integration/db/connection-pool')
    const infrastructurePool = poolManager.get().getInternalPool()
    const { pool: approvalPool } = await import('../../src/db/pg')
    const restoreDurableFlag = () => {
      if (previousDurableFlag === undefined) delete process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED
      else process.env.AUTOMATION_DURABLE_DELIVERY_ENABLED = previousDurableFlag
    }
    const fixture = await ownerHttpFixture(rules, false).catch(async error => {
      try { await rules.shutdown() } finally { restoreDurableFlag() }
      throw error
    })
    let approvalConnect: { mockRestore(): void } | undefined
    const metricsObservers: Array<{ mock: { results: Array<{ type: string; value: unknown }> }; mockRestore(): void }> = []
    try {
      if (!approvalPool) throw new Error('SYNTHETIC_APPROVAL_POOL_REQUIRED')
      // The HTTP fixture already forwards infrastructurePool.connect, including
      // global Kysely transactions. Forward a distinct captured pg Pool only if
      // needed; nested spies on the same connect method would restore out of order.
      if (approvalPool !== pool && approvalPool !== infrastructurePool) {
        approvalConnect = vi.spyOn(approvalPool, 'connect').mockImplementation(pool.connect.bind(pool))
      }
      // Only this owned synthetic schema follows the historical migration order.
      // The bridge migration's older action CHECK is installed against a valid
      // old action, then the actual current read-action migration upgrades it.
      // No migration failure is ignored and no production guard is disabled.
      await admin.query("UPDATE automation_rules SET action_type='notify' WHERE id=$1", [ruleId])
      await bootstrapOwnedApprovalAfterImageSchema({ db, query: (statement, params) => admin.query(statement, params), mode: 'existing' })
      approvalSchemaReady = true
      await db.transaction().execute(addReadPreviewAction)
      await admin.query('UPDATE automation_rules SET action_type=$2 WHERE id=$1', [ruleId, AUTOMATION_READ_ACTION_TYPE])
      // Observe unchanged promises from the actual shared metrics implementation.
      // Its post-COMMIT hooks are detached, so HTTP handler draining alone cannot
      // prove that it is safe to restore the process-wide DB transport.
      const { getApprovalMetricsService } = await import('../../src/services/ApprovalMetricsService')
      const metrics = getApprovalMetricsService()
      metricsObservers.push(vi.spyOn(metrics, 'recordInstanceStart'), vi.spyOn(metrics, 'recordNodeDecision'),
        vi.spyOn(metrics, 'recordTerminal'))

      const conditionField = 'synthetic-approval-chain-status'
      const approverField = 'synthetic-approval-chain-approver'
      const completedAtField = 'synthetic-approval-chain-completed-at'
      const recordId = 'synthetic-approval-chain-record'
      const approverId = 'synthetic-approval-chain-approver-user'
      for (const [id, type] of [[conditionField, 'string'], [approverField, 'string'], [completedAtField, 'dateTime']]) {
        await admin.query('INSERT INTO meta_fields(id,sheet_id,name,type,property) VALUES ($1,$2,$1,$3,\'{}\')', [id, sheetId, type])
      }
      await admin.query(`UPDATE automation_rules SET trigger_type='record.updated',trigger_config='{}',conditions=$2::jsonb WHERE id=$1`,
        [ruleId, JSON.stringify({ logic: 'and', conditions: [{ fieldId: conditionField, operator: 'equals', value: 'approved' }] })])
      await admin.query(`INSERT INTO users(id,name,email,role,permissions,is_active,activation_status)
        VALUES ($1,$1,'synthetic-approver@example.test','user','[]',true,'activated')`, [approverId])
      await admin.query('INSERT INTO roles(id,name) VALUES ($1,$2)', ['integration_admin', 'Synthetic integration owner'])
      // The source owner already has exactly one active organization. Adding a
      // second default organization would invalidate the actual approval scope.
      await admin.query("INSERT INTO user_permissions VALUES ($1,'approvals:write')", [actor.actorId])
      await authorizeRuleAuthoring()
      await admin.query(`INSERT INTO meta_records(id,sheet_id,data,version,created_by,created_at,updated_at)
        VALUES ($1,$2,$3::jsonb,1,$4,now(),now())`,
      [recordId, sheetId, JSON.stringify({ [conditionField]: 'pending', syntheticPreserved: 'untouched' }), actor.actorId])

      const options = await fixture.http.request('GET', ownerPath + '/options?sheetId=' + sheetId, { token: fixture.token })
      expect(options.status).toBe(200)
      const option = (responseData(options).items as Row[]).find(item => (item.selector as ReadSelector).ruleId === ruleId)
      expect(option).toMatchObject({ recordActivationEligible: true, recordTriggerType: 'record.updated',
        recordCondition: { mode: 'saved_conditions' } })
      const authorized = await fixture.http.request('POST', ownerPath + '/record-activations', { token: fixture.token, body: {
        activationKey: randomUUID(), selector: fixture.selector, projectNo: 'SYN-PROJECT',
        expectedRecordCondition: option!.recordCondition, expectedRuleRevision: option!.recordRuleRevision,
        budget: { maxRows: 60, maxPages: 20, maxReadCount: 200, timeoutMs: 25000 },
        maxExecutions: 1, expiresAt: '2099-01-01T00:00:00.000Z',
      } })
      expect(authorized.status).toBe(201)
      const pair = responseData(authorized)
      expect(await counts()).toEqual({ grants: 1, requests: 0, outbox: 0 })

      const approvals = new ApprovalProductService()
      const published = await approvals.createTemplate({
        key: 'synthetic-approval-chain-' + randomUUID(), name: 'Synthetic approval chain',
        visibilityScope: { type: 'all', ids: [] },
        formSchema: { fields: [{ id: 'summary', type: 'text', label: 'Summary', required: true }] },
        approvalGraph: {
          nodes: [
            { key: 'start', type: 'start', name: 'Start', config: {} },
            { key: 'approval_1', type: 'approval', name: 'Synthetic approver', config: {
              assigneeSources: [{ kind: 'static_user', userIds: [approverId] }], approvalMode: 'single', emptyAssigneePolicy: 'error',
            } },
            { key: 'end', type: 'end', name: 'End', config: {} },
          ],
          edges: [{ key: 'start-approval', source: 'start', target: 'approval_1' },
            { key: 'approval-end', source: 'approval_1', target: 'end' }],
        },
      })
      await approvals.publishTemplate(published.id, { policy: { allowRevoke: true } })
      // Bare mapping strings are lookup paths in the production bridge. Use its
      // template expression syntax to populate the required published text field.
      const startConfig = { templateId: published.id, formDataMapping: { summary: 'Synthetic approval {{recordId}}' },
        requester: { mode: 'trigger_actor' }, resultWriteback: { statusField: conditionField,
          approverField, completedAtField } }
      const saved = await rules.createRule(sheetId, { name: 'Synthetic approval writer', triggerType: 'record.created',
        triggerConfig: {}, actionType: 'start_approval', actionConfig: startConfig,
        actions: [{ type: 'start_approval', config: startConfig }], executionMode: 'workflow_job_v1', createdBy: actor.actorId })
      const startRule: AutomationRule = { id: saved.id, name: saved.name ?? '', sheetId,
        trigger: { type: 'record.created', config: {} }, actions: [{ type: 'start_approval', config: startConfig }],
        enabled: true, createdBy: actor.actorId, createdAt: new Date().toISOString(), executionMode: 'workflow_job_v1' }
      // Public production execution and approval action, not a completion payload
      // manufactured by the fixture or a private resultWriteback invocation.
      const execution = await rules.executeRule(startRule, { sheetId, recordId, actorId: actor.actorId, _automationDepth: 0 })
      expect(execution.status, 'SYNTHETIC_APPROVAL_START_FACTS_' + JSON.stringify({
        error: execution.error,
        steps: execution.steps.map(step => ({ actionType: step.actionType, status: step.status, error: step.error })),
      })).toBe('running')
      const bridges = (await admin.query(`SELECT id,approval_instance_id,status,execution_id
        FROM multitable_automation_approval_bridges WHERE execution_id=$1`, [execution.id])).rows
      expect(bridges).toHaveLength(1)
      expect(bridges[0]).toMatchObject({ status: 'pending', execution_id: execution.id, approval_instance_id: expect.any(String) })
      expect((await admin.query('SELECT status FROM multitable_automation_jobs WHERE execution_id=$1', [execution.id])).rows)
        .toEqual([{ status: 'suspended' }])
      expect((await admin.query('SELECT status,org_id,form_snapshot FROM approval_instances WHERE id=$1', [bridges[0].approval_instance_id])).rows)
        .toEqual([{ status: 'pending', org_id: actor.tenantId, form_snapshot: { summary: 'Synthetic approval ' + recordId } }])
      expect(fixture.nativeStatements).toEqual([])

      await approvals.dispatchAction(String(bridges[0].approval_instance_id), { action: 'approve', comment: 'Synthetic approval' },
        { userId: approverId, userName: 'Synthetic approver' })
      const completion = (await admin.query(`SELECT id,event_id,payload FROM meta_automation_outbox
        WHERE event_type='approval.approved'`)).rows
      expect(completion).toHaveLength(1)
      expect(completion[0].payload).toMatchObject({ source: 'approval-product', actor: { id: approverId },
        requester: { id: actor.actorId }, approval: { instanceId: bridges[0].approval_instance_id }, transition: { toStatus: 'approved' } })
      expect((await admin.query('SELECT data,version FROM meta_records WHERE id=$1', [recordId])).rows)
        .toEqual([{ data: { [conditionField]: 'pending', syntheticPreserved: 'untouched' }, version: 1 }])
      expect((await admin.query('SELECT outbox_id FROM meta_automation_record_after_images')).rows).toEqual([])
      expect((await admin.query('SELECT id FROM integration_automation_read_requests')).rows).toEqual([])

      const unexpected = async (): Promise<never> => { throw new Error('SYNTHETIC_UNEXPECTED_UNRELATED_CONSUMER') }
      const handlers = buildDurableConsumerHandlers({ automationService: rules,
        automationReadRecord: { produce: fixture.runtime.produceRecord }, projectionService: { reconcile: unexpected },
        webhookService: { deliverEvent: unexpected }, recordApprovalService: { handleApprovalCompletion: unexpected },
        todoMirrorService: { handleApprovalTaskCreated: unexpected, handleApprovalCompletion: unexpected } })
      const adapters = buildConsumerAdapterRegistry(handlers, createAutomationReadDelivery({ transaction, execute: fixture.runtime.execute }))
      const bridgeOnly = new ConsumerAdapterRegistry(), recordOnly = new ConsumerAdapterRegistry(), readOnly = new ConsumerAdapterRegistry()
      bridgeOnly.register(adapters.get('approval-bridge')!)
      recordOnly.register(adapters.get('automation-record-trigger')!)
      readOnly.register(adapters.get(AUTOMATION_READ_CONSUMER)!)
      expect(await runDispatchTick(pool, bridgeOnly, { batchSize: 1 })).toMatchObject({ completed: 1, rescheduled: 0 })
      expect((await admin.query('SELECT status,outcome,fence,attempts,lease_expires_at FROM multitable_automation_approval_bridges WHERE id=$1', [bridges[0].id])).rows)
        .toEqual([{ status: 'resumed', outcome: 'approved', fence: '1', attempts: 1, lease_expires_at: null }])
      expect((await rules.logs.getById(execution.id))?.status).toBe('success')
      const written = (await admin.query(`SELECT o.id,o.event_id,o.automation_depth,i.record_id,i.record_version,
          i.after_image,i.schema_revision,(i.after_image=r.data) AS exact_stored_image,
          v.source,v.action,v.actor_id,v.snapshot,v.patch
        FROM meta_automation_outbox o JOIN meta_automation_record_after_images i ON i.outbox_id=o.id
        JOIN meta_records r ON r.id=i.record_id JOIN meta_record_revisions v ON v.record_id=r.id AND v.version=i.record_version
        WHERE i.record_id=$1 AND o.event_type='multitable.record.updated'`, [recordId])).rows
      expect(written).toHaveLength(1)
      expect(written[0]).toMatchObject({ record_id: recordId, record_version: '2', automation_depth: 1,
        schema_revision: (option!.recordCondition as Row).schemaRevision, exact_stored_image: true,
        source: 'approval', action: 'update', actor_id: approverId,
        after_image: { [conditionField]: 'approved', [approverField]: approverId, [completedAtField]: expect.any(String), syntheticPreserved: 'untouched' } })
      expect(written[0].snapshot).toEqual(written[0].after_image)
      expect(written[0].patch).toEqual({ [conditionField]: 'approved', [approverField]: approverId,
        [completedAtField]: (written[0].after_image as Row)[completedAtField] })
      expect((await admin.query('SELECT id FROM integration_automation_read_requests')).rows).toEqual([])
      expect(fixture.nativeStatements).toEqual([])

      // Challenge the continuation with a newer committed row that no longer
      // matches. No event is fabricated for this fixture-only later mutation:
      // admission must consume the real approval writeback's immutable image.
      await admin.query(`UPDATE meta_records SET data=data || $2::jsonb,version=version+1 WHERE id=$1`,
        [recordId, JSON.stringify({ [conditionField]: 'changed-after-approval-event' })])
      expect((await admin.query('SELECT version,data FROM meta_records WHERE id=$1', [recordId])).rows[0])
        .toMatchObject({ version: 3, data: { [conditionField]: 'changed-after-approval-event' } })
      const businessTables = ['meta_bases', 'meta_sheets', 'meta_fields', 'meta_records', 'meta_record_revisions',
        'syn_pathlink', 'syn_path', 'syn_order', 'syn_orderline', 'syn_part', 'syn_bom', 'syn_bomline'] as const
      const snapshotBusiness = async () => {
        const snapshot: Record<string, unknown> = {}
        for (const table of businessTables) snapshot[table] = (await admin.query(
          'SELECT row_to_json(b) AS row FROM ' + table + ' b ORDER BY row_to_json(b)::text COLLATE "C"')).rows
        return snapshot
      }
      const beforePreview = await snapshotBusiness()
      expect(await runDispatchTick(pool, recordOnly, { batchSize: 1 })).toMatchObject({ completed: 1, rescheduled: 0 })
      const requests = (await admin.query('SELECT id,status,trigger_type,grant_id FROM integration_automation_read_requests')).rows
      expect(requests).toHaveLength(1)
      const request = requests[0]
      expect(request).toMatchObject({ status: 'queued', trigger_type: 'record', grant_id: pair.grantId })
      await executionAudit(String(request.id), ruleId, 'queued')
      expect(fixture.nativeStatements).toEqual([])
      expect(await runDispatchTick(pool, readOnly, { batchSize: 1, adapterTimeoutMs: 30000 }))
        .toMatchObject({ completed: 1, rescheduled: 0 })
      const observed = await fixture.http.request('GET', ownerPath + '/requests/' + request.id, { token: fixture.token })
      expect(observed.status).toBe(200)
      expect(responseData(observed)).toMatchObject({ requestId: request.id, status: 'succeeded',
        result: { status: 'ready', counts: { add: 1 }, canApply: false } })
      await executionAudit(String(request.id), ruleId, 'succeeded')
      expect(fixture.nativeStatements.length).toBeGreaterThan(0)
      expect(await snapshotBusiness()).toEqual(beforePreview)
      expect((await admin.query('SELECT used_executions,max_executions FROM integration_automation_read_grants WHERE id=$1', [pair.grantId])).rows)
        .toEqual([{ used_executions: 1, max_executions: 1 }])
      expect((await admin.query(`SELECT consumer_key,status FROM meta_automation_outbox_consumer
        WHERE outbox_id=$1 ORDER BY consumer_key`, [written[0].id])).rows)
        .toEqual([{ consumer_key: 'automation-record-trigger', status: 'done' }, { consumer_key: 'webhook-event-bridge', status: 'pending' }])
      // Redelivering the real completion cannot write a second image or spend
      // another source permission. The original B2a grant permits one preview.
      const readCount = fixture.nativeStatements.length
      await admin.query(`UPDATE meta_automation_outbox_consumer SET status='pending',lease_expires_at=NULL
        WHERE outbox_id=$1 AND consumer_key='approval-bridge'`, [completion[0].id])
      expect(await runDispatchTick(pool, bridgeOnly, { batchSize: 1 })).toMatchObject({ completed: 1, rescheduled: 0 })
      expect((await admin.query('SELECT record_version FROM meta_automation_record_after_images WHERE record_id=$1', [recordId])).rows)
        .toEqual([{ record_version: '2' }])
      expect((await admin.query('SELECT id FROM integration_automation_read_requests')).rows).toEqual([{ id: request.id }])
      expect(fixture.nativeStatements).toHaveLength(readCount)
      expect(await snapshotBusiness()).toEqual(beforePreview)
    } finally {
      try {
        await rules.shutdown(); await fixture.runtime.stop(); await fixture.http.drainHandlers()
        await Promise.allSettled(metricsObservers.flatMap(observed => observed.mock.results
          .filter(result => result.type === 'return' && result.value instanceof Promise)
          .map(result => result.value as Promise<unknown>)))
      }
      finally {
        // Restore the optional inner transport before the HTTP fixture restores
        // its outer transport. All actual source/handler work has settled first.
        for (const observed of metricsObservers.reverse()) observed.mockRestore()
        approvalConnect?.mockRestore()
        try { await fixture.close() } finally { restoreDurableFlag() }
      }
    }
  }, 60000)

  it('FWB create producer: actual published approval → durable FWB-1 create → owner-consented immutable record admission → native readonly preview', async () => {
    const priorFlags = new Map<string, string | undefined>(['AUTOMATION_DURABLE_DELIVERY_ENABLED', 'APPROVAL_FWB_WRITEBACK_ENABLED']
      .map(name => [name, process.env[name]] as const))
    for (const name of priorFlags.keys()) process.env[name] = 'true'
    const restoreFlags = () => {
      for (const [name, value] of priorFlags) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
    const rules = new AutomationService(new EventBus(), db as never, (statement, params) => pool.query(statement, params))
    const { poolManager } = await import('../../src/integration/db/connection-pool')
    const infrastructurePool = poolManager.get().getInternalPool()
    const { pool: approvalPool } = await import('../../src/db/pg')
    const fixture = await ownerHttpFixture(rules, false, 1, true).catch(async error => {
      try { await rules.shutdown() } finally { restoreFlags() }
      throw error
    })
    let approvalConnect: { mockRestore(): void } | undefined
    const metricsObservers: Array<{ mock: { results: Array<{ type: string; value: unknown }> }; mockRestore(): void }> = []
    try {
      if (!approvalPool) throw new Error('SYNTHETIC_APPROVAL_POOL_REQUIRED')
      if (approvalPool !== pool && approvalPool !== infrastructurePool) {
        approvalConnect = vi.spyOn(approvalPool, 'connect').mockImplementation(pool.connect.bind(pool))
      }
      // Install real prerequisites only inside this disposable schema, following
      // the historical action CHECK then its actual FWB/read-action upgrades.
      await admin.query("UPDATE automation_rules SET action_type='notify' WHERE id=$1", [ruleId])
      await bootstrapOwnedApprovalAfterImageSchema({ db, query: (statement, params) => admin.query(statement, params), mode: 'existing' })
      approvalSchemaReady = true
      for (const migration of [addFwbClaims, addFwbAction, addOperationAudit, fixOperationAudit, addReadPreviewAction]) {
        await db.transaction().execute(migration)
      }
      fwbSchemaReady = true
      await admin.query('ALTER TABLE meta_bases ADD COLUMN IF NOT EXISTS owner_id text')
      await admin.query('UPDATE automation_rules SET action_type=$2 WHERE id=$1', [ruleId, AUTOMATION_READ_ACTION_TYPE])
      const { getApprovalMetricsService } = await import('../../src/services/ApprovalMetricsService')
      const metrics = getApprovalMetricsService()
      metricsObservers.push(vi.spyOn(metrics, 'recordInstanceStart'), vi.spyOn(metrics, 'recordNodeDecision'), vi.spyOn(metrics, 'recordTerminal'))

      const conditionField = 'synthetic-fwb-create-condition'
      const approverId = 'synthetic-fwb-create-approver'
      await admin.query("INSERT INTO meta_fields(id,sheet_id,name,type,property) VALUES ($1,$2,$1,'string','{}')", [conditionField, sheetId])
      await admin.query(`UPDATE automation_rules SET trigger_type='record.created',trigger_config='{}',conditions=$2::jsonb WHERE id=$1`,
        [ruleId, JSON.stringify({ logic: 'and', conditions: [{ fieldId: conditionField, operator: 'equals', value: 'SYN-FWB-MATCH' }] })])
      await admin.query(`INSERT INTO users(id,name,email,role,permissions,is_active,activation_status)
        VALUES ($1,$1,'synthetic-fwb-approver@example.test','user','[]',true,'activated')`, [approverId])
      await admin.query('INSERT INTO roles(id,name) VALUES ($1,$2)', ['integration_admin', 'Synthetic integration owner'])
      await admin.query("INSERT INTO user_permissions VALUES ($1,'approvals:write'),($1,'approvals:read')", [actor.actorId])
      await authorizeRuleAuthoring()
      // This owner receives management authority on this synthetic sheet only;
      // no platform-admin role or permission-check replacement is introduced.
      await admin.query("INSERT INTO spreadsheet_permissions VALUES ($1,'user',$2,'spreadsheet:admin')", [sheetId, actor.actorId])

      const options = await fixture.http.request('GET', ownerPath + '/options?sheetId=' + sheetId, { token: fixture.token })
      expect(options.status).toBe(200)
      const option = (responseData(options).items as Row[]).find(item => (item.selector as ReadSelector).ruleId === ruleId)
      expect(option).toMatchObject({ recordActivationEligible: true, recordTriggerType: 'record.created', recordCondition: { mode: 'saved_conditions' } })
      const activated = await fixture.http.request('POST', ownerPath + '/record-activations', { token: fixture.token, body: {
        activationKey: randomUUID(), selector: fixture.selector, projectNo: 'SYN-PROJECT',
        expectedRecordCondition: option!.recordCondition, expectedRuleRevision: option!.recordRuleRevision,
        budget: { maxRows: 60, maxPages: 20, maxReadCount: 200, timeoutMs: 25000 },
        maxExecutions: 1, expiresAt: '2099-01-01T00:00:00.000Z',
      } })
      expect(activated.status).toBe(201)
      const pair = responseData(activated)
      const approvals = new ApprovalProductService()
      const template = await approvals.createTemplate({
        key: 'synthetic-fwb-create-' + randomUUID(), name: 'Synthetic FWB create', visibilityScope: { type: 'all', ids: [] },
        formSchema: { fields: [{ id: 'summary', type: 'text', label: 'Summary', required: true }] },
        approvalGraph: {
          nodes: [{ key: 'start', type: 'start', name: 'Start', config: {} },
            { key: 'approval_1', type: 'approval', name: 'Synthetic approver', config: {
              assigneeSources: [{ kind: 'static_user', userIds: [approverId] }], approvalMode: 'single', emptyAssigneePolicy: 'error',
            } }, { key: 'end', type: 'end', name: 'End', config: {} }],
          edges: [{ key: 'start-approval', source: 'start', target: 'approval_1' }, { key: 'approval-end', source: 'approval_1', target: 'end' }],
        },
      })
      await approvals.publishTemplate(template.id, { policy: { allowRevoke: true } })
      const templateVersion = (await admin.query('SELECT active_version_id FROM approval_templates WHERE id=$1', [template.id])).rows[0].active_version_id
      const mappings = [{ formFieldId: 'summary', targetFieldId: conditionField, targetType: 'text' }]
      // Obtain the actual actor-bound receipt through the production JWT route,
      // not a fixture-inserted audit row or a locally calculated hash.
      const confirmation = await fixture.http.request('POST', `/api/multitable/sheets/${sheetId}/automations/fwb/confirm`, {
        token: fixture.token, body: { templateId: template.id, sourceTemplateVersionId: templateVersion, mappings },
      })
      expect(confirmation.status, 'SYNTHETIC_FWB_CONFIRM_STATUS').toBe(200)
      const confirmed = confirmation.body as Row
      expect(confirmed).toMatchObject({ confirmationHash: expect.any(String), templateId: template.id,
        sourceTemplateVersionId: templateVersion, targetSheetId: sheetId, targetBaseId: baseId })
      expect((await admin.query(`SELECT actor_id,action,resource_type,resource_id FROM operation_audit_logs
        WHERE action='automation.fwb_confirm'`)).rows)
        .toEqual([{ actor_id: actor.actorId, action: 'automation.fwb_confirm', resource_type: 'automation_fwb_confirmation', resource_id: sheetId }])
      const fwbConfig = { sourceTemplateVersionId: templateVersion, confirmationHash: confirmed.confirmationHash, mappings }
      const writerRule = await rules.createRule(sheetId, { name: 'Synthetic FWB-1 creator', triggerType: 'approval.completed',
        triggerConfig: { templateId: template.id, outcomes: ['approved'] }, actionType: 'write_approval_form_values',
        actionConfig: fwbConfig, actions: [{ type: 'write_approval_form_values', config: fwbConfig }], createdBy: actor.actorId })
      const instance = await approvals.createApproval({ templateId: template.id, formData: { summary: 'SYN-FWB-MATCH' } },
        { userId: actor.actorId, userName: 'Synthetic owner' })
      await approvals.dispatchAction(instance.id, { action: 'approve', comment: 'Synthetic approval' },
        { userId: approverId, userName: 'Synthetic approver' })
      const completion = (await admin.query("SELECT id,event_id,payload FROM meta_automation_outbox WHERE event_type='approval.approved'")).rows
      expect(completion).toHaveLength(1)
      expect(completion[0].payload).toMatchObject({ source: 'approval-product', approval: { instanceId: instance.id,
        templateId: template.id, templateVersionId: templateVersion }, transition: { toStatus: 'approved' } })
      expect((await admin.query('SELECT status,org_id,form_snapshot FROM approval_instances WHERE id=$1', [instance.id])).rows)
        .toEqual([{ status: 'approved', org_id: actor.tenantId, form_snapshot: { summary: 'SYN-FWB-MATCH' } }])
      expect((await admin.query('SELECT id FROM meta_records')).rows).toEqual([])
      expect(await counts()).toEqual({ grants: 1, requests: 0, outbox: expect.any(Number) })
      expect(fixture.nativeStatements).toEqual([])

      const unexpected = async (): Promise<never> => { throw new Error('SYNTHETIC_UNEXPECTED_UNRELATED_CONSUMER') }
      const handlers = buildDurableConsumerHandlers({ automationService: rules, automationReadRecord: { produce: fixture.runtime.produceRecord },
        projectionService: { reconcile: unexpected }, webhookService: { deliverEvent: unexpected },
        recordApprovalService: { handleApprovalCompletion: unexpected },
        todoMirrorService: { handleApprovalTaskCreated: unexpected, handleApprovalCompletion: unexpected } })
      const adapters = buildConsumerAdapterRegistry(handlers, createAutomationReadDelivery({ transaction, execute: fixture.runtime.execute }))
      const approvalOnly = new ConsumerAdapterRegistry(), recordOnly = new ConsumerAdapterRegistry(), readOnly = new ConsumerAdapterRegistry()
      approvalOnly.register(adapters.get('approval-trigger')!)
      recordOnly.register(adapters.get('automation-record-trigger')!)
      readOnly.register(adapters.get(AUTOMATION_READ_CONSUMER)!)
      const dispatch = await runDispatchTick(pool, approvalOnly, { batchSize: 1 })
      const executionRows = (await admin.query('SELECT status,steps FROM multitable_automation_executions WHERE rule_id=$1', [writerRule.id])).rows
      expect(dispatch, 'SYNTHETIC_FWB_EXECUTION_FACTS_' + JSON.stringify(executionRows.map(row => ({
        status: row.status, steps: (row.steps as Array<Row>).map(step => ({ actionType: step.actionType, status: step.status,
          error: step.error === 'fwb_execution_failed' ? 'fwb_execution_failed'
            : typeof step.error === 'string' && /^fwb_rejected:[a-z_,:]+$/u.test(step.error) ? step.error : step.error ? 'other' : 'none' })),
      })))).toMatchObject({ completed: 1, rescheduled: 0 })
      expect(executionRows).toHaveLength(1)
      expect(executionRows[0]).toMatchObject({ status: 'success', steps: [{ actionType: 'write_approval_form_values', status: 'success' }] })
      const written = (await admin.query(`SELECT o.id,o.event_id,o.automation_depth,i.record_id,i.record_version,i.after_image,
          i.schema_revision,(i.after_image=r.data) AS exact_stored_image,v.source,v.action,v.actor_id,v.snapshot,v.patch
        FROM meta_automation_outbox o JOIN meta_automation_record_after_images i ON i.outbox_id=o.id
        JOIN meta_records r ON r.id=i.record_id JOIN meta_record_revisions v ON v.record_id=r.id AND v.version=i.record_version
        WHERE o.event_type='multitable.record.created'`)).rows
      expect(written).toHaveLength(1)
      const record = written[0]
      expect(record).toMatchObject({ record_version: '1', automation_depth: 1, after_image: { [conditionField]: 'SYN-FWB-MATCH' },
        schema_revision: (option!.recordCondition as Row).schemaRevision, exact_stored_image: true,
        source: 'automation', action: 'create', actor_id: actor.actorId, snapshot: { [conditionField]: 'SYN-FWB-MATCH' }, patch: { [conditionField]: 'SYN-FWB-MATCH' } })
      expect((await admin.query('SELECT instance_id,rule_id,application_mode FROM meta_fwb_action_applied')).rows)
        .toEqual([{ instance_id: instance.id, rule_id: writerRule.id, application_mode: 'apply' }])
      // Drift the latest row without fabricating a second event. The authentic
      // FWB v1 after-image must remain the admission subject, not this v2 row.
      await admin.query('UPDATE meta_records SET data=$2::jsonb,version=version+1 WHERE id=$1',
        [record.record_id, JSON.stringify({ [conditionField]: 'SYN-FWB-NONMATCH' })])
      expect((await admin.query('SELECT version FROM meta_records WHERE id=$1', [record.record_id])).rows).toEqual([{ version: 2 }])
      const businessTables = ['meta_bases', 'meta_sheets', 'meta_fields', 'meta_records', 'meta_record_revisions',
        'syn_pathlink', 'syn_path', 'syn_order', 'syn_orderline', 'syn_part', 'syn_bom', 'syn_bomline'] as const
      const snapshotBusiness = async () => {
        const snapshot: Record<string, unknown> = {}
        for (const table of businessTables) snapshot[table] = (await admin.query(
          'SELECT row_to_json(b) AS row FROM ' + table + ' b ORDER BY row_to_json(b)::text COLLATE "C"')).rows
        return snapshot
      }
      const beforePreview = await snapshotBusiness()
      expect(await runDispatchTick(pool, recordOnly, { batchSize: 1 })).toMatchObject({ completed: 1, rescheduled: 0 })
      const requests = (await admin.query('SELECT id,status,trigger_type,grant_id FROM integration_automation_read_requests')).rows
      expect(requests).toHaveLength(1)
      const request = requests[0]
      expect(request).toMatchObject({ status: 'queued', trigger_type: 'record', grant_id: pair.grantId })
      await executionAudit(String(request.id), ruleId, 'queued')
      expect(fixture.nativeStatements).toEqual([])
      expect(await runDispatchTick(pool, readOnly, { batchSize: 1, adapterTimeoutMs: 30000 })).toMatchObject({ completed: 1, rescheduled: 0 })
      const observed = await fixture.http.request('GET', ownerPath + '/requests/' + request.id, { token: fixture.token })
      expect(observed.status).toBe(200)
      expect(responseData(observed)).toMatchObject({ requestId: request.id, status: 'succeeded',
        result: { status: 'ready', counts: { add: 1 }, canApply: false } })
      await executionAudit(String(request.id), ruleId, 'succeeded')
      const readCount = fixture.nativeStatements.length
      expect(readCount).toBeGreaterThan(0)
      expect(await snapshotBusiness()).toEqual(beforePreview)
      // Re-deliver the real completion, its real record event, and terminal read
      // receipt. No manufactured event/permission, second write or second B2a IO.
      for (const [outboxId, consumer, registry] of [
        [completion[0].id, 'approval-trigger', approvalOnly], [record.id, 'automation-record-trigger', recordOnly],
      ] as const) {
        await admin.query("UPDATE meta_automation_outbox_consumer SET status='pending',lease_expires_at=NULL WHERE outbox_id=$1 AND consumer_key=$2", [outboxId, consumer])
        expect(await runDispatchTick(pool, registry, { batchSize: 1 })).toMatchObject({ completed: 1, rescheduled: 0 })
      }
      await admin.query("UPDATE meta_automation_outbox_consumer SET status='pending',lease_expires_at=NULL WHERE consumer_key=$1", [AUTOMATION_READ_CONSUMER])
      expect(await runDispatchTick(pool, readOnly, { batchSize: 1 })).toMatchObject({ completed: 1, rescheduled: 0 })
      expect((await admin.query('SELECT id FROM integration_automation_read_requests')).rows).toEqual([{ id: request.id }])
      expect((await admin.query('SELECT record_id,record_version FROM meta_automation_record_after_images')).rows)
        .toEqual([{ record_id: record.record_id, record_version: '1' }])
      expect((await admin.query('SELECT count(*)::int AS claims FROM meta_fwb_action_applied')).rows).toEqual([{ claims: 1 }])
      expect((await admin.query("SELECT count(*)::int AS events FROM meta_automation_outbox WHERE event_type='multitable.record.created'")).rows)
        .toEqual([{ events: 1 }])
      expect((await admin.query('SELECT count(*)::int AS events FROM meta_automation_outbox WHERE event_type=$1', [AUTOMATION_READ_EVENT])).rows)
        .toEqual([{ events: 1 }])
      expect((await admin.query('SELECT used_executions,max_executions FROM integration_automation_read_grants WHERE id=$1', [pair.grantId])).rows)
        .toEqual([{ used_executions: 1, max_executions: 1 }])
      expect((await admin.query('SELECT count(*)::int AS claims FROM integration_b2a_operation_claim')).rows).toEqual([{ claims: 1 }])
      expect(fixture.nativeStatements).toHaveLength(readCount)
      expect(await snapshotBusiness()).toEqual(beforePreview)
    } finally {
      try {
        await rules.shutdown(); await fixture.runtime.stop(); await fixture.http.drainHandlers()
        await Promise.allSettled(metricsObservers.flatMap(observed => observed.mock.results
          .filter(result => result.type === 'return' && result.value instanceof Promise).map(result => result.value as Promise<unknown>)))
      } finally {
        for (const observed of metricsObservers.reverse()) observed.mockRestore()
        approvalConnect?.mockRestore()
        try { await fixture.close() } finally { restoreFlags() }
      }
    }
  }, 60000)
  it('FWB update producer: actual published linked approval → derived target update image → owner-consented record admission → native readonly preview', async () => {
    const priorFlags = new Map<string, string | undefined>(['AUTOMATION_DURABLE_DELIVERY_ENABLED', 'APPROVAL_FWB_WRITEBACK_ENABLED']
      .map(name => [name, process.env[name]] as const))
    for (const name of priorFlags.keys()) process.env[name] = 'true'
    const restoreFlags = () => {
      for (const [name, value] of priorFlags) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
    const writerSheetId = 'synthetic-fwb-update-approval-sheet', recordId = 'synthetic-fwb-update-bound-record'
    const conditionField = 'synthetic-fwb-update-condition', preservedField = 'synthetic-fwb-update-preserved'
    const approverId = 'synthetic-fwb-update-approver'
    const rules = new AutomationService(new EventBus(), db as never, (statement, params) => pool.query(statement, params))
    const { poolManager } = await import('../../src/integration/db/connection-pool')
    const infrastructurePool = poolManager.get().getInternalPool()
    const { pool: approvalPool } = await import('../../src/db/pg')
    const fixture = await ownerHttpFixture(rules, false, 1, writerSheetId).catch(async error => {
      try { await rules.shutdown() } finally { restoreFlags() }
      throw error
    })
    let approvalConnect: { mockRestore(): void } | undefined
    let sourceTriggerCreated = false, sourceFunctionCreated = false
    const metricsObservers: Array<{ mock: { results: Array<{ type: string; value: unknown }> }; mockRestore(): void }> = []
    try {
      if (!approvalPool) throw new Error('SYNTHETIC_APPROVAL_POOL_REQUIRED')
      if (approvalPool !== pool && approvalPool !== infrastructurePool) {
        approvalConnect = vi.spyOn(approvalPool, 'connect').mockImplementation(pool.connect.bind(pool))
      }
      await admin.query("UPDATE automation_rules SET action_type='notify' WHERE id=$1", [ruleId])
      await bootstrapOwnedApprovalAfterImageSchema({ db, query: (statement, params) => admin.query(statement, params), mode: 'existing' })
      approvalSchemaReady = true
      for (const migration of [addFwbClaims, addFwbAction, addOperationAudit, fixOperationAudit, addReadPreviewAction]) {
        await db.transaction().execute(migration)
      }
      fwbSchemaReady = true
      // Production record-link row-auth locks select the UUID permission key.
      // Append its real default locally, retaining the fixture's legacy order.
      await admin.query(`ALTER TABLE ONLY "${schema}".record_permissions
        ADD COLUMN IF NOT EXISTS id uuid PRIMARY KEY DEFAULT gen_random_uuid()`)
      await admin.query('ALTER TABLE meta_bases ADD COLUMN IF NOT EXISTS owner_id text')
      await admin.query('UPDATE meta_bases SET owner_id=$2 WHERE id=$1', [baseId, actor.actorId])
      await admin.query('UPDATE automation_rules SET action_type=$2 WHERE id=$1', [ruleId, AUTOMATION_READ_ACTION_TYPE])
      await admin.query('INSERT INTO meta_sheets(id,base_id) VALUES ($1,$2)', [writerSheetId, baseId])
      expect(writerSheetId).not.toBe(sheetId)
      await admin.query("INSERT INTO meta_fields(id,sheet_id,name,type,property) VALUES ($1,$3,$1,'string','{}'),($2,$3,$2,'string','{}')",
        [conditionField, preservedField, sheetId])
      await admin.query(`UPDATE automation_rules SET trigger_type='record.updated',trigger_config='{}',conditions=$2::jsonb WHERE id=$1`,
        [ruleId, JSON.stringify({ logic: 'and', conditions: [
          { fieldId: conditionField, operator: 'equals', value: 'SYN-FWB-SAVED' },
          { fieldId: preservedField, operator: 'equals', value: 'SYN-FWB-PRESERVED' },
        ] })])
      await admin.query(`INSERT INTO meta_records(id,sheet_id,data,version,created_by,created_at,updated_at)
        VALUES($1,$2,$3::jsonb,1,$4,now(),now())`,
      [recordId, sheetId, JSON.stringify({ [conditionField]: 'SYN-FWB-BEFORE', [preservedField]: 'SYN-FWB-PRESERVED' }), actor.actorId])
      await admin.query(`INSERT INTO users(id,name,email,role,permissions,is_active,activation_status)
        VALUES ($1,$1,'synthetic-fwb-update-approver@example.test','user','[]',true,'activated')`, [approverId])
      await admin.query('INSERT INTO roles(id,name) VALUES ($1,$2)', ['integration_admin', 'Synthetic integration owner'])
      await admin.query("INSERT INTO user_permissions VALUES ($1,'approvals:write'),($1,'approvals:read'),($1,'workflow:create')", [actor.actorId])
      await admin.query("INSERT INTO spreadsheet_permissions VALUES ($1,'user',$3,'spreadsheet:admin'),($2,'user',$3,'spreadsheet:admin')",
        [sheetId, writerSheetId, actor.actorId])
      const { getApprovalMetricsService } = await import('../../src/services/ApprovalMetricsService')
      const metrics = getApprovalMetricsService()
      metricsObservers.push(vi.spyOn(metrics, 'recordInstanceStart'), vi.spyOn(metrics, 'recordNodeDecision'), vi.spyOn(metrics, 'recordTerminal'))

      const options = await fixture.http.request('GET', ownerPath + '/options?sheetId=' + sheetId, { token: fixture.token })
      expect(options.status).toBe(200)
      const option = (responseData(options).items as Row[]).find(item => (item.selector as ReadSelector).ruleId === ruleId)
      expect(option).toMatchObject({ recordActivationEligible: true, recordTriggerType: 'record.updated',
        recordCondition: { mode: 'saved_conditions' } })
      const activated = await fixture.http.request('POST', ownerPath + '/record-activations', { token: fixture.token, body: {
        activationKey: randomUUID(), selector: fixture.selector, projectNo: 'SYN-PROJECT',
        expectedRecordCondition: option!.recordCondition, expectedRuleRevision: option!.recordRuleRevision,
        budget: { maxRows: 60, maxPages: 20, maxReadCount: 200, timeoutMs: 25000 },
        maxExecutions: 1, expiresAt: '2099-01-01T00:00:00.000Z',
      } })
      expect(activated.status).toBe(201)
      const pair = responseData(activated)
      const approvals = new ApprovalProductService()
      const template = await approvals.createTemplate({
        key: 'synthetic-fwb-update-' + randomUUID(), name: 'Synthetic FWB update', visibilityScope: { type: 'all', ids: [] },
        formSchema: { fields: [{ id: 'summary', type: 'text', label: 'Summary', required: true },
          { id: 'linked', type: 'record-link', label: 'Bound record', required: true, props: { baseId, sheetId } }] },
        approvalGraph: {
          nodes: [{ key: 'start', type: 'start', name: 'Start', config: {} },
            { key: 'approval_1', type: 'approval', name: 'Synthetic approver', config: {
              assigneeSources: [{ kind: 'static_user', userIds: [approverId] }], approvalMode: 'single', emptyAssigneePolicy: 'error',
            } }, { key: 'end', type: 'end', name: 'End', config: {} }],
          edges: [{ key: 'start-approval', source: 'start', target: 'approval_1' }, { key: 'approval-end', source: 'approval_1', target: 'end' }],
        },
      })
      await approvals.publishTemplate(template.id, { policy: { allowRevoke: true }, actorUserId: actor.actorId })
      const templateVersion = (await admin.query('SELECT active_version_id FROM approval_templates WHERE id=$1', [template.id])).rows[0].active_version_id
      const mappings = [{ formFieldId: 'summary', targetFieldId: conditionField, targetType: 'text' }]
      const confirmation = await fixture.http.request('POST', `/api/multitable/sheets/${writerSheetId}/automations/fwb/confirm`, {
        token: fixture.token, body: { mode: 'update', recordLinkFieldId: 'linked', templateId: template.id,
          sourceTemplateVersionId: templateVersion, mappings },
      })
      expect(confirmation.status, 'SYNTHETIC_FWB_UPDATE_CONFIRM_STATUS').toBe(200)
      const confirmed = confirmation.body as Row
      expect(confirmed).toMatchObject({ confirmationHash: expect.any(String), templateId: template.id,
        sourceTemplateVersionId: templateVersion, targetSheetId: sheetId, targetBaseId: baseId })
      expect((await admin.query(`SELECT actor_id,resource_id,metadata FROM operation_audit_logs WHERE action='automation.fwb_confirm'`)).rows)
        .toEqual([{ actor_id: actor.actorId, resource_id: writerSheetId, metadata: expect.objectContaining({
          mode: 'update', recordLinkFieldId: 'linked', targetSheetId: sheetId, targetBaseId: baseId,
          sourceTemplateVersionId: templateVersion, confirmationHash: confirmed.confirmationHash,
        }) }])
      const fwbConfig = { mode: 'update', recordLinkFieldId: 'linked', sourceTemplateVersionId: templateVersion,
        confirmationHash: confirmed.confirmationHash, mappings }
      const writerRule = await rules.createRule(writerSheetId, { name: 'Synthetic FWB updater', triggerType: 'approval.completed',
        triggerConfig: { templateId: template.id, outcomes: ['approved'] }, actionType: 'write_approval_form_values',
        actionConfig: fwbConfig, actions: [{ type: 'write_approval_form_values', config: fwbConfig }], createdBy: actor.actorId })
      // The real database mutation differs from the mapped input and preserves
      // an unmapped field. Only RETURNING can supply the complete saved image.
      await admin.query(`CREATE FUNCTION "${schema}".synthetic_fwb_update_saved_image() RETURNS trigger LANGUAGE plpgsql AS $body$
        BEGIN
          IF NEW.id='${recordId}' AND NEW.data->>'${conditionField}'='SYN-FWB-INPUT' THEN
            NEW.data := pg_catalog.jsonb_set(NEW.data,ARRAY['${conditionField}'],pg_catalog.to_jsonb('SYN-FWB-SAVED'::text));
          END IF;
          RETURN NEW;
        END; $body$`)
      sourceFunctionCreated = true
      await admin.query(`CREATE TRIGGER synthetic_fwb_update_saved_image BEFORE UPDATE ON "${schema}".meta_records
        FOR EACH ROW EXECUTE FUNCTION "${schema}".synthetic_fwb_update_saved_image()`)
      sourceTriggerCreated = true
      const form = { summary: 'SYN-FWB-INPUT', linked: { recordId } }
      const instance = await approvals.createApproval({ templateId: template.id, formData: form },
        { userId: actor.actorId, userName: 'Synthetic owner' })
      await approvals.dispatchAction(instance.id, { action: 'approve', comment: 'Synthetic approval' },
        { userId: approverId, userName: 'Synthetic approver' })
      const completion = (await admin.query("SELECT id,event_id,payload,automation_depth FROM meta_automation_outbox WHERE event_type='approval.approved'")).rows
      expect(completion).toHaveLength(1)
      expect(completion[0].payload).toMatchObject({ eventId: completion[0].event_id, source: 'approval-product',
        approval: { instanceId: instance.id, templateId: template.id, templateVersionId: templateVersion }, transition: { toStatus: 'approved' } })
      expect((await admin.query('SELECT status,org_id,form_snapshot FROM approval_instances WHERE id=$1', [instance.id])).rows)
        .toEqual([{ status: 'approved', org_id: actor.tenantId, form_snapshot: form }])
      expect((await admin.query('SELECT data,version FROM meta_records WHERE id=$1', [recordId])).rows)
        .toEqual([{ data: { [conditionField]: 'SYN-FWB-BEFORE', [preservedField]: 'SYN-FWB-PRESERVED' }, version: 1 }])
      expect((await admin.query('SELECT outbox_id FROM meta_automation_record_after_images')).rows).toEqual([])
      expect((await admin.query('SELECT id FROM integration_automation_read_requests')).rows).toEqual([])
      expect(fixture.nativeStatements).toEqual([])

      const unexpected = async (): Promise<never> => { throw new Error('SYNTHETIC_UNEXPECTED_UNRELATED_CONSUMER') }
      const handlers = buildDurableConsumerHandlers({ automationService: rules, automationReadRecord: { produce: fixture.runtime.produceRecord },
        projectionService: { reconcile: unexpected }, webhookService: { deliverEvent: unexpected },
        recordApprovalService: { handleApprovalCompletion: unexpected },
        todoMirrorService: { handleApprovalTaskCreated: unexpected, handleApprovalCompletion: unexpected } })
      const adapters = buildConsumerAdapterRegistry(handlers, createAutomationReadDelivery({ transaction, execute: fixture.executeObserved }))
      const approvalOnly = new ConsumerAdapterRegistry(), recordOnly = new ConsumerAdapterRegistry(), readOnly = new ConsumerAdapterRegistry()
      approvalOnly.register(adapters.get('approval-trigger')!)
      recordOnly.register(adapters.get('automation-record-trigger')!)
      readOnly.register(adapters.get(AUTOMATION_READ_CONSUMER)!)
      expect(await runDispatchTick(pool, approvalOnly, { batchSize: 1 })).toMatchObject({ completed: 1, rescheduled: 0 })
      expect((await admin.query('SELECT status,steps FROM multitable_automation_executions WHERE rule_id=$1', [writerRule.id])).rows)
        .toEqual([expect.objectContaining({ status: 'success', steps: [expect.objectContaining({
          actionType: 'write_approval_form_values', status: 'success', output: { mode: 'update', alreadyApplied: false },
        })] })])
      const written = (await admin.query(`SELECT o.id,o.event_id,o.automation_depth,i.sheet_id,i.record_id,i.record_version,i.after_image,
          i.schema_revision,(i.after_image=r.data) AS exact_stored_image,v.source,v.action,v.actor_id,v.snapshot,v.patch
        FROM meta_automation_outbox o JOIN meta_automation_record_after_images i ON i.outbox_id=o.id
        JOIN meta_records r ON r.id=i.record_id JOIN meta_record_revisions v ON v.record_id=r.id AND v.version=i.record_version
        WHERE o.event_type='multitable.record.updated'`)).rows
      expect(written).toHaveLength(1)
      const image = { [conditionField]: 'SYN-FWB-SAVED', [preservedField]: 'SYN-FWB-PRESERVED' }, record = written[0]
      expect(record).toMatchObject({ sheet_id: sheetId, record_id: recordId, record_version: '2', automation_depth: 1,
        after_image: image, snapshot: image, patch: { [conditionField]: 'SYN-FWB-INPUT' },
        schema_revision: (option!.recordCondition as Row).schemaRevision, exact_stored_image: true,
        source: 'automation', action: 'update', actor_id: actor.actorId })
      expect(record.after_image).not.toEqual(record.patch)
      expect((await admin.query('SELECT instance_id,rule_id,application_mode FROM meta_fwb_action_applied')).rows)
        .toEqual([{ instance_id: instance.id, rule_id: writerRule.id, application_mode: 'apply' }])
      await admin.query('UPDATE meta_records SET data=$2::jsonb,version=version+1 WHERE id=$1',
        [recordId, JSON.stringify({ [conditionField]: 'SYN-FWB-LATER', [preservedField]: 'SYN-FWB-LATER-PRESERVED' })])
      expect((await admin.query('SELECT data,version FROM meta_records WHERE id=$1', [recordId])).rows)
        .toEqual([{ data: { [conditionField]: 'SYN-FWB-LATER', [preservedField]: 'SYN-FWB-LATER-PRESERVED' }, version: 3 }])
      const businessTables = ['meta_bases', 'meta_sheets', 'meta_fields', 'meta_records', 'meta_record_revisions',
        'syn_pathlink', 'syn_path', 'syn_order', 'syn_orderline', 'syn_part', 'syn_bom', 'syn_bomline'] as const
      const snapshotBusiness = async () => {
        const snapshot: Record<string, unknown> = {}
        for (const table of businessTables) snapshot[table] = (await admin.query(
          'SELECT row_to_json(b) AS row FROM ' + table + ' b ORDER BY row_to_json(b)::text COLLATE "C"')).rows
        return snapshot
      }
      const beforePreview = await snapshotBusiness()
      expect(await runDispatchTick(pool, recordOnly, { batchSize: 1 })).toMatchObject({ completed: 1, rescheduled: 0 })
      const requests = (await admin.query('SELECT id,status,trigger_type,grant_id FROM integration_automation_read_requests')).rows
      expect(requests).toHaveLength(1)
      const request = requests[0]
      expect(request).toMatchObject({ status: 'queued', trigger_type: 'record', grant_id: pair.grantId })
      await executionAudit(String(request.id), ruleId, 'queued')
      expect(fixture.nativeStatements).toEqual([])
      expect(await runDispatchTick(pool, readOnly, { batchSize: 1, adapterTimeoutMs: 30000 })).toMatchObject({ completed: 1, rescheduled: 0 })
      await fixture.drainObservedTransactions()
      const observed = await fixture.http.request('GET', ownerPath + '/requests/' + request.id, { token: fixture.token })
      expect(observed.status).toBe(200)
      const runtimeDiagnostic = fixture.runtimeDiagnostics()
      expect(runtimeDiagnostic.execution).toEqual([expect.objectContaining({ outcome: 'returned', status: 'succeeded' })])
      expect(runtimeDiagnostic.runtimeTransactions.queryCount).toBeGreaterThan(0)
      expect(runtimeDiagnostic.runtimeTransactions.committed).toBeGreaterThan(0)
      expect(responseData(observed), JSON.stringify(runtimeDiagnostic)).toMatchObject({ requestId: request.id, status: 'succeeded',
        result: { status: 'ready', counts: { add: 1 }, canApply: false } })
      await executionAudit(String(request.id), ruleId, 'succeeded')
      const readCount = fixture.nativeStatements.length
      expect(readCount).toBeGreaterThan(0)
      expect(await snapshotBusiness()).toEqual(beforePreview)
      // Test-controlled re-enqueue of the actual approved receipt changes only
      // the event identity. It is neither another approval nor an auto retry.
      const newEventId = String(completion[0].event_id) + ':synthetic-replay'
      const repeated = await transaction(trx => enqueueOutboxEvent(trx, { eventType: 'approval.approved', eventId: newEventId,
        payload: { ...(completion[0].payload as Row), eventId: newEventId }, automationDepth: Number(completion[0].automation_depth) }))
      expect(await runDispatchTick(pool, approvalOnly, { batchSize: 1 })).toMatchObject({ completed: 1, rescheduled: 0 })
      const replayExecutions = (await admin.query('SELECT status,steps FROM multitable_automation_executions WHERE rule_id=$1', [writerRule.id])).rows
      expect(replayExecutions).toHaveLength(2)
      expect(replayExecutions).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'success',
        steps: [expect.objectContaining({ actionType: 'write_approval_form_values', status: 'success',
          output: { mode: 'update', alreadyApplied: true } })] })]))
      expect((await admin.query('SELECT payload FROM meta_automation_outbox WHERE id=$1', [repeated.outboxId])).rows[0].payload)
        .toMatchObject({ eventId: repeated.eventId, approval: { instanceId: instance.id, templateVersionId: templateVersion } })
      for (const [outboxId, consumer, registry] of [
        [completion[0].id, 'approval-trigger', approvalOnly], [record.id, 'automation-record-trigger', recordOnly],
      ] as const) {
        await admin.query("UPDATE meta_automation_outbox_consumer SET status='pending',lease_expires_at=NULL WHERE outbox_id=$1 AND consumer_key=$2", [outboxId, consumer])
        expect(await runDispatchTick(pool, registry, { batchSize: 1 })).toMatchObject({ completed: 1, rescheduled: 0 })
      }
      await admin.query("UPDATE meta_automation_outbox_consumer SET status='pending',lease_expires_at=NULL WHERE consumer_key=$1", [AUTOMATION_READ_CONSUMER])
      expect(await runDispatchTick(pool, readOnly, { batchSize: 1 })).toMatchObject({ completed: 1, rescheduled: 0 })
      expect((await admin.query('SELECT id FROM integration_automation_read_requests')).rows).toEqual([{ id: request.id }])
      expect((await admin.query('SELECT sheet_id,record_id,record_version,after_image FROM meta_automation_record_after_images')).rows)
        .toEqual([{ sheet_id: sheetId, record_id: recordId, record_version: '2', after_image: image }])
      expect((await admin.query('SELECT count(*)::int AS claims FROM meta_fwb_action_applied')).rows).toEqual([{ claims: 1 }])
      expect((await admin.query("SELECT count(*)::int AS events FROM meta_automation_outbox WHERE event_type='multitable.record.updated'")).rows)
        .toEqual([{ events: 1 }])
      expect((await admin.query('SELECT count(*)::int AS events FROM meta_automation_outbox WHERE event_type=$1', [AUTOMATION_READ_EVENT])).rows)
        .toEqual([{ events: 1 }])
      expect((await admin.query('SELECT used_executions,max_executions FROM integration_automation_read_grants WHERE id=$1', [pair.grantId])).rows)
        .toEqual([{ used_executions: 1, max_executions: 1 }])
      expect((await admin.query('SELECT count(*)::int AS claims FROM integration_b2a_operation_claim')).rows).toEqual([{ claims: 1 }])
      expect(fixture.nativeStatements).toHaveLength(readCount)
      expect(await snapshotBusiness()).toEqual(beforePreview)
    } finally {
      try { await rules.shutdown() }
      finally {
        try { await fixture.runtime.stop() }
        finally {
          try {
            try { await fixture.http.drainHandlers() }
            finally {
              await Promise.allSettled(metricsObservers.flatMap(observed => observed.mock.results
                .filter(result => result.type === 'return' && result.value instanceof Promise).map(result => result.value as Promise<unknown>)))
            }
          } finally {
            for (const observed of metricsObservers.reverse()) observed.mockRestore()
            approvalConnect?.mockRestore()
            try { await fixture.close() }
            finally {
              try { await fixture.drainObservedTransactions() }
              finally {
                try {
                  if (sourceTriggerCreated) await admin.query(`DROP TRIGGER synthetic_fwb_update_saved_image ON "${schema}".meta_records`)
                } finally {
                  try {
                    if (sourceFunctionCreated) await admin.query(`DROP FUNCTION "${schema}".synthetic_fwb_update_saved_image()`)
                  } finally { restoreFlags() }
                }
              }
            }
          }
        }
      }
    }
  }, 60000)

  it('recovery HTTP producer: actual hot preview/execute → saved image → owner-consented condition → native readonly preview', async () => {
    // This is the hot public route, not archive sync/async coverage. Bootstrap
    // happens only in this final case; previous beforeEach/TRUNCATE is unchanged.
    const flagNames = ['AUTOMATION_DURABLE_DELIVERY_ENABLED', 'MULTITABLE_ENABLE_WRITER_FENCE',
      'MULTITABLE_HISTORY_CONTIGUITY_STRICT', 'MULTITABLE_ENABLE_SHEET_REVERT', 'MULTITABLE_META_REVISION_RETENTION_ENABLED']
    const previousFlags = new Map(flagNames.map(name => [name, process.env[name]]))
    for (const name of flagNames) process.env[name] = name === 'MULTITABLE_META_REVISION_RETENTION_ENABLED' ? '0' : 'true'
    const recordId = 'synthetic-recovery-http-record', conditionField = 'synthetic-recovery-http-condition'
    const preservedField = 'synthetic-recovery-http-preserved', xidField = 'synthetic-recovery-http-xid'
    const fields = [conditionField, preservedField, xidField]
    const projected = { [conditionField]: 'SYN-RECOVERY-INPUT', [preservedField]: 'SYN-RECOVERY-PRESERVED', [xidField]: 'SYN-NONE' }
    const before = { ...projected, [conditionField]: 'SYN-RECOVERY-BEFORE' }
    const rules = new AutomationService(new EventBus(), db as never, (statement, params) => pool.query(statement, params))
    let fixture: Awaited<ReturnType<typeof ownerHttpFixture>> | undefined
    let recoverySchema: Awaited<ReturnType<typeof bootstrapOwnedRecoveryAfterImageSchema>> | undefined
    let recordTriggerCreated = false, recordFunctionCreated = false
    const { poolManager } = await import('../../src/integration/db/connection-pool')
    const infrastructure = poolManager.get()
    // A plain spy calls the actual transaction method exactly once and retains
    // its ORIGINAL Promise. In particular, drain the detached post-commit burn
    // prune before restoring HTTP transport; neither prune nor transactions are
    // replaced with a success/no-op implementation.
    const recoveryTransactions = vi.spyOn(infrastructure, 'transaction')
    const recoveryErrors: unknown[] = []
    const drainRecoveryTransactions = async () => {
      let drained = 0
      while (drained < recoveryTransactions.mock.results.length) {
        const results = recoveryTransactions.mock.results.slice(drained)
        drained += results.length
        await Promise.allSettled(results.filter(result => result.type === 'return' && result.value instanceof Promise)
          .map(result => result.value as Promise<unknown>))
      }
    }
    try {
      recoverySchema = await bootstrapOwnedRecoveryAfterImageSchema({ db, schema, query: (statement, params) => admin.query(statement, params) })
      await admin.query('ALTER TABLE meta_bases ADD COLUMN IF NOT EXISTS owner_id text')
      await admin.query('UPDATE meta_bases SET owner_id=$2 WHERE id=$1', [baseId, actor.actorId])
      // Actual non-admin user plus explicit current grants; no admin-role or
      // constant-allow recovery evaluator is substituted.
      expect((await admin.query('SELECT role FROM users WHERE id=$1', [actor.actorId])).rows).toEqual([{ role: 'user' }])
      await admin.query("INSERT INTO user_permissions VALUES ($1,'multitable:write'),($1,'multitable:share'),($1,'multitable:manage-schema')", [actor.actorId])
      await admin.query("INSERT INTO spreadsheet_permissions(sheet_id,subject_type,subject_id,perm_code) VALUES ($1,'user',$2,'spreadsheet:admin')", [sheetId, actor.actorId])
      // executionFixture installs the native target profile by deleting and
      // rebuilding meta_fields. Complete it BEFORE configuring the condition
      // fields and trusted history, just as the ordinary producer cases do.
      fixture = await ownerHttpFixture(rules, false, 1, false, sheetId)
      for (const [index, field] of fields.entries()) await admin.query(`INSERT INTO meta_fields(id,sheet_id,name,type,property,"order")
        VALUES($1,$2,$1,'string','{}',$3)`, [field, sheetId, index + 100])
      await admin.query(`UPDATE automation_rules SET trigger_type='record.updated',trigger_config='{}',conditions=$2::jsonb WHERE id=$1`,
        [ruleId, JSON.stringify({ logic: 'and', conditions: [
          { fieldId: conditionField, operator: 'equals', value: 'SYN-RECOVERY-SAVED' },
          { fieldId: preservedField, operator: 'equals', value: 'SYN-RECOVERY-PRESERVED' },
        ] })])
      expect((await admin.query('SELECT trigger_type,conditions FROM automation_rules WHERE id=$1', [ruleId])).rows)
        .toEqual([{ trigger_type: 'record.updated', conditions: { logic: 'and', conditions: [
          { fieldId: conditionField, operator: 'equals', value: 'SYN-RECOVERY-SAVED' },
          { fieldId: preservedField, operator: 'equals', value: 'SYN-RECOVERY-PRESERVED' },
        ] } }])
      expect((await admin.query('SELECT id FROM meta_fields WHERE id=ANY($1::text[]) ORDER BY id', [fields])).rows)
        .toEqual([...fields].sort().map(id => ({ id })))
      // Real fenced checkpoint + two real sealed operations form the trusted
      // synthetic history. These seed no record event/image or read request.
      await tx(admin, async trx => {
        const query = (statement: string, params?: unknown[]) => trx.query(statement, params)
        await acquireCanonicalSheetFence(query, sheetId)
        await activateCheckpoint(query, { sheetId })
      })
      const anchor = await tx(admin, async trx => {
        const query = (statement: string, params?: unknown[]) => trx.query(statement, params)
        await acquireCanonicalSheetFence(query, sheetId)
        const ledger = await mintOperation(query, sheetId)
        await query(`INSERT INTO meta_records(id,sheet_id,data,version,created_by,modified_by,created_at,updated_at)
          VALUES($1,$2,$3::jsonb,1,$4,$4,now(),now())`, [recordId, sheetId, JSON.stringify(projected), actor.actorId])
        await recordRecordRevision(query, { sheetId, recordId, version: 1, action: 'create', source: 'rest',
          actorId: actor.actorId, changedFieldIds: fields, patch: projected, snapshot: projected, ledger })
        expect(await sealOperation(query, ledger)).toBe(true)
        return ledger.operationId
      })
      expect(anchor).toEqual(expect.any(String))
      await tx(admin, async trx => {
        const query = (statement: string, params?: unknown[]) => trx.query(statement, params)
        await acquireCanonicalSheetFence(query, sheetId)
        const ledger = await mintOperation(query, sheetId)
        await query('UPDATE meta_records SET data=$2::jsonb,version=2 WHERE id=$1', [recordId, JSON.stringify(before)])
        await recordRecordRevision(query, { sheetId, recordId, version: 2, action: 'update', source: 'rest',
          actorId: actor.actorId, changedFieldIds: [conditionField], patch: { [conditionField]: before[conditionField] }, snapshot: before, ledger })
        expect(await sealOperation(query, ledger)).toBe(true)
      })
      const previewPath = `/api/multitable/sheets/${encodeURIComponent(sheetId)}/revert-preview`
      const executePath = `/api/multitable/sheets/${encodeURIComponent(sheetId)}/revert-execute`
      expect((await fixture.http.request('POST', previewPath, { body: { anchorOperationId: anchor } })).status).toBe(401)
      const options = await fixture.http.request('GET', ownerPath + '/options?sheetId=' + sheetId, { token: fixture.token })
      expect(options.status).toBe(200)
      const option = (responseData(options).items as Row[]).find(item => (item.selector as ReadSelector).ruleId === ruleId)
      expect(option).toMatchObject({ recordActivationEligible: true, recordTriggerType: 'record.updated',
        recordCondition: { mode: 'saved_conditions' } })
      const activated = await fixture.http.request('POST', ownerPath + '/record-activations', { token: fixture.token, body: {
        activationKey: randomUUID(), selector: fixture.selector, projectNo: 'SYN-PROJECT',
        expectedRecordCondition: option!.recordCondition, expectedRuleRevision: option!.recordRuleRevision,
        budget: { maxRows: 60, maxPages: 20, maxReadCount: 200, timeoutMs: 25000 },
        maxExecutions: 1, expiresAt: '2099-01-01T00:00:00.000Z',
      } })
      expect(activated.status).toBe(201)
      const pair = responseData(activated)
      const preview = await fixture.http.request('POST', previewPath, { token: fixture.token, body: { anchorOperationId: anchor } })
      expect(preview.status, 'SYNTHETIC_HOT_PREVIEW_STATUS').toBe(200)
      const previewData = responseData(preview)
      expect(previewData).toMatchObject({ strategy: 'revert', anchorOperationId: anchor,
        summary: { visibleRevertCount: 1, effectiveWriteCount: 1, deleteCount: 0, resurrectCount: 0 }, executable: true,
        previewIdentity: expect.any(String) })
      const identity = previewData.previewIdentity
      await admin.query(`INSERT INTO field_permissions(sheet_id,field_id,subject_type,subject_id,visible,read_only)
        VALUES($1,$2,'user',$3,true,true)`, [sheetId, conditionField, actor.actorId])
      const denied = await fixture.http.request('POST', executePath, { token: fixture.token, body: { previewIdentity: identity } })
      expect(denied.status, 'SYNTHETIC_HOT_CURRENT_FIELD_PERMISSION_REFUSAL').toBe(403)
      expect((await admin.query('SELECT data,version FROM meta_records WHERE id=$1', [recordId])).rows).toEqual([{ data: before, version: 2 }])
      expect((await admin.query('SELECT token_sha256 FROM meta_recovery_token_burns')).rows).toEqual([])
      expect((await admin.query('SELECT outbox_id FROM meta_automation_record_after_images')).rows).toEqual([])
      await admin.query("DELETE FROM field_permissions WHERE sheet_id=$1 AND field_id=$2 AND subject_type='user' AND subject_id=$3", [sheetId, conditionField, actor.actorId])
      await admin.query(`CREATE FUNCTION "${schema}".synthetic_recovery_http_saved_image() RETURNS trigger LANGUAGE plpgsql AS $body$
        BEGIN
          IF NEW.id='${recordId}' AND NEW.data->>'${conditionField}'='SYN-RECOVERY-INPUT' THEN
            NEW.data := jsonb_set(NEW.data,ARRAY['${conditionField}'],to_jsonb('SYN-RECOVERY-SAVED'::text));
            NEW.data := jsonb_set(NEW.data,ARRAY['${xidField}'],to_jsonb(pg_current_xact_id()::text));
          END IF;
          RETURN NEW;
        END; $body$`)
      recordFunctionCreated = true
      await admin.query(`CREATE TRIGGER synthetic_recovery_http_saved_image BEFORE UPDATE ON "${schema}".meta_records
        FOR EACH ROW EXECUTE FUNCTION "${schema}".synthetic_recovery_http_saved_image()`)
      recordTriggerCreated = true
      expect((await admin.query('SELECT id FROM meta_automation_outbox')).rows).toEqual([])
      expect((await admin.query('SELECT id FROM integration_automation_read_requests')).rows).toEqual([])
      expect(fixture.nativeStatements).toEqual([])
      const executed = await fixture.http.request('POST', executePath, { token: fixture.token, body: { previewIdentity: identity } })
      expect(executed.status, 'SYNTHETIC_HOT_EXECUTE_STATUS').toBe(200)
      expect(responseData(executed)).toMatchObject({ strategy: 'revert', revertedCount: 1 })
      await fixture.http.drainHandlers()
      await drainRecoveryTransactions()
      const images = (await admin.query(`SELECT o.id,o.event_id,o.automation_depth,o.payload,i.sheet_id,i.record_id,i.record_version,
        i.after_image,i.schema_revision,v.source,v.action,v.actor_id,v.snapshot,v.patch,v.operation_id::text,
        b.token_sha256,(i.after_image=r.data) AS exact_stored_image,
        o.xmin::text AS event_xid,i.xmin::text AS image_xid,r.xmin::text AS record_xid,
        v.xmin::text AS revision_xid,h.xmin::text AS operation_xid,b.xmin::text AS burn_xid
        FROM meta_automation_outbox o JOIN meta_automation_record_after_images i ON i.outbox_id=o.id
        JOIN meta_records r ON r.id=i.record_id JOIN meta_record_revisions v ON v.record_id=r.id AND v.version=i.record_version
        JOIN meta_record_history_operations h ON h.sheet_id=v.sheet_id AND h.operation_id=v.operation_id
        JOIN meta_recovery_token_burns b ON b.sheet_id=i.sheet_id
        WHERE o.event_type='multitable.record.updated'`)).rows
      expect(images).toHaveLength(1)
      const image = images[0]
      const saved = { ...projected, [conditionField]: 'SYN-RECOVERY-SAVED', [xidField]: image.record_xid }
      expect(image).toMatchObject({ sheet_id: sheetId, record_id: recordId, record_version: '3', after_image: saved,
        snapshot: projected, patch: { [conditionField]: 'SYN-RECOVERY-INPUT' }, source: 'restore', action: 'update',
        actor_id: actor.actorId, exact_stored_image: true, schema_revision: (option!.recordCondition as Row).schemaRevision })
      expect(new Set([image.event_xid, image.image_xid, image.record_xid, image.revision_xid, image.operation_xid, image.burn_xid]).size).toBe(1)
      expect(image.token_sha256).toBe(createHash('sha256').update(String(identity)).digest('hex'))
      expect(image.payload).toEqual({ sheetId, recordId, actorId: actor.actorId,
        changes: { [conditionField]: 'SYN-RECOVERY-INPUT' }, _eventId: image.event_id })
      expect(image.after_image).not.toEqual(image.snapshot)
      expect((await admin.query('SELECT recovery_writer_state FROM meta_sheets WHERE id=$1', [sheetId])).rows).toEqual([{ recovery_writer_state: null }])
      const tables = ['meta_bases', 'meta_sheets', 'meta_fields', 'meta_records', 'meta_record_revisions',
        'meta_record_history_operations', 'meta_history_trust_checkpoints', 'meta_history_baselines', 'meta_recovery_token_burns',
        'syn_pathlink', 'syn_path', 'syn_order', 'syn_orderline', 'syn_part', 'syn_bom', 'syn_bomline']
      const snapshotBusiness = async () => {
        const snapshot: Row = {}
        for (const table of tables) snapshot[table] = (await admin.query('SELECT row_to_json(b) AS row FROM '
          + table + ' b ORDER BY row_to_json(b)::text COLLATE "C"')).rows
        return snapshot
      }
      const effectCounts = async () => (await admin.query(`SELECT
        (SELECT count(*)::int FROM meta_automation_outbox) AS events,
        (SELECT count(*)::int FROM meta_automation_record_after_images) AS images,
        (SELECT count(*)::int FROM meta_recovery_token_burns) AS burns,
        (SELECT count(*)::int FROM integration_automation_read_requests) AS requests,
        (SELECT count(*)::int FROM integration_b2a_operation_claim) AS claims`)).rows[0]
      const beforeReplay = await snapshotBusiness(), beforeReplayEffects = await effectCounts()
      const replay = await fixture.http.request('POST', executePath, { token: fixture.token, body: { previewIdentity: identity } })
      // This trigger intentionally saved different user-field data from the
      // unchanged planner revision snapshot. The actual strict preflight checks
      // current content BEFORE attempting another burn; therefore this replay
      // is precisely HISTORY_INCOMPLETE, not proof of the token-replayed guard.
      // The original token burn and all effects must nevertheless persist once.
      expect(replay.status).toBe(409)
      expect(replay.body).toMatchObject({ ok: false, error: { code: 'HISTORY_INCOMPLETE' } })
      await fixture.http.drainHandlers()
      await drainRecoveryTransactions()
      expect(await snapshotBusiness()).toEqual(beforeReplay)
      expect(await effectCounts()).toEqual(beforeReplayEffects)
      expect(fixture.nativeStatements).toEqual([])
      expect(fixture.runtimeDiagnostics().execution).toEqual([])
      // The live row now fails BOTH owner-approved conditions. Dispatch must
      // still admit the actual receipt's immutable RETURNING image, not reread
      // current values or use the planner's original snapshot/patch.
      await admin.query('UPDATE meta_records SET data=$2::jsonb,version=version+1 WHERE id=$1',
        [recordId, JSON.stringify({ ...projected, [conditionField]: 'SYN-RECOVERY-LATER', [preservedField]: 'SYN-RECOVERY-LATER-PRESERVED' })])
      const beforePreview = await snapshotBusiness()
      const unexpected = async (): Promise<never> => { throw new Error('SYNTHETIC_UNEXPECTED_UNRELATED_CONSUMER') }
      const handlers = buildDurableConsumerHandlers({ automationService: rules, automationReadRecord: { produce: fixture.runtime.produceRecord },
        projectionService: { reconcile: unexpected }, webhookService: { deliverEvent: unexpected },
        recordApprovalService: { handleApprovalCompletion: unexpected },
        todoMirrorService: { handleApprovalTaskCreated: unexpected, handleApprovalCompletion: unexpected } })
      const adapters = buildConsumerAdapterRegistry(handlers, createAutomationReadDelivery({ transaction, execute: fixture.executeObserved }))
      const recordOnly = new ConsumerAdapterRegistry(), readOnly = new ConsumerAdapterRegistry()
      recordOnly.register(adapters.get('automation-record-trigger')!)
      readOnly.register(adapters.get(AUTOMATION_READ_CONSUMER)!)
      expect(await runDispatchTick(pool, recordOnly, { batchSize: 1 })).toMatchObject({ completed: 1, rescheduled: 0 })
      const requests = (await admin.query('SELECT id,status,trigger_type,grant_id FROM integration_automation_read_requests')).rows
      expect(requests).toHaveLength(1)
      const request = requests[0]
      expect(request).toMatchObject({ status: 'queued', trigger_type: 'record', grant_id: pair.grantId })
      await executionAudit(String(request.id), ruleId, 'queued')
      expect(fixture.nativeStatements).toEqual([])
      expect(await runDispatchTick(pool, readOnly, { batchSize: 1, adapterTimeoutMs: 30000 })).toMatchObject({ completed: 1, rescheduled: 0 })
      await fixture.drainObservedTransactions()
      const observed = await fixture.http.request('GET', ownerPath + '/requests/' + request.id, { token: fixture.token })
      expect(observed.status).toBe(200)
      expect(responseData(observed), JSON.stringify(fixture.runtimeDiagnostics())).toMatchObject({ requestId: request.id, status: 'succeeded',
        result: { status: 'ready', counts: { add: 1 }, canApply: false } })
      await executionAudit(String(request.id), ruleId, 'succeeded')
      expect(fixture.nativeStatements.length).toBeGreaterThan(0)
      expect(await snapshotBusiness()).toEqual(beforePreview)
      expect((await admin.query('SELECT used_executions,max_executions FROM integration_automation_read_grants WHERE id=$1', [pair.grantId])).rows)
        .toEqual([{ used_executions: 1, max_executions: 1 }])
      expect((await admin.query('SELECT count(*)::int AS claims FROM integration_b2a_operation_claim')).rows).toEqual([{ claims: 1 }])
    } catch (error) {
      recoveryErrors.push(error)
    } finally {
      const finish = async (work: () => unknown | Promise<unknown>) => { try { await work() } catch (error) { recoveryErrors.push(error) } }
      await finish(() => rules.shutdown())
      await finish(() => fixture?.runtime.stop())
      await finish(() => fixture?.http.drainHandlers())
      await finish(drainRecoveryTransactions)
      await finish(() => fixture?.drainObservedTransactions())
      await finish(() => fixture?.close())
      recoveryTransactions.mockRestore()
      if (recordTriggerCreated) await finish(() => admin.query(`DROP TRIGGER synthetic_recovery_http_saved_image ON "${schema}".meta_records`))
      if (recordFunctionCreated) await finish(() => admin.query(`DROP FUNCTION "${schema}".synthetic_recovery_http_saved_image()`))
      await finish(() => recoverySchema?.cleanup())
      for (const [name, value] of previousFlags) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
    if (recoveryErrors.length === 1) throw recoveryErrors[0]
    if (recoveryErrors.length > 1) throw new AggregateError(recoveryErrors, 'SA06AR_RECOVERY_HTTP_FAILED')
  }, 60000)
})
