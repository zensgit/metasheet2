'use strict'

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
