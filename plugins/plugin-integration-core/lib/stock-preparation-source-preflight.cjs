'use strict'

// 源就绪预检 + 拓扑自测 — STOCK-PREPARATION **SOURCE** PREFLIGHT.
//
// Sibling, not duplicate, of stock-preparation-preflight.cjs. That module asks "is THIS DEPLOYMENT
// ready" (managed tables, packs, env allowlists — everything on OUR side of the wire). This one asks
// the other half, the half nothing answered before: **is the CUSTOMER'S SOURCE ready, and what SHAPE
// is it actually in.**
//
// ===========================================================================
// WHY THIS EXISTS — two failures on one live customer session
// ===========================================================================
//
//   INCIDENT A — THE ASSUMED BRIDGE. The shipped read plan
//   (PLM_STOCK_PREPARATION_BOM_READ_PLAN) reaches a project's top-level components through the ORDER
//   MODULE: pathExAttr -> pathInfo -> orderHead -> orderDetail. That is one deployment's topology,
//   not the family's. The customer catalog we met had ONE order-head row in total and carried its
//   real BOM somewhere else entirely. The expansion therefore returned ZERO rows — and reported that
//   as a successful run over an empty project, because "no rows" and "wrong bridge" are the same
//   observation to a plan that cannot question its own assumption.
//
//   INCIDENT B — THE EMPTY CATALOG. An implementer spent a long sequence of steps against a test
//   catalog that had no business rows in it at all, and only discovered it downstream. Nothing had
//   ever asked "does this source contain a project number and a BOM line".
//
// Both failures share one root cause: the system ASSUMED the source's shape instead of MEASURING it.
// So this module measures, and it reports what it measured, including when the measurement disagrees
// with what the deployment is configured for.
//
// ===========================================================================
// WHAT IT MEASURES (and what "measure" means here)
// ===========================================================================
//
// Every finding below comes from BOUNDED, UNFILTERED, READ-ONLY reads through the SAME source-adapter
// seam the BOM expansion itself uses (`adapter.read({ object, limit })` -> `{ records }`). There is no
// second connection path, no catalog/DDL privilege, no COUNT(*), and no SQL of our own: a source that
// the expansion can read, this can probe, and a source it cannot, this refuses the same way.
//
//   1. REACHABLE          — did any probe read succeed at all, and if not, WHY (a closed error
//                           vocabulary; never the driver's message, which carries hosts and logins).
//   2. HAS PROJECT DATA   — does the project-number entry table carry rows with a non-empty match
//                           value; and where the family's node-type column exists, how many of the
//                           sampled rows are project nodes (NodeType = 2).
//   3. HAS BOM DATA       — are the BOM head/detail tables non-empty.
//   4. TOPOLOGY / BRIDGE  — order-module vs design-bom, decided by MEASURED line volume on each
//                           candidate (see BRIDGE_DOMINANCE_RATIO and `decideBridge`). This is
//                           INCIDENT A's detector.
//   5. QUANTITY SLOT      — which generic ExAttr slot actually holds the BOM line quantity, from two
//                           independent readings: the customer's own slot DICTIONARY (decoded through
//                           the vendor preset's dictionary contract) and the MEASURED numeric density
//                           of each slot column on the BOM-carrying table.
//   6. PRESET MATCH       — which vendor preset this source is, BY TABLE SIGNATURE (never by company
//                           name), via the catalog's own `selectVendorPreset`.
//   7. PLAN ALIGNMENT     — the self-validating hook: the configured read plan's assumed bridge and
//                           quantity field, checked AGAINST 4 and 5. A mismatch is a BLOCKER whose
//                           text says the thing INCIDENT A never said out loud: "configured for the
//                           order module, but this source is DesignBom-shaped — the expansion will
//                           return 0 rows."
//
// ===========================================================================
// VALUES-FREE AT THE BOUNDARY
// ===========================================================================
//
// The report carries SHAPES, COUNTS and COLUMN ROLES: table names, column names, slot names, preset
// ids, integers, booleans, and codes from closed vocabularies. It carries NO credential, NO host, NO
// driver message, NO dictionary label text, and NO bulk business values.
//
// The single deliberate exception is LIVENESS EVIDENCE: at most LIVENESS_SAMPLE_MAX (2) short values
// from the project-number column, so an implementer can see the source is genuinely populated rather
// than take a count on faith. Each one is length-capped, and each is run through the preset schema's
// own `findValueShapeViolation` — the same connection-string / URL / IP / hostname / credential
// detector the preset validator uses — and DROPPED if it looks like anything but a project number.
// Two short project numbers are not a dump; two hundred rows would be, which is why the cap is a
// constant and not a parameter.
//
// `assertSourcePreflightValuesFree` is the independent second check, in the H0 spirit of
// scripts/ops/source-discovery-probe.mjs: it walks EVERY string leaf of the finished report and
// refuses any leaf that reproduces an observed row value or a supplied secret, except at the
// allow-listed liveness paths. It never echoes the offending value.
//
// ===========================================================================
// READ-ONLY BY CONSTRUCTION
// ===========================================================================
//
// The only capability this module is handed is `readObject`. It cannot write, provision, ensure or
// install, because it holds nothing that could. Reads are unfiltered but LIMIT-bounded at
// SOURCE_PREFLIGHT_ROW_CAP, and the object roster is finite and derived from the configured plan plus
// the declared bridge candidates — a request cannot name an object to read.
//
// ===========================================================================
// WHAT IS REUSED, AND WHAT IS NEW
// ===========================================================================
//
// REUSED verbatim from the already-shipped vendor-preset catalog
// (lib/source-vendor-presets/preset-schema.cjs, #5385 + the dn-pdm topology backfill):
//   `loadVendorPresetsFromDir`  — the catalog, unchanged, unextended
//   `selectVendorPreset`        — identity BY TABLE SIGNATURE, fail-closed on ambiguity
//   `evaluatePresetMatch`       — matched/missing signature tables for the report
//   `isFamilyColumn` / `familyColumnMatcher` — the generic-slot family membership test, which is what
//                                 makes `bom_exattr1` recognizable as slot 1 of the `Bom_ExAttr`
//                                 family without hardcoding one customer's column
//   `isEnabledFlagValue`        — the MEASURED dictionary polarity (nonzero-means-enabled), so the
//                                 slot decode reads enabled rows the way the live catalog meant them
//   `LABEL_HINT_VOCABULARY`     — the quantity/unit/material-code label regexes, CJK included
//   `findValueShapeViolation`   — the credential/host shape detector, reused as the liveness filter
//   `normalizeTableName`        — schema-qualified + case-folded table identity
//
// REUSED from the read plan: `PLM_STOCK_PREPARATION_BOM_READ_PLAN` and
// `normalizeStockPreparationBomReadPlan` — the probe roster and the alignment check both come from
// the plan the deployment ACTUALLY runs, so an overridden plan is probed as overridden.
//
// NEW here (the knowledge the live session produced, which existed nowhere in the repo):
//   - the DesignBom bridge candidate as a MEASURABLE alternative topology,
//   - the volume-dominance rule that decides between bridges from counts rather than belief,
//   - the two-reading quantity-slot detection and its agreement test,
//   - the plan-alignment blocker that turns INCIDENT A from a silent zero into a loud refusal.
//
// The vendor preset itself is deliberately NOT edited. `DN_PDM_DesignBom` is a TOPOLOGY VARIANT this
// family exhibits, not part of its identity signature: a catalog with it still clears the 6-of-11
// signature floor, so adding it would change nothing about selection while re-pinning a validated,
// measured artifact. Bridge variance belongs where it is measured — here.

const path = require('node:path')

const {
  PLM_STOCK_PREPARATION_BOM_READ_PLAN,
  normalizeStockPreparationBomReadPlan,
} = require('./stock-preparation-bom-expansion.cjs')
const {
  LABEL_HINT_VOCABULARY,
  evaluatePresetMatch,
  findValueShapeViolation,
  isEnabledFlagValue,
  isFamilyColumn,
  loadVendorPresetsFromDir,
  normalizeTableName,
  selectVendorPreset,
} = require('./source-vendor-presets/preset-schema.cjs')

const SOURCE_PREFLIGHT_ROUTE_PATH = '/api/integration/stock-preparation/source-preflight'

// ---------------------------------------------------------------------------
// Bounds. Every one of these is a CONSTANT and never a request input: a probe whose depth the caller
// chooses is a bulk-read surface wearing a preflight's name.
// ---------------------------------------------------------------------------

// Rows requested per probed object. Large enough that "1 order head" and "thousands of BOM lines"
// separate decisively; small enough that the whole preflight is a handful of small reads.
const SOURCE_PREFLIGHT_ROW_CAP = 200
// Liveness evidence: at most this many short values, from the project-number column only.
const LIVENESS_SAMPLE_MAX = 2
const LIVENESS_SAMPLE_MAX_LENGTH = 48
// One candidate's line volume must exceed the other's by this factor before it is called the bridge.
// Below it, with both sides populated, the answer is "a human must decide" — not a coin toss.
const BRIDGE_DOMINANCE_RATIO = 4
// A bridge candidate with fewer sampled lines than this is not evidence of a working bridge. The live
// incident's order module had exactly one head row and no usable lines; a floor of 1 would have called
// that a bridge.
const BRIDGE_MIN_LINES = 2
// IDENTITY PROBES. The read plan names seven objects; a vendor preset's signature names more (the
// slot-dictionary tables among them). Asking only about the plan's seven would report every
// dictionary table as "missing from the signature" when nobody ever asked about it — a report that
// reads like drift and is really an artifact of the question. So the roster is topped up with any
// signature table the catalog names that the plan does not, bounded by this cap so a large catalog
// cannot turn one preflight into a hundred reads.
const IDENTITY_PROBE_MAX = 16
// A slot column counts as the quantity carrier only if this share of its non-empty sampled values
// parse as finite non-negative numbers.
const QUANTITY_NUMERIC_DENSITY_FLOOR = 0.8
// Below this many non-empty sampled values a density ratio is noise, not a measurement.
const QUANTITY_MIN_OBSERVATIONS = 3
// The family's project node type, from the live session: a project number entry sits on a NodeType = 2
// node. Declared here rather than in the vendor preset because it is a per-catalog convention the
// probe VERIFIES (it reports how many sampled rows carry it, and says so when the column is absent)
// rather than one the preset may assert on every deployment's behalf.
const PROJECT_NODE_TYPE = 2

// The alternative top-level BOM bridge measured on a live customer catalog: the project's design BOM
// lives in its own table rather than behind the order module. Declared as a candidate ROSTER (spelling
// variants included) because the probe tests presence by reading, and a table that is not there simply
// reports absent.
const DESIGN_BOM_BRIDGE_OBJECTS = Object.freeze([
  'DN_PDM_DesignBom',
  'DN_PDM_DesignBomInfo',
])

const BRIDGES = Object.freeze({
  ORDER_MODULE: 'order-module',
  DESIGN_BOM: 'design-bom',
  AMBIGUOUS: 'ambiguous',
  NONE: 'none',
  UNKNOWN: 'unknown',
})
const SOURCE_PREFLIGHT_BRIDGES = Object.freeze(Object.values(BRIDGES))

// Closed read-failure vocabulary. A driver's message names hosts, ports, databases and logins; none of
// it may reach a report, so every failure collapses into one of these codes and the message is dropped
// at the point of classification — not filtered later.
const READ_ERROR_CODES = Object.freeze({
  OBJECT_MISSING: 'object_missing',
  PERMISSION_DENIED: 'permission_denied',
  AUTH_REFUSED: 'auth_refused',
  UNREACHABLE: 'unreachable',
  TIMEOUT: 'timeout',
  UNKNOWN: 'unknown_error',
})
const SOURCE_PREFLIGHT_READ_ERROR_CODES = Object.freeze(Object.values(READ_ERROR_CODES))

// A failure of these kinds means the SOURCE could not be talked to at all, as opposed to a named
// object being absent from a source we did reach.
const CONNECTIVITY_ERROR_CODES = Object.freeze([
  READ_ERROR_CODES.UNREACHABLE,
  READ_ERROR_CODES.AUTH_REFUSED,
  READ_ERROR_CODES.TIMEOUT,
])

const SOURCE_PREFLIGHT_BLOCKER_CODES = Object.freeze({
  SOURCE_UNREACHABLE: 'source_unreachable',
  ENTRY_TABLE_MISSING: 'entry_table_missing',
  NO_PROJECT_NUMBERS: 'no_project_numbers',
  NO_BOM_ROWS: 'no_bom_rows',
  NO_BOM_BRIDGE: 'no_bom_bridge',
  BRIDGE_AMBIGUOUS: 'bridge_ambiguous',
  TOPOLOGY_MISMATCH: 'topology_mismatch',
})

const SOURCE_PREFLIGHT_WARNING_CODES = Object.freeze({
  NO_PRESET_MATCH: 'no_preset_match',
  PRESET_AMBIGUOUS: 'preset_ambiguous',
  QUANTITY_FIELD_MISMATCH: 'quantity_field_mismatch',
  QUANTITY_FIELD_UNRESOLVED: 'quantity_field_unresolved',
  QUANTITY_READINGS_DISAGREE: 'quantity_readings_disagree',
  NODE_TYPE_COLUMN_ABSENT: 'node_type_column_absent',
  DICTIONARY_UNREADABLE: 'dictionary_unreadable',
})

// Ordered most-blocking first. A source you cannot reach makes every later finding meaningless, so it
// leads; the topology mismatch is last among blockers because it presupposes a reachable, populated
// source — it is the finding you can only make once everything before it passed.
const SOURCE_PREFLIGHT_BLOCKER_CODE_ORDER = Object.freeze([
  SOURCE_PREFLIGHT_BLOCKER_CODES.SOURCE_UNREACHABLE,
  SOURCE_PREFLIGHT_BLOCKER_CODES.ENTRY_TABLE_MISSING,
  SOURCE_PREFLIGHT_BLOCKER_CODES.NO_PROJECT_NUMBERS,
  SOURCE_PREFLIGHT_BLOCKER_CODES.NO_BOM_ROWS,
  SOURCE_PREFLIGHT_BLOCKER_CODES.NO_BOM_BRIDGE,
  SOURCE_PREFLIGHT_BLOCKER_CODES.BRIDGE_AMBIGUOUS,
  SOURCE_PREFLIGHT_BLOCKER_CODES.TOPOLOGY_MISMATCH,
])

// The ONLY JSON paths at which a value observed in a source row may appear. Everything else in the
// report is an identifier, a count or a code, and `assertSourcePreflightValuesFree` refuses an
// observed value anywhere else — including at a path a future edit adds, because the allowlist is
// exact and not a prefix.
const LIVENESS_VALUE_PATH = /^checks\.projectData\.livenessSamples\[[0-9]+\]$/

// ---------------------------------------------------------------------------
// LEAF CLASSIFICATION — the fail-closed half of the values-free contract.
//
// Every string leaf of the report belongs to exactly one of four classes, and a leaf belonging to
// NONE of them is itself a refusal. That inversion is the point: a future field added to this report
// is refused by default until someone classifies it deliberately, so "we forgot to consider whether
// the new field could carry a value" cannot be the way a value escapes.
// ---------------------------------------------------------------------------

// 1. CLOSED VOCABULARY — words this module itself emits. Each is checked AGAINST its set, so a leaf
//    that carried something else (a value that reached a code field) is refused rather than exempted.
const CLOSED_VOCABULARY_LEAF_FIELDS = Object.freeze(new Set([
  'verdict', 'code', 'reason', 'errorCode', 'failureCode',
  'bridge', 'detectedBridge', 'configuredBridge', 'role',
]))

// The bridge-decision reasons `decideBridge` can produce, plus the preset selector's own reasons.
const BRIDGE_DECISION_REASONS = Object.freeze([
  'neither-candidate-carries-lines',
  'only-order-module-carries-lines',
  'only-design-bom-carries-lines',
  'design-bom-line-volume-dominates',
  'order-module-line-volume-dominates',
  'both-candidates-carry-comparable-line-volume',
])
const PRESET_SELECTION_REASONS = Object.freeze([
  'MATCHED', 'NO_PRESET_MATCHED', 'AMBIGUOUS_PRESET_MATCH', 'PRESET_CATALOG_INVALID',
])

// The roles the roster assigns, plus the one role added after a preset matches.
const PROBE_ROLES = Object.freeze([
  'pathExAttr', 'pathInfo', 'orderHead', 'orderDetail', 'bomHead', 'bomDetail', 'part',
  'designBom', 'signature', 'quantityDictionary',
])

// 2. SERVER-AUTHORED — ids that come from server config, the request's own selector, or the shipped
//    preset catalog. None of them can be sourced from a customer row, because none of them is read
//    from one.
const SERVER_AUTHORED_LEAF_FIELDS = Object.freeze(new Set([
  'readPlanId', 'externalSystemId', 'presetId', 'matchedBy',
]))

// 3. SCHEMA IDENTIFIERS — table and column names. Exempt ONLY when the leaf's value really is one of
//    the identifiers this run observed (a table it probed, a column it saw), which is the same test
//    the source-discovery probe uses to tell a dictionary's schema-naming row from its content.
//    RESIDUAL, stated honestly: a business value that is character-for-character a column name of the
//    same catalog is indistinguishable from that column name here. That channel carries one token, is
//    the same one the discovery probe accepts, and is review-gated.
const IDENTIFIER_LEAF_FIELDS = Object.freeze(new Set([
  'object', 'entryObject', 'bomHeadObject', 'bomDetailObject', 'lineObject', 'headObject',
  'carrierObject', 'dictionaryObject', 'configuredLineObject', 'detectedLineObject',
  'matchField', 'nodeTypeColumn', 'dictionaryKeyColumn', 'dictionarySlot', 'measuredSlot',
  'resolvedSlot', 'configuredField', 'detectedField', 'column', 'columns',
  'missingSignatureTables',
]))

// 4. LIVENESS — matched by exact path, above.

const VENDOR_PRESETS_DIR = path.join(__dirname, 'source-vendor-presets')

class SourcePreflightError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'SourcePreflightError'
    this.details = details
  }
}

// ---------------------------------------------------------------------------
// Small local helpers. Deliberately local rather than imported: this module must stay loadable from a
// route, a test and a script with no host context, so it depends only on the preset schema and the
// read plan.
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function optionalString(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Case-insensitive column read — SQL Server preserves case, PostgreSQL folds it. */
function readCell(row, column) {
  if (!isPlainObject(row) || typeof column !== 'string' || column === '') return undefined
  if (Object.prototype.hasOwnProperty.call(row, column)) return row[column]
  const wanted = column.toLowerCase()
  const hits = Object.keys(row).filter((key) => key.toLowerCase() === wanted)
  return hits.length === 1 ? row[hits[0]] : undefined
}

function isNonEmptyValue(value) {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim() !== ''
  return true
}

function looksNumeric(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed === '') return false
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) && parsed >= 0
}

/**
 * Collapse ANY read failure into one closed code. The error's message is read here and NOWHERE ELSE:
 * it is matched against patterns and then dropped on the floor. Nothing downstream is ever handed the
 * text, so no later filter has to be trusted to remove a host or a login from it.
 */
function classifyReadError(error) {
  const code = optionalString(error && error.code) || ''
  const text = `${optionalString(error && error.message) || ''} ${code}`.toLowerCase()

  if (/econnrefused|ehostunreach|enetunreach|enotfound|eai_again|could not open a connection|failed to connect|socket hang up|econnreset/.test(text)) {
    return READ_ERROR_CODES.UNREACHABLE
  }
  if (/etimedout|esockettimedout|timeout|timed out/.test(text)) return READ_ERROR_CODES.TIMEOUT
  if (/login failed|authentication failed|password authentication|invalid credential|elogin|28p01/.test(text)) {
    return READ_ERROR_CODES.AUTH_REFUSED
  }
  if (/invalid object name|does not exist|doesn't exist|unknown table|undefined table|42p01|no such table/.test(text)) {
    return READ_ERROR_CODES.OBJECT_MISSING
  }
  if (/permission denied|access.{0,10}denied|not authorized|insufficient privilege|42501/.test(text)) {
    return READ_ERROR_CODES.PERMISSION_DENIED
  }
  return READ_ERROR_CODES.UNKNOWN
}

// ---------------------------------------------------------------------------
// THE PROBE — the only thing here that touches the source.
// ---------------------------------------------------------------------------

/**
 * One bounded, unfiltered, read-only probe of one object.
 *
 * Returns a values-free observation:
 *   { object, present, rowsObserved, exact, columns, errorCode }
 *
 * `exact` is the honest half of the count: a read that came back BELOW the cap saw the whole table, so
 * `rowsObserved` is the row count; a read that filled the cap saw a prefix, so `rowsObserved` is a
 * floor ("at least this many"). Reporting a capped page as a total is how a 200-row sample becomes a
 * "200-row table" in someone's notes.
 *
 * `columns` is the UNION of keys across the sampled rows — column NAMES only, never their values. It
 * is what lets an implementer see a table's shape (and what lets the slot-family matcher recognize
 * `bom_exattr1`) without anybody reading a business row.
 */
async function probeObject(readObject, object) {
  const observation = {
    object,
    present: false,
    rowsObserved: 0,
    exact: true,
    columns: [],
    errorCode: null,
  }
  let result
  try {
    result = await readObject({ object, limit: SOURCE_PREFLIGHT_ROW_CAP })
  } catch (error) {
    observation.errorCode = classifyReadError(error)
    return { observation, rows: [] }
  }
  const records = isPlainObject(result) && Array.isArray(result.records)
    ? result.records.filter(isPlainObject)
    : []
  observation.present = true
  observation.rowsObserved = records.length
  observation.exact = records.length < SOURCE_PREFLIGHT_ROW_CAP
  const columns = new Set()
  for (const row of records) {
    for (const key of Object.keys(row)) columns.add(key)
  }
  observation.columns = [...columns].sort()
  return { observation, rows: records }
}

/**
 * The roster of objects to probe, in a fixed order.
 *
 * It is DERIVED FROM THE CONFIGURED PLAN (not from a hardcoded list) so that a deployment which
 * overrode the plan is probed against what it actually runs — plus the declared bridge candidates and,
 * once a preset has matched, that preset's dictionary tables. A caller cannot add to it.
 */
function buildProbeRoster(plan, presets = []) {
  const roster = []
  const seenByRole = new Set()
  const seenTables = new Set()
  const add = (role, object) => {
    const name = optionalString(object)
    if (!name) return
    const normalized = normalizeTableName(name)
    const key = `${role}::${normalized}`
    if (seenByRole.has(key)) return
    seenByRole.add(key)
    seenTables.add(normalized)
    roster.push({ role, object: name })
  }
  add('pathExAttr', plan.pathExAttr.object)
  add('pathInfo', plan.pathInfo.object)
  add('orderHead', plan.orderHead.object)
  add('orderDetail', plan.orderDetail.object)
  add('bomHead', plan.bomHead.object)
  add('bomDetail', plan.bomDetail.object)
  add('part', plan.part.object)
  for (const candidate of DESIGN_BOM_BRIDGE_OBJECTS) add('designBom', candidate)

  // Identity top-up: the catalog's signature tables the plan does not already name. Ordered by the
  // catalog's own declaration order (stable across runs) and capped, so this stays a handful of small
  // reads rather than a function of how many presets ship.
  let added = 0
  for (const preset of presets) {
    const signature = (preset && preset.matches && preset.matches.signatureTables) || []
    for (const table of signature) {
      if (added >= IDENTITY_PROBE_MAX) return roster
      const normalized = normalizeTableName(table)
      if (seenTables.has(normalized)) continue
      seenTables.add(normalized)
      seenByRole.add(`signature::${normalized}`)
      roster.push({ role: 'signature', object: table })
      added += 1
    }
  }
  return roster
}

// ---------------------------------------------------------------------------
// TOPOLOGY — INCIDENT A's detector.
// ---------------------------------------------------------------------------

/**
 * Decide the bridge from MEASURED line volume, and say why.
 *
 * The rule, stated so a reader can audit the verdict rather than trust it:
 *
 *   - "line volume" is the number of BOM LINE rows each candidate carries, not the number of header
 *     rows. A module with one head row and no lines is not a bridge, whatever its head table's
 *     presence suggests — that is exactly the catalog the live incident met.
 *   - a candidate below BRIDGE_MIN_LINES lines counts as carrying nothing.
 *   - if exactly one candidate carries lines, it is the bridge.
 *   - if both do, the larger wins only when it exceeds the other by BRIDGE_DOMINANCE_RATIO; a capped
 *     ("at least") reading against a small exact one is decisive in the same way. Otherwise the answer
 *     is AMBIGUOUS, which is a blocker: two populated topologies is a question for a human, and
 *     guessing is what put a zero-row run on someone's screen in the first place.
 *   - if neither carries lines, the answer is NONE.
 */
function decideBridge(orderLines, designLines) {
  const orderCarries = orderLines.rowsObserved >= BRIDGE_MIN_LINES
  const designCarries = designLines.rowsObserved >= BRIDGE_MIN_LINES

  if (!orderCarries && !designCarries) {
    return { bridge: BRIDGES.NONE, reason: 'neither-candidate-carries-lines' }
  }
  if (orderCarries && !designCarries) {
    return { bridge: BRIDGES.ORDER_MODULE, reason: 'only-order-module-carries-lines' }
  }
  if (designCarries && !orderCarries) {
    return { bridge: BRIDGES.DESIGN_BOM, reason: 'only-design-bom-carries-lines' }
  }
  const order = orderLines.rowsObserved
  const design = designLines.rowsObserved
  if (design >= order * BRIDGE_DOMINANCE_RATIO) {
    return { bridge: BRIDGES.DESIGN_BOM, reason: 'design-bom-line-volume-dominates' }
  }
  if (order >= design * BRIDGE_DOMINANCE_RATIO) {
    return { bridge: BRIDGES.ORDER_MODULE, reason: 'order-module-line-volume-dominates' }
  }
  return { bridge: BRIDGES.AMBIGUOUS, reason: 'both-candidates-carry-comparable-line-volume' }
}

/** The bridge the CONFIGURED plan assumes. The shipped plan reaches components through the order module. */
function planAssumedBridge(plan) {
  return optionalString(plan.orderDetail.object) ? BRIDGES.ORDER_MODULE : BRIDGES.UNKNOWN
}

// ---------------------------------------------------------------------------
// QUANTITY SLOT — two independent readings.
// ---------------------------------------------------------------------------

/**
 * READING 1 — the customer's own dictionary.
 *
 * The vendor preset says WHERE to look and HOW to rank ("discover, not discovered"): a dictionary
 * table whose rows NAME columns of a generic slot family, an enabled flag with a measured polarity,
 * and a label hint for the quantity semantic. This resolves that into a slot name by:
 *
 *   - finding the dictionary column whose sampled values most often ARE members of the slot family
 *     (`isFamilyColumn`) — that is the key column, measured rather than declared;
 *   - keeping only rows the enabled flag marks enabled (`isEnabledFlagValue`, the live-measured
 *     nonzero-means-enabled polarity);
 *   - selecting the row whose label matches the quantity hint (`LABEL_HINT_VOCABULARY.quantity`).
 *
 * IT RETURNS THE SLOT NAME, NEVER THE LABEL. The slot name is a schema identifier; the label is the
 * customer's own wording for their own field, and no report of ours needs to carry it.
 */
function decodeQuantitySlotFromDictionary(preset, dictionaryRows) {
  const outcome = { slot: null, keyColumn: null, enabledRows: 0, matchedRows: 0 }
  if (!preset || !Array.isArray(dictionaryRows) || dictionaryRows.length === 0) return outcome

  const expectation = (preset.semanticExpectations || []).find((entry) => entry.semantic === 'bom-line-quantity')
  if (!expectation || !expectation.columnFamily) return outcome
  const family = (preset.genericColumnFamilies || {})[expectation.columnFamily]
  const dictionary = (preset.dictionaries || []).find((entry) => entry.id === expectation.dictionary)
  if (!family || !dictionary) return outcome

  const columns = new Set()
  for (const row of dictionaryRows) for (const key of Object.keys(row)) columns.add(key)

  // The key column is the one whose values name slot columns — MEASURED, because which column a
  // vendor's dictionary uses for that is not something a preset may assert.
  let keyColumn = null
  let keyHits = 0
  for (const column of columns) {
    let hits = 0
    for (const row of dictionaryRows) {
      const value = optionalString(readCell(row, column))
      if (value && isFamilyColumn(family, value)) hits += 1
    }
    if (hits > keyHits) {
      keyHits = hits
      keyColumn = column
    }
  }
  if (!keyColumn || keyHits === 0) return outcome
  outcome.keyColumn = keyColumn

  const enabledCandidates = (dictionary.enabledFlag && dictionary.enabledFlag.columnCandidates) || []
  const polarity = dictionary.enabledFlag && dictionary.enabledFlag.polarity
  const quantityHint = LABEL_HINT_VOCABULARY.quantity

  for (const row of dictionaryRows) {
    const slot = optionalString(readCell(row, keyColumn))
    if (!slot || !isFamilyColumn(family, slot)) continue
    if (polarity) {
      const flagValue = enabledCandidates
        .map((candidate) => readCell(row, candidate))
        .find((value) => value !== undefined)
      // No flag column at all -> treat the row as enabled (a catalog may simply not expose one);
      // a flag column present and NOT enabled -> skip, which is the whole point of reading it.
      if (flagValue !== undefined && !isEnabledFlagValue(polarity, flagValue)) continue
    }
    outcome.enabledRows += 1
    const labelMatches = Object.keys(row).some((column) => {
      if (column === keyColumn) return false
      const text = optionalString(row[column])
      return Boolean(text && quantityHint && quantityHint.test(text))
    })
    if (!labelMatches) continue
    outcome.matchedRows += 1
    if (!outcome.slot) outcome.slot = slot
  }
  return outcome
}

/**
 * READING 2 — the data's own numeric density.
 *
 * Independent of any dictionary: for each slot-family column present on the BOM-carrying table, what
 * share of its non-empty sampled values parse as finite non-negative numbers. A quantity column is
 * numeric almost everywhere; a text slot is not. Emits column names and RATIOS — never a value.
 */
function measureNumericSlots(preset, columns, rows) {
  const measured = []
  if (!preset || !Array.isArray(columns) || columns.length === 0 || rows.length === 0) return measured
  const expectation = (preset.semanticExpectations || []).find((entry) => entry.semantic === 'bom-line-quantity')
  const family = expectation && (preset.genericColumnFamilies || {})[expectation.columnFamily]
  if (!family) return measured

  for (const column of columns) {
    if (!isFamilyColumn(family, column)) continue
    let populated = 0
    let numeric = 0
    for (const row of rows) {
      const value = readCell(row, column)
      if (!isNonEmptyValue(value)) continue
      populated += 1
      if (looksNumeric(value)) numeric += 1
    }
    if (populated < QUANTITY_MIN_OBSERVATIONS) continue
    measured.push({
      column,
      populated,
      numericRatio: Math.round((numeric / populated) * 100) / 100,
    })
  }
  measured.sort((a, b) => (b.numericRatio - a.numericRatio) || (b.populated - a.populated) || a.column.localeCompare(b.column))
  return measured
}

// ---------------------------------------------------------------------------
// THE REPORT
// ---------------------------------------------------------------------------

function blockerOrder(code) {
  const index = SOURCE_PREFLIGHT_BLOCKER_CODE_ORDER.indexOf(code)
  return index === -1 ? SOURCE_PREFLIGHT_BLOCKER_CODE_ORDER.length : index
}

/**
 * Run the source preflight.
 *
 * @param {object}   input
 * @param {Function} input.readObject  async ({object, limit}) => ({ records })  — the SAME seam the BOM
 *                                     expansion reads through. The only capability this module holds.
 * @param {object}  [input.readPlan]   the deployment's configured plan; defaults to the shipped one.
 * @param {Array}   [input.presets]    vendor presets; defaults to the shipped catalog directory.
 * @param {string}  [input.externalSystemId] echoed for correlation. An id, never a connection.
 */
async function runStockPreparationSourcePreflight(input = {}) {
  if (typeof input.readObject !== 'function') {
    throw new SourcePreflightError('source preflight requires a readObject(request) capability', {
      field: 'readObject',
    })
  }
  const readObject = input.readObject
  const plan = normalizeStockPreparationBomReadPlan(input.readPlan || PLM_STOCK_PREPARATION_BOM_READ_PLAN)
  const presets = Array.isArray(input.presets)
    ? input.presets
    : loadVendorPresetsFromDir(VENDOR_PRESETS_DIR).map((entry) => entry.preset)

  const roster = buildProbeRoster(plan, presets)
  const observations = []
  const rowsByRole = new Map()
  const observationByRole = new Map()
  // Every string value seen in every sampled row. Never serialized; it ARMS the values-free
  // self-check, exactly as the discovery probe's leak guard does.
  const observedValues = new Set()

  for (const entry of roster) {
    const { observation, rows } = await probeObject(readObject, entry.object)
    const record = { role: entry.role, ...observation }
    observations.push(record)
    if (!observationByRole.has(entry.role) || (!observationByRole.get(entry.role).present && observation.present)) {
      observationByRole.set(entry.role, record)
      rowsByRole.set(entry.role, rows)
    }
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (typeof value === 'string' && value.trim() !== '') observedValues.add(value)
      }
    }
  }

  const roleOf = (role) => observationByRole.get(role) || {
    role, object: null, present: false, rowsObserved: 0, exact: true, columns: [], errorCode: null,
  }
  const rowsOf = (role) => rowsByRole.get(role) || []

  // ---- CHECK 1: reachability -------------------------------------------------
  // Reached = at least one probe got an answer. Unreached = every probe failed AND at least one failed
  // for a connectivity reason. "Every object missing" is a DIFFERENT diagnosis from "cannot connect",
  // and conflating them sends an implementer to the firewall when the problem is the schema.
  const anySucceeded = observations.some((entry) => entry.present)
  const connectivityFailures = observations.filter((entry) => CONNECTIVITY_ERROR_CODES.includes(entry.errorCode))
  const reachable = anySucceeded
  const reachability = {
    reachable,
    objectsProbed: observations.length,
    objectsAnswered: observations.filter((entry) => entry.present).length,
    failureCode: reachable
      ? null
      : (connectivityFailures.length > 0 ? connectivityFailures[0].errorCode : READ_ERROR_CODES.OBJECT_MISSING),
  }

  // ---- CHECK 2: project data -------------------------------------------------
  const pathExAttr = roleOf('pathExAttr')
  const pathExAttrRows = rowsOf('pathExAttr')
  const matchField = plan.pathExAttr.matchField
  const populatedMatchRows = pathExAttrRows.filter((row) => isNonEmptyValue(readCell(row, matchField))).length

  // The family's node-type column, where the catalog exposes one. Project nodes are NodeType = 2 —
  // knowledge from the live session. Absent column => the check degrades to "rows with a non-empty
  // match value", and SAYS SO, rather than reporting zero project nodes for a healthy source.
  const nodeTypeColumn = pathExAttr.columns.find((column) => column.toLowerCase() === 'nodetype') || null
  const projectNodeRows = nodeTypeColumn
    ? pathExAttrRows.filter((row) => String(readCell(row, nodeTypeColumn)).trim() === String(PROJECT_NODE_TYPE)).length
    : null

  // Liveness evidence — the one place an observed value may appear. Bounded in count and length, and
  // shape-screened with the preset validator's own detector so a planted connection string, URL, host
  // or credential in the project-number column is dropped instead of quoted back.
  const livenessSamples = []
  for (const row of pathExAttrRows) {
    if (livenessSamples.length >= LIVENESS_SAMPLE_MAX) break
    const value = optionalString(readCell(row, matchField))
    if (!value || value.length > LIVENESS_SAMPLE_MAX_LENGTH) continue
    if (findValueShapeViolation(value)) continue
    if (!livenessSamples.includes(value)) livenessSamples.push(value)
  }

  const projectData = {
    entryObject: pathExAttr.object,
    entryObjectPresent: pathExAttr.present,
    matchField,
    rowsObserved: pathExAttr.rowsObserved,
    exact: pathExAttr.exact,
    populatedMatchRows,
    nodeTypeColumn,
    projectNodeType: nodeTypeColumn ? PROJECT_NODE_TYPE : null,
    projectNodeRows,
    hasProjectNumbers: populatedMatchRows > 0,
    livenessSamples,
    errorCode: pathExAttr.errorCode,
  }

  // ---- CHECK 3: BOM data -----------------------------------------------------
  const bomHead = roleOf('bomHead')
  const bomDetail = roleOf('bomDetail')
  const designBom = roleOf('designBom')
  const bomData = {
    bomHeadObject: bomHead.object,
    bomHeadRows: bomHead.rowsObserved,
    bomHeadExact: bomHead.exact,
    bomHeadPresent: bomHead.present,
    bomDetailObject: bomDetail.object,
    bomDetailRows: bomDetail.rowsObserved,
    bomDetailExact: bomDetail.exact,
    bomDetailPresent: bomDetail.present,
    hasBomRows: bomHead.rowsObserved > 0 && bomDetail.rowsObserved > 0,
  }

  // ---- CHECK 4: topology -----------------------------------------------------
  const orderHead = roleOf('orderHead')
  const orderDetail = roleOf('orderDetail')
  const decision = decideBridge(orderDetail, designBom)
  const configuredBridge = planAssumedBridge(plan)
  const topology = {
    detectedBridge: decision.bridge,
    reason: decision.reason,
    configuredBridge,
    matchesConfigured: decision.bridge === configuredBridge,
    dominanceRatio: BRIDGE_DOMINANCE_RATIO,
    minLines: BRIDGE_MIN_LINES,
    candidates: [
      {
        bridge: BRIDGES.ORDER_MODULE,
        headObject: orderHead.object,
        headRows: orderHead.rowsObserved,
        headExact: orderHead.exact,
        headPresent: orderHead.present,
        lineObject: orderDetail.object,
        lineRows: orderDetail.rowsObserved,
        lineExact: orderDetail.exact,
        linePresent: orderDetail.present,
      },
      {
        bridge: BRIDGES.DESIGN_BOM,
        headObject: null,
        headRows: null,
        headExact: null,
        headPresent: null,
        lineObject: designBom.object,
        lineRows: designBom.rowsObserved,
        lineExact: designBom.exact,
        linePresent: designBom.present,
      },
    ],
  }

  // ---- CHECK 5: preset match, BY TABLE SIGNATURE -----------------------------
  // Identity comes from the tables the source actually answered for — never from a customer name, a
  // hostname, or an operator's assertion. `selectVendorPreset` is fail-closed on ambiguity by design.
  const answeredTables = observations.filter((entry) => entry.present).map((entry) => entry.object)
  let presetSelection
  try {
    presetSelection = selectVendorPreset(presets, answeredTables)
  } catch (error) {
    presetSelection = { selected: null, reason: 'PRESET_CATALOG_INVALID', evaluations: [] }
  }
  const matchedPreset = presetSelection.selected || null
  const presetEvaluation = matchedPreset
    ? evaluatePresetMatch(matchedPreset, answeredTables)
    : null
  const presetMatch = {
    matchedBy: 'table-signature',
    presetId: matchedPreset ? matchedPreset.presetId : null,
    reason: presetSelection.reason,
    tablesAnswered: answeredTables.length,
    matchedSignatureTables: presetEvaluation ? presetEvaluation.matchedCount : 0,
    requiredSignatureTables: presetEvaluation ? presetEvaluation.requiredCount : null,
    missingSignatureTables: presetEvaluation ? presetEvaluation.missingTables : [],
  }

  // ---- CHECK 6: quantity slot ------------------------------------------------
  // The BOM-carrying table is whichever the DETECTED bridge says it is — measuring the configured
  // table's slots when the source uses another one would report the wrong table's shape and quietly
  // agree with the very assumption that failed.
  const quantityCarrier = decision.bridge === BRIDGES.DESIGN_BOM ? designBom : bomDetail
  const quantityCarrierRows = decision.bridge === BRIDGES.DESIGN_BOM ? rowsOf('designBom') : rowsOf('bomDetail')

  let dictionaryDecode = { slot: null, keyColumn: null, enabledRows: 0, matchedRows: 0 }
  let dictionaryObject = null
  let dictionaryReadable = false
  if (matchedPreset) {
    const expectation = (matchedPreset.semanticExpectations || []).find((entry) => entry.semantic === 'bom-line-quantity')
    const dictionary = expectation && (matchedPreset.dictionaries || []).find((entry) => entry.id === expectation.dictionary)
    if (dictionary && dictionary.table) {
      dictionaryObject = dictionary.table
      const probe = await probeObject(readObject, dictionary.table)
      observations.push({ role: 'quantityDictionary', ...probe.observation })
      dictionaryReadable = probe.observation.present && probe.rows.length > 0
      for (const row of probe.rows) {
        for (const value of Object.values(row)) {
          if (typeof value === 'string' && value.trim() !== '') observedValues.add(value)
        }
      }
      dictionaryDecode = decodeQuantitySlotFromDictionary(matchedPreset, probe.rows)
    }
  }

  const measuredSlots = measureNumericSlots(matchedPreset, quantityCarrier.columns, quantityCarrierRows)
  const measuredSlot = measuredSlots.find((entry) => entry.numericRatio >= QUANTITY_NUMERIC_DENSITY_FLOOR) || null
  const configuredQuantityField = plan.bomDetail.quantityField
  const resolvedSlot = dictionaryDecode.slot || (measuredSlot ? measuredSlot.column : null)
  const readingsDisagree = Boolean(
    dictionaryDecode.slot && measuredSlot
    && dictionaryDecode.slot.toLowerCase() !== measuredSlot.column.toLowerCase(),
  )

  const quantityField = {
    carrierObject: quantityCarrier.object,
    configuredField: configuredQuantityField,
    dictionaryObject,
    dictionaryReadable,
    dictionaryKeyColumn: dictionaryDecode.keyColumn,
    dictionaryEnabledRows: dictionaryDecode.enabledRows,
    dictionarySlot: dictionaryDecode.slot,
    measuredSlot: measuredSlot ? measuredSlot.column : null,
    measuredNumericRatio: measuredSlot ? measuredSlot.numericRatio : null,
    measuredCandidates: measuredSlots,
    resolvedSlot,
    readingsAgree: Boolean(dictionaryDecode.slot && measuredSlot && !readingsDisagree),
    matchesConfigured: Boolean(
      resolvedSlot && configuredQuantityField
      && resolvedSlot.toLowerCase() === configuredQuantityField.toLowerCase(),
    ),
    numericDensityFloor: QUANTITY_NUMERIC_DENSITY_FLOOR,
  }

  // ---- BLOCKERS + WARNINGS ---------------------------------------------------
  const blockers = []
  const warnings = []
  const B = SOURCE_PREFLIGHT_BLOCKER_CODES
  const W = SOURCE_PREFLIGHT_WARNING_CODES

  if (!reachable) {
    blockers.push({ code: B.SOURCE_UNREACHABLE, detail: { failureCode: reachability.failureCode } })
  } else {
    if (!pathExAttr.present) {
      blockers.push({ code: B.ENTRY_TABLE_MISSING, detail: { object: pathExAttr.object, errorCode: pathExAttr.errorCode } })
    } else if (!projectData.hasProjectNumbers) {
      blockers.push({ code: B.NO_PROJECT_NUMBERS, detail: { object: pathExAttr.object, matchField } })
    }
    if (!bomData.hasBomRows && decision.bridge !== BRIDGES.DESIGN_BOM) {
      blockers.push({
        code: B.NO_BOM_ROWS,
        detail: { bomHeadRows: bomData.bomHeadRows, bomDetailRows: bomData.bomDetailRows },
      })
    }
    if (decision.bridge === BRIDGES.NONE) {
      blockers.push({ code: B.NO_BOM_BRIDGE, detail: { reason: decision.reason } })
    } else if (decision.bridge === BRIDGES.AMBIGUOUS) {
      blockers.push({
        code: B.BRIDGE_AMBIGUOUS,
        detail: { orderLines: orderDetail.rowsObserved, designBomLines: designBom.rowsObserved },
      })
    } else if (!topology.matchesConfigured) {
      // INCIDENT A, said out loud.
      blockers.push({
        code: B.TOPOLOGY_MISMATCH,
        detail: {
          configuredBridge,
          detectedBridge: decision.bridge,
          configuredLineObject: plan.orderDetail.object,
          detectedLineObject: decision.bridge === BRIDGES.DESIGN_BOM ? designBom.object : orderDetail.object,
        },
      })
    }

    if (!presetMatch.presetId) {
      warnings.push({
        code: presetSelection.reason === 'AMBIGUOUS_PRESET_MATCH' ? W.PRESET_AMBIGUOUS : W.NO_PRESET_MATCH,
        detail: { reason: presetSelection.reason },
      })
    }
    if (dictionaryObject && !dictionaryReadable) {
      warnings.push({ code: W.DICTIONARY_UNREADABLE, detail: { object: dictionaryObject } })
    }
    if (!resolvedSlot) {
      warnings.push({ code: W.QUANTITY_FIELD_UNRESOLVED, detail: { carrierObject: quantityCarrier.object } })
    } else if (!quantityField.matchesConfigured) {
      warnings.push({
        code: W.QUANTITY_FIELD_MISMATCH,
        detail: { configuredField: configuredQuantityField, detectedField: resolvedSlot },
      })
    }
    if (readingsDisagree) {
      warnings.push({
        code: W.QUANTITY_READINGS_DISAGREE,
        detail: { dictionarySlot: dictionaryDecode.slot, measuredSlot: measuredSlot.column },
      })
    }
    if (pathExAttr.present && !nodeTypeColumn) {
      warnings.push({ code: W.NODE_TYPE_COLUMN_ABSENT, detail: { object: pathExAttr.object } })
    }
  }

  blockers.sort((a, b) => blockerOrder(a.code) - blockerOrder(b.code))

  const report = {
    ok: blockers.length === 0,
    verdict: blockers.length === 0 ? 'go' : 'no-go',
    externalSystemId: optionalString(input.externalSystemId) || null,
    readPlanId: plan.id,
    rowCap: SOURCE_PREFLIGHT_ROW_CAP,
    checks: {
      reachability,
      projectData,
      bomData,
      topology,
      presetMatch,
      quantityField,
    },
    blockers,
    warnings,
    probes: observations.map((entry) => ({
      role: entry.role,
      object: entry.object,
      present: entry.present,
      rowsObserved: entry.rowsObserved,
      exact: entry.exact,
      columns: entry.columns,
      errorCode: entry.errorCode,
    })),
  }

  // The identifiers this run genuinely OBSERVED — every object it probed and every column name those
  // probes returned — plus the field names the configured plan itself names. Nothing else earns the
  // identifier exemption in the self-check below.
  const identifiers = new Set()
  for (const entry of observations) {
    if (entry.object) identifiers.add(entry.object)
    for (const column of entry.columns) identifiers.add(column)
  }
  for (const name of [matchField, configuredQuantityField, plan.pathExAttr.pathIdField, plan.pathInfo.idField]) {
    if (name) identifiers.add(name)
  }
  if (matchedPreset) {
    for (const table of (matchedPreset.matches && matchedPreset.matches.signatureTables) || []) identifiers.add(table)
  }

  assertSourcePreflightValuesFree(report, { observedValues, identifiers })
  return report
}

// ---------------------------------------------------------------------------
// VALUES-FREE SELF-CHECK
// ---------------------------------------------------------------------------

function collectStringLeaves(node, prefix, out) {
  if (typeof node === 'string') {
    out.push({ path: prefix, value: node })
    return
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => collectStringLeaves(item, `${prefix}[${index}]`, out))
    return
  }
  if (isPlainObject(node)) {
    for (const [key, value] of Object.entries(node)) {
      collectStringLeaves(value, prefix ? `${prefix}.${key}` : key, out)
    }
  }
}

function maskForRefusal(value) {
  if (typeof value !== 'string' || value.length <= 2) return '**'
  return `${value[0]}****${value[value.length - 1]}`
}

/** The leaf's own field name: the last path segment with any array subscript stripped. */
function leafFieldName(leafPath) {
  const segments = String(leafPath).split('.')
  const last = segments[segments.length - 1] || ''
  return last.replace(/\[[0-9]+\]$/, '')
}

function refuse(path, kind, value) {
  throw new SourcePreflightError('SOURCE_PREFLIGHT_VALUES_FREE_SELF_CHECK_FAILED', {
    path,
    kind,
    length: typeof value === 'string' ? value.length : 0,
    masked: maskForRefusal(value),
  })
}

/**
 * The independent second check, in the spirit of the discovery probe's H0 self-check.
 *
 * TWO assertions, in this order:
 *
 *   (1) CLASSIFICATION. Every string leaf must belong to one of the four declared classes, and a
 *       closed-vocabulary leaf must actually carry one of that vocabulary's words. A leaf in no class
 *       is refused — so a field added to this report later cannot carry a value out simply because
 *       nobody thought about it.
 *
 *   (2) CONTAINMENT. No leaf may reproduce — by equality, or by containing — a value observed in a
 *       sampled source row or a supplied secret. Exemptions are narrow and by CLASS, not by path
 *       prefix: closed-vocabulary and server-authored leaves cannot be sourced from a row at all;
 *       identifier leaves are exempt only when their value is genuinely one of the identifiers this
 *       run observed; and the liveness path is exempt for observed values only. Secrets are exempt
 *       NOWHERE, the liveness path included.
 *
 * It never echoes the offending value: a refusal names the path, the class, the length and a mask.
 */
function assertSourcePreflightValuesFree(report, { observedValues = new Set(), identifiers = new Set(), secrets = [] } = {}) {
  const leaves = []
  collectStringLeaves(report, '', leaves)

  const closedVocabulary = new Map([
    ['verdict', new Set(['go', 'no-go'])],
    ['code', new Set([
      ...Object.values(SOURCE_PREFLIGHT_BLOCKER_CODES),
      ...Object.values(SOURCE_PREFLIGHT_WARNING_CODES),
    ])],
    ['reason', new Set([...BRIDGE_DECISION_REASONS, ...PRESET_SELECTION_REASONS])],
    ['errorCode', new Set(SOURCE_PREFLIGHT_READ_ERROR_CODES)],
    ['failureCode', new Set(SOURCE_PREFLIGHT_READ_ERROR_CODES)],
    ['bridge', new Set(SOURCE_PREFLIGHT_BRIDGES)],
    ['detectedBridge', new Set(SOURCE_PREFLIGHT_BRIDGES)],
    ['configuredBridge', new Set(SOURCE_PREFLIGHT_BRIDGES)],
    ['role', new Set(PROBE_ROLES)],
  ])

  const knownIdentifiers = new Set()
  for (const value of identifiers) {
    if (typeof value === 'string' && value.trim() !== '') knownIdentifiers.add(value.toLowerCase())
  }

  const guarded = []
  for (const value of observedValues) {
    if (typeof value === 'string' && value.trim() !== '') guarded.push({ value, kind: 'observed-row-value' })
  }
  const secretList = (Array.isArray(secrets) ? secrets : [])
    .filter((value) => typeof value === 'string' && value.trim() !== '')

  for (const leaf of leaves) {
    const field = leafFieldName(leaf.path)
    const isLiveness = LIVENESS_VALUE_PATH.test(leaf.path)
    const isClosed = CLOSED_VOCABULARY_LEAF_FIELDS.has(field)
    const isServerAuthored = SERVER_AUTHORED_LEAF_FIELDS.has(field)
    const isIdentifier = IDENTIFIER_LEAF_FIELDS.has(field)

    // (1) CLASSIFICATION.
    if (!isLiveness && !isClosed && !isServerAuthored && !isIdentifier) {
      refuse(leaf.path, 'unclassified-string-leaf', leaf.value)
    }
    if (isClosed && !closedVocabulary.get(field).has(leaf.value)) {
      refuse(leaf.path, 'closed-vocabulary-violated', leaf.value)
    }

    // (2) CONTAINMENT. Secrets first, and with no exemption of any kind.
    for (const secret of secretList) {
      if (leaf.value === secret || (secret.length >= 4 && leaf.value.includes(secret))) {
        refuse(leaf.path, 'secret', secret)
      }
    }
    if (isClosed || isServerAuthored) continue
    for (const entry of guarded) {
      const hit = leaf.value === entry.value
        || (entry.value.length >= 4 && leaf.value.includes(entry.value))
      if (!hit) continue
      if (isLiveness) continue
      if (isIdentifier && knownIdentifiers.has(entry.value.toLowerCase())) continue
      refuse(leaf.path, entry.kind, entry.value)
    }
  }
  return report
}

module.exports = {
  SOURCE_PREFLIGHT_ROUTE_PATH,
  SOURCE_PREFLIGHT_ROW_CAP,
  IDENTITY_PROBE_MAX,
  SOURCE_PREFLIGHT_BRIDGES,
  SOURCE_PREFLIGHT_BLOCKER_CODES,
  SOURCE_PREFLIGHT_BLOCKER_CODE_ORDER,
  SOURCE_PREFLIGHT_WARNING_CODES,
  SOURCE_PREFLIGHT_READ_ERROR_CODES,
  DESIGN_BOM_BRIDGE_OBJECTS,
  BRIDGE_DOMINANCE_RATIO,
  BRIDGE_MIN_LINES,
  LIVENESS_SAMPLE_MAX,
  PROJECT_NODE_TYPE,
  QUANTITY_NUMERIC_DENSITY_FLOOR,
  SourcePreflightError,
  runStockPreparationSourcePreflight,
  assertSourcePreflightValuesFree,
  __internals: {
    buildProbeRoster,
    classifyReadError,
    decideBridge,
    decodeQuantitySlotFromDictionary,
    measureNumericSlots,
    planAssumedBridge,
    probeObject,
  },
}
