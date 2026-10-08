'use strict'

const crypto = require('node:crypto')

const EXCEPTION_TYPES = Object.freeze({
  MISSING_MAPPING: 'missing_mapping',
  MULTI_CANDIDATE: 'multi_candidate',
  VERSION_CONFLICT: 'version_conflict',
  MISSING_MATERIAL_MASTER: 'erp_item_missing',
  UNIT_MISSING: 'unit_missing',
  UNIT_CONFLICT: 'unit_conflict',
  INVALID_QTY: 'invalid_qty',
  MISSING_CHILD_BOM: 'missing_child_bom',
})

const PREP_STATUSES = Object.freeze({
  DRAFT: 'draft',
  HELD: 'held',
})

const UNIT_STATUSES = Object.freeze({
  CONVERTED: 'converted',
  MISSING_RULE: 'missing_rule',
  CONFLICT: 'conflict',
})

const MATERIAL_MATCH_STATUSES = Object.freeze({
  MATCHED: 'matched',
  PENDING_CONFIRM: 'pending_confirm',
  MULTI_CANDIDATE: 'multi_candidate',
  NOT_FOUND: 'not_found',
  VERSION_CONFLICT: 'version_conflict',
})

const VERSION_POLICIES = Object.freeze({
  DRAWING_AND_VERSION: 'drawing_and_version',
  DRAWING_ONLY: 'drawing_only',
  CATEGORY_RULE: 'category_rule',
  MANUAL: 'manual',
})

// OD2 round-1 hardening: only these three vocabulary values have an implementation branch in the
// matchers below. CATEGORY_RULE stays RESERVED in the vocabulary (the enum name does not move) but
// acceptance and matching are closed: a stored row carrying it — or any unknown junk string — must
// NEVER auto-match and never fall into the tail heuristic (fail-closed; #4391 doctrine: legacy
// approved rows are not trusted either).
const IMPLEMENTED_VERSION_POLICIES = Object.freeze(new Set([
  VERSION_POLICIES.DRAWING_AND_VERSION,
  VERSION_POLICIES.DRAWING_ONLY,
  VERSION_POLICIES.MANUAL,
]))

const UNIT_SCOPE_PRIORITIES = Object.freeze({
  material: 1,
  category: 2,
  generic: 3,
})

const STOCK_PREP_LINE_SYSTEM_FIELDS = Object.freeze([
  'stockPrepLineId',
  'projectId',
  'snapshotBatchId',
  'snapshotLineId',
  'parentDrawingNo',
  'childDrawingNo',
  'childVersion',
  'erpMaterialCode',
  'erpMaterialInternalId',
  'designQty',
  'designUnit',
  'conversionFactor',
  'lossRate',
  'issueQtyRaw',
  'issueQtyFinal',
  'issueUnit',
  'mappingStatus',
  'unitStatus',
  'prepStatus',
  'exceptionCount',
  'createdFromRunId',
])

class StockPreparationMvpGenerationError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'StockPreparationMvpGenerationError'
    this.details = details
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function requiredString(value, field) {
  const normalized = optionalString(value)
  if (!normalized) {
    throw new StockPreparationMvpGenerationError(`${field} is required`, { field })
  }
  return normalized
}

function asArray(value, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new StockPreparationMvpGenerationError(`${field} must be an array`, { field })
  }
  return value
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
}

function stableLineId(snapshotBatchId, snapshotLineId) {
  return `stockprep_line_${stableHash(`${snapshotBatchId}|${snapshotLineId}`)}`
}

function stableExceptionId(snapshotBatchId, snapshotLineId, exceptionType, index) {
  return `stockprep_exception_${stableHash(`${snapshotBatchId}|${snapshotLineId}|${exceptionType}|${index}`)}`
}

function numberOrNull(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function sameText(left, right) {
  const a = optionalString(left)
  const b = optionalString(right)
  return a !== null && b !== null && a.toLowerCase() === b.toLowerCase()
}

function mappingMatchesLine(mapping, line) {
  if (!sameText(mapping.plmDrawingNo, line.childDrawingNo)) return false
  const policy = optionalString(mapping.versionPolicy) || VERSION_POLICIES.MANUAL
  // OD2 fail-closed match guard: an UNIMPLEMENTED policy value (category_rule or any junk string)
  // never auto-matches — the line degrades to a visible missing_mapping exception (HELD) instead.
  if (!IMPLEMENTED_VERSION_POLICIES.has(policy)) return false
  if (policy === VERSION_POLICIES.DRAWING_ONLY) return true
  const mappingVersion = optionalString(mapping.plmVersion)
  const lineVersion = optionalString(line.childVersion)
  if (policy === VERSION_POLICIES.DRAWING_AND_VERSION) {
    return mappingVersion !== null && lineVersion !== null && sameText(mappingVersion, lineVersion)
  }
  if (mappingVersion && lineVersion) return sameText(mappingVersion, lineVersion)
  return true
}

function mappingHasVersionConflict(mapping, line) {
  if (!sameText(mapping.plmDrawingNo, line.childDrawingNo)) return false
  const policy = optionalString(mapping.versionPolicy) || VERSION_POLICIES.MANUAL
  // OD2 fail-closed (round 2): the policy guard runs BEFORE the stored-status short-circuit — a
  // legacy row carrying an unimplemented policy must not force version_conflict via a stored
  // matchStatus either. It never participates at all; the visible exception is missing_mapping.
  if (!IMPLEMENTED_VERSION_POLICIES.has(policy)) return false
  if (mapping.matchStatus === MATERIAL_MATCH_STATUSES.VERSION_CONFLICT) return true
  if (policy !== VERSION_POLICIES.DRAWING_AND_VERSION) return false
  const mappingVersion = optionalString(mapping.plmVersion)
  const lineVersion = optionalString(line.childVersion)
  if (!mappingVersion || !lineVersion) return false
  return !sameText(mappingVersion, lineVersion)
}

function activeRows(rows) {
  return rows.filter((row) => row && row.isActive !== false)
}

function selectConfirmedMapping(line, materialMappings) {
  const activeMappings = activeRows(materialMappings)
  const candidates = activeMappings.filter((mapping) => mappingMatchesLine(mapping, line))
  const versionConflicts = activeMappings.filter((mapping) => mappingHasVersionConflict(mapping, line))
  const confirmed = candidates.filter((mapping) => mapping.matchStatus === MATERIAL_MATCH_STATUSES.MATCHED)
  if (confirmed.length === 1) {
    return { mapping: confirmed[0], exceptionType: null, candidateCount: candidates.length }
  }
  if (confirmed.length > 1) {
    return { mapping: null, exceptionType: EXCEPTION_TYPES.MULTI_CANDIDATE, candidateCount: confirmed.length }
  }
  if (versionConflicts.length) {
    return { mapping: null, exceptionType: EXCEPTION_TYPES.VERSION_CONFLICT, candidateCount: versionConflicts.length }
  }
  if (candidates.length > 1 || candidates.some((mapping) => mapping.matchStatus === MATERIAL_MATCH_STATUSES.MULTI_CANDIDATE)) {
    return { mapping: null, exceptionType: EXCEPTION_TYPES.MULTI_CANDIDATE, candidateCount: candidates.length }
  }
  return { mapping: null, exceptionType: EXCEPTION_TYPES.MISSING_MAPPING, candidateCount: candidates.length }
}

function findErpMaterial(mapping, erpMaterials) {
  const internalId = optionalString(mapping.erpMaterialInternalId)
  const code = optionalString(mapping.erpMaterialCode)
  return erpMaterials.find((material) => (
    (internalId && sameText(material.erpMaterialInternalId, internalId)) ||
    (code && sameText(material.erpMaterialCode, code)) ||
    (internalId && sameText(material.erpMaterialId, internalId))
  )) || null
}

function materialCategoryKeys(material) {
  return [
    material && material.materialCategory,
    material && material.erpMaterialCategory,
    material && material.materialCategoryId,
  ].map(optionalString).filter(Boolean)
}

function unitRuleMatches(rule, line, mapping, material) {
  if (!rule || rule.isActive === false) return false
  if (!sameText(rule.plmUnit, line.designUnit)) return false
  const materialIssueUnit = optionalString(material && material.issueUnit)
  if (materialIssueUnit && !sameText(rule.erpIssueUnit, materialIssueUnit)) return false
  const scopeType = optionalString(rule.scopeType) || 'generic'
  const scopeKey = optionalString(rule.scopeKey)
  if (scopeType === 'generic') return true
  if (scopeType === 'material') {
    return [
      mapping.erpMaterialCode,
      mapping.erpMaterialInternalId,
      material && material.erpMaterialId,
    ].some((value) => scopeKey && sameText(value, scopeKey))
  }
  if (scopeType === 'category') {
    return materialCategoryKeys(material).some((value) => scopeKey && sameText(value, scopeKey))
  }
  return false
}

function selectUnitRule(line, mapping, material, unitConversionRules) {
  const matches = activeRows(unitConversionRules).filter((rule) => unitRuleMatches(rule, line, mapping, material))
  if (!matches.length) {
    return { rule: null, exceptionType: EXCEPTION_TYPES.UNIT_MISSING, candidateCount: 0 }
  }
  const sorted = matches
    .map((rule) => ({ rule, priority: UNIT_SCOPE_PRIORITIES[optionalString(rule.scopeType) || 'generic'] || 99 }))
    .sort((left, right) => left.priority - right.priority)
  const bestPriority = sorted[0].priority
  const best = sorted.filter((entry) => entry.priority === bestPriority).map((entry) => entry.rule)
  if (best.length !== 1) {
    return { rule: null, exceptionType: EXCEPTION_TYPES.UNIT_CONFLICT, candidateCount: best.length }
  }
  const selected = best[0]
  if (selected.requiresConfirmation === true && !optionalString(selected.confirmedBy) && !optionalString(selected.confirmedAt)) {
    return { rule: null, exceptionType: EXCEPTION_TYPES.UNIT_MISSING, candidateCount: best.length }
  }
  return { rule: selected, exceptionType: null, candidateCount: matches.length }
}

function applyRounding(value, roundingRule, minimumIssueQty) {
  const rule = optionalString(roundingRule) || 'none'
  const minimum = numberOrNull(minimumIssueQty)
  let rounded = value
  if (rule === 'ceil') rounded = Math.ceil(value)
  if (rule === 'floor') rounded = Math.floor(value)
  if (rule === 'nearest') rounded = Math.round(value)
  if (rule === 'pack_size' && minimum && minimum > 0) {
    rounded = Math.ceil(value / minimum) * minimum
  }
  if (minimum && minimum > 0 && rounded < minimum) return minimum
  return rounded
}

function calculateIssueQuantity(line, rule) {
  const designQty = numberOrNull(line.designQty)
  const conversionFactor = numberOrNull(rule.conversionFactor)
  const lossRate = numberOrNull(rule.lossRate) || 0
  if (!designQty || designQty <= 0 || !conversionFactor || conversionFactor <= 0) {
    return null
  }
  const issueQtyRaw = designQty * conversionFactor * (1 + lossRate)
  const issueQtyFinal = applyRounding(issueQtyRaw, rule.roundingRule, rule.minimumIssueQty)
  return { designQty, conversionFactor, lossRate, issueQtyRaw, issueQtyFinal }
}

function makeException({ projectId, snapshotBatchId, line, exceptionType, index, message }) {
  return {
    exceptionId: stableExceptionId(snapshotBatchId, line.snapshotLineId, exceptionType, index),
    projectId,
    snapshotBatchId,
    snapshotLineId: line.snapshotLineId,
    stockPrepLineId: stableLineId(snapshotBatchId, line.snapshotLineId),
    exceptionType,
    severity: 'blocking',
    status: 'open',
    message,
  }
}

function mergePreservedHumanFields(generated, existing, humanFieldIds = []) {
  if (!isPlainObject(existing)) return generated
  const systemFields = new Set(STOCK_PREP_LINE_SYSTEM_FIELDS)
  const explicitHuman = new Set(humanFieldIds)
  const out = { ...generated }
  for (const [key, value] of Object.entries(existing)) {
    if (explicitHuman.has(key) || (!systemFields.has(key) && !(key in generated))) {
      out[key] = value
    }
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

function buildValuesFreeEvidence(input, lines, exceptions) {
  return {
    input: {
      bomSnapshotLines: input.bomSnapshotLines.length,
      erpMaterials: input.erpMaterials.length,
      materialMappings: input.materialMappings.length,
      unitConversionRules: input.unitConversionRules.length,
      existingStockPreparationLines: input.existingStockPreparationLines.length,
    },
    result: {
      generatedLines: lines.length,
      exceptions: exceptions.length,
      byPrepStatus: summarizeBy(lines, 'prepStatus'),
      byMappingStatus: summarizeBy(lines, 'mappingStatus'),
      byUnitStatus: summarizeBy(lines, 'unitStatus'),
      byExceptionType: summarizeBy(exceptions, 'exceptionType'),
    },
    valuesFree: true,
  }
}

function normalizeInput(input = {}) {
  const projectId = requiredString(input.projectId, 'projectId')
  const snapshotBatchId = requiredString(input.snapshotBatchId, 'snapshotBatchId')
  return {
    projectId,
    snapshotBatchId,
    runId: optionalString(input.runId) || `stockprep_run_${stableHash(`${projectId}|${snapshotBatchId}`)}`,
    bomSnapshotLines: asArray(input.bomSnapshotLines, 'bomSnapshotLines'),
    erpMaterials: asArray(input.erpMaterials, 'erpMaterials'),
    materialMappings: asArray(input.materialMappings, 'materialMappings'),
    unitConversionRules: asArray(input.unitConversionRules, 'unitConversionRules'),
    existingStockPreparationLines: asArray(input.existingStockPreparationLines, 'existingStockPreparationLines'),
    humanFieldIds: asArray(input.humanFieldIds, 'humanFieldIds').map(String),
  }
}

function generateStockPreparationMvp(input = {}) {
  const normalized = normalizeInput(input)
  const existingByLineId = new Map(
    normalized.existingStockPreparationLines
      .filter((line) => optionalString(line && line.stockPrepLineId))
      .map((line) => [line.stockPrepLineId, line]),
  )
  const lines = []
  const exceptions = []
  for (const [index, line] of normalized.bomSnapshotLines.entries()) {
    if (!isPlainObject(line)) {
      throw new StockPreparationMvpGenerationError('bomSnapshotLines entries must be objects', {
        field: `bomSnapshotLines[${index}]`,
      })
    }
    const snapshotLineId = requiredString(line.snapshotLineId, `bomSnapshotLines[${index}].snapshotLineId`)
    const workingLine = { ...line, snapshotLineId }
    const lineExceptions = []

    if (workingLine.missingChildBom === true || workingLine.lineStatus === EXCEPTION_TYPES.MISSING_CHILD_BOM) {
      lineExceptions.push({
        exceptionType: EXCEPTION_TYPES.MISSING_CHILD_BOM,
        message: 'BOM line is marked as missing child BOM',
      })
    }

    const designQty = numberOrNull(workingLine.designQty)
    if (!designQty || designQty <= 0) {
      lineExceptions.push({
        exceptionType: EXCEPTION_TYPES.INVALID_QTY,
        message: 'BOM line design quantity is missing or invalid',
      })
    }

    const mappingSelection = selectConfirmedMapping(workingLine, normalized.materialMappings)
    let material = null
    if (mappingSelection.exceptionType) {
      lineExceptions.push({
        exceptionType: mappingSelection.exceptionType,
        message: 'BOM line does not have a unique confirmed material mapping',
      })
    } else {
      material = findErpMaterial(mappingSelection.mapping, normalized.erpMaterials)
      if (!material) {
        lineExceptions.push({
          exceptionType: EXCEPTION_TYPES.MISSING_MATERIAL_MASTER,
          message: 'Confirmed material mapping does not resolve to an ERP/K3 material master row',
        })
      }
    }

    let unitSelection = { rule: null, exceptionType: null }
    let quantity = null
    if (!lineExceptions.length && mappingSelection.mapping && material) {
      unitSelection = selectUnitRule(workingLine, mappingSelection.mapping, material, normalized.unitConversionRules)
      if (unitSelection.exceptionType) {
        lineExceptions.push({
          exceptionType: unitSelection.exceptionType,
          message: 'BOM line does not have a unique confirmed unit conversion rule',
        })
      } else {
        quantity = calculateIssueQuantity(workingLine, unitSelection.rule)
        if (!quantity) {
          lineExceptions.push({
            exceptionType: EXCEPTION_TYPES.INVALID_QTY,
            message: 'BOM line quantity or conversion factor is invalid',
          })
        }
      }
    }

    if (lineExceptions.length) {
      for (const [exceptionIndex, exception] of lineExceptions.entries()) {
        exceptions.push(makeException({
          projectId: normalized.projectId,
          snapshotBatchId: normalized.snapshotBatchId,
          line: workingLine,
          exceptionType: exception.exceptionType,
          index: exceptionIndex,
          message: exception.message,
        }))
      }
      continue
    }

    const stockPrepLineId = stableLineId(normalized.snapshotBatchId, workingLine.snapshotLineId)
    const generated = {
      stockPrepLineId,
      projectId: normalized.projectId,
      snapshotBatchId: normalized.snapshotBatchId,
      snapshotLineId: workingLine.snapshotLineId,
      parentDrawingNo: workingLine.parentDrawingNo,
      childDrawingNo: workingLine.childDrawingNo,
      childVersion: workingLine.childVersion,
      erpMaterialCode: mappingSelection.mapping.erpMaterialCode,
      erpMaterialInternalId: mappingSelection.mapping.erpMaterialInternalId,
      designQty: quantity.designQty,
      designUnit: workingLine.designUnit,
      conversionFactor: quantity.conversionFactor,
      lossRate: quantity.lossRate,
      issueQtyRaw: quantity.issueQtyRaw,
      issueQtyFinal: quantity.issueQtyFinal,
      issueUnit: unitSelection.rule.erpIssueUnit,
      mappingStatus: MATERIAL_MATCH_STATUSES.MATCHED,
      unitStatus: UNIT_STATUSES.CONVERTED,
      prepStatus: PREP_STATUSES.DRAFT,
      exceptionCount: 0,
      createdFromRunId: normalized.runId,
    }
    lines.push(mergePreservedHumanFields(generated, existingByLineId.get(stockPrepLineId), normalized.humanFieldIds))
  }

  return {
    status: exceptions.length ? (lines.length ? 'partial' : 'blocked') : 'ready',
    projectId: normalized.projectId,
    snapshotBatchId: normalized.snapshotBatchId,
    runId: normalized.runId,
    lines,
    exceptions,
    evidence: buildValuesFreeEvidence(normalized, lines, exceptions),
  }
}

module.exports = {
  EXCEPTION_TYPES,
  PREP_STATUSES,
  UNIT_STATUSES,
  MATERIAL_MATCH_STATUSES,
  VERSION_POLICIES,
  IMPLEMENTED_VERSION_POLICIES,
  StockPreparationMvpGenerationError,
  generateStockPreparationMvp,
  __internals: {
    stableHash,
    stableLineId,
    stableExceptionId,
    selectConfirmedMapping,
    selectUnitRule,
    calculateIssueQuantity,
    mergePreservedHumanFields,
    buildValuesFreeEvidence,
  },
}
