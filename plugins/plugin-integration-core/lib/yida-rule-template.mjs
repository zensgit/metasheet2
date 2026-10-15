import { validateYidaStaticConfig } from './yida-static-plan.mjs'
import { validateYidaProjectAllocationRules } from './stock-preparation-yida-allocation.mjs'

// Browser-only data mechanism: no I/O, storage, rows, target or authority.
const MAX_BYTES = 2 * 1024 * 1024
const MAX_NODES = 4096
const MAX_DEPTH = 10
const KIND = 'stock-preparation-yida-rule-template'
const ENVELOPE_KEYS = ['formatVersion', 'kind', 'status', 'rules', 'allocation']
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const CODES = new Set(['INPUT', 'TEXT', 'LIMIT', 'CONFIG', 'ALLOCATION'])
const ownErrors = new WeakSet()
const encoder = new TextEncoder()

export class YidaRuleTemplateError extends Error {
  constructor(kind = 'INPUT') {
    const code = `YIDA_RULE_TEMPLATE_${CODES.has(kind) ? kind : 'INPUT'}`
    super(code)
    this.name = 'YidaRuleTemplateError'
    this.code = code
    ownErrors.add(this)
  }
}

function fail(kind) { throw new YidaRuleTemplateError(kind) }

function textBudget(text) {
  if (text.length > MAX_BYTES || encoder.encode(text).length > MAX_BYTES) fail('LIMIT')
}

// Descriptor cloning is strict about own data. A browser cannot identify or
// isolate arbitrary same-process Proxy code; the external boundary is JSON text.
function ownedClone(input) {
  let nodes = 0
  let bytes = 0
  const ancestors = new Set()
  function charge(text) {
    if (text.length > MAX_BYTES) fail('LIMIT')
    bytes += encoder.encode(text).length
    if (bytes > MAX_BYTES) fail('LIMIT')
  }
  function clone(value, depth) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) fail('LIMIT')
    if (value === null || typeof value === 'boolean') { charge(String(value)); return value }
    if (typeof value === 'string') {
      if (value.length > MAX_BYTES) fail('LIMIT')
      charge(JSON.stringify(value))
      return value
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Object.is(value, -0)) fail('INPUT')
      charge(String(value))
      return value
    }
    if (!value || typeof value !== 'object' || ancestors.has(value)) fail('INPUT')
    const array = Array.isArray(value)
    const proto = Object.getPrototypeOf(value)
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) fail('INPUT')
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    if (keys.length > MAX_NODES + 1) fail('LIMIT')
    if (array && descriptors.length.value > MAX_NODES) fail('LIMIT')
    if (array && keys.length !== descriptors.length.value + 1) fail('INPUT')
    ancestors.add(value)
    const output = array ? [] : {}
    charge(array ? '[]' : '{}')
    let count = 0
    for (const key of keys) {
      if (array && key === 'length') continue
      const property = descriptors[key]
      if (typeof key !== 'string' || !property.enumerable || !Object.hasOwn(property, 'value')
        || DANGEROUS_KEYS.has(key)
        || (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= descriptors.length.value))) fail('INPUT')
      if (count++ > 0) charge(',')
      if (!array) {
        if (key.length > MAX_BYTES) fail('LIMIT')
        charge(`${JSON.stringify(key)}:`)
      }
      Object.defineProperty(output, key, {
        value: clone(property.value, depth + 1), enumerable: true,
      })
    }
    ancestors.delete(value)
    return Object.freeze(output)
  }
  return clone(input, 0)
}

function record(value, keys, kind = 'INPUT') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(kind)
  if (keys && (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))) fail(kind)
  return value
}

function normalize(rules, allocation) {
  record(rules, null, 'CONFIG')
  if (Object.hasOwn(rules, 'target')) fail('CONFIG')
  // Named schema-only placeholders: never returned, shown as real targets,
  // passed to a planner, or used in an external operation.
  const schemaConfig = { ...rules, target: {
    appType: 'LOCAL_SCHEMA_ONLY_APP', formUuid: 'LOCAL_SCHEMA_ONLY_FORM',
  } }
  let validated
  try { validated = validateYidaStaticConfig(schemaConfig) } catch { fail('CONFIG') }
  if (!validated.valid) fail('CONFIG')
  const { target: _schemaOnlyTarget, ...normalizedRules } = validated.normalized
  let normalizedAllocation
  record(allocation, null, 'ALLOCATION')
  if (allocation.mode === 'original') {
    record(allocation, ['mode'], 'ALLOCATION')
    normalizedAllocation = { mode: 'original' }
  } else {
    try { normalizedAllocation = validateYidaProjectAllocationRules(validated.normalized, allocation) } catch { fail('ALLOCATION') }
  }
  return ownedClone({
    formatVersion: 1, kind: KIND, status: 'local-unverified',
    rules: normalizedRules, allocation: normalizedAllocation,
  })
}

// Linear, bounded JSON scanner. Only version literals 1/2 are supported; using
// JSON.parse on document numbers first could silently accept rounded versions.
function parseText(text) {
  let at = 0
  let nodes = 0
  const whitespace = () => { while (text[at] === ' ' || text[at] === '\t' || text[at] === '\r' || text[at] === '\n') at += 1 }
  const isHex = (char) => (char >= '0' && char <= '9') || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F')
  function quoted() {
    if (text[at] !== '"') fail('TEXT')
    const start = at++
    while (at < text.length) {
      const char = text[at++]
      if (char === '"') {
        try { return JSON.parse(text.slice(start, at)) } catch { fail('TEXT') }
      }
      if (char.charCodeAt(0) < 32) fail('TEXT')
      if (char === '\\') {
        const escape = text[at++]
        if (escape === 'u') {
          for (let count = 0; count < 4; count += 1) if (!isHex(text[at++])) fail('TEXT')
        } else if (!['"', '\\', '/', 'b', 'f', 'n', 'r', 't'].includes(escape)) fail('TEXT')
      }
    }
    fail('TEXT')
  }
  function value(depth) {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) fail('LIMIT')
    whitespace()
    const char = text[at]
    if (char === '"') return quoted()
    if (char === '1' || char === '2') { at += 1; return Number(char) }
    for (const [literal, parsed] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(literal, at)) { at += literal.length; return parsed }
    }
    const array = char === '['
    if (array || char === '{') {
      at += 1
      whitespace()
      const output = array ? [] : {}
      const end = array ? ']' : '}'
      const seen = new Set()
      if (text[at] !== end) {
        // eslint-disable-next-line no-constant-condition -- Every iteration consumes a budgeted value and delimiter or throws.
        while (true) {
          const key = array ? String(output.length) : quoted()
          if (!array) {
            if (seen.has(key) || DANGEROUS_KEYS.has(key)) fail('TEXT')
            seen.add(key)
            whitespace()
            if (text[at++] !== ':') fail('TEXT')
          }
          Object.defineProperty(output, key, { value: value(depth + 1), enumerable: true })
          whitespace()
          if (text[at] === end) break
          if (text[at++] !== ',') fail('TEXT')
          whitespace()
        }
      }
      at += 1
      return output
    }
    fail('TEXT')
  }
  const output = value(0)
  whitespace()
  if (at !== text.length) fail('TEXT')
  return output
}

export function exportYidaRuleTemplate(input) {
  try {
    const owned = record(ownedClone(input), ['rules', 'allocation'])
    const envelope = normalize(owned.rules, owned.allocation)
    const text = JSON.stringify(envelope, null, 2)
    textBudget(text)
    return text
  } catch (error) {
    if (ownErrors.has(error)) throw error
    fail('INPUT')
  }
}

export function parseYidaRuleTemplate(text) {
  try {
    if (typeof text !== 'string') fail('TEXT')
    textBudget(text)
    const envelope = record(ownedClone(parseText(text)), ENVELOPE_KEYS)
    if (envelope.formatVersion !== 1 || envelope.kind !== KIND || envelope.status !== 'local-unverified') fail('INPUT')
    return normalize(envelope.rules, envelope.allocation)
  } catch (error) {
    if (ownErrors.has(error)) throw error
    fail('TEXT')
  }
}
