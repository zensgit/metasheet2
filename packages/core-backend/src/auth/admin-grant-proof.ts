import { randomBytes, randomUUID } from 'node:crypto'
import { encodeAdminGrantIntent, normalizeAdminGrantIntent, AdminGrantIntentError } from './admin-login-grant-intent'
import type { AdminGrantIntent } from './admin-login-grant-intent'
import {
  AdminGrantReceivingRefusal,
  assertPreparedAdminGrantConsume,
  resolveAdminGrantTargetSet,
} from './admin-grant-receiving-reader'
import type { AdminGrantActorPrivilegeExpectation, AdminGrantPreparedSnapshot } from './admin-grant-receiving-reader'
import { discoverPrivilegeRolePlan, revalidatePrivilegeRolePlan } from '../rbac/authorization-privilege-witness-plan'
import type { PrivilegeRolePlan } from '../rbac/authorization-privilege-witness-plan'
import type { AuthorizationInputTx } from '../rbac/authorization-input-lock'
import { AuthorizationInputContractError, AuthorizationInputTokenRejectedError } from '../rbac/authorization-input-brand'
import { assertAuthorizationInputTx } from '../rbac/authorization-input-brand'
import { query as dbQuery } from '../db/pg'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { PlatformActorAuthorityLost, assertPlatformActorAuthority } from '../admin/platform-actor-authority'
import {
  AdminGrantActorInputError,
  readAdminGrantLocalCredential,
  resolveAdminGrantInstallSchema,
} from './admin-grant-local-credential'
import {
  adminGrantBrowserBindingDigest,
  adminGrantBrowserStatements,
  assertAdminGrantBrowserContext,
  createAdminGrantBrowserContext,
} from './admin-grant-browser-context'
import type { AdminGrantBrowserContext, AdminGrantBrowserService } from './admin-grant-browser-context'
import { assessSecurityActionPrivilege, PrivilegeInputsUnavailableError } from './security-action-privilege'
import { evaluateUserAuthenticationGate } from './user-activation'
import { runOwnedAttempt } from './security-action-attempt-admission'
import type { AdminGrantOwnedSteps } from './security-action-attempt-admission'
import {
  assertAuthenticatedSessionContext,
  computeCredentialWitness,
  SECURITY_ACTION_FAILURE_LIMIT,
  SECURITY_ACTION_FAILURE_WINDOW_SECONDS,
  SECURITY_ACTION_SQL,
  SecurityActionProofError,
} from './security-action-proof'
import type { AuthenticatedSessionContext } from './security-action-proof'
import {
  adminGrantCommandActionRef,
  adminGrantDigestEqual,
  adminGrantIntentDigest,
  consumeAdminGrantProof,
  hashAdminGrantProofSecret,
  insertFailedAdminGrantProof,
  insertIssuedAdminGrantProofSet,
  lockAdminGrantProof,
  parseAdminGrantProof,
  readAdminGrantProofChildren,
  readAdminGrantProofHeader,
  readAdminGrantProofSeal,
  supersedeIssuedAdminGrantProof,
  AdminGrantProofStorageError,
} from './admin-grant-proof-storage'
import type { AdminGrantPrivilegeClass, AdminGrantProofChildWrite } from './admin-grant-proof-storage'

declare const preparedAdminGrantProofBrand: unique symbol
declare const consumedAdminGrantProofBrand: unique symbol

export type AdminGrantIssueInput = Readonly<{
  intent: AdminGrantIntent
  method: 'local_password'
  password: string
}>

export type IssuedAdminGrantProof = Readonly<{
  proof: string
  purpose: 'admin_login_grant_enable'
  commandId: string
  intentDigest: string
  targetCount: number
  method: 'local_password'
  assurance: 'local_password'
  expiresAt: string
  ttlSeconds: 300
}>

export type AdminGrantConsumeInput = Readonly<{
  intent: AdminGrantIntent
  proof: string
}>

export type PreparedAdminGrantProof = Readonly<{
  intent: AdminGrantIntent
  intentDigest: string
  actorPrivilege: AdminGrantActorPrivilegeExpectation
  privilegePlan: PrivilegeRolePlan
  readonly [preparedAdminGrantProofBrand]: true
}>

export type ConsumedAdminGrantProof = Readonly<{
  proofId: string
  commandId: string
  intentDigest: string
  targetCount: number
  receiving: AdminGrantPreparedSnapshot
  readonly [consumedAdminGrantProofBrand]: true
}>

export type AdminGrantProofErrorCode =
  | 'ADMIN_GRANT_SESSION_REQUIRED'
  | 'ADMIN_GRANT_ORIGIN_REJECTED'
  | 'ADMIN_GRANT_INVALID_REQUEST'
  | 'ADMIN_GRANT_PROOF_INVALID'
  | 'ADMIN_GRANT_CREDENTIAL_REJECTED'
  | 'ADMIN_GRANT_RATE_LIMITED'
  | 'ADMIN_GRANT_UNAVAILABLE'

export type AdminGrantProofContractCode =
  | 'ADMIN_GRANT_TRANSACTION_REQUIRED'
  | 'ADMIN_GRANT_CONTEXT_REQUIRED'
  | 'ADMIN_GRANT_INPUT_SHAPE'
  | 'ADMIN_GRANT_ORIGIN_INVALID'
  | 'ADMIN_GRANT_SESSION_ASSERTION_UNRELEASED'
  | 'ADMIN_GRANT_ATTEMPT_VARIANT_UNRELEASED'
  | 'ADMIN_GRANT_ACTOR_INPUTS_UNRELEASED'
  | 'ADMIN_GRANT_CONSUME_BRAND'

const ERROR_STATUS: Readonly<Record<AdminGrantProofErrorCode, number>> = Object.freeze({
  ADMIN_GRANT_SESSION_REQUIRED: 401,
  ADMIN_GRANT_ORIGIN_REJECTED: 403,
  ADMIN_GRANT_INVALID_REQUEST: 422,
  ADMIN_GRANT_PROOF_INVALID: 403,
  ADMIN_GRANT_CREDENTIAL_REJECTED: 403,
  ADMIN_GRANT_RATE_LIMITED: 429,
  ADMIN_GRANT_UNAVAILABLE: 503,
})

export class AdminGrantProofError extends Error {
  readonly status: number
  readonly code: AdminGrantProofErrorCode
  readonly retryAfter?: number

  constructor(code: AdminGrantProofErrorCode, retryAfter?: number) {
    super('Admin grant proof refused')
    this.name = 'AdminGrantProofError'
    this.code = code
    this.status = ERROR_STATUS[code]
    if (typeof retryAfter === 'number' && Number.isSafeInteger(retryAfter) && retryAfter > 0) {
      this.retryAfter = retryAfter
    }
  }
}

export class AdminGrantProofContractError extends Error {
  readonly code: AdminGrantProofContractCode

  constructor(code: AdminGrantProofContractCode) {
    super('Admin grant proof API contract violated')
    this.name = 'AdminGrantProofContractError'
    this.code = code
  }
}

export type AdminGrantProofService = Readonly<{
  issue(context: AuthenticatedSessionContext, input: AdminGrantIssueInput): Promise<IssuedAdminGrantProof>
  prepareConsume(context: AuthenticatedSessionContext, input: AdminGrantConsumeInput): Promise<PreparedAdminGrantProof>
  consumeOnTx(
    tx: AuthorizationInputTx,
    context: AuthenticatedSessionContext,
    prepared: PreparedAdminGrantProof,
  ): Promise<ConsumedAdminGrantProof>
  assertConsumedOnTx(
    result: ConsumedAdminGrantProof,
    tx: AuthorizationInputTx,
    context: AuthenticatedSessionContext,
    intent: AdminGrantIntent,
  ): void
}>

export type AdminGrantProofServiceOptions = Readonly<{ publicOrigin: string }>

const ISSUE_FIELDS = ['intent', 'method', 'password'] as const
const CONSUME_FIELDS = ['intent', 'proof'] as const
const OPTION_FIELDS = ['publicOrigin'] as const

type ConsumedBinding = Readonly<{
  tx: AuthorizationInputTx
  session: AuthenticatedSessionContext
  browser: AdminGrantBrowserContext
  origin: string
  receiving: AdminGrantPreparedSnapshot
  privilegePlan: PrivilegeRolePlan
  actorPrivilege: AdminGrantActorPrivilegeExpectation
  intent: AdminGrantIntent
}>

const consumedBindings = new WeakMap<object, ConsumedBinding>()
const retainedBrowsers = new WeakMap<object, AdminGrantBrowserContext>()

type PreparedBinding = Readonly<{
  intent: AdminGrantIntent
  intentDigest: string
  actorPrivilege: AdminGrantActorPrivilegeExpectation
  privilegePlan: PrivilegeRolePlan
  proofId: string
  browser: AdminGrantBrowserContext
  session: AuthenticatedSessionContext
}>

const preparedBindings = new WeakMap<object, PreparedBinding>()

const reads = {
  query: (sql: string, params?: unknown[]) => dbQuery(sql, params),
}

function invalid(): never {
  throw new AdminGrantProofContractError('ADMIN_GRANT_INPUT_SHAPE')
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

function closedRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) invalid()
  let prototype: unknown
  try {
    prototype = Object.getPrototypeOf(value)
  } catch {
    invalid()
  }
  if (prototype !== Object.prototype && prototype !== null) invalid()
  let descriptors: PropertyDescriptorMap
  try {
    descriptors = Object.getOwnPropertyDescriptors(value)
  } catch {
    invalid()
  }
  let keys: PropertyKey[]
  try {
    keys = Reflect.ownKeys(descriptors)
  } catch {
    invalid()
  }
  if (keys.length !== fields.length) invalid()
  const record: Record<string, unknown> = {}
  for (const field of fields) {
    let outer: PropertyDescriptor | undefined
    try {
      outer = Object.getOwnPropertyDescriptor(descriptors, field)
    } catch {
      invalid()
    }
    const descriptor = outer?.value as PropertyDescriptor | undefined
    if (!descriptor || !('value' in descriptor)) invalid()
    record[field] = descriptor.value
  }
  return record
}

function capturePassword(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000') || hasUnpairedSurrogate(value)) invalid()
  return value
}

function captureIntent(value: unknown): AdminGrantIntent {
  try {
    return normalizeAdminGrantIntent(value)
  } catch {
    invalid()
  }
}

export function captureAdminGrantIssueInput(value: unknown): AdminGrantIssueInput {
  const record = closedRecord(value, ISSUE_FIELDS)
  if (record.method !== 'local_password') invalid()
  return Object.freeze({
    intent: captureIntent(record.intent),
    method: 'local_password',
    password: capturePassword(record.password),
  })
}

export function captureAdminGrantConsumeInput(value: unknown): AdminGrantConsumeInput {
  const record = closedRecord(value, CONSUME_FIELDS)
  const proof = record.proof
  if (typeof proof !== 'string' || parseAdminGrantProof(proof) === null) invalid()
  return Object.freeze({
    intent: captureIntent(record.intent),
    proof,
  })
}

export function canonicalAdminGrantOrigin(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\u0000') || hasUnpairedSurrogate(value)) {
    throw new AdminGrantProofContractError('ADMIN_GRANT_ORIGIN_INVALID')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new AdminGrantProofContractError('ADMIN_GRANT_ORIGIN_INVALID')
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new AdminGrantProofContractError('ADMIN_GRANT_ORIGIN_INVALID')
  }
  if (url.search !== '' || url.hash !== '' || (url.pathname !== '' && url.pathname !== '/')) {
    throw new AdminGrantProofContractError('ADMIN_GRANT_ORIGIN_INVALID')
  }
  if (value !== url.origin) throw new AdminGrantProofContractError('ADMIN_GRANT_ORIGIN_INVALID')
  return url.origin
}

function requireSession(context: unknown): AuthenticatedSessionContext {
  assertAuthenticatedSessionContext(context)
  return context
}

export function retainAdminGrantBrowserContext(
  publicOrigin: string,
  session: AuthenticatedSessionContext,
  browser: AdminGrantBrowserContext,
): void {
  const origin = canonicalAdminGrantOrigin(publicOrigin)
  const current = requireSession(session)
  assertAdminGrantBrowserContext(browser, origin)
  if (browser.session !== current) throw new AdminGrantProofContractError('ADMIN_GRANT_CONTEXT_REQUIRED')
  retainedBrowsers.set(current, browser)
}

function retainedBrowser(session: AuthenticatedSessionContext, publicOrigin: string): AdminGrantBrowserContext {
  const browser = retainedBrowsers.get(session)
  if (!browser) throw new AdminGrantProofContractError('ADMIN_GRANT_CONTEXT_REQUIRED')
  assertAdminGrantBrowserContext(browser, publicOrigin)
  if (browser.session !== session || browser.tokenIssuedAt !== session.tokenIssuedAt) {
    throw new AdminGrantProofContractError('ADMIN_GRANT_CONTEXT_REQUIRED')
  }
  return browser
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

const SIX_DIGIT_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/

function proofInvalid(): never {
  throw new AdminGrantProofError('ADMIN_GRANT_PROOF_INVALID')
}

function unavailable(): never {
  throw new AdminGrantProofError('ADMIN_GRANT_UNAVAILABLE')
}

function asRows(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { rows?: unknown }).rows)) unavailable()
  return (value as { rows: Array<Record<string, unknown>> }).rows
}

function canonicalStoredIntent(canonical: string, presented: AdminGrantIntent): AdminGrantIntent {
  let parsed: unknown
  try {
    parsed = JSON.parse(canonical)
  } catch {
    proofInvalid()
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) proofInvalid()
  const record = parsed as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(record, 'targetCount')) proofInvalid()
  const targetCount = record.targetCount
  const rest: Record<string, unknown> = {}
  for (const key of Object.keys(record)) {
    if (key !== 'targetCount') rest[key] = record[key]
  }
  let normalized: AdminGrantIntent
  try {
    normalized = normalizeAdminGrantIntent(rest)
  } catch (error) {
    if (error instanceof AdminGrantIntentError) proofInvalid()
    throw error
  }
  if (targetCount !== normalized.targets.length) proofInvalid()
  if (encodeAdminGrantIntent(normalized) !== canonical) proofInvalid()
  if (!sameIntent(normalized, presented)) proofInvalid()
  return normalized
}

async function readAccount(tx: AuthorizationInputTx, userId: string): Promise<{
  passwordHash: string
  localPasswordSet: boolean
  mustChangePassword: boolean
  activationStatus: string
  isActive: boolean
  role: string | null
  deletedAt: string | null
  purgedAt: string | null
  accessGeneration: string
}> {
  const result = await tx.query(
    `SELECT password_hash, local_password_set, must_change_password, activation_status, is_active, role,
            deleted_at::text AS deleted_at, purged_at::text AS purged_at, access_generation::text AS access_generation
       FROM users
      WHERE id = $1`,
    [userId],
  )
  const rows = asRows(result)
  const row = rows[0]
  if (rows.length !== 1 || !row) proofInvalid()
  if (typeof row.password_hash !== 'string'
    || typeof row.local_password_set !== 'boolean'
    || typeof row.must_change_password !== 'boolean'
    || typeof row.activation_status !== 'string'
    || typeof row.is_active !== 'boolean'
    || typeof row.access_generation !== 'string') proofInvalid()
  return {
    passwordHash: row.password_hash,
    localPasswordSet: row.local_password_set,
    mustChangePassword: row.must_change_password,
    activationStatus: row.activation_status,
    isActive: row.is_active,
    role: typeof row.role === 'string' ? row.role : null,
    deletedAt: typeof row.deleted_at === 'string' ? row.deleted_at : null,
    purgedAt: typeof row.purged_at === 'string' ? row.purged_at : null,
    accessGeneration: row.access_generation,
  }
}

function sameIntent(left: AdminGrantIntent, right: AdminGrantIntent): boolean {
  if (left.purpose !== right.purpose || left.commandId !== right.commandId || left.actorId !== right.actorId
    || left.orgId !== right.orgId || left.provider !== right.provider || left.connectionId !== right.connectionId
    || left.applicationRevision !== right.applicationRevision || left.targets.length !== right.targets.length) return false
  return left.targets.every((target, index) => {
    const other = right.targets[index]
    return other !== undefined
      && target.userId === other.userId
      && target.identityId === other.identityId
      && target.bindingRevision === other.bindingRevision
      && target.evidenceId === other.evidenceId
      && target.evidenceWitness === other.evidenceWitness
      && target.accessGeneration === other.accessGeneration
      && target.privilegeWitness === other.privilegeWitness
  })
}

type IssueSnapshot = Readonly<{
  passwordHash: string
  accessGeneration: string
  credentialWitness: string
  privilegeWitness: string
  privilegeClass: AdminGrantPrivilegeClass
  targetWitness: string
  browserBindingId: string
  nonceDigest: string
  origin: string
  tokenIssuedAt: number
  watermarkUs: string
  sessionExpiresAt: string
  browserExpiresAt: string
  credentialEstablishmentId: string
  credentialVersion: string
  orgId: string
  connectionId: string
  sessionId: string
  userId: string
  canonicalIntent: string
  commandId: string
  applicationRevision: string
  children: readonly AdminGrantProofChildWrite[]
}>

type IssueOutcome =
  | Readonly<{ kind: 'issued'; proof: string; expiresAt: string; intentDigest: string; targetCount: number }>
  | Readonly<{ kind: 'rejected' }>

function asQueryable(tx: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }> }): Queryable {
  return {
    query: async (sql: string, params?: unknown[]) => {
      const result = await tx.query(sql, params)
      return { rows: result.rows, rowCount: result.rowCount ?? null }
    },
  }
}

function attemptRows(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { rows?: unknown }).rows)) {
    throw new SecurityActionProofError('SECURITY_ACTION_UNAVAILABLE')
  }
  return (value as { rows: Array<Record<string, unknown>> }).rows
}

function asAttemptRefusal(error: unknown): never {
  if (error instanceof SecurityActionProofError) throw error
  if (error instanceof PlatformActorAuthorityLost
    || error instanceof AdminGrantReceivingRefusal
    || error instanceof AdminGrantIntentError
    || error instanceof AuthorizationInputContractError) {
    throw new SecurityActionProofError('SECURITY_ACTION_STATE_CHANGED')
  }
  if (error instanceof AdminGrantActorInputError) {
    if (error.code === 'ADMIN_GRANT_CREDENTIAL_INELIGIBLE') {
      throw new SecurityActionProofError('SECURITY_ACTION_METHOD_UNAVAILABLE')
    }
    if (error.code === 'ADMIN_GRANT_BROWSER_SESSION_STALE') {
      throw new SecurityActionProofError('SECURITY_ACTION_SESSION_REQUIRED')
    }
    if (error.code === 'ADMIN_GRANT_BROWSER_UNAVAILABLE' || error.code === 'ADMIN_GRANT_CREDENTIAL_UNAVAILABLE') {
      throw new SecurityActionProofError('SECURITY_ACTION_UNAVAILABLE')
    }
    throw new SecurityActionProofError('SECURITY_ACTION_STATE_CHANGED')
  }
  if (error instanceof PrivilegeInputsUnavailableError
    || error instanceof AdminGrantProofStorageError
    || error instanceof AdminGrantProofError
    || error instanceof AuthorizationInputTokenRejectedError) {
    throw new SecurityActionProofError('SECURITY_ACTION_UNAVAILABLE')
  }
  throw new SecurityActionProofError('SECURITY_ACTION_UNAVAILABLE')
}

function mapAttemptError(error: unknown): never {
  if (error instanceof SecurityActionProofError) {
    if (error.code === 'SECURITY_ACTION_RATE_LIMITED') {
      const retryAfter = error.details?.retryAfter
      if (typeof retryAfter === 'number' && Number.isSafeInteger(retryAfter) && retryAfter > 0) {
        throw new AdminGrantProofError('ADMIN_GRANT_RATE_LIMITED', retryAfter)
      }
      throw new AdminGrantProofError('ADMIN_GRANT_UNAVAILABLE')
    }
    if (error.code === 'SECURITY_ACTION_STATE_CHANGED' || error.code === 'SECURITY_ACTION_METHOD_UNAVAILABLE') {
      throw new AdminGrantProofError('ADMIN_GRANT_PROOF_INVALID')
    }
    if (error.code === 'SECURITY_ACTION_SESSION_REQUIRED') {
      throw new AdminGrantProofError('ADMIN_GRANT_SESSION_REQUIRED')
    }
    throw new AdminGrantProofError('ADMIN_GRANT_UNAVAILABLE')
  }
  throw new AdminGrantProofError('ADMIN_GRANT_UNAVAILABLE')
}

async function countedFailures(executor: Queryable, userId: string): Promise<{ failures: number; retryAfter: number }> {
  const result = await executor.query(SECURITY_ACTION_SQL.failureCount, [userId])
  const rows = result?.rows
  if (!Array.isArray(rows) || rows.length !== 1) throw new SecurityActionProofError('SECURITY_ACTION_UNAVAILABLE')
  const failures = Number(rows[0]?.failures)
  if (!Number.isSafeInteger(failures) || failures < 0) throw new SecurityActionProofError('SECURITY_ACTION_UNAVAILABLE')
  const retryAfterRaw = Number(rows[0]?.retry_after)
  const retryAfter = Number.isSafeInteger(retryAfterRaw) && retryAfterRaw > 0
    ? Math.min(retryAfterRaw, SECURITY_ACTION_FAILURE_WINDOW_SECONDS)
    : SECURITY_ACTION_FAILURE_WINDOW_SECONDS
  return { failures, retryAfter }
}

async function refuseWhenLimited(executor: Queryable, userId: string): Promise<void> {
  const budget = await countedFailures(executor, userId)
  if (budget.failures >= SECURITY_ACTION_FAILURE_LIMIT) {
    throw new SecurityActionProofError('SECURITY_ACTION_RATE_LIMITED', { retryAfter: budget.retryAfter })
  }
}

async function readEligibleAccount(tx: AuthorizationInputTx, userId: string): Promise<{
  passwordHash: string
  localPasswordSet: boolean
  mustChangePassword: boolean
  activationStatus: string
  isActive: boolean
  role: string | null
  deletedAt: string | null
  purgedAt: string | null
  accessGeneration: string
}> {
  const rows = attemptRows(await tx.query(
    `SELECT password_hash, local_password_set, must_change_password, activation_status, is_active, role,
            deleted_at::text AS deleted_at, purged_at::text AS purged_at, access_generation::text AS access_generation
       FROM users
      WHERE id = $1`,
    [userId],
  ))
  const row = rows[0]
  if (rows.length !== 1 || !row
    || typeof row.password_hash !== 'string'
    || typeof row.local_password_set !== 'boolean'
    || typeof row.must_change_password !== 'boolean'
    || typeof row.activation_status !== 'string'
    || typeof row.is_active !== 'boolean'
    || typeof row.access_generation !== 'string') {
    throw new SecurityActionProofError('SECURITY_ACTION_STATE_CHANGED')
  }
  return {
    passwordHash: row.password_hash,
    localPasswordSet: row.local_password_set,
    mustChangePassword: row.must_change_password,
    activationStatus: row.activation_status,
    isActive: row.is_active,
    role: typeof row.role === 'string' ? row.role : null,
    deletedAt: typeof row.deleted_at === 'string' ? row.deleted_at : null,
    purgedAt: typeof row.purged_at === 'string' ? row.purged_at : null,
    accessGeneration: row.access_generation,
  }
}

function snapshotsAgree(left: IssueSnapshot, right: IssueSnapshot): boolean {
  if (left.passwordHash !== right.passwordHash
    || left.accessGeneration !== right.accessGeneration
    || left.credentialWitness !== right.credentialWitness
    || left.privilegeWitness !== right.privilegeWitness
    || left.privilegeClass !== right.privilegeClass
    || left.targetWitness !== right.targetWitness
    || left.browserBindingId !== right.browserBindingId
    || left.nonceDigest !== right.nonceDigest
    || left.origin !== right.origin
    || left.tokenIssuedAt !== right.tokenIssuedAt
    || left.watermarkUs !== right.watermarkUs
    || left.sessionExpiresAt !== right.sessionExpiresAt
    || left.browserExpiresAt !== right.browserExpiresAt
    || left.credentialEstablishmentId !== right.credentialEstablishmentId
    || left.credentialVersion !== right.credentialVersion
    || left.orgId !== right.orgId
    || left.connectionId !== right.connectionId
    || left.sessionId !== right.sessionId
    || left.userId !== right.userId
    || left.canonicalIntent !== right.canonicalIntent
    || left.commandId !== right.commandId
    || left.applicationRevision !== right.applicationRevision
    || left.children.length !== right.children.length) return false
  return left.children.every((child, index) => {
    const other = right.children[index]
    return other !== undefined
      && child.ordinal === other.ordinal
      && child.userId === other.userId
      && child.identityId === other.identityId
      && child.bindingRevision === other.bindingRevision
      && child.evidenceId === other.evidenceId
      && child.evidenceWitness === other.evidenceWitness
      && child.accessGeneration === other.accessGeneration
      && child.privilegeWitness === other.privilegeWitness
  })
}

async function readIssueSnapshot(
  tx: AuthorizationInputTx,
  session: AuthenticatedSessionContext,
  browser: AdminGrantBrowserContext,
  intent: AdminGrantIntent,
  privilegePlan: PrivilegeRolePlan,
  canonicalIntent: string,
  origin: string,
  browserService: AdminGrantBrowserService,
  enforceBudget: boolean,
): Promise<IssueSnapshot> {
  const userIds = [intent.actorId, ...intent.targets.map((target) => target.userId)].sort(compareCodeUnits)
  tx.requireUserRows(userIds)
  await assertPlatformActorAuthority(tx, tx.locked.get(intent.actorId))
  for (const userId of userIds) {
    const membership = attemptRows(await tx.query(
      `SELECT user_id FROM user_orgs WHERE user_id = $1 AND org_id = $2 AND is_active IS TRUE FOR SHARE`,
      [userId, intent.orgId],
    ))
    if (membership.length !== 1 || membership[0]?.user_id !== userId) {
      throw new SecurityActionProofError('SECURITY_ACTION_STATE_CHANGED')
    }
  }
  tx.requireIdentityRead([intent.connectionId])
  await revalidatePrivilegeRolePlan(tx, privilegePlan)
  const executor = asQueryable(tx)
  const assessment = await assessSecurityActionPrivilege(executor, intent.actorId)
  if (assessment.privilegeClass !== 'standard' && assessment.privilegeClass !== 'high') {
    throw new SecurityActionProofError('SECURITY_ACTION_UNAVAILABLE')
  }
  const actorPrivilege = Object.freeze({
    userId: intent.actorId,
    orgId: intent.orgId,
    privilegeWitness: assessment.witness,
  })
  const receiving = await resolveAdminGrantTargetSet(tx, Object.freeze({
    client: tx,
    privilegePlan,
    actorPrivilege,
  }), intent, 'issue')
  if (receiving.actor.privilegeWitness !== assessment.witness || receiving.actor.privilegeClass !== assessment.privilegeClass) {
    throw new SecurityActionProofError('SECURITY_ACTION_STATE_CHANGED')
  }
  if (receiving.targets.length !== intent.targets.length
    || receiving.targets.some((target, index) => target.userId !== intent.targets[index]?.userId || target.privilegeClass !== 'standard')) {
    throw new SecurityActionProofError('SECURITY_ACTION_STATE_CHANGED')
  }
  const schema = await resolveAdminGrantInstallSchema(executor, 'ADMIN_GRANT_BROWSER_UNAVAILABLE')
  const statements = adminGrantBrowserStatements(schema)
  for (const userId of userIds) {
    const watermark = attemptRows(await tx.query(statements.lockWatermark, [userId]))
    if (watermark.length !== 1) throw new SecurityActionProofError('SECURITY_ACTION_STATE_CHANGED')
  }
  const sessionRows = attemptRows(await tx.query(statements.lockSession, [session.sessionId]))
  const sessionRow = sessionRows[0]
  if (sessionRows.length !== 1 || !sessionRow || sessionRow.user_id !== session.userId || sessionRow.live !== true) {
    throw new SecurityActionProofError('SECURITY_ACTION_SESSION_REQUIRED')
  }
  const bindingRows = attemptRows(await tx.query(statements.lockBinding, [session.sessionId]))
  if (bindingRows.length !== 1 || bindingRows[0]?.binding_id !== browser.bindingId) {
    throw new SecurityActionProofError('SECURITY_ACTION_STATE_CHANGED')
  }
  const witness = await browserService.assertCurrent(executor, browser)
  if (witness.bindingId !== browser.bindingId
    || witness.userId !== session.userId
    || witness.sessionId !== session.sessionId
    || witness.orgId !== intent.orgId
    || witness.origin !== origin
    || witness.nonceDigest !== browser.nonceDigest
    || witness.tokenIssuedAt !== session.tokenIssuedAt
    || !SIX_DIGIT_UTC.test(witness.sessionExpiresAt)
    || !SIX_DIGIT_UTC.test(witness.bindingExpiresAt)) {
    throw new SecurityActionProofError('SECURITY_ACTION_STATE_CHANGED')
  }
  const credential = await readAdminGrantLocalCredential(executor, session)
  const account = await readEligibleAccount(tx, session.userId)
  if (!account.localPasswordSet || account.mustChangePassword || account.passwordHash.length === 0) {
    throw new SecurityActionProofError('SECURITY_ACTION_METHOD_UNAVAILABLE')
  }
  if (evaluateUserAuthenticationGate({
    deleted_at: account.deletedAt,
    purged_at: account.purgedAt,
    role: account.role,
    is_active: account.isActive,
    activation_status: account.activationStatus,
    local_password_set: account.localPasswordSet,
  }, { requireLocalPassword: true })) {
    throw new SecurityActionProofError('SECURITY_ACTION_SESSION_REQUIRED')
  }
  const credentialWitness = computeCredentialWitness(account)
  const targetWitness = adminGrantIntentDigest(canonicalIntent)
  if (enforceBudget) await refuseWhenLimited(executor, session.userId)
  const children = intent.targets.map((target, index) => Object.freeze({
    ordinal: index + 1,
    userId: target.userId,
    identityId: target.identityId,
    bindingRevision: target.bindingRevision,
    evidenceId: target.evidenceId,
    evidenceWitness: target.evidenceWitness,
    accessGeneration: target.accessGeneration,
    privilegeWitness: target.privilegeWitness,
  }))
  return Object.freeze({
    passwordHash: account.passwordHash,
    accessGeneration: account.accessGeneration,
    credentialWitness,
    privilegeWitness: assessment.witness,
    privilegeClass: assessment.privilegeClass,
    targetWitness,
    browserBindingId: witness.bindingId,
    nonceDigest: witness.nonceDigest,
    origin: witness.origin,
    tokenIssuedAt: witness.tokenIssuedAt,
    watermarkUs: witness.watermarkUs,
    sessionExpiresAt: witness.sessionExpiresAt,
    browserExpiresAt: witness.bindingExpiresAt,
    credentialEstablishmentId: credential.establishmentId,
    credentialVersion: credential.credentialVersion,
    orgId: intent.orgId,
    connectionId: intent.connectionId,
    sessionId: session.sessionId,
    userId: session.userId,
    canonicalIntent,
    commandId: intent.commandId,
    applicationRevision: intent.applicationRevision,
    children,
  })
}

async function accountRejected(tx: Queryable, first: IssueSnapshot): Promise<void> {
  await tx.query(SECURITY_ACTION_SQL.setReadCommitted)
  await tx.query(SECURITY_ACTION_SQL.advisoryLock, [`security-action:${first.userId}`])
  const locked = await tx.query(SECURITY_ACTION_SQL.userKeyShare, [first.userId])
  if (!Array.isArray(locked.rows) || locked.rows.length !== 1) {
    throw new SecurityActionProofError('SECURITY_ACTION_UNAVAILABLE')
  }
  await refuseWhenLimited(tx, first.userId)
  await insertFailedAdminGrantProof(tx, {
    id: randomUUID(),
    userId: first.userId,
    sessionId: first.sessionId,
    orgId: first.orgId,
    connectionId: first.connectionId,
    targetWitness: first.targetWitness,
    accessGeneration: first.accessGeneration,
    credentialWitness: first.credentialWitness,
    privilegeWitness: first.privilegeWitness,
    privilegeClass: first.privilegeClass,
  })
}

async function issueVerified(
  tx: AuthorizationInputTx,
  session: AuthenticatedSessionContext,
  browser: AdminGrantBrowserContext,
  intent: AdminGrantIntent,
  privilegePlan: PrivilegeRolePlan,
  canonicalIntent: string,
  origin: string,
  browserService: AdminGrantBrowserService,
  first: IssueSnapshot,
): Promise<IssueOutcome> {
  const second = await readIssueSnapshot(tx, session, browser, intent, privilegePlan, canonicalIntent, origin, browserService, false)
  if (!snapshotsAgree(first, second)) throw new SecurityActionProofError('SECURITY_ACTION_STATE_CHANGED')
  const executor = asQueryable(tx)
  await refuseWhenLimited(executor, session.userId)
  const secret = randomBytes(32).toString('base64url')
  const id = randomUUID()
  const proofHash = hashAdminGrantProofSecret(secret)
  if (!proofHash) throw new SecurityActionProofError('SECURITY_ACTION_UNAVAILABLE')
  const clientBindingDigest = adminGrantBrowserBindingDigest({
    bindingId: second.browserBindingId,
    userId: second.userId,
    sessionId: second.sessionId,
    orgId: second.orgId,
    origin: second.origin,
    nonceDigest: second.nonceDigest,
  })
  await supersedeIssuedAdminGrantProof(executor, second.userId, second.sessionId)
  const written = await insertIssuedAdminGrantProofSet(executor, {
    id,
    userId: second.userId,
    sessionId: second.sessionId,
    orgId: second.orgId,
    connectionId: second.connectionId,
    targetWitness: second.targetWitness,
    proofHash,
    clientBindingDigest,
    accessGeneration: second.accessGeneration,
    credentialWitness: second.credentialWitness,
    privilegeWitness: second.privilegeWitness,
    privilegeClass: second.privilegeClass,
    canonicalIntent: second.canonicalIntent,
    commandId: second.commandId,
    applicationRevision: second.applicationRevision,
    browserBindingId: second.browserBindingId,
    credentialEstablishmentId: second.credentialEstablishmentId,
    credentialVersion: second.credentialVersion,
    watermarkUs: second.watermarkUs,
    tokenIssuedAt: second.tokenIssuedAt,
    sessionExpiresAt: second.sessionExpiresAt,
    browserExpiresAt: second.browserExpiresAt,
    children: second.children,
  })
  return Object.freeze({
    kind: 'issued',
    proof: `agp1.${id}.${secret}`,
    expiresAt: written.expiresAt,
    intentDigest: second.targetWitness,
    targetCount: second.children.length,
  })
}

export function createAdminGrantProofService(options: AdminGrantProofServiceOptions): AdminGrantProofService {
  const record = closedRecord(options, OPTION_FIELDS)
  const publicOrigin = canonicalAdminGrantOrigin(typeof record.publicOrigin === 'string' ? record.publicOrigin : '')
  let browserService: ReturnType<typeof createAdminGrantBrowserContext>
  try {
    browserService = createAdminGrantBrowserContext({ publicOrigin })
  } catch (error) {
    if (error instanceof AdminGrantActorInputError) throw new AdminGrantProofContractError('ADMIN_GRANT_ORIGIN_INVALID')
    throw error
  }
  const boundOrigin = (): string => {
    if (publicOrigin.length === 0) throw new AdminGrantProofContractError('ADMIN_GRANT_ORIGIN_INVALID')
    return publicOrigin
  }
  return Object.freeze({
    async issue(context: AuthenticatedSessionContext, input: AdminGrantIssueInput): Promise<IssuedAdminGrantProof> {
      const captured = captureAdminGrantIssueInput(input)
      const session = requireSession(context)
      const origin = boundOrigin()
      const browser = retainedBrowser(session, origin)
      if (session.orgId === null || session.orgId !== captured.intent.orgId || session.userId !== captured.intent.actorId) {
        throw new AdminGrantProofError('ADMIN_GRANT_SESSION_REQUIRED')
      }
      const subjectIds = [captured.intent.actorId, ...captured.intent.targets.map((target) => target.userId)]
      let privilegePlan: PrivilegeRolePlan
      try {
        privilegePlan = await discoverPrivilegeRolePlan(reads, subjectIds, { sourceIntegrationIds: [captured.intent.connectionId] })
      } catch (error) {
        if (error instanceof AdminGrantIntentError) throw new AdminGrantProofError('ADMIN_GRANT_PROOF_INVALID')
        throw new AdminGrantProofError('ADMIN_GRANT_UNAVAILABLE')
      }
      const canonicalIntent = encodeAdminGrantIntent(captured.intent)
      const steps: AdminGrantOwnedSteps<IssueSnapshot, IssueOutcome> = {
        kind: 'admin_grant_issue',
        privilegePlan,
        readInputs: async (tx) => {
          try {
            return await readIssueSnapshot(tx, session, browser, captured.intent, privilegePlan, canonicalIntent, origin, browserService, true)
          } catch (error) {
            return asAttemptRefusal(error)
          }
        },
        accountRejected: async (tx, first) => {
          try {
            await accountRejected(tx, first)
            return { kind: 'rejected' }
          } catch (error) {
            return asAttemptRefusal(error)
          }
        },
        issue: async (tx, first) => {
          try {
            return await issueVerified(tx, session, browser, captured.intent, privilegePlan, canonicalIntent, origin, browserService, first)
          } catch (error) {
            return asAttemptRefusal(error)
          }
        },
      }
      try {
        const outcome = await runOwnedAttempt(session.sessionId, captured.password, steps)
        if (outcome.kind === 'rejected') throw new AdminGrantProofError('ADMIN_GRANT_CREDENTIAL_REJECTED')
        return Object.freeze({
          proof: outcome.proof,
          purpose: 'admin_login_grant_enable' as const,
          commandId: captured.intent.commandId,
          intentDigest: outcome.intentDigest,
          targetCount: outcome.targetCount,
          method: 'local_password' as const,
          assurance: 'local_password' as const,
          expiresAt: outcome.expiresAt,
          ttlSeconds: 300 as const,
        })
      } catch (error) {
        if (error instanceof AdminGrantProofError) throw error
        return mapAttemptError(error)
      }
    },
    async prepareConsume(context: AuthenticatedSessionContext, input: AdminGrantConsumeInput): Promise<PreparedAdminGrantProof> {
      const captured = captureAdminGrantConsumeInput(input)
      const session = requireSession(context)
      const origin = boundOrigin()
      const browser = retainedBrowser(session, origin)
      const parsed = parseAdminGrantProof(captured.proof)
      if (!parsed || session.userId !== captured.intent.actorId || session.orgId !== captured.intent.orgId) proofInvalid()
      const secretHash = hashAdminGrantProofSecret(parsed.secret)
      let header: Awaited<ReturnType<typeof readAdminGrantProofHeader>>
      let seal: Awaited<ReturnType<typeof readAdminGrantProofSeal>>
      let children: Awaited<ReturnType<typeof readAdminGrantProofChildren>>
      try {
        header = await readAdminGrantProofHeader(reads, parsed.id, session.userId)
        seal = header ? await readAdminGrantProofSeal(reads, parsed.id) : null
        children = header && seal ? await readAdminGrantProofChildren(reads, parsed.id) : []
      } catch (error) {
        if (error instanceof AdminGrantProofStorageError) unavailable()
        throw error
      }
      if (!header || !seal || !secretHash || !header.proofHash || !adminGrantDigestEqual(header.proofHash, secretHash)) proofInvalid()
      if (header.status !== 'issued' || header.sessionId !== session.sessionId) proofInvalid()
      if (seal.browserBindingId !== browser.bindingId || seal.tokenIssuedAt !== session.tokenIssuedAt) proofInvalid()
      const stored = canonicalStoredIntent(seal.canonicalIntent, captured.intent)
      if (adminGrantIntentDigest(seal.canonicalIntent) !== header.targetWitness) proofInvalid()
      if (seal.commandId !== stored.commandId || seal.targetCount !== stored.targets.length || children.length !== stored.targets.length) {
        proofInvalid()
      }
      const subjectIds = [stored.actorId, ...stored.targets.map((target) => target.userId)]
      let privilegePlan: PrivilegeRolePlan
      try {
        privilegePlan = await discoverPrivilegeRolePlan(reads, subjectIds, { sourceIntegrationIds: [stored.connectionId] })
      } catch (error) {
        if (error instanceof AdminGrantIntentError) proofInvalid()
        unavailable()
      }
      const actorPrivilege: AdminGrantActorPrivilegeExpectation = Object.freeze({
        userId: header.userId,
        orgId: header.orgId,
        privilegeWitness: header.privilegeWitness,
      })
      const prepared = Object.freeze({
        intent: stored,
        intentDigest: header.targetWitness,
        actorPrivilege,
        privilegePlan,
      }) as PreparedAdminGrantProof
      preparedBindings.set(prepared, Object.freeze({
        intent: stored,
        intentDigest: header.targetWitness,
        actorPrivilege,
        privilegePlan,
        proofId: header.id,
        browser,
        session,
      }))
      return prepared
    },
    async consumeOnTx(
      tx: AuthorizationInputTx,
      context: AuthenticatedSessionContext,
      prepared: PreparedAdminGrantProof,
    ): Promise<ConsumedAdminGrantProof> {
      if (typeof tx !== 'object' || tx === null) throw new AdminGrantProofContractError('ADMIN_GRANT_TRANSACTION_REQUIRED')
      if (typeof prepared !== 'object' || prepared === null) throw new AdminGrantProofContractError('ADMIN_GRANT_CONSUME_BRAND')
      const session = requireSession(context)
      const origin = boundOrigin()
      const binding = preparedBindings.get(prepared)
      if (!binding || binding.session !== session || binding.privilegePlan !== prepared.privilegePlan) {
        throw new AdminGrantProofContractError('ADMIN_GRANT_CONSUME_BRAND')
      }
      const browser = retainedBrowser(session, origin)
      if (browser !== binding.browser) throw new AdminGrantProofContractError('ADMIN_GRANT_CONTEXT_REQUIRED')
      let open = false
      let heldPlan: unknown
      try {
        open = tx.open === true
        assertAuthorizationInputTx(tx, { client: tx })
        heldPlan = tx.plan
      } catch (error) {
        if (error instanceof AdminGrantProofContractError) throw error
        if (error instanceof AuthorizationInputTokenRejectedError || error instanceof Error) {
          throw new AdminGrantProofContractError('ADMIN_GRANT_TRANSACTION_REQUIRED')
        }
        throw new AdminGrantProofContractError('ADMIN_GRANT_TRANSACTION_REQUIRED')
      }
      if (!open || heldPlan !== binding.privilegePlan.lockPlan) {
        throw new AdminGrantProofContractError('ADMIN_GRANT_TRANSACTION_REQUIRED')
      }
      const intent = binding.intent
      const userIds = [intent.actorId, ...intent.targets.map((target) => target.userId)].sort(compareCodeUnits)
      try {
        tx.requireUserRows(userIds)
        const actor = tx.locked.get(intent.actorId)
        await assertPlatformActorAuthority(tx, actor)
        for (const userId of userIds) {
          const membership = await tx.query(
            `SELECT user_id FROM user_orgs WHERE user_id = $1 AND org_id = $2 AND is_active IS TRUE FOR SHARE`,
            [userId, intent.orgId],
          )
          const rows = asRows(membership)
          if (rows.length !== 1 || rows[0]?.user_id !== userId) proofInvalid()
        }
        const receivingContext = Object.freeze({
          client: tx,
          privilegePlan: binding.privilegePlan,
          actorPrivilege: binding.actorPrivilege,
        })
        const receiving = await resolveAdminGrantTargetSet(tx, receivingContext, intent, 'consume')
        assertPreparedAdminGrantConsume(receiving, tx, receivingContext, intent)
        const executor = asQueryable(tx)
        const schema = await resolveAdminGrantInstallSchema(executor, 'ADMIN_GRANT_BROWSER_UNAVAILABLE')
        const statements = adminGrantBrowserStatements(schema)
        for (const userId of userIds) {
          const watermark = asRows(await tx.query(statements.lockWatermark, [userId]))
          if (watermark.length !== 1) proofInvalid()
        }
        const sessionRows = asRows(await tx.query(statements.lockSession, [session.sessionId]))
        const sessionRow = sessionRows[0]
        if (sessionRows.length !== 1 || !sessionRow || sessionRow.user_id !== session.userId || sessionRow.live !== true) {
          proofInvalid()
        }
        const bindingRows = asRows(await tx.query(statements.lockBinding, [session.sessionId]))
        if (bindingRows.length !== 1 || bindingRows[0]?.binding_id !== browser.bindingId) proofInvalid()
        const witness = await browserService.assertCurrent(executor, browser)
        const header = await lockAdminGrantProof(executor, binding.proofId, session.userId)
        const seal = header ? await readAdminGrantProofSeal(executor, binding.proofId) : null
        const children = header && seal ? await readAdminGrantProofChildren(executor, binding.proofId) : []
        if (!header || !seal || header.status !== 'issued' || header.sessionId !== session.sessionId) proofInvalid()
        if (seal.canonicalIntent.length === 0 || adminGrantIntentDigest(seal.canonicalIntent) !== header.targetWitness) proofInvalid()
        canonicalStoredIntent(seal.canonicalIntent, intent)
        if (seal.browserBindingId !== witness.bindingId || seal.tokenIssuedAt !== witness.tokenIssuedAt) proofInvalid()
        if (seal.watermarkUs !== witness.watermarkUs || !SIX_DIGIT_UTC.test(seal.sessionExpiresAt) || seal.sessionExpiresAt !== witness.sessionExpiresAt) {
          proofInvalid()
        }
        if (!header.clientBindingDigest || !header.proofHash || !header.expiresAt) proofInvalid()
        if (!Number.isFinite(Date.parse(header.expiresAt))) proofInvalid()
        const digest = adminGrantBrowserBindingDigest({
          bindingId: witness.bindingId,
          userId: witness.userId,
          sessionId: witness.sessionId,
          orgId: witness.orgId,
          origin: witness.origin,
          nonceDigest: witness.nonceDigest,
        })
        if (!adminGrantDigestEqual(header.clientBindingDigest, digest)) proofInvalid()
        if (Date.parse(header.expiresAt) > Date.parse(witness.bindingExpiresAt)) proofInvalid()
        const account = await readAccount(tx, session.userId)
        if (account.accessGeneration !== header.accessGeneration) proofInvalid()
        if (!adminGrantDigestEqual(header.credentialWitness, computeCredentialWitness(account))) proofInvalid()
        const credential = await readAdminGrantLocalCredential(executor, session)
        if (credential.establishmentId !== seal.credentialEstablishmentId || credential.credentialVersion !== seal.credentialVersion) {
          proofInvalid()
        }
        if (receiving.actor.privilegeWitness !== header.privilegeWitness || receiving.actor.privilegeClass !== header.privilegeClass) {
          proofInvalid()
        }
        if (children.length !== intent.targets.length) proofInvalid()
        for (let index = 0; index < intent.targets.length; index += 1) {
          const target = intent.targets[index]
          const child = children[index]
          if (!target || !child || child.ordinal !== index + 1 || child.userId !== target.userId
            || child.identityId !== target.identityId || child.bindingRevision !== target.bindingRevision
            || child.evidenceId !== target.evidenceId || child.evidenceWitness !== target.evidenceWitness
            || child.accessGeneration !== target.accessGeneration || child.privilegeWitness !== target.privilegeWitness) {
            proofInvalid()
          }
        }
        const consumed = await consumeAdminGrantProof(
          executor,
          header.id,
          session.userId,
          session.sessionId,
          adminGrantCommandActionRef(intent.actorId, intent.orgId, intent.commandId),
        )
        if (!consumed) proofInvalid()
        const result = Object.freeze({
          proofId: header.id,
          commandId: intent.commandId,
          intentDigest: header.targetWitness,
          targetCount: seal.targetCount,
          receiving,
        }) as ConsumedAdminGrantProof
        consumedBindings.set(result, Object.freeze({
          tx,
          session,
          browser,
          origin,
          receiving,
          privilegePlan: binding.privilegePlan,
          actorPrivilege: binding.actorPrivilege,
          intent,
        }))
        return result
      } catch (error) {
        if (error instanceof AdminGrantProofError || error instanceof AdminGrantProofContractError) throw error
        if (error instanceof AdminGrantReceivingRefusal || error instanceof PlatformActorAuthorityLost) proofInvalid()
        if (error instanceof AdminGrantActorInputError) {
          if (error.code === 'ADMIN_GRANT_BROWSER_UNAVAILABLE' || error.code === 'ADMIN_GRANT_CREDENTIAL_UNAVAILABLE') unavailable()
          proofInvalid()
        }
        if (error instanceof AdminGrantProofStorageError) unavailable()
        unavailable()
      }
    },
    assertConsumedOnTx(result, tx, context, intent): void {
      const normalized = captureIntent(intent)
      const session = requireSession(context)
      const origin = boundOrigin()
      if (typeof result !== 'object' || result === null) throw new AdminGrantProofContractError('ADMIN_GRANT_CONSUME_BRAND')
      const binding = consumedBindings.get(result)
      if (!binding || binding.session !== session || !sameIntent(binding.intent, normalized)) {
        throw new AdminGrantProofContractError('ADMIN_GRANT_CONSUME_BRAND')
      }
      if (binding.origin !== origin) throw new AdminGrantProofContractError('ADMIN_GRANT_CONTEXT_REQUIRED')
      let browser: AdminGrantBrowserContext
      try {
        browser = retainedBrowser(session, origin)
      } catch (error) {
        if (error instanceof AdminGrantActorInputError || error instanceof AdminGrantProofContractError) {
          throw new AdminGrantProofContractError('ADMIN_GRANT_CONTEXT_REQUIRED')
        }
        throw error
      }
      if (browser !== binding.browser) throw new AdminGrantProofContractError('ADMIN_GRANT_CONTEXT_REQUIRED')
      let open = false
      let planMatch = false
      try {
        open = typeof tx === 'object' && tx !== null && tx.open === true && tx === binding.tx
        planMatch = open && tx.plan === binding.privilegePlan.lockPlan
      } catch {
        throw new AdminGrantProofContractError('ADMIN_GRANT_TRANSACTION_REQUIRED')
      }
      if (!open || !planMatch) throw new AdminGrantProofContractError('ADMIN_GRANT_TRANSACTION_REQUIRED')
      try {
        assertPreparedAdminGrantConsume(binding.receiving, tx, {
          client: tx,
          privilegePlan: binding.privilegePlan,
          actorPrivilege: binding.actorPrivilege,
        }, normalized)
      } catch (error) {
        if (error instanceof AdminGrantReceivingRefusal) {
          throw new AdminGrantProofContractError('ADMIN_GRANT_CONSUME_BRAND')
        }
        throw new AdminGrantProofContractError('ADMIN_GRANT_CONSUME_BRAND')
      }
    },
  })
}
