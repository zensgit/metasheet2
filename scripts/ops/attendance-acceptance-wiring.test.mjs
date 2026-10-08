import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml')
const root = process.cwd()
const read = file => readFileSync(path.join(root, file), 'utf8')
const sha = 'a'.repeat(40)
const proof = { checkoutSha: 'b'.repeat(40), expectedDeploymentSha: sha, observedDeploymentSha: sha, source: 'backend_health_build_commit' }
const workflowCases = [
  ['attendance-strict-gates-prod.yml', 'strict-gates'],
  ['attendance-locale-zh-smoke-prod.yml', 'smoke'],
  ['attendance-import-perf-baseline.yml', 'perf'],
  ['attendance-import-perf-highscale.yml', 'perf'],
  ['attendance-import-perf-longrun.yml', 'perf-scenarios'],
]

for (const [filename, jobName] of workflowCases) {
  test(`${filename} binds fallback and auth verification to the synthetic organization`, () => {
    const workflow = yaml.load(read(`.github/workflows/${filename}`))
    const job = workflow.jobs[jobName]
    assert.ok(job, jobName)
    const expected = job.env.ORG_ID
    assert.match(expected, /vars\.ATTENDANCE_SYNTHETIC_ORG_ID/)
    assert.doesNotMatch(expected, /'default'|vars\.ATTENDANCE_ORG_ID/)
    assert.equal(job.env.ATTENDANCE_SMOKE_ORG_ID, expected)
    assert.equal(job.env.AUTH_EXPECTED_TENANT_ID, expected)
    const auth = job.steps.findIndex(step => step.name === 'Resolve valid auth token')
    const guard = job.steps.findIndex(step => ['Verify configured acceptance target', 'Require synthetic organization'].includes(step.name))
    assert.ok(guard >= 0 && guard < auth)
    if (filename === 'attendance-locale-zh-smoke-prod.yml') assert.equal(workflow.on.workflow_dispatch.inputs.org_id.default, '')
    if (filename.includes('-prod')) {
      assert.equal(job.env.ATTENDANCE_SYNTHETIC_ORG_ID, expected)
      assert.equal(job.env.ATTENDANCE_EXPECTED_DEPLOY_SHA, "${{ vars.ATTENDANCE_EXPECTED_DEPLOY_SHA || '' }}")
      assert.match(job.steps[guard].run, /node scripts\/ops\/attendance-acceptance-preflight\.mjs/)
    }
  })
}

test('hermetic acceptance tests are in the strict contract job', () => {
  const matrix = yaml.load(read('.github/workflows/attendance-gate-contract-matrix.yml'))
  assert.ok(matrix.jobs.contracts.strategy.matrix.case_id.includes('strict'))
  const run = read('scripts/ops/attendance-run-gate-contract-case.sh').split('if [[ "$CASE_ID" == "strict" ]]; then')[1].split('\nfi')[0]
  for (const file of ['attendance-acceptance-preflight', 'attendance-acceptance-wiring', 'attendance-provision-user', 'attendance-verifier-contract', 'attendance-auth-scripts', 'resolve-attendance-smoke-token']) {
    assert.match(run, new RegExp(`scripts/ops/${file}\\.test\\.mjs(?:\\s|$)`))
  }
})

function shellFixture(run) {
  const dir = mkdtempSync(path.join(tmpdir(), 'attendance-gate-tooling-'))
  const ops = path.join(dir, 'scripts/ops')
  const bin = path.join(dir, 'bin')
  mkdirSync(ops, { recursive: true })
  mkdirSync(bin)
  const events = path.join(dir, 'events')
  const write = (name, body) => writeFileSync(name, body, { mode: 0o755 })
  for (const file of ['attendance-run-gates.sh', 'attendance-run-strict-gates-twice.sh']) write(path.join(ops, file), read(`scripts/ops/${file}`))
  write(path.join(ops, 'attendance-resolve-auth.sh'), '#!/bin/bash\necho auth >> "$TEST_EVENTS"\necho synthetic.token.only\n')
  write(path.join(ops, 'attendance-smoke-api.sh'), '#!/bin/bash\necho smoke >> "$TEST_EVENTS"\n')
  write(path.join(bin, 'sleep'), '#!/bin/bash\nexit 0\n')
  write(path.join(bin, 'node'), `#!${process.execPath}
const fs = require('fs')
const name = require('path').basename(process.argv[2])
fs.appendFileSync(process.env.TEST_EVENTS, name + '\\n')
if (name === 'attendance-acceptance-preflight.mjs') {
  if (process.env.STUB_PROVENANCE_FAIL === 'true') process.exit(1)
  for (const name of ['ORG_ID', 'AUTH_EXPECTED_TENANT_ID', 'ATTENDANCE_SYNTHETIC_ORG_ID']) if (process.env[name] !== 'fixture-org') process.exit(1)
  if (process.env.ATTENDANCE_EXPECTED_DEPLOY_SHA !== '${sha}') process.exit(1)
  console.log(${JSON.stringify(JSON.stringify(proof))})
}
`)
  try {
    run({ dir, ops, events, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, API_BASE: 'http://127.0.0.1:1/api', WEB_URL: 'http://127.0.0.1:1/attendance', AUTH_TOKEN: 'synthetic.token.only', TEST_EVENTS: events, RUN_PREFLIGHT: 'false', PROVISION_USER_ID: '', SLEEP_SECONDS: '0', ORG_ID: 'fixture-org', AUTH_EXPECTED_TENANT_ID: 'fixture-org', ATTENDANCE_SYNTHETIC_ORG_ID: 'fixture-org', ATTENDANCE_EXPECTED_DEPLOY_SHA: sha } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('failed runtime identity prevents every auth/provision/smoke/browser command', () => shellFixture(({ ops, events, env }) => {
  const result = spawnSync('bash', [path.join(ops, 'attendance-run-gates.sh')], { env: { ...env, STUB_PROVENANCE_FAIL: 'true' }, encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.deepEqual(readFileSync(events, 'utf8').trim().split('\n'), ['attendance-acceptance-preflight.mjs'])
}))

test('both strict runs bracket acceptance with runtime checks and preserve evidence', () => shellFixture(({ dir, ops, events, env }) => {
  const result = spawnSync('bash', [path.join(ops, 'attendance-run-strict-gates-twice.sh')], { env, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const oneRun = ['attendance-acceptance-preflight.mjs', 'auth', 'smoke', 'verify-attendance-production-flow.mjs', 'verify-attendance-full-flow.mjs', 'verify-attendance-full-flow.mjs', 'attendance-acceptance-preflight.mjs']
  assert.deepEqual(readFileSync(events, 'utf8').trim().split('\n'), [...oneRun, ...oneRun])
  const out = path.join(dir, 'output/playwright/attendance-prod-acceptance')
  const runs = readdirSync(out)
  assert.equal(runs.length, 2)
  for (const run of runs) {
    const summary = JSON.parse(readFileSync(path.join(out, run, 'gate-summary.json'), 'utf8'))
    assert.equal(summary.schemaVersion, 2)
    assert.deepEqual(summary.provenance, proof)
    assert.equal(summary.exitCode, 0)
  }
}))

test('summary validators reject missing or contradictory runtime provenance', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'attendance-summary-'))
  const file = path.join(dir, 'gate-summary.json')
  const summary = { schemaVersion: 2, generatedAt: '2026-09-05T00:00:00Z', apiBase: '', webUrl: '', expectProductMode: 'platform', exitCode: 0, provenance: proof, gates: { preflight: 'PASS', apiSmoke: 'PASS', provisioning: 'SKIP', playwrightProd: 'PASS', playwrightDesktop: 'PASS', playwrightMobile: 'PASS' }, gateReasons: { apiSmoke: null, provisioning: null, playwrightProd: null, playwrightDesktop: null, playwrightMobile: null } }
  const validators = [
    ['bash', [path.join(root, 'scripts/ops/attendance-validate-gate-summary.sh'), dir, '1']],
    [process.execPath, [path.join(root, 'scripts/ops/attendance-validate-gate-summary-schema.mjs'), dir, '1']],
  ]
  try {
    for (const [command, args] of validators) {
      const run = value => {
        writeFileSync(file, JSON.stringify(value))
        return spawnSync(command, args, { env: { ...process.env, ATTENDANCE_REQUIRE_PROVENANCE: 'true' }, encoding: 'utf8' })
      }
      const valid = run(summary)
      assert.equal(valid.status, 0, valid.stderr)
      assert.notEqual(run({ ...summary, provenance: undefined }).status, 0)
      assert.notEqual(run({ ...summary, provenance: { ...proof, observedDeploymentSha: 'c'.repeat(40) } }).status, 0)
      assert.notEqual(run({ ...summary, schemaVersion: 1, provenance: undefined }).status, 0)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('workflow finalization cannot use an earlier green summary to mask a failed second run', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'attendance-finalize-'))
  const workflow = yaml.load(read('.github/workflows/attendance-strict-gates-prod.yml'))
  const finalize = workflow.jobs['strict-gates'].steps.find(step => step.id === 'strict_final')
  try {
    const output = path.join(dir, 'github-output')
    const root = path.join(dir, 'output/playwright/attendance-prod-acceptance')
    for (const run of ['20260905-1', '20260905-2']) mkdirSync(path.join(root, run), { recursive: true })
    writeFileSync(path.join(root, '20260905-1/gate-summary.json'), JSON.stringify({ schemaVersion: 2, provenance: proof, exitCode: 0 }))
    writeFileSync(path.join(root, '20260905-2/runtime-provenance-after.json'), '')
    const run = (strict, retryRan, retryOutcome) => {
      writeFileSync(output, '')
      return spawnSync('bash', ['-c', finalize.run], { cwd: dir, encoding: 'utf8', env: {
        ...process.env, GITHUB_OUTPUT: output, STRICT_OUTCOME: strict, RETRY_RAN: retryRan, RETRY_OUTCOME: retryOutcome,
      } })
    }
    for (const [strict, retryRan, retryOutcome] of [['failure', 'false', 'success'], ['failure', 'true', 'failure'], ['cancelled', '', 'skipped']]) {
      const result = run(strict, retryRan, retryOutcome)
      assert.notEqual(result.status, 0, result.stdout)
      assert.doesNotMatch(readFileSync(output, 'utf8'), /status=success/)
    }
    assert.equal(run('success', '', 'skipped').status, 0)
    assert.equal(run('failure', 'true', 'success').status, 0)
    assert.equal(finalize.env.STRICT_OUTCOME, '${{ steps.run_strict.outcome }}')
    assert.equal(finalize.env.RETRY_RAN, '${{ steps.run_strict_retry.outputs.retry_ran }}')
    assert.equal(finalize.env.RETRY_OUTCOME, '${{ steps.run_strict_retry.outcome }}')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
