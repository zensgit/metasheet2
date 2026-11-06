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
  const { compileYidaSendDraft } = await persistedPromise
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
  const after = compileYidaSendDraft({ config: { ...v3.rules, target }, rowsText, allocation })
  assert.equal(after.keyDefinition.fields.length, 7)
  assert.deepEqual(after.keyDefinition, before.keyDefinition)
  assert.equal(after.keyDefinitionDigest, before.keyDefinitionDigest)
  assert.deepEqual(after.rowSpecs.map((spec) => spec.businessKeyDigest), before.rowSpecs.map((spec) => spec.businessKeyDigest))
  assert.notEqual(after.planDigest, before.planDigest)
})
