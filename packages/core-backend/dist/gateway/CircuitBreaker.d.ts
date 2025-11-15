import { EventEmitter } from 'events';
export interface CircuitBreakerConfig {
    timeout?: number;
    errorThreshold?: number;
    resetTimeout?: number;
    volumeThreshold?: number;
    windowSize?: number;
    halfOpenRequests?: number;
}
export declare enum CircuitState {
    CLOSED = "CLOSED",
    OPEN = "OPEN",
    HALF_OPEN = "HALF_OPEN"
}
export interface CircuitMetrics {
    requests: number;
    successes: number;
    failures: number;
    timeouts: number;
    shortCircuits: number;
    latencies: number[];
    state: CircuitState;
    stateChangedAt: Date;
    nextAttempt?: Date;
}
export declare class CircuitBreaker extends EventEmitter {
    private config;
    private state;
    private stateChangedAt;
    private nextAttempt?;
    private requestWindow;
    private halfOpenRequests;
    private metrics;
    constructor(config?: CircuitBreakerConfig);
    execute<T>(fn: () => Promise<T>): Promise<T>;
    private recordSuccess;
    private recordFailure;
    private transitionTo;
    private shouldAttemptReset;
    private getRecentMetrics;
    private cleanupWindow;
    getState(): CircuitState;
    getMetrics(): CircuitMetrics;
    getStats(): {
        state: CircuitState;
        errorRate: number;
        averageLatency: number;
        totalRequests: number;
        recentRequests: number;
    };
    reset(): void;
    forceOpen(): void;
    forceClose(): void;
    isOpen(): boolean;
    isClosed(): boolean;
    isHalfOpen(): boolean;
}
export declare function createCircuitBreaker(config?: CircuitBreakerConfig): CircuitBreaker;
export declare function createStrictCircuitBreaker(): CircuitBreaker;
export declare function createModerateCircuitBreaker(): CircuitBreaker;
export declare function createRelaxedCircuitBreaker(): CircuitBreaker;
//# sourceMappingURL=CircuitBreaker.d.ts.map