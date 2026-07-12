'use strict'

// #4160 — the fake multitable the stock-preparation tests write against, made to behave like the
// REAL one on the single point that mattered: FIELD IDS.
//
// Why this file exists. Every stock-preparation write test used to inject a records API that happily
// accepted the frozen templates' LOGICAL keys ('snapshotBatchId'). The real records service does not:
// provisioning materializes each logical key as a DERIVED physical fieldId, and the service rejects
// anything else outright —
//   packages/core-backend/src/multitable/records.ts       buildNormalizedPatch  -> `Unknown fieldId: X`
//   packages/core-backend/src/multitable/query-service.ts normalizeQueryFilters -> `Unknown fieldId: X`
// — while the rows it RETURNS are keyed by physical id. So the suite was green against a substrate
// that could not exist, and the whole MVP chain 500'd on the first real write (#4160).
//
// These fakes close that gap:
//   * physicalFieldId()  reproduces the platform derivation EXACTLY (provisioning.ts getObjectFieldId:
//     stableMetaId('fld', projectId, objectId, fieldId) = 'fld_' + sha1(parts.join(':')).slice(0,24)),
//     so the ids the tests exercise are the ids production computes;
//   * makeFakeProvisioning() exposes resolveFieldIds over that derivation (the only sanctioned way for
//     a plugin to learn them);
//   * assertKnownFieldIds() rejects any key that is not a physical id of the target object's frozen
//     template — logical keys included — with the service's own message.
//
// A records-API fake built on these throws exactly where the real service throws. Point it at the
// pre-#4160 modules and the suite goes RED with `Unknown fieldId: snapshotBatchId`.

const { createHash } = require('node:crypto')
const path = require('node:path')

const {
  STOCK_PREPARATION_MVP_TABLE_TEMPLATES,
} = require(path.join(__dirname, '..', '..', 'lib', 'stock-preparation-templates.cjs'))

const TEMPLATE_BY_OBJECT_ID = new Map(
  STOCK_PREPARATION_MVP_TABLE_TEMPLATES.map((template) => [template.objectId, template]),
)

// Byte-for-byte the platform's derivation (multitable/provisioning.ts stableMetaId + getObjectFieldId).
function physicalFieldId(projectId, objectId, fieldId) {
  const digest = createHash('sha1').update([projectId, objectId, fieldId].join(':')).digest('hex').slice(0, 24)
  return `fld_${digest}`.slice(0, 50)
}

function templateFieldIds(objectId) {
  const template = TEMPLATE_BY_OBJECT_ID.get(objectId)
  if (!template) throw new Error(`fixture: no frozen MVP template for objectId ${objectId}`)
  return template.fields.map((field) => field.id)
}

// logical -> physical, over the object's frozen template (what provisioning.resolveFieldIds returns).
function resolveFieldIdsFor(projectId, objectId, fieldIds) {
  const requested = Array.isArray(fieldIds) ? fieldIds : templateFieldIds(objectId)
  const resolved = {}
  for (const fieldId of requested) resolved[fieldId] = physicalFieldId(projectId, objectId, fieldId)
  return resolved
}

function physicalFieldIdSet(projectId, objectId) {
  return new Set(templateFieldIds(objectId).map((fieldId) => physicalFieldId(projectId, objectId, fieldId)))
}

// The records service's own gate: any key that is not one of the sheet's field ids is rejected. A
// LOGICAL key lands here too — which is precisely the bug this fixture exists to surface.
function assertKnownFieldIds(projectId, objectId, keys) {
  const known = physicalFieldIdSet(projectId, objectId)
  for (const key of keys) {
    if (!known.has(key)) throw new Error(`Unknown fieldId: ${key}`)
  }
}

// Fake provisioning over a { objectId -> sheetId } registry, scoped to ONE staging project (a lookup
// with any other projectId misses, mirroring the real provisioning scope). `missing` marks objectIds
// that are not provisioned even under the staging project.
function makeFakeProvisioning({ sheetIdByObjectId, stagingProjectId, missing = new Set() } = {}) {
  const calls = { findObjectSheet: [], resolveFieldIds: [] }
  return {
    calls,
    async findObjectSheet({ projectId, objectId } = {}) {
      calls.findObjectSheet.push({ projectId, objectId })
      if (projectId !== stagingProjectId) return null
      if (missing.has(objectId)) return null
      const sheetId = sheetIdByObjectId[objectId]
      return sheetId ? { id: sheetId } : null
    },
    async resolveFieldIds({ projectId, objectId, fieldIds } = {}) {
      calls.resolveFieldIds.push({ projectId, objectId, fieldIds })
      return resolveFieldIdsFor(projectId, objectId, fieldIds)
    },
  }
}

// A STRICT in-memory records API: it knows which object each sheet carries, so every createRecord /
// patchRecord / queryRecords key is validated exactly as the real service validates it.
//
//   store        seeded/inspected as { [sheetId]: [{ id, data: { <PHYSICAL fieldId>: value } }] }
//   createCalls  { sheetId, data }  — data as the module actually sent it (physical ids)
//   queryCalls   { sheetId, filters }
//   patchCalls   { recordId, changes }
function makeStrictRecordsApi({ objectIdBySheetId, stagingProjectId, rowsBySheet = {} } = {}) {
  const store = new Map(Object.entries(rowsBySheet).map(([sheetId, rows]) => [sheetId, rows.map((row) => ({ ...row, data: { ...row.data } }))]))
  const createCalls = []
  const queryCalls = []
  const patchCalls = []
  let seq = 0

  function objectIdFor(sheetId) {
    const objectId = objectIdBySheetId[sheetId]
    if (!objectId) throw new Error(`Sheet not found: ${sheetId}`) // the service's own missing-sheet error
    return objectId
  }

  return {
    store,
    createCalls,
    queryCalls,
    patchCalls,
    get patchCallCount() {
      return patchCalls.length
    },
    rows(sheetId) {
      return (store.get(sheetId) || []).map((row) => ({ ...row, data: { ...row.data } }))
    },
    async createRecord(input = {}) {
      const { sheetId, data = {} } = input
      assertKnownFieldIds(stagingProjectId, objectIdFor(sheetId), Object.keys(data))
      createCalls.push({ sheetId, data: { ...data } })
      const rows = store.get(sheetId) || []
      seq += 1
      const record = { id: `rec_${seq}`, sheetId, version: 1, data: { ...data } }
      rows.push(record)
      store.set(sheetId, rows)
      return { ...record, data: { ...record.data } }
    },
    async queryRecords(input = {}) {
      const { sheetId, filters = {} } = input
      assertKnownFieldIds(stagingProjectId, objectIdFor(sheetId), Object.keys(filters))
      queryCalls.push({ sheetId, filters: { ...filters } })
      const rows = store.get(sheetId) || []
      return rows
        .filter((record) => Object.entries(filters).every(([key, value]) => record.data[key] === value))
        .map((record) => ({ ...record, data: { ...record.data } }))
    },
    async patchRecord(input = {}) {
      const { sheetId, recordId, changes = {} } = input
      assertKnownFieldIds(stagingProjectId, objectIdFor(sheetId), Object.keys(changes))
      patchCalls.push({ sheetId, recordId, changes: { ...changes } })
      const rows = store.get(sheetId) || []
      const record = rows.find((row) => row.id === recordId)
      if (!record) throw new Error(`Record not found: ${recordId}`)
      // Merge semantics, exactly like records.ts patchRecord (`nextData = { ...existing, ...patch }`):
      // an explicit null SETS null — it does not remove the key.
      Object.assign(record.data, changes)
      record.version = (record.version || 1) + 1
      return { ...record, data: { ...record.data } }
    },
  }
}

// Seed helper: turn LOGICAL test rows into the PHYSICAL-keyed rows the substrate really stores.
function physicalRow(projectId, objectId, logicalRow, id) {
  const data = {}
  for (const [key, value] of Object.entries(logicalRow || {})) {
    data[physicalFieldId(projectId, objectId, key)] = value
  }
  return id ? { id, sheetId: null, version: 1, data } : { data }
}

// Read a stored (physical-keyed) row back as logical keys — for assertions on what was persisted.
function logicalData(projectId, objectId, data) {
  const inverse = new Map(templateFieldIds(objectId).map((fieldId) => [physicalFieldId(projectId, objectId, fieldId), fieldId]))
  const out = {}
  for (const [key, value] of Object.entries(data || {})) {
    out[inverse.has(key) ? inverse.get(key) : key] = value
  }
  return out
}

module.exports = {
  physicalFieldId,
  physicalFieldIdSet,
  templateFieldIds,
  resolveFieldIdsFor,
  assertKnownFieldIds,
  makeFakeProvisioning,
  makeStrictRecordsApi,
  physicalRow,
  logicalData,
}
