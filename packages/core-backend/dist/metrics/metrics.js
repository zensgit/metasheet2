"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.metrics = void 0;
exports.installMetrics = installMetrics;
exports.requestMetricsMiddleware = requestMetricsMiddleware;
const prom_client_1 = __importDefault(require("prom-client"));
const registry = new prom_client_1.default.Registry();
prom_client_1.default.collectDefaultMetrics({ register: registry });
const httpHistogram = new prom_client_1.default.Histogram({
    name: 'http_server_requests_seconds',
    help: 'HTTP server request duration in seconds',
    labelNames: ['route', 'method', 'status'],
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5]
});
const httpSummary = new prom_client_1.default.Summary({
    name: 'http_server_requests_seconds_summary',
    help: 'HTTP request duration summary',
    labelNames: ['route', 'method', 'status'],
    percentiles: [0.5, 0.9, 0.99]
});
const httpRequestsTotal = new prom_client_1.default.Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests by method and status',
    labelNames: ['method', 'status']
});
const jwtAuthFail = new prom_client_1.default.Counter({
    name: 'jwt_auth_fail_total',
    help: 'Total JWT auth failures',
    labelNames: ['reason']
});
const approvalActions = new prom_client_1.default.Counter({
    name: 'metasheet_approval_actions_total',
    help: 'Approval actions count',
    labelNames: ['action', 'result']
});
const approvalConflict = new prom_client_1.default.Counter({
    name: 'metasheet_approval_conflict_total',
    help: 'Approval version conflicts',
    labelNames: ['action']
});
const rbacPermCacheHits = new prom_client_1.default.Counter({
    name: 'rbac_perm_cache_hits_total',
    help: 'RBAC permission cache hits',
    labelNames: []
});
const rbacPermCacheMiss = new prom_client_1.default.Counter({
    name: 'rbac_perm_cache_miss_total',
    help: 'RBAC permission cache misses',
    labelNames: []
});
// Alias (plural) for compatibility with external scripts
const rbacPermCacheMisses = new prom_client_1.default.Counter({
    name: 'rbac_perm_cache_misses_total',
    help: 'RBAC permission cache misses (alias)',
    labelNames: []
});
// RBAC denials and auth failures (compatibility names)
const rbacDenials = new prom_client_1.default.Counter({
    name: 'metasheet_rbac_denials_total',
    help: 'Total RBAC permission denials',
    labelNames: []
});
const authFailures = new prom_client_1.default.Counter({
    name: 'metasheet_auth_failures_total',
    help: 'Total authentication failures (alias)',
    labelNames: []
});
// V2 Integration metrics
const eventsEmittedTotal = new prom_client_1.default.Counter({
    name: 'metasheet_events_emitted_total',
    help: 'Total events emitted via EventBus',
    labelNames: []
});
const messagesProcessedTotal = new prom_client_1.default.Counter({
    name: 'metasheet_messages_processed_total',
    help: 'Total messages processed via MessageBus',
    labelNames: []
});
const messagesRetriedTotal = new prom_client_1.default.Counter({
    name: 'metasheet_messages_retried_total',
    help: 'Total message retries',
    labelNames: []
});
const messagesExpiredTotal = new prom_client_1.default.Counter({
    name: 'metasheet_messages_expired_total',
    help: 'Total messages expired (dropped before processing)',
    labelNames: []
});
const permissionDeniedTotal = new prom_client_1.default.Counter({
    name: 'metasheet_permission_denied_total',
    help: 'Total permission denied (sandbox) occurrences',
    labelNames: []
});
const rpcTimeoutsTotal = new prom_client_1.default.Counter({
    name: 'metasheet_rpc_timeouts_total',
    help: 'Total RPC timeouts',
    labelNames: []
});
// Cache metrics (Phase 1)
const cache_hits_total = new prom_client_1.default.Counter({
    name: 'cache_hits_total',
    help: 'Total cache hits',
    labelNames: ['impl', 'key_pattern']
});
const cache_miss_total = new prom_client_1.default.Counter({
    name: 'cache_miss_total',
    help: 'Total cache misses',
    labelNames: ['impl', 'key_pattern']
});
const cache_set_total = new prom_client_1.default.Counter({
    name: 'cache_set_total',
    help: 'Total cache sets',
    labelNames: ['impl', 'key_pattern']
});
const cache_del_total = new prom_client_1.default.Counter({
    name: 'cache_del_total',
    help: 'Total cache deletions',
    labelNames: ['impl', 'key_pattern']
});
const cache_errors_total = new prom_client_1.default.Counter({
    name: 'cache_errors_total',
    help: 'Total cache errors',
    labelNames: ['impl', 'error_type']
});
const cache_invalidate_total = new prom_client_1.default.Counter({
    name: 'cache_invalidate_total',
    help: 'Total cache invalidations',
    labelNames: ['impl', 'tag']
});
const cache_enabled = new prom_client_1.default.Gauge({
    name: 'cache_enabled',
    help: 'Whether cache is enabled (1=enabled, 0=disabled)',
    labelNames: ['impl']
});
const cache_candidate_requests = new prom_client_1.default.Counter({
    name: 'cache_candidate_requests',
    help: 'Requests that could benefit from caching',
    labelNames: ['route', 'method']
});
registry.registerMetric(httpHistogram);
registry.registerMetric(httpSummary);
registry.registerMetric(httpRequestsTotal);
registry.registerMetric(jwtAuthFail);
registry.registerMetric(approvalActions);
registry.registerMetric(approvalConflict);
registry.registerMetric(rbacPermCacheHits);
registry.registerMetric(rbacPermCacheMiss);
registry.registerMetric(rbacPermCacheMisses);
registry.registerMetric(rbacDenials);
registry.registerMetric(authFailures);
registry.registerMetric(eventsEmittedTotal);
registry.registerMetric(messagesProcessedTotal);
registry.registerMetric(messagesRetriedTotal);
registry.registerMetric(messagesExpiredTotal);
registry.registerMetric(permissionDeniedTotal);
registry.registerMetric(rpcTimeoutsTotal);
registry.registerMetric(cache_hits_total);
registry.registerMetric(cache_miss_total);
registry.registerMetric(cache_set_total);
registry.registerMetric(cache_del_total);
registry.registerMetric(cache_errors_total);
registry.registerMetric(cache_invalidate_total);
registry.registerMetric(cache_enabled);
registry.registerMetric(cache_candidate_requests);
function installMetrics(app) {
    app.get('/metrics', async (_req, res) => {
        res.json(await registry.getMetricsAsJSON());
    });
    app.get('/metrics/prom', async (_req, res) => {
        res.set('Content-Type', registry.contentType);
        res.end(await registry.metrics());
    });
}
function requestMetricsMiddleware(req, res, next) {
    const end = httpHistogram.startTimer();
    res.__metricsStartNs = process.hrtime.bigint();
    res.__metricsTimer = (labels) => (status) => {
        end({ route: labels.route, method: labels.method, status: String(status) });
        try {
            const start = res.__metricsStartNs;
            if (start) {
                const dur = Number((process.hrtime.bigint() - start)) / 1e9;
                httpSummary.labels(labels.route, labels.method, String(status)).observe(dur);
            }
            httpRequestsTotal.labels(labels.method, String(status)).inc();
        }
        catch { }
    };
    next();
}
exports.metrics = {
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
    cache_hits_total,
    cache_miss_total,
    cache_set_total,
    cache_del_total,
    cache_errors_total,
    cache_invalidate_total,
    cache_enabled,
    cache_candidate_requests
};
//# sourceMappingURL=metrics.js.map