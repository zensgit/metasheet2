/**
 * Stock-preparation T3b-1a: immutable snapshot replay hardening (real DB).
 *
 * This suite provisions the real MVP sheets, persists through the platform records API, and discovers
 * physical field ids from meta_fields. It proves an exact replay is a no-op while a same-fingerprint
 * row whose frozen projection changed fails closed without repairing the immutable snapshot.
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

type QueryResult = { rows: unknown[]; rowCount?: number | null }

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
    }) => transaction((query) => ensureObject({ query, projectId, baseId, descriptor })),
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
      orderBy?: { fieldId?: string; direction?: 'asc' | 'desc' }
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

function persistInput(facade: ReturnType<typeof createRealMultitableFacade>): Record<string, unknown> {
  return {
    permission: 'admin',
    recordsApi: facade.records,
    provisioning: facade.provisioning,
    targetProjectId: TARGET_PROJECT_ID,
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
  }
}

if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
  test('T3b replay hardening real-DB allowlist must provide DATABASE_URL', () => {
    throw new Error('T3b replay hardening real-DB allowlist step is missing DATABASE_URL')
  })
}

describeIfDatabase('stock-preparation T3b immutable replay hardening (real DB)', () => {
  const facade = createRealMultitableFacade()
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
})
