/**
 * Eligible local-credential establishment for admin login grant.
 * The version UUID is assigned by the database trigger. This module records
 * only the current required-password-change of a genuine session.
 */
import { transaction as runPoolTransaction } from '../db/pg'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { evaluateUserAuthenticationGate } from './user-activation'
import {
  assertAuthenticatedSessionContext,
  SecurityActionProofContractError,
  type AuthenticatedSessionContext,
} from './security-action-proof'

export const ADMIN_GRANT_ACTOR_INPUT_CODES = [
  'ADMIN_GRANT_BROWSER_ORIGIN_INVALID',
  'ADMIN_GRANT_BROWSER_ORIGIN_MISMATCH',
  'ADMIN_GRANT_BROWSER_CONTEXT_REQUIRED',
  'ADMIN_GRANT_BROWSER_COOKIE_REQUIRED',
  'ADMIN_GRANT_BROWSER_COOKIE_MISMATCH',
  'ADMIN_GRANT_BROWSER_COOKIE_LOST',
  'ADMIN_GRANT_BROWSER_UNAVAILABLE',
  'ADMIN_GRANT_BROWSER_SESSION_STALE',
  'ADMIN_GRANT_CREDENTIAL_UNAVAILABLE',
  'ADMIN_GRANT_CREDENTIAL_INELIGIBLE',
] as const

export type AdminGrantActorInputCode = (typeof ADMIN_GRANT_ACTOR_INPUT_CODES)[number]

export class AdminGrantActorInputError extends Error {
  readonly code: AdminGrantActorInputCode
  constructor(code: AdminGrantActorInputCode) {
    super('Admin grant actor input refused')
    this.name = 'AdminGrantActorInputError'
    this.code = code
  }
}

export type AdminGrantActorInputSchemaState = 'absent' | 'ready' | 'partial'

export type AdminGrantTransactionRunner = <T>(
  handler: (executor: Queryable) => Promise<T>,
) => Promise<T>

export type AdminGrantRequiredPasswordChange = Readonly<{
  session: AuthenticatedSessionContext
  passwordHash: string
}>

export type AdminGrantCredentialEstablishment = Readonly<{
  establishmentId: string
  userId: string
  credentialVersion: string
  sourceSessionId: string
  kind: 'self_password_change'
  establishedAt: string
}>

export type AdminGrantLocalCredentialWitness = Readonly<{
  userId: string
  credentialVersion: string
  establishmentId: string
  sourceSessionId: string
  kind: 'self_password_change'
  establishedAt: string
}>

const IDENT = /^[a-z_][a-z0-9_]*$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const BCRYPT_HASH = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/
const INTEGER_TEXT = /^-?\d+$/
// pg_trigger.tgtype bits: ROW=1, BEFORE=2, INSERT=4, DELETE=8, UPDATE=16, TRUNCATE=32.
// Ready attachments are enabled ('O') and call the owned zero-arg trigger function.
const BASELINE_REASON = 'admin-grant-baseline'
const ADVANCE_REASON = 'password-change-required-cleared'
const SET_READ_COMMITTED = 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED'
const SET_LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
const SET_STATEMENT_TIMEOUT = "SET LOCAL statement_timeout = '30s'"

const CLASSIFY_SQL = `WITH install AS (
  SELECT candidate.nspname AS schema_name
    FROM pg_catalog.unnest(pg_catalog.current_schemas(false)) WITH ORDINALITY AS candidate(nspname, ord)
   WHERE candidate.nspname <> 'information_schema'
     AND pg_catalog.left(candidate.nspname, 3) <> 'pg_'
   ORDER BY candidate.ord
   LIMIT 1
)
SELECT install.schema_name,
       EXISTS (
         SELECT 1
           FROM pg_catalog.pg_attribute att
           JOIN pg_catalog.pg_class rel ON rel.oid = att.attrelid
           JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
          WHERE ns.nspname = install.schema_name
            AND rel.relname = 'users'
            AND att.attname = 'local_credential_version'
            AND att.attnum > 0
            AND NOT att.attisdropped
       ) AS version_column,
       EXISTS (
         SELECT 1
           FROM pg_catalog.pg_attribute att
           JOIN pg_catalog.pg_class rel ON rel.oid = att.attrelid
           JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
           JOIN pg_catalog.pg_type typ ON typ.oid = att.atttypid
           JOIN pg_catalog.pg_namespace typns ON typns.oid = typ.typnamespace
          WHERE ns.nspname = install.schema_name
            AND rel.relname = 'users'
            AND att.attname = 'local_credential_version'
            AND att.attnum > 0
            AND NOT att.attisdropped
            AND NOT att.attnotnull
            AND NOT att.atthasdef
            AND typ.typname = 'uuid'
            AND typns.nspname = 'pg_catalog'
       ) AS version_ready,
       (pg_catalog.to_regclass(pg_catalog.format('%I.%I', install.schema_name, 'user_local_credential_establishments')) IS NOT NULL) AS establishments,
       (pg_catalog.to_regclass(pg_catalog.format('%I.%I', install.schema_name, 'security_action_browser_bindings')) IS NOT NULL) AS bindings,
       EXISTS (
         SELECT 1 FROM pg_catalog.pg_proc proc
           JOIN pg_catalog.pg_namespace ns ON ns.oid = proc.pronamespace
          WHERE ns.nspname = install.schema_name AND proc.proname = 'admin_grant_local_credential_version'
       ) AS version_fn,
       EXISTS (
         SELECT 1 FROM pg_catalog.pg_proc proc
           JOIN pg_catalog.pg_namespace ns ON ns.oid = proc.pronamespace
          WHERE ns.nspname = install.schema_name AND proc.proname = 'admin_grant_local_credential_establishment_guard'
       ) AS establishment_fn,
       EXISTS (
         SELECT 1 FROM pg_catalog.pg_proc proc
           JOIN pg_catalog.pg_namespace ns ON ns.oid = proc.pronamespace
          WHERE ns.nspname = install.schema_name AND proc.proname = 'admin_grant_browser_binding_guard'
       ) AS browser_fn,
       EXISTS (
         SELECT 1 FROM pg_catalog.pg_trigger tg
           JOIN pg_catalog.pg_class rel ON rel.oid = tg.tgrelid
           JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
           JOIN pg_catalog.pg_proc proc ON proc.oid = tg.tgfoid
           JOIN pg_catalog.pg_namespace fns ON fns.oid = proc.pronamespace
          WHERE ns.nspname = install.schema_name
            AND rel.relname = 'users'
            AND tg.tgname = 'admin_grant_local_credential_version'
            AND NOT tg.tgisinternal
            AND tg.tgenabled = 'O'
            AND tg.tgtype = 23
            AND fns.nspname = install.schema_name
            AND proc.proname = 'admin_grant_local_credential_version'
            AND proc.pronargs = 0
            AND proc.prokind = 'f'
            AND proc.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
       ) AS version_trigger,
       EXISTS (
         SELECT 1 FROM pg_catalog.pg_trigger tg
           JOIN pg_catalog.pg_class rel ON rel.oid = tg.tgrelid
           JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
           JOIN pg_catalog.pg_proc proc ON proc.oid = tg.tgfoid
           JOIN pg_catalog.pg_namespace fns ON fns.oid = proc.pronamespace
          WHERE ns.nspname = install.schema_name
            AND rel.relname = 'user_local_credential_establishments'
            AND tg.tgname = 'admin_grant_local_credential_establishment_truncate'
            AND NOT tg.tgisinternal
            AND tg.tgenabled = 'O'
            AND tg.tgtype = 34
            AND fns.nspname = install.schema_name
            AND proc.proname = 'admin_grant_local_credential_establishment_guard'
            AND proc.pronargs = 0
            AND proc.prokind = 'f'
            AND proc.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
       ) AS establishment_truncate,
       EXISTS (
         SELECT 1 FROM pg_catalog.pg_trigger tg
           JOIN pg_catalog.pg_class rel ON rel.oid = tg.tgrelid
           JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
           JOIN pg_catalog.pg_proc proc ON proc.oid = tg.tgfoid
           JOIN pg_catalog.pg_namespace fns ON fns.oid = proc.pronamespace
          WHERE ns.nspname = install.schema_name
            AND rel.relname = 'security_action_browser_bindings'
            AND tg.tgname = 'admin_grant_browser_binding_truncate'
            AND NOT tg.tgisinternal
            AND tg.tgenabled = 'O'
            AND tg.tgtype = 34
            AND fns.nspname = install.schema_name
            AND proc.proname = 'admin_grant_browser_binding_guard'
            AND proc.pronargs = 0
            AND proc.prokind = 'f'
            AND proc.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
       ) AS browser_truncate,
       EXISTS (
         SELECT 1 FROM pg_catalog.pg_trigger tg
           JOIN pg_catalog.pg_class rel ON rel.oid = tg.tgrelid
           JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
           JOIN pg_catalog.pg_proc proc ON proc.oid = tg.tgfoid
           JOIN pg_catalog.pg_namespace fns ON fns.oid = proc.pronamespace
          WHERE ns.nspname = install.schema_name
            AND rel.relname = 'user_local_credential_establishments'
            AND tg.tgname = 'admin_grant_local_credential_establishment_guard'
            AND NOT tg.tgisinternal
            AND tg.tgenabled = 'O'
            AND tg.tgtype = 31
            AND fns.nspname = install.schema_name
            AND proc.proname = 'admin_grant_local_credential_establishment_guard'
            AND proc.pronargs = 0
            AND proc.prokind = 'f'
            AND proc.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
       ) AS establishment_row,
       EXISTS (
         SELECT 1 FROM pg_catalog.pg_trigger tg
           JOIN pg_catalog.pg_class rel ON rel.oid = tg.tgrelid
           JOIN pg_catalog.pg_namespace ns ON ns.oid = rel.relnamespace
           JOIN pg_catalog.pg_proc proc ON proc.oid = tg.tgfoid
           JOIN pg_catalog.pg_namespace fns ON fns.oid = proc.pronamespace
          WHERE ns.nspname = install.schema_name
            AND rel.relname = 'security_action_browser_bindings'
            AND tg.tgname = 'admin_grant_browser_binding_guard'
            AND NOT tg.tgisinternal
            AND tg.tgenabled = 'O'
            AND tg.tgtype = 31
            AND fns.nspname = install.schema_name
            AND proc.proname = 'admin_grant_browser_binding_guard'
            AND proc.pronargs = 0
            AND proc.prokind = 'f'
            AND proc.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
       ) AS browser_row
  FROM install`

function qualify(schema: string, relation: string): string {
  if (!IDENT.test(schema) || !IDENT.test(relation)) {
    throw new AdminGrantActorInputError('ADMIN_GRANT_CREDENTIAL_UNAVAILABLE')
  }
  return `"${schema}"."${relation}"`
}

export function adminGrantCredentialStatements(schema: string): Readonly<{
  setReadCommitted: string
  setLockTimeout: string
  setStatementTimeout: string
  lockUser: string
  baselineWatermark: string
  lockWatermark: string
  lockSession: string
  updateCredential: string
  insertEstablishment: string
  advanceWatermark: string
  readCredential: string
}> {
  const users = qualify(schema, 'users')
  const revocations = qualify(schema, 'user_session_revocations')
  const sessions = qualify(schema, 'user_sessions')
  const establishments = qualify(schema, 'user_local_credential_establishments')
  return Object.freeze({
    setReadCommitted: SET_READ_COMMITTED,
    setLockTimeout: SET_LOCK_TIMEOUT,
    setStatementTimeout: SET_STATEMENT_TIMEOUT,
    lockUser: `SELECT u.id,
       u.local_password_set,
       u.must_change_password,
       u.activation_status,
       u.is_active,
       u.role,
       u.local_credential_version::text AS local_credential_version,
       (pg_catalog.to_jsonb(u) ->> 'deleted_at') AS deleted_at,
       (pg_catalog.to_jsonb(u) ->> 'purged_at') AS purged_at
  FROM ${users} u
 WHERE u.id = $1
   FOR UPDATE`,
    baselineWatermark: `INSERT INTO ${revocations} (user_id, revoked_after, updated_at, updated_by, reason)
VALUES ($1, TIMESTAMPTZ '1970-01-01 00:00:00+00', pg_catalog.clock_timestamp(), $1, $2)
ON CONFLICT (user_id) DO NOTHING`,
    lockWatermark: `SELECT floor(extract(epoch FROM revoked_after) * 1000)::text AS revoked_after_ms,
       floor(extract(epoch FROM revoked_after) * 1000000)::text AS revoked_after_us
  FROM ${revocations}
 WHERE user_id = $1
   FOR UPDATE`,
    lockSession: `SELECT s.user_id,
       (s.revoked_at IS NULL AND s.expires_at > pg_catalog.clock_timestamp()) AS live
  FROM ${sessions} s
 WHERE s.id = $1
   FOR SHARE`,
    updateCredential: `UPDATE ${users}
   SET password_hash = $1,
       must_change_password = FALSE,
       local_password_set = TRUE,
       updated_at = pg_catalog.clock_timestamp()
 WHERE id = $2
   AND must_change_password IS TRUE
RETURNING local_credential_version::text AS local_credential_version`,
    insertEstablishment: `INSERT INTO ${establishments} (user_id, credential_version, kind, source_session_id)
VALUES ($1, $2::uuid, 'self_password_change', $3)
RETURNING id::text AS establishment_id, established_at`,
    advanceWatermark: `UPDATE ${revocations}
   SET revoked_after = GREATEST(revoked_after, pg_catalog.clock_timestamp()),
       updated_at = pg_catalog.clock_timestamp(),
       updated_by = $2,
       reason = $3
 WHERE user_id = $1
RETURNING floor(extract(epoch FROM revoked_after) * 1000000)::text AS watermark_us`,
    readCredential: `SELECT u.local_credential_version::text AS credential_version,
       u.local_password_set,
       u.must_change_password,
       (u.password_hash IS NOT NULL) AS hash_present,
       e.id::text AS establishment_id,
       e.source_session_id,
       e.kind,
       e.established_at
  FROM ${users} u
  JOIN ${establishments} e
    ON e.user_id = u.id
   AND e.credential_version = u.local_credential_version
 WHERE u.id = $1
   AND e.kind = 'self_password_change'`,
  })
}

const defaultTransaction: AdminGrantTransactionRunner = (handler) => runPoolTransaction((client) => handler(client))

function unavailable(): AdminGrantActorInputError {
  return new AdminGrantActorInputError('ADMIN_GRANT_CREDENTIAL_UNAVAILABLE')
}

function isBcryptHash(value: unknown): value is string {
  return typeof value === 'string' && BCRYPT_HASH.test(value)
}

function lowerUuid(value: unknown): string | null {
  const text = textOf(value)
  if (text === null) return null
  const lower = text.toLowerCase()
  return UUID.test(lower) ? lower : null
}

function ineligible(): AdminGrantActorInputError {
  return new AdminGrantActorInputError('ADMIN_GRANT_CREDENTIAL_INELIGIBLE')
}

async function readRows(executor: Queryable, statement: string, params: readonly unknown[]): Promise<Array<Record<string, unknown>>> {
  const result = await executor.query(statement, [...params])
  if (!result || !Array.isArray(result.rows)) throw unavailable()
  return result.rows
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function timestampIso(value: unknown): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null
  if (typeof value === 'string') {
    const parsed = new Date(value)
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null
  }
  return null
}

function tokenExceedsWatermark(tokenIssuedAt: number, watermarkMs: string): boolean {
  if (!Number.isSafeInteger(tokenIssuedAt) || tokenIssuedAt <= 0 || !INTEGER_TEXT.test(watermarkMs)) return false
  return BigInt(tokenIssuedAt) * 1000n > BigInt(watermarkMs)
}

export async function resolveAdminGrantInstallSchema(
  executor: Queryable,
  unavailableCode: AdminGrantActorInputCode,
): Promise<string> {
  const result = await executor.query(`SELECT candidate.nspname AS schema_name
  FROM pg_catalog.unnest(pg_catalog.current_schemas(false)) WITH ORDINALITY AS candidate(nspname, ord)
 ORDER BY candidate.ord`)
  if (!result || !Array.isArray(result.rows)) throw new AdminGrantActorInputError(unavailableCode)
  for (const row of result.rows) {
    const name = row?.schema_name
    if (name === 'information_schema' || (typeof name === 'string' && name.startsWith('pg_'))) continue
    if (typeof name !== 'string' || !IDENT.test(name)) throw new AdminGrantActorInputError(unavailableCode)
    return name
  }
  throw new AdminGrantActorInputError(unavailableCode)
}

function flag(value: unknown): boolean {
  return value === true
}

export async function classifyAdminGrantActorInputSchema(executor: Queryable): Promise<AdminGrantActorInputSchemaState> {
  try {
    const rows = await readRows(executor, CLASSIFY_SQL, [])
    if (rows.length !== 1) throw unavailable()
    const row = rows[0]
    const schemaName = textOf(row.schema_name)
    if (schemaName === null || !IDENT.test(schemaName)) throw unavailable()
    const present = [
      flag(row.version_column),
      flag(row.establishments),
      flag(row.bindings),
      flag(row.version_fn),
      flag(row.establishment_fn),
      flag(row.browser_fn),
      flag(row.version_trigger),
      flag(row.establishment_truncate),
      flag(row.browser_truncate),
      flag(row.establishment_row),
      flag(row.browser_row),
    ]
    if (present.every((item) => item === false) && row.version_ready !== true) return 'absent'
    const ready = row.version_ready === true && present.every((item) => item === true)
    return ready ? 'ready' : 'partial'
  } catch (error) {
    if (error instanceof AdminGrantActorInputError) throw error
    throw unavailable()
  }
}

async function ensureWatermark(
  executor: Queryable,
  statements: ReturnType<typeof adminGrantCredentialStatements>,
  userId: string,
  tokenIssuedAt: number,
): Promise<void> {
  await executor.query(statements.baselineWatermark, [userId, BASELINE_REASON])
  const rows = await readRows(executor, statements.lockWatermark, [userId])
  if (rows.length !== 1) throw unavailable()
  const watermarkMs = textOf(rows[0].revoked_after_ms)
  const watermarkUs = textOf(rows[0].revoked_after_us)
  if (watermarkMs === null || watermarkUs === null || !INTEGER_TEXT.test(watermarkMs) || !INTEGER_TEXT.test(watermarkUs)) {
    throw unavailable()
  }
  if (!tokenExceedsWatermark(tokenIssuedAt, watermarkMs)) throw ineligible()
}

function captureRequiredPasswordChange(input: unknown): { session: unknown, passwordHash: unknown } {
  if (input === null || typeof input !== 'object') throw unavailable()
  let prototype: unknown
  try {
    prototype = Object.getPrototypeOf(input)
  } catch {
    throw unavailable()
  }
  if (prototype !== Object.prototype && prototype !== null) throw unavailable()
  let descriptors: PropertyDescriptorMap
  try {
    descriptors = Object.getOwnPropertyDescriptors(input)
  } catch {
    throw unavailable()
  }
  let keys: PropertyKey[]
  try {
    keys = Reflect.ownKeys(descriptors)
  } catch {
    throw unavailable()
  }
  if (keys.length !== 2) throw unavailable()
  const captured: { session: unknown, passwordHash: unknown } = { session: undefined, passwordHash: undefined }
  for (const field of ['session', 'passwordHash'] as const) {
    const descriptor = descriptors[field]
    if (descriptor === undefined || !('value' in descriptor)) throw unavailable()
    captured[field] = descriptor.value
  }
  return captured
}

export async function changeRequiredPasswordWithProvenance(
  input: AdminGrantRequiredPasswordChange,
  transaction: AdminGrantTransactionRunner = defaultTransaction,
): Promise<AdminGrantCredentialEstablishment> {
  const captured = captureRequiredPasswordChange(input)
  const session = captured.session
  assertAuthenticatedSessionContext(session)
  const userId = session.userId
  const sessionId = session.sessionId
  const tokenIssuedAt = session.tokenIssuedAt
  const passwordHash = captured.passwordHash
  if (typeof transaction !== 'function') throw unavailable()
  if (!isBcryptHash(passwordHash)) throw ineligible()
  try {
    return await transaction(async (executor) => {
      await executor.query(SET_READ_COMMITTED)
      await executor.query(SET_LOCK_TIMEOUT)
      await executor.query(SET_STATEMENT_TIMEOUT)
      const schema = await resolveAdminGrantInstallSchema(executor, 'ADMIN_GRANT_CREDENTIAL_UNAVAILABLE')
      const statements = adminGrantCredentialStatements(schema)
      const users = await readRows(executor, statements.lockUser, [userId])
      if (users.length !== 1) throw ineligible()
      const user = users[0]
      const previousVersion = user.local_credential_version === null ? null : lowerUuid(user.local_credential_version)
      if (user.local_credential_version !== null && previousVersion === null) throw unavailable()
      if (typeof user.local_password_set !== 'boolean'
        || user.must_change_password !== true
        || typeof user.activation_status !== 'string'
        || typeof user.is_active !== 'boolean') {
        throw user.must_change_password === false ? ineligible() : unavailable()
      }
      if (evaluateUserAuthenticationGate({
        is_active: user.is_active,
        role: typeof user.role === 'string' ? user.role : null,
        activation_status: user.activation_status,
        deleted_at: typeof user.deleted_at === 'string' ? user.deleted_at : null,
        purged_at: typeof user.purged_at === 'string' ? user.purged_at : null,
      }) !== null) {
        throw ineligible()
      }
      await ensureWatermark(executor, statements, userId, tokenIssuedAt)
      const sessions = await readRows(executor, statements.lockSession, [sessionId])
      if (sessions.length !== 1 || sessions[0].user_id !== userId || sessions[0].live !== true) throw ineligible()
      const updated = await readRows(executor, statements.updateCredential, [passwordHash, userId])
      if (updated.length !== 1) throw ineligible()
      const credentialVersion = lowerUuid(updated[0].local_credential_version)
      if (credentialVersion === null || credentialVersion === previousVersion) throw unavailable()
      const established = await readRows(executor, statements.insertEstablishment, [userId, credentialVersion, sessionId])
      if (established.length !== 1) throw unavailable()
      const establishmentId = lowerUuid(established[0].establishment_id)
      const establishedAt = timestampIso(established[0].established_at)
      if (establishmentId === null || establishedAt === null) throw unavailable()
      const advanced = await readRows(executor, statements.advanceWatermark, [userId, userId, ADVANCE_REASON])
      const watermarkUs = advanced.length === 1 ? textOf(advanced[0].watermark_us) : null
      if (watermarkUs === null || !INTEGER_TEXT.test(watermarkUs)) throw unavailable()
      return Object.freeze({
        establishmentId,
        userId,
        credentialVersion,
        sourceSessionId: sessionId,
        kind: 'self_password_change',
        establishedAt,
      })
    })
  } catch (error) {
    if (error instanceof AdminGrantActorInputError || error instanceof SecurityActionProofContractError) throw error
    throw unavailable()
  }
}

export async function readAdminGrantLocalCredential(
  executor: Queryable,
  session: AuthenticatedSessionContext,
): Promise<AdminGrantLocalCredentialWitness> {
  assertAuthenticatedSessionContext(session)
  const userId = session.userId
  try {
    const schema = await resolveAdminGrantInstallSchema(executor, 'ADMIN_GRANT_CREDENTIAL_UNAVAILABLE')
    const statements = adminGrantCredentialStatements(schema)
    const rows = await readRows(executor, statements.readCredential, [userId])
    if (rows.length !== 1) throw ineligible()
    const row = rows[0]
    const credentialVersion = lowerUuid(row.credential_version)
    const establishmentId = lowerUuid(row.establishment_id)
    const sourceSessionId = textOf(row.source_session_id)
    const establishedAt = timestampIso(row.established_at)
    if (credentialVersion === null
      || establishmentId === null
      || sourceSessionId === null || sourceSessionId.length === 0
      || establishedAt === null
      || row.local_password_set !== true
      || row.must_change_password !== false
      || row.hash_present !== true
      || row.kind !== 'self_password_change') {
      throw ineligible()
    }
    return Object.freeze({
      userId,
      credentialVersion,
      establishmentId,
      sourceSessionId,
      kind: 'self_password_change',
      establishedAt,
    })
  } catch (error) {
    if (error instanceof AdminGrantActorInputError || error instanceof SecurityActionProofContractError) throw error
    throw unavailable()
  }
}
