'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const {
  AdapterValidationError,
  UnsupportedAdapterOperationError,
} = require(path.join(__dirname, '..', 'lib', 'contracts.cjs'))
const {
  createMetaSheetMultitableTargetAdapter,
  createMetaSheetMultitableWriteSource,
  MULTITABLE_WRITE_PROFILE,
  __internals,
} = require(path.join(__dirname, '..', 'lib', 'adapters', 'metasheet-multitable-target-adapter.cjs'))
const {
  dryRunExternalWrite,
  applyExternalWrite,
} = require(path.join(__dirname, '..', 'lib', 'external-write-dry-run.cjs'))

function memoryStore() {
  const map = new Map()
  return {
    map,
    async get(key) { return map.get(key) || null },
    async set(key, value) { map.set(key, JSON.parse(JSON.stringify(value))) },
    async consume(key) { const v = map.get(key) || null; map.delete(key); return v },
    async delete(key) { map.delete(key) },
  }
}

function createContext({ existing = [], resolveFieldIds } = {}) {
  const rows = [...existing]
  const calls = []
  const multitable = {
    records: {
      async queryRecords(input) {
        calls.push(['queryRecords', input])
        return rows.filter((row) => Object.entries(input.filters || {}).every(([field, value]) => row.data[field] === value))
          .slice(0, input.limit || 1000)
      },
      async createRecord(input) {
        calls.push(['createRecord', input])
        const row = {
          id: `rec_${rows.length + 1}`,
          sheetId: input.sheetId,
          version: 1,
          data: { ...input.data },
        }
        rows.push(row)
        return row
      },
      async patchRecord(input) {
        calls.push(['patchRecord', input])
        const row = rows.find((item) => item.id === input.recordId && item.sheetId === input.sheetId)
        if (!row) throw new Error(`record not found: ${input.recordId}`)
        row.version += 1
        row.data = { ...row.data, ...input.changes }
        return row
      },
    },
  }
  if (resolveFieldIds) {
    multitable.provisioning = {
      async resolveFieldIds(input) {
        calls.push(['resolveFieldIds', input])
        return resolveFieldIds(input)
      },
    }
  }
  return {
    calls,
    rows,
    context: {
      api: {
        multitable,
      },
    },
  }
}

function createSystem(config = {}) {
  return {
    id: 'metasheet_target_project_1',
    name: 'MetaSheet target',
    kind: 'metasheet:multitable',
    role: 'target',
    config: {
      objects: {
        approved_materials: {
          name: 'Approved Materials',
          sheetId: 'sheet_approved_materials',
          viewId: 'view_approved_materials',
          openLink: '/multitable/sheet_approved_materials/view_approved_materials',
          keyFields: ['code'],
          fieldDetails: [
            { id: 'code', name: 'Code', type: 'string' },
            { id: 'name', name: 'Name', type: 'string' },
            { id: 'quantity', name: 'Quantity', type: 'number' },
          ],
        },
      },
      ...config,
    },
  }
}

// S1b-2: the multitable write-source rides the C6 dry-run->apply lifecycle (via the S1b-1
// seam), writing ONLY to own sheets, idempotent on re-pull, values-free. Non-identity
// fieldIdMap proves the logical<->physical round-trip.
async function testMultitableWriteSourceRidesC6Lifecycle() {
  const fieldIdMap = { code: 'f_code', name: 'f_name', quantity: 'f_qty' }
  const { context, rows } = createContext({
    existing: [
      { id: 'rec_mat_002', sheetId: 'sheet_approved_materials', version: 1, data: { f_code: 'MAT-002', f_name: 'Gadget', f_qty: 5 } },
    ],
  })
  const multitableSystem = createSystem({
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
        fieldIdMap,
      },
    },
  })
  const writeSource = createMetaSheetMultitableWriteSource({ system: multitableSystem, context })

  // capability test reports a REAL own-sheet-scoped safe state (not a rubber stamp)
  const cap = await writeSource.test('mt', 'owner-1')
  assert.deepEqual(MULTITABLE_WRITE_PROFILE.normalizeCapabilityState(cap), { success: true, ownSheetTarget: true, externalWrite: false })

  const sourceRows = [
    { code: 'MAT-001', name: 'Bolt', quantity: 2 },     // new -> add
    { code: 'MAT-002', name: 'Gadget', quantity: 9 },   // exists with qty 5 -> update
  ]
  const baseInput = () => ({
    pipeline: {
      id: 'pipe_mt', tenantId: 't1', workspaceId: 'w1',
      sourceSystemId: 'src', sourceObject: 'items',
      targetSystemId: multitableSystem.id, targetObject: 'approved_materials',
      createdBy: 'owner-1',
      fieldMappings: [
        { sourceField: 'code', targetField: 'code', validation: [{ type: 'required' }] },
        { sourceField: 'name', targetField: 'name' },
        { sourceField: 'quantity', targetField: 'quantity' },
      ],
    },
    sourceSystem: { id: 'src', kind: 'data-source:sql-readonly' },
    // flat planner target config (what the S1b-3 route derives from the multitable system)
    targetSystem: {
      id: multitableSystem.id,
      kind: 'metasheet:multitable',
      config: { dataSourceId: 'mt', object: 'approved_materials', keyFields: ['code'], writableFields: ['name', 'quantity'] },
    },
    sourceAdapter: { async read() { return { records: sourceRows, done: true, nextCursor: null } } },
    dataSourceWrites: writeSource,
    targetWriteProfile: MULTITABLE_WRITE_PROFILE,
    tokenStore: memoryStore(),
    dryRunUser: 'owner-1',
    dataSourceOwnerPrincipal: 'owner-1',
    maxRows: 100,
  })

  // Run 1: add + update through the full C6 lifecycle.
  const input1 = baseInput()
  const dry1 = await dryRunExternalWrite(input1)
  assert.equal(dry1.status, 'ready')
  assert.equal(dry1.canApply, true)
  assert.equal(dry1.counts.add, 1, 'MAT-001 classified add')
  assert.equal(dry1.counts.update, 1, 'MAT-002 (qty 5->9) classified update via logical<->physical round-trip')
  assert.equal(dry1.evidence.targetKind, 'metasheet:multitable', 'evidence carries the multitable kind via the S1b-1 seam')
  assert.equal(JSON.stringify(dry1.evidence).includes('MAT-001'), false, 'dry-run evidence stays values-free')
  assert.equal(JSON.stringify(dry1.evidence).includes('Bolt'), false, 'dry-run evidence stays values-free')

  const apply1 = await applyExternalWrite({ ...input1, dryRunToken: dry1.dryRunToken, applyUser: 'owner-1', runId: 'run_mt_1' })
  assert.equal(apply1.status, 'succeeded')
  assert.equal(apply1.counts.add, 1)
  assert.equal(apply1.counts.update, 1)
  assert.equal(apply1.counts.written, 2)
  assert.equal(rows.length, 2, 'exactly one new record created on own sheet (MAT-001), MAT-002 patched in place')
  const created = rows.find((r) => r.data.f_code === 'MAT-001')
  assert.ok(created && created.sheetId === 'sheet_approved_materials', 'write landed on OWN sheet')
  assert.deepEqual(created.data, { f_code: 'MAT-001', f_name: 'Bolt', f_qty: 2 }, 'logical->physical map applied on write')
  const patched = rows.find((r) => r.data.f_code === 'MAT-002')
  assert.equal(patched.data.f_qty, 9, 'update patched the changed field')
  assert.equal(JSON.stringify(apply1).includes('MAT-001'), false, 'apply response stays values-free')

  // Run 2 (re-pull): same source, now everything matches -> idempotent skip, no new writes.
  const input2 = baseInput()
  const dry2 = await dryRunExternalWrite(input2)
  assert.equal(dry2.counts.add, 0, 're-pull adds nothing')
  assert.equal(dry2.counts.update, 0, 're-pull updates nothing')
  assert.equal(dry2.counts.skip, 2, 're-pull classifies both as skip (idempotent)')
  const apply2 = await applyExternalWrite({ ...input2, dryRunToken: dry2.dryRunToken, applyUser: 'owner-1', runId: 'run_mt_2' })
  assert.equal(apply2.counts.written, 0, 're-pull writes nothing')
  assert.equal(rows.length, 2, 're-pull created no duplicate records')

  // Profile fails closed on an unsafe (non-own-sheet) capability state.
  assert.throws(
    () => MULTITABLE_WRITE_PROFILE.assertSafeCapabilityState({ ownSheetTarget: false, externalWrite: true }),
    /own-sheet scoped/,
    'unsafe capability state rejected',
  )
}

// S1b-2 (review P2): MetaSheet sheets don't enforce key uniqueness, so a DUPLICATE key must
// surface as ambiguous -> the C6 planner HOLDS (no write), not silently updates one row.
async function testMultitableAmbiguousKeyHolds() {
  const fieldIdMap = { code: 'f_code', name: 'f_name', quantity: 'f_qty' }
  const { context, rows } = createContext({
    existing: [
      { id: 'rec_a', sheetId: 'sheet_approved_materials', version: 1, data: { f_code: 'DUP-1', f_name: 'A', f_qty: 1 } },
      { id: 'rec_b', sheetId: 'sheet_approved_materials', version: 1, data: { f_code: 'DUP-1', f_name: 'B', f_qty: 2 } },
    ],
  })
  const system = createSystem({
    objects: {
      approved_materials: {
        name: 'Approved Materials', sheetId: 'sheet_approved_materials', keyFields: ['code'],
        fieldDetails: [{ id: 'code' }, { id: 'name' }, { id: 'quantity' }], fieldIdMap,
      },
    },
  })
  const writeSource = createMetaSheetMultitableWriteSource({ system, context })
  const dry = await dryRunExternalWrite({
    pipeline: {
      id: 'pipe_dup', tenantId: 't1', workspaceId: 'w1', sourceSystemId: 'src', sourceObject: 'items',
      targetSystemId: system.id, targetObject: 'approved_materials', createdBy: 'owner-1',
      fieldMappings: [
        { sourceField: 'code', targetField: 'code', validation: [{ type: 'required' }] },
        { sourceField: 'name', targetField: 'name' },
        { sourceField: 'quantity', targetField: 'quantity' },
      ],
    },
    sourceSystem: { id: 'src', kind: 'data-source:sql-readonly' },
    targetSystem: { id: system.id, kind: 'metasheet:multitable', config: { dataSourceId: 'mt', object: 'approved_materials', keyFields: ['code'], writableFields: ['name', 'quantity'] } },
    sourceAdapter: { async read() { return { records: [{ code: 'DUP-1', name: 'C', quantity: 3 }], done: true, nextCursor: null } } },
    dataSourceWrites: writeSource,
    targetWriteProfile: MULTITABLE_WRITE_PROFILE,
    tokenStore: memoryStore(),
    dryRunUser: 'owner-1', dataSourceOwnerPrincipal: 'owner-1', maxRows: 100,
  })
  assert.equal(dry.counts.held, 1, 'duplicate key HOLDS (ambiguous), not silently updated')
  assert.equal(dry.canApply, false, 'a held row blocks apply')
  assert.equal(dry.dryRunToken, null, 'no token issued when a row is held')
  assert.ok(dry.evidence.rowErrorTypes.includes('ambiguous_target_key'), 'ambiguity surfaced values-free')
  assert.equal(rows.length, 2, 'no write attempted on an ambiguous key')
}

// S1b-2 (review P3): a writable field NOT in fieldIdMap must round-trip identity on BOTH write
// and read-back (else re-pull would never be idempotent for unmapped fields).
async function testMultitableUnmappedFieldRoundTrips() {
  const fieldIdMap = { code: 'f_code' } // 'name' deliberately unmapped -> identity
  const { context, rows } = createContext({ existing: [] })
  const system = createSystem({
    objects: {
      approved_materials: {
        name: 'Approved Materials', sheetId: 'sheet_approved_materials', keyFields: ['code'],
        fieldDetails: [{ id: 'code' }, { id: 'name' }], fieldIdMap,
      },
    },
  })
  const writeSource = createMetaSheetMultitableWriteSource({ system, context })
  const baseInput = () => ({
    pipeline: {
      id: 'pipe_unmapped', tenantId: 't1', workspaceId: 'w1', sourceSystemId: 'src', sourceObject: 'items',
      targetSystemId: system.id, targetObject: 'approved_materials', createdBy: 'owner-1',
      fieldMappings: [
        { sourceField: 'code', targetField: 'code', validation: [{ type: 'required' }] },
        { sourceField: 'name', targetField: 'name' },
      ],
    },
    sourceSystem: { id: 'src', kind: 'data-source:sql-readonly' },
    targetSystem: { id: system.id, kind: 'metasheet:multitable', config: { dataSourceId: 'mt', object: 'approved_materials', keyFields: ['code'], writableFields: ['name'] } },
    sourceAdapter: { async read() { return { records: [{ code: 'U-1', name: 'Hello' }], done: true, nextCursor: null } } },
    dataSourceWrites: writeSource,
    targetWriteProfile: MULTITABLE_WRITE_PROFILE,
    tokenStore: memoryStore(),
    dryRunUser: 'owner-1', dataSourceOwnerPrincipal: 'owner-1', maxRows: 100,
  })
  const input1 = baseInput()
  const dry1 = await dryRunExternalWrite(input1)
  assert.equal(dry1.counts.add, 1)
  await applyExternalWrite({ ...input1, dryRunToken: dry1.dryRunToken, applyUser: 'owner-1' })
  const created = rows.find((r) => r.data.f_code === 'U-1')
  assert.deepEqual(created.data, { f_code: 'U-1', name: 'Hello' }, 'mapped field uses physical id; unmapped field stays identity')
  // re-pull: read-back of the unmapped field must equal -> skip (idempotent)
  const dry2 = await dryRunExternalWrite(baseInput())
  assert.equal(dry2.counts.skip, 1, 'unmapped field round-trips so re-pull is idempotent')
  assert.equal(dry2.counts.update, 0)
}

async function main() {
  const { context, calls, rows } = createContext({
    existing: [
      {
        id: 'rec_existing',
        sheetId: 'sheet_approved_materials',
        version: 2,
        data: { code: 'MAT-001', name: 'Old bolt', quantity: 1 },
      },
    ],
  })
  const adapter = createMetaSheetMultitableTargetAdapter({
    system: createSystem(),
    context,
  })

  const connection = await adapter.testConnection()
  assert.equal(connection.ok, true)
  assert.equal(connection.connected, true)
  assert.equal(connection.capabilities.createRecord, true)
  assert.equal(connection.capabilities.patchRecord, true)

  const objects = await adapter.listObjects()
  assert.equal(objects.length, 1)
  assert.equal(objects[0].name, 'approved_materials')
  assert.deepEqual(objects[0].operations, ['upsert'])
  assert.equal(objects[0].schema[0].name, 'code')

  const schema = await adapter.getSchema({ object: 'approved_materials' })
  assert.deepEqual(schema.fields.map((field) => field.name), ['code', 'name', 'quantity'])
  assert.equal(schema.raw.sheetId, 'sheet_approved_materials')
  assert.deepEqual(schema.raw.keyFields, ['code'])

  const preview = await adapter.previewUpsert({
    object: 'approved_materials',
    records: [
      { code: 'MAT-001', name: 'Bolt', quantity: 2, _integration_idempotency_key: 'secret-internal' },
    ],
    keyFields: ['_integration_idempotency_key'],
  })
  assert.deepEqual(preview.records[0].body, { code: 'MAT-001', name: 'Bolt', quantity: 2 })
  assert.equal(preview.records[0].operation, 'upsert')
  assert.equal(preview.records[0].path, '/multitable/sheet_approved_materials')

  const upsert = await adapter.upsert({
    object: 'approved_materials',
    records: [
      { code: 'MAT-001', name: 'Bolt', quantity: 2, _integration_idempotency_key: 'internal-1' },
      { code: 'MAT-002', name: 'Nut', quantity: 5, ignoredField: 'not in target schema' },
    ],
    keyFields: ['_integration_idempotency_key'],
  })
  assert.equal(upsert.written, 2)
  assert.equal(upsert.failed, 0)
  assert.equal(upsert.results[0].status, 'updated')
  assert.equal(upsert.results[0].externalId, 'rec_existing')
  assert.equal(upsert.results[1].status, 'created')
  assert.equal(rows.find((row) => row.id === 'rec_existing').data.name, 'Bolt')
  assert.equal(rows.find((row) => row.id === 'rec_2').data.ignoredField, undefined)
  assert.deepEqual(calls[0], ['queryRecords', {
    sheetId: 'sheet_approved_materials',
    filters: { code: 'MAT-001' },
    limit: 1,
    offset: 0,
  }])
  assert.equal(calls.some((call) => call[0] === 'patchRecord'), true)
  assert.equal(calls.some((call) => call[0] === 'createRecord'), true)

  const appendOnly = createMetaSheetMultitableTargetAdapter({
    system: createSystem({
      objects: {
        audit_copy: {
          name: 'Audit Copy',
          sheetId: 'sheet_audit_copy',
          mode: 'append',
          fields: ['code', 'name'],
        },
      },
    }),
    context,
  })
  const appendResult = await appendOnly.upsert({
    object: 'audit_copy',
    records: [{ code: 'MAT-003', name: 'Washer' }],
    keyFields: ['code'],
  })
  assert.equal(appendResult.written, 1)
  assert.equal(appendResult.results[0].status, 'created')

  const physical = createContext({
    existing: [
      {
        id: 'rec_plm_existing',
        sheetId: 'sheet_plm_raw_items',
        version: 1,
        data: {
          fld_sourceSystemId: 'bridge_source_1',
          fld_objectType: 'material',
          fld_sourceId: '1',
          fld_code: 'OLD',
        },
      },
    ],
    resolveFieldIds: ({ fieldIds }) => Object.fromEntries(fieldIds.map((fieldId) => [fieldId, `fld_${fieldId}`])),
  })
  const physicalTarget = createMetaSheetMultitableTargetAdapter({
    system: createSystem({
      projectId: 'default:integration-core',
      objects: {
        plm_raw_items: {
          name: 'PLM Raw Items',
          sheetId: 'sheet_plm_raw_items',
          keyFields: ['sourceSystemId', 'objectType', 'sourceId'],
          fieldDetails: [
            { id: 'sourceSystemId', name: 'Source System', type: 'string' },
            { id: 'objectType', name: 'Object Type', type: 'string' },
            { id: 'sourceId', name: 'Source ID', type: 'string' },
            { id: 'code', name: 'Code', type: 'string' },
            { id: 'name', name: 'Name', type: 'string' },
          ],
        },
      },
    }),
    context: physical.context,
  })
  const physicalResult = await physicalTarget.upsert({
    object: 'plm_raw_items',
    records: [
      { sourceSystemId: 'bridge_source_1', objectType: 'material', sourceId: '1', code: 'MAT-001', name: 'Bolt' },
      { sourceSystemId: 'bridge_source_1', objectType: 'bom', sourceId: '2', code: 'BOM-002', name: 'Parent' },
    ],
  })
  assert.equal(physicalResult.written, 2)
  assert.equal(physicalResult.failed, 0)
  assert.deepEqual(physical.calls[0], ['resolveFieldIds', {
    projectId: 'default:integration-core',
    objectId: 'plm_raw_items',
    fieldIds: ['sourceSystemId', 'objectType', 'sourceId', 'code', 'name'],
  }])
  assert.deepEqual(physical.calls[1], ['queryRecords', {
    sheetId: 'sheet_plm_raw_items',
    filters: {
      fld_sourceSystemId: 'bridge_source_1',
      fld_objectType: 'material',
      fld_sourceId: '1',
    },
    limit: 1,
    offset: 0,
  }])
  const patchCall = physical.calls.find((call) => call[0] === 'patchRecord')
  assert.deepEqual(patchCall[1].changes, {
    fld_sourceSystemId: 'bridge_source_1',
    fld_objectType: 'material',
    fld_sourceId: '1',
    fld_code: 'MAT-001',
    fld_name: 'Bolt',
  })
  const createCall = physical.calls.find((call) => call[0] === 'createRecord')
  assert.deepEqual(createCall[1].data, {
    fld_sourceSystemId: 'bridge_source_1',
    fld_objectType: 'bom',
    fld_sourceId: '2',
    fld_code: 'BOM-002',
    fld_name: 'Parent',
  })
  assert.equal(physical.rows.find((row) => row.id === 'rec_plm_existing').data.fld_code, 'MAT-001')

  const missingKey = await adapter.upsert({
    object: 'approved_materials',
    records: [{ name: 'Missing code' }],
  })
  assert.equal(missingKey.written, 0)
  assert.equal(missingKey.failed, 1)
  assert.equal(missingKey.errors[0].code, 'METASHEET_MULTITABLE_VALIDATION_FAILED')

  await assert.rejects(
    () => adapter.read({ object: 'approved_materials' }),
    UnsupportedAdapterOperationError,
    'multitable target is write-only',
  )
  assert.throws(
    () => createMetaSheetMultitableTargetAdapter({
      system: createSystem({ objects: { broken: { sheetId: 'sheet_broken', mode: 'merge' } } }),
      context,
    }),
    AdapterValidationError,
    'invalid object mode is rejected',
  )
  await assert.rejects(
    () => createMetaSheetMultitableTargetAdapter({
      system: createSystem(),
      context: { api: { multitable: { records: {} } } },
    }).testConnection(),
    AdapterValidationError,
    'missing createRecord API is reported',
  )

  assert.deepEqual(__internals.projectRecordForWrite({
    code: 'MAT-004',
    _integration_idempotency_key: 'internal',
    ignored: 'x',
  }, __internals.normalizeObjects(createSystem().config).approved_materials), {
    code: 'MAT-004',
  })
  assert.deepEqual(__internals.mapRecordFieldsForWrite({
    sourceSystemId: 'bridge_source_1',
    objectType: 'material',
  }, {
    sourceSystemId: 'fld_sourceSystemId',
    objectType: 'fld_objectType',
  }), {
    fld_sourceSystemId: 'bridge_source_1',
    fld_objectType: 'material',
  })

  await testMultitableWriteSourceRidesC6Lifecycle()
  await testMultitableAmbiguousKeyHolds()
  await testMultitableUnmappedFieldRoundTrips()

  console.log('✓ metasheet-multitable-target-adapter: write-only multitable target tests passed')
}

main().catch((err) => {
  console.error('✗ metasheet-multitable-target-adapter FAILED')
  console.error(err)
  process.exit(1)
})
