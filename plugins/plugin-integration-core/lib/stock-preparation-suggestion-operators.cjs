'use strict'

// P3 (general-prep-system line, feasibility doc 2026-07-21 rev-2, layer 1
// "suggestion 算子对"): pure suggestion OPERATORS for the stock-preparation
// scenario. Both operators emit SUGGESTION payloads only — they never write
// a human_preserved field and they never write anything at all (no DB, no
// routes, no side effects; a later slice wires the outputs):
//
//   - computeDemandDateCascade(...) targets the plm_system suggestion column
//     `suggestedDemandDate` (see the serial templates.cjs hook), NEVER the
//     human_preserved `demandDate` field. The result names its target via
//     `suggestionFieldId` so a caller cannot "accidentally" route it into the
//     human column without ignoring the contract.
//   - crossProjectPrefillCandidates(...) returns RANKED candidate human-field
//     sets from same-part history rows across projects. Candidates require an
//     explicit K2 confirm (confirm-writes style service countersign) before
//     any human_preserved field changes; even a single candidate is returned
//     as a ranked list of one, never as a pre-applied pick. Zero history
//     yields zero candidates — nothing is ever fabricated.
//
// Applying either payload directly to a human_preserved field is a charter
// violation (ownership wall; conflict-planner assertNoHumanFields). Both
// results carry applyMode 'k2_confirm_required' to make that machine-checkable.
//
// DOCUMENTED LIMITATION (by design; feasibility doc "明确不做"): the demand-date
// cascade uses PLAIN CALENDAR-DAY subtraction. There is NO holiday or workday
// calendar (formula NETWORKDAYS is 2-arg only today; a holidays-range variant
// is a deferred slice). A computed suggestion can land on a weekend or a
// holiday; that is expected, and it is precisely why the value is a suggestion
// requiring K2 confirm rather than an auto-applied date. v1 is also
// ROOT-ANCHORED and flat: every suggestion is rootDemandDate minus that row's
// own lead days — there is no per-parent chaining in this slice.
//
// Matching note: prefill matches identity-ish codes EXACTLY (trimmed, no case
// folding, no coercion). This deliberately does NOT reuse the common.cjs
// sameText family (see its scoping note: matching semantics differ per module
// and must not be silently migrated).

const { HUMAN_PRESERVED_FIELD_IDS } = require('./stock-preparation-templates.cjs')

const SUGGESTED_DEMAND_DATE_FIELD_ID = 'suggestedDemandDate'
const SUGGESTION_APPLY_MODE = 'k2_confirm_required'
const SUGGESTION_OPERATORS = Object.freeze(['demand_date_cascade', 'cross_project_prefill'])
const CASCADE_SKIP_REASONS = Object.freeze(['root_row', 'lead_days_missing', 'lead_days_invalid'])
const CASCADE_LEAD_DAYS_FIELDS = Object.freeze(['leadTimeDays'])
const PREFILL_MATCH_FIELDS = Object.freeze(['componentCode', 'plmDrawingNo'])
const PREFILL_RECENCY_FIELDS = Object.freeze(['lastPlmRefreshAt', 'confirmedAt', 'lastSyncedAt'])
const PREFILL_EXCLUSION_REASONS = Object.freeze(['self_row', 'record_id_missing', 'no_prefillable_values'])
// Closed ranking vocabulary. 'recency' (default) = the Java prep-field prefill
// behaviour (latest same-part row wins). 'field_presence' = the Java craft-plan
// reuse behaviour (most-COMPLETE plan wins, by non-empty human-field count) — the
// "最全方案复用" use-case the gallery pack documents. Both are deterministic total
// orders; ties fall through to the other signal then recordId.
const PREFILL_RANK_MODES = Object.freeze(['recency', 'field_presence'])
const MAX_LEAD_TIME_DAYS = 3650
const SUGGESTION_ERROR_REASONS = Object.freeze([
  'INPUT_SHAPE_INVALID',
  'ROOT_DEMAND_DATE_INVALID',
  'RECORD_ID_INVALID',
  'RECORD_ID_DUPLICATE',
  'LEAD_DAYS_FIELD_NOT_ALLOWED',
  'MATCH_FIELD_NOT_ALLOWED',
  'RECENCY_FIELD_NOT_ALLOWED',
  'HUMAN_FIELD_NOT_ALLOWED',
  'SUGGESTION_TARGET_NOT_SYSTEM_OWNED',
])

const DAY_MS = 24 * 60 * 60 * 1000
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
// Recency datetimes MUST carry an explicit zone designator: a naive local
// datetime would parse differently per host timezone and break determinism.
const ISO_DATETIME_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/
// Domain bound for plain dates: keeps calendar-day arithmetic (max lead
// MAX_LEAD_TIME_DAYS) inside 4-digit years by construction.
const MIN_DATE_YEAR = 1970
const MAX_DATE_YEAR = 9999

class StockPreparationSuggestionError extends Error {
  // details are values-free by contract: field NAMES, closed reasons, and
  // counts only — never raw row/tenant values (audit-surface discipline).
  constructor(message, reason, details = {}) {
    super(message)
    this.name = 'StockPreparationSuggestionError'
    this.reason = reason
    this.details = details
  }
}

function fail(message, reason, details) {
  throw new StockPreparationSuggestionError(message, reason, details)
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function parseIsoDateUtcMs(text) {
  if (typeof text !== 'string') return null
  const match = ISO_DATE_PATTERN.exec(text)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < MIN_DATE_YEAR || year > MAX_DATE_YEAR) return null
  const ms = Date.UTC(year, month - 1, day)
  const roundTrip = new Date(ms)
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() + 1 !== month ||
    roundTrip.getUTCDate() !== day
  ) {
    return null // rejects non-existent dates like 2026-02-30 instead of rolling them over
  }
  return ms
}

function formatIsoDateUtc(ms) {
  const date = new Date(ms)
  const year = String(date.getUTCFullYear()).padStart(4, '0')
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function parseRecencyMs(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  const dateMs = parseIsoDateUtcMs(trimmed)
  if (dateMs !== null) return dateMs
  if (!ISO_DATETIME_UTC_PATTERN.test(trimmed)) return null
  const ms = Date.parse(trimmed)
  return Number.isNaN(ms) ? null : ms
}

function normalizeMatchValue(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function normalizeRecordId(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

// Structural wall: the cascade target must be system-owned. If a future
// template revision ever declares `suggestedDemandDate` human_preserved, this
// module refuses to run rather than silently emitting a human-field write.
function assertSuggestionTargetIsSystemOwned() {
  if (HUMAN_PRESERVED_FIELD_IDS.includes(SUGGESTED_DEMAND_DATE_FIELD_ID)) {
    fail('suggestion target field must stay plm_system-owned', 'SUGGESTION_TARGET_NOT_SYSTEM_OWNED', {
      field: SUGGESTED_DEMAND_DATE_FIELD_ID,
    })
  }
}
assertSuggestionTargetIsSystemOwned()

function computeDemandDateCascade(rows, options) {
  assertSuggestionTargetIsSystemOwned()
  if (!Array.isArray(rows)) {
    fail('rows must be an array', 'INPUT_SHAPE_INVALID', { field: 'rows' })
  }
  if (!isPlainObject(options)) {
    fail('options must be a plain object', 'INPUT_SHAPE_INVALID', { field: 'options' })
  }
  const rootPredicate = options.rootPredicate
  if (typeof rootPredicate !== 'function') {
    fail('options.rootPredicate must be a function', 'INPUT_SHAPE_INVALID', { field: 'options.rootPredicate' })
  }
  const leadDaysField = options.leadDaysField === undefined ? 'leadTimeDays' : options.leadDaysField
  if (!CASCADE_LEAD_DAYS_FIELDS.includes(leadDaysField)) {
    fail('options.leadDaysField is outside the closed vocabulary', 'LEAD_DAYS_FIELD_NOT_ALLOWED', {
      field: 'options.leadDaysField',
    })
  }
  const rootMs = parseIsoDateUtcMs(options.rootDemandDate)
  if (rootMs === null) {
    // details stay values-free: no raw date text echoes into the error surface
    fail('options.rootDemandDate must be a valid YYYY-MM-DD date', 'ROOT_DEMAND_DATE_INVALID', {
      field: 'options.rootDemandDate',
    })
  }

  const seen = new Set()
  const suggestions = []
  const skipped = []
  const skip = (recordId, reason) => {
    skipped.push(Object.freeze({ recordId, reason }))
  }

  rows.forEach((row, index) => {
    if (!isPlainObject(row)) {
      fail('cascade row must be a plain object', 'INPUT_SHAPE_INVALID', { field: `rows[${index}]` })
    }
    const recordId = normalizeRecordId(row.recordId)
    if (recordId === null) {
      fail('cascade row must carry a non-empty recordId', 'RECORD_ID_INVALID', { field: `rows[${index}].recordId` })
    }
    if (seen.has(recordId)) {
      fail('cascade rows must have unique recordIds', 'RECORD_ID_DUPLICATE', { field: `rows[${index}].recordId` })
    }
    seen.add(recordId)
    if (rootPredicate(row)) {
      // The root row is the human-set anchor: it never receives a suggestion
      // derived from itself.
      skip(recordId, 'root_row')
      return
    }
    const lead = row[leadDaysField]
    if (lead === undefined || lead === null) {
      skip(recordId, 'lead_days_missing')
      return
    }
    // Fail-closed per row: no coercion of strings, no fractional days, no
    // negative or unbounded leads. A row we cannot trust gets NO suggestion.
    if (typeof lead !== 'number' || !Number.isInteger(lead) || lead < 0 || lead > MAX_LEAD_TIME_DAYS) {
      skip(recordId, 'lead_days_invalid')
      return
    }
    suggestions.push(
      Object.freeze({
        recordId,
        suggestedDemandDate: formatIsoDateUtc(rootMs - lead * DAY_MS),
      }),
    )
  })

  return Object.freeze({
    operator: 'demand_date_cascade',
    applyMode: SUGGESTION_APPLY_MODE,
    suggestionFieldId: SUGGESTED_DEMAND_DATE_FIELD_ID,
    rootDemandDate: formatIsoDateUtc(rootMs),
    suggestionCount: suggestions.length,
    skippedCount: skipped.length,
    suggestions: Object.freeze(suggestions),
    skipped: Object.freeze(skipped),
  })
}

function crossProjectPrefillCandidates(targetRow, historyRows, options) {
  if (!isPlainObject(targetRow)) {
    fail('targetRow must be a plain object', 'INPUT_SHAPE_INVALID', { field: 'targetRow' })
  }
  if (!Array.isArray(historyRows)) {
    fail('historyRows must be an array', 'INPUT_SHAPE_INVALID', { field: 'historyRows' })
  }
  if (!isPlainObject(options)) {
    fail('options must be a plain object', 'INPUT_SHAPE_INVALID', { field: 'options' })
  }
  const matchField = options.matchField === undefined ? 'componentCode' : options.matchField
  if (!PREFILL_MATCH_FIELDS.includes(matchField)) {
    fail('options.matchField is outside the closed vocabulary', 'MATCH_FIELD_NOT_ALLOWED', {
      field: 'options.matchField',
    })
  }
  const recencyField = options.recencyField === undefined ? 'lastPlmRefreshAt' : options.recencyField
  if (!PREFILL_RECENCY_FIELDS.includes(recencyField)) {
    fail('options.recencyField is outside the closed vocabulary', 'RECENCY_FIELD_NOT_ALLOWED', {
      field: 'options.recencyField',
    })
  }
  const rankBy = options.rankBy === undefined ? 'recency' : options.rankBy
  if (!PREFILL_RANK_MODES.includes(rankBy)) {
    fail('options.rankBy is outside the closed vocabulary', 'RANK_MODE_NOT_ALLOWED', {
      field: 'options.rankBy',
    })
  }
  const humanFields = options.humanFields
  if (!Array.isArray(humanFields) || humanFields.length === 0) {
    fail('options.humanFields must be a non-empty array', 'INPUT_SHAPE_INVALID', { field: 'options.humanFields' })
  }
  const humanSeen = new Set()
  humanFields.forEach((fieldId, index) => {
    // Ownership wall: prefill may ONLY ever propose human_preserved fields —
    // a plm_system field in the request is a caller bug and fails closed.
    if (typeof fieldId !== 'string' || !HUMAN_PRESERVED_FIELD_IDS.includes(fieldId)) {
      fail('options.humanFields entries must be human_preserved field ids', 'HUMAN_FIELD_NOT_ALLOWED', {
        field: `options.humanFields[${index}]`,
      })
    }
    if (humanSeen.has(fieldId)) {
      fail('options.humanFields must not repeat a field id', 'INPUT_SHAPE_INVALID', {
        field: `options.humanFields[${index}]`,
      })
    }
    humanSeen.add(fieldId)
  })

  const targetMatchValue = normalizeMatchValue(targetRow[matchField])
  const targetRecordId = normalizeRecordId(targetRow.recordId)
  const excludedCounts = { self_row: 0, record_id_missing: 0, no_prefillable_values: 0 }
  const matched = []
  const matchedIds = new Set()

  if (targetMatchValue !== null) {
    historyRows.forEach((row, index) => {
      if (!isPlainObject(row)) {
        fail('history row must be a plain object', 'INPUT_SHAPE_INVALID', { field: `historyRows[${index}]` })
      }
      const value = normalizeMatchValue(row[matchField])
      if (value === null || value !== targetMatchValue) return
      const recordId = normalizeRecordId(row.recordId)
      if (recordId === null) {
        // A candidate without provenance cannot be K2-confirmed — fail closed.
        excludedCounts.record_id_missing += 1
        return
      }
      if (targetRecordId !== null && recordId === targetRecordId) {
        excludedCounts.self_row += 1
        return
      }
      if (matchedIds.has(recordId)) {
        fail('matched history rows must have unique recordIds', 'RECORD_ID_DUPLICATE', {
          field: `historyRows[${index}].recordId`,
        })
      }
      matchedIds.add(recordId)
      const fieldValues = {}
      const presentFieldIds = []
      for (const fieldId of humanFields) {
        const fieldValue = row[fieldId]
        if (fieldValue === undefined || fieldValue === null) continue
        if (typeof fieldValue === 'string') {
          if (fieldValue.trim() === '') continue
        } else if (typeof fieldValue !== 'number' && typeof fieldValue !== 'boolean') {
          // Only scalar values are offerable; structured values are never
          // smuggled into a prefill candidate.
          continue
        }
        fieldValues[fieldId] = fieldValue
        presentFieldIds.push(fieldId)
      }
      if (presentFieldIds.length === 0) {
        // Never fabricate: a same-part row with nothing to prefill is not a
        // candidate.
        excludedCounts.no_prefillable_values += 1
        return
      }
      const recencyRaw = row[recencyField]
      const recencyMs = parseRecencyMs(recencyRaw)
      matched.push({
        recordId,
        recencyMs,
        recencyRaw: recencyMs === null ? null : recencyRaw.trim(),
        fieldValues,
        presentFieldIds,
      })
    })
  }

  // Deterministic total orders. compareRecency: most-recent first, missing/
  // unparseable recency last, ties by recordId ascending. field_presence layers
  // a most-complete-first primary key on top (non-empty human-field count desc),
  // then falls through to recency then recordId — so it is still a strict total
  // order and 'most-complete plan reuse' gets the fullest prior row.
  const compareRecency = (left, right) => {
    if (left.recencyMs !== null && right.recencyMs !== null && left.recencyMs !== right.recencyMs) {
      return right.recencyMs - left.recencyMs
    }
    if (left.recencyMs !== null && right.recencyMs === null) return -1
    if (left.recencyMs === null && right.recencyMs !== null) return 1
    if (left.recordId < right.recordId) return -1
    if (left.recordId > right.recordId) return 1
    return 0
  }
  matched.sort((left, right) => {
    if (rankBy === 'field_presence' && left.presentFieldIds.length !== right.presentFieldIds.length) {
      return right.presentFieldIds.length - left.presentFieldIds.length
    }
    return compareRecency(left, right)
  })

  const candidates = matched.map((entry, index) =>
    Object.freeze({
      rank: index,
      sourceRecordId: entry.recordId,
      sourceRecency: entry.recencyRaw,
      fieldValues: Object.freeze({ ...entry.fieldValues }),
      presentFieldIds: Object.freeze(entry.presentFieldIds.slice()),
    }),
  )

  return Object.freeze({
    operator: 'cross_project_prefill',
    applyMode: SUGGESTION_APPLY_MODE,
    matchField,
    recencyField,
    rankBy,
    humanFields: Object.freeze(humanFields.slice()),
    candidateCount: candidates.length,
    candidates: Object.freeze(candidates),
    excludedCounts: Object.freeze(excludedCounts),
  })
}

module.exports = {
  SUGGESTED_DEMAND_DATE_FIELD_ID,
  SUGGESTION_APPLY_MODE,
  SUGGESTION_OPERATORS,
  SUGGESTION_ERROR_REASONS,
  CASCADE_SKIP_REASONS,
  CASCADE_LEAD_DAYS_FIELDS,
  PREFILL_MATCH_FIELDS,
  PREFILL_RECENCY_FIELDS,
  PREFILL_RANK_MODES,
  PREFILL_EXCLUSION_REASONS,
  MAX_LEAD_TIME_DAYS,
  StockPreparationSuggestionError,
  computeDemandDateCascade,
  crossProjectPrefillCandidates,
  __internals: {
    DAY_MS,
    MIN_DATE_YEAR,
    MAX_DATE_YEAR,
    isPlainObject,
    parseIsoDateUtcMs,
    formatIsoDateUtc,
    parseRecencyMs,
    normalizeMatchValue,
    normalizeRecordId,
    assertSuggestionTargetIsSystemOwned,
  },
}
