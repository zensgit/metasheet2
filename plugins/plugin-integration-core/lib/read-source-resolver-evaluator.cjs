'use strict'

// External-API read self-service — resolver_lookup R1: PURE multiplicity-rule evaluator (#1709, per
// docs/design/integration-read-source-resolver-lookup-runtime-design-lock-20260702.md).
//
// Scope fence: pure function. NO route, NO persistence, NO adapter, NO outbound call, NO S3-1 executor
// wiring INSIDE this module (this stays pure). The R2 executor wiring — approved-authorized and merged
// 2026-07-03 (#3526) — lives in read-source-read-runtime.cjs, which invokes this evaluator standalone.
// It consumes an S1-normalized `resolver_lookup` config (the R0
// contract surface: resolverRule / resolverSortDirection / resolverDiscriminatorValue / rule-specific
// multiplicityRuleField / fieldMap with exactly one target) plus a raw response object, locates the
// candidate container with the S3-1 own-property dotted walker, applies the declared multiplicity rule,
// and returns { evidence, data }. Evidence is ALWAYS routed through the values-free readSourceProbeEvidence
// builder — never a hand-built producer object — so no candidate value, sort/discriminator value, runtime
// key, fieldMap name, host, credential, or tenant id can ride into evidence. `data` is null on any failure;
// on success it carries ONLY the one configured resolver output target + value.
//
// Each rule keeps its OWN fail-closed detail — the 0/1/>1 trichotomy is exactly_one's rule alone, NOT a
// shared simplification: first_when_sorted fails closed on missing sort field / mixed types / tie at the
// winning position / cap reached; field_equals fails closed on zero or multiple discriminator matches.

const {
  READ_SOURCE_PROBE_ROW_CAP,
  READ_SOURCE_RESOLVER_RULES,
  readSourceProbeEvidence,
} = require('./read-source-probe-contract.cjs')

const RESOLVER_ERROR_TYPE = 'ReadSourceResolverError'
const RESOLVER_RULE_SET = new Set(READ_SOURCE_RESOLVER_RULES)

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

// S3-1 own-property dotted walk (prototype keys never resolve). Same semantics as read-source-read-runtime.
function walkOwnPath(root, path) {
  let current = root
  for (const segment of path.split('.')) {
    if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return { resolved: false, value: null }
    }
    current = current[segment]
  }
  return { resolved: true, value: current }
}

function locateContainer(raw, paths) {
  for (const path of paths) {
    const { resolved, value } = walkOwnPath(raw, path)
    if (resolved) return { located: true, value }
  }
  return { located: false, value: null }
}

function classifyContainerShape(value) {
  if (Array.isArray(value)) return { type: 'array', arrayLength: value.length }
  if (value === null) return { type: 'null', arrayLength: null }
  const type = typeof value
  if (type === 'object') return { type: 'object', arrayLength: null }
  if (type === 'string' || type === 'number' || type === 'boolean') return { type, arrayLength: null }
  return { type: 'other', arrayLength: null }
}

// Build a minimal probe-plan so evidence flows through the SAME values-free sanitizer as the probe/read
// paths. object/mode are structural (not row values); the resolver fields are carried in `result`.
function resolverPlan(config) {
  return {
    object: typeof config.object === 'string' ? config.object : 'unknown',
    mode: 'resolver_lookup',
    containers: [{ alias: 'primary' }],
  }
}

function outcome(config, container, result) {
  const plan = resolverPlan(config)
  const source = { ...result }
  if (container) source.containers = { primary: classifyContainerShape(container.value) }
  const evidence = readSourceProbeEvidence(plan, source)
  return { evidence, data: result.ok === true ? result.__data : null }
}

function fail(config, container, errorCode, extra) {
  return outcome(config, container, { ok: false, errorCode, errorType: RESOLVER_ERROR_TYPE, rule: config.resolverRule, ...extra })
}

// A blank resolved output (missing / null / empty-or-whitespace string) is resolver_field_missing — the
// resolver must NOT inherit S3-1's fail-soft `null` projection.
function isBlankResolved(value) {
  if (value === undefined || value === null) return true
  if (typeof value === 'string' && value.trim().length === 0) return true
  return false
}

// Project ONLY the one configured resolver output target from the winning row. Missing/null/blank →
// resolver_field_missing.
function projectWinner(config, container, winningRow, candidateCount, matchedCount) {
  const target = config.fieldMap[0]
  const { resolved, value } = walkOwnPath(winningRow, target.source)
  if (!resolved || isBlankResolved(value)) {
    return fail(config, container, 'READ_SOURCE_RESOLVER_FIELD_MISSING', { candidateCount, matchedCount, containerLocated: true, resolved: false })
  }
  return outcome(config, container, {
    ok: true,
    rule: config.resolverRule,
    candidateCount,
    matchedCount,
    containerLocated: true,
    resolved: true,
    __data: { resolver: { target: target.target, value } },
  })
}

// Sort-value comparability: all present values must share one comparable primitive type (all number or all
// string). Mixed / non-comparable (object/array/boolean/null) → shape mismatch for the sort field.
function sortValueType(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return 'number'
  if (typeof value === 'string') return 'string'
  return null // boolean, null, object, array, NaN, undefined — not orderable for a first_when_sorted key
}

/**
 * Evaluate a resolver_lookup config against a raw response object.
 *
 * @param {object} config  S1-normalized resolver_lookup config (resolverRule + rule-specific fields + fieldMap).
 * @param {*} raw          The raw response object to locate the candidate container within.
 * @param {{ rowCap?: number }} [options]  rowCap is dependency injection for tests only; defaults to the
 *   platform cap (never request-reachable in a caller).
 * @returns {{ evidence: object, data: (null | { resolver: { target: string, value: * } }) }}
 */
function evaluateResolver(config, raw, options = {}) {
  const rowCap = Number.isInteger(options.rowCap) && options.rowCap > 0 ? options.rowCap : READ_SOURCE_PROBE_ROW_CAP

  // Rule must be one of the three (config validator already enforces; the pure evaluator fail-closes too).
  if (!RESOLVER_RULE_SET.has(config.resolverRule)) {
    return fail(config, null, 'READ_SOURCE_RESOLVER_RULE_NOT_SUPPORTED', { containerLocated: false })
  }
  if (!Array.isArray(config.fieldMap) || config.fieldMap.length !== 1) {
    return fail(config, null, 'READ_SOURCE_RESOLVER_RULE_INVALID', { containerLocated: false })
  }

  // Locate the candidate container (own-property walk; first declared path that resolves wins).
  const container = locateContainer(raw, config.containerPaths)
  if (!container.located) {
    return fail(config, null, 'READ_SOURCE_RESOLVER_CONTAINER_NOT_FOUND', { containerLocated: false })
  }
  // The located container MUST be an array of plain objects.
  if (!Array.isArray(container.value) || !container.value.every(isPlainObject)) {
    return fail(config, container, 'READ_SOURCE_RESOLVER_SHAPE_MISMATCH', { containerLocated: true })
  }

  const candidates = container.value
  const candidateCount = candidates.length

  // Cap reached before the full candidate set could be observed → cannot prove uniqueness / first-in-total-
  // order / single-match on a possibly-truncated window. Fail-closed for EVERY rule (the read never returns
  // more than rowCap rows, so candidateCount === rowCap means the source may have had more).
  if (candidateCount >= rowCap) {
    return fail(config, container, 'READ_SOURCE_RESOLVER_CAP_REACHED', { candidateCount, containerLocated: true, capReached: true })
  }

  if (config.resolverRule === 'exactly_one') {
    if (candidateCount === 0) return fail(config, container, 'READ_SOURCE_RESOLVER_NO_MATCH', { candidateCount, containerLocated: true })
    if (candidateCount > 1) return fail(config, container, 'READ_SOURCE_RESOLVER_AMBIGUOUS', { candidateCount, containerLocated: true, ambiguous: true })
    return projectWinner(config, container, candidates[0], candidateCount, 1)
  }

  if (config.resolverRule === 'first_when_sorted') {
    if (candidateCount === 0) return fail(config, container, 'READ_SOURCE_RESOLVER_NO_MATCH', { candidateCount, containerLocated: true })
    const sortField = config.multiplicityRuleField
    const entries = []
    for (const row of candidates) {
      const { resolved, value } = walkOwnPath(row, sortField)
      if (!resolved) {
        // Sort field MISSING on any candidate row — cannot order the set.
        return fail(config, container, 'READ_SOURCE_RESOLVER_FIELD_MISSING', { candidateCount, containerLocated: true })
      }
      entries.push(value)
    }
    // All sort values must share one orderable primitive type.
    const types = new Set(entries.map(sortValueType))
    if (types.size !== 1 || types.has(null)) {
      return fail(config, container, 'READ_SOURCE_RESOLVER_SHAPE_MISMATCH', { candidateCount, containerLocated: true })
    }
    // Uniform ordering for the single primitive type (number or string) proven above.
    const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
    const sortedVals = [...entries].sort(config.resolverSortDirection === 'desc' ? (a, b) => cmp(b, a) : cmp)
    const winningVal = sortedVals[0]
    // Tie at the winning position (two candidates share the extreme sort value) → order is ambiguous.
    const winnersAtTop = entries.filter((v) => v === winningVal).length
    if (winnersAtTop > 1) {
      return fail(config, container, 'READ_SOURCE_RESOLVER_AMBIGUOUS', { candidateCount, containerLocated: true, ambiguous: true })
    }
    const winnerIdx = entries.findIndex((v) => v === winningVal)
    return projectWinner(config, container, candidates[winnerIdx], candidateCount, 1)
  }

  // field_equals: exactly one candidate whose discriminator field equals the declared enum-like value.
  const discField = config.multiplicityRuleField
  const discValue = config.resolverDiscriminatorValue
  const matches = []
  for (const row of candidates) {
    const { resolved, value } = walkOwnPath(row, discField)
    // Compare on the string form: the discriminator value is a bounded enum-like token, and target fields
    // commonly return the flag as a string or number ('Y' / 1 / true-token). Own-property missing → not a
    // match (not an error — a candidate simply lacks the discriminator).
    if (resolved && value !== null && value !== undefined && String(value) === discValue) matches.push(row)
  }
  const matchedCount = matches.length
  if (matchedCount === 0) return fail(config, container, 'READ_SOURCE_RESOLVER_NO_MATCH', { candidateCount, matchedCount, containerLocated: true })
  if (matchedCount > 1) return fail(config, container, 'READ_SOURCE_RESOLVER_AMBIGUOUS', { candidateCount, matchedCount, containerLocated: true, ambiguous: true })
  return projectWinner(config, container, matches[0], candidateCount, 1)
}

module.exports = {
  evaluateResolver,
  __internals: { walkOwnPath, locateContainer, classifyContainerShape, sortValueType, isBlankResolved },
}
