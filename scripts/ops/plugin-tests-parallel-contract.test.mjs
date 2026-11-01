import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseYamlDocument } from './ci-realdb-step-contract.mjs'
import { REQUIRED_SUITES, requireSuccessfulSuites } from './plugin-tests-required-gate.mjs'
import { requiredSuiteJob, requiredSuiteJobBody } from './plugin-tests-workflow-contract.mjs'

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

// Only these explicit attendance additions are removed before the frozen baseline comparison.
const attendanceUnitStep = {
  name: 'Run approved correction exact target contracts',
  run: 'pnpm --filter @metasheet/core-backend exec vitest run \\\n  tests/unit/attendance-approved-correction-target-contract.test.ts \\\n  tests/unit/attendance-approved-correction-target-source.test.ts \\\n  tests/unit/attendance-approved-correction-plugin-contract.test.ts \\\n  tests/unit/attendance-approved-correction-write-admission.test.ts \\\n  tests/unit/attendance-approved-correction-authority-admission.test.ts \\\n  tests/unit/attendance-approved-correction-source-history.test.ts \\\n  tests/unit/attendance-approved-correction-group-v2.test.ts \\\n  tests/unit/attendance-approved-correction-async-input.test.ts \\\n  tests/unit/attendance-approved-correction-carry-execution.test.ts \\\n  --reporter=dot\n',
}
const attendanceDbLines = [
  '  tests/integration/attendance-approved-correction-targets.db.test.ts \\',
]

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
      if (suite === 'approval-db' && step.id === 'approval-real-db-integration') {
        // Explicit additive suite: preserve the frozen original command byte-for-byte.
        const addition = '  tests/integration/directory-controlled-handover.db.test.ts \\\n'
        const predecessor = '  tests/integration/directory-org-transfer-source-freeze.db.test.ts \\\n'
        assert.equal(step.run.split(addition).length - 1, 1, 'Handover DB suite must run exactly once')
        assert.ok(step.run.includes(predecessor + addition), 'Keep the new whole-file suite at its reviewed position')
        step.run = step.run.replace(addition, '')
      }
      if (suite !== 'unit' && step.name === 'Upload install log on failure') {
        assert.equal(step.with.name, `install-log-${nodeMatrix}-${suite}`)
        step.with.name = `install-log-${nodeMatrix}`
      }
    }
    if (suite === 'unit') {
      assert.equal(actual.filter(step => step.name === attendanceUnitStep.name).length, 1)
      const index = actual.findIndex(step => step.name === attendanceUnitStep.name)
      assert.equal(actual[index - 1]?.name, 'Run attendance shift segments W3 unit')
      assert.equal(actual[index + 1]?.name, 'Run attendance W4C-4 calculation detail and diff contracts')
      assert.deepEqual(actual.splice(index, 1), [attendanceUnitStep])
    }
    if (suite === 'attendance-db') {
      const matches = actual.filter(step => step.id === 'attendance-real-db-integration')
      assert.equal(matches.length, 1)
      const step = matches[0]
      // The frozen remainder pins these original neighbors to the first Vitest invocation.
      const block = [
        '  tests/integration/attendance-gate-e-txn-ownership-batch1.db.test.ts \\',
        '  tests/integration/attendance-w4c3b-request-operation-routes.db.test.ts \\',
        ...attendanceDbLines,
        '  tests/integration/attendance-w4c3b-approved-leave-cancellation.db.test.ts \\',
      ].join('\n') + '\n'
      assert.equal(step.run.split('\n' + block).length, 2)
      for (const line of attendanceDbLines) {
        assert.equal(step.run.split('\n').filter(candidate => candidate === line).length, 1)
        step.run = step.run.replace(line + '\n', '')
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
    doc => { const step = doc.jobs['approval-db'].steps.find(step => step.id === 'approval-real-db-integration'); step.run = step.run.replace('  tests/integration/directory-controlled-handover.db.test.ts \\\n', '') },
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

test('explicit attendance additions reject removal, reordering, filtering and changed DB files', () => {
  const doc = parseYamlDocument(workflow)
  assertParallelWorkflow(doc)
  const unitIndex = doc.jobs.unit.steps.findIndex(step => step.name === attendanceUnitStep.name)
  const mutations = [
    candidate => { candidate.jobs.unit.steps.splice(unitIndex, 1) },
    candidate => {
      const steps = candidate.jobs.unit.steps
      const [step] = steps.splice(unitIndex, 1)
      steps.splice(unitIndex + 1, 0, step)
    },
    candidate => { candidate.jobs.unit.steps[unitIndex].run += ' -t selected' },
    candidate => { candidate.jobs.unit.steps[unitIndex].run += ' --passWithNoTests' },
    candidate => { candidate.jobs.unit.steps[unitIndex].if = false },
    candidate => { candidate.jobs.unit.steps[unitIndex]['continue-on-error'] = true },
    candidate => { candidate.jobs.unit.steps.push(structuredClone(attendanceUnitStep)) },
  ]
  for (const mutate of mutations) {
    const candidate = structuredClone(doc)
    mutate(candidate)
    assert.throws(() => assertParallelWorkflow(candidate))
  }
  for (const line of attendanceDbLines) {
    for (const replacement of ['', line.replace('.db.test.ts', '.changed.db.test.ts') + '\n', line + '\n' + line + '\n']) {
      const candidate = structuredClone(doc)
      const step = candidate.jobs['attendance-db'].steps.find(step => step.id === 'attendance-real-db-integration')
      step.run = step.run.replace(line + '\n', replacement)
      assert.throws(() => assertParallelWorkflow(candidate))
    }
  }
})

test('attendance DB additions stay ordered in the original first Vitest invocation', () => {
  const doc = parseYamlDocument(workflow)
  assertParallelWorkflow(doc)
  const originalRun = doc.jobs['attendance-db'].steps.find(step => step.id === 'attendance-real-db-integration').run
  const timezoneLine = '  tests/integration/attendance-timezone-policy-routes.db.test.ts \\\n'
  assert.equal(originalRun.split(timezoneLine).length, 2)
  for (const line of attendanceDbLines) {
    const withoutLine = originalRun.replace(line + '\n', '')
    for (const run of [
      withoutLine.replace(timezoneLine, line + '\n' + timezoneLine),
      withoutLine + line + '\n',
    ]) {
      const candidate = structuredClone(doc)
      assert.notEqual(run, originalRun)
      candidate.jobs['attendance-db'].steps.find(step => step.id === 'attendance-real-db-integration').run = run
      assert.throws(() => assertParallelWorkflow(candidate))
    }
  }
})

const success = () => Object.fromEntries(REQUIRED_SUITES.map(id => [id, { result: 'success', outputs: {} }]))

test('Node-only wiring guards require exact gate headers without Python or npm dependencies', () => {
  for (const suite of REQUIRED_SUITES) assert.ok(requiredSuiteJobBody(workflow, suite))
  for (const candidate of [
    workflow.replace('    needs: [contracts, permissions, unit, checkpoint, runtime-db, multitable-db, approval-db, attendance-db]', '    needs: [contracts]'),
    workflow.replace('\n    if: always()\n', '\n    if: success()\n'),
    workflow.replace('  contracts:\n', '  "contracts":\n'),
    workflow.replace('  contracts:\n', '  contracts:\n    if: false\n'),
    workflow.replace('  contracts:\n', '  contracts:\n    continue-on-error: true\n'),
    workflow.replace('        node-version: [20.x]', '        node-version: [18.x]'),
    workflow.replace('    needs: [contracts, permissions]', '    needs: [permissions]'),
  ]) {
    assert.notEqual(candidate, workflow)
    assert.throws(() => requiredSuiteJobBody(candidate, 'contracts'))
  }
  const code = `import { readFileSync } from 'node:fs';
    import { requiredSuiteJobBody } from ${JSON.stringify(new URL('./plugin-tests-workflow-contract.mjs', import.meta.url).href)};
    const source = readFileSync(${JSON.stringify(fileURLToPath(new URL('../../.github/workflows/plugin-tests.yml', import.meta.url)))}, 'utf8');
    requiredSuiteJobBody(source, 'contracts');`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8', env: { ...process.env, PATH: '', Path: '' },
  })
  assert.equal(result.status, 0, result.stderr)
})

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
