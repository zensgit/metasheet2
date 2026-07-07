'use strict'

const crypto = require('node:crypto')

const RULE_OUTCOMES = Object.freeze({
  REUSED: 'reused',
  CANDIDATE: 'candidate',
  HELD: 'held',
})

const HELD_REASONS = Object.freeze({
  MISSING_MAPPING: 'missing_mapping',
  MISSING_MATERIAL: 'missing_material',
  MISSING_DESIGN_UNIT: 'missing_design_unit',
  MISSING_ISSUE_UNIT: 'missing_issue_unit',
  RULE_MISSING: 'rule_missing',
  RULE_CONFLICT: 'rule_conflict',
})

const MATCH_STATUSES = Object.freeze({
  MATCHED: 'matched',
})

const UNIT_SCOPE_PRIORITIES = Object.freeze({
  material: 1,
  category: 2,
  generic: 3,
})

class StockPreparationUnitRuleMatchError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'StockPreparationUnitRuleMatchError'
    this.details = details
  }
}

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

function asArray(value, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new StockPreparationUnitRuleMatchError(`${field} must be an array`, { field })
  }
  return value
}

function normalizeRows(rows, field) {
  return asArray(rows, field).map((row, index) => {
    if (!isPlainObject(row)) {
      throw new StockPreparationUnitRuleMatchError(`${field}[${index}] must be an object`, { field: `${field}[${index}]` })
    }
    return { ...row }
  })
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
}

function conversionRuleIdFor(plmUnit, issueUnit, scopeType, scopeKey) {
  return `stockprep_unit_rule_${stableHash(`${plmUnit}|${issueUnit}|${scopeType}|${scopeKey || ''}`)}`
}

function sameText(left, right) {
  const a = optionalString(left)
  const b = optionalString(right)
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  return a.toLowerCase() === b.toLowerCase()
}

function firstValue(row, keys) {
  for (const key of keys) {
    const value = optionalString(row && row[key])
    if (value !== null) return value
  }
  return null
}

function drawingNoOf(line) {
  return firstValue(line, ['childDrawingNo', 'plmDrawingNo', 'componentCode'])
}

function drawingVersionOf(line) {
  return firstValue(line, ['childVersion', 'plmVersion', 'sourceVersion'])
}

function designUnitOf(line) {
  return firstValue(line, ['designUnit', 'plmUnit', 'unit'])
}

function erpCodeOf(material) {
  return firstValue(material, ['erpMaterialCode', 'FNumber', 'materialCode'])
}

function erpInternalIdOf(material) {
  return firstValue(material, ['erpMaterialInternalId', 'FItemID', 'materialInternalId', 'erpMaterialId'])
}

function issueUnitOf(material) {
  return firstValue(material, ['issueUnit', 'FIssueUnit', 'unitName'])
}

function materialCategoryKeys(material) {
  return [
    material && material.materialCategory,
    material && material.erpMaterialCategory,
    material && material.materialCategoryId,
  ].map(optionalString).filter(Boolean)
}

function materialKeys(material, mapping) {
  return [
    mapping && mapping.erpMaterialInternalId,
    mapping && mapping.erpMaterialCode,
    material && material.erpMaterialId,
    erpInternalIdOf(material),
    erpCodeOf(material),
  ].map(optionalString).filter(Boolean)
}

function activeRows(rows) {
  return rows.filter((row) => row && row.isActive !== false)
}

function mappingMatchesLine(mapping, line) {
  if (!sameText(mapping.plmDrawingNo, drawingNoOf(line))) return false
  const mappingVersion = optionalString(mapping.plmVersion)
  const lineVersion = drawingVersionOf(line)
  if (mappingVersion && lineVersion) return sameText(mappingVersion, lineVersion)
  return true
}

function findMapping(line, mappings) {
  const matches = activeRows(mappings).filter((mapping) => (
    mapping.matchStatus === MATCH_STATUSES.MATCHED &&
    optionalString(mapping.erpMaterialCode) &&
    optionalString(mapping.erpMaterialInternalId) &&
    mappingMatchesLine(mapping, line)
  ))
  return matches.length === 1 ? matches[0] : null
}

function findMaterial(mapping, materials) {
  const internalId = optionalString(mapping && mapping.erpMaterialInternalId)
  const code = optionalString(mapping && mapping.erpMaterialCode)
  return activeRows(materials).find((material) => (
    (internalId && materialKeys(material, mapping).some((key) => sameText(key, internalId))) ||
    (code && sameText(erpCodeOf(material), code))
  )) || null
}

function ruleIsConfirmed(rule) {
  return rule && (rule.requiresConfirmation !== true || optionalString(rule.confirmedBy) || optionalString(rule.confirmedAt))
}

function ruleMatches(rule, plmUnit, issueUnit, material, mapping) {
  if (!rule || rule.isActive === false || !ruleIsConfirmed(rule)) return false
  if (!sameText(rule.plmUnit, plmUnit) || !sameText(rule.erpIssueUnit, issueUnit)) return false
  const scopeType = optionalString(rule.scopeType) || 'generic'
  const scopeKey = optionalString(rule.scopeKey)
  if (scopeType === 'generic') return true
  if (scopeType === 'material') {
    return materialKeys(material, mapping).some((key) => scopeKey && sameText(key, scopeKey))
  }
  if (scopeType === 'category') {
    return materialCategoryKeys(material).some((key) => scopeKey && sameText(key, scopeKey))
  }
  return false
}

function selectConfirmedRule(plmUnit, issueUnit, material, mapping, rules) {
  const matches = activeRows(rules).filter((rule) => ruleMatches(rule, plmUnit, issueUnit, material, mapping))
  if (!matches.length) return { rule: null, conflict: false }
  const sorted = matches
    .map((rule) => ({ rule, priority: UNIT_SCOPE_PRIORITIES[optionalString(rule.scopeType) || 'generic'] || 99 }))
    .sort((left, right) => left.priority - right.priority)
  const bestPriority = sorted[0].priority
  const best = sorted.filter((entry) => entry.priority === bestPriority)
  if (best.length !== 1) return { rule: null, conflict: true }
  return { rule: best[0].rule, conflict: false }
}

function contextKey(line, mapping, material) {
  return [
    drawingNoOf(line),
    drawingVersionOf(line) || '',
    designUnitOf(line) || '',
    mapping && mapping.erpMaterialInternalId,
    mapping && mapping.erpMaterialCode,
    issueUnitOf(material) || '',
  ].join('|')
}

function makeOutcome({ line, mapping, material, outcome, reason, rule }) {
  const plmUnit = designUnitOf(line)
  const issueUnit = issueUnitOf(material)
  const scopeKey = mapping && (optionalString(mapping.erpMaterialInternalId) || optionalString(mapping.erpMaterialCode))
  const candidateRule = outcome === RULE_OUTCOMES.CANDIDATE ? {
    conversionRuleId: conversionRuleIdFor(plmUnit, issueUnit, 'material', scopeKey),
    plmUnit,
    erpIssueUnit: issueUnit,
    conversionFactor: 1,
    scopeType: 'material',
    scopeKey,
    lossRate: 0,
    roundingRule: 'none',
    minimumIssueQty: 0,
    source: 'system_candidate',
    requiresConfirmation: true,
    isActive: true,
  } : undefined
  return {
    outcome,
    reason,
    contextFingerprint: `sha16:${stableHash(contextKey(line, mapping, material))}`,
    conversionRuleId: rule && rule.conversionRuleId,
    candidateRule,
  }
}

function uniqueLines(lines) {
  const seen = new Set()
  const out = []
  for (const line of lines) {
    const key = `${drawingNoOf(line) || ''}|${drawingVersionOf(line) || ''}|${designUnitOf(line) || ''}`
    if (!drawingNoOf(line) || seen.has(key)) continue
    seen.add(key)
    out.push(line)
  }
  return out
}

function summarizeBy(rows, field) {
  const out = {}
  for (const row of rows) {
    const key = optionalString(row && row[field]) || 'unknown'
    out[key] = (out[key] || 0) + 1
  }
  return out
}

function buildValuesFreeEvidence(input, outcomes) {
  return {
    input: {
      bomSnapshotLines: input.bomSnapshotLines.length,
      materialMappings: input.materialMappings.length,
      erpMaterials: input.erpMaterials.length,
      unitConversionRules: input.unitConversionRules.length,
      uniqueUnitContexts: uniqueLines(input.bomSnapshotLines).length,
    },
    result: {
      outcomes: outcomes.length,
      candidateRules: outcomes.filter((row) => row.outcome === RULE_OUTCOMES.CANDIDATE).length,
      reusedRules: outcomes.filter((row) => row.outcome === RULE_OUTCOMES.REUSED).length,
      held: outcomes.filter((row) => row.outcome === RULE_OUTCOMES.HELD).length,
      byOutcome: summarizeBy(outcomes, 'outcome'),
      byReason: summarizeBy(outcomes, 'reason'),
    },
    valuesFree: true,
  }
}

function normalizeInput(input = {}) {
  return {
    bomSnapshotLines: normalizeRows(input.bomSnapshotLines, 'bomSnapshotLines'),
    materialMappings: normalizeRows(input.materialMappings, 'materialMappings'),
    erpMaterials: normalizeRows(input.erpMaterials, 'erpMaterials'),
    unitConversionRules: normalizeRows(input.unitConversionRules, 'unitConversionRules'),
  }
}

function generateUnitConversionRuleCandidates(input = {}) {
  const normalized = normalizeInput(input)
  const outcomes = []
  for (const line of uniqueLines(normalized.bomSnapshotLines)) {
    const mapping = findMapping(line, normalized.materialMappings)
    if (!mapping) {
      outcomes.push(makeOutcome({ line, outcome: RULE_OUTCOMES.HELD, reason: HELD_REASONS.MISSING_MAPPING }))
      continue
    }
    const material = findMaterial(mapping, normalized.erpMaterials)
    if (!material) {
      outcomes.push(makeOutcome({ line, mapping, outcome: RULE_OUTCOMES.HELD, reason: HELD_REASONS.MISSING_MATERIAL }))
      continue
    }
    const plmUnit = designUnitOf(line)
    if (!plmUnit) {
      outcomes.push(makeOutcome({ line, mapping, material, outcome: RULE_OUTCOMES.HELD, reason: HELD_REASONS.MISSING_DESIGN_UNIT }))
      continue
    }
    const issueUnit = issueUnitOf(material)
    if (!issueUnit) {
      outcomes.push(makeOutcome({ line, mapping, material, outcome: RULE_OUTCOMES.HELD, reason: HELD_REASONS.MISSING_ISSUE_UNIT }))
      continue
    }
    const selected = selectConfirmedRule(plmUnit, issueUnit, material, mapping, normalized.unitConversionRules)
    if (selected.conflict) {
      outcomes.push(makeOutcome({ line, mapping, material, outcome: RULE_OUTCOMES.HELD, reason: HELD_REASONS.RULE_CONFLICT }))
      continue
    }
    if (selected.rule) {
      outcomes.push(makeOutcome({ line, mapping, material, outcome: RULE_OUTCOMES.REUSED, reason: 'confirmed_rule', rule: selected.rule }))
      continue
    }
    if (sameText(plmUnit, issueUnit)) {
      outcomes.push(makeOutcome({ line, mapping, material, outcome: RULE_OUTCOMES.CANDIDATE, reason: 'one_to_one_candidate' }))
      continue
    }
    outcomes.push(makeOutcome({ line, mapping, material, outcome: RULE_OUTCOMES.HELD, reason: HELD_REASONS.RULE_MISSING }))
  }
  return {
    status: outcomes.some((row) => row.outcome === RULE_OUTCOMES.HELD) ? 'held' : (outcomes.some((row) => row.outcome === RULE_OUTCOMES.CANDIDATE) ? 'pending_confirmation' : 'ready'),
    outcomes,
    candidateRules: outcomes.map((row) => row.candidateRule).filter(Boolean),
    evidence: buildValuesFreeEvidence(normalized, outcomes),
  }
}

module.exports = {
  HELD_REASONS,
  RULE_OUTCOMES,
  StockPreparationUnitRuleMatchError,
  generateUnitConversionRuleCandidates,
  __internals: {
    conversionRuleIdFor,
    findMapping,
    findMaterial,
    selectConfirmedRule,
    stableHash,
    uniqueLines,
  },
}
