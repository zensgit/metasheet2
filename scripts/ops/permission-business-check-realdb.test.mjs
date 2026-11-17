import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildTestEnvironment, validateConnection, validateReport } from './permission-business-check-realdb.mjs'

const trusted = [
  'matches actual guards for a trusted JWT and refuses target-token inference',
  'treats dev trusted admin as token guard context, not database delegation authority',
]
const makeReport = mode => ({
  success: true, numFailedTests: 0, numFailedTestSuites: 0,
  testResults: [{ name: '/workspace/tests/integration/business-check-realdb.test.ts', status: 'passed',
    assertionResults: [
      ...Array.from({ length: 19 }, (_, i) => ({ title: `normal ${i}`, status: mode === 'off' ? 'passed' : 'skipped' })),
      ...trusted.map(title => ({ title, status: mode === 'on' ? 'passed' : 'skipped' })),
    ] }],
})

test('local disposable database requires the exact acknowledgement and target', () => {
  assert.doesNotThrow(() => validateConnection('postgres://user:synthetic@127.0.0.1:5432/permission_check_test', 'permission_check_test'))
  for (const [url, ack] of [
    ['postgres://user@127.0.0.1:5432/permission_check_test', ''],
    ['postgres://user@192.0.2.1:5432/permission_check_test', 'permission_check_test'],
    ['postgres://user@127.0.0.1:5432/customer', 'permission_check_test'],
    ['postgres://user@127.0.0.1:5432/permission_check_test?host=elsewhere', 'permission_check_test'],
    ['postgres://user@127.0.0.1/permission_check_test', 'permission_check_test'],
  ]) assert.throws(() => validateConnection(url, ack))
})


test('runner supplies a clean synthetic environment to each child process', () => {
  const parent = { PATH: 'test-path', PGHOST: 'outside', PGOPTIONS: 'unsafe', JWT_SECRET: 'private-value',
    DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED: 'true', ARBITRARY_SECRET: 'private-value' }
  const url = validateConnection('postgres://user:synthetic@127.0.0.1:5432/permission_check_test', 'permission_check_test')
  for (const mode of ['off', 'on']) {
    const child = buildTestEnvironment(parent, url, 'permission_check_ci_example', mode, '/tmp/test-owned')
    assert.equal(child.PATH, 'test-path')
    assert.equal(child.PGHOST, undefined)
    assert.equal(child.ARBITRARY_SECRET, undefined)
    assert.equal(child.PGOPTIONS, '-c search_path=permission_check_ci_example')
    assert.equal(child.JWT_SECRET, 'permission-check-synthetic-test-secret-only')
    assert.equal(child.DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED, 'false')
    assert.equal(child.RBAC_TOKEN_TRUST, mode === 'on' ? 'true' : 'false')
  }
})

test('both reports must execute the intended assertions, not merely report green', () => {
  assert.deepEqual(validateReport(makeReport('off'), 'off'), { ran: 19, skipped: 2 })
  assert.deepEqual(validateReport(makeReport('on'), 'on'), { ran: 2, skipped: 19 })
  const cases = [
    report => { report.testResults[0].assertionResults[0].status = 'skipped' },
    report => { report.testResults[0].assertionResults[19].status = 'passed' },
    report => { report.testResults[0].assertionResults = [] },
    report => { report.testResults[0].assertionResults[19].title = 'renamed' },
    report => { report.testResults[0].name = '/workspace/tests/integration/other.test.ts' },
    report => { report.success = false },
    report => { report.testResults[0].assertionResults[19].status = 'pending' },
  ]
  for (const change of cases) {
    const report = makeReport('off'); change(report)
    assert.throws(() => validateReport(report, 'off'))
  }
  const missing = makeReport('on'); missing.testResults[0].assertionResults[20].status = 'skipped'
  assert.throws(() => validateReport(missing, 'on'))
})

test('safety guards and report witnesses are independently mutation-sensitive in memory', () => {
  const source = readFileSync(new URL('./permission-business-check-realdb.mjs', import.meta.url), 'utf8')
  const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))
  const connection = between('export function validateConnection', '/** Vitest')
  const report = between('export function validateReport', '/** Only OS')
  const mutants = [
    [connection, "acknowledgement !== 'permission_check_test' || ", '', fn => assert.throws(() => fn('postgres://u@127.0.0.1:5432/permission_check_test', ''))],
    [connection, "!['127.0.0.1', '[::1]'].includes(url.hostname)", 'false', fn => assert.throws(() => fn('postgres://u@192.0.2.1:5432/permission_check_test', 'permission_check_test'))],
    [connection, "url.pathname !== '/permission_check_test'", 'false', fn => assert.throws(() => fn('postgres://u@127.0.0.1:5432/customer', 'permission_check_test'))],
    [connection, "!['postgres:', 'postgresql:'].includes(url.protocol)", 'false', fn => assert.throws(() => fn('https://u@127.0.0.1:5432/permission_check_test', 'permission_check_test'))],
    [connection, 'url.search || url.hash', 'false', fn => assert.throws(() => fn('postgres://u@127.0.0.1:5432/permission_check_test?host=x', 'permission_check_test'))],
    [report, "if (test.status !== 'skipped') throw new Error('UNEXPECTED_TEST_STATUS')", '', fn => { const r = makeReport('off'); r.testResults[0].assertionResults[19].status = 'pending'; assert.throws(() => fn(r, 'off')) }],
    [report, "if (test.status !== 'passed') throw new Error('TEST_NOT_EXECUTED')", '', fn => { const r = makeReport('off'); r.testResults[0].assertionResults[0].status = 'skipped'; assert.throws(() => fn(r, 'off')) }],
    [report, 'ran < 19', 'ran < 0', fn => { const r = makeReport('off'); r.testResults[0].assertionResults.splice(0, 1); assert.throws(() => fn(r, 'off')) }],
    [report, "!file.name.replaceAll('\\\\', '/').endsWith('/tests/integration/business-check-realdb.test.ts')", 'false', fn => { const r = makeReport('off'); r.testResults[0].name = '/other'; assert.throws(() => fn(r, 'off')) }],
  ]
  for (const [original, needle, replacement, check] of mutants) {
    assert.ok(original.includes(needle), 'mutation anchor missing')
    const load = code => new Function('trustedNames', `${code.replace('export function', 'function')}\nreturn ${code.includes('validateConnection') ? 'validateConnection' : 'validateReport'}`)(new Set(trusted))
    check(load(original))
    assert.throws(() => check(load(original.replace(needle, replacement))), { name: 'AssertionError' }, `survived: ${needle}`)
  }
})
import yaml from 'js-yaml'
import { createRequire } from 'node:module'
const req = createRequire(import.meta.url)


test('rejected connection reports only a fixed diagnostic', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./permission-business-check-realdb.mjs', import.meta.url))], {
    encoding: 'utf8', env: { ...process.env, DATABASE_URL: 'postgres://u:synthetic-secret@192.0.2.1:5432/permission_check_test', PERMISSION_CHECK_DISPOSABLE_DB: 'permission_check_test' },
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /^BUSINESS_CHECK_REALDB: DATABASE_NOT_AUTHORIZED\s*$/)
  assert.doesNotMatch(result.stderr, /synthetic-secret|192\.0\.2\.1/)
})

test('removing environment isolation or changing the scope flag makes the witness fail', () => {
  const source = readFileSync(new URL('./permission-business-check-realdb.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('export function buildTestEnvironment')
  const end = source.indexOf('async function main', start)
  const section = source.slice(start, end)
  const loader = code => new Function(`${code.replace('export function', 'function')}\nreturn buildTestEnvironment`)()
  const parent = { PATH: 'ok', ARBITRARY_SECRET: 'hidden', DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED: 'true' }
  const url = new URL('postgres://u@127.0.0.1:5432/permission_check_test')
  const check = fn => {
    const child = fn(parent, url, 'permission_check_ci_test', 'off', 'temp')
    assert.equal(child.ARBITRARY_SECRET, undefined)
    assert.equal(child.DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED, 'false')
  }
  check(loader(section))
  for (const [needle, replacement] of [
    ['const env = {}', 'const env = { ...parent }'],
    ["DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED: 'false'", "DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED: 'true'"],
  ]) {
    assert.ok(section.includes(needle))
    assert.throws(() => check(loader(section.replace(needle, replacement))), assert.AssertionError)
  }
})

test('workflow actually runs the dedicated safety checks and real database suite', () => {
  const text = readFileSync(new URL('../../.github/workflows/permission-business-check-realdb.yml', import.meta.url), 'utf8')
  const workflow = yaml.load(text)
  const job = workflow.jobs['business-check-realdb']
  assert.equal(job.services.postgres.env.POSTGRES_DB, 'permission_check_test')
  assert.equal(job.env.PERMISSION_CHECK_DISPOSABLE_DB, 'permission_check_test')
  assert.equal(job.env.DELEGATED_SCOPE_EXACT_DEPARTMENT_ENABLED, 'false')
  const commands = job.steps.filter(step => step.run).map(step => step.run)
  assert.ok(commands.includes('node --test scripts/ops/permission-business-check-realdb.test.mjs'))
  assert.ok(commands.includes('node scripts/ops/permission-business-check-realdb.mjs'))
  assert.ok(workflow.on.workflow_dispatch !== undefined || Object.hasOwn(workflow.on, 'workflow_dispatch'))
  for (const event of ['pull_request', 'push']) {
    const paths = workflow.on[event].paths
    assert.ok(paths.includes('packages/core-backend/src/**'))
    assert.ok(paths.includes('packages/core-backend/tests/integration/business-check-realdb.test.ts'))
    assert.ok(paths.includes('.github/workflows/permission-business-check-realdb.yml'))
  }
  const defaultConfig = readFileSync(new URL('../../packages/core-backend/vitest.config.ts', import.meta.url), 'utf8')
  const integrationConfig = readFileSync(new URL('../../packages/core-backend/vitest.integration.config.ts', import.meta.url), 'utf8')
  for (const config of [defaultConfig, integrationConfig]) assert.match(config, /exclude:\s*\[[\s\S]*?'tests\/integration\/business-check-realdb\.test\.ts'/)
  assert.ok(req.resolve('../../packages/core-backend/node_modules/vitest/vitest.mjs'))
})
