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
  'ROW_SLOT_DUPLICATE',
  // --- target resolution -----------------------------------------------------
  'NATIVE_TABLE_ABSENT',
  'NATIVE_COLUMN_ABSENT',
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
// adaptVendorPresetShape() is the ONE place in this codebase that assumes what a
// vendor preset LOOKS LIKE. The preset schema itself is being defined on the
// sibling branch `feat/stock-prep-vendor-presets`
// (plugins/plugin-integration-core/lib/source-vendor-presets/). When that lands,
// reconciling the consumption side is a change to THIS FUNCTION AND NOTHING
// ELSE: everything downstream operates on the normalized internal shape it
// returns, and no other function in this module or in source-discovery-probe.mjs
// touches a raw preset key.
//
// The assumption is deliberately conservative and, above all, obeys the schema's
// core rule: every key below describes WHERE TO LOOK and HOW TO READ. There is
// no key in which a preset could record a customer's actual ExAttr assignment.
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

function adaptVendorPresetShape(raw) {
  if (!isPlainObject(raw)) {
    fail('PRESET_NOT_AN_OBJECT', 'a vendor preset must be a plain object', {})
  }

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
    const key = requireString(entry.key, 'PRESET_DICTIONARY_INVALID', `${at}.key`)
    if (dictionaries.has(key)) {
      fail('PRESET_DICTIONARY_INVALID', `${at}.key is declared twice`, { field: `${at}.key`, key })
    }
    const enabledColumn = optionalString(entry.enabledColumn)
    const enabledValues = Array.isArray(entry.enabledValues) ? entry.enabledValues.map(cellText) : []
    if (enabledColumn && enabledValues.length === 0) {
      // "Enabled rows only" is load-bearing: on the observed vendor family only
      // 2 of 30 bom-side slots and 21 of 73 part-side slots are live. A preset
      // that names the flag column but not which value means ENABLED would make
      // the filter a no-op, which is the silent-over-collection failure.
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
    if (labelAliases.length === 0) {
      // A dictionary-justified target with no aliases has nothing to be
      // justified BY, and would either match nothing or (worse) invite a
      // fallback. Refuse the preset instead.
      fail('PRESET_TARGET_INVALID', `${at}.labelAliases must list at least one vendor-standard label`, {
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
  const bestConfidence = Math.max(...eligible.map((score) => score.confidence))
  const winners = eligible.filter((score) => score.confidence === bestConfidence)
  if (winners.length > 1) {
    // Two vendors both explain this database. Picking one would be exactly the
    // guess this whole module refuses to make.
    return {
      ok: false,
      reason: 'PRESET_SIGNATURE_AMBIGUOUS',
      scores,
      detail: `${winners.length} presets tie at confidence ${bestConfidence.toFixed(2)}`,
    }
  }
  const winner = winners[0]
  return { ok: true, preset: list.find((preset) => preset.presetId === winner.presetId), score: winner, scores }
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
function readDictionaryEntries({ spec, rows, describedColumns }) {
  const entries = []
  const skipped = []
  const seenSlots = new Map()
  const columns = describedColumns instanceof Map ? describedColumns : new Map()

  for (const [rowIndex, row] of (Array.isArray(rows) ? rows : []).entries()) {
    const source = isPlainObject(row) ? row : {}

    if (spec.enabledColumn) {
      const rawFlag = source[spec.enabledColumn]
      if (!matchesEnabledValue(rawFlag, spec.enabledValues)) {
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

    const label = cellText(source[spec.labelColumn])
    if (!label) {
      // An enabled slot with no label is a REAL shape (seen live) and it is a
      // gap, not a non-event: the slot is live but nothing says what it means.
      skipped.push({ rowIndex, reason: 'ROW_LABEL_EMPTY', slot: column.name })
      continue
    }

    const slotKey = column.name.toLowerCase()
    if (seenSlots.has(slotKey)) {
      skipped.push({ rowIndex, reason: 'ROW_SLOT_DUPLICATE', slot: column.name })
      continue
    }
    seenSlots.set(slotKey, true)

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

  const skippedByReason = {}
  for (const item of skipped) skippedByReason[item.reason] = (skippedByReason[item.reason] || 0) + 1

  return { entries, skipped, skippedByReason }
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
    if (spec.enabledColumn && !matchesEnabledValue(source[spec.enabledColumn], spec.enabledValues)) {
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

function resolveTypeForEntry({ preset, entry, declaredType }) {
  if (declaredType) return { ok: true, type: declaredType, source: 'preset-target' }
  if (entry.typeToken) {
    const mapped = preset.typeMap.get(labelKey(entry.typeToken))
    if (mapped) return { ok: true, type: mapped, source: 'preset-typeMap' }
  }
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
      resolved.push({
        target: target.target,
        via: 'native',
        idKind: 'preset-declared',
        sourceTable: qualified,
        sourceTableName: tableHit.table.name,
        sourceColumn: column.name,
        type: target.type || preset.defaultType || 'string',
        typeSource: target.type ? 'preset-target' : 'preset-defaultType',
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
    const hits = read.entries.filter((entry) => aliasKeys.has(entry.labelKey))
    if (hits.length === 0) {
      unresolved.push({
        target: target.target,
        via: 'dictionary',
        reason: 'DICTIONARY_NO_ALIAS_MATCH',
        lookedFor: `${spec.table}.${spec.labelColumn} in [${target.labelAliases.join(', ')}] (${read.entries.length} enabled rows read)`,
      })
      continue
    }
    if (hits.length > 1) {
      // Two enabled slots claim the same meaning. Picking one silently is how a
      // draft becomes confidently wrong; the human is told exactly which slots.
      unresolved.push({
        target: target.target,
        via: 'dictionary',
        reason: 'DICTIONARY_AMBIGUOUS_ALIAS_MATCH',
        lookedFor: `${spec.table}.${spec.labelColumn} in [${target.labelAliases.join(', ')}]`,
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
      basis: dictionaryBasis({ entry, matchedAlias: aliasKeys.get(entry.labelKey) }),
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
        const proposal = {
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
  for (const item of resolved) {
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

  return { resolved, mappable, deferred, unresolved, unclaimed }
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
  const extensionFields = resolution.resolved.map((item) => ({
    id: item.target,
    label: item.label,
    type: item.type,
    ownership: item.ownership,
  }))

  const emittedOptionSets = []
  const optionSetGaps = []
  for (const item of resolution.resolved) {
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
    $fieldBasis: resolution.resolved.map((item) => ({
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
      unresolved: resolution.unresolved.length,
      placeholderProposed: resolution.unclaimed.length,
    },
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
    optionSets: (optionSets instanceof Map ? [...optionSets.values()] : []).map((result) => ({
      valueSetKey: result.valueSetKey,
      table: result.table,
      emitted: result.ok === true,
      reason: result.ok === true ? null : result.reason,
      optionCount: result.ok === true ? result.options.length : 0,
      duplicateCount: result.duplicateCount ?? 0,
      emptyCount: result.emptyCount ?? 0,
      disabledCount: result.disabledCount ?? 0,
    })),
  }
}

// ---------------------------------------------------------------------------
// Output placement. The drafts carry customer values, so they are DEPLOY-HOST
// output and must never be written into a working copy of this repository — the
// exact accident that put a customer's 领料节点 / 交接工段 option sets into
// plugins/plugin-integration-core/lib/customer-packs/factory-a.rehearsal.cjs
// (see stock-preparation-customer-pack-catalog.cjs's header). Refused
// structurally rather than by convention.
// ---------------------------------------------------------------------------

function assertDraftOutDirOutsideRepo(outDir, repoRoot) {
  const text = cellText(outDir)
  if (!text) {
    fail('DRAFT_OUT_DIR_INVALID', '--out-dir must be a non-empty directory path', { field: '--out-dir' })
  }
  const resolvedOut = path.resolve(text)
  const resolvedRepo = path.resolve(cellText(repoRoot) || '.')
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
  cellText,
}
