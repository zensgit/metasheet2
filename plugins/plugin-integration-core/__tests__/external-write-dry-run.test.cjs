'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  applyExternalWrite,
  dryRunExternalWrite,
  __internals,
} = require(path.join(__dirname, '..', 'lib', 'external-write-dry-run.cjs'))

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

function sandboxTargetSystem(overrides = {}) {
  const { config: configOverride, ...rest } = overrides
  return {
    id: 'target_1',
    kind: 'data-source:sql-write-gated',
    config: {
      dataSourceId: 'writable-ds',
      object: 'public.target_items',
      keyFields: ['externalId'],
      writableFields: ['name', 'status'],
      ...(configOverride || {}),
    },
    ...rest,
  }
}

function enabledTestFailureInjection(overrides = {}) {
  return {
    deployEnabled: true,
    enabled: true,
    pipelineId: 'pipe_c6',
    targetSystemId: 'target_1',
    targetDataSourceId: 'writable-ds',
    targetObject: 'public.target_items',
    environment: 'sandbox',
    failWriteOrdinal: 2,
    ...overrides,
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
      options: { source: { filters: { approvedSlice: 'fixture' } } },
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

async function testServerBoundSqlEqualityFiltersForwardAndDiscriminateCompleteness() {
  const reads = []
  const filterValue = 'PRIVATE-FILTER-SENTINEL'
  const persistedFilters = {
    zString: filterValue,
    aNull: null,
    mNumber: 7,
    bBoolean: true,
  }
  const { input } = baseInput({
    input: {
      maxRows: 3,
      pipeline: {
        ...baseInput().input.pipeline,
        options: { source: { filters: persistedFilters } },
      },
    },
    sourceRead: (readInput) => {
      reads.push(JSON.parse(JSON.stringify(readInput)))
      if (!readInput.filters) {
        return {
          records: [
            { code: 'P-001', name: 'Widget', status: 'new' },
            { code: 'P-002', name: 'Gadget', status: 'old' },
            { code: 'P-003', name: 'Third', status: 'new' },
          ],
          done: false,
          nextCursor: '3',
        }
      }
      return {
        records: [
          { code: 'P-001', name: 'Widget', status: 'new' },
          { code: 'P-002', name: 'Gadget', status: 'old' },
        ],
        done: true,
        nextCursor: null,
      }
    },
  })
  const result = await dryRunExternalWrite(input)
  assert.equal(result.status, 'ready', 'persisted filter changes the unfiltered truncated RED plan to ready')
  assert.deepEqual(reads, [{
    object: 'items',
    filters: { aNull: null, bBoolean: true, mNumber: 7, zString: filterValue },
    limit: 3,
    cursor: null,
  }])
  const publicText = JSON.stringify(result)
  assert.equal(publicText.includes(filterValue), false, 'filter values never enter public result/evidence')
  assert.equal(publicText.includes('zString'), false, 'filter keys never enter public result/evidence')
}

async function testMissingOrInvalidSqlFiltersFailBeforeSourceContactValuesFree() {
  for (const [filters, expectedCode] of [
    [undefined, 'C6_WRITE_SOURCE_FILTERS_REQUIRED'],
    [{}, 'C6_WRITE_SOURCE_FILTERS_REQUIRED'],
    [{ secretField: { $operator: 'PRIVATE-ERROR-SENTINEL' } }, 'C6_WRITE_SOURCE_FILTERS_INVALID'],
    [{ 'invalid-key-PRIVATE': 'PRIVATE-KEY-SENTINEL' }, 'C6_WRITE_SOURCE_FILTERS_INVALID'],
    [{ $or: 'PRIVATE-OPERATOR-SENTINEL' }, 'C6_WRITE_SOURCE_FILTERS_INVALID'],
    [JSON.parse('{"__proto__":"PRIVATE-PROTO-SENTINEL"}'), 'C6_WRITE_SOURCE_FILTERS_INVALID'],
  ]) {
    let reads = 0
    const { input, calls } = baseInput({
      input: {
        pipeline: {
          ...baseInput().input.pipeline,
          options: filters === undefined ? {} : { source: { filters } },
        },
      },
      sourceRead: () => { reads += 1; return { records: [], done: true, nextCursor: null } },
    })
    await assert.rejects(
      () => dryRunExternalWrite(input),
      (error) => {
        const text = JSON.stringify({ code: error.code, message: error.message, details: error.details })
        return error && error.code === expectedCode
          && [
            'secretField',
            'PRIVATE-ERROR-SENTINEL',
            'invalid-key-PRIVATE',
            'PRIVATE-KEY-SENTINEL',
            '$or',
            'PRIVATE-OPERATOR-SENTINEL',
            '__proto__',
            'PRIVATE-PROTO-SENTINEL',
          ].every((sentinel) => !text.includes(sentinel))
      },
    )
    assert.equal(reads, 0, 'invalid/missing persisted filter fails before source contact')
    assert.equal(calls.test.length, 0, 'invalid/missing persisted filter also fails before target capability contact')
  }
}

async function testSqlFilterDriverFailuresAreRedactedForDryRunAndApply() {
  const filterKey = 'privateFilterColumn'
  const filterValue = 'PRIVATE-FILTER-LITERAL'
  const driverLeak = `invalid input for ${filterKey}: ${filterValue}`
  let failRead = true
  const { input } = baseInput({
    input: {
      dryRunUser: 'user_write',
      pipeline: {
        ...baseInput().input.pipeline,
        options: { source: { filters: { [filterKey]: filterValue } } },
      },
    },
    sourceRead: () => {
      if (failRead) throw new Error(driverLeak)
      return {
        records: [
          { code: 'P-001', name: 'Widget', status: 'new' },
          { code: 'P-002', name: 'Gadget', status: 'old' },
        ],
        done: true,
        nextCursor: null,
      }
    },
  })
  const assertRedacted = (error) => {
    const text = JSON.stringify({ code: error.code, message: error.message, details: error.details })
    return error && error.code === 'C6_WRITE_SOURCE_READ_FAILED'
      && error.status === 502
      && !text.includes(filterKey)
      && !text.includes(filterValue)
      && !text.includes(driverLeak)
  }

  await assert.rejects(() => dryRunExternalWrite(input), assertRedacted)

  failRead = false
  const dryRun = await dryRunExternalWrite(input)
  failRead = true
  await assert.rejects(
    () => applyExternalWrite({ ...input, dryRunToken: dryRun.dryRunToken, applyUser: 'user_write' }),
    assertRedacted,
    'Apply recomputation uses the same values-free filtered-read failure boundary',
  )
}

async function testStoredFilterChangeInvalidatesDryRunRevisionBeforeWrite() {
  const { input, calls } = baseInput({ input: { dryRunUser: 'user_write' } })
  const dryRun = await dryRunExternalWrite(input)
  input.pipeline.options.source.filters.approvedSlice = 'changed-after-dry-run'
  await assert.rejects(
    () => applyExternalWrite({ ...input, dryRunToken: dryRun.dryRunToken, applyUser: 'user_write' }),
    (error) => error && error.code === 'C6_WRITE_DRY_RUN_TOKEN_MISMATCH',
  )
  assert.equal(calls.insertRows.length, 0, 'stored filter revision mismatch fails before insert')
  assert.equal(calls.updateRows.length, 0, 'stored filter revision mismatch fails before update')
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

async function testTestFailureInjectionStaysOffWithoutDeployGate() {
  const { input, calls } = baseInput({
    input: {
      dryRunUser: 'user_write',
      targetSystem: sandboxTargetSystem(),
      testFailureInjection: enabledTestFailureInjection({ deployEnabled: false }),
    },
  })
  const dryRun = await dryRunExternalWrite(input)
  assert.equal(dryRun.canApply, true)
  assert.deepEqual(dryRun.evidence.testFailureInjection, {
    deployEnabled: false,
    serverConfigEnabled: true,
    active: false,
    reason: 'deploy_disabled',
  })
  const apply = await applyExternalWrite({
    ...input,
    dryRunToken: dryRun.dryRunToken,
    applyUser: 'user_write',
  })
  assert.equal(apply.status, 'succeeded')
  assert.equal(apply.counts.failed, 0)
  assert.equal(apply.counts.written, 2)
  assert.deepEqual(apply.evidence.rowErrorTypes, [])
  assert.equal(calls.insertRows.length, 1)
  assert.equal(calls.updateRows.length, 1)
}

async function testTestFailureInjectionRequiresServerConfigTargetMatch() {
  const { input, calls } = baseInput({
    input: {
      dryRunUser: 'user_write',
      targetSystem: sandboxTargetSystem(),
      testFailureInjection: enabledTestFailureInjection({ targetSystemId: 'other_target' }),
    },
  })
  const dryRun = await dryRunExternalWrite(input)
  assert.equal(dryRun.canApply, true)
  assert.deepEqual(dryRun.evidence.testFailureInjection, {
    deployEnabled: true,
    serverConfigEnabled: true,
    active: false,
    reason: 'not_targeted',
  })
  const apply = await applyExternalWrite({
    ...input,
    dryRunToken: dryRun.dryRunToken,
    applyUser: 'user_write',
  })
  assert.equal(apply.status, 'succeeded')
  assert.equal(apply.counts.failed, 0)
  assert.equal(apply.counts.written, 2)
  assert.equal(calls.insertRows.length, 1)
  assert.equal(calls.updateRows.length, 1)
}

async function testTestFailureInjectionRejectsNonSandboxServerConfigBeforeWrite() {
  const { input, calls } = baseInput({
    input: {
      dryRunUser: 'user_write',
      targetSystem: sandboxTargetSystem({
        config: { environment: 'sandbox' },
      }),
      testFailureInjection: enabledTestFailureInjection({ environment: 'production' }),
    },
  })
  await assert.rejects(
    () => dryRunExternalWrite(input),
    (error) => error && error.code === 'C6_TEST_FAILURE_INJECTION_UNSAFE_TARGET',
  )
  assert.equal(calls.test.length, 0, 'unsafe test injection target fails before capability check')
  assert.equal(calls.lookupByKey.length, 0, 'unsafe test injection target fails before lookup')
  assert.equal(calls.insertRows.length, 0)
  assert.equal(calls.updateRows.length, 0)
}

async function testTestFailureInjectionRejectsMutableTargetDriftBeforeWrite() {
  const { input, calls } = baseInput({
    input: {
      dryRunUser: 'user_write',
      targetSystem: sandboxTargetSystem({
        config: {
          dataSourceId: 'prod-ds',
          environment: 'sandbox',
        },
      }),
      testFailureInjection: enabledTestFailureInjection({ targetDataSourceId: 'writable-ds' }),
    },
  })
  await assert.rejects(
    () => dryRunExternalWrite(input),
    (error) => error && error.code === 'C6_TEST_FAILURE_INJECTION_UNSAFE_TARGET',
  )
  assert.equal(calls.test.length, 0, 'server target mismatch fails before capability check')
  assert.equal(calls.lookupByKey.length, 0, 'server target mismatch fails before lookup')
  assert.equal(calls.insertRows.length, 0)
  assert.equal(calls.updateRows.length, 0)
}

async function testTestFailureInjectionRequiresWritableSiblingRows() {
  const { input, calls } = baseInput({
    sourceRows: [{ code: 'P-001', name: 'Widget', status: 'new' }],
    input: {
      dryRunUser: 'user_write',
      targetSystem: sandboxTargetSystem(),
      testFailureInjection: enabledTestFailureInjection(),
    },
    lookupByKey: () => ({ data: [], metadata: {} }),
  })
  await assert.rejects(
    () => dryRunExternalWrite(input),
    (error) => error && error.code === 'C6_TEST_FAILURE_INJECTION_CONFIG_INVALID',
  )
  assert.equal(calls.insertRows.length, 0)
  assert.equal(calls.updateRows.length, 0)
}

async function testTestFailureInjectionRevisionBoundBeforeWrite() {
  const { input, calls } = baseInput({
    sourceRows: [
      { code: 'P-001', name: 'Widget', status: 'new' },
      { code: 'P-002', name: 'Gadget', status: 'new' },
    ],
    input: {
      dryRunUser: 'user_write',
      targetSystem: sandboxTargetSystem(),
      testFailureInjection: enabledTestFailureInjection({ enabled: false }),
    },
    lookupByKey: () => ({ data: [], metadata: {} }),
  })
  const dryRun = await dryRunExternalWrite(input)
  await assert.rejects(
    () => applyExternalWrite({
      ...input,
      testFailureInjection: enabledTestFailureInjection({ failWriteOrdinal: 1 }),
      dryRunToken: dryRun.dryRunToken,
      applyUser: 'user_write',
    }),
    (error) => error && error.code === 'C6_WRITE_DRY_RUN_TOKEN_MISMATCH',
  )
  assert.equal(calls.insertRows.length, 0, 'injection config drift fails before insert')
  assert.equal(calls.updateRows.length, 0, 'injection config drift fails before update')
}

async function testTestFailureInjectionOrdinalIsRevisionBoundBeforeWrite() {
  const { input, calls } = baseInput({
    sourceRows: [
      { code: 'P-001', name: 'Widget', status: 'new' },
      { code: 'P-002', name: 'Gadget', status: 'new' },
    ],
    input: {
      dryRunUser: 'user_write',
      targetSystem: sandboxTargetSystem(),
      testFailureInjection: enabledTestFailureInjection({ failWriteOrdinal: 2 }),
    },
    lookupByKey: () => ({ data: [], metadata: {} }),
  })
  const dryRun = await dryRunExternalWrite(input)
  await assert.rejects(
    () => applyExternalWrite({
      ...input,
      testFailureInjection: enabledTestFailureInjection({ failWriteOrdinal: 1 }),
      dryRunToken: dryRun.dryRunToken,
      applyUser: 'user_write',
    }),
    (error) => error && error.code === 'C6_WRITE_DRY_RUN_TOKEN_MISMATCH',
  )
  assert.equal(calls.insertRows.length, 0, 'failWriteOrdinal drift fails before insert')
  assert.equal(calls.updateRows.length, 0, 'failWriteOrdinal drift fails before update')
}

async function testTestFailureInjectionInjectsExactlyOneRowAndKeepsSibling() {
  const { input, calls } = baseInput({
    sourceRows: [
      { code: 'P-001', name: 'Widget', status: 'new' },
      { code: 'P-002', name: 'Gadget', status: 'new' },
    ],
    input: {
      dryRunUser: 'user_write',
      targetSystem: sandboxTargetSystem(),
      testFailureInjection: enabledTestFailureInjection({ failWriteOrdinal: 2 }),
    },
    lookupByKey: () => ({ data: [], metadata: {} }),
  })
  const deadLetters = []
  const dryRun = await dryRunExternalWrite(input)
  const dryRunToken = dryRun.dryRunToken
  assert.equal(dryRun.status, 'ready')
  assert.deepEqual(dryRun.evidence.testFailureInjection, {
    deployEnabled: true,
    serverConfigEnabled: true,
    active: true,
    reason: 'active',
  })
  const apply = await applyExternalWrite({
    ...input,
    dryRunToken,
    applyUser: 'user_write',
    runId: 'run_c6_injected_failure',
    deadLetterStore: {
      async createDeadLetter(entry) {
        deadLetters.push(entry)
        return { ...entry, id: `dl_${deadLetters.length}` }
      },
    },
  })
  assert.equal(apply.status, 'partial')
  assert.equal(apply.counts.add, 1)
  assert.equal(apply.counts.update, 0)
  assert.equal(apply.counts.failed, 1)
  assert.equal(apply.counts.written, 1)
  assert.equal(calls.insertRows.length, 1, 'only the clean sibling reaches insertRows')
  assert.deepEqual(
    calls.insertRows[0].rows,
    [{ externalId: 'P-001', name: 'Widget', status: 'new' }],
    'failWriteOrdinal=2 leaves the first writable row as the clean sibling',
  )
  assert.equal(calls.updateRows.length, 0)
  assert.equal(input.tokenStore.map.size, 0, 'partial test-injection apply still consumes the dry-run token')
  assert.deepEqual(apply.evidence.rowErrorTypes, [__internals.C6_TEST_INJECTED_ROW_FAILURE])
  assert.deepEqual(apply.deadLetters, { attempted: 1, persisted: 1 })
  assert.equal(deadLetters[0].errorCode, __internals.C6_TEST_INJECTED_ROW_FAILURE)
  assert.equal(deadLetters[0].errorMessage, __internals.C6_TEST_INJECTED_ROW_FAILURE)
  assert.deepEqual(apply.evidence.testFailureInjection, {
    deployEnabled: true,
    serverConfigEnabled: true,
    active: true,
    reason: 'active',
  })
  const responseText = JSON.stringify(apply)
  assert.equal(responseText.includes('P-001'), false, 'injected failure response does not include clean sibling key values')
  assert.equal(responseText.includes('P-002'), false, 'injected failure response does not include row key values')
  assert.equal(responseText.includes('Widget'), false, 'injected failure response does not include clean sibling row values')
  assert.equal(responseText.includes('Gadget'), false, 'injected failure response does not include row values')
  assert.ok(apply.provenanceEvents.some((event) => event.eventType === 'target_write_failed'), 'injected failure produces failure provenance')
  assert.ok(apply.provenanceEvents.some((event) => event.eventType === 'target_write_succeeded'), 'clean sibling produces success provenance')

  const insertCountAfterPartial = calls.insertRows.length
  const deadLetterCountAfterPartial = deadLetters.length
  await assert.rejects(
    () => applyExternalWrite({
      ...input,
      dryRunToken,
      applyUser: 'user_write',
      runId: 'run_c6_injected_failure_reuse',
      deadLetterStore: {
        async createDeadLetter(entry) {
          deadLetters.push(entry)
          return { ...entry, id: `dl_${deadLetters.length}` }
        },
      },
    }),
    (error) => error && error.code === 'C6_WRITE_DRY_RUN_TOKEN_INVALID',
  )
  assert.equal(calls.insertRows.length, insertCountAfterPartial, 'reusing a consumed partial token cannot write again')
  assert.equal(deadLetters.length, deadLetterCountAfterPartial, 'reusing a consumed partial token cannot create another dead letter')
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
    input: { maxRows: 1 },
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

// --- S1b-1: the safe-write lifecycle generalizes off data-source:sql-write-gated ----------
// A non-SQL target opts into the SAME C6 lifecycle via a write PROFILE + the injected write
// source. The profile uses a DIFFERENT capability-state shape ({ ok }) to prove the planner
// no longer hardcodes the SQL flags; the write primitives are the injected dataSourceWrites.
function fakeWriteProfile() {
  return {
    kind: 'fake:write-target',
    normalizeCapabilityState(result) {
      const state = result && result.capabilityState
      if (!state || typeof state.ok !== 'boolean') {
        throw new Error('fake target capability state unavailable')
      }
      return { success: result.success === true, ok: state.ok }
    },
    assertSafeCapabilityState(state) {
      if (state.ok !== true) throw new Error('fake target capability state is unsafe')
    },
  }
}

function k3ExactTwoAcceptanceInput(overrides = {}) {
  const fixture = baseInput({
    test: () => ({ success: true, capabilityState: { ok: true } }),
    lookupByKey: () => ({ data: [], metadata: {} }),
    ...overrides,
  })
  fixture.input.targetWriteProfile = {
    ...fakeWriteProfile(),
    kind: 'erp:k3-wise-webapi',
  }
  fixture.input.targetSystem = {
    id: 'target_1',
    kind: 'erp:k3-wise-webapi',
    config: {
      dataSourceId: 'k3-save-only',
      object: 'material',
      keyFields: ['externalId'],
      writableFields: ['name', 'status'],
      acceptancePolicy: {
        profile: __internals.K3_TEST_ONLY_EXACT_TWO_ADD_PROFILE,
      },
    },
  }
  return fixture
}

// CONVERTED (E4 / HG v1.2 §10, error code K3_WISE_EXTERNAL_WRITE_DISABLED). Every K3-target
// fixture in this file used to end in a real apply. K3 external write-back is now permanently
// refused at four independent layers, and layer 2 lives in the module this suite drives — so the
// apply half of each K3 case becomes a refusal assertion with `insertRows`/`updateRows` at zero.
// The PLAN half of each case is untouched: the acceptance policy still evaluates, the counts and
// rowErrorTypes are still asserted, and the strictAbsence binding is still proven. That split is
// deliberate — E4-05 requires the read/plan path to keep working, and a blanket deny that stopped
// the planner from running would be a FAIL, not a pass.
async function testK3ExactTwoAcceptancePolicyAllowsOnlyExactAddPlan() {
  const { input, calls } = k3ExactTwoAcceptanceInput()
  const dryRun = await dryRunExternalWrite(input)
  assert.equal(dryRun.status, 'not_applyable', 'E4: a K3 plan is never "ready" — no apply follows from it')
  assert.equal(dryRun.canApply, false)
  assert.equal(dryRun.dryRunToken, null, 'E4: no apply authorisation is minted for a K3 target')
  assert.deepEqual(dryRun.evidence.externalWriteApply, {
    permanentlyRefused: true,
    refusalCode: 'K3_WISE_EXTERNAL_WRITE_DISABLED',
    authority: 'E4',
  })
  assert.equal(dryRun.counts.sourceRows, 2)
  assert.equal(dryRun.counts.planned, 2)
  assert.equal(dryRun.counts.add, 2)
  assert.equal(dryRun.counts.update, 0)
  assert.equal(dryRun.counts.skip, 0)
  assert.equal(dryRun.counts.held, 0)
  assert.equal(dryRun.counts.failed, 0)
  assert.deepEqual(dryRun.evidence.acceptancePolicy, {
    profile: __internals.K3_TEST_ONLY_EXACT_TWO_ADD_PROFILE,
    expectedRows: 2,
    ready: true,
    cleanupRequired: true,
  })

  // The persisted exact-two acceptance policy is EXACTLY the kind of "policy object" §10.1 says
  // cannot unlock the write. It still evaluates and still reports ready — and still buys nothing.
  assert.equal(calls.lookupByKey[0].policy.strictAbsence, true, 'exact-two add-only binds strict absence into planner policy')
  assert.equal(calls.lookupByKey.length, 2, 'the planner still performs its per-row target lookups')

  const refusal = await applyExternalWrite({
    ...input,
    dryRunToken: 'a-token-that-would-otherwise-be-valid',
    applyUser: 'user_read',
    runId: 'run_k3_exact_two',
  }).then(() => null, (error) => error)
  assert.ok(refusal, 'E4: apply must refuse')
  assert.equal(refusal.code, 'K3_WISE_EXTERNAL_WRITE_DISABLED')
  assert.equal(refusal.status, 403)
  assert.equal(calls.insertRows.length, 0, 'E4: zero Save calls')
  assert.equal(calls.updateRows.length, 0, 'E4: zero update calls')
  assert.equal(calls.lookupByKey.length, 2, 'E4: the refusal precedes the apply-side planner recompute entirely')
}

async function testK3ExactTwoAcceptanceStopsAfterFirstSaveFailure() {
  const deadLetters = []
  const { input, calls } = k3ExactTwoAcceptanceInput({
    insertRows: () => {
      throw new Error('K3 Save failed with private row values')
    },
  })
  // CONVERTED (E4). This proved that the FIRST Save failure stops the batch instead of enlarging
  // the partial-write set, and that the resulting evidence + dead letter stay values-free. With
  // zero Saves possible there is no first failure to stop after — so the surviving, stronger
  // claim is asserted instead: ZERO Saves, ZERO dead letters, and a refusal that carries none of
  // the private row values the old evidence had to be scrubbed of.
  const dryRun = await dryRunExternalWrite(input)
  assert.equal(dryRun.dryRunToken, null)
  const refusal = await applyExternalWrite({
    ...input,
    dryRunToken: 'a-token-that-would-otherwise-be-valid',
    applyUser: 'user_read',
    runId: 'run_k3_exact_two_first_save_failure',
    deadLetterStore: {
      async createDeadLetter(entry) {
        deadLetters.push(entry)
        return { ...entry, id: `dl_${deadLetters.length}` }
      },
    },
  }).then(() => null, (error) => error)

  assert.equal(refusal.code, 'K3_WISE_EXTERNAL_WRITE_DISABLED')
  assert.equal(calls.insertRows.length, 0, 'E4: not even the first Save is attempted')
  assert.equal(calls.updateRows.length, 0)
  assert.equal(deadLetters.length, 0, 'E4: a refused apply writes no dead letters — there is no failed row')
  const evidence = JSON.stringify({ code: refusal.code, message: refusal.message, details: refusal.details })
  for (const privateValue of ['P-001', 'P-002', 'Widget', 'Gadget']) {
    assert.equal(evidence.includes(privateValue), false, `the refusal stays values-free (${privateValue})`)
  }
}

async function testK3ExactTwoAcceptancePolicyRejectsDuplicateMaterialKeysBeforeApply() {
  const { input, calls } = k3ExactTwoAcceptanceInput({
    sourceRows: [
      { code: ' MAT-001 ', name: 'Widget', status: 'new' },
      { code: 'mat-001', name: 'Gadget', status: 'old' },
    ],
  })
  input.pipeline.fieldMappings = input.pipeline.fieldMappings.map((mapping) => (
    mapping.targetField === 'externalId'
      ? { ...mapping, targetField: 'FNumber' }
      : mapping
  ))
  input.targetSystem.config.keyFields = ['FNumber']

  const dryRun = await dryRunExternalWrite(input)
  assert.equal(dryRun.status, 'not_applyable')
  assert.equal(dryRun.canApply, false)
  assert.equal(dryRun.dryRunToken, null)
  assert.equal(dryRun.counts.sourceRows, 2)
  assert.equal(dryRun.counts.planned, 2)
  assert.equal(dryRun.counts.add, 1)
  assert.equal(dryRun.counts.held, 1)
  assert.equal(dryRun.evidence.acceptancePolicy.ready, false)
  assert.ok(dryRun.evidence.rowErrorTypes.includes('duplicate_target_key'))
  assert.ok(dryRun.evidence.rowErrorTypes.includes('acceptance_policy_mismatch'))
  assert.equal(calls.lookupByKey.length, 1, 'the duplicate key is refused before a second target lookup')
  assert.equal(input.tokenStore.map.size, 0, 'a duplicate target key never mints an Apply token')

  // CONVERTED (E4): the duplicate-key plan already minted no token, and the apply used to fail
  // with C6_WRITE_DRY_RUN_TOKEN_REQUIRED. The E4 fence is the FIRST statement of
  // applyExternalWrite, ahead of the token check, so a K3 apply now reports the write-disabled
  // code instead. The plan-side duplicate-key assertions above are untouched.
  await assert.rejects(
    () => applyExternalWrite({
      ...input,
      dryRunToken: dryRun.dryRunToken,
      applyUser: 'user_read',
    }),
    (error) => error && error.code === 'K3_WISE_EXTERNAL_WRITE_DISABLED',
  )
  assert.equal(calls.insertRows.length, 0, 'the duplicate-key plan cannot reach K3 Save')
  assert.equal(calls.updateRows.length, 0)
}

async function testK3ExactTwoAcceptancePolicyBlocksUpdateOrWrongCardinality() {
  for (const fixture of [
    k3ExactTwoAcceptanceInput({
      lookupByKey: ({ key }) => key.externalId === 'P-002'
        ? { data: [{ externalId: 'P-002', name: 'old', status: 'old' }] }
        : { data: [] },
    }),
    k3ExactTwoAcceptanceInput({ sourceRows: [{ code: 'P-001', name: 'Widget', status: 'new' }] }),
  ]) {
    const result = await dryRunExternalWrite(fixture.input)
    assert.equal(result.status, 'not_applyable')
    assert.equal(result.canApply, false)
    assert.equal(result.dryRunToken, null)
    assert.equal(result.evidence.acceptancePolicy.ready, false)
    assert.ok(result.evidence.rowErrorTypes.includes('acceptance_policy_mismatch'))
    assert.equal(fixture.calls.insertRows.length, 0)
    assert.equal(fixture.calls.updateRows.length, 0)
  }
}

async function testK3ExactTwoAcceptancePolicyIsClosedAndRevisionBound() {
  const invalid = k3ExactTwoAcceptanceInput()
  invalid.input.targetSystem.config.acceptancePolicy.extra = true
  await assert.rejects(
    () => dryRunExternalWrite(invalid.input),
    (error) => error && error.code === 'C6_WRITE_ACCEPTANCE_POLICY_INVALID',
  )
  assert.equal(invalid.calls.test.length, 0, 'invalid persisted policy fails before target capability/network work')

  const nonK3 = k3ExactTwoAcceptanceInput()
  nonK3.input.targetSystem.kind = 'data-source:sql-write-gated'
  nonK3.input.targetWriteProfile = {
    ...nonK3.input.targetWriteProfile,
    kind: 'data-source:sql-write-gated',
  }
  await assert.rejects(
    () => dryRunExternalWrite(nonK3.input),
    (error) => error && error.code === 'C6_WRITE_ACCEPTANCE_POLICY_INVALID',
  )
  assert.equal(nonK3.calls.test.length, 0, 'K3-only persisted policy fails closed on a non-K3 target')

  // CONVERTED (E4). The two closed-shape checks above are UNCHANGED and still live — they run in
  // the planner, which K3 targets still reach. The third leg used the revision fence
  // (C6_WRITE_DRY_RUN_TOKEN_MISMATCH) to prove that removing the persisted policy after the
  // dry-run invalidates the approval; for K3 that branch is unreachable because no token is
  // minted. The revision fence itself is NOT weakened — it stays covered for the SQL and
  // multitable profiles elsewhere in this same file.
  const { input, calls } = k3ExactTwoAcceptanceInput()
  const dryRun = await dryRunExternalWrite(input)
  assert.equal(dryRun.dryRunToken, null, 'E4: no token, so nothing to invalidate')
  delete input.targetSystem.config.acceptancePolicy
  await assert.rejects(
    () => applyExternalWrite({
      ...input,
      dryRunToken: 'a-token-that-would-otherwise-be-valid',
      applyUser: 'user_read',
    }),
    (error) => error && error.code === 'K3_WISE_EXTERNAL_WRITE_DISABLED',
    'with or without the persisted policy, a K3 apply is refused',
  )
  assert.equal(calls.insertRows.length, 0)
  assert.equal(calls.updateRows.length, 0)
}

async function testK3ExactTwoAcceptancePolicyDoesNotTreatLookupBusinessErrorAsAbsent() {
  const { input, calls } = k3ExactTwoAcceptanceInput({
    lookupByKey: () => {
      const error = new Error('K3 read business response failed')
      error.details = { code: 'K3_WISE_READ_BUSINESS_ERROR' }
      throw error
    },
  })
  await assert.rejects(
    () => dryRunExternalWrite(input),
    (error) => error && error.details && error.details.code === 'K3_WISE_READ_BUSINESS_ERROR',
  )
  assert.equal(input.tokenStore.map.size, 0, 'a generic K3 business-read error never mints a token under exact-two')
  assert.equal(calls.insertRows.length, 0)
  assert.equal(calls.updateRows.length, 0)
  assert.equal(calls.lookupByKey[0].policy.strictAbsence, true)
}

async function testK3ExactTwoApplyPreflightRefusesBatchAfterPlannerLookupStateChange() {
  let lookups = 0
  const { input, calls } = k3ExactTwoAcceptanceInput({
    lookupByKey: () => {
      lookups += 1
      if (lookups <= 4) return { data: [], metadata: {} }
      return { data: [{ externalId: 'now-present' }], metadata: {} }
    },
  })
  // CONVERTED (E4). The strict add-only TOCTOU preflight runs INSIDE applyExternalWrite, after
  // the token is consumed and the plan recomputed — layer 2 refuses long before it, so the
  // preflight is unreachable for K3. Its purpose (a post-plan existence change must not become a
  // silent overwrite) is subsumed: the write cannot happen at all, whatever the target does
  // between plan and apply. The values-free assertion is kept and now covers the refusal.
  const dryRun = await dryRunExternalWrite(input)
  assert.equal(dryRun.status, 'not_applyable')
  assert.equal(dryRun.dryRunToken, null)
  assert.equal(lookups, 2, 'dry-run still plans two absent rows — the read path is untouched')

  await assert.rejects(
    () => applyExternalWrite({
      ...input,
      dryRunToken: 'a-token-that-would-otherwise-be-valid',
      applyUser: 'user_read',
    }),
    (error) => error && error.code === 'K3_WISE_EXTERNAL_WRITE_DISABLED',
  )
  assert.equal(lookups, 2, 'E4: apply performs NO recompute lookups — the refusal precedes the planner')
  assert.equal(calls.insertRows.length, 0, 'zero Save')
  assert.equal(calls.updateRows.length, 0)
  const leaked = JSON.stringify(calls) + JSON.stringify(dryRun.evidence)
  assert.equal(leaked.includes('now-present'), false, 'evidence stays values-free')
}

async function testK3ExactTwoApplyPreflightRefusesAmbiguousOrLookupErrorWithZeroSave() {
  for (const fixture of [
    {
      reason: 'ambiguous_target_key',
      lookupByKey: (() => {
        let lookups = 0
        return () => {
          lookups += 1
          if (lookups <= 4) return { data: [], metadata: {} }
          return { data: [{ externalId: 'a' }, { externalId: 'b' }], metadata: {} }
        }
      })(),
    },
    {
      reason: 'lookup_error',
      lookupByKey: (() => {
        let lookups = 0
        return () => {
          lookups += 1
          if (lookups <= 4) return { data: [], metadata: {} }
          throw new Error('lookup exploded')
        }
      })(),
    },
    {
      reason: 'lookup_error',
      lookupByKey: (() => {
        let lookups = 0
        return () => {
          lookups += 1
          if (lookups <= 4) return { data: [], metadata: {} }
          return { metadata: {} }
        }
      })(),
    },
  ]) {
    // CONVERTED (E4), same disposition as the sibling preflight test above: the preflight's
    // ambiguous / lookup-error refusals live past layer 2 and are unreachable for K3. Each
    // fixture still runs its plan and each still ends in zero Save — now unconditionally.
    const { input, calls } = k3ExactTwoAcceptanceInput({ lookupByKey: fixture.lookupByKey })
    const dryRun = await dryRunExternalWrite(input)
    assert.equal(dryRun.dryRunToken, null, `${fixture.reason}: no token minted for a K3 target`)
    await assert.rejects(
      () => applyExternalWrite({
        ...input,
        dryRunToken: 'a-token-that-would-otherwise-be-valid',
        applyUser: 'user_read',
      }),
      (error) => error && error.code === 'K3_WISE_EXTERNAL_WRITE_DISABLED',
    )
    assert.equal(calls.insertRows.length, 0, `${fixture.reason}: zero Save`)
    assert.equal(calls.updateRows.length, 0)
  }
}

function fakeProfileInput(overrides = {}) {
  return baseInput({
    test: () => ({ success: true, capabilityState: { ok: true } }),
    ...overrides,
    input: {
      dryRunUser: 'user_write',
      targetWriteProfile: fakeWriteProfile(),
      targetSystem: {
        id: 'target_1',
        kind: 'fake:write-target',
        config: {
          dataSourceId: 'fake-write-source',
          object: 'own.target_items',
          keyFields: ['externalId'],
          writableFields: ['name', 'status'],
        },
      },
      ...(overrides.input || {}),
    },
  })
}

async function testWriteSourceSeamGeneralizesLifecycleOffSqlProfile() {
  const { input, calls } = fakeProfileInput()
  const dryRun = await dryRunExternalWrite(input)
  assert.equal(dryRun.status, 'ready')
  assert.equal(dryRun.canApply, true)
  assert.equal(dryRun.counts.add, 1, 'classification (add) works through the generalized profile')
  assert.equal(dryRun.counts.update, 1, 'classification (update) works through the generalized profile')
  assert.equal(dryRun.counts.failed, 0)
  assert.equal(dryRun.evidence.targetKind, 'fake:write-target', 'evidence carries the generalized kind, not the SQL constant')
  const dryText = JSON.stringify(dryRun.evidence)
  assert.equal(dryText.includes('P-001'), false, 'generalized dry-run evidence stays values-free')
  assert.equal(dryText.includes('Widget'), false, 'generalized dry-run evidence stays values-free')
  assert.equal(dryText.includes('data-source:sql-write-gated'), false, 'generalized run is not mislabeled as the SQL profile')

  const apply = await applyExternalWrite({
    ...input,
    dryRunToken: dryRun.dryRunToken,
    applyUser: 'user_write',
    runId: 'run_fake_seam',
  })
  assert.equal(apply.status, 'succeeded')
  assert.equal(apply.counts.written, 2)
  assert.equal(apply.counts.add, 1)
  assert.equal(apply.counts.update, 1)
  assert.equal(calls.insertRows.length, 1, 'add routed to the injected (non-SQL) write source')
  assert.equal(calls.updateRows.length, 1, 'update routed to the injected (non-SQL) write source')
  assert.equal(apply.evidence.targetKind, 'fake:write-target')
  assert.equal(input.tokenStore.map.size, 0, 'apply consumed the single-use token')
  // Revision-fence / single-use still holds on the generalized path: the consumed token is dead.
  await assert.rejects(
    () => applyExternalWrite({ ...input, dryRunToken: dryRun.dryRunToken, applyUser: 'user_write' }),
    (error) => error && error.code === 'C6_WRITE_DRY_RUN_TOKEN_INVALID',
    'consumed token is single-use under the generalized profile',
  )
}

async function testWriteSourceSeamIsolatesRowFailureValuesFree() {
  const deadLetters = []
  // The injected write source fails the add row with an error whose message embeds row
  // values; the per-row failure must isolate, persist a values-free dead letter, and let the
  // clean sibling (update) through — proving C6 safety holds on the generalized path.
  const { input, calls } = fakeProfileInput({
    insertRows: () => {
      throw new Error('insert failed: (externalId)=(P-001) name=Widget')
    },
  })
  const dryRun = await dryRunExternalWrite(input)
  const apply = await applyExternalWrite({
    ...input,
    dryRunToken: dryRun.dryRunToken,
    applyUser: 'user_write',
    runId: 'run_fake_fail',
    deadLetterStore: {
      async createDeadLetter(entry) {
        deadLetters.push(entry)
        return { ...entry, id: `dl_${deadLetters.length}` }
      },
    },
  })
  assert.equal(apply.status, 'partial', 'add fails, update succeeds -> partial')
  assert.equal(apply.counts.failed, 1)
  assert.equal(apply.counts.update, 1)
  assert.equal(apply.counts.written, 1)
  assert.equal(calls.updateRows.length, 1, 'clean sibling still written through the injected source')
  assert.deepEqual(apply.deadLetters, { attempted: 1, persisted: 1 })
  const text = JSON.stringify(apply) + JSON.stringify(deadLetters)
  for (const leak of ['P-001', 'P-002', 'Widget', 'Gadget']) {
    assert.equal(text.includes(leak), false, `generalized row-failure path stays values-free (${leak})`)
  }
}

async function main() {
  await testReadyDryRunIssuesTokenAndStaysValuesFree()
  await testServerBoundSqlEqualityFiltersForwardAndDiscriminateCompleteness()
  await testMissingOrInvalidSqlFiltersFailBeforeSourceContactValuesFree()
  await testSqlFilterDriverFailuresAreRedactedForDryRunAndApply()
  await testStoredFilterChangeInvalidatesDryRunRevisionBeforeWrite()
  await testWriteSourceSeamGeneralizesLifecycleOffSqlProfile()
  await testWriteSourceSeamIsolatesRowFailureValuesFree()
  await testK3ExactTwoAcceptancePolicyAllowsOnlyExactAddPlan()
  await testK3ExactTwoAcceptanceStopsAfterFirstSaveFailure()
  await testK3ExactTwoAcceptancePolicyRejectsDuplicateMaterialKeysBeforeApply()
  await testK3ExactTwoAcceptancePolicyBlocksUpdateOrWrongCardinality()
  await testK3ExactTwoAcceptancePolicyIsClosedAndRevisionBound()
  await testK3ExactTwoAcceptancePolicyDoesNotTreatLookupBusinessErrorAsAbsent()
  await testK3ExactTwoApplyPreflightRefusesBatchAfterPlannerLookupStateChange()
  await testK3ExactTwoApplyPreflightRefusesAmbiguousOrLookupErrorWithZeroSave()
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
  await testTestFailureInjectionStaysOffWithoutDeployGate()
  await testTestFailureInjectionRequiresServerConfigTargetMatch()
  await testTestFailureInjectionRejectsNonSandboxServerConfigBeforeWrite()
  await testTestFailureInjectionRejectsMutableTargetDriftBeforeWrite()
  await testTestFailureInjectionRequiresWritableSiblingRows()
  await testTestFailureInjectionRevisionBoundBeforeWrite()
  await testTestFailureInjectionOrdinalIsRevisionBoundBeforeWrite()
  await testTestFailureInjectionInjectsExactlyOneRowAndKeepsSibling()
  console.log('external-write-dry-run.test.cjs OK')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

// --- Ownership-guard codes survive as themselves (Codex review follow-up) ---------------
// The multitable ownership guard refuses to write a protected column, and refuses when it
// cannot verify ownership at all. Both are TARGET-CONFIGURATION facts: an operator must be
// able to tell "this target is misconfigured" from "this write flaked". Before these tokens
// were registered in SAFE_WRITE_ERROR_CODES they collapsed into an opaque WRITE_FAILED.
// The tokens are read from the guard module rather than retyped, so a rename over there
// fails this test instead of silently un-registering the codes.
{
  const { __internals } = require('../lib/external-write-dry-run.cjs')
  const guard = require('../lib/adapters/multitable-ownership-guard.cjs')
  const { valuesFreeErrorCode } = __internals

  const guardSource = require('node:fs').readFileSync(
    require.resolve('../lib/adapters/multitable-ownership-guard.cjs'),
    'utf8',
  )
  const declared = [...guardSource.matchAll(/'(METASHEET_MULTITABLE_OWNERSHIP_[A-Z_]+)'/g)].map((m) => m[1])
  assert.ok(declared.length >= 2, 'expected the guard to declare its ownership refusal codes')

  for (const code of new Set(declared)) {
    assert.strictEqual(
      valuesFreeErrorCode({ code }),
      code,
      `ownership refusal ${code} must survive as itself, not collapse to WRITE_FAILED`,
    )
  }

  // Negative control: an unregistered code still collapses, so the assertion above is not
  // passing because valuesFreeErrorCode became a pass-through.
  assert.strictEqual(valuesFreeErrorCode({ code: 'METASHEET_MULTITABLE_OWNERSHIP_NOT_A_REAL_CODE' }), 'WRITE_FAILED')
  assert.strictEqual(valuesFreeErrorCode({ code: 'SOME_UNREGISTERED_ERROR' }), 'WRITE_FAILED')

  // Values-free: the codes carry no operator data by construction.
  for (const code of new Set(declared)) {
    assert.ok(/^[A-Z0-9_]+$/.test(code), `${code} must be a closed token`)
  }
  void guard
  console.log('OK ownership refusal codes survive valuesFreeErrorCode')
}
