'use strict'

const assert = require('node:assert/strict')

const canonicalCodec = require('../lib/sealed-export/canonical-json.cjs')
const {
  PAYLOAD_FIELDS,
  StockPreparationSealedSnapshotDecodeError,
  decodeStockPreparationSealedSnapshotRows,
} = require('../lib/stock-preparation-sealed-snapshot-decoder.cjs')

function payload(overrides = {}) {
  return {
    bomLevel: 1,
    childDrawingNo: 'CHILD-1',
    childVersion: null,
    designQty: '1.25',
    designUnit: 'EA',
    lineStatus: 'active',
    parentDrawingNo: 'PARENT-1',
    parentVersion: 'A',
    pathKey: '1/1',
    projectId: 'project-1',
    projectName: 'Project 1',
    snapshotBatchId: 'batch-1',
    snapshotVersion: 1,
    sourceBomId: null,
    sourceProjectNo: 'SOURCE-PROJECT-1',
    syncRunId: 'run-1',
    ...overrides,
  }
}

function row(rowId, overrides = {}) {
  const encoded = canonicalCodec.tryCanonicalJson(payload(overrides))
  assert.equal(encoded.ok, true)
  return Object.freeze({
    payload: encoded.text,
    payloadVersion: 1,
    rowId,
  })
}

function input(rows) {
  return {
    actor: 'operator-1',
    rows,
    startedAt: '2026-07-31T00:00:00.000Z',
  }
}

function refuses(action, code) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof StockPreparationSealedSnapshotDecodeError)
    assert.equal(error.code, code)
    assert.equal(error.message.includes('CHILD-1'), false)
    return true
  })
}

assert.deepEqual([...PAYLOAD_FIELDS].sort(), Object.keys(payload()).sort())

{
  const result = decodeStockPreparationSealedSnapshotRows(input([
    row(1),
    row(2, {
      childDrawingNo: 'CHILD-2',
      pathKey: '1/2',
    }),
  ]))
  assert.equal(result.evidence.valuesFree, true)
  assert.equal(result.evidence.inputRows, 2)
  assert.equal(result.evidence.decodedRows, 2)
  assert.equal(result.request.projectId, 'project-1')
  assert.equal(result.intake.projects.length, 1)
  assert.equal(result.intake.bomSnapshotBatches.length, 1)
  assert.equal(result.intake.bomSnapshotLines.length, 2)
  assert.equal(result.intake.bomSnapshotLines[0].designQty, 1.25)
  assert.equal(
    result.intake.bomSnapshotLines[0].snapshotLineId,
    'sealed_snapshot_line_1',
  )
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.intake), true)
  assert.equal(Object.isFrozen(result.intake.bomSnapshotLines), true)
  assert.equal(Object.isFrozen(result.intake.bomSnapshotLines[0]), true)
  assert.throws(() => {
    result.intake.bomSnapshotLines[0].designQty = 99
  }, TypeError)
}

refuses(
  () => decodeStockPreparationSealedSnapshotRows(input([])),
  'STOCK_PREPARATION_SEALED_SNAPSHOT_EMPTY',
)

{
  const boundary = decodeStockPreparationSealedSnapshotRows(input(
    Array.from({ length: 24999 }, (_, index) => row(index + 1, {
      childDrawingNo: `CHILD-${index + 1}`,
      pathKey: `1/${index + 1}`,
    })),
  ))
  assert.equal(boundary.evidence.decodedRows, 24999)
  assert.equal(boundary.intake.bomSnapshotLines.length, 24999)
}

refuses(
  () =>
    decodeStockPreparationSealedSnapshotRows(input(
      Array.from({ length: 25000 }, (_, index) => row(index + 1, {
        childDrawingNo: `CHILD-${index + 1}`,
        pathKey: `1/${index + 1}`,
      })),
    )),
  'STOCK_PREPARATION_SEALED_SNAPSHOT_BUDGET_EXCEEDED',
)

refuses(
  () =>
    decodeStockPreparationSealedSnapshotRows(input([
      row(1),
      row(2, { pathKey: '1/2', syncRunId: 'other-run' }),
    ])),
  'STOCK_PREPARATION_SEALED_SNAPSHOT_SCOPE_MISMATCH',
)

refuses(
  () =>
    decodeStockPreparationSealedSnapshotRows(input([
      row(1),
      row(2, { childDrawingNo: 'CHILD-2' }),
    ])),
  'STOCK_PREPARATION_SEALED_SNAPSHOT_ROW_INVALID',
)

{
  const withUnknown = payload()
  withUnknown.unknown = 'not-certified'
  const encoded = canonicalCodec.tryCanonicalJson(withUnknown)
  assert.equal(encoded.ok, true)
  refuses(
    () =>
      decodeStockPreparationSealedSnapshotRows(input([{
        payload: encoded.text,
        payloadVersion: 1,
        rowId: 1,
      }])),
    'STOCK_PREPARATION_SEALED_SNAPSHOT_ROW_INVALID',
  )
}

refuses(
  () =>
    decodeStockPreparationSealedSnapshotRows(input([{
      payload: '{"projectId":"first","projectId":"second"}',
      payloadVersion: 1,
      rowId: 1,
    }])),
  'STOCK_PREPARATION_SEALED_SNAPSHOT_ROW_INVALID',
)

refuses(
  () =>
    decodeStockPreparationSealedSnapshotRows(input([{
      payload: JSON.stringify(payload({ designQty: 1.25 })),
      payloadVersion: 1,
      rowId: 1,
    }])),
  'STOCK_PREPARATION_SEALED_SNAPSHOT_ROW_INVALID',
)

refuses(
  () =>
    decodeStockPreparationSealedSnapshotRows(input([
      row(1, { lineStatus: 'missing_child_bom' }),
    ])),
  'STOCK_PREPARATION_SEALED_SNAPSHOT_ROW_INVALID',
)

refuses(
  () =>
    decodeStockPreparationSealedSnapshotRows({
      ...input([row(1)]),
      startedAt: '2026-02-30T00:00:00.000Z',
    }),
  'STOCK_PREPARATION_SEALED_SNAPSHOT_ROW_INVALID',
)

refuses(
  () =>
    decodeStockPreparationSealedSnapshotRows(input([
      row(1, { designQty: '9007199254740991.1' }),
    ])),
  'STOCK_PREPARATION_SEALED_SNAPSHOT_ROW_INVALID',
)

{
  const sparseRows = []
  sparseRows.length = 1
  refuses(
    () => decodeStockPreparationSealedSnapshotRows(input(sparseRows)),
    'STOCK_PREPARATION_SEALED_SNAPSHOT_ROW_INVALID',
  )
}

{
  const accessorRow = {}
  Object.defineProperty(accessorRow, 'payload', {
    enumerable: true,
    get() {
      return row(1).payload
    },
  })
  accessorRow.payloadVersion = 1
  accessorRow.rowId = 1
  refuses(
    () => decodeStockPreparationSealedSnapshotRows(input([accessorRow])),
    'STOCK_PREPARATION_SEALED_SNAPSHOT_ROW_INVALID',
  )
}

refuses(
  () =>
    decodeStockPreparationSealedSnapshotRows(input([
      new Proxy(row(1), {}),
    ])),
  'STOCK_PREPARATION_SEALED_SNAPSHOT_ROW_INVALID',
)

console.log('stock-preparation-sealed-snapshot-decoder.test.cjs OK')
