import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  isQuotedInTestExclude,
  isSuiteWiredInRealDbStep,
  requireExecutableRealDbStep,
} from './ci-realdb-step-contract.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const workflowPath = join(repoRoot, '.github/workflows/plugin-tests.yml')
const vitestPath = join(repoRoot, 'packages/core-backend/vitest.config.ts')
const workflow = readFileSync(workflowPath, 'utf8')
const vitest = readFileSync(vitestPath, 'utf8')
const realDbStepId = 'elearning-v01-content-assessment-schema-gate'
const wiringFile = 'scripts/ops/elearning-batch-assignment-ci-wiring.test.mjs'
const unitFiles = [
  'tests/unit/elearning-batch-assignment-routes.test.ts',
  'tests/unit/elearning-batch-assignment-runtime.test.ts',
  'tests/unit/elearning-batch-assignment.test.ts',
]
const dbFiles = [
  'tests/integration/elearning-assignment-target-snapshot-migration.db.test.ts',
  'tests/integration/elearning-batch-assignment.db.test.ts',
]

test('batch-assignment units are whole-file canaries before Postgres', () => {
  const unitStart = workflow.indexOf('id: elearning-v01-unit-canaries')
  const postgresStart = workflow.indexOf('- name: Start Postgres')
  assert.ok(unitStart >= 0 && postgresStart > unitStart)
  const unitStep = workflow.slice(unitStart, postgresStart)
  for (const file of unitFiles) {
    assert.ok(unitStep.includes(file), `${file} must be a whole-file unit canary`)
    assert.equal(workflow.split(file).length - 1, 1, `${file} must appear once in workflow`)
    assert.ok(existsSync(join(repoRoot, 'packages/core-backend', file)))
  }
  assert.equal(/\s-t(?:\s|=|$)/.test(unitStep), false)
  assert.equal(unitStep.includes('--testNamePattern'), false)
})

test('batch-assignment real-DB suites are excluded from no-DB and wired post-migrate', () => {
  const step = requireExecutableRealDbStep(workflow, realDbStepId)
  const run = typeof step.run === 'string' ? step.run : ''
  assert.match(run, /DATABASE_URL:\?/)
  assert.equal(/\s-t(?:\s|=|$)/.test(run), false)
  assert.equal(run.includes('--testNamePattern'), false)

  const migrateAt = workflow.indexOf('pnpm --filter @metasheet/core-backend db:migrate')
  const stepAt = workflow.indexOf(`id: ${realDbStepId}`)
  assert.ok(migrateAt >= 0 && stepAt > migrateAt)
  for (const file of dbFiles) {
    assert.ok(isQuotedInTestExclude(vitest, file), `${file} must be explicitly excluded`)
    assert.ok(
      isSuiteWiredInRealDbStep(workflow, realDbStepId, file),
      `${file} must be a whole-file post-migrate argument`,
    )
    assert.equal(workflow.split(file).length - 1, 1, `${file} must appear once in workflow`)
    assert.ok(existsSync(join(repoRoot, 'packages/core-backend', file)))
  }
})

test('real-DB suites refuse skip-shaped green and implementation files exist', () => {
  for (const file of dbFiles) {
    const source = readFileSync(join(repoRoot, 'packages/core-backend', file), 'utf8')
    assert.equal(source.includes('describe.skip'), false)
    assert.equal(source.includes('.skip('), false)
    assert.match(source, /if \(!DATABASE_URL\)/)
    assert.match(source, /throw new Error/)
    assert.match(source, /refusing skip-shaped green/)
  }
  for (const file of [
    'packages/core-backend/src/services/elearning-batch-assignment.ts',
    'packages/core-backend/src/db/migrations/zzzz20260826170000_add_elearning_assignment_target_snapshot.ts',
    'packages/openapi/src/paths/elearning.yml',
  ]) {
    assert.ok(existsSync(join(repoRoot, file)), `${file} must exist`)
  }
})

test('workflow runs this wiring contract before dependency installation', () => {
  assert.match(
    workflow,
    /node --test scripts\/ops\/elearning-batch-assignment-ci-wiring\.test\.mjs/,
  )
  const wiringAt = workflow.indexOf(wiringFile)
  const installAt = workflow.indexOf('pnpm install --frozen-lockfile')
  assert.ok(wiringAt >= 0 && installAt > wiringAt)
})
