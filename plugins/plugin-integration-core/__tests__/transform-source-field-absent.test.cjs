'use strict'

// ---------------------------------------------------------------------------
// X02: "the source record does not carry this field" is not "the source emptied
// this field".
//
// Before this suite's fix, a mapping whose sourceField was absent from a record
// resolved to `undefined`, was written to the target anyway, and blanked a
// column that held a correct value - with no error, rowsFailed still 0, and the
// watermark advancing. These tests pin the three dispositions apart:
//
//   absent path            -> target field LEFT UNWRITTEN + SOURCE_FIELD_ABSENT
//   path present, null/''  -> written, exactly as before (a real clearing)
//   defaultValue configured -> default applied, exactly as before
// ---------------------------------------------------------------------------

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  SOURCE_FIELD_ABSENT,
  getPath,
  resolveSourcePath,
  transformRecord,
} = require(path.join(__dirname, '..', 'lib', 'transform-engine.cjs'))
const { validateRecord } = require(path.join(__dirname, '..', 'lib', 'validator.cjs'))
const { createAdapterRegistry, createReadResult, createUpsertResult } = require(path.join(__dirname, '..', 'lib', 'contracts.cjs'))
const { createPipelineRunner } = require(path.join(__dirname, '..', 'lib', 'pipeline-runner.cjs'))
const { createDeadLetterStore } = require(path.join(__dirname, '..', 'lib', 'dead-letter.cjs'))
const { createWatermarkStore } = require(path.join(__dirname, '..', 'lib', 'watermark.cjs'))
const { createRunLogger } = require(path.join(__dirname, '..', 'lib', 'run-log.cjs'))
const {
  createMetaSheetMultitableTargetAdapter,
} = require(path.join(__dirname, '..', 'lib', 'adapters', 'metasheet-multitable-target-adapter.cjs'))

function ownKeys(object) {
  return Object.keys(object).sort()
}

function warningCodes(result) {
  return (result.warnings || []).map((warning) => warning.code)
}

// --- 1. absent source path: nothing is written, and the fact is reported -----
function testAbsentSourcePathLeavesTargetUnwritten() {
  const mappings = [
    { sourceField: 'code', targetField: 'FNumber' },
    { sourceField: 'spec', targetField: 'FSpec' },
  ]

  const result = transformRecord({ code: 'MAT-001' }, mappings)

  assert.equal(result.ok, true, 'an absent source field is reported, not failed')
  assert.deepEqual(result.errors, [], 'absence is not a transform error')
  assert.deepEqual(ownKeys(result.value), ['FNumber'], 'FSpec must not appear in the payload at all')
  assert.equal(
    Object.prototype.hasOwnProperty.call(result.value, 'FSpec'),
    false,
    'the key must be ABSENT, not present-holding-undefined: a present key is what patches the target to blank',
  )
  assert.deepEqual(result.warnings, [{
    field: 'FSpec',
    sourceField: 'spec',
    index: 1,
    code: 'SOURCE_FIELD_ABSENT',
    message: 'source field is absent from this record; target field left unwritten',
    details: {},
  }])
  assert.equal(SOURCE_FIELD_ABSENT, 'SOURCE_FIELD_ABSENT')

  // Values-free: the notice carries the two CONFIGURED identifiers and nothing else.
  const serialized = JSON.stringify(result.warnings)
  assert.equal(serialized.includes('MAT-001'), false, 'the notice must never carry a source value')

  // Nested + array paths behave the same, and the skipped write must not even
  // create the parent container.
  const nested = transformRecord({ head: {} }, [
    { sourceField: 'head.code', targetField: 'body.FNumber' },
    { sourceField: 'lines[].qty', targetField: 'FChildItems[].FQty' },
    { sourceField: 'head.rev', targetField: 'body.FRev' },
  ])
  assert.deepEqual(nested.value, {}, 'no parent object/array is materialised for a skipped write')
  assert.deepEqual(warningCodes(nested), [
    'SOURCE_FIELD_ABSENT',
    'SOURCE_FIELD_ABSENT',
    'SOURCE_FIELD_ABSENT',
  ])

  // An array that exists but is empty has no element 0 to read -> absent.
  const emptyArray = transformRecord({ lines: [] }, [{ sourceField: 'lines[].qty', targetField: 'FQty' }])
  assert.deepEqual(emptyArray.value, {})
  assert.deepEqual(warningCodes(emptyArray), ['SOURCE_FIELD_ABSENT'])
}

// --- 2. present-but-empty is UNCHANGED: the source really did clear it -------
function testPresentButEmptyStillWrites() {
  const cases = [
    { record: { spec: null }, expected: null, label: 'null' },
    { record: { spec: '' }, expected: '', label: 'empty string' },
    { record: { spec: 0 }, expected: 0, label: 'zero' },
    { record: { spec: false }, expected: false, label: 'false' },
    { record: { spec: undefined }, expected: undefined, label: 'own key holding undefined' },
  ]
  for (const { record, expected, label } of cases) {
    const result = transformRecord(record, [{ sourceField: 'spec', targetField: 'FSpec' }])
    assert.equal(
      Object.prototype.hasOwnProperty.call(result.value, 'FSpec'),
      true,
      `${label}: the path EXISTS, so the clearing must still be written`,
    )
    assert.equal(result.value.FSpec, expected, `${label}: value is written unchanged`)
    assert.deepEqual(result.warnings, [], `${label}: an existing path is never reported absent`)
  }

  // Nested + array forms of "present but empty".
  const nested = transformRecord({ head: { code: null }, lines: [{ qty: '' }] }, [
    { sourceField: 'head.code', targetField: 'FNumber' },
    { sourceField: 'lines[].qty', targetField: 'FQty' },
  ])
  assert.deepEqual(nested.value, { FNumber: null, FQty: '' })
  assert.deepEqual(nested.warnings, [])
}

// --- 3. defaultValue and value-producing transforms keep their precedence ----
function testDefaultsAndTransformsStillProduceValues() {
  const withDefault = transformRecord({}, [
    { sourceField: 'spec', targetField: 'FSpec', defaultValue: 'UNKNOWN' },
  ])
  assert.deepEqual(withDefault.value, { FSpec: 'UNKNOWN' }, 'mapping defaultValue still fills an absent field')
  assert.deepEqual(withDefault.warnings, [], 'a filled default is not a silent blanking, so nothing is reported')

  // defaultValue explicitly set to undefined: the operator asked for it; unchanged.
  const undefinedDefault = transformRecord({}, [
    { sourceField: 'spec', targetField: 'FSpec', defaultValue: undefined },
  ])
  assert.equal(Object.prototype.hasOwnProperty.call(undefinedDefault.value, 'FSpec'), true)
  assert.deepEqual(undefinedDefault.warnings, [])

  // A transform chain that manufactures a value out of nothing still writes it.
  const manufactured = transformRecord({}, [
    { sourceField: 'spec', targetField: 'FSpec', transform: { fn: 'defaultValue', value: 'FALLBACK' } },
    { sourceField: 'status', targetField: 'FStatus', transform: { fn: 'dictMap', map: {}, defaultValue: 'unknown' } },
    { sourceField: 'first', targetField: 'FKey', transform: { fn: 'concat', values: ['LITERAL'], separator: '|' } },
  ])
  assert.deepEqual(manufactured.value, { FSpec: 'FALLBACK', FStatus: 'unknown', FKey: 'LITERAL' })
  assert.deepEqual(manufactured.warnings, [], 'a transform-produced value is a real value, not an absence')

  // A transform chain that passes the nothing through DOES skip.
  const passthrough = transformRecord({}, [
    { sourceField: 'spec', targetField: 'FSpec', transform: ['trim', 'upper'] },
    { sourceField: 'qty', targetField: 'FQty', transform: 'toNumber' },
  ])
  assert.deepEqual(passthrough.value, {})
  assert.deepEqual(warningCodes(passthrough), ['SOURCE_FIELD_ABSENT', 'SOURCE_FIELD_ABSENT'])
}

// --- 4. the skip branch does not bypass the existing guards ------------------
function testSkipDoesNotBypassGuards() {
  // An unsafe targetField must keep failing even when its source field is absent
  // (before, setPath() was what raised it; skipping the write must not skip it).
  for (const targetField of ['__proto__', 'a.constructor.b', 'x.prototype']) {
    const result = transformRecord({}, [{ sourceField: 'absent', targetField }])
    assert.equal(result.ok, false, `${targetField}: unsafe target path still fails`)
    assert.equal(result.errors[0].code, 'TRANSFORM_FAILED')
    assert.equal(result.errors[0].message, 'targetField contains an unsafe path segment')
    assert.deepEqual(result.warnings, [], 'a refused mapping is not reported as an absence')
  }

  // `required` keeps its meaning: an unwritten target field reads back as empty
  // to the validator, exactly as the written-undefined did.
  const mappings = [{ sourceField: 'spec', targetField: 'FSpec', validation: [{ type: 'required' }] }]
  const transformed = transformRecord({}, mappings)
  assert.equal(transformed.ok, true)
  const validation = validateRecord(transformed.value, mappings)
  assert.equal(validation.ok, false, 'required still rejects a record whose source lacked the field')
  assert.equal(validation.errors[0].code, 'REQUIRED')

  // A mapping with no sourceField at all is the pre-existing "constant mapping"
  // shape; it must keep behaving as it did (nothing found, nothing produced).
  const noSource = transformRecord({ a: 1 }, [{ targetField: 'FSpec' }])
  assert.deepEqual(noSource.value, {})
  assert.deepEqual(warningCodes(noSource), ['SOURCE_FIELD_ABSENT'])
  assert.equal(noSource.warnings[0].sourceField, undefined)
}

// --- 5. resolveSourcePath cannot drift from getPath's VALUE ------------------
function testResolveSourcePathValueParityWithGetPath() {
  const records = [
    {},
    { a: 1 },
    { a: null },
    { a: undefined },
    { a: '' },
    { a: 0 },
    { a: { b: 2 } },
    { a: { b: null } },
    { a: 'hello' },
    { a: 5 },
    { a: [] },
    { a: [{ b: 3 }] },
    { a: [undefined] },
    { a: { b: [{ c: 4 }] } },
  ]
  const paths = [
    'a', 'a.b', 'a.b.c', 'a[]', 'a[].b', 'a.b[]', 'a.b[].c',
    'a.length', 'a.0', 'missing', 'missing.deep', '__proto__', 'a.__proto__',
  ]
  let checked = 0
  for (const record of records) {
    for (const p of paths) {
      const viaGetPath = getPath(record, p)
      const resolved = resolveSourcePath(record, p)
      assert.equal(
        Object.is(resolved.value, viaGetPath),
        true,
        `resolveSourcePath(${JSON.stringify(record)}, '${p}').value must equal getPath()'s answer`,
      )
      checked += 1
    }
  }
  assert.equal(checked, records.length * paths.length)
  assert.equal(checked, 182)

  // found is the NEW information, and it is what separates the two dispositions.
  assert.deepEqual(resolveSourcePath({ a: undefined }, 'a'), { found: true, value: undefined })
  assert.deepEqual(resolveSourcePath({}, 'a'), { found: false, value: undefined })
  assert.deepEqual(resolveSourcePath({ a: {} }, 'a.b'), { found: false, value: undefined })
  assert.deepEqual(resolveSourcePath({ a: { b: null } }, 'a.b'), { found: true, value: null })
  assert.deepEqual(resolveSourcePath(null, 'a'), { found: false, value: undefined })
  assert.deepEqual(resolveSourcePath({ a: 1 }, ''), { found: false, value: undefined })
}

// --- 6. the target patch really does preserve the old value ------------------
// The point of not writing the key: the multitable target patches with the keys
// it is handed, so an omitted key leaves the stored value alone.
async function testTargetPatchPreservesExistingValue() {
  const rows = [{
    id: 'rec_existing',
    sheetId: 'sheet_approved_materials',
    version: 1,
    data: { code: 'MAT-001', name: 'Correct bolt', quantity: 7 },
  }]
  const context = {
    api: {
      multitable: {
        records: {
          async queryRecords(input) {
            return rows.filter((row) => Object.entries(input.filters || {})
              .every(([field, value]) => row.data[field] === value)).slice(0, input.limit || 10)
          },
          async createRecord(input) {
            const row = { id: `rec_${rows.length + 1}`, sheetId: input.sheetId, version: 1, data: { ...input.data } }
            rows.push(row)
            return row
          },
          async patchRecord(input) {
            const row = rows.find((item) => item.id === input.recordId)
            row.version += 1
            row.data = { ...row.data, ...input.changes }
            return row
          },
        },
      },
    },
  }
  const adapter = createMetaSheetMultitableTargetAdapter({
    system: {
      id: 'metasheet_target_project_1',
      name: 'MetaSheet target',
      kind: 'metasheet:multitable',
      role: 'target',
      config: {
        objects: {
          approved_materials: {
            name: 'Approved Materials',
            sheetId: 'sheet_approved_materials',
            keyFields: ['code'],
            fieldDetails: [
              { id: 'code', name: 'Code', type: 'string' },
              { id: 'name', name: 'Name', type: 'string' },
              { id: 'quantity', name: 'Quantity', type: 'number' },
            ],
          },
        },
      },
    },
    context,
  })

  const mappings = [
    { sourceField: 'code', targetField: 'code' },
    { sourceField: 'name', targetField: 'name' },
    { sourceField: 'quantity', targetField: 'quantity' },
  ]
  // The source row for this pull simply does not carry `name` (a column that was
  // renamed away, or a projection that dropped it).
  const transformed = transformRecord({ code: 'MAT-001', quantity: 9 }, mappings)
  assert.deepEqual(warningCodes(transformed), ['SOURCE_FIELD_ABSENT'])

  await adapter.upsert({
    object: 'approved_materials',
    records: [transformed.value],
    keyFields: ['code'],
  })

  assert.equal(rows.length, 1, 'the existing row was updated, not duplicated')
  assert.equal(rows[0].data.name, 'Correct bolt', 'the absent source column must NOT blank the stored value')
  assert.equal(rows[0].data.quantity, 9, 'the columns the source did carry are still written')
}

// --- 7. run-level visibility: count + field identifiers in run details -------
function createMockDb() {
  const tables = new Map([
    ['integration_dead_letters', []],
    ['integration_watermarks', []],
    ['integration_runs', []],
  ])
  function rowsOf(table) {
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
    async selectOne(table, where) { return rowsOf(table).find((row) => matches(row, where)) || null },
    async insertOne(table, row) {
      const stored = { ...row, created_at: '2026-09-11T00:00:00.000Z', updated_at: '2026-09-11T00:00:00.000Z' }
      rowsOf(table).push(stored)
      return [stored]
    },
    async updateRow(table, set, where) {
      const row = rowsOf(table).find((candidate) => matches(candidate, where))
      if (!row) return []
      Object.assign(row, set, { updated_at: '2026-09-11T01:00:00.000Z' })
      return [row]
    },
    async select(table, options = {}) { return rowsOf(table).filter((row) => matches(row, options.where || {})) },
  }
}

function createHarness({ sourceRecords, fieldMappings }) {
  const db = createMockDb()
  const writtenRecords = []
  const pipeline = {
    id: 'pipe_x02',
    tenantId: 'tenant_1',
    workspaceId: null,
    projectId: 'project_1',
    sourceSystemId: 'source_1',
    sourceObject: 'materials',
    targetSystemId: 'target_1',
    targetObject: 'BD_MATERIAL',
    mode: 'incremental',
    status: 'active',
    idempotencyKeyFields: ['code'],
    options: { batchSize: 100, watermark: { type: 'updated_at', field: 'updatedAt', tiebreaker: 'code' } },
    fieldMappings,
  }
  let nextRun = 1
  const pipelineRegistry = {
    async getPipeline() { return pipeline },
    async createPipelineRun(input) {
      const id = `run_${nextRun++}`
      await db.insertOne('integration_runs', {
        id,
        tenant_id: input.tenantId,
        workspace_id: input.workspaceId ?? null,
        pipeline_id: input.pipelineId,
        status: input.status,
        details: input.details || {},
      })
      return {
        id,
        tenantId: input.tenantId,
        workspaceId: input.workspaceId ?? null,
        pipelineId: input.pipelineId,
        status: input.status,
        details: input.details || {},
      }
    },
    async updatePipelineRun(input) {
      const updated = await db.updateRow('integration_runs', {
        status: input.status,
        rows_read: input.rowsRead,
        rows_cleaned: input.rowsCleaned,
        rows_written: input.rowsWritten,
        rows_failed: input.rowsFailed,
        details: input.details || {},
      }, { tenant_id: input.tenantId, workspace_id: input.workspaceId ?? null, id: input.id })
      const row = updated[0]
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
        details: row.details,
      }
    },
  }
  const systems = new Map([
    ['source_1', { id: 'source_1', name: 'PLM mock', kind: 'mock-source', role: 'source', config: {} }],
    ['target_1', { id: 'target_1', name: 'ERP mock', kind: 'mock-target', role: 'target', config: {} }],
  ])
  const adapterRegistry = createAdapterRegistry()
    .registerAdapter('mock-source', ({ system }) => ({
      system,
      async testConnection() { return { ok: true } },
      async listObjects() { return [{ name: 'materials' }] },
      async getSchema() { return { fields: [] } },
      async read() { return createReadResult({ records: sourceRecords.slice() }) },
      async upsert() { throw new Error('source upsert should not be called') },
    }))
    .registerAdapter('mock-target', () => ({
      async testConnection() { return { ok: true } },
      async listObjects() { return [{ name: 'BD_MATERIAL' }] },
      async getSchema() { return { fields: [] } },
      async read() { return createReadResult({ records: [] }) },
      async upsert(input) {
        writtenRecords.push(...input.records)
        return createUpsertResult({ written: input.records.length, skipped: 0, results: [] })
      },
    }))
  const runner = createPipelineRunner({
    pipelineRegistry,
    externalSystemRegistry: {
      async getExternalSystem(input) { return systems.get(input.id) },
      async getExternalSystemForAdapter(input) {
        const system = systems.get(input.id)
        return system ? { ...system, credentials: { bearerToken: `${system.id}-token` } } : null
      },
    },
    adapterRegistry,
    deadLetterStore: createDeadLetterStore({ db, idGenerator: () => `dl_${db.tables.get('integration_dead_letters').length + 1}` }),
    watermarkStore: createWatermarkStore({ db }),
    runLogger: createRunLogger({ pipelineRegistry }),
    clock: (() => { let tick = 0; return () => tick++ * 25 })(),
  })
  return { db, pipeline, runner, writtenRecords }
}

async function testRunReportsAbsenceWithCountAndFieldNames() {
  const fieldMappings = [
    { sourceField: 'code', targetField: 'FNumber' },
    { sourceField: 'spec', targetField: 'FSpec' },
    { sourceField: 'colour', targetField: 'FColour' },
  ]
  const { db, runner, writtenRecords } = createHarness({
    fieldMappings,
    sourceRecords: [
      { code: 'MAT-001', spec: 'S1', colour: 'red', updatedAt: '2026-09-10T00:00:00.000Z' },
      { code: 'MAT-002', colour: 'blue', updatedAt: '2026-09-10T01:00:00.000Z' },
      { code: 'MAT-003', updatedAt: '2026-09-10T02:00:00.000Z' },
    ],
  })

  const result = await runner.runPipeline({ tenantId: 'tenant_1', pipelineId: 'pipe_x02', triggeredBy: 'test' })

  assert.equal(result.metrics.rowsRead, 3)
  assert.equal(result.metrics.rowsFailed, 0, 'absence is not a row failure')
  assert.equal(result.metrics.rowsWritten, 3)

  // The written payloads simply lack the columns the source did not carry.
  assert.deepEqual(ownKeys(writtenRecords[0]), ['FColour', 'FNumber', 'FSpec', '_integration_idempotency_key'])
  assert.deepEqual(ownKeys(writtenRecords[1]), ['FColour', 'FNumber', '_integration_idempotency_key'])
  assert.deepEqual(ownKeys(writtenRecords[2]), ['FNumber', '_integration_idempotency_key'])

  const runRow = db.tables.get('integration_runs')[0]
  assert.deepEqual(runRow.details.sourceFieldAbsent, {
    code: 'SOURCE_FIELD_ABSENT',
    rows: 2,
    fields: [
      { sourceField: 'colour', targetField: 'FColour' },
      { sourceField: 'spec', targetField: 'FSpec' },
    ],
  }, 'run details carry the COUNT of affected rows and the configured field identifiers')

  // Values-free: no source value, no row content, reaches the run record.
  const serialized = JSON.stringify(runRow.details)
  for (const value of ['MAT-001', 'MAT-002', 'MAT-003', 'red', 'blue', 'S1']) {
    assert.equal(serialized.includes(value), false, `run details must not carry the source value ${value}`)
  }

  // Documented, deliberately UNCHANGED in this change: the run still succeeds and
  // the watermark still advances after a SOURCE_FIELD_ABSENT. See the design doc.
  assert.equal(runRow.status, 'succeeded')
  const watermarkRow = db.tables.get('integration_watermarks')[0]
  assert.equal(watermarkRow.watermark_value, '2026-09-10T02:00:00.000Z', 'watermark semantics are untouched by this change')
}

async function testCleanRunCarriesNoAbsenceDetail() {
  const { db } = await (async () => {
    const harness = createHarness({
      fieldMappings: [
        { sourceField: 'code', targetField: 'FNumber' },
        { sourceField: 'spec', targetField: 'FSpec' },
      ],
      sourceRecords: [{ code: 'MAT-001', spec: null, updatedAt: '2026-09-10T00:00:00.000Z' }],
    })
    await harness.runner.runPipeline({ tenantId: 'tenant_1', pipelineId: 'pipe_x02', triggeredBy: 'test' })
    return harness
  })()
  const runRow = db.tables.get('integration_runs')[0]
  assert.equal(
    Object.prototype.hasOwnProperty.call(runRow.details, 'sourceFieldAbsent'),
    false,
    'a run where every mapped path existed carries no absence detail at all',
  )
}

// Exported one-by-one so a mutation probe can run each case in isolation and count
// exactly how many go red; `node __tests__/...` (the test-chain shape) still runs them all.
const CASES = {
  testAbsentSourcePathLeavesTargetUnwritten,
  testPresentButEmptyStillWrites,
  testDefaultsAndTransformsStillProduceValues,
  testSkipDoesNotBypassGuards,
  testResolveSourcePathValueParityWithGetPath,
  testTargetPatchPreservesExistingValue,
  testRunReportsAbsenceWithCountAndFieldNames,
  testCleanRunCarriesNoAbsenceDetail,
}

async function main() {
  for (const run of Object.values(CASES)) await run()
  console.log('[pass] transform-source-field-absent: absent source fields no longer blank target values')
}

module.exports = { CASES }

if (require.main === module) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
