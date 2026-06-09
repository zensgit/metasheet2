'use strict'

// #2253 C2 tests: projectNo -> PLM BOM dry-run expansion helper. Locks the
// runtime slice while keeping it write-free: every PLM lookup goes through
// sourceAdapter.read({ object, filters }), no raw SQL / joins / stored procs,
// no MetaSheet write, no K3.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  PLM_STOCK_PREPARATION_BOM_READ_PLAN,
  StockPreparationBomExpansionError,
  normalizeStockPreparationBomReadPlan,
  expandPlmProjectBom,
  summarizeBomExpansionForEvidence,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-bom-expansion.cjs'))

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function createAdapter(data) {
  const calls = []
  const adapter = {
    async read(input = {}) {
      calls.push(clone(input))
      assert.ok(input.object, 'read object is required')
      assert.ok(input.filters && Object.keys(input.filters).length > 0, `read(${input.object}) must carry equality filters`)
      const rows = Array.isArray(data[input.object]) ? data[input.object] : []
      const matches = rows.filter((row) =>
        Object.entries(input.filters).every(([field, expected]) => row[field] === expected),
      )
      const offset = input.cursor ? Number(input.cursor) : 0
      const limit = input.limit || matches.length || 1000
      const records = matches.slice(offset, offset + limit).map(clone)
      return {
        records,
        nextCursor: records.length >= limit && offset + records.length < matches.length ? String(offset + records.length) : null,
        done: offset + records.length >= matches.length,
        metadata: {
          source: 'bridge:legacy-sql-readonly',
          filtersApplied: true,
          filterFields: Object.keys(input.filters || {}).sort(),
        },
      }
    },
  }
  return { adapter, calls }
}

function baseData(overrides = {}) {
  return {
    DN_PDM_PathExAttrInfo: [{ FileCode: 'P-001', Parent_OBJ_ID: 'PATH-1' }],
    DN_PDM_PathInfo: [{ OBJ_ID: 'PATH-1' }],
    DN_PDM_OrderHeadInfo: [{ OBJ_ID: 'ORDER-1', path_id: 'PATH-1' }],
    DN_PDM_OrderDetailInfo: [{ order_id: 'ORDER-1', part_id: 'PART-A', quantity: '2', sort_id: 1 }],
    DN_PDM_PartLibraryInfo: [
      { OBJ_ID: 'PART-A', IdentityNo: 'A-001', IdentityName: 'Assembly', Material: 'Steel', SysVer: 'V1' },
      { OBJ_ID: 'PART-B', IdentityNo: 'B-001', IdentityName: 'Bolt', Material: 'Iron', SysVer: 'V1' },
    ],
    DN_PDM_BomHeadInfo: [{ part_id: 'PART-A', bom_id: 'BOM-A', SysVer: 'V1', bom_able: true }],
    DN_PDM_BomDetailsInfo: [{ bom_pid: 'BOM-A', part_id: 'PART-B', Bom_ExAttr1: '3', sort_id: 1 }],
    ...overrides,
  }
}

async function testSuccessfulExpansion() {
  const { adapter, calls } = createAdapter(baseData())
  const result = await expandPlmProjectBom({ sourceAdapter: adapter, projectNo: ' P-001 ', pageLimit: 1 })

  assert.equal(result.valid, true)
  assert.equal(result.status, 'expanded')
  assert.equal(result.rows.length, 2, 'root + one child')
  assert.equal(result.rows[0].componentSourceId, 'PART-A')
  assert.equal(result.rows[0].parentSourceId, null)
  assert.equal(result.rows[0].depth, 0)
  assert.equal(result.rows[0].rawQuantity, 2)
  assert.equal(result.rows[0].totalQuantity, 2)
  assert.equal(result.rows[1].componentSourceId, 'PART-B')
  assert.equal(result.rows[1].parentSourceId, 'PART-A')
  assert.equal(result.rows[1].depth, 1)
  assert.equal(result.rows[1].rawQuantity, 3)
  assert.equal(result.rows[1].totalQuantity, 6)
  assert.notEqual(result.rows[0].idempotencyKey, result.rows[1].idempotencyKey)
  assert.deepEqual(JSON.parse(result.rows[1].path), ['PART-A', 'PART-B'])

  const pathRead = calls.find((call) => call.object === 'DN_PDM_PathExAttrInfo')
  assert.deepEqual(pathRead.filters, { FileCode: 'P-001' }, 'projectNo is an exact FileCode equality filter')
  assert.ok(calls.some((call) => call.object === 'DN_PDM_BomHeadInfo' && call.filters.part_id === 'PART-A' && call.filters.SysVer === 'V1'), 'child BOM head read is filtered by parent part + version')
  assert.equal(calls.every((call) => !('rawSql' in call) && !('sql' in call) && !('query' in call)), true, 'reads never carry raw SQL/query')

  const evidence = summarizeBomExpansionForEvidence(result)
  const evidenceJson = JSON.stringify(evidence)
  assert.equal(evidence.valid, true)
  assert.equal(evidence.rowsExpanded, 2)
  assert.ok(evidence.readDiagnostics.some((entry) =>
    entry.object === 'DN_PDM_PathExAttrInfo' &&
    entry.status === 'ok' &&
    entry.filtersApplied === true &&
    entry.filterFields.includes('FileCode'),
  ), 'values-free evidence exposes Bridge filtered-read diagnostics')
  assert.ok(!evidenceJson.includes('P-001'), 'evidence hides project value')
  assert.ok(!evidenceJson.includes('PART-A'), 'evidence hides component source ids')
  assert.ok(!evidenceJson.includes('Assembly'), 'evidence hides component names')
}

async function testReadFailureDiagnosticsAreValuesFree() {
  const adapter = {
    async read() {
      const error = new Error('driver failure for P-001 and PART-A')
      error.code = 'BRIDGE_DB_QUERY_FAILED'
      throw error
    },
  }
  const result = await expandPlmProjectBom({ sourceAdapter: adapter, projectNo: 'P-001' })
  const evidence = summarizeBomExpansionForEvidence(result)
  const text = JSON.stringify(evidence)

  assert.equal(evidence.valid, false)
  assert.deepEqual(evidence.errorTypes, ['read_failed'])
  assert.deepEqual(evidence.readDiagnostics, [{
    object: 'DN_PDM_PathExAttrInfo',
    filterFields: ['FileCode'],
    cursor: null,
    status: 'failed',
    filtersSent: true,
    errorCode: 'BRIDGE_DB_QUERY_FAILED',
  }])
  assert.equal(text.includes('P-001'), false, 'read failure evidence hides project value')
  assert.equal(text.includes('PART-A'), false, 'read failure evidence hides error-message row values')
}

async function testNoHit() {
  const { adapter } = createAdapter(baseData({ DN_PDM_PathExAttrInfo: [] }))
  const result = await expandPlmProjectBom({ sourceAdapter: adapter, projectNo: 'P-404' })
  assert.equal(result.valid, true)
  assert.equal(result.status, 'not_found')
  assert.equal(result.rows.length, 0)
  assert.deepEqual(result.summary.actions, { add: 0, update: 0, skip: 0, inactive: 0, manualConfirm: 0 })
}

async function testSameComponentUnderDifferentParentsStaysDistinct() {
  const data = baseData({
    DN_PDM_OrderDetailInfo: [
      { order_id: 'ORDER-1', part_id: 'PART-A', quantity: '1' },
      { order_id: 'ORDER-1', part_id: 'PART-D', quantity: '1' },
    ],
    DN_PDM_PartLibraryInfo: [
      { OBJ_ID: 'PART-A', IdentityNo: 'A-001', IdentityName: 'Parent A', Material: 'Steel', SysVer: 'V1' },
      { OBJ_ID: 'PART-D', IdentityNo: 'D-001', IdentityName: 'Parent D', Material: 'Steel', SysVer: 'V1' },
      { OBJ_ID: 'PART-C', IdentityNo: 'C-001', IdentityName: 'Shared Child', Material: 'Copper', SysVer: 'V1' },
    ],
    DN_PDM_BomHeadInfo: [
      { part_id: 'PART-A', bom_id: 'BOM-A', SysVer: 'V1', bom_able: true },
      { part_id: 'PART-D', bom_id: 'BOM-D', SysVer: 'V1', bom_able: true },
    ],
    DN_PDM_BomDetailsInfo: [
      { bom_pid: 'BOM-A', part_id: 'PART-C', Bom_ExAttr1: '2' },
      { bom_pid: 'BOM-D', part_id: 'PART-C', Bom_ExAttr1: '3' },
    ],
  })
  const { adapter } = createAdapter(data)
  const result = await expandPlmProjectBom({ sourceAdapter: adapter, projectNo: 'P-001' })
  assert.equal(result.valid, true)
  const sharedRows = result.rows.filter((row) => row.componentSourceId === 'PART-C')
  assert.equal(sharedRows.length, 2, 'same component under different parents remains two rows')
  assert.deepEqual(sharedRows.map((row) => row.parentSourceId).sort(), ['PART-A', 'PART-D'])
  assert.notEqual(sharedRows[0].idempotencyKey, sharedRows[1].idempotencyKey)
}

async function testFailClosedGuards() {
  await assert.rejects(
    () => expandPlmProjectBom({ sourceAdapter: createAdapter(baseData()).adapter, projectNo: '   ' }),
    /projectNo is required/,
    'blank projectNo rejects',
  )

  {
    const { adapter } = createAdapter(baseData())
    const result = await expandPlmProjectBom({ sourceAdapter: adapter, projectNo: 'P-001', maxDepth: 1 })
    assert.equal(result.valid, true, 'depth 1 permits the one child')
    const failed = await expandPlmProjectBom({ sourceAdapter: adapter, projectNo: 'P-001', maxDepth: 0 })
    assert.equal(failed.valid, false)
    assert.ok(failed.errors.some((error) => error.type === 'max_depth_exceeded'))
  }

  {
    const { adapter } = createAdapter(baseData({
      DN_PDM_BomDetailsInfo: [],
    }))
    const result = await expandPlmProjectBom({ sourceAdapter: adapter, projectNo: 'P-001' })
    const evidence = summarizeBomExpansionForEvidence(result)
    const text = JSON.stringify(evidence)

    assert.equal(result.valid, false)
    assert.equal(result.status, 'failed')
    assert.ok(
      result.rowErrors.some((error) => error.type === 'missing_child_bom' && error.field === 'bom_pid'),
      'active BOM head with no details is held as missing_child_bom, not guessed as a complete leaf',
    )
    assert.deepEqual(evidence.errorTypes, ['missing_child_bom'])
    assert.equal(evidence.largeBom, false, 'source-incomplete child BOM is not relabeled as a scale-bounded large BOM')
    assert.equal(text.includes('P-001'), false, 'missing child BOM evidence hides project value')
    assert.equal(text.includes('PART-A'), false, 'missing child BOM evidence hides component source id')
    assert.equal(text.includes('BOM-A'), false, 'missing child BOM evidence hides BOM id')
  }

  {
    const { adapter } = createAdapter(baseData())
    const result = await expandPlmProjectBom({ sourceAdapter: adapter, projectNo: 'P-001', maxRows: 1 })
    assert.equal(result.valid, false)
    assert.ok(result.errors.some((error) => error.type === 'max_rows_exceeded'))
    assert.equal(result.rows.length, 1, 'rows before the guard are visible but not valid')
  }

  {
    const { adapter } = createAdapter(baseData({
      DN_PDM_BomDetailsInfo: [{ bom_pid: 'BOM-A', part_id: 'PART-A', Bom_ExAttr1: '1' }],
    }))
    const result = await expandPlmProjectBom({ sourceAdapter: adapter, projectNo: 'P-001' })
    assert.equal(result.valid, false)
    assert.ok(result.errors.some((error) => error.type === 'cycle_detected'))
  }

  {
    const { adapter } = createAdapter(baseData({
      DN_PDM_OrderDetailInfo: [{ order_id: 'ORDER-1', part_id: 'PART-A', quantity: 'not-a-number' }],
    }))
    const result = await expandPlmProjectBom({ sourceAdapter: adapter, projectNo: 'P-001' })
    assert.equal(result.valid, false)
    assert.ok(result.rowErrors.some((error) => error.type === 'invalid_quantity' && error.relation === 'root'))
    assert.equal(result.rows.length, 0)
  }

  {
    const { adapter } = createAdapter(baseData({
      DN_PDM_PartLibraryInfo: [
        { OBJ_ID: 'PART-A', IdentityNo: 'A-001', IdentityName: 'Assembly 1', Material: 'Steel', SysVer: 'V1' },
        { OBJ_ID: 'PART-A', IdentityNo: 'A-002', IdentityName: 'Assembly 2', Material: 'Steel', SysVer: 'V1' },
      ],
    }))
    const result = await expandPlmProjectBom({ sourceAdapter: adapter, projectNo: 'P-001' })
    assert.equal(result.valid, false)
    assert.ok(result.rowErrors.some((error) => error.type === 'ambiguous_component'), 'duplicate OBJ_ID lookup never pick-firsts')
    assert.equal(result.rows.length, 0)
  }
}

async function testScaleLimitsRemainDiagnosableAndValuesFree() {
  {
    const { adapter } = createAdapter(baseData({
      DN_PDM_PathExAttrInfo: [
        { FileCode: 'P-001', Parent_OBJ_ID: 'PATH-1' },
        { FileCode: 'P-001', Parent_OBJ_ID: 'PATH-2' },
      ],
    }))
    const result = await expandPlmProjectBom({
      sourceAdapter: adapter,
      projectNo: 'P-001',
      pageLimit: 1,
      maxPages: 1,
    })
    const evidence = summarizeBomExpansionForEvidence(result)

    assert.equal(result.valid, false)
    assert.deepEqual(evidence.errorTypes, ['read_page_limit_exceeded'])
    assert.equal(evidence.largeBom, true)
    assert.deepEqual(evidence.boundedPreview.errorTypes, ['read_page_limit_exceeded'])
    assert.equal(evidence.boundedPreview.complete, false)
    assert.equal(evidence.boundedPreview.authoritative, false)
    assert.equal(evidence.boundedPreview.maxPages, 1)
    assert.equal(JSON.stringify(evidence).includes('PATH-'), false, 'page-limit evidence hides PLM row values')
  }

  {
    const { adapter } = createAdapter(baseData())
    const result = await expandPlmProjectBom({
      sourceAdapter: adapter,
      projectNo: 'P-001',
      maxReadCount: 1,
    })
    const evidence = summarizeBomExpansionForEvidence(result)

    assert.equal(result.valid, false)
    assert.deepEqual(evidence.errorTypes, ['read_count_exceeded'])
    assert.equal(evidence.readCount, 1)
    assert.equal(evidence.largeBom, true)
    assert.equal(evidence.boundedPreview.maxReadCount, 1)
  }

  {
    const { adapter } = createAdapter(baseData())
    const result = await expandPlmProjectBom({
      sourceAdapter: adapter,
      projectNo: 'P-001',
      maxElapsedMs: 1,
      startedAtMs: 0,
      now: () => 2,
    })
    const evidence = summarizeBomExpansionForEvidence(result)

    assert.equal(result.valid, false)
    assert.deepEqual(evidence.errorTypes, ['read_time_limit_exceeded'])
    assert.equal(evidence.readCount, 0)
    assert.equal(evidence.largeBom, true)
    assert.equal(evidence.boundedPreview.maxElapsedMs, 1)
  }

  {
    const { adapter } = createAdapter(baseData({
      DN_PDM_OrderDetailInfo: [
        { order_id: 'ORDER-1', part_id: 'PART-BAD', quantity: 'not-a-number' },
        { order_id: 'ORDER-1', part_id: 'PART-A', quantity: '1' },
        { order_id: 'ORDER-1', part_id: 'PART-B', quantity: '1' },
      ],
      DN_PDM_PartLibraryInfo: [
        { OBJ_ID: 'PART-A', IdentityNo: 'A-001', IdentityName: 'Assembly', Material: 'Steel', SysVer: 'V1' },
        { OBJ_ID: 'PART-B', IdentityNo: 'B-001', IdentityName: 'Bolt', Material: 'Iron', SysVer: 'V1' },
      ],
      DN_PDM_BomHeadInfo: [],
      DN_PDM_BomDetailsInfo: [],
    }))
    const result = await expandPlmProjectBom({ sourceAdapter: adapter, projectNo: 'P-001', maxRows: 1 })
    const evidence = summarizeBomExpansionForEvidence(result)

    assert.equal(result.valid, false)
    assert.deepEqual(evidence.errorTypes, ['invalid_quantity', 'max_rows_exceeded'])
    assert.equal(evidence.largeBom, false, 'row-level correctness errors are not relabeled as bounded large BOM')
    assert.equal(evidence.boundedPreview, undefined)
  }
}

function testReadPlanValidation() {
  const plan = clone(PLM_STOCK_PREPARATION_BOM_READ_PLAN)
  assert.equal(normalizeStockPreparationBomReadPlan(plan).matchField, 'FileCode')
  assert.equal(
    normalizeStockPreparationBomReadPlan({ ...plan, sourceKind: 'bridge:legacy-sql-readonly' }).sourceKind,
    'bridge:legacy-sql-readonly',
    'explicit Bridge source kind is accepted for the C5 source gate',
  )

  assert.throws(
    () => normalizeStockPreparationBomReadPlan({ ...plan, rawSql: 'SELECT * FROM DN_PDM_PathExAttrInfo' }),
    StockPreparationBomExpansionError,
    'raw SQL rejected',
  )
  assert.throws(
    () => normalizeStockPreparationBomReadPlan({ ...plan, pathExAttr: { ...plan.pathExAttr, object: 'DN_PDM_PathExAttrInfo;DROP' } }),
    StockPreparationBomExpansionError,
    'unsafe object identifier rejected',
  )
  assert.throws(
    () => normalizeStockPreparationBomReadPlan({ ...plan, sourceKind: 'plm:adapter' }),
    StockPreparationBomExpansionError,
    'unsupported source kind rejected',
  )
  assert.throws(
    () => normalizeStockPreparationBomReadPlan({ ...plan, bomDetail: { ...plan.bomDetail, joins: ['DN_PDM_PartLibraryInfo'] } }),
    StockPreparationBomExpansionError,
    'join descriptors rejected',
  )
}

async function main() {
  await testSuccessfulExpansion()
  await testReadFailureDiagnosticsAreValuesFree()
  await testNoHit()
  await testSameComponentUnderDifferentParentsStaysDistinct()
  await testFailClosedGuards()
  await testScaleLimitsRemainDiagnosableAndValuesFree()
  testReadPlanValidation()

  console.log('stock-preparation-bom-expansion.test.cjs OK')
}

main().catch((err) => {
  console.error('stock-preparation-bom-expansion.test.cjs FAILED')
  console.error(err)
  process.exit(1)
})
