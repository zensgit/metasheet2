// Local, exact project allocation for the static YiDa preview. No I/O or apply path.
import { buildYidaStaticPlan, generatedTemplateDependencies, parseYidaStaticRows, validateYidaStaticConfig } from './yida-static-plan.mjs'

const INPUT_KEYS = new Set(['config', 'rowsText', 'allocation'])
const ALLOCATION_KEYS = new Set(['mode', 'projects', 'projectField', 'quantityField'])
const ALLOCATION_RULE_KEYS = new Set(['mode', 'projectField', 'quantityField'])
// Q4 (owner 2026-11-07, R-88: an open question gets a configurable default, never a hard-coded answer).
// Optional on both shapes. Absent or 'exact' = today's exact even split (QUANTITY_NOT_DIVISIBLE otherwise);
// 'legacy-1dp' = the legacy system's rule: each project's share rounded half-up to one decimal, which CHANGES
// the total (allocatedTotal = share x projects, difference != 0). Decimal mode only: an integer split stays exact.
const QUANTITY_ROUNDING_KEY = 'quantityRounding'
const QUANTITY_ROUNDINGS = new Set(['exact', 'legacy-1dp'])
const MAX_PROJECTS = 20
const MAX_ROWS = 100
const MAX_TEXT_BYTES = 128 * 1024
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const POWERS_OF_TEN = Array.from({ length: 7 }, (_, index) => 10n ** BigInt(index))
const CONTROL = /\p{Cc}/u
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/

export class YidaAllocationError extends Error {
  constructor(code) {
    super(code)
    this.name = 'YidaAllocationError'
    this.code = code
  }
}

function dataObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !descriptors[key].enumerable
      || !Object.prototype.hasOwnProperty.call(descriptors[key], 'value')) return null
  }
  return descriptors
}

function dataArray(value, maxLength) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value
  if (!Number.isInteger(length) || length > maxLength) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).length !== length + 1) return null
  const result = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !descriptor.enumerable
      || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null
    result.push(descriptor.value)
  }
  return result
}

function hasExactKeys(descriptors, keys) {
  return descriptors && Object.keys(descriptors).length === keys.size
    && Object.keys(descriptors).every((key) => keys.has(key))
}

// The closed key set plus the one optional Q4 key.
function hasAllocationKeys(descriptors, keys) {
  if (!descriptors) return false
  if (!Object.prototype.hasOwnProperty.call(descriptors, QUANTITY_ROUNDING_KEY)) return hasExactKeys(descriptors, keys)
  return hasExactKeys(descriptors, new Set([...keys, QUANTITY_ROUNDING_KEY]))
}

// Absent stays absent (every default-path output is byte-identical); a present value is one of the two names.
function normalizeRounding(descriptors, mode) {
  if (!Object.prototype.hasOwnProperty.call(descriptors, QUANTITY_ROUNDING_KEY)) return {}
  const rounding = descriptors[QUANTITY_ROUNDING_KEY].value
  if (!QUANTITY_ROUNDINGS.has(rounding) || (rounding === 'legacy-1dp' && mode !== 'equal_decimal_exact')) {
    throw new YidaAllocationError('YIDA_ALLOCATION_SETTINGS_INVALID')
  }
  return { quantityRounding: rounding }
}

function normalizeProjects(value) {
  const raw = dataArray(value, MAX_PROJECTS)
  if (!raw || raw.length < 1) throw new YidaAllocationError('YIDA_ALLOCATION_PROJECTS_INVALID')
  const projects = []
  const seen = new Set()
  for (const item of raw) {
    if (typeof item !== 'string') throw new YidaAllocationError('YIDA_ALLOCATION_PROJECTS_INVALID')
    const project = item.trim()
    if (!project || project.length > 128 || CONTROL.test(item) || seen.has(project)) {
      throw new YidaAllocationError('YIDA_ALLOCATION_PROJECTS_INVALID')
    }
    seen.add(project)
    projects.push(project)
  }
  return projects
}

function normalizeMode(mode) {
  if (mode !== 'equal_integer' && mode !== 'equal_decimal_exact') {
    throw new YidaAllocationError('YIDA_ALLOCATION_SETTINGS_INVALID')
  }
  return mode
}

// v3 names key parts by target, so both roles must be the column of a direct entry and the
// project one must be a key target. Copies and concat parts then read the allocated values.
function normalizeTransformRuleFields(projectField, quantityField, config, mode) {
  const direct = (source) => config.fieldMap.find((entry) => entry.transform === 'direct' && entry.source === source)
  const projectEntry = direct(projectField)
  const quantityEntry = direct(quantityField)
  if (typeof projectField !== 'string' || typeof quantityField !== 'string'
    || projectField === quantityField || config.businessKey.length < 2
    || !projectEntry || !quantityEntry || !config.businessKey.includes(projectEntry.target)
    || projectEntry.type !== 'string' || quantityEntry.type !== 'number') {
    throw new YidaAllocationError('YIDA_ALLOCATION_FIELDS_INVALID')
  }
  // R-71 ⑦.4: a generated value is evaluated on the split rows, so it must read the split project
  // (and a preset must take it as its project). G1 already implies this; asserted here as well.
  if (config.fieldMap.some((entry) => entry.transform === 'generated'
    && (!generatedTemplateDependencies(entry, config).includes(projectField)
      || entry.template.some((part) => Object.prototype.hasOwnProperty.call(part, 'preset') && part.projectOf !== projectEntry.target)))) {
    throw new YidaAllocationError('YIDA_ALLOCATION_FIELDS_INVALID')
  }
  return { mode, projectField, quantityField }
}

function normalizeRuleFields(descriptors, config, mode) {
  const projectField = descriptors.projectField.value
  const quantityField = descriptors.quantityField.value
  if (config.version === 3) return normalizeTransformRuleFields(projectField, quantityField, config, mode)
  if (typeof projectField !== 'string' || typeof quantityField !== 'string'
    || projectField === quantityField || !config.businessKey.includes(projectField)
    || config.businessKey.length < 2) {
    throw new YidaAllocationError('YIDA_ALLOCATION_FIELDS_INVALID')
  }
  const projectEntries = config.fieldMap.filter((entry) => entry.source === projectField)
  const quantityEntries = config.fieldMap.filter((entry) => entry.source === quantityField)
  if (!projectEntries.length || !quantityEntries.length
    || projectEntries.some((entry) => entry.type !== 'string')
    || quantityEntries.some((entry) => entry.type !== 'number')) {
    throw new YidaAllocationError('YIDA_ALLOCATION_FIELDS_INVALID')
  }
  return { mode, projectField, quantityField }
}

// The same rule/config compatibility check is used by local templates and the
// full preview. It does not validate rows, project selections or authority.
export function validateYidaProjectAllocationRules(config, rules) {
  try {
    const validation = validateYidaStaticConfig(config)
    if (!validation.valid) throw new YidaAllocationError('YIDA_ALLOCATION_CONFIG_INVALID')
    if (validation.normalized.intent !== 'create') throw new YidaAllocationError('YIDA_ALLOCATION_INTENT_INVALID')
    const descriptors = dataObject(rules)
    if (!hasAllocationKeys(descriptors, ALLOCATION_RULE_KEYS)) {
      throw new YidaAllocationError('YIDA_ALLOCATION_SETTINGS_INVALID')
    }
    const mode = normalizeMode(descriptors.mode.value)
    const rounding = normalizeRounding(descriptors, mode)
    return { ...normalizeRuleFields(descriptors, validation.normalized, mode), ...rounding }
  } catch (error) {
    if (error instanceof YidaAllocationError) throw error
    throw new YidaAllocationError('YIDA_ALLOCATION_INPUT_INVALID')
  }
}

function normalizeAllocation(value, config) {
  const descriptors = dataObject(value)
  if (!hasAllocationKeys(descriptors, ALLOCATION_KEYS)) {
    throw new YidaAllocationError('YIDA_ALLOCATION_SETTINGS_INVALID')
  }
  // Preserve the established mode -> projects -> fields error priority.
  const mode = normalizeMode(descriptors.mode.value)
  const rounding = normalizeRounding(descriptors, mode)
  const projects = normalizeProjects(descriptors.projects.value)
  const rules = validateYidaProjectAllocationRules(config, {
    mode, projectField: descriptors.projectField.value, quantityField: descriptors.quantityField.value, ...rounding,
  })
  return { ...rules, projects }
}

// Canonical decimal pair for comparing a raw JSON number to Number.toString().
// This detects precision lost by JSON.parse without treating ordinary 0.1 as invalid.
function decimalIdentity(token) {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token)
  if (!match) return null
  let digits = `${match[2]}${match[3] || ''}`.replace(/^0+/, '')
  if (!digits) return { negative: match[1] === '-', coefficient: '0', exponent: 0n }
  const exponentText = match[4] || '0'
  const exponentDigits = exponentText.replace(/^[+-]?0*/, '') || '0'
  // At most 128 KiB of JSON is accepted. A larger exponent cannot describe a
  // bounded nonzero quantity, even with all available digits cancelling it.
  if (exponentDigits.length > 6) return null
  const exponent = Number(exponentText)
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > token.length + 32) return null
  // A suffix regex can backtrack quadratically on a long zero run followed by
  // one nonzero digit. Rows are user-entered text on the browser main thread.
  let trailing = 0
  while (trailing < digits.length && digits[digits.length - 1 - trailing] === '0') trailing += 1
  if (trailing) digits = digits.slice(0, -trailing)
  return { negative: match[1] === '-', coefficient: digits,
    exponent: BigInt(exponent) - BigInt(match[3]?.length || 0) + BigInt(trailing) }
}

// The existing parser owns JSON validity and flat-row limits. This scanner only
// preserves the quantity token and detects duplicate quantity keys; it never
// evaluates row values, and JSON.parse is used only to decode a quoted key.
function quantityLexicalIssues(text, quantityField, parsedRows) {
  let offset = 0
  const whitespace = () => { while (/\s/.test(text[offset] || '') && offset < text.length) offset += 1 }
  const expect = (character) => {
    whitespace()
    if (text[offset] !== character) throw new YidaAllocationError('YIDA_ALLOCATION_ROWS_INVALID')
    offset += 1
  }
  const quoted = () => {
    whitespace()
    if (text[offset] !== '"') throw new YidaAllocationError('YIDA_ALLOCATION_ROWS_INVALID')
    const start = offset++
    while (offset < text.length) {
      if (text[offset] === '\\') { offset += 2; continue }
      if (text[offset++] === '"') return text.slice(start, offset)
    }
    throw new YidaAllocationError('YIDA_ALLOCATION_ROWS_INVALID')
  }
  const scalar = () => {
    whitespace()
    if (text[offset] === '"') return quoted()
    const start = offset
    while (offset < text.length && !/[\s,}\]]/.test(text[offset])) offset += 1
    if (offset === start) throw new YidaAllocationError('YIDA_ALLOCATION_ROWS_INVALID')
    return text.slice(start, offset)
  }
  const issues = []
  expect('[')
  whitespace()
  let rowIndex = 0
  while (text[offset] !== ']') {
    if (rowIndex > 0) expect(',')
    expect('{')
    whitespace()
    let seenQuantity = false
    let issue = null
    let first = true
    while (text[offset] !== '}') {
      if (!first) expect(',')
      const key = JSON.parse(quoted())
      expect(':')
      const token = scalar()
      if (key === quantityField) {
        if (seenQuantity) issue = 'QUANTITY_INVALID'
        seenQuantity = true
        if (JSON_NUMBER.test(token)) {
          const raw = decimalIdentity(token)
          const parsed = decimalIdentity(String(parsedRows[rowIndex]?.[quantityField]))
          if (token.startsWith('-')) issue = 'QUANTITY_INVALID'
          else if (!raw || !parsed || raw.coefficient !== parsed.coefficient
            || raw.exponent !== parsed.exponent) issue ||= 'QUANTITY_PRECISION'
        }
      }
      whitespace()
      first = false
    }
    expect('}')
    issues.push(issue)
    rowIndex += 1
    whitespace()
  }
  expect(']')
  whitespace()
  if (offset !== text.length || rowIndex !== parsedRows.length) {
    throw new YidaAllocationError('YIDA_ALLOCATION_ROWS_INVALID')
  }
  return issues
}

// Convert the canonical decimal spelling of a JS number into an integer and scale.
// No floating-point division or multiplication determines divisibility.
function decimalParts(value) {
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value))
  if (!match) return null
  const fractionLength = match[2]?.length || 0
  const exponent = Number(match[3] || 0)
  if (!Number.isSafeInteger(exponent) || exponent > 30 || exponent < -30) return null
  let scaled = BigInt(match[1] + (match[2] || ''))
  let scale = fractionLength - exponent
  if (scale < 0) {
    if (-scale > 30) return null
    scaled *= 10n ** BigInt(-scale)
    scale = 0
  }
  while (scale > 0 && scaled % 10n === 0n) {
    scaled /= 10n
    scale -= 1
  }
  return { scaled, scale }
}

function decimalString(scaled, scale) {
  const digits = String(scaled)
  if (scale === 0) return digits
  const padded = digits.padStart(scale + 1, '0')
  return `${padded.slice(0, -scale)}.${padded.slice(-scale)}`
}

function numberFromExactDecimal(scaled, scale) {
  const value = Number(decimalString(scaled, scale))
  if (!Number.isFinite(value)) return null
  const again = decimalParts(value)
  if (!again || again.scale > 6 || again.scaled > MAX_SAFE) return null
  const commonScale = Math.max(scale, again.scale)
  if (scaled * POWERS_OF_TEN[commonScale - scale]
    !== again.scaled * POWERS_OF_TEN[commonScale - again.scale]) return null
  return value
}

// Exact signed decimal (scaled / 10^scale) as a Number, or null when it does not round-trip.
function signedNumberFromExactDecimal(scaled, scale) {
  if (scaled >= 0n) return numberFromExactDecimal(scaled, scale)
  const magnitude = numberFromExactDecimal(-scaled, scale)
  return magnitude === null ? null : -magnitude
}

// Q4 'legacy-1dp': share = round-half-up(total / projects, 1 decimal), in integers only (never float division).
// The rounded share times the project count is the new total; difference = allocatedTotal - sourceTotal.
// A positive quantity whose share rounds to 0 is refused (QUANTITY_PRECISION): a split never drops a quantity.
function allocateLegacyOneDecimal(source, projectCount) {
  const count = BigInt(projectCount)
  const denominator = POWERS_OF_TEN[source.scale] * count
  const numerator = source.scaled * 10n
  let eachTenths = numerator / denominator
  if ((numerator % denominator) * 2n >= denominator) eachTenths += 1n
  if (eachTenths === 0n && source.scaled > 0n) return { code: 'QUANTITY_PRECISION' }
  const allocatedTenths = eachTenths * count
  if (allocatedTenths > MAX_SAFE) return { code: 'QUANTITY_RANGE' }
  const each = numberFromExactDecimal(eachTenths, 1)
  const allocatedTotal = numberFromExactDecimal(allocatedTenths, 1)
  const total = numberFromExactDecimal(source.scaled, source.scale)
  const commonScale = Math.max(1, source.scale)
  const difference = signedNumberFromExactDecimal(allocatedTenths * POWERS_OF_TEN[commonScale - 1]
    - source.scaled * POWERS_OF_TEN[commonScale - source.scale], commonScale)
  if (each === null || allocatedTotal === null || total === null || difference === null) return { code: 'QUANTITY_PRECISION' }
  return { each, allocatedTotal, difference }
}

function allocate(value, mode, projectCount, rounding) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return { code: 'QUANTITY_INVALID' }
  }
  if (rounding === 'legacy-1dp') {
    const source = decimalParts(value)
    if (!source || source.scale > 6) return { code: 'QUANTITY_PRECISION' }
    if (source.scaled > MAX_SAFE) return { code: 'QUANTITY_RANGE' }
    return allocateLegacyOneDecimal(source, projectCount)
  }
  if (mode === 'equal_integer') {
    if (!Number.isSafeInteger(value)) return { code: 'QUANTITY_RANGE' }
    const total = BigInt(value)
    if (total % BigInt(projectCount) !== 0n) return { code: 'QUANTITY_NOT_DIVISIBLE' }
    return { each: Number(total / BigInt(projectCount)), allocatedTotal: value }
  }
  const source = decimalParts(value)
  if (!source || source.scale > 6) return { code: 'QUANTITY_PRECISION' }
  if (source.scaled > MAX_SAFE) return { code: 'QUANTITY_RANGE' }
  for (let scale = source.scale; scale <= 6; scale += 1) {
    const numerator = source.scaled * POWERS_OF_TEN[scale - source.scale]
    if (numerator > MAX_SAFE) return { code: 'QUANTITY_RANGE' }
    if (numerator % BigInt(projectCount) !== 0n) continue
    const eachScaled = numerator / BigInt(projectCount)
    const each = numberFromExactDecimal(eachScaled, scale)
    if (each === null) return { code: 'QUANTITY_PRECISION' }
    const total = numberFromExactDecimal(source.scaled, source.scale)
    if (total === null) return { code: 'QUANTITY_PRECISION' }
    return { each, allocatedTotal: total }
  }
  return { code: 'QUANTITY_NOT_DIVISIBLE' }
}

function refusal(analysis, issues, sourceRows, projectCount, expandedRows) {
  return {
    kind: 'project_allocation_preview', status: 'not_applyable', canApply: false,
    tokenIssued: false, lookupExecuted: false, externalWriteAttempted: false,
    plan: null, analysis, issues,
    evidence: { sourceRows, projectCount, expandedRows,
      invalidSourceRows: analysis.filter((entry) => entry.issues.length > 0).length },
  }
}

// The one equal_integer / equal_decimal_exact expansion. The preview plans its rows; the send path
// (R-71 ⑦.3) re-derives the same rows for a v3 selection instead of reversing a payload. Either a
// refusal (exactly what the preview returns) or the expanded rows with their origins.
function expandAllocation(input) {
  { // The block keeps the moved preview body byte-identical (indentation included) for review.
    const top = dataObject(input)
    if (!hasExactKeys(top, INPUT_KEYS)) throw new YidaAllocationError('YIDA_ALLOCATION_INPUT_INVALID')
    const validation = validateYidaStaticConfig(top.config.value)
    if (!validation.valid) throw new YidaAllocationError('YIDA_ALLOCATION_CONFIG_INVALID')
    const config = validation.normalized
    if (config.intent !== 'create') throw new YidaAllocationError('YIDA_ALLOCATION_INTENT_INVALID')
    const allocation = normalizeAllocation(top.allocation.value, config)
    let rows
    try {
      rows = parseYidaStaticRows(top.rowsText.value, config)
    } catch (error) {
      if (error?.code === 'YIDA_STATIC_TEXT_TOO_LARGE' || error?.code === 'YIDA_STATIC_ROWS_LIMIT') {
        throw new YidaAllocationError('YIDA_ALLOCATION_ROWS_LIMIT')
      }
      throw new YidaAllocationError('YIDA_ALLOCATION_ROWS_INVALID')
    }
    const lexicalIssues = quantityLexicalIssues(top.rowsText.value, allocation.quantityField, rows)
    const projectCount = allocation.projects.length
    const projectedRows = rows.length * projectCount
    const analysis = []
    const issues = []
    const quantities = []
    for (let index = 0; index < rows.length; index += 1) {
      const sourceValue = Object.prototype.hasOwnProperty.call(rows[index], allocation.quantityField)
        ? rows[index][allocation.quantityField] : undefined
      const result = lexicalIssues[index]
        ? { code: lexicalIssues[index] } : allocate(sourceValue, allocation.mode, projectCount, allocation.quantityRounding)
      const entry = { sourceIndex: index,
        sourceTotal: !lexicalIssues[index] && typeof sourceValue === 'number' && Number.isFinite(sourceValue) ? sourceValue : null,
        projectCount, issues: [], candidates: [] }
      if (result.code) {
        entry.issues.push(result.code)
        issues.push({ index, code: result.code })
      } else {
        entry.perProjectQuantity = result.each
        entry.allocatedTotal = result.allocatedTotal
        entry.difference = result.difference ?? 0
        quantities.push(result.each)
      }
      analysis.push(entry)
    }
    if (projectedRows > MAX_ROWS) issues.push({ index: null, code: 'EXPANDED_ROWS_LIMIT' })
    if (issues.length > 0) return { refused: refusal(analysis, issues, rows.length, projectCount, projectedRows) }

    const expanded = []
    const origins = []
    for (let index = 0; index < rows.length; index += 1) {
      for (const project of allocation.projects) {
        origins.push({ sourceIndex: index, project })
        expanded.push({ ...rows[index], [allocation.projectField]: project,
          [allocation.quantityField]: quantities[index] })
      }
    }
    if (new TextEncoder().encode(JSON.stringify(expanded)).length > MAX_TEXT_BYTES) {
      return { refused: refusal(analysis, [{ index: null, code: 'EXPANDED_TEXT_LIMIT' }],
        rows.length, projectCount, projectedRows) }
    }
    return { config, rows, analysis, projectCount, expanded, origins }
  }
}

export function buildYidaProjectAllocationPreview(input) {
  try {
    const expansion = expandAllocation(input)
    if (expansion.refused) return expansion.refused
    const { config, rows, analysis, projectCount, expanded, origins } = expansion
    const plan = buildYidaStaticPlan({ config, rows: expanded })
    const invalidSources = new Set()
    // Associate only actual planner result members with their generated origins.
    // Candidate validity is independent of the exact allocation arithmetic above.
    for (const row of plan.rows) {
      const origin = Number.isInteger(row.index) && row.index >= 0 ? origins[row.index] : undefined
      if (!origin) throw new YidaAllocationError('YIDA_ALLOCATION_INPUT_INVALID')
      analysis[origin.sourceIndex].candidates.push({
        expandedIndex: row.index, project: origin.project, status: row.status,
        issues: row.issues.map((issue) => issue.code),
      })
      if (row.status === 'invalid') invalidSources.add(origin.sourceIndex)
    }
    return {
      kind: 'project_allocation_preview', status: 'not_applyable', canApply: false,
      tokenIssued: false, lookupExecuted: false, externalWriteAttempted: false,
      plan, analysis, issues: [],
      evidence: { sourceRows: rows.length, projectCount, expandedRows: expanded.length,
        invalidSourceRows: invalidSources.size },
    }
  } catch (error) {
    if (error instanceof YidaAllocationError) throw error
    throw new YidaAllocationError('YIDA_ALLOCATION_INPUT_INVALID')
  }
}

// R-71 ⑦.3: the expanded rows the preview plans, for an allocation the preview accepts; the same
// array, from the same code. A refusal throws: ROWS_LIMIT for the expanded row/text limits, else
// ROWS_INVALID. Rows only; no plan, no lookup, no I/O.
export function expandYidaProjectAllocationRows(input) {
  try {
    const expansion = expandAllocation(input)
    if (expansion.refused) {
      throw new YidaAllocationError(expansion.refused.issues.some((issue) => ['EXPANDED_ROWS_LIMIT', 'EXPANDED_TEXT_LIMIT'].includes(issue.code))
        ? 'YIDA_ALLOCATION_ROWS_LIMIT' : 'YIDA_ALLOCATION_ROWS_INVALID')
    }
    return expansion.expanded
  } catch (error) {
    if (error instanceof YidaAllocationError) throw error
    throw new YidaAllocationError('YIDA_ALLOCATION_INPUT_INVALID')
  }
}
