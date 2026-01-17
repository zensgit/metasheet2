/**
 * MetaSheet Backend Core
 * 后端核心服务器入口
 */

import type { Application, Request, Response, NextFunction, RequestHandler } from 'express';
import type { Server as HttpServer } from 'http';
import express from 'express'
import { createServer } from 'http'
import cors from 'cors'
import crypto from 'crypto'
import { EventEmitter } from 'eventemitter3'
import { Injector } from '@wendellhu/redi' // IoC Container
import { createContainer } from './di/container'
import { IConfigService, ILogger, ICollabService, ICoreAPI, IPluginLoader, ICollectionManager, IPLMAdapter, IAthenaAdapter, IDedupCADAdapter, ICADMLAdapter, IVisionAdapter, IFormulaService } from './di/identifiers'
import { PluginLoader, type LoadedPlugin } from './core/plugin-loader'
import { Logger, setLogContext } from './core/logger'
import type { CoreAPI, UserInfo, TokenOptions, UploadOptions, MessageHandler, RpcHandler, QueueJobData, PluginContext, PluginApiMethod, PluginCommunication, PluginStorage } from './types/plugin'
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
import { poolManager } from './integration/db/connection-pool'
import { approvalsRouter } from './routes/approvals'
import { authRouter } from './routes/auth'
import { auditLogsRouter } from './routes/audit-logs'
import { approvalHistoryRouter } from './routes/approval-history'
import { rolesRouter } from './routes/roles'
import { snapshotsRouter } from './routes/snapshots'
import snapshotLabelsRouter from './routes/snapshot-labels'
import changeManagementRouter from './routes/change-management'
import { permissionsRouter } from './routes/permissions'
import { filesRouter } from './routes/files'
import { spreadsheetsRouter } from './routes/spreadsheets'
import { spreadsheetPermissionsRouter } from './routes/spreadsheet-permissions'
import { eventsRouter } from './routes/events'
import { commentsRouter } from './routes/comments'
import { dataSourcesRouter, getDataSourceManager } from './routes/data-sources'
import { federationRouter } from './routes/federation'
import internalRouter from './routes/internal'
import cacheTestRouter from './routes/cache-test'
import { kanbanRouter } from './routes/kanban'
import { viewsRouter } from './routes/views'
import { initAdminRoutes } from './routes/admin-routes'
import { getSafetyGuard } from './guards'
import workflowRouter from './routes/workflow'
import workflowDesignerRouter from './routes/workflow-designer'
import { univerMockRouter } from './routes/univer-mock'
import { univerMetaRouter } from './routes/univer-meta'
import { SnapshotService } from './services/SnapshotService'
import { cacheRegistry } from '../core/cache/CacheRegistry'
import { loadObservabilityConfig } from './config/observability'
import { initObservability } from './observability/otel'

export class MetaSheetServer {
  private app: Application
  private httpServer: HttpServer
  private logger: Logger
  private eventBus: EventEmitter
  private pluginStatus = new Map<string, { status: 'active' | 'inactive' | 'failed'; error?: string; lastAttempt?: string }>()
  private pluginApis = new Map<string, Record<string, PluginApiMethod>>()
  private port: number
  private host?: string
  private portLocked: boolean
  private shuttingDown = false
  private snapshotService: SnapshotService
  private observabilityShutdown?: () => Promise<void>
  private observabilityEnabled = false
  private pluginContexts = new Map<string, PluginContext>()
  // Optional bypass/degraded-mode flags for local debug
  private disableWorkflow = process.env.DISABLE_WORKFLOW === 'true'
  private disableEventBus = process.env.DISABLE_EVENT_BUS === 'true'
  
  // IoC Container
  private injector: Injector

  // Helper to get PluginLoader from container
  private get pluginLoader(): PluginLoader {
    return this.injector.get(IPluginLoader)
  }

  constructor(options: { port?: number; host?: string; pluginDirs?: string[] } = {}) {
    // Initialize IoC Container
    this.injector = createContainer({ pluginDirs: options.pluginDirs })
    
    this.app = express()
    this.httpServer = createServer(this.app)
    this.eventBus = new EventEmitter()
    this.logger = new Logger('MetaSheetServer')
    this.portLocked = typeof options.port === 'number'
    this.port = options.port ?? parseInt(process.env.PORT || '7778')
    this.host = options.host ?? process.env.HOST

    // 创建核心API
    const coreAPI = this.createCoreAPI()
    
    // Bind CoreAPI to container (needed by PluginLoader)
    this.injector.add([ICoreAPI, { useValue: coreAPI }])
    
    this.snapshotService = new SnapshotService()

    this.setupMiddleware()
    // WebSocket setup is now handled by CollabService via start()
    this.initializeCache()
  }

  /**
   * 创建核心API
   */

  private createCoreAPI(): CoreAPI {
    const routes = new Map<string, RequestHandler>()

    return {
      injector: this.injector,
      formula: {
        calculate: (name, ...args) => this.injector.get(IFormulaService).calculate(name, ...args),
        calculateFormula: (exp, resolver) => this.injector.get(IFormulaService).calculateFormula(exp, resolver),
        getAvailableFunctions: () => this.injector.get(IFormulaService).getAvailableFunctions()
      },
      collection: {
        register: (definition) => {
          this.injector.get(ICollectionManager).register(definition)
        },
        getRepository: (name) => {
          return this.injector.get(ICollectionManager).getRepository(name)
        },
        sync: async () => {
          await this.injector.get(ICollectionManager).sync()
        }
      },

      http: {
        // ... (existing http impl)
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

      plm: {
        getProducts: (options) => this.injector.get(IPLMAdapter).getProducts(options),
        getProductBOM: (id) => this.injector.get(IPLMAdapter).getProductBOM(id)
      },

      athena: {
        listFolders: (parentId) => this.injector.get(IAthenaAdapter).listFolders(parentId),
        searchDocuments: (params) => this.injector.get(IAthenaAdapter).searchDocuments(params),
        getDocument: (id) => this.injector.get(IAthenaAdapter).getDocument(id),
        uploadDocument: (params) => this.injector.get(IAthenaAdapter).uploadDocument(params)
      },

      dedup: {
        search: (fileId, threshold) => this.injector.get(IDedupCADAdapter).search(fileId, threshold),
        compare: (sourceId, targetId) => this.injector.get(IDedupCADAdapter).compare(sourceId, targetId)
      },

      ai: {
        analyze: (fileId) => this.injector.get(ICADMLAdapter).analyze(fileId),
        extractText: (fileId) => this.injector.get(ICADMLAdapter).extractText(fileId),
        predictCost: (fileId, params) => this.injector.get(ICADMLAdapter).predictCost(fileId, params)
      },

      vision: {
        generateDiff: (sourceId, targetId) => this.injector.get(IVisionAdapter).generateDiff(sourceId, targetId)
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
          this.injector.get(ICollabService).broadcast(event, data)
        },
        broadcastTo: (room: string, event: string, data: unknown) => {
          this.injector.get(ICollabService).broadcastTo(room, event, data)
        },
        broadcastToRoom: (room: string, event: string, data: unknown) => {
          this.injector.get(ICollabService).broadcastTo(room, event, data)
        },
        sendTo: (userId: string, event: string, data: unknown) => {
          this.injector.get(ICollabService).sendTo(userId, event, data)
        },
        join: (arg1: string, arg2: string | { userId?: string }) => {
          if (typeof arg2 === 'string') {
            this.injector.get(ICollabService).joinRoom(arg1, arg2)
            return
          }
          if (arg2?.userId) {
            this.injector.get(ICollabService).joinRoom(arg1, arg2.userId)
          }
        },
        leave: (socketId: string, room: string) => {
          const collab = this.injector.get(ICollabService)
          if (collab.leaveRoom) {
            collab.leaveRoom(socketId, room)
          }
        },
        onConnection: (handler: (socket: import('./types/plugin').SocketInfo) => void | Promise<void>) => {
          this.injector.get(ICollabService).onConnection(handler)
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

  private createPluginContext(loaded: LoadedPlugin, coreAPI: CoreAPI): PluginContext {
    const storageMap = new Map<string, unknown>()
    const storage: PluginStorage = {
      get: async (key: string) => storageMap.has(key) ? (storageMap.get(key) as unknown) : null,
      set: async (key: string, value: unknown) => {
        storageMap.set(key, value)
      },
      delete: async (key: string) => {
        storageMap.delete(key)
      },
      list: async () => Array.from(storageMap.keys())
    }

    const communication: PluginCommunication = {
      call: async (plugin: string, method: string, ...args: unknown[]) => {
        const api = this.pluginApis.get(plugin)
        if (!api || typeof api[method] !== 'function') {
          throw new Error(`Plugin API not found: ${plugin}.${method}`)
        }
        return api[method](...args)
      },
      register: (name: string, api: Record<string, PluginApiMethod>) => {
        this.pluginApis.set(name, api)
      },
      on: (event: string, handler: (...args: unknown[]) => void | Promise<void>) => {
        this.eventBus.on(event, handler)
      },
      emit: (event: string, data?: unknown) => {
        this.eventBus.emit(event, data)
      }
    }

    const rawAuthor = loaded.manifest.author
    const author = typeof rawAuthor === 'string'
      ? rawAuthor
      : (rawAuthor && typeof rawAuthor === 'object' ? (rawAuthor as { name?: string }).name : undefined)

    return {
      metadata: {
        name: loaded.manifest.name,
        version: loaded.manifest.version,
        displayName: loaded.manifest.displayName,
        description: loaded.manifest.description,
        author,
        path: loaded.path
      },
      api: coreAPI,
      core: coreAPI,
      storage,
      config: {},
      communication,
      logger: new Logger(`Plugin:${loaded.manifest.name}`)
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
          // 与 PluginLoader summary 保持一致结构
          pluginsSummary = (this.pluginLoader as unknown as Record<string, () => Record<string, unknown>>).getSummary?.()
        } catch { /* ignore plugin summary errors */ }
        res.json({
          status: 'ok',
          timestamp: new Date().toISOString(),
          plugins: this.pluginLoader.getPlugins().size,
          pluginsSummary: pluginsSummary || undefined,
          dbPool: stats || undefined
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
    this.app.use(spreadsheetsRouter(this.injector))
    this.app.use(spreadsheetPermissionsRouter())
    this.app.use(commentsRouter(this.injector))
    // 路由：看板（Kanban MVP API）
    this.app.use('/api/kanban', kanbanRouter())
    // 路由：快照标签/保护
    this.app.use('/api/snapshots', snapshotLabelsRouter)
    // 路由：快照（Snapshot MVP）
    this.app.use(snapshotsRouter())

    // 路由：变更管理 (Sprint 3)
    this.app.use('/api', changeManagementRouter)

    // 路由：工作流引擎 (V2 BPMN)
    this.app.use('/api/workflow', workflowRouter)
    // 路由：工作流设计器 (V2 Visual Designer)
    this.app.use('/api/workflow-designer', workflowDesignerRouter)

    // 路由：工作流 Echo/Mock API（用于前端并行开发）
    // 当后端引擎未完全就绪时，返回 echo 响应
    this.app.post('/api/workflow-mock/echo', (req, res) => {
      res.json({
        ok: true,
        echo: req.body,
        timestamp: new Date().toISOString(),
        message: 'Workflow mock endpoint - use for frontend development'
      })
    })
    this.app.get('/api/workflow-mock/status', (_req, res) => {
      res.json({
        ok: true,
        engine: 'mock',
        ready: false,
        message: 'Workflow engine is in development. Use /api/workflow for real endpoints.'
      })
    })

    // 路由：Univer Mock API（用于前端 POC，不依赖数据库；仅非生产环境启用）
    if (process.env.NODE_ENV !== 'production') {
      this.app.use('/api/univer-mock', univerMockRouter())
      // DB-backed Meta API（用于把 POC 写回真实 meta schema；仅非生产环境启用）
      this.app.use('/api/univer-meta', univerMetaRouter())
    }

    // 路由：事件总线
    this.app.use(eventsRouter())

    // 路由：外部数据源管理 (V2)
    this.app.use(dataSourcesRouter())
    // 路由：联邦集成（PLM/Athena/MetaSheet）
    this.app.use(federationRouter(this.injector))

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

    // 路由：视图管理 (V2 Unified)
    this.app.use('/api/views', viewsRouter())

    // 路由：管理员端点 (带 SafetyGuard 保护)
    this.app.use('/api/admin', initAdminRoutes({
      pluginLoader: this.pluginLoader,
      snapshotService: this.snapshotService,
      dataSourceManager: getDataSourceManager()
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
        const list = Array.from(this.pluginLoader.getPlugins().values()).map((loaded) => {
          const state = this.pluginStatus.get(loaded.manifest.name)
          return {
            name: loaded.manifest.name,
            version: loaded.manifest.version,
            displayName: loaded.manifest.displayName,
            status: state?.status ?? 'inactive',
            error: state?.error,
            lastAttempt: state?.lastAttempt,
            contributes: loaded.manifest.contributes ? { views: loaded.manifest.contributes.views } : undefined,
          }
        })
        res.json(list)
        endTimer?.({ route: '/api/plugins', method: 'GET' })(200)
      } catch (e: unknown) {
        res.json([])
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

  private async activateLoadedPlugins(): Promise<void> {
    const plugins = this.pluginLoader.getPlugins()
    const coreAPI = this.injector.get(ICoreAPI)
    for (const [name, loaded] of plugins) {
      const lastAttempt = new Date().toISOString()
      if (!loaded.plugin || typeof loaded.plugin.activate !== 'function') {
        this.pluginStatus.set(name, { status: 'inactive', lastAttempt })
        continue
      }

      const context = this.createPluginContext(loaded, coreAPI)
      try {
        await loaded.plugin.activate(context)
        this.pluginContexts.set(loaded.manifest.name, context)
        this.pluginStatus.set(name, { status: 'active', lastAttempt })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.pluginStatus.set(name, { status: 'failed', error: message, lastAttempt })
        this.logger.error(`Plugin activation failed: ${name}`, error as Error)
      }
    }
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

    // 0. Close WebSocket server early to release open handles
    shutdownTasks.push((async () => {
      try {
        const collabService = this.injector.get(ICollabService)
        await collabService.close()
        this.logger.info('WebSocket server closed')
      } catch (err) {
        this.logger.warn(`WebSocket close error: ${err instanceof Error ? err.message : String(err)}`)
      }
    })())

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

    // 2.1 Close integration connection pools
    shutdownTasks.push((async () => {
      try {
        await poolManager.close()
        this.logger.info('Integration pools closed')
      } catch (err) {
        this.logger.warn(`Integration pool close error: ${err instanceof Error ? err.message : String(err)}`)
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

    // 3.1 Shutdown SafetyGuard timers
    shutdownTasks.push((async () => {
      try {
        const guard = getSafetyGuard()
        guard.destroy()
        this.logger.info('SafetyGuard destroyed')
      } catch (err) {
        this.logger.warn(`SafetyGuard shutdown error: ${err instanceof Error ? err.message : String(err)}`)
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
    // IoC: Load configuration
    if (!this.portLocked) {
      try {
        const configService = this.injector.get(IConfigService)
        const configPort = await configService.get<number>('app.port')
        if (typeof configPort === 'number') {
          this.port = configPort
          this.logger.info(`Port configured via ConfigService: ${this.port}`)
        }
      } catch (e) {
        this.logger.warn(`Failed to load config from IoC container, using default/env port: ${this.port}`, e as Error)
      }
    }

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
    if (this.disableEventBus) {
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
        await this.activateLoadedPlugins()
        this.logger.info('Plugins loaded successfully')
      } catch (e) {
        this.logger.error('Plugin loading failed; continuing startup without full plugin set', e as Error)
      }
    }

    // Initialize WebSocket Service
    try {
      const collabService = this.injector.get(ICollabService)
      collabService.initialize(this.httpServer)
    } catch (e) {
      this.logger.error('Failed to initialize WebSocket service', e as Error)
    }

    this.logger.info('Starting HTTP server listen phase...')
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          this.logger.error(`Port ${this.port} is already in use. Stop the process using it or set PORT to another value.`)
        } else if (err.code === 'EACCES') {
          this.logger.error(`Permission denied binding to port ${this.port}. Try a higher port or check permissions.`)
        } else {
          this.logger.error('HTTP server error', err)
        }
        reject(err)
      }

      this.httpServer.once('error', onError)
      const onListening = () => {
        this.httpServer.off('error', onError)

        // If port=0, update port to actual assigned port
        const addr = this.httpServer.address()
        if (addr && typeof addr === 'object') {
          this.port = addr.port
        }

        const displayHost = this.host ?? 'localhost'
        this.logger.info(`MetaSheet v2 core listening on http://${displayHost}:${this.port}`)
        this.logger.info(`Health:  http://${displayHost}:${this.port}/health`)
        this.logger.info(`Metrics: http://${displayHost}:${this.port}/metrics/prom`)
        this.logger.info(`Plugins: http://${displayHost}:${this.port}/api/plugins`)
        this.logger.info(`Events:  http://${displayHost}:${this.port}/api/events`)
        resolve()
      }

      // Preserve previous behavior: if no host specified, listen on all interfaces.
      if (this.host) {
        this.httpServer.listen(this.port, this.host, onListening)
      } else {
        this.httpServer.listen(this.port, onListening)
      }
    })

    // Register signal handlers only for real runtime, not test runners.
    if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
      process.on('SIGTERM', () => this.stop('SIGTERM').then(() => process.exit(0)))
      process.on('SIGINT', () => this.stop('SIGINT').then(() => process.exit(0)))
    }
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

// ============================================================
// View Provider System Exports
// ============================================================

// View Config Provider exports
export { getViewConfigRegistry, registerViewConfigProvider, unregisterViewConfigProvider } from './core/view-config-registry'
export type { ViewConfigProvider, ViewConfigProviderRegistry, DatabasePool, BaseViewConfig, GalleryViewConfig, CalendarViewConfig, KanbanViewConfig } from './types/view-config'

// View Data Provider exports
export { getViewDataRegistry, registerViewDataProvider, unregisterViewDataProvider } from './core/view-data-registry'
export { getDefaultViewDataProvider, DefaultViewDataProvider } from './core/default-view-data-provider'
export type { ViewDataProvider, ViewDataProviderRegistry, DataPool, ViewDataContext, ViewDataQueryOptions, ViewDataResult, FilterCondition, SortOptions, PaginationOptions } from './types/view-data'

// Convenience exports from views router
export { registerViewConfigProviderSync, registerViewDataProviderSync } from './routes/views'

// ============================================================
// Plugin System Exports (Sprint 7)
// ============================================================

// Plugin Loader exports
export { PluginLoader } from './core/plugin-loader'
export type { LoadOptions, LoadedPlugin, CascadeReloadOptions, CascadeReloadResult } from './core/plugin-loader'

// Plugin State Manager exports (Hot Swap)
export {
  PluginStateManager,
  getPluginStateManager,
  resetPluginStateManager
} from './core/plugin-state-manager'
export type {
  PluginState,
  StateSerializer,
  HotSwapHooks,
  StateSaveOptions,
  StateRestoreResult
} from './core/plugin-state-manager'

// ============================================================
// Audit System Exports (Sprint 7 Day 2)
// ============================================================

// AuditService exports
export { AuditService } from './audit/AuditService'
export type {
  AuditContext,
  AuditOptions,
  AuditLogFilters,
  UserActivitySummary,
  SecurityEventSummary,
  DataChange,
  AuditMessageEvent
} from './audit/AuditService'

// AuditLogSubscriber exports (JSON Lines file writer)
export {
  AuditLogSubscriber,
  createAuditLogSubscriber
} from './audit/AuditLogSubscriber'
export type {
  AuditLogSubscriberOptions,
  AuditLogStats
} from './audit/AuditLogSubscriber'

// Health Aggregation Exports (Sprint 7 Day 4)
export {
  HealthAggregatorService,
  getHealthAggregator,
  resetHealthAggregator
} from './services/HealthAggregatorService'
export type {
  HealthStatus,
  SubsystemHealth,
  DatabaseHealth,
  MessageBusHealth,
  PluginSystemHealth,
  RateLimitingHealth,
  SystemResourceHealth,
  AggregatedHealth,
  HealthAggregatorConfig
} from './services/HealthAggregatorService'
