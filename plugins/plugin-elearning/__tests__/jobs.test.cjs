'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { activate, deactivate } = require('../index.cjs')
const {
  TICK_INTERVAL_MS,
  CLAIM_SQL,
  FINALIZE_SUCCESS_SQL,
  FINALIZE_FAILURE_SQL,
  ATTEMPTS_EXHAUSTED,
  ERROR_CODE_RE,
  registerJobHandler,
  clearJobHandlers,
  registeredKinds,
  startJobsWorker,
  stopJobsWorker,
  getJobsWorkerState,
  claimDueJobs,
  finalizeJobSuccess,
  finalizeJobFailure,
  runJobsTick,
} = require('../lib/jobs.cjs')
const { LOOKALIKES, withFlagsAsync, createMockContext } = require('./helpers.cjs')

function createThrowingDatabase() {
  return new Proxy({}, {
    get() {
      throw new Error('elearning jobs must not touch the database')
    },
  })
}

function createFakeDatabase(handlers) {
  const queries = []
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params })
      if (typeof handlers.query === 'function') return handlers.query(sql, params)
      return []
    },
  }
}

function createContext(database) {
  const { context, routes } = createMockContext()
  if (database) context.api.database = database
  return { context, routes }
}

async function main() {
  stopJobsWorker()
  clearJobHandlers()

  assert.equal(TICK_INTERVAL_MS >= 30_000, true)
  assert.equal(TICK_INTERVAL_MS <= 60_000, true)
  assert.equal(ATTEMPTS_EXHAUSTED, 'ATTEMPTS_EXHAUSTED')
  assert.equal(ERROR_CODE_RE.test(ATTEMPTS_EXHAUSTED), true)
  assert.equal(ERROR_CODE_RE.test('HANDLER_FAILED'), true)
  assert.equal(ERROR_CODE_RE.test('bad code'), false)
  assert.match(CLAIM_SQL, /FOR UPDATE SKIP LOCKED/)
  assert.match(CLAIM_SQL, /lease_until IS NULL OR lease_until < now\(\)/)
  assert.match(CLAIM_SQL, /kind = ANY\(\$1::text\[\]\)/)
  assert.match(CLAIM_SQL, /due\.attempts >= \$5::int/)
  assert.match(CLAIM_SQL, /due\.attempts < \$5::int/)
  assert.match(CLAIM_SQL, /ATTEMPTS_EXHAUSTED/)
  assert.equal(
    CLAIM_SQL.includes("due.status IN ('running', 'failed')"),
    false,
    'exhaust must dead-letter due pending as well as failed and expired-running',
  )
  assert.match(FINALIZE_SUCCESS_SQL, /claim_worker_id = \$2/)
  assert.match(FINALIZE_SUCCESS_SQL, /attempts = \$3::int/)
  assert.match(FINALIZE_SUCCESS_SQL, /lease_until > now\(\)/)
  assert.match(FINALIZE_FAILURE_SQL, /claim_worker_id = \$2/)
  assert.match(FINALIZE_FAILURE_SQL, /attempts = \$3::int/)
  assert.match(FINALIZE_FAILURE_SQL, /lease_until > now\(\)/)

  const jobsSrc = fs.readFileSync(path.join(__dirname, '../lib/jobs.cjs'), 'utf8')
  assert.equal(jobsSrc.includes('http.addRoute'), false)
  assert.equal(jobsSrc.includes('/api/elearning/jobs'), false)
  assert.equal(/enqueue/i.test(jobsSrc), false)
  assert.equal(jobsSrc.includes('attendanceScheduler'), false)
  assert.match(jobsSrc, /void runJobsTick\(\)\.catch\(/)

  const indexSrc = fs.readFileSync(path.join(__dirname, '../index.cjs'), 'utf8')
  const stopAt = indexSrc.indexOf('stopJobsWorker()')
  const masterAt = indexSrc.indexOf('isMasterEnabled()')
  const dbPortAt = indexSrc.indexOf("plugin-elearning requires context.api.database.query")
  const addRouteAt = indexSrc.indexOf('context.api.http.addRoute(CANONICAL_METHOD')
  const startAt = indexSrc.indexOf('startJobsWorker(context)')
  const deactivateAt = indexSrc.indexOf('async function deactivate')
  assert.ok(stopAt >= 0, 'activate must stop the prior timer')
  assert.ok(masterAt >= 0)
  assert.ok(stopAt < masterAt, 'hot reload must stop the prior timer before master-off return')
  assert.ok(dbPortAt > masterAt, 'DB port is required only after the master gate')
  assert.ok(addRouteAt > dbPortAt, 'missing DB port must fail closed before addRoute')
  assert.ok(startAt > addRouteAt, 'worker starts only after routes')
  assert.match(indexSrc.slice(deactivateAt, deactivateAt + 120), /stopJobsWorker\(\)/)

  await withFlagsAsync({}, async () => {
    const database = createThrowingDatabase()
    const { context, routes } = createContext(database)
    await activate(context)
    assert.equal(routes.length, 0)
    assert.equal(getJobsWorkerState().running, false)
    assert.equal(getJobsWorkerState().timer, null)
  })

  await withFlagsAsync({ ELEARNING_ENABLED: 'false' }, async () => {
    const { context } = createContext(createThrowingDatabase())
    await activate(context)
    assert.equal(getJobsWorkerState().running, false)
  })

  for (const lookalike of LOOKALIKES) {
    await withFlagsAsync({ ELEARNING_ENABLED: lookalike }, async () => {
      const { context } = createContext(createThrowingDatabase())
      await activate(context)
      assert.equal(
        getJobsWorkerState().running,
        false,
        `master lookalike ${JSON.stringify(lookalike)} must not start the jobs worker`,
      )
    })
  }

  await withFlagsAsync({ ELEARNING_ENABLED: 'true' }, async () => {
    const { context, routes } = createMockContext()
    await assert.rejects(
      () => activate(context),
      /plugin-elearning requires context\.api\.database\.query/,
    )
    assert.equal(routes.length, 0, 'missing DB port must not register routes')
    assert.equal(getJobsWorkerState().running, false)
  })

  await withFlagsAsync({ ELEARNING_ENABLED: 'true' }, async () => {
    const { context, routes } = createMockContext()
    context.api.database = {}
    await assert.rejects(
      () => activate(context),
      /plugin-elearning requires context\.api\.database\.query/,
    )
    assert.equal(routes.length, 0)
    assert.equal(getJobsWorkerState().running, false)
  })

  await withFlagsAsync({ ELEARNING_ENABLED: 'true' }, async () => {
    const database = createFakeDatabase({})
    const { context } = createContext(database)
    await activate(context)
    assert.equal(getJobsWorkerState().running, true)
    assert.equal(getJobsWorkerState().intervalMs, TICK_INTERVAL_MS)
    assert.equal(database.queries.length, 0, 'starting the timer must not query')
    await deactivate()
    assert.equal(getJobsWorkerState().running, false)
    assert.equal(getJobsWorkerState().timer, null)
    assert.equal(database.queries.length, 0)
  })

  await withFlagsAsync({ ELEARNING_ENABLED: 'true' }, async () => {
    const database = createFakeDatabase({})
    const { context } = createContext(database)
    await activate(context)
    const firstTimer = getJobsWorkerState().timer
    assert.ok(firstTimer)
    await activate(context)
    const secondTimer = getJobsWorkerState().timer
    assert.ok(secondTimer)
    assert.notEqual(secondTimer, firstTimer, 'hot reload must replace the prior timer')
    await deactivate()
    assert.equal(getJobsWorkerState().running, false)
  })

  await withFlagsAsync({ ELEARNING_ENABLED: 'true' }, async () => {
    const database = createFakeDatabase({})
    startJobsWorker({ api: { database } })
    assert.equal(getJobsWorkerState().running, true)
    await assert.rejects(
      () => activate({ api: {} }),
      /plugin-elearning requires context\.api\.http\.addRoute/,
    )
    assert.equal(
      getJobsWorkerState().running,
      false,
      'activate must stop the prior timer before throwing',
    )
  })

  await withFlagsAsync({ ELEARNING_ENABLED: 'true' }, async () => {
    const database = createFakeDatabase({})
    const { context, routes } = createMockContext()
    startJobsWorker({ api: { database } })
    assert.equal(getJobsWorkerState().running, true)
    await assert.rejects(
      () => activate(context),
      /plugin-elearning requires context\.api\.database\.query/,
    )
    assert.equal(routes.length, 0)
    assert.equal(getJobsWorkerState().running, false)
  })

  await withFlagsAsync({ ELEARNING_ENABLED: 'true' }, async () => {
    const database = createFakeDatabase({})
    startJobsWorker({ api: { database } })
    assert.equal(getJobsWorkerState().running, true)
    await withFlagsAsync({}, async () => {
      const { context } = createContext(createThrowingDatabase())
      await activate(context)
    })
    assert.equal(getJobsWorkerState().running, false, 'master-off hot reload must stop the timer')
  })

  {
    assert.throws(() => registerJobHandler('', async () => {}), /handler kind is required/)
    assert.throws(() => registerJobHandler('  ', async () => {}), /handler kind is required/)
    assert.throws(() => registerJobHandler(' boom', async () => {}), /handler kind is required/)
    assert.throws(() => registerJobHandler('boom ', async () => {}), /handler kind is required/)
    registerJobHandler('boom', async () => {})
    assert.deepEqual(registeredKinds(), ['boom'])
    assert.throws(() => registerJobHandler('boom', async () => {}), /already registered/)
    assert.throws(
      () => registerJobHandler('other', async () => {}, true),
      /canClaim must be a function/,
    )
    assert.deepEqual(registeredKinds(), ['boom'])
    clearJobHandlers()
  }

  {
    for (const canClaim of [() => false, () => { throw new Error('gate failed') }]) {
      let queries = 0
      registerJobHandler('disabled', async () => {
        throw new Error('disabled handler must not run')
      }, canClaim)
      const result = await runJobsTick({
        database: {
          query: async () => {
            queries += 1
            throw new Error('disabled kind must not query')
          },
        },
        workerId: 'worker-disabled',
      })
      assert.deepEqual(result, { claimed: 0 })
      assert.equal(queries, 0)
      assert.deepEqual(registeredKinds(), ['disabled'])
      clearJobHandlers()
    }
  }

  {
    registerJobHandler('noop', async () => {})
    const claimed = await claimDueJobs(null, { workerId: 'w1' })
    assert.deepEqual(claimed, [])
    const skipped = await claimDueJobs(
      { query: async () => { throw new Error('must not query without kinds') } },
      { kinds: [], workerId: 'w1' },
    )
    assert.deepEqual(skipped, [])
    const spaced = await claimDueJobs(
      { query: async () => { throw new Error('must not query with whitespace kinds') } },
      { kinds: [' boom'], workerId: 'w1' },
    )
    assert.deepEqual(spaced, [])
    clearJobHandlers()
    const noKinds = await claimDueJobs(
      { query: async () => { throw new Error('must not query without registered handlers') } },
      { workerId: 'w1' },
    )
    assert.deepEqual(noKinds, [])
  }

  {
    registerJobHandler('registered', async () => {})
    const queried = []
    const unregistered = await claimDueJobs(
      {
        query: async (_sql, params) => {
          queried.push(params)
          throw new Error('must not claim an unregistered explicit kind')
        },
      },
      { kinds: ['unregistered', 'unregistered'], workerId: 'w1' },
    )
    assert.deepEqual(unregistered, [])
    assert.deepEqual(queried, [])

    const mixed = await claimDueJobs(
      {
        query: async (_sql, params) => {
          queried.push(params[0])
          return []
        },
      },
      { kinds: ['unregistered', 'registered', 'registered', ' boom'], workerId: 'w1' },
    )
    assert.deepEqual(mixed, [])
    assert.deepEqual(queried, [['registered']])
    clearJobHandlers()
  }

  {
    const jobId = '11111111-1111-4111-8111-111111111111'
    const invalidAttempts = ['1', 1.5, 0, Number.NaN, Number.POSITIVE_INFINITY]
    for (const value of invalidAttempts) {
      for (const key of ['claimAttempt', 'attempt']) {
        let queried = 0
        const database = {
          query: async () => {
            queried += 1
            throw new Error('must not query with a coerced claimAttempt')
          },
        }
        const input = { jobId, workerId: 'w1', code: 'HANDLER_FAILED', [key]: value }
        assert.equal(await finalizeJobSuccess(database, input), false, `${key}=${String(value)} success`)
        assert.equal(queried, 0, `${key}=${String(value)} success must not query`)
        assert.equal(await finalizeJobFailure(database, input), false, `${key}=${String(value)} failure`)
        assert.equal(queried, 0, `${key}=${String(value)} failure must not query`)
      }
    }
    assert.equal(
      await finalizeJobSuccess(
        { query: async () => { throw new Error('finalize requires claimAttempt') } },
        { jobId, workerId: 'w1' },
      ),
      false,
    )
    assert.equal(
      await finalizeJobFailure(
        { query: async () => { throw new Error('finalize requires claimAttempt') } },
        { jobId, workerId: 'w1', code: 'HANDLER_FAILED' },
      ),
      false,
    )
  }

  {
    const rejections = []
    const onUnhandled = (error) => {
      rejections.push(error)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      registerJobHandler('boom', async () => {
        throw new Error('handler exploded')
      })
      const database = createFakeDatabase({
        query: async (sql) => {
          if (sql.includes('FOR UPDATE SKIP LOCKED')) {
            return [{
              id: '11111111-1111-4111-8111-111111111111',
              org_id: 'org-test',
              kind: 'boom',
              occurrence_key: 'occ-1',
              ref: null,
              payload: {},
              attempts: 1,
              status: 'running',
            }]
          }
          return [{ id: '11111111-1111-4111-8111-111111111111' }]
        },
      })
      const result = await runJobsTick({ database, workerId: 'worker-a', logger: { warn() {} } })
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(result.claimed, 1)
      assert.equal(rejections.length, 0, 'handler throw must not become unhandledRejection')
      assert.equal(
        database.queries.some((entry) => entry.sql.includes("status = CASE")),
        true,
        'handler throw must attempt fenced failure finalization',
      )
      assert.equal(
        database.queries.some((entry) => Array.isArray(entry.params) && entry.params.includes(8)),
        true,
        'claim/finalize must pass maxAttempts',
      )
      assert.equal(
        database.queries.some((entry) => (
          entry.sql.includes('attempts = $3::int') && Array.isArray(entry.params) && entry.params[2] === 1
        )),
        true,
        'runJobsTick must finalize with the claimed row attempts',
      )
    } finally {
      process.off('unhandledRejection', onUnhandled)
      clearJobHandlers()
      stopJobsWorker()
    }
  }

  {
    const rejections = []
    const onUnhandled = (error) => {
      rejections.push(error)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      registerJobHandler('boom-tick', async () => {
        throw Object.assign(new Error('tick exploded'), { code: 'HANDLER_FAILED' })
      })
      const database = {
        query: async () => {
          throw new Error('claim exploded')
        },
      }
      const result = await runJobsTick({ database, workerId: 'worker-b' })
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(result.claimed, 0)
      assert.equal(rejections.length, 0, 'claim throw must not become unhandledRejection')
    } finally {
      process.off('unhandledRejection', onUnhandled)
      clearJobHandlers()
      stopJobsWorker()
    }
  }

  {
    let releaseFirst
    let firstStarted
    const firstGate = new Promise((resolve) => {
      firstStarted = resolve
    })
    const firstHold = new Promise((resolve) => {
      releaseFirst = resolve
    })
    let secondRan = false
    registerJobHandler('kind-a', async () => {
      firstStarted()
      await firstHold
    })
    registerJobHandler('kind-b', async () => {
      secondRan = true
    })
    const database = createFakeDatabase({
      query: async (sql) => {
        if (sql.includes('FOR UPDATE SKIP LOCKED')) {
          return [
            {
              id: '11111111-1111-4111-8111-111111111111',
              kind: 'kind-a',
              attempts: 1,
              status: 'running',
            },
            {
              id: '22222222-2222-4222-8222-222222222222',
              kind: 'kind-b',
              attempts: 1,
              status: 'running',
            },
          ]
        }
        return [{ id: '11111111-1111-4111-8111-111111111111' }]
      },
    })
    const tick = runJobsTick({
      database,
      workerId: 'worker-gen',
    })
    await firstGate
    stopJobsWorker()
    releaseFirst()
    const result = await tick
    assert.equal(result.claimed, 2)
    assert.equal(secondRan, false, 'stop must not start a later handler in the claimed batch')
    assert.equal(
      database.queries.some((entry) => (
        entry.sql.includes('status = \'succeeded\'')
        && Array.isArray(entry.params)
        && entry.params[0] === '11111111-1111-4111-8111-111111111111'
        && entry.params[2] === 1
      )),
      true,
      'the in-flight handler may finish and be finalized',
    )
    assert.equal(
      database.queries.some((entry) => (
        Array.isArray(entry.params) && entry.params[0] === '22222222-2222-4222-8222-222222222222'
      )),
      false,
      'the second claimed job must not be finalized after stop',
    )
    clearJobHandlers()
  }

  stopJobsWorker()
  clearJobHandlers()
  console.log('✓ jobs: OFF/no-DB/hot-reload/start-stop and no unhandled interval rejection')
}

main().catch((error) => {
  stopJobsWorker()
  clearJobHandlers()
  console.error(error)
  process.exit(1)
})
