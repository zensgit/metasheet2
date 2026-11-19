/**
 * Server browser binding for an admin grant actor.
 * The only session constructor remains readAuthenticatedSessionContext.
 * This module brands the browser binding, not the session.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Request, Response } from 'express'
import { transaction as runPoolTransaction } from '../db/pg'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import {
  assertAuthenticatedSessionContext,
  readAuthenticatedSessionContext,
  SecurityActionProofContractError,
  type AuthenticatedSessionContext,
} from './security-action-proof'
import { evaluateUserAuthenticationGate } from './user-activation'
import {
  AdminGrantActorInputError,
  classifyAdminGrantActorInputSchema,
  resolveAdminGrantInstallSchema,
  type AdminGrantActorInputSchemaState,
  type AdminGrantTransactionRunner,
} from './admin-grant-local-credential'

export type { AdminGrantTransactionRunner } from './admin-grant-local-credential'

export const ADMIN_GRANT_BROWSER_COOKIE_NAME = '__Host-meta-agp'
export const ADMIN_GRANT_BROWSER_NONCE_DOMAIN = 'metasheet:admin-grant-browser-nonce:v1|'
export const ADMIN_GRANT_BROWSER_BINDING_DOMAIN = 'metasheet:admin-grant-browser-binding:v1|'

declare const adminGrantBrowserContextBrand: unique symbol

export type AdminGrantBrowserContext = Readonly<{
  session: AuthenticatedSessionContext
  bindingId: string
  origin: string
  nonceDigest: string
  tokenIssuedAt: number
  readonly [adminGrantBrowserContextBrand]: true
}>

export type AdminGrantBrowserWitness = Readonly<{
  bindingId: string
  userId: string
  orgId: string
  sessionId: string
  origin: string
  nonceDigest: string
  tokenIssuedAt: number
  watermarkUs: string
  bindingEstablishedAt: string
  bindingExpiresAt: string
  sessionExpiresAt: string
}>

export type AdminGrantBrowserService = Readonly<{
  publicOrigin: string
  read(req: Request): Promise<AdminGrantBrowserContext>
  establish(req: Request, res: Response): Promise<AdminGrantBrowserContext>
  assert(context: unknown): asserts context is AdminGrantBrowserContext
  assertCurrent(executor: Queryable, context: AdminGrantBrowserContext): Promise<AdminGrantBrowserWitness>
}>

const IDENT = /^[a-z_][a-z0-9_]*$/
const HEX64 = /^[0-9a-f]{64}$/
const COOKIE_VALUE = /^[A-Za-z0-9_-]{43}$/
const INTEGER_TEXT = /^-?\d+$/
const BASELINE_REASON = 'admin-grant-baseline'
const SET_READ_COMMITTED = 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED'
const SET_LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'"
const SET_STATEMENT_TIMEOUT = "SET LOCAL statement_timeout = '30s'"

type RegisteredBrowser = {
  origin: string
  session: AuthenticatedSessionContext
  bindingId: string
  nonceDigest: string
  tokenIssuedAt: number
}

const browserContexts = new WeakMap<object, RegisteredBrowser>()

function qualify(schema: string, relation: string): string {
  if (!IDENT.test(schema) || !IDENT.test(relation)) throw new AdminGrantActorInputError('ADMIN_GRANT_BROWSER_UNAVAILABLE')
  return `"${schema}"."${relation}"`
}

export function adminGrantBrowserStatements(schema: string): Readonly<{
  lockUser: string
  shareUser: string
  baselineWatermark: string
  lockWatermark: string
  readWatermark: string
  lockSession: string
  readSession: string
  lockBinding: string
  readBinding: string
  insertBinding: string
}> {
  const users = qualify(schema, 'users')
  const revocations = qualify(schema, 'user_session_revocations')
  const sessions = qualify(schema, 'user_sessions')
  const bindings = qualify(schema, 'security_action_browser_bindings')
  const userColumns = `u.id,
       u.activation_status,
       u.is_active,
       u.role,
       (pg_catalog.to_jsonb(u) ->> 'deleted_at') AS deleted_at,
       (pg_catalog.to_jsonb(u) ->> 'purged_at') AS purged_at`
  const watermarkColumns = `floor(extract(epoch FROM revoked_after) * 1000)::text AS revoked_after_ms,
       floor(extract(epoch FROM revoked_after) * 1000000)::text AS revoked_after_us`
  const instant = (column: string, alias: string) =>
    `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${alias}`
  const sessionColumns = `s.user_id,
       (s.revoked_at IS NULL AND s.expires_at > pg_catalog.clock_timestamp()) AS live,
       ${instant('s.expires_at', 'expires_at_text')}`
  const bindingColumns = `b.id::text AS binding_id,
       b.user_id,
       b.org_id,
       b.origin,
       b.nonce_digest,
       ${instant('b.established_at', 'established_at_text')},
       ${instant('b.expires_at', 'expires_at_text')},
       (b.revoked_at IS NULL AND b.expires_at > pg_catalog.clock_timestamp()) AS live`
  return Object.freeze({
    lockUser: `SELECT ${userColumns}
  FROM ${users} u
 WHERE u.id = $1
   FOR UPDATE`,
    shareUser: `SELECT ${userColumns}
  FROM ${users} u
 WHERE u.id = $1
   FOR SHARE`,
    baselineWatermark: `INSERT INTO ${revocations} (user_id, revoked_after, updated_at, updated_by, reason)
VALUES ($1, TIMESTAMPTZ '1970-01-01 00:00:00+00', pg_catalog.clock_timestamp(), $1, $2)
ON CONFLICT (user_id) DO NOTHING`,
    lockWatermark: `SELECT ${watermarkColumns}
  FROM ${revocations}
 WHERE user_id = $1
   FOR UPDATE`,
    readWatermark: `SELECT ${watermarkColumns}
  FROM ${revocations}
 WHERE user_id = $1`,
    lockSession: `SELECT ${sessionColumns}
  FROM ${sessions} s
 WHERE s.id = $1
   FOR SHARE`,
    readSession: `SELECT ${sessionColumns}
  FROM ${sessions} s
 WHERE s.id = $1`,
    lockBinding: `SELECT ${bindingColumns}
  FROM ${bindings} b
 WHERE b.session_id = $1
   FOR SHARE`,
    readBinding: `SELECT ${bindingColumns}
  FROM ${bindings} b
 WHERE b.session_id = $1`,
    insertBinding: `INSERT INTO ${bindings} (session_id, user_id, org_id, origin, nonce_digest, expires_at)
VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
RETURNING id::text AS binding_id,
          established_at,
          expires_at,
          floor(extract(epoch FROM (expires_at - pg_catalog.clock_timestamp())))::text AS max_age_seconds`,
  })
}

const defaultTransaction: AdminGrantTransactionRunner = (handler) => runPoolTransaction((client) => handler(client))

function browserUnavailable(): AdminGrantActorInputError {
  return new AdminGrantActorInputError('ADMIN_GRANT_BROWSER_UNAVAILABLE')
}

function sessionStale(): AdminGrantActorInputError {
  return new AdminGrantActorInputError('ADMIN_GRANT_BROWSER_SESSION_STALE')
}

export function canonicalAdminGrantBrowserOrigin(input: string): string {
  if (typeof input !== 'string' || input.length === 0 || input !== input.trim()) {
    throw new AdminGrantActorInputError('ADMIN_GRANT_BROWSER_ORIGIN_INVALID')
  }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new AdminGrantActorInputError('ADMIN_GRANT_BROWSER_ORIGIN_INVALID')
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new AdminGrantActorInputError('ADMIN_GRANT_BROWSER_ORIGIN_INVALID')
  }
  if (url.pathname !== '/' || url.origin !== input) {
    throw new AdminGrantActorInputError('ADMIN_GRANT_BROWSER_ORIGIN_INVALID')
  }
  return url.origin
}

export function adminGrantBrowserNonceDigest(nonce: Buffer): string {
  if (!Buffer.isBuffer(nonce) || nonce.length !== 32) throw browserUnavailable()
  return createHash('sha256').update(ADMIN_GRANT_BROWSER_NONCE_DOMAIN, 'utf8').update(nonce).digest('hex')
}

export function adminGrantBrowserBindingDigest(binding: Readonly<{
  bindingId: string
  userId: string
  sessionId: string
  orgId: string
  origin: string
  nonceDigest: string
}>): string {
  const parts = [binding.bindingId, binding.userId, binding.sessionId, binding.orgId, binding.origin, binding.nonceDigest]
  if (parts.some((part) => typeof part !== 'string' || part.length === 0 || part.includes('\u0000'))) throw browserUnavailable()
  const encoded = JSON.stringify(parts)
  return createHash('sha256').update(ADMIN_GRANT_BROWSER_BINDING_DOMAIN + encoded, 'utf8').digest('hex')
}

export function formatAdminGrantBrowserSetCookie(nonce: string, maxAgeSeconds: number): string {
  if (!COOKIE_VALUE.test(nonce) || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1) throw browserUnavailable()
  return `${ADMIN_GRANT_BROWSER_COOKIE_NAME}=${nonce}; Max-Age=${maxAgeSeconds}; Path=/; HttpOnly; Secure; SameSite=Strict`
}

export function parseAdminGrantBrowserCookie(cookieHeader: string): Readonly<{
  state: 'absent' | 'present' | 'malformed'
  nonce: string | null
}> {
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) return Object.freeze({ state: 'absent', nonce: null })
  const values: string[] = []
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim()
    if (trimmed.length === 0) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    if (trimmed.slice(0, eq) !== ADMIN_GRANT_BROWSER_COOKIE_NAME) continue
    values.push(trimmed.slice(eq + 1))
  }
  if (values.length === 0) return Object.freeze({ state: 'absent', nonce: null })
  if (values.length !== 1 || !COOKIE_VALUE.test(values[0])) return Object.freeze({ state: 'malformed', nonce: null })
  return Object.freeze({ state: 'present', nonce: values[0] })
}

async function readRows(executor: Queryable, statement: string, params: readonly unknown[]): Promise<Array<Record<string, unknown>>> {
  const result = await executor.query(statement, [...params])
  if (!result || !Array.isArray(result.rows)) throw browserUnavailable()
  return result.rows
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function tokenExceedsWatermark(tokenIssuedAt: number, watermarkMs: string): boolean {
  if (!Number.isSafeInteger(tokenIssuedAt) || tokenIssuedAt <= 0 || !INTEGER_TEXT.test(watermarkMs)) return false
  return BigInt(tokenIssuedAt) * 1000n > BigInt(watermarkMs)
}

function digestEquals(stored: string, actual: string): boolean {
  if (!HEX64.test(stored) || !HEX64.test(actual)) return false
  return timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(actual, 'hex'))
}

function brandBrowser(
  session: AuthenticatedSessionContext,
  origin: string,
  bindingId: string,
  nonceDigest: string,
  tokenIssuedAt: number,
): AdminGrantBrowserContext {
  const context = Object.freeze({
    session,
    bindingId,
    origin,
    nonceDigest,
    tokenIssuedAt,
  })
  browserContexts.set(context, Object.freeze({
    origin,
    session,
    bindingId,
    nonceDigest,
    tokenIssuedAt,
  }))
  return context as AdminGrantBrowserContext
}

export function assertAdminGrantBrowserContext(context: unknown, publicOrigin: string): asserts context is AdminGrantBrowserContext {
  const registered = context && typeof context === 'object' ? browserContexts.get(context) : undefined
  if (!registered || typeof publicOrigin !== 'string' || registered.origin !== publicOrigin) {
    throw new AdminGrantActorInputError('ADMIN_GRANT_BROWSER_CONTEXT_REQUIRED')
  }
  const presented = context as AdminGrantBrowserContext
  if (presented.origin !== registered.origin
    || presented.session !== registered.session
    || presented.bindingId !== registered.bindingId
    || presented.nonceDigest !== registered.nonceDigest
    || presented.tokenIssuedAt !== registered.tokenIssuedAt
    || presented.tokenIssuedAt !== registered.session.tokenIssuedAt) {
    throw new AdminGrantActorInputError('ADMIN_GRANT_BROWSER_CONTEXT_REQUIRED')
  }
  assertAuthenticatedSessionContext(registered.session)
}

function captureRequest(req: Request, publicOrigin: string): {
  session: AuthenticatedSessionContext
  userId: string
  sessionId: string
  tokenIssuedAt: number
  orgId: string
  cookie: Readonly<{ state: 'absent' | 'present' | 'malformed'; nonce: string | null }>
} {
  const session = readAuthenticatedSessionContext(req)
  assertAuthenticatedSessionContext(session)
  const orgId = session.orgId
  if (typeof orgId !== 'string' || orgId.length === 0 || orgId.includes('\u0000')) throw sessionStale()
  const requestOrigin = typeof req.headers?.origin === 'string' ? req.headers.origin : ''
  if (requestOrigin !== publicOrigin) throw new AdminGrantActorInputError('ADMIN_GRANT_BROWSER_ORIGIN_MISMATCH')
  const cookieHeader = typeof req.headers?.cookie === 'string' ? req.headers.cookie : ''
  return {
    session,
    userId: session.userId,
    sessionId: session.sessionId,
    tokenIssuedAt: session.tokenIssuedAt,
    orgId,
    cookie: parseAdminGrantBrowserCookie(cookieHeader),
  }
}

async function begin(executor: Queryable): Promise<void> {
  await executor.query(SET_READ_COMMITTED)
  await executor.query(SET_LOCK_TIMEOUT)
  await executor.query(SET_STATEMENT_TIMEOUT)
}

async function requireReadyBrowserSchema(executor: Queryable): Promise<string> {
  let state: AdminGrantActorInputSchemaState
  try {
    state = await classifyAdminGrantActorInputSchema(executor)
  } catch (error) {
    if (error instanceof AdminGrantActorInputError) throw browserUnavailable()
    throw error
  }
  if (state !== 'ready') throw browserUnavailable()
  return resolveAdminGrantInstallSchema(executor, 'ADMIN_GRANT_BROWSER_UNAVAILABLE')
}

function accountAllows(row: Record<string, unknown>): boolean {
  if (typeof row.activation_status !== 'string' || typeof row.is_active !== 'boolean' || row.id === undefined) return false
  return evaluateUserAuthenticationGate({
    is_active: row.is_active,
    role: typeof row.role === 'string' ? row.role : null,
    activation_status: row.activation_status,
    deleted_at: typeof row.deleted_at === 'string' ? row.deleted_at : null,
    purged_at: typeof row.purged_at === 'string' ? row.purged_at : null,
  }) === null
}

async function readWatermark(executor: Queryable, statement: string, userId: string, tokenIssuedAt: number): Promise<string> {
  const rows = await readRows(executor, statement, [userId])
  if (rows.length !== 1) throw sessionStale()
  const watermarkMs = textOf(rows[0].revoked_after_ms)
  const watermarkUs = textOf(rows[0].revoked_after_us)
  if (watermarkMs === null || watermarkUs === null || !INTEGER_TEXT.test(watermarkMs) || !INTEGER_TEXT.test(watermarkUs)) {
    throw browserUnavailable()
  }
  if (!tokenExceedsWatermark(tokenIssuedAt, watermarkMs)) throw sessionStale()
  return watermarkUs
}

function cookieDigest(cookie: Readonly<{ state: 'absent' | 'present' | 'malformed'; nonce: string | null }>): string | null {
  if (cookie.state !== 'present' || cookie.nonce === null) return null
  const raw = Buffer.from(cookie.nonce, 'base64url')
  if (raw.length !== 32) return null
  return adminGrantBrowserNonceDigest(raw)
}

export function createAdminGrantBrowserContext(options: Readonly<{
  publicOrigin: string
  transaction?: AdminGrantTransactionRunner
}>): AdminGrantBrowserService {
  if (options === null || typeof options !== 'object') {
    throw new AdminGrantActorInputError('ADMIN_GRANT_BROWSER_ORIGIN_INVALID')
  }
  const publicOrigin = canonicalAdminGrantBrowserOrigin(options.publicOrigin)
  const transaction = options.transaction ?? defaultTransaction
  if (typeof transaction !== 'function') throw browserUnavailable()

  async function read(req: Request): Promise<AdminGrantBrowserContext> {
    const captured = captureRequest(req, publicOrigin)
    if (captured.cookie.state === 'absent') throw new AdminGrantActorInputError('ADMIN_GRANT_BROWSER_COOKIE_REQUIRED')
    if (captured.cookie.state !== 'present') throw new AdminGrantActorInputError('ADMIN_GRANT_BROWSER_COOKIE_MISMATCH')
    const presentedDigest = cookieDigest(captured.cookie)
    if (presentedDigest === null) throw new AdminGrantActorInputError('ADMIN_GRANT_BROWSER_COOKIE_MISMATCH')
    try {
      return await transaction(async (executor) => {
        await begin(executor)
        const schema = await requireReadyBrowserSchema(executor)
        const statements = adminGrantBrowserStatements(schema)
        const users = await readRows(executor, statements.shareUser, [captured.userId])
        if (users.length !== 1 || !accountAllows(users[0])) throw sessionStale()
        const watermarkUs = await readWatermark(executor, statements.readWatermark, captured.userId, captured.tokenIssuedAt)
        if (!INTEGER_TEXT.test(watermarkUs)) throw browserUnavailable()
        const sessions = await readRows(executor, statements.readSession, [captured.sessionId])
        if (sessions.length !== 1 || sessions[0].user_id !== captured.userId || sessions[0].live !== true) throw sessionStale()
        const bindings = await readRows(executor, statements.readBinding, [captured.sessionId])
        if (bindings.length !== 1) throw new AdminGrantActorInputError('ADMIN_GRANT_BROWSER_COOKIE_MISMATCH')
        const binding = bindings[0]
        const bindingId = textOf(binding.binding_id)
        const nonceDigest = textOf(binding.nonce_digest)
        if (bindingId === null || nonceDigest === null) throw browserUnavailable()
        if (binding.user_id !== captured.userId || binding.org_id !== captured.orgId || binding.origin !== publicOrigin || binding.live !== true) {
          throw sessionStale()
        }
        if (!digestEquals(nonceDigest, presentedDigest)) throw new AdminGrantActorInputError('ADMIN_GRANT_BROWSER_COOKIE_MISMATCH')
        return brandBrowser(captured.session, publicOrigin, bindingId, nonceDigest, captured.tokenIssuedAt)
      })
    } catch (error) {
      if (error instanceof AdminGrantActorInputError || error instanceof SecurityActionProofContractError) throw error
      throw browserUnavailable()
    }
  }

  async function establish(req: Request, res: Response): Promise<AdminGrantBrowserContext> {
    const captured = captureRequest(req, publicOrigin)
    const append = res.append
    const headersSent = res.headersSent
    if (headersSent || typeof append !== 'function') throw new AdminGrantActorInputError('ADMIN_GRANT_BROWSER_COOKIE_LOST')
    let minted: { nonce: string; maxAgeSeconds: number } | null = null
    try {
      const context = await transaction(async (executor) => {
        minted = null
        await begin(executor)
        const schema = await requireReadyBrowserSchema(executor)
        const statements = adminGrantBrowserStatements(schema)
        const users = await readRows(executor, statements.lockUser, [captured.userId])
        if (users.length !== 1 || !accountAllows(users[0])) throw sessionStale()
        await executor.query(statements.baselineWatermark, [captured.userId, BASELINE_REASON])
        await readWatermark(executor, statements.lockWatermark, captured.userId, captured.tokenIssuedAt)
        const sessions = await readRows(executor, statements.lockSession, [captured.sessionId])
        if (sessions.length !== 1 || sessions[0].user_id !== captured.userId || sessions[0].live !== true) throw sessionStale()
        const sessionExpiresAt = textOf(sessions[0].expires_at_text)
        if (sessionExpiresAt === null || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(sessionExpiresAt)) {
          throw browserUnavailable()
        }
        const existing = await readRows(executor, statements.lockBinding, [captured.sessionId])
        if (existing.length > 1) throw browserUnavailable()
        if (existing.length === 1) {
          const binding = existing[0]
          const bindingId = textOf(binding.binding_id)
          const nonceDigest = textOf(binding.nonce_digest)
          if (bindingId === null || nonceDigest === null) throw browserUnavailable()
          if (binding.user_id !== captured.userId || binding.org_id !== captured.orgId || binding.origin !== publicOrigin || binding.live !== true) {
            throw sessionStale()
          }
          const presentedDigest = cookieDigest(captured.cookie)
          if (captured.cookie.state === 'absent') throw new AdminGrantActorInputError('ADMIN_GRANT_BROWSER_COOKIE_REQUIRED')
          if (presentedDigest === null || !digestEquals(nonceDigest, presentedDigest)) {
            throw new AdminGrantActorInputError('ADMIN_GRANT_BROWSER_COOKIE_MISMATCH')
          }
          return brandBrowser(captured.session, publicOrigin, bindingId, nonceDigest, captured.tokenIssuedAt)
        }
        const nonce = randomBytes(32)
        const nonceToken = nonce.toString('base64url')
        const nonceDigest = adminGrantBrowserNonceDigest(nonce)
        const inserted = await readRows(executor, statements.insertBinding, [
          captured.sessionId,
          captured.userId,
          captured.orgId,
          publicOrigin,
          nonceDigest,
          sessionExpiresAt,
        ])
        if (inserted.length !== 1) throw browserUnavailable()
        const bindingId = textOf(inserted[0].binding_id)
        const maxAgeText = textOf(inserted[0].max_age_seconds)
        const maxAgeSeconds = maxAgeText !== null && /^\d+$/.test(maxAgeText) ? Number(maxAgeText) : Number.NaN
        if (bindingId === null || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1) throw browserUnavailable()
        minted = { nonce: nonceToken, maxAgeSeconds }
        return brandBrowser(captured.session, publicOrigin, bindingId, nonceDigest, captured.tokenIssuedAt)
      })
      if (minted !== null) {
        const cookie = minted as { nonce: string; maxAgeSeconds: number }
        if (res.headersSent) throw new AdminGrantActorInputError('ADMIN_GRANT_BROWSER_COOKIE_LOST')
        try {
          append.call(res, 'Set-Cookie', formatAdminGrantBrowserSetCookie(cookie.nonce, cookie.maxAgeSeconds))
        } catch {
          throw new AdminGrantActorInputError('ADMIN_GRANT_BROWSER_COOKIE_LOST')
        }
      }
      return context
    } catch (error) {
      if (error instanceof AdminGrantActorInputError || error instanceof SecurityActionProofContractError) throw error
      throw browserUnavailable()
    }
  }

  async function assertCurrent(executor: Queryable, context: AdminGrantBrowserContext): Promise<AdminGrantBrowserWitness> {
    assertAdminGrantBrowserContext(context, publicOrigin)
    const userId = context.session.userId
    const sessionId = context.session.sessionId
    const orgId = context.session.orgId
    const tokenIssuedAt = context.tokenIssuedAt
    const bindingId = context.bindingId
    const nonceDigest = context.nonceDigest
    if (typeof orgId !== 'string' || orgId.length === 0) throw sessionStale()
    try {
      const schema = await requireReadyBrowserSchema(executor)
      const statements = adminGrantBrowserStatements(schema)
      const watermarkUs = await readWatermark(executor, statements.readWatermark, userId, tokenIssuedAt)
      const sessions = await readRows(executor, statements.readSession, [sessionId])
      if (sessions.length !== 1 || sessions[0].user_id !== userId || sessions[0].live !== true) throw sessionStale()
      const sessionExpiresAt = textOf(sessions[0].expires_at_text)
      const bindings = await readRows(executor, statements.readBinding, [sessionId])
      if (bindings.length !== 1) throw sessionStale()
      const binding = bindings[0]
      const bindingExpiresAt = textOf(binding.expires_at_text)
      const bindingEstablishedAt = textOf(binding.established_at_text)
      if (sessionExpiresAt === null || bindingExpiresAt === null || bindingEstablishedAt === null) throw browserUnavailable()
      if (binding.binding_id !== bindingId
        || binding.user_id !== userId
        || binding.org_id !== orgId
        || binding.origin !== publicOrigin
        || binding.nonce_digest !== nonceDigest
        || binding.live !== true) {
        throw sessionStale()
      }
      return Object.freeze({
        bindingId,
        userId,
        orgId,
        sessionId,
        origin: publicOrigin,
        nonceDigest,
        tokenIssuedAt,
        watermarkUs,
        bindingEstablishedAt,
        bindingExpiresAt,
        sessionExpiresAt,
      })
    } catch (error) {
      if (error instanceof AdminGrantActorInputError || error instanceof SecurityActionProofContractError) throw error
      throw browserUnavailable()
    }
  }

  return Object.freeze({
    publicOrigin,
    read,
    establish,
    assert: (context: unknown): asserts context is AdminGrantBrowserContext => {
      assertAdminGrantBrowserContext(context, publicOrigin)
    },
    assertCurrent,
  })
}
