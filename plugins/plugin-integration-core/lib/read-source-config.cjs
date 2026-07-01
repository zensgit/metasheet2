'use strict'

// External-API read self-service — S1: CONFIG MODEL + save-time VALIDATOR ONLY (#1709, ladder in
// docs/development/integration-core-external-api-read-self-service-consultant-config-design-20260630.md).
//
// Scope fence (matches the S1 design-lock row): this module validates a consultant-authored read-source
// config and returns a normalized value or fail-closed errors. It does NOT persist, audit-log, wire a route,
// call any network, run any read, or touch a write path. There is no UI. Marker-gating enforcement (a new
// preset MUST be marker-gated) is DEFERRED to the S3 runtime — flagged, not silently dropped. `version` is a
// plain field here (real versioning/audit is S1-store, a later cut).
//
// Errors are values-free — every error is { code, field, reason } where `field` is a config KEY NAME and
// `reason` is a coarse enum. The offending endpoint URL, systemId, or any secret-shaped value is NEVER echoed.
// This mirrors the fail-closed / enum-strict / coarse-reason idiom of normalizeReadSmokeContract.

const { scrubSecretStringValue } = require('./payload-redaction.cjs')

// The four proven read modes (standard names from #3416); nothing else is accepted.
const READ_SOURCE_MODES = Object.freeze(['single_record', 'list_page', 'detail_with_lines', 'resolver_lookup'])
const READ_SOURCE_METHODS = Object.freeze(['GET', 'POST'])
const READ_SOURCE_KEY_ENCODINGS = Object.freeze(['structured_json_field', 'filter_expression', 'numeric_id'])

// Per-mode REQUIRED fields — hardcoded for the four modes (NOT a generic schema engine; per the design-lock,
// "the four read modes" means "knows each mode's shape").
const MODE_REQUIRED_FIELDS = Object.freeze({
  single_record: Object.freeze(['keyField', 'containerPaths']),
  list_page: Object.freeze(['containerPaths']),
  detail_with_lines: Object.freeze(['headerContainerPaths', 'lineContainerPaths']),
  resolver_lookup: Object.freeze(['keyField', 'containerPaths', 'multiplicityRuleField']),
})

// Keys that would carry a write surface (fail-closed: read-only line).
const WRITE_SHAPED_KEYS = Object.freeze(['savePath', 'submitPath', 'auditPath', 'deletePath', 'writePath'])
// Keys that would carry inline credential material (must be a backend reference via systemId, never inline).
const INLINE_CREDENTIAL_KEYS = Object.freeze([
  'bearerToken', 'token', 'authToken', 'accessToken', 'password', 'apiKey', 'secret', 'secretKey',
  'credential', 'credentials', 'connectionString', 'authorityCode', 'cookie', 'sessionId',
])
// The complete allowlist of top-level config keys (anything else is rejected — no raw path/method/response/etc.
// can ride in under an unexpected key).
const ALLOWED_CONFIG_KEYS = Object.freeze(new Set([
  'version', 'systemId', 'requiredKind', 'object', 'mode', 'readPath', 'readMethod', 'operations',
  'keyField', 'keyEncoding', 'containerPaths', 'headerContainerPaths', 'lineContainerPaths',
  'multiplicityRuleField', 'fieldMap',
]))

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

// Bounded structured identifier (systemId, field/container names). No whitespace, no scheme, no path.
function isBoundedIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(value.trim())
}

// A response container path: dot-joined identifier segments, case-preserving (e.g. Data.Page2). No scheme,
// host, traversal, brackets, or wildcards — a fixed structural path only.
function isValidContainerPath(value) {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(value.trim())
}

// THE crown-jewel guard. The consultant supplies the endpoint, so this is the sole barrier between config and
// SSRF. Stricter than the adapter's assertRelativePath: also rejects path traversal and ALL percent-encoding
// (any %xx can decode — post-guard, at URL-assembly time — to a boundary escape: %2e%2e→.., %2f→/, %5c→\,
// %00→NUL). S1 is relative-only; a per-system host-allowlist branch is a deferred, separate slice.
function isSafeRelativeReadPath(value) {
  if (typeof value !== 'string') return false
  const raw = value.trim()
  if (raw.length === 0) return false
  for (let i = 0; i < raw.length; i++) { const code = raw.charCodeAt(i); if (code < 0x20 || code === 0x7f) return false }  // control chars
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw)) return false      // any scheme: http: https: javascript: file: ...
  if (raw.startsWith('//')) return false                       // protocol-relative → resolves to a host
  if (raw.includes('\\')) return false                         // backslash: \\host  /\host
  // Reject ALL percent-encoding. A config endpoint never needs it, and each encoded form decodes to a
  // path-boundary escape our checks run BEFORE decoding and therefore miss: %2e%2e→.. (traversal, e.g.
  // Node normalizes `/%2e%2e/admin`→`/admin`), %2f→/ (host injection), %5c→\, %00→NUL. One blanket
  // reject kills the whole class rather than chasing each encoding.
  if (raw.includes('%')) return false
  const path = raw.startsWith('/') ? raw : `/${raw}`
  if (path.split('/').some((seg) => seg === '..')) return false // literal (already-decoded) path traversal
  // Positive allowlist: only safe URL-path characters (rejects spaces, quotes, angle brackets, query
  // chars, percent, etc.). Kept IN ADDITION to the explicit rejects above — the allowlist alone would
  // pass `//` and `..` (all their chars are "safe"), so both layers are required.
  if (!/^\/[A-Za-z0-9\-._~/]*$/.test(path)) return false
  return true
}

// A fieldMap entry is config metadata, not free text: `source` names a field/container path IN the response
// (same dotted-identifier shape as containerPaths — so `FNumber`, `Data.FQty`, never a value like `MAT-001`
// or a traversal like `../../x`), and `target` names a bounded cleansing-zone column id. Validating the shape
// here keeps values (and value-shaped injection) out of a config that is only supposed to describe structure.
function isValidFieldMapEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
  if (!Object.keys(entry).every((k) => k === 'source' || k === 'target')) return false
  return isValidContainerPath(entry.source) && isBoundedIdentifier(entry.target)
}

// Shallow scan: does any string value in the config look like a raw secret (Bearer/JWT/conn-string/…)? Uses the
// shared secret-shape scrubber as a second net beyond the inline-credential key check.
function hasSecretShapedValue(config) {
  for (const value of Object.values(config)) {
    if (typeof value === 'string' && scrubSecretStringValue(value) !== value) return true
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && scrubSecretStringValue(item) !== item) return true
        if (item && typeof item === 'object') {
          for (const v of Object.values(item)) {
            if (typeof v === 'string' && scrubSecretStringValue(v) !== v) return true
          }
        }
      }
    }
  }
  return false
}

function validateReadSourceConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { valid: false, errors: [{ code: 'READ_SOURCE_CONFIG_NOT_OBJECT', field: '(root)', reason: 'not_object' }] }
  }
  const errors = []
  const push = (code, field, reason) => errors.push({ code, field, reason })

  // Strict key allowlist — no raw endpoint/method/response-path/config can ride in under an unexpected key.
  for (const key of Object.keys(config)) {
    if (!ALLOWED_CONFIG_KEYS.has(key)) push('READ_SOURCE_UNEXPECTED_FIELD', key, 'not_allowlisted')
  }

  // Read-only line: no write-shaped keys; operations must be exactly ['read'].
  for (const key of WRITE_SHAPED_KEYS) {
    if (config[key] !== undefined) push('READ_SOURCE_WRITE_CONFIG_REJECTED', key, 'write_shaped_key')
  }
  if (!Array.isArray(config.operations) || config.operations.length !== 1 || config.operations[0] !== 'read') {
    push('READ_SOURCE_WRITE_CONFIG_REJECTED', 'operations', 'operations_must_be_read_only')
  }

  // Backend-reference-only credentials: no inline credential keys, no secret-shaped values anywhere.
  for (const key of INLINE_CREDENTIAL_KEYS) {
    if (config[key] !== undefined) push('READ_SOURCE_CREDENTIAL_INLINE_REJECTED', key, 'inline_credential_key')
  }
  if (hasSecretShapedValue(config)) {
    push('READ_SOURCE_CREDENTIAL_INLINE_REJECTED', '(value)', 'secret_shaped_value')
  }

  // systemId — the reference to the registered external system (which holds baseUrl + credential).
  if (!isBoundedIdentifier(config.systemId)) push('READ_SOURCE_SYSTEM_REF_INVALID', 'systemId', 'invalid_reference')
  if (!isNonEmptyString(config.requiredKind)) push('READ_SOURCE_KIND_REQUIRED', 'requiredKind', 'required')
  if (!isBoundedIdentifier(config.object)) push('READ_SOURCE_OBJECT_INVALID', 'object', 'invalid_object')

  // mode ∈ the four; method ∈ {GET, POST}; endpoint safe-relative (crown jewel).
  const modeOk = READ_SOURCE_MODES.includes(config.mode)
  if (!modeOk) push('READ_SOURCE_MODE_NOT_ALLOWED', 'mode', 'not_allowlisted')
  if (!READ_SOURCE_METHODS.includes(config.readMethod)) push('READ_SOURCE_METHOD_NOT_ALLOWED', 'readMethod', 'not_allowlisted')
  if (!isSafeRelativeReadPath(config.readPath)) push('READ_SOURCE_ENDPOINT_NOT_RELATIVE', 'readPath', 'not_safe_relative_path')

  // keyEncoding (optional) ∈ allowlist.
  if (config.keyEncoding !== undefined && !READ_SOURCE_KEY_ENCODINGS.includes(config.keyEncoding)) {
    push('READ_SOURCE_KEY_ENCODING_INVALID', 'keyEncoding', 'not_allowlisted')
  }
  if (config.keyField !== undefined && !isBoundedIdentifier(config.keyField)) {
    push('READ_SOURCE_KEY_FIELD_INVALID', 'keyField', 'invalid_identifier')
  }
  if (config.multiplicityRuleField !== undefined && !isBoundedIdentifier(config.multiplicityRuleField)) {
    push('READ_SOURCE_MULTIPLICITY_FIELD_INVALID', 'multiplicityRuleField', 'invalid_identifier')
  }

  // Container-path lists (case-aware structural allowlist; a guessed/raw path fails).
  const checkContainers = (field) => {
    const list = config[field]
    if (list === undefined) return
    if (!Array.isArray(list) || list.length === 0 || !list.every(isValidContainerPath)) {
      push('READ_SOURCE_CONTAINER_PATH_INVALID', field, 'invalid_container_path')
    }
  }
  checkContainers('containerPaths')
  checkContainers('headerContainerPaths')
  checkContainers('lineContainerPaths')

  // Field map — declares the data-plane fields only: { source, target } names, never values.
  if (config.fieldMap !== undefined && (!Array.isArray(config.fieldMap) || config.fieldMap.length === 0 || !config.fieldMap.every(isValidFieldMapEntry))) {
    push('READ_SOURCE_FIELD_MAP_INVALID', 'fieldMap', 'invalid_field_map')
  }

  // version — positive integer (audit/versioning surface; store is a later cut).
  if (!Number.isInteger(config.version) || config.version < 1) {
    push('READ_SOURCE_VERSION_INVALID', 'version', 'must_be_positive_integer')
  }

  // Per-mode required fields (only when the mode itself is valid).
  if (modeOk) {
    for (const required of MODE_REQUIRED_FIELDS[config.mode]) {
      if (config[required] === undefined) push('READ_SOURCE_MODE_FIELD_REQUIRED', required, `required_for_${config.mode}`)
    }
  }

  if (errors.length > 0) return { valid: false, errors }
  return { valid: true, normalized: normalizeReadSourceConfig(config) }
}

// Frozen, trimmed, read-only normalized view. Only reached after full validation. operations pinned to ['read'].
function normalizeReadSourceConfig(config) {
  const out = {
    version: config.version,
    systemId: config.systemId.trim(),
    requiredKind: config.requiredKind.trim(),
    object: config.object.trim(),
    mode: config.mode,
    readPath: config.readPath.trim().startsWith('/') ? config.readPath.trim() : `/${config.readPath.trim()}`,
    readMethod: config.readMethod,
    operations: Object.freeze(['read']),
  }
  if (config.keyField !== undefined) out.keyField = config.keyField.trim()
  if (config.keyEncoding !== undefined) out.keyEncoding = config.keyEncoding
  if (config.multiplicityRuleField !== undefined) out.multiplicityRuleField = config.multiplicityRuleField.trim()
  const trimList = (field) => {
    if (Array.isArray(config[field])) out[field] = Object.freeze(config[field].map((p) => p.trim()))
  }
  trimList('containerPaths')
  trimList('headerContainerPaths')
  trimList('lineContainerPaths')
  if (Array.isArray(config.fieldMap)) {
    out.fieldMap = Object.freeze(config.fieldMap.map((e) => Object.freeze({ source: e.source.trim(), target: e.target.trim() })))
  }
  return Object.freeze(out)
}

module.exports = {
  READ_SOURCE_MODES,
  READ_SOURCE_METHODS,
  READ_SOURCE_KEY_ENCODINGS,
  isSafeRelativeReadPath,
  validateReadSourceConfig,
  normalizeReadSourceConfig,
}
