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
const FILE = 'tests/integration/elearning-v01-content-assessment-schema.db.test.ts'
const WATCH_FILE = 'tests/integration/elearning-v01-watch-progress-schema.db.test.ts'
const STEP_ID = 'elearning-v01-content-assessment-schema-gate'
const VITEST_CFG = join(repoRoot, 'packages/core-backend/vitest.config.ts')
const WORKFLOW = join(repoRoot, '.github/workflows/plugin-tests.yml')
const SUITE = join(repoRoot, 'packages/core-backend', FILE)
const WATCH_SUITE = join(repoRoot, 'packages/core-backend', WATCH_FILE)
const CONTENT_MIGRATION = join(
  repoRoot,
  'packages/core-backend/src/db/migrations/zzzz20260824120000_create_elearning_v01_content_assessment.ts',
)
const PERMISSION_MIGRATION = join(
  repoRoot,
  'packages/core-backend/src/db/migrations/zzzz20260824121000_add_elearning_permissions.ts',
)
const WATCH_MIGRATION = join(
  repoRoot,
  'packages/core-backend/src/db/migrations/zzzz20260825120000_create_elearning_v01_watch_progress.ts',
)

test('vitest.config.ts excludes both elearning V0.1 schema gates from the no-DB job', () => {
  const cfg = readFileSync(VITEST_CFG, 'utf8')
  for (const file of [FILE, WATCH_FILE]) {
    assert.ok(
      isQuotedInTestExclude(cfg, file),
      `test.exclude must contain the exact quoted entry '${file}'`,
    )
  }
})

test('plugin-tests.yml runs both schema gates as whole-file siblings on the 20.x real-DB step after migrate', () => {
  const wf = readFileSync(WORKFLOW, 'utf8')
  const step = requireExecutableRealDbStep(wf, STEP_ID)
  for (const file of [FILE, WATCH_FILE]) {
    assert.ok(
      isSuiteWiredInRealDbStep(wf, STEP_ID, file),
      `plugin-tests.yml real-DB step id "${STEP_ID}" (if 20.x + env.DATABASE_URL + ` +
        `vitest.integration.config.ts) must run ${file} as a whole-file vitest arg`,
    )
    assert.equal(
      realDbStepWholeFileArgs(wf, REAL_DB_STEP_IDS.approval).includes(file),
      false,
      `${file} must not be wired into the approval real-DB step`,
    )
    assert.equal(
      realDbStepWholeFileArgs(wf, REAL_DB_STEP_IDS.multitable).includes(file),
      false,
      `${file} must not be wired into the multitable real-DB step`,
    )
  }
  const wired = realDbStepWholeFileArgs(wf, STEP_ID)
  assert.equal(wired.includes(FILE), true)
  assert.equal(wired.includes(WATCH_FILE), true)

  const run = typeof step.run === 'string' ? step.run : ''
  assert.equal(/\s-t(?:\s|=|$)/.test(run), false, 'schema gate step must not use a -t filter')
  assert.equal(run.includes('--testNamePattern'), false, 'schema gate step must not use --testNamePattern')

  const migrateAt = wf.indexOf('pnpm --filter @metasheet/core-backend db:migrate')
  const stepAt = wf.indexOf(`id: ${STEP_ID}`)
  assert.ok(migrateAt >= 0, 'workflow must contain the db:migrate command')
  assert.ok(stepAt > migrateAt, 'schema gate step must appear after db:migrate')
  assert.match(
    wf.slice(stepAt, stepAt + 1600),
    /DATABASE_URL:\?/,
    'real-DB step run script must fail closed if DATABASE_URL is unset',
  )
})

test('wired suites and content/watch migrations exist on disk', () => {
  assert.ok(existsSync(SUITE), `wired suite packages/core-backend/${FILE} must exist on disk`)
  assert.ok(existsSync(WATCH_SUITE), `wired suite packages/core-backend/${WATCH_FILE} must exist on disk`)
  assert.ok(existsSync(CONTENT_MIGRATION), 'content/assessment migration must exist on disk')
  assert.ok(existsSync(PERMISSION_MIGRATION), 'elearning permissions migration must exist on disk')
  assert.ok(existsSync(WATCH_MIGRATION), 'watch-progress migration must exist on disk')
})

test('schema gate sources throw when DATABASE_URL is missing (no describe.skip)', () => {
  for (const [label, path] of [
    ['content/assessment', SUITE],
    ['watch-progress', WATCH_SUITE],
  ]) {
    const src = readFileSync(path, 'utf8')
    assert.equal(src.includes('describe.skip'), false, `${label} must not describe.skip`)
    assert.match(src, /if \(!DATABASE_URL\)/)
    assert.match(src, /throw new Error/)
    assert.match(src, /refusing skip-shaped green/)
    assert.equal(src.includes('http.request'), false, `${label} must not use http.request`)
    assert.equal(src.includes('supertest'), false, `${label} must not use supertest`)
  }
})

test('schema gate uses dual PoolClient pg_locks barriers rather than sleep races', () => {
  const src = readFileSync(SUITE, 'utf8')
  assert.match(src, /type PoolClient/)
  assert.match(src, /pool\.connect\(\)/)
  assert.match(src, /holder: PoolClient/)
  assert.match(src, /waiter: PoolClient/)
  assert.match(src, /pg_locks/)
  assert.match(src, /lock_timeout/)
  assert.match(src, /pg_blocking_pids/)
  assert.match(src, /runLockBarrier/)
  assert.equal(src.includes('new Client('), false)
  assert.equal(src.includes('playwright'), false)
  assert.equal(src.includes('setTimeout(res, 500)'), false)
  assert.equal(src.includes('setTimeout(resolve, 500)'), false)
})
