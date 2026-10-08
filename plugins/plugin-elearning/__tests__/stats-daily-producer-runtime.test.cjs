'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  PRODUCER_INTERVAL_MS,
  getStatsDailyProducerRuntimeState,
  runStatsDailyProducerTick,
  startStatsDailyProducerRuntime,
  stopStatsDailyProducerRuntime,
  validateProducerResult,
} = require('../lib/stats-daily-producer-runtime.cjs')
const { withFlagsAsync } = require('./helpers.cjs')

const FLAGS_ON = Object.freeze({
  ELEARNING_ENABLED: 'true',
  ELEARNING_ANALYTICS_ENABLED: 'true',
})

function port(enqueueDue) {
  return {
    elearningStatsDailyProjection: {
      async enqueueDue() {
        return enqueueDue()
      },
      async project() {
        return { outcome: 'noop', projectedVersion: 1, suppressed: true }
      },
    },
  }
}

async function main() {
  stopStatsDailyProducerRuntime()
  assert.equal(PRODUCER_INTERVAL_MS, 60_000)

  const source = fs.readFileSync(
    path.join(__dirname, '../lib/stats-daily-producer-runtime.cjs'),
    'utf8',
  )
  const indexSource = fs.readFileSync(path.join(__dirname, '../index.cjs'), 'utf8')
  assert.equal(source.includes('attendanceScheduler'), false)
  assert.match(indexSource, /startStatsDailyProducerRuntime\(context\)/)
  assert.match(indexSource, /stopStatsDailyProducerRuntime\(\)/)

  await withFlagsAsync({}, async () => {
    const throwingContext = new Proxy({}, {
      get() { throw new Error('flags OFF must not inspect context') },
    })
    assert.equal(startStatsDailyProducerRuntime(throwingContext), false)
    assert.equal(getStatsDailyProducerRuntimeState().running, false)
  })

  await withFlagsAsync(FLAGS_ON, async () => {
    assert.throws(
      () => startStatsDailyProducerRuntime({ services: {} }),
      (error) => error && error.code === 'STATS_DAILY_PRODUCER_PORT_REQUIRED',
    )
    assert.equal(getStatsDailyProducerRuntimeState().running, false)
  })

  await withFlagsAsync(FLAGS_ON, async () => {
    let calls = 0
    const services = port(async () => {
      calls += 1
      return { statsDate: '2026-08-29', enqueuedCount: 3 }
    })
    assert.equal(startStatsDailyProducerRuntime({ services }), true)
    assert.equal(getStatsDailyProducerRuntimeState().running, true)
    assert.equal(calls, 0, 'start must not enqueue before the first bounded tick')
    assert.deepEqual(await runStatsDailyProducerTick(), {
      statsDate: '2026-08-29',
      enqueuedCount: 3,
    })
    assert.equal(calls, 1)
    stopStatsDailyProducerRuntime()
    assert.equal(getStatsDailyProducerRuntimeState().running, false)
  })

  await withFlagsAsync(FLAGS_ON, async () => {
    let calls = 0
    const services = port(async () => {
      calls += 1
      return { statsDate: '2026-08-29', enqueuedCount: 0 }
    })
    startStatsDailyProducerRuntime({ services })
    delete process.env.ELEARNING_ANALYTICS_ENABLED
    assert.deepEqual(await runStatsDailyProducerTick(), {
      enqueuedCount: 0,
      skipped: true,
    })
    assert.equal(calls, 0)
    stopStatsDailyProducerRuntime()
  })

  await withFlagsAsync(FLAGS_ON, async () => {
    let release
    const held = new Promise((resolve) => { release = resolve })
    const started = new Promise((resolve) => {
      startStatsDailyProducerRuntime({
        services: port(async () => {
          resolve()
          await held
          return { statsDate: '2026-08-29', enqueuedCount: 1 }
        }),
      })
    })
    const first = runStatsDailyProducerTick()
    await started
    assert.deepEqual(await runStatsDailyProducerTick(), {
      enqueuedCount: 0,
      skipped: true,
    })
    release()
    assert.deepEqual(await first, { statsDate: '2026-08-29', enqueuedCount: 1 })
    stopStatsDailyProducerRuntime()
  })

  for (const invalid of [
    null,
    { statsDate: '2026-02-30', enqueuedCount: 0 },
    { statsDate: '2026-08-29', enqueuedCount: -1 },
    { statsDate: '2026-08-29', enqueuedCount: 1.5 },
    { statsDate: '2026-08-29', enqueuedCount: 0, extra: true },
  ]) {
    assert.throws(
      () => validateProducerResult(invalid),
      (error) => error && error.code === 'STATS_DAILY_PRODUCER_UNAVAILABLE',
    )
  }

  await withFlagsAsync(FLAGS_ON, async () => {
    await assert.rejects(
      () => runStatsDailyProducerTick({
        port: {
          async enqueueDue() {
            throw Object.assign(new Error('database detail'), { code: 'unavailable' })
          },
        },
      }),
      (error) => error && error.code === 'STATS_DAILY_PRODUCER_UNAVAILABLE',
    )
  })

  console.log('✓ stats-daily-producer-runtime: UTC-day jobs, no attendance scheduler')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
