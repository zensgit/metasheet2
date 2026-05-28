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
  ]) {
    let threw = null
    try { buildTemplatePreview({ sourceRecord: {}, payloadTemplate: { F: '1' }, ...bad }) } catch (e) { threw = e }
    assert.ok(threw && threw.code === 'INVALID_TEMPLATE_PREVIEW', `invalid DF-T1 input rejected: ${JSON.stringify(bad)}`)
  }
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
  console.log('✓ k3-df-t1-target-payload-preview: namespacing, merge, fail-closed, shared-composer parity, passthrough, completeness, redaction, no-write, input-validation')
}

main()
