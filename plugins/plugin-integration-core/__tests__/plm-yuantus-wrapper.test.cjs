'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const {
  AdapterValidationError,
  UnsupportedAdapterOperationError,
} = require(path.join(__dirname, '..', 'lib', 'contracts.cjs'))
const {
  createYuantusPlmWrapperAdapter,
} = require(path.join(__dirname, '..', 'lib', 'adapters', 'plm-yuantus-wrapper.cjs'))

function createSystem(config = {}) {
  return {
    id: 'plm_1',
    name: 'Yuantus PLM',
    kind: 'plm:yuantus-wrapper',
    role: 'source',
    config,
  }
}

function createPlmClient() {
  const calls = []
  return {
    calls,
    isConnected() {
      return true
    },
    async getProducts(options) {
      calls.push({ method: 'getProducts', options })
      return {
        data: [
          {
            id: 'p1',
            itemCode: 'MAT-001',
            itemName: 'Bolt',
            revision: 'A',
            unitName: 'PCS',
            categoryName: 'Fastener',
            updated_at: '2026-04-24T01:00:00.000Z',
          },
          {
            id: 'p2',
            number: 'MAT-002',
            name: 'Nut',
            rev: 'B',
            unit: 'PCS',
            updatedAt: '2026-04-24T02:00:00.000Z',
          },
        ],
        metadata: { totalCount: 4 },
      }
    },
    async getProductBOM(productId, options) {
      calls.push({ method: 'getProductBOM', productId, options })
      return {
        data: [
          {
            id: 'line_1',
            parentCode: 'ASM-001',
            componentCode: 'MAT-001',
            component_id: 'p1',
            quantity: '2',
            unit: 'PCS',
            sequence: 10,
          },
          {
            id: 'line_2',
            parentCode: 'ASM-001',
            component_code: 'MAT-002',
            component_id: 'p2',
            qty: 4,
            unit: 'PCS',
            sequence: 20,
          },
        ],
        metadata: { totalCount: 2 },
      }
    },
  }
}

async function main() {
  const plmClient = createPlmClient()
  const adapter = createYuantusPlmWrapperAdapter({
    system: createSystem(),
    plmClient,
  })

  const connection = await adapter.testConnection()
  assert.deepEqual(connection, { ok: true, connected: true })

  const objects = await adapter.listObjects()
  assert.deepEqual(objects.map((object) => object.name), ['materials', 'bom'])
  const materialSchema = await adapter.getSchema({ object: 'materials' })
  assert.ok(materialSchema.fields.some((field) => field.name === 'code'))

  const materials = await adapter.read({
    object: 'materials',
    limit: 2,
    cursor: '0',
    filters: { lifecycle: 'released' },
    watermark: { updatedAt: '2026-04-24T00:00:00.000Z' },
  })
  assert.equal(materials.records.length, 2)
  assert.equal(materials.nextCursor, '2', 'metadata totalCount drives next cursor')
  assert.equal(materials.done, false)
  assert.equal(materials.records[0].sourceSystemId, 'plm_1')
  assert.equal(materials.records[0].sourceId, 'p1')
  assert.equal(materials.records[0].code, 'MAT-001')
  assert.equal(materials.records[0].name, 'Bolt')
  assert.equal(materials.records[0].uom, 'PCS')
  assert.equal(materials.records[0].category, 'Fastener')
  assert.equal(materials.records[0].updatedAt, '2026-04-24T01:00:00.000Z')
  assert.equal(plmClient.calls[0].options.lifecycle, 'released')
  assert.deepEqual(plmClient.calls[0].options.watermark, { updatedAt: '2026-04-24T00:00:00.000Z' })

  const bom = await adapter.read({
    object: 'bom',
    limit: 10,
    filters: {
      productId: 'root',
      parentCode: 'ASM-001',
    },
  })
  assert.equal(bom.records.length, 2)
  assert.equal(bom.done, true)
  assert.equal(bom.records[0].objectType, 'bom')
  assert.equal(bom.records[0].parentCode, 'ASM-001')
  assert.equal(bom.records[0].childCode, 'MAT-001')
  assert.equal(bom.records[0].quantity, 2)
  assert.equal(bom.records[1].childCode, 'MAT-002')
  assert.equal(plmClient.calls.find((call) => call.method === 'getProductBOM').productId, 'root')

  const flatSingleLineCalls = []
  const flatSingleLineAdapter = createYuantusPlmWrapperAdapter({
    system: createSystem(),
    plmClient: {
      async getProductBOM(productId, options) {
        flatSingleLineCalls.push({ productId, options })
        return {
          data: [
            {
              id: 'flat_line_1',
              parentCode: 'ASM-001',
              componentCode: 'MAT-003',
              quantity: '1',
              items: 'not-a-tree',
            },
          ],
          metadata: { totalCount: 1 },
        }
      },
    },
  })
  const flatSingleLine = await flatSingleLineAdapter.read({
    object: 'bom',
    limit: 10,
    filters: { productId: 'root' },
  })
  assert.equal(flatSingleLine.records.length, 1, 'one flat BOM row is not mistaken for a tree')
  assert.equal(flatSingleLine.records[0].sourceId, 'flat_line_1')
  assert.equal(flatSingleLine.records[0].childCode, 'MAT-003')
  assert.equal(flatSingleLine.done, true)

  const pagedFlatAdapter = createYuantusPlmWrapperAdapter({
    system: createSystem(),
    plmClient: {
      async getProductBOM(productId, options) {
        assert.equal(productId, 'root')
        assert.equal(options.offset, 1)
        assert.equal(options.limit, 1)
        return {
          data: [
            {
              id: 'flat_line_2',
              parentCode: 'ASM-001',
              componentCode: 'MAT-004',
              quantity: '3',
            },
          ],
          metadata: { totalCount: 3 },
        }
      },
    },
  })
  const pagedFlat = await pagedFlatAdapter.read({
    object: 'bom',
    limit: 1,
    cursor: '1',
    filters: { productId: 'root' },
  })
  assert.equal(pagedFlat.records.length, 1, 'server-paged flat BOM rows are not sliced a second time')
  assert.equal(pagedFlat.records[0].childCode, 'MAT-004')
  assert.equal(pagedFlat.nextCursor, '2')

  const root = {
    id: 'asm',
    code: 'ASM-001',
    children: [
      {
        id: 'child',
        componentCode: 'MAT-005',
        quantity: 1,
        children: [],
      },
    ],
  }
  root.children[0].children.push(root)
  const cyclicTreeAdapter = createYuantusPlmWrapperAdapter({
    system: createSystem(),
    plmClient: {
      async getProductBOM() {
        return { data: [root], metadata: {} }
      },
    },
  })
  const cyclicTree = await cyclicTreeAdapter.read({
    object: 'bom',
    limit: 10,
    filters: { productId: 'root' },
  })
  assert.equal(cyclicTree.records.length, 1, 'cyclic BOM tree does not recurse forever')
  assert.equal(cyclicTree.records[0].parentCode, 'ASM-001')
  assert.equal(cyclicTree.records[0].childCode, 'MAT-005')

  const invalidMaterial = createYuantusPlmWrapperAdapter({
    system: createSystem(),
    plmClient: {
      async getProducts() {
        return { data: [{ name: 'Missing code' }], metadata: {} }
      },
    },
  })
  const invalidMaterialRead = await invalidMaterial.read({ object: 'materials' }).catch((error) => error)
  assert.ok(invalidMaterialRead instanceof AdapterValidationError, 'material sourceId/code is required')

  const invalidBomQuantity = createYuantusPlmWrapperAdapter({
    system: createSystem(),
    plmClient: {
      async getProductBOM() {
        return {
          data: [
            {
              id: 'bad_qty',
              parentCode: 'ASM-001',
              componentCode: 'MAT-006',
            },
          ],
          metadata: {},
        }
      },
    },
  })
  const invalidBomRead = await invalidBomQuantity.read({
    object: 'bom',
    filters: { productId: 'root' },
  }).catch((error) => error)
  assert.ok(invalidBomRead instanceof AdapterValidationError, 'BOM quantity is required')

  const missingProduct = await adapter.read({ object: 'bom' }).catch((error) => error)
  assert.ok(missingProduct instanceof AdapterValidationError, 'BOM read requires productId')

  const unsupportedWrite = await adapter.upsert({ object: 'materials', records: [] }).catch((error) => error)
  assert.ok(unsupportedWrite instanceof UnsupportedAdapterOperationError, 'PLM wrapper is source-only')

  const configClient = createYuantusPlmWrapperAdapter({
    system: createSystem({ plmClient }),
  })
  const configClientConnection = await configClient.testConnection()
  assert.equal(configClientConnection.ok, false, 'config.plmClient is ignored to keep config data-only')
  assert.equal(configClientConnection.code, 'PLM_CLIENT_MISSING')

  const missingClient = createYuantusPlmWrapperAdapter({ system: createSystem() })
  const missingConnection = await missingClient.testConnection()
  assert.equal(missingConnection.ok, false)
  assert.equal(missingConnection.code, 'PLM_CLIENT_MISSING')

  console.log('✓ plm-yuantus-wrapper: source facade tests passed')
}

main().catch((err) => {
  console.error('✗ plm-yuantus-wrapper FAILED')
  console.error(err)
  process.exit(1)
})
