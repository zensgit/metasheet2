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
  requiredSuiteJob(workflow, suite)
  const source = workflow.replace(/\r\n/g, '\n')
  const marker = `\n  ${suite}:\n`
  assert.equal(source.split(marker).length, 2, `Expected one ${suite} job`)
  return source.split(marker)[1].split(/\n  [\w-]+:\n/)[0]
}
