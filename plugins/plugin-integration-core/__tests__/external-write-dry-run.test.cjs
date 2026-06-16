'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const { dryRunExternalWrite } = require(path.join(__dirname, '..', 'lib', 'external-write-dry-run.cjs'))

function memoryStore() {
  const map = new Map()
  return {
    map,
    async get(key) { return map.get(key) || null },
    async set(key, value) { map.set(key, JSON.parse(JSON.stringify(value))) },
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
      async insertRows() { calls.insertRows.push([...arguments]); throw new Error('insertRows must not be called by dry-run') },
      async updateRows() { calls.updateRows.push([...arguments]); throw new Error('updateRows must not be called by dry-run') },
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

async function testRevisionBindsTargetCapabilityState() {
  const { input: lockedInput } = baseInput()
  const locked = await dryRunExternalWrite(lockedInput)
  const { input: driftedInput } = baseInput({
    test: () => ({
      success: true,
      capabilityState: {
        readOnly: false,
        c6WriteTarget: true,
        genericQueryDisabled: false,
      },
    }),
  })
  const drifted = await dryRunExternalWrite(driftedInput)
  assert.notEqual(drifted.revision, locked.revision, 'revision changes when the facade-reported target C6 capability state drifts')
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
  await testRevisionBindsTargetCapabilityState()
  await testRejectsMissingCapabilityState()
  await testRejectsFailedTargetCapabilityCheck()
  console.log('external-write-dry-run.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
