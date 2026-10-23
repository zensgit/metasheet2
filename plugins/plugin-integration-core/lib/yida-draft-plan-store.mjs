import { randomUUID } from 'node:crypto'
import { types } from 'node:util'
import canonical from './gip-canonical-json.cjs'
import credentials from './credential-store.cjs'
import { compileYidaDraft } from './yida-draft-plan.mjs'

// Unregistered, local-only persistence. A declared app/form is NOT a verified
// remote organization/physical form. No method can approve, issue a grant, load
// credentials, prepare a delivery ledger row, or send. Context is a future
// trusted-caller input, not proof of user authorization by itself.
const TARGETS = 'integration_yida_draft_targets'
const OPERATIONS = 'integration_yida_draft_operations'
const ROWS = 'integration_yida_draft_rows'
const AUDIT = 'integration_yida_draft_audit'
const TARGET_UNIQUE = 'uniq_yida_draft_target_locator'
const CONTEXT = ['tenantId', 'workspaceId', 'ownerId']
const MAX_BYTES = 8 * 1024 * 1024
const ERROR_CODES = new Set(['INPUT', 'UNAVAILABLE', 'NOT_FOUND', 'CONFLICT', 'KEY_DEFINITION_CONFLICT'])
const ownErrors = new WeakMap()
const { stableCanonicalStringify, deepCloneFrozenCanonical } = canonical

export class YidaDraftStoreError extends Error {
  constructor(code) {
    const fixed = ERROR_CODES.has(code) ? code : 'UNAVAILABLE'
    super(`YIDA_DRAFT_${fixed}`)
    this.name = 'YidaDraftStoreError'
    this.code = this.message
    ownErrors.set(this, fixed)
  }
}
const TARGET_RACE = new YidaDraftStoreError('CONFLICT')
function fail(code) { throw new YidaDraftStoreError(code) }
function closed(error) { fail(ownErrors.get(error) || 'UNAVAILABLE') }
function targetRace(error) {
  if (!error || typeof error !== 'object' || types.isProxy(error)) return false
  // Only PG's own data fields identify this target INSERT race. Unknown
  // rejection values never contribute prototypes, getters or public messages.
  return Object.getOwnPropertyDescriptor(error, 'code')?.value === '23505'
    && Object.getOwnPropertyDescriptor(error, 'constraint')?.value === TARGET_UNIQUE
}
function record(value, keys) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) fail('INPUT')
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) fail('INPUT')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key))) fail('INPUT')
  const result = {}
  for (const key of keys) {
    const property = descriptors[key]
    if (!property.enumerable || !Object.hasOwn(property, 'value')) fail('INPUT')
    Object.defineProperty(result, key, { value: property.value, enumerable: true })
  }
  return result
}
function opaque(value) {
  if (typeof value !== 'string' || !value || value.length > 128 || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) fail('INPUT')
  return value
}
function rows(result) { return Array.isArray(result) ? result : result?.rows ?? [] }
function first(result) { return rows(result)[0] ?? null }

// Authenticated ciphertext can still have been moved from another domain. Bound
// the parsed JSON before recursive canonicalization as well as matching its
// envelope. This accepts no caller getters/proxies and does not normalize -0.
function encode(value) {
  const stack = [{ value, depth: 0 }]
  let nodes = 0
  while (stack.length) {
    const item = stack.pop(), entry = item.value
    if (++nodes > 60000 || item.depth > 20) fail('UNAVAILABLE')
    if (entry === null || typeof entry === 'boolean' || typeof entry === 'string') continue
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry) || Object.is(entry, -0)) fail('UNAVAILABLE')
      continue
    }
    if (!entry || typeof entry !== 'object' || types.isProxy(entry)) fail('UNAVAILABLE')
    const descriptors = Object.getOwnPropertyDescriptors(entry)
    for (const key of Reflect.ownKeys(descriptors)) {
      if (Array.isArray(entry) && key === 'length') continue
      const property = descriptors[key]
      if (typeof key !== 'string' || !property.enumerable || !Object.hasOwn(property, 'value')) fail('UNAVAILABLE')
      stack.push({ value: property.value, depth: item.depth + 1 })
    }
  }
  const text = stableCanonicalStringify(value)
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) fail('UNAVAILABLE')
  return text
}
function cipher(value) {
  if (typeof value !== 'string' || !value.startsWith('enc:') || value.length <= 4
    || Buffer.byteLength(value, 'utf8') > MAX_BYTES) fail('UNAVAILABLE')
  return value
}

function createDraftInternals({ db, security, context } = {}) {
  const fixed = record(context, CONTEXT)
  opaque(fixed.tenantId); opaque(fixed.ownerId)
  if (fixed.workspaceId !== null) opaque(fixed.workspaceId)
  Object.freeze(fixed)
  if (!security
    || typeof security.encrypt !== 'function' || typeof security.decrypt !== 'function') fail('UNAVAILABLE')
  const vault = credentials.createCredentialStore({ security })
  const scope = { tenant_id: fixed.tenantId, workspace_id: fixed.workspaceId }
  const ownedScope = { ...scope, owner_id: fixed.ownerId }
  async function transaction(callback) {
    try {
      if (!db || typeof db.transaction !== 'function') fail('UNAVAILABLE')
      return await db.transaction(async trx => {
        if (!trx || ['setTransactionIsolationLevel', 'select', 'selectOne', 'selectOneForUpdate', 'insertOne']
          .some(key => typeof trx[key] !== 'function')) fail('UNAVAILABLE')
        await trx.setTransactionIsolationLevel('read committed')
        return callback(trx)
      })
    } catch (error) {
      // Keep the private retry sentinel only within the public transaction
      // loop. Exported error fields/prototypes are mutable: rebuild from the
      // closed constructor record, never instanceof or foreign code/message.
      if (error === TARGET_RACE) throw TARGET_RACE
      closed(error)
    }
  }
  async function seal(value) { return cipher(await vault.encrypt(encode(value))) }
  async function unseal(value, keys) {
    try {
      const text = await vault.decrypt(cipher(value))
      if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) fail('UNAVAILABLE')
      const parsed = record(JSON.parse(text), keys)
      encode(parsed)
      return parsed
    } catch { fail('UNAVAILABLE') }
  }
  function bound(envelope, expected) {
    if (!CONTEXT.every(key => envelope[key] === fixed[key])
      || !Object.entries(expected).every(([key, value]) => envelope[key] === value)) fail('UNAVAILABLE')
  }
  function ownedTarget(target) {
    if (!target || target.tenant_id !== fixed.tenantId || target.workspace_id !== fixed.workspaceId
      || target.owner_id !== fixed.ownerId) fail('NOT_FOUND')
    if (target.status !== 'unverified') fail('UNAVAILABLE')
  }
  async function verifyTarget(target, compiled) {
    ownedTarget(target)
    if (target.locator_digest !== compiled.locatorDigest || target.key_definition_digest !== compiled.keyDefinitionDigest) fail('UNAVAILABLE')
    const envelope = await unseal(target.target_encrypted,
      ['purpose', 'schemaVersion', ...CONTEXT, 'targetRef', 'locator', 'keyDefinition'])
    bound(envelope, { purpose: 'yida-draft-target', schemaVersion: 1, targetRef: target.target_ref })
    if (encode(envelope.locator) !== encode(compiled.locator)
      || encode(envelope.keyDefinition) !== encode(compiled.keyDefinition)) fail('UNAVAILABLE')
  }
  async function acquireTarget(trx, compiled) {
    const natural = { ...scope, locator_digest: compiled.locatorDigest }
    let target = await trx.selectOneForUpdate(TARGETS, natural)
    if (target) {
      // Owner is intentionally absent from namespace uniqueness. An owner
      // change cannot mint a second local target for the same declared locator.
      if (target.owner_id !== fixed.ownerId) fail('CONFLICT')
      if (target.key_definition_digest !== compiled.keyDefinitionDigest) fail('KEY_DEFINITION_CONFLICT')
      await verifyTarget(target, compiled)
      return target
    }
    const targetRef = randomUUID()
    const encrypted = await seal({ purpose: 'yida-draft-target', schemaVersion: 1, ...fixed,
      targetRef, locator: compiled.locator, keyDefinition: compiled.keyDefinition })
    try {
      target = first(await trx.insertOne(TARGETS, { target_ref: targetRef, ...ownedScope,
        locator_digest: compiled.locatorDigest, key_definition_digest: compiled.keyDefinitionDigest,
        target_encrypted: encrypted, status: 'unverified' }))
    } catch (error) {
      if (targetRace(error)) throw TARGET_RACE
      throw error
    }
    if (!target || target.target_ref !== targetRef) fail('UNAVAILABLE')
    await verifyTarget(target, compiled)
    return target
  }
  async function verifyOperation(trx, target, operation) {
    if (!operation || operation.target_ref !== target.target_ref || operation.status !== 'unverified'
      || !Number.isInteger(operation.row_count) || operation.row_count < 1 || operation.row_count > 100) fail('UNAVAILABLE')
    const envelope = await unseal(operation.snapshot_encrypted,
      ['purpose', 'schemaVersion', ...CONTEXT, 'targetRef', 'operationId', 'planDigest', 'source', 'plan'])
    bound(envelope, { purpose: 'yida-draft-operation', schemaVersion: 1, targetRef: target.target_ref,
      operationId: operation.operation_id, planDigest: operation.plan_digest })
    let compiled
    try { compiled = compileYidaDraft(envelope.source) } catch { fail('UNAVAILABLE') }
    if (compiled.planDigest !== operation.plan_digest || compiled.rowSpecs.length !== operation.row_count
      || encode(envelope.plan) !== encode(compiled.plan)) fail('UNAVAILABLE')
    await verifyTarget(target, compiled)
    const members = rows(await trx.select(ROWS, { where: { operation_id: operation.operation_id }, orderBy: ['ordinal', 'ASC'], limit: 101 }))
    if (members.length !== operation.row_count || members.some((row, index) => row.operation_id !== operation.operation_id
      || row.ordinal !== index || row.business_key_digest !== compiled.rowSpecs[index].businessKeyDigest
      || row.payload_digest !== compiled.rowSpecs[index].payloadDigest || typeof row.row_key !== 'string'
      || !/^[0-9a-f-]{36}$/.test(row.row_key)) || new Set(members.map(row => row.row_key)).size !== members.length) fail('UNAVAILABLE')
    return { compiled, members }
  }
  function metadata(target, operation, members) {
    return deepCloneFrozenCanonical({ targetRef: target.target_ref, operationId: operation.operation_id,
      status: 'unverified', identityKind: 'local-unverified', canSend: false, canApply: false,
      tokenIssued: false, externalWriteAttempted: false, rowCount: members.length,
      rows: members.map(row => ({ rowKey: row.row_key, index: row.ordinal })) })
  }
  async function createDraftInTransaction(trx, input, compiled = compileYidaDraft(input)) {
    // Only the host's structured CRUD transaction is accepted. This private
    // writer never starts a transaction, pins isolation, commits, or retries.
    if (!trx || typeof trx !== 'object' || types.isProxy(trx) || Array.isArray(trx)
      || ['select', 'selectOne', 'selectOneForUpdate', 'insertOne'].some(key => {
        const property = Object.getOwnPropertyDescriptor(trx, key)
        return !property || !Object.hasOwn(property, 'value') || typeof property.value !== 'function'
      })) fail('UNAVAILABLE')
    const target = await acquireTarget(trx, compiled)
    const existing = await trx.selectOneForUpdate(OPERATIONS, { target_ref: target.target_ref, plan_digest: compiled.planDigest })
    if (existing) {
      const checked = await verifyOperation(trx, target, existing)
      return Object.freeze({ ...metadata(target, existing, checked.members), reused: true })
    }
    const operationId = randomUUID()
    const snapshot = await seal({ purpose: 'yida-draft-operation', schemaVersion: 1, ...fixed,
      targetRef: target.target_ref, operationId, planDigest: compiled.planDigest, source: compiled.source, plan: compiled.plan })
    const operation = first(await trx.insertOne(OPERATIONS, { operation_id: operationId,
      target_ref: target.target_ref, plan_digest: compiled.planDigest, snapshot_encrypted: snapshot,
      row_count: compiled.rowSpecs.length, status: 'unverified' }))
    if (!operation || operation.operation_id !== operationId) fail('UNAVAILABLE')
    for (const row of compiled.rowSpecs) {
      await trx.insertOne(ROWS, { row_key: randomUUID(), operation_id: operationId, ordinal: row.index,
        business_key_digest: row.businessKeyDigest, payload_digest: row.payloadDigest })
    }
    const audit = first(await trx.insertOne(AUDIT, { id: randomUUID(), operation_id: operationId,
      target_ref: target.target_ref, actor_id: fixed.ownerId, event: 'create_draft' }))
    if (!audit || audit.operation_id !== operationId || audit.target_ref !== target.target_ref
      || audit.actor_id !== fixed.ownerId || audit.event !== 'create_draft') fail('UNAVAILABLE')
    const checked = await verifyOperation(trx, target, operation)
    return Object.freeze({ ...metadata(target, operation, checked.members), reused: false })
  }
  async function createDraft(input) {
    const compiled = compileYidaDraft(input)
    // Only a precisely identified target INSERT race permits one fresh tx.
    // Commit failures and operation identity conflicts are never auto-retried.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await transaction(trx => createDraftInTransaction(trx, input, compiled))
      } catch (error) {
        if (error !== TARGET_RACE) throw error
        if (attempt === 1) fail('CONFLICT')
      }
    }
    fail('CONFLICT')
  }
  async function readVerifiedInTransaction(trx, input) {
    const operationId = opaque(record(input, ['operationId']).operationId)
    if (!trx || ['select', 'selectOne', 'selectOneForUpdate'].some(key => typeof trx[key] !== 'function')) fail('UNAVAILABLE')
    // Unlocked opaque locator read only. Never decrypt or project this row
    // until its immutable parent has passed the exact owner/scope lock below.
    const locator = await trx.selectOne(OPERATIONS, { operation_id: operationId })
    if (!locator) fail('NOT_FOUND')
    const target = await trx.selectOneForUpdate(TARGETS, { target_ref: locator.target_ref, ...ownedScope })
    ownedTarget(target)
    const operation = await trx.selectOneForUpdate(OPERATIONS, { operation_id: operationId, target_ref: target.target_ref })
    const checked = await verifyOperation(trx, target, operation)
    return { target, operation, ...checked }
  }
  async function read(input, replay) {
    return transaction(async trx => {
      const { target, operation, ...checked } = await readVerifiedInTransaction(trx, input)
      const view = metadata(target, operation, checked.members)
      return replay ? deepCloneFrozenCanonical({ ...view, evidence: checked.compiled.plan.evidence, replayVerified: true }) : view
    })
  }
  return { publicStore: Object.freeze({ createDraft, inspect: input => read(input, false), replay: input => read(input, true) }),
    readVerifiedInTransaction,
    async createDraftInTransaction(trx, input) {
      // The actual compiler owns INPUT/CONFIG/PLAN/LIMIT and its error name.
      // Compile before closing persistence failures so DB-supplied lookalikes
      // cannot borrow compiler identity to carry private details.
      const compiled = compileYidaDraft(input)
      try { return await createDraftInTransaction(trx, input, compiled) }
      // A shared transaction gets a fresh closed CONFLICT, never TARGET_RACE
      // or an independent retry/transaction/isolation/commit from this writer.
      catch (error) { closed(error) }
    } }
}

export function createYidaDraftPlanStore(options = {}) {
  if (!options.db || typeof options.db.transaction !== 'function') fail('UNAVAILABLE')
  return createDraftInternals(options).publicStore
}

// Internal consumer only: never register on the public plugin API. The owning
// store supplies its already-open transaction and isolation. This primitive
// performs no BEGIN, COMMIT, or nested db.transaction and grants no authority.
export function createInternalYidaDraftTransactionReader({ security, context } = {}) {
  return createDraftInternals({ security, context }).readVerifiedInTransaction
}

// Internal consumer only. The actual UUID/ciphertext/row verification/audit
// persistence above runs inside the already-open host transaction. It has no
// independent retry; an INSERT race is left to that transaction's owner.
export function createInternalYidaDraftTransactionWriter(options = {}) {
  try {
    const parsed = record(options, ['security', 'context'])
    return createDraftInternals(parsed).createDraftInTransaction
  } catch (error) { closed(error) }
}
