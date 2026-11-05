'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const yaml = require('js-yaml')
const ts = require('typescript')
const {
  createYidaDeliveryStore,
  YidaDeliveryStoreError,
} = require('../lib/yida-delivery-store.cjs')

const LEDGER = 'integration_yida_delivery_ledger'
const AUDIT = 'integration_yida_delivery_audit'
const UNIQUE_SCOPE_ROW = 'uniq_integration_yida_delivery_scope_row'
const UNIQUE_CREATE_BUSINESS = 'uniq_integration_yida_delivery_create_business'

test('the YiDa real-PG suites are registered in their real execution lane without filtered DB cases', async () => {
  const root = path.resolve(__dirname, '..', '..', '..')
  const specs = ['tests/integration/stock-preparation-yida-write-ledger-realdb.test.ts',
    'tests/integration/stock-preparation-yida-create-fence-realdb.test.ts',
    'tests/integration/stock-preparation-yida-approved-target-realdb.test.ts',
    'tests/integration/stock-preparation-yida-send-approvals-realdb.test.ts',
    'tests/integration/stock-preparation-yida-owner-send-port-realdb.test.ts',
    'tests/integration/stock-preparation-yida-delivery-runner-realdb.test.ts']
  // The step's whole file list: a dropped file, or an unexpected positional filter, is red.
  const lane = ['tests/integration/external-system-delete-bind-lock-protocol.db.test.ts', ...specs,
    'tests/integration/stock-preparation-yida-credential-materials-realdb.test.ts',
    'tests/integration/stock-preparation-yida-draft-plans-realdb.test.ts',
    'tests/integration/automation-live-authority-realdb.test.ts',
    'tests/integration/yida-host-boundaries-realdb.test.ts',
    'tests/integration/yida-host-initialization-barrier-realdb.test.ts',
    'tests/integration/yida-host-connection-test-realdb.test.ts',
    'tests/integration/yida-connection-test-http-realdb.test.ts']
  const workflow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/plugin-tests.yml'), 'utf8'))
  const { requiredSuiteJob } = await import('../../../scripts/ops/plugin-tests-workflow-contract.mjs')
  const step = requiredSuiteJob(workflow, 'runtime-db').steps.find((entry) => entry.id === 'external-system-delete-bind-lock-protocol-real-db')
  assert.deepEqual(Object.keys(step).sort(), ['env', 'id', 'if', 'name', 'run'])
  assert.deepEqual(Object.keys(step.env).sort(), ['DATABASE_URL', 'EXPECT_DB'])
  assert.equal(step.env.EXPECT_DB, '1')
  assert.equal(step.if, "matrix.node-version == '20.x'")
  assert.ok(step.env.DATABASE_URL)
  // An allowlist, not a denylist: vitest also accepts kebab and short-cluster spellings of its filter
  // flags, so every token is pinned. The DATABASE_URL guard line, then one command line whose tokens
  // before 'run' are exact and whose only options after 'run' are the verbose reporter plus the JSON
  // report, then the zero-skip check over that exact report and file count (R-71 gate 10).
  // Join continuations and split words the way bash does: a backslash-newline pair is deleted, not
  // replaced by a space, and only spaces and tabs separate words. Anything outside printable ASCII is
  // refused, so no exotic space or unspaced continuation can hide two files in one bash argument.
  assert.match(step.run, /^[\x20-\x7e\n]*$/)
  const lines = step.run.replace(/\\\r?\n/g, '').split(/\r?\n/).filter((line) => line.trim())
  assert.equal(lines.length, 3)
  assert.equal(lines[0].trim(), ': "${DATABASE_URL:?DATABASE_URL is required for the lock-protocol real-DB proof}"')
  const tokens = lines[1].trim().split(/[ \t]+/)
  const runAt = tokens.indexOf('run')
  assert.deepEqual(tokens.slice(0, runAt + 1),
    ['pnpm', '--filter', '@metasheet/core-backend', 'exec', 'vitest', '--config', 'vitest.integration.config.ts', 'run'])
  const files = tokens.slice(runAt + 1)
  assert.deepEqual(files.filter((token) => token.startsWith('-')),
    ['--reporter=verbose', '--reporter=json', '--outputFile.json=../../artifacts/yida-realdb/lock-protocol-vitest.json'])
  assert.deepEqual(files.slice(-3),
    ['--reporter=verbose', '--reporter=json', '--outputFile.json=../../artifacts/yida-realdb/lock-protocol-vitest.json'])
  // The check reads the same report (vitest resolves outputFile against packages/core-backend; the
  // step's own shell runs at the repository root) and the step's whole file count.
  assert.equal(lines[2], `node scripts/ops/vitest-zero-skip.mjs artifacts/yida-realdb/lock-protocol-vitest.json ${lane.length}`)
  assert.equal(lane.length, 14)
  // A local run's report is gitignored, so a committed stale clean report cannot stand in for this run's.
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/).includes('artifacts/yida-realdb/'), true)
  for (const spec of specs) assert.equal(files.filter((token) => token === spec).length, 1)
  assert.deepEqual(files.filter((token) => !token.startsWith('-')).sort(), [...lane].sort())
  const config = ts.createSourceFile('vitest.config.ts', fs.readFileSync(path.join(root, 'packages/core-backend/vitest.config.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
  const excluded = new Set()
  const visit = (node) => {
    if (ts.isPropertyAssignment(node) && node.name.getText(config) === 'exclude' && ts.isArrayLiteralExpression(node.initializer)) {
      for (const entry of node.initializer.elements) if (ts.isStringLiteral(entry)) excluded.add(entry.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(config)
  for (const spec of specs) assert.equal(excluded.has(spec), true)
  const commands = fs.readFileSync(path.join(root, 'plugins/plugin-integration-core/test-chain.txt'), 'utf8').split(/\r?\n/)
  assert.equal(commands.filter((line) => line === 'node __tests__/yida-delivery-store.test.cjs').length, 1)
  for (const spec of specs) assert.equal(commands.some((line) => line.includes(spec)), false)
})

test('the lock-protocol zero-skip check refuses every skipped, todo, failed, missing or empty report, values-free', () => {
  const { spawnSync } = require('node:child_process')
  const os = require('node:os')
  const root = path.resolve(__dirname, '..', '..', '..')
  const cli = path.join(root, 'scripts/ops/vitest-zero-skip.mjs')
  // Synthetic reports in the exact vitest 1.x JSON reporter shape. Titles carry a sentinel that must never
  // reach the check's output.
  const passed = (title) => ({ title: `${title} SENTINEL-VALUE`, fullName: title, status: 'passed', failureMessages: [] })
  const report = (patch = {}) => {
    const testResults = [0, 1, 2].map((index) => ({
      name: `/repo/tests/integration/sentinel-${index}-realdb.test.ts`,
      status: 'passed', message: '', assertionResults: [passed(`case ${index}a`), passed(`case ${index}b`)],
    }))
    return {
      numTotalTestSuites: 6, numPassedTestSuites: 6, numFailedTestSuites: 0, numPendingTestSuites: 0,
      numTotalTests: 6, numPassedTests: 6, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
      startTime: 1, success: true, testResults, ...patch,
    }
  }
  const withAssertion = (status, summary) => {
    const value = report(summary)
    value.testResults[1].assertionResults[1] = { ...value.testResults[1].assertionResults[1], status }
    return value
  }
  const failed = withAssertion('failed', { success: false, numFailedTests: 1, numPassedTests: 5, numFailedTestSuites: 1, numPassedTestSuites: 5 })
  failed.testResults[1].status = 'failed'
  failed.testResults[1].message = 'SENTINEL-VALUE failure message'
  const cases = [
    ['all pass', report(), 3, []],
    // vitest 1.x counts an it.skip as passed and not as pending: only the assertion status shows it.
    ['skip', withAssertion('skipped'), 3, ['ASSERTION_SKIPPED']],
    ['todo', withAssertion('todo', { numTodoTests: 1 }), 3, ['ASSERTION_TODO', 'TODO_TESTS']],
    ['pending', withAssertion('pending', { numPendingTests: 1 }), 3, ['ASSERTION_PENDING', 'PENDING_TESTS']],
    ['failed', failed, 3, ['ASSERTION_FAILED', 'FAILED_SUITES', 'FAILED_TESTS', 'FILE_NOT_PASSED', 'SUCCESS_NOT_TRUE', 'TOTAL_NOT_PASSED']],
    ['one file short', report(), 4, ['FILE_COUNT']],
    ['success false', report({ success: false }), 3, ['SUCCESS_NOT_TRUE']],
    ['bad JSON', '{"success":true,"SENTINEL-VALUE"', 3, ['REPORT_INVALID_JSON']],
    ['zero tests', report({ numTotalTests: 0, numPassedTests: 0, numTotalTestSuites: 0, numPassedTestSuites: 0, testResults: [] }), 3, ['FILE_COUNT', 'ZERO_TESTS']],
    ['zero tests in the expected files', report({ numTotalTests: 0, numPassedTests: 0,
      testResults: report().testResults.map((file) => ({ ...file, assertionResults: [] })) }), 3, ['FILE_NO_ASSERTIONS', 'ZERO_TESTS']],
    ['a file with no assertions', (() => { const value = report({ numTotalTests: 4, numPassedTests: 4 }); value.testResults[2].assertionResults = []; return value })(), 3, ['FILE_NO_ASSERTIONS']],
    ['a duplicated file', (() => { const value = report(); value.testResults[2].name = value.testResults[0].name; return value })(), 3, ['FILE_DUPLICATE']],
    ['summary counts out of step with the files', report({ numTotalTests: 7, numPassedTests: 7 }), 3, ['ASSERTION_COUNT']],
    ['a pending suite', report({ numPendingTestSuites: 1 }), 3, ['PENDING_SUITES']],
    ['a missing summary count', report({ numTodoTests: undefined }), 3, ['TODO_TESTS']],
    ['not an object', [], 3, ['REPORT_NOT_OBJECT']],
  ]
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yida-zero-skip-'))
  try {
    for (const [name, value, expectedFiles, keys] of cases) {
      const file = path.join(dir, 'report.json')
      fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
      const result = spawnSync(process.execPath, [cli, file, String(expectedFiles)], { encoding: 'utf8' })
      assert.equal(result.error, undefined, name)
      assert.equal(result.status, keys.length === 0 ? 0 : 1, name)
      const output = result.stdout + result.stderr
      assert.doesNotMatch(output, /SENTINEL|sentinel-|realdb\.test/, name)
      if (keys.length === 0) {
        assert.equal(result.stderr, '', name)
        assert.match(result.stdout, /^VITEST_ZERO_SKIP: ok \(3 files, 6 tests, all passed, none skipped or todo\)\r?\n$/, name)
      } else {
        assert.equal(result.stdout, '', name)
        assert.deepEqual(result.stderr.split(/\r?\n/).filter(Boolean), keys.map((key) => `VITEST_ZERO_SKIP: ${key}`), name)
      }
    }
    // An unreadable report path and a malformed or missing file count are refused, not passed.
    const clean = path.join(dir, 'clean.json')
    fs.writeFileSync(clean, JSON.stringify(report()))
    for (const [args, key] of [
      [[path.join(dir, 'missing.json'), '3'], 'REPORT_UNREADABLE'],
      [[clean], 'USAGE'], [[clean, '0'], 'USAGE'], [[clean, '03'], 'USAGE'], [[clean, '3x'], 'USAGE'], [[clean, '3', 'extra'], 'USAGE'], [[], 'USAGE'],
    ]) {
      const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' })
      assert.equal(result.status, 1, key)
      assert.equal(result.stderr.trim(), `VITEST_ZERO_SKIP: ${key}`)
    }
    // Reached through a symlinked directory, the check still runs and still refuses (a main-module guard
    // comparing import.meta.url with argv[1] would print nothing and exit 0 here). The link points at a
    // scratch copy of the script, never at the repository, so cleanup cannot follow it into the checkout.
    // 'junction' needs no privilege on Windows and is ignored on POSIX, where a plain symlink is made.
    const real = path.join(dir, 'real')
    const linked = path.join(dir, 'linked')
    fs.mkdirSync(real)
    fs.copyFileSync(cli, path.join(real, 'vitest-zero-skip.mjs'))
    fs.symlinkSync(real, linked, 'junction')
    try {
      assert.notEqual(fs.realpathSync(path.join(linked, 'vitest-zero-skip.mjs')), path.join(linked, 'vitest-zero-skip.mjs'))
      const skipped = path.join(dir, 'skipped.json')
      fs.writeFileSync(skipped, JSON.stringify(withAssertion('skipped')))
      const refused = spawnSync(process.execPath, [path.join(linked, 'vitest-zero-skip.mjs'), skipped, '3'], { encoding: 'utf8' })
      assert.equal(refused.status, 1, 'symlinked directory: a skip is refused')
      assert.equal(refused.stderr.trim(), 'VITEST_ZERO_SKIP: ASSERTION_SKIPPED')
      const accepted = spawnSync(process.execPath, [path.join(linked, 'vitest-zero-skip.mjs'), clean, '3'], { encoding: 'utf8' })
      assert.equal(accepted.status, 0, 'symlinked directory: a clean report passes')
      assert.match(accepted.stdout, /^VITEST_ZERO_SKIP: ok \(3 files, 6 tests, all passed, none skipped or todo\)\r?\n$/)
    } finally {
      fs.unlinkSync(linked)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

const copy = (value) => structuredClone(value)
const identity = (patch = {}) => ({
  tenantId: 'tenant-a', workspaceId: null, operationId: 'operation-a',
  rowKey: 'row-a', ownerId: 'owner-a', ...patch,
})
const preparation = (patch = {}) => ({
  ...identity(), targetRef: 'target-a', targetRevision: 'target-rev-a',
  planRevision: 'plan-rev-a', payloadDigest: 'a'.repeat(64),
  businessKeyDigest: 'b'.repeat(64), credentialRef: 'credential-a',
  credentialGeneration: 1, intent: 'create', ...patch,
})
const actor = (patch = {}) => ({ ...identity(), actorId: 'actor-a', ...patch })
const ack = (claimToken, patch = {}) => ({
  ...actor(), claimToken, ack: { statusCode: 200, instanceId: 'instance-a' }, ...patch,
})
const unknown = (claimToken, patch = {}) => ({
  ...actor(), claimToken, reason: 'transport_unknown', ...patch,
})

// A transactional unit fake, NOT PostgreSQL lock/rollback evidence. The separate
// realDB suite uses production db.cjs, PostgreSQL and independent connections.
function memoryDb({ wrappedRows = false } = {}) {
  let state = { [LEDGER]: [], [AUDIT]: [] }
  let sequence = 0
  const faults = { audit: false, commit: false, committedResponse: false, insert: null, competitor: null }
  const events = []
  const matches = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value)
  const result = (rows) => wrappedRows ? { rows: copy(rows) } : copy(rows)
  const db = {
    faults,
    events,
    rows: (table = LEDGER) => copy(state[table]),
    async selectOne(table, where) {
      events.push({ type: 'get', table, where: copy(where) })
      return copy(state[table].find((row) => matches(row, where)) || null)
    },
    async transaction(callback) {
      const tx = ++sequence
      const staged = copy(state)
      let pinned = false
      const record = (type, details = {}) => {
        assert.ok(pinned, 'isolation must be pinned before any transaction query')
        events.push({ tx, type, ...details })
      }
      events.push({ tx, type: 'begin' })
      const trx = {
        async setTransactionIsolationLevel(level) {
          assert.equal(level, 'read committed')
          assert.equal(pinned, false)
          pinned = true
          events.push({ tx, type: 'isolation' })
        },
        async selectOneForUpdate(table, where) {
          record('lock', { table, where: copy(where) })
          return copy(staged[table].find((row) => matches(row, where)) || null)
        },
        async insertOne(table, values) {
          record('insert', { table })
          if (table === AUDIT && faults.audit) throw new Error('synthetic-private-audit-failure')
          if (table === LEDGER && faults.insert) {
            const error = faults.insert
            faults.insert = null
            if (faults.competitor) state[LEDGER].push({ ...copy(values), ...faults.competitor })
            throw error
          }
          const row = {
            ...(table === LEDGER ? { claim_token: null, claim_actor_id: null, ack_status_code: null, ack_instance_id: null } : {}),
            ...copy(values), created_at: '2000-01-01T00:00:00.000Z', updated_at: '2000-01-01T00:00:00.000Z',
          }
          staged[table].push(row)
          return result([row])
        },
        async updateRow(table, values, where) {
          record('update', { table, where: copy(where) })
          const changed = []
          for (const row of staged[table]) {
            if (!matches(row, where)) continue
            Object.assign(row, copy(values))
            changed.push(row)
          }
          return result(changed)
        },
      }
      let value
      try {
        value = await callback(trx)
        if (faults.commit) throw new Error('synthetic-private-commit-failure')
      } catch (error) {
        events.push({ tx, type: 'rollback' })
        throw error
      }
      state = staged
      events.push({ tx, type: 'commit' })
      if (faults.committedResponse) throw new Error('synthetic-private-commit-response-lost')
      return value
    },
  }
  return db
}

async function rejectsCode(action, code) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof YidaDeliveryStoreError)
    assert.equal(error.code, `YIDA_DELIVERY_${code}`)
    assert.equal(error.message, error.code)
    assert.equal(error.cause, undefined)
    assert.deepEqual(Object.keys(error).sort(), ['code', 'name'])
    return true
  })
}

function publicRecord(record) {
  assert.deepEqual(Object.keys(record).sort(), [
    'createdAt', 'id', 'intent', 'operationId', 'ownerId', 'rowKey',
    'status', 'tenantId', 'updatedAt', 'workspaceId',
  ])
  assert.ok(!Object.hasOwn(record, 'claimToken'))
  assert.ok(!Object.hasOwn(record, 'instanceId'))
}

test('prepare reuses one scoped identity and rejects every changed snapshot field', async () => {
  const db = memoryDb()
  const store = createYidaDeliveryStore({ db })
  const first = await store.prepare(preparation())
  assert.equal(first.reused, false)
  publicRecord(first.record)
  const repeated = await store.prepare(preparation())
  assert.equal(repeated.reused, true)
  assert.equal(repeated.record.id, first.record.id)
  const changes = {
    ownerId: 'owner-b', targetRef: 'target-b', targetRevision: 'target-rev-b',
    planRevision: 'plan-rev-b', payloadDigest: 'c'.repeat(64),
    businessKeyDigest: 'd'.repeat(64), credentialRef: 'credential-b', credentialGeneration: 2,
  }
  for (const [key, value] of Object.entries(changes)) {
    await rejectsCode(() => store.prepare(preparation({ [key]: value })), 'CONFLICT')
  }
  await rejectsCode(() => store.prepare(preparation({ intent: 'update', instanceId: 'instance-a' })), 'CONFLICT')
  await store.prepare(preparation({ rowKey: 'row-update', intent: 'update', instanceId: 'instance-a' }))
  await rejectsCode(() => store.prepare(preparation({ rowKey: 'row-update', intent: 'update', instanceId: 'instance-b' })), 'CONFLICT')
  assert.equal(db.rows().length, 2)
  assert.equal(db.rows(AUDIT).length, 2)
})

test('null workspace, named workspace, tenant and rows stay separate; owner cannot split identity', async () => {
  const db = memoryDb()
  const store = createYidaDeliveryStore({ db })
  for (const patch of [{}, { workspaceId: 'workspace-a' }, { tenantId: 'tenant-b' }, { rowKey: 'row-b' }]) {
    await store.prepare(preparation(patch))
  }
  assert.equal(new Set(db.rows().map((row) => row.id)).size, 4)
  assert.equal(await store.get(identity({ ownerId: 'owner-b' })), null)
  assert.equal(await store.get(identity({ workspaceId: 'workspace-b' })), null)
  assert.equal(await store.get(identity({ tenantId: 'tenant-c' })), null)
  for (const patch of [{ ownerId: 'owner-b' }, { workspaceId: 'workspace-b' }, { tenantId: 'tenant-c' }]) {
    await rejectsCode(() => store.claim(actor(patch)), 'NOT_FOUND')
    await rejectsCode(() => store.cancelPrepared(actor(patch)), 'NOT_FOUND')
  }
  await rejectsCode(() => store.prepare(preparation({ ownerId: 'owner-b' })), 'CONFLICT')
  assert.equal((await store.get(identity())).status, 'prepared')
})

test('claim returns one committed private token; reloaded store and repeated prepare cannot reclaim it', async () => {
  for (const wrappedRows of [false, true]) {
    const db = memoryDb({ wrappedRows })
    const store = createYidaDeliveryStore({ db })
    await store.prepare(preparation())
    const claimed = await store.claim(actor())
    assert.match(claimed.claimToken, /^[0-9a-f]{64}$/)
    assert.equal(claimed.record.status, 'dispatching')
    publicRecord(claimed.record)
    assert.equal(db.events.at(-1).type, 'commit')
    assert.deepEqual(db.rows(AUDIT).map((row) => row.event), ['prepare', 'claim'])
    const reloaded = createYidaDeliveryStore({ db })
    await rejectsCode(() => reloaded.claim(actor()), 'STATE')
    await rejectsCode(() => reloaded.cancelPrepared(actor()), 'STATE')
    assert.equal((await reloaded.prepare(preparation())).reused, true)
    publicRecord(await reloaded.get(identity()))
    assert.equal(db.rows()[0].claim_token, claimed.claimToken)
  }
})

test('create ACK records protocol acknowledgement, never success, without projecting receipt values', async () => {
  const db = memoryDb()
  const store = createYidaDeliveryStore({ db })
  await store.prepare(preparation())
  const { claimToken } = await store.claim(actor())
  const record = await store.recordAcknowledgement(ack(claimToken, { ack: { statusCode: 201, instanceId: 'private-instance-a' } }))
  assert.equal(record.status, 'acknowledged')
  publicRecord(record)
  assert.equal(db.rows()[0].ack_instance_id, 'private-instance-a')
  assert.equal(db.rows()[0].ack_status_code, 201)
  assert.equal((await store.prepare(preparation())).record.status, 'acknowledged')
  await rejectsCode(() => store.claim(actor()), 'STATE')
  await rejectsCode(() => store.recordAcknowledgement(ack(claimToken)), 'STATE')
  await rejectsCode(() => store.markUnknown(unknown(claimToken)), 'STATE')
  for (const entry of db.rows(AUDIT)) {
    assert.deepEqual(Object.keys(entry).filter((key) => key !== 'updated_at').sort(), [
      'created_at', 'event', 'id', 'ledger_id', 'reason', 'status',
    ])
    assert.ok(!JSON.stringify(entry).includes('private-instance-a'))
    assert.ok(!JSON.stringify(entry).includes(claimToken))
  }
})

test('ACK validates strict shape, 2xx and explicit bounded instance; update binds its original instance', async () => {
  const db = memoryDb()
  const store = createYidaDeliveryStore({ db })
  await store.prepare(preparation({ intent: 'update', instanceId: 'instance-a' }))
  const { claimToken } = await store.claim(actor())
  for (const code of [199, 300, 500, '200', 200.5, null]) {
    await rejectsCode(() => store.recordAcknowledgement(ack(claimToken, { ack: { statusCode: code, instanceId: 'instance-a' } })), 'ACK')
  }
  for (const instanceId of ['', ' instance-a', 'a'.repeat(129), 123, null, 'instance-b']) {
    await rejectsCode(() => store.recordAcknowledgement(ack(claimToken, { ack: { statusCode: 200, instanceId } })), 'ACK')
  }
  for (const invalid of [
    { statusCode: 200 }, { instanceId: 'instance-a' },
    { statusCode: 200, instanceId: 'instance-a', verified: true },
    { statusCode: 200, instanceId: 'instance-a', body: { arbitrary: true } },
  ]) await rejectsCode(() => store.recordAcknowledgement(ack(claimToken, { ack: invalid })), 'INPUT')
  assert.equal((await store.get(identity())).status, 'dispatching')
  assert.equal((await store.recordAcknowledgement(ack(claimToken, { ack: { statusCode: 204, instanceId: 'instance-a' } }))).status, 'acknowledged')
})

test('completion is bound to token, actor, full scope and row, while unknown remains terminal', async () => {
  const db = memoryDb()
  const store = createYidaDeliveryStore({ db })
  await store.prepare(preparation())
  await store.prepare(preparation({ rowKey: 'row-b' }))
  const first = await store.claim(actor())
  const second = await store.claim(actor({ rowKey: 'row-b' }))
  assert.notEqual(first.claimToken, second.claimToken)
  for (const method of [
    (patch) => store.recordAcknowledgement(ack(first.claimToken, patch)),
    (patch) => store.markUnknown(unknown(first.claimToken, patch)),
  ]) {
    for (const patch of [{ claimToken: '0'.repeat(64) }, { claimToken: '' }, { actorId: 'actor-b' }, { rowKey: 'row-b' }]) {
      await rejectsCode(() => method(patch), 'TOKEN')
    }
    for (const patch of [{ tenantId: 'tenant-b' }, { workspaceId: 'workspace-b' }, { ownerId: 'owner-b' }]) {
      await rejectsCode(() => method(patch), 'NOT_FOUND')
    }
  }
  await rejectsCode(() => store.markUnknown(unknown(first.claimToken, { reason: 'arbitrary-private-exception' })), 'INPUT')
  assert.equal((await store.markUnknown(unknown(first.claimToken))).status, 'outcome_unknown')
  await rejectsCode(() => store.recordAcknowledgement(ack(first.claimToken)), 'STATE')
  await rejectsCode(() => store.markUnknown(unknown(first.claimToken)), 'STATE')
  await rejectsCode(() => store.claim(actor()), 'STATE')
  await rejectsCode(() => store.cancelPrepared(actor()), 'STATE')
  assert.equal((await store.get(identity({ rowKey: 'row-b' }))).status, 'dispatching')
  assert.equal((await store.recordAcknowledgement(ack(second.claimToken, { rowKey: 'row-b' }))).status, 'acknowledged')
})

test('only prepared rows can be cancelled and cancellation never supplies a retry', async () => {
  const db = memoryDb()
  const store = createYidaDeliveryStore({ db })
  await store.prepare(preparation())
  assert.equal((await store.cancelPrepared(actor())).status, 'not_sent')
  assert.equal((await store.prepare(preparation())).record.status, 'not_sent')
  await rejectsCode(() => store.claim(actor()), 'STATE')
  await rejectsCode(() => store.cancelPrepared(actor()), 'STATE')
  await rejectsCode(() => store.markUnknown(unknown('a'.repeat(64))), 'STATE')
  await rejectsCode(() => store.recordAcknowledgement(ack('a'.repeat(64))), 'STATE')
  assert.equal(db.rows()[0].claim_token, null)
})

test('audit failure atomically rolls back prepare, claim, ACK, unknown and cancellation', async () => {
  for (const operation of ['prepare', 'claim', 'ack', 'unknown', 'cancel']) {
    const db = memoryDb()
    const store = createYidaDeliveryStore({ db })
    let claimToken
    if (operation !== 'prepare') await store.prepare(preparation())
    if (['ack', 'unknown'].includes(operation)) ({ claimToken } = await store.claim(actor()))
    const before = [db.rows(), db.rows(AUDIT)]
    db.faults.audit = true
    const actions = {
      prepare: () => store.prepare(preparation()), claim: () => store.claim(actor()),
      ack: () => store.recordAcknowledgement(ack(claimToken)),
      unknown: () => store.markUnknown(unknown(claimToken)), cancel: () => store.cancelPrepared(actor()),
    }
    await rejectsCode(actions[operation], 'UNAVAILABLE')
    assert.deepEqual([db.rows(), db.rows(AUDIT)], before)
    assert.equal(db.events.at(-1).type, 'rollback')
    db.faults.audit = false
    await actions[operation]()
  }
})

test('failed commit does not return a claim; lost committed response cannot reopen dispatching', async () => {
  const db = memoryDb()
  const store = createYidaDeliveryStore({ db })
  await store.prepare(preparation())
  db.faults.commit = true
  await rejectsCode(() => store.claim(actor()), 'UNAVAILABLE')
  assert.equal(db.rows()[0].status, 'prepared')
  db.faults.commit = false
  db.faults.committedResponse = true
  await rejectsCode(() => store.claim(actor()), 'UNAVAILABLE')
  db.faults.committedResponse = false
  assert.equal(db.rows()[0].status, 'dispatching')
  await rejectsCode(() => createYidaDeliveryStore({ db }).claim(actor()), 'STATE')
})

test('known scope-row unique race rolls back before a new transaction reuses or conflicts', async () => {
  for (const competitor of [{}, { owner_id: 'owner-b' }, { credential_generation: 2 }]) {
    const db = memoryDb()
    db.faults.insert = Object.assign(new Error('synthetic-private-unique-values'), { code: '23505', constraint: UNIQUE_SCOPE_ROW })
    db.faults.competitor = competitor
    const store = createYidaDeliveryStore({ db })
    if (Object.keys(competitor).length) await rejectsCode(() => store.prepare(preparation()), 'CONFLICT')
    else assert.equal((await store.prepare(preparation())).reused, true)
    const rolledBack = db.events.findIndex((event) => event.type === 'rollback')
    const secondBegin = db.events.findIndex((event) => event.type === 'begin' && event.tx === 2)
    assert.ok(rolledBack > -1 && secondBegin > rolledBack)
    assert.equal(db.events.filter((event) => event.tx === 1 && event.type === 'lock').length, 1)
    assert.equal(db.rows().length, 1)
    assert.equal(db.rows(AUDIT).length, 0)
  }
})

test('business unique race preserves identical-operation replay after rollback in a new transaction', async () => {
  const db = memoryDb()
  db.faults.insert = Object.assign(new Error('synthetic-private-business-values'), { code: '23505', constraint: UNIQUE_CREATE_BUSINESS })
  db.faults.competitor = {}
  let result
  await assert.doesNotReject(async () => { result = await createYidaDeliveryStore({ db }).prepare(preparation()) })
  assert.equal(result.reused, true)
  publicRecord(result.record)
  const rollback = db.events.findIndex(event => event.type === 'rollback')
  assert.ok(rollback >= 0)
  assert.equal(db.events[rollback + 1].type, 'begin')
  assert.equal(db.events.filter(event => event.type === 'insert').length, 1)
  assert.equal(db.rows(AUDIT).length, 0)
})

test('business collision never returns a changed snapshot under the same operation identity', async () => {
  for (const competitor of [{ owner_id: 'owner-b' }, { credential_generation: 2 }, { payload_digest: 'c'.repeat(64) }]) {
    const db = memoryDb()
    db.faults.insert = Object.assign(new Error('synthetic-private-business-values'), { code: '23505', constraint: UNIQUE_CREATE_BUSINESS })
    db.faults.competitor = competitor
    await rejectsCode(() => createYidaDeliveryStore({ db }).prepare(preparation()), 'CONFLICT')
    assert.equal(db.rows().length, 1)
    assert.equal(db.rows(AUDIT).length, 0)
  }
})

test('business collision of another operation returns only a fixed conflict and never the other owner record', async () => {
  for (const competitor of [{ operation_id: 'operation-b' }, { row_key: 'row-b' },
    { operation_id: 'operation-b', owner_id: 'owner-b' }]) {
    const db = memoryDb()
    db.faults.insert = Object.assign(new Error('synthetic-private-business-values'), { code: '23505', constraint: UNIQUE_CREATE_BUSINESS })
    db.faults.competitor = competitor
    await rejectsCode(() => createYidaDeliveryStore({ db }).prepare(preparation()), 'BUSINESS_CONFLICT')
    const retryLocks = db.events.filter(event => event.tx === 2 && event.type === 'lock')
    assert.equal(retryLocks.length, 1)
    assert.deepEqual(retryLocks[0].where, { tenant_id: 'tenant-a', workspace_id: null, operation_id: 'operation-a', row_key: 'row-a' })
    assert.equal(db.events.filter(event => event.type === 'insert').length, 1)
    assert.equal(db.rows(AUDIT).length, 0)
  }
})

test('unrelated unique errors and arbitrary driver exceptions are sanitized without retry', async () => {
  for (const error of [
    Object.assign(new Error('synthetic-private-database-values'), { code: '23505', constraint: 'other_unique' }),
    Object.assign(new Error('synthetic-private-database-values'), { code: '40001', constraint: UNIQUE_SCOPE_ROW }),
    Object.assign(new Error('synthetic-private-database-values'), { code: '40001', constraint: UNIQUE_CREATE_BUSINESS }),
    Object.assign(new Error('synthetic-private-database-values'), { code: '23505', constraint: UNIQUE_CREATE_BUSINESS + '_other' }),
  ]) {
    const db = memoryDb()
    db.faults.insert = error
    await rejectsCode(() => createYidaDeliveryStore({ db }).prepare(preparation()), 'UNAVAILABLE')
    assert.equal(db.events.filter((event) => event.type === 'begin').length, 1)
    assert.equal(db.rows().length, 0)
  }
})

test('strict input rejects missing scope, unbounded IDs, payloads, credentials and accessors before storage', async () => {
  const db = memoryDb()
  const store = createYidaDeliveryStore({ db })
  const absentWorkspace = preparation()
  delete absentWorkspace.workspaceId
  const inputs = [
    absentWorkspace, preparation({ workspaceId: '' }), preparation({ ownerId: ' ' }),
    preparation({ rowKey: 'a\n' }), preparation({ operationId: 'a'.repeat(129) }),
    preparation({ payloadDigest: 'a'.repeat(63) }), preparation({ businessKeyDigest: 'A'.repeat(64) }),
    preparation({ credentialGeneration: 0 }), preparation({ credentialGeneration: 2147483648 }),
    preparation({ credentialGeneration: '1' }), preparation({ instanceId: 'instance-a' }),
    preparation({ intent: 'update' }), preparation({ intent: 'success' }),
    preparation({ targetRevision: 1 }), preparation({ payload: {} }),
    preparation({ token: 'synthetic-secret' }), preparation({ systemToken: 'synthetic-secret' }),
    preparation({ userId: 'caller' }), preparation({ url: 'https://invalid.example' }),
    [], null, Object.assign(Object.create({ inherited: true }), preparation()),
  ]
  let accessed = false
  const accessor = preparation()
  Object.defineProperty(accessor, 'ownerId', { get() { accessed = true; return 'owner-a' }, enumerable: true })
  inputs.push(accessor)
  for (const input of inputs) await rejectsCode(() => store.prepare(input), 'INPUT')
  assert.equal(accessed, false)
  assert.equal(db.events.length, 0)
})

test('missing transactional capabilities fail closed before any mutation', async () => {
  assert.throws(() => createYidaDeliveryStore(), { code: 'YIDA_DELIVERY_UNAVAILABLE' })
  const store = createYidaDeliveryStore({
    db: { selectOne() {}, async transaction(callback) { return callback({}) } },
  })
  await rejectsCode(() => store.prepare(preparation()), 'UNAVAILABLE')
  const read = createYidaDeliveryStore({
    db: { transaction() {}, async selectOne() { throw new Error('synthetic-private-read-error') } },
  })
  await rejectsCode(() => read.get(identity()), 'UNAVAILABLE')
})
