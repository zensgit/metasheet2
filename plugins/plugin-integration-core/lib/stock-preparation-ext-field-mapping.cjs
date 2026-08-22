'use strict'

// SOURCE COLUMN -> `ext_` FIELD MAPPER.
//
// The customer pack (stock-preparation-customer-pack.cjs) declares WHICH `ext_`
// columns exist on a tenant's landing sheet. Nothing declared WHERE their values
// come from: `createRow` (stock-preparation-bom-expansion.cjs) emits a fixed
// canonical row shape and no production code path has ever produced an `ext_`
// key. This module is that missing half — a declarative, reviewable
// "source column -> `ext_` logical id" object, plus the coercion that turns an
// all-string legacy cell into the type the pack declared.
//
// THREE REFUSALS, and they are the point of the module:
//
//   1. A mapping whose target is a `human_preserved` column is REFUSED at
//      normalize time. The refresh path already has a wall
//      (`assertNoHumanFields`, conflict-planner + apply-writer) that throws when
//      a human column reaches a write payload. A mapper that could target one
//      would turn that wall into a runtime surprise instead of a config error.
//      Refusing here keeps the wall's integrity: a human `ext_` column is
//      FIRST-LOAD territory, which is a different write path with a different
//      owner gate, and is deliberately out of scope here.
//   2. A mapping whose target is a canonical (frozen template) field is REFUSED.
//      The template governs its own columns — `createRow` already produces every
//      one of them, and a mapper that could overwrite `componentCode` would be a
//      second, invisible authority over the canonical row.
//   3. A mapping whose target is not declared by the pack at all is REFUSED.
//      An `ext_` id that no pack declares has no installed column, so it has no
//      physical field id either (see below) — writing it could only ever fail.
//
// WHY THE LOGICAL ID IS NOT A LABEL. A logical field id is the INPUT to the
// deterministic physical field id: `stableMetaId(prefix, ...parts)` sha1s
// `(projectId, objectId, fieldId)` (packages/core-backend/src/multitable/
// provisioning.ts:130-136, via `getObjectFieldId` :146-148). Renaming a logical
// id therefore does not rename a column, it addresses a DIFFERENT column — which
// is why the mapper resolves targets against the pack rather than accepting a
// free-form string, and why an unresolvable `ext_` key must fail loud rather
// than fall back (stock-preparation-apply-writer.cjs `mapFieldName`).
//
// TYPE COERCION IS DERIVED, NEVER AUTHORED. The coercion for a target is read
// off the pack's own `type` — exactly the discipline the pack itself uses for
// `preserveOnRefresh`. A config cannot declare a coercion that disagrees with
// the column it writes into. Legacy 备料 source data is all-string (the customer
// system stores 总数量 / 毛胚* as `String` on purpose, so a user can type a unit
// into the box), so the string->number and string->date conversion has to happen
// SOMEWHERE; it belongs here and not in the pack, because a pack is schema and
// performs no value work.
//
// FAIL-CLOSED ON VALUES, NOT JUST ON SHAPE. A well-formed `"10"` becomes `10`.
// A `"10件"` is REFUSED with a typed, values-free reason — it is never truncated
// to `10`, and never written through as a string into a `number` column. The
// refusal drops that ONE cell and reports it; it does not drop the row, because
// one unparseable legacy cell must not cost a whole BOM component its PLM data.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO:
//   * it never BLANKS a target. An absent / blank source cell omits the key
//     rather than writing empty — "the source stopped carrying this column" and
//     "the source says this is now empty" are different claims and only the
//     second one may clear a cell. Deciding that is a separate change.
//   * it performs no I/O, holds no clock, and reads no config file. Pure.
//   * it does not install columns. The pack installer does that.
//
// Fail-closed everywhere: an unknown key anywhere in the config is an error, not
// something silently dropped.

const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  __internals: {
    assertNoContentKeys: assertNoTemplateContentKeys,
    isPlainObject,
    isSecretShaped,
  },
} = require('./stock-preparation-templates.cjs')

const { isTenantExtensionField } = require('./stock-preparation-extension-namespace.cjs')

// LAZY, and deliberately so. The customer-pack normalizer is the ONE authority
// on what a legal pack is (content-key gating, the inline-options ban, duplicate
// detection, the ownership vocabulary) and re-implementing a weaker copy of it
// here would be exactly the drift this module is supposed to prevent. But a
// static require would close a load-time cycle that already exists between four
// other modules:
//
//   option-sync -> table-actions -> bom-expansion -> THIS -> customer-pack
//                       ^                                        |
//                       +------------------ option-sync <--------+
//
// Requiring at CALL time instead of load time breaks the cycle without weakening
// the check: by the time anyone normalizes a mapping, every module is loaded and
// Node serves the same cached instance. The module's own top-level requires stay
// leaf-only (templates, extension-namespace) so nothing downstream can be
// half-initialised when it imports this one.
let cachedNormalizeCustomerPack = null
function loadNormalizeCustomerPack() {
  if (!cachedNormalizeCustomerPack) {
    // eslint-disable-next-line global-require
    cachedNormalizeCustomerPack = require('./stock-preparation-customer-pack.cjs').normalizeCustomerPack
  }
  return cachedNormalizeCustomerPack
}

// The frozen canonical catalog. A mapping target that lands in here is refused —
// the template, not a tenant config, is the authority over these columns.
const TEMPLATE_FIELD_ID_SET = new Set(
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.fields.map((field) => field.id),
)

const MAPPING_KEYS = Object.freeze(['mappingId', 'mappingVersion', 'label', 'mappings'])
const MAPPING_ENTRY_KEYS = Object.freeze(['sourceColumn', 'target'])

// Same boring, diffable shape the pack uses for its own ids: this string ends up
// in evidence and in a deploy folder name.
const MAPPING_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/

// A SOURCE column name is not ours to design — it is whatever the legacy system
// already calls the column, and the field-dictionary survey found both ASCII
// camelCase (`prepareDate`, `IdentityNo`, `OBJ_ID`) and at least one CJK literal
// (`提前周期`). The class is therefore permissive about script but strictly
// closed about structure: no dots, brackets, quotes, whitespace or control
// characters, so a column name can never carry a path, an index or a separator
// into a lookup. The CJK range is written as escapes, not literals, so the
// character class stays reviewable in a diff.
const SOURCE_COLUMN_PATTERN = /^[A-Za-z0-9_\u4e00-\u9fff][A-Za-z0-9_\u4e00-\u9fff-]{0,63}$/

// Prototype-bearing names never reach a property lookup, whatever the shape
// pattern would otherwise allow.
const UNSAFE_PROPERTY_NAMES = Object.freeze(['__proto__', 'constructor', 'prototype'])

// Strict decimal. Deliberately NOT `Number(value)`: that accepts `"1e5"`,
// `"0x10"`, `" 12 "` and `""`, every one of which would be a silent
// reinterpretation of a legacy cell rather than a reading of it.
const DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,3})?Z$/

// Closed reason vocabulary. Every throw and every per-cell refusal from this
// module carries exactly one of these, so a caller branches on the token and
// never parses free text.
const STOCK_PREPARATION_EXT_FIELD_MAPPING_ERROR_REASONS = Object.freeze([
  // --- config shape ---------------------------------------------------------
  'MAPPING_NOT_AN_OBJECT',
  'MAPPING_UNKNOWN_KEY',
  'MAPPING_ID_INVALID',
  'MAPPING_VERSION_INVALID',
  'MAPPING_LABEL_INVALID',
  'MAPPINGS_INVALID',
  'MAPPING_ENTRY_UNKNOWN_KEY',
  'SOURCE_COLUMN_INVALID',
  'SOURCE_COLUMN_DUPLICATE',
  'TARGET_INVALID',
  'TARGET_DUPLICATE',
  // --- authority ------------------------------------------------------------
  'PACK_INVALID',
  'TARGET_NOT_EXTENSION_FIELD',
  'TARGET_IS_TEMPLATE_FIELD',
  'TARGET_NOT_DECLARED_IN_PACK',
  'TARGET_HUMAN_OWNED',
  'TARGET_TYPE_UNSUPPORTED',
  // --- per-cell coercion (reported, never thrown) ---------------------------
  'SOURCE_VALUE_NOT_A_NUMBER',
  'SOURCE_VALUE_NOT_A_DATE',
  'SOURCE_VALUE_NOT_A_BOOLEAN',
  'SOURCE_VALUE_NOT_A_STRING',
  'SOURCE_VALUE_NOT_AN_OPTION',
  'SOURCE_VALUE_SECRET_SHAPED',
])

const COERCION_REASON_BY_TYPE = Object.freeze({
  string: 'SOURCE_VALUE_NOT_A_STRING',
  number: 'SOURCE_VALUE_NOT_A_NUMBER',
  boolean: 'SOURCE_VALUE_NOT_A_BOOLEAN',
  date: 'SOURCE_VALUE_NOT_A_DATE',
  select: 'SOURCE_VALUE_NOT_AN_OPTION',
})

// Module-private brand, same discipline as the customer pack: only this module
// can mint a normalized mapping, so a caller downstream (the row producer) can
// require a normalized object without being able to be handed a forged one.
const NORMALIZED_MAPPING_BRAND = Symbol('stockPreparationExtFieldMappingNormalized')

class StockPreparationExtFieldMappingError extends Error {
  constructor(message, reason, details = {}) {
    super(message)
    this.name = 'StockPreparationExtFieldMappingError'
    this.reason = reason
    this.details = details
  }
}

function fail(reason, message, details) {
  throw new StockPreparationExtFieldMappingError(message, reason, details || {})
}

function isNormalizedExtFieldMapping(value) {
  return Boolean(value && typeof value === 'object' && value[NORMALIZED_MAPPING_BRAND] === true)
}

function brandAndFreeze(mapping) {
  // Non-enumerable: the brand must never reach JSON, evidence or a diff.
  Object.defineProperty(mapping, NORMALIZED_MAPPING_BRAND, { value: true, enumerable: false })
  return Object.freeze(mapping)
}

function assertOnlyKnownKeys(input, allowedKeys, reason, label) {
  for (const key of Object.keys(input)) {
    if (!allowedKeys.includes(key)) {
      fail(reason, `${label}.${key} is not a supported key`, { field: `${label}.${key}`, key })
    }
  }
}

// The template module's content-key gate, re-thrown in THIS module's closed
// vocabulary so a caller branching on `.reason` sees something.
function assertNoContentKeys(input, label, reason) {
  try {
    assertNoTemplateContentKeys(input, label)
  } catch (error) {
    fail(reason, `${label} must not carry content-smuggling keys (schema only)`, {
      field: error && error.details ? error.details.field : label,
    })
  }
}

function safeLabel(value, reason, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(reason, `${label} must be a non-empty string`, { field: label })
  }
  const text = value.trim()
  if (isSecretShaped(text)) {
    fail(reason, `${label} must not be secret-shaped`, { field: label })
  }
  return text
}

/**
 * The pack is the single authority on what an `ext_` target IS: whether it
 * exists, what type it carries and — the refusal that matters — who owns it.
 * Passed explicitly (never imported from a default) so every call site makes its
 * catalog dependency visible, the same way the namespace module demands an
 * explicit `templateFieldIds`.
 */
function packCatalog(pack) {
  let normalized
  try {
    normalized = loadNormalizeCustomerPack()(pack)
  } catch (error) {
    fail('PACK_INVALID', 'ext field mapping requires a valid customer pack as its target authority', {
      field: 'pack',
      packReason: error && error.reason ? error.reason : 'UNKNOWN',
    })
  }
  const byId = new Map()
  for (const field of normalized.extensionFields) {
    byId.set(field.id, field)
  }
  const optionValuesById = new Map()
  for (const set of normalized.optionSets) {
    optionValuesById.set(set.fieldId, new Set(set.options.map((option) => option.value)))
  }
  return { pack: normalized, byId, optionValuesById }
}

function normalizeSourceColumn(value, label) {
  const text = safeLabel(value, 'SOURCE_COLUMN_INVALID', label)
  if (!SOURCE_COLUMN_PATTERN.test(text)) {
    fail('SOURCE_COLUMN_INVALID', `${label} must be a bare column name (no separators, quotes or whitespace)`, {
      field: label,
    })
  }
  if (UNSAFE_PROPERTY_NAMES.includes(text)) {
    fail('SOURCE_COLUMN_INVALID', `${label} must not name a prototype-bearing property`, { field: label })
  }
  return text
}

function normalizeMappingEntry(input, index, catalog) {
  const label = `mappings[${index}]`
  if (!isPlainObject(input)) {
    fail('MAPPINGS_INVALID', `${label} must be a plain object`, { field: label })
  }
  assertNoContentKeys(input, label, 'MAPPINGS_INVALID')
  assertOnlyKnownKeys(input, MAPPING_ENTRY_KEYS, 'MAPPING_ENTRY_UNKNOWN_KEY', label)

  const sourceColumn = normalizeSourceColumn(input.sourceColumn, `${label}.sourceColumn`)
  const target = safeLabel(input.target, 'TARGET_INVALID', `${label}.target`)

  // Refusal order is deliberate: the MOST specific diagnosis first, so a
  // deployer who typed a canonical id is told "the template governs that
  // column" rather than the vaguer "that is not an extension field id".
  // The namespace module already keeps the two id spaces disjoint, so today
  // exactly one of these two can fire for any given string — but the template
  // check goes first so the reason names the ACTUAL problem.
  if (TEMPLATE_FIELD_ID_SET.has(target)) {
    fail('TARGET_IS_TEMPLATE_FIELD', `${label}.target is a frozen template field; the template governs its own columns`, {
      field: `${label}.target`,
      target,
    })
  }
  if (!isTenantExtensionField(target)) {
    fail('TARGET_NOT_EXTENSION_FIELD', `${label}.target must be a tenant extension field id`, {
      field: `${label}.target`,
      target,
    })
  }
  const declared = catalog.byId.get(target)
  if (!declared) {
    fail('TARGET_NOT_DECLARED_IN_PACK', `${label}.target is not an extension field declared by the pack`, {
      field: `${label}.target`,
      target,
    })
  }
  // THE WALL. A refresh overwrites every column it writes, so a mapper that
  // could aim at a human-owned column would be a refresh that eats human work.
  if (declared.ownership !== 'plm_system') {
    fail('TARGET_HUMAN_OWNED', `${label}.target is a human-owned column; the refresh path may not write it`, {
      field: `${label}.target`,
      target,
      ownership: declared.ownership,
    })
  }
  if (!Object.prototype.hasOwnProperty.call(COERCION_REASON_BY_TYPE, declared.type)) {
    fail('TARGET_TYPE_UNSUPPORTED', `${label}.target declares a type this mapper cannot coerce into`, {
      field: `${label}.target`,
      target,
      type: declared.type,
    })
  }

  return Object.freeze({
    sourceColumn,
    target,
    // DERIVED from the pack, never authored — a config cannot declare a
    // coercion that disagrees with the column it writes into.
    coerce: declared.type,
    ownership: declared.ownership,
  })
}

function normalizeMappings(input, catalog) {
  if (!Array.isArray(input) || input.length === 0) {
    fail('MAPPINGS_INVALID', 'mappings must be a non-empty array', { field: 'mappings' })
  }
  const entries = input.map((raw, index) => normalizeMappingEntry(raw, index, catalog))
  const seenSource = new Set()
  const seenTarget = new Set()
  for (const entry of entries) {
    if (seenSource.has(entry.sourceColumn)) {
      // Two mappings off one source column would make the produced value depend
      // on array order — a config must not be order-sensitive.
      fail('SOURCE_COLUMN_DUPLICATE', 'mappings must not read the same source column twice', {
        field: 'mappings',
        sourceColumn: entry.sourceColumn,
      })
    }
    if (seenTarget.has(entry.target)) {
      fail('TARGET_DUPLICATE', 'mappings must not write the same target twice', {
        field: 'mappings',
        target: entry.target,
      })
    }
    seenSource.add(entry.sourceColumn)
    seenTarget.add(entry.target)
  }
  return Object.freeze(entries)
}

/**
 * Validate + normalize a source->`ext_` mapping config against the customer pack
 * that declares the target columns. Throws StockPreparationExtFieldMappingError
 * with a closed `.reason` on any violation; on success returns a deeply frozen,
 * branded mapping. Pure — no I/O, no host API, no clock.
 *
 * @param {object} input   { mappingId, mappingVersion, label?, mappings: [{ sourceColumn, target }] }
 * @param {object} options { pack } — the customer pack, raw or already normalized.
 */
function normalizeExtFieldMapping(input, options = {}) {
  if (isNormalizedExtFieldMapping(input)) return input
  if (!isPlainObject(input)) {
    fail('MAPPING_NOT_AN_OBJECT', 'ext field mapping must be a plain object', {})
  }
  assertNoContentKeys(input, 'mapping', 'MAPPING_UNKNOWN_KEY')
  assertOnlyKnownKeys(input, MAPPING_KEYS, 'MAPPING_UNKNOWN_KEY', 'mapping')

  const catalog = packCatalog(options.pack)

  const mappingId = safeLabel(input.mappingId, 'MAPPING_ID_INVALID', 'mapping.mappingId')
  if (!MAPPING_ID_PATTERN.test(mappingId)) {
    fail('MAPPING_ID_INVALID', `mapping.mappingId must match ${MAPPING_ID_PATTERN}`, {
      field: 'mapping.mappingId',
      mappingId,
    })
  }
  if (!Number.isInteger(input.mappingVersion) || input.mappingVersion < 1) {
    fail('MAPPING_VERSION_INVALID', 'mapping.mappingVersion must be a positive integer', {
      field: 'mapping.mappingVersion',
    })
  }

  const mappings = normalizeMappings(input.mappings, catalog)

  return brandAndFreeze({
    mappingId,
    mappingVersion: input.mappingVersion,
    label: input.label === undefined || input.label === null
      ? mappingId
      : safeLabel(input.label, 'MAPPING_LABEL_INVALID', 'mapping.label'),
    packId: catalog.pack.packId,
    packVersion: catalog.pack.packVersion,
    targetObjectId: catalog.pack.targetObjectId,
    mappings,
    // Frozen so the wiring side (fieldIdMap resolution, completeness gate) reads
    // ONE list and can never disagree with what `applyExtFieldMapping` writes.
    targetFieldIds: Object.freeze(mappings.map((entry) => entry.target)),
    // Option vocabularies for every `select` target, so a coercion can refuse a
    // value that is not in the installed dictionary without re-reading the pack.
    optionValuesByTarget: Object.freeze(
      Object.fromEntries(
        mappings
          .filter((entry) => entry.coerce === 'select' && catalog.optionValuesById.has(entry.target))
          .map((entry) => [entry.target, Object.freeze([...catalog.optionValuesById.get(entry.target)])]),
      ),
    ),
  })
}

/** The `ext_` logical ids a normalized mapping can produce. */
function extFieldMappingTargetIds(mapping) {
  if (!isNormalizedExtFieldMapping(mapping)) {
    fail('MAPPING_NOT_AN_OBJECT', 'extFieldMappingTargetIds requires a normalized mapping', {})
  }
  return mapping.targetFieldIds
}

// A source cell that is absent, null or whitespace-only is ABSENT, not empty.
// See the header: omitting differs from blanking, and only blanking clears a
// cell.
function isAbsentSourceValue(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}

function coerceNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { ok: true, value } : { ok: false }
  }
  if (typeof value !== 'string') return { ok: false }
  const text = value.trim()
  if (!DECIMAL_PATTERN.test(text)) return { ok: false }
  const parsed = Number(text)
  return Number.isFinite(parsed) ? { ok: true, value: parsed } : { ok: false }
}

function isRealCalendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

function coerceDate(value) {
  if (typeof value !== 'string') return { ok: false }
  const text = value.trim()
  const dateOnly = DATE_ONLY_PATTERN.exec(text)
  if (dateOnly) {
    const [, y, m, d] = dateOnly
    // `2026-02-30` matches the shape and is still not a date.
    if (!isRealCalendarDate(Number(y), Number(m), Number(d))) return { ok: false }
    return { ok: true, value: text }
  }
  const instant = DATE_TIME_PATTERN.exec(text)
  if (instant) {
    const [, y, m, d] = instant
    if (!isRealCalendarDate(Number(y), Number(m), Number(d))) return { ok: false }
    return { ok: true, value: text }
  }
  return { ok: false }
}

function coerceBoolean(value) {
  if (typeof value === 'boolean') return { ok: true, value }
  if (typeof value !== 'string') return { ok: false }
  const text = value.trim().toLowerCase()
  if (text === 'true') return { ok: true, value: true }
  if (text === 'false') return { ok: true, value: false }
  return { ok: false }
}

function coerceString(value) {
  // A `number` or `boolean` arriving for a `string` column is REFUSED rather
  // than String()-ed: stringifying is exactly the silent reinterpretation this
  // module exists to prevent, and legacy 备料 source data is all-string anyway.
  if (typeof value !== 'string') return { ok: false }
  return { ok: true, value: value.trim() }
}

function coerceSelect(value, allowedValues) {
  if (typeof value !== 'string') return { ok: false }
  const text = value.trim()
  if (!text) return { ok: false }
  // No installed dictionary for this column => any non-empty label is as much
  // as this module can check.
  if (!Array.isArray(allowedValues)) return { ok: true, value: text }
  return allowedValues.includes(text) ? { ok: true, value: text } : { ok: false }
}

/**
 * Coerce ONE raw source value into the type the pack declared for `target`.
 * Returns `{ ok: true, value }` or `{ ok: false, reason }` — never throws, and
 * never carries the offending value into the reason (evidence stays values-free).
 */
function coerceSourceValue(value, coerce, allowedValues) {
  let result
  if (coerce === 'number') result = coerceNumber(value)
  else if (coerce === 'date') result = coerceDate(value)
  else if (coerce === 'boolean') result = coerceBoolean(value)
  else if (coerce === 'select') result = coerceSelect(value, allowedValues)
  else if (coerce === 'string') result = coerceString(value)
  else result = { ok: false }

  if (!result.ok) {
    return { ok: false, reason: COERCION_REASON_BY_TYPE[coerce] || 'SOURCE_VALUE_NOT_A_STRING' }
  }
  // A secret-shaped cell must never be written into a sheet, whatever its type.
  if (typeof result.value === 'string' && isSecretShaped(result.value)) {
    return { ok: false, reason: 'SOURCE_VALUE_SECRET_SHAPED' }
  }
  return result
}

// Default lookup: OWN properties only. The BOM expansion passes its own
// `readField` instead (case-insensitive with an ambiguity refusal), so the
// mapper and the canonical row read a source row through exactly one set of
// lookup semantics rather than two that can drift.
function defaultReadSourceColumn(row, column) {
  if (!isPlainObject(row)) return undefined
  return Object.prototype.hasOwnProperty.call(row, column) ? row[column] : undefined
}

/**
 * Apply a normalized mapping to ONE raw source row.
 *
 * @returns {{ values: object, errors: Array<{type,target,sourceColumn,expectedType}> }}
 *   `values` carries only successfully coerced `ext_` keys. A refused cell is
 *   OMITTED from `values` and reported in `errors` — never written wrong, and
 *   never silently dropped. Errors are values-free: schema ids and a frozen
 *   reason token only.
 */
function applyExtFieldMapping(mapping, sourceRow, options = {}) {
  if (!isNormalizedExtFieldMapping(mapping)) {
    fail('MAPPING_NOT_AN_OBJECT', 'applyExtFieldMapping requires a normalized mapping', {})
  }
  const read = typeof options.readField === 'function' ? options.readField : defaultReadSourceColumn
  const values = {}
  const errors = []
  for (const entry of mapping.mappings) {
    const raw = read(sourceRow, entry.sourceColumn)
    if (isAbsentSourceValue(raw)) continue
    const coerced = coerceSourceValue(raw, entry.coerce, mapping.optionValuesByTarget[entry.target])
    if (!coerced.ok) {
      errors.push({
        type: coerced.reason,
        target: entry.target,
        sourceColumn: entry.sourceColumn,
        expectedType: entry.coerce,
      })
      continue
    }
    values[entry.target] = coerced.value
  }
  return { values, errors }
}

/**
 * Values-free evidence projection: schema ids, types and counts only, never a
 * source cell and never an option literal.
 */
function summarizeExtFieldMappingForEvidence(mapping) {
  if (!isNormalizedExtFieldMapping(mapping)) {
    fail('MAPPING_NOT_AN_OBJECT', 'summarizeExtFieldMappingForEvidence requires a normalized mapping', {})
  }
  return {
    mappingId: mapping.mappingId,
    mappingVersion: mapping.mappingVersion,
    packId: mapping.packId,
    packVersion: mapping.packVersion,
    targetObjectId: mapping.targetObjectId,
    mappingCount: mapping.mappings.length,
    targetFieldIds: [...mapping.targetFieldIds],
    coercions: mapping.mappings.map((entry) => ({
      target: entry.target,
      coerce: entry.coerce,
      ownership: entry.ownership,
    })),
  }
}

module.exports = {
  MAPPING_ID_PATTERN,
  SOURCE_COLUMN_PATTERN,
  STOCK_PREPARATION_EXT_FIELD_MAPPING_ERROR_REASONS,
  StockPreparationExtFieldMappingError,
  isNormalizedExtFieldMapping,
  normalizeExtFieldMapping,
  extFieldMappingTargetIds,
  applyExtFieldMapping,
  summarizeExtFieldMappingForEvidence,
  __internals: {
    MAPPING_KEYS,
    MAPPING_ENTRY_KEYS,
    UNSAFE_PROPERTY_NAMES,
    COERCION_REASON_BY_TYPE,
    DECIMAL_PATTERN,
    coerceSourceValue,
    isAbsentSourceValue,
    defaultReadSourceColumn,
  },
}
