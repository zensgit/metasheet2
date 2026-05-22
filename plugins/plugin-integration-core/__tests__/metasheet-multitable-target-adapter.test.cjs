'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const {
  AdapterValidationError,
  UnsupportedAdapterOperationError,
} = require(path.join(__dirname, '..', 'lib', 'contracts.cjs'))
const {
  createMetaSheetMultitableTargetAdapter,
  __internals,
} = require(path.join(__dirname, '..', 'lib', 'adapters', 'metasheet-multitable-target-adapter.cjs'))

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

  console.log('✓ metasheet-multitable-target-adapter: write-only multitable target tests passed')
}

main().catch((err) => {
  console.error('✗ metasheet-multitable-target-adapter FAILED')
  console.error(err)
  process.exit(1)
})
