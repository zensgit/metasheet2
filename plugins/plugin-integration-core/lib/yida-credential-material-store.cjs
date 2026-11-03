'use strict'

// Internal, unregistered persistence. Context must be supplied by a future
// trusted caller; equality here is not an owner grant or permission to send.
// Only the current encrypted bundle is kept. Rotation/revocation never recover
// old secrets, reset a generation, or release a delivery/business reservation.
const { randomUUID } = require('node:crypto')
const { types: { isProxy } } = require('node:util')
const { createCredentialStore } = require('./credential-store.cjs')

const MATERIALS = 'integration_yida_credential_materials'
const AUDIT = 'integration_yida_credential_audit'
const PURPOSE = 'yida-credential-material'
const MAX_GENERATION = 2147483647
const CONTEXT_KEYS = ['tenantId', 'workspaceId', 'ownerId']
const BINDING_KEYS = [...CONTEXT_KEYS, 'credentialRef', 'credentialGeneration']
const MATERIAL_KEYS = ['appKey', 'appSecret', 'systemToken', 'userId']
const ERROR_CODES = new Set(['INPUT', 'UNAVAILABLE', 'NOT_FOUND', 'CONFLICT', 'REVOKED', 'CANCELLED'])
const ownErrors = new WeakMap()
const abortGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get

class YidaCredentialMaterialError extends Error {
  constructor(code) {
    const fixed = ERROR_CODES.has(code) ? code : 'UNAVAILABLE'
    super(`YIDA_CREDENTIAL_${fixed}`)
    this.name = 'YidaCredentialMaterialError'
    this.code = this.message
    ownErrors.set(this, fixed)
  }
}
function fail(code) { throw new YidaCredentialMaterialError(code) }

function record(value, keys, required = keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || isProxy(value)) fail('INPUT')
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) fail('INPUT')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !keys.includes(key)
    || !Object.hasOwn(descriptors[key], 'value'))) fail('INPUT')
  if (required.some(key => !Object.hasOwn(descriptors, key))) fail('INPUT')
  return Object.fromEntries(Object.keys(descriptors).map(key => [key, descriptors[key].value]))
}
function opaque(value) {
  if (typeof value !== 'string' || !value || value.length > 128 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)) fail('INPUT')
  return value
}
function generation(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_GENERATION) fail('INPUT')
  return value
}
function material(value) {
  const result = record(value, MATERIAL_KEYS)
  for (const key of MATERIAL_KEYS) {
    // Do not trim or normalize secret bytes. Whitespace-only is not a material.
    if (typeof result[key] !== 'string' || !result[key].trim()
      || result[key].length > (key === 'userId' ? 128 : 4096)) fail('INPUT')
  }
  return result
}
function first(result) { return (Array.isArray(result) ? result : result?.rows)?.[0] ?? null }
function ciphertext(value) {
  if (typeof value !== 'string' || !value.startsWith('enc:') || value.length <= 4 || value.length > 262144) fail('UNAVAILABLE')
  return value
}
function checkSignal(signal) {
  if (signal === undefined) return
  if (!signal || typeof signal !== 'object' || isProxy(signal)
    || Object.getPrototypeOf(signal) !== AbortSignal.prototype) fail('INPUT')
  let aborted
  try { aborted = abortGetter.call(signal) } catch { fail('INPUT') }
  if (aborted) fail('CANCELLED')
}

function createCredentialInternals({ db, security, context } = {}) {
  const fixed = record(context, CONTEXT_KEYS)
  opaque(fixed.tenantId); opaque(fixed.ownerId)
  if (fixed.workspaceId !== null) opaque(fixed.workspaceId)
  Object.freeze(fixed)
  if (!security
    || typeof security.encrypt !== 'function' || typeof security.decrypt !== 'function') fail('UNAVAILABLE')
  // Missing host security must not enter credential-store's legacy/dev fallback.
  const vault = createCredentialStore({ security })
  const where = credentialRef => ({ credential_ref: credentialRef, tenant_id: fixed.tenantId,
    workspace_id: fixed.workspaceId, owner_id: fixed.ownerId })
  const binding = row => ({ ...fixed, credentialRef: row.credential_ref, credentialGeneration: row.generation })
  const metadata = row => Object.freeze({ ...binding(row), status: row.status })

  async function transaction(callback) {
    try {
      if (!db || typeof db.transaction !== 'function') fail('UNAVAILABLE')
      return await db.transaction(async trx => {
        if (!trx || ['setTransactionIsolationLevel', 'selectOneForUpdate', 'insertOne', 'updateRow']
          .some(key => typeof trx[key] !== 'function')) fail('UNAVAILABLE')
        await trx.setTransactionIsolationLevel('read committed')
        return callback(trx)
      })
    } catch (error) {
      // In particular: a lost COMMIT reply is unknown, never a claimed rollback
      // or a reason to retry CREATE/rotate automatically. No driver data/cause.
      fail(ownErrors.get(error) || 'UNAVAILABLE')
    }
  }
  async function locked(trx, credentialRef) {
    const row = await trx.selectOneForUpdate(MATERIALS, where(credentialRef))
    if (!row || row.credential_ref !== credentialRef || row.tenant_id !== fixed.tenantId
      || row.workspace_id !== fixed.workspaceId || row.owner_id !== fixed.ownerId) fail('NOT_FOUND')
    if (!Number.isInteger(row.generation) || row.generation < 1 || row.generation > MAX_GENERATION
      || !['current', 'revoked'].includes(row.status)) fail('UNAVAILABLE')
    return row
  }
  async function seal(credentialRef, credentialGeneration, bundle) {
    return ciphertext(await vault.encrypt(JSON.stringify({ purpose: PURPOSE, schemaVersion: 1,
      ...fixed, credentialRef, credentialGeneration, material: bundle })))
  }
  async function unseal(row) {
    // Host decrypt passes non-enc text through, and legacy credential-store can
    // read v1. Neither behavior is acceptable for this new closed store.
    const plaintext = await vault.decrypt(ciphertext(row.material_encrypted))
    if (typeof plaintext !== 'string' || plaintext.length > 131072) fail('UNAVAILABLE')
    let envelope, bundle
    try {
      envelope = record(JSON.parse(plaintext), ['purpose', 'schemaVersion', ...BINDING_KEYS, 'material'])
      bundle = material(envelope.material)
    } catch { fail('UNAVAILABLE') }
    if (envelope.purpose !== PURPOSE || envelope.schemaVersion !== 1
      || !BINDING_KEYS.every(key => envelope[key] === binding(row)[key])) fail('UNAVAILABLE')
    return bundle
  }
  async function audit(trx, row, event) {
    const entry = first(await trx.insertOne(AUDIT, { id: randomUUID(), credential_ref: row.credential_ref,
      generation: row.generation, event, status: row.status, actor_id: fixed.ownerId }))
    if (!entry || entry.credential_ref !== row.credential_ref || entry.generation !== row.generation
      || entry.event !== event || entry.status !== row.status || entry.actor_id !== fixed.ownerId) fail('UNAVAILABLE')
  }
  function expected(input, hasMaterial = false) {
    const parsed = record(input, ['credentialRef', 'expectedGeneration', ...(hasMaterial ? ['material'] : [])])
    return { credentialRef: opaque(parsed.credentialRef), expectedGeneration: generation(parsed.expectedGeneration),
      ...(hasMaterial ? { material: material(parsed.material) } : {}) }
  }
  function assertGeneration(row, wanted) { if (row.generation !== wanted) fail('CONFLICT') }

  function createInput(input) { return material(record(input, ['material']).material) }
  async function createInTransaction(trx, input, bundle = createInput(input)) {
    // Only the host's structured CRUD handle is accepted. The transaction
    // owner supplies BEGIN/isolation/COMMIT and decides whether to retry.
    if (!trx || typeof trx !== 'object' || isProxy(trx) || Array.isArray(trx)
      || ['selectOneForUpdate', 'insertOne', 'updateRow'].some(key => {
        const property = Object.getOwnPropertyDescriptor(trx, key)
        return !property || !Object.hasOwn(property, 'value') || typeof property.value !== 'function'
      })) fail('UNAVAILABLE')
    const credentialRef = randomUUID()
    const row = first(await trx.insertOne(MATERIALS, { ...where(credentialRef), generation: 1, status: 'current',
      material_encrypted: await seal(credentialRef, 1, bundle) }))
    if (!row || row.credential_ref !== credentialRef || row.generation !== 1 || row.status !== 'current'
      || row.tenant_id !== fixed.tenantId || row.workspace_id !== fixed.workspaceId
      || row.owner_id !== fixed.ownerId) fail('UNAVAILABLE')
    await audit(trx, row, 'create')
    return metadata(row)
  }
  async function create(input) {
    const bundle = createInput(input)
    return transaction(trx => createInTransaction(trx, input, bundle))
  }
  async function rotate(input) {
    const parsed = expected(input, true)
    return transaction(async trx => {
      const row = await locked(trx, parsed.credentialRef)
      assertGeneration(row, parsed.expectedGeneration)
      if (row.generation === MAX_GENERATION) fail('CONFLICT')
      const next = row.generation + 1
      const updated = first(await trx.updateRow(MATERIALS, { generation: next, status: 'current',
        material_encrypted: await seal(row.credential_ref, next, parsed.material) },
      { ...where(row.credential_ref), generation: row.generation, status: row.status }))
      if (!updated || updated.generation !== next || updated.status !== 'current') fail('UNAVAILABLE')
      await audit(trx, updated, 'rotate')
      return metadata(updated)
    })
  }
  async function revoke(input) {
    const parsed = expected(input)
    return transaction(async trx => {
      const row = await locked(trx, parsed.credentialRef)
      assertGeneration(row, parsed.expectedGeneration)
      if (row.status === 'revoked') return metadata(row)
      // Revoking does not allocate a generation: even the last representable
      // active generation can be revoked. Restoring needs fresh material +1.
      const updated = first(await trx.updateRow(MATERIALS, { status: 'revoked', material_encrypted: null },
        { ...where(row.credential_ref), generation: row.generation, status: 'current' }))
      if (!updated || updated.generation !== row.generation || updated.status !== 'revoked'
        || updated.material_encrypted !== null) fail('UNAVAILABLE')
      await audit(trx, updated, 'revoke')
      return metadata(updated)
    })
  }
  async function inspect(input) {
    const credentialRef = opaque(record(input, ['credentialRef']).credentialRef)
    return transaction(async trx => metadata(await locked(trx, credentialRef)))
  }
  async function loadTokenCredential(input, options = {}) {
    const requested = record(input, BINDING_KEYS)
    BINDING_KEYS.filter(key => key !== 'workspaceId' && key !== 'credentialGeneration').forEach(key => opaque(requested[key]))
    if (requested.workspaceId !== null) opaque(requested.workspaceId)
    generation(requested.credentialGeneration)
    if (!CONTEXT_KEYS.every(key => requested[key] === fixed[key])) fail('NOT_FOUND')
    const { signal } = record(options, ['signal'], [])
    checkSignal(signal)
    const result = await transaction(async trx => {
      const row = await locked(trx, requested.credentialRef)
      assertGeneration(row, requested.credentialGeneration)
      if (row.status !== 'current') fail('REVOKED')
      checkSignal(signal)
      const bundle = await unseal(row)
      checkSignal(signal)
      return Object.freeze({ ...binding(row), appKey: bundle.appKey, appSecret: bundle.appSecret })
    })
    checkSignal(signal)
    // This proves only the last durable check, not revocation of a token that
    // has already returned or a linearized authorization at a future socket.
    return result
  }
  async function readCurrentInTransaction(trx, input) {
    try {
      const parsed = record(input, ['credentialRef', 'credentialGeneration'])
      opaque(parsed.credentialRef); generation(parsed.credentialGeneration)
      if (!trx || typeof trx.selectOneForUpdate !== 'function') fail('UNAVAILABLE')
      const row = await locked(trx, parsed.credentialRef)
      assertGeneration(row, parsed.credentialGeneration)
      if (row.status !== 'current') fail('REVOKED')
      return { row, bundle: await unseal(row) }
    } catch (error) { fail(ownErrors.get(error) || 'UNAVAILABLE') }
  }
  async function assertCurrentInTransaction(trx, input) {
    // Both private consumers share the same lock/current-generation/envelope
    // checks. Admission keeps only metadata and discards all secret fields.
    try {
      const { row } = await readCurrentInTransaction(trx, input)
      return metadata(row)
    } catch (error) { fail(ownErrors.get(error) || 'UNAVAILABLE') }
  }
  async function readExecutionMaterialInTransaction(trx, input) {
    try {
      const { row, bundle } = await readCurrentInTransaction(trx, input)
      // Exact private return contract, without status, audit or envelope fields.
      // Secret bytes are copied verbatim: material() checks, but never trims.
      return Object.freeze({ ...binding(row), appKey: bundle.appKey, appSecret: bundle.appSecret,
        systemToken: bundle.systemToken, userId: bundle.userId })
    } catch (error) { fail(ownErrors.get(error) || 'UNAVAILABLE') }
  }
  return { publicStore: Object.freeze({ create, rotate, revoke, inspect, loadTokenCredential }),
    assertCurrentInTransaction, readExecutionMaterialInTransaction,
    async createInTransaction(trx, input) {
      try { return await createInTransaction(trx, input) }
      catch (error) { fail(ownErrors.get(error) || 'UNAVAILABLE') }
    } }
}

function createYidaCredentialMaterialStore(options = {}) {
  if (!options.db || typeof options.db.transaction !== 'function') fail('UNAVAILABLE')
  return createCredentialInternals(options).publicStore
}

// Private composition only. The caller owns the transaction and isolation;
// this primitive performs no BEGIN/SET/COMMIT and exposes no credential bytes.
function createInternalYidaCredentialCurrentAsserter({ security, context } = {}) {
  return createCredentialInternals({ security, context }).assertCurrentInTransaction
}

// Only a private host execution path may consume this capability. No public
// store method exposes the complete bundle, and no transaction is created here.
function createInternalYidaCredentialExecutionReader(options = {}) {
  try {
    const parsed = record(options, ['security', 'context'])
    return createCredentialInternals(parsed).readExecutionMaterialInTransaction
  } catch (error) { fail(ownErrors.get(error) || 'UNAVAILABLE') }
}

// Internal persistence only, never a grant of integration-admin/owner authority.
// A host must establish actual ACL and its owner anchor before composing this
// with other writers in an already-open transaction. No db capability enters.
function createInternalYidaCredentialTransactionWriter(options = {}) {
  try {
    const parsed = record(options, ['security', 'context'])
    return createCredentialInternals(parsed).createInTransaction
  } catch (error) { fail(ownErrors.get(error) || 'UNAVAILABLE') }
}

module.exports = { createYidaCredentialMaterialStore, YidaCredentialMaterialError,
  createInternalYidaCredentialCurrentAsserter, createInternalYidaCredentialExecutionReader,
  createInternalYidaCredentialTransactionWriter }
