/**
 * Owner-provisioned managed-login consumer.
 * The browser is sent to the native first-party page. Exchange, session insert
 * and native revoke stay on the server. Personal write and approval are not called.
 */
import type { Request, Response } from 'express'
import { randomUUID } from 'node:crypto'
import { query, transaction } from '../db/pg'
import { isDatabaseSchemaError } from '../utils/database-errors'
import { encryptStoredSecretValue, decryptStoredSecretValue } from '../security/encrypted-secrets'
import { evaluateUserAuthenticationGate } from '../auth/user-activation'
import { authService } from '../auth/AuthService'
import {
  isManagedCompanionToken,
  readLiveManagedCookieIdentity,
  signManagedSessionToken,
} from '../auth/plm-managed-session'
import { BomReviewError, parseManagedSnapshot, type ManagedSnapshot } from '../multitable/plm-bom-review-wire'
import { personalChangeReadConnectionIdSchema } from './plm-personal-bom-change-read-wire'
import { resolvePersistedPlmSource } from './plm-personal-bom-write-wire'
import { currentManagedRequest } from './plm-managed-request-context'
import { queueSnapshotShareCancellationOnQuery, drainSnapshotShareCancellation, pendingSnapshotShareCancellations } from './plm-managed-snapshot-share-flow'
import {
  decodeBoundYurClaims,
  nativeExchange,
  nativeExchangeContinuous,
  nativeManagedContext,
  nativeRevoke,
  nativeStatus,
  ManagedNativeCallRefusal,
  type NativeContinuousExchange,
  type NativeExchange,
} from './plm-managed-native-http'
import {
  MANAGED_COMPANION_SCOPE,
  MANAGED_FIXED_RETURN_PATH,
  MANAGED_INTENT_COOKIE,
  MANAGED_INTENT_TTL_SECONDS,
  MANAGED_NONCE_COOKIE,
  MANAGED_SESSION_COOKIE,
  ManagedCompanionRefusal,
  bindingFingerprintMatches,
  buildManagedLoginNavigation,
  classifyManagedSource,
  cookieSecureFor,
  explicitDatabaseUrl,
  isPlmManagedCompanionEnabled,
  openCredential,
  originOfSourceConfig,
  pkceS256,
  randomUrlToken,
  readRequestCookie,
  registrationFor,
  sealCredential,
  sha256Hex,
  sourceFingerprint,
  hashesEqual,
  type ManagedClientRegistration,
} from './plm-managed-companion'

type SqlClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>
}

export type ManagedActor = { id: string; role?: string | null; authenticatedTenantId?: string | null }

type LinkRow = Record<string, unknown>
type StopReason = 'revoked' | 'transferred'

let loseExchangeResponse = false
let failSessionInsert = false

export function setManagedFlowHooksForTests(next: { loseExchangeResponse?: boolean; failSessionInsert?: boolean } | null): void {
  if (process.env.NODE_ENV === 'production') {
    throw new ManagedCompanionRefusal(500, 'PLM_MANAGED_TEST_HOOKS_REFUSED')
  }
  if (process.env.PLM_MANAGED_COMPANION_TEST_HOOKS !== 'true') {
    loseExchangeResponse = false
    failSessionInsert = false
    if (next) throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_TEST_HOOKS_REFUSED')
    return
  }
  loseExchangeResponse = next?.loseExchangeResponse === true
  failSessionInsert = next?.failSessionInsert === true
}

export function setManagedFixtureClockForTests(next: Date | null): void {
  if (process.env.NODE_ENV === 'production') {
    throw new ManagedCompanionRefusal(500, 'PLM_MANAGED_TEST_HOOKS_REFUSED')
  }
  if (process.env.PLM_MANAGED_COMPANION_TEST_HOOKS !== 'true') {
    if (next) throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_TEST_HOOKS_REFUSED')
    return
  }
  if (next !== null && (!(next instanceof Date) || Number.isNaN(next.getTime()))) {
    throw new ManagedCompanionRefusal(500, 'PLM_MANAGED_TEST_HOOKS_REFUSED')
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function consumedInflightPredicate(alias: string): string {
  const column = alias ? `${alias}.` : ''
  // Browser expiry and the client fetch abort do not cancel a native exchange
  // that already holds the parent lock. Stay pending until the delegation is observed.
  return `${column}status = 'consumed' AND ${column}delegation_id IS NULL`
}

function exactBody(body: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ManagedCompanionRefusal(400, 'PLM_MANAGED_BODY_REFUSED')
  }
  const record = body as Record<string, unknown>
  if (Object.keys(record).sort().join() !== [...keys].sort().join()) {
    throw new ManagedCompanionRefusal(400, 'PLM_MANAGED_BODY_REFUSED')
  }
  return record
}

function exactString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new ManagedCompanionRefusal(400, 'PLM_MANAGED_BODY_REFUSED')
  }
  return value
}

function partIdOf(value: string): string {
  if (value.length > 128 || /[\s\u0000-\u001f\u007f]/.test(value)) {
    throw new ManagedCompanionRefusal(400, 'PLM_MANAGED_ROOT_REFUSED')
  }
  return value
}

async function requireTables(): Promise<void> {
  if (!explicitDatabaseUrl()) throw new ManagedCompanionRefusal(503, 'PLM_MANAGED_DATABASE_REFUSED')
  try {
    await query('SELECT 1 FROM plm_managed_identity_links LIMIT 0')
  } catch (error) {
    if (isDatabaseSchemaError(error)) throw new ManagedCompanionRefusal(503, 'PLM_MANAGED_SCHEMA_MISSING')
    throw new ManagedCompanionRefusal(503, 'PLM_MANAGED_DATABASE_REFUSED')
  }
}

function sealVerifier(verifier: string): string {
  const sealed = encryptStoredSecretValue(verifier)
  if (!sealed.startsWith('enc:')) throw new ManagedCompanionRefusal(503, 'PLM_MANAGED_CREDENTIAL_REFUSED')
  return sealed
}

function openVerifier(sealed: string): string {
  if (!sealed.startsWith('enc:')) throw new ManagedCompanionRefusal(503, 'PLM_MANAGED_CREDENTIAL_REFUSED')
  const opened = decryptStoredSecretValue(sealed)
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(opened)) {
    throw new ManagedCompanionRefusal(503, 'PLM_MANAGED_CREDENTIAL_REFUSED')
  }
  return opened
}

function cookieBase(callback: string): { httpOnly: true; secure: boolean; sameSite: 'lax'; path: '/' } {
  return { httpOnly: true, secure: cookieSecureFor(callback), sameSite: 'lax', path: '/' }
}

function clearIntentCookies(res: Response, callback: string): void {
  const options = cookieBase(callback)
  res.clearCookie(MANAGED_INTENT_COOKIE, options)
  res.clearCookie(MANAGED_NONCE_COOKIE, options)
}

async function loadUser(client: SqlClient, userId: string): Promise<Record<string, unknown>> {
  const result = await client.query(
    `SELECT id, email, name, role, permissions, is_active, activation_status, must_change_password
     FROM users WHERE id = $1`,
    [userId],
  )
  const row = result.rows[0]
  if (!row) throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_META_USER_REFUSED')
  if (evaluateUserAuthenticationGate({
    role: text(row.role) || 'user',
    is_active: row.is_active === true,
    activation_status: text(row.activation_status),
  })) {
    throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_META_USER_REFUSED')
  }
  return row
}

async function requireMembership(client: SqlClient, userId: string, orgId: string): Promise<void> {
  // Same predicate as AuthService.resolveSessionTenantId: the requested id is an
  // active user_orgs.org_id of this active user. Native tenant and org ids are not inputs.
  const result = await client.query(
    `SELECT uo.org_id
     FROM user_orgs uo
     JOIN users u ON u.id = uo.user_id
     WHERE uo.user_id = $1
       AND uo.org_id = $2
       AND uo.is_active = true
       AND u.is_active = true
     LIMIT 1`,
    [userId, orgId],
  )
  if (result.rows[0]?.org_id !== orgId) throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_META_MEMBERSHIP_REFUSED')
}

function trustedTenant(actor: ManagedActor): string {
  const value = typeof actor.authenticatedTenantId === 'string' ? actor.authenticatedTenantId.trim() : ''
  if (!value) throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_META_MEMBERSHIP_REFUSED')
  return value
}

function registeredPlmOrigin(registration: { nativeBaseUrl: string }): string {
  try {
    return new URL(registration.nativeBaseUrl).origin
  } catch {
    throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_SOURCE_REFUSED')
  }
}

function persistentScopeValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

async function loadSource(client: SqlClient, dataSourceId: string, ownerId: string, origin: string, rootPartId: string): Promise<string> {
  const result = await client.query(
    `SELECT id, type, owner_id, config, is_active, deleted_at, tenant_id, workspace_id, scope_kind
     FROM data_sources WHERE id = $1`,
    [dataSourceId],
  )
  const row = result.rows[0]
  if (!row || text(row.type) !== 'plm' || row.is_active !== true || row.deleted_at || text(row.owner_id) !== ownerId) {
    throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_SOURCE_REFUSED')
  }
  const liveOrigin = originOfSourceConfig(row.config)
  if (!liveOrigin || liveOrigin !== origin) throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_SOURCE_REFUSED')
  return sourceFingerprint({
    type: 'plm',
    origin: liveOrigin,
    ownerId,
    rootPartId,
    tenantId: persistentScopeValue(row.tenant_id),
    workspaceId: persistentScopeValue(row.workspace_id),
    scopeKind: persistentScopeValue(row.scope_kind),
  })
}

/** Install settings seed a source once; subsequent requests use its persisted authority. */
async function handoffPersonalReadConnection(client: SqlClient, dataSourceId: string, ownerId: string,
  registration: {nativeBaseUrl:string; nativeTenantId:string; nativeOrgId:string}, metaTenantId: string) {
  if (process.env.PLM_PERSONAL_BOM_CHANGE_READ_ENABLED!=='true') return
  const row=(await client.query('SELECT * FROM data_sources WHERE id=$1 FOR UPDATE',[dataSourceId])).rows[0]
  const fail=():never=>{throw new ManagedCompanionRefusal(503,'PLM_CHANGE_READ_CONFIGURATION_REQUIRED')}
  if (!row || row.type!=='plm' || row.owner_id!==ownerId || row.is_active!==true || row.deleted_at
    || row.tenant_id!=null && row.tenant_id!==metaTenantId) fail()
  const config=row.config as Record<string,unknown>
  if (!config || typeof config!=='object' || Array.isArray(config)) fail()
  let resolved
  try { resolved=resolvePersistedPlmSource({...config,type:'plm'}) } catch { fail() }
  if (resolved.origin.origin!==registeredPlmOrigin(registration) || resolved.tenantId!==registration.nativeTenantId
    || resolved.orgId!==registration.nativeOrgId) fail()
  const options=config.options as Record<string,unknown>
  const present=Object.hasOwn(options,'personalChangeReadConnectionId')
  const existing=present ? options.personalChangeReadConnectionId : undefined
  const installation=process.env.PLM_PERSONAL_BOM_CHANGE_READ_CONNECTION_ID
  const supplied=installation!==undefined && installation!==''
  const valid=(value:unknown)=>personalChangeReadConnectionIdSchema.safeParse(value).success
  if (present && !valid(existing) || supplied && !valid(installation) || present && supplied && existing!==installation) fail()
  if (present) return
  // Visual source binding remains an explicit platform-admin configuration operation.
  if (options.visualReviewEnabled===true || options.managedVisualReviewEnabled===true) fail()
  if (!supplied) fail()
  const changed=await client.query(`UPDATE data_sources SET config=$2::jsonb WHERE id=$1 AND owner_id=$3
    AND is_active=true AND deleted_at IS NULL RETURNING id`,[dataSourceId,JSON.stringify({...config,
      options:{...options,personalChangeReadConnectionId:installation}}),ownerId])
  if (changed.rows.length!==1) fail()
}

function isAdmin(actor: ManagedActor): boolean {
  return actor.role === 'admin'
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
}

const PROVISION_KEYS = [
  'issuer', 'nativeAuthUserId', 'nativeTenantId', 'nativeOrgId', 'metaUserId', 'metaTenantId',
  'metaOrgId', 'dataSourceId', 'rootPartId', 'ownerOptIn',
] as const

function provisionRecord(body: unknown): { record: Record<string, unknown>; continuityMode: 'ordinary' | 'continuous' } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ManagedCompanionRefusal(400, 'PLM_MANAGED_BODY_REFUSED')
  }
  const record = body as Record<string, unknown>
  const keys = Object.keys(record).sort().join()
  if (keys === [...PROVISION_KEYS].sort().join()) return { record, continuityMode: 'ordinary' }
  if (keys === [...PROVISION_KEYS, 'continuityMode'].sort().join()) {
    if (record.continuityMode !== 'hour') throw new ManagedCompanionRefusal(400, 'PLM_MANAGED_BODY_REFUSED')
    return { record, continuityMode: 'continuous' }
  }
  throw new ManagedCompanionRefusal(400, 'PLM_MANAGED_BODY_REFUSED')
}

export async function provisionManagedLink(actor: ManagedActor, body: unknown): Promise<{ ok: true; linkId: string; generation: number }> {
  if (!isPlmManagedCompanionEnabled()) throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_DISABLED')
  await requireTables()
  const { record, continuityMode } = provisionRecord(body)
  if (record.ownerOptIn !== true) throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_OWNER_OPT_IN_REQUIRED')
  const issuer = exactString(record.issuer)
  const nativeAuthUserId = exactString(record.nativeAuthUserId)
  const nativeTenantId = exactString(record.nativeTenantId)
  const nativeOrgId = exactString(record.nativeOrgId)
  const metaUserId = exactString(record.metaUserId)
  const metaTenantId = exactString(record.metaTenantId)
  const metaOrgId = exactString(record.metaOrgId)
  const dataSourceId = exactString(record.dataSourceId)
  const rootPartId = partIdOf(exactString(record.rootPartId))
  if (actor.id !== metaUserId && !isAdmin(actor)) throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_ACTOR_REFUSED')
  const registration = registrationFor({ issuer, nativeTenantId, nativeOrgId })
  return transaction(async (client) => {
    await loadUser(client, metaUserId)
    if (trustedTenant(actor) !== metaTenantId) {
      throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_META_MEMBERSHIP_REFUSED')
    }
    await requireMembership(client, metaUserId, metaTenantId)
    await requireMembership(client, metaUserId, metaOrgId)
    const plmOrigin = registeredPlmOrigin(registration)
    let fingerprint = await loadSource(client, dataSourceId, metaUserId, plmOrigin, rootPartId)
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [dataSourceId])
    const existing = await client.query(
      `SELECT generation, status FROM plm_managed_identity_links
       WHERE installation_issuer = $1 AND native_auth_user_id = $2 AND native_tenant_id = $3
         AND native_org_id = $4 AND data_source_id = $5
       ORDER BY generation DESC FOR UPDATE`,
      [registration.issuer, nativeAuthUserId, nativeTenantId, nativeOrgId, dataSourceId],
    )
    if (existing.rows.some((row) => text(row.status) === 'active')) {
      throw new ManagedCompanionRefusal(409, 'PLM_MANAGED_LINK_ACTIVE')
    }
    const binding = await client.query(
      `SELECT generation, status FROM plm_managed_source_bindings WHERE data_source_id = $1 FOR UPDATE`,
      [dataSourceId],
    )
    const bindingRow = binding.rows[0]
    if (bindingRow && text(bindingRow.status) === 'active') {
      throw new ManagedCompanionRefusal(409, 'PLM_MANAGED_BINDING_REFUSED')
    }
    const tupleMax = existing.rows.reduce((max, row) => Math.max(max, Number(row.generation) || 0), 0)
    const sourceGeneration = Math.max(Number(bindingRow?.generation) || 0, tupleMax)
    if (sourceGeneration > 0 && actor.id !== metaUserId) {
      throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_REBIND_OWNER_REQUIRED')
    }
    await handoffPersonalReadConnection(client,dataSourceId,metaUserId,registration,metaTenantId)
    // The seed and link commit share the source lock and transaction; no runtime env fallback.
    if (process.env.PLM_PERSONAL_BOM_CHANGE_READ_ENABLED==='true')
      fingerprint=await loadSource(client,dataSourceId,metaUserId,plmOrigin,rootPartId)
    const linkId = randomUUID()
    const generation = sourceGeneration + 1
    try {
      await client.query(
        `INSERT INTO plm_managed_identity_links (
           id, installation_issuer, native_auth_user_id, native_tenant_id, native_org_id, client_id, callback,
           meta_user_id, meta_tenant_id, meta_org_id, data_source_id, root_part_id, client_origin, generation,
           status, owner_user_id, created_by, source_fingerprint, continuity_mode
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'active',$8,$15,$16,$17
         )`,
        [
          linkId, registration.issuer, nativeAuthUserId, nativeTenantId, nativeOrgId, registration.clientId,
          registration.callback, metaUserId, metaTenantId, metaOrgId, dataSourceId, rootPartId,
          registration.origin, generation, actor.id, fingerprint, continuityMode,
        ],
      )
    } catch (error) {
      if (isUniqueViolation(error)) throw new ManagedCompanionRefusal(409, 'PLM_MANAGED_LINK_ACTIVE')
      throw error
    }
    const bound = await client.query(
      `INSERT INTO plm_managed_source_bindings (
         data_source_id, link_id, generation, source_fingerprint, status, frozen_origin, frozen_root_part_id
       ) VALUES ($1,$2,$3,$4,'active',$5,$6)
       ON CONFLICT (data_source_id) DO UPDATE SET
         link_id = EXCLUDED.link_id,
         generation = EXCLUDED.generation,
         source_fingerprint = EXCLUDED.source_fingerprint,
         status = 'active',
         frozen_origin = EXCLUDED.frozen_origin,
         frozen_root_part_id = EXCLUDED.frozen_root_part_id,
         updated_at = now()
       WHERE plm_managed_source_bindings.generation < EXCLUDED.generation
         AND plm_managed_source_bindings.status = 'blocked'
       RETURNING data_source_id`,
      [dataSourceId, linkId, generation, fingerprint, plmOrigin, rootPartId],
    )
    if (bound.rows.length !== 1) throw new ManagedCompanionRefusal(409, 'PLM_MANAGED_BINDING_REFUSED')
    return { ok: true as const, linkId, generation }
  })
}

async function activeLinkForSource(client: SqlClient, dataSourceId: string, actorId: string): Promise<LinkRow> {
  const result = await client.query(
    `SELECT l.* FROM plm_managed_identity_links l
     JOIN plm_managed_source_bindings b ON b.link_id = l.id AND b.data_source_id = l.data_source_id
     WHERE l.data_source_id = $1 AND l.meta_user_id = $2 AND l.status = 'active' AND b.status = 'active'
     FOR UPDATE`,
    [dataSourceId, actorId],
  )
  const row = result.rows[0]
  if (!row || result.rows.length !== 1) throw new ManagedCompanionRefusal(404, 'PLM_MANAGED_LINK_NOT_FOUND')
  return row
}

type PreparedIntent = {
  registration: ManagedClientRegistration
  state: string
  nonce: string
  challenge: string
  intentId: string
  rootPartId: string
  requestMode: 'ordinary' | 'continuous'
}

function headerValue(req: Request, name: string): string {
  const raw = req.headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' ? value.trim() : ''
}

export function assertManagedBridge(req: Request, action: 'browser-start' | 'complete' | 'logout'): void {
  if (headerValue(req, 'x-metasheet-managed-bridge') !== action) {
    throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_BRIDGE_REFUSED')
  }
}

export function assertManagedOrigin(req: Request, expected: string): void {
  const origin = headerValue(req, 'origin')
  if (!origin || origin !== expected) throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_ORIGIN_REFUSED')
}

function issueIntentCookies(res: Response, prepared: PreparedIntent): void {
  const options = { ...cookieBase(prepared.registration.callback), maxAge: MANAGED_INTENT_TTL_SECONDS * 1000 }
  res.cookie(MANAGED_INTENT_COOKIE, prepared.intentId, options)
  res.cookie(MANAGED_NONCE_COOKIE, prepared.nonce, options)
}

function navigationFor(prepared: PreparedIntent): string {
  return buildManagedLoginNavigation(prepared.registration, {
    rootPartId: prepared.rootPartId,
    state: prepared.state,
    codeChallenge: prepared.challenge,
    continuityHint: prepared.requestMode === 'continuous' ? 'hour' : undefined,
  })
}

/**
 * Insert one intent for an already locked link. The caller owns the transaction.
 * Do not call startManagedLogin from here: that opens another transaction.
 */
async function prepareManagedIntent(
  client: SqlClient,
  actor: ManagedActor,
  link: LinkRow,
  rootPartId: string,
): Promise<PreparedIntent> {
  if (text(link.root_part_id) !== rootPartId) throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_ROOT_REFUSED')
  const registration = registrationFor({
    issuer: text(link.installation_issuer),
    nativeTenantId: text(link.native_tenant_id),
    nativeOrgId: text(link.native_org_id),
  })
  if (registration.clientId !== text(link.client_id) || registration.callback !== text(link.callback)
    || registration.origin !== text(link.client_origin) || registration.issuer !== text(link.installation_issuer)) {
    throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_REGISTRATION_MISMATCH')
  }
  await loadUser(client, actor.id)
  if (trustedTenant(actor) !== text(link.meta_tenant_id)) {
    throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_META_MEMBERSHIP_REFUSED')
  }
  await requireMembership(client, actor.id, text(link.meta_tenant_id))
  await requireMembership(client, actor.id, text(link.meta_org_id))
  const fingerprint = await loadSource(client, text(link.data_source_id), actor.id, registeredPlmOrigin(registration), rootPartId)
  if (fingerprint !== text(link.source_fingerprint)) throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_SOURCE_CHANGED')
  const requestMode = text(link.continuity_mode) === 'continuous'
    ? 'continuous'
    : text(link.continuity_mode) === 'ordinary' ? 'ordinary' : ''
  if (requestMode !== 'ordinary' && requestMode !== 'continuous') {
    throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_LINK_STOPPED')
  }
  const verifier = randomUrlToken(32)
  const state = randomUrlToken(32)
  const nonce = randomUrlToken(32)
  const challenge = pkceS256(verifier)
  const intentId = randomUUID()
  const expires = new Date(Date.now() + MANAGED_INTENT_TTL_SECONDS * 1000)
  await client.query(
    `INSERT INTO plm_managed_browser_intents (
       id, link_id, generation, meta_user_id, meta_tenant_id, meta_org_id, data_source_id, root_part_id,
       client_origin, installation_issuer, native_tenant_id, native_org_id, callback, client_id, state_hash,
       nonce_hash, code_challenge, code_verifier_ciphertext, return_path, status, expires_at, created_at,
       request_mode
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'pending',$20,$21,$22
     )`,
    [
      intentId, text(link.id), Number(link.generation), actor.id, text(link.meta_tenant_id), text(link.meta_org_id),
      text(link.data_source_id), rootPartId, registration.origin, registration.issuer, registration.nativeTenantId,
      registration.nativeOrgId, registration.callback, registration.clientId, sha256Hex(state), sha256Hex(nonce),
      challenge, sealVerifier(verifier), MANAGED_FIXED_RETURN_PATH, expires, new Date(), requestMode,
    ],
  )
  return { registration, state, nonce, challenge, intentId, rootPartId, requestMode }
}

async function assertBrowserIdentity(req: Request, userId: string, tenantId: string): Promise<void> {
  const header = req.headers.authorization
  const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
  if (bearer) {
    if (isManagedCompanionToken(bearer)) throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_BEARER_REFUSED')
    const current = await authService.verifyToken(bearer)
    const tenant = typeof current?.tenantId === 'string' ? current.tenantId.trim() : ''
    if (!current?.id) throw new ManagedCompanionRefusal(401, 'PLM_MANAGED_BEARER_REFUSED')
    if (current.id !== userId || tenant !== tenantId) {
      throw new ManagedCompanionRefusal(409, 'PLM_MANAGED_PERSON_CONFLICT')
    }
  }
  const sessionCookie = readRequestCookie(req.headers.cookie, MANAGED_SESSION_COOKIE)
  if (!sessionCookie) return
  const signedIn = await readLiveManagedCookieIdentity(sessionCookie)
  if (signedIn && (signedIn.userId !== userId || signedIn.tenantId !== tenantId)) {
    throw new ManagedCompanionRefusal(409, 'PLM_MANAGED_PERSON_CONFLICT')
  }
}

export async function startManagedLogin(actor: ManagedActor, body: unknown, res: Response): Promise<{ ok: true; navigationUrl: string }> {
  if (!isPlmManagedCompanionEnabled()) throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_DISABLED')
  await requireTables()
  const record = exactBody(body, ['dataSourceId', 'rootPartId'])
  const dataSourceId = exactString(record.dataSourceId)
  const rootPartId = partIdOf(exactString(record.rootPartId))
  const prepared = await transaction(async (client) => {
    const link = await activeLinkForSource(client, dataSourceId, actor.id)
    return prepareManagedIntent(client, actor, link, rootPartId)
  })
  issueIntentCookies(res, prepared)
  return { ok: true, navigationUrl: navigationFor(prepared) }
}

const BROWSER_START_KEYS = ['issuer', 'nativeTenantId', 'nativeOrgId', 'clientId', 'rootPartId', 'nativeSubjectHint'] as const

export async function startManagedBrowserLogin(req: Request, res: Response): Promise<{ ok: true; navigationUrl: string }> {
  if (!isPlmManagedCompanionEnabled()) throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_DISABLED')
  await requireTables()
  assertManagedBridge(req, 'browser-start')
  const record = exactBody(req.body, BROWSER_START_KEYS)
  const issuer = exactString(record.issuer)
  const nativeTenantId = exactString(record.nativeTenantId)
  const nativeOrgId = exactString(record.nativeOrgId)
  const clientId = exactString(record.clientId)
  const rootPartId = partIdOf(exactString(record.rootPartId))
  const hint = exactString(record.nativeSubjectHint)
  if (hint.length > 128 || /[\s\u0000-\u001f\u007f]/.test(hint)) {
    throw new ManagedCompanionRefusal(400, 'PLM_MANAGED_BODY_REFUSED')
  }
  const registration = registrationFor({ issuer, nativeTenantId, nativeOrgId })
  if (registration.clientId !== clientId) throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_REGISTRATION_MISMATCH')
  assertManagedOrigin(req, registration.origin)
  const prepared = await transaction(async (client) => {
    const locked = await client.query(
      `SELECT l.* FROM plm_managed_identity_links l
       JOIN plm_managed_source_bindings b ON b.link_id = l.id AND b.data_source_id = l.data_source_id
       WHERE l.installation_issuer = $1
         AND l.native_tenant_id = $2
         AND l.native_org_id = $3
         AND l.client_id = $4
         AND l.root_part_id = $5
         AND l.native_auth_user_id = $6
         AND l.status = 'active'
         AND b.status = 'active'
       ORDER BY l.id
       FOR UPDATE OF l, b`,
      [issuer, nativeTenantId, nativeOrgId, clientId, rootPartId, hint],
    )
    if (locked.rows.length === 0) throw new ManagedCompanionRefusal(404, 'PLM_MANAGED_LINK_NOT_FOUND')
    if (locked.rows.length !== 1) throw new ManagedCompanionRefusal(409, 'PLM_MANAGED_LINK_AMBIGUOUS')
    const link = locked.rows[0]
    const actor: ManagedActor = {
      id: text(link.meta_user_id),
      role: null,
      authenticatedTenantId: text(link.meta_tenant_id),
    }
    await assertBrowserIdentity(req, actor.id, text(link.meta_tenant_id))
    return prepareManagedIntent(client, actor, link, rootPartId)
  })
  issueIntentCookies(res, prepared)
  res.set('Cache-Control', 'no-store')
  res.set('Referrer-Policy', 'no-referrer')
  return { ok: true, navigationUrl: navigationFor(prepared) }
}

function presentedPair(code: unknown, state: unknown): { code: string; state: string } {
  if (typeof code !== 'string' || typeof state !== 'string') {
    throw new ManagedCompanionRefusal(400, 'PLM_MANAGED_CALLBACK_REFUSED')
  }
  if (code.length < 1 || code.length > 512 || /[\s\u0000-\u001f\u007f]/.test(code)) {
    throw new ManagedCompanionRefusal(400, 'PLM_MANAGED_CALLBACK_REFUSED')
  }
  if (state.length < 1 || state.length > 512 || /[\s\u0000-\u001f\u007f]/.test(state)) {
    throw new ManagedCompanionRefusal(400, 'PLM_MANAGED_CALLBACK_REFUSED')
  }
  return { code, state }
}

function callbackQuery(req: Request): { code: string; state: string } {
  const query = req.query ?? {}
  const keys = Object.keys(query)
  if (keys.length !== 2 || !keys.includes('code') || !keys.includes('state')) {
    throw new ManagedCompanionRefusal(400, 'PLM_MANAGED_CALLBACK_REFUSED')
  }
  return presentedPair(query.code, query.state)
}

function fixedDestination(row: LinkRow, managed: 'ready' | 'refused', reason?: string): string {
  const params = new URLSearchParams({
    dataSourceId: text(row.data_source_id),
    partId: text(row.root_part_id),
    managed,
  })
  if (reason) params.set('reason', reason)
  return `${MANAGED_FIXED_RETURN_PATH}?${params.toString()}`
}

async function consumeIntent(intentId: string, stateHash: string, nonceHash: string): Promise<boolean> {
  const consumed = await query(
    `UPDATE plm_managed_browser_intents
     SET status = 'consumed', consumed_at = now()
     WHERE id = $1 AND status = 'pending' AND expires_at > now() AND state_hash = $2 AND nonce_hash = $3
     RETURNING id`,
    [intentId, stateHash, nonceHash],
  )
  return consumed.rows.length === 1
}

function exchangeMatches(intent: LinkRow, issued: NativeExchange): boolean {
  return issued.subject === text(intent.native_auth_user_id)
    && issued.tenant_id === text(intent.native_tenant_id)
    && issued.org_id === text(intent.native_org_id)
    && issued.client_id === text(intent.client_id)
    && issued.issuer === text(intent.installation_issuer)
    && issued.scope === MANAGED_COMPANION_SCOPE
    && issued.root_part_id === text(intent.root_part_id)
    && issued.client_origin === text(intent.client_origin)
    && issued.delegation_id.length > 0
}

async function enqueueObservedRevoke(intent: LinkRow, delegationId: string): Promise<void> {
  const retryIdentity = sha256Hex(`${text(intent.generation)}:${delegationId}:${text(intent.client_id)}`)
  await query(
    `INSERT INTO plm_managed_revoke_outbox (
       id, link_id, generation, delegation_id, client_id, installation_issuer, native_tenant_id, native_org_id,
       callback, retry_identity, status, intent_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11)
     ON CONFLICT (generation, delegation_id) DO NOTHING`,
    [
      randomUUID(), text(intent.link_id), Number(intent.generation), delegationId, text(intent.client_id),
      text(intent.installation_issuer), text(intent.native_tenant_id), text(intent.native_org_id),
      text(intent.callback), retryIdentity, text(intent.id),
    ],
  )
}

type CompletionDelivery = 'redirect' | 'json'

function deliverCompletion(
  res: Response,
  delivery: CompletionDelivery,
  destination: string,
  failure?: { status: number; code: string },
): void {
  res.set('Cache-Control', 'no-store')
  res.set('Referrer-Policy', 'no-referrer')
  if (delivery === 'redirect') {
    res.redirect(302, destination)
    return
  }
  if (failure) {
    res.status(failure.status).json({
      ok: false,
      destination,
      error: { code: failure.code, message: 'Managed companion request refused' },
    })
    return
  }
  res.status(200).json({ ok: true, destination })
}

export const MANAGED_RETURN_PATH = '/plm/managed-return'

/** Browser navigation only. Does not read the intent row, exchange, or set a session cookie. */
export function handoffManagedCallback(req: Request, res: Response): void {
  const presented = callbackQuery(req)
  res.set('Cache-Control', 'no-store')
  res.set('Referrer-Policy', 'no-referrer')
  const params = new URLSearchParams({ code: presented.code, state: presented.state })
  res.redirect(302, `${MANAGED_RETURN_PATH}?${params.toString()}`)
}

type ContinuousLock = {
  intent: LinkRow
  link: LinkRow
  binding: LinkRow | null
  session: LinkRow | null
}

type ContinuousStop = {
  kind: 'stop' | 'refused'
  code: string
  status: number
  clearCookies: boolean
}

type ContinuousCommit =
  | { action: 'cookie'; sessionId: string; expiresAt: Date; email: string; role: string }
  | {
    action: 'closed'
    code: string
    status: number
    clearCookies: boolean
    enqueue: boolean
    delegationId: string | null
    storedDelegationId: string | null
  }

function instantSeconds(value: unknown): number | null {
  const date = value instanceof Date ? value : new Date(String(value ?? ''))
  if (Number.isNaN(date.getTime())) return null
  return Math.floor(date.getTime() / 1000)
}

function registrationMatches(registration: ManagedClientRegistration, row: LinkRow): boolean {
  return registration.clientId === text(row.client_id)
    && registration.callback === text(row.callback)
    && registration.origin === text(row.client_origin)
    && registration.issuer === text(row.installation_issuer)
}

function continuousSessionMatches(session: LinkRow, issued: NativeContinuousExchange): boolean {
  if (session.credential_generation === null || session.credential_generation === undefined) return false
  if (Number(session.credential_generation) !== 0 || issued.generation_index !== 0) return false
  if (session.revoked_at) return false
  if (text(session.delegation_id) !== issued.delegation_id) return false
  if (text(session.native_subject) !== issued.subject) return false
  if (text(session.native_tenant_id) !== issued.tenant_id) return false
  if (text(session.native_org_id) !== issued.org_id) return false
  if (text(session.root_part_id) !== issued.root_part_id) return false
  if (text(session.client_origin) !== issued.client_origin) return false
  if (text(session.scope) !== issued.scope) return false
  if (instantSeconds(session.expires_at) !== issued.absolute_exp) return false
  try {
    const claims = decodeBoundYurClaims(openCredential(text(session.credential_ciphertext)))
    return !!claims
      && claims.jti === issued.credential_jti
      && claims.delegation_id === issued.delegation_id
      && claims.exp === issued.absolute_exp
  } catch {
    return false
  }
}

async function lockContinuous(client: SqlClient, intentId: string): Promise<ContinuousLock | null> {
  const peek = await client.query(
    'SELECT link_id, data_source_id FROM plm_managed_browser_intents WHERE id = $1',
    [intentId],
  )
  const linkId = text(peek.rows[0]?.link_id)
  const sourceId = text(peek.rows[0]?.data_source_id)
  if (!linkId || !sourceId) return null
  // Link, then binding, then intent, then session. stopLink locks the link first.
  await client.query('SELECT id FROM plm_managed_identity_links WHERE id = $1 FOR UPDATE', [linkId])
  await client.query('SELECT data_source_id FROM plm_managed_source_bindings WHERE data_source_id = $1 FOR UPDATE', [sourceId])
  const intent = (await client.query('SELECT * FROM plm_managed_browser_intents WHERE id = $1 FOR UPDATE', [intentId])).rows[0]
  const link = (await client.query('SELECT * FROM plm_managed_identity_links WHERE id = $1', [linkId])).rows[0]
  const binding = (await client.query('SELECT * FROM plm_managed_source_bindings WHERE data_source_id = $1', [sourceId])).rows[0] ?? null
  const session = (await client.query('SELECT * FROM plm_managed_sessions WHERE intent_id = $1 FOR UPDATE', [intentId])).rows[0] ?? null
  if (!intent || !link) return null
  return { intent, link, binding, session }
}

function linkStillActive(locked: ContinuousLock): boolean {
  return text(locked.link.status) === 'active'
    && Number(locked.link.generation) === Number(locked.intent.generation)
    && !!locked.binding
    && text(locked.binding.status) === 'active'
    && text(locked.binding.link_id) === text(locked.link.id)
    && Number(locked.binding.generation) === Number(locked.link.generation)
}

async function markContinuousRefused(client: SqlClient, intentId: string): Promise<void> {
  await client.query(
    `UPDATE plm_managed_browser_intents
     SET status = 'refused'
     WHERE id = $1 AND status = 'pending' AND request_mode = 'continuous'
       AND delegation_id IS NULL AND credential_ciphertext IS NULL AND consumed_at IS NULL`,
    [intentId],
  )
}

async function freezeContinuousCode(intentId: string, codeHash: string): Promise<ContinuousStop | { kind: 'exchange' }> {
  return transaction(async (client) => {
    const locked = await lockContinuous(client, intentId)
    if (!locked) return { kind: 'stop', code: 'PLM_MANAGED_BROWSER_REQUIRED', status: 401, clearCookies: true }
    if (text(locked.intent.request_mode) !== 'continuous' || text(locked.link.continuity_mode) !== 'continuous') {
      return { kind: 'stop', code: 'PLM_MANAGED_EXCHANGE_WRONG_MODE', status: 403, clearCookies: true }
    }
    const status = text(locked.intent.status)
    if (status === 'revoked' || !linkStillActive(locked)) {
      return { kind: 'stop', code: 'PLM_MANAGED_LINK_STOPPED', status: 403, clearCookies: true }
    }
    if (status === 'refused') {
      return { kind: 'stop', code: 'PLM_MANAGED_INTENT_CONSUMED', status: 409, clearCookies: true }
    }
    const storedHash = text(locked.intent.completion_code_hash)
    if (status === 'consumed') {
      if (!storedHash || !hashesEqual(storedHash, codeHash)) {
        return { kind: 'stop', code: 'PLM_MANAGED_CALLBACK_REFUSED', status: 401, clearCookies: true }
      }
      return { kind: 'exchange' }
    }
    if (status !== 'pending') {
      return { kind: 'stop', code: 'PLM_MANAGED_INTENT_CONSUMED', status: 409, clearCookies: true }
    }
    const expiresAt = instantSeconds(locked.intent.expires_at)
    if (expiresAt === null || expiresAt * 1000 <= Date.now()) {
      return { kind: 'stop', code: 'PLM_MANAGED_INTENT_EXPIRED', status: 409, clearCookies: true }
    }
    try {
      await loadUser(client, text(locked.intent.meta_user_id))
      await requireMembership(client, text(locked.intent.meta_user_id), text(locked.intent.meta_tenant_id))
      await requireMembership(client, text(locked.intent.meta_user_id), text(locked.intent.meta_org_id))
      const registration = registrationFor({
        issuer: text(locked.intent.installation_issuer),
        nativeTenantId: text(locked.intent.native_tenant_id),
        nativeOrgId: text(locked.intent.native_org_id),
      })
      if (!registrationMatches(registration, locked.intent)) {
        return { kind: 'stop', code: 'PLM_MANAGED_REGISTRATION_MISMATCH', status: 403, clearCookies: false }
      }
      const fingerprint = await loadSource(
        client,
        text(locked.intent.data_source_id),
        text(locked.intent.meta_user_id),
        registeredPlmOrigin(registration),
        text(locked.intent.root_part_id),
      )
      if (fingerprint !== text(locked.link.source_fingerprint)) {
        return { kind: 'stop', code: 'PLM_MANAGED_SOURCE_CHANGED', status: 403, clearCookies: false }
      }
    } catch (error) {
      if (error instanceof ManagedCompanionRefusal) {
        return { kind: 'stop', code: error.code, status: error.status, clearCookies: false }
      }
      throw error
    }
    if (storedHash) {
      if (!hashesEqual(storedHash, codeHash)) {
        await client.query(
          `UPDATE plm_managed_browser_intents
           SET status = 'refused'
           WHERE id = $1 AND status = 'pending' AND request_mode = 'continuous'
             AND completion_code_hash = $2 AND delegation_id IS NULL AND credential_ciphertext IS NULL`,
          [intentId, storedHash],
        )
        return { kind: 'refused', code: 'PLM_MANAGED_CALLBACK_REFUSED', status: 401, clearCookies: true }
      }
      return { kind: 'exchange' }
    }
    const updated = await client.query(
      `UPDATE plm_managed_browser_intents
       SET completion_code_hash = $2
       WHERE id = $1 AND status = 'pending' AND completion_code_hash IS NULL AND request_mode = 'continuous'
       RETURNING id`,
      [intentId, codeHash],
    )
    if (updated.rows.length === 1) return { kind: 'exchange' }
    const again = await client.query(
      'SELECT status, completion_code_hash FROM plm_managed_browser_intents WHERE id = $1',
      [intentId],
    )
    const nextHash = text(again.rows[0]?.completion_code_hash)
    if (text(again.rows[0]?.status) === 'pending' && nextHash && hashesEqual(nextHash, codeHash)) {
      return { kind: 'exchange' }
    }
    if (text(again.rows[0]?.status) === 'pending' && nextHash) {
      await client.query(
        `UPDATE plm_managed_browser_intents
         SET status = 'refused'
         WHERE id = $1 AND status = 'pending' AND completion_code_hash = $2
           AND delegation_id IS NULL AND credential_ciphertext IS NULL`,
        [intentId, nextHash],
      )
      return { kind: 'refused', code: 'PLM_MANAGED_CALLBACK_REFUSED', status: 401, clearCookies: true }
    }
    return { kind: 'stop', code: 'PLM_MANAGED_INTENT_CONSUMED', status: 409, clearCookies: true }
  })
}

function closedResult(
  locked: ContinuousLock,
  issued: NativeContinuousExchange,
  code: string,
  status: number,
  clearCookies: boolean,
  enqueueObserved: boolean,
): ContinuousCommit {
  const storedDelegationId = locked.session ? text(locked.session.delegation_id) : ''
  const observed = issued.delegation_id
  return {
    action: 'closed',
    code,
    status,
    clearCookies,
    enqueue: enqueueObserved && observed.length > 0 && observed !== storedDelegationId,
    delegationId: observed || null,
    storedDelegationId: storedDelegationId || null,
  }
}

async function actorForSession(client: SqlClient, intent: LinkRow): Promise<{ email: string; role: string }> {
  const user = await loadUser(client, text(intent.meta_user_id))
  return {
    email: text(user.email) || `${text(intent.meta_user_id)}@managed.local`,
    role: text(user.role) || 'user',
  }
}

async function commitContinuousExchange(
  intentId: string,
  codeHash: string,
  issued: NativeContinuousExchange,
): Promise<ContinuousCommit> {
  return transaction(async (client) => {
    const locked = await lockContinuous(client, intentId)
    if (!locked) {
      return {
        action: 'closed',
        code: 'PLM_MANAGED_BROWSER_REQUIRED',
        status: 401,
        clearCookies: true,
        enqueue: issued.delegation_id.length > 0,
        delegationId: issued.delegation_id,
        storedDelegationId: null,
      }
    }
    if (!linkStillActive(locked) || text(locked.intent.status) === 'revoked') {
      return closedResult(locked, issued, 'PLM_MANAGED_LINK_STOPPED', 403, true, true)
    }
    await loadUser(client, text(locked.intent.meta_user_id))
    await requireMembership(client, text(locked.intent.meta_user_id), text(locked.intent.meta_tenant_id))
    await requireMembership(client, text(locked.intent.meta_user_id), text(locked.intent.meta_org_id))
    const registration = registrationFor({
      issuer: text(locked.intent.installation_issuer),
      nativeTenantId: text(locked.intent.native_tenant_id),
      nativeOrgId: text(locked.intent.native_org_id),
    })
    if (!registrationMatches(registration, locked.intent)) {
      throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_REGISTRATION_MISMATCH')
    }
    const fingerprint = await loadSource(
      client,
      text(locked.intent.data_source_id),
      text(locked.intent.meta_user_id),
      registeredPlmOrigin(registration),
      text(locked.intent.root_part_id),
    )
    if (fingerprint !== text(locked.link.source_fingerprint)) {
      throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_SOURCE_CHANGED')
    }
    if (text(locked.link.native_auth_user_id) !== issued.subject || text(locked.link.meta_user_id) !== text(locked.intent.meta_user_id)) {
      if (!locked.session && text(locked.intent.status) === 'pending') await markContinuousRefused(client, intentId)
      return closedResult(locked, issued, 'PLM_MANAGED_IDENTITY_REFUSED', 403, true, true)
    }
    const snapshot = { ...locked.intent, native_auth_user_id: locked.link.native_auth_user_id }
    if (!exchangeMatches(snapshot, issued) || issued.generation_index !== 0) {
      if (!locked.session && text(locked.intent.status) === 'pending') await markContinuousRefused(client, intentId)
      return closedResult(locked, issued, 'PLM_MANAGED_EXCHANGE_MISMATCH', 403, true, true)
    }
    if (locked.session) {
      if (!continuousSessionMatches(locked.session, issued)) {
        return closedResult(locked, issued, 'PLM_MANAGED_EXCHANGE_MISMATCH', 409, false, true)
      }
      const actor = await actorForSession(client, locked.intent)
      const expiresAt = locked.session.expires_at instanceof Date
        ? locked.session.expires_at
        : new Date(String(locked.session.expires_at))
      return { action: 'cookie', sessionId: text(locked.session.id), expiresAt, email: actor.email, role: actor.role }
    }
    if (text(locked.intent.status) !== 'pending') {
      return closedResult(locked, issued, 'PLM_MANAGED_INTENT_CONSUMED', 409, true, true)
    }
    const createdAt = new Date()
    const expiresAt = new Date(issued.absolute_exp * 1000)
    const remaining = issued.absolute_exp - Math.floor(Date.now() / 1000)
    const span = expiresAt.getTime() - createdAt.getTime()
    if (remaining < 1 || remaining > 600 || span <= 0 || span > 600_000) {
      await markContinuousRefused(client, intentId)
      return closedResult(locked, issued, 'PLM_MANAGED_SESSION_EXPIRY_REFUSED', 503, true, true)
    }
    if (failSessionInsert) throw new ManagedCompanionRefusal(503, 'PLM_MANAGED_SESSION_COMMIT_FAILED')
    const sealed = sealCredential(issued.credential)
    const stamped = await client.query(
      `UPDATE plm_managed_browser_intents
       SET status = 'consumed', consumed_at = now(), delegation_id = $2, credential_ciphertext = $3
       WHERE id = $1 AND status = 'pending' AND request_mode = 'continuous'
         AND completion_code_hash = $4 AND delegation_id IS NULL AND credential_ciphertext IS NULL
       RETURNING id`,
      [intentId, issued.delegation_id, sealed, codeHash],
    )
    if (stamped.rows.length !== 1) {
      const winner = (await client.query(
        'SELECT * FROM plm_managed_sessions WHERE intent_id = $1 FOR UPDATE',
        [intentId],
      )).rows[0] ?? null
      if (winner && continuousSessionMatches(winner, issued)) {
        const actor = await actorForSession(client, locked.intent)
        const storedExpiry = winner.expires_at instanceof Date ? winner.expires_at : new Date(String(winner.expires_at))
        return { action: 'cookie', sessionId: text(winner.id), expiresAt: storedExpiry, email: actor.email, role: actor.role }
      }
      return closedResult(
        { ...locked, session: winner },
        issued,
        'PLM_MANAGED_INTENT_CONSUMED',
        409,
        false,
        true,
      )
    }
    const sessionId = randomUUID()
    await client.query(
      `INSERT INTO plm_managed_sessions (
         id, intent_id, link_id, data_source_id, generation, delegation_id, credential_ciphertext, expires_at,
         scope, native_subject, native_tenant_id, native_org_id, meta_user_id, meta_tenant_id, meta_org_id,
         root_part_id, client_origin, installation_issuer, client_id, created_at, credential_generation
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,0
       )`,
      [
        sessionId, intentId, text(locked.link.id), text(locked.intent.data_source_id), Number(locked.intent.generation),
        issued.delegation_id, sealed, expiresAt, MANAGED_COMPANION_SCOPE, issued.subject, issued.tenant_id,
        issued.org_id, text(locked.intent.meta_user_id), text(locked.intent.meta_tenant_id), text(locked.intent.meta_org_id),
        issued.root_part_id, issued.client_origin, text(locked.intent.installation_issuer), text(locked.intent.client_id),
        createdAt,
      ],
    )
    const actor = await actorForSession(client, locked.intent)
    return { action: 'cookie', sessionId, expiresAt, email: actor.email, role: actor.role }
  })
}

async function runContinuousCompletion(
  res: Response,
  presented: { code: string; state: string },
  delivery: CompletionDelivery,
  intent: LinkRow,
  callback: string,
  intentId: string,
): Promise<void> {
  const codeHash = sha256Hex(presented.code)
  const deliverFailure = (status: number, code: string, clearCookies: boolean): void => {
    if (clearCookies) clearIntentCookies(res, callback)
    deliverCompletion(res, delivery, fixedDestination(intent, 'refused', code), { status, code })
  }
  const publishCookie = (sessionId: string, expiresAt: Date, email: string, role: string): void => {
    const token = signManagedSessionToken({
      userId: text(intent.meta_user_id),
      email,
      role,
      tenantId: text(intent.meta_tenant_id),
      sessionId,
      expiresAt,
    })
    clearIntentCookies(res, callback)
    res.cookie(MANAGED_SESSION_COOKIE, token, { ...cookieBase(callback), maxAge: Math.max(0, expiresAt.getTime() - Date.now()) })
    deliverCompletion(res, delivery, fixedDestination(intent, 'ready'))
  }
  const enqueueUntracked = async (delegationId: string | null, storedDelegationId: string | null): Promise<void> => {
    if (!delegationId || delegationId === storedDelegationId) return
    await enqueueObservedRevoke(intent, delegationId)
  }
  let frozen: ContinuousStop | { kind: 'exchange' }
  try {
    frozen = await freezeContinuousCode(intentId, codeHash)
  } catch {
    deliverFailure(503, 'PLM_MANAGED_EXCHANGE_UNAVAILABLE', false)
    return
  }
  if (frozen.kind !== 'exchange') {
    deliverFailure(frozen.status, frozen.code, frozen.clearCookies)
    return
  }
  let issued: NativeContinuousExchange
  try {
    const registration = registrationFor({
      issuer: text(intent.installation_issuer),
      nativeTenantId: text(intent.native_tenant_id),
      nativeOrgId: text(intent.native_org_id),
    })
    if (!registrationMatches(registration, intent)) {
      deliverFailure(403, 'PLM_MANAGED_REGISTRATION_MISMATCH', false)
      return
    }
    issued = await nativeExchangeContinuous(registration, {
      code: presented.code,
      codeVerifier: openVerifier(text(intent.code_verifier_ciphertext)),
    })
    if (loseExchangeResponse) {
      throw new ManagedNativeCallRefusal(503, 'PLM_MANAGED_EXCHANGE_UNAVAILABLE', null, true)
    }
  } catch (error) {
    if (error instanceof ManagedNativeCallRefusal && error.unavailable) {
      deliverFailure(503, 'PLM_MANAGED_EXCHANGE_UNAVAILABLE', false)
      return
    }
    const observed = error instanceof ManagedNativeCallRefusal ? error.observedDelegationId : null
    const code = error instanceof ManagedCompanionRefusal ? error.code : 'PLM_MANAGED_EXCHANGE_UNAVAILABLE'
    const status = error instanceof ManagedCompanionRefusal ? error.status : 503
    const terminal = error instanceof ManagedNativeCallRefusal && !error.unavailable
    if (!terminal) {
      deliverFailure(503, 'PLM_MANAGED_EXCHANGE_UNAVAILABLE', false)
      return
    }
    const decision = await transaction(async (client) => {
      const locked = await lockContinuous(client, intentId)
      const stored = locked?.session ? text(locked.session.delegation_id) : ''
      if (locked && !locked.session && text(locked.intent.status) === 'pending') {
        await markContinuousRefused(client, intentId)
      }
      return {
        clearCookies: !locked?.session,
        enqueue: !!observed && observed !== stored,
        stored,
      }
    })
    if (decision.enqueue && observed) await enqueueObservedRevoke(intent, observed)
    deliverFailure(status, code, decision.clearCookies)
    return
  }
  let committed: ContinuousCommit
  try {
    committed = await commitContinuousExchange(intentId, codeHash, issued)
  } catch (error) {
    if (isUniqueViolation(error)) {
      try {
        committed = await commitContinuousExchange(intentId, codeHash, issued)
      } catch (retryError) {
        if (retryError instanceof ManagedCompanionRefusal
          && (retryError.code === 'PLM_MANAGED_SESSION_COMMIT_FAILED'
            || retryError.code === 'PLM_MANAGED_SOURCE_CHANGED'
            || retryError.code === 'PLM_MANAGED_META_MEMBERSHIP_REFUSED'
            || retryError.code === 'PLM_MANAGED_META_USER_REFUSED'
            || retryError.code === 'PLM_MANAGED_REGISTRATION_MISMATCH')) {
          deliverFailure(retryError.status, retryError.code, false)
          return
        }
        deliverFailure(503, 'PLM_MANAGED_EXCHANGE_UNAVAILABLE', false)
        return
      }
    } else if (error instanceof ManagedCompanionRefusal
      && (error.code === 'PLM_MANAGED_SESSION_COMMIT_FAILED'
        || error.code === 'PLM_MANAGED_SOURCE_CHANGED'
        || error.code === 'PLM_MANAGED_META_MEMBERSHIP_REFUSED'
        || error.code === 'PLM_MANAGED_META_USER_REFUSED'
        || error.code === 'PLM_MANAGED_REGISTRATION_MISMATCH')) {
      deliverFailure(error.status, error.code, false)
      return
    } else {
      deliverFailure(503, 'PLM_MANAGED_EXCHANGE_UNAVAILABLE', false)
      return
    }
  }
  if (committed.action === 'closed') {
    await enqueueUntracked(committed.delegationId, committed.storedDelegationId)
    deliverFailure(committed.status, committed.code, committed.clearCookies)
    return
  }
  const fresh = await query(
    `SELECT s.revoked_at, l.status AS link_status
     FROM plm_managed_sessions s
     JOIN plm_managed_identity_links l ON l.id = s.link_id
     WHERE s.id = $1`,
    [committed.sessionId],
  )
  const row = fresh.rows[0]
  if (!row || row.revoked_at || text(row.link_status) !== 'active') {
    deliverFailure(403, 'PLM_MANAGED_LINK_STOPPED', true)
    return
  }
  try {
    publishCookie(committed.sessionId, committed.expiresAt, committed.email, committed.role)
  } catch (error) {
    if (error instanceof ManagedCompanionRefusal && error.code === 'PLM_MANAGED_SESSION_EXPIRY_REFUSED') {
      deliverFailure(error.status, error.code, false)
      return
    }
    deliverFailure(503, 'PLM_MANAGED_EXCHANGE_UNAVAILABLE', false)
  }
}

async function runManagedCompletion(
  req: Request,
  res: Response,
  presented: { code: string; state: string },
  delivery: CompletionDelivery,
  requireOrigin: boolean,
): Promise<void> {
  if (!isPlmManagedCompanionEnabled()) throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_DISABLED')
  await requireTables()
  const intentId = readRequestCookie(req.headers.cookie, MANAGED_INTENT_COOKIE)
  const nonce = readRequestCookie(req.headers.cookie, MANAGED_NONCE_COOKIE)
  if (!intentId || !nonce) throw new ManagedCompanionRefusal(401, 'PLM_MANAGED_BROWSER_REQUIRED')
  const loaded = await query('SELECT * FROM plm_managed_browser_intents WHERE id = $1', [intentId])
  const intent = loaded.rows[0]
  if (!intent) throw new ManagedCompanionRefusal(401, 'PLM_MANAGED_BROWSER_REQUIRED')
  const callback = text(intent.callback)
  if (!hashesEqual(text(intent.nonce_hash), sha256Hex(nonce)) || !hashesEqual(text(intent.state_hash), sha256Hex(presented.state))) {
    clearIntentCookies(res, callback)
    throw new ManagedCompanionRefusal(401, 'PLM_MANAGED_BROWSER_MISMATCH')
  }
  const linkResult = await query('SELECT * FROM plm_managed_identity_links WHERE id = $1', [text(intent.link_id)])
  const link = linkResult.rows[0]
  if (!link || Number(link.generation) !== Number(intent.generation)) {
    clearIntentCookies(res, callback)
    throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_LINK_STOPPED')
  }
  if (requireOrigin) assertManagedOrigin(req, text(intent.client_origin))
  try {
    await assertBrowserIdentity(req, text(intent.meta_user_id), text(intent.meta_tenant_id))
  } catch (error) {
    if (error instanceof ManagedCompanionRefusal
      && (error.code === 'PLM_MANAGED_PERSON_CONFLICT' || error.code === 'PLM_MANAGED_BEARER_REFUSED')) {
      res.status(error.status).json({
        ok: false,
        error: { code: error.code, message: 'Managed login does not replace another signed-in person' },
      })
      return
    }
    throw error
  }
  if (text(intent.request_mode) === 'continuous' || text(link.continuity_mode) === 'continuous') {
    if (text(intent.request_mode) !== 'continuous' || text(link.continuity_mode) !== 'continuous') {
      clearIntentCookies(res, callback)
      deliverCompletion(res, delivery, fixedDestination(intent, 'refused', 'PLM_MANAGED_EXCHANGE_WRONG_MODE'), {
        status: 403,
        code: 'PLM_MANAGED_EXCHANGE_WRONG_MODE',
      })
      return
    }
    await runContinuousCompletion(res, presented, delivery, intent, callback, intentId)
    return
  }
  const consumed = await consumeIntent(intentId, text(intent.state_hash), text(intent.nonce_hash))
  if (!consumed) {
    clearIntentCookies(res, callback)
    throw new ManagedCompanionRefusal(409, 'PLM_MANAGED_INTENT_CONSUMED')
  }
  let observed: NativeExchange | null = null
  try {
    const registration = registrationFor({
      issuer: text(intent.installation_issuer),
      nativeTenantId: text(intent.native_tenant_id),
      nativeOrgId: text(intent.native_org_id),
    })
    if (registration.clientId !== text(intent.client_id) || registration.callback !== text(intent.callback)
      || registration.origin !== text(intent.client_origin) || registration.issuer !== text(intent.installation_issuer)) {
      throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_REGISTRATION_MISMATCH')
    }
    const issued = await nativeExchange(registration, { code: presented.code, codeVerifier: openVerifier(text(intent.code_verifier_ciphertext)) })
    if (loseExchangeResponse) throw new ManagedCompanionRefusal(502, 'PLM_MANAGED_EXCHANGE_LOST')
    observed = issued
    const snapshot = { ...intent, native_auth_user_id: link.native_auth_user_id }
    if (!exchangeMatches(snapshot, issued)) throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_EXCHANGE_MISMATCH')
    const session = await transaction(async (client) => {
      const locked = await client.query(
        'SELECT * FROM plm_managed_identity_links WHERE id = $1 FOR UPDATE',
        [text(intent.link_id)],
      )
      const currentLink = locked.rows[0]
      if (!currentLink || text(currentLink.status) !== 'active' || Number(currentLink.generation) !== Number(intent.generation)) {
        throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_LINK_STOPPED')
      }
      if (text(currentLink.native_auth_user_id) !== issued.subject || text(currentLink.meta_user_id) !== text(intent.meta_user_id)) {
        throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_IDENTITY_REFUSED')
      }
      await loadUser(client, text(intent.meta_user_id))
      await requireMembership(client, text(intent.meta_user_id), text(intent.meta_tenant_id))
      await requireMembership(client, text(intent.meta_user_id), text(intent.meta_org_id))
      const fingerprint = await loadSource(
        client,
        text(intent.data_source_id),
        text(intent.meta_user_id),
        registeredPlmOrigin(registration),
        text(intent.root_part_id),
      )
      if (fingerprint !== text(currentLink.source_fingerprint)) throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_SOURCE_CHANGED')
      const sealed = sealCredential(issued.credential)
      const stamped = await client.query(
        `UPDATE plm_managed_browser_intents
         SET delegation_id = $2, credential_ciphertext = $3
         WHERE id = $1 AND status = 'consumed' AND delegation_id IS NULL
         RETURNING id`,
        [intentId, issued.delegation_id, sealed],
      )
      if (stamped.rows.length !== 1) throw new ManagedCompanionRefusal(409, 'PLM_MANAGED_INTENT_CONSUMED')
      if (failSessionInsert) throw new ManagedCompanionRefusal(503, 'PLM_MANAGED_SESSION_COMMIT_FAILED')
      const sessionId = randomUUID()
      const createdAt = new Date()
      const expiresAt = new Date(createdAt.getTime() + issued.expires_in * 1000)
      await client.query(
        `INSERT INTO plm_managed_sessions (
           id, intent_id, link_id, data_source_id, generation, delegation_id, credential_ciphertext, expires_at,
           scope, native_subject, native_tenant_id, native_org_id, meta_user_id, meta_tenant_id, meta_org_id,
           root_part_id, client_origin, installation_issuer, client_id, created_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
         )`,
        [
          sessionId, intentId, text(currentLink.id), text(intent.data_source_id), Number(intent.generation),
          issued.delegation_id, sealed, expiresAt, MANAGED_COMPANION_SCOPE, issued.subject, issued.tenant_id,
          issued.org_id, text(intent.meta_user_id), text(intent.meta_tenant_id), text(intent.meta_org_id),
          issued.root_part_id, issued.client_origin, text(intent.installation_issuer), text(intent.client_id), createdAt,
        ],
      )
      const user = await loadUser(client, text(intent.meta_user_id))
      return { sessionId, expiresAt, email: text(user.email) || `${text(intent.meta_user_id)}@managed.local`, role: text(user.role) || 'user' }
    })
    const token = signManagedSessionToken({
      userId: text(intent.meta_user_id),
      email: session.email,
      role: session.role,
      tenantId: text(intent.meta_tenant_id),
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
    })
    clearIntentCookies(res, callback)
    res.cookie(MANAGED_SESSION_COOKIE, token, { ...cookieBase(callback), maxAge: issued.expires_in * 1000 })
    deliverCompletion(res, delivery, fixedDestination(intent, 'ready'))
  } catch (error) {
    if (observed) {
      try {
        const registration = registrationFor({
          issuer: text(intent.installation_issuer),
          nativeTenantId: text(intent.native_tenant_id),
          nativeOrgId: text(intent.native_org_id),
        })
        const revoked = await nativeRevoke(registration, observed.delegation_id)
        if (revoked) {
          await query(
            `UPDATE plm_managed_browser_intents
             SET delegation_id = $2
             WHERE id = $1 AND status = 'consumed' AND delegation_id IS NULL`,
            [intentId, observed.delegation_id],
          )
        } else {
          await enqueueObservedRevoke(intent, observed.delegation_id)
        }
      } catch {
        await enqueueObservedRevoke(intent, observed.delegation_id).catch(() => undefined)
      }
    }
    clearIntentCookies(res, callback)
    const refusal = error instanceof ManagedCompanionRefusal ? error : null
    const code = refusal?.code ?? 'PLM_MANAGED_CALLBACK_REFUSED'
    deliverCompletion(res, delivery, fixedDestination(intent, 'refused', code), {
      status: refusal?.status ?? 400,
      code,
    })
  }
}

export async function completeManagedCallback(req: Request, res: Response): Promise<void> {
  await runManagedCompletion(req, res, callbackQuery(req), 'redirect', false)
}

export async function completeManagedBrowserLogin(req: Request, res: Response): Promise<void> {
  assertManagedBridge(req, 'complete')
  const record = exactBody(req.body, ['code', 'state'])
  await runManagedCompletion(req, res, presentedPair(record.code, record.state), 'json', true)
}

async function stopLink(actor: ManagedActor, reason: StopReason, selector: { linkId?: string; dataSourceId?: string }): Promise<{ ok: true; state: 'pending' | 'acked' }> {
  await requireTables()
  const outboxIds = await transaction(async (client) => {
    const found = selector.linkId
      ? await client.query('SELECT * FROM plm_managed_identity_links WHERE id = $1 FOR UPDATE', [selector.linkId])
      : await client.query(
        `SELECT * FROM plm_managed_identity_links
         WHERE data_source_id = $1 AND status = 'active' ORDER BY generation DESC FOR UPDATE`,
        [selector.dataSourceId],
      )
    const link = found.rows[0]
    if (!link || (selector.dataSourceId && text(link.status) !== 'active')) {
      throw new ManagedCompanionRefusal(404, 'PLM_MANAGED_LINK_NOT_FOUND')
    }
    if (actor.id !== text(link.meta_user_id) && !isAdmin(actor)) {
      throw new ManagedCompanionRefusal(404, 'PLM_MANAGED_LINK_NOT_FOUND')
    }
    if (reason === 'transferred' && actor.id !== text(link.owner_user_id)) {
      throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_TRANSFER_OWNER_REQUIRED')
    }
    if (text(link.status) !== 'active') throw new ManagedCompanionRefusal(409, 'PLM_MANAGED_LINK_STOPPED')
    const stopped = await client.query(
      `UPDATE plm_managed_identity_links
       SET status = $2, stopped_at = now(), stop_reason = $2, updated_at = now()
       WHERE id = $1 AND status = 'active' AND generation = $3`,
      [text(link.id), reason, Number(link.generation)],
    )
    if (stopped.rowCount !== 1) throw new ManagedCompanionRefusal(409, 'PLM_MANAGED_LINK_STOPPED')
    await client.query(
      `UPDATE plm_managed_source_bindings
       SET status = 'blocked', updated_at = now()
       WHERE data_source_id = $1 AND link_id = $2 AND generation = $3 AND status = 'active'`,
      [text(link.data_source_id), text(link.id), Number(link.generation)],
    )
    await client.query(
      `UPDATE plm_managed_sessions SET revoked_at = now()
       WHERE link_id = $1 AND generation = $2 AND revoked_at IS NULL`,
      [text(link.id), Number(link.generation)],
    )
    await client.query(
      `UPDATE plm_managed_browser_intents SET status = 'revoked'
       WHERE link_id = $1 AND generation = $2 AND status = 'pending'`,
      [text(link.id), Number(link.generation)],
    )
    const shareIds = await queueSnapshotShareCancellationOnQuery(client.query.bind(client), text(link.id), Number(link.generation))
    const sessions = await client.query(
      `SELECT delegation_id, intent_id FROM plm_managed_sessions WHERE link_id = $1 AND generation = $2`,
      [text(link.id), Number(link.generation)],
    )
    const ids: string[] = []
    for (const session of sessions.rows) {
      const delegationId = text(session.delegation_id)
      if (!delegationId) continue
      const outboxId = randomUUID()
      const inserted = await client.query(
        `INSERT INTO plm_managed_revoke_outbox (
           id, link_id, generation, delegation_id, client_id, installation_issuer, native_tenant_id, native_org_id,
           callback, retry_identity, status, intent_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11)
         ON CONFLICT (generation, delegation_id) DO NOTHING
         RETURNING id`,
        [
          outboxId, text(link.id), Number(link.generation), delegationId, text(link.client_id),
          text(link.installation_issuer), text(link.native_tenant_id), text(link.native_org_id),
          text(link.callback), sha256Hex(`${Number(link.generation)}:${delegationId}:${text(link.client_id)}`),
          text(session.intent_id),
        ],
      )
      ids.push(text(inserted.rows[0]?.id) || outboxId)
    }
    const inflight = await client.query(
      `SELECT 1 FROM plm_managed_browser_intents
       WHERE link_id = $1 AND generation = $2
         AND ${consumedInflightPredicate('')}
       LIMIT 1`,
      [text(link.id), Number(link.generation)],
    )
    return { ids, shareIds, inflight: inflight.rows.length > 0 }
  })
  let pending = outboxIds.inflight
  for (const outboxId of outboxIds.ids) {
    const result = await sendFrozenRevoke(outboxId)
    if (result.state !== 'acked') pending = true
  }
  for (const shareId of outboxIds.shareIds) {
    if (!await drainSnapshotShareCancellation(shareId)) pending = true
  }
  return { ok: true, state: pending ? 'pending' : 'acked' }
}

async function sendFrozenRevoke(outboxId: string): Promise<{ state: 'pending' | 'acked'; delegationId: string }> {
  return transaction(async (client) => {
    const peeked = await client.query('SELECT link_id FROM plm_managed_revoke_outbox WHERE id = $1', [outboxId])
    const linkId = text(peeked.rows[0]?.link_id)
    if (!linkId) throw new ManagedCompanionRefusal(404, 'PLM_MANAGED_OUTBOX_NOT_FOUND')
    await client.query('SELECT id FROM plm_managed_identity_links WHERE id = $1 FOR UPDATE', [linkId])
    const locked = await client.query('SELECT * FROM plm_managed_revoke_outbox WHERE id = $1 FOR UPDATE', [outboxId])
    const row = locked.rows[0]
    if (!row) throw new ManagedCompanionRefusal(404, 'PLM_MANAGED_OUTBOX_NOT_FOUND')
    if (text(row.status) === 'acked') return { state: 'acked' as const, delegationId: text(row.delegation_id) }
    const link = await client.query('SELECT generation FROM plm_managed_identity_links WHERE id = $1', [linkId])
    if (Number(link.rows[0]?.generation) !== Number(row.generation)) {
      throw new ManagedCompanionRefusal(409, 'PLM_MANAGED_REVOKE_GENERATION_REFUSED')
    }
    let registration: ManagedClientRegistration
    try {
      registration = registrationFor({
        issuer: text(row.installation_issuer),
        nativeTenantId: text(row.native_tenant_id),
        nativeOrgId: text(row.native_org_id),
      })
    } catch {
      await client.query(
        `UPDATE plm_managed_revoke_outbox
         SET attempts = attempts + 1, last_error = 'registration_mismatch', updated_at = now()
         WHERE id = $1 AND status = 'pending'`,
        [outboxId],
      )
      return { state: 'pending' as const, delegationId: text(row.delegation_id) }
    }
    if (registration.clientId !== text(row.client_id) || registration.callback !== text(row.callback)) {
      await client.query(
        `UPDATE plm_managed_revoke_outbox
         SET attempts = attempts + 1, last_error = 'registration_mismatch', updated_at = now()
         WHERE id = $1 AND status = 'pending'`,
        [outboxId],
      )
      return { state: 'pending' as const, delegationId: text(row.delegation_id) }
    }
    let acked = false
    try {
      acked = await nativeRevoke(registration, text(row.delegation_id))
    } catch {
      acked = false
    }
    if (!acked) {
      await client.query(
        `UPDATE plm_managed_revoke_outbox
         SET attempts = attempts + 1, last_error = 'native_revoke_failed', updated_at = now()
         WHERE id = $1 AND status = 'pending'`,
        [outboxId],
      )
      return { state: 'pending' as const, delegationId: text(row.delegation_id) }
    }
    const ackedRow = await client.query(
      `UPDATE plm_managed_revoke_outbox
       SET status = 'acked', acked_at = now(), attempts = attempts + 1, last_error = NULL, updated_at = now()
       WHERE id = $1 AND status = 'pending' AND generation = $2 AND delegation_id = $3`,
      [outboxId, Number(row.generation), text(row.delegation_id)],
    )
    const originIntentId = text(row.intent_id)
    if ((ackedRow.rowCount ?? 0) > 0 && originIntentId) {
      await client.query(
        `UPDATE plm_managed_browser_intents
         SET delegation_id = $2
         WHERE id = $1 AND status = 'consumed' AND delegation_id IS NULL`,
        [originIntentId, text(row.delegation_id)],
      )
    }
    return { state: 'acked' as const, delegationId: text(row.delegation_id) }
  })
}

export async function transferManagedLink(actor: ManagedActor, linkId: string, body: unknown): Promise<{ ok: true; state: 'pending' | 'acked' }> {
  exactBody(body ?? {}, [])
  return stopLink(actor, 'transferred', { linkId })
}

export async function revokeManagedLink(actor: ManagedActor, linkId: string, body: unknown): Promise<{ ok: true; state: 'pending' | 'acked' }> {
  exactBody(body ?? {}, [])
  return stopLink(actor, 'revoked', { linkId })
}

export async function unlinkManagedSource(actor: ManagedActor, body: unknown): Promise<{ ok: true; state: 'pending' | 'acked' }> {
  const record = exactBody(body, ['dataSourceId'])
  return stopLink(actor, 'revoked', { dataSourceId: exactString(record.dataSourceId) })
}

export async function retryManagedRevoke(actor: ManagedActor, body: unknown): Promise<{ ok: true; state: 'pending' | 'acked' }> {
  await requireTables()
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ManagedCompanionRefusal(400, 'PLM_MANAGED_BODY_REFUSED')
  }
  const record = body as Record<string, unknown>
  const keys = Object.keys(record).sort().join()
  if (keys === 'dataSourceId') return retrySourceRevokes(actor, exactString(record.dataSourceId))
  if (keys !== 'outboxId') throw new ManagedCompanionRefusal(400, 'PLM_MANAGED_BODY_REFUSED')
  const outboxId = exactString(record.outboxId)
  const owner = await query(
    `SELECT l.meta_user_id,l.data_source_id FROM plm_managed_revoke_outbox o
     JOIN plm_managed_identity_links l ON l.id = o.link_id
     WHERE o.id = $1`,
    [outboxId],
  )
  const metaUserId = text(owner.rows[0]?.meta_user_id)
  if (!metaUserId) throw new ManagedCompanionRefusal(404, 'PLM_MANAGED_OUTBOX_NOT_FOUND')
  if (actor.id !== metaUserId && !isAdmin(actor)) throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_ACTOR_REFUSED')
  const sent = await sendFrozenRevoke(outboxId)
  let pending = sent.state !== 'acked'
  for (const shareId of await pendingSnapshotShareCancellations(text(owner.rows[0]?.data_source_id))) {
    if (!await drainSnapshotShareCancellation(shareId)) pending = true
  }
  return { ok: true, state: pending ? 'pending' : 'acked' }
}

async function retrySourceRevokes(actor: ManagedActor, dataSourceId: string): Promise<{ ok: true; state: 'pending' | 'acked' }> {
  const link = await query(
    `SELECT meta_user_id FROM plm_managed_identity_links
     WHERE data_source_id = $1
     ORDER BY generation DESC
     LIMIT 1`,
    [dataSourceId],
  )
  const metaUserId = text(link.rows[0]?.meta_user_id)
  if (!metaUserId) throw new ManagedCompanionRefusal(404, 'PLM_MANAGED_LINK_NOT_FOUND')
  if (actor.id !== metaUserId && !isAdmin(actor)) throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_ACTOR_REFUSED')
  const pendingRows = await query(
    `SELECT o.id, l.meta_user_id
     FROM plm_managed_revoke_outbox o
     JOIN plm_managed_identity_links l ON l.id = o.link_id
     WHERE l.data_source_id = $1 AND o.status = 'pending'
     ORDER BY o.created_at ASC`,
    [dataSourceId],
  )
  let pending = false
  for (const row of pendingRows.rows) {
    if (text(row.meta_user_id) !== actor.id && !isAdmin(actor)) {
      throw new ManagedCompanionRefusal(403, 'PLM_MANAGED_ACTOR_REFUSED')
    }
    const sent = await sendFrozenRevoke(text(row.id))
    if (sent.state !== 'acked') pending = true
  }
  const inflight = await query(
    `SELECT 1
     FROM plm_managed_browser_intents i
     JOIN plm_managed_identity_links l ON l.id = i.link_id
     WHERE l.data_source_id = $1
       AND ${consumedInflightPredicate('i')}
     LIMIT 1`,
    [dataSourceId],
  )
  if (inflight.rows.length > 0) pending = true
  for (const shareId of await pendingSnapshotShareCancellations(dataSourceId)) {
    if (!await drainSnapshotShareCancellation(shareId)) pending = true
  }
  return { ok: true, state: pending ? 'pending' : 'acked' }
}

export async function readManagedSessionStatus(actor: ManagedActor, dataSourceId: string): Promise<{
  ok: true
  linked: boolean
  pendingRevoke: boolean
  generation: number | null
  expiresAt: string | null
}> {
  await requireTables()
  if (!dataSourceId || dataSourceId !== dataSourceId.trim()) {
    throw new ManagedCompanionRefusal(400, 'PLM_MANAGED_BODY_REFUSED')
  }
  const link = await query(
    `SELECT id, generation, status, meta_user_id FROM plm_managed_identity_links
     WHERE data_source_id = $1 ORDER BY generation DESC LIMIT 1`,
    [dataSourceId],
  )
  const row = link.rows[0]
  if (!row || (text(row.meta_user_id) !== actor.id && !isAdmin(actor))) {
    return { ok: true, linked: false, pendingRevoke: false, generation: null, expiresAt: null }
  }
  const pending = await query(
    `SELECT 1 FROM plm_managed_revoke_outbox o
     JOIN plm_managed_identity_links l ON l.id = o.link_id
     WHERE l.data_source_id = $1 AND o.status = 'pending'
     LIMIT 1`,
    [dataSourceId],
  )
  const inflight = await query(
    `SELECT 1 FROM plm_managed_browser_intents i
     JOIN plm_managed_identity_links l ON l.id = i.link_id
     WHERE l.data_source_id = $1
       AND ${consumedInflightPredicate('i')}
     LIMIT 1`,
    [dataSourceId],
  )
  const session = await query(
    `SELECT expires_at FROM plm_managed_sessions
     WHERE link_id = $1 AND meta_user_id = $2 AND revoked_at IS NULL AND expires_at > now()
     ORDER BY expires_at DESC LIMIT 1`,
    [text(row.id), actor.id],
  )
  const expires = session.rows[0]?.expires_at
  return {
    ok: true,
    linked: text(row.status) === 'active',
    pendingRevoke: pending.rows.length > 0 || inflight.rows.length > 0 || (await pendingSnapshotShareCancellations(dataSourceId)).length > 0,
    generation: Number(row.generation),
    expiresAt: expires ? new Date(expires as string).toISOString() : null,
  }
}

type ManagedBomReadInput = {
  userId: string | undefined
  dataSourceId: string
  partId: string
}

// Server-only projection envelope; it carries no persistent-sharing authority.
export async function relayManagedBomSnapshot(input: ManagedBomReadInput): Promise<
  | { kind: 'legacy' }
  | { kind: 'refusal'; status: number; code: string }
  | { kind: 'ok'; entitled: true; snapshot: ManagedSnapshot; advisoryCapabilities?: unknown }
> {
  const classified = await classifyManagedSource(input.dataSourceId)
  if (classified.kind === 'unbound') return { kind: 'legacy' }
  if (classified.kind === 'schema-missing') return { kind: 'refusal', status: 403, code: 'PLM_MANAGED_SCHEMA_MISSING' }
  if (classified.kind === 'unavailable') return { kind: 'refusal', status: 403, code: 'PLM_MANAGED_BINDING_UNAVAILABLE' }
  if (!isPlmManagedCompanionEnabled()) return { kind: 'refusal', status: 403, code: 'PLM_MANAGED_DISABLED' }
  const store = currentManagedRequest()
  if (!input.userId || !store || store.conflict || !store.sessionId || store.userId !== input.userId) {
    return { kind: 'refusal', status: 403, code: 'PLM_MANAGED_SESSION_REQUIRED' }
  }
  const row = classified.row
  if (input.userId !== row.meta_user_id || input.partId !== row.frozen_root_part_id || !bindingFingerprintMatches(row)) {
    return { kind: 'refusal', status: 403, code: 'PLM_MANAGED_READ_REFUSED' }
  }
  try {
    const found = await query(
      `SELECT id, delegation_id, credential_ciphertext, generation, native_subject, native_tenant_id, native_org_id,
              root_part_id, client_origin, installation_issuer, client_id, expires_at
       FROM plm_managed_sessions
       WHERE id = $1 AND meta_user_id = $2 AND data_source_id = $3 AND generation = $4
         AND revoked_at IS NULL AND expires_at > now()`,
      [store.sessionId, input.userId, input.dataSourceId, row.generation],
    )
    const session = found.rows[0]
    if (!session) return { kind: 'refusal', status: 403, code: 'PLM_MANAGED_SESSION_REQUIRED' }
    if (text(session.root_part_id) !== input.partId || text(session.client_origin) !== row.client_origin
      || text(session.native_subject) !== row.native_auth_user_id
      || text(session.native_tenant_id) !== row.native_tenant_id
      || text(session.native_org_id) !== row.native_org_id
      || text(session.installation_issuer) !== row.installation_issuer) {
      return { kind: 'refusal', status: 403, code: 'PLM_MANAGED_READ_REFUSED' }
    }
    const registration = registrationFor({
      issuer: text(session.installation_issuer),
      nativeTenantId: text(session.native_tenant_id),
      nativeOrgId: text(session.native_org_id),
    })
    if (registration.clientId !== text(session.client_id)) {
      return { kind: 'refusal', status: 403, code: 'PLM_MANAGED_REGISTRATION_MISMATCH' }
    }
    const status = await nativeStatus(registration, text(session.delegation_id))
    if (!status || status.root_part_id !== input.partId || status.client_origin !== text(session.client_origin)
      || status.subject !== text(session.native_subject) || status.scope !== MANAGED_COMPANION_SCOPE
      || status.tenant_id !== text(session.native_tenant_id) || status.org_id !== text(session.native_org_id)
      || status.issuer !== registration.issuer || status.client_id !== registration.clientId
      || status.delegation_id !== text(session.delegation_id)) {
      return { kind: 'refusal', status: 403, code: 'PLM_MANAGED_NATIVE_STATUS_REFUSED' }
    }
    const credential = openCredential(text(session.credential_ciphertext))
    const payload = await nativeManagedContext(registration, credential, input.partId)
    const snapshot = parseManagedSnapshot(payload, {
      part_id: input.partId,
      tenant_id: text(session.native_tenant_id),
      org_id: text(session.native_org_id),
      auth_user_id: text(session.native_subject),
    })
    return { kind: 'ok', entitled: true, snapshot,
      advisoryCapabilities: (payload as Record<string, unknown>).integration_capabilities }
  } catch (error) {
    if (error instanceof ManagedCompanionRefusal) return { kind: 'refusal', status: error.status, code: error.code }
    return { kind: 'refusal', status: error instanceof BomReviewError ? error.status : 502, code: 'PLM_MANAGED_READ_REFUSED' }
  }
}

export async function relayManagedBomContext(input: ManagedBomReadInput): Promise<
  | { kind: 'legacy' }
  | { kind: 'refusal'; status: number; code: string }
  | { kind: 'ok'; entitled: boolean; context: unknown }
> {
  const result = await relayManagedBomSnapshot(input)
  if (result.kind !== 'ok') return result
  return { kind: 'ok', entitled: true, context: result.snapshot.context }
}
