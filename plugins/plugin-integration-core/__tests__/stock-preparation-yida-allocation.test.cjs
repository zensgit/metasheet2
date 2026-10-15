'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const allocationPath = path.join(__dirname, '..', 'lib', 'stock-preparation-yida-allocation.mjs')
const modulePromise = import(pathToFileURL(allocationPath).href)
const plannerPromise = import(pathToFileURL(path.join(__dirname, '..', 'lib', 'yida-static-plan.mjs')).href)

function layoutA(patch = {}) {
  return {
    version: 1, kind: 'yida-form-static',
    target: { appType: 'synthetic-app', formUuid: 'synthetic-form' },
    intent: 'create', businessKey: ['projectNo', 'lineId'],
    fieldMap: [
      { source: 'projectNo', target: 'project', type: 'string', required: true },
      { source: 'lineId', target: 'line', type: 'string', required: true },
      { source: 'part', target: 'component', type: 'string', required: true },
      { source: 'quantity', target: 'qty', type: 'number', required: true },
      { source: 'active', target: 'enabled', type: 'boolean', required: true },
    ],
    ...patch,
  }
}

function layoutB(patch = {}) {
  return {
    version: 1, kind: 'yida-form-static',
    target: { appType: 'synthetic-app', formUuid: 'synthetic-form' },
    intent: 'create', businessKey: ['项目号', '明细标识'],
    fieldMap: [
      { source: '项目号', target: 'project', type: 'string', required: true },
      { source: '明细标识', target: 'line', type: 'string', required: true },
      { source: '物料', target: 'component', type: 'string', required: true },
      { source: '件数', target: 'qty', type: 'number', required: true },
      { source: '启用', target: 'enabled', type: 'boolean', required: true },
    ],
    ...patch,
  }
}

function rowA(quantity = 6, lineId = 'L-1') {
  return { projectNo: 'SOURCE', lineId, part: 'MAT-A', quantity, active: false }
}

function settings(patch = {}) {
  return {
    mode: 'equal_integer', projects: ['P-1', 'P-2', 'P-3'],
    projectField: 'projectNo', quantityField: 'quantity', ...patch,
  }
}

function preview(build, rows, config = layoutA(), allocation = settings()) {
  return build({ config, rowsText: JSON.stringify(rows), allocation })
}

function expectError(fn, code, YidaAllocationError) {
  assert.throws(fn, (error) => error instanceof YidaAllocationError
    && error.code === code && error.message === code)
}

test('integer 6/3 and zero produce real planner candidates, exact local evidence and fixed refusal flags', async () => {
  const { buildYidaProjectAllocationPreview } = await modulePromise
  const result = preview(buildYidaProjectAllocationPreview, [rowA(6), rowA(0, 'L-2')])
  assert.deepEqual({ kind: result.kind, status: result.status, canApply: result.canApply,
    tokenIssued: result.tokenIssued, lookupExecuted: result.lookupExecuted,
    externalWriteAttempted: result.externalWriteAttempted }, {
    kind: 'project_allocation_preview', status: 'not_applyable', canApply: false,
    tokenIssued: false, lookupExecuted: false, externalWriteAttempted: false,
  })
  assert.deepEqual(result.issues, [])
  assert.deepEqual(result.analysis, [
    { sourceIndex: 0, sourceTotal: 6, projectCount: 3, perProjectQuantity: 2,
      allocatedTotal: 6, difference: 0, issues: [], candidates: ['P-1', 'P-2', 'P-3'].map((project, expandedIndex) =>
        ({ expandedIndex, project, status: 'planned_create', issues: [] })) },
    { sourceIndex: 1, sourceTotal: 0, projectCount: 3, perProjectQuantity: 0,
      allocatedTotal: 0, difference: 0, issues: [], candidates: ['P-1', 'P-2', 'P-3'].map((project, index) =>
        ({ expandedIndex: index + 3, project, status: 'planned_create', issues: [] })) },
  ])
  assert.deepEqual(result.evidence, { sourceRows: 2, projectCount: 3,
    expandedRows: 6, invalidSourceRows: 0 })
  assert.equal(result.plan.kind, 'static_preview')
  assert.deepEqual(result.plan.rows.map((item) => item.status), Array(6).fill('planned_create'))
  assert.deepEqual(result.plan.rows.map((item) => item.payload), [
    { project: 'P-1', line: 'L-1', component: 'MAT-A', qty: 2, enabled: false },
    { project: 'P-2', line: 'L-1', component: 'MAT-A', qty: 2, enabled: false },
    { project: 'P-3', line: 'L-1', component: 'MAT-A', qty: 2, enabled: false },
    { project: 'P-1', line: 'L-2', component: 'MAT-A', qty: 0, enabled: false },
    { project: 'P-2', line: 'L-2', component: 'MAT-A', qty: 0, enabled: false },
    { project: 'P-3', line: 'L-2', component: 'MAT-A', qty: 0, enabled: false },
  ])
})

test('fully renamed layout changes both source roles and yields identical target payloads', async () => {
  const { buildYidaProjectAllocationPreview } = await modulePromise
  const config = layoutB()
  const result = preview(buildYidaProjectAllocationPreview,
    [{ 项目号: 'SOURCE', 明细标识: 'L-1', 物料: 'MAT-A', 件数: 6, 启用: false }],
    config, settings({ projectField: '项目号', quantityField: '件数' }))
  assert.deepEqual(result.plan.rows.map((item) => item.payload), [
    { project: 'P-1', line: 'L-1', component: 'MAT-A', qty: 2, enabled: false },
    { project: 'P-2', line: 'L-1', component: 'MAT-A', qty: 2, enabled: false },
    { project: 'P-3', line: 'L-1', component: 'MAT-A', qty: 2, enabled: false },
  ])
})

test('source project field may be absent because the explicit project list fills its mapped slot', async () => {
  const { buildYidaProjectAllocationPreview: build } = await modulePromise
  const source = { lineId: 'L-1', part: 'MAT-A', quantity: 6, active: false }
  const result = preview(build, [source])
  assert.deepEqual(result.issues, [])
  assert.deepEqual(result.plan.rows.map((row) => row.payload.project), ['P-1', 'P-2', 'P-3'])
  assert.deepEqual(source, { lineId: 'L-1', part: 'MAT-A', quantity: 6, active: false })
})

test('decimal exact accepts 1.5/3, 0.3/3 and 5/2 without floating-point difference', async () => {
  const { buildYidaProjectAllocationPreview } = await modulePromise
  for (const [source, projects, each] of [
    [1.5, ['P-1', 'P-2', 'P-3'], 0.5],
    [0.3, ['P-1', 'P-2', 'P-3'], 0.1],
    [5, ['P-1', 'P-2'], 2.5],
  ]) {
    const result = preview(buildYidaProjectAllocationPreview, [rowA(source)], layoutA(),
      settings({ mode: 'equal_decimal_exact', projects }))
    assert.equal(result.plan.rows.length, projects.length)
    assert.deepEqual(result.plan.rows.map((item) => item.payload.qty), projects.map(() => each))
    assert.equal(result.analysis[0].allocatedTotal, source)
    assert.equal(result.analysis[0].difference, 0)
    assert.deepEqual(result.issues, [])
  }
})

test('parser preempts raw quantity precision loss, underflow and duplicate decoded keys', async () => {
  const { buildYidaProjectAllocationPreview: build, YidaAllocationError } = await modulePromise
  for (const [token, mode] of [
    ['6.00000000000000001', 'equal_integer'],
    ['0.10000000000000001', 'equal_decimal_exact'],
    ['-1e-999', 'equal_decimal_exact'],
    ['1e-999999999999999999999', 'equal_decimal_exact'],
    ['9007199254740990.1', 'equal_integer'],
  ]) {
    const rowsText = `[{"projectNo":"SOURCE","lineId":"L-1","part":"MAT-A","quantity":${token},"active":false}]`
    expectError(() => build({ config: layoutA(), rowsText, allocation: settings({ mode,
      projects: mode === 'equal_integer' ? ['P-1', 'P-2', 'P-3'] : ['P-1', 'P-2'] }) }),
    'YIDA_ALLOCATION_ROWS_INVALID', YidaAllocationError)
  }
  const duplicate = '[{"projectNo":"SOURCE","lineId":"L-1","part":"MAT-A","quantity":6,"\\u0071uantity":6,"active":false}]'
  expectError(() => build({ config: layoutA(), rowsText: duplicate, allocation: settings() }),
    'YIDA_ALLOCATION_ROWS_INVALID', YidaAllocationError)
  // v1 accepts the exact -0 spelling; allocation still owns the quantity-domain refusal.
  const negativeZero = build({ config: layoutA(),
    rowsText: '[{"projectNo":"SOURCE","lineId":"L-1","part":"MAT-A","quantity":-0,"active":false}]', allocation: settings() })
  assert.equal(negativeZero.plan, null)
  assert.deepEqual(negativeZero.issues, [{ index: 0, code: 'QUANTITY_INVALID' }])
  assert.equal(negativeZero.analysis[0].sourceTotal, null)
  const zeroWithHugeExponent = '[{"projectNo":"SOURCE","lineId":"L-1","part":"MAT-A","quantity":0e999999999999999999999,"active":false}]'
  const zero = build({ config: layoutA(), rowsText: zeroWithHugeExponent,
    allocation: settings({ mode: 'equal_decimal_exact' }) })
  assert.deepEqual(zero.plan.rows.map((row) => row.payload.qty), [0, 0, 0])
})

test('raw scanner recognizes escaped role names and ignores quantity text inside values or other fields', async () => {
  const { buildYidaProjectAllocationPreview: build } = await modulePromise
  const escaped = '[{"\\u9879\\u76ee\\u53f7":"SOURCE","\\u660e\\u7ec6\\u6807\\u8bc6":"L-1","\\u7269\\u6599":"MAT-A","\\u4ef6\\u6570":0.3,"\\u542f\\u7528":false,"note":"quantity\\":999, { \\u4ef6\\u6570 : 3"}]'
  const result = build({ config: layoutB(), rowsText: escaped,
    allocation: settings({ mode: 'equal_decimal_exact',
      projectField: '项目号', quantityField: '件数' }) })
  assert.deepEqual(result.issues, [])
  assert.deepEqual(result.plan.rows.map((row) => row.payload.qty), [0.1, 0.1, 0.1])
  const exactTrailingZeros = '[{"projectNo":"SOURCE","lineId":"L-1","part":"MAT-A","quantity":1.5000000000000000,"active":false}]'
  const trailing = build({ config: layoutA(), rowsText: exactTrailingZeros,
    allocation: settings({ mode: 'equal_decimal_exact' }) })
  assert.deepEqual(trailing.plan.rows.map((row) => row.payload.qty), [0.5, 0.5, 0.5])
})

test('bounded long raw decimals refuse without suffix-regex backtracking', async () => {
  const { buildYidaProjectAllocationPreview: build, YidaAllocationError } = await modulePromise
  const token = `1${'0'.repeat(100000)}1e-100001`
  const rowsText = `[{"lineId":"L-1","part":"MAT-A","quantity":${token},"active":false}]`
  assert.ok(Buffer.byteLength(rowsText) < 128 * 1024)
  expectError(() => build({ config: layoutA(), rowsText, allocation: settings() }),
    'YIDA_ALLOCATION_ROWS_INVALID', YidaAllocationError)
})

test('nondivisible quantities refuse the whole batch with no partial planner candidate', async () => {
  const { buildYidaProjectAllocationPreview } = await modulePromise
  for (const [mode, quantity, projects] of [
    ['equal_integer', 5, ['P-1', 'P-2']],
    ['equal_decimal_exact', 1, ['P-1', 'P-2', 'P-3']],
  ]) {
    const result = preview(buildYidaProjectAllocationPreview,
      [rowA(6), rowA(quantity, 'L-2')], layoutA(), settings({ mode, projects }))
    assert.equal(result.plan, null)
    assert.deepEqual(result.issues, [{ index: 1, code: 'QUANTITY_NOT_DIVISIBLE' }])
    assert.deepEqual(result.analysis[1].issues, ['QUANTITY_NOT_DIVISIBLE'])
    assert.equal(result.evidence.invalidSourceRows, 1)
    assert.ok(result.analysis.every((entry) => entry.candidates.length === 0))
    assert.deepEqual(result.analysis[0].issues, [])
    assert.equal(result.analysis[0].difference, 0)
  }
})

test('planner required, type and missing-key failures count one source with project diagnostics while keeping the other source valid', async () => {
  const { buildYidaProjectAllocationPreview: build } = await modulePromise
  const { buildYidaStaticPlan } = await plannerPromise
  for (const [patch, code] of [
    [{ part: undefined }, 'FIELD_REQUIRED'],
    [{ active: 'synthetic-rejected-type' }, 'FIELD_TYPE'],
    [{ lineId: undefined }, 'KEY_MISSING'],
  ]) {
    const rows = [{ ...rowA(6), ...patch }, rowA(0, 'L-2')]
    const result = preview(build, rows)
    const expanded = rows.flatMap((row) => settings().projects.map((project) =>
      ({ ...row, projectNo: project, quantity: row.quantity / 3 })))
    // JSON text omits undefined fields before the actual planner receives rows.
    assert.deepEqual(result.plan, buildYidaStaticPlan({ config: layoutA(), rows: JSON.parse(JSON.stringify(expanded)) }))
    assert.deepEqual(result.evidence, { sourceRows: 2, projectCount: 3, expandedRows: 6, invalidSourceRows: 1 })
    assert.deepEqual(result.issues, [])
    assert.deepEqual(result.analysis[0].issues, [])
    assert.equal(result.analysis[0].allocatedTotal, 6)
    assert.equal(result.analysis[0].difference, 0)
    assert.deepEqual(result.analysis[0].candidates, settings().projects.map((project, expandedIndex) =>
      ({ expandedIndex, project, status: 'invalid', issues: [code] })))
    assert.deepEqual(result.analysis[1].candidates, settings().projects.map((project, index) =>
      ({ expandedIndex: index + 3, project, status: 'planned_create', issues: [] })))
    assert.deepEqual(result.plan.rows.slice(3).map((row) => row.payload), settings().projects.map((project) =>
      ({ project, line: 'L-2', component: 'MAT-A', qty: 0, enabled: false })))
    assert.equal(result.plan.canApply, false)
    assert.equal(result.lookupExecuted, false)
    assert.equal(result.externalWriteAttempted, false)
    assert.doesNotMatch(JSON.stringify(result.analysis), /synthetic-rejected-type/)
  }
})

test('v2 actual planner required and option failures preserve source association, other DTOs and exact conservation', async () => {
  const { buildYidaProjectAllocationPreview: build } = await modulePromise
  const { createYidaProtocolExample } = await plannerPromise
  for (const code of ['FIELD_REQUIRED', 'FIELD_OPTION_INVALID']) {
    const { config, rows } = createYidaProtocolExample()
    config.fieldMap.find((entry) => entry.source === 'priority').required = true
    config.fieldCatalog.find((entry) => entry.id === 'priority').required = true
    rows[0].quantity = 6
    rows[1].quantity = 0
    if (code === 'FIELD_REQUIRED') delete rows[0].priority
    else rows[0].priority = 'synthetic-rejected-option'
    const result = preview(build, rows, config)
    assert.equal(result.evidence.invalidSourceRows, 1)
    assert.equal(result.plan.evidence.invalid, 3)
    assert.deepEqual(result.analysis[0].candidates, settings().projects.map((project, expandedIndex) =>
      ({ expandedIndex, project, status: 'invalid', issues: [code] })))
    assert.equal(result.analysis[0].difference, 0)
    assert.deepEqual(result.analysis[0].issues, [])
    assert.ok(result.plan.rows.slice(0, 3).every((row) => !row.payload && !row.protocolPreview))
    assert.deepEqual(result.plan.rows.slice(3).map((row) => JSON.parse(row.protocolPreview.data.formDataJson).qty), [0, 0, 0])
    assert.deepEqual(result.analysis[1].candidates.map((candidate) => candidate.status), Array(3).fill('planned_create'))
    assert.doesNotMatch(JSON.stringify(result.analysis), /synthetic-rejected-option/)
  }
})

test('duplicate candidate keys across sources count both original rows once and retain source-major project ordering', async () => {
  const { buildYidaProjectAllocationPreview: build } = await modulePromise
  const result = preview(build, [rowA(6), rowA(3)])
  assert.equal(result.evidence.invalidSourceRows, 2)
  assert.equal(result.plan.evidence.duplicateKeyCount, 6)
  for (const entry of result.analysis) {
    assert.deepEqual(entry.candidates, settings().projects.map((project, index) => ({
      expandedIndex: entry.sourceIndex * 3 + index, project, status: 'invalid', issues: ['DUPLICATE_LOCAL_KEY'],
    })))
    assert.deepEqual(entry.issues, [])
    assert.equal(entry.difference, 0)
  }
  assert.deepEqual(result.issues, [])
})

test('source diagnostics preserve legacy v1 mapped number interpretation outside allocation quantity', async () => {
  const { buildYidaProjectAllocationPreview: build } = await modulePromise
  const config = layoutA({ fieldMap: [...layoutA().fieldMap,
    { source: 'legacyNumber', target: 'legacyNumber', type: 'number', required: false }] })
  const result = preview(build, [{ ...rowA(6), legacyNumber: -0.0000001 }], config)
  assert.equal(result.evidence.invalidSourceRows, 0)
  assert.deepEqual(result.plan.rows.map((row) => row.payload.legacyNumber), Array(3).fill(-0.0000001))
})

test('negative, nonfinite, wrong type, excessive precision and unsafe scaled totals refuse', async () => {
  const { buildYidaProjectAllocationPreview } = await modulePromise
  const checks = [
    [-1, 'equal_integer', 'QUANTITY_INVALID'],
    [-1, 'equal_decimal_exact', 'QUANTITY_INVALID'],
    ['6', 'equal_integer', 'QUANTITY_INVALID'],
    [null, 'equal_decimal_exact', 'QUANTITY_INVALID'],
    [0.0000001, 'equal_decimal_exact', 'QUANTITY_PRECISION'],
    [Number.MAX_SAFE_INTEGER + 1, 'equal_integer', 'QUANTITY_RANGE'],
    [9007199254.740992, 'equal_decimal_exact', 'QUANTITY_RANGE'],
  ]
  for (const [quantity, mode, code] of checks) {
    const result = preview(buildYidaProjectAllocationPreview, [rowA(quantity)], layoutA(),
      settings({ mode, projects: ['P-1'] }))
    assert.equal(result.plan, null)
    assert.deepEqual(result.issues, [{ index: 0, code }])
  }
  const invalidJson = '[{"projectNo":"P","lineId":"L","part":"A","quantity":NaN,"active":true}]'
  const { YidaAllocationError } = await modulePromise
  expectError(() => buildYidaProjectAllocationPreview({ config: layoutA(), rowsText: invalidJson,
    allocation: settings() }), 'YIDA_ALLOCATION_ROWS_INVALID', YidaAllocationError)
  expectError(() => buildYidaProjectAllocationPreview({ config: layoutA(),
    rowsText: '[{"projectNo":"P","lineId":"L","part":"A","quantity":1e999,"active":true}]',
    allocation: settings() }), 'YIDA_ALLOCATION_ROWS_INVALID', YidaAllocationError)
})

test('duplicate/invalid projects and all closed input settings fail without echoing values', async () => {
  const { buildYidaProjectAllocationPreview: build, YidaAllocationError } = await modulePromise
  const base = { config: layoutA(), rowsText: JSON.stringify([rowA()]), allocation: settings() }
  for (const projects of [[], ['P-1', ' P-1 '], [''], ['P-1\nX'], ['P-1\n'],
    Array.from({ length: 21 }, (_, i) => `P-${i}`), ['x'.repeat(129)]]) {
    expectError(() => build({ ...base, allocation: settings({ projects }) }),
      'YIDA_ALLOCATION_PROJECTS_INVALID', YidaAllocationError)
  }
  expectError(() => build({ ...base, allocation: settings({ mode: 'round' }) }),
    'YIDA_ALLOCATION_SETTINGS_INVALID', YidaAllocationError)
  expectError(() => build({ ...base, allocation: { ...settings(), endpoint: 'secret' } }),
    'YIDA_ALLOCATION_SETTINGS_INVALID', YidaAllocationError)
  expectError(() => build({ ...base, canApply: true }),
    'YIDA_ALLOCATION_INPUT_INVALID', YidaAllocationError)
  const trimmed = build({ ...base, allocation: settings({ projects: [' P-1 ', 'P-2'] }) })
  assert.deepEqual(trimmed.plan.rows.map((row) => row.payload.project), ['P-1', 'P-2'])
})

test('update intent and missing/incompatible project or quantity roles are rejected', async () => {
  const { buildYidaProjectAllocationPreview: build, YidaAllocationError } = await modulePromise
  const rowsText = JSON.stringify([rowA()])
  expectError(() => build({ config: layoutA({ intent: 'update', instanceIdField: 'instance' }),
    rowsText, allocation: settings() }), 'YIDA_ALLOCATION_INTENT_INVALID', YidaAllocationError)
  for (const [config, allocation] of [
    [layoutA(), settings({ projectField: 'missing' })],
    [layoutA(), settings({ quantityField: 'missing' })],
    [layoutA(), settings({ projectField: 'quantity' })],
    [layoutA(), settings({ quantityField: 'projectNo' })],
    [layoutA(), settings({ projectField: 'quantity', quantityField: 'quantity' })],
    [layoutA({ businessKey: ['projectNo'] }), settings()],
    [layoutA({ businessKey: ['lineId', 'part'] }), settings()],
    [layoutA({ fieldMap: [...layoutA().fieldMap,
      { source: 'quantity', target: 'otherQty', type: 'string', required: false }] }), settings()],
    [layoutA({ fieldMap: [...layoutA().fieldMap,
      { source: 'projectNo', target: 'otherProject', type: 'number', required: false }] }), settings()],
  ]) {
    expectError(() => build({ config, rowsText, allocation }),
      'YIDA_ALLOCATION_FIELDS_INVALID', YidaAllocationError)
  }
})

test('source rows, expanded row count and expanded UTF-8 text all obey budgets', async () => {
  const { buildYidaProjectAllocationPreview: build, YidaAllocationError } = await modulePromise
  const many = Array.from({ length: 51 }, (_, i) => rowA(2, `L-${i}`))
  const overRows = preview(build, many, layoutA(), settings({ projects: ['P-1', 'P-2'] }))
  assert.equal(overRows.plan, null)
  assert.deepEqual(overRows.issues, [{ index: null, code: 'EXPANDED_ROWS_LIMIT' }])
  assert.equal(overRows.evidence.expandedRows, 102)
  const huge = Array.from({ length: 30 }, (_, i) => ({ ...rowA(3, `L-${i}`),
    note: 'x'.repeat(1600) }))
  const overText = preview(build, huge)
  assert.equal(overText.plan, null)
  assert.deepEqual(overText.issues, [{ index: null, code: 'EXPANDED_TEXT_LIMIT' }])
  assert.equal(overText.evidence.expandedRows, 90)
  expectError(() => preview(build, Array.from({ length: 101 }, (_, i) => rowA(1, `L-${i}`))),
    'YIDA_ALLOCATION_ROWS_LIMIT', YidaAllocationError)
})

test('original config/rows/settings remain untouched and the real planner retains duplicate and required-field gates', async () => {
  const { buildYidaProjectAllocationPreview: build } = await modulePromise
  const { buildYidaStaticPlan } = await plannerPromise
  const config = layoutA()
  const rows = [rowA(6), rowA(3)]
  const allocation = settings()
  const snapshot = JSON.stringify({ config, rows, allocation })
  const result = preview(build, rows, config, allocation)
  assert.equal(JSON.stringify({ config, rows, allocation }), snapshot)
  assert.equal(result.plan.evidence.duplicateKeyCount, 6)
  assert.deepEqual(result.plan.rows.map((item) => item.status), Array(6).fill('invalid'))
  assert.ok(result.plan.rows.every((item) => item.issues.some((issue) => issue.code === 'DUPLICATE_LOCAL_KEY')))
  const missing = preview(build, [{ ...rowA(), part: undefined }])
  assert.equal(missing.plan.rows[0].status, 'invalid')
  assert.ok(missing.plan.rows[0].issues.some((issue) => issue.code === 'FIELD_REQUIRED'))
  assert.equal(buildYidaStaticPlan({ config, rows: [rowA()] }).kind, 'static_preview')
})

test('own data descriptors prevent input/config/allocation accessors and prototypes from running', async () => {
  const { buildYidaProjectAllocationPreview: build, YidaAllocationError } = await modulePromise
  let getterCalls = 0
  const input = { config: layoutA(), rowsText: JSON.stringify([rowA()]), allocation: settings() }
  Object.defineProperty(input, 'rowsText', { enumerable: true, get() { getterCalls += 1; return '[]' } })
  expectError(() => build(input), 'YIDA_ALLOCATION_INPUT_INVALID', YidaAllocationError)
  const config = layoutA()
  Object.defineProperty(config, 'target', { enumerable: true, get() { getterCalls += 1; return {} } })
  expectError(() => build({ config, rowsText: '[]', allocation: settings() }),
    'YIDA_ALLOCATION_CONFIG_INVALID', YidaAllocationError)
  const allocation = settings()
  Object.defineProperty(allocation, 'projects', { enumerable: true, get() { getterCalls += 1; return ['P'] } })
  expectError(() => build({ config: layoutA(), rowsText: '[]', allocation }),
    'YIDA_ALLOCATION_SETTINGS_INVALID', YidaAllocationError)
  const projects = ['P-1']
  Object.defineProperty(projects, '0', { enumerable: true, get() { getterCalls += 1; return 'P-1' } })
  expectError(() => build({ config: layoutA(), rowsText: '[]', allocation: settings({ projects }) }),
    'YIDA_ALLOCATION_PROJECTS_INVALID', YidaAllocationError)
  const inherited = Object.create({ allocation: settings() })
  inherited.config = layoutA()
  inherited.rowsText = '[]'
  expectError(() => build(inherited), 'YIDA_ALLOCATION_INPUT_INVALID', YidaAllocationError)
  assert.equal(getterCalls, 0)
})

test('parser rejects malformed, non-row and proto-key text with coarse fixed errors; source imports only planner', async () => {
  const { buildYidaProjectAllocationPreview: build, YidaAllocationError } = await modulePromise
  for (const rowsText of ['{bad', '{}', '[null]', '[{"__proto__":"x"}]']) {
    expectError(() => build({ config: layoutA(), rowsText, allocation: settings() }),
      'YIDA_ALLOCATION_ROWS_INVALID', YidaAllocationError)
  }
  const source = fs.readFileSync(allocationPath, 'utf8')
  assert.match(source, /from '\.\/yida-static-plan\.mjs'/)
  assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|WebSocket|sendBeacon)\s*\(/)
  assert.doesNotMatch(source, /\b(?:Date|localStorage|sessionStorage|indexedDB)\b/)
})

test('explicit v1 allocation rejects lossy mapped/unmapped numbers and duplicate decoded keys at parser boundary', async () => {
  const { buildYidaProjectAllocationPreview: build, YidaAllocationError } = await modulePromise
  const config = layoutA({ fieldMap: [...layoutA().fieldMap,
    { source: 'cost', target: 'unitCost', type: 'number', required: false }] })
  for (const extra of ['"cost":9007199254740993', '"unmapped":6.00000000000000001',
    '"unmapped":1e-400', '"part":"A","\\u0070art":"B"']) {
    const rowsText = `[{"projectNo":"SOURCE","lineId":"L-1","quantity":6,"active":false,${extra}}]`
    expectError(() => build({ config, rowsText, allocation: settings() }),
      'YIDA_ALLOCATION_ROWS_INVALID', YidaAllocationError)
  }
})

test('v2 allocation passes full config to parser so another mapped number cannot lose raw precision', async () => {
  const { buildYidaProjectAllocationPreview: build, YidaAllocationError } = await modulePromise
  const config = {
    version: 2, kind: 'yida-form-protocol-static',
    target: { appType: 'synthetic-app', formUuid: 'synthetic-form' },
    intent: 'create', businessKey: ['projectNo', 'lineId'], emptyKeyFields: [],
    fieldCatalog: [
      { id: 'project', control: 'text', required: true },
      { id: 'line', control: 'text', required: true },
      { id: 'qty', control: 'number', required: true },
      { id: 'unitCost', control: 'number', required: false },
    ],
    fieldMap: [
      { source: 'projectNo', target: 'project', type: 'string', required: true },
      { source: 'lineId', target: 'line', type: 'string', required: true },
      { source: 'quantity', target: 'qty', type: 'number', required: true },
      { source: 'cost', target: 'unitCost', type: 'number', required: false },
    ],
  }
  const rowsText = '[{"projectNo":"SOURCE","lineId":"L-1","quantity":6,"cost":9007199254740993}]'
  expectError(() => build({ config, rowsText, allocation: settings() }),
    'YIDA_ALLOCATION_ROWS_INVALID', YidaAllocationError)
  const valid = build({ config,
    rowsText: '[{"projectNo":"SOURCE","lineId":"L-1","quantity":6,"cost":0.3}]',
    allocation: settings() })
  assert.deepEqual(valid.plan.rows.map((row) => row.payload.unitCost), [0.3, 0.3, 0.3])
})
