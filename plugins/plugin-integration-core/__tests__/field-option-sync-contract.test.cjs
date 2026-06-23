'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  FieldOptionSyncContractError,
  SYNC_MODES,
  CONFLICT_POLICIES,
  TRIGGER_MODES,
  TARGET_KIND,
  DEFAULT_SYNC_MODE,
  DEFAULT_CONFLICT_POLICY,
  DEFAULT_TRIGGER_MODE,
  normalizeFieldOptionSyncPreset,
  assertFieldOptionSyncPresetValuesFree,
  listFieldOptionSyncPresets,
} = require(path.join(__dirname, '..', 'lib', 'field-option-sync-contract.cjs'))

function validPreset(overrides = {}) {
  return {
    presetId: 'preset.test.v1',
    label: 'Test preset',
    sourceKind: 'sql',
    sourceObjectOrTable: 'dbo.items',
    targetTable: 'my_table',
    optionFields: [{ valueField: 'code', targetField: 'codeField' }],
    ...overrides,
  }
}

async function main() {
  // --- 1. normalizer: valid + defaults applied ---
  const norm = normalizeFieldOptionSyncPreset(validPreset())
  assert.equal(norm.presetId, 'preset.test.v1')
  assert.equal(norm.targetKind, TARGET_KIND, 'targetKind defaults to metasheet:field-options')
  assert.equal(norm.syncMode, DEFAULT_SYNC_MODE, 'syncMode defaults to replace')
  assert.equal(norm.conflictPolicy, DEFAULT_CONFLICT_POLICY, 'conflictPolicy defaults to update_from_source')
  assert.equal(norm.triggerMode, DEFAULT_TRIGGER_MODE, 'triggerMode defaults to manual')
  assert.equal(norm.optionFields[0].targetFieldType, 'single_select', 'targetFieldType defaults to single_select')
  // sanity: defaults are the §7 v1 recommendations
  assert.ok(SYNC_MODES.includes('disable_missing') && CONFLICT_POLICIES.includes('keep_existing') && TRIGGER_MODES.includes('scheduled'), 'enums expose the FOS-2 modes')

  // --- 2. enum-strict: invalid enums rejected ---
  for (const [field, bad] of [['sourceKind', 'ftp'], ['syncMode', 'upsert'], ['conflictPolicy', 'overwrite'], ['triggerMode', 'webhook']]) {
    assert.throws(
      () => normalizeFieldOptionSyncPreset(validPreset({ [field]: bad })),
      (e) => e instanceof FieldOptionSyncContractError && e.details.field === field,
      `${field} is enum-strict (rejects "${bad}")`,
    )
  }
  assert.throws(() => normalizeFieldOptionSyncPreset(validPreset({ targetKind: 'metasheet:multitable' })), /targetKind/, 'targetKind locked to metasheet:field-options')
  assert.throws(() => normalizeFieldOptionSyncPreset(validPreset({ optionFields: [{ valueField: 'x', targetField: 'y', targetFieldType: 'rating' }] })), /targetFieldType/, 'targetFieldType enum-strict')

  // --- 3. required fields + non-empty optionFields ---
  for (const field of ['presetId', 'label', 'targetTable']) {
    assert.throws(() => normalizeFieldOptionSyncPreset(validPreset({ [field]: '' })), (e) => e.details.field === field, `${field} required`)
  }
  assert.throws(() => normalizeFieldOptionSyncPreset(validPreset({ optionFields: [] })), /non-empty/, 'optionFields non-empty')
  assert.throws(() => normalizeFieldOptionSyncPreset(validPreset({ optionFields: [{ valueField: 'code' }] })), /targetField is required/, 'optionField.targetField required')

  // --- 4. values-free: forbidden keys + secret-shaped (non-vacuous) ---
  for (const badKey of ['sql', 'url', 'payload', 'credentials', 'optionValues', 'sheetId', 'handler']) {
    assert.throws(
      () => normalizeFieldOptionSyncPreset(validPreset({ [badKey]: 'anything' })),
      (e) => e instanceof FieldOptionSyncContractError,
      `forbidden key "${badKey}" rejected`,
    )
  }
  // secret-shaped value (the real leak vector: conn-string) rejected, even under a benign key
  assert.throws(
    () => assertFieldOptionSyncPresetValuesFree({ presetId: 'p', targetTable: 'Server=db;Database=x;User Id=sa;Password=Hunter2;' }, 'p'),
    (e) => e instanceof FieldOptionSyncContractError,
    'secret-shaped (conn-string) value rejected',
  )
  // benign schema identifiers are NOT flagged
  assert.doesNotThrow(() => assertFieldOptionSyncPresetValuesFree(validPreset(), 'p'), 'clean schema identifiers pass')

  // --- 5. catalog: stock-prep first preset, valid, values-free, §7 defaults, deep-copy ---
  const presets = listFieldOptionSyncPresets()
  assert.ok(presets.length >= 1, 'catalog non-empty')
  const stock = presets[0]
  assert.equal(stock.presetId, 'preset.stock-preparation.v1', 'stock-prep is the first preset / compatibility anchor')
  assert.equal(stock.syncMode, 'replace', 'stock preset syncMode=replace (zero-drift)')
  assert.equal(stock.conflictPolicy, 'update_from_source', 'stock preset conflictPolicy=update_from_source')
  assert.equal(stock.triggerMode, 'manual', 'stock preset triggerMode=manual')
  assert.equal(stock.optionFields.length, 4, 'stock preset covers its 4 option fields')
  assert.ok(stock.optionFields.every((f) => f.valueField && f.targetField), 'each option field has value+target')
  // catalog entries carry no scope/secret/data keys
  for (const p of presets) {
    for (const k of ['tenantId', 'workspaceId', 'sheetId', 'credentials', 'optionValues', 'config', 'sql']) {
      assert.ok(!(k in p), `preset ${p.presetId} must not carry ${k}`)
    }
  }
  // deep copy: mutating the returned list must not corrupt the frozen catalog
  presets[0].optionFields.push({ valueField: '__x__', targetField: '__x__' })
  presets[0].label = 'MUTATED'
  const fresh = listFieldOptionSyncPresets()
  assert.equal(fresh[0].label, 'Stock-preparation option sync', 'catalog label not mutated by caller')
  assert.equal(fresh[0].optionFields.length, 4, 'catalog optionFields not mutated by caller')

  // --- FOS-4b-1: permittedActionIds (enum-strict ∈ registry; default []) ---
  assert.deepEqual(normalizeFieldOptionSyncPreset(validPreset()).permittedActionIds, [], 'permittedActionIds defaults to []')
  assert.deepEqual(
    normalizeFieldOptionSyncPreset(validPreset({ permittedActionIds: ['plm.stock-preparation.pull-bom.v1'] })).permittedActionIds,
    ['plm.stock-preparation.pull-bom.v1'],
    'a registered predefined action is permitted',
  )
  assert.throws(
    () => normalizeFieldOptionSyncPreset(validPreset({ permittedActionIds: ['evil.exec.v1'] })),
    (e) => e instanceof FieldOptionSyncContractError && e.details.field === 'permittedActionIds',
    'unregistered permittedActionId rejected (enum-strict ∈ registry)',
  )
  assert.throws(() => normalizeFieldOptionSyncPreset(validPreset({ permittedActionIds: 'x' })), /must be an array/, 'permittedActionIds must be an array')
  // catalog: every preset's permittedActionIds is a valid array of registered actions; only the
  // FOS-4b-2 with-actions preset permits one (the rest are []).
  const cat = listFieldOptionSyncPresets()
  assert.ok(cat.every((p) => Array.isArray(p.permittedActionIds)), 'every preset has a permittedActionIds array')
  const withActions = cat.find((p) => p.presetId === 'preset.stock-preparation.with-actions.v1')
  assert.deepEqual(withActions.permittedActionIds, ['plm.stock-preparation.pull-bom.v1'], 'with-actions preset permits the registered stock-prep action')
  assert.ok(cat.filter((p) => p.presetId !== 'preset.stock-preparation.with-actions.v1').every((p) => p.permittedActionIds.length === 0), 'all other catalog presets bind no actions')

  console.log('✓ field-option-sync-contract: normalizer + enum-strict + required + values-free(non-vacuous) + catalog + deep-copy + permittedActionIds tests passed')
}

main().catch((e) => {
  console.error('✗ field-option-sync-contract FAILED')
  console.error(e)
  process.exit(1)
})
