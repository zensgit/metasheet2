'use strict'

const crypto = require('node:crypto')

// #2342 C3/C4 large-BOM job contract.
// This module owns the route-facing job store/projection helpers while
// intentionally leaving dry-run composition and apply to later slices. The
// worker seam below produces the sealed expansion artifact used by those
// later slices while keeping public evidence values-free.

const { scrubSecretStringValue } = require('./payload-redaction.cjs')
const {
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_PAGES,
  DEFAULT_MAX_ROWS,
  expandPlmProjectBom,
  LARGE_BOM_BOUNDED_ERROR_TYPES,
  summarizeBomExpansionForEvidence,
} = require('./stock-preparation-bom-expansion.cjs')
const {
  planStockPreparationConflicts,
  summarizeConflictPlanForEvidence,
} = require('./stock-preparation-conflict-planner.cjs')
const {
  applyStockPreparationPlan,
  summarizeApplyResultForEvidence,
} = require('./stock-preparation-apply-writer.cjs')

const LARGE_BOM_BACKGROUND_EXPANSION_STATUSES = Object.freeze([
  'queued',
  'running',
  'paused',
  'failed',
  'completed',
  'cancelled',
  'expired',
])

const LARGE_BOM_CHECKPOINT_APPLY_STATUSES = Object.freeze([
  'queued',
  'running',
  'paused',
  'partial',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
])

const BACKGROUND_PROGRESS_FIELDS = Object.freeze([
  'rowsExpanded',
  'readCount',
  'frontierRemaining',
  'completedChunks',
])

const BACKGROUND_BUDGET_FIELDS = Object.freeze([
  'maxRows',
  'maxPages',
  'maxReadCount',
  'maxElapsedMs',
  'maxDepth',
  'maxArtifactChunks',
])

// A FAILED READ IS A DIAGNOSTIC, NOT A LOG. Twenty is enough to see the shape
// of a failure (one object, one error code, or a scatter across several) and
// small enough that a run whose every read failed cannot turn one job row into
// an unbounded array. Whatever the cap costs is reported: see `attachDetailList`.
const LARGE_BOM_READ_FAILURE_DETAIL_LIMIT = 20

// The per-entry bound. `filterFields` is the only variable-length field that
// survives projection, and its length is adapter-supplied (`metadata.filterFields`),
// so a hostile or broken adapter could otherwise make ONE diagnostic unbounded
// while every other cap here counted it as a single item.
const LARGE_BOM_READ_FAILURE_FILTER_FIELD_LIMIT = 32

// The ceiling on a counter read back OUT of storage. The stored `<key>Total` is
// written by this module today, but a job row is durable state that outlives the
// build that wrote it — so on the way out it is treated as a claim to be bounded,
// not a fact. DON'T TRUST CONTENT AND THEN TRUST ITS COUNTER.
const LARGE_BOM_EVIDENCE_COUNTER_CEILING = 1000000

const APPLY_COUNT_FIELDS = Object.freeze([
  'created',
  'updated',
  'inactive',
  'skipped',
  'held',
  'failed',
])

// `maxArtifactChunks` is a DESCRIPTION of the artifact's shape, not a budget
// that bounds anything. A background expansion is one `expandPlmProjectBom`
// pass sealed into one `job.artifact`, so the count is 1 and raising it would
// mean nothing until a chunked expander exists. Row VOLUME is paced on the
// apply side instead (LARGE_BOM_APPLY_DEFAULT_CHUNK_SIZE below), which is why
// widening the expansion caps does not require widening this.
const LARGE_BOM_ARTIFACT_CHUNK_COUNT = 1
const LARGE_BOM_APPLY_PERMISSIONS = Object.freeze(['write', 'admin'])
const LARGE_BOM_APPLY_DEFAULT_CHUNK_SIZE = 100
const LARGE_BOM_APPLY_MAX_CHUNK_SIZE = 1000
const activeCheckpointApplyRuns = new Set()

class StockPreparationLargeBomJobError extends Error {
  constructor(code, message, details = {}, status = 422) {
    super(message)
    this.name = 'StockPreparationLargeBomJobError'
    this.code = code
    this.status = status
    this.details = details
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function isRedactedMarker(value) {
  return /\[redacted[^\]]*\]|<redacted[^>]*>/i.test(value)
}

function safeEvidenceToken(value, field) {
  if (value !== undefined && value !== null && typeof value !== 'string') {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_EVIDENCE_INVALID',
      `${field} must be a string`,
      { field },
    )
  }
  const token = optionalString(value)
  if (!token) return ''
  if (isRedactedMarker(token) || /<[^>]+>/.test(token) || scrubSecretStringValue(token) !== token) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_EVIDENCE_UNSAFE',
      `${field} must not be secret, redacted, or placeholder-shaped`,
      { field },
    )
  }
  if (!/^[A-Za-z0-9_.:-]+$/.test(token)) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_EVIDENCE_UNSAFE',
      `${field} must be a values-free token`,
      { field },
    )
  }
  return token
}

function safeTokenList(value, field) {
  if (!Array.isArray(value)) return []
  const out = []
  for (let index = 0; index < value.length; index += 1) {
    const token = safeEvidenceToken(value[index], `${field}[${index}]`)
    if (token && !out.includes(token)) out.push(token)
  }
  return out
}

/**
 * DROP-INSTEAD-OF-THROW twin of `safeEvidenceToken`, for the read-failure
 * diagnostics below.
 *
 * `safeEvidenceToken` is right where a caller supplied the token and a bad one
 * is a bug worth refusing. It is WRONG on the failure path: these tokens come
 * from the driver (`error.code`) and from adapter metadata, so an unsafe one is
 * an ordinary Tuesday — and throwing there would replace the diagnostic we are
 * trying to persist with a second, less informative failure. Same safety rules,
 * different verdict: unsafe => the FIELD disappears, the rest of the diagnostic
 * survives.
 */
function evidenceTokenOrUndefined(value) {
  if (typeof value !== 'string') return undefined
  try {
    return safeEvidenceToken(value, 'readFailure') || undefined
  } catch {
    return undefined
  }
}

function evidenceTokenListOrEmpty(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const entry of value) {
    const token = evidenceTokenOrUndefined(entry)
    if (token && !out.includes(token)) out.push(token)
  }
  return out
}

/**
 * A COUNTER READ BACK FROM STORAGE IS A CLAIM, NOT A FACT.
 *
 * `attachStoredDetailEvidence` already refuses to trust the stored ARRAY — it
 * re-projects every entry through the values-free filter. Trusting the stored
 * COUNT while distrusting the content it counts would be the same mistake one
 * field over: a row written by another build (or hand-edited) could report
 * `readFailuresTotal: 1e12` next to a two-element array, and the public
 * projection would repeat it.
 *
 * So: non-integers and negatives fall back to the floor, absurd values are
 * clamped to the ceiling, and a total that claims FEWER items than we actually
 * projected is raised to what we can see. The result is never smaller than the
 * array it describes.
 */
function clampStoredTotal(value, floor) {
  const number = Number(value)
  const claimed = Number.isInteger(number) && number >= 0
    ? Math.min(number, LARGE_BOM_EVIDENCE_COUNTER_CEILING)
    : floor
  return Math.max(claimed, floor)
}

/**
 * ONE FAILED READ, VALUES-FREE. The allowed key set is closed and enumerated
 * here rather than filtered out of the diagnostic, because the diagnostic grows
 * over time and a deny-list would leak the next field somebody adds.
 *
 * `cursor` is deliberately NOT on the list. It is the one field here whose whole
 * PURPOSE is to carry adapter-opaque state — an offset for the PLM binding
 * today, an encoded key tomorrow — so no token filter can be trusted to vet it,
 * and it is excluded outright rather than filtered. The rest are named things
 * (table names, field names, symbolic codes) that CAN be vetted, and are: every
 * one goes through `evidenceTokenOrUndefined`, because `errorCode` and `source`
 * also arrive from outside this module and a driver is free to put anything in
 * them. `message` is on neither list and never will be: it is the driver's free
 * text and routinely quotes the part number that failed.
 */
function readFailureEntry(entry) {
  if (!isPlainObject(entry)) return {}
  const failure = {}
  const object = evidenceTokenOrUndefined(entry.object)
  if (object) failure.object = object
  const errorCode = evidenceTokenOrUndefined(entry.errorCode)
  if (errorCode) failure.errorCode = errorCode
  const filterFields = evidenceTokenListOrEmpty(entry.filterFields)
    .slice(0, LARGE_BOM_READ_FAILURE_FILTER_FIELD_LIMIT)
  if (filterFields.length > 0) failure.filterFields = filterFields
  if (entry.filtersApplied !== undefined) failure.filtersApplied = entry.filtersApplied === true
  const source = evidenceTokenOrUndefined(entry.source)
  if (source) failure.source = source
  return failure
}

function hasAnyKey(entry) {
  return Object.keys(entry).length > 0
}

/**
 * THE CANDIDATE SET, chosen by a values-free predicate that does not depend on
 * what survives projection. `<key>Total` counts THESE — see `attachDetailList`
 * for why the count is taken here and not after the filter.
 */
function readFailureCandidates(readDiagnostics) {
  if (!Array.isArray(readDiagnostics)) return []
  return readDiagnostics.filter((entry) => isPlainObject(entry) && entry.status === 'failed')
}

/**
 * ONE EXPANSION ERROR, VALUES-FREE. `expansion.errors[]` carries
 * `{ type, object?, causeClass?, message? }` — `causeClass` is the symbolic
 * `error.code || error.name` the expander deliberately kept beside the message
 * precisely so a downstream seam could classify without the message. This is
 * that seam: type + object + causeClass in, message out.
 */
function errorDetailEntry(entry) {
  if (!isPlainObject(entry)) return {}
  const detail = {}
  const type = evidenceTokenOrUndefined(entry.type)
  if (type) detail.type = type
  const object = evidenceTokenOrUndefined(entry.object)
  if (object) detail.object = object
  const causeClass = evidenceTokenOrUndefined(entry.causeClass)
  if (causeClass) detail.causeClass = causeClass
  return detail
}

/**
 * A DETAIL MUST ADD SOMETHING `errorTypes` DOES NOT.
 *
 * The first cut of this projection kept every entry that produced any key at
 * all, which meant `{ type }` alone qualified — and the bounded expansions whose
 * errors carry no object (`max_rows_exceeded` `{maxRows}`, `max_depth_exceeded`
 * `{maxDepth, parentDepth}`, `cycle_detected` `{depth}`) mounted three extra
 * evidence keys holding a verbatim copy of `errorTypes`. That is pure noise on
 * a path with zero failed reads, and it broke the "nothing to report => key set
 * unchanged" promise this feature is supposed to keep.
 *
 * The bar is therefore an OBJECT or a CAUSE CLASS: the two things `errorTypes`
 * cannot express. Note what this does NOT claim — a bounded error that names its
 * object (`read_count_exceeded`, `read_page_limit_exceeded`,
 * `read_time_limit_exceeded`, the three subtree limits) still mounts, and should:
 * "the read budget blew while reading WHICH object" is exactly the question
 * `errorTypes` leaves unanswered.
 */
function carriesObjectOrCauseClass(entry) {
  return entry.object !== undefined || entry.causeClass !== undefined
}

function isNamed(value) {
  return value !== undefined && value !== null && value !== ''
}

/**
 * THE CANDIDATE SET, tested on the RAW error rather than on what survived
 * projection — the same discipline as `readFailureCandidates`, and for the same
 * reason.
 *
 * Counting survivors instead was a real bug, caught in review: two
 * `read_count_exceeded` errors whose objects differ only in that one contains a
 * space (unsafe => the field is dropped) reported `1 / 1 / false` — one detail
 * silently gone while the stanza claimed nothing was missing. An error that
 * NAMES an object or a cause class is a detail we meant to report; whether its
 * token then passed the values-free filter decides if it is LISTED, never
 * whether it is COUNTED.
 */
function errorDetailCandidates(errors) {
  if (!Array.isArray(errors)) return []
  return errors.filter((entry) => isPlainObject(entry) && (isNamed(entry.object) || isNamed(entry.causeClass)))
}

/**
 * CONDITIONAL MOUNT, so a run with nothing to report keeps a byte-identical
 * evidence key set.
 *
 * `total` is the size of the CANDIDATE set, counted before projection — not the
 * length of what survived it. The difference is the whole point: three reads
 * that failed with driver codes too unsafe to project are still three failed
 * reads, and reporting `readFailuresTotal: 0` there would be a wrong answer to
 * the one question this stanza exists to answer. BOTH call sites obey this:
 * `readFailureCandidates` and `errorDetailCandidates` each pick the candidate
 * set off the raw input, and only then is projection allowed to thin the list.
 *
 * `<key>Truncated` is therefore derived as "the array does not list everything
 * counted" (`shown < total`) rather than "the cap fired" — exactly true whether
 * an entry went missing to the cap or to unprojectable content.
 */
function attachDetailList(evidence, key, { items, total }) {
  if (!Number.isInteger(total) || total <= 0) return evidence
  const shown = items.slice(0, LARGE_BOM_READ_FAILURE_DETAIL_LIMIT)
  evidence[key] = shown
  evidence[`${key}Total`] = total
  evidence[`${key}Truncated`] = shown.length < total
  return evidence
}

function attachReadFailureEvidence(evidence, { readDiagnostics, errors } = {}) {
  const failedReads = readFailureCandidates(readDiagnostics)
  attachDetailList(evidence, 'readFailures', {
    items: failedReads.map(readFailureEntry).filter(hasAnyKey),
    total: failedReads.length,
  })
  const namedErrors = errorDetailCandidates(errors)
  attachDetailList(evidence, 'errorDetails', {
    items: namedErrors.map(errorDetailEntry).filter(carriesObjectOrCauseClass),
    total: namedErrors.length,
  })
  return evidence
}

/**
 * The same two stanzas re-projected on the way OUT of storage. A stored job can
 * predate this feature, or have been written by a build that projected more
 * than this one does, so the public projection re-runs the values-free filter
 * instead of trusting what it reads back.
 *
 * KNOWN ASYMMETRY, currently unreachable. The storage side mounts on
 * `total > 0`, so a run whose candidates were ALL unprojectable persists
 * `readFailures: [] / Total: N / Truncated: true` — an honest "N reads failed,
 * none of them yielded a safe field". This function mounts on `items.length`
 * instead and early-returns on an empty list, so it would drop that row's
 * counters rather than republish them. Not a live divergence: every entry this
 * module STORES has already passed the values-free filter, so a stored array is
 * empty here only if the row came from elsewhere. Left as-is deliberately —
 * mounting a bare counter with no array is a public-shape change that wants its
 * own decision, not a side effect of this one.
 */
function attachStoredDetailEvidence(publicEvidence, evidence, key, projectEntry, keepEntry) {
  const stored = Array.isArray(evidence[key]) ? evidence[key] : []
  const items = stored.map(projectEntry).filter(keepEntry)
  if (items.length === 0) return publicEvidence
  const shown = items.slice(0, LARGE_BOM_READ_FAILURE_DETAIL_LIMIT)
  const total = clampStoredTotal(evidence[`${key}Total`], items.length)
  publicEvidence[key] = shown
  publicEvidence[`${key}Total`] = total
  // DERIVED, NEVER COPIED. The stored flag is not consulted: a row could carry
  // `Truncated: false` beside a 40-element array, or a non-boolean like
  // `'maybe'`. `shown < total` is computed from the two numbers this projection
  // just established, so it is a boolean, and it is forced true whenever the
  // slice above actually dropped something.
  publicEvidence[`${key}Truncated`] = shown.length < total
  return publicEvidence
}

function nonNegativeInteger(value, field) {
  if (value === undefined || value === null || value === '') return 0
  const isNumericString = typeof value === 'string' && /^\s*\d+\s*$/.test(value)
  const isSafeNumber = typeof value === 'number' && Number.isInteger(value) && value >= 0
  if (!isNumericString && !isSafeNumber) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_EVIDENCE_INVALID',
      `${field} must be a non-negative integer`,
      { field },
    )
  }
  return Number(value)
}

function nonNegativeProjection(input, fields) {
  const value = isPlainObject(input) ? input : {}
  return Object.fromEntries(fields.map((field) => [field, nonNegativeInteger(value[field], field)]))
}

/**
 * BUDGETS ARE NOT COUNTERS, so they do not share the projection above.
 * `nonNegativeProjection` reports an absent field as 0, which is right for
 * `progress` (nothing has happened yet) and actively WRONG for `budgets`:
 * `maxReadCount` and `maxElapsedMs` have no expander default, so absent means
 * THERE IS NO BOUND — and `maxReadCount: 0` reads as "the bound is zero", the
 * exact opposite. Absent is therefore `null`.
 *
 * The KEY SET stays fixed (every BACKGROUND_BUDGET_FIELDS member is present) so
 * a reader can tell "this budget is unbounded" from "this build does not report
 * that budget at all". Values-free either way: budgets are configured integers.
 */
function budgetProjection(input, fields) {
  const value = isPlainObject(input) ? input : {}
  return Object.fromEntries(fields.map((field) => {
    const raw = value[field]
    if (raw === undefined || raw === null || raw === '') return [field, null]
    return [field, nonNegativeInteger(raw, field)]
  }))
}

function normalizeStatus(value, allowed, field) {
  const status = safeEvidenceToken(value, field)
  if (!allowed.includes(status)) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_STATUS_INVALID',
      `${field} is not supported`,
      { field, status },
    )
  }
  return status
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function hashJson(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex')
}

function isoNow(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now)
  if (!Number.isFinite(date.getTime())) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_TIMESTAMP_INVALID',
      'job timestamp is invalid',
      {},
    )
  }
  return date.toISOString()
}

function defaultJobId() {
  return `large-bom-expansion-${crypto.randomUUID()}`
}

function defaultApplyJobId() {
  return `large-bom-apply-${crypto.randomUUID()}`
}

function ensureDurableJobStorage(storage) {
  if (!storage || storage.durable !== true) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_STORE_UNAVAILABLE',
      'large-BOM background expansion requires durable job storage',
      { durable: false },
      501,
    )
  }
  for (const method of ['get', 'set']) {
    if (typeof storage[method] !== 'function') {
      throw new StockPreparationLargeBomJobError(
        'LARGE_BOM_JOB_STORE_UNAVAILABLE',
        `large-BOM job storage is missing ${method}`,
        { method },
        501,
      )
    }
  }
  return storage
}

function requiredJobScope(input = {}) {
  const tenantId = safeEvidenceToken(input.tenantId, 'tenantId')
  const workspaceId = safeEvidenceToken(input.workspaceId, 'workspaceId')
  if (!tenantId || !workspaceId) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_SCOPE_REQUIRED',
      'large-BOM job scope is required',
      { tenantIdPresent: Boolean(tenantId), workspaceIdPresent: Boolean(workspaceId) },
    )
  }
  return { tenantId, workspaceId }
}

function backgroundJobKey(input = {}) {
  const { tenantId, workspaceId } = requiredJobScope(input)
  const safeActionId = safeEvidenceToken(input.actionId, 'actionId')
  const safeJobId = safeEvidenceToken(input.jobId, 'jobId')
  if (!safeActionId || !safeJobId) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_ID_INVALID',
      'large-BOM job id is required',
      { actionIdPresent: Boolean(safeActionId), jobIdPresent: Boolean(safeJobId) },
    )
  }
  return `stock-preparation:large-bom:background:${tenantId}:${workspaceId}:${safeActionId}:${safeJobId}`
}

function checkpointApplyJobKey(input = {}) {
  const { tenantId, workspaceId } = requiredJobScope(input)
  const safeActionId = safeEvidenceToken(input.actionId, 'actionId')
  const safeApplyJobId = safeEvidenceToken(input.applyJobId, 'applyJobId')
  if (!safeActionId || !safeApplyJobId) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_APPLY_JOB_ID_INVALID',
      'large-BOM checkpoint apply job id is required',
      { actionIdPresent: Boolean(safeActionId), applyJobIdPresent: Boolean(safeApplyJobId) },
    )
  }
  return `stock-preparation:large-bom:apply:${tenantId}:${workspaceId}:${safeActionId}:${safeApplyJobId}`
}

function requiredPrincipal(value) {
  const principal = optionalString(value)
  if (!principal) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_PRINCIPAL_REQUIRED',
      'large-BOM background expansion requires an authenticated principal',
      {},
    )
  }
  return principal
}

function publicBackgroundExpansionJob(job) {
  return {
    jobId: safeEvidenceToken(job && job.jobId, 'jobId'),
    ...summarizeLargeBomBackgroundExpansionJobForEvidence(job),
  }
}

function publicCheckpointApplyJob(job) {
  return {
    jobId: safeEvidenceToken(job && job.jobId, 'jobId'),
    ...summarizeLargeBomCheckpointApplyJobForEvidence(job),
  }
}

async function createLargeBomBackgroundExpansionJob(input = {}) {
  const storage = ensureDurableJobStorage(input.storage)
  const scope = requiredJobScope(input)
  const principal = requiredPrincipal(input.principal)
  // WHO ASKED, recorded apart from WHOSE CREDENTIALS ANSWER. `principal` is the identity the source
  // read is performed under — for the stock-prep pull that is the server-held binding owner, not the
  // caller (see resolveTableActionReadPrincipal) — while `actor` is the human who started this job.
  // Conflating them let any caller who could reach the run route drive a stored job under somebody
  // else's data-source ownership simply by naming its id.
  const actor = optionalString(input.actor) || principal
  const action = isPlainObject(input.action) ? input.action : {}
  const actionId = safeEvidenceToken(action.actionId || input.actionId, 'actionId')
  if (!actionId) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_ACTION_INVALID',
      'large-BOM job actionId is required',
      { actionIdPresent: false },
    )
  }
  const parameters = isPlainObject(input.parameters) ? cloneJson(input.parameters) : {}
  const jobId = safeEvidenceToken((typeof input.createJobId === 'function' ? input.createJobId() : '') || defaultJobId(), 'jobId')
  const now = isoNow(typeof input.now === 'function' ? input.now() : undefined)
  const job = {
    jobId,
    ...scope,
    actionId,
    status: 'queued',
    authoritative: false,
    projectNoPresent: optionalString(parameters.projectNo) !== '',
    parameters,
    principal,
    actor,
    actionSnapshot: cloneJson(action),
    sourceKind: safeEvidenceToken(action.source && action.source.kind, 'sourceKind') || undefined,
    progress: {
      rowsExpanded: 0,
      readCount: 0,
      frontierRemaining: 0,
      completedChunks: 0,
    },
    budgets: {},
    evidence: {
      sourceKind: safeEvidenceToken(action.source && action.source.kind, 'sourceKind') || undefined,
      readObjects: [],
      errorTypes: [],
      readDiagnosticShapePresent: false,
    },
    createdAt: now,
    updatedAt: now,
  }
  await storage.set(backgroundJobKey({ ...scope, actionId, jobId }), job)
  return cloneJson(job)
}

async function loadLargeBomBackgroundExpansionJob(input = {}) {
  const storage = ensureDurableJobStorage(input.storage)
  const key = backgroundJobKey(input)
  const job = await storage.get(key)
  if (!job) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_NOT_FOUND',
      'large-BOM background expansion job was not found',
      { jobIdPresent: Boolean(optionalString(input.jobId)) },
      404,
    )
  }
  return cloneJson(job)
}

async function cancelLargeBomBackgroundExpansionJob(input = {}) {
  const storage = ensureDurableJobStorage(input.storage)
  requiredPrincipal(input.principal)
  const key = backgroundJobKey(input)
  const job = await storage.get(key)
  if (!job) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_NOT_FOUND',
      'large-BOM background expansion job was not found',
      { jobIdPresent: Boolean(optionalString(input.jobId)) },
      404,
    )
  }
  if (job.status === 'completed') {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_CANCEL_REJECTED',
      'completed large-BOM background expansion job cannot be cancelled',
      { status: 'completed' },
      409,
    )
  }
  if (!['cancelled', 'failed', 'expired'].includes(job.status)) {
    job.status = 'cancelled'
    job.authoritative = false
    job.updatedAt = isoNow(typeof input.now === 'function' ? input.now() : undefined)
    await storage.set(key, job)
  }
  return cloneJson(job)
}

function requireSourceAdapter(adapter) {
  if (!adapter || typeof adapter.read !== 'function') {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_SOURCE_ADAPTER_UNAVAILABLE',
      'large-BOM background expansion requires a source adapter with read()',
      {},
      501,
    )
  }
  return adapter
}

function expansionArtifactRevision({ job, expansion }) {
  return hashJson({
    action: job.actionSnapshot || { actionId: job.actionId },
    parameters: job.parameters || {},
    principal: job.principal,
    expansion: {
      rows: Array.isArray(expansion.rows) ? expansion.rows : [],
      summary: expansion.summary || {},
    },
  })
}

function dropEmptyBudgets(budgets) {
  for (const key of Object.keys(budgets)) {
    if (budgets[key] === undefined || budgets[key] === null || budgets[key] === '') delete budgets[key]
  }
  return budgets
}

/**
 * The caps THIS RUN will actually enforce, written down before the first source
 * read rather than only after the expansion returns. Two reasons: a run that
 * dies in the adapter (or is still `running` when an operator looks) used to
 * report `budgets: {}`, which is exactly when a deployer needs to know whether
 * the background lane got its own numbers; and an issue report should be able
 * to distinguish "the background cap was too small" from "the background cap
 * was never applied". Values-free — these are configured integers, never
 * customer data.
 *
 * Mirrors the expander's own defaulting so the pre-run and post-run stanzas
 * agree: `maxRows`/`maxPages`/`maxDepth` fall back to the expander defaults,
 * `maxReadCount`/`maxElapsedMs` stay absent when nothing bounds them.
 */
function effectiveExpansionBudgets(expansionOptions) {
  const options = isPlainObject(expansionOptions) ? expansionOptions : {}
  return dropEmptyBudgets({
    maxRows: positiveBudget(options.maxRows) || DEFAULT_MAX_ROWS,
    maxPages: positiveBudget(options.maxPages) || DEFAULT_MAX_PAGES,
    maxReadCount: positiveBudget(options.maxReadCount),
    maxElapsedMs: positiveBudget(options.maxElapsedMs),
    maxDepth: nonNegativeBudget(options.maxDepth, DEFAULT_MAX_DEPTH),
    maxArtifactChunks: LARGE_BOM_ARTIFACT_CHUNK_COUNT,
  })
}

function positiveBudget(value) {
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : undefined
}

// `maxDepth` alone admits 0 (the expander's `nonNegativeInteger`), so it cannot
// share `positiveBudget`'s truthiness fallback.
function nonNegativeBudget(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 ? number : fallback
}

/**
 * THE ONE PLACE A FAILED LARGE-BOM JOB TALKS TO AN OPERATOR. `logger` is
 * optional (the two call sites below pass `input.logger`, which is `undefined`
 * unless a caller wires one — see http-routes.cjs's `routeLogger`), and a
 * deployment that wires none keeps byte-identical behaviour: this returns
 * before touching `job` at all.
 *
 * The payload is a NARROWER re-projection of `job.evidence` — never a new
 * read — so it can carry only what that stanza already carries, minus the
 * fields `readFailureEntry`/`errorDetailEntry` never let onto `job.evidence`
 * in the first place (`message`, `cursor`, row values). `principal` is
 * excluded on purpose too: it identifies the data-source binding the read ran
 * under, and a pm2 log line is a worse place for that than the stored job row
 * an operator already has to open to see anything else about the failure.
 *
 * Mirrors the module's "nothing to report => key absent" rule: `readFailures`
 * / `errorDetails` / `readFailuresTotal` mount only when `job.evidence`
 * actually has them, so the escaped-throw path (no per-read record — see
 * `runLargeBomBackgroundExpansionJob`'s catch block) logs without them rather
 * than a stray `0` or `[]` that would misstate "nothing failed" as "one read
 * failed at nothing".
 *
 * Never throws: a logger this defensive about its own inputs must not be the
 * reason a job write fails, and a hostile or malformed job row must not be
 * able to turn a diagnostic into a crash.
 *
 * CALLED BEFORE `storage.set(key, job)` at both call sites, on purpose: if the
 * durable write then fails, an operator still gets the diagnostic in pm2 even
 * though the stored job row never reaches `failed`. The alternative order
 * trades that away for the opposite gap — a write failure would swallow the
 * one log line explaining what just failed — which is the worse trade for a
 * feature whose whole point is "don't make failure silent".
 */
function logLargeBomJobFailure(logger, job) {
  if (!logger || typeof logger.warn !== 'function') return
  try {
    const evidence = isPlainObject(job.evidence) ? job.evidence : {}
    // #5514 adversarial review: this is a FAILURE-PATH diagnostic, and `evidence.errorTypes` can in
    // principle arrive from outside this module the same way `readFailures`/`errorDetails` do — so
    // it gets the same drop-instead-of-throw twin they use (`evidenceTokenListOrEmpty`), not the
    // throwing `safeTokenList`. The outer `try/catch` below would otherwise turn one unsafe token
    // into NO log line at all, on the one path where a log line matters most. See the doc comment
    // on `evidenceTokenOrUndefined` above for why "drop the field" is the failure-path verdict.
    const errorTypes = evidenceTokenListOrEmpty(evidence.errorTypes)
    const payload = {
      jobId: evidenceTokenOrUndefined(job.jobId),
      actionId: evidenceTokenOrUndefined(job.actionId),
      tenantId: evidenceTokenOrUndefined(job.tenantId),
      workspaceId: evidenceTokenOrUndefined(job.workspaceId),
      status: evidenceTokenOrUndefined(job.status),
      errorTypes,
      scaleErrorTypes: errorTypes.filter((type) => LARGE_BOM_BOUNDED_ERROR_TYPES.includes(type)),
    }
    if (Number.isInteger(evidence.readFailuresTotal) && evidence.readFailuresTotal > 0) {
      payload.readFailuresTotal = Math.min(evidence.readFailuresTotal, LARGE_BOM_EVIDENCE_COUNTER_CEILING)
    }
    if (Array.isArray(evidence.readFailures) && evidence.readFailures.length > 0) {
      payload.readFailures = evidence.readFailures.slice(0, LARGE_BOM_READ_FAILURE_DETAIL_LIMIT).map((entry) => {
        const projected = {}
        const object = evidenceTokenOrUndefined(entry && entry.object)
        if (object) projected.object = object
        const errorCode = evidenceTokenOrUndefined(entry && entry.errorCode)
        if (errorCode) projected.errorCode = errorCode
        return projected
      })
    }
    if (Array.isArray(evidence.errorDetails) && evidence.errorDetails.length > 0) {
      // #5514 adversarial review: this key set (type/object/causeClass, each through
      // `evidenceTokenOrUndefined`) is IDENTICAL to `errorDetailEntry` above — the public
      // projection's own re-selection of the same stored stanza. Calling it here instead of
      // re-typing the three fields means a future narrowing of `errorDetailEntry` narrows this log
      // line too, instead of silently diverging from it.
      payload.errorDetails = evidence.errorDetails
        .slice(0, LARGE_BOM_READ_FAILURE_DETAIL_LIMIT)
        .map((entry) => errorDetailEntry(entry))
    }
    logger.warn('[plugin-integration-core] large-BOM background expansion job failed', payload)
  } catch {
    // See the doc comment: a broken logger or a malformed job row degrades to
    // "no log line", never to a thrown error out of a state-transition helper.
  }
}

function updateJobFromExpansion(job, expansion, now, logger) {
  const evidence = summarizeBomExpansionForEvidence(expansion)
  const progress = {
    rowsExpanded: Number(evidence.rowsExpanded || 0),
    readCount: Number(evidence.readCount || 0),
    frontierRemaining: 0,
    completedChunks: expansion.valid === true ? 1 : 0,
  }
  const budgets = dropEmptyBudgets({
    maxRows: evidence.maxRows,
    maxPages: evidence.maxPages,
    maxReadCount: evidence.maxReadCount,
    maxElapsedMs: evidence.maxElapsedMs,
    maxDepth: evidence.maxDepth,
    maxArtifactChunks: LARGE_BOM_ARTIFACT_CHUNK_COUNT,
  })
  job.progress = progress
  job.budgets = budgets
  // `readDiagnosticShapePresent` STAYS, byte-identical: it is a boolean other
  // guards may pin, and it answers a different question ("did the expander
  // produce diagnostics at all") from the stanzas below ("which reads failed").
  //
  // Both stanzas are conditionally mounted, so a run with no failed read and no
  // object-bearing error keeps the pre-feature four-key evidence set. That
  // covers the clean path and the object-less bounded ones (`max_rows_exceeded`,
  // `max_depth_exceeded`, `cycle_detected`); see `carriesObjectOrCauseClass` for
  // the bounded errors that DO mount, on purpose.
  job.evidence = attachReadFailureEvidence({
    sourceKind: job.sourceKind,
    readObjects: evidence.readObjects || [],
    errorTypes: evidence.errorTypes || [],
    readDiagnosticShapePresent: Array.isArray(evidence.readDiagnostics) && evidence.readDiagnostics.length > 0,
  }, { readDiagnostics: evidence.readDiagnostics, errors: expansion.errors })
  job.updatedAt = now
  if (expansion.valid === true) {
    const revision = expansionArtifactRevision({ job, expansion })
    job.status = 'completed'
    job.authoritative = true
    job.artifactRevision = revision
    job.artifact = {
      revision,
      status: expansion.status,
      rows: cloneJson(expansion.rows || []),
      summary: cloneJson(expansion.summary || {}),
      sealedAt: now,
    }
    return
  }
  job.status = 'failed'
  job.authoritative = false
  delete job.artifactRevision
  delete job.artifact
  logLargeBomJobFailure(logger, job)
}

function safeErrorType(error) {
  try {
    return safeEvidenceToken(error && (error.code || error.name), 'errorType') || 'read_failed'
  } catch {
    return 'read_failed'
  }
}

/**
 * The escaped throw rendered in `expansion.errors[]`'s shape, so both projection
 * points feed `errorDetailEntry` and the stored stanza means the same thing on
 * either path. `details` is the expander's own error bag
 * (`StockPreparationBomExpansionError`); a raw driver error has neither and
 * contributes only its cause class.
 */
function thrownErrorDetail(error) {
  const details = isPlainObject(error && error.details) ? error.details : {}
  return {
    type: safeErrorType(error),
    object: details.object,
    causeClass: (error && (error.code || error.name)) || undefined,
  }
}

async function runLargeBomBackgroundExpansionJob(input = {}) {
  const storage = ensureDurableJobStorage(input.storage)
  const sourceAdapter = requireSourceAdapter(input.sourceAdapter)
  const key = backgroundJobKey(input)
  const job = await storage.get(key)
  if (!job) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_NOT_FOUND',
      'large-BOM background expansion job was not found',
      { jobIdPresent: Boolean(optionalString(input.jobId)) },
      404,
    )
  }
  if (job.status === 'completed') return cloneJson(job)
  if (!['queued', 'running', 'paused', 'failed'].includes(job.status)) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_RUN_REJECTED',
      'large-BOM background expansion job cannot be run from this status',
      { status: safeEvidenceToken(job.status, 'status') || undefined },
      409,
    )
  }
  requiredPrincipal(job.principal)
  const expansionOptions = isPlainObject(input.expansionOptions) ? input.expansionOptions : {}
  const runningAt = isoNow(typeof input.now === 'function' ? input.now() : undefined)
  job.status = 'running'
  job.authoritative = false
  // The caps this run enforces, recorded BEFORE the first source read — see
  // `effectiveExpansionBudgets`. `updateJobFromExpansion` rewrites the same
  // stanza from the expansion summary afterwards; the two agree by
  // construction, and this one is what survives an adapter throw.
  job.budgets = effectiveExpansionBudgets(expansionOptions)
  job.updatedAt = runningAt
  await storage.set(key, job)

  let expansion
  try {
    expansion = await expandPlmProjectBom({
      sourceAdapter,
      projectNo: job.parameters && job.parameters.projectNo,
      // F1c 根选择规则,taken from the job's STORED ACTION SNAPSHOT (`cloneJson(action)` at enqueue)
      // — the same seam `extensionFieldIds` / `carryPolicy` already use, and the reason it has to be
      // read here: the caller-supplied `expansionOptions` are assembled by the route module from a
      // fixed key set, so a deployment that configured `rootSelection` would otherwise get 老系统
      // roots interactively and pre-F1c roots in the background lane — the SAME project expanding to
      // two different root sets depending only on how big its BOM is.
      //
      // Listed BEFORE the spread so an explicit caller value still wins (the route stays the
      // authority over what it passes); absent on both => `undefined` => the expander's default.
      rootSelection: job.actionSnapshot && job.actionSnapshot.rootSelection,
      ...expansionOptions,
    })
  } catch (error) {
    const failedAt = isoNow(typeof input.now === 'function' ? input.now() : undefined)
    job.status = 'failed'
    job.authoritative = false
    job.progress = {
      rowsExpanded: 0,
      readCount: 0,
      frontierRemaining: 0,
      completedChunks: 0,
    }
    // NO EXPANSION, so no `readDiagnostics` to project — but the throw itself
    // still names an object and a cause class, and losing those is exactly the
    // hole this change closes. `readFailures` stays absent here (there is no
    // per-read record to report), which is itself the signal that the run died
    // before the expander could summarize.
    job.evidence = attachReadFailureEvidence({
      sourceKind: job.sourceKind,
      readObjects: [],
      errorTypes: [safeErrorType(error)],
      readDiagnosticShapePresent: false,
    }, { errors: [thrownErrorDetail(error)] })
    job.updatedAt = failedAt
    logLargeBomJobFailure(input.logger, job)
    await storage.set(key, job)
    return cloneJson(job)
  }

  const completedAt = isoNow(typeof input.now === 'function' ? input.now() : undefined)
  updateJobFromExpansion(job, expansion, completedAt, input.logger)
  await storage.set(key, job)
  return cloneJson(job)
}

function normalizeExistingRows(rows) {
  if (rows === undefined || rows === null) return []
  if (!Array.isArray(rows)) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_PLAN_EXISTING_ROWS_INVALID',
      'existingRows must be an array',
      { field: 'existingRows' },
    )
  }
  for (let index = 0; index < rows.length; index += 1) {
    if (!isPlainObject(rows[index])) {
      throw new StockPreparationLargeBomJobError(
        'LARGE_BOM_PLAN_EXISTING_ROWS_INVALID',
        'existingRows entries must be objects',
        { field: 'existingRows', index },
      )
    }
  }
  return rows.map(cloneJson)
}

function largeBomPlanRevision({ job, plan, existingRows, conflictPolicyReview }) {
  return hashJson({
    artifactRevision: job.artifactRevision || (job.artifact && job.artifact.revision),
    existingRows,
    conflictPolicyReview: conflictPolicyReview || null,
    plan: {
      valid: plan.valid === true,
      counts: plan.counts || {},
      conflictTypes: plan.summary && plan.summary.conflictTypes,
      duplicateExpandedKeyDiagnostics: plan.summary && plan.summary.duplicateExpandedKeyDiagnostics,
      duplicateExpandedKeyResolution: plan.summary && plan.summary.duplicateExpandedKeyResolution,
    },
  })
}

function isAuthoritativeLargeBomPlan(job = {}) {
  if (!isAuthoritativeLargeBomExpansion(job)) return false
  const planArtifact = isPlainObject(job.planArtifact) ? job.planArtifact : {}
  const plan = isPlainObject(planArtifact.plan) ? planArtifact.plan : {}
  return Boolean(optionalString(job.planRevision || planArtifact.revision)) &&
    Array.isArray(plan.decisions)
}

function assertAuthoritativeLargeBomPlan(job = {}) {
  if (!isAuthoritativeLargeBomPlan(job)) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_PLAN_ARTIFACT_NOT_AUTHORITATIVE',
      'large-BOM apply requires a completed authoritative conflict plan artifact',
      {
        status: isPlainObject(job) ? optionalString(job.status) || undefined : undefined,
        authoritative: isPlainObject(job) ? job.authoritative === true : false,
        artifactRevisionPresent: isPlainObject(job)
          ? Boolean(optionalString(job.artifactRevision || (job.artifact && job.artifact.revision)))
          : false,
        planRevisionPresent: isPlainObject(job)
          ? Boolean(optionalString(job.planRevision || (job.planArtifact && job.planArtifact.revision)))
          : false,
      },
    )
  }
  return job
}

function requireApplyPermission(value) {
  const permission = optionalString(value)
  if (!LARGE_BOM_APPLY_PERMISSIONS.includes(permission)) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_APPLY_PERMISSION_REQUIRED',
      'large-BOM checkpoint apply requires Data Factory write/admin permission',
      { permission: permission || undefined },
      403,
    )
  }
  return permission
}

function normalizeChunkSize(value) {
  if (value === undefined || value === null || value === '') return LARGE_BOM_APPLY_DEFAULT_CHUNK_SIZE
  const parsed = nonNegativeInteger(value, 'maxDecisionsPerChunk')
  if (parsed < 1 || parsed > LARGE_BOM_APPLY_MAX_CHUNK_SIZE) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_APPLY_CHUNK_SIZE_INVALID',
      'large-BOM checkpoint apply chunk size is out of range',
      { min: 1, max: LARGE_BOM_APPLY_MAX_CHUNK_SIZE },
    )
  }
  return parsed
}

function emptyApplyCounts() {
  return Object.fromEntries(APPLY_COUNT_FIELDS.map((field) => [field, 0]))
}

function mergeCounts(left = {}, right = {}) {
  const out = emptyApplyCounts()
  for (const field of APPLY_COUNT_FIELDS) {
    out[field] = nonNegativeInteger(left[field], field) + nonNegativeInteger(right[field], field)
  }
  return out
}

function mergeTokenList(left = [], right = []) {
  const out = []
  for (const token of [...left, ...right]) {
    if (typeof token === 'string' && token && !out.includes(token)) out.push(token)
  }
  return out.sort()
}

function countManualConfirmDecisions(plan = {}) {
  return Array.isArray(plan.decisions)
    ? plan.decisions.filter((decision) => decision && decision.decision === 'manual_confirm').length
    : 0
}

function requireTargetSnapshot(job = {}) {
  const target = job.actionSnapshot && job.actionSnapshot.target
  if (!isPlainObject(target)) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_APPLY_TARGET_REQUIRED',
      'large-BOM checkpoint apply requires a server-configured target binding',
      { targetPresent: false },
    )
  }
  return cloneJson(target)
}

function requireCheckpointRecordsApi(recordsApi) {
  if (
    !recordsApi ||
    typeof recordsApi.queryRecords !== 'function' ||
    typeof recordsApi.createRecord !== 'function' ||
    typeof recordsApi.patchRecord !== 'function'
  ) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_APPLY_RECORDS_API_UNAVAILABLE',
      'large-BOM checkpoint apply requires queryRecords/createRecord/patchRecord records API',
      { field: 'recordsApi' },
      501,
    )
  }
  return recordsApi
}

async function createLargeBomCheckpointApplyJob(input = {}) {
  const storage = ensureDurableJobStorage(input.storage)
  const scope = requiredJobScope(input)
  const principal = requiredPrincipal(input.principal)
  const permission = requireApplyPermission(input.permission)
  const sourceJob = await loadLargeBomBackgroundExpansionJob({
    storage,
    ...scope,
    actionId: input.actionId,
    jobId: input.jobId,
  })
  assertAuthoritativeLargeBomPlan(sourceJob)
  const planArtifact = sourceJob.planArtifact
  const plan = cloneJson(planArtifact.plan)
  const manualConfirmCount = countManualConfirmDecisions(plan)
  if (manualConfirmCount > 0 && input.acceptManualConfirmHold !== true) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_APPLY_MANUAL_CONFIRM_ACK_REQUIRED',
      'large-BOM checkpoint apply requires explicit acknowledgement for held manual-confirm rows',
      { manualConfirmCount },
      409,
    )
  }
  const target = requireTargetSnapshot(sourceJob)
  const applyJobId = safeEvidenceToken(
    (typeof input.createApplyJobId === 'function' ? input.createApplyJobId() : '') ||
      optionalString(input.applyJobId) ||
      defaultApplyJobId(),
    'applyJobId',
  )
  const now = isoNow(typeof input.now === 'function' ? input.now() : undefined)
  const job = {
    jobId: applyJobId,
    ...scope,
    actionId: sourceJob.actionId,
    sourceJobId: sourceJob.jobId,
    status: 'queued',
    planRevision: sourceJob.planRevision || planArtifact.revision,
    targetRevision: hashJson(target),
    approvalPresent: true,
    approval: {
      principal,
      permission,
      acceptManualConfirmHold: input.acceptManualConfirmHold === true,
      approvedAt: now,
    },
    permission,
    target,
    template: sourceJob.actionSnapshot && sourceJob.actionSnapshot.template
      ? cloneJson(sourceJob.actionSnapshot.template)
      : undefined,
    plan,
    totalDecisions: Array.isArray(plan.decisions) ? plan.decisions.length : 0,
    checkpoint: {
      nextDecisionIndex: 0,
      completedChunks: 0,
    },
    counts: emptyApplyCounts(),
    evidence: {
      resultStatuses: [],
      errorCodes: [],
      fieldCategories: ['plm_system'],
    },
    createdAt: now,
    updatedAt: now,
  }
  await storage.set(checkpointApplyJobKey({ ...scope, actionId: sourceJob.actionId, applyJobId }), job)
  return cloneJson(job)
}

async function loadLargeBomCheckpointApplyJob(input = {}) {
  const storage = ensureDurableJobStorage(input.storage)
  const key = checkpointApplyJobKey({ ...input, applyJobId: input.applyJobId || input.jobId })
  const job = await storage.get(key)
  if (!job) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_APPLY_JOB_NOT_FOUND',
      'large-BOM checkpoint apply job was not found',
      { applyJobIdPresent: Boolean(optionalString(input.applyJobId || input.jobId)) },
      404,
    )
  }
  return cloneJson(job)
}

function nextDecisionIndex(job = {}) {
  return nonNegativeInteger(job.checkpoint && job.checkpoint.nextDecisionIndex, 'checkpoint.nextDecisionIndex')
}

function completedChunks(job = {}) {
  return nonNegativeInteger(job.checkpoint && job.checkpoint.completedChunks, 'checkpoint.completedChunks')
}

function mergeApplyEvidence(job, applyResult) {
  const publicResult = summarizeApplyResultForEvidence(applyResult)
  const evidence = isPlainObject(job.evidence) ? job.evidence : {}
  job.evidence = {
    resultStatuses: mergeTokenList(evidence.resultStatuses, publicResult.resultStatuses),
    errorCodes: mergeTokenList(evidence.errorCodes, publicResult.errorCodes),
    fieldCategories: mergeTokenList(evidence.fieldCategories, ['plm_system']),
  }
}

function terminalApplyStatus(counts = {}) {
  if (nonNegativeInteger(counts.failed, 'failed') > 0 || nonNegativeInteger(counts.held, 'held') > 0) return 'partial'
  return 'succeeded'
}

function acquireCheckpointApplyRun(key) {
  if (activeCheckpointApplyRuns.has(key)) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_APPLY_RUN_IN_PROGRESS',
      'large-BOM checkpoint apply job already has a running chunk',
      { status: 'running' },
      409,
    )
  }
  activeCheckpointApplyRuns.add(key)
  let released = false
  return () => {
    if (released) return
    released = true
    activeCheckpointApplyRuns.delete(key)
  }
}

async function runLargeBomCheckpointApplyJobChunk(input = {}) {
  const storage = ensureDurableJobStorage(input.storage)
  const key = checkpointApplyJobKey({ ...input, applyJobId: input.applyJobId || input.jobId })
  const release = acquireCheckpointApplyRun(key)
  try {
    const job = await storage.get(key)
    if (!job) {
      throw new StockPreparationLargeBomJobError(
        'LARGE_BOM_APPLY_JOB_NOT_FOUND',
        'large-BOM checkpoint apply job was not found',
        { applyJobIdPresent: Boolean(optionalString(input.applyJobId || input.jobId)) },
        404,
      )
    }
    if (['succeeded', 'partial'].includes(job.status)) return cloneJson(job)
    if (job.status === 'running') {
      throw new StockPreparationLargeBomJobError(
        'LARGE_BOM_APPLY_RUN_IN_PROGRESS',
        'large-BOM checkpoint apply job already has a running chunk',
        { status: 'running' },
        409,
      )
    }
    if (!['queued', 'paused', 'failed'].includes(job.status)) {
      throw new StockPreparationLargeBomJobError(
        'LARGE_BOM_APPLY_RUN_REJECTED',
        'large-BOM checkpoint apply job cannot be run from this status',
        { status: safeEvidenceToken(job.status, 'status') || undefined },
        409,
      )
    }
    const plan = isPlainObject(job.plan) && Array.isArray(job.plan.decisions) ? job.plan : null
    if (!plan) {
      throw new StockPreparationLargeBomJobError(
        'LARGE_BOM_APPLY_PLAN_INVALID',
        'large-BOM checkpoint apply job is missing a private conflict plan',
        { planPresent: false },
      )
    }
    const chunkSize = normalizeChunkSize(input.maxDecisionsPerChunk)
    const recordsApi = requireCheckpointRecordsApi(input.recordsApi)
    const start = nextDecisionIndex(job)
    const decisions = plan.decisions
    if (start >= decisions.length) {
      job.status = terminalApplyStatus(job.counts)
      job.updatedAt = isoNow(typeof input.now === 'function' ? input.now() : undefined)
      await storage.set(key, job)
      return cloneJson(job)
    }

    const runningAt = isoNow(typeof input.now === 'function' ? input.now() : undefined)
    job.status = 'running'
    job.updatedAt = runningAt
    await storage.set(key, job)

    const end = Math.min(start + chunkSize, decisions.length)
    const chunkPlan = {
      ...plan,
      decisions: decisions.slice(start, end).map(cloneJson),
    }
    const applyResult = await applyStockPreparationPlan({
      permission: job.permission,
      plan: chunkPlan,
      target: job.target,
      template: job.template,
      // Same OPTIONAL projection the plan was built from. Threading it here too keeps
      // the human wall extended at WRITE time and not only at plan time — a chunked
      // apply must not be the one path where a pack `ext_` human column slips through.
      installedFieldProperties: input.installedFieldProperties,
      recordsApi,
    })

    job.counts = mergeCounts(job.counts, applyResult.counts)
    mergeApplyEvidence(job, applyResult)
    job.checkpoint = {
      nextDecisionIndex: end,
      completedChunks: completedChunks(job) + 1,
    }
    job.status = end >= decisions.length ? terminalApplyStatus(job.counts) : 'paused'
    job.updatedAt = isoNow(typeof input.now === 'function' ? input.now() : undefined)
    await storage.set(key, job)
    return cloneJson(job)
  } finally {
    release()
  }
}

async function planLargeBomBackgroundExpansionJob(input = {}) {
  const storage = ensureDurableJobStorage(input.storage)
  const key = backgroundJobKey(input)
  const job = await storage.get(key)
  if (!job) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_NOT_FOUND',
      'large-BOM background expansion job was not found',
      { jobIdPresent: Boolean(optionalString(input.jobId)) },
      404,
    )
  }
  assertAuthoritativeLargeBomExpansion(job)
  const artifact = isPlainObject(job.artifact) ? job.artifact : {}
  const expandedRows = Array.isArray(artifact.rows) ? artifact.rows.map(cloneJson) : []
  const existingRows = normalizeExistingRows(input.existingRows)
  const conflictPolicyReview = isPlainObject(input.conflictPolicyReview) ? cloneJson(input.conflictPolicyReview) : undefined
  const plan = planStockPreparationConflicts({
    template: job.actionSnapshot && job.actionSnapshot.template,
    conflictStrategy: job.actionSnapshot && job.actionSnapshot.conflictStrategy,
    expandedRows,
    existingRows,
    rowErrors: [],
    runId: input.runId || `large-bom:${job.jobId}`,
    plannedAt: input.plannedAt,
    duplicatePolicyReview: conflictPolicyReview,
    // OPTIONAL pack-aware ownership projection, threaded (never fetched — this module
    // does no field I/O). Omitted => the frozen-template bands, i.e. today's behaviour.
    installedFieldProperties: input.installedFieldProperties,
    // F1c/F1c-b: same DECLARED extension band as the interactive path, taken from the job's stored
    // action snapshot (`cloneJson(action)`) — a background apply must fill the same FIVE pack
    // columns an interactive one does (F1c: 当前组件排序号 / 父组件排序号 / 名称及规格; F1c-b:
    // 父组件图号 / 父组件名称), or one project would carry different columns depending on how big
    // its BOM is.
    //
    // DECLARED, NOT YET LANDED on this path. The declaration below is one of two halves; the other
    // is `installedFieldProperties` just above, and the large-BOM HTTP routes do not pass it
    // (`resolveInstalledFieldProperties` appears only on the interactive routes) — so the band this
    // module plans against is template-only and `pickFields` leaves every `ext_` id outside it.
    // Today a project that goes down the background path therefore still gets NONE of the five
    // columns on its sheet; the tests here prove the planner-level wiring, not the route. Wiring
    // that route is an owner item (F1c's pre-existing gap, carried into F1c-b).
    extensionFieldIds: job.actionSnapshot && job.actionSnapshot.extensionFieldIds,
    // W4 carry: threaded from the job's stored action snapshot (cloneJson of the
    // normalized deploy config). Absent => byte-identical pre-wiring planning.
    carryPolicy: job.actionSnapshot && job.actionSnapshot.carryPolicy,
  })
  const revision = largeBomPlanRevision({ job, plan, existingRows, conflictPolicyReview })
  job.planRevision = revision
  job.planArtifact = {
    revision,
    artifactRevision: job.artifactRevision || artifact.revision,
    plan: cloneJson(plan),
    existingRowCount: existingRows.length,
    plannedAt: plan.plannedAt,
  }
  job.planEvidence = summarizeConflictPlanForEvidence(plan)
  job.updatedAt = isoNow(typeof input.now === 'function' ? input.now() : undefined)
  await storage.set(key, job)
  return cloneJson(job)
}

function summarizeLargeBomBackgroundExpansionJobForEvidence(job = {}) {
  if (!isPlainObject(job)) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_INVALID',
      'background expansion job must be an object',
      { field: 'job' },
    )
  }
  const evidence = isPlainObject(job.evidence) ? job.evidence : {}
  const status = normalizeStatus(job.status, LARGE_BOM_BACKGROUND_EXPANSION_STATUSES, 'status')
  const errorTypes = safeTokenList(evidence.errorTypes || job.errorTypes, 'errorTypes')
  const publicEvidence = {
    sourceKind: safeEvidenceToken(evidence.sourceKind || job.sourceKind, 'sourceKind') || undefined,
    readObjects: safeTokenList(evidence.readObjects || job.readObjects, 'readObjects'),
    errorTypes,
    scaleErrorTypes: errorTypes.filter((errorType) => LARGE_BOM_BOUNDED_ERROR_TYPES.includes(errorType)),
    readDiagnosticShapePresent: evidence.readDiagnosticShapePresent === true || job.readDiagnosticShapePresent === true,
  }
  // Conditional on the same rule as the stored stanza, so an evidence object
  // with neither stanza projects to the pre-feature key set. The route
  // (`publicBackgroundExpansionJob` -> `largeBomJobResponse`) spreads whatever
  // this returns, so nothing outside this module gates these keys.
  attachStoredDetailEvidence(publicEvidence, evidence, 'readFailures', readFailureEntry, hasAnyKey)
  attachStoredDetailEvidence(publicEvidence, evidence, 'errorDetails', errorDetailEntry, carriesObjectOrCauseClass)
  if (isPlainObject(job.planEvidence)) publicEvidence.plan = cloneJson(job.planEvidence)
  return {
    jobIdPresent: Boolean(optionalString(job.jobId)),
    actionId: safeEvidenceToken(job.actionId, 'actionId') || undefined,
    status,
    largeBom: true,
    authoritative: status === 'completed' && job.authoritative === true,
    artifactRevisionPresent: Boolean(optionalString(job.artifactRevision || (job.artifact && job.artifact.revision))),
    planRevisionPresent: Boolean(optionalString(job.planRevision || (job.planArtifact && job.planArtifact.revision))),
    projectNoPresent: job.projectNoPresent === true,
    progress: nonNegativeProjection(job.progress, BACKGROUND_PROGRESS_FIELDS),
    budgets: budgetProjection(job.budgets, BACKGROUND_BUDGET_FIELDS),
    evidence: publicEvidence,
  }
}

function isAuthoritativeLargeBomExpansion(job = {}) {
  if (!isPlainObject(job)) return false
  return job.status === 'completed' &&
    job.authoritative === true &&
    Boolean(optionalString(job.artifactRevision || (job.artifact && job.artifact.revision)))
}

function assertAuthoritativeLargeBomExpansion(job = {}) {
  if (!isAuthoritativeLargeBomExpansion(job)) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_ARTIFACT_NOT_AUTHORITATIVE',
      'large-BOM apply requires a completed authoritative expansion artifact',
      {
        status: isPlainObject(job) ? optionalString(job.status) || undefined : undefined,
        authoritative: isPlainObject(job) ? job.authoritative === true : false,
        artifactRevisionPresent: isPlainObject(job)
          ? Boolean(optionalString(job.artifactRevision || (job.artifact && job.artifact.revision)))
          : false,
      },
    )
  }
  return job
}

function summarizeLargeBomCheckpointApplyJobForEvidence(job = {}) {
  if (!isPlainObject(job)) {
    throw new StockPreparationLargeBomJobError(
      'LARGE_BOM_JOB_INVALID',
      'checkpoint apply job must be an object',
      { field: 'job' },
    )
  }
  const evidence = isPlainObject(job.evidence) ? job.evidence : {}
  return {
    jobIdPresent: Boolean(optionalString(job.jobId)),
    status: normalizeStatus(job.status, LARGE_BOM_CHECKPOINT_APPLY_STATUSES, 'status'),
    planRevisionPresent: Boolean(optionalString(job.planRevision)),
    targetRevisionPresent: Boolean(optionalString(job.targetRevision)),
    approvalPresent: job.approvalPresent === true,
    counts: nonNegativeProjection(job.counts, APPLY_COUNT_FIELDS),
    evidence: {
      resultStatuses: safeTokenList(evidence.resultStatuses || job.resultStatuses, 'resultStatuses'),
      errorCodes: safeTokenList(evidence.errorCodes || job.errorCodes, 'errorCodes'),
      fieldCategories: safeTokenList(evidence.fieldCategories || job.fieldCategories, 'fieldCategories'),
    },
  }
}

module.exports = {
  LARGE_BOM_ARTIFACT_CHUNK_COUNT,
  LARGE_BOM_BACKGROUND_EXPANSION_STATUSES,
  LARGE_BOM_CHECKPOINT_APPLY_STATUSES,
  StockPreparationLargeBomJobError,
  cancelLargeBomBackgroundExpansionJob,
  createLargeBomBackgroundExpansionJob,
  createLargeBomCheckpointApplyJob,
  loadLargeBomBackgroundExpansionJob,
  loadLargeBomCheckpointApplyJob,
  planLargeBomBackgroundExpansionJob,
  publicBackgroundExpansionJob,
  publicCheckpointApplyJob,
  runLargeBomBackgroundExpansionJob,
  runLargeBomCheckpointApplyJobChunk,
  summarizeLargeBomBackgroundExpansionJobForEvidence,
  summarizeLargeBomCheckpointApplyJobForEvidence,
  isAuthoritativeLargeBomExpansion,
  assertAuthoritativeLargeBomExpansion,
  isAuthoritativeLargeBomPlan,
  assertAuthoritativeLargeBomPlan,
  __internals: {
    backgroundJobKey,
    checkpointApplyJobKey,
    effectiveExpansionBudgets,
    ensureDurableJobStorage,
    attachReadFailureEvidence,
    hashJson,
    LARGE_BOM_READ_FAILURE_DETAIL_LIMIT,
    safeEvidenceToken,
    safeTokenList,
    nonNegativeInteger,
    normalizeChunkSize,
    requireCheckpointRecordsApi,
  },
}
