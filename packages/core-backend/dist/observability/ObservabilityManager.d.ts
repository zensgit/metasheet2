/**
 * Unified Observability Manager
 * Integrates metrics, tracing, logging, and alerting into a single cohesive system
 */
import { EventEmitter } from 'eventemitter3';
import { Request, Response, NextFunction } from 'express';
export interface ObservabilityConfig {
    serviceName: string;
    environment: string;
    version: string;
    metrics?: {
        enabled: boolean;
        prometheusPort?: number;
        collectInterval?: number;
        customMetrics?: Array<{
            name: string;
            type: 'counter' | 'gauge' | 'histogram' | 'summary';
            help: string;
            labels?: string[];
        }>;
    };
    tracing?: {
        enabled: boolean;
        samplingRate?: number;
        jaegerEndpoint?: string;
        zipkinEndpoint?: string;
        propagators?: string[];
    };
    logging?: {
        enabled: boolean;
        level?: 'debug' | 'info' | 'warn' | 'error';
        format?: 'json' | 'text';
        output?: 'console' | 'file' | 'both';
        filePath?: string;
        maxFileSize?: number;
        maxFiles?: number;
        correlationIdHeader?: string;
    };
    alerting?: {
        enabled: boolean;
        rules?: AlertRule[];
        webhooks?: string[];
        emailRecipients?: string[];
        slackChannels?: string[];
    };
    profiling?: {
        enabled: boolean;
        cpuProfile?: boolean;
        heapSnapshot?: boolean;
        interval?: number;
    };
}
export interface AlertRule {
    name: string;
    condition: string;
    threshold: number;
    duration?: number;
    severity: 'info' | 'warning' | 'error' | 'critical';
    message: string;
    annotations?: Record<string, string>;
}
export interface HealthStatus {
    status: 'healthy' | 'degraded' | 'unhealthy';
    timestamp: Date;
    checks: {
        database: boolean;
        cache: boolean;
        queue: boolean;
        external: Record<string, boolean>;
    };
    metrics: {
        cpu: number;
        memory: number;
        responseTime: number;
        errorRate: number;
    };
}
export declare class ObservabilityManager extends EventEmitter {
    private config;
    private metricsCollector?;
    private distributedTracing?;
    private telemetryService?;
    private logger;
    private alerts;
    private healthChecks;
    private performanceMetrics;
    private profilingInterval?;
    constructor(config: ObservabilityConfig);
    /**
     * Initialize all observability components
     */
    private initialize;
    /**
     * Initialize metrics collection
     */
    private initializeMetrics;
    /**
     * Initialize distributed tracing
     */
    private initializeTracing;
    /**
     * Initialize telemetry service
     */
    private initializeTelemetry;
    /**
     * Initialize alerting system
     */
    private initializeAlerting;
    /**
     * Initialize performance profiling
     */
    private initializeProfiling;
    /**
     * Register default health checks
     */
    private registerDefaultHealthChecks;
    /**
     * Express middleware for observability
     */
    middleware(): (req: Request, res: Response, next: NextFunction) => Promise<void>;
    /**
     * Check alert rules
     */
    private checkAlertRules;
    /**
     * Evaluate alert condition
     */
    private evaluateCondition;
    /**
     * Trigger an alert
     */
    private triggerAlert;
    /**
     * Send alert notifications
     */
    private sendAlertNotifications;
    /**
     * Send webhook notification
     */
    private sendWebhookNotification;
    /**
     * Collect profiling data
     */
    private collectProfilingData;
    /**
     * Register a health check
     */
    registerHealthCheck(name: string, check: () => Promise<boolean>): void;
    /**
     * Get current health status
     */
    getHealthStatus(): Promise<HealthStatus>;
    /**
     * Get current metrics
     */
    getCurrentMetrics(): Promise<any>;
    /**
     * Get performance summary
     */
    getPerformanceSummary(): any;
    /**
     * Reset performance metrics
     */
    resetMetrics(): void;
    /**
     * Shutdown observability
     */
    shutdown(): Promise<void>;
}
export declare function initializeObservability(config: ObservabilityConfig): ObservabilityManager;
export declare function getObservability(): ObservabilityManager | null;
export default ObservabilityManager;
//# sourceMappingURL=ObservabilityManager.d.ts.map