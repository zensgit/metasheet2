import { types } from 'node:util'
import database from './db.cjs'
import credentialMaterials from './yida-credential-material-store.cjs'
import { compileYidaDraft } from './yida-draft-plan.mjs'
import { createInternalYidaDraftTransactionReader, createInternalYidaDraftTransactionWriter } from './yida-draft-plan-store.mjs'
import { createInternalYidaApprovedTargetTransactionWriter } from './yida-approved-target-store.mjs'

// Private persistence composition only. The host must first establish actual
// live ACL, its permanent deployment anchor and command inside this transaction.
// Nothing here grants first-admin authority, starts a transaction or performs external IO.
const ownErrors = new WeakMap()
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
class YidaInitializationProducerError extends Error {
  constructor(code) {
    const fixed = code === 'INPUT' ? 'INPUT' : 'UNAVAILABLE'
    super(`YIDA_INITIALIZATION_PRODUCER_${fixed}`)
    this.name = 'YidaInitializationProducerError'
    this.code = this.message
    ownErrors.set(this, fixed)
  }
}
function fail(code = 'INPUT') { throw new YidaInitializationProducerError(code) }
function closed(error) { fail(ownErrors.get(error) || 'UNAVAILABLE') }
function record(value, keys) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) fail()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key))) fail()
  const result = Object.create(null)
  for (const key of keys) {
    const property = descriptors[key]
    if (!property.enumerable || !Object.hasOwn(property, 'value')) fail()
    result[key] = property.value
  }
  return result
}
function id(value) {
  if (typeof value !== 'string' || !value || value.length > 128 || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) fail()
  return value
}
function securityCapability(value) {
  if (!value || typeof value !== 'object' || types.isProxy(value)) fail()
  const result = Object.create(null)
  for (const name of ['encrypt', 'decrypt']) {
    const property = Object.getOwnPropertyDescriptor(value, name)
    if (!property || !Object.hasOwn(property, 'value') || typeof property.value !== 'function' || types.isProxy(property.value)) fail()
    const method = property.value
    result[name] = (...args) => Reflect.apply(method, value, args)
  }
  return Object.freeze(result)
}
function crud(rawTrx) {
  const parsed = record(rawTrx, ['query'])
  if (typeof parsed.query !== 'function' || types.isProxy(parsed.query)) fail()
  const query = parsed.query
  return database.createDb({ database: { async query(sql, params) {
    const result = await Reflect.apply(query, rawTrx, [sql, params])
    if (!result || types.isProxy(result) || !Array.isArray(result.rows)) fail('UNAVAILABLE')
    return result.rows
  } } })
}
function capturedInput(input) {
  const parsed = record(input, ['commandId', 'material', 'draft', 'attestation'])
  if (typeof parsed.commandId !== 'string' || !UUID.test(parsed.commandId)) fail()
  const material = record(parsed.material, ['appKey', 'appSecret', 'systemToken', 'userId'])
  for (const name of Object.keys(material)) {
    if (typeof material[name] !== 'string' || !material[name].trim() || material[name].length > (name === 'userId' ? 128 : 4096)) fail()
  }
  // Check, never trim or normalize, the four original material fields.
  if (Buffer.byteLength(JSON.stringify(material), 'utf8') > 16 * 1024) fail()
  const draft = record(parsed.draft, ['config', 'rowsText', 'allocation'])
  if (typeof draft.rowsText !== 'string' || Buffer.byteLength(draft.rowsText, 'utf8') > 128 * 1024) fail()
  const compiled = compileYidaDraft({ config: draft.config, rowsText: draft.rowsText, allocation: draft.allocation })
  if (compiled.source.config.intent !== 'create') fail()
  const attestation = record(parsed.attestation, ['kind', 'reviewRef', 'organizationId', 'executionIdentity'])
  if (attestation.kind !== 'owner-reviewed-target') fail()
  for (const name of ['reviewRef', 'organizationId', 'executionIdentity']) id(attestation[name])
  if (attestation.executionIdentity !== material.userId) fail()
  return Object.freeze({ commandId: parsed.commandId, material: Object.freeze(material),
    draft: compiled.source, attestation: Object.freeze(attestation) })
}
function draftView(checked, reused) {
  return Object.freeze({ targetRef: checked.target.target_ref, operationId: checked.operation.operation_id,
    status: 'unverified', identityKind: 'local-unverified', canSend: false, canApply: false,
    tokenIssued: false, externalWriteAttempted: false, rowCount: checked.members.length,
    rows: Object.freeze(checked.members.map(row => Object.freeze({ rowKey: row.row_key, index: row.ordinal }))), reused })
}
export function createYidaInitializationBinding(options) {
  try {
    const parsed = record(options, ['security']), security = securityCapability(parsed.security)
    return Object.freeze({ createInitializationProducer(inputContext) {
      try {
        const actor = record(inputContext, ['actorId', 'tenantId', 'workspaceId'])
        if (actor.workspaceId !== null) fail()
        const context = Object.freeze({ ownerId: id(actor.actorId), tenantId: id(actor.tenantId), workspaceId: null })
        const options = { security, context }
        const writeMaterial = credentialMaterials.createInternalYidaCredentialTransactionWriter(options)
        const writeDraft = createInternalYidaDraftTransactionWriter(options)
        const writeTarget = createInternalYidaApprovedTargetTransactionWriter(options)
        const readDraft = createInternalYidaDraftTransactionReader(options)
        return Object.freeze({
          async initializeInTransaction(rawTrx, input) {
            try {
              const captured = capturedInput(input), trx = crud(rawTrx)
              const material = await writeMaterial(trx, { material: captured.material })
              const draft = await writeDraft(trx, captured.draft)
              const target = await writeTarget(trx, { operationId: draft.operationId,
                credentialRef: material.credentialRef, credentialGeneration: material.credentialGeneration,
                attestation: captured.attestation })
              return Object.freeze({ draft, credentialRef: material.credentialRef,
                credentialGeneration: material.credentialGeneration, targetRef: target.targetRef })
            } catch (error) { closed(error) }
          },
          async inspectDraftInTransaction(rawTrx, input) {
            try {
              const requested = record(input, ['operationId'])
              const operationId = id(requested.operationId)
              return draftView(await readDraft(crud(rawTrx), { operationId }), true)
            } catch (error) { closed(error) }
          },
        })
      } catch (error) { closed(error) }
    } })
  } catch (error) { closed(error) }
}
