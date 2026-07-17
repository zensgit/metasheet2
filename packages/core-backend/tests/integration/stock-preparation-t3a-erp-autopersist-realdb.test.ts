/**
 * Stock-preparation T3a: approved ERP read source -> internal material cache (real DB).
 *
 * This suite drives the actual route handler through the real provisioning and records APIs. It
 * deliberately discovers physical field ids from meta_fields instead of using the deterministic id
 * helper, so a broken logical-to-physical translation cannot self-prove against the same formula.
 */
import { createRequire } from 'module'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import {
  ensureObject,
  findObjectSheet,
  patchObjectFieldProperty,
  resolveObjectFieldIds,
  type MultitableProvisioningObjectDescriptor,
  type MultitableProvisioningQueryFn,
} from '../../src/multitable/provisioning'
import {
  createRecord,
  patchRecord,
  queryRecords,
  type MultitableRecordsQueryFn,
} from '../../src/multitable/records'

const require = createRequire(import.meta.url)
const { createHandlers } = require('../../../../plugins/plugin-integration-core/lib/http-routes.cjs') as {
  createHandlers: (
    services: Record<string, unknown>,
    options: { context: Record<string, unknown> },
  ) => Record<string, (req: Record<string, unknown>, res: TestResponse) => Promise<unknown>>
}
const { validateReadSourceConfig } = require('../../../../plugins/plugin-integration-core/lib/read-source-config.cjs') as {
  validateReadSourceConfig: (input: Record<string, unknown>) => {
    valid: boolean
    errors: unknown[]
    normalized: Record<string, unknown>
  }
}
const {
  ensureStockPreparationMvpTargets,
  syncStockPreparationMvpOptions,
} = require('../../../../plugins/plugin-integration-core/lib/stock-preparation-mvp-provisioning.cjs') as {
  ensureStockPreparationMvpTargets: (input: Record<string, unknown>) => Promise<Record<string, unknown>>
  syncStockPreparationMvpOptions: (input: Record<string, unknown>) => Promise<Record<string, unknown>>
}
const {
  MATERIAL_OBJECT_ID,
  RUN_OBJECT_ID,
} = require('../../../../plugins/plugin-integration-core/lib/stock-preparation-erp-material-sync-persist.cjs') as {
  MATERIAL_OBJECT_ID: string
  RUN_OBJECT_ID: string
}
const { STOCK_PREPARATION_MVP_TABLE_TEMPLATES } = require('../../../../plugins/plugin-integration-core/lib/stock-preparation-templates.cjs') as {
  STOCK_PREPARATION_MVP_TABLE_TEMPLATES: Array<{
    objectId: string
    fields: Array<{ id: string; label: string; type: string }>
  }>
}

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TOKEN = `${process.pid}_${Date.now().toString(36)}`
const TENANT_ID = `tenant_t3a_${TOKEN}`
const TARGET_PROJECT_ID = `${TENANT_ID}:integration-core`
const CONFIG_ID = `cfg_t3a_${TOKEN}`
const SYSTEM_ID = `sys_t3a_${TOKEN}`
const SYNC_RUN_ID = `run_t3a_${TOKEN}`
const MATERIAL_INTERNAL_ID = `internal_t3a_${TOKEN}`
const MATERIAL_CODE = `ERP-CODE-T3A-${TOKEN}`
const MATERIAL_NAME = `ERP-NAME-T3A-${TOKEN}`
const SOURCE_CREDENTIAL = `ERP-CREDENTIAL-T3A-${TOKEN}`
const FLAG = 'MULTITABLE_STOCK_PREP_ERP_AUTOPERSIST_ENABLED'

type QueryResult = { rows: unknown[]; rowCount?: number | null }
type TestResponse = {
  statusCode: number
  body: unknown
  status(code: number): TestResponse
  json(body: unknown): unknown
}

function wrapQuery(
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>,
): MultitableProvisioningQueryFn & MultitableRecordsQueryFn {
  return async (sql, params) => {
    const result = await query(sql, params)
    return {
      rows: Array.isArray(result.rows) ? result.rows : [],
      rowCount: typeof result.rowCount === 'number' ? result.rowCount : undefined,
    }
  }
}

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

function transaction<T>(handler: (query: MultitableRecordsQueryFn) => Promise<T>): Promise<T> {
  return poolManager.get().transaction(async ({ query }) => handler(wrapQuery(query)))
}

function createRealMultitableFacade() {
  const readQuery = wrapQuery(q)
  const provisioning = {
    findObjectSheet: ({ projectId, objectId }: { projectId: string; objectId: string }) =>
      findObjectSheet(readQuery, projectId, objectId),
    resolveFieldIds: ({ projectId, objectId, fieldIds }: { projectId: string; objectId: string; fieldIds: string[] }) =>
      resolveObjectFieldIds(projectId, objectId, fieldIds),
    ensureObject: ({ projectId, baseId, descriptor }: {
      projectId: string
      baseId?: string | null
      descriptor: MultitableProvisioningObjectDescriptor
    }) =>
      transaction((query) => ensureObject({ query, projectId, baseId, descriptor })),
    patchObjectFieldProperty: (input: {
      projectId: string
      objectId: string
      fieldId: string
      propertyPatch: Record<string, unknown>
    }) => transaction((query) => patchObjectFieldProperty({ query, ...input })),
  }
  const records = {
    queryRecords: (input: {
      sheetId: string
      filters?: Record<string, unknown>
      search?: string
      orderBy?: Array<Record<string, unknown>>
      limit?: number
      offset?: number
    }) => queryRecords({ query: readQuery, ...input }),
    createRecord: ({ sheetId, data }: { sheetId: string; data: Record<string, unknown> }) =>
      transaction((query) => createRecord({ query, sheetId, data })),
    patchRecord: ({ sheetId, recordId, changes }: {
      sheetId: string
      recordId: string
      changes: Record<string, unknown>
    }) => transaction((query) => patchRecord({ query, sheetId, recordId, changes })),
  }
  return { provisioning, records }
}

function readConfig(): Record<string, unknown> {
  const result = validateReadSourceConfig({
    version: 1,
    systemId: SYSTEM_ID,
    requiredKind: 'erp:k3-wise-webapi',
    object: 'stock-preparation-source',
    mode: 'list_page',
    readPath: '/readonly/stock-preparation',
    readMethod: 'POST',
    operations: ['read'],
    containerPaths: ['Rows'],
    fieldMap: [
      { source: 'FItemID', target: 'erpMaterialInternalId' },
      { source: 'FNumber', target: 'erpMaterialCode' },
      { source: 'FName', target: 'erpMaterialName' },
    ],
  })
  if (!result.valid) throw new Error(`T3a real-DB fixture config is invalid: ${JSON.stringify(result.errors)}`)
  return result.normalized
}

function unused(name: string): () => never {
  return () => {
    throw new Error(`unexpected T3a real-DB service call: ${name}`)
  }
}

function createServices(sourceRows: Array<Record<string, unknown>>) {
  const noopAsync = async () => ({})
  return {
    externalSystemRegistry: {
      upsertExternalSystem: unused('upsertExternalSystem'),
      getExternalSystem: unused('getExternalSystem'),
      deleteExternalSystem: unused('deleteExternalSystem'),
      listExternalSystems: unused('listExternalSystems'),
      async getExternalSystemForAdapter() {
        return {
          id: SYSTEM_ID,
          tenantId: TENANT_ID,
          kind: 'erp:k3-wise-webapi',
          credentials: { password: SOURCE_CREDENTIAL },
          config: {},
        }
      },
    },
    adapterRegistry: {
      listAdapterKinds: () => ['erp:k3-wise-webapi'],
      createAdapter: () => ({
        async read() {
          return {
            records: sourceRows,
            raw: { Rows: sourceRows },
            metadata: { dataRowCount: sourceRows.length, dataPageIndex: 1, returnedRecordCount: sourceRows.length },
          }
        },
      }),
    },
    pipelineRegistry: {
      upsertPipeline: unused('upsertPipeline'),
      getPipeline: unused('getPipeline'),
      listPipelines: unused('listPipelines'),
      listPipelineRuns: unused('listPipelineRuns'),
    },
    pipelineRunner: { runPipeline: unused('runPipeline') },
    deadLetterStore: { listDeadLetters: unused('listDeadLetters') },
    stagingInstaller: {
      installStaging: unused('installStaging'),
      listStagingDescriptors: unused('listStagingDescriptors'),
    },
    templateRegistry: {
      upsertTemplate: unused('upsertTemplate'),
      getTemplate: unused('getTemplate'),
      listTemplates: unused('listTemplates'),
      deleteTemplate: unused('deleteTemplate'),
      instantiateTemplate: unused('instantiateTemplate'),
    },
    readSourceConfigStore: {
      saveVersion: unused('readSourceConfig.saveVersion'),
      list: unused('readSourceConfig.list'),
      get: unused('readSourceConfig.get'),
      approve: unused('readSourceConfig.approve'),
      retire: unused('readSourceConfig.retire'),
      listAudit: unused('readSourceConfig.listAudit'),
      async getForRuntime() {
        return { id: CONFIG_ID, status: 'approved', systemId: SYSTEM_ID, config: readConfig() }
      },
    },
    readSourceCompositionConfigStore: {
      saveVersion: noopAsync,
      list: noopAsync,
      get: noopAsync,
      approve: noopAsync,
      retire: noopAsync,
      listAudit: noopAsync,
      getForRuntime: noopAsync,
    },
    bridgeAgentChecklistStore: {
      saveVersion: noopAsync,
      approve: noopAsync,
      retire: noopAsync,
      getForApply: noopAsync,
    },
  }
}

function response(): TestResponse {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      return body
    },
  }
}

function deepIncludes(value: unknown, needle: string): boolean {
  if (typeof value === 'string') return value.includes(needle)
  if (Array.isArray(value)) return value.some((entry) => deepIncludes(entry, needle))
  if (value && typeof value === 'object') return Object.values(value).some((entry) => deepIncludes(entry, needle))
  return false
}

async function discoverPhysicalFields(sheetId: string, objectId: string): Promise<Record<string, string>> {
  const template = STOCK_PREPARATION_MVP_TABLE_TEMPLATES.find((entry) => entry.objectId === objectId)
  if (!template) throw new Error(`missing frozen template for ${objectId}`)
  const result = await q('SELECT id, name, type FROM meta_fields WHERE sheet_id = $1', [sheetId])
  const rowsByName = new Map(
    (result.rows as Array<{ id: string; name: string; type: string }>).map((row) => [row.name, row]),
  )
  return Object.fromEntries(template.fields.map((field) => {
    const row = rowsByName.get(field.label)
    if (!row) throw new Error(`real meta_fields row missing for ${objectId}.${field.id}`)
    if (row.id === field.id) throw new Error(`expected a physical field id for ${objectId}.${field.id}`)
    return [field.id, row.id]
  }))
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected object response')
  return value as Record<string, unknown>
}

if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
  test('T3a real-DB allowlist must provide DATABASE_URL', () => {
    throw new Error('T3a real-DB allowlist step is missing DATABASE_URL')
  })
}

describeIfDatabase('stock-preparation T3a ERP source auto-persist (real DB)', () => {
  const facade = createRealMultitableFacade()
  const context = { api: { multitable: facade }, storage: {}, config: {} }
  const materialRows = [{ FItemID: MATERIAL_INTERNAL_ID, FNumber: MATERIAL_CODE, FName: MATERIAL_NAME }]
  let materialSheetId = ''
  let runSheetId = ''
  let previousFlag: string | undefined

  beforeAll(async () => {
    previousFlag = process.env[FLAG]
    const ensured = await ensureStockPreparationMvpTargets({
      context,
      projectId: TARGET_PROJECT_ID,
      permission: 'admin',
      objectIds: [MATERIAL_OBJECT_ID, RUN_OBJECT_ID],
    })
    expect(ensured).toMatchObject({ ready: true })
    const materialSheet = await facade.provisioning.findObjectSheet({ projectId: TARGET_PROJECT_ID, objectId: MATERIAL_OBJECT_ID })
    const runSheet = await facade.provisioning.findObjectSheet({ projectId: TARGET_PROJECT_ID, objectId: RUN_OBJECT_ID })
    if (!materialSheet || !runSheet) throw new Error('T3a real-DB provisioning did not create both target sheets')
    materialSheetId = materialSheet.id
    runSheetId = runSheet.id
    await syncStockPreparationMvpOptions({
      context,
      projectId: TARGET_PROJECT_ID,
      permission: 'admin',
      objectIds: [MATERIAL_OBJECT_ID, RUN_OBJECT_ID],
      optionSets: {
        stock_preparation_material_status_v1: [{ value: 'imported' }],
        stock_preparation_run_type_v1: ['plm_sync', 'erp_material_sync', 'mapping_match', 'unit_match', 'prep_generate']
          .map((value) => ({ value })),
        stock_preparation_run_status_v1: ['running', 'succeeded', 'failed', 'partial']
          .map((value) => ({ value })),
      },
    })
  })

  afterAll(async () => {
    if (previousFlag === undefined) delete process.env[FLAG]
    else process.env[FLAG] = previousFlag
    const sheetIds = [materialSheetId, runSheetId].filter(Boolean)
    if (sheetIds.length === 0) return
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = ANY($1::text[])', [sheetIds]).catch(() => {})
    await q(
      'DELETE FROM meta_links WHERE record_id IN (SELECT id FROM meta_records WHERE sheet_id = ANY($1::text[])) OR foreign_record_id IN (SELECT id FROM meta_records WHERE sheet_id = ANY($1::text[]))',
      [sheetIds],
    ).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [sheetIds]).catch(() => {})
    await q('DELETE FROM meta_views WHERE sheet_id = ANY($1::text[])', [sheetIds]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [sheetIds]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [sheetIds]).catch(() => {})
  })

  test('flag ON persists through physical field ids, stays values-free, and reruns idempotently', async () => {
    process.env[FLAG] = 'true'
    const handlers = createHandlers(createServices(materialRows), { context })
    const handler = handlers.stockPreparationErpMaterialSourceRun
    expect(handler).toBeTypeOf('function')
    const req = {
      user: { id: `admin_${TOKEN}`, tenantId: TENANT_ID, roles: ['admin'], permissions: ['integration:admin'] },
      body: { workspaceId: `workspace_${TOKEN}`, readSourceConfigId: CONFIG_ID, syncRunId: SYNC_RUN_ID },
      query: {},
      params: {},
    }

    const first = response()
    await handler(req, first)
    const firstBody = asRecord(first.body)
    const firstData = asRecord(firstBody.data)
    const firstAutoPersist = asRecord(firstData.autoPersist)
    expect(first.statusCode).toBe(201)
    expect(firstData).toMatchObject({
      mode: 'internal_persist',
      evidence: {
        internalWriteExecuted: true,
        externalWriteExecuted: false,
        productionWrite: false,
        k3SaveSubmitAudit: false,
      },
    })
    expect(firstAutoPersist).toMatchObject({
      persisted: true,
      mode: 'created',
      created: { materials: 1, run: 1 },
      patched: { materials: 0, run: 0 },
      runStatus: 'succeeded',
    })
    expect(deepIncludes(first.body, MATERIAL_CODE)).toBe(false)
    expect(deepIncludes(first.body, MATERIAL_NAME)).toBe(false)
    expect(deepIncludes(first.body, SYNC_RUN_ID)).toBe(false)
    expect(deepIncludes(first.body, SOURCE_CREDENTIAL)).toBe(false)

    const materialFields = await discoverPhysicalFields(materialSheetId, MATERIAL_OBJECT_ID)
    const runFields = await discoverPhysicalFields(runSheetId, RUN_OBJECT_ID)
    const materialResult = await q('SELECT id, data, version FROM meta_records WHERE sheet_id = $1', [materialSheetId])
    const runResult = await q('SELECT id, data, version FROM meta_records WHERE sheet_id = $1', [runSheetId])
    expect(materialResult.rows).toHaveLength(1)
    expect(runResult.rows).toHaveLength(1)
    const materialData = asRecord((materialResult.rows[0] as { data: unknown }).data)
    const runData = asRecord((runResult.rows[0] as { data: unknown }).data)
    expect(materialData[materialFields.erpMaterialInternalId]).toBe(MATERIAL_INTERNAL_ID)
    expect(materialData[materialFields.erpMaterialCode]).toBe(MATERIAL_CODE)
    expect(materialData[materialFields.erpMaterialName]).toBe(MATERIAL_NAME)
    expect(Object.prototype.hasOwnProperty.call(materialData, 'erpMaterialCode')).toBe(false)
    expect(runData[runFields.runId]).toBe(SYNC_RUN_ID)
    expect(runData[runFields.runType]).toBe('erp_material_sync')
    expect(runData[runFields.status]).toBe('succeeded')

    const second = response()
    await handler(req, second)
    const secondData = asRecord(asRecord(second.body).data)
    expect(second.statusCode).toBe(201)
    expect(secondData.autoPersist).toMatchObject({
      persisted: true,
      mode: 'refreshed',
      created: { materials: 0, run: 0 },
      patched: { materials: 1, run: 0 },
    })
    const counts = await q(
      'SELECT sheet_id, COUNT(*)::int AS count FROM meta_records WHERE sheet_id = ANY($1::text[]) GROUP BY sheet_id',
      [[materialSheetId, runSheetId]],
    )
    expect(Object.fromEntries((counts.rows as Array<{ sheet_id: string; count: number }>).map((row) => [row.sheet_id, row.count]))).toEqual({
      [materialSheetId]: 1,
      [runSheetId]: 1,
    })
  })

  test('flag OFF preserves the read-only response and writes no internal rows', async () => {
    delete process.env[FLAG]
    const before = await q(
      'SELECT sheet_id, COUNT(*)::int AS count FROM meta_records WHERE sheet_id = ANY($1::text[]) GROUP BY sheet_id',
      [[materialSheetId, runSheetId]],
    )
    const handlers = createHandlers(createServices([{
      FItemID: `off_internal_${TOKEN}`,
      FNumber: `OFF-CODE-${TOKEN}`,
      FName: `OFF-NAME-${TOKEN}`,
    }]), { context })
    const res = response()
    await handlers.stockPreparationErpMaterialSourceRun({
      user: { id: `admin_${TOKEN}`, tenantId: TENANT_ID, roles: ['admin'], permissions: ['integration:admin'] },
      body: { workspaceId: `workspace_${TOKEN}`, readSourceConfigId: CONFIG_ID, syncRunId: `off_${SYNC_RUN_ID}` },
      query: {},
      params: {},
    }, res)
    expect(res.statusCode).toBe(200)
    const data = asRecord(asRecord(res.body).data)
    expect(data.mode).toBe('dry_run')
    expect(Object.prototype.hasOwnProperty.call(data, 'autoPersist')).toBe(false)
    const after = await q(
      'SELECT sheet_id, COUNT(*)::int AS count FROM meta_records WHERE sheet_id = ANY($1::text[]) GROUP BY sheet_id',
      [[materialSheetId, runSheetId]],
    )
    const countsBySheet = (rows: unknown[]) => Object.fromEntries(
      (rows as Array<{ sheet_id: string; count: number }>).map((row) => [row.sheet_id, row.count]),
    )
    expect(countsBySheet(after.rows)).toEqual(countsBySheet(before.rows))
  })

  test('flag ON rejects an empty intake with a coarse 422 and zero writes', async () => {
    process.env[FLAG] = 'true'
    const before = await q(
      'SELECT sheet_id, COUNT(*)::int AS count FROM meta_records WHERE sheet_id = ANY($1::text[]) GROUP BY sheet_id',
      [[materialSheetId, runSheetId]],
    )
    const handlers = createHandlers(createServices([]), { context })
    const emptyRunId = `EMPTY-RUN-SECRET-${TOKEN}`
    let caught: unknown
    try {
      await handlers.stockPreparationErpMaterialSourceRun({
        user: { id: `admin_${TOKEN}`, tenantId: TENANT_ID, roles: ['admin'], permissions: ['integration:admin'] },
        body: { workspaceId: `workspace_${TOKEN}`, readSourceConfigId: CONFIG_ID, syncRunId: emptyRunId },
        query: {},
        params: {},
      }, response())
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ status: 422, code: 'SOURCE_RUN_EMPTY' })
    const coarseError = caught as { message?: unknown; code?: unknown; details?: unknown }
    expect(deepIncludes({
      message: coarseError.message,
      code: coarseError.code,
      details: coarseError.details,
    }, emptyRunId)).toBe(false)
    const after = await q(
      'SELECT sheet_id, COUNT(*)::int AS count FROM meta_records WHERE sheet_id = ANY($1::text[]) GROUP BY sheet_id',
      [[materialSheetId, runSheetId]],
    )
    const countsBySheet = (rows: unknown[]) => Object.fromEntries(
      (rows as Array<{ sheet_id: string; count: number }>).map((row) => [row.sheet_id, row.count]),
    )
    expect(countsBySheet(after.rows)).toEqual(countsBySheet(before.rows))
  })
})
