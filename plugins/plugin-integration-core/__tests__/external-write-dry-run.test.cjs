'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const { applyExternalWrite, dryRunExternalWrite } = require(path.join(__dirname, '..', 'lib', 'external-write-dry-run.cjs'))

function memoryStore() {
  const map = new Map()
  const delays = []
  return {
    map,
    delays,
    async get(key) {
      if (delays.length > 0) await delays.shift()
      return map.get(key) || null
    },
    async set(key, value) { map.set(key, JSON.parse(JSON.stringify(value))) },
    async consume(key) {
      if (delays.length > 0) await delays.shift()
      const value = map.get(key) || null
      map.delete(key)
      return value
    },
    async delete(key) { map.delete(key) },
  }
}

function baseInput(overrides = {}) {
  const calls = { test: [], lookupByKey: [], insertRows: [], updateRows: [] }
  const sourceRows = overrides.sourceRows || [
    { code: 'P-001', name: 'Widget', status: 'new' },
    { code: 'P-002', name: 'Gadget', status: 'old' },
  ]
  const input = {
    pipeline: {
      id: 'pipe_c6',
      tenantId: 'tenant_1',
      workspaceId: 'workspace_1',
      sourceSystemId: 'source_1',
      sourceObject: 'items',
      targetSystemId: 'target_1',
      targetObject: 'target_items',
      createdBy: 'owner-7',
      fieldMappings: [
        { sourceField: 'code', targetField: 'externalId', validation: [{ type: 'required' }] },
        { sourceField: 'name', targetField: 'name', validation: [{ type: 'required' }] },
        { sourceField: 'status', targetField: 'status' },
      ],
    },
    sourceSystem: { id: 'source_1', kind: 'data-source:sql-readonly' },
    targetSystem: {
      id: 'target_1',
      kind: 'data-source:sql-write-gated',
      config: {
        dataSourceId: 'writable-ds',
        object: 'public.target_items',
        keyFields: ['externalId'],
        writableFields: ['name', 'status'],
      },
    },
    sourceAdapter: {
      async read(readInput) {
        if (overrides.sourceRead) return overrides.sourceRead(readInput)
        return { records: sourceRows, done: true, nextCursor: null }
      },
    },
    dataSourceWrites: {
      async test(id, principal) {
        calls.test.push({ id, principal })
        if (overrides.test) return overrides.test({ id, principal })
        return {
          success: true,
          capabilityState: {
            readOnly: false,
            c6WriteTarget: true,
            genericQueryDisabled: true,
          },
        }
      },
      async lookupByKey(id, object, key, policy, principal) {
        calls.lookupByKey.push({ id, object, key, policy, principal })
        if (overrides.lookupByKey) return overrides.lookupByKey({ id, object, key, policy, principal })
        if (key.externalId === 'P-002') return { data: [{ externalId: 'P-002', name: 'Old gadget', status: 'old' }], metadata: {} }
        return { data: [], metadata: {} }
      },
      async insertRows(id, object, rows, policy, principal) {
        calls.insertRows.push({ id, object, rows, policy, principal })
        if (overrides.insertRows) return overrides.insertRows({ id, object, rows, policy, principal })
        return { data: rows, metadata: {} }
      },
      async updateRows(id, object, rows, policy, principal) {
        calls.updateRows.push({ id, object, rows, policy, principal })
        if (overrides.updateRows) return overrides.updateRows({ id, object, rows, policy, principal })
        return { rowCount: rows.length, results: [] }
      },
    },
    tokenStore: memoryStore(),
    dryRunUser: 'user_read',
    dataSourceOwnerPrincipal: 'owner-7',
    maxRows: 100,
    ...overrides.input,
  }
  return { input, calls }
}

async function testReadyDryRunIssuesTokenAndStaysValuesFree() {
  const { input, calls } = baseInput()
  const result = await dryRunExternalWrite(input)
  assert.equal(result.status, 'ready')
  assert.equal(result.canApply, true)
  assert.equal(typeof result.dryRunToken, 'string')
  assert.equal(result.counts.sourceRows, 2)
  assert.equal(result.counts.add, 1)
  assert.equal(result.counts.update, 1)
  assert.equal(result.counts.skip, 0)
  assert.equal(result.counts.held, 0)
  assert.equal(result.counts.failed, 0)
  assert.deepEqual(calls.test, [{ id: 'writable-ds', principal: 'owner-7' }], 'target capability check uses the owner principal')
  assert.equal(calls.lookupByKey.length, 2)
  assert.deepEqual(calls.lookupByKey[0].policy, {
    keyFields: ['externalId'],
    writableFields: ['name', 'status'],
  })
  assert.equal(calls.lookupByKey[0].principal, 'owner-7')
  assert.equal(calls.insertRows.length, 0)
  assert.equal(calls.updateRows.length, 0)
  assert.equal(input.tokenStore.map.size, 1, 'ready dry-run persists one token record')
  const evidenceText = JSON.stringify(result.evidence)
  assert.equal(evidenceText.includes('P-001'), false, 'evidence must not include source key values')
  assert.equal(evidenceText.includes('Widget'), false, 'evidence must not include source names')
  assert.equal(evidenceText.includes(result.dryRunToken), false, 'evidence must not include the bearer dry-run token')
  assert.equal(result.evidence.dryRunTokenPresent, true)
}

async function testApplyConsumesTokenRecomputesAndWritesEligibleRows() {
  const { input, calls } = baseInput({
    input: {
      dryRunUser: 'user_write',
    },
  })
  const dryRun = await dryRunExternalWrite(input)
  const apply = await applyExternalWrite({
    ...input,
    dryRunToken: dryRun.dryRunToken,
    applyUser: 'user_write',
    runId: 'run_c6_apply_1',
  })
  assert.equal(apply.status, 'succeeded')
  assert.equal(apply.dryRunRevision, dryRun.revision)
  assert.equal(apply.counts.add, 1)
  assert.equal(apply.counts.update, 1)
  assert.equal(apply.counts.skip, 0)
  assert.equal(apply.counts.failed, 0)
  assert.equal(apply.counts.written, 2)
  assert.equal(calls.insertRows.length, 1)
  assert.equal(calls.updateRows.length, 1)
  assert.deepEqual(calls.insertRows[0].rows, [{ externalId: 'P-001', name: 'Widget', status: 'new' }])
  assert.deepEqual(calls.updateRows[0].rows, [{ externalId: 'P-002', name: 'Gadget', status: 'old' }])
  assert.equal(calls.insertRows[0].principal, 'owner-7')
  assert.equal(calls.updateRows[0].principal, 'owner-7')
  assert.equal(input.tokenStore.map.size, 0, 'apply consumes the dry-run token')
  const responseText = JSON.stringify(apply)
  assert.equal(responseText.includes(dryRun.dryRunToken), false, 'apply response never echoes the bearer token')
  assert.equal(JSON.stringify(apply.evidence).includes('P-001'), false, 'apply evidence does not include source key values')
  assert.equal(JSON.stringify(apply.evidence).includes('Widget'), false, 'apply evidence does not include source field values')
  assert.deepEqual(apply.evidence.provenanceEventCounts, { target_write_succeeded: 2 })
  assert.ok(apply.provenanceEvents.every((event) => event.runId === 'run_c6_apply_1'), 'apply provenance uses the real run id when provided')
}

async function testApplyTokenIsSingleUseAndPrincipalBound() {
  const { input } = baseInput({
    input: {
      dryRunUser: 'user_write',
    },
  })
  const dryRun = await dryRunExternalWrite(input)
  await assert.rejects(
    () => applyExternalWrite({
      ...input,
      dryRunToken: dryRun.dryRunToken,
      applyUser: 'user_other',
    }),
    (error) => error && error.code === 'C6_WRITE_DRY_RUN_TOKEN_MISMATCH',
  )
  await assert.rejects(
    () => applyExternalWrite({
      ...input,
      dryRunToken: dryRun.dryRunToken,
      applyUser: 'user_write',
    }),
    (error) => error && error.code === 'C6_WRITE_DRY_RUN_TOKEN_INVALID',
  )
}

async function testApplyRequiresAuthenticatedApplyUser() {
  const { input } = baseInput({
    input: {
      dryRunUser: 'user_write',
    },
  })
  const dryRun = await dryRunExternalWrite(input)
  await assert.rejects(
    () => applyExternalWrite({
      ...input,
      dryRunToken: dryRun.dryRunToken,
      applyUser: '',
    }),
    (error) => error && error.code === 'C6_WRITE_APPLY_USER_REQUIRED',
  )
}

async function testApplyRejectsRevisionMismatchBeforeWrite() {
  let drift = false
  const { input, calls } = baseInput({
    input: {
      dryRunUser: 'user_write',
    },
    lookupByKey: ({ key }) => {
      if (!drift && key.externalId === 'P-002') return { data: [{ externalId: 'P-002', name: 'Old gadget', status: 'old' }], metadata: {} }
      if (drift && key.externalId === 'P-001') return { data: [{ externalId: 'P-001', name: 'Widget', status: 'new' }], metadata: {} }
      if (drift && key.externalId === 'P-002') return { data: [{ externalId: 'P-002', name: 'Gadget', status: 'old' }], metadata: {} }
      return { data: [], metadata: {} }
    },
  })
  const dryRun = await dryRunExternalWrite(input)
  drift = true
  await assert.rejects(
    () => applyExternalWrite({
      ...input,
      dryRunToken: dryRun.dryRunToken,
      applyUser: 'user_write',
    }),
    (error) => error && error.code === 'C6_WRITE_DRY_RUN_TOKEN_MISMATCH',
  )
  assert.equal(calls.insertRows.length, 0, 'revision mismatch fails before insert')
  assert.equal(calls.updateRows.length, 0, 'revision mismatch fails before update')
}

async function testApplyIsolatesRowWriteFailuresAndStaysValuesFree() {
  const { input, calls } = baseInput({
    sourceRows: [
      { code: 'P-001', name: 'Widget', status: 'new' },
      { code: 'P-002', name: 'Gadget', status: 'new' },
    ],
    input: {
      dryRunUser: 'user_write',
    },
    lookupByKey: () => ({ data: [], metadata: {} }),
    insertRows: ({ rows }) => {
      if (rows[0].externalId === 'P-002') {
        const error = new Error('duplicate key P-002 Widget')
        error.code = 'DUPLICATE_P-002_WIDGET'
        throw error
      }
      return { data: rows, metadata: {} }
    },
  })
  const deadLetters = []
  const dryRun = await dryRunExternalWrite(input)
  const apply = await applyExternalWrite({
    ...input,
    dryRunToken: dryRun.dryRunToken,
    applyUser: 'user_write',
    runId: 'run_c6_partial_1',
    deadLetterStore: {
      async createDeadLetter(entry) {
        deadLetters.push(entry)
        return { ...entry, id: `dl_${deadLetters.length}` }
      },
    },
  })
  assert.equal(apply.status, 'partial')
  assert.equal(apply.counts.add, 1)
  assert.equal(apply.counts.failed, 1)
  assert.equal(apply.counts.written, 1)
  assert.equal(calls.insertRows.length, 2, 'row failures are isolated by per-row writes')
  assert.deepEqual(apply.evidence.rowErrorTypes, ['WRITE_FAILED'])
  assert.deepEqual(apply.deadLetters, { attempted: 1, persisted: 1 })
  assert.equal(deadLetters.length, 1)
  assert.equal(deadLetters[0].errorCode, 'WRITE_FAILED')
  assert.equal(deadLetters[0].errorMessage, 'WRITE_FAILED')
  assert.equal(deadLetters[0].runId, 'run_c6_partial_1')
  assert.equal(deadLetters[0].sourcePayload.keyFingerprint, apply.rowErrors[0].keyFingerprint)
  assert.ok(apply.provenanceEvents.every((event) => event.runId === 'run_c6_partial_1'), 'failure provenance uses the real run id when provided')
  const responseText = JSON.stringify(apply)
  assert.equal(responseText.includes('P-002'), false, 'failure response does not include key values from thrown messages')
  assert.equal(responseText.includes('Widget'), false, 'failure response does not include row values from thrown messages')
  assert.equal(responseText.includes('DUPLICATE_P-002_WIDGET'), false, 'unsafe error codes are not exposed')
}

async function testApplyTokenIsSingleUseUnderConcurrency() {
  const { input, calls } = baseInput({
    input: {
      dryRunUser: 'user_write',
    },
  })
  let releaseRead
  input.tokenStore.delays.push(new Promise((resolve) => { releaseRead = resolve }))
  const dryRun = await dryRunExternalWrite(input)
  const first = applyExternalWrite({
    ...input,
    dryRunToken: dryRun.dryRunToken,
    applyUser: 'user_write',
  })
  const second = applyExternalWrite({
    ...input,
    dryRunToken: dryRun.dryRunToken,
    applyUser: 'user_write',
  })
  releaseRead()
  const results = await Promise.allSettled([first, second])
  const fulfilled = results.filter((result) => result.status === 'fulfilled')
  const rejected = results.filter((result) => result.status === 'rejected')
  assert.equal(fulfilled.length, 1, 'only one concurrent apply can consume the token')
  assert.equal(rejected.length, 1, 'the competing apply fails closed')
  assert.equal(rejected[0].reason.code, 'C6_WRITE_DRY_RUN_TOKEN_INVALID')
  assert.equal(calls.insertRows.length, 1)
  assert.equal(calls.updateRows.length, 1)
}

async function testAmbiguousTargetKeyHoldsAndDoesNotIssueToken() {
  const { input } = baseInput({
    sourceRows: [{ code: 'P-009', name: 'Dup', status: 'new' }],
    lookupByKey: () => ({ data: [{ externalId: 'P-009' }, { externalId: 'P-009' }], metadata: {} }),
  })
  const result = await dryRunExternalWrite(input)
  assert.equal(result.status, 'not_applyable')
  assert.equal(result.canApply, false)
  assert.equal(result.dryRunToken, null)
  assert.equal(result.counts.held, 1)
  assert.deepEqual(result.evidence.rowErrorTypes, ['ambiguous_target_key'])
  assert.equal(input.tokenStore.map.size, 0)
}

async function testTruncatedSourceReadDoesNotIssueToken() {
  const { input } = baseInput({
    sourceRead: () => ({ records: [{ code: 'P-001', name: 'Widget', status: 'new' }], done: false, nextCursor: 'next-page' }),
  })
  const result = await dryRunExternalWrite(input)
  assert.equal(result.status, 'not_applyable')
  assert.equal(result.canApply, false)
  assert.equal(result.dryRunToken, null)
  assert.equal(result.evidence.sourceRead.truncated, true)
  assert.deepEqual(result.evidence.rowErrorTypes, ['source_read_truncated'])
}

async function testRejectsNonC6Target() {
  const { input } = baseInput({
    input: {
      targetSystem: { id: 'target_1', kind: 'data-source:sql-readonly', config: {} },
    },
  })
  await assert.rejects(() => dryRunExternalWrite(input), /requires target kind data-source:sql-write-gated/)
}

async function testUnsafeCapabilityStateFailsClosed() {
  const { input, calls } = baseInput({
    test: () => ({
      success: true,
      capabilityState: {
        readOnly: false,
        c6WriteTarget: true,
        genericQueryDisabled: false,
      },
    }),
  })
  await assert.rejects(
    () => dryRunExternalWrite(input),
    (error) => error && error.code === 'C6_WRITE_TARGET_CAPABILITY_UNSAFE',
  )
  assert.equal(calls.lookupByKey.length, 0, 'unsafe target capability state fails before target lookup')
}

async function testRejectsMissingCapabilityState() {
  const { input, calls } = baseInput({
    test: () => ({ success: true }),
  })
  await assert.rejects(() => dryRunExternalWrite(input), /target capability state/)
  assert.equal(calls.lookupByKey.length, 0, 'missing target capability state fails before target lookup')
}

async function testRejectsFailedTargetCapabilityCheck() {
  const { input, calls } = baseInput({
    test: () => ({
      success: false,
      capabilityState: {
        readOnly: false,
        c6WriteTarget: true,
        genericQueryDisabled: true,
      },
    }),
  })
  await assert.rejects(
    () => dryRunExternalWrite(input),
    (error) => error && error.code === 'C6_WRITE_TARGET_TEST_FAILED',
  )
  assert.equal(calls.lookupByKey.length, 0, 'failed target capability check fails before target lookup')
}

async function main() {
  await testReadyDryRunIssuesTokenAndStaysValuesFree()
  await testAmbiguousTargetKeyHoldsAndDoesNotIssueToken()
  await testTruncatedSourceReadDoesNotIssueToken()
  await testRejectsNonC6Target()
  await testUnsafeCapabilityStateFailsClosed()
  await testRejectsMissingCapabilityState()
  await testRejectsFailedTargetCapabilityCheck()
  await testApplyConsumesTokenRecomputesAndWritesEligibleRows()
  await testApplyTokenIsSingleUseAndPrincipalBound()
  await testApplyTokenIsSingleUseUnderConcurrency()
  await testApplyRequiresAuthenticatedApplyUser()
  await testApplyRejectsRevisionMismatchBeforeWrite()
  await testApplyIsolatesRowWriteFailuresAndStaysValuesFree()
  console.log('external-write-dry-run.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
