'use strict'

// ---------------------------------------------------------------------------
// Field validator - plugin-integration-core
//
// Data-quality failures are returned as structured errors. They are not thrown
// as exceptions from validateValue() or validateRecord().
// ---------------------------------------------------------------------------

const { getPath } = require('./transform-engine.cjs')
const { runUserRegex, describeUserRegexRefusal } = require('./user-regex-guard.cjs')

const SUPPORTED_RULES = new Set(['required', 'pattern', 'enum', 'min', 'max'])

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isEmpty(value) {
  if (value === undefined || value === null) return true
  if (typeof value === 'string' && value.trim() === '') return true
  if (Array.isArray(value) && value.length === 0) return true
  return false
}

function normalizeRules(validation) {
  if (validation === undefined || validation === null) return []
  if (Array.isArray(validation)) return validation
  return [validation]
}

function normalizeRule(rule) {
  if (typeof rule === 'string') return { type: rule.trim(), params: {}, message: undefined }
  if (!isPlainObject(rule)) return { type: 'invalid', params: {}, message: undefined }

  const type = typeof rule.type === 'string'
    ? rule.type.trim()
    : typeof rule.kind === 'string'
      ? rule.kind.trim()
      : ''
  if (!type) return { type: 'invalid', params: {}, message: rule.message }

  const params = isPlainObject(rule.params) ? { ...rule.params } : {}
  for (const [key, value] of Object.entries(rule)) {
    if (key === 'type' || key === 'kind' || key === 'params' || key === 'message') continue
    params[key] = value
  }

  return {
    type,
    params,
    message: typeof rule.message === 'string' ? rule.message : undefined,
  }
}

function makeError(field, rule, code, message, value, details = {}) {
  return {
    field,
    code,
    message: rule.message || message,
    value,
    rule: rule.type,
    details,
  }
}

function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const normalized = value.trim().replace(/,/g, '')
    if (normalized === '') return null
    const numeric = Number(normalized)
    return Number.isFinite(numeric) ? numeric : null
  }
  return null
}

function ruleValue(rule, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(rule.params, name)) return rule.params[name]
  }
  return undefined
}

function compilePattern(rule) {
  const pattern = ruleValue(rule, ['regex', 'pattern', 'value'])
  const flags = ruleValue(rule, ['flags'])

  if (pattern instanceof RegExp) {
    return { regexp: pattern, source: pattern.source, flags: pattern.flags, error: null }
  }
  if (typeof pattern !== 'string') {
    return { regexp: null, source: null, flags: null, error: 'pattern rule requires params.regex, params.pattern, or params.value' }
  }
  if (flags !== undefined && typeof flags !== 'string') {
    return { regexp: null, source: null, flags: null, error: 'pattern flags must be a string' }
  }

  try {
    return { regexp: new RegExp(pattern, flags), source: pattern, flags, error: null }
  } catch (error) {
    return { regexp: null, source: null, flags: null, error: error.message }
  }
}

function enumValues(rule) {
  const values = ruleValue(rule, ['values', 'enum', 'allowedValues'])
  return Array.isArray(values) ? values : null
}

function includesEnumValue(values, value) {
  return values.some((candidate) => {
    if (Object.is(candidate, value)) return true
    if (typeof value === 'number' && typeof candidate === 'string') return candidate === String(value)
    return false
  })
}

function validateValue(value, rules, field = null) {
  const errors = []

  for (const rawRule of normalizeRules(rules)) {
    const rule = normalizeRule(rawRule)
    const fieldLabel = field || 'value'

    if (rule.type === 'invalid') {
      errors.push(makeError(field, rule, 'INVALID_RULE', `${fieldLabel} has invalid validation rule`, value))
      continue
    }
    if (!SUPPORTED_RULES.has(rule.type)) {
      errors.push(makeError(field, rule, 'UNSUPPORTED_RULE', `${fieldLabel} uses unsupported validation rule`, value))
      continue
    }

    switch (rule.type) {
      case 'required':
        if (isEmpty(value)) {
          errors.push(makeError(field, rule, 'REQUIRED', `${fieldLabel} is required`, value))
        }
        break
      case 'pattern': {
        if (isEmpty(value)) break
        const { regexp, source, flags, error } = compilePattern(rule)
        if (error) {
          errors.push(makeError(field, rule, 'INVALID_RULE', `${fieldLabel} has invalid pattern rule`, value, { error }))
          break
        }
        // PROPOSED (H-3, round 2): same guard, same constants as
        // packages/core-backend/src/formula/regex-safety.ts — a hard subject
        // ceiling that does not depend on the mapping's own rule list, plus a
        // bounded timing ladder that refuses only a MEASURED super-quadratic cost
        // curve. A refusal is reported under its own code, never as PATTERN: a
        // pipeline operator must be able to tell "the value is malformed" from
        // "the check declined to run". See lib/user-regex-guard.cjs.
        //
        // SCOPE (round 3): `compilePattern` above has ALREADY called
        // `new RegExp(pattern, flags)` by the time the guard sees it, so
        // USER_REGEX_MAX_PATTERN_LEN is enforced here AFTER compilation, not before
        // it. The backend case that pins "refuses an over-length pattern BEFORE
        // compiling it" is L1/L2-scoped and does not describe this call site.
        // Measured, the gap is small — pre-compiling a 133331-character alternation
        // costs 1.1ms — so this is recorded rather than restructured: moving the
        // length check into `compilePattern` would change the error CODE an
        // over-length pattern reports here (PATTERN_NOT_EVALUATED -> INVALID_RULE),
        // which is a pipeline-visible contract change and not this slice's to make.
        const outcome = runUserRegex(source, flags === null ? undefined : flags, String(value), (re, subject) => {
          re.lastIndex = 0
          return re.test(subject)
        })
        if (outcome.status !== 'ok') {
          errors.push(makeError(field, rule, 'PATTERN_NOT_EVALUATED', `${fieldLabel} could not be pattern-checked`, value, {
            reason: describeUserRegexRefusal(outcome.refusal),
            pattern: String(regexp),
          }))
          break
        }
        if (!outcome.value) {
          errors.push(makeError(field, rule, 'PATTERN', `${fieldLabel} does not match pattern`, value, {
            pattern: String(regexp),
          }))
        }
        break
      }
      case 'enum': {
        if (isEmpty(value)) break
        const values = enumValues(rule)
        if (!values) {
          errors.push(makeError(field, rule, 'INVALID_RULE', `${fieldLabel} has invalid enum rule`, value))
          break
        }
        if (!includesEnumValue(values, value)) {
          errors.push(makeError(field, rule, 'ENUM', `${fieldLabel} is not an allowed value`, value, { values }))
        }
        break
      }
      case 'min': {
        if (isEmpty(value)) break
        const min = toFiniteNumber(ruleValue(rule, ['value', 'min']))
        if (min === null) {
          errors.push(makeError(field, rule, 'INVALID_RULE', `${fieldLabel} has invalid min rule`, value))
          break
        }
        const numeric = toFiniteNumber(value)
        if (numeric === null || numeric < min) {
          errors.push(makeError(field, rule, 'MIN', `${fieldLabel} is below minimum`, value, { min }))
        }
        break
      }
      case 'max': {
        if (isEmpty(value)) break
        const max = toFiniteNumber(ruleValue(rule, ['value', 'max']))
        if (max === null) {
          errors.push(makeError(field, rule, 'INVALID_RULE', `${fieldLabel} has invalid max rule`, value))
          break
        }
        const numeric = toFiniteNumber(value)
        if (numeric === null || numeric > max) {
          errors.push(makeError(field, rule, 'MAX', `${fieldLabel} exceeds maximum`, value, { max }))
        }
        break
      }
      default:
        errors.push(makeError(field, rule, 'UNSUPPORTED_RULE', `${fieldLabel} uses unsupported validation rule`, value))
    }
  }

  return errors
}

function validateRecord(record, fieldMappings = []) {
  if (!isPlainObject(record)) {
    throw new TypeError('record must be an object')
  }
  if (!Array.isArray(fieldMappings)) {
    throw new TypeError('fieldMappings must be an array')
  }

  const errors = []
  fieldMappings.forEach((mapping, index) => {
    if (!isPlainObject(mapping)) {
      errors.push({
        field: null,
        code: 'INVALID_MAPPING',
        message: `fieldMappings[${index}] must be an object`,
        value: undefined,
        rule: 'mapping',
        details: { index },
      })
      return
    }

    const field = mapping.targetField || mapping.field || mapping.fieldId || null
    if (!field) {
      errors.push({
        field: null,
        code: 'INVALID_MAPPING',
        message: `fieldMappings[${index}].targetField is required`,
        value: undefined,
        rule: 'mapping',
        details: { index },
      })
      return
    }

    errors.push(...validateValue(getPath(record, field), mapping.validation, field))
  })

  return {
    ok: errors.length === 0,
    valid: errors.length === 0,
    errors,
  }
}

module.exports = {
  SUPPORTED_RULES,
  isEmpty,
  normalizeRules,
  validateValue,
  validateRecord,
  __internals: {
    compilePattern,
    enumValues,
    includesEnumValue,
    normalizeRule,
    toFiniteNumber,
  },
}
