import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { classifyPerfFailure } from './attendance-import-perf-trend-report.mjs'

describe('classifyPerfFailure', () => {
  it('classifies CSV_TOO_LARGE when remote cap hit', () => {
    const log = '[attendance-import-perf] Failed: CSV exceeds max rows (20000)'
    const result = classifyPerfFailure(log)
    assert.strictEqual(result.code, 'CSV_TOO_LARGE')
  })

  it('classifies NO_ROWS_TO_IMPORT when payload empty', () => {
    const log = '[attendance-import-perf] Failed: No rows to import'
    const result = classifyPerfFailure(log)
    assert.strictEqual(result.code, 'NO_ROWS_TO_IMPORT')
  })

  it('classifies ASYNC_POLL_TIMEOUT when async poll stalls', () => {
    const log = '[attendance-import-perf] Failed: Async poll stalled waiting for job status'
    const result = classifyPerfFailure(log)
    assert.strictEqual(result.code, 'ASYNC_POLL_TIMEOUT')
  })
})
