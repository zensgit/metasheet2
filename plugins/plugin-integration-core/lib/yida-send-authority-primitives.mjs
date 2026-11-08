import { createHash } from 'node:crypto'
import { types } from 'node:util'
import canonical from './gip-canonical-json.cjs'
import database from './db.cjs'
import credentialMaterials from './yida-credential-material-store.cjs'
import delivery from './yida-delivery-store.cjs'
import executionDigest from './yida-execution-digest.cjs'
import sendBudgetModule from './yida-send-budget.cjs'
import { createInternalYidaApprovedTargetTransactionReader } from './yida-approved-target-store.mjs'
import { createInternalYidaDraftTransactionReader, createInternalYidaDraftTransactionWriter } from './yida-draft-plan-store.mjs'
import { compileYidaSendDraft } from './yida-draft-plan.mjs'
import { buildYidaStaticPlan, parseYidaStaticRows, yidaGeneratedLayout, yidaTransformSourceColumns } from './yida-static-plan.mjs'
import { expandYidaProjectAllocationRows } from './stock-preparation-yida-allocation.mjs'

// Host-private composition, never a plugin API/route/authority callback. The
// host establishes its real actor permission, owns one transaction/isolation,
// persists the grant/attempt and commits it. None of these functions can send,
// exchange tokens, start a transaction, or claim that owner equality is ACL.
const CONTEXT = ['tenantId', 'workspaceId', 'ownerId']
const PREPARE = [...CONTEXT, 'operationId', 'rowKey', 'targetRef', 'targetRevision', 'planRevision',
  'payloadDigest', 'businessKeyDigest', 'credentialRef', 'credentialGeneration', 'intent']
// Source binding (design baseline v2.3 §7.2): a bound selection names its two digests and its per-row
// binding; the host hands all three to the admission together. Absent = the original unbound shape.
const BINDING = ['sourceRecordDigest', 'creationIdentityDigest', 'sourceBinding']
const ROW_BINDING = ['sheetId', 'recordId', 'keyFieldId', 'keyValue', 'projectNo', 'fieldBindings', 'fieldDependencies']
const DRAFT_INPUT = ['config', 'rowsText', 'allocation']
// The project-sheet registry (migration 087): one active row per (tenant, project number) names the sheet.
const PROJECT_REGISTRY = 'integration_stock_prep_project_target'
// P1 (external review 2026-11-08; migration zzzz20261108120000): one sealed generated layout per approved target.
const GENERATED_LAYOUT = 'integration_yida_generated_layout'
const GENERATED_LAYOUT_EVENTS = new Set(['approve', 'admit'])
const GENERATED_LAYOUT_PKEY = 'integration_yida_generated_layout_pkey'
const LAYOUT_CONFLICT = Object.freeze({ admissible: false, code: 'GENERATED_LAYOUT_CONFLICT' })
const layoutAdmissible = sealed => Object.freeze({ admissible: true, sealed })
const DIGEST_RE = /^[0-9a-f]{64}$/
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
// The seal's digest: sha256 of the planner's canonical generated layout (null without a generated entry).
function generatedLayoutDigest(config) {
  const layout = yidaGeneratedLayout(config)
  return layout === null ? null : createHash('sha256').update(stableCanonicalStringify(layout), 'utf8').digest('hex')
}
function layoutRace(error) {
  if (!error || typeof error !== 'object' || types.isProxy(error)) return false
  // PG's own data fields identify the one INSERT race on the seal's primary key (two first uses without the
  // approved-target row lock the host transaction always holds); nothing else of the rejection is inspected.
  return Object.getOwnPropertyDescriptor(error, 'code')?.value === '23505'
    && Object.getOwnPropertyDescriptor(error, 'constraint')?.value === GENERATED_LAYOUT_PKEY
}
// Y2 multi-target: the host passes `targetRef` ONLY while its multi-target switch reads exact 'true'.
// Absent, every primitive keeps the original closed input and the permanent slot-1 read unchanged.
const hasTarget = input => Boolean(input) && typeof input === 'object' && !types.isProxy(input)
  && Object.hasOwn(input, 'targetRef')
const hasKey = (input, key) => Boolean(input) && typeof input === 'object' && !types.isProxy(input) && Object.hasOwn(input, key)
// A draft input is the closed triple, plus the host's optional sourceBinding (never a request-body field).
const draftKeys = input => (hasKey(input, 'sourceBinding') ? [...DRAFT_INPUT, 'sourceBinding'] : DRAFT_INPUT)
function digest(value) {
  if (typeof value !== 'string' || !DIGEST_RE.test(value)) fail('INPUT')
  return value
}
function targeted(input, keys) {
  if (hasTarget(input)) {
    const parsed = record(input, [...keys, 'targetRef'])
    const targetRef = opaque(parsed.targetRef)
    const rest = {}
    for (const key of keys) Object.defineProperty(rest, key, { value: parsed[key], enumerable: true })
    return { parsed: rest, targetRef }
  }
  return { parsed: record(input, keys), targetRef: undefined }
}

function reconstructRows(compiled) {
  const config = compiled.source.config
  if (config.intent !== 'create') fail('CONFLICT')
  if (config.version === 3) return projectTransformRows(compiled)
  if (config.version !== 2) fail('UNAVAILABLE')
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

// R-71 ⑦.3: a v3 payload cannot be reversed into its row (copy / constant / concat entries have no
// single source column, and a concat-only column never reaches the payload). The selected rows are
// re-derived from the persisted source instead: the original rows, or the ONE shared allocation
// expansion (never a second equal_integer / equal_decimal_exact implementation). Each row is then
// projected onto the columns the mapping reads, so unmapped source columns never enter a grant, an
// execution snapshot or a budget input; an absent column stays absent and null stays null. The
// projected rows are planned again and must reproduce the compiled plan exactly, row by row.
function projectTransformRows(compiled) {
  const { config, rowsText, allocation } = compiled.source
  const expanded = allocation.mode === 'original'
    ? parseYidaStaticRows(rowsText, config)
    : expandYidaProjectAllocationRows({ config, rowsText, allocation })
  const columns = yidaTransformSourceColumns(config)
  const sourceRows = expanded.map(row => Object.fromEntries(columns
    .filter(column => Object.hasOwn(row, column)).map(column => [column, row[column]])))
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

// R-71 ⑦.3 decision C1 worst-case placeholders for the draft-time budget. Every opaque id the
// draft does not know yet (operation, row, grant, target, credential) is at most 128 UTF-16 units;
// a control character costs the most bytes a unit can cost once serialized (6), and serialized
// bytes bound raw bytes. expiresAt and the generation take their largest accepted values.
const WORST_OPAQUE = '\u0001'.repeat(128)
const WORST_EXPIRES_AT = Number.MAX_SAFE_INTEGER
const WORST_GENERATION = 2147483647
const WORST_DIGEST = 'f'.repeat(64)

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
      const { parsed: source, targetRef } = hasTarget(input)
        ? targeted(input, draftKeys(input)) : { parsed: input, targetRef: undefined }
      // The permanent slot (or, multi-target ON, the named owned target), current
      // authenticated 090, and original 091 all pass before a candidate may reach
      // the existing local draft writer.
      const approved = await readTarget(db, targetRef)
      const compiled = compileYidaSendDraft(source)
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
      const { parsed: requested, targetRef } = targeted(input, ['operationId', 'rowKey'])
      opaque(requested.operationId); opaque(requested.rowKey)
      const db = crud(trx)
      // This reader owns actual slot -> 090 -> original 091 locks and full
      // target/material authentication; then lock/replay the selected 091.
      // An operation compiled for another target's locator fails CONFLICT below.
      const approved = await readTarget(db, targetRef)
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
      // The draft reader already compared the durable binding digests with the recompiled row spec; the
      // selection carries the recompiled values (null for an unbound row) and the per-row binding.
      const spec = compiled.rowSpecs[member.ordinal]
      const data = deepCloneFrozenCanonical({ ...planned.protocolPreview.data,
        formDataJson: stableCanonicalStringify(planned.payload) })
      const selection = deepCloneFrozenCanonical({ ...fixed, operationId: selected.operation.operation_id,
        rowKey: member.row_key, targetRef: approved.target.target_ref, targetRevision: 'evidence-1',
        planRevision: compiled.planDigest, credentialRef: approved.target.credential_ref,
        credentialGeneration: approved.target.credential_generation, businessKeyDigest: member.business_key_digest,
        rowPayloadDigest: member.payload_digest, planDigest: compiled.planDigest,
        sourceRecordDigest: spec.sourceRecordDigest ?? null, creationIdentityDigest: spec.creationIdentityDigest ?? null,
        sourceBinding: spec.sourceBinding ?? null,
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
  // Gate 4 (R-71 ⑦.2): would the runner snapshot bound and the form transport request-body bound
  // accept this selection once a grant names it? Same branded selection, same grant fields and
  // owner rule as executionPayloadDigest; the snapshot has the exact shape the host execution
  // handle resolves (resolveExecutionSnapshot), with the two credential fields left to the
  // shared worst-case placeholders. No material is read or decrypted. One boolean, values-free.
  function sendBudget(selection, input) {
    try {
      const data = selections.get(selection)
      if (!data) fail('INPUT')
      const grant = record(input, ['grantRef', 'expiresAt', 'actorId'])
      opaque(grant.grantRef); opaque(grant.actorId)
      if (!Number.isSafeInteger(grant.expiresAt) || grant.expiresAt < 1) fail('INPUT')
      if (grant.actorId !== fixed.ownerId) fail('CONFLICT')
      const snapshot = { tenantId: selection.tenantId, workspaceId: selection.workspaceId, ownerId: selection.ownerId,
        actorId: grant.actorId, operationId: selection.operationId, rowKey: selection.rowKey, grantRef: grant.grantRef,
        expiresAt: grant.expiresAt, targetRef: selection.targetRef, targetRevision: selection.targetRevision,
        planRevision: selection.planRevision, credentialRef: selection.credentialRef,
        credentialGeneration: selection.credentialGeneration, config: selection.config, row: selection.selectedRow,
        sourceRecordDigest: selection.sourceRecordDigest, creationIdentityDigest: selection.creationIdentityDigest }
      const verdict = sendBudgetModule.assessYidaSendBudget({ snapshot, data })
      return Object.freeze({ withinBudget: verdict.withinBudget === true })
    } catch (error) { closed(error) }
  }
  // R-71 ⑦.3 decision C1: a v3 mapping's constants and copies are not bounded by the 128 KiB row
  // text, so a v3 draft must pass the gate-4 send budget when it is created, not first at approval.
  // Pure: no transaction, no target, no material. Every row of the draft is assessed with the exact
  // snapshot shape sendBudget builds, the unknown fields taken at their worst case (which dominates
  // every real value), so a draft that passes here passes sendBudget at approval and admission.
  // v2 is unchanged: { withinBudget: true } without assessing (its payload is bounded by its rows).
  function draftSendBudget(input) {
    try {
      const source = record(input, draftKeys(input))
      const compiled = compileYidaSendDraft(source)
      if (compiled.source.config.version !== 3) return Object.freeze({ withinBudget: true })
      // create only: reconstructRows refuses any other intent (CONFLICT), as prepareDraft does.
      const { sourceRows, verified } = reconstructRows(compiled)
      const within = verified.rows.every((planned, index) => {
        // The two binding digests at their worst case (a 64-hex string dominates null).
        const snapshot = { tenantId: fixed.tenantId, workspaceId: fixed.workspaceId, ownerId: fixed.ownerId,
          actorId: fixed.ownerId, operationId: WORST_OPAQUE, rowKey: WORST_OPAQUE, grantRef: WORST_OPAQUE,
          expiresAt: WORST_EXPIRES_AT, targetRef: WORST_OPAQUE, targetRevision: 'evidence-1',
          planRevision: compiled.planDigest, credentialRef: WORST_OPAQUE,
          credentialGeneration: WORST_GENERATION, config: compiled.source.config, row: sourceRows[index],
          sourceRecordDigest: WORST_DIGEST, creationIdentityDigest: WORST_DIGEST }
        const data = { ...planned.protocolPreview.data, formDataJson: stableCanonicalStringify(planned.payload) }
        return sendBudgetModule.assessYidaSendBudget({ snapshot, data }).withinBudget === true
      })
      return Object.freeze({ withinBudget: within })
    } catch (error) { closed(error) }
  }
  // Admission of a bound row (design baseline v2.3 §7.2): the project-sheet registry must still name the
  // bound sheet for the row's project, active, inside the SAME admission transaction; the two digests then
  // enter the ledger row, where the identity fence (D16) is the final guarantee. The three binding keys come
  // together or not at all; absent, the admission is the original unbound shape.
  async function prepareInTransaction(trx, input) {
    try {
      const bound = BINDING.some(key => hasKey(input, key))
      const requested = record(input, bound ? [...PREPARE, ...BINDING] : PREPARE)
      if (!CONTEXT.every(key => requested[key] === fixed[key]) || requested.intent !== 'create') fail('CONFLICT')
      const db = crud(trx)
      const prepareInput = {}
      for (const key of PREPARE) Object.defineProperty(prepareInput, key, { value: requested[key], enumerable: true })
      if (bound) {
        const unbound = requested.sourceRecordDigest === null && requested.creationIdentityDigest === null && requested.sourceBinding === null
        if (!unbound) {
          digest(requested.sourceRecordDigest); digest(requested.creationIdentityDigest)
          const binding = record(requested.sourceBinding, ROW_BINDING)
          opaque(binding.sheetId); opaque(binding.projectNo)
          const registered = await db.selectOne(PROJECT_REGISTRY, { tenant_id: fixed.tenantId, project_no: binding.projectNo })
          if (!registered || registered.status !== 'active' || registered.sheet_id !== binding.sheetId) fail('CONFLICT')
          Object.defineProperty(prepareInput, 'sourceRecordDigest', { value: requested.sourceRecordDigest, enumerable: true })
          Object.defineProperty(prepareInput, 'creationIdentityDigest', { value: requested.creationIdentityDigest, enumerable: true })
        }
      }
      const prepared = await delivery.prepareYidaDeliveryInTransaction(db, prepareInput)
      return Object.freeze({ record: Object.freeze(prepared.record), reused: prepared.reused })
    } catch (error) { closed(error) }
  }
  // P1 (external review 2026-11-08): seal-or-match the target's GENERATED LAYOUT inside the host's approval or admission
  // transaction, after its own checks and before its first write. Rule G1 holds per template, so two legal templates of
  // one target ([identity, field] with the field cell P_B and [field, identity] with the field cell P_A) give two
  // identities one code P_A + P_B, and neither ledger fence compares a code. The first selection with a generated entry
  // therefore seals the target's canonical layout signature (yidaGeneratedLayout: targets, part kinds and order,
  // literals, field / hash member targets, hash form, preset id and options) in integration_yida_generated_layout;
  // every later selection of that target with another signature is refused. Under one sealed layout the identity part
  // sits at one fixed offset for every code of the target, so equal codes carry equal identity parts, which the two
  // fences refuse. Race-safe: the host transaction already holds the approved-target row FOR UPDATE (the slot lock), so
  // two concurrent first uses serialize there and the second sees the committed seal; the seal row's primary key is the
  // belt behind it. A selection without a generated entry issues no SQL here. Answers a frozen verdict the host maps to
  // its own code: { admissible: true, sealed } or { admissible: false, code: 'GENERATED_LAYOUT_CONFLICT' }. The host's
  // transaction rolls back a refused verdict, so a seal written here never outlives a refused approval or admission.
  async function sealGeneratedLayoutInTransaction(trx, selection, input) {
    try {
      if (!selections.has(selection)) fail('INPUT')
      const { event } = record(input, ['event'])
      if (!GENERATED_LAYOUT_EVENTS.has(event)) fail('INPUT')
      const layoutDigest = generatedLayoutDigest(selection.config)
      if (layoutDigest === null) return layoutAdmissible(false)
      const db = crud(trx)
      const existing = await db.selectOneForUpdate(GENERATED_LAYOUT, { target_ref: selection.targetRef })
      if (existing) {
        if (existing.target_ref !== selection.targetRef || existing.tenant_id !== fixed.tenantId || existing.workspace_id !== null
          || existing.owner_id !== fixed.ownerId || typeof existing.layout_digest !== 'string' || !DIGEST_RE.test(existing.layout_digest)) fail('UNAVAILABLE')
        return existing.layout_digest === layoutDigest ? layoutAdmissible(false) : LAYOUT_CONFLICT
      }
      const row = { target_ref: selection.targetRef, tenant_id: fixed.tenantId, workspace_id: null, owner_id: fixed.ownerId,
        layout_digest: layoutDigest, operation_id: selection.operationId, event, actor_id: fixed.ownerId }
      let inserted
      try { inserted = rows(await db.insertOne(GENERATED_LAYOUT, row))[0] ?? null }
      catch (error) {
        if (layoutRace(error)) return LAYOUT_CONFLICT
        throw error
      }
      if (!inserted || Object.entries(row).some(([key, value]) => inserted[key] !== value)) fail('UNAVAILABLE')
      return layoutAdmissible(true)
    } catch (error) { closed(error) }
  }
  async function loadExecutionMaterialInTransaction(trx, input) {
    try {
      const { parsed: requested, targetRef } = targeted(input, ['credentialRef', 'credentialGeneration'])
      opaque(requested.credentialRef)
      if (!Number.isInteger(requested.credentialGeneration) || requested.credentialGeneration < 1
        || requested.credentialGeneration > 2147483647) fail('INPUT')
      const db = crud(trx)
      // Preserve slot -> 090 -> original 091 lock order. These are reentrant
      // reads inside the host's existing authority transaction, never new ones.
      const approved = await readTarget(db, targetRef)
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
      const { targetRef } = targeted(input, ['operationId', 'rowKey'])
      const selection = await resolveSelectionInTransaction(trx, input)
      const approved = await readTarget(crud(trx), targetRef)
      const compiled = compileYidaSendDraft(selection.source)
      if (approved.target.target_ref !== selection.targetRef
        || approved.target.credential_ref !== selection.credentialRef
        || approved.target.credential_generation !== selection.credentialGeneration
        || approved.target.locator_digest !== compiled.locatorDigest
        || approved.target.key_definition_digest !== compiled.keyDefinitionDigest
        || !same(approved.envelope.locator, compiled.locator)
        || !same(approved.envelope.keyDefinition, compiled.keyDefinition)) fail('CONFLICT')
      // Full material validation also compares userId with the authenticated
      // attestation through the existing loader. Discard its private result.
      // Legacy statement kept verbatim (its mutation probe); Y2 names the same locked target.
      if (targetRef === undefined) {
      await loadExecutionMaterialInTransaction(trx, { credentialRef: selection.credentialRef,
        credentialGeneration: selection.credentialGeneration })
      } else {
        await loadExecutionMaterialInTransaction(trx, { credentialRef: selection.credentialRef,
          credentialGeneration: selection.credentialGeneration, targetRef })
      }
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
    executionPayloadDigest, sendBudget, draftSendBudget, sealGeneratedLayoutInTransaction, prepareInTransaction,
    loadExecutionMaterialInTransaction })
}

export function createYidaSendAuthorityPrimitives(options) {
  try { return createPrimitives(options) } catch (error) { closed(error) }
}
