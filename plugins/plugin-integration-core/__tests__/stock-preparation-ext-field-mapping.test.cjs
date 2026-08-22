'use strict'

// SOURCE COLUMN -> `ext_` FIELD MAPPER — hermetic battery.
//
// The refresh path could describe a tenant's `ext_` columns (customer pack) and
// could decide whether one of them is writable (pack-aware planner), but nothing
// could FILL one: `createRow` emitted a fixed canonical shape and no production
// path produced an `ext_` key. This suite pins the piece that closes that, and —
// more importantly — the two refusals that make it safe to close:
//
//   * a mapping may not target a human-owned column (the refresh wall's
//     integrity: a refresh overwrites what it writes)
//   * an `ext_` key that reaches the records API with no physical id bound must
//     FAIL LOUD. Before this change `mapFieldName` returned `fieldIdMap[f] || f`,
//     so an unmapped `ext_` id was silently sent as its LOGICAL name — a write to
//     a field id that addresses no column. `unmappedExtKeyFailsLoud()` below is
//     the regression pin for exactly that fallback.
//
// Plain node test (throws on failure). Hermetic and dependency-free: no DB, no
// network, no filesystem writes, no clock. Values-free evidence throughout — the
// only literals are schema ids, frozen reason tokens and synthetic cell text.
//
// The customer pack used as the target authority is the REAL committed rehearsal
// pack, not a hand-typed stand-in, so a change to its ownership split shows up
// here as a failure rather than as agreeing drift on both sides.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')

const {
  MAPPING_ID_PATTERN,
  SOURCE_COLUMN_PATTERN,
  STOCK_PREPARATION_EXT_FIELD_MAPPING_ERROR_REASONS,
  StockPreparationExtFieldMappingError,
  isNormalizedExtFieldMapping,
  normalizeExtFieldMapping,
  extFieldMappingTargetIds,
  applyExtFieldMapping,
  summarizeExtFieldMappingForEvidence,
  __internals: mappingInternals,
} = require(path.join(LIB, 'stock-preparation-ext-field-mapping.cjs'))

const {
  expandPlmProjectBom,
  StockPreparationBomExpansionError,
  __internals: expansionInternals,
} = require(path.join(LIB, 'stock-preparation-bom-expansion.cjs'))

const {
  planStockPreparationConflicts,
} = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))

const {
  applyStockPreparationPlan,
  StockPreparationApplyWriterError,
  __internals: writerInternals,
} = require(path.join(LIB, 'stock-preparation-apply-writer.cjs'))

const {
  assertStockPreparationTargetReady,
  StockPreparationTableActionError,
  __internals: tableActionInternals,
} = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))

const {
  inspectStockPreparationCanonicalTarget,
} = require(path.join(LIB, 'stock-preparation-target-provisioning.cjs'))

const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
} = require(path.join(LIB, 'stock-preparation-templates.cjs'))

const {
  FACTORY_A_REHEARSAL_PACK,
} = require(path.join(LIB, 'customer-packs', 'factory-a.rehearsal.cjs'))

const PACK = FACTORY_A_REHEARSAL_PACK
const TEMPLATE_FIELDS = STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields

// Read off the REAL pack rather than restated, so the suite cannot disagree with
// the pack about which band a column is in.
const PACK_PLM_IDS = PACK.extensionFields.filter((f) => f.ownership === 'plm_system').map((f) => f.id)
const PACK_HUMAN_IDS = PACK.extensionFields.filter((f) => f.ownership === 'human_preserved').map((f) => f.id)

// ── helpers ───────────────────────────────────────────────────────────────────

function assertThrowsReason(fn, reason, label) {
  let thrown = null
  try {
    fn()
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown, `${label}: expected a throw`)
  assert.equal(thrown.name, 'StockPreparationExtFieldMappingError', `${label}: wrong error class`)
  assert.equal(thrown.reason, reason, `${label}: wrong reason (got ${thrown.reason})`)
  assert.ok(
    STOCK_PREPARATION_EXT_FIELD_MAPPING_ERROR_REASONS.includes(thrown.reason),
    `${label}: reason is outside the closed vocabulary`,
  )
}

function mappingConfig(mappings, overrides = {}) {
  return {
    mappingId: 'factory-a-legacy',
    mappingVersion: 1,
    mappings,
    ...overrides,
  }
}

function normalize(mappings, overrides = {}) {
  return normalizeExtFieldMapping(mappingConfig(mappings, overrides), { pack: PACK })
}

// ── 1. the normalizer accepts a valid config ──────────────────────────────────

function normalizerAcceptsAValidConfig() {
  const mapping = normalize([
    { sourceColumn: 'ParentDrawingNo', target: 'ext_parentDrawingNo' },
    { sourceColumn: 'Spec', target: 'ext_spec' },
    { sourceColumn: 'sort_id', target: 'ext_parentSortNo' },
    { sourceColumn: '提前周期', target: 'ext_standard' },
  ])

  assert.equal(isNormalizedExtFieldMapping(mapping), true)
  assert.equal(mapping.mappingId, 'factory-a-legacy')
  assert.equal(mapping.mappingVersion, 1)
  assert.equal(mapping.label, 'factory-a-legacy', 'label defaults to the mapping id')
  assert.equal(mapping.packId, PACK.packId, 'the mapping records which pack authorised its targets')
  assert.equal(mapping.packVersion, PACK.packVersion)
  assert.equal(mapping.targetObjectId, STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId)

  assert.deepEqual(extFieldMappingTargetIds(mapping), [
    'ext_parentDrawingNo',
    'ext_spec',
    'ext_parentSortNo',
    'ext_standard',
  ])

  // COERCION IS DERIVED, NEVER AUTHORED: the config above declared no type at
  // all, and `ext_parentSortNo` still coerces as a number because the PACK says
  // so. `coerce` is not authorable — `type` is not even an accepted key.
  const byTarget = new Map(mapping.mappings.map((entry) => [entry.target, entry]))
  assert.equal(byTarget.get('ext_parentSortNo').coerce, 'number')
  assert.equal(byTarget.get('ext_parentDrawingNo').coerce, 'string')
  assert.equal(byTarget.get('ext_parentSortNo').ownership, 'plm_system')
  assertThrowsReason(
    () => normalize([{ sourceColumn: 'A', target: 'ext_parentSortNo', type: 'string' }]),
    'MAPPING_ENTRY_UNKNOWN_KEY',
    'a config cannot author a type',
  )

  // Deeply frozen, and re-normalizing its own output is a no-op rather than a
  // second validation pass that would have to tolerate the derived keys.
  assert.equal(Object.isFrozen(mapping), true)
  assert.equal(Object.isFrozen(mapping.mappings), true)
  assert.equal(Object.isFrozen(mapping.mappings[0]), true)
  assert.equal(normalizeExtFieldMapping(mapping, { pack: PACK }), mapping)

  // The brand is not enumerable: it must never reach JSON, evidence or a diff.
  assert.equal(JSON.stringify(mapping).includes('Symbol'), false)
  assert.equal(Object.keys(mapping).includes('__brand'), false)

  // Every plm_system column the pack declares is a LEGAL target — the mapper is
  // not silently narrower than the band it is allowed to fill.
  for (const id of PACK_PLM_IDS) {
    const single = normalize([{ sourceColumn: 'Src', target: id }])
    assert.deepEqual(extFieldMappingTargetIds(single), [id], `${id} must be a legal target`)
  }
}

// ── 2. the normalizer rejects each malformed shape ────────────────────────────

function normalizerRejectsEachMalformedShape() {
  const cases = [
    ['MAPPING_NOT_AN_OBJECT', () => normalizeExtFieldMapping(null, { pack: PACK })],
    ['MAPPING_NOT_AN_OBJECT', () => normalizeExtFieldMapping('mapping', { pack: PACK })],
    ['MAPPING_NOT_AN_OBJECT', () => normalizeExtFieldMapping([], { pack: PACK })],
    ['MAPPING_UNKNOWN_KEY', () => normalizeExtFieldMapping(
      { ...mappingConfig([{ sourceColumn: 'A', target: 'ext_spec' }]), extra: 1 },
      { pack: PACK },
    )],
    // Content smuggling: a mapping is schema, never a values carrier.
    ['MAPPING_UNKNOWN_KEY', () => normalizeExtFieldMapping(
      { ...mappingConfig([{ sourceColumn: 'A', target: 'ext_spec' }]), rows: [] },
      { pack: PACK },
    )],
    ['MAPPING_UNKNOWN_KEY', () => normalizeExtFieldMapping(
      { ...mappingConfig([{ sourceColumn: 'A', target: 'ext_spec' }]), sql: 'select 1' },
      { pack: PACK },
    )],
    ['MAPPING_ID_INVALID', () => normalize([{ sourceColumn: 'A', target: 'ext_spec' }], { mappingId: '' })],
    ['MAPPING_ID_INVALID', () => normalize([{ sourceColumn: 'A', target: 'ext_spec' }], { mappingId: 'Factory-A' })],
    ['MAPPING_ID_INVALID', () => normalize([{ sourceColumn: 'A', target: 'ext_spec' }], { mappingId: 'x' })],
    ['MAPPING_VERSION_INVALID', () => normalize([{ sourceColumn: 'A', target: 'ext_spec' }], { mappingVersion: 0 })],
    ['MAPPING_VERSION_INVALID', () => normalize([{ sourceColumn: 'A', target: 'ext_spec' }], { mappingVersion: '1' })],
    ['MAPPING_VERSION_INVALID', () => normalize([{ sourceColumn: 'A', target: 'ext_spec' }], { mappingVersion: 1.5 })],
    ['MAPPING_LABEL_INVALID', () => normalize([{ sourceColumn: 'A', target: 'ext_spec' }], { label: '   ' })],
    ['MAPPINGS_INVALID', () => normalize(undefined)],
    ['MAPPINGS_INVALID', () => normalize([])],
    ['MAPPINGS_INVALID', () => normalize('nope')],
    ['MAPPINGS_INVALID', () => normalize([null])],
    ['MAPPING_ENTRY_UNKNOWN_KEY', () => normalize([{ sourceColumn: 'A', target: 'ext_spec', coerce: 'number' }])],
    ['MAPPING_ENTRY_UNKNOWN_KEY', () => normalize([{ sourceColumn: 'A', target: 'ext_spec', ownership: 'plm_system' }])],
    ['SOURCE_COLUMN_INVALID', () => normalize([{ target: 'ext_spec' }])],
    ['SOURCE_COLUMN_INVALID', () => normalize([{ sourceColumn: '', target: 'ext_spec' }])],
    ['SOURCE_COLUMN_INVALID', () => normalize([{ sourceColumn: 'a.b', target: 'ext_spec' }])],
    ['SOURCE_COLUMN_INVALID', () => normalize([{ sourceColumn: 'a b', target: 'ext_spec' }])],
    ['SOURCE_COLUMN_INVALID', () => normalize([{ sourceColumn: "a'b", target: 'ext_spec' }])],
    ['SOURCE_COLUMN_INVALID', () => normalize([{ sourceColumn: 'a[0]', target: 'ext_spec' }])],
    ['SOURCE_COLUMN_INVALID', () => normalize([{ sourceColumn: '__proto__', target: 'ext_spec' }])],
    ['SOURCE_COLUMN_INVALID', () => normalize([{ sourceColumn: 'constructor', target: 'ext_spec' }])],
    ['SOURCE_COLUMN_INVALID', () => normalize([{ sourceColumn: 'x'.repeat(65), target: 'ext_spec' }])],
    ['TARGET_INVALID', () => normalize([{ sourceColumn: 'A' }])],
    ['TARGET_INVALID', () => normalize([{ sourceColumn: 'A', target: 42 }])],
    ['SOURCE_COLUMN_DUPLICATE', () => normalize([
      { sourceColumn: 'A', target: 'ext_spec' },
      { sourceColumn: 'A', target: 'ext_standard' },
    ])],
    ['TARGET_DUPLICATE', () => normalize([
      { sourceColumn: 'A', target: 'ext_spec' },
      { sourceColumn: 'B', target: 'ext_spec' },
    ])],
    ['TARGET_NOT_EXTENSION_FIELD', () => normalize([{ sourceColumn: 'A', target: 'notAnExtensionColumn' }])],
    ['TARGET_NOT_DECLARED_IN_PACK', () => normalize([{ sourceColumn: 'A', target: 'ext_neverDeclared' }])],
    // The pack itself is the authority and must be present and valid.
    ['PACK_INVALID', () => normalizeExtFieldMapping(mappingConfig([{ sourceColumn: 'A', target: 'ext_spec' }]), {})],
    ['PACK_INVALID', () => normalizeExtFieldMapping(
      mappingConfig([{ sourceColumn: 'A', target: 'ext_spec' }]),
      { pack: { ...PACK, packId: 'NOT A PACK ID' } },
    )],
  ]

  for (const [reason, run] of cases) {
    assertThrowsReason(run, reason, `malformed shape -> ${reason}`)
  }

  // An unnormalized mapping can never be used as if it were normalized.
  assertThrowsReason(
    () => applyExtFieldMapping({ mappings: [] }, {}),
    'MAPPING_NOT_AN_OBJECT',
    'apply refuses an unbranded mapping',
  )
  assertThrowsReason(
    () => extFieldMappingTargetIds({ targetFieldIds: ['ext_spec'] }),
    'MAPPING_NOT_AN_OBJECT',
    'targetIds refuses an unbranded mapping',
  )
  assertThrowsReason(
    () => summarizeExtFieldMappingForEvidence({}),
    'MAPPING_NOT_AN_OBJECT',
    'evidence refuses an unbranded mapping',
  )
}

// ── 3. a mapping targeting a HUMAN column is refused ──────────────────────────

function humanOwnedTargetIsRefused() {
  assert.ok(PACK_HUMAN_IDS.length >= 8, 'the rehearsal pack must still carry its human band')

  // Every human column the pack declares, one by one — a positive rejection per
  // id, not "none of them happened to be reachable".
  for (const id of PACK_HUMAN_IDS) {
    assertThrowsReason(
      () => normalize([{ sourceColumn: 'Src', target: id }]),
      'TARGET_HUMAN_OWNED',
      `human-owned target ${id}`,
    )
  }

  // And it is refused even when it rides alongside perfectly legal mappings —
  // the whole config fails, nothing is partially accepted.
  assertThrowsReason(
    () => normalize([
      { sourceColumn: 'A', target: 'ext_spec' },
      { sourceColumn: 'B', target: PACK_HUMAN_IDS[0] },
      { sourceColumn: 'C', target: 'ext_standard' },
    ]),
    'TARGET_HUMAN_OWNED',
    'one human target poisons the whole config',
  )

  // The refusal is about OWNERSHIP, not about the id: the same id declared
  // plm_system in a different pack is accepted. This is what proves the check
  // reads the pack rather than a hardcoded deny-list.
  const flipped = {
    ...PACK,
    extensionFields: PACK.extensionFields.map((field) => (
      field.id === PACK_HUMAN_IDS[0] ? { ...field, ownership: 'plm_system' } : field
    )),
  }
  const accepted = normalizeExtFieldMapping(
    mappingConfig([{ sourceColumn: 'Src', target: PACK_HUMAN_IDS[0] }]),
    { pack: flipped },
  )
  assert.deepEqual(extFieldMappingTargetIds(accepted), [PACK_HUMAN_IDS[0]])
}

// ── 4. a mapping targeting a CANONICAL field is refused ───────────────────────

function canonicalTargetIsRefused() {
  // Every frozen template column, one by one.
  for (const field of TEMPLATE_FIELDS) {
    assertThrowsReason(
      () => normalize([{ sourceColumn: 'Src', target: field.id }]),
      'TARGET_IS_TEMPLATE_FIELD',
      `canonical target ${field.id}`,
    )
  }
  // Including the key field, which would be the most damaging of all to let a
  // tenant config overwrite.
  assertThrowsReason(
    () => normalize([{ sourceColumn: 'Src', target: 'idempotencyKey' }]),
    'TARGET_IS_TEMPLATE_FIELD',
    'canonical key field',
  )
}

// ── 5. type coercion: succeeds for well-formed strings, refuses malformed ─────

function typeCoercionSucceedsAndRefuses() {
  const { coerceSourceValue } = mappingInternals

  // NUMBER — the 毛胚/排序 case. Legacy source is all-string, and the customer
  // system deliberately allows a unit inside the box ("10件"), so the refusal
  // below is the whole reason this conversion cannot live in the pack.
  const numberOk = [['0', 0], ['10', 10], ['-3', -3], ['12.5', 12.5], ['007', 7], [' 42 ', 42], [7, 7]]
  for (const [input, expected] of numberOk) {
    assert.deepEqual(
      coerceSourceValue(input, 'number'),
      { ok: true, value: expected },
      `number accepts ${JSON.stringify(input)}`,
    )
  }
  const numberBad = ['10件', '10 kg', '1e5', '0x10', '1,000', '+5', '.5', '5.', '--1', 'NaN', 'Infinity', true, {}, [], Number.NaN, Number.POSITIVE_INFINITY]
  for (const input of numberBad) {
    assert.deepEqual(
      coerceSourceValue(input, 'number'),
      { ok: false, reason: 'SOURCE_VALUE_NOT_A_NUMBER' },
      `number refuses ${JSON.stringify(input)}`,
    )
  }

  // DATE — 备料日期 shape. Shape AND calendar: `2026-02-30` matches the pattern
  // and is still not a day.
  for (const input of ['2026-08-23', '2024-02-29', '2026-08-23T01:02:03Z', '2026-08-23T01:02:03.456Z']) {
    assert.deepEqual(coerceSourceValue(input, 'date'), { ok: true, value: input.trim() }, `date accepts ${input}`)
  }
  for (const input of ['2026-02-30', '2026-13-01', '2025-02-29', '2026/08/23', '23-08-2026', '2026-8-3', '2026-08-23 01:02:03', 'yesterday', '', 20260823]) {
    assert.deepEqual(
      coerceSourceValue(input, 'date'),
      { ok: false, reason: 'SOURCE_VALUE_NOT_A_DATE' },
      `date refuses ${JSON.stringify(input)}`,
    )
  }

  // BOOLEAN — closed vocabulary; `1`/`yes` are NOT booleans here.
  assert.deepEqual(coerceSourceValue('true', 'boolean'), { ok: true, value: true })
  assert.deepEqual(coerceSourceValue('FALSE', 'boolean'), { ok: true, value: false })
  assert.deepEqual(coerceSourceValue(false, 'boolean'), { ok: true, value: false })
  for (const input of ['1', '0', 'yes', 'no', 'Y', '', 1]) {
    assert.deepEqual(
      coerceSourceValue(input, 'boolean'),
      { ok: false, reason: 'SOURCE_VALUE_NOT_A_BOOLEAN' },
      `boolean refuses ${JSON.stringify(input)}`,
    )
  }

  // STRING — a number arriving for a string column is REFUSED, not String()-ed.
  // Silent stringification is the same class of bug as silent truncation.
  assert.deepEqual(coerceSourceValue('DWG-1', 'string'), { ok: true, value: 'DWG-1' })
  assert.deepEqual(coerceSourceValue('  padded  ', 'string'), { ok: true, value: 'padded' })
  for (const input of [12, true, {}, []]) {
    assert.deepEqual(
      coerceSourceValue(input, 'string'),
      { ok: false, reason: 'SOURCE_VALUE_NOT_A_STRING' },
      `string refuses ${JSON.stringify(input)}`,
    )
  }

  // SELECT — with an installed dictionary the value must be IN it.
  const dictionary = ['48 - 主体焊接', '124 - 接管']
  assert.deepEqual(coerceSourceValue('48 - 主体焊接', 'select', dictionary), { ok: true, value: '48 - 主体焊接' })
  assert.deepEqual(
    coerceSourceValue('999 - not a node', 'select', dictionary),
    { ok: false, reason: 'SOURCE_VALUE_NOT_AN_OPTION' },
  )
  // Without one, any non-empty label is as much as this module can check.
  assert.deepEqual(coerceSourceValue('anything', 'select'), { ok: true, value: 'anything' })
  assert.deepEqual(coerceSourceValue(7, 'select'), { ok: false, reason: 'SOURCE_VALUE_NOT_AN_OPTION' })

  // A secret-shaped cell never reaches a sheet, whatever the declared type.
  const secret = coerceSourceValue('AKIAIOSFODNN7EXAMPLE1234', 'string')
  if (secret.ok === false) assert.equal(secret.reason, 'SOURCE_VALUE_SECRET_SHAPED')

  // ABSENT is not EMPTY. Omitting a key and blanking a cell are different
  // claims; this module only ever makes the first one.
  for (const input of [undefined, null, '', '   ']) {
    assert.equal(mappingInternals.isAbsentSourceValue(input), true, `absent: ${JSON.stringify(input)}`)
  }
  for (const input of ['0', 0, false]) {
    assert.equal(mappingInternals.isAbsentSourceValue(input), false, `present: ${JSON.stringify(input)}`)
  }

  // And through the real apply surface: absent omits, malformed reports.
  const mapping = normalize([
    { sourceColumn: 'Spec', target: 'ext_spec' },
    { sourceColumn: 'SortNo', target: 'ext_parentSortNo' },
    { sourceColumn: 'Missing', target: 'ext_standard' },
  ])
  const applied = applyExtFieldMapping(mapping, { Spec: 'DN200', SortNo: '10件', Missing: '  ' })
  assert.deepEqual(applied.values, { ext_spec: 'DN200' }, 'a refused cell is OMITTED, never guessed')
  assert.deepEqual(applied.errors, [{
    type: 'SOURCE_VALUE_NOT_A_NUMBER',
    target: 'ext_parentSortNo',
    sourceColumn: 'SortNo',
    expectedType: 'number',
  }])
  // The refusal is values-free: the offending cell is never in the report.
  assert.equal(JSON.stringify(applied.errors).includes('10件'), false)
}

// ── 6. the row-production boundary carries the mapped values ──────────────────

function createAdapter(data) {
  return {
    async read(input = {}) {
      const rows = Array.isArray(data[input.object]) ? data[input.object] : []
      const matches = rows.filter((row) =>
        Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected),
      )
      const records = matches.map((row) => JSON.parse(JSON.stringify(row)))
      return { records, nextCursor: null, done: true, metadata: { filtersApplied: true } }
    },
  }
}

function sourceData(partOverrides = {}) {
  return {
    DN_PDM_PathExAttrInfo: [{ FileCode: 'P-001', Parent_OBJ_ID: 'PATH-1' }],
    DN_PDM_PathInfo: [{ OBJ_ID: 'PATH-1' }],
    DN_PDM_OrderHeadInfo: [{ OBJ_ID: 'ORDER-1', path_id: 'PATH-1' }],
    DN_PDM_OrderDetailInfo: [{ order_id: 'ORDER-1', part_id: 'PART-A', quantity: '2', sort_id: 1 }],
    DN_PDM_PartLibraryInfo: [
      {
        OBJ_ID: 'PART-A',
        IdentityNo: 'A-001',
        IdentityName: 'Assembly',
        Material: 'Steel',
        SysVer: 'V1',
        // The legacy columns the mapper is here to reach. All strings, exactly
        // as the customer system stores them.
        ParentDrawingNo: 'DWG-A-001',
        SortNo: '10',
        Designer: 'designer-one',
        ...partOverrides,
      },
    ],
    DN_PDM_BomHeadInfo: [],
    DN_PDM_BomDetailsInfo: [],
  }
}

const ROW_MAPPING_ENTRIES = [
  { sourceColumn: 'ParentDrawingNo', target: 'ext_parentDrawingNo' },
  { sourceColumn: 'SortNo', target: 'ext_parentSortNo' },
  { sourceColumn: 'Designer', target: 'ext_designer' },
]

async function rowProductionCarriesMappedValues() {
  const mapping = normalize(ROW_MAPPING_ENTRIES)

  // CONTROL first: with no mapping the row shape must be exactly what it always
  // was — not "the same plus an empty bag".
  const control = await expandPlmProjectBom({
    sourceAdapter: createAdapter(sourceData()),
    projectNo: 'P-001',
  })
  assert.equal(control.valid, true)
  assert.equal(control.rows.length, 1)
  assert.deepEqual(
    Object.keys(control.rows[0]).filter((key) => key.startsWith('ext_')),
    [],
    'a mapping-free expansion produces no ext_ key at all',
  )
  assert.deepEqual(control.rowErrors, [])

  // With the mapping, the SAME source row now carries coerced `ext_` values.
  const mapped = await expandPlmProjectBom({
    sourceAdapter: createAdapter(sourceData()),
    projectNo: 'P-001',
    extFieldMapping: mapping,
  })
  assert.equal(mapped.valid, true)
  assert.equal(mapped.rows.length, 1)
  const row = mapped.rows[0]
  assert.equal(row.ext_parentDrawingNo, 'DWG-A-001')
  assert.equal(row.ext_designer, 'designer-one')
  assert.equal(row.ext_parentSortNo, 10)
  assert.equal(typeof row.ext_parentSortNo, 'number', 'an all-string source lands as a real number')
  assert.deepEqual(mapped.rowErrors, [])

  // The canonical half is untouched: every canonical key is byte-identical to
  // the control. The mapper ADDS, it never rewrites.
  for (const key of Object.keys(control.rows[0])) {
    assert.deepEqual(row[key], control.rows[0][key], `canonical key ${key} must be unchanged`)
  }

  // A malformed legacy cell drops THAT CELL and reports it — the row still
  // lands with its PLM data, because one bad cell must not cost a component.
  const partial = await expandPlmProjectBom({
    sourceAdapter: createAdapter(sourceData({ SortNo: '10件' })),
    projectNo: 'P-001',
    extFieldMapping: mapping,
  })
  assert.equal(partial.rows.length, 1)
  assert.equal(partial.rows[0].ext_parentDrawingNo, 'DWG-A-001')
  assert.equal(
    Object.prototype.hasOwnProperty.call(partial.rows[0], 'ext_parentSortNo'),
    false,
    'a refused cell must be absent, never truncated into the row',
  )
  assert.equal(partial.rowErrors.length, 1)
  assert.equal(partial.rowErrors[0].type, 'SOURCE_VALUE_NOT_A_NUMBER')
  assert.equal(partial.rowErrors[0].target, 'ext_parentSortNo')
  assert.equal(partial.rowErrors[0].depth, 0)
  // The refusal reaches the values-free summary as a type token.
  assert.ok(partial.summary.errorTypes.includes('SOURCE_VALUE_NOT_A_NUMBER'))
  assert.equal(JSON.stringify(partial.summary).includes('10件'), false)

  // An unvalidated mapping cannot enter the expansion at all: it has not been
  // checked against a pack, so its targets could be anything.
  await assert.rejects(
    () => expandPlmProjectBom({
      sourceAdapter: createAdapter(sourceData()),
      projectNo: 'P-001',
      extFieldMapping: { mappings: [{ sourceColumn: 'Designer', target: 'ext_stockPrepDate' }] },
    }),
    (error) => error instanceof StockPreparationBomExpansionError &&
      error.details.reason === 'EXT_FIELD_MAPPING_NOT_NORMALIZED',
  )

  // `createRow` itself: the merge is additive and cannot shadow a canonical key
  // (the normalizer already guarantees ext_-only, this pins the merge order).
  const direct = expansionInternals.createRow({
    projectNo: 'P-001',
    parentSourceId: null,
    pathTokens: ['PART-A'],
    depth: 0,
    partRow: { OBJ_ID: 'PART-A', IdentityNo: 'A-001' },
    rawQuantity: 1,
    totalQuantity: 1,
    active: true,
    extValues: { ext_spec: 'DN200' },
  })
  assert.equal(direct.ext_spec, 'DN200')
  assert.equal(direct.componentCode, 'A-001')
  assert.equal(direct.componentSourceId, 'PART-A')
}

// ── 7. a mapped ext_ plm value reaches the record through the REAL planner ────
//
// Installed-property stanzas are byte-for-byte the ones the pack installer
// stamps, restated here (same discipline as the pack-aware refresh suite) so a
// silent change to the installer shows up as a FAILURE, not as matching drift.

function installedField(fieldId, stockPreparation) {
  return {
    logicalId: fieldId,
    name: fieldId,
    type: 'string',
    property: stockPreparation === undefined ? {} : { stockPreparation },
  }
}

function packStanza(ownership, overrides = {}) {
  return {
    ownership,
    preserveOnRefresh: ownership === 'human_preserved',
    required: false,
    key: false,
    extension: true,
    packId: PACK.packId,
    packVersion: '1.0.0',
    ...overrides,
  }
}

function installedSheet() {
  return TEMPLATE_FIELDS
    .map((field) => installedField(field.id, {
      ownership: field.ownership,
      preserveOnRefresh: field.preserveOnRefresh === true,
      required: field.required === true,
      key: field.key === true,
    }))
    .concat(PACK.extensionFields.map((field) => installedField(field.id, packStanza(field.ownership))))
}

async function mappedValueReachesTheRecordThroughTheRealPlanner() {
  const mapping = normalize(ROW_MAPPING_ENTRIES)
  const expansion = await expandPlmProjectBom({
    sourceAdapter: createAdapter(sourceData()),
    projectNo: 'P-001',
    extFieldMapping: mapping,
  })

  const planInput = {
    expandedRows: expansion.rows,
    existingRows: [],
    rowErrors: expansion.rowErrors,
    runId: 'ext-mapper-run',
    plannedAt: '2026-01-02T03:04:05.000Z',
  }

  // PACK-AWARE: the installed sheet classifies the pack's plm_system columns as
  // writable, so the mapped values land in the ADD record.
  const plan = planStockPreparationConflicts({ ...planInput, installedFieldProperties: installedSheet() })
  const add = plan.decisions.find((entry) => entry.decision === 'add')
  assert.ok(add, 'the fixture must produce an add decision')
  assert.equal(add.record.ext_parentDrawingNo, 'DWG-A-001')
  assert.equal(add.record.ext_parentSortNo, 10)
  assert.equal(add.record.ext_designer, 'designer-one')
  assert.equal(add.record.componentCode, 'A-001', 'the canonical half still lands')
  // The human band never enters the payload, mapped or not.
  for (const id of PACK_HUMAN_IDS) {
    assert.equal(Object.prototype.hasOwnProperty.call(add.record, id), false, `${id} must never be in an add record`)
  }

  // PACK-UNAWARE CONTROL: without installed properties the planner's writable
  // band is the frozen template's, so the very same row yields a record with NO
  // ext_ key. The mapper cannot widen the refresh on its own — two independent
  // decisions are required, and this is the second one.
  const legacyPlan = planStockPreparationConflicts(planInput)
  const legacyAdd = legacyPlan.decisions.find((entry) => entry.decision === 'add')
  assert.deepEqual(
    Object.keys(legacyAdd.record).filter((key) => key.startsWith('ext_')),
    [],
    'a pack-unaware plan drops mapped ext_ keys rather than writing them',
  )
  assert.equal(legacyAdd.record.componentCode, 'A-001')
}

// ── 8. THE REGRESSION PIN — an unmapped ext_ key fails loud ───────────────────

function recordsApiSpy() {
  const created = []
  const patched = []
  return {
    created,
    patched,
    api: {
      async queryRecords() { return [] },
      async createRecord(input) { created.push(input); return { id: `rec-${created.length}` } },
      async patchRecord(input) { patched.push(input); return { id: input.recordId } },
    },
  }
}

const PHYSICAL = {
  idempotencyKey: 'fld_key',
  projectNo: 'fld_project',
  componentCode: 'fld_code',
  ext_parentDrawingNo: 'fld_ext_drawing',
}

function planWith(record) {
  return { decisions: [{ decision: 'add', idempotencyKey: 'P-001/PART-A/1', record }] }
}

async function unmappedExtKeyFailsLoud() {
  const record = { idempotencyKey: 'P-001/PART-A/1', componentCode: 'A-001', ext_parentDrawingNo: 'DWG-A-001' }

  // A. BOUND — the happy path. The ext_ value is written under its PHYSICAL id,
  // proving the map is what addresses the column.
  const bound = recordsApiSpy()
  const okResult = await applyStockPreparationPlan({
    permission: 'write',
    plan: planWith({ ...record }),
    target: { sheetId: 'sheet-1', fieldIdMap: PHYSICAL },
    recordsApi: bound.api,
  })
  assert.equal(okResult.ok, true, JSON.stringify(okResult.errors))
  assert.equal(bound.created.length, 1)
  assert.equal(bound.created[0].data.fld_ext_drawing, 'DWG-A-001')
  assert.equal(
    Object.prototype.hasOwnProperty.call(bound.created[0].data, 'ext_parentDrawingNo'),
    false,
    'the logical id must not survive translation',
  )

  // B. UNBOUND — the regression pin. The map has explicit bindings but none for
  // the ext_ column. Before this change `mapFieldName` returned the RAW logical
  // id and the write went out addressing a field that does not exist. It must
  // now fail, loudly and typed, and MUST NOT create a record at all.
  const unbound = recordsApiSpy()
  const { ext_parentDrawingNo: _dropped, ...withoutExt } = PHYSICAL
  const failResult = await applyStockPreparationPlan({
    permission: 'write',
    plan: planWith({ ...record }),
    target: { sheetId: 'sheet-1', fieldIdMap: withoutExt },
    recordsApi: unbound.api,
  })
  assert.equal(failResult.ok, false, 'an unmapped ext_ key must not report success')
  assert.equal(failResult.counts.failed, 1)
  assert.equal(failResult.counts.created, 0)
  assert.equal(failResult.errors.length, 1)
  assert.equal(failResult.errors[0].code, 'unmapped_extension_field')
  assert.equal(failResult.errors[0].field, 'ext_parentDrawingNo')
  assert.equal(failResult.errors[0].reason, 'unmapped_extension_field')
  assert.equal(unbound.created.length, 0, 'nothing may be written when a key cannot be addressed')

  // THE FALLBACK ITSELF, pinned at the function. This is the assertion that
  // fails if anyone restores `fieldIdMap[field] || field`.
  assert.throws(
    () => writerInternals.mapFieldName('ext_parentDrawingNo', withoutExt),
    (error) => error instanceof StockPreparationApplyWriterError &&
      error.details.code === 'unmapped_extension_field' &&
      error.details.field === 'ext_parentDrawingNo',
    'an unmapped ext_ id under an explicit map must throw, not fall back',
  )
  assert.throws(
    () => writerInternals.mapRecordFields({ ext_neverBound: 'x' }, withoutExt),
    (error) => error.details && error.details.code === 'unmapped_extension_field',
  )

  // C. CANONICAL ids keep the fallback. Removing it would break every caller
  // that binds only some columns, so the guard is narrow on purpose.
  assert.equal(writerInternals.mapFieldName('componentName', withoutExt), 'componentName')
  assert.equal(writerInternals.mapFieldName('componentCode', withoutExt), 'fld_code')

  // D. THE EMPTY-MAP MODE still passes everything through, ext_ included: with
  // no bindings at all the target is addressed by LOGICAL id, so an ext_ key is
  // not a hole. Getting this wrong would break the untranslated write path.
  assert.equal(writerInternals.fieldIdMapHasExplicitBindings({}), false)
  assert.equal(writerInternals.fieldIdMapHasExplicitBindings({ a: '  ' }), false)
  assert.equal(writerInternals.fieldIdMapHasExplicitBindings({ a: 'fld_a' }), true)
  assert.equal(writerInternals.mapFieldName('ext_parentDrawingNo', {}), 'ext_parentDrawingNo')

  const logical = recordsApiSpy()
  const logicalResult = await applyStockPreparationPlan({
    permission: 'write',
    plan: planWith({ ...record }),
    target: { sheetId: 'sheet-1', fieldIdMap: {} },
    recordsApi: logical.api,
  })
  assert.equal(logicalResult.ok, true, JSON.stringify(logicalResult.errors))
  assert.equal(logical.created[0].data.ext_parentDrawingNo, 'DWG-A-001')
}

// ── 9. the completeness gate covers the mapped ext_ targets ───────────────────

function baseAction(overrides = {}) {
  return {
    source: { externalSystemId: 'sys-1' },
    target: { sheetId: 'sheet-1', fieldIdMap: {} },
    ...overrides,
  }
}

function explicitFieldIdMap(extra = {}) {
  const map = {}
  for (const field of TEMPLATE_FIELDS) map[field.id] = `fld_${field.id}`
  return { ...map, ...extra }
}

function completenessGateCoversExtensionTargets() {
  // CONTROL: a config with no extension ids behaves exactly as before.
  const legacy = assertStockPreparationTargetReady(baseAction({
    target: { sheetId: 'sheet-1', fieldIdMap: explicitFieldIdMap() },
  }))
  assert.equal(Object.prototype.hasOwnProperty.call(legacy, 'extensionFieldIds'), false,
    'a config that declares no extension columns must not grow the key')

  // Declared but NOT bound => the target is refused up front, naming the column.
  let thrown = null
  try {
    assertStockPreparationTargetReady(baseAction({
      extensionFieldIds: ['ext_parentDrawingNo', 'ext_designer'],
      target: { sheetId: 'sheet-1', fieldIdMap: explicitFieldIdMap({ ext_parentDrawingNo: 'fld_ext_drawing' }) },
    }))
  } catch (error) {
    thrown = error
  }
  assert.ok(thrown instanceof StockPreparationTableActionError)
  assert.equal(thrown.code, 'TARGET_SCHEMA_INCOMPLETE')
  assert.deepEqual(thrown.details.missingFields, ['ext_designer'])
  assert.deepEqual(thrown.details.missingExtensionFields, ['ext_designer'])

  // Declared AND bound => ready, and the ids survive normalization in order.
  const ready = assertStockPreparationTargetReady(baseAction({
    extensionFieldIds: ['ext_parentDrawingNo', 'ext_designer'],
    target: {
      sheetId: 'sheet-1',
      fieldIdMap: explicitFieldIdMap({ ext_parentDrawingNo: 'fld_a', ext_designer: 'fld_b' }),
    },
  }))
  assert.deepEqual(ready.extensionFieldIds, ['ext_parentDrawingNo', 'ext_designer'])

  // The declared list is itself fail-closed.
  const badIds = [['componentCode'], ['notExtension'], ['ext_'], ['ext_A'], [42], ['ext_a', 'ext_a'], 'ext_a']
  for (const extensionFieldIds of badIds) {
    assert.throws(
      () => assertStockPreparationTargetReady(baseAction({ extensionFieldIds })),
      (error) => error instanceof StockPreparationTableActionError && error.code === 'TABLE_ACTION_CONFIG_INVALID',
      `extensionFieldIds ${JSON.stringify(extensionFieldIds)} must be refused`,
    )
  }

  // The two halves must agree: a mapping may not write a column the durable
  // config never declared (the mapping object does not survive the JSON snapshot
  // that the gate reads, so the declared list is what protects the stored path).
  const action = assertStockPreparationTargetReady(baseAction({
    extensionFieldIds: ['ext_parentDrawingNo'],
    target: { sheetId: 'sheet-1', fieldIdMap: explicitFieldIdMap({ ext_parentDrawingNo: 'fld_a' }) },
  }))
  assert.doesNotThrow(() => tableActionInternals.assertExtFieldMappingAgreesWithAction(action, undefined))
  assert.doesNotThrow(() => tableActionInternals.assertExtFieldMappingAgreesWithAction(
    action,
    normalize([{ sourceColumn: 'ParentDrawingNo', target: 'ext_parentDrawingNo' }]),
  ))
  assert.throws(
    () => tableActionInternals.assertExtFieldMappingAgreesWithAction(
      action,
      normalize([{ sourceColumn: 'Designer', target: 'ext_designer' }]),
    ),
    (error) => error.code === 'TARGET_SCHEMA_INCOMPLETE' &&
      error.details.undeclaredExtensionFields.includes('ext_designer'),
  )
  assert.throws(
    () => tableActionInternals.assertExtFieldMappingAgreesWithAction(action, { mappings: [] }),
    (error) => error.code === 'TABLE_ACTION_CONFIG_INVALID',
    'an unbranded mapping is refused at the action boundary too',
  )
}

// ── 10. provisioning actually RESOLVES the ext_ ids into the fieldIdMap ───────

function provisioningStub({ resolvable }) {
  const asked = []
  return {
    asked,
    context: {
      api: { multitable: {
        provisioning: {
          async findObjectSheet() { return { id: 'sheet-1' } },
          async resolveFieldIds({ fieldIds }) {
            asked.push([...fieldIds])
            const out = {}
            for (const id of fieldIds) {
              if (resolvable.includes(id)) out[id] = `fld_${id}`
            }
            return out
          },
          async ensureObject() { throw new Error('ensureObject must not be called by inspect') },
        },
      } },
    },
  }
}

async function provisioningBindsExtensionFieldIds() {
  const templateIds = TEMPLATE_FIELDS.map((field) => field.id)

  // CONTROL: no extension ids asked for => the resolve call is unchanged.
  const control = provisioningStub({ resolvable: templateIds })
  const controlResult = await inspectStockPreparationCanonicalTarget({
    context: control.context,
    projectId: 'proj-1',
    permission: 'admin',
  })
  assert.equal(controlResult.ready, true)
  assert.deepEqual(control.asked[0], templateIds, 'the legacy resolve set must not move')
  assert.deepEqual(
    Object.keys(controlResult.target.fieldIdMap).filter((key) => key.startsWith('ext_')),
    [],
  )

  // Asked for and RESOLVABLE => bound in the returned map, so a downstream
  // ext_ write has a real physical id to address.
  const wanted = ['ext_parentDrawingNo', 'ext_designer']
  const bound = provisioningStub({ resolvable: templateIds.concat(wanted) })
  const boundResult = await inspectStockPreparationCanonicalTarget({
    context: bound.context,
    projectId: 'proj-1',
    permission: 'admin',
    extensionFieldIds: wanted,
  })
  assert.equal(boundResult.ready, true)
  assert.deepEqual(bound.asked[0], templateIds.concat(wanted), 'ext_ ids join the resolve set')
  assert.equal(boundResult.target.fieldIdMap.ext_parentDrawingNo, 'fld_ext_parentDrawingNo')
  assert.equal(boundResult.target.fieldIdMap.ext_designer, 'fld_ext_designer')

  // Asked for and UNRESOLVABLE => NOT ready. Fail-closed: an ext_ column that
  // is not installed must not be reported as bindable.
  const missing = provisioningStub({ resolvable: templateIds.concat(['ext_parentDrawingNo']) })
  const missingResult = await inspectStockPreparationCanonicalTarget({
    context: missing.context,
    projectId: 'proj-1',
    permission: 'admin',
    extensionFieldIds: wanted,
  })
  assert.equal(missingResult.ready, false)
  assert.equal(missingResult.target, null)
  assert.deepEqual(missingResult.evidence.missingFields, ['ext_designer'])

  // The requested list is validated, not trusted.
  for (const extensionFieldIds of [['componentCode'], ['notExtension'], ['ext_'], [null], 'ext_a']) {
    await assert.rejects(
      () => inspectStockPreparationCanonicalTarget({
        context: provisioningStub({ resolvable: templateIds }).context,
        projectId: 'proj-1',
        permission: 'admin',
        extensionFieldIds,
      }),
      `extensionFieldIds ${JSON.stringify(extensionFieldIds)} must be refused`,
    )
  }
}

// ── 11. house rules: frozen vocabularies, values-free evidence, no leaks ──────

function frozenVocabulariesAndValuesFreeEvidence() {
  assert.equal(Object.isFrozen(STOCK_PREPARATION_EXT_FIELD_MAPPING_ERROR_REASONS), true)
  assert.equal(new Set(STOCK_PREPARATION_EXT_FIELD_MAPPING_ERROR_REASONS).size, STOCK_PREPARATION_EXT_FIELD_MAPPING_ERROR_REASONS.length)
  assert.equal(Object.isFrozen(mappingInternals.COERCION_REASON_BY_TYPE), true)
  assert.equal(Object.isFrozen(mappingInternals.MAPPING_KEYS), true)
  assert.equal(Object.isFrozen(mappingInternals.MAPPING_ENTRY_KEYS), true)
  assert.ok(MAPPING_ID_PATTERN instanceof RegExp)
  assert.ok(SOURCE_COLUMN_PATTERN instanceof RegExp)

  // Every reason token this module can produce is in the frozen vocabulary.
  for (const reason of Object.values(mappingInternals.COERCION_REASON_BY_TYPE)) {
    assert.ok(STOCK_PREPARATION_EXT_FIELD_MAPPING_ERROR_REASONS.includes(reason), `${reason} must be declared`)
  }

  const mapping = normalize([
    { sourceColumn: 'ParentDrawingNo', target: 'ext_parentDrawingNo' },
    { sourceColumn: 'SortNo', target: 'ext_parentSortNo' },
  ])
  const evidence = summarizeExtFieldMappingForEvidence(mapping)
  const text = JSON.stringify(evidence)
  assert.equal(evidence.mappingCount, 2)
  assert.deepEqual(evidence.targetFieldIds, ['ext_parentDrawingNo', 'ext_parentSortNo'])
  assert.deepEqual(evidence.coercions, [
    { target: 'ext_parentDrawingNo', coerce: 'string', ownership: 'plm_system' },
    { target: 'ext_parentSortNo', coerce: 'number', ownership: 'plm_system' },
  ])
  // Source COLUMN names are schema and may appear; source VALUES may not — the
  // evidence projection never sees a row, so this is a structural guarantee.
  assert.equal(text.includes('DWG-A-001'), false)

  // Mutating an evidence projection must not reach the mapping behind it.
  evidence.targetFieldIds.push('ext_poisoned')
  assert.deepEqual(extFieldMappingTargetIds(mapping), ['ext_parentDrawingNo', 'ext_parentSortNo'])

  // No live mutable export leaks (Set/Map handed out by reference).
  const seen = new WeakSet()
  const walk = (value, label) => {
    assert.ok(!(value instanceof Set), `${label}: live Set instance exported`)
    assert.ok(!(value instanceof Map), `${label}: live Map instance exported`)
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return
    if (seen.has(value)) return
    seen.add(value)
    for (const [key, child] of Object.entries(value)) walk(child, `${label}.${key}`)
  }
  walk(require(path.join(LIB, 'stock-preparation-ext-field-mapping.cjs')), 'module')

  assert.ok(new StockPreparationExtFieldMappingError('m', 'MAPPING_NOT_AN_OBJECT') instanceof Error)
}

async function main() {
  normalizerAcceptsAValidConfig()
  normalizerRejectsEachMalformedShape()
  humanOwnedTargetIsRefused()
  canonicalTargetIsRefused()
  typeCoercionSucceedsAndRefuses()
  await rowProductionCarriesMappedValues()
  await mappedValueReachesTheRecordThroughTheRealPlanner()
  await unmappedExtKeyFailsLoud()
  completenessGateCoversExtensionTargets()
  await provisioningBindsExtensionFieldIds()
  frozenVocabulariesAndValuesFreeEvidence()
}

main().then(() => {
  console.log('stock-preparation-ext-field-mapping.test.cjs OK')
}, (error) => {
  console.error(error)
  process.exit(1)
})
