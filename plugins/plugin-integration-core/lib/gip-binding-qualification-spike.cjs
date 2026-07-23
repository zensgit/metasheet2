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
  'PROBE_STRATEGY_UNBOUND',
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

// The TOTAL-ORDER probe is ONE statement so both predicates are evaluated against
// ONE observed state (review P1: two independent reads are a torn check). Whether a
// single statement actually implies one source snapshot is a DIALECT/ISOLATION
// property — the PLATFORM does not assume it (review P1): the dialect, SQL shape and
// snapshot semantics come from an injected probeStrategy whose claims are the
// providing action profile's to certify at ITS gate. This module ships ONE reference
// strategy (PostgreSQL) and refuses to probe without an explicit strategy. The
// external-source read stays OUTSIDE and apart from any internal Activate transaction.
function buildOrderingKeyTotalOrderProbeSql({ objectName, keyColumns }) {
  const columns = normalizeKeyColumns(keyColumns)
  const dup = buildOrderingKeyDuplicateProbeSql({ objectName, keyColumns: columns })
  const nul = buildOrderingKeyNullProbeSql({ objectName, keyColumns: columns })
  // ::int casts (review P1): node-postgres returns int8 COUNT(*) as a STRING; the
  // sampled counts here are 0/1 by construction (LIMIT 1 subqueries), so int4 is
  // exact and arrives as a JS number on the real driver.
  return `SELECT (SELECT COUNT(*) FROM (${dup}) AS gip_duplicate_probe)::int AS duplicate_groups_sampled, (SELECT COUNT(*) FROM (${nul}) AS gip_null_probe)::int AS null_key_rows`
}

// Reference dialect strategy — PostgreSQL. `snapshotSemantics` is the STRATEGY'S
// claim (single statement executes under one MVCC snapshot in PG); a non-PG profile
// (e.g. SQL Server: no LIMIT, different isolation) must supply its own certified
// strategy — the platform never silently assumes this one.
const postgresTotalOrderProbeStrategy = Object.freeze({
  strategyId: 'gip.total_order_probe.postgres',
  strategyVersion: 'v1',
  dialect: 'postgres',
  snapshotSemantics: 'single_statement_mvcc',
  buildTotalOrderProbeSql: buildOrderingKeyTotalOrderProbeSql,
})

// STRATEGY BINDING (review P1): strategies are SERVER-REGISTERED implementations
// uniquely bound to an actionProfileVersion — runtime input never supplies strategy
// functions or claims. The registry is constructed server-side; probe resolves the
// strategy from the caller's actionProfileVersion alone, and the strategy IDENTITY
// (strategyId/strategyVersion + its registered dialect/snapshot claims) enters the
// CLOSED evidence fields (and therefore the qualification digest).
function createProbeStrategyRegistry(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    fail('QUALIFICATION_INPUT_INVALID', 'a probe-strategy registry needs at least one entry', { field: 'entries' })
  }
  const byProfile = new Map()
  for (const entry of entries) {
    if (!isPlainObject(entry) || typeof entry.buildTotalOrderProbeSql !== 'function') {
      fail('QUALIFICATION_INPUT_INVALID', 'a registry entry needs a strategy implementation', { field: 'entries' })
    }
    const actionProfileVersion = requiredString(entry.actionProfileVersion, 'entry.actionProfileVersion')
    if (byProfile.has(actionProfileVersion)) {
      // UNIQUE binding — a second strategy for the same profile is a wiring bug.
      fail('QUALIFICATION_INPUT_INVALID', 'an action profile is bound to two strategies', { field: 'entries' })
    }
    byProfile.set(actionProfileVersion, Object.freeze({
      strategyId: requiredIdentityToken(entry.strategyId, 'entry.strategyId'),
      strategyVersion: requiredIdentityToken(entry.strategyVersion, 'entry.strategyVersion'),
      dialect: requiredIdentityToken(entry.dialect, 'entry.dialect'),
      snapshotSemantics: requiredIdentityToken(entry.snapshotSemantics, 'entry.snapshotSemantics'),
      buildTotalOrderProbeSql: entry.buildTotalOrderProbeSql,
    }))
  }
  return Object.freeze({
    resolve(actionProfileVersion) {
      return byProfile.get(actionProfileVersion) || null
    },
    // brand: only a registry this module built is trusted by the prober factory.
    __gipTrustedRegistry: true,
  })
}

// SERVICE FACTORY (review P1): binds a TRUSTED registry once, server-side, and returns
// a prober whose probe() takes RUN DATA ONLY. A caller can never inject a fake
// duck-typed registry into the qualification chain — the registry is captured here,
// not per call, and must be one this module built (brand check).
function createBindingQualificationProber(strategyRegistry) {
  if (!isPlainObject(strategyRegistry) || strategyRegistry.__gipTrustedRegistry !== true
    || typeof strategyRegistry.resolve !== 'function') {
    fail('QUALIFICATION_INPUT_INVALID', 'a trusted probe-strategy registry (from createProbeStrategyRegistry) is required', { field: 'strategyRegistry' })
  }
  return Object.freeze({
    probe(input) {
      return probeWithTrustedRegistry(strategyRegistry, input)
    },
  })
}

// --- P1 (pg count shape): the real driver returns int8 counts as strings; after the
// ::int cast they arrive as numbers, but the acceptor is belt-and-braces — a safe
// non-negative decimal (number OR canonical digit string) is accepted, anything else
// fails closed.
const SAFE_COUNT_STRING = /^(0|[1-9][0-9]{0,14})$/
function normalizeProbeCount(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'string' && SAFE_COUNT_STRING.test(value)) return Number(value)
  return null
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
// Key material contract (review P2: a trimmed 1-char string secret signs valid MACs
// that are offline-brute-forceable since message+MAC are public): the secret is RAW
// BYTES — a Buffer/Uint8Array of at least 32 bytes (explicit binary encoding, no
// text trim, entropy is the key custodian's duty). Strings are refused outright.
const ENVELOPE_SECRET_MIN_BYTES = 32
function normalizeEnvelopeKey(envelopeKey) {
  if (!isPlainObject(envelopeKey)) {
    fail('QUALIFICATION_INPUT_INVALID', 'a server-held envelope key is required', { field: 'envelopeKey' })
  }
  const keyId = requiredString(envelopeKey.keyId, 'envelopeKey.keyId')
  const secret = envelopeKey.secret
  const secretBytes = Buffer.isBuffer(secret)
    ? secret
    : (secret instanceof Uint8Array ? Buffer.from(secret.buffer, secret.byteOffset, secret.byteLength) : null)
  if (secretBytes === null || secretBytes.length < ENVELOPE_SECRET_MIN_BYTES) {
    fail('QUALIFICATION_INPUT_INVALID', 'envelope secret must be raw bytes (Buffer/Uint8Array) of at least 32 bytes', { field: 'envelopeKey.secret' })
  }
  // OWN the bytes (review NIT, defense-in-depth): a defensive copy so a caller mutating
  // its Buffer cannot alias the key material. NB the MAC is already computed synchronously
  // within each call, so this copy is belt-and-braces, not a correctness fix for the
  // current synchronous flow.
  return { keyId, secret: Buffer.from(secretBytes) }
}

// Registry identity strings are SERVER-authored constants, but a malformed
// registration should fail loud, not silently ship control chars / megabyte ids into
// evidence (review NIT: shape hygiene, not a data leak).
function requiredIdentityToken(value, field) {
  const text = requiredString(value, field)
  if (text.length > 128 || /[\u0000-\u001f\u007f]/.test(text)) {
    fail('QUALIFICATION_INPUT_INVALID', 'identity token must be <=128 printable chars', { field })
  }
  return text
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

// INTERNAL: probe against a strategy resolved from the TRUSTED registry the factory
// (createBindingQualificationProber) captured server-side. `input` carries RUN DATA
// ONLY — never a registry or a strategy (review P1: a per-call registry was a
// duck-typed injection bypass — a fake registry could mint candidates and write
// arbitrary marker text into evidence). Not exported.
async function probeWithTrustedRegistry(trustedRegistry, input) {
  if (!isPlainObject(input) || typeof input.query !== 'function') {
    fail('QUALIFICATION_INPUT_INVALID', 'probe needs a query function and a plain-object input', {})
  }
  if (input.probeStrategy !== undefined || input.strategyRegistry !== undefined) {
    // run data may NOT carry a strategy or a registry — those are factory-bound.
    fail('QUALIFICATION_INPUT_INVALID', 'run input must not supply a strategy or registry (they are server-bound)', {})
  }
  const envelopeKey = normalizeEnvelopeKey(input.envelopeKey)
  const actionProfileVersion = requiredString(input.actionProfileVersion, 'actionProfileVersion')
  const strategy = trustedRegistry.resolve(actionProfileVersion)
  if (!strategy || typeof strategy.buildTotalOrderProbeSql !== 'function') {
    // fail closed by NAME: an unbound profile must never probe with a guessed dialect.
    fail('PROBE_STRATEGY_UNBOUND', 'no certified probe strategy is bound to this action profile', {})
  }
  const objectName = requiredString(input.objectKey, 'objectKey')
  const keyColumns = normalizeKeyColumns(input.keyColumns)
  // ONE statement per the injected strategy (whose snapshot claim is profile-certified).
  const rows = await runReadOnlyProbe(
    input.query,
    strategy.buildTotalOrderProbeSql({ objectName, keyColumns }),
  )
  const summary = rows.length === 1 && isPlainObject(rows[0]) ? rows[0] : null
  const duplicateGroups = summary ? normalizeProbeCount(summary.duplicate_groups_sampled) : null
  const nullRows = summary ? normalizeProbeCount(summary.null_key_rows) : null
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
    probeStrategyId: strategy.strategyId,
    probeStrategyVersion: strategy.strategyVersion,
    probeDialect: strategy.dialect,
    snapshotSemantics: strategy.snapshotSemantics,
    checkedKeyColumnCount: keyColumns.length,
    duplicateGroupsFound: 0,
    nullKeyRowsFound: 0,
    probedAt: requiredUtcInstant(input.probedAt, 'probedAt'),
  })
  const qualificationDigest = computeQualificationDigest({
    actionProfileVersion,
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
  // strict hex syntax + decoded length BEFORE timingSafeEqual (review P2: a 64-char
  // non-hex MAC made Buffer.from decode short and timingSafeEqual throw
  // ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH — escaping the frozen vocabulary).
  const provided = typeof qualification.envelopeMac === 'string' ? qualification.envelopeMac : ''
  if (!/^[0-9a-f]{64}$/.test(provided)) {
    fail('QUALIFICATION_ENVELOPE_MISMATCH', 'qualification lifecycle fields are not authenticated', {})
  }
  const expectedBuffer = Buffer.from(expectedMac, 'hex')
  const providedBuffer = Buffer.from(provided, 'hex')
  if (providedBuffer.length !== expectedBuffer.length
    || !crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
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
  postgresTotalOrderProbeStrategy,
  createProbeStrategyRegistry,
  createBindingQualificationProber,
  verifyBindingQualification,
  __internals: {
    fail,
    stableStringify,
    assertReadOnlySql,
    quoteIdentifier,
  },
}
