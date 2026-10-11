import { randomUUID } from 'node:crypto'
import { types } from 'node:util'
import canonical from './gip-canonical-json.cjs'
import credentials from './credential-store.cjs'
import credentialMaterials from './yida-credential-material-store.cjs'
import { createInternalYidaDraftTransactionReader } from './yida-draft-plan-store.mjs'

// Unregistered internal persistence, not an authorization boundary. A future
// host entry must establish live integration-admin AND this exact owner before
// calling it. Context and human attestation alone never prove that authority.
// No token, grant, delivery preparation, transport, or automatic verification.
const TARGET = 'integration_yida_approved_target'
const AUDIT = 'integration_yida_approved_target_audit'
const MATERIALS = 'integration_yida_credential_materials'
const CONTEXT = ['tenantId', 'workspaceId', 'ownerId']
const MAX_BYTES = 262144
const ERROR_CODES = new Set(['INPUT', 'UNAVAILABLE', 'NOT_FOUND', 'CONFLICT'])
const ownErrors = new WeakMap()
const { stableCanonicalStringify, deepCloneFrozenCanonical } = canonical

export class YidaApprovedTargetError extends Error {
  constructor(code) {
    const fixed = ERROR_CODES.has(code) ? code : 'UNAVAILABLE'
    super(`YIDA_APPROVED_TARGET_${fixed}`)
    this.name = 'YidaApprovedTargetError'
    this.code = this.message
    ownErrors.set(this, fixed)
  }
}
function fail(code) { throw new YidaApprovedTargetError(code) }
const SLOT_RACE = new YidaApprovedTargetError('CONFLICT')
function slotRace(error) {
  if (!error || typeof error !== 'object' || types.isProxy(error)) return false
  // PG's own data fields identify this one retryable INSERT constraint. Do not
  // inspect foreign getters/prototypes while closing an unknown rejection.
  return Object.getOwnPropertyDescriptor(error, 'code')?.value === '23505'
    && Object.getOwnPropertyDescriptor(error, 'constraint')?.value === 'integration_yida_approved_target_pkey'
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
function generation(value) {
  if (!Number.isInteger(value) || value < 1 || value > 2147483647) fail('INPUT')
  return value
}
function attestation(value) {
  const result = record(value, ['kind', 'reviewRef', 'organizationId', 'executionIdentity'])
  if (result.kind !== 'owner-reviewed-target') fail('INPUT')
  for (const key of ['reviewRef', 'organizationId', 'executionIdentity']) opaque(result[key])
  return Object.freeze(result)
}
function cipher(value) {
  if (typeof value !== 'string' || !value.startsWith('enc:') || value.length <= 4
    || Buffer.byteLength(value, 'utf8') > MAX_BYTES) fail('UNAVAILABLE')
  return value
}
function encode(value) {
  const text = stableCanonicalStringify(value)
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) fail('UNAVAILABLE')
  return text
}
const first = result => (Array.isArray(result) ? result : result?.rows)?.[0] ?? null

function createApprovedTargetInternals({ db, security, context } = {}) {
  const fixed = record(context, CONTEXT)
  opaque(fixed.tenantId); opaque(fixed.ownerId)
  if (fixed.workspaceId !== null) fail('INPUT')
  Object.freeze(fixed)
  if (!security
    || typeof security.encrypt !== 'function' || typeof security.decrypt !== 'function') fail('UNAVAILABLE')
  const vault = credentials.createCredentialStore({ security })
  const replay = createInternalYidaDraftTransactionReader({ security, context: fixed })
  const assertCurrent = credentialMaterials.createInternalYidaCredentialCurrentAsserter({ security, context: fixed })
  const scope = { tenant_id: fixed.tenantId, workspace_id: null, owner_id: fixed.ownerId }

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
      // Identity/WeakMap operations do not consult foreign prototypes, getters,
      // code or message. Even our exported errors may have been mutated by a
      // caller; rebuild them from the closed, private constructor record.
      if (error === SLOT_RACE) throw SLOT_RACE
      // A COMMIT reply failure is unknown. Never retry it or claim rollback.
      fail(ownErrors.get(error) || 'UNAVAILABLE')
    }
  }
  function owned(row, code) {
    if (!row || row.tenant_id !== fixed.tenantId || row.workspace_id !== null
      || row.owner_id !== fixed.ownerId) fail(code)
    if (row.slot !== 1 || typeof row.target_ref !== 'string' || !/^[0-9a-f-]{36}$/.test(row.target_ref) || row.evidence_version !== 1
      || row.status !== 'manually_confirmed') fail('UNAVAILABLE')
  }
  async function material(trx, credentialRef) {
    // Actual 090 row locked within this same transaction; no public 090 method
    // and no decryption of application secrets are necessary for this binding.
    const row = await trx.selectOneForUpdate(MATERIALS, { credential_ref: credentialRef, ...scope })
    if (!row || row.credential_ref !== credentialRef || row.tenant_id !== fixed.tenantId
      || row.workspace_id !== null || row.owner_id !== fixed.ownerId) fail('CONFLICT')
    if (!Number.isInteger(row.generation) || row.generation < 1 || row.generation > 2147483647
      || !['current', 'revoked'].includes(row.status)) fail('UNAVAILABLE')
    return row
  }
  function binding(row) {
    return { purpose: 'yida-approved-target', schemaVersion: 1, ...fixed, slot: 1, targetRef: row.target_ref,
      evidenceVersion: 1, operationId: row.operation_id, draftTargetRef: row.draft_target_ref,
      planDigest: row.plan_digest, locatorDigest: row.locator_digest, keyDefinitionDigest: row.key_definition_digest,
      credentialRef: row.credential_ref, credentialGeneration: row.credential_generation }
  }
  async function unseal(row) {
    try {
      const text = await vault.decrypt(cipher(row.evidence_encrypted))
      if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) fail('UNAVAILABLE')
      const expected = binding(row)
      const envelope = record(JSON.parse(text), [...Object.keys(expected), 'locator', 'keyDefinition', 'attestation'])
      if (!Object.entries(expected).every(([key, value]) => envelope[key] === value)) fail('UNAVAILABLE')
      attestation(envelope.attestation)
      return envelope
    } catch { fail('UNAVAILABLE') }
  }
  function matchesPlan(row, envelope, checked) {
    if (row.locator_digest !== checked.compiled.locatorDigest
      || row.key_definition_digest !== checked.compiled.keyDefinitionDigest
      || encode(envelope.locator) !== encode(checked.compiled.locator)
      || encode(envelope.keyDefinition) !== encode(checked.compiled.keyDefinition)) fail('CONFLICT')
  }
  function view(row, current) {
    return deepCloneFrozenCanonical({ targetRef: row.target_ref, evidenceVersion: row.evidence_version,
      status: 'manually_confirmed', identityKind: 'owner-attested-single-target',
      evidenceStatus: current.status === 'current' && current.generation === row.credential_generation ? 'current' : 'invalidated',
      canSend: false, canApply: false, tokenIssued: false, externalWriteAttempted: false })
  }
  function registration(input) {
    const parsed = record(input, ['operationId', 'credentialRef', 'credentialGeneration', 'attestation'])
    opaque(parsed.operationId); opaque(parsed.credentialRef); generation(parsed.credentialGeneration)
    const reviewed = attestation(parsed.attestation)
    return { parsed, reviewed }
  }
  async function registerInTransaction(trx, input, { parsed, reviewed } = registration(input)) {
    // Match the actual host CRUD transaction. Never call transaction/SET or
    // retry here: a failed statement belongs to this transaction's owner.
    if (!trx || typeof trx !== 'object' || types.isProxy(trx) || Array.isArray(trx)
      || ['select', 'selectOne', 'selectOneForUpdate', 'insertOne'].some(key => {
        const property = Object.getOwnPropertyDescriptor(trx, key)
        return !property || !Object.hasOwn(property, 'value') || typeof property.value !== 'function'
      })) fail('UNAVAILABLE')
    const existing = await trx.selectOneForUpdate(TARGET, { slot: 1 })
    if (existing) owned(existing, 'CONFLICT')
    const current = await material(trx, parsed.credentialRef)
    if (current.status !== 'current' || current.generation !== parsed.credentialGeneration) fail('CONFLICT')
    const checked = await replay(trx, { operationId: parsed.operationId })
    if (checked.compiled.source.config.intent !== 'create') fail('CONFLICT')
    if (existing) {
      const envelope = await unseal(existing)
      matchesPlan(existing, envelope, checked)
      if (existing.credential_ref !== parsed.credentialRef || existing.credential_generation !== parsed.credentialGeneration
        || encode(envelope.attestation) !== encode(reviewed)) fail('CONFLICT')
      return Object.freeze({ ...view(existing, current), reused: true })
    }
    const row = { slot: 1, target_ref: randomUUID(), ...scope, evidence_version: 1, status: 'manually_confirmed',
      operation_id: checked.operation.operation_id, draft_target_ref: checked.target.target_ref,
      plan_digest: checked.compiled.planDigest, locator_digest: checked.compiled.locatorDigest,
      key_definition_digest: checked.compiled.keyDefinitionDigest,
      credential_ref: parsed.credentialRef, credential_generation: parsed.credentialGeneration }
    const encrypted = cipher(await vault.encrypt(encode({ ...binding(row), locator: checked.compiled.locator,
      keyDefinition: checked.compiled.keyDefinition, attestation: reviewed })))
    let inserted
    try { inserted = first(await trx.insertOne(TARGET, { ...row, evidence_encrypted: encrypted })) }
    catch (error) {
      if (slotRace(error)) throw SLOT_RACE
      throw error
    }
    owned(inserted, 'UNAVAILABLE')
    if (!Object.entries(row).every(([key, value]) => inserted[key] === value)
      || inserted.evidence_encrypted !== encrypted) fail('UNAVAILABLE')
    const audit = first(await trx.insertOne(AUDIT, { id: randomUUID(), slot: 1, target_ref: row.target_ref,
      actor_id: fixed.ownerId, evidence_version: 1, event: 'register_target' }))
    if (!audit || audit.slot !== 1 || audit.target_ref !== row.target_ref || audit.actor_id !== fixed.ownerId
      || audit.evidence_version !== 1 || audit.event !== 'register_target') fail('UNAVAILABLE')
    matchesPlan(inserted, await unseal(inserted), checked)
    return Object.freeze({ ...view(inserted, current), reused: false })
  }
  async function register(input) {
    const checkedInput = registration(input)
    // Only the precise first-slot INSERT race can retry. Every loser replays
    // and compares with the committed permanent binding before returning it.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await transaction(trx => registerInTransaction(trx, input, checkedInput))
      } catch (error) {
        if (error !== SLOT_RACE) throw error
        if (attempt === 1) fail('CONFLICT')
      }
    }
    fail('CONFLICT')
  }
  async function readVerifiedInTransaction(trx, requireCurrentMaterial) {
    try {
      if (!trx || ['select', 'selectOne', 'selectOneForUpdate'].some(key => typeof trx[key] !== 'function')) fail('UNAVAILABLE')
      const row = await trx.selectOneForUpdate(TARGET, { slot: 1 })
      owned(row, 'NOT_FOUND')
      const envelope = await unseal(row)
      const current = requireCurrentMaterial
        ? await assertCurrent(trx, { credentialRef: row.credential_ref, credentialGeneration: row.credential_generation })
        : await material(trx, row.credential_ref)
      const checked = await replay(trx, { operationId: row.operation_id })
      if (checked.operation.plan_digest !== row.plan_digest || checked.target.target_ref !== row.draft_target_ref
        || checked.compiled.source.config.intent !== 'create') fail('UNAVAILABLE')
      matchesPlan(row, envelope, checked)
      return { target: row, envelope, current, checked }
    } catch (error) { fail(ownErrors.get(error) || 'UNAVAILABLE') }
  }
  async function inspect(input = {}) {
    record(input, [])
    return transaction(async trx => {
      const { target, current } = await readVerifiedInTransaction(trx, false)
      return view(target, current)
    })
  }
  return { publicStore: Object.freeze({ register, inspect }),
    readVerifiedInTransaction: trx => readVerifiedInTransaction(trx, true),
    async registerInTransaction(trx, input) {
      try { return await registerInTransaction(trx, input) }
      // SLOT_RACE stays private. Composition gets a fresh closed CONFLICT and
      // must abort its outer transaction, without our public retry loop.
      catch (error) { fail(ownErrors.get(error) || 'UNAVAILABLE') }
    } }
}

export function createYidaApprovedTargetStore(options = {}) {
  // Preserve input validation ahead of the public transaction capability check;
  // private composition deliberately does not provide its own transaction.
  const internals = createApprovedTargetInternals(options)
  if (!options.db || typeof options.db.transaction !== 'function') fail('UNAVAILABLE')
  return internals.publicStore
}

// Private host composition, never the public plugin API. Caller already owns
// its transaction and isolation. Lock order: permanent slot, 090, original 091.
// Unlike public inspect (which can report stale evidence), this reader requires
// current material and authenticates its full envelope without returning it.
export function createInternalYidaApprovedTargetTransactionReader({ security, context } = {}) {
  return createApprovedTargetInternals({ security, context }).readVerifiedInTransaction
}

// Internal persistence capability only. Actual host ACL and a server-owned
// tenant/owner anchor must precede any future online use of this writer.
export function createInternalYidaApprovedTargetTransactionWriter(options = {}) {
  try {
    const parsed = record(options, ['security', 'context'])
    return createApprovedTargetInternals(parsed).registerInTransaction
  } catch (error) { fail(ownErrors.get(error) || 'UNAVAILABLE') }
}
