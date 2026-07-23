import { afterEach, describe, expect, it } from 'vitest'
import {
  ACCOUNT_ACTIVATION_INVALID_CODE,
  ACCOUNT_INACTIVE_CODE,
  ACCOUNT_PASSWORD_LOGIN_DISABLED_CODE,
  ACCOUNT_PENDING_ACTIVATION_CODE,
  assertPendingUserCannotBeActivatedViaGenericStatusApi,
  evaluateUserAuthenticationGate,
  isDirectoryPendingActivationEnabled,
  isUserPendingActivation,
  parseUserActivationStatus,
  PENDING_ACTIVATE_BYPASS_FORBIDDEN_CODE,
} from '../../src/auth/user-activation'

describe('user-activation helpers (T1)', () => {
  const originalEnv = process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED
    else process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED = originalEnv
  })

  it('defaults pending-activation runtime OFF', () => {
    delete process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED
    expect(isDirectoryPendingActivationEnabled()).toBe(false)
  })

  it('enables only on explicit true/1/yes', () => {
    process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED = 'true'
    expect(isDirectoryPendingActivationEnabled()).toBe(true)
    process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED = 'no'
    expect(isDirectoryPendingActivationEnabled()).toBe(false)
  })

  it('parses activation_status with fail-closed unknown values', () => {
    expect(parseUserActivationStatus(null)).toEqual({ ok: true, status: 'activated' })
    expect(parseUserActivationStatus('')).toEqual({ ok: true, status: 'activated' })
    expect(parseUserActivationStatus('pending_activation')).toEqual({
      ok: true,
      status: 'pending_activation',
    })
    expect(parseUserActivationStatus('activated')).toEqual({ ok: true, status: 'activated' })
    expect(parseUserActivationStatus('weird')).toEqual({ ok: false, status: 'invalid' })
    expect(parseUserActivationStatus(42)).toEqual({ ok: false, status: 'invalid' })
  })

  it('gates pending, invalid activation, inactive, and password-less accounts', () => {
    expect(
      evaluateUserAuthenticationGate({
        is_active: true,
        activation_status: 'pending_activation',
      })?.code,
    ).toBe(ACCOUNT_PENDING_ACTIVATION_CODE)

    expect(
      evaluateUserAuthenticationGate({
        is_active: true,
        activation_status: 'corrupted',
      })?.code,
    ).toBe(ACCOUNT_ACTIVATION_INVALID_CODE)

    expect(
      evaluateUserAuthenticationGate({
        is_active: false,
        activation_status: 'activated',
      })?.code,
    ).toBe(ACCOUNT_INACTIVE_CODE)

    expect(
      evaluateUserAuthenticationGate(
        {
          is_active: true,
          activation_status: 'activated',
          local_password_set: false,
        },
        { requireLocalPassword: true },
      )?.code,
    ).toBe(ACCOUNT_PASSWORD_LOGIN_DISABLED_CODE)

    expect(
      evaluateUserAuthenticationGate({
        is_active: true,
        activation_status: 'activated',
        local_password_set: true,
      }),
    ).toBeNull()
  })

  it('refuses generic status API lighting pending users', () => {
    expect(() =>
      assertPendingUserCannotBeActivatedViaGenericStatusApi('pending_activation', true),
    ).toThrow(/directory activate/i)

    try {
      assertPendingUserCannotBeActivatedViaGenericStatusApi('pending_activation', true)
    } catch (error) {
      expect((error as { code?: string }).code).toBe(PENDING_ACTIVATE_BYPASS_FORBIDDEN_CODE)
    }

    expect(() =>
      assertPendingUserCannotBeActivatedViaGenericStatusApi('pending_activation', false),
    ).not.toThrow()
    expect(() =>
      assertPendingUserCannotBeActivatedViaGenericStatusApi('activated', true),
    ).not.toThrow()
  })

  it('detects pending activation', () => {
    expect(isUserPendingActivation('pending_activation')).toBe(true)
    expect(isUserPendingActivation('activated')).toBe(false)
    expect(isUserPendingActivation('weird')).toBe(false)
  })
})
