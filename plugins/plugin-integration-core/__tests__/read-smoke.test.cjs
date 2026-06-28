'use strict'

// #1709 follow-up: read-smoke preset catalog + values-free evidence helpers (unit). The route-level tests
// (fail-closed paths, backend credential context, no-write) live in http-routes.test.cjs (testReadSmokeRoute).

const assert = require('node:assert/strict')
const path = require('node:path')

const {
  READ_SMOKE_PRESETS,
  getReadSmokePreset,
  buildReadSmokeRequest,
  applyReadSmokePresetOverlay,
  readSmokeSuccessEvidence,
  readSmokeErrorEvidence,
} = require(path.join(__dirname, '..', 'lib', 'read-smoke.cjs'))

const PRESET = getReadSmokePreset('k3wise.material-detail.v1')

// --- catalog (built-in only) ---
assert.ok(PRESET, 'k3wise.material-detail.v1 is registered')
assert.equal(PRESET.requiredKind, 'erp:k3-wise-webapi')
assert.equal(PRESET.object, 'material')
assert.deepEqual(PRESET.readConfigOverlay, {
  objects: {
    material: {
      operations: ['read'],
      readPath: '/K3API/Material/GetDetail',
      readMethod: 'POST',
    },
  },
})
// unknown / empty / non-string / prototype keys → undefined (route fail-closes)
assert.equal(getReadSmokePreset('evil.custom.v1'), undefined)
assert.equal(getReadSmokePreset(''), undefined)
assert.equal(getReadSmokePreset(undefined), undefined)
assert.equal(getReadSmokePreset('toString'), undefined, 'prototype key never resolves to a preset')
assert.equal(getReadSmokePreset('__proto__'), undefined)
// catalog frozen — no user/runtime mutation
assert.throws(() => { READ_SMOKE_PRESETS['x.v1'] = { requiredKind: 'http' } }, TypeError, 'catalog is frozen')

// --- detail read request builder: consumes the normalized contract.object/mode (#3247); FNumber filter only ---
const reqObj = buildReadSmokeRequest(PRESET, { presetId: PRESET.presetId, object: 'material', mode: 'single_record_detail', key: 'M-001' })
assert.deepEqual(reqObj, { object: 'material', filters: { FNumber: 'M-001' } })
assert.equal(reqObj.cursor, undefined)
assert.equal(reqObj.limit, undefined)
assert.equal(reqObj.watermark, undefined)
assert.equal(reqObj.pagination, undefined)

// --- C3 LIST builder: dispatches on contract.mode='list'; signals list mode + optional FNumber filter only ---
const LIST_PRESET = getReadSmokePreset('k3wise.material-list.v1')
assert.ok(LIST_PRESET, 'list preset is registered')
assert.deepEqual(LIST_PRESET.allowedModes, ['list'])
assert.equal(LIST_PRESET.keyOptional, true)
assert.equal(LIST_PRESET.readConfigOverlay.objects.material.readPath, '/K3API/Material/GetList')
assert.equal(LIST_PRESET.readConfigOverlay.objects.material.readMode, 'list')
// list with an explicit key → exact FNumber filter signal; pagination/path NOT in the request (preset-owned)
const listReqKeyed = buildReadSmokeRequest(LIST_PRESET, { presetId: LIST_PRESET.presetId, object: 'material', mode: 'list', key: 'M-001' })
assert.deepEqual(listReqKeyed, { object: 'material', filters: { FNumber: 'M-001' }, options: { readMode: 'list' } })
assert.equal(listReqKeyed.cursor, undefined)
assert.equal(listReqKeyed.limit, undefined)
assert.equal(listReqKeyed.pagination, undefined)
// list with no key → first page, no filter
const listReqNoKey = buildReadSmokeRequest(LIST_PRESET, { presetId: LIST_PRESET.presetId, object: 'material', mode: 'list', key: null })
assert.deepEqual(listReqNoKey, { object: 'material', filters: {}, options: { readMode: 'list' } })

// --- non-persisted read config overlay: target-side Save config is preserved, read config is in-memory only ---
const storedSystem = {
  id: 'sys_1',
  kind: 'erp:k3-wise-webapi',
  role: 'target',
  credentials: { bearerToken: 'secret-token' },
  config: {
    objects: {
      material: {
        operations: ['upsert'],
        savePath: '/K3API/Material/Save',
      },
      salesOrder: {
        operations: ['upsert'],
        savePath: '/K3API/SalesOrder/Save',
      },
    },
  },
}
const storedBefore = JSON.parse(JSON.stringify(storedSystem))
const overlayedSystem = applyReadSmokePresetOverlay(storedSystem, PRESET)
assert.notEqual(overlayedSystem, storedSystem, 'overlay returns an in-memory clone')
assert.deepEqual(storedSystem, storedBefore, 'stored system is not mutated')
assert.deepEqual(overlayedSystem.config.objects.material, {
  operations: ['upsert', 'read'],
  savePath: '/K3API/Material/Save',
  readPath: '/K3API/Material/GetDetail',
  readMethod: 'POST',
})
assert.deepEqual(overlayedSystem.config.objects.salesOrder, storedSystem.config.objects.salesOrder, 'unrelated objects are preserved')
assert.equal(applyReadSmokePresetOverlay(null, PRESET), null)

// --- success evidence: recordPresent + referenceObjectCount; values-free ---
const okResult = {
  records: [{ _k3ReferenceObjects: { unit: {}, category: {} }, FName: 'SECRET-NAME', FNumber: 'M-001' }],
  raw: { secretPayload: 1 },
  metadata: { requestedNumber: 'M-001', readPath: 'https://k3host/K3API/Material/GetDetail' },
}
const ev = readSmokeSuccessEvidence(PRESET, okResult)
assert.deepEqual(ev, {
  ok: true, presetId: 'k3wise.material-detail.v1', object: 'material', recordPresent: true, referenceObjectCount: 2, recordCount: 1,
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
  ok: true, presetId: 'k3wise.material-detail.v1', object: 'material', recordPresent: false, referenceObjectCount: 0, recordCount: 0,
})
assert.deepEqual(readSmokeSuccessEvidence(PRESET, {}), {
  ok: true, presetId: 'k3wise.material-detail.v1', object: 'material', recordPresent: false, referenceObjectCount: 0, recordCount: 0,
})

// --- C3 LIST evidence: values-free counts/flags only; row VALUES (FNumber/FName/FModel/FUnitID) never surface ---
const listResult = {
  records: [
    { FNumber: 'M-LIST-1', FName: 'SECRET-LIST-NAME', FModel: 'SECRET-MODEL', FUnitID: 'SECRET-UNIT' },
    { FNumber: 'M-LIST-2', FName: 'SECRET-LIST-NAME-2', FModel: 'SECRET-MODEL-2', FUnitID: 'SECRET-UNIT-2' },
  ],
  metadata: { mode: 'material-list-bounded-smoke', pageBounded: true },
}
const listEv = readSmokeSuccessEvidence(LIST_PRESET, listResult)
assert.deepEqual(listEv, {
  ok: true, presetId: 'k3wise.material-list.v1', object: 'material', recordPresent: true, referenceObjectCount: 0, recordCount: 2, mode: 'list', pageBounded: true,
})
const listEvStr = JSON.stringify(listEv)
for (const leak of ['M-LIST-1', 'SECRET-LIST-NAME', 'SECRET-MODEL', 'SECRET-UNIT', 'FName', 'FModel', 'FUnitID']) {
  assert.ok(!listEvStr.includes(leak), `list evidence must not leak ${leak}`)
}

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
