import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The adapter registry resolves a provider to exactly one adapter, refuses an unregistered
 * provider, ignores a repeated registration of the same object and rejects a different object
 * under a registered provider. Loading the directory sync module registers the DingTalk adapter.
 */
vi.mock('../../src/db/pg', () => ({ query: vi.fn(), transaction: vi.fn() }))

import {
  DirectoryAdapterRegistrationError,
  DirectoryProviderAdapterUnavailableError,
  __directoryAdapterRegistryForTests,
  registerDirectoryAdapter,
  resolveDirectoryAdapter,
} from '../../src/directory/directory-adapter-registry'
import type { DirectoryAdapter } from '../../src/directory/directory-adapter'
import { dingtalkDirectoryAdapter } from '../../src/directory/adapters/dingtalk-directory-adapter'
import '../../src/directory/directory-sync'

function fakeAdapter(provider: string): DirectoryAdapter<unknown> {
  return {
    provider,
    capabilities: {
      contactFields: { email: 'unavailable', mobile: 'unavailable' },
      memberOpenId: 'unavailable',
      memberUnionId: 'unavailable',
      managerIds: false,
      primaryDepartmentSignal: false,
      diagnostics: false,
    },
    fetchDepartments: async () => new Map(),
    fetchMembers: async () => new Map(),
    observeRetries: (_observer, fn) => fn(),
  }
}

describe('directory adapter registry', () => {
  afterEach(() => {
    __directoryAdapterRegistryForTests.restore()
  })

  it('has the DingTalk adapter registered once the directory sync module is loaded', () => {
    expect(resolveDirectoryAdapter('dingtalk')).toBe(dingtalkDirectoryAdapter)
    expect(resolveDirectoryAdapter('dingtalk').provider).toBe('dingtalk')
  })

  it('refuses a provider that has no adapter, with a typed error', () => {
    __directoryAdapterRegistryForTests.replace(new Map())
    expect(() => resolveDirectoryAdapter('dingtalk')).toThrow(DirectoryProviderAdapterUnavailableError)
    expect(() => resolveDirectoryAdapter('local')).toThrow(DirectoryProviderAdapterUnavailableError)
    try {
      resolveDirectoryAdapter('local')
    } catch (error) {
      expect((error as DirectoryProviderAdapterUnavailableError).code).toBe('DIRECTORY_PROVIDER_ADAPTER_UNAVAILABLE')
      expect((error as Error).message).toBe('Directory provider adapter is not registered: local')
    }
  })

  it('ignores registering the same adapter object again', () => {
    __directoryAdapterRegistryForTests.replace(new Map())
    const adapter = fakeAdapter('a0g-provider')
    registerDirectoryAdapter(adapter)
    expect(() => registerDirectoryAdapter(adapter)).not.toThrow()
    expect(resolveDirectoryAdapter('a0g-provider')).toBe(adapter)
  })

  it('rejects a different adapter object under a registered provider and keeps the first', () => {
    __directoryAdapterRegistryForTests.replace(new Map())
    const first = fakeAdapter('a0g-provider')
    registerDirectoryAdapter(first)
    expect(() => registerDirectoryAdapter(fakeAdapter('a0g-provider'))).toThrow(DirectoryAdapterRegistrationError)
    expect(resolveDirectoryAdapter('a0g-provider')).toBe(first)
  })

  it('restores the production registrations after a replacement', () => {
    __directoryAdapterRegistryForTests.replace(new Map())
    expect(() => resolveDirectoryAdapter('dingtalk')).toThrow(DirectoryProviderAdapterUnavailableError)
    __directoryAdapterRegistryForTests.restore()
    expect(resolveDirectoryAdapter('dingtalk')).toBe(dingtalkDirectoryAdapter)
  })
})
