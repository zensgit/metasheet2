/**
 * source-discovery-draft-emitter.mjs
 *
 * H1 of docs/development/platform-overall-design/source-onboarding-self-service-design-20260830.md
 * — the half that turns implementation from "author configs" into "confirm a generated draft".
 *
 * source-discovery-probe.mjs discovers STRUCTURE (tables, columns, dictionary-shaped tables) and is
 * values-free by construction. This module is what a VENDOR PRESET plus that structure buys you: it
 * reads the CUSTOMER'S OWN dictionary tables per the preset and emits a draft `ext_` field mapping
 * plus a customer-pack skeleton for a human to confirm.
 *
 * ============================================================================
 * THE ONE RULE THE PRESET OBEYS: HOW TO DISCOVER, NEVER WHAT WAS DISCOVERED
 * ============================================================================
 * A preset may say "this vendor family keeps its part-side attribute dictionary in
 * DN_PM_PartExAttrInfo, the slot name is in column X, the label in column Y, and `isable = 0` means
 * ENABLED (yes, inverted — that is a vendor quirk, so it belongs to the vendor description)".
 *
 * A preset may NEVER say "part_ExAttr14 is 物料编码". Which slot carries which meaning is the
 * CUSTOMER's assignment, it differs per deployment, and it is read at probe time from the
 * customer's own dictionary rows. Every mapping this module proposes therefore carries a `basis`
 * string quoting the dictionary row (or the catalog fact) that justified it.
 *
 * ============================================================================
 * FAIL-CLOSED: TWO KINDS OF JUSTIFICATION, AND NOTHING ELSE
 * ============================================================================
 *   1. `native`     — the preset declares a vendor-native column (DN_PDM_PartLibraryInfo.IdentityNo).
 *                     Justified by the DISCOVERED CATALOG actually carrying that column. Absent
 *                     column => unresolved, never a near-miss on a similar name.
 *   2. `dictionary` — the preset declares LABEL ALIASES for a target. Justified by an ENABLED row of
 *                     the customer's dictionary whose label equals one of them. Two matching rows =>
 *                     AMBIGUOUS => unresolved. Zero => unresolved.
 *
 * There is no third kind. Column-name similarity is never a justification: on this vendor family the
 * column names are literally `Bom_ExAttr1..30` / `Part_ExAttr1..70` and carry ZERO semantics, so a
 * name-similarity guess is not merely weak, it is structurally impossible to be right.
 *
 * A THIRD, EXPLICITLY-LABELLED PRODUCT: `placeholder`. An enabled dictionary row that NO preset
 * target claimed is still a positive discovery — the customer says that slot is live and means
 * <label>. It becomes a proposed extension field whose ID is a MECHANICAL transform of the slot
 * COLUMN NAME (`part_ExAttr10` -> `ext_partExAttr10`), never of the label (transliterating 型号 into
 * an ASCII identifier would be exactly the guessing this module refuses). The meaning travels in the
 * `label`, verbatim from the customer's dictionary, and every one is marked CONFIRM-REQUIRED.
 *
 * ============================================================================
 * LOUD ABOUT GAPS
 * ============================================================================
 * A draft that silently omits what it could not resolve reproduces the `ext_`-all-empty silent
 * failure (scripts/ops/fixtures/stock-prep-synthetic-plm/schema.sql GOTCHA 2: a mapped source column
 * that does not exist does not fail the run — the column just stays empty forever). So:
 *   * every unresolved target is emitted WITH a coded reason and what was looked for;
 *   * every skipped dictionary row is counted by reason;
 *   * a target whose source row is not the row the mapper actually reads is DEFERRED, not dropped;
 *   * an empty draft is emitted as a loud empty draft, never as a plausible-looking small one.
 *
 * ============================================================================
 * VALUES: IN THE DRAFT, NOT IN THE REPORT
 * ============================================================================
 * The draft files are deploy-host output and CONTAIN customer values (dictionary labels, option
 * vocabularies) — that is their entire purpose. The probe's own report/STDOUT stays values-free:
 * `buildDraftEmissionSummary()` is the ONLY thing that crosses back into the report and it carries
 * identifiers, coded tokens and counts exclusively — no label, no option value, no free prose (prose
 * would give the probe's whole-word leak sweep an ordinary-English surface to collide with).
 *
 * ============================================================================
 * ONE ADAPTER, TWO PRESET DIALECTS
 * ============================================================================
 * `adaptVendorPresetShape` is the ONLY function that knows what a preset file looks like; every
 * other function downstream (here and in source-discovery-probe.mjs) sees one normalized internal
 * shape. It reads two dialects:
 *
 *   * the SIBLING SCHEMA (`presetSchema: "metasheet.source-vendor-preset"`), defined on branch
 *     feat/stock-prep-vendor-presets — a count-floor signature, `rows-name-columns` dictionaries
 *     whose own columns are DISCOVERED rather than declared, an enabled-flag column pattern plus a
 *     polarity, and `semanticExpectations` instead of `ext_` ids. This is the real one; the
 *     branch's dn-pdm-family.preset.json is read unmodified. See adaptSiblingVendorPreset().
 *   * a flat shape that names everything outright, kept because it is the smallest input a test (or
 *     a one-off vendor) can hand this module, and because it is what this side was written against
 *     before the schema landed.
 *
 * PURE. Every function here is a pure function of its arguments — rows arrive as arrays, nothing
 * here opens a connection, reads a file or holds a clock. The probe owns all I/O.
 */

import path from 'node:path'

// ---------------------------------------------------------------------------
// Closed reason vocabulary. Every refusal, every unresolved entry and every
// skipped dictionary row carries exactly one of these, so an operator (and the
// report) branches on a token instead of parsing prose.
// ---------------------------------------------------------------------------

const DRAFT_EMITTER_REASONS = Object.freeze([
  // --- preset shape (the adapter) -------------------------------------------
  'PRESET_NOT_AN_OBJECT',
  'PRESET_ID_INVALID',
  'PRESET_VERSION_INVALID',
  'PRESET_MATCHES_INVALID',
  'PRESET_DICTIONARY_INVALID',
  'PRESET_VALUE_SET_INVALID',
  'PRESET_FAMILY_MISSING',
  'PRESET_FAMILY_INVALID',
  'PRESET_TARGET_INVALID',
  'PRESET_TARGET_DUPLICATE',
  'PRESET_MAPPING_SOURCE_TABLE_MISSING',
  // --- vendor selection ------------------------------------------------------
  'PRESET_SET_EMPTY',
  'PRESET_SIGNATURE_NOT_MET',
  'PRESET_SIGNATURE_AMBIGUOUS',
  // --- catalog lookups -------------------------------------------------------
  'TABLE_ABSENT',
  'TABLE_AMBIGUOUS',
  // --- dictionary rows -------------------------------------------------------
  'ROW_DISABLED',
  'ROW_SLOT_EMPTY',
  'ROW_LABEL_EMPTY',
  'ROW_SLOT_NOT_A_COLUMN',
  'ROW_SLOT_OUTSIDE_COLUMN_FAMILY',
  'ROW_SLOT_DUPLICATE',
  // --- dictionary column discovery (rows-name-columns presets) ---------------
  'DICTIONARY_SLOT_COLUMN_UNDISCOVERED',
  'DICTIONARY_LABEL_COLUMN_UNDISCOVERED',
  'DICTIONARY_ENABLED_COLUMN_UNDISCOVERED',
  // --- target resolution -----------------------------------------------------
  'NATIVE_TABLE_ABSENT',
  'NATIVE_COLUMN_ABSENT',
  'NATIVE_TYPE_UNMAPPED',
  'DICTIONARY_NOT_READ',
  'DICTIONARY_NO_ALIAS_MATCH',
  'DICTIONARY_AMBIGUOUS_ALIAS_MATCH',
  'PLACEHOLDER_ID_UNDERIVABLE',
  'PLACEHOLDER_ID_COLLISION',
  'DICTIONARY_TYPE_UNMAPPED',
  // --- mapping consumability -------------------------------------------------
  'SOURCE_TABLE_NOT_THE_MAPPED_ROW',
  // --- option sets -----------------------------------------------------------
  'VALUE_SET_NOT_DECLARED_IN_PRESET',
  'VALUE_SET_NOT_READ',
  'VALUE_SET_EMPTY',
  'VALUE_SET_OVER_CAP',
  'VALUE_SET_TABLE_PATTERN_MISMATCH',
  'VALUE_SET_COLUMN_AMBIGUOUS',
  // --- output placement ------------------------------------------------------
  'DRAFT_OUT_DIR_INSIDE_REPO',
  'DRAFT_OUT_DIR_INVALID',
])

// The customer-pack normalizer's own limit (stock-preparation-option-sync.cjs MAX_OPTIONS_PER_FIELD).
// Duplicated as a NUMBER rather than imported because this file is an ESM ops script and the pack
// modules are CJS plugin internals; a draft that proposed 300 options would be refused downstream,
// so the draft refuses first and says so.
const MAX_OPTIONS_PER_FIELD = 200

// Matches stock-preparation-customer-pack.cjs PACK_ID_PATTERN / ext-field-mapping MAPPING_ID_PATTERN.
const PACK_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/
// Matches stock-preparation-extension-namespace.cjs SUFFIX_SHAPE_PATTERN.
const EXT_FIELD_SUFFIX_PATTERN = /^[a-z][a-zA-Z0-9]{0,63}$/
const EXT_FIELD_ID_PREFIX = 'ext_'
// Matches stock-preparation-ext-field-mapping.cjs SOURCE_COLUMN_PATTERN.
// CJK written as escapes, not literals, so the character class stays reviewable in a diff — the
// same discipline the mapper's own copy of this pattern uses.
const SOURCE_COLUMN_PATTERN = /^[A-Za-z0-9_一-鿿][A-Za-z0-9_一-鿿-]{0,63}$/

const FIELD_TYPES = Object.freeze(['string', 'number', 'boolean', 'date', 'select'])
const FIELD_OWNERSHIPS = Object.freeze(['plm_system', 'human_preserved'])

const DRAFT_FILE_NAMES = Object.freeze({
  mapping: 'ext-field-mapping.draft.json',
  pack: 'customer-pack.draft.json',
  readme: 'DRAFT-README.md',
})

class SourceDraftEmitterError extends Error {
  constructor(message, reason, details = {}) {
    super(message)
    this.name = 'SourceDraftEmitterError'
    this.reason = reason
    this.details = details
  }
}

function fail(reason, message, details) {
  throw new SourceDraftEmitterError(message, reason, details || {})
}

// ---------------------------------------------------------------------------
// Cell helpers. Every one of these exists because of a shape a real driver
// actually handed us: a bigint arriving as a STRING (the F13 false negative that
// screened out every table and reported "zero dictionaries"), a flag arriving as
// `0` on one row and `"0"` on the next, an ExAttr whose label is `''` rather
// than NULL.
// ---------------------------------------------------------------------------

function cellText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'bigint') return value.toString()
  return String(value).trim()
}

/**
 * Enabled-flag comparison, done on the TEXT form on both sides. `0`, `0n` and `"0"` are the same
 * answer from three different drivers, and a `typeof` test on this is the exact shape of the bug
 * that made the probe report zero dictionaries against a live SQL Server.
 */
function matchesEnabledValue(raw, enabledValues) {
  const text = cellText(raw)
  for (const candidate of enabledValues) {
    if (cellText(candidate) === text) return true
  }
  return false
}

/**
 * "Is this row enabled", the one predicate every dictionary read goes through. Two ways a preset can
 * say it, because the two preset dialects say it differently:
 *   * an explicit VALUE LIST (`enabledValues`), and
 *   * a POLARITY (`zero-means-enabled` / `nonzero-means-enabled`), which is how the vendor-preset
 *     schema states it — the family's flag is inverted relative to intuition, so the polarity is a
 *     vendor fact and belongs in the preset rather than in a reader's assumption.
 * A blank cell is never enabled under either reading: "no answer" is not "yes".
 */
function isEnabledCell(raw, spec) {
  const text = cellText(raw)
  if (spec.enabledPolarity === 'zero-means-enabled') return text === '0'
  if (spec.enabledPolarity === 'nonzero-means-enabled') return text !== '' && text !== '0'
  return matchesEnabledValue(raw, spec.enabledValues)
}

// Mirrors the probe's own MSSQL_TEXT_TYPES. Kept as a local copy rather than imported because this
// module must stay a pure leaf (the probe imports IT, not the other way round); it is used only to
// decide which column of a vocabulary table could be its value column, and a miss there produces a
// LOUD ambiguity gap, never a wrong pick.
const TEXT_LIKE_TYPES = new Set(['char', 'nchar', 'varchar', 'nvarchar', 'text', 'ntext'])

function isTextLikeColumn(column) {
  return TEXT_LIKE_TYPES.has(String((column && column.dataType) || '').toLowerCase())
}

// Catalog data type -> the field type a pack can declare. Used ONLY for a NATIVE target whose preset
// entry declares no type: the column's own type is a fact the discovery read established, so reading
// it is a derivation, not a guess. An unmapped type is a gap, never a defaulted `string`.
const CATALOG_TYPE_TO_FIELD_TYPE = Object.freeze({
  char: 'string', nchar: 'string', varchar: 'string', nvarchar: 'string', text: 'string', ntext: 'string',
  tinyint: 'number', smallint: 'number', int: 'number', bigint: 'number',
  decimal: 'number', numeric: 'number', float: 'number', real: 'number', money: 'number', smallmoney: 'number',
  bit: 'boolean',
  date: 'date', datetime: 'date', datetime2: 'date', smalldatetime: 'date', datetimeoffset: 'date',
})

function fieldTypeForCatalogColumn(column) {
  return CATALOG_TYPE_TO_FIELD_TYPE[String((column && column.dataType) || '').toLowerCase()] || null
}

// ---------------------------------------------------------------------------
// NO REGULAR EXPRESSION IS EVER BUILT FROM PRESET TEXT.
//
// An adversarial review of the preset schema's first cut EXECUTED nine smuggles,
// and the free-form hint pattern was the one string slot no scan touched: an
// attack parked both a concrete slot name and an option vocabulary inside it. The
// schema's answer was to delete every pattern-typed field from v1 and replace it
// with CLOSED ENUMS whose word lists live in CODE.
//
// This module is the consumer, so it holds the same line: `new RegExp` is never
// called on a preset-supplied string anywhere below. A preset selects a hint by
// enum KEY; the words are here. A "family" of generic columns arrives STRUCTURED
// ({ stems, indexMin, indexMax }) and its matcher is GENERATED, so a family
// cannot be authored as a single-member language pointing at one customer's slot.
//
// WHERE THE WORDS COME FROM. When the schema module is available (it ships with
// the preset catalog on plugins/plugin-integration-core/lib/source-vendor-presets/),
// the probe injects ITS exports and they are used verbatim — one vocabulary, no
// drift. The copies below are the fallback for a checkout where that module is
// not present yet, and a test asserts the two are identical whenever it IS
// present, so a divergence reddens rather than silently forks.
// ---------------------------------------------------------------------------

const FALLBACK_LABEL_HINT_VOCABULARY = Object.freeze({
  quantity: /数量|qty|quantity/i,
  unit: /单位|unit/i,
  'material-code': /物料编码|matcode|material/i,
})

const FALLBACK_DICTIONARY_TYPE_HINT_WORDS = Object.freeze({
  numeric: /float|numeric|decimal|double|real|int/i,
  list: /list|enum|select/i,
  text: /text|char|string/i,
})

// Mirrors the schema's own familyColumnMatcher(): anchored, case-insensitive, stems alternated,
// 1-4 digit index. Used only when the schema module is not injected.
function escapeForRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function fallbackFamilyColumnMatcher(family) {
  const stems = Array.isArray(family && family.stems) ? family.stems : []
  return new RegExp(`^(?:${stems.map(escapeForRegExp).join('|')})([0-9]{1,4})$`, 'i')
}

function fallbackIsFamilyColumn(family, columnName) {
  const match = fallbackFamilyColumnMatcher(family).exec(String(columnName))
  if (!match) return false
  const index = Number(match[1])
  return Number.isInteger(index) && index >= family.indexMin && index <= family.indexMax
}

/**
 * Resolve the vocabulary + family helpers this adaptation run will use. `schema` is the sibling
 * `preset-schema.cjs` module's exports when the probe could load it, and nothing otherwise.
 */
function resolvePresetSchemaBinding(schema) {
  const bound = schema && typeof schema === 'object' ? schema : null
  return Object.freeze({
    source: bound ? 'schema-module' : 'local-fallback',
    labelHints: (bound && bound.LABEL_HINT_VOCABULARY) || FALLBACK_LABEL_HINT_VOCABULARY,
    typeHints: (bound && bound.DICTIONARY_TYPE_HINT_WORDS) || FALLBACK_DICTIONARY_TYPE_HINT_WORDS,
    isFamilyColumn: (bound && typeof bound.isFamilyColumn === 'function') ? bound.isFamilyColumn : fallbackIsFamilyColumn,
    familyColumnMatcher: (bound && typeof bound.familyColumnMatcher === 'function')
      ? bound.familyColumnMatcher
      : fallbackFamilyColumnMatcher,
  })
}

// Structured generic-column / value-set-table family. Validated for SHAPE only — the schema module
// is the authority on the anti-smuggling rules (stem must not end in a digit, indexMin is 0 or 1,
// cardinality floor), and the probe runs its `assertVendorPreset` before this module sees a
// sibling-shaped preset. What is enforced here is only what this module must have to work at all.
function normalizeColumnFamily(raw, reason, label) {
  if (!isPlainObject(raw)) fail(reason, `${label} must be a plain object`, { field: label })
  const stems = uniqueStrings(Array.isArray(raw.stems) ? raw.stems : [])
  if (stems.length === 0) fail(reason, `${label}.stems must list at least one stem`, { field: `${label}.stems` })
  for (const stem of stems) {
    // A stem ending in a digit would let `stems: ['Bom_ExAttr1']` name ONE customer slot while
    // wearing a family's clothes. The schema refuses it; refuse it here too rather than trust that
    // the validator ran.
    if (/[0-9]$/.test(stem)) {
      fail(reason, `${label}.stems must not end in a digit — that names a concrete slot, not a family`, {
        field: `${label}.stems`,
      })
    }
  }
  const indexMin = Number(raw.indexMin)
  const indexMax = Number(raw.indexMax)
  if (!Number.isInteger(indexMin) || !Number.isInteger(indexMax) || indexMax < indexMin) {
    fail(reason, `${label} must carry integer indexMin/indexMax with indexMax >= indexMin`, { field: label })
  }
  return Object.freeze({ stems: Object.freeze(stems), indexMin, indexMax })
}

// Labels are compared for alias matching. Case folding is safe for ASCII and a
// no-op for CJK; the comparison is EQUALITY on the trimmed, folded text — never
// a substring or a fuzzy distance, because "近似" is how a draft acquires a
// confident wrong answer.
function labelKey(value) {
  return cellText(value).toLowerCase()
}

function uniqueStrings(values) {
  const seen = new Set()
  const out = []
  for (const v of values) {
    const text = cellText(v)
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

// ---------------------------------------------------------------------------
// >>> THE ADAPTER <<<
//
// adaptVendorPresetShape() is the ONE place in this codebase that knows what a
// vendor preset LOOKS LIKE. Everything downstream operates on the normalized
// internal shape it returns, and no other function in this module or in
// source-discovery-probe.mjs touches a raw preset key — so teaching this tool a
// new preset dialect is a change to this function and nothing else. (That claim
// was paid for rather than asserted: the sibling schema landed shaped quite
// differently from the flat form below and was absorbed entirely here.)
//
// Below is the FLAT dialect: everything named outright. The sibling schema's
// reader is adaptSiblingVendorPreset(), further down.
//
// Both obey the schema's core rule: every key describes WHERE TO LOOK and HOW TO
// READ. There is no key in which a preset could record a customer's actual
// ExAttr assignment.
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function requireString(value, reason, label) {
  const text = cellText(value)
  if (!text) fail(reason, `${label} must be a non-empty string`, { field: label })
  return text
}

function optionalString(value) {
  const text = cellText(value)
  return text || null
}

// The sibling branch's schema marker (feat/stock-prep-vendor-presets,
// plugins/plugin-integration-core/lib/source-vendor-presets/preset-schema.cjs
// SOURCE_VENDOR_PRESET_SCHEMA_MARKER). Presence of this key is what routes a preset to the
// sibling-shape reader below; anything else is read as the documented flat shape.
const SIBLING_PRESET_SCHEMA_MARKER = 'metasheet.source-vendor-preset'
// Same constant under the schema module's own export name, so a reader grepping either spelling
// lands here.
const SOURCE_VENDOR_PRESET_SCHEMA_MARKER = SIBLING_PRESET_SCHEMA_MARKER

function adaptVendorPresetShape(raw, options = {}) {
  if (!isPlainObject(raw)) {
    fail('PRESET_NOT_AN_OBJECT', 'a vendor preset must be a plain object', {})
  }
  const binding = resolvePresetSchemaBinding(options.schema)
  if (cellText(raw.presetSchema) === SIBLING_PRESET_SCHEMA_MARKER) {
    return adaptSiblingVendorPreset(raw, binding)
  }
  return adaptFlatVendorPreset(raw, binding)
}

// Selects one closed-enum hint and returns the CODE-HELD predicate for it. A key outside the
// vocabulary is refused: an unknown hint must not degrade to "no hint", which would silently widen
// the candidate set instead of narrowing it.
function resolveHint(key, vocabulary, reason, label) {
  const text = cellText(key)
  if (!text) return null
  if (!Object.prototype.hasOwnProperty.call(vocabulary, text)) {
    fail(reason, `${label} must be one of [${Object.keys(vocabulary).join(', ')}] — a closed enum`, {
      field: label,
      hint: text,
    })
  }
  return Object.freeze({ key: text, test: vocabulary[text] })
}

// The pattern-typed keys v1 deleted. A preset still carrying one is REFUSED rather than ignored:
// silently dropping it would restore the smuggling channel's payload to a file nobody re-reads.
const DELETED_PATTERN_KEYS = Object.freeze([
  'labelHintPattern',
  'dictionaryTypeHintPattern',
  'valueSetTableNamePattern',
  'labelPattern',
  'typeHintPattern',
  'columnPattern',
  'pattern',
])

function assertNoDeletedPatternKeys(input, reason, label) {
  for (const key of DELETED_PATTERN_KEYS) {
    if (isPlainObject(input) && Object.prototype.hasOwnProperty.call(input, key)) {
      fail(reason, `${label}.${key} is a pattern-typed key deleted in preset v1 — hints are closed enums and families are structured`, {
        field: `${label}.${key}`,
        key,
      })
    }
  }
}

function adaptFlatVendorPreset(raw, binding) {
  const presetId = requireString(raw.presetId, 'PRESET_ID_INVALID', 'preset.presetId')
  if (!PACK_ID_PATTERN.test(presetId)) {
    // The preset id seeds the draft packId and mappingId, both of which are
    // validated by the pack/mapper normalizers against exactly this pattern. A
    // preset that cannot seed a legal pack id would produce a draft that cannot
    // install, so it is refused here rather than three files later.
    fail('PRESET_ID_INVALID', `preset.presetId must match ${PACK_ID_PATTERN}`, { field: 'preset.presetId', presetId })
  }
  if (!Number.isInteger(raw.presetVersion) || raw.presetVersion < 1) {
    fail('PRESET_VERSION_INVALID', 'preset.presetVersion must be a positive integer', { field: 'preset.presetVersion' })
  }

  // --- matches: the vendor SIGNATURE ---------------------------------------
  const matches = isPlainObject(raw.matches) ? raw.matches : null
  if (!matches) fail('PRESET_MATCHES_INVALID', 'preset.matches must be a plain object', { field: 'preset.matches' })
  const requiredTables = uniqueStrings(Array.isArray(matches.requiredTables) ? matches.requiredTables : [])
  if (requiredTables.length === 0) {
    // A preset with no required tables would match every database on earth,
    // i.e. it would GUESS a vendor. Refused.
    fail('PRESET_MATCHES_INVALID', 'preset.matches.requiredTables must list at least one table', {
      field: 'preset.matches.requiredTables',
    })
  }
  const optionalTables = uniqueStrings(Array.isArray(matches.optionalTables) ? matches.optionalTables : [])
  const forbiddenTables = uniqueStrings(Array.isArray(matches.forbiddenTables) ? matches.forbiddenTables : [])
  const minimumConfidence =
    typeof matches.minimumConfidence === 'number' && matches.minimumConfidence > 0 && matches.minimumConfidence <= 1
      ? matches.minimumConfidence
      : 1

  // --- dictionaries: WHERE the customer's own assignments live --------------
  const dictionaries = new Map()
  const rawDictionaries = Array.isArray(raw.dictionaries) ? raw.dictionaries : []
  for (const [index, entry] of rawDictionaries.entries()) {
    const at = `preset.dictionaries[${index}]`
    if (!isPlainObject(entry)) fail('PRESET_DICTIONARY_INVALID', `${at} must be a plain object`, { field: at })
    assertNoDeletedPatternKeys(entry, 'PRESET_DICTIONARY_INVALID', at)
    const key = requireString(entry.key, 'PRESET_DICTIONARY_INVALID', `${at}.key`)
    if (dictionaries.has(key)) {
      fail('PRESET_DICTIONARY_INVALID', `${at}.key is declared twice`, { field: `${at}.key`, key })
    }
    const enabledColumn = optionalString(entry.enabledColumn)
    const enabledValues = Array.isArray(entry.enabledValues) ? entry.enabledValues.map(cellText) : []
    // "Enabled rows only" is load-bearing: on the observed vendor family only 2 of 30 bom-side
    // slots and 21 of 73 part-side slots are live. Two ways to lose the filter, and BOTH are
    // refused — naming the column without saying which value means ENABLED, and omitting the column
    // altogether. The second was the weaker hole: it read as "this dictionary has no flag" and
    // silently promoted every row, including the ones the customer switched off. The sibling
    // dialect already refuses a missing `enabledFlag`; this dialect gets no weaker gate.
    if (!enabledColumn) {
      fail('PRESET_DICTIONARY_INVALID', `${at}.enabledColumn is required — a dictionary read with no flag promotes rows the customer switched off`, {
        field: `${at}.enabledColumn`,
        key,
      })
    }
    if (enabledValues.length === 0) {
      fail('PRESET_DICTIONARY_INVALID', `${at}.enabledValues must list the value(s) that mean ENABLED`, {
        field: `${at}.enabledValues`,
        key,
      })
    }
    dictionaries.set(key, Object.freeze({
      key,
      table: requireString(entry.table, 'PRESET_DICTIONARY_INVALID', `${at}.table`),
      // The table whose COLUMNS the slot values name. This is what makes a slot
      // value verifiable against the discovered catalog instead of trusted.
      describesTable: requireString(entry.describesTable, 'PRESET_DICTIONARY_INVALID', `${at}.describesTable`),
      slotColumn: requireString(entry.slotColumn, 'PRESET_DICTIONARY_INVALID', `${at}.slotColumn`),
      labelColumn: requireString(entry.labelColumn, 'PRESET_DICTIONARY_INVALID', `${at}.labelColumn`),
      enabledColumn,
      enabledValues: Object.freeze(enabledValues),
      typeColumn: optionalString(entry.typeColumn),
      valueSetColumn: optionalString(entry.valueSetColumn),
      // Columns are named outright in this shape, so nothing has to be discovered.
      discoverColumns: false,
      enabledColumnCandidates: Object.freeze([]),
      enabledPolarity: null,
      valueSetTableFamily: null,
      columnFamily: entry.columnFamily === undefined || entry.columnFamily === null
        ? null
        : normalizeColumnFamily(entry.columnFamily, 'PRESET_DICTIONARY_INVALID', `${at}.columnFamily`),
    }))
  }

  // --- value sets: HOW to read a vocabulary table ---------------------------
  const valueSets = new Map()
  const rawValueSets = Array.isArray(raw.valueSets) ? raw.valueSets : []
  for (const [index, entry] of rawValueSets.entries()) {
    const at = `preset.valueSets[${index}]`
    if (!isPlainObject(entry)) fail('PRESET_VALUE_SET_INVALID', `${at} must be a plain object`, { field: at })
    const key = requireString(entry.key, 'PRESET_VALUE_SET_INVALID', `${at}.key`)
    if (valueSets.has(key)) {
      fail('PRESET_VALUE_SET_INVALID', `${at}.key is declared twice`, { field: `${at}.key`, key })
    }
    const enabledColumn = optionalString(entry.enabledColumn)
    const enabledValues = Array.isArray(entry.enabledValues) ? entry.enabledValues.map(cellText) : []
    if (enabledColumn && enabledValues.length === 0) {
      fail('PRESET_VALUE_SET_INVALID', `${at}.enabledValues must list the value(s) that mean ENABLED`, {
        field: `${at}.enabledValues`,
        key,
      })
    }
    valueSets.set(key, Object.freeze({
      key,
      table: requireString(entry.table, 'PRESET_VALUE_SET_INVALID', `${at}.table`),
      valueColumn: requireString(entry.valueColumn, 'PRESET_VALUE_SET_INVALID', `${at}.valueColumn`),
      labelColumn: optionalString(entry.labelColumn),
      enabledColumn,
      enabledValues: Object.freeze(enabledValues),
    }))
  }

  // --- typeMap: vendor type token -> our field type -------------------------
  const typeMap = new Map()
  if (isPlainObject(raw.typeMap)) {
    for (const [token, type] of Object.entries(raw.typeMap)) {
      const our = cellText(type)
      if (!FIELD_TYPES.includes(our)) {
        fail('PRESET_TARGET_INVALID', `preset.typeMap.${token} must be one of ${FIELD_TYPES.join(', ')}`, {
          field: `preset.typeMap.${token}`,
        })
      }
      typeMap.set(labelKey(token), our)
    }
  }
  const defaultType = optionalString(raw.defaultType)
  if (defaultType && !FIELD_TYPES.includes(defaultType)) {
    fail('PRESET_TARGET_INVALID', `preset.defaultType must be one of ${FIELD_TYPES.join(', ')}`, {
      field: 'preset.defaultType',
    })
  }
  const defaultOwnership = optionalString(raw.defaultOwnership) || 'plm_system'
  if (!FIELD_OWNERSHIPS.includes(defaultOwnership)) {
    fail('PRESET_TARGET_INVALID', `preset.defaultOwnership must be one of ${FIELD_OWNERSHIPS.join(', ')}`, {
      field: 'preset.defaultOwnership',
    })
  }

  // --- mappingSourceTable ---------------------------------------------------
  // The ONE row `applyExtFieldMapping` is handed (see its call site in
  // stock-preparation-bom-expansion.cjs, which passes `partRow`). A resolved
  // target whose column lives on a different table cannot become a mapping
  // entry today; it is DEFERRED loudly rather than emitted into a mapping that
  // would silently produce nothing.
  const mappingSourceTable = requireString(
    raw.mappingSourceTable,
    'PRESET_MAPPING_SOURCE_TABLE_MISSING',
    'preset.mappingSourceTable',
  )

  // --- targets --------------------------------------------------------------
  const targets = []
  const seenTargets = new Set()
  const rawTargets = Array.isArray(raw.targets) ? raw.targets : []
  for (const [index, entry] of rawTargets.entries()) {
    const at = `preset.targets[${index}]`
    if (!isPlainObject(entry)) fail('PRESET_TARGET_INVALID', `${at} must be a plain object`, { field: at })
    assertNoDeletedPatternKeys(entry, 'PRESET_TARGET_INVALID', at)
    const target = requireString(entry.target, 'PRESET_TARGET_INVALID', `${at}.target`)
    if (!target.startsWith(EXT_FIELD_ID_PREFIX) || !EXT_FIELD_SUFFIX_PATTERN.test(target.slice(EXT_FIELD_ID_PREFIX.length))) {
      fail('PRESET_TARGET_INVALID', `${at}.target must be "${EXT_FIELD_ID_PREFIX}" + ASCII camelCase`, {
        field: `${at}.target`,
        target,
      })
    }
    if (seenTargets.has(target)) {
      fail('PRESET_TARGET_DUPLICATE', `${at}.target is declared twice`, { field: `${at}.target`, target })
    }
    seenTargets.add(target)

    const via = requireString(entry.via, 'PRESET_TARGET_INVALID', `${at}.via`)
    if (via !== 'native' && via !== 'dictionary') {
      fail('PRESET_TARGET_INVALID', `${at}.via must be "native" or "dictionary"`, { field: `${at}.via`, via })
    }
    const type = optionalString(entry.type)
    if (type && !FIELD_TYPES.includes(type)) {
      fail('PRESET_TARGET_INVALID', `${at}.type must be one of ${FIELD_TYPES.join(', ')}`, { field: `${at}.type` })
    }
    const ownership = optionalString(entry.ownership) || defaultOwnership
    if (!FIELD_OWNERSHIPS.includes(ownership)) {
      fail('PRESET_TARGET_INVALID', `${at}.ownership must be one of ${FIELD_OWNERSHIPS.join(', ')}`, {
        field: `${at}.ownership`,
      })
    }

    const common = {
      target,
      via,
      type,
      ownership,
      label: optionalString(entry.label),
      valueSet: optionalString(entry.valueSet),
      // CLOSED ENUMS, both of them. The words are in code (see the block above the adapter); a
      // preset selects one by key and can carry no vocabulary of its own.
      labelHint: resolveHint(entry.labelHint, binding.labelHints, 'PRESET_TARGET_INVALID', `${at}.labelHint`),
      typeHint: resolveHint(entry.dictionaryTypeHint, binding.typeHints, 'PRESET_TARGET_INVALID', `${at}.dictionaryTypeHint`),
    }

    if (via === 'native') {
      targets.push(Object.freeze({
        ...common,
        table: requireString(entry.table, 'PRESET_TARGET_INVALID', `${at}.table`),
        column: requireString(entry.column, 'PRESET_TARGET_INVALID', `${at}.column`),
        dictionary: null,
        labelAliases: Object.freeze([]),
      }))
      continue
    }

    const dictionaryKey = requireString(entry.dictionary, 'PRESET_TARGET_INVALID', `${at}.dictionary`)
    if (!dictionaries.has(dictionaryKey)) {
      fail('PRESET_TARGET_INVALID', `${at}.dictionary names a dictionary the preset does not declare`, {
        field: `${at}.dictionary`,
        dictionary: dictionaryKey,
      })
    }
    const labelAliases = uniqueStrings(Array.isArray(entry.labelAliases) ? entry.labelAliases : [])
    if (labelAliases.length === 0 && !common.labelHint) {
      // A dictionary-justified target with no aliases has nothing to be
      // justified BY, and would either match nothing or (worse) invite a
      // fallback. Refuse the preset instead.
      fail('PRESET_TARGET_INVALID', `${at} must carry labelAliases or a labelHint to be justified BY`, {
        field: `${at}.labelAliases`,
        target,
      })
    }
    targets.push(Object.freeze({
      ...common,
      table: null,
      column: null,
      dictionary: dictionaryKey,
      labelAliases: Object.freeze(labelAliases),
    }))
  }

  return Object.freeze({
    presetId,
    presetVersion: raw.presetVersion,
    vendor: optionalString(raw.vendor) || presetId,
    label: optionalString(raw.label) || presetId,
    // Which vocabulary/matcher set this adaptation bound to. Reported in the values-free summary so
    // an operator can see whether the schema module was available or the fallback was used.
    hintVocabularySource: binding.source,
    isFamilyColumn: binding.isFamilyColumn,
    signature: Object.freeze({
      requiredTables: Object.freeze(requiredTables),
      optionalTables: Object.freeze(optionalTables),
      forbiddenTables: Object.freeze(forbiddenTables),
      minimumConfidence,
    }),
    dictionaries,
    valueSets,
    typeMap,
    defaultType,
    defaultOwnership,
    mappingSourceTable,
    targets: Object.freeze(targets),
    // The sandbox objectId a pack should install into is a DEPLOYMENT decision,
    // never a vendor fact. A preset may not carry one; the draft therefore never
    // emits `targetObjectId` and the README lists it as CONFIRM-REQUIRED. This
    // is deliberate: omitting the key means "the frozen canonical main table",
    // and an unconfirmed draft must not be able to say that by accident either.
    packTargetObjectIdIsDeploymentDecision: true,
  })
}

// ---------------------------------------------------------------------------
// >>> THE ADAPTER, SECOND DIALECT <<<
//
// The vendor-preset schema as it actually landed on the sibling branch
// (plugins/plugin-integration-core/lib/source-vendor-presets/preset-schema.cjs,
// marker `metasheet.source-vendor-preset`). Read here and translated into the
// SAME normalized internal shape, so nothing downstream knows there are two
// dialects. Five things it says differently, each a genuine improvement this
// side had to learn to read:
//
//   1. `matches` is a COUNT FLOOR (`minSignatureTablesPresent` of
//      `signatureTables`), not a ratio. present >= floor is identical to
//      confidence >= floor/total, so it maps exactly onto the ratio this module
//      already computes — and the floor's purpose (tolerate a deployment without
//      the order module) survives the translation.
//   2. Dictionary COLUMNS are not declared at all: `mechanism:
//      'rows-name-columns'` says the rows name columns, and WHICH column of the
//      dictionary is the slot / the label / the flag is DISCOVERED. That is
//      exactly what the probe's own dictionary heuristic already proves per
//      table, so the spec is left incomplete here and completed against that
//      heuristic's output by completeDictionarySpec(). A dictionary the
//      heuristic did not resolve becomes a loud gap, never a guess.
//   3. The enabled flag is a list of IDENTIFIER CANDIDATES plus a POLARITY
//      (`zero-means-enabled` on this family — inverted, and a vendor fact).
//   4. Targets are SEMANTICS (`bom-line-quantity`), not `ext_` ids, and they
//      match by a CLOSED-ENUM `labelHint` whose words live in code. The `ext_`
//      id is therefore a MECHANICAL transform of the semantic name — an ASCII
//      string the preset itself declares, never of a customer label.
//   5. Generic slot families are STRUCTURED (`{ onRole, stems, indexMin,
//      indexMax }`) and REQUIRED, and their matchers are generated. This module
//      does not merely tolerate them, it USES them: a dictionary row whose slot
//      is not a member of the family the dictionary declares is refused
//      (ROW_SLOT_OUTSIDE_COLUMN_FAMILY), so a dictionary cannot point the draft
//      at a native product column by naming one.
//
// ONE DELIBERATE DIVERGENCE, stated rather than smuggled: the schema's notes
// describe the hints as saying "how to RANK" candidates. This module does not
// rank. A hint matching two enabled rows produces
// DICTIONARY_AMBIGUOUS_ALIAS_MATCH with both candidates listed, because ranking
// picks a winner and a picked winner is a guess wearing a score. Where a
// `dictionaryTypeHint` is present it is applied as a FILTER (a candidate must
// match it), which narrows rather than orders. The reworked schema now states
// the same doctrine for selection, so the two halves agree.
// ---------------------------------------------------------------------------

// `bom-line-quantity` -> `ext_bomLineQuantity`. Mechanical, over an ASCII identifier the PRESET
// declares — never over a customer label (that would be transliteration, i.e. a guess).
function deriveSemanticExtFieldId(semantic) {
  const parts = cellText(semantic).split(/[^A-Za-z0-9]+/).filter(Boolean)
  if (parts.length === 0) return { ok: false, reason: 'PRESET_TARGET_INVALID' }
  const camel = parts[0].charAt(0).toLowerCase() + parts[0].slice(1) +
    parts.slice(1).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('')
  if (!EXT_FIELD_SUFFIX_PATTERN.test(camel)) return { ok: false, reason: 'PRESET_TARGET_INVALID' }
  return { ok: true, fieldId: `${EXT_FIELD_ID_PREFIX}${camel}` }
}

function adaptSiblingVendorPreset(raw, binding) {
  const presetId = requireString(raw.presetId, 'PRESET_ID_INVALID', 'preset.presetId')
  if (!PACK_ID_PATTERN.test(presetId)) {
    fail('PRESET_ID_INVALID', `preset.presetId must match ${PACK_ID_PATTERN}`, { field: 'preset.presetId', presetId })
  }
  if (!Number.isInteger(raw.presetVersion) || raw.presetVersion < 1) {
    fail('PRESET_VERSION_INVALID', 'preset.presetVersion must be a positive integer', { field: 'preset.presetVersion' })
  }

  // --- matches --------------------------------------------------------------
  const matches = isPlainObject(raw.matches) ? raw.matches : null
  if (!matches) fail('PRESET_MATCHES_INVALID', 'preset.matches must be a plain object', { field: 'preset.matches' })
  const requiredTables = uniqueStrings(Array.isArray(matches.signatureTables) ? matches.signatureTables : [])
  if (requiredTables.length === 0) {
    fail('PRESET_MATCHES_INVALID', 'preset.matches.signatureTables must list at least one table', {
      field: 'preset.matches.signatureTables',
    })
  }
  const floor = Number(matches.minSignatureTablesPresent)
  if (!Number.isInteger(floor) || floor < 1 || floor > requiredTables.length) {
    fail('PRESET_MATCHES_INVALID', 'preset.matches.minSignatureTablesPresent must be an integer within the signature size', {
      field: 'preset.matches.minSignatureTablesPresent',
    })
  }

  // --- genericColumnFamilies: REQUIRED, and actually used -------------------
  // v1 made this mandatory because an undeclared family was the first cut's bypass — the
  // anti-smuggling scan only policed families a preset chose to declare. On the consumption side
  // the family earns its keep differently: it is what lets a dictionary row's slot be checked as a
  // GENERIC SLOT rather than trusted as any column name (see ROW_SLOT_OUTSIDE_COLUMN_FAMILY).
  const families = new Map()
  if (!isPlainObject(raw.genericColumnFamilies) || Object.keys(raw.genericColumnFamilies).length === 0) {
    fail('PRESET_FAMILY_MISSING', 'preset.genericColumnFamilies is required — an undeclared family is an unpoliced one', {
      field: 'preset.genericColumnFamilies',
    })
  }
  for (const [name, family] of Object.entries(raw.genericColumnFamilies)) {
    const at = `preset.genericColumnFamilies.${name}`
    assertNoDeletedPatternKeys(family, 'PRESET_FAMILY_INVALID', at)
    families.set(name, Object.freeze({
      name,
      onRole: optionalString(family && family.onRole),
      ...normalizeColumnFamily(family, 'PRESET_FAMILY_INVALID', at),
    }))
  }

  // --- coreTables: role -> table + role columns -----------------------------
  const roleTables = new Map()
  const roleColumns = new Map()
  const coreTables = isPlainObject(raw.coreTables) ? raw.coreTables : {}
  for (const [role, entry] of Object.entries(coreTables)) {
    if (!isPlainObject(entry)) continue
    const table = optionalString(entry.table)
    if (!table) continue
    roleTables.set(role, table)
    const columns = new Map()
    for (const source of [entry.roles, entry.optionalRoles]) {
      if (!isPlainObject(source)) continue
      for (const [roleName, column] of Object.entries(source)) {
        const text = optionalString(column)
        if (text) columns.set(roleName, text)
      }
    }
    roleColumns.set(role, columns)
  }

  // The row `applyExtFieldMapping` is handed. The schema's own note on the part role says so:
  // "This is also the row the stock-preparation ext-field mapping reads."
  const mappingSourceTable = roleTables.get('part')
  if (!mappingSourceTable) {
    fail('PRESET_MAPPING_SOURCE_TABLE_MISSING', 'preset.coreTables.part.table is required — it is the row the ext-field mapper reads', {
      field: 'preset.coreTables.part.table',
    })
  }

  // --- dictionaries ---------------------------------------------------------
  const dictionaries = new Map()
  for (const [index, entry] of (Array.isArray(raw.dictionaries) ? raw.dictionaries : []).entries()) {
    const at = `preset.dictionaries[${index}]`
    if (!isPlainObject(entry)) fail('PRESET_DICTIONARY_INVALID', `${at} must be a plain object`, { field: at })
    assertNoDeletedPatternKeys(entry, 'PRESET_DICTIONARY_INVALID', at)
    assertNoDeletedPatternKeys(entry.enabledFlag, 'PRESET_DICTIONARY_INVALID', `${at}.enabledFlag`)
    const key = requireString(entry.id, 'PRESET_DICTIONARY_INVALID', `${at}.id`)
    if (dictionaries.has(key)) fail('PRESET_DICTIONARY_INVALID', `${at}.id is declared twice`, { field: `${at}.id`, key })
    const role = requireString(entry.labelsColumnsOfRole, 'PRESET_DICTIONARY_INVALID', `${at}.labelsColumnsOfRole`)
    const describesTable = roleTables.get(role)
    if (!describesTable) {
      fail('PRESET_DICTIONARY_INVALID', `${at}.labelsColumnsOfRole names a role with no coreTables entry`, {
        field: `${at}.labelsColumnsOfRole`,
        role,
      })
    }
    if (cellText(entry.mechanism) !== 'rows-name-columns') {
      // The only mechanism this reader knows how to complete against the probe's
      // dictionary heuristic. A future mechanism must be taught here explicitly
      // rather than fall through to a default reading.
      fail('PRESET_DICTIONARY_INVALID', `${at}.mechanism is not one this emitter can read`, {
        field: `${at}.mechanism`,
        mechanism: cellText(entry.mechanism),
      })
    }
    const flag = isPlainObject(entry.enabledFlag) ? entry.enabledFlag : null
    if (!flag) {
      // No flag means every row would be read as live. On this family two of
      // thirty bom-side slots are enabled — over-collection here is silent and
      // total, so it is refused.
      fail('PRESET_DICTIONARY_INVALID', `${at}.enabledFlag is required — "enabled rows only" cannot be a no-op`, {
        field: `${at}.enabledFlag`,
      })
    }
    const polarity = requireString(flag.polarity, 'PRESET_DICTIONARY_INVALID', `${at}.enabledFlag.polarity`)
    if (polarity !== 'zero-means-enabled' && polarity !== 'nonzero-means-enabled') {
      fail('PRESET_DICTIONARY_INVALID', `${at}.enabledFlag.polarity is not a polarity this emitter can read`, {
        field: `${at}.enabledFlag.polarity`,
        polarity,
      })
    }
    // IDENTIFIER CANDIDATES, not a pattern. v1 replaced the regex with a list precisely so this
    // channel cannot carry anything but column names, and an empty list is refused rather than
    // treated as "match nothing" (which would silently drop the flag and read every row).
    const enabledColumnCandidates = uniqueStrings(Array.isArray(flag.columnCandidates) ? flag.columnCandidates : [])
    if (enabledColumnCandidates.length === 0) {
      fail('PRESET_DICTIONARY_INVALID', `${at}.enabledFlag.columnCandidates must name at least one flag column`, {
        field: `${at}.enabledFlag.columnCandidates`,
      })
    }
    // A dictionary MAY decline to name a family (the head-side one does: its slot naming is not
    // recorded in-repo). Where it names one, slot membership becomes enforceable.
    const familyName = optionalString(entry.columnFamily)
    if (familyName && !families.has(familyName)) {
      fail('PRESET_DICTIONARY_INVALID', `${at}.columnFamily names a family the preset does not declare`, {
        field: `${at}.columnFamily`,
        columnFamily: familyName,
      })
    }
    dictionaries.set(key, Object.freeze({
      key,
      table: requireString(entry.table, 'PRESET_DICTIONARY_INVALID', `${at}.table`),
      describesTable,
      // Discovered, not declared — see completeDictionarySpec().
      slotColumn: null,
      labelColumn: null,
      enabledColumn: null,
      enabledValues: Object.freeze([]),
      typeColumn: null,
      valueSetColumn: null,
      discoverColumns: true,
      enabledColumnCandidates: Object.freeze(enabledColumnCandidates),
      enabledPolarity: polarity,
      valueSetTableFamily: null,
      columnFamily: familyName ? families.get(familyName) : null,
    }))
  }

  // --- semanticExpectations -> targets --------------------------------------
  const targets = []
  const seenTargets = new Set()
  const valueSetFamilyByDictionary = new Map()
  for (const [index, entry] of (Array.isArray(raw.semanticExpectations) ? raw.semanticExpectations : []).entries()) {
    const at = `preset.semanticExpectations[${index}]`
    if (!isPlainObject(entry)) fail('PRESET_TARGET_INVALID', `${at} must be a plain object`, { field: at })
    assertNoDeletedPatternKeys(entry, 'PRESET_TARGET_INVALID', at)
    const semantic = requireString(entry.semantic, 'PRESET_TARGET_INVALID', `${at}.semantic`)
    const derived = deriveSemanticExtFieldId(semantic)
    if (!derived.ok) {
      fail('PRESET_TARGET_INVALID', `${at}.semantic cannot become an ASCII camelCase extension field id`, {
        field: `${at}.semantic`,
        semantic,
      })
    }
    if (seenTargets.has(derived.fieldId)) {
      fail('PRESET_TARGET_DUPLICATE', `${at}.semantic yields an extension field id already claimed`, {
        field: `${at}.semantic`,
        target: derived.fieldId,
      })
    }
    seenTargets.add(derived.fieldId)

    const locus = requireString(entry.locus, 'PRESET_TARGET_INVALID', `${at}.locus`)
    const common = {
      target: derived.fieldId,
      // The semantic name IS the best label the preset can offer; it is ASCII and generic, and the
      // README marks every label CONFIRM-REQUIRED. A dictionary-justified target overrides it with
      // the customer's own label anyway.
      label: semantic,
      type: null,
      ownership: 'plm_system',
      valueSet: null,
      // CLOSED ENUMS. The preset names a hint; the words are in code and are the schema module's
      // own exports whenever that module is available.
      labelHint: resolveHint(entry.labelHint, binding.labelHints, 'PRESET_TARGET_INVALID', `${at}.labelHint`),
      typeHint: resolveHint(entry.dictionaryTypeHint, binding.typeHints, 'PRESET_TARGET_INVALID', `${at}.dictionaryTypeHint`),
    }

    if (locus === 'native-column') {
      const role = requireString(entry.role, 'PRESET_TARGET_INVALID', `${at}.role`)
      const table = roleTables.get(role)
      if (!table) {
        fail('PRESET_TARGET_INVALID', `${at}.role names a role with no coreTables entry`, { field: `${at}.role`, role })
      }
      const column = optionalString(entry.roleColumn) || (roleColumns.get(role) || new Map()).get(cellText(entry.roleName))
      if (!column) {
        fail('PRESET_TARGET_INVALID', `${at} must name the native column via roleColumn`, { field: `${at}.roleColumn` })
      }
      targets.push(Object.freeze({ ...common, via: 'native', table, column, dictionary: null, labelAliases: Object.freeze([]) }))
      continue
    }
    if (locus !== 'dictionary-assigned-column') {
      fail('PRESET_TARGET_INVALID', `${at}.locus is not one this emitter can read`, { field: `${at}.locus`, locus })
    }

    const dictionaryKey = requireString(entry.dictionary, 'PRESET_TARGET_INVALID', `${at}.dictionary`)
    if (!dictionaries.has(dictionaryKey)) {
      fail('PRESET_TARGET_INVALID', `${at}.dictionary names a dictionary the preset does not declare`, {
        field: `${at}.dictionary`,
        dictionary: dictionaryKey,
      })
    }
    if (!common.labelHint) {
      fail('PRESET_TARGET_INVALID', `${at}.labelHint is required — a dictionary-assigned semantic has nothing to be justified BY without it`, {
        field: `${at}.labelHint`,
      })
    }
    // A semantic MAY narrow the family its slot must belong to. Where it does, that beats the
    // dictionary's own family (it is the more specific statement); where it does not, the
    // dictionary's applies.
    const semanticFamilyName = optionalString(entry.columnFamily)
    if (semanticFamilyName && !families.has(semanticFamilyName)) {
      fail('PRESET_TARGET_INVALID', `${at}.columnFamily names a family the preset does not declare`, {
        field: `${at}.columnFamily`,
        columnFamily: semanticFamilyName,
      })
    }
    const valueSetFamily = entry.valueSetTableFamily === undefined || entry.valueSetTableFamily === null
      ? null
      : normalizeColumnFamily(entry.valueSetTableFamily, 'PRESET_TARGET_INVALID', `${at}.valueSetTableFamily`)
    if (valueSetFamily) valueSetFamilyByDictionary.set(dictionaryKey, valueSetFamily)
    targets.push(Object.freeze({
      ...common,
      via: 'dictionary',
      table: null,
      column: null,
      dictionary: dictionaryKey,
      labelAliases: Object.freeze([]),
      columnFamily: semanticFamilyName ? families.get(semanticFamilyName) : null,
    }))
  }

  // A value-set table FAMILY is declared on the SEMANTIC but is a property of the DICTIONARY's rows
  // (it is a dictionary cell that names the vocabulary table), so it is hoisted onto the dictionary
  // spec where the reader needs it.
  for (const [dictionaryKey, family] of valueSetFamilyByDictionary) {
    const spec = dictionaries.get(dictionaryKey)
    dictionaries.set(dictionaryKey, Object.freeze({ ...spec, valueSetTableFamily: family }))
  }

  return Object.freeze({
    presetId,
    presetVersion: raw.presetVersion,
    vendor: optionalString(raw.vendor) || presetId,
    label: optionalString(raw.title) || presetId,
    hintVocabularySource: binding.source,
    isFamilyColumn: binding.isFamilyColumn,
    signature: Object.freeze({
      requiredTables: Object.freeze(requiredTables),
      optionalTables: Object.freeze([]),
      forbiddenTables: Object.freeze([]),
      // present >= floor is exactly confidence >= floor/total.
      minimumConfidence: floor / requiredTables.length,
    }),
    dictionaries,
    valueSets: new Map(),
    typeMap: new Map(),
    defaultType: null,
    defaultOwnership: 'plm_system',
    mappingSourceTable,
    targets: Object.freeze(targets),
    packTargetObjectIdIsDeploymentDecision: true,
  })
}

// ---------------------------------------------------------------------------
// Catalog index — resolves a preset's table reference against what was actually
// discovered. Bare name or `schema.name`; a bare name matching two schemas is
// AMBIGUOUS and refused, never silently first-wins.
// ---------------------------------------------------------------------------

function buildCatalogTableIndex(catalog) {
  const byQualified = new Map()
  const byName = new Map()
  for (const table of (catalog && catalog.tables) || []) {
    const qualified = `${table.schema}.${table.name}`
    byQualified.set(qualified.toLowerCase(), table)
    const lower = String(table.name).toLowerCase()
    if (!byName.has(lower)) byName.set(lower, [])
    byName.get(lower).push(table)
  }

  function resolve(reference) {
    const text = cellText(reference)
    if (!text) return { ok: false, reason: 'TABLE_ABSENT', reference: text }
    const lower = text.toLowerCase()
    if (byQualified.has(lower)) return { ok: true, table: byQualified.get(lower) }
    const hits = byName.get(lower) || []
    if (hits.length === 1) return { ok: true, table: hits[0] }
    if (hits.length > 1) {
      return { ok: false, reason: 'TABLE_AMBIGUOUS', reference: text, candidateCount: hits.length }
    }
    return { ok: false, reason: 'TABLE_ABSENT', reference: text }
  }

  function columnsOf(table) {
    const map = new Map()
    for (const column of table.columns || []) map.set(String(column.name).toLowerCase(), column)
    return map
  }

  return { resolve, columnsOf, tableCount: byQualified.size }
}

// ---------------------------------------------------------------------------
// Vendor signature. NEVER GUESS A VENDOR: a preset applies only when its own
// declared signature clears its own declared bar, and when no other preset
// clears it equally well.
// ---------------------------------------------------------------------------

function scorePresetSignature({ preset, tableIndex }) {
  const presentRequired = []
  const missingRequired = []
  for (const reference of preset.signature.requiredTables) {
    const hit = tableIndex.resolve(reference)
    if (hit.ok) presentRequired.push(reference)
    else missingRequired.push({ table: reference, reason: hit.reason })
  }
  const presentOptional = preset.signature.optionalTables.filter((reference) => tableIndex.resolve(reference).ok)
  const forbiddenPresent = preset.signature.forbiddenTables.filter((reference) => tableIndex.resolve(reference).ok)

  const rawConfidence = presentRequired.length / preset.signature.requiredTables.length
  // A forbidden table is a hard disqualifier, not a penalty: it says "this is a
  // DIFFERENT system that happens to share table names".
  const confidence = forbiddenPresent.length > 0 ? 0 : rawConfidence

  return {
    presetId: preset.presetId,
    presetVersion: preset.presetVersion,
    vendor: preset.vendor,
    requiredTableCount: preset.signature.requiredTables.length,
    matchedRequiredTableCount: presentRequired.length,
    missingRequired,
    presentOptionalCount: presentOptional.length,
    optionalTableCount: preset.signature.optionalTables.length,
    forbiddenPresentCount: forbiddenPresent.length,
    confidence,
    minimumConfidence: preset.signature.minimumConfidence,
    meetsThreshold: confidence >= preset.signature.minimumConfidence,
  }
}

/**
 * Pick THE preset for this catalog, or refuse with a coded reason.
 *
 * @returns {{ ok: true, preset, score, scores }} | {{ ok: false, reason, scores, detail }}
 */
function selectVendorPreset({ presets, tableIndex }) {
  const list = Array.isArray(presets) ? presets : []
  if (list.length === 0) {
    return { ok: false, reason: 'PRESET_SET_EMPTY', scores: [], detail: 'no vendor preset was supplied' }
  }
  const scores = list.map((preset) => scorePresetSignature({ preset, tableIndex }))
  const eligible = scores.filter((score) => score.meetsThreshold)
  if (eligible.length === 0) {
    const best = scores.reduce((a, b) => (b.confidence > a.confidence ? b : a))
    return {
      ok: false,
      reason: 'PRESET_SIGNATURE_NOT_MET',
      scores,
      detail: `best candidate ${best.presetId} reached confidence ${best.confidence.toFixed(2)} against its own minimum ${best.minimumConfidence.toFixed(2)}`,
    }
  }
  if (eligible.length > 1) {
    // MORE THAN ONE PRESET CLEARING ITS OWN FLOOR IS AMBIGUOUS, REGARDLESS OF MATCH COUNTS.
    // The earlier reading here refused only an exact TIE at the top and otherwise let the higher
    // count win — which is a count race silently picking a winner, the behaviour an adversarial
    // review refuted on the schema side. A higher count is not a disambiguator: two overlapping
    // signatures are two vendors that both explain this database, and a legitimate superset case
    // must earn an explicit priority mechanism rather than an implicit race.
    // (Corresponds to the schema module's AMBIGUOUS_PRESET_MATCH; PRESET_SIGNATURE_NOT_MET below
    // corresponds to its NO_PRESET_MATCHED. The tokens stay this module's own closed vocabulary.)
    return {
      ok: false,
      reason: 'PRESET_SIGNATURE_AMBIGUOUS',
      scores,
      detail: `${eligible.length} presets each cleared their own signature floor; a count race is not a disambiguator`,
    }
  }
  const winner = eligible[0]
  return { ok: true, preset: list.find((preset) => preset.presetId === winner.presetId), score: winner, scores }
}

// ---------------------------------------------------------------------------
// Column discovery for `rows-name-columns` dictionaries.
//
// The preset declines to name the dictionary's own columns, and it is right to:
// which column of DN_PM_PartExAttrInfo holds the slot name is not a vendor
// constant a file should assert, it is something the probe PROVES per instance.
// `detected` is one entry of detectDictionaryTables()'s output for this very
// table — its `keyColumn` is the column whose values were shown to be column
// names elsewhere (that IS "rows name columns"), and its companions are the
// display-label / enabled-flag / type columns the same pass identified.
//
// Fail-closed at every step: a dictionary the heuristic did not resolve yields a
// coded reason and its targets become explicit gaps. Nothing is inferred from a
// column name here.
// ---------------------------------------------------------------------------

function completeDictionarySpec({ spec, tableColumns, detected }) {
  if (!spec.discoverColumns) return { ok: true, spec }
  const columns = tableColumns instanceof Map ? tableColumns : new Map()
  const companions = (detected && detected.companions) || {}

  const slotColumn = detected && detected.keyColumn ? detected.keyColumn : null
  if (!slotColumn) return { ok: false, reason: 'DICTIONARY_SLOT_COLUMN_UNDISCOVERED' }
  const labelColumn = companions.displayNameColumn || null
  if (!labelColumn) return { ok: false, reason: 'DICTIONARY_LABEL_COLUMN_UNDISCOVERED' }

  // The preset's own candidate identifiers are the authority on the flag column; the heuristic's
  // companion is the fallback. If neither names one, the read is refused rather than run without a
  // filter — "enabled rows only" must never degrade to "all". Candidates are matched
  // case-insensitively (SQL Server keeps CamelCase; PostgreSQL folds).
  let enabledColumn = null
  for (const candidate of spec.enabledColumnCandidates || []) {
    const hit = columns.get(String(candidate).toLowerCase())
    if (hit) { enabledColumn = hit.name; break }
  }
  if (!enabledColumn) enabledColumn = companions.enabledColumn || null
  if (!enabledColumn) return { ok: false, reason: 'DICTIONARY_ENABLED_COLUMN_UNDISCOVERED' }

  return {
    ok: true,
    spec: Object.freeze({
      ...spec,
      slotColumn,
      labelColumn,
      enabledColumn,
      typeColumn: companions.typeColumn || null,
      discoverColumns: false,
    }),
  }
}

/**
 * Which dictionary column names a VALUE-SET TABLE. Found by CONTENT, not by name: the first column
 * (excluding the slot/label/flag/type columns) carrying at least one value that matches the preset's
 * value-set table-name pattern.
 *
 * Identification is deliberately separate from PERMISSION. Adopting a column only says "this is
 * where the reference lives"; every individual reference read out of it is re-checked against the
 * same pattern before its table is opened (VALUE_SET_TABLE_PATTERN_MISMATCH), so a stray row
 * pointing somewhere else costs that ONE vocabulary a loud gap instead of costing every vocabulary
 * in the dictionary its column — which is what an all-must-match rule would do.
 */
function discoverValueSetRefColumn({ rows, columns, isValueSetTableName, exclude = [] }) {
  if (typeof isValueSetTableName !== 'function') return null
  const excluded = new Set(exclude.filter(Boolean).map((name) => String(name).toLowerCase()))
  for (const column of (columns instanceof Map ? [...columns.values()] : [])) {
    if (excluded.has(String(column.name).toLowerCase())) continue
    for (const row of Array.isArray(rows) ? rows : []) {
      const text = cellText(isPlainObject(row) ? row[column.name] : undefined)
      if (text && isValueSetTableName(text)) return column.name
    }
  }
  return null
}

/**
 * A vocabulary table's own columns, when the preset names only a table-name pattern. Exactly one
 * candidate text column must remain after excluding keys and the enabled flag; two or more is
 * AMBIGUOUS and the human is handed the candidate list. Picking the "most likely" one here would be
 * a guess about the customer's schema wearing a heuristic's clothes.
 */
function discoverValueSetColumns({ columns, enabledColumnCandidates = [] }) {
  const all = columns instanceof Map ? [...columns.values()] : []
  let enabledColumn = null
  for (const candidate of enabledColumnCandidates) {
    const hit = columns instanceof Map ? columns.get(String(candidate).toLowerCase()) : null
    if (hit) { enabledColumn = hit.name; break }
  }
  const candidates = all.filter(
    (column) => isTextLikeColumn(column) && !column.isPrimaryKey && column.name !== enabledColumn,
  )
  if (candidates.length === 1) return { ok: true, valueColumn: candidates[0].name, enabledColumn }
  return { ok: false, reason: 'VALUE_SET_COLUMN_AMBIGUOUS', candidates: candidates.map((c) => c.name) }
}

// ---------------------------------------------------------------------------
// Dictionary reading — PURE over a row array. Enabled rows only, and every
// dropped row is counted by reason so a draft can say WHY it saw 21 of 73.
// ---------------------------------------------------------------------------

/**
 * @param {object}   spec             a normalized preset dictionary spec
 * @param {Array}    rows             the dictionary table's rows, as read
 * @param {Map}      describedColumns lowercase column name -> catalog column, for spec.describesTable
 * @returns {{ entries: Array, skipped: Array, skippedByReason: object }}
 */
function readDictionaryEntries({ spec, rows, describedColumns, isFamilyColumn = fallbackIsFamilyColumn }) {
  const entries = []
  const skipped = []
  const seenSlots = new Map()
  const columns = describedColumns instanceof Map ? describedColumns : new Map()

  for (const [rowIndex, row] of (Array.isArray(rows) ? rows : []).entries()) {
    const source = isPlainObject(row) ? row : {}

    if (spec.enabledColumn) {
      const rawFlag = source[spec.enabledColumn]
      if (!isEnabledCell(rawFlag, spec)) {
        // NOT a leak: only the row index and the reason are kept. The flag value
        // itself never travels.
        skipped.push({ rowIndex, reason: 'ROW_DISABLED' })
        continue
      }
    }

    const slot = cellText(source[spec.slotColumn])
    if (!slot) {
      skipped.push({ rowIndex, reason: 'ROW_SLOT_EMPTY' })
      continue
    }
    const column = columns.get(slot.toLowerCase())
    if (!column) {
      // The slot names a column that does not exist on the table this dictionary
      // describes. Two things at once: the row cannot justify a mapping (a
      // sourceColumn that does not exist is the silent-empty-`ext_` failure), and
      // the value is NOT a verified schema identifier, so it must not travel.
      skipped.push({ rowIndex, reason: 'ROW_SLOT_NOT_A_COLUMN' })
      continue
    }
    if (!SOURCE_COLUMN_PATTERN.test(column.name)) {
      // Downstream (stock-preparation-ext-field-mapping.cjs) refuses a source
      // column carrying separators/quotes/whitespace. Refuse first, loudly.
      skipped.push({ rowIndex, reason: 'ROW_SLOT_NOT_A_COLUMN' })
      continue
    }
    // GENERIC-SLOT MEMBERSHIP. Where the preset declares which structured family this dictionary
    // labels, a row must name a MEMBER of it. Without this a dictionary row could point the draft at
    // a native product column (`IdentityNo`) — a real column, so the existence check above passes —
    // and the draft would propose overwriting product schema from a dictionary assignment. The
    // family is declared as { stems, indexMin, indexMax } and its matcher is generated, never
    // authored, so it cannot itself be narrowed to name one customer's slot.
    if (spec.columnFamily && typeof isFamilyColumn === 'function' && !isFamilyColumn(spec.columnFamily, column.name)) {
      skipped.push({ rowIndex, reason: 'ROW_SLOT_OUTSIDE_COLUMN_FAMILY', slot: column.name })
      continue
    }

    const label = cellText(source[spec.labelColumn])
    if (!label) {
      // An enabled slot with no label is a REAL shape (seen live) and it is a
      // gap, not a non-event: the slot is live but nothing says what it means.
      skipped.push({ rowIndex, reason: 'ROW_LABEL_EMPTY', slot: column.name })
      continue
    }

    const slotKey = column.name.toLowerCase()
    // Collected, not decided. Two enabled rows claiming one slot is settled AFTER the pass — see
    // below for why first-wins was not safe.
    seenSlots.set(slotKey, (seenSlots.get(slotKey) || 0) + 1)

    entries.push({
      dictionaryKey: spec.key,
      dictionaryTable: spec.table,
      describesTable: spec.describesTable,
      rowIndex,
      // The CATALOG's spelling, not the dictionary cell's: the catalog is the
      // authority on how a column is actually named.
      slot: column.name,
      slotDataType: column.dataType,
      label,
      labelKey: labelKey(label),
      typeToken: spec.typeColumn ? cellText(source[spec.typeColumn]) : '',
      valueSetRef: spec.valueSetColumn ? cellText(source[spec.valueSetColumn]) : '',
      enabledColumn: spec.enabledColumn,
      enabledText: spec.enabledColumn ? cellText(source[spec.enabledColumn]) : '',
    })
  }

  // DUPLICATE SLOTS ARE REFUSED ON BOTH SIDES, never first-wins.
  //
  // Two enabled dictionary rows naming the same slot are two contradictory statements about what
  // that column means, and nothing here can tell which the customer intended. Keeping the first was
  // worse than arbitrary: the sample query had no ORDER BY, so "first" was whatever order the driver
  // happened to return — the basis string would have cited a row chosen by the storage engine, and
  // two runs against the same database could justify the mapping differently. That is the same
  // failure as picking between two alias matches, so it gets the same answer: refuse the slot, name
  // it, let a human decide. (The sampler now also orders deterministically — see sampleRows.)
  const kept = []
  for (const entry of entries) {
    if ((seenSlots.get(entry.slot.toLowerCase()) || 0) > 1) {
      skipped.push({ rowIndex: entry.rowIndex, reason: 'ROW_SLOT_DUPLICATE', slot: entry.slot })
      continue
    }
    kept.push(entry)
  }

  const skippedByReason = {}
  for (const item of skipped) skippedByReason[item.reason] = (skippedByReason[item.reason] || 0) + 1

  return { entries: kept, skipped, skippedByReason }
}

// ---------------------------------------------------------------------------
// Option-set extraction — PURE over a row array. Duplicates are COLLAPSED and
// COUNTED (a vocabulary table with duplicate entries is a real shape, and the
// pack normalizer rejects duplicate option values outright, so a draft that
// passed them through would be a draft that cannot install).
// ---------------------------------------------------------------------------

function extractOptionSet({ spec, rows }) {
  const options = []
  const seen = new Set()
  let duplicateCount = 0
  let emptyCount = 0
  let disabledCount = 0

  for (const row of Array.isArray(rows) ? rows : []) {
    const source = isPlainObject(row) ? row : {}
    if (spec.enabledColumn && !isEnabledCell(source[spec.enabledColumn], spec)) {
      disabledCount += 1
      continue
    }
    const value = cellText(source[spec.valueColumn])
    if (!value) {
      emptyCount += 1
      continue
    }
    if (seen.has(value)) {
      duplicateCount += 1
      continue
    }
    seen.add(value)
    const option = { value }
    const label = spec.labelColumn ? cellText(source[spec.labelColumn]) : ''
    if (label && label !== value) option.label = label
    options.push(option)
  }

  if (options.length === 0) {
    return { ok: false, reason: 'VALUE_SET_EMPTY', valueSetKey: spec.key, table: spec.table, duplicateCount, emptyCount, disabledCount }
  }
  if (options.length > MAX_OPTIONS_PER_FIELD) {
    // The pack normalizer caps a set at 200. Emitting 300 would produce a draft
    // that fails to install with an error a long way from here.
    return {
      ok: false,
      reason: 'VALUE_SET_OVER_CAP',
      valueSetKey: spec.key,
      table: spec.table,
      optionCount: options.length,
      maxOptions: MAX_OPTIONS_PER_FIELD,
      duplicateCount,
      emptyCount,
      disabledCount,
    }
  }
  return { ok: true, valueSetKey: spec.key, table: spec.table, options, duplicateCount, emptyCount, disabledCount }
}

// ---------------------------------------------------------------------------
// Placeholder ext-field ids for unclaimed enabled slots.
//
// MECHANICAL, FROM THE COLUMN NAME, NEVER FROM THE LABEL. `part_ExAttr10` ->
// `ext_partExAttr10`. The label (型号) carries the meaning and travels verbatim;
// turning it into an ASCII identifier would be a transliteration guess, and a
// guess dressed as an id is the hardest kind to notice later.
// ---------------------------------------------------------------------------

function derivePlaceholderExtFieldId(sourceColumn) {
  const text = cellText(sourceColumn)
  if (!text) return { ok: false, reason: 'PLACEHOLDER_ID_UNDERIVABLE' }
  const parts = text.split(/[^A-Za-z0-9]+/).filter(Boolean)
  if (parts.length === 0) return { ok: false, reason: 'PLACEHOLDER_ID_UNDERIVABLE' }
  const head = parts[0]
  const camel = head.charAt(0).toLowerCase() + head.slice(1) +
    parts.slice(1).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('')
  if (!EXT_FIELD_SUFFIX_PATTERN.test(camel)) {
    // e.g. a slot named `2ndSource` (leading digit) or a CJK-only slot name.
    return { ok: false, reason: 'PLACEHOLDER_ID_UNDERIVABLE' }
  }
  return { ok: true, fieldId: `${EXT_FIELD_ID_PREFIX}${camel}` }
}

// ---------------------------------------------------------------------------
// Target resolution — the heart of the fail-closed rule.
// ---------------------------------------------------------------------------

function nativeBasis({ preset, qualifiedTable, column }) {
  return `catalog: column ${qualifiedTable}.${column.name} (${column.dataType}) exists — declared by preset "${preset.presetId}" v${preset.presetVersion} as a vendor-native column`
}

function dictionaryBasis({ entry, matchedAlias }) {
  const enabled = entry.enabledColumn ? `, ${entry.enabledColumn}="${entry.enabledText}" (ENABLED)` : ''
  const type = entry.typeToken ? `, type="${entry.typeToken}"` : ''
  const alias = matchedAlias === null
    ? ' — enabled dictionary row claimed by no preset target'
    : ` — label equals preset alias "${matchedAlias}"`
  return `${entry.dictionaryTable} row #${entry.rowIndex}: slot="${entry.slot}" label="${entry.label}"${enabled}${type}${alias}`
}

// A dictionary's own TYPE vocabulary, read as a type vocabulary. This is not a semantic guess: the
// customer's dictionary row literally says `float` / `list`, and mapping that word onto a field type
// is reading it, not inferring what the column MEANS (which stays entirely in the label). Used only
// after a preset's own typeMap, and the resulting `typeSource` says `builtin-type-token` so the draft
// shows exactly which reading produced it. A token outside this vocabulary is still a gap.
const BUILTIN_DICTIONARY_TYPE_TOKENS = Object.freeze({
  text: 'string', string: 'string', varchar: 'string', nvarchar: 'string', char: 'string', memo: 'string',
  int: 'number', integer: 'number', float: 'number', double: 'number', real: 'number',
  decimal: 'number', numeric: 'number', number: 'number',
  bool: 'boolean', boolean: 'boolean', bit: 'boolean',
  date: 'date', datetime: 'date', time: 'date',
  list: 'select', select: 'select', enum: 'select', combo: 'select',
})

function resolveTypeForEntry({ preset, entry, declaredType }) {
  if (declaredType) return { ok: true, type: declaredType, source: 'preset-target' }
  if (entry.typeToken) {
    const mapped = preset.typeMap.get(labelKey(entry.typeToken))
    if (mapped) return { ok: true, type: mapped, source: 'preset-typeMap' }
    const builtin = BUILTIN_DICTIONARY_TYPE_TOKENS[labelKey(entry.typeToken)]
    if (builtin) return { ok: true, type: builtin, source: 'builtin-type-token' }
  }
  // NO TYPE TOKEN ON THE ROW -> THE COLUMN'S OWN CATALOG TYPE. A dictionary that labels a slot
  // without typing it is the common live shape (on the first real PLM the type column is populated
  // on 35 of 73 rows), and the slot's SQL type is a fact the discovery read established — the same
  // derivation a NATIVE target already uses, for the same reason. Recorded as `catalog-datatype` so
  // the draft shows which reading produced it.
  const catalogType = fieldTypeForCatalogColumn({ dataType: entry.slotDataType })
  if (catalogType) return { ok: true, type: catalogType, source: 'catalog-datatype' }
  if (preset.defaultType) return { ok: true, type: preset.defaultType, source: 'preset-defaultType' }
  // Fail-closed: no type is better than a guessed one, because the pack's `type`
  // is what derives the mapper's coercion — a wrongly-typed column refuses every
  // cell at runtime and looks exactly like "the source had no value".
  return { ok: false, reason: 'DICTIONARY_TYPE_UNMAPPED' }
}

/**
 * A `select` column's vocabulary is named two different ways: the preset target may declare a
 * valueSet KEY, or the customer's dictionary row may point at a TABLE. Both are normalized to the
 * preset's own valueSet key here so exactly one lookup key travels downstream. An unresolvable
 * reference is returned VERBATIM rather than dropped — the option-set gap must be able to say what
 * the row actually pointed at.
 */
// Family membership through whichever matcher the preset bound to (the schema module's when it was
// available, the local mirror otherwise).
function isFamilyMember(preset, family, columnName) {
  const test = typeof preset.isFamilyColumn === 'function' ? preset.isFamilyColumn : fallbackIsFamilyColumn
  return test(family, columnName)
}

function resolveValueSetKey(preset, declared, rowRef) {
  const declaredKey = cellText(declared)
  if (declaredKey && preset.valueSets.has(declaredKey)) return declaredKey
  const rowKey = cellText(rowRef)
  if (rowKey) {
    if (preset.valueSets.has(rowKey)) return rowKey
    const lower = rowKey.toLowerCase()
    for (const [key, spec] of preset.valueSets) {
      if (cellText(spec.table).toLowerCase() === lower) return key
    }
  }
  return declaredKey || rowKey || ''
}

/**
 * @param {object} preset              normalized (adaptVendorPresetShape output)
 * @param {object} tableIndex          buildCatalogTableIndex output
 * @param {Map}    entriesByDictionary dictionaryKey -> { ok, entries, skippedByReason } | { ok:false, reason }
 * @returns {{ resolved, unresolved, deferred, unclaimed }}
 */
function resolveTargets({ preset, tableIndex, entriesByDictionary }) {
  const resolved = []
  const unresolved = []
  const claimedEntryKeys = new Set()
  // dictionaryKey#rowIndex -> the target(s) whose ambiguity refusal that row was a candidate for.
  const blockedByAmbiguity = new Map()
  const usedFieldIds = new Set(preset.targets.map((target) => target.target))

  for (const target of preset.targets) {
    if (target.via === 'native') {
      const tableHit = tableIndex.resolve(target.table)
      if (!tableHit.ok) {
        unresolved.push({
          target: target.target,
          via: 'native',
          reason: tableHit.reason === 'TABLE_AMBIGUOUS' ? 'TABLE_AMBIGUOUS' : 'NATIVE_TABLE_ABSENT',
          lookedFor: `${target.table}.${target.column}`,
        })
        continue
      }
      const columns = tableIndex.columnsOf(tableHit.table)
      const column = columns.get(target.column.toLowerCase())
      if (!column) {
        // The fail-closed rule in one branch: there is no fallback to "a column
        // whose name looks close enough".
        unresolved.push({
          target: target.target,
          via: 'native',
          reason: 'NATIVE_COLUMN_ABSENT',
          lookedFor: `${target.table}.${target.column}`,
        })
        continue
      }
      const qualified = `${tableHit.table.schema}.${tableHit.table.name}`
      // TYPE, in order of authority: what the preset declared, else what the CATALOG says the column
      // actually is (a discovered fact, not a guess), else the preset's default. None of the three
      // available is a gap — a wrongly-typed column refuses every cell at runtime and looks exactly
      // like "the source had no value", which is the failure this whole module exists to prevent.
      const catalogType = fieldTypeForCatalogColumn(column)
      const nativeType = target.type || catalogType || preset.defaultType || null
      if (!nativeType) {
        unresolved.push({
          target: target.target,
          via: 'native',
          reason: 'NATIVE_TYPE_UNMAPPED',
          lookedFor: `a field type for ${target.table}.${target.column} (catalog type "${column.dataType}")`,
        })
        continue
      }
      resolved.push({
        target: target.target,
        via: 'native',
        idKind: 'preset-declared',
        sourceTable: qualified,
        sourceTableName: tableHit.table.name,
        sourceColumn: column.name,
        type: nativeType,
        typeSource: target.type ? 'preset-target' : (catalogType ? 'catalog-datatype' : 'preset-defaultType'),
        ownership: target.ownership,
        label: target.label || target.target,
        labelIsPresetDeclared: Boolean(target.label),
        valueSetRef: resolveValueSetKey(preset, target.valueSet, ''),
        basis: nativeBasis({ preset, qualifiedTable: qualified, column }),
      })
      continue
    }

    // --- dictionary-justified ------------------------------------------------
    const spec = preset.dictionaries.get(target.dictionary)
    const read = entriesByDictionary instanceof Map ? entriesByDictionary.get(target.dictionary) : null
    if (!read || read.ok !== true) {
      unresolved.push({
        target: target.target,
        via: 'dictionary',
        reason: read && read.reason ? read.reason : 'DICTIONARY_NOT_READ',
        lookedFor: `${spec ? spec.table : target.dictionary} label in [${target.labelAliases.join(', ')}]`,
      })
      continue
    }
    const aliasKeys = new Map(target.labelAliases.map((alias) => [labelKey(alias), alias]))
    // Exact alias OR a preset-declared label pattern. Both forms are a CANDIDATE test, never a score:
    // whatever matches, the exactly-one rule below is what decides, so a pattern that fits two
    // enabled rows produces an ambiguity gap rather than a ranked pick.
    const matchOf = (entry) => {
      if (aliasKeys.has(entry.labelKey)) return aliasKeys.get(entry.labelKey)
      if (target.labelHint && target.labelHint.test.test(entry.label)) return `labelHint:${target.labelHint.key}`
      return null
    }
    // A type hint NARROWS the candidate set; it never orders it.
    const typeAllows = (entry) => !target.typeHint || target.typeHint.test.test(entry.typeToken)
    // FAMILY MEMBERSHIP, where the semantic narrowed it. Same argument as the dictionary-level check
    // in readDictionaryEntries, one level more specific.
    const familyAllows = (entry) => !target.columnFamily || isFamilyMember(preset, target.columnFamily, entry.slot)
    const hits = read.entries.filter((entry) => matchOf(entry) !== null && typeAllows(entry) && familyAllows(entry))
    const lookedForText = target.labelAliases.length > 0
      ? `[${target.labelAliases.join(', ')}]`
      : `labelHint "${target.labelHint ? target.labelHint.key : ''}"`
    if (hits.length === 0) {
      unresolved.push({
        target: target.target,
        via: 'dictionary',
        reason: 'DICTIONARY_NO_ALIAS_MATCH',
        lookedFor: `${spec.table}.${spec.labelColumn || '(label column)'} in ${lookedForText}` +
          `${target.typeHint ? ` with dictionaryTypeHint "${target.typeHint.key}"` : ''}` +
          ` (${read.entries.length} enabled rows read)`,
      })
      continue
    }
    if (hits.length > 1) {
      // Two enabled slots claim the same meaning. Picking one silently is how a
      // draft becomes confidently wrong; the human is told exactly which slots.
      // Each contested slot is REMEMBERED so the placeholder it would otherwise
      // become is blocked — see the placeholder pass below.
      for (const entry of hits) {
        const slotKey = `${entry.dictionaryKey}#${entry.rowIndex}`
        if (!blockedByAmbiguity.has(slotKey)) blockedByAmbiguity.set(slotKey, [])
        blockedByAmbiguity.get(slotKey).push(target.target)
      }
      unresolved.push({
        target: target.target,
        via: 'dictionary',
        reason: 'DICTIONARY_AMBIGUOUS_ALIAS_MATCH',
        lookedFor: `${spec.table}.${spec.labelColumn || '(label column)'} in ${lookedForText}`,
        candidates: hits.map((entry) => ({ slot: entry.slot, label: entry.label, rowIndex: entry.rowIndex })),
      })
      continue
    }
    const entry = hits[0]
    const typeResult = resolveTypeForEntry({ preset, entry, declaredType: target.type })
    if (!typeResult.ok) {
      unresolved.push({
        target: target.target,
        via: 'dictionary',
        reason: typeResult.reason,
        lookedFor: `a preset typeMap entry for dictionary type token "${entry.typeToken}" (slot "${entry.slot}", label "${entry.label}")`,
      })
      continue
    }
    claimedEntryKeys.add(`${entry.dictionaryKey}#${entry.rowIndex}`)
    const tableHit = tableIndex.resolve(entry.describesTable)
    const qualified = tableHit.ok ? `${tableHit.table.schema}.${tableHit.table.name}` : entry.describesTable
    resolved.push({
      target: target.target,
      via: 'dictionary',
      idKind: 'preset-declared',
      sourceTable: qualified,
      sourceTableName: tableHit.ok ? tableHit.table.name : entry.describesTable,
      sourceColumn: entry.slot,
      type: typeResult.type,
      typeSource: typeResult.source,
      ownership: target.ownership,
      // The customer's own label wins over the preset's: the preset alias is how
      // we FOUND the slot, the customer's dictionary is what the column is CALLED
      // in this deployment.
      label: entry.label,
      labelIsPresetDeclared: false,
      valueSetRef: resolveValueSetKey(preset, target.valueSet, entry.valueSetRef),
      dictionaryKey: entry.dictionaryKey,
      basis: dictionaryBasis({ entry, matchedAlias: matchOf(entry) }),
    })
  }

  // --- unclaimed enabled dictionary rows -> placeholder proposals ------------
  const unclaimed = []
  if (entriesByDictionary instanceof Map) {
    for (const [dictionaryKey, read] of entriesByDictionary) {
      if (!read || read.ok !== true) continue
      const spec = preset.dictionaries.get(dictionaryKey)
      for (const entry of read.entries) {
        if (claimedEntryKeys.has(`${dictionaryKey}#${entry.rowIndex}`)) continue
        const derived = derivePlaceholderExtFieldId(entry.slot)
        if (!derived.ok) {
          unresolved.push({
            target: null,
            via: 'placeholder',
            reason: derived.reason,
            // The LABEL travels with the gap. A human told only "slot 2ndSource could not become an
            // id" has to go back to the dictionary to find out whether it mattered; told that the
            // slot means <label>, they can decide on the spot.
            lookedFor: `an ASCII camelCase id derived from slot column "${entry.slot}" (label "${entry.label}", ${spec ? spec.table : dictionaryKey} row #${entry.rowIndex})`,
          })
          continue
        }
        if (usedFieldIds.has(derived.fieldId)) {
          unresolved.push({
            target: derived.fieldId,
            via: 'placeholder',
            reason: 'PLACEHOLDER_ID_COLLISION',
            lookedFor: `a free extension field id for slot column "${entry.slot}"`,
          })
          continue
        }
        const typeResult = resolveTypeForEntry({ preset, entry, declaredType: null })
        if (!typeResult.ok) {
          unresolved.push({
            target: derived.fieldId,
            via: 'placeholder',
            reason: typeResult.reason,
            lookedFor: `a preset typeMap entry for dictionary type token "${entry.typeToken}" (slot "${entry.slot}", label "${entry.label}")`,
          })
          continue
        }
        usedFieldIds.add(derived.fieldId)
        const tableHit = tableIndex.resolve(entry.describesTable)
        const qualified = tableHit.ok ? `${tableHit.table.schema}.${tableHit.table.name}` : entry.describesTable
        // CONFIRM-BLOCKER. A slot that was one of two candidates for an AMBIGUOUS target is
        // unclaimed for exactly one reason: the emitter refused to choose. Proposing it as an
        // ordinary placeholder made both halves of an unresolved ambiguity installable by anyone who
        // confirmed everything — the refusal would be recorded in one section while the thing it
        // refused to decide shipped from another. The proposal survives (the column may well be
        // wanted) but is BLOCKED: it is kept out of the mapping entries and both draft files carry
        // the cross-reference to the target whose ambiguity it belongs to.
        const blockers = blockedByAmbiguity.get(`${dictionaryKey}#${entry.rowIndex}`) || null
        const proposal = {
          confirmBlockedBy: blockers ? Object.freeze([...new Set(blockers)]) : null,
          confirmBlockedReason: blockers ? 'DICTIONARY_AMBIGUOUS_ALIAS_MATCH' : null,
          target: derived.fieldId,
          via: 'dictionary',
          idKind: 'placeholder-from-slot',
          sourceTable: qualified,
          sourceTableName: tableHit.ok ? tableHit.table.name : entry.describesTable,
          sourceColumn: entry.slot,
          type: typeResult.type,
          typeSource: typeResult.source,
          ownership: preset.defaultOwnership,
          label: entry.label,
          labelIsPresetDeclared: false,
          valueSetRef: resolveValueSetKey(preset, '', entry.valueSetRef),
          dictionaryKey,
          basis: dictionaryBasis({ entry, matchedAlias: null }),
        }
        resolved.push(proposal)
        unclaimed.push(proposal)
      }
    }
  }

  // --- deferral: only the mapped row can become a mapping entry --------------
  const mappingTableHit = tableIndex.resolve(preset.mappingSourceTable)
  const mappingTableName = mappingTableHit.ok ? mappingTableHit.table.name.toLowerCase() : cellText(preset.mappingSourceTable).toLowerCase()
  const deferred = []
  const mappable = []
  const blocked = []
  for (const item of resolved) {
    if (item.confirmBlockedBy) {
      // Structurally unable to be installed by "confirm everything": it is not a mapping entry.
      blocked.push(item)
      continue
    }
    if (String(item.sourceTableName).toLowerCase() === mappingTableName) {
      mappable.push(item)
      continue
    }
    // NOT dropped. `applyExtFieldMapping` is handed exactly one row (the part
    // row); a mapping entry naming a column of a different table would read
    // `undefined` on every row and leave its `ext_` column empty forever, which
    // is indistinguishable from success.
    deferred.push({ ...item, reason: 'SOURCE_TABLE_NOT_THE_MAPPED_ROW', mappingSourceTable: preset.mappingSourceTable })
  }

  return { resolved, mappable, deferred, blocked, unresolved, unclaimed }
}

// ---------------------------------------------------------------------------
// Draft artifacts.
// ---------------------------------------------------------------------------

/**
 * `ext-field-mapping.draft.json`.
 *
 * The `stockPreparationExtFieldMapping` member is EXACTLY the shape
 * stock-preparation-ext-field-mapping-config.cjs accepts (packId + the mapper's
 * own closed key set) — a confirmed draft is a copy/paste, not a translation.
 * Everything a human must confirm lives on `$`-prefixed siblings, which no
 * consumer accepts and no human can mistake for config.
 */
function buildExtFieldMappingDraft({ preset, resolution, generatedAt }) {
  const mappings = resolution.mappable.map((item) => ({ sourceColumn: item.sourceColumn, target: item.target }))
  const basis = {}
  for (const item of resolution.mappable) {
    basis[item.target] = {
      proposed: `${item.sourceTable}.${item.sourceColumn} -> ${item.target} (${item.type})`,
      basis: item.basis,
      idKind: item.idKind,
      confirmRequired: item.idKind === 'placeholder-from-slot'
        ? 'RENAME: the id is a mechanical transform of the slot column name; the meaning is in `label`.'
        : 'CONFIRM: the preset-declared target id and the source column it was matched to.',
    }
  }
  return {
    $draftStatus: mappings.length === 0 ? 'EMPTY — NOTHING WAS RESOLVED' : 'CONFIRM-REQUIRED',
    $generatedAt: generatedAt,
    $generatedBy: 'scripts/ops/source-discovery-probe.mjs --emit-draft',
    $preset: { presetId: preset.presetId, presetVersion: preset.presetVersion, vendor: preset.vendor },
    $howToUse: [
      'Read DRAFT-README.md first. Every entry below is a PROPOSAL.',
      'Confirm each entry, then copy the `stockPreparationExtFieldMapping` member into the server-config file',
      'named by INTEGRATION_CORE_STOCK_PREPARATION_* on the deploy host. Drop every `$`-prefixed key.',
      'The mapper refuses unknown keys, so a `$` key left in place fails loudly at plugin activation.',
    ],
    $basis: basis,
    $deferred: resolution.deferred.map((item) => ({
      target: item.target,
      sourceTable: item.sourceTable,
      sourceColumn: item.sourceColumn,
      reason: item.reason,
      detail: `applyExtFieldMapping reads ONE row (${item.mappingSourceTable}); this column lives on a different table, so it cannot be a mapping entry today.`,
      basis: item.basis,
    })),
    $unresolved: resolution.unresolved.map((item) => ({
      target: item.target,
      via: item.via,
      reason: item.reason,
      lookedFor: item.lookedFor,
      ...(item.candidates ? { candidates: item.candidates } : {}),
    })),
    // BLOCKED, not merely absent. These slots were candidates in an ambiguity this emitter refused
    // to settle; they are deliberately NOT mapping entries, so confirming this file wholesale cannot
    // install both halves of that unresolved ambiguity.
    $confirmBlocked: (resolution.blocked || []).map((item) => ({
      target: item.target,
      sourceTable: item.sourceTable,
      sourceColumn: item.sourceColumn,
      blockedBy: item.confirmBlockedBy,
      reason: item.confirmBlockedReason,
      detail: 'resolve the named target\'s ambiguity first; until then this slot has no agreed meaning',
      basis: item.basis,
    })),
    stockPreparationExtFieldMapping: {
      packId: preset.presetId,
      mappingId: preset.presetId,
      mappingVersion: 1,
      label: `${preset.label} draft mapping (CONFIRM-REQUIRED)`,
      mappings,
    },
  }
}

/**
 * `customer-pack.draft.json`.
 *
 * The `stockPreparationCustomerPacks` member is EXACTLY the map shape
 * stock-preparation-customer-pack-catalog.cjs consumes (`{ [packId]: pack }`),
 * with the pack itself carrying only the keys normalizeCustomerPack allows.
 */
function buildCustomerPackDraft({ preset, resolution, optionSets, generatedAt }) {
  // A confirm-blocked slot is NOT a pack field either. It has no agreed meaning yet — the emitter
  // said so — and installing a column for it is the same decision the mapping refuses to make.
  const installable = resolution.resolved.filter((item) => !item.confirmBlockedBy)
  const extensionFields = installable.map((item) => ({
    id: item.target,
    label: item.label,
    type: item.type,
    ownership: item.ownership,
  }))

  const emittedOptionSets = []
  const optionSetGaps = []
  for (const item of installable) {
    if (item.type !== 'select') continue
    const result = optionSets instanceof Map ? optionSets.get(item.valueSetRef) : null
    if (!result || result.ok !== true) {
      optionSetGaps.push({
        fieldId: item.target,
        valueSetRef: item.valueSetRef || null,
        reason: result && result.reason ? result.reason : 'VALUE_SET_NOT_DECLARED_IN_PRESET',
        detail: 'the select column is proposed WITHOUT an option set; a select field with no installed dictionary accepts any non-empty label at coercion time',
      })
      continue
    }
    emittedOptionSets.push({ fieldId: item.target, options: result.options })
  }

  const pack = {
    packId: preset.presetId,
    packVersion: 1,
    label: `${preset.label} draft pack (CONFIRM-REQUIRED)`,
    extensionFields,
    optionSets: emittedOptionSets,
  }

  return {
    $draftStatus: extensionFields.length === 0 ? 'EMPTY — NOTHING WAS RESOLVED' : 'CONFIRM-REQUIRED',
    $generatedAt: generatedAt,
    $generatedBy: 'scripts/ops/source-discovery-probe.mjs --emit-draft',
    $preset: { presetId: preset.presetId, presetVersion: preset.presetVersion, vendor: preset.vendor },
    $confirmRequired: [
      'packId / packVersion / label — a deployment names its own pack; the preset id is only a seed.',
      'targetObjectId — DELIBERATELY ABSENT. Absent means the FROZEN CANONICAL main table. A sandbox',
      'install needs an explicit `plm_stock_preparation_sandbox*` objectId, and choosing one is a',
      'deployment decision no vendor preset may make. Add it before installing anywhere but canonical.',
      'ownership — every field is proposed `plm_system` unless the preset said otherwise. A column a',
      'human edits must be `human_preserved`, or the next refresh overwrites their work.',
      'roleViews — omitted; role banding is a deployment decision.',
      'Every field whose `$fieldBasis[].idKind` is `placeholder-from-slot` carries a MECHANICAL id',
      'derived from the source column name. Rename it to a business name before installing.',
    ],
    $confirmBlocked: (resolution.blocked || []).map((item) => ({
      id: item.target,
      sourceTable: item.sourceTable,
      sourceColumn: item.sourceColumn,
      label: item.label,
      blockedBy: item.confirmBlockedBy,
      reason: item.confirmBlockedReason,
      detail: 'not proposed as a pack field: this slot was a candidate in an ambiguity the emitter refused to settle',
    })),
    $fieldBasis: installable.map((item) => ({
      id: item.target,
      idKind: item.idKind,
      label: item.label,
      labelSource: item.labelIsPresetDeclared ? 'preset-declared' : 'customer-dictionary',
      type: item.type,
      typeSource: item.typeSource,
      sourceTable: item.sourceTable,
      sourceColumn: item.sourceColumn,
      basis: item.basis,
    })),
    $optionSetGaps: optionSetGaps,
    $unresolved: resolution.unresolved.map((item) => ({
      target: item.target,
      via: item.via,
      reason: item.reason,
      lookedFor: item.lookedFor,
    })),
    stockPreparationCustomerPacks: { [pack.packId]: pack },
  }
}

function mdCell(value) {
  return String(value === null || value === undefined ? '' : value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function renderDraftReadme({ preset, score, resolution, optionSets, dictionaryReads, generatedAt }) {
  const lines = []
  lines.push(`# Source-discovery DRAFT — CONFIRM BEFORE USE`)
  lines.push('')
  lines.push(`- generated: ${generatedAt}`)
  lines.push(`- generated by: \`scripts/ops/source-discovery-probe.mjs --emit-draft\``)
  lines.push(`- preset: \`${preset.presetId}\` v${preset.presetVersion} (vendor \`${preset.vendor}\`)`)
  lines.push(
    `- vendor signature: confidence ${score.confidence.toFixed(2)} (minimum ${score.minimumConfidence.toFixed(2)}), ` +
    `${score.matchedRequiredTableCount}/${score.requiredTableCount} required tables present`,
  )
  lines.push('')
  lines.push('> **These files contain YOUR data.** Dictionary labels and option vocabularies are copied verbatim')
  lines.push('> from your own dictionary tables — that is the point of a draft. They are deploy-host output and')
  lines.push('> must not be committed to a repository. The probe report written alongside them is values-free.')
  lines.push('')
  lines.push('> **Nothing here is a decision.** Every row below is a PROPOSAL with the evidence that produced it.')
  lines.push('> Anything the dictionaries did not positively justify is listed under "Unresolved" — it was NOT')
  lines.push('> guessed from a similar-looking column name, and it is NOT silently absent.')
  lines.push('')

  // --- dictionaries ---------------------------------------------------------
  lines.push(`## 1. Dictionary tables read (${dictionaryReads.length})`)
  lines.push('')
  lines.push('| dictionary | table | describes | rows read | enabled entries | skipped (by reason) |')
  lines.push('|---|---|---|---|---|---|')
  for (const read of dictionaryReads) {
    const skipped = read.ok
      ? Object.entries(read.skippedByReason).map(([reason, count]) => `${reason}=${count}`).join(', ') || '—'
      : `NOT READ: ${read.reason}`
    lines.push(
      `| ${mdCell(read.key)} | ${mdCell(read.table)} | ${mdCell(read.describesTable)} | ` +
      `${read.ok ? read.rowsRead : '—'} | ${read.ok ? read.entries.length : '—'} | ${mdCell(skipped)} |`,
    )
  }
  lines.push('')

  // --- proposed mapping -----------------------------------------------------
  lines.push(`## 2. Proposed ext-field mapping entries (${resolution.mappable.length})`)
  lines.push('')
  if (resolution.mappable.length === 0) {
    lines.push('**NONE.** Nothing resolved onto the mapped row. The draft mapping is EMPTY — do not install it.')
  } else {
    lines.push('| # | proposed | id kind | type | basis | CONFIRM-REQUIRED |')
    lines.push('|---|---|---|---|---|---|')
    resolution.mappable.forEach((item, index) => {
      const confirm = item.idKind === 'placeholder-from-slot'
        ? 'RENAME the id (mechanical, from the column name); confirm the label is what this column means'
        : 'confirm the source column is the right one for this target'
      lines.push(
        `| ${index + 1} | \`${mdCell(item.sourceTable)}.${mdCell(item.sourceColumn)}\` → \`${mdCell(item.target)}\` | ` +
        `${mdCell(item.idKind)} | ${mdCell(item.type)} (${mdCell(item.typeSource)}) | ${mdCell(item.basis)} | ${confirm} |`,
      )
    })
  }
  lines.push('')

  // --- deferred -------------------------------------------------------------
  lines.push(`## 3. Deferred — resolved, but NOT mappable today (${resolution.deferred.length})`)
  lines.push('')
  if (resolution.deferred.length === 0) {
    lines.push('_none_')
  } else {
    lines.push(`The ext-field mapper is handed exactly one row (\`${mdCell(preset.mappingSourceTable)}\`).`)
    lines.push('A column on any other table cannot be a mapping entry today — it would read `undefined` on every')
    lines.push('row and leave its `ext_` column permanently empty, which is indistinguishable from success.')
    lines.push('')
    lines.push('| proposed | source | reason | basis |')
    lines.push('|---|---|---|---|')
    for (const item of resolution.deferred) {
      lines.push(
        `| \`${mdCell(item.target)}\` | \`${mdCell(item.sourceTable)}.${mdCell(item.sourceColumn)}\` | ` +
        `${mdCell(item.reason)} | ${mdCell(item.basis)} |`,
      )
    }
  }
  lines.push('')

  // --- confirm-blocked ------------------------------------------------------
  const blockedItems = resolution.blocked || []
  if (blockedItems.length > 0) {
    lines.push(`## 3b. CONFIRM-BLOCKED — do not install either half (${blockedItems.length})`)
    lines.push('')
    lines.push('Each slot below was one of several candidates for a target this draft REFUSED to decide (§4).')
    lines.push('They are deliberately absent from both the mapping entries and the pack fields, so confirming')
    lines.push('this draft wholesale cannot install both halves of an unresolved ambiguity. Settle the named')
    lines.push('target first, then re-run the probe.')
    lines.push('')
    lines.push('| slot | proposed id | blocked by | basis |')
    lines.push('|---|---|---|---|')
    for (const item of blockedItems) {
      lines.push(
        `| \`${mdCell(item.sourceTable)}.${mdCell(item.sourceColumn)}\` | \`${mdCell(item.target)}\` | ` +
        `${mdCell((item.confirmBlockedBy || []).join(', '))} | ${mdCell(item.basis)} |`,
      )
    }
    lines.push('')
  }

  // --- unresolved -----------------------------------------------------------
  lines.push(`## 4. UNRESOLVED — the gaps (${resolution.unresolved.length})`)
  lines.push('')
  if (resolution.unresolved.length === 0) {
    lines.push('_none — every preset target was positively justified_')
  } else {
    lines.push('| target | via | reason | what was looked for |')
    lines.push('|---|---|---|---|')
    for (const item of resolution.unresolved) {
      const candidates = item.candidates
        ? ` — candidates: ${item.candidates.map((c) => `${c.slot} ("${c.label}", row #${c.rowIndex})`).join('; ')}`
        : ''
      lines.push(
        `| ${mdCell(item.target || '(placeholder)')} | ${mdCell(item.via)} | \`${mdCell(item.reason)}\` | ` +
        `${mdCell(item.lookedFor)}${mdCell(candidates)} |`,
      )
    }
  }
  lines.push('')

  // --- option sets ----------------------------------------------------------
  const optionRows = optionSets instanceof Map ? [...optionSets.values()] : []
  lines.push(`## 5. Option sets extracted from your value-set tables (${optionRows.length})`)
  lines.push('')
  if (optionRows.length === 0) {
    lines.push('_none_')
  } else {
    lines.push('| value set | table | options | duplicates collapsed | blank rows skipped | disabled rows skipped |')
    lines.push('|---|---|---|---|---|---|')
    for (const result of optionRows) {
      lines.push(
        `| ${mdCell(result.valueSetKey)} | ${mdCell(result.table)} | ` +
        `${result.ok ? result.options.length : `NOT EMITTED: ${result.reason}`} | ` +
        `${result.duplicateCount ?? 0} | ${result.emptyCount ?? 0} | ${result.disabledCount ?? 0} |`,
      )
    }
    lines.push('')
    lines.push('Option VALUES are in `customer-pack.draft.json` under `stockPreparationCustomerPacks`. Confirm the')
    lines.push('vocabulary is complete and that duplicates were the right ones to collapse (the pack normalizer')
    lines.push('rejects duplicate option values outright, so they could not be passed through).')
  }
  lines.push('')

  // --- what to do -----------------------------------------------------------
  lines.push('## 6. What to do next')
  lines.push('')
  lines.push('1. Work through §2, §3 and §4 with someone who knows this factory\'s data. §4 is the important one:')
  lines.push('   an unresolved target is a column that will stay EMPTY forever if you install as-is.')
  lines.push(`2. Rename every \`placeholder-from-slot\` id (§2) to a business name. The label column already carries`)
  lines.push('   the meaning your dictionary gave it.')
  lines.push('3. Decide `targetObjectId` in `customer-pack.draft.json` (absent = the frozen canonical main table).')
  lines.push('4. Decide `ownership` per field. `plm_system` is overwritten by every refresh; `human_preserved` is not.')
  lines.push('5. Strip every `$`-prefixed key and install the two inner members through the server-config files.')
  lines.push('   Both normalizers refuse unknown keys, so a leftover `$` key fails loudly at plugin activation.')
  lines.push('')

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// The ONE thing that crosses back into the probe's values-free report.
//
// IDENTIFIERS, CODED TOKENS AND COUNTS ONLY. No label, no option value, no
// `lookedFor` (it quotes preset aliases and dictionary text), and deliberately
// NO PROSE: the probe's leak sweep does whole-word matching over report string
// leaves, and an ordinary-English sentence is exactly the surface a sampled
// business word collides with — see assertValuesFree's own notes on why the
// tool's static `limits.note` had to be excluded from that sweep. This section
// is NOT excluded, so it must give the sweep nothing to trip on.
// ---------------------------------------------------------------------------

function buildDraftEmissionSummary({ preset, score, resolution, optionSets, dictionaryReads }) {
  return {
    presetId: preset.presetId,
    presetVersion: preset.presetVersion,
    vendor: preset.vendor,
    signature: {
      confidence: score.confidence,
      minimumConfidence: score.minimumConfidence,
      requiredTableCount: score.requiredTableCount,
      matchedRequiredTableCount: score.matchedRequiredTableCount,
      missingRequiredTableCount: score.missingRequired.length,
      forbiddenPresentCount: score.forbiddenPresentCount,
    },
    dictionaryReads: dictionaryReads.map((read) => ({
      key: read.key,
      table: read.table,
      describesTable: read.describesTable,
      read: read.ok === true,
      reason: read.ok === true ? null : read.reason,
      rowsRead: read.ok === true ? read.rowsRead : null,
      enabledEntryCount: read.ok === true ? read.entries.length : null,
      skippedByReason: read.ok === true ? { ...read.skippedByReason } : {},
    })),
    targetCounts: {
      declared: preset.targets.length,
      resolved: resolution.resolved.length,
      mappable: resolution.mappable.length,
      deferred: resolution.deferred.length,
      confirmBlocked: (resolution.blocked || []).length,
      unresolved: resolution.unresolved.length,
      placeholderProposed: resolution.unclaimed.length,
    },
    confirmBlockedTargets: (resolution.blocked || []).map((item) => ({
      target: item.target,
      blockedBy: item.confirmBlockedBy,
      reason: item.confirmBlockedReason,
    })),
    resolvedTargets: resolution.resolved.map((item) => ({
      target: item.target,
      via: item.via,
      idKind: item.idKind,
      sourceTable: item.sourceTable,
      sourceColumn: item.sourceColumn,
      type: item.type,
      ownership: item.ownership,
    })),
    deferredTargets: resolution.deferred.map((item) => ({ target: item.target, reason: item.reason })),
    unresolvedTargets: resolution.unresolved.map((item) => ({
      target: item.target,
      via: item.via,
      reason: item.reason,
    })),
    optionSets: (optionSets instanceof Map ? [...optionSets.values()] : []).map((result) => {
      // A ref is VERIFIED when it is either a preset-declared value-set key or a member of the
      // preset's declared value-set table family — vendor-generic by construction either way, so it
      // travels as an identifier. `verified === false` means the dictionary cell named something the
      // family check refused: an ARBITRARY CUSTOMER VALUE, which never travels. Its locator does.
      const verified = result.verified !== false
      return {
        verified,
        valueSetKey: verified ? result.valueSetKey : null,
        table: verified ? result.table : null,
        locator: verified ? null : (result.locator || null),
        refLength: verified ? null : (result.refLength ?? null),
        emitted: result.ok === true,
        reason: result.ok === true ? null : result.reason,
        optionCount: result.ok === true ? result.options.length : 0,
        duplicateCount: result.duplicateCount ?? 0,
        emptyCount: result.emptyCount ?? 0,
        disabledCount: result.disabledCount ?? 0,
      }
    }),
  }
}

// ---------------------------------------------------------------------------
// Output placement. The drafts carry customer values, so they are DEPLOY-HOST
// output and must never be written into a working copy of this repository — the
// exact accident that once committed a customer's live option sets into
// plugins/plugin-integration-core/lib/customer-packs/factory-a.rehearsal.cjs,
// past a header in that very file forbidding it (#5074; the incident and the
// vocabulary/data distinction are argued in stock-preparation-customer-pack-
// catalog.cjs's header, which is also where the affected fields are named — this
// comment does not repeat them). A rule stated only in prose gets read once, so
// this one is refused structurally rather than by convention.
// ---------------------------------------------------------------------------

/**
 * CANONICALIZE BEFORE COMPARING. `path.resolve` only normalizes `..` and separators — it follows no
 * link. A Windows DIRECTORY JUNCTION (or a POSIX symlink) under $TEMP pointing into the repository
 * therefore resolved to a string outside the repo and was ACCEPTED, and a customer-pack draft
 * carrying real dictionary labels was written inside plugins/.../customer-packs — the #5074 incident
 * this guard's header claims to refuse structurally. A junction needs no privileges on Windows, so
 * this is not a theoretical bypass.
 *
 * The target directory usually does not exist yet (the probe creates it), and `realpath` throws on a
 * missing path, so canonicalization walks up to the DEEPEST EXISTING ANCESTOR, canonicalizes that,
 * and re-appends the not-yet-created tail. That closes the link on every existing segment, which is
 * where a junction can live.
 */
function canonicalizeExistingAncestor(target, realpath) {
  let current = path.resolve(target)
  const tail = []
  for (;;) {
    try {
      const real = realpath(current)
      return tail.length === 0 ? real : path.join(real, ...tail.slice().reverse())
    } catch {
      const parent = path.dirname(current)
      // Reached the filesystem root without finding an existing ancestor: nothing to canonicalize.
      if (parent === current) return path.resolve(target)
      tail.push(path.basename(current))
      current = parent
    }
  }
}

function assertDraftOutDirOutsideRepo(outDir, repoRoot, options = {}) {
  const text = cellText(outDir)
  if (!text) {
    fail('DRAFT_OUT_DIR_INVALID', '--out-dir must be a non-empty directory path', { field: '--out-dir' })
  }
  // Injected so this module stays pure; the probe passes fs.realpathSync.native. With no realpath
  // the check degrades to the string comparison, which is why the probe always passes one.
  const realpath = typeof options.realpath === 'function' ? options.realpath : (p) => p
  const resolvedOut = canonicalizeExistingAncestor(text, realpath)
  const resolvedRepo = canonicalizeExistingAncestor(cellText(repoRoot) || '.', realpath)
  const relative = path.relative(resolvedRepo, resolvedOut)
  const inside = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  if (inside) {
    fail(
      'DRAFT_OUT_DIR_INSIDE_REPO',
      '--out-dir points inside this repository; the drafts contain customer dictionary values and are deploy-host output',
      { field: '--out-dir' },
    )
  }
  return resolvedOut
}

export {
  DRAFT_EMITTER_REASONS,
  DRAFT_FILE_NAMES,
  MAX_OPTIONS_PER_FIELD,
  SIBLING_PRESET_SCHEMA_MARKER,
  SOURCE_VENDOR_PRESET_SCHEMA_MARKER,
  SourceDraftEmitterError,
  adaptVendorPresetShape,
  completeDictionarySpec,
  discoverValueSetRefColumn,
  discoverValueSetColumns,
  deriveSemanticExtFieldId,
  fieldTypeForCatalogColumn,
  isEnabledCell,
  normalizeColumnFamily,
  resolvePresetSchemaBinding,
  fallbackFamilyColumnMatcher,
  fallbackIsFamilyColumn,
  FALLBACK_LABEL_HINT_VOCABULARY,
  FALLBACK_DICTIONARY_TYPE_HINT_WORDS,
  DELETED_PATTERN_KEYS,
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
  canonicalizeExistingAncestor,
  matchesEnabledValue,
  cellText,
}
