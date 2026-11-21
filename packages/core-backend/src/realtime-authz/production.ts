/**
 * Production wiring of realtime protection for one serving process.
 *
 * Everything here reads the authoritative database through the process pool with the strict readers
 * of this directory. The credential binder verifies signature and expiry only; whether the session
 * is current is always decided by the authority reader, never by claims of the credential and never
 * by a helper that answers permissively when a structure cannot be read.
 */
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

export interface ProductionRealtimeProtection {
  protection: RealtimeProtectionRuntime
  connections: ProtectedConnections
}

export function createProductionRealtimeProtection(
  options: { listener?: InvalidationListenerPort; diagnostics?: RealtimeDiagnostics } = {},
): ProductionRealtimeProtection {
  const diagnostics = options.diagnostics ?? realtimeDiagnostics
  const protection = createRealtimeProtection({
    revalidationFlag: REALTIME_REVALIDATION_FLAG,
    credentialChainFlag: CREDENTIAL_REVOCATION_FLAG,
    probe: probeProductionRealtimeInstallation,
    authority: createRealtimeAuthorityReader({ query: authorityQuery, verifyStrict: verifyStrictSession }),
    bindCredential: bindProductionCredential,
    listener: options.listener,
    diagnostics,
  })
  const connections = new ProtectedConnections({ protection, diagnostics })
  return { protection, connections }
}
