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

// -- §4 step 1.5 (B1a-3): the legacy caller-supplied-tuple entry point is GONE ---
// `createBindingQualificationProber(...)` used to return `Object.freeze({ probe })`,
// and that `probe(input)` accepted a caller-supplied `query`, `keyColumns`,
// `systemContentKey`, `configContentKey`, `objectKey`, `canonicalObjectVersion` and
// `actionProfileVersion`. That construction — residual 1 of B-1 — is RETIRED AS
// INEXPRESSIBLE, not detected: the frozen prober object's EXACT KEY SET is now
// `{ probeFromResolution }`, so a re-addition under ANY name (including a symbol)
// reds the pin. B-1 rejects detection in favour of inexpressibility, so "keep
// probe() and add a check" was not an option.
//
// The six tuple fields now come from a trusted RESOLUTION, and execution comes from
// a CLOSURE-BOUND server-bound source executor (§4 step 1.4, δ=(c): certified HTTP
// probe actions only). Under δ=(c) the SQL builders below stay REACHABLE AS
// BUILDERS but are on NO probe path — that is the accepted v1 outcome.
const crypto = require('node:crypto')
const { CanonicalDomainError, stableCanonicalStringify } = require('./gip-canonical-json.cjs')
const { isTrustedBindingResolution } = require('./gip-approved-binding-resolver.cjs')
const { isTrustedServerBoundSourceExecutor } = require('./gip-server-bound-source-executor.cjs')

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
  // B1a-3 §4 step 1.5 — residual 2's NAMED closed refusal. Any key outside the
  // resolution-bound closed allowlist is refused under THIS token, so a
  // caller-supplied query, connection handle, statement or executor is refused
  // under ANY input key, including a novel one and a symbol.
  'PROBE_CALLER_SUPPLIED_EXECUTION_REFUSED',
  'PROBE_EXECUTOR_UNTRUSTED',
  'PROBE_RESOLUTION_UNTRUSTED',
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

// -- V-7 FIX (B1a-3, §4 step 1.5's "1.4's builder identity") ------------------
// This module used to hold a `trustedProbeStrategyRegistries` WeakSet whose SOLE
// WRITER was the EXPORTED `createProbeStrategyRegistry`. That is the shape the
// owner ruled on for #4610's registries — "a public factory whose products are
// trusted is equivalent to no trust check at all" — and it was still LIVE here:
// any importer could mint a *trusted* registry carrying its own
// `buildTotalOrderProbeSql` AND its own `snapshotSemantics`, which was written into
// closed evidence and therefore into the qualification digest.
//
// The hole is CLOSED BY REMOVAL, which is stronger than splitting build from trust:
// under δ=(c) no probe path resolves a SQL strategy at all, so there is no trust set
// left for a public factory to write into. `createProbeStrategyRegistry` below is
// now BUILD-ONLY — calling it, from anywhere, confers NOTHING and reaches no probe.
// The build/trust split for the surface that IS live moved to
// `gip-server-bound-source-executor.cjs`'s HTTP probe-action registry, where the
// granting constructor is exported nowhere.

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
  // INDEX LOOP, not `for...of` (P2-C, B1a-3 round 3): `entries` is a CALLER array, so
  // `for...of` hands control to an attacker-reachable `Symbol.iterator` mid-loop —
  // the same channel the two new modules already close by index-based iteration.
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
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
  // BUILD-ONLY. No trust is granted here, by design — see the V-7 note above.
  return Object.freeze({
    resolve(actionProfileVersion) {
      return byProfile.get(actionProfileVersion) || null
    },
  })
}

// SERVICE FACTORY. Authority is CLOSURE-BOUND at construction: the server-bound
// source executor is captured HERE, once, and admitted by OBJECT IDENTITY through
// its owning module's checker. The per-call entry point takes a trusted RESOLUTION
// and run-lifecycle data only — there is no seam through which a caller could pass
// a registry, a strategy, a connection handle, a statement or a query.
const PROBE_RUN_INPUT_KEYS = Object.freeze(['resolution', 'envelopeKey', 'probedAt', 'expiresAt'])
const PROBE_RUN_INPUT_KEY_SET = new Set(PROBE_RUN_INPUT_KEYS)

function createBindingQualificationProber(components) {
  if (!isPlainObject(components)) {
    fail('PROBE_EXECUTOR_UNTRUSTED', 'a trusted server-bound source executor is required', {})
  }
  const executor = components.executor
  // WeakSet-backed checker: returns false for primitives and null, never throws. A
  // duck-typed object carrying every expected public field is refused here.
  if (!isTrustedServerBoundSourceExecutor(executor)) {
    fail('PROBE_EXECUTOR_UNTRUSTED', 'a trusted server-bound source executor is required', {})
  }
  // EXACT KEY SET — `{ probeFromResolution }` and nothing that accepts a
  // caller-supplied tuple. Pinned by set equality in the test, so a re-addition
  // under any name (plausible, obscure or symbol-keyed) reds.
  return Object.freeze({
    probeFromResolution(input) {
      return probeFromTrustedResolution(executor, input)
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

// B1a-3 §4 step 1.5: the SQL execution path (`runReadOnlyProbe`) is REMOVED, not
// privatised. It was the only consumer of a caller-supplied `query` function, and
// under δ=(c) nothing may reach a SQL source. `assertReadOnlySql` survives as an
// exported guard over the builders below, which remain BUILDERS on no probe path —
// "SQL builders stay unreachable, that is the accepted v1 outcome".

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
  // OWN the bytes — LOAD-BEARING (review P2 round-5, corrected round-6; the named
  // await window CORRECTED again in round 3 of B1a-3). The comment used to name
  // `await runReadOnlyProbe(...)` as the window, but THIS PR DELETED that symbol —
  // the SQL execution path is gone. The window is now
  // `await executor.executeOrderingKeyProbe(resolution)` in
  // `probeFromTrustedResolution`, which sits BETWEEN this copy and
  // computeEnvelopeMac. Without the copy, a caller mutating its own Buffer inside the
  // connector's execute callback (during that await) would change the bytes the MAC
  // is computed under — the async-window test REDs on removal. The invariant is
  // unchanged and still tested; only the name of the await was stale.
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

// GUARDED READ of caller-supplied run input (B1a-3 round 3, P1-B).
//
// The allowlist below refuses an UNDECLARED key. It does NOT protect the four
// ALLOWLISTED reads, because `Object.keys()` enumeration does not invoke getters:
// a throwing getter parked on an allowlisted key NAME passes the allowlist intact
// and then fires on READ. If that throw escapes, raw attacker text lands in the
// caller's `message` and `stack` — the same leak channel the two new modules close.
// A non-enumerable getter does not even appear in `Object.keys()`.
//
// Same SHAPE as `gip-server-bound-source-executor.cjs`'s `safeRead` (:91) and the
// §4 step 1.6 read-observability contracts module's (:64) — that module's basename
// is deliberately NOT written out here, because its own latency enumeration treats
// any file mentioning it as a consumer. Catch, DISCARD UNCONDITIONALLY
// (no `cause`, no `message`, no `stack`, no class exemption), fail closed under the
// reason already declared for hostile run input. The signature differs only because
// this module's `fail` is `fail(reason, message, details)`: the message is the
// existing FIXED first-party string and `details` is `{}` — nothing is derived from
// the discarded error.
function safeReadRunInput(input, key) {
  try {
    return input[key]
  } catch (_error) {
    fail('PROBE_CALLER_SUPPLIED_EXECUTION_REFUSED', 'run input must carry only resolution-bound lifecycle data', {})
  }
  return undefined
}

// INTERNAL, not exported. The RESOLUTION-BOUND probe path (§4 step 1.4 + 1.5).
//
// Every one of the six digest inputs comes from the trusted resolution. `input`
// carries run-LIFECYCLE data only, on a CLOSED ALLOWLIST — so a caller-supplied
// `query`, connection handle, statement, executor, registry or strategy is refused
// under ANY key name, with the NAMED closed reason
// PROBE_CALLER_SUPPLIED_EXECUTION_REFUSED. That is residual 2, closed as a named
// refusal; residual 1 is closed one level up, as inexpressibility.
async function probeFromTrustedResolution(executor, input) {
  if (!isPlainObject(input)) {
    fail('QUALIFICATION_INPUT_INVALID', 'probe needs a plain-object run input', {})
  }
  // ALLOWLIST, not a denylist. A denylist of the names known today lets an executor
  // arrive under a novel key.
  let inputKeys
  try {
    inputKeys = Object.keys(input)
  } catch (_error) {
    // The ownKeys trap throws during ENUMERATION — discard unconditionally.
    fail('PROBE_CALLER_SUPPLIED_EXECUTION_REFUSED', 'run input must carry only resolution-bound lifecycle data', {})
  }
  for (let index = 0; index < inputKeys.length; index += 1) {
    if (!PROBE_RUN_INPUT_KEY_SET.has(inputKeys[index])) {
      fail('PROBE_CALLER_SUPPLIED_EXECUTION_REFUSED', 'run input must carry only resolution-bound lifecycle data', {})
    }
  }
  let inputSymbols
  try {
    inputSymbols = Object.getOwnPropertySymbols(input)
  } catch (_error) {
    fail('PROBE_CALLER_SUPPLIED_EXECUTION_REFUSED', 'run input must carry only resolution-bound lifecycle data', {})
  }
  if (inputSymbols.length > 0) {
    // A symbol-keyed executor is still an executor.
    fail('PROBE_CALLER_SUPPLIED_EXECUTION_REFUSED', 'run input must carry only resolution-bound lifecycle data', {})
  }

  // GUARDED (P1-B): the allowlist above does not cover a getter parked on an
  // ALLOWLISTED key name — enumeration never invokes it.
  const resolution = safeReadRunInput(input, 'resolution')
  // Trust is OBJECT IDENTITY. A hand-built object carrying every expected public
  // field — and any plausible brand — is refused BY NAME.
  if (!isTrustedBindingResolution(resolution)) {
    fail('PROBE_RESOLUTION_UNTRUSTED', 'a resolution minted by the approved-binding resolver is required', {})
  }
  const envelopeKey = normalizeEnvelopeKey(safeReadRunInput(input, 'envelopeKey'))

  // Execution is the CLOSURE-BOUND executor's. Its answer is values-free counts plus
  // first-party action identity; it carries no dialect and no snapshot claim (δ=(c),
  // and decision (ε) is unruled — see the executor module header).
  const observation = await executor.executeOrderingKeyProbe(resolution)
  if (!isPlainObject(observation)) {
    fail('PROBE_QUERY_FAILED', 'qualification probe returned no verifiable observation', {})
  }
  const duplicateGroups = normalizeProbeCount(observation.duplicateGroupsSampled)
  const nullRows = normalizeProbeCount(observation.nullKeyRowsSampled)
  if (duplicateGroups === null || nullRows === null) {
    fail('PROBE_QUERY_FAILED', 'qualification probe returned no verifiable observation', {})
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
    // FIRST-PARTY action identity only. Deliberately ABSENT: probeDialect,
    // snapshotSemantics, and every other guarantee token — §4 step 2 has not run,
    // so no such claim is establishable, and an HTTP action has none to make.
    probeTransport: requiredIdentityToken(observation.probeTransport, 'probeTransport'),
    probeActionId: requiredIdentityToken(observation.probeActionId, 'probeActionId'),
    probeActionVersion: requiredIdentityToken(observation.probeActionVersion, 'probeActionVersion'),
    probeConnectorKind: requiredIdentityToken(observation.probeConnectorKind, 'probeConnectorKind'),
    checkedKeyColumnCount: normalizeProbeCount(observation.checkedKeyColumnCount),
    duplicateGroupsFound: 0,
    nullKeyRowsFound: 0,
    probedAt: requiredUtcInstant(safeReadRunInput(input, 'probedAt'), 'probedAt'),
  })
  if (evidence.checkedKeyColumnCount === null) {
    fail('PROBE_QUERY_FAILED', 'qualification probe returned no verifiable observation', {})
  }
  const qualificationDigest = computeQualificationDigest({
    actionProfileVersion: resolution.actionProfileVersion,
    systemContentKey: resolution.systemContentKey,
    configContentKey: resolution.configContentKey,
    objectKey: resolution.objectKey,
    canonicalObjectVersion: resolution.canonicalObjectVersion,
    evidence,
  })
  // READ ONCE into a local, then test and use the LOCAL. Reading `input.expiresAt`
  // twice would fire an accessor twice and leave a differing-return channel open —
  // a getter could answer `undefined` to the presence test and a value to the use.
  const rawExpiresAt = safeReadRunInput(input, 'expiresAt')
  const expiresAt = rawExpiresAt !== undefined
    ? requiredUtcInstant(rawExpiresAt, 'expiresAt')
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
// §3.1 L371 — BOTH probe AND verify re-enter through the resolver; no cached
// caller-side tuple is honoured on either path. Until B1a-3 this function
// recomputed the digest from `expectedInputs`, a CALLER-SUPPLIED object — a live
// counter-construction to the ratified sentence. The parameter is gone; the expected
// tuple now comes from a trusted `resolution` and nothing else.
function verifyBindingQualification({ qualification, resolution, envelopeKey, now }) {
  if (!isPlainObject(qualification)) {
    fail('QUALIFICATION_NOT_OBJECT', 'qualification must be a plain object', {})
  }
  if (!isTrustedBindingResolution(resolution)) {
    fail('PROBE_RESOLUTION_UNTRUSTED', 'a resolution minted by the approved-binding resolver is required', {})
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
    actionProfileVersion: resolution.actionProfileVersion,
    systemContentKey: resolution.systemContentKey,
    configContentKey: resolution.configContentKey,
    objectKey: resolution.objectKey,
    canonicalObjectVersion: resolution.canonicalObjectVersion,
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
    // `fail` is deliberately ABSENT (B1a-3).
    //
    // ── RETRACTION FIRST (B1a-3 round 3, P1-A) ──────────────────────────────────
    // The earlier text here said that while `fail` was exported, any importer could
    // mint a GENUINELY BRANDED GipQualificationError carrying arbitrary caller
    // `message` and `details` — i.e. that removing `fail` CLOSED that channel.
    // THAT CLAIM IS WITHDRAWN. It was false when it was written. `GipQualificationError`
    // is itself EXPORTED, ten lines above, and it was ALREADY exported on `main`
    // before this PR — the class body and its export line are byte-identical to
    // `main` here. So `new GipQualificationError(<reason>, <attacker text>,
    // { leak: <attacker text> })` is reachable from the PUBLIC exports with no
    // `fail` at all. An importer never needed `fail` for this.
    //
    // WHAT REMOVING `fail` DOES BUY, stated exactly:
    //   * one fewer reachable path to error-minting, and
    //   * the INTERNAL path keeps its frozen-vocabulary validation — `fail()`
    //     refuses a reason outside QUALIFICATION_ERROR_REASONS with a coarse fixed
    //     token, which a direct `new GipQualificationError(...)` does NOT do.
    // WHAT IT DOES NOT BUY: closure of the branded-error text channel. That channel
    // is OPEN and this comment does not claim otherwise.
    //
    // THE RESIDUAL IS PINNED, NOT DROPPED. `brandedErrorChannelIsOpenOnTheSpikeClass()`
    // in `__tests__/gip-server-bound-source-executor.test.cjs` asserts the channel
    // EXISTS — that the attacker text IS carried in `.message` and `.details`.
    // Hardening the class is OUT OF SCOPE for this PR (byte-identical to `main`;
    // it belongs to the landed `bridge.bounded_read.v2` line and needs its own
    // gate). When a future PR does harden it, that test REDs and forces this ledger
    // entry to be updated rather than left stale. That is the point of asserting a
    // residual positively.
    //
    // The ABSENCE of `fail` itself is pinned by the exact-key-set test, so re-adding
    // it reds — that pin is unaffected by the retraction above.
    stableStringify,
    assertReadOnlySql,
    quoteIdentifier,
  },
}
