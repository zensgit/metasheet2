'use strict'

// YiDa 发料确认日期回写 — the WIRING of the Y9a core (slice Y9; design baseline v2.3 §7.3, frozen ⑦.4 plan §2.2).
// Unit level, no PostgreSQL: the ports module (ledger reader, row source, registry, sheets), the runtime-factory
// capability, the send port's unchanged closed input (the post-ACK run is the host runtime's), the import closure (the write-back can
// never reach a runner, a form transport or a token client), and the Y9a r2 MEDIUM with a HOST-FAITHFUL records port
// (an absent expectedVersion is an unconditional write, exactly packages/core-backend/src/multitable/records.ts).
// The real-PG versions (crash tests (a)/(b), selectors, flag matrix, append-only) are in
// packages/core-backend/tests/integration/stock-preparation-yida-issue-confirm-writeback-realdb.test.ts.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const { pathToFileURL } = require('node:url')

const writeback = require('../lib/yida-issue-confirm-writeback.cjs')
const writeLockModule = require('../lib/stock-preparation-project-write-lock.cjs')
const native = new Function('url', 'return import(url)')
const LIB = path.resolve(__dirname, '../lib')
const portsPromise = native(pathToFileURL(path.join(LIB, 'yida-issue-confirm-writeback-ports.mjs')).href)
const factoryPromise = native(pathToFileURL(path.join(LIB, 'yida-owner-runtime-factory.mjs')).href)
const sendPortPromise = native(pathToFileURL(path.join(LIB, 'yida-owner-send-port.mjs')).href)
const { createDb } = require('../lib/db.cjs')

const TENANT = 'tenant-syn-w'
const OWNER = 'owner-syn-w'
const TARGET = '2f2e2d2c-2b2a-4928-8726-252423222120'
const OTHER_TARGET = '3f3e3d3c-3b3a-4938-8736-353433323130'
const SHEET = 'sheet_syn_wiring'
const KEY = 'syn-line-w-1'
const PROJECT = 'SYN-PROJECT-W'
const ACK_AT = '2026-03-01T16:30:00.000Z'
const ACK_DAY = '2026-03-02'
const DIGEST = 'a'.repeat(64)
const CONFIG = Object.freeze({
  version: 2, kind: 'yida-form-protocol-static', intent: 'create', businessKey: ['idempotencyKey', 'projectNo'],
  fieldMap: [
    { source: 'idempotencyKey', target: 'sourceLineId', type: 'string', required: true },
    { source: 'projectNo', target: 'project', type: 'string', required: true },
  ],
})
const ON = Object.freeze({
  INTEGRATION_YIDA_ISSUE_CONFIRM_WRITEBACK_ENABLED: 'true',
  INTEGRATION_YIDA_ISSUE_CONFIRM_TARGET_REFS: TARGET,
  MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED: 'true',
})

// ── an in-memory plugin db with the createDb surface the ports use (equality / IS NULL where, orderBy, limit/offset)
function memoryDb(tables) {
  const calls = []
  const match = (row, where = {}) => Object.entries(where).every(([key, value]) => (value === null || value === undefined)
    ? row[key] === null || row[key] === undefined : row[key] === value)
  const db = {
    calls,
    async select(table, { where, orderBy, limit = 1000, offset = 0 } = {}) {
      calls.push(['select', table, where, limit, offset])
      let rows = (tables[table] || []).filter((row) => match(row, where))
      if (orderBy) {
        const [column, dir] = orderBy
        rows = [...rows].sort((a, b) => (a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0) * (dir === 'DESC' ? -1 : 1))
      }
      return rows.slice(offset, offset + limit).map((row) => ({ ...row }))
    },
    // createDb.selectUnmatched, faithfully: equality / IS NULL where, every notNull column present, no row of
    // `unmatched.table` whose columns equal this row's (the NOT EXISTS anti-join) — ALL before orderBy, offset and limit.
    // With `keyset`: ORDER BY (at, id), the row comparison (at, id) > (after.at, after.id), and keyset_at = the exact
    // microsecond UTC text of `at` (fixtures carry ISO text; fewer than six fraction digits are padded, like PG renders).
    async selectUnmatched(table, { where, notNull = [], unmatched, orderBy, limit = 1000, offset = 0, keyset } = {}) {
      calls.push(['selectUnmatched', table, where, notNull, unmatched, limit, offset, keyset])
      const others = tables[unmatched.table] || []
      const pairs = Object.entries(unmatched.on)
      let rows = (tables[table] || []).filter((row) => match(row, where)
        && notNull.every((column) => row[column] !== null && row[column] !== undefined)
        && !others.some((other) => pairs.every(([innerColumn, outerColumn]) => other[innerColumn] === row[outerColumn])))
      if (keyset) {
        const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
        rows = rows.map((row) => ({ ...row, keyset_at: usText(row[keyset.at]) }))
          .sort((a, b) => cmp(a.keyset_at, b.keyset_at) || cmp(a[keyset.id], b[keyset.id]))
        if (keyset.after) {
          rows = rows.filter((row) => cmp(row.keyset_at, keyset.after.at) > 0
            || (row.keyset_at === keyset.after.at && cmp(row[keyset.id], keyset.after.id) > 0))
        }
      } else if (orderBy) {
        const [column, dir] = orderBy
        rows = [...rows].sort((a, b) => (a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0) * (dir === 'DESC' ? -1 : 1))
      }
      return rows.slice(offset, offset + limit).map((row) => ({ ...row }))
    },
    async selectOne(table, where) {
      calls.push(['selectOne', table, where])
      const row = (tables[table] || []).find((entry) => match(entry, where))
      return row ? { ...row } : null
    },
    async insertOneIfAbsent(table, row) {
      calls.push(['insertOneIfAbsent', table])
      tables[table] = tables[table] || []
      if (tables[table].some((entry) => entry.ledger_id === row.ledger_id)) return []
      tables[table].push({ ...row })
      return [{ ...row }]
    },
    async transaction() { throw new Error('MEMORY_DB_NO_TRANSACTION') },
  }
  return db
}
function usText(value) {
  const text = value instanceof Date ? value.toISOString() : String(value)
  const padded = text.replace(/\.(\d{1,6})Z$/, (_whole, digits) => `.${digits.padEnd(6, '0')}Z`)
  assert.match(padded, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/, 'memory fixture created_at')
  return padded
}
function ledger(patch = {}) {
  return { id: `ledger-${Math.random().toString(16).slice(2)}`, tenant_id: TENANT, workspace_id: null, owner_id: OWNER,
    target_ref: TARGET, status: 'acknowledged', intent: 'create', source_record_digest: DIGEST,
    operation_id: 'op-syn', row_key: 'row-syn', created_at: '2026-03-01T16:29:00.000Z', ...patch }
}

test('ledger reader (batch): only this tenant + owner, acknowledged CREATEs of a LISTED target with a bound digest, untraced; acknowledgedAt is the ACK AUDIT time', async () => {
  const { createIssueConfirmLedgerReader } = await portsPromise
  const good = ledger({ id: 'ledger-good', created_at: '2026-03-01T16:29:01.000Z' })
  const rows = [
    good,
    ledger({ id: 'ledger-traced', created_at: '2026-03-01T16:29:02.000Z' }),
    ledger({ id: 'ledger-unbound', source_record_digest: null, created_at: '2026-03-01T16:29:03.000Z' }),
    ledger({ id: 'ledger-unknown', status: 'outcome_unknown' }),
    ledger({ id: 'ledger-reconciled', status: 'reconciled_existing', source_record_digest: null }),
    ledger({ id: 'ledger-update', intent: 'update' }),
    ledger({ id: 'ledger-other-target', target_ref: OTHER_TARGET }),
    ledger({ id: 'ledger-other-owner', owner_id: 'owner-syn-x' }),
    ledger({ id: 'ledger-other-tenant', tenant_id: 'tenant-syn-x' }),
    ledger({ id: 'ledger-workspace', workspace_id: 'ws-syn' }),
  ]
  const tables = {
    integration_yida_delivery_ledger: rows,
    integration_yida_delivery_audit: [
      { ledger_id: 'ledger-good', event: 'prepare', created_at: '2026-03-01T16:29:01.000Z' },
      { ledger_id: 'ledger-good', event: 'acknowledgement', created_at: new Date(ACK_AT) },
    ],
    integration_yida_issue_confirm_writeback: [{ ledger_id: 'ledger-traced' }],
  }
  const db = memoryDb(tables)
  const reader = createIssueConfirmLedgerReader({ db })
  const page = await reader.sweep({ tenantId: TENANT, ownerId: OWNER, targetRefs: [TARGET], after: null, limit: 100 })
  assert.equal(page.next, null)
  const listed = page.rows
  assert.deepEqual(listed.map((row) => row.id), ['ledger-good'])
  assert.equal(listed[0].acknowledgedAt, ACK_AT)
  assert.deepEqual([listed[0].operationId, listed[0].rowKey, listed[0].sourceRecordDigest], ['op-syn', 'row-syn', DIGEST])
  // The batch asks the ledger by (tenant, workspace NULL, owner, target, acknowledged, create) — never another scope —
  // with the bound digest and the "not traced" anti-join IN THE QUERY (so neither unbound nor traced rows take a slot).
  const pages = db.calls.filter((call) => call[0] === 'selectUnmatched')
  assert.ok(pages.length >= 1)
  assert.deepEqual(db.calls.filter((call) => call[0] === 'select'), [])
  for (const call of pages) {
    assert.equal(call[1], 'integration_yida_delivery_ledger')
    assert.deepEqual(call[2], { tenant_id: TENANT, workspace_id: null, owner_id: OWNER, target_ref: TARGET, status: 'acknowledged', intent: 'create' })
    assert.deepEqual(call[3], ['source_record_digest'])
    assert.deepEqual(call[4], { table: 'integration_yida_issue_confirm_writeback', on: { ledger_id: 'id' } })
    assert.deepEqual(call[7], { at: 'created_at', id: 'id' })
  }
  // An empty target list reads nothing.
  db.calls.length = 0
  assert.deepEqual(await reader.sweep({ tenantId: TENANT, ownerId: OWNER, targetRefs: [], after: null, limit: 100 }), { rows: [], next: null })
  assert.deepEqual(db.calls, [])
  // list() is the named path only: a batch through it is refused (a batch is a sweep page).
  await assert.rejects(reader.list({ tenantId: TENANT, ownerId: OWNER, targetRefs: [TARGET], ledgerIds: null, limit: 100 }),
    (error) => error.code === 'YIDA_ISSUE_CONFIRM_UNAVAILABLE')
  assert.deepEqual(db.calls, [])
})

test('ledger reader (named): the named rows of THIS scope only, untraced, any state; the ack audit is read only for a row the first three selector conditions admit', async () => {
  const { createIssueConfirmLedgerReader } = await portsPromise
  const tables = {
    integration_yida_delivery_ledger: [ledger({ id: 'l-ack' }), ledger({ id: 'l-unknown', status: 'outcome_unknown' }),
      ledger({ id: 'l-unbound', source_record_digest: null }), ledger({ id: 'l-foreign', owner_id: 'owner-syn-x' }), ledger({ id: 'l-traced' })],
    integration_yida_delivery_audit: [{ ledger_id: 'l-ack', event: 'acknowledgement', created_at: ACK_AT },
      { ledger_id: 'l-unbound', event: 'acknowledgement', created_at: ACK_AT }],
    integration_yida_issue_confirm_writeback: [{ ledger_id: 'l-traced' }],
  }
  const db = memoryDb(tables)
  const reader = createIssueConfirmLedgerReader({ db })
  const rows = await reader.list({ tenantId: TENANT, ownerId: OWNER, targetRefs: [TARGET],
    ledgerIds: ['l-ack', 'l-unknown', 'l-unbound', 'l-foreign', 'l-traced', 'l-missing'], limit: 100 })
  assert.deepEqual(rows.map((row) => [row.id, row.status, row.acknowledgedAt]), [
    ['l-ack', 'acknowledged', ACK_AT], ['l-unknown', 'outcome_unknown', null], ['l-unbound', 'acknowledged', ACK_AT]])
  const auditReads = db.calls.filter((call) => call[1] === 'integration_yida_delivery_audit').map((call) => call[2].ledger_id)
  assert.deepEqual(auditReads, ['l-ack', 'l-unbound'])
  // limit bounds the named list as well.
  assert.equal((await reader.list({ tenantId: TENANT, ownerId: OWNER, targetRefs: [TARGET], ledgerIds: ['l-ack', 'l-unknown'], limit: 1 })).length, 1)
})

// The recovery scan's progress (Codex, Y9 review): the old batch read the oldest 2000 rows of a target from offset 0 on
// EVERY run and only then dropped traced / unbound ones, so once those 2000 were traced (or unbound) no later pending
// row was ever returned. The filter is now in the query: only candidates take a slot, and one run reaches the next one.
const TRACE_TABLE = 'integration_yida_issue_confirm_writeback'
function history(count, patch = () => ({})) {
  const rows = []
  for (let index = 0; index < count; index += 1) {
    rows.push(ledger({ id: `l-${String(index).padStart(5, '0')}`, created_at: `2026-03-01T00:00:00.${String(index).padStart(5, '0')}Z`, ...patch(index) }))
  }
  return rows
}
const tracedOf = (rows) => rows.map((row) => ({ ledger_id: row.id, tenant_id: row.tenant_id, owner_id: row.owner_id, target_ref: row.target_ref }))

test('ledger reader (batch) makes progress: 2001 ACK rows, the oldest 2000 traced — ONE run returns the last row, every run', async () => {
  const { createIssueConfirmLedgerReader } = await portsPromise
  const rows = history(2001)
  const db = memoryDb({ integration_yida_delivery_ledger: rows, integration_yida_delivery_audit: [],
    [TRACE_TABLE]: tracedOf(rows.slice(0, 2000)) })
  const reader = createIssueConfirmLedgerReader({ db })
  for (let run = 0; run < 3; run += 1) {
    const page = await reader.sweep({ tenantId: TENANT, ownerId: OWNER, targetRefs: [TARGET], after: null, limit: 100 })
    assert.deepEqual([page.rows.map((row) => row.id), page.next], [['l-02000'], null], `run ${run}`)
  }
  // Bounded per run by `limit`, never by the history: no per-row trace probe, one ledger query per target (what is
  // missing of `limit` plus the one look-ahead row).
  db.calls.length = 0
  await reader.sweep({ tenantId: TENANT, ownerId: OWNER, targetRefs: [TARGET], after: null, limit: 100 })
  assert.deepEqual(db.calls.filter((call) => call[1] === TRACE_TABLE), [])
  assert.deepEqual(db.calls.filter((call) => call[0] === 'selectUnmatched').map((call) => [call[5], call[6]]), [[101, 0]])
})

test('ledger reader (batch) makes progress: 2000 unbound ACK rows then ONE bound row — the bound row is returned', async () => {
  const { createIssueConfirmLedgerReader } = await portsPromise
  const rows = history(2001, (index) => (index < 2000 ? { source_record_digest: null } : {}))
  const db = memoryDb({ integration_yida_delivery_ledger: rows, integration_yida_delivery_audit: [], [TRACE_TABLE]: [] })
  const listed = (await createIssueConfirmLedgerReader({ db }).sweep({ tenantId: TENANT, ownerId: OWNER, targetRefs: [TARGET], after: null, limit: 100 })).rows
  assert.deepEqual(listed.map((row) => [row.id, row.sourceRecordDigest]), [['l-02000', DIGEST]])
})

test('ledger reader (batch) keeps the order and the limit across a mix: listed targets in turn, oldest first, at most `limit`', async () => {
  const { createIssueConfirmLedgerReader } = await portsPromise
  const old = history(2400, (index) => (index % 7 === 3 ? { source_record_digest: null } : {}))
  const tracedRows = old.filter((row) => row.source_record_digest !== null).slice(0, 1990)
  const at = (seconds) => `2026-03-02T00:00:${String(seconds).padStart(2, '0')}.000Z`
  const rows = [
    ...old,
    // Newer rows of the first target, inserted out of order; a foreign scope and a non-candidate in between.
    ledger({ id: 'a-3', created_at: at(30) }), ledger({ id: 'a-1', created_at: at(10) }),
    ledger({ id: 'a-x-unbound', created_at: at(15), source_record_digest: null }),
    ledger({ id: 'a-x-unknown', created_at: at(16), status: 'outcome_unknown' }),
    ledger({ id: 'a-x-owner', created_at: at(17), owner_id: 'owner-syn-x' }),
    ledger({ id: 'a-2', created_at: at(20) }),
    // The second listed target.
    ledger({ id: 'b-2', target_ref: OTHER_TARGET, created_at: at(5) }), ledger({ id: 'b-1', target_ref: OTHER_TARGET, created_at: at(1) }),
  ]
  const db = memoryDb({ integration_yida_delivery_ledger: rows, integration_yida_delivery_audit: [], [TRACE_TABLE]: tracedOf(tracedRows) })
  const reader = createIssueConfirmLedgerReader({ db })
  const pendingOld = old.filter((row) => row.source_record_digest !== null).slice(1990).map((row) => row.id)
  // 2400 rows, 343 unbound (index % 7 === 3), the oldest 1990 bound ones traced: 67 pending.
  assert.equal(pendingOld.length, 2400 - 343 - 1990)
  const sweep = (targetRefs, limit, after = null) => reader.sweep({ tenantId: TENANT, ownerId: OWNER, targetRefs, after, limit })
  const all = await sweep([TARGET, OTHER_TARGET], 100)
  assert.deepEqual([all.rows.map((row) => row.id), all.next], [[...pendingOld, 'a-1', 'a-2', 'a-3', 'b-1', 'b-2'], null])
  // limit cuts inside the first target (the look-ahead row exists: next = the last row), then inside the second; the
  // second target is asked only for what the first left over, plus its look-ahead row.
  const cut = pendingOld.length + 2
  const first = await sweep([TARGET, OTHER_TARGET], cut)
  assert.deepEqual(first.rows.map((row) => row.id), [...pendingOld, 'a-1', 'a-2'])
  assert.deepEqual([first.next.targetRef, first.next.id, first.next.at], [TARGET, 'a-2', '2026-03-02T00:00:20.000000Z'])
  db.calls.length = 0
  const second = await sweep([TARGET, OTHER_TARGET], cut + 2)
  assert.deepEqual(second.rows.map((row) => row.id), [...pendingOld, 'a-1', 'a-2', 'a-3', 'b-1'])
  assert.deepEqual([second.next.targetRef, second.next.id], [OTHER_TARGET, 'b-1'])
  assert.deepEqual(db.calls.filter((call) => call[0] === 'selectUnmatched').map((call) => [call[2].target_ref, call[5]]),
    [[TARGET, cut + 3], [OTHER_TARGET, 2]])
  assert.deepEqual((await sweep([OTHER_TARGET, TARGET], 3)).rows.map((row) => row.id), ['b-1', 'b-2', pendingOld[0]])
  // Following the cursors: the page after `first` starts right after a-2 on the first target.
  assert.deepEqual((await sweep([TARGET, OTHER_TARGET], 100, first.next)).rows.map((row) => row.id), ['a-3', 'b-1', 'b-2'])
  assert.deepEqual((await sweep([TARGET, OTHER_TARGET], 100, second.next)).rows.map((row) => row.id), ['b-2'])
})

test('ledger reader (named) is unchanged by the progress fix: a named row past 2000 traced ones is read directly; a named traced row is omitted', async () => {
  const { createIssueConfirmLedgerReader } = await portsPromise
  const rows = history(2001)
  const db = memoryDb({ integration_yida_delivery_ledger: rows, integration_yida_delivery_audit: [],
    [TRACE_TABLE]: tracedOf(rows.slice(0, 2000)) })
  const listed = await createIssueConfirmLedgerReader({ db }).list({ tenantId: TENANT, ownerId: OWNER, targetRefs: [TARGET],
    ledgerIds: ['l-02000', 'l-00000', 'l-01999'], limit: 100 })
  assert.deepEqual(listed.map((row) => row.id), ['l-02000'])
  // The named path is per id: selectOne on the ledger by (id + scope), then the trace probe — never a ledger page.
  assert.deepEqual(db.calls.filter((call) => call[0] === 'select' || call[0] === 'selectUnmatched'), [])
  assert.deepEqual(db.calls.filter((call) => call[1] === 'integration_yida_delivery_ledger').map((call) => call[2]), [
    { id: 'l-02000', tenant_id: TENANT, workspace_id: null, owner_id: OWNER },
    { id: 'l-00000', tenant_id: TENANT, workspace_id: null, owner_id: OWNER },
    { id: 'l-01999', tenant_id: TENANT, workspace_id: null, owner_id: OWNER },
  ])
  assert.deepEqual(db.calls.filter((call) => call[1] === TRACE_TABLE).map((call) => call[2]),
    [{ ledger_id: 'l-02000' }, { ledger_id: 'l-00000' }, { ledger_id: 'l-01999' }])
})

test('sheets port refuses a records surface without the host write fence, and binds the scoped api to the ONE registered sheet', async () => {
  const { createIssueConfirmSheets } = await portsPromise
  const project = { sheetId: SHEET, objectId: 'stock_preparation_project_00000000000000000000000000000000' }
  const records = { queryRecords: async () => [], createRecord: async () => { throw new Error('NO') }, patchRecord: async () => ({}) }
  await assert.rejects(createIssueConfirmSheets({ multitable: () => ({ records, provisioning: {} }) }).open({ tenantId: TENANT, project }),
    (error) => error.code === 'YIDA_ISSUE_CONFIRM_UNAVAILABLE')
  await assert.rejects(createIssueConfirmSheets({ multitable: () => null }).open({ tenantId: TENANT, project }),
    (error) => error.code === 'YIDA_ISSUE_CONFIRM_UNAVAILABLE')
})

test('capability: enabled() is the core exact-literal predicate; create() binds the authenticated scope and refuses a missing re-check', async () => {
  const { createIssueConfirmWritebackCapability } = await portsPromise
  const lock = { scopeKeyFor: writeLockModule.sheetWriteScopeKey, async withProjectWriteLease() { throw new Error('NO') }, async bumpGeneration() {} }
  const base = { db: memoryDb({}), security: { async encrypt() {}, async decrypt() {} }, projectTargetStore: { async get() { return null } },
    projectWriteLock: lock, multitable: () => null }
  for (const [value, expected] of [['true', true], ['TRUE', false], [' true', false], ['1', false], [undefined, false], ['false', false]]) {
    const capability = createIssueConfirmWritebackCapability({ ...base, env: { INTEGRATION_YIDA_ISSUE_CONFIRM_WRITEBACK_ENABLED: value } })
    assert.equal(capability.enabled(), expected, String(value))
  }
  const capability = createIssueConfirmWritebackCapability({ ...base, env: { ...ON } })
  assert.deepEqual(Object.keys(capability).sort(), ['create', 'enabled'])
  assert.equal(Object.isFrozen(capability), true)
  for (const input of [undefined, null, {}, { context: { tenantId: TENANT, ownerId: OWNER } }, { context: { tenantId: ' x', ownerId: OWNER }, recheck() {} },
    { context: { tenantId: TENANT }, recheck() {} }]) {
    assert.throws(() => capability.create(input), (error) => error.code === 'YIDA_ISSUE_CONFIRM_UNAVAILABLE')
  }
  const bound = capability.create({ context: { tenantId: TENANT, ownerId: OWNER }, recheck: async () => true })
  assert.deepEqual(Object.keys(bound), ['run'])
  // ON: the run forwards `after` to the core, which refuses a bad cursor (or one with ledgerIds) before any read.
  const onDb = memoryDb({})
  const on = createIssueConfirmWritebackCapability({ ...base, db: onDb, env: { ...ON } }).create({ context: { tenantId: TENANT, ownerId: OWNER }, recheck: async () => true })
  assert.deepEqual(await on.run({ after: 'not-a-cursor' }), { enabled: true, results: [], refused: 'AFTER' })
  assert.deepEqual(await on.run({ ledgerIds: ['l-1'], after: 'eyJ2IjoxfQ' }), { enabled: true, results: [], refused: 'AFTER' })
  assert.deepEqual(onDb.calls, [])
  // OFF: run() returns before any dependency is touched.
  const off = createIssueConfirmWritebackCapability({ ...base, db: memoryDb({}), env: {} })
  const offDb = off
  const result = await offDb.create({ context: { tenantId: TENANT, ownerId: OWNER }, recheck: async () => true }).run({})
  assert.deepEqual(result, { enabled: false, results: [] })
})

test('import closure: the write-back ports reach no runner, form transport, token client or token exchange (a write-back can never cause a form submission)', () => {
  const forbidden = ['yida-delivery-runner', 'yida-form-transport', 'yida-token-client', 'yida-token-exchange', 'yida-owner-send-port']
  const seen = new Set()
  const queue = [path.join(LIB, 'yida-issue-confirm-writeback-ports.mjs')]
  while (queue.length) {
    const file = queue.shift()
    if (seen.has(file)) continue
    seen.add(file)
    const text = fs.readFileSync(file, 'utf8')
    // require('…'), import … from '…', a bare side-effect import '…', and dynamic import('…').
    const specs = [...text.matchAll(/(?:require\(\s*|from\s+|import\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm)].map((match) => match[1])
    for (const spec of specs) {
      const resolved = path.resolve(path.dirname(file), spec)
      const candidates = [resolved, `${resolved}.cjs`, `${resolved}.js`, `${resolved}.mjs`, path.join(resolved, 'index.cjs')]
      const hit = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile())
      if (hit) queue.push(hit)
    }
  }
  const names = [...seen].map((file) => path.basename(file))
  assert.ok(names.includes('yida-issue-confirm-writeback.cjs'))
  assert.ok(names.includes('yida-draft-plan-store.mjs'))
  for (const name of forbidden) assert.equal(names.some((file) => file.startsWith(name)), false, `${name} must stay out of the write-back closure`)
  // The direct imports are exactly these (a new one is a reviewed change).
  const direct = [...fs.readFileSync(path.join(LIB, 'yida-issue-confirm-writeback-ports.mjs'), 'utf8').matchAll(/^import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1])
  assert.deepEqual(direct, ['node:util', './yida-issue-confirm-writeback.cjs', './stock-preparation-table-actions.cjs', './yida-draft-plan-store.mjs'])
})

test('factory: with the capability the binding gains exactly two members; without it, the original two; a write-back that cannot be bound never breaks the send port', async () => {
  const { createYidaOwnerRuntimeBinding: create } = await factoryPromise
  const db = createDb({ database: { async query() { throw new Error('NO_IO') }, async transaction() { throw new Error('NO_IO') } } })
  const security = { async encrypt() { throw new Error('NO_IO') }, async decrypt() { throw new Error('NO_IO') } }
  const plain = create({ db, security })
  assert.deepEqual(Object.keys(plain).sort(), ['createPrimitives', 'createSendPort'])
  let created = 0
  const capability = { enabled: () => true, create(input) { created += 1; assert.deepEqual(Object.keys(input).sort(), ['context', 'recheck']); return { run: async () => ({ enabled: true, results: [] }) } } }
  const binding = create({ db, security, issueConfirmWriteback: capability })
  assert.deepEqual(Object.keys(binding).sort(), ['createIssueConfirmWriteback', 'createPrimitives', 'createSendPort', 'issueConfirmWritebackEnabled'])
  assert.equal(binding.issueConfirmWritebackEnabled(), true)
  const actor = { actorId: OWNER, tenantId: TENANT, workspaceId: null }
  const bound = binding.createIssueConfirmWriteback({ context: actor, recheck: async () => true })
  assert.deepEqual(Object.keys(bound), ['run'])
  assert.deepEqual(await bound.run({}), { enabled: true, results: [] })
  for (const input of [{ context: actor }, { context: actor, recheck: 'x' }, { context: { ...actor, workspaceId: 'w' }, recheck() {} }, { context: actor, recheck() {}, extra: 1 }]) {
    assert.throws(() => binding.createIssueConfirmWriteback(input), (error) => error.code === 'YIDA_OWNER_RUNTIME_INPUT')
  }
  const send = { context: actor, authority: { async admitForExecution() {}, takeExecution() {}, async observe() {} },
    fetch: () => { throw new Error('NO_NETWORK') }, readEnablement: () => 'false', timeoutMs: 10000 }
  // D5 a (Y9 r1 M2 ruling): the post-ACK write-back is the HOST runtime's own tracked run after submit returned, so the
  // send port is the original with or without the capability — no re-check key, no hook key, for any binding.
  for (const target of [plain, binding]) {
    assert.deepEqual(Object.keys(target.createSendPort(send)).sort(), ['inspect', 'submit'])
    assert.throws(() => target.createSendPort({ ...send, issueConfirmRecheck: async () => true }), (error) => error.code === 'YIDA_OWNER_RUNTIME_INPUT')
  }
  // A capability whose create() throws: the bound write-back is refused (the host logs and leaves it to recovery);
  // the binding and its send port are unaffected.
  const broken = create({ db, security, issueConfirmWriteback: { enabled: () => { throw new Error('X') }, create() { throw new Error('BROKEN') } } })
  assert.equal(broken.issueConfirmWritebackEnabled(), false)
  assert.throws(() => broken.createIssueConfirmWriteback({ context: actor, recheck: async () => true }), (error) => error.code === 'YIDA_OWNER_RUNTIME_UNAVAILABLE')
  assert.deepEqual(Object.keys(broken.createSendPort(send)).sort(), ['inspect', 'submit'])
  assert.ok(created >= 1)
})

test('send port: no write-back member at all — the hook key is not part of its closed options (D5 a: the host runs it after submit)', async () => {
  const { createYidaOwnerSendPort } = await sendPortPromise
  const scope = { tenantId: TENANT, workspaceId: null, ownerId: OWNER, actorId: OWNER }
  const options = { db: {}, context: scope, fetch: () => { throw new Error('NO_NETWORK') }, readEnablement: () => 'true',
    authority: { async admitForExecution() {}, takeExecution() {}, async observe() {} } }
  assert.deepEqual(Object.keys(createYidaOwnerSendPort(options)).sort(), ['inspect', 'submit'])
  assert.throws(() => createYidaOwnerSendPort({ ...options, issueConfirmWriteback: { async run() {} } }), (error) => error.code === 'YIDA_OWNER_SEND_INPUT')
  // The source has no write-back reference left (the whole post-ACK path lives in the host runtime).
  const source = fs.readFileSync(path.join(LIB, 'yida-owner-send-port.mjs'), 'utf8')
  assert.equal(/issueConfirm|writeback/i.test(source), false)
})

// ── the sweep (owner recovery entry, batch mode): the real reader on the memory db + the real executor ────────────
// Every row gets its own record (key = the ledger id). A `stuck` row's row values cannot be read (retryable, no trace);
// an `ackless` row has no acknowledgement audit (skip acknowledgement_missing, no trace). Host-faithful records.
async function sweepWorld({ rows, ackless = [], stuck = [], traced = [], env = ON, targets = [TARGET] }) {
  const { createIssueConfirmLedgerReader } = await portsPromise
  const tables = {
    integration_yida_delivery_ledger: rows,
    integration_yida_delivery_audit: rows.filter((row) => !ackless.includes(row.id))
      .map((row) => ({ ledger_id: row.id, event: 'acknowledgement', created_at: new Date(ACK_AT) })),
    [TRACE_TABLE]: traced.map((id) => ({ ledger_id: id, outcome: 'project_absent' })),
  }
  const db = memoryDb(tables)
  const records = new Map(rows.map((row) => [`rec-${row.id}`, { id: `rec-${row.id}`, version: 3,
    data: { idempotencyKey: row.id, projectNo: PROJECT, issueConfirmDate: null } }]))
  const patches = []
  const runEnv = { ...env, INTEGRATION_YIDA_ISSUE_CONFIRM_TARGET_REFS: targets.join(',') }
  const executor = writeback.createIssueConfirmWritebackExecutor({
    env: runEnv,
    runId: () => 'run-syn-sweep',
    ledgerReader: createIssueConfirmLedgerReader({ db }),
    rowSource: { async read({ ledger: row }) {
      return stuck.includes(row.id) ? null : { boundSheetId: SHEET, config: CONFIG, payload: { sourceLineId: row.id, project: PROJECT } }
    } },
    projectRegistry: { async resolve() { return { sheetId: SHEET, objectId: 'obj-syn-w', status: 'active' } } },
    sheets: { async open() {
      return {
        async queryRecords({ filters }) {
          return [...records.values()].filter((record) => record.data.idempotencyKey === filters.idempotencyKey)
            .map((record) => ({ id: record.id, version: record.version, data: { ...record.data } }))
        },
        async patchRecord({ recordId, changes, expectedVersion }) {
          patches.push(recordId)
          const record = records.get(recordId)
          if (expectedVersion !== undefined && record.version !== expectedVersion) {
            const error = new Error('version conflict'); error.code = 'VERSION_CONFLICT'; throw error
          }
          Object.assign(record.data, changes); record.version += 1
          return { id: record.id, version: record.version }
        },
      }
    } },
    authority: { async recheck() { return true } },
    writeLock: {
      scopeKeyFor: writeLockModule.sheetWriteScopeKey,
      async withProjectWriteLease(scopeKey, _options, fn) {
        return fn({ async beforeWrite() {}, hostWriteFence() { return { lock: 'integration_stock_prep_project_write_lock', scopeKey, leaseId: 'l', fencingEpoch: 1, generationToken: 'g' } },
          async withHostWrite(write) { return write() }, async hostFenceRefused(error) { return error } })
      },
      async bumpGeneration() {},
    },
    traceStore: writeback.createIssueConfirmTraceStore({ db }),
  })
  const run = (input = {}) => executor.run({ tenantId: TENANT, ownerId: OWNER, ...input })
  // Follow `next` from the start until it is null (guarded); every page's results in order.
  async function sweepAll(limit) {
    const pages = []
    let after
    for (let guard = 0; guard < 500; guard += 1) {
      const page = await run({ limit, ...(after === undefined ? {} : { after }) })
      pages.push(page)
      if (page.next === null) return pages
      assert.equal(typeof page.next, 'string')
      after = page.next
    }
    throw new Error('SWEEP_DID_NOT_TERMINATE')
  }
  const ledgerCalls = () => db.calls.filter((call) => call[0] === 'selectUnmatched')
  return { tables, db, records, patches, run, sweepAll, ledgerCalls, env: runEnv }
}
const setOf = (targetRefs) => writeback.issueConfirmSweepTargetSetDigest(targetRefs)
const stamp = (index, micro = 0) => `2026-03-01T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.${String(micro).padStart(6, '0')}Z`
const idsOf = (page) => page.results.map((entry) => entry.ledgerId)

test('sweep, stuck front: `limit` rows that stay retryable or acknowledgement_missing, one good row behind — following next reaches it (and the next target)', async () => {
  const front = Array.from({ length: 100 }, (_, index) => ledger({ id: `s-${String(index).padStart(3, '0')}`, created_at: stamp(index) }))
  const good = ledger({ id: 'g-1', created_at: stamp(200) })
  const other = ledger({ id: 'g-2', target_ref: OTHER_TARGET, created_at: stamp(1) })
  const world = await sweepWorld({ rows: [...front, good, other], targets: [TARGET, OTHER_TARGET],
    stuck: front.slice(0, 50).map((row) => row.id), ackless: front.slice(50).map((row) => row.id) })
  // Without the cursor every run is the same stuck page (the documented head-of-line block of a page)...
  for (let again = 0; again < 2; again += 1) {
    const page = await world.run({})
    assert.deepEqual(idsOf(page), front.map((row) => row.id))
    assert.deepEqual(page.results.map((entry) => entry.kind === 'skip' ? entry.reason : entry.code).filter((value, index, all) => all.indexOf(value) === index),
      ['YIDA_ISSUE_CONFIRM_ROW_SOURCE_UNAVAILABLE', 'acknowledgement_missing'])
    assert.equal(typeof page.next, 'string')
  }
  assert.deepEqual(world.patches, [])
  // ...and following next reaches the rows behind it, in the same target and in the next one, in ONE page.
  const first = await world.run({})
  const second = await world.run({ after: first.next })
  assert.deepEqual(second.results.map((entry) => [entry.ledgerId, entry.outcome]), [['g-1', 'written'], ['g-2', 'written']])
  assert.equal(second.next, null)
  assert.deepEqual(world.patches, ['rec-g-1', 'rec-g-2'])
  // A retryable row gets another try only on a LATER sweep from the start: the stuck front again, then nothing.
  const pages = await world.sweepAll(100)
  assert.deepEqual(pages.map(idsOf), [front.map((row) => row.id), []])
  assert.deepEqual(world.tables[TRACE_TABLE].map((row) => row.ledger_id), ['g-1', 'g-2'])
})

test('sweep, full sweep terminates: every candidate exactly once, in (listed target, created_at, id) order, with heavy created_at ties', async () => {
  const targets = [TARGET, OTHER_TARGET, '4f4e4d4c-4b4a-4948-8746-454443424140']
  const rows = []
  for (const [t, targetRef] of targets.entries()) {
    for (let index = 0; index < 23; index += 1) {
      // Three distinct instants per target (a microsecond apart), so most rows tie on created_at; ids out of order.
      rows.push(ledger({ id: `t${t}-${String((index * 7) % 23).padStart(2, '0')}`, target_ref: targetRef, created_at: stamp(5, index % 3) }))
    }
  }
  const foreign = [ledger({ id: 't0-zz-owner', owner_id: 'owner-syn-x', created_at: stamp(5) }), ledger({ id: 't0-zz-unbound', source_record_digest: null, created_at: stamp(5) })]
  const traced = ['t1-03', 't1-04', 't2-22']
  const expected = []
  for (const targetRef of targets) {
    expected.push(...rows.filter((row) => row.target_ref === targetRef && !traced.includes(row.id))
      .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1)).map((row) => row.id))
  }
  for (const limit of [1, 2, 5, 7, 22, 23, 66, 100]) {
    const world = await sweepWorld({ rows: [...rows, ...foreign], targets, ackless: rows.map((row) => row.id), traced })
    const pages = await world.sweepAll(limit)
    const seen = pages.flatMap(idsOf)
    assert.deepEqual(seen, expected, `limit ${limit}`)
    for (const page of pages) assert.ok(page.results.length <= limit)
    // At most one ledger statement per listed target per page, and a bounded number of pages.
    assert.ok(world.ledgerCalls().length <= pages.length * targets.length, `limit ${limit}`)
    assert.ok(pages.length <= Math.ceil(expected.length / limit) + targets.length, `limit ${limit}: ${pages.length} pages`)
    assert.equal(pages[pages.length - 1].next, null)
    for (const call of world.ledgerCalls()) assert.deepEqual([call[2].tenant_id, call[2].owner_id, call[2].workspace_id], [TENANT, OWNER, null])
  }
})

test('sweep, tie-break: rows of ONE created_at (to the microsecond) are paged by id — never repeated, never skipped', async () => {
  const rows = ['e', 'a', 'd', 'b', 'c'].map((id) => ledger({ id: `tie-${id}`, created_at: stamp(9, 7) }))
  const world = await sweepWorld({ rows, ackless: rows.map((row) => row.id) })
  const pages = await world.sweepAll(2)
  assert.deepEqual(pages.map(idsOf), [['tie-a', 'tie-b'], ['tie-c', 'tie-d'], ['tie-e']])
  // The second page asked strictly after (that instant, tie-b): the keyset carries the exact text and the id.
  assert.deepEqual(world.ledgerCalls()[1][7], { at: 'created_at', id: 'id', after: { at: '2026-03-01T00:00:09.000007Z', id: 'tie-b' } })
  // One microsecond apart inside ONE millisecond: still ordered and resumed exactly (a Date round trip could not).
  const micro = [3, 1, 2].map((m) => ledger({ id: `us-${m}`, created_at: stamp(9, 500 + m) }))
  const fine = await sweepWorld({ rows: micro, ackless: micro.map((row) => row.id) })
  assert.deepEqual((await fine.sweepAll(1)).map(idsOf), [['us-1'], ['us-2'], ['us-3']])
})

test('sweep, per-target guard: a first target holding more than `limit` costs ONE ledger statement; exactly `limit` too, its cursor then moves on', async () => {
  const many = Array.from({ length: 105 }, (_, index) => ledger({ id: `m-${String(index).padStart(3, '0')}`, created_at: stamp(index) }))
  const second = ledger({ id: 'o-1', target_ref: OTHER_TARGET, created_at: stamp(0) })
  const world = await sweepWorld({ rows: [...many, second], targets: [TARGET, OTHER_TARGET], ackless: [...many, second].map((row) => row.id) })
  const page = await world.run({})
  assert.equal(page.results.length, 100)
  assert.deepEqual(world.ledgerCalls().map((call) => [call[2].target_ref, call[5]]), [[TARGET, 101]])
  // Exactly `limit` candidates in the first target: still one statement (no look-ahead into the next target); next is
  // that target's last row, and the following page is one statement on it (empty) plus one on the next target.
  const exact = many.slice(0, 100)
  const flush = await sweepWorld({ rows: [...exact, second], targets: [TARGET, OTHER_TARGET], ackless: [...exact, second].map((row) => row.id) })
  const full = await flush.run({})
  assert.equal(full.results.length, 100)
  assert.deepEqual(flush.ledgerCalls().map((call) => [call[2].target_ref, call[5]]), [[TARGET, 101]])
  assert.equal(typeof full.next, 'string')
  flush.db.calls.length = 0
  const rest = await flush.run({ after: full.next })
  assert.deepEqual([idsOf(rest), rest.next], [['o-1'], null])
  assert.deepEqual(flush.ledgerCalls().map((call) => [call[2].target_ref, call[5], Boolean(call[7].after)]), [[TARGET, 101, true], [OTHER_TARGET, 101, false]])
  // Exactly `limit` in the LAST listed target: the sweep is exhausted, next is null.
  const last = await sweepWorld({ rows: exact, ackless: exact.map((row) => row.id) })
  assert.equal((await last.run({})).next, null)
  // Exhaustion, the converse (option 1): exactly `limit` at the end of a NON-last target whose later targets are empty
  // gives a cursor (one ledger statement), then ONE empty page with next null (one statement per remaining target).
  const THIRD = '4f4e4d4c-4b4a-4948-8746-454443424140'
  const boundary = await sweepWorld({ rows: exact, targets: [TARGET, OTHER_TARGET, THIRD], ackless: exact.map((row) => row.id) })
  const filled = await boundary.run({})
  assert.deepEqual([filled.results.length, typeof filled.next], [100, 'string'])
  assert.deepEqual(boundary.ledgerCalls().map((call) => call[2].target_ref), [TARGET])
  boundary.db.calls.length = 0
  const tail = await boundary.run({ after: filled.next })
  assert.deepEqual(tail, { enabled: true, results: [], next: null })
  assert.deepEqual(boundary.ledgerCalls().map((call) => call[2].target_ref), [TARGET, OTHER_TARGET, THIRD])
})

test('sweep, exhaustion: next null means no candidate remains — at every limit, the pages up to the first null hold every candidate of every listed target', async () => {
  const targets = [TARGET, OTHER_TARGET, '4f4e4d4c-4b4a-4948-8746-454443424140', '5f5e5d5c-5b5a-4958-8756-555453525150']
  // Target sizes 4, 0, 3, 0 (empty targets in the middle and at the end), so pages fill at every kind of boundary.
  const rows = [
    ...Array.from({ length: 4 }, (_, index) => ledger({ id: `x0-${index}`, target_ref: targets[0], created_at: stamp(index) })),
    ...Array.from({ length: 3 }, (_, index) => ledger({ id: `x2-${index}`, target_ref: targets[2], created_at: stamp(index) })),
  ]
  const expected = rows.map((row) => row.id)
  for (const limit of [1, 2, 3, 4, 5, 7, 8]) {
    const world = await sweepWorld({ rows, targets, ackless: expected })
    const pages = await world.sweepAll(limit)
    assert.deepEqual(pages.flatMap(idsOf), expected, `limit ${limit}`)
    // Only the last page answers null; at most that one page is empty (the exact fill at a non-last target).
    assert.deepEqual(pages.map((page) => page.next === null), pages.map((_, index) => index === pages.length - 1), `limit ${limit}`)
    assert.ok(pages.slice(0, -1).every((page) => page.results.length === limit), `limit ${limit}: every page before the last is full`)
  }
})

test('sweep, target-set stability: a cursor issued under another listed set (added, removed — another or its own target — or reordered) is STALE before any read; a fresh sweep then answers every row once', async () => {
  const THIRD = '4f4e4d4c-4b4a-4948-8746-454443424140'
  const rows = [ledger({ id: 'a-1', created_at: stamp(1) }), ledger({ id: 'a-2', created_at: stamp(2) }),
    ledger({ id: 'b-1', target_ref: OTHER_TARGET, created_at: stamp(1) }), ledger({ id: 'c-1', target_ref: THIRD, created_at: stamp(1) })]
  for (const [name, changed] of [
    ['added', [TARGET, OTHER_TARGET, THIRD]], ['removed (another target)', [TARGET]], ['removed (its own target)', [OTHER_TARGET]],
    ['reordered', [OTHER_TARGET, TARGET]],
  ]) {
    const world = await sweepWorld({ rows, targets: [TARGET, OTHER_TARGET], ackless: rows.map((row) => row.id) })
    const first = await world.run({ limit: 1 })
    assert.deepEqual(idsOf(first), ['a-1'], name)
    world.env.INTEGRATION_YIDA_ISSUE_CONFIRM_TARGET_REFS = changed.join(',')
    world.db.calls.length = 0
    assert.deepEqual(await world.run({ limit: 1, after: first.next }), { enabled: true, results: [], refused: 'STALE' }, name)
    assert.deepEqual(world.db.calls, [], `${name}: nothing is read`)
    const expected = changed.flatMap((targetRef) => rows.filter((row) => row.target_ref === targetRef).map((row) => row.id))
    assert.deepEqual((await world.sweepAll(1)).flatMap(idsOf), expected, name)
  }
})

test('sweep, forged cursors: a listed-target cursor only moves the start (scope stays the owner\'s); an unlisted target, a foreign key or an unknown version is refused before any read', async () => {
  const mine = [ledger({ id: 'mine-1', created_at: stamp(1) }), ledger({ id: 'mine-2', created_at: stamp(3) })]
  const foreign = [ledger({ id: 'theirs-1', owner_id: 'owner-syn-x', created_at: stamp(2) }), ledger({ id: 'theirs-2', tenant_id: 'tenant-syn-x', created_at: stamp(2) })]
  const unlistedRow = ledger({ id: 'unlisted-1', target_ref: OTHER_TARGET, created_at: stamp(0) })
  const world = await sweepWorld({ rows: [...mine, ...foreign, unlistedRow], ackless: [...mine, ...foreign, unlistedRow].map((row) => row.id) })
  const cursor = (shape) => Buffer.from(JSON.stringify(shape), 'utf8').toString('base64url')
  const s = setOf([TARGET])
  // Another owner's (created_at, id), on a listed target: the page is still only this owner's rows after that point.
  const shifted = await world.run({ after: cursor({ v: 2, s, t: TARGET, c: stamp(2), i: 'theirs-1' }) })
  assert.deepEqual([idsOf(shifted), shifted.next], [['mine-2'], null])
  assert.deepEqual(world.ledgerCalls().map((call) => call[2]), [{ tenant_id: TENANT, workspace_id: null, owner_id: OWNER, target_ref: TARGET, status: 'acknowledged', intent: 'create' }])
  world.db.calls.length = 0
  for (const forged of [
    cursor({ v: 2, s, t: OTHER_TARGET, c: stamp(0), i: 'unlisted-1' }), // a target that is not listed (with the current set's digest)
    cursor({ v: 2, s, t: TARGET, c: stamp(0), i: 'mine-1', o: 'owner-syn-x' }), // a scope key
    cursor({ v: 3, s, t: TARGET, c: stamp(0), i: 'mine-1' }), // an unknown version
    cursor({ v: 1, t: TARGET, c: stamp(0), i: 'mine-1' }), // the v1 shape (no target set digest)
    cursor({ v: 2, s, t: TARGET, c: '2026-03-01T00:00:00.000Z', i: 'mine-1' }), // a millisecond time
    cursor({ v: 2, s, t: TARGET, c: '0000-01-01T00:00:00.000000Z', i: 'mine-1' }), // year 0000 (PostgreSQL has none)
  ]) {
    assert.deepEqual(await world.run({ after: forged }), { enabled: true, results: [], refused: 'AFTER' })
  }
  assert.deepEqual(await world.run({ ledgerIds: ['mine-1'], after: cursor({ v: 2, s, t: TARGET, c: stamp(0), i: 'mine-1' }) }), { enabled: true, results: [], refused: 'AFTER' })
  assert.deepEqual(world.db.calls, [])
})

test('reader limit is clamped: a non-integer or out-of-range limit is the fixed UNAVAILABLE refusal, with no statement (list and sweep)', async () => {
  const { createIssueConfirmLedgerReader } = await portsPromise
  const db = memoryDb({ integration_yida_delivery_ledger: history(5), integration_yida_delivery_audit: [], [TRACE_TABLE]: [] })
  const reader = createIssueConfirmLedgerReader({ db })
  for (const limit of [undefined, null, NaN, 0, -1, 1.5, 101, 1e9, '5', Infinity]) {
    await assert.rejects(reader.sweep({ tenantId: TENANT, ownerId: OWNER, targetRefs: [TARGET], after: null, limit }),
      (error) => error.code === 'YIDA_ISSUE_CONFIRM_UNAVAILABLE', `sweep ${String(limit)}`)
    await assert.rejects(reader.list({ tenantId: TENANT, ownerId: OWNER, targetRefs: [TARGET], ledgerIds: ['l-00000'], limit }),
      (error) => error.code === 'YIDA_ISSUE_CONFIRM_UNAVAILABLE', `list ${String(limit)}`)
  }
  assert.deepEqual(db.calls, [])
  assert.equal((await reader.sweep({ tenantId: TENANT, ownerId: OWNER, targetRefs: [TARGET], after: null, limit: 100 })).rows.length, 5)
  // A cursor on a target that is not listed is refused by the reader as well (the executor refuses it first).
  db.calls.length = 0
  await assert.rejects(reader.sweep({ tenantId: TENANT, ownerId: OWNER, targetRefs: [TARGET], limit: 5,
    after: { targetRef: OTHER_TARGET, at: '2026-03-01T00:00:00.000000Z', id: 'l-00000' } }), (error) => error.code === 'YIDA_ISSUE_CONFIRM_UNAVAILABLE')
  assert.deepEqual(db.calls, [])
})

test('a traced row is never re-patched — limit path and ledgerIds path: its cell emptied again, zero patches, version unchanged', async () => {
  const row = ledger({ id: 'done-1', created_at: stamp(1) })
  // The control first: the same world without the trace writes the row (the test can see a patch).
  const control = await sweepWorld({ rows: [row] })
  assert.deepEqual((await control.run({})).results.map((entry) => entry.outcome), ['written'])
  assert.deepEqual(control.patches, ['rec-done-1'])
  // Traced (any outcome is final) while the cell is empty: only the trace stands between the row and a patch.
  const world = await sweepWorld({ rows: [row], traced: ['done-1'] })
  const before = { ...world.records.get('rec-done-1') }
  assert.equal(before.data.issueConfirmDate, null)
  assert.deepEqual(await world.run({}), { enabled: true, results: [], next: null })
  assert.deepEqual(await world.run({ limit: 1 }), { enabled: true, results: [], next: null })
  assert.deepEqual(await world.run({ ledgerIds: ['done-1'] }), { enabled: true, results: [] })
  assert.deepEqual(world.patches, [])
  assert.equal(world.records.get('rec-done-1').version, before.version)
  assert.equal(world.records.get('rec-done-1').data.issueConfirmDate, null)
})

// ── Y9a review r2 MEDIUM: the module must refuse a records-port row without `version` ────────────────────────────
// A HOST-FAITHFUL records port: queryRecords returns what the host stored; patchRecord applies `expectedVersion` ONLY
// when it is given — undefined is an unconditional write (packages/core-backend/src/multitable/records.ts patchRecord).
function hostFaithfulWorld({ withVersion }) {
  const only = () => ({ id: 'ledger-syn-w', tenantId: TENANT, ownerId: OWNER, targetRef: TARGET, status: 'acknowledged', intent: 'create',
    sourceRecordDigest: DIGEST, acknowledgedAt: ACK_AT })
  const rows = [{ id: 'rec-syn-w', version: 4, data: { idempotencyKey: KEY, projectNo: PROJECT, issueConfirmDate: null, warehouseConfirmation: 'human' } }]
  const patches = []
  const trace = []
  const deps = {
    env: { ...ON },
    runId: () => 'run-syn-w',
    ledgerReader: {
      async list() { return [only()] },
      async sweep() { return { rows: [only()], next: null } },
    },
    rowSource: { async read() { return { boundSheetId: SHEET, config: CONFIG, payload: { sourceLineId: KEY, project: PROJECT } } } },
    projectRegistry: { async resolve() { return { sheetId: SHEET, objectId: 'obj-syn-w', status: 'active' } } },
    sheets: { async open() {
      return {
        async queryRecords({ filters }) {
          return rows.filter((row) => row.data.idempotencyKey === filters.idempotencyKey)
            .map((row) => (withVersion ? { id: row.id, version: row.version, data: { ...row.data } } : { id: row.id, data: { ...row.data } }))
        },
        async patchRecord({ recordId, changes, expectedVersion, writeFence }) {
          patches.push({ recordId, expectedVersion, fenced: Boolean(writeFence) })
          const row = rows.find((entry) => entry.id === recordId)
          if (expectedVersion !== undefined && row.version !== expectedVersion) {
            const error = new Error('version conflict'); error.code = 'VERSION_CONFLICT'; throw error
          }
          Object.assign(row.data, changes); row.version += 1
          return { id: row.id, version: row.version }
        },
      }
    } },
    authority: { async recheck() { return true } },
    writeLock: {
      scopeKeyFor: writeLockModule.sheetWriteScopeKey,
      async withProjectWriteLease(scopeKey, _options, fn) {
        return fn({ async beforeWrite() {}, hostWriteFence() { return { lock: 'integration_stock_prep_project_write_lock', scopeKey, leaseId: 'l', fencingEpoch: 1, generationToken: 'g' } },
          async withHostWrite(write) { return write() }, async hostFenceRefused(error) { return error } })
      },
      async bumpGeneration() {},
    },
    traceStore: writeback.createIssueConfirmTraceStore({ db: { async insertOneIfAbsent(_table, row) { trace.push(row); return [row] },
      async selectOne(_table, where) { return trace.find((row) => row.ledger_id === where.ledger_id) || null } } }),
  }
  return { rows, patches, trace, executor: writeback.createIssueConfirmWritebackExecutor(deps) }
}

test('Y9a r2 MEDIUM, host-faithful port: a records row WITHOUT version is refused (retryable, no patch, no trace) — never an unconditional overwrite', async () => {
  const world = hostFaithfulWorld({ withVersion: false })
  const result = await world.executor.run({ tenantId: TENANT, ownerId: OWNER })
  assert.deepEqual(result.results, [{ ledgerId: 'ledger-syn-w', kind: 'retryable', code: 'YIDA_ISSUE_CONFIRM_RECORDS_INVALID' }])
  assert.deepEqual(world.patches, [])
  assert.deepEqual(world.trace, [])
  assert.equal(world.rows[0].data.issueConfirmDate, null)
  // With the version the same port is written once, conditionally (the control).
  const control = hostFaithfulWorld({ withVersion: true })
  const written = await control.executor.run({ tenantId: TENANT, ownerId: OWNER })
  assert.deepEqual(written.results.map((entry) => [entry.outcome, entry.date]), [['written', ACK_DAY]])
  assert.deepEqual(control.patches, [{ recordId: 'rec-syn-w', expectedVersion: 4, fenced: true }])
  // Malformed versions are refused the same way.
  for (const version of [0, -1, 1.5, '4', null, Number.MAX_SAFE_INTEGER + 1]) {
    const decision = () => writeback.decideIssueConfirmWriteback({
      ledger: { id: 'l', tenantId: TENANT, ownerId: OWNER, targetRef: TARGET, status: 'acknowledged', intent: 'create', sourceRecordDigest: DIGEST, acknowledgedAt: ACK_AT },
      targetRefs: [TARGET], timeZone: 'Asia/Shanghai', projectSheetsEnabled: true,
      rowValues: { boundSheetId: SHEET, config: CONFIG, payload: { sourceLineId: KEY, project: PROJECT } },
      project: { sheetId: SHEET, objectId: 'o', status: 'active' }, authority: true,
      records: [{ id: 'rec', version, data: { idempotencyKey: KEY, projectNo: PROJECT } }],
    })
    assert.throws(decision, (error) => error.code === 'YIDA_ISSUE_CONFIRM_RECORDS_INVALID', String(version))
  }
})
