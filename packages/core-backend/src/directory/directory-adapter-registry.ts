import type { DirectoryAdapter } from './directory-adapter'

/** Raised when an integration names a provider that has no registered adapter. */
export class DirectoryProviderAdapterUnavailableError extends Error {
  readonly code = 'DIRECTORY_PROVIDER_ADAPTER_UNAVAILABLE'

  constructor(provider: string) {
    super(`Directory provider adapter is not registered: ${provider}`)
    this.name = 'DirectoryProviderAdapterUnavailableError'
  }
}

/** Raised when two different adapter objects claim the same provider. */
export class DirectoryAdapterRegistrationError extends Error {
  readonly code = 'DIRECTORY_ADAPTER_REGISTRATION_CONFLICT'

  constructor(provider: string) {
    super(`Directory provider adapter is already registered with a different implementation: ${provider}`)
    this.name = 'DirectoryAdapterRegistrationError'
  }
}

const defaultAdapters = new Map<string, DirectoryAdapter<unknown>>()
let adapters: Map<string, DirectoryAdapter<unknown>> = defaultAdapters

/** Registers an adapter; registering the same object again is a no-op, a different object under the same provider throws. */
export function registerDirectoryAdapter<TConfig>(adapter: DirectoryAdapter<TConfig>): void {
  const existing = adapters.get(adapter.provider)
  if (existing === adapter) return
  if (existing) throw new DirectoryAdapterRegistrationError(adapter.provider)
  adapters.set(adapter.provider, adapter)
}

/** Returns the adapter registered for `provider`; an unregistered provider throws. */
export function resolveDirectoryAdapter(provider: string): DirectoryAdapter<unknown> {
  const adapter = adapters.get(provider)
  if (!adapter) throw new DirectoryProviderAdapterUnavailableError(provider)
  return adapter
}

/** Test seam: swaps the registry contents and restores the production registrations. */
export const __directoryAdapterRegistryForTests = {
  replace(map: Map<string, DirectoryAdapter<unknown>>): void {
    adapters = map
  },
  restore(): void {
    adapters = defaultAdapters
  },
}
