import { createHash, randomBytes } from 'node:crypto'
import { adminGrantApplicationMaterialFingerprint } from './admin-grant-application-material'
import {
  assertAuthenticatedSessionContext,
  type AuthenticatedSessionContext,
} from './security-action-proof'
import {
  PrivilegeInputsUnavailableError,
  assessSecurityActionPrivilege,
} from './security-action-privilege'
import {
  exchangeCodeForUserAccessToken,
  fetchDingTalkCurrentUser,
  type DingTalkCurrentUserProfile,
} from '../integrations/dingtalk/client'
import {
  DingTalkCorpNotAllowedError,
  assertDingTalkCorpAllowed,
} from '../integrations/dingtalk/runtime-policy'
import { scopeFromValues } from '../integrations/provider-capability-registry'
import type { AuthorizationInputQueryable } from '../rbac/authorization-input-brand'
import {
  withAuthorizationInputTransaction,
  type AuthorizationInputTransactionRunner,
  type AuthorizationInputTx,
} from '../rbac/authorization-input-lock'
import {
  discoverPrivilegeRolePlan,
  revalidatePrivilegeRolePlan,
  type PrivilegeRolePlan,
} from '../rbac/authorization-privilege-witness-plan'
import { decryptStoredSecretValue } from '../security/encrypted-secrets'

export const CURRENT_APP_EVIDENCE_FRESHNESS_SECONDS = 300
export const CURRENT_APP_TARGET_PRODUCER_ID = 'current_app_target_ceremony'

const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/
const HEX_64 = /^[0-9a-f]{64}$/
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const START_KEYS = ['connectionId']
const COMPLETE_KEYS = ['browserToken', 'code', 'state']

const INTEGRATION_LOCK = `SELECT id::text AS id, org_id, provider, status, corp_id, config
  FROM directory_integrations
 WHERE id = $1::uuid
   FOR UPDATE`
const APPLICATION_LOCK = `SELECT application_revision, material_fingerprint
  FROM directory_connection_application_pins
 WHERE connection_id = $1::uuid
   FOR UPDATE`
const CAPABILITY_LOCK = `SELECT revision::text AS revision, login_enabled, login_bound_tenant,
       login_bound_app_scope, bound_provider, bound_org_id
  FROM directory_integration_capabilities
 WHERE integration_id = $1::uuid
   FOR SHARE`
const IDENTITY_LOCK = `SELECT id::text AS id, provider, local_user_id, external_key, corp_id,
       provider_open_id, provider_union_id
  FROM user_external_identities
 WHERE local_user_id = $1 AND provider = 'dingtalk'
   FOR UPDATE`
const BINDING_LOCK = `SELECT binding_revision::text AS binding_revision, provider, local_user_id, external_key,
       corp_id, provider_open_id, provider_union_id
  FROM user_external_identity_binding_pins
 WHERE identity_id = $1::uuid
   FOR UPDATE`
const EVIDENCE_LOCK = `SELECT id, (fresh_until <= clock_timestamp()) AS expired
  FROM user_external_identity_evidence
 WHERE live_identity_id = $1::uuid
   FOR UPDATE`
const ACCOUNT_READ = `SELECT activation_status, is_active, local_password_set, must_change_password,
       deleted_at, purged_at, access_generation::text AS access_generation
  FROM users
 WHERE id = $1`
const MEMBERSHIP_READ = `SELECT 1 AS present
  FROM user_orgs
 WHERE user_id = $1 AND org_id = $2 AND is_active = true`
const WATERMARK_ENSURE = `INSERT INTO user_session_revocations (user_id, revoked_after, updated_at)
VALUES ($1, timestamptz '1970-01-01 00:00:00+00', clock_timestamp())
ON CONFLICT (user_id) DO NOTHING`
const WATERMARK_LOCK = `SELECT floor(extract(epoch FROM revoked_after) * 1000000)::text AS revoked_after_us
  FROM user_session_revocations
 WHERE user_id = $1
   FOR SHARE`
const SESSION_LOCK = `SELECT user_id, (revoked_at IS NULL AND expires_at > clock_timestamp()) AS live
  FROM user_sessions
 WHERE id = $1 AND user_id = $2
   FOR SHARE`
const SUCCESSOR_SCHEMA = `SELECT namespace.nspname AS schema_name
  FROM pg_catalog.pg_proc proc
  JOIN pg_catalog.pg_namespace namespace ON namespace.oid = proc.pronamespace
 WHERE proc.proname = 'admin_grant_application_successor'
   AND namespace.nspname = current_schema()
   AND pg_catalog.pg_get_function_identity_arguments(proc.oid) = 'revision text'`
const CHALLENGE_PREVIEW = `SELECT connection_id::text AS connection_id
  FROM admin_grant_target_ceremony_challenges
 WHERE state_hash = $1`
const CHALLENGE_LOCK = `SELECT browser_hash, target_user_id, session_id, org_id, connection_id::text AS connection_id,
       identity_id, provider, corp_id, app_scope, subject_key, application_revision, binding_revision,
       material_fingerprint, capability_revision_seen, access_generation, privilege_witness, privilege_class,
       privilege_reasons, slot_snapshot, token_issued_at, watermark_us, exchange_claimed_at,
       consumed_evidence_id, consumed_at, (expires_at > clock_timestamp()) AS live
  FROM admin_grant_target_ceremony_challenges
 WHERE state_hash = $1
   FOR UPDATE`

export type CurrentAppCeremonyCode =
  | 'request_shape'
  | 'unrepresentable_string'
  | 'production_unavailable'
  | 'redirect_unavailable'
  | 'corp_not_allowed'
  | 'transport_config_unusable'
  | 'provider_exchange_refused'
  | 'subject_mismatch'
  | 'material_mismatch'
  | 'evidence_already_live'
  | 'ceremony_exchange_spent'
  | 'integration_inactive'
  | 'session_rejected'
  | 'privilege_refused'
  | 'account_ineligible'
  | 'membership_missing'
  | 'scope_mismatch'
  | 'capability_moved'
  | 'binding_mismatch'
  | 'epoch_mismatch'
  | 'identity_missing'
  | 'read_failed'
  | 'ceremony_expired'

export type CurrentAppCeremonyRefusal = { readonly success: false; readonly code: CurrentAppCeremonyCode }
export type CurrentAppCeremonyStartResult =
  | { readonly success: true; readonly data: { readonly url: string }; readonly browserToken: string }
  | CurrentAppCeremonyRefusal
export type CurrentAppCeremonyCompleteResult = { readonly success: true } | CurrentAppCeremonyRefusal
export type CurrentAppCeremonyDeps = Readonly<{
  fetchFn?: typeof fetch
  transaction?: AuthorizationInputTransactionRunner
}>

type Slot = Readonly<{
  corpId: string
  externalKey: string
  localUserId: string
  provider: 'dingtalk'
  providerOpenId: string
  providerUnionId: string | null
}>

type LockedTarget = Readonly<{
  orgId: string
  corpId: string
  appScope: string
  appKey: string
  appSecret: string
  fingerprint: string
  capabilityRevision: string
  identityId: string
  subjectKey: string
  slot: Slot
  accessGeneration: string
  privilegeWitness: string
  applicationRevision: string | null
  applicationFingerprint: string | null
  bindingRevision: string | null
  bindingSlot: Slot | null
  expiredEvidenceId: string | null
  freshEvidence: boolean
}>

type CompleteRequest = Readonly<{ code: string; state: string; browserToken: string }>
type ClaimedTransport = Readonly<{ clientId: string; ciphertext: string; corpId: string }>

class CurrentAppCeremonyRefusalError extends Error {
  readonly code: CurrentAppCeremonyCode

  constructor(code: CurrentAppCeremonyCode) {
    super('current app ceremony refused')
    this.name = 'CurrentAppCeremonyRefusalError'
    this.code = code
  }
}

function refuse(code: CurrentAppCeremonyCode): never {
  throw new CurrentAppCeremonyRefusalError(code)
}

function refusal(code: CurrentAppCeremonyCode): CurrentAppCeremonyRefusal {
  return { success: false, code }
}

function isRefusal(value: unknown): value is CurrentAppCeremonyRefusal {
  return typeof value === 'object' && value !== null && 'success' in value
    && (value as { success?: unknown }).success === false
    && typeof (value as { code?: unknown }).code === 'string'
}

function closedCode(value: unknown): CurrentAppCeremonyCode {
  switch (value) {
    case 'request_shape':
    case 'unrepresentable_string':
    case 'production_unavailable':
    case 'redirect_unavailable':
    case 'corp_not_allowed':
    case 'transport_config_unusable':
    case 'provider_exchange_refused':
    case 'subject_mismatch':
    case 'material_mismatch':
    case 'evidence_already_live':
    case 'ceremony_exchange_spent':
    case 'integration_inactive':
    case 'session_rejected':
    case 'privilege_refused':
    case 'account_ineligible':
    case 'membership_missing':
    case 'scope_mismatch':
    case 'capability_moved':
    case 'binding_mismatch':
    case 'epoch_mismatch':
    case 'identity_missing':
    case 'read_failed':
    case 'ceremony_expired':
      return value
    default:
      return 'read_failed'
  }
}

function mapFailure(error: unknown): CurrentAppCeremonyRefusal {
  try {
    if (error instanceof CurrentAppCeremonyRefusalError) return refusal(closedCode(error.code))
  } catch {
    return refusal('read_failed')
  }
  return refusal('read_failed')
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

function gate(session: unknown): AuthenticatedSessionContext | CurrentAppCeremonyRefusal {
  try {
    assertAuthenticatedSessionContext(session)
    return session
  } catch {
    return refusal('session_rejected')
  }
}

function assertGate(session: unknown): asserts session is AuthenticatedSessionContext {
  try {
    assertAuthenticatedSessionContext(session)
  } catch (error) {
    if (error instanceof CurrentAppCeremonyRefusalError) throw error
    refuse('session_rejected')
  }
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) refuse('request_shape')
  let prototype: object | null
  try {
    prototype = Object.getPrototypeOf(value)
  } catch {
    refuse('request_shape')
  }
  if (prototype !== Object.prototype && prototype !== null) refuse('request_shape')
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  let keys: (string | symbol)[]
  try {
    keys = Reflect.ownKeys(value)
  } catch {
    refuse('request_shape')
  }
  const names = keys.filter((key): key is string => typeof key === 'string')
  const wanted = [...expected].sort()
  if (names.length !== keys.length || names.length !== wanted.length) refuse('request_shape')
  const sorted = [...names].sort()
  if (sorted.some((key, index) => key !== wanted[index])) refuse('request_shape')
}

function dataString(record: Record<string, unknown>, key: string): string {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) refuse('request_shape')
  if (typeof descriptor.value !== 'string' || descriptor.value.length === 0) refuse('request_shape')
  return descriptor.value
}

function startConnectionId(body: unknown): string {
  const record = plainRecord(body)
  exactKeys(record, START_KEYS)
  const connectionId = dataString(record, 'connectionId')
  if (!UUID_TEXT.test(connectionId)) refuse('request_shape')
  return connectionId
}

function completeRequest(body: unknown): CompleteRequest {
  const record = plainRecord(body)
  exactKeys(record, COMPLETE_KEYS)
  return {
    browserToken: dataString(record, 'browserToken'),
    code: dataString(record, 'code'),
    state: dataString(record, 'state'),
  }
}

function redirectUri(): string {
  const value = process.env.DINGTALK_REDIRECT_URI
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) refuse('redirect_unavailable')
  refuseUnrepresentableString(value)
  return value
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function opaqueToken(): string {
  return randomBytes(32).toString('base64url')
}

function issuedText(session: AuthenticatedSessionContext): string {
  if (!Number.isSafeInteger(session.tokenIssuedAt) || session.tokenIssuedAt <= 0) refuse('session_rejected')
  return String(session.tokenIssuedAt)
}

function issuedAfterWatermark(issued: string, watermarkUs: string): boolean {
  if (!POSITIVE_DECIMAL.test(issued) || !CANONICAL_DECIMAL.test(watermarkUs)) return false
  return BigInt(issued) * 1000000n > BigInt(watermarkUs)
}

function textOf(row: Record<string, unknown>, key: string, code: CurrentAppCeremonyCode = 'read_failed'): string {
  const value = row[key]
  if (typeof value !== 'string') refuse(code)
  return value
}

function nullableText(row: Record<string, unknown>, key: string): string | null {
  const value = row[key]
  if (value === null) return null
  if (typeof value !== 'string') refuse('read_failed')
  return value
}

async function queryRows(
  tx: AuthorizationInputTx,
  statement: string,
  params: readonly unknown[],
  code: CurrentAppCeremonyCode = 'read_failed',
): Promise<Record<string, unknown>[]> {
  try {
    const result = await tx.query(statement, [...params])
    if (!result || !Array.isArray(result.rows)) refuse(code)
    for (const row of result.rows) {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) refuse(code)
    }
    return result.rows as Record<string, unknown>[]
  } catch (error) {
    if (error instanceof CurrentAppCeremonyRefusalError) throw error
    refuse(code)
  }
}

async function rowCountOf(
  tx: AuthorizationInputTx,
  statement: string,
  params: readonly unknown[],
  code: CurrentAppCeremonyCode,
): Promise<number> {
  try {
    const result = await tx.query(statement, [...params])
    if (typeof result.rowCount !== 'number') refuse(code)
    return result.rowCount
  } catch (error) {
    if (error instanceof CurrentAppCeremonyRefusalError) throw error
    refuse(code)
  }
}

function fingerprintOf(config: unknown): string {
  try {
    const fingerprint = adminGrantApplicationMaterialFingerprint(config)
    if (typeof fingerprint !== 'string' || !HEX_64.test(fingerprint)) refuse('material_mismatch')
    return fingerprint
  } catch (error) {
    if (error instanceof CurrentAppCeremonyRefusalError) throw error
    refuse('material_mismatch')
  }
}

function transportFields(config: unknown): { appKey: string; appSecret: string } {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) refuse('material_mismatch')
  const record = config as Record<string, unknown>
  const appKey = record.appKey
  const appSecret = record.appSecret
  if (typeof appKey !== 'string' || appKey.length === 0 || appKey !== appKey.trim()) refuse('scope_mismatch')
  if (typeof appSecret !== 'string' || appSecret.length === 0) refuse('transport_config_unusable')
  refuseUnrepresentableString(appKey)
  refuseUnrepresentableString(appSecret)
  return { appKey, appSecret }
}

function slotJson(slot: Slot): string {
  return JSON.stringify({
    corpId: slot.corpId,
    externalKey: slot.externalKey,
    localUserId: slot.localUserId,
    provider: slot.provider,
    providerOpenId: slot.providerOpenId,
    providerUnionId: slot.providerUnionId,
  })
}

function sameSlot(left: Slot, right: Slot): boolean {
  return left.corpId === right.corpId
    && left.externalKey === right.externalKey
    && left.localUserId === right.localUserId
    && left.provider === right.provider
    && left.providerOpenId === right.providerOpenId
    && left.providerUnionId === right.providerUnionId
}

function slotFromUnknown(value: unknown): Slot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) refuse('read_failed')
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== 6) refuse('read_failed')
  const corpId = record.corpId
  const externalKey = record.externalKey
  const localUserId = record.localUserId
  const provider = record.provider
  const providerOpenId = record.providerOpenId
  const providerUnionId = nullableText(record, 'providerUnionId')
  if (typeof corpId !== 'string' || typeof externalKey !== 'string' || typeof localUserId !== 'string') refuse('read_failed')
  if (provider !== 'dingtalk' || typeof providerOpenId !== 'string') refuse('read_failed')
  return { corpId, externalKey, localUserId, provider, providerOpenId, providerUnionId }
}

function authorizeUrl(clientId: string, redirect: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: 'openid',
    state,
    prompt: 'consent',
  })
  return `https://login.dingtalk.com/oauth2/auth?${params.toString()}`
}

async function runRoot<T>(
  plan: PrivilegeRolePlan,
  session: AuthenticatedSessionContext,
  connectionId: string,
  deps: CurrentAppCeremonyDeps | undefined,
  work: (tx: AuthorizationInputTx) => Promise<T>,
): Promise<T | CurrentAppCeremonyRefusal> {
  try {
    return await withAuthorizationInputTransaction(plan.lockPlan, async (tx) => {
      assertGate(session)
      await revalidatePrivilegeRolePlan(tx, plan)
      tx.requireIdentityRead([connectionId])
      return work(tx)
    }, deps?.transaction ? { transaction: deps.transaction } : undefined)
  } catch (error) {
    if (error instanceof CurrentAppCeremonyRefusalError) return refusal(error.code)
    throw error
  }
}

async function lockAndRead(
  tx: AuthorizationInputTx,
  session: AuthenticatedSessionContext,
  connectionId: string,
): Promise<LockedTarget> {
  const integrationRows = await queryRows(tx, INTEGRATION_LOCK, [connectionId])
  if (integrationRows.length !== 1) refuse('integration_inactive')
  const integration = integrationRows[0]
  if (textOf(integration, 'provider') !== 'dingtalk' || textOf(integration, 'status') !== 'active') refuse('integration_inactive')
  const orgId = textOf(integration, 'org_id')
  const corpValue = nullableText(integration, 'corp_id')
  if (corpValue === null || corpValue.length === 0 || corpValue !== corpValue.trim()) refuse('scope_mismatch')
  const corpId = corpValue
  if (session.orgId !== null && session.orgId !== orgId) refuse('session_rejected')
  assertRepresentable(integration.config)
  const fingerprint = fingerprintOf(integration.config)
  const transport = transportFields(integration.config)
  const scope = scopeFromValues(corpId, transport.appKey)
  if (!scope || scope.tenant !== corpId || scope.appScope !== transport.appKey) refuse('scope_mismatch')
  try {
    assertDingTalkCorpAllowed(corpId)
  } catch (error) {
    if (error instanceof DingTalkCorpNotAllowedError) refuse('corp_not_allowed')
    throw error
  }

  const applicationRows = await queryRows(tx, APPLICATION_LOCK, [connectionId])
  if (applicationRows.length > 1) refuse('read_failed')
  const capabilityRows = await queryRows(tx, CAPABILITY_LOCK, [connectionId])
  if (capabilityRows.length !== 1) refuse('capability_moved')
  const capability = capabilityRows[0]
  if (capability.login_enabled !== true) refuse('capability_moved')
  if (textOf(capability, 'bound_provider') !== 'dingtalk' || textOf(capability, 'bound_org_id') !== orgId) refuse('capability_moved')
  if (textOf(capability, 'login_bound_tenant') !== scope.tenant || textOf(capability, 'login_bound_app_scope') !== scope.appScope) {
    refuse('scope_mismatch')
  }
  const capabilityRevision = textOf(capability, 'revision')
  if (!CANONICAL_DECIMAL.test(capabilityRevision)) refuse('read_failed')

  const identityRows = await queryRows(tx, IDENTITY_LOCK, [session.userId])
  if (identityRows.length === 0) refuse('identity_missing')
  if (identityRows.length !== 1) refuse('read_failed')
  const identity = identityRows[0]
  const identityId = textOf(identity, 'id')
  if (!UUID_TEXT.test(identityId)) refuse('read_failed')
  const providerOpenId = nullableText(identity, 'provider_open_id')
  const externalKey = textOf(identity, 'external_key')
  const identityCorp = nullableText(identity, 'corp_id')
  const providerUnionId = nullableText(identity, 'provider_union_id')
  if (identityCorp !== corpId || providerOpenId === null || providerOpenId.length === 0) refuse('subject_mismatch')
  const subjectKey = `${corpId}:${providerOpenId}`
  if (externalKey !== subjectKey || textOf(identity, 'provider') !== 'dingtalk' || textOf(identity, 'local_user_id') !== session.userId) {
    refuse('subject_mismatch')
  }
  if (providerUnionId === '') refuse('subject_mismatch')
  const slot: Slot = {
    corpId,
    externalKey: subjectKey,
    localUserId: session.userId,
    provider: 'dingtalk',
    providerOpenId,
    providerUnionId,
  }

  const bindingRows = await queryRows(tx, BINDING_LOCK, [identityId])
  if (bindingRows.length > 1) refuse('read_failed')
  let bindingRevision: string | null = null
  let bindingSlot: Slot | null = null
  if (bindingRows.length === 1) {
    const binding = bindingRows[0]
    bindingRevision = textOf(binding, 'binding_revision')
    if (!CANONICAL_DECIMAL.test(bindingRevision)) refuse('read_failed')
    const bindingUnion = nullableText(binding, 'provider_union_id')
    const bindingCorp = nullableText(binding, 'corp_id')
    const bindingOpen = nullableText(binding, 'provider_open_id')
    if (bindingCorp === null || bindingOpen === null) refuse('binding_mismatch')
    bindingSlot = {
      corpId: bindingCorp,
      externalKey: textOf(binding, 'external_key'),
      localUserId: textOf(binding, 'local_user_id'),
      provider: 'dingtalk',
      providerOpenId: bindingOpen,
      providerUnionId: bindingUnion,
    }
    if (textOf(binding, 'provider') !== 'dingtalk' || !sameSlot(bindingSlot, slot)) refuse('binding_mismatch')
  }

  const evidenceRows = await queryRows(tx, EVIDENCE_LOCK, [identityId])
  if (evidenceRows.length > 1) refuse('read_failed')
  let expiredEvidenceId: string | null = null
  let freshEvidence = false
  if (evidenceRows.length === 1) {
    if (evidenceRows[0].expired !== true && evidenceRows[0].expired !== false) refuse('read_failed')
    if (evidenceRows[0].expired === true) expiredEvidenceId = textOf(evidenceRows[0], 'id')
    else freshEvidence = true
  }

  const accountRows = await queryRows(tx, ACCOUNT_READ, [session.userId])
  if (accountRows.length !== 1) refuse('read_failed')
  const account = accountRows[0]
  if (!Object.prototype.hasOwnProperty.call(account, 'deleted_at') || !Object.prototype.hasOwnProperty.call(account, 'purged_at')) {
    refuse('read_failed')
  }
  if (typeof account.activation_status !== 'string' || typeof account.is_active !== 'boolean') refuse('read_failed')
  if (typeof account.local_password_set !== 'boolean' || typeof account.must_change_password !== 'boolean') refuse('read_failed')
  if (account.deleted_at !== null || account.purged_at !== null) refuse('account_ineligible')
  if (account.activation_status !== 'activated' || account.is_active !== true) refuse('account_ineligible')
  if (account.local_password_set !== true || account.must_change_password !== false) refuse('account_ineligible')
  const accessGeneration = textOf(account, 'access_generation')
  if (!CANONICAL_DECIMAL.test(accessGeneration)) refuse('read_failed')
  const membership = await queryRows(tx, MEMBERSHIP_READ, [session.userId, orgId])
  if (membership.length === 0) refuse('membership_missing')

  let privilegeWitness = ''
  try {
    const assessment = await assessSecurityActionPrivilege({
      query: async (statement: string, params?: unknown[]) => {
        const result = await tx.query(statement, params)
        return { rows: result.rows, rowCount: result.rowCount ?? null }
      },
    }, session.userId)
    if (assessment.privilegeClass !== 'standard' || assessment.reasons.length !== 0) refuse('privilege_refused')
    if (!HEX_64.test(assessment.witness)) refuse('read_failed')
    privilegeWitness = assessment.witness
  } catch (error) {
    if (error instanceof CurrentAppCeremonyRefusalError) throw error
    if (error instanceof PrivilegeInputsUnavailableError) refuse('read_failed')
    throw error
  }

  const applicationRevision = applicationRows.length === 1 ? textOf(applicationRows[0], 'application_revision') : null
  if (applicationRevision !== null && !CANONICAL_DECIMAL.test(applicationRevision)) refuse('read_failed')
  return {
    orgId,
    corpId,
    appScope: scope.appScope,
    appKey: transport.appKey,
    appSecret: transport.appSecret,
    fingerprint,
    capabilityRevision,
    identityId,
    subjectKey,
    slot,
    accessGeneration,
    privilegeWitness,
    applicationRevision,
    applicationFingerprint: applicationRows.length === 1 ? textOf(applicationRows[0], 'material_fingerprint') : null,
    bindingRevision,
    bindingSlot,
    expiredEvidenceId,
    freshEvidence,
  }
}

async function successorOf(tx: AuthorizationInputTx, revision: string): Promise<string> {
  if (!CANONICAL_DECIMAL.test(revision)) refuse('read_failed')
  const found = await queryRows(tx, SUCCESSOR_SCHEMA, [])
  if (found.length !== 1) refuse('read_failed')
  const schemaName = textOf(found[0], 'schema_name')
  if (schemaName.length === 0 || schemaName.startsWith('pg_') || schemaName === 'information_schema') refuse('read_failed')
  refuseUnrepresentableString(schemaName)
  const quoted = `"${schemaName.replace(/"/g, '""')}"`
  const rows = await queryRows(
    tx,
    `SELECT ${quoted}.admin_grant_application_successor($1::text) AS revision`,
    [revision],
  )
  if (rows.length !== 1) refuse('read_failed')
  const next = textOf(rows[0], 'revision')
  if (!CANONICAL_DECIMAL.test(next) || next === revision) refuse('read_failed')
  return next
}

async function ensureApplicationPin(
  tx: AuthorizationInputTx,
  connectionId: string,
  locked: LockedTarget,
  userId: string,
): Promise<string> {
  if (locked.applicationRevision === null) {
    const inserted = await queryRows(
      tx,
      `INSERT INTO directory_connection_application_pins
        (connection_id, application_revision, material_fingerprint, updated_by)
       VALUES ($1::uuid, '1', $2, $3)
       RETURNING application_revision`,
      [connectionId, locked.fingerprint, userId],
    )
    if (inserted.length !== 1 || textOf(inserted[0], 'application_revision') !== '1') refuse('read_failed')
    return '1'
  }
  if (locked.applicationFingerprint === locked.fingerprint) return locked.applicationRevision
  const next = await successorOf(tx, locked.applicationRevision)
  const updated = await queryRows(
    tx,
    `UPDATE directory_connection_application_pins
        SET application_revision = $2,
            material_fingerprint = $3,
            updated_by = $4
      WHERE connection_id = $1::uuid
      RETURNING application_revision`,
    [connectionId, next, locked.fingerprint, userId],
  )
  if (updated.length !== 1 || textOf(updated[0], 'application_revision') !== next) refuse('read_failed')
  return next
}

async function ensureBindingPin(tx: AuthorizationInputTx, locked: LockedTarget): Promise<string> {
  if (locked.bindingRevision === null) {
    const inserted = await queryRows(
      tx,
      `INSERT INTO user_external_identity_binding_pins
        (identity_id, binding_revision, provider, local_user_id, external_key, corp_id, provider_open_id, provider_union_id)
       VALUES ($1::uuid, 1, 'dingtalk', $2, $3, $4, $5, $6)
       RETURNING binding_revision::text AS binding_revision`,
      [locked.identityId, locked.slot.localUserId, locked.subjectKey, locked.corpId, locked.slot.providerOpenId, locked.slot.providerUnionId],
    )
    if (inserted.length !== 1 || textOf(inserted[0], 'binding_revision') !== '1') refuse('read_failed')
    return '1'
  }
  if (locked.bindingSlot === null || !sameSlot(locked.bindingSlot, locked.slot)) refuse('binding_mismatch')
  return locked.bindingRevision
}

async function bindSession(tx: AuthorizationInputTx, session: AuthenticatedSessionContext): Promise<{ tokenIssuedAt: string; watermarkUs: string }> {
  const tokenIssuedAt = issuedText(session)
  await queryRows(tx, WATERMARK_ENSURE, [session.userId], 'session_rejected')
  const watermarkRows = await queryRows(tx, WATERMARK_LOCK, [session.userId], 'session_rejected')
  if (watermarkRows.length !== 1) refuse('session_rejected')
  const watermarkUs = textOf(watermarkRows[0], 'revoked_after_us', 'session_rejected')
  if (!issuedAfterWatermark(tokenIssuedAt, watermarkUs)) refuse('session_rejected')
  const sessionRows = await queryRows(tx, SESSION_LOCK, [session.sessionId, session.userId], 'session_rejected')
  if (sessionRows.length !== 1 || sessionRows[0].live !== true || textOf(sessionRows[0], 'user_id', 'session_rejected') !== session.userId) {
    refuse('session_rejected')
  }
  return { tokenIssuedAt, watermarkUs }
}

async function insertChallenge(
  tx: AuthorizationInputTx,
  session: AuthenticatedSessionContext,
  connectionId: string,
  locked: LockedTarget,
  applicationRevision: string,
  bindingRevision: string,
  bound: { tokenIssuedAt: string; watermarkUs: string },
  state: string,
  browserToken: string,
): Promise<void> {
  const inserted = await queryRows(
    tx,
    `INSERT INTO admin_grant_target_ceremony_challenges
      (state_hash, browser_hash, target_user_id, session_id, org_id, connection_id, identity_id, provider,
       corp_id, app_scope, subject_key, application_revision, binding_revision, material_fingerprint,
       capability_revision_seen, access_generation, privilege_witness, privilege_class, privilege_reasons,
       slot_snapshot, token_issued_at, watermark_us, exchange_claimed_at, consumed_evidence_id, consumed_at,
       created_at, expires_at)
     SELECT $1, $2, $3, $4, $5, $6::uuid, $7, 'dingtalk',
            $8, $9, $10, $11, $12, $13,
            $14, $15, $16, 'standard', '[]'::jsonb,
            $17::jsonb, $18, $19, NULL, NULL, NULL,
            stamp.ts, stamp.ts + interval '5 minutes'
       FROM (SELECT clock_timestamp() AS ts) AS stamp
     RETURNING state_hash`,
    [
      sha256(state),
      sha256(browserToken),
      session.userId,
      session.sessionId,
      locked.orgId,
      connectionId,
      locked.identityId,
      locked.corpId,
      locked.appScope,
      locked.subjectKey,
      applicationRevision,
      bindingRevision,
      locked.fingerprint,
      locked.capabilityRevision,
      locked.accessGeneration,
      locked.privilegeWitness,
      slotJson(locked.slot),
      bound.tokenIssuedAt,
      bound.watermarkUs,
    ],
  )
  if (inserted.length !== 1) refuse('read_failed')
}

function profileUnion(profile: DingTalkCurrentUserProfile): string | null {
  if (typeof profile.unionId !== 'string') refuse('subject_mismatch')
  return profile.unionId.length === 0 ? null : profile.unionId
}

async function compareChallenge(
  tx: AuthorizationInputTx,
  session: AuthenticatedSessionContext,
  connectionId: string,
  locked: LockedTarget,
  bound: { tokenIssuedAt: string; watermarkUs: string },
  stateHash: string,
  browserToken: string,
  privilegeWitness: string,
): Promise<Record<string, unknown>> {
  const rows = await queryRows(tx, CHALLENGE_LOCK, [stateHash])
  if (rows.length !== 1) refuse('read_failed')
  const challenge = rows[0]
  if (challenge.live !== true) refuse('ceremony_expired')
  if (textOf(challenge, 'target_user_id') !== session.userId || textOf(challenge, 'session_id') !== session.sessionId) {
    refuse('session_rejected')
  }
  if (textOf(challenge, 'browser_hash') !== sha256(browserToken)) refuse('session_rejected')
  if (textOf(challenge, 'token_issued_at') !== bound.tokenIssuedAt || textOf(challenge, 'watermark_us') !== bound.watermarkUs) {
    refuse('session_rejected')
  }
  if (textOf(challenge, 'connection_id') !== connectionId) refuse('read_failed')
  if (textOf(challenge, 'provider') !== 'dingtalk' || textOf(challenge, 'privilege_class') !== 'standard') refuse('read_failed')
  if (!Array.isArray(challenge.privilege_reasons) || challenge.privilege_reasons.length !== 0) refuse('read_failed')
  if (privilegeWitness !== textOf(challenge, 'privilege_witness')) refuse('privilege_refused')
  if (textOf(challenge, 'material_fingerprint') !== locked.fingerprint) refuse('material_mismatch')
  if (textOf(challenge, 'application_revision') !== locked.applicationRevision) refuse('epoch_mismatch')
  if (textOf(challenge, 'binding_revision') !== locked.bindingRevision) refuse('epoch_mismatch')
  if (textOf(challenge, 'capability_revision_seen') !== locked.capabilityRevision) refuse('capability_moved')
  if (textOf(challenge, 'access_generation') !== locked.accessGeneration) refuse('epoch_mismatch')
  if (textOf(challenge, 'app_scope') !== locked.appScope || textOf(challenge, 'corp_id') !== locked.corpId) refuse('scope_mismatch')
  if (textOf(challenge, 'org_id') !== locked.orgId) refuse('epoch_mismatch')
  if (textOf(challenge, 'identity_id') !== locked.identityId || textOf(challenge, 'subject_key') !== locked.subjectKey) {
    refuse('subject_mismatch')
  }
  if (!sameSlot(slotFromUnknown(challenge.slot_snapshot), locked.slot)) refuse('subject_mismatch')
  return challenge
}

async function claim(
  tx: AuthorizationInputTx,
  session: AuthenticatedSessionContext,
  connectionId: string,
  request: CompleteRequest,
): Promise<ClaimedTransport> {
  const locked = await lockAndRead(tx, session, connectionId)
  if (locked.applicationRevision === null || locked.bindingRevision === null) refuse('epoch_mismatch')
  const bound = await bindSession(tx, session)
  const challenge = await compareChallenge(
    tx,
    session,
    connectionId,
    locked,
    bound,
    sha256(request.state),
    request.browserToken,
    locked.privilegeWitness,
  )
  if (challenge.exchange_claimed_at !== null || challenge.consumed_evidence_id !== null || challenge.consumed_at !== null) {
    refuse('ceremony_exchange_spent')
  }
  if (locked.freshEvidence) refuse('evidence_already_live')
  const claimed = await rowCountOf(
    tx,
    `UPDATE admin_grant_target_ceremony_challenges
        SET exchange_claimed_at = clock_timestamp()
      WHERE state_hash = $1
        AND exchange_claimed_at IS NULL
        AND consumed_evidence_id IS NULL
        AND consumed_at IS NULL
        AND expires_at > clock_timestamp()`,
    [sha256(request.state)],
    'read_failed',
  )
  if (claimed !== 1) refuse('ceremony_exchange_spent')
  return { clientId: locked.appKey, ciphertext: locked.appSecret, corpId: locked.corpId }
}

async function finish(
  tx: AuthorizationInputTx,
  session: AuthenticatedSessionContext,
  connectionId: string,
  request: CompleteRequest,
  profile: DingTalkCurrentUserProfile,
): Promise<void> {
  const locked = await lockAndRead(tx, session, connectionId)
  if (locked.applicationRevision === null || locked.bindingRevision === null) refuse('epoch_mismatch')
  const bound = await bindSession(tx, session)
  const challenge = await compareChallenge(
    tx,
    session,
    connectionId,
    locked,
    bound,
    sha256(request.state),
    request.browserToken,
    locked.privilegeWitness,
  )
  if (challenge.exchange_claimed_at === null || challenge.consumed_evidence_id !== null || challenge.consumed_at !== null) {
    refuse('ceremony_exchange_spent')
  }
  if (typeof profile.openId !== 'string' || profile.openId.length === 0 || profile.openId !== locked.slot.providerOpenId) {
    refuse('subject_mismatch')
  }
  if (profileUnion(profile) !== locked.slot.providerUnionId) refuse('subject_mismatch')
  if (`${locked.corpId}:${profile.openId}` !== locked.subjectKey) refuse('subject_mismatch')
  if (locked.freshEvidence) refuse('evidence_already_live')
  if (locked.expiredEvidenceId !== null) {
    const retired = await rowCountOf(
      tx,
      `UPDATE user_external_identity_evidence
          SET revocation_generation = revocation_generation + 1,
              live_identity_id = NULL
        WHERE id = $1
          AND live_identity_id IS NOT NULL
          AND fresh_until <= clock_timestamp()`,
      [locked.expiredEvidenceId],
      'read_failed',
    )
    if (retired !== 1) refuse('read_failed')
  }
  const evidenceId = opaqueToken()
  const evidenceWitness = opaqueToken()
  const consumed = await rowCountOf(
    tx,
    `UPDATE admin_grant_target_ceremony_challenges
        SET consumed_evidence_id = $2,
            consumed_at = clock_timestamp()
      WHERE state_hash = $1
        AND exchange_claimed_at IS NOT NULL
        AND consumed_evidence_id IS NULL
        AND consumed_at IS NULL
        AND expires_at > clock_timestamp()`,
    [sha256(request.state), evidenceId],
    'read_failed',
  )
  if (consumed !== 1) refuse('read_failed')
  const inserted = await queryRows(
    tx,
    `INSERT INTO user_external_identity_evidence
      (id, evidence_witness, identity_id, live_identity_id, binding_revision, producer_id, assurance,
       subject_key, app_scope, org_id, connection_id, capability_revision_seen, application_revision,
       material_fingerprint, evidence_revision, witnessed_at, fresh_until, revocation_generation,
       slot_snapshot, created_by, revoked_at)
     SELECT $1, $2, $3, $4::uuid, $5::bigint, $6, 'self_authenticated',
            $7, $8, $9, $10::uuid, $11::bigint, $12,
            $13, 1, stamp.ts, stamp.ts + interval '300 seconds', 0,
            $14::jsonb, $15, NULL
       FROM (SELECT clock_timestamp() AS ts) AS stamp
     RETURNING id`,
    [
      evidenceId,
      evidenceWitness,
      locked.identityId,
      locked.identityId,
      locked.bindingRevision,
      CURRENT_APP_TARGET_PRODUCER_ID,
      locked.subjectKey,
      locked.appScope,
      locked.orgId,
      connectionId,
      locked.capabilityRevision,
      locked.applicationRevision,
      locked.fingerprint,
      slotJson(locked.slot),
      session.userId,
    ],
  )
  if (inserted.length !== 1 || textOf(inserted[0], 'id') !== evidenceId) refuse('read_failed')
}

async function previewChallenge(
  queryable: AuthorizationInputQueryable,
  stateHash: string,
): Promise<{ connectionId: string } | null> {
  let result: { rows: Array<Record<string, unknown>> }
  try {
    result = await queryable.query(CHALLENGE_PREVIEW, [stateHash])
  } catch {
    refuse('read_failed')
  }
  if (!result || !Array.isArray(result.rows)) refuse('read_failed')
  if (result.rows.length === 0) return null
  if (result.rows.length !== 1) refuse('read_failed')
  const row = result.rows[0]
  if (typeof row !== 'object' || row === null || Array.isArray(row)) refuse('read_failed')
  const connectionId = row.connection_id
  if (typeof connectionId !== 'string' || !UUID_TEXT.test(connectionId)) refuse('read_failed')
  return { connectionId }
}

export function bindProductionTargetCeremony(): CurrentAppCeremonyRefusal {
  return { success: false, code: 'production_unavailable' }
}

export async function startCurrentAppCeremony(
  queryable: AuthorizationInputQueryable,
  body: unknown,
  session: unknown,
  deps?: CurrentAppCeremonyDeps,
): Promise<CurrentAppCeremonyStartResult> {
  const authenticated = gate(session)
  if (isRefusal(authenticated)) return authenticated
  try {
    assertRepresentable(body)
    const connectionId = startConnectionId(body)
    const again = gate(authenticated)
    if (isRefusal(again)) return again
    const redirect = redirectUri()
    const plan = await discoverPrivilegeRolePlan(queryable, [again.userId], { sourceIntegrationIds: [connectionId] })
    const started = await runRoot(plan, again, connectionId, deps, async (tx) => {
      const locked = await lockAndRead(tx, again, connectionId)
      if (locked.freshEvidence) refuse('evidence_already_live')
      const applicationRevision = await ensureApplicationPin(tx, connectionId, locked, again.userId)
      const bindingRevision = await ensureBindingPin(tx, locked)
      const bound = await bindSession(tx, again)
      const state = opaqueToken()
      const browserToken = opaqueToken()
      await insertChallenge(tx, again, connectionId, locked, applicationRevision, bindingRevision, bound, state, browserToken)
      return { appKey: locked.appKey, state, browserToken }
    })
    if (isRefusal(started)) return started
    return {
      success: true,
      data: { url: authorizeUrl(started.appKey, redirect, started.state) },
      browserToken: started.browserToken,
    }
  } catch (error) {
    return mapFailure(error)
  }
}

export async function completeCurrentAppCeremony(
  queryable: AuthorizationInputQueryable,
  body: unknown,
  session: unknown,
  deps?: CurrentAppCeremonyDeps,
): Promise<CurrentAppCeremonyCompleteResult> {
  const authenticated = gate(session)
  if (isRefusal(authenticated)) return authenticated
  try {
    assertRepresentable(body)
    const request = completeRequest(body)
    const again = gate(authenticated)
    if (isRefusal(again)) return again
    const redirect = redirectUri()
    const preview = await previewChallenge(queryable, sha256(request.state))
    if (!preview) return refusal('ceremony_expired')
    const plan = await discoverPrivilegeRolePlan(queryable, [again.userId], { sourceIntegrationIds: [preview.connectionId] })
    const claimed = await runRoot(plan, again, preview.connectionId, deps, (tx) => claim(tx, again, preview.connectionId, request))
    if (isRefusal(claimed)) return claimed
    let clientSecret: string
    try {
      clientSecret = decryptStoredSecretValue(claimed.ciphertext)
    } catch {
      return refusal('transport_config_unusable')
    }
    const options = { fetchFn: deps?.fetchFn, logUpstreamMessage: false as const }
    let profile: DingTalkCurrentUserProfile
    try {
      const exchanged = await exchangeCodeForUserAccessToken(request.code, {
        clientId: claimed.clientId,
        clientSecret,
        redirectUri: redirect,
        corpId: claimed.corpId,
      }, options)
      profile = await fetchDingTalkCurrentUser(exchanged.accessToken, options)
    } catch (error) {
      if (error instanceof CurrentAppCeremonyRefusalError) return refusal(error.code)
      return refusal('provider_exchange_refused')
    }
    const finished = await runRoot(plan, again, preview.connectionId, deps, async (tx) => {
      await finish(tx, again, preview.connectionId, request, profile)
      return { success: true as const }
    })
    if (isRefusal(finished)) return finished
    return { success: true }
  } catch (error) {
    return mapFailure(error)
  }
}
