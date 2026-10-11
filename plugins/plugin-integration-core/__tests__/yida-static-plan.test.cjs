'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')

const modulePath = path.join(__dirname, '..', 'lib', 'yida-static-plan.mjs')
const modulePromise = import(pathToFileURL(modulePath).href)

function configA(patch = {}) {
  return {
    version: 1,
    kind: 'yida-form-static',
    target: { appType: 'synthetic-app', formUuid: 'synthetic-form' },
    intent: 'create',
    businessKey: ['projectNo', 'sourceRowId'],
    fieldMap: [
      { source: 'projectNo', target: 'project', type: 'string', required: true },
      { source: 'sourceRowId', target: 'line', type: 'string', required: true },
      { source: 'componentCode', target: 'component', type: 'string', required: true },
      { source: 'quantity', target: 'qty', type: 'number', required: false },
      { source: 'active', target: 'enabled', type: 'boolean', required: true },
    ],
    ...patch,
  }
}

function configB(patch = {}) {
  return {
    version: 1,
    kind: 'yida-form-static',
    target: { appType: 'synthetic-app', formUuid: 'synthetic-form' },
    intent: 'create',
    businessKey: ['项目号', '明细标识'],
    fieldMap: [
      { source: '项目号', target: 'project', type: 'string', required: true },
      { source: '明细标识', target: 'line', type: 'string', required: true },
      { source: '物料编号', target: 'component', type: 'string', required: true },
      { source: '件数', target: 'qty', type: 'number', required: false },
      { source: '启用', target: 'enabled', type: 'boolean', required: true },
    ],
    ...patch,
  }
}

function configUpdate(patch = {}) {
  return configB({ intent: 'update', instanceIdField: '实例ID', ...patch })
}

const localKey = (target, pairs) => JSON.stringify([
  target.appType,
  target.formUuid,
  pairs,
])

test('independent layout A oracle: local create payload, typed sorted key, 0/false, evidence and fixed refusal', async () => {
  const { validateYidaStaticConfig, buildYidaStaticPlan } = await modulePromise
  const config = configA()
  const validation = validateYidaStaticConfig(config)
  assert.equal(validation.valid, true)
  const result = buildYidaStaticPlan({
    config,
    rows: [{ projectNo: 'P-1', sourceRowId: 'L-1', componentCode: 'MAT-A', quantity: 0, active: false, extra: 'ignored' }],
  })
  assert.deepEqual({
    kind: result.kind, status: result.status, canApply: result.canApply,
    tokenIssued: result.tokenIssued, lookupExecuted: result.lookupExecuted,
    externalWriteAttempted: result.externalWriteAttempted,
  }, {
    kind: 'static_preview', status: 'not_applyable', canApply: false,
    tokenIssued: false, lookupExecuted: false, externalWriteAttempted: false,
  })
  assert.deepEqual(result.rows, [{
    index: 0, status: 'planned_create', remoteState: 'unverified',
    localBusinessKey: localKey(config.target, [['projectNo', 'string', 'P-1'], ['sourceRowId', 'string', 'L-1']]),
    payload: { project: 'P-1', line: 'L-1', component: 'MAT-A', qty: 0, enabled: false }, issues: [],
  }])
  assert.deepEqual(result.evidence, { rowCount: 1, plannedCreate: 1, plannedUpdate: 0, invalid: 0, duplicateKeyCount: 0 })
  assert.equal('wouldAdd' in result.evidence, false)
  assert.equal('receipt' in result, false)
})

test('independent layout B oracle: renamed source yields equivalent create payload', async () => {
  const { buildYidaStaticPlan } = await modulePromise
  const config = configB()
  const result = buildYidaStaticPlan({
    config,
    rows: [{ 项目号: 'P-1', 明细标识: 'L-1', 物料编号: 'MAT-A', 件数: 0, 启用: false }],
  })
  assert.deepEqual(result.rows, [{
    index: 0, status: 'planned_create', remoteState: 'unverified',
    localBusinessKey: localKey(config.target, [['明细标识', 'string', 'L-1'], ['项目号', 'string', 'P-1']]),
    payload: { project: 'P-1', line: 'L-1', component: 'MAT-A', qty: 0, enabled: false }, issues: [],
  }])
  assert.deepEqual(result.evidence, { rowCount: 1, plannedCreate: 1, plannedUpdate: 0, invalid: 0, duplicateKeyCount: 0 })
})

test('key order is canonical, target identity changes key, duplicate local keys invalidate every related row', async () => {
  const { buildYidaStaticPlan } = await modulePromise
  const rows = [
    { projectNo: 'P-1', sourceRowId: 'L-1', componentCode: 'A', active: true, quantity: 1 },
    { sourceRowId: 'L-1', quantity: 2, projectNo: 'P-1', componentCode: 'B', active: true },
    { projectNo: 'P-1', sourceRowId: 'L-2', componentCode: 'A', active: true, quantity: 3 },
  ]
  const first = buildYidaStaticPlan({ config: configA(), rows })
  const reordered = buildYidaStaticPlan({ config: configA({ businessKey: ['sourceRowId', 'projectNo'] }), rows })
  assert.equal(first.rows[0].localBusinessKey, reordered.rows[0].localBusinessKey)
  assert.deepEqual(first.rows.map((row) => row.status), ['invalid', 'invalid', 'planned_create'])
  assert.deepEqual(first.rows.slice(0, 2).map((row) => row.issues), [
    [{ index: 0, code: 'DUPLICATE_LOCAL_KEY' }],
    [{ index: 1, code: 'DUPLICATE_LOCAL_KEY' }],
  ])
  assert.equal(first.evidence.duplicateKeyCount, 2)
  assert.equal(first.evidence.plannedCreate, 1)
  const otherTarget = buildYidaStaticPlan({
    config: configA({ target: { appType: 'synthetic-app', formUuid: 'different-form' } }),
    rows: [rows[0]],
  })
  assert.notEqual(first.rows[0].localBusinessKey, otherTarget.rows[0].localBusinessKey)
})

test('optional missing/null/blank omit target; required/key missing and strict type mark row invalid', async () => {
  const { buildYidaStaticPlan } = await modulePromise
  const rows = [
    { projectNo: 'P-1', sourceRowId: 'L-1', componentCode: 'A', active: false },
    { projectNo: 'P-1', sourceRowId: 'L-2', componentCode: 'B', quantity: null, active: true },
    { projectNo: 'P-1', sourceRowId: 'L-3', componentCode: 'C', quantity: '   ', active: false },
    { projectNo: ' ', sourceRowId: 'L-4', componentCode: 'D', quantity: 1, active: true },
    { projectNo: 'P-1', sourceRowId: 'L-5', componentCode: 'E', quantity: '1', active: false },
    { projectNo: 'P-1', sourceRowId: 'L-6', componentCode: 'F', quantity: 2 },
  ]
  const result = buildYidaStaticPlan({ config: configA(), rows })
  assert.deepEqual(result.rows.slice(0, 3).map((row) => row.payload), [
    { project: 'P-1', line: 'L-1', component: 'A', enabled: false },
    { project: 'P-1', line: 'L-2', component: 'B', enabled: true },
    { project: 'P-1', line: 'L-3', component: 'C', enabled: false },
  ])
  assert.deepEqual(result.rows.slice(3).map((row) => row.status), ['invalid', 'invalid', 'invalid'])
  assert.ok(result.rows[3].issues.some((issue) => issue.code === 'KEY_MISSING'))
  assert.ok(result.rows[4].issues.some((issue) => issue.code === 'FIELD_TYPE'))
  assert.ok(result.rows[5].issues.some((issue) => issue.code === 'FIELD_REQUIRED'))
  assert.equal(result.evidence.invalid, 3)
})

function assertV1FieldDiagnostics(build) {
  const config = configA({ fieldMap: [
    ...configA().fieldMap,
    { source: 'projectNo', target: 'projectAlias', type: 'string', required: false },
  ] })
  const plan = build({ config, rows: [
    { projectNo: null, sourceRowId: '', quantity: 0 },
    { projectNo: 'P-1', sourceRowId: 'L-2', componentCode: 17,
      quantity: '<img src=x onerror=syntheticRejected()>', active: 'synthetic-private-rejected' },
  ] })
  assert.deepEqual(plan.rows.map(row => row.issues), [
    [
      { index: 0, code: 'KEY_MISSING', fields: [
        { source: 'projectNo', target: 'project', type: 'string' },
        { source: 'sourceRowId', target: 'line', type: 'string' },
        { source: 'projectNo', target: 'projectAlias', type: 'string' },
      ] },
      { index: 0, code: 'FIELD_REQUIRED', fields: [{ source: 'componentCode', target: 'component', type: 'string' }] },
      { index: 0, code: 'FIELD_REQUIRED', fields: [{ source: 'active', target: 'enabled', type: 'boolean' }] },
    ],
    [
      { index: 1, code: 'FIELD_TYPE', fields: [{ source: 'componentCode', target: 'component', type: 'string' }] },
      { index: 1, code: 'FIELD_TYPE', fields: [{ source: 'quantity', target: 'qty', type: 'number' }] },
      { index: 1, code: 'FIELD_TYPE', fields: [{ source: 'active', target: 'enabled', type: 'boolean' }] },
    ],
  ])
  assert.deepEqual(plan.evidence, { rowCount: 2, plannedCreate: 0, plannedUpdate: 0, invalid: 2, duplicateKeyCount: 0 })
  assert.equal(plan.rows[0].issues.filter(issue => issue.code === 'KEY_MISSING').length, 1)
  assert.ok(plan.rows.every(row => row.status === 'invalid' && !Object.hasOwn(row, 'payload')))
  assert.doesNotMatch(JSON.stringify(plan.rows.map(row => row.issues)), /synthetic-private|<img|onerror|localBusinessKey|required/)
  assert.equal(plan.canApply, false)
}

test('field diagnostics locate repeated v1 type/required failures and aggregate missing key mappings without values', async () => {
  const { buildYidaStaticPlan } = await modulePromise
  assertV1FieldDiagnostics(buildYidaStaticPlan)
})

test('field diagnostics kill missing, misbound and unprojected metadata in the real production module in memory', async () => {
  const { buildYidaStaticPlan } = await modulePromise
  assertV1FieldDiagnostics(buildYidaStaticPlan)
  const source = fs.readFileSync(modulePath, 'utf8').replaceAll('\r\n', '\n')
  for (const [name, from, to] of [
    ['missing', '...(entries ? { fields:', '...(false ? { fields:'],
    ['misbound', 'source: entry.source, target: entry.target, type: entry.type,', "source: 'wrongSource', target: 'wrongTarget', type: entry.type,"],
    ['unprojected', 'source: entry.source, target: entry.target, type: entry.type,', '...entry,'],
  ]) {
    assert.equal(source.split(from).length, 2, 'diagnostic mutation target occurs exactly once')
    const changed = await import(`data:text/javascript;base64,${Buffer.from(source.replace(from, to)).toString('base64')}`)
    assert.throws(() => assertV1FieldDiagnostics(changed.buildYidaStaticPlan), { name: 'AssertionError' })
    console.log(`YIDA_FIELD_METADATA_MUTATION ${name} killed=AssertionError sourceFileUnchanged=true`)
  }
})

test('update requires a bounded string instance ID; config intent and key/map closure are enforced', async () => {
  const { validateYidaStaticConfig, buildYidaStaticPlan } = await modulePromise
  const planned = buildYidaStaticPlan({ config: configUpdate(), rows: [
    { 项目号: 'P-1', 明细标识: 'L-1', 物料编号: 'B-17', 件数: 3, 启用: true, 实例ID: 'LOCAL-ID-17' },
  ] })
  assert.equal(planned.rows[0].status, 'planned_update')
  assert.equal(planned.rows[0].remoteState, 'unverified')
  assert.equal(planned.rows[0].instanceId, 'LOCAL-ID-17')
  assert.deepEqual(planned.rows[0].payload, { project: 'P-1', line: 'L-1', component: 'B-17', qty: 3, enabled: true })
  for (const id of [undefined, null, '', 12, false, 'x'.repeat(129)]) {
    const row = { 项目号: 'P-1', 明细标识: 'L-1', 物料编号: 'B-17', 件数: 3, 启用: true }
    if (id !== undefined) row.实例ID = id
    const result = buildYidaStaticPlan({ config: configUpdate(), rows: [row] })
    assert.equal(result.rows[0].status, 'invalid')
    assert.ok(result.rows[0].issues.some((issue) => issue.code === 'INSTANCE_ID_MISSING'))
  }
  const invalidConfigs = [
    configA({ instanceIdField: 'id' }),
    configUpdate({ instanceIdField: undefined }),
    configA({ businessKey: ['missing'] }),
    configA({ businessKey: ['projectNo', 'projectNo'] }),
    configA({ fieldMap: [...configA().fieldMap, { source: 'other', target: 'project', type: 'string', required: false }] }),
    configA({ fieldMap: [{ source: 'item.code', target: 'code', type: 'string', required: true }] }),
  ]
  for (const config of invalidConfigs) assert.equal(validateYidaStaticConfig(config).valid, false)
})

test('flat fields use own values: absent prototype-named optional/key/instance fields stay absent', async () => {
  const { buildYidaStaticPlan } = await modulePromise
  const optionalConfig = configA({ fieldMap: [
    ...configA().fieldMap,
    { source: 'toString', target: 'optionalText', type: 'string', required: false },
  ] })
  const row = { projectNo: 'P', sourceRowId: 'L', componentCode: 'A', active: true }
  const absent = buildYidaStaticPlan({ config: optionalConfig, rows: [row] })
  assert.equal(absent.rows[0].status, 'planned_create')
  assert.equal('optionalText' in absent.rows[0].payload, false)
  const present = buildYidaStaticPlan({ config: optionalConfig, rows: [{ ...row, toString: 'own-value' }] })
  assert.equal(present.rows[0].payload.optionalText, 'own-value')
  const keyConfig = configA({ businessKey: ['toString'], fieldMap: [
    ...configA().fieldMap,
    { source: 'toString', target: 'optionalText', type: 'string', required: false },
  ] })
  const noKey = buildYidaStaticPlan({ config: keyConfig, rows: [row] })
  assert.equal(noKey.rows[0].status, 'invalid')
  assert.ok(noKey.rows[0].issues.some((item) => item.code === 'KEY_MISSING'))
  const update = buildYidaStaticPlan({ config: configUpdate({ instanceIdField: 'valueOf' }), rows: [
    { 项目号: 'P', 明细标识: 'L', 物料编号: 'A', 启用: true },
  ] })
  assert.ok(update.rows[0].issues.some((item) => item.code === 'INSTANCE_ID_MISSING'))
})

test('closed config rejects endpoint, identity, secret, apply fields and dangerous field names without echo', async () => {
  const { validateYidaStaticConfig, buildYidaStaticPlan, YidaStaticPlanError } = await modulePromise
  for (const extra of [{ endpoint: '/send' }, { systemId: 'remote' }, { appKey: 'secret' }, { approved: true }, { canApply: true }, { token: 'secret' }]) {
    const config = configA(extra)
    const result = validateYidaStaticConfig(config)
    assert.equal(result.valid, false)
    assert.equal(JSON.stringify(result).includes('secret'), false)
    assert.throws(() => buildYidaStaticPlan({ config, rows: [] }), (error) => error instanceof YidaStaticPlanError && error.code === 'YIDA_STATIC_CONFIG_INVALID')
  }
  for (const source of ['__proto__', 'constructor', 'password', 'appSecret', 'systemToken', 'authorityCode', 'a.b', 'a[0]']) {
    const config = configA({ fieldMap: [{ source, target: 'code', type: 'string', required: true }] })
    assert.equal(validateYidaStaticConfig(config).valid, false, source)
  }
  assert.equal(validateYidaStaticConfig(configA({ fieldMap: [] })).valid, false)
  assert.equal(validateYidaStaticConfig(configA({ fieldMap: Array.from({ length: 33 }, (_, i) => ({ source: `s${i}`, target: `t${i}`, type: 'string', required: false })) })).valid, false)
})

test('whole input limits, malformed JSON, accessors and inherited rows fail without getter execution', async () => {
  const { buildYidaStaticPlan, parseYidaStaticRows, YidaStaticPlanError } = await modulePromise
  const mustThrow = (fn, code) => assert.throws(fn, (error) => error instanceof YidaStaticPlanError && error.code === code)
  mustThrow(() => parseYidaStaticRows('{bad'), 'YIDA_STATIC_TEXT_INVALID')
  mustThrow(() => parseYidaStaticRows(' '.repeat(131073)), 'YIDA_STATIC_TEXT_TOO_LARGE')
  mustThrow(() => buildYidaStaticPlan({ config: configA(), rows: Array.from({ length: 101 }, () => ({ projectNo: 'P', sourceRowId: 'L', componentCode: 'A', active: true })) }), 'YIDA_STATIC_ROWS_LIMIT')
  mustThrow(() => buildYidaStaticPlan({ config: configA(), rows: [{ projectNo: 'P', sourceRowId: 'L', componentCode: 'A', active: true, extra: 'x'.repeat(131073) }] }), 'YIDA_STATIC_ROWS_INVALID')
  mustThrow(() => buildYidaStaticPlan({ config: configA(), rows: [{ projectNo: 'P', sourceRowId: 'L', componentCode: 'A', active: true, extra: 'x'.repeat(4097) }] }), 'YIDA_STATIC_ROWS_INVALID')
  mustThrow(() => buildYidaStaticPlan({ config: configA(), rows: [{ projectNo: 'P', sourceRowId: 'L', componentCode: 'A', active: true, extra: Number.NaN }] }), 'YIDA_STATIC_ROWS_INVALID')
  mustThrow(() => buildYidaStaticPlan({ config: configA(), rows: [{ projectNo: 'P', sourceRowId: 'L', componentCode: 'A', active: true, extra: {} }] }), 'YIDA_STATIC_ROWS_INVALID')
  mustThrow(() => buildYidaStaticPlan({ config: configA(), rows: [{ projectNo: 'P', sourceRowId: 'L', componentCode: 'A', active: true, ...Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`f${i}`, i])) }] }), 'YIDA_STATIC_ROWS_INVALID')
  let getterCalls = 0
  const getterRow = { projectNo: 'P', sourceRowId: 'L', componentCode: 'A', active: true }
  Object.defineProperty(getterRow, 'extra', { enumerable: true, get() { getterCalls += 1; return 'bad' } })
  mustThrow(() => buildYidaStaticPlan({ config: configA(), rows: [getterRow] }), 'YIDA_STATIC_ROWS_INVALID')
  assert.equal(getterCalls, 0)
  const arrayWithGetter = [{ projectNo: 'P', sourceRowId: 'L', componentCode: 'A', active: true }]
  Object.defineProperty(arrayWithGetter, '0', { enumerable: true, get() { getterCalls += 1; return getterRow } })
  mustThrow(() => buildYidaStaticPlan({ config: configA(), rows: arrayWithGetter }), 'YIDA_STATIC_ROWS_INVALID')
  assert.equal(getterCalls, 0)
  const largeButShallow = Array.from({ length: 40 }, (_, i) => ({
    projectNo: 'P', sourceRowId: `L-${i}`, componentCode: 'A', active: true,
    ...Object.fromEntries(Array.from({ length: 32 }, (_, j) => [`extra${j}`, 'x'.repeat(120)])),
  }))
  mustThrow(() => buildYidaStaticPlan({ config: configA(), rows: largeButShallow }), 'YIDA_STATIC_ROWS_LIMIT')
  const inherited = Object.create({ inherited: 'bad' })
  inherited.projectNo = 'P'
  inherited.sourceRowId = 'L'
  inherited.componentCode = 'A'
  inherited.active = true
  mustThrow(() => buildYidaStaticPlan({ config: configA(), rows: [inherited] }), 'YIDA_STATIC_ROWS_INVALID')
  mustThrow(() => buildYidaStaticPlan({ config: configA(), rows: [], canApply: true }), 'YIDA_STATIC_INPUT_INVALID')
})

test('examples are local, parseable, and provide two distinct hand-authored layouts', async () => {
  const { createYidaStaticExample, parseYidaStaticRows, buildYidaStaticPlan } = await modulePromise
  const primary = createYidaStaticExample()
  const renamed = createYidaStaticExample('renamed')
  assert.deepEqual(parseYidaStaticRows(primary.text), primary.rows)
  assert.deepEqual(parseYidaStaticRows(renamed.text), renamed.rows)
  assert.equal(primary.config.intent, 'create')
  assert.equal(renamed.config.intent, 'create')
  assert.notDeepEqual(primary.config.fieldMap, renamed.config.fieldMap)
  assert.equal(buildYidaStaticPlan({ config: primary.config, rows: primary.rows }).rows[0].status, 'planned_create')
  assert.equal(buildYidaStaticPlan({ config: renamed.config, rows: renamed.rows }).rows[0].status, 'planned_create')
  assert.deepEqual(
    buildYidaStaticPlan({ config: primary.config, rows: primary.rows }).rows[0].payload,
    buildYidaStaticPlan({ config: renamed.config, rows: renamed.rows }).rows[0].payload,
  )
  assert.throws(() => createYidaStaticExample('live'), /YIDA_STATIC_EXAMPLE_INVALID/)
})

test('production module remains I/O-free and build does not call fetch', async () => {
  const { buildYidaStaticPlan } = await modulePromise
  const source = fs.readFileSync(modulePath, 'utf8')
  assert.doesNotMatch(source, /^\s*import\s/m)
  assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|WebSocket|sendBeacon)\s*\(/)
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = () => { fetchCalls += 1; throw new Error('network forbidden') }
  try {
    buildYidaStaticPlan({ config: configA(), rows: [{ projectNo: 'P', sourceRowId: 'L', componentCode: 'A', active: false }] })
    assert.equal(fetchCalls, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('in-memory single-guard mutations are killed by independent result oracles', async () => {
  const source = fs.readFileSync(modulePath, 'utf8')
  async function mutant(from, to) {
    assert.equal(source.split(from).length, 2, 'mutation target occurs exactly once')
    const changed = source.replace(from, to)
    return import(`data:text/javascript;base64,${Buffer.from(changed).toString('base64')}`)
  }
  const one = [{ projectNo: 'P', sourceRowId: 'L', componentCode: 'A', active: false }]
  const permissionMutant = await mutant('canApply: false, tokenIssued: false,', 'canApply: true, tokenIssued: false,')
  assert.throws(() => assert.equal(permissionMutant.buildYidaStaticPlan({ config: configA(), rows: one }).canApply, false))

  const typeMutant = await mutant('if (typeof value !== entry.type) {', 'if (false) {')
  const wrongType = [{ projectNo: 'P', sourceRowId: 'L', componentCode: 'A', quantity: '2', active: false }]
  assert.throws(() => assert.equal(typeMutant.buildYidaStaticPlan({ config: configA(), rows: wrongType }).rows[0].status, 'invalid'))

  const duplicateMutant = await mutant('if (group.length < 2) continue', 'if (group.length < 3) continue')
  assert.throws(() => assert.deepEqual(duplicateMutant.buildYidaStaticPlan({ config: configA(), rows: [one[0], one[0]] }).rows.map((row) => row.status), ['invalid', 'invalid']))

  const ownMutant = await mutant(
    'return Object.prototype.hasOwnProperty.call(row, field) ? row[field] : undefined',
    'return row[field]',
  )
  const optionalConfig = configA({ fieldMap: [
    ...configA().fieldMap, { source: 'toString', target: 'optionalText', type: 'string', required: false },
  ] })
  assert.throws(() => assert.equal(ownMutant.buildYidaStaticPlan({ config: optionalConfig, rows: one }).rows[0].status, 'planned_create'))
})

const protocolSources = ['projectNo', 'componentCode', 'componentName', 'specification',
  'material', 'version', 'parentCode', 'quantity', 'priority']
const protocolTargets = ['f_project', 'f_code', 'f_name', 'f_spec', 'f_material',
  'f_version', 'f_parent', 'f_qty', 'f_priority']

function protocolConfig(sources = protocolSources, patch = {}) {
  return {
    version: 2, kind: 'yida-form-protocol-static',
    target: { appType: 'synthetic-app', formUuid: 'synthetic-form' },
    intent: 'create', businessKey: sources.slice(0, 7), emptyKeyFields: [sources[6]],
    fieldCatalog: protocolTargets.map((id, index) => ({
      id, control: index === 7 ? 'number' : index === 8 ? 'select' : 'text',
      required: index < 6 || index === 7,
      ...(index === 8 ? { options: ['normal', 'rush'] } : {}),
    })),
    fieldMap: sources.map((source, index) => ({ source, target: protocolTargets[index],
      type: index === 7 ? 'number' : 'string', required: index < 6 || index === 7 })),
    ...patch,
  }
}

function protocolRow(sources = protocolSources, overrides = {}) {
  const values = ['P-1', 'C-1', '物料"A', '规格Ω', '钢', 'V1', null, 0, 'normal']
  return { ...Object.fromEntries(sources.map((source, index) => [source, values[index]])),
    ...overrides }
}

const expectedProtocolPayload = {
  f_project: 'P-1', f_code: 'C-1', f_name: '物料"A', f_spec: '规格Ω',
  f_material: '钢', f_version: 'V1', f_qty: 0, f_priority: 'normal',
}

test('field diagnostics locate v2 number and option refusals without rejected values or option contents', async () => {
  const { buildYidaStaticPlan } = await modulePromise
  const plan = buildYidaStaticPlan({ config: protocolConfig(), rows: [
    protocolRow(protocolSources, { quantity: -0, priority: '<img src=x onerror=syntheticRejected()>' }),
  ] })
  assert.deepEqual(plan.rows[0].issues, [
    { index: 0, code: 'FIELD_NUMBER_INVALID', fields: [{ source: 'quantity', target: 'f_qty', type: 'number' }] },
    { index: 0, code: 'FIELD_OPTION_INVALID', fields: [{ source: 'priority', target: 'f_priority', type: 'string' }] },
  ])
  assert.equal(plan.rows[0].status, 'invalid')
  assert.equal(Object.hasOwn(plan.rows[0], 'payload'), false)
  assert.equal(Object.hasOwn(plan.rows[0], 'protocolPreview'), false)
  assert.doesNotMatch(JSON.stringify(plan.rows[0].issues), /<img|onerror|normal|rush|options|localBusinessKey/)
  assert.equal(plan.canApply, false)
})

const expectedProtocolKey = (parent = '') => JSON.stringify([
  'yida-protocol-v2', 'synthetic-app', 'synthetic-form', [
    ['f_code', 'string', 'C-1'], ['f_material', 'string', '钢'],
    ['f_name', 'string', '物料"A'], ['f_parent', 'string', parent],
    ['f_project', 'string', 'P-1'], ['f_spec', 'string', '规格Ω'],
    ['f_version', 'string', 'V1'],
  ],
])

test('v2 independent create oracle: sorted target identity, exact data-only DTO and JSON roundtrip', async () => {
  const { validateYidaStaticConfig, buildYidaStaticPlan } = await modulePromise
  const config = protocolConfig()
  assert.equal(validateYidaStaticConfig(config).valid, true)
  const plan = buildYidaStaticPlan({ config, rows: [protocolRow()] })
  assert.equal(plan.rows[0].status, 'planned_create')
  assert.equal(plan.rows[0].localBusinessKey, expectedProtocolKey())
  assert.deepEqual(plan.rows[0].payload, expectedProtocolPayload)
  assert.deepEqual(plan.rows[0].protocolPreview, {
    contract: 'dingtalk-yida-1.0-data-only', completeness: 'data_fields_only',
    data: { appType: 'synthetic-app', formUuid: 'synthetic-form',
      formDataJson: JSON.stringify(expectedProtocolPayload) },
  })
  assert.deepEqual(JSON.parse(plan.rows[0].protocolPreview.data.formDataJson), expectedProtocolPayload)
  assert.equal('f_parent' in plan.rows[0].payload, false)
  assert.deepEqual(plan.evidence, { rowCount: 1, plannedCreate: 1,
    plannedUpdate: 0, invalid: 0, duplicateKeyCount: 0 })
  assert.equal(plan.canApply, false)
  assert.equal(plan.tokenIssued, false)
  assert.equal(plan.lookupExecuted, false)
  assert.equal(plan.externalWriteAttempted, false)
})

test('all seven v2 identity fields are individually significant; renamed sources preserve key and target remap changes it', async () => {
  const { buildYidaStaticPlan } = await modulePromise
  const base = protocolRow()
  const baseline = buildYidaStaticPlan({ config: protocolConfig(), rows: [base] }).rows[0].localBusinessKey
  for (const source of protocolSources.slice(0, 7)) {
    const changed = { ...base, [source]: source === 'parentCode' ? 'PARENT' : 'changed' }
    const key = buildYidaStaticPlan({ config: protocolConfig(), rows: [changed] }).rows[0].localBusinessKey
    assert.notEqual(key, baseline, source)
  }
  const renamedSources = ['项目号', '物料编号', '物料名称', '规格', '材质', '版本', '父图号', '件数', '优先级']
  const renamed = buildYidaStaticPlan({ config: protocolConfig(renamedSources),
    rows: [protocolRow(renamedSources)] })
  assert.equal(renamed.rows[0].localBusinessKey, baseline)
  assert.deepEqual(renamed.rows[0].payload, expectedProtocolPayload)
  const remapped = protocolConfig()
  remapped.fieldCatalog[0].id = 'different_project'
  remapped.fieldMap[0].target = 'different_project'
  const remappedKey = buildYidaStaticPlan({ config: remapped, rows: [base] }).rows[0].localBusinessKey
  assert.notEqual(remappedKey, baseline)
})

test('v2 optional empty key identity treats absent/null/empty alike, rejects whitespace and removes duplicate DTOs', async () => {
  const { buildYidaStaticPlan } = await modulePromise
  const nullParent = protocolRow()
  const missingParent = protocolRow()
  delete missingParent.parentCode
  const emptyParent = protocolRow(protocolSources, { parentCode: '' })
  const plan = buildYidaStaticPlan({ config: protocolConfig(),
    rows: [nullParent, missingParent, emptyParent] })
  assert.deepEqual(plan.rows.map((row) => row.localBusinessKey),
    [expectedProtocolKey(), expectedProtocolKey(), expectedProtocolKey()])
  assert.deepEqual(plan.rows.map((row) => row.status), ['invalid', 'invalid', 'invalid'])
  assert.equal(plan.evidence.duplicateKeyCount, 3)
  assert.ok(plan.rows.every((row) => row.issues.some((issue) => issue.code === 'DUPLICATE_LOCAL_KEY')))
  assert.ok(plan.rows.every((row) => !Object.prototype.hasOwnProperty.call(row, 'protocolPreview')))
  const whitespace = buildYidaStaticPlan({ config: protocolConfig(),
    rows: [protocolRow(protocolSources, { parentCode: '   ' })] })
  assert.equal(whitespace.rows[0].status, 'invalid')
  assert.ok(whitespace.rows[0].issues.some((issue) => issue.code === 'KEY_MISSING'))
  assert.equal('protocolPreview' in whitespace.rows[0], false)
})

test('v2 create/update DTO property names and omission are exact', async () => {
  const { buildYidaStaticPlan } = await modulePromise
  const create = buildYidaStaticPlan({ config: protocolConfig(), rows: [protocolRow()] }).rows[0]
  assert.deepEqual(Object.keys(create.protocolPreview.data), ['appType', 'formUuid', 'formDataJson'])
  const updateConfig = protocolConfig(protocolSources,
    { intent: 'update', instanceIdField: 'instanceId' })
  const updated = buildYidaStaticPlan({ config: updateConfig,
    rows: [protocolRow(protocolSources, { instanceId: 'LOCAL-1' })] }).rows[0]
  assert.equal(updated.status, 'planned_update')
  assert.deepEqual(updated.protocolPreview, {
    contract: 'dingtalk-yida-1.0-data-only', completeness: 'data_fields_only',
    data: { appType: 'synthetic-app', formInstanceId: 'LOCAL-1',
      updateFormDataJson: JSON.stringify(expectedProtocolPayload) },
  })
  assert.deepEqual(Object.keys(updated.protocolPreview.data),
    ['appType', 'formInstanceId', 'updateFormDataJson'])
  const invalid = buildYidaStaticPlan({ config: updateConfig, rows: [protocolRow()] }).rows[0]
  assert.equal(invalid.status, 'invalid')
  assert.equal('protocolPreview' in invalid, false)
})

test('v2 catalog validates closure, required mapping, controls, options and own descriptors', async () => {
  const { validateYidaStaticConfig } = await modulePromise
  const invalid = [
    protocolConfig(protocolSources, { endpoint: 'secret' }),
    protocolConfig(protocolSources, { fieldCatalog: [...protocolConfig().fieldCatalog,
      { id: 'f_qty', control: 'number', required: false }] }),
    protocolConfig(protocolSources, { fieldCatalog: protocolConfig().fieldCatalog.map((entry) =>
      entry.id === 'f_priority' ? { ...entry, options: ['normal', 'normal'] } : entry) }),
    protocolConfig(protocolSources, { fieldCatalog: protocolConfig().fieldCatalog.map((entry) =>
      entry.id === 'f_priority' ? { ...entry, options: ['normal', ' '] } : entry) }),
    protocolConfig(protocolSources, { fieldCatalog: protocolConfig().fieldCatalog.map((entry) =>
      entry.id === 'f_project' ? { ...entry, options: ['x'] } : entry) }),
    protocolConfig(protocolSources, { fieldCatalog: protocolConfig().fieldCatalog.map((entry) =>
      entry.id === 'f_qty' ? { ...entry, control: 'text' } : entry) }),
    protocolConfig(protocolSources, { fieldMap: protocolConfig().fieldMap.filter((entry) => entry.target !== 'f_project') }),
    protocolConfig(protocolSources, { fieldMap: protocolConfig().fieldMap.map((entry) =>
      entry.target === 'f_project' ? { ...entry, required: false } : entry) }),
    protocolConfig(protocolSources, { fieldMap: [...protocolConfig().fieldMap,
      { source: 'projectNo', target: 'f_extra', type: 'string', required: false }],
    fieldCatalog: [...protocolConfig().fieldCatalog, { id: 'f_extra', control: 'text', required: false }] }),
    protocolConfig(protocolSources, { fieldMap: [...protocolConfig().fieldMap,
      { source: 'extra', target: 'not_catalogued', type: 'string', required: false }] }),
    protocolConfig(protocolSources, { emptyKeyFields: ['projectNo'] }),
    protocolConfig(protocolSources, { emptyKeyFields: ['parentCode', 'parentCode'] }),
    protocolConfig(protocolSources, { businessKey: [...protocolSources.slice(0, 7), 'quantity', 'priority'] }),
  ]
  for (const config of invalid) assert.equal(validateYidaStaticConfig(config).valid, false)
  const optionalCatalog = [...protocolConfig().fieldCatalog,
    { id: 'unmapped_optional', control: 'text', required: false }]
  assert.equal(validateYidaStaticConfig(protocolConfig(protocolSources,
    { fieldCatalog: optionalCatalog })).valid, true)
  let calls = 0
  const getterConfig = protocolConfig()
  Object.defineProperty(getterConfig, 'fieldCatalog', { enumerable: true,
    get() { calls += 1; return [] } })
  assert.equal(validateYidaStaticConfig(getterConfig).valid, false)
  const getterOption = protocolConfig()
  Object.defineProperty(getterOption.fieldCatalog[8], 'options', { enumerable: true,
    get() { calls += 1; return ['normal'] } })
  assert.equal(validateYidaStaticConfig(getterOption).valid, false)
  assert.equal(calls, 0)
})

test('v2 catalog count, option count, control vocabulary and entry closure have isolated boundaries', async () => {
  const { validateYidaStaticConfig, buildYidaStaticPlan } = await modulePromise
  const base = protocolConfig()
  const optionalEntries = Array.from({ length: 23 }, (_, index) => ({
    id: `optional_${index}`, control: 'text', required: false,
  }))
  const atCatalogLimit = protocolConfig(protocolSources,
    { fieldCatalog: [...base.fieldCatalog, ...optionalEntries] })
  assert.equal(atCatalogLimit.fieldCatalog.length, 32)
  assert.equal(validateYidaStaticConfig(atCatalogLimit).valid, true)
  assert.equal(buildYidaStaticPlan({ config: atCatalogLimit,
    rows: [protocolRow()] }).rows[0].status, 'planned_create')
  const overCatalogLimit = protocolConfig(protocolSources, { fieldCatalog: [
    ...atCatalogLimit.fieldCatalog, { id: 'optional_23', control: 'text', required: false },
  ] })
  assert.equal(overCatalogLimit.fieldCatalog.length, 33)
  assert.equal(validateYidaStaticConfig(overCatalogLimit).valid, false)

  const options64 = ['normal', ...Array.from({ length: 63 }, (_, index) => `choice_${index}`)]
  const withOptions = (options) => protocolConfig(protocolSources, {
    fieldCatalog: base.fieldCatalog.map((entry) => entry.id === 'f_priority'
      ? { ...entry, options } : entry),
  })
  assert.equal(validateYidaStaticConfig(withOptions(options64)).valid, true)
  assert.equal(buildYidaStaticPlan({ config: withOptions(options64),
    rows: [protocolRow()] }).rows[0].status, 'planned_create')
  assert.equal(validateYidaStaticConfig(withOptions([...options64, 'choice_63'])).valid, false)

  const changedEntry = (patch) => protocolConfig(protocolSources, {
    fieldCatalog: base.fieldCatalog.map((entry) => entry.id === 'f_priority'
      ? { ...entry, ...patch } : entry),
  })
  const unknownControl = protocolConfig(protocolSources, {
    fieldCatalog: base.fieldCatalog.map((entry) => entry.id === 'f_parent'
      ? { ...entry, control: 'checkbox' } : entry),
  })
  assert.equal(validateYidaStaticConfig(unknownControl).valid, false)
  assert.equal(validateYidaStaticConfig(changedEntry({ endpoint: 'secret' })).valid, false)
})

test('v2 select/radio values are exact options and invalid rows have no DTO', async () => {
  const { buildYidaStaticPlan } = await modulePromise
  for (const bad of ['Normal', 'normal ', 'unknown']) {
    const row = buildYidaStaticPlan({ config: protocolConfig(),
      rows: [protocolRow(protocolSources, { priority: bad })] }).rows[0]
    assert.equal(row.status, 'invalid')
    assert.ok(row.issues.some((issue) => issue.code === 'FIELD_OPTION_INVALID'))
    assert.equal('protocolPreview' in row, false)
  }
  const radioConfig = protocolConfig()
  radioConfig.fieldCatalog[8].control = 'radio'
  assert.equal(buildYidaStaticPlan({ config: radioConfig,
    rows: [protocolRow()] }).rows[0].status, 'planned_create')
})

test('explicit v1 parser rejects raw numeric losses across mapped and unmapped fields', async () => {
  const { parseYidaStaticRows, YidaStaticPlanError } = await modulePromise
  for (const field of ['quantity', 'extra']) {
    for (const token of ['9007199254740993', '6.00000000000000001', '0.10000000000000001',
      '9007199254740991.1', '0.1234567890123456789', '1e-400', '-1e-400']) {
      const text = `[{"${field}":${token}}]`
      assert.throws(() => parseYidaStaticRows(text, configA()),
        (error) => error instanceof YidaStaticPlanError && error.code === 'YIDA_STATIC_ROWS_INVALID', `${field}:${token}`)
    }
  }
  assert.throws(() => parseYidaStaticRows('[{"quantity":1},{"extra":9007199254740993}]', configA()),
    /YIDA_STATIC_ROWS_INVALID/)
})

test('explicit v1 parser retains exact finite number domain including unsafe integers and negative zero', async () => {
  const { parseYidaStaticRows } = await modulePromise
  for (const token of ['9007199254740992', '1e20', '-0', '-0.000', '-0e8', '0e999999999999999999999',
    '-1.25', '0.1234567', '0.100e0', '6.000000', '1e-20', '1e-300', '5e-324']) {
    const rows = parseYidaStaticRows(`[{"quantity":${token}}]`, configA())
    assert.ok(Object.is(rows[0].quantity, Number(token)), token)
  }
})

test('explicit v1 parser rejects duplicate decoded keys of every scalar type', async () => {
  const { parseYidaStaticRows } = await modulePromise
  for (const text of [
    '[{"quantity":1,"\\u0071uantity":1}]',
    '[{"part":"A","\\u0070art":"B"}]',
    '[{"active":false,"active":true}]',
    '[{"extra":null,"extra":null}]',
    '[{"件数":1,"\\u4ef6\\u6570":1}]',
  ]) assert.throws(() => parseYidaStaticRows(text, configA()), /YIDA_STATIC_ROWS_INVALID/)
  assert.deepEqual(parseYidaStaticRows('[{"quantity":1},{"quantity":2}]', configA()), [{ quantity: 1 }, { quantity: 2 }])
  assert.deepEqual(parseYidaStaticRows('[{"quantity":0.3,"note":"quantity\\":9007199254740993"}]', configA()),
    [{ quantity: 0.3, note: 'quantity":9007199254740993' }])
})

test('no-config parsing and direct v1 planner retain legacy Number and last-key interpretation', async () => {
  const { parseYidaStaticRows, buildYidaStaticPlan } = await modulePromise
  assert.deepEqual(parseYidaStaticRows('[{"quantity":9007199254740993}]'), [{ quantity: 9007199254740992 }])
  assert.deepEqual(parseYidaStaticRows('[{"part":"A","\\u0070art":"B"}]', undefined), [{ part: 'B' }])
  assert.equal(parseYidaStaticRows('[{"quantity":1e-400}]')[0].quantity, 0)
  for (const quantity of [Number('9007199254740993'), -0, -1.25, 0.1234567]) {
    const row = { projectNo: 'P', sourceRowId: 'L', componentCode: 'A', quantity, active: false }
    const planned = buildYidaStaticPlan({ config: configA(), rows: [row] }).rows[0]
    assert.equal(planned.status, 'planned_create')
    assert.ok(Object.is(planned.payload.qty, quantity))
  }
})

test('v2 parser checks raw numeric tokens before JSON precision loss while no-config behavior remains', async () => {
  const { parseYidaStaticRows, YidaStaticPlanError } = await modulePromise
  const config = protocolConfig()
  for (const token of ['9007199254740993', '9007199254740992', '1e20', '9007199254740991.1',
    '0.1234567890123456789', '1e-400', '-0', '6.00000000000000001']) {
    const text = `[{"quantity":${token}}]`
    assert.throws(() => parseYidaStaticRows(text, config),
      (error) => error instanceof YidaStaticPlanError && error.code === 'YIDA_STATIC_ROWS_INVALID', token)
  }
  assert.deepEqual(parseYidaStaticRows('[{"quantity":9007199254740993}]'),
    [{ quantity: 9007199254740992 }])
  for (const token of ['0', '0.3', '0.100e0', '6.000000', '9007199254740991',
    '-1.25', '1e-20', '1e-300']) {
    const rows = parseYidaStaticRows(`[{"quantity":${token}}]`, config)
    assert.equal(rows[0].quantity, Number(token), token)
  }
  assert.throws(() => parseYidaStaticRows('[{"quantity":1,"\\u0071uantity":1}]', config),
    /YIDA_STATIC_ROWS_INVALID/)
  assert.deepEqual(parseYidaStaticRows('[{"quantity":0.3,"note":"quantity\\":9007199254740993"}]', config),
    [{ quantity: 0.3, note: 'quantity":9007199254740993' }])
})

test('v2 raw-token scan handles a near-limit long-zero quantity in linear time',
  { timeout: 2000 }, async () => {
    const { parseYidaStaticRows } = await modulePromise
    const token = `1${'0'.repeat(100000)}1e-100001`
    assert.throws(() => parseYidaStaticRows(`[{"quantity":${token}}]`, protocolConfig()),
      /YIDA_STATIC_ROWS_INVALID/)
  })

test('direct v2 planner rejects unsafe integers and negative zero while preserving finite decimals', async () => {
  const { buildYidaStaticPlan } = await modulePromise
  for (const quantity of [9007199254740992, -0]) {
    const planned = buildYidaStaticPlan({ config: protocolConfig(),
      rows: [protocolRow(protocolSources, { quantity })] }).rows[0]
    assert.equal(planned.status, 'invalid', String(quantity))
    assert.ok(planned.issues.some((issue) => issue.code === 'FIELD_NUMBER_INVALID'))
    assert.equal('protocolPreview' in planned, false)
  }
  for (const quantity of [0.3, 0.1234567, 9007199254.740992, -1.25, 1e-20, 1e-300]) {
    assert.equal(buildYidaStaticPlan({ config: protocolConfig(),
      rows: [protocolRow(protocolSources, { quantity })] }).rows[0].status, 'planned_create')
  }
})

test('v2 synthetic examples have distinct parent identity, equivalent renamed targets and no network-shaped fields', async () => {
  const { createYidaProtocolExample, validateYidaStaticConfig,
    parseYidaStaticRows, buildYidaStaticPlan } = await modulePromise
  const primary = createYidaProtocolExample()
  const renamed = createYidaProtocolExample('renamed')
  for (const example of [primary, renamed]) {
    assert.equal(validateYidaStaticConfig(example.config).valid, true)
    assert.deepEqual(parseYidaStaticRows(example.text), example.rows)
    const plan = buildYidaStaticPlan({ config: example.config, rows: example.rows })
    assert.deepEqual(plan.rows.map((row) => row.status), ['planned_create', 'planned_create'])
    assert.notEqual(plan.rows[0].localBusinessKey, plan.rows[1].localBusinessKey)
    assert.ok(plan.rows.every((row) => row.protocolPreview.contract === 'dingtalk-yida-1.0-data-only'))
    const dto = JSON.stringify(plan.rows.map((row) => row.protocolPreview))
    assert.equal(dto.includes('credential'), false)
    assert.equal(dto.includes('token'), false)
  }
  const first = buildYidaStaticPlan({ config: primary.config, rows: primary.rows })
  const second = buildYidaStaticPlan({ config: renamed.config, rows: renamed.rows })
  assert.deepEqual(first.rows.map((row) => row.payload), second.rows.map((row) => row.payload))
  assert.deepEqual(first.rows.map((row) => row.localBusinessKey),
    second.rows.map((row) => row.localBusinessKey))
  assert.throws(() => createYidaProtocolExample('other'), /YIDA_STATIC_EXAMPLE_INVALID/)
})

test('production-source in-memory mutants independently prove v1 scan, duplicate and numeric comparison gates', async () => {
  const source = fs.readFileSync(modulePath, 'utf8')
  async function mutant(from, to) {
    assert.equal(source.split(from).length, 2, 'mutation target occurs exactly once')
    return import(`data:text/javascript;base64,${Buffer.from(source.replace(from, to)).toString('base64')}`)
  }
  const { parseYidaStaticRows } = await modulePromise
  const lossy = '[{"quantity":6.00000000000000001}]'
  const duplicate = '[{"part":"A","\\u0070art":"B"}]'
  assert.throws(() => parseYidaStaticRows(lossy, configA()), /YIDA_STATIC_ROWS_INVALID/)
  assert.throws(() => parseYidaStaticRows(duplicate, configA()), /YIDA_STATIC_ROWS_INVALID/)

  const v2OnlyScan = await mutant(
    '    validateRowTokens(text, rows, validation.normalized.version)',
    '    if (validation.normalized.version === 2) validateRowTokens(text, rows, validation.normalized.version)',
  )
  assert.deepEqual(v2OnlyScan.parseYidaStaticRows(lossy, configA()), [{ quantity: 6 }])
  assert.deepEqual(v2OnlyScan.parseYidaStaticRows(duplicate, configA()), [{ part: 'B' }])

  const uncheckedDuplicate = await mutant(
    "if (seen.has(key)) throw new YidaStaticPlanError('YIDA_STATIC_ROWS_INVALID')",
    "if (false) throw new YidaStaticPlanError('YIDA_STATIC_ROWS_INVALID')",
  )
  assert.deepEqual(uncheckedDuplicate.parseYidaStaticRows(duplicate, configA()), [{ part: 'B' }])

  const uncheckedNumeric = await mutant(
    'raw.coefficient !== parsed.coefficient || raw.exponent !== parsed.exponent',
    'false',
  )
  assert.deepEqual(uncheckedNumeric.parseYidaStaticRows(lossy, configA()), [{ quantity: 6 }])
})

test('in-memory v2 guard mutations break independent identity, parser, options and DTO oracles', async () => {
  const source = fs.readFileSync(modulePath, 'utf8')
  async function mutant(from, to) {
    assert.equal(source.split(from).length, 2, 'mutation target occurs exactly once')
    return import(`data:text/javascript;base64,${Buffer.from(source.replace(from, to)).toString('base64')}`)
  }
  const unsorted = await mutant(
    '}).sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)',
    '})',
  )
  assert.notEqual(unsorted.buildYidaStaticPlan({ config: protocolConfig(),
    rows: [protocolRow()] }).rows[0].localBusinessKey, expectedProtocolKey())

  const uncheckedRaw = await mutant(
    'raw.coefficient !== parsed.coefficient || raw.exponent !== parsed.exponent',
    'false',
  )
  const imprecise = '[{"quantity":6.00000000000000001}]'
  assert.doesNotThrow(() => uncheckedRaw.parseYidaStaticRows(imprecise, protocolConfig()))
  const { parseYidaStaticRows } = await modulePromise
  assert.throws(() => parseYidaStaticRows(imprecise, protocolConfig()), /YIDA_STATIC_ROWS_INVALID/)

  const uncheckedOption = await mutant('&& !control.options.includes(value)', '&& false')
  const badOption = protocolRow(protocolSources, { priority: 'unknown' })
  assert.equal(uncheckedOption.buildYidaStaticPlan({ config: protocolConfig(),
    rows: [badOption] }).rows[0].status, 'planned_create')
  const { buildYidaStaticPlan } = await modulePromise
  assert.equal(buildYidaStaticPlan({ config: protocolConfig(), rows: [badOption] }).rows[0].status, 'invalid')

  const leakyDto = await mutant(
    "if (planned.status !== 'invalid') planned.protocolPreview = protocolPreview(config, planned)",
    'if (true) planned.protocolPreview = protocolPreview(config, planned)',
  )
  const duplicate = [protocolRow(), protocolRow()]
  assert.ok(leakyDto.buildYidaStaticPlan({ config: protocolConfig(),
    rows: duplicate }).rows.every((row) => 'protocolPreview' in row))
  assert.ok(buildYidaStaticPlan({ config: protocolConfig(),
    rows: duplicate }).rows.every((row) => !('protocolPreview' in row)))
})
