import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { isQuotedInTestExclude } from './ci-realdb-step-contract.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const VITEST_CFG = join(repoRoot, 'packages/core-backend/vitest.config.ts')
const WORKFLOW = join(repoRoot, '.github/workflows/plugin-tests.yml')
const DOCKERFILE = join(repoRoot, 'Dockerfile.backend')
const ENV_EXAMPLE = join(repoRoot, '.env.example')
const PROBE_SRC = join(repoRoot, 'packages/core-backend/src/services/elearning-media-probe.ts')
const RUNTIME_SRC = join(repoRoot, 'packages/core-backend/src/services/elearning-media-runtime.ts')
const ROUTES_SRC = join(repoRoot, 'packages/core-backend/src/routes/elearning-media.ts')

const SUITES = [
  'tests/unit/elearning-media-validation.test.ts',
  'tests/unit/elearning-media-probe.test.ts',
  'tests/unit/elearning-media-storage.test.ts',
  'tests/unit/elearning-media-quota.test.ts',
  'tests/unit/elearning-media-runtime.test.ts',
  'tests/unit/elearning-media-routes.test.ts',
  'tests/unit/elearning-media-ingest.test.ts',
]

const DB_SUITE = 'tests/integration/elearning-media-quota.db.test.ts'

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
  for (const file of SUITES) {
    assert.ok(wf.includes(file), `plugin-tests.yml canary must name ${file}`)
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
