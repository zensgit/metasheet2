/**
 * Notification authority for persisted background events. eventOrgId must come from the event row,
 * never from a request, a constant, or the integration being resolved. The consumer also checks the
 * returned organization against its event. This function cannot establish a string's provenance.
 *
 * Pass the caller's READ COMMITTED transaction after setting bounded lock and statement timeouts.
 * The shared core issues exactly six statements; it creates no connection and changes no settings.
 * Finish the short transaction before external I/O, and roll back on read_failed.
 */
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { resolveCapabilityCore, type CoreCapabilityDecision } from './integration-capability-resolve-core'

export type BackgroundNotificationCapabilityDecision = CoreCapabilityDecision<'background_event_row', 'notification'>

/** Exact two-key input, fixed capability and source, and no thrown failures. */
export async function resolveEffectiveNotificationCapabilityForBackground(
  executor: Queryable,
  input: { integrationId: string; eventOrgId: string },
): Promise<BackgroundNotificationCapabilityDecision> {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return { effective: false, reason: 'input_invalid' }
    }
    const keys = Reflect.ownKeys(input)
    if (keys.length !== 2 || !keys.includes('integrationId') || !keys.includes('eventOrgId')) {
      return { effective: false, reason: 'input_invalid' }
    }
    return await resolveCapabilityCore(executor, {
      integrationId: input.integrationId,
      capability: 'notification',
      expectedOrgId: input.eventOrgId,
    }, 'background_event_row')
  } catch {
    return { effective: false, reason: 'read_failed' }
  }
}
