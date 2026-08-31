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
 *       dictionary-assigned slot of a generic column family — plus hints (declared-type words,
 *       label vocabulary) for ranking candidates;
 *     - identifier / version / sort conventions of the product.
 *
 *   CUSTOMER-SPECIFIC (must NEVER be in a preset; the probe reads it from the customer's own
 *   dictionary tables at run time):
 *     - WHICH concrete slot carries which meaning (that is a row of the customer's dictionary);
 *     - option vocabularies, business values, connection/runtime values of any kind.
 *
 * The schema makes smuggling STRUCTURAL, not aspirational:
 *   1. STRICT KEY ALLOWLISTS everywhere — there is no free-form field to hide a value in, and any
 *      key shaped like a value carrier (`default*`, `value(s)`, `sample*`, `example*`, `data`,
 *      `rows`…) is refused with its own coded reason even before the allowlist speaks.
 *   2. IDENTIFIER FIELDS accept only SQL-identifier-shaped strings, so a connection string, IP,
 *      or path cannot occupy a table/column position at all.
 *   3. CONCRETE-SLOT REJECTION — a preset DECLARES its generic column families as anchored
 *      patterns (`genericColumnFamilies`), and the validator then refuses ANY string leaf in the
 *      whole document that names a concrete member of a declared family. "Slot N of this family
 *      means X" is precisely a discovered fact; a preset may only speak of the family.
 *   4. VALUE-SHAPE REJECTION over every string leaf (notes included): connection strings, database
 *      URLs, bare IP addresses, credential material / credential file paths, and probe-env
 *      assignments are refused, naming the offending path but never echoing the content. The
 *      vocabulary MIRRORS the probe's own leak guard (`ENV_VAR_NAMES`, `isBareIpAddress`,
 *      `assertValuesFree` in scripts/ops/source-discovery-probe.mjs) — keep the two aligned when
 *      either grows; do not invent a third vocabulary.
 *
 * ── IDENTITY: SIGNATURE, NOT BRAND ──────────────────────────────────────────────────────────────
 *
 * A preset is keyed by a DETECTABLE SIGNATURE — the table-name family it matches against a live
 * catalog (`matches.signatureTables` + `matches.minSignatureTablesPresent`) — never by vendor
 * brand or customer name. No company names belong in this repository; the presetId names the
 * table-name family (e.g. `dn-pdm-family`). Selection is fail-closed: a catalog that does not
 * meet a preset's own confidence floor selects nothing, and an ambiguous tie between presets
 * selects nothing — there is no "best guess". Matching is case-insensitive because the same
 * schema is CamelCase on SQL Server and folded to lower case on PostgreSQL (see the header of
 * scripts/ops/fixtures/stock-prep-synthetic-plm/schema.sql).
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
 * `evaluatePresetMatch` exactly). Preset files live next to this module as `*.preset.json`.
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

const VENDOR_PRESET_ERROR_CODES = Object.freeze({
  PRESET_NOT_AN_OBJECT: 'PRESET_NOT_AN_OBJECT',
  PRESET_SCHEMA_MARKER_INVALID: 'PRESET_SCHEMA_MARKER_INVALID',
  PRESET_VERSION_UNSUPPORTED: 'PRESET_VERSION_UNSUPPORTED',
  PRESET_ID_INVALID: 'PRESET_ID_INVALID',
  PRESET_KEY_UNKNOWN: 'PRESET_KEY_UNKNOWN',
  PRESET_FIELD_INVALID: 'PRESET_FIELD_INVALID',
  PRESET_MATCHES_INVALID: 'PRESET_MATCHES_INVALID',
  PRESET_IDENTIFIER_INVALID: 'PRESET_IDENTIFIER_INVALID',
  PRESET_PATTERN_INVALID: 'PRESET_PATTERN_INVALID',
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

/** presetId / dictionary id / semantic id: lowercase kebab, names a FAMILY, never a company. */
const KEBAB_ID = /^[a-z][a-z0-9-]{2,63}$/

/** Role keys inside coreTables / genericColumnFamilies: lowerCamel. */
const ROLE_NAME = /^[a-z][A-Za-z0-9]*$/

const NOTE_MAX_LENGTH = 500
const NOTES_MAX_COUNT = 24
const PATTERN_MAX_LENGTH = 200
const SIGNATURE_TABLES_MAX = 64

/**
 * Keys that are value carriers by shape. A preset declares HOW TO DISCOVER, so no field of it may
 * be named like it holds WHAT WAS DISCOVERED. Checked before the allowlist so the refusal carries
 * this rule, not a generic "unknown key".
 */
const VALUE_CARRIER_KEY = /^(?:defaults?|values?|samples?|examples?|literals?|seeds?|rows?|data)$|^(?:default|sample|example|literal|seed)[A-Z_]/

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
// a new field means a new version with its own widened table here.
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
  family: Object.freeze(['onRole', 'pattern', 'note']),
  coreTable: Object.freeze(['table', 'roles', 'optionalRoles', 'note']),
  join: Object.freeze(['fromRole', 'fromColumn', 'toRole', 'toColumn', 'note']),
  dictionary: Object.freeze(['id', 'table', 'labelsColumnsOfRole', 'columnFamily', 'mechanism', 'enabledFlag', 'note']),
  enabledFlag: Object.freeze(['columnPattern', 'polarity', 'note']),
  semanticExpectation: Object.freeze([
    'semantic',
    'locus',
    'columnFamily',
    'dictionary',
    'dictionaryTypeHintPattern',
    'labelHintPattern',
    'valueSetTableNamePattern',
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

function checkAnchoredPattern(collector, value, atPath) {
  if (typeof value !== 'string' || value.length === 0 || value.length > PATTERN_MAX_LENGTH) {
    collector.add(
      VENDOR_PRESET_ERROR_CODES.PRESET_PATTERN_INVALID,
      atPath,
      `must be a non-empty regular-expression string of at most ${PATTERN_MAX_LENGTH} chars`,
    )
    return false
  }
  if (!value.startsWith('^') || !value.endsWith('$')) {
    collector.add(
      VENDOR_PRESET_ERROR_CODES.PRESET_PATTERN_INVALID,
      atPath,
      `must be anchored '^...$' — an unanchored family/column pattern would match inside unrelated ` +
        `identifiers. Acceptable form: '^Prefix_Slot[0-9]+$'.`,
    )
    return false
  }
  try {
    // Patterns are evaluated case-insensitively everywhere (SQL Server collations are
    // case-insensitive; PostgreSQL folds unquoted identifiers to lower case).
    new RegExp(value, 'i')
  } catch {
    collector.add(VENDOR_PRESET_ERROR_CODES.PRESET_PATTERN_INVALID, atPath, `must compile as a RegExp (with the 'i' flag)`)
    return false
  }
  return true
}

function checkHintPattern(collector, value, atPath) {
  if (value === undefined) return true
  if (typeof value !== 'string' || value.length === 0 || value.length > PATTERN_MAX_LENGTH) {
    collector.add(
      VENDOR_PRESET_ERROR_CODES.PRESET_PATTERN_INVALID,
      atPath,
      `must be a non-empty regular-expression string of at most ${PATTERN_MAX_LENGTH} chars (hint ` +
        `patterns may be unanchored)`,
    )
    return false
  }
  try {
    new RegExp(value, 'i')
  } catch {
    collector.add(VENDOR_PRESET_ERROR_CODES.PRESET_PATTERN_INVALID, atPath, `must compile as a RegExp (with the 'i' flag)`)
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
      `must be a non-empty string of at most ${NOTE_MAX_LENGTH} chars`,
    )
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Walks every string leaf (values only, never keys), reporting the leaf's key name and path. */
function walkStringLeaves(value, atPath, keyName, visit) {
  if (typeof value === 'string') {
    visit(value, atPath, keyName)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkStringLeaves(item, `${atPath}[${index}]`, keyName, visit))
    return
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      walkStringLeaves(child, `${atPath}.${key}`, key, visit)
    }
  }
}

function stripPatternAnchors(pattern) {
  let out = String(pattern)
  if (out.startsWith('^')) out = out.slice(1)
  if (out.endsWith('$')) out = out.slice(0, -1)
  return out
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

  // -- genericColumnFamilies -------------------------------------------------
  const families = isPlainObject(preset.genericColumnFamilies) ? preset.genericColumnFamilies : null
  if (preset.genericColumnFamilies !== undefined && !families) {
    collector.add(
      VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID,
      '$.genericColumnFamilies',
      `must be an object mapping family names to { onRole, pattern, note? }`,
    )
  }
  const familyPatterns = new Map() // familyName -> searcher RegExp (anchors stripped, 'i')
  if (families) {
    for (const [familyName, family] of Object.entries(families)) {
      const atPath = `$.genericColumnFamilies.${familyName}`
      if (!ROLE_NAME.test(familyName)) {
        collector.add(VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID, atPath, `family name must match ${ROLE_NAME}`)
      }
      if (!isPlainObject(family)) {
        collector.add(VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID, atPath, `must be { onRole, pattern, note? }`)
        continue
      }
      checkKeys(collector, family, atPath, V1_KEYS.family)
      checkNote(collector, family.note, `${atPath}.note`)
      if (coreTables && !isPlainObject(coreTables[family.onRole])) {
        collector.add(
          VENDOR_PRESET_ERROR_CODES.PRESET_ROLE_REF_INVALID,
          `${atPath}.onRole`,
          `must name a declared coreTables role (declared: ${Object.keys(coreTables || {}).join(', ')})`,
        )
      }
      if (checkAnchoredPattern(collector, family.pattern, `${atPath}.pattern`)) {
        familyPatterns.set(familyName, new RegExp(stripPatternAnchors(family.pattern), 'i'))
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
        if (dictionary.columnFamily !== undefined && !familyPatterns.has(dictionary.columnFamily) && !(families && families[dictionary.columnFamily])) {
          collector.add(
            VENDOR_PRESET_ERROR_CODES.PRESET_ROLE_REF_INVALID,
            `${atPath}.columnFamily`,
            `must name a declared genericColumnFamilies entry (declared: ${Object.keys(families || {}).join(', ')})`,
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
            collector.add(VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID, `${atPath}.enabledFlag`, `must be { columnPattern, polarity, note? }`)
          } else {
            checkKeys(collector, dictionary.enabledFlag, `${atPath}.enabledFlag`, V1_KEYS.enabledFlag)
            checkNote(collector, dictionary.enabledFlag.note, `${atPath}.enabledFlag.note`)
            checkAnchoredPattern(collector, dictionary.enabledFlag.columnPattern, `${atPath}.enabledFlag.columnPattern`)
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
        checkHintPattern(collector, expectation.dictionaryTypeHintPattern, `${atPath}.dictionaryTypeHintPattern`)
        checkHintPattern(collector, expectation.labelHintPattern, `${atPath}.labelHintPattern`)
        if (expectation.valueSetTableNamePattern !== undefined) {
          checkAnchoredPattern(collector, expectation.valueSetTableNamePattern, `${atPath}.valueSetTableNamePattern`)
        }
        if (expectation.locus === 'dictionary-assigned-column') {
          if (!familyPatterns.has(expectation.columnFamily) && !(families && families[expectation.columnFamily])) {
            collector.add(
              VENDOR_PRESET_ERROR_CODES.PRESET_ROLE_REF_INVALID,
              `${atPath}.columnFamily`,
              `must name a declared genericColumnFamilies entry (declared: ${Object.keys(families || {}).join(', ')})`,
            )
          }
          if (!dictionaryIds.has(expectation.dictionary)) {
            collector.add(
              VENDOR_PRESET_ERROR_CODES.PRESET_ROLE_REF_INVALID,
              `${atPath}.dictionary`,
              `must name a declared dictionaries[].id (declared: ${[...dictionaryIds].join(', ')})`,
            )
          }
          if (expectation.role !== undefined || expectation.roleColumn !== undefined) {
            collector.add(
              VENDOR_PRESET_ERROR_CODES.PRESET_FIELD_INVALID,
              `${atPath}.roleColumn`,
              `a dictionary-assigned expectation must NOT pin a role/roleColumn — WHICH slot carries ` +
                `this semantic is exactly the per-customer fact the probe discovers from the customer's ` +
                `dictionary at run time. Acceptable: columnFamily + dictionary + hint patterns only.`,
            )
          }
        } else {
          // native-column
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
        `must be an array of at most ${NOTES_MAX_COUNT} strings`,
      )
    } else {
      preset.notes.forEach((note, index) => checkNote(collector, note, `$.notes[${index}]`))
    }
  }

  // -- CONCRETE-SLOT SCAN (discover-vs-discovered, made structural) ----------
  // A leaf naming a concrete member of a declared generic column family is a discovered
  // per-customer fact wearing a committable coat. Pattern-declaration fields themselves are
  // skipped (their text is the family, not a member; an anchored pattern also cannot match its
  // own source, but skipping by key keeps that independent of pattern spelling).
  if (familyPatterns.size > 0) {
    walkStringLeaves(preset, '$', null, (leaf, atPath, keyName) => {
      if (typeof keyName === 'string' && (keyName === 'pattern' || keyName.endsWith('Pattern'))) return
      for (const [familyName, searcher] of familyPatterns) {
        if (searcher.test(leaf)) {
          collector.add(
            VENDOR_PRESET_ERROR_CODES.PRESET_CONCRETE_SLOT_REJECTED,
            atPath,
            `names a concrete member of generic column family '${familyName}'. WHICH slot of that ` +
              `family carries a meaning is per-customer dictionary data the probe reads at run time — ` +
              `a preset may speak of the family only via its declared pattern and discovery rules ` +
              `(dictionaries / semanticExpectations).`,
          )
          break
        }
      }
    })
  }

  // -- VALUE-SHAPE SCAN (leak guard, mirroring the probe's vocabulary) -------
  // Every string leaf, notes and patterns included. The offending content is never echoed into
  // the error (echoing a credential into a message is itself a leak — same posture as the probe's
  // masked violations).
  walkStringLeaves(preset, '$', null, (leaf, atPath) => {
    const violation = findValueShapeViolation(leaf)
    if (violation) {
      collector.add(
        VENDOR_PRESET_ERROR_CODES.PRESET_VALUE_SHAPE_REJECTED,
        atPath,
        `string of length ${leaf.length} matches forbidden value shape '${violation.shape}' (content ` +
          `not echoed). A preset carries discovery structure only — identifiers and patterns; ` +
          `connection/runtime values live exclusively in the probe's environment (PROBE_MSSQL_*, ` +
          `see scripts/ops/source-discovery-probe.mjs).`,
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
 *   - no preset meeting its own floor  -> { selected: null, reason: 'NO_PRESET_MATCHED' };
 *   - two presets tied at the top      -> { selected: null, reason: 'AMBIGUOUS_PRESET_MATCH' }.
 * There is deliberately no "best guess below the floor".
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
  const selectedEvals = evaluations.filter((e) => e.selected).sort((a, b) => b.matchedCount - a.matchedCount)
  if (selectedEvals.length === 0) {
    return { selected: null, reason: 'NO_PRESET_MATCHED', evaluations }
  }
  if (selectedEvals.length > 1 && selectedEvals[0].matchedCount === selectedEvals[1].matchedCount) {
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
  VENDOR_PRESET_ERROR_CODES,
  VALUE_SHAPE_PATTERNS,
  VendorPresetError,
  findValueShapeViolation,
  stripPatternAnchors,
  normalizeTableName,
  validateVendorPreset,
  assertVendorPreset,
  evaluatePresetMatch,
  selectVendorPreset,
  loadVendorPresetsFromDir,
}
