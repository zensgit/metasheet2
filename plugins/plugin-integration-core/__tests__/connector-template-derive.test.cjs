'use strict'

// DF-T2a derive helper tests. Plain node test (throws on failure). Focus: the three P1
// redaction-boundary footgun classes + the shape-driven classification.

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  TemplateDeriveError,
  deriveTemplateDraft,
  summarizeTemplateForEvidence,
  deriveK3MaterialTemplateDraft,
  K3_MATERIAL_GATED_FIELDS,
} = require(path.join(__dirname, '..', 'lib', 'connector-template-derive.cjs'))

// A clean, RAW operator-local K3 material sample. Distinctive values so the evidence-no-leak
// check below is unambiguous.
function rawK3Material() {
  return {
    FNumber: 'MAT-XYZ-001',
    FName: 'WidgetDisplayName',
    FModel: 'ModelSpecX1',
    FUnitID: { FNumber: 'UNITPCS', FName: 'PiecesUnitName' },        // reference by FNumber/FName
    FErpClsID: { FID: 'CLSIDZ10', FName: 'CategoryStdName' },        // reference by FID/FName
    FBaseUnitID: { FNumber: 'UNITPCS', FName: 'PiecesUnitName' },    // gated (M1: not authorable)
  }
}

const ALL_OPERATOR_LOCAL_VALUES = [
  'MAT-XYZ-001', 'WidgetDisplayName', 'ModelSpecX1',
  'UNITPCS', 'PiecesUnitName', 'CLSIDZ10', 'CategoryStdName',
]

function main() {
  // --- positive: derive a clean sample ---
  const draft = deriveK3MaterialTemplateDraft(rawK3Material())
  assert.deepEqual(draft.payloadTemplate, rawK3Material(), 'payloadTemplate is the RAW sample verbatim (operator-local)')
  const byField = Object.fromEntries(draft.fieldRules.map((r) => [r.targetField, r]))
  // scalars → replace from staging (draft suggests the same column name)
  assert.deepEqual(byField.FNumber, { targetField: 'FNumber', sourceType: 'from_staging', sourceField: 'FNumber', shape: 'scalar', required: false })
  assert.equal(byField.FModel.sourceType, 'from_staging')
  // {FNumber,FName} reference → preserve, object-passthrough, require-fnumber-fname
  assert.deepEqual(byField.FUnitID, { targetField: 'FUnitID', sourceType: 'preserve_template', shape: 'object-passthrough', completeness: 'require-fnumber-fname' })
  // {FID,FName} reference → preserve, require-fid-fname
  assert.equal(byField.FErpClsID.sourceType, 'preserve_template')
  assert.equal(byField.FErpClsID.completeness, 'require-fid-fname')
  // gated field is NOT an authorable rule
  assert.ok(!('FBaseUnitID' in byField), 'gated FBaseUnitID is excluded from authorable rules')
  assert.deepEqual(draft.gatedFields, ['FBaseUnitID'])
  assert.deepEqual([...K3_MATERIAL_GATED_FIELDS], ['FBaseUnitID'])

  // vocabulary pin: every emitted rule stays within the DF-T1 enums (route-local in
  // http-routes.cjs; mirrored in derive). A future edit that emits an out-of-vocab value fails
  // HERE, not silently at the T2c preview wire.
  const DF_T1_SOURCE_TYPES = new Set(['from_staging', 'from_constant', 'preserve_template', 'from_reference_table'])
  const DF_T1_SHAPES = new Set(['scalar', 'object-passthrough', 'by-fnumber', 'by-fid'])
  const DF_T1_COMPLETENESS = new Set(['none', 'require-fnumber-fname', 'require-fid-fname'])
  for (const rule of draft.fieldRules) {
    assert.ok(DF_T1_SOURCE_TYPES.has(rule.sourceType), `sourceType within DF-T1 vocab: ${rule.sourceType}`)
    assert.ok(DF_T1_SHAPES.has(rule.shape), `shape within DF-T1 vocab: ${rule.shape}`)
    if (rule.completeness !== undefined) assert.ok(DF_T1_COMPLETENESS.has(rule.completeness), `completeness within DF-T1 vocab: ${rule.completeness}`)
  }

  // --- P1 class 1: a redaction marker → REJECT (never frozen into a template) ---
  // all shared-scrubber marker forms — bare + suffixed ([redacted-jwt]/[redacted-secret-id]) +
  // angle form + embedded — are caught.
  for (const marker of ['[redacted]', '[redacted-jwt]', '[redacted-secret-id]', '<redacted>', '<redacted-secret>', 'prefix [REDACTED] suffix']) {
    assert.throws(
      () => deriveK3MaterialTemplateDraft({ ...rawK3Material(), FName: marker }),
      (e) => e instanceof TemplateDeriveError && e.details.reason === 'redaction_marker',
      `redaction marker rejected: ${marker}`,
    )
  }
  // an unfilled <…> placeholder is likewise rejected (reuses the composer's scan)
  assert.throws(
    () => deriveK3MaterialTemplateDraft({ ...rawK3Material(), FName: '<material-name>' }),
    (e) => e instanceof TemplateDeriveError && e.details.reason === 'unfilled_placeholder',
    'unfilled placeholder rejected',
  )

  // --- P1 class 2: a secret-shaped value under a benign key → REJECT (never lands in template) ---
  for (const secret of ['postgres://erp:S3cretPass@db/mat', 'Bearer abcdefghijklmnopqrstuvwxyz', 'token=supersecretvalue123']) {
    assert.throws(
      () => deriveTemplateDraft({ FNumber: 'M1', FName: secret }),
      (e) => e instanceof TemplateDeriveError && e.details.reason === 'secret_shaped',
      `secret-shaped value rejected: ${secret}`,
    )
  }

  // nested coverage: a marker/secret one level down inside a reference object (the depth where
  // preserved reference values actually live) is caught too (findOffendingString recurses).
  assert.throws(
    () => deriveK3MaterialTemplateDraft({ ...rawK3Material(), FUnitID: { FNumber: 'U1', FName: '[redacted]' } }),
    (e) => e instanceof TemplateDeriveError && e.details.reason === 'redaction_marker',
    'nested redaction marker (FUnitID.FName) rejected',
  )
  assert.throws(
    () => deriveTemplateDraft({ FNumber: 'M1', FUnitID: { FNumber: 'U1', FName: 'Bearer abcdefghijklmnopqrst' } }),
    (e) => e instanceof TemplateDeriveError && e.details.reason === 'secret_shaped',
    'nested secret-shaped value (FUnitID.FName) rejected',
  )

  // K3 helper FAILS CLOSED on an outer { Data: … } body/response envelope (operator must pass
  // the inner material object, not the Save body / GetDetail envelope) — object & array wrappers.
  for (const envelope of [{ Data: rawK3Material() }, { Data: [rawK3Material()] }, { StatusCode: 200, Data: { FNumber: 'X' } }]) {
    assert.throws(
      () => deriveK3MaterialTemplateDraft(envelope),
      (e) => e instanceof TemplateDeriveError && e.details.reason === 'k3_outer_envelope',
      'K3 outer {Data:…} envelope rejected',
    )
  }
  // ...but the GENERIC helper does not treat `Data` as an envelope (K3-specific guard only).
  assert.doesNotThrow(
    () => deriveTemplateDraft({ Data: { FNumber: 'X', FName: 'Y' } }),
    'generic deriveTemplateDraft does not envelope-reject a Data field',
  )

  // --- P1 class 3: evidence = field names + shape presence ONLY, never the operator-local values ---
  const evidence = summarizeTemplateForEvidence(draft)
  // field names + shapes ARE present
  assert.ok(
    evidence.fields.some((f) => f.field === 'FUnitID' && f.shape === 'object-passthrough' && f.isReference === true && f.hasValue === true),
    'evidence shows FUnitID field name + shape presence',
  )
  assert.ok(evidence.fields.some((f) => f.field === 'FNumber' && f.sourceType === 'from_staging'), 'evidence shows scalar field rule')
  assert.deepEqual(evidence.gatedFields, ['FBaseUnitID'])
  // ...but NO operator-local reference VALUE leaks into the evidence view
  const evidenceJson = JSON.stringify(evidence)
  for (const value of ALL_OPERATOR_LOCAL_VALUES) {
    assert.ok(!evidenceJson.includes(value), `evidence must not contain operator-local value: ${value}`)
  }
  // sanity: those values DO live in the (operator-local) payloadTemplate
  const templateJson = JSON.stringify(draft.payloadTemplate)
  assert.ok(templateJson.includes('PiecesUnitName'), 'payloadTemplate keeps the raw reference values (operator-local)')

  console.log('connector-template-derive.test.cjs OK')
}

main()
