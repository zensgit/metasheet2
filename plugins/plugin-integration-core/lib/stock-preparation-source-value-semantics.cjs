'use strict'

// Pure value semantics for two OPTIONAL top-level read-plan keys: `sourceProjectComparison` and
// `bomActiveState`. No dependencies, no IO. Errors carry a stable `.code` and never echo values.
// The state value sets are data, NOT physical column roles; only `bomHead.activeField` is a column.

const SOURCE_PROJECT_COMPARISON_MODES = Object.freeze(['case-sensitive', 'case-insensitive'])
const STATE_KEYS = Object.freeze(['activeValues', 'inactiveValues'])
const MAX_STATE_VALUES = 32
const MAX_STATE_STRING_LENGTH = 128
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/

class SourceValueSemanticsError extends Error {
  constructor(code) {
    super(code)
    this.name = 'SourceValueSemanticsError'
    this.code = code
  }
}

function refuse(code) { throw new SourceValueSemanticsError(code) }
function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

// Type-tagged identity of one allowed scalar, or null when the value may not appear in a set.
// 1 and '1' differ; -0 and 0 collapse (JSON cannot preserve -0); strings are never trimmed or folded.
function stateKey(value) {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return `b:${value}`
  if (typeof value === 'number') {
    return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? `n:${value + 0}` : null
  }
  if (typeof value === 'string') {
    if (value.trim() === '' || value.length > MAX_STATE_STRING_LENGTH || CONTROL_CHARACTER.test(value)) return null
    return `s:${value}`
  }
  return null
}

function compileValues(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_STATE_VALUES) refuse('BOM_ACTIVE_STATE_INVALID')
  const keys = new Set()
  const clean = []
  for (let index = 0; index < values.length; index += 1) {
    const key = stateKey(values[index])
    if (key === null || keys.has(key)) refuse('BOM_ACTIVE_STATE_INVALID')
    keys.add(key)
    clean.push(values[index] === 0 ? 0 : values[index])
  }
  return { keys, clean }
}

function compileBomActiveState(policy) {
  if (!record(policy)) refuse('BOM_ACTIVE_STATE_INVALID')
  const keys = Object.keys(policy)
  if (keys.length !== STATE_KEYS.length || !keys.every((key) => STATE_KEYS.includes(key))) refuse('BOM_ACTIVE_STATE_INVALID')
  const active = compileValues(policy.activeValues)
  const inactive = compileValues(policy.inactiveValues)
  for (const key of active.keys) {
    if (inactive.keys.has(key)) refuse('BOM_ACTIVE_STATE_INVALID')
  }
  return { active, inactive }
}

// Returns ONLY the explicitly present (non-undefined) keys, as fresh frozen copies. Absent => {}.
function normalizeSourceValueSemantics(readPlan) {
  const out = {}
  if (!record(readPlan)) return out
  const mode = readPlan.sourceProjectComparison
  if (mode !== undefined) {
    if (!SOURCE_PROJECT_COMPARISON_MODES.includes(mode)) refuse('SOURCE_PROJECT_COMPARISON_INVALID')
    out.sourceProjectComparison = mode
  }
  const state = readPlan.bomActiveState
  if (state !== undefined) {
    const activeField = record(readPlan.bomHead) ? readPlan.bomHead.activeField : undefined
    if (typeof activeField !== 'string' || activeField.trim() === '') refuse('BOM_ACTIVE_STATE_ACTIVE_FIELD_REQUIRED')
    const { active, inactive } = compileBomActiveState(state)
    out.bomActiveState = Object.freeze({
      activeValues: Object.freeze(active.clean),
      inactiveValues: Object.freeze(inactive.clean),
    })
  }
  return out
}

// Opt-in string/finite bounded-number keys only (trim, blank/invalid => no value).
// The absent-mode caller retains its original toKey behavior separately.
function projectText(value) {
  let text
  if (typeof value === 'string') text = value
  else if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) text = String(value)
  else return null
  text = text.trim()
  return text === '' ? null : text
}

// No numeric canonicalisation ('0010' != '10') and no collation simulation beyond toLowerCase.
function sameSourceProject(a, b, mode) {
  if (mode !== undefined && !SOURCE_PROJECT_COMPARISON_MODES.includes(mode)) refuse('SOURCE_PROJECT_COMPARISON_INVALID')
  const left = projectText(a)
  const right = projectText(b)
  if (left === null || right === null) return false
  return mode === 'case-insensitive' ? left.toLowerCase() === right.toLowerCase() : left === right
}

// Exact typed membership. Anything unlisted (including undefined, NaN, '' and null not listed) is unknown.
function resolveConfiguredBomActive(value, policy) {
  const { active, inactive } = compileBomActiveState(policy)
  const key = stateKey(value)
  if (key !== null && active.keys.has(key)) return true
  if (key !== null && inactive.keys.has(key)) return false
  return refuse('BOM_HEAD_ACTIVE_VALUE_INVALID')
}

module.exports = {
  SOURCE_PROJECT_COMPARISON_MODES,
  SourceValueSemanticsError,
  normalizeSourceValueSemantics,
  sameSourceProject,
  resolveConfiguredBomActive,
}
