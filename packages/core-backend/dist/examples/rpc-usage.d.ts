/**
 * RPC Manager Usage Examples
 * Issues #27 & #30: Demonstrates proper RPC usage patterns
 */
export declare class RPCExamples {
    private rpcManager;
    constructor();
    /**
     * Set up message handling for demonstration
     */
    private setupMessageHandling;
    /**
     * Example 1: Simple RPC call
     */
    simpleRPCCall(): Promise<void>;
    /**
     * Example 2: RPC with custom timeout
     */
    customTimeoutCall(): Promise<void>;
    /**
     * Example 3: RPC with retry logic
     */
    retryExample(): Promise<void>;
    /**
     * Example 4: Handling different error types
     */
    errorHandlingExample(): Promise<void>;
    /**
     * Example 5: Circuit breaker demonstration
     */
    circuitBreakerExample(): Promise<void>;
    /**
     * Example 6: Bulk operations with proper error handling
     */
    bulkOperationsExample(): Promise<void>;
    /**
     * Example 7: Resource monitoring
     */
    resourceMonitoringExample(): Promise<void>;
    /**
     * Simulate different responses for demonstration
     */
    private simulateResponse;
    /**
     * Run all examples
     */
    runAllExamples(): Promise<void>;
    /**
     * Cleanup
     */
    cleanup(): Promise<void>;
}
//# sourceMappingURL=rpc-usage.d.ts.map