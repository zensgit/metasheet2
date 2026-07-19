/**
 * Stock-preparation T3b-2: approved PLM read source -> internal project/batch/line/run (real DB).
 *
 * This suite drives the ACTUAL stockPreparationPlmBomSourceRun route handler through the real
 * provisioning and records APIs against a real PostgreSQL — never a helper impersonating the route.
 * Physical field ids are discovered from meta_fields instead of the deterministic id helper, so a
 * broken logical-to-physical translation cannot self-prove against the same formula.
 *
 * design-lock: docs/development/stock-preparation-t3b-plm-source-autopersist-design-lock-20260716.md §5.2
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
import { acquireStockPreparationPersistUnitOfWorkLocks } from '../../src/multitable/stock-preparation-persist-unit-of-work'
import type {
  MultitableRecordsWriteUnitOfWorkAPI,
  StockPreparationPersistUnitOfWorkInput,
} from '../../src/types/plugin'

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
  BATCH_OBJECT_ID,
  LINE_OBJECT_ID,
  PROJECT_OBJECT_ID,
  RUN_OBJECT_ID,
} = require('../../../../plugins/plugin-integration-core/lib/stock-preparation-sync-run-persist.cjs') as {
  BATCH_OBJECT_ID: string
  LINE_OBJECT_ID: string
  PROJECT_OBJECT_ID: string
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
const TENANT_ID = `tenant_t3b2_${TOKEN}`
const TARGET_PROJECT_ID = `${TENANT_ID}:integration-core`
const CONFIG_ID = `cfg_t3b2_${TOKEN}`
const SYSTEM_ID = `sys_t3b2_${TOKEN}`
const BUSINESS_PROJECT_ID = `project_t3b2_${TOKEN}`
const SOURCE_PROJECT_NO = `SOURCE-PROJECT-SECRET-${TOKEN}`
const PROJECT_NAME = `Secret project name ${TOKEN}`
const SYNC_RUN_ID = `run_t3b2_${TOKEN}`
const SNAPSHOT_BATCH_ID = `snapshot_t3b2_${TOKEN}`
const CHILD_CODE_1 = `PLM-CHILD-1-${TOKEN}`
const CHILD_CODE_2 = `PLM-CHILD-2-${TOKEN}`
const SOURCE_CREDENTIAL = `PLM-CREDENTIAL-${TOKEN}`
const FLAG = 'MULTITABLE_STOCK_PREP_PLM_AUTOPERSIST_ENABLED'
const OBJECT_IDS = [PROJECT_OBJECT_ID, BATCH_OBJECT_ID, LINE_OBJECT_ID, RUN_OBJECT_ID]

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
    runStockPreparationPersistUnitOfWork: <T>(
      input: StockPreparationPersistUnitOfWorkInput,
      operation: (records: MultitableRecordsWriteUnitOfWorkAPI) => Promise<T>,
    ) => transaction(async (query) => {
      await acquireStockPreparationPersistUnitOfWorkLocks(query, input)
      const transactionRecords: MultitableRecordsWriteUnitOfWorkAPI = {
        queryRecords: (recordInput) =>
          queryRecords({ query, ...recordInput }),
        createRecord: (recordInput) =>
          createRecord({ query, ...recordInput }),
        patchRecord: (recordInput) =>
          patchRecord({ query, ...recordInput }),
      }
      return operation(transactionRecords)
    }),
  }
  return { provisioning, records }
}

const DEFAULT_FIELD_MAP = [
  { source: 'path', target: 'pathKey' },
  { source: 'childCode', target: 'childDrawingNo' },
  { source: 'quantity', target: 'designQty' },
]

function readConfig(fieldMap: Array<Record<string, unknown>>): Record<string, unknown> {
  const result = validateReadSourceConfig({
    version: 1,
    systemId: SYSTEM_ID,
    requiredKind: 'plm:yuantus-wrapper',
    object: 'stock-preparation-source',
    mode: 'list_page',
    readPath: '/readonly/stock-preparation',
    readMethod: 'POST',
    operations: ['read'],
    containerPaths: ['Rows'],
    fieldMap,
  })
  if (!result.valid) throw new Error(`T3b-2 real-DB fixture config is invalid: ${JSON.stringify(result.errors)}`)
  return result.normalized
}

function unused(name: string): () => never {
  return () => {
    throw new Error(`unexpected T3b-2 real-DB service call: ${name}`)
  }
}

function createServices(
  sourceRows: Array<Record<string, unknown>>,
  fieldMap: Array<Record<string, unknown>> = DEFAULT_FIELD_MAP,
) {
  const noopAsync = async () => ({})
  const adapterCreates: string[] = []
  const services = {
    externalSystemRegistry: {
      upsertExternalSystem: unused('upsertExternalSystem'),
      getExternalSystem: unused('getExternalSystem'),
      deleteExternalSystem: unused('deleteExternalSystem'),
      listExternalSystems: unused('listExternalSystems'),
      async getExternalSystemForAdapter() {
        return {
          id: SYSTEM_ID,
          tenantId: TENANT_ID,
          kind: 'plm:yuantus-wrapper',
          credentials: { password: SOURCE_CREDENTIAL },
          config: {},
        }
      },
    },
    adapterRegistry: {
      listAdapterKinds: () => ['plm:yuantus-wrapper'],
      createAdapter: (system: { kind: string }) => {
        adapterCreates.push(system.kind)
        return {
          async read() {
            const pageRows = sourceRows.map((row) => ({ ...row }))
            return {
              records: pageRows,
              raw: { Rows: pageRows },
              metadata: { totalCount: pageRows.length, returnedRecordCount: pageRows.length },
            }
          },
        }
      },
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
        return { id: CONFIG_ID, status: 'approved', systemId: SYSTEM_ID, config: readConfig(fieldMap) }
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
  return { services, adapterCreates }
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
  const result = await q('SELECT id, name FROM meta_fields WHERE sheet_id = $1', [sheetId])
  const rowsByName = new Map(
    (result.rows as Array<{ id: string; name: string }>).map((row) => [row.name, row.id]),
  )
  return Object.fromEntries(template.fields.map((field) => {
    const physicalId = rowsByName.get(field.label)
    if (!physicalId) throw new Error(`real meta_fields row missing for ${objectId}.${field.id}`)
    if (physicalId === field.id) throw new Error(`expected a physical field id for ${objectId}.${field.id}`)
    return [field.id, physicalId]
  }))
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected object response')
  return value as Record<string, unknown>
}

function adminRequest(bodyOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    user: { id: `admin_${TOKEN}`, tenantId: TENANT_ID, roles: ['admin'], permissions: ['integration:admin'] },
    body: {
      workspaceId: `workspace_${TOKEN}`,
      projectId: BUSINESS_PROJECT_ID,
      sourceProjectNo: SOURCE_PROJECT_NO,
      projectName: PROJECT_NAME,
      readSourceConfigId: CONFIG_ID,
      syncRunId: SYNC_RUN_ID,
      snapshotBatchId: SNAPSHOT_BATCH_ID,
      snapshotVersion: 1,
      ...bodyOverrides,
    },
    query: {},
    params: {},
  }
}

const SOURCE_ROWS = [
  { path: '/root/asm-1', childCode: CHILD_CODE_1, quantity: 2 },
  { path: '/root/asm-1/part-2', childCode: CHILD_CODE_2, quantity: 1 },
]

if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
  test('T3b-2 real-DB allowlist must provide DATABASE_URL', () => {
    throw new Error('T3b-2 PLM auto-persist real-DB allowlist step is missing DATABASE_URL')
  })
}

describeIfDatabase('stock-preparation T3b-2 PLM source auto-persist (real DB)', () => {
  const facade = createRealMultitableFacade()
  const context = { api: { multitable: facade }, storage: {}, config: {} }
  const sheetIds = new Map<string, string>()
  let previousFlag: string | undefined

  async function countsBySheet(): Promise<Record<string, number>> {
    const ids = [...sheetIds.values()]
    const result = await q(
      'SELECT sheet_id, COUNT(*)::int AS count FROM meta_records WHERE sheet_id = ANY($1::text[]) GROUP BY sheet_id',
      [ids],
    )
    const counts = Object.fromEntries(ids.map((id) => [id, 0]))
    for (const row of result.rows as Array<{ sheet_id: string; count: number }>) counts[row.sheet_id] = row.count
    return counts
  }

  beforeAll(async () => {
    previousFlag = process.env[FLAG]
    const ensured = await ensureStockPreparationMvpTargets({
      context,
      projectId: TARGET_PROJECT_ID,
      permission: 'admin',
      objectIds: OBJECT_IDS,
    })
    expect(ensured).toMatchObject({ ready: true })
    for (const objectId of OBJECT_IDS) {
      const sheet = await facade.provisioning.findObjectSheet({ projectId: TARGET_PROJECT_ID, objectId })
      if (!sheet) throw new Error(`T3b-2 real-DB provisioning did not create the ${objectId} sheet`)
      sheetIds.set(objectId, sheet.id)
    }
    await syncStockPreparationMvpOptions({
      context,
      projectId: TARGET_PROJECT_ID,
      permission: 'admin',
      objectIds: OBJECT_IDS,
      optionSets: {
        stock_preparation_project_status_v1: ['active'].map((value) => ({ value })),
        stock_preparation_snapshot_status_v1: ['draft', 'active', 'superseded', 'rejected']
          .map((value) => ({ value })),
        stock_preparation_bom_line_status_v1: ['imported', 'active', 'inactive', 'incomplete']
          .map((value) => ({ value })),
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
    const ids = [...sheetIds.values()]
    if (ids.length === 0) return
    await q('DELETE FROM meta_record_revisions WHERE sheet_id = ANY($1::text[])', [ids]).catch(() => {})
    await q(
      'DELETE FROM meta_links WHERE record_id IN (SELECT id FROM meta_records WHERE sheet_id = ANY($1::text[])) OR foreign_record_id IN (SELECT id FROM meta_records WHERE sheet_id = ANY($1::text[]))',
      [ids],
    ).catch(() => {})
    await q('DELETE FROM meta_records WHERE sheet_id = ANY($1::text[])', [ids]).catch(() => {})
    await q('DELETE FROM meta_views WHERE sheet_id = ANY($1::text[])', [ids]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = ANY($1::text[])', [ids]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = ANY($1::text[])', [ids]).catch(() => {})
  })

  test('flag ON persists project/batch/line/run through physical field ids, stays values-free, and an exact replay is an internal noop', async () => {
    process.env[FLAG] = 'true'
    const { services } = createServices(SOURCE_ROWS)
    const handlers = createHandlers(services, { context })
    const handler = handlers.stockPreparationPlmBomSourceRun
    expect(handler).toBeTypeOf('function')

    const first = response()
    await handler(adminRequest(), first)
    const firstData = asRecord(asRecord(first.body).data)
    expect(first.statusCode).toBe(201)
    expect(firstData).toMatchObject({
      mode: 'internal_persist',
      evidence: {
        internalWriteExecuted: true,
        externalWriteExecuted: false,
        productionWrite: false,
        k3SaveSubmitAudit: false,
        plmExternalWrite: false,
      },
    })
    expect(asRecord(firstData.autoPersist)).toMatchObject({ persisted: true, mode: 'created' })

    // Values-free response: none of the business sentinels cross HTTP.
    for (const forbidden of [CHILD_CODE_1, CHILD_CODE_2, SOURCE_PROJECT_NO, PROJECT_NAME, SOURCE_CREDENTIAL, CONFIG_ID, SYSTEM_ID]) {
      expect(deepIncludes(first.body, forbidden)).toBe(false)
    }
    expect(Object.prototype.hasOwnProperty.call(firstData, 'intake')).toBe(false)

    // Physical landing: exactly one project, one batch, one run, and BOTH lines (not one row dropped).
    const counts = await countsBySheet()
    expect(counts[sheetIds.get(PROJECT_OBJECT_ID) as string]).toBe(1)
    expect(counts[sheetIds.get(BATCH_OBJECT_ID) as string]).toBe(1)
    expect(counts[sheetIds.get(LINE_OBJECT_ID) as string]).toBe(SOURCE_ROWS.length)
    expect(counts[sheetIds.get(RUN_OBJECT_ID) as string]).toBe(1)

    // Cross-check the line rows against meta_fields-discovered PHYSICAL ids: the sentinel child code
    // really landed (positive control for the leak scan above) and the default 'imported' intake
    // status crossed the bridge as canonical 'active'.
    const lineSheetId = sheetIds.get(LINE_OBJECT_ID) as string
    const lineFields = await discoverPhysicalFields(lineSheetId, LINE_OBJECT_ID)
    const lineRows = await q('SELECT data FROM meta_records WHERE sheet_id = $1', [lineSheetId])
    const lineData = (lineRows.rows as Array<{ data: unknown }>).map((row) => asRecord(row.data))
    const childCodes = lineData.map((data) => data[lineFields.childDrawingNo]).sort()
    expect(childCodes).toEqual([CHILD_CODE_1, CHILD_CODE_2].sort())
    for (const data of lineData) {
      expect(data[lineFields.lineStatus]).toBe('active')
      expect(Object.prototype.hasOwnProperty.call(data, 'lineStatus')).toBe(false)
    }

    // Exact replay: same request, no new rows, and the response says NOOP — never a hard-coded
    // internal-write claim just because the flag is ON.
    const replay = response()
    await handler(adminRequest(), replay)
    const replayData = asRecord(asRecord(replay.body).data)
    expect(replay.statusCode).toBe(200)
    expect(replayData.mode).toBe('internal_noop')
    expect(asRecord(replayData.evidence).internalWriteExecuted).toBe(false)
    expect(asRecord(replayData.autoPersist)).toMatchObject({ persisted: false, mode: 'skipped_existing' })
    expect(await countsBySheet()).toEqual(counts)
  })

  test('flag OFF preserves the read-only response and writes no internal rows', async () => {
    delete process.env[FLAG]
    const before = await countsBySheet()
    const { services } = createServices(SOURCE_ROWS)
    const handlers = createHandlers(services, { context })
    const res = response()
    await handlers.stockPreparationPlmBomSourceRun(adminRequest({
      syncRunId: `off_${SYNC_RUN_ID}`,
      snapshotBatchId: `off_${SNAPSHOT_BATCH_ID}`,
    }), res)
    expect(res.statusCode).toBe(200)
    const data = asRecord(asRecord(res.body).data)
    expect(data.mode).toBe('dry_run')
    expect(asRecord(data.evidence).internalWriteExecuted).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(data, 'autoPersist')).toBe(false)
    expect(await countsBySheet()).toEqual(before)
  })

  test('flag ON rejects a source-mapped raw lifecycle with the dedicated 422 and zero writes', async () => {
    process.env[FLAG] = 'true'
    const before = await countsBySheet()
    const { services } = createServices(
      [
        { path: '/root/asm-1', childCode: CHILD_CODE_1, quantity: 2, state: 'released' },
        { path: '/root/asm-1/part-2', childCode: CHILD_CODE_2, quantity: 1, state: 'active' },
      ],
      [...DEFAULT_FIELD_MAP, { source: 'state', target: 'lineStatus' }],
    )
    const handlers = createHandlers(services, { context })
    let caught: unknown
    try {
      await handlers.stockPreparationPlmBomSourceRun(adminRequest({
        syncRunId: `lifecycle_${SYNC_RUN_ID}`,
        snapshotBatchId: `lifecycle_${SNAPSHOT_BATCH_ID}`,
      }), response())
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ status: 422, code: 'STOCK_PREPARATION_PLM_AUTOPERSIST_LINE_STATUS_UNSUPPORTED' })
    const coarse = caught as { message?: unknown; code?: unknown; details?: unknown }
    expect(deepIncludes({ message: coarse.message, code: coarse.code, details: coarse.details }, 'released')).toBe(false)
    expect(await countsBySheet()).toEqual(before)
  })

  test('flag ON structurally rejects a forbidden missingChildBom fieldMap target before any source adapter exists', async () => {
    process.env[FLAG] = 'true'
    const before = await countsBySheet()
    const { services, adapterCreates } = createServices(
      [
        { path: '/root/asm-1', childCode: CHILD_CODE_1, quantity: 2, state: 'active', secretMarkerColumn: false },
        { path: '/root/asm-1/part-2', childCode: CHILD_CODE_2, quantity: 1, state: 'active', secretMarkerColumn: true },
      ],
      [
        ...DEFAULT_FIELD_MAP,
        { source: 'secretMarkerColumn', target: 'missingChildBom' },
        { source: 'state', target: 'lineStatus' },
      ],
    )
    const handlers = createHandlers(services, { context })
    let caught: unknown
    try {
      await handlers.stockPreparationPlmBomSourceRun(adminRequest({
        syncRunId: `guard_${SYNC_RUN_ID}`,
        snapshotBatchId: `guard_${SNAPSHOT_BATCH_ID}`,
      }), response())
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ status: 422, code: 'STOCK_PREPARATION_PLM_AUTOPERSIST_CONFIG_TARGET_FORBIDDEN' })
    const coarse = caught as { message?: unknown; code?: unknown; details?: unknown }
    expect(deepIncludes({ message: coarse.message, code: coarse.code, details: coarse.details }, 'secretMarkerColumn')).toBe(false)
    expect(adapterCreates).toHaveLength(0)
    expect(await countsBySheet()).toEqual(before)
  })
})
