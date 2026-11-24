/**
 * Switch for continuous authorization of established realtime connections (default collaboration
 * channel and the /yjs namespace).
 *
 * DEFAULT OFF, exact literal 'true' only: no trim, no case folding ('1', 'TRUE', ' true' stay OFF).
 * This is the byte-exact family of the flag manifest (scripts/ops/global-history-flag-manifest.mjs).
 *
 * What OFF means, when the database carries no committed login scope and no enablement record: the
 * ordinary collaboration handshake, messages and disconnects behave as before, no extra statement is
 * issued on those paths and no dedicated listening connection is opened.
 * What ON means: every protected receive and delivery is re-checked against the committed session,
 * watermark and membership facts of the bound session; a connection whose session is no longer
 * current is closed and a new handshake with the same credential is refused.
 *
 * The switch is not an authorization input and never restores a revoked session.
 * Read per call with the env passed in. Deliberately NO import of anything (pure module).
 */
export const REALTIME_REVALIDATION_FLAG = 'EXTERNAL_LOGIN_REALTIME_REVALIDATION_ENABLED' as const

export function isRealtimeRevalidationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EXTERNAL_LOGIN_REALTIME_REVALIDATION_ENABLED === 'true'
}

/**
 * 'near-true' is a value an operator most likely meant as ON but that the exact comparison keeps OFF.
 * It never activates anything; it only lets the administrator diagnostics report the mismatch.
 */
export type ExactSwitchReading = 'on' | 'off' | 'near-true'

const NEAR_TRUE_VALUES: ReadonlySet<string> = new Set(['true', '1', 'yes', 'on'])

export function readExactSwitch(raw: string | undefined | null): ExactSwitchReading {
  if (raw === 'true') return 'on'
  if (typeof raw === 'string' && NEAR_TRUE_VALUES.has(raw.trim().toLowerCase())) return 'near-true'
  return 'off'
}
