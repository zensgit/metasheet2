'use strict'

// Pure, synthetic, standalone node battery. No DB, source read, host registry,
// records API or deployment proof: those remain caller prerequisites.
const assert = require('node:assert/strict')
const {
  deriveAutomationReadTargetContract: derive,
  StockPreparationAutomationTargetContractError,
} = require('../lib/stock-preparation-automation-target-contract.cjs')
const { assertStockPreparationTargetReady } = require('../lib/stock-preparation-table-actions.cjs')
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require('../lib/stock-preparation-templates.cjs')
const { normalizeCustomerPack } = require('../lib/stock-preparation-customer-pack.cjs')
const { FACTORY_A_REHEARSAL_PACK } = require('../lib/customer-packs/factory-a.rehearsal.cjs')
const { __internals: { buildExtensionFieldProperty } } = require('../lib/stock-preparation-customer-pack-installer.cjs')
const { derivePackAwarePlmWritableFields } = require('../lib/stock-preparation-conflict-planner.cjs')
const { normalizeExtFieldMapping, isNormalizedExtFieldMapping } = require('../lib/stock-preparation-ext-field-mapping.cjs')

const copy = value => JSON.parse(JSON.stringify(value)) // Only our trusted, JSON fixture literals.
const pack = normalizeCustomerPack(FACTORY_A_REHEARSAL_PACK)
const template = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE
const installed = pack.extensionFields.map(field => ({ fieldId: field.id, property: buildExtensionFieldProperty(field, pack) }))
const plmId = pack.extensionFields.find(field => field.ownership === 'plm_system' && field.type === 'string').id
const humanId = pack.extensionFields.find(field => field.ownership === 'human_preserved').id
let passed = 0
function test(_name, fn) { fn(); passed += 1 }
function fixture() {
  return {
    action: { source: { externalSystemId: 'synthetic-source' }, target: { sheetId: 'synthetic-sheet', fieldIdMap: {} } },
    installedFieldProperties: [],
    extFieldMapping: null,
  }
}
function packFixture() {
  const input = fixture()
  input.installedFieldProperties = copy(installed)
  return input
}
function mappingFor(packInput = FACTORY_A_REHEARSAL_PACK, options = {}) {
  return normalizeExtFieldMapping({
    mappingId: 'synthetic-mapping', mappingVersion: 1,
    mappings: [{ sourceColumn: 'SyntheticColumn', target: plmId }], ...options,
  }, { pack: packInput })
}
function mappingFixture(mapping = mappingFor()) {
  const input = packFixture()
  input.action.extensionFieldIds = [...mapping.targetFieldIds]
  input.extFieldMapping = mapping
  return input
}
function physical(input, prefix = 'physical_') {
  const fields = derive(input).projection.logicalFieldIds
  input.action.target.fieldIdMap = Object.fromEntries(fields.map((id, index) => [id, `${prefix}${index}`]))
  return input
}
function rejected(input) {
  assert.throws(() => derive(input), error => {
    assert.ok(error instanceof StockPreparationAutomationTargetContractError)
    assert.equal(error.name, 'StockPreparationAutomationTargetContractError')
    assert.equal(error.code, 'AUTOMATION_TARGET_CONTRACT_INVALID')
    assert.equal(error.message, 'AUTOMATION_TARGET_CONTRACT_INVALID')
    assert.equal(Object.hasOwn(error, 'cause'), false)
    assert.equal(Object.hasOwn(error, 'details'), false)
    assert.equal(String(error).includes('synthetic-sensitive'), false)
    return true
  })
}
function recursivelyFrozen(value) {
  if (value && typeof value === 'object') {
    assert.equal(Object.isFrozen(value), true)
    Object.values(value).forEach(recursivelyFrozen)
  }
}

test('actual normalizer, whole template, exact empty identity and immutable output', () => {
  const input = fixture()
  const output = derive(input)
  assert.deepEqual(output.action, copy(assertStockPreparationTargetReady(input.action)))
  assert.deepEqual(output.projection.logicalFieldIds, template.fields.map(field => field.id).sort())
  assert.deepEqual(output.projection.fieldIds, output.projection.logicalFieldIds)
  assert.equal(output.projection.projectFieldId, 'projectNo')
  assert.equal(output.projection.activeFieldId, 'active')
  assert.ok(output.projection.logicalFieldIds.includes('notes'))
  assert.deepEqual(Object.keys(output).sort(), ['action', 'executionKey', 'extFieldMapping', 'installedFieldProperties', 'projection'])
  assert.match(output.executionKey, /^[a-f0-9]{64}$/u)
  recursivelyFrozen(output)
  assert.equal(Object.isFrozen(input), false)
})
test('normalizer-emitted optional undefined fields can be re-submitted', () => {
  const input = fixture()
  const first = derive(input)
  input.action = assertStockPreparationTargetReady(input.action)
  assert.equal(input.action.pageLimit, undefined)
  assert.equal(derive(input).executionKey, first.executionKey)
})
test('projection derives every normalized template field, not a frozen count', () => {
  const input = fixture()
  input.action.template = copy(template)
  input.action.template.fields.push({ id: 'syntheticHuman', label: 'Synthetic human', type: 'string', ownership: 'human_preserved' })
  assert.ok(derive(input).projection.logicalFieldIds.includes('syntheticHuman'))
})
test('actual factory pack supplies both shared-classification bands', () => {
  const input = packFixture()
  const classification = derivePackAwarePlmWritableFields({ templateFields: template.fields, installedFieldProperties: installed })
  assert.ok(classification.packPlmWritableFieldIds.includes(plmId))
  assert.ok(classification.packHumanPreservedFieldIds.includes(humanId))
  assert.deepEqual(derive(input).projection.logicalFieldIds, [...new Set([
    ...template.fields.map(field => field.id), ...classification.packPlmWritableFieldIds, ...classification.packHumanPreservedFieldIds,
  ])].sort())
})
test('all declared extensions participate even if no mapping fills them', () => {
  const input = fixture()
  input.action.extensionFieldIds = [plmId]
  assert.ok(derive(input).projection.logicalFieldIds.includes(plmId))
})
test('template-governed metadata is not reclassified as pack ownership', () => {
  const input = fixture()
  input.installedFieldProperties = [{ fieldId: 'notes', property: {} }]
  assert.ok(derive(input).projection.logicalFieldIds.includes('notes'))
})
test('complete maps bind full human and pack projection under two layouts', () => {
  for (const prefix of ['layout_a_', 'layout_b_']) {
    const input = physical(packFixture(), prefix)
    const output = derive(input)
    assert.deepEqual(output.projection.fieldIds, Object.values(input.action.target.fieldIdMap).sort())
    assert.equal(output.projection.projectFieldId, input.action.target.fieldIdMap.projectNo)
    assert.equal(output.projection.activeFieldId, input.action.target.fieldIdMap.active)
    assert.notEqual(output.projection.projectFieldId, output.projection.activeFieldId)
  }
})
test('ordinary target-ready accepts an omitted human binding, strict contract refuses', () => {
  const input = physical(fixture())
  delete input.action.target.fieldIdMap.notes
  assertStockPreparationTargetReady(input.action)
  rejected(input)
})
test('installed pack human binding cannot be omitted', () => {
  const input = physical(packFixture())
  delete input.action.target.fieldIdMap[humanId]
  rejected(input)
})
test('unused globally unique map entries are retained and hashed', () => {
  const input = physical(fixture())
  const initial = derive(input)
  input.action.target.fieldIdMap.syntheticUnused = 'physical_unused'
  const changed = derive(input)
  assert.deepEqual(changed.projection, initial.projection)
  assert.equal(changed.action.target.fieldIdMap.syntheticUnused, 'physical_unused')
  assert.notEqual(changed.executionKey, initial.executionKey)
})
for (const mutate of [
  input => { input.action.target.fieldIdMap.notes = input.action.target.fieldIdMap.active },
  input => { input.action.target.fieldIdMap.syntheticUnused = input.action.target.fieldIdMap.projectNo },
  input => { input.action.target.fieldIdMap.syntheticUnused = 'same'; input.action.target.fieldIdMap.syntheticOther = 'same' },
  input => { delete input.action.target.fieldIdMap.notes; input.action.target.fieldIdMap.syntheticUnused = 'notes' },
]) test('duplicate physical or identity-fallback collision rejects', () => { const input = physical(fixture()); mutate(input); rejected(input) })

for (const bad of [undefined, null, [], '', 1, true]) test('missing or malformed map never enables identity', () => {
  const input = fixture()
  if (bad === undefined) delete input.action.target.fieldIdMap
  else input.action.target.fieldIdMap = bad
  rejected(input)
})
for (const [logical, physicalId] of [
  ['syntheticUnused', ''], ['syntheticUnused', null], ['syntheticUnused', 7], ['syntheticUnused', false],
  [' syntheticUnused', 'physical_unused'], ['syntheticUnused ', 'physical_unused'], ['syntheticUnused', ' physical_unused'],
  ['syntheticUnused', 'physical_unused '], ['', 'physical_unused'], ['synthetic\u0000Unused', 'physical_unused'],
  ['syntheticUnused', 'physical\nunused'], ['x'.repeat(256), 'physical_unused'], ['syntheticUnused', 'x'.repeat(256)],
]) test('raw mapping validation precedes lossy normalizer', () => {
  const input = physical(fixture())
  input.action.target.fieldIdMap[logical] = physicalId
  rejected(input)
})
test('trim collision cannot be erased by the ordinary map normalizer', () => {
  const input = physical(fixture())
  input.action.target.fieldIdMap[' projectNo '] = 'physical_extra'
  rejected(input)
})
for (const unsafe of [...Object.getOwnPropertyNames(Object.prototype), 'prototype']) {
  test('prototype logical key refuses before legacy inverse mapping', () => {
    const input = physical(fixture())
    Object.defineProperty(input.action.target.fieldIdMap, unsafe, { value: 'physical_extra', enumerable: true })
    rejected(input)
  })
  test('prototype physical key refuses before legacy inverse mapping', () => {
    const input = physical(fixture())
    input.action.target.fieldIdMap.syntheticUnused = unsafe
    rejected(input)
  })
}
for (const field of ['action', 'installedFieldProperties', 'extFieldMapping']) test('exact input requires each material source', () => {
  const input = fixture(); delete input[field]; rejected(input)
})
test('exact input accepts no host capability or extra proof substitute', () => {
  const input = fixture(); input.permissionProof = true; rejected(input)
})
for (const bad of [null, undefined, {}, 'synthetic-sensitive', 1]) test('installed metadata must be explicit array', () => {
  const input = fixture(); input.installedFieldProperties = bad; rejected(input)
})
for (const bad of [
  null, [], {}, { fieldId: plmId }, { id: plmId, property: {} }, { fieldId: plmId, property: null },
  { fieldId: plmId, property: [] }, { fieldId: plmId, property: '{}' }, { fieldId: '', property: {} },
  { fieldId: ` ${plmId}`, property: {} }, { fieldId: 'otherColumn', property: {} },
  { fieldId: plmId, property: {}, logicalId: humanId },
]) test('strict installed entries reject invalid or ambiguous shape', () => {
  const input = fixture(); input.installedFieldProperties = [bad]; rejected(input)
})
test('duplicate installed entries reject instead of first/last-wins', () => {
  const input = packFixture(); input.installedFieldProperties.push(copy(input.installedFieldProperties[0])); rejected(input)
})
for (const property of [
  {}, { stockPreparation: null }, { stockPreparation: [] }, { stockPreparation: 'synthetic-sensitive' },
  { stockPreparation: { ownership: 'unknown', extension: true } },
  { stockPreparation: { ownership: 'plm_system' } },
  { stockPreparation: { extension: true } },
]) test('unclassified or malformed pack metadata fails closed', () => {
  const input = fixture(); input.installedFieldProperties = [{ fieldId: plmId, property }]; rejected(input)
})
test('shared preserve-on-refresh pin outranks PLM ownership', () => {
  const input = packFixture()
  input.installedFieldProperties.find(entry => entry.fieldId === plmId).property.stockPreparation.preserveOnRefresh = true
  const classified = derivePackAwarePlmWritableFields({ templateFields: template.fields, installedFieldProperties: input.installedFieldProperties })
  assert.ok(classified.packHumanPreservedFieldIds.includes(plmId))
  assert.ok(derive(input).projection.logicalFieldIds.includes(plmId))
  input.action.extensionFieldIds = [plmId]
  input.extFieldMapping = mappingFor()
  rejected(input)
})
test('branded actual mapping is retained completely, detached and still branded', () => {
  const input = mappingFixture()
  const output = derive(input)
  assert.equal(isNormalizedExtFieldMapping(output.extFieldMapping), true)
  assert.notEqual(output.extFieldMapping, input.extFieldMapping)
  assert.notEqual(output.extFieldMapping.mappings, input.extFieldMapping.mappings)
  assert.deepEqual(copy(output.extFieldMapping), copy(input.extFieldMapping))
  recursivelyFrozen(output)
})
for (const raw of [undefined, {}, { mappings: [] }, copy(mappingFor()), Object.freeze(copy(mappingFor()))]) {
  test('raw or lookalike mapping is not promoted to branded mapping', () => { const input = mappingFixture(); input.extFieldMapping = raw; rejected(input) })
}
test('mapping must agree with actual action extension declaration', () => {
  const input = mappingFixture(); delete input.action.extensionFieldIds; rejected(input)
})
test('mapping cannot rely on missing installed ownership metadata', () => {
  const input = mappingFixture(); input.installedFieldProperties = []; rejected(input)
})
test('mapping target must be present even among otherwise valid installed metadata', () => {
  const input = mappingFixture(); input.installedFieldProperties = input.installedFieldProperties.filter(entry => entry.fieldId !== plmId); rejected(input)
})
test('mapping cannot fill a live human-owned field', () => {
  const input = mappingFixture()
  input.installedFieldProperties.find(entry => entry.fieldId === plmId).property.stockPreparation.ownership = 'human_preserved'
  rejected(input)
})
test('mapping target object must match action target exactly', () => {
  const input = mappingFixture(); input.action.target.objectId = 'plm_stock_preparation_sandbox_synthetic'; rejected(input)
})
test('actual sandbox pack normalization and matching action remain supported', () => {
  const sandboxPack = { ...copy(FACTORY_A_REHEARSAL_PACK), targetObjectId: 'plm_stock_preparation_sandbox_synthetic' }
  const input = mappingFixture(mappingFor(sandboxPack))
  input.action.target.objectId = sandboxPack.targetObjectId
  assert.equal(derive(input).extFieldMapping.targetObjectId, sandboxPack.targetObjectId)
})

test('hash is independent of plain-object property insertion order', () => {
  const input = fixture()
  const reversed = { extFieldMapping: null, installedFieldProperties: [], action: { target: input.action.target, source: input.action.source } }
  assert.equal(derive(input).executionKey, derive(reversed).executionKey)
})
for (const mutate of [
  input => { input.action.carryPolicy = { carryKey: 'component_source_id', manualRowReattach: 'none' } },
  input => { input.action.conflictStrategy = { syntheticPolicy: 'hold' } },
  input => { input.action.maxRows = 17 },
  input => { input.action.source.workspaceId = 'synthetic-workspace' },
  input => { input.action.label = 'Synthetic changed label' },
  input => { input.installedFieldProperties[0].property.syntheticNested = { retained: ['changed'] } },
  input => { input.installedFieldProperties.find(entry => entry.fieldId === plmId).property.stockPreparation.ownership = 'human_preserved' },
  input => { input.installedFieldProperties[0].property.stockPreparation.packVersion += 1 },
]) test('complete normalized action and installed properties change content key', () => {
  const input = packFixture(); const before = derive(input).executionKey; mutate(input); assert.notEqual(derive(input).executionKey, before)
})
for (const options of [
  { mappingVersion: 2 }, { label: 'Synthetic changed mapping' },
  { mappings: [{ sourceColumn: 'OtherSyntheticColumn', target: plmId }] },
]) test('full mapping material participates in content key', () => {
  assert.notEqual(derive(mappingFixture()).executionKey, derive(mappingFixture(mappingFor(FACTORY_A_REHEARSAL_PACK, options))).executionKey)
})
test('mapping pack provenance participates in content key', () => {
  const changed = { ...copy(FACTORY_A_REHEARSAL_PACK), packVersion: FACTORY_A_REHEARSAL_PACK.packVersion + 1 }
  assert.notEqual(derive(mappingFixture()).executionKey, derive(mappingFixture(mappingFor(changed))).executionKey)
})
test('mapping coercion is hashed even when required field ids do not change', () => {
  const changed = copy(FACTORY_A_REHEARSAL_PACK)
  changed.extensionFields.find(field => field.id === plmId).type = 'number'
  const first = derive(mappingFixture())
  const second = derive(mappingFixture(mappingFor(changed)))
  assert.deepEqual(first.projection, second.projection)
  assert.notEqual(first.extFieldMapping.mappings[0].coerce, second.extFieldMapping.mappings[0].coerce)
  assert.notEqual(first.executionKey, second.executionKey)
})
test('mapping select option vocabulary is hashed, not reduced to mapping summary', () => {
  const changed = copy(FACTORY_A_REHEARSAL_PACK)
  changed.extensionFields.find(field => field.id === plmId).type = 'select'
  changed.optionSets.push({ fieldId: plmId, options: [{ value: 'synthetic-option-a' }] })
  const first = derive(mappingFixture(mappingFor(changed)))
  changed.optionSets.at(-1).options.push({ value: 'synthetic-option-b' })
  const second = derive(mappingFixture(mappingFor(changed)))
  assert.deepEqual(first.extFieldMapping.mappings, second.extFieldMapping.mappings)
  assert.notDeepEqual(first.extFieldMapping.optionValuesByTarget, second.extFieldMapping.optionValuesByTarget)
  assert.notEqual(first.executionKey, second.executionKey)
})
test('late mutations cannot alter any derived material or hash', () => {
  const input = physical(packFixture())
  input.action.conflictStrategy = { nested: { array: ['synthetic-original'] } }
  input.installedFieldProperties[0].property.nested = { array: ['synthetic-original'] }
  const output = derive(input)
  const before = copy(output)
  input.action.target.fieldIdMap.notes = 'mutated_physical'
  input.action.conflictStrategy.nested.array[0] = 'changed'
  input.installedFieldProperties[0].property.nested.array.push('changed')
  input.installedFieldProperties.length = 0
  assert.deepEqual(copy(output), before)
  assert.throws(() => { output.action.conflictStrategy.nested.array[0] = 'changed' }, TypeError)
  assert.throws(() => { output.projection.fieldIds.push('changed') }, TypeError)
  assert.throws(() => { output.installedFieldProperties[0].property.nested.array.push('changed') }, TypeError)
})

for (const bad of [undefined, () => 'synthetic-sensitive', NaN, Infinity, -Infinity, 1n, Symbol('synthetic-sensitive'), new Date(0), new Map(), new Set()]) {
  test('material JSON never silently discards non-JSON values', () => {
    const input = fixture(); input.action.conflictStrategy = { nested: { bad } }; rejected(input)
  })
  test('installed property uses the same strict JSON boundary', () => {
    const input = packFixture(); input.installedFieldProperties[0].property.extra = bad; rejected(input)
  })
}
test('raw optional path spelling cannot disguise undefined JSON material', () => {
  const input = fixture(); input.action['source/workspaceId'] = undefined; rejected(input)
})
test('nested optional names are not treated as normalizer undefined fields', () => {
  const input = fixture(); input.action.conflictStrategy = { maxRows: undefined }; rejected(input)
})
test('cycles fail closed without serializing them', () => {
  const input = fixture(); input.action.conflictStrategy = {}; input.action.conflictStrategy.self = input.action.conflictStrategy; rejected(input)
})
test('sparse arrays and arrays with extra properties are not JSON material', () => {
  for (const value of [new Array(1), Object.assign([], { extra: true })]) {
    const input = fixture(); input.action.conflictStrategy = { value }; rejected(input)
  }
})
test('non-enumerable and symbol material is not silently omitted', () => {
  for (const key of ['synthetic', Symbol('synthetic')]) {
    const input = fixture(); Object.defineProperty(input.action, key, { value: true }); rejected(input)
  }
})
test('custom object prototype is rejected without invoking hooks', () => {
  const input = fixture(); input.action.conflictStrategy = Object.create({ toJSON() { assert.fail('hook executed') } }); rejected(input)
})
test('toJSON callable is rejected rather than invoked', () => {
  let calls = 0
  const input = fixture(); input.action.conflictStrategy = { toJSON() { calls += 1; return {} } }; rejected(input)
  assert.equal(calls, 0)
})
for (const select of [input => input, input => input.action, input => input.action.target.fieldIdMap, input => input.installedFieldProperties[0].property]) {
  test('accessors are rejected before reading them', () => {
    let calls = 0
    const input = packFixture()
    const object = select(input)
    const key = object === input ? 'action' : 'synthetic'
    Object.defineProperty(object, key, { enumerable: true, get() { calls += 1; throw new Error('synthetic-sensitive') } })
    rejected(input)
    assert.equal(calls, 0)
  })
}
test('array index accessor is rejected without invocation', () => {
  let calls = 0
  const input = fixture()
  Object.defineProperty(input.installedFieldProperties, '0', { enumerable: true, get() { calls += 1; return {} } })
  rejected(input)
  assert.equal(calls, 0)
})
test('fake branding accessor is never consulted', () => {
  let calls = 0
  const real = mappingFor()
  const fake = copy(real)
  Object.defineProperty(fake, Object.getOwnPropertySymbols(real)[0], { get() { calls += 1; return true } })
  const input = mappingFixture(); input.extFieldMapping = Object.freeze(fake); rejected(input)
  assert.equal(calls, 0)
})
test('actual normalizer diagnostics are replaced by fixed values-free errors', () => {
  const input = fixture(); input.action.actionId = 'synthetic-sensitive'; rejected(input)
})
test('successful derivation performs no runtime IO or dynamic host loading', () => {
  // Modules and the real factory normalizers are loaded before this synchronous
  // sentinel. Any newly introduced require, fetch, filesystem, network or spawn
  // attempt in the derive call fails; the sentinel restores everything in finally.
  const Module = require('node:module')
  const surfaces = [
    [Module, '_load'], [globalThis, 'fetch'],
    [require('node:fs'), 'readFileSync'], [require('node:fs'), 'writeFileSync'],
    [require('node:net'), 'connect'], [require('node:http'), 'request'], [require('node:https'), 'request'],
    [require('node:child_process'), 'spawn'],
  ]
  const originals = surfaces.map(([object, key]) => object[key])
  let calls = 0
  const input = mappingFixture()
  try {
    for (const [object, key] of surfaces) object[key] = () => { calls += 1; throw new Error('unexpected runtime IO') }
    assert.ok(derive(input).executionKey)
    assert.equal(calls, 0)
  } finally {
    surfaces.forEach(([object, key], index) => { object[key] = originals[index] })
  }
})

process.stdout.write(`automation-target-contract: ${passed} passed\n`)
