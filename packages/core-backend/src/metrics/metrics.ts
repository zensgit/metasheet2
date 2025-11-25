import type { Application, Request, Response, NextFunction } from 'express'
import client from 'prom-client'

export const registry = new client.Registry()
client.collectDefaultMetrics({ register: registry })

const httpHistogram = new client.Histogram({
  name: 'http_server_requests_seconds',
  help: 'HTTP server request duration in seconds',
  labelNames: ['route', 'method', 'status'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5]
})

const httpSummary = new client.Summary({
  name: 'http_server_requests_seconds_summary',
  help: 'HTTP request duration summary',
  labelNames: ['route', 'method', 'status'] as const,
  percentiles: [0.5, 0.9, 0.99]
})

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests by method and status',
  labelNames: ['method', 'status'] as const
})

const jwtAuthFail = new client.Counter({
  name: 'jwt_auth_fail_total',
  help: 'Total JWT auth failures',
  labelNames: ['reason'] as const
})

const approvalActions = new client.Counter({
  name: 'metasheet_approval_actions_total',
  help: 'Approval actions count',
  labelNames: ['action', 'result'] as const
})

const approvalConflict = new client.Counter({
  name: 'metasheet_approval_conflict_total',
  help: 'Approval version conflicts',
  labelNames: ['action'] as const
})

const rbacPermCacheHits = new client.Counter({
  name: 'rbac_perm_cache_hits_total',
  help: 'RBAC permission cache hits',
  labelNames: [] as const
})

const rbacPermCacheMiss = new client.Counter({
  name: 'rbac_perm_cache_miss_total',
  help: 'RBAC permission cache misses',
  labelNames: [] as const
})

// Alias (plural) for compatibility with external scripts
const rbacPermCacheMisses = new client.Counter({
  name: 'rbac_perm_cache_misses_total',
  help: 'RBAC permission cache misses (alias)',
  labelNames: [] as const
})

// RBAC denials and auth failures (compatibility names)
const rbacDenials = new client.Counter({
  name: 'metasheet_rbac_denials_total',
  help: 'Total RBAC permission denials',
  labelNames: [] as const
})

const authFailures = new client.Counter({
  name: 'metasheet_auth_failures_total',
  help: 'Total authentication failures (alias)',
  labelNames: [] as const
})

// V2 Integration metrics
const eventsEmittedTotal = new client.Counter({
  name: 'metasheet_events_emitted_total',
  help: 'Total events emitted via EventBus',
  labelNames: [] as const
})

const messagesProcessedTotal = new client.Counter({
  name: 'metasheet_messages_processed_total',
  help: 'Total messages processed via MessageBus',
  labelNames: [] as const
})

const messagesRetriedTotal = new client.Counter({
  name: 'metasheet_messages_retried_total',
  help: 'Total message retries',
  labelNames: [] as const
})

const messagesExpiredTotal = new client.Counter({
  name: 'metasheet_messages_expired_total',
  help: 'Total messages expired (dropped before processing)',
  labelNames: [] as const
})

const permissionDeniedTotal = new client.Counter({
  name: 'metasheet_permission_denied_total',
  help: 'Total permission denied (sandbox) occurrences',
  labelNames: [] as const
})

const rpcTimeoutsTotal = new client.Counter({
  name: 'metasheet_rpc_timeouts_total',
  help: 'Total RPC timeouts',
  labelNames: [] as const
})

// Plugin reload metrics (Phase 8)
const pluginReloadTotal = new client.Counter({
  name: 'metasheet_plugin_reload_total',
  help: 'Total plugin reload operations',
  labelNames: ['plugin_name', 'result'] as const
})

const pluginReloadDuration = new client.Histogram({
  name: 'metasheet_plugin_reload_duration_seconds',
  help: 'Plugin reload duration in seconds',
  labelNames: ['plugin_name'] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10]
})

// Snapshot metrics (Phase 9)
const snapshotCreateTotal = new client.Counter({
  name: 'metasheet_snapshot_create_total',
  help: 'Total snapshot create operations',
  labelNames: ['result'] as const
})

const snapshotRestoreTotal = new client.Counter({
  name: 'metasheet_snapshot_restore_total',
  help: 'Total snapshot restore operations',
  labelNames: ['result'] as const
})

const snapshotOperationDuration = new client.Histogram({
  name: 'metasheet_snapshot_operation_duration_seconds',
  help: 'Snapshot operation duration in seconds',
  labelNames: ['operation'] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30]
})

const snapshotCleanupTotal = new client.Counter({
  name: 'metasheet_snapshot_cleanup_total',
  help: 'Total snapshot cleanup operations',
  labelNames: ['result'] as const
})

// Sprint 2: Snapshot Protection Metrics
const snapshotTagsTotal = new client.Counter({
  name: 'metasheet_snapshot_tags_total',
  help: 'Total count of snapshot tags usage',
  labelNames: ['tag'] as const
})

const snapshotProtectionLevel = new client.Gauge({
  name: 'metasheet_snapshot_protection_level',
  help: 'Snapshot protection level distribution',
  labelNames: ['level'] as const
})

const snapshotReleaseChannel = new client.Gauge({
  name: 'metasheet_snapshot_release_channel',
  help: 'Snapshot release channel distribution',
  labelNames: ['channel'] as const
})

const protectionRuleEvaluationsTotal = new client.Counter({
  name: 'metasheet_protection_rule_evaluations_total',
  help: 'Total protection rule evaluations',
  labelNames: ['rule', 'result'] as const
})

const protectionRuleBlocksTotal = new client.Counter({
  name: 'metasheet_protection_rule_blocks_total',
  help: 'Total operations blocked by protection rules',
  labelNames: ['rule', 'operation'] as const
})

const snapshotProtectedSkippedTotal = new client.Counter({
  name: 'metasheet_snapshot_protected_skipped_total',
  help: 'Total protected snapshots skipped during cleanup',
  labelNames: [] as const
})

// Cache metrics (Phase 1)
const cache_hits_total = new client.Counter({
  name: 'cache_hits_total',
  help: 'Total cache hits',
  labelNames: ['impl', 'key_pattern'] as const
})

const cache_miss_total = new client.Counter({
  name: 'cache_miss_total',
  help: 'Total cache misses',
  labelNames: ['impl', 'key_pattern'] as const
})

const cache_set_total = new client.Counter({
  name: 'cache_set_total',
  help: 'Total cache sets',
  labelNames: ['impl', 'key_pattern'] as const
})

const cache_del_total = new client.Counter({
  name: 'cache_del_total',
  help: 'Total cache deletions',
  labelNames: ['impl', 'key_pattern'] as const
})

const cache_errors_total = new client.Counter({
  name: 'cache_errors_total',
  help: 'Total cache errors',
  labelNames: ['impl', 'error_type'] as const
})

const cache_invalidate_total = new client.Counter({
  name: 'cache_invalidate_total',
  help: 'Total cache invalidations',
  labelNames: ['impl', 'tag'] as const
})

const cache_enabled = new client.Gauge({
  name: 'cache_enabled',
  help: 'Whether cache is enabled (1=enabled, 0=disabled)',
  labelNames: ['impl'] as const
})

const cache_candidate_requests = new client.Counter({
  name: 'cache_candidate_requests',
  help: 'Requests that could benefit from caching',
  labelNames: ['route', 'method'] as const
})

// Fallback metrics (Phase 5)
// Tracks degraded responses for SLO validation
// Reasons: http_error, http_timeout, message_error, message_timeout, cache_miss, circuit_breaker
const fallbackRawTotal = new client.Counter({
  name: 'metasheet_fallback_total',
  help: 'Total degraded fallback responses (raw count)',
  labelNames: ['reason'] as const
})

const fallbackEffectiveTotal = new client.Counter({
  name: 'metasheet_fallback_effective_total',
  help: 'Effective degraded fallback responses (excludes benign causes like cache_miss when COUNT_CACHE_MISS_AS_FALLBACK=false)',
  labelNames: ['reason'] as const
})

registry.registerMetric(httpHistogram)
registry.registerMetric(httpSummary)
registry.registerMetric(httpRequestsTotal)
registry.registerMetric(jwtAuthFail)
registry.registerMetric(approvalActions)
registry.registerMetric(approvalConflict)
registry.registerMetric(rbacPermCacheHits)
registry.registerMetric(rbacPermCacheMiss)
registry.registerMetric(rbacPermCacheMisses)
registry.registerMetric(rbacDenials)
registry.registerMetric(authFailures)
registry.registerMetric(eventsEmittedTotal)
registry.registerMetric(messagesProcessedTotal)
registry.registerMetric(messagesRetriedTotal)
registry.registerMetric(messagesExpiredTotal)
registry.registerMetric(permissionDeniedTotal)
registry.registerMetric(rpcTimeoutsTotal)
registry.registerMetric(pluginReloadTotal)
registry.registerMetric(pluginReloadDuration)
registry.registerMetric(snapshotCreateTotal)
registry.registerMetric(snapshotRestoreTotal)
registry.registerMetric(snapshotOperationDuration)
registry.registerMetric(snapshotCleanupTotal)
registry.registerMetric(snapshotTagsTotal)
registry.registerMetric(snapshotProtectionLevel)
registry.registerMetric(snapshotReleaseChannel)
registry.registerMetric(protectionRuleEvaluationsTotal)
registry.registerMetric(protectionRuleBlocksTotal)
registry.registerMetric(snapshotProtectedSkippedTotal)
registry.registerMetric(cache_hits_total)
registry.registerMetric(cache_miss_total)
registry.registerMetric(cache_set_total)
registry.registerMetric(cache_del_total)
registry.registerMetric(cache_errors_total)
registry.registerMetric(cache_invalidate_total)
registry.registerMetric(cache_enabled)
registry.registerMetric(cache_candidate_requests)
registry.registerMetric(fallbackRawTotal)
registry.registerMetric(fallbackEffectiveTotal)

export function installMetrics(app: Application) {
  app.get('/metrics', async (_req, res) => {
    res.json(await registry.getMetricsAsJSON())
  })
  app.get('/metrics/prom', async (_req, res) => {
    res.set('Content-Type', registry.contentType)
    res.end(await registry.metrics())
  })
}

export function requestMetricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const end = httpHistogram.startTimer()
  ;(res as any).__metricsStartNs = process.hrtime.bigint()
  ;(res as any).__metricsTimer = (labels: { route: string; method: string }) => (status: number) => {
    end({ route: labels.route, method: labels.method, status: String(status) })
    try {
      const start = (res as any).__metricsStartNs as bigint | undefined
      if (start) {
        const dur = Number((process.hrtime.bigint() - start)) / 1e9
        httpSummary.labels(labels.route, labels.method, String(status)).observe(dur)
      }
      httpRequestsTotal.labels(labels.method, String(status)).inc()
    } catch {}
  }
  next()
}

export const metrics = {
  jwtAuthFail,
  approvalActions,
  approvalConflict,
  rbacPermCacheHits,
  rbacPermCacheMiss,
  rbacPermCacheMisses,
  rbacDenials,
  authFailures,
  httpSummary,
  httpRequestsTotal,
  eventsEmittedTotal,
  messagesProcessedTotal,
  messagesRetriedTotal,
  messagesExpiredTotal,
  permissionDeniedTotal,
  rpcTimeoutsTotal,
  pluginReloadTotal,
  pluginReloadDuration,
  snapshotCreateTotal,
  snapshotRestoreTotal,
  snapshotOperationDuration,
  snapshotCleanupTotal,
  snapshotTagsTotal,
  snapshotProtectionLevel,
  snapshotReleaseChannel,
  protectionRuleEvaluationsTotal,
  protectionRuleBlocksTotal,
  snapshotProtectedSkippedTotal,
  cache_hits_total,
  cache_miss_total,
  cache_set_total,
  cache_del_total,
  cache_errors_total,
  cache_invalidate_total,
  cache_enabled,
  cache_candidate_requests,
  fallbackRawTotal,
  fallbackEffectiveTotal
}
