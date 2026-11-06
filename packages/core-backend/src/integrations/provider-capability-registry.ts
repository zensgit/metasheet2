/**
 * Provider capability registry: a static, frozen table that says, per provider, how each integration
 * capability (directory, login, notification) is governed and how the provider's scope is read from an
 * integration row. Pure module: types and data only, no I/O.
 *
 * The production registry cannot be replaced at runtime: the production entry point takes only a
 * provider name, and the test entry point takes the registry explicitly.
 */
export const INTEGRATION_CAPABILITIES = ['directory', 'login', 'notification'] as const
export type IntegrationCapability = (typeof INTEGRATION_CAPABILITIES)[number]

/**
 * legacy: governed by the existing switches and configuration; the stored state may not be true.
 * gated: a capability-gated path exists; the stored state may be set true.
 * unsupported: the provider does not offer the capability.
 */
export type CapabilityGovernance = 'legacy' | 'gated' | 'unsupported'

export type IntegrationScope = Readonly<{ tenant: string; appScope: string }>

/** Shape of a stored provider name; identical to the table CHECK. */
export const PROVIDER_NAME_PATTERN = '^[a-z][a-z0-9_]{0,31}$'
/** Shapes of a stored scope anchor; identical to the table CHECKs. */
export const ANCHOR_TENANT_PATTERN = '^[!-~]+$'
export const ANCHOR_APP_SCOPE_PATTERN = '^[!-~]{1,256}$'

const TENANT_RE = new RegExp(ANCHOR_TENANT_PATTERN)
const APP_SCOPE_RE = new RegExp(ANCHOR_APP_SCOPE_PATTERN)

export type EnablePreconditionContext = Readonly<{
  integrationId: string
  provider: string
  scope: IntegrationScope
}>

export interface ProviderCapabilityDescriptor {
  /** Exactly equal to directory_integrations.provider. */
  readonly provider: string
  readonly governance: Readonly<Record<IntegrationCapability, CapabilityGovernance>>
  /**
   * Reads the scope from an integration row. A missing, blank, non-ASCII or over-long value (anything
   * outside the two anchor patterns) yields null.
   */
  scopeOf(row: { corp_id: string; config: unknown }): IntegrationScope | null
  /** Persisted-evidence checks run before a capability is enabled; required for every 'gated' capability. */
  enablePreconditions?(
    capability: IntegrationCapability,
    context: EnablePreconditionContext,
  ): Promise<{ ok: true } | { ok: false; code: string }>
}

/** The scope a value pair would be stored as, or null when it does not satisfy the anchor patterns. */
export function scopeFromValues(tenant: unknown, appScope: unknown): IntegrationScope | null {
  if (typeof tenant !== 'string' || typeof appScope !== 'string') return null
  if (!TENANT_RE.test(tenant) || !APP_SCOPE_RE.test(appScope)) return null
  return Object.freeze({ tenant, appScope })
}

function dingTalkScopeOf(row: { corp_id: string; config: unknown }): IntegrationScope | null {
  const config = row.config
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return null
  const appKey = (config as Record<string, unknown>).appKey
  if (typeof appKey !== 'string') return null
  return scopeFromValues(row.corp_id, appKey.trim())
}

const DINGTALK: ProviderCapabilityDescriptor = Object.freeze({
  provider: 'dingtalk',
  governance: Object.freeze({ directory: 'legacy', login: 'legacy', notification: 'legacy' } as const),
  scopeOf: dingTalkScopeOf,
})

/** The production registry: frozen. 'local' and every other provider are intentionally absent. */
const PRODUCTION_REGISTRY: readonly ProviderCapabilityDescriptor[] = Object.freeze([DINGTALK])

/** Production entry point: bound to the production registry, accepts no registry argument. */
export function resolveProviderCapabilityDescriptor(provider: string): ProviderCapabilityDescriptor | null {
  return lookupProviderCapabilityDescriptor(PRODUCTION_REGISTRY, provider)
}

/** Test entry point: the registry is passed explicitly. */
export function lookupProviderCapabilityDescriptor(
  registry: readonly ProviderCapabilityDescriptor[],
  provider: string,
): ProviderCapabilityDescriptor | null {
  for (const descriptor of registry) {
    if (descriptor.provider === provider) return descriptor
  }
  return null
}

/** Throws for a duplicate provider (a repeated identical object is ignored) or a 'gated' capability without preconditions. */
export function assertRegistryWellFormed(registry: readonly ProviderCapabilityDescriptor[]): void {
  const seen = new Map<string, ProviderCapabilityDescriptor>()
  for (const descriptor of registry) {
    const previous = seen.get(descriptor.provider)
    if (previous !== undefined) {
      if (previous === descriptor) continue
      throw new Error('provider capability registry: duplicate provider entry')
    }
    seen.set(descriptor.provider, descriptor)
    for (const capability of INTEGRATION_CAPABILITIES) {
      if (descriptor.governance[capability] === 'gated' && typeof descriptor.enablePreconditions !== 'function') {
        throw new Error('provider capability registry: gated capability without enable preconditions')
      }
    }
  }
}

assertRegistryWellFormed(PRODUCTION_REGISTRY)
