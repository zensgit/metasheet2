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
const FILE = 'tests/integration/elearning-jobs.db.test.ts'
const STEP_ID = 'elearning-v01-content-assessment-schema-gate'
const MEDIA_DB_STEP_ID = 'elearning-v01-media-quota-real-db'
const VITEST_CFG = join(repoRoot, 'packages/core-backend/vitest.config.ts')
const WORKFLOW = join(repoRoot, '.github/workflows/plugin-tests.yml')
const SUITE = join(repoRoot, 'packages/core-backend', FILE)
const MIGRATION = join(
  repoRoot,
  'packages/core-backend/src/db/migrations/zzzz20260826160000_create_elearning_jobs.ts',
)
const JOBS_LIB = join(repoRoot, 'plugins/plugin-elearning/lib/jobs.cjs')
const JOBS_PLUGIN_TEST = join(repoRoot, 'plugins/plugin-elearning/__tests__/jobs.test.cjs')
const PLUGIN_PACKAGE = join(repoRoot, 'plugins/plugin-elearning/package.json')
const PLUGIN_INDEX = join(repoRoot, 'plugins/plugin-elearning/index.cjs')
const WIRING = 'scripts/ops/elearning-jobs-ci-wiring.test.mjs'

test('vitest.config.ts excludes the elearning jobs real-DB suite from the no-DB job', () => {
  const cfg = readFileSync(VITEST_CFG, 'utf8')
  assert.ok(
    isQuotedInTestExclude(cfg, FILE),
    `test.exclude must contain the exact quoted entry '${FILE}'`,
  )
})

test('plugin-tests.yml runs the jobs suite as a whole-file arg of the 20.x post-migrate schema step', () => {
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
  assert.equal(/\s-t(?:\s|=|$)/.test(run), false, 'jobs schema step must not use a -t filter')
  assert.equal(run.includes('--testNamePattern'), false, 'jobs schema step must not use --testNamePattern')

  const startPg = wf.indexOf('- name: Start Postgres')
  const migrateAt = wf.indexOf('pnpm --filter @metasheet/core-backend db:migrate')
  const stepAt = wf.indexOf(`id: ${STEP_ID}`)
  assert.ok(startPg >= 0, 'workflow must contain Start Postgres')
  assert.ok(migrateAt >= 0, 'workflow must contain the db:migrate command')
  assert.ok(stepAt > migrateAt, 'schema gate step must appear after db:migrate')
  assert.ok(startPg < migrateAt, 'Start Postgres must precede db:migrate')
  assert.match(
    wf.slice(stepAt, stepAt + 1600),
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
    /node --test scripts\/ops\/elearning-jobs-ci-wiring\.test\.mjs/,
    'plugin-tests.yml must run this wiring file as a whole-file node --test',
  )
  const wiringAt = wf.indexOf(WIRING)
  const installAt = wf.indexOf('pnpm install --frozen-lockfile')
  assert.ok(wiringAt >= 0, 'wiring path must appear in plugin-tests.yml')
  assert.ok(installAt >= 0, 'workflow must contain pnpm install --frozen-lockfile')
  assert.ok(wiringAt < installAt, 'jobs wiring contract must run before pnpm install')
})

test('wired jobs files exist on disk', () => {
  assert.ok(existsSync(SUITE), `wired suite packages/core-backend/${FILE} must exist on disk`)
  assert.ok(existsSync(MIGRATION), 'elearning_jobs migration must exist on disk')
  assert.ok(existsSync(JOBS_LIB), 'plugin jobs worker must exist on disk')
  assert.ok(existsSync(JOBS_PLUGIN_TEST), 'plugin jobs tests must exist on disk')
  assert.ok(existsSync(PLUGIN_PACKAGE), 'plugin-elearning package.json must exist on disk')
  assert.ok(existsSync(PLUGIN_INDEX), 'plugin-elearning index.cjs must exist on disk')
})

test('jobs real-DB suite throws when DATABASE_URL is missing (no describe.skip)', () => {
  const src = readFileSync(SUITE, 'utf8')
  assert.equal(src.includes('describe.skip'), false, 'jobs suite must not describe.skip')
  assert.equal(src.includes('.skip('), false, 'jobs suite must not skip')
  assert.match(src, /if \(!DATABASE_URL\)/)
  assert.match(src, /throw new Error/)
  assert.match(src, /refusing skip-shaped green/)
  assert.equal(src.includes('http.request'), false, 'jobs suite must not use http.request')
  assert.equal(src.includes('supertest'), false, 'jobs suite must not use supertest')
  assert.match(src, /FOR UPDATE SKIP LOCKED/)
  assert.match(src, /pool\.connect\(\)/)
  assert.match(src, /kysely_migration/)
  assert.equal(src.includes('await up(db)'), false, 'shared-schema tests must not re-run up()')
  assert.match(src, /42P07/)
  assert.match(src, /claimAttempt: 1/)
  assert.match(src, /worker-same/)
  assert.match(src, /kinds: \[kind\]/)
})

test('plugin jobs worker is claim-lease only: no enqueue HTTP, no attendance scheduler, master-off is first-stop', () => {
  const jobsSrc = readFileSync(JOBS_LIB, 'utf8')
  assert.match(jobsSrc, /FOR UPDATE SKIP LOCKED/)
  assert.match(jobsSrc, /lease_until IS NULL OR lease_until < now\(\)/)
  assert.match(jobsSrc, /due\.attempts >= \$5::int/)
  assert.match(jobsSrc, /due\.attempts < \$5::int/)
  assert.match(jobsSrc, /ATTEMPTS_EXHAUSTED/)
  assert.match(jobsSrc, /attempts = \$3::int/)
  assert.match(jobsSrc, /claim_worker_id = btrim\(\$4::text\)/)
  assert.match(jobsSrc, /workerGeneration/)
  assert.equal(
    jobsSrc.includes("due.status IN ('running', 'failed')"),
    false,
    'exhaust must dead-letter due pending as well as failed and expired-running',
  )
  assert.equal(jobsSrc.includes('http.addRoute'), false)
  assert.equal(jobsSrc.includes('/api/elearning/jobs'), false)
  assert.equal(/enqueue/i.test(jobsSrc), false)
  assert.equal(jobsSrc.includes('attendanceScheduler'), false)
  assert.match(jobsSrc, /TICK_INTERVAL_MS = 30_000/)

  const migration = readFileSync(MIGRATION, 'utf8')
  assert.equal(migration.includes('CREATE TABLE IF NOT EXISTS'), false)
  assert.equal(migration.includes('CREATE INDEX IF NOT EXISTS'), false)
  assert.match(migration, /CREATE TABLE elearning_jobs/)
  assert.match(migration, /\^\[A-Z\]\[A-Z0-9_\]\{1,63\}\$/)
  assert.match(migration, /claim_worker_id = btrim\(claim_worker_id\)/)

  const indexSrc = readFileSync(PLUGIN_INDEX, 'utf8')
  const stopAt = indexSrc.indexOf('stopJobsWorker()')
  const masterAt = indexSrc.indexOf('isMasterEnabled()')
  assert.ok(stopAt >= 0 && masterAt >= 0 && stopAt < masterAt)

  const pkg = JSON.parse(readFileSync(PLUGIN_PACKAGE, 'utf8'))
  const segments = String(pkg.scripts.test).split('&&').map((segment) => segment.trim())
  assert.equal(
    segments.includes('node __tests__/jobs.test.cjs'),
    true,
    'plugin-elearning scripts.test must chain jobs.test.cjs as a whole && segment',
  )
})
