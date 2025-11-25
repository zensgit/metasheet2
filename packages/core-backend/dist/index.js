/**
 * MetaSheet Backend Core
 * 后端核心服务器入口
 */
import express from 'express';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import cors from 'cors';
import { EventEmitter } from 'eventemitter3';
import { PluginLoader } from './core/plugin-loader';
import { Logger } from './core/logger';
import { poolManager } from './integration/db/connection-pool';
import { eventBus } from './integration/events/event-bus';
import { initializeEventBusService } from './integration/events/event-bus-service';
import { messageBus } from './integration/messaging/message-bus';
import { jwtAuthMiddleware, isWhitelisted } from './auth/jwt-middleware';
import { installMetrics, requestMetricsMiddleware } from './metrics/metrics';
import { getPoolStats } from './db/pg';
import { approvalsRouter } from './routes/approvals';
import { auditLogsRouter } from './routes/audit-logs';
import { approvalHistoryRouter } from './routes/approval-history';
import { rolesRouter } from './routes/roles';
import { snapshotsRouter } from './routes/snapshots';
import { permissionsRouter } from './routes/permissions';
import { filesRouter } from './routes/files';
import { spreadsheetsRouter } from './routes/spreadsheets';
import { spreadsheetPermissionsRouter } from './routes/spreadsheet-permissions';
import { eventsRouter } from './routes/events';
import internalRouter from './routes/internal';
import cacheTestRouter from './routes/cache-test';
import { initAdminRoutes } from './routes/admin-routes';
import { SnapshotService } from './services/SnapshotService';
import { cacheRegistry } from '../core/cache/CacheRegistry';
class MetaSheetServer {
    app;
    httpServer;
    io;
    pluginLoader;
    logger;
    eventBus;
    port;
    shuttingDown = false;
    wsAdapterType = 'local';
    wsRedis = { enabled: false, attached: false };
    snapshotService;
    constructor() {
        this.app = express();
        this.httpServer = createServer(this.app);
        this.io = new SocketServer(this.httpServer, {
            cors: {
                origin: '*',
                methods: ['GET', 'POST']
            }
        });
        this.eventBus = new EventEmitter();
        this.logger = new Logger('MetaSheetServer');
        this.port = parseInt(process.env.PORT || '8900');
        // 创建核心API
        const coreAPI = this.createCoreAPI();
        this.pluginLoader = new PluginLoader(coreAPI);
        this.snapshotService = new SnapshotService();
        this.setupMiddleware();
        this.setupWebSocket();
        this.initializeCache();
    }
    /**
     * 创建核心API
     */
    createCoreAPI() {
        const routes = new Map();
        return {
            http: {
                addRoute: (method, path, handler) => {
                    const key = `${method.toUpperCase()}:${path}`;
                    routes.set(key, handler);
                    // 动态注册路由到Express
                    const methodLower = method.toLowerCase();
                    this.app[methodLower](path, 
                    // 保护 /api/**（auth 白名单在全局中间件判定）
                    async (req, res) => {
                        const endTimer = res.__metricsTimer?.({ route: path, method: req.method });
                        try {
                            await handler(req, res);
                        }
                        catch (error) {
                            this.logger.error(`Route handler error: ${path}`, error);
                            if (!res.headersSent) {
                                res.status(500).json({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
                            }
                        }
                        finally {
                            // 结束计时（如果已安装指标中间件）
                            if (typeof endTimer === 'function')
                                endTimer(res.statusCode);
                        }
                    });
                    this.logger.info(`Route registered: ${method} ${path}`);
                },
                removeRoute: (path) => {
                    // Express doesn't support removing routes easily
                    // In production, you'd need a more sophisticated solution
                    this.logger.warn(`Route removal not implemented: ${path}`);
                },
                middleware: (name) => {
                    // Return middleware by name
                    return undefined;
                }
            },
            database: {
                query: async (sql, params) => {
                    return (await poolManager.get().query(sql, params)).rows;
                },
                transaction: async (callback) => {
                    return poolManager.get().transaction(async (client) => callback(client));
                },
                model: (_name) => ({})
            },
            auth: {
                verifyToken: async (token) => {
                    // 暂时返回模拟用户
                    return { id: '1', name: 'Test User', email: 'test@metasheet.com' };
                },
                checkPermission: (user, resource, action) => {
                    // 暂时全部允许
                    return true;
                },
                createToken: (user, options) => {
                    return 'mock-jwt-token';
                }
            },
            events: {
                on: (evt, handler) => eventBus.subscribe(evt, handler),
                once: (evt, handler) => {
                    const wrappedHandler = (data) => {
                        handler(data);
                        eventBus.unsubscribe(subscriptionId);
                    };
                    const subscriptionId = eventBus.subscribe(evt, wrappedHandler);
                    return subscriptionId;
                },
                emit: (evt, data) => eventBus.emit(evt, data),
                off: (idOrPlugin) => eventBus.unsubscribe(idOrPlugin)
            },
            storage: {
                upload: async (file, options) => {
                    const fileId = `file_${Date.now()}`;
                    this.logger.info(`File uploaded: ${fileId}`);
                    return fileId;
                },
                download: async (fileId) => {
                    return Buffer.from('mock file content');
                },
                delete: async (fileId) => {
                    this.logger.info(`File deleted: ${fileId}`);
                },
                getUrl: (fileId) => {
                    return `http://localhost:${this.port}/files/${fileId}`;
                }
            },
            cache: {
                get: async (key) => {
                    // 暂时用内存缓存
                    return undefined;
                },
                set: async (key, value, ttl) => {
                    // 暂时用内存缓存
                },
                delete: async (key) => {
                    // 暂时用内存缓存
                },
                clear: async () => {
                    // 清空缓存
                }
            },
            queue: {
                push: async (job) => {
                    const jobId = `job_${Date.now()}`;
                    this.logger.info(`Job queued: ${jobId}`);
                    return jobId;
                },
                process: (type, handler) => {
                    this.logger.info(`Queue processor registered: ${type}`);
                },
                cancel: async (jobId) => {
                    this.logger.info(`Job cancelled: ${jobId}`);
                }
            },
            websocket: {
                broadcast: (event, data) => {
                    this.io.emit(event, data);
                },
                sendTo: (userId, event, data) => {
                    this.io.to(userId).emit(event, data);
                },
                onConnection: (handler) => {
                    this.io.on('connection', handler);
                }
            },
            messaging: {
                publish: (topic, payload, opts) => messageBus.publish(topic, payload, opts),
                subscribe: (topic, handler) => messageBus.subscribe(topic, handler),
                subscribePattern: (pattern, handler) => messageBus.subscribePattern(pattern, handler),
                unsubscribe: (id) => messageBus.unsubscribe(id),
                request: (topic, payload, timeoutMs) => messageBus.request(topic, payload, timeoutMs),
                rpcHandler: (topic, handler) => messageBus.createRpcHandler(topic, handler)
            }
        };
    }
    /**
     * 配置中间件
     */
    setupMiddleware() {
        // CORS
        this.app.use(cors());
        // Body parsing
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true }));
        // 指标端点与请求指标（尽早注册）
        installMetrics(this.app);
        this.app.use(requestMetricsMiddleware);
        // 请求日志
        this.app.use((req, res, next) => {
            this.logger.info(`${req.method} ${req.path}`);
            next();
        });
        // 全局 JWT 保护 `/api/**`（白名单在中间件内判定）
        this.app.use((req, res, next) => {
            if (isWhitelisted(req.path))
                return next();
            if (req.path.startsWith('/api/'))
                return jwtAuthMiddleware(req, res, next);
            return next();
        });
        // 健康检查
        this.app.get('/health', (req, res) => {
            const endTimer = res.__metricsTimer?.({ route: '/health', method: 'GET' });
            try {
                const stats = getPoolStats();
                // 尽量不破坏现有字段，同时补充插件摘要，便于快速可见
                let pluginsSummary = undefined;
                try {
                    // 与 /api/plugins 的 summary 保持一致结构
                    pluginsSummary = this.pluginLoader.getSummary?.();
                }
                catch { }
                res.json({
                    status: 'ok',
                    timestamp: new Date().toISOString(),
                    plugins: this.pluginLoader.getPlugins().size,
                    pluginsSummary: pluginsSummary || undefined,
                    dbPool: stats || undefined,
                    wsAdapter: this.wsAdapterType,
                    redis: this.wsRedis
                });
                endTimer?.(200);
            }
            catch (err) {
                endTimer?.(500);
                throw err;
            }
        });
        // 路由：审批（示例）
        this.app.use(approvalsRouter());
        // 路由：审计日志（管理员）
        this.app.use(auditLogsRouter());
        // 路由：审批历史（从审计表衍生）
        this.app.use(approvalHistoryRouter());
        // 路由：角色/权限/表/文件/表权限（占位）
        this.app.use(rolesRouter());
        this.app.use(permissionsRouter());
        this.app.use(filesRouter());
        this.app.use(spreadsheetsRouter());
        this.app.use(spreadsheetPermissionsRouter());
        // 路由：快照（Snapshot MVP）
        this.app.use(snapshotsRouter());
        // 路由：事件总线
        this.app.use(eventsRouter());
        // 路由：内部调试端点 (dev/staging only)
        this.app.use('/internal', internalRouter);
        // 路由：降级测试端点 (dev only)
        try {
            import('./routes/fallback-test')
                .then(m => { this.app.use(m.default); })
                .catch(() => {});
        }
        catch { }
        // 路由：缓存测试端点 (dev only)
        this.app.use('/api/cache-test', cacheTestRouter);
        // 路由：管理员端点 (带 SafetyGuard 保护)
        this.app.use('/api/admin', initAdminRoutes({
            pluginLoader: this.pluginLoader,
            snapshotService: this.snapshotService
        }));
        // V2 测试端点
        this.app.get('/api/v2/hello', (req, res) => {
            const endTimer = res.__metricsTimer?.({ route: '/api/v2/hello', method: 'GET' });
            try {
                res.json({ ok: true, message: 'Hello from MetaSheet V2!', version: '2.0.0-alpha.1' });
                endTimer?.(200);
            }
            catch (err) {
                endTimer?.(500);
                throw err;
            }
        });
        this.app.get('/api/v2/rpc-test', async (req, res) => {
            const endTimer = res.__metricsTimer?.({ route: '/api/v2/rpc-test', method: 'GET' });
            try {
                // 测试 RPC 功能
                const testTopic = 'test.rpc';
                const testPayload = { message: 'ping' };
                // 创建测试 RPC handler
                messageBus.createRpcHandler(testTopic, async (payload) => {
                    return { ok: true, echo: payload, timestamp: Date.now() };
                });
                // 发送 RPC 请求
                const result = await messageBus.request(testTopic, testPayload, 1000);
                res.json({ ok: true, rpcTest: 'passed', result });
                endTimer?.(200);
            }
            catch (error) {
                res.json({ ok: true, rpcTest: 'skipped', reason: error.message });
                endTimer?.(200);
            }
        });
        // 插件信息
        this.app.get('/api/plugins', (req, res) => {
            const endTimer = res.__metricsTimer?.({ route: '/api/plugins', method: 'GET' });
            try {
                const list = this.pluginLoader.getList?.() || [];
                const summary = this.pluginLoader.getSummary?.() || {};
                res.json({ list, summary });
                endTimer?.(200);
            }
            catch (e) {
                res.json({ list: [], summary: { error: e?.message || String(e) } });
                endTimer?.(500);
            }
        });
        // Metrics (JSON minimal)
        this.app.get('/internal/metrics', async (_req, res) => {
            const endTimer = res.__metricsTimer?.({ route: '/internal/metrics', method: 'GET' });
            try {
                const { coreMetrics } = await import('./integration/metrics/metrics');
                res.json(coreMetrics.get());
                endTimer?.(200);
            }
            catch (err) {
                endTimer?.(500);
                throw err;
            }
        });
        // Note: /metrics/prom endpoint is registered by installMetrics() in setupMiddleware()
    }
    /**
     * 配置WebSocket
     */
    setupWebSocket() {
        if (process.env.WS_REDIS_ENABLED === 'true') {
            this.wsRedis.enabled = true;
            this.logger.info('WS_REDIS_ENABLED=true; local adapter active (no Redis wiring yet)');
        }
        this.io.on('connection', (socket) => {
            this.logger.info(`WebSocket client connected: ${socket.id}`);
            socket.on('disconnect', () => {
                this.logger.info(`WebSocket client disconnected: ${socket.id}`);
            });
            // 测试事件
            socket.on('ping', () => {
                socket.emit('pong', { timestamp: Date.now() });
            });
        });
    }
    /**
     * 初始化缓存 (Phase 1)
     *
     * Phase 1: Always use NullCache for observability
     * Phase 3: Will register RedisCache here based on feature flag
     */
    initializeCache() {
        // Phase 1: NullCache is already default in CacheRegistry
        const enabled = process.env.FEATURE_CACHE === 'true';
        this.logger.info(`Cache: ${enabled ? 'observing' : 'disabled'} (impl: ${cacheRegistry.getStatus().implName})`);
        // Phase 3: Plugin will register RedisCache when FEATURE_CACHE_REDIS=true
    }
    /**
     * 启动服务器
     */
    async start() {
        // 初始化EventBusService
        this.logger.info('Initializing EventBusService...');
        const coreAPI = this.createCoreAPI();
        await initializeEventBusService(coreAPI);
        // 加载插件并启动 HTTP 服务
        if (process.env.SKIP_PLUGINS === 'true') {
            this.logger.warn('Skipping plugin load (SKIP_PLUGINS=true)');
        }
        else {
            this.logger.info('Loading plugins...');
            try {
                await this.pluginLoader.loadPlugins();
                this.logger.info('Plugins loaded successfully');
            }
            catch (e) {
                this.logger.error('Plugin loading failed; continuing startup without full plugin set', e);
            }
        }
        this.logger.info('Starting HTTP server listen phase...');
        this.httpServer.listen(this.port, () => {
            this.logger.info(`MetaSheet v2 core listening on http://localhost:${this.port}`);
            this.logger.info(`Health:  http://localhost:${this.port}/health`);
            this.logger.info(`Metrics: http://localhost:${this.port}/metrics/prom`);
            this.logger.info(`Plugins: http://localhost:${this.port}/api/plugins`);
            this.logger.info(`Events:  http://localhost:${this.port}/api/events`);
        });
        const shutdown = async (signal) => {
            if (this.shuttingDown)
                return;
            this.shuttingDown = true;
            this.logger.info(`Received ${signal}, shutting down...`);
            try {
                this.httpServer.close(() => this.logger.info('HTTP server closed'));
            }
            catch { }
            try {
                const { pool } = await import('./db/pg');
                if (pool)
                    await pool.end();
            }
            catch { }
            setTimeout(() => process.exit(0), 500);
        };
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
    }
}
// 启动
const server = new MetaSheetServer();
server.start().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to start MetaSheet v2 core:', err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map