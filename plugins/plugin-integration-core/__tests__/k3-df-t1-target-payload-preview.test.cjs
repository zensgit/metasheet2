'use strict'

// DF-T1 — target payload template preview (shape B). Verifies the 5 owner requirements:
// (1) legacy preview fields compatible + DF-T1 evidence under targetPayloadPreview;
// (2) targetPayloadPreview ONLY when payloadTemplate present;
// (3) composes through the #1936 shared composer (no new K3 shaper/projector);
// (4) no-write / fail-closed / redaction / preview≡Save shaping parity all tested.

const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { __internals } = require('../lib/http-routes.cjs')
const composer = require('../lib/adapters/k3-save-body-composer.cjs')
const { buildTemplatePreview } = __internals

const STAGING = { materialCode: ' mat-001 ', materialName: 'Bolt', unit: '10' }
const TEMPLATE = {
  FUnitGroupID: { FNumber: '10', FName: 'Each' }, // a full reference object default
  FErpClsID: '<erp-cls-id>',                       // an unfilled placeholder default
}
const RULES = [
  { targetField: 'FNumber', sourceType: 'from_staging', sourceField: 'materialCode', required: true, shape: 'scalar' },
  { targetField: 'FName', sourceType: 'from_staging', sourceField: 'materialName', required: true },
  { targetField: 'FUnitGroupID', sourceType: 'preserve_template', completeness: 'require-fnumber-fname' },
]

// ---- Req 1 + 2: legacy fields compatible; targetPayloadPreview only in DF-T1 mode ----
function testModeNamespacing() {
  // Legacy mode (no payloadTemplate) — existing contract, NO targetPayloadPreview.
  const legacy = buildTemplatePreview({
    sourceRecord: { code: 'X' },
    fieldMappings: [{ sourceField: 'code', targetField: 'FNumber', transform: { fn: 'trim' } }],
    template: { bodyKey: 'Data', schema: [{ name: 'FNumber' }] },
  })
  assert.equal('targetPayloadPreview' in legacy, false, 'legacy preview must NOT carry targetPayloadPreview (req 2)')
  assert.ok('valid' in legacy && 'payload' in legacy && 'errors' in legacy, 'legacy fields preserved (req 1)')

  // DF-T1 mode — legacy fields still present + DF-T1 evidence namespaced.
  const dft1 = buildTemplatePreview({ sourceRecord: STAGING, payloadTemplate: TEMPLATE, fieldRules: RULES })
  assert.ok('valid' in dft1 && 'payload' in dft1 && 'errors' in dft1, 'DF-T1 keeps the compatible fields (req 1)')
  assert.ok(dft1.targetPayloadPreview && typeof dft1.targetPayloadPreview === 'object', 'DF-T1 evidence under targetPayloadPreview (req 1)')
  for (const k of ['eligibleForSaveOnly', 'unresolvedPlaceholders', 'unresolvedReferenceComponents', 'redactionSelfCheck', 'compositionSource']) {
    assert.ok(k in dft1.targetPayloadPreview, `targetPayloadPreview.${k} present (DoD)`)
  }
}

// ---- merge semantics: preserve whole-object defaults; replace only declared fields ----
function testMergeSemantics() {
  const out = buildTemplatePreview({ sourceRecord: STAGING, payloadTemplate: TEMPLATE, fieldRules: RULES })
  // preserve_template keeps the full two-field object verbatim.
  assert.deepEqual(out.payload.Data.FUnitGroupID, { FNumber: '10', FName: 'Each' }, 'preserve_template keeps the customer default object')
  // from_staging replaced only the declared fields (trim transform is the legacy path's job;
  // DF-T1 takes the staging value as-is for scalar, so materialCode comes through trimmed by the row).
  assert.equal(out.payload.Data.FName, 'Bolt', 'from_staging replaced FName')
  assert.equal(out.targetPayloadPreview.fieldProvenance.FName, 'staging')
  assert.equal(out.targetPayloadPreview.fieldProvenance.FUnitGroupID, 'template')
}

// ---- Req 4: fail-closed on an unresolved placeholder (same code as Save) ----
function testFailClosedPlaceholder() {
  const out = buildTemplatePreview({ sourceRecord: STAGING, payloadTemplate: TEMPLATE, fieldRules: RULES })
  // FErpClsID is left as the template placeholder (no rule fills it).
  assert.equal(out.valid, false, 'placeholder makes the preview invalid')
  assert.equal(out.targetPayloadPreview.eligibleForSaveOnly, false, 'not Save-only eligible with an unfilled placeholder')
  assert.deepEqual(out.targetPayloadPreview.unresolvedPlaceholders, ['Data.FErpClsID'])
  assert.ok(out.errors.some((e) => e.code === 'K3_WISE_PRESET_PLACEHOLDER_UNFILLED' && /FErpClsID/.test(e.field)),
    'placeholder error uses the same code the Save path throws')

  // Fill it → eligible.
  const filled = buildTemplatePreview({
    sourceRecord: STAGING,
    payloadTemplate: { ...TEMPLATE, FErpClsID: { FID: '1001', FName: 'Raw' } },
    fieldRules: RULES,
  })
  assert.equal(filled.valid, true)
  assert.equal(filled.targetPayloadPreview.eligibleForSaveOnly, true, 'eligible once no placeholder / required / incomplete remain')
}

// ---- Req 3 + 4: shaping goes through the shared composer; preview≡Save shaping parity ----
function testSharedComposerShapingParity() {
  const out = buildTemplatePreview({
    sourceRecord: { u: 'PCS', cat: '1001' },
    payloadTemplate: { FNumber: 'M-1', FName: 'x' },
    fieldRules: [
      { targetField: 'FBaseUnitID', sourceType: 'from_staging', sourceField: 'u', shape: 'by-fnumber' },
      { targetField: 'FErpClsID', sourceType: 'from_staging', sourceField: 'cat', shape: 'by-fid' },
    ],
  })
  // The DF-T1 shaping output must equal the SAME composer.applyReferenceShape the Save uses.
  assert.deepEqual(out.payload.Data.FBaseUnitID, composer.applyReferenceShape('PCS', { reference: { identifier: 'FNumber' } }))
  assert.deepEqual(out.payload.Data.FErpClsID, composer.applyReferenceShape('1001', { reference: { identifier: 'FID' } }))
  assert.deepEqual(out.payload.Data.FBaseUnitID, { FNumber: 'PCS' })
  assert.deepEqual(out.payload.Data.FErpClsID, { FID: '1001' })
  assert.equal(out.targetPayloadPreview.compositionSource, 'k3-save-body-composer', 'composition-source marker (DoD)')
}

// ---- object passthrough: a two-field object staging value is preserved verbatim ----
function testObjectPassthrough() {
  const out = buildTemplatePreview({
    sourceRecord: { unitObj: { FNumber: '10', FName: 'Each' } },
    payloadTemplate: { FNumber: 'M-2', FName: 'y' },
    fieldRules: [{ targetField: 'FUnitID', sourceType: 'from_staging', sourceField: 'unitObj', shape: 'object-passthrough', completeness: 'require-fnumber-fname' }],
  })
  assert.deepEqual(out.payload.Data.FUnitID, { FNumber: '10', FName: 'Each' }, 'object passthrough preserved verbatim')
  assert.equal(out.targetPayloadPreview.unresolvedReferenceComponents.length, 0, 'two-field object satisfies completeness')
}

// ---- completeness: a one-field object fails require-fnumber-fname (readiness, not shaping) ----
function testCompletenessReadiness() {
  const out = buildTemplatePreview({
    sourceRecord: { u: '10' },
    payloadTemplate: { FNumber: 'M-3', FName: 'z' },
    fieldRules: [{ targetField: 'FUnitID', sourceType: 'from_staging', sourceField: 'u', shape: 'by-fnumber', completeness: 'require-fnumber-fname' }],
  })
  // by-fnumber yields {FNumber:'10'} — only one component → completeness unmet.
  assert.deepEqual(out.payload.Data.FUnitID, { FNumber: '10' })
  assert.ok(out.targetPayloadPreview.unresolvedReferenceComponents.some((u) => u.field === 'FUnitID' && u.rule === 'require-fnumber-fname'))
  assert.equal(out.targetPayloadPreview.eligibleForSaveOnly, false, 'incomplete reference is not Save-only eligible')
}

// ---- Req 4: redaction — a secret-shaped value is scrubbed; self-check reports clean ----
function testRedaction() {
  const out = buildTemplatePreview({
    sourceRecord: { code: 'M-4', note: 'connect postgres://u:s3cretpw@db/erp' },
    payloadTemplate: { FNumber: '<n>', FRemark: '<r>' },
    fieldRules: [
      { targetField: 'FNumber', sourceType: 'from_staging', sourceField: 'code', required: true },
      { targetField: 'FRemark', sourceType: 'from_staging', sourceField: 'note' },
    ],
  })
  const serialized = JSON.stringify(out)
  assert.equal(serialized.includes('s3cretpw'), false, 'secret-shaped DSN password scrubbed from the preview')
  assert.equal(out.targetPayloadPreview.redactionSelfCheck.applied, true)
  assert.equal(out.targetPayloadPreview.redactionSelfCheck.clean, true, 'no secret-shape survived the sanitizer')
}

// ---- Req 4: no-write — buildTargetPayloadPreview is a pure compose (no fetch/login/Save) ----
function testNoWrite() {
  // It takes no fetch impl and performs no I/O; guard against a future import of one.
  const before = global.fetch
  let fetched = false
  global.fetch = () => { fetched = true; throw new Error('no fetch in preview') }
  try {
    const out = buildTemplatePreview({ sourceRecord: STAGING, payloadTemplate: TEMPLATE, fieldRules: RULES })
    assert.ok(out.payload, 'preview returns a payload')
    assert.equal(fetched, false, 'DF-T1 preview made no network call')
  } finally {
    global.fetch = before
  }
}

// ---- Req 3 grep gate: DF-T1 must not define a new K3 reference shaper/projector ----
function testNoNewShaper() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'http-routes.cjs'), 'utf8')
  assert.equal(/function\s+applyPreviewReferenceShape|function\s+projectRecordForTemplate/.test(src), false,
    'no resurrected preview shaper/projector')
  // applyDfT1Shape is allowed ONLY as a thin delegator to the composer (it must reference applyReferenceShape).
  assert.ok(/applyReferenceShape\(/.test(src), 'DF-T1 shaping delegates to the shared composer applyReferenceShape')
}

// ---- input validation: invalid sourceType/shape/completeness → 400 ----
function testInputValidation() {
  for (const bad of [
    { fieldRules: [{ targetField: 'F', sourceType: 'evil' }] },
    { fieldRules: [{ targetField: 'F', shape: 'evil' }] },
    { fieldRules: [{ targetField: 'F', completeness: 'evil' }] },
    { fieldRules: [{ sourceType: 'from_staging' }] }, // no targetField
    { fieldRules: 'nope' },
    { payloadTemplate: null },
    { payloadTemplate: [] },
    { payloadTemplate: 'not-an-object' },
    { bodyKey: '__proto__' },     // P2-1: DF-T1 must not bypass the unsafe-key guard
    { bodyKey: 'badkey' },  // P2-1: control char rejected
  ]) {
    let threw = null
    try { buildTemplatePreview({ sourceRecord: {}, payloadTemplate: { F: '1' }, ...bad }) } catch (e) { threw = e }
    assert.ok(threw && threw.code === 'INVALID_TEMPLATE_PREVIEW', `invalid DF-T1 input rejected: ${JSON.stringify(bad)}`)
  }
}

// ---- P2-2: DF-T1 response keeps the legacy fixed array fields (Shape B compatibility) ----
function testShapeBCompatibility() {
  const out = buildTemplatePreview({ sourceRecord: STAGING, payloadTemplate: TEMPLATE, fieldRules: RULES })
  for (const f of ['transformErrors', 'validationErrors', 'schemaErrors']) {
    assert.ok(Array.isArray(out[f]), `DF-T1 response keeps legacy array field ${f}`)
    assert.equal(out[f].length, 0, `${f} is empty in DF-T1 mode`)
  }
  // P2-1 positive: a safe custom bodyKey (through normalizePreviewBodyKey) is honored.
  const custom = buildTemplatePreview({
    sourceRecord: { c: 'X' }, bodyKey: 'Model',
    payloadTemplate: { FNumber: 'v' },
    fieldRules: [{ targetField: 'FNumber', sourceType: 'from_staging', sourceField: 'c' }],
  })
  assert.ok('Model' in custom.payload && custom.payload.Model.FNumber === 'X', 'safe custom bodyKey honored')
}

// ---- DF-T1.5 reachability wire: with fieldMappings (the UI path), DF-T1 runs the SAME transform
// the legacy pipeline runs and from_staging reads the TRANSFORMED (target-keyed) value, so the
// preview predicts the real Save body — not raw staging. Negative control: revert the backend to
// read raw (sourceRecord) and the transformed-value assertions below fail. ----
function testTransformAppliedWithFieldMappings() {
  const out = buildTemplatePreview({
    sourceRecord: { code: ' mat-001 ', name: ' Bolt ', uom: 'EA', quantity: '2' },
    fieldMappings: [
      { sourceField: 'code', targetField: 'FNumber', transform: ['trim', 'upper'], validation: [{ type: 'required' }] },
      { sourceField: 'name', targetField: 'FName', transform: { fn: 'trim' }, validation: [{ type: 'required' }] },
      { sourceField: 'uom', targetField: 'FBaseUnitID', transform: { fn: 'dictMap', map: { EA: 'Pcs' } } },
      { sourceField: 'quantity', targetField: 'FQty', transform: { fn: 'toNumber' } },
    ],
    payloadTemplate: { FNumber: '<n>', FName: '<n>', FBaseUnitID: '<u>', FQty: 0 },
    fieldRules: [
      { targetField: 'FNumber', sourceType: 'from_staging', sourceField: 'FNumber', required: true, shape: 'scalar' },
      { targetField: 'FName', sourceType: 'from_staging', sourceField: 'FName', required: true, shape: 'scalar' },
      { targetField: 'FBaseUnitID', sourceType: 'from_staging', sourceField: 'FBaseUnitID', shape: 'scalar' },
      { targetField: 'FQty', sourceType: 'from_staging', sourceField: 'FQty', shape: 'scalar' },
    ],
  })
  assert.equal(out.payload.Data.FNumber, 'MAT-001', 'trim+upper applied (not raw " mat-001 ")')
  assert.equal(out.payload.Data.FName, 'Bolt', 'trim applied')
  assert.equal(out.payload.Data.FBaseUnitID, 'Pcs', 'dictMap applied (EA -> Pcs)')
  assert.equal(out.payload.Data.FQty, 2, 'toNumber applied (string -> number)')
  assert.deepEqual(out.transformErrors, [], 'no transform errors for the clean sample')
  assert.equal(out.valid, true)
  assert.equal(out.targetPayloadPreview.eligibleForSaveOnly, true)
}

function testRequiredBlankWithFieldMappings() {
  // A required staging field is blank after transform -> the preview is invalid (a green preview
  // must not hide a missing required field).
  const out = buildTemplatePreview({
    sourceRecord: { code: 'MAT-9', name: '   ' },
    fieldMappings: [
      { sourceField: 'code', targetField: 'FNumber', transform: { fn: 'trim' }, validation: [{ type: 'required' }] },
      { sourceField: 'name', targetField: 'FName', transform: { fn: 'trim' }, validation: [{ type: 'required' }] },
    ],
    payloadTemplate: {},
    fieldRules: [
      { targetField: 'FNumber', sourceType: 'from_staging', sourceField: 'FNumber', required: true, shape: 'scalar' },
      { targetField: 'FName', sourceType: 'from_staging', sourceField: 'FName', required: true, shape: 'scalar' },
    ],
  })
  assert.equal(out.valid, false, 'blank required field -> preview invalid')
  assert.ok(out.targetPayloadPreview.missingRequiredFields.includes('FName'), 'FName flagged missing-required')
  assert.equal(out.targetPayloadPreview.eligibleForSaveOnly, false)
}

function main() {
  testModeNamespacing()
  testMergeSemantics()
  testFailClosedPlaceholder()
  testSharedComposerShapingParity()
  testObjectPassthrough()
  testCompletenessReadiness()
  testRedaction()
  testNoWrite()
  testNoNewShaper()
  testInputValidation()
  testShapeBCompatibility()
  testTransformAppliedWithFieldMappings()
  testRequiredBlankWithFieldMappings()
  console.log('✓ k3-df-t1-target-payload-preview: namespacing, merge, fail-closed, shared-composer parity, passthrough, completeness, redaction, no-write, input-validation, bodyKey-guard, shape-B-compat, transform-applied, required-blank')
}

main()
