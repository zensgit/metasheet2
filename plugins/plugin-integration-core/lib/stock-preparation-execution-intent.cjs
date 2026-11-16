'use strict'

// ---------------------------------------------------------------------------------------------------
// 备料 batch-refresh step 6a-1 (S6-1; register row R-91) — THE EXECUTION INTENT JOURNAL, pure.
//
// Design: step-6 design §3.2 (the journal), §3.5.1 (the classifier), as amended by the 2026-11-09 rebaseline (S6-1 (4):
// the band is the writer's own pack-aware derivation). Persisted by the refresh store's beginExecution (migration 106)
// in the SAME transaction as the execution row, before the first sheet write; read back by step 6a-2's recovery.
//
// WHAT AN ENTRY IS. One per ADD / UPDATE / INACTIVE decision of `plan.decisions` — the exact list the writer receives,
// the controlled update included; SKIP and MANUAL_CONFIRM get none:
//   { i: decision index, d: 'a' | 'u' | 'x', k: key digest, r: expected record id | null, v: expected version | null,
//     f: index into the chunk's field sets, pre: band digest of the expected row | null, post: band digest of the
//     decision's record / patch }
// `pre` is null for an ADD and for an UPDATE / INACTIVE whose key has no expected-record entry (the writer patches it
// unfenced; the classifier then never calls it `not_landed` by content).
//
// THE COMPARED BAND of an entry = the keys the decision writes (`record` for ADD, `patch` for UPDATE / INACTIVE) ∩ the
// writer's pack-aware plm band (`derivePackAwarePlmWritableFields`, the SAME derivation the writer's human wall uses)
// minus the RUN stamps (no business content; their date round-trip is unproven) and minus 批次标识's two band ids
// (register R-65: a band cell is never in a decision's record / patch — the writer adds it to the create leg after
// mapping — and never compared; excluded here by name as well, so no future band source can leak into a field set).
//
// VALUES-FREE BY CONSTRUCTION: key digests (domain-separated sha256, 32 hex), record-id handles, integers, schema
// field ids and 32-hex band digests. No cell value, key, part number or project number is ever in an entry.
//
// The module requires nothing that does IO and nothing from 批次标识's store (C-1); the band ids come from the frozen
// template module.
// ---------------------------------------------------------------------------------------------------

const crypto = require('node:crypto')

const {
  DECISIONS,
  EXISTING_ROW_RECORD_REF,
  RUN_FIELD_IDS,
  derivePackAwarePlmWritableFields,
} = require('./stock-preparation-conflict-planner.cjs')
const { STOCK_PREPARATION_PULL_BATCH_FIELD_IDS, normalizeStockPreparationTemplate, STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require('./stock-preparation-templates.cjs')
const pairing = require('./stock-preparation-continuation-pairing.cjs')

const { canonicalChangeValue } = pairing
const { canonicalJson } = pairing.__internals

const EXECUTION_INTENT_VERSION = 1
const INTENT_CHUNK_SIZE = 2000
const INTENT_SCHEMES = Object.freeze({
  key: 'stock-preparation/intent-key/v1',
  band: 'stock-preparation/intent-band/v1',
  intent: 'stock-preparation/execution-intent/v1',
})
const INTENT_DECISION_KINDS = Object.freeze({ [DECISIONS.ADD]: 'a', [DECISIONS.UPDATE]: 'u', [DECISIONS.INACTIVE]: 'x' })
const DIGEST_PATTERN = /^[0-9a-f]{32}$/
// §3.5.1 classes and results (S6-2 closes on them; `unprovable` is a report token, never stored).
const INTENT_ENTRY_CLASSES = Object.freeze(['landed', 'not_landed', 'diverged', 'duplicate', 'vanished', 'replaced'])
const INTENT_RESULTS = Object.freeze(['landed', 'nothing_landed', 'mixed', 'unprovable'])
const UNPROVABLE_REASONS = Object.freeze({ duplicate: 'duplicate_rows', vanished: 'record_vanished', replaced: 'record_replaced', diverged: 'diverged' })

class StockPreparationExecutionIntentError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'StockPreparationExecutionIntentError'
    this.status = 500
    this.code = 'STOCK_PREP_REFRESH_INPUT_INVALID'
    this.details = { ...details, partial: false }
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

/** The values-free handle of an idempotency key (the scheme of an entry's `k`). */
function intentKeyDigest(key) {
  return sha256(canonicalJson([INTENT_SCHEMES.key, String(key)])).slice(0, 32)
}

function templateFieldMapOf(template) {
  const normalized = normalizeStockPreparationTemplate(template || STOCK_PREPARATION_MAIN_TABLE_TEMPLATE)
  return { normalized, fields: new Map(normalized.fields.map((field) => [field.id, field])) }
}

/** The 32-hex digest of `src`'s cells over `fields` (sorted ids), each in the writer's canonical form. */
function bandDigest(src, fields, templateFields = new Map()) {
  const source = isPlainObject(src) ? src : {}
  const cells = fields.map((id) => [id, canonicalChangeValue(source[id], templateFields.get(id))])
  return sha256(canonicalJson({ scheme: INTENT_SCHEMES.band, cells })).slice(0, 32)
}

const EXCLUDED_FIELD_IDS = new Set([...RUN_FIELD_IDS, ...STOCK_PREPARATION_PULL_BATCH_FIELD_IDS])

/** The compared band of one decision: the keys it writes ∩ the pack-aware plm band, minus RUN and the 批次标识 band. */
function comparedFieldsOf(written, band) {
  return Object.keys(isPlainObject(written) ? written : {})
    .filter((id) => band.has(id) && !EXCLUDED_FIELD_IDS.has(id))
    .sort()
}

/** The writer's band (AW applyStockPreparationPlan): the pack-aware plm-writable ids of the normalized template. */
function intentBandOf({ template, installedFieldProperties } = {}) {
  const { normalized } = templateFieldMapOf(template)
  const ownership = derivePackAwarePlmWritableFields({ templateFields: normalized.fields, installedFieldProperties })
  return new Set(ownership.plmWritableFieldIds)
}

function intentDigestOf({ planDigest, chunks }) {
  return sha256(canonicalJson({
    scheme: INTENT_SCHEMES.intent,
    planDigest,
    chunks: chunks.map((chunk) => ({ entries: chunk.entries, fieldsets: chunk.fieldsets })),
  })).slice(0, 32)
}

/**
 * Build the journal of ONE execution from the IN-LEASE recompute (never a token or a preview, O-10):
 *   plan            the dry-run's plan (`plan.decisions`, the writer's list)
 *   planDigest      the execution row's plan digest (bound into the intent digest)
 *   expectedRecords the apply's `expectedRecordsOf(dryRun)` Map<key, { id, version, row }>
 *   template, installedFieldProperties   the writer's inputs (the band derivation)
 * Answers `{ version, digest, entryCount, chunks: [{ chunkIndex, entryCount, entries, fieldsets }] }` — frozen,
 * values-free. A decision without a usable key gets no entry (the writer fails it before any host call).
 */
function buildExecutionIntent({ plan, planDigest, expectedRecords, template, installedFieldProperties } = {}) {
  if (!isPlainObject(plan) || !Array.isArray(plan.decisions)) throw new StockPreparationExecutionIntentError('the intent needs the plan decisions', { field: 'plan' })
  if (typeof planDigest !== 'string' || planDigest.trim() === '') throw new StockPreparationExecutionIntentError('the intent needs the plan digest', { field: 'planDigest' })
  if (expectedRecords !== undefined && expectedRecords !== null && !(expectedRecords instanceof Map)) {
    throw new StockPreparationExecutionIntentError('expectedRecords must be a Map keyed by idempotency key', { field: 'expectedRecords' })
  }
  const expected = expectedRecords instanceof Map ? expectedRecords : new Map()
  const { fields: templateFields } = templateFieldMapOf(template)
  const band = intentBandOf({ template, installedFieldProperties })
  const flat = []
  plan.decisions.forEach((decision, index) => {
    if (!isPlainObject(decision)) return
    const kind = INTENT_DECISION_KINDS[decision.decision]
    if (!kind) return
    const key = typeof decision.idempotencyKey === 'string' ? decision.idempotencyKey.trim() : ''
    if (!key) return
    const written = kind === 'a' ? decision.record : decision.patch
    const fields = comparedFieldsOf(written, band)
    const ref = kind === 'a' ? null : expected.get(key) || null
    flat.push({
      i: index,
      d: kind,
      k: intentKeyDigest(key),
      r: ref ? ref.id : null,
      v: ref ? ref.version : null,
      fields,
      pre: ref ? bandDigest(ref.row, fields, templateFields) : null,
      post: bandDigest(written, fields, templateFields),
    })
  })
  const chunks = []
  for (let start = 0; start < flat.length; start += INTENT_CHUNK_SIZE) {
    const slice = flat.slice(start, start + INTENT_CHUNK_SIZE)
    const fieldsets = []
    const indexOf = new Map()
    const entries = slice.map((entry) => {
      const signature = entry.fields.join('\u0000')
      if (!indexOf.has(signature)) {
        indexOf.set(signature, fieldsets.length)
        fieldsets.push(entry.fields.slice())
      }
      return { i: entry.i, d: entry.d, k: entry.k, r: entry.r, v: entry.v, f: indexOf.get(signature), pre: entry.pre, post: entry.post }
    })
    chunks.push({ chunkIndex: chunks.length, entryCount: entries.length, entries, fieldsets })
  }
  return deepFreeze({
    version: EXECUTION_INTENT_VERSION,
    digest: intentDigestOf({ planDigest: planDigest.trim(), chunks }),
    entryCount: flat.length,
    chunks,
  })
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner)
    Object.freeze(value)
  }
  return value
}

const ENTRY_KEYS = Object.freeze(['d', 'f', 'i', 'k', 'post', 'pre', 'r', 'v'])

function validEntry(entry, fieldsetCount) {
  if (!isPlainObject(entry)) return false
  const keys = Object.keys(entry).sort()
  if (keys.length !== ENTRY_KEYS.length || keys.some((key, index) => key !== ENTRY_KEYS[index])) return false
  return Number.isSafeInteger(entry.i) && entry.i >= 0
    && ['a', 'u', 'x'].includes(entry.d)
    && typeof entry.k === 'string' && DIGEST_PATTERN.test(entry.k)
    && (entry.r === null || (typeof entry.r === 'string' && entry.r.trim() !== ''))
    && (entry.v === null || (Number.isSafeInteger(entry.v) && entry.v >= 1))
    && (entry.r === null) === (entry.v === null)
    && (entry.d !== 'a' || entry.r === null)
    && Number.isSafeInteger(entry.f) && entry.f >= 0 && entry.f < fieldsetCount
    && (entry.pre === null || (typeof entry.pre === 'string' && DIGEST_PATTERN.test(entry.pre)))
    && (entry.r !== null) === (entry.pre !== null)
    && typeof entry.post === 'string' && DIGEST_PATTERN.test(entry.post)
}

/**
 * The store's admission of a lane-supplied intent (beginExecution): the exact shape `buildExecutionIntent` answers, its
 * digest recomputed over `planDigest`. A mismatch is a lane defect: 500 STOCK_PREP_REFRESH_INPUT_INVALID, thrown before
 * any statement. Answers the validated `{ version, digest, entryCount, chunks }`.
 */
function assertExecutionIntent(intent, { planDigest } = {}) {
  const invalid = (field) => new StockPreparationExecutionIntentError('the execution intent is malformed', { field: `intent.${field}` })
  if (!isPlainObject(intent)) throw new StockPreparationExecutionIntentError('a governed begin needs its execution intent', { field: 'intent' })
  if (intent.version !== EXECUTION_INTENT_VERSION) throw invalid('version')
  if (typeof intent.digest !== 'string' || !DIGEST_PATTERN.test(intent.digest)) throw invalid('digest')
  if (!Array.isArray(intent.chunks)) throw invalid('chunks')
  let total = 0
  intent.chunks.forEach((chunk, index) => {
    if (!isPlainObject(chunk) || chunk.chunkIndex !== index || !Array.isArray(chunk.entries) || !Array.isArray(chunk.fieldsets)) throw invalid('chunks')
    if (chunk.entries.length < 1 || chunk.entries.length > INTENT_CHUNK_SIZE || chunk.entryCount !== chunk.entries.length) throw invalid('chunks.entryCount')
    if (!chunk.fieldsets.every((set) => Array.isArray(set) && set.every((id) => typeof id === 'string' && id !== '' && !EXCLUDED_FIELD_IDS.has(id)))) throw invalid('chunks.fieldsets')
    if (!chunk.entries.every((entry) => validEntry(entry, chunk.fieldsets.length))) throw invalid('chunks.entries')
    total += chunk.entries.length
  })
  if (intent.entryCount !== total) throw invalid('entryCount')
  if (typeof planDigest !== 'string' || intentDigestOf({ planDigest: planDigest.trim(), chunks: intent.chunks }) !== intent.digest) throw invalid('digest')
  return intent
}

// ── the classifier (§3.5.1; pure; S6-2's recovery runs it over the in-lease recompute's own read) ─────────────────

function recordIdOf(row) {
  const ref = row && row[EXISTING_ROW_RECORD_REF]
  return ref && typeof ref.id === 'string' ? ref.id : null
}

/**
 * Classify every entry against the sheet rows `rows` (logical rows, with the reader's record refs), then aggregate:
 *   all landed => landed; all not_landed (or zero entries) => nothing_landed; only landed + not_landed => mixed;
 *   anything else => unprovable, with `reasons` ⊂ { duplicate_rows, record_vanished, record_replaced, diverged }.
 * `landed` is decided by CONTENT equality on the compared band, never by key or record id alone (E08).
 * Values-free answer: per-entry classes keyed by decision index, the counts, the result and the reasons.
 */
function classifyExecutionIntent({ chunks, rows, template } = {}) {
  const { fields: templateFields } = templateFieldMapOf(template)
  const byKey = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = isPlainObject(row) && typeof row.idempotencyKey === 'string' ? row.idempotencyKey.trim() : ''
    if (!key) continue
    const digest = intentKeyDigest(key)
    if (!byKey.has(digest)) byKey.set(digest, [])
    byKey.get(digest).push(row)
  }
  const counts = { intended: 0, landed: 0, notLanded: 0, diverged: 0, duplicate: 0, vanished: 0, replaced: 0 }
  const classes = []
  for (const chunk of Array.isArray(chunks) ? chunks : []) {
    for (const entry of chunk.entries) {
      const fields = chunk.fieldsets[entry.f]
      const matched = byKey.get(entry.k) || []
      let cls
      if (matched.length >= 2) cls = 'duplicate'
      else if (entry.d === 'a') {
        if (matched.length === 0) cls = 'not_landed'
        else cls = bandDigest(matched[0], fields, templateFields) === entry.post ? 'landed' : 'diverged'
      } else if (matched.length === 0) cls = 'vanished'
      else if (entry.r !== null && recordIdOf(matched[0]) !== entry.r) cls = 'replaced'
      else {
        const now = bandDigest(matched[0], fields, templateFields)
        if (now === entry.post) cls = 'landed'
        else if (entry.pre !== null && now === entry.pre) cls = 'not_landed'
        else cls = 'diverged'
      }
      classes.push({ i: entry.i, d: entry.d, cls })
      counts.intended += 1
      counts[cls === 'not_landed' ? 'notLanded' : cls] += 1
    }
  }
  const reasons = []
  for (const cls of ['duplicate', 'vanished', 'replaced', 'diverged']) if (counts[cls] > 0) reasons.push(UNPROVABLE_REASONS[cls])
  let result
  if (reasons.length > 0) result = 'unprovable'
  else if (counts.landed === 0) result = 'nothing_landed'
  else if (counts.notLanded === 0) result = 'landed'
  else result = 'mixed'
  return deepFreeze({ result, counts, reasons, classes })
}

module.exports = {
  EXECUTION_INTENT_VERSION,
  INTENT_CHUNK_SIZE,
  INTENT_SCHEMES,
  INTENT_ENTRY_CLASSES,
  INTENT_RESULTS,
  StockPreparationExecutionIntentError,
  assertExecutionIntent,
  bandDigest,
  buildExecutionIntent,
  classifyExecutionIntent,
  intentBandOf,
  intentKeyDigest,
  __internals: {
    EXCLUDED_FIELD_IDS,
    comparedFieldsOf,
    intentDigestOf,
    validEntry,
  },
}
