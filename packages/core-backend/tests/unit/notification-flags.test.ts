import { describe, expect, it } from 'vitest'
import {
  USER_NOTIFICATION_PREFERENCES_ENABLED,
  EXTERNAL_NOTIFICATION_DELIVERY_ENABLED,
  isExternalNotificationDeliveryEnabled,
  isUserNotificationPreferencesEnabled,
} from '../../src/notifications/notification-flags'

describe('user notification preferences switch', () => {
  it('names the environment variable', () => {
    expect(USER_NOTIFICATION_PREFERENCES_ENABLED).toBe('USER_NOTIFICATION_PREFERENCES_ENABLED')
  })

  it('is on only for the exact literal true', () => {
    expect(isUserNotificationPreferencesEnabled({ USER_NOTIFICATION_PREFERENCES_ENABLED: 'true' })).toBe(true)
    for (const value of [undefined, '', 'false', 'TRUE', 'True', ' true ', 'true ', ' true', '1', 'yes', 'on']) {
      expect(isUserNotificationPreferencesEnabled({ USER_NOTIFICATION_PREFERENCES_ENABLED: value }), String(value)).toBe(false)
    }
  })

  it('reads the environment on every call', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(isUserNotificationPreferencesEnabled(env)).toBe(false)
    env.USER_NOTIFICATION_PREFERENCES_ENABLED = 'true'
    expect(isUserNotificationPreferencesEnabled(env)).toBe(true)
    env.USER_NOTIFICATION_PREFERENCES_ENABLED = 'false'
    expect(isUserNotificationPreferencesEnabled(env)).toBe(false)
  })

  it('defaults to the process environment, which has the switch off', () => {
    const saved = process.env.USER_NOTIFICATION_PREFERENCES_ENABLED
    try {
      delete process.env.USER_NOTIFICATION_PREFERENCES_ENABLED
      expect(isUserNotificationPreferencesEnabled()).toBe(false)
      process.env.USER_NOTIFICATION_PREFERENCES_ENABLED = 'true'
      expect(isUserNotificationPreferencesEnabled()).toBe(true)
    } finally {
      if (saved === undefined) delete process.env.USER_NOTIFICATION_PREFERENCES_ENABLED
      else process.env.USER_NOTIFICATION_PREFERENCES_ENABLED = saved
    }
  })
})

describe('external notification delivery switch', () => {
  it('uses only the exact literal true and defaults off', () => {
    expect(EXTERNAL_NOTIFICATION_DELIVERY_ENABLED).toBe('EXTERNAL_NOTIFICATION_DELIVERY_ENABLED')
    for (const value of [undefined, '', 'false', 'TRUE', 'True', ' true ', 'true ', ' true', '1', 'yes', 'on']) {
      expect(isExternalNotificationDeliveryEnabled({ EXTERNAL_NOTIFICATION_DELIVERY_ENABLED: value })).toBe(false)
    }
    expect(isExternalNotificationDeliveryEnabled({ EXTERNAL_NOTIFICATION_DELIVERY_ENABLED: 'true' })).toBe(true)
  })

  it('reads the environment on every call', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(isExternalNotificationDeliveryEnabled(env)).toBe(false)
    env.EXTERNAL_NOTIFICATION_DELIVERY_ENABLED = 'true'
    expect(isExternalNotificationDeliveryEnabled(env)).toBe(true)
    env.EXTERNAL_NOTIFICATION_DELIVERY_ENABLED = 'false'
    expect(isExternalNotificationDeliveryEnabled(env)).toBe(false)
  })
})
