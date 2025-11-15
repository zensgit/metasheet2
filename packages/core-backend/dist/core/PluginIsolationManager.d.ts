/**
 * Plugin Isolation Manager
 * Manages isolated execution environments for plugins with resource limits and monitoring
 */
import { Worker } from 'worker_threads';
import { EventEmitter } from 'eventemitter3';
import { PluginCapabilities } from './PluginContext';
export interface IsolationConfig {
    maxMemoryMB: number;
    maxCpuPercent: number;
    maxExecutionTimeMs: number;
    maxWorkers: number;
    enableNetworkIsolation: boolean;
    enableFileSystemIsolation: boolean;
}
export interface WorkerMessage {
    type: 'execute' | 'result' | 'error' | 'metrics' | 'log';
    id: string;
    data?: any;
    error?: string;
}
export interface PluginWorker {
    id: string;
    worker: Worker;
    pluginId: string;
    capabilities: PluginCapabilities;
    activeRequests: Map<string, {
        resolve: Function;
        reject: Function;
        startTime: number;
    }>;
    metrics: {
        totalExecutions: number;
        totalErrors: number;
        averageExecutionTime: number;
        memoryUsage: number;
        cpuUsage: number;
    };
}
export declare class PluginIsolationManager extends EventEmitter {
    private logger;
    private config;
    private workers;
    private workerPool;
    private workerCode;
    constructor(config?: Partial<IsolationConfig>);
    /**
     * Initialize worker pool for better performance
     */
    private initializeWorkerPool;
    /**
     * Create a new worker instance
     */
    private createWorker;
    /**
     * Generate worker code for isolated execution
     */
    private generateWorkerCode;
    /**
     * Create isolated plugin context
     */
    createPluginContext(pluginId: string, capabilities: PluginCapabilities): Promise<string>;
    /**
     * Execute code in isolated environment
     */
    execute(workerId: string, code: string, context?: any, options?: {
        timeout?: number;
    }): Promise<any>;
    /**
     * Handle worker messages
     */
    private handleWorkerMessage;
    /**
     * Handle worker errors
     */
    private handleWorkerError;
    /**
     * Handle worker exit
     */
    private handleWorkerExit;
    /**
     * Get worker metrics
     */
    getWorkerMetrics(workerId: string): any;
    /**
     * Get all worker metrics
     */
    getAllMetrics(): any;
    /**
     * Terminate a worker
     */
    terminateWorker(workerId: string): Promise<void>;
    /**
     * Terminate all workers
     */
    terminateAll(): Promise<void>;
    /**
     * Health check for workers
     */
    healthCheck(): Promise<{
        healthy: number;
        unhealthy: number;
    }>;
    /**
     * Dispose and cleanup
     */
    dispose(): Promise<void>;
}
export default PluginIsolationManager;
//# sourceMappingURL=PluginIsolationManager.d.ts.map