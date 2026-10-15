'use strict'
const assert = require('node:assert/strict')
const { test } = require('node:test')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')
const { createYidaCredentialMaterialStore } = require('../lib/yida-credential-material-store.cjs')
const modules = Promise.all(['yida-approved-target-store.mjs', 'yida-draft-plan-store.mjs', 'yida-static-plan.mjs']
  .map(name => import(pathToFileURL(path.resolve(__dirname, '../lib', name)).href)))
const TARGET = 'integration_yida_approved_target', AUDIT = 'integration_yida_approved_target_audit'
const DRAFT_TARGET = 'integration_yida_draft_targets', OP = 'integration_yida_draft_operations'
const ROW = 'integration_yida_draft_rows', DRAFT_AUDIT = 'integration_yida_draft_audit'
const MATERIAL = 'integration_yida_credential_materials', MATERIAL_AUDIT = 'integration_yida_credential_audit'
const scope = { tenantId: 'synthetic-tenant', workspaceId: null, ownerId: 'synthetic-owner' }
const attestation = () => ({ kind: 'owner-reviewed-target', reviewRef: 'synthetic-review',
  organizationId: 'synthetic-organization', executionIdentity: 'synthetic-executor' })
const secrets = () => ({ appKey: 'synthetic-key', appSecret: 'synthetic-secret', systemToken: 'synthetic-system', userId: 'synthetic-executor' })
async function example(variant) {
  const [, , planner] = await modules, value = planner.createYidaProtocolExample(variant)
  return { config: value.config, rowsText: value.text, allocation: { mode: 'original' } }
}
async function rejected(promise, code = 'UNAVAILABLE') {
  await assert.rejects(promise, error => {
    assert.equal(error.code, 'YIDA_APPROVED_TARGET_' + code)
    assert.equal(error.message, error.code)
    assert.deepEqual(Object.keys(error).sort(), ['code', 'name'])
    return true
  })
}
// Unit transaction fake only. Real PG locks, constraints and host enc: are
// exercised in the dedicated whole-file realDB suite without replacing stores.
async function fixture() {
  const [{ createYidaApprovedTargetStore }, { createYidaDraftPlanStore }] = await modules
  let state = Object.fromEntries([TARGET, AUDIT, DRAFT_TARGET, OP, ROW, DRAFT_AUDIT, MATERIAL, MATERIAL_AUDIT].map(key => [key, []]))
  const calls = [], faults = { audit: false, commit: false }
  const matches = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value)
  const db = { async transaction(callback) {
    calls.push('BEGIN')
    const staged = structuredClone(state)
    let isolated = false
    const note = (kind, table) => { assert(isolated); calls.push(kind + ':' + table) }
    const trx = {
      async setTransactionIsolationLevel(level) { assert.equal(level, 'read committed'); isolated = true; calls.push('RC') },
      async select(table, { where, orderBy, limit = 1000 }) {
        note('select', table)
        const found = staged[table].filter(row => matches(row, where))
        if (orderBy) found.sort((a, b) => a[orderBy[0]] - b[orderBy[0]])
        return { rows: structuredClone(found.slice(0, limit)) }
      },
      async selectOne(table, where) { note('one', table); return structuredClone(staged[table].find(row => matches(row, where)) ?? null) },
      async selectOneForUpdate(table, where) { note('lock', table); return structuredClone(staged[table].find(row => matches(row, where)) ?? null) },
      async insertOne(table, row) {
        note('insert', table)
        if (table === AUDIT && faults.audit) throw new Error('SYNTHETIC_PRIVATE_DETAIL')
        staged[table].push(structuredClone(row)); return [structuredClone(row)]
      },
      async updateRow(table, set, where) {
        note('update', table)
        const row = staged[table].find(value => matches(value, where))
        if (!row) return []
        Object.assign(row, set); return [structuredClone(row)]
      },
    }
    const result = await callback(trx)
    state = staged; calls.push('COMMIT')
    if (faults.commit) { faults.commit = false; throw new Error('SYNTHETIC_LOST_COMMIT_REPLY') }
    return result
  } }
  const security = { async encrypt(text) { return 'enc:' + Buffer.from(text).toString('base64') },
    async decrypt(value) { return Buffer.from(value.slice(4), 'base64').toString() } }
  function stores(context = scope) {
    return { target: createYidaApprovedTargetStore({ db, security, context }),
      draft: createYidaDraftPlanStore({ db, security, context }),
      material: createYidaCredentialMaterialStore({ db, security, context }) }
  }
  const local = stores()
  async function request(input = undefined, chosen = local) {
    const draft = await chosen.draft.createDraft(input || await example()), material = await chosen.material.create({ material: secrets() })
    return { operationId: draft.operationId, credentialRef: material.credentialRef,
      credentialGeneration: material.credentialGeneration, attestation: attestation() }
  }
  return { ...local, stores, request, faults, calls, security, db,
    snapshot: () => structuredClone(state), edit: fn => fn(state),
    readCipher: value => JSON.parse(Buffer.from(value.slice(4), 'base64').toString()),
    writeCipher: value => 'enc:' + Buffer.from(JSON.stringify(value)).toString('base64') }
}

test('internal human-attested singleton binds real replay and 090 metadata without conferring host authority', async () => {
  const f = await fixture(), request = await f.request(); f.calls.length = 0
  const made = await f.target.register(request)
  assert.deepEqual(Object.keys(f.target).sort(), ['inspect', 'register'])
  assert.deepEqual(Object.keys(f.draft).sort(), ['createDraft', 'inspect', 'replay'])
  assert.match(made.targetRef, /^[0-9a-f-]{36}$/)
  assert.equal(made.status, 'manually_confirmed'); assert.equal(made.evidenceStatus, 'current')
  assert.equal(made.identityKind, 'owner-attested-single-target'); assert.equal(made.reused, false)
  for (const field of ['canSend', 'canApply', 'tokenIssued', 'externalWriteAttempted']) assert.equal(made[field], false)
  assert.equal(Object.isFrozen(made), true)
  assert.equal(f.calls.filter(call => call === 'BEGIN').length, 1)
  assert.equal(f.calls.filter(call => call === 'RC').length, 1)
  assert.deepEqual(f.calls.filter(call => call.startsWith('lock:')), [TARGET, MATERIAL, DRAFT_TARGET, OP].map(table => 'lock:' + table))
  assert.equal(/organization|executionIdentity|credential|digest|formUuid|locator|attestation/.test(JSON.stringify(made)), false)
  assert.equal(f.snapshot()[TARGET][0].slot, 1); assert.equal(f.snapshot()[AUDIT].length, 1)
  const saved = JSON.stringify(f.snapshot()[TARGET])
  assert.equal(saved.includes('synthetic-organization'), false); assert.equal(saved.includes('synthetic_stock_form'), false)
  assert.notEqual(made.targetRef, (await f.draft.inspect({ operationId: request.operationId })).targetRef)
  assert.equal((await f.draft.replay({ operationId: request.operationId })).canSend, false)
  assert.deepEqual(await f.target.inspect(), (({ reused, ...view }) => view)(made))
})

test('restart, same request, renamed sources and changed rows preserve the sole target identity and one audit', async () => {
  const f = await fixture(), request = await f.request(), one = await f.target.register(request)
  const aliases = await example('renamed'), renamed = await f.draft.createDraft(aliases)
  const two = await f.stores().target.register({ ...request, operationId: renamed.operationId })
  const changed = await example(), rows = JSON.parse(changed.rowsText); rows[0].quantity = 17
  changed.rowsText = JSON.stringify(rows)
  const another = await f.draft.createDraft(changed)
  const three = await f.target.register({ ...request, operationId: another.operationId })
  assert.equal(two.targetRef, one.targetRef); assert.equal(three.targetRef, one.targetRef)
  assert.equal(two.reused && three.reused, true)
  assert.equal(f.snapshot()[TARGET].length, 1); assert.equal(f.snapshot()[AUDIT].length, 1)
  assert.equal(f.snapshot()[TARGET][0].operation_id, request.operationId)
})

test('foreign owner/tenant, locator, changed human proof or replacement credentials cannot fork the slot', async () => {
  const f = await fixture(), request = await f.request(); await f.target.register(request)
  for (const context of [{ ...scope, tenantId: 'synthetic-other' }, { ...scope, ownerId: 'synthetic-other' }]) {
    const foreign = f.stores(context), input = await example(); input.config.target.formUuid = 'synthetic-other'
    const competing = await f.request(input, foreign)
    await rejected(foreign.target.register(competing), 'CONFLICT'); await rejected(foreign.target.inspect(), 'NOT_FOUND')
  }
  const changed = await example(); changed.config.target.formUuid = 'synthetic-new-form'
  const other = await f.draft.createDraft(changed)
  await rejected(f.target.register({ ...request, operationId: other.operationId }), 'CONFLICT')
  for (const key of ['organizationId', 'executionIdentity', 'reviewRef']) {
    await rejected(f.target.register({ ...request, attestation: { ...request.attestation, [key]: 'synthetic-changed' } }), 'CONFLICT')
  }
  const replacement = await f.material.create({ material: secrets() })
  await rejected(f.target.register({ ...request, credentialRef: replacement.credentialRef }), 'CONFLICT')
  assert.equal(f.snapshot()[TARGET].length, 1); assert.equal(f.snapshot()[AUDIT].length, 1)
  assert.throws(() => f.stores({ ...scope, workspaceId: 'synthetic-workspace' }), { code: 'YIDA_APPROVED_TARGET_INPUT' })
})

test('material revocation/generation rejects initial registration, and rotation invalidates evidence without clearing slot', async () => {
  const f = await fixture(), request = await f.request()
  await rejected(f.target.register({ ...request, credentialGeneration: 2 }), 'CONFLICT')
  await f.material.revoke({ credentialRef: request.credentialRef, expectedGeneration: 1 })
  await rejected(f.target.register(request), 'CONFLICT')
  assert.equal(f.snapshot()[TARGET].length, 0)
  await f.material.rotate({ credentialRef: request.credentialRef, expectedGeneration: 1, material: secrets() })
  const active = { ...request, credentialGeneration: 2 }, made = await f.target.register(active)
  await f.material.rotate({ credentialRef: request.credentialRef, expectedGeneration: 2, material: secrets() })
  const stale = await f.target.inspect()
  assert.equal(stale.evidenceStatus, 'invalidated'); assert.equal(stale.targetRef, made.targetRef); assert.equal(stale.canSend, false)
  await rejected(f.target.register(active), 'CONFLICT')
  await rejected(f.target.register({ ...active, credentialGeneration: 3 }), 'CONFLICT')
  assert.equal(f.snapshot()[TARGET].length, 1)
})

test('actual full 091 replay rejects altered source, plan, row membership and target envelope before registration', async () => {
  for (const variant of ['source', 'plan', 'member', 'target']) {
    const f = await fixture(), request = await f.request()
    f.edit(state => {
      const envelope = f.readCipher(state[OP][0].snapshot_encrypted)
      if (variant === 'source') envelope.source.rowsText = '[]'
      if (variant === 'plan') envelope.plan.canApply = true
      if (variant === 'member') state[ROW].pop()
      if (variant === 'target') state[DRAFT_TARGET][0].target_encrypted = 'enc:invalid'
      state[OP][0].snapshot_encrypted = f.writeCipher(envelope)
    })
    await rejected(f.target.register(request)); assert.equal(f.snapshot()[TARGET].length, 0)
  }
})

test('sealed evidence binds exact owner, slot, identity, material and fixed key definition', async () => {
  for (const [key, changed] of [['ownerId', 'synthetic-other'], ['targetRef', 'synthetic-other'], ['credentialGeneration', 2],
    ['slot', 2], ['purpose', 'wrong-purpose'], ['keyDefinition', { algorithm: 'changed', fields: [] }]]) {
    const f = await fixture(), request = await f.request(); await f.target.register(request)
    f.edit(state => { const row = state[TARGET][0], value = f.readCipher(row.evidence_encrypted)
      value[key] = changed; row.evidence_encrypted = f.writeCipher(value) })
    await rejected(f.target.inspect(), key === 'keyDefinition' ? 'CONFLICT' : 'UNAVAILABLE')
  }
})

test('audit failure rolls back and lost commit response recovers one permanent identity without retrying writes', async () => {
  const f = await fixture(), request = await f.request(); f.faults.audit = true
  await rejected(f.target.register(request)); assert.equal(f.snapshot()[TARGET].length, 0)
  f.faults.audit = false; f.faults.commit = true; f.calls.length = 0
  await rejected(f.target.register(request))
  assert.equal(f.calls.filter(call => call === 'BEGIN').length, 1)
  const committed = f.snapshot()[TARGET][0].target_ref
  const recovered = await f.stores().target.register(request)
  assert.equal(recovered.targetRef, committed); assert.equal(recovered.reused, true)
  assert.equal(f.snapshot()[AUDIT].length, 1)
})

test('closed input rejects caller digests, verified flags, locator, proxies and accessor attestation without invoking getters', async () => {
  const f = await fixture(), request = await f.request()
  for (const key of ['verified', 'locator', 'keyDefinitionDigest', 'targetRef']) {
    await rejected(f.target.register({ ...request, [key]: true }), 'INPUT')
  }
  let calls = 0
  const accessor = { ...attestation(), get organizationId() { calls++; return 'synthetic' } }
  await rejected(f.target.register({ ...request, attestation: accessor }), 'INPUT')
  await rejected(f.target.register({ ...request, attestation: new Proxy(attestation(), {}) }), 'INPUT')
  await rejected(f.target.register({ ...request, attestation: { ...attestation(), reviewRef: 'x'.repeat(129) } }), 'INPUT')
  assert.equal(calls, 0); assert.equal(f.snapshot()[TARGET].length, 0)
})

function assertClosedError(value, code = 'UNAVAILABLE') {
  const expected = 'YIDA_APPROVED_TARGET_' + code
  assert.equal(Object.getOwnPropertyDescriptor(value, 'code')?.value, expected)
  assert.equal(Object.getOwnPropertyDescriptor(value, 'message')?.value, expected)
  assert.deepEqual(Object.keys(value).sort(), ['code', 'name'])
  assert.equal(Object.hasOwn(value, 'cause'), false)
  assert.equal(JSON.stringify(value).includes('SYNTHETIC_PRIVATE_EXCEPTION_SENTINEL'), false)
}

test('actual inspect/register transaction boundary closes arbitrary driver rejections without touching proxy/getter traps', async () => {
  const f = await fixture(), request = await f.request()
  let traps = 0
  const privateDetail = 'SYNTHETIC_PRIVATE_EXCEPTION_SENTINEL'
  const hostile = new Proxy({}, {
    getPrototypeOf() { traps++; throw new Error(privateDetail) },
    get() { traps++; throw new Error(privateDetail) },
  })
  const revoked = Proxy.revocable({}, {}); revoked.revoke()
  const accessor = {}
  for (const key of ['code', 'message', 'cause', 'constructor']) {
    Object.defineProperty(accessor, key, { get() { traps++; throw new Error(privateDetail) } })
  }
  for (const refusal of [undefined, null, privateDetail, 42, Symbol(privateDetail), hostile, revoked.proxy, accessor]) {
    f.db.transaction = async () => { throw refusal }
    for (const call of [() => f.target.inspect(), () => f.target.register(request)]) {
      let caught
      try { await call() } catch (error) { caught = error }
      assertClosedError(caught)
    }
  }
  assert.equal(traps, 0)
})

test('exported error constructor and actual transaction catch clamp unknown codes to fixed unavailable', async () => {
  const [{ YidaApprovedTargetError }] = await modules
  const f = await fixture(), request = await f.request()
  let coercions = 0
  const hostileCode = { toString() { coercions++; throw new Error('SYNTHETIC_PRIVATE_EXCEPTION_SENTINEL') } }
  for (const code of ['SYNTHETIC_PRIVATE_EXCEPTION_SENTINEL', undefined, hostileCode]) {
    const refusal = new YidaApprovedTargetError(code)
    f.db.transaction = async () => { throw refusal }
    for (const call of [() => f.target.inspect(), () => f.target.register(request)]) {
      let caught
      try { await call() } catch (error) { caught = error }
      assertClosedError(caught)
      assert.notEqual(caught, refusal)
    }
    assertClosedError(refusal)
  }
  assert.equal(coercions, 0)
})

test('module-created driver error is reconstructed from its private code without reading mutated public fields', async () => {
  const [{ YidaApprovedTargetError }] = await modules
  const f = await fixture(), request = await f.request()
  let traps = 0
  const refusal = new YidaApprovedTargetError('CONFLICT')
  for (const key of ['code', 'message', 'cause']) {
    Object.defineProperty(refusal, key, { get() { traps++; throw new Error('SYNTHETIC_PRIVATE_EXCEPTION_SENTINEL') } })
  }
  f.db.transaction = async () => { throw refusal }
  for (const call of [() => f.target.inspect(), () => f.target.register(request)]) {
    let caught
    try { await call() } catch (error) { caught = error }
    assertClosedError(caught, 'CONFLICT')
    assert.notEqual(caught, refusal)
  }
  assert.equal(traps, 0)
})

test('private target writer shares registration and existing alias replay inside one caller-owned transaction', async () => {
  const [{ createInternalYidaApprovedTargetTransactionWriter }, { createInternalYidaDraftTransactionWriter }] = await modules
  const { createInternalYidaCredentialTransactionWriter } = require('../lib/yida-credential-material-store.cjs')
  const f = await fixture(), value = await example()
  const options = { security: f.security, context: scope }
  const materialWriter = createInternalYidaCredentialTransactionWriter(options)
  const draftWriter = createInternalYidaDraftTransactionWriter(options)
  const targetWriter = createInternalYidaApprovedTargetTransactionWriter(options)
  assert.throws(() => createInternalYidaApprovedTargetTransactionWriter({ ...options, db: f.db }), { code: 'YIDA_APPROVED_TARGET_INPUT' })
  f.calls.length = 0
  const made = await f.db.transaction(async trx => {
    await trx.setTransactionIsolationLevel('read committed')
    const material = await materialWriter(trx, { material: secrets() }), draft = await draftWriter(trx, value)
    const registered = await targetWriter(trx, { operationId: draft.operationId, credentialRef: material.credentialRef,
      credentialGeneration: 1, attestation: attestation() })
    assert.deepEqual(f.snapshot()[TARGET], [])
    return registered
  })
  assert.equal(Object.isFrozen(made), true)
  assert.equal(f.calls.filter(call => call === 'BEGIN').length, 1)
  assert.equal(f.calls.filter(call => call === 'RC').length, 1)
  assert.equal(f.calls.filter(call => call === 'COMMIT').length, 1)
  assert.deepEqual(await f.target.inspect(), (({ reused, ...rest }) => rest)(made))
  const original = f.snapshot()[TARGET][0], alias = await f.draft.createDraft(await example('renamed'))
  const reused = await f.db.transaction(async trx => {
    await trx.setTransactionIsolationLevel('read committed')
    return targetWriter(trx, { operationId: alias.operationId, credentialRef: original.credential_ref,
      credentialGeneration: 1, attestation: attestation() })
  })
  assert.equal(reused.reused, true); assert.equal(reused.targetRef, made.targetRef)
  assert.equal(f.snapshot()[TARGET][0].operation_id, original.operation_id)
  assert.equal(f.snapshot()[AUDIT].length, 1)
})

test('private target writer requires own-data host CRUD and closes hostile insertion errors without retry or trap access', async () => {
  const [{ createInternalYidaApprovedTargetTransactionWriter }] = await modules
  const f = await fixture(), request = await f.request(), writer = createInternalYidaApprovedTargetTransactionWriter({ security: f.security, context: scope })
  let traps = 0
  const hostile = new Proxy({}, { get() { traps++; throw new Error('SYNTHETIC_PRIVATE_EXCEPTION_SENTINEL') }, getPrototypeOf() { traps++; throw new Error('SYNTHETIC_PRIVATE_EXCEPTION_SENTINEL') } })
  const accessor = {}
  for (const field of ['code', 'constraint']) Object.defineProperty(accessor, field, { get() { traps++; return field === 'code' ? '23505' : 'integration_yida_approved_target_pkey' } })
  await f.db.transaction(async trx => {
    await trx.setTransactionIsolationLevel('read committed')
    const getter = { ...trx }; Object.defineProperty(getter, 'insertOne', { get() { traps++; return trx.insertOne } })
    for (const invalid of [null, [], { query() {} }, Object.create(trx), getter, new Proxy(trx, {})]) await rejected(writer(invalid, request))
    for (const refusal of [undefined, null, hostile, accessor, { code: '23505', constraint: 'other_constraint' }]) {
      let inserts = 0
      await rejected(writer({ ...trx, async insertOne() { inserts++; throw refusal } }, request))
      assert.equal(inserts, 1)
    }
    const caught = []
    for (let count = 0; count < 2; count++) {
      try { await writer({ ...trx, async insertOne() { throw { code: '23505', constraint: 'integration_yida_approved_target_pkey' } } }, request) }
      catch (error) { assertClosedError(error, 'CONFLICT'); caught.push(error) }
    }
    assert.notEqual(caught[0], caught[1], 'private race identity must not escape')
  })
  assert.equal(traps, 0)
  assert.equal(f.snapshot()[TARGET].length, 0)
})

test('public registration retries only the exact slot INSERT race and never a shaped lost COMMIT rejection', async () => {
  const f = await fixture(), request = await f.request(), original = f.db.transaction
  let transactions = 0, raced = false
  f.db.transaction = async callback => {
    transactions++
    return original(trx => callback({ ...trx, async insertOne(table, row) {
      if (table === TARGET && !raced) { raced = true; throw { code: '23505', constraint: 'integration_yida_approved_target_pkey' } }
      return trx.insertOne(table, row)
    } }))
  }
  assert.equal((await f.target.register(request)).reused, false)
  assert.equal(transactions, 2)
  const fresh = await fixture(), wanted = await fresh.request(), commit = fresh.db.transaction
  let attempts = 0
  fresh.db.transaction = async callback => {
    attempts++; await commit(callback)
    throw { code: '23505', constraint: 'integration_yida_approved_target_pkey' }
  }
  await rejected(fresh.target.register(wanted))
  assert.equal(attempts, 1); assert.equal(fresh.snapshot()[TARGET].length, 1)
})

async function targetMutation(from, to) {
  const filename = path.resolve(__dirname, '../lib/yida-approved-target-store.mjs')
  const source = fs.readFileSync(filename, 'utf8').replace(/from '\.\/([^']+)'/g,
    (_match, file) => `from '${pathToFileURL(path.resolve(path.dirname(filename), file)).href}'`)
  assert.equal(source.split(from).length, 2, 'mutation must match exactly once')
  return import('data:text/javascript;base64,' + Buffer.from(source.replace(from, to)).toString('base64'))
}

test('memory mutations prove private target host shape, error closure, race identity and precise race guards are necessary', async () => {
  const hostGuard = "    if (!trx || typeof trx !== 'object' || types.isProxy(trx) || Array.isArray(trx)\n      || ['select', 'selectOne', 'selectOneForUpdate', 'insertOne'].some(key => {\n        const property = Object.getOwnPropertyDescriptor(trx, key)\n        return !property || !Object.hasOwn(property, 'value') || typeof property.value !== 'function'\n      })) fail('UNAVAILABLE')"
  const mutated = await targetMutation(hostGuard, ''), f = await fixture(), request = await f.request()
  const writer = mutated.createInternalYidaApprovedTargetTransactionWriter({ security: f.security, context: scope })
  await f.db.transaction(async trx => {
    await trx.setTransactionIsolationLevel('read committed')
    await assert.rejects(() => rejected(writer(Object.create(trx), request)), assert.AssertionError)
  })
  console.log('MUTATION target host-handle guard removed: baseline negative assertion RED (inherited handle accepted)')
  const boundary = "      catch (error) { fail(ownErrors.get(error) || 'UNAVAILABLE') }"
  const escaped = await targetMutation(boundary, '      catch (error) { throw error }'), other = await fixture(), wanted = await other.request()
  const unsafe = escaped.createInternalYidaApprovedTargetTransactionWriter({ security: other.security, context: scope })
  await other.db.transaction(async trx => {
    await trx.setTransactionIsolationLevel('read committed')
    await assert.rejects(() => rejected(unsafe({ ...trx, async insertOne() { throw new Error('SYNTHETIC_PRIVATE_EXCEPTION_SENTINEL') } }, wanted)), assert.AssertionError)
    const races = []
    for (let index = 0; index < 2; index++) {
      try { await unsafe({ ...trx, async insertOne() { throw { code: '23505', constraint: 'integration_yida_approved_target_pkey' } } }, wanted) }
      catch (error) { races.push(error) }
    }
    assert.throws(() => assert.notEqual(races[0], races[1]), assert.AssertionError)
  })
  console.log('MUTATION target private error closure removed: baseline negative assertion RED (driver error and SLOT_RACE identity escaped)')
  for (const [name, from, to, refusal] of [
    ['proxy', "if (!error || typeof error !== 'object' || types.isProxy(error)) return false", "if (!error || typeof error !== 'object') return false", new Proxy({ code: '23505', constraint: 'integration_yida_approved_target_pkey' }, {})],
    ['constraint', "    && Object.getOwnPropertyDescriptor(error, 'constraint')?.value === 'integration_yida_approved_target_pkey'", '', { code: '23505', constraint: 'other_constraint' }],
    ['code', "Object.getOwnPropertyDescriptor(error, 'code')?.value === '23505'", 'true', { code: '40001', constraint: 'integration_yida_approved_target_pkey' }],
  ]) {
    const api = await targetMutation(from, to), local = await fixture(), input = await local.request()
    const write = api.createInternalYidaApprovedTargetTransactionWriter({ security: local.security, context: scope })
    await local.db.transaction(async trx => {
      await trx.setTransactionIsolationLevel('read committed')
      await assert.rejects(() => rejected(write({ ...trx, async insertOne() { throw refusal } }, input)), assert.AssertionError)
    })
    console.log(`MUTATION target precise slot race ${name} guard removed: baseline negative assertion RED (foreign rejection classified CONFLICT)`)
  }
  const factory = "    const parsed = record(options, ['security', 'context'])\n    return createApprovedTargetInternals(parsed).registerInTransaction"
  const open = await targetMutation(factory, '    const parsed = options\n    return createApprovedTargetInternals(parsed).registerInTransaction'), local = await fixture()
  assert.throws(() => assert.throws(() => open.createInternalYidaApprovedTargetTransactionWriter({ db: local.db, security: local.security, context: scope }), { code: 'YIDA_APPROVED_TARGET_INPUT' }), assert.AssertionError)
  console.log('MUTATION target private factory closed options removed: baseline negative assertion RED (db capability admitted)')
  for (const field of ['code', 'constraint']) {
    const api = await targetMutation(`Object.getOwnPropertyDescriptor(error, '${field}')?.value`, `error.${field}`)
    const f = await fixture(), input = await f.request()
    const write = api.createInternalYidaApprovedTargetTransactionWriter({ security: f.security, context: scope })
    let traps = 0
    const refusal = { code: '23505', constraint: 'integration_yida_approved_target_pkey' }
    Object.defineProperty(refusal, field, { get() { traps++; return field === 'code' ? '23505' : 'integration_yida_approved_target_pkey' } })
    await f.db.transaction(async trx => {
      await trx.setTransactionIsolationLevel('read committed')
      try { await write({ ...trx, async insertOne() { throw refusal } }, input) } catch {}
    })
    assert.throws(() => assert.equal(traps, 0), assert.AssertionError)
    console.log(`MUTATION target slot race ${field} own-data read removed: baseline zero-trap assertion RED (getter invoked)`)
  }
})
