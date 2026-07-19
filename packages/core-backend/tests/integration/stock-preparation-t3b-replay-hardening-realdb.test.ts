/**
 * Stock-preparation T3b-1a: immutable snapshot replay hardening (real DB).
 *
 * This suite provisions the real MVP sheets, persists through the platform records API, and discovers
 * physical field ids from meta_fields. It proves an exact replay is a no-op while a same-fingerprint
 * row whose frozen projection changed fails closed without repairing the immutable snapshot.
 */
import { createRequire } from 'module'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { MetaSheetServer } from '../../src/index'
import { poolManager } from '../../src/integration/db/connection-pool'
import type { LoadedPlugin } from '../../src/core/plugin-loader'
import type {
  MultitableAPI,
  MultitableRecordsWriteUnitOfWorkAPI,
  PluginContext,
  StockPreparationPersistUnitOfWorkInput,
} from '../../src/types/plugin'

const require = createRequire(import.meta.url)
const {
  BATCH_OBJECT_ID,
  LINE_OBJECT_ID,
  PROJECT_OBJECT_ID,
  RUN_OBJECT_ID,
  persistStockPreparationSyncRun,
} = require('../../../../plugins/plugin-integration-core/lib/stock-preparation-sync-run-persist.cjs') as {
  BATCH_OBJECT_ID: string
  LINE_OBJECT_ID: string
  PROJECT_OBJECT_ID: string
  RUN_OBJECT_ID: string
  persistStockPreparationSyncRun: (input: Record<string, unknown>) => Promise<Record<string, unknown>>
}
const {
  ensureStockPreparationMvpTargets,
  syncStockPreparationMvpOptions,
} = require('../../../../plugins/plugin-integration-core/lib/stock-preparation-mvp-provisioning.cjs') as {
  ensureStockPreparationMvpTargets: (input: Record<string, unknown>) => Promise<Record<string, unknown>>
  syncStockPreparationMvpOptions: (input: Record<string, unknown>) => Promise<Record<string, unknown>>
}
const { STOCK_PREPARATION_MVP_TABLE_TEMPLATES } = require('../../../../plugins/plugin-integration-core/lib/stock-preparation-templates.cjs') as {
  STOCK_PREPARATION_MVP_TABLE_TEMPLATES: Array<{
    objectId: string
    fields: Array<{ id: string; label: string; type: string }>
  }>
}

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TOKEN = `${process.pid}_${Date.now().toString(36)}`
const TENANT_ID = `tenant_t3b_${TOKEN}`
const TARGET_PROJECT_ID = `${TENANT_ID}:integration-core`
const PROJECT_ID = `project_t3b_${TOKEN}`
const SOURCE_PROJECT_NO = `SOURCE-PROJECT-${TOKEN}`
const SYNC_RUN_ID = `run_t3b_${TOKEN}`
const SNAPSHOT_BATCH_ID = `batch_t3b_${TOKEN}`

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

function createProductionPluginContext(): PluginContext {
  const server = new MetaSheetServer({ port: 0, host: '127.0.0.1', pluginDirs: [] })
  const loaded: LoadedPlugin = {
    manifest: { name: 'plugin-integration-core', version: 'test' },
    plugin: { activate: async () => {} },
    path: 'realdb://plugin-integration-core',
    loadedAt: new Date(),
  }
  return (server as unknown as {
    createPluginContext: (plugin: LoadedPlugin) => PluginContext
  }).createPluginContext(loaded)
}

function createRealMultitableFacade(multitable: MultitableAPI) {
  const hostUnitOfWork = multitable.records.runStockPreparationPersistUnitOfWork
  if (typeof hostUnitOfWork !== 'function') {
    throw new Error('production plugin context is missing the P4 unit-of-work capability')
  }
  let failAfterMutation: number | null = null
  let unitOfWorkBarrier: {
    expected: number
    arrived: number
    wait: Promise<void>
    release: () => void
  } | null = null
  const provisioning = multitable.provisioning
  const records = {
    ...multitable.records,
    runStockPreparationPersistUnitOfWork: <T>(
      input: StockPreparationPersistUnitOfWorkInput,
      operation: (records: MultitableRecordsWriteUnitOfWorkAPI) => Promise<T>,
    ) => {
      const enterHostUnitOfWork = async (): Promise<T> => {
        const barrier = unitOfWorkBarrier
        if (barrier) {
          barrier.arrived += 1
          if (barrier.arrived === barrier.expected) {
            unitOfWorkBarrier = null
            barrier.release()
          }
          await barrier.wait
        }
        return hostUnitOfWork(input, async (transactionRecords) => {
          let mutationCount = 0
          const withInjectedCrash = async <R>(mutation: () => Promise<R>): Promise<R> => {
            const result = await mutation()
            mutationCount += 1
            if (failAfterMutation === mutationCount) {
              failAfterMutation = null
              throw new Error('P4_INJECTED_TRANSACTION_CRASH')
            }
            return result
          }
          const crashInjectingRecords: MultitableRecordsWriteUnitOfWorkAPI = {
            queryRecords: (recordInput) => transactionRecords.queryRecords(recordInput),
            createRecord: (recordInput) =>
              withInjectedCrash(() => transactionRecords.createRecord(recordInput)),
            patchRecord: (recordInput) =>
              withInjectedCrash(() => transactionRecords.patchRecord(recordInput)),
          }
          return operation(crashInjectingRecords)
        })
      }
      return enterHostUnitOfWork()
    },
  }
  return {
    provisioning,
    records,
    injectCrashAfterMutation(count: number) {
      failAfterMutation = count
    },
    armUnitOfWorkBarrier(expected: number) {
      let release = () => {}
      const wait = new Promise<void>((resolve) => {
        release = resolve
      })
      unitOfWorkBarrier = { expected, arrived: 0, wait, release }
    },
  }
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

function persistInput(
  facade: ReturnType<typeof createRealMultitableFacade>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    permission: 'admin',
    recordsApi: facade.records,
    provisioning: facade.provisioning,
    targetProjectId: TARGET_PROJECT_ID,
    lockTenantId: TENANT_ID,
    projectId: PROJECT_ID,
    sourceProjectNo: SOURCE_PROJECT_NO,
    sourceSystem: 'data-source:sql-readonly',
    syncRunId: SYNC_RUN_ID,
    snapshotBatchId: SNAPSHOT_BATCH_ID,
    snapshotVersion: 1,
    defaultDesignUnit: 'pcs',
    expansionResult: [{
      componentSourceId: `component_${TOKEN}`,
      componentCode: `MATERIAL-${TOKEN}`,
      sourceVersion: 'A',
      path: `/root/MATERIAL-${TOKEN}`,
      rawQuantity: 3,
    }],
    ...overrides,
  }
}

if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
  test('T3b replay hardening real-DB allowlist must provide DATABASE_URL', () => {
    throw new Error('T3b replay hardening real-DB allowlist step is missing DATABASE_URL')
  })
}

describeIfDatabase('stock-preparation T3b immutable replay hardening (real DB)', () => {
  const pluginContext = createProductionPluginContext()
  const multitable = pluginContext.api.multitable
  if (!multitable) throw new Error('production plugin context is missing multitable APIs')
  const facade = createRealMultitableFacade(multitable)
  const context = { api: { multitable: facade }, storage: {}, config: {} }
  const objectIds = [PROJECT_OBJECT_ID, BATCH_OBJECT_ID, LINE_OBJECT_ID, RUN_OBJECT_ID]
  const sheetIds = new Map<string, string>()

  beforeAll(async () => {
    const ensured = await ensureStockPreparationMvpTargets({
      context,
      projectId: TARGET_PROJECT_ID,
      permission: 'admin',
      objectIds,
    })
    expect(ensured).toMatchObject({ ready: true })
    await syncStockPreparationMvpOptions({
      context,
      projectId: TARGET_PROJECT_ID,
      permission: 'admin',
      objectIds,
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
    for (const objectId of objectIds) {
      const sheet = await facade.provisioning.findObjectSheet({ projectId: TARGET_PROJECT_ID, objectId })
      if (!sheet) throw new Error(`T3b real-DB provisioning did not create ${objectId}`)
      sheetIds.set(objectId, sheet.id)
    }
  })

  afterAll(async () => {
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

  test('exact replay skips, but a same-fingerprint frozen-projection mismatch returns 409 without repair', async () => {
    const input = persistInput(facade)
    const first = await persistStockPreparationSyncRun(input)
    expect(first).toMatchObject({
      persisted: true,
      mode: 'created',
      created: { batch: 1, lines: 1, run: 1 },
      project: { mode: 'created' },
    })

    const lineSheetId = sheetIds.get(LINE_OBJECT_ID)
    if (!lineSheetId) throw new Error('missing T3b line sheet id')
    const lineFields = await discoverPhysicalFields(lineSheetId, LINE_OBJECT_ID)
    const beforeReplay = await q('SELECT id, version, data FROM meta_records WHERE sheet_id = $1', [lineSheetId])
    expect(beforeReplay.rows).toHaveLength(1)
    const physicalData = (beforeReplay.rows[0] as { data: Record<string, unknown> }).data
    expect(physicalData[lineFields.lineStatus]).toBe('active')
    expect(typeof physicalData[lineFields.sourceFingerprint]).toBe('string')
    expect(Object.prototype.hasOwnProperty.call(physicalData, 'lineStatus')).toBe(false)

    const exactReplay = await persistStockPreparationSyncRun(input)
    expect(exactReplay).toMatchObject({ persisted: false, mode: 'skipped_existing', project: { mode: 'skipped' } })

    const recordId = String((beforeReplay.rows[0] as { id: unknown }).id)
    await q(
      'UPDATE meta_records SET data = jsonb_set(data, ARRAY[$1::text], to_jsonb($2::text), true), version = version + 1 WHERE id = $3 AND sheet_id = $4',
      [lineFields.lineStatus, 'inactive', recordId, lineSheetId],
    )
    const planted = await q('SELECT id, version, data FROM meta_records WHERE id = $1 AND sheet_id = $2', [recordId, lineSheetId])
    const plantedData = (planted.rows[0] as { data: Record<string, unknown> }).data
    expect(plantedData[lineFields.lineStatus]).toBe('inactive')
    expect(plantedData[lineFields.sourceFingerprint]).toBe(physicalData[lineFields.sourceFingerprint])

    let caught: unknown
    try {
      await persistStockPreparationSyncRun(input)
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({
      status: 409,
      code: 'PERSIST_IDEMPOTENCY_CONFLICT',
      details: { target: 'snapshot_line', reason: 'content_mismatch' },
    })
    const afterConflict = await q('SELECT id, version, data FROM meta_records WHERE id = $1 AND sheet_id = $2', [recordId, lineSheetId])
    expect(afterConflict.rows).toEqual(planted.rows)
  })

  test('CW1-CW4 crash matrix rolls back all four tables and revisions before clean retries', async () => {
    const ids = [...sheetIds.values()]
    const counts = async () => ({
      records: (await q(
        'SELECT count(*)::int AS count FROM meta_records WHERE sheet_id = ANY($1::text[])',
        [ids],
      )).rows,
      revisions: (await q(
        'SELECT count(*)::int AS count FROM meta_record_revisions WHERE sheet_id = ANY($1::text[])',
        [ids],
      )).rows,
    })
    const expansionResult = [
      {
        componentSourceId: `component_a_${TOKEN}`,
        componentCode: `MATERIAL-A-${TOKEN}`,
        sourceVersion: 'A',
        path: `/root/MATERIAL-A-${TOKEN}`,
        rawQuantity: 1,
      },
      {
        componentSourceId: `component_b_${TOKEN}`,
        componentCode: `MATERIAL-B-${TOKEN}`,
        sourceVersion: 'A',
        path: `/root/MATERIAL-B-${TOKEN}`,
        rawQuantity: 2,
      },
    ]
    const scenarios = [
      { name: 'CW1', failAfter: 1, existingProject: false },
      { name: 'CW2', failAfter: 2, existingProject: false },
      { name: 'CW3', failAfter: 3, existingProject: false },
      { name: 'CW4-first', failAfter: 4, existingProject: false },
      { name: 'CW4-existing', failAfter: 4, existingProject: true },
    ]

    for (const scenario of scenarios) {
      const projectId = `${PROJECT_ID}_${scenario.name}`
      const common = {
        projectId,
        sourceProjectNo: `${SOURCE_PROJECT_NO}_${scenario.name}`,
        expansionResult,
      }
      if (scenario.existingProject) {
        await persistStockPreparationSyncRun(persistInput(facade, {
          ...common,
          syncRunId: `${SYNC_RUN_ID}_${scenario.name}_base`,
          snapshotBatchId: `${SNAPSHOT_BATCH_ID}_${scenario.name}_base`,
          snapshotVersion: 1,
        }))
      }
      const input = persistInput(facade, {
        ...common,
        syncRunId: `${SYNC_RUN_ID}_${scenario.name}`,
        snapshotBatchId: `${SNAPSHOT_BATCH_ID}_${scenario.name}`,
        snapshotVersion: scenario.existingProject ? 2 : 1,
      })
      const before = await counts()
      facade.injectCrashAfterMutation(scenario.failAfter)
      await expect(persistStockPreparationSyncRun(input))
        .rejects.toThrow('P4_INJECTED_TRANSACTION_CRASH')
      expect(await counts()).toEqual(before)
      await expect(persistStockPreparationSyncRun(input)).resolves.toMatchObject({
        persisted: true,
        mode: 'created',
        created: { batch: 1, lines: 2, run: 1 },
        project: { mode: scenario.existingProject ? 'patched' : 'created' },
      })
    }
  }, 30_000)

  test('concurrent same-batch writers converge to one create and one exact replay', async () => {
    const projectId = `${PROJECT_ID}_same_batch`
    const snapshotBatchId = `${SNAPSHOT_BATCH_ID}_same_batch`
    const input = persistInput(facade, {
      projectId,
      sourceProjectNo: `${SOURCE_PROJECT_NO}_same_batch`,
      syncRunId: `${SYNC_RUN_ID}_same_batch`,
      snapshotBatchId,
      snapshotVersion: 1,
    })
    facade.armUnitOfWorkBarrier(2)
    const results = await Promise.all([
      persistStockPreparationSyncRun(input),
      persistStockPreparationSyncRun(input),
    ])
    expect(results.map((result) => result.mode).sort()).toEqual(['created', 'skipped_existing'])

    const batchSheetId = sheetIds.get(BATCH_OBJECT_ID)
    const projectSheetId = sheetIds.get(PROJECT_OBJECT_ID)
    if (!batchSheetId || !projectSheetId) throw new Error('missing P4 concurrency sheet ids')
    const batchFields = await discoverPhysicalFields(batchSheetId, BATCH_OBJECT_ID)
    const projectFields = await discoverPhysicalFields(projectSheetId, PROJECT_OBJECT_ID)
    const batchRows = await q(
      'SELECT id FROM meta_records WHERE sheet_id = $1 AND data ->> $2 = $3',
      [batchSheetId, batchFields.snapshotBatchId, snapshotBatchId],
    )
    const projectRows = await q(
      'SELECT id FROM meta_records WHERE sheet_id = $1 AND data ->> $2 = $3',
      [projectSheetId, projectFields.projectId, projectId],
    )
    expect(batchRows.rows).toHaveLength(1)
    expect(projectRows.rows).toHaveLength(1)
  }, 30_000)

  test('concurrent different batches for one project never duplicate its live row', async () => {
    const projectId = `${PROJECT_ID}_same_project`
    const inputV1 = persistInput(facade, {
      projectId,
      sourceProjectNo: `${SOURCE_PROJECT_NO}_same_project`,
      syncRunId: `${SYNC_RUN_ID}_same_project_v1`,
      snapshotBatchId: `${SNAPSHOT_BATCH_ID}_same_project_v1`,
      snapshotVersion: 1,
    })
    const inputV2 = persistInput(facade, {
      projectId,
      sourceProjectNo: `${SOURCE_PROJECT_NO}_same_project`,
      syncRunId: `${SYNC_RUN_ID}_same_project_v2`,
      snapshotBatchId: `${SNAPSHOT_BATCH_ID}_same_project_v2`,
      snapshotVersion: 2,
    })
    facade.armUnitOfWorkBarrier(2)
    const outcomes = await Promise.allSettled([
      persistStockPreparationSyncRun(inputV1),
      persistStockPreparationSyncRun(inputV2),
    ])
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled')
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected')
    expect(fulfilled.length).toBeGreaterThanOrEqual(1)
    for (const outcome of rejected) {
      expect(outcome.reason).toMatchObject({
        status: 422,
        code: 'PERSIST_VERSION_NOT_MONOTONIC',
      })
    }

    const projectSheetId = sheetIds.get(PROJECT_OBJECT_ID)
    if (!projectSheetId) throw new Error('missing P4 project sheet id')
    const projectFields = await discoverPhysicalFields(projectSheetId, PROJECT_OBJECT_ID)
    const projectRows = await q(
      'SELECT id FROM meta_records WHERE sheet_id = $1 AND data ->> $2 = $3',
      [projectSheetId, projectFields.projectId, projectId],
    )
    expect(projectRows.rows).toHaveLength(1)
  }, 30_000)
})
