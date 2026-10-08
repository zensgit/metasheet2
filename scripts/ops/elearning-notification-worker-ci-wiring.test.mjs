import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  REAL_DB_STEP_IDS,
  isQuotedInTestExclude,
  isSuiteWiredInRealDbStep,
  realDbStepWholeFileArgs,
  requireExecutableRealDbStep,
} from './ci-realdb-step-contract.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const FILE = 'tests/integration/elearning-notification-worker.db.test.ts'
const STEP_ID = 'elearning-v01-content-assessment-schema-gate'
const MEDIA_DB_STEP_ID = 'elearning-v01-media-quota-real-db'
const VITEST_CFG = join(repoRoot, 'packages/core-backend/vitest.config.ts')
const WORKFLOW = join(repoRoot, '.github/workflows/plugin-tests.yml')
const SUITE = join(repoRoot, 'packages/core-backend', FILE)
const WORKER_LIB = join(repoRoot, 'plugins/plugin-elearning/lib/notification-worker.cjs')
const WORKER_PLUGIN_TEST = join(
  repoRoot,
  'plugins/plugin-elearning/__tests__/notification-worker.test.cjs',
)
const PLUGIN_PACKAGE = join(repoRoot, 'plugins/plugin-elearning/package.json')
const PLUGIN_INDEX = join(repoRoot, 'plugins/plugin-elearning/index.cjs')
const WIRING = 'scripts/ops/elearning-notification-worker-ci-wiring.test.mjs'

test('vitest.config.ts excludes the notification-worker real-DB suite from the no-DB job', () => {
  const cfg = readFileSync(VITEST_CFG, 'utf8')
  assert.ok(
    isQuotedInTestExclude(cfg, FILE),
    `test.exclude must contain the exact quoted entry '${FILE}'`,
  )
})

test('plugin-tests.yml runs the worker suite as a whole-file arg of the 20.x post-migrate schema step', () => {
  const wf = readFileSync(WORKFLOW, 'utf8')
  const step = requireExecutableRealDbStep(wf, STEP_ID)
  assert.ok(
    isSuiteWiredInRealDbStep(wf, STEP_ID, FILE),
    `plugin-tests.yml real-DB step id "${STEP_ID}" must run ${FILE} as a whole-file vitest arg`,
  )
  assert.equal(
    realDbStepWholeFileArgs(wf, REAL_DB_STEP_IDS.approval).includes(FILE),
    false,
    `${FILE} must not be wired into the approval real-DB step`,
  )
  assert.equal(
    realDbStepWholeFileArgs(wf, REAL_DB_STEP_IDS.multitable).includes(FILE),
    false,
    `${FILE} must not be wired into the multitable real-DB step`,
  )
  assert.equal(
    realDbStepWholeFileArgs(wf, MEDIA_DB_STEP_ID).includes(FILE),
    false,
    `${FILE} must stay in the schema/service step, not the quota/reconciler step`,
  )

  const run = typeof step.run === 'string' ? step.run : ''
  assert.equal(/\s-t(?:\s|=|$)/.test(run), false, 'worker schema step must not use a -t filter')
  assert.equal(run.includes('--testNamePattern'), false, 'worker schema step must not use --testNamePattern')

  const startPg = wf.indexOf('- name: Start Postgres')
  const migrateAt = wf.indexOf('pnpm --filter @metasheet/core-backend db:migrate')
  const stepAt = wf.indexOf(`id: ${STEP_ID}`)
  assert.ok(startPg >= 0, 'workflow must contain Start Postgres')
  assert.ok(migrateAt >= 0, 'workflow must contain the db:migrate command')
  assert.ok(stepAt > migrateAt, 'schema gate step must appear after db:migrate')
  assert.ok(startPg < migrateAt, 'Start Postgres must precede db:migrate')
  assert.match(
    wf.slice(stepAt, stepAt + 1800),
    /DATABASE_URL:\?/,
    'real-DB step run script must fail closed if DATABASE_URL is unset',
  )

  const hits = []
  for (let from = 0; ; ) {
    const at = wf.indexOf(FILE, from)
    if (at < 0) break
    hits.push(at)
    from = at + FILE.length
  }
  assert.equal(hits.length, 1, `${FILE} must appear exactly once in plugin-tests.yml`)
  assert.ok(hits[0] > startPg, `${FILE} must appear only after Start Postgres`)
  assert.ok(hits[0] > migrateAt, `${FILE} must appear only after db:migrate`)
})

test('plugin-tests.yml executes this wiring contract as a whole-file node --test before pnpm install', () => {
  const wf = readFileSync(WORKFLOW, 'utf8')
  assert.match(
    wf,
    /node --test scripts\/ops\/elearning-notification-worker-ci-wiring\.test\.mjs/,
    'plugin-tests.yml must run this wiring file as a whole-file node --test',
  )
  const wiringAt = wf.indexOf(WIRING)
  const installAt = wf.indexOf('pnpm install --frozen-lockfile')
  assert.ok(wiringAt >= 0, 'wiring path must appear in plugin-tests.yml')
  assert.ok(installAt >= 0, 'workflow must contain pnpm install --frozen-lockfile')
  assert.ok(wiringAt < installAt, 'notification-worker wiring contract must run before pnpm install')
})

test('wired notification-worker files exist on disk', () => {
  assert.ok(existsSync(SUITE), `wired suite packages/core-backend/${FILE} must exist on disk`)
  assert.ok(existsSync(WORKER_LIB), 'plugin notification worker must exist on disk')
  assert.ok(existsSync(WORKER_PLUGIN_TEST), 'plugin notification-worker tests must exist on disk')
  assert.ok(existsSync(PLUGIN_PACKAGE), 'plugin-elearning package.json must exist on disk')
  assert.ok(existsSync(PLUGIN_INDEX), 'plugin-elearning index.cjs must exist on disk')
})

test('worker real-DB suite throws when DATABASE_URL is missing (no describe.skip)', () => {
  const src = readFileSync(SUITE, 'utf8')
  assert.equal(src.includes('describe.skip'), false, 'worker suite must not describe.skip')
  assert.equal(src.includes('.skip('), false, 'worker suite must not skip')
  assert.match(src, /if \(!DATABASE_URL\)/)
  assert.match(src, /throw new Error/)
  assert.match(src, /refusing skip-shaped green/)
  assert.equal(src.includes('http.request'), false, 'worker suite must not use http.request')
  assert.equal(src.includes('supertest'), false, 'worker suite must not use supertest')
  assert.match(src, /FOR UPDATE SKIP LOCKED/)
  assert.match(src, /pool\.connect\(\)/)
  assert.match(src, /kysely_migration/)
  assert.equal(src.includes('await up(db)'), false, 'shared-schema tests must not re-run up()')
  assert.match(src, /worker-left/)
  assert.match(src, /worker-right/)
  assert.match(src, /outcome_unknown/)
  assert.match(src, /NOT_ELIGIBLE/)
})

test('plugin notification worker is claim-lease only: no timer, route, flag, or plugin activation', () => {
  const workerSrc = readFileSync(WORKER_LIB, 'utf8')
  assert.match(workerSrc, /FOR UPDATE SKIP LOCKED/)
  assert.match(workerSrc, /status IN \('pending', 'retrying'\)/)
  assert.match(workerSrc, /claim_expires_at <= now\(\)/)
  assert.match(workerSrc, /attempt_count = delivery\.attempt_count \+ 1/)
  assert.match(workerSrc, /attempt_count = \$3::int/)
  assert.match(workerSrc, /claim_worker_id = btrim\(\$3::text\)/)
  assert.match(workerSrc, /NOT_ELIGIBLE/)
  assert.match(workerSrc, /OUTCOME_UNKNOWN/)
  assert.equal(workerSrc.includes('setInterval'), false)
  assert.equal(workerSrc.includes('http.addRoute'), false)
  assert.equal(workerSrc.includes('/api/elearning'), false)
  assert.equal(workerSrc.includes('context.services.notification'), false)
  assert.equal(workerSrc.includes('attendanceScheduler'), false)
  assert.equal(workerSrc.includes('process.env'), false)

  const indexSrc = readFileSync(PLUGIN_INDEX, 'utf8')
  assert.equal(indexSrc.includes('notification-worker'), false)
  assert.equal(indexSrc.includes('runNotificationDeliveryBatch'), false)

  const pkg = JSON.parse(readFileSync(PLUGIN_PACKAGE, 'utf8'))
  const segments = String(pkg.scripts.test).split('&&').map((segment) => segment.trim())
  assert.equal(
    segments.includes('node __tests__/notification-worker.test.cjs'),
    true,
    'plugin-elearning scripts.test must chain notification-worker.test.cjs as a whole && segment',
  )
})
