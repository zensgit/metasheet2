'use strict'

const assert = require('node:assert/strict')

const {
  ANALYTICS_EXPORT_CLEANUP_JOB_KIND,
  ANALYTICS_EXPORT_JOB_KIND,
  analyticsExportInputFromJob,
  isAnalyticsExportEnabled,
  registerAnalyticsExportWorker,
} = require('../lib/analytics-export-worker.cjs')
const {
  clearJobHandlers,
  registeredKinds,
  runJobsTick,
} = require('../lib/jobs.cjs')
const { LOOKALIKES, withFlagsAsync } = require('./helpers.cjs')

const EXPORT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FLAGS = Object.freeze({
  ELEARNING_ENABLED: 'true',
  ELEARNING_ANALYTICS_ENABLED: 'true',
})

function job(kind = ANALYTICS_EXPORT_JOB_KIND, overrides = {}) {
  return {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    org_id: 'org-export-worker',
    kind,
    occurrence_key: kind === ANALYTICS_EXPORT_JOB_KIND
      ? `export:${EXPORT_ID}`
      : `export:${EXPORT_ID}:cleanup`,
    ref: EXPORT_ID,
    payload: { exportJobId: EXPORT_ID },
    due_at: new Date('2026-08-31T00:00:00.000Z'),
    attempts: 1,
    status: 'running',
    ...overrides,
  }
}

function databaseFor(claimed, finalized) {
  return {
    async query(sql, params) {
      if (sql.includes('FOR UPDATE SKIP LOCKED')) return [claimed]
      if (sql.includes("status = 'succeeded'")) {
        finalized.push(params)
        return [{ id: claimed.id }]
      }
      if (sql.includes('status = CASE')) {
        finalized.push(params)
        return [{ id: claimed.id, status: 'failed', last_error: params[4], attempts: 1 }]
      }
      return []
    },
  }
}

async function run(kind, port) {
  clearJobHandlers()
  registerAnalyticsExportWorker({ services: { elearningAnalyticsExport: port } })
  const finalized = []
  const claimed = job(kind)
  const result = await runJobsTick({
    database: databaseFor(claimed, finalized),
    workerId: 'worker-export',
    kinds: [kind],
  })
  clearJobHandlers()
  return { finalized, result }
}

async function main() {
  clearJobHandlers()
  await withFlagsAsync({}, async () => {
    assert.equal(isAnalyticsExportEnabled(), false)
    assert.equal(registerAnalyticsExportWorker({ services: {} }), false)
  })
  for (const lookalike of LOOKALIKES) {
    await withFlagsAsync({ ...FLAGS, ELEARNING_ANALYTICS_ENABLED: lookalike }, async () => {
      assert.equal(registerAnalyticsExportWorker({ services: {} }), false)
    })
  }
  await withFlagsAsync(FLAGS, async () => {
    assert.throws(
      () => registerAnalyticsExportWorker({ services: {} }),
      (error) => error && error.code === 'ANALYTICS_EXPORT_PORT_REQUIRED',
    )
    assert.deepEqual(registeredKinds(), [])
  })

  assert.deepEqual(analyticsExportInputFromJob(job(), ANALYTICS_EXPORT_JOB_KIND), {
    orgId: 'org-export-worker',
    exportId: EXPORT_ID,
  })
  for (const invalid of [
    null,
    job(ANALYTICS_EXPORT_JOB_KIND, { org_id: ' org-export-worker' }),
    job(ANALYTICS_EXPORT_JOB_KIND, { ref: EXPORT_ID.toUpperCase() }),
    job(ANALYTICS_EXPORT_JOB_KIND, { payload: {} }),
    job(ANALYTICS_EXPORT_JOB_KIND, { payload: { exportJobId: EXPORT_ID, extra: true } }),
    job(ANALYTICS_EXPORT_JOB_KIND, { occurrence_key: `export:${EXPORT_ID}:cleanup` }),
  ]) {
    assert.throws(
      () => analyticsExportInputFromJob(invalid, ANALYTICS_EXPORT_JOB_KIND),
      (error) => error && error.code === 'ANALYTICS_EXPORT_JOB_INVALID',
    )
  }

  await withFlagsAsync(FLAGS, async () => {
    const calls = []
    const port = {
      async materialize(input) {
        calls.push(['materialize', input])
        return { outcome: 'materialized', exportId: input.exportId }
      },
      async cleanup(input) {
        calls.push(['cleanup', input])
        return { outcome: 'expired', exportId: input.exportId }
      },
    }
    const materialized = await run(ANALYTICS_EXPORT_JOB_KIND, port)
    const cleaned = await run(ANALYTICS_EXPORT_CLEANUP_JOB_KIND, port)
    assert.equal(materialized.result.claimed, 1)
    assert.equal(cleaned.result.claimed, 1)
    assert.equal(materialized.finalized.length, 1)
    assert.equal(cleaned.finalized.length, 1)
    assert.deepEqual(calls, [
      ['materialize', { orgId: 'org-export-worker', exportId: EXPORT_ID }],
      ['cleanup', { orgId: 'org-export-worker', exportId: EXPORT_ID }],
    ])
  })

  await withFlagsAsync(FLAGS, async () => {
    const failed = await run(ANALYTICS_EXPORT_JOB_KIND, {
      async materialize() {
        return { outcome: 'unknown', exportId: EXPORT_ID }
      },
      async cleanup() {
        return { outcome: 'noop', exportId: EXPORT_ID }
      },
    })
    assert.equal(failed.finalized[0][4], 'ANALYTICS_EXPORT_UNAVAILABLE')
  })

  console.log('✓ analytics-export-worker: analytics-gated materialize and cleanup jobs')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
