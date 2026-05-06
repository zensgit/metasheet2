'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { createAdapterRegistry, createReadResult, createUpsertResult } = require(path.join(__dirname, '..', 'lib', 'contracts.cjs'))
const { createPipelineRunner } = require(path.join(__dirname, '..', 'lib', 'pipeline-runner.cjs'))
const { createDeadLetterStore } = require(path.join(__dirname, '..', 'lib', 'dead-letter.cjs'))
const { createWatermarkStore } = require(path.join(__dirname, '..', 'lib', 'watermark.cjs'))
const { createRunLogger } = require(path.join(__dirname, '..', 'lib', 'run-log.cjs'))

function createMockDb() {
  const tables = new Map([
    ['integration_dead_letters', []],
    ['integration_watermarks', []],
    ['integration_runs', []],
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
    async selectOne(table, where) {
      return rows(table).find((row) => matches(row, where)) || null
    },
    async insertOne(table, row) {
      const stored = {
        ...row,
        created_at: row.created_at || '2026-04-24T00:00:00.000Z',
        updated_at: row.updated_at || '2026-04-24T00:00:00.000Z',
      }
      rows(table).push(stored)
      return [stored]
    },
    async updateRow(table, set, where) {
      const row = rows(table).find((candidate) => matches(candidate, where))
      if (!row) return []
      Object.assign(row, set, { updated_at: '2026-04-24T01:00:00.000Z' })
      return [row]
    },
    async select(table, options = {}) {
      return rows(table).filter((row) => matches(row, options.where || {}))
    },
  }
}

function createPipelineRegistry(pipeline, db) {
  let nextRun = 1
  return {
    async getPipeline(input) {
      assert.equal(input.id, pipeline.id)
      return pipeline
    },
    async createPipelineRun(input) {
      const id = `run_${nextRun++}`
      const row = {
        id,
        tenant_id: input.tenantId,
        workspace_id: input.workspaceId ?? null,
        pipeline_id: input.pipelineId,
        mode: input.mode,
        triggered_by: input.triggeredBy,
        status: input.status,
        rows_read: input.rowsRead || 0,
        rows_cleaned: input.rowsCleaned || 0,
        rows_written: input.rowsWritten || 0,
        rows_failed: input.rowsFailed || 0,
        started_at: input.startedAt || null,
        details: input.details || {},
      }
      await db.insertOne('integration_runs', row)
      return {
        id,
        tenantId: input.tenantId,
        workspaceId: input.workspaceId ?? null,
        pipelineId: input.pipelineId,
        mode: input.mode,
        triggeredBy: input.triggeredBy,
        status: input.status,
        details: input.details || {},
      }
    },
    async updatePipelineRun(input) {
      const rows = await db.updateRow('integration_runs', {
        status: input.status,
        rows_read: input.rowsRead,
        rows_cleaned: input.rowsCleaned,
        rows_written: input.rowsWritten,
        rows_failed: input.rowsFailed,
        duration_ms: input.durationMs,
        error_summary: input.errorSummary || null,
        details: input.details || {},
      }, {
        tenant_id: input.tenantId,
        workspace_id: input.workspaceId ?? null,
        id: input.id,
      })
      const row = rows[0]
      return {
        id: row.id,
        tenantId: row.tenant_id,
        workspaceId: row.workspace_id ?? null,
        pipelineId: row.pipeline_id,
        status: row.status,
        rowsRead: row.rows_read,
        rowsCleaned: row.rows_cleaned,
        rowsWritten: row.rows_written,
        rowsFailed: row.rows_failed,
        durationMs: row.duration_ms,
        errorSummary: row.error_summary,
        details: row.details,
      }
    },
  }
}

function createExternalSystemRegistry() {
  const systems = new Map([
    ['source_1', { id: 'source_1', name: 'PLM mock', kind: 'mock-source', role: 'source', config: {} }],
    ['target_1', { id: 'target_1', name: 'ERP mock', kind: 'mock-target', role: 'target', config: {} }],
  ])
  return {
    async getExternalSystem(input) {
      return systems.get(input.id)
    },
    async getExternalSystemForAdapter(input) {
      const system = systems.get(input.id)
      return system ? { ...system, credentials: { bearerToken: `${system.id}-token` } } : null
    },
  }
}

function createRunnerHarness({ sourceRecords, pipelineOverrides = {}, sourceRead, targetUpsert, erpFeedbackWriter } = {}) {
  const db = createMockDb()
  const targetRows = new Map()
  const adapterSystems = []
  const pipeline = {
    id: 'pipe_1',
    tenantId: 'tenant_1',
    workspaceId: null,
    projectId: 'project_1',
    sourceSystemId: 'source_1',
    sourceObject: 'materials',
    targetSystemId: 'target_1',
    targetObject: 'BD_MATERIAL',
    mode: 'incremental',
    status: 'active',
    idempotencyKeyFields: ['code', 'revision'],
    options: {
      batchSize: 100,
      watermark: { type: 'updated_at', field: 'updatedAt' },
    },
    fieldMappings: [
      { sourceField: 'code', targetField: 'FNumber', transform: ['trim', 'upper'], validation: [{ type: 'required' }] },
      { sourceField: 'qty', targetField: 'FQty', transform: { fn: 'toNumber' }, validation: [{ type: 'min', value: 1 }] },
      { sourceField: 'name', targetField: 'FName', transform: { fn: 'trim' }, validation: [{ type: 'required' }] },
    ],
    ...pipelineOverrides,
  }
  const adapterRegistry = createAdapterRegistry()
    .registerAdapter('mock-source', ({ system }) => ({
      system,
      async testConnection() { return { ok: true } },
      async listObjects() { return [{ name: 'materials' }] },
      async getSchema() { return { fields: [] } },
      async read(input) {
        if (sourceRead) return sourceRead(input)
        const watermark = input.watermark && input.watermark.updatedAt
        const records = watermark
          ? sourceRecords.filter((record) => Date.parse(record.updatedAt) > Date.parse(watermark))
          : sourceRecords.slice()
        return createReadResult({ records })
      },
      async upsert() {
        throw new Error('source upsert should not be called')
      },
    }))
    .registerAdapter('mock-target', ({ system }) => {
      adapterSystems.push(system)
      return {
      async testConnection() { return { ok: true } },
      async listObjects() { return [{ name: 'BD_MATERIAL' }] },
      async getSchema() { return { fields: [] } },
      async read() { return createReadResult({ records: [] }) },
      async upsert(input) {
        if (targetUpsert) return targetUpsert(input)
        let written = 0
        let skipped = 0
        const results = []
        for (const record of input.records) {
          const key = record._integration_idempotency_key
          if (targetRows.has(key)) {
            skipped += 1
            continue
          }
          targetRows.set(key, record)
          written += 1
          results.push({ key })
        }
        return createUpsertResult({ written, skipped, results })
      },
      }
    })

  const pipelineRegistry = createPipelineRegistry(pipeline, db)
  const runner = createPipelineRunner({
    pipelineRegistry,
    externalSystemRegistry: createExternalSystemRegistry(),
    adapterRegistry,
    deadLetterStore: createDeadLetterStore({ db, idGenerator: () => `dl_${db.tables.get('integration_dead_letters').length + 1}` }),
    watermarkStore: createWatermarkStore({ db }),
    runLogger: createRunLogger({ pipelineRegistry }),
    erpFeedbackWriter,
    clock: (() => {
      let tick = 0
      return () => tick++ * 25
    })(),
  })

  return { adapterSystems, db, pipeline, runner, sourceRecords, targetRows }
}

async function main() {
  // --- 1. Cleanse + validation failure goes to dead letter --------------
  const cleanse = createRunnerHarness({
    sourceRecords: [
      { code: '  a-01  ', revision: 'r1', qty: '3.50', name: ' Bolt ', updatedAt: '2026-04-24T01:00:00.000Z' },
      { code: 'b-02', revision: 'r1', qty: 'bad', name: 'Nut', updatedAt: '2026-04-24T02:00:00.000Z' },
    ],
  })
  const first = await cleanse.runner.runPipeline({
    tenantId: 'tenant_1',
    workspaceId: null,
    pipelineId: 'pipe_1',
    mode: 'incremental',
    triggeredBy: 'manual',
  })
  assert.equal(first.run.status, 'partial')
  assert.equal(first.metrics.rowsRead, 2)
  assert.equal(first.metrics.rowsCleaned, 1)
  assert.equal(first.metrics.rowsWritten, 1)
  assert.equal(first.metrics.rowsFailed, 1)
  assert.deepEqual(cleanse.adapterSystems[0].credentials, { bearerToken: 'target_1-token' }, 'runner passes decrypted target credentials to adapter')
  assert.equal(cleanse.targetRows.size, 1)
  assert.equal(Array.from(cleanse.targetRows.values())[0].FNumber, 'A-01')
  assert.equal(cleanse.db.tables.get('integration_dead_letters').length, 1)
  assert.equal(await cleanse.db.selectOne('integration_watermarks', { pipeline_id: 'pipe_1' }), null, 'failed batch does not advance watermark')

  // --- 1b. Target runtime options are passed through to the adapter ----
  let observedTargetOptions = null
  const targetOptions = createRunnerHarness({
    sourceRecords: [
      { code: 'save-01', revision: 'r1', qty: '1', name: 'Save Only', updatedAt: '2026-04-24T01:00:00.000Z' },
    ],
    pipelineOverrides: {
      options: {
        batchSize: 100,
        watermark: { type: 'updated_at', field: 'updatedAt' },
        target: { autoSubmit: false, autoAudit: false, marker: 'save-only' },
      },
    },
    targetUpsert: async (input) => {
      observedTargetOptions = input.options
      return createUpsertResult({
        written: input.records.length,
        skipped: 0,
        results: input.records.map((record) => ({ key: record._integration_idempotency_key })),
      })
    },
  })
  const targetOptionsRun = await targetOptions.runner.runPipeline({ tenantId: 'tenant_1', pipelineId: 'pipe_1', mode: 'full', triggeredBy: 'manual' })
  assert.equal(targetOptionsRun.run.status, 'succeeded')
  assert.deepEqual(observedTargetOptions, { autoSubmit: false, autoAudit: false, marker: 'save-only' })

  // --- 1c. Source runtime filters/options are passed through to adapter ---
  let observedSourceRead = null
  const sourceOptions = createRunnerHarness({
    sourceRecords: [],
    pipelineOverrides: {
      sourceObject: 'bom',
      options: {
        batchSize: 100,
        source: {
          filters: {
            productId: 'PRODUCT-TEST-001',
            revision: 'A',
          },
          productId: 'LEGACY-SHOULD-NOT-PASS',
          limit: 999,
          cursor: 'operator-cursor',
          watermark: { updatedAt: 'operator-watermark' },
          includeSubstitutes: false,
        },
      },
    },
    sourceRead: async (input) => {
      observedSourceRead = input
      return createReadResult({
        records: [
          { code: 'bom-01', revision: 'r1', qty: '1', name: 'BOM', updatedAt: '2026-04-24T01:00:00.000Z' },
        ],
        done: true,
      })
    },
  })
  const sourceOptionsRun = await sourceOptions.runner.runPipeline({ tenantId: 'tenant_1', pipelineId: 'pipe_1', mode: 'full', triggeredBy: 'manual' })
  assert.equal(sourceOptionsRun.run.status, 'succeeded')
  assert.equal(observedSourceRead.object, 'bom')
  assert.equal(observedSourceRead.limit, 100)
  assert.equal(observedSourceRead.cursor, null)
  assert.deepEqual(observedSourceRead.filters, { productId: 'PRODUCT-TEST-001', revision: 'A' })
  assert.deepEqual(observedSourceRead.options, { includeSubstitutes: false })

  const invalidSourceFilters = createRunnerHarness({
    pipelineOverrides: {
      options: {
        source: {
          filters: 'PRODUCT-TEST-001',
        },
      },
    },
  })
  await assert.rejects(
    () => invalidSourceFilters.runner.runPipeline({ tenantId: 'tenant_1', pipelineId: 'pipe_1', mode: 'full', triggeredBy: 'manual' }),
    (error) => error.name === 'PipelineRunnerError' && /pipeline\.options\.source\.filters/.test(error.details.cause),
  )

  // --- 2. Idempotency prevents duplicate target writes ------------------
  const idem = createRunnerHarness({
    sourceRecords: [
      { code: 'a-01', revision: 'r1', qty: '3', name: 'Bolt', updatedAt: '2026-04-24T01:00:00.000Z' },
    ],
  })
  const idemRun1 = await idem.runner.runPipeline({ tenantId: 'tenant_1', pipelineId: 'pipe_1', mode: 'full', triggeredBy: 'manual' })
  const idemRun2 = await idem.runner.runPipeline({ tenantId: 'tenant_1', pipelineId: 'pipe_1', mode: 'full', triggeredBy: 'manual' })
  assert.equal(idemRun1.metrics.rowsWritten, 1)
  assert.equal(idemRun2.metrics.rowsWritten, 0)
  assert.equal(idem.targetRows.size, 1)

  // --- 3. Incremental runs only read records above stored watermark ------
  const incrementalRecords = [
    { code: 'a-01', revision: 'r1', qty: '3', name: 'Bolt', updatedAt: '2026-04-24T01:00:00.000Z' },
  ]
  const incremental = createRunnerHarness({ sourceRecords: incrementalRecords })
  const incRun1 = await incremental.runner.runPipeline({ tenantId: 'tenant_1', pipelineId: 'pipe_1', mode: 'incremental', triggeredBy: 'manual' })
  assert.equal(incRun1.metrics.rowsWritten, 1)
  assert.equal((await incremental.db.selectOne('integration_watermarks', { pipeline_id: 'pipe_1' })).watermark_value, '2026-04-24T01:00:00.000Z')

  incrementalRecords.push({ code: 'b-02', revision: 'r1', qty: '4', name: 'Nut', updatedAt: '2026-04-24T02:00:00.000Z' })
  const incRun2 = await incremental.runner.runPipeline({ tenantId: 'tenant_1', pipelineId: 'pipe_1', mode: 'incremental', triggeredBy: 'manual' })
  assert.equal(incRun2.metrics.rowsRead, 1)
  assert.equal(incRun2.metrics.rowsWritten, 1)
  assert.equal((await incremental.db.selectOne('integration_watermarks', { pipeline_id: 'pipe_1' })).watermark_value, '2026-04-24T02:00:00.000Z')

  // --- 4. Dry-run previews records without target/dead-letter/watermark --
  const dryRun = createRunnerHarness({
    sourceRecords: [
      {
        code: 'a-01',
        revision: 'r1',
        qty: '3',
        name: 'Bolt',
        updatedAt: '2026-04-24T01:00:00.000Z',
        password: 'source-secret',
        headers: { Authorization: 'Bearer source-token' },
        rawPayload: { token: 'raw-token' },
      },
      { code: 'bad', revision: 'r1', qty: 'oops', name: 'Bad', updatedAt: '2026-04-24T02:00:00.000Z', token: 'bad-token' },
    ],
  })
  const dry = await dryRun.runner.runPipeline({
    tenantId: 'tenant_1',
    pipelineId: 'pipe_1',
    mode: 'incremental',
    triggeredBy: 'manual',
    dryRun: true,
    sampleLimit: 2,
  })
  assert.equal(dry.run.status, 'partial')
  assert.equal(dry.metrics.rowsRead, 2)
  assert.equal(dry.metrics.rowsCleaned, 1)
  assert.equal(dry.metrics.rowsWritten, 0)
  assert.equal(dry.metrics.rowsFailed, 1)
  assert.equal(dry.preview.records.length, 1)
  assert.equal(dry.preview.errors.length, 1)
  assert.equal(dry.preview.records[0].source.password, '[redacted]')
  assert.equal(dry.preview.records[0].source.headers.Authorization, '[redacted]')
  assert.equal(dry.preview.records[0].source.rawPayload, '[redacted]')
  assert.equal(dry.preview.errors[0].sourcePayload.token, '[redacted]')
  assert.equal(dryRun.targetRows.size, 0, 'dry-run does not write target')
  assert.equal(dryRun.db.tables.get('integration_dead_letters').length, 0, 'dry-run does not create dead letters')
  assert.equal(await dryRun.db.selectOne('integration_watermarks', { pipeline_id: 'pipe_1' }), null, 'dry-run does not advance watermark')

  // --- 4b. Idempotency failures are per-record dead letters -------------
  const noId = createRunnerHarness({
    sourceRecords: [
      { code: 'a-01', revision: 'r1', qty: '3', name: 'Bolt', updatedAt: '2026-04-24T01:00:00.000Z' },
    ],
    pipelineOverrides: {
      idempotencyKeyFields: ['missingId', 'revision'],
    },
  })
  const noIdRun = await noId.runner.runPipeline({ tenantId: 'tenant_1', pipelineId: 'pipe_1', mode: 'full', triggeredBy: 'manual' })
  assert.equal(noIdRun.run.status, 'partial')
  assert.equal(noIdRun.metrics.rowsFailed, 1)
  assert.equal(noId.db.tables.get('integration_dead_letters')[0].error_code, 'IDEMPOTENCY_FAILED')

  // --- 4c. Target failures without item errors create an aggregate dead letter
  const targetFailed = createRunnerHarness({
    sourceRecords: [
      { code: 'x-01', revision: 'r1', qty: '3', name: 'Bolt', updatedAt: '2026-04-24T01:00:00.000Z' },
      { code: 'x-02', revision: 'r1', qty: '4', name: 'Nut', updatedAt: '2026-04-24T02:00:00.000Z' },
      { code: 'x-03', revision: 'r1', qty: '5', name: 'Washer', updatedAt: '2026-04-24T03:00:00.000Z' },
    ],
    targetUpsert: async () => createUpsertResult({ written: 0, failed: 3, errors: [] }),
  })
  const targetFailedRun = await targetFailed.runner.runPipeline({ tenantId: 'tenant_1', pipelineId: 'pipe_1', mode: 'full', triggeredBy: 'manual' })
  assert.equal(targetFailedRun.run.status, 'partial')
  assert.equal(targetFailedRun.metrics.rowsFailed, 3)
  assert.equal(targetFailed.db.tables.get('integration_dead_letters').length, 1)
  assert.equal(targetFailed.db.tables.get('integration_dead_letters')[0].error_code, 'TARGET_WRITE_AGGREGATE_FAILED')
  assert.equal(targetFailed.db.tables.get('integration_dead_letters')[0].source_payload.failed, 3)

  // --- 4c.1. Adapter under-report creates aggregate failure and blocks watermark
  const underReported = createRunnerHarness({
    sourceRecords: [
      { code: 'ur-01', revision: 'r1', qty: '3', name: 'Bolt', updatedAt: '2026-04-24T01:00:00.000Z' },
      { code: 'ur-02', revision: 'r1', qty: '4', name: 'Nut', updatedAt: '2026-04-24T02:00:00.000Z' },
    ],
    targetUpsert: async () => createUpsertResult({ written: 1, failed: 0, errors: [] }),
  })
  const underReportedRun = await underReported.runner.runPipeline({ tenantId: 'tenant_1', pipelineId: 'pipe_1', mode: 'incremental', triggeredBy: 'manual' })
  assert.equal(underReportedRun.run.status, 'partial')
  assert.equal(underReportedRun.metrics.rowsWritten, 1)
  assert.equal(underReportedRun.metrics.rowsFailed, 1)
  assert.equal(underReported.db.tables.get('integration_dead_letters').length, 1)
  assert.equal(underReported.db.tables.get('integration_dead_letters')[0].error_code, 'TARGET_WRITE_AGGREGATE_FAILED')
  assert.equal(underReported.db.tables.get('integration_dead_letters')[0].source_payload.unaccountedFailed, 1)
  assert.equal(await underReported.db.selectOne('integration_watermarks', { pipeline_id: 'pipe_1' }), null, 'under-reported target result does not advance watermark')

  // --- 4c.1. Adapter errors count as failed even if failed=0 ------------
  const errorOnly = createRunnerHarness({
    sourceRecords: [
      { code: 'err-01', revision: 'r1', qty: '3', name: 'Bolt', updatedAt: '2026-04-24T01:00:00.000Z' },
    ],
    targetUpsert: async (input) => createUpsertResult({
      written: 0,
      failed: 0,
      errors: [
        {
          key: input.records[0]._integration_idempotency_key,
          code: 'ERP_REJECTED',
          message: 'business rule rejected',
        },
      ],
    }),
  })
  const errorOnlyRun = await errorOnly.runner.runPipeline({ tenantId: 'tenant_1', pipelineId: 'pipe_1', mode: 'incremental', triggeredBy: 'manual' })
  assert.equal(errorOnlyRun.run.status, 'partial')
  assert.equal(errorOnlyRun.metrics.rowsFailed, 1)
  assert.equal(errorOnly.db.tables.get('integration_dead_letters')[0].error_code, 'ERP_REJECTED')
  assert.equal(await errorOnly.db.selectOne('integration_watermarks', { pipeline_id: 'pipe_1' }), null, 'error-only target result does not advance watermark')

  // --- 4c.2. Itemized plus aggregate failures preserve replay evidence ---
  const mixedFailure = createRunnerHarness({
    sourceRecords: [
      { code: 'mix-01', revision: 'r1', qty: '3', name: 'Bolt', updatedAt: '2026-04-24T01:00:00.000Z' },
      { code: 'mix-02', revision: 'r1', qty: '4', name: 'Nut', updatedAt: '2026-04-24T02:00:00.000Z' },
    ],
    targetUpsert: async (input) => createUpsertResult({
      written: 0,
      failed: 2,
      errors: [
        {
          key: input.records[0]._integration_idempotency_key,
          code: 'ERP_REJECTED',
          message: 'business rule rejected',
        },
      ],
    }),
  })
  const mixedFailureRun = await mixedFailure.runner.runPipeline({ tenantId: 'tenant_1', pipelineId: 'pipe_1', mode: 'incremental', triggeredBy: 'manual' })
  assert.equal(mixedFailureRun.run.status, 'partial')
  assert.equal(mixedFailureRun.metrics.rowsFailed, 2)
  assert.deepEqual(
    mixedFailure.db.tables.get('integration_dead_letters').map((row) => row.error_code),
    ['ERP_REJECTED', 'TARGET_WRITE_AGGREGATE_FAILED'],
  )
  assert.equal(mixedFailure.db.tables.get('integration_dead_letters')[1].source_payload.failed, 1)
  assert.equal(await mixedFailure.db.selectOne('integration_watermarks', { pipeline_id: 'pipe_1' }), null, 'mixed target failures do not advance watermark')

  // --- 4c.2. Unmatched target errors do not bind to the first record ----
  const unmatched = createRunnerHarness({
    sourceRecords: [
      { code: 'u-01', revision: 'r1', qty: '3', name: 'Bolt', updatedAt: '2026-04-24T01:00:00.000Z' },
      { code: 'u-02', revision: 'r1', qty: '4', name: 'Nut', updatedAt: '2026-04-24T02:00:00.000Z' },
    ],
    targetUpsert: async () => createUpsertResult({
      written: 0,
      failed: 0,
      errors: [
        {
          key: 'missing-key',
          code: 'ERP_UNKNOWN_RECORD',
          message: 'not mapped',
          record: { FNumber: 'remote-only', password: 'remote-secret' },
        },
      ],
    }),
  })
  await unmatched.runner.runPipeline({ tenantId: 'tenant_1', pipelineId: 'pipe_1', mode: 'full', triggeredBy: 'manual' })
  const unmatchedLetter = unmatched.db.tables.get('integration_dead_letters')[0]
  assert.equal(unmatchedLetter.error_code, 'TARGET_WRITE_UNMATCHED_ERROR')
  assert.equal(unmatchedLetter.source_payload.adapterError, true)
  assert.equal(unmatchedLetter.source_payload.key, 'missing-key')
  assert.equal(unmatchedLetter.transformed_payload.password, '[redacted]')

  // --- 4d. ERP feedback writes target result summaries after upsert ----
  const feedbackCalls = []
  const feedback = createRunnerHarness({
    sourceRecords: [
      { code: 'k3-01', revision: 'r1', qty: '3', name: 'Bolt', updatedAt: '2026-04-24T01:00:00.000Z' },
    ],
    targetUpsert: async (input) => createUpsertResult({
      written: 1,
      failed: 0,
      results: [
        {
          key: input.records[0]._integration_idempotency_key,
          externalId: 'k3_item_1',
          billNo: 'K3-BILL-001',
          responseMessage: 'saved',
        },
      ],
    }),
    erpFeedbackWriter: {
      async writeBack(input) {
        feedbackCalls.push(input)
        return {
          ok: true,
          skipped: false,
          projectId: input.pipeline.projectId,
          objectId: 'standard_materials',
          keyField: '_integration_idempotency_key',
          items: [
            { key: input.writeResult.results[0].key, fields: { erpSyncStatus: 'synced' } },
          ],
          result: { written: 1 },
        }
      },
    },
  })
  const feedbackRun = await feedback.runner.runPipeline({ tenantId: 'tenant_1', pipelineId: 'pipe_1', mode: 'full', triggeredBy: 'manual' })
  assert.equal(feedbackCalls.length, 1)
  assert.equal(feedbackCalls[0].pipeline.id, 'pipe_1')
  assert.equal(feedbackCalls[0].runId, feedbackRun.run.id)
  assert.equal(feedbackCalls[0].cleanRecords.length, 1)
  assert.equal(feedbackCalls[0].writeResult.results[0].externalId, 'k3_item_1')
  assert.deepEqual(feedbackRun.run.details.erpFeedback, [
    {
      ok: true,
      skipped: false,
      reason: null,
      projectId: 'project_1',
      objectId: 'standard_materials',
      keyField: '_integration_idempotency_key',
      items: 1,
      written: 1,
    },
  ])

  // --- 4e. Dry-run sampleLimit is a total cap across pages --------------
  let page = 0
  const pagedDryRun = createRunnerHarness({
    sourceRecords: [],
    sourceRead: async () => {
      page += 1
      return createReadResult({
        records: [
          { code: `p-${page}-1`, revision: 'r1', qty: '3', name: 'Bolt', updatedAt: `2026-04-24T0${page}:00:00.000Z` },
          { code: `p-${page}-2`, revision: 'r1', qty: '3', name: 'Nut', updatedAt: `2026-04-24T0${page}:10:00.000Z` },
        ],
        nextCursor: page < 3 ? `cursor-${page + 1}` : null,
        done: page >= 3,
      })
    },
  })
  const limitedDryRun = await pagedDryRun.runner.runPipeline({
    tenantId: 'tenant_1',
    pipelineId: 'pipe_1',
    mode: 'incremental',
    triggeredBy: 'manual',
    dryRun: true,
    sampleLimit: 2,
  })
  assert.equal(limitedDryRun.metrics.rowsRead, 2)
  assert.equal(page, 1, 'dry-run stops once total sampleLimit is reached')

  // --- 5. Replay processes dead-letter source payload and marks replayed -
  const replay = createRunnerHarness({
    sourceRecords: [],
  })
  const deadLetterStore = createDeadLetterStore({ db: replay.db, idGenerator: () => 'dl_1' })
  await deadLetterStore.createDeadLetter({
    tenantId: 'tenant_1',
    workspaceId: null,
    runId: 'run_original',
    pipelineId: 'pipe_1',
    sourcePayload: { code: 'c-03', revision: 'r2', qty: '5', name: 'Washer', updatedAt: '2026-04-24T03:00:00.000Z' },
    transformedPayload: null,
    errorCode: 'VALIDATION_FAILED',
    errorMessage: 'old mapping failed',
  })
  const replayed = await replay.runner.replayDeadLetter({
    tenantId: 'tenant_1',
    workspaceId: null,
    id: 'dl_1',
  })
  assert.equal(replayed.deadLetter.status, 'replayed')
  assert.equal(replayed.replay.metrics.rowsWritten, 1)
  assert.equal(replay.targetRows.size, 1)

  const truncatedReplay = createRunnerHarness({
    sourceRecords: [],
  })
  const truncatedStore = createDeadLetterStore({ db: truncatedReplay.db, idGenerator: () => 'dl_truncated' })
  await truncatedStore.createDeadLetter({
    tenantId: 'tenant_1',
    workspaceId: null,
    runId: 'run_original',
    pipelineId: 'pipe_1',
    sourcePayload: {
      code: 'big-01',
      revision: 'r1',
      qty: '5',
      name: 'Big',
      details: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`field_${index}`, 'x'.repeat(2000)])),
    },
    transformedPayload: null,
    errorCode: 'VALIDATION_FAILED',
    errorMessage: 'large payload failed',
  })
  const replayError = await truncatedReplay.runner.replayDeadLetter({
    tenantId: 'tenant_1',
    workspaceId: null,
    id: 'dl_truncated',
  }).catch((error) => error)
  assert.equal(replayError.name, 'PipelineRunnerError')
  assert.equal(replayError.details.reason, 'PAYLOAD_TRUNCATED')
  assert.equal(truncatedReplay.targetRows.size, 0, 'truncated replay is rejected before target write')

  // --- 5b. null / non-object sourcePayload is rejected before target write -
  // createDeadLetter validates sourcePayload is non-null, so simulate rows
  // that arrive with corrupted payloads via direct DB table injection.
  for (const [label, badPayload, expectedReason] of [
    ['null', null, 'NULL_PAYLOAD'],
    ['undefined', undefined, 'NULL_PAYLOAD'],
    ['array', [{ code: 'x' }], 'INVALID_PAYLOAD_TYPE'],
    ['string', 'raw-value', 'INVALID_PAYLOAD_TYPE'],
    ['number', 42, 'INVALID_PAYLOAD_TYPE'],
  ]) {
    const badPayloadHarness = createRunnerHarness({ sourceRecords: [] })
    const badStore = createDeadLetterStore({
      db: badPayloadHarness.db,
      idGenerator: () => `dl_bad_${label}`,
    })
    // Inject a row directly into the DB table to bypass createDeadLetter validation
    badPayloadHarness.db.tables.get('integration_dead_letters').push({
      id: `dl_bad_${label}`,
      tenant_id: 'tenant_1',
      workspace_id: null,
      run_id: 'run_original',
      pipeline_id: 'pipe_1',
      source_payload: badPayload,
      transformed_payload: null,
      error_code: 'VALIDATION_FAILED',
      error_message: `bad payload: ${label}`,
      retry_count: 0,
      status: 'open',
      created_at: '2026-04-26T00:00:00.000Z',
      updated_at: '2026-04-26T00:00:00.000Z',
    })
    const badError = await badPayloadHarness.runner.replayDeadLetter({
      tenantId: 'tenant_1',
      workspaceId: null,
      id: `dl_bad_${label}`,
    }).catch((error) => error)
    assert.equal(badError.name, 'PipelineRunnerError',
      `${label} payload rejected with PipelineRunnerError`)
    assert.equal(badError.details.reason, expectedReason,
      `${label} payload reason is ${expectedReason}`)
    assert.equal(badPayloadHarness.targetRows.size, 0,
      `${label} payload is rejected before any target write`)
  }

  // --- 5c. markReplayed failure after successful replay does not throw ----
  // If markReplayed fails (DB down at cleanup time), the replay already wrote to ERP.
  // Throwing would cause the caller to retry → duplicate ERP write. Instead, return
  // a structured result with a warning so the caller knows the bookkeeping is inconsistent.
  {
    const markFailDb = createMockDb()
    const realDeadLetterStore = createDeadLetterStore({ db: markFailDb, idGenerator: () => 'dl_mark_fail' })
    await realDeadLetterStore.createDeadLetter({
      tenantId: 'tenant_1',
      workspaceId: null,
      runId: 'run_original',
      pipelineId: 'pipe_1',
      sourcePayload: { code: 'c-mark', revision: 'r1', qty: '5', name: 'Screw', updatedAt: '2026-04-24T04:00:00.000Z' },
      transformedPayload: null,
      errorCode: 'VALIDATION_FAILED',
      errorMessage: 'original failure',
    })
    // Wrap the store: getDeadLetter works, markReplayed always throws
    const throwingMarkStore = {
      ...realDeadLetterStore,
      async markReplayed() {
        throw new Error('DB connection lost — cannot mark dead letter replayed')
      },
    }
    const markFailTargetRows = new Map()
    const markFailRunner = createPipelineRunner({
      pipelineRegistry: createPipelineRegistry(
        { ...createRunnerHarness({ sourceRecords: [] }).pipeline },
        markFailDb
      ),
      externalSystemRegistry: createExternalSystemRegistry(),
      adapterRegistry: createAdapterRegistry()
        .registerAdapter('mock-source', () => ({
          async testConnection() { return { ok: true } },
          async listObjects() { return [] },
          async getSchema() { return { fields: [] } },
          async read() { return createReadResult({ records: [] }) },
          async upsert() { throw new Error('source upsert should not be called') },
        }))
        .registerAdapter('mock-target', () => ({
          async testConnection() { return { ok: true } },
          async listObjects() { return [] },
          async getSchema() { return { fields: [] } },
          async read() { return createReadResult({ records: [] }) },
          async upsert(input) {
            for (const record of input.records) {
              markFailTargetRows.set(record._integration_idempotency_key, record)
            }
            return createUpsertResult({ written: input.records.length, skipped: 0, results: input.records.map((r) => ({ key: r._integration_idempotency_key })) })
          },
        })),
      deadLetterStore: throwingMarkStore,
      watermarkStore: createWatermarkStore({ db: markFailDb }),
      runLogger: createRunLogger({ pipelineRegistry: createPipelineRegistry(
        { ...createRunnerHarness({ sourceRecords: [] }).pipeline },
        markFailDb
      ) }),
    })
    const markFailResult = await markFailRunner.replayDeadLetter({
      tenantId: 'tenant_1',
      workspaceId: null,
      id: 'dl_mark_fail',
    })
    assert.equal(markFailTargetRows.size, 1, 'ERP write succeeded despite markReplayed failure')
    assert.ok(markFailResult.warning, 'result includes a warning when markReplayed fails')
    assert.equal(markFailResult.warning.code, 'MARK_REPLAYED_FAILED', 'warning code identifies the failure')
    assert.match(markFailResult.warning.message, /DB connection lost/, 'warning message includes original error')
    assert.equal(markFailResult.deadLetter.status, 'open', 'dead letter status remains open when marking failed')
    assert.ok(markFailResult.replay.metrics.rowsWritten >= 1, 'replay metrics confirm write happened')
  }

  // --- 6. Dead-letter status guard — already-replayed letter is rejected --
  // The first replay in scenario 5 left dl_1 in status='replayed'. A second
  // replay attempt must throw before any ERP call happens.
  const doubleReplay = await replay.runner.replayDeadLetter({
    tenantId: 'tenant_1',
    workspaceId: null,
    id: 'dl_1',
  }).catch((error) => error)
  assert.equal(doubleReplay.name, 'PipelineRunnerError', 'double-replay rejected with PipelineRunnerError')
  assert.match(doubleReplay.message, /status is not open/, 'error message identifies the problem')
  assert.equal(doubleReplay.details.status, 'replayed', 'error details include current status')
  assert.equal(doubleReplay.details.id, 'dl_1', 'error details include dead letter id')
  assert.equal(replay.targetRows.size, 1, 'target unchanged after rejected double-replay')

  // Discarded dead letter is also rejected
  const discardHarness = createRunnerHarness({ sourceRecords: [] })
  const discardStore = createDeadLetterStore({ db: discardHarness.db, idGenerator: () => 'dl_discarded' })
  await discardStore.createDeadLetter({
    tenantId: 'tenant_1',
    workspaceId: null,
    runId: 'run_original',
    pipelineId: 'pipe_1',
    sourcePayload: { code: 'c-04', revision: 'r1', qty: '1', name: 'Nut', updatedAt: '2026-04-24T04:00:00.000Z' },
    errorCode: 'VALIDATION_FAILED',
    errorMessage: 'failed',
    status: 'discarded',
  })
  const discardReplay = await discardHarness.runner.replayDeadLetter({
    tenantId: 'tenant_1',
    workspaceId: null,
    id: 'dl_discarded',
  }).catch((error) => error)
  assert.equal(discardReplay.name, 'PipelineRunnerError', 'discarded letter replay rejected')
  assert.equal(discardReplay.details.status, 'discarded', 'error details include discarded status')
  assert.equal(discardHarness.targetRows.size, 0, 'target unchanged after rejected discarded-letter replay')

  // --- 7. finishRun failure does not mask original pipeline error ----------
  // If finishRun itself throws (e.g. DB is down at the moment of failure),
  // the caller must still see the ORIGINAL pipeline error, not the DB error.
  {
    const failingDb = createMockDb()
    const failingPipelineRegistry = createPipelineRegistry(
      { ...createRunnerHarness({ sourceRecords: [] }).pipeline },
      failingDb
    )
    // Build a runLogger where finishRun always throws a secondary DB error
    const throwingRunLogger = {
      async startRun(input) {
        const id = 'run_fail_test'
        const row = {
          id,
          tenant_id: input.tenantId,
          workspace_id: input.workspaceId ?? null,
          pipeline_id: input.pipelineId,
          mode: input.mode,
          triggered_by: input.triggeredBy,
          status: input.status,
          rows_read: 0,
          rows_cleaned: 0,
          rows_written: 0,
          rows_failed: 0,
          started_at: input.startedAt || null,
          details: input.details || {},
        }
        await failingDb.insertOne('integration_runs', row)
        return { id, tenantId: input.tenantId, workspaceId: input.workspaceId ?? null, pipelineId: input.pipelineId, status: 'running', details: {} }
      },
      async finishRun() {
        throw new Error('DB connection lost — cannot update run status')
      },
    }
    const failRunner = createPipelineRunner({
      pipelineRegistry: failingPipelineRegistry,
      externalSystemRegistry: createExternalSystemRegistry(),
      adapterRegistry: createAdapterRegistry()
        .registerAdapter('mock-source', () => ({
          async testConnection() { return { ok: true } },
          async listObjects() { return [] },
          async getSchema() { return { fields: [] } },
          async read() { throw new Error('source read failed: network timeout') },
          async upsert() { throw new Error('source upsert should not be called') },
        }))
        .registerAdapter('mock-target', () => ({
          async testConnection() { return { ok: true } },
          async listObjects() { return [] },
          async getSchema() { return { fields: [] } },
          async read() { return createReadResult({ records: [] }) },
          async upsert() { return createUpsertResult({ written: 0, skipped: 0, results: [] }) },
        })),
      deadLetterStore: createDeadLetterStore({ db: failingDb }),
      watermarkStore: createWatermarkStore({ db: failingDb }),
      runLogger: throwingRunLogger,
    })
    const originalError = await failRunner.runPipeline({
      tenantId: 'tenant_1',
      pipelineId: 'pipe_1',
      mode: 'manual',
      triggeredBy: 'api',
    }).catch((error) => error)
    assert.equal(originalError.name, 'PipelineRunnerError', 'error is PipelineRunnerError even when finishRun throws')
    assert.match(originalError.details.cause, /source read failed/, 'original pipeline error preserved in cause')
    assert.doesNotMatch(originalError.message + (originalError.details.cause || ''), /DB connection lost/, 'secondary finishRun error is suppressed')
  }

  // --- 11. dryRun string coercion (REST API hand-typed booleans) ---------
  {
    const stringDry = createRunnerHarness({
      sourceRecords: [
        { code: 'a-01', revision: 'r1', qty: '3', name: 'Bolt', updatedAt: '2026-04-24T01:00:00.000Z' },
      ],
    })
    const result = await stringDry.runner.runPipeline({
      tenantId: 'tenant_1',
      pipelineId: 'pipe_1',
      mode: 'incremental',
      triggeredBy: 'manual',
      dryRun: 'true',  // STRING — would previously fall through to LIVE run via strict ===
      sampleLimit: 1,
    })
    assert.equal(stringDry.targetRows.size, 0, 'dryRun: "true" (string) must NOT write to target')
    assert.equal(stringDry.db.tables.get('integration_dead_letters').length, 0, 'dryRun: "true" (string) must NOT create dead letters')
    assert.equal(await stringDry.db.selectOne('integration_watermarks', { pipeline_id: 'pipe_1' }), null, 'dryRun: "true" (string) must NOT advance watermark')
    assert.ok(result.preview, 'dryRun: "true" (string) must produce preview object')
    assert.equal(result.preview.records.length, 1, 'preview captured the cleaned record')
  }

  // --- 12. dryRun numeric 1 / Chinese "是" also work ---------------------
  for (const truthyVariant of [1, '是', 'YES', 'on']) {
    const harness = createRunnerHarness({
      sourceRecords: [
        { code: 'a-01', revision: 'r1', qty: '3', name: 'Bolt', updatedAt: '2026-04-24T01:00:00.000Z' },
      ],
    })
    await harness.runner.runPipeline({
      tenantId: 'tenant_1',
      pipelineId: 'pipe_1',
      mode: 'incremental',
      triggeredBy: 'manual',
      dryRun: truthyVariant,
      sampleLimit: 1,
    })
    assert.equal(
      harness.targetRows.size,
      0,
      `dryRun: ${JSON.stringify(truthyVariant)} must be honored as truthy and NOT write to target`,
    )
  }

  // --- 13. dryRun explicit "false" / 0 / "否" → real run ------------------
  for (const falsyVariant of [false, 'false', 0, '否', '']) {
    const harness = createRunnerHarness({
      sourceRecords: [
        { code: 'a-01', revision: 'r1', qty: '3', name: 'Bolt', updatedAt: '2026-04-24T01:00:00.000Z' },
      ],
    })
    await harness.runner.runPipeline({
      tenantId: 'tenant_1',
      pipelineId: 'pipe_1',
      mode: 'incremental',
      triggeredBy: 'manual',
      dryRun: falsyVariant,
      sampleLimit: 1,
    })
    assert.equal(
      harness.targetRows.size,
      1,
      `dryRun: ${JSON.stringify(falsyVariant)} should be falsy → live run writes 1 row`,
    )
  }

  // --- 14. dryRun "maybe" (unknown) throws PipelineRunnerError -----------
  {
    const harness = createRunnerHarness({
      sourceRecords: [
        { code: 'a-01', revision: 'r1', qty: '3', name: 'Bolt', updatedAt: '2026-04-24T01:00:00.000Z' },
      ],
    })
    const error = await harness.runner.runPipeline({
      tenantId: 'tenant_1',
      pipelineId: 'pipe_1',
      mode: 'incremental',
      triggeredBy: 'manual',
      dryRun: 'maybe',
    }).catch((err) => err)
    assert.equal(error.name, 'PipelineRunnerError', 'unknown string for dryRun should throw PipelineRunnerError')
    assert.equal(error.details.field, 'input.dryRun', 'error includes the field name')
  }

  // --- 15. allowInactive string coercion: inactive pipeline + "true" runs ---
  {
    const inactive = createRunnerHarness({
      sourceRecords: [
        { code: 'a-01', revision: 'r1', qty: '3', name: 'Bolt', updatedAt: '2026-04-24T01:00:00.000Z' },
      ],
      pipelineOverrides: { status: 'paused' },
    })

    // Without allowInactive: rejected
    const rejected = await inactive.runner.runPipeline({
      tenantId: 'tenant_1',
      pipelineId: 'pipe_1',
      mode: 'incremental',
      triggeredBy: 'manual',
    }).catch((err) => err)
    assert.equal(rejected.name, 'PipelineRunnerError', 'paused pipeline rejected when allowInactive unset')
    assert.equal(rejected.message, 'pipeline is not active')

    // With allowInactive: "true" (string) — must allow the run
    const allowed = await inactive.runner.runPipeline({
      tenantId: 'tenant_1',
      pipelineId: 'pipe_1',
      mode: 'incremental',
      triggeredBy: 'manual',
      allowInactive: 'true',  // STRING — would previously be rejected via strict !== true
    })
    assert.ok(allowed.run, 'allowInactive: "true" (string) lets the inactive pipeline run')
    assert.equal(allowed.metrics.rowsRead, 1, 'inactive pipeline with allowInactive: "true" reads source')
  }

  // --- 16. allowInactive Chinese "是" / numeric 1 also work --------------
  for (const truthyVariant of ['是', 1, 'YES']) {
    const inactive = createRunnerHarness({
      sourceRecords: [
        { code: 'a-01', revision: 'r1', qty: '3', name: 'Bolt', updatedAt: '2026-04-24T01:00:00.000Z' },
      ],
      pipelineOverrides: { status: 'paused' },
    })
    const result = await inactive.runner.runPipeline({
      tenantId: 'tenant_1',
      pipelineId: 'pipe_1',
      mode: 'incremental',
      triggeredBy: 'manual',
      allowInactive: truthyVariant,
    })
    assert.ok(result.run, `allowInactive: ${JSON.stringify(truthyVariant)} lets the inactive pipeline run`)
  }

  // --- 17. abandonStaleRuns called before run and is best-effort ----------
  {
    const staleDb = createMockDb()
    const stalePipeline = {
      id: 'pipe_1', tenantId: 'tenant_1', workspaceId: null, projectId: 'project_1',
      sourceSystemId: 'source_1', sourceObject: 'materials',
      targetSystemId: 'target_1', targetObject: 'BD_MATERIAL',
      mode: 'manual', status: 'active',
      idempotencyKeyFields: ['code', 'revision'],
      options: { batchSize: 100 },
      fieldMappings: [
        { sourceField: 'code', targetField: 'FNumber', transform: ['trim', 'upper'], validation: [{ type: 'required' }] },
        { sourceField: 'qty', targetField: 'FQty', transform: { fn: 'toNumber' }, validation: [{ type: 'min', value: 1 }] },
        { sourceField: 'name', targetField: 'FName', transform: { fn: 'trim' }, validation: [{ type: 'required' }] },
      ],
    }
    const staleSourceRecord = { code: 'a-01', revision: 'r1', qty: '3', name: 'Bolt', updatedAt: '2026-04-24T01:00:00.000Z' }
    const staleAdapterRegistry = createAdapterRegistry()
      .registerAdapter('mock-source', () => ({
        async testConnection() { return { ok: true } },
        async listObjects() { return [] },
        async getSchema() { return { fields: [] } },
        async read() { return createReadResult({ records: [staleSourceRecord] }) },
        async upsert() { throw new Error('should not upsert on source') },
      }))
      .registerAdapter('mock-target', () => ({
        async testConnection() { return { ok: true } },
        async listObjects() { return [] },
        async getSchema() { return { fields: [] } },
        async read() { return createReadResult({ records: [] }) },
        async upsert(input) { return createUpsertResult({ written: input.records.length, skipped: 0, results: [] }) },
      }))

    function buildRunner(registryExtension = {}) {
      const registry = { ...createPipelineRegistry(stalePipeline, staleDb), ...registryExtension }
      return createPipelineRunner({
        pipelineRegistry: registry,
        externalSystemRegistry: createExternalSystemRegistry(),
        adapterRegistry: staleAdapterRegistry,
        deadLetterStore: createDeadLetterStore({ db: staleDb }),
        watermarkStore: createWatermarkStore({ db: staleDb }),
        runLogger: createRunLogger({ pipelineRegistry: registry }),
      })
    }

    // 17a: abandonStaleRuns is called with correct tenant/pipeline context
    const abandonCalls = []
    const runnerWithAbandon = buildRunner({
      async abandonStaleRuns(input) { abandonCalls.push(input); return [] },
    })
    await runnerWithAbandon.runPipeline({ tenantId: 'tenant_1', pipelineId: 'pipe_1', mode: 'manual', triggeredBy: 'api' })
    assert.equal(abandonCalls.length, 1, 'abandonStaleRuns called once before run')
    assert.equal(abandonCalls[0].tenantId, 'tenant_1', 'abandonStaleRuns receives tenantId')
    assert.equal(abandonCalls[0].pipelineId, 'pipe_1', 'abandonStaleRuns receives pipelineId')

    // 17b: abandonStaleRuns throws -> pipeline still runs (best-effort protection)
    const resilientRunner = buildRunner({
      async abandonStaleRuns() { throw new Error('DB connection lost during stale-run cleanup') },
    })
    const resilientResult = await resilientRunner.runPipeline({
      tenantId: 'tenant_1', pipelineId: 'pipe_1', mode: 'manual', triggeredBy: 'api',
    })
    assert.ok(resilientResult.run, 'pipeline run succeeds even when abandonStaleRuns throws')
    assert.equal(resilientResult.metrics.rowsRead, 1, 'pipeline reads source despite cleanup failure')

    // 17c: registry without abandonStaleRuns (typeof check) -> no TypeError
    const plainRunner = buildRunner()
    const plainResult = await plainRunner.runPipeline({
      tenantId: 'tenant_1', pipelineId: 'pipe_1', mode: 'manual', triggeredBy: 'api',
    })
    assert.ok(plainResult.run, 'pipeline runs fine when registry has no abandonStaleRuns')
  }

  // --- 18. finishRun failure in success path returns warning, not error ----
  {
    const db18 = createMockDb()
    const pipeline18 = {
      id: 'pipe_1', tenantId: 'tenant_1', workspaceId: null, projectId: 'project_1',
      sourceSystemId: 'source_1', sourceObject: 'materials',
      targetSystemId: 'target_1', targetObject: 'BD_MATERIAL',
      mode: 'manual', status: 'active',
      idempotencyKeyFields: ['code', 'revision'],
      options: { batchSize: 100 },
      fieldMappings: [
        { sourceField: 'code', targetField: 'FNumber', transform: ['trim', 'upper'], validation: [{ type: 'required' }] },
        { sourceField: 'name', targetField: 'FName', transform: { fn: 'trim' }, validation: [{ type: 'required' }] },
      ],
    }
    const targetRows18 = new Map()
    const adapterRegistry18 = createAdapterRegistry()
      .registerAdapter('mock-source', () => ({
        async testConnection() { return { ok: true } },
        async listObjects() { return [] },
        async getSchema() { return { fields: [] } },
        async read() {
          return createReadResult({ records: [
            { code: 'mat-01', revision: 'r1', name: 'Bolt', updatedAt: '2026-04-24T01:00:00.000Z' },
          ] })
        },
        async upsert() { throw new Error('source upsert should not be called') },
      }))
      .registerAdapter('mock-target', () => ({
        async testConnection() { return { ok: true } },
        async listObjects() { return [] },
        async getSchema() { return { fields: [] } },
        async read() { return createReadResult({ records: [] }) },
        async upsert(input) {
          for (const record of input.records) targetRows18.set(record._integration_idempotency_key, record)
          return createUpsertResult({ written: input.records.length, skipped: 0, results: [] })
        },
      }))

    function buildRunner18(pipelineRegistryOverride = {}) {
      const registry = { ...createPipelineRegistry(pipeline18, db18), ...pipelineRegistryOverride }
      return createPipelineRunner({
        pipelineRegistry: registry,
        externalSystemRegistry: createExternalSystemRegistry(),
        adapterRegistry: adapterRegistry18,
        deadLetterStore: createDeadLetterStore({ db: db18 }),
        watermarkStore: createWatermarkStore({ db: db18 }),
        runLogger: createRunLogger({ pipelineRegistry: registry }),
      })
    }

    // 18a: finishRun throws (DB down) after ERP write -> returns warning, not error
    const throwingRunner = buildRunner18({
      async updatePipelineRun() {
        throw new Error('DB connection lost after ERP write')
      },
    })
    const warnResult = await throwingRunner.runPipeline({
      tenantId: 'tenant_1', pipelineId: 'pipe_1', mode: 'manual', triggeredBy: 'api',
    })
    assert.ok(warnResult.run, 'result.run is present even when finishRun throws')
    assert.equal(warnResult.metrics.rowsWritten, 1, 'ERP write completed before finishRun threw')
    assert.ok(warnResult.warning, 'warning field present when finishRun fails')
    assert.equal(warnResult.warning.code, 'FINISH_RUN_FAILED', 'warning code is FINISH_RUN_FAILED')
    assert.equal(typeof warnResult.warning.message, 'string', 'warning message is a string')
    assert.equal(targetRows18.size, 1, 'target record was written despite finishRun failure')

    // 18b: normal finishRun (no override) — no warning field
    const normalRunner = buildRunner18()
    const normalResult = await normalRunner.runPipeline({
      tenantId: 'tenant_1', pipelineId: 'pipe_1', mode: 'manual', triggeredBy: 'api',
    })
    assert.ok(normalResult.run, 'normal result has run')
    assert.equal(normalResult.run.status, 'succeeded', 'run status is succeeded')
    assert.equal(normalResult.warning, undefined, 'no warning when finishRun succeeds')
  }

  // --- 19. maxPagesReached signal in run details when cap exhausted ---------
  {
    // Source returns 3 pages of records; pipeline maxPages=2 → cap hit, more data unread
    let cappedPage = 0
    const cappedHarness = createRunnerHarness({
      sourceRecords: [],
      pipelineOverrides: { options: { batchSize: 100, maxPages: 2 } },
      sourceRead: async () => {
        cappedPage += 1
        return createReadResult({
          records: [
            { code: `cap-${cappedPage}-1`, revision: 'r1', qty: '1', name: 'Bolt', updatedAt: `2026-04-24T0${cappedPage}:00:00.000Z` },
          ],
          nextCursor: cappedPage < 3 ? `cursor-${cappedPage + 1}` : null,
          done: cappedPage >= 3,
        })
      },
    })
    const cappedResult = await cappedHarness.runner.runPipeline({
      tenantId: 'tenant_1', pipelineId: 'pipe_1', mode: 'incremental', triggeredBy: 'manual',
    })
    assert.equal(cappedResult.run.details.maxPagesReached, true,
      'maxPagesReached=true when source has more data and page cap is hit')
    assert.equal(cappedResult.run.details.pagesProcessed, 2,
      'pagesProcessed reflects the number of pages read')
    assert.equal(cappedPage, 2, 'source read called exactly maxPages times')

    // Source returns 1 page (done=true) → maxPagesReached=false, exited normally
    let normalPage = 0
    const normalHarness = createRunnerHarness({
      sourceRecords: [],
      pipelineOverrides: { options: { batchSize: 100, maxPages: 5 } },
      sourceRead: async () => {
        normalPage += 1
        return createReadResult({
          records: [
            { code: `n-${normalPage}-1`, revision: 'r1', qty: '1', name: 'Bolt', updatedAt: `2026-04-24T01:00:00.000Z` },
          ],
          nextCursor: null,
          done: true,
        })
      },
    })
    const normalResult = await normalHarness.runner.runPipeline({
      tenantId: 'tenant_1', pipelineId: 'pipe_1', mode: 'incremental', triggeredBy: 'manual',
    })
    assert.equal(normalResult.run.details.maxPagesReached, false,
      'maxPagesReached=false when source signals done before cap')
    assert.equal(normalResult.run.details.pagesProcessed, 1,
      'pagesProcessed=1 when single page completes the run')
  }

  // --- 20. invalid source record (null/array/scalar) → dead letter, run continues
  {
    // Source returns a mix of nulls, valid records, and a scalar; transformRecord
    // throws TransformError on non-objects, so without per-record guard the entire
    // run dies on the first null. Verify each invalid record becomes its own
    // dead letter with INVALID_SOURCE_RECORD and valid records still write.
    let mixedPage = 0
    const mixedHarness = createRunnerHarness({
      sourceRecords: [],
      sourceRead: async () => {
        mixedPage += 1
        return createReadResult({
          records: [
            null,
            { code: 'valid-1', revision: 'r1', qty: '3', name: 'Bolt', updatedAt: '2026-04-24T01:00:00.000Z' },
            undefined,
            'raw-string-not-an-object',
            { code: 'valid-2', revision: 'r1', qty: '5', name: 'Nut', updatedAt: '2026-04-24T01:10:00.000Z' },
            [{ nested: 'array' }],
          ],
          done: true,
          nextCursor: null,
        })
      },
    })
    const mixedResult = await mixedHarness.runner.runPipeline({
      tenantId: 'tenant_1', pipelineId: 'pipe_1', mode: 'incremental', triggeredBy: 'manual',
    })
    assert.equal(mixedResult.run.status, 'partial', 'run completes with partial status')
    assert.equal(mixedResult.metrics.rowsRead, 6, 'all 6 records counted as read')
    assert.equal(mixedResult.metrics.rowsCleaned, 2, 'two valid records cleaned')
    assert.equal(mixedResult.metrics.rowsWritten, 2, 'two valid records written to target')
    assert.equal(mixedResult.metrics.rowsFailed, 4, 'four invalid records failed')
    assert.equal(mixedHarness.targetRows.size, 2, 'target has the two valid records only')

    // Each invalid record produced its own dead letter with INVALID_SOURCE_RECORD
    const deadLetters = mixedHarness.db.tables.get('integration_dead_letters')
    const invalidLetters = deadLetters.filter((row) => row.error_code === 'INVALID_SOURCE_RECORD')
    assert.equal(invalidLetters.length, 4, 'four INVALID_SOURCE_RECORD dead letters created')
    const messages = invalidLetters.map((row) => row.error_message).sort()
    assert.ok(messages.some((m) => m.includes('null')), 'null reported in error message')
    assert.ok(messages.some((m) => m.includes('undefined')), 'undefined reported')
    assert.ok(messages.some((m) => m.includes('array')), 'array reported')
    assert.ok(messages.some((m) => m.includes('string')), 'string reported')
  }

  // --- 21. invalid runner paging options fall back / cap safely ----------
  {
    const invalidOptionLimits = []
    const invalidOptionHarness = createRunnerHarness({
      sourceRecords: [],
      pipelineOverrides: { options: { batchSize: 0, maxPages: 0 } },
      sourceRead: async (input) => {
        invalidOptionLimits.push(input.limit)
        return createReadResult({
          records: [
            { code: 'fallback-1', revision: 'r1', qty: '1', name: 'Bolt', updatedAt: '2026-04-24T01:00:00.000Z' },
          ],
          done: true,
          nextCursor: null,
        })
      },
    })
    const invalidOptionResult = await invalidOptionHarness.runner.runPipeline({
      tenantId: 'tenant_1', pipelineId: 'pipe_1', mode: 'incremental', triggeredBy: 'manual',
    })
    assert.equal(invalidOptionLimits[0], 1000, 'batchSize=0 falls back to default batch size')
    assert.equal(invalidOptionResult.metrics.rowsRead, 1, 'maxPages=0 falls back instead of producing a silent no-op')
    assert.equal(invalidOptionResult.run.details.pagesProcessed, 1, 'fallback maxPages allows one page to run')
    assert.equal(invalidOptionHarness.targetRows.size, 1, 'valid record still writes with invalid option fallbacks')

    const hugeOptionLimits = []
    const hugeOptionHarness = createRunnerHarness({
      sourceRecords: [],
      pipelineOverrides: { options: { batchSize: 999999, maxPages: 1 } },
      sourceRead: async (input) => {
        hugeOptionLimits.push(input.limit)
        return createReadResult({
          records: [
            { code: 'cap-1', revision: 'r1', qty: '1', name: 'Nut', updatedAt: '2026-04-24T02:00:00.000Z' },
          ],
          done: true,
          nextCursor: null,
        })
      },
    })
    await hugeOptionHarness.runner.runPipeline({
      tenantId: 'tenant_1', pipelineId: 'pipe_1', mode: 'incremental', triggeredBy: 'manual',
    })
    assert.equal(hugeOptionLimits[0], 10000, 'huge batchSize is capped before adapter read()')
  }

  console.log('✓ pipeline-runner: cleanse/idempotency/incremental E2E tests passed')
}

main().catch((err) => {
  console.error('✗ pipeline-runner FAILED')
  console.error(err)
  process.exit(1)
})
