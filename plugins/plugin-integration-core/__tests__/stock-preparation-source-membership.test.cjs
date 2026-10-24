'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { expandPlmProjectBom, PLM_STOCK_PREPARATION_BOM_READ_PLAN } = require('../lib/stock-preparation-bom-expansion.cjs')
const { createLibWriteLockHarness, createConsumableStorage, createRecordsApi } = require('./support/stock-preparation-project-write-lock-kit.cjs')
const { PLM_STOCK_PREPARATION_ACTION_ID, dryRunStockPreparationAction } = require('../lib/stock-preparation-table-actions.cjs')
const { createBridgeAgentReadonlyAdapter } = require('../lib/adapters/bridge-agent-readonly-adapter.cjs')

// Synthetic source only. Each negative widens exactly ONE read predicate while
// every other source query returns complete, matching, active, valid data.
const OBJECTS = {
  pathAttr: 'DN_PDM_PathExAttrInfo', path: 'DN_PDM_PathInfo', order: 'DN_PDM_OrderHeadInfo',
  orderLine: 'DN_PDM_OrderDetailInfo', part: 'DN_PDM_PartLibraryInfo',
  head: 'DN_PDM_BomHeadInfo', detail: 'DN_PDM_BomDetailsInfo',
}

function fixture(guard) {
  const data = {
    [OBJECTS.pathAttr]: [{ FileCode: 'SYN-PROJECT', Parent_OBJ_ID: 'PATH-A' }],
    [OBJECTS.path]: [{ OBJ_ID: 'PATH-A' }],
    [OBJECTS.order]: [{ OBJ_ID: 'ORDER-A', path_id: 'PATH-A' }],
    [OBJECTS.orderLine]: [{ order_id: 'ORDER-A', part_id: 'PART-A', quantity: '2', sort_id: 1 }],
    [OBJECTS.part]: ['A', 'B', 'FOREIGN'].map((id) => ({
      OBJ_ID: `PART-${id}`, IdentityNo: `SYN-${id}`, IdentityName: `Synthetic ${id}`, Material: 'SYN-MATERIAL', SysVer: 'V1',
    })),
    [OBJECTS.head]: [{ part_id: 'PART-A', bom_id: 'BOM-A', SysVer: 'V1', bom_able: true }],
    [OBJECTS.detail]: [{ bom_pid: 'BOM-A', part_id: 'PART-B', Bom_ExAttr1: '3', sort_id: 1 }],
  }
  if (guard === 'order-path') {
    data[OBJECTS.order].push({ OBJ_ID: 'ORDER-FOREIGN', path_id: 'PATH-FOREIGN' })
    data[OBJECTS.orderLine].push({ order_id: 'ORDER-FOREIGN', part_id: 'PART-FOREIGN', quantity: '5', sort_id: 2 })
  }
  if (guard === 'order-owner') data[OBJECTS.orderLine].push({ order_id: 'ORDER-FOREIGN', part_id: 'PART-FOREIGN', quantity: '5', sort_id: 2 })
  if (guard === 'head-parent' || guard === 'head-version') {
    data[OBJECTS.head].push({ part_id: guard === 'head-parent' ? 'PART-OTHER' : 'PART-A', bom_id: 'BOM-FOREIGN', SysVer: guard === 'head-version' ? 'V2' : 'V1', bom_able: true })
    data[OBJECTS.detail].push({ bom_pid: 'BOM-FOREIGN', part_id: 'PART-FOREIGN', Bom_ExAttr1: '5', sort_id: 2 })
  }
  if (guard === 'detail-parent') data[OBJECTS.detail].push({ bom_pid: 'BOM-FOREIGN', part_id: 'PART-FOREIGN', Bom_ExAttr1: '5', sort_id: 2 })
  return data
}

function fieldValue(row, field) {
  if (Object.hasOwn(row, field)) return row[field]
  const keys = Object.keys(row).filter((key) => key.toLowerCase() === field.toLowerCase())
  return keys.length === 1 ? row[keys[0]] : undefined
}
function equalKey(left, right) {
  return left !== undefined && left !== null && right !== undefined && right !== null
    && String(left).trim() !== '' && String(left).trim() === String(right).trim()
}
function source(data, guard, filtersApplied = false, { parent = 'PART-A', bom = 'BOM-A', widen } = {}) {
  const calls = []
  return {
    calls,
    adapter: { async read(input) {
      calls.push(input)
      assert.ok(input.filters && Object.keys(input.filters).length > 0)
      const wideField = widen ? widen(input)
        : guard === 'order-path' && input.object === OBJECTS.order ? 'path_id'
          : guard === 'order-owner' && input.object === OBJECTS.orderLine ? 'order_id'
            : (guard === 'head-parent' || guard === 'head-version') && input.object === OBJECTS.head && equalKey(input.filters.part_id, parent)
              ? guard === 'head-parent' ? 'part_id' : 'SysVer'
              : guard === 'detail-parent' && input.object === OBJECTS.detail && equalKey(input.filters.bom_pid, bom) ? 'bom_pid' : undefined
      const records = data[input.object].filter((row) => Object.entries(input.filters).every(([field, value]) => field === wideField || equalKey(fieldValue(row, field), value)))
      return { records, done: true, nextCursor: null, ...(filtersApplied === 'absent' ? {} : { metadata: { filtersApplied } }) }
    } },
  }
}

const MISMATCH_READS = {
  'order-path': [OBJECTS.order, 'path_id'],
  'order-owner': [OBJECTS.orderLine, 'order_id'],
  'head-parent': [OBJECTS.head, 'part_id'],
  'head-version': [OBJECTS.head, 'SysVer'],
  'detail-parent': [OBJECTS.detail, 'bom_pid'],
}
function assertReadMismatch(result, guard, expected = MISMATCH_READS[guard]) {
  assert.equal(result.valid, false)
  assert.equal(result.status, 'failed')
  assert.deepEqual(result.errors, [{ type: 'read_row_mismatch', object: expected[0], field: expected[1], page: 0 }])
  assert.deepEqual(result.rowErrors, [])
  assert.equal(result.rows.some((row) => row.componentSourceId === 'PART-FOREIGN'), false)
}

for (const metadata of [false, true, 'absent']) for (const guard of ['none', 'order-path', 'order-owner', 'head-parent', 'head-version', 'detail-parent']) {
  test(`one-predicate ${guard}, metadata=${metadata}: no foreign row enters actual recursive expansion`, async () => {
    const fake = source(fixture(guard), guard, metadata)
    const result = await expandPlmProjectBom({ sourceAdapter: fake.adapter, projectNo: 'SYN-PROJECT', rootSelection: { enabled: false } })
    if (metadata !== false && guard !== 'none') {
      assertReadMismatch(result, guard)
      assert.ok(fake.calls.some((call) => call.object === MISMATCH_READS[guard][0]))
      return
    }
    assert.equal(result.valid, true)
    assert.deepEqual(result.errors, [])
    assert.deepEqual(result.rowErrors, [])
    assert.deepEqual(result.rows.map((row) => row.componentSourceId), ['PART-A', 'PART-B'])
    assert.deepEqual(result.rows.map((row) => row.totalQuantity), [2, 6])
    assert.ok(fake.calls.some((call) => call.object === OBJECTS.detail && call.filters.bom_pid === 'BOM-A'))
  })
}

for (const metadata of [false, true, 'absent']) for (const guard of ['head-parent', 'head-version', 'detail-parent']) {
  test(`recursive child ${guard}, metadata=${metadata}: membership is enforced below the root`, async () => {
    const data = fixture('none')
    data[OBJECTS.part].push({ OBJ_ID: 'PART-C', IdentityNo: 'SYN-C', IdentityName: 'Synthetic C', Material: 'SYN-MATERIAL', SysVer: 'V1' })
    data[OBJECTS.head].push({ part_id: 'PART-B', bom_id: 'BOM-B', SysVer: 'V1', bom_able: true })
    data[OBJECTS.detail].push({ bom_pid: 'BOM-B', part_id: 'PART-C', Bom_ExAttr1: '4', sort_id: 1 })
    if (guard !== 'detail-parent') data[OBJECTS.head].push({ part_id: guard === 'head-parent' ? 'PART-OTHER' : 'PART-B', bom_id: 'BOM-FOREIGN', SysVer: guard === 'head-version' ? 'V2' : 'V1', bom_able: true })
    data[OBJECTS.detail].push({ bom_pid: 'BOM-FOREIGN', part_id: 'PART-FOREIGN', Bom_ExAttr1: '5', sort_id: 2 })
    const fake = source(data, guard, metadata, { parent: 'PART-B', bom: 'BOM-B' })
    const result = await expandPlmProjectBom({ sourceAdapter: fake.adapter, projectNo: 'SYN-PROJECT', rootSelection: { enabled: false } })
    assert.ok(fake.calls.some((call) => call.object === OBJECTS.head && call.filters.part_id === 'PART-B'))
    if (metadata !== false) {
      assertReadMismatch(result, guard)
      return
    }
    assert.equal(result.valid, true)
    assert.deepEqual(result.rows.map((row) => row.componentSourceId), ['PART-A', 'PART-B', 'PART-C'])
    assert.deepEqual(result.rows.map((row) => row.totalQuantity), [2, 6, 24])
    assert.deepEqual(result.rows.map((row) => row.parentSourceId), [null, 'PART-A', 'PART-B'])
    assert.ok(fake.calls.some((call) => call.object === OBJECTS.head && call.filters.part_id === 'PART-B'))
  })
  test(`projectSubtree ${guard}, metadata=${metadata}: discovered roots use the guarded real expander`, async () => {
    const data = fixture(guard)
    data[OBJECTS.order] = []; data[OBJECTS.orderLine] = []
    for (const head of data[OBJECTS.head]) head.path_id = head.bom_id === 'BOM-A' ? 'PATH-A' : 'PATH-FOREIGN'
    const plan = { ...PLM_STOCK_PREPARATION_BOM_READ_PLAN, maxReadCount: 100, projectSubtree: {
      pathInfo: { parentIdField: 'Parent_OBJ_ID' }, bomHead: { pathIdField: 'path_id' }, includeSelf: true,
    } }
    const fake = source(data, guard, metadata)
    const result = await expandPlmProjectBom({ sourceAdapter: fake.adapter, projectNo: 'SYN-PROJECT', readPlan: plan })
    assert.ok(fake.calls.some((call) => call.object === OBJECTS.head && call.filters.path_id === 'PATH-A'))
    assert.ok(fake.calls.some((call) => call.object === OBJECTS.head && call.filters.part_id === 'PART-A'))
    if (metadata !== false) {
      assertReadMismatch(result, guard)
      return
    }
    assert.equal(result.valid, true)
    assert.deepEqual(result.rows.map((row) => row.componentSourceId), ['PART-A', 'PART-B'])
    assert.deepEqual(result.rows.map((row) => row.totalQuantity), [1, 3])
    assert.ok(fake.calls.some((call) => call.object === OBJECTS.head && call.filters.path_id === 'PATH-A'))
    assert.ok(fake.calls.some((call) => call.object === OBJECTS.head && call.filters.part_id === 'PART-A'))
  })
}

for (const metadata of [false, true, 'absent']) for (const guard of ['order-path', 'order-owner', 'head-parent', 'head-version', 'detail-parent']) {
  test(`renamed case-variant numeric/whitespace keys preserve membership contract: ${guard}, metadata=${metadata}`, async () => {
    const plan = JSON.parse(JSON.stringify(PLM_STOCK_PREPARATION_BOM_READ_PLAN))
    const data = fixture(guard)
    const identities = { 'PATH-A': 0, 'PATH-FOREIGN': 9, 'ORDER-A': 10, 'ORDER-FOREIGN': 19,
      'PART-A': 100, 'PART-B': 200, 'PART-FOREIGN': 900, 'PART-OTHER': 800, 'BOM-A': 300, 'BOM-FOREIGN': 399, V1: 0, V2: 1 }
    for (const section of ['pathExAttr', 'pathInfo', 'orderHead', 'orderDetail', 'part', 'bomHead', 'bomDetail']) {
      const fields = Object.fromEntries(Object.entries(plan[section]).filter(([role]) => role.endsWith('Field')).map(([role, field]) => [field, `Renamed_${section}_${role}`]))
      for (const role of Object.keys(plan[section]).filter((key) => key.endsWith('Field'))) plan[section][role] = fields[plan[section][role]]
      data[plan[section].object] = data[plan[section].object].map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [
        (fields[key] || key).toUpperCase(), Object.hasOwn(identities, value) ? identities[value] : value,
      ])))
    }
    plan.matchField = plan.pathExAttr.matchField
    // Numeric references intentionally cross string/number and transport-space forms.
    data[OBJECTS.order][0][plan.orderHead.pathIdField.toUpperCase()] = ' 0 '
    data[OBJECTS.orderLine][0][plan.orderDetail.orderIdField.toUpperCase()] = ' 10 '
    data[OBJECTS.head][0][plan.bomHead.parentPartField.toUpperCase()] = ' 100 '
    data[OBJECTS.head][0][plan.bomHead.versionField.toUpperCase()] = ' 0 '
    data[OBJECTS.detail][0][plan.bomDetail.bomParentField.toUpperCase()] = ' 300 '
    const fake = source(data, guard, metadata, { widen(input) {
      if (guard === 'order-path' && input.object === OBJECTS.order) return plan.orderHead.pathIdField
      if (guard === 'order-owner' && input.object === OBJECTS.orderLine) return plan.orderDetail.orderIdField
      if ((guard === 'head-parent' || guard === 'head-version') && input.object === OBJECTS.head && equalKey(input.filters[plan.bomHead.parentPartField], 100)) return guard === 'head-parent' ? plan.bomHead.parentPartField : plan.bomHead.versionField
      if (guard === 'detail-parent' && input.object === OBJECTS.detail && equalKey(input.filters[plan.bomDetail.bomParentField], 300)) return plan.bomDetail.bomParentField
      return undefined
    } })
    const result = await expandPlmProjectBom({ sourceAdapter: fake.adapter, projectNo: 'SYN-PROJECT', readPlan: plan, rootSelection: { enabled: false } })
    if (metadata !== false) {
      const read = {
        'order-path': [OBJECTS.order, plan.orderHead.pathIdField],
        'order-owner': [OBJECTS.orderLine, plan.orderDetail.orderIdField],
        'head-parent': [OBJECTS.head, plan.bomHead.parentPartField],
        'head-version': [OBJECTS.head, plan.bomHead.versionField],
        'detail-parent': [OBJECTS.detail, plan.bomDetail.bomParentField],
      }[guard]
      assertReadMismatch(result, guard, read)
      assert.equal(result.rows.some((row) => row.componentSourceId === '900'), false)
      return
    }
    assert.equal(result.valid, true)
    assert.deepEqual(result.rows.map((row) => row.componentSourceId), ['100', '200'])
    assert.deepEqual(result.rows.map((row) => row.totalQuantity), [2, 6])
  })
}

for (const guard of ['head-parent', 'head-version']) {
  test(`foreign ${guard} cannot create a phantom maxDepth failure at a real leaf`, async () => {
    const data = fixture('none')
    data[OBJECTS.head].push({ part_id: guard === 'head-parent' ? 'PART-OTHER' : 'PART-B', bom_id: 'BOM-FOREIGN', SysVer: guard === 'head-version' ? 'V2' : 'V1', bom_able: true })
    const fake = source(data, guard, false, { parent: 'PART-B' })
    const result = await expandPlmProjectBom({ sourceAdapter: fake.adapter, projectNo: 'SYN-PROJECT', maxDepth: 1 })
    assert.equal(result.valid, true)
    assert.deepEqual(result.errors, [])
    assert.deepEqual(result.rows.map((row) => row.componentSourceId), ['PART-A', 'PART-B'])
    assert.equal(fake.calls.some((call) => call.object === OBJECTS.detail && call.filters.bom_pid === 'BOM-FOREIGN'), false)
  })
}

test('foreign detail pointing at an ancestor cannot create a phantom cycle; real same-BOM cycle still refuses', async () => {
  const data = fixture('none')
  data[OBJECTS.detail].push({ bom_pid: 'BOM-FOREIGN', part_id: 'PART-A', Bom_ExAttr1: '1', sort_id: 2 })
  const result = await expandPlmProjectBom({ sourceAdapter: source(data, 'detail-parent', false).adapter, projectNo: 'SYN-PROJECT' })
  assert.equal(result.valid, true)
  assert.deepEqual(result.rows.map((row) => row.componentSourceId), ['PART-A', 'PART-B'])
  data[OBJECTS.detail][1].bom_pid = 'BOM-A'
  const cycle = await expandPlmProjectBom({ sourceAdapter: source(data, 'none').adapter, projectNo: 'SYN-PROJECT' })
  assert.equal(cycle.valid, false)
  assert.deepEqual(cycle.errors.map((error) => error.type), ['cycle_detected'])
})

for (const missing of ['part-version-absent', 'part-version-null', 'part-version-blank', 'head-role-absent']) {
  test(`legacy ${missing} imposes no invented version restriction`, async () => {
    const data = fixture('head-version')
    const plan = JSON.parse(JSON.stringify(PLM_STOCK_PREPARATION_BOM_READ_PLAN))
    if (missing === 'part-version-absent') delete data[OBJECTS.part][0].SysVer
    if (missing === 'part-version-null') data[OBJECTS.part][0].SysVer = null
    if (missing === 'part-version-blank') data[OBJECTS.part][0].SysVer = ' '
    if (missing === 'head-role-absent') delete plan.bomHead.versionField
    const fake = source(data, 'none')
    const result = await expandPlmProjectBom({ sourceAdapter: fake.adapter, projectNo: 'SYN-PROJECT', readPlan: plan })
    assert.equal(result.valid, true)
    assert.deepEqual(result.rows.map((row) => row.componentSourceId), ['PART-A', 'PART-B', 'PART-FOREIGN'])
    assert.equal(Object.hasOwn(fake.calls.find((call) => call.object === OBJECTS.head && call.filters.part_id === 'PART-A').filters, 'SysVer'), false)
  })
}

function requestedPlan() {
  return { ...PLM_STOCK_PREPARATION_BOM_READ_PLAN, orderDetail: { ...PLM_STOCK_PREPARATION_BOM_READ_PLAN.orderDetail, versionField: 'RequestedVersion' } }
}
for (const wide of [false, true]) test(`legacy absent version role does not collide with parent field named undefined, wide=${wide}`, async () => {
  const data = fixture(wide ? 'head-parent' : 'none')
  const plan = JSON.parse(JSON.stringify(PLM_STOCK_PREPARATION_BOM_READ_PLAN))
  plan.bomHead.parentPartField = 'undefined'
  delete plan.bomHead.versionField
  for (const head of data[OBJECTS.head]) { head.undefined = head.part_id; delete head.part_id }
  const fake = source(data, 'none', false, { widen(input) {
    return wide && input.object === OBJECTS.head && input.filters.undefined === 'PART-A' ? 'undefined' : undefined
  } })
  const result = await expandPlmProjectBom({ sourceAdapter: fake.adapter, projectNo: 'SYN-PROJECT', readPlan: plan })
  assert.equal(result.valid, true)
  assert.deepEqual(result.rows.map((row) => row.componentSourceId), ['PART-A', 'PART-B'])
  assert.deepEqual(result.rows.map((row) => row.totalQuantity), [2, 6])
  assert.deepEqual(fake.calls.find((call) => call.object === OBJECTS.head).filters, { undefined: 'PART-A' })
})
test('explicit requested version remains type-strict while string transport spaces normalize', async () => {
  for (const [requested, matching, foreign] of [[0, 0, '0'], [' V1 ', 'V1 ', 'v1'], ['V02', ' V02', 'V2']]) {
    const data = fixture('head-version')
    data[OBJECTS.orderLine][0].RequestedVersion = requested
    data[OBJECTS.head][0].SysVer = matching; data[OBJECTS.head][1].SysVer = foreign
    const result = await expandPlmProjectBom({ sourceAdapter: source(data, 'head-version', false).adapter, projectNo: 'SYN-PROJECT', readPlan: requestedPlan() })
    assert.equal(result.valid, true)
    assert.deepEqual(result.rows.map((row) => row.componentSourceId), ['PART-A', 'PART-B'])
    assert.equal(result.rows[0].orderBomVersion, typeof requested === 'string' ? requested.trim() : requested)
  }
})
for (const fault of ['invalid', 'no-match', 'ambiguous', 'missing-id']) {
  test(`requested-version ${fault} retains the existing strict error`, async () => {
    const data = fixture('none')
    data[OBJECTS.orderLine][0].RequestedVersion = fault === 'invalid' ? true : 0
    data[OBJECTS.head][0].SysVer = fault === 'no-match' ? '0' : 0
    if (fault === 'ambiguous') data[OBJECTS.head].push({ ...data[OBJECTS.head][0], bom_id: 'BOM-SECOND' })
    if (fault === 'missing-id') delete data[OBJECTS.head][0].bom_id
    const fake = source(data, 'head-version', true)
    const result = await expandPlmProjectBom({ sourceAdapter: fake.adapter, projectNo: 'SYN-PROJECT', readPlan: requestedPlan() })
    assert.equal(result.valid, false)
    assert.deepEqual(result.errors.map((error) => error.type), [{ invalid: 'order_bom_version_invalid', 'no-match': 'order_bom_version_no_active_match', ambiguous: 'order_bom_version_ambiguous', 'missing-id': 'order_bom_version_missing_bom_id' }[fault]])
    assert.equal(fake.calls.some((call) => call.object === OBJECTS.detail), false)
  })
}
for (const guard of ['order-path', 'order-owner']) {
  test(`foreign ${guard} is excluded before inspecting its absent requested version`, async () => {
    const data = fixture(guard)
    data[OBJECTS.orderLine][0].RequestedVersion = 'V1'
    const result = await expandPlmProjectBom({ sourceAdapter: source(data, guard, false).adapter, projectNo: 'SYN-PROJECT', readPlan: requestedPlan() })
    assert.equal(result.valid, true)
    assert.deepEqual(result.rows.map((row) => row.componentSourceId), ['PART-A', 'PART-B'])
  })
}

for (const metadata of [false, true, 'absent']) test(`wide foreign first page: continue only for an explicitly unfiltered source, metadata=${metadata}`, async () => {
  const data = fixture('detail-parent')
  const fake = source(data, 'none')
  const pageCursors = []
  const adapter = { async read(input) {
    if (input.object !== OBJECTS.detail || input.filters.bom_pid !== 'BOM-A') return fake.adapter.read(input)
    pageCursors.push(input.cursor ?? null)
    assert.equal(input.limit, 1)
    const declaration = metadata === 'absent' ? {} : { metadata: { filtersApplied: metadata } }
    if (!input.cursor) return { records: [data[OBJECTS.detail][1]], done: false, nextCursor: 'synthetic-page-2', ...declaration }
    assert.equal(input.cursor, 'synthetic-page-2')
    return { records: [data[OBJECTS.detail][0]], done: true, nextCursor: null, ...declaration }
  } }
  const result = await expandPlmProjectBom({ sourceAdapter: adapter, projectNo: 'SYN-PROJECT', pageLimit: 1, requireCompleteBatch: true })
  if (metadata !== false) {
    assertReadMismatch(result, 'detail-parent')
    assert.deepEqual(pageCursors, [null], 'a misanswered filtered page must fail before fetching the next page')
    return
  }
  assert.equal(result.valid, true)
  assert.deepEqual(result.rows.map((row) => row.componentSourceId), ['PART-A', 'PART-B'])
  assert.deepEqual(result.rows.map((row) => row.totalQuantity), [2, 6])
  assert.deepEqual(pageCursors, [null, 'synthetic-page-2'])
  const diagnostics = result.summary.readDiagnostics.filter((entry) => entry.object === OBJECTS.detail)
  assert.deepEqual(diagnostics.map((entry) => entry.count), [1, 1], 'both raw source rows remain counted, including the rejected foreign row')
  assert.deepEqual(diagnostics.map((entry) => entry.cursor), pageCursors)
  assert.ok(diagnostics.every((entry) => entry.filtersApplied === false && entry.status === 'ok'))
})

test('matched active head with only foreign details retains missing_child_bom failure', async () => {
  const data = fixture('detail-parent')
  data[OBJECTS.detail] = data[OBJECTS.detail].filter((detail) => detail.bom_pid === 'BOM-FOREIGN')
  const fake = source(data, 'detail-parent', false)
  const result = await expandPlmProjectBom({ sourceAdapter: fake.adapter, projectNo: 'SYN-PROJECT' })
  assert.equal(result.valid, false)
  assert.equal(result.status, 'failed')
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.rowErrors, [{ type: 'missing_child_bom', field: 'bom_pid', depth: 1 }])
  assert.deepEqual(result.rows.map((row) => row.componentSourceId), ['PART-A'])
  assert.equal(fake.calls.some((call) => call.object === OBJECTS.part && call.filters.OBJ_ID === 'PART-FOREIGN'), false)
})

// ---------------------------------------------------------------------------------------------------
// FP-1: root/discovery identity is EXACT (`toKey`); the five new rechecks keep SQL equivalence.
// The source below answers like a CI / int-coercing SQL `=`, so a twin row legally reaches the expander
// and only the client-side membership check stands between it and the project.
// ---------------------------------------------------------------------------------------------------
function sqlLooseEqual(left, right) {
  if (left === undefined || left === null || right === undefined || right === null) return false
  const a = String(left).trim().toLowerCase()
  const b = String(right).trim().toLowerCase()
  return a === b || (/^\d+$/.test(a) && /^\d+$/.test(b) && BigInt(a) === BigInt(b))
}

// `holdHeadOf`: the bomHead read for that part id parks until `release()`, freezing the serial walk.
function looseSource(data, { holdHeadOf } = {}) {
  const calls = []
  let release
  const held = holdHeadOf === undefined ? null : new Promise((resolve) => { release = resolve })
  return {
    calls,
    release: () => { if (release) release() },
    adapter: { async read(input) {
      const call = { object: input.object, filters: { ...input.filters }, count: 0 }
      calls.push(call)
      if (held && input.object === OBJECTS.head && input.filters.part_id === holdHeadOf) await held
      const records = data[input.object].filter((row) => Object.entries(input.filters)
        .every(([field, value]) => sqlLooseEqual(fieldValue(row, field), value)))
      call.count = records.length
      return { records, done: true, nextCursor: null, metadata: { filtersApplied: true } }
    } },
  }
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve))
}
const foreignReads = (calls) => calls.filter((call) => Object.values(call.filters).some((value) => /FOREIGN/.test(String(value))))
const sortedIds = (result) => result.rows.map((row) => row.componentSourceId).sort()
const partRow = (id, code) => ({ OBJ_ID: id, IdentityNo: code, IdentityName: `Synthetic ${code}`, Material: 'SYN-MATERIAL', SysVer: 'V1' })
const activeHead = (partId, bomId, pathId) => ({ part_id: partId, bom_id: bomId, SysVer: 'V1', bom_able: true, path_id: pathId })

// own: the key sent in filters; stored: how the exact-checked column stores it; twin: a row that only
// SQL-equals the key (absent for the positive controls).
const IDENTITY_VARIANTS = [
  { name: 'number 100 keys as text 100', own: '100', stored: 100 },
  { name: 'transport spaces keep the key', own: '100', stored: ' 100 ' },
  { name: 'case-only twin', own: 'abc', stored: 'abc', twin: 'ABC' },
  { name: 'numeric-text twin', own: '10', stored: '10', twin: '0010' },
]
const SUBTREE_PLAN = { ...PLM_STOCK_PREPARATION_BOM_READ_PLAN, maxReadCount: 100, projectSubtree: {
  pathInfo: { parentIdField: 'Parent_OBJ_ID' }, bomHead: { pathIdField: 'path_id' }, includeSelf: true,
} }
const SITES = {
  entry: 'pathMatches entry',
  pathInfo: 'pathInfo candidates',
  part: 'readPart candidates',
  subtreeHead: 'subtree head path',
  subtreeChildren: 'subtree children parent',
}

// One synthetic project whose single exact-checked column holds `stored`, plus (for twin variants) a
// foreign row that only SQL-equals `own` and leads to FOREIGN-labelled downstream rows where it can.
function rootScenario(site, v) {
  const data = fixture('none')
  const twin = v.twin !== undefined
  const scenario = { data, projectNo: 'SYN-PROJECT', expected: ['PART-A', 'PART-B'] }
  if (site === 'entry') {
    scenario.projectNo = v.own
    scenario.seam = [OBJECTS.pathAttr, 'FileCode']
    data[OBJECTS.pathAttr] = [{ FileCode: v.stored, Parent_OBJ_ID: 'PATH-A' }]
    if (twin) {
      data[OBJECTS.pathAttr].push({ FileCode: v.twin, Parent_OBJ_ID: 'PATH-FOREIGN' })
      data[OBJECTS.path].push({ OBJ_ID: 'PATH-FOREIGN' })
      data[OBJECTS.order].push({ OBJ_ID: 'ORDER-FOREIGN', path_id: 'PATH-FOREIGN' })
      data[OBJECTS.orderLine].push({ order_id: 'ORDER-FOREIGN', part_id: 'PART-FOREIGN', quantity: '5', sort_id: 2 })
    }
  } else if (site === 'pathInfo') {
    scenario.seam = [OBJECTS.path, 'OBJ_ID']
    data[OBJECTS.pathAttr] = [{ FileCode: 'SYN-PROJECT', Parent_OBJ_ID: v.own }]
    data[OBJECTS.path] = [{ OBJ_ID: v.stored }]
    data[OBJECTS.order] = [{ OBJ_ID: 'ORDER-A', path_id: v.own }]
    if (twin) data[OBJECTS.path].push({ OBJ_ID: v.twin })
  } else if (site === 'part') {
    scenario.seam = [OBJECTS.part, 'OBJ_ID']
    scenario.expected = [v.own, 'PART-B']
    data[OBJECTS.orderLine] = [{ order_id: 'ORDER-A', part_id: v.own, quantity: '2', sort_id: 1 }]
    data[OBJECTS.head] = [{ part_id: v.own, bom_id: 'BOM-A', SysVer: 'V1', bom_able: true }]
    data[OBJECTS.part] = [partRow(v.stored, 'SYN-A'), partRow('PART-B', 'SYN-B')]
    if (twin) data[OBJECTS.part].push(partRow(v.twin, 'SYN-TWIN'))
  } else {
    scenario.readPlan = SUBTREE_PLAN
    data[OBJECTS.pathAttr] = [{ FileCode: 'SYN-PROJECT', Parent_OBJ_ID: v.own }]
    data[OBJECTS.order] = []
    data[OBJECTS.orderLine] = []
    if (twin) data[OBJECTS.detail].push({ bom_pid: 'BOM-FOREIGN', part_id: 'PART-B', Bom_ExAttr1: '5', sort_id: 2 })
    if (site === 'subtreeHead') {
      scenario.seam = [OBJECTS.head, 'path_id']
      data[OBJECTS.path] = [{ OBJ_ID: v.own }]
      data[OBJECTS.head] = [activeHead('PART-A', 'BOM-A', v.stored)]
      if (twin) data[OBJECTS.head].push(activeHead('PART-FOREIGN', 'BOM-FOREIGN', v.twin))
    } else {
      scenario.seam = [OBJECTS.path, 'Parent_OBJ_ID']
      data[OBJECTS.path] = [{ OBJ_ID: v.own }, { OBJ_ID: 'NODE-CHILD', Parent_OBJ_ID: v.stored }]
      data[OBJECTS.head] = [activeHead('PART-A', 'BOM-A', 'NODE-CHILD')]
      if (twin) {
        data[OBJECTS.path].push({ OBJ_ID: 'NODE-FOREIGN', Parent_OBJ_ID: v.twin })
        data[OBJECTS.head].push(activeHead('PART-FOREIGN', 'BOM-FOREIGN', 'NODE-FOREIGN'))
      }
    }
  }
  return scenario
}

async function runScenario(scenario, concurrency) {
  const fake = looseSource(scenario.data)
  const result = await expandPlmProjectBom({
    sourceAdapter: fake.adapter,
    projectNo: scenario.projectNo,
    ...(scenario.readPlan ? { readPlan: scenario.readPlan } : { rootSelection: { enabled: false } }),
    ...(concurrency ? { readConcurrency: concurrency } : {}),
  })
  return { fake, result }
}

// The seam read is where the twin enters: it must really have been handed both rows (count 2), and the
// exact membership must keep only the project's own identity.
for (const site of Object.keys(SITES)) for (const variant of IDENTITY_VARIANTS) for (const concurrency of site === 'part' ? [0, 4] : [0]) {
  test(`exact identity at ${SITES[site]}: ${variant.name}${concurrency ? `, readConcurrency=${concurrency}` : ''}`, async () => {
    const scenario = rootScenario(site, variant)
    const { fake, result } = await runScenario(scenario, concurrency)
    const seam = fake.calls.find((call) => call.object === scenario.seam[0] && String(call.filters[scenario.seam[1]]) === variant.own)
    assert.ok(seam, 'the fixture must traverse the chosen seam')
    assert.equal(seam.count, variant.twin === undefined ? 1 : 2)
    assert.equal(result.valid, true, JSON.stringify(result.errors))
    assert.deepEqual(result.errors, [])
    assert.deepEqual(result.rowErrors, [])
    assert.deepEqual(sortedIds(result), scenario.expected.slice().sort())
    assert.deepEqual(foreignReads(fake.calls), [])
  })
}

for (const variant of IDENTITY_VARIANTS.filter((v) => v.twin !== undefined)) for (const concurrency of [0, 4]) {
  test(`exact readPart identity: a twin-only part table fails closed (${variant.name}${concurrency ? `, readConcurrency=${concurrency}` : ''})`, async () => {
    const scenario = rootScenario('part', variant)
    scenario.data[OBJECTS.part] = scenario.data[OBJECTS.part].filter((row) => row.OBJ_ID !== variant.stored)
    const { fake, result } = await runScenario(scenario, concurrency)
    const seam = fake.calls.find((call) => call.object === OBJECTS.part && String(call.filters.OBJ_ID) === variant.own)
    assert.equal(seam.count, 1, 'only the twin comes back')
    assert.equal(result.valid, false)
    assert.deepEqual(result.rowErrors.map((error) => error.type), ['missing_component'])
    assert.deepEqual(result.rows, [])
    assert.equal(fake.calls.some((call) => call.object === OBJECTS.head || call.object === OBJECTS.detail), false)
  })
}

// The part READ-AHEAD checks its candidates itself: with the walk frozen on a sibling's head read, a
// child whose part table also holds a twin must still get its own head prefetched (an ambiguous
// candidate list would silently skip the prefetch).
for (const variant of IDENTITY_VARIANTS) {
  test(`exact identity at prefetched part candidates: ${variant.name}`, async () => {
    const data = fixture('none')
    data[OBJECTS.detail] = [
      { bom_pid: 'BOM-A', part_id: 'PART-X', Bom_ExAttr1: '1', sort_id: 1 },
      { bom_pid: 'BOM-A', part_id: variant.own, Bom_ExAttr1: '1', sort_id: 2 },
    ]
    data[OBJECTS.part] = [partRow('PART-A', 'SYN-A'), partRow('PART-X', 'SYN-X'), partRow(variant.stored, 'SYN-B')]
    if (variant.twin !== undefined) data[OBJECTS.part].push(partRow(variant.twin, 'SYN-TWIN'))
    const fake = looseSource(data, { holdHeadOf: 'PART-X' })
    const headReads = () => fake.calls.filter((call) => call.object === OBJECTS.head && String(call.filters.part_id) === variant.own)
    const pending = expandPlmProjectBom({ sourceAdapter: fake.adapter, projectNo: 'SYN-PROJECT', rootSelection: { enabled: false }, readConcurrency: 4 })
    let early
    try {
      await settle()
      early = headReads().length
    } finally {
      fake.release()
    }
    const result = await pending
    assert.equal(early, 1, 'the child head was read ahead while the walk was still held on the sibling')
    assert.equal(headReads().length, 1, 'the walk claims the read-ahead instead of repeating it')
    assert.equal(result.valid, true, JSON.stringify(result.errors))
    assert.deepEqual(result.rowErrors, [])
    assert.deepEqual(sortedIds(result), ['PART-A', 'PART-X', variant.own].sort())
  })
}

// A twin-only result must not even schedule a foreign head read. The later exact readPart
// still refuses the row if this prefetch guard is removed, so final row counts alone miss it.
for (const variant of IDENTITY_VARIANTS.filter((value) => value.twin !== undefined)) {
  test(`exact prefetch identity never reads a twin-only part head: ${variant.name}`, async () => {
    const data = fixture('none')
    data[OBJECTS.detail] = [
      { bom_pid: 'BOM-A', part_id: 'PART-X', Bom_ExAttr1: '1', sort_id: 1 },
      { bom_pid: 'BOM-A', part_id: variant.own, Bom_ExAttr1: '1', sort_id: 2 },
    ]
    data[OBJECTS.part] = [partRow('PART-A', 'SYN-A'), partRow('PART-X', 'SYN-X'), partRow(variant.twin, 'SYN-TWIN')]
    const fake = looseSource(data, { holdHeadOf: 'PART-X' })
    const pending = expandPlmProjectBom({ sourceAdapter: fake.adapter, projectNo: 'SYN-PROJECT', rootSelection: { enabled: false }, readConcurrency: 4 })
    try { await settle() } finally { fake.release() }
    const result = await pending
    assert.ok(fake.calls.some((call) => call.object === OBJECTS.part && call.filters.OBJ_ID === variant.own && call.count === 1))
    assert.equal(fake.calls.filter((call) => call.object === OBJECTS.head && call.filters.part_id === variant.twin).length, 0)
    assert.equal(result.valid, false)
    assert.deepEqual(result.rowErrors.map((error) => error.type), ['missing_component'])
    assert.deepEqual(sortedIds(result), ['PART-A', 'PART-X'])
  })
}

// The five SQL-recheck fields (order path/owner, head parent/version, detail parent) and the page
// validation keep accepting legal SQL equivalence.
for (const [name, ids, alt] of [
  ['case', { path: 'PATH-A', order: 'ORDER-A', part: 'PART-A', version: 'V1', bom: 'BOM-A' }, (id) => id.toLowerCase()],
  ['numeric text', { path: '10', order: '20', part: '30', version: '1', bom: '40' }, (id) => id.padStart(4, '0')],
]) {
  test(`the five SQL rechecks still accept ${name} equivalence`, async () => {
    const data = fixture('none')
    data[OBJECTS.pathAttr] = [{ FileCode: 'SYN-PROJECT', Parent_OBJ_ID: ids.path }]
    data[OBJECTS.path] = [{ OBJ_ID: ids.path }]
    data[OBJECTS.order] = [{ OBJ_ID: ids.order, path_id: alt(ids.path) }]
    data[OBJECTS.orderLine] = [{ order_id: alt(ids.order), part_id: ids.part, quantity: '2', sort_id: 1 }]
    data[OBJECTS.part] = [{ ...partRow(ids.part, 'SYN-A'), SysVer: ids.version }, partRow('PART-B', 'SYN-B')]
    data[OBJECTS.head] = [{ part_id: alt(ids.part), bom_id: ids.bom, SysVer: alt(ids.version), bom_able: true }]
    data[OBJECTS.detail] = [{ bom_pid: alt(ids.bom), part_id: 'PART-B', Bom_ExAttr1: '3', sort_id: 1 }]
    const { fake, result } = await runScenario({ data, projectNo: 'SYN-PROJECT' })
    assert.equal(result.valid, true, JSON.stringify(result.errors))
    assert.deepEqual(result.errors, [])
    assert.deepEqual(result.rowErrors, [])
    assert.deepEqual(sortedIds(result), [ids.part, 'PART-B'].sort())
    assert.ok(fake.calls.some((call) => call.object === OBJECTS.detail && call.filters.bom_pid === ids.bom))
  })
}

// ---------------------------------------------------------------------------------------------------
// FP-1 at the real dry-run: the REAL table-actions dry-run (inside the repo's in-memory write-lock
// harness) in front of the REAL Bridge readonly adapter, whose injected fetch is CLOSED (one origin, one
// method, one path shape) and emulates the shipped agent's /query. This drives the library entry point,
// not the HTTP route registration.
// ---------------------------------------------------------------------------------------------------
const BRIDGE_ORIGIN = 'http://localhost:19091'

// mainDrawings also exercises the normal 总图 (J...-00) root-selection path.
function bridgeCatalog(ownNo, foreignNo, mainDrawings) {
  return {
    [OBJECTS.pathAttr]: [{ FileCode: ownNo, Parent_OBJ_ID: 'NODE-OWN' }, { FileCode: foreignNo, Parent_OBJ_ID: 'NODE-FOREIGN' }],
    [OBJECTS.path]: [{ OBJ_ID: 'NODE-OWN', Parent_OBJ_ID: null }, { OBJ_ID: 'NODE-FOREIGN', Parent_OBJ_ID: null }],
    [OBJECTS.order]: [{ OBJ_ID: 'ORDER-OWN', path_id: 'NODE-OWN' }, { OBJ_ID: 'ORDER-FOREIGN', path_id: 'NODE-FOREIGN' }],
    [OBJECTS.orderLine]: [
      { order_id: 'ORDER-OWN', part_id: 'ROOT-OWN', quantity: 1, sort_id: 10 },
      { order_id: 'ORDER-FOREIGN', part_id: 'ROOT-FOREIGN', quantity: 1, sort_id: 10 },
    ],
    [OBJECTS.part]: [
      { ...partRow('ROOT-OWN', mainDrawings ? 'J100-00' : 'C-OWN'), SysVer: 'V1' },
      { ...partRow('ROOT-FOREIGN', mainDrawings ? 'J200-00' : 'C-FOREIGN'), SysVer: 'V2' },
      partRow('LEAF', 'C-LEAF'),
    ],
    [OBJECTS.head]: [
      { part_id: 'ROOT-OWN', bom_id: 'BOM-OWN', SysVer: 'V1', bom_able: '1' },
      { part_id: 'ROOT-FOREIGN', bom_id: 'BOM-FOREIGN', SysVer: 'V2', bom_able: '1' },
    ],
    [OBJECTS.detail]: [
      { bom_pid: 'BOM-OWN', part_id: 'LEAF', Bom_ExAttr1: 2, sort_id: 10 },
      { bom_pid: 'BOM-FOREIGN', part_id: 'LEAF', Bom_ExAttr1: 5, sort_id: 10 },
    ],
  }
}

// mode: 'shipped-ci' echoes filtersApplied:true over a CI/int-coercing `=`; 'whole-table' answers every
// table in full and DECLARES filtersApplied:false; 'missing' answers in full and omits the flag.
function createClosedFetch(catalog, mode) {
  const calls = []
  const violations = []
  const refuse = (kind) => {
    violations.push(kind)
    throw new Error(`closed fetch: ${kind}`)
  }
  const fetchImpl = async (url, options = {}) => {
    const target = new URL(String(url))
    if (target.origin !== BRIDGE_ORIGIN) refuse('origin')
    if (String(options.method || 'GET').toUpperCase() !== 'POST') refuse('method')
    const match = /^\/query\/([^/]+)$/.exec(target.pathname)
    if (!match) refuse('path')
    const object = decodeURIComponent(match[1])
    if (!Object.hasOwn(catalog, object)) refuse('object')
    const body = JSON.parse(options.body || '{}')
    const filters = body.filters || {}
    calls.push({ object, filters: { ...filters } })
    const hasFilters = Object.keys(filters).length > 0
    const rows = mode === 'shipped-ci'
      ? catalog[object].filter((row) => Object.entries(filters).every(([field, value]) => sqlLooseEqual(row[field], value)))
      : catalog[object]
    const payload = { object, records: rows.slice(0, body.limit), limit: body.limit, nextCursor: null, done: true }
    if (mode === 'shipped-ci') payload.filtersApplied = hasFilters
    if (mode === 'whole-table') payload.filtersApplied = false
    return { ok: true, status: 200, async text() { return JSON.stringify(payload) } }
  }
  return { fetchImpl, calls, violations }
}

async function dryRunAgainstBridge({ ownNo, foreignNo, mainDrawings, mode, readPlan, catalog }) {
  const closed = createClosedFetch(catalog || bridgeCatalog(ownNo, foreignNo, mainDrawings), mode)
  const bridge = createBridgeAgentReadonlyAdapter({
    system: {
      id: 'syn_bridge', name: 'SYN bridge', kind: 'bridge:legacy-sql-readonly', role: 'source',
      config: { baseUrl: `${BRIDGE_ORIGIN}/`, sampleLimit: 3, maxLimit: 500, authHeaderName: 'X-SYN-Header' },
      credentials: { sharedSecret: 'syn-not-a-secret' },
    },
    fetchImpl: closed.fetchImpl,
  })
  const storage = createConsumableStorage()
  const records = createRecordsApi()
  const dryRun = createLibWriteLockHarness().wrapDryRun(dryRunStockPreparationAction)
  const originalFetch = globalThis.fetch
  let globalFetchCalls = 0
  globalThis.fetch = () => { globalFetchCalls += 1; throw new Error('global fetch is not allowed') }
  let response
  try {
    response = await dryRun({
      action: {
        actionId: PLM_STOCK_PREPARATION_ACTION_ID,
        source: { externalSystemId: 'plm_source_1', kind: 'bridge:legacy-sql-readonly',
          ...(readPlan ? { readPlan: { ...PLM_STOCK_PREPARATION_BOM_READ_PLAN,
            sourceKind: 'bridge:legacy-sql-readonly', ...readPlan } } : {}) },
        target: { sheetId: 'sheet_stock', objectId: 'stockPreparationMain' },
      },
      parameters: { projectNo: ownNo },
      sourceAdapter: { read: (input) => bridge.read(input) },
      recordsApi: records.recordsApi,
      tokenStore: storage,
      plannedAt: '2026-10-24T00:00:00.000Z',
    })
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(globalFetchCalls, 0)
  return { response, closed, storage, records }
}

test('closed bridge fetch throws on an unexpected origin, method or path', async () => {
  const closed = createClosedFetch(bridgeCatalog('ab-1', 'AB-1', false), 'shipped-ci')
  const post = { method: 'POST', body: '{}' }
  await assert.rejects(closed.fetchImpl('http://127.0.0.1:19091/query/DN_PDM_PathInfo', post), /closed fetch: origin/)
  await assert.rejects(closed.fetchImpl(`${BRIDGE_ORIGIN}/query/DN_PDM_PathInfo`, { method: 'GET' }), /closed fetch: method/)
  await assert.rejects(closed.fetchImpl(`${BRIDGE_ORIGIN}/health`, post), /closed fetch: path/)
  assert.deepEqual(closed.violations, ['origin', 'method', 'path'])
  assert.equal(closed.calls.length, 0)
})

for (const [twinName, ownNo, foreignNo] of [['case-only twin', 'ab-1', 'AB-1'], ['numeric-text twin', '10', '0010']]) {
  for (const mainDrawings of [false, true]) {
    // The real Bridge adapter treats an omitted flag as false, just like its legacy agent.
    for (const mode of ['shipped-ci', 'whole-table', 'missing']) {
      test(`dry-run over the real bridge, ${twinName}, mainDrawings=${mainDrawings}, ${mode}: only the own project is read and previewed`, async () => {
        const { response, closed, storage, records } = await dryRunAgainstBridge({ ownNo, foreignNo, mainDrawings, mode })
        const expansion = (response.evidence && response.evidence.expansion) || {}
        assert.deepEqual(closed.violations, [])
        assert.deepEqual(foreignReads(closed.calls), [])
        assert.ok(closed.calls.some((call) => call.object === OBJECTS.order && call.filters.path_id === 'NODE-OWN'))
        assert.ok(closed.calls.some((call) => call.object === OBJECTS.orderLine && call.filters.order_id === 'ORDER-OWN'))
        assert.equal(expansion.rootMatches, 1)
        assert.equal(expansion.valid, true)
        assert.deepEqual(expansion.errorTypes, [])
        assert.equal(expansion.rowsExpanded, 2)
        assert.equal(response.counts.add, 2)
        assert.ok(closed.calls.some((call) => call.object === OBJECTS.head && call.filters.part_id === 'ROOT-OWN'))
        assert.ok(closed.calls.some((call) => call.object === OBJECTS.detail && call.filters.bom_pid === 'BOM-OWN'))
        // The public dry-run deliberately exposes values-free evidence, not raw preview rows.
        assert.equal(Object.hasOwn(response, 'rows'), false)
        assert.equal(response.canApply, true)
        assert.equal(typeof response.dryRunToken, 'string')
        assert.ok(response.dryRunToken.length > 0)
        assert.equal(storage.map.size, 1, 'exactly the own preview token is stored')
        assert.deepEqual(records.writes(), [])
      })
    }
  }
}

// This boundary test uses the real Bridge, normalizer, expander, write-lock and
// dry-run/token producer. The HTTP registry ambiguity gate is tested separately.
for (const mode of ['shipped-ci', 'whole-table', 'missing']) {
  test(`configured source comparison accepts source casing and preserves internal project identity: ${mode}`, async () => {
    const catalog = bridgeCatalog('AB-1', 'OTHER-PROJECT', false)
    const accepted = await dryRunAgainstBridge({ ownNo: 'ab-1', mode, catalog,
      readPlan: { sourceProjectComparison: 'case-insensitive' } })
    assert.equal(accepted.response.canApply, true)
    assert.equal(accepted.response.evidence.expansion.rootMatches, 1)
    assert.equal(accepted.response.evidence.expansion.rowsExpanded, 2)
    assert.equal(accepted.response.counts.add, 2)
    assert.deepEqual(foreignReads(accepted.closed.calls), [])
    assert.deepEqual(accepted.closed.violations, [])
    assert.deepEqual(accepted.records.writes(), [])
    assert.equal(accepted.storage.map.size, 1)
    assert.equal(accepted.closed.calls[0].filters.FileCode, 'ab-1', 'request identity is not rewritten to source casing')
    for (const comparison of [undefined, 'case-sensitive']) {
      const refused = await dryRunAgainstBridge({ ownNo: 'ab-1', mode, catalog,
        readPlan: comparison ? { sourceProjectComparison: comparison } : undefined })
      assert.equal(refused.response.canApply, false)
      assert.equal(refused.response.evidence.expansion.rootMatches, 0)
      assert.equal(refused.response.dryRunToken, null)
      assert.equal(refused.storage.map.size, 0)
    }
  })

  test(`configured source comparison does not fold numeric text project numbers: ${mode}`, async () => {
    const result = await dryRunAgainstBridge({ ownNo: '10', foreignNo: '0010', mainDrawings: false, mode,
      readPlan: { sourceProjectComparison: 'case-insensitive' } })
    assert.equal(result.response.canApply, true)
    assert.equal(result.response.evidence.expansion.rootMatches, 1)
    assert.equal(result.response.counts.add, 2)
    assert.deepEqual(foreignReads(result.closed.calls), [])
    assert.deepEqual(result.records.writes(), [])
  })

  test(`configured source comparison includes both differently cased links of one source project: ${mode}`, async () => {
    const result = await dryRunAgainstBridge({ ownNo: 'ab-1', foreignNo: 'AB-1', mainDrawings: false, mode,
      readPlan: { sourceProjectComparison: 'case-insensitive' } })
    assert.equal(result.response.canApply, true)
    assert.equal(result.response.evidence.expansion.rootMatches, 2)
    assert.equal(result.response.evidence.expansion.rowsExpanded, 4)
    assert.equal(result.response.counts.add, 4)
    assert.ok(result.closed.calls.some((call) => call.object === OBJECTS.order && call.filters.path_id === 'NODE-FOREIGN'))
    assert.deepEqual(result.records.writes(), [])
    assert.equal(result.storage.map.size, 1, 'both source paths belong to the same preview')
  })

  test(`configured source comparison retains normal main-drawing selection within that project: ${mode}`, async () => {
    const result = await dryRunAgainstBridge({ ownNo: 'ab-1', foreignNo: 'AB-1', mainDrawings: true, mode,
      readPlan: { sourceProjectComparison: 'case-insensitive' } })
    assert.equal(result.response.canApply, true)
    assert.equal(result.response.evidence.expansion.rootMatches, 2)
    assert.equal(result.response.evidence.expansion.rowsExpanded, 2)
    assert.equal(result.response.counts.add, 2)
    assert.ok(result.closed.calls.some((call) => call.object === OBJECTS.detail && call.filters.bom_pid === 'BOM-FOREIGN'),
      'the higher-version main drawing is in the same configured source project')
    assert.deepEqual(result.records.writes(), [])
  })
}
