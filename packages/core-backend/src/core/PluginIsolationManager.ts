/**
 * Plugin Isolation Manager
 * Manages isolated execution environments for plugins with resource limits and monitoring
 */

import { Worker } from 'worker_threads'
import * as path from 'path'
import * as fs from 'fs'
import { EventEmitter } from 'eventemitter3'
import { Logger } from './logger'
import { PluginContext, PluginCapabilities } from './PluginContext'
import { metrics } from '../metrics/metrics'

export interface IsolationConfig {
  maxMemoryMB: number
  maxCpuPercent: number
  maxExecutionTimeMs: number
  maxWorkers: number
  enableNetworkIsolation: boolean
  enableFileSystemIsolation: boolean
}

export interface WorkerMessage {
  type: 'execute' | 'result' | 'error' | 'metrics' | 'log'
  id: string
  data?: any
  error?: string
}

export interface PluginWorker {
  id: string
  worker: Worker
  pluginId: string
  capabilities: PluginCapabilities
  activeRequests: Map<string, { resolve: Function; reject: Function; startTime: number }>
  metrics: {
    totalExecutions: number
    totalErrors: number
    averageExecutionTime: number
    memoryUsage: number
    cpuUsage: number
  }
}

const DEFAULT_ISOLATION_CONFIG: IsolationConfig = {
  maxMemoryMB: 128,
  maxCpuPercent: 50,
  maxExecutionTimeMs: 10000,
  maxWorkers: 10,
  enableNetworkIsolation: true,
  enableFileSystemIsolation: true
}

export class PluginIsolationManager extends EventEmitter {
  private logger: Logger
  private config: IsolationConfig
  private workers: Map<string, PluginWorker> = new Map()
  private workerPool: Worker[] = []
  private workerCode: string

  constructor(config?: Partial<IsolationConfig>) {
    super()
    this.logger = new Logger('PluginIsolationManager')
    this.config = { ...DEFAULT_ISOLATION_CONFIG, ...config }
    this.workerCode = this.generateWorkerCode()

    // Pre-warm worker pool
    this.initializeWorkerPool()
  }

  /**
   * Initialize worker pool for better performance
   */
  private async initializeWorkerPool(): Promise<void> {
    const poolSize = Math.min(5, this.config.maxWorkers)

    for (let i = 0; i < poolSize; i++) {
      try {
        const worker = await this.createWorker()
        this.workerPool.push(worker)
      } catch (error) {
        this.logger.error(`Failed to create worker: ${error}`)
      }
    }

    this.logger.info(`Worker pool initialized with ${this.workerPool.length} workers`)
  }

  /**
   * Create a new worker instance
   */
  private async createWorker(): Promise<Worker> {
    // Create worker script file
    const workerScriptPath = path.join(__dirname, 'plugin-worker.js')
    await fs.promises.writeFile(workerScriptPath, this.workerCode, 'utf-8')

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
    })

    return worker
  }

  /**
   * Generate worker code for isolated execution
   */
  private generateWorkerCode(): string {
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
`
  }

  /**
   * Create isolated plugin context
   */
  async createPluginContext(
    pluginId: string,
    capabilities: PluginCapabilities
  ): Promise<string> {
    // Get or create worker from pool
    let worker: Worker

    if (this.workerPool.length > 0) {
      worker = this.workerPool.pop()!
    } else if (this.workers.size < this.config.maxWorkers) {
      worker = await this.createWorker()
    } else {
      throw new Error('Maximum number of workers reached')
    }

    const workerId = crypto.randomUUID()

    // Create plugin worker wrapper
    const pluginWorker: PluginWorker = {
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
    }

    // Set up message handling
    worker.on('message', (message: WorkerMessage) => {
      this.handleWorkerMessage(pluginWorker, message)
    })

    worker.on('error', (error) => {
      this.logger.error(`Worker error for plugin ${pluginId}: ${error}`)
      this.handleWorkerError(pluginWorker, error)
    })

    worker.on('exit', (code) => {
      if (code !== 0) {
        this.logger.error(`Worker exited with code ${code} for plugin ${pluginId}`)
      }
      this.handleWorkerExit(pluginWorker)
    })

    this.workers.set(workerId, pluginWorker)

    ;(metrics as any).pluginWorkersActive?.set?.(this.workers.size)

    this.logger.info(`Created isolated context for plugin ${pluginId} (worker: ${workerId})`)

    return workerId
  }

  /**
   * Execute code in isolated environment
   */
  async execute(
    workerId: string,
    code: string,
    context?: any,
    options?: { timeout?: number }
  ): Promise<any> {
    const pluginWorker = this.workers.get(workerId)
    if (!pluginWorker) {
      throw new Error(`Worker ${workerId} not found`)
    }

    const requestId = crypto.randomUUID()
    const timeout = options?.timeout || this.config.maxExecutionTimeMs

    return new Promise((resolve, reject) => {
      // Store request promise
      pluginWorker.activeRequests.set(requestId, {
        resolve,
        reject,
        startTime: Date.now()
      })

      // Set timeout
      const timeoutId = setTimeout(() => {
        const request = pluginWorker.activeRequests.get(requestId)
        if (request) {
          pluginWorker.activeRequests.delete(requestId)
          request.reject(new Error('Execution timeout'))
          ;(metrics as any).pluginExecutionTimeouts?.inc?.({ plugin: pluginWorker.pluginId })
        }
      }, timeout)

      // Send execution request
      pluginWorker.worker.postMessage({
        type: 'execute',
        id: requestId,
        data: { code, context }
      })

      // Update request with timeout ID for cleanup
      const request = pluginWorker.activeRequests.get(requestId)!
      ;(request as any).timeoutId = timeoutId
    })
  }

  /**
   * Handle worker messages
   */
  private handleWorkerMessage(pluginWorker: PluginWorker, message: WorkerMessage): void {
    switch (message.type) {
      case 'result':
      case 'error':
        const request = pluginWorker.activeRequests.get(message.id)
        if (request) {
          // Clear timeout
          if ((request as any).timeoutId) {
            clearTimeout((request as any).timeoutId)
          }

          // Update metrics
          const executionTime = Date.now() - request.startTime
          pluginWorker.metrics.totalExecutions++

          if (message.type === 'error') {
            pluginWorker.metrics.totalErrors++
            ;(metrics as any).pluginErrors?.inc?.({ plugin: pluginWorker.pluginId, type: 'execution' })
          }

          pluginWorker.metrics.averageExecutionTime =
            (pluginWorker.metrics.averageExecutionTime * (pluginWorker.metrics.totalExecutions - 1) +
              executionTime) /
            pluginWorker.metrics.totalExecutions

          // Update memory metrics if provided
          if ((message as any)?.metrics?.memoryUsed) {
            pluginWorker.metrics.memoryUsage = (message as any).metrics.memoryUsed
          }

          // Resolve or reject promise
          pluginWorker.activeRequests.delete(message.id)

          if (message.type === 'result') {
            request.resolve(message.data)
          } else {
            request.reject(new Error(message.error))
          }
        }
        break

      case 'log':
        this.emit('plugin:log', {
          pluginId: pluginWorker.pluginId,
          level: message.data.level,
          args: message.data.args
        })
        break

      case 'metrics':
        // Update worker metrics
        if (message.data) {
          Object.assign(pluginWorker.metrics, message.data)
        }
        break
    }
  }

  /**
   * Handle worker errors
   */
  private handleWorkerError(pluginWorker: PluginWorker, error: Error): void {
    // Reject all pending requests
    for (const [requestId, request] of pluginWorker.activeRequests) {
      request.reject(error)
    }
    pluginWorker.activeRequests.clear()

    // Emit error event
    this.emit('plugin:error', {
      pluginId: pluginWorker.pluginId,
      error: error.message
    })

    ;(metrics as any).pluginWorkerCrashes?.inc?.({ plugin: pluginWorker.pluginId })
  }

  /**
   * Handle worker exit
   */
  private handleWorkerExit(pluginWorker: PluginWorker): void {
    // Remove from active workers
    this.workers.delete(pluginWorker.id)

    // Reject any pending requests
    for (const [requestId, request] of pluginWorker.activeRequests) {
      request.reject(new Error('Worker exited'))
    }

    ;(metrics as any).pluginWorkersActive?.set?.(this.workers.size)

    // Try to refill worker pool
    this.createWorker()
      .then(worker => this.workerPool.push(worker))
      .catch(error => this.logger.error(`Failed to create replacement worker: ${error}`))
  }

  /**
   * Get worker metrics
   */
  getWorkerMetrics(workerId: string): any {
    const pluginWorker = this.workers.get(workerId)
    if (!pluginWorker) {
      return null
    }

    return {
      pluginId: pluginWorker.pluginId,
      ...pluginWorker.metrics,
      activeRequests: pluginWorker.activeRequests.size
    }
  }

  /**
   * Get all worker metrics
   */
  getAllMetrics(): any {
    const metrics: any[] = []

    for (const [workerId, pluginWorker] of this.workers) {
      metrics.push({
        workerId,
        pluginId: pluginWorker.pluginId,
        ...pluginWorker.metrics,
        activeRequests: pluginWorker.activeRequests.size
      })
    }

    return {
      totalWorkers: this.workers.size,
      poolSize: this.workerPool.length,
      maxWorkers: this.config.maxWorkers,
      workers: metrics
    }
  }

  /**
   * Terminate a worker
   */
  async terminateWorker(workerId: string): Promise<void> {
    const pluginWorker = this.workers.get(workerId)
    if (!pluginWorker) {
      return
    }

    // Reject pending requests
    for (const [requestId, request] of pluginWorker.activeRequests) {
      request.reject(new Error('Worker terminated'))
    }

    // Terminate worker
    await pluginWorker.worker.terminate()

    // Remove from active workers
    this.workers.delete(workerId)

    ;(metrics as any).pluginWorkersActive?.set?.(this.workers.size)

    this.logger.info(`Terminated worker ${workerId} for plugin ${pluginWorker.pluginId}`)
  }

  /**
   * Terminate all workers
   */
  async terminateAll(): Promise<void> {
    const promises: Promise<void>[] = []

    // Terminate active workers
    for (const workerId of this.workers.keys()) {
      promises.push(this.terminateWorker(workerId))
    }

    // Terminate pool workers (coerce Promise<number> to Promise<void> for Phase A)
    for (const worker of this.workerPool) {
      promises.push(worker.terminate() as unknown as Promise<void>)
    }

    await Promise.all(promises)

    this.workers.clear()
    this.workerPool = []

    ;(metrics as any).pluginWorkersActive?.set?.(0)

    this.logger.info('All workers terminated')
  }

  /**
   * Health check for workers
   */
  async healthCheck(): Promise<{ healthy: number; unhealthy: number }> {
    const results = { healthy: 0, unhealthy: 0 }

    for (const [workerId, pluginWorker] of this.workers) {
      try {
        const pingId = crypto.randomUUID()
        const pingPromise: Promise<any> = new Promise((resolve: any, reject: any) => {
          const timeout = setTimeout(() => reject(new Error('Ping timeout')), 1000)

          const handler = (message: any) => {
            if (message.type === 'pong' && message.id === pingId) {
              clearTimeout(timeout)
              pluginWorker.worker.off('message', handler)
              resolve(true)
            }
          }

          pluginWorker.worker.on('message', handler)
          pluginWorker.worker.postMessage({ type: 'ping', id: pingId })
        })

        await pingPromise
        results.healthy++
      } catch {
        results.unhealthy++
      }
    }

    return results
  }

  /**
   * Dispose and cleanup
   */
  async dispose(): Promise<void> {
    await this.terminateAll()
    this.removeAllListeners()
    this.logger.info('PluginIsolationManager disposed')
  }
}

export default PluginIsolationManager
