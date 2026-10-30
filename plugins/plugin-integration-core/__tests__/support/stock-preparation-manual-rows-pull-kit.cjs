'use strict'

// R line (R79 on onprem-r78) only: the lite test kit the B1 pull suite (stock-preparation-manual-rows-pull.test.cjs)
// runs on. Not a suite (lives under support/, so the chain-completeness walk does not see it).
//
// On main the suite uses support/stock-preparation-project-write-lock-kit.cjs, which requires the project write
// lock (lib/stock-preparation-project-write-lock.cjs, #6501) and wires the refresh governance (#6550); neither is on
// this line. The pieces the suite needs are copied here VERBATIM from that kit (as of main ccfe1432a) — the store fakes, the
// source adapter, the records fake and the synthetic golden fixture — with the host write fence left out of the
// records fake (this line's writer never sends a fence). Every value is synthetic.

const path = require('node:path')

const {
  PLM_STOCK_PREPARATION_ACTION_ID,
} = require(path.join(__dirname, '..', '..', 'lib', 'stock-preparation-table-actions.cjs'))

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

// The host storage contract (packages/core-backend/src/types/plugin.ts): get / set / delete and the
// OPTIONAL atomic consume. `consume` here is atomic the way the durable one is (one DELETE ... RETURNING):
// the read and the removal happen in one synchronous step, so two concurrent consumes of one key can
// never both answer the value.
function createConsumableStorage({ withConsume = true } = {}) {
  const map = new Map()
  const calls = []
  const store = {
    map,
    calls,
    async get(key) {
      calls.push(['get', key])
      return map.has(key) ? clone(map.get(key)) : null
    },
    async set(key, value) {
      calls.push(['set', key])
      map.set(key, clone(value))
    },
    async delete(key) {
      calls.push(['delete', key])
      map.delete(key)
    },
  }
  if (withConsume) {
    store.consume = async (key) => {
      calls.push(['consume', key])
      if (!map.has(key)) return null
      const value = map.get(key)
      map.delete(key)
      return clone(value)
    }
  }
  return store
}

function createSourceAdapter(data) {
  const calls = []
  return {
    calls,
    adapter: {
      async read(input = {}) {
        calls.push(clone(input))
        const rows = Array.isArray(data[input.object]) ? data[input.object] : []
        const found = rows.filter((row) =>
          Object.entries(input.filters || {}).every(([field, expected]) => row[field] === expected),
        )
        const offset = input.cursor ? Number(input.cursor) : 0
        const limit = input.limit || 1000
        const records = found.slice(offset, offset + limit).map(clone)
        return {
          records,
          done: offset + records.length >= found.length,
          nextCursor: offset + records.length < found.length ? String(offset + records.length) : null,
        }
      },
    },
  }
}

// `beforeWrite` (optional) is awaited inside createRecord / patchRecord BEFORE the row changes — the
// hook a test uses to hold a writer mid-run. (R line: no host write fence.)
function createRecordsApi({ existing = [], beforeWrite } = {}) {
  const rows = existing.map((entry, index) => ({
    id: entry.id || `rec_${index + 1}`,
    sheetId: entry.sheetId,
    version: entry.version || 1,
    data: { ...(entry.data || {}) },
  }))
  const calls = []
  let created = 0
  return {
    rows,
    calls,
    writes: () => calls.filter(([method]) => method === 'createRecord' || method === 'patchRecord'),
    recordsApi: {
      async queryRecords(input = {}) {
        calls.push(['queryRecords', clone(input)])
        return rows
          .filter((record) => record.sheetId === input.sheetId)
          .filter((record) => Object.entries(input.filters || {}).every(([field, value]) => record.data[field] === value))
          .slice(input.offset || 0, (input.offset || 0) + (input.limit || 1000))
          .map(clone)
      },
      async createRecord(input = {}) {
        calls.push(['createRecord', clone(input)])
        if (typeof beforeWrite === 'function') await beforeWrite('createRecord', input)
        created += 1
        const record = { id: `rec_new_${created}`, sheetId: input.sheetId, version: 1, data: { ...(input.data || {}) } }
        rows.push(record)
        return clone(record)
      },
      async patchRecord(input = {}) {
        calls.push(['patchRecord', clone(input)])
        if (typeof beforeWrite === 'function') await beforeWrite('patchRecord', input)
        const record = rows.find((row) => row.sheetId === input.sheetId && row.id === input.recordId)
        if (!record) throw new Error('record not found')
        record.version += 1
        record.data = { ...record.data, ...(input.changes || {}) }
        return clone(record)
      },
    },
  }
}

// ---------------------------------------------------------------------------------------------------
// The synthetic golden fixture
// ---------------------------------------------------------------------------------------------------

const GOLDEN_SHEET_ID = 'sheet_swl_golden'
const GOLDEN_PROJECT_NO = 'SYN-SWL-0001'
const GOLDEN_PLANNED_AT = '2026-10-22T08:00:00.000Z'
const GOLDEN_RUN_ID = 'run_swl_golden'

function goldenAction(overrides = {}) {
  return {
    actionId: PLM_STOCK_PREPARATION_ACTION_ID,
    source: { externalSystemId: 'swl_source_1', kind: 'data-source:sql-readonly' },
    target: { sheetId: GOLDEN_SHEET_ID, objectId: 'stockPreparationMain' },
    ...overrides,
  }
}

function goldenPlmData(projectNo = GOLDEN_PROJECT_NO) {
  return {
    DN_PDM_PathExAttrInfo: [{ FileCode: projectNo, Parent_OBJ_ID: 'SWL-PATH-1' }],
    DN_PDM_PathInfo: [{ OBJ_ID: 'SWL-PATH-1' }],
    DN_PDM_OrderHeadInfo: [{ OBJ_ID: 'SWL-ORDER-1', path_id: 'SWL-PATH-1' }],
    DN_PDM_OrderDetailInfo: [{ order_id: 'SWL-ORDER-1', part_id: 'SWL-PART-A', quantity: '2' }],
    DN_PDM_PartLibraryInfo: [
      { OBJ_ID: 'SWL-PART-A', IdentityNo: 'SWL-A-001', IdentityName: 'Synthetic assembly', Material: 'Synthetic', SysVer: 'V1' },
      { OBJ_ID: 'SWL-PART-B', IdentityNo: 'SWL-B-001', IdentityName: 'Synthetic part', Material: 'Synthetic', SysVer: 'V1' },
    ],
    DN_PDM_BomHeadInfo: [{ part_id: 'SWL-PART-A', bom_id: 'SWL-BOM-A', SysVer: 'V1', bom_able: true }],
    DN_PDM_BomDetailsInfo: [{ bom_pid: 'SWL-BOM-A', part_id: 'SWL-PART-B', Bom_ExAttr1: '3' }],
  }
}

module.exports = {
  GOLDEN_PLANNED_AT,
  GOLDEN_PROJECT_NO,
  GOLDEN_RUN_ID,
  GOLDEN_SHEET_ID,
  clone,
  createConsumableStorage,
  createRecordsApi,
  createSourceAdapter,
  goldenAction,
  goldenPlmData,
}
