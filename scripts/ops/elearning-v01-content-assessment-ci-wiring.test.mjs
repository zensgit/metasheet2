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
const STEP_ID = 'elearning-v01-content-assessment-schema-gate'
const VITEST_CFG = join(repoRoot, 'packages/core-backend/vitest.config.ts')
const WORKFLOW = join(repoRoot, '.github/workflows/plugin-tests.yml')
const SUITE = join(repoRoot, 'packages/core-backend', FILE)
const CONTENT_MIGRATION = join(
  repoRoot,
  'packages/core-backend/src/db/migrations/zzzz20260824120000_create_elearning_v01_content_assessment.ts',
)
const PERMISSION_MIGRATION = join(
  repoRoot,
  'packages/core-backend/src/db/migrations/zzzz20260824121000_add_elearning_permissions.ts',
)

test('vitest.config.ts excludes the elearning V0.1 schema gate from the no-DB job', () => {
  const cfg = readFileSync(VITEST_CFG, 'utf8')
  assert.ok(
    isQuotedInTestExclude(cfg, FILE),
    `test.exclude must contain the exact quoted entry '${FILE}'`,
  )
})

test('plugin-tests.yml runs the schema gate as a whole file on the 20.x real-DB step after migrate', () => {
  const wf = readFileSync(WORKFLOW, 'utf8')
  requireExecutableRealDbStep(wf, STEP_ID)
  assert.ok(
    isSuiteWiredInRealDbStep(wf, STEP_ID, FILE),
    `plugin-tests.yml real-DB step id "${STEP_ID}" (if 20.x + env.DATABASE_URL + ` +
      `vitest.integration.config.ts) must run ${FILE} as a whole-file vitest arg`,
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

  const migrateAt = wf.indexOf('pnpm --filter @metasheet/core-backend db:migrate')
  const stepAt = wf.indexOf(`id: ${STEP_ID}`)
  assert.ok(migrateAt >= 0, 'workflow must contain the db:migrate command')
  assert.ok(stepAt > migrateAt, 'schema gate step must appear after db:migrate')
  assert.match(
    wf.slice(stepAt, stepAt + 1200),
    /DATABASE_URL:\?/,
    'real-DB step run script must fail closed if DATABASE_URL is unset',
  )
})

test('wired suite and both Part A migrations exist on disk', () => {
  assert.ok(existsSync(SUITE), `wired suite packages/core-backend/${FILE} must exist on disk`)
  assert.ok(existsSync(CONTENT_MIGRATION), 'content/assessment migration must exist on disk')
  assert.ok(existsSync(PERMISSION_MIGRATION), 'elearning permissions migration must exist on disk')
})

test('schema gate source throws when DATABASE_URL is missing (no describe.skip)', () => {
  const src = readFileSync(SUITE, 'utf8')
  assert.equal(src.includes('describe.skip'), false)
  assert.match(src, /if \(!DATABASE_URL\)/)
  assert.match(src, /throw new Error/)
  assert.match(src, /refusing skip-shaped green/)
  assert.equal(src.includes('http.request'), false)
  assert.equal(src.includes('supertest'), false)
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
