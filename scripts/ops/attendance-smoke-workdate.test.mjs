import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  isBlockingTimeCorrectionRequest,
  resolveSmokeWorkDate,
  resolveSmokeWorkDateCandidates,
  scanBlockingTimeCorrectionRequests,
  selectAvailableSmokeWorkDate,
} from './attendance-smoke-workdate.mjs'

test('isBlockingTimeCorrectionRequest matches the API request collision contract', () => {
  assert.equal(
    isBlockingTimeCorrectionRequest({
      request_type: 'time_correction',
      status: 'approved',
    }),
    true,
  )
  assert.equal(
    isBlockingTimeCorrectionRequest({
      requestType: 'time_correction',
      status: 'pending',
    }),
    true,
  )
  assert.equal(
    isBlockingTimeCorrectionRequest({
      request_type: 'time_correction',
      status: 'cancelled',
    }),
    false,
  )
  assert.equal(
    isBlockingTimeCorrectionRequest({ request_type: 'leave', status: 'approved' }),
    false,
  )
})

test('scanBlockingTimeCorrectionRequests follows production pagination to a blocking row', async () => {
  const calls = []
  const blocking = await scanBlockingTimeCorrectionRequests('2031-02-03', {
    pageSize: 2,
    maxPages: 3,
    fetchPage: async (request) => {
      calls.push(request)
      if (request.page === 1) {
        return {
          items: [
            { requestType: 'leave', status: 'approved' },
            { requestType: 'time_correction', status: 'cancelled' },
          ],
          total: 3,
        }
      }
      return {
        items: [{ requestType: 'time_correction', status: 'pending' }],
        total: 3,
      }
    },
  })

  assert.equal(blocking, true)
  assert.deepEqual(calls, [
    { workDate: '2031-02-03', page: 1, pageSize: 2 },
    { workDate: '2031-02-03', page: 2, pageSize: 2 },
  ])
})

test('scanBlockingTimeCorrectionRequests fails closed on an invalid page shape', async () => {
  await assert.rejects(
    scanBlockingTimeCorrectionRequests('2031-02-03', {
      fetchPage: async () => ({ total: 1 }),
    }),
    /missing items/,
  )
})

test('production smoke awaits the collision-aware work-date resolver', () => {
  const source = readFileSync(
    new URL('./attendance-smoke-api.mjs', import.meta.url),
    'utf8',
  )

  assert.match(
    source,
    /const workDate = await resolveAvailableSmokeWorkDate\(\)/,
  )
  assert.match(source, /scanBlockingTimeCorrectionRequests\(workDate,/)
})

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

test('resolveSmokeWorkDate uses the expanded long-lived date pool', () => {
  const workDate = resolveSmokeWorkDate({
    SMOKE_WORK_DATE_SEED: 'long-lived-pool-proof',
  })

  assert.ok(workDate > '2029-12-31')
  assert.ok(workDate <= '2124-12-31')
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

test('resolveSmokeWorkDateCandidates advances deterministically from the seeded date', () => {
  const env = {
    SMOKE_WORK_DATE_SEED: '/tmp/output/20260714-032248-2',
    GITHUB_RUN_ID: '29303345772',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_RUN_NUMBER: '900',
  }
  const first = resolveSmokeWorkDate(env)
  const candidates = resolveSmokeWorkDateCandidates(env, 4)

  assert.equal(candidates.length, 4)
  assert.equal(candidates[0], first)
  assert.deepEqual(
    candidates.map((value) => Date.parse(`${value}T00:00:00.000Z`)),
    candidates.map(
      (_value, index) =>
        Date.parse(`${first}T00:00:00.000Z`) +
        index * 24 * 60 * 60 * 1000,
    ),
  )
})

test('resolveSmokeWorkDateCandidates preserves an explicit operator override', () => {
  assert.deepEqual(
    resolveSmokeWorkDateCandidates({ SMOKE_WORK_DATE: '2031-02-03' }, 32),
    ['2031-02-03'],
  )
})

test('selectAvailableSmokeWorkDate advances past a historical request collision', async () => {
  const env = {
    SMOKE_WORK_DATE_SEED: '/tmp/output/20260714-032248-2',
    GITHUB_RUN_ID: '29303345772',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_RUN_NUMBER: '900',
  }
  const candidates = resolveSmokeWorkDateCandidates(env, 3)
  const checked = []
  const collisions = []

  const selected = await selectAvailableSmokeWorkDate(env, {
    maxCandidates: 3,
    hasBlockingRequest: async (candidate) => {
      checked.push(candidate)
      return candidate === candidates[0]
    },
    onCollision: (candidate) => collisions.push(candidate),
  })

  assert.equal(selected, candidates[1])
  assert.deepEqual(checked, candidates.slice(0, 2))
  assert.deepEqual(collisions, [candidates[0]])
})

test('selectAvailableSmokeWorkDate does not shift an explicit operator override', async () => {
  await assert.rejects(
    selectAvailableSmokeWorkDate(
      { SMOKE_WORK_DATE: '2031-02-03' },
      { hasBlockingRequest: async () => true },
    ),
    /across 1 deterministic candidate/,
  )
})
