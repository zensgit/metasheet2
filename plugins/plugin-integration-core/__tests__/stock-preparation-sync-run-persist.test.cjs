'use strict'

// #3751 stock-prep MVP — COMMIT (persist) a previewed BOM-snapshot sync-run PLAN into the 9 internal
// MVP tables. This is the FIRST slice that writes business rows, so the tests lock the safety
// invariants, not just the happy path. Covered:
//   (a) happy path — batch -> lines -> run each written to its OWN resolved MVP sheet; every write's
//       objectId (mapped back from the recorded sheetId) is in the frozen MVP set; ordering is
//       batch-first, run-last; patchRecord is never called ON THE BATCH/LINE/RUN sheets;
//   (b) idempotency — only an exact full-projection replay is SKIPPED; orphan/conflicting rows return 409;
//   (c) immutability — patchRecord / update is NEVER called on the batch/line/run sheets on any path;
//   (d) grounding — a stamped missing_child_bom line persists WITHOUT the plan-internal missingChildBom
//       marker (records service rejects unknown fieldIds), and every persisted line key is template-declared;
//   (e) target not provisioned — fail closed with NO writes (now including the PROJECT sheet);
//   (f) admin-permission-denied — 403 BEFORE any provisioning / records access;
//   (g) values-free evidence — a planted leaky projectId + drawing number is absent from evidence
//       (while the persisted row payload legitimately carries it);
//   (h) #4163 T1 — project-row UPSERT: create on first sync, PATCH (not a duplicate create) on a
//       SECOND, genuinely-new batch for the same project; the patch never carries owner / sourceProjectNo
//       / projectName (human_preserved + first-synced identity survive untouched); a duplicate/retried
//       persist of the SAME snapshotBatchId leaves the project row untouched entirely (idempotent skip).

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  persistStockPreparationSyncRun,
  StockPreparationSyncRunPersistError,
  StockPreparationSyncRunPlanError,
  BATCH_OBJECT_ID,
  LINE_OBJECT_ID,
  RUN_OBJECT_ID,
  PROJECT_OBJECT_ID,
  PROJECT_KEY_FIELD,
  __internals: { MVP_OBJECT_ID_SET, READ_PAGE_LIMIT, READ_MAX_PAGES, PERSIST_MAX_PLAN_LINES, readExistingSnapshotLines },
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-sync-run-persist.cjs'))
const {
  __internals: { LINE_FIELD_IDS },
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-sync-run-plan.cjs'))
const {
  makeFakeProvisioning,
  makeStrictRecordsApi,
  physicalFieldId,
  physicalRow,
  logicalData,
} = require(path.join(__dirname, 'fixtures', 'stock-preparation-multitable-fakes.cjs'))

const BATCH_SHEET_ID = `sheet_${BATCH_OBJECT_ID}`
const LINE_SHEET_ID = `sheet_${LINE_OBJECT_ID}`
const RUN_SHEET_ID = `sheet_${RUN_OBJECT_ID}`
const PROJECT_SHEET_ID = `sheet_${PROJECT_OBJECT_ID}`
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

// The 9 frozen MVP objects, each on its own sheet (sheet_<objectId>) — and the reverse map the STRICT
// fake needs to know which object's field ids a given sheet accepts.
const SHEET_ID_BY_OBJECT_ID = Object.fromEntries([...MVP_OBJECT_ID_SET].map((objectId) => [objectId, `sheet_${objectId}`]))
const OBJECT_ID_BY_SHEET_ID = Object.fromEntries(Object.entries(SHEET_ID_BY_OBJECT_ID).map(([objectId, sheetId]) => [sheetId, objectId]))

// #4160 — the records API is now STRICT: it accepts ONLY the physical fieldIds provisioning derived for
// the sheet's object, exactly like the real service (`Unknown fieldId: X` otherwise). The old fake here
// accepted the templates' LOGICAL keys, which is why the whole suite was green while every write 500'd
// in production. Point this fake at the pre-fix module and it throws `Unknown fieldId: snapshotBatchId`.
function makeRecordsApi(options = {}) {
  return makeStrictRecordsApi({
    objectIdBySheetId: OBJECT_ID_BY_SHEET_ID,
    stagingProjectId: STAGING_PROJECT_ID,
    ...options,
  })
}

function makePaginatedRecordsApi(options = {}) {
  const api = makeRecordsApi(options)
  const queryRecords = api.queryRecords.bind(api)
  api.queryRecords = async (input = {}) => {
    const rows = await queryRecords(input)
    const offset = Number.isInteger(input.offset) ? input.offset : 0
    const limit = Number.isInteger(input.limit) ? input.limit : rows.length
    return rows.slice(offset, offset + limit)
  }
  return api
}

// Fake provisioning: a DISTINCT sheetId per MVP objectId (sheet_<objectId>), but ONLY under the STAGING
// project — a lookup with any other projectId (e.g. the business projectId) misses (returns null). This
// mirrors the real provisioning scope: ensure/readiness provisioned the tables under the staging project,
// so persist MUST resolve them there. `missing` names objectIds unprovisioned even under staging.
// resolveFieldIds mirrors the platform derivation, so the module can learn the physical ids.
function makeProvisioning({ missing = new Set(), stagingProjectId = STAGING_PROJECT_ID } = {}) {
  const fake = makeFakeProvisioning({ sheetIdByObjectId: SHEET_ID_BY_OBJECT_ID, stagingProjectId, missing })
  return {
    ...fake,
    get findObjectSheetCalls() {
      return fake.calls.findObjectSheet.length
    },
    // Only the SHEET lookups' project ids — the field-id resolution rides the same staging project by
    // construction (the scoped API resolves under the projectId the sheet was resolved with).
    get projectIdsSeen() {
      return fake.calls.findObjectSheet.map((call) => call.projectId)
    },
    findObjectSheet: fake.findObjectSheet,
    resolveFieldIds: fake.resolveFieldIds,
  }
}

// The recorded write payloads are keyed by PHYSICAL fieldId (that is the whole point). Read them back
// as logical keys for the value assertions; `rawKeysArePhysical` pins the translation itself.
function logicalOf(call) {
  return logicalData(STAGING_PROJECT_ID, objectIdForSheet(call.sheetId), call.data)
}

function rawKeysArePhysical(call) {
  const objectId = objectIdForSheet(call.sheetId)
  return Object.keys(call.data).every((key) => key.startsWith('fld_')) &&
    Object.keys(logicalOf(call)).every((logical) => call.data[physicalFieldId(STAGING_PROJECT_ID, objectId, logical)] !== undefined)
}

// A clean two-row expansion result: distinct paths, positive quantities.
function cleanExpansionResult() {
  return [
    { componentSourceId: 'CS1', componentCode: 'A-100', sourceVersion: 'V1', path: '/root/A-100', rawQuantity: 3 },
    { componentSourceId: 'CS2', componentCode: 'B-200', sourceVersion: 'V2', path: '/root/B-200', rawQuantity: 5, parentSourceId: 'CS1' },
  ]
}

function manyExpansionRows(count) {
  return Array.from({ length: count }, (_value, index) => ({
    componentSourceId: `CS-${index}`,
    componentCode: `PART-${index}`,
    sourceVersion: 'V1',
    path: `/root/PART-${index}`,
    rawQuantity: index + 1,
  }))
}

// `projectId` is the BUSINESS project (rides the plan rows); `targetProjectId` is the internal STAGING
// project used only for sheet resolution — the module destructures it out before recomputing the plan, so
// it never reaches the plan/business rows. They are deliberately DIFFERENT values here. `sourceProjectNo`
// is the project row's own required populator input (#4163 T1) — unrelated to the plan orchestrator.
function basePlanInputs(overrides = {}) {
  return {
    projectId: 'proj_1',
    targetProjectId: STAGING_PROJECT_ID,
    syncRunId: 'run_1',
    snapshotBatchId: 'batch_1',
    sourceProjectNo: 'PN-1',
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

    // 5 creates: 1 batch, 2 lines, 1 run, THEN the project row (upserted last) — in that order.
    assert.equal(recordsApi.createCalls.length, 5)
    assert.equal(recordsApi.createCalls[0].sheetId, BATCH_SHEET_ID, 'batch written first')
    assert.equal(recordsApi.createCalls[1].sheetId, LINE_SHEET_ID)
    assert.equal(recordsApi.createCalls[2].sheetId, LINE_SHEET_ID)
    assert.equal(recordsApi.createCalls[3].sheetId, RUN_SHEET_ID, 'run written last of batch/line/run')
    assert.equal(recordsApi.createCalls[4].sheetId, PROJECT_SHEET_ID, 'project row upserted last overall')

    // Every write landed on a sheet whose objectId is in the frozen MVP set (mapped back from sheetId).
    for (const call of recordsApi.createCalls) {
      const objectId = objectIdForSheet(call.sheetId)
      assert.ok(objectId && MVP_OBJECT_ID_SET.has(objectId), `write objectId ${objectId} is an MVP target`)
    }

    // Batch row carries the batch key + status; run row carries the run id + type.
    assert.equal(logicalOf(recordsApi.createCalls[0]).snapshotBatchId, 'batch_1')
    assert.equal(logicalOf(recordsApi.createCalls[0]).snapshotStatus, 'draft')
    assert.equal(logicalOf(recordsApi.createCalls[3]).runId, 'run_1')
    assert.equal(logicalOf(recordsApi.createCalls[3]).runType, 'plm_sync')

    // #4163 T1: the project row was CREATED (first sync for this project) — key + required field +
    // status + last-sync pointer, and projectName is ABSENT (the plan input never supplied one).
    const projectRow = logicalOf(recordsApi.createCalls[4])
    assert.equal(projectRow[PROJECT_KEY_FIELD], 'proj_1')
    assert.equal(projectRow.sourceProjectNo, 'PN-1')
    assert.equal(projectRow.projectStatus, 'active')
    assert.equal(projectRow.lastSyncRunId, 'run_1')
    assert.equal(typeof projectRow.lastSyncedAt, 'string')
    assert.equal('projectName' in projectRow, false, 'projectName not invented when absent from input')
    assert.deepEqual(result.project, { mode: 'created' })

    // Immutability: no patch ever (batch/line/run/project ALL created on a first sync).
    assert.equal(recordsApi.patchCalls.length, 0)
    // Evidence is values-free & carries the public objectId constants.
    assert.equal(result.evidence.valuesFree, true)
    assert.equal(result.evidence.targets.snapshotBatch.objectId, BATCH_OBJECT_ID)
    assert.equal(result.evidence.targets.snapshotLine.objectId, LINE_OBJECT_ID)
    assert.equal(result.evidence.targets.syncRun.objectId, RUN_OBJECT_ID)
    assert.equal(result.evidence.targets.project.objectId, PROJECT_OBJECT_ID)
    assert.equal(result.evidence.projectSync.mode, 'created')
    assert.equal(result.evidence.plannedLineCount, 2)

    // THE SPLIT: sheet resolution used the STAGING targetProjectId for all FOUR lookups, NOT the business
    // projectId — while the persisted batch row still carries the BUSINESS projectId as business data.
    assert.deepEqual(provisioning.projectIdsSeen, [STAGING_PROJECT_ID, STAGING_PROJECT_ID, STAGING_PROJECT_ID, STAGING_PROJECT_ID])
    assert.equal(logicalOf(recordsApi.createCalls[0]).projectId, 'proj_1')
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
      const logical = logicalOf(call)
      assert.equal('missingChildBom' in logical, false, 'plan-internal marker not persisted')
      // The keys actually sent to the records service are PHYSICAL fieldIds; each maps back to a
      // template-declared logical key of the line template (nothing else may be written).
      assert.ok(rawKeysArePhysical(call), 'line write used physical fieldIds')
      for (const key of Object.keys(logical)) {
        assert.ok(LINE_FIELD_ID_SET.has(key), `persisted line key ${key} is template-declared`)
      }
    }
    // At least one stamped incomplete line reached the sheet.
    assert.ok(lineWrites.some((call) => logicalOf(call).lineStatus === 'incomplete'), 'incomplete line persisted')
    assert.equal(recordsApi.patchCalls.length, 0)
  })

  // ---- #4160: the write path speaks PHYSICAL fieldIds — a logical key would be rejected outright ----
  await run('#4160 every create/query key is a resolved physical fieldId, never a logical template key', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    await persistStockPreparationSyncRun({ permission: 'admin', recordsApi, provisioning, ...basePlanInputs() })

    // Writes: every key is the physical id provisioning derived for that sheet's object.
    for (const call of recordsApi.createCalls) {
      assert.ok(rawKeysArePhysical(call), `create on ${call.sheetId} used physical fieldIds`)
      assert.equal(Object.keys(call.data).some((key) => key === 'snapshotBatchId' || key === 'runId'), false,
        'no raw logical key ever reaches the records service')
    }
    // Reads: the idempotency probe filters by the PHYSICAL snapshotBatchId — the exact key the real
    // service accepts (a logical filter key is rejected with `Unknown fieldId`).
    const batchProbe = recordsApi.queryCalls.find((call) => call.sheetId === BATCH_SHEET_ID)
    assert.ok(batchProbe, 'the batch idempotency probe ran')
    assert.deepEqual(Object.keys(batchProbe.filters), [physicalFieldId(STAGING_PROJECT_ID, BATCH_OBJECT_ID, 'snapshotBatchId')])
    assert.equal(Object.values(batchProbe.filters)[0], 'batch_1')

    // And the field ids were learned through the sanctioned API, under the STAGING project.
    assert.ok(provisioning.calls.resolveFieldIds.length > 0, 'field ids resolved via provisioning.resolveFieldIds')
    for (const call of provisioning.calls.resolveFieldIds) {
      assert.equal(call.projectId, STAGING_PROJECT_ID, 'field ids resolved under the staging project, not the business project')
    }
  })

  // ---- #4160 fail-closed: a field the target template does not declare THROWS (never silently dropped) ----
  await run('#4160 an undeclared logical key is rejected by the scoped API, not silently dropped', async () => {
    const { createTargetScopedRecordsApi, StockPreparationTableActionError } =
      require(path.join(__dirname, '..', 'lib', 'stock-preparation-table-actions.cjs'))
    const recordsApi = makeRecordsApi()
    const scoped = await createTargetScopedRecordsApi(
      recordsApi,
      { sheetId: BATCH_SHEET_ID, objectId: BATCH_OBJECT_ID },
      { provisioning: makeProvisioning(), projectId: STAGING_PROJECT_ID },
    )
    for (const call of [
      () => scoped.createRecord({ data: { snapshotBatchId: 'b1', notATemplateField: 'x' } }),
      () => scoped.patchRecord({ recordId: 'rec_1', changes: { notATemplateField: 'x' } }),
      () => scoped.queryRecords({ filters: { notATemplateField: 'x' } }),
    ]) {
      await assert.rejects(call, (error) =>
        error instanceof StockPreparationTableActionError &&
        error.code === 'TABLE_ACTION_UNKNOWN_LOGICAL_FIELD' &&
        error.details.field === 'notATemplateField')
    }
    assert.equal(recordsApi.createCalls.length, 0, 'nothing was written with a dropped field')
  })

  // ---- the target-sheet fence: a call that names ANOTHER sheet is refused, not silently redirected ----
  // This is the last lock on "stock-prep writes only ever touch its own 9 internal tables". It was the one
  // guard with zero coverage (#4163 review F1). `withTargetSheet` also overwrites sheetId, so deleting the
  // throw would make an out-of-scope attempt SILENT rather than successful — but silence is exactly how a
  // caller drifting to the wrong sheet stops being noticed. The fence must speak.
  await run('#4163 a records call naming a DIFFERENT sheet is refused (403), on every verb', async () => {
    const { createTargetScopedRecordsApi, StockPreparationTableActionError } =
      require(path.join(__dirname, '..', 'lib', 'stock-preparation-table-actions.cjs'))
    const recordsApi = makeRecordsApi()
    const scoped = await createTargetScopedRecordsApi(
      recordsApi,
      { sheetId: BATCH_SHEET_ID, objectId: BATCH_OBJECT_ID },
      { provisioning: makeProvisioning(), projectId: STAGING_PROJECT_ID },
    )
    const foreignSheetId = `${BATCH_SHEET_ID}_someone_elses_sheet`
    for (const call of [
      () => scoped.createRecord({ sheetId: foreignSheetId, data: { snapshotBatchId: 'b1' } }),
      () => scoped.patchRecord({ sheetId: foreignSheetId, recordId: 'rec_1', changes: { snapshotStatus: 'draft' } }),
      () => scoped.queryRecords({ sheetId: foreignSheetId, filters: { snapshotBatchId: 'b1' } }),
    ]) {
      await assert.rejects(call, (error) =>
        error instanceof StockPreparationTableActionError &&
        error.status === 403 &&
        error.code === 'TABLE_ACTION_TARGET_SCOPE_VIOLATION')
    }
    assert.equal(recordsApi.createCalls.length, 0, 'no write escaped to the foreign sheet')
    // The bound sheet still works — the fence is scoped, not a blanket refusal.
    await scoped.createRecord({ data: { snapshotBatchId: 'b1' } })
    assert.equal(recordsApi.createCalls.length, 1)
    assert.equal(recordsApi.createCalls[0].sheetId, BATCH_SHEET_ID)
  })

  // ---- (b) idempotency + (c) immutability: a repeat persist of the same batch id is skipped ----
  await run('a second persist of the same snapshotBatchId is skipped (no new batch create, no patch)', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    const first = await persistStockPreparationSyncRun({ permission: 'admin', recordsApi, provisioning, ...basePlanInputs() })
    assert.equal(first.persisted, true)
    const createsAfterFirst = recordsApi.createCalls.length
    assert.equal(createsAfterFirst, 5, 'batch + 2 lines + run + the first-sync project create')
    assert.deepEqual(first.project, { mode: 'created' })

    const second = await persistStockPreparationSyncRun({ permission: 'admin', recordsApi, provisioning, ...basePlanInputs() })
    assert.equal(second.persisted, false)
    assert.equal(second.mode, 'skipped_existing')
    assert.deepEqual(second.created, { batch: 0, lines: 0, run: 0 })
    assert.equal(second.evidence.existingBatchMatched, true)
    // A duplicate/retried persist of the SAME snapshotBatchId verifies project existence but leaves the
    // live pointer untouched (no create/patch) — the whole commit is a proven no-op replay.
    assert.deepEqual(second.project, { mode: 'skipped' })

    // No new writes on the skip path — the batch/lines/run/project are all left alone.
    assert.equal(recordsApi.createCalls.length, createsAfterFirst, 'no new createRecord on skip')
    assert.equal(recordsApi.patchCalls.length, 0, 'patchRecord never called across both persists (same batch retried)')
  })

  await run('duplicate planned snapshotLineId fails before provisioning or records I/O', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    await assert.rejects(
      () => persistStockPreparationSyncRun({
        permission: 'admin',
        recordsApi,
        provisioning,
        ...basePlanInputs({ expansionResult: [cleanExpansionResult()[0], cleanExpansionResult()[0]] }),
      }),
      (error) => error instanceof StockPreparationSyncRunPersistError &&
        error.status === 422 &&
        error.code === 'PERSIST_PLAN_LINE_KEY_AMBIGUOUS',
    )
    assert.equal(provisioning.findObjectSheetCalls, 0)
    assert.equal(recordsApi.queryCalls.length, 0)
    assert.equal(recordsApi.createCalls.length, 0)
  })

  await run('duplicate project keys fail before the first batch write', async () => {
    const projectRows = [
      physicalRow(STAGING_PROJECT_ID, PROJECT_OBJECT_ID, { projectId: 'proj_1', sourceProjectNo: 'PN-1' }, 'project-1'),
      physicalRow(STAGING_PROJECT_ID, PROJECT_OBJECT_ID, { projectId: 'proj_1', sourceProjectNo: 'PN-1' }, 'project-2'),
    ]
    const recordsApi = makeRecordsApi({ rowsBySheet: { [PROJECT_SHEET_ID]: projectRows } })
    await assert.rejects(
      () => persistStockPreparationSyncRun({
        permission: 'admin',
        recordsApi,
        provisioning: makeProvisioning(),
        ...basePlanInputs(),
      }),
      (error) => error instanceof StockPreparationSyncRunPersistError &&
        error.status === 409 &&
        error.code === 'PERSIST_IDEMPOTENCY_CONFLICT' &&
        error.details.target === 'project',
    )
    assert.equal(recordsApi.createCalls.length, 0, 'batch is not planted before project uniqueness is proven')
    assert.equal(recordsApi.patchCalls.length, 0)
  })

  await run('an existing project row without a patchable record id fails before the first batch write', async () => {
    const recordsApi = makeRecordsApi({
      rowsBySheet: {
        [PROJECT_SHEET_ID]: [physicalRow(STAGING_PROJECT_ID, PROJECT_OBJECT_ID, { projectId: 'proj_1' })],
      },
    })
    await assert.rejects(
      () => persistStockPreparationSyncRun({
        permission: 'admin',
        recordsApi,
        provisioning: makeProvisioning(),
        ...basePlanInputs(),
      }),
      (error) => error instanceof StockPreparationSyncRunPersistError &&
        error.status === 409 &&
        error.code === 'PERSIST_IDEMPOTENCY_CONFLICT' &&
        error.details.target === 'project' &&
        error.details.reason === 'missing_record_id',
    )
    assert.equal(recordsApi.createCalls.length, 0)
    assert.equal(recordsApi.patchCalls.length, 0)
  })

  await run('batch and run projection mismatches conflict without repairing immutable rows', async () => {
    for (const target of ['snapshot_batch', 'run']) {
      const recordsApi = makeRecordsApi()
      const provisioning = makeProvisioning()
      await persistStockPreparationSyncRun({ permission: 'admin', recordsApi, provisioning, ...basePlanInputs() })
      const sheetId = target === 'snapshot_batch' ? BATCH_SHEET_ID : RUN_SHEET_ID
      const objectId = target === 'snapshot_batch' ? BATCH_OBJECT_ID : RUN_OBJECT_ID
      const fieldId = target === 'snapshot_batch' ? 'snapshotStatus' : 'status'
      recordsApi.store.get(sheetId)[0].data[physicalFieldId(STAGING_PROJECT_ID, objectId, fieldId)] = 'conflicting'
      const createsBefore = recordsApi.createCalls.length
      await assert.rejects(
        () => persistStockPreparationSyncRun({ permission: 'admin', recordsApi, provisioning, ...basePlanInputs() }),
        (error) => error instanceof StockPreparationSyncRunPersistError &&
          error.code === 'PERSIST_IDEMPOTENCY_CONFLICT' &&
          error.details.target === target &&
          error.details.reason === 'content_mismatch',
      )
      assert.equal(recordsApi.createCalls.length, createsBefore)
      assert.equal(recordsApi.patchCalls.length, 0)
    }
  })

  for (const [fieldId, changedValue] of [
    ['pathKey', `/changed/${SECRET}`],
    ['designQty', 999],
    ['designUnit', ' pcs '],
    ['lineStatus', 'inactive'],
  ]) {
    await run(`same fingerprint with changed persisted ${fieldId} is a conflict, not a false skip`, async () => {
      const recordsApi = makeRecordsApi()
      const provisioning = makeProvisioning()
      await persistStockPreparationSyncRun({ permission: 'admin', recordsApi, provisioning, ...basePlanInputs() })
      const line = recordsApi.store.get(LINE_SHEET_ID)[0]
      const fingerprintField = physicalFieldId(STAGING_PROJECT_ID, LINE_OBJECT_ID, 'sourceFingerprint')
      const originalFingerprint = line.data[fingerprintField]
      line.data[physicalFieldId(STAGING_PROJECT_ID, LINE_OBJECT_ID, fieldId)] = changedValue
      const createsBefore = recordsApi.createCalls.length
      let caught
      try {
        await persistStockPreparationSyncRun({ permission: 'admin', recordsApi, provisioning, ...basePlanInputs() })
      } catch (error) {
        caught = error
      }
      assert.ok(caught instanceof StockPreparationSyncRunPersistError)
      assert.equal(caught.code, 'PERSIST_IDEMPOTENCY_CONFLICT')
      assert.equal(caught.details.target, 'snapshot_line')
      assert.equal(JSON.stringify(caught).includes(SECRET), false, 'conflict response is values-free')
      assert.equal(line.data[fingerprintField], originalFingerprint, 'fingerprint stayed identical for the discriminating case')
      assert.equal(recordsApi.createCalls.length, createsBefore)
      assert.equal(recordsApi.patchCalls.length, 0)
    })
  }

  for (const missingTarget of ['run', 'snapshot_line', 'project']) {
    await run(`an existing batch with a missing ${missingTarget} row returns incomplete`, async () => {
      const recordsApi = makeRecordsApi()
      const provisioning = makeProvisioning()
      await persistStockPreparationSyncRun({ permission: 'admin', recordsApi, provisioning, ...basePlanInputs() })
      const sheetId = missingTarget === 'run'
        ? RUN_SHEET_ID
        : (missingTarget === 'snapshot_line' ? LINE_SHEET_ID : PROJECT_SHEET_ID)
      recordsApi.store.set(sheetId, [])
      const createsBefore = recordsApi.createCalls.length
      await assert.rejects(
        () => persistStockPreparationSyncRun({ permission: 'admin', recordsApi, provisioning, ...basePlanInputs() }),
        (error) => error instanceof StockPreparationSyncRunPersistError &&
          error.status === 409 &&
          error.code === 'PERSIST_EXISTING_BATCH_INCOMPLETE' &&
          error.details.target === missingTarget,
      )
      assert.equal(recordsApi.createCalls.length, createsBefore)
      assert.equal(recordsApi.patchCalls.length, 0)
    })
  }

  await run('duplicate existing batch/run/line keys fail closed as idempotency conflicts', async () => {
    for (const target of ['snapshot_batch', 'run', 'snapshot_line']) {
      const recordsApi = makeRecordsApi()
      const provisioning = makeProvisioning()
      await persistStockPreparationSyncRun({ permission: 'admin', recordsApi, provisioning, ...basePlanInputs() })
      const sheetId = target === 'snapshot_batch' ? BATCH_SHEET_ID : (target === 'run' ? RUN_SHEET_ID : LINE_SHEET_ID)
      const rows = recordsApi.store.get(sheetId)
      rows.push({ ...rows[0], id: `${rows[0].id}-duplicate`, data: { ...rows[0].data } })
      const createsBefore = recordsApi.createCalls.length
      await assert.rejects(
        () => persistStockPreparationSyncRun({ permission: 'admin', recordsApi, provisioning, ...basePlanInputs() }),
        (error) => error instanceof StockPreparationSyncRunPersistError &&
          error.code === 'PERSIST_IDEMPOTENCY_CONFLICT' &&
          error.details.target === target,
      )
      assert.equal(recordsApi.createCalls.length, createsBefore)
      assert.equal(recordsApi.patchCalls.length, 0)
    }
  })

  await run('exact replay reads all line pages and normalizes persisted number serialization', async () => {
    const recordsApi = makePaginatedRecordsApi()
    const provisioning = makeProvisioning()
    const inputs = basePlanInputs({ expansionResult: manyExpansionRows(READ_PAGE_LIMIT + 1), snapshotVersion: 1 })
    await persistStockPreparationSyncRun({ permission: 'admin', recordsApi, provisioning, ...inputs })
    const batch = recordsApi.store.get(BATCH_SHEET_ID)[0]
    batch.data[physicalFieldId(STAGING_PROJECT_ID, BATCH_OBJECT_ID, 'snapshotVersion')] = '1'
    const createsBefore = recordsApi.createCalls.length
    const replay = await persistStockPreparationSyncRun({ permission: 'admin', recordsApi, provisioning, ...inputs })
    assert.equal(replay.mode, 'skipped_existing')
    const lineQueries = recordsApi.queryCalls.filter((call) => call.sheetId === LINE_SHEET_ID)
    assert.ok(lineQueries.length >= 2, 'more than one bounded page was read')
    assert.equal(recordsApi.createCalls.length, createsBefore)
    assert.equal(recordsApi.patchCalls.length, 0)
  })

  await run('a full final line page at the maximum page bound is unprovable', async () => {
    let calls = 0
    const page = Array.from({ length: READ_PAGE_LIMIT }, () => ({ id: 'opaque', data: {} }))
    await assert.rejects(
      () => readExistingSnapshotLines({
        async queryRecords() {
          calls += 1
          return page
        },
      }, 'batch-opaque'),
      (error) => error instanceof StockPreparationSyncRunPersistError &&
        error.status === 409 &&
        error.code === 'PERSIST_EXISTING_BATCH_READ_UNPROVABLE',
    )
    assert.equal(calls, READ_MAX_PAGES)
  })

  // ---- #4163 T1: a SECOND, genuinely-new batch for the SAME project PATCHES the project row ----
  await run('a second (new) sync for the same project PATCHES the project row, never duplicates it, and never touches owner/sourceProjectNo/projectName', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    const first = await persistStockPreparationSyncRun({
      permission: 'admin',
      recordsApi,
      provisioning,
      ...basePlanInputs({ sourceProjectNo: 'PN-ORIGINAL', projectName: 'Original Name' }),
    })
    assert.deepEqual(first.project, { mode: 'created' })
    const projectCreateCall = recordsApi.createCalls.find((call) => call.sheetId === PROJECT_SHEET_ID)
    assert.ok(projectCreateCall)
    assert.equal(logicalOf(projectCreateCall).sourceProjectNo, 'PN-ORIGINAL')
    assert.equal(logicalOf(projectCreateCall).projectName, 'Original Name')

    // A human sets `owner` directly on the stored row between syncs (simulating the human_preserved
    // annotation) — the fake records API supports this via a direct patch outside the module under test.
    const projectRecordId = projectCreateCall && (await recordsApi.queryRecords({
      sheetId: PROJECT_SHEET_ID,
      filters: { [physicalFieldId(STAGING_PROJECT_ID, PROJECT_OBJECT_ID, PROJECT_KEY_FIELD)]: 'proj_1' },
    }))[0].id
    await recordsApi.patchRecord({
      sheetId: PROJECT_SHEET_ID,
      recordId: projectRecordId,
      changes: { [physicalFieldId(STAGING_PROJECT_ID, PROJECT_OBJECT_ID, 'owner')]: 'human-owner-alice' },
    })

    // A SECOND, genuinely different batch/syncRun for the SAME project — NOT a duplicate/retry.
    // snapshotVersion bumps to 2: repeat syncs must be strictly monotonic per project (H-2
    // precondition guard) — a default-version repeat sync now fails loudly (own test below).
    const second = await persistStockPreparationSyncRun({
      permission: 'admin',
      recordsApi,
      provisioning,
      ...basePlanInputs({
        syncRunId: 'run_2',
        snapshotBatchId: 'batch_2',
        snapshotVersion: 2,
        // sourceProjectNo/projectName supplied again (a real caller always sends the populator inputs);
        // they must NOT overwrite the ORIGINAL stored values on this patch path.
        sourceProjectNo: 'PN-CHANGED-LATER',
        projectName: 'Changed Name Later',
      }),
    })
    assert.equal(second.persisted, true)
    assert.deepEqual(second.project, { mode: 'patched' })

    // Still exactly ONE project row (no duplicate) — patched, not re-created.
    const projectRowsNow = recordsApi.rows(PROJECT_SHEET_ID)
    assert.equal(projectRowsNow.length, 1, 'no duplicate project row for the same projectId')
    const patchCallsOnProject = recordsApi.patchCalls.filter((call) => call.sheetId === PROJECT_SHEET_ID)
    assert.equal(patchCallsOnProject.length, 2, 'the human owner-patch plus the populator patch')
    const populatorPatch = patchCallsOnProject[1]
    const populatorPatchLogical = logicalData(STAGING_PROJECT_ID, PROJECT_OBJECT_ID, populatorPatch.changes)
    assert.deepEqual(
      Object.keys(populatorPatchLogical).sort(),
      ['lastSyncRunId', 'lastSyncedAt', 'projectStatus'],
      'the populator patch touches ONLY lastSyncRunId/lastSyncedAt/projectStatus',
    )
    assert.equal(populatorPatchLogical.lastSyncRunId, 'run_2')
    assert.equal(populatorPatchLogical.projectStatus, 'active')

    // The ORIGINAL sourceProjectNo/projectName survive untouched (never overwritten by the second sync);
    // the human-set owner survives untouched too (human_preserved, never in the patch payload).
    const finalRow = logicalData(STAGING_PROJECT_ID, PROJECT_OBJECT_ID, projectRowsNow[0].data)
    assert.equal(finalRow.sourceProjectNo, 'PN-ORIGINAL')
    assert.equal(finalRow.projectName, 'Original Name')
    assert.equal(finalRow.owner, 'human-owner-alice')
    assert.equal(finalRow.projectStatus, 'active')
    assert.equal(finalRow.lastSyncRunId, 'run_2')

    // Batch/line/run rows for the FIRST batch are untouched — patchRecord never touches those sheets.
    assert.equal(recordsApi.patchCalls.filter((call) => call.sheetId !== PROJECT_SHEET_ID).length, 0)

    // Replaying the older exact snapshot remains a no-op even though the live project pointer now refers
    // to run_2. Replay checks project cardinality, not mutable live-pointer contents, and never rolls it back.
    const patchCountBeforeReplay = recordsApi.patchCalls.length
    const replay = await persistStockPreparationSyncRun({
      permission: 'admin',
      recordsApi,
      provisioning,
      ...basePlanInputs({ sourceProjectNo: 'PN-ORIGINAL', projectName: 'Original Name' }),
    })
    assert.equal(replay.mode, 'skipped_existing')
    assert.deepEqual(replay.project, { mode: 'skipped' })
    assert.equal(recordsApi.patchCalls.length, patchCountBeforeReplay)
    const projectAfterReplay = logicalData(STAGING_PROJECT_ID, PROJECT_OBJECT_ID, recordsApi.store.get(PROJECT_SHEET_ID)[0].data)
    assert.equal(projectAfterReplay.lastSyncRunId, 'run_2')
  })

  // ---- (e) target not provisioned -> fail closed, NO writes ----
  await run('any unprovisioned MVP target fails closed with no writes', async () => {
    for (const missingObjectId of [BATCH_OBJECT_ID, LINE_OBJECT_ID, RUN_OBJECT_ID, PROJECT_OBJECT_ID]) {
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
      assert.equal(recordsApi.patchCalls.length, 0)
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
    assert.equal(logicalOf(lineWrite).childDrawingNo, LEAKY_DRAWING_NO)
    const batchWrite = recordsApi.createCalls.find((call) => call.sheetId === BATCH_SHEET_ID)
    assert.equal(logicalOf(batchWrite).projectId, LEAKY_PROJECT_ID)
    // The project row's OWN key field is the SAME leaky projectId (#4163 T1) — legitimate row data.
    const projectWrite = recordsApi.createCalls.find((call) => call.sheetId === PROJECT_SHEET_ID)
    assert.ok(projectWrite, 'a project row was written')
    assert.equal(logicalOf(projectWrite)[PROJECT_KEY_FIELD], LEAKY_PROJECT_ID)
    assert.equal(logicalOf(projectWrite).sourceProjectNo, 'PN-1')

    // ...but the EVIDENCE is values-free: the secret token appears nowhere in it.
    const evidenceJson = JSON.stringify(result.evidence)
    assert.equal(evidenceJson.includes(SECRET), false, 'secret token absent from evidence')
    assert.equal(evidenceJson.includes(LEAKY_PROJECT_ID), false)
    assert.equal(evidenceJson.includes(LEAKY_DRAWING_NO), false)
    assert.equal(result.evidence.valuesFree, true)
    // Evidence still carries the values-free field-key NAMES + public objectId constants.
    assert.ok(result.evidence.targets.snapshotBatch.fieldKeys.includes('snapshotBatchId'))
    assert.ok(result.evidence.targets.project.fieldKeys.includes('sourceProjectNo'))
    assert.equal(result.evidence.targets.project.objectId, PROJECT_OBJECT_ID)
    assert.equal(result.evidence.projectSync.mode, 'created')
    assert.equal(result.evidence.runType, 'plm_sync')
  })

  // ---- #4163 T1: sourceProjectNo is required — omitting it fails closed with NO writes ----
  await run('sourceProjectNo is required for the project-row populator — omitting it fails closed with NO writes', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    await assert.rejects(
      () => persistStockPreparationSyncRun({
        permission: 'admin',
        recordsApi,
        provisioning,
        ...basePlanInputs({ sourceProjectNo: undefined }),
      }),
      (error) =>
        error instanceof StockPreparationSyncRunPersistError &&
        error.status === 422 &&
        error.code === 'PERSIST_CONFIG_INVALID' &&
        error.details.field === 'sourceProjectNo',
    )
    assert.equal(provisioning.findObjectSheetCalls, 0, 'fails before any sheet resolution')
    assert.equal(recordsApi.createCalls.length, 0)
  })

  // ── H-2 (P4 lock round-1): replay verifies the project LIVE POINTER, not just row existence ──────

  await run('H-2: CW4-existing crash (run created, project patch lost) -> replay 409 stale_pointer, not silent 200', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    // Sync 1 commits fully: project pointer -> run_1 (batch_1, version 1).
    await persistStockPreparationSyncRun({ permission: 'admin', recordsApi, provisioning, ...basePlanInputs() })
    // Sync 2 (batch_2, version 2) crashes at the CW4-existing window: every batch/line/run write lands,
    // the project PATCH is lost. Injected by failing patchRecord on the PROJECT sheet only.
    const crashingApi = Object.create(recordsApi)
    crashingApi.patchRecord = async (input = {}) => {
      if (input.sheetId === PROJECT_SHEET_ID) throw new Error('injected crash before project patch')
      return recordsApi.patchRecord(input)
    }
    await assert.rejects(
      () => persistStockPreparationSyncRun({
        permission: 'admin',
        recordsApi: crashingApi,
        provisioning,
        ...basePlanInputs({ syncRunId: 'run_2', snapshotBatchId: 'batch_2', snapshotVersion: 2 }),
      }),
      /injected crash before project patch/,
    )
    // Retry of sync 2 replays batch/lines/run exactly — but the pointer still names run_1 whose batch
    // sits at a LOWER version. Pre-H-2 this returned 200 skipped_existing (the silent window).
    await assert.rejects(
      () => persistStockPreparationSyncRun({
        permission: 'admin',
        recordsApi,
        provisioning,
        ...basePlanInputs({ syncRunId: 'run_2', snapshotBatchId: 'batch_2', snapshotVersion: 2 }),
      }),
      (error) =>
        error instanceof StockPreparationSyncRunPersistError &&
        error.status === 409 &&
        error.code === 'PERSIST_PROJECT_POINTER_STALE' &&
        error.details.target === 'project' &&
        error.details.reason === 'stale_pointer',
    )
  })

  await run('H-2: pointer advanced by a LATER sync -> replaying the older batch still returns 200 skipped_existing', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    await persistStockPreparationSyncRun({ permission: 'admin', recordsApi, provisioning, ...basePlanInputs() })
    await persistStockPreparationSyncRun({
      permission: 'admin',
      recordsApi,
      provisioning,
      ...basePlanInputs({ syncRunId: 'run_2', snapshotBatchId: 'batch_2', snapshotVersion: 2 }),
    })
    // Pointer now names run_2 (version 2). Replaying sync 1 must remain a legal exact replay.
    const replay = await persistStockPreparationSyncRun({ permission: 'admin', recordsApi, provisioning, ...basePlanInputs() })
    assert.equal(replay.mode, 'skipped_existing')
    assert.equal(replay.persisted, false)
  })

  await run('H-2: pointer naming a run with no batch row -> 409 pointer_unresolvable (fail closed)', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    await persistStockPreparationSyncRun({ permission: 'admin', recordsApi, provisioning, ...basePlanInputs() })
    // Corrupt the pointer to a run id no batch row carries (raw physical patch, as a poisoned/legacy
    // row would look).
    const projectRows = await recordsApi.queryRecords({
      sheetId: PROJECT_SHEET_ID,
      filters: { [physicalFieldId(STAGING_PROJECT_ID, PROJECT_OBJECT_ID, PROJECT_KEY_FIELD)]: 'proj_1' },
    })
    assert.equal(projectRows.length, 1)
    await recordsApi.patchRecord({
      sheetId: PROJECT_SHEET_ID,
      recordId: projectRows[0].id,
      changes: { [physicalFieldId(STAGING_PROJECT_ID, PROJECT_OBJECT_ID, 'lastSyncRunId')]: 'run_ghost' },
    })
    await assert.rejects(
      () => persistStockPreparationSyncRun({ permission: 'admin', recordsApi, provisioning, ...basePlanInputs() }),
      (error) =>
        error instanceof StockPreparationSyncRunPersistError &&
        error.status === 409 &&
        error.code === 'PERSIST_PROJECT_POINTER_STALE' &&
        error.details.target === 'project' &&
        error.details.reason === 'pointer_unresolvable',
    )
  })

  // ── H-3 (P4 lock round-1: Option-A prerequisite): explicit plan-size bound ──────────────────────

  await run('H-3: plan larger than PERSIST_MAX_PLAN_LINES -> 422 PERSIST_PLAN_TOO_LARGE before ANY provisioning/records access', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    await assert.rejects(
      () => persistStockPreparationSyncRun({
        permission: 'admin',
        recordsApi,
        provisioning,
        ...basePlanInputs({ expansionResult: manyExpansionRows(PERSIST_MAX_PLAN_LINES + 1) }),
      }),
      (error) =>
        error instanceof StockPreparationSyncRunPersistError &&
        error.status === 422 &&
        error.code === 'PERSIST_PLAN_TOO_LARGE' &&
        error.details.field === 'snapshotLines' &&
        error.details.maxLines === PERSIST_MAX_PLAN_LINES,
    )
    assert.equal(provisioning.findObjectSheetCalls, 0, 'rejected before sheet resolution')
    assert.equal(recordsApi.createCalls.length, 0, 'rejected before any write')
  })

  await run('H-2 precondition: a repeat sync with a non-increasing snapshotVersion (incl. the default) -> 422 PERSIST_VERSION_NOT_MONOTONIC before any write', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    await persistStockPreparationSyncRun({ permission: 'admin', recordsApi, provisioning, ...basePlanInputs() })
    const writesAfterFirst = recordsApi.createCalls.length
    for (const overrides of [
      { syncRunId: 'run_2', snapshotBatchId: 'batch_2' }, // omitted -> defaults to 1 == pointer version
      { syncRunId: 'run_2', snapshotBatchId: 'batch_2', snapshotVersion: 1 },
      { syncRunId: 'run_2', snapshotBatchId: 'batch_2', snapshotVersion: 0 },
    ]) {
      await assert.rejects(
        () => persistStockPreparationSyncRun({ permission: 'admin', recordsApi, provisioning, ...basePlanInputs(overrides) }),
        (error) =>
          error instanceof StockPreparationSyncRunPersistError &&
          error.status === 422 &&
          error.code === 'PERSIST_VERSION_NOT_MONOTONIC' &&
          error.details.field === 'snapshotVersion' &&
          error.details.reason === 'not_monotonic',
      )
    }
    assert.equal(recordsApi.createCalls.length, writesAfterFirst, 'rejected before any write')
  })

  await run('H-2: equal-version pointer on a DIFFERENT run (legacy/degenerate data) -> 409 pointer_unresolvable, never a silent 200', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    await persistStockPreparationSyncRun({ permission: 'admin', recordsApi, provisioning, ...basePlanInputs() })
    await persistStockPreparationSyncRun({
      permission: 'admin',
      recordsApi,
      provisioning,
      ...basePlanInputs({ syncRunId: 'run_2', snapshotBatchId: 'batch_2', snapshotVersion: 2 }),
    })
    // Simulate legacy degenerate data: flatten batch_2's version back to 1 (equal to batch_1) via a
    // raw physical patch — the monotonic create guard makes this state unreachable going forward.
    const batchRows = await recordsApi.queryRecords({
      sheetId: BATCH_SHEET_ID,
      filters: { [physicalFieldId(STAGING_PROJECT_ID, BATCH_OBJECT_ID, 'snapshotBatchId')]: 'batch_2' },
    })
    assert.equal(batchRows.length, 1)
    await recordsApi.patchRecord({
      sheetId: BATCH_SHEET_ID,
      recordId: batchRows[0].id,
      changes: { [physicalFieldId(STAGING_PROJECT_ID, BATCH_OBJECT_ID, 'snapshotVersion')]: 1 },
    })
    // Replaying batch_1 now sees pointer=run_2 whose batch version EQUALS its own — not provably
    // advanced -> fail closed.
    await assert.rejects(
      () => persistStockPreparationSyncRun({ permission: 'admin', recordsApi, provisioning, ...basePlanInputs() }),
      (error) =>
        error instanceof StockPreparationSyncRunPersistError &&
        error.status === 409 &&
        error.code === 'PERSIST_PROJECT_POINTER_STALE' &&
        error.details.reason === 'pointer_unresolvable',
    )
  })

  await run('H-3: create AND exact replay both succeed at the true bound (PERSIST_MAX_PLAN_LINES lines)', async () => {
    // Paginated fake: the replay path's bounded read must see REAL limit/offset pages (the plain fake
    // returns everything in one oversized page and would false-trip the page-size guard).
    const recordsApi = makePaginatedRecordsApi()
    const provisioning = makeProvisioning()
    const inputs = basePlanInputs({ expansionResult: manyExpansionRows(PERSIST_MAX_PLAN_LINES) })
    const first = await persistStockPreparationSyncRun({ permission: 'admin', recordsApi, provisioning, ...inputs })
    assert.equal(first.mode, 'created')
    assert.equal(first.created.lines, PERSIST_MAX_PLAN_LINES)
    // The bound is defined as the largest EXACTLY-REPLAYABLE plan (short-page provability): the
    // retry must be a clean 200 skip, never PERSIST_EXISTING_BATCH_READ_UNPROVABLE (round-2 finding:
    // at 25,000 the create succeeded and every replay 409'd forever).
    const replay = await persistStockPreparationSyncRun({ permission: 'admin', recordsApi, provisioning, ...inputs })
    assert.equal(replay.mode, 'skipped_existing')
  })

  await run('H-3: plan at EXACTLY the bound passes the cap (fails later on unprovisioned target, proving the cap did not fire)', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning({ missing: new Set([BATCH_OBJECT_ID]) })
    await assert.rejects(
      () => persistStockPreparationSyncRun({
        permission: 'admin',
        recordsApi,
        provisioning,
        ...basePlanInputs({ expansionResult: manyExpansionRows(PERSIST_MAX_PLAN_LINES) }),
      }),
      (error) =>
        error instanceof StockPreparationSyncRunPersistError &&
        error.code === 'PERSIST_TARGET_NOT_PROVISIONED',
    )
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
