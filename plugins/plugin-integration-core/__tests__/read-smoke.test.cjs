'use strict'

// #1709 follow-up: read-smoke preset catalog + values-free evidence helpers (unit). The route-level tests
// (fail-closed paths, backend credential context, no-write) live in http-routes.test.cjs (testReadSmokeRoute).

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  READ_SMOKE_PRESETS,
  getReadSmokePreset,
  buildReadSmokeRequest,
  readSmokeSuccessEvidence,
  readSmokeErrorEvidence,
} = require(path.join(__dirname, '..', 'lib', 'read-smoke.cjs'))

const PRESET = getReadSmokePreset('k3wise.material-detail.v1')

// --- catalog (built-in only) ---
assert.ok(PRESET, 'k3wise.material-detail.v1 is registered')
assert.equal(PRESET.requiredKind, 'erp:k3-wise-webapi')
assert.equal(PRESET.object, 'material')
// unknown / empty / non-string / prototype keys → undefined (route fail-closes)
assert.equal(getReadSmokePreset('evil.custom.v1'), undefined)
assert.equal(getReadSmokePreset(''), undefined)
assert.equal(getReadSmokePreset(undefined), undefined)
assert.equal(getReadSmokePreset('toString'), undefined, 'prototype key never resolves to a preset')
assert.equal(getReadSmokePreset('__proto__'), undefined)
// catalog frozen — no user/runtime mutation
assert.throws(() => { READ_SMOKE_PRESETS['x.v1'] = { requiredKind: 'http' } }, TypeError, 'catalog is frozen')

// --- forced single-record read request: FNumber filter only, no list/pagination/cursor/watermark/BOM ---
const reqObj = buildReadSmokeRequest(PRESET, 'M-001')
assert.deepEqual(reqObj, { object: 'material', filters: { FNumber: 'M-001' } })
assert.equal(reqObj.cursor, undefined)
assert.equal(reqObj.limit, undefined)
assert.equal(reqObj.watermark, undefined)
assert.equal(reqObj.pagination, undefined)

// --- success evidence: recordPresent + referenceObjectCount; values-free ---
const okResult = {
  records: [{ _k3ReferenceObjects: { unit: {}, category: {} }, FName: 'SECRET-NAME', FNumber: 'M-001' }],
  raw: { secretPayload: 1 },
  metadata: { requestedNumber: 'M-001', readPath: 'https://k3host/K3API/Material/GetDetail' },
}
const ev = readSmokeSuccessEvidence(PRESET, okResult)
assert.deepEqual(ev, {
  ok: true, presetId: 'k3wise.material-detail.v1', object: 'material', recordPresent: true, referenceObjectCount: 2,
})
// nothing sensitive leaks (key / material values / raw / metadata / host)
const evStr = JSON.stringify(ev)
for (const leak of ['M-001', 'SECRET-NAME', 'k3host', 'readPath', 'requestedNumber', 'secretPayload']) {
  assert.ok(!evStr.includes(leak), `success evidence must not leak ${leak}`)
}
assert.equal(ev.records, undefined)
assert.equal(ev.raw, undefined)
assert.equal(ev.metadata, undefined)
// empty / missing records → recordPresent false, count 0
assert.deepEqual(readSmokeSuccessEvidence(PRESET, { records: [] }), {
  ok: true, presetId: 'k3wise.material-detail.v1', object: 'material', recordPresent: false, referenceObjectCount: 0,
})
assert.deepEqual(readSmokeSuccessEvidence(PRESET, {}), {
  ok: true, presetId: 'k3wise.material-detail.v1', object: 'material', recordPresent: false, referenceObjectCount: 0,
})

// --- error evidence: coarse code + type ONLY (never the message, which may carry the key/values) ---
class FakeAdapterError extends Error {
  constructor() { super('material M-001 failed with secret value 42'); this.name = 'K3WiseWebApiAdapterError'; this.code = 'K3_WISE_READ_BUSINESS_ERROR' }
}
const errEv = readSmokeErrorEvidence(PRESET, new FakeAdapterError())
assert.deepEqual(errEv, {
  ok: false, presetId: 'k3wise.material-detail.v1', object: 'material',
  errorCode: 'K3_WISE_READ_BUSINESS_ERROR', errorType: 'K3WiseWebApiAdapterError',
})
const errStr = JSON.stringify(errEv)
for (const leak of ['M-001', '42', 'failed with secret']) {
  assert.ok(!errStr.includes(leak), `error evidence must not leak ${leak}`)
}
// error without code/name → safe defaults
const bare = readSmokeErrorEvidence(PRESET, {})
assert.equal(bare.errorCode, 'READ_SMOKE_READ_FAILED')
assert.equal(bare.errorType, 'Error')

console.log('read-smoke.test.cjs OK')
