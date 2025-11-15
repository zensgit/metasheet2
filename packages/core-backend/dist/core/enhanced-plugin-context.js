"use strict";
/**
 * 增强版插件上下文
 * 集成所有新的服务和功能
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createEnhancedPluginContext = createEnhancedPluginContext;
const eventemitter3_1 = require("eventemitter3");
const logger_1 = require("./logger");
const audit_1 = require("../audit/audit");
const metrics_1 = require("../metrics/metrics");
const db_1 = require("../db/db");
// Import service implementations
const CacheService_1 = require("../services/CacheService");
const QueueService_1 = require("../services/QueueService");
const StorageService_1 = require("../services/StorageService");
const SchedulerService_1 = require("../services/SchedulerService");
const NotificationService_1 = require("../services/NotificationService");
const WebSocketService_1 = require("../services/WebSocketService");
const SecurityService_1 = require("../services/SecurityService");
const ValidationService_1 = require("../services/ValidationService");
/**
 * 增强版插件上下文创建器
 */
function createEnhancedPluginContext(manifest, coreAPI, serviceInstances) {
    // 创建插件元信息
    const metadata = {
        name: manifest.name,
        version: manifest.version,
        displayName: manifest.displayName,
        description: manifest.description,
        author: manifest.author,
        path: manifest.path || ''
    };
    // 创建或使用现有服务实例
    const services = {
        cache: serviceInstances?.cache || CacheService_1.CacheServiceImpl.createMemoryService(),
        queue: serviceInstances?.queue || new QueueService_1.QueueServiceImpl(),
        storage: serviceInstances?.storage || new StorageService_1.StorageServiceImpl(),
        scheduler: serviceInstances?.scheduler || new SchedulerService_1.SchedulerServiceImpl(),
        notification: serviceInstances?.notification || new NotificationService_1.NotificationServiceImpl(),
        websocket: serviceInstances?.websocket || new WebSocketService_1.WebSocketServiceImpl(),
        security: serviceInstances?.security || new SecurityService_1.SecurityServiceImpl(),
        validation: serviceInstances?.validation || new ValidationService_1.ValidationServiceImpl()
    };
    // 创建沙箱化的API
    const sandboxedAPI = createEnhancedSandboxedAPI(coreAPI, manifest, services);
    // 创建增强的插件存储
    const storage = createEnhancedPluginStorage(manifest.name);
    // 创建插件通信
    const communication = createPluginCommunication(manifest.name);
    // 创建日志器
    const logger = new logger_1.Logger(`Plugin:${manifest.name}`);
    // 创建插件配置（从配置管理器加载）
    const config = loadPluginConfig(manifest.name);
    // 设置插件安全沙箱
    const sandbox = services.security.createSandbox(manifest.name);
    // 监听服务事件并转发到插件
    setupServiceEventForwarding(services, manifest.name, logger);
    return {
        metadata,
        api: sandboxedAPI,
        storage,
        config,
        communication,
        logger,
        services
    };
}
/**
 * 创建增强的沙箱化API
 */
function createEnhancedSandboxedAPI(api, manifest, services) {
    const permissions = new Set(manifest.permissions || []);
    // 权限检查辅助函数
    const hasPermission = (perm) => permissions.has('*') || permissions.has(perm) ||
        (perm.includes('.') && permissions.has(perm.split('.')[0] + '.*'));
    const wrapAsyncCall = async (cap, fn, args) => {
        // 检查权限
        if (!hasPermission(cap)) {
            try {
                ;
                metrics_1.metrics.pluginPermissionDenied?.labels?.(manifest.name, cap)?.inc?.();
            }
            catch { }
            await auditAPICall(manifest.name, cap, args, 'denied');
            throw new Error(`Plugin ${manifest.name} lacks permission: ${cap}`);
        }
        // 检查速率限制
        const rateLimitResult = await services.security.checkRateLimit(manifest.name, cap);
        if (!rateLimitResult.allowed) {
            throw new Error(`Rate limit exceeded for ${cap}. Retry after ${rateLimitResult.retryAfter} seconds.`);
        }
        // 审计日志
        await auditAPICall(manifest.name, cap, args, 'allowed');
        // 资源监控
        const startTime = Date.now();
        const startMemory = process.memoryUsage().heapUsed;
        try {
            const result = await fn(...args);
            // 记录资源使用
            const endTime = Date.now();
            const endMemory = process.memoryUsage().heapUsed;
            await services.security.monitorResource(manifest.name, cap, {
                resource: `${cap}_execution_time`,
                current: endTime - startTime,
                limit: 30000, // 30 seconds default limit
                unit: 'ms',
                timestamp: new Date()
            });
            await services.security.monitorResource(manifest.name, cap, {
                resource: `${cap}_memory_usage`,
                current: Math.max(0, endMemory - startMemory),
                limit: 50 * 1024 * 1024, // 50MB default limit
                unit: 'bytes',
                timestamp: new Date()
            });
            return result;
        }
        catch (error) {
            // 记录错误
            await services.security.audit({
                id: `error_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                pluginName: manifest.name,
                event: 'api_error',
                resource: cap,
                action: 'call',
                timestamp: new Date(),
                metadata: { error: error.message },
                severity: 'error'
            });
            throw error;
        }
    };
    // HTTP API增强
    const http = api.http && {
        addRoute: (...args) => wrapAsyncCall('http.addRoute', api.http.addRoute, args),
        removeRoute: (...args) => wrapAsyncCall('http.addRoute', api.http.removeRoute, args),
        middleware: (...args) => api.http.middleware?.(...args),
        request: (...args) => wrapAsyncCall('http.request', api.http.request, args)
    };
    // 数据库API增强
    const database = api.database && {
        query: async (sql, params) => {
            const intent = classifySqlIntent(sql);
            const cap = intent === 'read' ? 'database.read' : 'database.write';
            // SQL威胁扫描
            const threatScan = await services.security.scanForThreats(manifest.name, sql);
            if (!threatScan.safe) {
                const criticalThreats = threatScan.threats.filter(t => t.severity === 'critical');
                if (criticalThreats.length > 0) {
                    throw new Error(`SQL security threats detected: ${criticalThreats.map(t => t.description).join(', ')}`);
                }
            }
            return wrapAsyncCall(cap, api.database.query, [sql, params]);
        },
        transaction: async (callback) => {
            return wrapAsyncCall('database.write', api.database.transaction, [callback]);
        },
        model: (...args) => wrapAsyncCall('database.read', api.database.model, args)
    };
    // 存储API增强（使用服务）
    const storage = {
        upload: async (...args) => {
            await hasPermission('file.write');
            return services.storage.upload(...args);
        },
        download: async (...args) => {
            await hasPermission('file.read');
            return services.storage.download(...args);
        },
        delete: async (...args) => {
            await hasPermission('file.write');
            return services.storage.delete(...args);
        },
        getUrl: async (...args) => {
            await hasPermission('file.read');
            return services.storage.getFileUrl(...args);
        }
    };
    // WebSocket API增强（使用服务）
    const websocket = {
        broadcast: (...args) => {
            if (!hasPermission('websocket.broadcast')) {
                throw new Error(`Permission denied: websocket.broadcast`);
            }
            return services.websocket.broadcast(...args);
        },
        broadcastTo: (...args) => {
            if (!hasPermission('websocket.broadcastTo')) {
                throw new Error(`Permission denied: websocket.broadcastTo`);
            }
            return services.websocket.broadcastToRoom(...args);
        },
        join: (...args) => wrapAsyncCall('websocket.join', services.websocket.join.bind(services.websocket), args),
        leave: (...args) => wrapAsyncCall('websocket.leave', services.websocket.leave.bind(services.websocket), args),
        sendTo: (...args) => {
            if (!hasPermission('websocket.broadcast')) {
                throw new Error(`Permission denied: websocket.broadcast`);
            }
            return services.websocket.sendTo(...args);
        },
        onConnection: (...args) => services.websocket.onConnection(...args)
    };
    // 通知API（使用服务）
    const notification = {
        send: async (...args) => {
            if (!hasPermission('notification.send')) {
                throw new Error(`Permission denied: notification.send`);
            }
            return services.notification.send?.(...args);
        }
    };
    // 事件API
    const events = api.events && {
        emit: (...args) => wrapAsyncCall('events.emit', (...inner) => api.events.emit?.(...inner), args),
        on: (...args) => api.events.on?.(...args),
        once: (...args) => api.events.once?.(...args),
        off: (...args) => api.events.off?.(...args)
    };
    // 缓存API（使用服务）
    const cache = {
        get: (...args) => services.cache.get?.apply(services.cache, args),
        set: (...args) => services.cache.set?.apply(services.cache, args),
        delete: (...args) => services.cache.delete?.apply(services.cache, args),
        clear: (...args) => services.cache.clear?.apply(services.cache, args)
    };
    // 队列API（使用服务）
    const queue = {
        push: (...args) => {
            if (!hasPermission('queue.push')) {
                throw new Error(`Permission denied: queue.push`);
            }
            return services.queue.add?.('default', 'task', ...args);
        },
        process: (...args) => services.queue.process?.(...args),
        cancel: (...args) => services.queue.removeJob?.(...args)
    };
    return {
        http: http,
        database: database,
        auth: api.auth,
        events: events,
        storage: storage,
        cache: cache,
        queue: queue,
        websocket: websocket,
        notification: notification,
        // pass-through view service API from core API
        views: api.views
    };
}
/**
 * 创建增强的插件存储
 */
function createEnhancedPluginStorage(pluginName) {
    // 支持数据库和内存存储
    const memory = new Map();
    return {
        async get(key) {
            if (!db_1.db)
                return memory.get(key);
            try {
                const row = await db_1.db.selectFrom('plugin_kv')
                    .selectAll()
                    .where('plugin_id', '=', pluginName)
                    .where('key', '=', key)
                    .executeTakeFirst();
                return row ? row.value : undefined;
            }
            catch (error) {
                // 回退到内存存储
                return memory.get(key);
            }
        },
        async set(key, value) {
            if (!db_1.db) {
                memory.set(key, value);
                return;
            }
            try {
                await db_1.db
                    .insertInto('plugin_kv')
                    .values({
                    plugin_id: pluginName,
                    key,
                    value
                })
                    .onConflict(oc => oc.columns(['plugin_id', 'key']).doUpdateSet({
                    value
                }))
                    .execute();
            }
            catch (error) {
                // 回退到内存存储
                memory.set(key, value);
            }
        },
        async delete(key) {
            if (!db_1.db) {
                memory.delete(key);
                return;
            }
            try {
                await db_1.db.deleteFrom('plugin_kv')
                    .where('plugin_id', '=', pluginName)
                    .where('key', '=', key)
                    .execute();
            }
            catch (error) {
                // 回退到内存存储
                memory.delete(key);
            }
        },
        async list() {
            if (!db_1.db)
                return Array.from(memory.keys());
            try {
                const rows = await db_1.db.selectFrom('plugin_kv')
                    .select(['key'])
                    .where('plugin_id', '=', pluginName)
                    .orderBy('key asc')
                    .execute();
                return rows.map(r => r.key);
            }
            catch (error) {
                // 回退到内存存储
                return Array.from(memory.keys());
            }
        }
    };
}
/**
 * 创建插件通信
 */
function createPluginCommunication(pluginName) {
    const eventBus = new eventemitter3_1.EventEmitter();
    const apis = new Map();
    return {
        async call(plugin, method, ...args) {
            const api = apis.get(plugin);
            if (!api) {
                throw new Error(`Plugin ${plugin} not found`);
            }
            const fn = api[method];
            if (!fn) {
                throw new Error(`Method ${method} not found in plugin ${plugin}`);
            }
            return fn(...args);
        },
        register(name, api) {
            apis.set(name || pluginName, api);
        },
        on(event, handler) {
            ;
            eventBus.on(event, handler);
        },
        emit(event, data) {
            ;
            eventBus.emit(event, data);
        }
    };
}
/**
 * 设置服务事件转发
 */
function setupServiceEventForwarding(services, pluginName, logger) {
    // 缓存事件
    ;
    services.cache.on?.('cache:error', (event) => {
        logger.error(`Cache error: ${event.error?.message}`);
    });
    services.queue.on?.('default', 'failed', (job, error) => {
        logger.error(`Job failed: ${job.name} - ${error.message}`);
    });
    services.notification.on?.('notification:error', (event) => {
        logger.error(`Notification error: ${event.error?.message}`);
    });
    services.websocket.on?.('error', (event) => {
        logger.error(`WebSocket error: ${event.error?.message}`);
    });
    services.security.on?.('audit', (event) => {
        if (event.severity === 'error' || event.severity === 'critical') {
            logger.warn(`Security audit [${event.severity}]: ${event.event}`);
        }
    });
}
/**
 * 审计API调用
 */
async function auditAPICall(plugin, cap, args, result) {
    try {
        await (0, audit_1.auditLog)({
            actorType: 'system',
            action: 'plugin.api',
            resourceType: 'plugin',
            resourceId: plugin,
            meta: { capability: cap, result }
        });
    }
    catch { }
}
/**
 * 分类SQL意图
 */
function classifySqlIntent(sql) {
    const s = (sql || '').trim().toUpperCase();
    if (!s)
        return 'read';
    if (s.startsWith('SELECT') || s.startsWith('WITH'))
        return 'read';
    return 'write';
}
/**
 * 加载插件配置
 */
function loadPluginConfig(pluginName) {
    // TODO: 集成PluginConfigManager
    return {
    // 默认配置
    };
}
//# sourceMappingURL=enhanced-plugin-context.js.map