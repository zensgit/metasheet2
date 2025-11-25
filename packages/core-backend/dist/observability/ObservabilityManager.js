/**
 * Unified Observability Manager
 * Integrates metrics, tracing, logging, and alerting into a single cohesive system
 */
import { EventEmitter } from 'eventemitter3';
import { MetricsCollector } from './MetricsCollector';
import { DistributedTracing } from './DistributedTracing';
import { getTelemetry } from '../services/TelemetryService';
import { Logger } from '../core/logger';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
export class ObservabilityManager extends EventEmitter {
    config;
    metricsCollector;
    distributedTracing;
    telemetryService;
    logger;
    alerts = new Map();
    healthChecks = new Map();
    performanceMetrics;
    profilingInterval;
    constructor(config) {
        super();
        this.config = config;
        this.logger = new Logger('ObservabilityManager');
        this.performanceMetrics = {
            requestCount: 0,
            totalResponseTime: 0,
            errorCount: 0,
            lastReset: new Date()
        };
        this.initialize();
    }
    /**
     * Initialize all observability components
     */
    async initialize() {
        try {
            // Initialize metrics collection
            if (this.config.metrics?.enabled) {
                this.initializeMetrics();
            }
            // Initialize distributed tracing
            if (this.config.tracing?.enabled) {
                this.initializeTracing();
            }
            // Initialize telemetry service
            this.initializeTelemetry();
            // Initialize alerting
            if (this.config.alerting?.enabled) {
                this.initializeAlerting();
            }
            // Initialize profiling
            if (this.config.profiling?.enabled) {
                this.initializeProfiling();
            }
            // Register default health checks
            this.registerDefaultHealthChecks();
            this.logger.info('Observability Manager initialized', {
                serviceName: this.config.serviceName,
                environment: this.config.environment,
                version: this.config.version
            });
            this.emit('initialized');
        }
        catch (error) {
            this.logger.error('Failed to initialize Observability Manager', error);
            throw error;
        }
    }
    /**
     * Initialize metrics collection
     */
    initializeMetrics() {
        this.metricsCollector = new MetricsCollector({
            prefix: `${this.config.serviceName}_`,
            defaultLabels: {
                environment: this.config.environment,
                version: this.config.version
            },
            enableDefaultMetrics: true,
            aggregateInterval: this.config.metrics?.collectInterval
        });
        // Register custom metrics
        if (this.config.metrics?.customMetrics) {
            for (const metric of this.config.metrics.customMetrics) {
                this.metricsCollector.registerCustomMetric(metric);
            }
        }
        this.logger.info('Metrics collector initialized');
    }
    /**
     * Initialize distributed tracing
     */
    initializeTracing() {
        this.distributedTracing = new DistributedTracing({
            serviceName: this.config.serviceName,
            serviceVersion: this.config.version,
            environment: this.config.environment,
            exporters: {
                console: this.config.environment === 'development',
                jaeger: this.config.tracing?.jaegerEndpoint ? {
                    endpoint: this.config.tracing.jaegerEndpoint
                } : undefined,
                zipkin: this.config.tracing?.zipkinEndpoint ? {
                    url: this.config.tracing.zipkinEndpoint
                } : undefined
            },
            sampling: {
                probability: this.config.tracing?.samplingRate || 1.0
            },
            propagators: this.config.tracing?.propagators
        });
        this.logger.info('Distributed tracing initialized');
    }
    /**
     * Initialize telemetry service
     */
    initializeTelemetry() {
        this.telemetryService = getTelemetry({
            serviceName: this.config.serviceName,
            serviceVersion: this.config.version,
            environment: this.config.environment,
            enableMetrics: this.config.metrics?.enabled,
            enableTracing: this.config.tracing?.enabled,
            samplingRate: this.config.tracing?.samplingRate
        });
        this.telemetryService.initialize().catch(error => {
            this.logger.error('Failed to initialize telemetry', error);
        });
    }
    /**
     * Initialize alerting system
     */
    initializeAlerting() {
        if (!this.config.alerting?.rules)
            return;
        // Start monitoring for alert conditions
        setInterval(() => {
            this.checkAlertRules();
        }, 30000); // Check every 30 seconds
        this.logger.info('Alerting system initialized', {
            rules: this.config.alerting.rules.length
        });
    }
    /**
     * Initialize performance profiling
     */
    initializeProfiling() {
        if (!this.config.profiling)
            return;
        const interval = this.config.profiling.interval || 300000; // 5 minutes
        this.profilingInterval = setInterval(() => {
            this.collectProfilingData();
        }, interval);
        this.logger.info('Performance profiling initialized');
    }
    /**
     * Register default health checks
     */
    registerDefaultHealthChecks() {
        // Database health check
        this.registerHealthCheck('database', async () => {
            try {
                // Check database connectivity
                const { db } = await import('../db/db');
                await db.selectFrom('users').select('id').limit(1).execute();
                return true;
            }
            catch {
                return false;
            }
        });
        // Memory health check
        this.registerHealthCheck('memory', async () => {
            const usage = process.memoryUsage();
            const limit = 1024 * 1024 * 1024; // 1GB
            return usage.heapUsed < limit;
        });
        // CPU health check
        this.registerHealthCheck('cpu', async () => {
            const cpus = os.cpus();
            const avgLoad = os.loadavg()[0] / cpus.length;
            return avgLoad < 0.8; // Less than 80% load
        });
    }
    /**
     * Express middleware for observability
     */
    middleware() {
        return async (req, res, next) => {
            const startTime = Date.now();
            const correlationId = (req.headers[this.config.logging?.correlationIdHeader || 'x-correlation-id'] || crypto.randomUUID());
            // Add correlation ID to request
            req.correlationId = correlationId;
            // Start trace span
            let span;
            if (this.distributedTracing) {
                span = this.distributedTracing.startSpan(`${req.method} ${req.path}`, {
                    attributes: {
                        'http.method': req.method,
                        'http.url': req.url,
                        'http.target': req.path,
                        'correlation.id': correlationId
                    }
                });
            }
            // Log request
            this.logger.info('Request received', {
                method: req.method,
                path: req.path,
                correlationId,
                ip: req.ip,
                userAgent: req.get('user-agent')
            });
            // Hook into response
            const originalSend = res.send;
            res.send = function (data) {
                const responseTime = Date.now() - startTime;
                // Update metrics
                if (this.metricsCollector) {
                    this.metricsCollector.recordHttpRequest(req.method, req.route?.path || req.path, res.statusCode, responseTime, parseInt(req.get('content-length') || '0'), Buffer.byteLength(data));
                }
                // Update performance metrics
                this.performanceMetrics.requestCount++;
                this.performanceMetrics.totalResponseTime += responseTime;
                if (res.statusCode >= 400) {
                    this.performanceMetrics.errorCount++;
                }
                // End trace span
                if (span && this.distributedTracing) {
                    this.distributedTracing.endSpan(span, {
                        code: res.statusCode < 400 ? 0 : 2,
                        message: res.statusCode >= 400 ? `HTTP ${res.statusCode}` : undefined
                    });
                }
                // Log response
                this.logger.info('Request completed', {
                    method: req.method,
                    path: req.path,
                    statusCode: res.statusCode,
                    responseTime,
                    correlationId
                });
                // Add observability headers
                res.set('X-Correlation-Id', correlationId);
                res.set('X-Response-Time', responseTime.toString());
                return originalSend.call(this, data);
            }.bind(res);
            next();
        };
    }
    /**
     * Check alert rules
     */
    async checkAlertRules() {
        if (!this.config.alerting?.rules)
            return;
        const metrics = await this.getCurrentMetrics();
        for (const rule of this.config.alerting.rules) {
            const value = this.evaluateCondition(rule.condition, metrics);
            if (value > rule.threshold) {
                const alert = this.alerts.get(rule.name);
                if (!alert || (Date.now() - alert.triggered.getTime()) > (rule.duration || 0) * 1000) {
                    this.triggerAlert(rule, value);
                }
            }
            else {
                // Clear alert if condition no longer met
                this.alerts.delete(rule.name);
            }
        }
    }
    /**
     * Evaluate alert condition
     */
    evaluateCondition(condition, metrics) {
        // Simple evaluation - in production use a proper expression evaluator
        switch (condition) {
            case 'error_rate':
                return this.performanceMetrics.requestCount > 0
                    ? (this.performanceMetrics.errorCount / this.performanceMetrics.requestCount) * 100
                    : 0;
            case 'response_time':
                return this.performanceMetrics.requestCount > 0
                    ? this.performanceMetrics.totalResponseTime / this.performanceMetrics.requestCount
                    : 0;
            case 'cpu_usage':
                return metrics.system?.cpu || 0;
            case 'memory_usage':
                return metrics.system?.memory.percentage || 0;
            default:
                return 0;
        }
    }
    /**
     * Trigger an alert
     */
    triggerAlert(rule, value) {
        const alert = {
            rule,
            triggered: new Date(),
            count: (this.alerts.get(rule.name)?.count || 0) + 1
        };
        this.alerts.set(rule.name, alert);
        const alertData = {
            name: rule.name,
            severity: rule.severity,
            message: rule.message.replace('{{value}}', value.toString()),
            value,
            threshold: rule.threshold,
            timestamp: alert.triggered,
            annotations: rule.annotations
        };
        // Log alert
        this.logger.error('Alert triggered', alertData);
        // Emit alert event
        this.emit('alert', alertData);
        // Send notifications
        this.sendAlertNotifications(alertData);
    }
    /**
     * Send alert notifications
     */
    async sendAlertNotifications(alert) {
        const notifications = [];
        // Webhook notifications
        if (this.config.alerting?.webhooks) {
            for (const webhook of this.config.alerting.webhooks) {
                notifications.push(this.sendWebhookNotification(webhook, alert));
            }
        }
        // Add other notification channels (email, Slack, etc.)
        await Promise.allSettled(notifications);
    }
    /**
     * Send webhook notification
     */
    async sendWebhookNotification(webhook, alert) {
        try {
            await fetch(webhook, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(alert)
            });
        }
        catch (error) {
            this.logger.error('Failed to send webhook notification', error);
        }
    }
    /**
     * Collect profiling data
     */
    async collectProfilingData() {
        if (!this.config.profiling)
            return;
        const profilingDir = path.join(process.cwd(), 'profiling');
        await fs.promises.mkdir(profilingDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        // CPU profile
        if (this.config.profiling.cpuProfile) {
            try {
                const profiler = require('v8-profiler-next');
                profiler.startProfiling('CPU profile');
                setTimeout(() => {
                    const profile = profiler.stopProfiling();
                    profile.export((error, result) => {
                        if (!error) {
                            fs.promises.writeFile(path.join(profilingDir, `cpu-profile-${timestamp}.cpuprofile`), result);
                        }
                        profile.delete();
                    });
                }, 10000); // Profile for 10 seconds
            }
            catch (error) {
                this.logger.error('Failed to collect CPU profile', error);
            }
        }
        // Heap snapshot
        if (this.config.profiling.heapSnapshot) {
            try {
                const v8 = require('v8');
                const heapSnapshot = v8.writeHeapSnapshot();
                if (heapSnapshot) {
                    await fs.promises.rename(heapSnapshot, path.join(profilingDir, `heap-snapshot-${timestamp}.heapsnapshot`));
                }
            }
            catch (error) {
                this.logger.error('Failed to collect heap snapshot', error);
            }
        }
    }
    /**
     * Register a health check
     */
    registerHealthCheck(name, check) {
        this.healthChecks.set(name, check);
    }
    /**
     * Get current health status
     */
    async getHealthStatus() {
        const checks = {};
        for (const [name, check] of this.healthChecks) {
            try {
                checks[name] = await check();
            }
            catch {
                checks[name] = false;
            }
        }
        const metrics = await this.getCurrentMetrics();
        const allHealthy = Object.values(checks).every(v => v === true);
        const someHealthy = Object.values(checks).some(v => v === true);
        return {
            status: allHealthy ? 'healthy' : someHealthy ? 'degraded' : 'unhealthy',
            timestamp: new Date(),
            checks: {
                database: checks.database || false,
                cache: checks.cache || false,
                queue: checks.queue || false,
                external: Object.fromEntries(Object.entries(checks).filter(([k]) => !['database', 'cache', 'queue'].includes(k)))
            },
            metrics: {
                cpu: metrics.system?.cpu || 0,
                memory: metrics.system?.memory.percentage || 0,
                responseTime: this.performanceMetrics.requestCount > 0
                    ? this.performanceMetrics.totalResponseTime / this.performanceMetrics.requestCount
                    : 0,
                errorRate: this.performanceMetrics.requestCount > 0
                    ? (this.performanceMetrics.errorCount / this.performanceMetrics.requestCount) * 100
                    : 0
            }
        };
    }
    /**
     * Get current metrics
     */
    async getCurrentMetrics() {
        if (this.metricsCollector) {
            return await this.metricsCollector.getMetricsAsJson();
        }
        return {
            system: {
                cpu: os.loadavg()[0],
                memory: {
                    used: os.totalmem() - os.freemem(),
                    total: os.totalmem(),
                    percentage: ((os.totalmem() - os.freemem()) / os.totalmem()) * 100
                }
            }
        };
    }
    /**
     * Get performance summary
     */
    getPerformanceSummary() {
        const uptime = Date.now() - this.performanceMetrics.lastReset.getTime();
        const avgResponseTime = this.performanceMetrics.requestCount > 0
            ? this.performanceMetrics.totalResponseTime / this.performanceMetrics.requestCount
            : 0;
        const errorRate = this.performanceMetrics.requestCount > 0
            ? (this.performanceMetrics.errorCount / this.performanceMetrics.requestCount) * 100
            : 0;
        return {
            uptime,
            requestCount: this.performanceMetrics.requestCount,
            avgResponseTime,
            errorRate,
            errorCount: this.performanceMetrics.errorCount,
            alerts: Array.from(this.alerts.values()).map(a => ({
                name: a.rule.name,
                severity: a.rule.severity,
                triggered: a.triggered,
                count: a.count
            }))
        };
    }
    /**
     * Reset performance metrics
     */
    resetMetrics() {
        this.performanceMetrics = {
            requestCount: 0,
            totalResponseTime: 0,
            errorCount: 0,
            lastReset: new Date()
        };
        this.emit('metrics:reset');
    }
    /**
     * Shutdown observability
     */
    async shutdown() {
        // Stop profiling
        if (this.profilingInterval) {
            clearInterval(this.profilingInterval);
        }
        // Shutdown tracing
        if (this.distributedTracing) {
            await this.distributedTracing.shutdown();
        }
        // Shutdown telemetry
        if (this.telemetryService) {
            await this.telemetryService.shutdown();
        }
        // Cleanup metrics
        if (this.metricsCollector) {
            this.metricsCollector.dispose();
        }
        this.removeAllListeners();
        this.logger.info('Observability Manager shut down');
    }
}
// Singleton instance
let observabilityManager = null;
export function initializeObservability(config) {
    if (!observabilityManager) {
        observabilityManager = new ObservabilityManager(config);
    }
    return observabilityManager;
}
export function getObservability() {
    return observabilityManager;
}
export default ObservabilityManager;
//# sourceMappingURL=ObservabilityManager.js.map