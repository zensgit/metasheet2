import assert from 'node:assert/strict'
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

// Time Machine D2 is DATABASE_URL-gated real-DB proof. Each load-bearing spec must stay in both
// placements: direct `test.exclude` keeps the no-DB job from skip-greening it, and the exact-id
// real-DB step names the whole file. Parse both structures so comments, heredocs, title decoys,
// wrong steps, and similarly named files cannot satisfy the contract.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FILES = [
  'tests/integration/multitable-recovery-archive-catalog-realdb.test.ts',
  'tests/integration/multitable-recovery-archive-stale-pin-cleanup-realdb.test.ts',
  'tests/integration/multitable-recovery-archive-section-causality-realdb.test.ts',
]
const CONFIG = join(repoRoot, 'packages/core-backend/vitest.config.ts')
const WORKFLOW = join(repoRoot, '.github/workflows/plugin-tests.yml')
const INSTALL_STEP_MARKER = '      - name: Install dependencies (with log)\n'
const BEHAVIOR_STEP_MARKER = '      - name: Time Machine D2 archive real-DB fail-not-skip behavior\n'

function jobBody(workflow, jobName) {
  const marker = `  ${jobName}:\n`
  assert.equal(
    workflow.split(marker).length - 1,
    1,
    `plugin-tests.yml must contain exactly one ${jobName} job`,
  )
  const start = workflow.indexOf(marker) + marker.length
  const remainder = workflow.slice(start)
  const nextJob = remainder.match(/^  [A-Za-z0-9_-]+:\s*$/m)
  return nextJob ? remainder.slice(0, nextJob.index) : remainder
}

test('Time Machine D2 archive real-DB proofs are exactly two-point wired', () => {
  const config = readFileSync(CONFIG, 'utf8')
  const excludeBody = extractTestExcludeArrayBody(config)
  assert.notEqual(excludeBody, null, 'vitest.config.ts must have a direct test.exclude array')
  const exclusions = quotedExcludeEntries(excludeBody)
  for (const file of FILES) {
    assert.equal(
      exclusions.filter((entry) => entry === file).length,
      1,
      `test.exclude must contain exactly one quoted ${file} entry`,
    )
  }

  const workflow = readFileSync(WORKFLOW, 'utf8')
  const testJob = jobBody(workflow, 'test')
  assert.equal(
    testJob.split(INSTALL_STEP_MARKER).length - 1,
    1,
    'the required test job must contain exactly one dependency-install step marker',
  )
  assert.equal(
    testJob.split(BEHAVIOR_STEP_MARKER).length - 1,
    1,
    'the required test job must contain exactly one D2 fail-not-skip behavior step',
  )
  assert.ok(
    testJob.indexOf(BEHAVIOR_STEP_MARKER) > testJob.indexOf(INSTALL_STEP_MARKER),
    'the D2 behavioral fail-not-skip proof must run after dependencies are installed',
  )
  const step = requireExecutableRealDbStep(workflow, REAL_DB_STEP_IDS.multitable)
  assert.ok(step.env && typeof step.env === 'object' && !Array.isArray(step.env))
  assert.equal(
    step.env.METASHEET_REAL_DB_TEST_STEP,
    '1',
    `${REAL_DB_STEP_IDS.multitable} must arm the D2 fail-not-skip marker with exact string '1'`,
  )
  const fileArgs = wholeFileVitestArgs(step)
  for (const file of FILES) {
    assert.equal(
      fileArgs.filter((arg) => arg === file).length,
      1,
      `the parsed ${REAL_DB_STEP_IDS.multitable} step must contain exactly one whole-file Vitest argument ${file}`,
    )
  }
})
