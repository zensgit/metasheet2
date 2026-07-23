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
const { CanonicalDomainError, stableCanonicalStringify } = require('./gip-canonical-json.cjs')

const QUALIFICATION_ERROR_REASONS = Object.freeze([
  'QUALIFICATION_INPUT_INVALID',
  'PROBE_SQL_NOT_READ_ONLY',
  'PROBE_QUERY_FAILED',
  'ORDERING_KEY_DUPLICATE_FOUND',
  'ORDERING_KEY_NULL_FOUND',
  'QUALIFICATION_NOT_OBJECT',
  'QUALIFICATION_DIGEST_MISMATCH',
  'QUALIFICATION_ENVELOPE_MISMATCH',
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
  const parsed = Date.parse(text)
  // Format pin AND calendar round-trip: Date.parse NORMALIZES impossible calendar
  // dates (2026-02-30 → 2026-03-02, review P2) — only a value that reproduces itself
  // byte-for-byte through toISOString is a real instant.
  if (!ISO_UTC_SECONDS.test(text) || Number.isNaN(parsed)
    || new Date(parsed).toISOString() !== text.replace(/Z$/, '.000Z')) {
    fail('QUALIFICATION_INPUT_INVALID', 'timestamps must be strict, calendar-valid UTC ISO-8601 (YYYY-MM-DDThh:mm:ssZ)', { field })
  }
  return text
}

// Serialization = the ONE shared strict canonical codec (review P2: two partial
// definitions drifted). Domain violations (Date/class instances/sparse arrays/
// non-finite/undefined…) become QUALIFICATION_INPUT_INVALID, fail-closed.
function stableStringify(value) {
  try {
    return stableCanonicalStringify(value)
  } catch (error) {
    if (error instanceof CanonicalDomainError) {
      fail('QUALIFICATION_INPUT_INVALID', 'digest material must stay in the strict canonical JSON domain', {})
    }
    throw error
  }
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
function normalizeKeyColumns(keyColumns) {
  if (!Array.isArray(keyColumns) || keyColumns.length === 0) {
    fail('QUALIFICATION_INPUT_INVALID', 'keyColumns must be a non-empty array', { field: 'keyColumns' })
  }
  const seen = new Set()
  for (const column of keyColumns) {
    const name = requiredString(column, 'keyColumns')
    if (seen.has(name)) {
      // A duplicated column declaration cannot strengthen an order and hides a
      // mis-configured composite key (review P2) — reject, never dedupe silently.
      fail('QUALIFICATION_INPUT_INVALID', 'keyColumns must not contain duplicate columns', { field: 'keyColumns' })
    }
    seen.add(name)
  }
  return [...seen]
}

function buildOrderingKeyDuplicateProbeSql({ objectName, keyColumns }) {
  const object = quoteIdentifier(objectName)
  const cols = normalizeKeyColumns(keyColumns).map((column) => quoteIdentifier(column)).join(', ')
  return `SELECT ${cols}, COUNT(*) AS duplicate_count FROM ${object} GROUP BY ${cols} HAVING COUNT(*) > 1 LIMIT 1`
}

function buildOrderingKeyNullProbeSql({ objectName, keyColumns }) {
  const object = quoteIdentifier(objectName)
  const predicate = normalizeKeyColumns(keyColumns)
    .map((column) => `${quoteIdentifier(column)} IS NULL`)
    .join(' OR ')
  return `SELECT 1 AS null_key_row FROM ${object} WHERE ${predicate} LIMIT 1`
}

// The TOTAL-ORDER probe is ONE statement (review P1: two independent reads are a
// torn check — read A and read B can each look clean while no single snapshot
// satisfies both predicates). A single statement executes under one source snapshot
// (statement-level consistency); this external-source read stays OUTSIDE and apart
// from any internal Activate transaction.
function buildOrderingKeyTotalOrderProbeSql({ objectName, keyColumns }) {
  const columns = normalizeKeyColumns(keyColumns)
  const dup = buildOrderingKeyDuplicateProbeSql({ objectName, keyColumns: columns })
  const nul = buildOrderingKeyNullProbeSql({ objectName, keyColumns: columns })
  return `SELECT (SELECT COUNT(*) FROM (${dup}) AS gip_duplicate_probe) AS duplicate_groups_sampled, (SELECT COUNT(*) FROM (${nul}) AS gip_null_probe) AS null_key_rows`
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
async function runReadOnlyProbe(query, sql) {
  const text = assertReadOnlySql(sql)
  let rows
  try {
    const result = await query(text)
    rows = Array.isArray(result && result.rows) ? result.rows : null
  } catch (_error) {
    fail('PROBE_QUERY_FAILED', 'qualification probe query failed', { errorType: 'source_runtime' })
  }
  if (rows === null) {
    fail('PROBE_QUERY_FAILED', 'qualification probe returned no verifiable row plane', {})
  }
  return rows
}

// Lifecycle fields are AUTHENTICATED with a KEYED MAC (review P1: an unkeyed hash
// over public values is an integrity checksum anyone can recompute after postponing
// expiresAt — not authentication). The envelope key is SERVER-HELD material with an
// explicit lifecycle: { keyId, secret } — keyId travels with the qualification
// (public, selects the verifier's key at rotation), the secret never leaves the
// server side and never appears in qualifications, evidence or errors. Rotation /
// revocation = keyring by keyId at the (gated) binding runtime; the spike freezes
// the shape. The ratified 6-input qualificationDigest tuple stays untouched.
function normalizeEnvelopeKey(envelopeKey) {
  if (!isPlainObject(envelopeKey)) {
    fail('QUALIFICATION_INPUT_INVALID', 'a server-held envelope key is required', { field: 'envelopeKey' })
  }
  return {
    keyId: requiredString(envelopeKey.keyId, 'envelopeKey.keyId'),
    secret: requiredString(envelopeKey.secret, 'envelopeKey.secret'),
  }
}

function computeEnvelopeMac({ envelopeKey, qualificationDigest, status, expiresAt }) {
  const key = normalizeEnvelopeKey(envelopeKey)
  return crypto.createHmac('sha256', key.secret).update(stableStringify({
    keyId: key.keyId,
    qualificationDigest: requiredString(qualificationDigest, 'qualificationDigest'),
    status: requiredString(status, 'status'),
    expiresAt: expiresAt === undefined ? null : requiredString(expiresAt, 'expiresAt'),
  })).digest('hex')
}

async function probeBindingQualification(input) {
  if (!isPlainObject(input) || typeof input.query !== 'function') {
    fail('QUALIFICATION_INPUT_INVALID', 'probe needs a query function and a plain-object input', {})
  }
  const envelopeKey = normalizeEnvelopeKey(input.envelopeKey)
  const objectName = requiredString(input.objectKey, 'objectKey')
  const keyColumns = normalizeKeyColumns(input.keyColumns)
  // ONE statement, one source snapshot (review P1: no torn two-read qualification).
  const rows = await runReadOnlyProbe(
    input.query,
    buildOrderingKeyTotalOrderProbeSql({ objectName, keyColumns }),
  )
  const summary = rows.length === 1 ? rows[0] : null
  const duplicateGroups = summary && Number.isInteger(summary.duplicate_groups_sampled)
    ? summary.duplicate_groups_sampled : null
  const nullRows = summary && Number.isInteger(summary.null_key_rows)
    ? summary.null_key_rows : null
  if (duplicateGroups === null || nullRows === null) {
    fail('PROBE_QUERY_FAILED', 'qualification probe returned no verifiable summary row', {})
  }
  if (duplicateGroups > 0) {
    // Fail closed — and do NOT echo the duplicated key values (values-free).
    fail('ORDERING_KEY_DUPLICATE_FOUND', 'ordering key is not a stable total order on this object', {
      duplicateGroupsSampled: duplicateGroups,
    })
  }
  if (nullRows > 0) {
    // NULL key components are incomparable — no total order (review P2). Values-free.
    fail('ORDERING_KEY_NULL_FOUND', 'ordering key has NULL components on this object', {})
  }
  const evidence = Object.freeze({
    probeKind: 'ordering_key_total_order_negative',
    checkedKeyColumnCount: keyColumns.length,
    duplicateGroupsFound: 0,
    nullKeyRowsFound: 0,
    probedAt: requiredUtcInstant(input.probedAt, 'probedAt'),
  })
  const qualificationDigest = computeQualificationDigest({
    actionProfileVersion: input.actionProfileVersion,
    systemContentKey: input.systemContentKey,
    configContentKey: input.configContentKey,
    objectKey: objectName,
    canonicalObjectVersion: input.canonicalObjectVersion,
    evidence,
  })
  const expiresAt = input.expiresAt !== undefined
    ? requiredUtcInstant(input.expiresAt, 'expiresAt')
    : undefined
  return Object.freeze({
    status: 'candidate',
    qualificationDigest,
    envelopeKeyId: envelopeKey.keyId,
    envelopeMac: computeEnvelopeMac({ envelopeKey, qualificationDigest, status: 'candidate', expiresAt }),
    evidence,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  })
}

// verifyBindingQualification — PURE LOCAL, transaction-safe: recomputes the digest
// from the caller's expected inputs + the qualification's own evidence, then checks
// binding, status and expiry. ZERO external I/O by construction. An expired
// qualification fails closed (QUALIFICATION_EXPIRED) — Run-start proper never
// probes; it requires a fresh Preflight instead.
function verifyBindingQualification({ qualification, expectedInputs, envelopeKey, now }) {
  if (!isPlainObject(qualification) || !isPlainObject(expectedInputs)) {
    fail('QUALIFICATION_NOT_OBJECT', 'qualification and expectedInputs must be plain objects', {})
  }
  const key = normalizeEnvelopeKey(envelopeKey)
  if (!QUALIFICATION_STATUSES.includes(qualification.status) || qualification.status !== 'candidate') {
    fail('QUALIFICATION_STATUS_INVALID', 'only a candidate qualification is verifiable', {})
  }
  // AUTHENTICATE lifecycle before trusting it (review P1): the MAC is keyed with
  // SERVER-HELD secret material — a caller postponing expiresAt cannot recompute a
  // valid envelope from public values. keyId selects the key (rotation-ready).
  if (qualification.envelopeKeyId !== key.keyId) {
    fail('QUALIFICATION_ENVELOPE_MISMATCH', 'qualification lifecycle fields are not authenticated', {})
  }
  const expectedMac = computeEnvelopeMac({
    envelopeKey: key,
    qualificationDigest: qualification.qualificationDigest,
    status: qualification.status,
    expiresAt: qualification.expiresAt,
  })
  const provided = typeof qualification.envelopeMac === 'string' ? qualification.envelopeMac : ''
  const expectedBuffer = Buffer.from(expectedMac, 'hex')
  const providedBuffer = provided.length === expectedMac.length ? Buffer.from(provided, 'hex') : null
  if (providedBuffer === null || !crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
    fail('QUALIFICATION_ENVELOPE_MISMATCH', 'qualification lifecycle fields are not authenticated', {})
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
  computeEnvelopeMac,
  buildOrderingKeyDuplicateProbeSql,
  buildOrderingKeyNullProbeSql,
  buildOrderingKeyTotalOrderProbeSql,
  probeBindingQualification,
  verifyBindingQualification,
  __internals: {
    fail,
    stableStringify,
    assertReadOnlySql,
    quoteIdentifier,
  },
}
