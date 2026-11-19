import {
  AdminGrantApplicationMaterialError,
  adminGrantApplicationMaterialFingerprint as fingerprintApplicationMaterial,
} from './admin-grant-application-material'
import {
  AdminGrantIntentError,
  type AdminGrantIntent,
  type AdminGrantTargetPin,
  normalizeAdminGrantIntent,
} from './admin-login-grant-intent'
import {
  PrivilegeInputsUnavailableError,
  assessSecurityActionPrivilege,
} from './security-action-privilege'
import {
  AuthorizationInputContractError,
  AuthorizationInputTokenRejectedError,
  assertAuthorizationInputTx,
} from '../rbac/authorization-input-brand'
import type { AuthorizationInputTx } from '../rbac/authorization-input-lock'
import {
  type PrivilegeRolePlan,
  revalidatePrivilegeRolePlan,
} from '../rbac/authorization-privilege-witness-plan'

const SLOT_FIELDS = ['corpId', 'externalKey', 'localUserId', 'provider', 'providerOpenId', 'providerUnionId'] as const

const INTEGRATION_LOCK = `SELECT id::text AS id, org_id, provider, corp_id, config
  FROM directory_integrations
 WHERE id = $1::uuid
   FOR SHARE`
const APPLICATION_PIN_LOCK = `SELECT application_revision, material_fingerprint
  FROM directory_connection_application_pins
 WHERE connection_id = $1::uuid
   FOR SHARE`
const CAPABILITY_LOCK = `SELECT revision::text AS revision,
       login_enabled,
       login_bound_tenant,
       login_bound_app_scope,
       bound_provider,
       bound_org_id
  FROM directory_integration_capabilities
 WHERE integration_id = $1::uuid
   FOR SHARE`
const IDENTITY_LOCK = `SELECT id::text AS id, provider, local_user_id, external_key, corp_id,
       provider_open_id, provider_union_id
  FROM user_external_identities
 WHERE id = $1::uuid
   FOR SHARE`
const BINDING_PIN_LOCK = `SELECT binding_revision::text AS binding_revision, provider, local_user_id, external_key,
       corp_id, provider_open_id, provider_union_id
  FROM user_external_identity_binding_pins
 WHERE identity_id = $1::uuid
   FOR SHARE`
const EVIDENCE_LOCK = `SELECT id, evidence_witness, identity_id, live_identity_id::text AS live_identity_id,
       binding_revision::text AS binding_revision, producer_id, assurance, subject_key, app_scope, org_id,
       connection_id::text AS connection_id, capability_revision_seen::text AS capability_revision_seen,
       application_revision, material_fingerprint, (revoked_at IS NULL) AS unrevoked,
       (fresh_until > clock_timestamp()) AS fresh, slot_snapshot
  FROM user_external_identity_evidence
 WHERE id = $1
   FOR SHARE`
const ACCOUNT_READ = `SELECT activation_status, is_active,
       (deleted_at IS NOT NULL) AS deleted,
       (purged_at IS NOT NULL) AS purged,
       access_generation::text AS access_generation
  FROM users
 WHERE id = $1`
const MEMBERSHIP_READ = `SELECT 1 AS present
  FROM user_orgs
 WHERE user_id = $1 AND org_id = $2 AND is_active = true`

export type AdminGrantReceivingPhase = 'issue' | 'consume'

export type AdminGrantReceivingRefusalCode =
  | 'unrepresentable_string'
  | 'intent_invalid'
  | 'phase_invalid'
  | 'token_rejected'
  | 'identity_read_not_held'
  | 'role_plan_invalid'
  | 'role_plan_stale'
  | 'read_failed'
  | 'integration_missing'
  | 'application_pin_missing'
  | 'binding_pin_missing'
  | 'evidence_missing'
  | 'identity_missing'
  | 'application_revision_mismatch'
  | 'material_mismatch'
  | 'capability_absent'
  | 'capability_disabled'
  | 'capability_moved'
  | 'capability_anchor_mismatch'
  | 'provider_mismatch'
  | 'org_mismatch'
  | 'connection_mismatch'
  | 'corp_mismatch'
  | 'owner_mismatch'
  | 'snapshot_mismatch'
  | 'identity_mismatch'
  | 'live_reference_mismatch'
  | 'evidence_witness_mismatch'
  | 'binding_revision_mismatch'
  | 'assurance_ineligible'
  | 'evidence_revoked'
  | 'evidence_stale'
  | 'access_generation_mismatch'
  | 'account_inactive'
  | 'account_pending'
  | 'account_deleted'
  | 'account_purged'
  | 'membership_missing'
  | 'privilege_high'
  | 'privilege_unknown'
  | 'privilege_witness_mismatch'
  | 'actor_privilege_expectation_invalid'
  | 'actor_privilege_subject_mismatch'
  | 'actor_privilege_witness_mismatch'
  | 'brand_mismatch'

export class AdminGrantReceivingRefusal extends Error {
  readonly reason: string

  constructor(readonly code: AdminGrantReceivingRefusalCode, reason?: string) {
    super('Admin grant receiving refused')
    this.name = 'AdminGrantReceivingRefusal'
    this.reason = reason ?? code
  }
}

export type AdminGrantActorPrivilegeExpectation = Readonly<{
  userId: string
  orgId: string
  privilegeWitness: string
}>

export type AdminGrantReceivingContext = Readonly<{
  client: object
  privilegePlan: PrivilegeRolePlan
  actorPrivilege: AdminGrantActorPrivilegeExpectation
}>

export type AdminGrantPreparedTarget = Readonly<{
  userId: string
  identityId: string
  evidenceId: string
  bindingRevision: string
  accessGeneration: string
  privilegeClass: 'standard'
  authorizes: false
}>

export type AdminGrantPreparedSnapshot = Readonly<{
  authorizes: false
  productionAvailable: false
  prepared: true
  phase: AdminGrantReceivingPhase
  commandId: string
  connectionId: string
  applicationRevision: string
  actor: Readonly<{
    userId: string
    orgId: string
    privilegeClass: 'standard' | 'high'
    privilegeWitness: string
    authorizes: false
  }>
  targets: readonly AdminGrantPreparedTarget[]
}>

type PreparedBrand = Readonly<{
  token: AuthorizationInputTx
  connectionId: string
  phase: AdminGrantReceivingPhase
  intent: AdminGrantIntent
  privilegePlan: PrivilegeRolePlan
  actorPrivilege: AdminGrantActorPrivilegeExpectation
}>

type IdentityView = Readonly<{
  provider: string
  localUserId: string
  externalKey: string
  corpId: string
  providerOpenId: string | null
  providerUnionId: string | null
}>

const preparedBrands = new WeakMap<object, PreparedBrand>()

function refuse(code: AdminGrantReceivingRefusalCode, reason?: string): never {
  throw new AdminGrantReceivingRefusal(code, reason)
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

function refuseUnrepresentableString(value: string): void {
  if (value.includes('\u0000') || hasUnpairedSurrogate(value)) refuse('unrepresentable_string')
}

function assertRepresentable(value: unknown, seen = new WeakSet<object>()): void {
  if (typeof value === 'string') {
    refuseUnrepresentableString(value)
    return
  }
  if (typeof value !== 'object' || value === null) return
  if (seen.has(value)) refuse('unrepresentable_string')
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) assertRepresentable(item, seen)
    return
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string') refuseUnrepresentableString(key)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor && 'value' in descriptor) assertRepresentable(descriptor.value, seen)
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function normalizeIntent(value: unknown): AdminGrantIntent {
  try {
    return normalizeAdminGrantIntent(value)
  } catch (error) {
    if (error instanceof AdminGrantIntentError) refuse('intent_invalid')
    refuse('intent_invalid')
  }
}

function assertPhase(phase: unknown): asserts phase is AdminGrantReceivingPhase {
  if (typeof phase === 'string') refuseUnrepresentableString(phase)
  if (phase !== 'issue' && phase !== 'consume') refuse('phase_invalid')
}

function isActorField(key: string): key is 'userId' | 'orgId' | 'privilegeWitness' {
  return key === 'userId' || key === 'orgId' || key === 'privilegeWitness'
}

function isExactLowerHexWitness(value: string): boolean {
  if (value.length !== 64) return false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    const digit = code >= 48 && code <= 57
    const lower = code >= 97 && code <= 102
    if (!digit && !lower) return false
  }
  return true
}

function copyActorExpectation(value: unknown): AdminGrantActorPrivilegeExpectation {
  if (typeof value !== 'object' || value === null) refuse('actor_privilege_expectation_invalid')
  let array = false
  let prototype: object | null = null
  try {
    array = Array.isArray(value)
    prototype = Object.getPrototypeOf(value)
  } catch {
    refuse('actor_privilege_expectation_invalid')
  }
  if (array || (prototype !== Object.prototype && prototype !== null)) refuse('actor_privilege_expectation_invalid')
  let keys: readonly (string | symbol)[]
  try {
    keys = Reflect.ownKeys(value)
  } catch {
    refuse('actor_privilege_expectation_invalid')
  }
  if (keys.length !== 3) refuse('actor_privilege_expectation_invalid')
  const fields: { userId: string; orgId: string; privilegeWitness: string } = {
    userId: '',
    orgId: '',
    privilegeWitness: '',
  }
  for (const key of keys) {
    if (typeof key !== 'string' || !isActorField(key)) refuse('actor_privilege_expectation_invalid')
    let descriptor: PropertyDescriptor | undefined
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key)
    } catch {
      refuse('actor_privilege_expectation_invalid')
    }
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) refuse('actor_privilege_expectation_invalid')
    const fieldValue = descriptor.value
    if (typeof fieldValue !== 'string') refuse('actor_privilege_expectation_invalid')
    fields[key] = fieldValue
  }
  refuseUnrepresentableString(fields.userId)
  refuseUnrepresentableString(fields.orgId)
  refuseUnrepresentableString(fields.privilegeWitness)
  if (!isExactLowerHexWitness(fields.privilegeWitness)) refuse('actor_privilege_expectation_invalid')
  return Object.freeze({
    userId: fields.userId,
    orgId: fields.orgId,
    privilegeWitness: fields.privilegeWitness,
  })
}

function readActorExpectation(context: object): AdminGrantActorPrivilegeExpectation {
  let descriptor: PropertyDescriptor | undefined
  try {
    descriptor = Object.getOwnPropertyDescriptor(context, 'actorPrivilege')
  } catch {
    refuse('actor_privilege_expectation_invalid')
  }
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) refuse('actor_privilege_expectation_invalid')
  return copyActorExpectation(descriptor.value)
}

function tokenRefusal(error: unknown): AdminGrantReceivingRefusal {
  if (error instanceof AuthorizationInputTokenRejectedError) return new AdminGrantReceivingRefusal('token_rejected', error.reason)
  return new AdminGrantReceivingRefusal('token_rejected')
}

function assertOpenToken(tx: AuthorizationInputTx, client: object): void {
  try {
    assertAuthorizationInputTx(tx, { client })
  } catch (error) {
    throw tokenRefusal(error)
  }
}

function sameTarget(left: AdminGrantTargetPin, right: AdminGrantTargetPin): boolean {
  return left.userId === right.userId
    && left.identityId === right.identityId
    && left.bindingRevision === right.bindingRevision
    && left.evidenceId === right.evidenceId
    && left.evidenceWitness === right.evidenceWitness
    && left.accessGeneration === right.accessGeneration
    && left.privilegeWitness === right.privilegeWitness
}

function sameIntent(left: AdminGrantIntent, right: AdminGrantIntent): boolean {
  return left.purpose === right.purpose
    && left.commandId === right.commandId
    && left.actorId === right.actorId
    && left.orgId === right.orgId
    && left.provider === right.provider
    && left.connectionId === right.connectionId
    && left.applicationRevision === right.applicationRevision
    && left.targets.length === right.targets.length
    && left.targets.every((target, index) => sameTarget(target, right.targets[index]))
}

export function adminGrantApplicationMaterialFingerprint(config: unknown): string {
  try {
    return fingerprintApplicationMaterial(config)
  } catch (error) {
    if (error instanceof AdminGrantApplicationMaterialError) refuse('material_mismatch')
    throw error
  }
}

async function oneRow(
  tx: AuthorizationInputTx,
  statement: string,
  params: readonly unknown[],
  missing: AdminGrantReceivingRefusalCode,
): Promise<Record<string, unknown>> {
  let result: { rows: Array<Record<string, unknown>> }
  try {
    result = await tx.query(statement, [...params])
  } catch {
    refuse('read_failed')
  }
  if (!Array.isArray(result.rows) || result.rows.length > 1) refuse('read_failed')
  if (result.rows.length === 0) refuse(missing)
  const row = result.rows[0]
  if (typeof row !== 'object' || row === null || Array.isArray(row)) refuse('read_failed')
  return row
}

function textField(row: Record<string, unknown>, field: string, code: AdminGrantReceivingRefusalCode): string {
  const value = row[field]
  if (typeof value !== 'string') refuse(code)
  return value
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') refuse('read_failed')
  return value
}

function sameNullable(left: string | null, right: unknown): boolean {
  if (left === null) return right === null || right === undefined
  return left === right
}

function requireStandardTarget(assessment: Awaited<ReturnType<typeof assessSecurityActionPrivilege>>, target: AdminGrantTargetPin): void {
  if (assessment.privilegeClass === 'high') refuse('privilege_high')
  if (assessment.privilegeClass !== 'standard' || assessment.reasons.length !== 0) refuse('privilege_unknown')
  if (assessment.witness !== target.privilegeWitness) refuse('privilege_witness_mismatch')
}

function accountGate(row: Record<string, unknown> | undefined, accessGeneration: string): void {
  if (!row) refuse('account_inactive')
  if (row.purged === true) refuse('account_purged')
  if (row.deleted === true) refuse('account_deleted')
  if (row.activation_status === 'pending_activation') refuse('account_pending')
  if (row.activation_status !== 'activated' || row.is_active !== true) refuse('account_inactive')
  if (row.access_generation !== accessGeneration) refuse('access_generation_mismatch')
}

function slotMatches(snapshot: unknown, identity: IdentityView): boolean {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) return false
  const record = snapshot as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== SLOT_FIELDS.length || SLOT_FIELDS.some((field) => !Object.prototype.hasOwnProperty.call(record, field))) return false
  return record.provider === identity.provider
    && record.localUserId === identity.localUserId
    && record.externalKey === identity.externalKey
    && record.corpId === identity.corpId
    && sameNullable(identity.providerOpenId, record.providerOpenId)
    && sameNullable(identity.providerUnionId, record.providerUnionId)
}

async function lockTargetRows(
  tx: AuthorizationInputTx,
  targets: readonly AdminGrantTargetPin[],
): Promise<ReadonlyArray<Readonly<{ identity: Record<string, unknown>; pin: Record<string, unknown>; evidence: Record<string, unknown> }>>> {
  const identities: Record<string, unknown>[] = []
  for (const target of targets) identities.push(await oneRow(tx, IDENTITY_LOCK, [target.identityId], 'identity_missing'))
  const pins: Record<string, unknown>[] = []
  for (const target of targets) pins.push(await oneRow(tx, BINDING_PIN_LOCK, [target.identityId], 'binding_pin_missing'))
  const evidenceRows: Record<string, unknown>[] = []
  for (const target of targets) evidenceRows.push(await oneRow(tx, EVIDENCE_LOCK, [target.evidenceId], 'evidence_missing'))
  return targets.map((target, index) => Object.freeze({
    identity: identities[index],
    pin: pins[index],
    evidence: evidenceRows[index],
  }))
}

async function readPreparedTarget(
  tx: AuthorizationInputTx,
  intent: AdminGrantIntent,
  target: AdminGrantTargetPin,
  locked: Readonly<{ identity: Record<string, unknown>; pin: Record<string, unknown>; evidence: Record<string, unknown> }>,
  integrationCorpId: string,
  fingerprint: string,
  capabilityRevision: string,
  loginBoundAppScope: string,
): Promise<AdminGrantPreparedTarget> {
  const identity: IdentityView = {
    provider: textField(locked.identity, 'provider', 'read_failed'),
    localUserId: textField(locked.identity, 'local_user_id', 'read_failed'),
    externalKey: textField(locked.identity, 'external_key', 'read_failed'),
    corpId: textField(locked.identity, 'corp_id', 'corp_mismatch'),
    providerOpenId: nullableText(locked.identity.provider_open_id),
    providerUnionId: nullableText(locked.identity.provider_union_id),
  }
  if (identity.localUserId !== target.userId) refuse('owner_mismatch')
  if (identity.provider !== intent.provider) refuse('provider_mismatch')
  if (identity.corpId !== integrationCorpId) refuse('corp_mismatch')

  const pin = locked.pin
  if (textField(pin, 'local_user_id', 'read_failed') !== target.userId) refuse('owner_mismatch')
  if (textField(pin, 'provider', 'read_failed') !== identity.provider) refuse('provider_mismatch')
  if (textField(pin, 'external_key', 'read_failed') !== identity.externalKey) refuse('snapshot_mismatch')
  if (nullableText(pin.corp_id) !== identity.corpId) refuse('corp_mismatch')
  if (!sameNullable(identity.providerOpenId, pin.provider_open_id) || !sameNullable(identity.providerUnionId, pin.provider_union_id)) {
    refuse('snapshot_mismatch')
  }
  if (textField(pin, 'binding_revision', 'read_failed') !== target.bindingRevision) refuse('binding_revision_mismatch')

  const evidence = locked.evidence
  if (textField(evidence, 'evidence_witness', 'read_failed') !== target.evidenceWitness) refuse('evidence_witness_mismatch')
  if (textField(evidence, 'identity_id', 'read_failed') !== target.identityId) refuse('identity_mismatch')
  if (evidence.assurance !== 'self_authenticated') refuse('assurance_ineligible')
  if (evidence.unrevoked !== true) refuse('evidence_revoked')
  if (nullableText(evidence.live_identity_id) !== target.identityId) refuse('live_reference_mismatch')
  if (evidence.fresh !== true) refuse('evidence_stale')
  if (textField(evidence, 'binding_revision', 'read_failed') !== target.bindingRevision) refuse('binding_revision_mismatch')
  if (textField(evidence, 'application_revision', 'read_failed') !== intent.applicationRevision) refuse('application_revision_mismatch')
  if (textField(evidence, 'org_id', 'read_failed') !== intent.orgId) refuse('org_mismatch')
  if (textField(evidence, 'connection_id', 'read_failed') !== intent.connectionId) refuse('connection_mismatch')
  if (textField(evidence, 'material_fingerprint', 'read_failed') !== fingerprint) refuse('material_mismatch')
  if (textField(evidence, 'capability_revision_seen', 'read_failed') !== capabilityRevision) refuse('capability_moved')
  if (textField(evidence, 'app_scope', 'read_failed') !== loginBoundAppScope) refuse('capability_anchor_mismatch')
  if (typeof evidence.producer_id !== 'string' || typeof evidence.subject_key !== 'string') refuse('read_failed')
  if (!slotMatches(evidence.slot_snapshot, identity)) refuse('snapshot_mismatch')

  const account = await oneRow(tx, ACCOUNT_READ, [target.userId], 'account_inactive')
  accountGate(account, target.accessGeneration)
  const membership = await tx.query(MEMBERSHIP_READ, [target.userId, intent.orgId]).catch(() => refuse('read_failed'))
  if (!Array.isArray(membership.rows) || membership.rows.length !== 1) refuse('membership_missing')

  let assessment: Awaited<ReturnType<typeof assessSecurityActionPrivilege>>
  try {
    assessment = await assessSecurityActionPrivilege({
      query: async (statement: string, params?: unknown[]) => {
        const result = await tx.query(statement, params)
        return { rows: result.rows, rowCount: result.rowCount ?? null }
      },
    }, target.userId)
  } catch (error) {
    if (error instanceof PrivilegeInputsUnavailableError) refuse('read_failed')
    refuse('read_failed')
  }
  requireStandardTarget(assessment, target)
  return Object.freeze({
    userId: target.userId,
    identityId: target.identityId,
    evidenceId: target.evidenceId,
    bindingRevision: target.bindingRevision,
    accessGeneration: target.accessGeneration,
    privilegeClass: 'standard',
    authorizes: false,
  })
}

export async function resolveAdminGrantTargetSet(
  tx: AuthorizationInputTx,
  context: AdminGrantReceivingContext,
  intent: unknown,
  phase: AdminGrantReceivingPhase,
): Promise<AdminGrantPreparedSnapshot> {
  const normalized = normalizeIntent(intent)
  assertRepresentable(normalized)
  assertPhase(phase)
  const actorPrivilege = readActorExpectation(context)
  if (actorPrivilege.userId !== normalized.actorId || actorPrivilege.orgId !== normalized.orgId) {
    refuse('actor_privilege_subject_mismatch')
  }
  const client = context.client
  const privilegePlan = context.privilegePlan
  assertOpenToken(tx, client)
  try {
    tx.requireIdentityRead([normalized.connectionId])
  } catch {
    refuse('identity_read_not_held')
  }
  try {
    await revalidatePrivilegeRolePlan(tx, privilegePlan)
  } catch (error) {
    if (error instanceof PrivilegeInputsUnavailableError) refuse('read_failed')
    if (error instanceof AuthorizationInputContractError && error.code === 'AUTHORIZATION_INPUT_PLAN_STALE') refuse('role_plan_stale')
    refuse('role_plan_invalid')
  }
  const expectedSubjects = [normalized.actorId, ...normalized.targets.map((target) => target.userId)].sort(compareCodeUnits)
  if (privilegePlan.subjectIds.length !== expectedSubjects.length
    || privilegePlan.subjectIds.some((subjectId, index) => subjectId !== expectedSubjects[index])) {
    refuse('role_plan_invalid', 'subject_set_mismatch')
  }
  let actorAssessment: Awaited<ReturnType<typeof assessSecurityActionPrivilege>>
  try {
    actorAssessment = await assessSecurityActionPrivilege({
      query: async (statement: string, params?: unknown[]) => {
        const result = await tx.query(statement, params)
        return { rows: result.rows, rowCount: result.rowCount ?? null }
      },
    }, normalized.actorId)
  } catch (error) {
    if (error instanceof PrivilegeInputsUnavailableError) refuse('read_failed')
    refuse('read_failed')
  }
  if (typeof actorAssessment !== 'object' || actorAssessment === null
    || (actorAssessment.privilegeClass !== 'standard' && actorAssessment.privilegeClass !== 'high')
    || typeof actorAssessment.witness !== 'string') {
    refuse('read_failed')
  }
  if (actorAssessment.witness !== actorPrivilege.privilegeWitness) refuse('actor_privilege_witness_mismatch')

  const integration = await oneRow(tx, INTEGRATION_LOCK, [normalized.connectionId], 'integration_missing')
  if (textField(integration, 'provider', 'read_failed') !== normalized.provider) refuse('provider_mismatch')
  if (textField(integration, 'org_id', 'read_failed') !== normalized.orgId) refuse('org_mismatch')
  const integrationCorpId = textField(integration, 'corp_id', 'corp_mismatch')
  const fingerprint = adminGrantApplicationMaterialFingerprint(integration.config)

  const applicationPin = await oneRow(tx, APPLICATION_PIN_LOCK, [normalized.connectionId], 'application_pin_missing')
  if (textField(applicationPin, 'application_revision', 'read_failed') !== normalized.applicationRevision) refuse('application_revision_mismatch')
  if (textField(applicationPin, 'material_fingerprint', 'read_failed') !== fingerprint) refuse('material_mismatch')

  const capability = await oneRow(tx, CAPABILITY_LOCK, [normalized.connectionId], 'capability_absent')
  if (capability.login_enabled !== true) refuse('capability_disabled')
  if (textField(capability, 'bound_provider', 'read_failed') !== normalized.provider) refuse('provider_mismatch')
  if (textField(capability, 'bound_org_id', 'read_failed') !== normalized.orgId) refuse('org_mismatch')
  if (textField(capability, 'login_bound_tenant', 'read_failed') !== integrationCorpId) refuse('capability_anchor_mismatch')
  const capabilityRevision = textField(capability, 'revision', 'read_failed')
  const loginBoundAppScope = textField(capability, 'login_bound_app_scope', 'read_failed')

  const lockedTargets = await lockTargetRows(tx, normalized.targets)
  const preparedTargets: AdminGrantPreparedTarget[] = []
  for (let index = 0; index < normalized.targets.length; index += 1) {
    preparedTargets.push(await readPreparedTarget(
      tx,
      normalized,
      normalized.targets[index],
      lockedTargets[index],
      integrationCorpId,
      fingerprint,
      capabilityRevision,
      loginBoundAppScope,
    ))
  }
  const snapshot = Object.freeze({
    authorizes: false as const,
    productionAvailable: false as const,
    prepared: true as const,
    phase,
    commandId: normalized.commandId,
    connectionId: normalized.connectionId,
    applicationRevision: normalized.applicationRevision,
    actor: Object.freeze({
      userId: actorPrivilege.userId,
      orgId: actorPrivilege.orgId,
      privilegeClass: actorAssessment.privilegeClass,
      privilegeWitness: actorAssessment.witness,
      authorizes: false as const,
    }),
    targets: Object.freeze(preparedTargets),
  })
  preparedBrands.set(snapshot, Object.freeze({
    token: tx,
    connectionId: normalized.connectionId,
    phase,
    intent: normalized,
    privilegePlan,
    actorPrivilege,
  }))
  return snapshot
}

export function assertPreparedAdminGrantConsume(
  snapshot: unknown,
  tx: AuthorizationInputTx,
  context: AdminGrantReceivingContext,
  intent: unknown,
): void {
  const normalized = normalizeIntent(intent)
  assertRepresentable(normalized)
  const actorPrivilege = readActorExpectation(context)
  const client = context.client
  const privilegePlan = context.privilegePlan
  assertOpenToken(tx, client)
  if (typeof snapshot !== 'object' || snapshot === null) refuse('brand_mismatch', 'unbranded')
  const brand = preparedBrands.get(snapshot)
  if (!brand) refuse('brand_mismatch', 'unbranded')
  if (brand.phase !== 'consume') refuse('brand_mismatch', 'issue_phase')
  if (brand.token !== tx) refuse('brand_mismatch', 'other_token')
  if (brand.connectionId !== normalized.connectionId || !sameIntent(brand.intent, normalized)) refuse('brand_mismatch', 'intent_mismatch')
  if (privilegePlan !== brand.privilegePlan) refuse('brand_mismatch', 'role_plan_mismatch')
  let registeredLock: unknown
  try {
    registeredLock = brand.privilegePlan.lockPlan
  } catch {
    refuse('brand_mismatch', 'role_plan_mismatch')
  }
  let heldPlan: unknown
  try {
    heldPlan = tx.plan
  } catch {
    refuse('brand_mismatch', 'role_plan_mismatch')
  }
  if (heldPlan !== registeredLock) refuse('brand_mismatch', 'role_plan_mismatch')
  if (actorPrivilege.userId !== brand.actorPrivilege.userId
    || actorPrivilege.orgId !== brand.actorPrivilege.orgId
    || actorPrivilege.privilegeWitness !== brand.actorPrivilege.privilegeWitness) {
    refuse('brand_mismatch', 'actor_expectation_mismatch')
  }
}
