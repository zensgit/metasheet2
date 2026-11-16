/**
 * One-time action proofs for security actions.
 *
 * A signed-in user re-verifies with a local password and receives a proof that is valid for 300
 * seconds, can be consumed once, and is bound to the user, the session, the authenticated
 * organization, the purpose, the connection, the target witness, the access generation, a
 * credential witness, a privilege witness and the policy revision.
 *
 * Issuance decides every refusal that needs no data before any statement. A read-committed
 * transaction then reads the inputs without row locks; the password is compared outside any
 * transaction; a second read-committed transaction takes a per-user advisory lock and the user row
 * before any proof row, counts failures again, and either records the rejected attempt or re-reads
 * every input and writes the proof only when nothing changed. The account gate decides whether the
 * session is still usable; whether the local password is an eligible method is decided separately,
 * so an account that cannot use it is told which step comes next.
 *
 * Consumption runs inside the caller's read-committed transaction. The user row is always the first
 * lock: the caller takes it through lockUsersForAccessGraphWrite, then any other row it needs
 * (including the rows it recomputes the target witness from), and only then calls consume, which
 * re-enters the user row, takes the session row and the proof row, re-checks every binding and marks
 * the proof consumed in that transaction, so the proof and the action commit together. No path may
 * wait for the user row while holding the session row or a proof row. The caller must not perform an
 * irreversible external effect before that transaction commits; an external call goes after the
 * commit or is idempotent on the proof id. Binding inputs come only from a context built by
 * readAuthenticatedSessionContext. Consumption applies the same account gate and the same method
 * eligibility check as issuance; either refusal is reported as a stale proof. The privilege witness
 * is compared at consumption time; every purpose stays unavailable until every authorization-input
 * writer serializes with consumption, proofs are bound to the browser that started them, and
 * verification attempts are limited per user and per session.
 *
 * Every entry point refuses before any statement unless SECURITY_ACTION_PROOF_ENABLED is exactly
 * 'true'. This module is the only reader and writer of security_action_challenges.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import * as bcrypt from 'bcryptjs'
import type { Request } from 'express'
import { auditLog } from '../audit/audit'
import { transaction } from '../db/pg'
import { lockUsersForAccessGraphWrite } from '../directory/access-graph-mutex'
import type { LockedAccessGraphUser } from '../directory/access-graph-mutex'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { assertInTransaction } from '../multitable/pg-transaction-guard'
import { authService } from './AuthService'
import {
  evaluateSecurityActionPolicy,
  isSecurityActionPurpose,
  isSecurityActionPurposeAvailable,
  SECURITY_ACTION_POLICY_REVISION,
  SECURITY_ACTION_PURPOSE_REGISTRY,
} from './external-login-assurance'
import type { PrivilegeClass, SecurityActionPurpose, SecurityActionTargetKind } from './external-login-assurance'
import { assessSecurityActionPrivilege } from './security-action-privilege'
import { isSecurityActionProofEnabled } from './security-action-proof-flag'
import { evaluateUserAuthenticationGate } from './user-activation'

export const SECURITY_ACTION_PROOF_TTL_SECONDS = 300
export const SECURITY_ACTION_FAILURE_LIMIT = 5
export const SECURITY_ACTION_FAILURE_WINDOW_SECONDS = 900
export const SECURITY_ACTION_PROOF_STATUSES = ['issued', 'consumed', 'superseded', 'failed'] as const
export const SECURITY_ACTION_FAILURE_CODES = ['credential_rejected', 'reauth_subject_mismatch'] as const
export const SECURITY_ACTION_NEXT_STEPS = ['admin_assisted_local_credential'] as const
export type SecurityActionNextStep = (typeof SECURITY_ACTION_NEXT_STEPS)[number]

export const SECURITY_ACTION_PROOF_HASH_DOMAIN = 'metasheet:security-action:proof:v1|'
export const SECURITY_ACTION_CREDENTIAL_WITNESS_DOMAIN = 'metasheet:security-action:credential:v1|'
const PROOF_PREFIX = 'sap1'
const PROOF_PATTERN = /^sap1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const HEX64_PATTERN = /^[0-9a-f]{64}$/
const ACTION_REF_PATTERN = /^[!-~]{1,128}$/
const PASSWORD_MAX_LENGTH = 1024
const CLIENT_BINDING_MAX_LENGTH = 256
const ADVISORY_KEY_PREFIX = 'security-action:'
const NEXT_STEP: SecurityActionNextStep = 'admin_assisted_local_credential'

// ---------------------------------------------------------------------------
// Statements. Each is one constant so a test stand-in can answer by identity.
// ---------------------------------------------------------------------------

export const SECURITY_ACTION_SQL = Object.freeze({
  setReadCommitted: 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
  setLockTimeout: "SET LOCAL lock_timeout = '5s'",
  setStatementTimeout: "SET LOCAL statement_timeout = '30s'",
  session: `SELECT s.user_id, (s.revoked_at IS NULL AND s.expires_at > clock_timestamp()) AS live
  FROM user_sessions s
 WHERE s.id = $1`,
  watermark: `SELECT floor(extract(epoch FROM revoked_after) * 1000)::text AS revoked_after_ms,
       floor(extract(epoch FROM revoked_after) * 1000000)::text AS revoked_after_us
  FROM user_session_revocations
 WHERE user_id = $1`,
  failureCount: `SELECT count(*)::int AS failures,
       GREATEST(1, ceil(extract(epoch FROM (min(created_at) + interval '900 seconds' - clock_timestamp()))))::int AS retry_after
  FROM security_action_challenges
 WHERE user_id = $1 AND status = 'failed' AND created_at > clock_timestamp() - interval '900 seconds'`,
  account: `SELECT password_hash, local_password_set, must_change_password, activation_status, is_active, role,
       (to_jsonb(users) ->> 'deleted_at') AS deleted_at,
       (to_jsonb(users) ->> 'purged_at') AS purged_at,
       COALESCE(access_generation, 0)::text AS access_generation
  FROM users
 WHERE id = $1`,
  membership: `SELECT 1 AS present
  FROM user_orgs uo
  JOIN users u ON u.id = uo.user_id
 WHERE uo.user_id = $1 AND uo.org_id = $2 AND uo.is_active = true AND u.is_active = true`,
  advisoryLock: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
  userKeyShare: 'SELECT 1 AS present FROM users WHERE id = $1 FOR KEY SHARE',
  insertFailed: `INSERT INTO security_action_challenges
  (id, user_id, session_id, org_id, purpose, connection_id, target_kind, target_identity_id, expected_binding_revision,
   target_witness, method, method_connection_id, assurance, status, failure_code, proof_hash, client_binding_digest,
   policy_revision, access_generation, credential_witness, privilege_witness, privilege_class, expires_at)
VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $7, $8::uuid, $9::bigint,
        $10, 'local_password', NULL, NULL, 'failed', 'credential_rejected', NULL, NULL,
        $11, $12::bigint, $13, $14, $15, NULL)`,
  supersede: `UPDATE security_action_challenges
   SET status = 'superseded', superseded_at = clock_timestamp()
 WHERE user_id = $1 AND session_id = $2 AND purpose = $3 AND status = 'issued'`,
  insertIssued: `INSERT INTO security_action_challenges
  (id, user_id, session_id, org_id, purpose, connection_id, target_kind, target_identity_id, expected_binding_revision,
   target_witness, method, method_connection_id, assurance, status, failure_code, proof_hash, client_binding_digest,
   policy_revision, access_generation, credential_witness, privilege_witness, privilege_class, expires_at)
VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $7, $8::uuid, $9::bigint,
        $10, 'local_password', NULL, 'local_password', 'issued', NULL, $11, $12,
        $13, $14::bigint, $15, $16, $17, now() + interval '300 seconds')
RETURNING created_at, expires_at`,
  isolation: "SELECT current_setting('transaction_isolation') AS isolation",
  sessionForShare: `SELECT s.user_id, (s.revoked_at IS NULL AND s.expires_at > clock_timestamp()) AS live
  FROM user_sessions s
 WHERE s.id = $1
   FOR SHARE`,
  lockProof: `SELECT id::text AS id, user_id, session_id, org_id, purpose, connection_id::text AS connection_id, target_kind,
       target_witness, method, method_connection_id::text AS method_connection_id, assurance, status, proof_hash,
       client_binding_digest, policy_revision, access_generation::text AS access_generation, credential_witness,
       privilege_witness, privilege_class, created_at,
       floor(extract(epoch FROM created_at) * 1000000)::text AS created_at_us,
       (expires_at > clock_timestamp()) AS live
  FROM security_action_challenges
 WHERE id = $1::uuid AND user_id = $2
   FOR UPDATE`,
  consume: `UPDATE security_action_challenges
   SET status = 'consumed', consumed_at = clock_timestamp(), consumed_action_ref = $5
 WHERE id = $1::uuid AND user_id = $2 AND session_id = $3 AND purpose = $4
   AND status = 'issued' AND expires_at > clock_timestamp()
RETURNING id::text AS id, created_at, method, assurance, privilege_class`,
  reloadProof: `SELECT status, (expires_at > clock_timestamp()) AS live
  FROM security_action_challenges
 WHERE id = $1::uuid AND user_id = $2`,
})

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type SecurityActionErrorCode =
  | 'SECURITY_ACTION_SESSION_REQUIRED'
  | 'SECURITY_ACTION_PURPOSE_UNAVAILABLE'
  | 'SECURITY_ACTION_METHOD_UNAVAILABLE'
  | 'SECURITY_ACTION_HIGH_PRIVILEGE_SELF_SERVICE_DENIED'
  | 'SECURITY_ACTION_ASSURANCE_INSUFFICIENT'
  | 'SECURITY_ACTION_CONNECTION_NOT_PERMITTED'
  | 'SECURITY_ACTION_CREDENTIAL_REJECTED'
  | 'SECURITY_ACTION_ORG_CONTEXT_REQUIRED'
  | 'SECURITY_ACTION_TARGET_CONFLICT'
  | 'SECURITY_ACTION_STATE_CHANGED'
  | 'SECURITY_ACTION_INVALID_REQUEST'
  | 'SECURITY_ACTION_RATE_LIMITED'
  | 'SECURITY_ACTION_UNAVAILABLE'
  | 'SECURITY_ACTION_PROOF_UNAVAILABLE'
  | 'SECURITY_ACTION_PROOF_INVALID'
  | 'SECURITY_ACTION_PROOF_SESSION_MISMATCH'
  | 'SECURITY_ACTION_PROOF_EXPIRED'
  | 'SECURITY_ACTION_PROOF_ALREADY_USED'
  | 'SECURITY_ACTION_PROOF_SCOPE_MISMATCH'
  | 'SECURITY_ACTION_PROOF_STALE'

export type SecurityActionErrorDetails = Readonly<{
  nextStep?: SecurityActionNextStep
  retryAfter?: number
  fields?: readonly string[]
}>

const ERROR_STATUS: Readonly<Record<SecurityActionErrorCode, number>> = Object.freeze({
  SECURITY_ACTION_SESSION_REQUIRED: 401,
  SECURITY_ACTION_PURPOSE_UNAVAILABLE: 403,
  SECURITY_ACTION_METHOD_UNAVAILABLE: 403,
  SECURITY_ACTION_HIGH_PRIVILEGE_SELF_SERVICE_DENIED: 403,
  SECURITY_ACTION_ASSURANCE_INSUFFICIENT: 403,
  SECURITY_ACTION_CONNECTION_NOT_PERMITTED: 403,
  SECURITY_ACTION_CREDENTIAL_REJECTED: 403,
  SECURITY_ACTION_ORG_CONTEXT_REQUIRED: 409,
  SECURITY_ACTION_TARGET_CONFLICT: 409,
  SECURITY_ACTION_STATE_CHANGED: 409,
  SECURITY_ACTION_INVALID_REQUEST: 422,
  SECURITY_ACTION_RATE_LIMITED: 429,
  SECURITY_ACTION_UNAVAILABLE: 503,
  SECURITY_ACTION_PROOF_UNAVAILABLE: 503,
  SECURITY_ACTION_PROOF_INVALID: 403,
  SECURITY_ACTION_PROOF_SESSION_MISMATCH: 409,
  SECURITY_ACTION_PROOF_EXPIRED: 409,
  SECURITY_ACTION_PROOF_ALREADY_USED: 409,
  SECURITY_ACTION_PROOF_SCOPE_MISMATCH: 409,
  SECURITY_ACTION_PROOF_STALE: 409,
})

/** A refusal with a fixed message and no cause; `details` holds closed-set values only. */
export class SecurityActionProofError extends Error {
  readonly status: number
  readonly code: SecurityActionErrorCode
  readonly details?: SecurityActionErrorDetails
  constructor(code: SecurityActionErrorCode, details?: SecurityActionErrorDetails) {
    super('Security action refused')
    this.name = 'SecurityActionProofError'
    this.code = code
    this.status = ERROR_STATUS[code]
    if (details) this.details = Object.freeze({ ...details })
  }
}

export type SecurityActionContractCode =
  | 'SECURITY_ACTION_TRANSACTION_REQUIRED'
  | 'SECURITY_ACTION_CONTEXT_REQUIRED'
  | 'SECURITY_ACTION_LOCKED_USER_REQUIRED'
  | 'SECURITY_ACTION_INPUT_SHAPE'

/** The caller used the API outside its contract. Never mapped to a success. */
export class SecurityActionProofContractError extends Error {
  readonly code: SecurityActionContractCode
  constructor(code: SecurityActionContractCode) {
    super('Security action API contract violated')
    this.name = 'SecurityActionProofContractError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Session context: the only construction point for binding inputs.
// ---------------------------------------------------------------------------

declare const sessionBrand: unique symbol

export type AuthenticatedSessionContext = Readonly<{
  userId: string
  sessionId: string
  tokenIssuedAt: number
  orgId: string | null
  readonly [sessionBrand]: true
}>

const sessionContexts = new WeakSet<object>()

function bearerOf(req: Pick<Request, 'headers'>): string | null {
  const header = req.headers?.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null
  const token = header.slice(7)
  return token.length > 0 ? token : null
}

function trimmedNonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Builds the session context of a request that passed the session gate: the user id of the gate's
 * user, the session id and issue time of the bearer token (re-verified), and the organization the
 * gate authenticated. Returns null when any of them is missing, when the token names another user,
 * or when the organization claim of the token differs from the authenticated organization.
 */
export function readAuthenticatedSessionContext(req: Request): AuthenticatedSessionContext | null {
  const user = req.user
  if (!user || typeof user !== 'object') return null
  const userId = typeof user.id === 'string' && user.id.length > 0 ? user.id : null
  if (!userId) return null
  const token = bearerOf(req)
  if (!token) return null
  const payload = authService.readTokenPayload(token)
  if (!payload || typeof payload !== 'object') return null
  const sessionId = trimmedNonEmpty(payload.sid)
  if (!sessionId) return null
  const tokenIssuedAt = payload.iat
  if (typeof tokenIssuedAt !== 'number' || !Number.isSafeInteger(tokenIssuedAt) || tokenIssuedAt <= 0) return null
  const claimedUser = trimmedNonEmpty(payload.userId) ?? trimmedNonEmpty(payload.id) ?? trimmedNonEmpty(payload.sub)
  if (claimedUser !== userId) return null
  const orgId = trimmedNonEmpty(req.authenticatedTenantId)
  if (orgId !== null && trimmedNonEmpty(payload.tenantId) !== orgId) return null
  const context = Object.freeze({ userId, sessionId, tokenIssuedAt, orgId }) as unknown as AuthenticatedSessionContext
  sessionContexts.add(context)
  return context
}

function assertSessionContext(session: unknown): asserts session is AuthenticatedSessionContext {
  if (!session || typeof session !== 'object' || !sessionContexts.has(session)) {
    throw new SecurityActionProofContractError('SECURITY_ACTION_CONTEXT_REQUIRED')
  }
}

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

export type SecurityActionVerifyRequest = Readonly<{
  purpose: SecurityActionPurpose
  connectionId: string
  targetIdentityId?: string
  expectedBindingRevision?: number
  method: 'local_password'
  password: string
  clientBindingDigest?: string
}>

const REQUEST_FIELDS = ['purpose', 'connectionId', 'targetIdentityId', 'expectedBindingRevision', 'method', 'password', 'clientBindingDigest'] as const
const UNKNOWN_FIELD = '_unknown'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

/**
 * Closed schema. Unknown keys are reported under one fixed field name and never echoed; `details`
 * holds schema field names only. The password is neither trimmed nor echoed.
 */
export function parseSecurityActionVerifyRequest(body: unknown):
  | { ok: true; request: SecurityActionVerifyRequest }
  | { ok: false; fields: readonly string[] } {
  if (!isPlainObject(body)) return { ok: false, fields: [UNKNOWN_FIELD] }
  const invalid = new Set<string>()
  for (const key of Object.keys(body)) {
    if (!(REQUEST_FIELDS as readonly string[]).includes(key)) invalid.add(UNKNOWN_FIELD)
  }
  const has = (key: (typeof REQUEST_FIELDS)[number]): boolean => Object.hasOwn(body, key)

  const purpose = body.purpose
  if (!isSecurityActionPurpose(purpose)) invalid.add('purpose')
  const connectionId = body.connectionId
  if (!isUuid(connectionId)) invalid.add('connectionId')
  const method = body.method
  if (method !== 'local_password') invalid.add('method')
  const password = body.password
  if (typeof password !== 'string' || password.length < 1 || password.length > PASSWORD_MAX_LENGTH) invalid.add('password')

  const targetRequired = isSecurityActionPurpose(purpose)
    ? SECURITY_ACTION_PURPOSE_REGISTRY[purpose].targetKind === 'identity_revision'
    : null
  const targetPresent = has('targetIdentityId')
  const revisionPresent = has('expectedBindingRevision')
  if (targetRequired === true && !targetPresent) invalid.add('targetIdentityId')
  if (targetRequired === false && targetPresent) invalid.add('targetIdentityId')
  if (targetPresent && !isUuid(body.targetIdentityId)) invalid.add('targetIdentityId')
  if (targetPresent !== revisionPresent) invalid.add('expectedBindingRevision')
  if (revisionPresent) {
    const revision = body.expectedBindingRevision
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) invalid.add('expectedBindingRevision')
  }
  if (has('clientBindingDigest')) {
    const digest = body.clientBindingDigest
    if (typeof digest !== 'string' || !HEX64_PATTERN.test(digest)) invalid.add('clientBindingDigest')
  }
  if (invalid.size > 0) return { ok: false, fields: Object.freeze([...invalid].sort()) }

  const request: Record<string, unknown> = {
    purpose,
    connectionId: (connectionId as string).toLowerCase(),
    method: 'local_password',
    password,
  }
  if (targetPresent) {
    request.targetIdentityId = (body.targetIdentityId as string).toLowerCase()
    request.expectedBindingRevision = body.expectedBindingRevision
  }
  if (has('clientBindingDigest')) request.clientBindingDigest = body.clientBindingDigest
  return { ok: true, request: Object.freeze(request) as SecurityActionVerifyRequest }
}

// ---------------------------------------------------------------------------
// Tokens, hashes and witnesses
// ---------------------------------------------------------------------------

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/** `sap1.<uuid>.<43 base64url characters>`; the secret is 32 random bytes. */
function generateProof(): { id: string; proof: string; hash: string } {
  const id = randomUUID()
  const secret = randomBytes(32).toString('base64url')
  return { id, proof: `${PROOF_PREFIX}.${id}.${secret}`, hash: hashProofSecret(secret) }
}

export function hashProofSecret(secret: string): string {
  return sha256Hex(SECURITY_ACTION_PROOF_HASH_DOMAIN + secret)
}

export function parseProof(proof: unknown): { id: string; secret: string } | null {
  if (typeof proof !== 'string') return null
  const match = PROOF_PATTERN.exec(proof)
  if (!match) return null
  return { id: match[1], secret: match[2] }
}

export function clientBindingDigestOf(raw: string): string {
  return sha256Hex(raw)
}

function hexEquals(expectedHex: string, actualHex: string): boolean {
  if (!HEX64_PATTERN.test(expectedHex) || !HEX64_PATTERN.test(actualHex)) return false
  return timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(actualHex, 'hex'))
}

type AccountRow = Readonly<{
  passwordHash: string
  localPasswordSet: boolean
  mustChangePassword: boolean
  activationStatus: string
  isActive: boolean
  role: string | null
  deletedAt: string | null
  purgedAt: string | null
  accessGeneration: string
}>

function isMarked(value: unknown): boolean {
  return value != null && String(value).trim().length > 0
}

export function computeCredentialWitness(account: AccountRow): string {
  const encoded = JSON.stringify([
    account.passwordHash,
    account.localPasswordSet,
    account.mustChangePassword,
    account.activationStatus,
    account.isActive,
    isMarked(account.deletedAt),
    isMarked(account.purgedAt),
  ])
  return sha256Hex(SECURITY_ACTION_CREDENTIAL_WITNESS_DOMAIN + encoded)
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export type SecurityActionTargetRequest = Readonly<{
  userId: string
  orgId: string
  connectionId: string
  targetIdentityId: string | null
  expectedBindingRevision: string | null
}>

export type SecurityActionTargetResolution =
  | Readonly<{ ok: true; kind: SecurityActionTargetKind; witness: string }>
  | Readonly<{ ok: false; refused: 'connection_not_permitted' | 'target_conflict' }>

export type SecurityActionTargetResolver = (executor: Queryable, request: SecurityActionTargetRequest) => Promise<SecurityActionTargetResolution>

export type SecurityActionAuditResult =
  | 'issued' | 'credential_rejected' | 'rate_limited' | 'method_unavailable' | 'high_privilege_denied'
  | 'assurance_insufficient' | 'connection_not_permitted' | 'target_conflict' | 'org_context_required'
  | 'session_required' | 'state_changed' | 'unavailable'

export type SecurityActionAuditEvent = Readonly<{
  action: 'security_action_verify'
  resourceType: 'user-security-action'
  resourceId: string
  meta: Readonly<{
    userId: string
    purpose: SecurityActionPurpose
    method: 'local_password'
    result: SecurityActionAuditResult
    code: SecurityActionErrorCode | null
    connectionId: string
    privilegeClass: PrivilegeClass | null
  }>
}>

export type SecurityActionProofServiceDeps = Readonly<{
  isPurposeAvailable: (purpose: SecurityActionPurpose) => boolean
  resolvers: Readonly<Partial<Record<SecurityActionPurpose, SecurityActionTargetResolver>>>
  runTransaction: <T>(work: (executor: Queryable) => Promise<T>) => Promise<T>
  verifyPassword: (password: string, hash: string) => Promise<boolean>
  recordAudit: (event: SecurityActionAuditEvent) => Promise<void>
  policyRevision: number
}>

export type IssuedSecurityActionProof = Readonly<{
  proof: string
  purpose: SecurityActionPurpose
  connectionId: string
  method: 'local_password'
  assurance: 'local_password'
  expiresAt: string
  ttlSeconds: number
}>

export type SecurityActionConsumeInput = Readonly<{
  proof: string
  clientBinding?: string
  purpose: SecurityActionPurpose
  connectionId: string | null
  target: Readonly<{ kind: SecurityActionTargetKind; witness: string }>
  lockedUser: LockedAccessGraphUser
  actionRef?: string
}>

export type VerifiedSecurityAction = Readonly<{
  proofId: string
  verifiedAt: string
  method: string
  assurance: string
  privilegeClass: PrivilegeClass
  purpose: SecurityActionPurpose
  connectionId: string | null
}>

type SessionState = Readonly<{ live: boolean }>

type IssueSnapshot = Readonly<{
  passwordHash: string
  accessGeneration: string
  credentialWitness: string
  privilegeClass: PrivilegeClass
  privilegeWitness: string
  targetKind: SecurityActionTargetKind
  targetWitness: string
}>

type IssueOutcome =
  | Readonly<{ kind: 'issued'; proof: string; expiresAt: string }>
  | Readonly<{ kind: 'rejected' }>

function unavailable(): SecurityActionProofError {
  return new SecurityActionProofError('SECURITY_ACTION_UNAVAILABLE')
}

function asProofError(error: unknown): SecurityActionProofError {
  if (error instanceof SecurityActionProofError) return error
  // Driver errors, privilege input errors and anything unexpected: a fixed refusal with no cause.
  return unavailable()
}

function toText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  return null
}

function timestampIso(value: unknown): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null
  if (typeof value === 'string') {
    const parsed = new Date(value)
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null
  }
  return null
}

async function readRows(executor: Queryable, statement: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
  const result = await executor.query(statement, params)
  if (!result || !Array.isArray(result.rows)) throw unavailable()
  return result.rows
}

async function readSession(executor: Queryable, statement: string, session: AuthenticatedSessionContext): Promise<SessionState> {
  const rows = await readRows(executor, statement, [session.sessionId])
  if (rows.length !== 1) return { live: false }
  const row = rows[0]
  if (row.user_id !== session.userId) return { live: false }
  return { live: row.live === true }
}

/** True when the token was issued at or before the user's revocation watermark (millisecond precision). */
async function isTokenRevoked(executor: Queryable, session: AuthenticatedSessionContext): Promise<{ revoked: boolean; watermarkUs: bigint | null }> {
  const rows = await readRows(executor, SECURITY_ACTION_SQL.watermark, [session.userId])
  if (rows.length === 0) return { revoked: false, watermarkUs: null }
  const ms = toText(rows[0].revoked_after_ms)
  const us = toText(rows[0].revoked_after_us)
  if (ms === null || us === null || !/^-?\d+$/.test(ms) || !/^-?\d+$/.test(us)) throw unavailable()
  return { revoked: BigInt(session.tokenIssuedAt) * 1000n <= BigInt(ms), watermarkUs: BigInt(us) }
}

async function readFailures(executor: Queryable, userId: string): Promise<{ failures: number; retryAfter: number }> {
  const rows = await readRows(executor, SECURITY_ACTION_SQL.failureCount, [userId])
  const failures = Number(rows[0]?.failures)
  if (rows.length !== 1 || !Number.isSafeInteger(failures) || failures < 0) throw unavailable()
  const retryAfterRaw = Number(rows[0]?.retry_after)
  const retryAfter = Number.isSafeInteger(retryAfterRaw) && retryAfterRaw > 0
    ? Math.min(retryAfterRaw, SECURITY_ACTION_FAILURE_WINDOW_SECONDS)
    : SECURITY_ACTION_FAILURE_WINDOW_SECONDS
  return { failures, retryAfter }
}

async function readAccount(executor: Queryable, userId: string): Promise<AccountRow | null> {
  const rows = await readRows(executor, SECURITY_ACTION_SQL.account, [userId])
  if (rows.length === 0) return null
  if (rows.length !== 1) throw unavailable()
  const row = rows[0]
  const accessGeneration = toText(row.access_generation)
  if (typeof row.password_hash !== 'string'
    || typeof row.local_password_set !== 'boolean'
    || typeof row.must_change_password !== 'boolean'
    || typeof row.activation_status !== 'string'
    || typeof row.is_active !== 'boolean'
    || accessGeneration === null || !/^\d+$/.test(accessGeneration)) {
    throw unavailable()
  }
  return Object.freeze({
    passwordHash: row.password_hash,
    localPasswordSet: row.local_password_set,
    mustChangePassword: row.must_change_password,
    activationStatus: row.activation_status,
    isActive: row.is_active,
    role: typeof row.role === 'string' ? row.role : null,
    deletedAt: typeof row.deleted_at === 'string' ? row.deleted_at : null,
    purgedAt: typeof row.purged_at === 'string' ? row.purged_at : null,
    accessGeneration,
  })
}

/** Account state only (no method requirement): a denial means the session is no longer usable. */
function accountGateDenies(account: AccountRow): boolean {
  return evaluateUserAuthenticationGate({
    is_active: account.isActive,
    role: account.role,
    activation_status: account.activationStatus,
    local_password_set: account.localPasswordSet,
    deleted_at: account.deletedAt,
    purged_at: account.purgedAt,
  }) !== null
}

/** The local password is an eligible method only for an account that set one and is not required to change it. */
function localPasswordEligible(account: AccountRow): boolean {
  return account.localPasswordSet === true && account.mustChangePassword === false
}

async function isMember(executor: Queryable, userId: string, orgId: string): Promise<boolean> {
  const rows = await readRows(executor, SECURITY_ACTION_SQL.membership, [userId, orgId])
  return rows.length > 0
}

function policyRefusal(purpose: SecurityActionPurpose, privilegeClass: PrivilegeClass, row?: { method: unknown; assurance: unknown; methodConnectionId: unknown; connectionId: unknown }): SecurityActionErrorCode | null {
  const decision = evaluateSecurityActionPolicy({
    purpose,
    privilegeClass,
    method: row ? row.method : 'local_password',
    assurance: row ? row.assurance : 'local_password',
    methodConnectionId: row ? row.methodConnectionId : null,
    targetConnectionId: row ? row.connectionId : null,
  })
  return decision.allowed === true ? null : decision.code
}

async function resolveTarget(
  resolver: SecurityActionTargetResolver,
  executor: Queryable,
  purpose: SecurityActionPurpose,
  request: SecurityActionTargetRequest,
): Promise<{ kind: SecurityActionTargetKind; witness: string }> {
  let resolution: SecurityActionTargetResolution
  try {
    resolution = await resolver(executor, request)
  } catch {
    throw unavailable()
  }
  if (!resolution || typeof resolution !== 'object') throw unavailable()
  if (resolution.ok !== true) {
    if (resolution.ok === false && resolution.refused === 'connection_not_permitted') throw new SecurityActionProofError('SECURITY_ACTION_CONNECTION_NOT_PERMITTED')
    if (resolution.ok === false && resolution.refused === 'target_conflict') throw new SecurityActionProofError('SECURITY_ACTION_TARGET_CONFLICT')
    throw unavailable()
  }
  if (resolution.kind !== SECURITY_ACTION_PURPOSE_REGISTRY[purpose].targetKind) throw unavailable()
  if (typeof resolution.witness !== 'string' || !HEX64_PATTERN.test(resolution.witness)) throw unavailable()
  return { kind: resolution.kind, witness: resolution.witness }
}

function auditResultOf(code: SecurityActionErrorCode): SecurityActionAuditResult {
  switch (code) {
    case 'SECURITY_ACTION_CREDENTIAL_REJECTED': return 'credential_rejected'
    case 'SECURITY_ACTION_RATE_LIMITED': return 'rate_limited'
    case 'SECURITY_ACTION_METHOD_UNAVAILABLE': return 'method_unavailable'
    case 'SECURITY_ACTION_HIGH_PRIVILEGE_SELF_SERVICE_DENIED': return 'high_privilege_denied'
    case 'SECURITY_ACTION_ASSURANCE_INSUFFICIENT': return 'assurance_insufficient'
    case 'SECURITY_ACTION_CONNECTION_NOT_PERMITTED': return 'connection_not_permitted'
    case 'SECURITY_ACTION_TARGET_CONFLICT': return 'target_conflict'
    case 'SECURITY_ACTION_ORG_CONTEXT_REQUIRED': return 'org_context_required'
    case 'SECURITY_ACTION_SESSION_REQUIRED': return 'session_required'
    case 'SECURITY_ACTION_STATE_CHANGED': return 'state_changed'
    default: return 'unavailable'
  }
}

function isActionRef(value: unknown): value is string {
  return typeof value === 'string' && ACTION_REF_PATTERN.test(value)
}

export function createSecurityActionProofService(deps: SecurityActionProofServiceDeps): {
  issue(session: AuthenticatedSessionContext, request: SecurityActionVerifyRequest): Promise<IssuedSecurityActionProof>
  consume(client: Queryable, session: AuthenticatedSessionContext, input: SecurityActionConsumeInput): Promise<VerifiedSecurityAction>
} {
  async function setReadCommitted(executor: Queryable): Promise<void> {
    await executor.query(SECURITY_ACTION_SQL.setReadCommitted)
    await executor.query(SECURITY_ACTION_SQL.setLockTimeout)
    await executor.query(SECURITY_ACTION_SQL.setStatementTimeout)
  }

  /** The per-user failure limit, counted in the database and decided before any password comparison. */
  async function refuseWhenRateLimited(executor: Queryable, userId: string): Promise<void> {
    const { failures, retryAfter } = await readFailures(executor, userId)
    if (failures >= SECURITY_ACTION_FAILURE_LIMIT) {
      throw new SecurityActionProofError('SECURITY_ACTION_RATE_LIMITED', { retryAfter, nextStep: NEXT_STEP })
    }
  }

  /** Every input of one issuance, read on `executor`; refuses in the order of the contract. */
  async function readIssueInputs(
    executor: Queryable,
    session: AuthenticatedSessionContext,
    request: SecurityActionVerifyRequest,
    orgId: string,
    resolver: SecurityActionTargetResolver,
    countFailures: boolean,
  ): Promise<IssueSnapshot> {
    const sessionState = await readSession(executor, SECURITY_ACTION_SQL.session, session)
    if (!sessionState.live) throw new SecurityActionProofError('SECURITY_ACTION_SESSION_REQUIRED')
    if ((await isTokenRevoked(executor, session)).revoked) throw new SecurityActionProofError('SECURITY_ACTION_SESSION_REQUIRED')
    if (countFailures) await refuseWhenRateLimited(executor, session.userId)
    const account = await readAccount(executor, session.userId)
    if (!account || accountGateDenies(account)) throw new SecurityActionProofError('SECURITY_ACTION_SESSION_REQUIRED')
    if (!localPasswordEligible(account)) throw new SecurityActionProofError('SECURITY_ACTION_METHOD_UNAVAILABLE', { nextStep: NEXT_STEP })
    if (!(await isMember(executor, session.userId, orgId))) throw new SecurityActionProofError('SECURITY_ACTION_ORG_CONTEXT_REQUIRED')
    const privilege = await assessSecurityActionPrivilege(executor, session.userId)
    const refusal = policyRefusal(request.purpose, privilege.privilegeClass)
    if (refusal) throw new SecurityActionProofError(refusal)
    const target = await resolveTarget(resolver, executor, request.purpose, {
      userId: session.userId,
      orgId,
      connectionId: request.connectionId,
      targetIdentityId: request.targetIdentityId ?? null,
      expectedBindingRevision: request.expectedBindingRevision === undefined ? null : String(request.expectedBindingRevision),
    })
    return Object.freeze({
      passwordHash: account.passwordHash,
      accessGeneration: account.accessGeneration,
      credentialWitness: computeCredentialWitness(account),
      privilegeClass: privilege.privilegeClass,
      privilegeWitness: privilege.witness,
      targetKind: target.kind,
      targetWitness: target.witness,
    })
  }

  function snapshotsAgree(first: IssueSnapshot, second: IssueSnapshot): boolean {
    return first.accessGeneration === second.accessGeneration
      && first.credentialWitness === second.credentialWitness
      && first.privilegeWitness === second.privilegeWitness
      && first.privilegeClass === second.privilegeClass
      && first.targetKind === second.targetKind
      && first.targetWitness === second.targetWitness
  }

  async function recordRejected(executor: Queryable, session: AuthenticatedSessionContext, request: SecurityActionVerifyRequest, orgId: string, first: IssueSnapshot): Promise<void> {
    // The rejected attempt is written from the first read, whatever changed in between, so that a
    // failure is counted even when the inputs drifted. The request's client binding is not stored.
    await executor.query(SECURITY_ACTION_SQL.insertFailed, [
      randomUUID(), session.userId, session.sessionId, orgId, request.purpose, request.connectionId,
      first.targetKind, request.targetIdentityId ?? null,
      request.expectedBindingRevision === undefined ? null : String(request.expectedBindingRevision),
      first.targetWitness, deps.policyRevision, first.accessGeneration, first.credentialWitness,
      first.privilegeWitness, first.privilegeClass,
    ])
  }

  async function writeProof(executor: Queryable, session: AuthenticatedSessionContext, request: SecurityActionVerifyRequest, orgId: string, snapshot: IssueSnapshot): Promise<{ proof: string; expiresAt: string }> {
    await executor.query(SECURITY_ACTION_SQL.supersede, [session.userId, session.sessionId, request.purpose])
    const generated = generateProof()
    const rows = await readRows(executor, SECURITY_ACTION_SQL.insertIssued, [
      generated.id, session.userId, session.sessionId, orgId, request.purpose, request.connectionId,
      snapshot.targetKind, request.targetIdentityId ?? null,
      request.expectedBindingRevision === undefined ? null : String(request.expectedBindingRevision),
      snapshot.targetWitness, generated.hash, request.clientBindingDigest ?? null,
      deps.policyRevision, snapshot.accessGeneration, snapshot.credentialWitness, snapshot.privilegeWitness, snapshot.privilegeClass,
    ])
    const expiresAt = rows.length === 1 ? timestampIso(rows[0].expires_at) : null
    if (expiresAt === null) throw unavailable()
    return { proof: generated.proof, expiresAt }
  }

  async function audit(session: AuthenticatedSessionContext, request: SecurityActionVerifyRequest, result: SecurityActionAuditResult, code: SecurityActionErrorCode | null, privilegeClass: PrivilegeClass | null): Promise<void> {
    try {
      await deps.recordAudit(Object.freeze({
        action: 'security_action_verify',
        resourceType: 'user-security-action',
        resourceId: `user:${session.userId}`,
        meta: Object.freeze({
          userId: session.userId,
          purpose: request.purpose,
          method: 'local_password',
          result,
          code,
          connectionId: request.connectionId,
          privilegeClass,
        }),
      }))
    } catch {
      // Audit is best effort; the outcome of the verification is already decided.
    }
  }

  async function issue(session: AuthenticatedSessionContext, request: SecurityActionVerifyRequest): Promise<IssuedSecurityActionProof> {
    if (!isSecurityActionProofEnabled()) throw new SecurityActionProofError('SECURITY_ACTION_PROOF_UNAVAILABLE')
    assertSessionContext(session)
    const parsed = parseSecurityActionVerifyRequest(request)
    if (!parsed.ok) throw new SecurityActionProofContractError('SECURITY_ACTION_INPUT_SHAPE')
    const purpose = parsed.request.purpose
    const resolver = Object.hasOwn(deps.resolvers, purpose) ? deps.resolvers[purpose] : undefined
    if (deps.isPurposeAvailable(purpose) !== true || typeof resolver !== 'function') {
      throw new SecurityActionProofError('SECURITY_ACTION_PURPOSE_UNAVAILABLE')
    }
    if (session.orgId === null) throw new SecurityActionProofError('SECURITY_ACTION_ORG_CONTEXT_REQUIRED')
    const orgId = session.orgId
    const verifyRequest = parsed.request

    let privilegeClass: PrivilegeClass | null = null
    try {
      const first = await deps.runTransaction(async (executor) => {
        await setReadCommitted(executor)
        return readIssueInputs(executor, session, verifyRequest, orgId, resolver, true)
      })
      privilegeClass = first.privilegeClass

      // Outside any transaction and without a connection.
      const verified = await deps.verifyPassword(verifyRequest.password, first.passwordHash) === true

      const outcome = await deps.runTransaction<IssueOutcome>(async (executor) => {
        await setReadCommitted(executor)
        await executor.query(SECURITY_ACTION_SQL.advisoryLock, [ADVISORY_KEY_PREFIX + session.userId])
        const locked = await readRows(executor, SECURITY_ACTION_SQL.userKeyShare, [session.userId])
        if (locked.length !== 1) throw unavailable()
        await refuseWhenRateLimited(executor, session.userId)
        if (!verified) {
          await recordRejected(executor, session, verifyRequest, orgId, first)
          return { kind: 'rejected' }
        }
        const second = await readIssueInputs(executor, session, verifyRequest, orgId, resolver, false)
        if (!snapshotsAgree(first, second)) throw new SecurityActionProofError('SECURITY_ACTION_STATE_CHANGED')
        const written = await writeProof(executor, session, verifyRequest, orgId, second)
        return { kind: 'issued', proof: written.proof, expiresAt: written.expiresAt }
      })

      if (outcome.kind === 'rejected') {
        // The rejected attempt is committed before the refusal is reported.
        throw new SecurityActionProofError('SECURITY_ACTION_CREDENTIAL_REJECTED', { nextStep: NEXT_STEP })
      }
      await audit(session, verifyRequest, 'issued', null, privilegeClass)
      return Object.freeze({
        proof: outcome.proof,
        purpose,
        connectionId: verifyRequest.connectionId,
        method: 'local_password',
        assurance: 'local_password',
        expiresAt: outcome.expiresAt,
        ttlSeconds: SECURITY_ACTION_PROOF_TTL_SECONDS,
      })
    } catch (error) {
      const refusal = asProofError(error)
      await audit(session, verifyRequest, auditResultOf(refusal.code), refusal.code, privilegeClass)
      throw refusal
    }
  }

  function assertConsumeInput(session: AuthenticatedSessionContext, input: SecurityActionConsumeInput): void {
    if (!input || typeof input !== 'object') throw new SecurityActionProofContractError('SECURITY_ACTION_INPUT_SHAPE')
    const locked = input.lockedUser
    if (!locked || typeof locked !== 'object' || locked.id !== session.userId) {
      throw new SecurityActionProofContractError('SECURITY_ACTION_LOCKED_USER_REQUIRED')
    }
    if (!isSecurityActionPurpose(input.purpose)) throw new SecurityActionProofContractError('SECURITY_ACTION_INPUT_SHAPE')
    if (input.connectionId !== null && !isUuid(input.connectionId)) throw new SecurityActionProofContractError('SECURITY_ACTION_INPUT_SHAPE')
    const target = input.target
    if (!target || typeof target !== 'object'
      || (target.kind !== 'empty_slot' && target.kind !== 'identity_revision')
      || typeof target.witness !== 'string' || !HEX64_PATTERN.test(target.witness)) {
      throw new SecurityActionProofContractError('SECURITY_ACTION_INPUT_SHAPE')
    }
    if (input.actionRef !== undefined && !isActionRef(input.actionRef)) throw new SecurityActionProofContractError('SECURITY_ACTION_INPUT_SHAPE')
    if (input.clientBinding !== undefined
      && (typeof input.clientBinding !== 'string' || input.clientBinding.length < 1 || input.clientBinding.length > CLIENT_BINDING_MAX_LENGTH)) {
      throw new SecurityActionProofContractError('SECURITY_ACTION_INPUT_SHAPE')
    }
  }

  async function assertReadCommittedTransaction(client: Queryable): Promise<void> {
    try {
      if (!client || typeof client.query !== 'function') throw new Error('Missing transaction')
      const isolation = await client.query(SECURITY_ACTION_SQL.isolation)
      if (!isolation || !Array.isArray(isolation.rows) || isolation.rows.length !== 1 || isolation.rows[0]?.isolation !== 'read committed') {
        throw new Error('Wrong isolation')
      }
      await assertInTransaction(client, 'Security action proof')
    } catch {
      throw new SecurityActionProofContractError('SECURITY_ACTION_TRANSACTION_REQUIRED')
    }
  }

  async function consume(client: Queryable, session: AuthenticatedSessionContext, input: SecurityActionConsumeInput): Promise<VerifiedSecurityAction> {
    if (!isSecurityActionProofEnabled()) throw new SecurityActionProofError('SECURITY_ACTION_PROOF_UNAVAILABLE')
    assertSessionContext(session)
    assertConsumeInput(session, input)
    if (deps.isPurposeAvailable(input.purpose) !== true) throw new SecurityActionProofError('SECURITY_ACTION_PURPOSE_UNAVAILABLE')
    const token = parseProof(input.proof)
    if (!token) throw new SecurityActionProofError('SECURITY_ACTION_PROOF_INVALID')

    await assertReadCommittedTransaction(client)
    try {
      // The user row first, then the session row, then the proof row.
      const lockedUsers = await lockUsersForAccessGraphWrite(client, [session.userId])
      if (!lockedUsers.has(session.userId)) throw new SecurityActionProofError('SECURITY_ACTION_PROOF_STALE')
      const sessionState = await readSession(client, SECURITY_ACTION_SQL.sessionForShare, session)
      const rows = await readRows(client, SECURITY_ACTION_SQL.lockProof, [token.id, session.userId])
      if (rows.length !== 1) throw new SecurityActionProofError('SECURITY_ACTION_PROOF_INVALID')
      const row = rows[0]
      if (typeof row.proof_hash !== 'string' || !hexEquals(hashProofSecret(token.secret), row.proof_hash)) {
        throw new SecurityActionProofError('SECURITY_ACTION_PROOF_INVALID')
      }
      if (typeof row.client_binding_digest === 'string') {
        if (input.clientBinding === undefined || !hexEquals(clientBindingDigestOf(input.clientBinding), row.client_binding_digest)) {
          throw new SecurityActionProofError('SECURITY_ACTION_PROOF_INVALID')
        }
      }
      if (row.session_id !== session.sessionId) throw new SecurityActionProofError('SECURITY_ACTION_PROOF_SESSION_MISMATCH')
      if (row.status === 'consumed' || row.status === 'superseded') throw new SecurityActionProofError('SECURITY_ACTION_PROOF_ALREADY_USED')
      if (row.status !== 'issued' || row.live !== true) throw new SecurityActionProofError('SECURITY_ACTION_PROOF_EXPIRED')
      const rowConnection = typeof row.connection_id === 'string' ? row.connection_id.toLowerCase() : null
      const inputConnection = input.connectionId === null ? null : input.connectionId.toLowerCase()
      if (row.purpose !== input.purpose
        || rowConnection !== inputConnection
        || row.org_id !== session.orgId
        || row.target_kind !== input.target.kind
        || row.target_witness !== input.target.witness) {
        throw new SecurityActionProofError('SECURITY_ACTION_PROOF_SCOPE_MISMATCH')
      }

      // Account and privilege, re-read on the locked user row.
      const account = await readAccount(client, session.userId)
      if (!account || accountGateDenies(account) || !localPasswordEligible(account)) throw new SecurityActionProofError('SECURITY_ACTION_PROOF_STALE')
      const recordedGeneration = toText(row.access_generation)
      if (recordedGeneration === null || !/^\d+$/.test(recordedGeneration)) throw unavailable()
      if (BigInt(recordedGeneration) !== BigInt(account.accessGeneration)) throw new SecurityActionProofError('SECURITY_ACTION_PROOF_STALE')
      if (row.credential_witness !== computeCredentialWitness(account)) throw new SecurityActionProofError('SECURITY_ACTION_PROOF_STALE')
      const privilege = await assessSecurityActionPrivilege(client, session.userId)
      if (row.privilege_witness !== privilege.witness) {
        const refusal = policyRefusal(input.purpose, privilege.privilegeClass)
        if (refusal === 'SECURITY_ACTION_HIGH_PRIVILEGE_SELF_SERVICE_DENIED') throw new SecurityActionProofError(refusal)
        throw new SecurityActionProofError('SECURITY_ACTION_PROOF_STALE')
      }
      if (Number(row.policy_revision) !== deps.policyRevision) throw new SecurityActionProofError('SECURITY_ACTION_PROOF_STALE')

      // Session, watermark and membership.
      if (!sessionState.live) throw new SecurityActionProofError('SECURITY_ACTION_PROOF_STALE')
      const watermark = await isTokenRevoked(client, session)
      const createdAtUs = toText(row.created_at_us)
      if (createdAtUs === null || !/^-?\d+$/.test(createdAtUs)) throw unavailable()
      if (watermark.revoked || (watermark.watermarkUs !== null && watermark.watermarkUs >= BigInt(createdAtUs))) {
        throw new SecurityActionProofError('SECURITY_ACTION_PROOF_STALE')
      }
      if (session.orgId === null || !(await isMember(client, session.userId, session.orgId))) throw new SecurityActionProofError('SECURITY_ACTION_PROOF_STALE')

      // The policy as recorded on the row, evaluated again with the current class.
      const recordedRefusal = policyRefusal(input.purpose, privilege.privilegeClass, {
        method: row.method, assurance: row.assurance, methodConnectionId: row.method_connection_id, connectionId: row.connection_id,
      })
      if (recordedRefusal) throw new SecurityActionProofError(recordedRefusal)

      const consumed = await readRows(client, SECURITY_ACTION_SQL.consume, [token.id, session.userId, session.sessionId, input.purpose, input.actionRef ?? null])
      if (consumed.length !== 1) {
        const reloaded = await readRows(client, SECURITY_ACTION_SQL.reloadProof, [token.id, session.userId])
        const state = reloaded[0]
        if (state && (state.status === 'consumed' || state.status === 'superseded')) throw new SecurityActionProofError('SECURITY_ACTION_PROOF_ALREADY_USED')
        if (state && state.status === 'issued' && state.live !== true) throw new SecurityActionProofError('SECURITY_ACTION_PROOF_EXPIRED')
        throw new SecurityActionProofError('SECURITY_ACTION_PROOF_STALE')
      }
      const verifiedAt = timestampIso(consumed[0].created_at)
      const privilegeClass = consumed[0].privilege_class
      if (verifiedAt === null || typeof consumed[0].id !== 'string' || (privilegeClass !== 'standard' && privilegeClass !== 'high')) throw unavailable()
      return Object.freeze({
        proofId: consumed[0].id,
        verifiedAt,
        method: String(consumed[0].method),
        assurance: String(consumed[0].assurance),
        privilegeClass,
        purpose: input.purpose,
        connectionId: input.connectionId,
      })
    } catch (error) {
      throw asProofError(error)
    }
  }

  return Object.freeze({ issue, consume })
}

// ---------------------------------------------------------------------------
// Production binding: no injection point.
// ---------------------------------------------------------------------------

async function auditSecurityAction(event: SecurityActionAuditEvent): Promise<void> {
  await auditLog({
    actorId: event.meta.userId,
    actorType: 'user',
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    meta: event.meta,
  })
}

const PRODUCTION = createSecurityActionProofService(Object.freeze({
  isPurposeAvailable: isSecurityActionPurposeAvailable,
  resolvers: Object.freeze({}),
  runTransaction: transaction,
  verifyPassword: (password: string, hash: string) => bcrypt.compare(password, hash),
  recordAudit: auditSecurityAction,
  policyRevision: SECURITY_ACTION_POLICY_REVISION,
}))

export const issueSecurityActionProof = PRODUCTION.issue
export const consumeSecurityActionProof = PRODUCTION.consume
