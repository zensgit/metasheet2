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
const { READ_SMOKE_LIST_REQUEST_MARKER } = require(path.join(__dirname, '..', 'lib', 'read-smoke-marker.cjs'))

const PRESET = getReadSmokePreset('k3wise.material-detail.v1')
const LIST_PRESET = getReadSmokePreset('k3wise.material-list.v1')
const BOM_PRESET = getReadSmokePreset('k3wise.material-bom.v1')

// --- catalog (built-in only) ---
assert.ok(PRESET, 'k3wise.material-detail.v1 is registered')
assert.ok(LIST_PRESET, 'k3wise.material-list.v1 is registered')
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
assert.deepEqual(LIST_PRESET.readConfigOverlay, {
  objects: {
    material: {
      operations: ['read'],
      readPath: '/K3API/Material/GetList',
      readMethod: 'POST',
      readMode: 'list',
      readListBodyTemplate: { Data: { Top: 10, PageIndex: 1 } },
      readListBodyKey: 'Data',
      readListFields: ['FNumber', 'FName', 'FModel', 'FUnitID'],
      readListOrderBy: 'FNumber',
      readListFilterField: 'FNumber',
      readListFilterMode: 'contains_like',
      readListFilterEscape: 'k3_freeform',
      topField: 'Top',
      pageIndexField: 'PageIndex',
      pageSizeField: 'PageSize',
      maxListLimit: 10,
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

// --- forced single-record read request: FNumber filter only, no list/pagination/cursor/watermark/BOM ---
const reqObj = buildReadSmokeRequest(PRESET, { object: 'material', mode: 'single_record_detail', key: 'M-001' })
assert.deepEqual(reqObj, { object: 'material', filters: { FNumber: 'M-001' } })
assert.equal(reqObj.cursor, undefined)
assert.equal(reqObj.limit, undefined)
assert.equal(reqObj.watermark, undefined)
assert.equal(reqObj.pagination, undefined)

// --- C3 LIST request: bounded by preset, no request-supplied filters/cursor/watermark/BOM ---
const listReq = buildReadSmokeRequest(LIST_PRESET, { object: 'material', mode: 'list' })
assert.equal(listReq.object, 'material')
assert.equal(listReq.limit, 10)
assert.equal(listReq.options.k3ReadMode, 'list')
assert.equal(listReq.options[READ_SMOKE_LIST_REQUEST_MARKER], true, 'LIST request carries the internal route-only marker')
assert.equal(listReq.filters, undefined)
assert.equal(listReq.cursor, undefined)
assert.equal(listReq.watermark, undefined)
const keyedListReq = buildReadSmokeRequest(LIST_PRESET, { object: 'material', mode: 'list', key: 'MAT-' })
assert.equal(keyedListReq.object, 'material')
assert.equal(keyedListReq.limit, 10)
assert.equal(keyedListReq.options.k3ReadMode, 'list')
assert.equal(keyedListReq.options.listKey, 'MAT-')
assert.equal(keyedListReq.options[READ_SMOKE_LIST_REQUEST_MARKER], true, 'keyed LIST request also carries the internal route-only marker')

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

const listOverlayedSystem = applyReadSmokePresetOverlay(storedSystem, LIST_PRESET)
assert.deepEqual(listOverlayedSystem.config.objects.material, {
  operations: ['upsert', 'read'],
  savePath: '/K3API/Material/Save',
  readPath: '/K3API/Material/GetList',
  readMethod: 'POST',
  readMode: 'list',
  readListBodyTemplate: { Data: { Top: 10, PageIndex: 1 } },
  readListBodyKey: 'Data',
  readListFields: ['FNumber', 'FName', 'FModel', 'FUnitID'],
  readListOrderBy: 'FNumber',
  readListFilterField: 'FNumber',
  readListFilterMode: 'contains_like',
  readListFilterEscape: 'k3_freeform',
  topField: 'Top',
  pageIndexField: 'PageIndex',
  pageSizeField: 'PageSize',
  maxListLimit: 10,
}, 'LIST preset applies a non-persisted bounded Material/GetList overlay')
const listOverlayedWeirdSystem = applyReadSmokePresetOverlay({
  ...storedSystem,
  config: {
    objects: {
      material: {
        operations: ['upsert'],
        savePath: '/K3API/Material/Save',
        readListBodyKey: 'Payload',
      },
    },
  },
}, LIST_PRESET)
assert.equal(listOverlayedWeirdSystem.config.objects.material.readListBodyKey, 'Data', 'LIST preset pins the approved Data.* body container')

// --- success evidence: recordPresent + referenceObjectCount; values-free ---
const okResult = {
  records: [{ _k3ReferenceObjects: { unit: {}, category: {} }, FName: 'SECRET-NAME', FNumber: 'M-001' }],
  raw: { secretPayload: 1 },
  metadata: { requestedNumber: 'M-001', readPath: 'https://k3host/K3API/Material/GetDetail' },
}
const ev = readSmokeSuccessEvidence(PRESET, okResult, { object: 'material', mode: 'single_record_detail' })
assert.deepEqual(ev, {
  ok: true, presetId: 'k3wise.material-detail.v1', object: 'material', mode: 'single_record_detail', recordPresent: true, recordCount: 1, referenceObjectCount: 2,
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
assert.deepEqual(readSmokeSuccessEvidence(PRESET, { records: [] }, { object: 'material', mode: 'single_record_detail' }), {
  ok: true, presetId: 'k3wise.material-detail.v1', object: 'material', mode: 'single_record_detail', recordPresent: false, recordCount: 0, referenceObjectCount: 0,
})
assert.deepEqual(readSmokeSuccessEvidence(PRESET, {}, { object: 'material', mode: 'single_record_detail' }), {
  ok: true, presetId: 'k3wise.material-detail.v1', object: 'material', mode: 'single_record_detail', recordPresent: false, recordCount: 0, referenceObjectCount: 0,
})
// C3 LIST paging echo (#1709): surfaces ONLY allowlisted values-free paging counts (K3-echoed page size/index +
// requested paging); a non-count value under the same metadata (materialNumber) is never surfaced.
const pagingEcho = readSmokeSuccessEvidence(LIST_PRESET, {
  records: [],
  metadata: {
    dataRowCount: 30134,
    dataPageSize: 0,
    dataPageIndex: 0,
    requestedLimit: 10,
    requestedPageIndex: 1,
    materialNumber: 'SECRET-MAT-001',
  },
}, { object: 'material', mode: 'list' })
assert.deepEqual(pagingEcho, {
  ok: true, presetId: 'k3wise.material-list.v1', object: 'material', mode: 'list',
  recordPresent: false, recordCount: 0, referenceObjectCount: 0,
  dataRowCount: 30134, dataPageSize: 0, dataPageIndex: 0, requestedLimit: 10, requestedPageIndex: 1,
})
assert.ok(!JSON.stringify(pagingEcho).includes('SECRET-MAT-001'), 'paging-echo evidence does not leak a material value')
assert.ok(!JSON.stringify(pagingEcho).includes('materialNumber'), 'paging-echo evidence drops non-allowlisted metadata keys')
const responseShapeEvidence = readSmokeSuccessEvidence(LIST_PRESET, {
  records: [],
  metadata: {
    responseShapeProbe: {
      dataObjectPresent: true,
      dataRowCountPresent: true,
      dataPageSizePresent: true,
      dataPageIndexPresent: false,
      dataDataType: 'null',
      dataDataArrayLength: null,
      materialNumber: 'SECRET-MAT-002',
      arbitraryKeyName: 'SECRET-KEY',
      fixedContainers: {
        dataData: { type: 'null', arrayLength: null, materialNumber: 'SECRET-MAT-002' },
        dataPascalData: { type: 'array', arrayLength: 2, materialNumber: 'SECRET-MAT-004' },
        dataList: { type: 'array', arrayLength: 2, rows: [{ materialNumber: 'SECRET-MAT-003' }] },
        resultRows: { type: 'invalid-type', arrayLength: 1 },
        arbitraryContainer: { type: 'array', arrayLength: 99 },
      },
    },
  },
}, { object: 'material', mode: 'list' })
assert.deepEqual(responseShapeEvidence, {
  ok: true,
  presetId: 'k3wise.material-list.v1',
  object: 'material',
  mode: 'list',
  recordPresent: false,
  recordCount: 0,
  referenceObjectCount: 0,
  responseShapeProbe: {
    dataObjectPresent: true,
    dataRowCountPresent: true,
    dataPageSizePresent: true,
    dataPageIndexPresent: false,
    dataDataType: 'null',
    dataDataArrayLength: null,
    fixedContainers: {
      dataData: { type: 'null', arrayLength: null },
      dataPascalData: { type: 'array', arrayLength: 2 },
      dataList: { type: 'array', arrayLength: 2 },
    },
  },
})
const responseShapeEvidenceStr = JSON.stringify(responseShapeEvidence)
for (const leak of ['SECRET-MAT-002', 'SECRET-MAT-003', 'SECRET-MAT-004', 'SECRET-KEY', 'materialNumber', 'arbitraryKeyName', 'arbitraryContainer']) {
  assert.ok(!responseShapeEvidenceStr.includes(leak), `response-shape evidence must not leak ${leak}`)
}

assert.deepEqual(readSmokeSuccessEvidence(LIST_PRESET, { records: [{ FNumber: 'M-001' }, { FNumber: 'M-002' }] }, { object: 'material', mode: 'list' }), {
  ok: true, presetId: 'k3wise.material-list.v1', object: 'material', mode: 'list', recordPresent: true, recordCount: 2, referenceObjectCount: 0,
})
assert.deepEqual(readSmokeSuccessEvidence(LIST_PRESET, {
  records: [],
  raw: { Data: { SECRET: 'never leak' } },
  metadata: {
    dataDataPresent: false,
    dataRowCount: 0,
    listShapeProbe: {
      dataData: false,
      dataLowerData: false,
      dataRows: true,
      resultData: false,
      resultRows: false,
      rows: false,
      topLevelArray: false,
      SECRET: true,
    },
    readPath: 'https://k3host/K3API/Material/GetList',
  },
}, { object: 'material', mode: 'list' }), {
  ok: true,
  presetId: 'k3wise.material-list.v1',
  object: 'material',
  mode: 'list',
  recordPresent: false,
  recordCount: 0,
  referenceObjectCount: 0,
  dataDataPresent: false,
  dataRowCount: 0,
  listShapeProbe: {
    dataData: false,
    dataLowerData: false,
    dataRows: true,
    resultData: false,
    resultRows: false,
    rows: false,
    topLevelArray: false,
  },
})

// --- error evidence: coarse code + type ONLY (never the message, which may carry the key/values) ---
class FakeAdapterError extends Error {
  constructor() {
    super('material M-001 failed with secret value 42')
    this.name = 'K3WiseWebApiAdapterError'
    this.details = { code: 'K3_WISE_READ_BUSINESS_ERROR' }
  }
}
const errEv = readSmokeErrorEvidence(PRESET, new FakeAdapterError(), { object: 'material', mode: 'single_record_detail' })
assert.deepEqual(errEv, {
  ok: false, presetId: 'k3wise.material-detail.v1', object: 'material', mode: 'single_record_detail',
  errorCode: 'K3_WISE_READ_BUSINESS_ERROR', errorType: 'K3WiseWebApiAdapterError',
})
const errStr = JSON.stringify(errEv)
for (const leak of ['M-001', '42', 'failed with secret']) {
  assert.ok(!errStr.includes(leak), `error evidence must not leak ${leak}`)
}
const listError = new Error('material M-001 rejected with secret value 42')
listError.name = 'K3WiseWebApiAdapterError'
listError.details = {
  code: 'K3_WISE_READ_LIST_ENVELOPE_UNRECOGNIZED',
  dataDataPresent: true,
  dataRowCount: 1,
  responseShapeProbe: {
    dataObjectPresent: true,
    dataRowCountPresent: true,
    dataPageSizePresent: false,
    dataPageIndexPresent: false,
    dataDataType: 'array',
    dataDataArrayLength: 1,
    fixedContainers: {
      dataData: { type: 'array', arrayLength: 1, materialNumber: 'M-001' },
      topLevel: { type: 'object', arrayLength: null },
      arbitraryContainer: { type: 'array', arrayLength: 1 },
    },
  },
  listShapeProbe: {
    dataData: true,
    dataLowerData: false,
    dataRows: false,
    resultData: false,
    resultRows: false,
    rows: false,
    topLevelArray: false,
    materialNumber: 'M-001',
  },
}
assert.deepEqual(readSmokeErrorEvidence(LIST_PRESET, listError, { object: 'material', mode: 'list' }), {
  ok: false, presetId: 'k3wise.material-list.v1', object: 'material', mode: 'list',
  errorCode: 'K3_WISE_READ_LIST_ENVELOPE_UNRECOGNIZED',
  errorType: 'K3WiseWebApiAdapterError',
  dataDataPresent: true,
  dataRowCount: 1,
  listShapeProbe: {
    dataData: true,
    dataLowerData: false,
    dataRows: false,
    resultData: false,
    resultRows: false,
    rows: false,
    topLevelArray: false,
  },
  responseShapeProbe: {
    dataObjectPresent: true,
    dataRowCountPresent: true,
    dataPageSizePresent: false,
    dataPageIndexPresent: false,
    dataDataType: 'array',
    dataDataArrayLength: 1,
    fixedContainers: {
      dataData: { type: 'array', arrayLength: 1 },
      topLevel: { type: 'object', arrayLength: null },
    },
  },
})
const listErrorStr = JSON.stringify(readSmokeErrorEvidence(LIST_PRESET, listError, { object: 'material', mode: 'list' }))
for (const leak of ['M-001', '42', 'materialNumber', 'arbitraryContainer']) {
  assert.ok(!listErrorStr.includes(leak), `LIST error evidence must not leak ${leak}`)
}
const unsafeDetails = new Error('material M-001 failed with secret value 42')
unsafeDetails.name = 'K3WiseWebApiAdapterError'
unsafeDetails.details = { code: 'M-001 failed with secret value 42' }
const unsafeEv = readSmokeErrorEvidence(PRESET, unsafeDetails, { object: 'material', mode: 'single_record_detail' })
assert.equal(unsafeEv.errorCode, 'READ_SMOKE_READ_FAILED', 'non-enum details.code is not surfaced')
const unsafeStr = JSON.stringify(unsafeEv)
for (const leak of ['M-001', '42', 'failed with secret']) {
  assert.ok(!unsafeStr.includes(leak), `unsafe details.code must not leak ${leak}`)
}
// error without code/name → safe defaults
const bare = readSmokeErrorEvidence(PRESET, {}, { object: 'material', mode: 'single_record_detail' })
assert.equal(bare.errorCode, 'READ_SMOKE_READ_FAILED')
assert.equal(bare.errorType, 'Error')

// --- C4 BOM read (#1709): values-free BOM evidence sanitizer. Feed bomShapeProbe + bomResponseShapeProbe with
// leak-bait values (material numbers, nested row payloads, arbitrary keys); the surfaced evidence must contain
// ONLY allowlisted booleans/counts + per-container {type, arrayLength}, dropping every value.
assert.ok(BOM_PRESET, 'k3wise.material-bom.v1 is registered')
const bomEvidence = readSmokeSuccessEvidence(BOM_PRESET, {
  records: [{ FNumber: 'SECRET-CHILD-1' }, { FNumber: 'SECRET-CHILD-2' }, { FNumber: 'SECRET-CHILD-3' }],
  metadata: {
    mode: 'material-bom-smoke',
    bomHeaderPresent: true,
    bomLinePresent: true,
    bomHeaderCount: 1,
    bomLineCount: 3,
    bomShapeProbe: {
      dataPage1: true,
      dataPage2: true,
      dataLowerPage1: false,
      dataLowerPage2: false,
      materialNumber: 'SECRET-BOM-001',
    },
    bomResponseShapeProbe: {
      dataObjectPresent: true,
      headerPresent: true,
      linePresent: true,
      arbitraryKeyName: 'SECRET-BOM-KEY',
      fixedContainers: {
        dataPage1: { type: 'array', arrayLength: 1, materialNumber: 'SECRET-BOM-002' },
        dataPage2: { type: 'array', arrayLength: 3, rows: [{ materialNumber: 'SECRET-BOM-003' }] },
        arbitraryContainer: { type: 'array', arrayLength: 99 },
      },
    },
  },
}, { object: 'material-bom', mode: 'bom' })
assert.deepEqual(bomEvidence, {
  ok: true,
  presetId: 'k3wise.material-bom.v1',
  object: 'material-bom',
  mode: 'bom',
  recordPresent: true,
  recordCount: 3,
  referenceObjectCount: 0,
  bomHeaderPresent: true,
  bomLinePresent: true,
  bomHeaderCount: 1,
  bomLineCount: 3,
  bomShapeProbe: {
    dataPage1: true,
    dataPage2: true,
    dataLowerPage1: false,
    dataLowerPage2: false,
  },
  bomResponseShapeProbe: {
    dataObjectPresent: true,
    headerPresent: true,
    linePresent: true,
    fixedContainers: {
      dataPage1: { type: 'array', arrayLength: 1 },
      dataPage2: { type: 'array', arrayLength: 3 },
    },
  },
})
const bomEvidenceStr = JSON.stringify(bomEvidence)
for (const leak of ['SECRET-CHILD-1', 'SECRET-CHILD-2', 'SECRET-CHILD-3', 'SECRET-BOM-001', 'SECRET-BOM-002', 'SECRET-BOM-003', 'SECRET-BOM-KEY', 'materialNumber', 'arbitraryKeyName', 'arbitraryContainer', 'rows']) {
  assert.ok(!bomEvidenceStr.includes(leak), `BOM evidence must not leak ${leak}`)
}

// C4 BOM read (#1709): values-free BOM ERROR evidence — symmetric to the LIST error path. A failed BOM read
// surfaces the coarse BOM code + presence/counts/shape from error.details, dropping every leak-bait value.
const bomError = {
  name: 'K3WiseWebApiAdapterError',
  details: {
    code: 'K3_WISE_BOM_READ_REJECTED',
    bomHeaderPresent: true,
    bomLinePresent: false,
    bomHeaderCount: 1,
    bomLineCount: 0,
    bomShapeProbe: {
      dataPage1: true,
      dataPage2: false,
      dataLowerPage1: false,
      dataLowerPage2: false,
      materialNumber: 'SECRET-BOM-ERR-001',
    },
    bomResponseShapeProbe: {
      dataObjectPresent: true,
      headerPresent: true,
      linePresent: false,
      arbitraryKeyName: 'SECRET-BOM-ERR-KEY',
      fixedContainers: {
        dataPage1: { type: 'array', arrayLength: 1, materialNumber: 'SECRET-BOM-ERR-002' },
        dataPage2: { type: 'null', arrayLength: null },
        arbitraryContainer: { type: 'array', arrayLength: 9 },
      },
    },
  },
}
assert.deepEqual(readSmokeErrorEvidence(BOM_PRESET, bomError, { object: 'material-bom', mode: 'bom' }), {
  ok: false,
  presetId: 'k3wise.material-bom.v1',
  object: 'material-bom',
  mode: 'bom',
  errorCode: 'K3_WISE_BOM_READ_REJECTED',
  errorType: 'K3WiseWebApiAdapterError',
  bomHeaderPresent: true,
  bomLinePresent: false,
  bomHeaderCount: 1,
  bomLineCount: 0,
  bomShapeProbe: {
    dataPage1: true,
    dataPage2: false,
    dataLowerPage1: false,
    dataLowerPage2: false,
  },
  bomResponseShapeProbe: {
    dataObjectPresent: true,
    headerPresent: true,
    linePresent: false,
    fixedContainers: {
      dataPage1: { type: 'array', arrayLength: 1 },
      dataPage2: { type: 'null', arrayLength: null },
    },
  },
})
const bomErrorStr = JSON.stringify(readSmokeErrorEvidence(BOM_PRESET, bomError, { object: 'material-bom', mode: 'bom' }))
for (const leak of ['SECRET-BOM-ERR-001', 'SECRET-BOM-ERR-002', 'SECRET-BOM-ERR-KEY', 'materialNumber', 'arbitraryKeyName', 'arbitraryContainer']) {
  assert.ok(!bomErrorStr.includes(leak), `BOM error evidence must not leak ${leak}`)
}

console.log('read-smoke.test.cjs OK')
