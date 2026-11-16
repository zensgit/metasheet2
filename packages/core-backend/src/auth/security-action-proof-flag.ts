/**
 * Default OFF. Only the exact string 'true' enables the action proof route and service.
 *
 * No trimming and no case folding, so 'TRUE', '1', ' true' and 'true ' all stay OFF. The route
 * factory and every service entry point read this one predicate.
 */
export function isSecurityActionProofEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SECURITY_ACTION_PROOF_ENABLED === 'true'
}
