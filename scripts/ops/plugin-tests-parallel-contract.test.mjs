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
// Explicit additive contracts steps: suites promoted from the non-required k3wise-offline-poc job.
const closeoutContractsStep = {
  name: 'DingTalk closeout env and OAuth-stability contracts (required lane)',
  run: 'node --test \\\n  scripts/ops/dingtalk-closeout-env-contract.test.mjs \\\n  scripts/ops/dingtalk-oauth-stability-metrics-auth-contract.test.mjs \\\n  scripts/ops/dingtalk-oauth-stability-metrics-only-contract.test.mjs \\\n  scripts/ops/dingtalk-oauth-stability-metrics-only-fullscript.test.mjs \\\n  scripts/ops/github-dingtalk-oauth-stability-summary.test.mjs\n',
}
// Explicit additive contracts step: the lifecycle canary exclusion consistency contract (standalone;
// the canary contract suite itself must never be referenced by plugin-tests.yml).
const canaryExclusionConsistencyStep = {
  name: 'DingTalk lifecycle canary exclusion consistency contract (required lane)',
  run: 'node --test scripts/ops/dingtalk-lifecycle-canary-exclusion-consistency.test.mjs',
}
const directoryWiringContractsStep = {
  name: 'Directory grant-table, deprovision-writer and access-graph-mutex CI-wiring contracts (required lane)',
  run: 'node --test \\\n  scripts/ops/directory-grant-table-ci-wiring.test.mjs \\\n  scripts/ops/directory-deprovision-writer-ci-wiring.test.mjs \\\n  scripts/ops/directory-access-graph-mutex-ci-wiring.test.mjs\n',
}
const permissionStep = {
  name: 'Admin write-route inventory and permission preflight',
  run: 'pnpm --filter @metasheet/core-backend exec vitest run \\\n  tests/unit/admin-mounts-write-gate-guard.test.ts \\\n  tests/unit/admin-directory-routes.test.ts \\\n  tests/unit/admin-directory-5xx-values-free.test.ts\n',
}

const directoryClientLintStep = {
  name: 'Run DingTalk directory client lint',
  if: "matrix.node-version == '20.x'",
  'working-directory': 'packages/core-backend',
  run: 'pnpm exec eslint --no-cache src/integrations/dingtalk/client.ts src/integrations/dingtalk/directory-response-ids.ts src/directory/directory-sync.ts src/directory/directory-department-cycle.ts',
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
    if (suite === 'contracts') {
      assert.deepEqual(actual.splice(2, 1), [inventoryStep])
      const inventoryIndex = actual.findIndex(step => step.id === 'dingtalk-production-readiness-inventory-contract')
      assert.ok(inventoryIndex >= 0, 'Keep the original DingTalk production-readiness inventory step')
      assert.deepEqual(actual.splice(inventoryIndex + 1, 1), [closeoutContractsStep],
        'Keep the promoted DingTalk closeout contracts immediately after the inventory step')
      assert.deepEqual(actual.splice(inventoryIndex + 1, 1), [canaryExclusionConsistencyStep],
        'Keep the lifecycle canary exclusion consistency contract immediately after the closeout contracts step')
      const sourceLockIndex = actual.findIndex(step => step.name === 'Directory activation source-lock CI-wiring contract (required lane)')
      assert.ok(sourceLockIndex >= 0, 'Keep the original directory activation source-lock step')
      assert.deepEqual(actual.splice(sourceLockIndex + 1, 1), [directoryWiringContractsStep],
        'Keep the promoted directory CI-wiring contracts immediately after the source-lock step')
    }
    if (suite === 'permissions') assert.deepEqual(actual.splice(-1), [permissionStep])
    if (suite === 'unit') {
      const lintIndex = actual.findIndex(step => step.name === 'Run linting')
      assert.ok(lintIndex >= 0, 'Keep the original lint step')
      assert.deepEqual(actual.splice(lintIndex + 1, 1), [directoryClientLintStep],
        'Keep the additional configured DingTalk client lint immediately after the original lint')
    }
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
        const repairAddition = '  tests/integration/dingtalk-login-repair.db.test.ts \\\n'
        assert.equal(step.run.split(repairAddition).length - 1, 1, 'Login repair DB suite must run exactly once')
        assert.ok(step.run.includes(addition + repairAddition), 'Keep the login repair suite at its reviewed position')
        step.run = step.run.replace(addition, '')
        step.run = step.run.replace(repairAddition, '')
      }
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
    doc => { const step = doc.jobs['approval-db'].steps.find(step => step.id === 'approval-real-db-integration'); step.run = step.run.replace('  tests/integration/directory-controlled-handover.db.test.ts \\\n', '') },
    doc => { const step = doc.jobs['approval-db'].steps.find(step => step.id === 'approval-real-db-integration'); step.run = step.run.replace('  tests/integration/dingtalk-login-repair.db.test.ts \\\n', '') },
    doc => { const step = doc.jobs['approval-db'].steps.find(step => step.id === 'approval-real-db-integration'); const line = '  tests/integration/dingtalk-login-repair.db.test.ts \\\n', anchor = '  tests/integration/directory-source-freeze-lock-correctness.db.test.ts \\\n'; assert.ok(step.run.includes(anchor)); step.run = step.run.replace(line, '').replace(anchor, anchor + line) },
    doc => { const steps = doc.jobs.unit.steps; steps.splice(steps.findIndex(step => step.name === directoryClientLintStep.name), 1) },
    doc => { doc.jobs.unit.steps.find(step => step.name === directoryClientLintStep.name).run += ' || true' },
    doc => { doc.jobs.unit.steps.find(step => step.name === directoryClientLintStep.name).if = false },
    doc => { doc.jobs.unit.steps.find(step => step.name === directoryClientLintStep.name)['working-directory'] = '.' },
    doc => { const steps = doc.jobs.unit.steps; const index = steps.findIndex(step => step.name === directoryClientLintStep.name); [steps[index - 1], steps[index]] = [steps[index], steps[index - 1]] },
    doc => { doc.jobs.unit.steps.push(structuredClone(directoryClientLintStep)) },
    doc => { doc.jobs.unit.steps.pop() },
    doc => { doc.jobs.unit.steps.find(step => step.name === 'Run core-backend tests').run += ' -t selected' },
    doc => { doc.jobs['attendance-db'].steps.find(step => step.id === 'attendance-real-db-integration').if = false },
    doc => { doc.jobs['multitable-db'].steps.find(step => step.id === 'multitable-real-db-integration').run = 'echo skipped' },
    doc => { doc.jobs.contracts.steps.reverse() },
    ...[
      [closeoutContractsStep, '  scripts/ops/dingtalk-closeout-env-contract.test.mjs \\\n'],
      [canaryExclusionConsistencyStep, 'scripts/ops/dingtalk-lifecycle-canary-exclusion-consistency.test.mjs'],
      [directoryWiringContractsStep, '  scripts/ops/directory-deprovision-writer-ci-wiring.test.mjs \\\n'],
    ].flatMap(([promoted, file]) => [
      doc => { const steps = doc.jobs.contracts.steps; steps.splice(steps.findIndex(step => step.name === promoted.name), 1) },
      doc => { doc.jobs.contracts.steps.find(step => step.name === promoted.name).run += ' || true' },
      doc => { doc.jobs.contracts.steps.find(step => step.name === promoted.name).if = false },
      doc => { doc.jobs.contracts.steps.find(step => step.name === promoted.name)['continue-on-error'] = true },
      doc => { const step = doc.jobs.contracts.steps.find(step => step.name === promoted.name); assert.ok(step.run.includes(file)); step.run = step.run.replace(file, '') },
      doc => { const steps = doc.jobs.contracts.steps; const index = steps.findIndex(step => step.name === promoted.name); [steps[index - 1], steps[index]] = [steps[index], steps[index - 1]] },
      doc => { doc.jobs.contracts.steps.push(structuredClone(promoted)) },
    ]),
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
