import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveSmokeWorkDate } from './attendance-smoke-workdate.mjs'

test('resolveSmokeWorkDate honors explicit override', () => {
  assert.equal(
    resolveSmokeWorkDate({ SMOKE_WORK_DATE: '2031-02-03' }),
    '2031-02-03',
  )
})

test('resolveSmokeWorkDate stays deterministic for the same seed', () => {
  const env = {
    SMOKE_WORK_DATE_SEED: 'strict-run-1',
    GITHUB_RUN_ID: '23296937710',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_RUN_NUMBER: '500',
  }
  assert.equal(resolveSmokeWorkDate(env), resolveSmokeWorkDate(env))
})

test('resolveSmokeWorkDate varies across strict gate sub-runs', () => {
  const baseEnv = {
    GITHUB_RUN_ID: '23296937710',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_RUN_NUMBER: '500',
  }

  const first = resolveSmokeWorkDate({
    ...baseEnv,
    SMOKE_WORK_DATE_SEED: '/tmp/output/20260319-132230-1',
  })
  const second = resolveSmokeWorkDate({
    ...baseEnv,
    SMOKE_WORK_DATE_SEED: '/tmp/output/20260319-132230-2',
  })

  assert.notEqual(first, second)
})
