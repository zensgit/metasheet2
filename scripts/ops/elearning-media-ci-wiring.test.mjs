import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  isQuotedInTestExclude,
  isSuiteWiredInRealDbStep,
  parseYamlDocument,
  realDbStepWholeFileArgs,
  requireExecutableRealDbStep,
  REAL_DB_STEP_IDS,
} from './ci-realdb-step-contract.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const VITEST_CFG = join(repoRoot, 'packages/core-backend/vitest.config.ts')
const WORKFLOW = join(repoRoot, '.github/workflows/plugin-tests.yml')
const WEB_GUARD = join(repoRoot, '.github/workflows/elearning-web-guard.yml')
const REQUIRED_WEB = join(repoRoot, 'apps/web/scripts/run-required-web-tests.sh')
const DOCKERFILE = join(repoRoot, 'Dockerfile.backend')
const ENV_EXAMPLE = join(repoRoot, '.env.example')
const PROBE_SRC = join(repoRoot, 'packages/core-backend/src/services/elearning-media-probe.ts')
const RUNTIME_SRC = join(repoRoot, 'packages/core-backend/src/services/elearning-media-runtime.ts')
const ROUTES_SRC = join(repoRoot, 'packages/core-backend/src/routes/elearning-media.ts')
const INDEX_SRC = join(repoRoot, 'packages/core-backend/src/index.ts')
const UNIT_DIR = join(repoRoot, 'packages/core-backend/tests/unit')
const INTEGRATION_DIR = join(repoRoot, 'packages/core-backend/tests/integration')
const WEB_TEST_DIR = join(repoRoot, 'apps/web/tests')
const OPENAPI_JSON = join(repoRoot, 'packages/openapi/dist/openapi.json')
const OPENAPI_SDK = join(repoRoot, 'packages/openapi/dist-sdk/index.d.ts')

const SUITES = readdirSync(UNIT_DIR)
  .filter((name) => /^elearning-.*\.test\.ts$/.test(name))
  .map((name) => `tests/unit/${name}`)
  .sort()

const DB_SUITES = readdirSync(INTEGRATION_DIR)
  .filter((name) => /^elearning-.*\.db\.test\.ts$/.test(name))
  .map((name) => `tests/integration/${name}`)
  .sort()

const WEB_SPECS = [
  'tests/elearning-client.spec.ts',
  'tests/elearning-analytics-admin.spec.ts',
  'tests/elearning-analytics-client.spec.ts',
  'tests/elearning-analytics-period.spec.ts',
  'tests/elearning-content-admin.spec.ts',
  'tests/elearning-content-client.spec.ts',
  'tests/elearning-content-learner.spec.ts',
  'tests/elearning-certificate-admin.spec.ts',
  'tests/elearning-certificate-client.spec.ts',
  'tests/elearning-certificate-wallet.spec.ts',
  'tests/elearning-credit-admin.spec.ts',
  'tests/elearning-credit-client.spec.ts',
  'tests/elearning-credit-wallet.spec.ts',
  'tests/elearning-learner-view.spec.ts',
  'tests/elearning-admin-view.spec.ts',
  'tests/elearning-routes.spec.ts',
  'tests/elearning-manual-grading-client.spec.ts',
  'tests/elearning-manual-grading-view.spec.ts',
  'tests/elearning-offline-training-admin.spec.ts',
  'tests/elearning-offline-training-client.spec.ts',
  'tests/elearning-offline-training-learner.spec.ts',
  'tests/elearning-learning-profile-client.spec.ts',
  'tests/elearning-learning-profile-section.spec.ts',
  'tests/elearning-portal-admin.spec.ts',
  'tests/elearning-portal-client.spec.ts',
  'tests/elearning-portal-learner.spec.ts',
  'tests/elearning-practice-admin.spec.ts',
  'tests/elearning-practice-client.spec.ts',
  'tests/elearning-practice-learner.spec.ts',
  'tests/elearning-title-admin.spec.ts',
]

const WEB_GUARD_PATHS = [
  'apps/web/src/services/elearning.ts',
  'apps/web/src/services/elearningAnalytics.ts',
  'apps/web/src/services/elearningContent.ts',
  'apps/web/src/services/elearningCredit.ts',
  'apps/web/src/services/elearningCertificate.ts',
  'apps/web/src/services/elearningManualGrading.ts',
  'apps/web/src/services/elearningOfflineTraining.ts',
  'apps/web/src/services/elearningProfile.ts',
  'apps/web/src/services/elearningPortal.ts',
  'apps/web/src/services/elearningPractice.ts',
  'apps/web/src/views/ElearningAdminView.vue',
  'apps/web/src/views/ElearningAnalyticsAdminSection.vue',
  'apps/web/src/views/ElearningAnalyticsPeriodSection.vue',
  'apps/web/src/views/ElearningContentAdminSection.vue',
  'apps/web/src/views/ElearningContentLearnerCourse.vue',
  'apps/web/src/views/ElearningCreditAdminSection.vue',
  'apps/web/src/views/ElearningCreditWalletSection.vue',
  'apps/web/src/views/ElearningTitleAdminSection.vue',
  'apps/web/src/views/ElearningCertificateAdminSection.vue',
  'apps/web/src/views/ElearningCertificateWalletSection.vue',
  'apps/web/src/views/ElearningLearnerView.vue',
  'apps/web/src/views/ElearningManualGradingView.vue',
  'apps/web/src/views/ElearningManualGradingAttempt.vue',
  'apps/web/src/views/ElearningOfflineTrainingAdminSection.vue',
  'apps/web/src/views/ElearningOfflineTrainingLearnerSection.vue',
  'apps/web/src/views/ElearningLearningProfileSection.vue',
  'apps/web/src/views/ElearningPortalAdminSection.vue',
  'apps/web/src/views/ElearningPortalHero.vue',
  'apps/web/src/views/ElearningPracticeAdminSection.vue',
  'apps/web/src/views/ElearningPracticeLearnerSection.vue',
  'apps/web/src/views/elearningLabels.ts',
  'apps/web/src/router/appRoutes.ts',
  'apps/web/src/router/types.ts',
  'apps/web/src/router/guardPolicy.ts',
  'apps/web/src/stores/featureFlags.ts',
  'plugins/plugin-elearning/app.manifest.json',
  'apps/web/tests/elearning-client.spec.ts',
  'apps/web/tests/elearning-analytics-admin.spec.ts',
  'apps/web/tests/elearning-analytics-client.spec.ts',
  'apps/web/tests/elearning-analytics-period.spec.ts',
  'apps/web/tests/elearning-content-admin.spec.ts',
  'apps/web/tests/elearning-content-client.spec.ts',
  'apps/web/tests/elearning-content-learner.spec.ts',
  'apps/web/tests/elearning-certificate-admin.spec.ts',
  'apps/web/tests/elearning-certificate-client.spec.ts',
  'apps/web/tests/elearning-certificate-wallet.spec.ts',
  'apps/web/tests/elearning-credit-admin.spec.ts',
  'apps/web/tests/elearning-credit-client.spec.ts',
  'apps/web/tests/elearning-credit-wallet.spec.ts',
  'apps/web/tests/elearning-learner-view.spec.ts',
  'apps/web/tests/elearning-admin-view.spec.ts',
  'apps/web/tests/elearning-routes.spec.ts',
  'apps/web/tests/elearning-manual-grading-client.spec.ts',
  'apps/web/tests/elearning-manual-grading-view.spec.ts',
  'apps/web/tests/elearning-offline-training-admin.spec.ts',
  'apps/web/tests/elearning-offline-training-client.spec.ts',
  'apps/web/tests/elearning-offline-training-learner.spec.ts',
  'apps/web/tests/elearning-learning-profile-client.spec.ts',
  'apps/web/tests/elearning-learning-profile-section.spec.ts',
  'apps/web/tests/elearning-portal-admin.spec.ts',
  'apps/web/tests/elearning-portal-client.spec.ts',
  'apps/web/tests/elearning-portal-learner.spec.ts',
  'apps/web/tests/elearning-practice-admin.spec.ts',
  'apps/web/tests/elearning-practice-client.spec.ts',
  'apps/web/tests/elearning-practice-learner.spec.ts',
  'apps/web/tests/elearning-title-admin.spec.ts',
  '.github/workflows/elearning-web-guard.yml',
]

const SCHEMA_DB_FILES = [
  'tests/integration/elearning-v01-content-assessment-schema.db.test.ts',
  'tests/integration/elearning-v01-watch-progress-schema.db.test.ts',
  'tests/integration/elearning-watch-progress-service.db.test.ts',
  'tests/integration/elearning-direct-assignment.db.test.ts',
  'tests/integration/elearning-course-publish.db.test.ts',
  'tests/integration/elearning-title-runtime.db.test.ts',
  'tests/integration/elearning-certificate-runtime.db.test.ts',
  'tests/integration/elearning-learning-profile.db.test.ts',
  'tests/integration/elearning-portal-settings.db.test.ts',
  'tests/integration/elearning-stats-daily-projection.db.test.ts',
  'tests/integration/elearning-exam-service.db.test.ts',
  'tests/integration/elearning-learner-courses.db.test.ts',
  'tests/integration/elearning-media-playback.db.test.ts',
  'tests/integration/elearning-assessment-catalog.db.test.ts',
  'tests/integration/elearning-paper-exam.db.test.ts',
  'tests/integration/elearning-question-practice.db.test.ts',
  'tests/integration/elearning-manual-grading-schema.db.test.ts',
  'tests/integration/elearning-offline-training.db.test.ts',
]

const SCHEMA_DB_STEP_ID = 'elearning-v01-content-assessment-schema-gate'
const EXISTING_REQUIRED_WEB_TOKENS = [
  'tests/api.spec.ts',
  'approval-canvas-commands',
  'featureFlagsApprovalAttachments',
  'tests/App.spec.ts',
  'approval-comments-panel',
]

const CANONICAL_ELEARNING_FLAGS = [
  'ELEARNING_ENABLED',
  'ELEARNING_CONTENT_ENABLED',
  'ELEARNING_ASSIGNMENT_ENABLED',
  'ELEARNING_ASSESSMENT_ENABLED',
  'ELEARNING_INCENTIVE_ENABLED',
  'ELEARNING_ANALYTICS_ENABLED',
  'ELEARNING_MEDIA_ENABLED',
]

const V01_REQUIRED_FLAGS = [
  'ELEARNING_ENABLED',
  'ELEARNING_CONTENT_ENABLED',
  'ELEARNING_ASSIGNMENT_ENABLED',
  'ELEARNING_ASSESSMENT_ENABLED',
  'ELEARNING_MEDIA_ENABLED',
]

const V01_PARKED_FLAGS = [
  'ELEARNING_INCENTIVE_ENABLED',
  'ELEARNING_ANALYTICS_ENABLED',
]

const MEDIA_CLAIM_UNIT_FILES = [
  'tests/unit/elearning-media-runtime.test.ts',
  'tests/unit/elearning-media-reconciler.test.ts',
  'tests/unit/elearning-media-storage.test.ts',
  'tests/unit/elearning-media-s3.test.ts',
]

const DB_SUITE = 'tests/integration/elearning-media-quota.db.test.ts'
const RECONCILER_DB = 'tests/integration/elearning-media-reconciler.db.test.ts'
const MEDIA_DB_STEP_ID = 'elearning-v01-media-quota-real-db'

function stripTsComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, '')
}

function wholeFileArg(run, file) {
  return new RegExp(`(?:^|\\s)${file.replace(/\./g, '\\.')}(?:\\s|$)`).test(run)
}

function uncommentedLines(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
}

function namedStepContaining(wf, pos) {
  const start = wf.lastIndexOf('\n      - name:', pos)
  assert.ok(start >= 0, 'path must sit inside a named workflow step')
  const end = wf.indexOf('\n      - name:', start + 1)
  return wf.slice(start, end === -1 ? wf.length : end)
}

function refusesNameFilters(run, label) {
  assert.equal(/\s-t(?:\s|=|$)/.test(run), false, `${label} must not use a -t filter`)
  assert.equal(run.includes('--testNamePattern'), false, `${label} must not use --testNamePattern`)
  assert.equal(/\s--name(?:\s|=|$)/.test(run), false, `${label} must not use a --name filter`)
}

function refusesSkipShapedGreen(text, label) {
  const executable = uncommentedLines(text)
  assert.equal(executable.includes('continue-on-error'), false, `${label} must not set continue-on-error`)
  assert.equal(/\|\|\s*true\b/.test(executable), false, `${label} must not swallow vitest failures with || true`)
  assert.doesNotMatch(executable, /if:\s*false\b/, `${label} must not disable itself with if: false`)
}

function joinContinuedLines(text) {
  const logical = []
  let pending = null
  for (const line of uncommentedLines(text).split('\n')) {
    const continued = /\\\s*$/.test(line)
    const body = continued ? line.replace(/\\\s*$/, ' ') : line
    pending = pending === null ? body : `${pending}${body}`
    if (!continued) {
      logical.push(pending)
      pending = null
    }
  }
  if (pending !== null) logical.push(pending)
  return logical
}

function vitestRunInvocations(text) {
  return joinContinuedLines(text)
    .map((line) => line.trim())
    .filter((line) => /\bvitest\b/.test(line) && /\brun\b/.test(line))
}

function invocationFileArgs(line) {
  return line
    .split(/\s+/)
    .filter((token) => /^tests\/\S+\.(?:test|spec)\.[tj]sx?$/.test(token))
}

function parseYaml(text) {
  // Shared fail-closed python3 + PyYAML bridge — this file runs in the required no-DB `test`
  // job BEFORE `pnpm install`, so `js-yaml` is not importable on a clean runner.
  const doc = parseYamlDocument(text)
  assert.ok(doc && typeof doc === 'object', 'workflow YAML must parse')
  return doc
}

function workflowOn(doc) {
  // YAML 1.1 `on:` is a boolean. js-yaml would expose it as `"true"`; the shared PyYAML
  // bridge stringifies keys with Python `str()`, so the trigger block lands under `"True"`.
  return doc.on ?? doc.true ?? doc.True
}

function commentBlockStarting(text, headingRe, label) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => headingRe.test(line))
  assert.ok(start >= 0, `.env.example must keep the ${label} contract`)
  const block = [lines[start]]
  for (let i = start + 1; i < lines.length; i += 1) {
    if (!/^#\s{2,}\S/.test(lines[i])) break
    block.push(lines[i])
  }
  return block.join('\n')
}

test('elearning media focused suites exist and are not excluded from the no-DB vitest job', () => {
  const cfg = readFileSync(VITEST_CFG, 'utf8')
  for (const file of SUITES) {
    const abs = join(repoRoot, 'packages/core-backend', file)
    assert.ok(existsSync(abs), `suite ${file} must exist on disk`)
    assert.equal(
      isQuotedInTestExclude(cfg, file),
      false,
      `${file} must not be listed in vitest.config.ts test.exclude`,
    )
  }
})

test('plugin-tests.yml keeps the core-backend test job and an explicit unit canary', () => {
  assert.ok(SUITES.length > 0, 'at least one elearning unit file must exist on disk')
  const wf = readFileSync(WORKFLOW, 'utf8')
  assert.match(wf, /pnpm --filter @metasheet\/core-backend test/)
  assert.match(wf, /id: elearning-v01-unit-canaries/)
  const canaryAt = wf.indexOf('Run elearning V0.1 unit canaries')
  assert.ok(canaryAt >= 0, 'unit canary step must exist')
  const canary = namedStepContaining(wf, canaryAt)
  refusesSkipShapedGreen(canary, 'unit canary')
  const runAt = canary.search(/^\s+run:/m)
  assert.ok(runAt >= 0, 'unit canary must have a run script')
  const run = canary.slice(runAt)
  assert.match(run, /\bvitest\b/)
  refusesNameFilters(run, 'unit canary')
  for (const file of SUITES) {
    assert.ok(wholeFileArg(run, file), `plugin-tests.yml canary must name ${file} as a whole-file vitest arg`)
  }
  for (const file of MEDIA_CLAIM_UNIT_FILES) {
    assert.ok(
      SUITES.includes(file) && wholeFileArg(run, file),
      `runtime/reconciler/storage/S3 unit file ${file} must stay in the existing canary invocation`,
    )
  }
  assert.match(wf, /node --test scripts\/ops\/elearning-media-ci-wiring\.test\.mjs/)
})

test('quota DB suite exists, is excluded, and is a post-Postgres whole-file vitest step', () => {
  const abs = join(repoRoot, 'packages/core-backend', DB_SUITE)
  assert.ok(existsSync(abs), `suite ${DB_SUITE} must exist on disk`)
  const cfg = readFileSync(VITEST_CFG, 'utf8')
  assert.ok(
    isQuotedInTestExclude(cfg, DB_SUITE),
    `test.exclude must contain the exact quoted entry '${DB_SUITE}'`,
  )

  const wf = readFileSync(WORKFLOW, 'utf8')
  const startPg = wf.indexOf('- name: Start Postgres')
  const migrateAt = wf.indexOf('pnpm --filter @metasheet/core-backend db:migrate')
  assert.ok(startPg >= 0, 'workflow must contain Start Postgres')
  assert.ok(migrateAt >= 0, 'workflow must contain db:migrate')
  assert.ok(startPg < migrateAt, 'Start Postgres must precede db:migrate')

  const hits = []
  for (let from = 0; ; ) {
    const at = wf.indexOf(DB_SUITE, from)
    if (at < 0) break
    hits.push(at)
    from = at + DB_SUITE.length
  }
  assert.ok(hits.length >= 1, `plugin-tests.yml must name ${DB_SUITE}`)
  for (const at of hits) {
    assert.ok(at > startPg, `${DB_SUITE} must appear only after Start Postgres`)
    assert.ok(at > migrateAt, `${DB_SUITE} must appear only after db:migrate`)
  }

  const step = namedStepContaining(wf, hits[0])
  for (const at of hits) {
    assert.equal(
      namedStepContaining(wf, at),
      step,
      `${DB_SUITE} must be named only in one post-Start-Postgres/post-migration step`,
    )
  }
  const runAt = step.search(/^\s+run:/m)
  assert.ok(runAt >= 0, 'DB step must have a run script')
  const run = step.slice(runAt)
  assert.match(run, /\bvitest\b/)
  assert.match(
    run,
    new RegExp(`(?:^|\\s)${DB_SUITE.replace(/\./g, '\\.')}(?:\\s|$)`),
    `${DB_SUITE} must be an exact whole-file vitest argument`,
  )
  refusesNameFilters(run, 'quota DB step')
  assert.match(
    step,
    /DATABASE_URL:\s*postgresql:\/\/postgres@localhost:5432\/metasheet_test/,
    'DB step must provide DATABASE_URL with the same post-DB pattern as neighboring gates',
  )
})

test('reconciler DB suite exists, is excluded, and is a sibling whole-file arg of the media real-DB step', () => {
  const abs = join(repoRoot, 'packages/core-backend', RECONCILER_DB)
  assert.ok(existsSync(abs), `suite ${RECONCILER_DB} must exist on disk`)
  const cfg = readFileSync(VITEST_CFG, 'utf8')
  assert.ok(
    isQuotedInTestExclude(cfg, RECONCILER_DB),
    `test.exclude must contain the exact quoted entry '${RECONCILER_DB}'`,
  )
  assert.equal(
    isQuotedInTestExclude(cfg, 'tests/unit/elearning-media-reconciler.test.ts'),
    false,
    'reconciler unit file must not be excluded from the no-DB job',
  )

  const wf = readFileSync(WORKFLOW, 'utf8')
  requireExecutableRealDbStep(wf, MEDIA_DB_STEP_ID)
  assert.ok(
    isSuiteWiredInRealDbStep(wf, MEDIA_DB_STEP_ID, DB_SUITE),
    `step ${MEDIA_DB_STEP_ID} must keep ${DB_SUITE} as a whole-file vitest arg`,
  )
  assert.ok(
    isSuiteWiredInRealDbStep(wf, MEDIA_DB_STEP_ID, RECONCILER_DB),
    `step ${MEDIA_DB_STEP_ID} must run ${RECONCILER_DB} as a whole-file vitest arg`,
  )
  const wired = realDbStepWholeFileArgs(wf, MEDIA_DB_STEP_ID)
  assert.equal(wired.includes(DB_SUITE), true)
  assert.equal(wired.includes(RECONCILER_DB), true)
  assert.equal(
    realDbStepWholeFileArgs(wf, REAL_DB_STEP_IDS.approval).includes(RECONCILER_DB),
    false,
    `${RECONCILER_DB} must not be wired into the approval real-DB step`,
  )
  assert.equal(
    realDbStepWholeFileArgs(wf, REAL_DB_STEP_IDS.multitable).includes(RECONCILER_DB),
    false,
    `${RECONCILER_DB} must not be wired into the multitable real-DB step`,
  )

  const src = readFileSync(abs, 'utf8')
  assert.equal(src.includes('describe.skip'), false)
  assert.equal(src.includes('describeIfDatabase'), false)
  assert.match(src, /if \(!DATABASE_URL\)/)
  assert.match(src, /throw new Error/)
  assert.match(src, /refusing skip-shaped green/)
  assert.match(src, /reconcileStaleElearningMediaRows/)
  assert.match(src, /FOR UPDATE SKIP LOCKED/)
  assert.match(src, /new Client\(/)
  assert.match(src, /new Pool\(/)
  assert.match(src, /\.end\(\)/)
  assert.match(src, /FILE_NS/)
})

test('index.ts mounts media routes, defers startWorkers until listen, and stops them on shutdown', () => {
  const src = stripTsComments(readFileSync(INDEX_SRC, 'utf8'))
  assert.match(src, /bootElearningMediaRuntime/)
  assert.match(src, /this\.app\.use\(\s*mediaRuntime\.router\s*\)/)
  assert.match(src, /startElearningMediaWorkers\s*=\s*mediaRuntime\.startWorkers/)

  const assignAt = src.search(/startElearningMediaWorkers\s*=\s*mediaRuntime\.startWorkers/)
  const mountAt = src.search(/this\.app\.use\(\s*mediaRuntime\.router\s*\)/)
  const listenAt = src.search(/this\.httpServer\.listen\s*\(/)
  const startAt = src.search(/this\.stopElearningMediaWorkers\s*=\s*startElearningMediaWorkers\s*\(\s*\)/)
  const stopMethodAt = src.search(/\n  stop\s*\(/)
  assert.ok(stopMethodAt >= 0, 'stop() must exist')
  const stopOnceMethodAt = src.search(/\n  private\s+async\s+stopOnce\s*\(/)
  assert.ok(stopOnceMethodAt >= 0, 'stop() must delegate to async stopOnce()')
  const stopMethodSrc = src.slice(stopMethodAt, stopOnceMethodAt)
  assert.match(stopMethodSrc, /this\.stopPromise\s*\?\?=\s*this\.stopOnce\s*\(\s*signal\s*\)/)
  assert.match(stopMethodSrc, /return\s+this\.stopPromise/)
  const stopPromiseAssignments = [...stopMethodSrc.matchAll(/this\.stopPromise\s*(\?\?=|\|\|=|&&=|=(?!=))/g)]
    .map((match) => match[1])
  assert.deepEqual(
    stopPromiseAssignments,
    ['??='],
    'stop() must assign stopPromise exactly once with ??= and never overwrite the shared promise',
  )
  const stopSlice = src.slice(stopOnceMethodAt)
  const startAfterStopRel = stopSlice.search(/\n  async\s+start\s*\(/)
  const stopSrc = startAfterStopRel >= 0 ? stopSlice.slice(0, startAfterStopRel) : stopSlice
  const stopAwaitAt = stopSrc.search(/await\s+this\.stopElearningMediaWorkers\s*\?\.\s*\(\s*\)/)
  const recoveryStopAt = stopSrc.search(/await\s+this\.recoveryArchiveApplication\.stopWorker\s*\(\s*\)/)
  const poolEndAt = stopSrc.search(/await\s+pool\.end\s*\(\s*\)/)

  assert.ok(assignAt >= 0, 'boot must capture startWorkers without invoking it')
  assert.ok(mountAt >= 0, 'boot must mount mediaRuntime.router')
  assert.ok(listenAt >= 0, 'server listen must exist')
  assert.ok(startAt >= 0, 'startWorkers must be invoked after listen')
  assert.ok(stopAwaitAt >= 0, 'stopOnce() must await stopElearningMediaWorkers')
  assert.ok(recoveryStopAt >= 0, 'stopOnce() must await recoveryArchiveApplication.stopWorker')
  assert.ok(poolEndAt >= 0, 'stopOnce() must await pool.end')
  assert.ok(
    stopAwaitAt < recoveryStopAt && recoveryStopAt < poolEndAt,
    'stopOnce() must stop e-learning media before recovery drain and pool close',
  )

  assert.ok(mountAt < listenAt, 'route mount must happen during boot, before listen')
  assert.ok(assignAt < listenAt, 'startWorkers capture must happen during boot, before listen')
  assert.ok(listenAt < startAt, 'startWorkers invocation must be deferred until after listen')
  assert.equal(
    /startElearningMediaWorkers\s*\(\s*\)/.test(src.slice(assignAt, listenAt)),
    false,
    'boot must not call startWorkers before listen',
  )
  assert.match(
    src.slice(Math.max(0, startAt - 280), startAt + 80),
    /NODE_ENV\s*!==\s*['"]test['"]/,
  )
  assert.match(
    src.slice(Math.max(0, startAt - 280), startAt + 80),
    /!\s*process\.env\.VITEST/,
  )
})

test('Dockerfile.backend runner installs ffmpeg and requires ffprobe on PATH', () => {
  const docker = uncommentedLines(readFileSync(DOCKERFILE, 'utf8'))
  assert.match(docker, /ffmpeg/)
  const probeAt = docker.search(/command\s+-v\s+ffprobe/)
  const cleanupAt = docker.search(/rm\s+-rf\s+\/var\/lib\/apt\/lists/)
  assert.ok(probeAt >= 0, 'runner RUN must execute command -v ffprobe, not a comment')
  assert.ok(cleanupAt > probeAt, 'command -v ffprobe must run before apt list cleanup')
})

test('env example documents media flags, explicit quotas, and S3/local storage', () => {
  const env = readFileSync(ENV_EXAMPLE, 'utf8')
  for (const key of [
    'ELEARNING_ENABLED',
    'ELEARNING_MEDIA_ENABLED',
    'ELEARNING_MEDIA_MAX_OBJECT_BYTES',
    'ELEARNING_MEDIA_ORG_QUOTA_BYTES',
    'ELEARNING_MEDIA_S3_BUCKET',
    'ELEARNING_MEDIA_S3_REGION',
    'ELEARNING_MEDIA_S3_ENDPOINT',
    'ELEARNING_MEDIA_S3_FORCE_PATH_STYLE',
    'ELEARNING_MEDIA_STORAGE_DIR',
  ]) {
    assert.ok(env.includes(key), `.env.example must document ${key}`)
  }
  for (const key of [
    'ELEARNING_MEDIA_MAX_OBJECT_BYTES',
    'ELEARNING_MEDIA_ORG_QUOTA_BYTES',
    'ELEARNING_MEDIA_PLAYBACK_SIGNING_SECRET',
  ]) {
    assert.match(
      env,
      new RegExp(`^#\\s*${key}=\\s*$`, 'm'),
      `.env.example must keep ${key} empty (no invented quota/secret default)`,
    )
  }
})

test('env example documents the seven canonical flags default false and V0.1 required vs parked contract', () => {
  const env = readFileSync(ENV_EXAMPLE, 'utf8')
  assert.equal(CANONICAL_ELEARNING_FLAGS.length, 7)
  assert.equal(V01_REQUIRED_FLAGS.length, 5)
  assert.equal(V01_PARKED_FLAGS.length, 2)
  assert.deepEqual(
    [...V01_REQUIRED_FLAGS, ...V01_PARKED_FLAGS].sort(),
    [...CANONICAL_ELEARNING_FLAGS].sort(),
  )
  assert.match(
    env,
    /seven canonical flags default false/,
    '.env.example must keep the seven-flag default-false contract',
  )
  for (const key of CANONICAL_ELEARNING_FLAGS) {
    assert.match(
      env,
      new RegExp(`^#\\s*${key}=false\\s*$`, 'm'),
      `.env.example must keep the canonical ${key}=false line`,
    )
  }
  const requiredBlock = commentBlockStarting(env, /V0\.1 required flags/, 'V0.1 required flags')
  for (const key of V01_REQUIRED_FLAGS) {
    assert.ok(requiredBlock.includes(key), `V0.1 required contract must name ${key}`)
  }
  for (const key of V01_PARKED_FLAGS) {
    assert.equal(
      requiredBlock.includes(key),
      false,
      `${key} must stay parked and must not appear in the V0.1 required contract`,
    )
  }
  const parkedBlock = commentBlockStarting(env, /Parked for V0\.1/, 'parked/default')
  assert.match(
    parkedBlock,
    /remain default false/,
    '.env.example must keep the parked flags remain-default-false contract',
  )
  for (const key of V01_PARKED_FLAGS) {
    assert.ok(parkedBlock.includes(key), `parked/default contract must name ${key}`)
  }
  for (const key of V01_REQUIRED_FLAGS) {
    assert.equal(
      parkedBlock.includes(key),
      false,
      `${key} is V0.1 required and must not appear in the parked/default contract`,
    )
  }
})

test('probe invokes ffprobe without a shell; runtime uses rbacGuard elearning write', () => {
  const probe = readFileSync(PROBE_SRC, 'utf8')
  assert.match(probe, /execFile/)
  assert.equal(probe.includes('shell: true'), false)
  assert.equal(/\bexec\(/.test(probe), false)
  const runtime = readFileSync(RUNTIME_SRC, 'utf8')
  assert.match(runtime, /rbacGuard\('elearning',\s*'write'\)/)
  const routes = readFileSync(ROUTES_SRC, 'utf8')
  assert.match(routes, /isElearningMediaSurfaceEnabled/)
  assert.match(routes, /ORG_CONTEXT_REQUIRED/)
})

test('schema/service real-DB step keeps prior files and the four missing V0.1 suites as whole-file args', () => {
  for (const file of SCHEMA_DB_FILES) {
    const abs = join(repoRoot, 'packages/core-backend', file)
    assert.ok(existsSync(abs), `suite ${file} must exist on disk`)
  }
  const wf = readFileSync(WORKFLOW, 'utf8')
  const step = requireExecutableRealDbStep(wf, SCHEMA_DB_STEP_ID)
  refusesSkipShapedGreen(typeof step.run === 'string' ? step.run : '', 'schema/service real-DB step')
  refusesNameFilters(typeof step.run === 'string' ? step.run : '', 'schema/service real-DB step')
  for (const file of SCHEMA_DB_FILES) {
    assert.ok(
      isSuiteWiredInRealDbStep(wf, SCHEMA_DB_STEP_ID, file),
      `plugin-tests.yml real-DB step id "${SCHEMA_DB_STEP_ID}" must run ${file} as a whole-file vitest arg`,
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
  const wired = realDbStepWholeFileArgs(wf, SCHEMA_DB_STEP_ID)
  for (const file of SCHEMA_DB_FILES) {
    assert.equal(wired.includes(file), true, `${file} must be present in ${SCHEMA_DB_STEP_ID}`)
  }
})

test('every on-disk elearning real-DB suite is a whole-file arg of exactly one post-migrate step', () => {
  assert.ok(DB_SUITES.length > 0, 'at least one elearning real-DB suite must exist on disk')
  const cfg = readFileSync(VITEST_CFG, 'utf8')
  const wf = readFileSync(WORKFLOW, 'utf8')
  const schemaWired = realDbStepWholeFileArgs(wf, SCHEMA_DB_STEP_ID)
  const mediaWired = realDbStepWholeFileArgs(wf, MEDIA_DB_STEP_ID)
  assert.equal(mediaWired.includes(DB_SUITE), true)
  assert.equal(mediaWired.includes(RECONCILER_DB), true)
  const union = new Set([...schemaWired, ...mediaWired])
  const startPg = wf.indexOf('- name: Start Postgres')
  const migrateAt = wf.indexOf('pnpm --filter @metasheet/core-backend db:migrate')
  assert.ok(startPg >= 0, 'workflow must contain Start Postgres')
  assert.ok(migrateAt >= 0, 'workflow must contain db:migrate')
  assert.ok(startPg < migrateAt, 'Start Postgres must precede db:migrate')
  const approvalWired = realDbStepWholeFileArgs(wf, REAL_DB_STEP_IDS.approval)
  const multitableWired = realDbStepWholeFileArgs(wf, REAL_DB_STEP_IDS.multitable)
  for (const file of DB_SUITES) {
    assert.ok(
      isQuotedInTestExclude(cfg, file),
      `test.exclude must contain the exact quoted entry '${file}'`,
    )
    assert.equal(
      union.has(file),
      true,
      `${file} must be a whole-file arg of the schema/service or quota/reconciler real-DB step`,
    )
    assert.equal(
      schemaWired.includes(file) && mediaWired.includes(file),
      false,
      `${file} must not be duplicated across both elearning real-DB steps`,
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
  }
})

test('elearning V0.1 frontend specs exist on disk', () => {
  const onDisk = readdirSync(WEB_TEST_DIR)
    .filter((name) => /^elearning-.*\.spec\.ts$/.test(name))
    .map((name) => `tests/${name}`)
    .sort()
  assert.deepEqual(onDisk, [...WEB_SPECS].sort())
  for (const file of WEB_SPECS) {
    assert.ok(existsSync(join(repoRoot, 'apps/web', file)), `${file} must exist on disk`)
  }
})

test('media upload OpenAPI and generated SDK keep the ready/rejected discriminated union', () => {
  const openapi = JSON.parse(readFileSync(OPENAPI_JSON, 'utf8'))
  const schemas = openapi?.components?.schemas
  const result = schemas?.ElearningMediaUploadResult
  const ready = schemas?.ElearningMediaUploadReadyResult
  const rejected = schemas?.ElearningMediaUploadRejectedResult

  assert.deepEqual(result?.oneOf, [
    { $ref: '#/components/schemas/ElearningMediaUploadReadyResult' },
    { $ref: '#/components/schemas/ElearningMediaUploadRejectedResult' },
  ])
  assert.deepEqual(result?.discriminator, {
    propertyName: 'status',
    mapping: {
      ready: '#/components/schemas/ElearningMediaUploadReadyResult',
      rejected: '#/components/schemas/ElearningMediaUploadRejectedResult',
    },
  })
  assert.deepEqual(ready?.properties?.status?.enum, ['ready'])
  assert.equal(ready?.properties?.durationMs?.minimum, 1)
  assert.equal(ready?.properties?.durationMs?.nullable, undefined)
  assert.deepEqual(rejected?.properties?.status?.enum, ['rejected'])
  assert.equal(rejected?.properties?.durationMs?.nullable, true)
  assert.deepEqual(rejected?.properties?.durationMs?.enum, [null])

  const sdk = readFileSync(OPENAPI_SDK, 'utf8')
  assert.match(sdk, /ElearningMediaUploadReadyResult:[\s\S]*?status: "ready";[\s\S]*?durationMs: number;/)
  assert.match(sdk, /ElearningMediaUploadRejectedResult:[\s\S]*?status: "rejected";[\s\S]*?durationMs: null;/)
})

test('elearning-web-guard.yml parses, installs frozen deps, and runs the thirty whole spec files', () => {
  assert.ok(existsSync(WEB_GUARD), 'elearning-web-guard.yml must exist')
  const yaml = readFileSync(WEB_GUARD, 'utf8')
  const doc = parseYaml(yaml)
  const on = workflowOn(doc)
  assert.ok(on?.pull_request?.paths, 'web guard must be a path-filtered pull_request workflow')
  const paths = on.pull_request.paths
  for (const path of WEB_GUARD_PATHS) {
    assert.equal(paths.includes(path), true, `web guard pull_request.paths must include ${path}`)
  }
  refusesSkipShapedGreen(yaml, 'elearning-web-guard.yml')
  assert.match(yaml, /pnpm install --frozen-lockfile/)
  const runStepAt = yaml.indexOf('Run elearning V0.1 + L3 + L4 + content web guard specs (targeted)')
  assert.ok(runStepAt >= 0, 'web guard must have a targeted spec step')
  const runStep = namedStepContaining(yaml, runStepAt)
  const runAt = runStep.search(/^\s+run:/m)
  assert.ok(runAt >= 0, 'web guard spec step must have a run script')
  const run = runStep.slice(runAt)
  assert.match(run, /\bvitest\b/)
  refusesNameFilters(run, 'elearning web guard')
  for (const file of WEB_SPECS) {
    assert.ok(wholeFileArg(run, file), `web guard must name ${file} as a whole-file vitest arg`)
  }
  const invocations = vitestRunInvocations(run)
  assert.equal(invocations.length, 1, 'web guard must use exactly one vitest run invocation')
  assert.deepEqual(invocationFileArgs(invocations[0]).sort(), [...WEB_SPECS].sort())
})

test('run-required-web-tests.sh keeps existing tokens and adds a distinct thirty-file elearning invocation', () => {
  assert.ok(existsSync(REQUIRED_WEB), 'run-required-web-tests.sh must exist')
  const src = readFileSync(REQUIRED_WEB, 'utf8')
  for (const token of EXISTING_REQUIRED_WEB_TOKENS) {
    assert.ok(src.includes(token), `run-required-web-tests.sh must preserve existing token ${token}`)
  }
  refusesNameFilters(src, 'run-required-web-tests.sh')
  const invocations = vitestRunInvocations(src)
  const targeted = invocations.filter((line) => WEB_SPECS.every((file) => wholeFileArg(line, file)))
  assert.equal(
    targeted.length,
    1,
    'run-required-web-tests.sh must have exactly one distinct invocation that names all thirty elearning specs',
  )
  assert.deepEqual(
    invocationFileArgs(targeted[0]).sort(),
    [...WEB_SPECS].sort(),
    'the targeted elearning invocation must run exactly the thirty whole spec files',
  )
  assert.equal(targeted[0].includes('exec '), false, 'the targeted elearning invocation must not be the final exec batch')
})
