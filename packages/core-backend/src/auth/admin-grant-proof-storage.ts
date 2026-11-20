import { createHash, timingSafeEqual } from 'node:crypto'
import { ADMIN_GRANT_INTENT_HASH_DOMAIN } from './admin-login-grant-intent'
import type { Queryable } from '../multitable/automation-durable-dispatcher'

export const ADMIN_GRANT_PROOF_PURPOSE = 'admin_login_grant_enable' as const
export const ADMIN_GRANT_PROOF_TARGET_KIND = 'confirmed_identity_set' as const
export const ADMIN_GRANT_PROOF_METHOD = 'local_password' as const
export const ADMIN_GRANT_PROOF_ASSURANCE = 'local_password' as const
export const ADMIN_GRANT_PROOF_TTL_SECONDS = 300
export const ADMIN_GRANT_PROOF_POLICY_REVISION = 1
export const ADMIN_GRANT_PROOF_HASH_DOMAIN = 'metasheet:admin-grant-proof:v1|'
export const ADMIN_GRANT_COMMAND_KEY_DOMAIN = 'metasheet:admin-login-grant-command:v1|'
export const ADMIN_GRANT_FAILURE_CODE = 'credential_rejected' as const

const PROOF_PATTERN = /^agp1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEX64_PATTERN = /^[0-9a-f]{64}$/
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/
const SIGNED_PATTERN = /^-?(0|[1-9][0-9]*)$/
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/

export class AdminGrantProofStorageError extends Error {
  readonly code = 'ADMIN_GRANT_PROOF_STORAGE_REFUSED'
  readonly sqlState?: string

  constructor(sqlState?: string) {
    super('Admin grant proof storage refused')
    this.name = 'AdminGrantProofStorageError'
    if (sqlState) this.sqlState = sqlState
  }
}

export type AdminGrantPrivilegeClass = 'standard' | 'high'

export type AdminGrantFailedProofWrite = Readonly<{
  id: string
  userId: string
  sessionId: string
  orgId: string
  connectionId: string
  targetWitness: string
  accessGeneration: string
  credentialWitness: string
  privilegeWitness: string
  privilegeClass: AdminGrantPrivilegeClass
}>

export type AdminGrantProofChildWrite = Readonly<{
  ordinal: number
  userId: string
  identityId: string
  bindingRevision: string
  evidenceId: string
  evidenceWitness: string
  accessGeneration: string
  privilegeWitness: string
}>

export type AdminGrantIssuedProofWrite = Readonly<{
  id: string
  userId: string
  sessionId: string
  orgId: string
  connectionId: string
  targetWitness: string
  proofHash: string
  clientBindingDigest: string
  accessGeneration: string
  credentialWitness: string
  privilegeWitness: string
  privilegeClass: AdminGrantPrivilegeClass
  canonicalIntent: string
  commandId: string
  applicationRevision: string
  browserBindingId: string
  credentialEstablishmentId: string
  credentialVersion: string
  watermarkUs: string
  tokenIssuedAt: number
  sessionExpiresAt: string
  browserExpiresAt: string
  children: readonly AdminGrantProofChildWrite[]
}>

export type AdminGrantStoredProofHeader = Readonly<{
  id: string
  userId: string
  sessionId: string
  orgId: string
  connectionId: string
  purpose: typeof ADMIN_GRANT_PROOF_PURPOSE
  targetKind: typeof ADMIN_GRANT_PROOF_TARGET_KIND
  status: 'issued' | 'consumed' | 'superseded' | 'failed'
  assurance: typeof ADMIN_GRANT_PROOF_ASSURANCE | null
  proofHash: string | null
  clientBindingDigest: string | null
  targetWitness: string
  accessGeneration: string
  credentialWitness: string
  privilegeWitness: string
  privilegeClass: AdminGrantPrivilegeClass
  failureCode: typeof ADMIN_GRANT_FAILURE_CODE | null
  createdAt: string
  expiresAt: string | null
  tokenIssuedAt: number | null
}>

export type AdminGrantStoredSeal = Readonly<{
  challengeId: string
  canonicalIntent: string
  commandId: string
  applicationRevision: string
  targetCount: number
  browserBindingId: string
  credentialEstablishmentId: string
  credentialVersion: string
  watermarkUs: string
  tokenIssuedAt: number
  sessionExpiresAt: string
}>

function refuse(error?: unknown): never {
  const sqlState = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    && SQLSTATE_PATTERN.test((error as { code: string }).code)
    ? (error as { code: string }).code
    : undefined
  throw new AdminGrantProofStorageError(sqlState)
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

function opaque(value: string): string {
  if (value.length === 0 || value.trim() !== value || value.includes('\u0000') || hasUnpairedSurrogate(value)) refuse()
  return value
}

function uuid(value: string): string {
  if (!UUID_PATTERN.test(value)) refuse()
  return value
}

function hex64(value: string): string {
  if (!HEX64_PATTERN.test(value)) refuse()
  return value
}

function decimal(value: string): string {
  if (!DECIMAL_PATTERN.test(value)) refuse()
  return value
}

function privilegeClass(value: string): AdminGrantPrivilegeClass {
  if (value !== 'standard' && value !== 'high') refuse()
  return value
}

function canonicalSecret(secret: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return null
  const bytes = Buffer.from(secret, 'base64url')
  if (bytes.length !== 32 || bytes.toString('base64url') !== secret) return null
  return bytes
}

export function parseAdminGrantProof(proof: unknown): { id: string; secret: string } | null {
  if (typeof proof !== 'string') return null
  const match = PROOF_PATTERN.exec(proof)
  if (!match) return null
  const secret = canonicalSecret(match[2])
  if (!secret) return null
  return { id: match[1], secret: match[2] }
}

export function hashAdminGrantProofSecret(secret: string): string | null {
  const bytes = canonicalSecret(secret)
  if (!bytes) return null
  return createHash('sha256').update(ADMIN_GRANT_PROOF_HASH_DOMAIN, 'utf8').update(bytes).digest('hex')
}

export function adminGrantDigestEqual(expectedHex: string, actualHex: string): boolean {
  if (!HEX64_PATTERN.test(expectedHex) || !HEX64_PATTERN.test(actualHex)) return false
  return timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(actualHex, 'hex'))
}

export function adminGrantIntentDigest(canonicalIntent: string): string {
  return createHash('sha256')
    .update(ADMIN_GRANT_INTENT_HASH_DOMAIN, 'utf8')
    .update(canonicalIntent, 'utf8')
    .digest('hex')
}

export function adminGrantCommandKey(actorId: string, orgId: string, commandId: string): string {
  return createHash('sha256')
    .update(ADMIN_GRANT_COMMAND_KEY_DOMAIN, 'utf8')
    .update(JSON.stringify([ADMIN_GRANT_PROOF_PURPOSE, actorId, orgId, commandId]), 'utf8')
    .digest('hex')
}

export function adminGrantCommandActionRef(actorId: string, orgId: string, commandId: string): string {
  return `agc:${adminGrantCommandKey(actorId, orgId, commandId)}`
}

async function rowsOf(db: Queryable, text: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
  try {
    const result = await db.query(text, params)
    if (!result || !Array.isArray(result.rows)) refuse()
    return result.rows
  } catch (error) {
    if (error instanceof AdminGrantProofStorageError) throw error
    refuse(error)
  }
}

function textOf(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') refuse()
  return value
}

function nullableText(row: Record<string, unknown>, key: string): string | null {
  const value = row[key]
  if (value === null) return null
  if (typeof value !== 'string') refuse()
  return value
}

function timestampOf(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  if (typeof value === 'string' && value.length > 0) return value
  refuse()
}

function sessionExpiryText(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)) refuse()
  return value
}

function validateChildren(actorId: string, children: readonly AdminGrantProofChildWrite[]): void {
  if (!Array.isArray(children) || children.length === 0) refuse()
  const users = new Set<string>()
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]
    if (!child || child.ordinal !== index + 1) refuse()
    opaque(child.userId)
    if (child.userId === actorId || users.has(child.userId)) refuse()
    users.add(child.userId)
    uuid(child.identityId)
    decimal(child.bindingRevision)
    opaque(child.evidenceId)
    opaque(child.evidenceWitness)
    decimal(child.accessGeneration)
    hex64(child.privilegeWitness)
  }
}

export async function insertFailedAdminGrantProof(db: Queryable, write: AdminGrantFailedProofWrite): Promise<void> {
  uuid(write.id)
  opaque(write.userId)
  opaque(write.sessionId)
  opaque(write.orgId)
  uuid(write.connectionId)
  hex64(write.targetWitness)
  decimal(write.accessGeneration)
  hex64(write.credentialWitness)
  hex64(write.privilegeWitness)
  privilegeClass(write.privilegeClass)
  await rowsOf(db, `INSERT INTO security_action_challenges
    (id, user_id, session_id, org_id, purpose, connection_id, target_kind, target_identity_id,
     expected_binding_revision, target_witness, method, method_connection_id, assurance, status,
     failure_code, proof_hash, client_binding_digest, policy_revision, access_generation,
     credential_witness, privilege_witness, privilege_class, expires_at)
  VALUES ($1::uuid, $2, $3, $4, 'admin_login_grant_enable', $5::uuid, 'confirmed_identity_set', NULL,
          NULL, $6, 'local_password', NULL, NULL, 'failed', 'credential_rejected', NULL, NULL,
          1, $7::bigint, $8, $9, $10, NULL)`, [
    write.id,
    write.userId,
    write.sessionId,
    write.orgId,
    write.connectionId,
    write.targetWitness,
    write.accessGeneration,
    write.credentialWitness,
    write.privilegeWitness,
    write.privilegeClass,
  ])
}

export async function supersedeIssuedAdminGrantProof(db: Queryable, userId: string, sessionId: string): Promise<void> {
  opaque(userId)
  opaque(sessionId)
  await rowsOf(db, `UPDATE security_action_challenges
     SET status = 'superseded', superseded_at = clock_timestamp()
   WHERE user_id = $1 AND session_id = $2 AND purpose = 'admin_login_grant_enable' AND status = 'issued'`, [
    userId,
    sessionId,
  ])
}

export async function insertIssuedAdminGrantProofSet(
  db: Queryable,
  write: AdminGrantIssuedProofWrite,
): Promise<{ createdAt: string; expiresAt: string }> {
  uuid(write.id)
  opaque(write.userId)
  opaque(write.sessionId)
  opaque(write.orgId)
  uuid(write.connectionId)
  hex64(write.targetWitness)
  hex64(write.proofHash)
  hex64(write.clientBindingDigest)
  decimal(write.accessGeneration)
  hex64(write.credentialWitness)
  hex64(write.privilegeWitness)
  privilegeClass(write.privilegeClass)
  opaque(write.canonicalIntent)
  opaque(write.commandId)
  decimal(write.applicationRevision)
  uuid(write.browserBindingId)
  uuid(write.credentialEstablishmentId)
  uuid(write.credentialVersion)
  if (!SIGNED_PATTERN.test(write.watermarkUs)) refuse()
  if (!Number.isSafeInteger(write.tokenIssuedAt) || write.tokenIssuedAt <= 0) refuse()
  if (typeof write.sessionExpiresAt !== 'string' || write.sessionExpiresAt.length === 0) refuse()
  if (typeof write.browserExpiresAt !== 'string' || write.browserExpiresAt.length === 0) refuse()
  if (adminGrantIntentDigest(write.canonicalIntent) !== write.targetWitness) refuse()
  validateChildren(write.userId, write.children)
  const inserted = await rowsOf(db, `INSERT INTO security_action_challenges
    (id, user_id, session_id, org_id, purpose, connection_id, target_kind, target_identity_id,
     expected_binding_revision, target_witness, method, method_connection_id, assurance, status,
     failure_code, proof_hash, client_binding_digest, policy_revision, access_generation,
     credential_witness, privilege_witness, privilege_class, expires_at)
  VALUES ($1::uuid, $2, $3, $4, 'admin_login_grant_enable', $5::uuid, 'confirmed_identity_set', NULL,
          NULL, $6, 'local_password', NULL, 'local_password', 'issued', NULL, $7, $8,
          1, $9::bigint, $10, $11, $12,
          LEAST(now() + interval '300 seconds', $13::timestamptz, $14::timestamptz))
  RETURNING created_at, expires_at`, [
    write.id,
    write.userId,
    write.sessionId,
    write.orgId,
    write.connectionId,
    write.targetWitness,
    write.proofHash,
    write.clientBindingDigest,
    write.accessGeneration,
    write.credentialWitness,
    write.privilegeWitness,
    write.privilegeClass,
    write.sessionExpiresAt,
    write.browserExpiresAt,
  ])
  const header = inserted[0]
  if (inserted.length !== 1 || !header) refuse()
  for (const child of write.children) {
    await rowsOf(db, `INSERT INTO admin_grant_proof_targets
      (challenge_id, ordinal, user_id, identity_id, binding_revision, evidence_id, evidence_witness,
       access_generation, privilege_witness)
    VALUES ($1::uuid, $2::integer, $3, $4::uuid, $5::bigint, $6, $7, $8::bigint, $9)`, [
      write.id,
      child.ordinal,
      child.userId,
      child.identityId,
      child.bindingRevision,
      child.evidenceId,
      child.evidenceWitness,
      child.accessGeneration,
      child.privilegeWitness,
    ])
  }
  await rowsOf(db, `INSERT INTO admin_grant_proof_seals
    (challenge_id, canonical_intent, command_id, application_revision, target_count,
     browser_binding_id, credential_establishment_id, credential_version, watermark_us,
     token_issued_at, session_expires_at)
  VALUES ($1::uuid, $2, $3, $4, $5::integer, $6::uuid, $7::uuid, $8::uuid, $9, $10::bigint, $11::timestamptz)`, [
    write.id,
    write.canonicalIntent,
    write.commandId,
    write.applicationRevision,
    write.children.length,
    write.browserBindingId,
    write.credentialEstablishmentId,
    write.credentialVersion,
    write.watermarkUs,
    write.tokenIssuedAt,
    write.sessionExpiresAt,
  ])
  return { createdAt: timestampOf(header.created_at), expiresAt: timestampOf(header.expires_at) }
}

export async function lockAdminGrantProof(
  db: Queryable,
  id: string,
  userId: string,
): Promise<AdminGrantStoredProofHeader | null> {
  uuid(id)
  opaque(userId)
  const found = await rowsOf(db, `${HEADER_SQL} FOR UPDATE`, [id, userId])
  const row = found[0]
  if (found.length === 0 || !row) return null
  if (found.length !== 1) refuse()
  return headerFrom(row)
}

export async function readAdminGrantProofSeal(db: Queryable, challengeId: string): Promise<AdminGrantStoredSeal | null> {
  uuid(challengeId)
  const found = await rowsOf(db, `SELECT challenge_id::text AS challenge_id, canonical_intent, command_id,
            application_revision, target_count, browser_binding_id::text AS browser_binding_id,
            credential_establishment_id::text AS credential_establishment_id,
            credential_version::text AS credential_version, watermark_us,
            token_issued_at::text AS token_issued_at,
            to_char(session_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS session_expires_at
       FROM admin_grant_proof_seals
      WHERE challenge_id = $1::uuid`, [challengeId])
  const row = found[0]
  if (found.length === 0 || !row) return null
  if (found.length !== 1) refuse()
  const tokenIssuedAt = Number(textOf(row, 'token_issued_at'))
  const targetCount = row.target_count
  if (!Number.isSafeInteger(tokenIssuedAt) || tokenIssuedAt <= 0) refuse()
  if (typeof targetCount !== 'number' || !Number.isSafeInteger(targetCount) || targetCount < 1) refuse()
  return {
    challengeId: textOf(row, 'challenge_id'),
    canonicalIntent: textOf(row, 'canonical_intent'),
    commandId: textOf(row, 'command_id'),
    applicationRevision: textOf(row, 'application_revision'),
    targetCount,
    browserBindingId: textOf(row, 'browser_binding_id'),
    credentialEstablishmentId: textOf(row, 'credential_establishment_id'),
    credentialVersion: textOf(row, 'credential_version'),
    watermarkUs: textOf(row, 'watermark_us'),
    tokenIssuedAt,
    sessionExpiresAt: sessionExpiryText(row.session_expires_at),
  }
}

export type AdminGrantStoredChild = Readonly<{
  ordinal: number
  userId: string
  identityId: string
  bindingRevision: string
  evidenceId: string
  evidenceWitness: string
  accessGeneration: string
  privilegeWitness: string
}>

const HEADER_SQL = `SELECT id::text AS id, user_id, session_id, org_id, connection_id::text AS connection_id,
            purpose, target_kind, status, assurance, proof_hash, client_binding_digest, target_witness,
            access_generation::text AS access_generation, credential_witness, privilege_witness, privilege_class,
            failure_code, created_at, expires_at
       FROM security_action_challenges
      WHERE id = $1::uuid AND user_id = $2 AND purpose = 'admin_login_grant_enable'`

function headerFrom(row: Record<string, unknown>): AdminGrantStoredProofHeader {
  const status = textOf(row, 'status')
  if (status !== 'issued' && status !== 'consumed' && status !== 'superseded' && status !== 'failed') refuse()
  const assuranceText = nullableText(row, 'assurance')
  const assurance = assuranceText === ADMIN_GRANT_PROOF_ASSURANCE
    ? ADMIN_GRANT_PROOF_ASSURANCE
    : assuranceText === null
      ? null
      : refuse()
  const failureText = nullableText(row, 'failure_code')
  const failureCode = failureText === ADMIN_GRANT_FAILURE_CODE
    ? ADMIN_GRANT_FAILURE_CODE
    : failureText === null
      ? null
      : refuse()
  const orgId = nullableText(row, 'org_id')
  const connectionId = nullableText(row, 'connection_id')
  if (orgId === null || connectionId === null) refuse()
  return {
    id: textOf(row, 'id'),
    userId: textOf(row, 'user_id'),
    sessionId: textOf(row, 'session_id'),
    orgId,
    connectionId,
    purpose: 'admin_login_grant_enable',
    targetKind: 'confirmed_identity_set',
    status,
    assurance,
    proofHash: nullableText(row, 'proof_hash'),
    clientBindingDigest: nullableText(row, 'client_binding_digest'),
    targetWitness: textOf(row, 'target_witness'),
    accessGeneration: textOf(row, 'access_generation'),
    credentialWitness: textOf(row, 'credential_witness'),
    privilegeWitness: textOf(row, 'privilege_witness'),
    privilegeClass: privilegeClass(textOf(row, 'privilege_class')),
    failureCode,
    createdAt: timestampOf(row.created_at),
    expiresAt: row.expires_at == null ? null : timestampOf(row.expires_at),
    tokenIssuedAt: null,
  }
}

export async function readAdminGrantProofHeader(
  db: Queryable,
  id: string,
  userId: string,
): Promise<AdminGrantStoredProofHeader | null> {
  uuid(id)
  opaque(userId)
  const found = await rowsOf(db, HEADER_SQL, [id, userId])
  const row = found[0]
  if (found.length === 0 || !row) return null
  if (found.length !== 1) refuse()
  return headerFrom(row)
}

export async function readAdminGrantProofChildren(
  db: Queryable,
  challengeId: string,
): Promise<readonly AdminGrantStoredChild[]> {
  uuid(challengeId)
  const found = await rowsOf(db, `SELECT ordinal, user_id, identity_id::text AS identity_id,
            binding_revision::text AS binding_revision, evidence_id, evidence_witness,
            access_generation::text AS access_generation, privilege_witness
       FROM admin_grant_proof_targets
      WHERE challenge_id = $1::uuid
      ORDER BY ordinal`, [challengeId])
  return found.map((row, index) => {
    const ordinal = row.ordinal
    const ordinalText = typeof ordinal === 'number' ? String(ordinal) : typeof ordinal === 'string' ? ordinal : ''
    if (!DECIMAL_PATTERN.test(ordinalText)) refuse()
    const ordinalNumber = Number(ordinalText)
    if (!Number.isSafeInteger(ordinalNumber) || ordinalNumber !== index + 1) refuse()
    return {
      ordinal: ordinalNumber,
      userId: opaque(textOf(row, 'user_id')),
      identityId: uuid(textOf(row, 'identity_id')),
      bindingRevision: decimal(textOf(row, 'binding_revision')),
      evidenceId: opaque(textOf(row, 'evidence_id')),
      evidenceWitness: opaque(textOf(row, 'evidence_witness')),
      accessGeneration: decimal(textOf(row, 'access_generation')),
      privilegeWitness: hex64(textOf(row, 'privilege_witness')),
    }
  })
}

export async function consumeAdminGrantProof(
  db: Queryable,
  id: string,
  userId: string,
  sessionId: string,
  actionRef: string,
): Promise<boolean> {
  uuid(id)
  opaque(userId)
  opaque(sessionId)
  if (!/^agc:[0-9a-f]{64}$/.test(actionRef)) refuse()
  const found = await rowsOf(db, `UPDATE security_action_challenges
      SET status = 'consumed', consumed_at = clock_timestamp(), consumed_action_ref = $4
    WHERE id = $1::uuid AND user_id = $2 AND session_id = $3
      AND purpose = 'admin_login_grant_enable' AND status = 'issued'
      AND expires_at > clock_timestamp()
    RETURNING id::text AS id`, [id, userId, sessionId, actionRef])
  return found.length === 1
}
