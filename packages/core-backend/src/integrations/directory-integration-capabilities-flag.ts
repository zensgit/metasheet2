/**
 * Switch for the directory integration capability surface (the read route, the write route and the
 * capability services behind them).
 *
 * DEFAULT OFF, exact literal 'true' only: no trim, no case folding ('1', 'TRUE', ' true' stay OFF).
 * This is the byte-exact family of the flag manifest (scripts/ops/global-history-flag-manifest.mjs).
 *
 * What OFF means: both routes answer 404 after authentication, and the services issue no statement.
 * What ON means: the capability tables are read (after a non-throwing existence probe) and an
 * administrator may change the stored state through the write route; a capability can be turned on
 * only where the provider registry governs it as gated. The switch governs this surface only and is
 * not an authorization input.
 *
 * Read per call with the env passed in. Deliberately NO import of anything (pure module).
 */
export const DIRECTORY_INTEGRATION_CAPABILITIES_ENABLED = 'DIRECTORY_INTEGRATION_CAPABILITIES_ENABLED' as const

export function isDirectoryIntegrationCapabilitiesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DIRECTORY_INTEGRATION_CAPABILITIES_ENABLED === 'true'
}
