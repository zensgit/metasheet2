'use strict'
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const yaml = require('js-yaml')
const ts = require('typescript')
const modules = Promise.all(['yida-draft-plan-store.mjs', 'yida-static-plan.mjs'].map(name =>
  import(pathToFileURL(path.resolve(__dirname, '../lib', name)).href)))
const TARGET = 'integration_yida_draft_targets', OP = 'integration_yida_draft_operations'
const ROW = 'integration_yida_draft_rows', AUDIT = 'integration_yida_draft_audit'
const scope = { tenantId: 'synthetic-tenant', workspaceId: null, ownerId: 'synthetic-owner' }
async function example(variant) {
  const [, planner] = await modules
  const value = planner.createYidaProtocolExample(variant)
  return { config: value.config, rowsText: value.text, allocation: { mode: 'original' } }
}
async function rejected(promise, code) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, 'YIDA_DRAFT_' + code)
    assert.equal(error.message, error.code)
    assert.deepEqual(Object.keys(error).sort(), ['code', 'name'])
    return true
  })
}
async function memoryMutant(from, to) {
  const file = path.resolve(__dirname, '../lib/yida-draft-plan-store.mjs')
  const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  assert.equal(source.split(from).length - 1, 1, 'mutation must replace exactly one actual guard')
  const changed = source.replace(from, to).replace(/from '(\.\/[^']+)'/g,
    (_, relative) => `from '${pathToFileURL(path.resolve(path.dirname(file), relative)).href}'`)
  return import('data:text/javascript;base64,' + Buffer.from(changed).toString('base64'))
}
async function mutationRed(label, probe) {
  let observed
  try { await probe() } catch (error) { observed = error }
  assert(observed instanceof assert.AssertionError, label + ' must fail its direct boundary assertion')
  console.log(`MUTATION ${label}: RED (${observed.message})`)
}
async function privateThrow(api, foreign, phase = TARGET) {
  const f = await fixture(), input = await example(), errors = []
  const write = api.createInternalYidaDraftTransactionWriter({ security: f.security, context: scope })
  async function run() {
    return f.db.transaction(async trx => {
      await trx.setTransactionIsolationLevel('read committed')
      const insert = trx.insertOne
      trx.insertOne = async (table, row) => { if (table === phase) throw foreign; return insert(table, row) }
      return write(trx, input)
    }).catch(error => { errors.push(error); throw error })
  }
  return { run, errors, f }
}
// Unit fake only. Real locks, host encryption and triggers live in realDB suite.
async function fixture() {
  const [{ createYidaDraftPlanStore }] = await modules
  let state = Object.fromEntries([TARGET, OP, ROW, AUDIT].map(table => [table, []]))
  const faults = { audit: false, row: false, commit: false, targetRace: 0 }, calls = []
  const hostCalls = { transactions: 0, isolation: 0 }
  const matches = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value)
  const db = { async transaction(callback) {
    hostCalls.transactions++
    const staged = structuredClone(state)
    let isolated = false
    function note(kind, table, where = {}) {
      assert(isolated); calls.push({ kind, table, where: structuredClone(where) })
    }
    const trx = {
      async setTransactionIsolationLevel(level) { assert.equal(level, 'read committed'); isolated = true; hostCalls.isolation++ },
      async select(table, { where, orderBy, limit = 1000 }) {
        note('select', table, where)
        const found = staged[table].filter(row => matches(row, where))
        if (orderBy) found.sort((a, b) => a[orderBy[0]] - b[orderBy[0]])
        return { rows: structuredClone(found.slice(0, limit)) }
      },
      async selectOne(table, where) {
        note('one', table, where)
        return structuredClone(staged[table].find(row => matches(row, where)) ?? null)
      },
      async selectOneForUpdate(table, where) {
        note('lock', table, where)
        return structuredClone(staged[table].find(row => matches(row, where)) ?? null)
      },
      async insertOne(table, row) {
        note('insert', table)
        if (table === TARGET && faults.targetRace > 0) {
          faults.targetRace--
          const error = new Error('SYNTHETIC_INSERT_RACE')
          error.code = '23505'; error.constraint = 'uniq_yida_draft_target_locator'
          throw error
        }
        if ((table === AUDIT && faults.audit) || (table === ROW && faults.row)) throw new Error('SYNTHETIC_PRIVATE_DETAIL')
        staged[table].push(structuredClone(row))
        return [structuredClone(row)]
      },
    }
    const result = await callback(trx)
    state = staged
    if (faults.commit) { faults.commit = false; throw new Error('SYNTHETIC_LOST_COMMIT_REPLY') }
    return result
  } }
  const security = {
    async encrypt(text) { return 'enc:' + Buffer.from(text).toString('base64') },
    async decrypt(value) { return Buffer.from(value.slice(4), 'base64').toString() },
  }
  const fresh = (context = scope, vault = security) => createYidaDraftPlanStore({ db, security: vault, context })
  return { store: fresh(), fresh, db, security, faults, calls, hostCalls, snapshot: () => structuredClone(state), edit: fn => fn(state),
    readCipher: value => JSON.parse(Buffer.from(value.slice(4), 'base64').toString()),
    writeCipher: value => 'enc:' + Buffer.from(JSON.stringify(value)).toString('base64') }
}

test('realDB whole-file lane and Node contracts are registered; no-DB lane excludes the DB file', () => {
  const root = path.resolve(__dirname, '../../..')
  const spec = 'tests/integration/stock-preparation-yida-draft-plans-realdb.test.ts'
  const flow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/plugin-tests.yml'), 'utf8'))
  const step = flow.jobs.test.steps.find(item => item.id === 'external-system-delete-bind-lock-protocol-real-db')
  assert.equal(step.env.EXPECT_DB, '1'); assert.equal(step.if, "matrix.node-version == '20.x'")
  assert.ok(step.env.DATABASE_URL)
  const command = step.run.replace(/\\\r?\n/g, ' ')
  assert.equal(command.split(/\s+/).filter(token => token === spec).length, 1)
  assert.doesNotMatch(command, /(?:^|\s)(?:-t|--testNamePattern|--passWithNoTests)(?:\s|=|$)/)
  const source = ts.createSourceFile('vitest.config.ts', fs.readFileSync(path.join(root, 'packages/core-backend/vitest.config.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
  const exclusions = []
  const walk = node => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'exclude' && ts.isArrayLiteralExpression(node.initializer)) {
      exclusions.push(...node.initializer.elements.filter(ts.isStringLiteral).map(item => item.text))
    }
    ts.forEachChild(node, walk)
  }
  walk(source); assert(exclusions.includes(spec))
  const chain = fs.readFileSync(path.join(root, 'plugins/plugin-integration-core/test-chain.txt'), 'utf8').split(/\r?\n/)
  for (const name of ['yida-draft-plan', 'yida-draft-plan-store']) assert.equal(chain.filter(line => line === `node __tests__/${name}.test.cjs`).length, 1)
  assert.equal(chain.some(line => line.includes(spec)), false)
})

test('server-generated frozen identity has no permission or private source in metadata; replay uses persisted full source', async () => {
  const f = await fixture(), input = await example()
  const made = await f.store.createDraft(input)
  assert.deepEqual(Object.keys(f.store).sort(), ['createDraft', 'inspect', 'replay'])
  assert.equal(made.reused, false); assert.equal(made.rowCount, 2)
  assert.equal(made.status, 'unverified'); assert.equal(made.identityKind, 'local-unverified')
  for (const field of ['canSend', 'canApply', 'tokenIssued', 'externalWriteAttempted']) assert.equal(made[field], false)
  for (const id of [made.targetRef, made.operationId, ...made.rows.map(row => row.rowKey)]) assert.match(id, /^[0-9a-f-]{36}$/)
  assert.equal(Object.isFrozen(made.rows[0]), true)
  const serialized = JSON.stringify(made)
  assert.equal(/formUuid|payload|rowsText|digest|credential|synthetic_stock/.test(serialized), false)
  input.rowsText = '[]'; input.config.intent = 'update'
  const replay = await f.fresh().replay({ operationId: made.operationId })
  assert.equal(replay.replayVerified, true)
  assert.deepEqual(replay.rows, made.rows)
  assert.deepEqual(replay.evidence, { rowCount: 2, plannedCreate: 2, plannedUpdate: 0, invalid: 0, duplicateKeyCount: 0 })
})

test('source aliases and row order reuse original operation and row identities without another audit', async () => {
  const f = await fixture(), made = await f.store.createDraft(await example())
  const other = await example('renamed')
  other.rowsText = JSON.stringify(JSON.parse(other.rowsText).reverse())
  const reused = await f.fresh().createDraft(other)
  assert.equal(reused.reused, true)
  assert.equal(reused.operationId, made.operationId); assert.deepEqual(reused.rows, made.rows)
  assert.equal(f.snapshot()[TARGET].length, 1); assert.equal(f.snapshot()[OP].length, 1)
  assert.equal(f.snapshot()[AUDIT].length, 1)
})

test('payload edits produce a new immutable operation on the same target, never replace the first snapshot', async () => {
  const f = await fixture(), input = await example()
  const made = await f.store.createDraft(input), before = f.snapshot()[OP][0]
  const source = JSON.parse(input.rowsText); source[0].quantity = 10
  const changed = await f.store.createDraft({ ...input, rowsText: JSON.stringify(source) })
  assert.equal(changed.targetRef, made.targetRef)
  assert.notEqual(changed.operationId, made.operationId)
  assert.equal(JSON.stringify(f.snapshot()[OP][0]) === JSON.stringify(before), true)
  assert.equal(f.snapshot()[TARGET].length, 1); assert.equal(f.snapshot()[AUDIT].length, 2)
})

test('key definition cannot fork the same locator; owner change cannot mint another namespace', async () => {
  const f = await fixture(), input = await example()
  const made = await f.store.createDraft(input), before = f.snapshot()
  const differentKey = structuredClone(input)
  differentKey.config.businessKey = ['projectNo', 'parentCode']
  await rejected(f.store.createDraft(differentKey), 'KEY_DEFINITION_CONFLICT')
  await rejected(f.fresh({ ...scope, ownerId: 'different-owner' }).createDraft(input), 'CONFLICT')
  for (const patch of [{ ownerId: 'different-owner' }, { tenantId: 'different-tenant' }, { workspaceId: 'different-workspace' }]) {
    await rejected(f.fresh({ ...scope, ...patch }).inspect({ operationId: made.operationId }), 'NOT_FOUND')
    await rejected(f.fresh({ ...scope, ...patch }).replay({ operationId: made.operationId }), 'NOT_FOUND')
  }
  assert.equal(JSON.stringify(f.snapshot()) === JSON.stringify(before), true)
})

test('all row insertions and audit roll back together, while commit-response loss remains unknown', async () => {
  for (const fault of ['audit', 'row']) {
    const f = await fixture(); f.faults[fault] = true
    await rejected(f.store.createDraft(await example()), 'UNAVAILABLE')
    assert(Object.values(f.snapshot()).every(rows => rows.length === 0))
  }
  const f = await fixture(); f.faults.commit = true
  await rejected(f.store.createDraft(await example()), 'UNAVAILABLE')
  assert.equal(f.snapshot()[OP].length, 1)
  const replay = await f.store.createDraft(await example())
  assert.equal(replay.reused, true); assert.equal(f.snapshot()[OP].length, 1)
})

test('exact sealed target and operation envelopes prevent transplant of valid unit ciphertext', async () => {
  for (const [table, column, field, value] of [
    [TARGET, 'target_encrypted', 'ownerId', 'different-owner'],
    [TARGET, 'target_encrypted', 'targetRef', 'different-target'],
    [TARGET, 'target_encrypted', 'purpose', 'different-purpose'],
    [OP, 'snapshot_encrypted', 'operationId', 'different-operation'],
    [OP, 'snapshot_encrypted', 'planDigest', '0'.repeat(64)],
    [OP, 'snapshot_encrypted', 'workspaceId', 'different-workspace'],
  ]) {
    const f = await fixture(), made = await f.store.createDraft(await example())
    f.edit(state => { const envelope = f.readCipher(state[table][0][column]); envelope[field] = value
      state[table][0][column] = f.writeCipher(envelope) })
    await rejected(f.store.replay({ operationId: made.operationId }), 'UNAVAILABLE')
  }
})

test('replay re-runs the actual planner and checks stored plan plus complete immutable row membership', async () => {
  for (const variant of ['source', 'plan', 'missing-row', 'row-digest']) {
    const f = await fixture(), made = await f.store.createDraft(await example())
    f.edit(state => {
      const envelope = f.readCipher(state[OP][0].snapshot_encrypted)
      if (variant === 'source') envelope.source.rowsText = '[]'
      if (variant === 'plan') envelope.plan.canApply = true
      if (variant === 'missing-row') state[ROW].pop()
      if (variant === 'row-digest') state[ROW][0].business_key_digest = '0'.repeat(64)
      state[OP][0].snapshot_encrypted = f.writeCipher(envelope)
    })
    await rejected(f.store.replay({ operationId: made.operationId }), 'UNAVAILABLE')
  }
})

test('no plaintext/v1 fallback, absent host security or caller-chosen operation identity', async () => {
  const f = await fixture(), [{ createYidaDraftPlanStore }] = await modules
  assert.throws(() => createYidaDraftPlanStore({ db: f.db, context: scope }), { code: 'YIDA_DRAFT_UNAVAILABLE' })
  for (const field of ['operationId', 'targetRef', 'rowKey', 'credentialRef', 'approved']) {
    await rejected(f.store.createDraft({ ...await example(), [field]: 'caller' }), 'INPUT')
  }
  for (const plaintext of ['plaintext', 'v1:legacy', 'enc:']) {
    await rejected(f.fresh(scope, { ...f.security, async encrypt() { return plaintext } }).createDraft(await example()), 'UNAVAILABLE')
  }
  assert.equal(f.snapshot()[TARGET].length, 0)
})

test('private transaction writer executes actual UUID/cipher/rows/audit persistence and reuse in one host transaction', async () => {
  const f = await fixture(), [{ createInternalYidaDraftTransactionWriter }] = await modules
  const write = createInternalYidaDraftTransactionWriter({ security: f.security, context: scope })
  const input = await example(), before = structuredClone(input)
  const [made, reused] = await f.db.transaction(async trx => {
    await trx.setTransactionIsolationLevel('read committed')
    return [await write(trx, input), await write(trx, input)]
  })
  assert.equal(made.reused, false); assert.equal(reused.reused, true)
  assert.deepEqual(input, before)
  console.log('INPUT_UNCHANGED private-create-and-reuse: exact deepEqual PASS')
  assert.equal(reused.operationId, made.operationId); assert.deepEqual(reused.rows, made.rows)
  assert.deepEqual(f.hostCalls, { transactions: 1, isolation: 1 })
  assert.equal(f.snapshot()[AUDIT].length, 1); assert.equal(f.snapshot()[ROW].length, 2)
  assert.equal(Object.isFrozen(made.rows[0]), true)
  for (const id of [made.targetRef, made.operationId, ...made.rows.map(row => row.rowKey)]) assert.match(id, /^[0-9a-f-]{36}$/)
  const replay = await f.store.replay({ operationId: made.operationId })
  assert.equal(replay.replayVerified, true)
})

test('private writer rejects incomplete/accessor/proxy/raw transaction methods; caller owns race handling', async () => {
  const f = await fixture(), [{ createInternalYidaDraftTransactionWriter }] = await modules
  const write = createInternalYidaDraftTransactionWriter({ security: f.security, context: scope }), input = await example()
  let touched = 0
  await f.db.transaction(async trx => {
    await trx.setTransactionIsolationLevel('read committed')
    for (const key of ['select', 'selectOne', 'selectOneForUpdate', 'insertOne']) {
      const missing = { ...trx }; delete missing[key]
      await rejected(write(missing, input), 'UNAVAILABLE')
      const getter = { ...trx }; Object.defineProperty(getter, key, { get() { touched++; return trx[key] } })
      await rejected(write(getter, input), 'UNAVAILABLE')
    }
    await rejected(write(new Proxy(trx, { get() { touched++; throw new Error('SYNTHETIC_PRIVATE') } }), input), 'UNAVAILABLE')
    await rejected(write({ query() { touched++ } }, input), 'UNAVAILABLE')
  })
  assert.equal(touched, 0); assert.equal(f.calls.length, 0)
  const race = await fixture(); race.faults.targetRace = 1
  await rejected(race.db.transaction(async trx => {
    await trx.setTransactionIsolationLevel('read committed')
    return createInternalYidaDraftTransactionWriter({ security: race.security, context: scope })(trx, input)
  }), 'CONFLICT')
  assert.deepEqual(race.hostCalls, { transactions: 1, isolation: 1 })
  const publicRace = await fixture(); publicRace.faults.targetRace = 1
  assert.equal((await publicRace.store.createDraft(input)).reused, false)
  assert.deepEqual(publicRace.hostCalls, { transactions: 2, isolation: 2 })
})

test('private writer closes raw CRUD/audit/encryption refusals before they reach its transaction owner', async () => {
  const [{ createInternalYidaDraftTransactionWriter }] = await modules
  for (const phase of ['lock', TARGET, OP, ROW, AUDIT, 'encrypt']) {
    const f = await fixture(), input = await example(), before = structuredClone(input)
    const foreign = Object.assign(new Error('SYNTHETIC_PRIVATE_DETAIL'), { code: 'P0001', detail: 'SYNTHETIC_PRIVATE_DETAIL' })
    const security = phase === 'encrypt' ? { ...f.security, async encrypt() { throw foreign } } : f.security
    const write = createInternalYidaDraftTransactionWriter({ security, context: scope })
    await rejected(f.db.transaction(async trx => {
      await trx.setTransactionIsolationLevel('read committed')
      const insert = trx.insertOne
      if (phase === 'lock') trx.selectOneForUpdate = async () => { throw foreign }
      else trx.insertOne = async (table, row) => { if (table === phase) throw foreign; return insert(table, row) }
      return write(trx, input)
    }), 'UNAVAILABLE')
    assert.deepEqual(input, before)
    assert.deepEqual(f.hostCalls, { transactions: 1, isolation: 1 })
    assert(Object.values(f.snapshot()).every(rows => rows.length === 0))
  }
  console.log('INPUT_UNCHANGED private-failures: lock/target/operation/row/audit/encrypt exact deepEqual PASS')
})

test('private reuse closes select/decrypt refusals without changing the existing immutable draft', async () => {
  const [{ createInternalYidaDraftTransactionWriter }] = await modules
  for (const phase of ['select', 'decrypt']) {
    const f = await fixture(), input = await example()
    await f.store.createDraft(input)
    const before = f.snapshot(), foreign = Object.assign(new Error('SYNTHETIC_PRIVATE_DETAIL'), { code: 'P0001' })
    const security = phase === 'decrypt' ? { ...f.security, async decrypt() { throw foreign } } : f.security
    const write = createInternalYidaDraftTransactionWriter({ security, context: scope })
    await rejected(f.db.transaction(async trx => {
      await trx.setTransactionIsolationLevel('read committed')
      if (phase === 'select') trx.select = async () => { throw foreign }
      return write(trx, input)
    }), 'UNAVAILABLE')
    assert.deepEqual(f.snapshot(), before)
    assert.deepEqual(f.hostCalls, { transactions: 2, isolation: 2 })
  }
})

test('foreign and mutated exported errors cannot inject private fields, messages or prototypes', async () => {
  const [{ createInternalYidaDraftTransactionWriter, YidaDraftStoreError }] = await modules
  const { YidaDraftPlanError } = await import(pathToFileURL(path.resolve(__dirname, '../lib/yida-draft-plan.mjs')).href)
  const unknown = new YidaDraftStoreError('SYNTHETIC_PRIVATE_DETAIL')
  assert.equal(unknown.code, 'YIDA_DRAFT_UNAVAILABLE')
  assert.equal(unknown.message, unknown.code)
  const own = new YidaDraftStoreError('CONFLICT'), plan = new YidaDraftPlanError('INPUT')
  for (const error of [own, plan]) {
    error.message = 'SYNTHETIC_PRIVATE_DETAIL'; error.code = 'SYNTHETIC_PRIVATE_DETAIL'
    error.cause = 'SYNTHETIC_PRIVATE_DETAIL'; error.detail = 'SYNTHETIC_PRIVATE_DETAIL'
    Object.setPrototypeOf(error, null)
  }
  let touched = 0
  const ownGetters = new YidaDraftStoreError('CONFLICT')
  for (const key of ['code', 'message', 'cause']) Object.defineProperty(ownGetters, key,
    { configurable: true, get() { touched++; throw new Error('SYNTHETIC_PRIVATE_DETAIL') } })
  const fakeStore = Object.assign(Object.create(YidaDraftStoreError.prototype), { code: 'YIDA_DRAFT_CONFLICT', message: 'SYNTHETIC_PRIVATE_DETAIL' })
  const fakePlan = Object.assign(Object.create(YidaDraftPlanError.prototype), { code: 'YIDA_DRAFT_INPUT', message: 'SYNTHETIC_PRIVATE_DETAIL' })
  for (const [foreign, expected] of [[own, 'CONFLICT'], [ownGetters, 'CONFLICT'], [plan, 'UNAVAILABLE'], [fakeStore, 'UNAVAILABLE'], [fakePlan, 'UNAVAILABLE'],
    ['SYNTHETIC_PRIVATE_DETAIL', 'UNAVAILABLE'], [null, 'UNAVAILABLE'], [undefined, 'UNAVAILABLE']]) {
    for (const boundary of ['private', 'public']) {
      const f = await fixture(), input = await example()
      let observed
      const promise = boundary === 'private' ? f.db.transaction(async trx => {
        await trx.setTransactionIsolationLevel('read committed')
        trx.insertOne = async () => { throw foreign }
        return createInternalYidaDraftTransactionWriter({ security: f.security, context: scope })(trx, input)
      }) : f.fresh(scope, { ...f.security, async encrypt() { throw foreign } }).createDraft(input)
      await rejected(promise.catch(error => { observed = error; throw error }), expected)
      assert.notEqual(observed, foreign)
      assert.equal(Object.hasOwn(observed, 'cause'), false)
      assert.equal(Object.getPrototypeOf(observed), YidaDraftStoreError.prototype)
      assert.equal(touched, 0)
    }
  }
})

test('unknown DB rejections never execute Proxy traps or error code/constraint/message getters', async () => {
  const [{ createInternalYidaDraftTransactionWriter }] = await modules
  let touched = 0
  const trap = () => { touched++; throw new Error('SYNTHETIC_PRIVATE_DETAIL') }
  const getters = {}
  for (const key of ['code', 'constraint', 'message', 'cause']) Object.defineProperty(getters, key, { get: trap })
  const constraintGetter = { code: '23505' }; Object.defineProperty(constraintGetter, 'constraint', { get: trap })
  const proxy = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap })
  const revoked = Proxy.revocable({}, {}); revoked.revoke()
  for (const foreign of [getters, constraintGetter, proxy, revoked.proxy]) {
    for (const phase of [TARGET, AUDIT, 'commit']) {
      const f = await fixture(), input = await example()
      const promise = phase === 'commit' ? (await modules)[0].createYidaDraftPlanStore({
        db: { async transaction() { throw foreign } }, security: f.security, context: scope,
      }).createDraft(input) : f.db.transaction(async trx => {
        await trx.setTransactionIsolationLevel('read committed')
        const insert = trx.insertOne
        trx.insertOne = async (table, row) => { if (table === phase) throw foreign; return insert(table, row) }
        return createInternalYidaDraftTransactionWriter({ security: f.security, context: scope })(trx, input)
      })
      await rejected(promise, 'UNAVAILABLE')
      assert.equal(touched, 0)
    }
  }
})

test('only own-data target INSERT unique errors are races; private conflicts are fresh and never retry', async () => {
  const [{ createInternalYidaDraftTransactionWriter }] = await modules
  const race = () => Object.assign(new Error('SYNTHETIC_PRIVATE_DETAIL'), { code: '23505', constraint: 'uniq_yida_draft_target_locator' })
  const inherited = Object.create({ code: '23505', constraint: 'uniq_yida_draft_target_locator' })
  const inheritedConstraint = Object.assign(Object.create({ constraint: 'uniq_yida_draft_target_locator' }), { code: '23505' })
  for (const [foreign, phase, expected] of [[race(), TARGET, 'CONFLICT'], [inherited, TARGET, 'UNAVAILABLE'],
    [inheritedConstraint, TARGET, 'UNAVAILABLE'],
    [{ code: '23505', constraint: 'other_constraint' }, TARGET, 'UNAVAILABLE'],
    [{ code: 'P0001', constraint: 'uniq_yida_draft_target_locator' }, TARGET, 'UNAVAILABLE'],
    [race(), OP, 'UNAVAILABLE'], [race(), AUDIT, 'UNAVAILABLE']]) {
    const f = await fixture(), input = await example(), errors = []
    for (let attempt = 0; attempt < 2; attempt++) {
      await rejected(f.db.transaction(async trx => {
        await trx.setTransactionIsolationLevel('read committed')
        const insert = trx.insertOne
        trx.insertOne = async (table, row) => { if (table === phase) throw foreign; return insert(table, row) }
        return createInternalYidaDraftTransactionWriter({ security: f.security, context: scope })(trx, input)
      }).catch(error => { errors.push(error); throw error }), expected)
      assert.deepEqual(f.hostCalls, { transactions: attempt + 1, isolation: attempt + 1 })
    }
    assert.notEqual(errors[0], errors[1]); assert.notEqual(errors[0], foreign)
  }
  const limited = await fixture(); limited.faults.targetRace = 2
  await rejected(limited.store.createDraft(await example()), 'CONFLICT')
  assert.deepEqual(limited.hostCalls, { transactions: 2, isolation: 2 })
  const committed = await fixture(); committed.faults.commit = true
  await rejected(committed.store.createDraft(await example()), 'UNAVAILABLE')
  assert.deepEqual(committed.hostCalls, { transactions: 1, isolation: 1 })
  const shapedCommit = await fixture(), [{ createYidaDraftPlanStore }] = await modules
  const unknown = createYidaDraftPlanStore({ db: { async transaction(callback) {
    await shapedCommit.db.transaction(callback); throw race()
  } }, security: shapedCommit.security, context: scope })
  await rejected(unknown.createDraft(await example()), 'UNAVAILABLE')
  assert.deepEqual(shapedCommit.hostCalls, { transactions: 1, isolation: 1 })
  assert.equal(shapedCommit.snapshot()[OP].length, 1)
  assert.equal((await shapedCommit.store.createDraft(await example())).reused, true)
})

test('private factory requires exact own-data options/context and closes host-security setup failures', async () => {
  const f = await fixture(), [{ createInternalYidaDraftTransactionWriter }] = await modules
  const valid = { security: f.security, context: scope }
  let touched = 0
  const trap = () => { touched++; throw new Error('SYNTHETIC_PRIVATE_DETAIL') }
  const optionsGetter = { context: scope }; Object.defineProperty(optionsGetter, 'security', { enumerable: true, get: trap })
  const contextGetter = { ...scope }; Object.defineProperty(contextGetter, 'ownerId', { enumerable: true, get: trap })
  const nonenumerable = { ...valid }; Object.defineProperty(nonenumerable, 'context', { value: scope, enumerable: false })
  const revoked = Proxy.revocable(valid, {}); revoked.revoke()
  for (const options of [undefined, null, [], {}, { ...valid, db: f.db }, Object.create(valid), optionsGetter, nonenumerable,
    { ...valid, [Symbol('extra')]: true }, new Proxy(valid, { get: trap, getPrototypeOf: trap, ownKeys: trap }), revoked.proxy,
    { ...valid, context: contextGetter }, { ...valid, context: new Proxy(scope, { get: trap, getPrototypeOf: trap, ownKeys: trap }) },
    { ...valid, context: { ...scope, ownerId: '' } }, { ...valid, context: { ...scope, tenantId: ' synthetic' } }]) {
    assert.throws(() => createInternalYidaDraftTransactionWriter(options), error => {
      assert.equal(error.code, 'YIDA_DRAFT_INPUT'); assert.equal(error.message, error.code)
      assert.deepEqual(Object.keys(error).sort(), ['code', 'name']); return true
    })
  }
  assert.equal(touched, 0)
  const foreign = Object.assign(new Error('SYNTHETIC_PRIVATE_DETAIL'), { code: 'P0001' })
  const security = {}; Object.defineProperty(security, 'encrypt', { get() { throw foreign } })
  assert.throws(() => createInternalYidaDraftTransactionWriter({ security, context: scope }), error => {
    assert.notEqual(error, foreign); assert.equal(error.code, 'YIDA_DRAFT_UNAVAILABLE')
    assert.equal(error.message, error.code); assert.deepEqual(Object.keys(error).sort(), ['code', 'name']); return true
  })
  assert.equal(typeof createInternalYidaDraftTransactionWriter(Object.assign(Object.create(null), valid)), 'function')
  assert.equal(typeof createInternalYidaDraftTransactionWriter({ security: f.security, context: Object.assign(Object.create(null), scope) }), 'function')
})

test('private persistence closure preserves actual compiler INPUT/CONFIG/PLAN/LIMIT errors before any CRUD', async () => {
  const f = await fixture(), [{ createInternalYidaDraftTransactionWriter }] = await modules
  const write = createInternalYidaDraftTransactionWriter({ security: f.security, context: scope })
  const input = await example(), wrongConfig = structuredClone(input), wrongPlan = structuredClone(input)
  wrongConfig.config.version = 1; wrongPlan.rowsText = '[]'
  for (const [value, code] of [[{ ...input, operationId: 'caller' }, 'INPUT'], [wrongConfig, 'CONFIG'], [wrongPlan, 'PLAN'],
    [{ ...input, rowsText: 'x'.repeat(2 * 1024 * 1024 + 1) }, 'LIMIT']]) {
    await assert.rejects(write({}, value), error => {
      assert.equal(error.name, 'YidaDraftPlanError'); assert.equal(error.code, 'YIDA_DRAFT_' + code)
      assert.equal(error.message, error.code); assert.deepEqual(Object.keys(error).sort(), ['code', 'name']); return true
    })
  }
  assert.deepEqual(f.hostCalls, { transactions: 0, isolation: 0 }); assert.equal(f.calls.length, 0)
})

test('actual in-memory guard downgrades make their direct error/factory/race assertions red', async () => {
  let mutant = await memoryMutant("const fixed = ERROR_CODES.has(code) ? code : 'UNAVAILABLE'", 'const fixed = code')
  await mutationRed('constructor-closed-vocabulary', () => {
    assert.equal(new mutant.YidaDraftStoreError('SYNTHETIC_PRIVATE_DETAIL').code, 'YIDA_DRAFT_UNAVAILABLE')
  })

  mutant = await memoryMutant('    ownErrors.set(this, fixed)', '')
  let foreign = new mutant.YidaDraftStoreError('CONFLICT')
  let throwing = await privateThrow(mutant, foreign, AUDIT)
  await mutationRed('constructor-private-provenance', () => rejected(throwing.run(), 'CONFLICT'))

  mutant = await memoryMutant("function closed(error) { fail(ownErrors.get(error) || 'UNAVAILABLE') }",
    "function closed(error) { if (error instanceof YidaDraftStoreError) throw error; fail('UNAVAILABLE') }")
  foreign = Object.assign(Object.create(mutant.YidaDraftStoreError.prototype), { code: 'YIDA_DRAFT_CONFLICT', message: 'SYNTHETIC_PRIVATE_DETAIL' })
  throwing = await privateThrow(mutant, foreign, AUDIT)
  await mutationRed('private-closed-identity', () => rejected(throwing.run(), 'UNAVAILABLE'))

  mutant = await memoryMutant('      catch (error) { closed(error) }', '      catch (error) { throw error }')
  throwing = await privateThrow(mutant, Object.assign(new Error('SYNTHETIC_PRIVATE_DETAIL'), { code: 'P0001' }), AUDIT)
  await mutationRed('private-persistence-closure-raw-P0001', () => rejected(throwing.run(), 'UNAVAILABLE'))
  throwing = await privateThrow(mutant, { code: '23505', constraint: 'uniq_yida_draft_target_locator' })
  await rejected(throwing.run(), 'CONFLICT'); await rejected(throwing.run(), 'CONFLICT')
  await mutationRed('private-persistence-closure-sentinel', () => assert.notEqual(throwing.errors[0], throwing.errors[1]))

  const transactionClosure = "      if (error === TARGET_RACE) throw TARGET_RACE\n      closed(error)"
  mutant = await memoryMutant(transactionClosure,
    "      if (error === TARGET_RACE) throw TARGET_RACE\n      if (error instanceof YidaDraftStoreError) throw error\n      fail('UNAVAILABLE')")
  const f = await fixture()
  foreign = Object.assign(Object.create(mutant.YidaDraftStoreError.prototype), { code: 'YIDA_DRAFT_CONFLICT', message: 'SYNTHETIC_PRIVATE_DETAIL' })
  await mutationRed('public-transaction-closure', async () => rejected(mutant.createYidaDraftPlanStore({
    db: { async transaction() { throw foreign } }, security: f.security, context: scope,
  }).createDraft(await example()), 'UNAVAILABLE'))

  mutant = await memoryMutant("  if (!error || typeof error !== 'object' || types.isProxy(error)) return false",
    "  if (!error || typeof error !== 'object') return false")
  let touched = 0
  foreign = new Proxy({}, { getOwnPropertyDescriptor() { touched++; throw new Error('SYNTHETIC_PRIVATE_DETAIL') } })
  throwing = await privateThrow(mutant, foreign)
  await rejected(throwing.run(), 'UNAVAILABLE')
  await mutationRed('target-race-Proxy-exclusion', () => assert.equal(touched, 0))

  for (const field of ['code', 'constraint']) {
    mutant = await memoryMutant(`Object.getOwnPropertyDescriptor(error, '${field}')?.value`, `error.${field}`)
    touched = 0
    foreign = field === 'constraint' ? { code: '23505' } : {}
    Object.defineProperty(foreign, field, { get() { touched++; throw new Error('SYNTHETIC_PRIVATE_DETAIL') } })
    throwing = await privateThrow(mutant, foreign)
    await rejected(throwing.run(), 'UNAVAILABLE')
    await mutationRed('target-race-own-data-' + field, () => assert.equal(touched, 0))
  }

  mutant = await memoryMutant("    const parsed = record(options, ['security', 'context'])",
    '    const parsed = { security: options.security, context: options.context }')
  await mutationRed('private-factory-exact-options', () => assert.throws(() => mutant.createInternalYidaDraftTransactionWriter({
    security: f.security, context: scope, db: f.db,
  }), { code: 'YIDA_DRAFT_INPUT' }))

  mutant = await memoryMutant('  } catch (error) { closed(error) }', '  } catch (error) { throw error }')
  const security = {}; Object.defineProperty(security, 'encrypt', { get() { throw new Error('SYNTHETIC_PRIVATE_DETAIL') } })
  await mutationRed('private-factory-setup-closure', () => assert.throws(() => mutant.createInternalYidaDraftTransactionWriter({
    security, context: scope,
  }), { code: 'YIDA_DRAFT_UNAVAILABLE' }))

  mutant = await memoryMutant('      const compiled = compileYidaDraft(input)\n      try { return await createDraftInTransaction(trx, input, compiled) }',
    '      try { const compiled = compileYidaDraft(input); return await createDraftInTransaction(trx, input, compiled) }')
  const write = mutant.createInternalYidaDraftTransactionWriter({ security: f.security, context: scope })
  await mutationRed('actual-compiler-before-persistence-closure', () => assert.rejects(write({}, {}), error => {
    assert.equal(error.name, 'YidaDraftPlanError'); assert.equal(error.code, 'YIDA_DRAFT_INPUT'); return true
  }))
})

test('in-memory removal of private writer capability guard makes the incomplete-transaction rejection red', async () => {
  const file = path.resolve(__dirname, '../lib/yida-draft-plan-store.mjs')
  const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  const guard = "    if (!trx || typeof trx !== 'object' || types.isProxy(trx) || Array.isArray(trx)\n"
    + "      || ['select', 'selectOne', 'selectOneForUpdate', 'insertOne'].some(key => {\n"
    + "        const property = Object.getOwnPropertyDescriptor(trx, key)\n"
    + "        return !property || !Object.hasOwn(property, 'value') || typeof property.value !== 'function'\n"
    + "      })) fail('UNAVAILABLE')"
  assert(source.includes(guard))
  const mutantSource = source.replace(guard, '').replace(/from '(\.\/[^']+)'/g,
    (_, relative) => `from '${pathToFileURL(path.resolve(path.dirname(file), relative)).href}'`)
  const mutant = await import('data:text/javascript;base64,' + Buffer.from(mutantSource).toString('base64'))
  const f = await fixture(), input = await example()
  await assert.rejects(f.db.transaction(async trx => {
    await trx.setTransactionIsolationLevel('read committed'); delete trx.selectOne
    return rejected(mutant.createInternalYidaDraftTransactionWriter({ security: f.security, context: scope })(trx, input), 'UNAVAILABLE')
  }), error => error instanceof assert.AssertionError && /Missing expected rejection/.test(error.message))
  console.log('MUTATION private-writer-structured-transaction: RED (Missing expected rejection)')
})
