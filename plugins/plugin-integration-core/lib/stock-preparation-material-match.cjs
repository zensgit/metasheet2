'use strict'

const crypto = require('node:crypto')

const {
  firstValue,
  isPlainObject,
  optionalString,
  sameText,
} = require('./stock-preparation-common.cjs')

const MATCH_STATUSES = Object.freeze({
  MATCHED: 'matched',
  PENDING_CONFIRM: 'pending_confirm',
  MULTI_CANDIDATE: 'multi_candidate',
  NOT_FOUND: 'not_found',
  VERSION_CONFLICT: 'version_conflict',
})

const MATCH_METHODS = Object.freeze({
  HISTORICAL_CONFIRMED: 'historical_confirmed',
  EXACT_CODE: 'exact_code_candidate',
  NORMALIZED_CODE: 'normalized_code_candidate',
  NAME_SPEC: 'name_spec_candidate',
  NONE: 'none',
})

const VERSION_POLICIES = Object.freeze({
  DRAWING_AND_VERSION: 'drawing_and_version',
  DRAWING_ONLY: 'drawing_only',
  MANUAL: 'manual',
})

// OD2 round-1 hardening: exactly these three policies have an implementation branch below.
// `category_rule` stays RESERVED in the wider vocabulary (stock-preparation-mvp-generation.cjs
// VERSION_POLICIES) but has NO branch — so it, like any unknown stored string, must NEVER
// auto-match and never fall into the tail heuristic (fail-closed; #4391 doctrine: stored legacy
// rows are not trusted either). Enumerated EXPLICITLY (never derived from the enum object) so a
// future vocabulary widening cannot silently widen this guard without adding a matcher branch.
const IMPLEMENTED_VERSION_POLICIES = Object.freeze(new Set([
  VERSION_POLICIES.DRAWING_AND_VERSION,
  VERSION_POLICIES.DRAWING_ONLY,
  VERSION_POLICIES.MANUAL,
]))

class StockPreparationMaterialMatchError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'StockPreparationMaterialMatchError'
    this.details = details
  }
}

function requiredString(value, field) {
  const normalized = optionalString(value)
  if (!normalized) {
    throw new StockPreparationMaterialMatchError(`${field} is required`, { field })
  }
  return normalized
}

function asArray(value, field) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new StockPreparationMaterialMatchError(`${field} must be an array`, { field })
  }
  return value
}

function normalizeRows(rows, field) {
  return asArray(rows, field).map((row, index) => {
    if (!isPlainObject(row)) {
      throw new StockPreparationMaterialMatchError(`${field}[${index}] must be an object`, { field: `${field}[${index}]` })
    }
    return { ...row }
  })
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
}

function mappingIdFor(drawingNo, version, method, materialKey = '') {
  return `stockprep_mapping_${stableHash(`${drawingNo}|${version || ''}|${method}|${materialKey}`)}`
}

function normalizeCode(value) {
  const text = optionalString(value)
  return text ? text.toLowerCase().replace(/[^a-z0-9]/g, '') : null
}

function drawingNoOf(line) {
  return firstValue(line, ['childDrawingNo', 'plmDrawingNo', 'componentCode', 'drawingNo'])
}

function drawingVersionOf(line) {
  return firstValue(line, ['childVersion', 'plmVersion', 'sourceVersion', 'version'])
}

function plmNameOf(line) {
  return firstValue(line, ['plmMaterialName', 'childName', 'componentName', 'name'])
}

function plmSpecOf(line) {
  return firstValue(line, ['plmSpec', 'childSpec', 'spec', 'specification'])
}

function erpCodeOf(material) {
  return firstValue(material, ['erpMaterialCode', 'FNumber', 'materialCode', 'code'])
}

function erpInternalIdOf(material) {
  return firstValue(material, ['erpMaterialInternalId', 'FItemID', 'materialInternalId', 'itemId'])
}

function erpNameOf(material) {
  return firstValue(material, ['erpMaterialName', 'FName', 'name'])
}

function erpSpecOf(material) {
  return firstValue(material, ['erpSpec', 'FModel', 'spec', 'specification'])
}

function activeRows(rows) {
  return rows.filter((row) => row && row.isActive !== false)
}

function mappingMatchesLine(mapping, drawingNo, version) {
  if (!sameText(mapping.plmDrawingNo, drawingNo)) return false
  const policy = optionalString(mapping.versionPolicy) || VERSION_POLICIES.MANUAL
  // OD2 fail-closed match guard: an UNIMPLEMENTED policy value (category_rule or any junk string)
  // never auto-matches — the line degrades to a visible missing-mapping exception instead.
  if (!IMPLEMENTED_VERSION_POLICIES.has(policy)) return false
  if (policy === VERSION_POLICIES.DRAWING_ONLY) return true
  if (policy === VERSION_POLICIES.DRAWING_AND_VERSION) {
    return optionalString(version) !== null && sameText(mapping.plmVersion, version)
  }
  const mappingVersion = optionalString(mapping.plmVersion)
  if (mappingVersion && version) return sameText(mappingVersion, version)
  return true
}

function mappingIsVersionConflict(mapping, drawingNo, version) {
  if (!sameText(mapping.plmDrawingNo, drawingNo)) return false
  const policy = optionalString(mapping.versionPolicy) || VERSION_POLICIES.MANUAL
  // OD2 fail-closed (round 2): the policy guard runs BEFORE the stored-status short-circuit — a
  // legacy row carrying an unimplemented policy must not force version_conflict via a stored
  // matchStatus either. It never participates at all; the visible exception is the missing path.
  if (!IMPLEMENTED_VERSION_POLICIES.has(policy)) return false
  if (mapping.matchStatus === MATCH_STATUSES.VERSION_CONFLICT) return true
  if (policy !== VERSION_POLICIES.DRAWING_AND_VERSION) return false
  const mappingVersion = optionalString(mapping.plmVersion)
  return Boolean(mappingVersion && version && !sameText(mappingVersion, version))
}

function selectHistoricalMapping(line, confirmedMappings) {
  const drawingNo = drawingNoOf(line)
  const version = drawingVersionOf(line)
  const activeMappings = activeRows(confirmedMappings)
  const matched = activeMappings.filter((mapping) => (
    mapping.matchStatus === MATCH_STATUSES.MATCHED &&
    optionalString(mapping.erpMaterialCode) &&
    optionalString(mapping.erpMaterialInternalId) &&
    mappingMatchesLine(mapping, drawingNo, version)
  ))
  if (matched.length === 1) return { mapping: matched[0], status: MATCH_STATUSES.MATCHED }
  if (matched.length > 1) return { mapping: null, status: MATCH_STATUSES.MULTI_CANDIDATE }
  const conflicts = activeMappings.filter((mapping) => mappingIsVersionConflict(mapping, drawingNo, version))
  if (conflicts.length > 0) return { mapping: null, status: MATCH_STATUSES.VERSION_CONFLICT }
  return { mapping: null, status: null }
}

function materialKey(material) {
  return erpInternalIdOf(material) || erpCodeOf(material) || ''
}

function uniqueMaterials(materials) {
  const seen = new Set()
  const out = []
  for (const material of materials) {
    const key = materialKey(material)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(material)
  }
  return out
}

function candidateMaterials(line, erpMaterials) {
  const drawingNo = drawingNoOf(line)
  const normalizedDrawingNo = normalizeCode(drawingNo)
  const name = plmNameOf(line)
  const spec = plmSpecOf(line)
  const activeMaterials = activeRows(erpMaterials)

  const exact = activeMaterials.filter((material) => sameText(erpCodeOf(material), drawingNo))
  if (exact.length) return { method: MATCH_METHODS.EXACT_CODE, confidence: 0.95, materials: uniqueMaterials(exact) }

  const normalized = activeMaterials.filter((material) => normalizedDrawingNo && normalizeCode(erpCodeOf(material)) === normalizedDrawingNo)
  if (normalized.length) return { method: MATCH_METHODS.NORMALIZED_CODE, confidence: 0.9, materials: uniqueMaterials(normalized) }

  const nameSpec = activeMaterials.filter((material) => {
    const nameMatched = name && sameText(erpNameOf(material), name)
    const specMatched = spec && sameText(erpSpecOf(material), spec)
    return Boolean((name && spec && nameMatched && specMatched) || (nameMatched && !spec) || (specMatched && !name))
  })
  if (nameSpec.length) return { method: MATCH_METHODS.NAME_SPEC, confidence: 0.65, materials: uniqueMaterials(nameSpec) }

  return { method: MATCH_METHODS.NONE, confidence: 0, materials: [] }
}

function makeMappingRow({ line, material, status, method, confidence, versionPolicy }) {
  const drawingNo = requiredString(drawingNoOf(line), 'line drawing number')
  const version = drawingVersionOf(line)
  const materialCode = material ? erpCodeOf(material) : null
  const internalId = material ? erpInternalIdOf(material) : null
  return {
    mappingId: mappingIdFor(drawingNo, version, method, material ? materialKey(material) : status),
    plmDrawingNo: drawingNo,
    plmVersion: version,
    plmMaterialName: plmNameOf(line),
    plmSpec: plmSpecOf(line),
    erpMaterialCode: materialCode || undefined,
    erpMaterialInternalId: internalId || undefined,
    erpMaterialName: material ? erpNameOf(material) : undefined,
    erpSpec: material ? erpSpecOf(material) : undefined,
    versionPolicy: versionPolicy || VERSION_POLICIES.DRAWING_AND_VERSION,
    matchStatus: status,
    matchMethod: method,
    confidence,
    isActive: true,
  }
}

function makeHistoricalRow(line, mapping) {
  return {
    mappingId: mapping.mappingId || mappingIdFor(mapping.plmDrawingNo, mapping.plmVersion, MATCH_METHODS.HISTORICAL_CONFIRMED, mapping.erpMaterialInternalId || mapping.erpMaterialCode),
    plmDrawingNo: mapping.plmDrawingNo,
    plmVersion: mapping.plmVersion,
    plmMaterialName: mapping.plmMaterialName || plmNameOf(line),
    plmSpec: mapping.plmSpec || plmSpecOf(line),
    erpMaterialCode: mapping.erpMaterialCode,
    erpMaterialInternalId: mapping.erpMaterialInternalId,
    erpMaterialName: mapping.erpMaterialName,
    erpSpec: mapping.erpSpec,
    versionPolicy: mapping.versionPolicy || VERSION_POLICIES.DRAWING_AND_VERSION,
    matchStatus: MATCH_STATUSES.MATCHED,
    matchMethod: MATCH_METHODS.HISTORICAL_CONFIRMED,
    confidence: 1,
    isActive: true,
    confirmedBy: mapping.confirmedBy,
    confirmedAt: mapping.confirmedAt,
  }
}

function uniquePlmItems(lines) {
  const seen = new Set()
  const out = []
  for (const line of lines) {
    const drawingNo = drawingNoOf(line)
    if (!drawingNo) continue
    const key = `${drawingNo.toLowerCase()}|${(drawingVersionOf(line) || '').toLowerCase()}`
    if (seen.has(key)) continue
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

function buildValuesFreeEvidence(input, rows) {
  return {
    input: {
      plmBomLines: input.plmBomLines.length,
      uniquePlmItems: uniquePlmItems(input.plmBomLines).length,
      erpMaterials: input.erpMaterials.length,
      confirmedMappings: input.confirmedMappings.length,
    },
    result: {
      mappingRows: rows.length,
      byMatchStatus: summarizeBy(rows, 'matchStatus'),
      byMatchMethod: summarizeBy(rows, 'matchMethod'),
    },
    valuesFree: true,
  }
}

function normalizeInput(input = {}) {
  const defaultVersionPolicy = optionalString(input.defaultVersionPolicy)
  // OD2 input boundary (engine-level backstop; the route validator rejects first with 422): a
  // SUPPLIED defaultVersionPolicy outside the implemented set is refused — it would be stamped
  // onto every generated candidate row. Details carry the field NAME only (values-free).
  if (defaultVersionPolicy && !IMPLEMENTED_VERSION_POLICIES.has(defaultVersionPolicy)) {
    throw new StockPreparationMaterialMatchError('defaultVersionPolicy is not an implemented version policy', { field: 'defaultVersionPolicy' })
  }
  return {
    plmBomLines: normalizeRows(input.plmBomLines, 'plmBomLines'),
    erpMaterials: normalizeRows(input.erpMaterials, 'erpMaterials'),
    confirmedMappings: normalizeRows(input.confirmedMappings, 'confirmedMappings'),
    defaultVersionPolicy: defaultVersionPolicy || VERSION_POLICIES.DRAWING_AND_VERSION,
  }
}

function generateMaterialMappingCandidates(input = {}) {
  const normalized = normalizeInput(input)
  const rows = []
  for (const line of uniquePlmItems(normalized.plmBomLines)) {
    const historical = selectHistoricalMapping(line, normalized.confirmedMappings)
    if (historical.status === MATCH_STATUSES.MATCHED) {
      rows.push(makeHistoricalRow(line, historical.mapping))
      continue
    }
    if (historical.status === MATCH_STATUSES.MULTI_CANDIDATE) {
      rows.push(makeMappingRow({
        line,
        status: MATCH_STATUSES.MULTI_CANDIDATE,
        method: MATCH_METHODS.HISTORICAL_CONFIRMED,
        confidence: 0,
        versionPolicy: normalized.defaultVersionPolicy,
      }))
      continue
    }
    if (historical.status === MATCH_STATUSES.VERSION_CONFLICT) {
      rows.push(makeMappingRow({
        line,
        status: MATCH_STATUSES.VERSION_CONFLICT,
        method: MATCH_METHODS.HISTORICAL_CONFIRMED,
        confidence: 0,
        versionPolicy: normalized.defaultVersionPolicy,
      }))
      continue
    }

    const candidates = candidateMaterials(line, normalized.erpMaterials)
    if (candidates.materials.length === 0) {
      rows.push(makeMappingRow({
        line,
        status: MATCH_STATUSES.NOT_FOUND,
        method: MATCH_METHODS.NONE,
        confidence: 0,
        versionPolicy: normalized.defaultVersionPolicy,
      }))
      continue
    }
    if (candidates.materials.length > 1) {
      rows.push(makeMappingRow({
        line,
        status: MATCH_STATUSES.MULTI_CANDIDATE,
        method: candidates.method,
        confidence: candidates.confidence,
        versionPolicy: normalized.defaultVersionPolicy,
      }))
      continue
    }
    rows.push(makeMappingRow({
      line,
      material: candidates.materials[0],
      status: MATCH_STATUSES.PENDING_CONFIRM,
      method: candidates.method,
      confidence: candidates.confidence,
      versionPolicy: normalized.defaultVersionPolicy,
    }))
  }

  return {
    status: rows.some((row) => row.matchStatus !== MATCH_STATUSES.MATCHED) ? 'pending_confirmation' : 'matched',
    mappingRows: rows,
    evidence: buildValuesFreeEvidence(normalized, rows),
  }
}

module.exports = {
  MATCH_METHODS,
  MATCH_STATUSES,
  VERSION_POLICIES,
  IMPLEMENTED_VERSION_POLICIES,
  StockPreparationMaterialMatchError,
  generateMaterialMappingCandidates,
  __internals: {
    candidateMaterials,
    mappingIdFor,
    normalizeCode,
    selectHistoricalMapping,
    stableHash,
    uniquePlmItems,
  },
}
