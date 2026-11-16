/**
 * Switch for the directory integration capability surface (the read route and the capability service).
 *
 * DEFAULT OFF, exact literal 'true' only: no trim, no case folding ('1', 'TRUE', ' true' stay OFF).
 * This is the byte-exact family of the flag manifest (scripts/ops/global-history-flag-manifest.mjs).
 *
 * What OFF means: the route answers 404 after authentication, and the service issues no statement.
 * What ON means: the capability tables are read (after a non-throwing existence probe); no other
 * consumer reads them. The switch governs this surface only and is not an authorization input.
 *
 * Read per call with the env passed in. Deliberately NO import of anything (pure module).
 */
export const DIRECTORY_INTEGRATION_CAPABILITIES_ENABLED = 'DIRECTORY_INTEGRATION_CAPABILITIES_ENABLED' as const

export function isDirectoryIntegrationCapabilitiesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DIRECTORY_INTEGRATION_CAPABILITIES_ENABLED === 'true'
}
