/**
 * MetaSheet Backend Core
 * 后端核心服务器入口
 */

import type { Application, Request, Response, NextFunction, RequestHandler } from 'express';
import type { Server as HttpServer } from 'http';
import express from 'express'
import { createServer } from 'http'
import { Server as SocketServer } from 'socket.io'
import cors from 'cors'
import crypto from 'crypto'
import { EventEmitter } from 'eventemitter3'
import { PluginLoader } from './core/plugin-loader'
import { Logger, setLogContext } from './core/logger'
import type { CoreAPI, UserInfo, TokenOptions, UploadOptions, MessageHandler, RpcHandler, QueueJobData } from './types/plugin'
import type { User } from './auth/AuthService'
import { poolManager } from './integration/db/connection-pool'
import { eventBus } from './integration/events/event-bus'
import { initializeEventBusService } from './integration/events/event-bus-service'
import { messageBus } from './integration/messaging/message-bus'
import { jwtAuthMiddleware, isWhitelisted } from './auth/jwt-middleware'
import { authService } from './auth/AuthService'
import { cache } from './cache-init'
import { installMetrics, requestMetricsMiddleware } from './metrics/metrics'
import { getPoolStats } from './db/pg'
import { approvalsRouter } from './routes/approvals'
import { authRouter } from './routes/auth'
import { auditLogsRouter } from './routes/audit-logs'
import { approvalHistoryRouter } from './routes/approval-history'
import { rolesRouter } from './routes/roles'
import { snapshotsRouter } from './routes/snapshots'
import changeManagementRouter from './routes/change-management'
import { permissionsRouter } from './routes/permissions'
import { filesRouter } from './routes/files'
import { spreadsheetsRouter } from './routes/spreadsheets'
import { spreadsheetPermissionsRouter } from './routes/spreadsheet-permissions'
import { eventsRouter } from './routes/events'
import internalRouter from './routes/internal'
import cacheTestRouter from './routes/cache-test'
import { initAdminRoutes } from './routes/admin-routes'
import { SnapshotService } from './services/SnapshotService'
import { cacheRegistry } from '../core/cache/CacheRegistry'
import { loadObservabilityConfig } from './config/observability'
import { initObservability } from './observability/otel'

export class MetaSheetServer {
  private app: Application
  private httpServer: HttpServer
  private io: SocketServer
  private pluginLoader: PluginLoader
  private logger: Logger
  private eventBus: EventEmitter
  private port: number
  private shuttingDown = false
  private wsAdapterType: 'local' | 'redis' = 'local'
  private wsRedis = { enabled: false, attached: false }
  private snapshotService: SnapshotService
  private observabilityShutdown?: () => Promise<void>
  private observabilityEnabled = false

  constructor() {
    this.app = express()
    this.httpServer = createServer(this.app)
    this.io = new SocketServer(this.httpServer, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST']
      }
    })
    this.eventBus = new EventEmitter()
    this.logger = new Logger('MetaSheetServer')
    this.port = parseInt(process.env.PORT || '8900')

    // 创建核心API
    const coreAPI = this.createCoreAPI()
    this.pluginLoader = new PluginLoader(coreAPI)
    this.snapshotService = new SnapshotService()

    this.setupMiddleware()
    this.setupWebSocket()
    this.initializeCache()
  }

  /**
   * 创建核心API
   */
  private createCoreAPI(): CoreAPI {
    const routes = new Map<string, RequestHandler>()

    return {
      http: {
        addRoute: (method: string, path: string, handler: RequestHandler) => {
          const key = `${method.toUpperCase()}:${path}`
          routes.set(key, handler)

          // 动态注册路由到Express
          const methodLower = method.toLowerCase() as 'get' | 'post' | 'put' | 'delete' | 'patch'
          this.app[methodLower](path,
            // 保护 /api/**（auth 白名单在全局中间件判定）
            async (req: Request, res: Response, next: NextFunction) => {
              const endTimer = (res as unknown as Record<string, unknown>).__metricsTimer as ((opts: { route: string; method: string }) => (statusCode: number) => void) | undefined
              try {
                await handler(req, res, next)
              } catch (error) {
                this.logger.error(`Route handler error: ${path}`, error as Error)
                if (!res.headersSent) {
                  res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } })
                }
              } finally {
                // 结束计时（如果已安装指标中间件）
                if (typeof endTimer === 'function') endTimer({ route: path, method: req.method })(res.statusCode)
              }
            }
          )

          this.logger.info(`Route registered: ${method} ${path}`)
        },
        removeRoute: (path: string) => {
          // Express doesn't support removing routes easily
          // In production, you'd need a more sophisticated solution
          this.logger.warn(`Route removal not implemented: ${path}`)
        },
        middleware: (_name: string) => {
          // Return middleware by name
          return undefined
        }
      },

      database: {
        query: async (sql: string, params?: unknown[]) => {
          return (await poolManager.get().query(sql, params)).rows
        },
        transaction: async <T>(callback: (trx: import('./types/plugin').DatabaseTransaction) => Promise<T>): Promise<T> => {
          return poolManager.get().transaction(async (client) => {
            // Adapt the pool client to DatabaseTransaction interface
            const trx: import('./types/plugin').DatabaseTransaction = {
              query: async (sql: string, params?: unknown[]) => {
                const result = await client.query(sql, params)
                return result.rows
              },
              commit: async () => {
                // Commit is handled by the pool manager
              },
              rollback: async () => {
                // Rollback is handled by the pool manager
              }
            }
            return callback(trx)
          })
        },
        model: (_name: string): import('./types/plugin').DatabaseModel => ({
          find: async () => [],
          findOne: async () => null,
          create: async (data) => data,
          update: async () => 0,
          delete: async () => 0
        })
      },

      auth: {
        verifyToken: async (token: string) => {
          return await authService.verifyToken(token)
        },
        checkPermission: (user: UserInfo, resource: string, action: string) => {
          // Convert UserInfo to User for authService
          const userAsUser: User = {
            id: user.id,
            email: user.email || '',
            name: user.name || '',
            role: user.roles?.[0] || 'user',
            permissions: user.permissions || [],
            created_at: new Date(),
            updated_at: new Date()
          }
          return authService.checkPermission(userAsUser, resource, action)
        },
        createToken: (user: UserInfo, _options?: TokenOptions) => {
          // Convert UserInfo to User for authService
          const userAsUser: User = {
            id: user.id,
            email: user.email || '',
            name: user.name || '',
            role: user.roles?.[0] || 'user',
            permissions: user.permissions || [],
            created_at: new Date(),
            updated_at: new Date()
          }
          return authService.createToken(userAsUser)
        }
      },

      events: {
        on: (evt: string | RegExp, handler: MessageHandler) => {
          // Adapt MessageHandler to eventBus handler signature
          const adaptedHandler = (payload: unknown) => handler(payload, evt as string)
          return eventBus.subscribe(evt as string, adaptedHandler)
        },
        once: (evt: string, handler: MessageHandler) => {
          const subscriptionId: { value: string } = { value: '' }
          const wrappedHandler = (data: unknown) => {
            handler(data, evt)
            eventBus.unsubscribe(subscriptionId.value)
          }
          subscriptionId.value = eventBus.subscribe(evt, wrappedHandler)
          return subscriptionId.value
        },
        emit: (evt: string, data?: unknown) => eventBus.emit(evt, data),
        off: (idOrPlugin: string) => eventBus.unsubscribe(idOrPlugin)
      },

      storage: {
        upload: async (_file: Buffer, _options: UploadOptions) => {
          const fileId = `file_${Date.now()}`
          this.logger.info(`File uploaded: ${fileId}`)
          return fileId
        },
        download: async (_fileId: string) => {
          return Buffer.from('mock file content')
        },
        delete: async (fileId: string) => {
          this.logger.info(`File deleted: ${fileId}`)
        },
        getUrl: (fileId: string) => {
          return `http://localhost:${this.port}/files/${fileId}`
        }
      },

      cache: {
        get: async <T = unknown>(key: string): Promise<T | null> => {
          const result = await cache.get(key)
          return result.ok ? (result.value as T) : null
        },
        set: async <T = unknown>(key: string, value: T, ttl?: number): Promise<void> => {
          await cache.set(key, value, ttl)
        },
        delete: async (key: string): Promise<void> => {
          await cache.del(key)
        },
        clear: async (): Promise<void> => {
          // 清空缓存 - 对于内存缓存，需要扩展API
          this.logger.warn('Cache clear not implemented for all cache types')
        }
      },

      queue: {
        push: async <T = unknown>(job: QueueJobData | T): Promise<string> => {
          const jobId = `job_${Date.now()}`
          this.logger.info(`Job queued: ${jobId}`, { job })
          return jobId
        },
        process: <T = unknown>(type: string, _handler: (job: import('./types/plugin').Job<T>) => Promise<unknown>) => {
          this.logger.info(`Queue processor registered: ${type}`)
        },
        cancel: async (jobId: string) => {
          this.logger.info(`Job cancelled: ${jobId}`)
        }
      },

      websocket: {
        broadcast: (event: string, data: unknown) => {
          this.io.emit(event, data)
        },
        sendTo: (userId: string, event: string, data: unknown) => {
          this.io.to(userId).emit(event, data)
        },
        onConnection: (handler: (socket: import('./types/plugin').SocketInfo) => void | Promise<void>) => {
          this.io.on('connection', handler as (socket: unknown) => void)
        }
      },
      messaging: {
        publish: <T = unknown>(topic: string, payload: T, opts?: import('./types/plugin').PublishOptions) => {
          // Adapt PublishOptions - messageBus uses MessagePriority string, plugin uses number
          const adaptedOpts = opts ? {
            ...opts,
            priority: opts.priority !== undefined
              ? (opts.priority <= 3 ? 'low' : opts.priority <= 6 ? 'normal' : 'high') as 'low' | 'normal' | 'high'
              : undefined
          } : undefined
          messageBus.publish(topic, payload, adaptedOpts)
        },
        subscribe: <T = unknown>(topic: string, handler: MessageHandler<T>) => {
          // Adapt MessageHandler to messageBus Handler signature
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const adaptedHandler = (msg: any) => handler(msg.payload as T, msg.topic)
          return messageBus.subscribe(topic, adaptedHandler)
        },
        subscribePattern: <T = unknown>(pattern: string, handler: MessageHandler<T>) => {
          // Adapt MessageHandler to messageBus Handler signature
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const adaptedHandler = (msg: any) => handler(msg.payload as T, msg.topic)
          return messageBus.subscribePattern(pattern, adaptedHandler)
        },
        unsubscribe: (id: string) => messageBus.unsubscribe(id),
        request: <T = unknown, R = unknown>(topic: string, payload: T, timeoutMs?: number): Promise<R> => messageBus.request(topic, payload, timeoutMs),
        rpcHandler: <T = unknown, R = unknown>(topic: string, handler: RpcHandler<T, R>) => messageBus.createRpcHandler(topic, handler)
      }
    }
  }

  /**
   * 配置中间件
   */
  private setupMiddleware(): void {
    // CORS
    this.app.use(cors())

    // 请求上下文（requestId + trace bridge）
    this.app.use((req, _res, next) => {
      const requestId = (req.headers['x-request-id'] as string) || crypto.randomUUID()
      setLogContext({ requestId })
      next()
    })

    // Body parsing
    this.app.use(express.json({ limit: '10mb' }))
    this.app.use(express.urlencoded({ extended: true }))

    // 指标端点与请求指标（尽早注册）
    installMetrics(this.app)
    this.app.use(requestMetricsMiddleware)

    // Production safety guards
    if (process.env.NODE_ENV === 'production') {
      if (process.env.ALLOW_UNSAFE_ADMIN === 'true') {
        this.logger.error('FATAL: ALLOW_UNSAFE_ADMIN=true in production')
        process.exit(1)
      }
      if (process.env.ENABLE_FALLBACK_TEST === 'true') {
        this.logger.warn('WARNING: ENABLE_FALLBACK_TEST should be false in production')
      }
    }

    // 请求日志
    this.app.use((req, res, next) => {
      this.logger.info(`${req.method} ${req.path}`)
      next()
    })

    // 全局 JWT 保护 `/api/**`（白名单在中间件内判定）
    this.app.use((req: Request, res: Response, next: NextFunction) => {
      if (isWhitelisted(req.path)) return next()
      if (req.path.startsWith('/api/')) return jwtAuthMiddleware(req, res, next)
      return next()
    })

    // 健康检查
    this.app.get('/health', (req, res) => {
      const endTimer = (res as unknown as Record<string, unknown>).__metricsTimer as ((opts: { route: string; method: string }) => (statusCode: number) => void) | undefined
      try {
        const stats = getPoolStats()
        // 尽量不破坏现有字段，同时补充插件摘要，便于快速可见
        let pluginsSummary: Record<string, unknown> | undefined = undefined
        try {
          // 与 /api/plugins 的 summary 保持一致结构
          pluginsSummary = (this.pluginLoader as unknown as Record<string, () => Record<string, unknown>>).getSummary?.()
        } catch { /* ignore plugin summary errors */ }
        res.json({
          status: 'ok',
          timestamp: new Date().toISOString(),
          plugins: this.pluginLoader.getPlugins().size,
          pluginsSummary: pluginsSummary || undefined,
          dbPool: stats || undefined,
          wsAdapter: this.wsAdapterType,
          redis: this.wsRedis
        })
        endTimer?.({ route: '/health', method: 'GET' })(200)
      } catch (err) {
        endTimer?.({ route: '/health', method: 'GET' })(500)
        throw err
      }
    })

    // 路由：认证（登录/注册/token管理）
    this.app.use('/api/auth', authRouter)

    // 路由：审批（示例）
    this.app.use(approvalsRouter())
    // 路由：审计日志（管理员）
    this.app.use(auditLogsRouter())
    // 路由：审批历史（从审计表衍生）
    this.app.use(approvalHistoryRouter())
    // 路由：角色/权限/表/文件/表权限（占位）
    this.app.use(rolesRouter())
    this.app.use(permissionsRouter())
    this.app.use(filesRouter())
    this.app.use(spreadsheetsRouter())
    this.app.use(spreadsheetPermissionsRouter())
    // 路由：快照（Snapshot MVP）
    this.app.use(snapshotsRouter())

    // 路由：变更管理 (Sprint 3)
    this.app.use('/api', changeManagementRouter)

    // 路由：事件总线
    this.app.use(eventsRouter())

    // 路由：内部调试端点 (dev/staging only)
    this.app.use('/internal', internalRouter)
    // 路由：降级测试端点 (dev only)
    // 使用静态导入，避免在某些运行环境中 transpile 为顶层 await 导致语法错误
    // 动态导入（无需使用 await，避免编译为顶层 await）
    try {
      import('./routes/fallback-test')
        .then(m => {
          if (m?.default) this.app.use(m.default)
        })
        .catch(() => { /* fallback-test route not available */ })
    } catch { /* dynamic import error */ }

    // 路由：缓存测试端点 (dev only)
    this.app.use('/api/cache-test', cacheTestRouter)

    // 路由：模拟错误 (用于观测 HTTP 成功率下降 & Burn Rate 测试，仅在非生产且允许不安全 admin 时暴露)
    if (process.env.ALLOW_UNSAFE_ADMIN === 'true') {
      this.app.get('/api/sim-error', (req, res) => {
        const endTimer = (res as unknown as Record<string, unknown>).__metricsTimer as ((opts: { route: string; method: string }) => (statusCode: number) => void) | undefined
        endTimer?.({ route: '/api/sim-error', method: 'GET' })(500)
        res.status(500).json({ ok: false, error: { code: 'SIMULATED_ERROR', message: 'Simulated failure' } })
      })
    }

    // 路由：管理员端点 (带 SafetyGuard 保护)
    this.app.use('/api/admin', initAdminRoutes({
      pluginLoader: this.pluginLoader,
      snapshotService: this.snapshotService
    }))

    // V2 测试端点
    this.app.get('/api/v2/hello', (req, res) => {
      const endTimer = (res as unknown as Record<string, unknown>).__metricsTimer as ((opts: { route: string; method: string }) => (statusCode: number) => void) | undefined
      try {
        res.json({ ok: true, message: 'Hello from MetaSheet V2!', version: '2.0.0-alpha.1' })
        endTimer?.({ route: '/api/v2/hello', method: 'GET' })(200)
      } catch (err) {
        endTimer?.({ route: '/api/v2/hello', method: 'GET' })(500)
        throw err
      }
    })

    this.app.get('/api/v2/rpc-test', async (req, res) => {
      const endTimer = (res as unknown as Record<string, unknown>).__metricsTimer as ((opts: { route: string; method: string }) => (statusCode: number) => void) | undefined
      try {
        // 测试 RPC 功能
        const testTopic = 'test.rpc'
        const testPayload = { message: 'ping' }

        // 创建测试 RPC handler
        messageBus.createRpcHandler(testTopic, async (payload: { message: string }) => {
          return { ok: true, echo: payload, timestamp: Date.now() }
        })

        // 发送 RPC 请求
        const result = await messageBus.request(testTopic, testPayload, 1000)
        res.json({ ok: true, rpcTest: 'passed', result })
        endTimer?.({ route: '/api/v2/rpc-test', method: 'GET' })(200)
      } catch (error: unknown) {
        res.json({ ok: true, rpcTest: 'skipped', reason: error instanceof Error ? error.message : String(error) })
        endTimer?.({ route: '/api/v2/rpc-test', method: 'GET' })(200)
      }
    })

    // 插件信息
    this.app.get('/api/plugins', (req, res) => {
      const endTimer = (res as unknown as Record<string, unknown>).__metricsTimer as ((opts: { route: string; method: string }) => (statusCode: number) => void) | undefined
      try {
        const list = (this.pluginLoader as unknown as Record<string, () => unknown[]>).getList?.() || []
        const summary = (this.pluginLoader as unknown as Record<string, () => Record<string, unknown>>).getSummary?.() || {}
        res.json({ list, summary })
        endTimer?.({ route: '/api/plugins', method: 'GET' })(200)
      } catch (e: unknown) {
        res.json({ list: [], summary: { error: e instanceof Error ? e.message : String(e) } })
        endTimer?.({ route: '/api/plugins', method: 'GET' })(500)
      }
    })

    // Metrics (JSON minimal)
    this.app.get('/internal/metrics', async (_req, res) => {
      const endTimer = (res as unknown as Record<string, unknown>).__metricsTimer as ((opts: { route: string; method: string }) => (statusCode: number) => void) | undefined
      try {
        const { coreMetrics } = await import('./integration/metrics/metrics')
        res.json(coreMetrics.get())
        endTimer?.({ route: '/internal/metrics', method: 'GET' })(200)
      } catch (err) {
        endTimer?.({ route: '/internal/metrics', method: 'GET' })(500)
        throw err
      }
    })

    // Note: /metrics/prom endpoint is registered by installMetrics() in setupMiddleware()
  }

  /**
   * 配置WebSocket
   */
  private setupWebSocket(): void {
    if (process.env.WS_REDIS_ENABLED === 'true') {
      this.wsRedis.enabled = true
      this.logger.info('WS_REDIS_ENABLED=true; local adapter active (no Redis wiring yet)')
    }
    this.io.on('connection', (socket) => {
      this.logger.info(`WebSocket client connected: ${socket.id}`)

      socket.on('disconnect', () => {
        this.logger.info(`WebSocket client disconnected: ${socket.id}`)
      })

      // 测试事件
      socket.on('ping', () => {
        socket.emit('pong', { timestamp: Date.now() })
      })
    })
  }

  /**
   * 初始化缓存 (Phase 1)
   *
   * Phase 1: Always use NullCache for observability
   * Phase 3: Will register RedisCache here based on feature flag
   */
  private initializeCache(): void {
    // Phase 1: NullCache is already default in CacheRegistry
    const enabled = process.env.FEATURE_CACHE === 'true'
    this.logger.info(`Cache: ${enabled ? 'observing' : 'disabled'} (impl: ${cacheRegistry.getStatus().implName})`)

    // Phase 3: Plugin will register RedisCache when FEATURE_CACHE_REDIS=true
  }

  /**
   * 获取服务器地址
   */
  getAddress() {
    return this.httpServer.address()
  }

  /**
   * 停止服务器
   */
  async stop(signal = 'SIGTERM'): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    this.logger.info(`Received ${signal}, shutting down gracefully...`)

    const shutdownTasks: Promise<void>[] = []

    // 1. Close HTTP server
    shutdownTasks.push(new Promise<void>((resolve) => {
      try {
        if (this.httpServer.listening) {
          this.httpServer.close((err: Error | undefined) => {
            if (err) {
              this.logger.warn(`HTTP server close error: ${err.message}`)
            } else {
              this.logger.info('HTTP server closed')
            }
            resolve()
          })
        } else {
          resolve()
        }
      } catch (err) {
        this.logger.warn(`HTTP server close error: ${err instanceof Error ? err.message : String(err)}`)
        resolve()
      }
    }))

    // 2. Close database pool
    shutdownTasks.push((async () => {
      try {
        const { pool } = await import('./db/pg')
        if (pool) {
          await pool.end()
          this.logger.info('Database pool closed')
        }
      } catch (err) {
        this.logger.warn(`Database pool close error: ${err instanceof Error ? err.message : String(err)}`)
      }
    })())

    // 3. Unload plugins gracefully
    shutdownTasks.push((async () => {
      try {
        await this.pluginLoader.unloadAll()
        this.logger.info('Plugins unloaded')
      } catch (err) {
        this.logger.warn(`Plugin unload error: ${err instanceof Error ? err.message : String(err)}`)
      }
    })())

    // 4. Shutdown observability SDK if enabled
    if (this.observabilityShutdown) {
      shutdownTasks.push((async () => {
        try {
          await this.observabilityShutdown?.()
          this.logger.info('Observability shutdown complete')
        } catch (err) {
          this.logger.warn(`Observability shutdown failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      })())
    }

    // 4. Destroy API Gateway resources
    // shutdownTasks.push((async () => {
    //   try {
    //     this.apiGateway.destroy()
    //     this.logger.info('API Gateway resources released')
    //   } catch (err) {
    //     this.logger.warn(`API Gateway cleanup error: ${err instanceof Error ? err.message : String(err)}`)
    //   }
    // })())

    // Wait for all shutdown tasks with timeout
    await Promise.race([
      Promise.all(shutdownTasks),
      new Promise<void>((resolve) => setTimeout(() => {
        this.logger.warn('Shutdown timeout, forcing exit')
        resolve()
      }, 10000)) // 10 second timeout
    ])

    this.logger.info('Shutdown complete')
  }

  /**
   * 启动服务器
   */
  async start(): Promise<void> {
    // 初始化可观测性（可选）
    const observabilityConfig = loadObservabilityConfig()
    try {
      const obsResult = await initObservability(observabilityConfig, this.logger)
      this.observabilityEnabled = obsResult.started
      this.observabilityShutdown = obsResult.shutdown
    } catch (err) {
      this.logger.error('OpenTelemetry initialization failed', err as Error)
      if (observabilityConfig.strict) {
        throw err
      }
    }

    // 初始化EventBusService (允许降级跳过以保证度量端可用)
    if (process.env.DISABLE_EVENT_BUS === 'true') {
      this.logger.warn('Skipping EventBusService initialization (DISABLE_EVENT_BUS=true)')
    } else {
      this.logger.info('Initializing EventBusService...')
      const coreAPI = this.createCoreAPI()
      try {
        await initializeEventBusService(coreAPI)
      } catch (e) {
        // 降级容错：记录错误但继续启动，使 Redis / metrics 在缺表或总线故障时仍可观测
        this.logger.error('EventBusService initialization failed; continuing in degraded mode', e as Error)
      }
    }

    // 加载插件并启动 HTTP 服务
    if (process.env.SKIP_PLUGINS === 'true') {
      this.logger.warn('Skipping plugin load (SKIP_PLUGINS=true)')
    } else {
      this.logger.info('Loading plugins...')
      try {
        await this.pluginLoader.loadPlugins()
        this.logger.info('Plugins loaded successfully')
      } catch (e) {
        this.logger.error('Plugin loading failed; continuing startup without full plugin set', e as Error)
      }
    }

    this.logger.info('Starting HTTP server listen phase...')
    this.httpServer.listen(this.port, () => {
      this.logger.info(`MetaSheet v2 core listening on http://localhost:${this.port}`)
      this.logger.info(`Health:  http://localhost:${this.port}/health`)
      this.logger.info(`Metrics: http://localhost:${this.port}/metrics/prom`)
      this.logger.info(`Plugins: http://localhost:${this.port}/api/plugins`)
      this.logger.info(`Events:  http://localhost:${this.port}/api/events`)
    })

    process.on('SIGTERM', () => this.stop('SIGTERM').then(() => process.exit(0)))
    process.on('SIGINT', () => this.stop('SIGINT').then(() => process.exit(0)))
  }
}

// 启动 - 仅在直接运行时启动服务器，测试导入时不启动
if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  const server = new MetaSheetServer()
  server.start().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to start MetaSheet v2 core:', err)
    process.exit(1)
  })
}
