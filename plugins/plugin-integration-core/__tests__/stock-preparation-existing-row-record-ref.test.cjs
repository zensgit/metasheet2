'use strict'

// Batch-refresh step 4, PR-1 — the ONE table-actions edit: `readExistingStockPreparationRows` attaches
// the record id + version on the planner's Symbol key EXISTING_ROW_RECORD_REF (design §6.5). Envelope
// records only, read from the envelope (a `data.id` cell cannot forge it), hash-neutral (the dry-run
// revision and the archive revision do not move — end to end that is pinned by
// stock-preparation-continuation-golden.test.cjs), and `unmapRecordFields` itself is unchanged (the
// foreign-rows scan reads it).

const assert = require('node:assert/strict')
const path = require('node:path')

const { __internals: tableActionInternals } = require(path.join(__dirname, '..', 'lib', 'stock-preparation-table-actions.cjs'))
const { EXISTING_ROW_RECORD_REF } = require(path.join(__dirname, '..', 'lib', 'stock-preparation-conflict-planner.cjs'))
const { recordRefOf } = require(path.join(__dirname, '..', 'lib', 'stock-preparation-continuation-pairing.cjs'))

const { readExistingStockPreparationRows, unmapRecordFields, buildRevision, stableStringify } = tableActionInternals

const TARGET = { sheetId: 'sheet_scc_ref', fieldIdMap: { projectNo: 'fld_project', notes: 'fld_notes' } }

const tests = []
function test(name, fn) {
  tests.push([name, fn])
}

function recordsApi(records) {
  return {
    async queryRecords({ filters = {}, limit = 1000, offset = 0 } = {}) {
      return records
        .filter((record) => {
          const data = record.data && typeof record.data === 'object' ? record.data : record
          return Object.entries(filters).every(([field, value]) => data[field] === value)
        })
        .slice(offset, offset + limit)
        .map((record) => JSON.parse(JSON.stringify(record)))
    },
  }
}

test('envelope records carry { id, version } on the Symbol key; it is invisible to keys / JSON / stableStringify', async () => {
  const rows = await readExistingStockPreparationRows(recordsApi([
    { id: 'rec_1', version: 4, data: { fld_project: 'PRJ-SCC-1', fld_notes: 'n', idempotencyKey: 'k1' } },
    { id: 'rec_2', version: 1, createdBy: 'actor_scc', data: { fld_project: 'PRJ-SCC-1', idempotencyKey: 'k2' } },
  ]), TARGET, 'PRJ-SCC-1')
  assert.deepEqual(rows.map((row) => row[EXISTING_ROW_RECORD_REF]), [{ id: 'rec_1', version: 4 }, { id: 'rec_2', version: 1 }])
  assert.deepEqual(rows.map(recordRefOf), [{ id: 'rec_1', version: 4 }, { id: 'rec_2', version: 1 }])
  assert.ok(Object.isFrozen(rows[0][EXISTING_ROW_RECORD_REF]))
  assert.deepEqual(Object.keys(rows[0]).sort(), ['idempotencyKey', 'notes', 'projectNo'])
  assert.equal(JSON.stringify(rows[0]).includes('rec_1'), false)
  assert.equal(stableStringify(rows[0]).includes('rec_1'), false)
  // GOV-05's createdBy Symbol still rides beside it.
  assert.equal(Object.getOwnPropertySymbols(rows[1]).length, 2)
  // The planner's normalizeRows spread keeps it.
  assert.deepEqual({ ...rows[0] }[EXISTING_ROW_RECORD_REF], { id: 'rec_1', version: 4 })
})

test('no reference without an envelope id: flat rows, blank ids, and a `data.id` CELL (cannot forge it); a non-integer version reads as null', async () => {
  const rows = await readExistingStockPreparationRows(recordsApi([
    { id: 'flat_1', fld_project: 'PRJ-SCC-1', idempotencyKey: 'k1' },
    { id: '   ', version: 2, data: { fld_project: 'PRJ-SCC-1', idempotencyKey: 'k2' } },
    { version: 2, data: { fld_project: 'PRJ-SCC-1', id: 'forged_cell', idempotencyKey: 'k3' } },
    { id: 'rec_4', version: '7', data: { fld_project: 'PRJ-SCC-1', idempotencyKey: 'k4' } },
  ]), TARGET, 'PRJ-SCC-1')
  assert.equal(rows[0][EXISTING_ROW_RECORD_REF], undefined)
  assert.equal(rows[1][EXISTING_ROW_RECORD_REF], undefined)
  assert.equal(rows[2][EXISTING_ROW_RECORD_REF], undefined)
  assert.equal(recordRefOf(rows[2]), null)
  assert.deepEqual(rows[3][EXISTING_ROW_RECORD_REF], { id: 'rec_4', version: null })
})

test('unmapRecordFields itself is unchanged: it attaches no record reference (the foreign-rows scan reads it)', () => {
  const out = unmapRecordFields({ id: 'rec_1', version: 3, data: { fld_project: 'PRJ-SCC-1' } }, TARGET.fieldIdMap)
  assert.equal(out[EXISTING_ROW_RECORD_REF], undefined)
  assert.deepEqual(out, { projectNo: 'PRJ-SCC-1' })
})

test('hash-neutral: buildRevision over the read rows equals buildRevision over the same rows without the reference', async () => {
  const rows = await readExistingStockPreparationRows(recordsApi([
    { id: 'rec_1', version: 4, data: { fld_project: 'PRJ-SCC-1', fld_notes: 'n', idempotencyKey: 'k1', totalQuantity: 2 } },
    { id: 'rec_2', version: 9, data: { fld_project: 'PRJ-SCC-1', idempotencyKey: 'k2', totalQuantity: 3 } },
  ]), TARGET, 'PRJ-SCC-1')
  const stripped = rows.map((row) => {
    const copy = { ...row }
    delete copy[EXISTING_ROW_RECORD_REF]
    return copy
  })
  const args = (existingRows) => ({
    action: { actionId: 'a', source: { externalSystemId: 'x', workspaceId: null, readPlan: {} }, target: TARGET },
    parameters: { projectNo: 'PRJ-SCC-1' },
    expansion: { status: 'expanded', rows: [], errors: [], rowErrors: [] },
    existingRows,
    conflictPolicyReview: null,
    plan: null,
  })
  assert.equal(buildRevision(args(rows)), buildRevision(args(stripped)))
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-existing-row-record-ref.test.cjs', tests)
