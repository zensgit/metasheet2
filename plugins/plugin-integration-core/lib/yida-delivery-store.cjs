'use strict'

// SA05B1 internal storage only: no sender, credential loader, route, lease or clock.
// All scope and operation identities must come from a future trusted authority.
const crypto = require('node:crypto')
const { types: { isProxy } } = require('node:util')

const LEDGER = 'integration_yida_delivery_ledger'
const AUDIT = 'integration_yida_delivery_audit'
const UNIQUE_SCOPE_ROW = 'uniq_integration_yida_delivery_scope_row'
const UNIQUE_CREATE_BUSINESS = 'uniq_integration_yida_delivery_create_business'
const SNAPSHOT_KEYS = Object.freeze([
  'owner_id', 'target_ref', 'target_revision', 'plan_revision', 'payload_digest',
  'business_key_digest', 'credential_ref', 'credential_generation', 'intent', 'instance_id',
])
const UNKNOWN_REASONS = new Set([
  'transport_unknown', 'commit_unknown', 'receipt_invalid', 'manual_recovery',
])
const ID_RE = /^[^\u0000-\u001f\u007f]+$/u
const DIGEST_RE = /^[0-9a-f]{64}$/
const TOKEN_RE = /^[0-9a-f]{64}$/
const ERROR_CODES = new Set(['INPUT', 'TOKEN', 'UNAVAILABLE', 'NOT_FOUND', 'CONFLICT', 'BUSINESS_CONFLICT', 'STATE', 'ACK']
  .map(code => `YIDA_DELIVERY_${code}`))
const ownErrors = new WeakMap()

class YidaDeliveryStoreError extends Error {
  constructor(code) {
    const fixed = ERROR_CODES.has(code) ? code : 'YIDA_DELIVERY_UNAVAILABLE'
    super(fixed)
    this.name = 'YidaDeliveryStoreError'
    this.code = fixed
    ownErrors.set(this, fixed)
  }
}

// Carries no driver exception, SQL, parameters or business values. Its identity is
// private to this module, and prepare consumes it only after transaction rollback.
const PREPARE_RACE = new YidaDeliveryStoreError('YIDA_DELIVERY_CONFLICT')
const CREATE_BUSINESS_RACE = new YidaDeliveryStoreError('YIDA_DELIVERY_BUSINESS_CONFLICT')

function fail(code) { throw new YidaDeliveryStoreError(`YIDA_DELIVERY_${code}`) }

// Reject inherited/accessor and extra properties before reading any caller value.
function dataObject(value, keys, required = keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('INPUT')
  let descriptors
  try {
    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) fail('INPUT')
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch { fail('INPUT') }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !keys.includes(key) || !('value' in descriptors[key])) fail('INPUT')
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(descriptors, key)) fail('INPUT')
  }
  const result = Object.create(null)
  for (const key of Object.keys(descriptors)) result[key] = descriptors[key].value
  return result
}

function opaque(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128
    || value !== value.trim() || !ID_RE.test(value)) fail('INPUT')
  return value
}

function digest(value) {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) fail('INPUT')
  return value
}

function token(value) {
  if (typeof value !== 'string' || !TOKEN_RE.test(value)) fail('TOKEN')
  return value
}

function scope(input, extraKeys = [], requiredExtra = extraKeys) {
  const parsed = dataObject(input, ['tenantId', 'workspaceId', 'operationId', 'rowKey', 'ownerId', ...extraKeys],
    ['tenantId', 'workspaceId', 'operationId', 'rowKey', 'ownerId', ...requiredExtra])
  return {
    parsed,
    where: {
      tenant_id: opaque(parsed.tenantId),
      workspace_id: parsed.workspaceId === null ? null : opaque(parsed.workspaceId),
      operation_id: opaque(parsed.operationId),
      row_key: opaque(parsed.rowKey),
    },
    ownerId: opaque(parsed.ownerId),
  }
}

function first(result) {
  const rows = Array.isArray(result) ? result : (result && Array.isArray(result.rows) ? result.rows : [])
  return rows[0] || null
}

function project(row) {
  if (!row || !['prepared', 'dispatching', 'acknowledged', 'outcome_unknown', 'not_sent'].includes(row.status)) {
    fail('UNAVAILABLE')
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    operationId: row.operation_id,
    rowKey: row.row_key,
    ownerId: row.owner_id,
    intent: row.intent,
    status: row.status,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  }
}

function snapshot(parsed) {
  const intent = parsed.intent
  if (intent !== 'create' && intent !== 'update') fail('INPUT')
  const instanceId = intent === 'create'
    ? (Object.prototype.hasOwnProperty.call(parsed, 'instanceId') ? fail('INPUT') : null)
    : opaque(parsed.instanceId)
  if (!Number.isSafeInteger(parsed.credentialGeneration)
    || parsed.credentialGeneration < 1 || parsed.credentialGeneration > 2147483647) fail('INPUT')
  return {
    owner_id: opaque(parsed.ownerId),
    target_ref: opaque(parsed.targetRef),
    target_revision: opaque(parsed.targetRevision),
    plan_revision: opaque(parsed.planRevision),
    payload_digest: digest(parsed.payloadDigest),
    business_key_digest: digest(parsed.businessKeyDigest),
    credential_ref: opaque(parsed.credentialRef),
    credential_generation: parsed.credentialGeneration,
    intent,
    instance_id: instanceId,
  }
}

function sameSnapshot(row, expected) {
  return SNAPSHOT_KEYS.every((key) => row[key] === expected[key])
}

function equalToken(left, right) {
  return typeof left === 'string' && TOKEN_RE.test(left)
    && crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

function dbError(error) {
  if (error === PREPARE_RACE || error === CREATE_BUSINESS_RACE) throw error
  throw new YidaDeliveryStoreError(ownErrors.get(error) || 'YIDA_DELIVERY_UNAVAILABLE')
}

function prepareIdentity(input) {
  const names = [
    'targetRef', 'targetRevision', 'planRevision', 'payloadDigest', 'businessKeyDigest',
    'credentialRef', 'credentialGeneration', 'intent', 'instanceId',
  ]
  const identity = scope(input, names, names.filter(name => name !== 'instanceId'))
  return { identity, fixed: snapshot(identity.parsed) }
}

function uniqueConstraint(error) {
  // Constraint metadata is the only inspected driver fact. Never invoke an
  // arbitrary exception's getters/prototype traps while classifying a race.
  if (!error || typeof error !== 'object' || isProxy(error)) return null
  try {
    const code = Object.getOwnPropertyDescriptor(error, 'code')
    const constraint = Object.getOwnPropertyDescriptor(error, 'constraint')
    return code?.value === '23505' && typeof constraint?.value === 'string' ? constraint.value : null
  } catch { return null }
}

async function audit(trx, ledgerId, event, status, reason = null) {
  const row = first(await trx.insertOne(AUDIT, {
    id: crypto.randomUUID(), ledger_id: ledgerId, event, status, reason,
  }))
  if (!row || row.ledger_id !== ledgerId || row.event !== event || row.status !== status) fail('UNAVAILABLE')
}

async function prepareFixedInTransaction(trx, identity, fixed) {
  if (!trx || ['selectOneForUpdate', 'insertOne'].some(name => typeof trx[name] !== 'function')) fail('UNAVAILABLE')
  const existing = await trx.selectOneForUpdate(LEDGER, identity.where)
  if (existing) {
    if (!sameSnapshot(existing, fixed)) fail('CONFLICT')
    return { record: project(existing), reused: true }
  }
  let inserted
  try {
    inserted = first(await trx.insertOne(LEDGER, {
      id: crypto.randomUUID(), ...identity.where, ...fixed, status: 'prepared',
    }))
  } catch (error) {
    const constraint = uniqueConstraint(error)
    if (constraint === UNIQUE_SCOPE_ROW) throw PREPARE_RACE
    if (constraint === UNIQUE_CREATE_BUSINESS) throw CREATE_BUSINESS_RACE
    throw error
  }
  if (!inserted) fail('UNAVAILABLE')
  await audit(trx, inserted.id, 'prepare', 'prepared')
  return { record: project(inserted), reused: false }
}

// Private composition only. Never starts/retries/commits a transaction. A PG
// unique conflict aborts the caller's transaction and must be handled there.
async function prepareYidaDeliveryInTransaction(trx, input) {
  try {
    const { identity, fixed } = prepareIdentity(input)
    return await prepareFixedInTransaction(trx, identity, fixed)
  } catch (error) {
    throw new YidaDeliveryStoreError(ownErrors.get(error) || 'YIDA_DELIVERY_UNAVAILABLE')
  }
}

function createYidaDeliveryStore({ db } = {}) {
  if (!db || ['transaction', 'selectOne'].some((name) => typeof db[name] !== 'function')) fail('UNAVAILABLE')

  async function transaction(callback) {
    try {
      return await db.transaction(async (trx) => {
        if (!trx || ['setTransactionIsolationLevel', 'selectOneForUpdate', 'insertOne', 'updateRow']
          .some((name) => typeof trx[name] !== 'function')) fail('UNAVAILABLE')
        await trx.setTransactionIsolationLevel('read committed')
        return callback(trx)
      })
    } catch (error) { dbError(error) }
  }

  async function locked(trx, identity) {
    const row = await trx.selectOneForUpdate(LEDGER, { ...identity.where, owner_id: identity.ownerId })
    if (!row || row.owner_id !== identity.ownerId) fail('NOT_FOUND')
    return row
  }

  async function prepare(input) {
    const { identity, fixed } = prepareIdentity(input)
    // A known unique-key race is re-read only in a NEW transaction; never query an aborted PG transaction.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await transaction(trx => prepareFixedInTransaction(trx, identity, fixed))
      } catch (error) {
        if (error === CREATE_BUSINESS_RACE) {
          // A concurrent IDENTICAL operation can hit either unique index. Its
          // winning transaction is committed by the time PG reports 23505.
          // Re-read our original identity only after rollback, in a new tx;
          // never expose a competing operation/owner's row or private snapshot.
          return transaction(async (trx) => {
            const existing = await trx.selectOneForUpdate(LEDGER, identity.where)
            if (!existing) fail('BUSINESS_CONFLICT')
            if (!sameSnapshot(existing, fixed)) fail('CONFLICT')
            return { record: project(existing), reused: true }
          })
        }
        if (error === PREPARE_RACE) {
          if (attempt === 0) continue
          fail('CONFLICT')
        }
        throw error
      }
    }
    fail('CONFLICT')
  }

  async function claim(input) {
    const identity = scope(input, ['actorId'])
    const actorId = opaque(identity.parsed.actorId)
    return transaction(async (trx) => {
      const row = await locked(trx, identity)
      if (row.status !== 'prepared') fail('STATE')
      const claimToken = crypto.randomBytes(32).toString('hex')
      const changed = first(await trx.updateRow(LEDGER, {
        status: 'dispatching', claim_token: claimToken, claim_actor_id: actorId,
      }, { id: row.id, ...identity.where, owner_id: identity.ownerId, status: 'prepared' }))
      if (!changed) fail('STATE')
      await audit(trx, row.id, 'claim', 'dispatching')
      return { record: project(changed), claimToken }
    })
  }

  async function finish(input, kind) {
    const names = kind === 'acknowledgement' ? ['actorId', 'claimToken', 'ack'] : ['actorId', 'claimToken', 'reason']
    const identity = scope(input, names)
    const actorId = opaque(identity.parsed.actorId)
    const claimToken = token(identity.parsed.claimToken)
    let ack = null
    let reason = null
    if (kind === 'acknowledgement') {
      ack = dataObject(identity.parsed.ack, ['statusCode', 'instanceId'])
      if (!Number.isInteger(ack.statusCode) || ack.statusCode < 200 || ack.statusCode > 299) fail('ACK')
      try { opaque(ack.instanceId) } catch { fail('ACK') }
    } else {
      reason = identity.parsed.reason
      if (!UNKNOWN_REASONS.has(reason)) fail('INPUT')
    }
    return transaction(async (trx) => {
      const row = await locked(trx, identity)
      if (row.status !== 'dispatching') fail('STATE')
      if (row.claim_actor_id !== actorId || !equalToken(row.claim_token, claimToken)) fail('TOKEN')
      if (ack && row.intent === 'update' && ack.instanceId !== row.instance_id) fail('ACK')
      const status = kind === 'acknowledgement' ? 'acknowledged' : 'outcome_unknown'
      const set = ack
        ? { status, ack_status_code: ack.statusCode, ack_instance_id: ack.instanceId }
        : { status }
      const changed = first(await trx.updateRow(LEDGER, set, {
        id: row.id, ...identity.where, owner_id: identity.ownerId,
        status: 'dispatching', claim_token: claimToken, claim_actor_id: actorId,
      }))
      if (!changed) fail('STATE')
      await audit(trx, row.id, kind === 'acknowledgement' ? 'acknowledgement' : 'unknown', status, reason)
      return project(changed)
    })
  }

  async function recordAcknowledgement(input) { return finish(input, 'acknowledgement') }
  async function markUnknown(input) { return finish(input, 'unknown') }

  async function cancelPrepared(input) {
    const identity = scope(input, ['actorId'])
    opaque(identity.parsed.actorId)
    return transaction(async (trx) => {
      const row = await locked(trx, identity)
      if (row.status !== 'prepared') fail('STATE')
      const changed = first(await trx.updateRow(LEDGER, { status: 'not_sent' }, {
        id: row.id, ...identity.where, owner_id: identity.ownerId, status: 'prepared',
      }))
      if (!changed) fail('STATE')
      await audit(trx, row.id, 'cancel', 'not_sent')
      return project(changed)
    })
  }

  async function get(input) {
    const identity = scope(input)
    try {
      const row = await db.selectOne(LEDGER, { ...identity.where, owner_id: identity.ownerId })
      return row ? project(row) : null
    } catch (error) { dbError(error) }
  }

  return { prepare, claim, recordAcknowledgement, markUnknown, cancelPrepared, get }
}

module.exports = { createYidaDeliveryStore, YidaDeliveryStoreError, prepareYidaDeliveryInTransaction }
