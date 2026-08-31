'use strict'

/**
 * SOURCE VENDOR PRESET SCHEMA — the contract for the PLM/ERP vendor preset catalog that
 * `scripts/ops/source-discovery-probe.mjs` (and its preset-consuming extension) reads to turn a
 * cold source-discovery run into a machine-drafted mapping a human CONFIRMS instead of authors.
 *
 * ── THE ONE RULE EVERYTHING HERE ENFORCES: DISCOVER, NEVER DISCOVERED ───────────────────────────
 *
 * A preset encodes HOW TO DISCOVER a vendor family's semantics, never WHAT WAS DISCOVERED at any
 * customer. The vendor family this catalog exists for ships a per-customer dictionary mechanism:
 * physical column names carry ZERO semantics (generic numbered slots), and the MEANING of each
 * slot is configured in the vendor's own dictionary tables, per customer. Therefore:
 *
 *   VENDOR-GENERIC (belongs in a preset, committable):
 *     - core table names and join topology (product schema, same at every customer);
 *     - WHICH tables are the dictionaries and HOW to read them (rows name columns; enabled flag);
 *     - the RULE that a given semantic (e.g. a BOM line's quantity) lives in some
 *       dictionary-assigned slot of a generic column family, plus CLOSED-ENUM hints for ranking;
 *     - identifier / version / sort conventions of the product.
 *
 *   CUSTOMER-SPECIFIC (must NEVER be in a preset; the probe reads it from the customer's own
 *   dictionary tables at run time):
 *     - WHICH concrete slot carries which meaning (that is a row of the customer's dictionary);
 *     - option vocabularies, business values, observed enablement states, connection/runtime
 *       values, and any proper names.
 *
 * The schema makes smuggling STRUCTURAL. An adversarial review of the first cut EXECUTED several
 * smuggles through channels that prose alone had declared closed; each mechanism below exists
 * because a specific attack got through without it, and each is pinned by a refusing regression
 * test carrying the attack's exact fragment:
 *
 *   1. NO FREE-FORM REGEX ANYWHERE. presetVersion 1 has zero pattern-typed fields. A generic
 *      column family is declared STRUCTURED — { stems, indexMin, indexMax } — and its matcher is
 *      GENERATED (familyColumnMatcher), so a "family" cannot be authored as a single-member
 *      language ('^Slot7$'): a stem must not end in a digit, indexMin must be 0 or 1 (an offset
 *      would encode WHERE the interesting slots sit), and cardinality must be at least
 *      FAMILY_MIN_CARDINALITY. The enabled flag is a list of identifier candidates, not a regex.
 *   2. THE CONCRETE-MEMBER SCAN IS UNCONDITIONAL AND TOTAL. genericColumnFamilies is REQUIRED
 *      (an undeclared family was the first cut's bypass: the scan only policed families the
 *      preset chose to declare). Every string leaf — notes, ids, every nested level, with NO
 *      key-name exemptions — is scanned for stem+digit of every declared stem AND of every
 *      stem's underscore-stripped base (narrowing 'Part_ExAttr' cannot exempt bare 'ExAttr9'),
 *      and a second RAW-TEXT pass over the serialized preset catches carriers the leaf walk
 *      cannot see (e.g. a role-map KEY).
 *   3. HINT CHANNEL: CLOSED ENUMS, VOCABULARY IN CODE. Free-form hint patterns were the one
 *      string slot no scan touched, and an executed attack parked both a concrete slot and an
 *      option vocabulary there. v1 keeps hints but as enums (labelHint / dictionaryTypeHint);
 *      the actual word lists live HERE (LABEL_HINT_VOCABULARY / DICTIONARY_TYPE_HINT_WORDS) and
 *      in the probe — code, not data. An enum cannot smuggle. The value-set table family is the
 *      same structured shape as a column family.
 *   4. NOTES ARE HARD-CAPPED (NOTES_MAX_COUNT / NOTE_MAX_LENGTH) and the whole document is
 *      byte-capped (PRESET_MAX_JSON_BYTES); every note passes the full leak + concrete-member
 *      scans. RESIDUAL, stated honestly: a proper name (company, plant, person) inside a short
 *      note is NOT mechanically detectable — that channel is review-gated, and the stem scans at
 *      least catch any note that names a concrete slot or value-set table.
 *   5. VALUE-SHAPE REJECTION over every string leaf: connection strings, database URLs, bare
 *      IPv4, IPv6, bare FQDN hostnames, credential material / credential file paths, and
 *      probe-env assignments are refused naming the offending path but never echoing the
 *      content. The vocabulary MIRRORS the probe's own leak guard (`ENV_VAR_NAMES`,
 *      `isBareIpAddress`, `assertValuesFree` in scripts/ops/source-discovery-probe.mjs) — keep
 *      the two aligned when either grows; do not invent a third vocabulary.
 *   6. STRICT PER-VERSION KEY ALLOWLISTS at EVERY nesting depth (each depth pinned by its own
 *      refusing test), and any key shaped like a value carrier (`default*`, `value(s)`,
 *      `sample*`, `example*`, `data`, `rows`…) is refused with its own coded reason before the
 *      allowlist speaks.
 *
 * ── IDENTITY: SIGNATURE, NOT BRAND ──────────────────────────────────────────────────────────────
 *
 * A preset is keyed by a DETECTABLE SIGNATURE — the table-name family it matches against a live
 * catalog (`matches.signatureTables` + `matches.minSignatureTablesPresent`) — never by vendor
 * brand or customer name. No company names belong in this repository; the presetId names the
 * table-name family (e.g. `dn-pdm-family`). Selection is fail-closed: a catalog that does not
 * meet a preset's own confidence floor selects nothing, and MORE THAN ONE preset clearing its
 * floor selects nothing (AMBIGUOUS) regardless of match counts — a count race is not a
 * disambiguator; a future legitimate-superset case must earn an explicit priority mechanism.
 * Matching is case-insensitive because the same schema is CamelCase on SQL Server and folded to
 * lower case on PostgreSQL (see scripts/ops/fixtures/stock-prep-synthetic-plm/schema.sql).
 *
 * ── VERSIONING: `presetVersion`, ADDITIVE EVOLUTION ─────────────────────────────────────────────
 *
 * Every preset file is self-describing: `presetSchema` is the fixed marker string and
 * `presetVersion` an integer from SUPPORTED_PRESET_VERSIONS. Because the allowlists are strict
 * (they are the anti-smuggling mechanism), evolution is BY VERSION, not by tolerated unknowns:
 * adding a field means adding version N with a widened allowlist here, keeping every version
 * <= N accepted unchanged (additive — a v1 file stays valid forever). A version this module does
 * not know is refused naming the versions it accepts; consumers must treat that refusal as
 * "upgrade the reader", never as "skip validation".
 *
 * Consumed by: scripts/ops/source-discovery-probe.mjs (preset auto-selection + directed
 * dictionary reads; coordinated via this file shape — the probe may import this module or mirror
 * `evaluatePresetMatch`/`familyColumnMatcher` exactly). Preset files live next to this module as
 * `*.preset.json`.
 */

const fs = require('node:fs')
const path = require('node:path')

const SOURCE_VENDOR_PRESET_SCHEMA_MARKER = 'metasheet.source-vendor-preset'
const SUPPORTED_PRESET_VERSIONS = Object.freeze([1])
const PRESET_FILE_SUFFIX = '.preset.json'

/**
 * Fail-closed floor for `matches.minSignatureTablesPresent`. A one- or two-table signature would
 * select on generic noise (`orders`, `parts` exist everywhere); three distinctly-named tables is
 * the smallest signature that identifies a product family rather than a coincidence.
 */
const SIGNATURE_MATCH_FLOOR = 3

/**
 * Minimum members of a structured generic column family (indexMax - indexMin + 1). A "family"
 * narrower than this is a pointer to specific slots — i.e. discovered per-customer data wearing
 * a structural coat. The real families this schema exists for run 30-70 slots wide.
 */
const FAMILY_MIN_CARDINALITY = 10

/** Whole-document byte cap on the serialized preset. A preset is a mechanism declaration; bulk
 * is a smuggling surface (an executed attack carried 12KB of prose in notes). */
const PRESET_MAX_JSON_BYTES = 16384

const VENDOR_PRESET_ERROR_CODES = Object.freeze({
  PRESET_NOT_AN_OBJECT: 'PRESET_NOT_AN_OBJECT',
  PRESET_SCHEMA_MARKER_INVALID: 'PRESET_SCHEMA_MARKER_INVALID',
  PRESET_VERSION_UNSUPPORTED: 'PRESET_VERSION_UNSUPPORTED',
  PRESET_ID_INVALID: 'PRESET_ID_INVALID',
  PRESET_KEY_UNKNOWN: 'PRESET_KEY_UNKNOWN',
  PRESET_FIELD_INVALID: 'PRESET_FIELD_INVALID',
  PRESET_MATCHES_INVALID: 'PRESET_MATCHES_INVALID',
  PRESET_IDENTIFIER_INVALID: 'PRESET_IDENTIFIER_INVALID',
  PRESET_FAMILY_INVALID: 'PRESET_FAMILY_INVALID',
  PRESET_ROLE_REF_INVALID: 'PRESET_ROLE_REF_INVALID',
  PRESET_VALUE_KEY_REJECTED: 'PRESET_VALUE_KEY_REJECTED',
  PRESET_CONCRETE_SLOT_REJECTED: 'PRESET_CONCRETE_SLOT_REJECTED',
  PRESET_VALUE_SHAPE_REJECTED: 'PRESET_VALUE_SHAPE_REJECTED',
})

// ---------------------------------------------------------------------------
// Shapes and small vocabularies.
// ---------------------------------------------------------------------------

/** SQL-identifier shape. Blocks dots, spaces, `=`, `:`, `/` — a connection value structurally
 * cannot occupy an identifier position. */
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
const IDENTIFIER_MAX_LENGTH = 128

/** A family stem: identifier charset, 3..64 chars, and it must NOT end in a digit — a stem
 * ending in a digit IS a concrete slot prefix (`Slot7` + range would name slot 7x). */
const FAMILY_STEM = /^[A-Za-z_][A-Za-z0-9_]{1,62}[A-Za-z_]$/
const FAMILY_STEMS_MAX = 4
const FAMILY_INDEX_MAX_BOUND = 9999

/** presetId / dictionary id / semantic id: lowercase kebab, names a FAMILY, never a company. */
const KEBAB_ID = /^[a-z][a-z0-9-]{2,63}$/

/** Role keys inside coreTables / genericColumnFamilies: lowerCamel. */
const ROLE_NAME = /^[a-z][A-Za-z0-9]*$/

const NOTE_MAX_LENGTH = 300
const NOTES_MAX_COUNT = 6
const SIGNATURE_TABLES_MAX = 64
const ENABLED_FLAG_CANDIDATES_MAX = 4

/**
 * Keys that are value carriers by shape. A preset declares HOW TO DISCOVER, so no field of it may
 * be named like it holds WHAT WAS DISCOVERED. Checked before the allowlist so the refusal carries
 * this rule, not a generic "unknown key".
 */
const VALUE_CARRIER_KEY = /^(?:defaults?|values?|samples?|examples?|literals?|seeds?|rows?|data)$|^(?:default|sample|example|literal|seed)[A-Z_]/

// ---------------------------------------------------------------------------
// Closed-enum hint vocabulary. The WORDS live here (and mirrored in the probe)
// — code, not preset data — so the hint channel cannot carry a vocabulary or a
// concrete slot. Extending the enum is a code change reviewed like any other.
// ---------------------------------------------------------------------------

const LABEL_HINT_VOCABULARY = Object.freeze({
  quantity: /数量|qty|quantity/i,
  unit: /单位|unit/i,
  'material-code': /物料编码|matcode|material/i,
})

const DICTIONARY_TYPE_HINTS = Object.freeze(['numeric', 'list', 'text'])
const DICTIONARY_TYPE_HINT_WORDS = Object.freeze({
  numeric: /float|numeric|decimal|double|real|int/i,
  list: /list|enum|select/i,
  text: /text|char|string/i,
})

// ---------------------------------------------------------------------------
// Value-shape leak vocabulary — MIRRORS scripts/ops/source-discovery-probe.mjs
// (ENV_VAR_NAMES, isBareIpAddress, assertValuesFree). Keep aligned; do not fork.
// ---------------------------------------------------------------------------

const VALUE_SHAPE_PATTERNS = Object.freeze([
  Object.freeze({
    shape: 'connection-string',
    pattern: /(?:^|[;,\s"'])(?:server|data\s*source|address|database|initial\s*catalog|user\s*id|uid|pwd|password|trusted_connection|integrated\s*security)\s*=/i,
  }),
  Object.freeze({
    shape: 'database-url',
    pattern: /\b(?:mssql|sqlserver|jdbc|odbc|postgres(?:ql)?|mysql|mariadb|oracle|tds|tcp):\/\//i,
  }),
  Object.freeze({
    // Probe's isBareIpAddress, unanchored so a dotted quad inside prose is caught too.
    shape: 'bare-ip-address',
    pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
  }),
  Object.freeze({
    // Compressed (with '::') and full (4+ hextet) IPv6 forms. Clock times (two colons) and
    // ordinary prose ratios do not match; a bare 'fe80::' with no tail is accepted as the cost
    // of not flagging every '::' in code-like prose.
    shape: 'ipv6-address',
    pattern: /(?:^|[\s"'=[])(?:(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|::[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){4,}[0-9a-f]{1,4})/i,
  }),
  Object.freeze({
    // Bare FQDN with a real-world or intranet TLD. Repo-relative file paths and dotted plan ids
    // do not match (their final segment is not in the TLD set).
    shape: 'bare-hostname',
    pattern: /\b[a-z0-9][a-z0-9-]{0,62}(?:\.[a-z0-9][a-z0-9-]{0,62})*\.(?:com|net|org|io|co|cn|de|fr|jp|uk|us|ru|in|edu|gov|mil|info|biz|cloud|dev|app|ai|internal|local|corp|lan|intra|example)\b/i,
  }),
  Object.freeze({
    // The probe's own connection env vars (ENV_VAR_NAMES). Naming a variable is documentation;
    // ASSIGNING one is a value.
    shape: 'probe-env-assignment',
    pattern: /\bPROBE_MSSQL_(?:SERVER|PORT|DATABASE|USER|PASSWORD)\s*[:=]/,
  }),
  Object.freeze({
    shape: 'credential-material',
    pattern: /\b(?:password|passwd|secret|token|credential|api[_-]?key)s?\s*[:=]/i,
  }),
  Object.freeze({
    shape: 'credential-file-path',
    pattern: /\.(?:pem|pfx|p12|ppk|jks|keytab)\b|(?:^|[\s"'=(])(?:[A-Za-z]:\\|\\\\|\/(?:etc|home|root|var|run|srv)\/)/i,
  }),
])

/**
 * First matching value-shape class for a string, or null. Exported so tests can pin each class
 * and so the probe-side consumer can reuse the identical vocabulary.
 */
function findValueShapeViolation(text) {
  const s = String(text)
  for (const entry of VALUE_SHAPE_PATTERNS) {
    if (entry.pattern.test(s)) return { shape: entry.shape }
  }
  return null
}

// ---------------------------------------------------------------------------
// Version 1 key allowlists. Evolution is additive BY VERSION (see header):
// a new field means a new version with its own widened table here. EVERY depth
// is pinned by a refusing test — loosening a nested list is a visible RED.
// ---------------------------------------------------------------------------

const V1_KEYS = Object.freeze({
  top: Object.freeze([
    'presetSchema',
    'presetVersion',
    'presetId',
    'title',
    'dialects',
    'matches',
    'genericColumnFamilies',
    'coreTables',
    'joins',
    'dictionaries',
    'semanticExpectations',
    'conventions',
    'notes',
  ]),
  matches: Object.freeze(['kind', 'signatureTables', 'minSignatureTablesPresent', 'note']),
  family: Object.freeze(['onRole', 'stems', 'indexMin', 'indexMax', 'note']),
  tableFamily: Object.freeze(['stems', 'indexMin', 'indexMax', 'note']),
  coreTable: Object.freeze(['table', 'roles', 'optionalRoles', 'note']),
  join: Object.freeze(['fromRole', 'fromColumn', 'toRole', 'toColumn', 'note']),
  dictionary: Object.freeze(['id', 'table', 'labelsColumnsOfRole', 'columnFamily', 'mechanism', 'enabledFlag', 'note']),
  enabledFlag: Object.freeze(['columnCandidates', 'polarity', 'note']),
  semanticExpectation: Object.freeze([
    'semantic',
    'locus',
    'columnFamily',
    'dictionary',
    'dictionaryTypeHint',
    'labelHint',
    'valueSetTableFamily',
    'role',
    'roleColumn',
    'note',
  ]),
  conventions: Object.freeze(['objectIdColumn', 'versionColumn', 'versionRule', 'sortColumn', 'hierarchy', 'bomActiveFilter', 'note']),
  hierarchy: Object.freeze(['role', 'idColumn', 'parentIdColumn', 'shape', 'note']),
  bomActiveFilter: Object.freeze(['role', 'column', 'rule', 'presence', 'note']),
})

const DICTIONARY_MECHANISMS = Object.freeze(['rows-name-columns'])
const ENABLED_FLAG_POLARITIES = Object.freeze(['zero-means-enabled', 'nonzero-means-enabled'])
const SEMANTIC_LOCI = Object.freeze(['dictionary-assigned-column', 'native-column'])
const MATCH_KINDS = Object.freeze(['table-name-signature'])
const PRESENCE_VALUES = Object.freeze(['always', 'verify-live-before-use'])

// ---------------------------------------------------------------------------
// Error collection helpers. Every refusal is coded AND names the acceptable form.
// ---------------------------------------------------------------------------

function makeCollector() {
  const errors = []
  return {
    errors,
    add(code, atPath, message) {
      errors.push({ code, path: atPath, message: `${code} at ${atPath}: ${message}` })
    },
  }
}

function checkKeys(collector, obj, atPath, allowed) {
  for (const key of Object.keys(obj)) {
    if (VALUE_CARRIER_KEY.test(key)) {
      collector.add(
        VENDOR_PRESET_ERROR_CODES.PRESET_VALUE_KEY_REJECTED,
        `${atPath}.${key}`,
        `a preset declares HOW TO DISCOVER, never WHAT WAS DISCOVERED — a key named like a value ` +
          `carrier is refused. Acceptable: structural keys only (${allowed.join(', ')}); the ` +
          `concrete assignment this key looks like it holds is per-customer dictionary data the ` +
          `probe reads at run time.`,
      )
    } else if (!allowed.includes(key)) {
      collector.add(
        VENDOR_PRESET_ERROR_CODES.PRESET_KEY_UNKNOWN,
        `${atPath}.${key}`,
        `unknown key for presetVersion 1. Acceptable keys here: ${allowed.join(', ')}. New fields ` +
          `require a new presetVersion with a widened allowlist (additive evolution), never a ` +
          `tolerated unknown.`,
      )
    }
  }
}

function checkIdentifier(collector, value, atPath) {
  if (typeof value !== 'string' || value.length === 0 || value.length > IDENTIFIER_MAX_LENGTH || !SQL_IDENTIFIER.test(value)) {
    collector.add(
      VENDOR_PRESET_ERROR_CODES.PRESET_IDENTIFIER_INVALID,
      atPath,
      `must be a SQL-identifier-shaped string (${SQL_IDENTIFIER}, at most ${IDENTIFIER_MAX_LENGTH} ` +
        `chars). Connection values, addresses and paths structurally cannot occupy an identifier position.`,
    )
    return false
  }
  return true
}

function checkNote(collector, value, atPath) {
  if (value === undefined) return
  if (typeof value !== 'string' || value.length === 0 || value.length > NOTE_MAX_LENGTH) {
    collector.add(
      VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID,
      atPath,
      `must be a non-empty string of at most ${NOTE_MAX_LENGTH} chars — bulk prose is a smuggling ` +
        `surface; cite a repo doc instead of restating observations`,
    )
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Walks every string leaf (values only — object KEYS are covered by the raw-text pass),
 * reporting the leaf's path. */
function walkStringLeaves(value, atPath, visit) {
  if (typeof value === 'string') {
    visit(value, atPath)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkStringLeaves(item, `${atPath}[${index}]`, visit))
    return
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      walkStringLeaves(child, `${atPath}.${key}`, visit)
    }
  }
}

function escapeForRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// Structured generic column families — pattern GENERATED, never authored.
// ---------------------------------------------------------------------------

/**
 * Validates one structured family `{ stems, indexMin, indexMax }` (with `onRole` when
 * `requireOnRole`). Returns the stems array when structurally sound enough to scan with,
 * else null. Refusals name the acceptable form.
 */
function validateStructuredFamily(collector, family, atPath, { coreTables, requireOnRole }) {
  if (!isPlainObject(family)) {
    collector.add(
      VENDOR_PRESET_ERROR_CODES.PRESET_FAMILY_INVALID,
      atPath,
      `must be a structured family object { ${requireOnRole ? 'onRole, ' : ''}stems, indexMin, indexMax, note? } — ` +
        `presetVersion 1 has no free-form pattern fields; the matcher is generated from the structure`,
    )
    return null
  }
  checkKeys(collector, family, atPath, requireOnRole ? V1_KEYS.family : V1_KEYS.tableFamily)
  checkNote(collector, family.note, `${atPath}.note`)
  if (requireOnRole && (!coreTables || !isPlainObject(coreTables[family.onRole]))) {
    collector.add(
      VENDOR_PRESET_ERROR_CODES.PRESET_ROLE_REF_INVALID,
      `${atPath}.onRole`,
      `must name a declared coreTables role (declared: ${Object.keys(coreTables || {}).join(', ')})`,
    )
  }

  let stems = null
  if (!Array.isArray(family.stems) || family.stems.length === 0 || family.stems.length > FAMILY_STEMS_MAX) {
    collector.add(
      VENDOR_PRESET_ERROR_CODES.PRESET_FAMILY_INVALID,
      `${atPath}.stems`,
      `must be an array of 1..${FAMILY_STEMS_MAX} stem strings (e.g. spelling variants of one slot prefix)`,
    )
  } else {
    stems = []
    const seen = new Set()
    family.stems.forEach((stem, index) => {
      const stemPath = `${atPath}.stems[${index}]`
      if (typeof stem !== 'string' || !FAMILY_STEM.test(stem)) {
        collector.add(
          VENDOR_PRESET_ERROR_CODES.PRESET_FAMILY_INVALID,
          stemPath,
          `each stem must match ${FAMILY_STEM} (identifier charset, 3..64 chars, NOT ending in a ` +
            `digit — a stem ending in a digit IS a concrete slot prefix)`,
        )
        return
      }
      const lower = stem.toLowerCase()
      if (seen.has(lower)) {
        collector.add(VENDOR_PRESET_ERROR_CODES.PRESET_FAMILY_INVALID, stemPath, `duplicate (case-insensitive) stem`)
        return
      }
      seen.add(lower)
      stems.push(stem)
    })
    if (stems.length === 0) stems = null
  }

  const { indexMin, indexMax } = family
  if (indexMin !== 0 && indexMin !== 1) {
    collector.add(
      VENDOR_PRESET_ERROR_CODES.PRESET_FAMILY_INVALID,
      `${atPath}.indexMin`,
      `must be 0 or 1 — a generic slot family is numbered from its base; a chosen offset would ` +
        `encode WHERE the interesting slots sit, which is discovered per-customer data`,
    )
  }
  if (!Number.isInteger(indexMax) || indexMax > FAMILY_INDEX_MAX_BOUND || !Number.isInteger(indexMin) || indexMax < indexMin) {
    collector.add(
      VENDOR_PRESET_ERROR_CODES.PRESET_FAMILY_INVALID,
      `${atPath}.indexMax`,
      `must be an integer >= indexMin and <= ${FAMILY_INDEX_MAX_BOUND} (a discovery iteration bound)`,
    )
  } else if (indexMax - indexMin + 1 < FAMILY_MIN_CARDINALITY) {
    collector.add(
      VENDOR_PRESET_ERROR_CODES.PRESET_FAMILY_INVALID,
      `${atPath}.indexMax`,
      `family cardinality (indexMax - indexMin + 1) must be at least ${FAMILY_MIN_CARDINALITY} — a ` +
        `narrower range is a pointer to specific slots, i.e. discovered per-customer data; a real ` +
        `generic slot family is wide by construction`,
    )
  }

  return stems
}

/** Generated matcher for one structured family: anchored, case-insensitive, stems alternated. */
function familyColumnMatcher(family) {
  const stems = Array.isArray(family && family.stems) ? family.stems : []
  return new RegExp(`^(?:${stems.map(escapeForRegExp).join('|')})([0-9]{1,4})$`, 'i')
}

/** Whether a live column name is a member of a structured family (stem match + index range). */
function isFamilyColumn(family, columnName) {
  const match = familyColumnMatcher(family).exec(String(columnName))
  if (!match) return false
  const index = Number(match[1])
  return Number.isInteger(index) && index >= family.indexMin && index <= family.indexMax
}

/**
 * Concrete-member scanners for a stem set: one per stem AND one per stem's underscore-stripped
 * base (>= 3 chars). The base scanner is what defeats the narrowing bypass — a preset that
 * declares only 'Part_ExAttr' still cannot carry bare 'ExAttr9' anywhere.
 */
function buildConcreteMemberScanners(stems) {
  const sources = new Set()
  for (const stem of stems) {
    sources.add(stem.toLowerCase())
    const base = stem.includes('_') ? stem.slice(stem.lastIndexOf('_') + 1) : stem
    if (base.length >= 3) sources.add(base.toLowerCase())
  }
  return [...sources].map((source) => ({ stem: source, regex: new RegExp(`${escapeForRegExp(source)}[0-9]`, 'i') }))
}

// ---------------------------------------------------------------------------
// The validator.
// ---------------------------------------------------------------------------

function declaredRoleColumns(coreTableEntry) {
  const columns = []
  if (isPlainObject(coreTableEntry)) {
    for (const map of [coreTableEntry.roles, coreTableEntry.optionalRoles]) {
      if (isPlainObject(map)) {
        for (const value of Object.values(map)) {
          if (typeof value === 'string') columns.push(value)
        }
      }
    }
  }
  return columns
}

function validateVendorPreset(preset) {
  const collector = makeCollector()
  const { errors } = collector

  if (!isPlainObject(preset)) {
    collector.add(
      VENDOR_PRESET_ERROR_CODES.PRESET_NOT_AN_OBJECT,
      '$',
      `must be a plain object with presetSchema '${SOURCE_VENDOR_PRESET_SCHEMA_MARKER}' and an ` +
        `integer presetVersion from [${SUPPORTED_PRESET_VERSIONS.join(', ')}]`,
    )
    return { ok: false, errors }
  }

  let serialized = null
  try {
    serialized = JSON.stringify(preset)
  } catch {
    collector.add(VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID, '$', 'must be JSON-serializable (no cycles)')
    return { ok: false, errors }
  }
  if (Buffer.byteLength(serialized, 'utf8') > PRESET_MAX_JSON_BYTES) {
    collector.add(
      VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID,
      '$',
      `serialized preset exceeds ${PRESET_MAX_JSON_BYTES} bytes — a preset is a mechanism ` +
        `declaration, not a document; move prose to a cited repo doc`,
    )
  }

  // Envelope first: an unsupported version must be refused BEFORE key allowlists, because a later
  // version legitimately carries keys this validator does not know.
  if (preset.presetSchema !== SOURCE_VENDOR_PRESET_SCHEMA_MARKER) {
    collector.add(
      VENDOR_PRESET_ERROR_CODES.PRESET_SCHEMA_MARKER_INVALID,
      '$.presetSchema',
      `must be exactly '${SOURCE_VENDOR_PRESET_SCHEMA_MARKER}' (the self-describing marker the ` +
        `probe keys on)`,
    )
  }
  if (!Number.isInteger(preset.presetVersion) || !SUPPORTED_PRESET_VERSIONS.includes(preset.presetVersion)) {
    collector.add(
      VENDOR_PRESET_ERROR_CODES.PRESET_VERSION_UNSUPPORTED,
      '$.presetVersion',
      `must be an integer from the supported set [${SUPPORTED_PRESET_VERSIONS.join(', ')}]. A ` +
        `newer version means: upgrade this validator (additive evolution), never skip validation.`,
    )
    return { ok: false, errors }
  }
  if (typeof preset.presetId !== 'string' || !KEBAB_ID.test(preset.presetId)) {
    collector.add(
      VENDOR_PRESET_ERROR_CODES.PRESET_ID_INVALID,
      '$.presetId',
      `must match ${KEBAB_ID} and name the detectable TABLE-NAME FAMILY the preset matches ` +
        `(e.g. 'dn-pdm-family') — never a vendor brand or customer name.`,
    )
  }

  checkKeys(collector, preset, '$', V1_KEYS.top)

  if (preset.title !== undefined && (typeof preset.title !== 'string' || preset.title.length === 0 || preset.title.length > 120)) {
    collector.add(VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID, '$.title', 'must be a non-empty string of at most 120 chars')
  }

  if (!Array.isArray(preset.dialects) || preset.dialects.length === 0) {
    collector.add(
      VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID,
      '$.dialects',
      `must be a non-empty array of lowercase dialect ids (e.g. ['mssql'])`,
    )
  } else {
    preset.dialects.forEach((dialect, index) => {
      if (typeof dialect !== 'string' || !/^[a-z][a-z0-9-]*$/.test(dialect)) {
        collector.add(VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID, `$.dialects[${index}]`, `must match ^[a-z][a-z0-9-]*$ (e.g. 'mssql')`)
      }
    })
  }

  // -- matches ---------------------------------------------------------------
  if (!isPlainObject(preset.matches)) {
    collector.add(
      VENDOR_PRESET_ERROR_CODES.PRESET_MATCHES_INVALID,
      '$.matches',
      `must be an object { kind: 'table-name-signature', signatureTables: [...], ` +
        `minSignatureTablesPresent: n } — the preset's detectable identity`,
    )
  } else {
    checkKeys(collector, preset.matches, '$.matches', V1_KEYS.matches)
    checkNote(collector, preset.matches.note, '$.matches.note')
    if (!MATCH_KINDS.includes(preset.matches.kind)) {
      collector.add(
        VENDOR_PRESET_ERROR_CODES.PRESET_MATCHES_INVALID,
        '$.matches.kind',
        `must be one of [${MATCH_KINDS.join(', ')}] (the only selection mechanism presetVersion 1 defines)`,
      )
    }
    const tables = preset.matches.signatureTables
    if (!Array.isArray(tables) || tables.length < SIGNATURE_MATCH_FLOOR || tables.length > SIGNATURE_TABLES_MAX) {
      collector.add(
        VENDOR_PRESET_ERROR_CODES.PRESET_MATCHES_INVALID,
        '$.matches.signatureTables',
        `must be an array of ${SIGNATURE_MATCH_FLOOR}..${SIGNATURE_TABLES_MAX} table names — fewer ` +
          `than ${SIGNATURE_MATCH_FLOOR} cannot identify a product family`,
      )
    } else {
      const seen = new Set()
      tables.forEach((table, index) => {
        if (checkIdentifier(collector, table, `$.matches.signatureTables[${index}]`)) {
          const lower = table.toLowerCase()
          if (seen.has(lower)) {
            collector.add(
              VENDOR_PRESET_ERROR_CODES.PRESET_MATCHES_INVALID,
              `$.matches.signatureTables[${index}]`,
              `duplicate (case-insensitive) signature table — each entry must be unique`,
            )
          }
          seen.add(lower)
        }
      })
      const min = preset.matches.minSignatureTablesPresent
      if (!Number.isInteger(min) || min < SIGNATURE_MATCH_FLOOR || min > tables.length) {
        collector.add(
          VENDOR_PRESET_ERROR_CODES.PRESET_MATCHES_INVALID,
          '$.matches.minSignatureTablesPresent',
          `must be an integer between ${SIGNATURE_MATCH_FLOOR} (the fail-closed floor — a ` +
            `1-table 'match' selects on noise) and signatureTables.length (${tables.length})`,
        )
      }
    }
  }

  // -- coreTables ------------------------------------------------------------
  const coreTables = isPlainObject(preset.coreTables) ? preset.coreTables : null
  if (!coreTables || Object.keys(coreTables).length === 0) {
    collector.add(
      VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID,
      '$.coreTables',
      `must be a non-empty object mapping role names (lowerCamel) to { table, roles, optionalRoles?, note? }`,
    )
  } else {
    for (const [roleName, entry] of Object.entries(coreTables)) {
      const atPath = `$.coreTables.${roleName}`
      if (!ROLE_NAME.test(roleName)) {
        collector.add(VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID, atPath, `role name must match ${ROLE_NAME}`)
      }
      if (!isPlainObject(entry)) {
        collector.add(VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID, atPath, `must be { table, roles, optionalRoles?, note? }`)
        continue
      }
      checkKeys(collector, entry, atPath, V1_KEYS.coreTable)
      checkNote(collector, entry.note, `${atPath}.note`)
      checkIdentifier(collector, entry.table, `${atPath}.table`)
      for (const mapName of ['roles', 'optionalRoles']) {
        const map = entry[mapName]
        if (map === undefined && mapName === 'optionalRoles') continue
        if (!isPlainObject(map) || (mapName === 'roles' && Object.keys(map).length === 0)) {
          collector.add(
            VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID,
            `${atPath}.${mapName}`,
            `must be a non-empty object mapping role names to column identifiers`,
          )
          continue
        }
        for (const [columnRole, column] of Object.entries(map)) {
          const columnPath = `${atPath}.${mapName}.${columnRole}`
          if (VALUE_CARRIER_KEY.test(columnRole)) {
            collector.add(
              VENDOR_PRESET_ERROR_CODES.PRESET_VALUE_KEY_REJECTED,
              columnPath,
              `a role name shaped like a value carrier is refused — roles name discovery structure, ` +
                `never discovered content`,
            )
          } else if (!ROLE_NAME.test(columnRole)) {
            collector.add(VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID, columnPath, `role name must match ${ROLE_NAME}`)
          }
          checkIdentifier(collector, column, columnPath)
        }
      }
    }
  }

  // -- genericColumnFamilies (REQUIRED — the concrete-member scan's scope) ----
  const families = isPlainObject(preset.genericColumnFamilies) ? preset.genericColumnFamilies : null
  const allStems = []
  const validFamilyNames = new Set()
  if (!families || Object.keys(families).length === 0) {
    collector.add(
      VENDOR_PRESET_ERROR_CODES.PRESET_FAMILY_INVALID,
      '$.genericColumnFamilies',
      `is REQUIRED and must declare at least one structured family { onRole, stems, indexMin, ` +
        `indexMax } — the concrete-member scan's scope is the declared stems, so an absent ` +
        `declaration would silently exempt the whole document (the executed S1/A3 bypass); a ` +
        `vendor family without generic slot columns does not need this schema at all`,
    )
  } else {
    for (const [familyName, family] of Object.entries(families)) {
      const atPath = `$.genericColumnFamilies.${familyName}`
      if (!ROLE_NAME.test(familyName)) {
        collector.add(VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID, atPath, `family name must match ${ROLE_NAME}`)
      }
      const stems = validateStructuredFamily(collector, family, atPath, { coreTables, requireOnRole: true })
      if (stems) {
        allStems.push(...stems)
        validFamilyNames.add(familyName)
      }
    }
  }

  // -- joins -----------------------------------------------------------------
  if (preset.joins !== undefined) {
    if (!Array.isArray(preset.joins)) {
      collector.add(
        VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID,
        '$.joins',
        `must be an array of { fromRole, fromColumn, toRole, toColumn, note? }`,
      )
    } else {
      preset.joins.forEach((join, index) => {
        const atPath = `$.joins[${index}]`
        if (!isPlainObject(join)) {
          collector.add(VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID, atPath, `must be { fromRole, fromColumn, toRole, toColumn, note? }`)
          return
        }
        checkKeys(collector, join, atPath, V1_KEYS.join)
        checkNote(collector, join.note, `${atPath}.note`)
        for (const [roleKey, columnKey] of [
          ['fromRole', 'fromColumn'],
          ['toRole', 'toColumn'],
        ]) {
          const role = join[roleKey]
          const column = join[columnKey]
          if (!coreTables || !isPlainObject(coreTables[role])) {
            collector.add(
              VENDOR_PRESET_ERROR_CODES.PRESET_ROLE_REF_INVALID,
              `${atPath}.${roleKey}`,
              `must name a declared coreTables role (declared: ${Object.keys(coreTables || {}).join(', ')})`,
            )
            continue
          }
          if (!checkIdentifier(collector, column, `${atPath}.${columnKey}`)) continue
          const known = declaredRoleColumns(coreTables[role])
          if (!known.includes(column)) {
            collector.add(
              VENDOR_PRESET_ERROR_CODES.PRESET_ROLE_REF_INVALID,
              `${atPath}.${columnKey}`,
              `must be one of role '${role}'s declared columns [${known.join(', ')}] — join topology ` +
                `may only reference structure the preset itself declares`,
            )
          }
        }
      })
    }
  }

  // -- dictionaries ----------------------------------------------------------
  const dictionaryIds = new Set()
  if (preset.dictionaries !== undefined) {
    if (!Array.isArray(preset.dictionaries)) {
      collector.add(
        VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID,
        '$.dictionaries',
        `must be an array of { id, table, labelsColumnsOfRole, columnFamily?, mechanism, enabledFlag?, note? }`,
      )
    } else {
      preset.dictionaries.forEach((dictionary, index) => {
        const atPath = `$.dictionaries[${index}]`
        if (!isPlainObject(dictionary)) {
          collector.add(VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID, atPath, `must be a dictionary declaration object`)
          return
        }
        checkKeys(collector, dictionary, atPath, V1_KEYS.dictionary)
        checkNote(collector, dictionary.note, `${atPath}.note`)
        if (typeof dictionary.id !== 'string' || !KEBAB_ID.test(dictionary.id)) {
          collector.add(VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID, `${atPath}.id`, `must match ${KEBAB_ID}`)
        } else if (dictionaryIds.has(dictionary.id)) {
          collector.add(VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID, `${atPath}.id`, `duplicate dictionary id`)
        } else {
          dictionaryIds.add(dictionary.id)
        }
        checkIdentifier(collector, dictionary.table, `${atPath}.table`)
        if (!coreTables || !isPlainObject(coreTables[dictionary.labelsColumnsOfRole])) {
          collector.add(
            VENDOR_PRESET_ERROR_CODES.PRESET_ROLE_REF_INVALID,
            `${atPath}.labelsColumnsOfRole`,
            `must name a declared coreTables role (declared: ${Object.keys(coreTables || {}).join(', ')})`,
          )
        }
        if (dictionary.columnFamily !== undefined && !validFamilyNames.has(dictionary.columnFamily)) {
          collector.add(
            VENDOR_PRESET_ERROR_CODES.PRESET_ROLE_REF_INVALID,
            `${atPath}.columnFamily`,
            `must name a declared genericColumnFamilies entry (declared: ${[...validFamilyNames].join(', ')})`,
          )
        }
        if (!DICTIONARY_MECHANISMS.includes(dictionary.mechanism)) {
          collector.add(
            VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID,
            `${atPath}.mechanism`,
            `must be one of [${DICTIONARY_MECHANISMS.join(', ')}] — 'rows-name-columns' means each row's key ` +
              `value names a column of the labeled table (the probe's dictionary heuristic, made directed)`,
          )
        }
        if (dictionary.enabledFlag !== undefined) {
          if (!isPlainObject(dictionary.enabledFlag)) {
            collector.add(
              VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID,
              `${atPath}.enabledFlag`,
              `must be { columnCandidates, polarity, note? }`,
            )
          } else {
            checkKeys(collector, dictionary.enabledFlag, `${atPath}.enabledFlag`, V1_KEYS.enabledFlag)
            checkNote(collector, dictionary.enabledFlag.note, `${atPath}.enabledFlag.note`)
            const candidates = dictionary.enabledFlag.columnCandidates
            if (!Array.isArray(candidates) || candidates.length === 0 || candidates.length > ENABLED_FLAG_CANDIDATES_MAX) {
              collector.add(
                VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID,
                `${atPath}.enabledFlag.columnCandidates`,
                `must be an array of 1..${ENABLED_FLAG_CANDIDATES_MAX} column-name identifiers (spelling ` +
                  `variants of the vendor's enabled flag) — presetVersion 1 has no free-form pattern fields`,
              )
            } else {
              candidates.forEach((candidate, candidateIndex) =>
                checkIdentifier(collector, candidate, `${atPath}.enabledFlag.columnCandidates[${candidateIndex}]`),
              )
            }
            if (!ENABLED_FLAG_POLARITIES.includes(dictionary.enabledFlag.polarity)) {
              collector.add(
                VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID,
                `${atPath}.enabledFlag.polarity`,
                `must be one of [${ENABLED_FLAG_POLARITIES.join(', ')}]`,
              )
            }
          }
        }
      })
    }
  }

  // -- semanticExpectations --------------------------------------------------
  if (preset.semanticExpectations !== undefined) {
    if (!Array.isArray(preset.semanticExpectations)) {
      collector.add(
        VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID,
        '$.semanticExpectations',
        `must be an array of { semantic, locus, ... } discovery rules`,
      )
    } else {
      preset.semanticExpectations.forEach((expectation, index) => {
        const atPath = `$.semanticExpectations[${index}]`
        if (!isPlainObject(expectation)) {
          collector.add(VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID, atPath, `must be an expectation object`)
          return
        }
        checkKeys(collector, expectation, atPath, V1_KEYS.semanticExpectation)
        checkNote(collector, expectation.note, `${atPath}.note`)
        if (typeof expectation.semantic !== 'string' || !KEBAB_ID.test(expectation.semantic)) {
          collector.add(VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID, `${atPath}.semantic`, `must match ${KEBAB_ID}`)
        }
        if (!SEMANTIC_LOCI.includes(expectation.locus)) {
          collector.add(
            VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID,
            `${atPath}.locus`,
            `must be one of [${SEMANTIC_LOCI.join(', ')}]`,
          )
          return
        }
        if (expectation.locus === 'dictionary-assigned-column') {
          if (!validFamilyNames.has(expectation.columnFamily)) {
            collector.add(
              VENDOR_PRESET_ERROR_CODES.PRESET_ROLE_REF_INVALID,
              `${atPath}.columnFamily`,
              `must name a declared genericColumnFamilies entry (declared: ${[...validFamilyNames].join(', ')})`,
            )
          }
          if (!dictionaryIds.has(expectation.dictionary)) {
            collector.add(
              VENDOR_PRESET_ERROR_CODES.PRESET_ROLE_REF_INVALID,
              `${atPath}.dictionary`,
              `must name a declared dictionaries[].id (declared: ${[...dictionaryIds].join(', ')})`,
            )
          }
          if (expectation.labelHint !== undefined && !(expectation.labelHint in LABEL_HINT_VOCABULARY)) {
            collector.add(
              VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID,
              `${atPath}.labelHint`,
              `must be one of [${Object.keys(LABEL_HINT_VOCABULARY).join(', ')}] — a CLOSED enum; the ` +
                `word lists live in code (LABEL_HINT_VOCABULARY), never in a preset, so this channel ` +
                `cannot carry a vocabulary or a slot name`,
            )
          }
          if (expectation.dictionaryTypeHint !== undefined && !DICTIONARY_TYPE_HINTS.includes(expectation.dictionaryTypeHint)) {
            collector.add(
              VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID,
              `${atPath}.dictionaryTypeHint`,
              `must be one of [${DICTIONARY_TYPE_HINTS.join(', ')}] — a CLOSED enum; the type-word lists ` +
                `live in code (DICTIONARY_TYPE_HINT_WORDS), never in a preset`,
            )
          }
          if (expectation.valueSetTableFamily !== undefined) {
            const valueSetStems = validateStructuredFamily(collector, expectation.valueSetTableFamily, `${atPath}.valueSetTableFamily`, {
              coreTables,
              requireOnRole: false,
            })
            if (valueSetStems) allStems.push(...valueSetStems)
          }
          if (expectation.role !== undefined || expectation.roleColumn !== undefined) {
            collector.add(
              VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID,
              `${atPath}.roleColumn`,
              `a dictionary-assigned expectation must NOT pin a role/roleColumn — WHICH slot carries ` +
                `this semantic is exactly the per-customer fact the probe discovers from the customer's ` +
                `dictionary at run time. Acceptable: columnFamily + dictionary + enum hints only.`,
            )
          }
        } else {
          // native-column
          for (const forbidden of ['labelHint', 'dictionaryTypeHint', 'valueSetTableFamily', 'columnFamily', 'dictionary']) {
            if (expectation[forbidden] !== undefined) {
              collector.add(
                VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID,
                `${atPath}.${forbidden}`,
                `only meaningful on a dictionary-assigned expectation — a native-column expectation ` +
                  `carries role + roleColumn only`,
              )
            }
          }
          const role = expectation.role
          if (!coreTables || !isPlainObject(coreTables[role])) {
            collector.add(
              VENDOR_PRESET_ERROR_CODES.PRESET_ROLE_REF_INVALID,
              `${atPath}.role`,
              `must name a declared coreTables role (declared: ${Object.keys(coreTables || {}).join(', ')})`,
            )
          } else if (checkIdentifier(collector, expectation.roleColumn, `${atPath}.roleColumn`)) {
            const known = declaredRoleColumns(coreTables[role])
            if (!known.includes(expectation.roleColumn)) {
              collector.add(
                VENDOR_PRESET_ERROR_CODES.PRESET_ROLE_REF_INVALID,
                `${atPath}.roleColumn`,
                `must be one of role '${role}'s declared columns [${known.join(', ')}] — a native-column ` +
                  `expectation may only point at structure the preset itself declares`,
              )
            }
          }
        }
      })
    }
  }

  // -- conventions -----------------------------------------------------------
  if (preset.conventions !== undefined) {
    if (!isPlainObject(preset.conventions)) {
      collector.add(VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID, '$.conventions', `must be an object`)
    } else {
      checkKeys(collector, preset.conventions, '$.conventions', V1_KEYS.conventions)
      checkNote(collector, preset.conventions.note, '$.conventions.note')
      for (const key of ['objectIdColumn', 'versionColumn', 'sortColumn']) {
        if (preset.conventions[key] !== undefined) checkIdentifier(collector, preset.conventions[key], `$.conventions.${key}`)
      }
      if (preset.conventions.versionRule !== undefined && typeof preset.conventions.versionRule !== 'string') {
        collector.add(VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID, '$.conventions.versionRule', `must be a short rule id string`)
      }
      const hierarchy = preset.conventions.hierarchy
      if (hierarchy !== undefined) {
        if (!isPlainObject(hierarchy)) {
          collector.add(VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID, '$.conventions.hierarchy', `must be { role, idColumn, parentIdColumn, shape, note? }`)
        } else {
          checkKeys(collector, hierarchy, '$.conventions.hierarchy', V1_KEYS.hierarchy)
          checkNote(collector, hierarchy.note, '$.conventions.hierarchy.note')
          if (!coreTables || !isPlainObject(coreTables[hierarchy.role])) {
            collector.add(
              VENDOR_PRESET_ERROR_CODES.PRESET_ROLE_REF_INVALID,
              '$.conventions.hierarchy.role',
              `must name a declared coreTables role (declared: ${Object.keys(coreTables || {}).join(', ')})`,
            )
          }
          checkIdentifier(collector, hierarchy.idColumn, '$.conventions.hierarchy.idColumn')
          checkIdentifier(collector, hierarchy.parentIdColumn, '$.conventions.hierarchy.parentIdColumn')
          if (hierarchy.shape !== 'tree') {
            collector.add(VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID, '$.conventions.hierarchy.shape', `must be 'tree' (the only shape presetVersion 1 defines)`)
          }
        }
      }
      const bomActiveFilter = preset.conventions.bomActiveFilter
      if (bomActiveFilter !== undefined) {
        if (!isPlainObject(bomActiveFilter)) {
          collector.add(VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID, '$.conventions.bomActiveFilter', `must be { role, column, rule, presence, note? }`)
        } else {
          checkKeys(collector, bomActiveFilter, '$.conventions.bomActiveFilter', V1_KEYS.bomActiveFilter)
          checkNote(collector, bomActiveFilter.note, '$.conventions.bomActiveFilter.note')
          if (!coreTables || !isPlainObject(coreTables[bomActiveFilter.role])) {
            collector.add(
              VENDOR_PRESET_ERROR_CODES.PRESET_ROLE_REF_INVALID,
              '$.conventions.bomActiveFilter.role',
              `must name a declared coreTables role (declared: ${Object.keys(coreTables || {}).join(', ')})`,
            )
          }
          checkIdentifier(collector, bomActiveFilter.column, '$.conventions.bomActiveFilter.column')
          if (typeof bomActiveFilter.rule !== 'string' || bomActiveFilter.rule.length === 0) {
            collector.add(VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID, '$.conventions.bomActiveFilter.rule', `must be a short rule id string`)
          }
          if (!PRESENCE_VALUES.includes(bomActiveFilter.presence)) {
            collector.add(
              VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID,
              '$.conventions.bomActiveFilter.presence',
              `must be one of [${PRESENCE_VALUES.join(', ')}] — 'verify-live-before-use' records that this ` +
                `column has been seen ABSENT on a live catalog of the same family (schema drift)`,
            )
          }
        }
      }
    }
  }

  // -- notes -----------------------------------------------------------------
  if (preset.notes !== undefined) {
    if (!Array.isArray(preset.notes) || preset.notes.length > NOTES_MAX_COUNT) {
      collector.add(
        VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID,
        '$.notes',
        `must be an array of at most ${NOTES_MAX_COUNT} strings of at most ${NOTE_MAX_LENGTH} chars ` +
          `each — cite repo docs instead of restating observations. RESIDUAL: a proper name inside ` +
          `a short note is not mechanically detectable; that channel is review-gated.`,
      )
    } else {
      preset.notes.forEach((note, index) => checkNote(collector, note, `$.notes[${index}]`))
    }
  }

  // -- CONCRETE-MEMBER SCAN (discover-vs-discovered, made structural) --------
  // Unconditional and total: every string leaf, NO key-name exemptions, against every declared
  // stem AND its underscore-stripped base; then a raw-text pass over the serialized document for
  // carriers the leaf walk cannot see (object keys). A leaf naming a concrete member of a
  // declared family is a discovered per-customer fact wearing a committable coat.
  const scanners = buildConcreteMemberScanners(allStems)
  if (scanners.length > 0) {
    walkStringLeaves(preset, '$', (leaf, atPath) => {
      for (const scanner of scanners) {
        if (scanner.regex.test(leaf)) {
          collector.add(
            VENDOR_PRESET_ERROR_CODES.PRESET_CONCRETE_SLOT_REJECTED,
            atPath,
            `names a concrete member of a declared generic family (stem '${scanner.stem}' followed by ` +
              `a digit). WHICH slot of a family carries a meaning is per-customer dictionary data the ` +
              `probe reads at run time — a preset may speak of a family only through its structured ` +
              `declaration and discovery rules.`,
          )
          break
        }
      }
    })
    for (const scanner of scanners) {
      if (scanner.regex.test(serialized)) {
        collector.add(
          VENDOR_PRESET_ERROR_CODES.PRESET_CONCRETE_SLOT_REJECTED,
          '$(serialized preset)',
          `the serialized document carries a concrete member of a declared generic family (stem ` +
            `'${scanner.stem}' followed by a digit) — this raw-text pass exists so a member hiding in ` +
            `an object KEY or any other non-leaf position is still refused.`,
        )
        break
      }
    }
  }

  // -- VALUE-SHAPE SCAN (leak guard, mirroring the probe's vocabulary) -------
  // Every string leaf, notes included. The offending content is never echoed into the error
  // (echoing a credential into a message is itself a leak — same posture as the probe's masked
  // violations).
  walkStringLeaves(preset, '$', (leaf, atPath) => {
    const violation = findValueShapeViolation(leaf)
    if (violation) {
      collector.add(
        VENDOR_PRESET_ERROR_CODES.PRESET_VALUE_SHAPE_REJECTED,
        atPath,
        `string of length ${leaf.length} matches forbidden value shape '${violation.shape}' (content ` +
          `not echoed). A preset carries discovery structure only — identifiers, structured families ` +
          `and enums; connection/runtime values live exclusively in the probe's environment ` +
          `(PROBE_MSSQL_*, see scripts/ops/source-discovery-probe.mjs).`,
      )
    }
  })

  return { ok: errors.length === 0, errors }
}

class VendorPresetError extends Error {
  constructor(message, errors) {
    super(message)
    this.name = 'VendorPresetError'
    this.errors = errors
  }
}

function assertVendorPreset(preset, label = 'preset') {
  const result = validateVendorPreset(preset)
  if (!result.ok) {
    throw new VendorPresetError(
      `${label} failed vendor-preset validation (${result.errors.length} error(s)):\n` +
        result.errors.map((e) => `  - ${e.message}`).join('\n'),
      result.errors,
    )
  }
  return preset
}

// ---------------------------------------------------------------------------
// Signature matching — the probe's auto-selection contract.
// ---------------------------------------------------------------------------

function normalizeTableName(name) {
  // Accepts bare names and the probe's `schema.table` keys; case-insensitive (see header).
  const s = String(name)
  const bare = s.includes('.') ? s.slice(s.lastIndexOf('.') + 1) : s
  return bare.trim().toLowerCase()
}

/**
 * Evaluates one validated preset against a discovered table list (strings; bare or
 * `schema.table`). Pure and deterministic. `selected` is true ONLY when at least
 * `minSignatureTablesPresent` signature tables are present — below the floor there is no
 * partial credit and no ranking.
 */
function evaluatePresetMatch(preset, tableNames) {
  const present = new Set((Array.isArray(tableNames) ? tableNames : []).map(normalizeTableName))
  const signature = preset && preset.matches && Array.isArray(preset.matches.signatureTables) ? preset.matches.signatureTables : []
  const matchedTables = signature.filter((table) => present.has(table.toLowerCase()))
  const missingTables = signature.filter((table) => !present.has(table.toLowerCase()))
  const requiredCount = preset && preset.matches ? preset.matches.minSignatureTablesPresent : Number.POSITIVE_INFINITY
  return {
    presetId: preset ? preset.presetId : null,
    selected: matchedTables.length >= requiredCount,
    matchedCount: matchedTables.length,
    requiredCount,
    matchedTables,
    missingTables,
  }
}

/**
 * Selects at most ONE preset for a discovered table list. Fail-closed on every edge:
 *   - an invalid preset in the catalog throws (a broken catalog must not half-work);
 *   - no preset meeting its own floor      -> { selected: null, reason: 'NO_PRESET_MATCHED' };
 *   - MORE THAN ONE preset meeting its floor -> { selected: null, reason: 'AMBIGUOUS_PRESET_MATCH' },
 *     REGARDLESS of match counts. A higher count is not a disambiguator (a count race between
 *     overlapping signatures silently picks a winner — the refuted A1b behavior); if a
 *     legitimate superset-family case ever arises it must earn an explicit priority mechanism
 *     in a new preset version, not an implicit race.
 * There is deliberately no "best guess".
 */
function selectVendorPreset(presets, tableNames) {
  const list = Array.isArray(presets) ? presets : []
  const ids = new Set()
  for (const preset of list) {
    assertVendorPreset(preset, `catalog preset ${preset && preset.presetId ? `'${preset.presetId}'` : '(unidentified)'}`)
    if (ids.has(preset.presetId)) {
      throw new VendorPresetError(`duplicate presetId '${preset.presetId}' in catalog`, [])
    }
    ids.add(preset.presetId)
  }
  const evaluations = list.map((preset) => evaluatePresetMatch(preset, tableNames))
  const selectedEvals = evaluations.filter((e) => e.selected)
  if (selectedEvals.length === 0) {
    return { selected: null, reason: 'NO_PRESET_MATCHED', evaluations }
  }
  if (selectedEvals.length > 1) {
    return { selected: null, reason: 'AMBIGUOUS_PRESET_MATCH', evaluations }
  }
  const winner = list.find((preset) => preset.presetId === selectedEvals[0].presetId)
  return { selected: winner, reason: 'MATCHED', evaluation: selectedEvals[0], evaluations }
}

/**
 * Loads and validates every `*.preset.json` in a directory (sorted, deterministic). An invalid
 * or unparseable preset file THROWS naming the file — it is never silently skipped, because a
 * skipped preset would demote same-vendor customer #2 back to a cold discovery run with no
 * visible signal.
 */
function loadVendorPresetsFromDir(dir = __dirname) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(PRESET_FILE_SUFFIX))
    .sort()
  return files.map((file) => {
    const full = path.join(dir, file)
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(full, 'utf8'))
    } catch (err) {
      throw new VendorPresetError(`preset file ${file} is not valid JSON: ${err && err.message}`, [])
    }
    assertVendorPreset(parsed, `preset file ${file}`)
    return { file, preset: parsed }
  })
}

module.exports = {
  SOURCE_VENDOR_PRESET_SCHEMA_MARKER,
  SUPPORTED_PRESET_VERSIONS,
  PRESET_FILE_SUFFIX,
  SIGNATURE_MATCH_FLOOR,
  FAMILY_MIN_CARDINALITY,
  PRESET_MAX_JSON_BYTES,
  VENDOR_PRESET_ERROR_CODES,
  VALUE_SHAPE_PATTERNS,
  LABEL_HINT_VOCABULARY,
  DICTIONARY_TYPE_HINTS,
  DICTIONARY_TYPE_HINT_WORDS,
  VendorPresetError,
  findValueShapeViolation,
  familyColumnMatcher,
  isFamilyColumn,
  buildConcreteMemberScanners,
  normalizeTableName,
  validateVendorPreset,
  assertVendorPreset,
  evaluatePresetMatch,
  selectVendorPreset,
  loadVendorPresetsFromDir,
}
