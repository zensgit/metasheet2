/**
 * Harness for realtime protection tests: a real HTTP server, a real Socket.IO server and real
 * socket.io clients, with the committed facts held in memory so a test can change them between two
 * messages. Nothing here opens a database connection.
 */
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client'
import type { ListenerState } from '../../src/realtime-authz/admission'
import type { AuthorityVerdict, RealtimeAuthorityReader } from '../../src/realtime-authz/authority-read'
import { createRealtimeDiagnostics, type RealtimeDiagnostics } from '../../src/realtime-authz/diagnostics'
import type { RealtimeInstallationFacts } from '../../src/realtime-authz/installation-probe'
import {
  createRealtimeProtection,
  type InvalidationListenerPort,
  type InvalidationScope,
  type RealtimeProtectionRuntime,
} from '../../src/realtime-authz/protection'
import { ProtectedConnections } from '../../src/realtime-authz/protected-connections'
import { bindVerifiedSessionClaims, bindingKey, type RealtimeSessionBinding } from '../../src/realtime-authz/session-binding'

export const REVALIDATION = 'EXTERNAL_LOGIN_REALTIME_REVALIDATION_ENABLED'
export const CREDENTIAL_CHAIN = 'DIRECTORY_DEPROVISION_REVOKE_CREDENTIALS_ENABLED'

export interface FakeFacts {
  /** Users whose sessions are no longer current. */
  revokedUsers: Set<string>
  /** Users whose session facts cannot be read right now; the others answer. */
  unreadableUsers: Set<string>
  /** When true every authority read fails. */
  authorityDown: boolean
  /** Installation facts the probe answers; a function may throw to simulate a failed probe. */
  installation: RealtimeInstallationFacts
  env: Record<string, string | undefined>
}

export class FakeListener implements InvalidationListenerPort {
  private current: ListenerState = 'not-started'
  private readonly stateHandlers: Array<(state: ListenerState) => void> = []
  private readonly noticeHandlers: Array<(scope: InvalidationScope) => void> = []
  starts = 0
  /** State the listener reaches when it is started. */
  stateOnStart: ListenerState = 'ready'

  state(): ListenerState { return this.current }
  async start(): Promise<void> { this.starts += 1; this.set(this.stateOnStart) }
  async stop(): Promise<void> { this.current = 'not-started' }
  onStateChange(handler: (state: ListenerState) => void): void { this.stateHandlers.push(handler) }
  onNotice(handler: (scope: InvalidationScope) => void): void { this.noticeHandlers.push(handler) }
  set(state: ListenerState): void {
    this.current = state
    for (const handler of this.stateHandlers) handler(state)
  }
  notify(scope: InvalidationScope): void {
    for (const handler of this.noticeHandlers) handler(scope)
  }
}

/** `token:<userId>` is an ordinary session; `strict:<userId>:<expSeconds>` a strict one; anything else does not verify. */
export function bindFakeCredential(token: string): RealtimeSessionBinding | null {
  const classify = (payload: unknown) => ((payload as { xa?: unknown }).xa === true ? 'strict' : 'standard') as 'strict' | 'standard'
  if (token.startsWith('token:')) {
    const userId = token.slice('token:'.length).trim()
    return userId ? bindVerifiedSessionClaims({ userId, iat: 1000, exp: 9_999_999_999 }, classify) : null
  }
  if (token.startsWith('strict:')) {
    const [, userId, exp] = token.split(':')
    return bindVerifiedSessionClaims({ userId, iat: 1000, exp: Number(exp), sid: `xs.${userId}`, xa: true, tenantId: 'org-1' }, classify)
  }
  return null
}

export interface ProtectionHarness {
  facts: FakeFacts
  listener: FakeListener
  diagnostics: RealtimeDiagnostics
  protection: RealtimeProtectionRuntime
  connections: ProtectedConnections
  /** Every batch handed to the authority reader, in order. */
  authorityReads: string[][]
  probes: { count: number }
  /** When set, the next authority read waits for this promise before answering. */
  holdAuthority: { until: Promise<void> | null }
}

export function createProtectionHarness(options: {
  env?: Record<string, string | undefined>
  installation?: RealtimeInstallationFacts
  sweepIntervalMs?: number
} = {}): ProtectionHarness {
  const facts: FakeFacts = {
    revokedUsers: new Set(),
    unreadableUsers: new Set(),
    authorityDown: false,
    installation: options.installation ?? {
      strictScope: { state: 'never-installed' },
      enablement: { state: 'never-installed', definedInThisBuild: false },
    },
    env: { ...(options.env ?? {}) },
  }
  const listener = new FakeListener()
  const diagnostics = createRealtimeDiagnostics()
  const authorityReads: string[][] = []
  const probes = { count: 0 }
  const holdAuthority: { until: Promise<void> | null } = { until: null }
  const authority: RealtimeAuthorityReader = {
    async read(bindings) {
      authorityReads.push(bindings.map((binding) => binding.userId))
      const hold = holdAuthority.until
      if (hold) {
        holdAuthority.until = null
        await hold
      }
      const verdicts = new Map<string, AuthorityVerdict>()
      for (const binding of bindings) {
        if (facts.authorityDown || facts.unreadableUsers.has(binding.userId)) verdicts.set(bindingKey(binding), { state: 'unknown', reason: 'authority-read-failed' })
        else if (facts.revokedUsers.has(binding.userId)) verdicts.set(bindingKey(binding), { state: 'denied', reason: 'watermark-applies' })
        else verdicts.set(bindingKey(binding), { state: 'allowed' })
      }
      return verdicts
    },
  }
  const protection = createRealtimeProtection({
    env: () => facts.env as NodeJS.ProcessEnv,
    revalidationFlag: REVALIDATION,
    credentialChainFlag: CREDENTIAL_CHAIN,
    probe: async () => {
      probes.count += 1
      return facts.installation
    },
    authority,
    bindCredential: bindFakeCredential,
    listener,
    diagnostics,
    reprobeIntervalMs: 3_600_000,
    undeterminedRetryMinMs: 20,
    undeterminedRetryMaxMs: 40,
  })
  const connections = new ProtectedConnections({ protection, diagnostics, sweepIntervalMs: options.sweepIntervalMs ?? 3_600_000 })
  return { facts, listener, diagnostics, protection, connections, authorityReads, probes, holdAuthority }
}

export async function listen(): Promise<{ httpServer: HttpServer; url: string }> {
  const httpServer = createServer()
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const { port } = httpServer.address() as AddressInfo
  return { httpServer, url: `http://127.0.0.1:${port}` }
}

export function connectClient(url: string, token?: string, options: Record<string, unknown> = {}): ClientSocket {
  return ioClient(url, {
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    ...(token === undefined ? {} : { auth: { token } }),
    ...options,
  })
}

export function once<T = unknown>(client: ClientSocket, event: string, timeoutMs = 2000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs)
    client.once(event, (payload: T) => {
      clearTimeout(timer)
      resolve(payload)
    })
  })
}

/** Collects every payload of `event`; `received` is live. */
export function collect<T = unknown>(client: ClientSocket, event: string): T[] {
  const received: T[] = []
  client.on(event, (payload: T) => { received.push(payload) })
  return received
}

export function settle(ms = 80): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 2000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}
