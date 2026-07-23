/**
 * T1 — user activation axis helpers (design lock Rev 4.2).
 *
 * Dual axis:
 * - activation_status: pending_activation | activated
 * - is_active: platform availability (security / offboarding)
 *
 * Pending-create runtime is env-gated and **defaults OFF** so shipping T1 does not
 * change production admission behavior until an explicit later GO enables the flag.
 */

import * as crypto from 'node:crypto'
import * as bcrypt from 'bcryptjs'
import { getBcryptSaltRounds } from '../security/auth-runtime-config'

export const USER_ACTIVATION_STATUSES = ['pending_activation', 'activated'] as const
export type UserActivationStatus = (typeof USER_ACTIVATION_STATUSES)[number]

export const ACCOUNT_PENDING_ACTIVATION_CODE = 'ACCOUNT_PENDING_ACTIVATION'
export const ACCOUNT_INACTIVE_CODE = 'ACCOUNT_INACTIVE'
export const ACCOUNT_PASSWORD_LOGIN_DISABLED_CODE = 'ACCOUNT_PASSWORD_LOGIN_DISABLED'
export const PENDING_ACTIVATE_BYPASS_FORBIDDEN_CODE = 'PENDING_ACTIVATE_BYPASS_FORBIDDEN'

/**
 * When true, directory auto/manual admission creates pending_activation users
 * (is_active=false, no active user_orgs, grant off, unusable password).
 * Default false — existing admit path stays activated + active membership.
 */
export function isDirectoryPendingActivationEnabled(): boolean {
  return ['true', '1', 'yes'].includes(
    String(process.env.DIRECTORY_PENDING_ACTIVATION_ENABLED ?? '').trim().toLowerCase(),
  )
}

export function normalizeUserActivationStatus(raw: unknown): UserActivationStatus {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if (value === 'pending_activation') return 'pending_activation'
  // Missing column / legacy rows / anything else → activated (fail open for stock logins)
  return 'activated'
}

export function isUserPendingActivation(raw: unknown): boolean {
  return normalizeUserActivationStatus(raw) === 'pending_activation'
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
 * Shared gate for password login, token refresh, and DingTalk SSO login.
 * Does not evaluate grants (caller-specific).
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
  if (isUserPendingActivation(user.activation_status)) {
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
