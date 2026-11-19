/**
 * Lane B credential chain.
 *
 * Closed DR-11(a′) selector, remaining-method reads, and broad credential-leg
 * writes on a caller transaction. Exact-grant revoke, evidence detach, the
 * installation witness, and session prelock are the strict login grant store's
 * static exports. This file does not probe the catalog and does not treat a
 * missing relation as never-installed.
 *
 * Production flags are not set here.
 */

import {
  collectStrictGrantSessionUsers,
  detachEvidenceForIdentities,
  prelockUserSessionWatermarks,
  readConnectionLoginScope,
  readCurrentConnectionLoginScope,
  readStrictLoginInstallation,
  revokeForIdentity,
  revokeForUserInScope,
  revokeSessionsForExactGrants,
  type StrictLoginGrantCaller,
  type StrictLoginGrantRevokeReason,
} from './strict-login-grant-store.js'
import { currentStrictGrantUsable } from './strict-dingtalk-entry.js'

const PROVIDER = 'dingtalk'
const ORIGIN_BRAND = Symbol('closedExternalOrigin')
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const CREDENTIAL_REVOCATION_FLAG = 'DIRECTORY_DEPROVISION_REVOKE_CREDENTIALS_ENABLED'

export type QueryClient = {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>
}

export class StrictCredentialChainError extends Error {
  readonly code: string
  readonly statusCode: number

  constructor(code: string, message: string, statusCode = 409) {
    super(message)
    this.name = 'StrictCredentialChainError'
    this.code = code
    this.statusCode = statusCode
  }
}

export type ClosedExternalOrigin = Readonly<
  | { kind: 'password'; readonly [ORIGIN_BRAND]: true }
  | { kind: 'dingtalk'; connectionId: string; readonly [ORIGIN_BRAND]: true }
>

export function closedPasswordOrigin(): ClosedExternalOrigin {
  return Object.freeze({ kind: 'password', [ORIGIN_BRAND]: true as const })
}

export function closedDingTalkOrigin(connectionId: string): ClosedExternalOrigin {
  const id = requireUuid(connectionId, 'STRICT_CONNECTION_ID')
  return Object.freeze({ kind: 'dingtalk', connectionId: id, [ORIGIN_BRAND]: true as const })
}

export function isClosedExternalOrigin(value: unknown): value is ClosedExternalOrigin {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string | symbol, unknown>
  if (record[ORIGIN_BRAND] !== true) return false
  if (record.kind === 'password') return true
  return record.kind === 'dingtalk' && typeof record.connectionId === 'string' && UUID_RE.test(record.connectionId)
}

/** Exact literal only. Trimmed, folded, or numeric values stay off. */
export function credentialRevocationFlagOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CREDENTIAL_REVOCATION_FLAG] === 'true'
}

export type CredentialLegs = Readonly<{ sessions: boolean; tokens: boolean }>

export type DeprovisionCredentialFacts = Readonly<{
  surface: 'deprovision'
  /** Legacy `user_changed` effect. */
  user: boolean
  /** CLEAR and at least one legacy directory effect, including membership only. */
  departAll: boolean
  /** Globally clear: no other linked directory source remains. */
  clear: boolean
  /** This call terminal-revoked at least one strict grant. */
  strict: boolean
  /** Legacy `grant_changed` effect. */
  grant: boolean
  /** `noRemainingLoginMethod` after the writes. */
  noMethod: boolean
}>

export type LinkedUnbindCredentialFacts = Readonly<{
  surface: 'linked_admin_unbind'
  closesAuthorization: boolean
  strict: boolean
  clear: boolean
  noMethod: boolean
}>

export type ClosedCredentialFacts =
  | DeprovisionCredentialFacts
  | LinkedUnbindCredentialFacts
  | Readonly<{ surface: 'unlinked_admin_unbind' }>
  | Readonly<{ surface: 'admin_disable' }>
  | Readonly<{ surface: 'privilege_elevation' }>
  | Readonly<{ surface: 'recycle_purge' }>
  | Readonly<{ surface: 'legacy_admin_grant_switch' }>

type FormulaBits = {
  grant: boolean
  user: boolean
  strict: boolean
  clear: boolean
  noMethod: boolean
  departAll: boolean
}

/**
 * Sessions = GRANT || USER || (STRICT && LEFT) || DEPART_ALL.
 * Tokens = USER || (LEFT && (GRANT || STRICT)) || DEPART_ALL.
 * LEFT = CLEAR || NO_METHOD.
 * Any flag value other than exact true leaves both legs off.
 * Callers pass facts. This function does not read the database.
 */
export function selectCredentialLegs(facts: ClosedCredentialFacts, flagOn: boolean): CredentialLegs {
  if (flagOn !== true) return { sessions: false, tokens: false }
  const bits = formulaBits(facts)
  const left = bits.clear || bits.noMethod
  return {
    sessions: bits.grant || bits.user || (bits.strict && left) || bits.departAll,
    tokens: bits.user || (left && (bits.grant || bits.strict)) || bits.departAll,
  }
}

function formulaBits(facts: ClosedCredentialFacts): FormulaBits {
  if (facts.surface === 'deprovision') {
    if (facts.departAll && !facts.clear) {
      throw new StrictCredentialChainError(
        'STRICT_CREDENTIAL_FACT',
        'DEPART_ALL requires CLEAR',
      )
    }
    return {
      grant: facts.grant,
      user: facts.user,
      strict: facts.strict,
      clear: facts.clear,
      noMethod: facts.noMethod,
      departAll: facts.departAll,
    }
  }
  if (facts.surface === 'linked_admin_unbind') {
    return {
      grant: facts.closesAuthorization,
      user: false,
      strict: facts.strict,
      clear: facts.clear,
      noMethod: facts.noMethod,
      departAll: false,
    }
  }
  return {
    grant: false,
    user: false,
    strict: false,
    clear: false,
    noMethod: false,
    departAll: false,
  }
}

/**
 * True when the account has no usable local password, no enabled legacy
 * DingTalk grant on a connection that admits one, and no current usable
 * strict grant. The strict half is `currentStrictGrantUsable`. A departed
 * connection is that reader's exception. A failed read aborts.
 */
export async function noRemainingLoginMethod(
  client: QueryClient,
  input: { userId: string; departedConnectionId?: string | null },
): Promise<boolean> {
  const userId = String(input.userId || '').trim()
  if (!userId) {
    throw new StrictCredentialChainError('STRICT_USER_REQUIRED', 'userId is required')
  }
  const departed = input.departedConnectionId
    ? requireUuid(input.departedConnectionId, 'STRICT_CONNECTION_ID')
    : null
  if (await usableLocalPassword(client, userId)) return false
  if (await eligibleLegacyGrantRemains(client, userId, departed)) return false
  if (await currentStrictGrantUsable(asCaller(client), {
    userId,
    exceptConnectionId: departed,
  })) return false
  return true
}

export async function otherDirectorySourceRemains(
  client: QueryClient,
  input: { userId: string; exceptAccountId?: string | null },
): Promise<boolean> {
  const except = input.exceptAccountId && UUID_RE.test(input.exceptAccountId)
    ? input.exceptAccountId
    : null
  const result = await client.query(
    `SELECT 1 AS present
       FROM directory_account_links link
       JOIN directory_accounts account ON account.id = link.directory_account_id
      WHERE link.local_user_id = $1::text
        AND link.link_status = 'linked'
        AND ($2::uuid IS NULL OR link.directory_account_id IS DISTINCT FROM $2::uuid)
      LIMIT 1`,
    [input.userId, except],
  )
  return Boolean(result.rows[0])
}

export async function shareIntegrations(
  client: QueryClient,
  connectionIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(connectionIds.map((id) => requireUuid(id, 'STRICT_CONNECTION_ID')))].sort()
  if (ids.length === 0) return
  await client.query(
    `SELECT id FROM directory_integrations WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE`,
    [ids],
  )
}

export async function lockIdentitiesForUpdate(
  client: QueryClient,
  identityIds: readonly string[],
): Promise<void> {
  const ids = [...new Set(identityIds.map((id) => requireUuid(id, 'STRICT_IDENTITY_ID')))].sort()
  if (ids.length === 0) return
  await client.query(
    `SELECT id FROM user_external_identities WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [ids],
  )
}

/**
 * Locking scope read for issuance and legacy writes.
 * Never-installed admits the legacy path. Installed plus a scope row does not.
 * The remaining-method helper does not use this function.
 */
export async function connectionAdmitsLegacyGrant(
  client: QueryClient,
  connectionId: string,
): Promise<boolean> {
  const read = await readConnectionLoginScope(asCaller(client), requireUuid(connectionId, 'STRICT_CONNECTION_ID'))
  if (read.installation === 'never-installed') return true
  return read.scope === null
}

/**
 * After the caller holds the user row. Shares the stored integration through
 * `readConnectionLoginScope`. A strict connection throws before the legacy write.
 */
export async function refuseStrictLegacyDingTalkWrite(
  client: QueryClient,
  corpId: string | null | undefined,
): Promise<ClosedExternalOrigin | null> {
  const resolved = await resolveStoredDingTalkConnections(client, corpId)
  if (resolved.status === 'none') return null
  if (resolved.status === 'ambiguous') {
    if (resolved.anyStrict) {
      throw new StrictCredentialChainError(
        'strict_connection_ambiguous',
        'DingTalk legacy login cannot choose among strict connections',
        503,
      )
    }
    return null
  }
  if (resolved.strict) {
    throw new StrictCredentialChainError(
      'strict_connection',
      'DingTalk legacy login is closed for this connection',
      403,
    )
  }
  return closedDingTalkOrigin(resolved.connectionId)
}

/** Installed live evidence on a strict connection refuses before a legacy identity write. */
export async function refuseStrictLiveEvidence(client: QueryClient, userId: string): Promise<void> {
  const installation = await readStrictLoginInstallation(asCaller(client))
  if (installation.installation !== 'installed') return
  const rows = await client.query(
    `SELECT DISTINCT e.connection_id::text AS connection_id
       FROM user_external_identity_evidence e
       JOIN user_external_identities identity
         ON identity.id = e.live_identity_id
         OR identity.id::text = e.identity_id
      WHERE identity.local_user_id = $1::text
        AND identity.provider = $2::text
        AND e.revoked_at IS NULL
        AND e.live_identity_id IS NOT NULL`,
    [userId, PROVIDER],
  )
  for (const row of rows.rows) {
    const connectionId = String(row.connection_id || '')
    if (!UUID_RE.test(connectionId)) continue
    if (!await connectionAdmitsLegacyGrant(client, connectionId)) {
      throw new StrictCredentialChainError(
        'strict_connection',
        'DingTalk legacy identity write is closed for this connection',
        403,
      )
    }
  }
}

export async function assertOrdinaryIssuerAllowsLegacySession(
  client: QueryClient,
  origin: ClosedExternalOrigin | null,
): Promise<void> {
  if (origin === null || origin.kind === 'password') return
  if (!isClosedExternalOrigin(origin) || origin.kind !== 'dingtalk') {
    throw new StrictCredentialChainError(
      'STRICT_ORIGIN_UNCLOSED',
      'Ordinary issuer origin is not a closed connection',
      403,
    )
  }
  if (!await connectionAdmitsLegacyGrant(client, origin.connectionId)) {
    throw new StrictCredentialChainError(
      'strict_connection',
      'Ordinary session issuer is closed for this connection',
      403,
    )
  }
}

export async function finishDeprovisionCredentials(
  client: QueryClient,
  input: {
    userId: string
    actorId: string
    connectionId: string
    runId: string | null
    eventId: string | null
    accountId?: string | null
    orgId?: string | null
    user: boolean
    departAll: boolean
    clear: boolean
    grant: boolean
  },
): Promise<{ grantIds: readonly string[]; legs: CredentialLegs }> {
  const caller = asCaller(client)
  const connectionId = requireUuid(input.connectionId, 'STRICT_CONNECTION_ID')
  const scope = await readConnectionLoginScope(caller, connectionId)
  let grantIds: readonly string[] = []
  if (scope.installation === 'installed' && scope.scope) {
    const revoked = await revokeForUserInScope(caller, connectionId, input.userId, {
      reason: 'deprovision',
      revokedBy: input.actorId,
      revokedEventId: input.eventId,
      revokedRunId: input.runId,
      revokedAccountId: input.accountId ?? null,
      revokedOrgId: input.orgId ?? null,
    })
    grantIds = revoked.grantIds
  }
  const flagOn = credentialRevocationFlagOn()
  const strict = grantIds.length > 0
  // NO_METHOD can affect the selector only while LEFT and both unconditional legs are false.
  const needsNoMethod = flagOn && !input.clear && !input.user && !input.departAll && (input.grant || strict)
  const noMethod = needsNoMethod
    ? await noRemainingLoginMethod(client, { userId: input.userId, departedConnectionId: connectionId })
    : false
  const legs = selectCredentialLegs({
    surface: 'deprovision',
    user: input.user,
    departAll: input.departAll,
    clear: input.clear,
    strict,
    grant: input.grant,
    noMethod,
  }, flagOn)
  await sealExactAndCredentialSessions(client, {
    userId: input.userId,
    actorId: input.actorId,
    reason: 'directory-deprovision',
    grantIds,
    legs,
  })
  return { grantIds, legs }
}

/**
 * Detach and terminal-revoke before an identity DELETE. Never-installed returns
 * without calling the store mutators. Does not insert a watermark of its own.
 */
export async function completeIdentityDeletion(
  client: QueryClient,
  input: {
    userId: string
    identityIds: readonly string[]
    actorId: string
    reason: Exclude<StrictLoginGrantRevokeReason, 'deprovision'>
  },
): Promise<{ grantIds: readonly string[] }> {
  if (input.identityIds.length === 0) return { grantIds: [] }
  const caller = asCaller(client)
  const installation = await readStrictLoginInstallation(caller)
  if (installation.installation === 'never-installed') return { grantIds: [] }
  const identityIds = input.identityIds.map((id) => requireUuid(id, 'STRICT_IDENTITY_ID'))
  await detachEvidenceForIdentities(caller, identityIds)
  const revoked = await revokeForIdentity(caller, identityIds, {
    reason: input.reason,
    revokedBy: input.actorId,
  })
  return { grantIds: revoked.grantIds }
}

/**
 * One watermark prelock of the exact-grant session users union the credential-leg
 * user, then the credential watermark value update, then exact-grant session
 * revocation. Broad session and token writes run after that and do not take a
 * new watermark lock.
 */
export async function sealExactAndCredentialSessions(
  client: QueryClient,
  input: {
    userId: string
    actorId: string
    reason: string
    grantIds: readonly string[]
    legs: CredentialLegs
  },
): Promise<void> {
  if (input.grantIds.length === 0 && !input.legs.sessions && !input.legs.tokens) return
  const caller = asCaller(client)
  const sessionUsers = input.grantIds.length > 0
    ? await collectStrictGrantSessionUsers(caller, input.grantIds)
    : []
  const prelockIds = sortedUnique(input.legs.sessions ? [...sessionUsers, input.userId] : sessionUsers)
  if (prelockIds.length > 0) await prelockUserSessionWatermarks(caller, prelockIds)
  if (input.legs.sessions) {
    await advanceHeldCredentialWatermark(client, input.userId, input.actorId, input.reason)
  }
  if (input.grantIds.length > 0) {
    await revokeSessionsForExactGrants(caller, {
      grantIds: input.grantIds,
      updatedBy: input.actorId,
    })
  }
  await applySelectedCredentialLegs(client, input)
}

/**
 * Admin legacy `user_external_auth_grants` switch for one already-locked user.
 * Delegates to the set composer. The caller still writes the legacy row.
 */
export async function guardAdminLegacyGrantSwitch(
  client: QueryClient,
  input: { userId: string; actorId: string; enabled: boolean },
): Promise<{ grantIds: readonly string[] }> {
  return guardAdminLegacyGrantSwitchSet(client, {
    userIds: [input.userId],
    actorId: input.actorId,
    enabled: input.enabled,
  })
}

/**
 * One pass over the complete already-locked target set. Every integration
 * scope read and every identity revoke finishes before the one exact-grant
 * session seal. Enable refusal and ambiguous disable throw before a revoke.
 * Never-installed admits the caller's legacy write. Broad legs stay off, so
 * the prelock set is only the session users collected for the revoked grants.
 */
export async function guardAdminLegacyGrantSwitchSet(
  client: QueryClient,
  input: { userIds: readonly string[]; actorId: string; enabled: boolean },
): Promise<{ grantIds: readonly string[] }> {
  const actorId = String(input.actorId || '').trim()
  const userIds = uniqueInOrder(input.userIds)
  if (!actorId || userIds.length === 0) {
    throw new StrictCredentialChainError('STRICT_USER_REQUIRED', 'userId and actorId are required', 400)
  }
  const connections = await client.query(
    `SELECT DISTINCT link.local_user_id::text AS user_id,
            integration.id::text AS id
       FROM directory_account_links link
       JOIN directory_accounts account ON account.id = link.directory_account_id
       JOIN directory_integrations integration ON integration.id = account.integration_id
      WHERE link.local_user_id = ANY($1::text[])
        AND link.link_status = 'linked'
        AND account.provider = $2::text
        AND integration.provider = $2::text
      ORDER BY id, user_id`,
    [userIds, PROVIDER],
  )
  const byUser = new Map<string, string[]>(userIds.map((userId) => [userId, []]))
  for (const row of connections.rows) {
    const userId = String(row.user_id || '').trim()
    const connectionId = String(row.id || '').trim()
    const owned = byUser.get(userId)
    if (!owned || !connectionId) continue
    const id = requireUuid(connectionId, 'STRICT_CONNECTION_ID')
    if (!owned.includes(id)) owned.push(id)
  }
  const admits = new Map<string, boolean>()
  for (const connectionId of sortedUnique(userIds.flatMap((userId) => byUser.get(userId) ?? []))) {
    admits.set(connectionId, await connectionAdmitsLegacyGrant(client, connectionId))
  }
  const strictByUser = new Map<string, string[]>()
  for (const userId of userIds) {
    strictByUser.set(
      userId,
      (byUser.get(userId) ?? []).filter((connectionId) => admits.get(connectionId) === false),
    )
  }
  if (input.enabled) {
    if ([...strictByUser.values()].some((ids) => ids.length > 0)) {
      throw new StrictCredentialChainError(
        'strict_connection',
        'DingTalk legacy grant enable is closed for a strict connection',
        403,
      )
    }
    return { grantIds: [] }
  }
  if ([...strictByUser.values()].some((ids) => ids.length > 1)) {
    throw new StrictCredentialChainError(
      'strict_connection_ambiguous',
      'DingTalk legacy grant disable cannot choose among strict connections',
      503,
    )
  }
  const revokeUserIds = userIds.filter((userId) => (strictByUser.get(userId) ?? []).length === 1)
  if (revokeUserIds.length === 0) return { grantIds: [] }
  const identities = await client.query(
    `SELECT id::text AS id
       FROM user_external_identities
      WHERE local_user_id = ANY($1::text[])
        AND provider = $2::text
      ORDER BY id`,
    [revokeUserIds, PROVIDER],
  )
  const identityIds = sortedUnique(
    identities.rows
      .map((row) => String(row.id || '').trim())
      .filter((id) => id.length > 0)
      .map((id) => requireUuid(id, 'STRICT_IDENTITY_ID')),
  )
  if (identityIds.length === 0) return { grantIds: [] }
  const revoked = await revokeForIdentity(asCaller(client), identityIds, {
    reason: 'admin_disable',
    revokedBy: actorId,
  })
  await sealExactAndCredentialSessions(client, {
    userId: revokeUserIds[0],
    actorId,
    reason: 'admin-legacy-grant-disable',
    grantIds: revoked.grantIds,
    legs: selectCredentialLegs({ surface: 'legacy_admin_grant_switch' }, credentialRevocationFlagOn()),
  })
  return { grantIds: revoked.grantIds }
}

async function resolveStoredDingTalkConnections(
  client: QueryClient,
  corpId: string | null | undefined,
): Promise<
  | { status: 'none' }
  | { status: 'unique'; connectionId: string; strict: boolean }
  | { status: 'ambiguous'; anyStrict: boolean }
> {
  const corp = String(corpId || '').trim()
  if (!corp) return { status: 'none' }
  const found = await client.query(
    `SELECT id::text AS id
       FROM directory_integrations
      WHERE provider = $1::text
        AND btrim(corp_id) = $2::text
      ORDER BY id`,
    [PROVIDER, corp],
  )
  const ids = found.rows.map((row) => String(row.id)).filter((id) => UUID_RE.test(id))
  if (ids.length === 0) return { status: 'none' }
  const caller = asCaller(client)
  const strictIds: string[] = []
  for (const id of ids) {
    const read = await readConnectionLoginScope(caller, id)
    if (read.installation === 'installed' && read.scope) strictIds.push(id)
  }
  if (ids.length > 1) return { status: 'ambiguous', anyStrict: strictIds.length > 0 }
  return { status: 'unique', connectionId: ids[0], strict: strictIds.length === 1 }
}

/**
 * Broad session and token legs. Does not insert or lock a watermark.
 * `sealExactAndCredentialSessions` advances the held watermark before exact-grant
 * session locks, then calls this.
 */
export async function applySelectedCredentialLegs(
  client: QueryClient,
  input: {
    userId: string
    actorId: string
    reason: string
    legs: CredentialLegs
  },
): Promise<void> {
  await reselectHeldUser(client, input.userId)
  if (input.legs.sessions) {
    await client.query(
      `UPDATE user_sessions
          SET revoked_at = clock_timestamp()
        WHERE user_id = $1::text
          AND revoked_at IS NULL`,
      [input.userId],
    )
  }
  if (input.legs.tokens) {
    await client.query(
      `UPDATE multitable_api_tokens
          SET revoked = TRUE,
              revoked_at = clock_timestamp()
        WHERE created_by = $1::text
          AND revoked = FALSE
        RETURNING id`,
      [input.userId],
    )
  }
}

export function apiTokenBearer(header: unknown): string {
  if (typeof header !== 'string') return ''
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header)
  return match ? match[1] : ''
}

export function refuseZeroReturning(rowCount: number, message: string): void {
  if (rowCount === 0) {
    throw new StrictCredentialChainError('API_TOKEN_REVOKED_CONCURRENTLY', message, 401)
  }
}

function requireUuid(value: string, code: string): string {
  const id = String(value || '').trim()
  if (!UUID_RE.test(id)) {
    throw new StrictCredentialChainError(code, 'Identifier is not a UUID')
  }
  return id
}

async function usableLocalPassword(client: QueryClient, userId: string): Promise<boolean> {
  const result = await client.query(
    `SELECT (
        COALESCE(local_password_set, TRUE) = TRUE
        AND COALESCE(is_active, FALSE) = TRUE
        AND COALESCE(activation_status, 'activated') = 'activated'
        AND password_hash IS NOT NULL
        AND length(btrim(password_hash)) > 0
        AND password_hash NOT LIKE 'unusable:%'
        AND deleted_at IS NULL
        AND purged_at IS NULL
      ) AS usable
       FROM users
      WHERE id = $1::text`,
    [userId],
  )
  if (!result.rows[0]) return false
  return result.rows[0].usable === true
}

async function eligibleLegacyGrantRemains(
  client: QueryClient,
  userId: string,
  departedConnectionId: string | null,
): Promise<boolean> {
  const grant = await client.query(
    `SELECT 1 AS present
       FROM user_external_auth_grants grant_row
      WHERE grant_row.provider = $2::text
        AND grant_row.local_user_id = $1::text
        AND grant_row.enabled = TRUE
      LIMIT 1`,
    [userId, PROVIDER],
  )
  if (!grant.rows[0]) return false
  const connections = await client.query(
    `SELECT DISTINCT integration.id::text AS id
       FROM directory_account_links link
       JOIN directory_accounts account ON account.id = link.directory_account_id
       JOIN directory_integrations integration ON integration.id = account.integration_id
      WHERE link.local_user_id = $1::text
        AND link.link_status = 'linked'
        AND account.provider = $2::text
        AND account.is_active = TRUE
        AND integration.provider = $2::text
        AND ($3::uuid IS NULL OR integration.id IS DISTINCT FROM $3::uuid)
      ORDER BY id`,
    [userId, PROVIDER, departedConnectionId],
  )
  for (const row of connections.rows) {
    const connectionId = String(row.id || '').trim()
    if (!connectionId) continue
    const read = await readCurrentConnectionLoginScope(
      asCaller(client),
      requireUuid(connectionId, 'STRICT_CONNECTION_ID'),
    )
    if (read.installation === 'never-installed' || read.scope === null) return true
  }
  return false
}

async function advanceHeldCredentialWatermark(
  client: QueryClient,
  userId: string,
  actorId: string,
  reason: string,
): Promise<void> {
  const watermark = await client.query(
    `UPDATE user_session_revocations
        SET revoked_after = GREATEST(user_session_revocations.revoked_after, clock_timestamp()),
            updated_at = clock_timestamp(),
            updated_by = $2::text,
            reason = $3::text
      WHERE user_id = $1::text
      RETURNING user_id`,
    [userId, actorId, reason],
  )
  if (!watermark.rows[0]) {
    throw new StrictCredentialChainError(
      'STRICT_WATERMARK_NOT_PRELOCKED',
      'Credential session leg requires a watermark row already locked before session revocation',
      503,
    )
  }
}

function asCaller(client: QueryClient): StrictLoginGrantCaller {
  return client as StrictLoginGrantCaller
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

function uniqueInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const value of values) {
    const id = String(value || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    ordered.push(id)
  }
  return ordered
}

async function reselectHeldUser(client: QueryClient, userId: string): Promise<void> {
  const locked = await client.query(
    `SELECT id FROM users WHERE id = $1::text FOR UPDATE`,
    [userId],
  )
  if (!locked.rows[0]) {
    throw new StrictCredentialChainError('STRICT_USER_NOT_HELD', 'User row is not held for credential revocation')
  }
}
