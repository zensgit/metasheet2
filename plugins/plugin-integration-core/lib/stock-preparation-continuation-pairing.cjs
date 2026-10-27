'use strict'

// Batch-refresh step 4, PR-1 — THE CONTINUATION (沿用关系) PAIRING CORE. Pure and write-free.
//
// Design: the batch-refresh step-4 synthesis (2026-10-23, PR-1 row of its §17) §6 (planner projection,
// verification, detection, output), §9.2 (`sheetMachineDigest`), §10.1 (content-trigger fields); plan
// docs/development/takeover-beiliao-20260821/batch-refresh-merge-plan-20261022.md §3.1-3.4, §4, §9.
//
// WHAT IT IS. Everything the conflict planner needs to (a) keep a persisted continuation in force on
// every pull — ONE projection that yields both "do not ADD these new positions" and "do not sweep these
// old rows", built in one pass from the same member rows; (b) re-verify each continuation against the
// current read and name the first thing that no longer holds; (c) on pilot projects only, find every
// new overlap between an independently prepared old root and a new position of the same component, and
// every dropped order head without old rows, and turn each into a HOLD; (d) find content changes in the
// trigger fields. Plus the pure pieces later lanes share: the three fingerprints, the demand-facts
// projection of the #6502 recorder output, the trigger-field list with its cold-start rule, the hold
// fingerprint and the one machine-column digest the settlement and the export gate both use.
//
// WHAT IT IS NOT.
//   * Not wired. In PR-1 no caller passes the planner's `continuation` input; nothing here is reachable
//     from a route, a lane, a writer or a store. Absent input => the planner is byte-identical
//     (stock-preparation-continuation-golden.test.cjs pins it on a second-pull sheet).
//   * Not a reader and not a writer: no I/O, no clock, no randomness. Same input => same output.
//   * Not a customer-rule engine. Plan §10 Q1 (first pull with S and P), Q2 (S re-ordered alone; no-dash
//     hierarchy; sheet metal alone + in 总图) and Q6 (does a version change change the part id?) are NOT
//     answered here: every such shape is a hold WITHOUT a confirm control (design D-10 / Q-D). The ONLY
//     confirmable shape is the base shape: the old root was dropped by root selection (dash descendant, or
//     a 总图 of ANOTHER component not chosen) or its order head is absent from this read, exactly one new
//     position, a unique pairing, the seven items consistent, the evidence complete. Q6 is handled both
//     ways without choosing: a same-id version change is a CONTENT change, a changed part id is STRUCTURE.
//
// VALUES. Hold bodies (`detail`), pairs, items and demand facts carry customer values (keys, paths,
// component ids, quantities). They are PRIVATE: they may only travel to the plan's `holds` array, which
// never enters `summary`, `summarizeConflictPlanForEvidence`, dry-run evidence or any hash. Every public
// surface built here (`planContinuationSummary`, hold `subject`, fingerprints) is values-free: counts,
// closed tokens, continuation ids, record ids and sha256 digests.

const crypto = require('node:crypto')

const planner = require('./stock-preparation-conflict-planner.cjs')
const { isTenantExtensionField } = require('./stock-preparation-extension-namespace.cjs')
const {
  STOCK_PREPARATION_MAIN_TABLE_TEMPLATE,
  normalizeStockPreparationTemplate,
} = require('./stock-preparation-templates.cjs')
const { __internals: expansionInternals } = require('./stock-preparation-bom-expansion.cjs')

const {
  CHANGE_PLAN_UPDATE_TYPE,
  DECISIONS,
  DENORMALIZED_PLM_FIELD_IDS,
  EXISTING_ROW_RECORD_REF,
  LINEAGE_FIELD_IDS,
  RUN_FIELD_IDS,
  derivePackAwarePlmWritableFields,
} = planner
const {
  changedFields,
  fieldMapForTemplate,
  normalizeComparableValueForField,
  pickFields,
  valuesEqualForTemplateField,
  withDenormalizedPlmFields,
} = planner.__internals
const { makeIdempotencyKey } = expansionInternals

// ── vocabularies (closed; design §9.4) ────────────────────────────────────────────────────────────

const SCHEMES = Object.freeze({
  pairing: 'stock-preparation/continuation-pairing/v1',
  comparison: 'stock-preparation/continuation-comparison/v1',
  evidence: 'stock-preparation/continuation-evidence/v1',
  hold: 'stock-preparation/refresh-hold/v1',
  holdBody: 'stock-preparation/refresh-hold-body/v1',
  subject: 'stock-preparation/refresh-subject/v1',
  sheetMachine: 'stock-preparation/sheet-machine/v1',
  // Step 5 PR-8: the change plan's binding (record set + source content) and the reviewed content.
  changePlan: 'stock-preparation/change-plan/v1',
  changeContent: 'stock-preparation/change-content/v1',
})

const CONTINUATION_ERROR_CODES = Object.freeze({
  INPUT_INVALID: 'STOCK_PREP_CONTINUATION_INPUT_INVALID',
  STORE_FAILED: 'STOCK_PREP_REFRESH_STORE_FAILED',
  PROJECTION_INCONSISTENT: 'STOCK_PREP_CONTINUATION_PROJECTION_INCONSISTENT',
  POSTCONDITION_VIOLATED: 'STOCK_PREP_CONTINUATION_POSTCONDITION_VIOLATED',
  SHEET_DIGEST_RECORD_REF_MISSING: 'STOCK_PREP_SHEET_DIGEST_RECORD_REF_MISSING',
})

// The statuses a continuation passed to the planner may have. `ended` releases protection, so an ended
// row handed to the planner is a caller error (the store passes claim_active rows only).
const CONTINUATION_STATUSES = Object.freeze(['active', 'needs_reconfirmation'])

const CONTINUATION_VERDICTS = Object.freeze([
  'valid',
  'source_scope_changed',
  'new_position_removed',
  'new_position_occupied',
  'old_record_missing',
  'old_record_inactive',
  'old_record_replaced',
  'old_subtree_duplicate',
  'structure_changed',
  'demand_changed',
  'evidence_changed',
  'evidence_incomplete',
  'content_changed',
])

// Design §8.3 / D-19: the only verdicts a puller may re-confirm in phase 1.
const RECONFIRMABLE_REASONS = Object.freeze(['source_scope_changed', 'evidence_changed', 'evidence_incomplete'])

const HOLD_KINDS = Object.freeze([
  'continuation_candidate',
  'candidate_ambiguous',
  'candidate_target_occupied',
  'candidate_old_duplicate',
  'candidate_keyless_rows',
  'candidate_structure_differs',
  'candidate_incomplete_evidence',
  'candidate_content_differs',
  'candidate_shape_unresolved',
  'dropped_order_head_unresolved',
  'relationship_reconfirm',
  'relationship_content_change',
  'content_change',
  'structure_change',
])

// Design §9.4 plus ONE token (`dropped_other_rule`, see `classifyOldRootDemand`): a root dropped by a
// root-selection rule that is not one of the base-shape rules is an unresolved shape, never a candidate.
const SHAPE_TOKENS = Object.freeze([
  'old_root_still_ordered',
  'sheet_metal_dual',
  'no_dash_hierarchy',
  'root_selection_disabled',
  'parent_before_child',
  'dropped_other_rule',
])

const NOT_CONFIRMABLE_REASONS = Object.freeze([
  'specialist_repair',
  'ambiguous_pairing',
  'keyless_rows_present',
  'customer_rule_pending',
  'phase_2',
  'evidence_incomplete',
  'needs_step5',
  'reconfirm_not_admissible',
])

// Skip conflict types the governed planner emits (values-free; `continuationId` / `holdFingerprint`).
const CONTINUATION_SKIP_TYPES = Object.freeze({
  continued: 'continued_by_relationship',
  protected: 'protected_by_relationship',
  candidate: 'suspended_continuation_candidate',
})

// §10.1 — never content triggers.
const STRUCTURE_FIELD_IDS = Object.freeze(['projectNo', 'idempotencyKey', 'componentSourceId', 'parentSourceId', 'path', 'depth'])
const LIFECYCLE_FIELD_IDS = Object.freeze(['active'])
const DERIVED_LINEAGE_DISPLAY_FIELD_IDS = Object.freeze(['parentComponentCode', 'parentComponentName'])
const NON_TRIGGER_PACK_FIELD_IDS = Object.freeze(['ext_componentSortNo', 'ext_parentSortNo'])

// §6.6: the root-selection rules under which a dropped old root is the BASE shape.
const BASE_DROP_RULES = Object.freeze(['dash_descendant', 'main_drawing_not_chosen'])

// The #6502 recorder's observation-local exclusions: an incompleteness of THIS kind is attributable to
// one component, so it only matters when that component is relevant. Every other completeness reason
// (read failures, caps, truncated refs, unexplained root selection, a line with no component id) could
// have hidden ANY component and makes the whole read unusable for a comparison.
const ATTRIBUTABLE_EXCLUSIONS = Object.freeze(['quantity_invalid', 'part_missing', 'part_ambiguous', 'part_not_read'])

// The continuation input's closed key set (design §6.1, with the deviations stated in the PR body).
// `persistedHolds` (batch-refresh step 4 PR-3a, AMB-1 / TD-10): the consult's OPEN holds, field-picked by
// the lane to PERSISTED_HOLD_KEYS. REQUIRED (an array, possibly empty): a lane that forgot it would silently
// lose the pilot-exit protection those holds carry (detection runs only on pilot input, and a reconcile
// supersedes every open hold absent from the new set).
const CONTINUATION_INPUT_KEYS = Object.freeze([
  'storeState',
  'pilot',
  'projectNo',
  'continuations',
  'members',
  'demandEvidence',
  'sourceIdentity',
  'specSlotDeclared',
  'persistedHolds',
  'changePlan',
  // Step 5 PR-8 review fix N3 (C06): the content the reviews (round 2: the reviewed-cell register) and the pending written
  // plan left on the sheet.
  'expectedContent',
])

// The persisted-hold key set (PHK, defined once; the lane's `pickPersistedHold` and this validation both
// use it): the eleven hold-body fields the refresh store answers (`rowToHold`), `runbookOnly`, and
// `continuationRoots` — the root keys of the continuation the hold names (every status, ended included),
// attached by the lane so a runbook-only hold of an ENDED relationship can still protect its subtrees.
const PERSISTED_HOLD_KEYS = Object.freeze([
  'kind',
  'fingerprint',
  'confirmable',
  'notConfirmableReason',
  'shapeToken',
  'continuationId',
  'subject',
  'detail',
  'evidenceFingerprint',
  'comparisonFingerprint',
  'pairingFingerprint',
  'runbookOnly',
  'continuationRoots',
])

// Step 5 PR-8 review fix N3 (C06): the `detail.reason` of a content_change hold opened because a cell a review (or the
// pending written plan) left under a record key is no longer on the sheet while the source agrees with the sheet — the
// source and a host-side write moved together — or (round 2, N3-a) because the row under that key is gone while the
// source moved off the reviewed value. Detected for those keys pilot or not, so it is never re-emitted.
const REVIEWED_CONTENT_MOVED_REASON = 'reviewed_content_moved'

// Re-emission (AMB-1 / TD-10): the kinds only pilot DETECTION produces. After the pilot marker is cleared
// detection stops, so a persisted hold of one of these kinds is re-emitted VERBATIM (stored fingerprint)
// instead of being superseded by the next non-pilot computation.
function isPilotDetectionHoldKind(kind, detail) {
  if (kind === 'continuation_candidate' || kind === 'dropped_order_head_unresolved') return true
  if (typeof kind === 'string' && kind.startsWith('candidate_')) return true
  return kind === 'content_change' && isPlainObject(detail) && detail.reason === 'plm_system_refresh'
}

class StockPreparationContinuationError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'StockPreparationContinuationError'
    this.status = status
    this.code = code
    this.details = details
  }
}

// ── small pure helpers ────────────────────────────────────────────────────────────────────────────

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}

function nonBlankString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

// Key-sorted, `undefined`-skipping serialization: the canonical form every fingerprint here hashes.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .filter((entryKey) => value[entryKey] !== undefined)
      .sort()
      .map((entryKey) => `${JSON.stringify(entryKey)}:${canonicalJson(value[entryKey])}`)
      .join(',')}}`
  }
  return JSON.stringify(value === undefined ? null : value)
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

function fingerprintOf(scheme, body) {
  return sha256(canonicalJson({ scheme, body }))
}

// A values-free handle for a private value (component id, key): domain-separated sha256.
function subjectDigest(value) {
  return sha256(`${SCHEMES.subject}\0${String(value)}`)
}

function keyOf(row) {
  return isPlainObject(row) && nonBlankString(row.idempotencyKey) ? row.idempotencyKey : null
}

// TD-14 (O-4): a resolved duplicate group's key is `<base>::duplicate:<kind>:<hash>` (the conflict planner's
// `duplicateResolvedKey`). Every claim map here — the projection's two sets and the three candidate maps — is
// keyed by BASE keys (members and detection read raw expansion keys), so every lookup and the post-condition
// strip the suffix first; otherwise a resolved group at a continued or candidate position escapes suppression.
// ONE definition of the strip, owned by the module that mints the suffix (review round 1).
function baseKeyOf(key) {
  return planner.baseIdempotencyKeyOf(key)
}

function isActiveRow(row) {
  return isPlainObject(row) && row.active !== false
}

function isRootRow(row) {
  return isPlainObject(row) && isBlank(row.parentSourceId)
}

function compareStrings(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function sortedUnique(values) {
  return Array.from(new Set(values)).sort(compareStrings)
}

function countBy(values) {
  const out = {}
  for (const value of values) out[value] = (out[value] || 0) + 1
  return Object.fromEntries(Object.keys(out).sort().map((entryKey) => [entryKey, out[entryKey]]))
}

// The ONE reader of the record reference (design §6.5). `null` when the reader did not attach one (a
// flat-row host, a hand-built row): callers treat that as "cannot bind" and fail closed.
function recordRefOf(row) {
  const ref = isPlainObject(row) ? row[EXISTING_ROW_RECORD_REF] : undefined
  if (!ref || typeof ref !== 'object' || !nonBlankString(ref.id)) return null
  return { id: ref.id, version: Number.isInteger(ref.version) ? ref.version : null }
}

// ── paths and keys ────────────────────────────────────────────────────────────────────────────────

// A row's path tokens. The expander writes `path` as JSON.stringify(tokens) (stock-preparation-bom-
// expansion.cjs makePath); an array is accepted as-is. Anything else — unparseable, empty, a non-string
// token — is `null`, which every caller turns into a hold, never a throw out of the plan.
function pathTokensOf(row) {
  if (!isPlainObject(row)) return null
  let tokens = row.path
  if (typeof tokens === 'string') {
    try {
      tokens = JSON.parse(tokens)
    } catch {
      return null
    }
  }
  if (!Array.isArray(tokens) || tokens.length === 0) return null
  if (!tokens.every((token) => typeof token === 'string' && token !== '')) return null
  return tokens.slice()
}

function tokensStartWith(tokens, prefix) {
  if (!Array.isArray(tokens) || !Array.isArray(prefix) || tokens.length < prefix.length) return false
  for (let index = 0; index < prefix.length; index += 1) {
    if (tokens[index] !== prefix[index]) return false
  }
  return true
}

/**
 * The suffix of `tokens` after `rootTokens` (design §6.4); `[]` for the root itself, `null` when the row
 * is not in that subtree.
 */
function relativePath(tokens, rootTokens) {
  if (!tokensStartWith(tokens, rootTokens)) return null
  return tokens.slice(rootTokens.length)
}

function comparePaths(left, right) {
  if (left.length !== right.length) return left.length - right.length
  return compareStrings(JSON.stringify(left), JSON.stringify(right))
}

// The key the expander would mint for a position: its parent is the SECOND-TO-LAST token of its full
// path (BE `expandChildren`: `parentSourceId = parentRow.componentSourceId`, `childTokens =
// pathTokens.concat(child)`), not the continuation's new parent for every member — design §6.4 writes
// the subtree ROOT's case; this is the general one.
function expectedKeyForTokens(projectNo, tokens) {
  return makeIdempotencyKey(projectNo, tokens[tokens.length - 1], tokens.length > 1 ? tokens[tokens.length - 2] : null, tokens)
}

function expectedParentForTokens(tokens) {
  return tokens.length > 1 ? tokens[tokens.length - 2] : null
}

function keyPathTokens(key) {
  if (!nonBlankString(key)) return null
  try {
    const parsed = JSON.parse(key)
    return pathTokensOf({ path: isPlainObject(parsed) ? parsed.path : undefined })
  } catch {
    return null
  }
}

// ── pairing (design §6.4) ─────────────────────────────────────────────────────────────────────────

/**
 * Pair an old subtree with a new subtree by (relative path, component id). OCCURRENCE-EXACT: rows are
 * indexed by their full relative path, so a component repeated at two positions is two paths, and two
 * rows at one relative path are a multiset the pairing refuses (`path_repeated_*`) — never deduped and
 * never paired by "the first one". Every key is RECOMPUTED from the root tokens + relative path and
 * compared with the row's own key (old and new) — a mismatch is structure, never silently repaired.
 *
 * @returns {{ ok: boolean, problems: Array<{reason: string, side?: string}>, pairs: Array<object> }}
 *   `problems` carry closed reason tokens only; `pairs` (private) are sorted root-first.
 */
function pairSubtrees({ projectNo, oldRootTokens, newRootTokens, oldRows, newRows }) {
  const problems = []
  function index(rows, rootTokens, side) {
    const byPath = new Map()
    for (const row of Array.isArray(rows) ? rows : []) {
      const tokens = pathTokensOf(row)
      if (!tokens) {
        problems.push({ reason: 'path_unreadable', side })
        continue
      }
      const relative = relativePath(tokens, rootTokens)
      if (!relative) continue
      const pathKey = JSON.stringify(relative)
      if (!byPath.has(pathKey)) byPath.set(pathKey, { relative, rows: [] })
      byPath.get(pathKey).rows.push(row)
    }
    return byPath
  }
  const oldIndex = index(oldRows, oldRootTokens, 'old')
  const newIndex = index(newRows, newRootTokens, 'new')
  if (!oldIndex.has('[]') || !newIndex.has('[]')) problems.push({ reason: 'root_missing' })

  const relatives = new Map()
  for (const [pathKey, entry] of oldIndex.entries()) relatives.set(pathKey, entry.relative)
  for (const [pathKey, entry] of newIndex.entries()) relatives.set(pathKey, entry.relative)
  const ordered = Array.from(relatives.values()).sort(comparePaths)

  const pairs = []
  for (const relative of ordered) {
    const pathKey = JSON.stringify(relative)
    const oldEntry = oldIndex.get(pathKey)
    const newEntry = newIndex.get(pathKey)
    if (!oldEntry) {
      problems.push({ reason: 'path_only_new' })
      continue
    }
    if (!newEntry) {
      problems.push({ reason: 'path_only_old' })
      continue
    }
    if (oldEntry.rows.length !== 1) {
      problems.push({ reason: 'path_repeated_old' })
      continue
    }
    if (newEntry.rows.length !== 1) {
      problems.push({ reason: 'path_repeated_new' })
      continue
    }
    const oldRow = oldEntry.rows[0]
    const newRow = newEntry.rows[0]
    const oldTokens = oldRootTokens.concat(relative)
    const newTokens = newRootTokens.concat(relative)
    const componentSourceId = newTokens[newTokens.length - 1]
    if (oldTokens[oldTokens.length - 1] !== componentSourceId
      || oldRow.componentSourceId !== componentSourceId
      || newRow.componentSourceId !== componentSourceId) {
      problems.push({ reason: 'component_mismatch' })
      continue
    }
    const oldKey = keyOf(oldRow)
    const newKey = keyOf(newRow)
    if (!oldKey || !newKey) {
      problems.push({ reason: 'key_missing' })
      continue
    }
    if (oldKey !== expectedKeyForTokens(projectNo, oldTokens)) {
      problems.push({ reason: 'key_mismatch', side: 'old' })
      continue
    }
    if (newKey !== expectedKeyForTokens(projectNo, newTokens)) {
      problems.push({ reason: 'key_mismatch', side: 'new' })
      continue
    }
    if ((isBlank(newRow.parentSourceId) ? null : newRow.parentSourceId) !== expectedParentForTokens(newTokens)
      || (isBlank(oldRow.parentSourceId) ? null : oldRow.parentSourceId) !== expectedParentForTokens(oldTokens)) {
      problems.push({ reason: 'parent_mismatch' })
      continue
    }
    const ref = recordRefOf(oldRow)
    pairs.push({
      relativePath: relative.slice(),
      componentSourceId,
      root: relative.length === 0,
      oldRow,
      newRow,
      oldKey,
      newKey,
      oldRecordId: ref ? ref.id : null,
    })
  }
  return { ok: problems.length === 0, problems, pairs }
}

// ── the seven items (design §6.4, plan §3.2) ──────────────────────────────────────────────────────

// blankRule: 'declared' => a blank on EITHER side is `incomplete` (never "both empty => equal");
// 'undeclared' => both blank is `not_compared` (shown), otherwise compared; 'value' => blank is a value.
function sevenItemFields({ specSlotDeclared, nameAndSpecDeclared }) {
  const fields = [
    { item: 1, field: 'componentCode', blankRule: 'value' },
    { item: 2, field: 'componentName', blankRule: 'declared' },
    { item: 2, field: 'componentSpec', blankRule: specSlotDeclared === true ? 'declared' : 'undeclared' },
  ]
  if (nameAndSpecDeclared === true) fields.push({ item: 2, field: 'ext_nameAndSpec', blankRule: 'declared' })
  fields.push(
    { item: 3, field: 'material', blankRule: 'value' },
    { item: 4, field: 'sourceVersion', blankRule: 'value' },
    // 5: single-level usage — every edge INSIDE the subtree. The old root's rawQuantity is its ORDER
    //    quantity and the new root's is the parent edge: neither is compared (plan §3.2 单层用量).
    { item: 5, field: 'rawQuantity', blankRule: 'declared', excludeRoot: true },
    // 6: total demand — the old root's confirmed demand vs the new structure's derived root total, and
    //    every descendant's total.
    { item: 6, field: 'totalQuantity', blankRule: 'declared' },
  )
  return fields
}

function normalizedItemValue(value, field) {
  if (isBlank(value)) return null
  return normalizeComparableValueForField(value, field)
}

/**
 * Compare paired rows item by item. Item 7 (structure) is `pairSubtrees`' job and is not repeated here.
 *
 * @returns {{ outcome: 'match'|'content_change'|'incomplete', items: Array<object>, parentEdgeUsage: *,
 *             differingFields: string[], incompleteFields: string[], comparisonFingerprint: string }}
 */
function compareSevenItems({ pairs, templateFields = new Map(), specSlotDeclared = false, nameAndSpecDeclared = false }) {
  const fields = sevenItemFields({ specSlotDeclared, nameAndSpecDeclared })
  const items = []
  const differing = []
  const incomplete = []
  let parentEdgeUsage = null
  const canonical = []
  const canonicalStatuses = []
  for (const pair of pairs) {
    const entry = { relativePath: pair.relativePath.slice(), componentSourceId: pair.componentSourceId, root: pair.root, fields: {} }
    const canonicalEntry = { relativePath: pair.relativePath.slice(), componentSourceId: pair.componentSourceId, old: {}, new: {} }
    const statusEntry = {}
    for (const spec of fields) {
      const fieldMeta = templateFields.get(spec.field)
      const oldValue = pair.oldRow[spec.field]
      const newValue = pair.newRow[spec.field]
      if (spec.excludeRoot && pair.root) {
        parentEdgeUsage = normalizedItemValue(newValue, fieldMeta)
        entry.fields[spec.field] = { item: spec.item, status: 'excluded_root_order_quantity', old: oldValue === undefined ? null : oldValue, new: newValue === undefined ? null : newValue }
        statusEntry[spec.field] = 'excluded_root_order_quantity'
        continue
      }
      canonicalEntry.old[spec.field] = normalizedItemValue(oldValue, fieldMeta)
      canonicalEntry.new[spec.field] = normalizedItemValue(newValue, fieldMeta)
      const oldBlank = isBlank(oldValue)
      const newBlank = isBlank(newValue)
      let status
      if (spec.blankRule === 'declared' && (oldBlank || newBlank)) status = 'incomplete'
      else if (spec.blankRule === 'undeclared' && oldBlank && newBlank) status = 'not_compared_spec_undeclared'
      else if (oldBlank && newBlank) status = 'equal'
      else status = valuesEqualForTemplateField(oldValue, newValue, fieldMeta) ? 'equal' : 'differs'
      if (status === 'incomplete') incomplete.push(spec.field)
      if (status === 'differs') differing.push(spec.field)
      entry.fields[spec.field] = { item: spec.item, status, old: oldValue === undefined ? null : oldValue, new: newValue === undefined ? null : newValue }
      statusEntry[spec.field] = status
    }
    items.push(entry)
    canonical.push(canonicalEntry)
    canonicalStatuses.push({ ...canonicalEntry, statuses: statusEntry })
  }
  const outcome = incomplete.length > 0 ? 'incomplete' : (differing.length > 0 ? 'content_change' : 'match')
  return {
    outcome,
    items,
    // Normalized values + statuses, the form the evidence fingerprint hashes (a "2" read back as 2 does
    // not move it).
    canonicalItems: canonicalStatuses,
    parentEdgeUsage,
    differingFields: sortedUnique(differing),
    incompleteFields: sortedUnique(incomplete),
    // Human columns and RUN fields are structurally absent: only the item fields above are read.
    comparisonFingerprint: fingerprintOf(SCHEMES.comparison, { items: canonical }),
  }
}

function pairingFingerprintOf({ projectNo, oldRootKey, newRootKey, pairs }) {
  return fingerprintOf(SCHEMES.pairing, {
    projectNo,
    oldRootKey,
    newRootKey,
    pairs: pairs.map((pair) => ({
      relativePath: pair.relativePath,
      componentSourceId: pair.componentSourceId,
      oldKey: pair.oldKey,
      newKey: pair.newKey,
      oldRecordId: pair.oldRecordId,
    })),
  })
}

// Design §6.4: over the RELEVANT observations only (the members' components and the new parent) —
// never the whole-project demand-evidence fingerprint, so an unrelated part changing elsewhere does not
// re-ask this relationship (plan §4 「无关部件变化不使此关系重新询问」).
function evidenceFingerprintOf({ projectNo, pairs, comparison, demandFacts }) {
  return fingerprintOf(SCHEMES.evidence, {
    projectNo,
    members: pairs.map((pair, index) => ({
      relativePath: pair.relativePath,
      componentSourceId: pair.componentSourceId,
      oldKey: pair.oldKey,
      newKey: pair.newKey,
      items: comparison.canonicalItems[index] || null,
    })),
    parentEdgeUsage: comparison.parentEdgeUsage,
    demand: {
      oldRootOrderHeadPresence: demandFacts.oldRoot.orderHeadPresence,
      oldRootKeptAsRoot: demandFacts.oldRoot.keptAsRoot,
      newParentKeptAsRoot: demandFacts.newParent.keptAsRoot,
      relevantObservationDigests: demandFacts.relevantObservationDigests,
    },
  })
}

// ── the post-change pair (batch-refresh step 5 PR-8; design §10.3 (1), C04 / C11) ────────────────────
//
// What a relationship's comparison and evidence fingerprints WILL be once the controlled update has written the new
// side's values for every field the seven items say `differs` (and, for the subtree root, the derived root total into
// its single-level usage too — the S-root rule; the root's usage is outside both fingerprints anyway). A confirm stamps
// THIS pair on the relationship: before the write the next computation's content change is then the confirmed one
// (covered, no hold); after it the relationship verifies `valid` instead of `evidence_changed`. Same pairs, same
// normalisation and the same demand facts as the comparison it is derived from — so it equals what the verification
// computes after the write (pinned by the planner suite).
function postChangePairsOf(pairs, comparison) {
  const itemsByPath = new Map(comparison.items.map((item) => [JSON.stringify(item.relativePath), item]))
  return pairs.map((pair) => {
    const item = itemsByPath.get(JSON.stringify(pair.relativePath))
    const after = {}
    if (item && isPlainObject(item.fields)) {
      for (const [fieldId, cell] of Object.entries(item.fields)) {
        if (isPlainObject(cell) && cell.status === 'differs') after[fieldId] = pair.newRow[fieldId]
      }
    }
    if (pair.root && Object.prototype.hasOwnProperty.call(after, 'totalQuantity')) after.rawQuantity = pair.newRow.totalQuantity
    return { ...pair, oldRow: { ...pair.oldRow, ...after } }
  })
}

function postChangeFingerprintsOf({ projectNo, pairs, comparison, demandFacts, templateFields, specSlotDeclared, nameAndSpecDeclared }) {
  const postPairs = postChangePairsOf(pairs, comparison)
  const post = compareSevenItems({ pairs: postPairs, templateFields, specSlotDeclared, nameAndSpecDeclared })
  return Object.freeze({
    comparisonFingerprint: post.comparisonFingerprint,
    evidenceFingerprint: evidenceFingerprintOf({ projectNo, pairs: postPairs, comparison: post, demandFacts }),
  })
}

// ── demand facts (design §6.4, from the #6502 recorder) ────────────────────────────────────────────

function evidenceUsability(demandEvidence) {
  if (!isPlainObject(demandEvidence)) return { usable: false, reason: 'demand_evidence_absent', reasons: [] }
  const completeness = isPlainObject(demandEvidence.completeness) ? demandEvidence.completeness : {}
  const status = completeness.status
  if (status === 'capture_error') return { usable: false, reason: 'capture_error', reasons: [] }
  if (status === 'project_not_found') return { usable: false, reason: 'project_not_found', reasons: [] }
  if (status !== 'complete' && status !== 'incomplete') return { usable: false, reason: 'completeness_unknown', reasons: [] }
  if (!Array.isArray(demandEvidence.observations)) return { usable: false, reason: 'observations_absent', reasons: [] }
  const reasons = Array.isArray(completeness.reasons) ? completeness.reasons.filter((entry) => typeof entry === 'string') : []
  const nonAttributable = reasons.filter((entry) => !ATTRIBUTABLE_EXCLUSIONS.includes(entry))
  if (status === 'incomplete' && (nonAttributable.length > 0 || reasons.length === 0)) {
    return { usable: false, reason: 'incomplete_read', reasons: sortedUnique(nonAttributable) }
  }
  return { usable: true, reason: null, reasons: [] }
}

function observationsFor(demandEvidence, componentSourceId) {
  if (!isPlainObject(demandEvidence) || !Array.isArray(demandEvidence.observations)) return []
  return demandEvidence.observations.filter((observation) => isPlainObject(observation) && observation.componentSourceId === componentSourceId)
}

function numericLineOrder(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return null
}

function isBaseDrop(observation) {
  if (observation.decision !== 'dropped' || !BASE_DROP_RULES.includes(observation.rule)) return false
  if (observation.rule === 'main_drawing_not_chosen') {
    return isPlainObject(observation.ruleDetail) && observation.ruleDetail.sameComponentAsChosen === false
  }
  return true
}

function componentDemand(demandEvidence, componentSourceId, usable) {
  const all = observationsFor(demandEvidence, componentSourceId)
  const order = all.filter((observation) => observation.source === 'order')
  const selected = order.filter((observation) => observation.decision === 'selected')
  const dropped = order.filter((observation) => observation.decision === 'dropped')
  const quantities = selected.map((observation) => observation.orderQuantity).filter((value) => typeof value === 'number')
  return {
    componentSourceId,
    orderLines: order.length,
    selected: selected.length,
    dropped: dropped.length,
    keptAsRoot: selected.length > 0,
    rules: sortedUnique(order.map((observation) => observation.rule).filter((rule) => typeof rule === 'string')),
    baseDropsOnly: dropped.length > 0 && dropped.every(isBaseDrop) && selected.length === 0 && dropped.length === order.length,
    orderHeadPresence: order.length > 0 ? 'present' : (usable ? 'absent' : 'unknown'),
    orderQuantity: quantities.length === 1 ? quantities[0] : null,
    lineOrders: selected.map((observation) => numericLineOrder(observation.lineOrder)),
    localIncomplete: all.some((observation) => ATTRIBUTABLE_EXCLUSIONS.includes(observation.exclusion)),
  }
}

/**
 * The demand facts one candidate / continuation needs, projected from `expansion.demandEvidence` (the
 * #6502 recorder; PRIVATE — it carries order quantities). `classification` is what the base-shape rule
 * reads:
 *   incomplete          the read cannot answer (recorder absent / capture_error / a non-attributable gap /
 *                       a relevant line excluded) — never "same";
 *   kept                the old root's component is a SELECTED root in this read (plan §10 Q2 shape);
 *   base_head_absent    no order line for it in this read (shown as such, never as "cancelled", A07);
 *   base_dropped        every line for it was dropped by a base-shape rule;
 *   dropped_other_rule  dropped by any other rule (e.g. 总图 mode's not_main_or_sheet_metal) — unresolved.
 */
function projectDemandFacts(demandEvidence, { oldRootComponentSourceId, newParentComponentSourceId, memberComponentSourceIds = [] } = {}) {
  const usability = evidenceUsability(demandEvidence)
  const usable = usability.usable
  const oldRoot = componentDemand(demandEvidence, oldRootComponentSourceId, usable)
  const newParent = componentDemand(demandEvidence, newParentComponentSourceId, usable)
  const relevant = new Set([oldRootComponentSourceId, newParentComponentSourceId, ...memberComponentSourceIds].filter(nonBlankString))
  const relevantObservations = isPlainObject(demandEvidence) && Array.isArray(demandEvidence.observations)
    ? demandEvidence.observations.filter((observation) => isPlainObject(observation) && relevant.has(observation.componentSourceId))
    : []
  const relevantLocalIncomplete = relevantObservations.some((observation) => ATTRIBUTABLE_EXCLUSIONS.includes(observation.exclusion))
  const relevantComplete = usable && !relevantLocalIncomplete
  let classification
  if (!relevantComplete) classification = 'incomplete'
  else if (oldRoot.keptAsRoot) classification = 'kept'
  else if (oldRoot.orderLines === 0) classification = 'base_head_absent'
  else if (oldRoot.baseDropsOnly) classification = 'base_dropped'
  else classification = 'dropped_other_rule'
  return {
    available: isPlainObject(demandEvidence),
    completenessStatus: isPlainObject(demandEvidence) && isPlainObject(demandEvidence.completeness) ? demandEvidence.completeness.status || null : null,
    unusableReason: usability.reason,
    relevantComplete,
    classification,
    history: 'history_unknown',
    oldRoot,
    newParent,
    subTokens: keptShapeSubTokens(demandEvidence, oldRoot, newParent),
    relevantObservationDigests: sortedUnique(relevantObservations.map((observation) => observation.digest).filter(nonBlankString)),
  }
}

// Sub-tokens of `old_root_still_ordered`, read off the recorder rule that KEPT the old root.
function keptShapeSubTokens(demandEvidence, oldRoot, newParent) {
  if (!oldRoot.keptAsRoot) return []
  const tokens = []
  const selectedRules = observationsFor(demandEvidence, oldRoot.componentSourceId)
    .filter((observation) => observation.source === 'order' && observation.decision === 'selected')
    .map((observation) => observation.rule)
  if (selectedRules.includes('sheet_metal')) tokens.push('sheet_metal_dual')
  if (selectedRules.includes('not_dash_descendant') || selectedRules.includes('no_main_drawing_keep_all')) tokens.push('no_dash_hierarchy')
  if (selectedRules.includes('root_selection_disabled')) tokens.push('root_selection_disabled')
  if (newParent.keptAsRoot) {
    const parentFirst = newParent.lineOrders.filter((value) => value !== null)
    const childOrders = oldRoot.lineOrders.filter((value) => value !== null)
    if (parentFirst.length > 0 && childOrders.length > 0 && Math.min(...parentFirst) < Math.min(...childOrders)) tokens.push('parent_before_child')
  }
  return sortedUnique(tokens)
}

// ── content-trigger fields (design §10.1) ─────────────────────────────────────────────────────────

/**
 * The fields whose change is a CONTENT change (plan §3.4 实施细则 1): the pack-aware plm_system writable
 * band (already minus RUN fields) minus structure/identity keys, lifecycle (`active`), derived lineage
 * display, and the pack sort-number columns. Derived from ownership metadata, never from a list a caller
 * hands in.
 */
function contentTriggerFieldIds({ template, installedFieldProperties } = {}) {
  const normalized = normalizeStockPreparationTemplate(template || STOCK_PREPARATION_MAIN_TABLE_TEMPLATE)
  const excluded = new Set([...STRUCTURE_FIELD_IDS, ...LIFECYCLE_FIELD_IDS, ...DERIVED_LINEAGE_DISPLAY_FIELD_IDS, ...NON_TRIGGER_PACK_FIELD_IDS])
  return derivePackAwarePlmWritableFields({ templateFields: normalized.fields, installedFieldProperties })
    .plmWritableFieldIds
    .filter((fieldId) => !excluded.has(fieldId))
}

// Cold-start rule: for denormalized columns (PL DENORMALIZED_PLM_FIELD_IDS — componentSpec included) and
// pack `ext_` columns a blank -> value transition is a FIRST FILL (the planner backfills them onto old
// rows), not a change; value -> other value (or value -> blank) is. For the core seven-item fields any
// difference, blank -> value included, is a trigger.
function isColdStartExempt(fieldId) {
  return DENORMALIZED_PLM_FIELD_IDS.includes(fieldId) || isTenantExtensionField(fieldId)
}

/**
 * The trigger fields that changed between an existing row and the incoming one, with the cold-start
 * rule applied. Only fields the intake actually provides are compared (`changedFields`, X6).
 */
function contentTriggerChanges(nextRow, existingRow, { triggerFieldIds, templateFields = new Map() }) {
  return changedFields(nextRow, existingRow, triggerFieldIds, templateFields)
    .filter((fieldId) => !(isColdStartExempt(fieldId) && isBlank(existingRow[fieldId]) && !isBlank(nextRow[fieldId])))
}

// ── machine-column digest (design §9.2) ───────────────────────────────────────────────────────────

/**
 * The machine band the settlement digest covers: content triggers + lineage + lifecycle + depth + the
 * derived parent display columns + the key itself. RUN fields are excluded (they move on every apply);
 * human columns are structurally absent, so a person filling a cell never moves the digest.
 */
function machineBandFieldIds({ template, installedFieldProperties } = {}) {
  return sortedUnique([
    ...contentTriggerFieldIds({ template, installedFieldProperties }),
    ...LINEAGE_FIELD_IDS,
    'idempotencyKey',
    'active',
    'depth',
    ...DERIVED_LINEAGE_DISPLAY_FIELD_IDS,
  ])
}

/**
 * THE ONE digest over a project's rows as `readExistingStockPreparationRows` returned them (record id +
 * machine band). The settlement and the export gate must both feed it rows from that reader (design
 * §9.2): never the export's own projection. A row without a record reference cannot be bound and
 * refuses (fail closed) rather than digesting as "no id".
 */
function sheetMachineDigest(rows, { machineFieldIds }) {
  if (!Array.isArray(machineFieldIds) || machineFieldIds.length === 0) {
    throw new StockPreparationContinuationError(500, CONTINUATION_ERROR_CODES.INPUT_INVALID, 'machineFieldIds must be a non-empty array')
  }
  const band = sortedUnique(machineFieldIds)
  const entries = (Array.isArray(rows) ? rows : []).map((row) => {
    const ref = recordRefOf(row)
    if (!ref) {
      throw new StockPreparationContinuationError(500, CONTINUATION_ERROR_CODES.SHEET_DIGEST_RECORD_REF_MISSING, 'every row must carry its record reference')
    }
    return [ref.id, pickFields(row, band)]
  })
  entries.sort((left, right) => compareStrings(left[0], right[0]) || compareStrings(canonicalJson(left[1]), canonicalJson(right[1])))
  return fingerprintOf(SCHEMES.sheetMachine, { band, rows: entries })
}

// ── the projection (design §6.2) ──────────────────────────────────────────────────────────────────

function projectionInconsistent(message, details = {}) {
  return new StockPreparationContinuationError(500, CONTINUATION_ERROR_CODES.PROJECTION_INCONSISTENT, message, details)
}

/**
 * ONE pass over the members, TWO sets, three consumers (the planner's ADD branch, its sweep, its carry
 * source pool — and, stricter than the design, the refresh branch: a continued key never receives ANY
 * write decision). Every member contributes to every map; the cardinality assertion makes a corrupted
 * member row (a duplicated key / record id, a member of an unknown or ended continuation, a member count
 * that disagrees with its header) refuse the plan instead of half-protecting.
 */
function buildContinuationProjection(continuations, members) {
  if (!Array.isArray(continuations) || !Array.isArray(members)) throw projectionInconsistent('continuations and members must be arrays')
  const headers = new Map()
  for (const continuation of continuations) {
    if (!isPlainObject(continuation) || !nonBlankString(continuation.id)) throw projectionInconsistent('a continuation has no id')
    if (!CONTINUATION_STATUSES.includes(continuation.status)) throw projectionInconsistent('a continuation is not active or needs_reconfirmation', { status: continuation.status })
    if (headers.has(continuation.id)) throw projectionInconsistent('a continuation id repeats')
    headers.set(continuation.id, continuation)
  }
  const suppressAddKeys = new Map()
  const protectInactiveKeys = new Map()
  const byOldRecordId = new Map()
  const byContinuation = new Map()
  for (const member of members) {
    if (!isPlainObject(member)) throw projectionInconsistent('a member is not an object')
    const { continuationId, oldKey, newKey, oldRecordId } = member
    if (!nonBlankString(continuationId) || !headers.has(continuationId)) throw projectionInconsistent('a member names no active continuation')
    if (!nonBlankString(oldKey) || !nonBlankString(newKey) || !nonBlankString(oldRecordId) || !nonBlankString(member.componentSourceId)) {
      throw projectionInconsistent('a member lacks its keys, record id or component id')
    }
    if (!Number.isInteger(member.position) || member.position < 0) throw projectionInconsistent('a member has no position')
    const ref = Object.freeze({ continuationId, position: member.position })
    // BASE keys (TD-14; the lookups `continuedRefFor` strip the same way). A member key is a raw key by
    // construction (pairing recomputes every key from its tokens), so the strip is a no-op there — it is the
    // stated invariant made true for a stored key that somehow carries the suffix (PR-4 F-15b).
    suppressAddKeys.set(baseKeyOf(newKey), ref)
    protectInactiveKeys.set(baseKeyOf(oldKey), ref)
    byOldRecordId.set(oldRecordId, ref)
    if (!byContinuation.has(continuationId)) byContinuation.set(continuationId, [])
    byContinuation.get(continuationId).push(member)
  }
  if (suppressAddKeys.size !== members.length || protectInactiveKeys.size !== members.length || byOldRecordId.size !== members.length) {
    throw projectionInconsistent('member cardinality mismatch', {
      members: members.length,
      suppressAddKeys: suppressAddKeys.size,
      protectInactiveKeys: protectInactiveKeys.size,
      byOldRecordId: byOldRecordId.size,
    })
  }
  for (const [id, header] of headers.entries()) {
    const list = byContinuation.get(id) || []
    list.sort((left, right) => left.position - right.position)
    const positionsOk = list.every((member, index) => member.position === index)
    if (list.length === 0 || !positionsOk || (header.memberCount !== undefined && header.memberCount !== list.length)) {
      throw projectionInconsistent('a continuation\'s members do not match its header', { continuationId: id })
    }
    byContinuation.set(id, Object.freeze(list.slice()))
  }
  return Object.freeze({ suppressAddKeys, protectInactiveKeys, byOldRecordId, byContinuation })
}

/**
 * Design §6.1 invariant (iii), over the EMITTED decisions, fail closed: no ADD / UPDATE / INACTIVE on a
 * key a continuation claims (either end), no ADD and no UPDATE (revive) of a candidate's new subtree —
 * free or already occupied (TD-15(i), O-5) — no INACTIVE of a candidate's old subtree. Every key is
 * compared as its BASE key (TD-14, O-4). Separate from the consumers on purpose, so removing a consumer
 * cannot also remove the check.
 */
// Step 5 PR-8 (design §10.3 (2); plan §3.4 「这是对『沿用行不执行 patch』的唯一例外」): a change-plan UPDATE is admitted
// ONLY as the confirmed plan authorizes it — an UPDATE (never ADD / INACTIVE), naming the authorized plan, on a key
// whose record the plan binds, patching nothing but that record's WRITE fields and the RUN stamps (never a key, a
// path, a parent, `active` or a human column). Fail closed, separate from the builders.
function assertAuthorizedChangePlanUpdate(decision, key, authorization) {
  const violated = (reason) => new StockPreparationContinuationError(500, CONTINUATION_ERROR_CODES.POSTCONDITION_VIOLATED, 'a change-plan update is not what the confirmed plan authorizes', { decision: decision.decision, reason })
  if (!authorization) throw violated('no_authorization')
  if (decision.decision !== DECISIONS.UPDATE) throw violated('not_update')
  if (!isPlainObject(decision.conflictSummary) || decision.conflictSummary.changePlanId !== authorization.changePlanId) throw violated('plan_id')
  const entry = authorization.byKey.get(key)
  if (!entry) throw violated('key_not_authorized')
  const allowed = new Set([...Object.keys(entry.writeFields), ...RUN_FIELD_IDS])
  const patch = isPlainObject(decision.patch) ? decision.patch : {}
  for (const fieldId of Object.keys(patch)) {
    if (!allowed.has(fieldId)) throw violated('field_not_authorized')
  }
}

function assertContinuationPostCondition(decisions, { projection, candidateSuppressAddKeys = new Map(), candidateOccupiedKeys = new Map(), candidateProtectKeys = new Map(), authorization = null }) {
  const writes = new Set([DECISIONS.ADD, DECISIONS.UPDATE, DECISIONS.INACTIVE])
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    if (!isPlainObject(decision) || !nonBlankString(decision.idempotencyKey)) continue
    const key = baseKeyOf(decision.idempotencyKey)
    const changePlanUpdate = isPlainObject(decision.conflictSummary) && decision.conflictSummary.type === CHANGE_PLAN_UPDATE_TYPE
    if (changePlanUpdate) assertAuthorizedChangePlanUpdate(decision, key, authorization)
    const continued = projection && (projection.suppressAddKeys.has(key) || projection.protectInactiveKeys.has(key))
    // The ONE exemption: an authorized change-plan UPDATE on a continued relationship's OLD (protected) key.
    const authorizedOldKey = changePlanUpdate && authorization && authorization.continuedOldKeys.has(key)
    if (continued && writes.has(decision.decision) && !authorizedOldKey) {
      throw new StockPreparationContinuationError(500, CONTINUATION_ERROR_CODES.POSTCONDITION_VIOLATED, 'a continued key received a write decision', { decision: decision.decision })
    }
    const candidatePosition = candidateSuppressAddKeys.has(key) || candidateOccupiedKeys.has(key)
    if (decision.decision === DECISIONS.ADD && candidatePosition) {
      throw new StockPreparationContinuationError(500, CONTINUATION_ERROR_CODES.POSTCONDITION_VIOLATED, 'a suspended candidate position received an ADD', { decision: decision.decision })
    }
    if (decision.decision === DECISIONS.UPDATE && candidatePosition) {
      throw new StockPreparationContinuationError(500, CONTINUATION_ERROR_CODES.POSTCONDITION_VIOLATED, 'a suspended candidate position received an UPDATE', { decision: decision.decision })
    }
    if (decision.decision === DECISIONS.INACTIVE && candidateProtectKeys.has(key)) {
      throw new StockPreparationContinuationError(500, CONTINUATION_ERROR_CODES.POSTCONDITION_VIOLATED, 'a suspended candidate old row received an INACTIVE', { decision: decision.decision })
    }
  }
}

// ── input normalization (design §6.1) ─────────────────────────────────────────────────────────────

function inputInvalid(message, field) {
  return new StockPreparationContinuationError(500, CONTINUATION_ERROR_CODES.INPUT_INVALID, message, field ? { field } : {})
}

function normalizeContinuationHeader(continuation) {
  if (!isPlainObject(continuation)) throw inputInvalid('continuations entries must be objects', 'continuation.continuations')
  for (const field of ['id', 'comparisonFingerprint', 'evidenceFingerprint', 'pairingFingerprint', 'sourceScopeDigest', 'readPlanDigest', 'oldRootKey', 'newRootKey']) {
    if (!nonBlankString(continuation[field])) throw inputInvalid(`continuation.${field} is required`, `continuation.continuations.${field}`)
  }
  if (!CONTINUATION_STATUSES.includes(continuation.status)) throw inputInvalid('continuation.status must be active or needs_reconfirmation', 'continuation.continuations.status')
  if (!Number.isInteger(continuation.revision) || continuation.revision < 1) throw inputInvalid('continuation.revision must be a positive integer', 'continuation.continuations.revision')
  if (!Number.isInteger(continuation.memberCount) || continuation.memberCount < 1) throw inputInvalid('continuation.memberCount must be a positive integer', 'continuation.continuations.memberCount')
  if (continuation.statusReason !== undefined && continuation.statusReason !== null && !CONTINUATION_VERDICTS.includes(continuation.statusReason)) {
    throw inputInvalid('continuation.statusReason is not a verdict token', 'continuation.continuations.statusReason')
  }
  return Object.freeze({
    id: continuation.id,
    status: continuation.status,
    statusReason: continuation.statusReason || null,
    revision: continuation.revision,
    comparisonFingerprint: continuation.comparisonFingerprint,
    evidenceFingerprint: continuation.evidenceFingerprint,
    pairingFingerprint: continuation.pairingFingerprint,
    sourceScopeDigest: continuation.sourceScopeDigest,
    readPlanDigest: continuation.readPlanDigest,
    oldRootKey: continuation.oldRootKey,
    newRootKey: continuation.newRootKey,
    memberCount: continuation.memberCount,
  })
}

/**
 * Validate the planner's optional `continuation` input. Server-held, never request-supplied. Refuses:
 * a store state other than the literal 'ok' (503 — the planner never proceeds "without continuations"
 * because a read failed, design §6.1 (ii)); an unknown key; a missing / mistyped required key; a step-5
 * change plan (PR-8 has not landed).
 */
function normalizeContinuationInput(input) {
  if (!isPlainObject(input)) throw inputInvalid('continuation must be an object (omit it for an ungoverned project)', 'continuation')
  if (input.storeState !== 'ok') {
    throw new StockPreparationContinuationError(503, CONTINUATION_ERROR_CODES.STORE_FAILED, 'the refresh store answer is not ok; refusing to plan without it', { storeState: typeof input.storeState === 'string' ? input.storeState : null })
  }
  for (const entryKey of Object.keys(input)) {
    if (!CONTINUATION_INPUT_KEYS.includes(entryKey)) throw inputInvalid(`continuation.${entryKey} is not a recognized key`, `continuation.${entryKey}`)
  }
  if (typeof input.pilot !== 'boolean') throw inputInvalid('continuation.pilot must be a boolean', 'continuation.pilot')
  if (!nonBlankString(input.projectNo)) throw inputInvalid('continuation.projectNo is required', 'continuation.projectNo')
  if (!Array.isArray(input.continuations)) throw inputInvalid('continuation.continuations must be an array', 'continuation.continuations')
  if (!Array.isArray(input.members)) throw inputInvalid('continuation.members must be an array', 'continuation.members')
  if (input.demandEvidence !== undefined && input.demandEvidence !== null && !isPlainObject(input.demandEvidence)) {
    throw inputInvalid('continuation.demandEvidence must be the expansion\'s demandEvidence object or null', 'continuation.demandEvidence')
  }
  const sourceIdentity = input.sourceIdentity
  if (!isPlainObject(sourceIdentity) || !nonBlankString(sourceIdentity.externalSystemId) || !nonBlankString(sourceIdentity.sourceScopeDigest) || !nonBlankString(sourceIdentity.readPlanDigest)) {
    throw inputInvalid('continuation.sourceIdentity needs externalSystemId, sourceScopeDigest and readPlanDigest', 'continuation.sourceIdentity')
  }
  if (typeof input.specSlotDeclared !== 'boolean') throw inputInvalid('continuation.specSlotDeclared must be a boolean', 'continuation.specSlotDeclared')
  const persistedHolds = normalizePersistedHolds(input.persistedHolds)
  const changePlan = normalizeChangePlanInput(input.changePlan)
  const expectedContent = normalizeExpectedContent(input.expectedContent)
  return Object.freeze({
    storeState: 'ok',
    pilot: input.pilot,
    projectNo: input.projectNo.trim(),
    continuations: Object.freeze(input.continuations.map(normalizeContinuationHeader)),
    members: Object.freeze(input.members.slice()),
    demandEvidence: isPlainObject(input.demandEvidence) ? input.demandEvidence : null,
    sourceIdentity: Object.freeze({
      externalSystemId: sourceIdentity.externalSystemId,
      sourceScopeDigest: sourceIdentity.sourceScopeDigest,
      readPlanDigest: sourceIdentity.readPlanDigest,
    }),
    specSlotDeclared: input.specSlotDeclared,
    persistedHolds,
    changePlan,
    expectedContent,
  })
}

// Step 5 PR-8 review fix N3 (C06) — the content the project's REVIEWS (round 2, N3-b: the reviewed-cell register, every
// cell any review bound) and its pending WRITTEN plan left on the sheet (the consult's private `expectedContent`, built
// by the continuation store): `[]` when absent (nothing reviewed or written — the lane always passes it, RL-02 / SL-G8),
// else exactly `[{ recordId, key, fields: { [fieldId]: { after, afterCanonical } } }]` with DISTINCT KEYS (round 2,
// N3-a: the record key is the identity; `recordId` names the record the latest review / the written plan bound under
// that key, and one record reviewed under two keys over time may appear twice). A closed shape, refused 500 otherwise
// (a lane defect).
const EXPECTED_CONTENT_KEYS = Object.freeze(['recordId', 'key', 'fields'])

function normalizeExpectedContent(input) {
  if (input === undefined || input === null) return Object.freeze([])
  if (!Array.isArray(input)) throw inputInvalid('continuation.expectedContent must be an array', 'continuation.expectedContent')
  const seen = new Set()
  return Object.freeze(input.map((entry, index) => {
    const field = `continuation.expectedContent[${index}]`
    if (!isPlainObject(entry)) throw inputInvalid('an expected-content entry must be an object', field)
    for (const entryKey of Object.keys(entry)) {
      if (!EXPECTED_CONTENT_KEYS.includes(entryKey)) throw inputInvalid(`${field}.${entryKey} is not a recognized key`, `${field}.${entryKey}`)
    }
    if (!nonBlankString(entry.recordId) || !nonBlankString(entry.key) || !isPlainObject(entry.fields)) throw inputInvalid('an expected-content entry needs recordId, key and fields', field)
    if (seen.has(entry.key)) throw inputInvalid('an expected-content key repeats', field)
    seen.add(entry.key)
    const fields = {}
    for (const [fieldId, cell] of Object.entries(entry.fields)) {
      if (!isPlainObject(cell) || !Object.prototype.hasOwnProperty.call(cell, 'after') || !Object.prototype.hasOwnProperty.call(cell, 'afterCanonical')) {
        throw inputInvalid('an expected-content cell needs after and afterCanonical', `${field}.fields.${fieldId}`)
      }
      fields[fieldId] = Object.freeze({ after: cell.after, afterCanonical: cell.afterCanonical })
    }
    return Object.freeze({ recordId: entry.recordId, key: entry.key, fields: Object.freeze(fields) })
  }))
}

// Step 5 PR-8 — the CONFIRMED change plan a governed computation plans with (design §10.3 (2); the lane builds it from
// the consult's values-free summary and THIS computation's source content digest): `null` (none), or exactly
// `{ id, planFingerprint, currentSourceContentDigest, recordIds }`. `recordIds` (record-id handles the plan writes)
// keep content detection ON for those records whatever the pilot marker says (refutation M4: after a pilot exit the
// confirmed change is still found, so it is executed and reviewed — plan §3.4 「退出试点…未完成的变更复核…继续生效」).
const CHANGE_PLAN_INPUT_KEYS = Object.freeze(['id', 'planFingerprint', 'currentSourceContentDigest', 'recordIds'])

function normalizeChangePlanInput(input) {
  if (input === undefined || input === null) return null
  if (!isPlainObject(input)) throw inputInvalid('continuation.changePlan must be null or an object', 'continuation.changePlan')
  for (const entryKey of Object.keys(input)) {
    if (!CHANGE_PLAN_INPUT_KEYS.includes(entryKey)) throw inputInvalid(`continuation.changePlan.${entryKey} is not a recognized key`, `continuation.changePlan.${entryKey}`)
  }
  for (const field of ['id', 'planFingerprint', 'currentSourceContentDigest']) {
    if (!nonBlankString(input[field])) throw inputInvalid(`continuation.changePlan.${field} is required`, `continuation.changePlan.${field}`)
  }
  if (!Array.isArray(input.recordIds) || !input.recordIds.every(nonBlankString)) {
    throw inputInvalid('continuation.changePlan.recordIds must be an array of record ids', 'continuation.changePlan.recordIds')
  }
  return Object.freeze({
    id: input.id,
    planFingerprint: input.planFingerprint,
    currentSourceContentDigest: input.currentSourceContentDigest,
    recordIds: Object.freeze(input.recordIds.slice()),
  })
}

/**
 * The consult's open holds as the lane field-picked them (PERSISTED_HOLD_KEYS, AMB-1). REQUIRED: absent is a
 * lane defect (500), never "no holds". Each entry is closed to the thirteen keys and re-validated exactly
 * like a hold the store would accept, so a re-emitted hold can never 500 at the store on its shape.
 */
function normalizePersistedHolds(input) {
  if (input === undefined) throw inputInvalid('continuation.persistedHolds is required (the consult\'s open holds; [] when none)', 'continuation.persistedHolds')
  if (!Array.isArray(input)) throw inputInvalid('continuation.persistedHolds must be an array', 'continuation.persistedHolds')
  const seen = new Set()
  const out = input.map((entry, index) => {
    const field = `continuation.persistedHolds[${index}]`
    if (!isPlainObject(entry)) throw inputInvalid('a persisted hold must be an object', field)
    for (const entryKey of Object.keys(entry)) {
      if (!PERSISTED_HOLD_KEYS.includes(entryKey)) throw inputInvalid(`${field}.${entryKey} is not a recognized key`, `${field}.${entryKey}`)
    }
    for (const entryKey of PERSISTED_HOLD_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(entry, entryKey)) throw inputInvalid(`${field}.${entryKey} is required`, `${field}.${entryKey}`)
    }
    if (!HOLD_KINDS.includes(entry.kind)) throw inputInvalid('persisted hold kind is not a hold kind', `${field}.kind`)
    if (!nonBlankString(entry.fingerprint)) throw inputInvalid('persisted hold fingerprint is required', `${field}.fingerprint`)
    if (seen.has(entry.fingerprint)) throw inputInvalid('two persisted holds share a fingerprint', `${field}.fingerprint`)
    seen.add(entry.fingerprint)
    if (typeof entry.confirmable !== 'boolean') throw inputInvalid('persisted hold confirmable must be a boolean', `${field}.confirmable`)
    if (entry.confirmable === true && entry.notConfirmableReason !== null) throw inputInvalid('a confirmable persisted hold carries no notConfirmableReason', `${field}.notConfirmableReason`)
    if (entry.confirmable === false && !NOT_CONFIRMABLE_REASONS.includes(entry.notConfirmableReason)) throw inputInvalid('a non-confirmable persisted hold needs a notConfirmableReason token', `${field}.notConfirmableReason`)
    if (entry.shapeToken !== null && !SHAPE_TOKENS.includes(entry.shapeToken)) throw inputInvalid('persisted hold shapeToken is not a shape token', `${field}.shapeToken`)
    for (const name of ['continuationId', 'evidenceFingerprint', 'comparisonFingerprint', 'pairingFingerprint']) {
      if (entry[name] !== null && !nonBlankString(entry[name])) throw inputInvalid(`persisted hold ${name} must be a string or null`, `${field}.${name}`)
    }
    if (!isPlainObject(entry.subject)) throw inputInvalid('persisted hold subject must be an object', `${field}.subject`)
    if (!isPlainObject(entry.detail)) throw inputInvalid('persisted hold detail must be an object', `${field}.detail`)
    if (typeof entry.runbookOnly !== 'boolean') throw inputInvalid('persisted hold runbookOnly must be a boolean', `${field}.runbookOnly`)
    const roots = entry.continuationRoots
    if (roots !== null) {
      const rootKeys = isPlainObject(roots) ? Object.keys(roots).sort() : []
      if (!isPlainObject(roots) || rootKeys.join(',') !== 'newRootKey,oldRootKey' || !nonBlankString(roots.oldRootKey) || !nonBlankString(roots.newRootKey)) {
        throw inputInvalid('persisted hold continuationRoots must be null or { oldRootKey, newRootKey }', `${field}.continuationRoots`)
      }
    }
    return Object.freeze({
      kind: entry.kind,
      fingerprint: entry.fingerprint,
      confirmable: entry.confirmable,
      notConfirmableReason: entry.confirmable ? null : entry.notConfirmableReason,
      shapeToken: entry.shapeToken,
      continuationId: entry.continuationId,
      subject: entry.subject,
      detail: entry.detail,
      evidenceFingerprint: entry.evidenceFingerprint,
      comparisonFingerprint: entry.comparisonFingerprint,
      pairingFingerprint: entry.pairingFingerprint,
      runbookOnly: entry.runbookOnly,
      continuationRoots: roots === null ? null : Object.freeze({ oldRootKey: roots.oldRootKey, newRootKey: roots.newRootKey }),
    })
  })
  return Object.freeze(out)
}

// ── holds ─────────────────────────────────────────────────────────────────────────────────────────

// Batch-refresh step 5 PR-8 (refutation M2; plan §4 「人工填写不属于关系内容指纹，不因普通人工填写变更就重新询问」):
// the per-computation OBSERVATIONS a content hold carries for the page — the record version the computation read and
// which human columns hold a value — say nothing about WHAT changed, and a person filling any cell of the row moves
// both. They stay in the stored `detail` (the store refreshes them every time a computation keeps the hold) but are
// EXCLUDED from the hold's body digest, so a person's edit never re-keys the hold (a new id / fingerprint would void
// the puller's read receipt and the change-plan confirm's echo). Only the content_change body carries them.
const VOLATILE_DETAIL_KEYS = Object.freeze({
  content_change: Object.freeze(['recordVersion', 'humanColumnsPresent']),
})

function fingerprintedDetail(kind, detail) {
  const volatile = VOLATILE_DETAIL_KEYS[kind]
  if (!volatile || !isPlainObject(detail)) return detail
  const out = {}
  for (const [entryKey, value] of Object.entries(detail)) {
    if (!volatile.includes(entryKey)) out[entryKey] = value
  }
  return out
}

/**
 * Same hold content => same fingerprint across computations (design §4.2 `fingerprint`): kind, subject
 * handles, confirmability and the body digest (the kind's volatile observations excluded, PR-8 M2).
 * Deterministic: no clock, no run id, no lane.
 */
function holdFingerprint(hold) {
  const { kind, subject, confirmable, notConfirmableReason, shapeToken, detail, evidenceFingerprint, comparisonFingerprint, pairingFingerprint, continuationId } = hold
  return fingerprintOf(SCHEMES.hold, {
    kind,
    subject,
    confirmable: confirmable === true,
    notConfirmableReason: notConfirmableReason || null,
    shapeToken: shapeToken || null,
    continuationId: continuationId || null,
    evidenceFingerprint: evidenceFingerprint || null,
    comparisonFingerprint: comparisonFingerprint || null,
    pairingFingerprint: pairingFingerprint || null,
    bodyDigest: fingerprintOf(SCHEMES.holdBody, detail === undefined ? null : fingerprintedDetail(kind, detail)),
  })
}

function makeHold(fields) {
  if (!HOLD_KINDS.includes(fields.kind)) throw new Error(`unknown hold kind ${fields.kind}`)
  if (fields.shapeToken && !SHAPE_TOKENS.includes(fields.shapeToken)) throw new Error(`unknown shape token ${fields.shapeToken}`)
  if (fields.notConfirmableReason && !NOT_CONFIRMABLE_REASONS.includes(fields.notConfirmableReason)) throw new Error(`unknown reason ${fields.notConfirmableReason}`)
  const hold = {
    kind: fields.kind,
    confirmable: fields.confirmable === true,
    ...(fields.confirmable === true ? {} : { notConfirmableReason: fields.notConfirmableReason }),
    ...(fields.shapeToken ? { shapeToken: fields.shapeToken } : {}),
    ...(fields.continuationId ? { continuationId: fields.continuationId } : {}),
    subject: fields.subject,
    ...(fields.evidenceFingerprint ? { evidenceFingerprint: fields.evidenceFingerprint } : {}),
    ...(fields.comparisonFingerprint ? { comparisonFingerprint: fields.comparisonFingerprint } : {}),
    ...(fields.pairingFingerprint ? { pairingFingerprint: fields.pairingFingerprint } : {}),
    detail: fields.detail,
  }
  hold.fingerprint = holdFingerprint(hold)
  return hold
}

function privatePairs(pairs) {
  return pairs.map((pair) => ({
    relativePath: pair.relativePath,
    componentSourceId: pair.componentSourceId,
    oldKey: pair.oldKey,
    newKey: pair.newKey,
    oldRecordId: pair.oldRecordId,
  }))
}

// ── verification (design §6.3) ────────────────────────────────────────────────────────────────────

function subtreeRows(rows, rootTokens, predicate = () => true) {
  return rows.filter((row) => predicate(row) && tokensStartWith(pathTokensOf(row) || [], rootTokens))
}

/**
 * Re-verify one continuation against the current read. Every step is evaluated; the verdict is the
 * FIRST failing step in the design's order (source, new position present, new position free, old rows
 * present, pairing, demand, content). Protection stays applied whatever the verdict (the caller's
 * projection does not depend on it).
 */
function verifyContinuation(context, continuation, members) {
  const { input, expandedRowsComposed, rawExpandedKeyed, existingKeyed, duplicateExistingKeys, existingRows, templateFields, nameAndSpecDeclared } = context
  const steps = {}
  steps.source = continuation.sourceScopeDigest === input.sourceIdentity.sourceScopeDigest
    && continuation.readPlanDigest === input.sourceIdentity.readPlanDigest
    ? 'valid' : 'source_scope_changed'

  steps.newPresent = members.every((member) => rawExpandedKeyed.has(member.newKey)) ? 'valid' : 'new_position_removed'
  steps.newFree = members.every((member) => !existingKeyed.has(member.newKey)) ? 'valid' : 'new_position_occupied'

  let oldStep = 'valid'
  for (const member of members) {
    const group = existingKeyed.get(member.oldKey)
    let verdict = 'valid'
    if (!group || group.length === 0) verdict = 'old_record_missing'
    else if (group.length > 1 || duplicateExistingKeys.has(member.oldKey)) verdict = 'old_subtree_duplicate'
    else {
      const ref = recordRefOf(group[0])
      if (!ref || ref.id !== member.oldRecordId) verdict = 'old_record_replaced'
      else if (group[0].active === false) verdict = 'old_record_inactive'
    }
    if (verdict !== 'valid') {
      oldStep = verdict
      break
    }
  }
  steps.oldPresent = oldStep

  const oldRootTokens = keyPathTokens(continuation.oldRootKey)
  const newRootTokens = keyPathTokens(continuation.newRootKey)
  // PR-4 (design §8.4, O-17): N(c) of the OLD ROOT's component in THIS read — every raw expansion position of
  // that component other than the old root's own key (its subtree rows carry other components). Recorded on
  // the reconfirm hold as a values-free count, so the end route can decide `release_to_normal_refresh` from
  // the latest computation's recorded facts: zero means the normal refresh afterwards can only SKIP / UPDATE
  // the old rows (back in the expansion) or mark them missing — no copy exists to be ADDed. `null` when the
  // old root key cannot be parsed (the end route then refuses: facts missing).
  let componentNewPositionCount = null
  if (oldRootTokens) {
    const oldRootComponent = oldRootTokens[oldRootTokens.length - 1]
    componentNewPositionCount = 0
    for (const [entryKey, rows] of rawExpandedKeyed.entries()) {
      if (entryKey === continuation.oldRootKey) continue
      if (rows[0] && rows[0].componentSourceId === oldRootComponent) componentNewPositionCount += 1
    }
  }
  let pairing = null
  let comparison = null
  let demandFacts = null
  let fingerprints = null
  let postChange = null
  if (!oldRootTokens || !newRootTokens) {
    // F-15 (design §23.8): a root key the parser refuses — the planner's `::duplicate:` suffix included — is
    // structure, deliberately and by construction (TD-14's claim maps are base-keyed, so a stripped root would
    // protect / suppress BOTH duplicate twins); the detector never emits a confirmable candidate on such a root.
    steps.pairing = 'structure_changed'
  } else {
    const oldClosure = subtreeRows(existingRows, oldRootTokens, (row) => keyOf(row) !== null && isActiveRow(row))
    const newClosure = subtreeRows(expandedRowsComposed, newRootTokens)
    pairing = pairSubtrees({ projectNo: input.projectNo, oldRootTokens, newRootTokens, oldRows: oldClosure, newRows: newClosure })
    const membersByPath = new Map(members.map((member) => [JSON.stringify(Array.isArray(member.relativePathTokens) ? member.relativePathTokens : null), member]))
    const membersMatch = pairing.ok
      && pairing.pairs.length === members.length
      && membersByPath.size === members.length
      && pairing.pairs.every((pair) => {
        const member = membersByPath.get(JSON.stringify(pair.relativePath))
        return Boolean(member)
          && member.oldKey === pair.oldKey
          && member.newKey === pair.newKey
          && member.componentSourceId === pair.componentSourceId
          && member.oldRecordId === pair.oldRecordId
          && JSON.stringify(Array.isArray(member.relativePathTokens) ? member.relativePathTokens : null) === JSON.stringify(pair.relativePath)
      })
    const pairingFingerprint = pairing.ok
      ? pairingFingerprintOf({ projectNo: input.projectNo, oldRootKey: continuation.oldRootKey, newRootKey: continuation.newRootKey, pairs: pairing.pairs })
      : null
    steps.pairing = membersMatch && pairingFingerprint === continuation.pairingFingerprint ? 'valid' : 'structure_changed'
    demandFacts = projectDemandFacts(input.demandEvidence, {
      oldRootComponentSourceId: oldRootTokens[oldRootTokens.length - 1],
      newParentComponentSourceId: expectedParentForTokens(newRootTokens),
      memberComponentSourceIds: members.map((member) => member.componentSourceId),
    })
    if (!demandFacts.relevantComplete) steps.demand = 'evidence_incomplete'
    else if (demandFacts.oldRoot.keptAsRoot) steps.demand = 'demand_changed'
    else steps.demand = 'valid'

    if (pairing.ok) {
      comparison = compareSevenItems({ pairs: pairing.pairs, templateFields, specSlotDeclared: input.specSlotDeclared, nameAndSpecDeclared })
      const evidenceFingerprint = evidenceFingerprintOf({ projectNo: input.projectNo, pairs: pairing.pairs, comparison, demandFacts })
      fingerprints = { pairingFingerprint, comparisonFingerprint: comparison.comparisonFingerprint, evidenceFingerprint }
      if (comparison.comparisonFingerprint === continuation.comparisonFingerprint) {
        steps.content = evidenceFingerprint === continuation.evidenceFingerprint ? 'valid' : 'evidence_changed'
      } else if (comparison.outcome === 'incomplete') {
        steps.content = 'evidence_incomplete'
      } else if (comparison.outcome === 'content_change') {
        steps.content = 'content_changed'
        // Step 5 PR-8: the pair a change-plan confirm stamps (see postChangeFingerprintsOf).
        postChange = postChangeFingerprintsOf({ projectNo: input.projectNo, pairs: pairing.pairs, comparison, demandFacts, templateFields, specSlotDeclared: input.specSlotDeclared, nameAndSpecDeclared })
      } else {
        // Both sides moved together (a host-side write on the old rows AND a source change): the
        // relationship no longer describes what was confirmed.
        steps.content = 'evidence_changed'
      }
    } else {
      steps.content = 'structure_changed'
    }
  }
  const order = ['source', 'newPresent', 'newFree', 'oldPresent', 'pairing', 'demand', 'content']
  const failing = order.find((step) => steps[step] !== undefined && steps[step] !== 'valid')
  const verdict = failing ? steps[failing] : 'valid'
  const othersValid = order.filter((step) => step !== 'source').every((step) => steps[step] === 'valid')
  let reconfirmable = false
  if (verdict === 'source_scope_changed') reconfirmable = othersValid
  else if (verdict === 'evidence_changed') reconfirmable = true
  else if (verdict === 'valid' && continuation.status === 'needs_reconfirmation') reconfirmable = RECONFIRMABLE_REASONS.includes(continuation.statusReason)
  return { verdict, steps, reconfirmable, pairing, comparison, demandFacts, fingerprints, componentNewPositionCount, postChange }
}

function verificationHold(continuation, result) {
  const { verdict } = result
  if (verdict === 'valid' && continuation.status === 'active') return null
  const subject = {
    continuationId: continuation.id,
    newRootKeyDigest: subjectDigest(continuation.newRootKey),
  }
  const detail = {
    verdict,
    statusReason: continuation.statusReason,
    steps: { ...result.steps },
    pairs: result.pairing && result.pairing.ok ? privatePairs(result.pairing.pairs) : null,
    pairingProblems: result.pairing ? result.pairing.problems.map((problem) => problem.reason) : null,
    comparison: result.comparison ? { outcome: result.comparison.outcome, items: result.comparison.items, parentEdgeUsage: result.comparison.parentEdgeUsage } : null,
    demand: result.demandFacts,
    // PR-4 (§8.4 end admissibility): N(c) of the old root's component in this read — see verifyContinuation.
    componentNewPositionCount: result.componentNewPositionCount === undefined ? null : result.componentNewPositionCount,
  }
  // Step 5 PR-8: a content change the change-plan confirm can resolve carries the post-change pair it would stamp
  // (two digests — never a version or a human-column observation, so a person's edit never re-keys it; M2).
  const changePlanResolvable = verdict === 'content_changed'
    && (continuation.status === 'active' || RECONFIRMABLE_REASONS.includes(continuation.statusReason))
    && isPlainObject(result.postChange)
  if (changePlanResolvable) detail.postChange = { ...result.postChange }
  const fingerprints = result.fingerprints || {}
  if (verdict === 'content_changed' && continuation.status === 'active') {
    return makeHold({
      kind: 'relationship_content_change',
      confirmable: false,
      notConfirmableReason: 'needs_step5',
      continuationId: continuation.id,
      subject,
      ...fingerprints,
      detail,
    })
  }
  let reason = null
  if (!result.reconfirmable) {
    if (verdict === 'demand_changed') reason = 'customer_rule_pending'
    else if (verdict === 'evidence_incomplete') reason = 'evidence_incomplete'
    // Step 5 PR-8 (refutation M3): a relationship that needs reconfirmation AND whose content changed is resolved
    // by the change-plan confirm (which re-activates it) only when its stored reason is one a re-confirm admits;
    // otherwise neither path admits it and the token says so (never a promise of step 5 it cannot keep).
    else if (verdict === 'content_changed') reason = changePlanResolvable ? 'needs_step5' : 'reconfirm_not_admissible'
    else reason = 'reconfirm_not_admissible'
  }
  return makeHold({
    kind: 'relationship_reconfirm',
    confirmable: result.reconfirmable === true,
    notConfirmableReason: reason,
    continuationId: continuation.id,
    subject,
    ...fingerprints,
    detail,
  })
}

// ── candidate detection (design §6.6) — pilot projects only ───────────────────────────────────────

function candidateHoldFields(kind) {
  switch (kind) {
    case 'candidate_target_occupied': return { notConfirmableReason: 'specialist_repair' }
    case 'candidate_ambiguous': return { notConfirmableReason: 'ambiguous_pairing' }
    case 'candidate_old_duplicate': return { notConfirmableReason: 'specialist_repair' }
    case 'candidate_keyless_rows': return { notConfirmableReason: 'keyless_rows_present' }
    case 'candidate_shape_unresolved': return { notConfirmableReason: 'customer_rule_pending' }
    case 'candidate_structure_differs': return { notConfirmableReason: 'phase_2' }
    case 'candidate_incomplete_evidence': return { notConfirmableReason: 'evidence_incomplete' }
    case 'candidate_content_differs': return { notConfirmableReason: 'needs_step5' }
    default: return {}
  }
}

/**
 * Keyed on the COMPONENT (design §6.6): for every component c with at least one OLD root (an active,
 * parentless row of c) and at least one NEW position (any other expansion key of c), whether or not root
 * selection dropped the old root and whether or not the new position is occupied, exactly one hold.
 * Positions and roots already claimed by a continuation are excluded (the projection protects them). The
 * first matching rule names the hold; only the base shape is confirmable.
 *
 * NEW POSITIONS, precisely (design §6.6 step 1 read together with §18 A09 「新位置已有有效或无效记录」):
 * every expansion key of c that is not an old root of c. A position that already holds an ACTIVE row
 * counts too — as `candidate_target_occupied` — whenever some old root of c is about to be swept (not in
 * this expansion): that is the "history already holds two copies" sheet the old flow would resolve by
 * sweeping the independent copy. Only when EVERY old root of c is still in the expansion (both demands
 * live; this pull changes neither) is an actively-held position left alone, as step 1 states.
 */
function detectCandidates(context) {
  const { input, expandedRowsComposed, rawExpandedKeyed, existingKeyed, existingMissing, duplicateExistingKeys, existingRows, projection, templateFields, nameAndSpecDeclared } = context
  const activeKeys = new Set()
  for (const [entryKey, rows] of existingKeyed.entries()) {
    if (rows.some(isActiveRow)) activeKeys.add(entryKey)
  }
  const oldRoots = new Map()
  const oldRootKeys = new Set()
  for (const [entryKey, rows] of existingKeyed.entries()) {
    if (projection.protectInactiveKeys.has(entryKey)) continue
    const root = rows.find((row) => isRootRow(row) && isActiveRow(row))
    if (!root || !nonBlankString(root.componentSourceId)) continue
    oldRootKeys.add(entryKey)
    if (!oldRoots.has(root.componentSourceId)) oldRoots.set(root.componentSourceId, [])
    oldRoots.get(root.componentSourceId).push({ key: entryKey, tokens: pathTokensOf(root), row: root, rows })
  }
  const newPositions = new Map()
  for (const [entryKey, rows] of rawExpandedKeyed.entries()) {
    if (oldRootKeys.has(entryKey) || projection.suppressAddKeys.has(entryKey)) continue
    const row = rows[0]
    if (!nonBlankString(row.componentSourceId) || !oldRoots.has(row.componentSourceId)) continue
    if (!newPositions.has(row.componentSourceId)) newPositions.set(row.componentSourceId, [])
    newPositions.get(row.componentSourceId).push({ key: entryKey, tokens: pathTokensOf(row), rows, activeOccupied: activeKeys.has(entryKey) })
  }
  // O-6 (PR-3a, T-ratified 2026-10-23, D-10 fail closed): a component held BOTH as an active root that is
  // still ordered AND as an active nested copy is never filtered out ("both demands live, leave the copy
  // alone" read the doubled sheet as healthy). It raises `candidate_shape_unresolved` / `old_root_still_ordered`
  // instead; the step-6 repair (or PR B readiness) is the way out of a two-copy sheet.
  const twoCopyComponents = new Set()
  for (const [component, positions] of Array.from(newPositions.entries())) {
    const everyOldRootKept = oldRoots.get(component).every((root) => rawExpandedKeyed.has(root.key))
    if (everyOldRootKept && positions.some((position) => position.activeOccupied)) twoCopyComponents.add(component)
  }
  const components = Array.from(newPositions.keys()).sort(compareStrings)

  // Pre-pass: which new / old keys each component's subtrees claim (two candidates claiming one key are
  // ambiguous — A08 "two old sets claim one new position").
  const claims = { new: new Map(), old: new Map() }
  const prepared = components.map((component) => {
    const positions = newPositions.get(component).slice().sort((left, right) => compareStrings(left.key, right.key))
    const roots = oldRoots.get(component).slice().sort((left, right) => compareStrings(left.key, right.key))
    const newSubtree = []
    for (const position of positions) {
      if (!position.tokens) continue
      newSubtree.push(...subtreeRows(expandedRowsComposed, position.tokens))
    }
    const oldSubtree = []
    for (const root of roots) {
      if (!root.tokens) continue
      oldSubtree.push(...subtreeRows(existingRows, root.tokens, (row) => keyOf(row) !== null && isActiveRow(row)))
    }
    for (const row of newSubtree) {
      const entryKey = keyOf(row)
      if (!entryKey) continue
      if (!claims.new.has(entryKey)) claims.new.set(entryKey, new Set())
      claims.new.get(entryKey).add(component)
    }
    for (const row of oldSubtree) {
      const entryKey = keyOf(row)
      if (!claims.old.has(entryKey)) claims.old.set(entryKey, new Set())
      claims.old.get(entryKey).add(component)
    }
    return { component, positions, roots, newSubtree, oldSubtree }
  })

  const holds = []
  const candidateSuppressAddKeys = new Map()
  const candidateOccupiedKeys = new Map()
  const candidateProtectKeys = new Map()
  for (const entry of prepared) {
    const { component, positions, roots, newSubtree, oldSubtree } = entry
    const subject = { componentSourceIdDigest: subjectDigest(component) }
    const detail = {
      componentSourceId: component,
      newPositionKeys: positions.map((position) => position.key),
      oldRootKeys: roots.map((root) => root.key),
      oldRootRecordIds: roots.map((root) => (recordRefOf(root.row) || {}).id || null),
      history: 'history_unknown',
    }
    let kind = null
    let shapeToken = null
    let fingerprints = {}

    const occupied = positions.some((position) => existingKeyed.has(position.key))
      || newSubtree.some((row) => keyOf(row) && existingKeyed.has(keyOf(row)))
    const overlaps = newSubtree.some((row) => keyOf(row) && claims.new.get(keyOf(row)).size > 1)
      || oldSubtree.some((row) => claims.old.get(keyOf(row)).size > 1)
    // F-15 (PR-4; design §23.8): an OLD root whose key is duplicate-resolved (`<base>::duplicate:<kind>:<hash>`,
    // the row of one of ≥ 2 identical positions an earlier pull ADDed) is ambiguous by construction — the claim
    // maps are base-keyed (TD-14), so a continuation on it would protect / suppress BOTH twins, and the key
    // parsers refuse the suffix (verification: structure_changed; the store: new_root_key_unparsable). Never a
    // confirmable candidate. Raw expansion keys never carry the suffix (the planner mints it on decisions).
    const duplicateResolvedRoot = roots.some((root) => baseKeyOf(root.key) !== root.key) || positions.some((position) => baseKeyOf(position.key) !== position.key)
    if (duplicateResolvedRoot) detail.duplicateResolvedRootKey = true
    const unreadablePath = positions.some((position) => !position.tokens) || roots.some((root) => !root.tokens)
    if (twoCopyComponents.has(component)) {
      kind = 'candidate_shape_unresolved'
      shapeToken = 'old_root_still_ordered'
      detail.shapeSubTokens = ['active_nested_copy']
    } else if (occupied) kind = 'candidate_target_occupied'
    else if (roots.length > 1 || positions.length > 1 || overlaps || duplicateResolvedRoot) kind = 'candidate_ambiguous'
    else if (oldSubtree.some((row) => duplicateExistingKeys.has(keyOf(row))) || roots.some((root) => root.rows.length > 1)) kind = 'candidate_old_duplicate'
    else if (existingMissing.some((row) => isActiveRow(row) && (row.componentSourceId === component
      || roots.some((root) => root.tokens && tokensStartWith(pathTokensOf(row) || [], root.tokens))))) kind = 'candidate_keyless_rows'

    if (!kind && unreadablePath) kind = 'candidate_incomplete_evidence'
    if (!kind) {
      const position = positions[0]
      const root = roots[0]
      const demandFacts = projectDemandFacts(input.demandEvidence, {
        oldRootComponentSourceId: component,
        newParentComponentSourceId: expectedParentForTokens(position.tokens),
        memberComponentSourceIds: sortedUnique(newSubtree.map((row) => row.componentSourceId).filter(nonBlankString)),
      })
      detail.demand = demandFacts
      const oldRootStillInExpansion = rawExpandedKeyed.has(root.key)
      if (oldRootStillInExpansion || demandFacts.classification === 'kept') {
        kind = 'candidate_shape_unresolved'
        shapeToken = 'old_root_still_ordered'
        detail.shapeSubTokens = demandFacts.subTokens
      } else if (demandFacts.classification === 'dropped_other_rule') {
        kind = 'candidate_shape_unresolved'
        shapeToken = 'dropped_other_rule'
        detail.shapeSubTokens = demandFacts.oldRoot.rules
      } else {
        const pairing = pairSubtrees({ projectNo: input.projectNo, oldRootTokens: root.tokens, newRootTokens: position.tokens, oldRows: oldSubtree, newRows: newSubtree })
        detail.pairingProblems = pairing.problems.map((problem) => problem.reason)
        if (!pairing.ok) {
          kind = 'candidate_structure_differs'
        } else {
          detail.pairs = privatePairs(pairing.pairs)
          const comparison = compareSevenItems({ pairs: pairing.pairs, templateFields, specSlotDeclared: input.specSlotDeclared, nameAndSpecDeclared })
          detail.comparison = { outcome: comparison.outcome, items: comparison.items, parentEdgeUsage: comparison.parentEdgeUsage }
          fingerprints = {
            pairingFingerprint: pairingFingerprintOf({ projectNo: input.projectNo, oldRootKey: root.key, newRootKey: position.key, pairs: pairing.pairs }),
            comparisonFingerprint: comparison.comparisonFingerprint,
            evidenceFingerprint: evidenceFingerprintOf({ projectNo: input.projectNo, pairs: pairing.pairs, comparison, demandFacts }),
          }
          if (demandFacts.classification === 'incomplete' || comparison.outcome === 'incomplete') kind = 'candidate_incomplete_evidence'
          else if (comparison.outcome === 'content_change') {
            kind = 'candidate_content_differs'
            // Step 5 PR-8 (design §10.3 (5)): the combined confirm creates the relationship stamped with the pair it
            // will verify with once the change-plan update has written the new side (see postChangeFingerprintsOf).
            detail.postChange = { ...postChangeFingerprintsOf({ projectNo: input.projectNo, pairs: pairing.pairs, comparison, demandFacts, templateFields, specSlotDeclared: input.specSlotDeclared, nameAndSpecDeclared }) }
          } else kind = 'continuation_candidate'
        }
      }
      subject.oldRootRecordId = (recordRefOf(root.row) || {}).id || null
      subject.newRootKeyDigest = subjectDigest(position.key)
    }
    const hold = makeHold({
      kind,
      confirmable: kind === 'continuation_candidate',
      ...candidateHoldFields(kind),
      ...(shapeToken ? { shapeToken } : {}),
      subject,
      ...fingerprints,
      detail,
    })
    holds.push(hold)
    // Whatever the hold, the displayed plan shows what it protects: no ADD of the candidate's new
    // subtree, no INACTIVE of its old one (design §6.6 last paragraph). An OCCUPIED new-subtree key (an
    // inactive tombstone or an active copy already at the position) is kept in its own map so the planner
    // SKIPs it too instead of reviving / patching it inside a suspended plan (TD-15(i), O-5).
    for (const row of newSubtree) {
      const entryKey = keyOf(row)
      if (!entryKey) continue
      if (existingKeyed.has(entryKey)) candidateOccupiedKeys.set(entryKey, hold.fingerprint)
      else candidateSuppressAddKeys.set(entryKey, hold.fingerprint)
    }
    // BASE keys (TD-14; see claimOldRootRowSubtree): the sweep's lookup strips, so the claim is stored stripped.
    for (const row of oldSubtree) candidateProtectKeys.set(baseKeyOf(keyOf(row)), hold.fingerprint)
  }
  return { holds, candidateSuppressAddKeys, candidateOccupiedKeys, candidateProtectKeys }
}

/**
 * Design §6.6 step 4 — a dropped order head whose component has NO existing root row (first pull, or a
 * component never prepared on its own): plan §10 Q1. A hold without a confirm control, one per
 * component. ALSO (beyond the design's text, same fail-closed direction): a head dropped by a base rule
 * whose component is expanded NOWHERE in this read (`expandedOccurrences.count === 0`) — root selection
 * dropped it as "a child elsewhere" and it is not; the old flow would sweep its old rows, if any, and the
 * demand would vanish without anybody being asked. When the read cannot rule such a head out (recorder
 * absent, capture error, a gap that could hide any line), one project-level
 * `candidate_incomplete_evidence` hold instead: the unknown suspends.
 */
function detectDroppedHeads(context) {
  const { input, existingRows } = context
  const usability = evidenceUsability(input.demandEvidence)
  if (!usability.usable) {
    return [makeHold({
      kind: 'candidate_incomplete_evidence',
      confirmable: false,
      notConfirmableReason: 'evidence_incomplete',
      subject: { scope: 'project' },
      detail: { scope: 'project', unusableReason: usability.reason, reasons: usability.reasons },
    })]
  }
  // O-7 (PR-3a, T-ratified 2026-10-23): only an ACTIVE root row counts as "the component already has its own
  // rows". An inactive remnant does not, so a head dropped by a base rule and expanded under another parent
  // holds here instead of the copy being ADDed with no hold.
  const rootComponents = new Set(existingRows.filter((row) => isRootRow(row) && isActiveRow(row)).map((row) => row.componentSourceId).filter(nonBlankString))
  const byComponent = new Map()
  for (const observation of input.demandEvidence.observations) {
    if (!isPlainObject(observation) || observation.source !== 'order' || !isBaseDrop(observation)) continue
    if (!nonBlankString(observation.componentSourceId)) continue
    const expandedNowhere = isPlainObject(observation.expandedOccurrences) && observation.expandedOccurrences.count === 0
    if (rootComponents.has(observation.componentSourceId) && !expandedNowhere) continue
    if (!byComponent.has(observation.componentSourceId)) byComponent.set(observation.componentSourceId, [])
    byComponent.get(observation.componentSourceId).push(observation)
  }
  return Array.from(byComponent.keys()).sort(compareStrings).map((component) => makeHold({
    kind: 'dropped_order_head_unresolved',
    confirmable: false,
    notConfirmableReason: 'customer_rule_pending',
    subject: { componentSourceIdDigest: subjectDigest(component) },
    detail: {
      componentSourceId: component,
      observationDigests: sortedUnique(byComponent.get(component).map((observation) => observation.digest).filter(nonBlankString)),
      rules: sortedUnique(byComponent.get(component).map((observation) => observation.rule)),
      expandedOccurrences: byComponent.get(component).map((observation) => (isPlainObject(observation.expandedOccurrences) ? observation.expandedOccurrences.count : null)),
      history: 'history_unknown',
    },
  }))
}

// ── re-emitted holds and their keys (PR-3a: AMB-1 / TD-10, TD-15(ii), TD-29) ───────────────────────

/** AMB-1: re-emit iff runbook-only, or (pilot cleared AND a kind only pilot detection produces). */
function shouldReemitPersistedHold(entry, pilot) {
  if (entry.runbookOnly === true) return true
  if (pilot === true) return false
  return isPilotDetectionHoldKind(entry.kind, entry.detail)
}

/**
 * A persisted hold as the planner emits it: the `makeHold` key layout, with the STORED fingerprint copied
 * (never `holdFingerprint(body)`): the store keeps an open hold by fingerprint, so the next reconcile keeps
 * this row instead of superseding it and opening a recomputed twin.
 */
function reemittedHold(entry) {
  const hold = {
    kind: entry.kind,
    confirmable: entry.confirmable === true,
    ...(entry.confirmable === true ? {} : { notConfirmableReason: entry.notConfirmableReason }),
    ...(entry.shapeToken ? { shapeToken: entry.shapeToken } : {}),
    ...(entry.continuationId ? { continuationId: entry.continuationId } : {}),
    subject: entry.subject,
    ...(entry.evidenceFingerprint ? { evidenceFingerprint: entry.evidenceFingerprint } : {}),
    ...(entry.comparisonFingerprint ? { comparisonFingerprint: entry.comparisonFingerprint } : {}),
    ...(entry.pairingFingerprint ? { pairingFingerprint: entry.pairingFingerprint } : {}),
    detail: entry.detail,
  }
  hold.fingerprint = entry.fingerprint
  return hold
}

// First claim wins (a key two holds name keeps the first fingerprint; the SKIP decision is the same).
function claimKey(map, key, fingerprint) {
  if (nonBlankString(key) && !map.has(key)) map.set(key, fingerprint)
}

// A new position (an expansion key) with its expansion subtree: free keys are not ADDed, occupied ones are
// not revived / patched.
function claimNewPositionSubtree(context, key, fingerprint, maps) {
  const rows = context.rawExpandedKeyed.get(key)
  if (!rows || rows.length === 0) return
  const tokens = pathTokensOf(rows[0])
  const subtree = tokens ? subtreeRows(context.expandedRowsComposed, tokens) : [rows[0]]
  for (const row of subtree) {
    const entryKey = keyOf(row)
    if (!entryKey) continue
    claimKey(context.existingKeyed.has(entryKey) ? maps.occupied : maps.suppress, entryKey, fingerprint)
  }
}

// An existing (active) root row with its active, keyed existing subtree: not swept.
function claimOldRootRowSubtree(context, rootRow, fingerprint, maps) {
  const tokens = pathTokensOf(rootRow)
  const subtree = tokens ? subtreeRows(context.existingRows, tokens, (row) => keyOf(row) !== null && isActiveRow(row)) : [rootRow]
  // BASE keys (TD-14): an EXISTING row's key may carry the planner's `::duplicate:` suffix (an earlier
  // duplicate-resolved ADD); the sweep looks its base up, so the claim is stored by base (PR-4 F-15a).
  for (const row of subtree) claimKey(maps.protect, baseKeyOf(keyOf(row)), fingerprint)
}

function claimOldRootKeySubtree(context, key, fingerprint, maps) {
  const rows = context.existingKeyed.get(key)
  const root = rows ? rows.find(isActiveRow) : null
  if (root) claimOldRootRowSubtree(context, root, fingerprint, maps)
}

// A dropped order head (TD-15(ii), O-7): every expansion position of the component with its subtree, and
// every active root row of the component with its subtree.
function claimDroppedHeadKeys(context, componentSourceId, fingerprint, maps) {
  if (!nonBlankString(componentSourceId)) return
  for (const [entryKey, rows] of context.rawExpandedKeyed.entries()) {
    if (rows[0] && rows[0].componentSourceId === componentSourceId) claimNewPositionSubtree(context, entryKey, fingerprint, maps)
  }
  for (const row of context.existingRows) {
    if (isRootRow(row) && isActiveRow(row) && row.componentSourceId === componentSourceId) claimOldRootRowSubtree(context, row, fingerprint, maps)
  }
}

/**
 * The keys a RE-EMITTED hold protects (R-15 / TD-29), from what its own `detail` names: a candidate's new
 * positions and old roots (a project-level `candidate_incomplete_evidence` names none); a dropped head's
 * component; a runbook-only relationship hold's continuation roots (`continuationRoots`, attached by the lane
 * from the consult's continuation of ANY status) plus its pairs when present. A content change names no
 * position (its row's decision stays what the planner computed; the suspension dominates).
 */
function claimReemittedHoldKeys(context, entry, fingerprint, maps) {
  const detail = isPlainObject(entry.detail) ? entry.detail : {}
  if (entry.kind === 'dropped_order_head_unresolved') {
    claimDroppedHeadKeys(context, detail.componentSourceId, fingerprint, maps)
  } else if (entry.kind === 'continuation_candidate' || entry.kind.startsWith('candidate_')) {
    if (detail.scope !== 'project') {
      for (const key of Array.isArray(detail.newPositionKeys) ? detail.newPositionKeys : []) claimNewPositionSubtree(context, key, fingerprint, maps)
      for (const key of Array.isArray(detail.oldRootKeys) ? detail.oldRootKeys : []) claimOldRootKeySubtree(context, key, fingerprint, maps)
    }
  }
  if (entry.continuationRoots) {
    claimNewPositionSubtree(context, entry.continuationRoots.newRootKey, fingerprint, maps)
    claimOldRootKeySubtree(context, entry.continuationRoots.oldRootKey, fingerprint, maps)
  }
  if (entry.continuationRoots || entry.kind.startsWith('relationship_')) {
    for (const pair of Array.isArray(detail.pairs) ? detail.pairs : []) {
      if (!isPlainObject(pair)) continue
      if (nonBlankString(pair.newKey)) claimKey(context.existingKeyed.has(pair.newKey) ? maps.occupied : maps.suppress, pair.newKey, fingerprint)
      if (nonBlankString(pair.oldKey)) claimKey(maps.protect, pair.oldKey, fingerprint)
    }
  }
}

// ── the planner seam ──────────────────────────────────────────────────────────────────────────────

/**
 * Everything the planner needs for a governed plan, computed ONCE before its main loop from the same
 * grouped maps the planner itself uses. Returns the projection, the candidate sets, the holds so far and
 * the two per-row hooks the planner calls (`noteContentChange`, `noteStructureChange`), plus `finalize`.
 */
function prepareGovernedPlanning(args) {
  const {
    input,
    template,
    installedFieldProperties,
    expandedRows,
    existingRows,
    expanded,
    existing,
    duplicateExistingKeys,
    parentIndex,
    declaredExtensionFieldIds,
    humanFields,
    // Step 5 PR-8: the confirmed change plan's AUTHORIZATION — present only on the planner's second pass, after its
    // first pass found exactly the plan's change set (`authorizationFromRecords`); never part of the closed input.
    authorization = null,
  } = args
  const templateFields = fieldMapForTemplate(template)
  const projection = buildContinuationProjection(input.continuations, input.members)
  const triggerFieldIds = contentTriggerFieldIds({ template, installedFieldProperties })
  const nameAndSpecDeclared = triggerFieldIds.includes('ext_nameAndSpec')
    && declaredExtensionFieldIds instanceof Set && declaredExtensionFieldIds.has('ext_nameAndSpec')
  const expandedRowsComposed = expandedRows.map((row) => withDenormalizedPlmFields(row, parentIndex, declaredExtensionFieldIds))
  const context = {
    input,
    expandedRowsComposed,
    rawExpandedKeyed: expanded.keyed,
    existingKeyed: existing.keyed,
    existingMissing: existing.missing,
    duplicateExistingKeys,
    existingRows,
    projection,
    templateFields,
    nameAndSpecDeclared,
  }

  const holds = []
  const verdicts = {}
  const failedVerifications = []
  for (const continuation of input.continuations.slice().sort((left, right) => compareStrings(left.id, right.id))) {
    const result = verifyContinuation(context, continuation, projection.byContinuation.get(continuation.id))
    verdicts[continuation.id] = result.verdict
    // Step 5 PR-8: the content change of a relationship the confirmed plan covers is the AUTHORIZED one (the first
    // pass proved its post-change pair is the relationship's stamp): no hold — its old rows get the plan's UPDATEs.
    // The verdict is still reported (`content_changed`, which never moves the relationship's status).
    const covered = authorization && result.verdict === 'content_changed' && authorization.coveredContinuationIds.has(continuation.id)
    const hold = covered ? null : verificationHold(continuation, result)
    if (hold) holds.push(hold)
    if (hold && result.verdict !== 'valid') failedVerifications.push({ oldRootKey: continuation.oldRootKey, fingerprint: hold.fingerprint })
  }
  // The three candidate maps the planner consults (base keys -> the hold fingerprint its SKIP names):
  // `suppress` (no ADD at a free new-subtree key), `occupied` (no UPDATE / revive at an occupied one),
  // `protect` (no INACTIVE of an old-subtree row).
  const maps = { suppress: new Map(), occupied: new Map(), protect: new Map() }
  if (input.pilot === true) {
    const detected = detectCandidates(context)
    holds.push(...detected.holds)
    maps.suppress = detected.candidateSuppressAddKeys
    maps.occupied = detected.candidateOccupiedKeys
    maps.protect = detected.candidateProtectKeys
    const dropped = detectDroppedHeads(context)
    holds.push(...dropped)
    // TD-15(ii) / O-7: a dropped head's own rows are protected and its copies are not ADDed in the displayed plan.
    for (const hold of dropped) {
      if (hold.kind === 'dropped_order_head_unresolved') claimDroppedHeadKeys(context, hold.detail.componentSourceId, hold.fingerprint, maps)
    }
  }
  // TD-15(ii): every row under the old root of a continuation whose verdict is not `valid` is protected (a
  // member is already protected by the projection; an extra row under the continued old subtree is not).
  for (const failed of failedVerifications) claimOldRootKeySubtree(context, failed.oldRootKey, failed.fingerprint, maps)

  // AMB-1 / TD-10 (PR-3a) — PILOT EXIT KEEPS THE HOLDS. A persisted open hold that only pilot detection could
  // re-create (a candidate, a dropped head, a pilot content change) is re-emitted VERBATIM once the marker is
  // cleared, and a runbook-only hold (an escalated relationship) is re-emitted always: the next reconcile then
  // KEEPS it (same stored fingerprint) instead of superseding it, the plan stays suspended, and both refusal
  // layers keep holding. The stored fingerprint is copied, never recomputed through `makeHold` — an escalated
  // row's body no longer hashes to its fingerprint (the store rewrote `confirmable` / the reason), and a
  // recomputed one would open a duplicate on every computation. The keys it names feed the same three maps
  // detection feeds (TD-29), so the displayed plan never contradicts it.
  for (const entry of input.persistedHolds) {
    if (!shouldReemitPersistedHold(entry, input.pilot === true)) continue
    const hold = reemittedHold(entry)
    holds.push(hold)
    claimReemittedHoldKeys(context, entry, hold.fingerprint, maps)
  }
  const candidateSuppressAddKeys = maps.suppress
  const candidateOccupiedKeys = maps.occupied
  const candidateProtectKeys = maps.protect

  const humanFieldIds = Array.isArray(humanFields) ? humanFields.slice() : []
  const rowHolds = new Map()
  function subjectFor(existingRow, key) {
    const ref = recordRefOf(existingRow)
    return ref ? { recordId: ref.id } : { keyDigest: subjectDigest(key) }
  }
  // Step 5 PR-8 (refutation M4): the records a confirmed plan writes stay under content detection on EVERY pass,
  // pilot or not — after a pilot exit the confirmed change is still found (so it matches, is executed and reviewed).
  const forcedRecordIds = input.changePlan ? new Set(input.changePlan.recordIds) : null
  // Review fix N3 (C06 「复核前后再发生相关变化，旧复核不再有效，重新挂起」): the content the reviews and the pending written
  // plan left on the sheet. Those rows stay under content detection on every pass (pilot or not), and a cell of them the
  // sheet no longer carries is held even when the source moved to exactly that value. Round 2 (N3-a): indexed by record
  // KEY as well as by record id — a row under a reviewed / written key is compared whatever its record id (the reviewed
  // row deleted and re-created under its key carries a new id, V8D-03), and a key whose row is gone is held when the
  // source no longer carries the reviewed value (V8D-04, `noteMissingReviewedRow`).
  const expectedEntries = Array.isArray(input.expectedContent) ? input.expectedContent : []
  const expectedByRecordId = new Map(expectedEntries.map((entry) => [entry.recordId, entry]))
  const expectedByKey = new Map(expectedEntries.map((entry) => [entry.key, entry]))
  // The expected content of the row under `key`: the entry its record id names when that entry is under the same key,
  // else (N3-a) the entry of the KEY itself.
  function expectedEntryFor(existingRow, key) {
    const ref = recordRefOf(existingRow)
    const byId = ref ? expectedByRecordId.get(ref.id) : null
    if (byId && byId.key === key) return byId
    return expectedByKey.get(key) || null
  }
  // The trigger cells of `existingRow` that differ from what the reviews / the written plan left under its key
  // (canonical, the writer's normalisation). Sorted.
  function reviewedContentMovesOf(existingRow, key) {
    const entry = expectedEntryFor(existingRow, key)
    if (!entry) return []
    const moved = []
    for (const [fieldId, cell] of Object.entries(entry.fields)) {
      if (!triggerFieldIds.includes(fieldId)) continue
      const current = canonicalChangeValue(existingRow[fieldId], templateFields.get(fieldId))
      if (canonicalJson(current === undefined ? null : current) !== canonicalJson(cell.afterCanonical === undefined ? null : cell.afterCanonical)) moved.push(fieldId)
    }
    return moved.sort(compareStrings)
  }
  // The authorized entry a record id names, only when the row is the one the plan bound (same id AND same key).
  function authorizedEntryFor(existingRow) {
    if (!authorization) return null
    const ref = recordRefOf(existingRow)
    if (!ref) return null
    const entry = authorization.records.get(ref.id)
    return entry && entry.key === keyOf(existingRow) ? entry : null
  }
  return {
    pilot: input.pilot === true,
    projection,
    candidateSuppressAddKeys,
    candidateOccupiedKeys,
    candidateProtectKeys,
    triggerFieldIds,
    authorization,
    // Content detection for this existing row on a governed plan: the pilot marker, a record the confirmed plan writes
    // (M4), or a row whose content the reviews / the pending written plan left (review fix N3) — by its KEY (round 2,
    // N3-a: whatever its record id, and before the record-ref check: a re-created row is still the reviewed position).
    detectsContentOf(existingRow) {
      if (input.pilot === true) return true
      if (expectedByKey.has(keyOf(existingRow))) return true
      const ref = recordRefOf(existingRow)
      if (!ref) return false
      return Boolean((forcedRecordIds && forcedRecordIds.has(ref.id)) || expectedByRecordId.has(ref.id))
    },
    // Review fix N3-a (round 2, the inactive sibling): a row under a reviewed / written KEY stays under content detection
    // even while INACTIVE (the source dropped it and the sweep marked it inactive). The step-4 rule "a revive is not a
    // content change" would otherwise let the source bring the row back with content nobody reviewed, unheld. Keys with
    // no reviewed / written content keep that rule.
    isReviewedKey(existingRow) {
      return expectedByKey.has(keyOf(existingRow))
    },
    // Step 5 PR-8: the authorized change of a NOT-continued row (null otherwise).
    authorizedChangeFor(existingRow) {
      const entry = authorizedEntryFor(existingRow)
      return entry && !entry.inContinuation ? entry : null
    },
    // Step 5 PR-8: the authorized change of a continued relationship's OLD (protected) row, by BASE key and record id.
    authorizedContinuedUpdateFor(key, existingRow) {
      if (!authorization) return null
      const entry = authorization.continuedOldKeys.get(baseKeyOf(key))
      const ref = recordRefOf(existingRow)
      return entry && ref && ref.id === entry.recordId ? entry : null
    },
    // Which continuation (if any) claims a key, and from which end. BASE key (TD-14).
    continuedRefFor(key) {
      const base = baseKeyOf(key)
      const suppressed = projection.suppressAddKeys.get(base)
      if (suppressed) return { ref: suppressed, type: CONTINUATION_SKIP_TYPES.continued }
      const protectedRef = projection.protectInactiveKeys.get(base)
      if (protectedRef) return { ref: protectedRef, type: CONTINUATION_SKIP_TYPES.protected }
      return null
    },
    // A candidate's new-subtree key, free or occupied (TD-15(i)): the hold fingerprint its SKIP names, else
    // null. BASE key (TD-14).
    candidatePositionHoldFor(key) {
      const base = baseKeyOf(key)
      return candidateSuppressAddKeys.get(base) || candidateOccupiedKeys.get(base) || null
    },
    // A candidate's (or a failed relationship's, or a dropped head's) old-subtree key: the hold fingerprint
    // its SKIP names, else null. BASE key (TD-14).
    candidateProtectHoldFor(key) {
      return candidateProtectKeys.get(baseKeyOf(key)) || null
    },
    // Design §6.7 (pilot), and D-4 (governed: a legacy identity hold becomes a step-4 hold).
    noteContentChange(row, existingRow, { reason }) {
      const key = keyOf(existingRow)
      if (!key || rowHolds.has(key)) return
      // Step 5 PR-8: the confirmed plan's own change of this row is authorized (the planner emits its UPDATE).
      if (authorizedEntryFor(existingRow)) return
      const fields = contentTriggerChanges(row, existingRow, { triggerFieldIds, templateFields })
      // Review fix N3 (C06; design §10.3 (4) "any later relevant change invalidates"): the source did not change against
      // the sheet, but a cell a review (or the pending written plan) left under this row's key is no longer there — the
      // source and a host-side write moved it TOGETHER (pg lens V8PG-15), so no ordinary detection fires and the old review
      // would stay "valid" over content nobody reviewed. It is held like any content change: from the reviewed / written
      // value (`before`, the C06 baseline the review chain continues from) to the source value (`after`, which the sheet
      // already holds — the controlled update rewrites it), reason `reviewed_content_moved`.
      const moved = fields.length === 0 ? reviewedContentMovesOf(existingRow, key) : []
      if (fields.length === 0 && moved.length === 0) return
      const ref = recordRefOf(existingRow)
      const expected = moved.length > 0 ? expectedEntryFor(existingRow, key) : null
      rowHolds.set(key, makeHold({
        kind: 'content_change',
        confirmable: false,
        notConfirmableReason: 'needs_step5',
        subject: subjectFor(existingRow, key),
        detail: {
          recordId: ref ? ref.id : null,
          recordVersion: ref ? ref.version : null,
          key,
          reason: moved.length > 0 ? REVIEWED_CONTENT_MOVED_REASON : reason,
          fields: moved.length > 0
            ? Object.fromEntries(moved.map((fieldId) => [fieldId, {
              before: expected.fields[fieldId].after === undefined ? null : expected.fields[fieldId].after,
              after: row[fieldId] === undefined ? null : row[fieldId],
            }]))
            : Object.fromEntries(fields.map((fieldId) => [fieldId, {
              before: existingRow[fieldId] === undefined ? null : existingRow[fieldId],
              after: row[fieldId] === undefined ? null : row[fieldId],
            }])),
          inContinuation: null,
          humanColumnsPresent: Object.fromEntries(humanFieldIds.map((fieldId) => [fieldId, !isBlank(existingRow[fieldId])])),
        },
      }))
    },
    // Review fix N3-a (round 2; delta probe V8D-04): the expansion carries `key`, the sheet has NO row under it, and the
    // reviews / the pending written plan left content there (the reviewed row was deleted — a person's action the PLM
    // column lock does not cover). When a trigger cell of the source differs (canonically) from what was reviewed /
    // written, the ADD would bring back content nobody reviewed: the key is HELD, a content_change with reason
    // `reviewed_content_moved`, before = the reviewed / written value, after = the source. There is no record to bind, so
    // a change-plan confirm answers `record_unbound` until a row is back under the key (its content is then compared by
    // key, `expectedEntryFor`). The planner's ADD decision stays as computed; the suspension dominates (no token is
    // minted), as for every content hold. A source that still carries the reviewed value is re-ADDed (nothing
    // unreviewed). Returns whether the key was held.
    noteMissingReviewedRow(row, key) {
      if (!key || rowHolds.has(key)) return false
      const entry = expectedByKey.get(key)
      if (!entry) return false
      const moved = []
      for (const [fieldId, cell] of Object.entries(entry.fields)) {
        if (!triggerFieldIds.includes(fieldId)) continue
        const source = canonicalChangeValue(row[fieldId], templateFields.get(fieldId))
        if (canonicalJson(source === undefined ? null : source) !== canonicalJson(cell.afterCanonical === undefined ? null : cell.afterCanonical)) moved.push(fieldId)
      }
      if (moved.length === 0) return false
      moved.sort(compareStrings)
      rowHolds.set(key, makeHold({
        kind: 'content_change',
        confirmable: false,
        notConfirmableReason: 'needs_step5',
        subject: subjectFor(null, key),
        detail: {
          recordId: null,
          recordVersion: null,
          key,
          reason: REVIEWED_CONTENT_MOVED_REASON,
          fields: Object.fromEntries(moved.map((fieldId) => [fieldId, {
            before: entry.fields[fieldId].after === undefined ? null : entry.fields[fieldId].after,
            after: row[fieldId] === undefined ? null : row[fieldId],
          }])),
          inContinuation: null,
          humanColumnsPresent: Object.fromEntries(humanFieldIds.map((fieldId) => [fieldId, false])),
        },
      }))
      return true
    },
    // D-4: a legacy lineage_mismatch on a governed project is a STRUCTURE hold (never acknowledgeable,
    // and never the content path — C07).
    noteStructureChange(existingRow, changedFieldIds) {
      const key = keyOf(existingRow)
      if (!key) return
      const ref = recordRefOf(existingRow)
      rowHolds.set(key, makeHold({
        kind: 'structure_change',
        confirmable: false,
        notConfirmableReason: 'phase_2',
        subject: subjectFor(existingRow, key),
        detail: { recordId: ref ? ref.id : null, key, changedFields: changedFieldIds.slice().sort(compareStrings) },
      }))
    },
    finalize(decisions) {
      const all = holds.concat(Array.from(rowHolds.values()))
      const byFingerprint = new Map()
      for (const hold of all) byFingerprint.set(hold.fingerprint, hold)
      const finalHolds = Array.from(byFingerprint.values())
        .sort((left, right) => compareStrings(left.kind, right.kind) || compareStrings(left.fingerprint, right.fingerprint))
      const skips = decisions.filter((decision) => decision.decision === DECISIONS.SKIP && decision.conflictSummary)
      const suspended = finalHolds.length > 0
      return {
        suspended,
        holds: finalHolds,
        summary: {
          pilot: input.pilot === true,
          consulted: input.continuations.length,
          verdicts: Object.fromEntries(Object.keys(verdicts).sort(compareStrings).map((id) => [id, verdicts[id]])),
          protectedOldRows: skips.filter((decision) => decision.conflictSummary.type === CONTINUATION_SKIP_TYPES.protected).length,
          suppressedNewRows: skips.filter((decision) => decision.conflictSummary.type === CONTINUATION_SKIP_TYPES.continued).length,
          candidateRows: skips.filter((decision) => decision.conflictSummary.type === CONTINUATION_SKIP_TYPES.candidate).length,
          holds: {
            count: finalHolds.length,
            confirmable: finalHolds.filter((hold) => hold.confirmable).length,
            kinds: countBy(finalHolds.map((hold) => hold.kind)),
          },
          suspended,
        },
      }
    },
  }
}

// ── change plans (batch-refresh step 5 PR-8; design §10.3 (1)-(5), plan §3.4) ──────────────────────
//
// PURE. The ONE derivation of a change plan's record set from content-class holds — the planner's pass 1 (in-memory
// hold bodies) and the store's confirm transaction (hold rows read under the state-row lock, i.e. after a JSONB round
// trip) both call it, so the plan fingerprint they each compute is the same function of the same holds.

// The holds a change-plan confirm resolves (and a confirmed plan authorizes): CONTENT changes only. A
// `relationship_reconfirm` whose current verdict is `content_changed` belongs here only when its own reason token is
// `needs_step5` — the planner emits that token only for a relationship whose stored status reason is re-confirmable
// (refutation M3); the store re-checks the relationship row under the lock.
const CONTENT_CLASS_HOLD_KINDS = Object.freeze(['content_change', 'relationship_content_change', 'candidate_content_differs'])
// C07 (plan §9.3): a STRUCTURE change anywhere on the project refuses the change-plan confirm (换物料 ID、子件增删、改挂
// 或配对变化与内容变化同时出现 ⇒ 整次保持挂起). The relationship verdicts that name a structure fact.
const STRUCTURE_VERDICTS = Object.freeze([
  'structure_changed',
  'new_position_removed',
  'new_position_occupied',
  'old_record_missing',
  'old_record_inactive',
  'old_record_replaced',
  'old_subtree_duplicate',
])
const STRUCTURE_CLASS_HOLD_KINDS = Object.freeze(['structure_change', 'candidate_structure_differs'])

function isReconfirmContentHold(hold) {
  return isPlainObject(hold) && hold.kind === 'relationship_reconfirm'
    && isPlainObject(hold.detail) && hold.detail.verdict === 'content_changed'
    && hold.notConfirmableReason === 'needs_step5'
}

function isContentClassHold(hold) {
  if (!isPlainObject(hold)) return false
  return CONTENT_CLASS_HOLD_KINDS.includes(hold.kind) || isReconfirmContentHold(hold)
}

function isStructureClassHold(hold) {
  if (!isPlainObject(hold)) return false
  if (STRUCTURE_CLASS_HOLD_KINDS.includes(hold.kind)) return true
  return hold.kind === 'relationship_reconfirm' && isPlainObject(hold.detail) && STRUCTURE_VERDICTS.includes(hold.detail.verdict)
}

function changePlanInputInvalid(reason, field) {
  return new StockPreparationContinuationError(500, CONTINUATION_ERROR_CODES.INPUT_INVALID, 'a content hold does not carry what a change plan needs', { reason, ...(field ? { field } : {}) })
}

function cellValue(value) {
  return value === undefined ? null : value
}

// One relationship / candidate content hold's records: every pair whose seven-item comparison says `differs`
// (design §6.4). The OLD side is the existing row the controlled update patches (its record id, its key); the after
// value is the new position's. THE S-ROOT RULE (plan §3.4 实施细则 2, design §6.4; register R-63 ⑥): the root's
// single-level usage keeps meaning "root demand" — when the root total changes, the root's `rawQuantity` receives the
// derived root total too, never the new parent edge (which `compareSevenItems` excludes from the comparison).
function pairRecordsOf(hold) {
  const detail = hold.detail
  if (!Array.isArray(detail.pairs) || detail.pairs.length === 0) throw changePlanInputInvalid('pairs_missing')
  if (!isPlainObject(detail.comparison) || !Array.isArray(detail.comparison.items)) throw changePlanInputInvalid('comparison_missing')
  const itemsByPath = new Map()
  for (const item of detail.comparison.items) {
    if (!isPlainObject(item) || !Array.isArray(item.relativePath) || !isPlainObject(item.fields)) throw changePlanInputInvalid('comparison_item_malformed')
    itemsByPath.set(JSON.stringify(item.relativePath), item)
  }
  const out = []
  for (const pair of detail.pairs) {
    if (!isPlainObject(pair) || !Array.isArray(pair.relativePath)) throw changePlanInputInvalid('pair_malformed')
    const item = itemsByPath.get(JSON.stringify(pair.relativePath))
    if (!item) throw changePlanInputInvalid('comparison_item_missing')
    const fields = {}
    for (const [fieldId, cell] of Object.entries(item.fields)) {
      if (!isPlainObject(cell) || cell.status !== 'differs') continue
      fields[fieldId] = { before: cellValue(cell.old), after: cellValue(cell.new) }
    }
    const root = pair.relativePath.length === 0
    if (root && fields.totalQuantity) {
      const raw = isPlainObject(item.fields.rawQuantity) ? item.fields.rawQuantity : {}
      fields.rawQuantity = { before: cellValue(raw.old), after: fields.totalQuantity.after }
    }
    if (Object.keys(fields).length === 0) continue
    out.push({
      recordId: nonBlankString(pair.oldRecordId) ? pair.oldRecordId : null,
      key: nonBlankString(pair.oldKey) ? pair.oldKey : null,
      root,
      inContinuation: hold.kind === 'candidate_content_differs' ? null : (nonBlankString(hold.continuationId) ? hold.continuationId : null),
      fields,
    })
  }
  return out
}

function contentChangeRecordsOf(hold) {
  const detail = hold.detail
  if (!isPlainObject(detail.fields)) throw changePlanInputInvalid('fields_missing')
  const fields = {}
  for (const [fieldId, cell] of Object.entries(detail.fields)) {
    if (!isPlainObject(cell)) throw changePlanInputInvalid('field_malformed')
    fields[fieldId] = { before: cellValue(cell.before), after: cellValue(cell.after) }
  }
  if (Object.keys(fields).length === 0) return []
  return [{
    recordId: nonBlankString(detail.recordId) ? detail.recordId : null,
    key: nonBlankString(detail.key) ? detail.key : null,
    root: false,
    inContinuation: null,
    fields,
  }]
}

/**
 * The record set a change plan binds, from the content-class holds it resolves: `[{ recordId, key, root,
 * inContinuation, fields: { [fieldId]: { before, after } } }]`, sorted by record id. Refuses (500
 * STOCK_PREP_CONTINUATION_INPUT_INVALID, `details.reason`): a hold that is not content-class (`not_content_class`), a
 * record without a record id (`record_unbound` — the reader could not bind the row), a record two holds describe
 * differently (`record_conflict`). Values are raw (as the holds carry them); the fingerprint and the digests below
 * canonicalise.
 */
function changePlanRecordsFromHolds(holds) {
  const byRecordId = new Map()
  for (const hold of Array.isArray(holds) ? holds : []) {
    if (!isContentClassHold(hold) || !isPlainObject(hold.detail)) throw changePlanInputInvalid('not_content_class')
    const records = hold.kind === 'content_change' ? contentChangeRecordsOf(hold) : pairRecordsOf(hold)
    for (const record of records) {
      if (!record.recordId || !record.key) throw changePlanInputInvalid('record_unbound')
      const existing = byRecordId.get(record.recordId)
      if (existing) {
        if (canonicalJson({ key: existing.key, fields: existing.fields }) !== canonicalJson({ key: record.key, fields: record.fields })) {
          throw changePlanInputInvalid('record_conflict')
        }
        continue
      }
      byRecordId.set(record.recordId, record)
    }
  }
  return Array.from(byRecordId.values()).sort((left, right) => compareStrings(left.recordId, right.recordId))
}

// The WRITE fields of a record (a field absorbed from a superseded written plan is review-only: shown and reviewed,
// never patched again and never part of the plan fingerprint).
function writeFieldsOf(record) {
  const out = {}
  for (const [fieldId, cell] of Object.entries(isPlainObject(record.fields) ? record.fields : {})) {
    if (isPlainObject(cell) && cell.reviewOnly !== true) out[fieldId] = cell
  }
  return out
}

/**
 * THE PLAN FINGERPRINT (design §4.3 as corrected, register R-63 ②): the WRITE fields' raw before / after per record
 * (record id + key) + the source content digest of the computation that opened the holds + the project. NO record
 * version (a person's edit never revokes the plan — A12, E-4) and NO generation token (the mandatory re-preview after
 * the confirm bumps it — D12): a computation whose change set equals the plan's authorizes it, any other does not.
 */
function changePlanFingerprintOf({ projectNo, records, sourceContentDigest }) {
  const body = []
  for (const record of Array.isArray(records) ? records : []) {
    const fields = {}
    for (const [fieldId, cell] of Object.entries(writeFieldsOf(record))) fields[fieldId] = { before: cellValue(cell.before), after: cellValue(cell.after) }
    if (Object.keys(fields).length === 0) continue
    body.push({ recordId: record.recordId, key: record.key, fields })
  }
  body.sort((left, right) => compareStrings(left.recordId, right.recordId))
  return fingerprintOf(SCHEMES.changePlan, { projectNo, sourceContentDigest: sourceContentDigest || null, records: body })
}

/** The template-normalized form of one cell — what the writer would send (the comparison normalisation mirrors it). */
function canonicalChangeValue(value, field) {
  return normalizeComparableValueForField(isBlank(value) ? null : value, field)
}

function contentDigestOf(entries) {
  entries.sort((left, right) => compareStrings(left[0], right[0]) || compareStrings(left[1], right[1]))
  return fingerprintOf(SCHEMES.changeContent, { rows: entries })
}

/**
 * The content a plan WRITES and asks a person to review, over EVERY field (write + review-only), from the canonical
 * after values the store recorded at confirm time (`afterCanonical`). `written_content_digest` is this; a review binds
 * it to the sheet through `currentContentDigestOf`.
 */
function plannedContentDigestOf(records) {
  const entries = []
  for (const record of Array.isArray(records) ? records : []) {
    for (const [fieldId, cell] of Object.entries(isPlainObject(record.fields) ? record.fields : {})) {
      entries.push([record.recordId, fieldId, isPlainObject(cell) && cell.afterCanonical !== undefined ? cell.afterCanonical : null])
    }
  }
  return contentDigestOf(entries)
}

/**
 * The same digest over what the SHEET holds now for the plan's records and fields (`rowsByRecordId`: logical rows from
 * the project-scoped reader, keyed by record id). A record that is gone digests as missing (never as "unchanged").
 */
function currentContentDigestOf({ records, rowsByRecordId, templateFields = new Map() }) {
  const entries = []
  for (const record of Array.isArray(records) ? records : []) {
    const row = rowsByRecordId instanceof Map ? rowsByRecordId.get(record.recordId) : undefined
    for (const fieldId of Object.keys(isPlainObject(record.fields) ? record.fields : {})) {
      entries.push([record.recordId, fieldId, row ? canonicalChangeValue(row[fieldId], templateFields.get(fieldId)) : { missing: true }])
    }
  }
  return contentDigestOf(entries)
}

/**
 * Step 5 PR-8 — THE VERDICT ON A CONFIRMED CHANGE PLAN, from the planner's FIRST pass (the governed plan computed
 * exactly as without a plan, content detection kept on for the plan's records): `matches` iff the content-class holds
 * of that pass describe EXACTLY the plan's change set (the plan fingerprint over the same record set + THIS
 * computation's source content digest) and every relationship content hold among them carries, as its post-change
 * pair, the stamp the confirm wrote on that relationship (C04 / C11). Anything else — an extra / missing / different
 * change, a moved source, an unstamped relationship, a candidate content hold still open — is `stale` (the plan is
 * invalidated by the reconciliation and the holds of the first pass stand). `matches` answers the AUTHORIZATION the
 * second pass plans with: the observed records by record id and by base key, the continued relationships' OLD keys,
 * the relationships whose content change it covers. Pure; values stay in-process.
 */
function changePlanAuthorizationOf({ input, holds }) {
  const plan = input && input.changePlan
  if (!plan) return Object.freeze({ verdict: null, reason: null, observedRecordCount: 0, authorization: null })
  const stale = (reason, observedRecordCount = 0) => Object.freeze({ verdict: 'stale', reason, observedRecordCount, authorization: null })
  const content = (Array.isArray(holds) ? holds : []).filter(isContentClassHold)
  if (content.some((hold) => hold.kind === 'candidate_content_differs')) return stale('candidate_open')
  let observed
  try {
    observed = changePlanRecordsFromHolds(content)
  } catch (error) {
    return stale('records_unbound')
  }
  if (observed.length === 0) return stale('no_change')
  if (changePlanFingerprintOf({ projectNo: input.projectNo, records: observed, sourceContentDigest: plan.currentSourceContentDigest }) !== plan.planFingerprint) {
    return stale('change_set_moved', observed.length)
  }
  const stamps = new Map(input.continuations.map((continuation) => [continuation.id, continuation]))
  const covered = new Set()
  for (const hold of content) {
    if (hold.kind !== 'relationship_content_change' && hold.kind !== 'relationship_reconfirm') continue
    const stamp = stamps.get(hold.continuationId)
    const post = isPlainObject(hold.detail) ? hold.detail.postChange : null
    if (!stamp || !isPlainObject(post) || post.comparisonFingerprint !== stamp.comparisonFingerprint || post.evidenceFingerprint !== stamp.evidenceFingerprint) {
      return stale('relationship_not_stamped', observed.length)
    }
    covered.add(hold.continuationId)
  }
  const records = new Map()
  const byKey = new Map()
  const continuedOldKeys = new Map()
  for (const record of observed) {
    const entry = Object.freeze({ ...record, writeFields: record.fields })
    records.set(entry.recordId, entry)
    byKey.set(baseKeyOf(entry.key), entry)
    if (entry.inContinuation) continuedOldKeys.set(baseKeyOf(entry.key), entry)
  }
  return Object.freeze({
    verdict: 'matches',
    reason: null,
    observedRecordCount: observed.length,
    authorization: Object.freeze({ changePlanId: plan.id, records, byKey, continuedOldKeys, coveredContinuationIds: covered }),
  })
}

module.exports = {
  SCHEMES,
  CONTINUATION_ERROR_CODES,
  CONTINUATION_STATUSES,
  CONTINUATION_VERDICTS,
  CONTINUATION_INPUT_KEYS,
  CONTINUATION_SKIP_TYPES,
  PERSISTED_HOLD_KEYS,
  // Review fix N3.
  EXPECTED_CONTENT_KEYS,
  REVIEWED_CONTENT_MOVED_REASON,
  RECONFIRMABLE_REASONS,
  HOLD_KINDS,
  SHAPE_TOKENS,
  NOT_CONFIRMABLE_REASONS,
  NON_TRIGGER_PACK_FIELD_IDS,
  // Step 5 PR-8: the change-plan vocabulary and the pure derivations shared by the planner and the store.
  CONTENT_CLASS_HOLD_KINDS,
  STRUCTURE_CLASS_HOLD_KINDS,
  STRUCTURE_VERDICTS,
  VOLATILE_DETAIL_KEYS,
  isContentClassHold,
  isStructureClassHold,
  changePlanRecordsFromHolds,
  changePlanFingerprintOf,
  canonicalChangeValue,
  plannedContentDigestOf,
  currentContentDigestOf,
  changePlanAuthorizationOf,
  postChangeFingerprintsOf,
  CHANGE_PLAN_INPUT_KEYS,
  StockPreparationContinuationError,
  assertContinuationPostCondition,
  buildContinuationProjection,
  compareSevenItems,
  contentTriggerChanges,
  contentTriggerFieldIds,
  evidenceFingerprintOf,
  holdFingerprint,
  machineBandFieldIds,
  normalizeContinuationInput,
  pairSubtrees,
  pairingFingerprintOf,
  pathTokensOf,
  prepareGovernedPlanning,
  projectDemandFacts,
  recordRefOf,
  relativePath,
  sheetMachineDigest,
  __internals: {
    baseKeyOf,
    canonicalJson,
    claimReemittedHoldKeys,
    detectCandidates,
    detectDroppedHeads,
    isPilotDetectionHoldKind,
    normalizePersistedHolds,
    reemittedHold,
    shouldReemitPersistedHold,
    evidenceUsability,
    expectedKeyForTokens,
    // Pre-enable hardening F-5 (O-6): the pilot readiness check reads "active" and "root" with THESE two
    // predicates, so the readiness refusal and the candidate filter it protects can never disagree.
    isActiveRow,
    isRootRow,
    isColdStartExempt,
    keyPathTokens,
    subjectDigest,
    verifyContinuation,
  },
}
