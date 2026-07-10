'use strict'

// #3751 stock-prep MVP — readonly BOM-snapshot sync-RUN PLAN orchestrator tests.
// Locks the pure composer that turns an already-produced expansion result (+ optional prior batch)
// into a plan (snapshot batch + lines + sync run + diff + flags) with values-free evidence. It
// PERSISTS NOTHING and has NO external write path. Covers: happy-path shaping (batch/lines/run,
// snapshot_status 'draft'); missing_child_bom flag via the mapper's rowError stamping; a diff that
// reaches a change type; prior lines never mutated; duplicate + missing-qty flags surfaced;
// admin-permission-denied (403); and values-free evidence (no leaked projectId / drawing number).

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  planBomSnapshotSyncRun,
  StockPreparationSyncRunPlanError,
  SNAPSHOT_STATUS_DRAFT,
  RUN_TYPE_PLM_SYNC,
  RUN_STATUS_SUCCEEDED,
  RUN_STATUS_PARTIAL,
  DEFAULT_SNAPSHOT_VERSION,
  __internals: { BATCH_FIELD_IDS, RUN_FIELD_IDS },
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-sync-run-plan.cjs'))
const {
  CHANGE_TYPES,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-snapshot-diff.cjs'))

const BATCH_OBJECT_ID = 'plm_stock_preparation_bom_snapshot_batch'
const LINE_OBJECT_ID = 'plm_stock_preparation_bom_snapshot_line'
const RUN_OBJECT_ID = 'plm_stock_preparation_run'

// A leaky project id + drawing number carrying a unique token that MUST NEVER reach evidence.
const SECRET = 'SECRET_XYZ_9d1f'
const LEAKY_PROJECT_ID = `tenant_leaky:proj_${SECRET}`
const LEAKY_DRAWING_NO = `DRW_${SECRET}`

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

// A clean two-row expansion result: distinct paths, positive quantities. With a defaultDesignUnit the
// lines carry every value they need, so no flags surface (the read plan declares no unit field).
function cleanExpansionResult() {
  return [
    { componentSourceId: 'CS1', componentCode: 'A-100', sourceVersion: 'V1', path: '/root/A-100', rawQuantity: 3 },
    { componentSourceId: 'CS2', componentCode: 'B-200', sourceVersion: 'V2', path: '/root/B-200', rawQuantity: 5, parentSourceId: 'CS1' },
  ]
}

function baseInput(overrides = {}) {
  return {
    permission: 'admin',
    projectId: 'proj_1',
    syncRunId: 'run_1',
    snapshotBatchId: 'batch_1',
    defaultDesignUnit: 'pcs',
    expansionResult: cleanExpansionResult(),
    ...overrides,
  }
}

async function main() {
  // ---- happy path: batch + lines + run all shaped; snapshot_status draft; no flags ----
  await run('happy path shapes batch + lines + run with snapshot_status draft and status succeeded', () => {
    const result = planBomSnapshotSyncRun(baseInput())

    // snapshot batch keyed to the batch template's field ids; status draft (never active).
    assert.equal(result.snapshotBatch.snapshotBatchId, 'batch_1')
    assert.equal(result.snapshotBatch.projectId, 'proj_1')
    assert.equal(result.snapshotBatch.syncRunId, 'run_1')
    assert.equal(result.snapshotBatch.snapshotStatus, SNAPSHOT_STATUS_DRAFT)
    assert.equal(result.snapshotBatch.snapshotStatus, 'draft')
    assert.notEqual(result.snapshotBatch.snapshotStatus, 'active')
    assert.equal(result.snapshotBatch.snapshotVersion, DEFAULT_SNAPSHOT_VERSION)
    // every emitted batch-row key is declared by the frozen template (grounding).
    for (const key of Object.keys(result.snapshotBatch)) {
      assert.ok(BATCH_FIELD_IDS.includes(key), `batch field ${key} is template-grounded`)
    }
    // persistence-time who/when stamps are deliberately absent in the pure plan.
    assert.equal('createdAt' in result.snapshotBatch, false)
    assert.equal('createdBy' in result.snapshotBatch, false)

    // snapshot lines: one per expansion row, each with the required line keys.
    assert.equal(result.snapshotLines.length, 2)
    for (const line of result.snapshotLines) {
      assert.equal(typeof line.snapshotLineId, 'string')
      assert.equal(line.snapshotBatchId, 'batch_1')
      assert.equal(typeof line.pathKey, 'string')
    }

    // sync run keyed to the run template; runType plm_sync; status succeeded (no flags).
    assert.equal(result.syncRun.runId, 'run_1')
    assert.equal(result.syncRun.runType, RUN_TYPE_PLM_SYNC)
    assert.equal(result.syncRun.runType, 'plm_sync')
    assert.equal(result.syncRun.status, RUN_STATUS_SUCCEEDED)
    for (const key of Object.keys(result.syncRun)) {
      assert.ok(RUN_FIELD_IDS.includes(key), `run field ${key} is template-grounded`)
    }
    assert.equal('startedAt' in result.syncRun, false)
    // inputShape / resultShape are values-free JSON summary strings.
    const resultShape = JSON.parse(result.syncRun.resultShape)
    assert.equal(resultShape.snapshotLines, 2)
    assert.equal(resultShape.snapshotStatus, 'draft')
    assert.equal(resultShape.diff, null)

    assert.equal(result.diff, null, 'no prior lines => no diff')
    assert.equal(result.flags.hasFlags, false)
    assert.equal(result.evidence.valuesFree, true)
    assert.equal(result.evidence.snapshotBatch.objectId, BATCH_OBJECT_ID)
    assert.equal(result.evidence.snapshotLine.objectId, LINE_OBJECT_ID)
    assert.equal(result.evidence.syncRun.objectId, RUN_OBJECT_ID)
  })

  // ---- caller-supplied snapshot version is honored ----
  await run('caller-supplied snapshotVersion is used instead of the default', () => {
    const result = planBomSnapshotSyncRun(baseInput({ snapshotVersion: 7, sourceSystem: 'plm-main' }))
    assert.equal(result.snapshotBatch.snapshotVersion, 7)
    assert.equal(result.snapshotBatch.sourceSystem, 'plm-main')
    assert.equal(result.evidence.snapshotBatch.snapshotVersionProvided, true)
    assert.equal(result.evidence.snapshotBatch.sourceSystemProvided, true)
  })

  // ---- missing_child_bom flag surfaced via the mapper's rowError stamping ----
  await run('missing_child_bom rowError is stamped into an incomplete line and surfaced as a flag', () => {
    const result = planBomSnapshotSyncRun(baseInput({
      expansionResult: {
        rows: cleanExpansionResult(),
        rowErrors: [{ type: 'missing_child_bom', depth: 2 }],
      },
    }))
    assert.ok(result.flags.missingChildBom >= 1, 'missing_child_bom flag surfaced')
    assert.ok(result.flags.incomplete >= 1, 'the stamped line is incomplete')
    assert.equal(result.flags.hasFlags, true)
    assert.equal(result.syncRun.status, RUN_STATUS_PARTIAL, 'flags => partial run status')
    assert.equal(result.evidence.flags.missingChildBom, result.flags.missingChildBom)
  })

  // ---- diff vs a prior batch reaches a change type ----
  await run('diff against prior lines reaches quantity_changed and is never null when prior supplied', () => {
    const previousLines = [
      {
        snapshotLineId: 'prev_line_1',
        snapshotBatchId: 'batch_prev',
        pathKey: '/root/A-100',
        childDrawingNo: 'A-100',
        childVersion: 'V1',
        designQty: 99, // differs from the current rawQuantity=3 => quantity_changed
        designUnit: 'pcs',
        lineStatus: 'active',
        sourceFingerprint: 'sha16:prioroldvalue',
      },
    ]
    const result = planBomSnapshotSyncRun(baseInput({
      previousSnapshotBatchId: 'batch_prev',
      previousLines,
    }))
    assert.notEqual(result.diff, null)
    assert.ok(result.diff.diffs.length > 0)
    const byChangeType = result.diff.evidence.result.byChangeType
    assert.ok(
      Object.prototype.hasOwnProperty.call(byChangeType, CHANGE_TYPES.QUANTITY_CHANGED),
      `diff reaches ${CHANGE_TYPES.QUANTITY_CHANGED}`,
    )
    assert.equal(result.evidence.diffRan, true)
    // resultShape carries a values-free diff summary (counts only).
    const resultShape = JSON.parse(result.syncRun.resultShape)
    assert.equal(typeof resultShape.diff.diffs, 'number')
  })

  // ---- prior lines are NEVER mutated (immutability of old snapshots) ----
  await run('previousLines are not mutated by the plan', () => {
    const previousLines = [
      { snapshotLineId: 'p1', snapshotBatchId: 'batch_prev', pathKey: '/root/A-100', childDrawingNo: 'A-100', designQty: 1, designUnit: 'pcs', lineStatus: 'active' },
      { snapshotLineId: 'p2', snapshotBatchId: 'batch_prev', pathKey: '/root/gone', childDrawingNo: 'Z-9', designQty: 4, designUnit: 'pcs', lineStatus: 'active' },
    ]
    const before = JSON.parse(JSON.stringify(previousLines))
    planBomSnapshotSyncRun(baseInput({ previousSnapshotBatchId: 'batch_prev', previousLines }))
    assert.deepEqual(previousLines, before, 'previousLines unchanged after planning')
  })

  // ---- requiring the prior batch id when prior lines are supplied ----
  await run('previousLines without previousSnapshotBatchId is a 422 config error', () => {
    assert.throws(
      () => planBomSnapshotSyncRun(baseInput({ previousLines: [] })),
      (error) => error instanceof StockPreparationSyncRunPlanError && error.status === 422 && error.details.field === 'previousSnapshotBatchId',
    )
  })

  // ---- duplicate path key + missing design qty flags surfaced ----
  await run('duplicate path keys and lines lacking a design qty are surfaced as flags', () => {
    const result = planBomSnapshotSyncRun(baseInput({
      defaultDesignUnit: undefined,
      expansionResult: [
        { componentSourceId: 'CS1', componentCode: 'A-100', sourceVersion: 'V1', path: '/root/dup', rawQuantity: 2 },
        { componentSourceId: 'CS2', componentCode: 'A-101', sourceVersion: 'V1', path: '/root/dup', rawQuantity: 2 }, // same path => duplicate
        { componentSourceId: 'CS3', componentCode: 'A-102', sourceVersion: 'V1', path: '/root/noqty' }, // no quantity
      ],
    }))
    assert.ok(result.flags.duplicatePathKeys >= 1, 'duplicate path key surfaced')
    assert.ok(result.flags.missingDesignQty >= 1, 'line lacking a design qty surfaced')
    assert.ok(result.flags.missingDesignUnit >= 1, 'lines lacking a design unit surfaced (no default supplied)')
    assert.equal(result.flags.hasFlags, true)
    assert.equal(result.syncRun.status, RUN_STATUS_PARTIAL)
  })

  // ---- admin gate: non-admin permission is a 403 and short-circuits ----
  await run('non-admin permission throws 403 before any planning', () => {
    for (const permission of ['read', 'write', undefined, null, '']) {
      assert.throws(
        () => planBomSnapshotSyncRun(baseInput({ permission })),
        (error) =>
          error instanceof StockPreparationSyncRunPlanError &&
          error.status === 403 &&
          error.code === 'SYNC_RUN_PLAN_PERMISSION_DENIED',
        `permission ${String(permission)} denied`,
      )
    }
  })

  // ---- values-free evidence: no leaked projectId / drawing number ----
  await run('evidence never leaks the projectId or a drawing number', () => {
    const result = planBomSnapshotSyncRun(baseInput({
      projectId: LEAKY_PROJECT_ID,
      syncRunId: `run_${SECRET}`,
      snapshotBatchId: `batch_${SECRET}`,
      expansionResult: [
        { componentSourceId: 'CS1', componentCode: LEAKY_DRAWING_NO, sourceVersion: 'V1', path: `/root/${LEAKY_DRAWING_NO}`, rawQuantity: 3 },
      ],
    }))
    // The plan rows legitimately carry the ids/drawing (that is the plan data)...
    assert.equal(result.snapshotBatch.projectId, LEAKY_PROJECT_ID)
    assert.equal(result.snapshotLines[0].childDrawingNo, LEAKY_DRAWING_NO)
    // ...but the EVIDENCE is values-free: the secret token appears nowhere in it.
    const evidenceJson = JSON.stringify(result.evidence)
    assert.equal(evidenceJson.includes(SECRET), false, 'secret token absent from evidence')
    assert.equal(evidenceJson.includes(LEAKY_PROJECT_ID), false)
    assert.equal(evidenceJson.includes(LEAKY_DRAWING_NO), false)
    assert.equal(result.evidence.valuesFree, true)
    // evidence still carries the values-free field-key NAMES + public objectId constants.
    assert.ok(result.evidence.snapshotBatch.fieldKeys.includes('snapshotBatchId'))
    assert.equal(result.evidence.syncRun.runType, 'plm_sync')
  })

  // ---- input guard ----
  await run('non-object input is a 422 config error', () => {
    assert.throws(
      () => planBomSnapshotSyncRun('nope'),
      (error) => error instanceof StockPreparationSyncRunPlanError && error.status === 422,
    )
  })

  console.log(`\nstock-preparation-sync-run-plan.test.cjs: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    for (const { name } of failures) console.error(`  - ${name}`)
    process.exit(1)
  }
  console.log('stock-preparation-sync-run-plan.test.cjs OK')
}

main().catch((error) => {
  console.error('stock-preparation-sync-run-plan.test.cjs FAILED')
  console.error(error)
  process.exit(1)
})
