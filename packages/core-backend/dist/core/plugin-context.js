"use strict";
/**
 * 插件上下文工厂
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPluginContext = createPluginContext;
const eventemitter3_1 = require("eventemitter3");
const logger_1 = require("./logger");
/**
 * 创建插件上下文
 */
function createPluginContext(manifest, coreAPI) {
    // 创建插件元信息
    const metadata = {
        name: manifest.name,
        version: manifest.version,
        displayName: manifest.displayName,
        description: manifest.description,
        author: manifest.author,
        path: manifest.path || ''
    };
    // 创建沙箱化的API
    const sandboxedAPI = createSandboxedAPI(coreAPI, manifest);
    // 创建插件存储
    const storage = createPluginStorage(manifest.name);
    // 创建插件通信
    const communication = createPluginCommunication(manifest.name);
    // 创建日志器
    const logger = new logger_1.Logger(`Plugin:${manifest.name}`);
    // 创建插件配置
    const config = loadPluginConfig(manifest.name);
    return {
        metadata,
        api: sandboxedAPI,
        core: sandboxedAPI, // Provide expected core API structure for backward compatibility
        storage,
        config,
        communication,
        logger
    };
}
/**
 * 创建沙箱化的API
 */
const PERMISSION_MAP = {
    // High-level group -> underlying allowed roots (simple expansion)
    'database.read': ['database.query'],
    'database.write': ['database.query', 'database.transaction'],
    'events.basic': ['events.on', 'events.emit', 'events.off'],
    'messaging.basic': ['messaging.publish', 'messaging.subscribe', 'messaging.request', 'messaging.rpcHandler'],
    'messaging.pattern': ['messaging.subscribePattern'],
    'messaging.expiry': ['messaging.publish'],
    'http.register': ['http.addRoute'],
};
function expandPermissions(raw) {
    const out = new Set();
    for (const p of raw) {
        out.add(p);
        if (PERMISSION_MAP[p]) {
            for (const t of PERMISSION_MAP[p]) {
                out.add(t);
                // Also add the namespace root for permissions like 'events.emit' -> 'events'
                const [namespace] = t.split('.');
                if (namespace) {
                    out.add(namespace);
                }
            }
        }
    }
    return out;
}
function createSandboxedAPI(api, manifest) {
    const rawPerms = manifest.permissions || [];
    // '*' means full access
    const full = rawPerms.includes('*');
    const expanded = expandPermissions(rawPerms);
    return new Proxy(api, {
        get(target, prop) {
            // 粗粒度命名空间检查（http/database/events/messaging...）
            if (!full) {
                const root = prop;
                // allow basic namespace introspection of auth/storage/cache/queue/websocket for now
                const passiveNamespaces = new Set(['auth', 'storage', 'cache', 'queue', 'websocket']);
                if (!passiveNamespaces.has(root)) {
                    const allowed = Array.from(expanded).some(p => p === root || p.startsWith(root + '.'));
                    if (!allowed) {
                        try {
                            const { coreMetrics } = require('../integration/metrics/metrics');
                            coreMetrics.inc('permissionDenied');
                        }
                        catch { }
                        throw new Error(`Permission denied: ${manifest.name} → ${root}`);
                    }
                }
            }
            const value = target[prop];
            // 如果是对象，递归创建代理
            if (typeof value === 'object' && value !== null) {
                return new Proxy(value, {
                    get(subTarget, subProp) {
                        const subValue = subTarget[subProp];
                        // 包装函数调用以添加审计
                        if (typeof subValue === 'function') {
                            return (...args) => {
                                auditAPICall(manifest.name, `${prop}.${String(subProp)}`, args);
                                if (!full) {
                                    const op = `${prop}.${String(subProp)}`;
                                    if (!expanded.has(op) && !expanded.has(prop)) {
                                        try {
                                            const { coreMetrics } = require('../integration/metrics/metrics');
                                            coreMetrics.inc('permissionDenied');
                                        }
                                        catch { }
                                        throw new Error(`Permission denied: ${manifest.name} → ${op}`);
                                    }
                                }
                                return subValue.apply(subTarget, args);
                            };
                        }
                        return subValue;
                    }
                });
            }
            return value;
        }
    });
}
/**
 * 检查权限
 */
function checkPermission(api, permissions) {
    // 实现权限检查逻辑
    // 例如: database.read, database.write, http.*, etc.
    return permissions.some(p => {
        if (p === '*')
            return true;
        if (p === api)
            return true;
        if (p.endsWith('.*') && api.startsWith(p.slice(0, -2)))
            return true;
        return false;
    });
}
/**
 * 审计API调用
 */
function auditAPICall(plugin, api, args) {
    // TODO: 实现审计日志
    if (process.env.AUDIT_LOG === 'true') {
        console.log(`[AUDIT] Plugin ${plugin} called ${api}`, args);
    }
}
/**
 * 创建插件存储
 */
function createPluginStorage(pluginName) {
    // TODO: 实现持久化存储
    const storage = new Map();
    return {
        async get(key) {
            return storage.get(`${pluginName}:${key}`);
        },
        async set(key, value) {
            storage.set(`${pluginName}:${key}`, value);
        },
        async delete(key) {
            storage.delete(`${pluginName}:${key}`);
        },
        async list() {
            const prefix = `${pluginName}:`;
            return Array.from(storage.keys())
                .filter(k => k.startsWith(prefix))
                .map(k => k.slice(prefix.length));
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
            eventBus.on(event, handler);
        },
        emit(event, data) {
            eventBus.emit(event, data);
        }
    };
}
/**
 * 加载插件配置
 */
function loadPluginConfig(pluginName) {
    // TODO: 从配置文件或数据库加载配置
    return {
    // 默认配置
    };
}
//# sourceMappingURL=plugin-context.js.map