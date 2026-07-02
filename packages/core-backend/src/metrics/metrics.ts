import type { Application, Request, Response, NextFunction } from 'express'
import client, {
  type CounterConfiguration,
  type GaugeConfiguration,
  type HistogramConfiguration,
  type SummaryConfiguration,
} from 'prom-client'

export const registry = new client.Registry()
client.collectDefaultMetrics({ register: registry })

function counter<T extends string>(configuration: CounterConfiguration<T>) {
  return new client.Counter<T>({ ...configuration, registers: [] })
}

function gauge<T extends string>(configuration: GaugeConfiguration<T>) {
  return new client.Gauge<T>({ ...configuration, registers: [] })
}

function histogram<T extends string>(configuration: HistogramConfiguration<T>) {
  return new client.Histogram<T>({ ...configuration, registers: [] })
}

function summary<T extends string>(configuration: SummaryConfiguration<T>) {
  return new client.Summary<T>({ ...configuration, registers: [] })
}

const httpHistogram = histogram({
  name: 'http_server_requests_seconds',
  help: 'HTTP server request duration in seconds',
  labelNames: ['route', 'method', 'status'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5]
})

const httpSummary = summary({
  name: 'http_server_requests_seconds_summary',
  help: 'HTTP request duration summary',
  labelNames: ['route', 'method', 'status'] as const,
  percentiles: [0.5, 0.9, 0.99]
})

const httpRequestsTotal = counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests by method and status',
  labelNames: ['method', 'status'] as const
})

const jwtAuthFail = counter({
  name: 'jwt_auth_fail_total',
  help: 'Total JWT auth failures',
  labelNames: ['reason'] as const
})

const approvalActions = counter({
  name: 'metasheet_approval_actions_total',
  help: 'Approval actions count',
  labelNames: ['action', 'result'] as const
})

const approvalConflict = counter({
  name: 'metasheet_approval_conflict_total',
  help: 'Approval version conflicts',
  labelNames: ['action'] as const
})

const automationWebhookRejectedTotal = counter({
  name: 'automation_webhook_rejected_total',
  help: 'Inbound automation webhook attempts rejected before execution',
  labelNames: ['reason'] as const
})

const rbacPermCacheHits = counter({
  name: 'rbac_perm_cache_hits_total',
  help: 'RBAC permission cache hits',
  labelNames: [] as const
})

const rbacPermCacheMiss = counter({
  name: 'rbac_perm_cache_miss_total',
  help: 'RBAC permission cache misses',
  labelNames: [] as const
})

// Alias (plural) for compatibility with external scripts
const rbacPermCacheMisses = counter({
  name: 'rbac_perm_cache_misses_total',
  help: 'RBAC permission cache misses (alias)',
  labelNames: [] as const
})

// RBAC denials and auth failures (compatibility names)
const rbacDenials = counter({
  name: 'metasheet_rbac_denials_total',
  help: 'Total RBAC permission denials',
  labelNames: [] as const
})

const authFailures = counter({
  name: 'metasheet_auth_failures_total',
  help: 'Total authentication failures (alias)',
  labelNames: [] as const
})

// V2 Integration metrics
const eventsEmittedTotal = counter({
  name: 'metasheet_events_emitted_total',
  help: 'Total events emitted via EventBus',
  labelNames: [] as const
})

const messagesProcessedTotal = counter({
  name: 'metasheet_messages_processed_total',
  help: 'Total messages processed via MessageBus',
  labelNames: [] as const
})

const messagesRetriedTotal = counter({
  name: 'metasheet_messages_retried_total',
  help: 'Total message retries',
  labelNames: [] as const
})

const messagesExpiredTotal = counter({
  name: 'metasheet_messages_expired_total',
  help: 'Total messages expired (dropped before processing)',
  labelNames: [] as const
})

const permissionDeniedTotal = counter({
  name: 'metasheet_permission_denied_total',
  help: 'Total permission denied (sandbox) occurrences',
  labelNames: [] as const
})

const rpcTimeoutsTotal = counter({
  name: 'metasheet_rpc_timeouts_total',
  help: 'Total RPC timeouts',
  labelNames: [] as const
})

// Config reload metrics
const configReloadTotal = counter({
  name: 'metasheet_config_reload_total',
  help: 'Total config reload operations',
  labelNames: ['result', 'telemetry_restart'] as const
})

const configVersionGauge = gauge({
  name: 'metasheet_config_version',
  help: 'Current config version (monotonic counter)',
  labelNames: [] as const
})

const configSamplingRate = gauge({
  name: 'metasheet_config_sampling_rate',
  help: 'Current telemetry sampling rate',
  labelNames: [] as const
})

// Plugin reload metrics (Phase 8)
const pluginReloadTotal = counter({
  name: 'metasheet_plugin_reload_total',
  help: 'Total plugin reload operations',
  labelNames: ['plugin_name', 'result'] as const
})

const pluginReloadDuration = histogram({
  name: 'metasheet_plugin_reload_duration_seconds',
  help: 'Plugin reload duration in seconds',
  labelNames: ['plugin_name'] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10]
})

const pluginStatus = gauge({
  name: 'metasheet_plugin_status',
  help: 'Plugin status indicator (1=current status)',
  labelNames: ['plugin_name', 'status'] as const
})

// Snapshot metrics (Phase 9)
const snapshotCreateTotal = counter({
  name: 'metasheet_snapshot_create_total',
  help: 'Total snapshot create operations',
  labelNames: ['result'] as const
})

const snapshotRestoreTotal = counter({
  name: 'metasheet_snapshot_restore_total',
  help: 'Total snapshot restore operations',
  labelNames: ['result'] as const
})

const snapshotOperationDuration = histogram({
  name: 'metasheet_snapshot_operation_duration_seconds',
  help: 'Snapshot operation duration in seconds',
  labelNames: ['operation'] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30]
})

const snapshotCleanupTotal = counter({
  name: 'metasheet_snapshot_cleanup_total',
  help: 'Total snapshot cleanup operations',
  labelNames: ['result'] as const
})

// Sprint 2: Snapshot Protection Metrics
const snapshotTagsTotal = counter({
  name: 'metasheet_snapshot_tags_total',
  help: 'Total count of snapshot tags usage',
  labelNames: ['tag'] as const
})

const snapshotProtectionLevel = gauge({
  name: 'metasheet_snapshot_protection_level',
  help: 'Snapshot protection level distribution',
  labelNames: ['level'] as const
})

const snapshotReleaseChannel = gauge({
  name: 'metasheet_snapshot_release_channel',
  help: 'Snapshot release channel distribution',
  labelNames: ['channel'] as const
})

const protectionRuleEvaluationsTotal = counter({
  name: 'metasheet_protection_rule_evaluations_total',
  help: 'Total protection rule evaluations',
  labelNames: ['rule', 'result'] as const
})

const protectionRuleBlocksTotal = counter({
  name: 'metasheet_protection_rule_blocks_total',
  help: 'Total operations blocked by protection rules',
  labelNames: ['rule', 'operation'] as const
})

const snapshotProtectedSkippedTotal = counter({
  name: 'metasheet_snapshot_protected_skipped_total',
  help: 'Total protected snapshots skipped during cleanup',
  labelNames: [] as const
})

// Cache metrics (Phase 1)
const cache_hits_total = counter({
  name: 'cache_hits_total',
  help: 'Total cache hits',
  labelNames: ['impl', 'key_pattern'] as const
})

const cache_miss_total = counter({
  name: 'cache_miss_total',
  help: 'Total cache misses',
  labelNames: ['impl', 'key_pattern'] as const
})

const cache_set_total = counter({
  name: 'cache_set_total',
  help: 'Total cache sets',
  labelNames: ['impl', 'key_pattern'] as const
})

const cache_del_total = counter({
  name: 'cache_del_total',
  help: 'Total cache deletions',
  labelNames: ['impl', 'key_pattern'] as const
})

const cache_errors_total = counter({
  name: 'cache_errors_total',
  help: 'Total cache errors',
  labelNames: ['impl', 'error_type'] as const
})

const cache_invalidate_total = counter({
  name: 'cache_invalidate_total',
  help: 'Total cache invalidations',
  labelNames: ['impl', 'tag'] as const
})

const cache_enabled = gauge({
  name: 'cache_enabled',
  help: 'Whether cache is enabled (1=enabled, 0=disabled)',
  labelNames: ['impl'] as const
})

const cache_candidate_requests = counter({
  name: 'cache_candidate_requests',
  help: 'Requests that could benefit from caching',
  labelNames: ['route', 'method'] as const
})

// Redis metrics (Phase 5 extension)
// Redis histogram; ensure creation even if Redis client not used yet
const redisOperationDuration = histogram({
  name: 'redis_operation_duration_seconds',
  help: 'Redis cache operation duration in seconds',
  labelNames: ['op'] as const,
  buckets: [0.0005, 0.001, 0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2]
})

const redisRecoveryAttemptsTotal = counter({
  name: 'redis_recovery_attempts_total',
  help: 'Redis recovery attempts after failure',
  labelNames: ['result'] as const
})

const redisLastFailureTimestamp = gauge({
  name: 'redis_last_failure_timestamp',
  help: 'Unix timestamp of last Redis failure',
  labelNames: [] as const
})

// Fallback metrics (Phase 5)
// Tracks degraded responses for SLO validation
// Reasons: http_error, http_timeout, message_error, message_timeout, cache_miss, circuit_breaker
const fallbackRawTotal = counter({
  name: 'metasheet_fallback_total',
  help: 'Total degraded fallback responses (raw count)',
  labelNames: ['reason'] as const
})

const fallbackEffectiveTotal = counter({
  name: 'metasheet_fallback_effective_total',
  help: 'Effective degraded fallback responses (excludes benign causes like cache_miss when COUNT_CACHE_MISS_AS_FALLBACK=false)',
  labelNames: ['reason'] as const
})

// RBAC table permission check metrics
const rbacPermissionChecksTotal = counter({
  name: 'rbac_permission_checks_total',
  help: 'Total RBAC permission checks by operation and result',
  labelNames: ['operation', 'result'] as const
})

const rbacCheckLatencySeconds = histogram({
  name: 'rbac_check_latency_seconds',
  help: 'RBAC permission check latency in seconds',
  labelNames: ['operation'] as const,
  buckets: [0.0001, 0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5]
})

// View data metrics (view-service)
const viewDataLatencySeconds = histogram({
  name: 'metasheet_view_data_latency_seconds',
  help: 'View data query latency in seconds',
  labelNames: ['type', 'status'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5]
})

const viewDataRequestsTotal = counter({
  name: 'metasheet_view_data_requests_total',
  help: 'Total view data requests',
  labelNames: ['type', 'result'] as const
})

// Sprint 4: Advanced Messaging Metrics
const dlqMessagesTotal = counter({
  name: 'metasheet_dlq_messages_total',
  help: 'Total messages sent to DLQ',
  labelNames: ['topic'] as const
})

const delayedMessagesTotal = counter({
  name: 'metasheet_delayed_messages_total',
  help: 'Total delayed messages scheduled',
  labelNames: ['topic'] as const
})

// BPMN Workflow Engine Metrics
const bpmnProcessInstancesTotal = counter({
  name: 'bpmn_process_instances_total',
  help: 'Total BPMN process instances started',
  labelNames: ['definition_key', 'result'] as const
})

const bpmnProcessInstancesActive = gauge({
  name: 'bpmn_process_instances_active',
  help: 'Current number of active BPMN process instances',
  labelNames: [] as const
})

const bpmnActivityExecutionsTotal = counter({
  name: 'bpmn_activity_executions_total',
  help: 'Total BPMN activity executions',
  labelNames: ['activity_type', 'result'] as const
})

const bpmnActivityDurationSeconds = histogram({
  name: 'bpmn_activity_duration_seconds',
  help: 'BPMN activity execution duration in seconds',
  labelNames: ['activity_type'] as const,
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30, 60]
})

const bpmnProcessDurationSeconds = histogram({
  name: 'bpmn_process_duration_seconds',
  help: 'BPMN process instance duration in seconds',
  labelNames: ['definition_key'] as const,
  buckets: [1, 5, 10, 30, 60, 300, 600, 1800, 3600]
})

const bpmnTimerJobsTotal = counter({
  name: 'bpmn_timer_jobs_total',
  help: 'Total BPMN timer jobs processed',
  labelNames: ['result'] as const
})

const bpmnSignalEventsTotal = counter({
  name: 'bpmn_signal_events_total',
  help: 'Total BPMN signal events processed',
  labelNames: ['signal_name'] as const
})

const bpmnMessageEventsTotal = counter({
  name: 'bpmn_message_events_total',
  help: 'Total BPMN message events processed',
  labelNames: ['message_name'] as const
})

const bpmnProcessErrorsTotal = counter({
  name: 'bpmn_process_errors_total',
  help: 'Total BPMN process errors',
  labelNames: ['error_type'] as const
})

const bpmnStuckInstancesGauge = gauge({
  name: 'bpmn_stuck_instances',
  help: 'Number of potentially stuck BPMN process instances',
  labelNames: [] as const
})

// RPC Latency Histogram
const rpcLatencySeconds = histogram({
  name: 'metasheet_rpc_latency_seconds',
  help: 'RPC call latency in seconds',
  labelNames: ['method', 'plugin', 'status'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5]
})

// Metrics Stream (real-time WebSocket streaming)
const metricsStreamClients = gauge({
  name: 'metasheet_metrics_stream_clients',
  help: 'Active metrics streaming clients',
  labelNames: [] as const
})

const metricsStreamPushesTotal = counter({
  name: 'metasheet_metrics_stream_pushes_total',
  help: 'Total push events sent via metrics stream',
  labelNames: [] as const
})

const metricsStreamErrorsTotal = counter({
  name: 'metasheet_metrics_stream_errors_total',
  help: 'Total metrics stream push errors',
  labelNames: [] as const
})

// API Gateway + CircuitBreaker observability (Lane 3 / collab-infra rollout).
// These are exposed via the shared registry so operators can query the
// same `/metrics/prom` endpoint; no new endpoint is introduced.
const apigwCbStoreUsedTotal = counter({
  name: 'apigw_cb_store_used_total',
  help: 'CircuitBreaker store operations by backing implementation',
  labelNames: ['store'] as const
})

const apigwCbInitTotal = counter({
  name: 'apigw_cb_init_total',
  help: 'APIGateway.initRedisCircuitBreakerStore outcome counts',
  labelNames: ['outcome'] as const
})

const automationSchedulerLeaderGauge = gauge({
  name: 'automation_scheduler_leader',
  help: 'AutomationScheduler leader-lock state (1=current state, 0=other)',
  labelNames: ['state'] as const
})

const approvalSlaSchedulerLeaderGauge = gauge({
  name: 'approval_sla_scheduler_leader',
  help: 'ApprovalSlaScheduler leader-lock state (1=current state, 0=other)',
  labelNames: ['state'] as const
})

registry.registerMetric(httpHistogram)
registry.registerMetric(httpSummary)
registry.registerMetric(httpRequestsTotal)
registry.registerMetric(jwtAuthFail)
registry.registerMetric(approvalActions)
registry.registerMetric(approvalConflict)
registry.registerMetric(automationWebhookRejectedTotal)
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
registry.registerMetric(configReloadTotal)
registry.registerMetric(configVersionGauge)
registry.registerMetric(configSamplingRate)
registry.registerMetric(pluginReloadTotal)
registry.registerMetric(pluginReloadDuration)
registry.registerMetric(pluginStatus)
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
registry.registerMetric(redisOperationDuration)
registry.registerMetric(redisRecoveryAttemptsTotal)
registry.registerMetric(redisLastFailureTimestamp)
registry.registerMetric(rbacPermissionChecksTotal)
registry.registerMetric(rbacCheckLatencySeconds)
registry.registerMetric(viewDataLatencySeconds)
registry.registerMetric(viewDataRequestsTotal)
registry.registerMetric(dlqMessagesTotal)
registry.registerMetric(delayedMessagesTotal)
registry.registerMetric(bpmnProcessInstancesTotal)
registry.registerMetric(bpmnProcessInstancesActive)
registry.registerMetric(bpmnActivityExecutionsTotal)
registry.registerMetric(bpmnActivityDurationSeconds)
registry.registerMetric(bpmnProcessDurationSeconds)
registry.registerMetric(bpmnTimerJobsTotal)
registry.registerMetric(bpmnSignalEventsTotal)
registry.registerMetric(bpmnMessageEventsTotal)
registry.registerMetric(bpmnProcessErrorsTotal)
registry.registerMetric(bpmnStuckInstancesGauge)
registry.registerMetric(rpcLatencySeconds)
registry.registerMetric(metricsStreamClients)
registry.registerMetric(metricsStreamPushesTotal)
registry.registerMetric(metricsStreamErrorsTotal)
registry.registerMetric(apigwCbStoreUsedTotal)
registry.registerMetric(apigwCbInitTotal)
registry.registerMetric(automationSchedulerLeaderGauge)
registry.registerMetric(approvalSlaSchedulerLeaderGauge)

function trimConfiguredMetricsToken(raw: string | undefined): string | null {
  const token = typeof raw === 'string' ? raw.trim() : ''
  return token.length > 0 ? token : null
}

export function resolveMetricsScrapeToken(env: NodeJS.ProcessEnv = process.env): string | null {
  return trimConfiguredMetricsToken(env.METRICS_SCRAPE_TOKEN)
}

function resolveProvidedMetricsToken(req: Request): string | null {
  const bearer = typeof req.headers.authorization === 'string' ? req.headers.authorization.trim() : ''
  if (bearer.startsWith('Bearer ')) {
    const token = bearer.slice(7).trim()
    if (token) return token
  }
  const headerToken = typeof req.headers['x-metrics-token'] === 'string' ? req.headers['x-metrics-token'].trim() : ''
  return headerToken || null
}

export function createMetricsAuthMiddleware(getToken: () => string | null = () => resolveMetricsScrapeToken()) {
  return (req: Request, res: Response, next: NextFunction) => {
    const expectedToken = getToken()
    if (!expectedToken) return next()

    const providedToken = resolveProvidedMetricsToken(req)
    if (providedToken === expectedToken) return next()

    res.setHeader('WWW-Authenticate', 'Bearer realm="metrics"')
    return res.status(401).json({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: 'Metrics scrape token required',
      },
    })
  }
}

export function installMetrics(app: Application) {
  const metricsAuthMiddleware = createMetricsAuthMiddleware()

  app.get('/metrics', metricsAuthMiddleware, async (_req, res) => {
    res.json(await registry.getMetricsAsJSON())
  })
  app.get('/metrics/prom', metricsAuthMiddleware, async (_req, res) => {
    res.set('Content-Type', registry.contentType)
    res.end(await registry.metrics())
  })
}

interface ResponseWithMetrics extends Response {
  __metricsStartNs?: bigint
  __metricsTimer?: (labels: { route: string; method: string }) => (status: number) => void
}

export function requestMetricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const end = httpHistogram.startTimer()
  const metricsRes = res as ResponseWithMetrics
  metricsRes.__metricsStartNs = process.hrtime.bigint()
  metricsRes.__metricsTimer = (labels: { route: string; method: string }) => (status: number) => {
    end({ route: labels.route, method: labels.method, status: String(status) })
    try {
      const start = metricsRes.__metricsStartNs
      if (start) {
        const dur = Number((process.hrtime.bigint() - start)) / 1e9
        httpSummary.labels(labels.route, labels.method, String(status)).observe(dur)
      }
      httpRequestsTotal.labels(labels.method, String(status)).inc()
    } catch { /* metrics recording failure - non-critical */ }
  }
  next()
}

export const metrics = {
  jwtAuthFail,
  approvalActions,
  approvalConflict,
  automationWebhookRejectedTotal,
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
  configReloadTotal,
  configVersionGauge,
  configSamplingRate,
  pluginReloadTotal,
  pluginReloadDuration,
  pluginStatus,
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
  fallbackEffectiveTotal,
  redisOperationDuration,
  redisRecoveryAttemptsTotal,
  redisLastFailureTimestamp,
  rbacPermissionChecksTotal,
  rbacCheckLatencySeconds,
  viewDataLatencySeconds,
  viewDataRequestsTotal,
  dlqMessagesTotal,
  delayedMessagesTotal,
  // BPMN Workflow metrics
  bpmnProcessInstancesTotal,
  bpmnProcessInstancesActive,
  bpmnActivityExecutionsTotal,
  bpmnActivityDurationSeconds,
  bpmnProcessDurationSeconds,
  bpmnTimerJobsTotal,
  bpmnSignalEventsTotal,
  bpmnMessageEventsTotal,
  bpmnProcessErrorsTotal,
  bpmnStuckInstancesGauge,
  // RPC Latency
  rpcLatencySeconds,
  // Metrics Stream
  metricsStreamClients,
  metricsStreamPushesTotal,
  metricsStreamErrorsTotal,
  // APIGateway + CircuitBreaker (Lane 3 / collab-infra rollout)
  apigwCbStoreUsedTotal,
  apigwCbInitTotal,
  automationSchedulerLeaderGauge,
  approvalSlaSchedulerLeaderGauge
}

/**
 * Observe RPC call latency in the Prometheus histogram.
 * @param method - RPC method name
 * @param plugin - Plugin identifier (caller or target)
 * @param status - 'success' | 'failure' | 'timeout'
 * @param durationSeconds - Duration in seconds
 */
export function observeRpcLatency(
  method: string,
  plugin: string,
  status: 'success' | 'failure' | 'timeout',
  durationSeconds: number
): void {
  rpcLatencySeconds.labels(method, plugin, status).observe(durationSeconds)
}
