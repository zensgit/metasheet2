import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'

import {
  DRAFT_FILE_NAMES,
  SourceDraftEmitterError,
  adaptVendorPresetShape,
  buildCatalogTableIndex,
  scorePresetSignature,
  selectVendorPreset,
  readDictionaryEntries,
  extractOptionSet,
  derivePlaceholderExtFieldId,
  resolveTargets,
  buildExtFieldMappingDraft,
  buildCustomerPackDraft,
  renderDraftReadme,
  buildDraftEmissionSummary,
  assertDraftOutDirOutsideRepo,
  matchesEnabledValue,
  completeDictionarySpec,
  discoverValueSetRefColumn,
  discoverValueSetColumns,
  deriveSemanticExtFieldId,
  fieldTypeForCatalogColumn,
} from './source-discovery-draft-emitter.mjs'

import {
  buildCatalogFromRows,
  assertValuesFree,
  runProbe,
  parseArgs,
  main,
  REPO_ROOT,
} from './source-discovery-probe.mjs'

// The pack + mapper normalizers are CJS plugin internals; requiring them here is the point of the
// "consumable draft" test below — a draft that the real normalizers refuse is not a draft, it is a
// suggestion with extra steps.
const require = createRequire(import.meta.url)
const PLUGIN_LIB = path.join(REPO_ROOT, 'plugins', 'plugin-integration-core', 'lib')
const { normalizeCustomerPack } = require(path.join(PLUGIN_LIB, 'stock-preparation-customer-pack.cjs'))
const { normalizeExtFieldMapping } = require(path.join(PLUGIN_LIB, 'stock-preparation-ext-field-mapping.cjs'))

// ---------------------------------------------------------------------------
// FIXTURE — the vendor family mirrored by scripts/ops/fixtures/
// stock-prep-synthetic-plm/schema.sql, built THROUGH buildCatalogFromRows so the
// row counts travel as the driver actually hands them over: bigint SUM()s arrive
// as STRINGS. That is not decoration — a `typeof` test on this exact shape made
// the probe screen out every table and report "zero dictionaries" against a live
// SQL Server (F13), a false negative shaped precisely like a valid answer. A
// hermetic fixture that cannot reproduce reality proves nothing, so this one
// carries every nasty shape we actually met.
// ---------------------------------------------------------------------------

function catalogRow(tableName, rowCount, columnName, dataType, extra = {}) {
  return {
    schemaName: 'dbo',
    tableName,
    columnName,
    dataType,
    maxLength: null,
    nullable: true,
    isPrimaryKey: false,
    rowCount,
    ...extra,
  }
}

function tableRows(tableName, rowCount, columns) {
  return columns.map(([columnName, dataType, extra]) => catalogRow(tableName, rowCount, columnName, dataType, extra || {}))
}

function buildVendorCatalog(overrides = {}) {
  const rows = [
    // rowCount as a STRING everywhere: the live driver shape.
    ...tableRows('DN_PDM_PartLibraryInfo', '5000', [
      ['OBJ_ID', 'varchar', { isPrimaryKey: true }],
      ['IdentityNo', 'varchar'],
      ['IdentityName', 'nvarchar'],
      ['Material', 'varchar'],
      ['Specification', 'nvarchar'],
      ['SysVer', 'varchar'],
      ['part_ExAttr10', 'nvarchar'],
      ['part_ExAttr11', 'nvarchar'],
      ['part_ExAttr12', 'nvarchar'],
      ['part_ExAttr14', 'nvarchar'],
      ['part_ExAttr20', 'nvarchar'],
      ['part_ExAttr21', 'nvarchar'],
      ['2ndSource', 'nvarchar'],
    ]),
    ...tableRows('DN_PDM_BomHeadInfo', '3000', [
      ['part_id', 'varchar'],
      ['bom_id', 'varchar'],
      ['SysVer', 'varchar'],
      ['bom_able', 'int'],
    ]),
    ...tableRows('DN_PDM_BomDetailsInfo', '40000', [
      ['bom_pid', 'varchar'],
      ['part_id', 'varchar'],
      ['Bom_ExAttr1', 'varchar'],
      ['Bom_ExAttr2', 'varchar'],
      ['sort_id', 'int'],
    ]),
    ...tableRows('DN_PDM_PathInfo', '800', [
      ['OBJ_ID', 'varchar', { isPrimaryKey: true }],
      ['Parent_OBJ_ID', 'varchar'],
    ]),
    ...tableRows('DN_PDM_PathExAttrInfo', '900', [
      ['FileCode', 'varchar'],
      ['Parent_OBJ_ID', 'varchar'],
    ]),
    ...tableRows('DN_PDM_OrderHeadInfo', '10', [
      ['OBJ_ID', 'varchar', { isPrimaryKey: true }],
      ['path_id', 'varchar'],
    ]),
    ...tableRows('DN_PDM_OrderDetailInfo', '70', [
      ['order_id', 'varchar'],
      ['part_id', 'varchar'],
      ['quantity', 'decimal'],
      ['sort_id', 'int'],
    ]),
    // The three dictionary tables. Small, and their counts are strings too.
    ...tableRows('DN_PM_PartExAttrInfo', '73', [
      ['ExAttrCode', 'varchar'],
      ['ExAttrName', 'nvarchar'],
      ['isable', 'int'],
      ['ExAttrType', 'varchar'],
      ['ParamTable', 'varchar'],
    ]),
    ...tableRows('DN_PM_BomExAttrInfo', '30', [
      ['ExAttrCode', 'varchar'],
      ['ExAttrName', 'nvarchar'],
      ['isable', 'int'],
      ['ExAttrType', 'varchar'],
      ['ParamTable', 'varchar'],
    ]),
    ...tableRows('DN_Test_BomParam1', '9', [
      ['name', 'nvarchar'],
      ['isable', 'int'],
    ]),
  ]
  const filtered = overrides.dropTables
    ? rows.filter((r) => !overrides.dropTables.includes(r.tableName))
    : rows
  return buildCatalogFromRows('mssql', filtered)
}

// --- customer VALUES. Every one of these must reach the draft files and none of
// them may reach the probe report. The two assertions are made in both
// directions further down; these constants are the single source for both.
const CUSTOMER_LABELS = Object.freeze({
  materialCode: '物料编码',
  model: '型号',
  brandDisabled: '品牌',
  surface: '表面处理',
  quantity: '数量',
  unit: '单位',
  ghost: '幽灵字段',
  duplicateModel: '重复型号',
  attachment: '附件',
  secondSource: '第二货源',
})
const CUSTOMER_UNIT_VOCABULARY = Object.freeze(['件', '套', '公斤'])

function partExAttrRows() {
  return [
    // isable = 0 means ENABLED on this vendor family (inverted, and that is why
    // the preset — not this code — declares which value means enabled).
    { ExAttrCode: 'part_ExAttr14', ExAttrName: CUSTOMER_LABELS.materialCode, isable: 0, ExAttrType: 'text', ParamTable: null },
    // ENABLED FLAG AS A STRING. Same driver quirk as the bigint row counts: one
    // column, two runtime types, and a typeof test loses every row.
    { ExAttrCode: 'part_ExAttr10', ExAttrName: CUSTOMER_LABELS.model, isable: '0', ExAttrType: 'text', ParamTable: null },
    // A DISABLED row. 52 of 73 look like this on the real instance.
    { ExAttrCode: 'part_ExAttr11', ExAttrName: CUSTOMER_LABELS.brandDisabled, isable: 1, ExAttrType: 'text', ParamTable: null },
    // AN ENABLED SLOT WITH AN EMPTY LABEL. Live shape: the slot is on, nothing
    // says what it means.
    { ExAttrCode: 'part_ExAttr12', ExAttrName: '', isable: 0, ExAttrType: 'text', ParamTable: null },
    { ExAttrCode: 'part_ExAttr20', ExAttrName: CUSTOMER_LABELS.surface, isable: 0, ExAttrType: 'list', ParamTable: 'DN_Test_BomParam1' },
    // A slot naming a column that does not exist on the described table.
    { ExAttrCode: 'part_ExAttrNope', ExAttrName: CUSTOMER_LABELS.ghost, isable: 0, ExAttrType: 'text', ParamTable: null },
    // A SECOND enabled row for a slot already taken.
    { ExAttrCode: 'part_ExAttr10', ExAttrName: CUSTOMER_LABELS.duplicateModel, isable: 0, ExAttrType: 'text', ParamTable: null },
    // A vendor type token the preset's typeMap does not carry.
    { ExAttrCode: 'part_ExAttr21', ExAttrName: CUSTOMER_LABELS.attachment, isable: 0, ExAttrType: 'blob', ParamTable: null },
    // A slot whose column name cannot become an ASCII camelCase identifier.
    { ExAttrCode: '2ndSource', ExAttrName: CUSTOMER_LABELS.secondSource, isable: 0, ExAttrType: 'text', ParamTable: null },
  ]
}

function bomExAttrRows() {
  return [
    { ExAttrCode: 'Bom_ExAttr1', ExAttrName: CUSTOMER_LABELS.quantity, isable: 0, ExAttrType: 'float', ParamTable: null },
    { ExAttrCode: 'Bom_ExAttr2', ExAttrName: CUSTOMER_LABELS.unit, isable: 0, ExAttrType: 'list', ParamTable: 'DN_Test_BomParam1' },
    { ExAttrCode: 'sort_id', ExAttrName: '排序', isable: 1, ExAttrType: 'int', ParamTable: null },
  ]
}

// A VALUE SET WITH DUPLICATE ENTRIES (and a blank, and a disabled row). The pack
// normalizer rejects duplicate option values outright, so a draft that passed
// them through would be a draft that cannot install.
function bomParam1Rows() {
  return [
    { name: CUSTOMER_UNIT_VOCABULARY[0], isable: 0 },
    { name: CUSTOMER_UNIT_VOCABULARY[1], isable: 0 },
    { name: CUSTOMER_UNIT_VOCABULARY[0], isable: 0 },
    { name: '', isable: 0 },
    { name: CUSTOMER_UNIT_VOCABULARY[2], isable: '0' },
    { name: CUSTOMER_UNIT_VOCABULARY[1], isable: 0 },
    { name: '打', isable: 1 },
  ]
}

function rawVendorPreset(overrides = {}) {
  return {
    presetId: 'dn-pdm-plm',
    presetVersion: 1,
    vendor: 'dn-pdm',
    label: 'DN_PDM PLM',
    matches: {
      requiredTables: [
        'DN_PDM_PartLibraryInfo',
        'DN_PDM_BomHeadInfo',
        'DN_PDM_BomDetailsInfo',
        'DN_PM_PartExAttrInfo',
        'DN_PM_BomExAttrInfo',
      ],
      optionalTables: ['DN_PDM_PathInfo', 'DN_PDM_PathExAttrInfo', 'DN_PDM_OrderHeadInfo', 'DN_PDM_OrderDetailInfo'],
      minimumConfidence: 0.8,
    },
    mappingSourceTable: 'DN_PDM_PartLibraryInfo',
    dictionaries: [
      {
        key: 'partExAttr',
        table: 'DN_PM_PartExAttrInfo',
        describesTable: 'DN_PDM_PartLibraryInfo',
        slotColumn: 'ExAttrCode',
        labelColumn: 'ExAttrName',
        enabledColumn: 'isable',
        enabledValues: [0],
        typeColumn: 'ExAttrType',
        valueSetColumn: 'ParamTable',
      },
      {
        key: 'bomExAttr',
        table: 'DN_PM_BomExAttrInfo',
        describesTable: 'DN_PDM_BomDetailsInfo',
        slotColumn: 'ExAttrCode',
        labelColumn: 'ExAttrName',
        enabledColumn: 'isable',
        enabledValues: [0],
        typeColumn: 'ExAttrType',
        valueSetColumn: 'ParamTable',
      },
    ],
    valueSets: [{ key: 'bomParam1', table: 'DN_Test_BomParam1', valueColumn: 'name', enabledColumn: 'isable', enabledValues: [0] }],
    typeMap: { text: 'string', float: 'number', list: 'select', date: 'date' },
    targets: [
      { target: 'ext_drawingNo', via: 'native', table: 'DN_PDM_PartLibraryInfo', column: 'IdentityNo', type: 'string', label: '图号' },
      { target: 'ext_partLabel', via: 'native', table: 'DN_PDM_PartLibraryInfo', column: 'IdentityName', type: 'string', label: '名称' },
      { target: 'ext_specification', via: 'native', table: 'DN_PDM_PartLibraryInfo', column: 'Specification', type: 'string', label: '规格' },
      // A column this vendor family sometimes has and this customer does not.
      { target: 'ext_legacyErpCode', via: 'native', table: 'DN_PDM_PartLibraryInfo', column: 'invcode', type: 'string', label: 'ERP编码' },
      { target: 'ext_materialCode', via: 'dictionary', dictionary: 'partExAttr', labelAliases: ['物料编码', '料号'] },
      { target: 'ext_surfaceTreatment', via: 'dictionary', dictionary: 'partExAttr', labelAliases: ['表面处理'], valueSet: 'bomParam1' },
      // Nothing in this customer's dictionary carries this label.
      { target: 'ext_heatTreatment', via: 'dictionary', dictionary: 'partExAttr', labelAliases: ['热处理'] },
      // Resolvable, but off the BOM-detail row — deferred, never silently dropped.
      { target: 'ext_quantity', via: 'dictionary', dictionary: 'bomExAttr', labelAliases: ['数量'] },
      { target: 'ext_unit', via: 'dictionary', dictionary: 'bomExAttr', labelAliases: ['单位'], valueSet: 'bomParam1' },
    ],
    ...overrides,
  }
}

function buildFixtureSampleFn({ trackCalls } = {}) {
  const rowsByTable = {
    'dbo.DN_PM_PartExAttrInfo': partExAttrRows(),
    'dbo.DN_PM_BomExAttrInfo': bomExAttrRows(),
    'dbo.DN_Test_BomParam1': bomParam1Rows(),
    'dbo.DN_PDM_OrderHeadInfo': [{ OBJ_ID: 'o-1', path_id: 'p-1' }],
    'dbo.DN_PDM_OrderDetailInfo': [{ order_id: 'o-1', part_id: 'x', quantity: 1, sort_id: 1 }],
  }
  return async ({ table, cap }) => {
    const key = `${table.schema}.${table.name}`
    if (trackCalls) trackCalls[key] = (trackCalls[key] || 0) + 1
    return (rowsByTable[key] || []).slice(0, cap)
  }
}

function fixtureResolution() {
  const catalog = buildVendorCatalog()
  const tableIndex = buildCatalogTableIndex(catalog)
  const preset = adaptVendorPresetShape(rawVendorPreset())
  const partSpec = preset.dictionaries.get('partExAttr')
  const bomSpec = preset.dictionaries.get('bomExAttr')
  const partRead = readDictionaryEntries({
    spec: partSpec,
    rows: partExAttrRows(),
    describedColumns: tableIndex.columnsOf(tableIndex.resolve('DN_PDM_PartLibraryInfo').table),
  })
  const bomRead = readDictionaryEntries({
    spec: bomSpec,
    rows: bomExAttrRows(),
    describedColumns: tableIndex.columnsOf(tableIndex.resolve('DN_PDM_BomDetailsInfo').table),
  })
  const entriesByDictionary = new Map([
    ['partExAttr', { ok: true, ...partRead }],
    ['bomExAttr', { ok: true, ...bomRead }],
  ])
  const optionSets = new Map([
    ['bomParam1', extractOptionSet({ spec: preset.valueSets.get('bomParam1'), rows: bomParam1Rows() })],
  ])
  const resolution = resolveTargets({ preset, tableIndex, entriesByDictionary })
  return { catalog, tableIndex, preset, resolution, optionSets, partRead, bomRead, entriesByDictionary }
}

// ---------------------------------------------------------------------------
// The adapter — the single reconciliation point with the sibling preset schema.
// ---------------------------------------------------------------------------

describe('adaptVendorPresetShape (the one preset-shape assumption)', () => {
  test('normalizes the vendor preset into the internal shape', () => {
    const preset = adaptVendorPresetShape(rawVendorPreset())
    assert.equal(preset.presetId, 'dn-pdm-plm')
    assert.equal(preset.mappingSourceTable, 'DN_PDM_PartLibraryInfo')
    assert.equal(preset.dictionaries.size, 2)
    assert.equal(preset.valueSets.size, 1)
    assert.equal(preset.targets.length, 9)
    assert.equal(preset.signature.requiredTables.length, 5)
    assert.equal(preset.signature.minimumConfidence, 0.8)
  })

  test('a preset with no required tables would match every database — refused', () => {
    assert.throws(
      () => adaptVendorPresetShape(rawVendorPreset({ matches: { requiredTables: [] } })),
      (err) => err instanceof SourceDraftEmitterError && err.reason === 'PRESET_MATCHES_INVALID',
    )
  })

  test('an enabled COLUMN with no enabled VALUES would make the filter a no-op — refused', () => {
    const raw = rawVendorPreset()
    raw.dictionaries[0] = { ...raw.dictionaries[0], enabledValues: [] }
    assert.throws(
      () => adaptVendorPresetShape(raw),
      (err) => err instanceof SourceDraftEmitterError && err.reason === 'PRESET_DICTIONARY_INVALID',
    )
  })

  test('a dictionary target with no label aliases has nothing to be justified BY — refused', () => {
    const raw = rawVendorPreset()
    raw.targets = [{ target: 'ext_materialCode', via: 'dictionary', dictionary: 'partExAttr', labelAliases: [] }]
    assert.throws(
      () => adaptVendorPresetShape(raw),
      (err) => err instanceof SourceDraftEmitterError && err.reason === 'PRESET_TARGET_INVALID',
    )
  })

  test('a preset id that cannot seed a legal packId is refused up front', () => {
    assert.throws(
      () => adaptVendorPresetShape(rawVendorPreset({ presetId: 'DN PDM!' })),
      (err) => err.reason === 'PRESET_ID_INVALID',
    )
  })

  test('a target id outside the ext_ camelCase namespace is refused', () => {
    const raw = rawVendorPreset()
    raw.targets = [{ target: 'ext_物料编码', via: 'native', table: 'DN_PDM_PartLibraryInfo', column: 'IdentityNo' }]
    assert.throws(() => adaptVendorPresetShape(raw), (err) => err.reason === 'PRESET_TARGET_INVALID')
  })

  test('mappingSourceTable is mandatory — the mapper is handed exactly one row', () => {
    const raw = rawVendorPreset()
    delete raw.mappingSourceTable
    assert.throws(() => adaptVendorPresetShape(raw), (err) => err.reason === 'PRESET_MAPPING_SOURCE_TABLE_MISSING')
  })
})

// ---------------------------------------------------------------------------
// Vendor signature — NEVER GUESS A VENDOR.
// ---------------------------------------------------------------------------

describe('preset signature', () => {
  test('the vendor catalog clears the preset signature at confidence 1.00', () => {
    const tableIndex = buildCatalogTableIndex(buildVendorCatalog())
    const score = scorePresetSignature({ preset: adaptVendorPresetShape(rawVendorPreset()), tableIndex })
    assert.equal(score.confidence, 1)
    assert.equal(score.matchedRequiredTableCount, 5)
    assert.equal(score.meetsThreshold, true)
  })

  test('SIGNATURE REFUSAL: a catalog missing two required tables is refused, not guessed', () => {
    const catalog = buildVendorCatalog({ dropTables: ['DN_PM_PartExAttrInfo', 'DN_PM_BomExAttrInfo'] })
    const tableIndex = buildCatalogTableIndex(catalog)
    const preset = adaptVendorPresetShape(rawVendorPreset())
    const score = scorePresetSignature({ preset, tableIndex })
    assert.equal(score.confidence, 0.6)
    assert.equal(score.meetsThreshold, false)

    const selection = selectVendorPreset({ presets: [preset], tableIndex })
    assert.equal(selection.ok, false)
    assert.equal(selection.reason, 'PRESET_SIGNATURE_NOT_MET')
    // The refusal names what it looked for, so an operator can act on it.
    assert.equal(score.missingRequired.length, 2)
    assert.ok(score.missingRequired.every((m) => m.reason === 'TABLE_ABSENT'))
  })

  test('SIGNATURE REFUSAL: two presets tying at the top is AMBIGUOUS, never a coin flip', () => {
    const tableIndex = buildCatalogTableIndex(buildVendorCatalog())
    const a = adaptVendorPresetShape(rawVendorPreset())
    const b = adaptVendorPresetShape(rawVendorPreset({ presetId: 'dn-pdm-clone' }))
    const selection = selectVendorPreset({ presets: [a, b], tableIndex })
    assert.equal(selection.ok, false)
    assert.equal(selection.reason, 'PRESET_SIGNATURE_AMBIGUOUS')
  })

  test('an empty preset set is refused rather than treated as "no constraints"', () => {
    const tableIndex = buildCatalogTableIndex(buildVendorCatalog())
    assert.equal(selectVendorPreset({ presets: [], tableIndex }).reason, 'PRESET_SET_EMPTY')
  })

  test('a forbidden table present disqualifies outright (confidence 0)', () => {
    const tableIndex = buildCatalogTableIndex(buildVendorCatalog())
    const preset = adaptVendorPresetShape(
      rawVendorPreset({
        matches: { ...rawVendorPreset().matches, forbiddenTables: ['DN_PDM_PathInfo'] },
      }),
    )
    const score = scorePresetSignature({ preset, tableIndex })
    assert.equal(score.confidence, 0)
    assert.equal(score.meetsThreshold, false)
  })

  test('a bare table name matching two schemas is AMBIGUOUS, never first-wins', () => {
    const rows = [
      ...tableRows('DN_PM_PartExAttrInfo', '10', [['ExAttrCode', 'varchar']]),
      { schemaName: 'other', tableName: 'DN_PM_PartExAttrInfo', columnName: 'ExAttrCode', dataType: 'varchar', maxLength: null, nullable: true, isPrimaryKey: false, rowCount: '10' },
    ]
    const tableIndex = buildCatalogTableIndex(buildCatalogFromRows('mssql', rows))
    const hit = tableIndex.resolve('DN_PM_PartExAttrInfo')
    assert.equal(hit.ok, false)
    assert.equal(hit.reason, 'TABLE_AMBIGUOUS')
    // ...and a fully-qualified reference still resolves.
    assert.equal(tableIndex.resolve('dbo.DN_PM_PartExAttrInfo').ok, true)
  })
})

// ---------------------------------------------------------------------------
// Dictionary reading — enabled rows only, and every drop counted by reason.
// ---------------------------------------------------------------------------

describe('readDictionaryEntries', () => {
  test('enabled-row filtering keeps only the live slots and counts every drop by reason', () => {
    const { partRead } = fixtureResolution()
    const slots = partRead.entries.map((e) => e.slot)
    assert.deepEqual(slots, ['part_ExAttr14', 'part_ExAttr10', 'part_ExAttr20', 'part_ExAttr21', '2ndSource'])

    // A DISABLED row is not a non-event: it is counted.
    assert.equal(partRead.skippedByReason.ROW_DISABLED, 1)
    // An ENABLED slot with an EMPTY LABEL is a GAP, reported, never silently gone.
    assert.equal(partRead.skippedByReason.ROW_LABEL_EMPTY, 1)
    // A slot naming a column that does not exist on the described table.
    assert.equal(partRead.skippedByReason.ROW_SLOT_NOT_A_COLUMN, 1)
    // A second enabled row for an already-taken slot.
    assert.equal(partRead.skippedByReason.ROW_SLOT_DUPLICATE, 1)
    assert.equal(partRead.skipped.length, 4)
    assert.equal(partRead.entries.length + partRead.skipped.length, partExAttrRows().length)
  })

  test('BIGINT-AS-STRING: an enabled flag arriving as "0" is as enabled as 0', () => {
    const { partRead } = fixtureResolution()
    const model = partRead.entries.find((e) => e.slot === 'part_ExAttr10')
    assert.ok(model, 'the row whose isable arrived as the STRING "0" must be read as ENABLED')
    assert.equal(model.label, CUSTOMER_LABELS.model)
    assert.equal(matchesEnabledValue('0', ['0']), true)
    assert.equal(matchesEnabledValue(0, ['0']), true)
    assert.equal(matchesEnabledValue(0n, ['0']), true)
    assert.equal(matchesEnabledValue(1, ['0']), false)
    assert.equal(matchesEnabledValue(null, ['0']), false)
  })

  test('the slot spelling comes from the CATALOG, not from the dictionary cell', () => {
    const tableIndex = buildCatalogTableIndex(buildVendorCatalog())
    const preset = adaptVendorPresetShape(rawVendorPreset())
    const read = readDictionaryEntries({
      spec: preset.dictionaries.get('partExAttr'),
      // The dictionary cell is lower-cased; the catalog spells it `part_ExAttr14`.
      rows: [{ ExAttrCode: 'PART_EXATTR14', ExAttrName: '料号', isable: 0, ExAttrType: 'text' }],
      describedColumns: tableIndex.columnsOf(tableIndex.resolve('DN_PDM_PartLibraryInfo').table),
    })
    assert.equal(read.entries[0].slot, 'part_ExAttr14')
  })

  test('a dictionary with no enabled column reads every row (and the preset must then say so)', () => {
    const tableIndex = buildCatalogTableIndex(buildVendorCatalog())
    const raw = rawVendorPreset()
    raw.dictionaries[0] = { ...raw.dictionaries[0], enabledColumn: null, enabledValues: [] }
    const preset = adaptVendorPresetShape(raw)
    const read = readDictionaryEntries({
      spec: preset.dictionaries.get('partExAttr'),
      rows: partExAttrRows(),
      describedColumns: tableIndex.columnsOf(tableIndex.resolve('DN_PDM_PartLibraryInfo').table),
    })
    assert.equal(read.skippedByReason.ROW_DISABLED, undefined)
    assert.ok(read.entries.some((e) => e.label === CUSTOMER_LABELS.brandDisabled))
  })
})

// ---------------------------------------------------------------------------
// Option sets.
// ---------------------------------------------------------------------------

describe('extractOptionSet', () => {
  test('duplicates are collapsed and COUNTED; blanks and disabled rows are counted too', () => {
    const preset = adaptVendorPresetShape(rawVendorPreset())
    const result = extractOptionSet({ spec: preset.valueSets.get('bomParam1'), rows: bomParam1Rows() })
    assert.equal(result.ok, true)
    assert.deepEqual(result.options.map((o) => o.value), [...CUSTOMER_UNIT_VOCABULARY])
    assert.equal(result.duplicateCount, 2)
    assert.equal(result.emptyCount, 1)
    assert.equal(result.disabledCount, 1)
  })

  test('an empty vocabulary is refused, not emitted as a silently empty set', () => {
    const preset = adaptVendorPresetShape(rawVendorPreset())
    const result = extractOptionSet({ spec: preset.valueSets.get('bomParam1'), rows: [{ name: '', isable: 0 }] })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'VALUE_SET_EMPTY')
  })

  test('a vocabulary over the pack cap is refused HERE rather than at install time', () => {
    const preset = adaptVendorPresetShape(rawVendorPreset())
    const rows = Array.from({ length: 250 }, (_, i) => ({ name: `v${i}`, isable: 0 }))
    const result = extractOptionSet({ spec: preset.valueSets.get('bomParam1'), rows })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'VALUE_SET_OVER_CAP')
    assert.equal(result.maxOptions, 200)
  })
})

// ---------------------------------------------------------------------------
// Placeholder ids — mechanical, from the COLUMN NAME, never from the label.
// ---------------------------------------------------------------------------

describe('derivePlaceholderExtFieldId', () => {
  test('a slot column name becomes a mechanical camelCase id', () => {
    assert.deepEqual(derivePlaceholderExtFieldId('part_ExAttr10'), { ok: true, fieldId: 'ext_partExAttr10' })
    assert.deepEqual(derivePlaceholderExtFieldId('Bom_ExAttr1'), { ok: true, fieldId: 'ext_bomExAttr1' })
  })

  test('a slot that cannot become an ASCII identifier is UNRESOLVED, never transliterated', () => {
    assert.equal(derivePlaceholderExtFieldId('2ndSource').ok, false)
    assert.equal(derivePlaceholderExtFieldId('规格型号').reason, 'PLACEHOLDER_ID_UNDERIVABLE')
    assert.equal(derivePlaceholderExtFieldId('').reason, 'PLACEHOLDER_ID_UNDERIVABLE')
  })
})

// ---------------------------------------------------------------------------
// Target resolution — the fail-closed rule.
// ---------------------------------------------------------------------------

describe('resolveTargets', () => {
  test('a native target is justified by the CATALOG and cites it in its basis', () => {
    const { resolution } = fixtureResolution()
    const hit = resolution.resolved.find((r) => r.target === 'ext_drawingNo')
    assert.ok(hit)
    assert.equal(hit.via, 'native')
    assert.equal(hit.sourceColumn, 'IdentityNo')
    assert.equal(hit.idKind, 'preset-declared')
    assert.match(hit.basis, /catalog: column dbo\.DN_PDM_PartLibraryInfo\.IdentityNo \(varchar\) exists/)
  })

  test('FAIL-CLOSED: an absent native column is UNRESOLVED and is never matched to a similar name', () => {
    const { resolution } = fixtureResolution()
    assert.equal(resolution.resolved.find((r) => r.target === 'ext_legacyErpCode'), undefined)
    const gap = resolution.unresolved.find((u) => u.target === 'ext_legacyErpCode')
    assert.ok(gap, 'an absent native column must appear as an explicit gap')
    assert.equal(gap.reason, 'NATIVE_COLUMN_ABSENT')
    assert.equal(gap.lookedFor, 'DN_PDM_PartLibraryInfo.invcode')
    // The catalog carries IdentityNo / Material / Specification. None of them was
    // silently substituted for the missing `invcode`.
    for (const item of resolution.resolved) {
      assert.notEqual(item.target, 'ext_legacyErpCode')
    }
  })

  test('a dictionary target is justified by an ENABLED row and cites that row in its basis', () => {
    const { resolution } = fixtureResolution()
    const hit = resolution.resolved.find((r) => r.target === 'ext_materialCode')
    assert.ok(hit)
    assert.equal(hit.sourceColumn, 'part_ExAttr14')
    assert.equal(hit.type, 'string')
    assert.equal(hit.typeSource, 'preset-typeMap')
    // The customer's own label wins over the preset alias.
    assert.equal(hit.label, CUSTOMER_LABELS.materialCode)
    assert.match(hit.basis, /DN_PM_PartExAttrInfo row #0: slot="part_ExAttr14"/)
    assert.match(hit.basis, /label matched|label equals preset alias/)
  })

  test('FAIL-CLOSED: a label no enabled row carries is UNRESOLVED with what was looked for', () => {
    const { resolution } = fixtureResolution()
    const gap = resolution.unresolved.find((u) => u.target === 'ext_heatTreatment')
    assert.ok(gap)
    assert.equal(gap.reason, 'DICTIONARY_NO_ALIAS_MATCH')
    assert.match(gap.lookedFor, /DN_PM_PartExAttrInfo\.ExAttrName in \[热处理\]/)
    assert.match(gap.lookedFor, /enabled rows read/)
  })

  test('FAIL-CLOSED: two enabled rows claiming one meaning is AMBIGUOUS, not a pick', () => {
    const tableIndex = buildCatalogTableIndex(buildVendorCatalog())
    const preset = adaptVendorPresetShape(rawVendorPreset())
    const read = readDictionaryEntries({
      spec: preset.dictionaries.get('partExAttr'),
      rows: [
        { ExAttrCode: 'part_ExAttr14', ExAttrName: '物料编码', isable: 0, ExAttrType: 'text' },
        { ExAttrCode: 'part_ExAttr20', ExAttrName: '物料编码', isable: 0, ExAttrType: 'text' },
      ],
      describedColumns: tableIndex.columnsOf(tableIndex.resolve('DN_PDM_PartLibraryInfo').table),
    })
    const resolution = resolveTargets({
      preset,
      tableIndex,
      entriesByDictionary: new Map([['partExAttr', { ok: true, ...read }], ['bomExAttr', { ok: false, reason: 'DICTIONARY_NOT_READ' }]]),
    })
    const gap = resolution.unresolved.find((u) => u.target === 'ext_materialCode')
    assert.equal(gap.reason, 'DICTIONARY_AMBIGUOUS_ALIAS_MATCH')
    assert.equal(gap.candidates.length, 2)
    assert.deepEqual(gap.candidates.map((c) => c.slot), ['part_ExAttr14', 'part_ExAttr20'])
    assert.equal(resolution.resolved.find((r) => r.target === 'ext_materialCode'), undefined)
  })

  test('a dictionary that could not be read leaves its targets UNRESOLVED with the read reason', () => {
    const tableIndex = buildCatalogTableIndex(buildVendorCatalog())
    const preset = adaptVendorPresetShape(rawVendorPreset())
    const resolution = resolveTargets({
      preset,
      tableIndex,
      entriesByDictionary: new Map([
        ['partExAttr', { ok: false, reason: 'ROW_CAP_REFUSED' }],
        ['bomExAttr', { ok: false, reason: 'ROW_CAP_REFUSED' }],
      ]),
    })
    const gap = resolution.unresolved.find((u) => u.target === 'ext_materialCode')
    assert.equal(gap.reason, 'ROW_CAP_REFUSED')
    assert.equal(resolution.unclaimed.length, 0)
  })

  test('an unclaimed enabled row becomes a clearly-marked PLACEHOLDER proposal', () => {
    const { resolution } = fixtureResolution()
    const placeholder = resolution.resolved.find((r) => r.target === 'ext_partExAttr10')
    assert.ok(placeholder, 'an enabled slot no target claimed must still be proposed')
    assert.equal(placeholder.idKind, 'placeholder-from-slot')
    assert.equal(placeholder.sourceColumn, 'part_ExAttr10')
    assert.equal(placeholder.label, CUSTOMER_LABELS.model)
    assert.match(placeholder.basis, /claimed by no preset target/)
    assert.ok(resolution.unclaimed.some((u) => u.target === 'ext_partExAttr10'))
  })

  test('an unmapped vendor type token and an underivable id are UNRESOLVED, not defaulted', () => {
    const { resolution } = fixtureResolution()
    const typeGap = resolution.unresolved.find((u) => u.reason === 'DICTIONARY_TYPE_UNMAPPED')
    assert.ok(typeGap, 'a dictionary type token the preset does not map must be a gap')
    assert.equal(typeGap.target, 'ext_partExAttr21')
    const idGap = resolution.unresolved.find((u) => u.reason === 'PLACEHOLDER_ID_UNDERIVABLE')
    assert.ok(idGap, 'a slot that cannot become an ASCII id must be a gap')
    assert.match(idGap.lookedFor, /2ndSource/)
  })

  test('a resolved target off the wrong row is DEFERRED, never emitted into the mapping', () => {
    const { resolution } = fixtureResolution()
    const quantity = resolution.deferred.find((d) => d.target === 'ext_quantity')
    assert.ok(quantity, 'a BOM-detail column cannot be a mapping entry — it must be deferred loudly')
    assert.equal(quantity.reason, 'SOURCE_TABLE_NOT_THE_MAPPED_ROW')
    assert.equal(quantity.sourceColumn, 'Bom_ExAttr1')
    assert.equal(resolution.mappable.find((m) => m.target === 'ext_quantity'), undefined)
    // ...and everything mappable really is on the mapped row.
    for (const item of resolution.mappable) {
      assert.equal(item.sourceTable, 'dbo.DN_PDM_PartLibraryInfo')
    }
  })
})

// ---------------------------------------------------------------------------
// Draft artifacts — loud about gaps, and actually consumable.
// ---------------------------------------------------------------------------

describe('draft artifacts', () => {
  test('the mapping draft carries one basis per proposal and every gap explicitly', () => {
    const { preset, resolution } = fixtureResolution()
    const draft = buildExtFieldMappingDraft({ preset, resolution, generatedAt: '2026-08-31T00:00:00.000Z' })

    assert.equal(draft.$draftStatus, 'CONFIRM-REQUIRED')
    assert.equal(draft.stockPreparationExtFieldMapping.mappings.length, resolution.mappable.length)
    for (const entry of draft.stockPreparationExtFieldMapping.mappings) {
      // Exactly the mapper's closed entry key set — no extra keys to strip.
      assert.deepEqual(Object.keys(entry).sort(), ['sourceColumn', 'target'])
      const basis = draft.$basis[entry.target]
      assert.ok(basis, `every proposed entry must carry a basis (${entry.target})`)
      assert.ok(basis.basis.length > 0)
      assert.ok(basis.confirmRequired.length > 0)
    }
    // LOUD GAPS: the unresolved and deferred lists are in the file itself, not
    // only in the prose alongside it.
    assert.ok(draft.$unresolved.length >= 4)
    assert.ok(draft.$unresolved.every((u) => typeof u.reason === 'string' && u.reason.length > 0))
    assert.ok(draft.$deferred.some((d) => d.target === 'ext_quantity'))
  })

  test('LOUD GAPS: a draft that resolved nothing says so instead of looking plausible', () => {
    const tableIndex = buildCatalogTableIndex(buildVendorCatalog({ dropTables: ['DN_PDM_PartLibraryInfo'] }))
    const preset = adaptVendorPresetShape(rawVendorPreset())
    const resolution = resolveTargets({
      preset,
      tableIndex,
      entriesByDictionary: new Map([
        ['partExAttr', { ok: false, reason: 'TABLE_ABSENT' }],
        ['bomExAttr', { ok: false, reason: 'TABLE_ABSENT' }],
      ]),
    })
    const draft = buildExtFieldMappingDraft({ preset, resolution, generatedAt: 'x' })
    assert.equal(draft.stockPreparationExtFieldMapping.mappings.length, 0)
    assert.equal(draft.$draftStatus, 'EMPTY — NOTHING WAS RESOLVED')
    assert.equal(draft.$unresolved.length, preset.targets.length)
  })

  test('the pack draft carries the customer labels, the deduped vocabulary and its own gaps', () => {
    const { preset, resolution, optionSets } = fixtureResolution()
    const draft = buildCustomerPackDraft({ preset, resolution, optionSets, generatedAt: 'x' })
    const pack = draft.stockPreparationCustomerPacks['dn-pdm-plm']

    assert.equal(pack.extensionFields.length, resolution.resolved.length)
    const materialCode = pack.extensionFields.find((f) => f.id === 'ext_materialCode')
    assert.equal(materialCode.label, CUSTOMER_LABELS.materialCode)
    assert.equal(materialCode.ownership, 'plm_system')

    const unitSet = pack.optionSets.find((s) => s.fieldId === 'ext_surfaceTreatment')
    assert.ok(unitSet, 'a select field with a readable value set must get its option set')
    assert.deepEqual(unitSet.options.map((o) => o.value), [...CUSTOMER_UNIT_VOCABULARY])

    // targetObjectId is DELIBERATELY absent — a draft may not choose where it installs.
    assert.equal(Object.prototype.hasOwnProperty.call(pack, 'targetObjectId'), false)
    assert.ok(draft.$confirmRequired.some((line) => line.includes('targetObjectId')))
    assert.equal(draft.$fieldBasis.length, resolution.resolved.length)
  })

  test('a select field whose value set could not be read gets an EXPLICIT gap, not a silent field', () => {
    const { preset, resolution } = fixtureResolution()
    const draft = buildCustomerPackDraft({ preset, resolution, optionSets: new Map(), generatedAt: 'x' })
    assert.ok(draft.$optionSetGaps.some((g) => g.fieldId === 'ext_surfaceTreatment'))
    const pack = draft.stockPreparationCustomerPacks['dn-pdm-plm']
    assert.equal(pack.optionSets.length, 0)
    assert.ok(pack.extensionFields.some((f) => f.id === 'ext_surfaceTreatment' && f.type === 'select'))
  })

  test('CONSUMABLE: the drafts pass the REAL pack and mapper normalizers unchanged', () => {
    const { preset, resolution, optionSets } = fixtureResolution()
    const packDraft = buildCustomerPackDraft({ preset, resolution, optionSets, generatedAt: 'x' })
    const mappingDraft = buildExtFieldMappingDraft({ preset, resolution, generatedAt: 'x' })

    const pack = normalizeCustomerPack(packDraft.stockPreparationCustomerPacks['dn-pdm-plm'])
    assert.equal(pack.packId, 'dn-pdm-plm')

    // The config module peels `packId` off and hands the rest to the mapper verbatim.
    const { packId, ...mappingInput } = mappingDraft.stockPreparationExtFieldMapping
    assert.equal(packId, 'dn-pdm-plm')
    const mapping = normalizeExtFieldMapping(mappingInput, { pack })
    assert.equal(mapping.mappings.length, resolution.mappable.length)
    assert.ok(mapping.targetFieldIds.includes('ext_materialCode'))
    // The coercion is DERIVED from the pack type the draft proposed.
    assert.equal(mapping.mappings.find((m) => m.target === 'ext_materialCode').coerce, 'string')
  })

  test('the README states proposed / basis / CONFIRM-REQUIRED per entry and lists every gap', () => {
    const { preset, resolution, optionSets, partRead, bomRead } = fixtureResolution()
    const readme = renderDraftReadme({
      preset,
      score: scorePresetSignature({ preset, tableIndex: buildCatalogTableIndex(buildVendorCatalog()) }),
      resolution,
      optionSets,
      dictionaryReads: [
        { key: 'partExAttr', table: 'DN_PM_PartExAttrInfo', describesTable: 'DN_PDM_PartLibraryInfo', ok: true, rowsRead: 9, ...partRead },
        { key: 'bomExAttr', table: 'DN_PM_BomExAttrInfo', describesTable: 'DN_PDM_BomDetailsInfo', ok: true, rowsRead: 3, ...bomRead },
      ],
      generatedAt: 'x',
    })

    assert.match(readme, /CONFIRM BEFORE USE/)
    assert.match(readme, /CONFIRM-REQUIRED/)
    // Every proposal and every gap is named in the file.
    for (const item of resolution.mappable) {
      assert.ok(readme.includes(item.target), `README must name proposal ${item.target}`)
      assert.ok(readme.includes(item.basis.slice(0, 40)), `README must carry the basis for ${item.target}`)
    }
    for (const gap of resolution.unresolved) {
      assert.ok(readme.includes(gap.reason), `README must name gap reason ${gap.reason}`)
    }
    assert.match(readme, /ROW_LABEL_EMPTY=1/)
    assert.match(readme, /ROW_DISABLED=1/)
    assert.match(readme, /Deferred/)
  })
})

// ---------------------------------------------------------------------------
// THE VALUES SPLIT — values land in the draft, values do NOT land in the report.
// ---------------------------------------------------------------------------

const ALL_CUSTOMER_VALUES = Object.freeze([...Object.values(CUSTOMER_LABELS), ...CUSTOMER_UNIT_VOCABULARY])

// WHOLE-LEAF, never a naive substring — the same precision the probe's own leak guard had to be
// tuned to. A raw `serialized.includes('件')` fires inside the label '附件' that the report is
// ENTITLED to emit (a matched dictionary row's decoded label, which is pre-existing, documented
// probe behaviour), so a substring assertion here would assert something false and then be
// "fixed" by weakening the code. A leaked value arrives as its own leaf.
function stringLeaves(value, out = []) {
  if (value === null || value === undefined) return out
  if (typeof value === 'string') { out.push(value); return out }
  if (Array.isArray(value)) { for (const item of value) stringLeaves(item, out); return out }
  if (typeof value === 'object') { for (const v of Object.values(value)) stringLeaves(v, out) }
  return out
}

function hasNonAscii(text) {
  for (const ch of String(text)) if (ch.codePointAt(0) > 127) return true
  return false
}

// Three labels that must NOT reach the draft either, each for its own reason:
//   brandDisabled  — the customer's own dictionary says that slot is OFF. Proposing it would be the
//                    emitter overriding the customer's configuration.
//   ghost          — its slot names no column on the described table, so the row is not a verified
//                    schema-identifier row and nothing on it may travel (the probe's own row-level
//                    leak-guard rule, applied to the draft path).
//   duplicateModel — a second enabled row for a slot already taken; first-wins is recorded as a
//                    ROW_SLOT_DUPLICATE count, and the losing row's text is not needed to act on it.
const NEVER_IN_THE_DRAFT = new Set([
  CUSTOMER_LABELS.brandDisabled,
  CUSTOMER_LABELS.ghost,
  CUSTOMER_LABELS.duplicateModel,
])

describe('values in the draft, values NOT in the report', () => {
  test('buildDraftEmissionSummary carries identifiers and counts, never a label or an option value', () => {
    const { preset, resolution, optionSets, partRead, bomRead } = fixtureResolution()
    const summary = buildDraftEmissionSummary({
      preset,
      score: scorePresetSignature({ preset, tableIndex: buildCatalogTableIndex(buildVendorCatalog()) }),
      resolution,
      optionSets,
      dictionaryReads: [
        { key: 'partExAttr', table: 'DN_PM_PartExAttrInfo', describesTable: 'DN_PDM_PartLibraryInfo', ok: true, rowsRead: 9, ...partRead },
        { key: 'bomExAttr', table: 'DN_PM_BomExAttrInfo', describesTable: 'DN_PDM_BomDetailsInfo', ok: true, rowsRead: 3, ...bomRead },
      ],
    })
    const serialized = JSON.stringify(summary)
    for (const value of ALL_CUSTOMER_VALUES) {
      assert.equal(serialized.includes(value), false, `summary must not carry the customer value "${value}"`)
    }
    // ...while still saying enough to act on.
    assert.equal(summary.targetCounts.unresolved, resolution.unresolved.length)
    assert.equal(summary.optionSets[0].duplicateCount, 2)
    assert.ok(summary.resolvedTargets.some((t) => t.sourceColumn === 'part_ExAttr14'))
  })

  test('runProbe puts the draft summary in the report and keeps the report values-free', async () => {
    const catalog = buildVendorCatalog()
    const sampleFn = buildFixtureSampleFn()
    const presets = [adaptVendorPresetShape(rawVendorPreset())]
    const { report, leakGuardValues, draft } = await runProbe({ catalog, sampleFn, presets })

    assert.ok(report.draftEmission, 'the report must carry the values-free draft summary')
    assert.equal(report.draftEmission.presetId, 'dn-pdm-plm')

    // The section the draft mode ADDS to the report carries no customer text at all — not a label,
    // not an option value, not prose that could contain one. Asserted as "zero non-ASCII characters
    // anywhere in it", which is the strongest form of the claim and cannot be satisfied by accident.
    assert.equal(hasNonAscii(JSON.stringify(report.draftEmission)), false)

    // The OPTION VOCABULARY is read only by the draft mode (from a value-set table the generic
    // dictionary heuristic screens out), so it must not appear as a leaf anywhere in the report.
    const leaves = stringLeaves(report).map((leaf) => leaf.trim())
    for (const value of CUSTOMER_UNIT_VOCABULARY) {
      assert.equal(leaves.includes(value), false, `report must not carry the option value "${value}" as a leaf`)
    }
    // BOUNDARY, stated rather than implied: a matched dictionary row's decoded label IS pre-existing,
    // deliberate probe output (source-discovery-probe.mjs header: "the whole point of the dictionary
    // heuristic is to recover these"). Draft mode neither adds to that nor relies on it — the labels
    // it needs come from its own preset-directed read, and they travel to the DRAFT, not the report.
    assert.ok(leaves.includes(CUSTOMER_LABELS.materialCode), 'pre-existing dictionary output is unchanged')
    assert.equal(hasNonAscii(JSON.stringify(report.draftEmission)), false)
    // The leak guard still passes over the assembled report.
    assert.doesNotThrow(() => assertValuesFree(report, { env: {}, leakGuardValues }))

    // ...and the very same values ARE in the drafts — including the labels of the rows the emitter
    // could NOT turn into a proposal, because a gap a human cannot recognise is not a loud gap.
    const draftText = Object.values(draft.files).join('\n')
    for (const value of ALL_CUSTOMER_VALUES) {
      if (NEVER_IN_THE_DRAFT.has(value)) continue
      assert.ok(draftText.includes(value), `the draft must carry the customer value "${value}"`)
    }
    // ...and the three that must NOT travel, do not.
    for (const value of NEVER_IN_THE_DRAFT) {
      assert.equal(draftText.includes(value), false, `"${value}" must not reach the draft`)
    }
  })

  test('the option vocabulary never reaches the report even though a dictionary heuristic sampled it', async () => {
    const catalog = buildVendorCatalog()
    const { report, leakGuardValues } = await runProbe({
      catalog,
      sampleFn: buildFixtureSampleFn(),
      presets: [adaptVendorPresetShape(rawVendorPreset())],
    })
    // DN_Test_BomParam1 is small, so the generic dictionary heuristic samples it
    // too; none of its values match a column name, so all of them are guarded.
    for (const value of CUSTOMER_UNIT_VOCABULARY) {
      assert.ok(leakGuardValues.has(value), `"${value}" should be leak-guarded`)
    }
    assert.doesNotThrow(() => assertValuesFree(report, { env: {}, leakGuardValues }))
  })
})

// ---------------------------------------------------------------------------
// THE SIBLING PRESET DIALECT — the schema as it actually landed on
// feat/stock-prep-vendor-presets. Structurally faithful to
// plugins/plugin-integration-core/lib/source-vendor-presets/dn-pdm-family.preset.json
// (marker, count-floor signature, rows-name-columns dictionaries with a flag
// pattern + polarity, semanticExpectations instead of ext_ ids), trimmed to what
// the emitter reads. Kept here rather than imported from that branch so this
// suite stays hermetic and does not break when the sibling iterates.
// ---------------------------------------------------------------------------

function siblingVendorPreset(overrides = {}) {
  return {
    presetSchema: 'metasheet.source-vendor-preset',
    presetVersion: 1,
    presetId: 'dn-pdm-family',
    title: 'DN_PDM / DN_PM table-name family',
    dialects: ['mssql'],
    matches: {
      kind: 'table-name-signature',
      signatureTables: [
        'DN_PDM_PartLibraryInfo',
        'DN_PDM_BomHeadInfo',
        'DN_PDM_BomDetailsInfo',
        'DN_PDM_PathInfo',
        'DN_PDM_PathExAttrInfo',
        'DN_PDM_OrderHeadInfo',
        'DN_PDM_OrderDetailInfo',
        'DN_PM_BomExAttrInfo',
        'DN_PM_PartExAttrInfo',
        'DN_PM_BomExAttrInfo_header',
      ],
      minSignatureTablesPresent: 6,
    },
    coreTables: {
      part: { table: 'DN_PDM_PartLibraryInfo', roles: { id: 'OBJ_ID', code: 'IdentityNo', name: 'IdentityName' } },
      bomHead: { table: 'DN_PDM_BomHeadInfo', roles: { parentPart: 'part_id', bomId: 'bom_id' } },
      bomDetail: { table: 'DN_PDM_BomDetailsInfo', roles: { bomParent: 'bom_pid', component: 'part_id' } },
      pathInfo: { table: 'DN_PDM_PathInfo', roles: { id: 'OBJ_ID' } },
      pathExAttr: { table: 'DN_PDM_PathExAttrInfo', roles: { match: 'FileCode', pathId: 'Parent_OBJ_ID' } },
      orderHead: { table: 'DN_PDM_OrderHeadInfo', roles: { id: 'OBJ_ID', pathId: 'path_id' } },
      orderDetail: { table: 'DN_PDM_OrderDetailInfo', roles: { orderId: 'order_id', quantity: 'quantity' } },
    },
    dictionaries: [
      {
        id: 'bom-detail-exattr-labels',
        table: 'DN_PM_BomExAttrInfo',
        labelsColumnsOfRole: 'bomDetail',
        mechanism: 'rows-name-columns',
        enabledFlag: { columnPattern: '^is_?able$', polarity: 'zero-means-enabled' },
      },
      {
        id: 'bom-head-exattr-labels',
        table: 'DN_PM_BomExAttrInfo_header',
        labelsColumnsOfRole: 'bomHead',
        mechanism: 'rows-name-columns',
        enabledFlag: { columnPattern: '^is_?able$', polarity: 'zero-means-enabled' },
      },
      {
        id: 'part-exattr-labels',
        table: 'DN_PM_PartExAttrInfo',
        labelsColumnsOfRole: 'part',
        mechanism: 'rows-name-columns',
        enabledFlag: { columnPattern: '^is_?able$', polarity: 'zero-means-enabled' },
      },
    ],
    semanticExpectations: [
      {
        semantic: 'bom-line-quantity',
        locus: 'dictionary-assigned-column',
        dictionary: 'bom-detail-exattr-labels',
        dictionaryTypeHintPattern: 'float|numeric|decimal|double|real|int',
        labelHintPattern: '数量|qty|quantity',
      },
      {
        semantic: 'bom-line-unit',
        locus: 'dictionary-assigned-column',
        dictionary: 'bom-detail-exattr-labels',
        dictionaryTypeHintPattern: 'list',
        labelHintPattern: '单位|unit',
        valueSetTableNamePattern: '^DN_Test_BomParam[0-9]+$',
      },
      {
        semantic: 'erp-material-code',
        locus: 'dictionary-assigned-column',
        dictionary: 'part-exattr-labels',
        labelHintPattern: '物料编码|matcode|material',
      },
      { semantic: 'order-line-quantity', locus: 'native-column', role: 'orderDetail', roleColumn: 'quantity' },
      { semantic: 'project-number', locus: 'native-column', role: 'pathExAttr', roleColumn: 'FileCode' },
    ],
    ...overrides,
  }
}

describe('adaptVendorPresetShape — the sibling schema dialect', () => {
  test('routes on the schema marker and normalizes to the same internal shape', () => {
    const preset = adaptVendorPresetShape(siblingVendorPreset())
    assert.equal(preset.presetId, 'dn-pdm-family')
    // A COUNT FLOOR maps exactly onto the ratio this module computes: 6 of 10.
    assert.equal(preset.signature.requiredTables.length, 10)
    assert.equal(preset.signature.minimumConfidence, 0.6)
    // The mapper's row comes from the `part` role, as that role's own note says.
    assert.equal(preset.mappingSourceTable, 'DN_PDM_PartLibraryInfo')
    assert.equal(preset.dictionaries.size, 3)
    const partDict = preset.dictionaries.get('part-exattr-labels')
    assert.equal(partDict.describesTable, 'DN_PDM_PartLibraryInfo')
    assert.equal(partDict.discoverColumns, true, 'rows-name-columns means the columns are discovered')
    assert.equal(partDict.slotColumn, null)
    assert.equal(partDict.enabledPolarity, 'zero-means-enabled')
    // Semantics become mechanical ext_ ids; the customer's label never enters an id.
    assert.deepEqual(preset.targets.map((t) => t.target), [
      'ext_bomLineQuantity',
      'ext_bomLineUnit',
      'ext_erpMaterialCode',
      'ext_orderLineQuantity',
      'ext_projectNumber',
    ])
    assert.equal(preset.targets[3].via, 'native')
    assert.equal(preset.targets[3].table, 'DN_PDM_OrderDetailInfo')
    assert.equal(preset.targets[3].column, 'quantity')
    // The value-set table-name pattern is hoisted onto the dictionary that carries the reference.
    assert.ok(preset.dictionaries.get('bom-detail-exattr-labels').valueSetTableNamePattern)
  })

  test('a semantic name becomes a mechanical ext_ id', () => {
    assert.deepEqual(deriveSemanticExtFieldId('bom-line-quantity'), { ok: true, fieldId: 'ext_bomLineQuantity' })
    assert.deepEqual(deriveSemanticExtFieldId('erp-material-code'), { ok: true, fieldId: 'ext_erpMaterialCode' })
    assert.equal(deriveSemanticExtFieldId('数量').ok, false)
  })

  test('a dictionary with no enabled flag is refused — "enabled rows only" cannot be a no-op', () => {
    const raw = siblingVendorPreset()
    delete raw.dictionaries[0].enabledFlag
    assert.throws(() => adaptVendorPresetShape(raw), (err) => err.reason === 'PRESET_DICTIONARY_INVALID')
  })

  test('a mechanism or locus this emitter cannot read is refused, never defaulted', () => {
    const a = siblingVendorPreset()
    a.dictionaries[0].mechanism = 'columns-name-rows'
    assert.throws(() => adaptVendorPresetShape(a), (err) => err.reason === 'PRESET_DICTIONARY_INVALID')
    const b = siblingVendorPreset()
    b.semanticExpectations[0].locus = 'somewhere-else'
    assert.throws(() => adaptVendorPresetShape(b), (err) => err.reason === 'PRESET_TARGET_INVALID')
  })

  test('a dictionary-assigned semantic with no label hint has nothing to be justified BY', () => {
    const raw = siblingVendorPreset()
    delete raw.semanticExpectations[0].labelHintPattern
    assert.throws(() => adaptVendorPresetShape(raw), (err) => err.reason === 'PRESET_TARGET_INVALID')
  })
})

describe('rows-name-columns discovery', () => {
  test('a dictionary spec is completed against the probe\'s OWN detected dictionary', () => {
    const catalog = buildVendorCatalog()
    const tableIndex = buildCatalogTableIndex(catalog)
    const preset = adaptVendorPresetShape(siblingVendorPreset())
    const table = tableIndex.resolve('DN_PM_PartExAttrInfo').table
    const completed = completeDictionarySpec({
      spec: preset.dictionaries.get('part-exattr-labels'),
      tableColumns: tableIndex.columnsOf(table),
      detected: {
        table: 'dbo.DN_PM_PartExAttrInfo',
        keyColumn: 'ExAttrCode',
        companions: { displayNameColumn: 'ExAttrName', enabledColumn: 'isable', typeColumn: 'ExAttrType' },
      },
    })
    assert.equal(completed.ok, true)
    assert.equal(completed.spec.slotColumn, 'ExAttrCode')
    assert.equal(completed.spec.labelColumn, 'ExAttrName')
    assert.equal(completed.spec.enabledColumn, 'isable')
    assert.equal(completed.spec.discoverColumns, false)
  })

  test('a dictionary the heuristic did not resolve is a coded GAP, not a guess by column name', () => {
    const tableIndex = buildCatalogTableIndex(buildVendorCatalog())
    const preset = adaptVendorPresetShape(siblingVendorPreset())
    const spec = preset.dictionaries.get('part-exattr-labels')
    const tableColumns = tableIndex.columnsOf(tableIndex.resolve('DN_PM_PartExAttrInfo').table)
    assert.equal(completeDictionarySpec({ spec, tableColumns, detected: null }).reason, 'DICTIONARY_SLOT_COLUMN_UNDISCOVERED')
    assert.equal(
      completeDictionarySpec({ spec, tableColumns, detected: { keyColumn: 'ExAttrCode', companions: {} } }).reason,
      'DICTIONARY_LABEL_COLUMN_UNDISCOVERED',
    )
    // The flag column falls back to the heuristic's companion, and if neither names one the read is
    // refused rather than run without a filter.
    const noFlagColumns = new Map([['exattrcode', { name: 'ExAttrCode', dataType: 'varchar' }]])
    assert.equal(
      completeDictionarySpec({
        spec,
        tableColumns: noFlagColumns,
        detected: { keyColumn: 'ExAttrCode', companions: { displayNameColumn: 'ExAttrName' } },
      }).reason,
      'DICTIONARY_ENABLED_COLUMN_UNDISCOVERED',
    )
  })

  test('the value-set REFERENCE column is found by content, not by name', () => {
    const tableIndex = buildCatalogTableIndex(buildVendorCatalog())
    const columns = tableIndex.columnsOf(tableIndex.resolve('DN_PM_PartExAttrInfo').table)
    const found = discoverValueSetRefColumn({
      rows: partExAttrRows(),
      columns,
      pattern: /^DN_Test_BomParam[0-9]+$/i,
      exclude: ['ExAttrCode', 'ExAttrName', 'isable', 'ExAttrType'],
    })
    assert.equal(found, 'ParamTable')
    // A column carrying anything that does NOT match is not adopted — one stray match is not enough.
    assert.equal(
      discoverValueSetRefColumn({ rows: partExAttrRows(), columns, pattern: /^nothing-matches$/i, exclude: [] }),
      null,
    )
  })

  test('a vocabulary table with two candidate columns is AMBIGUOUS, not a most-likely pick', () => {
    const one = new Map([
      ['name', { name: 'name', dataType: 'nvarchar' }],
      ['isable', { name: 'isable', dataType: 'int' }],
    ])
    assert.deepEqual(discoverValueSetColumns({ columns: one, enabledColumnPattern: /^is_?able$/i }), {
      ok: true,
      valueColumn: 'name',
      enabledColumn: 'isable',
    })
    const two = new Map([
      ['name', { name: 'name', dataType: 'nvarchar' }],
      ['alias', { name: 'alias', dataType: 'nvarchar' }],
    ])
    const result = discoverValueSetColumns({ columns: two, enabledColumnPattern: /^is_?able$/i })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'VALUE_SET_COLUMN_AMBIGUOUS')
    assert.deepEqual(result.candidates, ['name', 'alias'])
  })

  test('a NATIVE column with no declared type takes its type from the CATALOG, not from a default', () => {
    assert.equal(fieldTypeForCatalogColumn({ dataType: 'decimal' }), 'number')
    assert.equal(fieldTypeForCatalogColumn({ dataType: 'nvarchar' }), 'string')
    assert.equal(fieldTypeForCatalogColumn({ dataType: 'bit' }), 'boolean')
    assert.equal(fieldTypeForCatalogColumn({ dataType: 'geography' }), null)
  })
})

describe('end to end on the sibling preset', () => {
  test('resolves the customer\'s own slot assignments and stays loud about the rest', async () => {
    const { report, draft } = await runProbe({
      catalog: buildVendorCatalog(),
      sampleFn: buildFixtureSampleFn(),
      presets: [adaptVendorPresetShape(siblingVendorPreset())],
    })
    const byTarget = new Map(draft.resolution.resolved.map((r) => [r.target, r]))

    // The quantity slot is whichever one THIS customer's dictionary declares numeric and
    // quantity-labelled — nothing in the preset named Bom_ExAttr1.
    const quantity = byTarget.get('ext_bomLineQuantity')
    assert.equal(quantity.sourceColumn, 'Bom_ExAttr1')
    assert.equal(quantity.type, 'number')
    assert.equal(quantity.typeSource, 'builtin-type-token')
    assert.equal(quantity.label, CUSTOMER_LABELS.quantity)

    const unit = byTarget.get('ext_bomLineUnit')
    assert.equal(unit.sourceColumn, 'Bom_ExAttr2')
    assert.equal(unit.type, 'select')
    assert.equal(unit.valueSetRef, 'DN_Test_BomParam1', 'the vocabulary table is named by the CUSTOMER dictionary row')

    const materialCode = byTarget.get('ext_erpMaterialCode')
    assert.equal(materialCode.sourceColumn, 'part_ExAttr14')
    assert.equal(materialCode.sourceTable, 'dbo.DN_PDM_PartLibraryInfo')

    // A native column takes its type from the catalog.
    const orderQuantity = byTarget.get('ext_orderLineQuantity')
    assert.equal(orderQuantity.type, 'number')
    assert.equal(orderQuantity.typeSource, 'catalog-datatype')

    // Only the part row can become a mapping entry; the rest are deferred, not dropped.
    for (const item of draft.resolution.mappable) assert.equal(item.sourceTable, 'dbo.DN_PDM_PartLibraryInfo')
    assert.ok(draft.resolution.deferred.some((d) => d.target === 'ext_bomLineQuantity'))

    // The head-side dictionary is absent from this catalog: reported, never silently skipped.
    const headRead = report.draftEmission.dictionaryReads.find((r) => r.key === 'bom-head-exattr-labels')
    assert.equal(headRead.read, false)
    assert.equal(headRead.reason, 'TABLE_ABSENT')

    // The vocabulary came off the customer's own value-set table, duplicates collapsed.
    const optionSet = draft.optionSets.get('DN_Test_BomParam1')
    assert.equal(optionSet.ok, true)
    assert.deepEqual(optionSet.options.map((o) => o.value), [...CUSTOMER_UNIT_VOCABULARY])
    assert.equal(optionSet.duplicateCount, 2)

    // Gaps stay gaps.
    const reasons = new Set(draft.resolution.unresolved.map((u) => u.reason))
    assert.ok(reasons.has('DICTIONARY_TYPE_UNMAPPED'))
    assert.ok(reasons.has('PLACEHOLDER_ID_UNDERIVABLE'))

    // And the split holds on this dialect too.
    assert.equal(hasNonAscii(JSON.stringify(report.draftEmission)), false)
    const draftText = Object.values(draft.files).join('\n')
    assert.ok(draftText.includes(CUSTOMER_LABELS.quantity))
    for (const unitValue of CUSTOMER_UNIT_VOCABULARY) assert.ok(draftText.includes(unitValue))
  })

  test('a dictionary cell naming a table OUTSIDE the preset pattern is not read', async () => {
    const catalog = buildVendorCatalog()
    const sampleFn = async ({ table, cap }) => {
      const key = `${table.schema}.${table.name}`
      if (key === 'dbo.DN_PM_BomExAttrInfo') {
        return [
          { ExAttrCode: 'Bom_ExAttr1', ExAttrName: CUSTOMER_LABELS.quantity, isable: 0, ExAttrType: 'float', ParamTable: null },
          // Points at a table that is NOT a declared value-set table.
          { ExAttrCode: 'Bom_ExAttr2', ExAttrName: CUSTOMER_LABELS.unit, isable: 0, ExAttrType: 'list', ParamTable: 'DN_PDM_PartLibraryInfo' },
          // A well-formed reference in the SAME column, so the column is identified as the
          // value-set reference column and the stray row above costs only its own vocabulary.
          { ExAttrCode: 'sort_id', ExAttrName: '排序', isable: 0, ExAttrType: 'list', ParamTable: 'DN_Test_BomParam1' },
        ].slice(0, cap)
      }
      return buildFixtureSampleFn()({ table, cap })
    }
    const { draft } = await runProbe({ catalog, sampleFn, presets: [adaptVendorPresetShape(siblingVendorPreset())] })
    const gap = draft.optionSets.get('DN_PDM_PartLibraryInfo')
    assert.ok(gap, 'the reference must be recorded rather than ignored')
    assert.equal(gap.ok, false)
    assert.equal(gap.reason, 'VALUE_SET_TABLE_PATTERN_MISMATCH')
  })
})

// ---------------------------------------------------------------------------
// Output placement + CLI.
// ---------------------------------------------------------------------------

describe('--out-dir placement', () => {
  test('an --out-dir inside this repository is REFUSED (the drafts carry customer values)', () => {
    assert.throws(
      () => assertDraftOutDirOutsideRepo(path.join(REPO_ROOT, 'out', 'drafts'), REPO_ROOT),
      (err) => err.reason === 'DRAFT_OUT_DIR_INSIDE_REPO',
    )
    assert.throws(() => assertDraftOutDirOutsideRepo(REPO_ROOT, REPO_ROOT), (err) => err.reason === 'DRAFT_OUT_DIR_INSIDE_REPO')
    assert.throws(() => assertDraftOutDirOutsideRepo('', REPO_ROOT), (err) => err.reason === 'DRAFT_OUT_DIR_INVALID')
  })

  test('a deploy-host directory outside the repository is accepted', () => {
    const outside = path.join(tmpdir(), 'source-discovery-drafts')
    assert.equal(assertDraftOutDirOutsideRepo(outside, REPO_ROOT), path.resolve(outside))
  })
})

describe('parseArgs — draft mode', () => {
  test('--emit-draft requires both --preset and --out-dir', () => {
    assert.throws(() => parseArgs(['--out', 'r.json', '--emit-draft']), /requires --preset and --out-dir/)
    assert.throws(() => parseArgs(['--out', 'r.json', '--emit-draft', '--preset', 'p.json']), /requires --out-dir/)
  })

  test('--preset without --emit-draft is refused rather than silently ignored', () => {
    assert.throws(() => parseArgs(['--out', 'r.json', '--preset', 'p.json']), /only meaningful together with --emit-draft/)
  })

  test('parses the full draft invocation', () => {
    assert.deepEqual(parseArgs(['--out', 'r.json', '--emit-draft', '--preset', 'p.json', '--out-dir', 'd']), {
      out: 'r.json',
      help: false,
      emitDraft: true,
      preset: 'p.json',
      outDir: 'd',
    })
  })
})

// ---------------------------------------------------------------------------
// Integration-shaped: main() over a FAKE QUERY LAYER (never imports `mssql`).
// ---------------------------------------------------------------------------

function withTempDirs(fn) {
  const root = mkdtempSync(path.join(tmpdir(), 'source-draft-emitter-'))
  try {
    return fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function fakeDialectFor(catalog, sampleFn) {
  return {
    connect: async () => ({ fake: true }),
    close: async () => {},
    fetchCatalog: async () => catalog,
    sampleRows: async (_pool, table, cap) => sampleFn({ table, cap }),
  }
}

const FAKE_ENV = Object.freeze({
  PROBE_MSSQL_SERVER: 'sekrit-host.internal',
  PROBE_MSSQL_PORT: '1433',
  PROBE_MSSQL_DATABASE: 'sekrit-db',
  PROBE_MSSQL_USER: 'sekrit-user',
  PROBE_MSSQL_PASSWORD: 'sekrit-pass-123',
})

describe('main() --emit-draft over a fake query layer', () => {
  test('writes three drafts WITH customer values, and a report WITHOUT them', async () => {
    await withTempDirs(async (root) => {
      const presetPath = path.join(root, 'dn-pdm-plm.json')
      writeFileSync(presetPath, JSON.stringify(rawVendorPreset(), null, 2), 'utf8')
      const outPath = path.join(root, 'report', 'probe.json')
      const draftDir = path.join(root, 'drafts')

      const code = await main(
        ['--out', outPath, '--emit-draft', '--preset', presetPath, '--out-dir', draftDir],
        FAKE_ENV,
        { dialects: { mssql: fakeDialectFor(buildVendorCatalog(), buildFixtureSampleFn()) } },
      )
      assert.equal(code, 0)

      for (const name of Object.values(DRAFT_FILE_NAMES)) {
        assert.ok(existsSync(path.join(draftDir, name)), `${name} should have been written`)
      }

      const draftText = Object.values(DRAFT_FILE_NAMES)
        .map((name) => readFileSync(path.join(draftDir, name), 'utf8'))
        .join('\n')
      const reportText = readFileSync(outPath, 'utf8')
      const mdText = readFileSync(path.join(root, 'report', 'probe.md'), 'utf8')

      // >>> values land in the draft <<<
      assert.ok(draftText.includes(CUSTOMER_LABELS.materialCode))
      assert.ok(draftText.includes(CUSTOMER_LABELS.model))
      for (const unit of CUSTOMER_UNIT_VOCABULARY) {
        assert.ok(draftText.includes(unit), `the draft must carry the unit "${unit}"`)
      }

      // >>> values do NOT land in the report <<<
      const report0 = JSON.parse(reportText)
      const reportLeaves = stringLeaves(report0).map((leaf) => leaf.trim())
      for (const unit of CUSTOMER_UNIT_VOCABULARY) {
        assert.equal(reportLeaves.includes(unit), false, `the report must not carry the unit "${unit}" as a leaf`)
      }
      // The draft-emission section of BOTH artifacts is free of customer text entirely.
      assert.equal(hasNonAscii(JSON.stringify(report0.draftEmission)), false)
      const sectionStart = mdText.indexOf('## Draft emission (H1)')
      assert.ok(sectionStart > 0, 'the md summary must carry a draft-emission section')
      // Bounded at the trailing blockquote, which is the probe's own pre-existing `limits.note`
      // (it carries an em dash and predates this change).
      const sectionEnd = mdText.indexOf('\n> ', sectionStart)
      const mdDraftSection = mdText.slice(sectionStart, sectionEnd > 0 ? sectionEnd : undefined)
      assert.ok(mdDraftSection.length > 0)
      assert.equal(hasNonAscii(mdDraftSection), false, 'the md draft section must carry no customer text')
      for (const secret of Object.values(FAKE_ENV)) {
        assert.equal(reportText.includes(secret), false)
        assert.equal(mdText.includes(secret), false)
        assert.equal(draftText.includes(secret), false, 'connection details belong in no output at all')
      }

      // The report still says WHAT happened, in counts and identifiers.
      const report = JSON.parse(reportText)
      assert.equal(report.draftEmission.presetId, 'dn-pdm-plm')
      assert.ok(report.draftEmission.targetCounts.unresolved > 0)
      assert.match(mdText, /Draft emission \(H1\)/)
      assert.match(mdText, /UNRESOLVED/)

      // The drafts are loud about their gaps.
      const mapping = JSON.parse(readFileSync(path.join(draftDir, DRAFT_FILE_NAMES.mapping), 'utf8'))
      assert.equal(mapping.$unresolved.length, report.draftEmission.targetCounts.unresolved)
      assert.ok(mapping.$deferred.length > 0)
    })
  })

  test('SIGNATURE REFUSAL: an unrecognised database exits 3 and writes NOTHING', async () => {
    await withTempDirs(async (root) => {
      const presetPath = path.join(root, 'dn-pdm-plm.json')
      writeFileSync(presetPath, JSON.stringify(rawVendorPreset(), null, 2), 'utf8')
      const outPath = path.join(root, 'probe.json')
      const draftDir = path.join(root, 'drafts')

      const catalog = buildVendorCatalog({ dropTables: ['DN_PM_PartExAttrInfo', 'DN_PM_BomExAttrInfo'] })
      const code = await main(
        ['--out', outPath, '--emit-draft', '--preset', presetPath, '--out-dir', draftDir],
        FAKE_ENV,
        { dialects: { mssql: fakeDialectFor(catalog, buildFixtureSampleFn()) } },
      )
      assert.equal(code, 3, 'a signature miss is its own exit code, not a crash and not a guess')
      assert.equal(existsSync(outPath), false, 'nothing is written when the vendor could not be identified')
      assert.equal(existsSync(draftDir), false)
    })
  })

  test('an --out-dir inside the repository exits 2 before a single row is read', async () => {
    await withTempDirs(async (root) => {
      const presetPath = path.join(root, 'p.json')
      writeFileSync(presetPath, JSON.stringify(rawVendorPreset(), null, 2), 'utf8')
      let connected = false
      const code = await main(
        ['--out', path.join(root, 'probe.json'), '--emit-draft', '--preset', presetPath, '--out-dir', path.join(REPO_ROOT, 'out')],
        FAKE_ENV,
        {
          dialects: {
            mssql: {
              connect: async () => { connected = true; return {} },
              close: async () => {},
              fetchCatalog: async () => buildVendorCatalog(),
              sampleRows: async () => [],
            },
          },
        },
      )
      assert.equal(code, 2)
      assert.equal(connected, false, 'the repo-placement refusal must precede the connection')
    })
  })

  test('a preset DIRECTORY auto-selects the one preset whose signature is met', async () => {
    await withTempDirs(async (root) => {
      const presetDir = path.join(root, 'presets')
      mkdirSync(presetDir, { recursive: true })
      writeFileSync(path.join(presetDir, 'a.json'), JSON.stringify(rawVendorPreset()), 'utf8')
      // A rival vendor whose signature this database does not meet.
      writeFileSync(
        path.join(presetDir, 'b.json'),
        JSON.stringify(
          rawVendorPreset({
            presetId: 'other-vendor',
            matches: { requiredTables: ['T_SOMETHING_ELSE', 'T_ALSO_MISSING'], minimumConfidence: 1 },
          }),
        ),
        'utf8',
      )
      const outPath = path.join(root, 'probe.json')
      const code = await main(
        ['--out', outPath, '--emit-draft', '--preset', presetDir, '--out-dir', path.join(root, 'drafts')],
        FAKE_ENV,
        { dialects: { mssql: fakeDialectFor(buildVendorCatalog(), buildFixtureSampleFn()) } },
      )
      assert.equal(code, 0)
      assert.equal(JSON.parse(readFileSync(outPath, 'utf8')).draftEmission.presetId, 'dn-pdm-plm')
    })
  })

  test('a dictionary table above the row cap is NOT READ, and the draft says so', async () => {
    const catalog = buildVendorCatalog()
    // Push the part-side dictionary over the sampling cap: it must not be read at
    // all, and its targets must become explicit gaps rather than quietly vanish.
    const oversized = catalog.tables.find((t) => t.name === 'DN_PM_PartExAttrInfo')
    oversized.rowCount = 50000
    const trackCalls = {}
    const { report } = await runProbe({
      catalog,
      sampleFn: buildFixtureSampleFn({ trackCalls }),
      presets: [adaptVendorPresetShape(rawVendorPreset())],
    })
    assert.equal(trackCalls['dbo.DN_PM_PartExAttrInfo'], undefined, 'an over-cap dictionary must never be sampled')
    const read = report.draftEmission.dictionaryReads.find((d) => d.key === 'partExAttr')
    assert.equal(read.read, false)
    assert.equal(read.reason, 'ROW_CAP_REFUSED')
    assert.ok(report.draftEmission.unresolvedTargets.some((u) => u.target === 'ext_materialCode'))
  })
})
