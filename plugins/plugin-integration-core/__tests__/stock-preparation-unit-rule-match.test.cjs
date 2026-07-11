'use strict'

// Slice #3767: pure unit-conversion rule candidate planning. Proposed rules
// require confirmation and no external write/read is performed.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  HELD_REASONS,
  RULE_OUTCOMES,
  StockPreparationUnitRuleMatchError,
  generateUnitConversionRuleCandidates,
} = require(path.join(__dirname, '..', 'lib', 'stock-preparation-unit-rule-match.cjs'))

function line(overrides = {}) {
  return {
    snapshotLineId: 'line_alpha',
    childDrawingNo: 'DRAW-001',
    childVersion: 'A',
    designUnit: 'piece',
    ...overrides,
  }
}

function mapping(overrides = {}) {
  return {
    mappingId: 'mapping_alpha',
    plmDrawingNo: 'DRAW-001',
    plmVersion: 'A',
    erpMaterialCode: 'ERP-CODE-001',
    erpMaterialInternalId: 'ERP-INTERNAL-001',
    matchStatus: 'matched',
    isActive: true,
    ...overrides,
  }
}

function material(overrides = {}) {
  return {
    erpMaterialId: 'ERP-INTERNAL-001',
    erpMaterialCode: 'ERP-CODE-001',
    erpMaterialInternalId: 'ERP-INTERNAL-001',
    erpMaterialCategory: 'category_alpha',
    issueUnit: 'kg',
    isActive: true,
    ...overrides,
  }
}

function rule(overrides = {}) {
  return {
    conversionRuleId: 'rule_generic_alpha',
    plmUnit: 'piece',
    erpIssueUnit: 'kg',
    conversionFactor: 2,
    scopeType: 'generic',
    isActive: true,
    requiresConfirmation: false,
    ...overrides,
  }
}

function result(overrides = {}) {
  return generateUnitConversionRuleCandidates({
    bomSnapshotLines: [line()],
    materialMappings: [mapping()],
    erpMaterials: [material()],
    unitConversionRules: [rule()],
    ...overrides,
  })
}

function main() {
  const reused = result({
    unitConversionRules: [
      rule({ conversionRuleId: 'rule_generic', conversionFactor: 2, scopeType: 'generic' }),
      rule({ conversionRuleId: 'rule_category', conversionFactor: 3, scopeType: 'category', scopeKey: 'category_alpha' }),
      rule({ conversionRuleId: 'rule_material', conversionFactor: 4, scopeType: 'material', scopeKey: 'ERP-INTERNAL-001' }),
    ],
  })
  assert.equal(reused.status, 'ready')
  assert.equal(reused.outcomes.length, 1)
  assert.equal(reused.outcomes[0].outcome, RULE_OUTCOMES.REUSED)
  assert.equal(reused.outcomes[0].conversionRuleId, 'rule_material', 'material rule has highest priority')
  assert.equal(reused.candidateRules.length, 0)

  const oneToOne = result({
    erpMaterials: [material({ issueUnit: 'piece' })],
    unitConversionRules: [],
  })
  assert.equal(oneToOne.status, 'pending_confirmation')
  assert.equal(oneToOne.outcomes[0].outcome, RULE_OUTCOMES.CANDIDATE)
  assert.equal(oneToOne.outcomes[0].reason, 'one_to_one_candidate')
  assert.equal(oneToOne.candidateRules.length, 1)
  assert.equal(oneToOne.candidateRules[0].conversionFactor, 1)
  assert.equal(oneToOne.candidateRules[0].requiresConfirmation, true)
  assert.equal(oneToOne.candidateRules[0].scopeType, 'material')

  const conflict = result({
    unitConversionRules: [
      rule({ conversionRuleId: 'rule_material_a', scopeType: 'material', scopeKey: 'ERP-INTERNAL-001' }),
      rule({ conversionRuleId: 'rule_material_b', scopeType: 'material', scopeKey: 'ERP-INTERNAL-001' }),
    ],
  })
  assert.equal(conflict.status, 'held')
  assert.equal(conflict.outcomes[0].outcome, RULE_OUTCOMES.HELD)
  assert.equal(conflict.outcomes[0].reason, HELD_REASONS.RULE_CONFLICT)

  assert.equal(result({ materialMappings: [] }).outcomes[0].reason, HELD_REASONS.MISSING_MAPPING)
  assert.equal(result({ erpMaterials: [] }).outcomes[0].reason, HELD_REASONS.MISSING_MATERIAL)
  assert.equal(result({ bomSnapshotLines: [line({ designUnit: '' })] }).outcomes[0].reason, HELD_REASONS.MISSING_DESIGN_UNIT)
  assert.equal(result({ erpMaterials: [material({ issueUnit: '' })] }).outcomes[0].reason, HELD_REASONS.MISSING_ISSUE_UNIT)
  assert.equal(result({ unitConversionRules: [] }).outcomes[0].reason, HELD_REASONS.RULE_MISSING)

  const duplicateContexts = result({
    bomSnapshotLines: [line(), line({ snapshotLineId: 'line_beta' })],
  })
  assert.equal(duplicateContexts.outcomes.length, 1, 'same drawing/version/unit context is planned once')

  const evidenceText = JSON.stringify(reused.evidence)
  for (const rawValue of ['DRAW-001', 'ERP-CODE-001', 'ERP-INTERNAL-001', 'category_alpha', 'rule_material']) {
    assert.equal(evidenceText.includes(rawValue), false, `evidence omits row value ${rawValue}`)
  }
  assert.deepEqual(reused.evidence.result.byOutcome, { reused: 1 })
  assert.deepEqual(reused.evidence.result.byReason, { confirmed_rule: 1 })

  assert.throws(
    () => generateUnitConversionRuleCandidates({ bomSnapshotLines: {}, materialMappings: [] }),
    StockPreparationUnitRuleMatchError,
    'array contract is enforced',
  )

  console.log('stock-preparation-unit-rule-match.test.cjs OK')
}

main()
