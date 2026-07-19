'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  persistStockPreparationSyncRun,
  BATCH_OBJECT_ID,
  LINE_OBJECT_ID,
  RUN_OBJECT_ID,
  PROJECT_OBJECT_ID,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-sync-run-persist.cjs'))
const {
  repairStockPreparationSyncRunOnce,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-sync-run-repair-once.cjs'))
const {
  __internals: { MVP_OBJECT_ID_SET },
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-sync-run-persist.cjs'))
const {
  makeFakeProvisioning,
  makeStrictRecordsApi,
  physicalFieldId,
  logicalData,
} = require(path.join(__dirname, 'fixtures', 'stock-preparation-multitable-fakes.cjs'))

const STAGING_PROJECT_ID = 'tenant_x:integration-core'
const LOCK_TENANT_ID = 'tenant_x'
const BATCH_SHEET_ID = `sheet_${BATCH_OBJECT_ID}`
const LINE_SHEET_ID = `sheet_${LINE_OBJECT_ID}`
const RUN_SHEET_ID = `sheet_${RUN_OBJECT_ID}`
const PROJECT_SHEET_ID = `sheet_${PROJECT_OBJECT_ID}`
const SHEET_ID_BY_OBJECT_ID = Object.fromEntries(
  [...MVP_OBJECT_ID_SET].map((objectId) => [objectId, `sheet_${objectId}`]),
)
const OBJECT_ID_BY_SHEET_ID = Object.fromEntries(
  Object.entries(SHEET_ID_BY_OBJECT_ID).map(([objectId, sheetId]) => [sheetId, objectId]),
)

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

function makeRecordsApi() {
  return makeStrictRecordsApi({
    objectIdBySheetId: OBJECT_ID_BY_SHEET_ID,
    stagingProjectId: STAGING_PROJECT_ID,
  })
}

function makeProvisioning() {
  return makeFakeProvisioning({
    sheetIdByObjectId: SHEET_ID_BY_OBJECT_ID,
    stagingProjectId: STAGING_PROJECT_ID,
  })
}

function cleanExpansionResult() {
  return [
    { componentSourceId: 'CS1', componentCode: 'A-100', sourceVersion: 'V1', path: '/root/A-100', rawQuantity: 3 },
    { componentSourceId: 'CS2', componentCode: 'B-200', sourceVersion: 'V2', path: '/root/B-200', rawQuantity: 5, parentSourceId: 'CS1' },
  ]
}

function baseInputs(overrides = {}) {
  return {
    projectId: 'proj_1',
    targetProjectId: STAGING_PROJECT_ID,
    lockTenantId: LOCK_TENANT_ID,
    syncRunId: 'run_1',
    snapshotBatchId: 'batch_1',
    snapshotVersion: 1,
    sourceProjectNo: 'PN-1',
    defaultDesignUnit: 'pcs',
    expansionResult: cleanExpansionResult(),
    ...overrides,
  }
}

function repairInput(recordsApi, provisioning, overrides = {}) {
  return {
    permission: 'admin',
    recordsApi,
    provisioning,
    auditStore: { async append() {} },
    ...baseInputs(),
    ...overrides,
  }
}

function persistInput(recordsApi, provisioning, overrides = {}) {
  return {
    permission: 'admin',
    recordsApi,
    provisioning,
    ...baseInputs(),
    ...overrides,
  }
}

function logicalProjectRow(recordsApi) {
  const row = recordsApi.store.get(PROJECT_SHEET_ID)[0]
  return logicalData(STAGING_PROJECT_ID, PROJECT_OBJECT_ID, row.data)
}

function removeTailForCrashAfterFirstLine(recordsApi) {
  const lines = recordsApi.store.get(LINE_SHEET_ID)
  recordsApi.store.set(LINE_SHEET_ID, lines.slice(0, 1))
  recordsApi.store.set(RUN_SHEET_ID, [])
  recordsApi.store.set(PROJECT_SHEET_ID, [])
}

async function main() {
  await run('dry-run reports a provable missing suffix without writing; apply repairs once and then noops', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    const auditCalls = []
    const auditStore = { async append(input) { auditCalls.push(structuredClone(input)) } }
    await persistStockPreparationSyncRun(persistInput(recordsApi, provisioning))
    removeTailForCrashAfterFirstLine(recordsApi)
    const createsBeforeDryRun = recordsApi.createCalls.length

    const dryRun = await repairStockPreparationSyncRunOnce(repairInput(recordsApi, provisioning, { auditStore }))
    assert.equal(dryRun.persisted, false)
    assert.equal(dryRun.mode, 'dry_run')
    assert.equal(dryRun.repairable, true)
    assert.deepEqual(dryRun.created, { lines: 0, run: 0, project: 0 })
    assert.deepEqual(dryRun.evidence.missing, { lines: 1, run: 1, project: 1 })
    assert.equal(recordsApi.createCalls.length, createsBeforeDryRun, 'dry-run does not write')

    const applied = await repairStockPreparationSyncRunOnce(repairInput(recordsApi, provisioning, { apply: true, auditStore }))
    assert.equal(applied.persisted, true)
    assert.equal(applied.mode, 'repaired')
    assert.deepEqual(applied.created, { lines: 1, run: 1, project: 1 })
    assert.equal(recordsApi.store.get(LINE_SHEET_ID).length, 2)
    assert.equal(recordsApi.store.get(RUN_SHEET_ID).length, 1)
    assert.equal(recordsApi.store.get(PROJECT_SHEET_ID).length, 1)

    const replay = await repairStockPreparationSyncRunOnce(repairInput(recordsApi, provisioning, { apply: true, auditStore }))
    assert.equal(replay.persisted, false)
    assert.equal(replay.mode, 'noop')
    assert.equal(replay.repairable, false)
    assert.deepEqual(replay.created, { lines: 0, run: 0, project: 0 })
    assert.deepEqual(auditCalls.map((call) => [call.action, call.mode]), [
      ['persist_repair_once', 'dry_run'],
      ['persist_repair_once', 'apply_requested'],
      ['persist_repair_once', 'repaired'],
      ['persist_repair_once', 'apply_requested'],
      ['persist_repair_once', 'noop'],
    ])
    assert.deepEqual(auditCalls[2].detail.created, { lines: 1, run: 1, project: 1 })
  })

  await run('a middle line gap is refused and never converted into an append repair', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    await persistStockPreparationSyncRun(persistInput(recordsApi, provisioning))
    const lines = recordsApi.store.get(LINE_SHEET_ID)
    recordsApi.store.set(LINE_SHEET_ID, [lines[1]])
    recordsApi.store.set(RUN_SHEET_ID, [])
    recordsApi.store.set(PROJECT_SHEET_ID, [])
    const createsBefore = recordsApi.createCalls.length

    await assert.rejects(
      () => repairStockPreparationSyncRunOnce(repairInput(recordsApi, provisioning, { apply: true })),
      (error) => error.status === 409 && error.code === 'PERSIST_REPAIR_REFUSED' &&
        error.details.target === 'snapshot_line' && error.details.reason === 'non_suffix_gap',
    )
    assert.equal(recordsApi.createCalls.length, createsBefore)
    assert.equal(recordsApi.store.get(LINE_SHEET_ID).length, 1)
  })

  await run('a mismatched immutable line is refused rather than overwritten', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    await persistStockPreparationSyncRun(persistInput(recordsApi, provisioning))
    const line = recordsApi.store.get(LINE_SHEET_ID)[0]
    line.data[physicalFieldId(STAGING_PROJECT_ID, LINE_OBJECT_ID, 'designQty')] = 999
    const createsBefore = recordsApi.createCalls.length

    await assert.rejects(
      () => repairStockPreparationSyncRunOnce(repairInput(recordsApi, provisioning, { apply: true })),
      (error) => error.status === 409 && error.code === 'PERSIST_REPAIR_REFUSED' &&
        error.details.target === 'snapshot_line' && error.details.reason === 'content_mismatch',
    )
    assert.equal(recordsApi.createCalls.length, createsBefore)
    assert.equal(recordsApi.patchCalls.length, 0)
  })

  await run('a provably stale project pointer advances to the complete newer run and then noops', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    await persistStockPreparationSyncRun(persistInput(recordsApi, provisioning))
    await persistStockPreparationSyncRun(persistInput(recordsApi, provisioning, {
      syncRunId: 'run_2',
      snapshotBatchId: 'batch_2',
      snapshotVersion: 2,
    }))
    const project = recordsApi.store.get(PROJECT_SHEET_ID)[0]
    project.data[physicalFieldId(STAGING_PROJECT_ID, PROJECT_OBJECT_ID, 'lastSyncRunId')] = 'run_1'

    const dryRun = await repairStockPreparationSyncRunOnce(repairInput(recordsApi, provisioning, {
      syncRunId: 'run_2',
      snapshotBatchId: 'batch_2',
      snapshotVersion: 2,
    }))
    assert.equal(dryRun.evidence.staleProjectPointer, true)
    assert.equal(logicalProjectRow(recordsApi).lastSyncRunId, 'run_1')

    const applied = await repairStockPreparationSyncRunOnce(repairInput(recordsApi, provisioning, {
      apply: true,
      syncRunId: 'run_2',
      snapshotBatchId: 'batch_2',
      snapshotVersion: 2,
    }))
    assert.equal(applied.patched.project, 1)
    assert.equal(logicalProjectRow(recordsApi).lastSyncRunId, 'run_2')

    const replay = await repairStockPreparationSyncRunOnce(repairInput(recordsApi, provisioning, {
      apply: true,
      syncRunId: 'run_2',
      snapshotBatchId: 'batch_2',
      snapshotVersion: 2,
    }))
    assert.equal(replay.mode, 'noop')
  })

  await run('repairing an older complete batch preserves an already advanced project pointer', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    await persistStockPreparationSyncRun(persistInput(recordsApi, provisioning))
    await persistStockPreparationSyncRun(persistInput(recordsApi, provisioning, {
      syncRunId: 'run_2',
      snapshotBatchId: 'batch_2',
      snapshotVersion: 2,
    }))
    const patchesBefore = recordsApi.patchCalls.length

    const result = await repairStockPreparationSyncRunOnce(repairInput(recordsApi, provisioning, { apply: true }))
    assert.equal(result.mode, 'noop')
    assert.equal(result.evidence.advancedProjectPointerPreserved, true)
    assert.equal(recordsApi.patchCalls.length, patchesBefore)
    assert.equal(logicalProjectRow(recordsApi).lastSyncRunId, 'run_2')
  })

  await run('a duplicate batch identity fails closed before any repair write', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    const auditCalls = []
    const auditStore = { async append(input) { auditCalls.push(structuredClone(input)) } }
    await persistStockPreparationSyncRun(persistInput(recordsApi, provisioning))
    const rows = recordsApi.store.get(BATCH_SHEET_ID)
    rows.push({ ...rows[0], id: 'duplicate-batch', data: { ...rows[0].data } })
    const createsBefore = recordsApi.createCalls.length

    await assert.rejects(
      () => repairStockPreparationSyncRunOnce(repairInput(recordsApi, provisioning, { apply: true, auditStore })),
      (error) => error.status === 409 && error.code === 'PERSIST_REPAIR_REFUSED' &&
        error.details.target === 'snapshot_batch' && error.details.reason === 'ambiguous',
    )
    assert.equal(recordsApi.createCalls.length, createsBefore)
    assert.equal(auditCalls.length, 2)
    assert.equal(auditCalls[0].mode, 'apply_requested')
    assert.equal(auditCalls[1].mode, 'refused')
    assert.deepEqual(auditCalls[1].detail, {
      persisted: false,
      applied: true,
      result: 'refused',
      failureCode: 'PERSIST_REPAIR_REFUSED',
      target: 'snapshot_batch',
      reason: 'ambiguous',
    })
  })

  await run('a run row after a missing line proves a non-suffix write history and is refused', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    await persistStockPreparationSyncRun(persistInput(recordsApi, provisioning))
    recordsApi.store.set(LINE_SHEET_ID, recordsApi.store.get(LINE_SHEET_ID).slice(0, 1))
    recordsApi.store.set(PROJECT_SHEET_ID, [])

    await assert.rejects(
      () => repairStockPreparationSyncRunOnce(repairInput(recordsApi, provisioning, { apply: true })),
      (error) => error.status === 409 && error.code === 'PERSIST_REPAIR_REFUSED' &&
        error.details.target === 'run' && error.details.reason === 'non_suffix_gap',
    )
  })

  await run('an apply failure rolls the whole repair back to the original partial state', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    await persistStockPreparationSyncRun(persistInput(recordsApi, provisioning))
    removeTailForCrashAfterFirstLine(recordsApi)
    const createRecord = recordsApi.createRecord.bind(recordsApi)
    recordsApi.createRecord = async (input) => {
      if (input && input.sheetId === RUN_SHEET_ID) throw new Error('injected-run-create-failure')
      return createRecord(input)
    }

    await assert.rejects(
      () => repairStockPreparationSyncRunOnce(repairInput(recordsApi, provisioning, { apply: true })),
      /injected-run-create-failure/,
    )
    assert.equal(recordsApi.store.get(LINE_SHEET_ID).length, 1, 'line suffix write rolled back')
    assert.equal(recordsApi.store.get(RUN_SHEET_ID).length, 0)
    assert.equal(recordsApi.store.get(PROJECT_SHEET_ID).length, 0)
  })

  await run('repair evidence is values-free even when business inputs carry a planted sentinel', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    const secret = 'MAT_SECRET_DO_NOT_ECHO_4470'
    const inputs = repairInput(recordsApi, provisioning, {
      projectName: secret,
      expansionResult: [
        { componentSourceId: 'CS1', componentCode: secret, sourceVersion: 'V1', path: `/${secret}`, rawQuantity: 3 },
      ],
    })
    await persistStockPreparationSyncRun(persistInput(recordsApi, provisioning, {
      projectName: secret,
      expansionResult: inputs.expansionResult,
    }))
    recordsApi.store.set(RUN_SHEET_ID, [])
    recordsApi.store.set(PROJECT_SHEET_ID, [])

    const result = await repairStockPreparationSyncRunOnce({ ...inputs, apply: false })
    assert.equal(result.evidence.valuesFree, true)
    assert.equal(result.evidence.externalWrite, false)
    assert.equal(JSON.stringify(result).includes(secret), false)
  })

  await run('apply must be an explicit boolean and fails before provisioning or records access', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    await assert.rejects(
      () => repairStockPreparationSyncRunOnce(repairInput(recordsApi, provisioning, { apply: 'true' })),
      (error) => error.status === 422 && error.code === 'PERSIST_REPAIR_CONFIG_INVALID',
    )
    assert.equal(provisioning.calls.findObjectSheet.length, 0)
    assert.equal(recordsApi.queryCalls.length, 0)
    assert.equal(recordsApi.createCalls.length, 0)
  })

  await run('missing audit capability fails closed before provisioning or records access', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    await assert.rejects(
      () => repairStockPreparationSyncRunOnce(repairInput(recordsApi, provisioning, { auditStore: undefined })),
      (error) => error.status === 503 && error.code === 'PERSIST_REPAIR_AUDIT_UNAVAILABLE',
    )
    assert.equal(provisioning.calls.findObjectSheet.length, 0)
    assert.equal(recordsApi.queryCalls.length, 0)
    assert.equal(recordsApi.createCalls.length, 0)
  })

  await run('apply audit-intent failure stops before the repair unit-of-work or any snapshot write', async () => {
    const recordsApi = makeRecordsApi()
    const provisioning = makeProvisioning()
    const auditStore = { async append() { throw new Error('injected-audit-intent-failure') } }

    await assert.rejects(
      () => repairStockPreparationSyncRunOnce(repairInput(recordsApi, provisioning, { apply: true, auditStore })),
      /injected-audit-intent-failure/,
    )
    assert.equal(recordsApi.unitOfWorkCalls.length, 0)
    assert.equal(recordsApi.queryCalls.length, 0)
    assert.equal(recordsApi.createCalls.length, 0)
    assert.equal(recordsApi.patchCalls.length, 0)
  })

  console.log(`\nstock-preparation-sync-run-repair-once.test.cjs: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    for (const { name } of failures) console.error(`  - ${name}`)
    process.exit(1)
  }
  console.log('stock-preparation-sync-run-repair-once.test.cjs OK')
}

main().catch((error) => {
  console.error('stock-preparation-sync-run-repair-once.test.cjs FAILED')
  console.error(error)
  process.exit(1)
})
