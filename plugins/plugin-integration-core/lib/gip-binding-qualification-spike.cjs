'use strict'

// GIP-D0 binding-qualification READ-ONLY spike — a LATENT prototype (not wired to
// any runtime).
//
// RATIFY SCOPE (owner 2026-07-23, GIP-D0 @ d58ec38f4): item (3) — the read-only
// qualification spike. It prototypes the two frozen functions of GIP-D0 §3/§5:
//
//   probeBindingQualification()   OUTSIDE any transaction: touches the external
//                                 source (via an injected query fn) and produces
//                                 CANDIDATE evidence. External probing exists ONLY
//                                 here (charter: "外部网络探测只在 Preflight，绝不
//                                 进入数据库事务").
//   verifyBindingQualification()  PURE LOCAL, transaction-safe: recomputes and
//                                 checks digest, input binding, expiry and status —
//                                 ZERO external I/O by construction (it takes no
//                                 query fn at all).
//
// READ-ONLY is enforced, not assumed: the probe SQL builder emits a single SELECT
// and the probe refuses to run anything else (assertReadOnlySql). No write, no DDL,
// no runtime wiring, no route. Qualification objects are SERVER-generated,
// values-free, input-bound (digest binds every input — no cross-object reuse) and
// optionally expiring; customers can never submit or reuse one (enforced at the
// future binding runtime — the spike freezes the shapes that make it checkable).

const crypto = require('node:crypto')

const QUALIFICATION_ERROR_REASONS = Object.freeze([
  'QUALIFICATION_INPUT_INVALID',
  'PROBE_SQL_NOT_READ_ONLY',
  'PROBE_QUERY_FAILED',
  'ORDERING_KEY_DUPLICATE_FOUND',
  'QUALIFICATION_NOT_OBJECT',
  'QUALIFICATION_DIGEST_MISMATCH',
  'QUALIFICATION_EXPIRED',
  'QUALIFICATION_STATUS_INVALID',
])
const QUALIFICATION_ERROR_REASON_SET = new Set(QUALIFICATION_ERROR_REASONS)

const QUALIFICATION_STATUSES = Object.freeze(['candidate', 'revoked'])

class GipQualificationError extends Error {
  constructor(reason, message, details = {}) {
    super(message)
    this.name = 'GipQualificationError'
    this.reason = reason
    this.details = details
  }
}

function fail(reason, message, details) {
  if (!QUALIFICATION_ERROR_REASON_SET.has(reason)) {
    // COARSE fixed token — never echo the rejected reason value.
    throw new Error(
      'gip-binding-qualification-spike internal: undeclared error reason '
        + '(add it to the frozen QUALIFICATION_ERROR_REASONS vocabulary)',
    )
  }
  throw new GipQualificationError(reason, message, details)
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('QUALIFICATION_INPUT_INVALID', 'a required qualification input is missing', { field })
  }
  return value.trim()
}

// Timestamps are pinned to strict second-precision UTC ISO-8601 and compared
// NUMERICALLY — a raw lexicographic compare over mixed representations silently
// verifies an EXPIRED qualification (review P3: fail-open inversion). Any other
// format fails closed.
const ISO_UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/
function requiredUtcInstant(value, field) {
  const text = requiredString(value, field)
  if (!ISO_UTC_SECONDS.test(text) || Number.isNaN(Date.parse(text))) {
    fail('QUALIFICATION_INPUT_INVALID', 'timestamps must be strict UTC ISO-8601 (YYYY-MM-DDThh:mm:ssZ)', { field })
  }
  return text
}

// Deterministic serialization: sorted keys, no whitespace variance — the SAME
// stableStringify shape used by the large-bom sealed-artifact digest precedent.
function stableStringify(value) {
  if (value === undefined) {
    // undefined has no JSON form: JSON.stringify would emit the bare token
    // `undefined` (and silently DROP undefined array entries — ss([undefined]) ===
    // ss([]) is a digest collision). Evidence is server-built; undefined anywhere is
    // a programming error — fail loud, never collide (review NIT).
    fail('QUALIFICATION_INPUT_INVALID', 'digest material must not contain undefined', {})
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

// qualificationDigest (GIP-D0 §3, frozen shape) — the SINGLE authoritative
// actionProfileVersion is the only version input (the action/queryPreset version is
// pinned inside the profile definition, never an independent digest input):
//
//   H(actionProfileVersion + systemContentKey + configContentKey
//     + objectKey + canonicalObjectVersion + normalized qualification evidence)
function computeQualificationDigest(input) {
  if (!isPlainObject(input)) {
    fail('QUALIFICATION_INPUT_INVALID', 'digest input must be a plain object', {})
  }
  const material = {
    actionProfileVersion: requiredString(input.actionProfileVersion, 'actionProfileVersion'),
    systemContentKey: requiredString(input.systemContentKey, 'systemContentKey'),
    configContentKey: requiredString(input.configContentKey, 'configContentKey'),
    objectKey: requiredString(input.objectKey, 'objectKey'),
    canonicalObjectVersion: requiredString(input.canonicalObjectVersion, 'canonicalObjectVersion'),
    evidence: isPlainObject(input.evidence) ? input.evidence : fail('QUALIFICATION_INPUT_INVALID', 'evidence must be a plain object', { field: 'evidence' }),
  }
  return crypto.createHash('sha256').update(stableStringify(material)).digest('hex')
}

// Identifier hygiene for the probe SQL builder: double-quoted identifiers with
// embedded quotes doubled — never string-interpolated raw.
function quoteIdentifier(name) {
  const trimmed = requiredString(name, 'identifier')
  return `"${trimmed.replace(/"/g, '""')}"`
}

// Ordering-key uniqueness NEGATIVE probe (GIP-D0 §6.2 / scale-D0 §6.2): a view must
// PROVE a stable total order — the duplicate-key probe must return ZERO rows within
// the SAME snapshot the read would use. SELECT-only by construction.
function buildOrderingKeyDuplicateProbeSql({ objectName, keyColumns }) {
  const object = quoteIdentifier(objectName)
  if (!Array.isArray(keyColumns) || keyColumns.length === 0) {
    fail('QUALIFICATION_INPUT_INVALID', 'keyColumns must be a non-empty array', { field: 'keyColumns' })
  }
  const cols = keyColumns.map((column) => quoteIdentifier(column)).join(', ')
  return `SELECT ${cols}, COUNT(*) AS duplicate_count FROM ${object} GROUP BY ${cols} HAVING COUNT(*) > 1 LIMIT 1`
}

// The probe refuses to execute anything but a single SELECT — read-only is a
// runtime guard here, not a comment.
function assertReadOnlySql(sql) {
  const text = String(sql).trim()
  // Write-free, not merely "starts with SELECT": SELECT ... INTO creates a table,
  // setval/nextval mutate sequences, advisory locks take server state, FOR UPDATE/
  // SHARE takes row locks (review findings). The builder is safe by construction —
  // this guard is defense-in-depth and is wired on the probe's ONLY execution path.
  if (!/^SELECT\b/i.test(text) || /;/.test(text)
    || /\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COPY|INTO|SETVAL|NEXTVAL|PG_ADVISORY_LOCK|PG_ADVISORY_XACT_LOCK|PG_TRY_ADVISORY_LOCK)\b/i.test(text)
    || /\bFOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b/i.test(text)) {
    fail('PROBE_SQL_NOT_READ_ONLY', 'qualification probe may only execute a single write-free SELECT', {})
  }
  return text
}

// probeBindingQualification — OUTSIDE any transaction (the caller supplies a plain
// query fn; the spike never opens/joins a transaction). Produces a CANDIDATE
// qualification whose digest binds every input. Values-free evidence: counts and
// booleans only — never key values, never row content.
async function probeBindingQualification(input) {
  if (!isPlainObject(input) || typeof input.query !== 'function') {
    fail('QUALIFICATION_INPUT_INVALID', 'probe needs a query function and a plain-object input', {})
  }
  const objectName = requiredString(input.objectKey, 'objectKey')
  const keyColumns = input.keyColumns
  const sql = assertReadOnlySql(buildOrderingKeyDuplicateProbeSql({ objectName, keyColumns }))
  let rows
  try {
    const result = await input.query(sql)
    rows = Array.isArray(result && result.rows) ? result.rows : null
  } catch (_error) {
    fail('PROBE_QUERY_FAILED', 'qualification probe query failed', { errorType: 'source_runtime' })
  }
  if (rows === null) {
    fail('PROBE_QUERY_FAILED', 'qualification probe returned no verifiable row plane', {})
  }
  if (rows.length > 0) {
    // Fail closed — and do NOT echo the duplicated key values (values-free).
    fail('ORDERING_KEY_DUPLICATE_FOUND', 'ordering key is not a stable total order on this object', {
      duplicateGroupsSampled: rows.length,
    })
  }
  const evidence = Object.freeze({
    probeKind: 'ordering_key_uniqueness_negative',
    checkedKeyColumnCount: keyColumns.length,
    duplicateGroupsFound: 0,
    probedAt: requiredUtcInstant(input.probedAt, 'probedAt'),
  })
  const digestInput = {
    actionProfileVersion: input.actionProfileVersion,
    systemContentKey: input.systemContentKey,
    configContentKey: input.configContentKey,
    objectKey: objectName,
    canonicalObjectVersion: input.canonicalObjectVersion,
    evidence,
  }
  return Object.freeze({
    status: 'candidate',
    qualificationDigest: computeQualificationDigest(digestInput),
    evidence,
    ...(input.expiresAt !== undefined
      ? { expiresAt: requiredUtcInstant(input.expiresAt, 'expiresAt') }
      : {}),
  })
}

// verifyBindingQualification — PURE LOCAL, transaction-safe: recomputes the digest
// from the caller's expected inputs + the qualification's own evidence, then checks
// binding, status and expiry. ZERO external I/O by construction. An expired
// qualification fails closed (QUALIFICATION_EXPIRED) — Run-start proper never
// probes; it requires a fresh Preflight instead.
function verifyBindingQualification({ qualification, expectedInputs, now }) {
  if (!isPlainObject(qualification) || !isPlainObject(expectedInputs)) {
    fail('QUALIFICATION_NOT_OBJECT', 'qualification and expectedInputs must be plain objects', {})
  }
  if (!QUALIFICATION_STATUSES.includes(qualification.status) || qualification.status !== 'candidate') {
    fail('QUALIFICATION_STATUS_INVALID', 'only a candidate qualification is verifiable', {})
  }
  if (qualification.expiresAt !== undefined) {
    const nowInstant = Date.parse(requiredUtcInstant(now, 'now'))
    const expiresInstant = Date.parse(requiredUtcInstant(qualification.expiresAt, 'expiresAt'))
    if (expiresInstant <= nowInstant) {
      fail('QUALIFICATION_EXPIRED', 'qualification expired; a fresh Preflight is required', {})
    }
  }
  const recomputed = computeQualificationDigest({
    actionProfileVersion: expectedInputs.actionProfileVersion,
    systemContentKey: expectedInputs.systemContentKey,
    configContentKey: expectedInputs.configContentKey,
    objectKey: expectedInputs.objectKey,
    canonicalObjectVersion: expectedInputs.canonicalObjectVersion,
    evidence: qualification.evidence,
  })
  if (recomputed !== qualification.qualificationDigest) {
    // Input-binding violation (cross-object / cross-config reuse, or tampering).
    fail('QUALIFICATION_DIGEST_MISMATCH', 'qualification does not bind these inputs', {})
  }
  return Object.freeze({ verified: true, qualificationDigest: recomputed })
}

module.exports = {
  QUALIFICATION_ERROR_REASONS,
  QUALIFICATION_STATUSES,
  GipQualificationError,
  computeQualificationDigest,
  buildOrderingKeyDuplicateProbeSql,
  probeBindingQualification,
  verifyBindingQualification,
  __internals: {
    fail,
    stableStringify,
    assertReadOnlySql,
    quoteIdentifier,
  },
}
