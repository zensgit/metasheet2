import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
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
const ATTEMPT_MIGRATION_FILE = 'tests/integration/elearning-exam-attempt-item-migration.db.test.ts'
const WATCH_FILE = 'tests/integration/elearning-v01-watch-progress-schema.db.test.ts'
const SERVICE_FILE = 'tests/integration/elearning-watch-progress-service.db.test.ts'
const ASSIGNMENT_FILE = 'tests/integration/elearning-direct-assignment.db.test.ts'
const PUBLISH_FILE = 'tests/integration/elearning-course-publish.db.test.ts'
const EXAM_FILE = 'tests/integration/elearning-exam-service.db.test.ts'
const LEARNER_FILE = 'tests/integration/elearning-learner-courses.db.test.ts'
const SCOPE_FILE = 'tests/integration/elearning-scope-access.db.test.ts'
const PLAYBACK_FILE = 'tests/integration/elearning-media-playback.db.test.ts'
const ROLE_TEMPLATE_FILE = 'tests/integration/elearning-role-templates.db.test.ts'
const MANUAL_GRADING_SERVICE_FILE =
  'tests/integration/elearning-manual-grading-service.db.test.ts'
const STEP_ID = 'elearning-v01-content-assessment-schema-gate'
const MEDIA_DB_STEP_ID = 'elearning-v01-media-quota-real-db'
const VITEST_CFG = join(repoRoot, 'packages/core-backend/vitest.config.ts')
const WORKFLOW = join(repoRoot, '.github/workflows/plugin-tests.yml')
const INTEGRATION_DIR = join(repoRoot, 'packages/core-backend/tests/integration')
const SUITE = join(repoRoot, 'packages/core-backend', FILE)
const ATTEMPT_MIGRATION_SUITE = join(repoRoot, 'packages/core-backend', ATTEMPT_MIGRATION_FILE)
const WATCH_SUITE = join(repoRoot, 'packages/core-backend', WATCH_FILE)
const SERVICE_SUITE = join(repoRoot, 'packages/core-backend', SERVICE_FILE)
const ASSIGNMENT_SUITE = join(repoRoot, 'packages/core-backend', ASSIGNMENT_FILE)
const PUBLISH_SUITE = join(repoRoot, 'packages/core-backend', PUBLISH_FILE)
const EXAM_SUITE = join(repoRoot, 'packages/core-backend', EXAM_FILE)
const LEARNER_SUITE = join(repoRoot, 'packages/core-backend', LEARNER_FILE)
const SCOPE_SUITE = join(repoRoot, 'packages/core-backend', SCOPE_FILE)
const PLAYBACK_SUITE = join(repoRoot, 'packages/core-backend', PLAYBACK_FILE)
const ROLE_TEMPLATE_SUITE = join(repoRoot, 'packages/core-backend', ROLE_TEMPLATE_FILE)
const MANUAL_GRADING_SERVICE_SUITE = join(
  repoRoot,
  'packages/core-backend',
  MANUAL_GRADING_SERVICE_FILE,
)
const GATE_FILES = [
  FILE,
  ATTEMPT_MIGRATION_FILE,
  WATCH_FILE,
  SERVICE_FILE,
  ASSIGNMENT_FILE,
  PUBLISH_FILE,
  EXAM_FILE,
  LEARNER_FILE,
  SCOPE_FILE,
  PLAYBACK_FILE,
  ROLE_TEMPLATE_FILE,
  MANUAL_GRADING_SERVICE_FILE,
]
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
const ROLE_TEMPLATE_MIGRATION = join(
  repoRoot,
  'packages/core-backend/src/db/migrations/zzzz20260826140000_add_elearning_role_templates.ts',
)
const SCOPE_MIGRATION = join(
  repoRoot,
  'packages/core-backend/src/db/migrations/zzzz20260826150000_add_elearning_scope_access.ts',
)

test('vitest.config.ts excludes elearning V0.1 schema and watch-service gates from the no-DB job', () => {
  const cfg = readFileSync(VITEST_CFG, 'utf8')
  for (const file of GATE_FILES) {
    assert.ok(
      isQuotedInTestExclude(cfg, file),
      `test.exclude must contain the exact quoted entry '${file}'`,
    )
  }
})

test('plugin-tests.yml runs schema and watch-service gates as whole-file siblings on the 20.x real-DB step after migrate', () => {
  const wf = readFileSync(WORKFLOW, 'utf8')
  const step = requireExecutableRealDbStep(wf, STEP_ID)
  for (const file of GATE_FILES) {
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
    assert.equal(
      realDbStepWholeFileArgs(wf, MEDIA_DB_STEP_ID).includes(file),
      false,
      `${file} must stay in the schema/service step, not the quota/reconciler step`,
    )
  }
  const wired = realDbStepWholeFileArgs(wf, STEP_ID)
  assert.equal(wired.includes(FILE), true)
  assert.equal(wired.includes(WATCH_FILE), true)
  assert.equal(wired.includes(SERVICE_FILE), true)
  assert.equal(wired.includes(ASSIGNMENT_FILE), true)
  assert.equal(wired.includes(PUBLISH_FILE), true)
  assert.equal(wired.includes(EXAM_FILE), true)
  assert.equal(wired.includes(LEARNER_FILE), true)
  assert.equal(wired.includes(SCOPE_FILE), true)
  assert.equal(wired.includes(PLAYBACK_FILE), true)
  assert.equal(wired.includes(ROLE_TEMPLATE_FILE), true)
  assert.equal(wired.includes(MANUAL_GRADING_SERVICE_FILE), true)

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
  assert.ok(existsSync(SERVICE_SUITE), `wired suite packages/core-backend/${SERVICE_FILE} must exist on disk`)
  assert.ok(existsSync(ASSIGNMENT_SUITE), `wired suite packages/core-backend/${ASSIGNMENT_FILE} must exist on disk`)
  assert.ok(existsSync(PUBLISH_SUITE), `wired suite packages/core-backend/${PUBLISH_FILE} must exist on disk`)
  assert.ok(existsSync(EXAM_SUITE), `wired suite packages/core-backend/${EXAM_FILE} must exist on disk`)
  assert.ok(existsSync(LEARNER_SUITE), `wired suite packages/core-backend/${LEARNER_FILE} must exist on disk`)
  assert.ok(existsSync(SCOPE_SUITE), `wired suite packages/core-backend/${SCOPE_FILE} must exist on disk`)
  assert.ok(existsSync(PLAYBACK_SUITE), `wired suite packages/core-backend/${PLAYBACK_FILE} must exist on disk`)
  assert.ok(existsSync(ROLE_TEMPLATE_SUITE), `wired suite packages/core-backend/${ROLE_TEMPLATE_FILE} must exist on disk`)
  assert.ok(
    existsSync(MANUAL_GRADING_SERVICE_SUITE),
    `wired suite packages/core-backend/${MANUAL_GRADING_SERVICE_FILE} must exist on disk`,
  )
  assert.ok(existsSync(CONTENT_MIGRATION), 'content/assessment migration must exist on disk')
  assert.ok(existsSync(PERMISSION_MIGRATION), 'elearning permissions migration must exist on disk')
  assert.ok(existsSync(WATCH_MIGRATION), 'watch-progress migration must exist on disk')
  assert.ok(existsSync(ROLE_TEMPLATE_MIGRATION), 'role-template migration must exist on disk')
  assert.ok(existsSync(SCOPE_MIGRATION), 'scope/access migration must exist on disk')
})

test('schema and watch-service gate sources throw when DATABASE_URL is missing (no describe.skip)', () => {
  for (const [label, path] of [
    ['content/assessment', SUITE],
    ['exam-attempt-item-migration', ATTEMPT_MIGRATION_SUITE],
    ['watch-progress', WATCH_SUITE],
    ['watch-progress-service', SERVICE_SUITE],
    ['direct-assignment-service', ASSIGNMENT_SUITE],
    ['course-publish-service', PUBLISH_SUITE],
    ['exam-service', EXAM_SUITE],
    ['learner-courses-service', LEARNER_SUITE],
    ['scope-access-service', SCOPE_SUITE],
    ['media-playback-service', PLAYBACK_SUITE],
    ['role-template-migration', ROLE_TEMPLATE_SUITE],
    ['manual-grading-service', MANUAL_GRADING_SERVICE_SUITE],
  ]) {
    const src = readFileSync(path, 'utf8')
    assert.equal(src.includes('describe.skip'), false, `${label} must not describe.skip`)
    assert.equal(src.includes('.skip('), false, `${label} must not skip`)
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

test('watch-service gate uses dual PoolClient pg_locks barriers for start and heartbeat withdrawal', () => {
  const src = readFileSync(SERVICE_SUITE, 'utf8')
  assert.match(src, /type PoolClient/)
  assert.match(src, /pool\.connect\(\)/)
  assert.match(src, /holder: PoolClient/)
  assert.match(src, /waiter: PoolClient/)
  assert.match(src, /pg_locks/)
  assert.match(src, /lock_timeout/)
  assert.match(src, /pg_blocking_pids/)
  assert.match(src, /runLockBarrier/)
  assert.match(src, /watchDbFromClient/)
  assert.match(src, /startElearningWatch\(watchDbFromClient/)
  assert.match(src, /recordElearningHeartbeat\(watchDbFromClient/)
  assert.match(src, /elearning-watch:insert-evidence/)
  assert.equal(src.includes('new Client('), false)
  assert.equal(src.includes('playwright'), false)
  assert.equal(src.includes('setTimeout(res, 500)'), false)
  assert.equal(src.includes('setTimeout(resolve, 500)'), false)
})

test('direct-assignment gate uses dual PoolClient pg_locks barriers for duplicate, course-head withdrawal, and platform-user deactivation', () => {
  const src = readFileSync(ASSIGNMENT_SUITE, 'utf8')
  const service = readFileSync(join(repoRoot, 'packages/core-backend/src/services/elearning-direct-assignment.ts'), 'utf8')
  assert.match(src, /type PoolClient/)
  assert.match(src, /pool\.connect\(\)/)
  assert.match(src, /holder: PoolClient/)
  assert.match(src, /waiter: PoolClient/)
  assert.match(src, /pg_locks/)
  assert.match(src, /lock_timeout/)
  assert.match(src, /pg_blocking_pids/)
  assert.match(src, /runLockBarrier/)
  assert.match(src, /assignDbFromClient/)
  assert.match(src, /assignElearningDirect\(assignDbFromClient/)
  assert.match(src, /elearning-assign:insert-member/)
  assert.match(src, /INSERT INTO users/)
  assert.match(src, /UPDATE users SET is_active = false/)
  assert.match(src, /inactive-platform/)
  assert.match(service, /elearning-assign:load-membership/)
  assert.match(service, /JOIN users u ON u\.id = uo\.user_id/)
  assert.match(service, /uo\.is_active = true/)
  assert.match(service, /u\.is_active = true/)
  assert.match(service, /FOR SHARE OF u, uo/)
  assert.equal(src.includes('new Client('), false)
  assert.equal(src.includes('playwright'), false)
  assert.equal(src.includes('setTimeout(res, 500)'), false)
  assert.equal(src.includes('setTimeout(resolve, 500)'), false)
})

test('every on-disk elearning real-DB suite is excluded and a whole-file arg of exactly one post-migrate step', () => {
  const dbSuites = readdirSync(INTEGRATION_DIR)
    .filter((name) => /^elearning-.*\.db\.test\.ts$/.test(name))
    .map((name) => `tests/integration/${name}`)
    .sort()
  assert.ok(dbSuites.length > 0, 'at least one elearning real-DB suite must exist on disk')
  for (const file of GATE_FILES) {
    assert.equal(
      dbSuites.includes(file),
      true,
      `schema-gate file ${file} must exist on disk as an elearning *.db.test.ts`,
    )
  }

  const cfg = readFileSync(VITEST_CFG, 'utf8')
  const wf = readFileSync(WORKFLOW, 'utf8')
  const schemaWired = realDbStepWholeFileArgs(wf, STEP_ID)
  const mediaWired = realDbStepWholeFileArgs(wf, MEDIA_DB_STEP_ID)
  const approvalWired = realDbStepWholeFileArgs(wf, REAL_DB_STEP_IDS.approval)
  const multitableWired = realDbStepWholeFileArgs(wf, REAL_DB_STEP_IDS.multitable)
  const union = new Set([...schemaWired, ...mediaWired])
  const startPg = wf.indexOf('- name: Start Postgres')
  const migrateAt = wf.indexOf('pnpm --filter @metasheet/core-backend db:migrate')
  assert.ok(startPg >= 0, 'workflow must contain Start Postgres')
  assert.ok(migrateAt >= 0, 'workflow must contain db:migrate')
  assert.ok(startPg < migrateAt, 'Start Postgres must precede db:migrate')

  for (const file of dbSuites) {
    const abs = join(repoRoot, 'packages/core-backend', file)
    assert.ok(existsSync(abs), `wired suite packages/core-backend/${file} must exist on disk`)
    assert.ok(
      isQuotedInTestExclude(cfg, file),
      `test.exclude must contain the exact quoted entry '${file}'`,
    )
    assert.equal(
      union.has(file),
      true,
      `${file} must be a whole-file arg of the schema/service or quota/reconciler real-DB step`,
    )
    const inSchema = schemaWired.includes(file) ? 1 : 0
    const inMedia = mediaWired.includes(file) ? 1 : 0
    assert.equal(
      inSchema + inMedia,
      1,
      `${file} must appear in exactly one elearning post-migrate real-DB step`,
    )
    assert.equal(
      approvalWired.includes(file),
      false,
      `${file} must not be wired into the approval real-DB step`,
    )
    assert.equal(
      multitableWired.includes(file),
      false,
      `${file} must not be wired into the multitable real-DB step`,
    )

    const hits = []
    for (let from = 0; ; ) {
      const at = wf.indexOf(file, from)
      if (at < 0) break
      hits.push(at)
      from = at + file.length
    }
    assert.equal(hits.length, 1, `${file} must appear exactly once in plugin-tests.yml`)
    for (const at of hits) {
      assert.ok(at > startPg, `${file} must appear only after Start Postgres`)
      assert.ok(at > migrateAt, `${file} must appear only after db:migrate`)
    }

    const src = readFileSync(abs, 'utf8')
    assert.equal(src.includes('describe.skip'), false, `${file} must not describe.skip`)
    assert.equal(src.includes('.skip('), false, `${file} must not skip`)
    assert.match(src, /if \(!DATABASE_URL\)/)
    assert.match(src, /throw new Error/)
    assert.match(src, /refusing skip-shaped green/)
    assert.equal(src.includes('http.request'), false, `${file} must not use http.request`)
    assert.equal(src.includes('supertest'), false, `${file} must not use supertest`)
  }
})
