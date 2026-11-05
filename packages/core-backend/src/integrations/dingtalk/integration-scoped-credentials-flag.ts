/**
 * Switch for DingTalk work-notification credential resolution anchored to the recipient's
 * directory integration (work-notification-settings.ts readDingTalkMessageConfigFromRuntime).
 *
 * DEFAULT OFF, exact literal 'true' only: no trim, no case folding ('1', 'TRUE', ' true' stay OFF).
 * This is the byte-exact family of the flag manifest (scripts/ops/global-history-flag-manifest.mjs),
 * not the trim+lowercase family some older DingTalk switches use.
 *
 * What OFF means (load-bearing): the resolver keeps its pre-switch code path byte for byte — a complete
 * env triple is used without reading the integration row, otherwise each field is env-then-stored.
 * What ON means: for a call that names an integration, the row is always read, must be active, and the
 * credentials come from one source only unless the env app key is the same app as the row (see the
 * resolver); an env Agent ID that would be sent must be 1-32 digits. The automation executor also reads
 * this switch: no approval card for an assignee whose integration is missing or not active, approval-card
 * public URL per assignee integration, card credentials resolved before the outbound claim, person-message
 * groups all resolved before the first send.
 *
 * Read per call with the env passed in, so a gate site or a test never has to mutate process.env at
 * module load. Deliberately NO import of anything (pure module).
 */
export const DINGTALK_INTEGRATION_SCOPED_CREDENTIALS_ENABLED = 'DINGTALK_INTEGRATION_SCOPED_CREDENTIALS_ENABLED' as const

export function isDingTalkIntegrationScopedCredentialsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DINGTALK_INTEGRATION_SCOPED_CREDENTIALS_ENABLED === 'true'
}
