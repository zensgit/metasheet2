import type { ResolvedTarget, ResolveResult } from '../recipient-resolver'

export interface NotificationAdapter {
  readonly provider: string
  readonly transport: string
  prepare(context: AdapterPrepareContext): Promise<AdapterPrepared>
  fingerprint(connectionId: string): Promise<{ ok: true; value: string } | { ok: false; code: string; failureKind?: 'read_failed' }>
}

export interface AdapterPrepareContext {
  readonly connectionId: string
  readonly target: ResolvedTarget
  readonly reverify: () => Promise<ResolveResult>
  readonly budgetMs: number
  readonly dedupeHint: string
}

export type AdapterPrepared =
  | { ok: true; send(message: { title: string; content: string }): Promise<AdapterSendResult> }
  | { ok: false; retryable: boolean; skip?: boolean; code: string }

export type AdapterSendResult =
  | { ok: true }
  | { ok: false; retryable: boolean; outcomeUnknown?: boolean; code: string }

export class NotificationProviderAdapterUnavailableError extends Error {
  readonly code = 'NOTIFICATION_PROVIDER_ADAPTER_UNAVAILABLE'

  constructor(provider: string) {
    super(`Notification provider adapter is not registered: ${provider}`)
    this.name = 'NotificationProviderAdapterUnavailableError'
  }
}

export class NotificationAdapterRegistrationError extends Error {
  readonly code = 'NOTIFICATION_ADAPTER_REGISTRATION_CONFLICT'

  constructor(provider: string) {
    super(`Notification provider adapter cannot be registered: ${provider}`)
    this.name = 'NotificationAdapterRegistrationError'
  }
}

const defaultAdapters = new Map<string, NotificationAdapter>()
let adapters = defaultAdapters

export function registerNotificationAdapter(adapter: NotificationAdapter): void {
  if (adapter.provider === 'local') throw new NotificationAdapterRegistrationError(adapter.provider)
  const existing = adapters.get(adapter.provider)
  if (existing === adapter) return
  if (existing) throw new NotificationAdapterRegistrationError(adapter.provider)
  adapters.set(adapter.provider, adapter)
}

export function resolveNotificationAdapter(provider: string): NotificationAdapter {
  const adapter = provider === 'local' ? undefined : adapters.get(provider)
  if (!adapter) throw new NotificationProviderAdapterUnavailableError(provider)
  return adapter
}

/** Test-only registrations never alter the production registry. */
export const __notificationAdapterRegistryForTests = {
  replace(map: Map<string, NotificationAdapter>): void {
    adapters = map
  },
  restore(): void {
    adapters = defaultAdapters
  },
}
