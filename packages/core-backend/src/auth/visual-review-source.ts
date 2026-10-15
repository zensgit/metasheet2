import type { DataSourceConfig } from '../data-adapters/BaseAdapter'

export function visualReviewSourceConfigured(config: DataSourceConfig, tenantId?: string): boolean {
  const configuredTenant = config.options?.tenantId
  return config.type === 'plm' && config.options?.visualReviewEnabled === true
    && typeof configuredTenant === 'string' && configuredTenant.length > 0
    && configuredTenant.length <= 128 && configuredTenant.trim() === configuredTenant
    && (tenantId === undefined || tenantId === configuredTenant)
}

export function assertVisualReviewSourceScope(config: DataSourceConfig, tenantId: string | null): void {
  const enabled = config.options?.visualReviewEnabled
  if (enabled === undefined || enabled === false) return
  if (enabled !== true || !tenantId || !visualReviewSourceConfigured(config, tenantId)) {
    throw Object.assign(new Error('Visual review requires a PLM source bound to its stored tenant'), {
      status: 400, code: 'VISUAL_REVIEW_SOURCE_SCOPE_INVALID',
    })
  }
}
