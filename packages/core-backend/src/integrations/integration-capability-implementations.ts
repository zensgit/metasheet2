/**
 * Static table of which (provider, capability) pairs have a registered implementation behind the
 * capability gate. DingTalk notification delivery is registered by the notification composition root.
 *
 * Pure module: data only, no I/O, not replaceable at runtime.
 */
import { INTEGRATION_CAPABILITIES, type IntegrationCapability } from './provider-capability-registry'

type ImplementationTable = Readonly<Record<string, Readonly<Record<IntegrationCapability, boolean>>>>

const IMPLEMENTATIONS: ImplementationTable = Object.freeze({
  dingtalk: Object.freeze({ directory: false, login: false, notification: true }),
})

export function isCapabilityImplementationAvailable(provider: string, capability: IntegrationCapability): boolean {
  if (!(INTEGRATION_CAPABILITIES as readonly string[]).includes(capability)) return false
  if (!Object.hasOwn(IMPLEMENTATIONS, provider)) return false
  return IMPLEMENTATIONS[provider][capability] === true
}
