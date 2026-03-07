import test from 'node:test'
import assert from 'node:assert/strict'
import { pickLatestCompletedRun } from './attendance-daily-gate-report.mjs'

test('pickLatestCompletedRun skips excluded conclusions and falls back to previous valid run', () => {
  const list = [
    { id: 4, status: 'in_progress', conclusion: '' },
    { id: 3, status: 'completed', conclusion: 'cancelled' },
    { id: 2, status: 'completed', conclusion: 'success' },
    { id: 1, status: 'completed', conclusion: 'failure' },
  ]

  const picked = pickLatestCompletedRun(list, {
    excludeConclusions: ['cancelled', 'neutral', 'skipped'],
  })

  assert.equal(picked?.id, 2)
  assert.equal(picked?.conclusion, 'success')
})

test('pickLatestCompletedRun falls back to latest completed when all are excluded', () => {
  const list = [
    { id: 3, status: 'completed', conclusion: 'cancelled' },
    { id: 2, status: 'completed', conclusion: 'cancelled' },
    { id: 1, status: 'queued', conclusion: '' },
  ]

  const picked = pickLatestCompletedRun(list, {
    excludeConclusions: ['cancelled'],
  })

  assert.equal(picked?.id, 3)
  assert.equal(picked?.conclusion, 'cancelled')
})

test('pickLatestCompletedRun returns null when no completed run exists', () => {
  const list = [
    { id: 2, status: 'queued', conclusion: '' },
    { id: 1, status: 'in_progress', conclusion: '' },
  ]

  const picked = pickLatestCompletedRun(list, {
    excludeConclusions: ['cancelled'],
  })

  assert.equal(picked, null)
})
