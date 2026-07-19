/**
 * FWB runtime activation gate — dedicated, default OFF.
 *
 * FWB-0 / approval-line contracts: FWB must not run until fully implemented + owner enablement.
 * This flag is independent of AUTOMATION_DURABLE_DELIVERY_ENABLED / CLASSA / CLASSB; defaults stay OFF.
 *
 * Execution additionally requires durable delivery ON so claim+record+revision+outbox can share one
 * transaction (D9/D10). Legacy post-commit emit is never a FWB delivery path.
 */
export const FWB_RUNTIME_ENV = 'APPROVAL_FWB_RUNTIME_ENABLED'

/** Master gate for FWB writeback runtime. Default OFF. Only the exact string `true` enables. */
export function isFwbRuntimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env[FWB_RUNTIME_ENV] ?? '').trim().toLowerCase() === 'true'
}
