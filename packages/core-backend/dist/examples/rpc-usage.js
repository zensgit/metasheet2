"use strict";
/**
 * RPC Manager Usage Examples
 * Issues #27 & #30: Demonstrates proper RPC usage patterns
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RPCExamples = void 0;
const rpc_manager_1 = require("../messaging/rpc-manager");
const rpc_error_handler_1 = require("../messaging/rpc-error-handler");
// Mock implementations for demonstration
const logger = {
    debug: (msg) => console.log(`[DEBUG] ${msg}`),
    info: (msg) => console.log(`[INFO] ${msg}`),
    warn: (msg) => console.log(`[WARN] ${msg}`),
    error: (msg) => console.log(`[ERROR] ${msg}`)
};
const metrics = {
    increment: (name, labels) => console.log(`[METRIC] ${name}`, labels),
    histogram: (name, value, labels) => console.log(`[METRIC] ${name}: ${value}`, labels),
    gauge: (name, value, labels) => console.log(`[METRIC] ${name}: ${value}`, labels)
};
class RPCExamples {
    rpcManager;
    constructor() {
        this.rpcManager = new rpc_manager_1.RPCManager(logger, metrics, {
            defaultTimeoutMs: 5000,
            maxRetries: 3,
            cleanupIntervalMs: 30000,
            circuitBreakerThreshold: 5,
            circuitBreakerResetMs: 60000
        });
        this.setupMessageHandling();
    }
    /**
     * Set up message handling for demonstration
     */
    setupMessageHandling() {
        this.rpcManager.on('rpc:request', (request) => {
            // Simulate different responses based on topic
            this.simulateResponse(request);
        });
        this.rpcManager.on('rpc:timeout', (data) => {
            logger.warn(`RPC timeout occurred: ${data.topic}`);
        });
        this.rpcManager.on('rpc:unsubscribe', (data) => {
            logger.debug(`Unsubscribed from RPC: ${data.topic}`);
        });
    }
    /**
     * Example 1: Simple RPC call
     */
    async simpleRPCCall() {
        console.log('\n=== Example 1: Simple RPC Call ===');
        try {
            const result = await this.rpcManager.request('user.get', {
                userId: '12345'
            });
            console.log('✅ User data received:', result);
        }
        catch (error) {
            console.error('❌ RPC call failed:', rpc_error_handler_1.RPCErrorHandler.getErrorMessage(error));
        }
    }
    /**
     * Example 2: RPC with custom timeout
     */
    async customTimeoutCall() {
        console.log('\n=== Example 2: Custom Timeout ===');
        try {
            const result = await this.rpcManager.request('data.export', { format: 'csv', records: 10000 }, { timeoutMs: 30000 } // 30 second timeout for large export
            );
            console.log('✅ Export completed:', result);
        }
        catch (error) {
            console.error('❌ Export failed:', rpc_error_handler_1.RPCErrorHandler.getErrorMessage(error));
        }
    }
    /**
     * Example 3: RPC with retry logic
     */
    async retryExample() {
        console.log('\n=== Example 3: Retry Logic ===');
        try {
            const result = await this.rpcManager.request('service.unstable', { action: 'process' }, { retries: 5, timeoutMs: 2000 });
            console.log('✅ Eventually succeeded:', result);
        }
        catch (error) {
            console.error('❌ Failed after retries:', rpc_error_handler_1.RPCErrorHandler.getErrorMessage(error));
        }
    }
    /**
     * Example 4: Handling different error types
     */
    async errorHandlingExample() {
        console.log('\n=== Example 4: Error Handling ===');
        const testCases = [
            { topic: 'auth.validate', data: { token: 'invalid' } },
            { topic: 'data.validate', data: { invalid: 'data' } },
            { topic: 'service.unavailable', data: {} },
            { topic: 'network.timeout', data: {} }
        ];
        for (const testCase of testCases) {
            try {
                const result = await this.rpcManager.request(testCase.topic, testCase.data);
                console.log(`✅ ${testCase.topic} succeeded:`, result);
            }
            catch (error) {
                const rpcError = rpc_error_handler_1.RPCErrorHandler.wrapError(error, {
                    topic: testCase.topic,
                    requestId: 'demo-' + Date.now()
                });
                console.log(`❌ ${testCase.topic} failed:`);
                console.log(`   Code: ${rpcError.code}`);
                console.log(`   Message: ${rpcError.message}`);
                console.log(`   Retriable: ${rpcError.retriable}`);
                console.log(`   User Message: ${rpc_error_handler_1.RPCErrorHandler.formatUserMessage(rpcError)}`);
            }
        }
    }
    /**
     * Example 5: Circuit breaker demonstration
     */
    async circuitBreakerExample() {
        console.log('\n=== Example 5: Circuit Breaker ===');
        // Trigger multiple failures to open circuit breaker
        console.log('Triggering failures to open circuit breaker...');
        for (let i = 0; i < 6; i++) {
            try {
                await this.rpcManager.request('service.failing', { attempt: i }, { retries: 0 });
            }
            catch (error) {
                // Expected failures
            }
        }
        // Next call should be rejected by circuit breaker
        try {
            await this.rpcManager.request('service.failing', { attempt: 'after-breach' });
        }
        catch (error) {
            console.log('❌ Circuit breaker rejection:', error.message);
        }
        console.log('Circuit breaker stats:', this.rpcManager.getStats().circuitBreakers);
    }
    /**
     * Example 6: Bulk operations with proper error handling
     */
    async bulkOperationsExample() {
        console.log('\n=== Example 6: Bulk Operations ===');
        const operations = [
            { id: 'op1', topic: 'user.create', data: { name: 'Alice' } },
            { id: 'op2', topic: 'user.create', data: { name: 'Bob' } },
            { id: 'op3', topic: 'user.create', data: { invalid: 'data' } }, // This will fail
            { id: 'op4', topic: 'user.create', data: { name: 'Charlie' } }
        ];
        const results = await Promise.allSettled(operations.map(op => this.rpcManager.request(op.topic, op.data).then(result => ({ id: op.id, success: true, result }), error => ({
            id: op.id,
            success: false,
            error: rpc_error_handler_1.RPCErrorHandler.wrapError(error).toJSON()
        }))));
        results.forEach((result, index) => {
            const op = operations[index];
            if (result.status === 'fulfilled') {
                const data = result.value;
                if (data.success) {
                    console.log(`✅ ${op.id}: Success`);
                }
                else {
                    console.log(`❌ ${op.id}: ${data.error.message}`);
                }
            }
        });
    }
    /**
     * Example 7: Resource monitoring
     */
    async resourceMonitoringExample() {
        console.log('\n=== Example 7: Resource Monitoring ===');
        // Start several concurrent requests
        const concurrentRequests = Array.from({ length: 5 }, (_, i) => this.rpcManager.request('data.process', { batch: i })
            .catch(error => ({ error: error.message })));
        // Monitor resources during execution
        const monitorInterval = setInterval(() => {
            const stats = this.rpcManager.getStats();
            console.log('📊 Current resources:', {
                activeRequests: stats.activeRequests,
                activeSubscriptions: stats.activeSubscriptions,
                cachedResponses: stats.cachedResponses
            });
        }, 500);
        // Wait for all requests to complete
        await Promise.all(concurrentRequests);
        clearInterval(monitorInterval);
        // Final stats
        const finalStats = this.rpcManager.getStats();
        console.log('📊 Final stats:', finalStats);
    }
    /**
     * Simulate different responses for demonstration
     */
    simulateResponse(request) {
        setTimeout(() => {
            switch (request.topic) {
                case 'user.get':
                    this.rpcManager.handleResponse(request.id, {
                        id: '12345',
                        name: 'John Doe',
                        email: 'john@example.com'
                    });
                    break;
                case 'data.export':
                    this.rpcManager.handleResponse(request.id, {
                        url: '/exports/data_2024.csv',
                        records: 10000,
                        size: '2.5MB'
                    });
                    break;
                case 'service.unstable':
                    // 70% chance of success
                    if (Math.random() > 0.3) {
                        this.rpcManager.handleResponse(request.id, { status: 'processed' });
                    }
                    else {
                        const error = new Error('Service temporarily unavailable');
                        error.code = 'SERVICE_UNAVAILABLE';
                        this.rpcManager.handleResponse(request.id, null, error);
                    }
                    break;
                case 'auth.validate':
                    const authError = new rpc_error_handler_1.RPCError({
                        code: rpc_error_handler_1.RPCErrorCode.UNAUTHORIZED,
                        message: 'Invalid token'
                    });
                    this.rpcManager.handleResponse(request.id, null, authError);
                    break;
                case 'data.validate':
                    const validationError = new rpc_error_handler_1.RPCError({
                        code: rpc_error_handler_1.RPCErrorCode.VALIDATION_ERROR,
                        message: 'Invalid data format',
                        details: { field: 'name', message: 'Name is required' }
                    });
                    this.rpcManager.handleResponse(request.id, null, validationError);
                    break;
                case 'service.unavailable':
                    const unavailableError = new rpc_error_handler_1.RPCError({
                        code: rpc_error_handler_1.RPCErrorCode.SERVICE_UNAVAILABLE,
                        message: 'Service is down for maintenance'
                    });
                    this.rpcManager.handleResponse(request.id, null, unavailableError);
                    break;
                case 'network.timeout':
                    // Don't respond - will cause timeout
                    break;
                case 'service.failing':
                    const failError = new Error('Simulated failure');
                    this.rpcManager.handleResponse(request.id, null, failError);
                    break;
                case 'user.create':
                    if (request.payload.invalid) {
                        const createError = new rpc_error_handler_1.RPCError({
                            code: rpc_error_handler_1.RPCErrorCode.VALIDATION_ERROR,
                            message: 'Invalid user data'
                        });
                        this.rpcManager.handleResponse(request.id, null, createError);
                    }
                    else {
                        this.rpcManager.handleResponse(request.id, {
                            id: 'user-' + Date.now(),
                            name: request.payload.name,
                            created: true
                        });
                    }
                    break;
                case 'data.process':
                    // Simulate processing time
                    setTimeout(() => {
                        this.rpcManager.handleResponse(request.id, {
                            batch: request.payload.batch,
                            processed: true
                        });
                    }, Math.random() * 1000);
                    break;
                default:
                    this.rpcManager.handleResponse(request.id, {
                        echo: request.payload,
                        timestamp: new Date().toISOString()
                    });
            }
        }, Math.random() * 100 + 10); // Random delay 10-110ms
    }
    /**
     * Run all examples
     */
    async runAllExamples() {
        console.log('🚀 Starting RPC Manager Examples...\n');
        try {
            await this.simpleRPCCall();
            await this.customTimeoutCall();
            await this.retryExample();
            await this.errorHandlingExample();
            await this.circuitBreakerExample();
            await this.bulkOperationsExample();
            await this.resourceMonitoringExample();
        }
        catch (error) {
            console.error('Example execution failed:', error);
        }
        console.log('\n✨ All examples completed!');
    }
    /**
     * Cleanup
     */
    async cleanup() {
        await this.rpcManager.shutdown();
    }
}
exports.RPCExamples = RPCExamples;
// Example usage
if (require.main === module) {
    const examples = new RPCExamples();
    examples.runAllExamples()
        .then(() => examples.cleanup())
        .then(() => {
        console.log('\n🏁 Examples finished successfully!');
        process.exit(0);
    })
        .catch((error) => {
        console.error('❌ Examples failed:', error);
        process.exit(1);
    });
}
//# sourceMappingURL=rpc-usage.js.map