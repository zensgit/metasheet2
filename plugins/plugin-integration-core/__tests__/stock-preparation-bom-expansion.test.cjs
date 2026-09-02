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

// The C3 planner, required HERE so one test can carry a declared source column the whole way:
// source row -> expansion row -> the record actually written to plm_stock_preparation_main. Each
// leg has its own suite; only an end-to-end assertion catches a value that is read and then dropped
// at the hand-off, which is exactly what happened to 规格 before 备料主表 had a column for it.
const { planStockPreparationConflicts } = require(path.join(__dirname, '..', 'lib', 'stock-preparation-conflict-planner.cjs'))

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

async function testSourceRowsResolveCaseVariantFieldKeys() {
  {
    const { adapter } = createAdapter(baseData({
      DN_PDM_OrderHeadInfo: [{ obj_id: 'ORDER-1', path_id: 'PATH-1' }],
    }))
    const result = await expandPlmProjectBom({ sourceAdapter: adapter, projectNo: 'P-001' })

    assert.equal(result.valid, true)
    assert.equal(result.status, 'expanded')
    assert.ok(
      !result.rowErrors.some((error) => error.type === 'missing_order_id'),
      'case-variant order id must not fail as missing_order_id',
    )
    assert.equal(result.rows.length, 2)
  }

  {
    const { adapter } = createAdapter(baseData({
      DN_PDM_OrderHeadInfo: [{ OBJ_ID: 'ORDER-1', obj_id: 'SHOULD_NOT_WIN', path_id: 'PATH-1' }],
    }))
    const result = await expandPlmProjectBom({ sourceAdapter: adapter, projectNo: 'P-001' })

    assert.equal(result.valid, true)
    assert.equal(result.status, 'expanded')
    assert.equal(
      result.rows.length,
      2,
      'exact field key wins over a case-variant sibling; fallback must not retarget to SHOULD_NOT_WIN',
    )
  }

  {
    const { adapter } = createAdapter(baseData({
      DN_PDM_OrderHeadInfo: [{ obj_id: 'ORDER-1', Obj_Id: 'ORDER-ALT', path_id: 'PATH-1' }],
    }))
    const result = await expandPlmProjectBom({ sourceAdapter: adapter, projectNo: 'P-001' })

    assert.equal(result.valid, false)
    assert.ok(
      result.rowErrors.some((error) => error.type === 'missing_order_id'),
      'ambiguous case-variant field keys fail closed instead of picking the first value',
    )
    assert.equal(result.rows.length, 0)
  }
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

// Hold-not-zero: a SQL NULL or blank Bom_ExAttr1 / order-detail quantity must
// never silently coerce to 0 (Number(null) === 0 and Number('') === 0 are both
// finite). Before this fix that zero multiplied down through every descendant
// (totalQuantity = parent x 0), silently zeroing an entire subtree's demand —
// the customer's legacy system's exact hazard. A row whose SOURCE quantity is
// genuinely blank/null must be held as invalid_quantity, never planned as a
// writable 0. A row whose source quantity is a STATED numeric 0 is a real
// measured zero and must keep expanding exactly as before.
async function testBlankOrNullQuantityHeldNotZeroed() {
  function threeLevelData(bomExAttr1AtMidTree, orderDetailQuantity = '2') {
    return baseData({
      DN_PDM_OrderDetailInfo: [{ order_id: 'ORDER-1', part_id: 'PART-A', quantity: orderDetailQuantity }],
      DN_PDM_PartLibraryInfo: [
        { OBJ_ID: 'PART-A', IdentityNo: 'A-001', IdentityName: 'Assembly', Material: 'Steel', SysVer: 'V1' },
        { OBJ_ID: 'PART-B', IdentityNo: 'B-001', IdentityName: 'Sub-assembly', Material: 'Iron', SysVer: 'V1' },
        { OBJ_ID: 'PART-C', IdentityNo: 'C-001', IdentityName: 'Fastener', Material: 'Copper', SysVer: 'V1' },
      ],
      DN_PDM_BomHeadInfo: [
        { part_id: 'PART-A', bom_id: 'BOM-A', SysVer: 'V1', bom_able: true },
        { part_id: 'PART-B', bom_id: 'BOM-B', SysVer: 'V1', bom_able: true },
      ],
      DN_PDM_BomDetailsInfo: [
        { bom_pid: 'BOM-A', part_id: 'PART-B', Bom_ExAttr1: bomExAttr1AtMidTree, sort_id: 1 },
        { bom_pid: 'BOM-B', part_id: 'PART-C', Bom_ExAttr1: '4', sort_id: 1 },
      ],
    })
  }

  // (1) NULL quantity on a mid-tree node (PART-B, depth 1, with its own child
  // PART-C beneath it): the row errors as invalid_quantity and the subtree
  // (PART-C) must never be read or expanded with a silently zeroed total.
  {
    const { adapter, calls } = createAdapter(threeLevelData(null))
    const result = await expandPlmProjectBom({ sourceAdapter: adapter, projectNo: 'P-001' })

    assert.equal(result.valid, false)
    assert.ok(
      result.rowErrors.some((error) => error.type === 'invalid_quantity' && error.relation === 'child' && error.depth === 1),
      'a null mid-tree Bom_ExAttr1 is held as invalid_quantity, not coerced to 0',
    )
    assert.ok(!result.rows.some((row) => row.componentSourceId === 'PART-B'), 'the zero-quantity mid-tree row itself is never pushed')
    assert.ok(!result.rows.some((row) => row.componentSourceId === 'PART-C'), 'PART-C subtree is never read once its parent quantity is held')
    assert.ok(!calls.some((call) => call.object === 'DN_PDM_BomHeadInfo' && call.filters.part_id === 'PART-B'), 'expansion never descends into the held node to read its subtree')
    assert.ok(!result.rows.some((row) => row.totalQuantity === 0), 'no row anywhere in this run carries a silently-zeroed totalQuantity')
  }

  // (2) Blank-string quantity on the same mid-tree node: identical hold.
  {
    const { adapter } = createAdapter(threeLevelData(''))
    const result = await expandPlmProjectBom({ sourceAdapter: adapter, projectNo: 'P-001' })

    assert.equal(result.valid, false)
    assert.ok(
      result.rowErrors.some((error) => error.type === 'invalid_quantity' && error.relation === 'child' && error.depth === 1),
      'a blank-string mid-tree Bom_ExAttr1 is held as invalid_quantity, not coerced to 0',
    )
    assert.ok(!result.rows.some((row) => row.componentSourceId === 'PART-B'))
    assert.ok(!result.rows.some((row) => row.componentSourceId === 'PART-C'))
    assert.ok(!result.rows.some((row) => row.totalQuantity === 0))
  }

  // Whitespace-only counts as blank too (isBlank trims before checking).
  {
    const { adapter } = createAdapter(threeLevelData('   '))
    const result = await expandPlmProjectBom({ sourceAdapter: adapter, projectNo: 'P-001' })

    assert.equal(result.valid, false)
    assert.ok(result.rowErrors.some((error) => error.type === 'invalid_quantity' && error.relation === 'child'))
  }

  // (3) A STATED numeric 0 mid-tree quantity is a real measured zero: it must
  // keep expanding exactly as before, multiplying down as 0 (not held).
  {
    const { adapter } = createAdapter(threeLevelData(0))
    const result = await expandPlmProjectBom({ sourceAdapter: adapter, projectNo: 'P-001' })

    assert.equal(result.valid, true, 'a stated numeric 0 is a valid measured quantity, not an error')
    assert.equal(result.status, 'expanded')
    assert.ok(!result.rowErrors.some((error) => error.type === 'invalid_quantity'))
    const partB = result.rows.find((row) => row.componentSourceId === 'PART-B')
    const partC = result.rows.find((row) => row.componentSourceId === 'PART-C')
    assert.ok(partB, 'PART-B still expands on a stated zero')
    assert.equal(partB.rawQuantity, 0)
    assert.equal(partB.totalQuantity, 0, 'stated zero multiplies down exactly as before')
    assert.ok(partC, 'PART-C subtree still expands beneath a stated zero')
    assert.equal(partC.totalQuantity, 0)
  }

  // Root order-detail quantity is the same parseQuantity() call site (relation
  // 'root'): null/blank must hold there too, and a stated 0 must still expand.
  {
    const { adapter } = createAdapter(threeLevelData('4', null))
    const result = await expandPlmProjectBom({ sourceAdapter: adapter, projectNo: 'P-001' })
    assert.equal(result.valid, false)
    assert.ok(result.rowErrors.some((error) => error.type === 'invalid_quantity' && error.relation === 'root'))
    assert.equal(result.rows.length, 0, 'a null root order-detail quantity holds before any row is pushed')
  }

  {
    const { adapter } = createAdapter(threeLevelData('4', ''))
    const result = await expandPlmProjectBom({ sourceAdapter: adapter, projectNo: 'P-001' })
    assert.equal(result.valid, false)
    assert.ok(result.rowErrors.some((error) => error.type === 'invalid_quantity' && error.relation === 'root'))
    assert.equal(result.rows.length, 0)
  }

  {
    const { adapter } = createAdapter(threeLevelData('4', 0))
    const result = await expandPlmProjectBom({ sourceAdapter: adapter, projectNo: 'P-001' })
    assert.equal(result.valid, true, 'a stated numeric 0 root quantity is valid, not an error')
    assert.equal(result.rows[0].rawQuantity, 0)
    assert.equal(result.rows[0].totalQuantity, 0)
  }

  // (4) The existing not-a-number case is a different failure (garbled value,
  // not absent) and must keep failing exactly as before — untouched by this
  // fix. (Locked already in testFailClosedGuards; reasserted here for locality.)
  {
    const { adapter } = createAdapter(threeLevelData('4', 'not-a-number'))
    const result = await expandPlmProjectBom({ sourceAdapter: adapter, projectNo: 'P-001' })
    assert.equal(result.valid, false)
    assert.ok(result.rowErrors.some((error) => error.type === 'invalid_quantity' && error.relation === 'root'))
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

// 规格 and the material creation time: DECLARED on the read plan, DEFAULTED TO ABSENT.
//
// Neither is a core role of this vendor family (source-vendor-presets/dn-pdm-family.preset.json
// declares exactly rowId/id/code/name/material/version on the part table). Where they live is a
// per-deployment reading — a native view column on the measured customer catalog, a dictionary-
// assigned generic slot on a stock one — so the shipped plan pins NEITHER. A deployment that has
// them says so; one that does not gets absence, never a guessed column.
async function testSpecAndCreateTimeAreDeclaredNotGuessed() {
  // (1) UNDECLARED — the shipped default. The row must be byte-identical to the pre-change one:
  //     no `spec` key, no `createTime` key, not even an empty one.
  const undeclared = await expandPlmProjectBom({
    sourceAdapter: createAdapter(baseData({
      DN_PDM_PartLibraryInfo: [
        { OBJ_ID: 'PART-A', IdentityNo: 'A-001', IdentityName: 'Assembly', Material: 'Steel', SysVer: 'V1', Specification: 'DN1200', Createtime: '2026-08-30T09:15:00' },
        { OBJ_ID: 'PART-B', IdentityNo: 'B-001', IdentityName: 'Bolt', Material: 'Iron', SysVer: 'V1', Specification: 'M20', Createtime: '2026-08-30T09:40:00' },
      ],
    })).adapter,
    projectNo: 'P-001',
  })
  assert.equal(undeclared.valid, true)
  for (const row of undeclared.rows) {
    assert.ok(!('spec' in row), 'an undeclared spec slot must not be guessed off a same-named column')
    assert.ok(!('createTime' in row), 'an undeclared createTime slot must not be guessed either')
  }

  // (2) DECLARED — the same source rows, now with the deployment naming its own columns.
  const plan = clone(PLM_STOCK_PREPARATION_BOM_READ_PLAN)
  plan.part.specField = 'Specification'
  plan.part.createTimeField = 'Createtime'
  const declared = await expandPlmProjectBom({
    sourceAdapter: createAdapter(baseData({
      DN_PDM_PartLibraryInfo: [
        { OBJ_ID: 'PART-A', IdentityNo: 'A-001', IdentityName: 'Assembly', Material: 'Steel', SysVer: 'V1', Specification: 'DN1200', Createtime: '2026-08-30T09:15:00' },
        { OBJ_ID: 'PART-B', IdentityNo: 'B-001', IdentityName: 'Bolt', Material: 'Iron', SysVer: 'V1', Specification: 'M20', Createtime: '2026-08-30T09:40:00' },
      ],
    })).adapter,
    projectNo: 'P-001',
    readPlan: plan,
  })
  assert.equal(declared.valid, true)
  assert.equal(declared.rows[0].spec, 'DN1200', '规格 rides the expansion row once declared')
  assert.equal(declared.rows[0].createTime, '2026-08-30T09:15:00', 'the material creation time rides it too')
  assert.equal(declared.rows[1].spec, 'M20')

  // (3) DECLARED but EMPTY on the source row — absence, never an empty string on the row.
  const declaredButBlank = await expandPlmProjectBom({
    sourceAdapter: createAdapter(baseData({
      DN_PDM_PartLibraryInfo: [
        { OBJ_ID: 'PART-A', IdentityNo: 'A-001', IdentityName: 'Assembly', Material: 'Steel', SysVer: 'V1', Specification: '   ', Createtime: null },
        { OBJ_ID: 'PART-B', IdentityNo: 'B-001', IdentityName: 'Bolt', Material: 'Iron', SysVer: 'V1' },
      ],
    })).adapter,
    projectNo: 'P-001',
    readPlan: plan,
  })
  assert.equal(declaredButBlank.valid, true, 'a declared column the source leaves empty is not an error')
  for (const row of declaredButBlank.rows) {
    assert.ok(!('spec' in row), 'a blank declared spec is absent, not an empty string')
    assert.ok(!('createTime' in row), 'a null declared createTime is absent')
  }

  // (4) The evidence must not start leaking the new values.
  const evidenceJson = JSON.stringify(summarizeBomExpansionForEvidence(declared))
  assert.ok(!evidenceJson.includes('DN1200'), 'evidence hides 规格')
  assert.ok(!evidenceJson.includes('2026-08-30'), 'evidence hides the creation time')

  // (5) The DECLARED batch rule survives plan normalization — it is the deployment's one
  //     configuration surface, so dropping it here would make the rule unreachable.
  assert.equal(normalizeStockPreparationBomReadPlan(plan).batchIdentity, undefined, 'absent stays absent')
  assert.deepEqual(
    normalizeStockPreparationBomReadPlan({ ...plan, batchIdentity: { mode: 'material_create_hour' } }).batchIdentity,
    { mode: 'material_create_hour' },
  )
  assert.deepEqual(
    normalizeStockPreparationBomReadPlan(plan).part,
    { object: 'DN_PDM_PartLibraryInfo', idField: 'OBJ_ID', codeField: 'IdentityNo', nameField: 'IdentityName', materialField: 'Material', versionField: 'SysVer', specField: 'Specification', createTimeField: 'Createtime' },
    'both declared slots survive normalization as safe identifiers',
  )
  assert.throws(
    () => normalizeStockPreparationBomReadPlan({ ...plan, part: { ...plan.part, specField: 'Specification;DROP' } }),
    StockPreparationBomExpansionError,
    'a declared spec slot is still held to the safe-identifier rule',
  )
}

// THE LAST MILE: a declared NATIVE source column reaches the 备料 WORKING SHEET.
//
// testSpecAndCreateTimeAreDeclaredNotGuessed above proves the declared slot reaches the EXPANSION
// ROW. This one carries it the rest of the way — expansion -> conflict plan -> the row that is
// written to plm_stock_preparation_main — because until 备料主表 gained `componentSpec` the value
// was read from the source and then dropped on the floor at exactly this step.
//
// The declared column is spelled `Specification`, a PLAIN NATIVE COLUMN NAME on the part object.
// That is the measured shape on the customer catalog (docs/development/takeover-beiliao-20260821/
// onsite-connection-test-runbook-20260901.md §0/§4), and the point of the assertion is that the
// DECLARED-SLOT design expresses it directly: `readPlan.part.specField` is a column name, exactly
// like the `codeField: 'IdentityNo'` / `materialField: 'Material'` next to it. No dictionary
// indirection is required for a deployment whose 规格 is a native column, and none is assumed for
// one whose 规格 is a dictionary slot — the plan names whichever the deployment actually has.
async function testDeclaredNativeSpecColumnReachesTheMainTableRow() {
  const plan = clone(PLM_STOCK_PREPARATION_BOM_READ_PLAN)
  plan.part.specField = 'Specification'
  const expansion = await expandPlmProjectBom({
    sourceAdapter: createAdapter(baseData({
      DN_PDM_PartLibraryInfo: [
        { OBJ_ID: 'PART-A', IdentityNo: 'A-001', IdentityName: 'Assembly', Material: 'Steel', SysVer: 'V1', Specification: 'DN1200' },
        { OBJ_ID: 'PART-B', IdentityNo: 'B-001', IdentityName: 'Bolt', Material: 'Iron', SysVer: 'V1', Specification: 'M20' },
      ],
    })).adapter,
    projectNo: 'P-001',
    readPlan: plan,
  })
  assert.equal(expansion.valid, true)

  const conflictPlan = planStockPreparationConflicts({
    expandedRows: expansion.rows,
    existingRows: [],
    rowErrors: expansion.rowErrors,
    runId: 'run-native-spec',
    plannedAt: '2026-09-02T00:00:00.000Z',
  })
  const records = conflictPlan.decisions.filter((decision) => decision.decision === 'add').map((decision) => decision.record)
  assert.ok(records.length >= 2, 'the expanded rows become main-table writes')

  const root = records.find((record) => record.componentCode === 'A-001')
  const child = records.find((record) => record.componentCode === 'B-001')
  assert.ok(root && child, 'both the root and its child are written')

  // 规格 — read from the declared NATIVE column, all the way onto the working sheet.
  assert.equal(root.componentSpec, 'DN1200', '规格 reaches 备料主表 from a declared native column')
  assert.equal(child.componentSpec, 'M20')

  // 父组件图号 / 父组件名称 — resolved from the in-batch parent, which is the only place they
  // exist (the expansion carries the parent as an OBJ_ID).
  assert.equal(child.parentComponentCode, 'A-001', '父组件图号 reaches 备料主表')
  assert.equal(child.parentComponentName, 'Assembly', '父组件名称 reaches 备料主表')
  assert.equal(Object.prototype.hasOwnProperty.call(root, 'parentComponentCode'), false, 'the root has no parent — absence, not a blank')

  // All seven, on one written row, from one pull.
  for (const fieldId of ['parentComponentCode', 'parentComponentName', 'componentCode', 'componentName', 'componentSpec', 'material', 'totalQuantity']) {
    assert.ok(child[fieldId] !== undefined && child[fieldId] !== null && child[fieldId] !== '', `the seven fields all land: ${fieldId}`)
  }

  // UNDECLARED is still absence, end to end — a deployment whose 规格 lives somewhere else gets an
  // empty column, not a guess off a same-named source column and not a failure.
  const undeclared = await expandPlmProjectBom({
    sourceAdapter: createAdapter(baseData({
      DN_PDM_PartLibraryInfo: [
        { OBJ_ID: 'PART-A', IdentityNo: 'A-001', IdentityName: 'Assembly', Material: 'Steel', SysVer: 'V1', Specification: 'DN1200' },
        { OBJ_ID: 'PART-B', IdentityNo: 'B-001', IdentityName: 'Bolt', Material: 'Iron', SysVer: 'V1', Specification: 'M20' },
      ],
    })).adapter,
    projectNo: 'P-001',
  })
  const undeclaredPlan = planStockPreparationConflicts({
    expandedRows: undeclared.rows,
    existingRows: [],
    rowErrors: undeclared.rowErrors,
    runId: 'run-no-native-spec',
    plannedAt: '2026-09-02T00:00:00.000Z',
  })
  assert.equal(undeclaredPlan.valid, true, 'no declared spec slot is not an error')
  for (const decision of undeclaredPlan.decisions.filter((d) => d.decision === 'add')) {
    assert.equal(Object.prototype.hasOwnProperty.call(decision.record, 'componentSpec'), false, 'no 规格 cell is invented')
    // ...while the parent columns, which need no declaration, still land.
    if (decision.record.componentCode === 'B-001') {
      assert.equal(decision.record.parentComponentCode, 'A-001', '父组件图号 needs no per-deployment declaration')
    }
  }
}

async function main() {
  await testSpecAndCreateTimeAreDeclaredNotGuessed()
  await testDeclaredNativeSpecColumnReachesTheMainTableRow()
  await testSuccessfulExpansion()
  await testReadFailureDiagnosticsAreValuesFree()
  await testNoHit()
  await testSourceRowsResolveCaseVariantFieldKeys()
  await testSameComponentUnderDifferentParentsStaysDistinct()
  await testFailClosedGuards()
  await testBlankOrNullQuantityHeldNotZeroed()
  await testScaleLimitsRemainDiagnosableAndValuesFree()
  testReadPlanValidation()

  console.log('stock-preparation-bom-expansion.test.cjs OK')
}

main().catch((err) => {
  console.error('stock-preparation-bom-expansion.test.cjs FAILED')
  console.error(err)
  process.exit(1)
})
