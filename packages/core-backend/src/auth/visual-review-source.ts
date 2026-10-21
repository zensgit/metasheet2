import type { DataSourceConfig } from '../data-adapters/BaseAdapter'

export function visualReviewSourceConfigured(config: DataSourceConfig, tenantId?: string): boolean {
  const configuredTenant = config.options?.tenantId
  return config.type === 'plm' && config.options?.visualReviewEnabled === true
    && typeof configuredTenant === 'string' && configuredTenant.length > 0
    && configuredTenant.length <= 128 && configuredTenant.trim() === configuredTenant
    && (tenantId === undefined || tenantId === configuredTenant)
}

export function assertVisualReviewSourceScope(config: DataSourceConfig, tenantId: string | null): void {
  // Managed sources have independent Native and Meta namespaces. This opt-in is
  // usable only after the managed data plane locks the current identity binding.
  const managed = config.options?.managedVisualReviewEnabled
  if (managed !== undefined && managed !== false) {
    const nativeScope = [config.options?.tenantId, config.options?.orgId]
    if (managed !== true || config.type !== 'plm' || !nativeScope.every(value =>
      typeof value === 'string' && value.length > 0 && value.length <= 128 && value.trim() === value)) {
      throw Object.assign(new Error('Managed visual review requires an explicit Native source scope'), {
        status: 400, code: 'VISUAL_REVIEW_SOURCE_SCOPE_INVALID',
      })
    }
  }
  const enabled = config.options?.visualReviewEnabled
  if (enabled === undefined || enabled === false) return
  if (enabled !== true || !tenantId || !visualReviewSourceConfigured(config, tenantId)) {
    throw Object.assign(new Error('Visual review requires a PLM source bound to its stored tenant'), {
      status: 400, code: 'VISUAL_REVIEW_SOURCE_SCOPE_INVALID',
    })
  }
}

/** Management privilege covers both opt-ins; legacy data-plane admission remains separate. */
export function isVisualReviewSource(config: { options?: Record<string, unknown> }): boolean {
  return config.options?.visualReviewEnabled === true || config.options?.managedVisualReviewEnabled === true
}
