'use strict'

// #2253 C3: conflict planner for PLM stock-preparation refreshes.
// Pure and write-free. It consumes C2 expanded rows + existing stock-preparation
// rows + C2 rowErrors, then produces add/update/skip/inactive/manual_confirm
// decisions for a later C4 apply writer. No PLM read, MetaSheet write, route,
// UI, external DB write, or K3 path.

const crypto = require('node:crypto')

const {
  HUMAN_PRESERVED_FIELD_IDS,
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  normalizeStockPreparationTemplate,
} = require('./stock-preparation-templates.cjs')
const { isTenantExtensionField } = require('./stock-preparation-extension-namespace.cjs')

const DECISIONS = Object.freeze({
  ADD: 'add',
  UPDATE: 'update',
  SKIP: 'skip',
  INACTIVE: 'inactive',
  MANUAL_CONFIRM: 'manual_confirm',
})

const RUN_FIELD_IDS = Object.freeze([
  'lastPlmRefreshRunId',
  'lastPlmRefreshAt',
  'lastPlmRefreshDecision',
  'lastPlmConflictSummary',
])

const LINEAGE_FIELD_IDS = Object.freeze([
  'projectNo',
  'componentSourceId',
  'parentSourceId',
  'path',
])

const IDENTITY_FIELD_IDS = Object.freeze([
  'componentCode',
  'componentName',
  'material',
  'sourceVersion',
])

// Frozen persisted vocabulary. Tokens are NEVER removed from this list: table-scope policy
// selections are persisted under `integration:table-action:conflict-policies:` and re-validated
// against this list on read, so dropping a token would turn "this selection does nothing" into
// "this stored row no longer loads" — strictly worse. See IMPLEMENTED/UNIMPLEMENTED below for
// which of these a client may actually SELECT.
const DUPLICATE_EXPANDED_KEY_POLICIES = Object.freeze([
  'hold',
  'keep_multiple_rows',
  'merge_quantity',
  'select_representative',
  'skip_selected',
  'source_correction_required',
])

// The single policy that can turn a duplicate group into write decisions. Pinned as a constant so
// the resolution gate in resolveDuplicateExpandedRows() and the implemented-policy derivation below
// cannot drift apart under a rename.
const DUPLICATE_EXPANDED_KEY_RESOLVING_POLICY = 'keep_multiple_rows'

// The catch-all held reason heldReasonForDuplicatePolicy() returns for any policy the planner has
// no named handling for. A policy that lands here is inert: selecting it is accepted, changes
// nothing, and the rows hold anonymously.
const DUPLICATE_EXPANDED_KEY_UNSUPPORTED_HELD_REASON = 'unsupported_policy'

// ── O1-B: identity for the ANONYMOUS hold families ──────────────────────────
//
// Three planner emitters produce manual_confirm holds WITHOUT an idempotencyKey
// (:1023 expanded-keyless, :1029 existing-keyless, :1035 the c2_row_error
// UMBRELLA — which is `rowError.type || 'c2_row_error'`, an unvalidated
// passthrough covering 10 real BOM-expander types plus the ext-mapping coercion
// codes). The confirmation-decision ledger keys every row on `rowIdentity`, so
// without an identity these holds can only ever be counted, never ledgered.
//
// This block derives a values-free identity from the context the emitters
// ACTUALLY carry — see docs/development/takeover-beiliao-20260821/
// anonymous-hold-identity-spec-20260829.md for the per-family audit. The
// identity is a HASH: component refs, paths and order ids go IN, nothing comes
// back OUT. It is a pure function of the plan input, so the same source state
// reproduces the same identity — the property supersede/reopen leans on.
//
// The prefix is a RESERVED NAMESPACE. A real idempotencyKey is
// `JSON.stringify({projectNo, componentSourceId, parentSourceId, path})`
// (stock-preparation-bom-expansion.cjs makeIdempotencyKey), so it always starts
// with '{' and can never produce this prefix. The ledger fences both directions.
const ANONYMOUS_HOLD_IDENTITY_PREFIX = 'anon-hold:v1:'

// Row-granularity context for the two keyless-ROW families. projectNo is folded
// in but does NOT count as a discriminator: a row carrying nothing but the
// project number addresses nothing, and an identity that addresses nothing is
// worse than an honest refusal (see ANONYMOUS_HOLD_IDENTITY_UNAVAILABLE).
const ANONYMOUS_ROW_IDENTITY_FIELDS = Object.freeze([
  'componentSourceId',
  'parentSourceId',
  'path',
  'depth',
])

// Locus-granularity context for the 10 expander rowError types. Read every one
// of the 12 emit sites before changing this: NONE of them attaches an order id,
// a component ref or a path — `field` (a frozen read-plan source column name),
// `depth` and, for invalid_quantity only, `relation` is the whole of it.
const ANONYMOUS_LOCUS_IDENTITY_FIELDS = Object.freeze(['field', 'depth', 'relation'])

// Cell-granularity context for the ext-mapping coercion codes. The mapper emits
// { type, target, sourceColumn, expectedType } and the expander adds `depth`;
// all four are CONFIG identifiers (an ext_ field id, a source column name, a
// pack-derived type token), never customer values. The planner's `details`
// projection drops target/sourceColumn/expectedType, so the identity reads the
// raw rowError instead of the conflictSummary — deliberately, so conflictSummary
// (which feeds the ledger's inputFingerprint) is left untouched.
const ANONYMOUS_CELL_IDENTITY_FIELDS = Object.freeze(['target', 'sourceColumn', 'expectedType', 'depth'])

const DUPLICATE_SOURCE_DETAIL_FIELDS = Object.freeze([
  'sourceDetailId',
  'detailSourceId',
  'lineSourceId',
  'bomDetailId',
])

const DUPLICATE_SORT_LINE_FIELDS = Object.freeze([
  'sourceSortLine',
  'sortLine',
  'lineNo',
])

class StockPreparationConflictPlannerError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'StockPreparationConflictPlannerError'
    this.details = details
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}

function optionalString(value, field, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string' || value.trim() === '') {
    throw new StockPreparationConflictPlannerError(`${field} must be a string`, { field })
  }
  return value.trim()
}

function normalizeRows(rows, field) {
  if (rows === undefined || rows === null) return []
  if (!Array.isArray(rows)) {
    throw new StockPreparationConflictPlannerError(`${field} must be an array`, { field })
  }
  return rows.filter(isPlainObject).map((row) => ({ ...row }))
}

function normalizeRunId(value) {
  return optionalString(value, 'runId', 'dry-run')
}

function normalizeIsoTime(value) {
  if (value === undefined || value === null || value === '') {
    return new Date().toISOString()
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed !== '') {
      const timestamp = Date.parse(trimmed)
      if (!Number.isNaN(timestamp)) return new Date(timestamp).toISOString()
    }
  }
  throw new StockPreparationConflictPlannerError('plannedAt must be an ISO string or Date', { field: 'plannedAt' })
}

function normalizeTemplate(template) {
  return normalizeStockPreparationTemplate(template || STOCK_PREPARATION_MAIN_TABLE_TEMPLATE)
}

function normalizeStrategy(template, override) {
  const strategy = { ...(template.conflictStrategy || {}), ...(isPlainObject(override) ? override : {}) }
  if (strategy.deleteByDefault === true) {
    throw new StockPreparationConflictPlannerError('deleteByDefault is not supported for stock-preparation planning', {
      field: 'conflictStrategy.deleteByDefault',
    })
  }
  if (strategy.preserveHumanFields === false) {
    throw new StockPreparationConflictPlannerError('human-preserved fields must be preserved', {
      field: 'conflictStrategy.preserveHumanFields',
    })
  }
  if (strategy.missingFromPlmPolicy && strategy.missingFromPlmPolicy !== 'mark_inactive') {
    throw new StockPreparationConflictPlannerError('missingFromPlmPolicy must be mark_inactive for v1', {
      field: 'conflictStrategy.missingFromPlmPolicy',
    })
  }
  return {
    addMissing: strategy.addMissing !== false,
    refreshPlmSystemFields: strategy.refreshPlmSystemFields !== false,
    preserveHumanFields: true,
    duplicatePolicy: strategy.duplicatePolicy || 'skip_or_conflict',
    missingFromPlmPolicy: 'mark_inactive',
    deleteByDefault: false,
  }
}

function fieldIdsByOwnership(template, ownership) {
  return template.fields.filter((field) => field.ownership === ownership).map((field) => field.id)
}

function plmRefreshFieldIds(template) {
  return fieldIdsByOwnership(template, 'plm_system').filter((id) => !RUN_FIELD_IDS.includes(id))
}

function fieldMapForTemplate(template) {
  return new Map((template.fields || []).map((field) => [field.id, field]))
}

// ── PACK-AWARE OWNERSHIP (#5074 follow-up) ────────────────────────────────────
//
// Until now this planner derived its writable set from the FROZEN template alone,
// so a customer pack's `ext_` columns were never written — and "a refresh never
// clobbers a human cell" held by OMISSION, not by decision. Once a pack installs
// `ext_` plm_system columns the refresh has to write them, and the moment it does,
// the human/plm boundary must come from what is ACTUALLY INSTALLED ON THE SHEET.
//
// The classification therefore reads back the `property.stockPreparation` stanza
// the pack installer stamped (buildExtensionFieldProperty in
// stock-preparation-customer-pack-installer.cjs) rather than trusting the pack
// config, the caller, or the template.
//
// FAIL-CLOSED, in this precedence order:
//   1. a `preserveOnRefresh: true` pin WINS over ownership — a deployer can pin a
//      hand-maintained column without restating ownership, and the pin must bite.
//   2. `ownership: 'human_preserved'` -> the HUMAN band (extends the wall).
//   3. `ownership: 'plm_system'` AND `extension === true` -> the WRITABLE band.
//      The extension stamp is REQUIRED: it is the installer's own mark, and
//      without it the stanza did not come from a pack install.
//   4. anything else — no stanza, a malformed stanza, a missing/unknown
//      ownership, a plm_system claim with no extension stamp — is UNCLASSIFIED:
//      NOT writable and NOT human. An unclassified column is a column nobody has
//      decided about, and a refresh must not be the thing that decides.
//
// Only `ext_`-namespaced ids are considered at all. A canonical id appearing in the
// installed set is TEMPLATE-GOVERNED and ignored here, so no installed property can
// ever re-classify a frozen column (e.g. flip `procurementOwner` to plm_system).
//
// PURE: this reads an in-memory projection the CALLER supplies. It performs no I/O.

const PACK_FIELD_OWNERSHIP_REASONS = Object.freeze([
  'invalid_field_id',
  'duplicate_field_id',
  'template_governed',
  'not_extension_namespace',
  'missing_property_stanza',
  'malformed_property_stanza',
  'missing_ownership',
  'unknown_ownership',
  'missing_extension_stamp',
  'human_preserved_ownership',
  'preserve_on_refresh_pinned',
])

const PACK_FIELD_OWNERSHIP_PLM = 'plm_system'
const PACK_FIELD_OWNERSHIP_HUMAN = 'human_preserved'

function normalizeTemplateFieldList(templateFields) {
  if (Array.isArray(templateFields)) return templateFields.filter(isPlainObject)
  if (isPlainObject(templateFields) && Array.isArray(templateFields.fields)) {
    return templateFields.fields.filter(isPlainObject)
  }
  throw new StockPreparationConflictPlannerError('templateFields must be an array of template field descriptors', {
    field: 'templateFields',
  })
}

// Accepts the shapes a caller can realistically hold without inventing a new read:
//   - Array<{ id | fieldId | logicalId, property }>
//   - Map<any, { id | fieldId | logicalId, property }>   (the host fields map, keyed physically)
//   - plain object { [fieldId]: { property } | property-stanza-carrier }
// Every entry is reduced to { fieldId, stanza } and nothing else is trusted.
function normalizeInstalledFieldProperties(installedFieldProperties) {
  if (installedFieldProperties === undefined || installedFieldProperties === null) return []
  let entries
  if (Array.isArray(installedFieldProperties)) {
    entries = installedFieldProperties.map((row) => [undefined, row])
  } else if (installedFieldProperties instanceof Map) {
    entries = Array.from(installedFieldProperties.entries())
  } else if (isPlainObject(installedFieldProperties)) {
    entries = Object.entries(installedFieldProperties)
  } else {
    throw new StockPreparationConflictPlannerError('installedFieldProperties must be an array, Map, or object', {
      field: 'installedFieldProperties',
    })
  }

  return entries.map(([key, row]) => {
    const carrier = isPlainObject(row) ? row : {}
    const fieldId = optionalStringOrNull(carrier.logicalId)
      || optionalStringOrNull(carrier.fieldId)
      || optionalStringOrNull(carrier.id)
      || (typeof key === 'string' ? optionalStringOrNull(key) : null)
    const property = isPlainObject(carrier.property) ? carrier.property : undefined
    const stanza = property && isPlainObject(property.stockPreparation)
      ? property.stockPreparation
      : (isPlainObject(carrier.stockPreparation) ? carrier.stockPreparation : undefined)
    return {
      fieldId,
      hasProperty: property !== undefined || isPlainObject(carrier.stockPreparation),
      stanza,
      stanzaMalformed: property !== undefined
        && property.stockPreparation !== undefined
        && !isPlainObject(property.stockPreparation),
    }
  })
}

function optionalStringOrNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * Project the writable / human bands a pack-aware refresh must honour.
 *
 * @param {object} input
 * @param {Array|object} input.templateFields  frozen template field descriptors (or the template).
 * @param {Array|Map|object} [input.installedFieldProperties]  what is ACTUALLY installed on the
 *        sheet. Omit it and the result is byte-identical to the pre-pack behaviour.
 * @returns {{
 *   plmWritableFieldIds: string[],       // template refresh band + qualifying pack columns
 *   humanPreservedFieldIds: string[],    // template human band + declared pack human columns
 *   packPlmWritableFieldIds: string[],
 *   packHumanPreservedFieldIds: string[],
 *   unclassifiedPackFieldIds: string[],
 *   packAware: boolean,
 *   reasons: Array<{fieldId: string, reason: string}>,  // VALUES-FREE (ids + frozen tokens only)
 *   counts: object,
 * }}
 */
function derivePackAwarePlmWritableFields(input = {}) {
  const templateFieldList = normalizeTemplateFieldList(input.templateFields)
  const templateIds = new Set(templateFieldList.map((field) => field.id))
  const baseHuman = templateFieldList
    .filter((field) => field.ownership === PACK_FIELD_OWNERSHIP_HUMAN)
    .map((field) => field.id)
  const basePlm = templateFieldList
    .filter((field) => field.ownership === PACK_FIELD_OWNERSHIP_PLM)
    .map((field) => field.id)
    .filter((id) => !RUN_FIELD_IDS.includes(id))

  const packAware = input.installedFieldProperties !== undefined && input.installedFieldProperties !== null
  const installed = normalizeInstalledFieldProperties(input.installedFieldProperties)

  const packPlm = []
  const packHuman = []
  const unclassified = []
  const reasons = []
  const seen = new Set()

  for (const entry of installed) {
    const { fieldId } = entry
    if (!fieldId) {
      reasons.push({ fieldId: '', reason: 'invalid_field_id' })
      continue
    }
    if (seen.has(fieldId)) {
      reasons.push({ fieldId, reason: 'duplicate_field_id' })
      continue
    }
    seen.add(fieldId)

    // The frozen template owns its own columns. An installed property may never move one.
    if (templateIds.has(fieldId)) {
      reasons.push({ fieldId, reason: 'template_governed' })
      continue
    }
    if (!isTenantExtensionField(fieldId)) {
      reasons.push({ fieldId, reason: 'not_extension_namespace' })
      continue
    }
    if (entry.stanzaMalformed) {
      unclassified.push(fieldId)
      reasons.push({ fieldId, reason: 'malformed_property_stanza' })
      continue
    }
    if (!isPlainObject(entry.stanza)) {
      unclassified.push(fieldId)
      reasons.push({ fieldId, reason: 'missing_property_stanza' })
      continue
    }

    const stanza = entry.stanza
    // (1) an explicit pin wins over ownership, in both directions.
    if (stanza.preserveOnRefresh === true) {
      packHuman.push(fieldId)
      reasons.push({ fieldId, reason: 'preserve_on_refresh_pinned' })
      continue
    }
    // (2) declared human -> the wall must now reject it BY NAME.
    if (stanza.ownership === PACK_FIELD_OWNERSHIP_HUMAN) {
      packHuman.push(fieldId)
      reasons.push({ fieldId, reason: 'human_preserved_ownership' })
      continue
    }
    // (3) the ONLY road into the writable band.
    if (stanza.ownership === PACK_FIELD_OWNERSHIP_PLM) {
      if (stanza.extension === true) {
        packPlm.push(fieldId)
        continue
      }
      unclassified.push(fieldId)
      reasons.push({ fieldId, reason: 'missing_extension_stamp' })
      continue
    }
    // (4) fail-closed.
    unclassified.push(fieldId)
    reasons.push({
      fieldId,
      reason: isBlank(stanza.ownership) ? 'missing_ownership' : 'unknown_ownership',
    })
  }

  // Deterministic regardless of the caller's iteration order.
  packPlm.sort()
  packHuman.sort()
  unclassified.sort()
  reasons.sort((left, right) => (left.fieldId === right.fieldId
    ? left.reason.localeCompare(right.reason)
    : left.fieldId.localeCompare(right.fieldId)))

  return {
    plmWritableFieldIds: basePlm.concat(packPlm),
    humanPreservedFieldIds: baseHuman.concat(packHuman),
    packPlmWritableFieldIds: packPlm.slice(),
    packHumanPreservedFieldIds: packHuman.slice(),
    unclassifiedPackFieldIds: unclassified.slice(),
    packAware,
    reasons,
    counts: {
      inspected: installed.length,
      packPlmWritable: packPlm.length,
      packHumanPreserved: packHuman.length,
      unclassified: unclassified.length,
    },
  }
}

// Values-free evidence for the plan summary: ids, frozen reason tokens, counts.
function packAwareOwnershipEvidence(derived) {
  return {
    packPlmWritableFieldIds: derived.packPlmWritableFieldIds.slice(),
    packHumanPreservedFieldIds: derived.packHumanPreservedFieldIds.slice(),
    unclassifiedPackFieldIds: derived.unclassifiedPackFieldIds.slice(),
    counts: { ...derived.counts },
    reasons: derived.reasons.map((entry) => ({ ...entry })),
  }
}

function keyOf(row) {
  return isPlainObject(row) && typeof row.idempotencyKey === 'string' && row.idempotencyKey.trim() !== ''
    ? row.idempotencyKey
    : null
}

function groupByKey(rows) {
  const keyed = new Map()
  const missing = []
  for (const row of rows) {
    const key = keyOf(row)
    if (!key) {
      missing.push(row)
      continue
    }
    const group = keyed.get(key) || []
    group.push(row)
    keyed.set(key, group)
  }
  return { keyed, missing }
}

function comparableValue(value) {
  return value === undefined ? null : value
}

function isPrimitiveComparable(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
}

function valuesEqual(left, right) {
  const normalizedLeft = comparableValue(left)
  const normalizedRight = comparableValue(right)
  if (normalizedLeft === normalizedRight) return true
  if (isPrimitiveComparable(normalizedLeft) && isPrimitiveComparable(normalizedRight)) return false
  return JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight)
}

function normalizeComparableValueForField(value, field) {
  const normalized = comparableValue(value)
  if (normalized === null || !field || !field.type) return normalized
  if (field.type === 'string' || field.type === 'date' || field.type === 'select') {
    if (typeof normalized === 'number' || typeof normalized === 'boolean') return String(normalized)
    return normalized
  }
  if (field.type === 'number') {
    if (typeof normalized === 'number' && Number.isFinite(normalized)) return normalized
    if (typeof normalized === 'string' && normalized.trim()) {
      const parsed = Number(normalized)
      if (Number.isFinite(parsed)) return parsed
    }
    return normalized
  }
  if (field.type === 'boolean') {
    if (typeof normalized === 'boolean') return normalized
    if (typeof normalized === 'string') {
      const lowered = normalized.trim().toLowerCase()
      if (lowered === 'true') return true
      if (lowered === 'false') return false
    }
  }
  return normalized
}

function valuesEqualForTemplateField(left, right, field) {
  return valuesEqual(
    normalizeComparableValueForField(left, field),
    normalizeComparableValueForField(right, field),
  )
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function stableFingerprint(value) {
  return `sha16:${crypto
    .createHash('sha256')
    .update('stock-preparation-duplicate-expanded-key-v1\0')
    .update(String(value))
    .digest('hex')
    .slice(0, 16)}`
}

// ── O1-B identity derivation (pure; see the constant block near the top) ─────

// Scalars are String()-normalised before hashing: the canonical records API can
// hand `depth` back as "2" where the expander produced 2, and an identity that
// flips on that round trip would supersede its own ledger row on every other
// reconcile. Non-scalars go through the key-sorted stringifier.
function anonymousIdentityScalar(value) {
  return value !== null && typeof value === 'object' ? stableStringify(value) : String(value)
}

function anonymousIdentityContext(source, fields) {
  const context = {}
  for (const field of fields) {
    const value = source ? source[field] : undefined
    // isBlank() treats numeric 0 as PRESENT — depth 0 (the BOM root) is a real
    // discriminator and must never be dropped here.
    if (isBlank(value)) continue
    context[field] = anonymousIdentityScalar(value)
  }
  return context
}

function anonymousHoldIdentity(granularity, context) {
  return `${ANONYMOUS_HOLD_IDENTITY_PREFIX}${granularity}:sha256:${crypto
    .createHash('sha256')
    .update(`stock-preparation-anonymous-hold-identity:${granularity}:v1\0`)
    .update(stableStringify(context))
    .digest('hex')
    .slice(0, 32)}`
}

// A keyless expanded/existing row. `undefined` (no identity) when the row
// carries no lineage discriminator at all beyond its project number — that row
// addresses nothing, and a ledger row nothing could ever be matched back to is
// worse than an honest deferral.
function anonymousRowIdentity(conflictType, row, projectNo) {
  const context = anonymousIdentityContext(row, ANONYMOUS_ROW_IDENTITY_FIELDS)
  if (Object.keys(context).length === 0) return undefined
  context.conflictType = conflictType
  if (!isBlank(projectNo)) context.projectNo = anonymousIdentityScalar(projectNo)
  return anonymousHoldIdentity('row', context)
}

// A C2 rowError. Coercion refusals name the mapped CELL they refused (ext
// target x source column x declared type x depth) and get `cell` granularity;
// every other rowError gets `locus` granularity — the (field, depth, relation)
// position, which is genuinely all its emitter attaches. `undefined` when the
// error carries nothing but its type (the unvalidated `c2_row_error` fallback).
function anonymousRowErrorIdentity(conflictType, rowError) {
  const cell = anonymousIdentityContext(rowError, ANONYMOUS_CELL_IDENTITY_FIELDS)
  if (cell.target !== undefined && cell.sourceColumn !== undefined) {
    cell.conflictType = conflictType
    return anonymousHoldIdentity('cell', cell)
  }
  const locus = anonymousIdentityContext(rowError, ANONYMOUS_LOCUS_IDENTITY_FIELDS)
  if (Object.keys(locus).length === 0) return undefined
  locus.conflictType = conflictType
  return anonymousHoldIdentity('locus', locus)
}

function firstPresent(row, fields) {
  for (const field of fields) {
    const value = row && row[field]
    if (!isBlank(value)) return value
  }
  return undefined
}

function stableValue(value) {
  return value === undefined ? null : value
}

function stableKey(value) {
  return stableStringify(stableValue(value))
}

function parentContext(row) {
  return {
    parentSourceId: stableValue(row && row.parentSourceId),
    path: stableValue(row && row.path),
  }
}

function parentContextKey(row) {
  return stableStringify(parentContext(row))
}

function hasParentContext(row) {
  return !isBlank(row && row.parentSourceId) || !isBlank(row && row.path)
}

function allValuesPresent(rows, picker) {
  return rows.every((row) => !isBlank(picker(row)))
}

function distinctCount(rows, picker) {
  return new Set(rows.map((row) => stableKey(picker(row)))).size
}

function groupQuantityShape(rows) {
  if (!allValuesPresent(rows, (row) => row && row.totalQuantity)) return 'unknown'
  return distinctCount(rows, (row) => row.totalQuantity) <= 1 ? 'all_equal' : 'varied'
}

function groupAttributeShape(rows) {
  const fields = ['componentCode', 'componentName', 'material', 'sourceVersion']
  const presentFields = fields.filter((field) => rows.some((row) => !isBlank(row && row[field])))
  if (presentFields.length === 0) return 'unknown'
  return presentFields.every((field) => distinctCount(rows, (row) => row && row[field]) <= 1) ? 'all_equal' : 'varied'
}

function groupParentShape(rows) {
  if (!rows.every(hasParentContext)) return 'unknown'
  return distinctCount(rows, parentContextKey) <= 1 ? 'same_parent' : 'cross_parent'
}

function hasDistinctStableDiscriminator(rows, fields) {
  if (!allValuesPresent(rows, (row) => firstPresent(row, fields))) return false
  return distinctCount(rows, (row) => firstPresent(row, fields)) === rows.length
}

function duplicateExpandedGroupDiagnostic(key, rows, index) {
  const parentShape = groupParentShape(rows)
  const quantityShape = groupQuantityShape(rows)
  const attributeShape = groupAttributeShape(rows)
  const sourceDetail = hasDistinctStableDiscriminator(rows, DUPLICATE_SOURCE_DETAIL_FIELDS)
  const sortLine = hasDistinctStableDiscriminator(rows, DUPLICATE_SORT_LINE_FIELDS)
  const pathParent = parentShape === 'cross_parent'
  return {
    ordinal: index + 1,
    fingerprint: stableFingerprint(key),
    rowCount: rows.length,
    parentShape,
    quantityShape,
    attributeShape,
    stableDiscriminators: {
      sourceDetail,
      pathParent,
      sortLine,
      any: sourceDetail || pathParent || sortLine,
    },
    recommendedDefault: 'hold',
    // Only the policies a client may actually select. `unimplementedPolicies` keeps the refused
    // tokens visible (a stored selection can still name one) without advertising them as choices.
    allowedPolicies: IMPLEMENTED_DUPLICATE_EXPANDED_KEY_POLICIES.slice(),
    unimplementedPolicies: UNIMPLEMENTED_DUPLICATE_EXPANDED_KEY_POLICIES.slice(),
  }
}

function increment(map, key) {
  map.set(key, (map.get(key) || 0) + 1)
}

function sortedDistribution(map, keyName) {
  return Array.from(map.entries())
    .map(([key, count]) => ({ [keyName]: key, groups: count }))
    .sort((left, right) => Number(left[keyName]) - Number(right[keyName]))
}

function shapeCounts(groups, field) {
  const out = {}
  for (const group of groups) out[group[field]] = (out[group[field]] || 0) + 1
  return out
}

function duplicateExpandedKeyDiagnostics(groupedRows) {
  const groups = []
  const distribution = new Map()
  for (const [key, rows] of groupedRows.entries()) {
    if (rows.length <= 1) continue
    increment(distribution, rows.length)
    groups.push(duplicateExpandedGroupDiagnostic(key, rows, groups.length))
  }
  if (groups.length === 0) return undefined
  return {
    conflictType: 'duplicate_expanded_key',
    groupCount: groups.length,
    rowCount: groups.reduce((sum, group) => sum + group.rowCount, 0),
    rowsPerGroup: sortedDistribution(distribution, 'rowCount'),
    parentShapeCounts: shapeCounts(groups, 'parentShape'),
    quantityShapeCounts: shapeCounts(groups, 'quantityShape'),
    attributeShapeCounts: shapeCounts(groups, 'attributeShape'),
    stableDiscriminatorCounts: {
      any: groups.filter((group) => group.stableDiscriminators.any).length,
      sourceDetail: groups.filter((group) => group.stableDiscriminators.sourceDetail).length,
      pathParent: groups.filter((group) => group.stableDiscriminators.pathParent).length,
      sortLine: groups.filter((group) => group.stableDiscriminators.sortLine).length,
    },
    defaultPolicy: 'hold',
    // Only the policies a client may actually select (this is the list the workbench dropdown is
    // built from). `unimplementedPolicies` keeps the refused tokens visible without offering them.
    allowedPolicies: IMPLEMENTED_DUPLICATE_EXPANDED_KEY_POLICIES.slice(),
    unimplementedPolicies: UNIMPLEMENTED_DUPLICATE_EXPANDED_KEY_POLICIES.slice(),
    groups,
  }
}

function duplicateExpandedKeyDiagnosticsForRows(rows) {
  return duplicateExpandedKeyDiagnostics(groupByKey(normalizeRows(rows, 'expandedRows')).keyed)
}

function duplicatePolicySelections(review) {
  const selections = new Map()
  const rows = isPlainObject(review) && Array.isArray(review.selectedPolicies)
    ? review.selectedPolicies
    : []
  for (const row of rows) {
    if (!isPlainObject(row)) continue
    if (typeof row.fingerprint !== 'string' || typeof row.policy !== 'string') continue
    selections.set(row.fingerprint, {
      policy: row.policy,
      scope: typeof row.scope === 'string' ? row.scope : 'default',
    })
  }
  return selections
}

function heldReasonForDuplicatePolicy(policy) {
  if (policy === 'hold') return 'default_hold'
  if (policy === 'source_correction_required') return 'source_correction_required'
  return DUPLICATE_EXPANDED_KEY_UNSUPPORTED_HELD_REASON
}

// DERIVED FROM BEHAVIOUR, not hand-copied. A policy counts as implemented iff the planner does
// something NAMED with it: either it reaches resolution (keep_multiple_rows) or it holds under its
// own named reason. Anything that falls through to the catch-all `unsupported_policy` reason is,
// by definition, inert. This derivation is fail-closed: a token added to the frozen vocabulary
// without planner handling is automatically NOT selectable, and a future slice that implements one
// of the three inert strategies makes it selectable only by giving it real behaviour here.
const IMPLEMENTED_DUPLICATE_EXPANDED_KEY_POLICIES = Object.freeze(
  DUPLICATE_EXPANDED_KEY_POLICIES.filter((policy) => (
    policy === DUPLICATE_EXPANDED_KEY_RESOLVING_POLICY
    || heldReasonForDuplicatePolicy(policy) !== DUPLICATE_EXPANDED_KEY_UNSUPPORTED_HELD_REASON
  )),
)

// merge_quantity / select_representative / skip_selected. Unimplemented BY DECISION, not by
// oversight: each destroys or alters a business quantity (sum / discard / drop) and in a
// materials-requirement context a wrong quantity is a wrong requirement. Implementing them needs a
// design lock, an audit trail and reversibility — a separate owner decision. They stay in the
// frozen vocabulary so stored selections keep loading; they are refused at the selection boundary
// so the refusal lands on the operator who chose one instead of surfacing later as a silent hold.
const UNIMPLEMENTED_DUPLICATE_EXPANDED_KEY_POLICIES = Object.freeze(
  DUPLICATE_EXPANDED_KEY_POLICIES.filter((policy) => !IMPLEMENTED_DUPLICATE_EXPANDED_KEY_POLICIES.includes(policy)),
)

function duplicateGroupDiscriminator(rows) {
  if (hasDistinctStableDiscriminator(rows, DUPLICATE_SOURCE_DETAIL_FIELDS)) {
    return {
      kind: 'sourceDetail',
      valueForRow: (row) => firstPresent(row, DUPLICATE_SOURCE_DETAIL_FIELDS),
    }
  }
  if (rows.every(hasParentContext) && distinctCount(rows, parentContextKey) === rows.length) {
    return {
      kind: 'pathParent',
      valueForRow: parentContext,
    }
  }
  if (hasDistinctStableDiscriminator(rows, DUPLICATE_SORT_LINE_FIELDS)) {
    return {
      kind: 'sortLine',
      valueForRow: (row) => firstPresent(row, DUPLICATE_SORT_LINE_FIELDS),
    }
  }
  return null
}

function duplicateResolvedKey(baseKey, groupFingerprint, discriminatorKind, discriminatorValue) {
  const discriminatorHash = stableFingerprint(`${groupFingerprint}\0${discriminatorKind}\0${stableStringify(stableValue(discriminatorValue))}`)
  return `${baseKey}::duplicate:${discriminatorKind}:${discriminatorHash}`
}

function emptyDuplicateResolutionSummary() {
  return {
    conflictType: 'duplicate_expanded_key',
    resolvedPolicy: DUPLICATE_EXPANDED_KEY_RESOLVING_POLICY,
    resolvedGroupCount: 0,
    resolvedRowCount: 0,
    heldGroupCount: 0,
    heldRowCount: 0,
    tableScopeResolvedGroupCount: 0,
    runOnlyResolvedGroupCount: 0,
    heldReasonCounts: {},
    resolvedPolicies: [],
    heldPolicies: [],
  }
}

function addHeldDuplicateResolution(summary, { fingerprint, rows, policy, scope, reason }) {
  summary.heldGroupCount += 1
  summary.heldRowCount += rows.length
  summary.heldReasonCounts[reason] = (summary.heldReasonCounts[reason] || 0) + 1
  summary.heldPolicies.push({
    fingerprint,
    policy,
    scope,
    reason,
    rowCount: rows.length,
  })
}

function addResolvedDuplicateResolution(summary, { fingerprint, rows, policy, scope, discriminatorKind }) {
  summary.resolvedGroupCount += 1
  summary.resolvedRowCount += rows.length
  if (scope === 'table_scope') summary.tableScopeResolvedGroupCount += 1
  if (scope === 'run_only') summary.runOnlyResolvedGroupCount += 1
  summary.resolvedPolicies.push({
    fingerprint,
    policy,
    scope,
    discriminator: discriminatorKind,
    rowCount: rows.length,
    writeEffect: 'add_decisions',
  })
}

function compactDuplicateResolutionSummary(summary) {
  if (!summary || (summary.resolvedGroupCount === 0 && summary.heldGroupCount === 0)) return undefined
  const out = {
    conflictType: summary.conflictType,
    resolvedPolicy: summary.resolvedPolicy,
    resolvedGroupCount: summary.resolvedGroupCount,
    resolvedRowCount: summary.resolvedRowCount,
    heldGroupCount: summary.heldGroupCount,
    heldRowCount: summary.heldRowCount,
    tableScopeResolvedGroupCount: summary.tableScopeResolvedGroupCount,
    runOnlyResolvedGroupCount: summary.runOnlyResolvedGroupCount,
    heldReasonCounts: { ...summary.heldReasonCounts },
  }
  if (summary.resolvedPolicies.length) out.resolvedPolicies = summary.resolvedPolicies.map((row) => ({ ...row }))
  if (summary.heldPolicies.length) out.heldPolicies = summary.heldPolicies.map((row) => ({ ...row }))
  return out
}

function resolveDuplicateExpandedRows({ expandedKeyed, existingKeyed, duplicatePolicyReview }) {
  const selections = duplicatePolicySelections(duplicatePolicyReview)
  const keyed = new Map()
  const duplicateExpandedKeys = new Set()
  const resolution = emptyDuplicateResolutionSummary()

  for (const [key, rows] of expandedKeyed.entries()) {
    if (rows.length <= 1) {
      keyed.set(key, rows)
      continue
    }

    const fingerprint = stableFingerprint(key)
    const selected = selections.get(fingerprint) || { policy: 'hold', scope: 'default' }
    if (selected.policy !== DUPLICATE_EXPANDED_KEY_RESOLVING_POLICY) {
      duplicateExpandedKeys.add(key)
      addHeldDuplicateResolution(resolution, {
        fingerprint,
        rows,
        policy: selected.policy,
        scope: selected.scope,
        reason: heldReasonForDuplicatePolicy(selected.policy),
      })
      continue
    }

    if (existingKeyed.has(key)) {
      duplicateExpandedKeys.add(key)
      addHeldDuplicateResolution(resolution, {
        fingerprint,
        rows,
        policy: selected.policy,
        scope: selected.scope,
        reason: 'clean_to_collision_requires_review',
      })
      continue
    }

    const discriminator = duplicateGroupDiscriminator(rows)
    if (!discriminator) {
      duplicateExpandedKeys.add(key)
      addHeldDuplicateResolution(resolution, {
        fingerprint,
        rows,
        policy: selected.policy,
        scope: selected.scope,
        reason: 'missing_stable_discriminator',
      })
      continue
    }

    const resolvedRows = rows.map((row) => {
      const discriminatorValue = discriminator.valueForRow(row)
      const resolvedKey = duplicateResolvedKey(key, fingerprint, discriminator.kind, discriminatorValue)
      return { ...row, idempotencyKey: resolvedKey }
    })
    const uniqueResolvedKeys = new Set(resolvedRows.map((row) => row.idempotencyKey))
    if (uniqueResolvedKeys.size !== rows.length) {
      duplicateExpandedKeys.add(key)
      addHeldDuplicateResolution(resolution, {
        fingerprint,
        rows,
        policy: selected.policy,
        scope: selected.scope,
        reason: 'non_unique_resolved_key',
      })
      continue
    }

    for (const row of resolvedRows) keyed.set(row.idempotencyKey, [row])
    addResolvedDuplicateResolution(resolution, {
      fingerprint,
      rows,
      policy: selected.policy,
      scope: selected.scope,
      discriminatorKind: discriminator.kind,
    })
  }

  return {
    keyed,
    duplicateExpandedKeys,
    resolution: compactDuplicateResolutionSummary(resolution),
  }
}

function changedFields(nextRow, existingRow, fields, templateFields = new Map()) {
  return fields.filter((field) => !valuesEqualForTemplateField(nextRow[field], existingRow[field], templateFields.get(field)))
}

function pickFields(row, fields) {
  const out = {}
  for (const field of fields) {
    if (row[field] !== undefined) out[field] = row[field]
  }
  return out
}

function assertNoHumanFields(payload, humanFields, context) {
  for (const field of humanFields) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      throw new StockPreparationConflictPlannerError(`${context} must not include human-preserved field ${field}`, {
        field,
        context,
      })
    }
  }
}

function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  const leftSet = new Set(left)
  if (leftSet.size !== left.length) return false
  const rightSet = new Set(right)
  if (rightSet.size !== right.length) return false
  return right.every((value) => leftSet.has(value))
}

function runPatch(runId, plannedAt, decision, conflictSummary = '') {
  return {
    lastPlmRefreshRunId: runId,
    lastPlmRefreshAt: plannedAt,
    lastPlmRefreshDecision: decision,
    lastPlmConflictSummary: conflictSummary,
  }
}

function makeConflictSummary(type, details = {}) {
  const out = { type }
  for (const [key, value] of Object.entries(details)) {
    if (value !== undefined && value !== null && value !== '') out[key] = value
  }
  return out
}

function addDecision(decisions, counts, decision) {
  decisions.push(decision)
  counts[decision.decision] += 1
}

function manualConfirm(decisions, counts, input) {
  const decision = {
    decision: DECISIONS.MANUAL_CONFIRM,
    idempotencyKey: input.idempotencyKey,
    conflictSummary: makeConflictSummary(input.type, input.details),
    changedFields: Array.isArray(input.changedFields) ? input.changedFields.slice() : [],
    source: input.source || 'planner',
  }
  // O1-B. The reserved namespace is enforced HERE too, not only at the ledger:
  // a keyed hold whose key looks like a derived anonymous identity would let a
  // forged plan claim a ledger row that belongs to a different addressing
  // scheme. Fail closed rather than key it.
  if (typeof decision.idempotencyKey === 'string' && decision.idempotencyKey.startsWith(ANONYMOUS_HOLD_IDENTITY_PREFIX)) {
    throw new StockPreparationConflictPlannerError('idempotencyKey must not use the reserved anonymous-hold identity namespace', {
      field: 'idempotencyKey',
    })
  }
  // Added LAST and only when present, so every keyed hold's decision object is
  // byte-identical to the pre-O1-B one.
  if (input.derivedRowIdentity) decision.derivedRowIdentity = input.derivedRowIdentity
  addDecision(decisions, counts, decision)
}

function makeAddDecision(row, runId, plannedAt, plmFields, humanFields) {
  const record = {
    ...pickFields(row, plmFields),
    ...runPatch(runId, plannedAt, DECISIONS.ADD),
  }
  assertNoHumanFields(record, humanFields, 'add record')
  return {
    decision: DECISIONS.ADD,
    idempotencyKey: row.idempotencyKey,
    record,
    conflictSummary: makeConflictSummary('add_missing'),
  }
}

function makeUpdateDecision(row, existing, runId, plannedAt, plmFields, humanFields, changed) {
  const patch = {
    ...pickFields(row, plmFields),
    ...runPatch(runId, plannedAt, DECISIONS.UPDATE, JSON.stringify({ type: 'plm_system_refresh', changedFields: changed })),
  }
  assertNoHumanFields(patch, humanFields, 'update patch')
  return {
    decision: DECISIONS.UPDATE,
    idempotencyKey: row.idempotencyKey,
    patch,
    changedFields: changed,
    conflictSummary: makeConflictSummary('plm_system_refresh', { changedFieldCount: changed.length }),
  }
}

function makeSkipDecision(row) {
  return {
    decision: DECISIONS.SKIP,
    idempotencyKey: row.idempotencyKey,
    conflictSummary: makeConflictSummary('unchanged'),
  }
}

function makeInactiveDecision(existing, runId, plannedAt, humanFields) {
  const patch = {
    active: false,
    ...runPatch(runId, plannedAt, DECISIONS.INACTIVE, JSON.stringify({ type: 'missing_from_plm' })),
  }
  assertNoHumanFields(patch, humanFields, 'inactive patch')
  return {
    decision: DECISIONS.INACTIVE,
    idempotencyKey: existing.idempotencyKey,
    patch,
    conflictSummary: makeConflictSummary('missing_from_plm'),
  }
}

function planStockPreparationConflicts(input = {}) {
  const template = normalizeTemplate(input.template)
  const strategy = normalizeStrategy(template, input.conflictStrategy)
  const runId = normalizeRunId(input.runId)
  const plannedAt = normalizeIsoTime(input.plannedAt)
  const expandedRows = normalizeRows(input.expandedRows, 'expandedRows')
  const existingRows = normalizeRows(input.existingRows, 'existingRows')
  const rowErrors = normalizeRows(input.rowErrors, 'rowErrors')

  const templateHumanFields = fieldIdsByOwnership(template, 'human_preserved')
  if (!sameStringSet(HUMAN_PRESERVED_FIELD_IDS.slice(), templateHumanFields)) {
    throw new StockPreparationConflictPlannerError('human field whitelist drifted from template', {
      field: 'template.fields',
    })
  }
  // Pack-aware bands. With no installedFieldProperties this returns exactly the
  // template-derived sets, in template order — the pre-pack behaviour, unchanged.
  const ownership = derivePackAwarePlmWritableFields({
    templateFields: template.fields,
    installedFieldProperties: input.installedFieldProperties,
  })
  const humanFields = ownership.humanPreservedFieldIds
  const plmFields = ownership.plmWritableFieldIds
  const templateFields = fieldMapForTemplate(template)
  const counts = {
    [DECISIONS.ADD]: 0,
    [DECISIONS.UPDATE]: 0,
    [DECISIONS.SKIP]: 0,
    [DECISIONS.INACTIVE]: 0,
    [DECISIONS.MANUAL_CONFIRM]: 0,
  }
  const decisions = []

  const expanded = groupByKey(expandedRows)
  const existing = groupByKey(existingRows)
  const resolvedExpanded = resolveDuplicateExpandedRows({
    expandedKeyed: expanded.keyed,
    existingKeyed: existing.keyed,
    duplicatePolicyReview: input.duplicatePolicyReview,
  })

  // O1-B: the three ANONYMOUS emitters. Each hold now carries a derived,
  // values-free identity when its row/error offers one — the loop variables
  // used to be discarded outright, which is exactly why these classes could
  // never be ledgered. `details` and `conflictSummary` are UNCHANGED: the
  // identity rides beside them so no existing fingerprint moves.
  for (const row of expanded.missing) {
    manualConfirm(decisions, counts, {
      type: 'missing_expanded_idempotency_key',
      source: 'expanded_row',
      derivedRowIdentity: anonymousRowIdentity('missing_expanded_idempotency_key', row, row.projectNo),
    })
  }
  for (const row of existing.missing) {
    manualConfirm(decisions, counts, {
      type: 'missing_existing_idempotency_key',
      source: 'existing_row',
      derivedRowIdentity: anonymousRowIdentity('missing_existing_idempotency_key', row, row.projectNo),
    })
  }
  for (const rowError of rowErrors) {
    const rowErrorType = rowError.type || 'c2_row_error'
    manualConfirm(decisions, counts, {
      type: rowErrorType,
      source: 'c2_row_error',
      details: {
        field: rowError.field,
        depth: rowError.depth,
        relation: rowError.relation,
      },
      derivedRowIdentity: anonymousRowErrorIdentity(rowErrorType, rowError),
    })
  }

  const duplicateExpandedKeys = resolvedExpanded.duplicateExpandedKeys
  for (const key of duplicateExpandedKeys) {
    const rows = expanded.keyed.get(key) || []
    if (rows.length > 1) {
      manualConfirm(decisions, counts, {
        idempotencyKey: key,
        type: 'duplicate_expanded_key',
        source: 'expanded_rows',
        details: { count: rows.length },
      })
    }
  }
  const duplicateExistingKeys = new Set()
  for (const [key, rows] of existing.keyed.entries()) {
    if (rows.length > 1) {
      duplicateExistingKeys.add(key)
      manualConfirm(decisions, counts, {
        idempotencyKey: key,
        type: 'duplicate_existing_key',
        source: 'existing_rows',
        details: { count: rows.length },
      })
    }
  }

  for (const [key, rows] of resolvedExpanded.keyed.entries()) {
    if (duplicateExpandedKeys.has(key) || duplicateExistingKeys.has(key)) continue
    const row = rows[0]
    const existingGroup = existing.keyed.get(key)
    const existingRow = existingGroup && existingGroup[0]
    if (!existingRow) {
      if (strategy.addMissing) {
        addDecision(decisions, counts, makeAddDecision(row, runId, plannedAt, plmFields, humanFields))
      } else {
        manualConfirm(decisions, counts, {
          idempotencyKey: key,
          type: 'add_missing_disabled',
          source: 'conflict_strategy',
        })
      }
      continue
    }

    const lineageChanges = changedFields(row, existingRow, LINEAGE_FIELD_IDS, templateFields)
    if (lineageChanges.length > 0) {
      manualConfirm(decisions, counts, {
        idempotencyKey: key,
        type: 'lineage_mismatch',
        source: 'existing_row',
        changedFields: lineageChanges,
        details: { changedFieldCount: lineageChanges.length },
      })
      continue
    }

    const identityChanges = changedFields(row, existingRow, IDENTITY_FIELD_IDS, templateFields)
    if (identityChanges.length > 0) {
      manualConfirm(decisions, counts, {
        idempotencyKey: key,
        type: 'component_identity_conflict',
        source: 'existing_row',
        changedFields: identityChanges,
        details: { changedFieldCount: identityChanges.length },
      })
      continue
    }

    const refreshChanges = strategy.refreshPlmSystemFields ? changedFields(row, existingRow, plmFields, templateFields) : []
    if (refreshChanges.length === 0) {
      addDecision(decisions, counts, makeSkipDecision(row))
      continue
    }
    addDecision(decisions, counts, makeUpdateDecision(row, existingRow, runId, plannedAt, plmFields, humanFields, refreshChanges))
  }

  for (const [key, rows] of existing.keyed.entries()) {
    if (expanded.keyed.has(key) || resolvedExpanded.keyed.has(key) || duplicateExistingKeys.has(key)) continue
    const existingRow = rows[0]
    if (existingRow.active === false) {
      addDecision(decisions, counts, {
        decision: DECISIONS.SKIP,
        idempotencyKey: key,
        conflictSummary: makeConflictSummary('already_inactive'),
      })
      continue
    }
    addDecision(decisions, counts, makeInactiveDecision(existingRow, runId, plannedAt, humanFields))
  }

  // The key is ADDED ONLY when the caller supplied installed properties, so a
  // legacy (pack-unaware) call still produces a byte-identical plan object.
  const packAwareOwnership = ownership.packAware ? packAwareOwnershipEvidence(ownership) : undefined

  return {
    valid: counts[DECISIONS.MANUAL_CONFIRM] === 0,
    runId,
    plannedAt,
    decisions,
    counts,
    summary: {
      runIdPresent: !isBlank(runId),
      plannedAtPresent: !isBlank(plannedAt),
      counts: { ...counts },
      expandedRows: expandedRows.length,
      existingRows: existingRows.length,
      rowErrors: rowErrors.length,
      humanPreservedFields: humanFields.slice(),
      plmSystemFields: plmFields.slice(),
      conflictTypes: Array.from(new Set(decisions.map((decision) => decision.conflictSummary && decision.conflictSummary.type).filter(Boolean))).sort(),
      duplicateExpandedKeyDiagnostics: duplicateExpandedKeyDiagnostics(expanded.keyed),
      duplicateExpandedKeyResolution: resolvedExpanded.resolution,
      ...(packAwareOwnership ? { packAwareOwnership } : {}),
    },
  }
}

function summarizeConflictPlanForEvidence(plan = {}) {
  const summary = isPlainObject(plan.summary) ? plan.summary : {}
  return {
    valid: plan.valid === true,
    runIdPresent: summary.runIdPresent === true,
    plannedAtPresent: summary.plannedAtPresent === true,
    counts: isPlainObject(summary.counts) ? { ...summary.counts } : {},
    expandedRows: Number(summary.expandedRows || 0),
    existingRows: Number(summary.existingRows || 0),
    rowErrors: Number(summary.rowErrors || 0),
    humanPreservedFields: Array.isArray(summary.humanPreservedFields) ? summary.humanPreservedFields.slice() : [],
    plmSystemFields: Array.isArray(summary.plmSystemFields) ? summary.plmSystemFields.slice() : [],
    conflictTypes: Array.isArray(summary.conflictTypes) ? summary.conflictTypes.slice() : [],
    duplicateExpandedKeyDiagnostics: isPlainObject(summary.duplicateExpandedKeyDiagnostics)
      ? JSON.parse(JSON.stringify(summary.duplicateExpandedKeyDiagnostics))
      : undefined,
    duplicateExpandedKeyResolution: isPlainObject(summary.duplicateExpandedKeyResolution)
      ? JSON.parse(JSON.stringify(summary.duplicateExpandedKeyResolution))
      : undefined,
    packAwareOwnership: isPlainObject(summary.packAwareOwnership)
      ? JSON.parse(JSON.stringify(summary.packAwareOwnership))
      : undefined,
  }
}

module.exports = {
  DECISIONS,
  RUN_FIELD_IDS,
  LINEAGE_FIELD_IDS,
  IDENTITY_FIELD_IDS,
  ANONYMOUS_HOLD_IDENTITY_PREFIX,
  DUPLICATE_EXPANDED_KEY_POLICIES,
  DUPLICATE_EXPANDED_KEY_RESOLVING_POLICY,
  DUPLICATE_EXPANDED_KEY_UNSUPPORTED_HELD_REASON,
  IMPLEMENTED_DUPLICATE_EXPANDED_KEY_POLICIES,
  UNIMPLEMENTED_DUPLICATE_EXPANDED_KEY_POLICIES,
  PACK_FIELD_OWNERSHIP_REASONS,
  StockPreparationConflictPlannerError,
  derivePackAwarePlmWritableFields,
  duplicateExpandedKeyDiagnosticsForRows,
  planStockPreparationConflicts,
  summarizeConflictPlanForEvidence,
  __internals: {
    anonymousHoldIdentity,
    anonymousRowErrorIdentity,
    anonymousRowIdentity,
    assertNoHumanFields,
    changedFields,
    normalizeInstalledFieldProperties,
    packAwareOwnershipEvidence,
    pickFields,
    heldReasonForDuplicatePolicy,
    duplicateExpandedKeyDiagnosticsForRows,
    duplicateGroupDiscriminator,
    duplicateResolvedKey,
    fieldMapForTemplate,
    groupByKey,
    normalizeStrategy,
    normalizeIsoTime,
    normalizeComparableValueForField,
    plmRefreshFieldIds,
    sameStringSet,
    stableFingerprint,
    valuesEqual,
    valuesEqualForTemplateField,
  },
}
