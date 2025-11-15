/**
 * Enhanced Plugin Context Manager
 * Provides isolated execution context and capability management for plugins
 */

import { EventEmitter } from 'eventemitter3'
import { VM } from 'vm2'
import * as path from 'path'
import * as fs from 'fs'
import { Logger } from './logger'
import { CoreAPI } from '../types/plugin'
import { metrics } from '../metrics/metrics'

// Plugin capability declarations
export interface PluginCapability {
  name: string
  version: string
  required: boolean
}

export interface PluginCapabilities {
  // Data access capabilities
  database?: {
    read?: string[]   // Table names the plugin can read
    write?: string[]  // Table names the plugin can write
    execute?: boolean // Can execute arbitrary SQL
  }

  // HTTP capabilities
  http?: {
    internal?: boolean      // Access internal APIs
    external?: boolean      // Access external APIs
    allowedDomains?: string[] // Specific domains allowed
  }

  // File system capabilities
  filesystem?: {
    read?: string[]   // Directory paths the plugin can read
    write?: string[]  // Directory paths the plugin can write
    temp?: boolean    // Can use temp directory
  }

  // Event capabilities
  events?: {
    emit?: string[]   // Event types the plugin can emit
    listen?: string[] // Event types the plugin can listen to
  }

  // System capabilities
  system?: {
    env?: string[]    // Environment variables the plugin can access
    spawn?: boolean   // Can spawn child processes
    network?: boolean // Can create network connections
  }

  // UI capabilities
  ui?: {
    views?: boolean      // Can register views
    modals?: boolean     // Can show modals
    notifications?: boolean // Can send notifications
  }
}

export interface PluginSandboxOptions {
  timeout?: number           // Execution timeout in ms
  memory?: number           // Memory limit in MB
  cpuQuota?: number        // CPU quota percentage
  capabilities: PluginCapabilities
}

export interface PluginMetrics {
  executionCount: number
  totalExecutionTime: number
  errorCount: number
  lastExecution?: Date
  memoryUsage?: number
  cpuUsage?: number
}

export class PluginContext extends EventEmitter {
  private vm?: VM
  private logger: Logger
  private capabilities: PluginCapabilities
  private metrics: PluginMetrics = {
    executionCount: 0,
    totalExecutionTime: 0,
    errorCount: 0
  }
  private resourceLimits: {
    memory: number
    timeout: number
    cpuQuota: number
  }

  constructor(
    private pluginId: string,
    private coreAPI: CoreAPI,
    options: PluginSandboxOptions
  ) {
    super()
    this.logger = new Logger(`PluginContext:${pluginId}`)
    this.capabilities = options.capabilities
    this.resourceLimits = {
      memory: options.memory || 128,
      timeout: options.timeout || 10000,
      cpuQuota: options.cpuQuota || 50
    }

    this.initializeSandbox()
  }

  /**
   * Initialize VM2 sandbox with security restrictions
   */
  private initializeSandbox(): void {
    try {
      this.vm = new VM({
        timeout: this.resourceLimits.timeout,
        sandbox: this.createSandboxedAPI(),
        fixAsync: true,
        eval: false,
        wasm: false,
        compiler: 'javascript',
        // wrapper may not exist in some vm2 versions; keep compile-time leniency
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        wrapper: 'none'
      })

      this.logger.info(`Sandbox initialized for plugin: ${this.pluginId}`)
    } catch (error) {
      this.logger.error(`Failed to initialize sandbox: ${error}`)
      throw error
    }
  }

  /**
   * Create sandboxed API based on declared capabilities
   */
  private createSandboxedAPI(): any {
    const sandboxAPI: any = {
      console: this.createSandboxedConsole(),
      setTimeout: undefined,
      setInterval: undefined,
      setImmediate: undefined,
      process: {
        env: this.createSandboxedEnv(),
        version: process.version,
        platform: process.platform
      }
    }

    // Add database API if capability declared
    if (this.capabilities.database) {
      sandboxAPI.database = this.createSandboxedDatabase()
    }

    // Add HTTP API if capability declared
    if (this.capabilities.http) {
      sandboxAPI.http = this.createSandboxedHttp()
    }

    // Add events API if capability declared
    if (this.capabilities.events) {
      sandboxAPI.events = this.createSandboxedEvents()
    }

    // Add filesystem API if capability declared
    if (this.capabilities.filesystem) {
      sandboxAPI.fs = this.createSandboxedFilesystem()
    }

    // Add core MetaSheet API
    sandboxAPI.metasheet = this.createSandboxedMetaSheetAPI()

    return sandboxAPI
  }

  /**
   * Create sandboxed console for logging
   */
  private createSandboxedConsole(): any {
    return {
      log: (...args: any[]) => this.logger.info(`[${this.pluginId}]`, ...args),
      error: (...args: any[]) => this.logger.error(`[${this.pluginId}]`, ...args),
      warn: (...args: any[]) => this.logger.warn(`[${this.pluginId}]`, ...args),
      info: (...args: any[]) => this.logger.info(`[${this.pluginId}]`, ...args),
      debug: (...args: any[]) => this.logger.debug(`[${this.pluginId}]`, ...args)
    }
  }

  /**
   * Create sandboxed environment variables
   */
  private createSandboxedEnv(): any {
    const env: any = {}

    if (this.capabilities.system?.env) {
      for (const key of this.capabilities.system.env) {
        if (process.env[key]) {
          env[key] = process.env[key]
        }
      }
    }

    return env
  }

  /**
   * Create sandboxed database API
   */
  private createSandboxedDatabase(): any {
    const { database } = this.capabilities

    return {
      query: async (sql: string, params?: any[]) => {
        // Check if plugin has execute permission
        if (!database?.execute) {
          // Parse SQL to check table access
          const tables = this.extractTablesFromSQL(sql)
          const isRead = /^\s*(SELECT|WITH)/i.test(sql)
          const isWrite = /^\s*(INSERT|UPDATE|DELETE)/i.test(sql)

          if (isRead) {
            const allowed = tables.every(table =>
              database.read?.includes(table)
            )
            if (!allowed) {
              throw new Error(`Plugin ${this.pluginId} does not have read access to requested tables`)
            }
          }

          if (isWrite) {
            const allowed = tables.every(table =>
              database.write?.includes(table)
            )
            if (!allowed) {
              throw new Error(`Plugin ${this.pluginId} does not have write access to requested tables`)
            }
          }
        }

        try {
          const result = await this.coreAPI.database.query(sql, params)
          ;(metrics as any).pluginDatabaseQueries?.inc?.({ plugin: this.pluginId, operation: 'query' })
          return result
        } catch (error) {
          ;(metrics as any).pluginErrors?.inc?.({ plugin: this.pluginId, type: 'database' })
          throw error
        }
      },

      transaction: async (callback: Function) => {
        if (!database?.write || database.write.length === 0) {
          throw new Error(`Plugin ${this.pluginId} does not have transaction capability`)
        }

        return await this.coreAPI.database.transaction(async (tx: any) => {
          return await callback(tx)
        })
      }
    }
  }

  /**
   * Create sandboxed HTTP client
   */
  private createSandboxedHttp(): any {
    const { http } = this.capabilities

    return {
      request: async (url: string, options?: any) => {
        const urlObj = new URL(url)

        // Check domain restrictions
        if (!http?.external && !this.isInternalURL(urlObj)) {
          throw new Error(`Plugin ${this.pluginId} cannot access external URLs`)
        }

        if (http?.allowedDomains && !http.allowedDomains.includes(urlObj.hostname)) {
          throw new Error(`Plugin ${this.pluginId} cannot access domain: ${urlObj.hostname}`)
        }

        try {
          const result = await this.coreAPI.http.request({
            url,
            ...options,
            headers: {
              ...options?.headers,
              'X-Plugin-ID': this.pluginId
            }
          })

          ;(metrics as any).pluginHttpRequests?.inc?.({ plugin: this.pluginId, domain: urlObj.hostname })
          return result
        } catch (error) {
          ;(metrics as any).pluginErrors?.inc?.({ plugin: this.pluginId, type: 'http' })
          throw error
        }
      }
    }
  }

  /**
   * Create sandboxed event emitter
   */
  private createSandboxedEvents(): any {
    const { events } = this.capabilities

    return {
      emit: (event: string, data: any) => {
        if (!events?.emit?.includes(event)) {
          throw new Error(`Plugin ${this.pluginId} cannot emit event: ${event}`)
        }

        this.emit('plugin:event', {
          pluginId: this.pluginId,
          event,
          data
        })

        ;(metrics as any).pluginEvents?.inc?.({ plugin: this.pluginId, event, type: 'emit' })
      },

      on: (event: string, handler: Function) => {
        if (!events?.listen?.includes(event)) {
          throw new Error(`Plugin ${this.pluginId} cannot listen to event: ${event}`)
        }

        this.on(event, (data) => {
          this.executeInSandbox(handler, [data])
        })

        ;(metrics as any).pluginEvents?.inc?.({ plugin: this.pluginId, event, type: 'listen' })
      }
    }
  }

  /**
   * Create sandboxed filesystem API
   */
  private createSandboxedFilesystem(): any {
    const { filesystem } = this.capabilities

    return {
      readFile: async (filePath: string) => {
        const resolvedPath = path.resolve(filePath)

        // Check if path is allowed
        const allowed = filesystem?.read?.some(allowedPath =>
          resolvedPath.startsWith(path.resolve(allowedPath))
        )

        if (!allowed) {
          throw new Error(`Plugin ${this.pluginId} cannot read file: ${filePath}`)
        }

        try {
          const content = await fs.promises.readFile(resolvedPath, 'utf-8')
          ;(metrics as any).pluginFileOperations?.inc?.({ plugin: this.pluginId, operation: 'read' })
          return content
        } catch (error) {
          ;(metrics as any).pluginErrors?.inc?.({ plugin: this.pluginId, type: 'filesystem' })
          throw error
        }
      },

      writeFile: async (filePath: string, content: string) => {
        const resolvedPath = path.resolve(filePath)

        // Check if path is allowed
        const allowed = filesystem?.write?.some(allowedPath =>
          resolvedPath.startsWith(path.resolve(allowedPath))
        )

        if (!allowed) {
          throw new Error(`Plugin ${this.pluginId} cannot write file: ${filePath}`)
        }

        try {
          await fs.promises.writeFile(resolvedPath, content, 'utf-8')
          ;(metrics as any).pluginFileOperations?.inc?.({ plugin: this.pluginId, operation: 'write' })
        } catch (error) {
          ;(metrics as any).pluginErrors?.inc?.({ plugin: this.pluginId, type: 'filesystem' })
          throw error
        }
      }
    }
  }

  /**
   * Create sandboxed MetaSheet-specific API
   */
  private createSandboxedMetaSheetAPI(): any {
    return {
      getSpreadsheet: async (id: string) => {
        // Check if plugin has database read access to spreadsheets table
        if (!this.capabilities.database?.read?.includes('spreadsheets')) {
          throw new Error(`Plugin ${this.pluginId} cannot access spreadsheets`)
        }

        return await this.coreAPI.database.query(
          'SELECT * FROM spreadsheets WHERE id = $1',
          [id]
        )
      },

      updateCell: async (spreadsheetId: string, cellRef: string, value: any) => {
        // Check if plugin has database write access
        if (!this.capabilities.database?.write?.includes('spreadsheet_cells')) {
          throw new Error(`Plugin ${this.pluginId} cannot update cells`)
        }

        // Implementation would update the cell
        this.emit('cell:update', { spreadsheetId, cellRef, value, pluginId: this.pluginId })
      },

      registerView: async (viewConfig: any) => {
        if (!this.capabilities.ui?.views) {
          throw new Error(`Plugin ${this.pluginId} cannot register views`)
        }

        this.emit('view:register', { ...viewConfig, pluginId: this.pluginId })
      }
    }
  }

  /**
   * Execute code in sandbox
   */
  async execute(code: string, context?: any): Promise<any> {
    if (!this.vm) {
      throw new Error('Sandbox not initialized')
    }

    const startTime = Date.now()

    try {
      // Set execution context
      if (context) {
        this.vm.setGlobal('__context', context)
      }

      // Execute with timeout
      const result = await Promise.race([
        this.vm.run(code),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Execution timeout')), this.resourceLimits.timeout)
        )
      ])

      // Update metrics
      this.metrics.executionCount++
      this.metrics.totalExecutionTime += Date.now() - startTime
      this.metrics.lastExecution = new Date()

      ;(metrics as any).pluginExecutions?.inc?.({ plugin: this.pluginId, status: 'success' })

      return result
    } catch (error) {
      this.metrics.errorCount++
      ;(metrics as any).pluginExecutions?.inc?.({ plugin: this.pluginId, status: 'error' })
      ;(metrics as any).pluginErrors?.inc?.({ plugin: this.pluginId, type: 'execution' })

      this.logger.error(`Plugin execution error: ${error}`)
      throw error
    }
  }

  /**
   * Execute a function in sandbox
   */
  private async executeInSandbox(fn: Function, args: any[]): Promise<any> {
    const fnCode = `
      (function() {
        const fn = ${fn.toString()};
        return fn.apply(null, ${JSON.stringify(args)});
      })()
    `

    return await this.execute(fnCode)
  }

  /**
   * Extract table names from SQL query
   */
  private extractTablesFromSQL(sql: string): string[] {
    const tables: string[] = []

    // Simple regex patterns for table extraction
    const patterns = [
      /FROM\s+["']?(\w+)["']?/gi,
      /JOIN\s+["']?(\w+)["']?/gi,
      /INTO\s+["']?(\w+)["']?/gi,
      /UPDATE\s+["']?(\w+)["']?/gi,
      /DELETE\s+FROM\s+["']?(\w+)["']?/gi
    ]

    for (const pattern of patterns) {
      let match
      while ((match = pattern.exec(sql)) !== null) {
        if (match[1] && !tables.includes(match[1])) {
          tables.push(match[1])
        }
      }
    }

    return tables
  }

  /**
   * Check if URL is internal
   */
  private isInternalURL(url: URL): boolean {
    return url.hostname === 'localhost' ||
           url.hostname === '127.0.0.1' ||
           url.hostname.endsWith('.local')
  }

  /**
   * Get plugin metrics
   */
  getMetrics(): PluginMetrics {
    return { ...this.metrics }
  }

  /**
   * Check if plugin has a specific capability
   */
  hasCapability(capability: string): boolean {
    const parts = capability.split('.')
    let current: any = this.capabilities

    for (const part of parts) {
      if (!current[part]) {
        return false
      }
      current = current[part]
    }

    return true
  }

  /**
   * Destroy the context and clean up resources
   */
  destroy(): void {
    if (this.vm) {
      // VM2 doesn't have a destroy method, but we can clear references
      this.vm = undefined
    }

    this.removeAllListeners()
    this.logger.info(`Plugin context destroyed: ${this.pluginId}`)
  }
}

export default PluginContext
