import { randomBytes } from 'node:crypto'
import { adminGrantApplicationMaterialFingerprint, AdminGrantApplicationMaterialError } from './admin-grant-application-material'
import { SECURITY_ACTION_POLICY_REVISION } from './external-login-assurance'
import { assessSecurityActionPrivilege, PrivilegeInputsUnavailableError } from './security-action-privilege'
import { evaluateUserAuthenticationGate } from './user-activation'
import { decryptStoredSecretValue } from '../security/encrypted-secrets'
import { poolManager } from '../integration/db/connection-pool'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import {
  discoverPrivilegeRolePlan,
  revalidatePrivilegeRolePlan,
  type PrivilegeRolePlan,
} from '../rbac/authorization-privilege-witness-plan'
import {
  withAuthorizationInputTransaction,
  type AuthorizationInputTransactionRunner,
  type AuthorizationInputTx,
} from '../rbac/authorization-input-lock'
import {
  exchangeCodeForUserAccessToken,
  fetchDingTalkAppAccessTokenFresh,
  fetchDingTalkCurrentUser,
  getDingTalkUserDetail,
  getDingTalkUserInfoByAuthCode,
} from '../integrations/dingtalk/client'
import {
  DingTalkBusinessError,
  DingTalkIncompleteResponseError,
  DingTalkMalformedResponseError,
  DingTalkRequestError,
  DingTalkTimeoutError,
} from '../integrations/dingtalk/transport'
import type { StrictLoginGrantCaller, StrictSessionContext } from './strict-login-grant-store'

export const STRICT_SESSION_MAX_AGE_ENV = 'EXTERNAL_LOGIN_STRICT_SESSION_MAX_AGE_SECONDS'
export const STRICT_SESSION_MAX_AGE_MIN_SECONDS = 300
export const STRICT_SESSION_MAX_AGE_MAX_SECONDS = 2_592_000

export const STRICT_SESSION_ORG_FIELD = 'strictSessionOrgId'

export const STRICT_SELECTOR_HEADERS = ['x-tenant-id', 'x-org-id', 'x-workspace-id'] as const
export const STRICT_SELECTOR_FIELDS = ['orgId', 'tenantId', 'workspaceId', 'org_id', 'tenant_id', 'workspace_id'] as const

export const STRICT_DINGTALK_ENTRY_GATES = Object.freeze({
  implementationPermit: false,
  productionAvailable: false,
  b2Complete: false,
  delivered: false,
  containerAdapterProved: false,
})

const CONTAINER_BASE_URL = 'https://oapi.dingtalk.com'
const PROVIDER = 'dingtalk'
const SLOT_FIELDS = ['corpId', 'externalKey', 'localUserId', 'provider', 'providerOpenId', 'providerUnionId'] as const

const GRANT_JOIN = `SELECT
    grant_row.id AS grant_id,
    grant_row.local_user_id,
    grant_row.identity_id,
    grant_row.live_identity_id::text AS live_identity_id,
    grant_row.connection_id::text AS connection_id,
    grant_row.binding_revision_text,
    grant_row.application_revision AS grant_application_revision,
    grant_row.access_generation_text,
    grant_row.org_id AS grant_org_id,
    grant_row.subject_key,
    grant_row.app_scope,
    grant_row.material_fingerprint AS grant_material_fingerprint,
    grant_row.capability_revision_seen,
    grant_row.assurance AS grant_assurance,
    grant_row.enabled,
    identity.provider AS identity_provider,
    identity.local_user_id AS identity_user_id,
    identity.external_key,
    identity.corp_id AS identity_corp_id,
    identity.provider_open_id,
    identity.provider_union_id,
    pin.binding_revision::text AS pin_binding_revision,
    pin.provider AS pin_provider,
    pin.local_user_id AS pin_user_id,
    pin.external_key AS pin_external_key,
    pin.corp_id AS pin_corp_id,
    pin.provider_open_id AS pin_open_id,
    pin.provider_union_id AS pin_union_id,
    evidence.id AS evidence_id,
    evidence.identity_id AS evidence_identity_id,
    evidence.live_identity_id::text AS evidence_live_identity_id,
    evidence.binding_revision::text AS evidence_binding_revision,
    evidence.assurance AS evidence_assurance,
    evidence.subject_key AS evidence_subject_key,
    evidence.app_scope AS evidence_app_scope,
    evidence.org_id AS evidence_org_id,
    evidence.connection_id::text AS evidence_connection_id,
    evidence.capability_revision_seen::text AS evidence_capability_revision,
    evidence.application_revision AS evidence_application_revision,
    evidence.material_fingerprint AS evidence_material_fingerprint,
    evidence.slot_snapshot,
    (evidence.revoked_at IS NULL) AS evidence_open,
    integration.org_id AS integration_org_id,
    integration.provider AS integration_provider,
    integration.corp_id AS integration_corp_id,
    integration.status AS integration_status,
    integration.config AS integration_config,
    application.application_revision AS application_revision,
    application.material_fingerprint AS application_material_fingerprint,
    capability.revision::text AS capability_revision,
    capability.login_enabled,
    capability.login_bound_tenant,
    capability.login_bound_app_scope,
    capability.bound_provider,
    capability.bound_org_id,
    users.email,
    users.name,
    users.role AS user_role,
    users.permissions,
    users.is_active,
    users.must_change_password,
    users.activation_status,
    users.local_password_set,
    users.created_at,
    users.updated_at,
    users.access_generation::text AS access_generation,
    (users.deleted_at IS NOT NULL) AS deleted,
    (users.purged_at IS NOT NULL) AS purged,
    membership.present AS membership_present,
    EXISTS (
      SELECT 1
        FROM directory_connection_login_scope strict_scope
       WHERE strict_scope.connection_id = grant_row.connection_id
    ) AS strict_scope_present
  FROM user_external_identity_login_grants grant_row
  JOIN user_external_identities identity ON identity.id::text = grant_row.identity_id
  JOIN user_external_identity_binding_pins pin ON pin.identity_id = identity.id
  JOIN user_external_identity_evidence evidence ON evidence.id = grant_row.evidence_id
  JOIN directory_integrations integration ON integration.id = grant_row.connection_id
  JOIN directory_connection_application_pins application ON application.connection_id = grant_row.connection_id
  JOIN directory_integration_capabilities capability ON capability.integration_id = grant_row.connection_id
  JOIN users ON users.id = grant_row.local_user_id
  LEFT JOIN LATERAL (
    SELECT 1 AS present
      FROM user_orgs
     WHERE user_id = grant_row.local_user_id
       AND org_id = grant_row.org_id
       AND is_active = true
  ) membership ON true`

export type VerifiedSessionClass = 'strict' | 'standard' | 'conflict' | 'none'

export type StrictDingTalkEntryCode =
  | 'STRICT_CONNECTION_AMBIGUOUS'
  | 'STRICT_SESSION_UNCONFIGURED'
  | 'STRICT_LOGIN_REFUSED'
  | 'STRICT_LOGIN_READ_FAILED'
  | 'STRICT_LOGIN_INPUT_REFUSED'
  | 'STRICT_PROVIDER_EXCHANGE_REFUSED'
  | 'STRICT_SESSION_NOT_CURRENT'
  | 'SESSION_ORG_NOT_MEMBER'

export class StrictDingTalkEntryError extends Error {
  readonly code: StrictDingTalkEntryCode
  readonly httpStatus: number

  constructor(code: StrictDingTalkEntryCode, httpStatus: number) {
    super(code)
    this.name = 'StrictDingTalkEntryError'
    this.code = code
    this.httpStatus = httpStatus
  }
}

export type StrictSessionPrincipal = {
  id: string
  email: string | null
  name: string
  role: string
  permissions: string[]
  tenantId: string
  is_active: boolean
  must_change_password: boolean
  activation_status: string
  local_password_set: boolean
  created_at: Date
  updated_at: Date
  strictSessionOrgId: string
}

export type StrictTokenMinter = (
  user: StrictSessionPrincipal,
  options: { sid: string; externalAuth: true },
) => string

export type StrictTokenExpReader = (token: string) => number | null

export type StrictDingTalkTransport = {
  fetchFn?: typeof fetch
  timeoutMs?: number
  signal?: AbortSignal
}

export type StrictDingTalkSignInInput = {
  code: string
  selector?: { connectionId?: unknown; corpId?: unknown }
  transport?: StrictDingTalkTransport
  transaction?: AuthorizationInputTransactionRunner
  createToken: StrictTokenMinter
  readExp: StrictTokenExpReader
  readIssuedAt: StrictTokenExpReader
  env?: Readonly<Record<string, string | undefined>>
  ipAddress?: string | null
  userAgent?: string | null
}

export type StrictDingTalkSignInResult =
  | { readonly status: 'issued'; readonly token: string; readonly user: StrictSessionPrincipal }
  | { readonly status: 'not-strict' }

export type StrictDingTalkLocalBinding = {
  readonly gates: typeof STRICT_DINGTALK_ENTRY_GATES
  currentStrictGrantUsable: typeof currentStrictGrantUsable
  signInWeb: (input: Omit<StrictDingTalkSignInInput, 'createToken' | 'readExp' | 'readIssuedAt' | 'transaction'>) => Promise<StrictDingTalkSignInResult>
  signInContainer: (input: Omit<StrictDingTalkSignInInput, 'createToken' | 'readExp' | 'readIssuedAt' | 'transaction'>) => Promise<StrictDingTalkSignInResult>
  verifyPersistedStrictSession: typeof verifyPersistedStrictSession
  refreshStrictSession: (input: Omit<StrictSessionContinueInput, 'createToken' | 'readExp'>) => Promise<{ token: string; user: StrictSessionPrincipal } | null>
  switchStrictSessionOrg: (input: Omit<StrictSessionSwitchInput, 'createToken' | 'readExp'>) => Promise<{ token: string; user: StrictSessionPrincipal } | null>
}

type QueryCaller = StrictLoginGrantCaller

type StoreModule = typeof import('./strict-login-grant-store')

type GrantRow = Record<string, unknown>

type AppSnapshot = {
  connectionId: string
  orgId: string
  corpId: string
  appKey: string
  appSecretStored: string
  applicationRevision: string
  materialFingerprint: string
  capabilityRevision: string
  appScope: string
}

type LoginWitness =
  | { kind: 'web'; openId: string }
  | { kind: 'container'; unionId: string }

export type StrictSessionContinueInput = {
  caller: QueryCaller
  payload: unknown
  createToken: StrictTokenMinter
  readExp: StrictTokenExpReader
  env?: Readonly<Record<string, string | undefined>>
  ipAddress?: string | null
  userAgent?: string | null
}

export type StrictSessionSwitchInput = StrictSessionContinueInput & {
  orgId: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function refuse(code: StrictDingTalkEntryCode, httpStatus: number): never {
  throw new StrictDingTalkEntryError(code, httpStatus)
}

function readFailed(): never {
  refuse('STRICT_LOGIN_READ_FAILED', 503)
}

function loginRefused(): never {
  refuse('STRICT_LOGIN_REFUSED', 403)
}

let storePromise: Promise<StoreModule> | undefined

function loadStore(): Promise<StoreModule> {
  if (!storePromise) storePromise = import('./strict-login-grant-store')
  return storePromise
}

function rowsOf(result: { rows?: readonly Record<string, unknown>[] | unknown } | null | undefined): GrantRow[] {
  if (!result || !Array.isArray(result.rows)) readFailed()
  return result.rows.map((row) => {
    if (!isRecord(row)) readFailed()
    return row
  })
}

async function queryRows(caller: QueryCaller, sql: string, params: unknown[] = []): Promise<GrantRow[]> {
  return rowsOf(await caller.query(sql, params))
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function sameText(left: unknown, right: unknown): boolean {
  return typeof left === 'string' && left.length > 0 && left === right
}

function selectorText(value: unknown): string | null {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) refuse('STRICT_LOGIN_INPUT_REFUSED', 400)
  return value
}

function requireUserId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.includes('\u0000')) {
    refuse('STRICT_LOGIN_INPUT_REFUSED', 400)
  }
  return value
}

function configRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      return isRecord(parsed) ? parsed : null
    } catch {
      return null
    }
  }
  return isRecord(value) ? value : null
}

function storedField(config: Record<string, unknown>, key: string): string | null {
  if (!hasOwn(config, key)) return null
  const value = config[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function fingerprintOf(config: unknown): string | null {
  try {
    return adminGrantApplicationMaterialFingerprint(config)
  } catch (error) {
    if (error instanceof AdminGrantApplicationMaterialError) return null
    throw error
  }
}

function permissionList(value: unknown): string[] {
  if (value == null) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) readFailed()
  return value
}

function asDate(value: unknown): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  readFailed()
}

function slotMatches(snapshot: unknown, identity: {
  provider: string
  localUserId: string
  externalKey: string
  corpId: string
  providerOpenId: string | null
  providerUnionId: string | null
}): boolean {
  if (!isRecord(snapshot)) return false
  const keys = Object.keys(snapshot)
  if (keys.length !== SLOT_FIELDS.length || SLOT_FIELDS.some((field) => !hasOwn(snapshot, field))) return false
  const sameNullable = (left: string | null, right: unknown) => left === null
    ? right === null || right === undefined
    : left === right
  return snapshot.provider === identity.provider
    && snapshot.localUserId === identity.localUserId
    && snapshot.externalKey === identity.externalKey
    && snapshot.corpId === identity.corpId
    && sameNullable(identity.providerOpenId, snapshot.providerOpenId)
    && sameNullable(identity.providerUnionId, snapshot.providerUnionId)
}

function accountAccepts(row: GrantRow): boolean {
  if (row.must_change_password === true) return false
  const denial = evaluateUserAuthenticationGate({
    deleted_at: row.deleted === true ? 'deleted' : null,
    purged_at: row.purged === true ? 'purged' : null,
    role: textValue(row.user_role),
    is_active: row.is_active === true,
    activation_status: textValue(row.activation_status),
    local_password_set: row.local_password_set === true,
  })
  return denial === null
    && row.access_generation === row.access_generation_text
    && row.membership_present != null
}

function pinsMatch(row: GrantRow, witness?: LoginWitness): boolean {
  const config = configRecord(row.integration_config)
  const fingerprint = config ? fingerprintOf(config) : null
  if (!fingerprint) return false
  const openId = textValue(row.provider_open_id)
  const corpId = textValue(row.integration_corp_id)
  if (!openId || !corpId || openId.trim() !== openId || corpId.trim() !== corpId) return false
  const subject = `${corpId}:${openId}`
  const identity = {
    provider: textValue(row.identity_provider) ?? '',
    localUserId: textValue(row.identity_user_id) ?? '',
    externalKey: textValue(row.external_key) ?? '',
    corpId: textValue(row.identity_corp_id) ?? '',
    providerOpenId: openId,
    providerUnionId: textValue(row.provider_union_id),
  }
  if (row.enabled !== true) return false
  if (row.evidence_open !== true) return false
  if (row.grant_assurance !== 'self_authenticated' || row.evidence_assurance !== 'self_authenticated') return false
  if (!sameText(row.live_identity_id, row.identity_id)) return false
  if (!sameText(row.evidence_live_identity_id, row.identity_id)) return false
  if (!sameText(row.evidence_identity_id, row.identity_id)) return false
  if (!sameText(row.local_user_id, row.identity_user_id) || !sameText(row.local_user_id, row.pin_user_id)) return false
  if (identity.provider !== PROVIDER || row.integration_provider !== PROVIDER || row.pin_provider !== PROVIDER) return false
  if (row.bound_provider !== PROVIDER) return false
  if (!sameText(row.identity_corp_id, corpId) || !sameText(row.pin_corp_id, corpId)) return false
  if (!sameText(row.grant_org_id, row.integration_org_id) || !sameText(row.grant_org_id, row.evidence_org_id)) return false
  if (!sameText(row.bound_org_id, row.grant_org_id)) return false
  if (!sameText(row.connection_id, row.evidence_connection_id)) return false
  if (!sameText(row.subject_key, subject) || !sameText(row.evidence_subject_key, subject)) return false
  if (!sameText(row.app_scope, row.evidence_app_scope) || !sameText(row.app_scope, row.login_bound_app_scope)) return false
  if (!sameText(row.login_bound_tenant, corpId)) return false
  if (row.login_enabled !== true) return false
  if (!sameText(row.binding_revision_text, row.pin_binding_revision)) return false
  if (!sameText(row.binding_revision_text, row.evidence_binding_revision)) return false
  if (!sameText(row.grant_application_revision, row.evidence_application_revision)) return false
  if (!sameText(row.grant_application_revision, row.application_revision)) return false
  if (!sameText(row.grant_material_fingerprint, fingerprint)) return false
  if (!sameText(row.evidence_material_fingerprint, fingerprint)) return false
  if (!sameText(row.application_material_fingerprint, fingerprint)) return false
  if (!sameText(row.capability_revision_seen, row.evidence_capability_revision)) return false
  if (!sameText(row.capability_revision_seen, row.capability_revision)) return false
  if (!sameText(row.pin_open_id, openId)) return false
  if (textValue(row.pin_external_key) !== identity.externalKey) return false
  if (!slotMatches(row.slot_snapshot, identity)) return false
  if (!accountAccepts(row)) return false
  if (row.integration_status !== 'active') return false
  if (row.strict_scope_present !== true) return false
  if (witness?.kind === 'web' && openId !== witness.openId) return false
  if (witness?.kind === 'container') {
    if (identity.providerUnionId !== witness.unionId) return false
    if (!isRecord(row.slot_snapshot) || row.slot_snapshot.providerUnionId !== witness.unionId) return false
    if (textValue(row.pin_union_id) !== witness.unionId) return false
  }
  return true
}

function contextAgrees(context: StrictSessionContext, row: GrantRow): boolean {
  return context.provider === PROVIDER
    && context.connectionId === row.connection_id
    && context.identityId === row.identity_id
    && context.grantId === row.grant_id
    && context.evidenceId === row.evidence_id
    && context.orgId === row.grant_org_id
    && context.subjectKey === row.subject_key
    && context.subjectAppScope === row.app_scope
    && context.bindingRevision === row.binding_revision_text
    && context.applicationRevision === row.application_revision
    && context.accessGeneration === row.access_generation
    && context.assurance === 'self_authenticated'
    && context.scopeAsserted === false
    && context.policyRevision >= SECURITY_ACTION_POLICY_REVISION
}

function privilegeExecutor(caller: QueryCaller): Queryable {
  return {
    query: async (sql, params) => {
      const result = await caller.query(sql, params)
      if (!Array.isArray(result.rows)) readFailed()
      const rows: Array<Record<string, unknown>> = []
      for (const row of result.rows) {
        if (!isRecord(row)) readFailed()
        const copy: Record<string, unknown> = {}
        for (const key of Object.keys(row)) copy[key] = row[key]
        rows.push(copy)
      }
      if (rows.length !== result.rows.length) readFailed()
      return { rows, rowCount: result.rowCount ?? null }
    },
  }
}

async function currentPrivilegeRemainsEligible(caller: QueryCaller, userId: string): Promise<boolean> {
  try {
    const assessment = await assessSecurityActionPrivilege(privilegeExecutor(caller), userId)
    return assessment.privilegeClass === 'standard' && assessment.reasons.length === 0
  } catch (error) {
    if (error instanceof PrivilegeInputsUnavailableError) throw error
    throw error
  }
}

async function existingGrantRemainsEligible(caller: QueryCaller, row: GrantRow): Promise<boolean> {
  if (!pinsMatch(row)) return false
  const userId = textValue(row.local_user_id)
  if (!userId) return false
  return currentPrivilegeRemainsEligible(caller, userId)
}

export async function currentStrictGrantUsable(
  caller: QueryCaller,
  input: { userId: string; exceptConnectionId?: string | null },
): Promise<boolean> {
  const userId = requireUserId(input.userId)
  const except = input.exceptConnectionId == null || input.exceptConnectionId === ''
    ? null
    : selectorText(input.exceptConnectionId)
  const store = await loadStore()
  const installation = await store.readStrictLoginInstallation(caller)
  if (installation.installation !== 'installed') return false
  const found = await queryRows(
    caller,
    `${GRANT_JOIN}
      WHERE grant_row.local_user_id = $1
        AND grant_row.enabled = true
        AND grant_row.revoked_at IS NULL
        AND ($2::uuid IS NULL OR grant_row.connection_id <> $2::uuid)
      ORDER BY grant_row.id`,
    [userId, except],
  )
  const seen = new Set<string>()
  for (const row of found) {
    const grantId = textValue(row.grant_id)
    if (!grantId || seen.has(grantId)) readFailed()
    seen.add(grantId)
    if (await existingGrantRemainsEligible(caller, row)) return true
  }
  return false
}

export function classifyVerifiedSessionPayload(payload: unknown): VerifiedSessionClass {
  if (!isRecord(payload)) return 'none'
  const xs = typeof payload.sid === 'string' && payload.sid.startsWith('xs.')
  const xaOwned = hasOwn(payload, 'xa')
  if (!xs && !xaOwned) return 'standard'
  if (xs && xaOwned && payload.xa === true) return 'strict'
  return 'conflict'
}

export function readConfiguredStrictSessionMaxAgeSeconds(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number | null {
  if (!hasOwn(env, STRICT_SESSION_MAX_AGE_ENV)) return null
  const raw = env[STRICT_SESSION_MAX_AGE_ENV]
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw)) return null
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) return null
  if (value < STRICT_SESSION_MAX_AGE_MIN_SECONDS || value > STRICT_SESSION_MAX_AGE_MAX_SECONDS) return null
  return value
}

export function strictSessionOrgIdOf(user: unknown): string | null {
  if (!isRecord(user) || !hasOwn(user, STRICT_SESSION_ORG_FIELD)) return null
  const value = user[STRICT_SESSION_ORG_FIELD]
  if (typeof value !== 'string' || value.length === 0) return null
  return value
}

function selectorValueMismatches(orgId: string, value: unknown): boolean {
  return typeof value !== 'string' || value !== orgId
}

function recordSelectorMismatches(orgId: string, source: unknown, names: readonly string[]): boolean {
  if (!isRecord(source)) return false
  for (const name of names) {
    if (!hasOwn(source, name)) continue
    if (selectorValueMismatches(orgId, source[name])) return true
  }
  return false
}

export function strictSelectorMismatch(input: {
  orgId: string
  headers?: object | null
  query?: object | null
  body?: unknown
}): boolean {
  if (recordSelectorMismatches(input.orgId, input.headers, STRICT_SELECTOR_HEADERS)) return true
  if (recordSelectorMismatches(input.orgId, input.query, STRICT_SELECTOR_FIELDS)) return true
  if (recordSelectorMismatches(input.orgId, input.body, STRICT_SELECTOR_FIELDS)) return true
  return false
}

function claimUserId(payload: Record<string, unknown>): string | null {
  const value = payload.userId || payload.id || payload.sub
  return typeof value === 'string' && value.length > 0 && value.trim() === value ? value : null
}

function principalFrom(row: GrantRow): StrictSessionPrincipal {
  const id = textValue(row.local_user_id)
  const orgId = textValue(row.grant_org_id)
  const role = textValue(row.user_role)
  const activation = textValue(row.activation_status)
  if (!id || !orgId || !role || !activation) readFailed()
  const user: StrictSessionPrincipal = {
    id,
    email: textValue(row.email),
    name: textValue(row.name) ?? '',
    role,
    permissions: permissionList(row.permissions),
    tenantId: orgId,
    is_active: row.is_active === true,
    must_change_password: row.must_change_password === true,
    activation_status: activation,
    local_password_set: row.local_password_set === true,
    created_at: asDate(row.created_at),
    updated_at: asDate(row.updated_at),
    strictSessionOrgId: orgId,
  }
  return user
}

function runnerOf(transaction: AuthorizationInputTransactionRunner | undefined): AuthorizationInputTransactionRunner {
  if (transaction) return transaction
  return (handler) => poolManager.get().transaction((client) => handler({
    query: (sql, params) => client.query(sql, params),
    __rawClient: client.__rawClient,
  }))
}

function processAppKey(env: Readonly<Record<string, string | undefined>>): string | null {
  const values = [env.DINGTALK_APP_KEY, env.DINGTALK_CLIENT_ID]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
  if (values.length === 0) return null
  if (values.some((value) => value !== values[0])) return null
  return values[0]
}

async function selectStrictSnapshot(
  caller: QueryCaller,
  selector: { connectionId?: unknown; corpId?: unknown } | undefined,
  env: Readonly<Record<string, string | undefined>>,
): Promise<AppSnapshot | null> {
  const connectionId = selectorText(selector?.connectionId)
  const corpId = selectorText(selector?.corpId)
  const integrations = await queryRows(
    caller,
    `SELECT id::text AS id, org_id, corp_id, config
       FROM directory_integrations
      WHERE provider = $1
        AND status = 'active'
      ORDER BY id`,
    [PROVIDER],
  )
  let candidates = integrations
  if (connectionId) {
    candidates = integrations.filter((row) => row.id === connectionId)
  } else if (corpId) {
    candidates = integrations.filter((row) => row.corp_id === corpId)
  } else {
    const hint = processAppKey(env)
    if (!hint) return null
    candidates = integrations.filter((row) => {
      const config = configRecord(row.config)
      return config !== null && storedField(config, 'appKey') === hint
    })
    if (candidates.length !== 1) return null
  }
  if (candidates.length === 0) return null
  const store = await loadStore()
  const strictRows: GrantRow[] = []
  for (const row of candidates) {
    const id = textValue(row.id)
    if (!id) readFailed()
    const scope = await store.readConnectionLoginScope(caller, id)
    if (scope.installation === 'installed' && scope.scope) strictRows.push(row)
  }
  if (candidates.length > 1 && strictRows.length > 0) refuse('STRICT_CONNECTION_AMBIGUOUS', 503)
  if (strictRows.length !== 1) return null
  const row = strictRows[0]
  const id = textValue(row.id)
  const orgId = textValue(row.org_id)
  const corp = textValue(row.corp_id)
  const config = configRecord(row.config)
  if (!id || !orgId || !corp || !config) loginRefused()
  const appKey = storedField(config, 'appKey')
  const appSecretStored = storedField(config, 'appSecret')
  const fingerprint = fingerprintOf(config)
  if (!appKey || !appSecretStored || !fingerprint) loginRefused()
  const application = await queryRows(
    caller,
    `SELECT application_revision, material_fingerprint
       FROM directory_connection_application_pins
      WHERE connection_id = $1::uuid
      FOR SHARE`,
    [id],
  )
  const capability = await queryRows(
    caller,
    `SELECT revision::text AS revision, login_enabled, login_bound_tenant, login_bound_app_scope,
            bound_provider, bound_org_id
       FROM directory_integration_capabilities
      WHERE integration_id = $1::uuid
      FOR SHARE`,
    [id],
  )
  if (application.length !== 1 || capability.length !== 1) loginRefused()
  const applicationRevision = textValue(application[0].application_revision)
  const materialFingerprint = textValue(application[0].material_fingerprint)
  const capabilityRevision = textValue(capability[0].revision)
  const appScope = textValue(capability[0].login_bound_app_scope)
  if (!applicationRevision || !materialFingerprint || !capabilityRevision || !appScope) loginRefused()
  if (materialFingerprint !== fingerprint) loginRefused()
  if (capability[0].login_enabled !== true) loginRefused()
  if (capability[0].bound_provider !== PROVIDER || capability[0].bound_org_id !== orgId) loginRefused()
  if (capability[0].login_bound_tenant !== corp) loginRefused()
  return {
    connectionId: id,
    orgId,
    corpId: corp,
    appKey,
    appSecretStored,
    applicationRevision,
    materialFingerprint,
    capabilityRevision,
    appScope,
  }
}

function transportOptions(transport: StrictDingTalkTransport | undefined): {
  fetchFn?: typeof fetch
  timeoutMs?: number
  signal?: AbortSignal
  logUpstreamMessage: false
} {
  return {
    fetchFn: transport?.fetchFn,
    timeoutMs: transport?.timeoutMs,
    signal: transport?.signal,
    logUpstreamMessage: false,
  }
}

function isProviderError(error: unknown): boolean {
  return error instanceof DingTalkRequestError
    || error instanceof DingTalkBusinessError
    || error instanceof DingTalkIncompleteResponseError
    || error instanceof DingTalkMalformedResponseError
    || error instanceof DingTalkTimeoutError
}

async function providerExchange<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof StrictDingTalkEntryError) throw error
    if (isProviderError(error)) refuse('STRICT_PROVIDER_EXCHANGE_REFUSED', 502)
    throw error
  }
}

function decryptSecret(stored: string): string {
  try {
    const secret = decryptStoredSecretValue(stored)
    if (typeof secret !== 'string' || secret.length === 0) refuse('STRICT_PROVIDER_EXCHANGE_REFUSED', 502)
    return secret
  } catch (error) {
    if (error instanceof StrictDingTalkEntryError) throw error
    refuse('STRICT_PROVIDER_EXCHANGE_REFUSED', 502)
  }
}

function ownUnionId(source: Record<string, unknown>): 'absent' | 'malformed' | string {
  const present = (['unionid', 'unionId'] as const)
    .filter((key) => hasOwn(source, key))
    .map((key) => source[key])
    .filter((value) => value !== undefined && value !== null)
  if (present.length === 0) return 'absent'
  if (present.some((value) => typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.includes('\u0000'))) {
    return 'malformed'
  }
  const [first] = present as string[]
  if (present.some((value) => value !== first)) return 'malformed'
  return first
}

function rawDirectoryUserId(source: Record<string, unknown>): string | null {
  const present = (['userid', 'userId'] as const)
    .filter((key) => hasOwn(source, key))
    .map((key) => source[key])
    .filter((value) => value !== undefined && value !== null)
  if (present.length === 0) return null
  if (present.some((value) => typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.includes('\u0000'))) {
    return null
  }
  const [first] = present as string[]
  if (present.some((value) => value !== first)) return null
  return first
}

async function exchangeWeb(snapshot: AppSnapshot, code: string, transport: StrictDingTalkTransport | undefined): Promise<LoginWitness> {
  if (snapshot.corpId.length === 0) loginRefused()
  const secret = decryptSecret(snapshot.appSecretStored)
  const options = transportOptions(transport)
  const token = await providerExchange(() => exchangeCodeForUserAccessToken(code, {
    clientId: snapshot.appKey,
    clientSecret: secret,
    redirectUri: '',
    corpId: snapshot.corpId,
  }, options))
  const profile = await providerExchange(() => fetchDingTalkCurrentUser(token.accessToken, options))
  if (typeof profile.openId !== 'string' || profile.openId.length === 0 || profile.openId.trim() !== profile.openId) {
    refuse('STRICT_PROVIDER_EXCHANGE_REFUSED', 502)
  }
  return { kind: 'web', openId: profile.openId }
}

async function exchangeContainer(snapshot: AppSnapshot, code: string, transport: StrictDingTalkTransport | undefined): Promise<LoginWitness> {
  const secret = decryptSecret(snapshot.appSecretStored)
  const options = transportOptions(transport)
  const directory = { appKey: snapshot.appKey, appSecret: secret, baseUrl: CONTAINER_BASE_URL }
  const appToken = await providerExchange(() => fetchDingTalkAppAccessTokenFresh(directory, options))
  const info = await providerExchange(() => getDingTalkUserInfoByAuthCode(
    appToken,
    code,
    { baseUrl: CONTAINER_BASE_URL },
    options,
  ))
  const first = ownUnionId(info.source)
  if (first === 'malformed') refuse('STRICT_PROVIDER_EXCHANGE_REFUSED', 502)
  let unionId = first === 'absent' ? null : first
  if (unionId === null) {
    const userId = rawDirectoryUserId(info.source)
    if (!userId) refuse('STRICT_PROVIDER_EXCHANGE_REFUSED', 502)
    const detail = await providerExchange(() => getDingTalkUserDetail(
      appToken,
      userId,
      { baseUrl: CONTAINER_BASE_URL },
      options,
    ))
    const second = ownUnionId(detail.source)
    if (second === 'absent' || second === 'malformed') refuse('STRICT_PROVIDER_EXCHANGE_REFUSED', 502)
    unionId = second
  } else if (rawDirectoryUserId(info.source)) {
    const userId = rawDirectoryUserId(info.source)
    if (userId && hasOwn(info.source, 'unionid') === false && hasOwn(info.source, 'unionId') === false) {
      refuse('STRICT_PROVIDER_EXCHANGE_REFUSED', 502)
    }
  }
  return { kind: 'container', unionId }
}

async function findCandidate(
  caller: QueryCaller,
  snapshot: AppSnapshot,
  witness: LoginWitness,
): Promise<{ identityId: string; evidenceId: string; grantId: string }> {
  const subject = witness.kind === 'web' ? `${snapshot.corpId}:${witness.openId}` : null
  const rows = await queryRows(
    caller,
    `SELECT DISTINCT identity.id::text AS identity_id, evidence.id AS evidence_id
       FROM user_external_identities identity
       JOIN user_external_identity_evidence evidence
         ON evidence.live_identity_id = identity.id
        AND evidence.revoked_at IS NULL
      WHERE identity.provider = $1
        AND identity.corp_id = $2
        AND evidence.connection_id = $3::uuid
        AND ($4::text IS NULL OR identity.provider_open_id = $4)
        AND ($4::text IS NULL OR evidence.subject_key = $5)
        AND ($6::text IS NULL OR identity.provider_union_id = $6)`,
    [
      PROVIDER,
      snapshot.corpId,
      snapshot.connectionId,
      witness.kind === 'web' ? witness.openId : null,
      subject,
      witness.kind === 'container' ? witness.unionId : null,
    ],
  )
  const identityIds = [...new Set(rows.map((row) => textValue(row.identity_id)).filter((id): id is string => id !== null))]
  if (identityIds.length !== 1 || rows.length !== 1) loginRefused()
  const identityId = identityIds[0]
  const evidenceId = textValue(rows[0].evidence_id)
  if (!evidenceId) loginRefused()
  const grants = await queryRows(
    caller,
    `SELECT id
       FROM user_external_identity_login_grants
      WHERE identity_id = $1
        AND connection_id = $2::uuid
        AND enabled = true
        AND revoked_at IS NULL
      ORDER BY id`,
    [identityId, snapshot.connectionId],
  )
  if (grants.length !== 1) loginRefused()
  const grantId = textValue(grants[0].id)
  if (!grantId) loginRefused()
  return { identityId, evidenceId, grantId }
}

async function lockLoginRows(
  tx: AuthorizationInputTx,
  snapshot: AppSnapshot,
  candidate: { identityId: string; evidenceId: string; grantId: string },
): Promise<void> {
  const integration = rowsOf(await tx.query(
    `SELECT id::text AS id, org_id, provider, corp_id, status
       FROM directory_integrations
      WHERE id = $1::uuid
      FOR SHARE`,
    [snapshot.connectionId],
  ))
  if (integration.length !== 1) loginRefused()
  if (integration[0].status !== 'active') loginRefused()
  if (integration[0].provider !== PROVIDER || integration[0].org_id !== snapshot.orgId || integration[0].corp_id !== snapshot.corpId) {
    loginRefused()
  }
  const application = rowsOf(await tx.query(
    `SELECT application_revision, material_fingerprint
       FROM directory_connection_application_pins
      WHERE connection_id = $1::uuid
      FOR SHARE`,
    [snapshot.connectionId],
  ))
  if (application.length !== 1) loginRefused()
  if (application[0].application_revision !== snapshot.applicationRevision) loginRefused()
  if (application[0].material_fingerprint !== snapshot.materialFingerprint) loginRefused()
  const capability = rowsOf(await tx.query(
    `SELECT revision::text AS revision
       FROM directory_integration_capabilities
      WHERE integration_id = $1::uuid
      FOR SHARE`,
    [snapshot.connectionId],
  ))
  if (capability.length !== 1 || capability[0].revision !== snapshot.capabilityRevision) loginRefused()
  const identity = rowsOf(await tx.query(
    `SELECT id::text AS id
       FROM user_external_identities
      WHERE id = $1::uuid
      FOR SHARE`,
    [candidate.identityId],
  ))
  if (identity.length !== 1) loginRefused()
  const pin = rowsOf(await tx.query(
    `SELECT identity_id::text AS identity_id
       FROM user_external_identity_binding_pins
      WHERE identity_id = $1::uuid
      FOR SHARE`,
    [candidate.identityId],
  ))
  if (pin.length !== 1) loginRefused()
  const evidence = rowsOf(await tx.query(
    `SELECT id
       FROM user_external_identity_evidence
      WHERE id = $1
      FOR SHARE`,
    [candidate.evidenceId],
  ))
  if (evidence.length !== 1) loginRefused()
  const grant = rowsOf(await tx.query(
    `SELECT id, enabled, (revoked_at IS NULL) AS unrevoked
       FROM user_external_identity_login_grants
      WHERE id = $1
        AND identity_id = $2
        AND connection_id = $3::uuid
      FOR SHARE`,
    [candidate.grantId, candidate.identityId, snapshot.connectionId],
  ))
  if (grant.length !== 1 || grant[0].enabled !== true || grant[0].unrevoked !== true) loginRefused()
}

async function insertStrictSession(
  tx: AuthorizationInputTx,
  row: GrantRow,
  maxAge: number,
  ipAddress: string | null,
  userAgent: string | null,
  sid: string,
): Promise<{ sid: string; user: StrictSessionPrincipal }> {
  const store = await loadStore()
  const user = principalFrom(row)
  const context = store.parseStrictSessionContext({
    v: 1,
    provider: PROVIDER,
    connectionId: row.connection_id,
    identityId: row.identity_id,
    grantId: row.grant_id,
    evidenceId: row.evidence_id,
    orgId: row.grant_org_id,
    subjectAppScope: row.app_scope,
    subjectKey: row.subject_key,
    bindingRevision: row.binding_revision_text,
    applicationRevision: row.application_revision,
    accessGeneration: row.access_generation,
    capRev: row.capability_revision,
    assurance: 'self_authenticated',
    policyRevision: SECURITY_ACTION_POLICY_REVISION,
    scopeAsserted: false,
  })
  let inserted: { rows?: readonly Record<string, unknown>[] }
  try {
    inserted = await tx.query(
      `INSERT INTO user_sessions (
         id, user_id, issued_at, expires_at, last_seen_at, revoked_at, revoked_by, revoke_reason,
         ip_address, user_agent, created_at, updated_at, external_auth_context
       )
       SELECT $1, $2, clock_timestamp(), clock_timestamp() + make_interval(secs => $3::int),
              clock_timestamp(), NULL, NULL, NULL, $4, $5, clock_timestamp(), clock_timestamp(), $6::jsonb
        WHERE EXISTS (SELECT 1 FROM users WHERE id = $2)
       RETURNING id`,
      [sid, user.id, maxAge, ipAddress, userAgent, JSON.stringify(context)],
    )
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined
    if (code === '42P01' || code === '42703') throw error
    throw error
  }
  if (rowsOf(inserted).length !== 1) loginRefused()
  return { sid, user }
}

async function capSessionExpiry(tx: AuthorizationInputTx, sid: string, exp: number): Promise<void> {
  await tx.query(
    `UPDATE user_sessions
        SET expires_at = LEAST(expires_at, to_timestamp($2::double precision)),
            updated_at = clock_timestamp()
      WHERE id = $1
        AND expires_at > to_timestamp($2::double precision)`,
    [sid, exp],
  )
}

async function issueOnRoot(
  input: StrictDingTalkSignInInput,
  snapshot: AppSnapshot,
  witness: LoginWitness,
  candidate: { identityId: string; evidenceId: string; grantId: string },
  plan: PrivilegeRolePlan,
  maxAge: number,
): Promise<StrictDingTalkSignInResult> {
  const issued = await withAuthorizationInputTransaction(plan.lockPlan, async (tx) => {
    await revalidatePrivilegeRolePlan(tx, plan)
    tx.requireIdentityRead([snapshot.connectionId])
    await lockLoginRows(tx, snapshot, candidate)
    const locked = rowsOf(await tx.query(
      `${GRANT_JOIN}
        WHERE grant_row.id = $1
          AND grant_row.identity_id = $2
          AND grant_row.connection_id = $3::uuid
          AND evidence.id = $4
          AND grant_row.enabled = true
          AND grant_row.revoked_at IS NULL`,
      [candidate.grantId, candidate.identityId, snapshot.connectionId, candidate.evidenceId],
    ))
    if (locked.length !== 1) loginRefused()
    const row = locked[0]
    if (row.application_revision !== snapshot.applicationRevision) loginRefused()
    if (row.capability_revision !== snapshot.capabilityRevision) loginRefused()
    if (row.grant_material_fingerprint !== snapshot.materialFingerprint) loginRefused()
    if (!pinsMatch(row, witness)) loginRefused()
    const targetUserId = textValue(row.local_user_id)
    if (!targetUserId) loginRefused()
    tx.requireUserRows([targetUserId])
    const assessment = await assessSecurityActionPrivilege(privilegeExecutor(tx), targetUserId)
    if (assessment.privilegeClass !== 'standard' || assessment.reasons.length !== 0) loginRefused()
    const user = principalFrom(row)
    const store = await loadStore()
    await store.prelockUserSessionWatermarks(tx, [user.id])
    const sid = `xs.${randomBytes(16).toString('hex')}`
    const token = input.createToken(user, { sid, externalAuth: true })
    const exp = input.readExp(token)
    const issuedAt = input.readIssuedAt(token)
    if (exp == null || issuedAt == null || !Number.isFinite(exp) || !Number.isFinite(issuedAt)) loginRefused()
    const timing = await queryRows(
      tx,
      `SELECT (to_timestamp($1::double precision) > clock_timestamp()) AS exp_future`,
      [exp],
    )
    if (timing.length !== 1 || timing[0].exp_future !== true) loginRefused()
    const covered = await queryRows(
      tx,
      `SELECT 1 AS present
         FROM user_session_revocations
        WHERE user_id = $1
          AND revoked_after >= to_timestamp($2::double precision)`,
      [user.id, issuedAt],
    )
    if (covered.length !== 0) loginRefused()
    const inserted = await insertStrictSession(tx, row, maxAge, input.ipAddress ?? null, input.userAgent ?? null, sid)
    await capSessionExpiry(tx, sid, exp)
    return { token, user: inserted.user }
  }, { transaction: input.transaction })
  return { status: 'issued', token: issued.token, user: issued.user }
}

async function signIn(input: StrictDingTalkSignInInput, kind: 'web' | 'container'): Promise<StrictDingTalkSignInResult> {
  if (typeof input.code !== 'string' || input.code.length === 0 || input.code.trim() !== input.code) {
    refuse('STRICT_LOGIN_INPUT_REFUSED', 400)
  }
  const env = input.env ?? process.env
  const maxAge = readConfiguredStrictSessionMaxAgeSeconds(env)
  const runner = runnerOf(input.transaction)
  const snapshot = await runner(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    return selectStrictSnapshot({ query: (sql, params) => client.query(sql, params) }, input.selector, env)
  })
  if (!snapshot) return { status: 'not-strict' }
  if (maxAge == null) refuse('STRICT_SESSION_UNCONFIGURED', 503)
  const witness = kind === 'web'
    ? await exchangeWeb(snapshot, input.code, input.transport)
    : await exchangeContainer(snapshot, input.code, input.transport)
  const hinted = await runner(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    const caller = { query: (sql: string, params?: unknown[]) => client.query(sql, params) }
    const candidate = await findCandidate(caller, snapshot, witness)
    const plan = await discoverPrivilegeRolePlan(
      caller,
      [await grantUserId(caller, candidate.grantId)],
      { sourceIntegrationIds: [snapshot.connectionId] },
    )
    return { candidate, plan }
  })
  return issueOnRoot({ ...input, transaction: runner }, snapshot, witness, hinted.candidate, hinted.plan, maxAge)
}

async function grantUserId(caller: QueryCaller, grantId: string): Promise<string> {
  const rows = await queryRows(
    caller,
    `SELECT local_user_id
       FROM user_external_identity_login_grants
      WHERE id = $1
        AND enabled = true
        AND revoked_at IS NULL`,
    [grantId],
  )
  if (rows.length !== 1) loginRefused()
  const userId = textValue(rows[0].local_user_id)
  if (!userId) loginRefused()
  return userId
}

export function signInStrictDingTalkWeb(input: StrictDingTalkSignInInput): Promise<StrictDingTalkSignInResult> {
  return signIn(input, 'web')
}

export function signInStrictDingTalkContainer(input: StrictDingTalkSignInInput): Promise<StrictDingTalkSignInResult> {
  return signIn(input, 'container')
}

async function readOpenSession(caller: QueryCaller, sid: string, maxAge: number): Promise<GrantRow | null> {
  const rows = await queryRows(
    caller,
    `SELECT id, user_id, external_auth_context,
            (revoked_at IS NULL) AS session_open,
            (expires_at > clock_timestamp()) AS unexpired,
            (issued_at + make_interval(secs => $2::int) > clock_timestamp()) AS within_lifetime,
            NOT EXISTS (
              SELECT 1
                FROM user_session_revocations watermark
               WHERE watermark.user_id = user_sessions.user_id
                 AND watermark.revoked_after >= user_sessions.issued_at
            ) AS watermark_clear
       FROM user_sessions
      WHERE id = $1`,
    [sid, maxAge],
  )
  if (rows.length === 0) return null
  if (rows.length !== 1) readFailed()
  const row = rows[0]
  if (row.session_open !== true || row.unexpired !== true || row.within_lifetime !== true) return null
  if (row.watermark_clear !== true) return null
  return row
}

async function continueAuthorized(
  caller: QueryCaller,
  payload: unknown,
  env: Readonly<Record<string, string | undefined>>,
): Promise<{ context: StrictSessionContext; row: GrantRow; sid: string } | null> {
  if (classifyVerifiedSessionPayload(payload) !== 'strict' || !isRecord(payload)) return null
  const sid = textValue(payload.sid)
  const userId = claimUserId(payload)
  const tenantId = textValue(payload.tenantId)
  if (!sid || !userId || !tenantId) return null
  const maxAge = readConfiguredStrictSessionMaxAgeSeconds(env)
  if (maxAge == null) return null
  const store = await loadStore()
  const installation = await store.readStrictLoginInstallation(caller)
  if (installation.installation !== 'installed') return null
  const session = await readOpenSession(caller, sid, maxAge)
  if (!session || session.user_id !== userId) return null
  let context: StrictSessionContext
  try {
    context = store.parseStrictSessionContext(session.external_auth_context)
  } catch (error) {
    if (isRecord(error) && error.code === 'STRICT_LOGIN_GRANT_INPUT_REFUSED') return null
    throw error
  }
  if (context.orgId !== tenantId) return null
  const grantRows = await queryRows(
    caller,
    `${GRANT_JOIN}
      WHERE grant_row.id = $1
        AND grant_row.local_user_id = $2
        AND grant_row.enabled = true
        AND grant_row.revoked_at IS NULL`,
    [context.grantId, userId],
  )
  if (grantRows.length !== 1) return null
  const row = grantRows[0]
  if (!contextAgrees(context, row)) return null
  if (!await existingGrantRemainsEligible(caller, row)) return null
  return { context, row, sid }
}

export async function verifyPersistedStrictSession(
  caller: QueryCaller,
  payload: unknown,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<StrictSessionPrincipal | null> {
  const continued = await continueAuthorized(caller, payload, env)
  if (!continued) return null
  return principalFrom(continued.row)
}

async function rewriteExpiry(
  caller: QueryCaller,
  sid: string,
  user: StrictSessionPrincipal,
  maxAge: number,
  exp: number,
  ipAddress: string | null,
  userAgent: string | null,
): Promise<boolean> {
  const updated = await queryRows(
    caller,
    `UPDATE user_sessions
        SET expires_at = LEAST(
              issued_at + make_interval(secs => $2::int),
              to_timestamp($3::double precision)
            ),
            last_seen_at = clock_timestamp(),
            updated_at = clock_timestamp(),
            ip_address = COALESCE($4, ip_address),
            user_agent = COALESCE($5, user_agent)
      WHERE id = $1
        AND user_id = $6
        AND revoked_at IS NULL
        AND expires_at > clock_timestamp()
        AND issued_at + make_interval(secs => $2::int) > clock_timestamp()
      RETURNING id`,
    [sid, maxAge, exp, ipAddress, userAgent, user.id],
  )
  return updated.length === 1
}

export async function refreshStrictSession(
  input: StrictSessionContinueInput,
): Promise<{ token: string; user: StrictSessionPrincipal } | null> {
  const env = input.env ?? process.env
  const continued = await continueAuthorized(input.caller, input.payload, env)
  if (!continued) return null
  const maxAge = readConfiguredStrictSessionMaxAgeSeconds(env)
  if (maxAge == null) return null
  const user = principalFrom(continued.row)
  const token = input.createToken(user, { sid: continued.sid, externalAuth: true })
  const exp = input.readExp(token)
  if (exp == null) refuse('STRICT_SESSION_NOT_CURRENT', 401)
  const wrote = await rewriteExpiry(input.caller, continued.sid, user, maxAge, exp, input.ipAddress ?? null, input.userAgent ?? null)
  if (!wrote) return null
  return { token, user }
}

export async function switchStrictSessionOrg(
  input: StrictSessionSwitchInput,
): Promise<{ token: string; user: StrictSessionPrincipal } | null> {
  if (typeof input.orgId !== 'string' || input.orgId.length === 0 || input.orgId.trim() !== input.orgId) {
    refuse('STRICT_LOGIN_INPUT_REFUSED', 400)
  }
  const env = input.env ?? process.env
  const continued = await continueAuthorized(input.caller, input.payload, env)
  if (!continued) return null
  if (input.orgId !== continued.context.orgId) refuse('SESSION_ORG_NOT_MEMBER', 403)
  const maxAge = readConfiguredStrictSessionMaxAgeSeconds(env)
  if (maxAge == null) return null
  const user = principalFrom(continued.row)
  const token = input.createToken(user, { sid: continued.sid, externalAuth: true })
  const exp = input.readExp(token)
  if (exp == null) refuse('STRICT_SESSION_NOT_CURRENT', 401)
  const wrote = await rewriteExpiry(input.caller, continued.sid, user, maxAge, exp, input.ipAddress ?? null, input.userAgent ?? null)
  if (!wrote) return null
  return { token, user }
}

function capturedSignInRequest(input: Omit<StrictDingTalkSignInInput, 'createToken' | 'readExp' | 'readIssuedAt' | 'transaction'>): Pick<StrictDingTalkSignInInput, 'code' | 'selector' | 'transport' | 'env' | 'ipAddress' | 'userAgent'> {
  const transport = input.transport
  return {
    code: input.code,
    selector: input.selector,
    env: input.env,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
    transport: transport
      ? {
          fetchFn: transport.fetchFn,
          timeoutMs: transport.timeoutMs,
          signal: transport.signal,
        }
      : undefined,
  }
}

export async function bindStrictDingTalkEntryLocal(options: {
  fetchFn?: typeof fetch
  transaction?: AuthorizationInputTransactionRunner
  env?: Readonly<Record<string, string | undefined>>
} = {}): Promise<StrictDingTalkLocalBinding> {
  const auth = await import('./AuthService')
  const createToken: StrictTokenMinter = (user, tokenOptions) => auth.authService.createToken(user, tokenOptions)
  const readExp: StrictTokenExpReader = (token) => {
    const exp = auth.authService.readTokenPayload(token)?.exp
    return typeof exp === 'number' ? exp : null
  }
  const readIssuedAt: StrictTokenExpReader = (token) => {
    const issuedAt = auth.authService.readTokenPayload(token)?.iat
    return typeof issuedAt === 'number' ? issuedAt : null
  }
  const signInBound = (
    kind: 'web' | 'container',
    input: Omit<StrictDingTalkSignInInput, 'createToken' | 'readExp' | 'readIssuedAt' | 'transaction'>,
  ) => {
    const request = capturedSignInRequest(input)
    const call = kind === 'web' ? signInStrictDingTalkWeb : signInStrictDingTalkContainer
    return call({
      ...request,
      transport: {
        fetchFn: request.transport?.fetchFn ?? options.fetchFn,
        timeoutMs: request.transport?.timeoutMs,
        signal: request.transport?.signal,
      },
      env: request.env ?? options.env,
      transaction: options.transaction,
      createToken,
      readExp,
      readIssuedAt,
    })
  }
  return {
    gates: STRICT_DINGTALK_ENTRY_GATES,
    currentStrictGrantUsable,
    signInWeb: (input) => signInBound('web', input),
    signInContainer: (input) => signInBound('container', input),
    verifyPersistedStrictSession,
    refreshStrictSession: (input) => refreshStrictSession({ ...input, createToken, readExp, env: input.env ?? options.env }),
    switchStrictSessionOrg: (input) => switchStrictSessionOrg({ ...input, createToken, readExp, env: input.env ?? options.env }),
  }
}
