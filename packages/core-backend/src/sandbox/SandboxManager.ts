import { EventEmitter } from 'eventemitter3'
import type { SandboxOptions, ExecutionContext, ExecutionResult } from './ScriptSandbox';
import { ScriptSandbox } from './ScriptSandbox'
import { SecurityPolicy } from './SecurityPolicy'
import crypto from 'crypto'

export interface SandboxPool {
  id: string
  name: string
  options: SandboxOptions
  policy: SecurityPolicy
  instances: ScriptSandbox[]
  maxInstances: number
  activeInstances: number
}

export interface ScriptTemplate {
  id: string
  name: string
  description?: string
  language: 'javascript' | 'typescript' | 'python'
  code: string
  parameters?: Array<{
    name: string
    type: string
    required?: boolean
    default?: unknown
    description?: string
  }>
  context?: ExecutionContext
  sandboxOptions?: SandboxOptions
}

export interface ExecutionRequest {
  script?: string
  templateId?: string
  parameters?: Record<string, unknown>
  context?: ExecutionContext
  language?: 'javascript' | 'typescript' | 'python'
  poolId?: string
  async?: boolean
  callback?: (result: ExecutionResult) => void
}

export interface ExecutionJob {
  id: string
  request: ExecutionRequest
  status: 'pending' | 'running' | 'completed' | 'failed' | 'timeout'
  result?: ExecutionResult
  startedAt?: Date
  completedAt?: Date
  sandbox?: ScriptSandbox
}

export class SandboxManager extends EventEmitter {
  private pools: Map<string, SandboxPool> = new Map()
  private templates: Map<string, ScriptTemplate> = new Map()
  private jobs: Map<string, ExecutionJob> = new Map()
  private defaultPool: SandboxPool | null = null
  private queue: ExecutionJob[] = []
  private processing: boolean = false

  constructor() {
    super()
    this.initializeDefaultPool()
  }

  private initializeDefaultPool(): void {
    const defaultPolicy = new SecurityPolicy({
      maxExecutionTime: 5000,
      maxMemory: 128,
      maxCPU: 5,
      allowNetwork: false,
      allowFileSystem: false,
      allowedModules: ['lodash', 'moment', 'axios'],
      blockedAPIs: ['eval', 'Function', 'require', 'import']
    })

    this.defaultPool = {
      id: 'default',
      name: 'Default Pool',
      options: {
        timeout: 5000,
        memoryLimit: 128,
        cpuLimit: 5,
        allowedModules: ['lodash', 'moment'],
        isolateContext: true
      },
      policy: defaultPolicy,
      instances: [],
      maxInstances: 10,
      activeInstances: 0
    }

    this.pools.set('default', this.defaultPool)
  }

  async createPool(
    name: string,
    options: SandboxOptions,
    policy: SecurityPolicy,
    maxInstances: number = 10
  ): Promise<string> {
    const poolId = crypto.randomBytes(16).toString('hex')

    const pool: SandboxPool = {
      id: poolId,
      name,
      options,
      policy,
      instances: [],
      maxInstances,
      activeInstances: 0
    }

    // Pre-create some sandbox instances
    const preCreateCount = Math.min(2, maxInstances)
    for (let i = 0; i < preCreateCount; i++) {
      const sandbox = new ScriptSandbox(options)
      await sandbox.initialize()
      pool.instances.push(sandbox)
    }

    this.pools.set(poolId, pool)
    this.emit('pool:created', { poolId, name })

    return poolId
  }

  async destroyPool(poolId: string): Promise<void> {
    const pool = this.pools.get(poolId)
    if (!pool) {
      throw new Error(`Pool ${poolId} not found`)
    }

    // Clean up all sandbox instances
    for (const sandbox of pool.instances) {
      await sandbox.cleanup()
    }

    this.pools.delete(poolId)
    this.emit('pool:destroyed', { poolId })
  }

  registerTemplate(template: ScriptTemplate): string {
    const templateId = template.id || crypto.randomBytes(16).toString('hex')
    template.id = templateId

    this.templates.set(templateId, template)
    this.emit('template:registered', { templateId, name: template.name })

    return templateId
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const job: ExecutionJob = {
      id: crypto.randomBytes(16).toString('hex'),
      request,
      status: 'pending'
    }

    this.jobs.set(job.id, job)
    this.emit('job:created', { jobId: job.id })

    if (request.async) {
      // Add to queue for async processing
      this.queue.push(job)
      this.processQueue()

      // Return immediately with job ID
      return {
        success: true,
        output: { jobId: job.id },
        logs: [],
        metrics: { executionTime: 0, memoryUsed: 0 }
      }
    } else {
      // Execute synchronously
      return await this.executeJob(job)
    }
  }

  private async executeJob(job: ExecutionJob): Promise<ExecutionResult> {
    job.status = 'running'
    job.startedAt = new Date()
    this.emit('job:started', { jobId: job.id })

    try {
      // Get or prepare script
      let script = job.request.script
      let context = job.request.context || {}
      let language = job.request.language || 'javascript'

      if (job.request.templateId) {
        const template = this.templates.get(job.request.templateId)
        if (!template) {
          throw new Error(`Template ${job.request.templateId} not found`)
        }

        script = this.prepareTemplateScript(template, job.request.parameters || {})
        context = { ...template.context, ...context }
        language = template.language
      }

      if (!script) {
        throw new Error('No script or template provided')
      }

      // Get sandbox from pool
      const pool = job.request.poolId
        ? this.pools.get(job.request.poolId)
        : this.defaultPool

      if (!pool) {
        throw new Error(`Pool ${job.request.poolId} not found`)
      }

      // Apply security policy
      const validationResult = await pool.policy.validate(script, language)
      if (!validationResult.allowed) {
        throw new Error(`Security policy violation: ${validationResult.reasons.join(', ')}`)
      }

      // Get or create sandbox
      const sandbox = await this.getSandbox(pool)
      job.sandbox = sandbox

      // Execute script
      const result = await sandbox.execute(script, context, language)

      // Release sandbox back to pool
      this.releaseSandbox(pool, sandbox)

      // Update job
      job.status = result.success ? 'completed' : 'failed'
      job.result = result
      job.completedAt = new Date()

      this.emit('job:completed', { jobId: job.id, result })

      // Call callback if provided
      if (job.request.callback) {
        job.request.callback(result)
      }

      return result
    } catch (error) {
      const errorResult: ExecutionResult = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        logs: [],
        metrics: {
          executionTime: Date.now() - (job.startedAt?.getTime() || Date.now()),
          memoryUsed: 0
        }
      }

      job.status = 'failed'
      job.result = errorResult
      job.completedAt = new Date()

      this.emit('job:failed', { jobId: job.id, error })

      if (job.request.callback) {
        job.request.callback(errorResult)
      }

      return errorResult
    }
  }

  private async getSandbox(pool: SandboxPool): Promise<ScriptSandbox> {
    // Try to get an available sandbox from the pool
    if (pool.instances.length > pool.activeInstances) {
      pool.activeInstances++
      return pool.instances[pool.activeInstances - 1]
    }

    // Create new sandbox if under limit
    if (pool.instances.length < pool.maxInstances) {
      const sandbox = new ScriptSandbox(pool.options)
      await sandbox.initialize()
      pool.instances.push(sandbox)
      pool.activeInstances++
      return sandbox
    }

    // Wait for a sandbox to become available
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (pool.activeInstances < pool.instances.length) {
          clearInterval(checkInterval)
          pool.activeInstances++
          resolve(pool.instances[pool.activeInstances - 1])
        }
      }, 100)
    })
  }

  private releaseSandbox(pool: SandboxPool, _sandbox: ScriptSandbox): void {
    pool.activeInstances--
    this.emit('sandbox:released', { poolId: pool.id })
  }

  private prepareTemplateScript(template: ScriptTemplate, parameters: Record<string, unknown>): string {
    let script = template.code

    // Replace parameter placeholders
    if (template.parameters) {
      for (const param of template.parameters) {
        const value = parameters[param.name] ?? param.default
        if (value === undefined && param.required) {
          throw new Error(`Required parameter ${param.name} not provided`)
        }

        // Safe parameter injection
        const placeholder = `{{${param.name}}}`
        const safeValue = JSON.stringify(value)
        script = script.replace(new RegExp(placeholder, 'g'), safeValue)
      }
    }

    return script
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return
    }

    this.processing = true

    while (this.queue.length > 0) {
      const job = this.queue.shift()
      if (job) {
        await this.executeJob(job)
      }
    }

    this.processing = false
  }

  async getJobStatus(jobId: string): Promise<ExecutionJob | undefined> {
    return this.jobs.get(jobId)
  }

  async getJobResult(jobId: string, timeout: number = 30000): Promise<ExecutionResult> {
    const job = this.jobs.get(jobId)
    if (!job) {
      throw new Error(`Job ${jobId} not found`)
    }

    if (job.status === 'completed' || job.status === 'failed') {
      return job.result!
    }

    // Wait for job to complete
    return new Promise((resolve, reject) => {
      const startTime = Date.now()

      const checkInterval = setInterval(() => {
        const currentJob = this.jobs.get(jobId)
        if (!currentJob) {
          clearInterval(checkInterval)
          reject(new Error(`Job ${jobId} disappeared`))
          return
        }

        if (currentJob.status === 'completed' || currentJob.status === 'failed') {
          clearInterval(checkInterval)
          resolve(currentJob.result!)
          return
        }

        if (Date.now() - startTime > timeout) {
          clearInterval(checkInterval)
          reject(new Error(`Job ${jobId} timeout`))
        }
      }, 100)
    })
  }

  getPoolMetrics(poolId?: string): {
    poolId: string
    name: string
    activeInstances: number
    totalInstances: number
    maxInstances: number
    utilization: number
  }[] {
    const pools = poolId ? [this.pools.get(poolId)] : Array.from(this.pools.values())

    return pools
      .filter(pool => pool !== undefined)
      .map(pool => ({
        poolId: pool!.id,
        name: pool!.name,
        activeInstances: pool!.activeInstances,
        totalInstances: pool!.instances.length,
        maxInstances: pool!.maxInstances,
        utilization: pool!.activeInstances / pool!.maxInstances
      }))
  }

  async cleanup(): Promise<void> {
    // Cancel all pending jobs
    for (const job of this.queue) {
      job.status = 'failed'
      job.result = {
        success: false,
        error: 'Manager shutting down',
        logs: [],
        metrics: { executionTime: 0, memoryUsed: 0 }
      }
    }
    this.queue = []

    // Clean up all pools
    for (const pool of this.pools.values()) {
      for (const sandbox of pool.instances) {
        await sandbox.cleanup()
      }
    }

    this.pools.clear()
    this.templates.clear()
    this.jobs.clear()

    this.emit('cleanup:complete')
  }
}
