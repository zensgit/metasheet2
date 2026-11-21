/**
 * Authenticated capability entry point. expectedOrgId is the token-derived authenticated tenant;
 * pre-authentication and background consumers must use their separately approved entry points.
 * The shared core keeps the six-statement READ COMMITTED flow and integration-before-capability locks.
 * Callers bound lock_timeout, finish external work first, and promptly commit or roll back afterwards.
 * A SQL read failure aborts the transaction; every read_failed result requires caller rollback.
 */
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import type { IntegrationCapability } from './provider-capability-registry'
import {
  resolveCapabilityCore,
  CAPABILITY_RESOLVE_MAX_LOCK_TIMEOUT_MS,
  type CoreCapabilityDecision,
} from './integration-capability-resolve-core'

export { CAPABILITY_RESOLVE_MAX_LOCK_TIMEOUT_MS }
export {
  CAPABILITY_WITNESS_SHAPE,
  computeIntegrationCapabilityWitness,
  type CapabilityWitnessFields,
} from './integration-capability-witness'

export type CapabilityDecision = CoreCapabilityDecision<'authenticated_tenant'>

/** Never throws. Existing callers' additional input fields remain ignored. */
export async function resolveEffectiveIntegrationCapability(
  executor: Queryable,
  input: { integrationId: string; capability: IntegrationCapability; expectedOrgId: string },
): Promise<CapabilityDecision> {
  try {
    return await resolveCapabilityCore(executor, input, 'authenticated_tenant')
  } catch {
    return { effective: false, reason: 'read_failed' }
  }
}
