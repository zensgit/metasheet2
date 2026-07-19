/**
 * FWB runtime activation gate — dedicated, default OFF.
 *
 * FWB-0 / approval-line contracts: FWB must not run until fully implemented + owner enablement.
 * This flag is independent of AUTOMATION_DURABLE_DELIVERY_ENABLED / CLASSA / CLASSB; defaults stay OFF.
 *
 * Execution additionally requires durable delivery ON so claim+record+revision+outbox can share one
 * transaction (D9/D10). Legacy post-commit emit is never a FWB delivery path.
 *
 * Staging nuance: a DISABLED rule/draft may be saved while flags are OFF so operators can author
 * FWB configs before production enablement. Enabling (enabled=true) and runtime execution require
 * both flags ON (fail-closed).
 */
export const FWB_RUNTIME_ENV = 'APPROVAL_FWB_RUNTIME_ENABLED'

/** Master gate for FWB writeback runtime. Default OFF. Only the exact string `true` enables. */
export function isFwbRuntimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env[FWB_RUNTIME_ENV] ?? '').trim().toLowerCase() === 'true'
}

/**
 * Save-time activation policy for rules that carry write_approval_form_values.
 * - enabled=false → allow staging (no production-flag requirement)
 * - enabled=true  → both FWB + durable must be ON (same gate as execution)
 *
 * Returns an error string or null. Callers throw / fail-closed on a non-null result.
 */
export function requireFwbActivationForEnabledRule(
  enabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!enabled) return null
  // Lazy import avoided — keep flags module free of durable dependency cycle by inlining the check shape.
  // Durable check is re-exported via approval-fwb-runtime.assertFwbRuntimeActivatable for the full gate.
  const fwbOn = isFwbRuntimeEnabled(env)
  const durableOn = String(env.AUTOMATION_DURABLE_DELIVERY_ENABLED ?? '').trim().toLowerCase() === 'true'
  if (!fwbOn) {
    return 'write_approval_form_values is disabled (APPROVAL_FWB_RUNTIME_ENABLED is not true)'
  }
  if (!durableOn) {
    return 'write_approval_form_values requires AUTOMATION_DURABLE_DELIVERY_ENABLED=true (D9 same-transaction outbox)'
  }
  return null
}
