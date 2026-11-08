'use strict'

// Synthetic, offline draft compilation. No store, credentials or ledger; the form
// transport appears only disabled, as an offline input oracle whose fetch throws.
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const path = require('node:path')
const { test } = require('node:test')
const { pathToFileURL } = require('node:url')
const { stableCanonicalStringify } = require('../lib/gip-canonical-json.cjs')
const { createYidaFormTransport } = require('../lib/yida-form-transport.cjs')

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

test('exports the two persisted-path compilers and the fixed draft error class', async () => {
  const exported = await modulePromise
  assert.deepEqual(Object.keys(exported).sort(), ['YidaDraftPlanError', 'compileYidaDraft', 'compileYidaSendDraft'])
})

// R-71 ⑦.3 (B2): literal v2 goldens, computed by the base compiler before this change. A stored v2
// draft, an L4-sealed plan digest and a ledger plan revision must keep exactly these bytes, through
// the initialization entry and the send entry alike.
const V2_GOLDEN = {
  protocol: {
    planDigest: 'abab832e3a8c42adecb79e244901400f47b61b712fa922f2a863688366e07fcd',
    keyDefinitionDigest: '45e2fcf5e9ea73a18f75319b2b43632c9969de643802220439deed1924aa9495',
    locatorDigest: 'bb9d4879e19db998bf1aa865102470bb3fea7c2a149d4bdb888e653bd52569e2',
    rowSpecs: [
      { index: 0, businessKeyDigest: 'fa3228a6f42b2725a14ba1a4bd9d0665eb43a302a901bfb92a8277cecc362b49', payloadDigest: '3f7f9a196dd22e9b37bfee43e2623457c6c8843b13441253c339527f3a8b2166' },
      { index: 1, businessKeyDigest: 'efedaff7d65b4b06eea4b7bffaea130d78518f9f9ee79ca24fc8e12ad5acdd4d', payloadDigest: '65c04d05883a4b6ab242f36692d518aef408f684b8afd2464cfcc44b814c1088' },
    ],
  },
  material: {
    planDigest: 'fb883eb7830903d243dc5acf7df5593a0d66970aa4defdf86d808b78c6969066',
    keyDefinitionDigest: 'd320bf2a69eeff33b75ad11af51a50f8000d62d2dc0965bf16d35ef283a96f26',
    locatorDigest: '9c954dc26211cd6de7190ceda515a56d5aec59c331f01c607acb44db29a98369',
    rowSpecs: [
      { index: 0, businessKeyDigest: 'e54631415663b1a44ee2acd473a1b24fe78c780e8581b1bfea8a44a20e838426', payloadDigest: 'ba606ceb515d63688d80487191c33d0c78d9fd8d5fe2f7802e50d2c9de0e790f' },
      { index: 1, businessKeyDigest: '0ad6b53932125831250141dbf6debc370c3c7077c5235d13f249c7160a87a851', payloadDigest: '1b39c25b35a44b77d99796e6ed6349285c11e079384b9317ee2215c4cdb8c370' },
      { index: 2, businessKeyDigest: '3f080ebf507efc660d81ad362812f435e15abe3c6b3c72996a6d37472f8e1c39', payloadDigest: '7ae7514e45e6bbcd55b0999a612ceb9aa4c39c7e82a55ee98f272acd41c258f8' },
      { index: 3, businessKeyDigest: '4f9077c90291a153831ff2d29f9494592627110371c99821696a4cb85d564523', payloadDigest: '37a0e09828a5a901e5caf3f09b84faf478b2e513f0a7eb4787c1352c7c0ec416' },
    ],
  },
}
async function goldenInputs() {
  const { createYidaProtocolExample, createYidaTransformExample } = await plannerPromise
  const template = JSON.parse(require('node:fs').readFileSync(path.join(__dirname,
    '../../../docs/development/takeover-beiliao-20260821/yida-legacy-templates/material.json'), 'utf8'))
  const example = createYidaProtocolExample()
  return {
    protocol: { config: example.config, rowsText: example.text, allocation: { mode: 'original' } },
    material: { config: { ...template.rules, target: { appType: 'synthetic_golden_app', formUuid: 'synthetic_golden_form' } },
      rowsText: createYidaTransformExample().text, allocation: { ...template.allocation, projects: ['DEMO-P1', 'DEMO-P2'] } },
  }
}

test('R-71 ⑦.3 B2: v2 literal goldens (protocol example, shipped material template) are byte-identical through both entries', async () => {
  const { compileYidaDraft, compileYidaSendDraft } = await modulePromise
  const inputs = await goldenInputs()
  for (const [name, golden] of Object.entries(V2_GOLDEN)) {
    for (const compile of [compileYidaDraft, compileYidaSendDraft]) {
      const result = compile(inputs[name])
      assert.deepEqual({ planDigest: result.planDigest, keyDefinitionDigest: result.keyDefinitionDigest,
        locatorDigest: result.locatorDigest, rowSpecs: result.rowSpecs }, golden, name)
    }
  }
})

test('R-71 ⑦.3 B2: a v3 plan digest is the v2 formula plus exactly one mapping: 3 marker; key definition and rows stay shared', async () => {
  const { compileYidaDraft, compileYidaSendDraft } = await modulePromise
  const lifted = config({ version: 3, businessKey: ['project', 'line', 'parent'], emptyKeyFields: ['parent'],
    fieldMap: config().fieldMap.map((entry) => ({ transform: 'direct', ...entry })) })
  for (const settings of [{ mode: 'original' }, allocation()]) {
    const v2 = compileYidaSendDraft(input([row(), row('LINE-2', 4)], config(), settings))
    const v3 = compileYidaSendDraft(input([row(), row('LINE-2', 4)], lifted, settings))
    const rows = v3.rowSpecs.map(({ businessKeyDigest, payloadDigest }) => ({ businessKeyDigest, payloadDigest }))
      .sort((left, right) => compareCodePoints(left.businessKeyDigest, right.businessKeyDigest))
    const formula = (marker) => digest({ version: 1, kind: 'yida-local-plan', locator: v3.locator,
      keyDefinition: v3.keyDefinition, intent: 'create', ...marker, rows })
    assert.equal(v3.planDigest, formula({ mapping: 3 }))
    assert.equal(v2.planDigest, formula({}))
    assert.notEqual(v3.planDigest, v2.planDigest)
    assert.equal(v3.keyDefinitionDigest, v2.keyDefinitionDigest)
    assert.deepEqual(v3.rowSpecs, v2.rowSpecs)
    // The initialization entry still refuses v3 (decision E1).
    expectError(compileYidaDraft, (await modulePromise).YidaDraftPlanError, input([row()], lifted, settings), 'YIDA_DRAFT_CONFIG')
  }
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

// The disabled transport reports DISABLED only after its input check passed.
async function transportVerdict(data, intent = 'create') {
  let fetched = 0
  const transport = createYidaFormTransport({ fetch: () => { fetched += 1; throw new Error('synthetic-offline') } })
  const error = await transport.send({ intent, data, accessToken: 'synthetic_access',
    systemToken: 'synthetic_system', userId: 'synthetic_user' }, { signal: new AbortController().signal })
    .then(() => null, (failure) => failure)
  assert.equal(fetched, 0)
  return error?.code
}

test('a planned row with no sendable field is refused before it can become an approvable draft', async () => {
  const { compileYidaDraft, YidaDraftPlanError } = await modulePromise
  const { buildYidaStaticPlan, validateYidaStaticConfig } = await plannerPromise
  const layout = config({ businessKey: ['parentCode'], emptyKeyFields: ['parentCode'],
    fieldCatalog: [{ id: 'parent', control: 'text', required: false }],
    fieldMap: [{ source: 'parentCode', target: 'parent', type: 'string', required: false }] })
  const normalized = validateYidaStaticConfig(layout).normalized
  // Real planner oracle: every key may be empty and every field optional, so an
  // all-empty row plans as a create whose payload has no key at all.
  for (const empty of [{}, { parentCode: null }, { parentCode: '' }]) {
    const planned = buildYidaStaticPlan({ config: normalized, rows: [empty] }).rows[0]
    assert.equal(planned.status, 'planned_create')
    assert.deepEqual(planned.payload, {})
    assert.equal(await transportVerdict(planned.protocolPreview.data), 'YIDA_FORM_INPUT')
    expectError(compileYidaDraft, YidaDraftPlanError, input([empty], layout), 'YIDA_DRAFT_PLAN')
    expectError(compileYidaDraft, YidaDraftPlanError, input([{ parentCode: 'P-1' }, empty], layout), 'YIDA_DRAFT_PLAN')
  }
  const sendable = compileYidaDraft(input([{ parentCode: 'P-1' }], layout))
  assert.deepEqual(sendable.plan.rows[0].payload, { parent: 'P-1' })
  assert.equal(await transportVerdict(sendable.plan.rows[0].protocolPreview.data), 'YIDA_FORM_DISABLED')
})

test('target IDs carrying a control character the transport refuses never compile into a draft', async () => {
  const { compileYidaDraft, YidaDraftPlanError } = await modulePromise
  for (const control of ['\u0000', '\u001b', '\u007f', '\u0080', '\u0085', '\u009f']) {
    for (const field of ['appType', 'formUuid']) {
      const target = { ...config().target, [field]: `synthetic${control}draft` }
      assert.equal(await transportVerdict({ ...target, formDataJson: '{"project":"P"}' }), 'YIDA_FORM_INPUT')
      expectError(compileYidaDraft, YidaDraftPlanError, input([row()], config({ target })), 'YIDA_DRAFT_CONFIG')
    }
  }
  // Surrounding whitespace is still normalized away and the sent value passes the transport.
  const padded = compileYidaDraft(input([row()], config({ target: { appType: '\tsynthetic_draft_app\n', formUuid: 'synthetic_draft_form' } })))
  assert.equal(padded.locator.appType, 'synthetic_draft_app')
  assert.equal(await transportVerdict(padded.plan.rows[0].protocolPreview.data), 'YIDA_FORM_DISABLED')
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

// ---- Source binding (design baseline v2.3 §3.3 / §7.2; D1 a′, D16): the two row digests ----
// Synthetic binding for the five-column v2 layout above: the sheet's key column is `fld_line` (idempotency key),
// bound to the `lineId` alias; records align with the rows of rowsText.
function binding(rows, patch = {}) {
  return {
    sheetId: 'sheet_synthetic', keyFieldId: 'fld_line',
    fieldBindings: { projectNo: 'fld_project', lineId: 'fld_line', parentCode: 'fld_parent', quantity: 'fld_qty', description: 'fld_desc' },
    records: rows.map((entry, index) => ({ recordId: `rec_${index + 1}`, keyValue: entry.lineId, projectNo: 'DEMO-P1' })),
    ...patch,
  }
}
// Independent oracle for the two digests (the baseline formulas), never the compiler's own helper.
function expectedBinding(bound, index, projectNo, fieldDependencies) {
  const record = bound.records[index]
  const sourceBinding = { sheetId: bound.sheetId, recordId: record.recordId, keyFieldId: bound.keyFieldId, keyValue: record.keyValue,
    projectNo, fieldBindings: bound.fieldBindings, fieldDependencies }
  return { sourceBinding,
    sourceRecordDigest: digest({ version: 1, kind: 'yida-source-record', ...sourceBinding }),
    creationIdentityDigest: digest({ version: 1, kind: 'yida-creation-identity', keyValue: record.keyValue, projectNo }) }
}
const V2_DEPENDENCIES = { project: ['fld_project'], line: ['fld_line'], parent: ['fld_parent'], qty: ['fld_qty'], description: ['fld_desc'] }

test('source binding: a bound row spec carries both digests, the per-row binding and dependencies by target; the plan digest covers them', async () => {
  const { compileYidaSendDraft, compileYidaDraft } = await modulePromise
  const rows = [row('LINE-1', 6), row('LINE-2', 3)]
  const bound = binding(rows)
  const unbound = compileYidaSendDraft(input(rows))
  const result = compileYidaSendDraft({ ...input(rows), sourceBinding: bound })
  assertFrozenTree(result)
  assert.deepEqual(result.source, { ...unbound.source, sourceBinding: bound })
  // Unbound specs stay byte-identical to the pre-binding shape: no binding keys at all.
  for (const spec of unbound.rowSpecs) assert.deepEqual(Object.keys(spec).sort(), ['businessKeyDigest', 'index', 'payloadDigest'])
  for (const [index, spec] of result.rowSpecs.entries()) {
    assert.deepEqual(Object.keys(spec).sort(), ['businessKeyDigest', 'creationIdentityDigest', 'index', 'payloadDigest', 'sourceBinding', 'sourceRecordDigest'])
    assert.equal(spec.businessKeyDigest, unbound.rowSpecs[index].businessKeyDigest)
    assert.equal(spec.payloadDigest, unbound.rowSpecs[index].payloadDigest)
    const expected = expectedBinding(bound, index, 'DEMO-P1', V2_DEPENDENCIES)
    assert.deepEqual(spec.sourceBinding, expected.sourceBinding)
    assert.equal(spec.sourceRecordDigest, expected.sourceRecordDigest)
    assert.equal(spec.creationIdentityDigest, expected.creationIdentityDigest)
    assert.match(spec.sourceRecordDigest, /^[0-9a-f]{64}$/); assert.match(spec.creationIdentityDigest, /^[0-9a-f]{64}$/)
  }
  // Both digests enter the plan digest (sorted row entries), so a bound draft is a different operation.
  assert.notEqual(result.planDigest, unbound.planDigest)
  assert.equal(result.planDigest, digest({ version: 1, kind: 'yida-local-plan', locator: result.locator, keyDefinition: result.keyDefinition,
    intent: 'create', rows: result.rowSpecs.map(({ businessKeyDigest, payloadDigest, sourceRecordDigest, creationIdentityDigest }) =>
      ({ businessKeyDigest, payloadDigest, sourceRecordDigest, creationIdentityDigest }))
      .sort((left, right) => compareCodePoints(left.businessKeyDigest, right.businessKeyDigest)) }))
  // The key definition, locator and business keys are binding-independent (the seven-key fence is unchanged).
  assert.equal(result.keyDefinitionDigest, unbound.keyDefinitionDigest)
  assert.equal(result.locatorDigest, unbound.locatorDigest)
  // The initialization entry accepts a binding too (same compiler), without changing the v2 layout rules.
  assert.equal(compileYidaDraft({ ...input(rows), sourceBinding: bound }).planDigest, result.planDigest)
})

test('source binding: the identity digest is stable across a draft rebuild and distinct per allocated project', async () => {
  const { compileYidaSendDraft } = await modulePromise
  const rows = [row('LINE-1', 6)]
  const bound = binding(rows)
  const first = compileYidaSendDraft({ ...input(rows), sourceBinding: bound })
  const again = compileYidaSendDraft({ ...input(rows), sourceBinding: bound })
  assert.deepEqual(again.rowSpecs, first.rowSpecs); assert.equal(again.planDigest, first.planDigest)
  // A rebuilt draft whose unrelated column changed: same identity, same source record, a new plan digest.
  const changed = [{ ...row('LINE-1', 6), description: 'synthetic corrected description' }]
  const rebuilt = compileYidaSendDraft({ ...input(changed), sourceBinding: binding(changed) })
  assert.equal(rebuilt.rowSpecs[0].creationIdentityDigest, first.rowSpecs[0].creationIdentityDigest)
  assert.equal(rebuilt.rowSpecs[0].sourceRecordDigest, first.rowSpecs[0].sourceRecordDigest)
  assert.notEqual(rebuilt.rowSpecs[0].payloadDigest, first.rowSpecs[0].payloadDigest)
  assert.notEqual(rebuilt.planDigest, first.planDigest)
  // The same key under a NEW physical record (deleted and re-created): same identity, another source record.
  const recreated = compileYidaSendDraft({ ...input(rows), sourceBinding: binding(rows, { records: [{ recordId: 'rec_new', keyValue: 'LINE-1', projectNo: 'DEMO-P1' }] }) })
  assert.equal(recreated.rowSpecs[0].creationIdentityDigest, first.rowSpecs[0].creationIdentityDigest)
  assert.notEqual(recreated.rowSpecs[0].sourceRecordDigest, first.rowSpecs[0].sourceRecordDigest)
  // Another sheet (moved registration): same identity again, another source record.
  const moved = compileYidaSendDraft({ ...input(rows), sourceBinding: binding(rows, { sheetId: 'sheet_other' }) })
  assert.equal(moved.rowSpecs[0].creationIdentityDigest, first.rowSpecs[0].creationIdentityDigest)
  assert.notEqual(moved.rowSpecs[0].sourceRecordDigest, first.rowSpecs[0].sourceRecordDigest)
  // A different key value or project is another identity.
  const otherKey = compileYidaSendDraft({ ...input([row('LINE-9', 6)]), sourceBinding: binding([row('LINE-9', 6)]) })
  assert.notEqual(otherKey.rowSpecs[0].creationIdentityDigest, first.rowSpecs[0].creationIdentityDigest)
  // Allocation: every expanded row of one source record carries its allocated project; identities differ per project,
  // the record is shared, and the project column of the expanded row is the project of its identity.
  const split = compileYidaSendDraft({ ...input(rows, config(), allocation('equal_integer', ['DEMO-P1', 'DEMO-P2'])), sourceBinding: bound })
  assert.equal(split.rowSpecs.length, 2)
  assert.deepEqual(split.rowSpecs.map(spec => spec.sourceBinding.projectNo), ['DEMO-P1', 'DEMO-P2'])
  assert.deepEqual(split.rowSpecs.map(spec => spec.sourceBinding.recordId), ['rec_1', 'rec_1'])
  assert.notEqual(split.rowSpecs[0].creationIdentityDigest, split.rowSpecs[1].creationIdentityDigest)
  assert.equal(split.rowSpecs[0].creationIdentityDigest, first.rowSpecs[0].creationIdentityDigest)
  for (const [index, spec] of split.rowSpecs.entries()) {
    assert.equal(split.plan.rows[index].payload.project, spec.sourceBinding.projectNo)
    const expected = expectedBinding(bound, 0, spec.sourceBinding.projectNo, V2_DEPENDENCIES)
    assert.equal(spec.sourceRecordDigest, expected.sourceRecordDigest); assert.equal(spec.creationIdentityDigest, expected.creationIdentityDigest)
  }
})

test('source binding: v3 dependencies follow the transform (copy primary, concat parts, no constant) through the alias map', async () => {
  const { compileYidaSendDraft } = await modulePromise
  const { createYidaTransformExample, transformDependencies } = await plannerPromise
  const example = createYidaTransformExample()
  const rows = JSON.parse(example.text)
  const columns = [...new Set(example.config.fieldMap.flatMap(entry => transformDependencies(entry, example.config)))]
  const fieldBindings = Object.fromEntries(columns.map(column => [column, 'fld_' + column]))
  const keySource = example.config.fieldMap.find(entry => entry.transform === 'direct' && entry.target === 'sourceLineId')?.source
    ?? example.config.fieldMap.find(entry => entry.transform === 'direct').source
  const bound = { sheetId: 'sheet_v3', keyFieldId: fieldBindings[keySource], fieldBindings,
    records: rows.map((entry, index) => ({ recordId: `rec_${index}`, keyValue: String(entry[keySource]), projectNo: 'DEMO-P1' })) }
  const result = compileYidaSendDraft({ config: example.config, rowsText: example.text, allocation: { ...example.allocation, projects: ['DEMO-P1'] }, sourceBinding: bound })
  const dependencies = result.rowSpecs[0].sourceBinding.fieldDependencies
  for (const entry of example.config.fieldMap) {
    const expected = transformDependencies(entry, example.config).map(column => fieldBindings[column]).sort()
    if (expected.length === 0) assert.equal(Object.hasOwn(dependencies, entry.target), false, entry.target)
    else assert.deepEqual(dependencies[entry.target], expected, entry.target)
  }
  const copy = example.config.fieldMap.find(entry => entry.transform === 'copy')
  const primary = example.config.fieldMap.find(entry => entry.transform === 'direct' && entry.target === copy.copyOf)
  assert.deepEqual(dependencies[copy.target], ['fld_' + primary.source])
  const concat = example.config.fieldMap.find(entry => entry.transform === 'concat')
  assert.deepEqual(dependencies[concat.target], concat.parts.filter(part => part.source).map(part => 'fld_' + part.source).sort())
  assert.equal(example.config.fieldMap.some(entry => entry.transform === 'constant'), true)
})

test('source binding: a malformed, misaligned or smuggled binding is a fixed INPUT refusal with no plan', async () => {
  const { compileYidaSendDraft, YidaDraftPlanError } = await modulePromise
  const rows = [row('LINE-1', 6), row('LINE-2', 3)]
  const reject = (patch) => expectError(compileYidaSendDraft, YidaDraftPlanError, { ...input(rows), sourceBinding: binding(rows, patch) }, 'YIDA_DRAFT_INPUT')
  // The key the server read must be what the planner sees in that row's key column.
  reject({ records: [{ recordId: 'rec_1', keyValue: 'LINE-OTHER', projectNo: 'DEMO-P1' }, { recordId: 'rec_2', keyValue: 'LINE-2', projectNo: 'DEMO-P1' }] })
  // One record per source row, distinct record ids.
  reject({ records: [{ recordId: 'rec_1', keyValue: 'LINE-1', projectNo: 'DEMO-P1' }] })
  reject({ records: [{ recordId: 'rec_1', keyValue: 'LINE-1', projectNo: 'DEMO-P1' }, { recordId: 'rec_1', keyValue: 'LINE-2', projectNo: 'DEMO-P1' }] })
  // One sheet is one registered project (087 maps a sheet to exactly one project_no): records naming two projects
  // under one sheetId are not a binding the sheet source can produce, in either allocation mode.
  reject({ records: [{ recordId: 'rec_1', keyValue: 'LINE-1', projectNo: 'DEMO-P1' }, { recordId: 'rec_2', keyValue: 'LINE-2', projectNo: 'DEMO-P2' }] })
  const divisible = [row('LINE-1', 6), row('LINE-2', 4)]
  expectError(compileYidaSendDraft, YidaDraftPlanError, { ...input(divisible, config(), allocation('equal_integer', ['DEMO-P1', 'DEMO-P2'])),
    sourceBinding: binding(divisible, { records: [{ recordId: 'rec_1', keyValue: 'LINE-1', projectNo: 'DEMO-P1' }, { recordId: 'rec_2', keyValue: 'LINE-2', projectNo: 'DEMO-P2' }] }) }, 'YIDA_DRAFT_INPUT')
  // The same split with one project per binding is a valid draft (the refusal above is the mixed projects, not the split).
  assert.equal(compileYidaSendDraft({ ...input(divisible, config(), allocation('equal_integer', ['DEMO-P1', 'DEMO-P2'])), sourceBinding: binding(divisible) }).rowSpecs.length, 4)
  // The key column must be one of the bound columns; aliases are planner identifiers; ids are opaque text.
  reject({ keyFieldId: 'fld_unbound' })
  reject({ fieldBindings: { 'bad alias': 'fld_x', lineId: 'fld_line' } })
  reject({ fieldBindings: { projectNo: 'fld_line', lineId: 'fld_line' } })
  reject({ sheetId: ' sheet ' })
  for (const extra of [{ extra: true }, { sheetId: undefined }]) {
    expectError(compileYidaSendDraft, YidaDraftPlanError, { ...input(rows), sourceBinding: { ...binding(rows), ...extra } }, 'YIDA_DRAFT_INPUT')
  }
  expectError(compileYidaSendDraft, YidaDraftPlanError, { ...input(rows), sourceBinding: null }, 'YIDA_DRAFT_INPUT')
  expectError(compileYidaSendDraft, YidaDraftPlanError, { ...input(rows), sourceBinding: binding(rows), extra: 1 }, 'YIDA_DRAFT_INPUT')
})

// ---- R-71 ⑦.4 PR-2 (Y6): the `generated` transform in the persisted compile (owner addendum 2026-11-06 decision 1) ----
// Independent oracle for the material code: node:crypto SHA-1 with the RFC 4122 UUIDv5 bit layout and the frozen
// name layout of material-code-v1 (never the leaf or the planner).
function oracleMaterialCode(keyValue, projectNo) {
  const digest = createHash('sha1').update(Buffer.from('6d37f698e75c4b5e8eefb702478a1cfb', 'hex'))
    .update(Buffer.from(JSON.stringify(['metasheet.stock-prep.yida-material-code', 'v1', keyValue, projectNo]), 'utf8')).digest().subarray(0, 16)
  digest[6] = (digest[6] & 0x0f) | 0x50
  digest[8] = (digest[8] & 0x3f) | 0x80
  const h = digest.toString('hex')
  return `WLBH-${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`.toUpperCase()
}
const compilerPromise = import(pathToFileURL(path.join(__dirname, '../lib/yida-draft-compiler.mjs')).href)
// The shipped v3 example (one preset part on materialCodeText, rowIdOf the idempotency key sourceLineId, projectOf
// project), bound the way the sheet source binds a registered project sheet: the key column is idempotencyKey.
async function generatedInput({ allocation: settings = { mode: 'original' }, rows: patchRows, config: patchConfig, projectNo = 'DEMO-P1' } = {}) {
  const { createYidaTransformExample, transformDependencies } = await plannerPromise
  const example = createYidaTransformExample()
  const layout = patchConfig ? patchConfig(structuredClone(example.config)) : example.config
  const rows = patchRows ? patchRows(structuredClone(example.rows)) : example.rows
  const columns = [...new Set(layout.fieldMap.flatMap((entry) => transformDependencies(entry, layout)))]
  const fieldBindings = Object.fromEntries(columns.map((column) => [column, 'fld_' + column]))
  const unbound = { config: layout, rowsText: JSON.stringify(rows), allocation: settings }
  const sourceBinding = { sheetId: 'sheet_generated', keyFieldId: 'fld_idempotencyKey', fieldBindings,
    records: rows.map((entry, index) => ({ recordId: `rec_g${index}`, keyValue: entry.idempotencyKey, projectNo })) }
  return { unbound, bound: { ...unbound, sourceBinding }, rows }
}
const codesOf = (compiled) => compiled.plan.rows.map((planned) => planned.payload.materialCodeText)

test('generated (SOURCE_UNBOUND): the persisted send entry refuses a generated entry on unbound rows whatever the template; local and bound compile', async () => {
  const { compileYidaSendDraft, compileYidaDraft, YidaDraftPlanError } = await modulePromise
  const { compileYidaLocalDraft } = await compilerPromise
  const hashOnly = (layout) => {
    layout.fieldMap.at(-1).template = [{ literal: 'SYN-' }, { hash: [...layout.businessKey], form: 'uuid-32' }, { literal: '-' }, { field: 'versionNo' }]
    return layout
  }
  for (const patchConfig of [undefined, hashOnly]) {
    const { unbound, bound } = await generatedInput({ config: patchConfig })
    expectError(compileYidaSendDraft, YidaDraftPlanError, unbound, 'YIDA_DRAFT_PLAN')
    // The never-persisted local recompute needs no binding (browser preview parity), and a bound draft compiles.
    const local = compileYidaLocalDraft(unbound), sent = compileYidaSendDraft(bound)
    assert.equal(local.plan.rows.length, 2); assert.equal(sent.plan.rows.length, 2)
    assert.deepEqual(codesOf(sent), codesOf(local))
    // The initialization entry stays v2 only.
    expectError(compileYidaDraft, YidaDraftPlanError, bound, 'YIDA_DRAFT_CONFIG')
  }
  // The same unbound rows without the generated entry are an ordinary (unbound) v3 send draft.
  const { unbound } = await generatedInput({ config: (layout) => {
    layout.fieldMap = layout.fieldMap.filter((entry) => entry.transform !== 'generated')
    layout.fieldCatalog = layout.fieldCatalog.filter((item) => item.id !== 'materialCodeText')
    return layout
  } })
  const plain = compileYidaSendDraft(unbound)
  for (const spec of plain.rowSpecs) assert.deepEqual(Object.keys(spec).sort(), ['businessKeyDigest', 'index', 'payloadDigest'])
})

test('generated: a bound row whose preset project cell is not the project of its identity is refused (original mode); a split holds by construction', async () => {
  const { compileYidaSendDraft, YidaDraftPlanError } = await modulePromise
  // Original mode: the binding names the registry project DEMO-P1 and every row's project cell says DEMO-P1.
  const same = await generatedInput()
  const compiled = compileYidaSendDraft(same.bound)
  for (const [index, spec] of compiled.rowSpecs.entries()) {
    assert.equal(spec.sourceBinding.projectNo, 'DEMO-P1')
    assert.equal(compiled.plan.rows[index].payload.materialCodeText, oracleMaterialCode(same.rows[index].idempotencyKey, 'DEMO-P1'))
  }
  // A row whose project cell differs from its binding (cell not re-pulled, plugin-SDK or SQL write): the code would be
  // minted for another project than the row's creation identity, so the whole draft is refused (row problem
  // SOURCE_PROJECT_MISMATCH → PLAN). Verbatim comparison: no case folding.
  for (const cell of ['DEMO-P2', 'demo-p1']) {
    const other = await generatedInput({ rows: (rows) => rows.map((entry, index) => index === 1 ? { ...entry, projectNo: cell } : entry) })
    expectError(compileYidaSendDraft, YidaDraftPlanError, other.bound, 'YIDA_DRAFT_PLAN')
    // The same rows compile unbound locally (the preview has no identity to compare with).
    const { compileYidaLocalDraft } = await compilerPromise
    assert.equal(compileYidaLocalDraft(other.unbound).plan.rows.length, 2)
  }
  // The binding naming another project than all cells: refused as well.
  expectError(compileYidaSendDraft, YidaDraftPlanError, (await generatedInput({ projectNo: 'DEMO-P9' })).bound, 'YIDA_DRAFT_PLAN')
  // Without a generated entry the same mismatch is not this row problem (Y4 pins the per-binding project rule).
  const noCode = await generatedInput({ projectNo: 'DEMO-P9', config: (layout) => {
    layout.fieldMap = layout.fieldMap.filter((entry) => entry.transform !== 'generated')
    layout.fieldCatalog = layout.fieldCatalog.filter((item) => item.id !== 'materialCodeText')
    return layout
  } })
  assert.equal(compileYidaSendDraft(noCode.bound).rowSpecs.every((spec) => spec.sourceBinding.projectNo === 'DEMO-P9'), true)
  // Split: every expanded row's project cell is its allocated project, which is also its identity project.
  const split = await generatedInput({ allocation: { mode: 'equal_integer', projects: ['DEMO-P1', 'DEMO-P2'], projectField: 'projectNo', quantityField: 'totalQuantity' } })
  const allocated = compileYidaSendDraft(split.bound)
  assert.equal(allocated.rowSpecs.length, 4)
  for (const [index, spec] of allocated.rowSpecs.entries()) {
    const payload = allocated.plan.rows[index].payload
    assert.equal(payload.project, spec.sourceBinding.projectNo)
    assert.equal(payload.materialCodeText, oracleMaterialCode(spec.sourceBinding.keyValue, spec.sourceBinding.projectNo))
  }
  assert.deepEqual(allocated.rowSpecs.map((spec) => spec.sourceBinding.projectNo).sort(), ['DEMO-P1', 'DEMO-P1', 'DEMO-P2', 'DEMO-P2'])
})

test('generated: a bound row whose preset rowIdOf cell is not the key value of its identity is refused (one code, two identities)', async () => {
  const { compileYidaSendDraft, YidaDraftPlanError } = await modulePromise
  const { compileYidaLocalDraft } = await compilerPromise
  // A valid planner config (rowIdOf only has to be a string direct target): the preset reads the drawing number,
  // not the key column idempotencyKey the binding names.
  const offKey = (layout) => {
    layout.fieldMap.at(-1).template = [{ preset: 'material-code-v1', rowIdOf: 'drawingNo', projectOf: 'project' }]
    return layout
  }
  // One component (DEMO-DRW-1) under two parents: two source lines, two creation identities, one drawing number.
  const lineOf = (key, parent) => (rows) => [{ ...rows[0], idempotencyKey: key, parentComponentCode: parent }]
  const drafts = [await generatedInput({ config: offKey, rows: lineOf('SYN-LINE-1', null) }),
    await generatedInput({ config: offKey, rows: lineOf('SYN-LINE-5', 'DEMO-DRW-9') })]
  // Locally both compile to the SAME code with different seven keys, so neither fence would refuse the second draft.
  const locals = drafts.map((draft) => compileYidaLocalDraft(draft.unbound))
  assert.equal(codesOf(locals[0])[0], oracleMaterialCode('DEMO-DRW-1', 'DEMO-P1'))
  assert.equal(codesOf(locals[1])[0], codesOf(locals[0])[0])
  assert.notEqual(locals[1].rowSpecs[0].businessKeyDigest, locals[0].rowSpecs[0].businessKeyDigest)
  // The persisted compile refuses both bound drafts (row problem SOURCE_KEY_MISMATCH → PLAN), before any fence.
  for (const draft of drafts) expectError(compileYidaSendDraft, YidaDraftPlanError, draft.bound, 'YIDA_DRAFT_PLAN')
  // The default template (rowIdOf = the key column) still compiles bound, and its code is WLBH(identity).
  const keyed = await generatedInput({ rows: lineOf('SYN-LINE-5', 'DEMO-DRW-9') })
  const compiled = compileYidaSendDraft(keyed.bound)
  assert.equal(codesOf(compiled)[0], oracleMaterialCode(compiled.rowSpecs[0].sourceBinding.keyValue, compiled.rowSpecs[0].sourceBinding.projectNo))
  // The rule is on values: an off-key column holding exactly the key value mints WLBH(identity) and is accepted.
  const equalCell = await generatedInput({ config: offKey, rows: (rows) => [{ ...rows[0], componentCode: rows[0].idempotencyKey }] })
  const accepted = compileYidaSendDraft(equalCell.bound)
  assert.equal(codesOf(accepted)[0], oracleMaterialCode(accepted.rowSpecs[0].sourceBinding.keyValue, 'DEMO-P1'))
  // Verifier r2 M1: the hook covers every planned row, every preset of every generated entry, and compares verbatim.
  // (K5) Two bound rows: row 0's off-key cell equals its key value, only row 1's does not → the draft is refused.
  const rowTwoOff = await generatedInput({ config: offKey, rows: (rows) => [{ ...rows[0], componentCode: rows[0].idempotencyKey }, { ...rows[1] }] })
  expectError(compileYidaSendDraft, YidaDraftPlanError, rowTwoOff.bound, 'YIDA_DRAFT_PLAN')
  const rowTwoOn = await generatedInput({ config: offKey, rows: (rows) => rows.map((entry) => ({ ...entry, componentCode: entry.idempotencyKey })) })
  assert.equal(compileYidaSendDraft(rowTwoOn.bound).rowSpecs.length, 2)
  // (K3) Two generated entries: the first is the default (key column), the SECOND one's preset reads the drawing number.
  const secondEntry = (rowIdOf) => (layout) => {
    layout.fieldCatalog.push({ id: 'secondCodeText', control: 'text', required: false })
    layout.fieldMap.push({ transform: 'generated', template: [{ literal: 'B-' }, { preset: 'material-code-v1', rowIdOf, projectOf: 'project' }],
      target: 'secondCodeText', type: 'string', required: false })
    return layout
  }
  const secondOff = await generatedInput({ config: secondEntry('drawingNo'), rows: (rows) => [rows[0]] })
  expectError(compileYidaSendDraft, YidaDraftPlanError, secondOff.bound, 'YIDA_DRAFT_PLAN')
  const secondOn = compileYidaSendDraft((await generatedInput({ config: secondEntry('sourceLineId'), rows: (rows) => [rows[0]] })).bound)
  assert.equal(secondOn.plan.rows[0].payload.secondCodeText, 'B-' + oracleMaterialCode('SYN-LINE-1', 'DEMO-P1'))
  // (K4) An off-key cell that differs from the key value only by case is another value: refused.
  const caseOnly = await generatedInput({ config: offKey, rows: (rows) => [{ ...rows[0], componentCode: rows[0].idempotencyKey.toLowerCase() }] })
  assert.notEqual(caseOnly.rows[0].componentCode, caseOnly.rows[0].idempotencyKey)
  expectError(compileYidaSendDraft, YidaDraftPlanError, caseOnly.bound, 'YIDA_DRAFT_PLAN')
  // Split: every expanded row keeps the record's key value, so an off-key preset is refused there as well.
  expectError(compileYidaSendDraft, YidaDraftPlanError, (await generatedInput({ config: offKey,
    allocation: { mode: 'equal_integer', projects: ['DEMO-P1', 'DEMO-P2'], projectField: 'projectNo', quantityField: 'totalQuantity' } })).bound, 'YIDA_DRAFT_PLAN')
})

test('generated: fieldDependencies of a bound row name the field ids a generated target reads (preset inputs, hash members, field parts)', async () => {
  const { compileYidaSendDraft } = await modulePromise
  const preset = compileYidaSendDraft((await generatedInput()).bound)
  for (const spec of preset.rowSpecs) assert.deepEqual(spec.sourceBinding.fieldDependencies.materialCodeText, ['fld_idempotencyKey', 'fld_projectNo'])
  const template = await generatedInput({ config: (layout) => {
    layout.fieldMap.at(-1).template = [{ field: 'materialGrade' }, { literal: '/' }, { hash: [...layout.businessKey], form: 'uuid-36' }]
    return layout
  } })
  const hashed = compileYidaSendDraft(template.bound)
  for (const spec of hashed.rowSpecs) {
    assert.deepEqual(spec.sourceBinding.fieldDependencies.materialCodeText, ['fld_componentCode', 'fld_componentName', 'fld_componentSpec',
      'fld_material', 'fld_parentComponentCode', 'fld_projectNo', 'fld_sourceVersion'])
  }
  // The dependencies enter the source record digest: a template reading other columns is another source record.
  assert.notEqual(hashed.rowSpecs[0].sourceRecordDigest, preset.rowSpecs[0].sourceRecordDigest)
  assert.equal(hashed.rowSpecs[0].creationIdentityDigest, preset.rowSpecs[0].creationIdentityDigest)
  // A field part on a non-key column (verifier r2 L2, mutant V5c): the generated target's own sealed list names it.
  const decorated = compileYidaSendDraft((await generatedInput({ config: (layout) => {
    layout.fieldMap.at(-1).template = [{ preset: 'material-code-v1', rowIdOf: 'sourceLineId', projectOf: 'project' }, { literal: '/' }, { field: 'versionNo' }]
    return layout
  }, rows: (rows) => [rows[0]] })).bound)
  assert.deepEqual(decorated.rowSpecs[0].sourceBinding.fieldDependencies.materialCodeText, ['fld_idempotencyKey', 'fld_projectNo', 'fld_sourceVersion'])
})

test('generated (persisted entry): two bound rows with one generated value are refused as DUPLICATE_GENERATED_VALUE before any draft exists', async () => {
  const { compileYidaSendDraft, YidaDraftPlanError } = await modulePromise
  const { buildYidaStaticPlan, parseYidaStaticRows } = await plannerPromise
  // Verifier r2 L4: one key value (so one preset code), other seven keys (so no duplicate business key). Each row alone
  // compiles bound; together the batch pass marks both rows and the persisted compile refuses the draft.
  const twin = await generatedInput({ rows: (rows) => [rows[0], { ...rows[0], componentCode: 'DEMO-DRW-7' }] })
  const plan = buildYidaStaticPlan({ config: twin.unbound.config, rows: parseYidaStaticRows(twin.unbound.rowsText, twin.unbound.config) })
  assert.deepEqual(plan.rows.map((planned) => planned.issues.map((issue) => issue.code)), [['DUPLICATE_GENERATED_VALUE'], ['DUPLICATE_GENERATED_VALUE']])
  assert.equal(plan.evidence.duplicateKeyCount, 0)
  expectError(compileYidaSendDraft, YidaDraftPlanError, twin.bound, 'YIDA_DRAFT_PLAN')
  for (const index of [0, 1]) {
    const single = await generatedInput({ rows: (rows) => [index === 0 ? rows[0] : { ...rows[0], componentCode: 'DEMO-DRW-7' }] })
    assert.equal(codesOf(compileYidaSendDraft(single.bound))[0], oracleMaterialCode('SYN-LINE-1', 'DEMO-P1'))
  }
})

test('generated SR1: a rebuilt bound draft keeps the code bytes and the source record; an unrelated constant changes only payload and plan digests', async () => {
  const { compileYidaSendDraft } = await modulePromise
  const { compileYidaLocalDraft } = await compilerPromise
  const { buildYidaStaticPlan, parseYidaStaticRows } = await plannerPromise
  const input = await generatedInput()
  const first = compileYidaSendDraft(input.bound), again = compileYidaSendDraft(structuredClone(input.bound))
  assert.deepEqual(again.rowSpecs, first.rowSpecs); assert.equal(again.planDigest, first.planDigest)
  assert.deepEqual(codesOf(again), codesOf(first))
  assert.deepEqual(codesOf(first), input.rows.map((entry) => oracleMaterialCode(entry.idempotencyKey, 'DEMO-P1')))
  // Third draft: one unrelated constant changed (not a key, not a template input).
  const changed = await generatedInput({ config: (layout) => {
    layout.fieldMap.find((entry) => entry.target === 'defaultText').value = 'SYN-DEFAULT-CHANGED'
    return layout
  } })
  const third = compileYidaSendDraft(changed.bound)
  assert.deepEqual(codesOf(third), codesOf(first))
  for (const [index, spec] of third.rowSpecs.entries()) {
    assert.equal(spec.sourceRecordDigest, first.rowSpecs[index].sourceRecordDigest)
    assert.equal(spec.creationIdentityDigest, first.rowSpecs[index].creationIdentityDigest)
    assert.equal(spec.businessKeyDigest, first.rowSpecs[index].businessKeyDigest)
    assert.notEqual(spec.payloadDigest, first.rowSpecs[index].payloadDigest)
  }
  assert.notEqual(third.planDigest, first.planDigest)
  // Parity: the browser sequence (parse, plan) and a one-row re-plan of each row (what the send selection does) give the
  // same code as the persisted bound compile and the unbound local recompute: the binding never feeds the code.
  const browser = buildYidaStaticPlan({ config: input.unbound.config, rows: parseYidaStaticRows(input.unbound.rowsText, input.unbound.config) })
  assert.deepEqual(browser.rows.map((planned) => planned.payload.materialCodeText), codesOf(first))
  assert.deepEqual(codesOf(compileYidaLocalDraft(input.unbound)), codesOf(first))
  for (const [index, entry] of input.rows.entries()) {
    assert.equal(buildYidaStaticPlan({ config: input.unbound.config, rows: [entry] }).rows[0].payload.materialCodeText, codesOf(first)[index])
  }
  // ⑦.3 point 6 with generated: any fieldMap permutation is the same bound draft (same plan digest and row specs).
  const permuted = await generatedInput({ config: (layout) => { layout.fieldMap.reverse(); return layout } })
  const reordered = compileYidaSendDraft(permuted.bound)
  assert.equal(reordered.planDigest, first.planDigest)
  assert.deepEqual(reordered.rowSpecs, first.rowSpecs)
})

// ---- YD (owner 2026-11-07, R-88: an open question gets a configurable default; the default is today's behaviour) ----
// Pre-change goldens, captured on b6dc5f4d2 + main merge d59a15525 before the options existed (local, never-persisted
// compile of the v3 example split two ways with decimal quantities 0.5 / 1.25).
const YD_V3_DECIMAL_GOLDEN = {
  planDigest: 'b167c893df12da6f944c534944e8bcb43bb60002955023617b576d30af8d950a',
  keyDefinitionDigest: 'd320bf2a69eeff33b75ad11af51a50f8000d62d2dc0965bf16d35ef283a96f26',
}
async function ydDecimalInput(patch = {}) {
  const { createYidaTransformExample } = await plannerPromise
  const example = createYidaTransformExample()
  const rows = example.rows.map((entry, index) => ({ ...entry, totalQuantity: index === 0 ? 0.5 : 1.25 }))
  return { config: example.config, rowsText: JSON.stringify(rows),
    allocation: { mode: 'equal_decimal_exact', projectField: 'projectNo', quantityField: 'totalQuantity', projects: ['DEMO-P1', 'DEMO-P2'], ...patch } }
}

test('Q4 plan digest: absent and explicit exact are the pre-change digest; legacy-1dp is its own digest even when every share is exact', async () => {
  const { compileYidaDraft, compileYidaSendDraft, YidaDraftPlanError } = await modulePromise
  const { compileYidaLocalDraft } = await compilerPromise
  for (const patch of [{}, { quantityRounding: 'exact' }]) {
    const compiled = compileYidaLocalDraft(await ydDecimalInput(patch))
    assert.equal(compiled.planDigest, YD_V3_DECIMAL_GOLDEN.planDigest)
    assert.equal(compiled.keyDefinitionDigest, YD_V3_DECIMAL_GOLDEN.keyDefinitionDigest)
  }
  // The literal v2 material golden through both persisted entries with an explicit 'exact'.
  const { material } = await goldenInputs()
  const explicit = { ...material, allocation: { ...material.allocation, quantityRounding: 'exact' } }
  for (const compile of [compileYidaDraft, compileYidaSendDraft]) {
    const compiled = compile(explicit)
    assert.equal(compiled.planDigest, V2_GOLDEN.material.planDigest)
    assert.equal(compiled.keyDefinitionDigest, V2_GOLDEN.material.keyDefinitionDigest)
  }
  // 4 / 2 and 6 / 2: the legacy shares equal the exact ones, the rows are the same bytes, the plan digest is not.
  const decimal = { ...material, allocation: { ...material.allocation, mode: 'equal_decimal_exact' } }
  const exact = compileYidaSendDraft(decimal)
  const legacy = compileYidaSendDraft({ ...decimal, allocation: { ...decimal.allocation, quantityRounding: 'legacy-1dp' } })
  assert.deepEqual(legacy.plan, exact.plan)
  assert.deepEqual(legacy.rowSpecs, exact.rowSpecs)
  assert.notEqual(legacy.planDigest, exact.planDigest)
  assert.equal(legacy.keyDefinitionDigest, exact.keyDefinitionDigest)
  // A legacy share that is not exact changes the rows (and the plan digest) too.
  const rounded = compileYidaLocalDraft(await ydDecimalInput({ quantityRounding: 'legacy-1dp' }))
  assert.deepEqual(rounded.plan.rows.map((row) => row.payload.totalQty), [0.3, 0.3, 0.6, 0.6])
  assert.notEqual(rounded.planDigest, YD_V3_DECIMAL_GOLDEN.planDigest)
  // The compiler's closed allocation shape: the optional key, never on original, never another key.
  expectError(compileYidaSendDraft, YidaDraftPlanError, { ...material, allocation: { mode: 'original', quantityRounding: 'exact' } }, 'YIDA_DRAFT_INPUT')
  expectError(compileYidaSendDraft, YidaDraftPlanError, { ...decimal, allocation: { ...decimal.allocation, quantityRounding: 'legacy-1dp', note: 'x' } }, 'YIDA_DRAFT_INPUT')
  // The allocation module owns the values: legacy-1dp on an integer split is refused (PLAN).
  expectError(compileYidaSendDraft, YidaDraftPlanError, { ...material, allocation: { ...material.allocation, quantityRounding: 'legacy-1dp' } }, 'YIDA_DRAFT_PLAN')
})

// D2: the material-code form. 'uuid-36' (default) is Y2's code byte for byte; 'uuid-32' drops the UUID's hyphens after
// the WLBH- prefix. The form is part of the key definition only when 'uuid-32', so it is sealed with the slot.
const uuid32 = (code) => 'WLBH-' + code.slice(5).replaceAll('-', '')
const presetForm = (form) => (layout) => {
  layout.fieldMap.find((entry) => entry.transform === 'generated').template[0].form = form
  return layout
}
const rootForm = (form, inner = (layout) => layout) => (layout) => ({ ...inner(layout), materialCodeForm: form })

test('D2 default: absent, root uuid-36, preset uuid-36 or both compile byte-identically, the 41-character Y2 code and the golden key definition', async () => {
  const { compileYidaSendDraft } = await modulePromise
  const { compileYidaLocalDraft } = await compilerPromise
  const base = await generatedInput()
  const absent = compileYidaSendDraft(base.bound)
  assert.equal(absent.keyDefinitionDigest, V2_GOLDEN.material.keyDefinitionDigest)
  assert.deepEqual(Object.keys(absent.keyDefinition).sort(), ['algorithm', 'fields'])
  assert.equal(Object.hasOwn(absent.source.config, 'materialCodeForm'), false)
  for (const [index, code] of codesOf(absent).entries()) {
    assert.equal(code, oracleMaterialCode(base.rows[index].idempotencyKey, 'DEMO-P1'))
    assert.equal(code.length, 41)
  }
  for (const patch of [rootForm('uuid-36'), presetForm('uuid-36'), rootForm('uuid-36', presetForm('uuid-36'))]) {
    const declared = compileYidaSendDraft((await generatedInput({ config: patch })).bound)
    assert.equal(declared.planDigest, absent.planDigest)
    assert.equal(declared.keyDefinitionDigest, absent.keyDefinitionDigest)
    assert.deepEqual(declared.plan, absent.plan)
    assert.deepEqual(declared.rowSpecs, absent.rowSpecs)
    assert.equal(declared.source.config.materialCodeForm, 'uuid-36')
  }
  // The split local compile keeps its pre-change digest too.
  assert.equal(compileYidaLocalDraft(await ydDecimalInput()).keyDefinitionDigest, YD_V3_DECIMAL_GOLDEN.keyDefinitionDigest)
})

test('D2 uuid-32: the 37-character code is the Y2 code without the UUID hyphens, from the root, the preset or both; the form is in the key definition', async () => {
  const { compileYidaSendDraft } = await modulePromise
  const base = await generatedInput()
  const defaults = compileYidaSendDraft(base.bound)
  const results = []
  for (const patch of [presetForm('uuid-32'), rootForm('uuid-32'), rootForm('uuid-32', presetForm('uuid-32'))]) {
    const compiled = compileYidaSendDraft((await generatedInput({ config: patch })).bound)
    for (const [index, code] of codesOf(compiled).entries()) {
      assert.equal(code, uuid32(oracleMaterialCode(base.rows[index].idempotencyKey, 'DEMO-P1')))
      assert.match(code, /^WLBH-[0-9A-F]{32}$/)
      assert.equal(code.length, 37)
    }
    assert.deepEqual(compiled.keyDefinition, { ...defaults.keyDefinition, materialCodeForm: 'uuid-32' })
    assert.notEqual(compiled.keyDefinitionDigest, defaults.keyDefinitionDigest)
    assert.notEqual(compiled.planDigest, defaults.planDigest)
    assert.equal(compiled.source.config.materialCodeForm, 'uuid-32')
    results.push(compiled)
  }
  // Wherever it is declared, one form gives one draft: same plan, same digests.
  for (const other of results.slice(1)) {
    assert.equal(other.planDigest, results[0].planDigest)
    assert.equal(other.keyDefinitionDigest, results[0].keyDefinitionDigest)
  }
  // A split gets one code per split row in the chosen form as well.
  const split = compileYidaSendDraft((await generatedInput({ config: presetForm('uuid-32'),
    allocation: { mode: 'equal_integer', projectField: 'projectNo', quantityField: 'totalQuantity', projects: ['DEMO-P1', 'DEMO-P2'] } })).bound)
  assert.equal(codesOf(split).length, 4)
  assert.equal(new Set(codesOf(split)).size, 4)
  for (const code of codesOf(split)) assert.match(code, /^WLBH-[0-9A-F]{32}$/)
})

test('D2 initialization seal: a v2 initialization draft declares uuid-32 at the root and gets exactly the key definition a v3 uuid-32 draft has', async () => {
  const { compileYidaDraft, compileYidaSendDraft, YidaDraftPlanError } = await modulePromise
  const { material } = await goldenInputs()
  // Default and explicit uuid-36: the literal v2 goldens are unchanged (an L4-sealed slot keeps its digests).
  for (const config of [material.config, { ...material.config, materialCodeForm: 'uuid-36' }]) {
    const compiled = compileYidaDraft({ ...material, config })
    assert.equal(compiled.planDigest, V2_GOLDEN.material.planDigest)
    assert.equal(compiled.keyDefinitionDigest, V2_GOLDEN.material.keyDefinitionDigest)
  }
  const sealed = compileYidaDraft({ ...material, config: { ...material.config, materialCodeForm: 'uuid-32' } })
  const v3 = compileYidaSendDraft((await generatedInput({ config: presetForm('uuid-32') })).bound)
  assert.equal(sealed.keyDefinitionDigest, v3.keyDefinitionDigest)
  assert.deepEqual(sealed.keyDefinition, v3.keyDefinition)
  // The v2 rows themselves are unchanged (v2 has no generated value); only the key definition carries the form.
  assert.deepEqual(sealed.rowSpecs, compileYidaDraft(material).rowSpecs)
  assert.notEqual(sealed.planDigest, V2_GOLDEN.material.planDigest)
  for (const bad of ['uuid-16', 'UUID-32', '', null, 32, true]) {
    expectError(compileYidaDraft, YidaDraftPlanError, { ...material, config: { ...material.config, materialCodeForm: bad } }, 'YIDA_DRAFT_CONFIG')
  }
})

test('D2 one form per config: a root and a preset that disagree, or an unknown preset form, are CONFIG_MATERIAL_CODE_FORM_INVALID / FIELD_MAP', async () => {
  const { validateYidaStaticConfig, createYidaTransformExample } = await plannerPromise
  const { compileYidaSendDraft, YidaDraftPlanError } = await modulePromise
  const issueOf = (config) => validateYidaStaticConfig(config).issues
  const example = () => structuredClone(createYidaTransformExample().config)
  assert.deepEqual(issueOf(rootForm('uuid-36', presetForm('uuid-32'))(example())), [{ code: 'CONFIG_MATERIAL_CODE_FORM_INVALID', field: 'materialCodeForm' }])
  assert.deepEqual(issueOf(rootForm('uuid-32', presetForm('uuid-36'))(example())), [{ code: 'CONFIG_MATERIAL_CODE_FORM_INVALID', field: 'materialCodeForm' }])
  assert.deepEqual(issueOf(rootForm('uuid-16')(example())), [{ code: 'CONFIG_MATERIAL_CODE_FORM_INVALID', field: 'materialCodeForm' }])
  // A preset part's form is closed like a hash part's: an unknown form is an invalid part.
  assert.deepEqual(issueOf(presetForm('uuid-16')(example())), [{ code: 'CONFIG_FIELD_MAP_INVALID', field: 'fieldMap' }])
  // Two preset parts naming two forms in one config are refused as well (one identity, one code).
  const twoPresets = example()
  const generated = twoPresets.fieldMap.find((entry) => entry.transform === 'generated')
  twoPresets.fieldMap.push({ ...structuredClone(generated), target: 'materialCodeAlt' })
  twoPresets.fieldCatalog.push({ id: 'materialCodeAlt', control: 'text', required: false })
  generated.template[0].form = 'uuid-32'
  twoPresets.fieldMap.at(-1).template[0].form = 'uuid-36'
  assert.deepEqual(issueOf(twoPresets), [{ code: 'CONFIG_MATERIAL_CODE_FORM_INVALID', field: 'materialCodeForm' }])
  // A preset part without a form follows the config's one declared form; both presets then mint uuid-32 codes.
  delete twoPresets.fieldMap.at(-1).template[0].form
  assert.equal(validateYidaStaticConfig(twoPresets).normalized.materialCodeForm, 'uuid-32')
  twoPresets.fieldMap.at(-1).template[0].form = 'uuid-32'
  assert.equal(validateYidaStaticConfig(twoPresets).normalized.materialCodeForm, 'uuid-32')
  const { unbound } = await generatedInput()
  expectError(compileYidaSendDraft, YidaDraftPlanError, { ...unbound, config: rootForm('uuid-36', presetForm('uuid-32'))(example()) }, 'YIDA_DRAFT_CONFIG')
})
