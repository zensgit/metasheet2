'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const {
  computeIdempotencyKey,
  computeRecordIdempotencyKey,
} = require(path.join(__dirname, '..', 'lib', 'idempotency.cjs'))
const {
  createWatermarkStore,
  deriveNextWatermark,
} = require(path.join(__dirname, '..', 'lib', 'watermark.cjs'))
const { createDeadLetterStore } = require(path.join(__dirname, '..', 'lib', 'dead-letter.cjs'))
const { createRunLog, createRunLogger } = require(path.join(__dirname, '..', 'lib', 'run-log.cjs'))

function createMockDb() {
  const tables = new Map([
    ['integration_watermarks', []],
    ['integration_dead_letters', []],
  ])

  function rows(table) {
    if (!tables.has(table)) tables.set(table, [])
    return tables.get(table)
  }

  function matches(row, where) {
    return Object.entries(where || {}).every(([key, value]) => {
      if (value === null || value === undefined) return row[key] === null || row[key] === undefined
      return row[key] === value
    })
  }

  return {
    tables,
    calls: [],
    async selectOne(table, where) {
      this.calls.push(['selectOne', table, { ...where }])
      return rows(table).find((row) => matches(row, where)) || null
    },
    async insertOne(table, row) {
      this.calls.push(['insertOne', table, { ...row }])
      const stored = {
        ...row,
        created_at: row.created_at || '2026-04-24T00:00:00.000Z',
        updated_at: row.updated_at || '2026-04-24T00:00:00.000Z',
      }
      rows(table).push(stored)
      return [stored]
    },
    async updateRow(table, set, where) {
      this.calls.push(['updateRow', table, { ...set }, { ...where }])
      const row = rows(table).find((candidate) => matches(candidate, where))
      if (!row) return []
      Object.assign(row, set, { updated_at: '2026-04-24T01:00:00.000Z' })
      return [row]
    },
    async select(table, options = {}) {
      this.calls.push(['select', table, JSON.parse(JSON.stringify(options))])
      const filtered = rows(table).filter((row) => matches(row, options.where || {}))
      const ordered = filtered.slice()
      if (options.orderBy) {
        const [field, direction] = options.orderBy
        ordered.sort((left, right) => {
          if (left[field] === right[field]) return 0
          const result = left[field] > right[field] ? 1 : -1
          return direction === 'DESC' ? -result : result
        })
      }
      return ordered.slice(options.offset || 0, (options.offset || 0) + (options.limit || 1000))
    },
  }
}

async function main() {
  // Idempotency keys are stable and include all requested dimensions.
  const keyA = computeIdempotencyKey({
    sourceSystem: 'plm_1',
    objectType: 'materials',
    sourceId: 'A-01',
    revision: 0,
    targetSystem: 'k3_1',
  })
  const keyB = computeIdempotencyKey({
    sourceSystemId: 'plm_1',
    objectType: 'materials',
    sourceId: 'A-01',
    revision: 0,
    targetSystemId: 'k3_1',
  })
  assert.equal(keyA, keyB)
  assert.match(keyA, /^idem_[0-9a-f]{64}$/)
  assert.notEqual(keyA, computeIdempotencyKey({
    sourceSystem: 'plm_1',
    objectType: 'materials',
    sourceId: 'A-01',
    revision: '',
    targetSystem: 'k3_1',
  }))

  const recordKey = computeRecordIdempotencyKey({
    record: { source: { id: 'SRC-1' }, version: 'v2' },
    pipeline: {
      sourceSystemId: 'plm_pipeline',
      targetSystemId: 'erp_pipeline',
      sourceObject: 'materials',
      idempotencyKeyFields: ['source.id', 'version'],
    },
    sourceSystem: { id: 'plm_1' },
    targetSystem: { id: 'k3_1' },
  })
  assert.equal(recordKey, computeIdempotencyKey({
    sourceSystem: 'plm_1',
    objectType: 'materials',
    sourceId: 'SRC-1',
    revision: 'v2',
    targetSystem: 'k3_1',
  }))
  const multiDimKeyA = computeRecordIdempotencyKey({
    record: { code: 'MAT-001', revision: 'A', org: '100', locale: 'zh-CN' },
    pipeline: {
      sourceSystemId: 'plm_pipeline',
      targetSystemId: 'erp_pipeline',
      sourceObject: 'materials',
      idempotencyKeyFields: ['code', 'revision', 'org', 'locale'],
    },
    sourceSystem: { id: 'plm_1' },
    targetSystem: { id: 'k3_1' },
  })
  const multiDimKeyB = computeRecordIdempotencyKey({
    record: { code: 'MAT-001', revision: 'A', org: '200', locale: 'zh-CN' },
    pipeline: {
      sourceSystemId: 'plm_pipeline',
      targetSystemId: 'erp_pipeline',
      sourceObject: 'materials',
      idempotencyKeyFields: ['code', 'revision', 'org', 'locale'],
    },
    sourceSystem: { id: 'plm_1' },
    targetSystem: { id: 'k3_1' },
  })
  assert.notEqual(multiDimKeyA, multiDimKeyB, 'all idempotencyKeyFields after the first two contribute to the key')
  assert.equal(multiDimKeyA, computeIdempotencyKey({
    sourceSystem: 'plm_1',
    objectType: 'materials',
    sourceId: 'MAT-001',
    revision: 'A',
    targetSystem: 'k3_1',
    dimensions: {
      org: '100',
      locale: 'zh-CN',
    },
  }))
  assert.throws(
    () => computeRecordIdempotencyKey({
      record: { code: 'MAT-001', revision: 'A', org: '' },
      pipeline: {
        sourceSystemId: 'plm_pipeline',
        targetSystemId: 'erp_pipeline',
        sourceObject: 'materials',
        idempotencyKeyFields: ['code', 'revision', 'org'],
      },
      sourceSystem: { id: 'plm_1' },
      targetSystem: { id: 'k3_1' },
    }),
    /dimensions\.org is required/,
  )
  const unsafeDimensionInput = {
    sourceSystem: 'plm_1',
    objectType: 'materials',
    sourceId: 'MAT-001',
    revision: 'A',
    targetSystem: 'k3_1',
    dimensions: { ['__proto__']: 'safe', constructor: 'safe', prototype: 'safe', org: '100' },
  }
  const unsafeDimensionVariant = {
    ...unsafeDimensionInput,
    dimensions: { ['__proto__']: 'changed', constructor: 'safe', prototype: 'safe', org: '100' },
  }
  const unsafeDimensionKey = computeIdempotencyKey(unsafeDimensionInput)
  assert.match(unsafeDimensionKey, /^idem_[0-9a-f]{64}$/)
  assert.notEqual(
    unsafeDimensionKey,
    computeIdempotencyKey(unsafeDimensionVariant),
    'special dimension keys remain own data keys and contribute to the fingerprint',
  )
  assert.equal({}.polluted, undefined, 'idempotency dimensions cannot pollute Object.prototype')
  assert.throws(
    () => computeIdempotencyKey({ sourceSystem: 'plm_1', objectType: 'materials', targetSystem: 'k3_1' }),
    /sourceId is required/,
  )

  // Watermark derivation supports updated_at and monotonic_id without storing
  // anything by itself. The caller decides when a successful batch advances it.
  const nextWatermark = deriveNextWatermark([
    { updated_at: '2026-04-24T01:00:00.000Z' },
    { updatedAt: '2026-04-24T02:00:00.000Z' },
  ], { type: 'updated_at' })
  assert.deepEqual(nextWatermark, { type: 'updated_at', value: '2026-04-24T02:00:00.000Z' })
  assert.deepEqual(
    deriveNextWatermark([{ id: 7 }, { id: '42' }, { id: 13 }], { type: 'monotonic_id' }),
    { type: 'monotonic_id', value: '42' },
  )

  const db = createMockDb()
  const watermarks = createWatermarkStore({ db })
  assert.equal(await watermarks.getWatermark('pipe_1'), null)
  const storedWatermark = await watermarks.setWatermark({
    pipelineId: 'pipe_1',
    type: 'updated_at',
    value: '2026-04-24T01:00:00.000Z',
  })
  assert.equal(storedWatermark.value, '2026-04-24T01:00:00.000Z')
  const failedBatchCandidate = deriveNextWatermark([
    { updated_at: '2026-04-24T09:00:00.000Z' },
  ], { type: 'updated_at' })
  assert.equal(failedBatchCandidate.value, '2026-04-24T09:00:00.000Z')
  assert.equal((await watermarks.getWatermark('pipe_1')).value, storedWatermark.value)

  const advancedWatermark = await watermarks.setWatermark({
    pipelineId: 'pipe_1',
    type: nextWatermark.type,
    value: nextWatermark.value,
  })
  assert.equal(advancedWatermark.value, nextWatermark.value)
  const updatedWatermark = await watermarks.advanceWatermark({ pipelineId: 'pipe_1', type: 'monotonic_id', value: '42' })
  assert.equal(updatedWatermark.type, 'monotonic_id')
  assert.equal(updatedWatermark.value, '42')
  const notRegressed = await watermarks.advanceWatermark({ pipelineId: 'pipe_1', type: 'monotonic_id', value: '7' })
  assert.equal(notRegressed.value, '42', 'advanceWatermark does not move monotonic watermarks backwards')

  // Dead letters can be created, listed, and marked as replayed.
  const deadLetters = createDeadLetterStore({ db, idGenerator: () => 'dl_1' })
  const created = await deadLetters.create({
    tenantId: 'tenant_1',
    workspaceId: null,
    runId: 'run_1',
    pipelineId: 'pipe_1',
    sourcePayload: { code: 'A-01' },
    transformedPayload: { FNumber: 'A-01' },
    errorCode: 'VALIDATION_FAILED',
    errorMessage: 'FName is required',
  })
  assert.equal(created.id, 'dl_1')
  assert.equal(created.status, 'open')
  const listed = await deadLetters.list({ tenantId: 'tenant_1', workspaceId: null, status: 'open' })
  assert.equal(listed.length, 1)
  assert.equal(listed[0].errorCode, 'VALIDATION_FAILED')
  const replayed = await deadLetters.markReplayed({
    tenantId: 'tenant_1',
    workspaceId: null,
    id: 'dl_1',
    replayRunId: 'run_2',
    retryCount: 1,
  })
  assert.equal(replayed.status, 'replayed')
  assert.equal(replayed.lastReplayRunId, 'run_2')
  assert.equal(replayed.retryCount, 1)

  const capped = await deadLetters.create({
    tenantId: 'tenant_1',
    workspaceId: null,
    runId: 'run_1',
    pipelineId: 'pipe_1',
    sourcePayload: {
      code: 'BIG-01',
      password: 'source-secret',
      rawPayload: {
        token: 'raw-secret',
      },
      details: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`field_${index}`, 'x'.repeat(2000)])),
    },
    transformedPayload: {
      FNumber: 'BIG-01',
      Authorization: 'Bearer target-token',
    },
    errorCode: 'TARGET_WRITE_FAILED',
    errorMessage: 'large payload failed',
  })
  assert.equal(capped.sourcePayload.payloadTruncated, true)
  assert.equal(capped.sourcePayload.preview.rawPayload, '[redacted]')
  assert.equal(capped.sourcePayload.preview.password, '[redacted]')
  assert.equal(capped.transformedPayload.Authorization, '[redacted]')

  // Run-log is a thin wrapper over the pipeline registry run APIs.
  const runCalls = []
  const clockValues = [
    '2026-04-24T00:00:00.000Z',
    '2026-04-24T00:00:01.500Z',
  ]
  const runLogger = createRunLog({
    pipelineRegistry: {
      async createPipelineRun(input) {
        runCalls.push(['create', input])
        return { id: 'run_1', ...input }
      },
      async updatePipelineRun(input) {
        runCalls.push(['update', input])
        return { id: input.id, status: input.status, rowsWritten: input.rowsWritten }
      },
    },
    clock: () => clockValues.shift(),
  })
  assert.equal(createRunLogger, createRunLog)
  const run = await runLogger.start({
    tenantId: 'tenant_1',
    pipelineId: 'pipe_1',
    mode: 'manual',
    triggeredBy: 'manual',
  })
  assert.equal(runCalls[0][1].status, 'running')
  assert.equal(runCalls[0][1].startedAt, '2026-04-24T00:00:00.000Z')
  const finished = await runLogger.finish(run, {
    rowsRead: 1,
    rowsCleaned: 1,
    rowsWritten: 1,
    rowsFailed: 0,
  }, 'succeeded')
  assert.equal(finished.status, 'succeeded')
  assert.equal(runCalls[1][1].finishedAt, '2026-04-24T00:00:01.500Z')
  assert.equal(runCalls[1][1].durationMs, 1500)
  assert.equal(runCalls.length, 2)

  // --- run-log: errorSummary length cap ---------------------------------
  {
    const { MAX_ERROR_SUMMARY_LENGTH } = require(path.join(__dirname, '..', 'lib', 'run-log.cjs'))
    const truncCalls = []
    const truncLogger = createRunLog({
      pipelineRegistry: {
        async createPipelineRun(input) { return { id: 'run_t', ...input } },
        async updatePipelineRun(input) { truncCalls.push(input); return { id: input.id, status: input.status } },
      },
      clock: () => '2026-04-27T00:00:00.000Z',
    })
    const truncRun = await truncLogger.start({
      tenantId: 'tenant_1', pipelineId: 'pipe_t', mode: 'manual', triggeredBy: 'manual',
    })

    // Long error message via failRun → truncated with [truncated] suffix
    const hugeMessage = 'X'.repeat(MAX_ERROR_SUMMARY_LENGTH * 5)
    await truncLogger.failRun(truncRun, new Error(hugeMessage), {
      rowsRead: 0, rowsCleaned: 0, rowsWritten: 0, rowsFailed: 0,
    })
    const failCall = truncCalls[truncCalls.length - 1]
    assert.equal(failCall.errorSummary.length, MAX_ERROR_SUMMARY_LENGTH,
      `errorSummary capped at MAX_ERROR_SUMMARY_LENGTH (${MAX_ERROR_SUMMARY_LENGTH})`)
    assert.ok(failCall.errorSummary.endsWith('… [truncated]'),
      'truncated errorSummary ends with [truncated] suffix')

    // Long extra.errorSummary via finishRun directly → also truncated
    await truncLogger.finishRun(truncRun, {}, 'failed', { errorSummary: hugeMessage })
    const finishCall = truncCalls[truncCalls.length - 1]
    assert.equal(finishCall.errorSummary.length, MAX_ERROR_SUMMARY_LENGTH,
      'finishRun extra.errorSummary also capped')

    // Short message → unchanged, no truncation suffix
    await truncLogger.failRun(truncRun, new Error('connection refused'), {})
    const shortCall = truncCalls[truncCalls.length - 1]
    assert.equal(shortCall.errorSummary, 'connection refused', 'short messages pass through unchanged')

    // null/undefined errorSummary → unchanged (passes through, DB layer handles null)
    await truncLogger.finishRun(truncRun, {}, 'succeeded', {})
    const nullCall = truncCalls[truncCalls.length - 1]
    assert.equal(nullCall.errorSummary, undefined, 'absent errorSummary passes through as undefined')
  }

  console.log('runner-support: idempotency/watermark/dead-letter/run-log tests passed')
}

main().catch((err) => {
  console.error('runner-support FAILED')
  console.error(err)
  process.exit(1)
})
