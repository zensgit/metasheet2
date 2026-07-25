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
// PROFILE_ID_PATTERN is IMPORTED, never duplicated, so actionProfileVersion here and the GIP certification
// module's profileId vocabulary cannot drift apart (ledger §4 step 1.1).
const { __internals: { PROFILE_ID_PATTERN } } = require('./gip-profile-certification-contracts.cjs')

// The four proven read modes (standard names from #3416); nothing else is accepted.
const READ_SOURCE_MODES = Object.freeze(['single_record', 'list_page', 'detail_with_lines', 'resolver_lookup'])
const READ_SOURCE_METHODS = Object.freeze(['GET', 'POST'])
const READ_SOURCE_KEY_ENCODINGS = Object.freeze(['structured_json_field', 'filter_expression', 'numeric_id'])

// resolver_lookup multiplicity rules (R0 contract extension, #1709 / resolver design-lock 2026-07-02).
// The default MUST NOT be "take the first row" — resolverRule is REQUIRED for resolver_lookup (below), so an
// old/pre-R0 resolver config that never declared it is fail-closed invalid (never silently reinterpreted).
const RESOLVER_RULES = Object.freeze(['exactly_one', 'first_when_sorted', 'field_equals'])
const RESOLVER_SORT_DIRECTIONS = Object.freeze(['asc', 'desc'])

// B1a §4 step 1.1 (⟲R6) — orderingKeySpec.direction. Deliberately UPPERCASE and deliberately NOT unified
// with RESOLVER_SORT_DIRECTIONS above (owner-ratified decision, ledger §4 step 1.1): a read-time normalizer
// that reconciled the two vocabularies would let two textually different approved bodies — different
// configContentKey, different qualification digest — behave identically, silently un-pinning behaviour the
// content key exists to pin. Keep both vocabularies exactly as they are.
const ORDERING_KEY_DIRECTIONS = Object.freeze(['ASC', 'DESC'])

// Per-mode REQUIRED fields — hardcoded for the four modes (NOT a generic schema engine; per the design-lock,
// "the four read modes" means "knows each mode's shape"). resolver_lookup: multiplicityRuleField is no longer
// unconditionally required — it is RULE-specific (validateResolverContract below), so the base requirement is
// only keyField + containerPaths + resolverRule.
const MODE_REQUIRED_FIELDS = Object.freeze({
  single_record: Object.freeze(['keyField', 'containerPaths']),
  list_page: Object.freeze(['containerPaths']),
  detail_with_lines: Object.freeze(['headerContainerPaths', 'lineContainerPaths']),
  resolver_lookup: Object.freeze(['keyField', 'containerPaths', 'resolverRule']),
})

// Keys that only make sense for resolver_lookup — must NOT ride in under any other mode.
const RESOLVER_ONLY_KEYS = Object.freeze(['resolverRule', 'resolverSortDirection', 'resolverDiscriminatorValue'])

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
  // R0: resolver_lookup contract keys (rule-gated below; rejected on non-resolver modes).
  'resolverRule', 'resolverSortDirection', 'resolverDiscriminatorValue',
  // B1a §4 step 1.1 — config v2 (additive; OPTIONAL on every mode; omitted ⇒ no behaviour change). Adding a
  // key HERE alone is NOT sufficient — normalizeReadSourceConfig below is the second, independent
  // enforcement point (persistence + content-key participation); both must carry the key or the field is
  // accepted and then silently dropped before storage.
  'orderingKeySpec', 'actionProfileVersion',
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
  } else if (Array.isArray(config.fieldMap)) {
    // One target, one source. Two entries writing the SAME target is not "try both spellings": the mapping
    // is a sequence of writes, so the last entry wins — and an entry that does not resolve writes null OVER
    // a real value an earlier entry had already read. The column then reads as empty everywhere while the
    // source had a value all along. Reject it where it is written, not where it silently loses data.
    const targets = new Set()
    const duplicated = config.fieldMap.some((entry) => {
      const target = entry && typeof entry.target === 'string' ? entry.target.trim() : null
      if (!target) return false
      if (targets.has(target)) return true
      targets.add(target)
      return false
    })
    if (duplicated) {
      push('READ_SOURCE_FIELD_MAP_INVALID', 'fieldMap', 'duplicate_target')
    }
  }

  // orderingKeySpec — B1a §4 step 1.1 (⟲R6 closed schema). OPTIONAL; omitted ⇒ no behaviour change. The
  // certificate holds only the capability-level orderingKeyRequirement (never customer columns, §3.1); this
  // is the CONCRETE customer field list + directions, and belongs at the config layer.
  if (config.orderingKeySpec !== undefined) {
    if (!Array.isArray(config.orderingKeySpec) || config.orderingKeySpec.length === 0) {
      push('READ_SOURCE_ORDERING_KEY_SPEC_INVALID', 'orderingKeySpec', 'must_be_non_empty_array')
    } else {
      // The ONLY place a target identifier is declared is fieldMap — every orderingKeySpec fieldId must
      // resolve through THIS SAME config version's fieldMap targets. No fieldMap ⇒ nothing resolves ⇒ every
      // fieldId is unresolvable (deliberate: no "skip when fieldMap is absent" escape hatch). This Set
      // dedupes a fieldMap that itself carries a duplicate target — harmless in practice only because the
      // fieldMap block above independently fail-closes that same body (duplicate_target, above), so a
      // resolution against a duplicate-target fieldMap is never observable through the public valid:true path.
      const fieldMapTargets = new Set(
        Array.isArray(config.fieldMap)
          ? config.fieldMap
            .filter((entry) => entry && typeof entry.target === 'string')
            .map((entry) => entry.target.trim())
          : [],
      )
      const seenFieldIds = new Set()
      for (const entry of config.orderingKeySpec) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Object.keys(entry).every((k) => k === 'fieldId' || k === 'direction')) {
          // Also the gate that keeps orderingKeySpec schema-only: NULLability (or any other per-entry flag,
          // e.g. a hypothetical "nullable") is deliberately NOT a schema key here — it stays fail-closed at
          // the qualification probe, where it is observable against the live source (§3.1⟲R6).
          push('READ_SOURCE_ORDERING_KEY_SPEC_INVALID', 'orderingKeySpec', 'invalid_entry_shape')
          continue
        }
        // Canonical fieldIds only — never raw SQL, expressions, or aliases. Same bounded-identifier shape as
        // fieldMap's `target` (the thing a fieldId must resolve to).
        if (!isBoundedIdentifier(entry.fieldId)) {
          push('READ_SOURCE_ORDERING_KEY_SPEC_INVALID', 'orderingKeySpec', 'field_id_invalid')
        } else {
          const fieldId = entry.fieldId.trim()
          if (seenFieldIds.has(fieldId)) {
            push('READ_SOURCE_ORDERING_KEY_SPEC_INVALID', 'orderingKeySpec', 'duplicate_field_id')
          }
          seenFieldIds.add(fieldId)
          if (!fieldMapTargets.has(fieldId)) {
            push('READ_SOURCE_ORDERING_KEY_SPEC_INVALID', 'orderingKeySpec', 'field_id_unresolved')
          }
        }
        // direction ∈ {ASC, DESC} ONLY, UPPERCASE-strict (deliberately NOT resolverSortDirection's lowercase
        // vocabulary — see ORDERING_KEY_DIRECTIONS above).
        if (!ORDERING_KEY_DIRECTIONS.includes(entry.direction)) {
          push('READ_SOURCE_ORDERING_KEY_SPEC_INVALID', 'orderingKeySpec', 'direction_invalid')
        }
      }
    }
  }

  // actionProfileVersion — B1a §4 step 1.1. OPTIONAL; omitted ⇒ no behaviour change. Validated against the
  // SAME PROFILE_ID_PATTERN vocabulary as GIP certification (imported above, never duplicated) so the two
  // cannot drift; this field must not move systemContentKey (GIP-D0 §6) — it is a config-plane value only.
  if (config.actionProfileVersion !== undefined) {
    if (
      typeof config.actionProfileVersion !== 'string' ||
      config.actionProfileVersion.length > 128 ||
      !PROFILE_ID_PATTERN.test(config.actionProfileVersion)
    ) {
      push('READ_SOURCE_ACTION_PROFILE_VERSION_INVALID', 'actionProfileVersion', 'not_allowlisted')
    }
  }

  // R0 resolver_lookup contract (rule-gated multiplicity; #1709 / resolver design-lock). The resolver keys
  // are rejected on any other mode; for resolver_lookup, resolverRule selects which rule-specific fields are
  // required vs forbidden. Values-free: reasons are coarse enums, no config value is echoed.
  if (config.mode !== 'resolver_lookup') {
    for (const key of RESOLVER_ONLY_KEYS) {
      if (config[key] !== undefined) push('READ_SOURCE_RESOLVER_KEY_NOT_ALLOWED', key, 'resolver_only_key')
    }
  } else {
    const rule = config.resolverRule
    const has = (k) => config[k] !== undefined
    // resolverRule presence is enforced by MODE_REQUIRED_FIELDS; validate the VALUE here (a pre-R0 config
    // with no resolverRule is already fail-closed via the required-field check — never reinterpreted).
    if (rule !== undefined && !RESOLVER_RULES.includes(rule)) {
      push('READ_SOURCE_RESOLVER_RULE_NOT_SUPPORTED', 'resolverRule', 'not_allowlisted')
    }
    if (config.resolverSortDirection !== undefined && !RESOLVER_SORT_DIRECTIONS.includes(config.resolverSortDirection)) {
      push('READ_SOURCE_RESOLVER_RULE_INVALID', 'resolverSortDirection', 'not_allowlisted')
    }
    // resolverDiscriminatorValue is config METADATA (a short enum-like token), never runtime data — reject a
    // host/path/secret/value-shaped string (bounded identifier + the global secret-shape scan below).
    if (config.resolverDiscriminatorValue !== undefined && !isBoundedIdentifier(config.resolverDiscriminatorValue)) {
      push('READ_SOURCE_RESOLVER_RULE_INVALID', 'resolverDiscriminatorValue', 'invalid_token')
    }
    // Rule-specific required / forbidden fields (only when the rule itself is a known value).
    if (RESOLVER_RULES.includes(rule)) {
      if (rule === 'exactly_one') {
        for (const k of ['multiplicityRuleField', 'resolverSortDirection', 'resolverDiscriminatorValue']) {
          if (has(k)) push('READ_SOURCE_RESOLVER_RULE_INVALID', k, 'not_allowed_for_exactly_one')
        }
      } else if (rule === 'first_when_sorted') {
        if (!has('multiplicityRuleField')) push('READ_SOURCE_RESOLVER_RULE_INVALID', 'multiplicityRuleField', 'required_sort_field_for_first_when_sorted')
        if (!has('resolverSortDirection')) push('READ_SOURCE_RESOLVER_RULE_INVALID', 'resolverSortDirection', 'required_for_first_when_sorted')
        if (has('resolverDiscriminatorValue')) push('READ_SOURCE_RESOLVER_RULE_INVALID', 'resolverDiscriminatorValue', 'not_allowed_for_first_when_sorted')
      } else if (rule === 'field_equals') {
        if (!has('multiplicityRuleField')) push('READ_SOURCE_RESOLVER_RULE_INVALID', 'multiplicityRuleField', 'required_discriminator_field_for_field_equals')
        if (!has('resolverDiscriminatorValue')) push('READ_SOURCE_RESOLVER_RULE_INVALID', 'resolverDiscriminatorValue', 'required_for_field_equals')
        if (has('resolverSortDirection')) push('READ_SOURCE_RESOLVER_RULE_INVALID', 'resolverSortDirection', 'not_allowed_for_field_equals')
      }
    }
    // fieldMap: REQUIRED and exactly ONE resolver output target for v1.
    if (config.fieldMap === undefined) {
      push('READ_SOURCE_RESOLVER_RULE_INVALID', 'fieldMap', 'resolver_requires_one_target')
    } else if (Array.isArray(config.fieldMap) && config.fieldMap.length !== 1) {
      push('READ_SOURCE_RESOLVER_RULE_INVALID', 'fieldMap', 'resolver_requires_exactly_one_target')
    }
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
  // R0 resolver_lookup contract fields (already validated; enum values are not trimmed as they are exact).
  if (config.resolverRule !== undefined) out.resolverRule = config.resolverRule
  if (config.resolverSortDirection !== undefined) out.resolverSortDirection = config.resolverSortDirection
  if (config.resolverDiscriminatorValue !== undefined) out.resolverDiscriminatorValue = config.resolverDiscriminatorValue.trim()
  // B1a §4 step 1.1 — THE SECOND enforcement point. ALLOWED_CONFIG_KEYS above decides acceptance only; this
  // key-by-key projection decides PERSISTENCE, and the store hashes exactly this output (`contentKeyFor`).
  // A key merely allowlisted and not copied here is accepted, then silently discarded before storage — add
  // both in lockstep with the allowlist, never here alone.
  if (config.orderingKeySpec !== undefined) {
    out.orderingKeySpec = Object.freeze(
      config.orderingKeySpec.map((entry) => Object.freeze({ fieldId: entry.fieldId.trim(), direction: entry.direction })),
    )
  }
  if (config.actionProfileVersion !== undefined) out.actionProfileVersion = config.actionProfileVersion.trim()
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
  RESOLVER_RULES,
  RESOLVER_SORT_DIRECTIONS,
  ORDERING_KEY_DIRECTIONS,
  isSafeRelativeReadPath,
  validateReadSourceConfig,
  normalizeReadSourceConfig,
}
