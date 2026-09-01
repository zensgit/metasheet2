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

// ---------------------------------------------------------------------------
// THE TWO BOM STORES, and why "which one is production" is not a volume question.
//
// MEASURED ON THE REAL CUSTOMER PLM (read-only, ground truth — not a fixture):
//
//   DN_PDM_BomHeadInfo      143 rows
//   DN_PDM_BomDetailsInfo  1319 rows, Bom_ExAttr1 columnar, 1319/1319 numeric
//   DN_PDM_DesignBom       2570 rows, NO ExAttr columns at all — its slots live as JSON KEYS inside
//                          a single nvarchar `data` column ({"pid":…,"material":…,"bom_exattr16":""})
//   DN_PDM_OrderHeadInfo      1 row  /  DN_PDM_OrderDetailInfo  7 rows (the order module is dead here)
//
// A rule that ranked BOM stores by LINE VOLUME would read 2570 > 1319 and hand an implementer
// `DN_PDM_DesignBom` with confidence. That is WRONG: the customer's own legacy 备料 system
// (`Bom.xml` mapper) reads BomHeadInfo/BomDetailsInfo and references DesignBom NOWHERE — the 2570
// rows are design-stage/historical. A confident wrong carrier is worse than a refusal, which is the
// principle this module applies everywhere else, and volume was quietly violating it.
//
// So volume is DEMOTED to a tiebreak, and two stronger signals are read first:
//
//   AUTHORITY  what the vendor preset says the family's production BOM line model IS. Not a new
//              preset field: the preset ALREADY declares `bom-line-quantity` on a column family whose
//              `onRole` names the carrier (`bomDetail` for dn-pdm), and declares DesignBom nowhere.
//              Reading that is reading what the catalog already asserts, not inventing an assertion.
//   SHAPE      a COLUMNAR, densely-numeric quantity slot is strong evidence of the production line
//              table. Slots buried as JSON keys inside a text blob are not addressable by the
//              columnar read plan at all, so a store in that shape cannot be the one the deployment
//              reads — whatever its row count.
//   VOLUME     the tiebreak, and only that.
//
// WHEN THE SIGNALS DISAGREE — exactly the real customer's case, where volume says DesignBom while
// shape and authority say BomDetails — the answer is a CONFLICT BLOCKER naming both stores and which
// signal favours which. Deliberately NOT "always prefer BomDetails": that would replace one guess
// with another. The conflict is made visible and a human (or the preset) resolves it.
// ---------------------------------------------------------------------------

const BOM_STORES = Object.freeze({
  BOM_DETAILS: 'bom-details',
  DESIGN_BOM: 'design-bom',
  CONFLICTED: 'conflicted',
  NONE: 'none',
})
const SOURCE_PREFLIGHT_BOM_STORES = Object.freeze(Object.values(BOM_STORES))

/** The signals, strongest first. `volume` is last on purpose and is never alone decisive over these. */
const BOM_STORE_SIGNALS = Object.freeze(['authority', 'shape', 'volume'])
const STRONG_BOM_STORE_SIGNALS = Object.freeze(['authority', 'shape'])

/** How a store's slots are physically laid out — the SHAPE signal's vocabulary. */
const CARRIER_SHAPES = Object.freeze({
  COLUMNAR_NUMERIC: 'columnar-numeric',
  COLUMNAR_PLAIN: 'columnar-plain',
  JSON_EMBEDDED: 'json-embedded',
  NO_SLOTS: 'no-slots',
})
const SOURCE_PREFLIGHT_CARRIER_SHAPES = Object.freeze(Object.values(CARRIER_SHAPES))

const BOM_STORE_DECISION_REASONS = Object.freeze([
  'no-store-carries-lines',
  'only-one-store-carries-lines',
  'strong-signals-agree',
  'strong-signals-disagree',
  'strong-signals-and-volume-disagree',
  'volume-undecidable-at-cap',
  'volume-only-tiebreak',
  'no-signal-distinguishes-the-stores',
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

// The bridges a HUMAN may declare when the bounded sample cannot decide. Deliberately only the two
// real carriers: `ambiguous` / `none` / `unknown` are readings, not topologies, and nobody can declare
// their source into one.
const DECLARABLE_BRIDGES = Object.freeze([BRIDGES.ORDER_MODULE, BRIDGES.DESIGN_BOM])

const SOURCE_PREFLIGHT_BLOCKER_CODES = Object.freeze({
  SOURCE_UNREACHABLE: 'source_unreachable',
  ENTRY_TABLE_MISSING: 'entry_table_missing',
  NO_PROJECT_NUMBERS: 'no_project_numbers',
  NO_BOM_ROWS: 'no_bom_rows',
  NO_BOM_BRIDGE: 'no_bom_bridge',
  // Two populated BOM stores whose signals point different ways — measured for real: volume favours
  // DesignBom (2570 rows) while shape and the preset's own authority favour BomDetails (1319 rows,
  // columnar 100%-numeric Bom_ExAttr1). Naming a winner there would be a confident wrong carrier.
  BOM_STORE_SIGNALS_CONFLICT: 'bom_store_signals_conflict',
  BRIDGE_AMBIGUOUS: 'bridge_ambiguous',
  // Distinct from BRIDGE_AMBIGUOUS on purpose: "both carriers are full past the sample cap, so a
  // bounded read cannot rank them" is a different fact, with a different way out, from "we compared
  // them and they came out close".
  BRIDGE_UNDECIDABLE_AT_CAP: 'bridge_undecidable_at_cap',
  // A declaration may resolve what the sample could not. It may NEVER overrule what the sample did
  // decide — that would turn the one measurement this whole module exists to make into a formality.
  DECLARED_BRIDGE_CONTRADICTS_MEASUREMENT: 'declared_bridge_contradicts_measurement',
  TOPOLOGY_MISMATCH: 'topology_mismatch',
})

const SOURCE_PREFLIGHT_WARNING_CODES = Object.freeze({
  NO_PRESET_MATCH: 'no_preset_match',
  PRESET_AMBIGUOUS: 'preset_ambiguous',
  QUANTITY_FIELD_MISMATCH: 'quantity_field_mismatch',
  QUANTITY_FIELD_UNRESOLVED: 'quantity_field_unresolved',
  // Two or more slots are equally plausible quantity carriers and no dictionary breaks the tie. The
  // same discipline the bridge decision follows: say so, do not pick.
  QUANTITY_FIELD_AMBIGUOUS: 'quantity_field_ambiguous',
  // The carrier has no addressable slot columns at all — its slots are JSON keys in a text blob, the
  // real customer's DesignBom shape. Saying nothing here would render as "no quantity", which is
  // wrong; this says the slots exist and the columnar read plan cannot reach them.
  QUANTITY_FIELD_UNDETECTABLE_ON_CARRIER: 'quantity_field_undetectable_on_this_carrier',
  QUANTITY_READINGS_DISAGREE: 'quantity_readings_disagree',
  // The bridge in this report came from a human, not from the data. Said out loud every time, so a
  // declared bridge is never read back later as a measured one.
  BRIDGE_DECLARED_NOT_MEASURED: 'bridge_declared_not_measured',
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
  // Ranked ABOVE every bridge question: "which store holds the production BOM" is the more basic
  // fact, and no answer about how a project reaches its lines means anything until it is settled.
  SOURCE_PREFLIGHT_BLOCKER_CODES.BOM_STORE_SIGNALS_CONFLICT,
  // A contradicted declaration outranks both ambiguity codes: it says the operator's belief and the
  // data disagree, and that has to be settled before any question about ranking carriers matters.
  SOURCE_PREFLIGHT_BLOCKER_CODES.DECLARED_BRIDGE_CONTRADICTS_MEASUREMENT,
  SOURCE_PREFLIGHT_BLOCKER_CODES.BRIDGE_AMBIGUOUS,
  SOURCE_PREFLIGHT_BLOCKER_CODES.BRIDGE_UNDECIDABLE_AT_CAP,
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
  // The bridge-provenance fields. `declaredBridge` is request-supplied, which is exactly why it is
  // CLOSED and not server-authored: it is validated against DECLARABLE_BRIDGES here too, so a request
  // cannot use it as a free-text channel into the report.
  'measuredBridge', 'declaredBridge', 'bridgeSource', 'declarableBridges',
  // The BOM-store decision's vocabulary: which store, which signal favoured which, what shape each
  // store's slots are in, and where the authority reading came from.
  'store', 'carrierStore', 'favours', 'signal', 'signals', 'strongSignals',
  'shape', 'carrierShape', 'authorityBasis',
]))

// The bridge-decision reasons `decideBridge` can produce, plus the preset selector's own reasons.
const BRIDGE_DECISION_REASONS = Object.freeze([
  'bom-store-conflict',
  'neither-candidate-carries-lines',
  'only-order-module-carries-lines',
  'only-design-bom-carries-lines',
  'design-bom-line-volume-dominates',
  'order-module-line-volume-dominates',
  'both-candidates-carry-comparable-line-volume',
  'both-candidates-saturate-the-sample-cap',
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
  // The tied quantity slots the reading refused to choose between, the objects that answered under a
  // collapsed role, and the two bridge line objects the cap standoff names.
  'qualifyingSlots', 'candidates', 'orderLineObject', 'designBomLineObject',
  // Store-shape identifiers: slot columns, the JSON blob column, and the VENDOR slot keys found in it
  // (only keys matching the family pattern are ever named; every other key is counted, not named).
  'familySlotColumns', 'numericSlotColumns', 'jsonSlotColumn', 'jsonFamilySlotKeys',
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
function decideBridge(orderLines, designLines, bomStore) {
  const orderCarries = orderLines.rowsObserved >= BRIDGE_MIN_LINES
  // DesignBom is only an entry candidate when the STORE question resolved in its favour. Before this,
  // a high-volume DesignBom became the answer on row count alone — which, on the real customer
  // catalog, is a confident wrong answer (see the BOM_STORES banner above).
  const designEligible = bomStore.store === BOM_STORES.DESIGN_BOM
  const designCarries = designLines.rowsObserved >= BRIDGE_MIN_LINES && designEligible

  // The store question came out CONFLICTED and DesignBom really does hold lines: we cannot say which
  // store is production, so we certainly cannot say which one the project enters through. Refuse, and
  // point at the conflict rather than inventing an entry.
  if (bomStore.store === BOM_STORES.CONFLICTED && designLines.rowsObserved >= BRIDGE_MIN_LINES && !orderCarries) {
    return { bridge: BRIDGES.AMBIGUOUS, reason: 'bom-store-conflict', undecidableAtCap: false }
  }

  if (!orderCarries && !designCarries) {
    return { bridge: BRIDGES.NONE, reason: 'neither-candidate-carries-lines', undecidableAtCap: false }
  }
  if (orderCarries && !designCarries) {
    return { bridge: BRIDGES.ORDER_MODULE, reason: 'only-order-module-carries-lines', undecidableAtCap: false }
  }
  if (designCarries && !orderCarries) {
    return { bridge: BRIDGES.DESIGN_BOM, reason: 'only-design-bom-carries-lines', undecidableAtCap: false }
  }

  // BOTH SATURATED THE CAP — and this is NOT a tie.
  //
  // A bounded sample stops counting at SOURCE_PREFLIGHT_ROW_CAP, so two carriers that both fill it
  // read as "cap vs cap" whether the truth is 201-vs-205 or 100,000-vs-201. Running the dominance
  // ratio on those two equal floors would report `both-candidates-carry-comparable-line-volume`, which
  // is a claim about the DATA that the sample cannot support — and, since real deployments have real
  // volume on at least one side, it would make AMBIGUOUS the permanent answer for exactly the
  // catalogs this check exists to serve: a hard block with no way out and no way to tell it apart
  // from a genuine tie.
  //
  // So it gets its own reason and its own blocker. The refusal stands — we still do not guess — but
  // it is DISTINGUISHABLE ("the sample cannot decide") and ACTIONABLE (a human may declare the
  // bridge; see `declaredBridge`, which is a declaration to check against, never a read-widening).
  if (!orderLines.exact && !designLines.exact) {
    return {
      bridge: BRIDGES.AMBIGUOUS,
      reason: 'both-candidates-saturate-the-sample-cap',
      undecidableAtCap: true,
    }
  }

  const order = orderLines.rowsObserved
  const design = designLines.rowsObserved
  // A saturated candidate against an exact one IS decidable in the saturated candidate's favour when
  // it clears the ratio: its count is a FLOOR, so the true margin can only be larger.
  if (design >= order * BRIDGE_DOMINANCE_RATIO) {
    return { bridge: BRIDGES.DESIGN_BOM, reason: 'design-bom-line-volume-dominates', undecidableAtCap: false }
  }
  if (order >= design * BRIDGE_DOMINANCE_RATIO) {
    return { bridge: BRIDGES.ORDER_MODULE, reason: 'order-module-line-volume-dominates', undecidableAtCap: false }
  }
  // One side is exact and neither dominates: a real comparison that came out close. That IS a tie.
  return {
    bridge: BRIDGES.AMBIGUOUS,
    reason: 'both-candidates-carry-comparable-line-volume',
    undecidableAtCap: false,
  }
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
 * The slot family the preset declares the BOM line quantity lives in, plus the ROLE that family sits
 * on — which is the AUTHORITY signal in one read. For dn-pdm this resolves to the `Bom_ExAttr` family
 * on role `bomDetail`, i.e. the catalog already says the family's production BOM lines are on
 * `DN_PDM_BomDetailsInfo`, and says nothing at all about DesignBom.
 */
function bomLineQuantityFamily(preset) {
  if (!preset) return null
  const expectation = (preset.semanticExpectations || []).find((entry) => entry.semantic === 'bom-line-quantity')
  if (!expectation || !expectation.columnFamily) return null
  const family = (preset.genericColumnFamilies || {})[expectation.columnFamily]
  if (!family) return null
  return { family, onRole: family.onRole || null, columnFamily: expectation.columnFamily }
}

/**
 * JSON-EMBEDDED SLOTS — the shape the real customer's DesignBom turned out to have.
 *
 * `DN_PDM_DesignBom` carries no ExAttr columns whatsoever; its dictionary values live as KEYS inside a
 * single nvarchar `data` column. A slot scan that only looks at COLUMN names finds nothing there and
 * reports nothing — and "nothing" reads as "no quantity", which is both wrong and misleading.
 *
 * So text columns are scanned for JSON objects and their KEYS are matched against the slot family.
 * VALUES-FREE: only keys that MATCH THE VENDOR'S OWN SLOT PATTERN are ever named (those are vendor
 * vocabulary, not customer content); every other key is counted and not named, and no JSON VALUE is
 * read except to ask whether the slot key is populated at all.
 */
function detectJsonEmbeddedSlots(family, columns, rows) {
  const outcome = { column: null, familySlotKeys: [], otherKeyCount: 0, rowsWithObject: 0, populatedFamilySlotRows: 0 }
  if (!family || rows.length === 0) return outcome

  for (const column of columns) {
    const familyKeys = new Set()
    const otherKeys = new Set()
    let rowsWithObject = 0
    let populated = 0
    for (const row of rows) {
      const raw = optionalString(readCell(row, column))
      if (!raw || raw[0] !== '{') continue
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        continue
      }
      if (!isPlainObject(parsed)) continue
      rowsWithObject += 1
      let rowHasPopulatedSlot = false
      for (const [key, value] of Object.entries(parsed)) {
        if (isFamilyColumn(family, key)) {
          familyKeys.add(key)
          if (isNonEmptyValue(value)) rowHasPopulatedSlot = true
        } else {
          otherKeys.add(key)
        }
      }
      if (rowHasPopulatedSlot) populated += 1
    }
    if (familyKeys.size === 0) continue
    // First column that carries family slot keys wins; a table with two such blobs is pathological
    // and the report shows the column so a human can see which one was read.
    return {
      column,
      familySlotKeys: [...familyKeys].sort(),
      otherKeyCount: otherKeys.size,
      rowsWithObject,
      populatedFamilySlotRows: populated,
    }
  }
  return outcome
}

/**
 * Classify ONE store's physical slot layout. This is the SHAPE signal's measurement.
 *
 * `columnar-numeric` is the only shape that evidences a production line table: the deployment's read
 * plan addresses columns, so a store whose slots are JSON keys cannot be the one it reads, however
 * many rows it holds.
 */
function classifyCarrierShape(family, observation, rows) {
  const base = {
    object: observation.object,
    shape: CARRIER_SHAPES.NO_SLOTS,
    familySlotColumns: [],
    numericSlotColumns: [],
    jsonSlotColumn: null,
    jsonFamilySlotKeys: [],
    jsonOtherKeyCount: 0,
    jsonPopulatedSlotRows: 0,
  }
  if (!family || !observation.present) return base

  const familyColumns = observation.columns.filter((column) => isFamilyColumn(family, column))
  base.familySlotColumns = familyColumns
  if (familyColumns.length > 0) {
    const numeric = []
    for (const column of familyColumns) {
      let populated = 0
      let numericCount = 0
      for (const row of rows) {
        const value = readCell(row, column)
        if (!isNonEmptyValue(value)) continue
        populated += 1
        if (looksNumeric(value)) numericCount += 1
      }
      if (populated >= QUANTITY_MIN_OBSERVATIONS && (numericCount / populated) >= QUANTITY_NUMERIC_DENSITY_FLOOR) {
        numeric.push(column)
      }
    }
    base.numericSlotColumns = numeric
    base.shape = numeric.length > 0 ? CARRIER_SHAPES.COLUMNAR_NUMERIC : CARRIER_SHAPES.COLUMNAR_PLAIN
    return base
  }

  const json = detectJsonEmbeddedSlots(family, observation.columns, rows)
  if (json.column) {
    base.shape = CARRIER_SHAPES.JSON_EMBEDDED
    base.jsonSlotColumn = json.column
    base.jsonFamilySlotKeys = json.familySlotKeys
    base.jsonOtherKeyCount = json.otherKeyCount
    base.jsonPopulatedSlotRows = json.populatedFamilySlotRows
  }
  return base
}

/**
 * WHICH STORE HOLDS THE PRODUCTION BOM — authority, then shape, then volume as a tiebreak.
 *
 * The rule, stated so a reader can audit the verdict rather than trust it:
 *
 *   - a store below BRIDGE_MIN_LINES lines carries nothing and is out; if one store is left, it wins.
 *   - AUTHORITY favours the store the matched preset declares the family's BOM line quantity on —
 *     but only if that store actually carries lines. A table with no rows asserts nothing.
 *   - SHAPE favours the unique store with a columnar, densely-numeric slot.
 *   - if the strong signals (authority, shape) all point one way and VOLUME points the other, that is
 *     a CONFLICT and the answer is a refusal naming both stores and which signal favours which. This
 *     is the real customer: volume says DesignBom (2570 > 1319), authority and shape say BomDetails.
 *   - if the strong signals disagree with EACH OTHER, likewise a conflict.
 *   - with no strong opinion at all, volume decides — that is the tiebreak role, and the report says
 *     the decision rested on volume alone.
 *   - two populated stores that nothing distinguishes is also a refusal, not a coin toss.
 */
function decideBomStore({ bomDetail, bomDetailShape, designBom, designBomShape, authorityRole }) {
  const carriers = [
    { store: BOM_STORES.BOM_DETAILS, role: 'bomDetail', observation: bomDetail, shape: bomDetailShape },
    { store: BOM_STORES.DESIGN_BOM, role: 'designBom', observation: designBom, shape: designBomShape },
  ]
  const carrying = carriers.filter((entry) => entry.observation.rowsObserved >= BRIDGE_MIN_LINES)
  const signals = { authority: null, shape: null, volume: null }

  if (carrying.length === 0) {
    return { store: BOM_STORES.NONE, reason: 'no-store-carries-lines', signals, carrying: [] }
  }
  if (carrying.length === 1) {
    return {
      store: carrying[0].store,
      reason: 'only-one-store-carries-lines',
      signals,
      carrying: carrying.map((entry) => entry.store),
    }
  }

  // AUTHORITY — what the catalog already says, restricted to a store that carries lines.
  const authorityCarrier = authorityRole
    ? carrying.find((entry) => entry.role === authorityRole) || null
    : null
  if (authorityCarrier) signals.authority = authorityCarrier.store

  // SHAPE — the unique columnar, densely-numeric store.
  const columnar = carrying.filter((entry) => entry.shape.shape === CARRIER_SHAPES.COLUMNAR_NUMERIC)
  if (columnar.length === 1) signals.shape = columnar[0].store

  // VOLUME — plain ordering, not dominance. Demoted to "which store holds more of the rows we were
  // allowed to see", because that is all a bounded sample can honestly say.
  //
  // AND THE HONEST CAVEAT THAT MATTERS MOST HERE: when BOTH stores fill the sample cap, the sample
  // cannot rank them AT ALL. On the real customer the true counts are 2570 and 1319 — a fact this
  // probe never sees, because it stops at 200 apiece. Treating that as "volume agrees" would let the
  // cap manufacture agreement, and would quietly hide from the operator that the store we are NOT
  // pointing at might be the far bigger one. So it is recorded as undecidable, and it is enough on
  // its own to make the answer a conflict.
  const [a, b] = carrying
  const volumeUndecidableAtCap = !a.observation.exact && !b.observation.exact
  if (!volumeUndecidableAtCap) {
    if (a.observation.rowsObserved > b.observation.rowsObserved) signals.volume = a.store
    else if (b.observation.rowsObserved > a.observation.rowsObserved) signals.volume = b.store
  }

  const strongOpinions = STRONG_BOM_STORE_SIGNALS
    .map((name) => signals[name])
    .filter((store) => store !== null)
  const carryingStores = carrying.map((entry) => entry.store)
  const base = { signals, carrying: carryingStores, volumeUndecidableAtCap }

  if (strongOpinions.length > 0) {
    const unanimous = strongOpinions.every((store) => store === strongOpinions[0])
    if (!unanimous) {
      return { store: BOM_STORES.CONFLICTED, reason: 'strong-signals-disagree', ...base }
    }
    if (signals.volume !== null && signals.volume !== strongOpinions[0]) {
      // The strong signals point one way and the bigger table is the other one. Refuse, and say which
      // signal pointed where.
      return { store: BOM_STORES.CONFLICTED, reason: 'strong-signals-and-volume-disagree', ...base }
    }
    if (volumeUndecidableAtCap) {
      // THE REAL CUSTOMER. Shape and authority both say BomDetails; the sample cannot see that
      // DesignBom holds twice as many rows, and cannot rule it out either. Concluding BomDetails here
      // would be "always prefer the preset's pair" wearing a measurement's clothes — so the operator
      // is shown the standoff and resolves it, exactly as for the bridge cap standoff.
      return { store: BOM_STORES.CONFLICTED, reason: 'volume-undecidable-at-cap', ...base }
    }
    return { store: strongOpinions[0], reason: 'strong-signals-agree', ...base }
  }

  if (signals.volume !== null) {
    return { store: signals.volume, reason: 'volume-only-tiebreak', ...base }
  }
  return { store: BOM_STORES.CONFLICTED, reason: 'no-signal-distinguishes-the-stores', ...base }
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
  // role -> every {record, rows} that answered under it, in roster order.
  const attemptsByRole = new Map()
  // Every string value seen in every sampled row. Never serialized; it ARMS the values-free
  // self-check, exactly as the discovery probe's leak guard does.
  const observedValues = new Set()

  for (const entry of roster) {
    const { observation, rows } = await probeObject(readObject, entry.object)
    const record = { role: entry.role, ...observation }
    observations.push(record)
    if (!attemptsByRole.has(entry.role)) attemptsByRole.set(entry.role, [])
    attemptsByRole.get(entry.role).push({ record, rows })
    for (const row of rows) {
      for (const value of Object.values(row)) {
        if (typeof value === 'string' && value.trim() !== '') observedValues.add(value)
      }
    }
  }

  // ROLE COLLAPSE — the STRONGEST carrier, never merely the first to answer.
  //
  // A role can address more than one object: `designBom` probes every spelling in
  // DESIGN_BOM_BRIDGE_OBJECTS, because which one a catalog uses is exactly the thing we do not know.
  // Taking the first PRESENT one collapses that on arrival order, and arrival order is the roster's,
  // not the data's — so a deployment carrying a five-row legacy `DN_PDM_DesignBom` beside a populated
  // `DN_PDM_DesignBomInfo` would have its design-BOM volume read as five. That undercount tilts the
  // bridge decision toward the order module, or into AMBIGUOUS, on nothing but a naming accident.
  //
  // So the winner is the object with the LARGEST observed row count (ties resolved by roster order, so
  // the choice is deterministic). MAX rather than SUM on purpose: these are alternative spellings of
  // one carrier, not shards of it, and the sampled rows that feed column inspection and slot-density
  // measurement must come from ONE table — summing counts while inspecting one table's columns would
  // describe a table that does not exist. Every object that answered is still reported, so an operator
  // can see that two candidates were present and which one the verdict rests on.
  const winnerByRole = new Map()
  for (const [role, attempts] of attemptsByRole) {
    const present = attempts.filter((attempt) => attempt.record.present)
    if (present.length === 0) {
      winnerByRole.set(role, attempts[0])
      continue
    }
    winnerByRole.set(role, present.reduce(
      (best, attempt) => (attempt.record.rowsObserved > best.record.rowsObserved ? attempt : best),
      present[0],
    ))
  }

  const roleOf = (role) => (winnerByRole.get(role) || {}).record || {
    role, object: null, present: false, rowsObserved: 0, exact: true, columns: [], errorCode: null,
  }
  const rowsOf = (role) => (winnerByRole.get(role) || {}).rows || []
  /** Every object that ANSWERED under a role — the audit trail behind the collapse above. */
  const contributorsOf = (role) => (attemptsByRole.get(role) || [])
    .filter((attempt) => attempt.record.present)
    .map((attempt) => ({
      object: attempt.record.object,
      rowsObserved: attempt.record.rowsObserved,
      exact: attempt.record.exact,
    }))

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

  // ---- CHECK 3a: preset match, BY TABLE SIGNATURE ----------------------------
  // Identity comes from the tables the source actually answered for — never from a customer name, a
  // hostname, or an operator's assertion. `selectVendorPreset` is fail-closed on ambiguity by design.
  //
  // Resolved HERE, ahead of the store and topology decisions, because the matched preset is what
  // carries the AUTHORITY signal those decisions weigh: the family's declared BOM-line-quantity role.
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

  // ---- CHECK 3b: WHICH BOM STORE IS PRODUCTION -------------------------------
  // Runs BEFORE the topology decision, because "which store holds the production BOM" is a stronger
  // and more basic question than "how does a project reach it" — and because answering the second on
  // row count alone is what produced a confident wrong carrier on the real customer catalog.
  //
  // The preset is read here purely as an ASSERTION SOURCE; the shapes are measured from the sampled
  // rows. Both stores are classified even when only one carries lines, so the report always shows the
  // shape evidence rather than only the winner's.
  const quantityFamily = bomLineQuantityFamily(matchedPreset)
  const bomDetailShape = classifyCarrierShape(quantityFamily && quantityFamily.family, bomDetail, rowsOf('bomDetail'))
  const designBomShape = classifyCarrierShape(quantityFamily && quantityFamily.family, designBom, rowsOf('designBom'))
  const storeDecision = decideBomStore({
    bomDetail,
    bomDetailShape,
    designBom,
    designBomShape,
    authorityRole: quantityFamily ? quantityFamily.onRole : null,
  })
  const bomStore = {
    store: storeDecision.store,
    reason: storeDecision.reason,
    // Which signal favoured which store — the sentence a refusal has to be able to say out loud.
    signals: BOM_STORE_SIGNALS.map((signal) => ({ signal, favours: storeDecision.signals[signal] })),
    strongSignals: [...STRONG_BOM_STORE_SIGNALS],
    // True when both stores filled the sample cap: the sample cannot rank them, and says so rather
    // than letting the cap manufacture agreement.
    volumeUndecidableAtCap: Boolean(storeDecision.volumeUndecidableAtCap),
    rowCap: SOURCE_PREFLIGHT_ROW_CAP,
    authorityBasis: quantityFamily && quantityFamily.onRole ? 'preset-bom-line-quantity-role' : null,
    dominanceRatio: BRIDGE_DOMINANCE_RATIO,
    minLines: BRIDGE_MIN_LINES,
    candidates: [
      {
        store: BOM_STORES.BOM_DETAILS,
        object: bomDetail.object,
        lines: bomDetail.rowsObserved,
        exact: bomDetail.exact,
        present: bomDetail.present,
        ...bomDetailShape,
      },
      {
        store: BOM_STORES.DESIGN_BOM,
        object: designBom.object,
        lines: designBom.rowsObserved,
        exact: designBom.exact,
        present: designBom.present,
        ...designBomShape,
      },
    ],
  }

  // ---- CHECK 4: topology -----------------------------------------------------
  const orderHead = roleOf('orderHead')
  const orderDetail = roleOf('orderDetail')
  const measured = decideBridge(orderDetail, designBom, storeDecision)
  const configuredBridge = planAssumedBridge(plan)

  // THE DECLARATION, and the exactly two things it may do.
  //
  // It RESOLVES what the bounded sample could not rank (`undecidableAtCap`), and it CONTRADICTS a
  // measurement that came out decisive. It can do nothing else: it cannot conjure a bridge where
  // neither carrier holds lines (NONE stands — declaring a bridge into an empty catalog is how a
  // zero-row run gets blessed), and it cannot break a genuine close tie between two exactly-counted
  // carriers, because that tie is a real measurement and a human's belief is not evidence against it.
  const declaredBridge = DECLARABLE_BRIDGES.includes(optionalString(input.declaredBridge))
    ? optionalString(input.declaredBridge)
    : null
  const declarationContradicts = Boolean(
    declaredBridge
    && (measured.bridge === BRIDGES.ORDER_MODULE || measured.bridge === BRIDGES.DESIGN_BOM)
    && measured.bridge !== declaredBridge,
  )
  const declarationResolves = Boolean(declaredBridge && measured.undecidableAtCap)
  const detectedBridge = declarationResolves ? declaredBridge : measured.bridge
  const bridgeSource = declarationResolves ? 'declared' : 'measured'

  const topology = {
    detectedBridge,
    reason: measured.reason,
    // Where this answer CAME FROM. A declared bridge is a human's answer to a question the data could
    // not settle, and every consumer of this report gets to see that rather than infer it.
    bridgeSource,
    declaredBridge,
    declarationContradictsMeasurement: declarationContradicts,
    measuredBridge: measured.bridge,
    undecidableAtCap: measured.undecidableAtCap,
    rowCap: SOURCE_PREFLIGHT_ROW_CAP,
    configuredBridge,
    matchesConfigured: detectedBridge === configuredBridge,
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
        // Every object that answered under this role, so the collapse to one carrier is auditable.
        contributingObjects: contributorsOf('orderDetail'),
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
        contributingObjects: contributorsOf('designBom'),
      },
    ],
  }

  // ---- CHECK 6: quantity slot ------------------------------------------------
  // The slots measured are the ones on the STORE the previous check resolved to — measuring the
  // configured table's slots when the source uses another store would report the wrong table's shape
  // and quietly agree with the very assumption that failed.
  //
  // When the store question came out CONFLICTED there is no carrier to measure and no honest quantity
  // answer to give. The measurement still runs against the preset-authoritative store so the evidence
  // is on screen, but `carrierUndecided` is set and NO mismatch is claimed from it: naming a
  // "configured field is wrong" against a table we are not sure is the production one is exactly the
  // confident-wrong-answer this whole revision exists to remove.
  const storeIsDesignBom = bomStore.store === BOM_STORES.DESIGN_BOM
  const carrierUndecided = bomStore.store === BOM_STORES.CONFLICTED
  const quantityCarrier = storeIsDesignBom ? designBom : bomDetail
  const quantityCarrierRows = storeIsDesignBom ? rowsOf('designBom') : rowsOf('bomDetail')
  const quantityCarrierShape = storeIsDesignBom ? designBomShape : bomDetailShape

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
  // THE DENSITY READING NEVER PICKS A WINNER OUT OF A FIELD.
  //
  // A BOM line's slots are not "one numeric column among text" — quantity, weight, length and price
  // are all numeric, and all of them clear the density floor. Taking `find()`'s first hit meant taking
  // whatever the sort happened to put on top, which is a GUESS wearing a measurement's name: with no
  // readable dictionary it could hand `quantity_field_mismatch` a confident, wrong column name and
  // send an implementer to change a correct configuration.
  //
  // So the same discipline the bridge decision follows applies here. Every slot clearing the floor is
  // a CANDIDATE; the reading resolves only when there is exactly one, or when the customer's own
  // dictionary names one of them — a dictionary is the customer's declaration about their own schema,
  // which is evidence, unlike a sort order. Otherwise the answer is "these are the candidates; we
  // cannot tell", and no mismatch is claimed.
  const qualifyingSlots = measuredSlots.filter((entry) => entry.numericRatio >= QUANTITY_NUMERIC_DENSITY_FLOOR)
  const dictionaryNamed = dictionaryDecode.slot
    ? qualifyingSlots.find((entry) => entry.column.toLowerCase() === dictionaryDecode.slot.toLowerCase()) || null
    : null
  const measuredSlot = qualifyingSlots.length === 1
    ? qualifyingSlots[0]
    : dictionaryNamed
  const measuredAmbiguous = qualifyingSlots.length > 1 && !dictionaryNamed

  const configuredQuantityField = plan.bomDetail.quantityField
  const resolvedSlot = dictionaryDecode.slot || (measuredSlot ? measuredSlot.column : null)
  const readingsDisagree = Boolean(
    dictionaryDecode.slot && measuredSlot
    && dictionaryDecode.slot.toLowerCase() !== measuredSlot.column.toLowerCase(),
  )
  const configuredAmongCandidates = Boolean(
    configuredQuantityField
    && qualifyingSlots.some((entry) => entry.column.toLowerCase() === configuredQuantityField.toLowerCase()),
  )

  // THE CARRIER MAY NOT HAVE COLUMNS TO MEASURE AT ALL.
  //
  // The real customer's DesignBom has no ExAttr columns whatsoever — its slots are JSON keys inside a
  // text blob. A column-only scan finds nothing there, and "nothing" renders as "no quantity", which
  // is wrong and misleading. So an addressable-slot-less carrier is reported as UNDETECTABLE, naming
  // the blob column and the vendor slot keys found inside it.
  //
  // Deliberately reported rather than parsed. Resolving a quantity out of JSON would mean deciding
  // WHICH key, with the dictionary decode mapping slot names to keys — a real feature, and a
  // half-built version of it is another confident wrong answer of exactly the kind being removed
  // here. The shipped read plan addresses columns; a JSON-embedded store is not readable by it, and
  // saying so plainly is the honest and actionable answer.
  const slotsUndetectable = quantityCarrier.present
    && quantityCarrierShape.shape === CARRIER_SHAPES.JSON_EMBEDDED

  const quantityField = {
    carrierObject: quantityCarrier.object,
    carrierStore: bomStore.store,
    carrierUndecided,
    carrierShape: quantityCarrierShape.shape,
    // Present only on a JSON-embedded carrier; identifiers only — the vendor's own slot keys, never a
    // customer value, with every other key counted and unnamed.
    jsonSlotColumn: quantityCarrierShape.jsonSlotColumn,
    jsonFamilySlotKeys: quantityCarrierShape.jsonFamilySlotKeys,
    jsonOtherKeyCount: quantityCarrierShape.jsonOtherKeyCount,
    jsonPopulatedSlotRows: quantityCarrierShape.jsonPopulatedSlotRows,
    slotsUndetectable,
    configuredField: configuredQuantityField,
    dictionaryObject,
    dictionaryReadable,
    dictionaryKeyColumn: dictionaryDecode.keyColumn,
    dictionaryEnabledRows: dictionaryDecode.enabledRows,
    dictionarySlot: dictionaryDecode.slot,
    measuredSlot: measuredSlot ? measuredSlot.column : null,
    measuredNumericRatio: measuredSlot ? measuredSlot.numericRatio : null,
    measuredCandidates: measuredSlots,
    // The slots that cleared the floor — the field the reading refused to choose from, when it did.
    qualifyingSlots: qualifyingSlots.map((entry) => entry.column),
    measuredAmbiguous,
    configuredAmongCandidates,
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
    // Suppressed when the resolved STORE is DesignBom: the classic head/detail pair being empty is
    // then the expected shape, not missing data. Keyed on the store rather than the bridge because
    // the store is what decides where lines legitimately live.
    if (!bomData.hasBomRows && bomStore.store !== BOM_STORES.DESIGN_BOM) {
      blockers.push({
        code: B.NO_BOM_ROWS,
        detail: { bomHeadRows: bomData.bomHeadRows, bomDetailRows: bomData.bomDetailRows },
      })
    }
    if (bomStore.store === BOM_STORES.CONFLICTED) {
      // Name BOTH stores and WHICH SIGNAL FAVOURS WHICH. A refusal that cannot say what disagreed is
      // just a shrug; this one hands over the whole disagreement.
      blockers.push({
        code: B.BOM_STORE_SIGNALS_CONFLICT,
        detail: {
          reason: bomStore.reason,
          signals: bomStore.signals,
          candidates: bomStore.candidates.map((entry) => ({
            store: entry.store,
            object: entry.object,
            lines: entry.lines,
            exact: entry.exact,
            shape: entry.shape,
          })),
          declarableBridges: [...DECLARABLE_BRIDGES],
        },
      })
    }
    if (declarationContradicts) {
      // Settled first, and settled by a human: the data says one thing and the operator declared
      // another, and no later question about this source means anything until that is reconciled.
      blockers.push({
        code: B.DECLARED_BRIDGE_CONTRADICTS_MEASUREMENT,
        detail: {
          declaredBridge,
          measuredBridge: measured.bridge,
          reason: measured.reason,
          orderLines: orderDetail.rowsObserved,
          designBomLines: designBom.rowsObserved,
        },
      })
    } else if (measured.bridge === BRIDGES.NONE) {
      blockers.push({ code: B.NO_BOM_BRIDGE, detail: { reason: measured.reason } })
    } else if (measured.undecidableAtCap && !declarationResolves) {
      // DISTINGUISHABLE from a genuine tie, and ACTIONABLE: the detail carries the cap that produced
      // the standoff and the declaration that would resolve it.
      blockers.push({
        code: B.BRIDGE_UNDECIDABLE_AT_CAP,
        detail: {
          rowCap: SOURCE_PREFLIGHT_ROW_CAP,
          orderLines: orderDetail.rowsObserved,
          orderLineObject: orderDetail.object,
          designBomLines: designBom.rowsObserved,
          designBomLineObject: designBom.object,
          declarableBridges: [...DECLARABLE_BRIDGES],
        },
      })
    } else if (detectedBridge === BRIDGES.AMBIGUOUS) {
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
          detectedBridge,
          configuredLineObject: plan.orderDetail.object,
          detectedLineObject: detectedBridge === BRIDGES.DESIGN_BOM ? designBom.object : orderDetail.object,
        },
      })
    }

    if (declarationResolves) {
      warnings.push({
        code: W.BRIDGE_DECLARED_NOT_MEASURED,
        detail: { declaredBridge, rowCap: SOURCE_PREFLIGHT_ROW_CAP },
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
    if (slotsUndetectable) {
      warnings.push({
        code: W.QUANTITY_FIELD_UNDETECTABLE_ON_CARRIER,
        detail: {
          carrierObject: quantityCarrier.object,
          carrierShape: quantityCarrierShape.shape,
          jsonSlotColumn: quantityCarrierShape.jsonSlotColumn,
          jsonFamilySlotKeys: quantityCarrierShape.jsonFamilySlotKeys,
          jsonPopulatedSlotRows: quantityCarrierShape.jsonPopulatedSlotRows,
        },
      })
    } else if (measuredAmbiguous && !resolvedSlot) {
      // Several plausible carriers and nothing to break the tie. Naming one here is exactly the guess
      // this module refuses everywhere else, so it names the FIELD instead — and deliberately emits no
      // mismatch, because a mismatch claims to know the right answer.
      warnings.push({
        code: W.QUANTITY_FIELD_AMBIGUOUS,
        detail: {
          carrierObject: quantityCarrier.object,
          candidates: quantityField.qualifyingSlots,
          configuredField: configuredQuantityField,
          configuredAmongCandidates,
        },
      })
    } else if (!resolvedSlot) {
      warnings.push({ code: W.QUANTITY_FIELD_UNRESOLVED, detail: { carrierObject: quantityCarrier.object } })
    } else if (!quantityField.matchesConfigured && !carrierUndecided) {
      // Suppressed while the STORE is unresolved: "your configured quantity column is wrong" is a
      // claim about a specific table, and we do not yet know which table the deployment should read.
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
      bomStore,
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
  // JSON-embedded slot keys are schema, not content — but they are not COLUMNS of any probed table,
  // so they would not otherwise earn the identifier exemption. Only keys matching the vendor's own
  // slot-family pattern ever reach the report, and only those are added here.
  for (const shape of [bomDetailShape, designBomShape]) {
    for (const key of shape.jsonFamilySlotKeys) identifiers.add(key)
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
    ['reason', new Set([...BRIDGE_DECISION_REASONS, ...PRESET_SELECTION_REASONS, ...BOM_STORE_DECISION_REASONS])],
    ['errorCode', new Set(SOURCE_PREFLIGHT_READ_ERROR_CODES)],
    ['failureCode', new Set(SOURCE_PREFLIGHT_READ_ERROR_CODES)],
    ['bridge', new Set(SOURCE_PREFLIGHT_BRIDGES)],
    ['detectedBridge', new Set(SOURCE_PREFLIGHT_BRIDGES)],
    ['configuredBridge', new Set(SOURCE_PREFLIGHT_BRIDGES)],
    ['measuredBridge', new Set(SOURCE_PREFLIGHT_BRIDGES)],
    // Re-validated here, at the boundary, even though the runner already filtered it: this is the one
    // closed-vocabulary leaf whose value originates in a REQUEST, and the self-check is the last thing
    // that runs before the report leaves.
    ['declaredBridge', new Set(DECLARABLE_BRIDGES)],
    ['declarableBridges', new Set(DECLARABLE_BRIDGES)],
    ['bridgeSource', new Set(['measured', 'declared'])],
    ['role', new Set(PROBE_ROLES)],
    ['store', new Set(SOURCE_PREFLIGHT_BOM_STORES)],
    ['carrierStore', new Set(SOURCE_PREFLIGHT_BOM_STORES)],
    ['favours', new Set(SOURCE_PREFLIGHT_BOM_STORES)],
    ['signal', new Set(BOM_STORE_SIGNALS)],
    ['signals', new Set(BOM_STORE_SIGNALS)],
    ['strongSignals', new Set(STRONG_BOM_STORE_SIGNALS)],
    ['shape', new Set(SOURCE_PREFLIGHT_CARRIER_SHAPES)],
    ['carrierShape', new Set(SOURCE_PREFLIGHT_CARRIER_SHAPES)],
    ['authorityBasis', new Set(['preset-bom-line-quantity-role'])],
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
  SOURCE_PREFLIGHT_BOM_STORES,
  SOURCE_PREFLIGHT_CARRIER_SHAPES,
  BOM_STORE_SIGNALS,
  STRONG_BOM_STORE_SIGNALS,
  DECLARABLE_BRIDGES,
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
    decideBomStore,
    classifyCarrierShape,
    detectJsonEmbeddedSlots,
    bomLineQuantityFamily,
    decodeQuantitySlotFromDictionary,
    measureNumericSlots,
    planAssumedBridge,
    probeObject,
  },
}
