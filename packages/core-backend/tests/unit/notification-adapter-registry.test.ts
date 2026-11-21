import { afterEach, describe, expect, it } from 'vitest'
import {
  __notificationAdapterRegistryForTests,
  NotificationAdapterRegistrationError,
  NotificationProviderAdapterUnavailableError,
  registerNotificationAdapter,
  resolveNotificationAdapter,
  type NotificationAdapter,
} from '../../src/notifications/adapters/notification-adapter'

function fake(provider: string): NotificationAdapter {
  return {
    provider, transport: 'test',
    prepare: async () => ({ ok: false, retryable: false, skip: true, code: 'routed_simulated' }),
    fingerprint: async () => ({ ok: true, value: 'fixture' }),
  }
}

afterEach(() => __notificationAdapterRegistryForTests.restore())

describe('notification adapter registry', () => {
  it('ignores repeated registration of the identical object', () => {
    __notificationAdapterRegistryForTests.replace(new Map())
    const adapter = fake('dingtalk')
    registerNotificationAdapter(adapter)
    registerNotificationAdapter(adapter)
    expect(resolveNotificationAdapter('dingtalk')).toBe(adapter)
  })

  it('rejects a different object for the same provider without replacing the original', () => {
    __notificationAdapterRegistryForTests.replace(new Map())
    const adapter = fake('dingtalk')
    registerNotificationAdapter(adapter)
    expect(() => registerNotificationAdapter(fake('dingtalk'))).toThrow(NotificationAdapterRegistrationError)
    expect(resolveNotificationAdapter('dingtalk')).toBe(adapter)
  })

  it.each(['local', 'missing'])('fails closed for an unregistered %s provider', (provider) => {
    __notificationAdapterRegistryForTests.replace(new Map())
    expect(() => resolveNotificationAdapter(provider)).toThrow(NotificationProviderAdapterUnavailableError)
    try { resolveNotificationAdapter(provider) } catch (error) {
      expect(error).toMatchObject({ code: 'NOTIFICATION_PROVIDER_ADAPTER_UNAVAILABLE' })
      expect((error as Error).message).toBe(`Notification provider adapter is not registered: ${provider}`)
    }
  })

  it('never registers local, including a test-registry injection', () => {
    __notificationAdapterRegistryForTests.replace(new Map([['local', fake('local')]]))
    expect(() => registerNotificationAdapter(fake('local'))).toThrow(NotificationAdapterRegistrationError)
    expect(() => resolveNotificationAdapter('local')).toThrow(NotificationProviderAdapterUnavailableError)
  })

  it('restores the production registry without retaining injected implementations', () => {
    __notificationAdapterRegistryForTests.replace(new Map([['test-provider', fake('test-provider')]]))
    expect(resolveNotificationAdapter('test-provider').provider).toBe('test-provider')
    __notificationAdapterRegistryForTests.restore()
    expect(() => resolveNotificationAdapter('test-provider')).toThrow(NotificationProviderAdapterUnavailableError)
  })
})
