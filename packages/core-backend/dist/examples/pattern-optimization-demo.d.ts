/**
 * Pattern Optimization Demo
 * Issue #28: Demonstrates Trie-based pattern matching performance improvements
 */
export declare class PatternOptimizationDemo {
    private patternManager;
    private callbacks;
    constructor();
    /**
     * Set up mock callbacks for different patterns
     */
    private setupCallbacks;
    /**
     * Benchmark: Compare performance with and without Trie optimization
     */
    performanceBenchmark(): Promise<void>;
    /**
     * Generate test patterns for benchmarking
     */
    private generateTestPatterns;
    /**
     * Generate test topics for benchmarking
     */
    private generateTestTopics;
    /**
     * Benchmark Trie-based implementation
     */
    private benchmarkTrieImplementation;
    /**
     * Display benchmark results
     */
    private displayBenchmarkResults;
    /**
     * Demonstrate different pattern types
     */
    patternTypesDemo(): Promise<void>;
    /**
     * Demonstrate caching performance
     */
    cachingDemo(): Promise<void>;
    /**
     * Demonstrate memory usage optimization
     */
    memoryOptimizationDemo(): Promise<void>;
    /**
     * Demonstrate real-world usage scenarios
     */
    realWorldScenariosDemo(): Promise<void>;
    /**
     * Run all demonstrations
     */
    runAllDemos(): Promise<void>;
    /**
     * Cleanup resources
     */
    cleanup(): Promise<void>;
}
//# sourceMappingURL=pattern-optimization-demo.d.ts.map