'use strict'

// 人工补充行 B1 (ADR adr-stock-prep-manual-rows-20261030) — the plugin module itself (lib/stock-preparation-manual-rows.cjs):
//
//   MR-01 the two prefix constants and the storage key, byte for byte (B2 pins the host's constants to these).
//   MR-02 THE TRUTH TABLE (support/stock-preparation-manual-rows-truth-table.cjs): prefix / M′ / reader kind / export 来源
//         for every input shape — the same rows B2's host contract test runs through M.
//   MR-03 the collector attaches NOTHING when it collected nothing; otherwise one non-enumerable, frozen Symbol value
//         that no JSON / Object.keys / spread / slice carries, with the unbound ids capped at 50.
//   MR-04 the reminder (ADR §5.3): only ADD records count; 图号 (trimmed) decides when the manual row has one; without
//         one, 名称 + 规格 + 材料 (each trimmed) must all agree; numbers compare as their decimal text; the id lists are
//         sorted and capped at 50; `matchedManualRecordIds` are MANUAL rows' ids; null when nothing was collected.
//   MR-05 persistence (ADR §5.3): the key, the values-free value; a pull with nothing to say writes only over an existing
//         record; an unknown mode / blank sheet / store without get+set writes nothing; a failing store — or a `now`
//         that is no valid time — is logged with a code and never throws.
//
// Synthetic values only.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const manualRows = require(path.join(LIB, 'stock-preparation-manual-rows.cjs'))
const { MANUAL_ROWS_TRUTH_TABLE, PROJECT_OBJECT_ID } = require('./support/stock-preparation-manual-rows-truth-table.cjs')

const {
  EXISTING_ROWS_MANUAL_PREFIX,
  MANUAL_ROW_KEY_PREFIX,
  MANUAL_ROW_KEY_V1_PREFIX,
  MANUAL_ROWS_LAST_PULL_KEY_PREFIX,
  MANUAL_SUPPLEMENT_ID_LIMIT,
  ROW_SOURCES,
  classifyManualPrefixRow,
  createManualPrefixCollector,
  exportRowSourceOf,
  isManualPrefixKey,
  isManualSupplementRow,
  manualPrefixRowsOf,
  manualRowKeyFor,
  manualRowsLastPullKey,
  persistManualRowsLastPull,
  summarizeManualSupplement,
} = manualRows

const tests = []
const test = (name, fn) => tests.push([name, fn])

function readWith(manual = [], unbound = []) {
  const collector = createManualPrefixCollector()
  for (const [recordId, row] of manual) collector.add('manual', row, recordId)
  for (const recordId of unbound) collector.add('unbound_prefix', {}, recordId)
  return collector.attachTo([{ idempotencyKey: '{"k":1}' }])
}

function memoryStore() {
  const map = new Map()
  const calls = []
  return {
    map,
    calls,
    async get(key) { calls.push(['get', key]); return map.has(key) ? JSON.parse(JSON.stringify(map.get(key))) : null },
    async set(key, value) { calls.push(['set', key]); map.set(key, JSON.parse(JSON.stringify(value))) },
  }
}

test('MR-01 the prefix constants and the persisted key are the ADR\'s, byte for byte', () => {
  assert.equal(MANUAL_ROW_KEY_PREFIX, 'manual:')
  assert.equal(MANUAL_ROW_KEY_V1_PREFIX, 'manual:v1:')
  assert.ok(MANUAL_ROW_KEY_V1_PREFIX.startsWith(MANUAL_ROW_KEY_PREFIX), 'the v1 key sits inside the namespace')
  assert.equal(Buffer.from(MANUAL_ROW_KEY_PREFIX, 'utf8').toString('hex'), '6d616e75616c3a')
  assert.equal(Buffer.from(MANUAL_ROW_KEY_V1_PREFIX, 'utf8').toString('hex'), '6d616e75616c3a76313a')
  assert.equal(MANUAL_ROWS_LAST_PULL_KEY_PREFIX, 'stockPrepManualRows:lastPull:v1:')
  assert.equal(manualRowsLastPullKey('sheet_mr_1'), 'stockPrepManualRows:lastPull:v1:sheet_mr_1')
  assert.equal(manualRowsLastPullKey('  '), null)
  assert.equal(manualRowKeyFor('rec_mr_1'), 'manual:v1:rec_mr_1')
  assert.equal(manualRowKeyFor(''), null)
  assert.equal(MANUAL_SUPPLEMENT_ID_LIMIT, 50)
  assert.deepEqual(ROW_SOURCES, { MANUAL_SUPPLEMENT: 'manual_supplement', MANUAL_OTHER: 'manual_other', PLM: 'plm' })
  assert.equal(EXISTING_ROWS_MANUAL_PREFIX, Symbol.for('metasheet.stock-preparation.existingRows.manualPrefix'))
  // A PLM key (bom-expansion makeIdempotencyKey: JSON of an object) can never enter the namespace.
  assert.equal(isManualPrefixKey(JSON.stringify({ projectNo: 'manual:x', componentSourceId: 'manual:y' })), false)
})

test('MR-02 the truth table: prefix, M′, the reader kind and the export 来源 for every input shape', () => {
  assert.ok(MANUAL_ROWS_TRUTH_TABLE.length >= 20, 'the table is not vacuous')
  const kinds = new Set()
  for (const { name, input, expected } of MANUAL_ROWS_TRUTH_TABLE) {
    assert.equal(isManualPrefixKey(input.key), expected.prefix, `${name}: prefix`)
    assert.equal(isManualSupplementRow(input), expected.manual, `${name}: M′`)
    assert.equal(classifyManualPrefixRow(input), expected.kind, `${name}: kind`)
    assert.equal(exportRowSourceOf(input), expected.source, `${name}: source`)
    kinds.add(`${expected.kind}/${expected.source}`)
  }
  // Every cell of the classification is exercised.
  assert.deepEqual([...kinds].sort(), ['manual/manual_supplement', 'null/manual_other', 'null/plm', 'unbound_prefix/manual_other'])
  // The predicate reads the objectId through own-base's ONE project-sheet rule.
  const { isStockPreparationProjectSheetObjectId } = require(path.join(LIB, 'stock-preparation-own-base.cjs'))
  assert.equal(isStockPreparationProjectSheetObjectId(PROJECT_OBJECT_ID), true)
})

test('MR-03 the collector: nothing collected => nothing attached; otherwise one frozen, non-enumerable Symbol value no copy carries', () => {
  const plain = [{ a: 1 }]
  assert.equal(createManualPrefixCollector().attachTo(plain), plain)
  assert.deepEqual(Object.getOwnPropertySymbols(plain), [], 'no Symbol on a read without a prefix row')
  assert.equal(manualPrefixRowsOf(plain), null)

  const collector = createManualPrefixCollector()
  const manualRow = { idempotencyKey: 'manual:v1:rec_m1', componentCode: 'SYN-C' }
  collector.add('manual', manualRow, 'rec_m1')
  for (let i = 0; i < 60; i += 1) collector.add('unbound_prefix', {}, `rec_u_${String(i).padStart(2, '0')}`)
  collector.add('unbound_prefix', {}, null)
  const rows = collector.attachTo([{ idempotencyKey: '{"k":1}' }])
  const value = manualPrefixRowsOf(rows)
  assert.equal(value.manualRows.length, 1)
  assert.equal(value.manualRows[0].recordId, 'rec_m1')
  assert.equal(value.manualRows[0].row, manualRow)
  assert.equal(value.unboundKeyCount, 61, 'every unbound row counts, id or not')
  assert.equal(value.unboundRecordIds.length, 50, 'ids capped at 50')
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value.manualRows) && Object.isFrozen(value.unboundRecordIds))
  const descriptor = Object.getOwnPropertyDescriptor(rows, EXISTING_ROWS_MANUAL_PREFIX)
  assert.equal(descriptor.enumerable, false)
  assert.equal(descriptor.writable, false)
  assert.equal(JSON.stringify(rows), '[{"idempotencyKey":"{\\"k\\":1}"}]', 'JSON carries the array only')
  assert.deepEqual(Object.keys(rows), ['0'])
  assert.equal(manualPrefixRowsOf(rows.slice()), null, 'a copy drops it')
  assert.equal(manualPrefixRowsOf([...rows]), null, 'a spread drops it')
  assert.equal(manualPrefixRowsOf(JSON.parse(JSON.stringify(rows))), null, 'cloneJson drops it (the large lane)')
  assert.equal(manualPrefixRowsOf('not an array'), null)
})

test('MR-04 the reminder compares ADD records only: 图号 first; else 名称 + 规格 + 材料; ids sorted, capped, manual rows\' own', () => {
  const existing = readWith([
    ['rec_m_code', { componentCode: '  SYN-B-001 ' }],
    ['rec_m_code_miss', { componentCode: 'SYN-NOT-IN-PLM' }],
    ['rec_m_triple', { componentCode: '', componentName: ' 合成件 ', componentSpec: 'DN10', material: 'Q235 ' }],
    ['rec_m_triple_partial', { componentName: '合成件', componentSpec: 'DN10', material: 'OTHER' }],
    ['rec_m_numeric', { componentCode: 1001 }],
  ], ['rec_u_2', 'rec_u_1'])
  const addRecords = [
    { componentCode: 'SYN-B-001', componentName: 'X', componentSpec: 'Y', material: 'Z' },
    { componentCode: 'SYN-OTHER', componentName: '合成件', componentSpec: ' DN10', material: 'Q235' },
    { componentCode: '1001', componentName: 'N', componentSpec: null, material: null },
  ]
  const summary = summarizeManualSupplement({ existingRows: existing, addRecords })
  assert.deepEqual(summary, {
    rowCount: 5,
    unboundKeyCount: 2,
    matchedManualCount: 3,
    matchedManualRecordIds: ['rec_m_code', 'rec_m_numeric', 'rec_m_triple'],
    unboundRecordIds: ['rec_u_1', 'rec_u_2'],
  })
  // A manual row with a 图号 never falls back to the triple (its code is the identity).
  const codeOnly = summarizeManualSupplement({
    existingRows: readWith([['rec_m', { componentCode: 'SYN-NOPE', componentName: '合成件', componentSpec: 'DN10', material: 'Q235' }]]),
    addRecords,
  })
  assert.equal(codeOnly.matchedManualCount, 0)
  // No ADD at all (every PLM row already exists: UPDATE / SKIP) => no reminder, the counts stay.
  const noAdds = summarizeManualSupplement({ existingRows: existing, addRecords: [] })
  assert.equal(noAdds.matchedManualCount, 0)
  assert.deepEqual(noAdds.matchedManualRecordIds, [])
  assert.equal(noAdds.rowCount, 5)
  // Nothing collected => null (the result stanza is absent, never an all-zero object).
  assert.equal(summarizeManualSupplement({ existingRows: [{ a: 1 }], addRecords }), null)
  assert.equal(summarizeManualSupplement({}), null)
  // Only-unbound reads still report (rowCount 0, unboundKeyCount > 0).
  assert.deepEqual(summarizeManualSupplement({ existingRows: readWith([], ['rec_u']), addRecords }), {
    rowCount: 0, unboundKeyCount: 1, matchedManualCount: 0, matchedManualRecordIds: [], unboundRecordIds: ['rec_u'],
  })
  // The id lists are capped at 50 (sorted first).
  const many = readWith(Array.from({ length: 70 }, (_, i) => [`rec_m_${String(69 - i).padStart(2, '0')}`, { componentCode: 'SYN-B-001' }]))
  const capped = summarizeManualSupplement({ existingRows: many, addRecords })
  assert.equal(capped.matchedManualCount, 70)
  assert.equal(capped.matchedManualRecordIds.length, 50)
  assert.equal(capped.matchedManualRecordIds[0], 'rec_m_00')
  assert.equal(capped.matchedManualRecordIds[49], 'rec_m_49')
})

test('MR-05 persistence: key + values-free value; a silent pull overwrites only an existing record; guards; a failing store or a bad clock never throws', async () => {
  const store = memoryStore()
  const summary = { rowCount: 2, unboundKeyCount: 1, matchedManualCount: 1, matchedManualRecordIds: ['rec_m1'], unboundRecordIds: ['rec_u1'] }
  assert.equal(await persistManualRowsLastPull({ store, sheetId: 'sheet_mr', mode: 'dry_run', at: '2026-10-30T01:00:00.000Z', summary }), true)
  assert.deepEqual(store.map.get('stockPrepManualRows:lastPull:v1:sheet_mr'), {
    at: '2026-10-30T01:00:00.000Z', mode: 'dry_run', rowCount: 2, unboundKeyCount: 1, matchedManualCount: 1, matchedManualRecordIds: ['rec_m1'], unboundRecordIds: ['rec_u1'],
  })
  assert.deepEqual(store.calls, [['set', 'stockPrepManualRows:lastPull:v1:sheet_mr']], 'a pull with something to say does not read first')
  // The next pull has nothing to say: it OVERWRITES the existing record with zeros (the reminder never outlives it).
  store.calls.length = 0
  assert.equal(await persistManualRowsLastPull({ store, sheetId: 'sheet_mr', mode: 'apply', at: '2026-10-30T02:00:00.000Z', summary: null }), true)
  assert.deepEqual(store.map.get('stockPrepManualRows:lastPull:v1:sheet_mr'), {
    at: '2026-10-30T02:00:00.000Z', mode: 'apply', rowCount: 0, unboundKeyCount: 0, matchedManualCount: 0, matchedManualRecordIds: [], unboundRecordIds: [],
  })
  // A sheet that never had a prefix row never gets a record: one read, no write.
  store.calls.length = 0
  assert.equal(await persistManualRowsLastPull({ store, sheetId: 'sheet_plm_only', mode: 'dry_run', at: '2026-10-30T03:00:00.000Z', summary: null }), false)
  assert.deepEqual(store.calls, [['get', 'stockPrepManualRows:lastPull:v1:sheet_plm_only']])
  assert.equal(store.map.has('stockPrepManualRows:lastPull:v1:sheet_plm_only'), false)
  // Guards: unknown mode, blank sheet, a store without get + set.
  assert.equal(await persistManualRowsLastPull({ store, sheetId: 'sheet_mr', mode: 'large', at: 'x', summary }), false)
  assert.equal(await persistManualRowsLastPull({ store, sheetId: ' ', mode: 'dry_run', at: 'x', summary }), false)
  assert.equal(await persistManualRowsLastPull({ store: { set: async () => {} }, sheetId: 'sheet_mr', mode: 'dry_run', at: 'x', summary }), false)
  assert.equal(await persistManualRowsLastPull({ store: null, sheetId: 'sheet_mr', mode: 'dry_run', at: 'x', summary }), false)
  // A failing store: logged with a code, never thrown.
  const warnings = []
  const failing = { async get() { return null }, async set() { throw Object.assign(new Error('storage down ZZSENTINELVALUEZZ'), { code: 'PLUGIN_DURABLE_STORAGE_UNAVAILABLE' }) } }
  assert.equal(await persistManualRowsLastPull({ store: failing, sheetId: 'sheet_mr', mode: 'apply', at: 'x', summary, logger: { warn: (...args) => warnings.push(args) } }), false)
  assert.equal(warnings.length, 1)
  assert.deepEqual(warnings[0][1], { code: 'PLUGIN_DURABLE_STORAGE_UNAVAILABLE', mode: 'apply' })
  assert.equal(JSON.stringify(warnings).includes('ZZSENTINELVALUEZZ'), false, 'the log line carries the code, never the message')
  assert.equal(await persistManualRowsLastPull({ store: failing, sheetId: 'sheet_mr', mode: 'apply', at: 'x', summary }), false, 'no logger: still no throw')
  // The timestamp from `now` (epoch ms) is taken INSIDE the best-effort try: a value that is no valid time is logged
  // and writes nothing — it never throws out of the pull.
  const clocked = memoryStore()
  assert.equal(await persistManualRowsLastPull({ store: clocked, sheetId: 'sheet_mr_now', mode: 'dry_run', now: Date.parse('2026-10-30T04:00:00.000Z'), summary }), true)
  assert.equal(clocked.map.get('stockPrepManualRows:lastPull:v1:sheet_mr_now').at, '2026-10-30T04:00:00.000Z')
  const clockWarnings = []
  assert.equal(await persistManualRowsLastPull({ store: clocked, sheetId: 'sheet_mr_bad_now', mode: 'dry_run', now: 1e20, summary, logger: { warn: (...args) => clockWarnings.push(args) } }), false)
  assert.equal(clocked.map.has('stockPrepManualRows:lastPull:v1:sheet_mr_bad_now'), false)
  assert.deepEqual(clockWarnings.map((args) => args[1]), [{ code: 'PERSIST_FAILED', mode: 'dry_run' }])
  // The value is values-free by shape: exactly these seven keys.
  assert.deepEqual(Object.keys(store.map.get('stockPrepManualRows:lastPull:v1:sheet_mr')).sort(), ['at', 'matchedManualCount', 'matchedManualRecordIds', 'mode', 'rowCount', 'unboundKeyCount', 'unboundRecordIds'])
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-manual-rows.test.cjs', tests)
