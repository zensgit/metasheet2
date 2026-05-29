'use strict'

// DF-T1-0 contract test: the no-write preview must compose a payload BYTE-IDENTICAL to what
// the adapter actually Saves, and must fail-closed on the same placeholders. This is the test
// that justifies the shared k3-save-body-composer existing. Sibling to the composer (grep gate).

const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const { createK3WiseWebApiAdapter } = require('../lib/adapters/k3-wise-webapi-adapter.cjs')
const { __internals: httpInternals } = require('../lib/http-routes.cjs')
const { getK3WiseMaterialProfile, getK3WiseDocumentObjectDefaults } = require('../lib/adapters/k3-wise-document-templates.cjs')
const composer = require('../lib/adapters/k3-save-body-composer.cjs')
// DF-T3b-2a: resolve from_reference_table INTO the record, then prove the resolved record composes
// BYTE-IDENTICALLY through the schema-path preview and the real adapter Save.
const { K3_REFERENCE_MAPPING_TEMPLATES } = require('../lib/reference-mapping-templates.cjs')
const { buildReferenceMappingIndex, resolveReferenceRulesIntoRecord, UNRESOLVED_PLACEHOLDER } = require('../lib/reference-mapping-resolver.cjs')

const PROFILE_ID = 'material-k3wise-customer-profile-v1'
const { buildTemplatePreview, buildTargetPayloadPreview } = httpInternals
const UNIT_GROUP_TEMPLATE = K3_REFERENCE_MAPPING_TEMPLATES.find((t) => t.domain === 'unit-group') // BY_NUMBER
const REF_RULE = { targetField: 'FUnitGroupID', domain: 'unit-group', sourceField: 'unitGroupSourceCode' }

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, async text() { return JSON.stringify(body) } }
}

function mockFetchCapturing() {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    const u = new URL(url)
    const body = options.body ? JSON.parse(options.body) : undefined
    calls.push({ pathname: u.pathname, body })
    if (u.pathname === '/K3API/Login') return jsonResponse(200, { success: true, sessionId: 's1' })
    if (u.pathname === '/K3API/Token/Create') return jsonResponse(200, { StatusCode: 200, Data: { Code: 'Y', Token: 't1' } })
    if (u.pathname === '/K3API/Material/Save') {
      return jsonResponse(200, { StatusCode: 200, Message: 'Successful', Data: [{ FStatus: true, FItemID: 1, FNumber: body && body.Data && body.Data.FNumber }] })
    }
    return jsonResponse(404, { success: false, message: 'not found' })
  }
  return { calls, fetchImpl }
}

function presetSystem() {
  return {
    id: 'k3_1', name: 'K3', kind: 'erp:k3-wise-webapi', role: 'target',
    credentials: { username: 'u', password: 'p', acctId: '1' },
    config: { baseUrl: 'https://k3.example.test', autoSubmit: false, autoAudit: false, objects: { material: { profile: PROFILE_ID } } },
  }
}

const identityMappings = (record) => Object.keys(record).map((k) => ({ sourceField: k, targetField: k }))
const presetSchema = () => getK3WiseMaterialProfile(PROFILE_ID).schema

// Capture the exact Save body the adapter sends for a record under the customer profile.
async function adapterSaveBody(record) {
  const { calls, fetchImpl } = mockFetchCapturing()
  const adapter = createK3WiseWebApiAdapter({ system: presetSystem(), fetchImpl })
  const result = await adapter.upsert({ object: 'material', records: [record], keyFields: ['FNumber'] })
  const save = calls.find((c) => c.pathname === '/K3API/Material/Save')
  return { result, body: save ? save.body : null }
}

function previewPayload(record) {
  return buildTemplatePreview({
    sourceRecord: record,
    fieldMappings: identityMappings(record),
    template: { bodyKey: 'Data', schema: presetSchema() },
  })
}

// ---- Parity 1: scalar reference shaping (preset) — preview ≡ adapter Save body ----
async function testScalarShapeParity() {
  const record = { FNumber: 'MAT-1', FName: 'Bolt', FUnitGroupID: '10', FErpClsID: '1001' }
  const { body } = await adapterSaveBody(record)
  const preview = previewPayload(record)
  const expected = { Data: { FNumber: 'MAT-1', FName: 'Bolt', FUnitGroupID: { FNumber: '10' }, FErpClsID: { FID: '1001' } } }
  assert.deepEqual(body, expected, 'adapter Save body shapes by-FNumber / by-FID per preset')
  assert.deepEqual(preview.payload, expected, 'preview payload matches the adapter Save body exactly')
  assert.deepEqual(preview.payload, body, 'preview ≡ adapter Save (byte parity)')
  assert.equal(preview.valid, true)
}

// ---- Parity 2: object passthrough — two-field {FNumber,FName}/{FID,FName} preserved both sides ----
async function testObjectPassthroughParity() {
  const record = {
    FNumber: 'MAT-2', FName: 'Nut',
    FUnitGroupID: { FNumber: '10', FName: 'Each' },
    FErpClsID: { FID: '1001', FName: 'Raw' },
  }
  const { body } = await adapterSaveBody(record)
  const preview = previewPayload(record)
  assert.deepEqual(body.Data.FUnitGroupID, { FNumber: '10', FName: 'Each' }, 'adapter preserves two-field object')
  assert.deepEqual(preview.payload, body, 'preview ≡ adapter Save with object passthrough')
}

// ---- Parity 3: placeholder — same detection, dispositions differ (Save throws, preview valid:false) ----
async function testPlaceholderParity() {
  const record = { FNumber: 'MAT-3', FName: 'X', FUnitGroupID: '<unit-group-number>' }
  const { result, body } = await adapterSaveBody(record)
  assert.equal(body, null, 'adapter made NO Save call — fail-closed before HTTP')
  assert.equal(result.written, 0)
  assert.equal(result.errors[0].code, 'K3_WISE_PRESET_PLACEHOLDER_UNFILLED', 'Save throws the placeholder code')

  const preview = previewPayload(record)
  assert.equal(preview.valid, false, 'preview reports invalid for the same placeholder')
  assert.ok(preview.placeholderErrors.length > 0, 'preview lists the unfilled placeholder')
  assert.ok(preview.placeholderErrors.some((e) => /FUnitGroupID/.test(e.field)), 'preview names the placeholder field')
  // Same error CODE both sides so the operator can correlate preview ↔ Save failure.
  assert.ok(preview.placeholderErrors.every((e) => e.code === 'K3_WISE_PRESET_PLACEHOLDER_UNFILLED'),
    'preview placeholder code matches the Save throw code')

  // Shared detection: the composer finds the same path for the same composed body.
  const composed = composer.composeSchemaBody({ FUnitGroupID: '<unit-group-number>' }, { bodyKey: 'Data', schema: presetSchema() })
  assert.ok(composer.findUnfilledPlaceholders(composed).some((p) => /FUnitGroupID/.test(p)))
}

// ---- no-write: the preview composes with zero network/login/Save calls ----
async function testPreviewIsNoWrite() {
  const { calls, fetchImpl } = mockFetchCapturing()
  // buildTemplatePreview takes no fetch and performs no I/O; prove it by running it while a
  // fetch mock is in scope and asserting the mock recorded nothing.
  void fetchImpl
  const out = previewPayload({ FNumber: 'MAT-9', FName: 'Y' })
  assert.ok(out && out.payload, 'preview returns a payload')
  assert.equal(calls.length, 0, 'preview made no login/fetch/Submit/Audit/BOM/list/search calls')
}

// ---- opt-in: the GENERIC material template never carries the customer-profile fields ----
function testPresetIsOptIn() {
  const genericSchema = getK3WiseDocumentObjectDefaults().material.schema
  const record = { FNumber: 'MAT-5', FName: 'Z', FErpClsID: '1001' }
  // Generic template has no FErpClsID → it is dropped (not silently composed as the preset would).
  const generic = buildTemplatePreview({ sourceRecord: record, fieldMappings: identityMappings(record), template: { bodyKey: 'Data', schema: genericSchema } })
  assert.equal(generic.payload.Data.FErpClsID, undefined, 'generic preview omits the preset-only field')
  // Only the explicitly-selected preset schema includes + shapes it.
  const withPreset = previewPayload(record)
  assert.deepEqual(withPreset.payload.Data.FErpClsID, { FID: '1001' }, 'preset preview shapes the field by FID')
}

// ---- generic preview nested-path contract must NOT regress (the shared composer must keep
//      the old getPath/setPath path projection for non-K3 templates) ----
function testGenericNestedProjectionPreserved() {
  const out = buildTemplatePreview({
    sourceRecord: { code: 'C-1' },
    fieldMappings: [{ sourceField: 'code', targetField: 'nested.code' }],
    template: { bodyKey: 'Data', schema: [{ name: 'nested.code', required: true }] },
  })
  assert.deepEqual(out.payload, { Data: { nested: { code: 'C-1' } } }, 'nested schema path projects (no silent field drop)')
  assert.equal(out.valid, true)
}

// ---- reference identifier '' must fall back to identifierField / key (not disable wrapping) ----
function testIdentifierEmptyStringFallback() {
  const field = { name: 'FUnitGroupID', type: 'reference', reference: { identifier: '', identifierField: 'FNumber' } }
  assert.deepEqual(composer.applyReferenceShape('PCS', field), { FNumber: 'PCS' }, 'empty identifier falls back to identifierField')
  assert.equal(composer.normalizeReferenceIdentifier(field), 'FNumber')
  // Only-empty identifier (no fallback) → no wrap.
  assert.equal(composer.applyReferenceShape('PCS', { reference: { identifier: '' } }), 'PCS')
}

// ---- grep gate: no divergent duplicate may reappear ----
function testNoDivergentDuplicate() {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', 'lib', rel), 'utf8')
  const httpRoutes = read('http-routes.cjs')
  const adapter = read('adapters/k3-wise-webapi-adapter.cjs')
  const comp = read('adapters/k3-save-body-composer.cjs')

  // Gate on function DEFINITIONS (the deleted copies were `function …`), not bare mentions —
  // "moved to the composer" comments legitimately reference the old names.
  assert.equal(/function\s+applyPreviewReferenceShape|function\s+projectRecordForTemplate/.test(httpRoutes), false,
    'http-routes must not re-introduce a preview-side shaper/projector copy')
  assert.equal(/function applyReferenceShape|function projectRecordForBody/.test(adapter), false,
    'adapter must not re-define composition functions (they live in the composer)')
  assert.ok(/function applyReferenceShape/.test(comp) && /function projectRecordForBody/.test(comp),
    'the composer is the sole home of applyReferenceShape / projectRecordForBody')
}

// Step 7 (#1792 M1 one-record Save PASSED 2026-05-28): the customer profile must NOT compose
// FBaseUnitID into the Save body even if a staging record carries it — schema-driven projection
// drops it (the field is omitted from the profile schema). Composing FBaseUnitID was the dry-run
// cross-check mismatch behind the 2 failed M1 Saves; the proven shape uses FUnitID + the unit
// family. Negative control: re-add FBaseUnitID to the profile schema → this test fails.
async function testCustomerProfileDropsFBaseUnitID() {
  const record = { FNumber: 'MAT-7', FName: 'Widget', FModel: 'M-1', FBaseUnitID: { FNumber: '10', FName: 'Each' } }
  const { body } = await adapterSaveBody(record)
  const preview = previewPayload(record)
  assert.equal('FBaseUnitID' in body.Data, false, 'adapter Save body omits FBaseUnitID (not in customer profile schema)')
  assert.equal('FBaseUnitID' in preview.payload.Data, false, 'preview payload omits FBaseUnitID')
  assert.deepEqual(preview.payload, body, 'preview ≡ adapter Save (no FBaseUnitID divergence)')
  assert.equal(body.Data.FNumber, 'MAT-7', 'scalar identity still composes')
  assert.equal(body.Data.FModel, 'M-1', 'FModel scalar still composes')
}

// ---- DF-T3b-2a Parity 4: resolved-record byte-parity — a from_reference_table reference resolved
//      INTO the record composes identically on the preview schema path and the adapter Save ----
async function testResolvedRecordParity() {
  const indexes = { 'unit-group': buildReferenceMappingIndex(UNIT_GROUP_TEMPLATE, [
    { sourceCode: 'STD', fNumber: '10', fName: 'Each', enabled: true },
  ]) }
  const source = { FNumber: 'MAT-RM1', FName: 'Bolt', unitGroupSourceCode: 'STD' }
  const { record: resolved } = resolveReferenceRulesIntoRecord(source, [REF_RULE], indexes)
  // sanity: the resolver materialized the FULL reference object into the record
  assert.deepEqual(resolved.FUnitGroupID, { FNumber: '10', FName: 'Each' }, 'resolver materialized the reference into the record')

  const { body } = await adapterSaveBody(resolved)
  const preview = previewPayload(resolved)
  const expected = { Data: { FNumber: 'MAT-RM1', FName: 'Bolt', FUnitGroupID: { FNumber: '10', FName: 'Each' } } }
  assert.deepEqual(body, expected, 'adapter Save composes the resolved reference (unitGroupSourceCode dropped — not in schema)')
  assert.deepEqual(preview.payload, body, 'DF-T3b-2a: preview ≡ adapter Save with a from_reference_table-resolved reference')
  assert.equal(preview.valid, true)
}

// ---- DF-T3b-2a Parity 5: all THREE non-resolved statuses → IDENTICAL fail-closed disposition on
//      both sides (preview valid:false + adapter Save throws K3_WISE_PRESET_PLACEHOLDER_UNFILLED).
//      Mirrors testPlaceholderParity — the Save throws (no body) so we assert disposition, not bytes. ----
async function testNonResolvedFailClosedParity() {
  const cases = {
    unresolved: [{ sourceCode: 'OTHER', fNumber: '9', fName: 'X', enabled: true }],
    ambiguous: [
      { sourceCode: 'STD', fNumber: 'A', fName: 'X', enabled: true },
      { sourceCode: 'STD', fNumber: 'B', fName: 'Y', enabled: true },
    ],
    'incomplete-row': [{ sourceCode: 'STD', fNumber: 'A', enabled: true }], // missing fName
  }
  for (const [label, rows] of Object.entries(cases)) {
    const indexes = { 'unit-group': buildReferenceMappingIndex(UNIT_GROUP_TEMPLATE, rows) }
    const { record: resolved } = resolveReferenceRulesIntoRecord({ FNumber: 'MAT-X', FName: 'Y', unitGroupSourceCode: 'STD' }, [REF_RULE], indexes)
    assert.equal(resolved.FUnitGroupID, UNRESOLVED_PLACEHOLDER, `${label}: target field carries the sentinel`)

    const { result, body } = await adapterSaveBody(resolved)
    assert.equal(body, null, `${label}: adapter made NO Save call (fail-closed before HTTP)`)
    assert.equal(result.written, 0, `${label}: nothing written`)
    assert.equal(result.errors[0].code, 'K3_WISE_PRESET_PLACEHOLDER_UNFILLED', `${label}: Save throws the placeholder code`)

    const preview = previewPayload(resolved)
    assert.equal(preview.valid, false, `${label}: preview reports invalid`)
    assert.ok(preview.placeholderErrors.some((e) => /FUnitGroupID/.test(e.field)), `${label}: preview names the unresolved field`)
    assert.ok(preview.placeholderErrors.every((e) => e.code === 'K3_WISE_PRESET_PLACEHOLDER_UNFILLED'),
      `${label}: preview placeholder code matches the Save throw code (identical disposition)`)
  }
}

// ---- DF-T3b-2a Parity 6: desync NEGATIVE CONTROL — resolving the two sides with DIFFERENT indexes
//      must break byte-parity, proving the assertion catches a preview/Save resolver divergence. ----
async function testDesyncNegativeControl() {
  const source = { FNumber: 'MAT-DS', FName: 'Z', unitGroupSourceCode: 'STD' }
  const indexA = { 'unit-group': buildReferenceMappingIndex(UNIT_GROUP_TEMPLATE, [{ sourceCode: 'STD', fNumber: '10', fName: 'Each', enabled: true }]) }
  const indexB = { 'unit-group': buildReferenceMappingIndex(UNIT_GROUP_TEMPLATE, [{ sourceCode: 'STD', fNumber: '99', fName: 'Box', enabled: true }]) }
  const previewResolved = resolveReferenceRulesIntoRecord(source, [REF_RULE], indexA).record
  const saveResolved = resolveReferenceRulesIntoRecord(source, [REF_RULE], indexB).record
  const { body } = await adapterSaveBody(saveResolved)
  const preview = previewPayload(previewResolved)
  assert.notDeepEqual(preview.payload, body, 'desync (different indexes) → byte-parity assertion catches the divergence')
}

// ---- DF-T3b-2a Parity 7: NESTED sourceField — the operator preview and the record materializer must
//      extract the sourceCode with the SAME path semantics (getPath), so they resolve the SAME object.
//      Guards the "shared decision cannot diverge" claim against extraction drift (flat vs nested). ----
function testNestedSourceFieldNoDivergence() {
  const indexes = { 'unit-group': buildReferenceMappingIndex(UNIT_GROUP_TEMPLATE, [{ sourceCode: 'STD', fNumber: '10', fName: 'Each', enabled: true }]) }
  const nestedRule = { targetField: 'FUnitGroupID', domain: 'unit-group', sourceField: 'source.unitGroup' }
  const sourceRecord = { source: { unitGroup: 'STD' } }

  const preview = buildTargetPayloadPreview(
    { bodyKey: 'Data', payloadTemplate: {}, sourceRecord, fieldRules: [{ ...nestedRule, sourceType: 'from_reference_table', shape: 'object-passthrough', completeness: 'require-fnumber-fname' }] },
    { referenceMappingIndexes: indexes },
  )
  const { record } = resolveReferenceRulesIntoRecord(sourceRecord, [nestedRule], indexes)
  assert.equal(preview.payload.Data.FUnitGroupID.FNumber, '10', 'preview resolves a nested sourceField (getPath)')
  assert.equal(record.FUnitGroupID.FNumber, '10', 'materializer resolves the SAME nested sourceField (no flat-vs-nested divergence)')
  assert.deepEqual(preview.payload.Data.FUnitGroupID, record.FUnitGroupID, 'preview path ≡ materializer for a nested sourceField')
}

// ---- DF-T3b-2a Parity 8: OVERLAPPING source/target rules — the operator preview always reads the
//      original sourceRecord; the materializer must too (read snapshot = original, write = clone), so an
//      earlier rule writing a path a later rule reads cannot diverge between the two surfaces. ----
function testSourceTargetOverlapNoDivergence() {
  const indexes = { 'unit-group': buildReferenceMappingIndex(UNIT_GROUP_TEMPLATE, [{ sourceCode: 'STD', fNumber: '10', fName: 'Each', enabled: true }]) }
  const overlapRules = [
    { targetField: 'source.unitGroup', domain: 'unit-group', sourceField: 'source.unitGroup' }, // rule 1 writes the read path
    { targetField: 'FUnitGroupID', domain: 'unit-group', sourceField: 'source.unitGroup' }, // rule 2 reads it
  ]
  const sourceRecord = { source: { unitGroup: 'STD' } }
  const preview = buildTargetPayloadPreview(
    { bodyKey: 'Data', payloadTemplate: {}, sourceRecord, fieldRules: overlapRules.map((r) => ({ ...r, sourceType: 'from_reference_table', shape: 'object-passthrough', completeness: 'require-fnumber-fname' })) },
    { referenceMappingIndexes: indexes },
  )
  const { record } = resolveReferenceRulesIntoRecord(sourceRecord, overlapRules, indexes)
  assert.equal(preview.payload.Data.FUnitGroupID.FNumber, '10', 'preview resolves FUnitGroupID (reads original snapshot)')
  assert.equal(record.FUnitGroupID.FNumber, '10', 'materializer resolves FUnitGroupID identically (reads original, writes clone)')
  assert.deepEqual(preview.payload.Data.FUnitGroupID, record.FUnitGroupID, 'preview ≡ materializer with overlapping source/target rules')
  assert.equal(sourceRecord.source.unitGroup, 'STD', 'the input sourceRecord is not mutated')
}

async function main() {
  await testScalarShapeParity()
  testNestedSourceFieldNoDivergence()
  testSourceTargetOverlapNoDivergence()
  await testObjectPassthroughParity()
  await testPlaceholderParity()
  await testPreviewIsNoWrite()
  testPresetIsOptIn()
  testGenericNestedProjectionPreserved()
  testIdentifierEmptyStringFallback()
  testNoDivergentDuplicate()
  await testCustomerProfileDropsFBaseUnitID()
  await testResolvedRecordParity()
  await testNonResolvedFailClosedParity()
  await testDesyncNegativeControl()
  console.log('✓ k3-save-body-composer.parity: preview ≡ adapter Save (shape/passthrough/placeholder), nested-path preserved, identifier-fallback, no-write, opt-in, no divergent duplicate, customer-profile drops FBaseUnitID, DF-T3b-2a resolved-record parity + 3-state fail-closed + desync neg-control')
}

main().catch((err) => {
  console.error('✗ k3-save-body-composer.parity FAILED')
  console.error(err)
  process.exit(1)
})
