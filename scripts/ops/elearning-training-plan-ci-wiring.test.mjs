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
const wiringFile = 'scripts/ops/elearning-training-plan-ci-wiring.test.mjs'
const unitFiles = [
  'tests/unit/elearning-training-plan-routes.test.ts',
  'tests/unit/elearning-training-plan.test.ts',
]
const dbFile = 'tests/integration/elearning-training-plan.db.test.ts'

test('training-plan units and generated OpenAPI contract are whole-file canaries', () => {
  const unitStart = workflow.indexOf('id: elearning-v01-unit-canaries')
  const postgresStart = workflow.indexOf('- name: Start Postgres')
  assert.ok(unitStart >= 0 && postgresStart > unitStart)
  const unitStep = workflow.slice(unitStart, postgresStart)
  for (const file of unitFiles) {
    assert.ok(unitStep.includes(file), `${file} must be a whole-file unit canary`)
    assert.equal(workflow.split(file).length - 1, 1, `${file} must appear once in workflow`)
    assert.ok(existsSync(join(repoRoot, 'packages/core-backend', file)))
  }
  assert.ok(unitStep.includes('tests/elearning-paths.test.ts'))
  assert.equal(/\s-t(?:\s|=|$)/.test(unitStep), false)
  assert.equal(unitStep.includes('--testNamePattern'), false)
})

test('training-plan real-DB suite is excluded from no-DB and wired post-migrate', () => {
  const step = requireExecutableRealDbStep(workflow, realDbStepId)
  const run = typeof step.run === 'string' ? step.run : ''
  assert.match(run, /DATABASE_URL:\?/)
  assert.equal(/\s-t(?:\s|=|$)/.test(run), false)
  assert.equal(run.includes('--testNamePattern'), false)
  assert.ok(isQuotedInTestExclude(vitest, dbFile))
  assert.ok(isSuiteWiredInRealDbStep(workflow, realDbStepId, dbFile))
  assert.equal(workflow.split(dbFile).length - 1, 1)
  assert.ok(existsSync(join(repoRoot, 'packages/core-backend', dbFile)))

  const source = readFileSync(join(repoRoot, 'packages/core-backend', dbFile), 'utf8')
  assert.equal(source.includes('describe.skip'), false)
  assert.equal(source.includes('.skip('), false)
  assert.match(source, /if \(!DATABASE_URL\)/)
  assert.match(source, /refusing skip-shaped green/)
})

test('implementation, migration, route, and OpenAPI sources exist', () => {
  for (const file of [
    'packages/core-backend/src/db/migrations/zzzz20260826180000_create_elearning_training_plans.ts',
    'packages/core-backend/src/services/elearning-training-plan.ts',
    'packages/core-backend/src/routes/elearning-pilot.ts',
    'packages/openapi/src/paths/elearning.yml',
    'packages/openapi/src/base.yml',
  ]) {
    assert.ok(existsSync(join(repoRoot, file)), `${file} must exist`)
  }
})

test('workflow runs this wiring contract before dependency installation', () => {
  const token = `node --test ${wiringFile}`
  const wiringAt = workflow.indexOf(token)
  const installAt = workflow.indexOf('pnpm install --frozen-lockfile')
  assert.ok(wiringAt >= 0 && installAt > wiringAt)
})
