'use strict'

// Synthetic, offline draft compilation. No store, credentials, transport or ledger.
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const path = require('node:path')
const { test } = require('node:test')
const { pathToFileURL } = require('node:url')
const { stableCanonicalStringify } = require('../lib/gip-canonical-json.cjs')

const modulePromise = import(pathToFileURL(path.join(__dirname, '../lib/yida-draft-plan.mjs')).href)
const plannerPromise = import(pathToFileURL(path.join(__dirname, '../lib/yida-static-plan.mjs')).href)
const allocationPromise = import(pathToFileURL(path.join(__dirname, '../lib/stock-preparation-yida-allocation.mjs')).href)

function config(patch = {}) {
  return {
    version: 2, kind: 'yida-form-protocol-static',
    target: { appType: 'synthetic_draft_app', formUuid: 'synthetic_draft_form' },
    intent: 'create', businessKey: ['projectNo', 'lineId', 'parentCode'], emptyKeyFields: ['parentCode'],
    fieldCatalog: [
      { id: 'project', control: 'text', required: true },
      { id: 'line', control: 'text', required: true },
      { id: 'parent', control: 'text', required: false },
      { id: 'qty', control: 'number', required: true },
      { id: 'description', control: 'text', required: false },
    ],
    fieldMap: [
      { source: 'projectNo', target: 'project', type: 'string', required: true },
      { source: 'lineId', target: 'line', type: 'string', required: true },
      { source: 'parentCode', target: 'parent', type: 'string', required: false },
      { source: 'quantity', target: 'qty', type: 'number', required: true },
      { source: 'description', target: 'description', type: 'string', required: false },
    ],
    ...patch,
  }
}

function row(lineId = 'LINE-1', quantity = 6) {
  return { projectNo: 'DEMO-P1', lineId, parentCode: null, quantity, description: 'synthetic part' }
}

function allocation(mode = 'equal_integer', projects = ['DEMO-P1', 'DEMO-P2']) {
  return { mode, projects, projectField: 'projectNo', quantityField: 'quantity' }
}

function input(rows = [row()], layout = config(), settings = { mode: 'original' }) {
  return { config: layout, rowsText: JSON.stringify(rows), allocation: settings }
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function digest(value) {
  return sha256(stableCanonicalStringify(value))
}

function compareCodePoints(left, right) {
  const a = Array.from(left, (character) => character.codePointAt(0))
  const b = Array.from(right, (character) => character.codePointAt(0))
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1
  }
  return a.length - b.length
}

// Independent oracle: use actual shared canonical bytes and actual planner output,
// never a draft module helper or a regex that merely accepts a digest-shaped string.
function expectedDigests(normalized, plan) {
  const locator = normalized.target
  const keyDefinition = {
    algorithm: 'yida-protocol-v2',
    fields: normalized.businessKey.map((source) => {
      const mapped = normalized.fieldMap.find((entry) => entry.source === source)
      return { target: mapped.target, type: mapped.type, empty: normalized.emptyKeyFields.includes(source) }
    }).sort((left, right) => compareCodePoints(left.target, right.target)),
  }
  const rowSpecs = plan.rows.map((planned) => {
    const jsonField = normalized.intent === 'create' ? 'formDataJson' : 'updateFormDataJson'
    return {
      index: planned.index,
      businessKeyDigest: sha256(planned.localBusinessKey),
      payloadDigest: digest({
        intent: normalized.intent,
        formUuid: locator.formUuid,
        data: { ...planned.protocolPreview.data, [jsonField]: stableCanonicalStringify(planned.payload) },
      }),
    }
  })
  return {
    locator, locatorDigest: digest({ version: 1, kind: 'yida-local-locator', ...locator }),
    keyDefinition, keyDefinitionDigest: digest(keyDefinition), rowSpecs,
    planDigest: digest({ version: 1, kind: 'yida-local-plan', locator, keyDefinition,
      intent: normalized.intent,
      rows: rowSpecs.map(({ businessKeyDigest, payloadDigest }) => ({ businessKeyDigest, payloadDigest }))
        .sort((left, right) => compareCodePoints(left.businessKeyDigest, right.businessKeyDigest)),
    }),
  }
}

function assertFrozenTree(value) {
  if (value === null || typeof value !== 'object') return
  assert.equal(Object.isFrozen(value), true)
  for (const child of Object.values(value)) assertFrozenTree(child)
}

function expectError(compile, ErrorClass, candidate, code) {
  assert.throws(() => compile(candidate), (error) => {
    assert.ok(error instanceof ErrorClass)
    assert.equal(error.name, 'YidaDraftPlanError')
    assert.equal(error.code, code)
    assert.equal(error.message, code)
    assert.equal(Object.hasOwn(error, 'cause'), false)
    assert.deepEqual(Object.keys(error).sort(), ['code', 'name'])
    return true
  })
}

test('exports only the compiler and fixed draft error class', async () => {
  const exported = await modulePromise
  assert.deepEqual(Object.keys(exported).sort(), ['YidaDraftPlanError', 'compileYidaDraft'])
})

test('original draft contains the real full plan, exact normalized source and independently computed digests', async () => {
  const { compileYidaDraft } = await modulePromise
  const { buildYidaStaticPlan, parseYidaStaticRows, validateYidaStaticConfig } = await plannerPromise
  const raw = input([row(), row('LINE-2', 0)])
  raw.config.target.appType = ` ${raw.config.target.appType} `
  raw.rowsText = `\n ${JSON.stringify([row(), row('LINE-2', 0)], null, 2)}\n`
  const normalized = validateYidaStaticConfig(raw.config).normalized
  const plan = buildYidaStaticPlan({ config: normalized, rows: parseYidaStaticRows(raw.rowsText, normalized) })
  const result = compileYidaDraft(raw)
  assert.deepEqual(result, {
    source: { config: normalized, rowsText: raw.rowsText, allocation: { mode: 'original' } },
    ...expectedDigests(normalized, plan), plan,
  })
  assert.equal(result.plan.canApply, false)
  assert.equal(result.plan.tokenIssued, false)
  assert.equal(result.plan.lookupExecuted, false)
  assert.equal(result.plan.externalWriteAttempted, false)
  assert.ok(result.plan.rows.every((entry) => entry.remoteState === 'unverified'))
})

test('the actual seven-key UI protocol example is a successful original draft', async () => {
  const { compileYidaDraft } = await modulePromise
  const { createYidaProtocolExample, validateYidaStaticConfig, buildYidaStaticPlan } = await plannerPromise
  const example = createYidaProtocolExample()
  const normalized = validateYidaStaticConfig(example.config).normalized
  const plan = buildYidaStaticPlan({ config: normalized, rows: example.rows })
  const result = compileYidaDraft({ config: example.config, rowsText: example.text, allocation: { mode: 'original' } })
  assert.equal(result.keyDefinition.fields.length, 7)
  assert.deepEqual(result.plan, plan)
  for (const [key, value] of Object.entries(expectedDigests(normalized, plan))) assert.deepEqual(result[key], value)
  assert.deepEqual(result.source, { config: normalized, rowsText: example.text, allocation: { mode: 'original' } })
})

test('every owned output node is frozen and caller mutation cannot change source, plan or digests', async () => {
  const { compileYidaDraft } = await modulePromise
  const raw = input([row()], config(), allocation())
  const before = JSON.stringify(raw)
  const result = compileYidaDraft(raw)
  assert.equal(JSON.stringify(raw), before)
  assertFrozenTree(result)
  assert.notEqual(result.source, raw)
  assert.notEqual(result.source.config, raw.config)
  assert.notEqual(result.source.config.fieldMap, raw.config.fieldMap)
  assert.notEqual(result.source.allocation.projects, raw.allocation.projects)
  const serialized = stableCanonicalStringify(result)
  raw.config.target.appType = 'changed_app'
  raw.config.fieldMap[0].target = 'changed_field'
  raw.config.businessKey.reverse()
  raw.allocation.projects[0] = 'CHANGED-P'
  raw.rowsText = '[]'
  assert.equal(stableCanonicalStringify(result), serialized)
  assert.throws(() => { result.plan.rows[0].payload.qty = 999 }, TypeError)
  assert.throws(() => { result.rowSpecs.push({}) }, TypeError)
})

for (const [mode, quantity, projects, expectedQuantity] of [
  ['equal_integer', 6, ['DEMO-P1', 'DEMO-P2', 'DEMO-P3'], 2],
  ['equal_decimal_exact', 0.3, ['DEMO-P1', 'DEMO-P2', 'DEMO-P3'], 0.1],
]) {
  test(`${mode} uses actual allocation plan and hashes every expanded candidate`, async () => {
    const { compileYidaDraft } = await modulePromise
    const { buildYidaProjectAllocationPreview } = await allocationPromise
    const { validateYidaStaticConfig } = await plannerPromise
    const raw = input([row('LINE-1', quantity)], config(), allocation(mode, projects))
    const normalized = validateYidaStaticConfig(raw.config).normalized
    const expectedPlan = buildYidaProjectAllocationPreview(raw).plan
    const result = compileYidaDraft(raw)
    assert.deepEqual(result.plan, expectedPlan)
    assert.deepEqual(result.source.allocation, raw.allocation)
    const expected = expectedDigests(normalized, expectedPlan)
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(result[key], value)
    assert.deepEqual(result.plan.rows.map((entry) => entry.payload.qty), projects.map(() => expectedQuantity))
    assert.deepEqual(result.rowSpecs.map((entry) => entry.index), projects.map((_, index) => index))
    assertFrozenTree(result)
  })
}

test('field map, catalog, business key, row property and row order do not change the semantic plan digest', async () => {
  const { compileYidaDraft } = await modulePromise
  const rows = [row(), row('LINE-2', 4)]
  const original = compileYidaDraft(input(rows))
  const reorderedConfig = config()
  reorderedConfig.fieldMap.reverse()
  reorderedConfig.fieldCatalog.reverse()
  reorderedConfig.businessKey.reverse()
  const reversedProperties = rows.map((entry) => Object.fromEntries(Object.entries(entry).reverse())).reverse()
  const reordered = compileYidaDraft(input(reversedProperties, reorderedConfig))
  assert.equal(reordered.planDigest, original.planDigest)
  assert.equal(reordered.locatorDigest, original.locatorDigest)
  assert.equal(reordered.keyDefinitionDigest, original.keyDefinitionDigest)
  assert.notEqual(reordered.plan.rows[1].protocolPreview.data.formDataJson,
    original.plan.rows[0].protocolPreview.data.formDataJson)
  assert.equal(reordered.rowSpecs[0].businessKeyDigest, original.rowSpecs[1].businessKeyDigest)
  assert.equal(reordered.rowSpecs[0].payloadDigest, original.rowSpecs[1].payloadDigest)
  assert.deepEqual(reordered.rowSpecs.map((entry) => entry.index), [0, 1])
})

test('renaming source aliases preserves target-based key definition and all semantic row digests', async () => {
  const { compileYidaDraft } = await modulePromise
  const aliases = { projectNo: '项目号', lineId: '明细号', parentCode: '父图号', quantity: '件数', description: '说明' }
  const renamed = config()
  renamed.businessKey = renamed.businessKey.map((source) => aliases[source])
  renamed.emptyKeyFields = renamed.emptyKeyFields.map((source) => aliases[source])
  renamed.fieldMap = renamed.fieldMap.map((entry) => ({ ...entry, source: aliases[entry.source] }))
  const rows = [row(), row('LINE-2', 2)]
  const translated = rows.map((entry) => Object.fromEntries(Object.entries(entry).map(([key, value]) => [aliases[key], value])))
  const original = compileYidaDraft(input(rows))
  const result = compileYidaDraft(input(translated, renamed))
  assert.equal(result.planDigest, original.planDigest)
  assert.deepEqual(result.keyDefinition, original.keyDefinition)
  assert.deepEqual(result.rowSpecs, original.rowSpecs)
  assert.notDeepEqual(result.source.config, original.source.config)
})

test('allocation project ordering changes output order but not semantic plan digest', async () => {
  const { compileYidaDraft } = await modulePromise
  const first = compileYidaDraft(input([row()], config(), allocation()))
  const reversed = compileYidaDraft(input([row()], config(), allocation('equal_integer', ['DEMO-P2', 'DEMO-P1'])))
  assert.equal(reversed.planDigest, first.planDigest)
  assert.deepEqual(reversed.source.allocation.projects, ['DEMO-P2', 'DEMO-P1'])
  assert.equal(reversed.rowSpecs[0].businessKeyDigest, first.rowSpecs[1].businessKeyDigest)
})

test('non-key payload changes affect payload and plan digests but preserve business and definition digests', async () => {
  const { compileYidaDraft } = await modulePromise
  const first = compileYidaDraft(input())
  const changed = compileYidaDraft(input([row('LINE-1', 7)]))
  assert.equal(changed.rowSpecs[0].businessKeyDigest, first.rowSpecs[0].businessKeyDigest)
  assert.equal(changed.keyDefinitionDigest, first.keyDefinitionDigest)
  assert.equal(changed.locatorDigest, first.locatorDigest)
  assert.notEqual(changed.rowSpecs[0].payloadDigest, first.rowSpecs[0].payloadDigest)
  assert.notEqual(changed.planDigest, first.planDigest)
})

test('locator app and form changes are distinct from key definition semantics', async () => {
  const { compileYidaDraft } = await modulePromise
  const first = compileYidaDraft(input())
  for (const field of ['appType', 'formUuid']) {
    const changedConfig = config()
    changedConfig.target[field] += '_other'
    const changed = compileYidaDraft(input([row()], changedConfig))
    assert.notEqual(changed.locatorDigest, first.locatorDigest)
    assert.equal(changed.keyDefinitionDigest, first.keyDefinitionDigest)
    assert.notEqual(changed.rowSpecs[0].businessKeyDigest, first.rowSpecs[0].businessKeyDigest)
    assert.notEqual(changed.rowSpecs[0].payloadDigest, first.rowSpecs[0].payloadDigest)
    assert.notEqual(changed.planDigest, first.planDigest)
  }
})

test('key definition digest covers target controls, declared types and empty-key semantics', async () => {
  const { compileYidaDraft } = await modulePromise
  const sourceRow = { ...row(), parentCode: 'PARENT-1' }
  const original = compileYidaDraft(input([sourceRow]))
  const changedTarget = config()
  changedTarget.fieldMap.find((entry) => entry.source === 'lineId').target = 'otherLine'
  changedTarget.fieldCatalog.find((entry) => entry.id === 'line').id = 'otherLine'
  const changedType = config()
  changedType.fieldMap.find((entry) => entry.source === 'lineId').type = 'number'
  changedType.fieldCatalog.find((entry) => entry.id === 'line').control = 'number'
  const candidates = [
    input([sourceRow], changedTarget),
    input([{ ...sourceRow, lineId: 1 }], changedType),
    input([sourceRow], config({ emptyKeyFields: [] })),
  ]
  for (const candidate of candidates) {
    const changed = compileYidaDraft(candidate)
    assert.equal(changed.locatorDigest, original.locatorDigest)
    assert.notEqual(changed.keyDefinitionDigest, original.keyDefinitionDigest)
    assert.equal(changed.keyDefinitionDigest, digest(changed.keyDefinition))
    assert.notEqual(changed.planDigest, original.planDigest)
  }
})

test('definition fields sort by Unicode code point rather than locale or UTF-16 order', async () => {
  const { compileYidaDraft } = await modulePromise
  const { validateYidaStaticConfig, buildYidaStaticPlan } = await plannerPromise
  const layout = config()
  for (const [source, oldTarget, target] of [['projectNo', 'project', 'Ａ'], ['lineId', 'line', '𐐀']]) {
    layout.fieldMap.find((entry) => entry.source === source).target = target
    layout.fieldCatalog.find((entry) => entry.id === oldTarget).id = target
  }
  const normalized = validateYidaStaticConfig(layout).normalized
  const plan = buildYidaStaticPlan({ config: normalized, rows: [row()] })
  const result = compileYidaDraft(input([row()], layout))
  assert.deepEqual(result.keyDefinition.fields.map((field) => field.target), ['parent', 'Ａ', '𐐀'])
  assert.equal(result.keyDefinitionDigest, expectedDigests(normalized, plan).keyDefinitionDigest)
  assert.equal(result.planDigest, expectedDigests(normalized, plan).planDigest)
})

test('missing, null and empty optional keys share the real planner empty-key business identity', async () => {
  const { compileYidaDraft, YidaDraftPlanError } = await modulePromise
  const missing = row()
  delete missing.parentCode
  const variants = [missing, row(), { ...row(), parentCode: '' }].map((entry) => compileYidaDraft(input([entry])))
  assert.equal(new Set(variants.map((entry) => entry.rowSpecs[0].businessKeyDigest)).size, 1)
  assert.equal(new Set(variants.map((entry) => entry.planDigest)).size, 1)
  expectError(compileYidaDraft, YidaDraftPlanError, input([{ ...row(), parentCode: ' ' }]), 'YIDA_DRAFT_PLAN')
})

test('update hashes canonical update data including instance identity and explicit form locator', async () => {
  const { compileYidaDraft } = await modulePromise
  const { validateYidaStaticConfig, buildYidaStaticPlan } = await plannerPromise
  const layout = config({ intent: 'update', instanceIdField: 'instance' })
  const rows = [{ ...row(), instance: 'synthetic_instance_1' }]
  const normalized = validateYidaStaticConfig(layout).normalized
  const plan = buildYidaStaticPlan({ config: normalized, rows })
  const original = compileYidaDraft(input(rows, layout))
  assert.deepEqual(original.rowSpecs, expectedDigests(normalized, plan).rowSpecs)
  assert.equal(original.planDigest, expectedDigests(normalized, plan).planDigest)
  const changed = compileYidaDraft(input([{ ...rows[0], instance: 'synthetic_instance_2' }], layout))
  assert.equal(changed.rowSpecs[0].businessKeyDigest, original.rowSpecs[0].businessKeyDigest)
  assert.notEqual(changed.rowSpecs[0].payloadDigest, original.rowSpecs[0].payloadDigest)
  assert.notEqual(changed.planDigest, original.planDigest)
})

test('whole-plan refusal covers zero rows, invalid candidates and duplicate business keys', async () => {
  const { compileYidaDraft, YidaDraftPlanError } = await modulePromise
  const missingQuantity = row()
  delete missingQuantity.quantity
  const missingKey = row()
  delete missingKey.lineId
  for (const rows of [[], [missingQuantity], [missingKey], [{ ...row(), quantity: '6' }], [row(), row()],
    [row(), { ...row('LINE-2'), quantity: 'synthetic_wrong_type' }]]) {
    expectError(compileYidaDraft, YidaDraftPlanError, input(rows), 'YIDA_DRAFT_PLAN')
  }
  const update = config({ intent: 'update', instanceIdField: 'instance' })
  expectError(compileYidaDraft, YidaDraftPlanError, input([row()], update), 'YIDA_DRAFT_PLAN')
})

test('allocation refusals and duplicate expanded candidates cannot become partial drafts', async () => {
  const { compileYidaDraft, YidaDraftPlanError } = await modulePromise
  for (const [mode, quantity, projects] of [
    ['equal_integer', 5, ['DEMO-P1', 'DEMO-P2']],
    ['equal_decimal_exact', 1, ['DEMO-P1', 'DEMO-P2', 'DEMO-P3']],
  ]) {
    expectError(compileYidaDraft, YidaDraftPlanError,
      input([row('LINE-1', quantity)], config(), allocation(mode, projects)), 'YIDA_DRAFT_PLAN')
  }
  expectError(compileYidaDraft, YidaDraftPlanError,
    input([row(), row()], config(), allocation()), 'YIDA_DRAFT_PLAN')
  expectError(compileYidaDraft, YidaDraftPlanError,
    input([row(), { ...row('LINE-2'), quantity: 'bad' }], config(), allocation()), 'YIDA_DRAFT_PLAN')
})

test('actual allocation rejects invalid projects, incompatible roles and update intent', async () => {
  const { compileYidaDraft, YidaDraftPlanError } = await modulePromise
  for (const settings of [allocation('equal_integer', []), allocation('equal_integer', ['DEMO-P1', ' DEMO-P1 ']),
    allocation('equal_integer', ['']), { ...allocation(), projectField: 'missing' },
    { ...allocation(), quantityField: 'projectNo' }, { ...allocation(), projects: 'DEMO-P1' }]) {
    expectError(compileYidaDraft, YidaDraftPlanError, input([row()], config(), settings), 'YIDA_DRAFT_PLAN')
  }
  const layout = config({ intent: 'update', instanceIdField: 'instance' })
  expectError(compileYidaDraft, YidaDraftPlanError,
    input([{ ...row(), instance: 'synthetic_instance' }], layout, allocation()), 'YIDA_DRAFT_PLAN')
})

test('original and expanded plans accept exactly 100 rows and reject larger whole plans', async () => {
  const { compileYidaDraft, YidaDraftPlanError } = await modulePromise
  const rows = Array.from({ length: 101 }, (_, index) => row(`LINE-${index}`, 2))
  const hundred = compileYidaDraft(input(rows.slice(0, 100)))
  assert.equal(hundred.rowSpecs.length, 100)
  assert.equal(hundred.plan.evidence.plannedCreate, 100)
  expectError(compileYidaDraft, YidaDraftPlanError, input(rows), 'YIDA_DRAFT_LIMIT')
  const expanded = compileYidaDraft(input(rows.slice(0, 50), config(), allocation()))
  assert.equal(expanded.rowSpecs.length, 100)
  expectError(compileYidaDraft, YidaDraftPlanError,
    input(rows.slice(0, 51), config(), allocation()), 'YIDA_DRAFT_LIMIT')
})

test('actual parser text and allocation expansion budgets cannot be bypassed by larger wrapper budgets', async () => {
  const { compileYidaDraft, YidaDraftPlanError } = await modulePromise
  const rowsText = `${' '.repeat(128 * 1024)}${JSON.stringify([row()])}`
  assert.ok(Buffer.byteLength(rowsText) < 2 * 1024 * 1024)
  for (const settings of [{ mode: 'original' }, allocation()]) {
    expectError(compileYidaDraft, YidaDraftPlanError,
      { config: config(), rowsText, allocation: settings }, 'YIDA_DRAFT_LIMIT')
  }
  const rows = Array.from({ length: 30 }, (_, index) => ({ ...row(`LINE-${index}`, 3),
    description: 'x'.repeat(1600) }))
  assert.ok(Buffer.byteLength(JSON.stringify(rows)) < 128 * 1024)
  expectError(compileYidaDraft, YidaDraftPlanError,
    input(rows, config(), allocation('equal_integer', ['DEMO-P1', 'DEMO-P2', 'DEMO-P3'])), 'YIDA_DRAFT_LIMIT')
})

test('raw decoded duplicate keys and lossy quantities are rejected before any draft is returned', async () => {
  const { compileYidaDraft, YidaDraftPlanError } = await modulePromise
  const texts = [
    '[{"projectNo":"DEMO-P1","lineId":"LINE-1","\\u006cineId":"LINE-2","quantity":6}]',
    '[{"projectNo":"DEMO-P1","lineId":"LINE-1","quantity":6,"\\u0071uantity":6}]',
    ...['9007199254740993', '6.00000000000000001', '1e-400', '-0', '1e999', 'NaN', 'Infinity'].map((quantity) =>
      `[{"projectNo":"DEMO-P1","lineId":"LINE-1","quantity":${quantity}}]`),
    '[{"projectNo":"DEMO-P1","lineId":"LINE-1","quantity":6,"unused":9007199254740993}]',
  ]
  for (const settings of [{ mode: 'original' }, allocation()]) {
    for (const rowsText of texts) {
      expectError(compileYidaDraft, YidaDraftPlanError,
        { config: config(), rowsText, allocation: settings }, 'YIDA_DRAFT_PLAN')
    }
  }
})

test('exact decimal tokens and escaped source names preserve actual finite numeric values', async () => {
  const { compileYidaDraft } = await modulePromise
  const raw = input()
  raw.rowsText = '[{"projectNo":"DEMO-P1","\\u006cineId":"LINE-1","quantity":0.3000000000000000}]'
  const result = compileYidaDraft(raw)
  assert.equal(result.plan.rows[0].payload.qty, 0.3)
  assert.equal(result.source.rowsText, raw.rowsText)
  const ordinary = compileYidaDraft({ ...raw, rowsText: raw.rowsText.replace('0.3000000000000000', '0.3') })
  assert.equal(result.planDigest, ordinary.planDigest)
})

test('invalid JSON, nonflat rows, unsupported row values and forbidden row names use fixed PLAN errors', async () => {
  const { compileYidaDraft, YidaDraftPlanError } = await modulePromise
  for (const rowsText of ['{bad', '{}', '[null]', '[[1]]', '[{"lineId":{}}]', '[{"__proto__":"x"}]',
    '[{"projectNo":"DEMO-P1","lineId":"LINE-1","quantity":6,"note":[1]}]']) {
    expectError(compileYidaDraft, YidaDraftPlanError, { ...input(), rowsText }, 'YIDA_DRAFT_PLAN')
  }
})

test('only version 2 valid local protocol config can compile', async () => {
  const { compileYidaDraft, YidaDraftPlanError } = await modulePromise
  const { createYidaStaticExample } = await plannerPromise
  for (const layout of [null, {}, config({ version: 1 }), createYidaStaticExample().config,
    config({ target: { appType: 'synthetic_only' } }), config({ businessKey: [] }),
    config({ intent: 'send' }), config({ unexpected: true })]) {
    expectError(compileYidaDraft, YidaDraftPlanError, input([row()], layout), 'YIDA_DRAFT_CONFIG')
  }
})

test('top-level and allocation records are closed, with no authority or prebuilt-plan input', async () => {
  const { compileYidaDraft, YidaDraftPlanError } = await modulePromise
  const missing = input()
  delete missing.rowsText
  for (const candidate of [null, [], {}, missing, { ...input(), plan: {} }, { ...input(), canApply: true },
    { ...input(), rows: [row()] }, { ...input(), rowsText: 1 },
    { ...input(), allocation: null }, { ...input(), allocation: {} },
    { ...input(), allocation: { mode: 'original', projects: [] } },
    { ...input(), allocation: { mode: 'round' } },
    { ...input(), allocation: { mode: 'equal_integer', projects: ['DEMO-P1'], projectField: 'projectNo' } },
    { ...input(), allocation: { ...allocation(), extra: true } }]) {
    expectError(compileYidaDraft, YidaDraftPlanError, candidate, 'YIDA_DRAFT_INPUT')
  }
})

test('raw proxies are refused without calling their traps, including nested and revoked proxies', async () => {
  const { compileYidaDraft, YidaDraftPlanError } = await modulePromise
  let calls = 0
  const traps = {
    get() { calls += 1; throw new Error('synthetic trap') },
    getPrototypeOf() { calls += 1; throw new Error('synthetic trap') },
    ownKeys() { calls += 1; throw new Error('synthetic trap') },
    getOwnPropertyDescriptor() { calls += 1; throw new Error('synthetic trap') },
  }
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  for (const candidate of [new Proxy(input(), traps),
    { ...input(), config: new Proxy(config(), traps) },
    { ...input(), allocation: allocation('equal_integer', new Proxy(['DEMO-P1'], traps)) },
    { ...input(), config: revoked.proxy }]) {
    expectError(compileYidaDraft, YidaDraftPlanError, candidate, 'YIDA_DRAFT_INPUT')
  }
  assert.equal(calls, 0)
})

test('accessors, hidden fields, symbol fields and serialization hooks never execute', async () => {
  const { compileYidaDraft, YidaDraftPlanError } = await modulePromise
  let calls = 0
  const candidates = []
  const getter = input()
  Object.defineProperty(getter, 'rowsText', { enumerable: true, get() { calls += 1; return '[]' } })
  candidates.push(getter)
  const nestedGetter = input()
  Object.defineProperty(nestedGetter.config.target, 'appType', { enumerable: true, get() { calls += 1; return 'x' } })
  candidates.push(nestedGetter)
  const arrayGetter = input([row()], config(), allocation())
  Object.defineProperty(arrayGetter.allocation.projects, '0', { enumerable: true, get() { calls += 1; return 'x' } })
  candidates.push(arrayGetter)
  const hidden = input()
  Object.defineProperty(hidden, 'hidden', { value: 1 })
  candidates.push(hidden)
  const symbol = input()
  symbol.config[Symbol('synthetic')] = 1
  candidates.push(symbol)
  const hook = input()
  hook.config.toJSON = () => { calls += 1; return {} }
  candidates.push(hook)
  for (const candidate of candidates) expectError(compileYidaDraft, YidaDraftPlanError, candidate, 'YIDA_DRAFT_INPUT')
  assert.equal(calls, 0)
})

test('cycles, sparse/exotic arrays, null/inherited prototypes and non-JSON primitives are fixed INPUT refusals', async () => {
  const { compileYidaDraft, YidaDraftPlanError } = await modulePromise
  const cycle = input()
  cycle.config.loop = cycle
  const sparse = ['DEMO-P1', 'DEMO-P2']
  delete sparse[1]
  const extraArray = ['DEMO-P1']
  extraArray.extra = true
  const exoticArray = ['DEMO-P1']
  Object.setPrototypeOf(exoticArray, Object.create(Array.prototype))
  const inherited = Object.assign(Object.create({ inherited: true }), input())
  const nullPrototype = Object.assign(Object.create(null), input())
  const nestedNull = input()
  nestedNull.config.target = Object.assign(Object.create(null), nestedNull.config.target)
  const values = [undefined, NaN, Infinity, -Infinity, -0, 1n, Symbol('synthetic'), () => 1,
    new Date(0), new Map(), new Set(), new (class Synthetic {})()]
  const candidates = [cycle, inherited, nullPrototype, nestedNull,
    ...[sparse, extraArray, exoticArray].map((projects) => input([row()], config(), allocation('equal_integer', projects))),
    ...values.map((value) => ({ ...input(), config: { ...config(), unsupported: value } })),
  ]
  for (const candidate of candidates) expectError(compileYidaDraft, YidaDraftPlanError, candidate, 'YIDA_DRAFT_INPUT')
})

test('raw UTF-8 input bytes, depth and node budgets refuse before planner validation', async () => {
  const { compileYidaDraft, YidaDraftPlanError } = await modulePromise
  for (const rowsText of ['x'.repeat(2 * 1024 * 1024 + 1), '界'.repeat(750000)]) {
    assert.ok(Buffer.byteLength(rowsText, 'utf8') > 2 * 1024 * 1024)
    expectError(compileYidaDraft, YidaDraftPlanError, { ...input(), rowsText }, 'YIDA_DRAFT_LIMIT')
  }
  const deep = input()
  let cursor = deep.config
  for (let depth = 0; depth < 14; depth += 1) {
    cursor.nested = {}
    cursor = cursor.nested
  }
  expectError(compileYidaDraft, YidaDraftPlanError, deep, 'YIDA_DRAFT_LIMIT')
  const many = input()
  many.config.nodes = Array.from({ length: 20001 }, () => null)
  expectError(compileYidaDraft, YidaDraftPlanError, many, 'YIDA_DRAFT_LIMIT')
})
