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
const LAYOUT = 'integration_yida_generated_layout'
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
  const [{ createYidaSendAuthorityPrimitives }, { compileYidaSendDraft: compileYidaDraft }, { createYidaProtocolExample }] = await modules
  const key = randomBytes(32), calls = [], state = Object.fromEntries([TARGET, MATERIAL, DRAFT, OP, ROWS, LEDGER, AUDIT, DRAFT_AUDIT,
    'integration_stock_prep_project_target', LAYOUT].map(name => [name, []]))
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
    assert.deepEqual(Object.keys(f.port).sort(), ['draftSendBudget', 'executionPayloadDigest', 'loadExecutionMaterialInTransaction',
      'prepareDraftInTransaction', 'prepareInTransaction', 'previewInTransaction', 'resolveSelectionInTransaction', 'sealGeneratedLayoutInTransaction', 'sendBudget'])
    assert.equal(Object.isFrozen(selected) && Object.isFrozen(selected.selectedRow) && Object.isFrozen(selected.plan.rows), true)
    assert.deepEqual(Object.keys(selected).sort(), ['tenantId', 'workspaceId', 'ownerId', 'operationId', 'rowKey', 'targetRef',
      'targetRevision', 'planRevision', 'credentialRef', 'credentialGeneration', 'businessKeyDigest', 'rowPayloadDigest', 'planDigest',
      'sourceRecordDigest', 'creationIdentityDigest', 'sourceBinding', 'config', 'selectedRow', 'source', 'plan'].sort())
    // A pasted (unbound) draft: no source binding, both digests null (design baseline v2.3 §7.2).
    assert.deepEqual([selected.sourceRecordDigest, selected.creationIdentityDigest, selected.sourceBinding], [null, null, null])
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
  // Version 2 (design baseline v2.3 §7.2, D18): the formula also covers the two source-binding digests, null here.
  const expected = createHash('sha256').update(stableCanonicalStringify({
    version: 2, grantRef: authorization.grantRef, expiresAt: authorization.expiresAt,
    actorId: authorization.actorId, targetRef: selected.targetRef, targetRevision: selected.targetRevision,
    planRevision: selected.planRevision, intent, data, formUuid: selected.config.target.formUuid,
    sourceRecordDigest: null, creationIdentityDigest: null,
  })).digest('hex')
  assert.equal(f.port.executionPayloadDigest(selected, authorization), expected)
  assert.notEqual(f.port.executionPayloadDigest(selected, { ...authorization, grantRef: 'synthetic-other-grant' }), expected)
  assert.notEqual(f.port.executionPayloadDigest(selected, { ...authorization, expiresAt: authorization.expiresAt + 1 }), expected)
  assert.throws(() => f.port.executionPayloadDigest(structuredClone(selected), authorization), { code: 'YIDA_SEND_AUTHORITY_INPUT' })
  assert.throws(() => f.fresh().executionPayloadDigest(selected, authorization), { code: 'YIDA_SEND_AUTHORITY_INPUT' })
  assert.throws(() => f.port.executionPayloadDigest(selected, { ...authorization, actorId: 'synthetic-other' }), { code: 'YIDA_SEND_AUTHORITY_CONFLICT' })
  assert.equal(f.state[LEDGER].length, 0)
})

test('gate 4 send budget: the selected row counts — a joint config+row snapshot overflow is refused although config alone and the body are within', async () => {
  const f = await fixture(), [, , { createYidaProtocolExample }] = await modules
  const budget = require('../lib/yida-send-budget.cjs')
  const LIMIT = budget.YIDA_SEND_SNAPSHOT_MAX_BYTES
  const worst = { systemToken: '\u0001'.repeat(4096), userId: '\u0001'.repeat(128) }
  const bytes = text => Buffer.byteLength(text, 'utf8')
  // Same locator and key definition as the registered target; 11 extra text fields and 12 selects of
  // 30 long options each. The config alone is far within the snapshot budget, and so is the body.
  const example = createYidaProtocolExample(), base = example.config
  const notes = Array.from({ length: 11 }, (_, i) => 'note' + i), picks = Array.from({ length: 12 }, (_, i) => 'pick' + i)
  const options = Array.from({ length: 30 }, (_, k) => (String(k) + '选项').padEnd(128, '项'))
  const config = { ...base,
    fieldCatalog: [...base.fieldCatalog, ...notes.map(id => ({ id, control: 'text', required: false })),
      ...picks.map(id => ({ id, control: 'select', required: false, options }))],
    fieldMap: [...base.fieldMap, ...[...notes, ...picks].map(id => ({ source: 'src_' + id, target: id, type: 'string', required: false }))] }
  const row = { ...example.rows[0], ...Object.fromEntries(picks.map(id => ['src_' + id, null])) }
  for (const id of notes) {
    row['src_' + id] = ''
    const room = Math.floor((130000 - bytes(JSON.stringify([row]))) / 3)
    row['src_' + id] = '中'.repeat(Math.max(0, Math.min(4096, room)))
  }
  const custom = await f.addDraft({ config, rowsText: JSON.stringify([row]), allocation: { mode: 'original' } })
  const selected = await f.port.resolveSelectionInTransaction(f.trx, f.selection(custom, 0))
  const authorization = grant(), planned = selected.plan.rows[0]
  const data = { ...planned.protocolPreview.data, formDataJson: stableCanonicalStringify(planned.payload) }
  // The exact snapshot shape the primitive assesses (and the host execution handle resolves).
  const snapshot = selectedRow => ({ tenantId: selected.tenantId, workspaceId: selected.workspaceId, ownerId: selected.ownerId,
    actorId: authorization.actorId, operationId: selected.operationId, rowKey: selected.rowKey, grantRef: authorization.grantRef,
    expiresAt: authorization.expiresAt, targetRef: selected.targetRef, targetRevision: selected.targetRevision,
    planRevision: selected.planRevision, credentialRef: selected.credentialRef, credentialGeneration: selected.credentialGeneration,
    config: selected.config, row: selectedRow, ...worst })
  assert.ok(bytes(JSON.stringify(selected.selectedRow)) > 120000)
  assert.ok(bytes(stableCanonicalStringify(snapshot(selected.selectedRow))) > LIMIT)
  assert.ok(bytes(stableCanonicalStringify(snapshot({}))) < LIMIT - 60000)
  assert.ok(bytes(budget.encodeYidaFormRequestBody(data, worst.systemToken, worst.userId)) < budget.YIDA_SEND_REQUEST_MAX_BYTES - 60000)
  assert.throws(() => budget.boundYidaExecutionSnapshot(snapshot(selected.selectedRow)), { code: 'YIDA_SEND_BUDGET_INVALID' })
  const verdict = f.port.sendBudget(selected, authorization)
  assert.deepEqual([Object.isFrozen(verdict), Object.keys(verdict), verdict.withinBudget], [true, ['withinBudget'], false])
  // Control: the registered example row under the same target and config shape is within.
  const small = await f.port.resolveSelectionInTransaction(f.trx, f.selection(f.draft, 0))
  assert.equal(f.port.sendBudget(small, authorization).withinBudget, true)
  assert.equal(f.state[LEDGER].length, 0)
})

test('gate 4 send budget: one frozen boolean for this port actual selection; owner-bound; no SQL or crypto', async () => {
  const f = await fixture('equal_integer'), selected = await f.port.resolveSelectionInTransaction(f.trx, f.selection(f.draft, 2))
  const authorization = grant(), calls = f.calls.length
  let crypto = 0
  const { encrypt, decrypt } = f.security
  f.security.encrypt = async (...args) => { crypto++; return encrypt(...args) }
  f.security.decrypt = async (...args) => { crypto++; return decrypt(...args) }
  const verdict = f.port.sendBudget(selected, authorization)
  assert.deepEqual(Object.keys(verdict), ['withinBudget'])
  assert.equal(verdict.withinBudget, true)
  assert.equal(Object.isFrozen(verdict), true)
  assert.equal(typeof verdict.then, 'undefined')
  assert.throws(() => f.port.sendBudget(structuredClone(selected), authorization), { code: 'YIDA_SEND_AUTHORITY_INPUT' })
  assert.throws(() => f.fresh().sendBudget(selected, authorization), { code: 'YIDA_SEND_AUTHORITY_INPUT' })
  assert.throws(() => f.port.sendBudget(selected, { ...authorization, actorId: 'synthetic-other' }), { code: 'YIDA_SEND_AUTHORITY_CONFLICT' })
  for (const bad of [{ ...authorization, expiresAt: 0 }, { ...authorization, grantRef: '' }, { ...authorization, extra: true },
    { grantRef: authorization.grantRef, actorId: authorization.actorId }, null])
    assert.throws(() => f.port.sendBudget(selected, bad), { code: 'YIDA_SEND_AUTHORITY_INPUT' })
  assert.equal(f.calls.length, calls)
  assert.equal(crypto, 0)
  assert.equal(f.state[LEDGER].length, 0)
  // Positive control: the counter does observe this port's real decryptions.
  await f.port.resolveSelectionInTransaction(f.trx, f.selection(f.draft, 2))
  assert.equal(crypto > 0, true)
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

// R-71 ⑦.3: the slot's v2 protocol layout restated as v3 (same locator, key targets, types and
// nullable parts, so the same key definition), plus one copy, one constant and one concat. The concat
// reads ext_size, a column the payload never carries; ext_unmapped is read by nothing.
function v3Of(v2, extra = []) {
  const target = source => v2.fieldMap.find(entry => entry.source === source).target
  return { ...structuredClone(v2), version: 3, businessKey: v2.businessKey.map(target), emptyKeyFields: v2.emptyKeyFields.map(target),
    fieldCatalog: [...structuredClone(v2.fieldCatalog), { id: 'nameCopy', control: 'text', required: false },
      { id: 'rule', control: 'text', required: true }, { id: 'label', control: 'text', required: false },
      ...extra.map(entry => ({ id: entry.target, control: 'text', required: false }))],
    fieldMap: [...v2.fieldMap.map(entry => ({ transform: 'direct', ...entry })),
      { transform: 'copy', copyOf: 'componentName', target: 'nameCopy', type: 'string', required: false },
      { transform: 'constant', value: 'SYN-RULE', target: 'rule', type: 'string', required: true },
      { transform: 'concat', parts: [{ source: 'ext_size' }, { literal: 'mm' }], separator: ' ', blank: 'skip',
        target: 'label', type: 'string', required: false }, ...extra] }
}
function v3Source(source, extra) {
  const rows = JSON.parse(source.rowsText).map((row, index) => ({ ...row, ext_size: 1200 + index, ext_unmapped: 'SYN-UNMAPPED' }))
  return { config: v3Of(source.config, extra), rowsText: JSON.stringify(rows), allocation: structuredClone(source.allocation) }
}
const constants = (count, character) => Array.from({ length: count }, (_, index) => ({ transform: 'constant',
  value: character.repeat(4096), target: 'big' + index, type: 'string', required: false }))

for (const mode of ['original', 'equal_integer']) {
  test(`R-71 ⑦.3 ${mode}: a v3 draft for the v2 slot selects projected rows; preview payload is the executed data`, async () => {
    const f = await fixture(mode), [, , { buildYidaStaticPlan, yidaTransformSourceColumns }] = await modules
    const source = v3Source(f.source), index = mode === 'original' ? 0 : 2
    const made = await f.port.prepareDraftInTransaction(f.trx, source)
    assert.equal(made.reused, false); assert.equal(made.targetRef, f.draft.target.target_ref)
    assert.notEqual(made.operationId, f.draft.operation.operation_id)
    const operation = f.state[OP].find(row => row.operation_id === made.operationId)
    assert.notEqual(operation.plan_digest, f.draft.operation.plan_digest)
    const members = f.state[ROWS].filter(row => row.operation_id === made.operationId).sort((a, b) => a.ordinal - b.ordinal)
    // Same layout and rows: every row keeps the v2 draft's business identity (the create fence).
    assert.deepEqual(members.map(row => row.business_key_digest), f.draft.members.map(row => row.business_key_digest))
    const request = { operationId: made.operationId, rowKey: members[index].row_key }
    const selected = await f.port.resolveSelectionInTransaction(f.trx, request)
    assert.equal(selected.config.version, 3)
    const columns = yidaTransformSourceColumns(selected.config)
    assert.deepEqual(Object.keys(selected.selectedRow).sort(), [...columns])
    assert.equal(columns.includes('ext_size') && !columns.includes('ext_unmapped'), true)
    assert.equal(JSON.stringify(selected.selectedRow).includes('SYN-UNMAPPED'), false)
    const planned = buildYidaStaticPlan({ config: selected.config, rows: [selected.selectedRow] }).rows[0]
    assert.deepEqual(planned.payload, selected.plan.rows[index].payload)
    assert.equal(planned.payload.label, '1200 mm')
    assert.equal(planned.payload.rule, 'SYN-RULE'); assert.equal(planned.payload.nameCopy, planned.payload.componentName)
    const preview = await f.port.previewInTransaction(f.trx, request)
    assert.deepEqual(preview.payload, selected.plan.rows[index].payload)
    // The digest the runner verifies is over exactly the previewed payload bytes.
    const authorization = grant()
    const data = { ...selected.plan.rows[index].protocolPreview.data, formDataJson: stableCanonicalStringify(preview.payload) }
    assert.equal(f.port.executionPayloadDigest(selected, authorization), createHash('sha256').update(stableCanonicalStringify({
      version: 2, grantRef: authorization.grantRef, expiresAt: authorization.expiresAt, actorId: authorization.actorId,
      targetRef: selected.targetRef, targetRevision: selected.targetRevision, planRevision: selected.planRevision,
      intent: 'create', data, formUuid: selected.config.target.formUuid,
      sourceRecordDigest: null, creationIdentityDigest: null })).digest('hex'))
    for (const target of Object.keys(preview.payload)) assert.equal(selected.config.fieldCatalog.some(item => item.id === target), true)
    assert.deepEqual(f.port.sendBudget(selected, authorization), { withinBudget: true })
    assert.deepEqual(f.port.draftSendBudget(source), { withinBudget: true })
    assert.equal(f.state[LEDGER].length, 0)
  })
}

test('R-71 ⑦.3: a v3 draft whose key definition or intent differs from the slot is CONFLICT with no draft written', async () => {
  const f = await fixture(), base = v3Source(f.source)
  const narrowed = structuredClone(base); narrowed.config.businessKey = narrowed.config.businessKey.filter(target => target !== 'componentName')
  const nullable = structuredClone(base); nullable.config.emptyKeyFields = []
  nullable.rowsText = JSON.stringify(JSON.parse(nullable.rowsText).map(row => ({ ...row, parentCode: 'SYN-PARENT-' + row.quantity })))
  const update = structuredClone(base); update.config.intent = 'update'; update.config.instanceIdField = 'instanceId'
  update.rowsText = JSON.stringify(JSON.parse(update.rowsText).map((row, index) => ({ ...row, instanceId: 'SYN-INSTANCE-' + index })))
  for (const input of [narrowed, nullable, update]) await rejected(f.port.prepareDraftInTransaction(f.trx, input), 'CONFLICT')
  assert.equal(f.state[OP].length, 1); assert.equal(f.state[DRAFT_AUDIT].length, 0)
  assert.throws(() => f.port.draftSendBudget(update), { code: 'YIDA_SEND_AUTHORITY_CONFLICT' })
})

test('R-71 ⑦.3 C1: draftSendBudget is one frozen boolean, v2 always within, v3 assessed per row; within implies sendBudget within', async () => {
  const f = await fixture(), sql = f.calls.length
  const v2 = f.port.draftSendBudget(f.source)
  assert.deepEqual(v2, { withinBudget: true }); assert.equal(Object.isFrozen(v2), true)
  assert.deepEqual(Object.getOwnPropertyNames(v2), ['withinBudget'])
  // Over budget for v3 (constants live in the config, not the 128 KiB row text): refused.
  assert.deepEqual(f.port.draftSendBudget(v3Source(f.source, constants(20, '中'))), { withinBudget: false })
  assert.deepEqual(f.port.draftSendBudget(v3Source(f.source, constants(20, '"'))), { withinBudget: false })
  assert.throws(() => f.port.draftSendBudget({ ...f.source, targetRef: 'caller' }), { code: 'YIDA_SEND_AUTHORITY_INPUT' })
  assert.throws(() => f.port.draftSendBudget(new Proxy(f.source, {})), { code: 'YIDA_SEND_AUTHORITY_INPUT' })
  assert.throws(() => f.port.draftSendBudget({ ...f.source, rowsText: '[]' }), { code: 'YIDA_SEND_AUTHORITY_UNAVAILABLE' })
  assert.equal(f.calls.length, sql)
  // Property: whenever the draft-time verdict is within, the approval-time verdict on the real
  // selection is within too (the placeholders dominate the real ids, expiry and credentials).
  const seen = new Set()
  for (const character of ['中', '"', 'a']) {
    for (let count = 0; count <= 20; count += 2) {
      const source = v3Source(f.source, constants(count, character)), verdict = f.port.draftSendBudget(source)
      seen.add(verdict.withinBudget)
      if (!verdict.withinBudget) continue
      const made = await f.port.prepareDraftInTransaction(f.trx, source)
      for (const row of made.rows) {
        const selected = await f.port.resolveSelectionInTransaction(f.trx, { operationId: made.operationId, rowKey: row.rowKey })
        assert.deepEqual(f.port.sendBudget(selected, { ...grant(), expiresAt: Number.MAX_SAFE_INTEGER }), { withinBudget: true },
          `${character} x ${count}`)
      }
    }
  }
  assert.deepEqual([...seen].sort(), [false, true])
})

test('R-71 ⑦.3 C1: at the exact draft-time edge the approval-time budget still holds with real-length ids', async () => {
  const f = await fixture()
  // Total constant text T split into 4096-char constants; find the largest T the draft accepts.
  const sized = total => {
    const extra = constants(Math.ceil(total / 4096), '中')
    if (extra.length) extra[extra.length - 1].value = '中'.repeat(total - 4096 * (extra.length - 1))
    return v3Source(f.source, extra)
  }
  let low = 0, high = 20 * 4096
  assert.equal(f.port.draftSendBudget(sized(low)).withinBudget, true)
  assert.equal(f.port.draftSendBudget(sized(high)).withinBudget, false)
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    if (f.port.draftSendBudget(sized(middle)).withinBudget) low = middle; else high = middle
  }
  const made = await f.port.prepareDraftInTransaction(f.trx, sized(low))
  for (const row of made.rows) {
    const selected = await f.port.resolveSelectionInTransaction(f.trx, { operationId: made.operationId, rowKey: row.rowKey })
    // A real grant: a 36-char UUID ref and a current-epoch expiry, the shapes the host mints.
    assert.deepEqual(f.port.sendBudget(selected, { grantRef: randomUUID(), expiresAt: Date.now() + 900000, actorId: context.ownerId }),
      { withinBudget: true })
  }
})

// ---- Source binding (design baseline v2.3 §7.2): bound drafts, bound selections, the registry check at admission ----
const REGISTRY = 'integration_stock_prep_project_target'
function boundSource(f, index = 0) {
  const rows = JSON.parse(f.source.rowsText)
  const keySource = f.source.config.businessKey[1]
  const fieldBindings = Object.fromEntries(f.source.config.fieldMap.map(entry => [entry.source, 'fld_' + entry.source]))
  return { ...f.source, sourceBinding: { sheetId: 'sheet_registered', keyFieldId: fieldBindings[keySource], fieldBindings,
    records: rows.map((row, ordinal) => ({ recordId: `rec_${ordinal}`, keyValue: String(row[keySource]), projectNo: 'DEMO-P1' })) } }
}
function registryRow(patch = {}) {
  return { id: randomUUID(), tenant_id: context.tenantId, project_no: 'DEMO-P1', sheet_id: 'sheet_registered', object_id: 'synthetic-object', status: 'active', ...patch }
}

test('a bound draft is written with both row digests; its selection carries them and the per-row binding; the digest covers them', async () => {
  const f = await fixture(), [, { compileYidaSendDraft }] = await modules
  const source = boundSource(f)
  const made = await f.port.prepareDraftInTransaction(f.trx, source)
  assert.equal(made.reused, false)
  const compiled = compileYidaSendDraft(source)
  const members = f.state[ROWS].filter(row => row.operation_id === made.operationId).sort((a, b) => a.ordinal - b.ordinal)
  assert.deepEqual(members.map(row => [row.source_record_digest, row.creation_identity_digest]),
    compiled.rowSpecs.map(spec => [spec.sourceRecordDigest, spec.creationIdentityDigest]))
  assert.equal(members.every(row => /^[0-9a-f]{64}$/.test(row.source_record_digest) && /^[0-9a-f]{64}$/.test(row.creation_identity_digest)), true)
  // The unbound draft of the same rows is another operation with null digests (SR5, draft level).
  assert.equal(f.state[ROWS].filter(row => row.operation_id === f.draft.operation.operation_id)
    .every(row => row.source_record_digest === undefined && row.creation_identity_digest === undefined), true)
  const selected = await f.port.resolveSelectionInTransaction(f.trx, { operationId: made.operationId, rowKey: members[0].row_key })
  assert.equal(selected.sourceRecordDigest, compiled.rowSpecs[0].sourceRecordDigest)
  assert.equal(selected.creationIdentityDigest, compiled.rowSpecs[0].creationIdentityDigest)
  assert.deepEqual(selected.sourceBinding, compiled.rowSpecs[0].sourceBinding)
  assert.equal(Object.isFrozen(selected.sourceBinding), true)
  // Version 2 digest: the binding digests are inputs, so the same payload under another record is another digest.
  const authorization = grant(), payload = selected.plan.rows[0]
  const data = { ...payload.protocolPreview.data, formDataJson: stableCanonicalStringify(payload.payload) }
  assert.equal(f.port.executionPayloadDigest(selected, authorization), createHash('sha256').update(stableCanonicalStringify({
    version: 2, grantRef: authorization.grantRef, expiresAt: authorization.expiresAt, actorId: authorization.actorId,
    targetRef: selected.targetRef, targetRevision: selected.targetRevision, planRevision: selected.planRevision,
    intent: 'create', data, formUuid: selected.config.target.formUuid,
    sourceRecordDigest: selected.sourceRecordDigest, creationIdentityDigest: selected.creationIdentityDigest })).digest('hex'))
  const unboundSelected = await f.port.resolveSelectionInTransaction(f.trx, f.selection())
  assert.notEqual(f.port.executionPayloadDigest(unboundSelected, authorization), f.port.executionPayloadDigest(selected, authorization))
  assert.deepEqual(f.port.sendBudget(selected, authorization), { withinBudget: true })
  assert.deepEqual(f.port.draftSendBudget(source), { withinBudget: true })
  // A durable digest that no longer matches the recompiled row is refused on read.
  members[0].creation_identity_digest = 'e'.repeat(64)
  await rejected(f.port.resolveSelectionInTransaction(f.trx, { operationId: made.operationId, rowKey: members[0].row_key }))
})

test('admission of a bound row reads the project registry in the same transaction and refuses an absent, archived or moved registration', async () => {
  const f = await fixture()
  const made = await f.port.prepareDraftInTransaction(f.trx, boundSource(f))
  const member = f.state[ROWS].filter(row => row.operation_id === made.operationId).sort((a, b) => a.ordinal - b.ordinal)[0]
  const selected = await f.port.resolveSelectionInTransaction(f.trx, { operationId: made.operationId, rowKey: member.row_key })
  const authorization = grant(), payloadDigest = f.port.executionPayloadDigest(selected, authorization)
  const request = () => ({ ...prepared(selected, payloadDigest), sourceRecordDigest: selected.sourceRecordDigest,
    creationIdentityDigest: selected.creationIdentityDigest, sourceBinding: selected.sourceBinding })
  // No registry row for the project: CONFLICT, nothing written.
  await rejected(f.port.prepareInTransaction(f.trx, request()), 'CONFLICT')
  assert.equal(f.state[LEDGER].length, 0)
  // Archived registration, and a registration that names another sheet: CONFLICT.
  f.state[REGISTRY].push(registryRow({ status: 'archived' }))
  await rejected(f.port.prepareInTransaction(f.trx, request()), 'CONFLICT')
  f.state[REGISTRY][0] = registryRow({ sheet_id: 'sheet_other' })
  await rejected(f.port.prepareInTransaction(f.trx, request()), 'CONFLICT')
  // Another tenant's registration of the same project does not count.
  f.state[REGISTRY][0] = registryRow({ tenant_id: 'synthetic-other-tenant' })
  await rejected(f.port.prepareInTransaction(f.trx, request()), 'CONFLICT')
  assert.equal(f.state[LEDGER].length, 0)
  // The three binding keys come together: a partial set is INPUT.
  for (const partial of [{ sourceRecordDigest: selected.sourceRecordDigest }, { sourceBinding: selected.sourceBinding },
    { sourceRecordDigest: selected.sourceRecordDigest, creationIdentityDigest: null, sourceBinding: selected.sourceBinding }]) {
    await rejected(f.port.prepareInTransaction(f.trx, { ...prepared(selected, payloadDigest), ...partial }), 'INPUT')
  }
  // Active registration naming the bound sheet: prepared, with both digests on the ledger row.
  f.state[REGISTRY][0] = registryRow()
  const result = await f.port.prepareInTransaction(f.trx, request())
  assert.equal(result.reused, false); assert.equal(result.record.status, 'prepared')
  assert.equal(f.state[LEDGER][0].source_record_digest, selected.sourceRecordDigest)
  assert.equal(f.state[LEDGER][0].creation_identity_digest, selected.creationIdentityDigest)
  assert.equal(f.calls.some(sql => sql.startsWith(`SELECT * FROM "${REGISTRY}"`)), true)
  // Unbound admission (all three null, or absent) never reads the registry.
  const unbound = await f.port.resolveSelectionInTransaction(f.trx, f.selection())
  const unboundDigest = f.port.executionPayloadDigest(unbound, authorization)
  f.calls.length = 0
  const plain = await f.port.prepareInTransaction(f.trx, { ...prepared(unbound, unboundDigest), sourceRecordDigest: null, creationIdentityDigest: null, sourceBinding: null })
  assert.equal(plain.reused, false)
  assert.equal(f.calls.some(sql => sql.includes(REGISTRY)), false)
  assert.deepEqual([f.state[LEDGER][1].source_record_digest, f.state[LEDGER][1].creation_identity_digest], [null, null])
})

// ---- R-71 ⑦.4 PR-2 (Y6): a v3 draft with a generated entry through the send authority (SR5 generated part, and the
// ⑦.3 points 3/4/5 re-run with the generated value: projected selection, re-plan equality, preview ≡ executed data) ----
const GENERATED_ENTRY = { transform: 'generated', target: 'code', type: 'string', required: true,
  template: [{ literal: 'SYN-' }, { hash: ['project', 'componentCode', 'componentName', 'specification', 'material', 'version', 'parentCode'], form: 'uuid-36' }] }
// Independent oracle (node:crypto SHA-1, RFC 4122 UUIDv5 bit layout, the generated-hash name layout: [target, value] pairs
// sorted by target, coordinator ruling L1).
function oracleGeneratedHash(members) {
  const pairs = Object.entries(members).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  const digest = createHash('sha1').update(Buffer.from('de2dfbd78b3f41a493228487ec85637f', 'hex'))
    .update(Buffer.from(JSON.stringify(['metasheet.stock-prep.yida-generated-hash', 'v1', pairs]), 'utf8')).digest().subarray(0, 16)
  digest[6] = (digest[6] & 0x0f) | 0x50
  digest[8] = (digest[8] & 0x3f) | 0x80
  const h = digest.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`.toUpperCase()
}
function generatedSource(f) {
  const source = v3Source(f.source, [GENERATED_ENTRY])
  const columns = [...new Set(source.config.fieldMap.flatMap(entry => entry.source ? [entry.source] : []).concat(['ext_size']))]
  const fieldBindings = Object.fromEntries(columns.map(column => [column, 'fld_' + column]))
  const rows = JSON.parse(source.rowsText)
  return { unbound: source, bound: { ...source, sourceBinding: { sheetId: 'sheet_registered', keyFieldId: 'fld_componentCode', fieldBindings,
    records: rows.map((row, ordinal) => ({ recordId: `rec_${ordinal}`, keyValue: row.componentCode, projectNo: 'DEMO-P1' })) } } }
}

test('R-71 ⑦.4 SR5 (generated): an unbound draft with a generated entry is refused before any draft row; without it the pasted draft is written unbound', async () => {
  const f = await fixture(), { unbound } = generatedSource(f)
  const operations = f.state[OP].length, rows = f.state[ROWS].length
  await rejected(f.port.prepareDraftInTransaction(f.trx, unbound))
  assert.deepEqual([f.state[OP].length, f.state[ROWS].length, f.state[DRAFT_AUDIT].length], [operations, rows, 0])
  // The draft-time budget answers the same refusal (one compiler, one rule).
  assert.throws(() => f.port.draftSendBudget(unbound), { code: 'YIDA_SEND_AUTHORITY_UNAVAILABLE' })
  // The same pasted rows without the generated entry: an ordinary v3 draft whose rows carry no binding digest.
  const made = await f.port.prepareDraftInTransaction(f.trx, v3Source(f.source))
  const members = f.state[ROWS].filter(row => row.operation_id === made.operationId)
  assert.equal(members.length, 2)
  assert.equal(members.every(row => row.source_record_digest === null && row.creation_identity_digest === null), true)
})

for (const mode of ['original', 'equal_integer']) {
  test(`R-71 ⑦.4 (⑦.3 points 3-5 with generated) ${mode}: a bound generated draft selects projected rows; re-plan, preview and executed data carry the same code`, async () => {
    const f = await fixture(mode), [, { compileYidaSendDraft }, { buildYidaStaticPlan, yidaTransformSourceColumns }] = await modules
    const { bound } = generatedSource(f), index = mode === 'original' ? 0 : 2
    const made = await f.port.prepareDraftInTransaction(f.trx, bound)
    const members = f.state[ROWS].filter(row => row.operation_id === made.operationId).sort((a, b) => a.ordinal - b.ordinal)
    const compiled = compileYidaSendDraft(bound)
    assert.deepEqual(members.map(row => row.payload_digest), compiled.rowSpecs.map(spec => spec.payloadDigest))
    // Every planned row has its own code (split rows included), equal to the independent oracle over its own key tuple.
    const codes = compiled.plan.rows.map(row => row.payload.code)
    assert.equal(new Set(codes).size, codes.length)
    for (const row of compiled.plan.rows) {
      const p = row.payload
      assert.equal(p.code, 'SYN-' + oracleGeneratedHash({ project: p.project, componentCode: p.componentCode, componentName: p.componentName,
        specification: p.specification, material: p.material, version: p.version, parentCode: p.parentCode ?? '' }))
    }
    const request = { operationId: made.operationId, rowKey: members[index].row_key }
    const selected = await f.port.resolveSelectionInTransaction(f.trx, request)
    // (4) the selection is projected onto the columns the mapping reads, generated inputs included, nothing else.
    const columns = yidaTransformSourceColumns(selected.config)
    assert.deepEqual(Object.keys(selected.selectedRow).sort(), [...columns])
    assert.equal(JSON.stringify(selected.selectedRow).includes('SYN-UNMAPPED'), false)
    // (3) a one-row re-plan of the projected row reproduces the compiled payload, code included.
    const planned = buildYidaStaticPlan({ config: selected.config, rows: [selected.selectedRow] }).rows[0]
    assert.deepEqual(planned.payload, selected.plan.rows[index].payload)
    assert.equal(planned.payload.code, codes[index])
    // (5) preview is the executed data, and the execution digest covers exactly those bytes (with both binding digests).
    const preview = await f.port.previewInTransaction(f.trx, request)
    assert.deepEqual(preview.payload, selected.plan.rows[index].payload)
    const authorization = grant()
    const data = { ...selected.plan.rows[index].protocolPreview.data, formDataJson: stableCanonicalStringify(preview.payload) }
    assert.equal(JSON.parse(data.formDataJson).code, codes[index])
    assert.equal(f.port.executionPayloadDigest(selected, authorization), createHash('sha256').update(stableCanonicalStringify({
      version: 2, grantRef: authorization.grantRef, expiresAt: authorization.expiresAt, actorId: authorization.actorId,
      targetRef: selected.targetRef, targetRevision: selected.targetRevision, planRevision: selected.planRevision,
      intent: 'create', data, formUuid: selected.config.target.formUuid,
      sourceRecordDigest: selected.sourceRecordDigest, creationIdentityDigest: selected.creationIdentityDigest })).digest('hex'))
    assert.deepEqual(selected.sourceBinding.fieldDependencies.code, ['fld_componentCode', 'fld_componentName', 'fld_material',
      'fld_parentCode', 'fld_projectNo', 'fld_specification', 'fld_version'])
    assert.deepEqual(f.port.sendBudget(selected, authorization), { withinBudget: true })
    assert.deepEqual(f.port.draftSendBudget(bound), { withinBudget: true })
    assert.equal(f.state[LEDGER].length, 0)
  })
}

// ---- P1 (external review 2026-11-08): one sealed generated layout per approved target (migration zzzz20261108120000) ----
// Independent oracle of the seal's digest: the planner's canonical layout through canonical JSON and sha256.
function oracleLayoutDigest(planner, config) {
  return createHash('sha256').update(stableCanonicalStringify(planner.yidaGeneratedLayout(config)), 'utf8').digest('hex')
}
// A bound generated draft written by the real draft writer (its member rows carry the binding digests), selected at row 0.
// `salt` moves ext_size (a concat input) so a template variant becomes its own operation instead of reusing the first plan.
async function generatedSelection(f, bound) {
  const made = await f.port.prepareDraftInTransaction(f.trx, bound)
  const member = f.state[ROWS].find(row => row.operation_id === made.operationId && row.ordinal === 0)
  return f.port.resolveSelectionInTransaction(f.trx, { operationId: made.operationId, rowKey: member.row_key })
}
const withTemplate = (bound, template, salt = 0) => ({ ...bound,
  rowsText: JSON.stringify(JSON.parse(bound.rowsText).map(row => ({ ...row, ext_size: row.ext_size + salt }))),
  config: { ...bound.config, fieldMap: bound.config.fieldMap.map(entry => entry.transform === 'generated' ? { ...entry, template } : entry) } })

test('P1 seal: without a generated entry the seal row is read and nothing is written on an unsealed target; the first generated selection seals the target layout (digest = canonical layout sha256, this operation, the event); the same layout matches, a reordered hash is the same layout, another layout — and a selection without a generated entry — is the frozen conflict verdict with nothing written', async () => {
  const f = await fixture(), [, , planner] = await modules
  // v2 (no generated entry) on an UNSEALED target: admissible, not sealed; exactly one SELECT … FOR UPDATE of the seal
  // row (the null signature must be compared with a seal that may exist), no write.
  const plain = await f.port.resolveSelectionInTransaction(f.trx, f.selection())
  f.calls.length = 0
  const untouched = await f.port.sealGeneratedLayoutInTransaction(f.trx, plain, { event: 'approve' })
  assert.deepEqual(untouched, { admissible: true, sealed: false })
  assert.equal(Object.isFrozen(untouched), true)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].startsWith(`SELECT * FROM "${LAYOUT}"`) && f.calls[0].endsWith('FOR UPDATE'), true)
  assert.deepEqual(f.state[LAYOUT], [])
  // The first generated selection: the row is locked FOR UPDATE, absent, written with this target, scope, operation and event.
  const { bound } = generatedSource(f)
  const selected = await generatedSelection(f, bound)
  f.calls.length = 0
  assert.deepEqual(await f.port.sealGeneratedLayoutInTransaction(f.trx, selected, { event: 'approve' }), { admissible: true, sealed: true })
  assert.equal(f.calls.some(sql => sql.startsWith(`SELECT * FROM "${LAYOUT}"`) && sql.endsWith('FOR UPDATE')), true)
  assert.equal(f.state[LAYOUT].length, 1)
  const sealed = f.state[LAYOUT][0]
  assert.deepEqual([sealed.target_ref, sealed.tenant_id, sealed.workspace_id, sealed.owner_id, sealed.operation_id, sealed.event, sealed.actor_id],
    [selected.targetRef, context.tenantId, null, context.ownerId, selected.operationId, 'approve', context.ownerId])
  assert.equal(sealed.layout_digest, oracleLayoutDigest(planner, bound.config))
  // The same plain selection on the now SEALED target (verifier r1 of the P1 fix): null is another signature — the frozen
  // conflict verdict, nothing written (a cell mapped directly onto the sealed code target could otherwise carry another
  // identity's generated code).
  f.calls.length = 0
  const refusedPlain = await f.port.sealGeneratedLayoutInTransaction(f.trx, plain, { event: 'admit' })
  assert.deepEqual(refusedPlain, { admissible: false, code: 'GENERATED_LAYOUT_CONFLICT' })
  assert.equal(Object.isFrozen(refusedPlain), true)
  assert.equal(f.calls.some(sql => sql.startsWith('INSERT')), false)
  assert.deepEqual(f.state[LAYOUT], [sealed])
  // Another draft of the same layout (another operation, the admission event): matches, nothing written.
  const again = await generatedSelection(f, withTemplate(bound, GENERATED_ENTRY.template, 1))
  assert.deepEqual(await f.port.sealGeneratedLayoutInTransaction(f.trx, again, { event: 'admit' }), { admissible: true, sealed: false })
  assert.equal(f.state[LAYOUT].length, 1)
  // A hash listing its members in another order is the same layout (ruling L1: the listed order never changes a code).
  const [prefix, hashPart] = GENERATED_ENTRY.template
  const reordered = await generatedSelection(f, withTemplate(bound, [prefix, { ...hashPart, hash: [...hashPart.hash].reverse() }], 2))
  assert.deepEqual(await f.port.sealGeneratedLayoutInTransaction(f.trx, reordered, { event: 'approve' }), { admissible: true, sealed: false })
  // Another layout of the same target (the reviewer's counterexample shape: the hash first, a field part after it; and the
  // bare hash): the frozen conflict verdict, no write, the seal unchanged.
  for (const [salt, template] of [[3, [hashPart, { field: 'componentName' }]], [4, [hashPart]]]) {
    const other = await generatedSelection(f, withTemplate(bound, template, salt))
    f.calls.length = 0
    const verdict = await f.port.sealGeneratedLayoutInTransaction(f.trx, other, { event: 'approve' })
    assert.deepEqual(verdict, { admissible: false, code: 'GENERATED_LAYOUT_CONFLICT' })
    assert.equal(Object.isFrozen(verdict), true)
    assert.equal(f.calls.some(sql => sql.startsWith('INSERT')), false)
    assert.deepEqual(f.state[LAYOUT], [sealed])
  }
  // Closed inputs: an unbranded copy of a selection, another port's selection, an unknown or missing event.
  await rejected(f.port.sealGeneratedLayoutInTransaction(f.trx, structuredClone(selected), { event: 'approve' }), 'INPUT')
  await rejected(f.fresh().sealGeneratedLayoutInTransaction(f.trx, selected, { event: 'approve' }), 'INPUT')
  for (const bad of [{ event: 'draft' }, { event: 'approve', extra: 1 }, {}, null, 'approve']) {
    await rejected(f.port.sealGeneratedLayoutInTransaction(f.trx, selected, bad), 'INPUT')
  }
  // A seal row under this target ref that is not this owner's, or whose digest is malformed: UNAVAILABLE, never a match.
  f.state[LAYOUT][0] = { ...sealed, owner_id: 'synthetic-other-owner' }
  await rejected(f.port.sealGeneratedLayoutInTransaction(f.trx, selected, { event: 'approve' }))
  f.state[LAYOUT][0] = { ...sealed, layout_digest: 'not-a-digest' }
  await rejected(f.port.sealGeneratedLayoutInTransaction(f.trx, selected, { event: 'approve' }))
  f.state[LAYOUT][0] = sealed
  assert.deepEqual(await f.port.sealGeneratedLayoutInTransaction(f.trx, selected, { event: 'admit' }), { admissible: true, sealed: false })
  // The seal's primary-key race (reachable only without the host's approved-target row lock): the conflict verdict.
  f.state[LAYOUT].length = 0
  const race = Object.assign(new Error('synthetic unique violation'), { code: '23505', constraint: 'integration_yida_generated_layout_pkey' })
  f.faults.onQuery = async sql => { if (sql.startsWith(`INSERT INTO "${LAYOUT}"`)) throw race }
  assert.deepEqual(await f.port.sealGeneratedLayoutInTransaction(f.trx, selected, { event: 'approve' }), { admissible: false, code: 'GENERATED_LAYOUT_CONFLICT' })
  f.faults.onQuery = async sql => { if (sql.startsWith(`INSERT INTO "${LAYOUT}"`)) throw Object.assign(new Error('synthetic other failure'), { code: '23505', constraint: 'other' }) }
  await rejected(f.port.sealGeneratedLayoutInTransaction(f.trx, selected, { event: 'approve' }))
  f.faults.onQuery = null
})
