'use strict'

// 备料 BATCH IDENTITY — "物料创建日期(精确到小时)区分同一项目不同批次的物料".
//
// ── WHAT SHIPPED BEFORE THIS MODULE ────────────────────────────────────────────────────────────
//
// The owner's rule is that a project's pulls are separated into batches by the CREATION HOUR of the
// materials they carry. Shipped code did not implement it. Two things stood in for it:
//
//   1. the MINT at the table-action MVP-persist route, which keys the batch id on the expansion's
//      CONTENT revision — `snapshot_<sha256(tenant\nactionId\nprojectNo\nrevision)[0:32]>`; and
//   2. a persist-time MONOTONIC COUNTER, the numeric `snapshotVersion` column allocated under a lock
//      as max(project's versions)+1 (stock-preparation-sync-run-persist.cjs), which is what actually
//      orders the diff chain (stock-preparation-snapshot-reads.cjs `pickPredecessor`).
//
// The hour rule existed ONLY in the rehearsal/demo drivers, as a caller-side derivation the shipped
// mapper could not see (docs/development/takeover-beiliao-20260821/structure-exact-rehearsal-report-
// 20260901.md gap #3; onsite-connection-test-runbook-20260901.md §3 step 2).
//
// ── WHAT THIS MODULE IS ────────────────────────────────────────────────────────────────────────
//
// The rehearsal's PROVEN pure derivation, promoted to shipped code so there is exactly ONE
// implementation. `hourBucket` is the rehearsal driver's own function (the first 13 characters of an
// ISO-ish creation timestamp ARE the hour bucket) and `mintStockPreparationBatchIdentity` is its
// `batchIdFromMaterials` — "as-of the NEWEST material hour" — with the fixture-specific row lookup
// replaced by a read of the expansion row's own `createTime`. The rehearsal test now requires this
// module instead of carrying its own copy, so the two cannot drift.
//
// PURE and DETERMINISTIC: no clock, no I/O, no route, no source or target read. It is handed rows
// that are already in memory and returns a string plus a values-free verdict.
//
// ── WHY THE HOUR RULE IS OPT-IN AND NOT THE DEFAULT ────────────────────────────────────────────
//
// The batch id is not a label. It is:
//   * the PERSIST IDEMPOTENCY KEY — an existing row under the same id makes the pull a replay, and
//     a replay whose immutable projections differ is refused (sync-run-persist.cjs, repair-once),
//   * the Postgres advisory-lock key (stock-preparation-persist-unit-of-work.ts), and
//   * a hash INPUT for every derived child id: snapshotLineId, stockPrepLineId, exceptionId, runId
//     are all `…${stableHash(`${snapshotBatchId}|${seed}`)}`.
//
// So switching the default would change, for every existing deployment, WHICH pulls count as the
// same batch. Concretely: under the content-revision default a BOM correction always mints a new
// batch and is accepted; under the hour rule a correction that does not move any material's
// creation hour lands on the SAME id with different content and is refused as an idempotency
// conflict. That refusal is CORRECT under the owner's semantics — one hour cannot be two different
// batches — but it is a behaviour change a running install must opt into, not inherit silently.
//
// It does NOT re-key or orphan anything already persisted: existing batches keep their ids, and the
// diff chain is ordered by the numeric `snapshotVersion`, not by the id, so a deployment that turns
// the rule on simply continues the chain with differently-shaped ids.
//
// Declared per deployment on the read plan:  readPlan.batchIdentity = { mode: 'material_create_hour' }
// Absent  => 'source_revision', today's behaviour, byte for byte.
// Unknown => a coded throw. A typo must never silently mean "legacy".
//
// ── DEGRADATION IS DECLARED, NEVER SILENT ──────────────────────────────────────────────────────
//
// A deployment can ask for the hour rule and the source can still not support it — no declared
// createTime column, or no row carrying a parseable one. The rule then FALLS BACK to the legacy
// content-revision id and says so: `degraded: true` with a coded `reason`, surfaced in the route's
// evidence. Never a wrong bucket, never a crash, never a silently different batching rule.

const { isPlainObject, optionalString } = require('./stock-preparation-common.cjs')

const BATCH_IDENTITY_MODES = Object.freeze({
  // Today's shipped behaviour: the caller's content-revision digest.
  SOURCE_REVISION: 'source_revision',
  // The owner's rule: `<project>|<YYYY-MM-DDTHH>` of the newest material creation hour.
  MATERIAL_CREATE_HOUR: 'material_create_hour',
})

const BATCH_IDENTITY_MODE_VALUES = Object.freeze(Object.values(BATCH_IDENTITY_MODES))

const DEGRADATION_REASONS = Object.freeze({
  NONE: 'none',
  // No expansion row carried a parseable createTime — the deployment declared no
  // readPlan.part.createTimeField, or the column is empty/unparseable on every row.
  SOURCE_CREATE_TIME_ABSENT: 'source_create_time_absent',
  PROJECT_NO_ABSENT: 'project_no_absent',
  // The project number contains the `|` this scheme uses as its own separator. See INJECTIVITY.
  PROJECT_NO_NOT_SEPARATOR_SAFE: 'project_no_not_separator_safe',
})

// INJECTIVITY. Derived child ids hash `${snapshotBatchId}|${seed}`. An hour-bucket batch id
// contributes exactly one `|`, at a position fixed by a 13-character hour bucket of pinned shape, so
// `<project>|<hour>|<seed>` cannot be re-read as some other (batchId, seed) split — PROVIDED the
// project component carries no `|` of its own. A project number that does is refused into the legacy
// id rather than allowed to make two different batches hash alike.
const BATCH_ID_SEPARATOR = '|'
const HOUR_BUCKET_LENGTH = 13
const HOUR_BUCKET_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}$/

class StockPreparationBatchIdentityError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'StockPreparationBatchIdentityError'
    this.details = details
  }
}

/**
 * The rehearsal driver's proven derivation: the first 13 characters of an ISO-ish creation
 * timestamp ARE the hour bucket ('2026-08-30T09:15:00' -> '2026-08-30T09').
 *
 * Two deliberate strengthenings over the driver's bare `String(x).slice(0, 13)`:
 *   * a SQL-Server-shaped 'YYYY-MM-DD HH:mm:ss' (space separator, the common varchar form on this
 *     vendor family) is normalized to the same bucket rather than read as a different one, and
 *   * the result must MATCH the bucket shape. Anything else returns null, which the caller turns
 *     into a declared degradation. A source string that is not a timestamp must never be sliced
 *     into a plausible-looking wrong bucket.
 *
 * @returns {string|null} 'YYYY-MM-DDTHH', or null when the input cannot be read as one.
 */
function hourBucket(createTime) {
  const raw = optionalString(createTime)
  if (raw === null) return null
  const bucket = raw.slice(0, HOUR_BUCKET_LENGTH).replace(' ', 'T')
  return HOUR_BUCKET_PATTERN.test(bucket) ? bucket : null
}

/**
 * The deployment's declared batch-identity mode, read off the read plan.
 * Absent => the legacy content-revision mode. Unknown => coded throw (never a silent legacy).
 */
function readStockPreparationBatchIdentityMode(readPlan) {
  const identity = isPlainObject(readPlan) && isPlainObject(readPlan.batchIdentity)
    ? readPlan.batchIdentity
    : null
  const mode = identity ? optionalString(identity.mode) : null
  if (mode === null) return BATCH_IDENTITY_MODES.SOURCE_REVISION
  if (!BATCH_IDENTITY_MODE_VALUES.includes(mode)) {
    throw new StockPreparationBatchIdentityError(
      `readPlan.batchIdentity.mode must be one of ${BATCH_IDENTITY_MODE_VALUES.join(', ')}`,
      { field: 'readPlan.batchIdentity.mode' },
    )
  }
  return mode
}

function extractRows(rows) {
  if (Array.isArray(rows)) return rows
  if (isPlainObject(rows) && Array.isArray(rows.rows)) return rows.rows
  return []
}

/**
 * Mint the batch identity for one pull.
 *
 * @param {string}   opts.mode          BATCH_IDENTITY_MODES value (see readStockPreparationBatchIdentityMode).
 * @param {string}   opts.projectNo     the source project number — the batch's business scope.
 * @param {Array}    opts.rows          expansion rows (or an expansion result carrying `rows`).
 * @param {string}   opts.legacyBatchId the caller's content-revision id — the mandatory fallback.
 * @returns {{batchId,mode,requestedMode,degraded,reason,evidence}} evidence is VALUES-FREE: counts
 *          and a coded reason only, no timestamp text and no business values.
 */
function mintStockPreparationBatchIdentity(opts = {}) {
  const options = isPlainObject(opts) ? opts : {}
  const legacyBatchId = optionalString(options.legacyBatchId)
  if (legacyBatchId === null) {
    // The fallback is what makes degradation safe, so it is never optional.
    throw new StockPreparationBatchIdentityError('opts.legacyBatchId is required', { field: 'opts.legacyBatchId' })
  }
  const requestedMode = optionalString(options.mode) || BATCH_IDENTITY_MODES.SOURCE_REVISION
  if (!BATCH_IDENTITY_MODE_VALUES.includes(requestedMode)) {
    throw new StockPreparationBatchIdentityError(
      `opts.mode must be one of ${BATCH_IDENTITY_MODE_VALUES.join(', ')}`,
      { field: 'opts.mode' },
    )
  }

  const rows = extractRows(options.rows)
  const buckets = []
  for (const row of rows) {
    if (!isPlainObject(row)) continue
    const bucket = hourBucket(row.createTime)
    if (bucket !== null) buckets.push(bucket)
  }
  const evidenceBase = {
    requestedMode,
    rows: rows.length,
    rowsWithCreateTimeHour: buckets.length,
    distinctCreateTimeHours: new Set(buckets).size,
    valuesFree: true,
  }

  const legacy = (reason) => ({
    batchId: legacyBatchId,
    mode: BATCH_IDENTITY_MODES.SOURCE_REVISION,
    requestedMode,
    degraded: requestedMode !== BATCH_IDENTITY_MODES.SOURCE_REVISION,
    reason,
    evidence: { ...evidenceBase, mode: BATCH_IDENTITY_MODES.SOURCE_REVISION, reason },
  })

  if (requestedMode === BATCH_IDENTITY_MODES.SOURCE_REVISION) return legacy(DEGRADATION_REASONS.NONE)

  const projectNo = optionalString(options.projectNo)
  if (projectNo === null) return legacy(DEGRADATION_REASONS.PROJECT_NO_ABSENT)
  if (projectNo.includes(BATCH_ID_SEPARATOR)) return legacy(DEGRADATION_REASONS.PROJECT_NO_NOT_SEPARATOR_SAFE)
  if (buckets.length === 0) return legacy(DEGRADATION_REASONS.SOURCE_CREATE_TIME_ABSENT)

  // "as-of the newest material hour" — the rehearsal's rule. Buckets are fixed-width and
  // zero-padded, so lexical max IS chronological max; no Date parsing, no timezone, no clock.
  const newestHour = buckets.slice().sort()[buckets.length - 1]
  return {
    batchId: `${projectNo}${BATCH_ID_SEPARATOR}${newestHour}`,
    mode: BATCH_IDENTITY_MODES.MATERIAL_CREATE_HOUR,
    requestedMode,
    degraded: false,
    reason: DEGRADATION_REASONS.NONE,
    evidence: {
      ...evidenceBase,
      mode: BATCH_IDENTITY_MODES.MATERIAL_CREATE_HOUR,
      reason: DEGRADATION_REASONS.NONE,
    },
  }
}

module.exports = {
  BATCH_IDENTITY_MODES,
  BATCH_IDENTITY_MODE_VALUES,
  DEGRADATION_REASONS,
  StockPreparationBatchIdentityError,
  hourBucket,
  mintStockPreparationBatchIdentity,
  readStockPreparationBatchIdentityMode,
}
