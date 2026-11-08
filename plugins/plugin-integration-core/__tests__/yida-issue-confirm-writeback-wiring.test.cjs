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
  const listed = await reader.list({ tenantId: TENANT, ownerId: OWNER, targetRefs: [TARGET], ledgerIds: null, limit: 100 })
  assert.deepEqual(listed.map((row) => row.id), ['ledger-good'])
  assert.equal(listed[0].acknowledgedAt, ACK_AT)
  assert.deepEqual([listed[0].operationId, listed[0].rowKey, listed[0].sourceRecordDigest], ['op-syn', 'row-syn', DIGEST])
  // The batch asks the ledger by (tenant, workspace NULL, owner, target, acknowledged, create) — never another scope.
  const pages = db.calls.filter((call) => call[0] === 'select')
  assert.ok(pages.length >= 1)
  for (const call of pages) {
    assert.deepEqual(call[2], { tenant_id: TENANT, workspace_id: null, owner_id: OWNER, target_ref: TARGET, status: 'acknowledged', intent: 'create' })
  }
  // An empty target list reads nothing.
  db.calls.length = 0
  assert.deepEqual(await reader.list({ tenantId: TENANT, ownerId: OWNER, targetRefs: [], ledgerIds: null, limit: 100 }), [])
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

test('ledger reader (batch) is bounded: pages of 200, at most 2000 rows scanned per listed target', async () => {
  const { createIssueConfirmLedgerReader, ISSUE_CONFIRM_LEDGER_SCAN_CAP } = await portsPromise
  assert.equal(ISSUE_CONFIRM_LEDGER_SCAN_CAP, 2000)
  const rows = []
  for (let index = 0; index < 2500; index += 1) {
    rows.push(ledger({ id: `l-${String(index).padStart(5, '0')}`, created_at: `2026-03-01T00:00:${String(index).padStart(5, '0')}`,
      source_record_digest: index < 2400 ? null : DIGEST }))
  }
  const db = memoryDb({ integration_yida_delivery_ledger: rows, integration_yida_delivery_audit: [], integration_yida_issue_confirm_writeback: [] })
  const listed = await createIssueConfirmLedgerReader({ db }).list({ tenantId: TENANT, ownerId: OWNER, targetRefs: [TARGET], ledgerIds: null, limit: 100 })
  // Every scanned row was unbound: nothing returned, and the scan stopped at the cap (never the whole history).
  assert.deepEqual(listed, [])
  const pages = db.calls.filter((call) => call[0] === 'select')
  assert.equal(pages.reduce((sum, call) => sum + call[3], 0), ISSUE_CONFIRM_LEDGER_SCAN_CAP)
  assert.ok(pages.every((call) => call[3] <= 200))
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

// ── Y9a review r2 MEDIUM: the module must refuse a records-port row without `version` ────────────────────────────
// A HOST-FAITHFUL records port: queryRecords returns what the host stored; patchRecord applies `expectedVersion` ONLY
// when it is given — undefined is an unconditional write (packages/core-backend/src/multitable/records.ts patchRecord).
function hostFaithfulWorld({ withVersion }) {
  const rows = [{ id: 'rec-syn-w', version: 4, data: { idempotencyKey: KEY, projectNo: PROJECT, issueConfirmDate: null, warehouseConfirmation: 'human' } }]
  const patches = []
  const trace = []
  const deps = {
    env: { ...ON },
    runId: () => 'run-syn-w',
    ledgerReader: { async list() {
      return [{ id: 'ledger-syn-w', tenantId: TENANT, ownerId: OWNER, targetRef: TARGET, status: 'acknowledged', intent: 'create',
        sourceRecordDigest: DIGEST, acknowledgedAt: ACK_AT }]
    } },
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
    traceStore: writeback.createIssueConfirmTraceStore({ db: { async insertOneIfAbsent(_table, row) { trace.push(row); return [row] } } }),
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
