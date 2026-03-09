import test from 'node:test'
import assert from 'node:assert/strict'
import { assertImportTelemetry, coerceNonNegativeNumber } from './attendance-import-telemetry-utils.mjs'

test('coerceNonNegativeNumber parses numeric input', () => {
  assert.equal(coerceNonNegativeNumber(12), 12)
  assert.equal(coerceNonNegativeNumber('8'), 8)
  assert.equal(coerceNonNegativeNumber('-1'), null)
})

test('assertImportTelemetry accepts explicit telemetry payload', () => {
  const telemetry = assertImportTelemetry(
    {
      engine: 'bulk',
      processedRows: 120,
      failedRows: 3,
      elapsedMs: 2500,
      recordUpsertStrategy: 'staging',
    },
    'telemetry',
    { minProcessedRows: 1, requireExplicit: true, requireUpsertStrategy: true },
  )
  assert.equal(telemetry.engine, 'bulk')
  assert.equal(telemetry.processedRows, 120)
  assert.equal(telemetry.failedRows, 3)
  assert.equal(telemetry.elapsedMs, 2500)
  assert.equal(telemetry.recordUpsertStrategy, 'staging')
})

test('assertImportTelemetry rejects missing explicit processedRows', () => {
  assert.throws(
    () => assertImportTelemetry(
      {
        engine: 'standard',
        rowCount: 10,
        failedRows: 0,
        elapsedMs: 50,
      },
      'telemetry',
      { requireExplicit: true },
    ),
    /processedRows missing or invalid/i,
  )
})
