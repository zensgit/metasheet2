/**
 * RPC Manager with Timeout Cleanup
 * Issues #27 & #30: RPC timeout cleanup and error handling
 */
import { EventEmitter } from 'events';
import { Logger } from '../core/logger';
import { CoreMetrics } from '../integration/metrics/metrics';
interface RPCConfig {
    defaultTimeoutMs?: number;
    maxRetries?: number;
    cleanupIntervalMs?: number;
    circuitBreakerThreshold?: number;
    circuitBreakerResetMs?: number;
}
export declare class RPCManager extends EventEmitter {
    private requests;
    private responses;
    private subscriptions;
    private cleanupTimer?;
    private circuitBreakers;
    private logger;
    private metrics;
    private config;
    constructor(logger: Logger, metrics: CoreMetrics, config?: RPCConfig);
    /**
     * Make an RPC request with timeout and retry logic
     */
    request(topic: string, payload: any, options?: {
        timeoutMs?: number;
        retries?: number;
        priority?: 'high' | 'normal' | 'low';
    }): Promise<any>;
    /**
     * Execute request with retry logic
     */
    private executeRequestWithRetry;
    /**
     * Execute a single RPC request
     */
    private executeRequest;
    /**
     * Handle RPC response
     */
    handleResponse(requestId: string, result?: any, error?: any): void;
    /**
     * Handle request timeout
     */
    private handleTimeout;
    /**
     * Clean up request and related resources
     */
    private cleanup;
    /**
     * Clean up subscription
     */
    private cleanupSubscription;
    /**
     * Periodic cleanup of stale requests
     */
    private startCleanupTimer;
    /**
     * Perform cleanup of stale requests and responses
     */
    private performCleanup;
    /**
     * Get timeout for specific topic
     */
    private getTimeoutForTopic;
    /**
     * Check if error is retriable
     */
    private isRetriableError;
    /**
     * Circuit breaker management
     */
    private getCircuitBreaker;
    private recordSuccess;
    private recordFailure;
    private resetCircuitBreakers;
    /**
     * Generate unique request ID
     */
    private generateRequestId;
    /**
     * Helper sleep function
     */
    private sleep;
    /**
     * Get statistics
     */
    getStats(): {
        activeRequests: number;
        cachedResponses: number;
        activeSubscriptions: number;
        circuitBreakers: Record<string, string>;
    };
    /**
     * Shutdown and cleanup
     */
    shutdown(): Promise<void>;
}
export {};
//# sourceMappingURL=rpc-manager.d.ts.map