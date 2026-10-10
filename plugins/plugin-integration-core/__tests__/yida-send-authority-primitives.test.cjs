'use strict'
const assert = require('node:assert/strict')
const { test } = require('node:test')
const { randomBytes, randomUUID, createCipheriv, createDecipheriv, createHash } = require('node:crypto')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')
const { stableCanonicalStringify } = require('../lib/gip-canonical-json.cjs')
const { createDb } = require('../lib/db.cjs')
const { createInternalYidaCredentialCurrentAsserter, createInternalYidaCredentialExecutionReader } = require('../lib/yida-credential-material-store.cjs')
const modules = Promise.all(['yida-send-authority-primitives.mjs', 'yida-draft-plan.mjs', 'yida-static-plan.mjs']
  .map(name => import(pathToFileURL(path.resolve(__dirname, '../lib', name)).href)))
const TARGET = 'integration_yida_approved_target', MATERIAL = 'integration_yida_credential_materials'
const DRAFT = 'integration_yida_draft_targets', OP = 'integration_yida_draft_operations', ROWS = 'integration_yida_draft_rows'
const LEDGER = 'integration_yida_delivery_ledger', AUDIT = 'integration_yida_delivery_audit'
const DRAFT_AUDIT = 'integration_yida_draft_audit'
const context = { tenantId: 'synthetic-tenant', workspaceId: null, ownerId: 'synthetic-owner' }
const bundle = () => ({ appKey: 'synthetic-key', appSecret: 'synthetic-secret', systemToken: 'synthetic-system', userId: 'synthetic-executor' })
const grant = () => ({ grantRef: 'synthetic-grant', expiresAt: 2000000000000, actorId: context.ownerId })

async function rejected(promise, code = 'UNAVAILABLE') {
  await assert.rejects(promise, error => {
    assert.equal(error.code, 'YIDA_SEND_AUTHORITY_' + code)
    assert.equal(error.message, error.code)
    assert.deepEqual(Object.keys(error).sort(), ['code', 'name'])
    assert.equal(Object.hasOwn(error, 'cause'), false)
    return true
  })
}
function prepared(selection, payloadDigest) {
  return Object.fromEntries([...Object.keys(context), 'operationId', 'rowKey', 'targetRef', 'targetRevision', 'planRevision',
    'businessKeyDigest', 'credentialRef', 'credentialGeneration'].map(key => [key, selection[key]])
    .concat([['payloadDigest', payloadDigest], ['intent', 'create']]))
}

// Unit raw-driver fixture only. All SQL is emitted by actual db.cjs, and all
// verification uses actual stores/planners. This object has no transaction or
// isolation fake: BEGIN/SET/COMMIT are rejected. Atomicity/locks are PG proofs.
async function fixture(mode = 'original', alternateFactory) {
  const [{ createYidaSendAuthorityPrimitives }, { compileYidaDraft }, { createYidaProtocolExample }] = await modules
  const key = randomBytes(32), calls = [], state = Object.fromEntries([TARGET, MATERIAL, DRAFT, OP, ROWS, LEDGER, AUDIT, DRAFT_AUDIT].map(name => [name, []]))
  const faults = { query: null, audit: null, wrapped: true, onQuery: null }
  const security = {
    async encrypt(text) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
      return 'enc:' + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
    },
    async decrypt(value) {
      const data = Buffer.from(value.slice(4), 'base64'), decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12))
      decipher.setAuthTag(data.subarray(12, 28))
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8')
    },
  }
  const seal = value => security.encrypt(JSON.stringify(value))
  const unseal = async value => JSON.parse(await security.decrypt(value))
  const trx = { async query(sql, params = []) {
    calls.push(sql)
    if (faults.query) throw faults.query
    if (faults.onQuery) await faults.onQuery(sql)
    const table = /^(?:SELECT \* FROM|INSERT INTO) "([a-z_]+)"/.exec(sql)?.[1]
    assert(table && state[table], 'Only actual CRUD SQL is accepted; transaction/isolation SQL is forbidden')
    let result
    if (sql.startsWith('SELECT')) {
      const conditions = [...sql.matchAll(/"([a-z_]+)" (?:= \$(\d+)|(IS NULL))/g)]
      result = state[table].filter(row => conditions.every(([, column, index, nil]) => row[column] === (nil ? null : params[Number(index) - 1])))
      const order = /ORDER BY "([a-z_]+)" ASC/.exec(sql)
      if (order) result = [...result].sort((a, b) => a[order[1]] - b[order[1]])
      const limit = /LIMIT (\d+)/.exec(sql); if (limit) result = result.slice(0, Number(limit[1]))
    } else {
      if ((table === AUDIT || table === DRAFT_AUDIT) && faults.audit) throw faults.audit
      const columns = [.../\((.*?)\) VALUES/.exec(sql)[1].matchAll(/"([a-z_]+)"/g)].map(match => match[1])
      const row = Object.fromEntries(columns.map((column, index) => [column, params[index]]))
      state[table].push(row); result = [row]
    }
    return faults.wrapped ? { rows: structuredClone(result) } : structuredClone(result)
  } }
  async function addDraft(input) {
    const compiled = compileYidaDraft(input), targetRef = randomUUID(), operationId = randomUUID()
    const scope = { tenant_id: context.tenantId, workspace_id: null, owner_id: context.ownerId }
    const target = { target_ref: targetRef, ...scope, status: 'unverified', locator_digest: compiled.locatorDigest,
      key_definition_digest: compiled.keyDefinitionDigest,
      target_encrypted: await seal({ purpose: 'yida-draft-target', schemaVersion: 1, ...context, targetRef,
        locator: compiled.locator, keyDefinition: compiled.keyDefinition }) }
    const operation = { operation_id: operationId, target_ref: targetRef, plan_digest: compiled.planDigest,
      status: 'unverified', row_count: compiled.rowSpecs.length,
      snapshot_encrypted: await seal({ purpose: 'yida-draft-operation', schemaVersion: 1, ...context, targetRef,
        operationId, planDigest: compiled.planDigest, source: compiled.source, plan: compiled.plan }) }
    const members = compiled.rowSpecs.map(row => ({ row_key: randomUUID(), operation_id: operationId, ordinal: row.index,
      business_key_digest: row.businessKeyDigest, payload_digest: row.payloadDigest }))
    state[DRAFT].push(target); state[OP].push(operation); state[ROWS].push(...members)
    return { compiled, target, operation, members }
  }
  const example = createYidaProtocolExample(), source = { config: example.config, rowsText: example.text, allocation: { mode: 'original' } }
  if (mode !== 'original') {
    const parsed = JSON.parse(source.rowsText); parsed[0].quantity = 6; parsed[1].quantity = 3
    source.rowsText = JSON.stringify(parsed)
    source.allocation = { mode, projects: mode === 'equal_integer' ? ['SYN-A', 'SYN-B', 'SYN-C'] : ['SYN-A', 'SYN-B'],
      projectField: 'projectNo', quantityField: 'quantity' }
  }
  const draft = await addDraft(source), credentialRef = randomUUID(), targetRef = randomUUID()
  state[MATERIAL].push({ credential_ref: credentialRef, tenant_id: context.tenantId, workspace_id: null,
    owner_id: context.ownerId, generation: 1, status: 'current', material_encrypted: await seal({
      purpose: 'yida-credential-material', schemaVersion: 1, ...context, credentialRef, credentialGeneration: 1, material: bundle() }) })
  const target = { slot: 1, target_ref: targetRef, tenant_id: context.tenantId, workspace_id: null, owner_id: context.ownerId,
    evidence_version: 1, status: 'manually_confirmed', operation_id: draft.operation.operation_id, draft_target_ref: draft.target.target_ref,
    plan_digest: draft.compiled.planDigest, locator_digest: draft.compiled.locatorDigest, key_definition_digest: draft.compiled.keyDefinitionDigest,
    credential_ref: credentialRef, credential_generation: 1 }
  target.evidence_encrypted = await seal({ purpose: 'yida-approved-target', schemaVersion: 1, ...context, slot: 1, targetRef,
    evidenceVersion: 1, operationId: target.operation_id, draftTargetRef: target.draft_target_ref,
    planDigest: target.plan_digest, locatorDigest: target.locator_digest, keyDefinitionDigest: target.key_definition_digest,
    credentialRef, credentialGeneration: 1, locator: draft.compiled.locator, keyDefinition: draft.compiled.keyDefinition,
    attestation: { kind: 'owner-reviewed-target', reviewRef: 'synthetic-review', organizationId: 'synthetic-org', executionIdentity: 'synthetic-executor' } })
  state[TARGET].push(target)
  const fresh = (scope = context, hostSecurity = security) => (alternateFactory || createYidaSendAuthorityPrimitives)({ security: hostSecurity, context: scope })
  const port = fresh(), selection = (which = draft, ordinal = 0) => ({ operationId: which.operation.operation_id, rowKey: which.members[ordinal].row_key })
  return { port, fresh, trx, security, state, calls, faults, draft, source, selection, addDraft, seal, unseal }
}

for (const mode of ['original', 'equal_integer', 'equal_decimal_exact']) {
  test(`actual full ${mode} selection uses allocated execution rows and never controls the host transaction`, async () => {
    const f = await fixture(mode), index = mode === 'original' ? 0 : 2
    const selected = await f.port.resolveSelectionInTransaction(f.trx, f.selection(f.draft, index))
    assert.deepEqual(Object.keys(f.port).sort(), ['executionPayloadDigest', 'loadExecutionMaterialInTransaction',
      'prepareDraftInTransaction', 'prepareInTransaction', 'previewInTransaction', 'resolveSelectionInTransaction'])
    assert.equal(Object.isFrozen(selected) && Object.isFrozen(selected.selectedRow) && Object.isFrozen(selected.plan.rows), true)
    assert.deepEqual(Object.keys(selected).sort(), ['tenantId', 'workspaceId', 'ownerId', 'operationId', 'rowKey', 'targetRef',
      'targetRevision', 'planRevision', 'credentialRef', 'credentialGeneration', 'businessKeyDigest', 'rowPayloadDigest', 'planDigest',
      'config', 'selectedRow', 'source', 'plan'].sort())
    assert.equal(selected.targetRef, f.state[TARGET][0].target_ref)
    assert.notEqual(selected.targetRef, f.draft.target.target_ref)
    assert.equal(selected.targetRevision, 'evidence-1'); assert.equal(selected.planRevision, f.draft.compiled.planDigest)
    assert.equal(selected.businessKeyDigest, f.draft.members[index].business_key_digest)
    assert.equal(selected.rowPayloadDigest, f.draft.members[index].payload_digest)
    const [, , { buildYidaStaticPlan }] = await modules
    const actual = buildYidaStaticPlan({ config: selected.config, rows: [selected.selectedRow] }).rows[0]
    assert.deepEqual(actual.payload, f.draft.compiled.plan.rows[index].payload)
    assert.equal(actual.localBusinessKey, f.draft.compiled.plan.rows[index].localBusinessKey)
    if (mode === 'equal_integer') assert.equal(selected.selectedRow.quantity, 2)
    if (mode === 'equal_decimal_exact') assert.equal(selected.selectedRow.quantity, 1.5)
    if (mode !== 'original') assert.equal(JSON.parse(selected.source.rowsText)[index], undefined)
    const locks = f.calls.filter(sql => sql.endsWith('FOR UPDATE')).map(sql => /FROM "([a-z_]+)"/.exec(sql)[1])
    assert.deepEqual(locks, [TARGET, MATERIAL, DRAFT, OP, DRAFT, OP])
    assert.equal(f.calls.every(sql => sql.startsWith('SELECT ')), true)
    assert.equal(/synthetic-secret|synthetic-system|synthetic-executor|appKey|appSecret|systemToken|userId/.test(JSON.stringify(selected)), false)
    assert.equal(Object.hasOwn(selected, 'canSend'), false)
  })
}

test('execution digest is the original runner formula, binds grant and requires this port actual selection object', async () => {
  const f = await fixture('equal_integer'), selected = await f.port.resolveSelectionInTransaction(f.trx, f.selection(f.draft, 2))
  const authorization = grant(), payload = selected.plan.rows[2], intent = 'create'
  const data = { ...payload.protocolPreview.data, formDataJson: stableCanonicalStringify(payload.payload) }
  const expected = createHash('sha256').update(stableCanonicalStringify({
    version: 1, grantRef: authorization.grantRef, expiresAt: authorization.expiresAt,
    actorId: authorization.actorId, targetRef: selected.targetRef, targetRevision: selected.targetRevision,
    planRevision: selected.planRevision, intent, data, formUuid: selected.config.target.formUuid,
  })).digest('hex')
  assert.equal(f.port.executionPayloadDigest(selected, authorization), expected)
  assert.notEqual(f.port.executionPayloadDigest(selected, { ...authorization, grantRef: 'synthetic-other-grant' }), expected)
  assert.notEqual(f.port.executionPayloadDigest(selected, { ...authorization, expiresAt: authorization.expiresAt + 1 }), expected)
  assert.throws(() => f.port.executionPayloadDigest(structuredClone(selected), authorization), { code: 'YIDA_SEND_AUTHORITY_INPUT' })
  assert.throws(() => f.fresh().executionPayloadDigest(selected, authorization), { code: 'YIDA_SEND_AUTHORITY_INPUT' })
  assert.throws(() => f.port.executionPayloadDigest(selected, { ...authorization, actorId: 'synthetic-other' }), { code: 'YIDA_SEND_AUTHORITY_CONFLICT' })
  assert.equal(f.state[LEDGER].length, 0)
})

test('private 090 current asserter verifies the full authenticated four-field envelope and returns metadata only', async () => {
  const f = await fixture(), row = f.state[MATERIAL][0]
  const assertCurrent = createInternalYidaCredentialCurrentAsserter({ security: f.security, context })
  const checked = await assertCurrent(createDb({ database: f.trx }), { credentialRef: row.credential_ref, credentialGeneration: 1 })
  assert.deepEqual(checked, { ...context, credentialRef: row.credential_ref, credentialGeneration: 1, status: 'current' })
  assert.equal(Object.isFrozen(checked), true)
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].endsWith('FOR UPDATE'), true)
  for (const name of ['appKey', 'appSecret', 'systemToken', 'userId']) {
    const envelope = await f.unseal(row.material_encrypted); envelope.material[name] = ' '
    row.material_encrypted = await f.seal(envelope)
    await rejected(f.port.resolveSelectionInTransaction(f.trx, f.selection()))
    envelope.material = bundle(); row.material_encrypted = await f.seal(envelope)
  }
})

test('revoked/wrong-generation/cross-scope 090 and transplanted authenticated envelopes fail before selected draft replay', async () => {
  for (const [field, value] of [['status', 'revoked'], ['generation', 2], ['tenant_id', 'synthetic-other'],
    ['owner_id', 'synthetic-other'], ['workspace_id', 'synthetic-workspace']]) {
    const f = await fixture(); f.state[MATERIAL][0][field] = value
    await rejected(f.port.resolveSelectionInTransaction(f.trx, f.selection()))
    assert.equal(f.calls.some(sql => sql.includes(`"${OP}"`)), false)
  }
  for (const [field, value] of [['purpose', 'wrong-domain'], ['credentialGeneration', 2], ['ownerId', 'synthetic-other'],
    ['credentialRef', 'synthetic-other'], ['workspaceId', 'synthetic-workspace']]) {
    const f = await fixture(), row = f.state[MATERIAL][0], envelope = await f.unseal(row.material_encrypted)
    envelope[field] = value; row.material_encrypted = await f.seal(envelope)
    await rejected(f.port.resolveSelectionInTransaction(f.trx, f.selection()))
  }
})

test('permanent target rejects foreign contexts, another selected locator/key definition and a row outside the chosen operation', async () => {
  const f = await fixture()
  for (const scope of [{ ...context, tenantId: 'synthetic-other' }, { ...context, ownerId: 'synthetic-other' }]) {
    await rejected(f.fresh(scope).resolveSelectionInTransaction(f.trx, f.selection()))
  }
  assert.throws(() => f.fresh({ ...context, workspaceId: 'synthetic-workspace' }), { code: 'YIDA_SEND_AUTHORITY_INPUT' })
  for (const kind of ['locator', 'key-definition']) {
    const source = structuredClone(f.source)
    if (kind === 'locator') source.config.target.formUuid = 'synthetic-other-form'
    else source.config.businessKey = source.config.businessKey.filter(field => field !== 'componentName')
    const other = await f.addDraft(source)
    await rejected(f.port.resolveSelectionInTransaction(f.trx, f.selection(other)), 'CONFLICT')
  }
  await rejected(f.port.resolveSelectionInTransaction(f.trx, { ...f.selection(), rowKey: randomUUID() }), 'NOT_FOUND')
})

test('selection independently replays original and selected complete snapshots and durable member sets', async () => {
  for (const variant of ['original-source', 'selected-plan', 'selected-member']) {
    const f = await fixture(), source = structuredClone(f.source), parsed = JSON.parse(source.rowsText)
    parsed[0].quantity = 19; source.rowsText = JSON.stringify(parsed)
    const selected = await f.addDraft(source)
    if (variant === 'selected-member') f.state[ROWS] = f.state[ROWS].filter(row => row.row_key !== selected.members[1].row_key)
    else {
      const row = variant === 'original-source' ? f.draft.operation : selected.operation
      const envelope = await f.unseal(row.snapshot_encrypted)
      if (variant === 'original-source') envelope.source.rowsText = '[]'
      else envelope.plan.canApply = true
      row.snapshot_encrypted = await f.seal(envelope)
    }
    await rejected(f.port.resolveSelectionInTransaction(f.trx, f.selection(selected)))
  }
})

test('private prepare runs actual 088 selection/insert/audit SQL in the supplied transaction and retains snapshot identity', async () => {
  const f = await fixture(), selected = await f.port.resolveSelectionInTransaction(f.trx, f.selection())
  const request = prepared(selected, f.port.executionPayloadDigest(selected, grant())); f.calls.length = 0
  const one = await f.port.prepareInTransaction(f.trx, request)
  assert.equal(one.reused, false); assert.equal(one.record.status, 'prepared'); assert.match(one.record.id, /^[0-9a-f-]{36}$/)
  assert.equal(Object.isFrozen(one) && Object.isFrozen(one.record), true)
  assert.deepEqual(Object.keys(one.record).sort(), ['id', ...Object.keys(context), 'operationId', 'rowKey', 'intent', 'status', 'createdAt', 'updatedAt'].sort())
  assert.equal(f.state[LEDGER][0].target_ref, selected.targetRef)
  assert.equal(f.state[LEDGER][0].payload_digest, request.payloadDigest)
  assert.equal(f.state[AUDIT][0].ledger_id, one.record.id)
  const two = await f.port.prepareInTransaction(f.trx, request)
  assert.equal(two.reused, true); assert.equal(two.record.id, one.record.id)
  assert.equal(f.state[LEDGER].length, 1); assert.equal(f.state[AUDIT].length, 1)
  await rejected(f.port.prepareInTransaction(f.trx, { ...request, payloadDigest: '0'.repeat(64) }))
  await rejected(f.port.prepareInTransaction(f.trx, { ...request, tenantId: 'synthetic-other' }), 'CONFLICT')
  await rejected(f.port.prepareInTransaction(f.trx, { ...request, intent: 'update' }), 'CONFLICT')
  assert.equal(f.calls.every(sql => /^(SELECT|INSERT)/.test(sql)), true)
  f.faults.wrapped = false
  assert.equal((await f.port.prepareInTransaction(f.trx, request)).record.id, one.record.id)
})

test('prepare audit failure is returned to its owning transaction without implicit rollback, commit or retry', async () => {
  const f = await fixture(), selected = await f.port.resolveSelectionInTransaction(f.trx, f.selection())
  const request = prepared(selected, f.port.executionPayloadDigest(selected, grant())); f.calls.length = 0
  f.faults.audit = new Error('SYNTHETIC_PRIVATE_EXCEPTION')
  await rejected(f.port.prepareInTransaction(f.trx, request))
  assert.equal(f.calls.length, 3)
  assert.equal(f.calls.filter(sql => sql.startsWith(`INSERT INTO "${LEDGER}"`)).length, 1)
  assert.equal(f.calls.every(sql => /^(SELECT|INSERT)/.test(sql)), true)
  // The unit raw-driver has deliberately NO fake rollback. Actual rollback of
  // ledger + host attempt/grant is asserted by the shared PG transaction suite.
})

test('raw query/security rejections and hostile proxy errors cannot leak values or trigger exception getters', async () => {
  const f = await fixture(), selected = await f.port.resolveSelectionInTransaction(f.trx, f.selection())
  const request = prepared(selected, f.port.executionPayloadDigest(selected, grant()))
  let traps = 0
  const hostile = new Proxy({}, { get() { traps++; throw new Error('SYNTHETIC_PRIVATE_EXCEPTION') },
    getPrototypeOf() { traps++; throw new Error('SYNTHETIC_PRIVATE_EXCEPTION') } })
  f.faults.query = hostile
  await rejected(f.port.resolveSelectionInTransaction(f.trx, f.selection()))
  await rejected(f.port.prepareInTransaction(f.trx, request))
  f.faults.query = null; f.faults.audit = hostile
  await rejected(f.port.prepareInTransaction(f.trx, request))
  await rejected(f.fresh(context, { ...f.security, decrypt: async () => { throw hostile } })
    .resolveSelectionInTransaction(f.trx, f.selection()))
  assert.equal(traps, 0)
})

async function rejectedCredential(promise, code = 'UNAVAILABLE') {
  await assert.rejects(promise, error => {
    assert.equal(error.code, 'YIDA_CREDENTIAL_' + code)
    assert.equal(error.message, error.code)
    assert.deepEqual(Object.keys(error).sort(), ['code', 'name'])
    assert.equal(Object.hasOwn(error, 'cause'), false)
    return true
  })
}
const materialRequest = f => ({ credentialRef: f.state[MATERIAL][0].credential_ref, credentialGeneration: 1 })

test('private actual 090 execution reader returns exactly frozen binding and four original material strings', async () => {
  const f = await fixture(), row = f.state[MATERIAL][0], envelope = await f.unseal(row.material_encrypted)
  const preserved = Object.fromEntries(Object.entries(bundle()).map(([key, value]) => [key, ' ' + value + '\t']))
  envelope.material = preserved; row.material_encrypted = await f.seal(envelope)
  const read = createInternalYidaCredentialExecutionReader({ security: f.security, context })
  const loaded = await read(createDb({ database: f.trx }), materialRequest(f))
  assert.deepEqual(Object.keys(loaded).sort(), [...Object.keys(context), 'credentialRef', 'credentialGeneration', ...Object.keys(bundle())].sort())
  assert.deepEqual(loaded, { ...context, ...materialRequest(f), ...preserved })
  assert.equal(Object.isFrozen(loaded), true)
  assert.equal(f.calls.length, 1)
  assert.match(f.calls[0], /integration_yida_credential_materials.*FOR UPDATE$/)
  const assertCurrent = createInternalYidaCredentialCurrentAsserter({ security: f.security, context })
  const metadata = await assertCurrent(createDb({ database: f.trx }), materialRequest(f))
  assert.deepEqual(metadata, { ...context, ...materialRequest(f), status: 'current' })
  assert.equal(f.calls.every(sql => sql.startsWith('SELECT ')), true)
})

test('private port authenticates permanent target and preserves secret whitespace before returning exact execution material', async () => {
  const f = await fixture(), row = f.state[MATERIAL][0], envelope = await f.unseal(row.material_encrypted)
  for (const key of ['appKey', 'appSecret', 'systemToken']) envelope.material[key] = ' ' + envelope.material[key] + '\t'
  row.material_encrypted = await f.seal(envelope)
  const loaded = await f.port.loadExecutionMaterialInTransaction(f.trx, materialRequest(f))
  assert.deepEqual(loaded, { ...context, ...materialRequest(f), ...envelope.material })
  assert.equal(Object.isFrozen(loaded), true)
  assert.deepEqual(Object.keys(loaded).sort(), [...Object.keys(context), 'credentialRef', 'credentialGeneration', ...Object.keys(bundle())].sort())
  const locks = f.calls.filter(sql => sql.endsWith('FOR UPDATE')).map(sql => /FROM "([a-z_]+)"/.exec(sql)[1])
  assert.deepEqual(locks, [TARGET, MATERIAL, DRAFT, OP, MATERIAL])
  assert.equal(f.calls.every(sql => sql.startsWith('SELECT ')), true)
})

test('execution reader and port reject every malformed material field and authenticated envelope transplant', async () => {
  const changes = [
    ...Object.keys(bundle()).map(key => envelope => { envelope.material[key] = ' ' }),
    envelope => { envelope.material.userId = 'x'.repeat(129) },
    envelope => { envelope.material.systemToken = 'x'.repeat(4097) },
    envelope => { delete envelope.material.appKey },
    envelope => { envelope.material.extra = 'unexpected' },
    envelope => { envelope.material.appSecret = 123 },
    envelope => { envelope.purpose = 'different-domain' },
    envelope => { envelope.schemaVersion = 2 },
    envelope => { envelope.ownerId = 'different-owner' },
    envelope => { envelope.tenantId = 'different-tenant' },
    envelope => { envelope.workspaceId = 'different-workspace' },
    envelope => { envelope.credentialRef = randomUUID() },
    envelope => { envelope.credentialGeneration = 2 },
  ]
  for (const change of changes) {
    const f = await fixture(), row = f.state[MATERIAL][0], envelope = await f.unseal(row.material_encrypted)
    change(envelope); row.material_encrypted = await f.seal(envelope)
    const read = createInternalYidaCredentialExecutionReader({ security: f.security, context })
    await rejectedCredential(read(createDb({ database: f.trx }), materialRequest(f)))
    await rejected(f.port.loadExecutionMaterialInTransaction(f.trx, materialRequest(f)))
  }
  for (const invalid of ['plaintext', 'v1:legacy', 'enc:broken']) {
    const f = await fixture(); f.state[MATERIAL][0].material_encrypted = invalid
    const read = createInternalYidaCredentialExecutionReader({ security: f.security, context })
    await rejectedCredential(read(createDb({ database: f.trx }), materialRequest(f)))
    await rejected(f.port.loadExecutionMaterialInTransaction(f.trx, materialRequest(f)))
  }
})

test('execution material stays bound to target ref/generation/owner and current 090 scope/status', async () => {
  const f = await fixture(), requested = materialRequest(f)
  await rejected(f.port.loadExecutionMaterialInTransaction(f.trx, { ...requested, credentialRef: randomUUID() }), 'CONFLICT')
  await rejected(f.port.loadExecutionMaterialInTransaction(f.trx, { ...requested, credentialGeneration: 2 }), 'CONFLICT')
  for (const [field, value, expected] of [['status', 'revoked', 'REVOKED'], ['generation', 2, 'CONFLICT'],
    ['tenant_id', 'other-tenant', 'NOT_FOUND'], ['owner_id', 'other-owner', 'NOT_FOUND'],
    ['workspace_id', 'other-workspace', 'NOT_FOUND']]) {
    const current = await fixture(); current.state[MATERIAL][0][field] = value
    const read = createInternalYidaCredentialExecutionReader({ security: current.security, context })
    await rejectedCredential(read(createDb({ database: current.trx }), materialRequest(current)), expected)
    await rejected(current.port.loadExecutionMaterialInTransaction(current.trx, materialRequest(current)))
  }
  for (const field of ['tenant_id', 'owner_id', 'workspace_id']) {
    const current = await fixture(); current.state[TARGET][0][field] = 'other-scope'
    await rejected(current.port.loadExecutionMaterialInTransaction(current.trx, materialRequest(current)))
  }
})

test('execution userId must equal the authenticated human-attested executor exactly, without trimming', async () => {
  for (const userId of ['other-executor', ' synthetic-executor', 'synthetic-executor ', 'SYNTHETIC-EXECUTOR']) {
    const f = await fixture(), row = f.state[MATERIAL][0], envelope = await f.unseal(row.material_encrypted)
    envelope.material.userId = userId; row.material_encrypted = await f.seal(envelope)
    const read = createInternalYidaCredentialExecutionReader({ security: f.security, context })
    assert.equal((await read(createDb({ database: f.trx }), materialRequest(f))).userId, userId)
    await rejected(f.port.loadExecutionMaterialInTransaction(f.trx, materialRequest(f)), 'CONFLICT')
  }
  const f = await fixture(), target = f.state[TARGET][0], envelope = await f.unseal(target.evidence_encrypted)
  envelope.attestation.executionIdentity = 'other-attested-executor'
  target.evidence_encrypted = await f.seal(envelope)
  await rejected(f.port.loadExecutionMaterialInTransaction(f.trx, materialRequest(f)), 'CONFLICT')
})

test('execution material port keeps full target replay and closed input/error boundaries', async () => {
  const f = await fixture(), requested = materialRequest(f)
  for (const input of [{ ...requested, verified: true }, { ...requested, credentialGeneration: 0 }, { ...requested, credentialGeneration: 1.5 }]) {
    await rejected(f.port.loadExecutionMaterialInTransaction(f.trx, input), 'INPUT')
  }
  const original = f.draft.operation.snapshot_encrypted, envelope = await f.unseal(original)
  envelope.plan.canApply = true; f.draft.operation.snapshot_encrypted = await f.seal(envelope)
  await rejected(f.port.loadExecutionMaterialInTransaction(f.trx, requested))
  f.draft.operation.snapshot_encrypted = original
  let traps = 0
  const hostile = new Proxy({}, { get() { traps++; throw new Error('SYNTHETIC_PRIVATE_EXCEPTION') },
    getPrototypeOf() { traps++; throw new Error('SYNTHETIC_PRIVATE_EXCEPTION') } })
  f.faults.query = hostile
  const read = createInternalYidaCredentialExecutionReader({ security: f.security, context })
  await rejectedCredential(read(createDb({ database: f.trx }), requested))
  await rejected(f.port.loadExecutionMaterialInTransaction(f.trx, requested))
  f.faults.query = null
  const badSecurity = { ...f.security, decrypt: async () => { throw hostile } }
  await rejectedCredential(createInternalYidaCredentialExecutionReader({ security: badSecurity, context })
    (createDb({ database: f.trx }), requested))
  await rejected(f.fresh(context, badSecurity).loadExecutionMaterialInTransaction(f.trx, requested))
  assert.equal(traps, 0)
})

test('prepare actual draft uses permanent target reader then real transaction-only 091 writer and reuses original identities', async () => {
  const f = await fixture(), original = structuredClone(f.source), parsed = JSON.parse(original.rowsText)
  parsed[0].quantity = 11; original.rowsText = JSON.stringify(parsed)
  const made = await f.port.prepareDraftInTransaction(f.trx, original)
  assert.equal(made.reused, false); assert.equal(made.rowCount, 2)
  assert.equal(made.targetRef, f.draft.target.target_ref)
  assert.notEqual(made.operationId, f.draft.operation.operation_id)
  assert.deepEqual(Object.keys(made).sort(), ['targetRef', 'operationId', 'status', 'identityKind', 'canSend', 'canApply',
    'tokenIssued', 'externalWriteAttempted', 'rowCount', 'rows', 'reused'].sort())
  assert.equal(Object.isFrozen(made.rows[0]), true)
  const reused = await f.port.prepareDraftInTransaction(f.trx, original)
  assert.equal(reused.reused, true); assert.equal(reused.operationId, made.operationId); assert.deepEqual(reused.rows, made.rows)
  assert.equal(f.state[DRAFT].length, 1); assert.equal(f.state[OP].length, 2)
  assert.equal(f.state[DRAFT_AUDIT].length, 1); assert.equal(f.state[LEDGER].length, 0)
  const locks = f.calls.filter(sql => sql.endsWith('FOR UPDATE')).map(sql => /FROM "([a-z_]+)"/.exec(sql)[1])
  assert.deepEqual(locks.slice(0, 6), [TARGET, MATERIAL, DRAFT, OP, DRAFT, OP])
  assert.equal(f.calls.some(sql => /^(BEGIN|SET|COMMIT|ROLLBACK)/.test(sql)), false)
  const members = f.state[ROWS].filter(row => row.operation_id === made.operationId)
  const preview = await f.port.previewInTransaction(f.trx, { operationId: made.operationId, rowKey: members[0].row_key })
  assert.equal(preview.operationId, made.operationId)
})

function updateInput(source) {
  const input = structuredClone(source)
  input.config.intent = 'update'; input.config.instanceIdField = 'instanceId'
  input.rowsText = JSON.stringify(JSON.parse(input.rowsText).map((row, index) => ({ ...row, instanceId: 'SYN-INSTANCE-' + index })))
  return input
}

test('prepare closes create-only permanent locator/key binding and input identities before any draft insert', async () => {
  for (const change of [input => { input.config.target.formUuid = 'synthetic-other-form' },
    input => { input.config.businessKey = input.config.businessKey.filter(field => field !== 'componentName') }]) {
    const f = await fixture(), input = structuredClone(f.source); change(input)
    await rejected(f.port.prepareDraftInTransaction(f.trx, input), 'CONFLICT')
    assert.equal(f.calls.every(sql => sql.startsWith('SELECT ')), true)
  }
  const f = await fixture()
  await rejected(f.port.prepareDraftInTransaction(f.trx, updateInput(f.source)), 'CONFLICT')
  for (const field of ['operationId', 'targetRef', 'ownerId', 'credentialRef', 'sourceRef', 'connectionId', 'query', 'url', 'authority']) {
    await rejected(f.port.prepareDraftInTransaction(f.trx, { ...f.source, [field]: 'caller' }))
  }
  assert.equal(f.state[OP].length, 1); assert.equal(f.state[DRAFT_AUDIT].length, 0)
  for (const variant of ['revoked', 'wrong-material-envelope', 'broken-original']) {
    const current = await fixture()
    if (variant === 'revoked') current.state[MATERIAL][0].status = 'revoked'
    else if (variant === 'wrong-material-envelope') {
      const row = current.state[MATERIAL][0], envelope = await current.unseal(row.material_encrypted)
      envelope.ownerId = 'synthetic-other'; row.material_encrypted = await current.seal(envelope)
    } else current.draft.operation.snapshot_encrypted = 'enc:broken'
    await rejected(current.port.prepareDraftInTransaction(current.trx, current.source))
    assert.equal(current.calls.every(sql => sql.startsWith('SELECT ')), true)
  }
})

for (const mode of ['original', 'equal_integer', 'equal_decimal_exact']) {
  test(`exact frozen ${mode} preview uses actual allocated selected payload, target evidence, and current execution identity`, async () => {
    const f = await fixture(mode), index = mode === 'original' ? 0 : 2, request = f.selection(f.draft, index)
    const preview = await f.port.previewInTransaction(f.trx, request)
    assert.deepEqual(Object.keys(preview).sort(), ['operationId', 'rowKey', 'planDigest', 'rowPayloadDigest', 'target',
      'payload', 'policy', 'canSend', 'externalWriteAttempted'].sort())
    assert.deepEqual(preview, { ...request, planDigest: f.draft.compiled.planDigest,
      rowPayloadDigest: f.draft.members[index].payload_digest,
      target: { targetRef: f.state[TARGET][0].target_ref, identityKind: 'owner-attested-single-target', evidenceVersion: 1,
        reviewRef: 'synthetic-review', organizationId: 'synthetic-org', ...f.draft.compiled.locator },
      payload: f.draft.compiled.plan.rows[index].payload,
      policy: { intent: 'create', maxAttempts: 1, maxTtlMs: 900000, requiresExplicitConfirmation: true, unknownMustNotRetry: true },
      canSend: false, externalWriteAttempted: false })
    for (const value of [preview, preview.target, preview.payload, preview.policy]) assert.equal(Object.isFrozen(value), true)
    assert.equal(/appKey|appSecret|systemToken|userId|executionIdentity|credentialRef|rowsText|selectedRow|source|fieldMap/.test(JSON.stringify(preview)), false)
    if (mode !== 'original') assert.equal(JSON.parse(f.source.rowsText)[index], undefined)
    assert.equal(f.calls.every(sql => sql.startsWith('SELECT ')), true)
    assert.equal(f.state[LEDGER].length, 0); assert.equal(f.state[DRAFT_AUDIT].length, 0)
    const locks = f.calls.filter(sql => sql.endsWith('FOR UPDATE')).map(sql => /FROM "([a-z_]+)"/.exec(sql)[1])
    assert.equal(locks.filter(table => table === MATERIAL).length, 4)
  })
}

test('preview rejects changed attested execution user, full material corruption, stale material and foreign selected scope', async () => {
  for (const variant of ['executor', 'app-secret', 'revoked', 'generation', 'member']) {
    const f = await fixture(), row = f.state[MATERIAL][0]
    if (variant === 'executor' || variant === 'app-secret') {
      const envelope = await f.unseal(row.material_encrypted)
      envelope.material[variant === 'executor' ? 'userId' : 'appSecret'] = variant === 'executor' ? 'synthetic-other-executor' : ' '
      row.material_encrypted = await f.seal(envelope)
    } else if (variant === 'revoked') row.status = 'revoked'
    else if (variant === 'generation') row.generation = 2
    else f.state[ROWS].pop()
    await rejected(f.port.previewInTransaction(f.trx, f.selection()), variant === 'executor' ? 'CONFLICT' : 'UNAVAILABLE')
    assert.equal(f.calls.every(sql => sql.startsWith('SELECT ')), true)
  }
  const f = await fixture()
  for (const scope of [{ ...context, ownerId: 'synthetic-other' }, { ...context, tenantId: 'synthetic-other' }]) {
    await rejected(f.fresh(scope).previewInTransaction(f.trx, f.selection()))
  }
  await rejected(f.port.previewInTransaction(f.trx, { ...f.selection(), payload: {} }), 'INPUT')
})

async function changeTargetOnSecondRead(f) {
  let count = 0
  f.faults.onQuery = async sql => {
    if (sql.startsWith(`SELECT * FROM "${TARGET}"`) && ++count === 2) {
      const row = f.state[TARGET][0], envelope = await f.unseal(row.evidence_encrypted)
      row.target_ref = randomUUID(); envelope.targetRef = row.target_ref
      row.evidence_encrypted = await f.seal(envelope)
    }
  }
}

test('preview rejects authenticated permanent target identity change after selection and before projection', async () => {
  const f = await fixture(); await changeTargetOnSecondRead(f)
  await rejected(f.port.previewInTransaction(f.trx, f.selection()), 'CONFLICT')
})

async function mutantPrimitives(remove) {
  const file = path.resolve(__dirname, '../lib/yida-send-authority-primitives.mjs')
  const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  assert(source.includes(remove))
  const mutated = source.replace(remove, '').replace(/from '(\.\/[^']+)'/g,
    (_, relative) => `from '${pathToFileURL(path.resolve(path.dirname(file), relative)).href}'`)
  return (await import('data:text/javascript;base64,' + Buffer.from(mutated).toString('base64'))).createYidaSendAuthorityPrimitives
}

test('in-memory removal of each new prepare/preview guard makes its rejection assertion red', async () => {
  const guards = [
    ['prepare-create-only', "      if (compiled.source.config.intent !== 'create') fail('CONFLICT')", async f =>
      rejected(f.port.prepareDraftInTransaction(f.trx, updateInput(f.source)), 'CONFLICT')],
    ['prepare-permanent-target', "      if (approved.target.locator_digest !== compiled.locatorDigest\n"
      + "        || approved.target.key_definition_digest !== compiled.keyDefinitionDigest\n"
      + "        || !same(approved.envelope.locator, compiled.locator)\n"
      + "        || !same(approved.envelope.keyDefinition, compiled.keyDefinition)) fail('CONFLICT')", async f => {
      const input = structuredClone(f.source); input.config.target.formUuid = 'synthetic-other-form'
      return rejected(f.port.prepareDraftInTransaction(f.trx, input), 'CONFLICT')
    }],
    ['preview-selected-target', "      if (approved.target.target_ref !== selection.targetRef\n"
      + "        || approved.target.credential_ref !== selection.credentialRef\n"
      + "        || approved.target.credential_generation !== selection.credentialGeneration\n"
      + "        || approved.target.locator_digest !== compiled.locatorDigest\n"
      + "        || approved.target.key_definition_digest !== compiled.keyDefinitionDigest\n"
      + "        || !same(approved.envelope.locator, compiled.locator)\n"
      + "        || !same(approved.envelope.keyDefinition, compiled.keyDefinition)) fail('CONFLICT')", async f => {
      await changeTargetOnSecondRead(f)
      return rejected(f.port.previewInTransaction(f.trx, f.selection()), 'CONFLICT')
    }],
    ['preview-full-material-validation', "      await loadExecutionMaterialInTransaction(trx, { credentialRef: selection.credentialRef,\n"
      + "        credentialGeneration: selection.credentialGeneration })", async f => {
      const row = f.state[MATERIAL][0], envelope = await f.unseal(row.material_encrypted)
      envelope.material.userId = 'synthetic-other-executor'; row.material_encrypted = await f.seal(envelope)
      return rejected(f.port.previewInTransaction(f.trx, f.selection()), 'CONFLICT')
    }],
  ]
  for (const [name, guard, probe] of guards) {
    const f = await fixture('original', await mutantPrimitives(guard))
    await assert.rejects(probe(f), error => error instanceof assert.AssertionError && /Missing expected rejection/.test(error.message))
    console.log(`MUTATION ${name}: RED (Missing expected rejection)`)
  }
})
