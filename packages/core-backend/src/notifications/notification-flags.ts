/**
 * Switch for the user-facing notification preference surface: `/api/me/notification-*` and the reads
 * and writes of the endpoint and preference tables.
 *
 * DEFAULT OFF, exact literal 'true' only: no trim, no case folding ('1', 'TRUE', ' true' stay OFF).
 * This is the byte-exact family of the flag manifest (scripts/ops/global-history-flag-manifest.mjs).
 *
 * What OFF means: every route answers 404 after authentication, and the tables are not queried.
 *
 * Read per call with the env passed in. Deliberately NO import of anything (pure module).
 */
export const USER_NOTIFICATION_PREFERENCES_ENABLED = 'USER_NOTIFICATION_PREFERENCES_ENABLED' as const

export function isUserNotificationPreferencesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.USER_NOTIFICATION_PREFERENCES_ENABLED === 'true'
}
