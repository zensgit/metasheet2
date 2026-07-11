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

module.exports = {
  firstValue,
  isPlainObject,
  optionalString,
  sameText,
}
