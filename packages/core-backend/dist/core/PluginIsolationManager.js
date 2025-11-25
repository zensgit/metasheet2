/**
 * Plugin Isolation Manager
 * Manages isolated execution environments for plugins with resource limits and monitoring
 */
import { Worker } from 'worker_threads';
import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'eventemitter3';
import { Logger } from './logger';
import { metrics } from '../metrics/metrics';
const DEFAULT_ISOLATION_CONFIG = {
    maxMemoryMB: 128,
    maxCpuPercent: 50,
    maxExecutionTimeMs: 10000,
    maxWorkers: 10,
    enableNetworkIsolation: true,
    enableFileSystemIsolation: true
};
export class PluginIsolationManager extends EventEmitter {
    logger;
    config;
    workers = new Map();
    workerPool = [];
    workerCode;
    constructor(config) {
        super();
        this.logger = new Logger('PluginIsolationManager');
        this.config = { ...DEFAULT_ISOLATION_CONFIG, ...config };
        this.workerCode = this.generateWorkerCode();
        // Pre-warm worker pool
        this.initializeWorkerPool();
    }
    /**
     * Initialize worker pool for better performance
     */
    async initializeWorkerPool() {
        const poolSize = Math.min(5, this.config.maxWorkers);
        for (let i = 0; i < poolSize; i++) {
            try {
                const worker = await this.createWorker();
                this.workerPool.push(worker);
            }
            catch (error) {
                this.logger.error(`Failed to create worker: ${error}`);
            }
        }
        this.logger.info(`Worker pool initialized with ${this.workerPool.length} workers`);
    }
    /**
     * Create a new worker instance
     */
    async createWorker() {
        // Create worker script file
        const workerScriptPath = path.join(__dirname, 'plugin-worker.js');
        await fs.promises.writeFile(workerScriptPath, this.workerCode, 'utf-8');
        const worker = new Worker(workerScriptPath, {
            resourceLimits: {
                maxOldGenerationSizeMb: this.config.maxMemoryMB,
                maxYoungGenerationSizeMb: this.config.maxMemoryMB / 4
            },
            env: {
                ...process.env,
                PLUGIN_WORKER: 'true',
                MAX_EXECUTION_TIME: this.config.maxExecutionTimeMs.toString()
            }
        });
        return worker;
    }
    /**
     * Generate worker code for isolated execution
     */
    generateWorkerCode() {
        return `
const { parentPort, workerData } = require('worker_threads');
const { VM } = require('vm2');
const crypto = require('crypto');

// Isolated execution environment
class IsolatedEnvironment {
  constructor() {
    this.vm = new VM({
      timeout: parseInt(process.env.MAX_EXECUTION_TIME) || 10000,
      sandbox: this.createSandbox(),
      fixAsync: true,
      eval: false,
      wasm: false
    });
  }

  createSandbox() {
    return {
      console: {
        log: (...args) => this.sendLog('log', args),
        error: (...args) => this.sendLog('error', args),
        warn: (...args) => this.sendLog('warn', args),
        info: (...args) => this.sendLog('info', args)
      },
      Buffer: Buffer,
      process: {
        env: {},
        version: process.version,
        platform: process.platform
      },
      setTimeout: undefined,
      setInterval: undefined,
      setImmediate: undefined,
      __metasheet: {}
    };
  }

  sendLog(level, args) {
    parentPort.postMessage({
      type: 'log',
      data: { level, args: args.map(arg => String(arg)) }
    });
  }

  async execute(code, context) {
    const startTime = Date.now();
    const startMemory = process.memoryUsage();

    try {
      // Inject context
      if (context) {
        this.vm.setGlobal('__context', context);
      }

      // Execute code
      const result = await this.vm.run(code);

      // Calculate metrics
      const executionTime = Date.now() - startTime;
      const endMemory = process.memoryUsage();
      const memoryDelta = endMemory.heapUsed - startMemory.heapUsed;

      return {
        success: true,
        result,
        metrics: {
          executionTime,
          memoryUsed: memoryDelta,
          timestamp: Date.now()
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message || 'Unknown error',
        metrics: {
          executionTime: Date.now() - startTime,
          timestamp: Date.now()
        }
      };
    }
  }
}

// Worker message handler
const environment = new IsolatedEnvironment();

parentPort.on('message', async (message) => {
  const { type, id, data } = message;

  if (type === 'execute') {
    const { code, context } = data;
    const result = await environment.execute(code, context);

    parentPort.postMessage({
      type: result.success ? 'result' : 'error',
      id,
      data: result.success ? result.result : undefined,
      error: result.success ? undefined : result.error,
      metrics: result.metrics
    });
  } else if (type === 'ping') {
    parentPort.postMessage({ type: 'pong', id });
  }
});

// Handle worker errors
process.on('uncaughtException', (error) => {
  parentPort.postMessage({
    type: 'error',
    error: error.message
  });
});

process.on('unhandledRejection', (reason) => {
  parentPort.postMessage({
    type: 'error',
    error: String(reason)
  });
});
`;
    }
    /**
     * Create isolated plugin context
     */
    async createPluginContext(pluginId, capabilities) {
        // Get or create worker from pool
        let worker;
        if (this.workerPool.length > 0) {
            worker = this.workerPool.pop();
        }
        else if (this.workers.size < this.config.maxWorkers) {
            worker = await this.createWorker();
        }
        else {
            throw new Error('Maximum number of workers reached');
        }
        const workerId = crypto.randomUUID();
        // Create plugin worker wrapper
        const pluginWorker = {
            id: workerId,
            worker,
            pluginId,
            capabilities,
            activeRequests: new Map(),
            metrics: {
                totalExecutions: 0,
                totalErrors: 0,
                averageExecutionTime: 0,
                memoryUsage: 0,
                cpuUsage: 0
            }
        };
        // Set up message handling
        worker.on('message', (message) => {
            this.handleWorkerMessage(pluginWorker, message);
        });
        worker.on('error', (error) => {
            this.logger.error(`Worker error for plugin ${pluginId}: ${error}`);
            this.handleWorkerError(pluginWorker, error);
        });
        worker.on('exit', (code) => {
            if (code !== 0) {
                this.logger.error(`Worker exited with code ${code} for plugin ${pluginId}`);
            }
            this.handleWorkerExit(pluginWorker);
        });
        this.workers.set(workerId, pluginWorker);
        metrics.pluginWorkersActive?.set?.(this.workers.size);
        this.logger.info(`Created isolated context for plugin ${pluginId} (worker: ${workerId})`);
        return workerId;
    }
    /**
     * Execute code in isolated environment
     */
    async execute(workerId, code, context, options) {
        const pluginWorker = this.workers.get(workerId);
        if (!pluginWorker) {
            throw new Error(`Worker ${workerId} not found`);
        }
        const requestId = crypto.randomUUID();
        const timeout = options?.timeout || this.config.maxExecutionTimeMs;
        return new Promise((resolve, reject) => {
            // Store request promise
            pluginWorker.activeRequests.set(requestId, {
                resolve,
                reject,
                startTime: Date.now()
            });
            // Set timeout
            const timeoutId = setTimeout(() => {
                const request = pluginWorker.activeRequests.get(requestId);
                if (request) {
                    pluginWorker.activeRequests.delete(requestId);
                    request.reject(new Error('Execution timeout'));
                    metrics.pluginExecutionTimeouts?.inc?.({ plugin: pluginWorker.pluginId });
                }
            }, timeout);
            // Send execution request
            pluginWorker.worker.postMessage({
                type: 'execute',
                id: requestId,
                data: { code, context }
            });
            // Update request with timeout ID for cleanup
            const request = pluginWorker.activeRequests.get(requestId);
            request.timeoutId = timeoutId;
        });
    }
    /**
     * Handle worker messages
     */
    handleWorkerMessage(pluginWorker, message) {
        switch (message.type) {
            case 'result':
            case 'error':
                const request = pluginWorker.activeRequests.get(message.id);
                if (request) {
                    // Clear timeout
                    if (request.timeoutId) {
                        clearTimeout(request.timeoutId);
                    }
                    // Update metrics
                    const executionTime = Date.now() - request.startTime;
                    pluginWorker.metrics.totalExecutions++;
                    if (message.type === 'error') {
                        pluginWorker.metrics.totalErrors++;
                        metrics.pluginErrors?.inc?.({ plugin: pluginWorker.pluginId, type: 'execution' });
                    }
                    pluginWorker.metrics.averageExecutionTime =
                        (pluginWorker.metrics.averageExecutionTime * (pluginWorker.metrics.totalExecutions - 1) +
                            executionTime) /
                            pluginWorker.metrics.totalExecutions;
                    // Update memory metrics if provided
                    if (message?.metrics?.memoryUsed) {
                        pluginWorker.metrics.memoryUsage = message.metrics.memoryUsed;
                    }
                    // Resolve or reject promise
                    pluginWorker.activeRequests.delete(message.id);
                    if (message.type === 'result') {
                        request.resolve(message.data);
                    }
                    else {
                        request.reject(new Error(message.error));
                    }
                }
                break;
            case 'log':
                this.emit('plugin:log', {
                    pluginId: pluginWorker.pluginId,
                    level: message.data.level,
                    args: message.data.args
                });
                break;
            case 'metrics':
                // Update worker metrics
                if (message.data) {
                    Object.assign(pluginWorker.metrics, message.data);
                }
                break;
        }
    }
    /**
     * Handle worker errors
     */
    handleWorkerError(pluginWorker, error) {
        // Reject all pending requests
        for (const [requestId, request] of pluginWorker.activeRequests) {
            request.reject(error);
        }
        pluginWorker.activeRequests.clear();
        // Emit error event
        this.emit('plugin:error', {
            pluginId: pluginWorker.pluginId,
            error: error.message
        });
        metrics.pluginWorkerCrashes?.inc?.({ plugin: pluginWorker.pluginId });
    }
    /**
     * Handle worker exit
     */
    handleWorkerExit(pluginWorker) {
        // Remove from active workers
        this.workers.delete(pluginWorker.id);
        // Reject any pending requests
        for (const [requestId, request] of pluginWorker.activeRequests) {
            request.reject(new Error('Worker exited'));
        }
        ;
        metrics.pluginWorkersActive?.set?.(this.workers.size);
        // Try to refill worker pool
        this.createWorker()
            .then(worker => this.workerPool.push(worker))
            .catch(error => this.logger.error(`Failed to create replacement worker: ${error}`));
    }
    /**
     * Get worker metrics
     */
    getWorkerMetrics(workerId) {
        const pluginWorker = this.workers.get(workerId);
        if (!pluginWorker) {
            return null;
        }
        return {
            pluginId: pluginWorker.pluginId,
            ...pluginWorker.metrics,
            activeRequests: pluginWorker.activeRequests.size
        };
    }
    /**
     * Get all worker metrics
     */
    getAllMetrics() {
        const metrics = [];
        for (const [workerId, pluginWorker] of this.workers) {
            metrics.push({
                workerId,
                pluginId: pluginWorker.pluginId,
                ...pluginWorker.metrics,
                activeRequests: pluginWorker.activeRequests.size
            });
        }
        return {
            totalWorkers: this.workers.size,
            poolSize: this.workerPool.length,
            maxWorkers: this.config.maxWorkers,
            workers: metrics
        };
    }
    /**
     * Terminate a worker
     */
    async terminateWorker(workerId) {
        const pluginWorker = this.workers.get(workerId);
        if (!pluginWorker) {
            return;
        }
        // Reject pending requests
        for (const [requestId, request] of pluginWorker.activeRequests) {
            request.reject(new Error('Worker terminated'));
        }
        // Terminate worker
        await pluginWorker.worker.terminate();
        // Remove from active workers
        this.workers.delete(workerId);
        metrics.pluginWorkersActive?.set?.(this.workers.size);
        this.logger.info(`Terminated worker ${workerId} for plugin ${pluginWorker.pluginId}`);
    }
    /**
     * Terminate all workers
     */
    async terminateAll() {
        const promises = [];
        // Terminate active workers
        for (const workerId of this.workers.keys()) {
            promises.push(this.terminateWorker(workerId));
        }
        // Terminate pool workers (coerce Promise<number> to Promise<void> for Phase A)
        for (const worker of this.workerPool) {
            promises.push(worker.terminate());
        }
        await Promise.all(promises);
        this.workers.clear();
        this.workerPool = [];
        metrics.pluginWorkersActive?.set?.(0);
        this.logger.info('All workers terminated');
    }
    /**
     * Health check for workers
     */
    async healthCheck() {
        const results = { healthy: 0, unhealthy: 0 };
        for (const [workerId, pluginWorker] of this.workers) {
            try {
                const pingId = crypto.randomUUID();
                const pingPromise = new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => reject(new Error('Ping timeout')), 1000);
                    const handler = (message) => {
                        if (message.type === 'pong' && message.id === pingId) {
                            clearTimeout(timeout);
                            pluginWorker.worker.off('message', handler);
                            resolve(true);
                        }
                    };
                    pluginWorker.worker.on('message', handler);
                    pluginWorker.worker.postMessage({ type: 'ping', id: pingId });
                });
                await pingPromise;
                results.healthy++;
            }
            catch {
                results.unhealthy++;
            }
        }
        return results;
    }
    /**
     * Dispose and cleanup
     */
    async dispose() {
        await this.terminateAll();
        this.removeAllListeners();
        this.logger.info('PluginIsolationManager disposed');
    }
}
export default PluginIsolationManager;
//# sourceMappingURL=PluginIsolationManager.js.map