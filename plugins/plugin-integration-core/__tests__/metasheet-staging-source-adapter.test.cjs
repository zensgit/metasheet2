'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const {
  AdapterValidationError,
  UnsupportedAdapterOperationError,
} = require(path.join(__dirname, '..', 'lib', 'contracts.cjs'))
const {
  createMetaSheetStagingSourceAdapter,
} = require(path.join(__dirname, '..', 'lib', 'adapters', 'metasheet-staging-source-adapter.cjs'))

function createContext({ rows = [], provisioning = null } = {}) {
  const calls = []
  return {
    calls,
    context: {
      api: {
        multitable: {
          records: {
            async queryRecords(input) {
              calls.push(['queryRecords', input])
              const offset = Number(input.offset || 0)
              const limit = Number(input.limit || rows.length)
              return rows.slice(offset, offset + limit)
            },
          },
          ...(provisioning ? { provisioning } : {}),
        },
      },
    },
  }
}

function createSystem(config = {}) {
  return {
    id: 'metasheet_staging_project_1',
    name: 'MetaSheet staging',
    kind: 'metasheet:staging',
    role: 'source',
    config: {
      objects: {
        standard_materials: {
          name: 'Standard Materials',
          sheetId: 'sheet_materials',
          viewId: 'view_materials',
          openLink: '/multitable/sheet_materials/view_materials',
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
  const { context, calls } = createContext({
    rows: [
      { id: 'r1', sheetId: 'sheet_materials', version: 3, data: { code: 'MAT-001', name: 'Bolt', quantity: '2' } },
      { id: 'r2', sheetId: 'sheet_materials', version: 4, data: { code: 'MAT-002', name: 'Nut', quantity: '5' } },
    ],
  })
  const adapter = createMetaSheetStagingSourceAdapter({
    system: createSystem(),
    context,
  })

  const test = await adapter.testConnection()
  assert.equal(test.ok, true, 'testConnection passes when records API and object config exist')
  assert.equal(test.connected, true)

  const objects = await adapter.listObjects()
  assert.equal(objects.length, 1)
  assert.equal(objects[0].name, 'standard_materials')
  assert.deepEqual(objects[0].operations, ['read'])
  assert.equal(objects[0].schema[0].name, 'code')

  const schema = await adapter.getSchema({ object: 'standard_materials' })
  assert.equal(schema.object, 'standard_materials')
  assert.deepEqual(schema.fields.map((field) => field.name), ['code', 'name', 'quantity'])
  assert.equal(schema.raw.sheetId, 'sheet_materials')

  const manualConfigAdapter = createMetaSheetStagingSourceAdapter({
    system: createSystem({
      objects: {
        standard_materials: {
          sheetId: 'sheet_materials',
        },
      },
    }),
    context,
  })
  const fallbackObjects = await manualConfigAdapter.listObjects()
  assert.ok(
    fallbackObjects[0].schema.some((field) => field.name === 'code'),
    'manual staging source config derives schema from built-in descriptors',
  )
  const fallbackSchema = await manualConfigAdapter.getSchema({ object: 'standard_materials' })
  assert.ok(fallbackSchema.fields.length > 0, 'manual staging source schema is not empty')
  assert.ok(fallbackSchema.fields.some((field) => field.name === 'name'), 'descriptor fallback includes material name field')

  const firstPage = await adapter.read({ object: 'standard_materials', limit: 1 })
  assert.equal(firstPage.records.length, 1)
  assert.equal(firstPage.records[0].code, 'MAT-001')
  assert.equal(firstPage.records[0]._metaRecordId, 'r1')
  assert.equal(firstPage.nextCursor, '1')
  assert.equal(firstPage.done, false)
  assert.deepEqual(calls[0][1], {
    sheetId: 'sheet_materials',
    filters: {},
    limit: 1,
    offset: 0,
  })

  const secondPage = await adapter.read({ object: 'standard_materials', limit: 10, cursor: firstPage.nextCursor })
  assert.equal(secondPage.records.length, 1)
  assert.equal(secondPage.records[0].code, 'MAT-002')
  assert.equal(secondPage.nextCursor, null)
  assert.equal(secondPage.done, true)

  const fieldAliasCalls = []
  const { context: physicalContext } = createContext({
    rows: [
      {
        id: 'r3',
        sheetId: 'sheet_materials',
        version: 5,
        data: {
          fld_code: 'MAT-003',
          fld_name: 'Screw',
          fld_quantity: '8',
        },
      },
      {
        id: 'r4',
        sheetId: 'sheet_materials',
        version: 6,
        data: {
          code: 'MAT-004-LOGICAL',
          fld_code: 'MAT-004-PHYSICAL',
          fld_name: 'Washer',
          fld_quantity: '13',
        },
      },
    ],
    provisioning: {
      async resolveFieldIds(input) {
        fieldAliasCalls.push(input)
        return {
          code: 'fld_code',
          name: 'fld_name',
          quantity: 'fld_quantity',
        }
      },
    },
  })
  const physicalAdapter = createMetaSheetStagingSourceAdapter({
    system: createSystem({ projectId: 'default:integration-core' }),
    context: physicalContext,
  })
  const physicalRows = await physicalAdapter.read({ object: 'standard_materials', limit: 10 })
  assert.equal(physicalRows.records[0].code, 'MAT-003')
  assert.equal(physicalRows.records[0].name, 'Screw')
  assert.equal(physicalRows.records[0].quantity, '8')
  assert.equal(physicalRows.records[0].fld_code, 'MAT-003', 'physical field id is preserved for manually patched pipelines')
  assert.equal(physicalRows.records[1].code, 'MAT-004-LOGICAL', 'existing logical fields are not overwritten')
  assert.deepEqual(fieldAliasCalls, [{
    projectId: 'default:integration-core',
    objectId: 'standard_materials',
    fieldIds: ['code', 'name', 'quantity'],
  }])

  const explicitMapAdapter = createMetaSheetStagingSourceAdapter({
    system: createSystem({
      objects: {
        standard_materials: {
          name: 'Standard Materials',
          sheetId: 'sheet_materials',
          fieldDetails: [
            { id: 'code', name: 'Code', type: 'string' },
          ],
          fieldIdMap: {
            code: 'fld_code',
          },
        },
      },
    }),
    context: createContext({
      rows: [
        { id: 'r5', sheetId: 'sheet_materials', version: 1, data: { fld_code: 'MAT-005' } },
      ],
    }).context,
  })
  const explicitMapRows = await explicitMapAdapter.read({ object: 'standard_materials', limit: 1 })
  assert.equal(explicitMapRows.records[0].code, 'MAT-005', 'explicit fieldIdMap works without provisioning API')

  await assert.rejects(
    () => adapter.read({ object: 'unknown', limit: 1 }),
    AdapterValidationError,
    'unknown staging object is rejected',
  )
  await assert.rejects(
    () => adapter.upsert({ object: 'standard_materials', records: [{ code: 'MAT-001' }] }),
    UnsupportedAdapterOperationError,
    'staging source is read-only',
  )

  const broken = createMetaSheetStagingSourceAdapter({
    system: createSystem(),
    context: { api: { multitable: { records: {} } } },
  })
  await assert.rejects(
    () => broken.testConnection(),
    AdapterValidationError,
    'missing records API is reported as adapter validation error',
  )

  console.log('✓ metasheet-staging-source-adapter: read-only multitable source tests passed')
}

main().catch((err) => {
  console.error('✗ metasheet-staging-source-adapter FAILED')
  console.error(err)
  process.exit(1)
})
