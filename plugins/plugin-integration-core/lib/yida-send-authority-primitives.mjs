import { createHash } from 'node:crypto'
import { types } from 'node:util'
import canonical from './gip-canonical-json.cjs'
import database from './db.cjs'
import credentialMaterials from './yida-credential-material-store.cjs'
import delivery from './yida-delivery-store.cjs'
import executionDigest from './yida-execution-digest.cjs'
import { createInternalYidaApprovedTargetTransactionReader } from './yida-approved-target-store.mjs'
import { createInternalYidaDraftTransactionReader, createInternalYidaDraftTransactionWriter } from './yida-draft-plan-store.mjs'
import { compileYidaDraft } from './yida-draft-plan.mjs'
import { buildYidaStaticPlan } from './yida-static-plan.mjs'

// Host-private composition, never a plugin API/route/authority callback. The
// host establishes its real actor permission, owns one transaction/isolation,
// persists the grant/attempt and commits it. None of these functions can send,
// exchange tokens, start a transaction, or claim that owner equality is ACL.
const CONTEXT = ['tenantId', 'workspaceId', 'ownerId']
const PREPARE = [...CONTEXT, 'operationId', 'rowKey', 'targetRef', 'targetRevision', 'planRevision',
  'payloadDigest', 'businessKeyDigest', 'credentialRef', 'credentialGeneration', 'intent']
const ERROR_CODES = new Set(['INPUT', 'UNAVAILABLE', 'NOT_FOUND', 'CONFLICT'])
const ownErrors = new WeakMap()
const { stableCanonicalStringify, deepCloneFrozenCanonical } = canonical

export class YidaSendAuthorityError extends Error {
  constructor(code) {
    const fixed = ERROR_CODES.has(code) ? code : 'UNAVAILABLE'
    super(`YIDA_SEND_AUTHORITY_${fixed}`)
    this.name = 'YidaSendAuthorityError'
    this.code = this.message
    ownErrors.set(this, fixed)
  }
}
function fail(code) { throw new YidaSendAuthorityError(code) }
function closed(error) { fail(ownErrors.get(error) || 'UNAVAILABLE') }
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
function rows(result) {
  if (Array.isArray(result)) return result
  if (!result || types.isProxy(result) || !Array.isArray(result.rows)) fail('UNAVAILABLE')
  return result.rows
}
function crud(trx) {
  if (!trx || types.isProxy(trx) || typeof trx.query !== 'function') fail('UNAVAILABLE')
  // This actual db.cjs instance has no database.transaction at all. Only CRUD
  // SQL is routed to the host's already-open raw queryable transaction.
  return database.createDb({ database: { query: async (sql, params) => rows(await trx.query(sql, params)) } })
}
const same = (left, right) => stableCanonicalStringify(left) === stableCanonicalStringify(right)

function reconstructRows(compiled) {
  const config = compiled.source.config
  if (config.intent !== 'create') fail('CONFLICT')
  // Allocation is already performed by the real full draft compiler. Recover
  // source field names from its executed payloads, never rowsText[ordinal] and
  // never a second implementation of equal_integer/equal_decimal_exact.
  const sourceRows = compiled.plan.rows.map(planned => Object.fromEntries(config.fieldMap
    .filter(field => Object.hasOwn(planned.payload, field.target))
    .map(field => [field.source, planned.payload[field.target]])))
  const verified = buildYidaStaticPlan({ config, rows: sourceRows })
  if (verified.rows.length !== compiled.plan.rows.length || verified.evidence.invalid !== 0
    || verified.evidence.duplicateKeyCount !== 0 || verified.canApply !== false
    || verified.tokenIssued !== false || verified.lookupExecuted !== false || verified.externalWriteAttempted !== false) fail('UNAVAILABLE')
  for (let index = 0; index < verified.rows.length; index++) {
    const row = verified.rows[index], original = compiled.plan.rows[index]
    if (row.status !== 'planned_create' || row.issues.length !== 0
      || row.localBusinessKey !== original.localBusinessKey || !same(row.payload, original.payload)
      || !same(row.protocolPreview, original.protocolPreview)) fail('UNAVAILABLE')
  }
  return { sourceRows, verified }
}

function createPrimitives(options) {
  const parsed = record(options, ['security', 'context'])
  const fixed = record(parsed.context, CONTEXT)
  opaque(fixed.tenantId); opaque(fixed.ownerId)
  if (fixed.workspaceId !== null) fail('INPUT')
  Object.freeze(fixed)
  const readTarget = createInternalYidaApprovedTargetTransactionReader({ security: parsed.security, context: fixed })
  const readDraft = createInternalYidaDraftTransactionReader({ security: parsed.security, context: fixed })
  const writeDraft = createInternalYidaDraftTransactionWriter({ security: parsed.security, context: fixed })
  const readExecutionMaterial = credentialMaterials.createInternalYidaCredentialExecutionReader({ security: parsed.security, context: fixed })
  const selections = new WeakMap()

  async function prepareDraftInTransaction(trx, input) {
    try {
      const db = crud(trx)
      // The permanent slot, current authenticated 090, and original 091 all
      // pass before a candidate may reach the existing local draft writer.
      const approved = await readTarget(db)
      const compiled = compileYidaDraft(input)
      if (compiled.source.config.intent !== 'create') fail('CONFLICT')
      if (approved.target.locator_digest !== compiled.locatorDigest
        || approved.target.key_definition_digest !== compiled.keyDefinitionDigest
        || !same(approved.envelope.locator, compiled.locator)
        || !same(approved.envelope.keyDefinition, compiled.keyDefinition)) fail('CONFLICT')
      return await writeDraft(db, compiled.source)
    } catch (error) { closed(error) }
  }

  async function resolveSelectionInTransaction(trx, input) {
    try {
      const requested = record(input, ['operationId', 'rowKey'])
      opaque(requested.operationId); opaque(requested.rowKey)
      const db = crud(trx)
      // This reader owns actual slot -> 090 -> original 091 locks and full
      // target/material authentication; then lock/replay the selected 091.
      const approved = await readTarget(db)
      const selected = await readDraft(db, { operationId: requested.operationId })
      const compiled = selected.compiled
      if (approved.target.locator_digest !== compiled.locatorDigest
        || approved.target.key_definition_digest !== compiled.keyDefinitionDigest
        || !same(approved.envelope.locator, compiled.locator)
        || !same(approved.envelope.keyDefinition, compiled.keyDefinition)) fail('CONFLICT')
      const member = selected.members.find(row => row.row_key === requested.rowKey)
      if (!member) fail('NOT_FOUND')
      const { sourceRows, verified } = reconstructRows(compiled)
      const planned = verified.rows[member.ordinal]
      if (!planned || createHash('sha256').update(planned.localBusinessKey).digest('hex') !== member.business_key_digest) fail('UNAVAILABLE')
      const data = deepCloneFrozenCanonical({ ...planned.protocolPreview.data,
        formDataJson: stableCanonicalStringify(planned.payload) })
      const selection = deepCloneFrozenCanonical({ ...fixed, operationId: selected.operation.operation_id,
        rowKey: member.row_key, targetRef: approved.target.target_ref, targetRevision: 'evidence-1',
        planRevision: compiled.planDigest, credentialRef: approved.target.credential_ref,
        credentialGeneration: approved.target.credential_generation, businessKeyDigest: member.business_key_digest,
        rowPayloadDigest: member.payload_digest, planDigest: compiled.planDigest,
        config: compiled.source.config, selectedRow: sourceRows[member.ordinal], source: compiled.source, plan: compiled.plan })
      selections.set(selection, data)
      return selection
    } catch (error) { closed(error) }
  }
  function executionPayloadDigest(selection, input) {
    try {
      const data = selections.get(selection)
      if (!data) fail('INPUT')
      const grant = record(input, ['grantRef', 'expiresAt', 'actorId'])
      opaque(grant.grantRef); opaque(grant.actorId)
      if (!Number.isSafeInteger(grant.expiresAt) || grant.expiresAt < 1) fail('INPUT')
      if (grant.actorId !== fixed.ownerId) fail('CONFLICT')
      return executionDigest.buildYidaExecutionPayloadDigest({ snapshot: { ...selection, ...grant }, intent: 'create', data })
    } catch (error) { closed(error) }
  }
  async function prepareInTransaction(trx, input) {
    try {
      const requested = record(input, PREPARE)
      if (!CONTEXT.every(key => requested[key] === fixed[key]) || requested.intent !== 'create') fail('CONFLICT')
      const prepared = await delivery.prepareYidaDeliveryInTransaction(crud(trx), requested)
      return Object.freeze({ record: Object.freeze(prepared.record), reused: prepared.reused })
    } catch (error) { closed(error) }
  }
  async function loadExecutionMaterialInTransaction(trx, input) {
    try {
      const requested = record(input, ['credentialRef', 'credentialGeneration'])
      opaque(requested.credentialRef)
      if (!Number.isInteger(requested.credentialGeneration) || requested.credentialGeneration < 1
        || requested.credentialGeneration > 2147483647) fail('INPUT')
      const db = crud(trx)
      // Preserve slot -> 090 -> original 091 lock order. These are reentrant
      // reads inside the host's existing authority transaction, never new ones.
      const approved = await readTarget(db)
      if (approved.target.credential_ref !== requested.credentialRef
        || approved.target.credential_generation !== requested.credentialGeneration) fail('CONFLICT')
      const material = await readExecutionMaterial(db, requested)
      if (!CONTEXT.every(key => material[key] === fixed[key])
        || material.credentialRef !== requested.credentialRef
        || material.credentialGeneration !== requested.credentialGeneration
        || material.userId !== approved.envelope.attestation.executionIdentity) fail('CONFLICT')
      return material
    } catch (error) { closed(error) }
  }
  async function previewInTransaction(trx, input) {
    try {
      const selection = await resolveSelectionInTransaction(trx, input)
      const approved = await readTarget(crud(trx))
      const compiled = compileYidaDraft(selection.source)
      if (approved.target.target_ref !== selection.targetRef
        || approved.target.credential_ref !== selection.credentialRef
        || approved.target.credential_generation !== selection.credentialGeneration
        || approved.target.locator_digest !== compiled.locatorDigest
        || approved.target.key_definition_digest !== compiled.keyDefinitionDigest
        || !same(approved.envelope.locator, compiled.locator)
        || !same(approved.envelope.keyDefinition, compiled.keyDefinition)) fail('CONFLICT')
      // Full material validation also compares userId with the authenticated
      // attestation through the existing loader. Discard its private result.
      await loadExecutionMaterialInTransaction(trx, { credentialRef: selection.credentialRef,
        credentialGeneration: selection.credentialGeneration })
      const payload = JSON.parse(selections.get(selection).formDataJson)
      return deepCloneFrozenCanonical({ operationId: selection.operationId, rowKey: selection.rowKey,
        planDigest: selection.planDigest, rowPayloadDigest: selection.rowPayloadDigest,
        target: { targetRef: approved.target.target_ref, identityKind: 'owner-attested-single-target', evidenceVersion: 1,
          reviewRef: approved.envelope.attestation.reviewRef, organizationId: approved.envelope.attestation.organizationId,
          appType: approved.envelope.locator.appType, formUuid: approved.envelope.locator.formUuid },
        payload, policy: { intent: 'create', maxAttempts: 1, maxTtlMs: 900000,
          requiresExplicitConfirmation: true, unknownMustNotRetry: true }, canSend: false, externalWriteAttempted: false })
    } catch (error) { closed(error) }
  }
  return Object.freeze({ prepareDraftInTransaction, previewInTransaction, resolveSelectionInTransaction,
    executionPayloadDigest, prepareInTransaction, loadExecutionMaterialInTransaction })
}

export function createYidaSendAuthorityPrimitives(options) {
  try { return createPrimitives(options) } catch (error) { closed(error) }
}
