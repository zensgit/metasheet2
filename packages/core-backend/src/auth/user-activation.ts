/**
 * T1 — user activation axis helpers (design lock Rev 4.2 + PR #4559 review fixes).
 *
 * Dual axis:
 * - activation_status: **exact** pending_activation | activated only (closed set)
 * - is_active: platform availability
 *
 * After migration, the column is NOT NULL + CHECK. Application code must not treat
 * null/undefined/'' as activated (fail-closed closed set).
 *
 * Pending-create runtime is env-gated and **defaults OFF**.
 */

import * as crypto from 'node:crypto'
import * as bcrypt from 'bcryptjs'
import { getBcryptSaltRounds } from '../security/auth-runtime-config'

export const USER_ACTIVATION_STATUSES = ['pending_activation', 'activated'] as const
export type UserActivationStatus = (typeof USER_ACTIVATION_STATUSES)[number]

export const ACCOUNT_PENDING_ACTIVATION_CODE = 'ACCOUNT_PENDING_ACTIVATION'
export const ACCOUNT_INACTIVE_CODE = 'ACCOUNT_INACTIVE'
export const ACCOUNT_PASSWORD_LOGIN_DISABLED_CODE = 'ACCOUNT_PASSWORD_LOGIN_DISABLED'
export const ACCOUNT_ACTIVATION_INVALID_CODE = 'ACCOUNT_ACTIVATION_INVALID'
export const PENDING_ACTIVATE_BYPASS_FORBIDDEN_CODE = 'PENDING_ACTIVATE_BYPASS_FORBIDDEN'

/**
 * When true, directory auto/manual admission creates pending_activation users.
 * Default false.
 */
export function isDirectoryPendingActivationEnabled(): boolean {
  return ['true', '1', 'yes'].includes(
    String(process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED ?? '').trim().toLowerCase(),
  )
}

/**
 * Closed-set parser: only the two exact strings are valid.
 * null/undefined/''/unknown → invalid (fail-closed).
 */
export function parseUserActivationStatus(
  raw: unknown,
): { ok: true; status: UserActivationStatus } | { ok: false; status: 'invalid' } {
  if (typeof raw !== 'string') {
    return { ok: false, status: 'invalid' }
  }
  const value = raw.trim()
  if (value === 'pending_activation') return { ok: true, status: 'pending_activation' }
  if (value === 'activated') return { ok: true, status: 'activated' }
  return { ok: false, status: 'invalid' }
}

export function isUserPendingActivation(raw: unknown): boolean {
  const parsed = parseUserActivationStatus(raw)
  return parsed.ok && parsed.status === 'pending_activation'
}

export type UserAuthGateInput = {
  is_active?: boolean | null
  role?: string | null
  activation_status?: string | null
  local_password_set?: boolean | null
}

export type UserAuthGateDenial = {
  code: string
  message: string
}

/**
 * Shared gate for password login, token refresh/verify, DingTalk SSO, API tokens.
 */
export function evaluateUserAuthenticationGate(
  user: UserAuthGateInput,
  options: { requireLocalPassword?: boolean } = {},
): UserAuthGateDenial | null {
  if (user.role === 'disabled' || user.is_active === false) {
    return {
      code: ACCOUNT_INACTIVE_CODE,
      message: 'Account is inactive or disabled',
    }
  }

  const parsed = parseUserActivationStatus(user.activation_status)
  if (!parsed.ok) {
    return {
      code: ACCOUNT_ACTIVATION_INVALID_CODE,
      message: 'Account activation status is invalid',
    }
  }
  if (parsed.status === 'pending_activation') {
    return {
      code: ACCOUNT_PENDING_ACTIVATION_CODE,
      message: 'Account is pending activation and cannot sign in',
    }
  }

  if (options.requireLocalPassword && user.local_password_set === false) {
    return {
      code: ACCOUNT_PASSWORD_LOGIN_DISABLED_CODE,
      message: 'Local password login is not enabled for this account',
    }
  }
  return null
}

/** Cryptographically random unusable password hash (password_hash stays NOT NULL). */
export async function buildUnusablePasswordHash(): Promise<string> {
  const secret = crypto.randomBytes(32).toString('base64url')
  return bcrypt.hash(secret, getBcryptSaltRounds())
}

export function assertPendingUserCannotBeActivatedViaGenericStatusApi(
  activationStatus: unknown,
  nextIsActive: boolean,
): void {
  if (nextIsActive && isUserPendingActivation(activationStatus)) {
    const error = new Error(
      'Cannot set is_active=true on a pending_activation user via generic status API; use directory activate',
    )
    ;(error as Error & { code?: string }).code = PENDING_ACTIVATE_BYPASS_FORBIDDEN_CODE
    throw error
  }
}
