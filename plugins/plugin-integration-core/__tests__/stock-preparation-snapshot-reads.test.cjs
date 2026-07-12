'use strict'

// #3751 stock-prep MVP view 2 — READONLY snapshot-batch LIST + DIFF read endpoints tests.
// Locks the queryRecords-only reads that back the FE "BOM Snapshot Batch & Diff" view. Covers:
//   - list returns the values-free contract shape with the correct lineCount per batch;
//   - empty / unprovisioned batch sheet => batchCount 0;
//   - diff picks the correct predecessor by snapshotVersion and maps byChangeType -> changeCounts;
//   - diff with no predecessor => baseSnapshotBatchId null + counts-vs-empty (all current = added);
//   - blockingExceptionCount = exception rows (linked to the batch) with severity 'blocking';
//   - PROJECT-SCOPE SPLIT: findObjectSheet uses the STAGING targetProjectId (business project => null),
//     so using the business project as the locator finds nothing (kills a revert of the split);
//   - COMPLETENESS: a batch with a row but zero lines OR a missing run row => incomplete:true;
//   - admin-denied => 403 before any read (fail closed);
//   - READONLY: createRecord/patchRecord/deleteRecord are NEVER called;
//   - values-free: a planted drawing number / quantity / exception message never reaches a summary.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  listSnapshotBatches,
  getSnapshotDiff,
  listSnapshotDiffRows,
  BATCH_OBJECT_ID,
  LINE_OBJECT_ID,
  RUN_OBJECT_ID,
  EXCEPTION_OBJECT_ID,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-snapshot-reads.cjs'))
const {
  StockPreparationTargetProvisioningError,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-target-provisioning.cjs'))
const {
  assertKnownFieldIds,
  physicalRow,
  resolveFieldIdsFor,
} = require(path.join(__dirname, 'fixtures', 'stock-preparation-multitable-fakes.cjs'))

const STAGING_PROJECT = 'tenant_1:integration-core'
const BUSINESS_PROJECT = 'PROJ-42'
const OTHER_PROJECT = 'PROJ-OTHER'

const SHEET_IDS = {
  [BATCH_OBJECT_ID]: 'sheet_batch',
  [LINE_OBJECT_ID]: 'sheet_line',
  [RUN_OBJECT_ID]: 'sheet_run',
  [EXCEPTION_OBJECT_ID]: 'sheet_exc',
}
const ALL_OBJECT_IDS = Object.keys(SHEET_IDS)

// A token planted into leaky VALUE fields (drawing number / unit / fingerprint / exception message)
// that MUST NEVER reach a returned summary (the summaries are values-free).
const SECRET = 'SECRET_XYZ_9d1f'

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

// Records may be flat or { data: {...} }; the fake unwraps to mirror the module + a real records api.
function rowData(row) {
  if (row && typeof row.data === 'object' && row.data && !Array.isArray(row.data)) return row.data
  return row || {}
}

const OBJECT_ID_BY_SHEET_ID = Object.fromEntries(Object.entries(SHEET_IDS).map(([objectId, sheetId]) => [sheetId, objectId]))

// #4160 — STRICT records API. The fixtures below are written in LOGICAL keys because that is what a
// human can read, but the substrate STORES (and returns) PHYSICAL fieldIds, and it rejects any filter
// key that is not one — exactly as the real query-service does (`Unknown fieldId: X`). A read module
// that filters by a logical key therefore FAILS here instead of quietly returning nothing, and one
// that reads a physical-keyed row by logical key sees undefined instead of the value.
function makeRecordsApi(rowsBySheet = {}) {
  const calls = []
  const stored = {}
  for (const [sheetId, rows] of Object.entries(rowsBySheet)) {
    const objectId = OBJECT_ID_BY_SHEET_ID[sheetId]
    stored[sheetId] = rows.map((row, index) => physicalRow(STAGING_PROJECT, objectId, rowData(row), `rec_${sheetId}_${index}`))
  }
  return {
    calls,
    async queryRecords({ sheetId, filters = {}, limit, offset = 0 } = {}) {
      calls.push(['queryRecords', { sheetId, filters: { ...filters }, limit, offset }])
      assertKnownFieldIds(STAGING_PROJECT, OBJECT_ID_BY_SHEET_ID[sheetId], Object.keys(filters))
      const matched = (stored[sheetId] || []).filter((row) =>
        Object.entries(filters).every(([key, value]) => row.data[key] === value))
      const start = offset || 0
      const end = typeof limit === 'number' ? start + limit : matched.length
      return matched.slice(start, end).map((row) => ({ ...row, data: { ...row.data } }))
    },
    // Write methods exist only to PROVE they are never called (readonly): any call throws + is recorded.
    createRecord() { calls.push(['createRecord']); throw new Error('createRecord must never be called (readonly)') },
    patchRecord() { calls.push(['patchRecord']); throw new Error('patchRecord must never be called (readonly)') },
    deleteRecord() { calls.push(['deleteRecord']); throw new Error('deleteRecord must never be called (readonly)') },
  }
}

// KILLER for the project-scope split: sheets resolve ONLY under the STAGING project; the business
// project (or any non-staging id) returns null. A mutation that located sheets by the business project
// would get null here and the list/diff would go empty, failing the assertions below.
// resolveFieldIds (#4160) mirrors the platform derivation — and is scoped the same way.
function makeProvisioning({ staging = STAGING_PROJECT, present = ALL_OBJECT_IDS } = {}) {
  const calls = []
  return {
    calls,
    async findObjectSheet({ projectId, objectId } = {}) {
      calls.push(['findObjectSheet', { projectId, objectId }])
      if (projectId !== staging) return null
      if (!present.includes(objectId)) return null
      return { id: SHEET_IDS[objectId] }
    },
    async resolveFieldIds({ projectId, objectId, fieldIds } = {}) {
      calls.push(['resolveFieldIds', { projectId, objectId }])
      return resolveFieldIdsFor(projectId, objectId, fieldIds)
    },
  }
}

// A rich fixture: batches b1(v1)..b4(v4) for BUSINESS_PROJECT + one bX for OTHER_PROJECT.
//   b1: 2 lines + run  -> complete
//   b2: 2 lines + run  -> complete (diff target; predecessor = b1)
//   b3: 0 lines, no run -> incomplete (both signals fail)
//   b4: 1 line, no run  -> incomplete (run missing despite lines)
function fullFixture() {
  return {
    [SHEET_IDS[BATCH_OBJECT_ID]]: [
      { snapshotBatchId: 'b1', projectId: BUSINESS_PROJECT, snapshotVersion: 1, snapshotStatus: 'superseded', syncRunId: 'run1', createdAt: '2026-07-01T00:00:00Z' },
      { snapshotBatchId: 'b2', projectId: BUSINESS_PROJECT, snapshotVersion: 2, snapshotStatus: 'active', syncRunId: 'run2', createdAt: '2026-07-02T00:00:00Z' },
      { snapshotBatchId: 'b3', projectId: BUSINESS_PROJECT, snapshotVersion: 3, snapshotStatus: 'draft', syncRunId: 'run3' },
      { snapshotBatchId: 'b4', projectId: BUSINESS_PROJECT, snapshotVersion: 4, snapshotStatus: 'draft', syncRunId: 'run4', createdAt: '2026-07-04T00:00:00Z' },
      { snapshotBatchId: 'bX', projectId: OTHER_PROJECT, snapshotVersion: 9, snapshotStatus: 'active', syncRunId: 'runX', createdAt: '2026-07-09T00:00:00Z' },
    ],
    [SHEET_IDS[LINE_OBJECT_ID]]: [
      // b1 lines
      { snapshotLineId: 'l1', snapshotBatchId: 'b1', childDrawingNo: 'DRW-A', childVersion: 'V1', pathKey: '/root/A', designQty: 2, designUnit: 'pcs', sourceFingerprint: 'fpA1' },
      { snapshotLineId: 'l2', snapshotBatchId: 'b1', childDrawingNo: 'DRW-B', childVersion: 'V1', pathKey: '/root/B', designQty: 5, designUnit: 'pcs', sourceFingerprint: 'fpB1' },
      // b2 lines: /root/A qty 2->4 (quantity_changed); /root/B removed; /root/C added
      { snapshotLineId: 'l3', snapshotBatchId: 'b2', childDrawingNo: 'DRW-A', childVersion: 'V1', pathKey: '/root/A', designQty: 4, designUnit: 'pcs', sourceFingerprint: 'fpA1' },
      { snapshotLineId: 'l4', snapshotBatchId: 'b2', childDrawingNo: 'DRW-C', childVersion: 'V1', pathKey: '/root/C', designQty: 7, designUnit: 'pcs', sourceFingerprint: 'fpC2' },
      // b4 has one line (but no run row => incomplete)
      { snapshotLineId: 'l5', snapshotBatchId: 'b4', childDrawingNo: 'DRW-D', childVersion: 'V1', pathKey: '/root/D', designQty: 1, designUnit: 'pcs', sourceFingerprint: 'fpD1' },
    ],
    [SHEET_IDS[RUN_OBJECT_ID]]: [
      { runId: 'run1', runType: 'plm_sync', status: 'succeeded', startedAt: '2026-07-01T00:00:00Z' },
      { runId: 'run2', runType: 'plm_sync', status: 'succeeded', startedAt: '2026-07-02T00:00:00Z' },
      // NO run3 / run4 rows on purpose -> b3, b4 incomplete.
    ],
    [SHEET_IDS[EXCEPTION_OBJECT_ID]]: [
      { exceptionId: 'e1', projectId: BUSINESS_PROJECT, snapshotBatchId: 'b2', exceptionType: 'unit_conflict', severity: 'blocking', status: 'open', message: 'blocked A' },
      { exceptionId: 'e2', projectId: BUSINESS_PROJECT, snapshotBatchId: 'b2', exceptionType: 'unit_conflict', severity: 'warning', status: 'open', message: 'warn A' },
      { exceptionId: 'e3', projectId: BUSINESS_PROJECT, snapshotBatchId: 'b2', exceptionType: 'mapping_missing', severity: 'blocking', status: 'resolved', message: 'blocked C' },
    ],
  }
}

async function main() {
  // ---- LIST: contract shape + per-batch lineCount + completeness + project filter ----
  await run('list returns the contract shape with correct lineCount + incomplete per batch', async () => {
    const recordsApi = makeRecordsApi(fullFixture())
    const provisioning = makeProvisioning()
    const result = await listSnapshotBatches({
      recordsApi,
      provisioning,
      targetProjectId: STAGING_PROJECT,
      businessProjectId: BUSINESS_PROJECT,
      permission: 'admin',
    })
    assert.equal(result.projectId, BUSINESS_PROJECT, 'echoes the business project')
    assert.equal(result.batchCount, 4, 'bX (OTHER project) is filtered out')
    assert.equal(result.batches.length, 4)
    // Newest-first ordering by snapshotVersion.
    assert.deepEqual(result.batches.map((b) => b.snapshotBatchId), ['b4', 'b3', 'b2', 'b1'])
    const byId = new Map(result.batches.map((b) => [b.snapshotBatchId, b]))
    // Exact contract keys, no extras beyond the completeness addition.
    assert.deepEqual(
      Object.keys(byId.get('b1')).sort(),
      ['createdAtPresent', 'incomplete', 'lineCount', 'snapshotBatchId', 'snapshotStatus', 'snapshotVersion', 'syncRunId'],
    )
    assert.equal(byId.get('b1').lineCount, 2)
    assert.equal(byId.get('b2').lineCount, 2)
    assert.equal(byId.get('b3').lineCount, 0)
    assert.equal(byId.get('b4').lineCount, 1)
    // completeness: b1/b2 complete; b3 (0 lines + no run), b4 (lines but no run) incomplete.
    assert.equal(byId.get('b1').incomplete, false)
    assert.equal(byId.get('b2').incomplete, false)
    assert.equal(byId.get('b3').incomplete, true)
    assert.equal(byId.get('b4').incomplete, true)
    // values-free field shapes
    assert.equal(byId.get('b2').snapshotStatus, 'active')
    assert.equal(byId.get('b2').snapshotVersion, 2)
    assert.equal(byId.get('b2').syncRunId, 'run2')
    assert.equal(byId.get('b1').createdAtPresent, true)
    assert.equal(byId.get('b3').createdAtPresent, false, 'createdAtPresent is presence, not a value')
    // READONLY: only queryRecords ever hit the records api.
    assert.ok(recordsApi.calls.every((c) => c[0] === 'queryRecords'), 'no write method called')
  })

  // ---- LIST: reads { data: {...} }-wrapped records too ----
  await run('list unwraps { data } record envelopes', async () => {
    const rows = {
      [SHEET_IDS[BATCH_OBJECT_ID]]: [
        { data: { snapshotBatchId: 'w1', projectId: BUSINESS_PROJECT, snapshotVersion: 1, snapshotStatus: 'active', syncRunId: 'wr1', createdAt: 'x' } },
      ],
      [SHEET_IDS[LINE_OBJECT_ID]]: [
        { data: { snapshotLineId: 'wl1', snapshotBatchId: 'w1', pathKey: '/root/W', designQty: 1 } },
      ],
      [SHEET_IDS[RUN_OBJECT_ID]]: [{ data: { runId: 'wr1', runType: 'plm_sync', status: 'succeeded', startedAt: 'x' } }],
      [SHEET_IDS[EXCEPTION_OBJECT_ID]]: [],
    }
    const result = await listSnapshotBatches({
      recordsApi: makeRecordsApi(rows),
      provisioning: makeProvisioning(),
      targetProjectId: STAGING_PROJECT,
      businessProjectId: BUSINESS_PROJECT,
      permission: 'admin',
    })
    assert.equal(result.batchCount, 1)
    assert.equal(result.batches[0].snapshotBatchId, 'w1')
    assert.equal(result.batches[0].lineCount, 1)
    assert.equal(result.batches[0].incomplete, false)
  })

  // ---- LIST: empty / unprovisioned batch sheet ----
  await run('list on an unprovisioned batch sheet => batchCount 0', async () => {
    const recordsApi = makeRecordsApi(fullFixture())
    const result = await listSnapshotBatches({
      recordsApi,
      // batch object not provisioned yet
      provisioning: makeProvisioning({ present: [LINE_OBJECT_ID, RUN_OBJECT_ID, EXCEPTION_OBJECT_ID] }),
      targetProjectId: STAGING_PROJECT,
      businessProjectId: BUSINESS_PROJECT,
      permission: 'admin',
    })
    assert.deepEqual(result, { projectId: BUSINESS_PROJECT, batchCount: 0, batches: [] })
    assert.equal(recordsApi.calls.length, 0, 'no queryRecords when the batch sheet is absent')
  })

  // ---- PROJECT-SCOPE SPLIT: business project as the locator finds nothing ----
  await run('using the business project as the sheet locator finds no tables (split matters)', async () => {
    const recordsApi = makeRecordsApi(fullFixture())
    const result = await listSnapshotBatches({
      recordsApi,
      provisioning: makeProvisioning(),
      // BUG SIMULATION: pass the business project as the locator instead of the staging project.
      targetProjectId: BUSINESS_PROJECT,
      businessProjectId: BUSINESS_PROJECT,
      permission: 'admin',
    })
    assert.equal(result.batchCount, 0, 'sheets are only found under the staging project')
  })

  // ---- DIFF: predecessor by version + byChangeType -> changeCounts + blockingExceptionCount ----
  await run('diff picks the predecessor by snapshotVersion and maps change counts', async () => {
    const recordsApi = makeRecordsApi(fullFixture())
    const result = await getSnapshotDiff({
      recordsApi,
      provisioning: makeProvisioning(),
      targetProjectId: STAGING_PROJECT,
      snapshotBatchId: 'b2',
      permission: 'admin',
    })
    assert.equal(result.snapshotBatchId, 'b2')
    assert.equal(result.baseSnapshotBatchId, 'b1', 'predecessor is the highest version below 2')
    assert.deepEqual(result.changeCounts, {
      added: 1,
      removed: 1,
      quantityChanged: 1,
      unitChanged: 0,
      versionChanged: 0,
      pathChanged: 0,
      missingChildBom: 0,
      fingerprintChanged: 0,
    })
    assert.equal(result.blockingExceptionCount, 2, 'two blocking-severity exceptions (open + resolved)')
    assert.deepEqual(Object.keys(result).sort(), ['baseSnapshotBatchId', 'blockingExceptionCount', 'changeCounts', 'snapshotBatchId'])
    assert.ok(recordsApi.calls.every((c) => c[0] === 'queryRecords'), 'no write method called')
  })

  // ---- DIFF: no predecessor => base null + counts vs empty (all current lines are added) ----
  await run('diff of the earliest batch => baseSnapshotBatchId null + counts vs empty', async () => {
    const result = await getSnapshotDiff({
      recordsApi: makeRecordsApi(fullFixture()),
      provisioning: makeProvisioning(),
      targetProjectId: STAGING_PROJECT,
      snapshotBatchId: 'b1',
      permission: 'admin',
    })
    assert.equal(result.baseSnapshotBatchId, null)
    assert.equal(result.changeCounts.added, 2, 'both b1 lines surface as added vs an empty predecessor')
    assert.equal(result.changeCounts.removed, 0)
    assert.equal(result.changeCounts.quantityChanged, 0)
    assert.equal(result.blockingExceptionCount, 0)
  })

  // ---- ADMIN-GATED (fail closed BEFORE any read) ----
  await run('non-admin permission => 403 before any queryRecords', async () => {
    const recordsApi = makeRecordsApi(fullFixture())
    const provisioning = makeProvisioning()
    await assert.rejects(
      () => listSnapshotBatches({ recordsApi, provisioning, targetProjectId: STAGING_PROJECT, businessProjectId: BUSINESS_PROJECT, permission: 'write' }),
      (error) => error instanceof StockPreparationTargetProvisioningError && error.status === 403,
    )
    await assert.rejects(
      () => getSnapshotDiff({ recordsApi, provisioning, targetProjectId: STAGING_PROJECT, snapshotBatchId: 'b2', permission: 'read' }),
      (error) => error instanceof StockPreparationTargetProvisioningError && error.status === 403,
    )
    assert.equal(recordsApi.calls.length, 0, 'fail closed: no read attempted when denied')
    assert.equal(provisioning.calls.length, 0, 'fail closed: no sheet lookup when denied')
  })

  // ---- READONLY guard: missing queryRecords => 501 ----
  await run('records api without queryRecords => 501', async () => {
    await assert.rejects(
      () => listSnapshotBatches({ recordsApi: {}, provisioning: makeProvisioning(), targetProjectId: STAGING_PROJECT, businessProjectId: BUSINESS_PROJECT, permission: 'admin' }),
      (error) => error instanceof StockPreparationTargetProvisioningError && error.status === 501,
    )
  })

  // ---- VALUES-FREE: planted drawing number / quantity / message never reaches a summary ----
  await run('values-free: planted secrets never leak into list or diff summaries', async () => {
    const rows = {
      [SHEET_IDS[BATCH_OBJECT_ID]]: [
        { snapshotBatchId: 'c1', projectId: BUSINESS_PROJECT, snapshotVersion: 1, snapshotStatus: 'superseded', syncRunId: 'cr1', createdAt: 'x' },
        { snapshotBatchId: 'c2', projectId: BUSINESS_PROJECT, snapshotVersion: 2, snapshotStatus: 'active', syncRunId: 'cr2', createdAt: 'x' },
      ],
      [SHEET_IDS[LINE_OBJECT_ID]]: [
        { snapshotLineId: 'cl1', snapshotBatchId: 'c1', childDrawingNo: `DRW_${SECRET}`, childVersion: 'V1', pathKey: '/root/S', designQty: 999, designUnit: `unit_${SECRET}`, sourceFingerprint: `fp_${SECRET}` },
        { snapshotLineId: 'cl2', snapshotBatchId: 'c2', childDrawingNo: `DRW_${SECRET}`, childVersion: 'V2', pathKey: '/root/S', designQty: 111, designUnit: `unit_${SECRET}`, sourceFingerprint: `fp_${SECRET}_2` },
      ],
      [SHEET_IDS[RUN_OBJECT_ID]]: [
        { runId: 'cr1', runType: 'plm_sync', status: 'succeeded', startedAt: 'x' },
        { runId: 'cr2', runType: 'plm_sync', status: 'succeeded', startedAt: 'x' },
      ],
      [SHEET_IDS[EXCEPTION_OBJECT_ID]]: [
        { exceptionId: 'ce1', projectId: BUSINESS_PROJECT, snapshotBatchId: 'c2', exceptionType: 'unit_conflict', severity: 'blocking', status: 'open', message: `msg_${SECRET}` },
      ],
    }
    const listResult = await listSnapshotBatches({
      recordsApi: makeRecordsApi(rows),
      provisioning: makeProvisioning(),
      targetProjectId: STAGING_PROJECT,
      businessProjectId: BUSINESS_PROJECT,
      permission: 'admin',
    })
    assert.equal(JSON.stringify(listResult).includes(SECRET), false, 'no secret leaked into the list summary')

    const diffResult = await getSnapshotDiff({
      recordsApi: makeRecordsApi(rows),
      provisioning: makeProvisioning(),
      targetProjectId: STAGING_PROJECT,
      snapshotBatchId: 'c2',
      permission: 'admin',
    })
    assert.equal(JSON.stringify(diffResult).includes(SECRET), false, 'no secret leaked into the diff summary')
    assert.equal(diffResult.blockingExceptionCount, 1, 'blocking exception still counted (values-free)')
    // The version/unit change between /root/S c1->c2 still counts, values-free.
    assert.equal(diffResult.baseSnapshotBatchId, 'c1')
    assert.ok(diffResult.changeCounts.versionChanged >= 1)
  })

  // ---- W3a: caller-chosen base pair on the counts diff ----
  await run('diff base-override: valid pair honored; unknown 404; cross-project 409; self 400', async () => {
    const rows = {
      [SHEET_IDS[BATCH_OBJECT_ID]]: [
        { snapshotBatchId: 'b1', projectId: BUSINESS_PROJECT, snapshotVersion: 1, syncRunId: 'r1' },
        { snapshotBatchId: 'b2', projectId: BUSINESS_PROJECT, snapshotVersion: 2, syncRunId: 'r2' },
        { snapshotBatchId: 'b3', projectId: BUSINESS_PROJECT, snapshotVersion: 3, syncRunId: 'r3' },
        { snapshotBatchId: 'bx', projectId: OTHER_PROJECT, snapshotVersion: 1, syncRunId: 'rx' },
      ],
      [SHEET_IDS[LINE_OBJECT_ID]]: [
        { snapshotLineId: 'l1', snapshotBatchId: 'b1', childDrawingNo: 'A', childVersion: 'V1', pathKey: '/root/A', designQty: 1 },
        { snapshotLineId: 'l3', snapshotBatchId: 'b3', childDrawingNo: 'A', childVersion: 'V3', pathKey: '/root/A', designQty: 1 },
      ],
    }
    // Explicit base b1 (predecessor auto-pick would choose b2): version change A V1 -> V3 counts.
    const result = await getSnapshotDiff({
      recordsApi: makeRecordsApi(rows),
      provisioning: makeProvisioning(),
      targetProjectId: STAGING_PROJECT,
      snapshotBatchId: 'b3',
      baseSnapshotBatchId: 'b1',
      permission: 'admin',
    })
    assert.equal(result.baseSnapshotBatchId, 'b1', 'explicit base echoes back')
    assert.ok(result.changeCounts.versionChanged >= 1)
    const expectDiffError = async (base, status, code) => {
      let caught = null
      try {
        await getSnapshotDiff({
          recordsApi: makeRecordsApi(rows),
          provisioning: makeProvisioning(),
          targetProjectId: STAGING_PROJECT,
          snapshotBatchId: 'b3',
          baseSnapshotBatchId: base,
          permission: 'admin',
        })
      } catch (error) {
        caught = error
      }
      assert.ok(caught, `expected error for base ${base}`)
      assert.equal(caught.status, status)
      assert.equal(caught.code, code)
    }
    await expectDiffError('nope', 404, 'SNAPSHOT_DIFF_BASE_NOT_FOUND')
    await expectDiffError('bx', 409, 'SNAPSHOT_DIFF_BASE_PROJECT_MISMATCH')
    await expectDiffError('b3', 400, 'SNAPSHOT_DIFF_BASE_INVALID')
    // P2-A1 (review): a GHOST current batch with a caller-chosen base must fail closed 404 — never
    // skip the project gate and never fabricate an all-removed diff of the base project's rows.
    const expectGhostError = async (fn, base) => {
      let caught = null
      try {
        await fn({
          recordsApi: makeRecordsApi(rows),
          provisioning: makeProvisioning(),
          targetProjectId: STAGING_PROJECT,
          snapshotBatchId: 'ghost_current',
          baseSnapshotBatchId: base,
          permission: 'admin',
        })
      } catch (error) {
        caught = error
      }
      assert.ok(caught, 'ghost current + explicit base must not answer')
      assert.equal(caught.status, 404)
      assert.equal(caught.code, 'SNAPSHOT_DIFF_BASE_NOT_FOUND')
    }
    await expectGhostError(getSnapshotDiff, 'bx')
    await expectGhostError(getSnapshotDiff, 'b1')
    await expectGhostError(listSnapshotDiffRows, 'bx')
    // Predecessor auto-pick path for a ghost current stays the #4002 graceful shape (no throw).
    const ghostAuto = await getSnapshotDiff({
      recordsApi: makeRecordsApi(rows),
      provisioning: makeProvisioning(),
      targetProjectId: STAGING_PROJECT,
      snapshotBatchId: 'ghost_current',
      permission: 'admin',
    })
    assert.equal(ghostAuto.baseSnapshotBatchId, null)
  })

  // ---- W3a: per-row diff browse ----
  await run('diff rows: 11-key whitelist projection, heldRowCount, filters, values-free', async () => {
    const rows = {
      [SHEET_IDS[BATCH_OBJECT_ID]]: [
        { snapshotBatchId: 'd1', projectId: BUSINESS_PROJECT, snapshotVersion: 1, syncRunId: 'r1' },
        { snapshotBatchId: 'd2', projectId: BUSINESS_PROJECT, snapshotVersion: 2, syncRunId: 'r2' },
      ],
      [SHEET_IDS[LINE_OBJECT_ID]]: [
        // unchanged row + version-changed row + added row => mixed ready/held statuses.
        { snapshotLineId: 'p1', snapshotBatchId: 'd1', childDrawingNo: `S_${SECRET}`, childVersion: 'V1', pathKey: '/root/same', designQty: 1, designUnit: `u_${SECRET}` },
        { snapshotLineId: 'p2', snapshotBatchId: 'd1', childDrawingNo: 'B', childVersion: 'V1', pathKey: '/root/B', designQty: 1 },
        { snapshotLineId: 'c1', snapshotBatchId: 'd2', childDrawingNo: `S_${SECRET}`, childVersion: 'V1', pathKey: '/root/same', designQty: 1, designUnit: `u_${SECRET}` },
        { snapshotLineId: 'c2', snapshotBatchId: 'd2', childDrawingNo: 'B', childVersion: 'V2', pathKey: '/root/B', designQty: 1 },
        { snapshotLineId: 'c3', snapshotBatchId: 'd2', childDrawingNo: 'C', childVersion: 'V1', pathKey: '/root/C', designQty: 1 },
      ],
    }
    const DIFF_ROW_KEY_SET = new Set([
      'diffId', 'diffType', 'reviewStatus', 'changeTypes', 'reason', 'rowCount',
      'previousSnapshotLineId', 'currentSnapshotLineId', 'keyFingerprint',
      'previousPathKeyFingerprint', 'currentPathKeyFingerprint',
    ])
    const result = await listSnapshotDiffRows({
      recordsApi: makeRecordsApi(rows),
      provisioning: makeProvisioning(),
      targetProjectId: STAGING_PROJECT,
      snapshotBatchId: 'd2',
      permission: 'admin',
    })
    assert.equal(result.baseSnapshotBatchId, 'd1')
    assert.ok(result.rowCount >= 3, 'unchanged + changed + added rows surface')
    assert.ok(result.heldRowCount >= 2, 'version change + added are held under the all-blocking policy')
    for (const row of result.rows) {
      for (const key of Object.keys(row)) {
        assert.ok(DIFF_ROW_KEY_SET.has(key), `row key ${key} must be whitelisted`)
      }
      assert.ok(row.diffId && row.diffType && row.reviewStatus)
      assert.ok(Array.isArray(row.changeTypes))
    }
    assert.equal(JSON.stringify(result).includes(SECRET), false, 'no secret leaks through a diff row')

    // filters narrow by enum; held filter drops the unchanged row.
    const held = await listSnapshotDiffRows({
      recordsApi: makeRecordsApi(rows),
      provisioning: makeProvisioning(),
      targetProjectId: STAGING_PROJECT,
      snapshotBatchId: 'd2',
      reviewStatus: 'held',
      permission: 'admin',
    })
    assert.equal(held.rowCount, held.rows.length)
    assert.ok(held.rows.every((row) => row.reviewStatus === 'held'))
    assert.ok(held.rowCount < result.rowCount, 'held filter narrows the unchanged row away')
    assert.equal(held.heldRowCount, result.heldRowCount, 'heldRowCount stays pre-filter context')
    const added = await listSnapshotDiffRows({
      recordsApi: makeRecordsApi(rows),
      provisioning: makeProvisioning(),
      targetProjectId: STAGING_PROJECT,
      snapshotBatchId: 'd2',
      diffType: 'added',
      permission: 'admin',
    })
    assert.ok(added.rows.every((row) => row.diffType === 'added'))

    // bogus enum fails closed at the module belt-and-braces gate too.
    let caught = null
    try {
      await listSnapshotDiffRows({
        recordsApi: makeRecordsApi(rows),
        provisioning: makeProvisioning(),
        targetProjectId: STAGING_PROJECT,
        snapshotBatchId: 'd2',
        reviewStatus: 'bogus',
        permission: 'admin',
      })
    } catch (error) {
      caught = error
    }
    assert.equal(caught && caught.code, 'SNAPSHOT_READS_CONFIG_INVALID')
  })

  await run('diff rows: result row cap fails closed at 2000', async () => {
    const manyLines = []
    for (let index = 0; index < 2001; index += 1) {
      manyLines.push({ snapshotLineId: `m${index}`, snapshotBatchId: 'big1', childDrawingNo: `D${index}`, childVersion: 'V1', pathKey: `/root/D${index}`, designQty: 1 })
    }
    const rows = {
      [SHEET_IDS[BATCH_OBJECT_ID]]: [
        { snapshotBatchId: 'big1', projectId: BUSINESS_PROJECT, snapshotVersion: 1, syncRunId: 'r1' },
      ],
      [SHEET_IDS[LINE_OBJECT_ID]]: manyLines,
    }
    let caught = null
    try {
      await listSnapshotDiffRows({
        recordsApi: makeRecordsApi(rows),
        provisioning: makeProvisioning(),
        targetProjectId: STAGING_PROJECT,
        snapshotBatchId: 'big1',
        permission: 'admin',
      })
    } catch (error) {
      caught = error
    }
    assert.equal(caught && caught.status, 422)
    assert.equal(caught && caught.code, 'SNAPSHOT_READS_ROWS_TOO_LARGE')
  })

  console.log(`\nstock-preparation-snapshot-reads.test.cjs: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    for (const { name } of failures) console.error(`  - ${name}`)
    process.exit(1)
  }
  console.log('stock-preparation-snapshot-reads.test.cjs OK')
}

main().catch((error) => {
  console.error('stock-preparation-snapshot-reads.test.cjs FAILED')
  console.error(error)
  process.exit(1)
})
