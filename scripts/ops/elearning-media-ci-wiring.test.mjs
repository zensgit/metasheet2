import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  isQuotedInTestExclude,
  isSuiteWiredInRealDbStep,
  realDbStepWholeFileArgs,
  requireExecutableRealDbStep,
  REAL_DB_STEP_IDS,
} from './ci-realdb-step-contract.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const VITEST_CFG = join(repoRoot, 'packages/core-backend/vitest.config.ts')
const WORKFLOW = join(repoRoot, '.github/workflows/plugin-tests.yml')
const DOCKERFILE = join(repoRoot, 'Dockerfile.backend')
const ENV_EXAMPLE = join(repoRoot, '.env.example')
const PROBE_SRC = join(repoRoot, 'packages/core-backend/src/services/elearning-media-probe.ts')
const RUNTIME_SRC = join(repoRoot, 'packages/core-backend/src/services/elearning-media-runtime.ts')
const ROUTES_SRC = join(repoRoot, 'packages/core-backend/src/routes/elearning-media.ts')
const INDEX_SRC = join(repoRoot, 'packages/core-backend/src/index.ts')

const SUITES = [
  'tests/unit/elearning-media-validation.test.ts',
  'tests/unit/elearning-media-probe.test.ts',
  'tests/unit/elearning-media-storage.test.ts',
  'tests/unit/elearning-media-quota.test.ts',
  'tests/unit/elearning-media-runtime.test.ts',
  'tests/unit/elearning-media-routes.test.ts',
  'tests/unit/elearning-media-ingest.test.ts',
  'tests/unit/elearning-media-reconciler.test.ts',
  'tests/unit/elearning-media-s3.test.ts',
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

test('plugin-tests.yml keeps the core-backend test job and an explicit media canary', () => {
  const wf = readFileSync(WORKFLOW, 'utf8')
  assert.match(wf, /pnpm --filter @metasheet\/core-backend test/)
  assert.match(wf, /Run elearning V0\.1 media ingestion canaries/)
  const canaryAt = wf.indexOf('Run elearning V0.1 media ingestion canaries')
  assert.ok(canaryAt >= 0, 'media canary step must exist')
  const canary = namedStepContaining(wf, canaryAt)
  const runAt = canary.search(/^\s+run:/m)
  assert.ok(runAt >= 0, 'media canary must have a run script')
  const run = canary.slice(runAt)
  assert.match(run, /\bvitest\b/)
  assert.equal(/\s-t(?:\s|=|$)/.test(run), false, 'media canary must not use a -t filter')
  assert.equal(run.includes('--testNamePattern'), false, 'media canary must not use --testNamePattern')
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
  assert.equal(/\s-t(?:\s|=|$)/.test(run), false, 'DB step must not use a -t filter')
  assert.equal(run.includes('--testNamePattern'), false, 'DB step must not use --testNamePattern')
  assert.equal(/\s--name(?:\s|=|$)/.test(run), false, 'DB step must not use a --name filter')
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
  const stopMethodAt = src.search(/async\s+stop\s*\(/)
  assert.ok(stopMethodAt >= 0, 'stop() must exist')
  const stopSlice = src.slice(stopMethodAt)
  const startAfterStopRel = stopSlice.search(/\n  async\s+start\s*\(/)
  const stopSrc = startAfterStopRel >= 0 ? stopSlice.slice(0, startAfterStopRel) : stopSlice
  const stopAwaitAt = stopSrc.search(/await\s+this\.stopElearningMediaWorkers\s*\?\.\s*\(\s*\)/)
  const poolEndAt = stopSrc.search(/await\s+pool\.end\s*\(\s*\)/)

  assert.ok(assignAt >= 0, 'boot must capture startWorkers without invoking it')
  assert.ok(mountAt >= 0, 'boot must mount mediaRuntime.router')
  assert.ok(listenAt >= 0, 'server listen must exist')
  assert.ok(startAt >= 0, 'startWorkers must be invoked after listen')
  assert.ok(stopAwaitAt >= 0, 'stop() must await stopElearningMediaWorkers')
  assert.ok(poolEndAt >= 0, 'stop() must await pool.end')
  assert.ok(
    stopAwaitAt < poolEndAt,
    'stop() must await stopElearningMediaWorkers before await pool.end',
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
