'use strict'

/* eslint-disable @typescript-eslint/no-var-requires -- This Node test is intentionally CommonJS and dynamically imports the browser ESM boundary. */
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const modulePath = path.join(__dirname, '..', 'lib', 'yida-rule-template.mjs')
const modules = Promise.all([
  import(pathToFileURL(modulePath).href),
  import(pathToFileURL(path.join(__dirname, '..', 'lib', 'yida-static-plan.mjs')).href),
  import(pathToFileURL(path.join(__dirname, '..', 'lib', 'stock-preparation-yida-allocation.mjs')).href),
])
const original = { mode: 'original' }
const clone = (value) => JSON.parse(JSON.stringify(value))
const withoutTarget = ({ target: _target, ...rules }) => rules
const newTarget = { appType: 'SYN_NEW_APP', formUuid: 'SYN_NEW_FORM' }

function code(kind) {
  return (error) => {
    assert.equal(error.name, 'YidaRuleTemplateError')
    assert.equal(error.code, `YIDA_RULE_TEMPLATE_${kind}`)
    assert.equal(error.message, error.code)
    assert.equal(Object.hasOwn(error, 'cause'), false)
    assert.deepEqual(Object.keys(error).sort(), ['code', 'name'])
    assert.doesNotMatch(error.stack, /synthetic-private|SYN_NEW_APP|SYN_NEW_FORM/)
    return true
  }
}

function assertFrozen(value) {
  if (value && typeof value === 'object') {
    assert.equal(Object.isFrozen(value), true)
    for (const entry of Object.values(value)) assertFrozen(entry)
  }
}

async function fixture(version = 2, variant = 'primary') {
  const [api, planner, allocation] = await modules
  const example = version === 1 ? planner.createYidaStaticExample(variant) : planner.createYidaProtocolExample(variant)
  return { ...api, ...planner, ...allocation, ...example, rules: withoutTarget(example.config) }
}

for (const version of [1, 2]) for (const variant of ['primary', 'renamed']) for (const intent of ['create', 'update']) {
  test(`v${version} ${variant} ${intent} roundtrip uses actual validator and rebuilt real planner`, async () => {
    const h = await fixture(version, variant)
    h.rules.intent = intent
    if (intent === 'update') {
      h.rules.instanceIdField = 'instanceRole'
      h.rows.forEach((row, index) => { row.instanceRole = `SYN_INSTANCE_${index}` })
    }
    const before = clone(h.rules)
    const text = h.exportYidaRuleTemplate({ rules: h.rules, allocation: original })
    // Inspect the exported bytes before the importer can reject a leaked field.
    const raw = JSON.parse(text)
    assert.deepEqual(Object.keys(raw).sort(), ['allocation', 'formatVersion', 'kind', 'rules', 'status'])
    assert.equal(raw.formatVersion, 1)
    assert.equal(raw.kind, 'stock-preparation-yida-rule-template')
    assert.equal(raw.status, 'local-unverified')
    assert.equal(Object.hasOwn(raw.rules, 'target'), false)
    assert.doesNotMatch(text, /LOCAL_SCHEMA_ONLY_APP|LOCAL_SCHEMA_ONLY_FORM/)
    assert.deepEqual(raw.rules, before)
    assert.deepEqual(raw.allocation, original)
    for (const section of [raw, raw.rules, raw.allocation]) {
      for (const field of ['rows', 'rowsText', 'projects', 'payload', 'data', 'accessToken', 'systemToken', 'appKey', 'appSecret', 'tenantId', 'ownerId', 'verified', 'canApply']) {
        assert.equal(Object.hasOwn(section, field), false)
      }
    }
    const result = h.parseYidaRuleTemplate(text)
    assert.deepEqual(Object.keys(result).sort(), ['allocation', 'formatVersion', 'kind', 'rules', 'status'])
    assert.equal(result.formatVersion, 1)
    assert.equal(result.kind, 'stock-preparation-yida-rule-template')
    assert.equal(result.status, 'local-unverified')
    assert.deepEqual(result.rules, before)
    assert.deepEqual(h.rules, before)
    assert.notEqual(result.rules, h.rules)
    assertFrozen(result)
    assert.equal(h.exportYidaRuleTemplate({ rules: result.rules, allocation: result.allocation }), text)
    assert.deepEqual(h.buildYidaStaticPlan({ config: { ...result.rules, target: newTarget }, rows: h.rows }),
      h.buildYidaStaticPlan({ config: { ...h.rules, target: newTarget }, rows: h.rows }))
  })
}

test('export accepts only explicit rules/allocation, while parse returns the complete frozen envelope', async () => {
  const h = await fixture()
  const text = h.exportYidaRuleTemplate({ rules: h.rules, allocation: original })
  const envelope = h.parseYidaRuleTemplate(text)
  assert.throws(() => h.exportYidaRuleTemplate(envelope), code('INPUT'))
  assert.equal(h.exportYidaRuleTemplate({ rules: envelope.rules, allocation: envelope.allocation }), text)
})

test('fresh targets/rows produce equivalent real plans, retaining every refusal safety flag', async () => {
  for (const version of [1, 2]) for (const variant of ['primary', 'renamed']) {
    const h = await fixture(version, variant)
    const roundtrip = h.parseYidaRuleTemplate(h.exportYidaRuleTemplate({ rules: h.rules, allocation: original }))
    const expected = h.buildYidaStaticPlan({ config: { ...h.rules, target: newTarget }, rows: h.rows })
    const actual = h.buildYidaStaticPlan({ config: { ...roundtrip.rules, target: newTarget }, rows: h.rows })
    assert.deepEqual(actual, expected)
    assert.equal(actual.canApply, false)
    assert.equal(actual.externalWriteAttempted, false)
    assert.equal(actual.tokenIssued, false)
    assert.equal(actual.lookupExecuted, false)
    assert.equal(actual.rows[0].remoteState, 'unverified')
  }
})

test('v1 repeated source mappings remain valid and preserve a single business key selection', async () => {
  const h = await fixture(1)
  h.rules.fieldMap.push({ ...h.rules.fieldMap[0], target: 'anotherProject' })
  const result = h.parseYidaRuleTemplate(h.exportYidaRuleTemplate({ rules: h.rules, allocation: original }))
  assert.deepEqual(result.rules, h.rules)
  assert.equal(result.rules.businessKey.filter((source) => source === h.rules.fieldMap[0].source).length, 1)
  const plan = h.buildYidaStaticPlan({ config: { ...result.rules, target: newTarget }, rows: h.rows })
  assert.equal(plan.evidence.invalid, 0)
  assert.equal(plan.rows[0].payload.anotherProject, plan.rows[0].payload.project)
})

test('v2 options retain multiline, Unicode, whitespace, quote and backslash bytes', async () => {
  const h = await fixture()
  const catalog = h.rules.fieldCatalog.find((entry) => entry.control === 'select')
  const options = ['first\nsecond', ' 雪😀 ', 'quote" and slash\\', 'line\r\nnext', 'constructor']
  catalog.options = options
  const source = h.rules.fieldMap.find((entry) => entry.target === catalog.id).source
  h.rows[0][source] = options[0]
  h.rows[1][source] = options[1]
  const parsed = h.parseYidaRuleTemplate(h.exportYidaRuleTemplate({ rules: h.rules, allocation: original }))
  assert.deepEqual(parsed.rules.fieldCatalog.find((entry) => entry.id === catalog.id).options, options)
  const plan = h.buildYidaStaticPlan({ config: { ...parsed.rules, target: newTarget }, rows: h.rows })
  assert.equal(plan.evidence.invalid, 0)
  assert.equal(plan.rows[0].payload[catalog.id], options[0])
  assert.equal(plan.rows[0].payload.parentCode, undefined)
})

test('maximum legal catalog larger than the old rows cap survives rule export/import', async () => {
  const h = await fixture()
  const options = Array.from({ length: 64 }, (_, index) => `v${String(index).padStart(3, '0')}${'x'.repeat(124)}`)
  const rules = { version: 2, kind: 'yida-form-protocol-static', intent: 'create', businessKey: ['s0'], emptyKeyFields: [],
    fieldCatalog: Array.from({ length: 32 }, (_, index) => ({ id: `f${index}`, control: 'select', required: false, options })),
    fieldMap: Array.from({ length: 32 }, (_, index) => ({ source: `s${index}`, target: `f${index}`, type: 'string', required: false })) }
  const text = h.exportYidaRuleTemplate({ rules, allocation: original })
  assert.ok(Buffer.byteLength(text, 'utf8') > 128 * 1024)
  assert.deepEqual(h.parseYidaRuleTemplate(text).rules, rules)
})

for (const mode of ['equal_integer', 'equal_decimal_exact']) {
  test(`shared ${mode} rule validation feeds real runtime allocation without storing project values`, async () => {
    const h = await fixture(2)
    const allocation = { mode, projectField: 'projectNo', quantityField: 'quantity' }
    assert.deepEqual(h.validateYidaProjectAllocationRules(h.config, allocation), allocation)
    const text = h.exportYidaRuleTemplate({ rules: h.rules, allocation })
    const restored = h.parseYidaRuleTemplate(text)
    assert.deepEqual(restored.allocation, allocation)
    assert.doesNotMatch(text, /LOCAL_SCHEMA_ONLY|synthetic_stock|projects|rows|appType|formUuid/)
    const rows = h.rows.map((row) => ({ ...row, quantity: 6 }))
    const preview = h.buildYidaProjectAllocationPreview({ config: { ...restored.rules, target: newTarget },
      rowsText: JSON.stringify(rows), allocation: { ...restored.allocation, projects: ['SYN_P1', 'SYN_P2'] } })
    assert.equal(preview.plan.evidence.invalid, 0)
    assert.equal(preview.plan.rows.length, 4)
    assert.equal(preview.analysis[0].perProjectQuantity, 3)
    assert.equal(preview.canApply, false)
    assert.equal(preview.externalWriteAttempted, false)
  })
}

test('shared allocation rules reject config/intent/mode/role/extra fields with actual errors', async () => {
  const h = await fixture()
  const good = { mode: 'equal_integer', projectField: 'projectNo', quantityField: 'quantity' }
  const check = (config, rules, expected) => assert.throws(() => h.validateYidaProjectAllocationRules(config, rules), (error) => error.code === expected)
  check({}, good, 'YIDA_ALLOCATION_CONFIG_INVALID')
  check({ ...h.config, intent: 'update', instanceIdField: 'instance' }, good, 'YIDA_ALLOCATION_INTENT_INVALID')
  for (const patch of [{ mode: 'original' }, { projects: [] }, { quantityField: undefined }]) {
    check(h.config, { ...good, ...patch }, patch.quantityField === undefined && Object.hasOwn(patch, 'quantityField') ? 'YIDA_ALLOCATION_FIELDS_INVALID' : 'YIDA_ALLOCATION_SETTINGS_INVALID')
  }
  check(h.config, { ...good, quantityField: 'projectNo' }, 'YIDA_ALLOCATION_FIELDS_INVALID')
  check({ ...h.config, businessKey: ['projectNo'], emptyKeyFields: [] }, good, 'YIDA_ALLOCATION_FIELDS_INVALID')
})

test('runtime preserves mode then projects then fields failure priority', async () => {
  const h = await fixture()
  const attempt = (allocation) => h.buildYidaProjectAllocationPreview({ config: h.config, rowsText: '[]', allocation })
  assert.throws(() => attempt({ mode: 'bad', projects: [], projectField: '', quantityField: '' }), (e) => e.code === 'YIDA_ALLOCATION_SETTINGS_INVALID')
  assert.throws(() => attempt({ mode: 'equal_integer', projects: [], projectField: '', quantityField: '' }), (e) => e.code === 'YIDA_ALLOCATION_PROJECTS_INVALID')
  assert.throws(() => attempt({ mode: 'equal_integer', projects: ['SYN_P1'], projectField: '', quantityField: '' }), (e) => e.code === 'YIDA_ALLOCATION_FIELDS_INVALID')
})

test('run parameters and authority declarations are rejected, never silently stripped', async () => {
  const h = await fixture()
  for (const key of ['target', 'rows', 'payload', 'instanceId', 'appKey', 'appSecret', 'token', 'credentialRef', 'tenantId', 'ownerId', 'url', 'approved']) {
    assert.throws(() => h.exportYidaRuleTemplate({ rules: { ...h.rules, [key]: 'synthetic-private' }, allocation: original }), code('CONFIG'))
  }
  for (const key of ['target', 'projects', 'rows', 'approved', 'canApply', 'token']) {
    assert.throws(() => h.exportYidaRuleTemplate({ rules: h.rules, allocation: original, [key]: 'synthetic-private' }), code('INPUT'))
    const envelope = JSON.parse(h.exportYidaRuleTemplate({ rules: h.rules, allocation: original }))
    envelope[key] = 'synthetic-private'
    assert.throws(() => h.parseYidaRuleTemplate(JSON.stringify(envelope)), code('INPUT'))
  }
  assert.throws(() => h.exportYidaRuleTemplate({ rules: h.rules, allocation: { mode: 'original', projects: [] } }), code('ALLOCATION'))
})

test('actual config and allocation validators reject domain-invalid templates', async () => {
  const h = await fixture()
  for (const patch of [{ version: 2, businessKey: ['unmapped'] }, { fieldCatalog: [] }, { emptyKeyFields: ['quantity'] },
    { fieldMap: h.rules.fieldMap.map((entry, index) => index ? entry : { ...entry, type: 'number' }) }]) {
    assert.throws(() => h.exportYidaRuleTemplate({ rules: { ...h.rules, ...patch }, allocation: original }), code('CONFIG'))
  }
  assert.throws(() => h.exportYidaRuleTemplate({ rules: h.rules, allocation: { mode: 'equal_integer', projectField: 'quantity', quantityField: 'projectNo' } }), code('ALLOCATION'))
  assert.throws(() => h.exportYidaRuleTemplate({ rules: { ...h.rules, intent: 'update', instanceIdField: 'instance' }, allocation: { mode: 'equal_integer', projectField: 'projectNo', quantityField: 'quantity' } }), code('ALLOCATION'))
})

test('JSON rejects duplicate/escaped duplicate keys and dangerous prototype properties', async () => {
  const h = await fixture()
  const text = h.exportYidaRuleTemplate({ rules: h.rules, allocation: original })
  for (const raw of [text.replace('"formatVersion": 1', '"formatVersion": 1,"formatVersion":1'),
    text.replace('"formatVersion": 1', '"formatVersion": 1,"format\\u0056ersion":1'),
    text.replace('"source": "projectNo"', '"source":"projectNo","\\u0073ource":"projectNo"'),
    text.replace('"mode": "original"', '"mode":"original","__proto__":{}'),
    text.replace('"mode": "original"', '"mode":"original","constructor":{}'),
  ]) assert.throws(() => h.parseYidaRuleTemplate(raw), code('TEXT'))
})

for (const literal of ['1.0', '1e0', '1.0000000000000001', '-0', '0', '3', '01', 'Infinity', 'NaN', '""']) {
  test(`numeric version spelling ${literal} is not silently normalized`, async () => {
    const h = await fixture()
    const text = h.exportYidaRuleTemplate({ rules: h.rules, allocation: original })
    assert.throws(() => h.parseYidaRuleTemplate(text.replace('"formatVersion": 1', `"formatVersion": ${literal}`)), code(literal === '""' ? 'INPUT' : 'TEXT'))
    assert.throws(() => h.parseYidaRuleTemplate(text.replace('"version": 2', `"version": ${literal}`)), code(literal === '""' ? 'CONFIG' : 'TEXT'))
  })
}

test('text grammar is strict, with fixed errors and no raw document echo', async () => {
  const h = await fixture()
  for (const text of [null, undefined, '', 'synthetic-private', '/*private*/{}', '{"a":true,}', '[1,]', '\uFEFF{}', '{"a":"\\x00"}', '{"a":"\n"}', '{} trailing']) {
    assert.throws(() => h.parseYidaRuleTemplate(text), code('TEXT'))
  }
  assert.throws(() => h.parseYidaRuleTemplate('{}'), code('INPUT'))
})

test('object API rejects getters, symbols, sparse arrays, exotic prototypes and cycles without reading getters', async () => {
  const h = await fixture()
  let read = 0
  const good = () => ({ rules: clone(h.rules), allocation: { mode: 'original' } })
  const getter = good(); Object.defineProperty(getter.rules, 'intent', { enumerable: true, get() { read++; throw new Error('synthetic-private') } })
  const symbol = good(); symbol.rules[Symbol('private')] = true
  const hidden = good(); Object.defineProperty(hidden.rules, 'hidden', { value: true })
  const sparse = good(); sparse.rules.fieldMap = Array(2)
  const extra = good(); extra.rules.fieldMap.extra = true
  const exotic = good(); exotic.rules = Object.assign(Object.create({ parent: true }), exotic.rules)
  const cycle = good(); cycle.rules.extra = cycle
  const badNumber = good(); badNumber.rules.version = -0
  for (const value of [undefined, null, [], getter, symbol, hidden, sparse, extra, exotic, cycle, badNumber,
    { rules: new Date(), allocation: original }, { rules: () => {}, allocation: original }]) {
    assert.throws(() => h.exportYidaRuleTemplate(value), code('INPUT'))
  }
  assert.equal(read, 0)
})

test('2MiB UTF8, depth and total-node budgets bound text and object APIs', async () => {
  const h = await fixture()
  const max = 2 * 1024 * 1024
  const text = h.exportYidaRuleTemplate({ rules: h.rules, allocation: original })
  const padded = text + ' '.repeat(max - Buffer.byteLength(text))
  assert.equal(Buffer.byteLength(padded), max)
  assert.deepEqual(h.parseYidaRuleTemplate(padded).rules, h.rules)
  assert.throws(() => h.parseYidaRuleTemplate(padded + ' '), code('LIMIT'))
  assert.throws(() => h.parseYidaRuleTemplate('雪'.repeat(max / 2)), code('LIMIT'))
  assert.throws(() => h.parseYidaRuleTemplate('['.repeat(11) + 'null' + ']'.repeat(11)), code('LIMIT'))
  assert.throws(() => h.parseYidaRuleTemplate('[' + Array(4096).fill('null').join(',') + ']'), code('LIMIT'))
  assert.throws(() => h.exportYidaRuleTemplate({ rules: h.rules, allocation: original, extra: Array(4096).fill(null) }), code('LIMIT'))
  assert.throws(() => h.exportYidaRuleTemplate({ rules: h.rules, allocation: original, extra: 'x'.repeat(max) }), code('LIMIT'))
})

test('core modules stay browser-capable and introduce no I/O or runtime dependencies', async () => {
  const source = fs.readFileSync(modulePath, 'utf8')
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((match) => match[1])
  assert.deepEqual(imports, ['./yida-static-plan.mjs', './stock-preparation-yida-allocation.mjs'])
  assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|WebSocket|localStorage|indexedDB|process|Buffer|require)\s*[.(]/)
})
