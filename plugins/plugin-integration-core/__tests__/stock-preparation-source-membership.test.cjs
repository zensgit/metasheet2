'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { expandPlmProjectBom, PLM_STOCK_PREPARATION_BOM_READ_PLAN } = require('../lib/stock-preparation-bom-expansion.cjs')

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

for (const metadata of [false, true, 'absent']) for (const guard of ['none', 'order-path', 'order-owner', 'head-parent', 'head-version', 'detail-parent']) {
  test(`one-predicate ${guard}, metadata=${metadata}: no foreign row enters actual recursive expansion`, async () => {
    const fake = source(fixture(guard), guard, metadata)
    const result = await expandPlmProjectBom({ sourceAdapter: fake.adapter, projectNo: 'SYN-PROJECT', rootSelection: { enabled: false } })
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
    assert.equal(result.valid, true)
    assert.deepEqual(result.rows.map((row) => row.componentSourceId), ['PART-A', 'PART-B'])
    assert.deepEqual(result.rows.map((row) => row.totalQuantity), [1, 3])
    assert.ok(fake.calls.some((call) => call.object === OBJECTS.head && call.filters.path_id === 'PATH-A'))
    assert.ok(fake.calls.some((call) => call.object === OBJECTS.head && call.filters.part_id === 'PART-A'))
  })
}

for (const guard of ['order-path', 'order-owner', 'head-parent', 'head-version', 'detail-parent']) {
  test(`renamed case-variant numeric/whitespace keys preserve matchesByField semantics: ${guard}`, async () => {
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
    const fake = source(data, guard, true, { widen(input) {
      if (guard === 'order-path' && input.object === OBJECTS.order) return plan.orderHead.pathIdField
      if (guard === 'order-owner' && input.object === OBJECTS.orderLine) return plan.orderDetail.orderIdField
      if ((guard === 'head-parent' || guard === 'head-version') && input.object === OBJECTS.head && equalKey(input.filters[plan.bomHead.parentPartField], 100)) return guard === 'head-parent' ? plan.bomHead.parentPartField : plan.bomHead.versionField
      if (guard === 'detail-parent' && input.object === OBJECTS.detail && equalKey(input.filters[plan.bomDetail.bomParentField], 300)) return plan.bomDetail.bomParentField
      return undefined
    } })
    const result = await expandPlmProjectBom({ sourceAdapter: fake.adapter, projectNo: 'SYN-PROJECT', readPlan: plan, rootSelection: { enabled: false } })
    assert.equal(result.valid, true)
    assert.deepEqual(result.rows.map((row) => row.componentSourceId), ['100', '200'])
    assert.deepEqual(result.rows.map((row) => row.totalQuantity), [2, 6])
  })
}

for (const guard of ['head-parent', 'head-version']) {
  test(`foreign ${guard} cannot create a phantom maxDepth failure at a real leaf`, async () => {
    const data = fixture('none')
    data[OBJECTS.head].push({ part_id: guard === 'head-parent' ? 'PART-OTHER' : 'PART-B', bom_id: 'BOM-FOREIGN', SysVer: guard === 'head-version' ? 'V2' : 'V1', bom_able: true })
    const fake = source(data, guard, true, { parent: 'PART-B' })
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
  const result = await expandPlmProjectBom({ sourceAdapter: source(data, 'detail-parent', true).adapter, projectNo: 'SYN-PROJECT' })
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
  const fake = source(data, 'none', true, { widen(input) {
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
    const result = await expandPlmProjectBom({ sourceAdapter: source(data, 'head-version', true).adapter, projectNo: 'SYN-PROJECT', readPlan: requestedPlan() })
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
    const result = await expandPlmProjectBom({ sourceAdapter: source(data, guard, true).adapter, projectNo: 'SYN-PROJECT', readPlan: requestedPlan() })
    assert.equal(result.valid, true)
    assert.deepEqual(result.rows.map((row) => row.componentSourceId), ['PART-A', 'PART-B'])
  })
}

test('wide foreign first page does not suppress a later matching page or hide raw read counts', async () => {
  const data = fixture('detail-parent')
  const fake = source(data, 'none')
  const pageCursors = []
  const adapter = { async read(input) {
    if (input.object !== OBJECTS.detail || input.filters.bom_pid !== 'BOM-A') return fake.adapter.read(input)
    pageCursors.push(input.cursor ?? null)
    assert.equal(input.limit, 1)
    if (!input.cursor) return { records: [data[OBJECTS.detail][1]], done: false, nextCursor: 'synthetic-page-2', metadata: { filtersApplied: true } }
    assert.equal(input.cursor, 'synthetic-page-2')
    return { records: [data[OBJECTS.detail][0]], done: true, nextCursor: null, metadata: { filtersApplied: true } }
  } }
  const result = await expandPlmProjectBom({ sourceAdapter: adapter, projectNo: 'SYN-PROJECT', pageLimit: 1, requireCompleteBatch: true })
  assert.equal(result.valid, true)
  assert.deepEqual(result.rows.map((row) => row.componentSourceId), ['PART-A', 'PART-B'])
  assert.deepEqual(result.rows.map((row) => row.totalQuantity), [2, 6])
  assert.deepEqual(pageCursors, [null, 'synthetic-page-2'])
  const diagnostics = result.summary.readDiagnostics.filter((entry) => entry.object === OBJECTS.detail)
  assert.deepEqual(diagnostics.map((entry) => entry.count), [1, 1], 'both raw source rows remain counted, including the rejected foreign row')
  assert.deepEqual(diagnostics.map((entry) => entry.cursor), pageCursors)
  assert.ok(diagnostics.every((entry) => entry.filtersApplied === true && entry.status === 'ok'))
})

test('matched active head with only foreign details retains missing_child_bom failure', async () => {
  const data = fixture('detail-parent')
  data[OBJECTS.detail] = data[OBJECTS.detail].filter((detail) => detail.bom_pid === 'BOM-FOREIGN')
  const fake = source(data, 'detail-parent', true)
  const result = await expandPlmProjectBom({ sourceAdapter: fake.adapter, projectNo: 'SYN-PROJECT' })
  assert.equal(result.valid, false)
  assert.equal(result.status, 'failed')
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.rowErrors, [{ type: 'missing_child_bom', field: 'bom_pid', depth: 1 }])
  assert.deepEqual(result.rows.map((row) => row.componentSourceId), ['PART-A'])
  assert.equal(fake.calls.some((call) => call.object === OBJECTS.part && call.filters.OBJ_ID === 'PART-FOREIGN'), false)
})
