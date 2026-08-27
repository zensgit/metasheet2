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
  'tests/integration/multitable-recovery-archive-operation-binding-realdb.test.ts',
  'tests/integration/multitable-recovery-archive-coverage-binding-realdb.test.ts',
  'tests/integration/multitable-recovery-archive-key-registry-realdb.test.ts',
  'tests/integration/multitable-recovery-archive-source-pin-authority-realdb.test.ts',
  'tests/integration/multitable-recovery-archive-object-receipt-authority-realdb.test.ts',
  'tests/integration/multitable-recovery-archive-crypto-registry-realdb.test.ts',
  'tests/integration/multitable-recovery-archive-writer-block-realdb.test.ts',
]
const ARCHIVE_REALDB_RE =
  /^tests\/integration\/multitable-recovery-archive-[a-z0-9-]+-realdb\.test\.ts$/
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

function archiveRoster(paths) {
  return paths.filter((path) => ARCHIVE_REALDB_RE.test(path))
}

function assertExactRoster(paths, label) {
  const roster = archiveRoster(paths)
  assert.deepEqual(
    FILES,
    [...new Set(FILES)],
    'the D2 archive FILES constant must itself be duplicate-free',
  )
  assert.deepEqual(
    roster,
    FILES,
    `${label} must list the D2 archive real-DB roster exactly once, in order, with no duplicates or extras`,
  )
  const start = paths.indexOf(FILES[0])
  assert.notEqual(start, -1, `${label} must contain the D2 archive catalog file`)
  assert.deepEqual(
    paths.slice(start, start + FILES.length),
    FILES,
    `${label} must keep the D2 archive real-DB union contiguous`,
  )
}

function assertD2ArchiveWiring(config, workflow) {
  const excludeBody = extractTestExcludeArrayBody(config)
  assert.notEqual(excludeBody, null, 'vitest.config.ts must have a direct test.exclude array')
  assertExactRoster(quotedExcludeEntries(excludeBody), 'test.exclude')

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
  assertExactRoster(
    wholeFileVitestArgs(step),
    `the parsed ${REAL_DB_STEP_IDS.multitable} whole-file Vitest arguments`,
  )
}

test('Time Machine D2 archive real-DB proofs are exactly two-point wired', () => {
  assertD2ArchiveWiring(readFileSync(CONFIG, 'utf8'), readFileSync(WORKFLOW, 'utf8'))
})

test('D2 archive roster contract rejects a duplicate section-causality whole-file arg', () => {
  const config = readFileSync(CONFIG, 'utf8')
  const workflow = readFileSync(WORKFLOW, 'utf8')
  const duplicated = workflow.replace(
    'tests/integration/multitable-recovery-archive-section-causality-realdb.test.ts \\\n            tests/integration/multitable-recovery-archive-operation-binding-realdb.test.ts',
    'tests/integration/multitable-recovery-archive-section-causality-realdb.test.ts \\\n            tests/integration/multitable-recovery-archive-section-causality-realdb.test.ts \\\n            tests/integration/multitable-recovery-archive-operation-binding-realdb.test.ts',
  )
  assert.notEqual(duplicated, workflow, 'section-causality duplication mutation must apply')
  assert.throws(() => assertD2ArchiveWiring(config, duplicated), (error) => {
    assert.match(String(error.message), /no duplicates or extras/)
    return true
  })
})

test('D2 archive roster contract rejects dropping operation-binding from the union', () => {
  const config = readFileSync(CONFIG, 'utf8')
  const workflow = readFileSync(WORKFLOW, 'utf8')
  const dropped = workflow.replace(
    '            tests/integration/multitable-recovery-archive-operation-binding-realdb.test.ts \\\n',
    '',
  )
  assert.notEqual(dropped, workflow, 'operation-binding removal mutation must apply')
  assert.throws(() => assertD2ArchiveWiring(config, dropped), (error) => {
    assert.match(String(error.message), /no duplicates or extras/)
    return true
  })
})
