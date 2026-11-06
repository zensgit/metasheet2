'use strict'

// YiDa 发料确认日期回写 core (slice Y9a; design baseline v2.3 §7.3, frozen ⑦.4 plan §2.2 / §3).
// Module-level tests with doubles: no PostgreSQL, no multitable host, no DingTalk / YiDa. The real-PG
// versions of the crash tests (and the send-port hook, the owner route, the runtime wiring) are slice Y9.
//
// The doubles model exactly what the module relies on:
//   * the trace table: PRIMARY KEY (ledger_id) — a plain INSERT of a taken key throws 23505, the
//     ON CONFLICT DO NOTHING form returns no row;
//   * the sheet: version-conditional patch (VERSION_CONFLICT), the host fence must ride every patch;
//   * the sheet write lease: one holder per scope (a second acquire is 409 WRITE_LOCKED);
//   * the ledger + audits: read-only to the module; a "send" double flips one row to acknowledged and
//     counts the one form POST and token request it made.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')

const writeback = require('../lib/yida-issue-confirm-writeback.cjs')
const writeLockModule = require('../lib/stock-preparation-project-write-lock.cjs')

const {
  ISSUE_CONFIRM_WRITEBACK_OUTCOMES,
  createIssueConfirmTraceStore,
  createIssueConfirmWritebackExecutor,
  decideIssueConfirmWriteback,
  extractIssueConfirmRowKey,
  issueConfirmBusinessDay,
  issueConfirmWritebackEnabled,
  parseIssueConfirmTargetRefs,
  resolveIssueConfirmBusinessTimeZone,
  selectIssueConfirmCandidate,
} = writeback

const TENANT = 'tenant-syn-a'
const OWNER = 'owner-syn-a'
const TARGET = '0f0e0d0c-0b0a-4908-8706-050403020100'
const TEST_COPY_TARGET = '1f1e1d1c-1b1a-4918-8716-151413121110'
const SHEET = 'sheet_syn_registered'
const OBJECT = 'object_syn_registered'
const KEY = 'syn-line-key-0001'
const PROJECT = 'SYN-PROJECT-01'
// 2026-03-01T16:30Z is 2026-03-02 00:30 in Asia/Shanghai: the business day differs from the UTC day, and
// lies in the past, so neither "UTC" nor "now" can produce it.
const ACK_AT = '2026-03-01T16:30:00.000Z'
const ACK_DAY = '2026-03-02'
const DIGEST = 'a'.repeat(64)
const CONFIG = Object.freeze({
  version: 2,
  kind: 'yida-form-protocol-static',
  intent: 'create',
  businessKey: ['idempotencyKey', 'projectNo'],
  fieldMap: [
    { source: 'idempotencyKey', target: 'sourceLineId', type: 'string', required: true },
    { source: 'projectNo', target: 'project', type: 'string', required: true },
  ],
})
const PAYLOAD = Object.freeze({ sourceLineId: KEY, project: PROJECT })

function onEnv(extra = {}) {
  return { INTEGRATION_YIDA_ISSUE_CONFIRM_WRITEBACK_ENABLED: 'true', INTEGRATION_YIDA_ISSUE_CONFIRM_TARGET_REFS: TARGET, ...extra }
}

// ── the world of doubles ─────────────────────────────────────────────────────────────────────────

function createWorld({ env = onEnv(), authorityAllowed = true } = {}) {
  const calls = { ledgerList: 0, rowRead: 0, registry: 0, open: 0, query: 0, patch: [], authority: 0, acquire: [], bump: [], trace: 0 }
  const world = { calls, env, authorityAllowed, formPosts: 0, tokenRequests: 0 }

  // ledger + audits (read-only to the module)
  world.ledger = []
  world.audits = []
  world.rowValues = new Map()
  world.addLedger = (patch = {}) => {
    const row = {
      id: `ledger-syn-${world.ledger.length + 1}`,
      tenantId: TENANT, ownerId: OWNER, targetRef: TARGET, status: 'prepared', intent: 'create', sourceRecordDigest: DIGEST,
      ...patch,
    }
    world.ledger.push(row)
    world.audits.push({ ledgerId: row.id, event: 'prepare', createdAt: '2026-03-01T16:29:58.000Z' })
    world.rowValues.set(row.id, { boundSheetId: SHEET, config: CONFIG, payload: PAYLOAD })
    return row
  }
  // The one send of a ledger row: one token request + one form POST, then claim + acknowledgement.
  world.send = (row, { ackAt = ACK_AT } = {}) => {
    world.tokenRequests += 1
    world.formPosts += 1
    row.status = 'acknowledged'
    world.audits.push({ ledgerId: row.id, event: 'claim', createdAt: '2026-03-01T16:29:59.000Z' })
    world.audits.push({ ledgerId: row.id, event: 'acknowledgement', createdAt: ackAt })
  }

  // trace table: PRIMARY KEY (ledger_id), append-only
  world.trace = []
  world.traceGate = null
  world.traceDb = {
    async insertOne(table, row) {
      assert.equal(table, 'integration_yida_issue_confirm_writeback')
      if (world.traceGate) await world.traceGate(row)
      if (world.trace.some((existing) => existing.ledger_id === row.ledger_id)) {
        const error = new Error('duplicate key value violates unique constraint')
        error.code = '23505'
        error.constraint = 'integration_yida_issue_confirm_writeback_pkey'
        throw error
      }
      world.trace.push({ ...row })
      return [{ ...row }]
    },
    async insertOneIfAbsent(table, row, { conflictColumns } = {}) {
      assert.equal(table, 'integration_yida_issue_confirm_writeback')
      assert.deepEqual(conflictColumns, ['ledger_id'])
      if (world.traceGate) await world.traceGate(row)
      if (world.trace.some((existing) => existing.ledger_id === row.ledger_id)) return []
      world.trace.push({ ...row })
      return [{ ...row }]
    },
  }

  // the registered project sheet
  world.projects = new Map([[PROJECT, { sheetId: SHEET, objectId: OBJECT, status: 'active' }]])
  world.sheets = new Map([[SHEET, [{ id: 'rec_syn_1', version: 3, data: { idempotencyKey: KEY, projectNo: PROJECT, issueConfirmDate: null, warehouseConfirmation: 'human note' } }]]])
  world.patchFailure = null

  // the sheet write lease: one holder per scope
  world.leases = new Set()
  world.lockFailure = null
  const writeLock = {
    scopeKeyFor: writeLockModule.sheetWriteScopeKey,
    async withProjectWriteLease(scopeKey, options, fn) {
      calls.acquire.push({ scopeKey, ...options })
      if (world.lockFailure) throw world.lockFailure
      if (world.leases.has(scopeKey)) {
        throw new writeLockModule.StockPreparationProjectWriteLockError(409, 'STOCK_PREP_PROJECT_WRITE_LOCKED', 'busy', {})
      }
      world.leases.add(scopeKey)
      const guard = {
        beforeWriteCalls: 0,
        async beforeWrite() { guard.beforeWriteCalls += 1 },
        hostWriteFence() { return { lock: 'integration_stock_prep_project_write_lock', scopeKey, leaseId: 'lease-syn', fencingEpoch: 1, generationToken: 'gen-syn' } },
        async withHostWrite(write) { return write() },
        async hostFenceRefused() {
          return new writeLockModule.StockPreparationProjectWriteLockError(409, 'STOCK_PREP_PROJECT_WRITE_LEASE_LOST', 'lost', {}, { fence: true })
        },
      }
      try {
        return await fn(guard)
      } finally {
        world.leases.delete(scopeKey)
      }
    },
    async bumpGeneration(scopeKey, options) { calls.bump.push({ scopeKey, ...options }) },
  }

  world.deps = () => ({
    env: world.env,
    runId: () => 'run-syn',
    ledgerReader: {
      async list({ tenantId, ownerId, targetRefs, ledgerIds, limit }) {
        calls.ledgerList += 1
        // What the Y9 SQL reader does: this tenant + owner, untraced, and either the named rows or the
        // bounded selector (acknowledged, create, listed target, bound).
        const rows = world.ledger
          .filter((row) => row.tenantId === tenantId && row.ownerId === ownerId)
          .filter((row) => !world.trace.some((entry) => entry.ledger_id === row.id))
          .filter((row) => ledgerIds ? ledgerIds.includes(row.id)
            : row.status === 'acknowledged' && row.intent === 'create' && targetRefs.includes(row.targetRef) && row.sourceRecordDigest !== null)
          .slice(0, limit)
        return rows.map((row) => {
          const ack = world.audits.find((audit) => audit.ledgerId === row.id && audit.event === 'acknowledgement')
          return { ...row, acknowledgedAt: ack ? ack.createdAt : null }
        })
      },
    },
    rowSource: {
      async read({ ledger }) {
        calls.rowRead += 1
        return world.rowValues.has(ledger.id) ? world.rowValues.get(ledger.id) : null
      },
    },
    projectRegistry: {
      async resolve({ tenantId, projectNo }) {
        calls.registry += 1
        assert.equal(tenantId, TENANT)
        return world.projects.has(projectNo) ? { ...world.projects.get(projectNo) } : null
      },
    },
    sheets: {
      async open({ project }) {
        calls.open += 1
        const rows = world.sheets.get(project.sheetId) || []
        return {
          async queryRecords({ filters, limit, offset }) {
            calls.query += 1
            assert.equal(limit, 2)
            assert.equal(offset, 0)
            assert.deepEqual(Object.keys(filters), ['idempotencyKey'])
            return rows.filter((row) => row.data.idempotencyKey === filters.idempotencyKey).slice(0, limit)
              .map((row) => ({ id: row.id, version: row.version, data: { ...row.data } }))
          },
          async patchRecord(input) {
            calls.patch.push(input)
            if (world.patchFailure) {
              const failure = world.patchFailure
              world.patchFailure = null
              throw failure
            }
            assert.ok(input.writeFence && input.writeFence.leaseId, 'every patch is host fenced')
            const row = rows.find((entry) => entry.id === input.recordId)
            if (!row || row.version !== input.expectedVersion) {
              const conflict = new Error('version conflict')
              conflict.code = 'VERSION_CONFLICT'
              throw conflict
            }
            Object.assign(row.data, input.changes)
            row.version += 1
            if (world.afterPatch) await world.afterPatch()
            return { id: row.id, version: row.version }
          },
        }
      },
    },
    authority: {
      async recheck() {
        calls.authority += 1
        if (world.onAuthority) world.onAuthority()
        return world.authorityAllowed
      },
    },
    writeLock,
    traceStore: createIssueConfirmTraceStore({ db: world.traceDb }),
  })
  world.executor = () => createIssueConfirmWritebackExecutor(world.deps())
  world.cell = () => world.sheets.get(SHEET)[0].data.issueConfirmDate
  world.version = () => world.sheets.get(SHEET)[0].version
  world.snapshot = () => JSON.parse(JSON.stringify({ ledger: world.ledger, audits: world.audits }))
  return world
}

function sentWorld(options) {
  const world = createWorld(options)
  const row = world.addLedger()
  world.send(row)
  return { world, row }
}

function sheetReadsAndWrites(calls) {
  return { open: calls.open, query: calls.query, patch: calls.patch.length, authority: calls.authority, acquire: calls.acquire.length }
}

// ── constants and pure helpers ───────────────────────────────────────────────────────────────────

test('the outcome vocabulary is exactly the twelve baseline values', () => {
  assert.deepEqual(ISSUE_CONFIRM_WRITEBACK_OUTCOMES, [
    'written', 'already_set', 'kept_existing', 'row_absent', 'duplicate_key', 'project_absent',
    'project_archived', 'project_mismatch', 'payload_unmapped', 'sheet_mismatch', 'permission_revoked', 'source_unbound',
  ])
  assert.ok(Object.isFrozen(ISSUE_CONFIRM_WRITEBACK_OUTCOMES))
  assert.equal(writeback.ISSUE_CONFIRM_TRACE_TABLE, 'integration_yida_issue_confirm_writeback')
  assert.equal(writeback.ISSUE_CONFIRM_DATE_FIELD_ID, 'issueConfirmDate')
  assert.equal(writeback.ISSUE_CONFIRM_WRITEBACK_MAX_BATCH, 100)
})

test('the lease purpose and the generation reason are in the write lock vocabularies', () => {
  assert.equal(writeback.ISSUE_CONFIRM_WRITEBACK_LOCK_PURPOSE, 'issue_confirm_writeback')
  assert.equal(writeback.ISSUE_CONFIRM_WRITEBACK_GENERATION_REASON, 'issue_confirm_writeback')
  assert.ok(writeLockModule.PROJECT_WRITE_PURPOSES.includes(writeback.ISSUE_CONFIRM_WRITEBACK_LOCK_PURPOSE))
  assert.ok(writeLockModule.PROJECT_WRITE_GENERATION_REASONS.includes(writeback.ISSUE_CONFIRM_WRITEBACK_GENERATION_REASON))
})

test('the module never reaches a runner, a form transport, a token client or a ledger writer (import scan)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'yida-issue-confirm-writeback.cjs'), 'utf8')
  const required = [...source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
  assert.deepEqual(required, ['node:crypto'])
  assert.doesNotMatch(source, /\bimport\s*\(/)
  assert.doesNotMatch(source, /\bfetch\s*\(/)
})

test('switch matrix: only the exact literal true enables; the target list is trimmed UUIDs only', () => {
  assert.equal(issueConfirmWritebackEnabled({ INTEGRATION_YIDA_ISSUE_CONFIRM_WRITEBACK_ENABLED: 'true' }), true)
  for (const value of [undefined, '', 'false', 'TRUE', 'True', ' true', 'true ', '1', 'yes', 'on']) {
    assert.equal(issueConfirmWritebackEnabled({ INTEGRATION_YIDA_ISSUE_CONFIRM_WRITEBACK_ENABLED: value }), false, JSON.stringify(value))
  }
  assert.equal(issueConfirmWritebackEnabled(undefined), false)
  assert.deepEqual(parseIssueConfirmTargetRefs({}), [])
  assert.deepEqual(parseIssueConfirmTargetRefs({ INTEGRATION_YIDA_ISSUE_CONFIRM_TARGET_REFS: '  ' }), [])
  assert.deepEqual(parseIssueConfirmTargetRefs({ INTEGRATION_YIDA_ISSUE_CONFIRM_TARGET_REFS: ` ${TARGET} ,${TARGET},not-a-uuid,${TARGET.toUpperCase()},,${TEST_COPY_TARGET}` }),
    [TARGET, TEST_COPY_TARGET])
})

test('the business day is the acknowledgement instant in MULTITABLE_BUSINESS_TIMEZONE (default Asia/Shanghai)', () => {
  assert.equal(resolveIssueConfirmBusinessTimeZone({}), 'Asia/Shanghai')
  assert.equal(resolveIssueConfirmBusinessTimeZone({ MULTITABLE_BUSINESS_TIMEZONE: '  ' }), 'Asia/Shanghai')
  assert.equal(resolveIssueConfirmBusinessTimeZone({ MULTITABLE_BUSINESS_TIMEZONE: 'Not/AZone' }), 'Asia/Shanghai')
  assert.equal(resolveIssueConfirmBusinessTimeZone({ MULTITABLE_BUSINESS_TIMEZONE: ' Asia/Tokyo ' }), 'Asia/Tokyo')
  assert.equal(issueConfirmBusinessDay(ACK_AT, 'Asia/Shanghai'), ACK_DAY)
  assert.equal(issueConfirmBusinessDay(new Date(ACK_AT), 'Asia/Shanghai'), ACK_DAY)
  assert.equal(issueConfirmBusinessDay(ACK_AT, 'Etc/UTC'), '2026-03-01')
  assert.equal(issueConfirmBusinessDay('2026-03-01T15:59:59.999Z', 'Asia/Shanghai'), '2026-03-01')
  assert.throws(() => issueConfirmBusinessDay('not a time', 'Asia/Shanghai'), { code: 'YIDA_ISSUE_CONFIRM_INPUT' })
})

test('row key extraction uses the direct mapping entries only', () => {
  assert.deepEqual(extractIssueConfirmRowKey(CONFIG, PAYLOAD), { idempotencyKey: KEY, projectNo: PROJECT })
  const v3 = { ...CONFIG, fieldMap: CONFIG.fieldMap.map((entry) => ({ ...entry, transform: 'direct' })) }
  assert.deepEqual(extractIssueConfirmRowKey(v3, PAYLOAD), { idempotencyKey: KEY, projectNo: PROJECT })
  const copied = { ...CONFIG, fieldMap: [CONFIG.fieldMap[0], { ...CONFIG.fieldMap[1], transform: 'copy' }] }
  assert.equal(extractIssueConfirmRowKey(copied, PAYLOAD), null)
  assert.equal(extractIssueConfirmRowKey({ ...CONFIG, fieldMap: [CONFIG.fieldMap[0]] }, PAYLOAD), null)
  assert.equal(extractIssueConfirmRowKey(CONFIG, { sourceLineId: KEY, project: '' }), null)
  assert.equal(extractIssueConfirmRowKey(CONFIG, { sourceLineId: KEY, project: 7 }), null)
  const twice = { ...CONFIG, fieldMap: [...CONFIG.fieldMap, { source: 'projectNo', target: 'project2', type: 'string' }] }
  assert.equal(extractIssueConfirmRowKey(twice, { ...PAYLOAD, project2: 'SYN-OTHER' }), null)
})

// ── the selector: one counter-example per condition ──────────────────────────────────────────────

const ACKED = Object.freeze({ id: 'l1', tenantId: TENANT, ownerId: OWNER, targetRef: TARGET, status: 'acknowledged', intent: 'create', sourceRecordDigest: DIGEST, acknowledgedAt: ACK_AT })

test('selector positive control: all four conditions hold', () => {
  assert.deepEqual(selectIssueConfirmCandidate(ACKED, [TARGET]), { selected: true })
})

test('selector condition 1: every status other than acknowledged is not selected (no trace, no read, no write)', async () => {
  for (const status of ['prepared', 'dispatching', 'not_sent', 'outcome_unknown']) {
    assert.deepEqual(selectIssueConfirmCandidate({ ...ACKED, status }, [TARGET]), { selected: false, reason: 'not_acknowledged' })
    const world = createWorld()
    const row = world.addLedger({ status })
    world.audits.push({ ledgerId: row.id, event: 'acknowledgement', createdAt: ACK_AT }) // even with a (forged) ack audit
    const result = await world.executor().run({ tenantId: TENANT, ownerId: OWNER, ledgerIds: [row.id] })
    assert.deepEqual(result.results, [{ ledgerId: row.id, kind: 'skip', reason: 'not_acknowledged' }], status)
    assert.equal(world.trace.length, 0)
    assert.equal(world.calls.rowRead + world.calls.registry, 0)
    assert.deepEqual(sheetReadsAndWrites(world.calls), { open: 0, query: 0, patch: 0, authority: 0, acquire: 0 })
  }
})

test('selector condition 2: intent update is not selected', async () => {
  assert.deepEqual(selectIssueConfirmCandidate({ ...ACKED, intent: 'update' }, [TARGET]), { selected: false, reason: 'not_create' })
  const world = createWorld()
  const row = world.addLedger({ intent: 'update' })
  world.send(row)
  const result = await world.executor().run({ tenantId: TENANT, ownerId: OWNER, ledgerIds: [row.id] })
  assert.deepEqual(result.results, [{ ledgerId: row.id, kind: 'skip', reason: 'not_create' }])
  assert.equal(world.trace.length, 0)
  assert.equal(world.cell(), null)
  assert.deepEqual(sheetReadsAndWrites(world.calls), { open: 0, query: 0, patch: 0, authority: 0, acquire: 0 })
})

test('selector condition 3: a target outside the list (a test copy) is not selected; an empty list reads nothing at all', async () => {
  assert.deepEqual(selectIssueConfirmCandidate({ ...ACKED, targetRef: TEST_COPY_TARGET }, [TARGET]), { selected: false, reason: 'target_not_listed' })
  assert.deepEqual(selectIssueConfirmCandidate(ACKED, []), { selected: false, reason: 'target_not_listed' })
  const world = createWorld()
  const row = world.addLedger({ targetRef: TEST_COPY_TARGET })
  world.send(row)
  const result = await world.executor().run({ tenantId: TENANT, ownerId: OWNER, ledgerIds: [row.id] })
  assert.deepEqual(result.results, [{ ledgerId: row.id, kind: 'skip', reason: 'target_not_listed' }])
  assert.equal(world.trace.length, 0)
  assert.equal(world.cell(), null)
  assert.deepEqual(sheetReadsAndWrites(world.calls), { open: 0, query: 0, patch: 0, authority: 0, acquire: 0 })

  const empty = sentWorld({ env: onEnv({ INTEGRATION_YIDA_ISSUE_CONFIRM_TARGET_REFS: '' }) })
  assert.deepEqual(await empty.world.executor().run({ tenantId: TENANT, ownerId: OWNER }), { enabled: true, results: [] })
  assert.equal(empty.world.calls.ledgerList, 0)
  assert.equal(empty.world.trace.length, 0)
  assert.equal(empty.world.cell(), null)
})

test('selector condition 4: an unbound row (source_record_digest null) is never written; named, it is recorded source_unbound', async () => {
  assert.deepEqual(selectIssueConfirmCandidate({ ...ACKED, sourceRecordDigest: null }, [TARGET]), { selected: false, outcome: 'source_unbound' })
  const world = createWorld()
  const row = world.addLedger({ sourceRecordDigest: null })
  world.send(row)
  // The bounded batch does not even select it.
  assert.deepEqual((await world.executor().run({ tenantId: TENANT, ownerId: OWNER })).results, [])
  // Named explicitly: the decision refuses it on its own (defence in depth), records it, and patches nothing.
  const named = await world.executor().run({ tenantId: TENANT, ownerId: OWNER, ledgerIds: [row.id] })
  assert.deepEqual(named.results, [{ ledgerId: row.id, kind: 'outcome', outcome: 'source_unbound', recorded: true }])
  assert.equal(world.trace.length, 1)
  assert.equal(world.trace[0].outcome, 'source_unbound')
  assert.equal(world.calls.rowRead, 0)
  assert.equal(world.cell(), null)
  assert.deepEqual(sheetReadsAndWrites(world.calls), { open: 0, query: 0, patch: 0, authority: 0, acquire: 0 })
})

test('a missing acknowledgement audit is never written and never recorded', async () => {
  assert.deepEqual(selectIssueConfirmCandidate({ ...ACKED, acknowledgedAt: null }, [TARGET]), { selected: false, reason: 'acknowledgement_missing' })
  const world = createWorld()
  const row = world.addLedger({ status: 'acknowledged' }) // acknowledged with no acknowledgement audit row
  const result = await world.executor().run({ tenantId: TENANT, ownerId: OWNER })
  assert.deepEqual(result.results, [{ ledgerId: row.id, kind: 'skip', reason: 'acknowledgement_missing' }])
  assert.equal(world.trace.length, 0)
  assert.deepEqual(sheetReadsAndWrites(world.calls), { open: 0, query: 0, patch: 0, authority: 0, acquire: 0 })
})

// ── the switch at run time ───────────────────────────────────────────────────────────────────────

test('switch off (every non-literal value): run returns before any dependency call', async () => {
  for (const value of [undefined, '', 'false', 'TRUE', ' true', 'true ', '1', 'yes']) {
    const env = onEnv()
    if (value === undefined) delete env.INTEGRATION_YIDA_ISSUE_CONFIRM_WRITEBACK_ENABLED
    else env.INTEGRATION_YIDA_ISSUE_CONFIRM_WRITEBACK_ENABLED = value
    const { world } = sentWorld({ env })
    assert.deepEqual(await world.executor().run({ tenantId: TENANT, ownerId: OWNER }), { enabled: false, results: [] }, JSON.stringify(value))
    assert.equal(world.calls.ledgerList + world.calls.rowRead + world.calls.registry, 0)
    assert.deepEqual(sheetReadsAndWrites(world.calls), { open: 0, query: 0, patch: 0, authority: 0, acquire: 0 })
    assert.equal(world.trace.length, 0)
  }
  // Positive control: the exact literal runs.
  const { world } = sentWorld()
  const on = await world.executor().run({ tenantId: TENANT, ownerId: OWNER })
  assert.equal(on.enabled, true)
  assert.equal(on.results[0].outcome, 'written')
})

test('switch turned off mid-run: the rest of the batch stays unrecorded for a later run', async () => {
  const world = createWorld()
  const first = world.addLedger()
  world.send(first)
  const second = world.addLedger()
  world.send(second)
  world.rowValues.set(second.id, { boundSheetId: SHEET, config: CONFIG, payload: { sourceLineId: 'syn-line-key-0002', project: PROJECT } })
  world.sheets.get(SHEET).push({ id: 'rec_syn_2', version: 1, data: { idempotencyKey: 'syn-line-key-0002', projectNo: PROJECT, issueConfirmDate: null } })
  world.afterPatch = () => { world.env.INTEGRATION_YIDA_ISSUE_CONFIRM_WRITEBACK_ENABLED = 'false' }
  const result = await world.executor().run({ tenantId: TENANT, ownerId: OWNER })
  assert.deepEqual(result.results.map((entry) => [entry.ledgerId, entry.kind, entry.outcome || entry.code]),
    [[first.id, 'outcome', 'written'], [second.id, 'retryable', 'SWITCH_OFF']])
  assert.equal(result.stopped, 'SWITCH_OFF')
  assert.deepEqual(world.trace.map((entry) => entry.ledger_id), [first.id])
  assert.equal(world.sheets.get(SHEET)[1].data.issueConfirmDate, null)
  assert.equal(world.calls.patch.length, 1)
})

test('switch turned off after the records read and before the patch: no patch, no trace', async () => {
  const { world, row } = sentWorld()
  world.onAuthority = () => { world.env.INTEGRATION_YIDA_ISSUE_CONFIRM_WRITEBACK_ENABLED = 'false' }
  const result = await world.executor().run({ tenantId: TENANT, ownerId: OWNER })
  assert.deepEqual(result.results, [{ ledgerId: row.id, kind: 'retryable', code: 'SWITCH_OFF' }])
  assert.equal(world.calls.patch.length, 0)
  assert.equal(world.trace.length, 0)
  assert.equal(world.cell(), null)
})

// ── the decision table, through the executor ─────────────────────────────────────────────────────

test('written: one version-conditional, fenced patch of issueConfirmDate only, under the lease, then a bump and one trace row', async () => {
  const { world, row } = sentWorld()
  const before = world.snapshot()
  const result = await world.executor().run({ tenantId: TENANT, ownerId: OWNER })
  assert.deepEqual(result, { enabled: true, results: [{ ledgerId: row.id, kind: 'outcome', outcome: 'written', recorded: true, date: ACK_DAY, timeZone: 'Asia/Shanghai' }] })
  assert.equal(world.cell(), ACK_DAY)
  assert.equal(world.sheets.get(SHEET)[0].data.warehouseConfirmation, 'human note')
  assert.equal(world.calls.patch.length, 1)
  const patch = world.calls.patch[0]
  assert.deepEqual(Object.keys(patch).sort(), ['changes', 'expectedVersion', 'recordId', 'writeFence'])
  assert.deepEqual(patch.changes, { issueConfirmDate: ACK_DAY })
  assert.equal(patch.expectedVersion, 3)
  assert.deepEqual(world.calls.acquire, [{ scopeKey: writeLockModule.sheetWriteScopeKey(SHEET), purpose: 'issue_confirm_writeback', runId: 'run-syn', tenantId: TENANT }])
  assert.deepEqual(world.calls.bump, [{ scopeKey: writeLockModule.sheetWriteScopeKey(SHEET), reason: 'issue_confirm_writeback', tenantId: TENANT }])
  assert.deepEqual(world.trace, [{ ledger_id: row.id, tenant_id: TENANT, owner_id: OWNER, target_ref: TARGET, sheet_id: SHEET, outcome: 'written', written_date: ACK_DAY, time_zone: 'Asia/Shanghai' }])
  assert.deepEqual(world.snapshot(), before, 'ledger and audits untouched')
  // Values-free: no project number, key or human value in the result or the trace.
  for (const text of [JSON.stringify(result), JSON.stringify(world.trace)]) {
    for (const secret of [PROJECT, KEY, 'human note']) assert.equal(text.includes(secret), false)
  }
})

test('the business zone comes from MULTITABLE_BUSINESS_TIMEZONE', async () => {
  const { world } = sentWorld({ env: onEnv({ MULTITABLE_BUSINESS_TIMEZONE: 'America/Los_Angeles' }) })
  await world.executor().run({ tenantId: TENANT, ownerId: OWNER })
  assert.equal(world.cell(), '2026-03-01')
  assert.equal(world.trace[0].time_zone, 'America/Los_Angeles')
})

test('already_set and kept_existing never patch (D8: the first confirmation wins)', async () => {
  for (const [cell, outcome] of [[ACK_DAY, 'already_set'], ['2026-02-27', 'kept_existing'], ['not a date', 'kept_existing']]) {
    const { world, row } = sentWorld()
    world.sheets.get(SHEET)[0].data.issueConfirmDate = cell
    const result = await world.executor().run({ tenantId: TENANT, ownerId: OWNER })
    assert.equal(result.results[0].outcome, outcome, cell)
    assert.equal(world.calls.patch.length, 0)
    assert.equal(world.cell(), cell)
    assert.equal(world.calls.bump.length, 0)
    assert.equal(world.trace.length, 1)
    assert.equal(world.trace[0].ledger_id, row.id)
    assert.equal(world.trace[0].written_date, outcome === 'already_set' ? ACK_DAY : null)
  }
})

test('every terminal non-write outcome records one trace row and patches nothing', async () => {
  const cases = [
    ['payload_unmapped', (world, row) => world.rowValues.set(row.id, { boundSheetId: SHEET, config: CONFIG, payload: { sourceLineId: KEY } })],
    ['source_unbound', (world, row) => world.rowValues.set(row.id, null)],
    ['project_absent', (world) => world.projects.clear()],
    ['project_archived', (world) => world.projects.set(PROJECT, { sheetId: SHEET, objectId: OBJECT, status: 'archived' })],
    // SR2: the project's registration moved to another sheet after the send.
    ['sheet_mismatch', (world) => world.projects.set(PROJECT, { sheetId: 'sheet_syn_moved', objectId: OBJECT, status: 'active' })],
    // SR4: the owner's authority was revoked after acknowledged.
    ['permission_revoked', (world) => { world.authorityAllowed = false }],
    ['row_absent', (world) => world.sheets.set(SHEET, [])],
    ['duplicate_key', (world) => world.sheets.get(SHEET).push({ id: 'rec_syn_dup', version: 1, data: { idempotencyKey: KEY, projectNo: PROJECT, issueConfirmDate: null } })],
    ['project_mismatch', (world) => { world.sheets.get(SHEET)[0].data.projectNo = 'SYN-PROJECT-02' }],
  ]
  for (const [outcome, arrange] of cases) {
    const { world, row } = sentWorld()
    arrange(world, row)
    const before = world.snapshot()
    const result = await world.executor().run({ tenantId: TENANT, ownerId: OWNER })
    assert.deepEqual(result.results, [{ ledgerId: row.id, kind: 'outcome', outcome, recorded: true }], outcome)
    assert.equal(world.calls.patch.length, 0, outcome)
    assert.equal(world.calls.bump.length, 0, outcome)
    assert.equal(world.trace.length, 1, outcome)
    assert.equal(world.trace[0].outcome, outcome)
    assert.equal(world.trace[0].written_date, null)
    assert.equal(world.trace[0].time_zone, null)
    assert.deepEqual(world.snapshot(), before)
    for (const sheet of world.sheets.values()) for (const record of sheet) assert.equal(record.data.issueConfirmDate, null, outcome)
  }
})

test('the live authority re-check runs under the lease, before the sheet is read', async () => {
  const { world } = sentWorld()
  const order = []
  world.onAuthority = () => order.push(['authority', world.leases.size, world.calls.query])
  await world.executor().run({ tenantId: TENANT, ownerId: OWNER })
  assert.deepEqual(order, [['authority', 1, 0]])
  // An authority port that does not answer true / false is retryable, never permission_revoked.
  const { world: unsure, row } = sentWorld()
  unsure.authorityAllowed = undefined
  const result = await unsure.executor().run({ tenantId: TENANT, ownerId: OWNER })
  assert.deepEqual(result.results, [{ ledgerId: row.id, kind: 'retryable', code: 'YIDA_ISSUE_CONFIRM_AUTHORITY_UNAVAILABLE' }])
  assert.equal(unsure.trace.length, 0)
})

test('retryable cases insert no trace row and converge on the next run', async () => {
  const cases = [
    ['STOCK_PREP_PROJECT_WRITE_LOCKED', (world) => { world.lockFailure = new writeLockModule.StockPreparationProjectWriteLockError(409, 'STOCK_PREP_PROJECT_WRITE_LOCKED', 'busy', {}) }],
    ['STOCK_PREP_PROJECT_WRITE_LOCK_STORE_FAILED', (world) => { world.lockFailure = new writeLockModule.StockPreparationProjectWriteLockError(503, 'STOCK_PREP_PROJECT_WRITE_LOCK_STORE_FAILED', 'store', {}) }],
    ['VERSION_CONFLICT', (world) => { world.patchFailure = Object.assign(new Error('version conflict'), { code: 'VERSION_CONFLICT' }) }],
    ['STOCK_PREP_PROJECT_WRITE_LEASE_LOST', (world) => { world.patchFailure = Object.assign(new Error('fence'), { code: 'PLUGIN_WRITE_FENCE_REJECTED' }) }],
    ['UNAVAILABLE', (world) => { world.patchFailure = Object.assign(new Error('host 5xx'), { status: 503 }) }],
  ]
  for (const [code, arrange] of cases) {
    const { world, row } = sentWorld()
    arrange(world)
    const first = await world.executor().run({ tenantId: TENANT, ownerId: OWNER })
    assert.deepEqual(first.results, [{ ledgerId: row.id, kind: 'retryable', code }], code)
    assert.equal(world.trace.length, 0, code)
    assert.equal(world.cell(), null, code)
    assert.equal(world.leases.size, 0, 'the lease is released')
    world.lockFailure = null
    const next = await world.executor().run({ tenantId: TENANT, ownerId: OWNER })
    assert.equal(next.results[0].outcome, 'written', code)
    assert.equal(world.trace.length, 1)
    assert.equal(world.cell(), ACK_DAY)
  }
})

test('a ledger reader that returns a row outside the caller scope fails the run closed', async () => {
  const { world } = sentWorld()
  const other = world.addLedger({ tenantId: 'tenant-syn-b' })
  world.send(other)
  const deps = world.deps()
  const original = deps.ledgerReader.list
  deps.ledgerReader.list = async (input) => [...await original(input), { ...other, acknowledgedAt: ACK_AT }]
  await assert.rejects(() => createIssueConfirmWritebackExecutor(deps).run({ tenantId: TENANT, ownerId: OWNER }), { code: 'YIDA_ISSUE_CONFIRM_LEDGER_INVALID' })
  assert.equal(world.calls.patch.length, 0)
  assert.equal(world.trace.length, 0)
})

test('input bounds: tenant and owner required, limit and ledgerIds bounded to 100', async () => {
  const { world } = sentWorld()
  const executor = world.executor()
  for (const input of [{}, { tenantId: TENANT }, { tenantId: TENANT, ownerId: OWNER, limit: 0 }, { tenantId: TENANT, ownerId: OWNER, limit: 101 },
    { tenantId: TENANT, ownerId: OWNER, ledgerIds: [] }, { tenantId: TENANT, ownerId: OWNER, ledgerIds: Array.from({ length: 101 }, (_, i) => `l${i}`) }]) {
    await assert.rejects(() => executor.run(input), { code: 'YIDA_ISSUE_CONFIRM_INPUT' })
  }
  assert.equal(world.calls.ledgerList, 0)
  assert.throws(() => createIssueConfirmWritebackExecutor({}), { code: 'YIDA_ISSUE_CONFIRM_UNAVAILABLE' })
  assert.throws(() => createIssueConfirmTraceStore({ db: { insertOne() {} } }), { code: 'YIDA_ISSUE_CONFIRM_UNAVAILABLE' })
})

test('the pure decision asks for facts in order and never patches before the authority and records are known', () => {
  const facts = { ledger: ACKED, targetRefs: [TARGET], timeZone: 'Asia/Shanghai' }
  assert.deepEqual(decideIssueConfirmWriteback(facts), { kind: 'need', need: 'rowValues' })
  facts.rowValues = { boundSheetId: SHEET, config: CONFIG, payload: PAYLOAD }
  assert.deepEqual(decideIssueConfirmWriteback(facts), { kind: 'need', need: 'project', projectNo: PROJECT })
  facts.project = { sheetId: SHEET, objectId: OBJECT, status: 'active' }
  assert.deepEqual(decideIssueConfirmWriteback(facts), { kind: 'need', need: 'authority', sheetId: SHEET })
  facts.authority = true
  assert.deepEqual(decideIssueConfirmWriteback(facts), { kind: 'need', need: 'records', sheetId: SHEET, idempotencyKey: KEY })
  facts.records = [{ id: 'rec_syn_1', version: 3, data: { projectNo: PROJECT, issueConfirmDate: '' } }]
  const decision = decideIssueConfirmWriteback(facts)
  assert.equal(decision.kind, 'patch')
  assert.deepEqual(decision.changes, { issueConfirmDate: ACK_DAY })
  assert.throws(() => decideIssueConfirmWriteback({ ...facts, project: { sheetId: SHEET, status: 'paused' } }), { code: 'YIDA_ISSUE_CONFIRM_REGISTRY_INVALID' })
})

// ── crash recovery (a), (b) and the cross-day recovery ───────────────────────────────────────────

test('ack persisted, crash before write-back: recovery fills only the local date; ledger, audits and the single form submission are untouched', async () => {
  const { world, row } = sentWorld()
  // State after the send: acknowledged, prepare / claim / acknowledgement once each, no trace, empty cell.
  assert.equal(row.status, 'acknowledged')
  assert.deepEqual(world.audits.map((audit) => audit.event), ['prepare', 'claim', 'acknowledgement'])
  assert.equal(world.trace.length, 0)
  assert.equal(world.cell(), null)
  assert.equal(world.formPosts, 1)
  assert.equal(world.tokenRequests, 1)
  // The crash: the post-send write-back hook dies on its first call, before any IO of the executor.
  const crashingHook = async () => { throw new Error('synthetic process death before the write-back') }
  await assert.rejects(crashingHook)
  assert.equal(world.calls.ledgerList, 0)
  const before = world.snapshot()
  // Recovery: one owner recovery run.
  const recovery = await world.executor().run({ tenantId: TENANT, ownerId: OWNER })
  assert.deepEqual(recovery.results, [{ ledgerId: row.id, kind: 'outcome', outcome: 'written', recorded: true, date: ACK_DAY, timeZone: 'Asia/Shanghai' }])
  assert.equal(world.cell(), ACK_DAY)
  assert.equal(world.trace.length, 1)
  assert.equal(world.trace[0].outcome, 'written')
  assert.deepEqual(world.snapshot(), before, 'ledger and the three audits unchanged')
  assert.equal(world.formPosts, 1, 'the form POST count stays 1')
  assert.equal(world.tokenRequests, 1, 'no token request')
  // A second recovery finds nothing to do and sends nothing.
  assert.deepEqual((await world.executor().run({ tenantId: TENANT, ownerId: OWNER })).results, [])
  assert.equal(world.formPosts, 1)
  assert.equal(world.calls.patch.length, 1)
})

test('date committed, confirmation lost: a retry neither changes the date nor writes a second success record; the form submission count stays 1', async () => {
  // (b-1) The process dies after the patch committed and before the trace INSERT.
  {
    const { world, row } = sentWorld()
    const before = world.snapshot()
    let dies = true
    world.traceGate = async () => {
      if (dies) {
        dies = false
        throw new Error('synthetic process death after the patch committed')
      }
    }
    await assert.rejects(() => world.executor().run({ tenantId: TENANT, ownerId: OWNER }), /synthetic process death/)
    assert.equal(world.cell(), ACK_DAY)
    assert.equal(world.version(), 4)
    assert.equal(world.trace.length, 0)
    const retry = await world.executor().run({ tenantId: TENANT, ownerId: OWNER })
    assert.deepEqual(retry.results, [{ ledgerId: row.id, kind: 'outcome', outcome: 'already_set', recorded: true, date: ACK_DAY, timeZone: 'Asia/Shanghai' }])
    assert.equal(world.cell(), ACK_DAY)
    assert.equal(world.version(), 4, 'one patch only: the record version moved exactly once')
    assert.equal(world.calls.patch.length, 1)
    assert.equal(world.trace.length, 1)
    assert.deepEqual(world.snapshot(), before)
    assert.equal(world.formPosts, 1)
  }
  // (b-2) The first attempt's trace INSERT commits but its confirmation is lost: the owner's retry had
  // already selected the row (the first attempt was still in flight). The retry decides already_set and its
  // INSERT meets the primary key. The assertion is that the retry COMPLETES NORMALLY and exactly one row
  // exists: without ON CONFLICT DO NOTHING the retry fails with 23505.
  {
    const { world, row } = sentWorld()
    const before = world.snapshot()
    const arrived = []
    const release = []
    world.traceGate = (traceRow) => new Promise((resolve) => {
      arrived.push(traceRow.outcome)
      release.push(resolve)
    })
    const waitFor = async (count) => { while (arrived.length < count) await new Promise((resolve) => setImmediate(resolve)) }
    const firstAttempt = world.executor().run({ tenantId: TENANT, ownerId: OWNER })
    await waitFor(1)
    const retry = world.executor().run({ tenantId: TENANT, ownerId: OWNER })
    await waitFor(2)
    assert.deepEqual(arrived, ['written', 'already_set'])
    release[0]()
    const first = await firstAttempt
    release[1]()
    const second = await retry
    assert.deepEqual(first.results, [{ ledgerId: row.id, kind: 'outcome', outcome: 'written', recorded: true, date: ACK_DAY, timeZone: 'Asia/Shanghai' }])
    assert.deepEqual(second.results, [{ ledgerId: row.id, kind: 'outcome', outcome: 'already_set', recorded: false, date: ACK_DAY, timeZone: 'Asia/Shanghai' }])
    assert.equal(world.trace.length, 1)
    assert.equal(world.trace[0].outcome, 'written')
    assert.equal(world.cell(), ACK_DAY)
    assert.equal(world.version(), 4)
    assert.equal(world.calls.patch.length, 1)
    assert.deepEqual(world.snapshot(), before)
    assert.equal(world.formPosts, 1)
  }
  // (b-3) Two concurrent recovery calls on the same row: the lease admits one; the other is retryable
  // (no trace) and the next run finds nothing to do.
  {
    const { world, row } = sentWorld()
    let releaseAuthority
    const parked = new Promise((resolve) => { releaseAuthority = resolve })
    let entered = 0
    world.onAuthority = () => { entered += 1 }
    const deps = world.deps()
    const recheck = deps.authority.recheck
    deps.authority.recheck = async (input) => {
      const answer = await recheck(input)
      if (entered === 1) await parked
      return answer
    }
    const a = createIssueConfirmWritebackExecutor(deps).run({ tenantId: TENANT, ownerId: OWNER })
    while (entered < 1) await new Promise((resolve) => setImmediate(resolve))
    const b = await world.executor().run({ tenantId: TENANT, ownerId: OWNER })
    assert.deepEqual(b.results, [{ ledgerId: row.id, kind: 'retryable', code: 'STOCK_PREP_PROJECT_WRITE_LOCKED' }])
    releaseAuthority()
    assert.equal((await a).results[0].outcome, 'written')
    assert.equal(world.trace.length, 1)
    assert.equal(world.calls.patch.length, 1)
    assert.deepEqual((await world.executor().run({ tenantId: TENANT, ownerId: OWNER })).results, [])
    assert.equal(world.formPosts, 1)
  }
})

test('a cross-day recovery keeps the acknowledgement day (never the recovery day)', async () => {
  // Acknowledged at 23:50 in Shanghai on 2026-03-01; the first write-back fails; recovery runs later
  // (any later day, including today) and writes 2026-03-01.
  const world = createWorld()
  const row = world.addLedger()
  world.send(row, { ackAt: '2026-03-01T15:50:00.000Z' })
  world.patchFailure = Object.assign(new Error('host 5xx'), { status: 503 })
  assert.equal((await world.executor().run({ tenantId: TENANT, ownerId: OWNER })).results[0].kind, 'retryable')
  const realNow = Date.now
  try {
    Date.now = () => Date.parse('2026-03-02T09:00:00.000Z')
    const recovery = await world.executor().run({ tenantId: TENANT, ownerId: OWNER })
    assert.deepEqual(recovery.results, [{ ledgerId: row.id, kind: 'outcome', outcome: 'written', recorded: true, date: '2026-03-01', timeZone: 'Asia/Shanghai' }])
  } finally {
    Date.now = realNow
  }
  assert.equal(world.cell(), '2026-03-01')
  assert.equal(world.trace[0].written_date, '2026-03-01')
})

test('the trace store inserts with ON CONFLICT (ledger_id) DO NOTHING and reports whether this call recorded', async () => {
  const calls = []
  const store = createIssueConfirmTraceStore({
    db: {
      async insertOneIfAbsent(table, row, options) {
        calls.push({ table, row, options })
        return calls.length === 1 ? [row] : []
      },
    },
  })
  const row = { ledger_id: 'l1', tenant_id: TENANT, owner_id: OWNER, target_ref: TARGET, sheet_id: null, outcome: 'row_absent', written_date: null, time_zone: null }
  assert.deepEqual(await store.record(row), { recorded: true })
  assert.deepEqual(await store.record(row), { recorded: false })
  assert.deepEqual(calls[0], { table: 'integration_yida_issue_confirm_writeback', row, options: { conflictColumns: ['ledger_id'] } })
  assert.throws(() => writeback.issueConfirmTraceRow({ ledger: ACKED, outcome: 'written', sheetId: SHEET, date: null, timeZone: 'Asia/Shanghai' }), { code: 'YIDA_ISSUE_CONFIRM_INPUT' })
  assert.throws(() => writeback.issueConfirmTraceRow({ ledger: ACKED, outcome: 'bogus', sheetId: SHEET }), { code: 'YIDA_ISSUE_CONFIRM_INPUT' })
})
