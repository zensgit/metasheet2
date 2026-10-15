import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FROZEN_SHA, LedgerError, evaluateExecution } from './ci-execution-ledger.mjs'

const DIGEST = 'ab'.repeat(32)

function receipt(workerId, patch = {}) {
  return {
    schema: 'ci-execution-receipt-p0/1',
    workerId,
    sha: FROZEN_SHA,
    runId: 'run1',
    attempt: 1,
    ledgerDigest: DIGEST,
    status: 'success',
    ...patch,
  }
}

function invocation(patch = {}) {
  return {
    identity: 'web',
    config: DIGEST,
    flags: 'node20',
    group: 'required',
    occurrence: '1',
    ...patch,
  }
}

function input(patch = {}) {
  const workers = [
    { id: 'build', needs: [], produces: [], condition: 'success()' },
    { id: 'web', needs: ['build'], produces: ['test (20.x)'], condition: 'success()' },
  ]
  const requiredNames = ['test (20.x)']
  const base = {
    expected: { workers: structuredClone(workers), requiredNames: requiredNames.slice() },
    workers: structuredClone(workers),
    requiredNames: requiredNames.slice(),
    workflowStatus: 'completed',
    results: { build: 'success', web: 'success' },
    binding: { currentSha: FROZEN_SHA, runId: 'run1', attempt: 1, ledgerDigest: DIGEST },
    receipts: [receipt('build'), receipt('web')],
    invocations: { expected: [invocation(), invocation({ occurrence: '2' })], observed: [invocation(), invocation({ occurrence: '2' })] },
  }
  return { ...base, ...patch }
}

function codeOf(body) {
  try {
    evaluateExecution(body)
  } catch (err) {
    assert.ok(err instanceof LedgerError)
    assert.equal(err.message, err.code)
    assert.equal(err.message.includes('://'), false)
    return err.code
  }
  assert.fail('expected LedgerError')
}

test('positive control accepts one exact success receipt per expected worker', () => {
  assert.deepEqual(evaluateExecution(input()), { ok: true, workers: 2 })
})

test('graph rejects empty, duplicate, missing, cycle, orphan, and ambiguous producers', () => {
  assert.equal(codeOf(input({ workers: [] })), 'WORKER_EMPTY')
  assert.equal(codeOf(input({
    workers: [{ id: 'web', needs: [], produces: ['web_tests'] }, { id: 'web', needs: [], produces: [] }],
  })), 'WORKER_DUPLICATE_IDENTITY')
  assert.equal(codeOf(input({
    workers: [{ id: 'web', needs: ['build', 'build'], produces: ['web_tests'] }],
  })), 'WORKER_DUPLICATE_EDGE')
  assert.equal(codeOf(input({
    workers: [{ id: 'web', needs: ['build'], produces: ['web_tests'] }],
  })), 'WORKER_MISSING_EDGE')
  assert.equal(codeOf(input({
    workers: [
      { id: 'a', needs: ['b'], produces: ['web_tests'] },
      { id: 'b', needs: ['a'], produces: [] },
    ],
  })), 'WORKER_CYCLE')
  assert.equal(codeOf(input({
    workers: [
      { id: 'web', needs: [], produces: ['test (20.x)'] },
      { id: 'stray', needs: [], produces: [] },
    ],
    results: { web: 'success', stray: 'success' },
    receipts: [receipt('web'), receipt('stray')],
  })), 'WORKER_ORPHAN')
  assert.equal(codeOf(input({
    workers: [
      { id: 'web', needs: [], produces: ['test (20.x)'] },
      { id: 'other', needs: [], produces: ['test (20.x)'] },
    ],
  })), 'WORKER_AMBIGUOUS_PRODUCER')
  assert.equal(codeOf(input({
    workers: [{ id: 'web', needs: [], produces: [] }],
    requiredNames: ['test (20.x)'],
  })), 'WORKER_MISSING_PRODUCER')
  assert.equal(codeOf(input({
    workers: [{ id: 'web', needs: [], produces: ['test (20.x)'], condition: "matrix.node == '20'" }],
  })), 'WORKER_UNSUPPORTED_CONDITION')
})

test('only exact success is accepted and cancellation wins without an aggregator', () => {
  assert.equal(codeOf(input({ workflowStatus: 'cancelled', results: undefined, receipts: [] })), 'WORKFLOW_CANCELLED')
  assert.equal(codeOf(input({ workflowStatus: 'cancelled' })), 'WORKFLOW_CANCELLED')
  assert.equal(codeOf(input({ workflowStatus: 'mystery' })), 'WORKER_RESULT_UNKNOWN')
  assert.equal(codeOf(input({ results: { build: 'failure', web: 'success' } })), 'WORKER_RESULT_FAILURE')
  assert.equal(codeOf(input({ results: { build: 'skipped', web: 'success' } })), 'WORKER_RESULT_SKIPPED')
  assert.equal(codeOf(input({ results: { build: 'cancelled', web: 'success' } })), 'WORKER_RESULT_CANCELLED')
  assert.equal(codeOf(input({ results: { build: 'success', web: 'bogus' } })), 'WORKER_RESULT_UNKNOWN')
  assert.equal(codeOf(input({ results: { web: 'success' } })), 'WORKER_RESULT_MISSING')
  assert.equal(codeOf(input({ results: { build: 'success', web: 'success', extra: 'success' } })), 'WORKER_RESULT_EXTRA')
})

test('coordinated worker, edge, result, and receipt removal cannot self-ratify', () => {
  const body = input()
  body.workers = [{ id: 'web', needs: [], produces: ['test (20.x)'], condition: 'success()' }]
  body.requiredNames = ['test (20.x)']
  body.results = { web: 'success' }
  body.receipts = [receipt('web')]
  assert.equal(codeOf(body), 'WORKER_GRAPH_MISMATCH')
  assert.equal(body.expected.workers.map((worker) => worker.id).join(','), 'build,web')
})

test('required name test (20.x) is exact and is not a worker id', () => {
  assert.equal(evaluateExecution(input()).ok, true)
  const named = input()
  named.expected.workers[1].produces = ['http://ci.invalid/test']
  assert.equal(codeOf(named), 'LEDGER_MALFORMED_SCHEMA')
  const asId = input({
    expected: {
      workers: [{ id: 'test (20.x)', needs: [], produces: ['test (20.x)'] }],
      requiredNames: ['test (20.x)'],
    },
    workers: [{ id: 'test (20.x)', needs: [], produces: ['test (20.x)'] }],
    requiredNames: ['test (20.x)'],
  })
  assert.equal(codeOf(asId), 'LEDGER_MALFORMED_SCHEMA')
})

test('missing workflow status and contradictory conditions fail', () => {
  const missing = input()
  delete missing.workflowStatus
  assert.equal(codeOf(missing), 'WORKER_RESULT_UNKNOWN')
  for (const condition of ['failure()', 'cancelled()']) {
    const body = input()
    body.expected.workers[1].condition = condition
    body.workers[1].condition = condition
    assert.equal(codeOf(body), 'WORKER_UNSUPPORTED_CONDITION')
  }
  const always = input()
  always.expected.workers[1].condition = 'always()'
  always.workers[1].condition = 'always()'
  assert.equal(evaluateExecution(always).ok, true)
  const truthy = input()
  truthy.expected.workers[1].condition = true
  truthy.workers[1].condition = true
  assert.equal(evaluateExecution(truthy).ok, true)
})

test('dropping a worker from results and receipts cannot shrink the expected inventory', () => {
  const body = input()
  delete body.results.build
  body.receipts = body.receipts.filter((item) => item.workerId !== 'build')
  assert.equal(codeOf(body), 'WORKER_RESULT_MISSING')
  body.results = { web: 'success' }
  assert.equal(codeOf(body), 'WORKER_RESULT_MISSING')
})

test('receipts bind sha, run, attempt, and ledger digest exactly once', () => {
  assert.equal(codeOf(input({ receipts: [] })), 'RECEIPT_MISSING')
  assert.equal(codeOf(input({ receipts: [{}] })), 'RECEIPT_EMPTY')
  assert.equal(codeOf(input({ receipts: [receipt('build'), receipt('nope')] })), 'RECEIPT_EXTRA')
  assert.equal(codeOf(input({ receipts: [receipt('build'), receipt('build')] })), 'RECEIPT_DUPLICATE')
  assert.equal(codeOf(input({ receipts: [receipt('build', { schema: 'other' }), receipt('web')] })), 'RECEIPT_SCHEMA')
  assert.equal(codeOf(input({ receipts: [receipt('build', { sha: 'b'.repeat(40) }), receipt('web')] })), 'RECEIPT_STALE')
  assert.equal(codeOf(input({ receipts: [receipt('build', { runId: 'run2' }), receipt('web')] })), 'RECEIPT_RUN_MISMATCH')
  assert.equal(codeOf(input({ receipts: [receipt('build', { attempt: 2 }), receipt('web')] })), 'RECEIPT_ATTEMPT_MISMATCH')
  assert.equal(codeOf(input({ receipts: [receipt('build', { ledgerDigest: 'cd'.repeat(32) }), receipt('web')] })), 'RECEIPT_CONFIG_MISMATCH')
  assert.equal(codeOf(input({ receipts: [receipt('build', { status: 'skipped' }), receipt('web')] })), 'RECEIPT_STATUS')
  assert.equal(codeOf(input({ receipts: [receipt('web')] })), 'RECEIPT_MISSING')
  assert.equal(codeOf(input({ binding: { currentSha: FROZEN_SHA, runId: 'run1', attempt: 0, ledgerDigest: DIGEST } })), 'LEDGER_MALFORMED_SCHEMA')
})

test('invocation multisets keep occurrence and reject empty, altered, missing, repeated, and extra', () => {
  const expected = [invocation(), invocation({ occurrence: '2' })]
  assert.equal(codeOf(input({ invocations: { expected: [], observed: [] } })), 'INVOCATION_EMPTY')
  assert.equal(codeOf(input({ invocations: { expected, observed: [] } })), 'INVOCATION_EMPTY')
  assert.equal(codeOf(input({
    invocations: { expected, observed: [invocation(), invocation({ occurrence: '2', flags: 'node18' })] },
  })), 'INVOCATION_ALTERED')
  assert.equal(codeOf(input({
    invocations: { expected, observed: [invocation()] },
  })), 'INVOCATION_MISSING')
  assert.equal(codeOf(input({
    invocations: { expected: [invocation()], observed: [invocation(), invocation()] },
  })), 'INVOCATION_REPEATED')
  assert.equal(codeOf(input({
    invocations: { expected: [invocation()], observed: [invocation(), invocation({ occurrence: '9' })] },
  })), 'INVOCATION_EXTRA')
  const reversed = evaluateExecution(input({
    invocations: { expected, observed: [invocation({ occurrence: '2' }), invocation()] },
  }))
  assert.equal(reversed.ok, true)
})
