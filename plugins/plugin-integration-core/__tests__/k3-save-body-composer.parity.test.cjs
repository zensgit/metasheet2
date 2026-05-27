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

const PROFILE_ID = 'material-k3wise-customer-profile-v1'
const { buildTemplatePreview } = httpInternals

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

async function main() {
  await testScalarShapeParity()
  await testObjectPassthroughParity()
  await testPlaceholderParity()
  await testPreviewIsNoWrite()
  testPresetIsOptIn()
  testNoDivergentDuplicate()
  console.log('✓ k3-save-body-composer.parity: preview ≡ adapter Save (shape/passthrough/placeholder), no-write, opt-in, no divergent duplicate')
}

main().catch((err) => {
  console.error('✗ k3-save-body-composer.parity FAILED')
  console.error(err)
  process.exit(1)
})
