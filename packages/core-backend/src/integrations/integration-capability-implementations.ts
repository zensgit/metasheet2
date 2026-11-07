/**
 * Static table of which (provider, capability) pairs have a registered implementation behind the
 * capability gate. Every entry is false: no capability-gated consumer exists. A change that adds one
 * changes this table together with the registry and the consumer.
 *
 * Pure module: data only, no I/O, not replaceable at runtime.
 */
import { INTEGRATION_CAPABILITIES, type IntegrationCapability } from './provider-capability-registry'

type ImplementationTable = Readonly<Record<string, Readonly<Record<IntegrationCapability, boolean>>>>

const IMPLEMENTATIONS: ImplementationTable = Object.freeze({
  dingtalk: Object.freeze({ directory: false, login: false, notification: false }),
})

export function isCapabilityImplementationAvailable(provider: string, capability: IntegrationCapability): boolean {
  if (!(INTEGRATION_CAPABILITIES as readonly string[]).includes(capability)) return false
  if (!Object.hasOwn(IMPLEMENTATIONS, provider)) return false
  return IMPLEMENTATIONS[provider][capability] === true
}
