'use strict'
// SCOPING NOTE (review #3892): matching-family semantics — only the modules that already carried
// byte-identical variants (readonly-intake/material-match/unit-rule-match) consume this. Other stock-prep
// modules use DIFFERENT semantics (e.g. mvp-generation null!==null; large-bom-jobs/option-sync ''-blank,
// non-coercing) — do NOT naively migrate them onto this common helper; it would silently change behavior.

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function optionalString(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

function sameText(left, right) {
  const normalizedLeft = optionalString(left)
  const normalizedRight = optionalString(right)
  if (normalizedLeft === null && normalizedRight === null) return true
  if (normalizedLeft === null || normalizedRight === null) return false
  return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
}

function firstValue(row, keys) {
  if (!isPlainObject(row)) return null
  for (const key of keys) {
    const value = optionalString(row[key])
    if (value !== null) return value
  }
  return null
}

/**
 * The shape a 备料 business project number is allowed to have.
 *
 * WHY THIS EXISTS AS A SHARED CONSTANT. `projectNo` is the one caller-supplied string in the
 * stock-prep family that travels furthest: it scopes record queries, it is written verbatim into the
 * values-free audit trail's `project_id`, it keys the handoff cursor row, it is interpolated into
 * an xlsx sheet name and a Content-Disposition filename, and — since 通知下一步 — it is interpolated
 * into a DingTalk MARKDOWN body that a person reads on their phone. Treating it as free text made
 * the last of those an injection surface: `[click](http://evil)` or a few hundred newlines ride
 * straight into the message, and a 20k-character string rides into an append-only audit row.
 *
 * SO IT IS A HANDLE, NOT PROSE, and the pattern says so: an alphanumeric first character, then
 * alphanumerics and the four separators real project numbers actually use (`. _ - /`), 80 characters
 * at the outside. That admits every projectNo the templates, fixtures and customer packs in this
 * repo carry, and excludes whitespace, newlines, markdown metacharacters, quotes, angle brackets and
 * every non-ASCII byte.
 *
 * Deliberately NOT the same thing as "this project exists" — that question is answered by reading
 * the bound target, and a caller-facing route must answer it separately (404), because a
 * well-shaped id for a project nobody has is still not a project.
 */
const STOCK_PREP_PROJECT_NO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,79}$/
const STOCK_PREP_PROJECT_NO_MAX_LENGTH = 80

/** Is `value` a well-shaped 备料 business project number? Pure predicate; never throws. */
function isValidStockPrepProjectNo(value) {
  return typeof value === 'string' && STOCK_PREP_PROJECT_NO_PATTERN.test(value)
}

module.exports = {
  firstValue,
  isPlainObject,
  isValidStockPrepProjectNo,
  optionalString,
  sameText,
  STOCK_PREP_PROJECT_NO_MAX_LENGTH,
  STOCK_PREP_PROJECT_NO_PATTERN,
}
