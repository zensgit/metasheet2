/**
 * Legacy login-grant registry.
 *
 * `user_external_auth_grants` keys a login grant by `(provider, local_user_id)` and has no
 * connection dimension. The providers that own a reader of that table are listed here; every
 * other provider's login grants live only in the strict per-connection store.
 *
 * Invariants:
 * - the production registry is exactly `['dingtalk']`; a wider registry exists only as a test
 *   injection, never as a runtime setting;
 * - a `grant_changed` ledger effect whose `provider` is NULL is read as the default provider —
 *   this is the only place that mapping is written down, and the ledger's dedicated INSERT
 *   trigger enforces the same reading at the schema layer.
 */

export const DEFAULT_LEGACY_LOGIN_GRANT_PROVIDER = 'dingtalk'

export const LEGACY_LOGIN_GRANT_PROVIDERS: readonly string[] = Object.freeze([
  DEFAULT_LEGACY_LOGIN_GRANT_PROVIDER,
])

export function isLegacyLoginGrantProvider(
  provider: unknown,
  registry: readonly string[] = LEGACY_LOGIN_GRANT_PROVIDERS,
): boolean {
  return typeof provider === 'string' && registry.includes(provider)
}

/**
 * The provider a `grant_changed` effect row acts on. Input is a row read with
 * `to_jsonb(effect) ->> 'provider'` (so a ledger that predates the column still yields NULL
 * instead of an error). NULL / undefined are the default provider; a non-empty string is
 * returned as is; an empty or blank string is a malformed witness and is refused.
 */
export function effectGrantProvider(row: { provider?: unknown }): string {
  const raw = row?.provider
  if (raw === null || raw === undefined) return DEFAULT_LEGACY_LOGIN_GRANT_PROVIDER
  if (typeof raw !== 'string' || raw.trim() === '') {
    const error = new Error('deprovision effect provider witness is malformed')
    ;(error as Error & { code?: string }).code = 'DEPROVISION_EFFECT_PROVIDER_MALFORMED'
    throw error
  }
  return raw
}
