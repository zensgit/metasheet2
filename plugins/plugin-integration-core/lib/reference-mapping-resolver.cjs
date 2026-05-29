'use strict'

// DF-T3b-1: PURE reference-mapping resolver + index (LATENT). Given a DF-T3a template (#2043 manifest)
// + the domain's mapping rows (customer dictionary) + a sourceCode, decide the resolution OUTCOME
// (resolved / unresolved / ambiguous / incomplete). NO preview/Save wiring, NO from_reference_table
// runtime, NO K3 write — that is DF-T3b-2 (byte-parity-gated, a separate opt-in).
//
// Value boundary: the reference the caller composes lives on `outcome.reference` and NECESSARILY
// carries the customer `{FNumber|FID, FName}` values. `outcome.evidence` is VALUES-FREE — field /
// domain / sourceCode-PRESENCE / error-type only (the error-type tokens are locked by #2036/#2048).

const { normalizeReferenceMappingTemplate } = require('./reference-mapping-templates.cjs')

// Resolution status — the outcome vocabulary.
const OUTCOME = Object.freeze({
  RESOLVED: 'resolved',
  UNRESOLVED: 'unresolved',
  AMBIGUOUS: 'ambiguous',
  INCOMPLETE: 'incomplete',
})

// Evidence error-type tokens — LOCKED VERBATIM by #2036 P2 / #2048 (`unresolved` / `ambiguous` /
// `incomplete-row`). Deliberately distinct from OUTCOME.INCOMPLETE ('incomplete'): `status` is the
// outcome, `errorType` is the contract's evidence vocabulary. `resolved` → no errorType.
const STATUS_TO_ERROR_TYPE = Object.freeze({
  unresolved: 'unresolved',
  ambiguous: 'ambiguous',
  incomplete: 'incomplete-row',
})

function isBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

// The identifier component column for a template: FNumber → 'fNumber', FID → 'fID'.
function identifierColumn(identifier) {
  return identifier === 'FID' ? 'fID' : 'fNumber'
}

// sourceCode match normalization — trimmed + String-coerced, CASE-SENSITIVE. Applied identically on
// the index side and the query side so DF-T3b-2's byte-parity is stable. NEVER case-fold — a
// "helpful" lowercase would silently change resolution. Returns null for a blank source code.
function normalizeSourceCodeKey(value) {
  if (isBlank(value)) return null
  return String(typeof value === 'string' ? value.trim() : value)
}

// A row is "complete" iff its identifier component AND fName are both non-blank.
function isCompleteRow(row, idCol) {
  return isPlainObject(row) && !isBlank(row[idCol]) && !isBlank(row.fName)
}

// Build a per-run in-memory index keyed by normalized sourceCode. ONLY enabled rows (enabled !== false;
// an ABSENT enabled is treated as enabled) with a non-blank sourceCode are indexed. Each bucket keeps
// complete candidate refs + an incomplete count so resolution can distinguish unresolved (no rows)
// from incomplete (rows exist but lack components). Pure; no I/O, no cache — the caller bulk-reads
// rows and rebuilds per composition run. THROWS on a malformed template (only data conditions return
// outcomes; a bad template is a contract error).
function buildReferenceMappingIndex(template, rows) {
  const normalized = normalizeReferenceMappingTemplate(template)
  const idCol = identifierColumn(normalized.identifier)
  const buckets = new Map() // normalizedSourceCode → { complete: [refObj], incomplete: number }
  const rowList = Array.isArray(rows) ? rows : []
  for (const row of rowList) {
    if (!isPlainObject(row)) continue
    if (row.enabled === false) continue // enabled-only
    const key = normalizeSourceCodeKey(row.sourceCode)
    if (key === null) continue // blank sourceCode ignored
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { complete: [], incomplete: 0 }
      buckets.set(key, bucket)
    }
    if (isCompleteRow(row, idCol)) {
      // reference VALUES verbatim (no trim) — never mangle customer data (asymmetric vs the trimmed key).
      bucket.complete.push({ [normalized.identifier]: row[idCol], FName: row.fName })
    } else {
      bucket.incomplete += 1
    }
  }
  return { domain: normalized.domain, identifier: normalized.identifier, completeness: normalized.completeness, buckets }
}

function makeOutcome(status, domain, sourceCode, field, reference) {
  const evidence = { domain, sourceCodePresent: !isBlank(sourceCode) }
  if (field !== undefined) evidence.field = field
  const errorType = STATUS_TO_ERROR_TYPE[status]
  if (errorType) evidence.errorType = errorType
  const outcome = { status, evidence }
  if (reference !== undefined) outcome.reference = reference
  return outcome
}

// Resolve a single (domain, sourceCode) against a built index. Returns a values-free-evidence outcome;
// `reference` is set ONLY for 'resolved'. opts.field = optional target-field LABEL for evidence (e.g.
// 'FUnitID') — a field NAME, never a value.
function resolveReference(index, sourceCode, opts = {}) {
  const field = typeof opts.field === 'string' ? opts.field : undefined
  const domain = index && index.domain
  const key = normalizeSourceCodeKey(sourceCode)
  if (key === null) return makeOutcome(OUTCOME.UNRESOLVED, domain, sourceCode, field) // blank query
  const bucket = index.buckets.get(key)
  if (!bucket || (bucket.complete.length === 0 && bucket.incomplete === 0)) {
    return makeOutcome(OUTCOME.UNRESOLVED, domain, sourceCode, field) // no enabled rows for this code
  }
  if (bucket.complete.length >= 2) {
    // ambiguous → fail closed; NEVER pick first, NEVER dedup (keeps DF-T3b-2 parity order-independent).
    return makeOutcome(OUTCOME.AMBIGUOUS, domain, sourceCode, field)
  }
  if (bucket.complete.length === 1) {
    // exactly one complete row wins even if incomplete siblings exist (they can't compose).
    return makeOutcome(OUTCOME.RESOLVED, domain, sourceCode, field, { ...bucket.complete[0] })
  }
  return makeOutcome(OUTCOME.INCOMPLETE, domain, sourceCode, field) // rows exist but all incomplete
}

// Convenience: build + resolve in one call (still pure; rebuilds the index each call). For single
// lookups / tests; a real run builds the index ONCE then resolves many sourceCodes against it.
function resolveReferenceFromRows(template, rows, sourceCode, opts = {}) {
  return resolveReference(buildReferenceMappingIndex(template, rows), sourceCode, opts)
}

module.exports = {
  OUTCOME,
  STATUS_TO_ERROR_TYPE,
  buildReferenceMappingIndex,
  resolveReference,
  resolveReferenceFromRows,
  __internals: { isBlank, isCompleteRow, identifierColumn, normalizeSourceCodeKey },
}
