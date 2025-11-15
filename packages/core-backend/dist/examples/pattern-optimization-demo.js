"use strict";
/**
 * Pattern Optimization Demo
 * Issue #28: Demonstrates Trie-based pattern matching performance improvements
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PatternOptimizationDemo = void 0;
const pattern_manager_1 = require("../messaging/pattern-manager");
// Mock implementations for demonstration
const logger = {
    debug: (msg) => console.log(`[DEBUG] ${msg}`),
    info: (msg) => console.log(`[INFO] ${msg}`),
    warn: (msg) => console.log(`[WARN] ${msg}`),
    error: (msg) => console.log(`[ERROR] ${msg}`)
};
const metrics = {
    increment: (name, labels) => console.log(`[METRIC] ${name}`, labels),
    histogram: (name, value, labels) => console.log(`[METRIC] ${name}: ${value}ms`, labels),
    gauge: (name, value, labels) => console.log(`[METRIC] ${name}: ${value}`, labels)
};
class PatternOptimizationDemo {
    patternManager;
    callbacks = new Map();
    constructor() {
        this.patternManager = new pattern_manager_1.PatternManager(logger, metrics, {
            enableMetrics: true,
            optimizationMode: 'speed',
            maxPatterns: 50000,
            cleanupIntervalMs: 60000
        });
        this.setupCallbacks();
    }
    /**
     * Set up mock callbacks for different patterns
     */
    setupCallbacks() {
        const patterns = [
            'user.*',
            'admin.*',
            '*.login',
            '*.logout',
            'system.*.event',
            'notification.*.sent',
            'workflow.*.completed',
            'data.*.updated'
        ];
        patterns.forEach(pattern => {
            this.callbacks.set(pattern, (topic, message) => {
                console.log(`📬 ${pattern} callback: ${topic}`, message);
            });
        });
    }
    /**
     * Benchmark: Compare performance with and without Trie optimization
     */
    async performanceBenchmark() {
        console.log('\n=== Performance Benchmark ===');
        // Setup patterns
        const patterns = this.generateTestPatterns(10000);
        const topics = this.generateTestTopics(1000);
        console.log(`Testing with ${patterns.length} patterns and ${topics.length} topics`);
        // Benchmark Trie-based implementation
        const trieResults = await this.benchmarkTrieImplementation(patterns, topics);
        // Display results
        this.displayBenchmarkResults(trieResults);
    }
    /**
     * Generate test patterns for benchmarking
     */
    generateTestPatterns(count) {
        const patterns = [];
        const categories = ['user', 'admin', 'system', 'notification', 'workflow', 'data', 'event', 'log'];
        const actions = ['create', 'update', 'delete', 'read', 'login', 'logout', 'send', 'receive'];
        for (let i = 0; i < count; i++) {
            const category = categories[i % categories.length];
            const action = actions[i % actions.length];
            if (i % 4 === 0) {
                patterns.push(`${category}.*`); // Prefix pattern
            }
            else if (i % 4 === 1) {
                patterns.push(`*.${action}`); // Suffix pattern
            }
            else if (i % 4 === 2) {
                patterns.push(`${category}.${action}.${i}`); // Exact pattern
            }
            else {
                patterns.push(`${category}.*.${action}`); // Complex pattern
            }
        }
        return patterns;
    }
    /**
     * Generate test topics for benchmarking
     */
    generateTestTopics(count) {
        const topics = [];
        const categories = ['user', 'admin', 'system', 'notification', 'workflow', 'data', 'event', 'log'];
        const actions = ['create', 'update', 'delete', 'read', 'login', 'logout', 'send', 'receive'];
        const entities = ['profile', 'session', 'document', 'email', 'task', 'report'];
        for (let i = 0; i < count; i++) {
            const category = categories[i % categories.length];
            const action = actions[i % actions.length];
            const entity = entities[i % entities.length];
            topics.push(`${category}.${entity}.${action}`);
        }
        return topics;
    }
    /**
     * Benchmark Trie-based implementation
     */
    async benchmarkTrieImplementation(patterns, topics) {
        const manager = new pattern_manager_1.PatternManager(logger, metrics, {
            enableMetrics: false,
            optimizationMode: 'speed'
        });
        // Subscription phase
        const subscribeStart = process.hrtime.bigint();
        patterns.forEach(pattern => {
            manager.subscribe(pattern, this.callbacks.get(pattern) || (() => { }));
        });
        const subscribeTime = Number(process.hrtime.bigint() - subscribeStart) / 1_000_000;
        // Matching phase
        const matchStart = process.hrtime.bigint();
        let totalMatches = 0;
        topics.forEach(topic => {
            const result = manager.findMatches(topic);
            totalMatches += result.subscriptions.length;
        });
        const matchTime = Number(process.hrtime.bigint() - matchStart) / 1_000_000;
        // Publishing phase
        const publishStart = process.hrtime.bigint();
        let totalPublished = 0;
        for (const topic of topics.slice(0, 100)) { // Test first 100 topics
            const count = await manager.publish(topic, { test: 'data' });
            totalPublished += count;
        }
        const publishTime = Number(process.hrtime.bigint() - publishStart) / 1_000_000;
        const stats = manager.getStats();
        await manager.shutdown();
        return {
            subscribeTime,
            matchTime,
            publishTime,
            totalMatches,
            totalPublished,
            memoryUsage: stats.trie.memoryUsage,
            cacheSize: stats.cache.size
        };
    }
    /**
     * Display benchmark results
     */
    displayBenchmarkResults(results) {
        console.log('\n📊 Trie Implementation Results:');
        console.log(`  Subscribe Time: ${results.subscribeTime.toFixed(2)}ms`);
        console.log(`  Match Time: ${results.matchTime.toFixed(2)}ms`);
        console.log(`  Publish Time: ${results.publishTime.toFixed(2)}ms`);
        console.log(`  Total Matches Found: ${results.totalMatches}`);
        console.log(`  Total Published: ${results.totalPublished}`);
        console.log(`  Memory Usage: ${(results.memoryUsage / 1024).toFixed(2)}KB`);
        console.log(`  Cache Size: ${results.cacheSize}`);
        console.log('\n🚀 Performance Summary:');
        console.log(`  Average Match Time: ${(results.matchTime / 1000).toFixed(4)}ms per topic`);
        console.log(`  Matches per Second: ${Math.round(1000 / (results.matchTime / 1000))}`);
        console.log(`  Memory per Pattern: ${(results.memoryUsage / 10000).toFixed(2)} bytes`);
    }
    /**
     * Demonstrate different pattern types
     */
    async patternTypesDemo() {
        console.log('\n=== Pattern Types Demonstration ===');
        // Subscribe to different pattern types
        const patterns = [
            { pattern: 'user.login', type: 'Exact Match' },
            { pattern: 'user.*', type: 'Prefix Wildcard' },
            { pattern: '*.login', type: 'Suffix Wildcard' },
            { pattern: 'system.*.event', type: 'Complex Wildcard' },
            { pattern: 'notification.email.*', type: 'Nested Prefix' },
            { pattern: '*.workflow.completed', type: 'Nested Suffix' }
        ];
        patterns.forEach(({ pattern, type }) => {
            this.patternManager.subscribe(pattern, (topic, message) => {
                console.log(`  🎯 ${type} (${pattern}) matched: ${topic}`);
            }, { type });
        });
        // Test topics
        const testTopics = [
            'user.login',
            'user.profile.update',
            'admin.login',
            'system.auth.event',
            'notification.email.sent',
            'background.workflow.completed',
            'data.export.started'
        ];
        console.log('\nTesting topics:');
        for (const topic of testTopics) {
            console.log(`\n📡 Publishing to: ${topic}`);
            await this.patternManager.publish(topic, { timestamp: new Date().toISOString() });
        }
    }
    /**
     * Demonstrate caching performance
     */
    async cachingDemo() {
        console.log('\n=== Caching Performance Demo ===');
        // Subscribe to patterns
        this.patternManager.subscribe('cache.*', (topic, message) => {
            console.log(`  📋 Cache pattern matched: ${topic}`);
        });
        const testTopic = 'cache.performance.test';
        // First match - should not be cached
        console.log('\n🔍 First match (cold):');
        const result1 = this.patternManager.findMatches(testTopic);
        console.log(`  Match time: ${result1.matchTime.toFixed(4)}ms, Cache hit: ${result1.cacheHit}`);
        // Second match - should be cached
        console.log('\n🔍 Second match (cached):');
        const result2 = this.patternManager.findMatches(testTopic);
        console.log(`  Match time: ${result2.matchTime.toFixed(4)}ms, Cache hit: ${result2.cacheHit}`);
        // Performance improvement
        const improvement = ((result1.matchTime - result2.matchTime) / result1.matchTime * 100);
        console.log(`\n🚀 Cache Performance Improvement: ${improvement.toFixed(1)}%`);
    }
    /**
     * Demonstrate memory usage optimization
     */
    async memoryOptimizationDemo() {
        console.log('\n=== Memory Optimization Demo ===');
        const initialStats = this.patternManager.getStats();
        console.log(`Initial memory usage: ${(initialStats.trie.memoryUsage / 1024).toFixed(2)}KB`);
        // Add many patterns
        console.log('\nAdding 1000 patterns...');
        for (let i = 0; i < 1000; i++) {
            this.patternManager.subscribe(`memory.test.${i % 10}.*`, () => { });
        }
        const afterPatternsStats = this.patternManager.getStats();
        console.log(`After patterns: ${(afterPatternsStats.trie.memoryUsage / 1024).toFixed(2)}KB`);
        // Test matching with many patterns
        const matchStart = process.hrtime.bigint();
        for (let i = 0; i < 100; i++) {
            this.patternManager.findMatches(`memory.test.${i % 10}.action`);
        }
        const matchTime = Number(process.hrtime.bigint() - matchStart) / 1_000_000;
        console.log(`100 matches with 1000 patterns: ${matchTime.toFixed(2)}ms`);
        console.log(`Average per match: ${(matchTime / 100).toFixed(4)}ms`);
        const finalStats = this.patternManager.getStats();
        console.log(`Final stats:`);
        console.log(`  Patterns: ${finalStats.trie.totalSubscriptions}`);
        console.log(`  Memory: ${(finalStats.trie.memoryUsage / 1024).toFixed(2)}KB`);
        console.log(`  Cache size: ${finalStats.cache.size}`);
        console.log(`  Cache hit rate: ${(finalStats.cache.hitRate * 100).toFixed(1)}%`);
    }
    /**
     * Demonstrate real-world usage scenarios
     */
    async realWorldScenariosDemo() {
        console.log('\n=== Real-World Scenarios Demo ===');
        // User activity monitoring
        console.log('\n📱 User Activity Monitoring:');
        this.patternManager.subscribe('user.*.login', (topic, data) => {
            console.log(`  🔐 User login detected: ${topic}`, data);
        });
        this.patternManager.subscribe('user.*.logout', (topic, data) => {
            console.log(`  🚪 User logout detected: ${topic}`, data);
        });
        await this.patternManager.publish('user.john.login', { userId: 'john', timestamp: new Date() });
        await this.patternManager.publish('user.jane.logout', { userId: 'jane', session: '123' });
        // System monitoring
        console.log('\n🖥️ System Monitoring:');
        this.patternManager.subscribe('system.*.error', (topic, data) => {
            console.log(`  ❌ System error: ${topic}`, data);
        });
        this.patternManager.subscribe('system.*.warning', (topic, data) => {
            console.log(`  ⚠️ System warning: ${topic}`, data);
        });
        await this.patternManager.publish('system.database.error', { error: 'Connection timeout' });
        await this.patternManager.publish('system.memory.warning', { usage: '85%' });
        // Workflow automation
        console.log('\n⚙️ Workflow Automation:');
        this.patternManager.subscribe('workflow.*.completed', (topic, data) => {
            console.log(`  ✅ Workflow completed: ${topic}`, data);
        });
        this.patternManager.subscribe('workflow.approval.*', (topic, data) => {
            console.log(`  📋 Approval workflow: ${topic}`, data);
        });
        await this.patternManager.publish('workflow.data-export.completed', { jobId: 'export-123' });
        await this.patternManager.publish('workflow.approval.submitted', { requestId: 'req-456' });
    }
    /**
     * Run all demonstrations
     */
    async runAllDemos() {
        console.log('🎯 Pattern Optimization Demo Starting...\n');
        try {
            await this.patternTypesDemo();
            await this.cachingDemo();
            await this.memoryOptimizationDemo();
            await this.realWorldScenariosDemo();
            await this.performanceBenchmark();
            console.log('\n✨ All demonstrations completed successfully!');
        }
        catch (error) {
            console.error('❌ Demo execution failed:', error);
        }
    }
    /**
     * Cleanup resources
     */
    async cleanup() {
        await this.patternManager.shutdown();
        console.log('\n🧹 Cleanup completed');
    }
}
exports.PatternOptimizationDemo = PatternOptimizationDemo;
// Direct execution example
if (require.main === module) {
    const demo = new PatternOptimizationDemo();
    demo.runAllDemos()
        .then(() => demo.cleanup())
        .then(() => {
        console.log('\n🏁 Pattern optimization demo finished!');
        process.exit(0);
    })
        .catch((error) => {
        console.error('❌ Demo failed:', error);
        process.exit(1);
    });
}
//# sourceMappingURL=pattern-optimization-demo.js.map