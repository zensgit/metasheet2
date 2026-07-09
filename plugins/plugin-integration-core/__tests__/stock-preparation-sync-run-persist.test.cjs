'use strict'

// #3751 stock-prep MVP — COMMIT (persist) a previewed BOM-snapshot sync-run PLAN into the 9 internal
// MVP tables. This is the FIRST slice that writes business rows, so the tests lock the safety
// invariants, not just the happy path. Covered:
//   (a) happy path — batch -> lines -> run each written to its OWN resolved MVP sheet; every write's
//       objectId (mapped back from the recorded sheetId) is in the frozen MVP set; ordering is
//       batch-first, run-last; patchRecord is never called;
//   (b) idempotency — a second persist of the same snapshotBatchId is SKIPPED (no new batch create);
//   (c) immutability — patchRecord / update is NEVER called on any path;
//   (d) grounding — a stamped missing_child_bom line persists WITHOUT the plan-internal missingChildBom
//       marker (records service rejects unknown fieldIds), and every persisted line key is template-declared;
//   (e) target not provisioned — fail closed with NO writes;
//   (f) admin-permission-denied — 403 BEFORE any provisioning / records access;
//   (g) values-free evidence — a planted leaky projectId + drawing number is absent from evidence
//       (while the persisted row payload legitimately carries it).

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  persistStockPreparationSyncRun,
  StockPreparationSyncRunPersistError,
  StockPreparationSyncRunPlanError,
  BATCH_OBJECT_ID,
  LINE_OBJECT_ID,
  RUN_OBJECT_ID,
  __internals: { MVP_OBJECT_ID_SET },
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-sync-run-persist.cjs'))
const {
  __internals: { LINE_FIELD_IDS },
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-sync-run-plan.cjs'))

const BATCH_SHEET_ID = `sheet_${BATCH_OBJECT_ID}`
const LINE_SHEET_ID = `sheet_${LINE_OBJECT_ID}`
const RUN_SHEET_ID = `sheet_${RUN_OBJECT_ID}`
const LINE_FIELD_ID_SET = new Set(LINE_FIELD_IDS)

// A leaky project id + drawing number carrying a unique token that MUST NEVER reach evidence.
const SECRET = 'SECRET_XYZ_9d1f'
const LEAKY_PROJECT_ID = `tenant_leaky:proj_${SECRET}`
const LEAKY_DRAWING_NO = `DRW_${SECRET}`

// The MVP tables live under the INTERNAL staging project; the business projectId ('proj_1') is a DIFFERENT
// value. Sheet resolution must use the staging targetProjectId — a lookup with the business project misses.
const STAGING_PROJECT_ID = 'tenant_x:integration-core'

let passed = 0
let failed = 0
const failures = []

function run(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1
    })
    .catch((error) => {
      failed += 1
      failures.push({ name, error })
      console.error(`FAIL: ${name}`)
      console.error(error && error.stack ? error.stack : error)
    })
}

// Stateful in-memory fake records API: stores every created row by sheetId, records every call's
// sheetId (+ data), and filters queryRecords by exact field equality — so idempotency genuinely hits
// the skip path. patchRecord is present ONLY so createTargetScopedRecordsApi's write-API guard passes;
// it counts invocations, which every test asserts stays 0.
function makeRecordsApi() {
  const store = new Map() // sheetId -> [{ id, data }]
  const createCalls = []
  const queryCalls = []
  let patchCalls = 0
  let seq = 0
  return {
    createCalls,
    queryCalls,
    get patchCalls() {
      return patchCalls
    },
    async createRecord(input = {}) {
      const { sheetId, data } = input
      createCalls.push({ sheetId, data })
      const rows = store.get(sheetId) || []
      seq += 1
      const record = { id: `rec_${seq}`, data: { ...data } }
      rows.push(record)
      store.set(sheetId, rows)
      return record
    },
    async queryRecords(input = {}) {
      const { sheetId, filters = {} } = input
      queryCalls.push({ sheetId, filters })
      const rows = store.get(sheetId) || []
      return rows.filter((record) => Object.entries(filters).every(([key, value]) => record.data[key] === value))
    },
    async patchRecord(input = {}) {
      patchCalls += 1
      return { id: input.recordId }
    },
  }
}

// Fake provisioning: a DISTINCT sheetId per MVP objectId (sheet_<objectId>), but ONLY under the STAGING
// project — a lookup with any other projectId (e.g. the business projectId) misses (returns null). This
// mirrors the real provisioning scope: ensure/readiness provisioned the tables under the staging project,
// so persist MUST resolve them there. `missing` names objectIds unprovisioned even under staging. Records
// every projectId seen (so a test can assert sheet resolution used the staging target, not the business
// project) and counts invocations (so the admin-gate-first test can assert zero).
function makeProvisioning({ missing = new Set(), stagingProjectId = STAGING_PROJECT_ID } = {}) {
  let findObjectSheetCalls = 0
  const projectIdsSeen = []
  return {
    get findObjectSheetCalls() {
      return findObjectSheetCalls
    },
    get projectIdsSeen() {
      return projectIdsSeen.slice()
    },
    async findObjectSheet({ projectId, objectId } = {}) {
      findObjectSheetCalls += 1
      projectIdsSeen.push(projectId)
      if (projectId !== stagingProjectId) return null
      if (missing.has(objectId)) return null
      return { id: `sheet_${objectId}` }
    },
  }
}

// A clean two-row expansion result: distinct paths, positive quantities.
function cleanExpansionResult() {
  return [
    { componentSourceId: 'CS1', componentCode: 'A-100', sourceVersion: 'V1', path: '/root/A-100', rawQuantity: 3 },
    { componentSourceId: 'CS2', componentCode: 'B-200', sourceVersion: 'V2', path: '/root/B-200', rawQuantity: 5, parentSourceId: 'CS1' },
  ]
}

// `projectId` is the BUSINESS project (rides the plan rows); `targetProjectId` is the internal STAGING
// project used only for sheet resolution — the module destructures it out before recomputing the plan, so
// it never reaches the plan/business rows. They are deliberately DIFFERENT values here.
function basePlanInputs(overrides = {}) {
  return {
    projectId: 'proj_1',
    targetProjectId: STAGING_PROJECT_ID,
    syncRunId: 'run_1',
    snapshotBatchId: 'batch_1',
    defaultDesignUnit: 'pcs',
    expansionResult: cleanExpansionResult(),
    ...overrides,
  }
}

// Map a recorded write sheetId back to its objectId via the fake convention (sheet_<objectId>).
function objectIdForSheet(sheetId) {
  return typeof sheetId === 'string' && sheetId.startsWith('sheet_') ? sheetId.slice('sheet_'.length) : null
}

async function main() {
  // ---- (a) happy path: batch -> lines -> run each to its OWN MVP sheet; objectId in MVP set; order ----
  await run('happy path writes batch->lines->run each to its own resolved MVP sheet', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    const result = await persistStockPreparationSyncRun({
      permission: 'admin',
      recordsApi,
      provisioning,
      ...basePlanInputs(),
    })

    assert.equal(result.persisted, true)
    assert.equal(result.mode, 'created')
    assert.deepEqual(result.created, { batch: 1, lines: 2, run: 1 })

    // 4 creates: 1 batch, 2 lines, 1 run — in that order.
    assert.equal(recordsApi.createCalls.length, 4)
    assert.equal(recordsApi.createCalls[0].sheetId, BATCH_SHEET_ID, 'batch written first')
    assert.equal(recordsApi.createCalls[1].sheetId, LINE_SHEET_ID)
    assert.equal(recordsApi.createCalls[2].sheetId, LINE_SHEET_ID)
    assert.equal(recordsApi.createCalls[3].sheetId, RUN_SHEET_ID, 'run written last')

    // Every write landed on a sheet whose objectId is in the frozen MVP set (mapped back from sheetId).
    for (const call of recordsApi.createCalls) {
      const objectId = objectIdForSheet(call.sheetId)
      assert.ok(objectId && MVP_OBJECT_ID_SET.has(objectId), `write objectId ${objectId} is an MVP target`)
    }

    // Batch row carries the batch key + status; run row carries the run id + type.
    assert.equal(recordsApi.createCalls[0].data.snapshotBatchId, 'batch_1')
    assert.equal(recordsApi.createCalls[0].data.snapshotStatus, 'draft')
    assert.equal(recordsApi.createCalls[3].data.runId, 'run_1')
    assert.equal(recordsApi.createCalls[3].data.runType, 'plm_sync')

    // Immutability: no patch ever.
    assert.equal(recordsApi.patchCalls, 0)
    // Evidence is values-free & carries the public objectId constants.
    assert.equal(result.evidence.valuesFree, true)
    assert.equal(result.evidence.targets.snapshotBatch.objectId, BATCH_OBJECT_ID)
    assert.equal(result.evidence.targets.snapshotLine.objectId, LINE_OBJECT_ID)
    assert.equal(result.evidence.targets.syncRun.objectId, RUN_OBJECT_ID)
    assert.equal(result.evidence.plannedLineCount, 2)

    // THE SPLIT: sheet resolution used the STAGING targetProjectId for all three lookups, NOT the business
    // projectId — while the persisted batch row still carries the BUSINESS projectId as business data.
    assert.deepEqual(provisioning.projectIdsSeen, [STAGING_PROJECT_ID, STAGING_PROJECT_ID, STAGING_PROJECT_ID])
    assert.equal(recordsApi.createCalls[0].data.projectId, 'proj_1')
  })

  // ---- project-scope split: targetProjectId (staging) resolves sheets; business projectId must NOT ----
  await run('targetProjectId is required — omitting it fails closed with NO provisioning/records access', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    await assert.rejects(
      () => persistStockPreparationSyncRun({
        permission: 'admin',
        recordsApi,
        provisioning,
        ...basePlanInputs({ targetProjectId: undefined }),
      }),
      (error) => error instanceof StockPreparationSyncRunPersistError && error.status === 422 && error.code === 'PERSIST_CONFIG_INVALID',
    )
    assert.equal(provisioning.findObjectSheetCalls, 0, 'no sheet resolved')
    assert.equal(recordsApi.createCalls.length, 0, 'no write')
  })

  await run('resolving sheets with the BUSINESS projectId misses — proves the split is load-bearing', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    // Pass the business projectId AS the target — the tables are not provisioned under it, so it fails closed.
    await assert.rejects(
      () => persistStockPreparationSyncRun({
        permission: 'admin',
        recordsApi,
        provisioning,
        ...basePlanInputs({ targetProjectId: 'proj_1' }),
      }),
      (error) => error instanceof StockPreparationSyncRunPersistError && error.code === 'PERSIST_TARGET_NOT_PROVISIONED',
    )
    assert.equal(recordsApi.createCalls.length, 0, 'no write on a missed target')
  })

  // ---- (d) grounding: a stamped missing_child_bom line drops the plan-internal marker on persist ----
  await run('persisted line rows are grounded — missingChildBom marker is dropped, keys are template-declared', async () => {
    const recordsApi = makeRecordsApi()
    const result = await persistStockPreparationSyncRun({
      permission: 'admin',
      recordsApi,
      provisioning: makeProvisioning(),
      ...basePlanInputs({
        expansionResult: {
          rows: cleanExpansionResult(),
          rowErrors: [{ type: 'missing_child_bom', depth: 2 }],
        },
      }),
    })
    // 2 mapped + 1 stamped incomplete line.
    assert.equal(result.created.lines, 3)
    const lineWrites = recordsApi.createCalls.filter((call) => call.sheetId === LINE_SHEET_ID)
    assert.equal(lineWrites.length, 3)
    for (const call of lineWrites) {
      assert.equal('missingChildBom' in call.data, false, 'plan-internal marker not persisted')
      for (const key of Object.keys(call.data)) {
        assert.ok(LINE_FIELD_ID_SET.has(key), `persisted line key ${key} is template-declared`)
      }
    }
    // At least one stamped incomplete line reached the sheet.
    assert.ok(lineWrites.some((call) => call.data.lineStatus === 'incomplete'), 'incomplete line persisted')
    assert.equal(recordsApi.patchCalls, 0)
  })

  // ---- (b) idempotency + (c) immutability: a repeat persist of the same batch id is skipped ----
  await run('a second persist of the same snapshotBatchId is skipped (no new batch create, no patch)', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    const first = await persistStockPreparationSyncRun({ permission: 'admin', recordsApi, provisioning, ...basePlanInputs() })
    assert.equal(first.persisted, true)
    const createsAfterFirst = recordsApi.createCalls.length
    assert.equal(createsAfterFirst, 4)

    const second = await persistStockPreparationSyncRun({ permission: 'admin', recordsApi, provisioning, ...basePlanInputs() })
    assert.equal(second.persisted, false)
    assert.equal(second.mode, 'skipped_existing')
    assert.deepEqual(second.created, { batch: 0, lines: 0, run: 0 })
    assert.equal(second.evidence.existingBatchMatched, true)

    // No new writes on the skip path — the batch (and its lines/run) are immutable.
    assert.equal(recordsApi.createCalls.length, createsAfterFirst, 'no new createRecord on skip')
    assert.equal(recordsApi.patchCalls, 0, 'patchRecord never called across both persists')
  })

  // ---- (e) target not provisioned -> fail closed, NO writes ----
  await run('any unprovisioned MVP target fails closed with no writes', async () => {
    for (const missingObjectId of [BATCH_OBJECT_ID, LINE_OBJECT_ID, RUN_OBJECT_ID]) {
      const recordsApi = makeRecordsApi()
      const provisioning = makeProvisioning({ missing: new Set([missingObjectId]) })
      await assert.rejects(
        () => persistStockPreparationSyncRun({ permission: 'admin', recordsApi, provisioning, ...basePlanInputs() }),
        (error) =>
          error instanceof StockPreparationSyncRunPersistError &&
          error.status === 409 &&
          error.code === 'PERSIST_TARGET_NOT_PROVISIONED' &&
          error.details.objectId === missingObjectId,
        `missing ${missingObjectId} fails closed`,
      )
      assert.equal(recordsApi.createCalls.length, 0, 'no rows written when a target is unprovisioned')
      assert.equal(recordsApi.patchCalls, 0)
    }
  })

  // ---- (f) admin-permission-denied: 403 BEFORE any provisioning / records access ----
  await run('non-admin permission throws 403 before any provisioning or records call', async () => {
    for (const permission of ['read', 'write', undefined, null, '']) {
      const recordsApi = makeRecordsApi()
      const provisioning = makeProvisioning()
      await assert.rejects(
        () => persistStockPreparationSyncRun({ permission, recordsApi, provisioning, ...basePlanInputs() }),
        (error) =>
          error instanceof StockPreparationSyncRunPersistError &&
          error.status === 403 &&
          error.code === 'PERSIST_PERMISSION_DENIED',
        `permission ${String(permission)} denied`,
      )
      assert.equal(provisioning.findObjectSheetCalls, 0, 'gate runs before provisioning')
      assert.equal(recordsApi.createCalls.length, 0)
      assert.equal(recordsApi.queryCalls.length, 0)
    }
  })

  // ---- provisioning API unavailable -> 503 (fail closed) ----
  await run('missing provisioning findObjectSheet is a 503 fail-closed', async () => {
    await assert.rejects(
      () => persistStockPreparationSyncRun({ permission: 'admin', recordsApi: makeRecordsApi(), provisioning: {}, ...basePlanInputs() }),
      (error) => error instanceof StockPreparationSyncRunPersistError && error.status === 503 && error.code === 'PERSIST_PROVISIONING_API_UNAVAILABLE',
    )
  })

  // ---- plan input validation is inherited (recompute re-validates) ----
  await run('a bad plan input (missing snapshotBatchId) surfaces the plan 422', async () => {
    await assert.rejects(
      () => persistStockPreparationSyncRun({ permission: 'admin', recordsApi: makeRecordsApi(), provisioning: makeProvisioning(), ...basePlanInputs({ snapshotBatchId: undefined }) }),
      (error) => error instanceof StockPreparationSyncRunPlanError && error.status === 422,
    )
  })

  // ---- (g) values-free evidence: a planted leaky projectId + drawing number never reaches evidence ----
  await run('evidence never leaks the projectId or a drawing number (rows still carry them)', async () => {
    const recordsApi = makeRecordsApi()
    const result = await persistStockPreparationSyncRun({
      permission: 'admin',
      recordsApi,
      provisioning: makeProvisioning(),
      ...basePlanInputs({
        projectId: LEAKY_PROJECT_ID,
        syncRunId: `run_${SECRET}`,
        snapshotBatchId: `batch_${SECRET}`,
        expansionResult: [
          { componentSourceId: 'CS1', componentCode: LEAKY_DRAWING_NO, sourceVersion: 'V1', path: `/root/${LEAKY_DRAWING_NO}`, rawQuantity: 3 },
        ],
      }),
    })

    // The persisted rows legitimately carry the business values (that IS the row data)...
    const lineWrite = recordsApi.createCalls.find((call) => call.sheetId === LINE_SHEET_ID)
    assert.ok(lineWrite, 'a line row was written')
    assert.equal(lineWrite.data.childDrawingNo, LEAKY_DRAWING_NO)
    const batchWrite = recordsApi.createCalls.find((call) => call.sheetId === BATCH_SHEET_ID)
    assert.equal(batchWrite.data.projectId, LEAKY_PROJECT_ID)

    // ...but the EVIDENCE is values-free: the secret token appears nowhere in it.
    const evidenceJson = JSON.stringify(result.evidence)
    assert.equal(evidenceJson.includes(SECRET), false, 'secret token absent from evidence')
    assert.equal(evidenceJson.includes(LEAKY_PROJECT_ID), false)
    assert.equal(evidenceJson.includes(LEAKY_DRAWING_NO), false)
    assert.equal(result.evidence.valuesFree, true)
    // Evidence still carries the values-free field-key NAMES + public objectId constants.
    assert.ok(result.evidence.targets.snapshotBatch.fieldKeys.includes('snapshotBatchId'))
    assert.equal(result.evidence.runType, 'plm_sync')
  })

  console.log(`\nstock-preparation-sync-run-persist.test.cjs: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    for (const { name } of failures) console.error(`  - ${name}`)
    process.exit(1)
  }
  console.log('stock-preparation-sync-run-persist.test.cjs OK')
}

main().catch((error) => {
  console.error('stock-preparation-sync-run-persist.test.cjs FAILED')
  console.error(error)
  process.exit(1)
})
