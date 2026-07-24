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
//
// ── B1a / R3.3 — RESOLUTION-BOUND ENTRY POINTS (still LATENT) ────────────────────
//
// WHY THIS EXISTS. Both ratified entry points take the qualification tuple as CALLER
// DATA: probe() reads actionProfileVersion/systemContentKey/configContentKey/objectKey/
// canonicalObjectVersion AND keyColumns out of run input, and
// verifyBindingQualification() recomputes the digest from a caller-assembled
// `expectedInputs`. A caller that assembles either by hand can MIX AND MATCH:
// "config A's contentKey with field set B", or "config A + system-or-profile B".
//
// WHY DETECTION IS IMPOSSIBLE, SO CONSTRUCTION-PREVENTION IS THE ONLY ANSWER.
// Probe evidence is VALUES-FREE by design: it carries `checkedKeyColumnCount` — a
// COUNT — and never the field names it checked. So a qualification probed over field
// set B while carrying config A's contentKey is BYTE-IDENTICAL to an honest one: same
// evidence shape, same digest arithmetic, same envelope MAC. Nothing in the
// qualification, in the digest, or in any audit record names the fields, so NO
// after-the-fact check — not a reviewer, not a log, not a replay — can tell the two
// apart. The forgery is therefore made INEXPRESSIBLE at construction time rather than
// detectable afterwards. Putting field NAMES into evidence to make it detectable was
// considered and REJECTED: it would break the values-free discipline and leak customer
// schema into digests and audit records.
//
// HOW. `probeFromResolution()` and `verifyBindingQualificationFromResolution()` take a
// RESOLUTION OBJECT produced by gip-approved-binding-resolver.cjs and authenticated by
// that module's WeakSet IDENTITY predicate (never a public brand — a brand is
// duck-typable). Every digest input, AND the probed field set, is read BY NAME off the
// resolution; the run-input key allowlist REFUSES any tuple field (and `expectedInputs`)
// supplied alongside it, counted and never echoed. No cached caller-side tuple is
// honoured: both paths re-enter through the resolver's object on every call.
//
// FIELD-SET DERIVATION — NAMED DECISION (reconciles with the resolver's R6 header).
// `keyColumns` is derived from `resolution.orderingKeySpec` fieldIds, IN ORDER. It must
// be: a caller-supplied field set is exactly the "config A + field set B" forgery, and
// it is undetectable (above). The resolver's header states that a `fieldId` is a
// CANONICAL CLEANSING-ZONE identity and is NOT a source column name — that stands: this
// module passes fieldIds through BY IDENTITY and deliberately does NOT translate them.
// B1a is LATENT (no runtime consumer, no SQL reaches a real source), and the
// target → source-column translation is the NAMED GATED FOLLOW-UP that B1b owns; when it
// lands it is inserted at THIS ONE derivation point (deriveProbeKeyColumns) and nowhere
// else. Note that the field set is bound to the config TRANSITIVELY regardless of
// translation: orderingKeySpec lives in the immutable approved body, so it is covered by
// contentKeyFor(body) ⇒ configContentKey ⇒ the digest.
//
// DEPENDENCY DIRECTION IS ONE-WAY: this module requires the resolver; the resolver must
// NEVER require this module (it would be a cycle, and the resolver is the lower layer —
// it derives what this module consumes).
//
// API CHOICE — ADDITIVE, NOT BREAKING. `verifyBindingQualification()` and `probe()` keep
// their ratified signatures and stay exported, so the ratified spike battery keeps
// proving what it proved. They REMAIN caller-supplied surfaces: nothing here stops a
// future consumer from calling them. Closure is enforced at the (gated) wiring point,
// which binds the runtime to the *FromResolution* entry points only.
//
// SCOPE OF THE INEXPRESSIBILITY CLAIM — MEASURED, NOT ASSUMED. TWO residuals, both pinned
// behaviourally in the spike battery so this paragraph cannot rot into a stale claim.
//
// RESIDUAL 1 — THE FIELD SET, on the ratified path. The forgery is inexpressible for callers
// restricted to the *FromResolution* pair. It is NOT inexpressible module-wide: the ratified
// probe() still takes `keyColumns` as run data, so a caller holding resolution A can mint a
// qualification carrying A's five digest fields while probing FIELD SET B, and
// verifyBindingQualificationFromResolution() then returns verified:true — because evidence is
// values-free, verify cannot see which fields were probed. Pinned by
// ratifiedPathRemainsAnOpenConstruction. A count check in verify would NOT close it: it would
// catch a different-SIZE field set and miss a same-size foreign one — a partial detector for a
// hole the wiring gate closes completely, and it would contradict the impossibility argument
// above.
//
// RESIDUAL 2 — THE SOURCE HANDLE, on the resolution-bound path itself. probeFromResolution()
// derives the tuple and the field set from the resolution, but `query` is still CALLER-
// SUPPLIED: the probe never learns WHICH system its rows came from, so evidence need not come
// from the bound system at all. The suite's own fixtures are the demonstration — every probe
// in this battery is answered by an in-test `async () => ({ rows: [...] })` that touches no
// system, and the resulting qualification verifies. That is not a fixture shortcut; it is the
// module boundary: B1a is LATENT and no SQL reaches a real source, so there is nothing here to
// bind a handle to. THE FIX IS NAMED AND DEFERRED, NOT DONE: the source handle must be derived
// from the resolution's OWN system record (the same record whose lossless config backs
// systemContentKey — see the resolver's D2.1), which requires the per-system connection wiring
// the gated wiring point owns. Until then a qualification proves "these six approved inputs +
// this evidence", NOT "this evidence was observed on the bound system". Pinned by
// callerSuppliedQueryRemainsAnOpenConstruction.
//
// A RESOLUTION IS AUTHENTICATED AND IMMUTABLE — NOT FRESH. Approval, tenant/workspace scope
// and system admission are re-verified by the resolver at RESOLVE time, not at probe/verify
// time. Nothing here bounds how long a caller may hold a resolution, so a config retired or
// a system deactivated after resolution is not observed by a held one; the qualification's
// `expiresAt` bounds the QUALIFICATION, not the resolution. Resolution freshness/TTL is a
// named follow-up for the wiring gate, not something this module can assert.

const crypto = require('node:crypto')
const { CanonicalDomainError, stableCanonicalStringify } = require('./gip-canonical-json.cjs')
// TRUST BY OBJECT IDENTITY, borrowed from the module that mints resolutions. This is a
// predicate over a module-private WeakSet — there is no public field to duck-type.
const { isTrustedBindingResolution } = require('./gip-approved-binding-resolver.cjs')

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
  // B1a / R3.3 — resolution-bound entry points (exact pin lives in the spike battery;
  // a change here MUST update that pin in the same edit, both directions).
  'QUALIFICATION_RESOLUTION_NOT_TRUSTED',
  'QUALIFICATION_RESOLUTION_INPUT_CONFLICT',
])
const QUALIFICATION_ERROR_REASON_SET = new Set(QUALIFICATION_ERROR_REASONS)

const QUALIFICATION_STATUSES = Object.freeze(['candidate', 'revoked'])

// EXACT run-input allowlists for the resolution-bound entry points. Everything else about
// a run is DERIVED from the resolution, so any other key is a caller trying to supply what
// the resolver owns — refused, not ignored, so a caller can never believe it was honoured.
// `expectedInputs` is deliberately absent from the verify list: it IS the surface R3 closes.
const RESOLUTION_PROBE_INPUT_KEYS = Object.freeze(['resolution', 'query', 'envelopeKey', 'probedAt', 'expiresAt'])
const RESOLUTION_VERIFY_INPUT_KEYS = Object.freeze(['resolution', 'qualification', 'envelopeKey', 'now'])

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

// ── B1b — KNOWN LIMITATION shared by ALL THREE builders (PG above, MySQL + SQL Server
// below): DERIVED-TABLE DUPLICATE OUTPUT COLUMN. The duplicate sub-probe projects the key
// columns AND a computed `duplicate_count`; the null sub-probe projects a literal
// `null_key_row`. If an ordering KEY COLUMN is itself named `duplicate_count` (or
// `null_key_row`), the derived table `gip_duplicate_probe` (resp. `gip_null_probe`) is
// asked for two output columns of the same name.
//   MEASURED (test battery, this environment): the built SQL string does contain the name
//   twice — that half is a fact about our own generator, not about any server.
//   REASONED — TO BE CONFIRMED BY SPIKE: MySQL rejects this at parse time (ER_DUP_FIELDNAME
//   / error 1060 "Duplicate column name") and T-SQL rejects it ("The column ... was
//   specified multiple times for 'gip_duplicate_probe'"), while PostgreSQL TOLERATES
//   duplicate output column names in a derived table as long as nothing references the
//   ambiguous name — and nothing here does, since the outer query only counts rows.
// Either way the failure mode is FAIL-CLOSED, not a wrong answer: the driver rejects the
// statement, runReadOnlyProbe's catch turns it into PROBE_QUERY_FAILED, and no
// qualification is minted. It is recorded here rather than "fixed" by renaming, because a
// rename would change the SQL shape (and thus what every pinned test asserts) to defend a
// key column named `duplicate_count`, which no canonical object in this line has.
//
// ── B1b — MySQL certified dialect strategy ──────────────────────────────────────────
// Identifier hygiene: backtick-quoted, per segment, embedded backticks doubled (mirrors
// quoteIdentifier's double-quote doubling above — MySQL's own escaping rule).
function quoteMysqlIdentifier(name) {
  const trimmed = requiredString(name, 'identifier')
  return `\`${trimmed.replace(/`/g, '``')}\``
}

function buildMysqlOrderingKeyDuplicateProbeSql({ objectName, keyColumns }) {
  const object = quoteMysqlIdentifier(objectName)
  const cols = normalizeKeyColumns(keyColumns).map((column) => quoteMysqlIdentifier(column)).join(', ')
  return `SELECT ${cols}, COUNT(*) AS duplicate_count FROM ${object} GROUP BY ${cols} HAVING COUNT(*) > 1 LIMIT 1`
}

function buildMysqlOrderingKeyNullProbeSql({ objectName, keyColumns }) {
  const object = quoteMysqlIdentifier(objectName)
  const predicate = normalizeKeyColumns(keyColumns)
    .map((column) => `${quoteMysqlIdentifier(column)} IS NULL`)
    .join(' OR ')
  return `SELECT 1 AS null_key_row FROM ${object} WHERE ${predicate} LIMIT 1`
}

// COUNT SHAPE (mirrors the PG ::int reasoning, MySQL syntax — NOT the PG cast, which is
// invalid here): MySQL's COUNT(*) is BIGINT server-side. TO BE CONFIRMED BY SPIKE: mysql2
// (the standard node driver), under its DEFAULT options, returns a BIGINT column as a JS
// `number` when the value is within the safe-integer range, and only surfaces it as a
// decimal STRING when `supportBigNumbers`+`bigNumberStrings` are both set. Because these
// sampled counts are 0/1 by construction (LIMIT-1 subqueries, same as PG), EITHER shape is
// already a safe non-negative decimal and normalizeProbeCount's acceptor (number OR
// canonical digit string) already covers both without a cast. We CAST to SIGNED anyway —
// for the same reason PG narrows to ::int: an explicit, driver-configuration-independent
// type, not because correctness here depends on it.
function buildMysqlOrderingKeyTotalOrderProbeSql({ objectName, keyColumns }) {
  const columns = normalizeKeyColumns(keyColumns)
  const dup = buildMysqlOrderingKeyDuplicateProbeSql({ objectName, keyColumns: columns })
  const nul = buildMysqlOrderingKeyNullProbeSql({ objectName, keyColumns: columns })
  return `SELECT CAST((SELECT COUNT(*) FROM (${dup}) AS gip_duplicate_probe) AS SIGNED) AS duplicate_groups_sampled, CAST((SELECT COUNT(*) FROM (${nul}) AS gip_null_probe) AS SIGNED) AS null_key_rows`
}

// Dialect strategy — MySQL/InnoDB (B1b). REASONED, NOT MEASURED — no real MySQL is
// reachable from this environment; every claim below is "to be confirmed by spike".
//
// A single autocommit SELECT against InnoDB tables DOES get one consistent read view for
// its own duration (InnoDB establishes the view at the start of the first — here, only —
// read of an implicit autocommit transaction), so the SAME "one statement, one observed
// state" property PG's MVCC gives unconditionally CAN hold here too. But unlike PG (whose
// MVCC is a property of every heap table, unconditionally), that guarantee is CONDITIONAL
// on THREE things this module cannot verify from a SQL string alone:
//   (a) the probed object is backed by InnoDB (or another MVCC-capable engine) — a
//       non-transactional engine (MyISAM, etc.) has no read view at all, and the
//       duplicate/null subqueries could then observe DIFFERENT states (a torn check);
//   (b) the connection is in autocommit / has no already-open transaction already holding
//       an older snapshot from a previous statement;
//   (c) the session's transaction ISOLATION LEVEL is READ COMMITTED or stricter. This
//       third condition is NOT redundant with (a)+(b) and its omission was a real defect
//       (review P2-4): under READ UNCOMMITTED, InnoDB does NOT establish a read view at
//       all — plain SELECTs become dirty, non-consistent reads — so a consumer that
//       verified only "InnoDB + autocommit" and trusted the token could still get exactly
//       the torn check the token promises it will not get. Under READ COMMITTED a
//       consistent read view is taken per statement, and under REPEATABLE READ (MySQL's
//       default) / SERIALIZABLE at first read of the transaction; in all three, ONE
//       autocommit statement observes ONE state, which is the property being claimed.
// The token names all three conditions, rather than reusing `single_statement_mvcc` for
// prestige — it is DELIBERATELY WEAKER than PG's. NOTE: this token is DIGEST-BEARING (it
// flows into probe evidence → qualificationDigest, per the module header) — rewording it
// later is a breaking change to every qualification minted under it, not a copy edit,
// which is why the missing third condition is corrected NOW rather than "documented".
const mysqlTotalOrderProbeStrategy = Object.freeze({
  strategyId: 'gip.total_order_probe.mysql',
  strategyVersion: 'v1',
  dialect: 'mysql',
  snapshotSemantics: 'single_statement_consistent_read_conditional_on_innodb_autocommit_and_isolation_read_committed_or_stricter',
  buildTotalOrderProbeSql: buildMysqlOrderingKeyTotalOrderProbeSql,
})

// ── B1b — SQL Server certified dialect strategy ─────────────────────────────────────
// Identifier hygiene: bracket-quoted, per segment, embedded `]` doubled (SQL Server's own
// escaping rule — the closing-bracket analogue of quoteIdentifier's `"` doubling above).
function quoteSqlServerIdentifier(name) {
  const trimmed = requiredString(name, 'identifier')
  return `[${trimmed.replace(/]/g, ']]')}]`
}

function buildSqlServerOrderingKeyDuplicateProbeSql({ objectName, keyColumns }) {
  const object = quoteSqlServerIdentifier(objectName)
  const cols = normalizeKeyColumns(keyColumns).map((column) => quoteSqlServerIdentifier(column)).join(', ')
  // SQL Server has NO LIMIT — TOP (n) is the dialect equivalent (brief: "no LIMIT, use TOP").
  return `SELECT TOP (1) ${cols}, COUNT(*) AS duplicate_count FROM ${object} GROUP BY ${cols} HAVING COUNT(*) > 1`
}

function buildSqlServerOrderingKeyNullProbeSql({ objectName, keyColumns }) {
  const object = quoteSqlServerIdentifier(objectName)
  const predicate = normalizeKeyColumns(keyColumns)
    .map((column) => `${quoteSqlServerIdentifier(column)} IS NULL`)
    .join(' OR ')
  return `SELECT TOP (1) 1 AS null_key_row FROM ${object} WHERE ${predicate}`
}

// COUNT SHAPE: T-SQL `COUNT(*)` returns `int` (NOT bigint) — that is SQL Server's own
// documented default (COUNT_BIG(*) is the bigint form). That is a LANGUAGE fact, statable
// flatly, not a driver behaviour — so unlike PG (whose int8-as-string quirk is a driver
// choice masking a wide server type) no cast/normalisation is needed to narrow the server
// type here; it is already narrow. TO BE CONFIRMED BY SPIKE: that the `mssql`/tedious
// driver surfaces a T-SQL `int` column as a plain JS number (its documented type mapping
// says so, but this has not been run against a real server from this environment).
function buildSqlServerOrderingKeyTotalOrderProbeSql({ objectName, keyColumns }) {
  const columns = normalizeKeyColumns(keyColumns)
  const dup = buildSqlServerOrderingKeyDuplicateProbeSql({ objectName, keyColumns: columns })
  const nul = buildSqlServerOrderingKeyNullProbeSql({ objectName, keyColumns: columns })
  return `SELECT (SELECT COUNT(*) FROM (${dup}) AS gip_duplicate_probe) AS duplicate_groups_sampled, (SELECT COUNT(*) FROM (${nul}) AS gip_null_probe) AS null_key_rows`
}

// Dialect strategy — SQL Server (B1b). REASONED, NOT MEASURED.
//
// SQL Server's DEFAULT isolation is READ COMMITTED WITHOUT row versioning (versioned reads
// only happen if the database has READ_COMMITTED_SNAPSHOT or SNAPSHOT isolation explicitly
// enabled — a database-level config this module cannot see or assume from a probe call).
// Under that default, a read takes and releases short-lived locks AS it scans; there is NO
// consistent read view established at statement start the way PG's MVCC or InnoDB's read
// view provide. So the two internal subqueries of this ONE statement are each individually
// "read committed" at the instant they scan, but are NOT guaranteed to observe the SAME
// point-in-time state as each other — a row committed BETWEEN the two internal scans could
// make the combined result a torn check under default settings. This is materially WEAKER
// than both PG's and MySQL/InnoDB's claims, and the token says so rather than inheriting
// `single_statement_mvcc`.
//
// THE TOKEN IS THE CERTIFICATION SIGNAL, not a disclaimer that argues against registering
// this strategy: it is DIGEST-BEARING (flows into probe evidence → qualificationDigest), so
// a qualification minted under it is PERMANENTLY distinguishable from a PG/MySQL one — a
// downstream consumer (the gated wiring point, not this latent module) can read the token
// and decide to refuse this dialect, or require the operator to enable RCSI/SNAPSHOT
// isolation before trusting it. That decision is explicitly NOT made here.
//
// The token describes a read that is at least READ COMMITTED. A probe carrying the
// T-SQL hints `WITH (NOLOCK)` / `READUNCOMMITTED` would perform DIRTY reads and make even
// that weak claim untrue, so the read-only guard below blocks those hints outright —
// without that, the honest token could sit on evidence from a read it does not describe.
const sqlServerTotalOrderProbeStrategy = Object.freeze({
  strategyId: 'gip.total_order_probe.sqlserver',
  strategyVersion: 'v1',
  dialect: 'sqlserver',
  snapshotSemantics: 'no_single_statement_snapshot_under_default_read_committed',
  buildTotalOrderProbeSql: buildSqlServerOrderingKeyTotalOrderProbeSql,
})

// TRUST is OBJECT IDENTITY, never a public field (review P1, round-6): a boolean
// brand `__gipTrustedRegistry: true` is trivially duck-typed — a plain object carrying
// that field + a resolve() passed the prober factory and minted candidates with an
// attacker-controlled snapshotSemantics marker written into evidence. Membership in
// this module-private WeakSet is UNFORGEABLE: the ONLY way in is to be constructed by
// createProbeStrategyRegistry below. No public property is ever consulted.
const trustedProbeStrategyRegistries = new WeakSet()

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
  const registry = Object.freeze({
    resolve(actionProfileVersion) {
      return byProfile.get(actionProfileVersion) || null
    },
  })
  // Authenticate by IDENTITY, not by a forgeable public marker (review P1, round-6).
  trustedProbeStrategyRegistries.add(registry)
  return registry
}

// SERVICE FACTORY (review P1): binds a TRUSTED registry once, server-side, and returns
// a prober whose probe() takes RUN DATA ONLY. A caller can never inject a fake
// duck-typed registry into the qualification chain — the registry is captured here,
// not per call, and must be an object this module ACTUALLY constructed. Trust is
// WeakSet MEMBERSHIP (round-6): a duck-typed object — even one carrying
// __gipTrustedRegistry:true and a working resolve() — is not in the private WeakSet
// and is rejected.
function createBindingQualificationProber(strategyRegistry) {
  if (!trustedProbeStrategyRegistries.has(strategyRegistry)) {
    // WeakSet.has(primitive) returns false (never throws) — null/strings fail here too.
    fail('QUALIFICATION_INPUT_INVALID', 'a trusted probe-strategy registry (from createProbeStrategyRegistry) is required', { field: 'strategyRegistry' })
  }
  return Object.freeze({
    // RATIFIED signature — run data carries the tuple. Kept working on purpose (additive
    // API choice, see the header): the ratified battery proves what it proves.
    probe(input) {
      return probeWithTrustedRegistry(strategyRegistry, input)
    },
    // B1a / R3.3 — the tuple AND the probed field set come from an authenticated
    // resolution; run data carries only the source handle, the envelope key and time.
    probeFromResolution(input) {
      return probeFromResolutionWithTrustedRegistry(strategyRegistry, input)
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

// ── B1b — dialect-aware hardening ────────────────────────────────────────────────────
// EMPIRICALLY CONFIRMED (B1B brief, then re-run here): the guard below was PG-flavoured
// and did not cover MySQL's or SQL Server's equivalents of "this SELECT takes server state
// or executes arbitrary code" — WAITFOR, EXEC xp_cmdshell, OPENROWSET, GET_LOCK, BENCHMARK,
// SLEEP and LOAD_FILE all passed unmodified as syntactically-legal expressions inside a
// single SELECT, while the existing generic INTO token already caught MySQL's INTO OUTFILE/
// DUMPFILE and SQL Server's SELECT...INTO, and the legitimate PG probe kept passing.
//
// FRAMING (honest, not a live vulnerability): this guard is documented DEFENSE-IN-DEPTH on
// the probe's ONLY execution path — today the SQL it guards comes only from
// server-registered strategy builders (never user input), so none of these gaps was
// exploitable. They become materially relevant the moment a non-PG strategy is REGISTERED,
// which is exactly what this slice does (mysqlTotalOrderProbeStrategy /
// sqlServerTotalOrderProbeStrategy above).
//
// ── COVERAGE, PER CLASS × PER DIALECT (stated exactly) ──
// RETRACTION FIRST, so a grep that stops at this line gets the right answer: an earlier
// draft of this comment asserted that the state-taking-lock class was covered for
// postgres/mysql/sqlserver. THAT ASSERTION WAS FALSE and has been withdrawn — SQL Server's
// lock class had NO coverage at all (see LOCK-TAKING below). The table that follows is the
// corrected statement, and it is what the test battery pins.
//
//   ARBITRARY CODE / REMOTE EXECUTION
//     SQL Server  EXEC / EXECUTE, the xp_ / sp_ / fn_ routine-name families (xp_cmdshell,
//                 sp_configure, fn_get_audit_file), OPENROWSET / OPENQUERY /
//                 OPENDATASOURCE (ad-hoc remote and linked-server execution).
//     MySQL, PG   NOT CLAIMED COMPLETE (round-2 re-verification NEW-3). An earlier draft said
//                 "no additional members"; that was measured FALSE — PG `dblink` / `dblink_exec` /
//                 `query_to_xml` execute SQL text and open network egress from the server, and all
//                 three still pass every door. They are OUT OF SCOPE for this slice (extension-
//                 provided, and the probe SQL is builder-minted), not covered.
//
//   UNBOUNDED SERVER-SIDE WORK (timing / DoS primitive)
//     MySQL       SLEEP, BENCHMARK. NOT COMPLETE: MASTER_POS_WAIT / SOURCE_POS_WAIT /
//                 WAIT_FOR_EXECUTED_GTID_SET / WAIT_UNTIL_SQL_THREAD_AFTER_GTIDS are genuine
//                 unbounded waits and still pass (round-2 NEW-3).
//     SQL Server  WAITFOR.
//     PG          pg_sleep AND its longer siblings pg_sleep_for / pg_sleep_until.
//
//   SCOPE OF THE MULTI-WORD TOKENS (round-2 NEW-2, stated so it is not over-read): phrase tokens
//   such as `LOCK IN SHARE MODE` are closed against WHITESPACE, TAB, NEWLINE and CASE spellings —
//   measured — but NOT against intra-phrase comments (`LOCK/**/IN/**/SHARE/**/MODE` trips no door;
//   the ratified `FOR/**/SHARE` escapes the same way). No builder emits comments, and this guard
//   only ever sees builder-minted SQL, so this is a bound on the CLAIM, not a reachable hole.
//
//   ARBITRARY SERVER-SIDE FILE ACCESS
//     MySQL       LOAD_FILE (INTO OUTFILE / INTO DUMPFILE are the ratified INTO token).
//     PG          pg_read_file, pg_read_binary_file, pg_stat_file, pg_ls_* (pg_ls_dir,
//                 pg_ls_logdir), and the whole lo_ large-object family (lo_import,
//                 lo_export, lo_get, …) — the family, not three hand-picked members.
//     SQL Server  the fn_ family above (fn_get_audit_file, ::fn_trace_gettable).
//
//   STATE-TAKING LOCKS — the class that was WRONG before this fix
//     PG          `FOR UPDATE/SHARE/NO KEY UPDATE/KEY SHARE` (ratified clause token) plus
//                 pg_advisory_lock / pg_advisory_xact_lock / pg_try_advisory_lock
//                 (ratified) AND their `_shared` variants, which the ratified `\b`-
//                 terminated tokens did NOT reach (a PRE-EXISTING gap, not introduced by
//                 this slice; closed here because it is the same regex being touched).
//     MySQL       the same `FOR UPDATE` / `FOR SHARE` clause (8.0+) — covered by the
//                 ratified clause token — PLUS the pre-8.0 spelling `LOCK IN SHARE MODE`,
//                 which is still supported and still takes shared row locks (REASONED, to
//                 be confirmed by spike), and the GET_LOCK / RELEASE_LOCK /
//                 RELEASE_ALL_LOCKS named-lock family.
//     SQL Server  T-SQL HAS NO `FOR UPDATE` / `FOR SHARE` SYNTAX AT ALL (language fact),
//                 so the ratified clause token matched NOTHING a T-SQL client can write:
//                 before this fix this dialect's lock class had ZERO coverage. T-SQL takes
//                 locks with TABLE HINTS, so those are the tokens: UPDLOCK, XLOCK, TABLOCK,
//                 TABLOCKX, PAGLOCK, ROWLOCK, HOLDLOCK, SERIALIZABLE, REPEATABLEREAD,
//                 READCOMMITTEDLOCK, READPAST. The same token also blocks the OPPOSITE
//                 hazard — NOLOCK / READUNCOMMITTED (and READCOMMITTED), the hints that
//                 DESTROY the read rather than lock it: a probe carrying WITH (NOLOCK)
//                 performs dirty reads and would make the `sqlserver` strategy's snapshot
//                 token describe a read that did not happen.
//     NOT claimed IS_FREE_LOCK / IS_USED_LOCK (read-only lock INSPECTION, not state-taking)
//                 are deliberately NOT blocked and are NOT claimed as covered.
//
//   NOT A TOKEN, EXCLUDED STRUCTURALLY: `LOAD DATA` is a standalone STATEMENT, not an
//   expression, so the `^SELECT\b` anchor already excludes it — a different branch of this
//   function, proven separately.
//
// ── OVERBREADTH, ENUMERATED MECHANICALLY (not "e.g.") ──
// These patterns run on EVERY dialect, not only the one that owns the spelling, and they
// are textual: they cannot tell a keyword from an identifier. Therefore, exactly:
//   (1) every BARE token below rejects any SQL containing that word standing alone —
//       including a column or object named exactly `exec`, `execute`, `waitfor`, `sleep`,
//       `benchmark`, `openrowset`, `openquery`, `opendatasource`, `nolock`, `holdlock`,
//       `serializable`, `repeatableread`, `readpast`, `readcommitted`, `readuncommitted`,
//       `readcommittedlock`, `tablock`, `tablockx`, `updlock`, `xlock`, `rowlock`,
//       `paglock`;
//   (2) every PREFIX FAMILY rejects any identifier STARTING with it, in any dialect:
//       `xp_`, `sp_`, `fn_`, `lo_`, `pg_sleep*`, `pg_read_file*`, `pg_read_binary_file*`,
//       `pg_stat_file*`, `pg_ls_*`, `pg_advisory*`, `pg_try_advisory*`, `get_lock*`,
//       `release_lock*`, `release_all_locks*`, `load_file*`. So an object named
//       `sp_parts`, `fn_report`, `xp_report` or `lo_batch` fails a probe on PG and MySQL
//       too. `lo_` and `fn_` are only two letters wide and are the widest of these — that
//       is a deliberate blanket family choice, matching how `xp_`/`sp_` were already
//       handled, NOT an oversight.
//   (3) the keyword tokens are deliberately NOT prefix-extended (unlike the routine
//       families): extending `EXEC` would reject an ordinary column named
//       `execution_date`, and no dangerous callable is spelled `EXEC<something>`.
// This is an accepted false-CLOSED trade-off for a defense-in-depth layer that is not the
// primary safety mechanism (the builders above are safe by construction; a rare identifier
// collision fails a probe, not a customer). The named cases are PINNED in the test battery
// so a future "precision fix" of the overbreadth cannot silently reopen the hole.
//
// NO RATIFIED TOKEN IS TOUCHED OR WEAKENED: the two ratified patterns are extracted below
// VERBATIM — same tokens, same order, same flags — and their `.source` is pinned
// character-for-character by the test battery. Extraction exists so the new patterns can be
// proven DISJOINT from them: without that, a mutation of a new pattern could be silently
// caught by a ratified one and would prove nothing (fail-closed doors covering for each
// other).
const RATIFIED_WRITE_TOKEN_PATTERN = /\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COPY|INTO|SETVAL|NEXTVAL|PG_ADVISORY_LOCK|PG_ADVISORY_XACT_LOCK|PG_TRY_ADVISORY_LOCK)\b/i
const RATIFIED_ROW_LOCK_CLAUSE_PATTERN = /\bFOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b/i
// Keyword class — exact word, deliberately NOT prefix-extended (see overbreadth note (3)).
const DIALECT_UNSAFE_TOKEN_PATTERN = /\b(SLEEP|BENCHMARK|WAITFOR|EXECUTE|EXEC|OPENROWSET|OPENQUERY|OPENDATASOURCE)\b/i
// Routine families — PREFIX-matched with `[A-Za-z0-9_]*` so a LONGER identifier sharing the
// prefix cannot escape (pg_sleep_for, pg_sleep_until, lo_get, pg_advisory_lock_shared…).
// RELEASE_ALL_LOCKS is listed explicitly: prefix-extending RELEASE_LOCK does not reach it.
const DIALECT_UNSAFE_ROUTINE_PREFIX_PATTERN = /\b(GET_LOCK|RELEASE_ALL_LOCKS|RELEASE_LOCK|LOAD_FILE|PG_SLEEP|PG_READ_FILE|PG_READ_BINARY_FILE|PG_STAT_FILE|PG_LS_|PG_ADVISORY|PG_TRY_ADVISORY|LO_)[A-Za-z0-9_]*\b/i
// SQL Server routine-name prefix families: xp_ (extended), sp_ (system), fn_ (system
// table-valued functions — fn_get_audit_file, fn_trace_gettable; neither xp_ nor sp_).
const MSSQL_PROCEDURE_PREFIX_PATTERN = /\b(XP|SP|FN)_[A-Za-z0-9_]*\b/i
// Lock-taking / read-weakening spellings that are NOT `FOR UPDATE|SHARE`: MySQL's pre-8.0
// clause, and the T-SQL table-hint vocabulary (T-SQL has no FOR UPDATE at all).
const DIALECT_LOCK_TAKING_PATTERN = /\b(LOCK\s+IN\s+SHARE\s+MODE|UPDLOCK|XLOCK|TABLOCKX|TABLOCK|PAGLOCK|ROWLOCK|HOLDLOCK|SERIALIZABLE|REPEATABLEREAD|READCOMMITTEDLOCK|READCOMMITTED|READUNCOMMITTED|READPAST|NOLOCK)\b/i

// The probe refuses to execute anything but a single SELECT — read-only is a
// runtime guard here, not a comment.
function assertReadOnlySql(sql) {
  const text = String(sql).trim()
  // Write-free, not merely "starts with SELECT": SELECT ... INTO creates a table,
  // setval/nextval mutate sequences, advisory locks take server state, FOR UPDATE/
  // SHARE takes row locks (review findings). The builder is safe by construction —
  // this guard is defense-in-depth and is wired on the probe's ONLY execution path.
  if (!/^SELECT\b/i.test(text) || /;/.test(text)
    || RATIFIED_WRITE_TOKEN_PATTERN.test(text)
    || RATIFIED_ROW_LOCK_CLAUSE_PATTERN.test(text)
    || DIALECT_UNSAFE_TOKEN_PATTERN.test(text)
    || DIALECT_UNSAFE_ROUTINE_PREFIX_PATTERN.test(text)
    || MSSQL_PROCEDURE_PREFIX_PATTERN.test(text)
    || DIALECT_LOCK_TAKING_PATTERN.test(text)) {
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
  // OWN the bytes — LOAD-BEARING (review P2 round-5, corrected round-6): the probe path
  // has an `await runReadOnlyProbe(...)` window BETWEEN this copy and computeEnvelopeMac.
  // Without the copy, a caller mutating its own Buffer inside the query callback (during
  // that await) would change the bytes the MAC is computed under — the async-window test
  // REDs on removal. This is a correctness fix, not belt-and-braces.
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

// ── B1a / R3.3 — derivation from an AUTHENTICATED resolution ────────────────────────
// ONE PARAMETER, and it is the resolution. An override is INEXPRESSIBLE here, not merely
// rejected: there is no argument a caller value could arrive through, and every field is
// read BY NAME (never a spread), so an extra property on a resolution can never reach the
// digest either. This is the single choke point both resolution-bound entry points use.
function deriveQualificationInputsFromResolution(resolution) {
  // IDENTITY, not a property: the ONLY way in is to have been minted by the approved-
  // binding resolver. A structurally perfect, deep-frozen hand-built clone is refused.
  if (!isTrustedBindingResolution(resolution)) {
    fail('QUALIFICATION_RESOLUTION_NOT_TRUSTED', 'a binding resolution produced by the approved-binding resolver is required', {})
  }
  return {
    actionProfileVersion: resolution.actionProfileVersion,
    systemContentKey: resolution.systemContentKey,
    configContentKey: resolution.configContentKey,
    objectKey: resolution.objectKey,
    canonicalObjectVersion: resolution.canonicalObjectVersion,
    keyColumns: deriveProbeKeyColumns(resolution.orderingKeySpec),
  }
}

// THE ONE PLACE the probed field set is decided (header: FIELD-SET DERIVATION). fieldIds
// are passed through BY IDENTITY and deliberately NOT translated to source columns; the
// gated target → source translation lands HERE and nowhere else. Order is preserved — an
// ordering key is a sequence. Shape is not re-litigated: normalizeKeyColumns is the
// fail-closed gate (an empty or malformed spec lands there as QUALIFICATION_INPUT_INVALID).
function deriveProbeKeyColumns(orderingKeySpec) {
  const columns = []
  const length = Array.isArray(orderingKeySpec) ? orderingKeySpec.length : 0
  for (let index = 0; index < length; index += 1) {
    columns.push(orderingKeySpec[index] && orderingKeySpec[index].fieldId)
  }
  return columns
}

// EXACT key allowlist. The offending key name is attacker-chosen text and is NEVER echoed —
// a COUNT is the observable substitute (values-free discipline).
function assertResolutionInputKeys(input, allowedKeys) {
  const keys = Object.keys(input)
  let rejectedKeyCount = 0
  for (let index = 0; index < keys.length; index += 1) {
    if (!allowedKeys.includes(keys[index])) rejectedKeyCount += 1
  }
  if (rejectedKeyCount > 0) {
    fail('QUALIFICATION_RESOLUTION_INPUT_CONFLICT', 'run input supplies keys the resolution owns (they are derived, never supplied)', {
      rejectedKeyCount,
    })
  }
}

// probeFromResolution — the resolution-bound probe path. Same probe, same read-only guard,
// same single statement; what changes is WHERE the tuple and the field set come from.
async function probeFromResolutionWithTrustedRegistry(trustedRegistry, input) {
  if (!isPlainObject(input)) {
    fail('QUALIFICATION_INPUT_INVALID', 'resolution-bound probe needs a plain-object input', {})
  }
  // AUTHENTICATE provenance first, then police the request shape.
  const derived = deriveQualificationInputsFromResolution(input.resolution)
  assertResolutionInputKeys(input, RESOLUTION_PROBE_INPUT_KEYS)
  // Run data is assembled by NAMED READS into an object THIS module owns, at parse time —
  // load-bearing twice over: (a) a tuple field is inexpressible in it, and (b) the tuple
  // fields are read AFTER the source round-trip inside probeWithTrustedRegistry, so a
  // caller mutating its own input object during that window must not be able to reach them.
  const runData = {
    query: input.query,
    envelopeKey: input.envelopeKey,
    probedAt: input.probedAt,
  }
  if (input.expiresAt !== undefined) runData.expiresAt = input.expiresAt
  // RESOLUTION LAST — deliberate: even if a future refactor let a tuple field through the
  // allowlist, the resolution's value would still be the one that wins.
  return probeWithTrustedRegistry(trustedRegistry, { ...runData, ...derived })
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

// verifyBindingQualificationFromResolution — B1a / R3.3. The function above with its
// caller-supplied `expectedInputs` surface REMOVED: the five digest inputs are read BY NAME
// off an AUTHENTICATED resolution, on every call, so no cached caller-side tuple is ever
// honoured. `expectedInputs` is REFUSED rather than ignored — a caller must never be able to
// believe it was honoured. It DELEGATES to the ratified function, so there is exactly ONE
// digest/envelope implementation and the two paths cannot drift. Stays as pure-local and as
// transaction-safe as its delegate: it adds no external I/O of any kind.
function verifyBindingQualificationFromResolution(input) {
  if (!isPlainObject(input)) {
    fail('QUALIFICATION_NOT_OBJECT', 'resolution-bound verification needs a plain-object input', {})
  }
  const derived = deriveQualificationInputsFromResolution(input.resolution)
  assertResolutionInputKeys(input, RESOLUTION_VERIFY_INPUT_KEYS)
  return verifyBindingQualification({
    qualification: input.qualification,
    expectedInputs: {
      actionProfileVersion: derived.actionProfileVersion,
      systemContentKey: derived.systemContentKey,
      configContentKey: derived.configContentKey,
      objectKey: derived.objectKey,
      canonicalObjectVersion: derived.canonicalObjectVersion,
    },
    envelopeKey: input.envelopeKey,
    now: input.now,
  })
}

module.exports = {
  QUALIFICATION_ERROR_REASONS,
  QUALIFICATION_STATUSES,
  RESOLUTION_PROBE_INPUT_KEYS,
  RESOLUTION_VERIFY_INPUT_KEYS,
  GipQualificationError,
  computeQualificationDigest,
  computeEnvelopeMac,
  buildOrderingKeyDuplicateProbeSql,
  buildOrderingKeyNullProbeSql,
  buildOrderingKeyTotalOrderProbeSql,
  postgresTotalOrderProbeStrategy,
  // B1b — certified dialect strategies (MySQL / SQL Server), mirroring the PG reference.
  buildMysqlOrderingKeyDuplicateProbeSql,
  buildMysqlOrderingKeyNullProbeSql,
  buildMysqlOrderingKeyTotalOrderProbeSql,
  mysqlTotalOrderProbeStrategy,
  buildSqlServerOrderingKeyDuplicateProbeSql,
  buildSqlServerOrderingKeyNullProbeSql,
  buildSqlServerOrderingKeyTotalOrderProbeSql,
  sqlServerTotalOrderProbeStrategy,
  createProbeStrategyRegistry,
  createBindingQualificationProber,
  verifyBindingQualification,
  verifyBindingQualificationFromResolution,
  __internals: {
    fail,
    stableStringify,
    assertReadOnlySql,
    quoteIdentifier,
    quoteMysqlIdentifier,
    quoteSqlServerIdentifier,
    // B1b — the guard's patterns, exposed so the battery can prove (a) the ratified two are
    // byte-identical to their pin and (b) each discriminating probe is caught by EXACTLY
    // ONE pattern, so no mutation can hide behind a neighbouring door.
    readOnlyGuardPatterns: Object.freeze({
      ratifiedWriteTokens: RATIFIED_WRITE_TOKEN_PATTERN,
      ratifiedRowLockClause: RATIFIED_ROW_LOCK_CLAUSE_PATTERN,
      dialectKeyword: DIALECT_UNSAFE_TOKEN_PATTERN,
      dialectRoutinePrefix: DIALECT_UNSAFE_ROUTINE_PREFIX_PATTERN,
      mssqlProcedurePrefix: MSSQL_PROCEDURE_PREFIX_PATTERN,
      dialectLockTaking: DIALECT_LOCK_TAKING_PATTERN,
    }),
    deriveQualificationInputsFromResolution,
    deriveProbeKeyColumns,
  },
}
