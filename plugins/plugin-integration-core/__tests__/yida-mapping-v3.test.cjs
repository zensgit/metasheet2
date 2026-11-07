'use strict'

// Synthetic, offline checks of the v3 YiDa mapping (direct / copy / constant / concat).
// No store, credentials, transport or network: every network global is replaced by a
// spy that throws, and each suite asserts that none of them was touched.
const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')
const { pathToFileURL } = require('node:url')

const lib = (name) => import(pathToFileURL(path.join(__dirname, '..', 'lib', name)).href)
const plannerPromise = lib('yida-static-plan.mjs')
const allocationPromise = lib('stock-preparation-yida-allocation.mjs')
const draftPromise = lib('yida-draft-compiler.mjs')
const persistedPromise = lib('yida-draft-plan.mjs')

const TARGET = { appType: 'synthetic_v3_app', formUuid: 'synthetic_v3_form' }
const clone = (value) => JSON.parse(JSON.stringify(value))

// A small layout with one of every transform. The key is bound to targets, not sources.
function config(patch = {}) {
  return {
    version: 3, kind: 'yida-form-protocol-static', target: TARGET, intent: 'create',
    businessKey: ['project', 'line', 'parent'], emptyKeyFields: ['parent'],
    fieldCatalog: [
      { id: 'project', control: 'text', required: true },
      { id: 'line', control: 'text', required: true },
      { id: 'parent', control: 'text', required: false },
      { id: 'parentCopy', control: 'text', required: false },
      { id: 'qty', control: 'number', required: true },
      { id: 'size', control: 'text', required: false },
      { id: 'rule', control: 'select', required: true, options: ['SYN-A', 'SYN-B'] },
      { id: 'note', control: 'text', required: false },
    ],
    fieldMap: [
      { transform: 'direct', source: 'projectNo', target: 'project', type: 'string', required: true },
      { transform: 'direct', source: 'lineId', target: 'line', type: 'string', required: true },
      { transform: 'direct', source: 'parentCode', target: 'parent', type: 'string', required: false },
      { transform: 'copy', copyOf: 'parent', target: 'parentCopy', type: 'string', required: false },
      { transform: 'direct', source: 'quantity', target: 'qty', type: 'number', required: true },
      { transform: 'concat', parts: [{ source: 'length' }, { source: 'width' }, { source: 'thickness' }],
        separator: '*', blank: 'refuse', target: 'size', type: 'string', required: false },
      { transform: 'constant', value: 'SYN-A', target: 'rule', type: 'string', required: true },
      { transform: 'constant', value: 'SYN-NOTE', target: 'note', type: 'string', required: false },
    ],
    ...patch,
  }
}

function row(patch = {}) {
  return { projectNo: 'DEMO-P1', lineId: 'LINE-1', parentCode: 'PARENT-1', quantity: 4,
    length: 1200, width: 600, thickness: 20, ...patch }
}

const DERIVED = new Set(['copy', 'constant', 'concat'])

// Every order of the derived entries, interleaved at fixed slots between the direct ones.
function permutations(items) {
  if (items.length <= 1) return [items]
  return items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)])
    .map((rest) => [item, ...rest]))
}

function reorderDerived(layout, order) {
  const derived = layout.fieldMap.filter((entry) => DERIVED.has(entry.transform))
  const queue = order.map((index) => derived[index])
  return { ...layout, fieldMap: layout.fieldMap.map((entry) => DERIVED.has(entry.transform) ? queue.shift() : entry) }
}

function guardNetwork() {
  const names = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource']
  const saved = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
  const calls = []
  for (const name of names) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true,
      value: (...args) => { calls.push(name); throw new Error(`synthetic ${name} must not run`) } })
  }
  return {
    calls,
    restore() {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else delete globalThis[name]
      }
    },
  }
}

test('v3 validates one of every transform and normalizes to a fixed, target-bound shape', async () => {
  const { validateYidaStaticConfig } = await plannerPromise
  const checked = validateYidaStaticConfig(config())
  assert.equal(checked.valid, true, JSON.stringify(checked.issues))
  assert.deepEqual(checked.normalized.businessKey, ['project', 'line', 'parent'])
  assert.deepEqual(checked.normalized.emptyKeyFields, ['parent'])
  assert.deepEqual(checked.normalized.fieldMap[3], { transform: 'copy', copyOf: 'parent', target: 'parentCopy', type: 'string', required: false })
  assert.deepEqual(Object.keys(checked.normalized.fieldMap[5]), ['transform', 'parts', 'separator', 'blank', 'target', 'type', 'required'])
})

test('v3 config refusals: lookup, chains, bad constants, bad concat, keys on derived targets, duplicate direct source', async () => {
  const { validateYidaStaticConfig } = await plannerPromise
  const map = config().fieldMap
  const replace = (index, entry) => ({ fieldMap: map.map((item, at) => at === index ? entry : item) })
  const cases = {
    lookup: replace(3, { transform: 'lookup', table: 'synthetic', target: 'parentCopy', type: 'string', required: false }),
    'v2-shaped entry': replace(3, { source: 'parentCode', target: 'parentCopy', type: 'string', required: false }),
    'copy of a derived target': replace(3, { transform: 'copy', copyOf: 'note', target: 'parentCopy', type: 'string', required: false }),
    'copy of itself': replace(3, { transform: 'copy', copyOf: 'parentCopy', target: 'parentCopy', type: 'string', required: false }),
    'copy changes type': { fieldCatalog: config().fieldCatalog.map((item) => item.id === 'parentCopy' ? { ...item, control: 'number' } : item),
      ...replace(3, { transform: 'copy', copyOf: 'parent', target: 'parentCopy', type: 'number', required: false }) },
    'constant outside options': replace(6, { transform: 'constant', value: 'SYN-C', target: 'rule', type: 'string', required: true }),
    'blank constant': replace(7, { transform: 'constant', value: '  ', target: 'note', type: 'string', required: false }),
    'number constant for text': replace(7, { transform: 'constant', value: 3, target: 'note', type: 'string', required: false }),
    'concat without a source part': replace(5, { ...map[5], parts: [{ literal: 'a' }, { literal: 'b' }] }),
    'concat single part': replace(5, { ...map[5], parts: [{ source: 'length' }] }),
    'concat part with two keys': replace(5, { ...map[5], parts: [{ source: 'length', literal: 'x' }, { source: 'width' }] }),
    'concat unknown blank rule': replace(5, { ...map[5], blank: 'keep' }),
    'concat control separator': replace(5, { ...map[5], separator: '\u0007' }),
    'concat into select': { ...replace(6, { transform: 'concat', parts: [{ source: 'length' }, { source: 'width' }], separator: '', blank: 'skip', target: 'rule', type: 'string', required: true }) },
    'second direct entry for one source': replace(3, { transform: 'direct', source: 'parentCode', target: 'parentCopy', type: 'string', required: false }),
    'key names a copy target': { businessKey: ['project', 'line', 'parentCopy'], emptyKeyFields: [] },
    'key names a constant target': { businessKey: ['project', 'rule'], emptyKeyFields: [] },
    'key names a source column': { businessKey: ['projectNo', 'line'], emptyKeyFields: [] },
    'empty key on a required target': { emptyKeyFields: ['line'] },
  }
  for (const [name, patch] of Object.entries(cases)) {
    const checked = validateYidaStaticConfig(config(patch))
    assert.equal(checked.valid, false, name)
  }
})

test('concat semantics are explicit: listed order, one separator, String(number), skip or refuse blanks', async () => {
  const { buildYidaStaticPlan } = await plannerPromise
  const skip = config({ fieldMap: config().fieldMap.map((entry) => entry.target === 'size'
    ? { ...entry, parts: [{ literal: 'L' }, { source: 'length' }, { source: 'width' }, { source: 'thickness' }], separator: '/', blank: 'skip' }
    : entry) })
  const run = (layout, rows) => buildYidaStaticPlan({ config: layout, rows }).rows
  // Literal first, numbers via String(), separator between every kept piece; no current-value-first rule.
  assert.equal(run(skip, [row({ length: 0.5 })])[0].payload.size, 'L/0.5/600/20')
  // skip: a blank source part drops with its separator; strings are used verbatim (no trim).
  assert.equal(run(skip, [row({ width: null, thickness: ' 20 ' })])[0].payload.size, 'L/1200/ 20 ')
  assert.equal(run(skip, [row({ width: '   ' })])[0].payload.size, 'L/1200/20')
  // Every source part blank: the value is missing, literals alone never make one.
  const absentThickness = row({ length: null, width: '' })
  delete absentThickness.thickness
  const allBlank = run(skip, [absentThickness])[0]
  assert.equal(allBlank.status, 'planned_create')
  assert.equal(Object.hasOwn(allBlank.payload, 'size'), false)
  const requiredSkip = config({ fieldCatalog: skip.fieldCatalog.map((item) => item.id === 'size' ? { ...item, required: true } : item),
    fieldMap: skip.fieldMap.map((entry) => entry.target === 'size' ? { ...entry, required: true } : entry) })
  assert.deepEqual(run(requiredSkip, [row({ length: null, width: null, thickness: null })])[0].issues.map((issue) => issue.code), ['FIELD_REQUIRED'])
  // refuse: a partly filled concat is refused; an entirely blank one is just missing.
  const refuse = run(config(), [row({ width: null }), row({ lineId: 'LINE-2', length: null, width: null, thickness: null }), row({ lineId: 'LINE-3' })])
  assert.deepEqual(refuse[0].issues, [{ index: 0, code: 'FIELD_PART_MISSING', fields: [{ target: 'size', type: 'string', transform: 'concat' }] }])
  assert.equal(refuse[1].status, 'planned_create')
  assert.equal(Object.hasOwn(refuse[1].payload, 'size'), false)
  assert.equal(refuse[2].payload.size, '1200*600*20')
  // Booleans are never stringified; an over-long result is refused.
  assert.deepEqual(run(config(), [row({ width: true })])[0].issues.map((issue) => issue.code), ['FIELD_TYPE'])
  assert.deepEqual(run(config(), [row({ length: 'x'.repeat(4096) })])[0].issues.map((issue) => issue.code), ['FIELD_VALUE_TOO_LONG'])
})

test('v3 row-token number domain: safe integers up to 2^53-1, finite decimals that keep their text', async () => {
  const { parseYidaStaticRows } = await plannerPromise
  // Builds the row text by hand so the numeric token reaches the scanner exactly as written.
  const rowsText = (token) => `[{"projectNo":"DEMO-P1","lineId":"LINE-1","parentCode":"PARENT-1","quantity":${token},"length":1200,"width":600,"thickness":20}]`
  const accepted = { '9007199254740991': Number.MAX_SAFE_INTEGER, '-9007199254740991': -Number.MAX_SAFE_INTEGER, '0': 0, '1.5': 1.5 }
  for (const [token, value] of Object.entries(accepted)) {
    assert.equal(parseYidaStaticRows(rowsText(token), config())[0].quantity, value, token)
  }
  // 2^53 and beyond leave the safe-integer domain; 1e400 parses to Infinity; -0 is refused;
  // a decimal that loses digits when parsed no longer keeps its text identity.
  for (const token of ['9007199254740992', '9007199254740993', '-9007199254740992', '1e400', '-1e400', '-0', '9007199254740991.5']) {
    assert.throws(() => parseYidaStaticRows(rowsText(token), config()), (error) => error.code === 'YIDA_STATIC_ROWS_INVALID', token)
  }
})

test('constants and copies land in the payload and are validated against their own control', async () => {
  const { buildYidaStaticPlan } = await plannerPromise
  const [planned] = buildYidaStaticPlan({ config: config(), rows: [row()] }).rows
  assert.deepEqual(planned.payload, { project: 'DEMO-P1', line: 'LINE-1', parent: 'PARENT-1', parentCopy: 'PARENT-1',
    qty: 4, size: '1200*600*20', rule: 'SYN-A', note: 'SYN-NOTE' })
  // Payload order follows the field catalog, so formDataJson does not depend on fieldMap order.
  assert.equal(planned.protocolPreview.data.formDataJson, JSON.stringify(planned.payload))
  const selectCopy = config({
    fieldCatalog: [...config().fieldCatalog.filter((item) => item.id !== 'parentCopy'), { id: 'parentCopy', control: 'select', required: false, options: ['PARENT-1'] }],
  })
  const plan = buildYidaStaticPlan({ config: selectCopy, rows: [row(), row({ lineId: 'LINE-2', parentCode: 'PARENT-2' })] })
  assert.equal(plan.rows[0].status, 'planned_create')
  assert.deepEqual(plan.rows[1].issues, [{ index: 1, code: 'FIELD_OPTION_INVALID', fields: [{ source: 'parentCode', target: 'parentCopy', type: 'string', transform: 'copy' }] }])
})

test('key stability: every order of the derived entries keeps the dedupe key, the plan and the plan identity', async () => {
  const { buildYidaStaticPlan, validateYidaStaticConfig } = await plannerPromise
  const { compileYidaLocalDraft } = await draftPromise
  const rows = [row(), row({ lineId: 'LINE-2', parentCode: null, length: null, width: null, thickness: null }), row({ lineId: 'LINE-3', parentCode: '' })]
  const base = config()
  const reference = buildYidaStaticPlan({ config: base, rows })
  const referenceDraft = compileYidaLocalDraft({ config: base, rowsText: JSON.stringify(rows), allocation: { mode: 'original' } })
  const derivedCount = base.fieldMap.filter((entry) => DERIVED.has(entry.transform)).length
  const orders = permutations([...Array(derivedCount).keys()])
  assert.equal(orders.length, 24)
  for (const order of orders) {
    const layout = reorderDerived(base, order)
    assert.equal(validateYidaStaticConfig(layout).valid, true)
    const plan = buildYidaStaticPlan({ config: layout, rows })
    assert.deepEqual(plan.rows.map((item) => item.localBusinessKey), reference.rows.map((item) => item.localBusinessKey), `order ${order}`)
    assert.deepEqual(plan, reference, `order ${order}`)
    const draft = compileYidaLocalDraft({ config: layout, rowsText: JSON.stringify(rows), allocation: { mode: 'original' } })
    assert.equal(draft.planDigest, referenceDraft.planDigest, `order ${order}`)
    assert.equal(draft.keyDefinitionDigest, referenceDraft.keyDefinitionDigest)
    assert.deepEqual(draft.rowSpecs, referenceDraft.rowSpecs)
  }
  // Also with a copy placed before its primary and the whole map reversed.
  const reversed = { ...base, fieldMap: [...base.fieldMap].reverse(), businessKey: [...base.businessKey].reverse() }
  assert.deepEqual(buildYidaStaticPlan({ config: reversed, rows }), reference)
  assert.equal(compileYidaLocalDraft({ config: reversed, rowsText: JSON.stringify(rows), allocation: { mode: 'original' } }).planDigest, referenceDraft.planDigest)
})

test('derived targets never enter the key: renaming or changing them moves only the payload', async () => {
  const { buildYidaStaticPlan } = await plannerPromise
  const { compileYidaLocalDraft } = await draftPromise
  const rows = [row()]
  const base = compileYidaLocalDraft({ config: config(), rowsText: JSON.stringify(rows), allocation: { mode: 'original' } })
  const constant = config({ fieldMap: config().fieldMap.map((entry) => entry.target === 'note' ? { ...entry, value: 'SYN-OTHER' } : entry) })
  const changed = compileYidaLocalDraft({ config: constant, rowsText: JSON.stringify(rows), allocation: { mode: 'original' } })
  assert.equal(changed.keyDefinitionDigest, base.keyDefinitionDigest)
  assert.equal(changed.rowSpecs[0].businessKeyDigest, base.rowSpecs[0].businessKeyDigest)
  assert.notEqual(changed.rowSpecs[0].payloadDigest, base.rowSpecs[0].payloadDigest)
  assert.notEqual(changed.planDigest, base.planDigest)
  assert.deepEqual(base.keyDefinition, { algorithm: 'yida-protocol-v2', fields: [
    { target: 'line', type: 'string', empty: false },
    { target: 'parent', type: 'string', empty: true },
    { target: 'project', type: 'string', empty: false },
  ] })
  // Two rows that differ only in a derived value are still duplicates of one key.
  const twins = buildYidaStaticPlan({ config: config(), rows: [row(), row({ length: 999 })] })
  assert.equal(twins.evidence.duplicateKeyCount, 2)
})

// R-71 ⑦.3 B2: the plan digest now covers the mapping version (v3 adds mapping: 3), so it differs
// from the v2 one; the key definition, row specs and business keys stay the same.
test('a v2 layout lifted to v3 keeps its key, key definition and row digests; only the plan digest marks v3', async () => {
  const { compileYidaDraft } = await persistedPromise
  const { compileYidaLocalDraft } = await draftPromise
  const v2 = {
    version: 2, kind: 'yida-form-protocol-static', target: TARGET, intent: 'create',
    businessKey: ['projectNo', 'lineId', 'parentCode'], emptyKeyFields: ['parentCode'],
    fieldCatalog: config().fieldCatalog.filter((item) => ['project', 'line', 'parent', 'qty'].includes(item.id)),
    fieldMap: [
      { source: 'projectNo', target: 'project', type: 'string', required: true },
      { source: 'lineId', target: 'line', type: 'string', required: true },
      { source: 'parentCode', target: 'parent', type: 'string', required: false },
      { source: 'quantity', target: 'qty', type: 'number', required: true },
    ],
  }
  const v3 = { ...v2, version: 3, businessKey: ['project', 'line', 'parent'], emptyKeyFields: ['parent'],
    fieldMap: v2.fieldMap.map((entry) => ({ transform: 'direct', ...entry })) }
  const rows = JSON.stringify([row(), row({ lineId: 'LINE-2', parentCode: null })])
  for (const allocation of [{ mode: 'original' }, { mode: 'equal_integer', projects: ['DEMO-P1', 'DEMO-P2'], projectField: 'projectNo', quantityField: 'quantity' }]) {
    const before = compileYidaDraft({ config: v2, rowsText: rows, allocation })
    const after = compileYidaLocalDraft({ config: v3, rowsText: rows, allocation })
    assert.notEqual(after.planDigest, before.planDigest)
    assert.equal(after.keyDefinitionDigest, before.keyDefinitionDigest)
    assert.deepEqual(after.rowSpecs, before.rowSpecs)
    assert.deepEqual(after.plan.rows.map((item) => item.localBusinessKey), before.plan.rows.map((item) => item.localBusinessKey))
  }
})

test('v2 still refuses one source mapped twice; initialization still refuses v3 and the send entry accepts it', async () => {
  const { validateYidaStaticConfig } = await plannerPromise
  const { compileYidaDraft, compileYidaSendDraft } = await persistedPromise
  const { compileYidaLocalDraft } = await draftPromise
  const v2 = {
    version: 2, kind: 'yida-form-protocol-static', target: TARGET, intent: 'create',
    businessKey: ['parentName'], emptyKeyFields: [],
    fieldCatalog: [{ id: 'parentPart', control: 'text', required: false }, { id: 'category', control: 'text', required: false }],
    fieldMap: [
      { source: 'parentName', target: 'parentPart', type: 'string', required: false },
      { source: 'parentName', target: 'category', type: 'string', required: false },
    ],
  }
  assert.deepEqual(validateYidaStaticConfig(v2).issues, [{ code: 'CONFIG_FIELD_MAP_INVALID', field: 'fieldMap' }])
  const input = { config: config(), rowsText: JSON.stringify([row()]), allocation: { mode: 'original' } }
  assert.equal(compileYidaLocalDraft(input).plan.rows.length, 1)
  assert.throws(() => compileYidaDraft(input), (error) => error.code === 'YIDA_DRAFT_CONFIG')
  // R-71 ⑦.3: the facade carries the v2-only initialization entry and the v2+v3 send entry, never
  // the local recompute. The send entry gives the local recompute's exact result for a v3 input.
  assert.deepEqual(Object.keys(await persistedPromise).sort(), ['YidaDraftPlanError', 'compileYidaDraft', 'compileYidaSendDraft'])
  assert.deepEqual(compileYidaSendDraft(input), compileYidaLocalDraft(input))
  assert.equal((await persistedPromise).YidaDraftPlanError, (await draftPromise).YidaDraftPlanError)
})

test('v3 allocation: copies and concat parts read the split project and quantity', async () => {
  const { buildYidaProjectAllocationPreview, validateYidaProjectAllocationRules } = await allocationPromise
  const layout = config({
    fieldCatalog: [...config().fieldCatalog, { id: 'projectCopy', control: 'text', required: false }, { id: 'label', control: 'text', required: false }],
    fieldMap: [...config().fieldMap,
      { transform: 'copy', copyOf: 'project', target: 'projectCopy', type: 'string', required: false },
      { transform: 'concat', parts: [{ source: 'projectNo' }, { source: 'quantity' }], separator: '#', blank: 'skip', target: 'label', type: 'string', required: false }],
  })
  assert.deepEqual(validateYidaProjectAllocationRules(layout, { mode: 'equal_integer', projectField: 'projectNo', quantityField: 'quantity' }),
    { mode: 'equal_integer', projectField: 'projectNo', quantityField: 'quantity' })
  // Allocation fields are source columns of direct entries; the project one must be in the key.
  for (const rules of [{ projectField: 'project', quantityField: 'quantity' }, { projectField: 'projectNo', quantityField: 'qty' },
    { projectField: 'lineId', quantityField: 'quantity', unkeyed: true }]) {
    const { unkeyed, ...fields } = rules
    const target = unkeyed ? config({ businessKey: ['project', 'parent'], emptyKeyFields: ['parent'] }) : layout
    const probe = unkeyed ? { ...fields, projectField: 'lineId' } : fields
    assert.throws(() => validateYidaProjectAllocationRules(target, { mode: 'equal_integer', ...probe }), (error) => error.code === 'YIDA_ALLOCATION_FIELDS_INVALID')
  }
  const preview = buildYidaProjectAllocationPreview({ config: layout, rowsText: JSON.stringify([row({ quantity: 8 })]),
    allocation: { mode: 'equal_integer', projects: ['SYN-P1', 'SYN-P2'], projectField: 'projectNo', quantityField: 'quantity' } })
  assert.deepEqual(preview.issues, [])
  assert.deepEqual(preview.plan.rows.map((item) => [item.payload.project, item.payload.projectCopy, item.payload.qty, item.payload.label]),
    [['SYN-P1', 'SYN-P1', 4, 'SYN-P1#4'], ['SYN-P2', 'SYN-P2', 4, 'SYN-P2#4']])
})

test('lookup stays out: the static plan, allocation and local compile run with zero network', async () => {
  const { buildYidaStaticPlan, parseYidaStaticRows, validateYidaStaticConfig, createYidaTransformExample } = await plannerPromise
  const { buildYidaProjectAllocationPreview } = await allocationPromise
  const { compileYidaLocalDraft } = await draftPromise
  const guard = guardNetwork()
  try {
    const example = createYidaTransformExample()
    const checked = validateYidaStaticConfig(example.config)
    assert.equal(checked.valid, true)
    const plan = buildYidaStaticPlan({ config: example.config, rows: parseYidaStaticRows(example.text, example.config) })
    assert.equal(plan.lookupExecuted, false)
    assert.equal(plan.externalWriteAttempted, false)
    assert.equal(plan.evidence.invalid, 0)
    const allocation = { ...example.allocation, projects: ['SYN-P1', 'SYN-P2'] }
    const preview = buildYidaProjectAllocationPreview({ config: example.config, rowsText: example.text, allocation })
    assert.equal(preview.lookupExecuted, false)
    assert.deepEqual(preview.issues, [])
    const draft = compileYidaLocalDraft({ config: example.config, rowsText: example.text, allocation })
    assert.equal(draft.plan.lookupExecuted, false)
    // A lookup transform is not part of the vocabulary at all.
    const lookup = clone(example.config)
    lookup.fieldMap[0] = { transform: 'lookup', source: 'projectNo', table: 'synthetic_bom', target: lookup.fieldMap[0].target, type: 'string', required: true }
    assert.equal(validateYidaStaticConfig(lookup).valid, false)
  } finally { guard.restore() }
  assert.deepEqual(guard.calls, [])
})

// R-71 ⑦.3 decision A: slot 1 seals its key definition at L4. A v3 material draft can only go to it
// if the shipped v2 material template (the L4 layout) and the v3 material template define the key
// identically: same key targets, types and nullable parts, so the same rows keep the same identity.
test('the shipped v2 material template and the v3 material template share one key definition and row identities', async () => {
  const { compileYidaSendDraft, YidaDraftPlanError } = await persistedPromise
  const { compileYidaLocalDraft } = await draftPromise
  const { createYidaTransformExample } = await plannerPromise
  const fs = require('node:fs')
  const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
  const v2 = read(path.join(__dirname, '..', '..', '..', 'docs', 'development', 'takeover-beiliao-20260821', 'yida-legacy-templates', 'material.json'))
  const v3 = read(path.join(__dirname, '..', 'fixtures', 'yida-rule-templates', 'material-v3.json'))
  const target = { appType: 'synthetic_slot_app', formUuid: 'synthetic_slot_form' }
  const rowsText = createYidaTransformExample().text
  const allocation = { ...v2.allocation, projects: ['DEMO-P1', 'DEMO-P2'] }
  assert.deepEqual(v3.allocation, v2.allocation)
  const before = compileYidaSendDraft({ config: { ...v2.rules, target }, rowsText, allocation })
  // The v3 template carries the generated material code, so its persisted entry needs a server source binding
  // (SOURCE_UNBOUND, R-71 ⑦.4): pasted rows are refused there and compared through the same compiler's local entry.
  assert.equal(v3.rules.fieldMap.some((entry) => entry.transform === 'generated'), true)
  assert.throws(() => compileYidaSendDraft({ config: { ...v3.rules, target }, rowsText, allocation }),
    (error) => error instanceof YidaDraftPlanError && error.code === 'YIDA_DRAFT_PLAN')
  const after = compileYidaLocalDraft({ config: { ...v3.rules, target }, rowsText, allocation })
  assert.equal(after.keyDefinition.fields.length, 7)
  assert.deepEqual(after.keyDefinition, before.keyDefinition)
  assert.equal(after.keyDefinitionDigest, before.keyDefinitionDigest)
  assert.deepEqual(after.rowSpecs.map((spec) => spec.businessKeyDigest), before.rowSpecs.map((spec) => spec.businessKeyDigest))
  assert.notEqual(after.planDigest, before.planDigest)
})

// ---------------------------------------------------------------------------------------------
// R-71 ⑦.4 PR-2 (owner addendum 2026-11-06, decision 1): the `generated` transform, a template of
// closed parts (literal / field / hash / preset) under rule G1. Acceptance A1-A4 and A6 of design B.
// The oracle below is independent of the planner and of the material-code leaf: node:crypto SHA-1
// with the RFC 4122 / 9562 UUIDv5 bit layout.
const crypto = require('node:crypto')
const GENERATED_NAMESPACE = 'de2dfbd7-8b3f-41a4-9322-8487ec85637f'
const MATERIAL_NAMESPACE = '6d37f698-e75c-4b5e-8eef-b702478a1cfb'
function oracleUuidV5(namespace, name) {
  const digest = crypto.createHash('sha1').update(Buffer.from(namespace.replace(/-/g, ''), 'hex'))
    .update(Buffer.from(name, 'utf8')).digest().subarray(0, 16)
  digest[6] = (digest[6] & 0x0f) | 0x50
  digest[8] = (digest[8] & 0x3f) | 0x80
  const h = digest.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`.toUpperCase()
}
// The hash name holds each member as a [target, value] pair, sorted by target (coordinator ruling L1, 2026-11-07).
const oracleHash = (members, form = 'uuid-36') => {
  const pairs = Object.entries(members).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  const uuid = oracleUuidV5(GENERATED_NAMESPACE, JSON.stringify(['metasheet.stock-prep.yida-generated-hash', 'v1', pairs]))
  return form === 'uuid-32' ? uuid.replaceAll('-', '') : uuid
}
const oracleMaterialCode = (keyValue, projectNo) =>
  `WLBH-${oracleUuidV5(MATERIAL_NAMESPACE, JSON.stringify(['metasheet.stock-prep.yida-material-code', 'v1', keyValue, projectNo]))}`
const WLBH_SHAPE = /^WLBH-[0-9A-F]{8}-[0-9A-F]{4}-5[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/

const KEY_HASH = { hash: ['project', 'line', 'parent'], form: 'uuid-36' }
// The small layout plus a non-key text column and one generated target.
function generatedConfig(template = [{ literal: 'PRJ-' }, { field: 'project' }, { literal: '-' }, KEY_HASH], patch = {}, entryPatch = {}) {
  const base = config()
  return config({
    fieldCatalog: [...base.fieldCatalog, { id: 'drawing', control: 'text', required: false }, { id: 'code', control: 'text', required: false }],
    fieldMap: [...base.fieldMap,
      { transform: 'direct', source: 'drawingNo', target: 'drawing', type: 'string', required: false },
      { transform: 'generated', template, target: 'code', type: 'string', required: true, ...entryPatch }],
    ...patch,
  })
}
const generatedRow = (patch = {}) => row({ drawingNo: 'DRW-1', ...patch })
const codeIssue = (index, code) => ({ index, code, fields: [{ target: 'code', type: 'string', transform: 'generated' }] })

test('A1 generated config closure: shape, caps, part targets, G1 and key placement are all refused', async () => {
  const { validateYidaStaticConfig } = await plannerPromise
  const valid = {
    'hash, field and literals': generatedConfig(),
    'hash only, 32 form': generatedConfig([{ hash: ['parent', 'line', 'project'], form: 'uuid-32' }]),
    'hash with an extra non-key member': generatedConfig([{ hash: ['project', 'line', 'parent', 'drawing'], form: 'uuid-36' }]),
    'number field part': generatedConfig([{ field: 'qty' }, KEY_HASH]),
    // G1 shift: field parts on one side only (either side), literals on both sides.
    'field parts after the hash only': generatedConfig([{ literal: 'A-' }, KEY_HASH, { literal: '-' }, { field: 'drawing' }, { field: 'qty' }]),
    'field parts before the preset only, literals around': generatedConfig([{ field: 'qty' }, { field: 'drawing' }, { literal: '<' },
      { preset: 'material-code-v1', rowIdOf: 'line', projectOf: 'project' }, { literal: '>' }]),
    preset: generatedConfig([{ preset: 'material-code-v1', rowIdOf: 'drawing', projectOf: 'project' }]),
    'eight parts': generatedConfig([...Array(7).fill({ literal: 'x' }), KEY_HASH]),
    'literal of 128': generatedConfig([{ literal: 'L'.repeat(128) }, KEY_HASH]),
    'sixteen hash members': (() => {
      const extra = Array.from({ length: 12 }, (_, index) => `extra${index}`)
      const layout = generatedConfig([{ hash: ['project', 'line', 'parent', 'drawing', ...extra], form: 'uuid-36' }])
      layout.fieldCatalog = [...layout.fieldCatalog, ...extra.map((id) => ({ id, control: 'text', required: false }))]
      layout.fieldMap = [...layout.fieldMap, ...extra.map((id) => ({ transform: 'direct', source: `${id}Source`, target: id, type: 'string', required: false }))]
      return layout
    })(),
  }
  for (const [name, layout] of Object.entries(valid)) {
    const checked = validateYidaStaticConfig(layout)
    assert.equal(checked.valid, true, `${name}: ${JSON.stringify(checked.issues)}`)
  }
  const normalized = validateYidaStaticConfig(generatedConfig([{ preset: 'material-code-v1', rowIdOf: 'drawing', projectOf: 'project' }, { literal: '#' }])).normalized
  assert.deepEqual(normalized.fieldMap.at(-1), { transform: 'generated',
    template: [{ preset: 'material-code-v1', rowIdOf: 'drawing', projectOf: 'project' }, { literal: '#' }], target: 'code', type: 'string', required: true })

  const seventeen = (() => {
    const extra = Array.from({ length: 13 }, (_, index) => `extra${index}`)
    const layout = generatedConfig([{ hash: ['project', 'line', 'parent', 'drawing', ...extra], form: 'uuid-36' }])
    layout.fieldCatalog = [...layout.fieldCatalog, ...extra.map((id) => ({ id, control: 'text', required: false }))]
    layout.fieldMap = [...layout.fieldMap, ...extra.map((id) => ({ transform: 'direct', source: `${id}Source`, target: id, type: 'string', required: false }))]
    return layout
  })()
  const refused = {
    'unknown entry key': generatedConfig(undefined, {}, { separator: '-' }),
    'entry without template': (() => { const layout = generatedConfig(); delete layout.fieldMap.at(-1).template; return layout })(),
    'unknown part key': generatedConfig([{ literal: 'x', note: 'y' }, KEY_HASH]),
    // Every part kind has an exact key list (Y6a verifier LOW-2: MI2 / MI3), not only literal and field.
    'unknown key on a hash part': generatedConfig([{ ...KEY_HASH, note: 'y' }]),
    'unknown key on a field part': generatedConfig([{ field: 'project', note: 'y' }, KEY_HASH]),
    'unknown key on a preset part': generatedConfig([{ preset: 'material-code-v1', rowIdOf: 'drawing', projectOf: 'project', note: 'y' }]),
    'part with two kinds': generatedConfig([{ field: 'project', literal: 'x' }, KEY_HASH]),
    'unknown part kind': generatedConfig([{ date: 'project', format: 'YYYYMMDD' }, KEY_HASH]),
    'template not an array': generatedConfig('PRJ-'),
    'empty template': generatedConfig([]),
    'nine parts': generatedConfig([...Array(8).fill({ literal: 'x' }), KEY_HASH]),
    'literals only': generatedConfig([{ literal: 'a' }, { literal: 'b' }]),
    'literal of 129': generatedConfig([{ literal: 'L'.repeat(129) }, KEY_HASH]),
    'literal with a control character': generatedConfig([{ literal: 'a\u0007' }, KEY_HASH]),
    'blank literal': generatedConfig([{ literal: '   ' }, KEY_HASH]),
    'field on a copy target': generatedConfig([{ field: 'parentCopy' }, KEY_HASH]),
    'field on an unknown target': generatedConfig([{ field: 'nowhere' }, KEY_HASH]),
    'field on a source column': generatedConfig([{ field: 'projectNo' }, KEY_HASH]),
    'hash on a constant target': generatedConfig([{ hash: ['project', 'line', 'parent', 'note'], form: 'uuid-36' }]),
    'hash on an unknown target': generatedConfig([{ hash: ['project', 'line', 'parent', 'nowhere'], form: 'uuid-36' }]),
    'hash on a number target': generatedConfig([{ hash: ['project', 'line', 'parent', 'qty'], form: 'uuid-36' }]),
    'hash missing one key target': generatedConfig([{ hash: ['project', 'line'], form: 'uuid-36' }]),
    'hash with a duplicate member': generatedConfig([{ hash: ['project', 'line', 'parent', 'line'], form: 'uuid-36' }]),
    'hash with no member': generatedConfig([{ hash: [], form: 'uuid-36' }]),
    'hash with seventeen members': seventeen,
    'unknown hash form': generatedConfig([{ hash: ['project', 'line', 'parent'], form: 'uuid-16' }]),
    'hash without form': generatedConfig([{ hash: ['project', 'line', 'parent'] }]),
    'two hash parts': generatedConfig([KEY_HASH, { literal: '-' }, KEY_HASH]),
    'hash and preset': generatedConfig([KEY_HASH, { preset: 'material-code-v1', rowIdOf: 'drawing', projectOf: 'project' }]),
    'no identity part': generatedConfig([{ literal: 'PRJ-' }, { field: 'project' }, { field: 'line' }]),
    'unknown preset': generatedConfig([{ preset: 'material-code-v2', rowIdOf: 'drawing', projectOf: 'project' }]),
    'preset project not a key target': generatedConfig([{ preset: 'material-code-v1', rowIdOf: 'line', projectOf: 'drawing' }]),
    'preset on a copy target': generatedConfig([{ preset: 'material-code-v1', rowIdOf: 'parentCopy', projectOf: 'project' }]),
    'preset row id on a number target': generatedConfig([{ preset: 'material-code-v1', rowIdOf: 'qty', projectOf: 'project' }]),
    'preset missing projectOf': generatedConfig([{ preset: 'material-code-v1', rowIdOf: 'line' }]),
    // G1 shift (ruling 2026-11-07; r1 F2 / r2 deviation 4): field parts on both sides of the identity part.
    'field parts on both sides of the hash': generatedConfig([{ field: 'drawing' }, KEY_HASH, { field: 'qty' }]),
    'field parts on both sides of the hash, literals between': generatedConfig([{ field: 'drawing' }, { literal: '-' }, KEY_HASH, { literal: '-' }, { field: 'drawing' }]),
    'field parts on both sides of the preset': generatedConfig([{ field: 'qty' }, { preset: 'material-code-v1', rowIdOf: 'line', projectOf: 'project' }, { field: 'drawing' }]),
    'target not a text control': (() => {
      const layout = generatedConfig()
      layout.fieldCatalog = layout.fieldCatalog.map((item) => item.id === 'code' ? { id: 'code', control: 'select', required: false, options: ['SYN-A'] } : item)
      return layout
    })(),
    'number type': (() => {
      const layout = generatedConfig(undefined, {}, { type: 'number' })
      layout.fieldCatalog = layout.fieldCatalog.map((item) => item.id === 'code' ? { ...item, control: 'number' } : item)
      return layout
    })(),
    'target reused by another entry': generatedConfig(undefined, {}, { target: 'drawing' }),
  }
  for (const [name, layout] of Object.entries(refused)) {
    assert.deepEqual(validateYidaStaticConfig(layout).issues, [{ code: 'CONFIG_FIELD_MAP_INVALID', field: 'fieldMap' }], name)
  }
  // A generated target can never be a key part or a nullable key part (keys name direct targets).
  assert.deepEqual(validateYidaStaticConfig(generatedConfig(undefined, { businessKey: ['project', 'line', 'parent', 'code'] })).issues,
    [{ code: 'CONFIG_KEY_INVALID', field: 'businessKey' }])
  assert.deepEqual(validateYidaStaticConfig(generatedConfig(undefined, { emptyKeyFields: ['parent', 'code'] })).issues,
    [{ code: 'CONFIG_EMPTY_KEY_FIELDS_INVALID', field: 'emptyKeyFields' }])
})

test('A2 generated golden vectors: hash forms, the preset, numbers, Chinese and supplementary-plane text', async () => {
  const { buildYidaStaticPlan } = await plannerPromise
  const { generateYidaMaterialCode } = await lib('yida-material-code.mjs')
  const rows = [
    generatedRow(),
    generatedRow({ projectNo: '示例项目', lineId: '行-二', parentCode: null, quantity: 0.5 }),
    generatedRow({ projectNo: 'P-\u{20000}', lineId: 'L-\u{1F600}', parentCode: '', quantity: 12 }),
  ]
  const golden = {
    'uuid-36': ['4/F8A4B368-95BB-52D7-BCDA-7134BD6B2282', '0.5/6326E462-715A-51A8-9B31-6DFF599BAF4F', '12/71D1A519-243C-5629-A1C3-BFA8BA922EDF'],
    'uuid-32': ['4/F8A4B36895BB52D7BCDA7134BD6B2282', '0.5/6326E462715A51A89B316DFF599BAF4F', '12/71D1A519243C5629A1C3BFA8BA922EDF'],
  }
  for (const form of ['uuid-36', 'uuid-32']) {
    const plan = buildYidaStaticPlan({ config: generatedConfig([{ field: 'qty' }, { literal: '/' }, { hash: ['project', 'line', 'parent'], form }]), rows })
    const codes = plan.rows.map((item) => item.payload.code)
    assert.deepEqual(codes, golden[form], form)
    assert.deepEqual(codes, rows.map((item) => `${String(item.quantity)}/${oracleHash({ project: item.projectNo, line: item.lineId, parent: item.parentCode ?? '' }, form)}`), form)
  }
  // Member order is NOT part of the name (ruling L1): the same members listed in any order give the same code.
  for (const members of [['parent', 'line', 'project'], ['line', 'project', 'parent'], ['project', 'line', 'parent']]) {
    const reordered = buildYidaStaticPlan({ config: generatedConfig([{ field: 'qty' }, { literal: '/' }, { hash: members, form: 'uuid-36' }]), rows })
    assert.deepEqual(reordered.rows.map((item) => item.payload.code), golden['uuid-36'], members.join())
  }
  // The preset is the frozen material-code-v1 generator, byte for byte, on the row's own columns.
  const preset = buildYidaStaticPlan({ config: generatedConfig([{ preset: 'material-code-v1', rowIdOf: 'drawing', projectOf: 'project' }]),
    rows: rows.map((item, index) => ({ ...item, drawingNo: `SYN-LINE-${index}` })) })
  for (const [index, planned] of preset.rows.entries()) {
    assert.equal(planned.payload.code, generateYidaMaterialCode({ keyValue: `SYN-LINE-${index}`, projectNo: rows[index].projectNo }))
    assert.equal(planned.payload.code, oracleMaterialCode(`SYN-LINE-${index}`, rows[index].projectNo))
    assert.match(planned.payload.code, WLBH_SHAPE)
  }
  assert.equal(preset.rows[0].payload.code, 'WLBH-' + oracleUuidV5(MATERIAL_NAMESPACE, JSON.stringify(['metasheet.stock-prep.yida-material-code', 'v1', 'SYN-LINE-0', 'DEMO-P1'])))
  // Domain separation: the generic hash of the same inputs is never the WLBH code's UUID.
  const twoKeys = { businessKey: ['project', 'line'], emptyKeyFields: [] }
  const generic = buildYidaStaticPlan({ config: generatedConfig([{ hash: ['line', 'project'], form: 'uuid-36' }], twoKeys), rows: [rows[0]] }).rows[0].payload.code
  const material = buildYidaStaticPlan({ config: generatedConfig([{ preset: 'material-code-v1', rowIdOf: 'line', projectOf: 'project' }], twoKeys), rows: [rows[0]] }).rows[0].payload.code
  assert.equal(material, oracleMaterialCode('LINE-1', 'DEMO-P1'))
  assert.notEqual(`WLBH-${generic}`, material)
  assert.equal(generic, oracleHash({ line: 'LINE-1', project: 'DEMO-P1' }))
})

test('A3 generated blank and type rules: blank parts refuse, nullable keys hash as empty, no second key issue', async () => {
  const { buildYidaStaticPlan } = await plannerPromise
  const run = (template, rows, patch) => buildYidaStaticPlan({ config: generatedConfig(template, patch), rows }).rows
  const withDrawing = [{ field: 'drawing' }, { literal: '/' }, KEY_HASH]
  // A blank field part (absent, null, empty or blank text) is refused; literals never stand in for it.
  const absent = generatedRow()
  delete absent.drawingNo
  for (const blankRow of [absent, generatedRow({ drawingNo: null }), generatedRow({ drawingNo: '' }), generatedRow({ drawingNo: '   ' })]) {
    assert.deepEqual(run(withDrawing, [blankRow])[0].issues, [codeIssue(0, 'FIELD_PART_MISSING')])
  }
  // A blank nullable key (emptyKeyFields) inside the hash counts as '' -> the oracle with ''.
  const parentAbsent = generatedRow()
  delete parentAbsent.parentCode
  for (const blankParent of [parentAbsent, generatedRow({ parentCode: null }), generatedRow({ parentCode: '' })]) {
    const [planned] = run([KEY_HASH], [blankParent])
    assert.equal(planned.status, 'planned_create')
    assert.equal(planned.payload.code, oracleHash({ project: 'DEMO-P1', line: 'LINE-1', parent: '' }))
  }
  // ...but as a field part it is a blank part like any other.
  assert.deepEqual(run([{ field: 'parent' }, KEY_HASH], [generatedRow({ parentCode: null })])[0].issues, [codeIssue(0, 'FIELD_PART_MISSING')])
  // A blank required key is KEY_MISSING only: the generated entry (required) adds no issue of its own.
  for (const template of [[KEY_HASH], [{ field: 'line' }, KEY_HASH], [{ preset: 'material-code-v1', rowIdOf: 'drawing', projectOf: 'project' }]]) {
    const missingKey = template[0].preset ? generatedRow({ projectNo: null }) : generatedRow({ lineId: '  ' })
    assert.deepEqual(run(template, [missingKey])[0].issues.map((issue) => issue.code), ['KEY_MISSING'], JSON.stringify(template))
  }
  // A whitespace-only nullable key is KEY_MISSING too, and again only that.
  assert.deepEqual(run([KEY_HASH], [generatedRow({ parentCode: ' ' })])[0].issues.map((issue) => issue.code), ['KEY_MISSING'])
  // Types: a boolean is never stringified; identity text is verbatim, so padding, control characters and
  // lone surrogates are refused rather than normalized.
  assert.deepEqual(run(withDrawing, [generatedRow({ drawingNo: true })])[0].issues.filter((issue) => issue.fields[0].target === 'code'),
    [codeIssue(0, 'FIELD_TYPE')])
  for (const lineId of [' LINE-1', 'LINE-1 ', 'LINE\u00011', 'LINE-\uD800', 'LINE-\uDC00x']) {
    assert.deepEqual(run([KEY_HASH], [generatedRow({ lineId })])[0].issues, [codeIssue(0, 'FIELD_TYPE')], JSON.stringify(lineId))
    assert.deepEqual(run([{ preset: 'material-code-v1', rowIdOf: 'line', projectOf: 'project' }], [generatedRow({ lineId })])[0].issues,
      [codeIssue(0, 'FIELD_TYPE')], JSON.stringify(lineId))
  }
  // A field part keeps text verbatim (padding included) and writes numbers with String().
  assert.equal(run([{ field: 'drawing' }, { field: 'qty' }, KEY_HASH], [generatedRow({ drawingNo: ' D ', quantity: 1.25 })])[0].payload.code,
    ` D 1.25${oracleHash({ project: 'DEMO-P1', line: 'LINE-1', parent: 'PARENT-1' })}`)
  // Over 4096 characters is refused.
  assert.deepEqual(run(withDrawing, [generatedRow({ drawingNo: 'x'.repeat(4096) })])[0].issues, [codeIssue(0, 'FIELD_VALUE_TOO_LONG')])
  assert.equal(run(withDrawing, [generatedRow({ drawingNo: 'x'.repeat(4096 - 37) })])[0].payload.code.length, 4096)
  // Collision probe: with two nullable members, [A, '', B] and [A, B, ''] are different inputs and get different codes.
  const fourKeys = { businessKey: ['project', 'line', 'parent', 'drawing'], emptyKeyFields: ['parent', 'drawing'] }
  const probe = run([{ hash: ['project', 'parent', 'drawing', 'line'], form: 'uuid-36' }],
    [generatedRow({ parentCode: '', drawingNo: 'B' }), generatedRow({ parentCode: 'B', drawingNo: '' })], fourKeys)
  assert.deepEqual(probe.map((item) => item.status), ['planned_create', 'planned_create'])
  assert.notEqual(probe[0].payload.code, probe[1].payload.code)
  assert.deepEqual(probe.map((item) => item.payload.code), [oracleHash({ project: 'DEMO-P1', parent: '', drawing: 'B', line: 'LINE-1' }),
    oracleHash({ project: 'DEMO-P1', parent: 'B', drawing: '', line: 'LINE-1' })])
  // Ruling L1 (verifier r2 probe PA): two templates listing the same members in another order. Under a layout of values
  // in listed order, row X under one order and row Y under the other were the same name (one code, two tuples). With
  // (target, value) pairs the two orders give one code per tuple and two codes for the two tuples.
  const otherOrder = run([{ hash: ['project', 'drawing', 'parent', 'line'], form: 'uuid-36' }],
    [generatedRow({ parentCode: '', drawingNo: 'B' }), generatedRow({ parentCode: 'B', drawingNo: '' })], fourKeys)
  assert.deepEqual(otherOrder.map((item) => item.payload.code), probe.map((item) => item.payload.code))
  assert.notEqual(otherOrder[1].payload.code, probe[0].payload.code)
})

test('A4 generated batch duplicates: both rows refused, no payload, and the local draft refuses the batch', async () => {
  const { buildYidaStaticPlan } = await plannerPromise
  const { compileYidaLocalDraft } = await draftPromise
  // Preset on a non-key row id: two rows with different keys but one row id and project share a code.
  const preset = generatedConfig([{ preset: 'material-code-v1', rowIdOf: 'drawing', projectOf: 'project' }])
  const rows = [generatedRow({ lineId: 'LINE-1' }), generatedRow({ lineId: 'LINE-2', quantity: 9 }), generatedRow({ lineId: 'LINE-3', drawingNo: 'DRW-3' })]
  const plan = buildYidaStaticPlan({ config: preset, rows })
  assert.deepEqual(plan.rows.map((item) => item.status), ['invalid', 'invalid', 'planned_create'])
  assert.deepEqual(plan.rows[0].issues, [codeIssue(0, 'DUPLICATE_GENERATED_VALUE')])
  assert.deepEqual(plan.rows[1].issues, [codeIssue(1, 'DUPLICATE_GENERATED_VALUE')])
  for (const planned of plan.rows.slice(0, 2)) {
    assert.equal(Object.hasOwn(planned, 'payload'), false)
    assert.equal(Object.hasOwn(planned, 'protocolPreview'), false)
  }
  assert.equal(plan.evidence.invalid, 2)
  assert.equal(plan.evidence.duplicateKeyCount, 0)
  assert.throws(() => compileYidaLocalDraft({ config: preset, rowsText: JSON.stringify(rows), allocation: { mode: 'original' } }),
    (error) => error.code === 'YIDA_DRAFT_PLAN')
  assert.doesNotThrow(() => compileYidaLocalDraft({ config: preset, rowsText: JSON.stringify([rows[0], rows[2]]), allocation: { mode: 'original' } }))
  // Hash inputs identical, other columns different: the generated duplicate is reported on both rows.
  const hashed = buildYidaStaticPlan({ config: generatedConfig([KEY_HASH]), rows: [generatedRow(), generatedRow({ quantity: 7, drawingNo: 'DRW-9' })] })
  assert.equal(hashed.evidence.invalid, 2)
  for (const planned of hashed.rows) assert.ok(planned.issues.some((issue) => issue.code === 'DUPLICATE_GENERATED_VALUE'))
})

test('A6 generated re-push stability: same input same bytes; a template edit moves the payload, never the key', async () => {
  const { compileYidaLocalDraft } = await draftPromise
  const rows = JSON.stringify([generatedRow(), generatedRow({ lineId: 'LINE-2', parentCode: null })])
  const compile = (layout) => compileYidaLocalDraft({ config: layout, rowsText: rows, allocation: { mode: 'original' } })
  const first = compile(generatedConfig())
  const again = compile(generatedConfig())
  assert.equal(again.planDigest, first.planDigest)
  assert.deepEqual(again.rowSpecs, first.rowSpecs)
  assert.deepEqual(again.plan.rows.map((item) => item.payload.code), first.plan.rows.map((item) => item.payload.code))
  assert.deepEqual(first.plan.rows.map((item) => item.payload.code),
    [`PRJ-DEMO-P1-${oracleHash({ project: 'DEMO-P1', line: 'LINE-1', parent: 'PARENT-1' })}`, `PRJ-DEMO-P1-${oracleHash({ project: 'DEMO-P1', line: 'LINE-2', parent: '' })}`])
  // An unrelated constant: the plan moves, the generated bytes and the business keys do not.
  const constant = generatedConfig()
  constant.fieldMap = constant.fieldMap.map((entry) => entry.target === 'note' ? { ...entry, value: 'SYN-OTHER' } : entry)
  const changedConstant = compile(constant)
  assert.notEqual(changedConstant.planDigest, first.planDigest)
  assert.deepEqual(changedConstant.plan.rows.map((item) => item.payload.code), first.plan.rows.map((item) => item.payload.code))
  assert.deepEqual(changedConstant.rowSpecs.map((spec) => spec.businessKeyDigest), first.rowSpecs.map((spec) => spec.businessKeyDigest))
  // A template literal: payload and plan digests move, the business keys and key definition do not.
  const literal = compile(generatedConfig([{ literal: 'PRJ2-' }, { field: 'project' }, { literal: '-' }, KEY_HASH]))
  assert.notEqual(literal.planDigest, first.planDigest)
  assert.equal(literal.keyDefinitionDigest, first.keyDefinitionDigest)
  for (const [index, spec] of literal.rowSpecs.entries()) {
    assert.notEqual(spec.payloadDigest, first.rowSpecs[index].payloadDigest)
    assert.equal(spec.businessKeyDigest, first.rowSpecs[index].businessKeyDigest)
  }
})

test('generatedTemplateDependencies: the source columns one generated entry reads, and only for its own config', async () => {
  const { generatedTemplateDependencies, yidaTransformSourceColumns } = await plannerPromise
  const layout = generatedConfig([{ field: 'qty' }, { field: 'project' }, { hash: ['project', 'line', 'parent', 'drawing'], form: 'uuid-32' }])
  const entry = layout.fieldMap.at(-1)
  const columns = generatedTemplateDependencies(entry, layout)
  assert.equal(Object.isFrozen(columns), true)
  assert.deepEqual(columns, ['drawingNo', 'lineId', 'parentCode', 'projectNo', 'quantity'])
  const preset = generatedConfig([{ preset: 'material-code-v1', rowIdOf: 'drawing', projectOf: 'project' }])
  assert.deepEqual(generatedTemplateDependencies(preset.fieldMap.at(-1), preset), ['drawingNo', 'projectNo'])
  // Registered as the generated reader of the transform-column map (its columns are direct sources too).
  assert.ok(columns.every((column) => yidaTransformSourceColumns(layout).includes(column)))
  const code = (error) => error.code === 'YIDA_STATIC_CONFIG_INVALID'
  assert.throws(() => generatedTemplateDependencies(entry, generatedConfig()), code)
  assert.throws(() => generatedTemplateDependencies(layout.fieldMap[0], layout), code)
  assert.throws(() => generatedTemplateDependencies({ ...entry, target: 'drawing' }, layout), code)
  assert.throws(() => generatedTemplateDependencies(entry, { ...layout, version: 2 }), code)
  assert.throws(() => generatedTemplateDependencies(null, layout), code)
  assert.throws(() => generatedTemplateDependencies(entry, generatedConfig([{ hash: ['project'], form: 'uuid-32' }])), code)
})
