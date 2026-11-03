'use strict'

// Batch-refresh step 2b — DEMAND EVIDENCE, captured before root selection drops anything.
//
// WHY. 根选择 (stock-preparation-bom-expansion.cjs `selectOrderRootCandidates`) decides which order
// lines become BOM roots and keeps only COUNTS of the rest (`rootsFilteredOut`,
// `rootSelectionReport`). The order-head id is read only to filter the detail read and then
// forgotten. Batch-refresh phase 1 (plan §3.1) has to compare a project's demand across pulls —
// "S was ordered on its own, now it is inside P" — so it needs, per order line, what was read and
// what root selection did with it: path node, order head, detail line (or an explicit "unknown"),
// component, order quantity, and the exclusion / selection decision with its rule and the lines it
// was decided against. This module records exactly that.
//
// WHAT THIS MODULE IS NOT.
//   * Not wired. The expander creates a recorder only when its caller passes `demandEvidence`, and
//     in this change no caller does (storage, flag, migration and routes are step 2c / 2d).
//   * Not a hash input. The result rides the expansion as the sibling key `demandEvidence` — never
//     in `rows`, never in `summary`, never in dry-run `evidence` — and no existing hash reads the
//     expansion object whole (see the golden suite, which pins every one of them byte for byte).
//   * Not a reader. A hook receives only values the walk already holds; it has no adapter and
//     issues no read. Hooks are synchronous, so they cannot reorder the walk either.
//   * Not able to break a pull. Every hook goes through `openDemandEvidenceCapture`'s guard: the
//     first fault stops recording, the walk carries on untouched, and the evidence says
//     `capture_error` instead of pretending to be complete.
//
// VALUES-BEARING. Observations carry customer ids, drawing numbers and quantities. The object must
// only ever travel a permission-protected private channel (step 2c), never a log, a summary or a
// values-free evidence stanza.
//
// DETERMINISM. No timestamps, lane, tenant or revision in the body. Observations are put in a
// canonical order before refs are assigned, caps are applied after that order, and the
// fingerprint is a sha256 over a key-sorted serialization. The one input-order dependence that
// remains is inherited, not introduced: two 总图 tied on version are chosen by read order, so the
// rows already depend on it and the evidence reports what was chosen.

const crypto = require('node:crypto')

const DEMAND_EVIDENCE_SCHEME = 'stock-preparation/demand-evidence/v1'
const DEMAND_OBSERVATION_SCHEME = 'stock-preparation/demand-observation/v1'
const DEFAULT_MAX_OBSERVATIONS = 5000
const MAX_OBSERVATIONS_CEILING = 50000
const OCCURRENCE_PATH_LIMIT = 20
const RELATED_REF_LIMIT = 20

// THE CLOSED KEY SET of the opt-in. `orderDetailLineIdField` names the order-detail column that
// holds a stable line id where a deployment has one; it is SERVER-HELD capture config and must
// never become part of `readPlan` or the action, because both are hashed (dry-run revision, large
// artifact revision) and declaring it there would move every revision.
const DEMAND_EVIDENCE_OPTION_KEYS = Object.freeze(['orderDetailLineIdField', 'maxObservations'])
const IDENTIFIER_SHAPE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

const COMPLETENESS_STATUSES = Object.freeze(['complete', 'incomplete', 'project_not_found', 'capture_error'])

class StockPreparationDemandEvidenceError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'StockPreparationDemandEvidenceError'
    this.details = details
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}

// The expander's `toKey`, restated (requiring the expander from here would be a cycle): trimmed,
// never case-folded, blank => null.
function keyOf(value) {
  if (isBlank(value)) return null
  return String(typeof value === 'string' ? value.trim() : value)
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex')
}

// An UNKNOWN is a status object, never null and never an omitted key: "the source had no value"
// and "this run could not see a value" must stay distinguishable from each other and from a value.
function unknown(status) {
  return { status }
}

function identityOrBlank(value) {
  const key = keyOf(value)
  return key === null ? unknown('blank') : key
}

/**
 * Config-time normalizer for the opt-in. `undefined` / `null` / `false` => `null` (capture off).
 * `true` => defaults. An object => closed keys, refused rather than ignored, because an ignored
 * misspelling would store a capture config that does not describe what runs.
 */
function normalizeDemandEvidenceOptions(input) {
  if (input === undefined || input === null || input === false) return null
  if (input === true) return Object.freeze({ orderDetailLineIdField: undefined, maxObservations: DEFAULT_MAX_OBSERVATIONS })
  if (!isPlainObject(input)) {
    throw new StockPreparationDemandEvidenceError('demandEvidence must be true or an object', { field: 'demandEvidence' })
  }
  for (const key of Object.keys(input)) {
    if (!DEMAND_EVIDENCE_OPTION_KEYS.includes(key)) {
      throw new StockPreparationDemandEvidenceError(`demandEvidence.${key} is not a recognized key`, { field: `demandEvidence.${key}` })
    }
  }
  let orderDetailLineIdField
  if (input.orderDetailLineIdField !== undefined && input.orderDetailLineIdField !== null) {
    const field = typeof input.orderDetailLineIdField === 'string' ? input.orderDetailLineIdField.trim() : ''
    if (!IDENTIFIER_SHAPE.test(field)) {
      throw new StockPreparationDemandEvidenceError('demandEvidence.orderDetailLineIdField must be an identifier', { field: 'demandEvidence.orderDetailLineIdField' })
    }
    orderDetailLineIdField = field
  }
  let maxObservations = DEFAULT_MAX_OBSERVATIONS
  if (input.maxObservations !== undefined && input.maxObservations !== null) {
    const number = input.maxObservations
    if (!Number.isInteger(number) || number <= 0 || number > MAX_OBSERVATIONS_CEILING) {
      throw new StockPreparationDemandEvidenceError(
        `demandEvidence.maxObservations must be an integer between 1 and ${MAX_OBSERVATIONS_CEILING}`,
        { field: 'demandEvidence.maxObservations' },
      )
    }
    maxObservations = number
  }
  return Object.freeze({ orderDetailLineIdField, maxObservations })
}

// The detail-line id, read by the expander's own field rule (own key first, then exactly one
// case-insensitive match) but reporting WHY a value is missing instead of collapsing to undefined.
function readDetailLineId(detail, field) {
  if (!field) return unknown('not_declared')
  if (!isPlainObject(detail)) return unknown('column_absent')
  if (Object.prototype.hasOwnProperty.call(detail, field)) return identityOrBlank(detail[field])
  const normalized = field.toLowerCase()
  const matches = Object.keys(detail).filter((key) => key.toLowerCase() === normalized)
  if (matches.length === 0) return unknown('column_absent')
  if (matches.length > 1) return unknown('column_ambiguous')
  return identityOrBlank(detail[matches[0]])
}

function readSortHint(detail, field) {
  if (!field) return unknown('not_declared')
  if (!isPlainObject(detail)) return unknown('blank')
  let value
  if (Object.prototype.hasOwnProperty.call(detail, field)) value = detail[field]
  else {
    const normalized = field.toLowerCase()
    const matches = Object.keys(detail).filter((key) => key.toLowerCase() === normalized)
    value = matches.length === 1 ? detail[matches[0]] : undefined
  }
  return identityOrBlank(value)
}

function partValue(declared, value) {
  if (!declared) return unknown('not_declared')
  return identityOrBlank(value)
}

/**
 * The RAW recorder. Not called by the walk directly — `openDemandEvidenceCapture` wraps every
 * method so a fault here never reaches the walk. Reached through `module.exports` there, which is
 * also the seam the golden suite's throwing-recorder leg replaces.
 *
 * The walk is sequential, so "the current path node / order head / line" is a pointer, not a
 * handle: each hook speaks about the thing the walk is on.
 */
function createDemandEvidenceRecorder({ options, plan, rootSelection, explainRootSelection } = {}) {
  const pathNodes = []
  const orderHeads = []
  const observations = []
  const byCandidate = new Map()
  let currentPath = null
  let currentHead = null
  let currentLine = null
  let currentSubtree = null
  let rootSelectionUnexplained = false

  const codeDeclared = Boolean(plan && plan.part && plan.part.codeField)
  const versionDeclared = Boolean(plan && plan.part && plan.part.versionField)
  const sortField = plan && plan.orderDetail ? plan.orderDetail.sortField : undefined

  function newObservation(fields) {
    const observation = {
      source: 'order',
      pathId: currentPath ? currentPath.pathId : unknown('not_recorded'),
      orderHead: currentHead ? currentHead.orderHead : unknown('not_recorded'),
      detailLine: unknown('not_declared'),
      componentSourceId: unknown('not_evaluated'),
      componentCode: unknown('unavailable'),
      sourceVersion: unknown('unavailable'),
      orderQuantity: unknown('not_evaluated'),
      quantitySemantics: 'order_line',
      lineOrder: unknown('not_declared'),
      stage: 'line',
      exclusion: 'none',
      decision: 'not_applicable',
      rule: 'not_applicable',
      ruleDetail: {},
      rowProduced: false,
      related: [],
      ...fields,
    }
    observations.push(observation)
    return observation
  }

  return {
    pathNode(rawPathId, outcome) {
      currentPath = {
        pathId: identityOrBlank(rawPathId),
        outcome,
        orderHeadCount: unknown(outcome === 'ok' ? 'not_read' : 'not_applicable'),
      }
      currentHead = null
      pathNodes.push(currentPath)
    },
    orderHeadsRead(count) {
      if (currentPath) currentPath.orderHeadCount = count
    },
    orderHead(rawOrderId) {
      const id = keyOf(rawOrderId)
      currentHead = {
        pathId: currentPath ? currentPath.pathId : unknown('not_recorded'),
        orderHead: id === null ? unknown('blank') : id,
        lineCount: unknown(id === null ? 'not_applicable' : 'not_read'),
      }
      orderHeads.push(currentHead)
    },
    orderLinesRead(count) {
      if (currentHead) currentHead.lineCount = count
    },
    // One order-detail row the walk iterated. `quantity` is the walk's own parseQuantity result
    // (undefined when the walk never parsed it because the component id was missing).
    orderLine({ detail, componentSourceId, quantity }) {
      const fields = {
        detailLine: readDetailLineId(detail, options.orderDetailLineIdField),
        lineOrder: readSortHint(detail, sortField),
      }
      if (componentSourceId === null || componentSourceId === undefined) {
        fields.exclusion = 'component_id_missing'
        fields.componentSourceId = unknown('blank')
      } else {
        fields.componentSourceId = componentSourceId
        if (!quantity || quantity.ok !== true) {
          fields.exclusion = 'quantity_invalid'
          fields.orderQuantity = unknown('invalid')
        } else {
          fields.orderQuantity = quantity.value
          // Pending until the part read answers; a read that throws leaves it here, which is the
          // truth: the walk never learned what this line's part is.
          fields.stage = 'part'
          fields.exclusion = 'part_not_read'
        }
      }
      const observation = newObservation(fields)
      // Only a line still waiting on its part read can be spoken about by `orderLinePart`.
      currentLine = observation.stage === 'part' ? observation : null
    },
    // The part read for the current line. `candidate` is the object the walk pushed onto its root
    // candidate list (the identity root selection's result is expressed in), or undefined.
    orderLinePart(outcome, candidate) {
      if (!currentLine) return
      if (outcome !== 'found' || !candidate) {
        currentLine.exclusion = outcome === 'part_ambiguous' ? 'part_ambiguous' : 'part_missing'
        currentLine = null
        return
      }
      currentLine.stage = 'selection'
      currentLine.exclusion = 'none'
      currentLine.componentCode = partValue(codeDeclared, candidate.componentCode)
      currentLine.sourceVersion = partValue(versionDeclared, candidate.sourceVersion)
      byCandidate.set(candidate, currentLine)
      currentLine = null
    },
    rootSelection(candidates, result) {
      const explanations = explainRootSelection(candidates, result, rootSelection)
      // Every candidate was bound by `orderLinePart`; a missing binding is a recorder fault (the
      // guard turns the throw below into `capture_error`), never a silently unlabelled line.
      candidates.forEach((candidate, index) => {
        const observation = byCandidate.get(candidate)
        const explanation = explanations[index]
        observation.decision = explanation.decision
        observation.rule = explanation.rule
        observation.ruleDetail = explanation.ruleDetail || {}
        if (explanation.rule === 'unexplained') rootSelectionUnexplained = true
        observation.related = (explanation.related || [])
          .map((relatedIndex) => byCandidate.get(candidates[relatedIndex]))
          .filter(Boolean)
        observation.rowProduced = explanation.decision === 'selected' ? unknown('not_reached') : false
      })
    },
    rootRow(candidate, produced) {
      const observation = byCandidate.get(candidate)
      if (observation) observation.rowProduced = produced === true
    },
    subtreeRoot(rootSourceId, nodeId, alreadyExpanded) {
      currentSubtree = newObservation({
        source: 'project_subtree',
        pathId: identityOrBlank(nodeId),
        orderHead: unknown('not_applicable'),
        detailLine: unknown('not_applicable'),
        componentSourceId: identityOrBlank(rootSourceId),
        orderQuantity: unknown('not_applicable'),
        quantitySemantics: 'subtree_default',
        lineOrder: unknown('not_applicable'),
        stage: 'subtree',
        exclusion: alreadyExpanded ? 'subtree_already_expanded' : 'part_not_read',
        decision: alreadyExpanded ? 'skipped' : 'not_applicable',
        rule: alreadyExpanded ? 'subtree_already_expanded' : 'not_applicable',
      })
      if (alreadyExpanded) currentSubtree = null
    },
    subtreeRootPart(outcome, partInfo) {
      if (!currentSubtree) return
      if (outcome !== 'found') {
        currentSubtree.exclusion = outcome === 'part_ambiguous' ? 'part_ambiguous' : 'part_missing'
        currentSubtree = null
        return
      }
      currentSubtree.exclusion = 'none'
      currentSubtree.decision = 'selected'
      currentSubtree.rule = 'project_subtree_root'
      currentSubtree.componentCode = partValue(codeDeclared, partInfo && partInfo.componentCode)
      currentSubtree.sourceVersion = partValue(versionDeclared, partInfo && partInfo.sourceVersion)
      currentSubtree.rowProduced = unknown('not_reached')
    },
    subtreeRootRow(produced) {
      if (!currentSubtree) return
      currentSubtree.rowProduced = produced === true
      currentSubtree = null
    },
    finalize({ projectNo, result }) {
      return buildDemandEvidence({
        projectNo,
        result,
        options,
        plan,
        rootSelection,
        pathNodes,
        orderHeads,
        observations,
        rootSelectionUnexplained,
      })
    },
  }
}

// ── finalize ──────────────────────────────────────────────────────────────────────────────────

function sortToken(value) {
  if (typeof value === 'string') return `s:${value}`
  if (typeof value === 'number') return `n:${String(value)}`
  return `o:${stableStringify(value)}`
}

function compareTokens(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1
  }
  return 0
}

function canonicalOrder(entries, keyOfEntry) {
  return entries
    .map((entry) => ({ entry, key: keyOfEntry(entry) }))
    .sort((left, right) => compareTokens(left.key, right.key))
    .map((item) => item.entry)
}

// Same component somewhere BELOW depth 0 — "this part also appears inside another assembly". A
// count plus the first paths in canonical order; never deduped against the observation itself.
function occurrenceIndex(rows) {
  const index = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isPlainObject(row) || !(Number(row.depth) > 0)) continue
    const id = keyOf(row.componentSourceId)
    if (id === null) continue
    if (!index.has(id)) index.set(id, [])
    index.get(id).push(typeof row.path === 'string' ? row.path : stableStringify(row.path))
  }
  for (const paths of index.values()) paths.sort()
  return index
}

function rulesDigest(rootSelection) {
  return sha256(stableStringify(rootSelection === undefined ? null : rootSelection))
}

function countBy(list, keyOfItem) {
  const out = {}
  for (const item of list) {
    const key = keyOfItem(item)
    out[key] = (out[key] || 0) + 1
  }
  return Object.fromEntries(Object.keys(out).sort().map((key) => [key, out[key]]))
}

const EXCLUSIONS_THAT_MAKE_EVIDENCE_INCOMPLETE = new Set([
  'component_id_missing',
  'quantity_invalid',
  'part_missing',
  'part_ambiguous',
  'part_not_read',
])

function buildDemandEvidence({ projectNo, result, options, plan, rootSelection, pathNodes, orderHeads, observations, rootSelectionUnexplained }) {
  const expansion = isPlainObject(result) ? result : {}
  const summary = isPlainObject(expansion.summary) ? expansion.summary : {}
  const occurrences = occurrenceIndex(expansion.rows)

  // 1. Per-observation body (no refs yet), with its occurrence stanza.
  const bodies = observations.map((observation) => {
    const { related, ...rest } = observation
    const id = typeof observation.componentSourceId === 'string' ? observation.componentSourceId : null
    const paths = id === null ? [] : (occurrences.get(id) || [])
    const body = {
      ...rest,
      expandedOccurrences: {
        count: paths.length,
        paths: paths.slice(0, OCCURRENCE_PATH_LIMIT),
        truncated: paths.length > OCCURRENCE_PATH_LIMIT,
      },
    }
    return { observation, body, bodyText: stableStringify(body) }
  })
  // 2. Canonical order: (source, pathId, head, line, component, quantity, line order), then the
  //    whole body. Two observations tied on all of it are interchangeable: their relations are
  //    derived from values that are IN the body (component id, drawing number, version) against
  //    the same candidate set, so they relate to the same observations and swapping them moves no
  //    ref anywhere.
  const ordered = canonicalOrder(bodies, ({ observation, bodyText }) => [
    sortToken(observation.source),
    sortToken(observation.pathId),
    sortToken(observation.orderHead),
    sortToken(observation.detailLine),
    sortToken(observation.componentSourceId),
    sortToken(observation.orderQuantity),
    sortToken(observation.lineOrder),
    bodyText,
  ])

  // 3. Cap AFTER the canonical order, so the retained set does not depend on read order.
  const retained = ordered.slice(0, options.maxObservations)
  const refOf = new Map(retained.map((entry, index) => [entry.observation, `o${index + 1}`]))
  let relatedTruncated = false
  let pathsTruncated = false
  const outObservations = retained.map((entry, index) => {
    const relatedRefs = entry.observation.related
      .map((other) => refOf.get(other))
      .filter(Boolean)
      .sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)))
    if (relatedRefs.length > RELATED_REF_LIMIT) relatedTruncated = true
    if (entry.body.expandedOccurrences.truncated) pathsTruncated = true
    const { expandedOccurrences, ...digestBody } = entry.body
    return {
      ref: `o${index + 1}`,
      digest: sha256(stableStringify({ scheme: DEMAND_OBSERVATION_SCHEME, observation: digestBody })),
      ...entry.body,
      relatedRefs: relatedRefs.slice(0, RELATED_REF_LIMIT),
      relatedCount: entry.observation.related.length,
    }
  })

  // 4. Completeness. Every reason is a closed token; anything but `complete` means a later
  //    comparison must hold, never assume.
  const reasons = new Set()
  for (const error of Array.isArray(expansion.errors) ? expansion.errors : []) {
    if (isPlainObject(error) && typeof (error.type || error.code) === 'string') reasons.add(error.type || error.code)
  }
  if (summary.rowErrorsTruncated === true) reasons.add('row_errors_truncated')
  for (const node of pathNodes) if (node.outcome !== 'ok') reasons.add(node.outcome)
  for (const head of orderHeads) if (typeof head.orderHead !== 'string') reasons.add('missing_order_id')
  for (const observation of observations) {
    if (EXCLUSIONS_THAT_MAKE_EVIDENCE_INCOMPLETE.has(observation.exclusion)) reasons.add(observation.exclusion)
  }
  if (ordered.length > retained.length) reasons.add('observation_cap_exceeded')
  if (relatedTruncated) reasons.add('related_refs_truncated')
  if (pathsTruncated) reasons.add('occurrence_paths_truncated')
  if (rootSelectionUnexplained) reasons.add('root_selection_unexplained')
  const notFound = expansion.status === 'not_found'
  const status = notFound ? 'project_not_found' : (reasons.size === 0 ? 'complete' : 'incomplete')

  const orderObservations = observations.filter((observation) => observation.source === 'order')
  const subtreeObservations = observations.filter((observation) => observation.source === 'project_subtree')
  const counts = {
    pathNodes: pathNodes.length,
    orderHeads: orderHeads.length,
    observations: observations.length,
    observationsRetained: retained.length,
    bySource: { order: orderObservations.length, project_subtree: subtreeObservations.length },
    orderDecisions: countBy(orderObservations, (observation) => observation.decision),
    orderRules: countBy(orderObservations, (observation) => observation.rule),
    exclusions: countBy(observations, (observation) => observation.exclusion),
    subtreeDecisions: countBy(subtreeObservations, (observation) => observation.decision),
    rowsProduced: observations.filter((observation) => observation.rowProduced === true).length,
  }

  const header = {
    readPlanId: plan && plan.id ? plan.id : unknown('not_declared'),
    quantityField: plan && plan.orderDetail && plan.orderDetail.quantityField ? plan.orderDetail.quantityField : unknown('not_declared'),
    rootSelection: {
      mode: rootSelection && rootSelection.enabled === true ? 'enabled' : 'disabled',
      rulesDigest: rulesDigest(rootSelection),
    },
    projectSubtree: plan && plan.projectSubtree ? 'enabled' : 'disabled',
    identity: {
      orderHead: 'declared',
      orderDetailLine: options.orderDetailLineIdField
        ? { status: 'declared', field: options.orderDetailLineIdField }
        : unknown('not_declared'),
    },
  }

  const body = {
    header,
    completeness: {
      status,
      reasons: Array.from(reasons).sort(),
      totals: { observations: observations.length, observationsRetained: retained.length },
    },
    pathNodes: canonicalOrder(pathNodes.map((node) => ({ ...node })), (node) => [stableStringify(node)]),
    orderHeads: canonicalOrder(orderHeads.map((head) => ({ ...head })), (head) => [stableStringify(head)]),
    observations: outObservations,
    counts,
  }
  return {
    scheme: DEMAND_EVIDENCE_SCHEME,
    fingerprint: demandEvidenceFingerprint({ projectNo, body }),
    ...body,
  }
}

function demandEvidenceFingerprint({ projectNo, body }) {
  return sha256(stableStringify({ scheme: DEMAND_EVIDENCE_SCHEME, projectNo, body }))
}

// Recompute the fingerprint of a finished evidence object (what a later reader verifies).
function fingerprintOfDemandEvidence(evidence, projectNo) {
  if (!isPlainObject(evidence)) return null
  const { scheme, fingerprint, ...body } = evidence
  if (scheme !== DEMAND_EVIDENCE_SCHEME || typeof fingerprint !== 'string') return null
  return demandEvidenceFingerprint({ projectNo, body })
}

function captureErrorEvidence(reason) {
  return {
    scheme: DEMAND_EVIDENCE_SCHEME,
    completeness: { status: 'capture_error', reasons: [reason] },
  }
}

const RECORDER_HOOKS = Object.freeze([
  'pathNode',
  'orderHeadsRead',
  'orderHead',
  'orderLinesRead',
  'orderLine',
  'orderLinePart',
  'rootSelection',
  'rootRow',
  'subtreeRoot',
  'subtreeRootPart',
  'subtreeRootRow',
])

/**
 * THE ONLY ENTRY THE EXPANDER USES. Returns `null` when the caller did not ask (the walk then runs
 * exactly as before), otherwise a guarded recorder:
 *   * every hook returns `undefined` whatever the raw recorder returns, and swallows any throw —
 *     the first fault switches recording off for the rest of the run;
 *   * `finalize` always returns an evidence object: the real one, or `capture_error` with the
 *     stage that failed (`options_invalid`, `recorder_fault`, `finalize_fault`).
 * A capture problem is therefore visible in the evidence and invisible to the pull.
 */
function openDemandEvidenceCapture(request, context = {}) {
  // THE WALK-LEVEL GATE, deliberately wider than the config normalizer: capture is ON only for the
  // literal `true` or a plain object. Every other value — `0`, `''`, `NaN`, `1`, `'yes'`, an array —
  // is OFF and mounts no key, so a falsy-but-not-`false` value can never switch on a
  // `capture_error` stanza. (`normalizeDemandEvidenceOptions` still REFUSES those at config time;
  // that is the step-2c config contract, not this gate's.) A plain object with bad keys is ON and
  // answers `capture_error / options_invalid` without touching the walk.
  if (request !== true && !isPlainObject(request)) return null
  let fault = null
  let raw = null
  try {
    const options = normalizeDemandEvidenceOptions(request)
    try {
      raw = module.exports.createDemandEvidenceRecorder({ ...context, options })
    } catch {
      fault = 'recorder_fault'
    }
  } catch {
    fault = 'options_invalid'
  }
  const guarded = {}
  for (const name of RECORDER_HOOKS) {
    guarded[name] = (...args) => {
      if (fault !== null) return undefined
      try {
        raw[name](...args)
      } catch {
        fault = 'recorder_fault'
      }
      return undefined
    }
  }
  guarded.finalize = (final) => {
    if (fault === null) {
      try {
        return raw.finalize(final)
      } catch {
        fault = 'finalize_fault'
      }
    }
    return captureErrorEvidence(fault)
  }
  return Object.freeze(guarded)
}

module.exports = {
  DEMAND_EVIDENCE_SCHEME,
  DEMAND_OBSERVATION_SCHEME,
  DEMAND_EVIDENCE_OPTION_KEYS,
  DEFAULT_MAX_OBSERVATIONS,
  MAX_OBSERVATIONS_CEILING,
  OCCURRENCE_PATH_LIMIT,
  RELATED_REF_LIMIT,
  COMPLETENESS_STATUSES,
  StockPreparationDemandEvidenceError,
  normalizeDemandEvidenceOptions,
  openDemandEvidenceCapture,
  // Reached through `module.exports` by `openDemandEvidenceCapture` on purpose: the one seam a
  // test may replace to prove a faulting recorder cannot reach the walk.
  createDemandEvidenceRecorder,
  fingerprintOfDemandEvidence,
  __internals: {
    RECORDER_HOOKS,
    buildDemandEvidence,
    captureErrorEvidence,
    keyOf,
    readDetailLineId,
    stableStringify,
  },
}
