'use strict'

// Standalone synthetic unit battery; root invokes this only through its sanitized
// wrapper. Actual plugin factories, no source/DB/host activation/permission proof.
const assert = require('node:assert/strict')
const {
  prepareStockPreparationAutomationProfiles: prepare,
  restoreStockPreparationAutomationProfileMaterial: restore,
  composeStockPreparationAutomationExecution: compose,
  StockPreparationAutomationProfileError,
} = require('../lib/stock-preparation-automation-profile.cjs')
const { assertStockPreparationTargetReady, PLM_STOCK_PREPARATION_ACTION_ID } = require('../lib/stock-preparation-table-actions.cjs')
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require('../lib/stock-preparation-templates.cjs')
const { createCustomerPackCatalog } = require('../lib/stock-preparation-customer-pack-catalog.cjs')
const { createConfiguredExtFieldMapping } = require('../lib/stock-preparation-ext-field-mapping-config.cjs')
const { isNormalizedExtFieldMapping } = require('../lib/stock-preparation-ext-field-mapping.cjs')
const { FACTORY_A_SAMPLE_PACK } = require('../lib/customer-packs/factory-a.sample.cjs')
const { __internals: { buildExtensionFieldProperty } } = require('../lib/stock-preparation-customer-pack-installer.cjs')
const { deriveAutomationReadTargetContract } = require('../lib/stock-preparation-automation-target-contract.cjs')

const copy = value => JSON.parse(JSON.stringify(value)) // Our JSON fixture literals only.
let passed = 0
function test(_name, fn) { fn(); passed += 1 }
function descriptor(overrides = {}) {
  return { tenantId: 'synthetic-tenant', workspaceId: null, projectId: 'arbitrary-project',
    actionId: PLM_STOCK_PREPARATION_ACTION_ID, ...overrides }
}
function fixture() {
  return { config: {
    stockPreparationAutomationProfiles: [descriptor()],
    stockPreparationTableActions: [{ actionId: PLM_STOCK_PREPARATION_ACTION_ID,
      source: { externalSystemId: 'synthetic-deployment-default' },
      target: { sheetId: 'arbitrary-sheet', fieldIdMap: {} } }],
  } }
}
const action = input => input.config.stockPreparationTableActions[0]
function packFixture() {
  const input = fixture()
  input.config.stockPreparationCustomerPacks = { [FACTORY_A_SAMPLE_PACK.packId]: copy(FACTORY_A_SAMPLE_PACK) }
  input.config.stockPreparationExtFieldMapping = {
    packId: FACTORY_A_SAMPLE_PACK.packId, mappingId: 'synthetic-map', mappingVersion: 1,
    mappings: [{ sourceColumn: 'SyntheticColumn', target: 'ext_legacyRowId' },
      { sourceColumn: 'SyntheticStandard', target: 'ext_standard' }],
  }
  action(input).extensionFieldIds = ['ext_legacyRowId', 'ext_standard']
  return input
}
function physical(input, prefix) {
  const fields = [...STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map(field => field.id),
    ...(input.config.stockPreparationCustomerPacks ? FACTORY_A_SAMPLE_PACK.extensionFields.map(field => field.id) : [])]
  action(input).target.fieldIdMap = Object.fromEntries(fields.map((field, index) => [field, `${prefix}_${index}`]))
  action(input).target.sheetId = `${prefix}_sheet`
  return input
}
function rebuild(material) {
  const packCatalog = createCustomerPackCatalog({ packs: material.customerPacks })
  const mapping = createConfiguredExtFieldMapping({
    config: { stockPreparationExtFieldMapping: material.extFieldMappingConfig }, packCatalog,
  })
  return { packCatalog, mapping }
}
function rejected(input, operation = prepare) {
  assert.throws(() => operation(input), error => {
    assert.ok(error instanceof StockPreparationAutomationProfileError)
    assert.equal(error.name, 'StockPreparationAutomationProfileError')
    assert.equal(error.code, 'AUTOMATION_PROFILE_INVALID')
    assert.equal(error.message, 'AUTOMATION_PROFILE_INVALID')
    assert.equal(Object.hasOwn(error, 'cause'), false)
    assert.equal(Object.hasOwn(error, 'details'), false)
    assert.equal(String(error).includes('synthetic-sensitive'), false)
    return true
  })
}
function frozen(value) {
  if (value && typeof value === 'object') {
    assert.equal(Object.isFrozen(value), true)
    Object.values(value).forEach(frozen)
  }
}

test('absent optional segment is inert, frozen and does not normalize unrelated config', () => {
  const config = { stockPreparationTableActions: 'not-an-action', stockPreparationCustomerPacks: false }
  const result = prepare({ config })
  assert.deepEqual(result, [])
  frozen(result)
})
test('captures exact explicit scope and full actual-normalizer material', () => {
  const input = fixture()
  const result = prepare(input)
  assert.deepEqual(result, [{ ...descriptor(), sheetId: 'arbitrary-sheet',
    objectId: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId,
    material: { action: copy(assertStockPreparationTargetReady(action(input))), customerPacks: {}, extFieldMappingConfig: null } }])
  assert.deepEqual(Object.keys(result[0]).sort(), ['actionId', 'material', 'objectId', 'projectId', 'sheetId', 'tenantId', 'workspaceId'])
  assert.deepEqual(Object.keys(result[0].material).sort(), ['action', 'customerPacks', 'extFieldMappingConfig'])
  assert.equal(Object.hasOwn(result[0], 'permission'), false)
  assert.equal(Object.hasOwn(result[0], 'epoch'), false)
  assert.equal(Object.hasOwn(result[0].material.action, 'maxPages'), false)
  frozen(result)
  assert.equal(Object.isFrozen(input), false)
})
test('uses the existing alias and precedence, not an independently provided action', () => {
  const input = fixture()
  input.config.tableActions = { first: copy(action(input)) }
  delete input.config.stockPreparationTableActions
  assert.equal(prepare(input)[0].sheetId, 'arbitrary-sheet')
  input.config.stockPreparationTableActions = [copy(input.config.tableActions.first)]
  input.config.tableActions.first.target.sheetId = 'ignored-alias-sheet'
  assert.equal(prepare(input)[0].sheetId, 'arbitrary-sheet')
})
test('does not infer tenant/project from source or target identifiers', () => {
  const input = fixture()
  action(input).source.externalSystemId = 'another-tenant:source'
  action(input).target.sheetId = 'another-tenant:sheet'
  const result = prepare(input)[0]
  assert.equal(result.tenantId, descriptor().tenantId)
  assert.equal(result.projectId, descriptor().projectId)
  assert.equal(result.material.action.source.externalSystemId, 'another-tenant:source')
})
test('does not narrow the source kinds accepted by the actual action normalizer', () => {
  const input = fixture()
  action(input).source.kind = 'bridge:legacy-sql-readonly'
  const result = prepare(input)[0]
  assert.equal(result.material.action.source.kind, 'bridge:legacy-sql-readonly')
  assert.equal(result.material.action.source.readPlan.sourceKind, 'bridge:legacy-sql-readonly')
})
test('captures the complete raw catalog and mapping, then rebuilds the actual private brand after JSON persistence', () => {
  const input = packFixture()
  const extraPack = copy(FACTORY_A_SAMPLE_PACK)
  extraPack.packId = 'synthetic-unused-pack'
  input.config.stockPreparationCustomerPacks[extraPack.packId] = extraPack
  const material = prepare(input)[0].material
  assert.deepEqual(material.customerPacks, input.config.stockPreparationCustomerPacks)
  assert.deepEqual(material.extFieldMappingConfig, input.config.stockPreparationExtFieldMapping)
  assert.equal(isNormalizedExtFieldMapping(material.extFieldMappingConfig), false)
  const { mapping, packCatalog } = rebuild(copy(material))
  assert.equal(packCatalog.size, 2)
  assert.equal(isNormalizedExtFieldMapping(mapping), true)
  assert.equal(mapping.mappings[0].coerce, 'string')
  assert.equal(mapping.mappings[1].coerce, 'select')
  assert.ok(mapping.optionValuesByTarget.ext_standard.length > 0)
  frozen(material)
})
for (const prefix of ['layout_alpha', 'layout_beta']) test(`real factories compose the closed target contract for ${prefix}`, () => {
  const profile = prepare(physical(packFixture(), prefix))[0]
  const { mapping, packCatalog } = rebuild(copy(profile.material))
  const pack = packCatalog.get(FACTORY_A_SAMPLE_PACK.packId)
  const installedFieldProperties = pack.extensionFields.map(field => ({ fieldId: field.id,
    property: buildExtensionFieldProperty(field, pack) })) // Synthetic metadata, NOT live installed proof.
  const closed = deriveAutomationReadTargetContract({ action: profile.material.action, installedFieldProperties, extFieldMapping: mapping })
  assert.equal(profile.sheetId, `${prefix}_sheet`)
  assert.equal(closed.projection.projectFieldId, profile.material.action.target.fieldIdMap.projectNo)
  assert.ok(closed.projection.logicalFieldIds.includes('notes'))
  assert.ok(closed.projection.logicalFieldIds.includes('ext_blankLength'))
  assert.ok(closed.projection.logicalFieldIds.includes('ext_legacyRowId'))
  assert.ok(closed.projection.fieldIds.every(id => id.startsWith(`${prefix}_`)))
})
test('copies normalized optional and policy material, not just source/target selectors', () => {
  const input = fixture()
  action(input).pageLimit = 17
  action(input).maxPages = 23
  action(input).rootSelection = { enabled: false }
  action(input).conflictStrategy = { syntheticRule: ['one', { nested: true }] }
  const output = prepare(input)[0].material.action
  assert.deepEqual(output, copy(assertStockPreparationTargetReady(action(input))))
  assert.equal(output.pageLimit, 17)
  assert.deepEqual(output.conflictStrategy.syntheticRule, ['one', { nested: true }])
})
test('does not freeze or retain caller aliases, including dictionaries and nested mappings', () => {
  const input = packFixture()
  const output = prepare(input)
  const before = copy(output)
  input.config.stockPreparationAutomationProfiles[0].tenantId = 'late-tenant'
  action(input).source.externalSystemId = 'late-source'
  input.config.stockPreparationCustomerPacks[FACTORY_A_SAMPLE_PACK.packId].extensionFields[0].label = 'late-label'
  input.config.stockPreparationExtFieldMapping.mappings[0].sourceColumn = 'LateColumn'
  assert.deepEqual(output, before)
  assert.equal(Reflect.set(output[0].material.action.source, 'externalSystemId', 'mutated'), false)
  assert.equal(Reflect.set(output[0].material.extFieldMappingConfig.mappings[0], 'target', 'ext_other'), false)
})
for (const value of [null, false]) test(`actual mapping disabled input ${value} serializes as explicit null`, () => {
  const input = fixture()
  input.config.stockPreparationExtFieldMapping = value
  assert.equal(prepare(input)[0].material.extFieldMappingConfig, null)
})
test('supports null-prototype plain data and preserves JSON-safe special property names as data', () => {
  const input = fixture()
  input.config = Object.assign(Object.create(null), input.config)
  input.config.stockPreparationAutomationProfiles[0] = Object.assign(Object.create(null), descriptor())
  action(input).conflictStrategy = Object.fromEntries([['__proto__', { nested: 'data' }]])
  assert.equal(prepare(input)[0].material.action.conflictStrategy.__proto__.nested, 'data')
})

for (const value of [undefined, null, false, 1, 'x', [], {}, { config: null }, { config: [] }, { config: {}, extra: true }]) {
  test('invalid envelope/config refuses with a fixed error', () => rejected(value))
}
for (const value of [undefined, null, false, true, 1, '', {}, []]) test('present malformed/empty profile segment never becomes disabled', () => {
  const input = fixture(); input.config.stockPreparationAutomationProfiles = value; rejected(input)
})
test('profile segment has a hard bound of 32 before action processing', () => {
  const input = fixture()
  input.config.stockPreparationAutomationProfiles = Array.from({ length: 33 }, (_, index) => descriptor({ tenantId: `tenant-${index}` }))
  rejected(input)
})
for (const key of ['tenantId', 'workspaceId', 'projectId', 'actionId']) test(`missing descriptor ${key} is not inferred`, () => {
  const input = fixture(); delete input.config.stockPreparationAutomationProfiles[0][key]; rejected(input)
})
for (const key of ['source', 'target', 'sheetId', 'objectId', 'fieldIdMap', 'externalSystemId', 'role']) test(`descriptor cannot independently steer ${key}`, () => {
  const input = fixture(); input.config.stockPreparationAutomationProfiles[0][key] = 'synthetic-sensitive'; rejected(input)
})
for (const key of ['tenantId', 'projectId', 'actionId']) {
  for (const value of ['', ' leading', 'trailing ', 'x\u0000y', 'x\u007fy', 'x'.repeat(256), null, 1]) {
    test(`descriptor ${key} is canonical`, () => {
      const input = fixture(); input.config.stockPreparationAutomationProfiles[0][key] = value; rejected(input)
    })
  }
}
for (const key of ['tenantId', 'projectId']) test(`descriptor ${key} uses UTF-16 length without ASCII-only restriction`, () => {
  const input = fixture()
  input.config.stockPreparationAutomationProfiles[0][key] = `${'😀'.repeat(127)}x`
  assert.equal(prepare(input)[0][key].length, 255)
  input.config.stockPreparationAutomationProfiles[0][key] = '😀'.repeat(128)
  rejected(input)
})
for (const value of ['', 'workspace', undefined, false, 0]) test('workspace must be explicit null', () => {
  const input = fixture(); input.config.stockPreparationAutomationProfiles[0].workspaceId = value; rejected(input)
})
test('same scope cannot install ambiguous descriptor projects or duplicate entries', () => {
  const input = fixture()
  input.config.stockPreparationAutomationProfiles.push(descriptor())
  rejected(input)
  input.config.stockPreparationAutomationProfiles[1].projectId = 'different-project'
  rejected(input)
})
test('same physical sheet cannot be assigned to a second tenant', () => {
  const input = fixture()
  input.config.stockPreparationAutomationProfiles.push(descriptor({ tenantId: 'another-tenant' }))
  rejected(input)
})
for (const value of [undefined, null, '', [], {}, [null]]) test('configured action must actually exist', () => {
  const input = fixture(); input.config.stockPreparationTableActions = value; rejected(input)
})
test('duplicate normalized action ids refuse instead of using last-wins target/source', () => {
  const input = fixture()
  input.config.stockPreparationTableActions.push(copy(action(input)))
  input.config.stockPreparationTableActions[1].target.sheetId = 'second-sheet'
  rejected(input)
})
test('descriptor selects an existing exact action id, not the registry default', () => {
  const input = fixture(); input.config.stockPreparationAutomationProfiles[0].actionId = 'missing-action'; rejected(input)
})
for (const key of ['actionId', 'kind']) test(`actual normalizer rejects unsupported ${key}`, () => {
  const input = fixture(); action(input)[key] = 'unsupported'; rejected(input)
})
for (const value of [undefined, null, '', [], { projectNo: '' }, { ' projectNo': 'field' }, { projectNo: ' field' },
  { projectNo: 'field', active: 'field' }, { constructor: 'field' }, { projectNo: 'constructor' }]) {
  test('raw maps cannot silently lose malformed keys or introduce aliases', () => {
    const input = fixture(); action(input).target.fieldIdMap = value; rejected(input)
  })
}
test('explicit projection binds human template fields too, not just legacy PLM fields', () => {
  const input = physical(fixture(), 'custom')
  delete action(input).target.fieldIdMap.notes
  rejected(input)
})
test('map injectivity covers keys outside the selected projection', () => {
  const input = physical(fixture(), 'custom')
  action(input).target.fieldIdMap.syntheticOutside = action(input).target.fieldIdMap.projectNo
  rejected(input)
})
test('whole-template fields are derived, not a hardcoded template field count', () => {
  const input = fixture()
  action(input).template = copy(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE)
  action(input).template.fields.push({ id: 'syntheticHuman', label: 'Synthetic human', type: 'string', ownership: 'human_preserved' })
  assert.ok(prepare(input)[0].material.action.template.fields.some(field => field.id === 'syntheticHuman'))
})
for (const value of [undefined, null, false, true, [], 'bad']) test('malformed catalog cannot silently become empty', () => {
  const input = fixture(); input.config.stockPreparationCustomerPacks = value; rejected(input)
})
test('actual catalog rejects invalid packs even if no mapping uses them', () => {
  const input = fixture(); input.config.stockPreparationCustomerPacks = { unknown: { packId: 'unknown' } }; rejected(input)
})
test('catalog key must equal the pack id', () => {
  const input = packFixture(); input.config.stockPreparationCustomerPacks = { other: copy(FACTORY_A_SAMPLE_PACK) }; rejected(input)
})
for (const value of [undefined, true, 1, '', [], {}]) test('present invalid mapping is not treated as absent', () => {
  const input = packFixture(); input.config.stockPreparationExtFieldMapping = value; rejected(input)
})
for (const change of [mapping => { mapping.packId = 'not-listed' }, mapping => { mapping.extra = 'synthetic-sensitive' },
  mapping => { mapping.mappings[0].target = 'ext_blankLength' }, mapping => { mapping.mappings[0].sourceColumn = 'sql select' }]) {
  test('actual mapping factory rejects invalid allowlist/ownership/shape', () => {
    const input = packFixture(); change(input.config.stockPreparationExtFieldMapping); rejected(input)
  })
}
test('mapping targets must be declared in the same action', () => {
  const input = packFixture(); action(input).extensionFieldIds = []; rejected(input)
})
test('mapping pack target must agree with the same action object', () => {
  const input = packFixture(); action(input).target.objectId = 'plm_stock_preparation_sandbox_alternative'; rejected(input)
})
test('normalizer errors do not leak configuration values', () => {
  const input = fixture(); action(input).source.kind = 'synthetic-sensitive'; rejected(input)
})

for (const value of [undefined, () => true, 1n, Symbol('value'), NaN, Infinity, new Date(0), new Map(), new Set()]) {
  test('non-JSON raw action material is rejected rather than erased by normalization', () => {
    const input = fixture(); action(input).syntheticRaw = value; rejected(input)
  })
}
test('raw optional undefined is not confused with normalizer-emitted undefined', () => {
  const input = fixture(); action(input).pageLimit = undefined; rejected(input)
})
test('cycles are rejected without serializing', () => {
  const input = fixture(); action(input).loop = action(input); rejected(input)
})
test('non-JSON material in unused catalog entries still rejects', () => {
  const input = packFixture(); input.config.stockPreparationCustomerPacks[FACTORY_A_SAMPLE_PACK.packId].unknown = () => true; rejected(input)
})
for (const locate of [input => input, input => input.config, input => input.config.stockPreparationAutomationProfiles[0],
  input => action(input), input => action(input).target, input => input.config.stockPreparationCustomerPacks,
  input => input.config.stockPreparationExtFieldMapping.mappings[0]]) {
  for (const kind of ['getter', 'hidden', 'symbol', 'toJSON', 'prototype']) test(`rejects ${kind} without invoking hooks at every material boundary`, () => {
    const input = packFixture()
    const target = locate(input)
    let calls = 0
    if (kind === 'getter') Object.defineProperty(target, 'malicious', { enumerable: true, get() { calls += 1; return true } })
    if (kind === 'hidden') Object.defineProperty(target, 'malicious', { value: true })
    if (kind === 'symbol') Object.defineProperty(target, Symbol('malicious'), { value: true, enumerable: true })
    if (kind === 'toJSON') target.toJSON = () => { calls += 1; return {} }
    if (kind === 'prototype') Object.setPrototypeOf(target, { malicious: true })
    rejected(input)
    assert.equal(calls, 0)
  })
}
for (const change of [array => { delete array[0] }, array => { array.extra = true }, array => { Object.setPrototypeOf(array, {}) },
  array => { Object.defineProperty(array, '0', { enumerable: true, get() { throw new Error('hook invoked') } }) }]) {
  test('profile arrays cannot hide sparse/accessor/prototype/extra data', () => {
    const input = fixture(); change(input.config.stockPreparationAutomationProfiles); rejected(input)
  })
}
test('array element accessors are refused without evaluation', () => {
  const input = fixture()
  let calls = 0
  Object.defineProperty(input.config.stockPreparationAutomationProfiles, '0', {
    enumerable: true, get() { calls += 1; return descriptor() },
  })
  rejected(input)
  assert.equal(calls, 0)
})
test('does not call unrelated host capabilities or mutate host config', () => {
  const input = fixture()
  let calls = 0
  input.config.unrelatedHostCapability = () => { calls += 1; throw new Error('must remain unused') }
  assert.equal(prepare(input).length, 1)
  assert.equal(calls, 0)
  assert.equal(typeof input.config.unrelatedHostCapability, 'function')
})

test('restore round-trips exact prepared material with no mapping or installed claims', () => {
  const material = copy(prepare(fixture())[0].material)
  const restored = restore({ material })
  assert.deepEqual(Object.keys(restored).sort(), ['action', 'extFieldMapping', 'packCatalog'])
  assert.deepEqual(restored.action, material.action)
  assert.equal(restored.extFieldMapping, null)
  assert.equal(restored.packCatalog.size, 0)
  assert.equal(typeof restored.packCatalog.get, 'function')
  assert.deepEqual(restored.packCatalog.list(), [])
  assert.equal(Object.hasOwn(restored, 'installedFieldProperties'), false)
  assert.equal(Object.hasOwn(restored, 'tenantId'), false)
  assert.equal(Object.hasOwn(restored, 'revision'), false)
  frozen(restored)
  assert.equal(Object.isFrozen(material), false)
})
for (const prefix of ['restored_alpha', 'restored_beta']) test(`production restore composes closed target contract for ${prefix}`, () => {
  const material = copy(prepare(physical(packFixture(), prefix))[0].material)
  const restored = restore({ material })
  const { action: restoredAction, packCatalog, extFieldMapping } = restored
  assert.equal(isNormalizedExtFieldMapping(extFieldMapping), true)
  assert.equal(restoredAction.target.sheetId, `${prefix}_sheet`)
  const pack = packCatalog.get(FACTORY_A_SAMPLE_PACK.packId)
  const installedFieldProperties = pack.extensionFields.map(field => ({ fieldId: field.id,
    property: buildExtensionFieldProperty(field, pack) }))
  const closed = deriveAutomationReadTargetContract({ action: restoredAction, installedFieldProperties, extFieldMapping })
  assert.equal(closed.projection.projectFieldId, restoredAction.target.fieldIdMap.projectNo)
  assert.ok(closed.projection.logicalFieldIds.includes('ext_blankLength'))
  assert.ok(closed.projection.logicalFieldIds.includes('ext_legacyRowId'))
  assert.ok(closed.projection.fieldIds.every(id => id.startsWith(`${prefix}_`)))
  assert.deepEqual(restoredAction, material.action)
  frozen(restored)
})
test('restore retains unused packs, every pack property and actual mapping option/coercion material', () => {
  const input = packFixture()
  const extra = copy(FACTORY_A_SAMPLE_PACK)
  extra.packId = 'synthetic-extra-pack'
  input.config.stockPreparationCustomerPacks[extra.packId] = extra
  const material = copy(prepare(input)[0].material)
  const restored = restore({ material })
  const expected = rebuild(material)
  assert.deepEqual(restored.packCatalog.packIds, expected.packCatalog.packIds)
  for (const packId of expected.packCatalog.packIds) {
    assert.deepEqual(restored.packCatalog.get(packId), expected.packCatalog.get(packId))
  }
  assert.deepEqual(restored.extFieldMapping, expected.mapping)
  assert.equal(restored.extFieldMapping.mappings[0].coerce, 'string')
  assert.equal(restored.extFieldMapping.mappings[1].coerce, 'select')
  assert.ok(restored.extFieldMapping.optionValuesByTarget.ext_standard.length > 0)
})
test('restore always creates detached factory closures and guards their result from late mutations', () => {
  const material = copy(prepare(packFixture())[0].material)
  const restored = restore({ material })
  const second = restore({ material })
  assert.notEqual(restored.packCatalog, second.packCatalog)
  assert.notEqual(restored.packCatalog.get, second.packCatalog.get)
  assert.notEqual(restored.packCatalog.get(FACTORY_A_SAMPLE_PACK.packId), second.packCatalog.get(FACTORY_A_SAMPLE_PACK.packId))
  assert.notEqual(restored.extFieldMapping, second.extFieldMapping)
  material.action.source.externalSystemId = 'late-source'
  material.customerPacks[FACTORY_A_SAMPLE_PACK.packId].extensionFields[0].label = 'late-label'
  material.extFieldMappingConfig.mappings[0].sourceColumn = 'LateColumn'
  assert.equal(restored.action.source.externalSystemId, 'synthetic-deployment-default')
  assert.notEqual(restored.packCatalog.get(FACTORY_A_SAMPLE_PACK.packId).extensionFields[0].label, 'late-label')
  assert.equal(restored.extFieldMapping.mappings[0].sourceColumn, 'SyntheticColumn')
  assert.equal(Reflect.set(restored.packCatalog, 'get', () => null), false)
  assert.equal(Reflect.set(restored.extFieldMapping.mappings[0], 'target', 'ext_other'), false)
  assert.equal(Reflect.set(restored.packCatalog.packIds, '0', 'other-pack'), false)
})
for (const value of [undefined, null, [], {}, { material: null }, { material: [] }, { material: {}, extra: true }]) {
  test('restore requires an exact data envelope and material object', () => rejected(value, restore))
}
for (const key of ['action', 'customerPacks', 'extFieldMappingConfig']) test(`restore requires explicit material ${key}`, () => {
  const material = copy(prepare(fixture())[0].material)
  delete material[key]
  rejected({ material }, restore)
})
for (const key of ['packCatalog', 'extFieldMapping', 'tenantId', 'sourcePointerRevision', 'permissions']) {
  test(`restore does not recover ${key} from an extra persisted capability`, () => {
    const material = copy(prepare(fixture())[0].material)
    material[key] = {}
    rejected({ material }, restore)
  })
}
test('restore rejects actual or counterfeit symbol-branded mapping objects instead of trusting them', () => {
  const material = copy(prepare(packFixture())[0].material)
  const actual = rebuild(material).mapping
  material.extFieldMappingConfig = actual
  rejected({ material }, restore)
  const counterfeit = copy(actual)
  Object.defineProperty(counterfeit, Symbol('normalized'), { value: true })
  material.extFieldMappingConfig = counterfeit
  rejected({ material }, restore)
})
test('serialized normalized mapping cannot bypass rebuilding the mapping config schema', () => {
  const material = copy(prepare(packFixture())[0].material)
  material.extFieldMappingConfig = copy(rebuild(material).mapping)
  assert.equal(isNormalizedExtFieldMapping(material.extFieldMappingConfig), false)
  rejected({ material }, restore)
})
test('restore accepts ordinary factory-compatible pack JSON but never a stored catalog with methods', () => {
  const material = copy(prepare(packFixture())[0].material)
  assert.ok(restore({ material }).packCatalog.has(FACTORY_A_SAMPLE_PACK.packId))
  material.customerPacks = rebuild(material).packCatalog
  rejected({ material }, restore)
})
for (const value of [undefined, null, false, [], 'bad']) test('restore rejects unavailable/malformed catalog instead of using empty', () => {
  const material = copy(prepare(fixture())[0].material)
  material.customerPacks = value
  rejected({ material }, restore)
})
for (const value of [undefined, false, true, 1, [], {}]) test('restore requires canonical null or valid raw mapping material', () => {
  const material = copy(prepare(fixture())[0].material)
  material.extFieldMappingConfig = value
  rejected({ material }, restore)
})
for (const change of [
  material => { material.action.target.fieldIdMap.projectNo = 'project-alias'; material.action.target.fieldIdMap.active = 'project-alias' },
  material => { material.action.target.fieldIdMap.extraAlias = material.action.target.fieldIdMap.projectNo },
  material => { delete material.action.target.fieldIdMap.notes },
  material => { material.action.target.fieldIdMap.projectNo = ' field' },
  material => { material.action.target.fieldIdMap.constructor = 'field' },
  material => { material.action.extensionFieldIds = [] },
  material => { material.action.target.objectId = 'another-object' },
  material => { material.action.source.kind = 'synthetic-sensitive' },
  material => { material.action.target.sheetId = '' },
  material => { material.extFieldMappingConfig.packId = 'not-listed' },
  material => { material.extFieldMappingConfig.mappings[0].target = 'ext_blankLength' },
  material => { material.customerPacks[FACTORY_A_SAMPLE_PACK.packId].packVersion = 0 },
]) test('restore reuses the prepare raw-map/target/catalog/mapping alignment guards', () => {
  const material = copy(prepare(physical(packFixture(), 'restored'))[0].material)
  change(material)
  rejected({ material }, restore)
})
for (const locate of [input => input, input => input.material, input => input.material.action.target,
  input => input.material.customerPacks[FACTORY_A_SAMPLE_PACK.packId], input => input.material.extFieldMappingConfig]) {
  for (const kind of ['getter', 'hidden', 'symbol', 'toJSON', 'prototype']) test(`restore rejects ${kind} before factory execution`, () => {
    const input = { material: copy(prepare(packFixture())[0].material) }
    const target = locate(input)
    let calls = 0
    if (kind === 'getter') Object.defineProperty(target, 'malicious', { enumerable: true, get() { calls += 1; return true } })
    if (kind === 'hidden') Object.defineProperty(target, 'malicious', { value: true })
    if (kind === 'symbol') Object.defineProperty(target, Symbol('malicious'), { value: true })
    if (kind === 'toJSON') target.toJSON = () => { calls += 1; return {} }
    if (kind === 'prototype') Object.setPrototypeOf(target, { malicious: true })
    rejected(input, restore)
    assert.equal(calls, 0)
  })
}
for (const value of [undefined, () => true, 1n, Symbol('value'), NaN, Infinity, new Date(0), new Map()]) {
  test('restore refuses non-JSON nested material before a normalizer can erase it', () => {
    const material = copy(prepare(fixture())[0].material)
    material.action.conflictStrategy.syntheticInvalid = value
    rejected({ material }, restore)
  })
}

function executionFixture() {
  const { createHash } = require('node:crypto')
  const { __internals: { stableStringify } } = require('../lib/stock-preparation-table-actions.cjs')
  const { validateStockPreparationReadPlanConfig } = require('../lib/stock-preparation-read-plan-config.cjs')
  const role = (object, fields) => ({ object, ...Object.fromEntries(fields.map(field => [field, field])) })
  const config = validateStockPreparationReadPlanConfig({ schemaVersion: 1, actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    systemId: 'synthetic-selected-source', readPlan: {
      id: 'plm.stock-preparation.bom-read.user-draft.v1', sourceKind: 'data-source:sql-readonly', matchField: 'matchField', maxReadCount: 7,
      pathExAttr: role('SYN_PathLink', ['matchField', 'pathIdField']), pathInfo: role('SYN_Path', ['idField']),
      orderHead: role('SYN_Order', ['idField', 'pathIdField']),
      orderDetail: role('SYN_Line', ['orderIdField', 'componentIdField', 'quantityField']),
      part: role('SYN_Part', ['idField']), bomHead: role('SYN_Bom', ['parentPartField', 'bomIdField']),
      bomDetail: role('SYN_BomLine', ['bomParentField', 'componentIdField', 'quantityField']),
    } })
  const contentKey = createHash('sha256').update(stableStringify(config)).digest('hex')
  const scope = { tenantId: 'synthetic-tenant', workspaceId: null }
  const common = { ...scope, actionId: config.actionId, systemId: config.systemId, contentKey }
  return { action: copy(prepare(fixture())[0].material.action), scope, systemId: config.systemId,
    active: { version: { ...common, id: 'synthetic-version', schemaVersion: 1, version: 1, config, status: 'approved' },
      activation: { ...common, id: 'synthetic-activation', versionId: 'synthetic-version', generation: 1, status: 'active' } },
    budgetCeiling: { maxRows: 100, maxPages: 2, maxReadCount: 50, timeoutMs: 3000 } }
}
test('actual approved composer replaces only source selection and plan, with finite tighter budgets', () => {
  const input = executionFixture(), before = copy(input)
  const result = compose(input)
  assert.deepEqual(result.budget, { maxRows: 100, maxPages: 2, maxReadCount: 7, timeoutMs: 3000 })
  assert.equal(result.action.source.externalSystemId, input.systemId)
  assert.deepEqual(result.action.source.readPlan, input.active.version.config.readPlan)
  assert.equal(result.action.readPlanExecutionIdentity.versionId, 'synthetic-version')
  assert.deepEqual(result.action.target, input.action.target)
  assert.equal(Object.hasOwn(result.action, 'maxElapsedMs'), false)
  assert.deepEqual(input, before)
  frozen(result)
})
test('stricter action bounds beat host ceiling, never widened background caps', () => {
  const input = executionFixture()
  Object.assign(input.action, { maxRows: 3, maxPages: 1, maxReadCount: 2, maxElapsedMs: 500 })
  assert.deepEqual(compose(input).budget, { maxRows: 3, maxPages: 1, maxReadCount: 2, timeoutMs: 500 })
})
test('actual normalizer defaults remain a ceiling when host asks for larger rows/pages', () => {
  const input = executionFixture()
  input.budgetCeiling.maxRows = 20000; input.budgetCeiling.maxPages = 200
  assert.deepEqual(compose(input).budget, { maxRows: 10000, maxPages: 100, maxReadCount: 7, timeoutMs: 3000 })
})
for (const key of ['maxRows', 'maxPages', 'maxReadCount', 'timeoutMs']) {
  for (const value of [0, -1, 1.5, null, undefined, Infinity, 2147483648, '100']) {
    test('finite positive integer host ceiling required for ' + key, () => {
      const input = executionFixture(); input.budgetCeiling[key] = value
      rejected(input, compose)
    })
  }
}
for (const mutation of [
  input => { input.active.activation.status = 'disabled' },
  input => { input.active.version.status = 'draft' },
  input => { input.active.version.contentKey = 'a'.repeat(64) },
  input => { input.scope.tenantId = 'other-tenant' },
  input => { input.scope.workspaceId = 'other-workspace' },
  input => { input.systemId = 'wrong-source' },
  input => { input.action.source.kind = 'bridge:legacy-sql-readonly' },
  input => { input.action.source.workspaceId = 'legacy-workspace' },
  input => { input.active.extra = 'not-allowed' },
]) test('effective composition cannot manufacture authority from invalid source material', () => {
  const input = executionFixture(); mutation(input); rejected(input, compose)
})
test('effective codec captures descriptors without invoking getters or toJSON', () => {
  const input = executionFixture(); let calls = 0
  Object.defineProperty(input.active.version.config, 'readPlan', { enumerable: true, get() { calls++; return {} } })
  rejected(input, compose); assert.equal(calls, 0)
})

console.log(`stock-preparation-automation-profile: ${passed} passed`)
