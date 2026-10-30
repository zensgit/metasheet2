import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseYamlDocument } from './ci-realdb-step-contract.mjs'
import { REQUIRED_SUITES, requireSuccessfulSuites } from './plugin-tests-required-gate.mjs'
import { requiredSuiteJob } from './plugin-tests-workflow-contract.mjs'

const workflow = readFileSync(new URL('../../.github/workflows/plugin-tests.yml', import.meta.url), 'utf8')
const baseline = JSON.parse(readFileSync(new URL('./fixtures/plugin-tests-serial-baseline-20261030.json', import.meta.url)))
const nodeMatrix = '${{ matrix.node-version }}'

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
}

const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const inventoryStep = {
  name: 'Parallel test inventory and required-gate contract',
  run: 'node --test scripts/ops/plugin-tests-parallel-contract.test.mjs',
}
const permissionStep = {
  name: 'Admin write-route inventory and permission preflight',
  run: 'pnpm --filter @metasheet/core-backend exec vitest run \\\n  tests/unit/admin-mounts-write-gate-guard.test.ts \\\n  tests/unit/admin-directory-routes.test.ts \\\n  tests/unit/admin-directory-5xx-values-free.test.ts\n',
}

function resultUpload(suite) {
  return {
    name: `Upload ${suite} test results`, if: 'always()', uses: 'actions/upload-artifact@v4',
    with: {
      name: `test-results-${suite}-${nodeMatrix}`,
      path: 'packages/core-backend/coverage/\npackages/core-backend/test-results/\n',
    },
  }
}

function assertParallelWorkflow(doc) {
  const metadata = Object.fromEntries(Object.entries(doc).filter(([key]) => key !== 'jobs'))
  assert.equal(digest(metadata), baseline.workflowMetadataSha256, 'Triggers, concurrency and workflow environment stay unchanged')
  assert.deepEqual(Object.keys(doc.jobs).sort(), [...REQUIRED_SUITES, 'test', ...Object.keys(baseline.otherJobs)].sort())
  for (const [id, hash] of Object.entries(baseline.otherJobs)) {
    assert.equal(digest(doc.jobs[id]), hash, `${id} remains unchanged`)
  }
  for (const suite of REQUIRED_SUITES) {
    const job = requiredSuiteJob(doc, suite)
    assert.equal(job['runs-on'], 'ubuntu-22.04', 'Keep the original isolated hosted VM')
    assert.deepEqual(Object.keys(job).sort(), [
      'runs-on', 'timeout-minutes', 'strategy', 'steps',
      ...(['contracts', 'permissions'].includes(suite) ? [] : ['needs']),
    ].sort(), 'No inherited env/defaults/services/outputs may change test execution')
    const originals = baseline.steps.filter(step => step.jobs.includes(suite))
    const actual = structuredClone(job.steps)
    if (suite === 'contracts') assert.deepEqual(actual.splice(2, 1), [inventoryStep])
    if (suite === 'permissions') assert.deepEqual(actual.splice(-1), [permissionStep])
    if (!['contracts', 'permissions', 'unit'].includes(suite)) {
      assert.deepEqual(actual.splice(-1), [resultUpload(suite)])
    }
    for (const step of actual) {
      if (suite !== 'unit' && step.name === 'Upload install log on failure') {
        assert.equal(step.with.name, `install-log-${nodeMatrix}-${suite}`)
        step.with.name = `install-log-${nodeMatrix}`
      }
    }
    assert.deepEqual(actual.map(digest), originals.map(step => step.sha256),
      `${suite} must preserve every original step, condition, command and order`)
  }
  const gate = doc.jobs.test
  assert.equal(gate['runs-on'], 'ubuntu-latest')
  assert.deepEqual(Object.keys(gate).sort(), ['needs', 'if', 'runs-on', 'timeout-minutes', 'strategy', 'steps'].sort())
  assert.equal(gate.steps.length, 3)
  assert.deepEqual(gate.steps.slice(0, 2).map(digest), baseline.steps.slice(0, 2).map(step => step.sha256))
  assert.deepEqual(gate.steps[2], {
    name: 'Require every parallel suite to succeed',
    env: { PLUGIN_TEST_RESULTS: '${{ toJSON(needs) }}' },
    run: 'node scripts/ops/plugin-tests-required-gate.mjs',
  })
}

test('all 129 original steps retain their commands, conditions and required-gate coverage', () => {
  assert.equal(baseline.sourceCommit, '2006826d772b9f693d878bff7d18bf275dead299')
  assert.equal(baseline.steps.length, 129)
  for (const step of baseline.steps) {
    assert.ok(step.jobs.length > 0)
    if (![0, 1, 60, 61, 62, 63, 64, 65, 66, 90, 91, 97].includes(step.index)) {
      assert.equal(step.jobs.length, 1, `${step.name} must execute exactly once`)
    }
  }
  assertParallelWorkflow(parseYamlDocument(workflow))
})

test('each database suite owns a fresh runner/database and migration ordering', () => {
  const doc = parseYamlDocument(workflow)
  for (const suite of ['checkpoint', 'runtime-db', 'multitable-db', 'approval-db', 'attendance-db']) {
    const steps = requiredSuiteJob(doc, suite).steps
    const setup = steps.findIndex(step => step.name === 'Start Postgres')
    const create = steps.findIndex(step => step.name === 'Create test database')
    assert.ok(setup > 0 && create > setup)
    if (suite === 'checkpoint') continue // its unchanged protocols create their own disposable DBs
    const migration = steps.findIndex(step => step.name === 'Run DB migrations')
    assert.ok(migration > create)
    assert.ok(steps.slice(migration + 1).some(step => step.run))
  }
})

test('removed/filtered/reordered steps, disabled suites and a weakened aggregate are rejected', () => {
  const mutations = [
    doc => { doc.jobs.unit.steps.pop() },
    doc => { doc.jobs.unit.steps.find(step => step.name === 'Run core-backend tests').run += ' -t selected' },
    doc => { doc.jobs['attendance-db'].steps.find(step => step.id === 'attendance-real-db-integration').if = false },
    doc => { doc.jobs['multitable-db'].steps.find(step => step.id === 'multitable-real-db-integration').run = 'echo skipped' },
    doc => { doc.jobs.contracts.steps.reverse() },
    doc => { doc.jobs.permissions.steps.at(-1).run = 'true' },
    doc => { doc.jobs.unit.if = false },
    doc => { doc.jobs.unit['continue-on-error'] = true },
    doc => { doc.jobs.unit.needs = ['contracts'] },
    doc => { doc.jobs.unit.strategy.matrix['node-version'] = ['18.x'] },
    doc => { doc.jobs.unit.env = { DATABASE_URL: '' } },
    doc => { doc.jobs.test.needs.pop() },
    doc => { doc.jobs.test.if = 'success()' },
    doc => { doc.jobs.test.name = 'new name' },
    doc => { doc.jobs.test.steps.at(-1).run += ' || true' },
    doc => { doc.jobs.test.steps.at(-1).if = false },
    doc => { doc.jobs.coverage.steps.pop() },
    doc => { delete doc.on; delete doc.True },
    doc => { doc.concurrency.group = 'shared-across-PRs' },
  ]
  for (const mutate of mutations) {
    const candidate = structuredClone(parseYamlDocument(workflow))
    mutate(candidate)
    assert.throws(() => assertParallelWorkflow(candidate))
  }
})

const success = () => Object.fromEntries(REQUIRED_SUITES.map(id => [id, { result: 'success', outputs: {} }]))

test('every failure, cancellation, skip, missing or unknown suite fails the required gate', () => {
  requireSuccessfulSuites(success())
  for (const suite of REQUIRED_SUITES) {
    for (const status of ['failure', 'cancelled', 'skipped', 'pending', 'SUCCESS', '', null, undefined]) {
      const results = success()
      results[suite].result = status
      assert.throws(() => requireSuccessfulSuites(results))
    }
    const missing = success()
    delete missing[suite]
    assert.throws(() => requireSuccessfulSuites(missing))
  }
  assert.throws(() => requireSuccessfulSuites({ ...success(), unexpected: { result: 'success' } }))
  for (const input of [null, [], {}, 'success']) assert.throws(() => requireSuccessfulSuites(input))
})

test('required-gate executable propagates failure and never prints its input environment', () => {
  const cli = fileURLToPath(new URL('./plugin-tests-required-gate.mjs', import.meta.url))
  const cases = [[JSON.stringify(success()), 0], ['not-json-private-value', 1], ['null', 1], [undefined, 1]]
  for (const suite of REQUIRED_SUITES) {
    for (const status of ['failure', 'cancelled', 'skipped']) {
      const results = success()
      results[suite].result = status
      cases.push([JSON.stringify(results), 1])
    }
  }
  for (const [input, expected] of cases) {
    const env = { ...process.env }
    delete env.PLUGIN_TEST_RESULTS
    if (input !== undefined) env.PLUGIN_TEST_RESULTS = input
    const result = spawnSync(process.execPath, [cli], { encoding: 'utf8', env })
    assert.equal(result.status, expected)
    assert.doesNotMatch(result.stdout + result.stderr, /not-json|private-value|"result"/)
  }
})
