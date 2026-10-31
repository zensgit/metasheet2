'use strict'

// 人工补充行 B1 (ADR adr-stock-prep-manual-rows-20261030 §5.1–§5.3, §8 「B1 插件」 1–3, 5–7) — the pull never touches a
// `manual:` prefix row:
//
//   MP-01 THE RAW PAGE (condition 1): limit = 2, the manual row on page 1, PLM rows on pages 1–2 — every PLM row is
//         returned (the last-page test reads the host's page length, never the rows left after the prefix rows came
//         out); a page holding only prefix rows still counts against maxPages.
//   MP-02 the read without a prefix row is the pre-B1 read (same rows, same Symbols, no array Symbol); with one, the
//         prefix rows ride on the non-enumerable array Symbol; a `data.id` / `data.createdBy` CELL cannot forge M′.
//   MP-03 the manual row end to end: preview ready, two ADDs, no INACTIVE; the revision, the counts and the evidence are
//         those of the same sheet WITHOUT the manual row (not in the plan, not hashed); `manualSupplement` reports it
//         (matched by 图号 against an ADD); the apply writes the two PLM rows and never the manual row (version and
//         data byte-identical); the reminder is persisted for the preview and for the apply; the next pull (no ADD
//         left) overwrites it with matchedManualCount 0.
//   MP-04 the reminder by 名称 + 规格 + 材料 when the manual row has no 图号; a COPY of an existing PLM row never reminds
//         (that row is a SKIP, not an ADD) (condition 6).
//   MP-05 THE THREE UNBOUND PREFIX ROWS (condition 2) — created_by empty, the key naming another row's id, an env
//         target: each one's plan is valid, 0 failed decisions, the row is never written; counted as unboundKeyCount.
//   MP-06 a sheet without a prefix row: no `manualSupplement` key, no reminder record (no write), the response
//         byte-identical to the same dry-run without the store; a project the source does not know (not_found)
//         leaves an existing record alone; a direct lib caller (no store) persists nothing.
//   MP-07 INVARIANT (condition 7): a manual row never carries componentSourceId — nothing on the pull path writes one
//         (no decision names its key; after the apply it has none), so the carry route's anti-forgery check
//         (stock-preparation-confirm-writes.cjs, the component axis) can never match a manual row.
//   MP-08 THE WRITER (condition 3, ADR §5.2): an ADD with a `manual:` key fails APPLY_MANUAL_KEY_RESERVED alone (no
//         lookup, no write), the rest of the run proceeds; the batch prefetch runs over the same plan and does not
//         throw; UPDATE / INACTIVE keep the shared `decisionKey` path untouched (the refusal is ADD-only).
//   MP-09 the R-60 boundary (ADR §6): the settlement's machine digest over the reader's rows is the same with no manual
//         row, with one, and after the manual row is edited — so a governed project's formal export does not move.
//   MP-10 a preview over a TRUNCATED read (the small-lane cap, `large_bom_bounded`) holds only part of the ADD rows: it
//         creates no reminder record and leaves an existing one byte-identical (verification r1 MF-1). MP-03 also pins
//         WHERE each record is written: the apply's inside its write lease, a preview's outside any lease.
//
// Synthetic values only.

const assert = require('node:assert/strict')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const tableActions = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const writer = require(path.join(LIB, 'stock-preparation-apply-writer.cjs'))
const { DECISIONS, EXISTING_ROW_CREATED_BY, EXISTING_ROW_RECORD_REF } = require(path.join(LIB, 'stock-preparation-conflict-planner.cjs'))
const { EXISTING_ROWS_MANUAL_PREFIX, manualPrefixRowsOf } = require(path.join(LIB, 'stock-preparation-manual-rows.cjs'))
const { machineBandFieldIds, sheetMachineDigest } = require(path.join(LIB, 'stock-preparation-continuation-pairing.cjs'))
const { STOCK_PREPARATION_MAIN_TABLE_TEMPLATE } = require(path.join(LIB, 'stock-preparation-templates.cjs'))
const { sheetWriteScopeKey } = require(path.join(LIB, 'stock-preparation-project-write-lock.cjs'))
const kit = require('./support/stock-preparation-project-write-lock-kit.cjs')

const { readExistingStockPreparationRows, unmapRecordFields } = tableActions.__internals

const tests = []
const test = (name, fn) => tests.push([name, fn])

const PROJECT_NO = 'SYN-MR-0001'
const PROJECT_OBJECT_ID = 'plm_stock_preparation_sandbox_p_0123456789abcdef01234567'
const ENV_OBJECT_ID = 'plm_stock_preparation_sandbox_mr_env'
const SANDBOX = Object.freeze({ enabled: true, allowedTargetObjectIds: [PROJECT_OBJECT_ID, ENV_OBJECT_ID] })
const PERSON = 'u_mr_person'
const LAST_PULL_KEY_PREFIX = 'stockPrepManualRows:lastPull:v1:'

function actionFor(sheetId, objectId = PROJECT_OBJECT_ID) {
  return {
    actionId: tableActions.PLM_STOCK_PREPARATION_ACTION_ID,
    source: { externalSystemId: 'mr_source_1', kind: 'data-source:sql-readonly' },
    target: { sheetId, objectId },
  }
}

// A person's row as the host stores it: the record envelope carries `createdBy` (meta_records.created_by).
function personRow(sheetId, id, data, { createdBy = PERSON, key } = {}) {
  return {
    id,
    sheetId,
    version: 1,
    ...(createdBy === null ? {} : { createdBy }),
    data: { projectNo: PROJECT_NO, active: true, idempotencyKey: key === undefined ? `manual:v1:${id}` : key, ...data },
  }
}

// The kit's records fake (host fence included) with the given rows pushed verbatim — `createdBy` survives, because
// the fake answers clones of the whole record.
function sheetWith(sheetId, rows = []) {
  const sheet = kit.createRecordsApi({ existing: [] })
  for (const row of rows) sheet.rows.push(JSON.parse(JSON.stringify({ ...row, sheetId })))
  return sheet
}

function pullEnv(sheetId, { objectId = PROJECT_OBJECT_ID, rows = [], plmData = kit.goldenPlmData(PROJECT_NO), withStore = true, action: actionOverride } = {}) {
  const harness = kit.createLibWriteLockHarness()
  const sheet = sheetWith(sheetId, rows)
  const storage = kit.createConsumableStorage()
  // Every reminder write, with the sheet's lease state AT THAT MOMENT (read through the harness's real lock module):
  // the apply's record is written inside its write lease, a preview's outside any lease.
  const reminderWrites = []
  const storeSet = storage.set
  storage.set = async (key, value) => {
    if (key === `${LAST_PULL_KEY_PREFIX}${sheetId}`) {
      const state = await harness.lock.readState(sheetWriteScopeKey(sheetId))
      reminderWrites.push({ mode: value && value.mode, leaseHeld: state.leaseHeld, leasePurpose: state.leasePurpose || null })
    }
    return storeSet.call(storage, key, value)
  }
  const source = kit.createSourceAdapter(plmData)
  const action = actionOverride || actionFor(sheetId, objectId)
  const common = () => ({
    action,
    parameters: { projectNo: PROJECT_NO },
    sourceAdapter: source.adapter,
    recordsApi: sheet.recordsApi,
    tokenStore: storage,
    ...(withStore ? { manualRowsStore: storage } : {}),
    plannedAt: kit.GOLDEN_PLANNED_AT,
    runId: kit.GOLDEN_RUN_ID,
    now: Date.parse('2026-10-30T01:00:00.000Z'),
  })
  const dryRun = (extra = {}) => harness.wrapDryRun(tableActions.dryRunStockPreparationAction)({ ...common(), ...extra })
  const apply = (token, extra = {}) => harness.wrapApply(tableActions.applyStockPreparationAction)({
    ...common(), dryRunToken: token, permission: 'write', sandboxPolicy: SANDBOX, ...extra,
  })
  const lastPull = () => (storage.map.has(`${LAST_PULL_KEY_PREFIX}${sheetId}`) ? kit.clone(storage.map.get(`${LAST_PULL_KEY_PREFIX}${sheetId}`)) : null)
  const rowOf = (id) => sheet.rows.find((row) => row.id === id)
  const writesTo = (id) => sheet.writes().filter(([method, input]) => method === 'patchRecord' && input.recordId === id)
  return { harness, sheet, storage, source, action, dryRun, apply, lastPull, rowOf, writesTo, reminderWrites }
}

// A response with its two run-varying values masked: the random token and the read phase's wall time.
const sansToken = (response) => {
  const { dryRunToken, plmReadPhase, ...rest } = response
  return {
    ...rest,
    dryRunToken: typeof dryRunToken === 'string' ? '<token>' : dryRunToken,
    ...(plmReadPhase ? { plmReadPhase: { ...plmReadPhase, wallMs: '<wall>' } } : {}),
  }
}

// ── MP-01 / MP-02: the reader ────────────────────────────────────────────────────────────────────────────

// A host-shaped records API over sorted envelopes (ORDER BY id ASC, like query-service), counting pages.
function pagedRecords(records) {
  const calls = []
  return {
    calls,
    api: {
      async queryRecords(input = {}) {
        calls.push({ limit: input.limit, offset: input.offset })
        return records
          .filter((record) => Object.entries(input.filters || {}).every(([field, value]) => record.data[field] === value))
          .slice().sort((left, right) => (left.id < right.id ? -1 : 1))
          .slice(input.offset || 0, (input.offset || 0) + (input.limit || 1000))
          .map((record) => JSON.parse(JSON.stringify(record)))
      },
    },
  }
}

const plmRecord = (id, component) => ({ id, version: 1, data: { projectNo: PROJECT_NO, active: true, componentCode: component, idempotencyKey: JSON.stringify({ projectNo: PROJECT_NO, componentSourceId: component, parentSourceId: null, path: [component] }) } })
const target = (objectId = PROJECT_OBJECT_ID) => ({ sheetId: 'sheet_mr_read', objectId, fieldIdMap: {} })

test('MP-01 the RAW page decides the last page and the page bound: limit 2, the manual row on page 1 — every PLM row comes back', async () => {
  const records = [
    personRow('sheet_mr_read', 'rec_a_manual', { componentCode: 'SYN-M' }),
    plmRecord('rec_b_plm', 'SYN-B'),
    plmRecord('rec_c_plm', 'SYN-C'),
    plmRecord('rec_d_plm', 'SYN-D'),
  ]
  const host = pagedRecords(records)
  const rows = await readExistingStockPreparationRows(host.api, target(), PROJECT_NO, { limit: 2 })
  assert.deepEqual(rows.map((row) => row.componentCode), ['SYN-B', 'SYN-C', 'SYN-D'], 'every PLM row, including those behind the page that held the manual row')
  assert.deepEqual(host.calls, [{ limit: 2, offset: 0 }, { limit: 2, offset: 2 }, { limit: 2, offset: 4 }], 'pages walked by raw length')
  const prefix = manualPrefixRowsOf(rows)
  assert.equal(prefix.manualRows.length, 1)
  assert.equal(prefix.manualRows[0].recordId, 'rec_a_manual')
  assert.equal(prefix.unboundKeyCount, 0)
  // A page holding ONLY prefix rows is still a full page: it counts against maxPages, and the read goes on.
  const onlyPrefix = pagedRecords([
    personRow('sheet_mr_read', 'rec_a_m1', { componentCode: 'SYN-M1' }),
    personRow('sheet_mr_read', 'rec_a_m2', { componentCode: 'SYN-M2' }),
    plmRecord('rec_b_plm', 'SYN-B'),
  ])
  const after = await readExistingStockPreparationRows(onlyPrefix.api, target(), PROJECT_NO, { limit: 2, maxPages: 2 })
  assert.deepEqual(after.map((row) => row.componentCode), ['SYN-B'])
  assert.equal(manualPrefixRowsOf(after).manualRows.length, 2)
  // ... and at the bound the read refuses exactly as before (never plans off a partial set).
  const full = pagedRecords([
    personRow('sheet_mr_read', 'rec_a_m1', { componentCode: 'SYN-M1' }),
    personRow('sheet_mr_read', 'rec_a_m2', { componentCode: 'SYN-M2' }),
    plmRecord('rec_b_plm', 'SYN-B'),
    plmRecord('rec_c_plm', 'SYN-C'),
  ])
  await assert.rejects(
    () => readExistingStockPreparationRows(full.api, target(), PROJECT_NO, { limit: 2, maxPages: 2 }),
    (error) => error.code === 'TABLE_ACTION_EXISTING_ROWS_TOO_LARGE' && error.details.maxPages === 2,
  )
})

test('MP-02 no prefix row => the pre-B1 read exactly; a prefix row rides the non-enumerable array Symbol; a cell cannot forge M′', async () => {
  const plain = [plmRecord('rec_b_plm', 'SYN-B'), { ...plmRecord('rec_c_plm', 'SYN-C'), createdBy: PERSON }]
  const rows = await readExistingStockPreparationRows(pagedRecords(plain).api, target(), PROJECT_NO)
  // The pre-B1 projection, row by row: unmap (string keys AND the createdBy Symbol) + the record reference.
  const expected = plain.map((record) => unmapRecordFields(JSON.parse(JSON.stringify(record)), {}))
  assert.equal(rows.length, expected.length)
  for (let i = 0; i < rows.length; i += 1) {
    assert.deepEqual(Object.keys(rows[i]), Object.keys(expected[i]), `row ${i}: same keys, same order`)
    assert.equal(JSON.stringify(rows[i]), JSON.stringify(expected[i]), `row ${i}: same cells`)
    assert.equal(rows[i][EXISTING_ROW_CREATED_BY], expected[i][EXISTING_ROW_CREATED_BY], `row ${i}: same creator Symbol`)
    assert.deepEqual(Object.getOwnPropertySymbols(rows[i]).sort((a, b) => String(a) < String(b) ? -1 : 1),
      [...Object.getOwnPropertySymbols(expected[i]), EXISTING_ROW_RECORD_REF].sort((a, b) => String(a) < String(b) ? -1 : 1), `row ${i}: exactly the pre-B1 Symbols`)
  }
  assert.deepEqual(rows.map((row) => row[EXISTING_ROW_RECORD_REF]), [{ id: 'rec_b_plm', version: 1 }, { id: 'rec_c_plm', version: 1 }])
  assert.equal(rows[1][EXISTING_ROW_CREATED_BY], PERSON, 'GOV-05 still rides')
  assert.deepEqual(Object.getOwnPropertySymbols(rows), [], 'no array Symbol without a prefix row')

  const forged = [
    // A `data.id` cell naming the key's id, and a `data.createdBy` cell: neither is the envelope.
    { id: 'rec_e_real', version: 1, data: { projectNo: PROJECT_NO, active: true, id: 'rec_forged', createdBy: PERSON, idempotencyKey: 'manual:v1:rec_forged' } },
    { id: 'rec_f_real', version: 1, data: { projectNo: PROJECT_NO, active: true, createdBy: PERSON, idempotencyKey: 'manual:v1:rec_f_real' } },
    plmRecord('rec_b_plm', 'SYN-B'),
  ]
  const read = await readExistingStockPreparationRows(pagedRecords(forged).api, target(), PROJECT_NO)
  assert.deepEqual(read.map((row) => row.componentCode), ['SYN-B'], 'both prefix rows out of planning')
  const prefix = manualPrefixRowsOf(read)
  assert.equal(prefix.manualRows.length, 0, 'neither satisfies M′ (envelope only)')
  assert.equal(prefix.unboundKeyCount, 2)
  assert.deepEqual([...prefix.unboundRecordIds].sort(), ['rec_e_real', 'rec_f_real'])
  assert.equal(Object.getOwnPropertyDescriptor(read, EXISTING_ROWS_MANUAL_PREFIX).enumerable, false)
  assert.equal(JSON.stringify(read).includes('manual:'), false, 'the array JSON carries no prefix row')
})

// ── MP-03 .. MP-07: the pull, end to end through the lib with the lock + governance the routes use ──────

test('MP-03 the manual row end to end: not planned, not hashed, reported, never written; reminder persisted per pull', async () => {
  const manual = personRow('sheet_mr_p3', 'rec_mr_p3', { componentCode: 'SWL-B-001', componentName: '人工补充件', totalQuantity: 5 })
  const env = pullEnv('sheet_mr_p3', { rows: [manual] })
  const control = pullEnv('sheet_mr_p3', { rows: [] })
  const preview = await env.dryRun()
  const controlPreview = await control.dryRun()
  assert.equal(preview.status, 'ready', JSON.stringify(preview.evidence))
  assert.deepEqual(preview.counts, { add: 2, update: 0, skip: 0, inactive: 0, manual_confirm: 0 }, 'no INACTIVE, no hold for the manual row')
  // Not in the plan, not hashed: the revision, the counts and the evidence are the manual-free sheet's.
  assert.equal(preview.revision, controlPreview.revision)
  assert.deepEqual(preview.counts, controlPreview.counts)
  assert.deepEqual(preview.evidence, controlPreview.evidence)
  const token = env.storage.map.get(`integration:table-action:dry-run-token:${preview.dryRunToken}`)
  assert.equal(token.revision, controlPreview.revision, 'the token promises the manual-free revision')
  assert.equal(JSON.stringify(token).includes('manual'), false)
  assert.deepEqual(preview.manualSupplement, {
    rowCount: 1, unboundKeyCount: 0, matchedManualCount: 1, matchedManualRecordIds: ['rec_mr_p3'], unboundRecordIds: [],
  })
  assert.equal(Object.prototype.hasOwnProperty.call(controlPreview, 'manualSupplement'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(preview.evidence, 'manualSupplement'), false, 'never inside evidence')
  assert.deepEqual(env.lastPull(), {
    at: '2026-10-30T01:00:00.000Z', mode: 'dry_run', rowCount: 1, unboundKeyCount: 0, matchedManualCount: 1, matchedManualRecordIds: ['rec_mr_p3'], unboundRecordIds: [],
  })
  assert.equal(control.lastPull(), null, 'a manual-free sheet never gets a record')

  const before = kit.clone(env.rowOf('rec_mr_p3'))
  const applied = await env.apply(preview.dryRunToken)
  assert.equal(applied.status, 'succeeded', JSON.stringify(applied.apply))
  assert.deepEqual(applied.apply.counts, { created: 2, updated: 0, inactive: 0, skipped: 0, held: 0, failed: 0 })
  assert.deepEqual(env.rowOf('rec_mr_p3'), before, 'version and data byte-identical: the pull never wrote it')
  assert.deepEqual(env.writesTo('rec_mr_p3'), [])
  assert.deepEqual(applied.manualSupplement, preview.manualSupplement)
  assert.equal(env.lastPull().mode, 'apply')
  assert.equal(env.lastPull().matchedManualCount, 1)

  // The next pull: both PLM rows exist (SKIP) — no ADD left, so no reminder; the record is overwritten, not left.
  const next = await env.dryRun({ now: Date.parse('2026-10-30T02:00:00.000Z') })
  assert.equal(next.status, 'ready')
  assert.equal(next.counts.add, 0)
  assert.equal(next.counts.inactive, 0)
  assert.deepEqual(next.manualSupplement, { rowCount: 1, unboundKeyCount: 0, matchedManualCount: 0, matchedManualRecordIds: [], unboundRecordIds: [] })
  assert.deepEqual(env.lastPull(), {
    at: '2026-10-30T02:00:00.000Z', mode: 'dry_run', rowCount: 1, unboundKeyCount: 0, matchedManualCount: 0, matchedManualRecordIds: [], unboundRecordIds: [],
  })
  // WHERE each record was written: the apply's INSIDE its write lease (the in-lease recompute's reminder, after the
  // execution is closed), each preview's outside any lease.
  assert.deepEqual(env.reminderWrites, [
    { mode: 'dry_run', leaseHeld: false, leasePurpose: null },
    { mode: 'apply', leaseHeld: true, leasePurpose: 'small_apply' },
    { mode: 'dry_run', leaseHeld: false, leasePurpose: null },
  ])
})

test('MP-04 名称 + 规格 + 材料 decide without a 图号; a COPY of an existing PLM row never reminds (it is a SKIP, not an ADD)', async () => {
  // The golden part B expands to 名称 'Synthetic', 规格 'part', 材料 'Synthetic' (IdentityName split at its first space).
  const byTriple = personRow('sheet_mr_p4', 'rec_mr_p4_triple', { componentName: ' Synthetic ', componentSpec: 'part', material: 'Synthetic', totalQuantity: 1 })
  const near = personRow('sheet_mr_p4', 'rec_mr_p4_near', { componentName: 'Synthetic', componentSpec: 'part', material: 'Other', totalQuantity: 1 })
  const env = pullEnv('sheet_mr_p4', { rows: [byTriple, near] })
  const preview = await env.dryRun()
  assert.equal(preview.status, 'ready')
  assert.deepEqual(preview.manualSupplement, {
    rowCount: 2, unboundKeyCount: 0, matchedManualCount: 1, matchedManualRecordIds: ['rec_mr_p4_triple'], unboundRecordIds: [],
  })
  const applied = await env.apply(preview.dryRunToken)
  assert.equal(applied.status, 'succeeded')
  // A person copies the (now existing) PLM row B into a manual row: same 图号 — the PLM row is a SKIP, never an ADD.
  env.sheet.rows.push(personRow('sheet_mr_p4', 'rec_mr_p4_copy', { componentCode: 'SWL-B-001', componentName: 'Synthetic', componentSpec: 'part', material: 'Synthetic', totalQuantity: 6 }))
  const after = await env.dryRun()
  assert.equal(after.counts.add, 0)
  assert.deepEqual(after.manualSupplement, { rowCount: 3, unboundKeyCount: 0, matchedManualCount: 0, matchedManualRecordIds: [], unboundRecordIds: [] })
})

test('MP-05 the three unbound prefix rows (no creator / another row\'s id / an env target): plan valid, 0 failed decisions, the row never written', async () => {
  const cases = [
    { label: 'created_by empty', sheetId: 'sheet_mr_u1', objectId: PROJECT_OBJECT_ID, row: personRow('sheet_mr_u1', 'rec_mr_u1', { componentCode: 'SYN-U1' }, { createdBy: null }) },
    { label: 'the key names another row', sheetId: 'sheet_mr_u2', objectId: PROJECT_OBJECT_ID, row: personRow('sheet_mr_u2', 'rec_mr_u2', { componentCode: 'SYN-U2' }, { key: 'manual:v1:rec_mr_someone_else' }) },
    { label: 'an env target', sheetId: 'sheet_mr_u3', objectId: ENV_OBJECT_ID, row: personRow('sheet_mr_u3', 'rec_mr_u3', { componentCode: 'SYN-U3' }) },
  ]
  for (const { label, sheetId, objectId, row } of cases) {
    const env = pullEnv(sheetId, { objectId, rows: [row] })
    const preview = await env.dryRun()
    assert.equal(preview.status, 'ready', `${label}: ${JSON.stringify(preview.evidence)}`)
    assert.equal(preview.evidence.plan.valid, true, `${label}: the plan is valid`)
    assert.deepEqual(preview.counts, { add: 2, update: 0, skip: 0, inactive: 0, manual_confirm: 0 }, `${label}: never set inactive`)
    assert.deepEqual(preview.manualSupplement, { rowCount: 0, unboundKeyCount: 1, matchedManualCount: 0, matchedManualRecordIds: [], unboundRecordIds: [row.id] }, label)
    const before = kit.clone(env.rowOf(row.id))
    const applied = await env.apply(preview.dryRunToken)
    assert.equal(applied.status, 'succeeded', `${label}: ${JSON.stringify(applied.apply)}`)
    assert.equal(applied.apply.counts.failed, 0, `${label}: 0 failed decisions`)
    assert.deepEqual(env.writesTo(row.id), [], `${label}: never written`)
    assert.deepEqual(env.rowOf(row.id), before, `${label}: byte-identical`)
    assert.equal(env.lastPull().unboundKeyCount, 1, label)
  }
})

test('MP-06 no prefix row: no stanza, no record, the response byte-identical without the store; not_found and the storeless caller persist nothing', async () => {
  const withStore = pullEnv('sheet_mr_p6')
  const without = pullEnv('sheet_mr_p6', { withStore: false })
  const a = await withStore.dryRun()
  const b = await without.dryRun()
  assert.equal(Object.prototype.hasOwnProperty.call(a, 'manualSupplement'), false)
  assert.deepEqual(sansToken(a), sansToken(b), 'the store changes nothing a manual-free response says')
  assert.equal(withStore.lastPull(), null)
  assert.equal(withStore.storage.calls.filter(([method, key]) => method === 'set' && String(key).startsWith(LAST_PULL_KEY_PREFIX)).length, 0, 'no reminder write')
  const applied = await withStore.apply(a.dryRunToken)
  assert.equal(applied.status, 'succeeded')
  assert.equal(Object.prototype.hasOwnProperty.call(applied, 'manualSupplement'), false)
  assert.equal(withStore.lastPull(), null)

  // A project the source does not know: the sheet is never read, so an earlier reminder stands untouched.
  const unknown = pullEnv('sheet_mr_p6b', { rows: [personRow('sheet_mr_p6b', 'rec_mr_p6b', { componentCode: 'SYN-X' })], plmData: kit.goldenPlmData('SYN-MR-NOT-IN-PLM') })
  const earlier = { at: '2026-10-29T00:00:00.000Z', mode: 'dry_run', rowCount: 1, unboundKeyCount: 0, matchedManualCount: 1, matchedManualRecordIds: ['rec_mr_p6b'], unboundRecordIds: [] }
  unknown.storage.map.set(`${LAST_PULL_KEY_PREFIX}sheet_mr_p6b`, kit.clone(earlier))
  const notFound = await unknown.dryRun()
  assert.equal(notFound.status, 'not_found')
  assert.deepEqual(unknown.lastPull(), earlier)

  // A direct lib caller that hands no store: the stanza is answered, nothing is persisted.
  const storeless = pullEnv('sheet_mr_p6c', { rows: [personRow('sheet_mr_p6c', 'rec_mr_p6c', { componentCode: 'SWL-A-001' })], withStore: false })
  const answered = await storeless.dryRun()
  assert.equal(answered.manualSupplement.matchedManualCount, 1)
  assert.equal(storeless.lastPull(), null)
})

test('MP-07 invariant: a manual row never carries componentSourceId — no decision names its key, and after the apply it has none', async () => {
  const manual = personRow('sheet_mr_p7', 'rec_mr_p7', { componentCode: 'SWL-A-001', componentName: '人工补充件', totalQuantity: 1 })
  const env = pullEnv('sheet_mr_p7', { rows: [manual] })
  const preview = await env.dryRun()
  const applied = await env.apply(preview.dryRunToken)
  assert.equal(applied.status, 'succeeded')
  const after = env.rowOf('rec_mr_p7')
  assert.equal(Object.prototype.hasOwnProperty.call(after.data, 'componentSourceId'), false)
  assert.equal(after.data.idempotencyKey, 'manual:v1:rec_mr_p7')
  // Every host write of the run addressed the two PLM rows; none carried a `manual:` key.
  for (const [method, input] of env.sheet.writes()) {
    const payload = method === 'createRecord' ? input.data : input.changes
    assert.equal(JSON.stringify(payload).includes('manual:'), false, `${method} never carries a manual: key`)
    if (method === 'patchRecord') assert.notEqual(input.recordId, 'rec_mr_p7')
  }
  // The carry route's component anti-forgery axis compares a claimed componentSourceId with BOTH stored rows; a manual
  // row's is blank, so no non-blank claim can equal it (the same normalization the route applies).
  const optional = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null)
  assert.notEqual(optional(after.data.componentSourceId === undefined ? null : String(after.data.componentSourceId)), optional('SWL-PART-A'))
})

// ── MP-08: the writer ───────────────────────────────────────────────────────────────────────────────────

function writerHost(seed = [], { batchCapable = false } = {}) {
  const rows = seed.map((row) => JSON.parse(JSON.stringify(row)))
  const calls = []
  return {
    rows,
    calls,
    api: {
      ...(batchCapable ? { supportsFilterValueLists: true } : {}),
      async queryRecords(input = {}) {
        calls.push(['queryRecords', JSON.parse(JSON.stringify(input))])
        return rows
          .filter((record) => Object.entries(input.filters || {}).every(([field, value]) => (Array.isArray(value) ? value.includes(record.data[field]) : record.data[field] === value)))
          .slice(input.offset || 0, (input.offset || 0) + (input.limit || 1000))
          .map((record) => JSON.parse(JSON.stringify(record)))
      },
      async createRecord(input = {}) {
        calls.push(['createRecord', JSON.parse(JSON.stringify(input))])
        const record = { id: `rec_w_new_${rows.length + 1}`, sheetId: input.sheetId, version: 1, data: { ...(input.data || {}) } }
        rows.push(record)
        return JSON.parse(JSON.stringify(record))
      },
      async patchRecord(input = {}) {
        calls.push(['patchRecord', JSON.parse(JSON.stringify(input))])
        const record = rows.find((row) => row.id === input.recordId)
        if (!record) throw Object.assign(new Error('Record not found'), { name: 'MultitableRecordNotFoundError' })
        record.data = { ...record.data, ...(input.changes || {}) }
        record.version += 1
        return JSON.parse(JSON.stringify(record))
      },
    },
  }
}

const RUN = { lastPlmRefreshRunId: 'run_mr_w', lastPlmRefreshAt: '2026-10-30T00:00:00.000Z', lastPlmConflictSummary: '{}' }
const plmKey = (component) => JSON.stringify({ projectNo: PROJECT_NO, componentSourceId: component, parentSourceId: null, path: [component] })
const addOf = (key, code) => ({ decision: DECISIONS.ADD, idempotencyKey: key, record: { idempotencyKey: key, projectNo: PROJECT_NO, componentCode: code, active: true, ...RUN, lastPlmRefreshDecision: 'add' } })

function runWriter(host, decisions) {
  return writer.applyStockPreparationPlan({
    permission: 'write',
    plan: { decisions },
    target: { sheetId: 'sheet_mr_w', objectId: PROJECT_OBJECT_ID },
    recordsApi: host.api,
  })
}

test('MP-08a an ADD with a manual: key fails APPLY_MANUAL_KEY_RESERVED alone — no lookup, no write — and the run goes on (per-row path)', async () => {
  const host = writerHost()
  const result = await runWriter(host, [addOf('manual:v1:rec_forged', 'SYN-FORGED'), addOf(plmKey('SYN-OK'), 'SYN-OK')])
  assert.equal(writer.APPLY_MANUAL_KEY_RESERVED, 'APPLY_MANUAL_KEY_RESERVED')
  assert.equal(result.status, 'partial')
  assert.deepEqual(result.counts, { created: 1, updated: 0, inactive: 0, skipped: 0, held: 0, failed: 1 })
  assert.deepEqual(result.results[0], { index: 0, decision: 'add', status: 'failed', code: 'APPLY_MANUAL_KEY_RESERVED' })
  assert.deepEqual(result.errors, [{ index: 0, decision: 'add', code: 'APPLY_MANUAL_KEY_RESERVED', operation: null, message: 'apply target row failed: APPLY_MANUAL_KEY_RESERVED' }])
  const touching = host.calls.filter(([, input]) => JSON.stringify(input).includes('manual:'))
  assert.deepEqual(touching, [], 'the refused key was never looked up and never written')
  assert.equal(writer.countAttemptedHostWrites(result), 1, 'the refusal is not a host write attempt')
  assert.equal(host.rows.length, 1)
  assert.equal(writer.summarizeApplyResultForEvidence(result).errorCodes[0], 'APPLY_MANUAL_KEY_RESERVED')
})

test('MP-08b the batch prefetch runs over the same plan (the manual: key in its list) and does not throw; the ADD is still refused', async () => {
  const host = writerHost([], { batchCapable: true })
  const result = await runWriter(host, [addOf(plmKey('SYN-OK-1'), 'SYN-OK-1'), addOf('manual:v1:rec_forged', 'SYN-FORGED'), addOf(plmKey('SYN-OK-2'), 'SYN-OK-2')])
  const listQueries = host.calls.filter(([method, input]) => method === 'queryRecords' && Object.values(input.filters || {}).some(Array.isArray))
  assert.equal(listQueries.length, 1, 'one batch prefetch')
  assert.deepEqual(Object.values(listQueries[0][1].filters)[0], [plmKey('SYN-OK-1'), 'manual:v1:rec_forged', plmKey('SYN-OK-2')], 'the prefetch keeps the shared decisionKey: the manual: key is just looked up')
  const scalarQueries = host.calls.filter(([method, input]) => method === 'queryRecords' && !Object.values(input.filters || {}).some(Array.isArray))
  assert.deepEqual(scalarQueries, [], 'the index served every lookup')
  assert.deepEqual(result.counts, { created: 2, updated: 0, inactive: 0, skipped: 0, held: 0, failed: 1 })
  assert.equal(result.results[1].code, 'APPLY_MANUAL_KEY_RESERVED')
  assert.equal(host.calls.filter(([method]) => method === 'createRecord').length, 2)
})

test('MP-08c the refusal is ADD-only: UPDATE / INACTIVE keep the shared decisionKey path (the planner never emits them for a prefix key)', async () => {
  const seed = [{ id: 'rec_mr_w_m', sheetId: 'sheet_mr_w', version: 1, data: { projectNo: PROJECT_NO, idempotencyKey: 'manual:v1:rec_mr_w_m', componentCode: 'SYN-M', active: true } }]
  const update = { decision: DECISIONS.UPDATE, idempotencyKey: 'manual:v1:rec_mr_w_m', patch: { material: 'SYN-MAT', ...RUN, lastPlmRefreshDecision: 'update' }, changedFields: ['material'], conflictSummary: { type: 'plm_system_refresh', changedFieldCount: 1 } }
  const inactive = { decision: DECISIONS.INACTIVE, idempotencyKey: 'manual:v1:rec_mr_w_m', patch: { active: false, ...RUN, lastPlmRefreshDecision: 'inactive' }, conflictSummary: { type: 'missing_from_plm' } }
  for (const [label, decision, counted] of [['update', update, 'updated'], ['inactive', inactive, 'inactive']]) {
    for (const batchCapable of [false, true]) {
      const host = writerHost(seed, { batchCapable })
      const result = await runWriter(host, [decision])
      assert.equal(result.counts.failed, 0, `${label} (batch ${batchCapable}): not refused`)
      assert.equal(result.counts[counted], 1, `${label} (batch ${batchCapable}): applied`)
      assert.equal(result.results[0].status, 'updated', `${label} (batch ${batchCapable})`)
      assert.equal(result.results[0].idempotencyKey, 'manual:v1:rec_mr_w_m')
    }
  }
  // The shared helper itself answers the key unchanged for every decision kind.
  const { decisionKey } = writer.__internals
  const targetShape = { keyField: 'idempotencyKey' }
  assert.equal(decisionKey(update, targetShape), 'manual:v1:rec_mr_w_m')
  assert.equal(decisionKey(addOf('manual:v1:rec_x', 'X'), targetShape), 'manual:v1:rec_x')
})

// ── MP-09: the R-60 boundary ────────────────────────────────────────────────────────────────────────────

test('MP-09 the settlement digest over the reader\'s rows is the same with no manual row, with one, and after editing it', async () => {
  const plm = [plmRecord('rec_b_plm', 'SYN-B'), plmRecord('rec_c_plm', 'SYN-C')]
  const manual = personRow('sheet_mr_read', 'rec_a_manual', { componentCode: 'SYN-M', totalQuantity: 3 })
  const machineFieldIds = machineBandFieldIds({ template: STOCK_PREPARATION_MAIN_TABLE_TEMPLATE })
  const digestOf = async (records) => sheetMachineDigest(await readExistingStockPreparationRows(pagedRecords(records).api, target(), PROJECT_NO), { machineFieldIds })
  const base = await digestOf(plm)
  assert.equal(await digestOf([...plm, manual]), base)
  const edited = JSON.parse(JSON.stringify(manual))
  edited.version = 2
  edited.data.componentCode = 'SYN-M-EDITED'
  edited.data.totalQuantity = 9
  assert.equal(await digestOf([...plm, edited]), base)
  // Control: a machine-column edit on a PLM row DOES move the digest (the gate is live).
  const movedPlm = JSON.parse(JSON.stringify(plm))
  movedPlm[0].version = 2
  movedPlm[0].data.componentCode = 'SYN-B-MOVED'
  assert.notEqual(await digestOf([...movedPlm, manual]), base)
})

// ── MP-10: a truncated read never persists a reminder (verification r1 MF-1) ────────────────────────────

test('MP-10 a preview over a TRUNCATED read (the small-lane cap: large_bom_bounded) leaves the reminder record alone — never created, never overwritten', async () => {
  // The manual row copies part B's 图号, and B is the SECOND expanded row — beyond maxRows 1.
  const manual = () => personRow('sheet_mr_p10', 'rec_mr_p10', { componentCode: 'SWL-B-001', componentName: '人工补充件', totalQuantity: 1 })
  const bounded = () => ({ ...kit.goldenAction({ maxRows: 1 }), target: { sheetId: 'sheet_mr_p10', objectId: PROJECT_OBJECT_ID } })
  // Control: the COMPLETE read matches it — the truth is 1.
  const complete = pullEnv('sheet_mr_p10', { rows: [manual()] })
  const truth = await complete.dryRun()
  assert.equal(truth.status, 'ready')
  assert.equal(truth.manualSupplement.matchedManualCount, 1)
  assert.equal(complete.lastPull().matchedManualCount, 1)
  // (a) No record yet: the bounded preview creates none (its ADD set is partial, so its "0 matched" would be false).
  const fresh = pullEnv('sheet_mr_p10', { rows: [manual()], action: bounded() })
  const a = await fresh.dryRun()
  assert.equal(a.status, 'large_bom_bounded', JSON.stringify(a.evidence && a.evidence.expansion))
  assert.equal(a.manualSupplement.rowCount, 1, 'the sheet read itself is complete')
  assert.equal(fresh.lastPull(), null, 'no record created')
  assert.deepEqual(fresh.reminderWrites, [])
  // (b) An existing record (a true reminder) is byte-identical after the bounded preview.
  const kept = pullEnv('sheet_mr_p10', { rows: [manual()], action: bounded() })
  const earlier = { at: '2026-10-29T00:00:00.000Z', mode: 'dry_run', rowCount: 1, unboundKeyCount: 0, matchedManualCount: 1, matchedManualRecordIds: ['rec_mr_p10'], unboundRecordIds: [] }
  kept.storage.map.set(`${LAST_PULL_KEY_PREFIX}sheet_mr_p10`, kit.clone(earlier))
  const before = JSON.stringify(kept.storage.map.get(`${LAST_PULL_KEY_PREFIX}sheet_mr_p10`))
  const b = await kept.dryRun()
  assert.equal(b.status, 'large_bom_bounded')
  assert.equal(JSON.stringify(kept.storage.map.get(`${LAST_PULL_KEY_PREFIX}sheet_mr_p10`)), before, 'the true reminder survives byte-identical')
  assert.deepEqual(kept.reminderWrites, [])
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-manual-rows-pull.test.cjs', tests)
