"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CircuitBreaker = exports.CircuitState = void 0;
exports.createCircuitBreaker = createCircuitBreaker;
exports.createStrictCircuitBreaker = createStrictCircuitBreaker;
exports.createModerateCircuitBreaker = createModerateCircuitBreaker;
exports.createRelaxedCircuitBreaker = createRelaxedCircuitBreaker;
const events_1 = require("events");
var CircuitState;
(function (CircuitState) {
    CircuitState["CLOSED"] = "CLOSED";
    CircuitState["OPEN"] = "OPEN";
    CircuitState["HALF_OPEN"] = "HALF_OPEN";
})(CircuitState || (exports.CircuitState = CircuitState = {}));
class CircuitBreaker extends events_1.EventEmitter {
    config;
    state = CircuitState.CLOSED;
    stateChangedAt = new Date();
    nextAttempt;
    requestWindow = [];
    halfOpenRequests = 0;
    metrics;
    constructor(config = {}) {
        super();
        this.config = {
            timeout: config.timeout || 10000,
            errorThreshold: config.errorThreshold || 50,
            resetTimeout: config.resetTimeout || 60000,
            volumeThreshold: config.volumeThreshold || 10,
            windowSize: config.windowSize || 10000,
            halfOpenRequests: config.halfOpenRequests || 3
        };
        this.metrics = {
            requests: 0,
            successes: 0,
            failures: 0,
            timeouts: 0,
            shortCircuits: 0,
            latencies: [],
            state: this.state,
            stateChangedAt: this.stateChangedAt
        };
        // Clean up old records periodically
        setInterval(() => this.cleanupWindow(), 1000);
    }
    async execute(fn) {
        // Check if circuit is open
        if (this.state === CircuitState.OPEN) {
            if (!this.shouldAttemptReset()) {
                this.metrics.shortCircuits++;
                this.emit('shortCircuit');
                throw new Error('Circuit breaker is open');
            }
            // Transition to half-open
            this.transitionTo(CircuitState.HALF_OPEN);
        }
        // Check half-open limit
        if (this.state === CircuitState.HALF_OPEN) {
            if (this.halfOpenRequests >= this.config.halfOpenRequests) {
                this.metrics.shortCircuits++;
                this.emit('shortCircuit');
                throw new Error('Circuit breaker is half-open, max requests reached');
            }
            this.halfOpenRequests++;
        }
        // Execute with timeout
        const start = Date.now();
        let timer;
        try {
            const result = await Promise.race([
                fn(),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error('Request timeout')), this.config.timeout);
                })
            ]);
            const latency = Date.now() - start;
            this.recordSuccess(latency);
            return result;
        }
        catch (error) {
            const latency = Date.now() - start;
            this.recordFailure(latency, error);
            throw error;
        }
        finally {
            if (timer) {
                clearTimeout(timer);
            }
            if (this.state === CircuitState.HALF_OPEN) {
                this.halfOpenRequests--;
            }
        }
    }
    recordSuccess(latency) {
        const record = {
            timestamp: new Date(),
            success: true,
            latency
        };
        this.requestWindow.push(record);
        this.metrics.requests++;
        this.metrics.successes++;
        this.metrics.latencies.push(latency);
        // Update state based on success
        if (this.state === CircuitState.HALF_OPEN) {
            const recentMetrics = this.getRecentMetrics();
            if (recentMetrics.errorRate < this.config.errorThreshold) {
                this.transitionTo(CircuitState.CLOSED);
            }
        }
        this.emit('success', { latency });
    }
    recordFailure(latency, error) {
        const record = {
            timestamp: new Date(),
            success: false,
            latency,
            error
        };
        this.requestWindow.push(record);
        this.metrics.requests++;
        this.metrics.failures++;
        this.metrics.latencies.push(latency);
        if (error.message === 'Request timeout') {
            this.metrics.timeouts++;
        }
        // Update state based on failure
        const recentMetrics = this.getRecentMetrics();
        if (this.state === CircuitState.CLOSED &&
            recentMetrics.totalRequests >= this.config.volumeThreshold &&
            recentMetrics.errorRate >= this.config.errorThreshold) {
            this.transitionTo(CircuitState.OPEN);
        }
        else if (this.state === CircuitState.HALF_OPEN) {
            // Immediate open on failure in half-open state
            this.transitionTo(CircuitState.OPEN);
        }
        this.emit('failure', { latency, error });
    }
    transitionTo(newState) {
        if (this.state === newState)
            return;
        const oldState = this.state;
        this.state = newState;
        this.stateChangedAt = new Date();
        this.metrics.state = newState;
        this.metrics.stateChangedAt = this.stateChangedAt;
        // Reset half-open counter
        if (newState !== CircuitState.HALF_OPEN) {
            this.halfOpenRequests = 0;
        }
        // Set next attempt time for open state
        if (newState === CircuitState.OPEN) {
            this.nextAttempt = new Date(Date.now() + this.config.resetTimeout);
            this.metrics.nextAttempt = this.nextAttempt;
        }
        else {
            this.nextAttempt = undefined;
            this.metrics.nextAttempt = undefined;
        }
        this.emit('stateChange', { from: oldState, to: newState });
    }
    shouldAttemptReset() {
        if (!this.nextAttempt)
            return false;
        return new Date() >= this.nextAttempt;
    }
    getRecentMetrics() {
        const now = Date.now();
        const windowStart = now - this.config.windowSize;
        const recentRequests = this.requestWindow.filter(record => record.timestamp.getTime() >= windowStart);
        const totalRequests = recentRequests.length;
        const failures = recentRequests.filter(r => !r.success).length;
        const errorRate = totalRequests > 0 ? (failures / totalRequests) * 100 : 0;
        return { totalRequests, failures, errorRate };
    }
    cleanupWindow() {
        const now = Date.now();
        const windowStart = now - this.config.windowSize;
        this.requestWindow = this.requestWindow.filter(record => record.timestamp.getTime() >= windowStart);
        // Keep only recent latencies (last 1000)
        if (this.metrics.latencies.length > 1000) {
            this.metrics.latencies = this.metrics.latencies.slice(-1000);
        }
    }
    // Public API
    getState() {
        return this.state;
    }
    getMetrics() {
        return { ...this.metrics };
    }
    getStats() {
        const recent = this.getRecentMetrics();
        const averageLatency = this.metrics.latencies.length > 0
            ? this.metrics.latencies.reduce((a, b) => a + b, 0) / this.metrics.latencies.length
            : 0;
        return {
            state: this.state,
            errorRate: recent.errorRate,
            averageLatency,
            totalRequests: this.metrics.requests,
            recentRequests: recent.totalRequests
        };
    }
    reset() {
        this.transitionTo(CircuitState.CLOSED);
        this.requestWindow = [];
        this.halfOpenRequests = 0;
        this.metrics = {
            requests: 0,
            successes: 0,
            failures: 0,
            timeouts: 0,
            shortCircuits: 0,
            latencies: [],
            state: this.state,
            stateChangedAt: this.stateChangedAt
        };
        this.emit('reset');
    }
    forceOpen() {
        this.transitionTo(CircuitState.OPEN);
    }
    forceClose() {
        this.transitionTo(CircuitState.CLOSED);
    }
    isOpen() {
        return this.state === CircuitState.OPEN && !this.shouldAttemptReset();
    }
    isClosed() {
        return this.state === CircuitState.CLOSED;
    }
    isHalfOpen() {
        return this.state === CircuitState.HALF_OPEN;
    }
}
exports.CircuitBreaker = CircuitBreaker;
// Factory functions
function createCircuitBreaker(config) {
    return new CircuitBreaker(config);
}
function createStrictCircuitBreaker() {
    return new CircuitBreaker({
        errorThreshold: 25, // Open at 25% error rate
        volumeThreshold: 20, // Need 20 requests minimum
        resetTimeout: 60000, // 1 minute reset
        timeout: 5000 // 5 second timeout
    });
}
function createModerateCircuitBreaker() {
    return new CircuitBreaker({
        errorThreshold: 50, // Open at 50% error rate
        volumeThreshold: 10, // Need 10 requests minimum
        resetTimeout: 30000, // 30 second reset
        timeout: 10000 // 10 second timeout
    });
}
function createRelaxedCircuitBreaker() {
    return new CircuitBreaker({
        errorThreshold: 75, // Open at 75% error rate
        volumeThreshold: 5, // Need 5 requests minimum
        resetTimeout: 15000, // 15 second reset
        timeout: 30000 // 30 second timeout
    });
}
//# sourceMappingURL=CircuitBreaker.js.map