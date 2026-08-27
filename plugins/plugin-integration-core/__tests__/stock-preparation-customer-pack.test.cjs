'use strict'

// P0 — customer config pack CONTRACT battery.
// Plain node test (throws on failure). No DB, no network, no host API: this
// module is pure validation, so the whole suite is hermetic. Values-free: the
// only literals exercised are schema ids, business column labels and material
// grade samples — never customer rows.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const MODULE_PATH = path.join(__dirname, '..', 'lib', 'stock-preparation-customer-pack.cjs')
const SAMPLE_PATH = path.join(__dirname, '..', 'lib', 'customer-packs', 'factory-a.sample.cjs')

const {
  PACK_ID_PATTERN,
  STOCK_PREPARATION_CUSTOMER_PACK_ERROR_REASONS,
  StockPreparationCustomerPackError,
  isNormalizedCustomerPack,
  normalizeCustomerPack,
  summarizeCustomerPackForEvidence,
  __internals,
} = require(MODULE_PATH)

const { FACTORY_A_SAMPLE_PACK } = require(SAMPLE_PATH)

const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  HUMAN_PRESERVED_FIELD_IDS,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-templates.cjs'))

const { MAX_OPTIONS_PER_FIELD } = require(path.join(__dirname, '..', 'lib', 'stock-preparation-option-sync.cjs'))

// A minimal, independently authored pack — deliberately NOT the sample, so a
// broken sample cannot make the negative cases vacuous.
function minimalPack(overrides = {}) {
  return {
    packId: 'unit-pack',
    packVersion: 1,
    extensionFields: [{ id: 'ext_unitProbe', label: '单测列', type: 'string', ownership: 'plm_system' }],
    optionSets: [],
    roleViews: [],
    ...overrides,
  }
}

function assertThrowsReason(fn, reason, label) {
  let thrown = null
  try {
    fn()
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown, `${label}: expected a throw`)
  assert.ok(
    thrown instanceof StockPreparationCustomerPackError,
    `${label}: expected StockPreparationCustomerPackError, got ${thrown.name}: ${thrown.message}`,
  )
  assert.equal(thrown.reason, reason, `${label}: expected reason ${reason}, got ${thrown.reason}`)
  assert.ok(
    STOCK_PREPARATION_CUSTOMER_PACK_ERROR_REASONS.includes(thrown.reason),
    `${label}: reason ${thrown.reason} must be in the closed vocabulary`,
  )
  return thrown
}

function purityAndCoupling() {
  // The module must stay pure: no fs, no net, no DB, no host API. Its only
  // project dependencies are the four schema authorities it reuses rather
  // than duplicates (template vocabulary, ext_ namespace, option normalizer,
  // and the sandbox-objectId rule).
  //
  // target-provisioning joined the list when a pack gained its optional
  // `targetObjectId`. It is on this list for exactly the reason the other three
  // are: the alternative was a second copy of the sandbox namespace regex, and a
  // copied rule is one that drifts. The module it pulls in is itself pure at
  // load time (its host calls all take a `context` argument), so the no-I/O
  // assertions below still hold — they are re-checked here rather than assumed.
  const source = fs.readFileSync(MODULE_PATH, 'utf8')
  const requireCalls = [...source.matchAll(/require\((['"])([^'"]+)\1\)/g)].map((match) => match[2])
  assert.deepEqual(
    requireCalls.slice().sort(),
    [
      './stock-preparation-extension-namespace.cjs',
      './stock-preparation-option-sync.cjs',
      './stock-preparation-target-provisioning.cjs',
      './stock-preparation-templates.cjs',
    ],
    'pack module must require exactly the four schema authorities and nothing else',
  )
  for (const forbidden of ['node:fs', 'node:http', 'node:https', 'node:child_process', 'pg', 'mssql']) {
    assert.ok(!requireCalls.includes(forbidden), `pack module must not require ${forbidden}`)
  }
}

function validSamplePasses() {
  const pack = normalizeCustomerPack(FACTORY_A_SAMPLE_PACK)
  assert.equal(pack.packId, 'factory-a')
  assert.equal(pack.packVersion, 1)
  assert.equal(pack.targetObjectId, STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId)
  assert.equal(pack.extensionFields.length, 10, 'sample carries ten extension columns')
  assert.equal(pack.optionSets.length, 1)
  assert.equal(pack.optionSets[0].fieldId, 'ext_standard')
  assert.equal(pack.optionSets[0].options.length, 12)
  assert.equal(pack.roleViews.length, 2)

  // Every id sits in the reserved namespace, and none collides with the frozen
  // template — the additive-only invariant, asserted against the REAL catalog.
  const templateIds = new Set(STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => field.id))
  for (const field of pack.extensionFields) {
    assert.ok(field.id.startsWith('ext_'), `${field.id} must live in the ext_ namespace`)
    assert.equal(templateIds.has(field.id), false, `${field.id} must not be a template field id`)
  }

  // preserveOnRefresh is DERIVED from ownership, never authored.
  for (const field of pack.extensionFields) {
    assert.equal(field.preserveOnRefresh, field.ownership === 'human_preserved', `${field.id} preserveOnRefresh`)
  }

  // Deep freeze: a normalized pack handed to the installer must not be
  // mutable from underneath it.
  assert.ok(Object.isFrozen(pack))
  assert.ok(Object.isFrozen(pack.extensionFields))
  assert.ok(Object.isFrozen(pack.extensionFields[0]))
  assert.ok(Object.isFrozen(pack.optionSets[0].options))
  assert.ok(Object.isFrozen(pack.roleViews[0].hiddenFieldIds))

  // Re-normalizing an already-normalized pack is a no-op (the installer
  // normalizes whatever it is handed, so this must hold).
  assert.equal(normalizeCustomerPack(pack), pack, 'normalize must be idempotent by identity')
  assert.equal(isNormalizedCustomerPack(pack), true)
  assert.equal(isNormalizedCustomerPack(FACTORY_A_SAMPLE_PACK), false, 'a raw pack is not branded')

  // The brand cannot be carried onto a hand-made lookalike: a spread copy drops
  // it (non-enumerable), so a tampered "normalized" pack is re-validated from
  // scratch rather than trusted.
  const forged = { ...pack, packId: 'forged-pack' }
  assert.equal(isNormalizedCustomerPack(forged), false, 'a spread copy must lose the brand')
  // The DERIVED keys normalization adds are what make a spread copy fail re-validation,
  // and there are two of them at different depths. This used to trip the TOP-LEVEL gate on
  // `targetObjectId`; that key is now authorable (optional, sandbox-only), so the copy gets
  // one gate further and is caught by the field-level derived key `preserveOnRefresh`.
  // The property under test is unchanged and is asserted directly below: a spread copy is
  // re-validated from scratch, never trusted.
  assertThrowsReason(() => normalizeCustomerPack(forged), 'EXTENSION_FIELD_UNKNOWN_KEY', 'spread copy re-validated')
  // And the top-level gate still fires on its own, so widening PACK_KEYS by one key did not
  // open the door to arbitrary top-level keys.
  assertThrowsReason(
    () => normalizeCustomerPack({ ...FACTORY_A_SAMPLE_PACK, smuggled: 'x' }),
    'PACK_UNKNOWN_KEY',
    'top-level unknown key still refused',
  )
}

function hideOwnershipsResolvesAgainstBothCatalogs() {
  const pack = normalizeCustomerPack(FACTORY_A_SAMPLE_PACK)
  const production = pack.roleViews.find((view) => view.viewId === 'production')
  const procurement = pack.roleViews.find((view) => view.viewId === 'procurement')

  // hideOwnerships must resolve across BOTH halves of the sheet: every frozen
  // human-preserved template column AND every human-preserved pack column.
  for (const fieldId of HUMAN_PRESERVED_FIELD_IDS) {
    assert.ok(production.hiddenFieldIds.includes(fieldId), `production view must hide template ${fieldId}`)
  }
  for (const fieldId of ['ext_blankLength', 'ext_blankWidth', 'ext_blankQuantity']) {
    assert.ok(production.hiddenFieldIds.includes(fieldId), `production view must hide pack ${fieldId}`)
  }
  // …and the explicitly named column joins the banded ones.
  assert.ok(production.hiddenFieldIds.includes('lastPlmConflictSummary'))
  // No PLM/system column is hidden by accident.
  assert.equal(production.hiddenFieldIds.includes('componentCode'), false)
  assert.equal(production.hiddenFieldIds.includes('ext_legacyRowId'), false)

  // An empty hideOwnerships band hides exactly the named ids, nothing more.
  assert.deepEqual(
    [...procurement.hiddenFieldIds].sort(),
    [...procurement.hideFieldIds].sort(),
    'with no ownership band, hiddenFieldIds is exactly hideFieldIds',
  )

  // Order is catalog order (template fields first, then pack fields), which is
  // what makes a re-install byte-identical.
  const catalogOrder = [
    ...STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => field.id),
    ...pack.extensionFields.map((field) => field.id),
  ]
  const positions = production.hiddenFieldIds.map((id) => catalogOrder.indexOf(id))
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'hiddenFieldIds must follow catalog order')
}

function badExtensionFieldIdRejected() {
  // Missing reserved prefix — a bare id could someday collide with a new
  // frozen template column.
  assertThrowsReason(
    () => normalizeCustomerPack(minimalPack({
      extensionFields: [{ id: 'legacyRowId', label: '旧系统ID', type: 'string', ownership: 'plm_system' }],
    })),
    'EXTENSION_FIELD_ID_INVALID',
    'bare id (no ext_ prefix)',
  )

  // Suffix collides with a REAL frozen template field id (`notes`).
  const collision = assertThrowsReason(
    () => normalizeCustomerPack(minimalPack({
      extensionFields: [{ id: 'ext_notes', label: '备注', type: 'string', ownership: 'human_preserved' }],
    })),
    'EXTENSION_FIELD_ID_INVALID',
    'ext_ suffix colliding with a template field id',
  )
  assert.equal(collision.details.namespaceReason, 'FIELD_ID_TEMPLATE_COLLISION')

  // Suffix shape: separators / unicode / leading capitals are all closed out.
  for (const badId of ['ext_Legacy', 'ext_legacy-row', 'ext_legacy_row', 'ext_旧系统', 'ext_', 'ext_1st']) {
    assertThrowsReason(
      () => normalizeCustomerPack(minimalPack({
        extensionFields: [{ id: badId, label: '列', type: 'string', ownership: 'plm_system' }],
      })),
      'EXTENSION_FIELD_ID_INVALID',
      `malformed suffix ${badId}`,
    )
  }

  // A content-smuggling key name cannot come back in as a field id suffix.
  const smuggled = assertThrowsReason(
    () => normalizeCustomerPack(minimalPack({
      extensionFields: [{ id: 'ext_rawSql', label: '列', type: 'string', ownership: 'plm_system' }],
    })),
    'EXTENSION_FIELD_ID_INVALID',
    'forbidden content key as suffix',
  )
  assert.equal(smuggled.details.namespaceReason, 'FIELD_ID_FORBIDDEN_CONTENT_KEY')

  // Duplicates would make the additive write ambiguous.
  assertThrowsReason(
    () => normalizeCustomerPack(minimalPack({
      extensionFields: [
        { id: 'ext_dup', label: '甲', type: 'string', ownership: 'plm_system' },
        { id: 'ext_dup', label: '乙', type: 'string', ownership: 'plm_system' },
      ],
    })),
    'EXTENSION_FIELD_DUPLICATE',
    'duplicate extension field ids',
  )
}

function inlineOptionsOnAFieldRejected() {
  // The frozen template bans inline options on a field descriptor; a pack gets
  // no weaker gate. Options may ONLY arrive under optionSets.
  for (const key of ['options', 'values', 'value', 'default', 'optionSource']) {
    const field = { id: 'ext_grade', label: '牌号', type: 'select', ownership: 'plm_system' }
    field[key] = key === 'optionSource' ? { type: 'config_info', key: 'grade' } : [{ value: 'S30408' }]
    assertThrowsReason(
      () => normalizeCustomerPack(minimalPack({ extensionFields: [field] })),
      'EXTENSION_FIELD_INLINE_OPTIONS',
      `inline ${key} on a field descriptor`,
    )
  }
}

function optionSetCapsEnforced() {
  const oversized = {
    fieldId: 'ext_grade',
    options: Array.from({ length: MAX_OPTIONS_PER_FIELD + 1 }, (_, index) => ({ value: `G${index}` })),
  }
  const thrown = assertThrowsReason(
    () => normalizeCustomerPack(minimalPack({
      extensionFields: [{ id: 'ext_grade', label: '牌号', type: 'select', ownership: 'plm_system' }],
      optionSets: [oversized],
    })),
    'OPTION_SET_OPTIONS_INVALID',
    `${MAX_OPTIONS_PER_FIELD + 1} options`,
  )
  assert.equal(thrown.details.maxOptions, MAX_OPTIONS_PER_FIELD)

  // Exactly at the cap still passes — the boundary is inclusive, so the
  // rejection above is the cap and not an off-by-one somewhere else.
  const atCap = normalizeCustomerPack(minimalPack({
    extensionFields: [{ id: 'ext_grade', label: '牌号', type: 'select', ownership: 'plm_system' }],
    optionSets: [{
      fieldId: 'ext_grade',
      options: Array.from({ length: MAX_OPTIONS_PER_FIELD }, (_, index) => ({ value: `G${index}` })),
    }],
  }))
  assert.equal(atCap.optionSets[0].options.length, MAX_OPTIONS_PER_FIELD)

  // An empty set is a mistake, not "nothing to do".
  assertThrowsReason(
    () => normalizeCustomerPack(minimalPack({
      extensionFields: [{ id: 'ext_grade', label: '牌号', type: 'select', ownership: 'plm_system' }],
      optionSets: [{ fieldId: 'ext_grade', options: [] }],
    })),
    'OPTION_SET_OPTIONS_INVALID',
    'empty option set',
  )

  // Executable keys inside an option are the option normalizer's rejection,
  // re-thrown in this module's vocabulary.
  assertThrowsReason(
    () => normalizeCustomerPack(minimalPack({
      extensionFields: [{ id: 'ext_grade', label: '牌号', type: 'select', ownership: 'plm_system' }],
      optionSets: [{ fieldId: 'ext_grade', options: [{ value: 'S30408', script: 'x' }] }],
    })),
    'OPTION_SET_OPTIONS_INVALID',
    'executable key inside an option',
  )
}

function optionSetTargetingRules() {
  // An option set must land on a select field the pack can actually see.
  assertThrowsReason(
    () => normalizeCustomerPack(minimalPack({ optionSets: [{ fieldId: 'ext_nowhere', options: [{ value: 'A' }] }] })),
    'OPTION_SET_FIELD_UNKNOWN',
    'option set on an unknown field',
  )
  assertThrowsReason(
    () => normalizeCustomerPack(minimalPack({ optionSets: [{ fieldId: 'ext_unitProbe', options: [{ value: 'A' }] }] })),
    'OPTION_SET_FIELD_NOT_SELECT',
    'option set on a string field',
  )
  assertThrowsReason(
    () => normalizeCustomerPack(minimalPack({
      extensionFields: [{ id: 'ext_grade', label: '牌号', type: 'select', ownership: 'plm_system' }],
      optionSets: [
        { fieldId: 'ext_grade', options: [{ value: 'A' }] },
        { fieldId: 'ext_grade', options: [{ value: 'B' }] },
      ],
    })),
    'OPTION_SET_DUPLICATE_FIELD',
    'two option sets for one field',
  )

  // A pack MAY supply the dictionary for a frozen template select column —
  // that is the deploy-time config_info path, not a template edit.
  const onTemplateField = normalizeCustomerPack(minimalPack({
    optionSets: [{ fieldId: 'materialType', options: [{ value: '20 - S30408' }] }],
  }))
  assert.equal(onTemplateField.optionSets[0].fieldSource, 'template')
}

function unknownKeysRejectedEverywhere() {
  assertThrowsReason(
    () => normalizeCustomerPack(minimalPack({ tenantHost: 'anything' })),
    'PACK_UNKNOWN_KEY',
    'unknown top-level pack key',
  )
  assertThrowsReason(
    () => normalizeCustomerPack(minimalPack({
      extensionFields: [{ id: 'ext_probe', label: '列', type: 'string', ownership: 'plm_system', width: 120 }],
    })),
    'EXTENSION_FIELD_UNKNOWN_KEY',
    'unknown extension field key',
  )
  assertThrowsReason(
    () => normalizeCustomerPack(minimalPack({
      extensionFields: [{ id: 'ext_grade', label: '牌号', type: 'select', ownership: 'plm_system' }],
      optionSets: [{ fieldId: 'ext_grade', options: [{ value: 'A' }], refresh: true }],
    })),
    'OPTION_SET_UNKNOWN_KEY',
    'unknown option set key',
  )
  assertThrowsReason(
    () => normalizeCustomerPack(minimalPack({
      roleViews: [{ viewId: 'ops', label: '视图', filterInfo: {} }],
    })),
    'ROLE_VIEW_UNKNOWN_KEY',
    'unknown role view key',
  )

  // Content-smuggling keys report in THIS module's vocabulary, not the
  // template module's — a caller branching on `.reason` must see something.
  assertThrowsReason(() => normalizeCustomerPack(minimalPack({ rows: [] })), 'PACK_UNKNOWN_KEY', 'rows on the pack')
}

function packIdentityRejections() {
  for (const packId of ['Factory-A', 'a', 'factory_a', '1factory', 'factory a', '']) {
    assertThrowsReason(() => normalizeCustomerPack(minimalPack({ packId })), 'PACK_ID_INVALID', `packId ${packId}`)
  }
  assert.equal(PACK_ID_PATTERN.test('factory-a'), true)
  for (const packVersion of [0, -1, 1.5, '1', null]) {
    assertThrowsReason(
      () => normalizeCustomerPack(minimalPack({ packVersion })),
      'PACK_VERSION_INVALID',
      `packVersion ${String(packVersion)}`,
    )
  }
  assertThrowsReason(() => normalizeCustomerPack(null), 'PACK_NOT_AN_OBJECT', 'null pack')
  assertThrowsReason(() => normalizeCustomerPack([]), 'PACK_NOT_AN_OBJECT', 'array pack')
}

function fieldShapeRejections() {
  assertThrowsReason(
    () => normalizeCustomerPack(minimalPack({
      extensionFields: [{ id: 'ext_probe', label: '列', type: 'lookup', ownership: 'plm_system' }],
    })),
    'EXTENSION_FIELD_TYPE_INVALID',
    'type outside the template vocabulary',
  )
  assertThrowsReason(
    () => normalizeCustomerPack(minimalPack({
      extensionFields: [{ id: 'ext_probe', label: '列', type: 'string', ownership: 'tenant_owned' }],
    })),
    'EXTENSION_FIELD_OWNERSHIP_INVALID',
    'ownership outside the template vocabulary',
  )
  assertThrowsReason(
    () => normalizeCustomerPack(minimalPack({
      extensionFields: [{ id: 'ext_probe', label: '  ', type: 'string', ownership: 'plm_system' }],
    })),
    'EXTENSION_FIELD_LABEL_INVALID',
    'blank label',
  )
  assertThrowsReason(
    () => normalizeCustomerPack(minimalPack({ extensionFields: 'ext_probe' })),
    'EXTENSION_FIELDS_INVALID',
    'extensionFields not an array',
  )
}

function roleViewRejections() {
  assertThrowsReason(
    () => normalizeCustomerPack(minimalPack({ roleViews: [{ viewId: 'Ops', label: '视图' }] })),
    'ROLE_VIEW_ID_INVALID',
    'uppercase viewId',
  )
  assertThrowsReason(
    () => normalizeCustomerPack(minimalPack({
      roleViews: [{ viewId: 'ops', label: '甲' }, { viewId: 'ops', label: '乙' }],
    })),
    'ROLE_VIEW_DUPLICATE',
    'duplicate viewId',
  )
  assertThrowsReason(
    () => normalizeCustomerPack(minimalPack({
      roleViews: [{ viewId: 'ops', label: '视图', hideOwnerships: ['tenant_owned'] }],
    })),
    'ROLE_VIEW_OWNERSHIP_INVALID',
    'ownership band outside the vocabulary',
  )
  assertThrowsReason(
    () => normalizeCustomerPack(minimalPack({
      roleViews: [{ viewId: 'ops', label: '视图', hideFieldIds: ['ext_nowhere'] }],
    })),
    'ROLE_VIEW_HIDE_FIELD_UNKNOWN',
    'hiding a field nobody declares',
  )
}

function evidenceIsValuesFree() {
  const evidence = summarizeCustomerPackForEvidence(FACTORY_A_SAMPLE_PACK)
  const serialized = JSON.stringify(evidence)
  // Counts, never dictionary values or business labels.
  assert.equal(evidence.optionSets[0].optionCount, 12)
  for (const leak of ['S30408', 'Q345R', '标准', '旧系统ID']) {
    assert.equal(serialized.includes(leak), false, `evidence must not echo ${leak}`)
  }
}

function noLiveMutableExportLeak() {
  // No live Set/Map on the export surface, and the frozen catalog copy the
  // pack module exposes must not be poisonable by a caller.
  assert.ok(Object.isFrozen(STOCK_PREPARATION_CUSTOMER_PACK_ERROR_REASONS))
  assert.ok(Object.isFrozen(__internals.TEMPLATE_FIELD_IDS))
  const catalog = __internals.buildFieldCatalog([])
  catalog.set('poisoned', { id: 'poisoned', type: 'string', ownership: 'plm_system', source: 'pack' })
  assert.equal(__internals.buildFieldCatalog([]).has('poisoned'), false, 'catalog must be rebuilt per call')
}

function main() {
  purityAndCoupling()
  validSamplePasses()
  hideOwnershipsResolvesAgainstBothCatalogs()
  badExtensionFieldIdRejected()
  inlineOptionsOnAFieldRejected()
  optionSetCapsEnforced()
  optionSetTargetingRules()
  unknownKeysRejectedEverywhere()
  packIdentityRejections()
  fieldShapeRejections()
  roleViewRejections()
  evidenceIsValuesFree()
  noLiveMutableExportLeak()
}

main()
console.log('stock-preparation-customer-pack.test.cjs OK')
