import assert from 'node:assert/strict'
import { parseYamlDocument } from './ci-realdb-step-contract.mjs'
import { REQUIRED_SUITES } from './plugin-tests-required-gate.mjs'

// Existing wiring guards still inspect their exact step, after proving its new job
// is an unconditional dependency of the unchanged required test (20.x) context.
export function requiredSuiteJob(workflow, suite) {
  const doc = typeof workflow === 'string' ? parseYamlDocument(workflow) : workflow
  const gate = doc.jobs?.test
  assert.ok(gate, 'Missing required test job')
  assert.deepEqual(gate.needs, [...REQUIRED_SUITES], 'Required gate must depend on every suite')
  assert.equal(gate.if, 'always()', 'Required gate must run after failure or cancellation')
  assert.equal(gate.name, undefined, 'Preserve the required test (20.x) name')
  assert.deepEqual(gate.strategy, { 'fail-fast': false, matrix: { 'node-version': ['20.x'] } })
  assert.equal(gate['continue-on-error'], undefined)
  assert.ok(REQUIRED_SUITES.includes(suite), 'Unknown required suite')
  const job = doc.jobs?.[suite]
  assert.ok(job, `Missing required suite ${suite}`)
  assert.equal(job.if, undefined, `${suite} must not be conditionally skipped`)
  assert.equal(job['continue-on-error'], undefined, `${suite} must propagate failure`)
  assert.deepEqual(job.strategy, { 'fail-fast': false, matrix: { 'node-version': ['20.x'] } })
  assert.deepEqual(job.needs, ['contracts', 'permissions'].includes(suite) ? undefined : ['contracts', 'permissions'])
  return job
}

export function requiredSuiteJobBody(workflow, suite) {
  // These text-based guards also run in the Node-only Windows acceptance entry.
  // Require the literal header format instead of adding a Python dependency there.
  // The contracts job separately parses the complete document with real YAML.
  const source = workflow.replace(/\r\n/g, '\n')
  const body = id => {
    const marker = `\n  ${id}:\n`
    assert.equal(source.split(marker).length, 2, `Expected one literal ${id} job`)
    return source.split(marker)[1].split(/\n  [^\s#]/)[0]
  }
  const matrix = [
    '    strategy:', '      fail-fast: false', '      matrix:',
    '        node-version: [20.x]',
  ]
  const permissionBrowserService = [
    '    services:',
    '      permission-browser-postgres:',
    '        image: postgres:16',
    '        env:',
    '          POSTGRES_USER: postgres',
    '          POSTGRES_PASSWORD: synthetic_ci_only',
    '          POSTGRES_DB: permission_boundaries_synthetic',
    "          POSTGRES_INITDB_ARGS: '--locale=C --encoding=UTF8'",
    '        ports:',
    "          - '127.0.0.1:5433:5432'",
    '        options: >-',
    '          --health-cmd "pg_isready -U postgres -d permission_boundaries_synthetic"',
    '          --health-interval 5s',
    '          --health-timeout 5s',
    '          --health-retries 20',
  ]
  const assertHeader = (id, expected) => {
    const parts = body(id).split(/^    steps:\n/m)
    assert.equal(parts.length, 2, `${id} must have one literal steps section`)
    const header = (parts[0] + '    steps:').split('\n')
      .filter(line => line.trim() && !line.trimStart().startsWith('#'))
    assert.deepEqual(header, expected, `${id} must keep its unconditional required-gate header`)
  }
  assertHeader('test', [
    `    needs: [${REQUIRED_SUITES.join(', ')}]`, '    if: always()',
    '    runs-on: ubuntu-latest', '    timeout-minutes: 10', ...matrix, '    steps:',
  ])
  for (const id of REQUIRED_SUITES) {
    const preflight = ['contracts', 'permissions'].includes(id)
    assertHeader(id, [
      ...(preflight ? [] : ['    needs: [contracts, permissions]']),
      '    runs-on: ubuntu-22.04', `    timeout-minutes: ${preflight ? 30 : 90}`, ...matrix,
      ...(id === 'runtime-db' ? permissionBrowserService : []),
      '    steps:',
    ])
  }
  assert.ok(REQUIRED_SUITES.includes(suite), 'Unknown required suite')
  return body(suite)
}
