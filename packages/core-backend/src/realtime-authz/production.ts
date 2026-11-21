/**
 * Production wiring of realtime protection for one serving process.
 *
 * Everything here reads the authoritative database through the process pool with the strict readers
 * of this directory. The credential binder verifies signature and expiry only; whether the session
 * is current is always decided by the authority reader, never by claims of the credential and never
 * by a helper that answers permissively when a structure cannot be read.
 */
import { Client } from 'pg'
import { authService } from '../auth/AuthService'
import { CREDENTIAL_REVOCATION_FLAG } from '../auth/strict-credential-chain'
import { classifyVerifiedSessionPayload, verifyPersistedStrictSession } from '../auth/strict-dingtalk-entry'
import { poolManager } from '../integration/db/connection-pool'
import { createRealtimeAuthorityReader, type AuthorityQuery } from './authority-read'
import { realtimeDiagnostics, type RealtimeDiagnostics } from './diagnostics'
import {
  enablementRecordNotDefinedInThisBuild,
  probeRealtimeInstallation,
  type ProbeCaller,
  type RealtimeInstallationFacts,
} from './installation-probe'
import {
  createRealtimeProtection,
  type CredentialBinder,
  type InvalidationListenerPort,
  type RealtimeProtectionRuntime,
} from './protection'
import { ProtectedConnections } from './protected-connections'
import { readDatabaseIdentity } from './database-identity'
import { PgInvalidationListener, type ListenerClient } from './pg-invalidation-listener'
import { REALTIME_REVALIDATION_FLAG } from './revalidation-flag'
import { bindVerifiedSessionClaims, type RealtimeSessionBinding } from './session-binding'

const authorityQuery: AuthorityQuery = async (sql, params) => {
  const result = await poolManager.get().query(sql, params)
  return { rows: result.rows as Array<Record<string, unknown>> }
}

async function verifyStrictSession(binding: RealtimeSessionBinding): Promise<boolean> {
  const principal = await poolManager.get().transaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    return verifyPersistedStrictSession({ query: (sql, params) => client.query(sql, params) }, binding.claims)
  })
  return principal !== null && principal !== undefined && principal.id === binding.userId
}

async function withReadOnlySnapshot<T>(work: (caller: ProbeCaller) => Promise<T>): Promise<T> {
  return poolManager.get().transaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    return work({ query: async (sql, params) => client.query(sql, params) })
  })
}

async function readStrictInstallation(caller: ProbeCaller): Promise<'installed' | 'never-installed'> {
  const { readStrictLoginInstallation } = await import('../auth/strict-login-grant-store')
  const installation = await readStrictLoginInstallation(caller)
  return installation.installation
}

export function probeProductionRealtimeInstallation(): Promise<RealtimeInstallationFacts> {
  return probeRealtimeInstallation({
    withReadOnlySnapshot,
    readStrictInstallation,
    readEnablement: enablementRecordNotDefinedInThisBuild,
  })
}

export const bindProductionCredential: CredentialBinder = (token) =>
  bindVerifiedSessionClaims(authService.readTokenPayload(token), classifyVerifiedSessionPayload)

/**
 * The dedicated listening session of this process: one PostgreSQL session outside the business
 * pool, opened with the connection settings of that pool so both are attached to the same database.
 * Nothing is opened until the protection runtime starts the listener.
 */
export function createProductionInvalidationListener(
  diagnostics: RealtimeDiagnostics = realtimeDiagnostics,
  options: { applicationNameSuffix?: string } = {},
): PgInvalidationListener {
  const pool = poolManager.get().getInternalPool()
  const suffix = options.applicationNameSuffix ?? '-realtime-listener'
  return new PgInvalidationListener({
    createClient: () => {
      const options = pool.options as unknown as Record<string, unknown>
      const applicationName = typeof options.application_name === 'string' ? options.application_name : 'metasheet-backend'
      return new Client({
        ...options,
        application_name: `${applicationName}${suffix}`,
        keepAlive: true,
      }) as unknown as ListenerClient
    },
    readPoolIdentity: () => readDatabaseIdentity(async (sql) => pool.query(sql)),
    onPoolConnection: (handler) => {
      const onConnect = (client: { query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }> }): void => {
        handler(async (sql) => client.query(sql))
      }
      pool.on('connect', onConnect as never)
      return () => {
        pool.off('connect', onConnect as never)
      }
    },
    diagnostics,
  })
}

export interface ProductionRealtimeProtection {
  protection: RealtimeProtectionRuntime
  connections: ProtectedConnections
}

export interface ProductionRealtimeProtectionOptions {
  listener?: InvalidationListenerPort
  diagnostics?: RealtimeDiagnostics
  /** Source of the local switches; the process environment by default. */
  env?: () => NodeJS.ProcessEnv
  listenerApplicationNameSuffix?: string
  sweepIntervalMs?: number
  reprobeIntervalMs?: number
}

export function createProductionRealtimeProtection(
  options: ProductionRealtimeProtectionOptions = {},
): ProductionRealtimeProtection {
  const diagnostics = options.diagnostics ?? realtimeDiagnostics
  const protection = createRealtimeProtection({
    env: options.env,
    reprobeIntervalMs: options.reprobeIntervalMs,
    revalidationFlag: REALTIME_REVALIDATION_FLAG,
    credentialChainFlag: CREDENTIAL_REVOCATION_FLAG,
    probe: probeProductionRealtimeInstallation,
    authority: createRealtimeAuthorityReader({ query: authorityQuery, verifyStrict: verifyStrictSession }),
    bindCredential: bindProductionCredential,
    listener: options.listener
      ?? createProductionInvalidationListener(diagnostics, { applicationNameSuffix: options.listenerApplicationNameSuffix }),
    diagnostics,
  })
  const connections = new ProtectedConnections({ protection, diagnostics, sweepIntervalMs: options.sweepIntervalMs })
  return { protection, connections }
}
