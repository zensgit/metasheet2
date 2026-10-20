// Real read-runtime activation, native profile/target codecs, metadata epochs,
// finite-field ACL and SA06D private material in one owned PostgreSQL schema.
// Source execution dependencies deliberately throw: this suite reads NO records.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { YidaAutomationManagementBinding } from '../../src/integration/yida-automation-management-host'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { createYidaAutomationExecutionFixture, executionFixtureScope } from './yida-automation-execution-fixture'
import { createAutomationReadRuntime, type AutomationReadRuntimeBinding } from '../../src/integration/automation-read-runtime'
import { createYidaAutomationAuthorizationService } from '../../src/integration/yida-automation-authorization-service'
import type { InstalledYidaAutomationBinding } from '../../src/integration/yida-automation-installed-binding'
import { CURRENT_ROUTING_MANIFEST } from '../../src/multitable/automation-routing-manifest'
import { up as profiles } from '../../src/db/migrations/zzzz20261001125000_automation_read_profiles'
import { up as epochs } from '../../src/db/migrations/zzzz20261001130000_automation_read_material_epochs'
import type { TransactionalQueryable } from '../../src/multitable/pg-transaction-guard'

const root = path.resolve(__dirname, '../../../..')
const requirePlugin = createRequire(import.meta.url)
const importNative = requirePlugin('./yida-native-module-import.cjs') as (url: string) => Promise<Record<string, unknown>>
const lib = path.join(root, 'plugins/plugin-integration-core/lib')
const codec = requirePlugin(path.join(lib, 'stock-preparation-automation-profile.cjs')) as Pick<AutomationReadRuntimeBinding['codec'],
  'restoreStockPreparationAutomationProfileMaterial' | 'composeStockPreparationAutomationExecution'> & {
    prepareStockPreparationAutomationProfiles: AutomationReadRuntimeBinding['prepareProfiles'] }
const target = requirePlugin(path.join(lib, 'stock-preparation-automation-target-contract.cjs')) as Pick<AutomationReadRuntimeBinding['codec'],
  'deriveAutomationReadTargetContract'>
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE: template } = requirePlugin(path.join(lib, 'stock-preparation-templates.cjs')) as {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE: { objectId: string; fields: Array<{ id: string; name?: string; type: string }> }
}
const { PLM_STOCK_PREPARATION_ACTION_ID: actionId } = requirePlugin(path.join(lib, 'stock-preparation-table-actions.cjs')) as { PLM_STOCK_PREPARATION_ACTION_ID: string }
export const installedActor = Object.freeze({ tenantId: executionFixtureScope.tenantId, workspaceId: null, actorId: executionFixtureScope.ownerId })
export async function createYidaAutomationInstalledFixture(connectionString: string,
  fixtureOptions: { approvedSecondRow?: boolean } = {}) {
  const base = await createYidaAutomationExecutionFixture(connectionString, fixtureOptions)
  let readRuntime: ReturnType<typeof createAutomationReadRuntime> | undefined
  let enabled = true, sourceCalls = 0, runtimeTransactionsStarted = 0
  const managers = new Set<ReturnType<typeof createYidaAutomationAuthorizationService>>()
  const fieldIdMap = Object.fromEntries(template.fields.map(field => [field.id, 'mapped-' + field.id]))
  const config = { stockPreparationAutomationProfiles: [{ tenantId: String(installedActor.tenantId), workspaceId: null,
    projectId: 'synthetic-install-project-not-base', actionId }], stockPreparationTableActions: [{ actionId,
    source: { externalSystemId: 'synthetic-source-never-read' },
    target: { sheetId: 'synthetic-sheet', fieldIdMap } }] }
  async function cleanup() {
    try { await readRuntime?.stop() }
    finally { managers.forEach(manager => manager.close()); await base.cleanup() }
  }
  try {
    // This fixture is not published until all installed metadata is committed.
    // Preserve individual statements/triggers; avoid a commit per setup step.
    const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: base.pool }) })
    await db.transaction().execute(async setup => {
    await sql.raw(`ALTER TABLE meta_sheets ADD COLUMN row_level_read_permissions_enabled boolean NOT NULL DEFAULT false;
      CREATE TABLE platform_member_group_members(user_id text,group_id uuid,PRIMARY KEY(user_id,group_id));
      CREATE TABLE spreadsheet_permissions(sheet_id text,subject_type text,subject_id text,perm_code text);
      CREATE TABLE field_permissions(sheet_id text,field_id text,subject_type text,subject_id text,visible boolean,read_only boolean);
      CREATE TABLE record_permissions(sheet_id text,record_id text,subject_type text,subject_id text,access_level text);
      CREATE TABLE meta_fields(id text PRIMARY KEY,sheet_id text NOT NULL,name text NOT NULL,type text NOT NULL,
        property jsonb,"order" integer DEFAULT 0,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE TABLE meta_records(id text PRIMARY KEY,sheet_id text NOT NULL,data jsonb NOT NULL DEFAULT '{}',
        version integer DEFAULT 1,created_by text,modified_by text,created_at timestamptz,updated_at timestamptz);
      CREATE TABLE plugin_multitable_object_registry(sheet_id text PRIMARY KEY,project_id text NOT NULL,object_id text NOT NULL,
        plugin_name text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(project_id,object_id));
      INSERT INTO user_permissions VALUES ('synthetic-owner','multitable:read')`).execute(setup)
    await sql.raw(readFileSync(path.join(root, 'packages/core-backend/migrations/076_create_integration_stock_prep_pack_installs.sql'), 'utf8')).execute(setup)
    await profiles(setup); await epochs(setup)
    await sql`INSERT INTO plugin_multitable_object_registry(sheet_id,project_id,object_id,plugin_name)
      VALUES ('synthetic-sheet','synthetic-install-project-not-base',${template.objectId},'plugin-integration-core')`.execute(setup)
    for (const field of template.fields) {
      await sql`INSERT INTO meta_fields(id,sheet_id,name,type,property)
        VALUES (${fieldIdMap[field.id]},'synthetic-sheet',${field.name ?? field.id},${field.type},'{}')`.execute(setup)
    }
    })
    const unused = (): never => { sourceCalls += 1; throw new Error('SA06D_RECORD_SOURCE_IO_FORBIDDEN') }
    const binding: AutomationReadRuntimeBinding = {
      prepareProfiles: codec.prepareStockPreparationAutomationProfiles,
      codec: { restoreStockPreparationAutomationProfileMaterial: codec.restoreStockPreparationAutomationProfileMaterial,
        deriveAutomationReadTargetContract: target.deriveAutomationReadTargetContract,
        composeStockPreparationAutomationExecution: codec.composeStockPreparationAutomationExecution },
      sourceStore: { lockActiveForAutomation: async () => unused() }, preview: async () => unused(),
    }
    // base.transaction owns a real BEGIN/COMMIT client. This marker documents
    // that boundary; production xid probes still verify it against PostgreSQL.
    const runtimeTransaction = <T>(work: (trx: TransactionalQueryable) => Promise<T>) => {
      runtimeTransactionsStarted += 1 // Actual provider entry, not a fake SQL result.
      return base.transaction(trx => work(Object.freeze({ isTransaction: true as const, query: trx.query.bind(trx) })))
    }
    readRuntime = createAutomationReadRuntime({ transaction: runtimeTransaction, manifest: CURRENT_ROUTING_MANIFEST,
      getManager: unused, enabled: () => enabled, onUnavailable() {} })
    const runtime = readRuntime
    async function activate() { return runtime.createPluginCapability(config).activate(binding) }
    await activate()
    const resolve = () => base.transaction(trx => runtime.installedBindingSourceForYida()
      .resolveInTransaction(trx, installedActor, 'synthetic-rule'))
    function management(reference: InstalledYidaAutomationBinding,
      override: Partial<Parameters<typeof createYidaAutomationAuthorizationService>[0]> = {}) {
      const manager = createYidaAutomationAuthorizationService({ grantor: installedActor, binding: reference.binding,
        primitives: base.primitives, database: { transaction: base.transaction },
        activationId: '22222222-2222-4222-8222-222222222222', monotonicNow: () => base.controls.mono,
        installationRevisionInTransaction: reference.installationRevisionInTransaction, ...override })
      managers.add(manager); return manager
    }
    async function metadataAba() {
      const fieldId = fieldIdMap.projectNo
      const original = (await base.pool.query('SELECT name FROM meta_fields WHERE id=$1', [fieldId])).rows[0].name as string
      await base.pool.query('UPDATE meta_fields SET name=$2 WHERE id=$1', [fieldId, 'Synthetic temporary layout'])
      await base.pool.query('UPDATE meta_fields SET name=$2 WHERE id=$1', [fieldId, original])
    }
    const factory = await importNative(pathToFileURL(path.join(lib, 'yida-automation-runtime-factory.mjs')).href)
    const makeBinding = factory.createYidaAutomationRuntimeBinding as (input: { db: typeof base.db;
      security: Pick<typeof base.security, 'encrypt' | 'decrypt'> }) => YidaAutomationManagementBinding
    return { ...base, cleanup, readRuntime: runtime, activate, resolve, managementInstalled: management,
      automationBinding: () => makeBinding({ db: base.db, security: Object.freeze({
        encrypt: base.security.encrypt.bind(base.security), decrypt: base.security.decrypt.bind(base.security),
      }) }),
      metadataAba, fieldIdMap, config, setInstalledEnabled(value: boolean) { enabled = value },
      get runtimeTransactionsStarted() { return runtimeTransactionsStarted },
      get sourceCalls() { return sourceCalls } }
  } catch (error) { await cleanup(); throw error }
}
