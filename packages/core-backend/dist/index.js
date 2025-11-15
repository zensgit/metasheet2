"use strict";
/**
 * MetaSheet Backend Core
 * 后端核心服务器入口
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = require("http");
const socket_io_1 = require("socket.io");
const cors_1 = __importDefault(require("cors"));
const eventemitter3_1 = require("eventemitter3");
const plugin_loader_1 = require("./core/plugin-loader");
const logger_1 = require("./core/logger");
const connection_pool_1 = require("./integration/db/connection-pool");
const event_bus_1 = require("./integration/events/event-bus");
const event_bus_service_1 = require("./integration/events/event-bus-service");
const message_bus_1 = require("./integration/messaging/message-bus");
const jwt_middleware_1 = require("./auth/jwt-middleware");
const metrics_1 = require("./metrics/metrics");
const pg_1 = require("./db/pg");
const approvals_1 = require("./routes/approvals");
const audit_logs_1 = require("./routes/audit-logs");
const approval_history_1 = require("./routes/approval-history");
const roles_1 = require("./routes/roles");
const permissions_1 = require("./routes/permissions");
const files_1 = require("./routes/files");
const spreadsheets_1 = require("./routes/spreadsheets");
const spreadsheet_permissions_1 = require("./routes/spreadsheet-permissions");
const events_1 = require("./routes/events");
const internal_1 = __importDefault(require("./routes/internal"));
const cache_test_1 = __importDefault(require("./routes/cache-test"));
const CacheRegistry_1 = require("../core/cache/CacheRegistry");
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
    constructor() {
        this.app = (0, express_1.default)();
        this.httpServer = (0, http_1.createServer)(this.app);
        this.io = new socket_io_1.Server(this.httpServer, {
            cors: {
                origin: '*',
                methods: ['GET', 'POST']
            }
        });
        this.eventBus = new eventemitter3_1.EventEmitter();
        this.logger = new logger_1.Logger('MetaSheetServer');
        this.port = parseInt(process.env.PORT || '8900');
        // 创建核心API
        const coreAPI = this.createCoreAPI();
        this.pluginLoader = new plugin_loader_1.PluginLoader(coreAPI);
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
                    return (await connection_pool_1.poolManager.get().query(sql, params)).rows;
                },
                transaction: async (callback) => {
                    return connection_pool_1.poolManager.get().transaction(async (client) => callback(client));
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
                on: (evt, handler) => event_bus_1.eventBus.subscribe(evt, handler),
                once: (evt, handler) => {
                    const wrappedHandler = (data) => {
                        handler(data);
                        event_bus_1.eventBus.unsubscribe(subscriptionId);
                    };
                    const subscriptionId = event_bus_1.eventBus.subscribe(evt, wrappedHandler);
                    return subscriptionId;
                },
                emit: (evt, data) => event_bus_1.eventBus.emit(evt, data),
                off: (idOrPlugin) => event_bus_1.eventBus.unsubscribe(idOrPlugin)
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
                publish: (topic, payload, opts) => message_bus_1.messageBus.publish(topic, payload, opts),
                subscribe: (topic, handler) => message_bus_1.messageBus.subscribe(topic, handler),
                subscribePattern: (pattern, handler) => message_bus_1.messageBus.subscribePattern(pattern, handler),
                unsubscribe: (id) => message_bus_1.messageBus.unsubscribe(id),
                request: (topic, payload, timeoutMs) => message_bus_1.messageBus.request(topic, payload, timeoutMs),
                rpcHandler: (topic, handler) => message_bus_1.messageBus.createRpcHandler(topic, handler)
            }
        };
    }
    /**
     * 配置中间件
     */
    setupMiddleware() {
        // CORS
        this.app.use((0, cors_1.default)());
        // Body parsing
        this.app.use(express_1.default.json({ limit: '10mb' }));
        this.app.use(express_1.default.urlencoded({ extended: true }));
        // 指标端点与请求指标（尽早注册）
        (0, metrics_1.installMetrics)(this.app);
        this.app.use(metrics_1.requestMetricsMiddleware);
        // 请求日志
        this.app.use((req, res, next) => {
            this.logger.info(`${req.method} ${req.path}`);
            next();
        });
        // 全局 JWT 保护 `/api/**`（白名单在中间件内判定）
        this.app.use((req, res, next) => {
            if ((0, jwt_middleware_1.isWhitelisted)(req.path))
                return next();
            if (req.path.startsWith('/api/'))
                return (0, jwt_middleware_1.jwtAuthMiddleware)(req, res, next);
            return next();
        });
        // 健康检查
        this.app.get('/health', (req, res) => {
            const stats = (0, pg_1.getPoolStats)();
            res.json({
                status: 'ok',
                timestamp: new Date().toISOString(),
                plugins: this.pluginLoader.getPlugins().size,
                dbPool: stats || undefined,
                wsAdapter: this.wsAdapterType,
                redis: this.wsRedis
            });
        });
        // 路由：审批（示例）
        this.app.use((0, approvals_1.approvalsRouter)());
        // 路由：审计日志（管理员）
        this.app.use((0, audit_logs_1.auditLogsRouter)());
        // 路由：审批历史（从审计表衍生）
        this.app.use((0, approval_history_1.approvalHistoryRouter)());
        // 路由：角色/权限/表/文件/表权限（占位）
        this.app.use((0, roles_1.rolesRouter)());
        this.app.use((0, permissions_1.permissionsRouter)());
        this.app.use((0, files_1.filesRouter)());
        this.app.use((0, spreadsheets_1.spreadsheetsRouter)());
        this.app.use((0, spreadsheet_permissions_1.spreadsheetPermissionsRouter)());
        // 路由：事件总线
        this.app.use((0, events_1.eventsRouter)());
        // 路由：内部调试端点 (dev/staging only)
        this.app.use('/internal', internal_1.default);
        // 路由：缓存测试端点 (dev only)
        this.app.use('/api/cache-test', cache_test_1.default);
        // V2 测试端点
        this.app.get('/api/v2/hello', (req, res) => {
            res.json({ ok: true, message: 'Hello from MetaSheet V2!', version: '2.0.0-alpha.1' });
        });
        this.app.get('/api/v2/rpc-test', async (req, res) => {
            try {
                // 测试 RPC 功能
                const testTopic = 'test.rpc';
                const testPayload = { message: 'ping' };
                // 创建测试 RPC handler
                message_bus_1.messageBus.createRpcHandler(testTopic, async (payload) => {
                    return { ok: true, echo: payload, timestamp: Date.now() };
                });
                // 发送 RPC 请求
                const result = await message_bus_1.messageBus.request(testTopic, testPayload, 1000);
                res.json({ ok: true, rpcTest: 'passed', result });
            }
            catch (error) {
                res.json({ ok: true, rpcTest: 'skipped', reason: error.message });
            }
        });
        // 插件信息
        this.app.get('/api/plugins', (req, res) => {
            const plugins = Array.from(this.pluginLoader.getPlugins().entries()).map(([name, instance]) => ({
                name,
                version: instance.manifest.version,
                displayName: instance.manifest.displayName,
                status: instance.status
            }));
            res.json(plugins);
        });
        // Metrics (JSON minimal)
        this.app.get('/internal/metrics', async (_req, res) => {
            const { coreMetrics } = await Promise.resolve().then(() => __importStar(require('./integration/metrics/metrics')));
            res.json(coreMetrics.get());
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
        this.logger.info(`Cache: ${enabled ? 'observing' : 'disabled'} (impl: ${CacheRegistry_1.cacheRegistry.getStatus().implName})`);
        // Phase 3: Plugin will register RedisCache when FEATURE_CACHE_REDIS=true
    }
    /**
     * 启动服务器
     */
    async start() {
        // 初始化EventBusService
        this.logger.info('Initializing EventBusService...');
        const coreAPI = this.createCoreAPI();
        await (0, event_bus_service_1.initializeEventBusService)(coreAPI);
        // 加载插件并启动 HTTP 服务
        this.logger.info('Loading plugins...');
        await this.pluginLoader.loadPlugins();
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
                const { pool } = await Promise.resolve().then(() => __importStar(require('./db/pg')));
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