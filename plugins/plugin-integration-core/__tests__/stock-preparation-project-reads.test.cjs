'use strict'

// #4163 audit gap T1 — READONLY, values-free PROJECT list tests (backs FE view 1, the project
// workspace / selector). Locks:
//   - the values-free contract shape (projectId handle + closed projectStatus enum + lastSyncRunId
//     handle + per-project counts), matching apps/web's StockPreparationProjectSummary type;
//   - VALUES-FREE HARD BOUNDARY: a planted `sourceProjectNo` / `projectName` on the stored row NEVER
//     crosses into the response, even though the row legitimately carries them internally;
//   - unknown/junk projectStatus folds to 'unknown' (never the raw junk string);
//   - read-gated (permission MUST be the literal 'read', not 'admin' — this route is deliberately
//     broader than the rest of the stock-preparation module) — 403 before any read;
//   - READONLY: createRecord/patchRecord/deleteRecord are NEVER called;
//   - empty / unprovisioned project sheet => the zero shape, not an error.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  listStockPreparationProjects,
  StockPreparationProjectReadsError,
  PROJECT_OBJECT_ID,
  BATCH_OBJECT_ID,
  EXCEPTION_OBJECT_ID,
  PREP_LINE_OBJECT_ID,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-project-reads.cjs'))
const {
  assertKnownFieldIds,
  physicalRow,
  resolveFieldIdsFor,
} = require(path.join(__dirname, 'fixtures', 'stock-preparation-multitable-fakes.cjs'))

const STAGING_PROJECT = 'tenant_1:integration-core'

const SHEET_IDS = {
  [PROJECT_OBJECT_ID]: 'sheet_project',
  [BATCH_OBJECT_ID]: 'sheet_batch',
  [EXCEPTION_OBJECT_ID]: 'sheet_exc',
  [PREP_LINE_OBJECT_ID]: 'sheet_prepline',
}
const ALL_OBJECT_IDS = Object.keys(SHEET_IDS)
const OBJECT_ID_BY_SHEET_ID = Object.fromEntries(Object.entries(SHEET_IDS).map(([objectId, sheetId]) => [sheetId, objectId]))

// A token planted into leaky VALUE fields (sourceProjectNo / projectName) that MUST NEVER reach the
// returned response — the values-free hard boundary this route exists to enforce.
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

function rowData(row) {
  if (row && typeof row.data === 'object' && row.data && !Array.isArray(row.data)) return row.data
  return row || {}
}

// #4160 — STRICT records API (mirrors stock-preparation-snapshot-reads.test.cjs): fixtures are written
// in LOGICAL keys (human-readable), but the substrate stores + returns PHYSICAL fieldIds and rejects any
// filter key that is not one. Write methods exist ONLY to prove they are never called (readonly).
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
    createRecord() { calls.push(['createRecord']); throw new Error('createRecord must never be called (readonly)') },
    patchRecord() { calls.push(['patchRecord']); throw new Error('patchRecord must never be called (readonly)') },
    deleteRecord() { calls.push(['deleteRecord']); throw new Error('deleteRecord must never be called (readonly)') },
  }
}

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

// Two projects: proj-alpha (rich: batches + open/resolved exceptions + draft/held prep lines) and
// proj-beta (bare: only the project row itself, no children anywhere — every count must be 0, not an
// error). proj-alpha also carries a PLANTED sourceProjectNo/projectName that must never cross.
function fullFixture() {
  return {
    [SHEET_IDS[PROJECT_OBJECT_ID]]: [
      {
        projectId: 'proj-alpha',
        sourceProjectNo: `SRC-${SECRET}`,
        projectName: `涡轮增压器总成-${SECRET}`,
        sourceSystem: 'plm_sync',
        projectStatus: 'active',
        lastSyncRunId: 'run-alpha-2',
        lastSyncedAt: '2026-07-11T00:00:00Z',
        owner: 'alice',
      },
      {
        projectId: 'proj-beta',
        sourceProjectNo: 'SRC-BETA',
        projectStatus: 'junk_status_never_seen_before',
        lastSyncRunId: 'run-beta-1',
      },
    ],
    [SHEET_IDS[BATCH_OBJECT_ID]]: [
      { snapshotBatchId: 'b1', projectId: 'proj-alpha', snapshotVersion: 1 },
      { snapshotBatchId: 'b2', projectId: 'proj-alpha', snapshotVersion: 2 },
    ],
    [SHEET_IDS[EXCEPTION_OBJECT_ID]]: [
      { exceptionId: 'e1', projectId: 'proj-alpha', status: 'open', exceptionType: 'missing_mapping' },
      { exceptionId: 'e2', projectId: 'proj-alpha', status: 'resolved', exceptionType: 'unit_conflict' },
    ],
    [SHEET_IDS[PREP_LINE_OBJECT_ID]]: [
      { stockPrepLineId: 'p1', projectId: 'proj-alpha', prepStatus: 'held' },
      { stockPrepLineId: 'p2', projectId: 'proj-alpha', prepStatus: 'draft' },
      { stockPrepLineId: 'p3', projectId: 'proj-alpha', prepStatus: 'draft' },
    ],
  }
}

async function main() {
  // ---- happy path: values-free contract shape + correct per-project counts ----
  await run('list returns the values-free contract shape with correct per-project counts', async () => {
    const recordsApi = makeRecordsApi(fullFixture())
    const provisioning = makeProvisioning()
    const result = await listStockPreparationProjects({
      recordsApi,
      provisioning,
      targetProjectId: STAGING_PROJECT,
      permission: 'read',
    })

    assert.equal(result.projectCount, 2)
    const byId = new Map(result.projects.map((project) => [project.projectId, project]))

    const alpha = byId.get('proj-alpha')
    assert.ok(alpha, 'proj-alpha present')
    // Exact contract keys — matches apps/web StockPreparationProjectSummary 1:1, no extras.
    assert.deepEqual(
      Object.keys(alpha).sort(),
      ['heldLineCount', 'lastSyncRunId', 'openExceptionCount', 'projectId', 'projectStatus', 'readyLineCount', 'snapshotBatchCount'].sort(),
    )
    assert.equal(alpha.projectStatus, 'active')
    assert.equal(alpha.lastSyncRunId, 'run-alpha-2')
    assert.equal(alpha.snapshotBatchCount, 2)
    assert.equal(alpha.openExceptionCount, 1, 'only the OPEN exception counts')
    assert.equal(alpha.heldLineCount, 1)
    assert.equal(alpha.readyLineCount, 2, 'the two draft lines map to ready')

    const beta = byId.get('proj-beta')
    assert.ok(beta, 'proj-beta present (bare project, zero children)')
    assert.equal(beta.snapshotBatchCount, 0)
    assert.equal(beta.openExceptionCount, 0)
    assert.equal(beta.heldLineCount, 0)
    assert.equal(beta.readyLineCount, 0)
    assert.equal(beta.lastSyncRunId, 'run-beta-1')
    // Junk stored projectStatus folds to 'unknown' — the junk string itself never crosses.
    assert.equal(beta.projectStatus, 'unknown')

    // statusCounts zero-fills the known vocabulary + counts junk as 'unknown'.
    assert.equal(result.statusCounts.active, 1)
    assert.equal(result.statusCounts.unknown, 1)

    // READONLY: only queryRecords ever hit the records api.
    assert.ok(recordsApi.calls.every((call) => call[0] === 'queryRecords'), 'no write method called')
  })

  // ---- VALUES-FREE HARD BOUNDARY: sourceProjectNo / projectName never cross ----
  await run('values-free: a planted sourceProjectNo/projectName never reaches the response', async () => {
    const recordsApi = makeRecordsApi(fullFixture())
    const provisioning = makeProvisioning()
    const result = await listStockPreparationProjects({
      recordsApi,
      provisioning,
      targetProjectId: STAGING_PROJECT,
      permission: 'read',
    })
    const resultJson = JSON.stringify(result)
    assert.equal(resultJson.includes(SECRET), false, 'the planted secret token never crosses')
    assert.equal(resultJson.includes('sourceProjectNo'), false, 'the field NAME itself never crosses either')
    assert.equal(resultJson.includes('projectName'), false)
    assert.equal(resultJson.includes('owner'), false, 'human_preserved owner annotation never crosses')
  })

  // ---- empty / unprovisioned project sheet -> zero shape, not an error ----
  await run('unprovisioned project sheet degrades to the zero shape', async () => {
    const recordsApi = makeRecordsApi({})
    const provisioning = makeProvisioning({ present: [] })
    const result = await listStockPreparationProjects({
      recordsApi,
      provisioning,
      targetProjectId: STAGING_PROJECT,
      permission: 'read',
    })
    assert.equal(result.projectCount, 0)
    assert.deepEqual(result.projects, [])
  })

  // ---- read-gated: permission MUST be the literal 'read' — 403 before any read ----
  await run('non-read permission (including admin) throws 403 before any provisioning/records access', async () => {
    for (const permission of ['admin', 'write', undefined, null, '']) {
      const recordsApi = makeRecordsApi(fullFixture())
      const provisioning = makeProvisioning()
      await assert.rejects(
        () => listStockPreparationProjects({ recordsApi, provisioning, targetProjectId: STAGING_PROJECT, permission }),
        (error) =>
          error instanceof StockPreparationProjectReadsError &&
          error.status === 403 &&
          error.code === 'PROJECT_READS_PERMISSION_DENIED',
        `permission ${String(permission)} denied`,
      )
      assert.equal(provisioning.calls.length, 0, 'gate runs before provisioning')
      assert.equal(recordsApi.calls.length, 0)
    }
  })

  // ---- targetProjectId required ----
  await run('targetProjectId is required', async () => {
    await assert.rejects(
      () => listStockPreparationProjects({ recordsApi: makeRecordsApi(), provisioning: makeProvisioning(), permission: 'read' }),
      (error) => error instanceof StockPreparationProjectReadsError && error.status === 422 && error.code === 'PROJECT_READS_CONFIG_INVALID',
    )
  })

  console.log(`\nstock-preparation-project-reads.test.cjs: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    for (const { name } of failures) console.error(`  - ${name}`)
    process.exit(1)
  }
  console.log('stock-preparation-project-reads.test.cjs OK')
}

main().catch((error) => {
  console.error('stock-preparation-project-reads.test.cjs FAILED')
  console.error(error)
  process.exit(1)
})
