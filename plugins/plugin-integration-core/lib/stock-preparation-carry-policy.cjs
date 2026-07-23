'use strict'

// General-prep-system P4 — cross-BATCH human-field CARRY policy for PLM
// stock-preparation refreshes (feasibility rev-2 §layer-1; review P2-3/P2-4
// 収窄+定死). Pure and write-free: it consumes the PREVIOUS batch's rows plus a
// single new ADD row and produces ONE closed-vocabulary carry decision for a
// later K2 confirm-write / apply step. It performs NO PLM read, NO MetaSheet
// write, NO route, NO external DB write, and NO K3 path. It NEVER emits a silent
// planner ADD carrying human-preserved fields (that would hit the conflict
// planner's assertNoHumanFields wall) and it NEVER performs a latest-createTime
// silent overwrite.
//
// ── The two policy axes (LOCKED semantics; pinned by the mutation battery) ──
// carryPolicy = { carryKey, manualRowReattach } is a CLOSED object.
//
//   carryKey is the SOLE driver of the three component mappings:
//     • 'idempotency_key' (default) → NO_CARRY. 1→1 same-key inheritance is
//       ALREADY free today: the conflict planner patches only plm_system fields
//       on an existing key and leaves human_preserved fields in place
//       (UPDATE-preserve). There is nothing to carry, so this path emits an
//       explicit NO_CARRY marker (reason: same_key_update_preserve).
//     • 'component_source_id' → cross-KEY carry. Among the previous batch's
//       REMOVED/INACTIVE rows (active === false — see precondition below) sharing
//       the new row's componentSourceId under a DIFFERENT idempotencyKey:
//         · 0 matches            → NO_CARRY (no_source_match)
//         · exactly 1 match      → CARRY_VIA_CONFIRM   (human fields carried, but
//                                    ONLY via a K2-style server-signed confirm
//                                    write — writeVia:'k2_confirm', never an ADD)
//                                    — subject to manualRowReattach, see below
//         · 2+ matches (1→N)     → MANUAL_CONFIRM (row-level hold). NEVER auto-pick,
//                                    NEVER latest-createTime silent overwrite.
//
//   manualRowReattach chooses between two SAFE emitted outcomes for the
//   SINGLE-match case ONLY — it can NEVER downgrade a real carry to a silent
//   ADD, and it never suppresses the 1→N hold:
//     • 'propose_confirm' (default) → CARRY_VIA_CONFIRM (propose the reattach,
//                            human confirms via K2). It is the default because
//                            opting into carryKey='component_source_id' is itself
//                            the opt-in to cross-key carry, and a proposal writes
//                            NOTHING without the human confirm — so it is exactly
//                            as fail-closed as a bare hold, just more useful (it
//                            carries sourceIdempotencyKey + carryFields).
//     • 'none'           → MANUAL_CONFIRM hold (surface the reattach for a human,
//                            propose nothing). Still safe: no ADD, no overwrite.
//   (A single match whose source row carries NO human-field values has nothing to
//    reattach and collapses to NO_CARRY:no_human_context — value-presence driven,
//    orthogonal to both axes.)
//
// ── PRECONDITION on prevBatchRows ──
// A carry SOURCE is a prior-batch row with active === false. The caller passes
// the previous batch's rows already annotated inactive for removed components
// (i.e. the rows the conflict planner's missing-from-PLM sweep marks INACTIVE).
// A still-active prior row is NOT a carry source: same-key survivors are the free
// UPDATE-preserve path; a re-keyed component is only a source once it is inactive.
//
// ── Values-free ──
// Emitted evidence carries system IDENTITY handles only (idempotencyKey,
// sourceIdempotencyKey, componentSourceId — the planner already emits
// idempotencyKey) plus human-field NAMES (the closed HUMAN_PRESERVED whitelist)
// and counts/booleans. It NEVER carries a human-field VALUE, a customer business
// value, or any free text.

const {
  HUMAN_PRESERVED_FIELD_IDS,
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  normalizeStockPreparationTemplate,
} = require('./stock-preparation-templates.cjs')
const { DECISIONS } = require('./stock-preparation-conflict-planner.cjs')

// Closed carry-key vocabulary. 'idempotency_key' is the default (no new behavior).
const CARRY_KEYS = Object.freeze(['idempotency_key', 'component_source_id'])

// Closed manual-row-reattach vocabulary. 'propose_confirm' is the default: a
// single-match carry is PROPOSED via a K2 confirm write (which writes nothing
// without the human confirm). 'none' downgrades a single match to a bare hold.
const MANUAL_ROW_REATTACH_MODES = Object.freeze(['none', 'propose_confirm'])

// Closed carry-decision vocabulary. CARRY_VIA_CONFIRM is UNIQUE to this module —
// it is NOT a conflict-planner DECISION and must never be routed as an ADD.
// MANUAL_CONFIRM is DELIBERATELY the planner's literal so the apply-writer's
// existing MANUAL_CONFIRM → held branch routes a carry hold to `held` with no
// apply-writer change (apply-writer.cjs:487).
const CARRY_DECISIONS = Object.freeze({
  NO_CARRY: 'no_carry',
  CARRY_VIA_CONFIRM: 'carry_via_confirm',
  MANUAL_CONFIRM: DECISIONS.MANUAL_CONFIRM,
})

// Closed reason vocabulary for NO_CARRY markers and for typed errors.
const CARRY_NO_CARRY_REASONS = Object.freeze([
  'same_key_update_preserve',
  'no_source_match',
  'no_human_context',
])

const CARRY_CONFLICT_TYPES = Object.freeze([
  'carry_ambiguous_component_source',
  'carry_reattach_requires_confirm',
  'carry_conflicting_source_content',
])
const CARRY_CONFLICT_TYPE_SET = new Set(CARRY_CONFLICT_TYPES)

const CARRY_POLICY_ERROR_REASONS = Object.freeze([
  'CARRY_POLICY_NOT_OBJECT',
  'UNKNOWN_CARRY_KEY',
  'UNKNOWN_MANUAL_ROW_REATTACH',
  'UNKNOWN_CARRY_POLICY_KEY',
  'NEW_ADD_ROW_INVALID',
  'MISSING_IDEMPOTENCY_KEY',
  'MISSING_COMPONENT_SOURCE_ID',
  'PREV_ROWS_INVALID',
  'HUMAN_FIELD_WHITELIST_DRIFT',
  'CARRY_CONFIRM_SHAPE_VIOLATION',
  'AMBIGUITY_MUST_HOLD',
  'UNSUPPORTED_DECISION',
  'UNKNOWN_CONFLICT_TYPE',
])

// The K2 confirm-write marker: a CARRY_VIA_CONFIRM decision is ONLY ever applied
// by a server-signed confirm write (confirm-writes precedent: confirmedBy/At are
// human_preserved fields the SERVICE stamps), never by the planner/apply ADD path.
const CARRY_WRITE_VIA = 'k2_confirm'

class StockPreparationCarryPolicyError extends Error {
  constructor(reason, message, details = {}) {
    super(message || reason)
    this.name = 'StockPreparationCarryPolicyError'
    this.reason = reason
    this.details = details
  }
}

// Runtime consumer of the frozen reason vocabulary: every reason this module can throw
// MUST be declared in CARRY_POLICY_ERROR_REASONS. A fail('SOME_NEW_REASON') that skips the
// vocabulary trips here instead of silently emitting an undeclared reason — so the closed
// vocabulary is fail-closed at runtime, not documentation-only.
const CARRY_POLICY_ERROR_REASON_SET = new Set(CARRY_POLICY_ERROR_REASONS)
function fail(reason, message, details) {
  if (!CARRY_POLICY_ERROR_REASON_SET.has(reason)) {
    // COARSE: do NOT echo the rejected reason value back — this future-protection layer
    // must not become a value-leak channel (round-5 review P3). Fixed token only.
    throw new Error(
      'stock-preparation-carry-policy internal: undeclared error reason ' +
        '(add it to the frozen CARRY_POLICY_ERROR_REASONS vocabulary)',
    )
  }
  throw new StockPreparationCarryPolicyError(reason, message, details)
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}

function keyOf(row) {
  return isPlainObject(row) && typeof row.idempotencyKey === 'string' && row.idempotencyKey.trim() !== ''
    ? row.idempotencyKey.trim()
    : null
}

function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  const leftSet = new Set(left)
  if (leftSet.size !== left.length) return false
  return right.every((value) => leftSet.has(value))
}

// Resolve the human-preserved whitelist from a template and fail closed on any
// drift from the frozen HUMAN_PRESERVED_FIELD_IDS (mirrors the planner's guard so
// carry can never operate on a stale/wider human-field set).
function resolveHumanFields(template) {
  const normalized = normalizeStockPreparationTemplate(template || STOCK_PREPARATION_MAIN_TABLE_TEMPLATE)
  const templateHumanFields = normalized.fields
    .filter((field) => field.ownership === 'human_preserved')
    .map((field) => field.id)
  const whitelist = HUMAN_PRESERVED_FIELD_IDS.slice()
  if (!sameStringSet(whitelist, templateHumanFields)) {
    fail('HUMAN_FIELD_WHITELIST_DRIFT', 'human field whitelist drifted from template', {
      field: 'template.fields',
    })
  }
  return whitelist
}

function normalizeCarryPolicy(input) {
  if (input === undefined || input === null) {
    return { carryKey: 'idempotency_key', manualRowReattach: 'propose_confirm' }
  }
  if (!isPlainObject(input)) {
    fail('CARRY_POLICY_NOT_OBJECT', 'carryPolicy must be a plain object', { field: 'carryPolicy' })
  }
  for (const key of Object.keys(input)) {
    if (key !== 'carryKey' && key !== 'manualRowReattach') {
      fail('UNKNOWN_CARRY_POLICY_KEY', `carryPolicy has unsupported key ${key}`, { field: key })
    }
  }
  const carryKey = input.carryKey === undefined ? 'idempotency_key' : input.carryKey
  if (!CARRY_KEYS.includes(carryKey)) {
    fail('UNKNOWN_CARRY_KEY', 'carryPolicy.carryKey is not a supported value', { field: 'carryKey' })
  }
  const manualRowReattach = input.manualRowReattach === undefined ? 'propose_confirm' : input.manualRowReattach
  if (!MANUAL_ROW_REATTACH_MODES.includes(manualRowReattach)) {
    fail('UNKNOWN_MANUAL_ROW_REATTACH', 'carryPolicy.manualRowReattach is not a supported value', {
      field: 'manualRowReattach',
    })
  }
  return { carryKey, manualRowReattach }
}

function normalizePrevBatchRows(rows) {
  if (rows === undefined || rows === null) return []
  if (!Array.isArray(rows)) {
    fail('PREV_ROWS_INVALID', 'prevBatchRows must be an array', { field: 'prevBatchRows' })
  }
  return rows.filter(isPlainObject)
}

function normalizeNewAddRow(row) {
  if (!isPlainObject(row)) {
    fail('NEW_ADD_ROW_INVALID', 'newAddRow must be a plain object', { field: 'newAddRow' })
  }
  const idempotencyKey = keyOf(row)
  if (!idempotencyKey) {
    fail('MISSING_IDEMPOTENCY_KEY', 'newAddRow must carry a non-blank idempotencyKey', {
      field: 'idempotencyKey',
    })
  }
  return row
}

// SOURCE selection: prior-batch rows that are inactive (active === false), share
// the new row's componentSourceId, and live under a DIFFERENT idempotencyKey
// (same-key is the free UPDATE-preserve path, never a cross-key carry).
// De-duplicated by idempotencyKey so a repeated source row is ONE match.
function findComponentSourceMatches(prevBatchRows, newAddRow, humanFields) {
  const targetId = String(newAddRow.componentSourceId)
  const targetKey = keyOf(newAddRow)
  const byKey = new Map()
  for (const row of prevBatchRows) {
    if (row.active !== false) continue
    if (isBlank(row.componentSourceId)) continue
    if (String(row.componentSourceId) !== targetId) continue
    const sourceKey = keyOf(row)
    if (!sourceKey || sourceKey === targetKey) continue
    if (!byKey.has(sourceKey)) byKey.set(sourceKey, [])
    byKey.get(sourceKey).push(row)
  }
  const humanValue = (row, field) => (isBlank(row[field]) ? null : String(row[field]))
  let conflicted = false
  const matches = []
  for (const rows of byKey.values()) {
    // A repeated source row under the SAME key is one match — BUT only if the rows
    // agree on the carried human fields. If two rows share a key yet carry DIFFERENT
    // human content, that is a genuine, order-dependent ambiguity that must HOLD —
    // never a silent pick of whichever came first (review P2).
    if (rows.length > 1) {
      const first = rows[0]
      const differs = rows.slice(1).some((row) =>
        (humanFields || []).some((field) => humanValue(row, field) !== humanValue(first, field)),
      )
      if (differs) conflicted = true
    }
    matches.push(rows[0])
  }
  return { matches, conflicted }
}

function presentHumanFields(row, humanFields) {
  return humanFields.filter((field) => !isBlank(row[field]))
}

// PURE branch selector — the load-bearing semantic. Returns a decision TYPE plus
// a reason; planCarry maps this to a concrete decision object. Exposed so the
// mutation battery can pin every branch directly.
function classifyCarry({ carryKey, manualRowReattach, matchCount, hasHumanContext }) {
  if (carryKey === 'idempotency_key') {
    return { decision: CARRY_DECISIONS.NO_CARRY, reason: 'same_key_update_preserve' }
  }
  // carryKey === 'component_source_id'
  if (matchCount === 0) {
    return { decision: CARRY_DECISIONS.NO_CARRY, reason: 'no_source_match' }
  }
  if (matchCount > 1) {
    // 1→N ambiguity: ALWAYS a row-level hold. Never auto-pick, never overwrite.
    return { decision: CARRY_DECISIONS.MANUAL_CONFIRM, conflictType: 'carry_ambiguous_component_source' }
  }
  // exactly one match
  if (manualRowReattach === 'propose_confirm') {
    if (!hasHumanContext) {
      return { decision: CARRY_DECISIONS.NO_CARRY, reason: 'no_human_context' }
    }
    return { decision: CARRY_DECISIONS.CARRY_VIA_CONFIRM }
  }
  // manualRowReattach === 'none': surface a hold, propose nothing (still safe).
  return { decision: CARRY_DECISIONS.MANUAL_CONFIRM, conflictType: 'carry_reattach_requires_confirm' }
}

function makeNoCarry(newAddRow, carryPolicy, reason) {
  return {
    decision: CARRY_DECISIONS.NO_CARRY,
    idempotencyKey: keyOf(newAddRow),
    carryKey: carryPolicy.carryKey,
    manualRowReattach: carryPolicy.manualRowReattach,
    reason,
    carry: false,
  }
}

function makeCarryViaConfirm(newAddRow, source, carryPolicy, carryFields) {
  const decision = {
    decision: CARRY_DECISIONS.CARRY_VIA_CONFIRM,
    idempotencyKey: keyOf(newAddRow),
    sourceIdempotencyKey: keyOf(source),
    componentSourceId: String(newAddRow.componentSourceId),
    carryKey: carryPolicy.carryKey,
    manualRowReattach: carryPolicy.manualRowReattach,
    carryFields: carryFields.slice(),
    writeVia: CARRY_WRITE_VIA,
    requiresConfirm: true,
    carry: true,
  }
  // Defense in depth: a mutated builder that dropped the confirm requirement or
  // smuggled human field values into an ADD-shaped record trips this at runtime.
  assertCarryViaConfirmShape(decision)
  return decision
}

function makeManualConfirm(newAddRow, carryPolicy, conflictType, matchCount) {
  // conflictType is a CLOSED vocabulary — an out-of-vocab value never surfaces.
  if (!CARRY_CONFLICT_TYPE_SET.has(conflictType)) {
    fail('UNKNOWN_CONFLICT_TYPE', 'manual_confirm conflictType is outside the frozen vocabulary', {})
  }
  return {
    decision: CARRY_DECISIONS.MANUAL_CONFIRM,
    idempotencyKey: keyOf(newAddRow),
    componentSourceId: String(newAddRow.componentSourceId),
    carryKey: carryPolicy.carryKey,
    manualRowReattach: carryPolicy.manualRowReattach,
    conflictSummary: { type: conflictType, matchCount },
    source: 'carry_policy',
    carry: false,
  }
}

// Load-bearing guard: a CARRY_VIA_CONFIRM decision MUST require a K2 confirm write
// and MUST NOT be an ADD-shaped record nor smuggle any human-field VALUE. This is
// the wall against the "silent-ADD of human fields" mutant.
function assertCarryViaConfirmShape(decision) {
  if (!isPlainObject(decision) || decision.decision !== CARRY_DECISIONS.CARRY_VIA_CONFIRM) {
    fail('CARRY_CONFIRM_SHAPE_VIOLATION', 'not a carry_via_confirm decision', {})
  }
  if (decision.requiresConfirm !== true) {
    fail('CARRY_CONFIRM_SHAPE_VIOLATION', 'carry_via_confirm must require a confirm write', {
      field: 'requiresConfirm',
    })
  }
  if (decision.writeVia !== CARRY_WRITE_VIA) {
    fail('CARRY_CONFIRM_SHAPE_VIOLATION', 'carry_via_confirm must be written via k2_confirm', {
      field: 'writeVia',
    })
  }
  if (Object.prototype.hasOwnProperty.call(decision, 'record')) {
    fail('CARRY_CONFIRM_SHAPE_VIOLATION', 'carry_via_confirm must not carry an ADD-shaped record', {
      field: 'record',
    })
  }
  for (const humanField of HUMAN_PRESERVED_FIELD_IDS) {
    if (Object.prototype.hasOwnProperty.call(decision, humanField)) {
      fail('CARRY_CONFIRM_SHAPE_VIOLATION', 'carry_via_confirm must not carry a human-field value', {
        field: humanField,
      })
    }
  }
  if (!Array.isArray(decision.carryFields)
    || decision.carryFields.some((field) => !HUMAN_PRESERVED_FIELD_IDS.includes(field))) {
    fail('CARRY_CONFIRM_SHAPE_VIOLATION', 'carryFields must be a subset of the human-preserved whitelist', {
      field: 'carryFields',
    })
  }
  return decision
}

// Load-bearing guard: a 1→N (matchCount > 1) situation MUST route to a hold, never
// to an auto-picked carry. This is the wall against the "1→N auto-pick" mutant.
function assertAmbiguityRoutedToHold(decision, matchCount) {
  if (matchCount > 1 && (!isPlainObject(decision) || decision.decision !== CARRY_DECISIONS.MANUAL_CONFIRM)) {
    fail('AMBIGUITY_MUST_HOLD', '1→N carry ambiguity must be a manual_confirm hold, never auto-pick', {
      matchCount,
    })
  }
  return decision
}

// Core entry point. Returns exactly ONE closed-vocabulary carry decision for the
// given new ADD row against the previous batch. Pure and write-free.
function planCarry(prevBatchRows, newAddRow, carryPolicy, options = {}) {
  const policy = normalizeCarryPolicy(carryPolicy)
  const row = normalizeNewAddRow(newAddRow)
  const humanFields = resolveHumanFields(options.template)

  if (policy.carryKey === 'idempotency_key') {
    // 1→1 same-key inheritance is already free via UPDATE-preserve — no carry.
    return makeNoCarry(row, policy, 'same_key_update_preserve')
  }

  // carryKey === 'component_source_id' — a cross-key carry requires a source id.
  if (isBlank(row.componentSourceId)) {
    fail('MISSING_COMPONENT_SOURCE_ID', 'component_source_id carry requires newAddRow.componentSourceId', {
      field: 'componentSourceId',
    })
  }

  const prev = normalizePrevBatchRows(prevBatchRows)
  const { matches, conflicted } = findComponentSourceMatches(prev, row, humanFields)
  const matchCount = matches.length
  // Same-key-conflicting-content ALWAYS holds, whatever the match count — a genuine
  // ambiguity is never resolved by input order (review P2).
  const single = matchCount === 1 && !conflicted ? matches[0] : null
  const carryFields = single ? presentHumanFields(single, humanFields) : []
  const hasHumanContext = carryFields.length > 0

  const classified = conflicted
    ? { decision: CARRY_DECISIONS.MANUAL_CONFIRM, conflictType: 'carry_conflicting_source_content' }
    : classifyCarry({
        carryKey: policy.carryKey,
        manualRowReattach: policy.manualRowReattach,
        matchCount,
        hasHumanContext,
      })

  let decision
  if (classified.decision === CARRY_DECISIONS.NO_CARRY) {
    decision = makeNoCarry(row, policy, classified.reason)
  } else if (classified.decision === CARRY_DECISIONS.CARRY_VIA_CONFIRM) {
    decision = makeCarryViaConfirm(row, single, policy, carryFields)
  } else if (classified.decision === CARRY_DECISIONS.MANUAL_CONFIRM) {
    decision = makeManualConfirm(row, policy, classified.conflictType, matchCount)
  } else {
    fail('UNSUPPORTED_DECISION', 'classifyCarry returned an unsupported decision', {
      decision: classified.decision,
    })
  }

  // Post-build invariant: a 1→N situation must be held, never auto-picked.
  assertAmbiguityRoutedToHold(decision, matchCount)
  return decision
}

module.exports = {
  CARRY_KEYS,
  MANUAL_ROW_REATTACH_MODES,
  CARRY_DECISIONS,
  CARRY_NO_CARRY_REASONS,
  CARRY_CONFLICT_TYPES,
  CARRY_POLICY_ERROR_REASONS,
  CARRY_WRITE_VIA,
  StockPreparationCarryPolicyError,
  normalizeCarryPolicy,
  classifyCarry,
  planCarry,
  __internals: {
    findComponentSourceMatches,
    presentHumanFields,
    resolveHumanFields,
    normalizePrevBatchRows,
    normalizeNewAddRow,
    makeNoCarry,
    makeCarryViaConfirm,
    makeManualConfirm,
    assertCarryViaConfirmShape,
    assertAmbiguityRoutedToHold,
    keyOf,
    isBlank,
    sameStringSet,
  },
}
