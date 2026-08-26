import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  REAL_DB_STEP_IDS,
  extractTestExcludeArrayBody,
  quotedExcludeEntries,
  requireExecutableRealDbStep,
  wholeFileVitestArgs,
} from './ci-realdb-step-contract.mjs'

// Time Machine D2a is a DATABASE_URL-gated real-DB proof. Its two load-bearing CI placements
// must stay in sync: direct `test.exclude` keeps the no-DB job from skip-greening it, and the
// exact-id real-DB step names the whole file. Parse both structures so comments, heredocs, title
// decoys, wrong steps, and similarly named files cannot satisfy the contract.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FILE = 'tests/integration/multitable-recovery-archive-catalog-realdb.test.ts'
const CONFIG = join(repoRoot, 'packages/core-backend/vitest.config.ts')
const WORKFLOW = join(repoRoot, '.github/workflows/plugin-tests.yml')
const CORE_BACKEND = join(repoRoot, 'packages/core-backend')
const VITEST = join(repoRoot, 'node_modules/.bin/vitest')

test('Time Machine D2a archive-catalog proof is exactly two-point wired', () => {
  const config = readFileSync(CONFIG, 'utf8')
  const excludeBody = extractTestExcludeArrayBody(config)
  assert.notEqual(excludeBody, null, 'vitest.config.ts must have a direct test.exclude array')
  const exclusions = quotedExcludeEntries(excludeBody).filter((entry) => entry === FILE)
  assert.equal(
    exclusions.length,
    1,
    `test.exclude must contain exactly one quoted ${FILE} entry`,
  )

  const workflow = readFileSync(WORKFLOW, 'utf8')
  const step = requireExecutableRealDbStep(workflow, REAL_DB_STEP_IDS.multitable)
  assert.ok(step.env && typeof step.env === 'object' && !Array.isArray(step.env))
  assert.equal(
    step.env.METASHEET_REAL_DB_TEST_STEP,
    '1',
    `${REAL_DB_STEP_IDS.multitable} must arm the D2a fail-not-skip marker with exact string '1'`,
  )
  const fileArgs = wholeFileVitestArgs(step).filter((arg) => arg === FILE)
  assert.equal(
    fileArgs.length,
    1,
    `the parsed ${REAL_DB_STEP_IDS.multitable} step must contain exactly one whole-file Vitest argument ${FILE}`,
  )
})

test('the armed D2a real-DB spec fails instead of skipping when DATABASE_URL is absent', () => {
  const env = {
    ...process.env,
    METASHEET_REAL_DB_TEST_STEP: '1',
  }
  delete env.DATABASE_URL

  const result = spawnSync(VITEST, ['--config', 'vitest.integration.config.ts', 'run', FILE, '--reporter=dot'], {
    cwd: CORE_BACKEND,
    env,
    encoding: 'utf8',
  })
  assert.ifError(result.error)
  assert.equal(result.signal, null)
  assert.notEqual(result.status, 0, 'the armed real-DB file must fail when DATABASE_URL is absent')
  assert.match(`${result.stdout}\n${result.stderr}`, /recovery_archive_realdb_harness_missing_database_url/)
})
