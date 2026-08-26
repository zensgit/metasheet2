import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  REAL_DB_STEP_IDS,
  isQuotedInTestExclude,
  isSuiteWiredInRealDbStep,
  realDbStepWholeFileArgs,
  requireExecutableRealDbStep,
} from './ci-realdb-step-contract.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const workflowPath = join(repoRoot, '.github/workflows/plugin-tests.yml')
const vitestPath = join(repoRoot, 'packages/core-backend/vitest.config.ts')
const workflow = readFileSync(workflowPath, 'utf8')
const vitest = readFileSync(vitestPath, 'utf8')
const stepId = 'elearning-v01-content-assessment-schema-gate'
const mediaStepId = 'elearning-v01-media-quota-real-db'
const unitFile = 'tests/unit/elearning-notification-delivery.test.ts'
const dbFile = 'tests/integration/elearning-notification-delivery.db.test.ts'
const wiringFile = 'scripts/ops/elearning-notification-delivery-ci-wiring.test.mjs'
const migrationFile =
  'packages/core-backend/src/db/migrations/zzzz20260826210000_create_elearning_notification_deliveries.ts'
const serviceFile =
  'packages/core-backend/src/services/elearning-notification-delivery.ts'

test('notification unit and real-DB suites are exact whole-file canaries', () => {
  const unitStart = workflow.indexOf('id: elearning-v01-unit-canaries')
  const postgresStart = workflow.indexOf('- name: Start Postgres')
  assert.ok(unitStart >= 0 && postgresStart > unitStart)
  const unitStep = workflow.slice(unitStart, postgresStart)
  assert.ok(unitStep.includes(unitFile))
  assert.equal(workflow.split(unitFile).length - 1, 1)

  const step = requireExecutableRealDbStep(workflow, stepId)
  const run = typeof step.run === 'string' ? step.run : ''
  assert.match(run, /DATABASE_URL:\?/)
  assert.equal(/\s-t(?:\s|=|$)/.test(run), false)
  assert.equal(run.includes('--testNamePattern'), false)
  assert.ok(isQuotedInTestExclude(vitest, dbFile))
  assert.ok(isSuiteWiredInRealDbStep(workflow, stepId, dbFile))
  assert.equal(workflow.split(dbFile).length - 1, 1)
  assert.equal(realDbStepWholeFileArgs(workflow, mediaStepId).includes(dbFile), false)
  assert.equal(
    realDbStepWholeFileArgs(workflow, REAL_DB_STEP_IDS.approval).includes(dbFile),
    false,
  )
  assert.equal(
    realDbStepWholeFileArgs(workflow, REAL_DB_STEP_IDS.multitable).includes(dbFile),
    false,
  )
})

test('notification ledger files exist and the real-DB suite refuses skip green', () => {
  for (const file of [
    migrationFile,
    serviceFile,
    `packages/core-backend/${unitFile}`,
    `packages/core-backend/${dbFile}`,
  ]) {
    assert.ok(existsSync(join(repoRoot, file)), `${file} must exist`)
  }
  const source = readFileSync(join(repoRoot, 'packages/core-backend', dbFile), 'utf8')
  assert.equal(source.includes('describe.skip'), false)
  assert.equal(source.includes('.skip('), false)
  assert.match(source, /if \(!DATABASE_URL\)/)
  assert.match(source, /refusing skip-shaped green/)
  assert.match(source, /kysely_migration/)
  assert.equal(source.includes('await up('), false)
})

test('this slice is an inert intent ledger, not a reachable sender', () => {
  const migration = readFileSync(join(repoRoot, migrationFile), 'utf8')
  const service = readFileSync(join(repoRoot, serviceFile), 'utf8')
  assert.match(migration, /CREATE TABLE elearning_notification_deliveries/)
  assert.equal(migration.includes('CREATE TABLE IF NOT EXISTS'), false)
  assert.equal(migration.includes('CREATE INDEX IF NOT EXISTS'), false)
  assert.match(migration, /UNIQUE \(org_id, source_key\)/)
  assert.match(migration, /FOREIGN KEY \(org_id, assignment_member_id\)/)
  assert.match(service, /enqueueElearningNotificationDelivery/)
  assert.equal(service.includes('http.addRoute'), false)
  assert.equal(service.includes('/api/elearning'), false)
  assert.equal(service.includes('context.services.notification'), false)
  assert.equal(service.includes('attendanceScheduler'), false)
  assert.equal(service.includes('setInterval'), false)
})

test('workflow runs this wiring contract before dependency installation', () => {
  const token = `node --test ${wiringFile}`
  const wiringAt = workflow.indexOf(token)
  const installAt = workflow.indexOf('pnpm install --frozen-lockfile')
  assert.ok(wiringAt >= 0 && installAt > wiringAt)
})
