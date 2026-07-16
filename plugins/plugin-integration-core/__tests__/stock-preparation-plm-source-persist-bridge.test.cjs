'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  ACCEPTED_LINE_STATUSES,
  CANONICAL_LINE_STATUSES,
  EXPANSION_ROW_KEYS,
  StockPreparationPlmSourcePersistBridgeError,
  buildPlmSourcePersistInput,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-plm-source-persist-bridge.cjs'))
const {
  mapExpansionRowsToSnapshotLines,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-expansion-snapshot-mapper.cjs'))

const SECRET = 'CUSTOMER-LIFECYCLE-SECRET-991'

function request(overrides = {}) {
  return {
    tenantId: 'must-not-forward',
    workspaceId: 'must-not-forward',
    projectId: 'project-1',
    sourceProjectNo: 'PROJECT-NO-1',
    projectName: 'request-name-is-not-authoritative',
    readSourceConfigId: 'private-config-must-not-forward',
    inputs: { key: 'private-key-must-not-forward' },
    syncRunId: 'run-1',
    snapshotBatchId: 'batch-1',
    snapshotVersion: '2',
    ...overrides,
  }
}

function line(overrides = {}) {
  return {
    snapshotLineId: 'stockprep_snapshot_line_0123456789abcdef',
    snapshotBatchId: 'batch-1',
    projectId: 'project-1',
    parentDrawingNo: 'PARENT-1',
    parentVersion: 'A',
    childDrawingNo: 'CHILD-1',
    childVersion: 'B',
    bomLevel: 1,
    pathKey: '/root/child-1',
    designQty: 3,
    designUnit: 'pcs',
    lineStatus: 'imported',
    sourceFingerprint: 'sha16:0123456789abcdef',
    unknownBusinessField: 'must-not-forward',
    ...overrides,
  }
}

function intake(overrides = {}) {
  return {
    status: 'ready',
    projects: [{
      projectId: 'project-1',
      sourceProjectNo: 'PROJECT-NO-1',
      projectName: 'PLM Project One',
      sourceSystem: 'data-source:sql-readonly',
      projectStatus: 'imported',
      lastSyncRunId: 'run-1',
      owner: 'must-not-forward',
    }],
    bomSnapshotBatches: [{
      snapshotBatchId: 'batch-1',
      projectId: 'project-1',
      sourceSystem: 'data-source:sql-readonly',
      sourceBomId: 'must-not-forward',
      snapshotVersion: 2,
      syncRunId: 'run-1',
      snapshotStatus: 'ready',
      createdAt: '2026-07-16T00:00:00.000Z',
      createdBy: 'must-not-forward',
    }],
    bomSnapshotLines: [
      line(),
      line({
        snapshotLineId: 'stockprep_snapshot_line_fedcba9876543210',
        childDrawingNo: 'CHILD-2',
        pathKey: '/root/child-2',
        lineStatus: 'inactive',
        sourceFingerprint: 'sha16:fedcba9876543210',
      }),
    ],
    rowErrors: [],
    runRecord: {
      runId: 'run-1',
      runType: 'readonly_intake',
      status: 'ready',
      inputShape: '{}',
      resultShape: '{}',
      createdBy: 'must-not-forward',
    },
    evidence: { valuesFree: true },
    ...overrides,
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function run(name, fn) {
  fn()
  process.stdout.write(`ok - ${name}\n`)
}

run('builds the closed persist input and preserves every line through the existing mapper', () => {
  const sourceIntake = intake()
  const result = buildPlmSourcePersistInput({ request: request(), intake: sourceIntake })
  assert.deepEqual(Object.keys(result).sort(), [
    'expansionResult',
    'projectId',
    'projectName',
    'snapshotBatchId',
    'snapshotVersion',
    'sourceProjectNo',
    'sourceSystem',
    'syncRunId',
  ])
  assert.equal(result.projectName, 'PLM Project One')
  assert.equal(result.snapshotVersion, 2)
  assert.equal(result.expansionResult.length, sourceIntake.bomSnapshotLines.length)
  assert.equal(result.expansionResult[0].lineStatus, 'active')
  assert.equal(result.expansionResult[1].lineStatus, 'inactive')
  for (const row of result.expansionResult) {
    assert.ok(Object.keys(row).every((key) => EXPANSION_ROW_KEYS.includes(key)))
    assert.equal('projectId' in row, false)
    assert.equal('unknownBusinessField' in row, false)
  }

  const remapped = mapExpansionRowsToSnapshotLines(result.expansionResult, { snapshotBatchId: result.snapshotBatchId })
  assert.equal(remapped.lines.length, sourceIntake.bomSnapshotLines.length)
  for (let index = 0; index < remapped.lines.length; index += 1) {
    const actual = remapped.lines[index]
    const expected = sourceIntake.bomSnapshotLines[index]
    assert.equal(actual.snapshotLineId, expected.snapshotLineId)
    assert.equal(actual.pathKey, expected.pathKey)
    assert.equal(actual.designQty, expected.designQty)
    assert.equal(actual.designUnit, expected.designUnit)
    assert.equal(actual.sourceFingerprint, expected.sourceFingerprint)
    assert.equal(actual.lineStatus, expected.lineStatus === 'imported' ? 'active' : expected.lineStatus)
  }
})

run('canonicalizes only imported and preserves the remaining canonical statuses', () => {
  const sourceIntake = intake({
    bomSnapshotLines: ACCEPTED_LINE_STATUSES.map((status, index) => line({
      snapshotLineId: `line-${index}`,
      pathKey: `/path/${index}`,
      sourceFingerprint: `fingerprint-${index}`,
      lineStatus: status,
    })),
  })
  const result = buildPlmSourcePersistInput({ request: request(), intake: sourceIntake })
  assert.deepEqual(result.expansionResult.map((row) => row.lineStatus), ['active', 'active', 'inactive', 'incomplete'])
  assert.deepEqual(CANONICAL_LINE_STATUSES, ['active', 'inactive', 'incomplete'])
})

run('unsupported lifecycle values reject the whole envelope with values-free details', () => {
  const sourceIntake = intake({
    bomSnapshotLines: [
      line({ lineStatus: `released-${SECRET}` }),
      line({ snapshotLineId: 'line-2', pathKey: '/two', sourceFingerprint: 'fp-2', lineStatus: `obsolete-${SECRET}` }),
      line({ snapshotLineId: 'line-3', pathKey: '/three', sourceFingerprint: 'fp-3', lineStatus: `WIP-${SECRET}` }),
    ],
  })
  let caught
  try {
    buildPlmSourcePersistInput({ request: request(), intake: sourceIntake })
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof StockPreparationPlmSourcePersistBridgeError)
  assert.equal(caught.status, 422)
  assert.equal(caught.code, 'STOCK_PREPARATION_PLM_AUTOPERSIST_LINE_STATUS_UNSUPPORTED')
  assert.deepEqual(caught.details.acceptedInput, ACCEPTED_LINE_STATUSES)
  assert.deepEqual(caught.details.canonicalOutput, CANONICAL_LINE_STATUSES)
  assert.equal(caught.details.unsupportedRowCount, 3)
  assert.equal(JSON.stringify(caught).includes(SECRET), false)
})

run('a malformed line fails the entire envelope instead of being dropped', () => {
  const sourceIntake = intake({ bomSnapshotLines: [line(), null] })
  assert.throws(
    () => buildPlmSourcePersistInput({ request: request(), intake: sourceIntake }),
    (error) => error instanceof StockPreparationPlmSourcePersistBridgeError &&
      error.code === 'STOCK_PREPARATION_PLM_AUTOPERSIST_INTAKE_INVALID',
  )
})

for (const [name, mutate] of [
  ['request project', (req) => { req.projectId = 'other-project' }],
  ['source project number', (_req, value) => { value.projects[0].sourceProjectNo = 'other-project-no' }],
  ['project run', (_req, value) => { value.projects[0].lastSyncRunId = 'other-run' }],
  ['batch project', (_req, value) => { value.bomSnapshotBatches[0].projectId = 'other-project' }],
  ['batch id', (_req, value) => { value.bomSnapshotBatches[0].snapshotBatchId = 'other-batch' }],
  ['batch run', (_req, value) => { value.bomSnapshotBatches[0].syncRunId = 'other-run' }],
  ['batch version', (_req, value) => { value.bomSnapshotBatches[0].snapshotVersion = 3 }],
  ['run record', (_req, value) => { value.runRecord.runId = 'other-run' }],
  ['line project', (_req, value) => { value.bomSnapshotLines[1].projectId = 'other-project' }],
  ['line batch', (_req, value) => { value.bomSnapshotLines[1].snapshotBatchId = 'other-batch' }],
  ['source system', (_req, value) => { value.bomSnapshotBatches[0].sourceSystem = 'other-source' }],
]) {
  run(`rejects ${name} mismatch without echoing business values`, () => {
    const req = request()
    const value = intake()
    mutate(req, value)
    let caught
    try {
      buildPlmSourcePersistInput({ request: req, intake: value })
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof StockPreparationPlmSourcePersistBridgeError)
    assert.equal(caught.code, 'STOCK_PREPARATION_PLM_AUTOPERSIST_INTAKE_INVALID')
    assert.equal(JSON.stringify(caught).includes('other-'), false)
  })
}

for (const [name, mutate] of [
  ['zero projects', (value) => { value.projects = [] }],
  ['multiple projects', (value) => { value.projects.push(clone(value.projects[0])) }],
  ['zero batches', (value) => { value.bomSnapshotBatches = [] }],
  ['multiple batches', (value) => { value.bomSnapshotBatches.push(clone(value.bomSnapshotBatches[0])) }],
  ['zero lines', (value) => { value.bomSnapshotLines = [] }],
  ['row errors', (value) => { value.rowErrors = [{ type: SECRET }] }],
  ['missing row-errors ledger', (value) => { delete value.rowErrors }],
  ['malformed row-errors ledger', (value) => { value.rowErrors = { count: 0 } }],
  ['missing run record', (value) => { value.runRecord = null }],
]) {
  run(`rejects ${name} as an all-or-nothing envelope`, () => {
    const value = intake()
    mutate(value)
    let caught
    try {
      buildPlmSourcePersistInput({ request: request(), intake: value })
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof StockPreparationPlmSourcePersistBridgeError)
    assert.equal(caught.code, 'STOCK_PREPARATION_PLM_AUTOPERSIST_INTAKE_INVALID')
    assert.equal(JSON.stringify(caught).includes(SECRET), false)
  })
}

for (const [field, value] of [
  ['snapshotLineId', ''],
  ['pathKey', null],
  ['sourceFingerprint', undefined],
]) {
  run(`rejects a line missing required ${field} without dropping it`, () => {
    const sourceIntake = intake({ bomSnapshotLines: [line({ [field]: value })] })
    assert.throws(
      () => buildPlmSourcePersistInput({ request: request(), intake: sourceIntake }),
      (error) => error instanceof StockPreparationPlmSourcePersistBridgeError &&
        error.code === 'STOCK_PREPARATION_PLM_AUTOPERSIST_INTAKE_INVALID' &&
        error.details.field === `intake.bomSnapshotLines.${field}`,
    )
  })
}

run('module dependency surface is pure and contains no platform I/O calls', () => {
  const sourcePath = path.join(__dirname, '..', 'lib', 'stock-preparation-plm-source-persist-bridge.cjs')
  const source = fs.readFileSync(sourcePath, 'utf8')
  const requiredModules = [...source.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1])
  assert.deepEqual(requiredModules, ['./stock-preparation-common.cjs'])
  for (const token of ['queryRecords(', 'createRecord(', 'patchRecord(', 'fetch(', 'persistStockPreparationSyncRun(']) {
    assert.equal(source.includes(token), false, `${token} is absent from the pure bridge`)
  }
})

process.stdout.write('all stock-preparation-plm-source-persist-bridge tests passed\n')
