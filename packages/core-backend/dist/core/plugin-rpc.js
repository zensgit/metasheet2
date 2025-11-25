/**
 * 插件间 RPC (Remote Procedure Call) 机制
 * 任务ID: P1-021
 * 功能: 基于事件总线实现插件间的远程方法调用
 */
import { createLogger } from './logger';
/**
 * RPC 错误代码
 */
export var RpcErrorCode;
(function (RpcErrorCode) {
    RpcErrorCode[RpcErrorCode["METHOD_NOT_FOUND"] = -32601] = "METHOD_NOT_FOUND";
    RpcErrorCode[RpcErrorCode["INVALID_PARAMS"] = -32602] = "INVALID_PARAMS";
    RpcErrorCode[RpcErrorCode["INTERNAL_ERROR"] = -32603] = "INTERNAL_ERROR";
    RpcErrorCode[RpcErrorCode["TIMEOUT"] = -32000] = "TIMEOUT";
    RpcErrorCode[RpcErrorCode["PLUGIN_NOT_FOUND"] = -32001] = "PLUGIN_NOT_FOUND";
    RpcErrorCode[RpcErrorCode["UNAUTHORIZED"] = -32002] = "UNAUTHORIZED";
    RpcErrorCode[RpcErrorCode["RATE_LIMITED"] = -32003] = "RATE_LIMITED";
})(RpcErrorCode || (RpcErrorCode = {}));
/**
 * RPC 服务器 - 提供方法供其他插件调用
 */
export class RpcServer {
    pluginId;
    methods;
    eventBus;
    logger;
    config;
    stats;
    rateLimiters;
    activeCalls = 0;
    constructor(pluginId, eventBus, config) {
        this.pluginId = pluginId;
        this.eventBus = eventBus;
        this.methods = new Map();
        this.stats = new Map();
        this.rateLimiters = new Map();
        this.logger = createLogger(`RpcServer:${pluginId}`);
        this.config = {
            enableLogging: true,
            enableMetrics: true,
            maxConcurrentCalls: 100,
            defaultTimeout: 30000,
            ...config
        };
        this.initialize();
    }
    /**
     * 初始化 RPC 服务器
     */
    initialize() {
        // 订阅 RPC 请求事件
        this.eventBus.subscribe(`rpc:request:${this.pluginId}:*`, this.handleRpcRequest.bind(this), this.pluginId);
        if (this.config.enableLogging) {
            this.logger.info(`RPC Server initialized for plugin: ${this.pluginId}`);
        }
    }
    /**
     * 注册 RPC 方法
     */
    register(definition) {
        const fullName = `${this.pluginId}.${definition.name}`;
        this.methods.set(definition.name, definition);
        // 初始化统计
        this.stats.set(definition.name, {
            calls: 0,
            successes: 0,
            failures: 0,
            totalDuration: 0
        });
        if (definition.rateLimit) {
            this.rateLimiters.set(definition.name, new Map());
        }
        if (this.config.enableLogging) {
            this.logger.debug(`Registered RPC method: ${fullName}`);
        }
    }
    /**
     * 批量注册方法
     */
    registerAll(definitions) {
        definitions.forEach(def => this.register(def));
    }
    /**
     * 处理 RPC 请求
     */
    async handleRpcRequest(event) {
        const request = event.data;
        const startTime = Date.now();
        // 检查并发限制
        if (this.activeCalls >= this.config.maxConcurrentCalls) {
            await this.sendError(request, {
                code: RpcErrorCode.RATE_LIMITED,
                message: 'Max concurrent calls exceeded'
            });
            return;
        }
        this.activeCalls++;
        try {
            // 提取方法名
            const methodName = request.method;
            const method = this.methods.get(methodName);
            if (!method) {
                await this.sendError(request, {
                    code: RpcErrorCode.METHOD_NOT_FOUND,
                    message: `Method not found: ${methodName}`
                });
                this.updateStats(methodName, false, Date.now() - startTime);
                return;
            }
            // 检查速率限制
            if (method.rateLimit) {
                const callerId = request.metadata?.callerId || 'unknown';
                if (!this.checkRateLimit(methodName, callerId, method.rateLimit)) {
                    await this.sendError(request, {
                        code: RpcErrorCode.RATE_LIMITED,
                        message: 'Rate limit exceeded'
                    });
                    this.updateStats(methodName, false, Date.now() - startTime);
                    return;
                }
            }
            // 设置超时
            const timeout = request.timeout || this.config.defaultTimeout;
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('RPC timeout')), timeout);
            });
            // 执行方法
            const resultPromise = method.handler(request.params, request.metadata);
            // 等待结果或超时
            const result = await Promise.race([resultPromise, timeoutPromise]);
            // 发送响应
            const response = {
                id: request.id,
                result,
                metadata: {
                    responderId: this.pluginId,
                    timestamp: new Date(),
                    duration: Date.now() - startTime
                }
            };
            await this.eventBus.publish(`rpc:response:${request.id}`, response);
            this.updateStats(methodName, true, Date.now() - startTime);
            if (this.config.enableLogging) {
                this.logger.debug(`RPC call succeeded: ${methodName}`);
            }
        }
        catch (error) {
            // 发送错误响应
            await this.sendError(request, {
                code: RpcErrorCode.INTERNAL_ERROR,
                message: error.message || 'Internal server error',
                data: error.stack
            });
            const methodName = request.method;
            this.updateStats(methodName, false, Date.now() - startTime);
            if (this.config.enableLogging) {
                this.logger.error(`RPC call failed: ${methodName}`, error);
            }
        }
        finally {
            this.activeCalls--;
        }
    }
    /**
     * 发送错误响应
     */
    async sendError(request, error) {
        const response = {
            id: request.id,
            error,
            metadata: {
                responderId: this.pluginId,
                timestamp: new Date(),
                duration: 0
            }
        };
        await this.eventBus.publish(`rpc:response:${request.id}`, response);
    }
    /**
     * 检查速率限制
     */
    checkRateLimit(method, callerId, limit) {
        const now = Date.now();
        const limiter = this.rateLimiters.get(method);
        if (!limiter.has(callerId)) {
            limiter.set(callerId, []);
        }
        const calls = limiter.get(callerId);
        // 清理过期的调用记录
        const cutoff = now - limit.windowMs;
        const validCalls = calls.filter(time => time > cutoff);
        if (validCalls.length >= limit.maxCalls) {
            return false;
        }
        validCalls.push(now);
        limiter.set(callerId, validCalls);
        return true;
    }
    /**
     * 更新统计信息
     */
    updateStats(method, success, duration) {
        if (!this.config.enableMetrics)
            return;
        let stats = this.stats.get(method);
        if (!stats) {
            stats = {
                calls: 0,
                successes: 0,
                failures: 0,
                totalDuration: 0
            };
            this.stats.set(method, stats);
        }
        stats.calls++;
        if (success) {
            stats.successes++;
        }
        else {
            stats.failures++;
        }
        stats.totalDuration += duration;
        stats.lastCall = new Date();
    }
    /**
     * 获取方法列表
     */
    getMethods() {
        return Array.from(this.methods.keys()).map(name => `${this.pluginId}.${name}`);
    }
    /**
     * 获取统计信息
     */
    getStats() {
        return new Map(this.stats);
    }
    /**
     * 清理资源
     */
    destroy() {
        this.eventBus.unsubscribeByPlugin(this.pluginId);
        this.methods.clear();
        this.stats.clear();
        this.rateLimiters.clear();
        if (this.config.enableLogging) {
            this.logger.info(`RPC Server destroyed for plugin: ${this.pluginId}`);
        }
    }
}
/**
 * RPC 客户端 - 调用其他插件提供的方法
 */
export class RpcClient {
    pluginId;
    eventBus;
    logger;
    config;
    pendingCalls;
    constructor(pluginId, eventBus, config) {
        this.pluginId = pluginId;
        this.eventBus = eventBus;
        this.pendingCalls = new Map();
        this.logger = createLogger(`RpcClient:${pluginId}`);
        this.config = {
            timeout: 30000,
            retries: 3,
            retryDelay: 1000,
            ...config
        };
    }
    /**
     * 调用远程方法
     */
    async call(targetPlugin, method, params = [], options) {
        const actualOptions = {
            timeout: this.config.timeout,
            retries: this.config.retries,
            ...options
        };
        let lastError;
        for (let attempt = 0; attempt <= actualOptions.retries; attempt++) {
            try {
                const result = await this.doCall(targetPlugin, method, params, actualOptions.timeout);
                return result;
            }
            catch (error) {
                lastError = error;
                if (attempt < actualOptions.retries) {
                    // 等待后重试
                    await new Promise(resolve => setTimeout(resolve, this.config.retryDelay * (attempt + 1)));
                    this.logger.warn(`RPC call failed, retrying... (${attempt + 1}/${actualOptions.retries})`, { targetPlugin, method, error });
                }
            }
        }
        throw lastError;
    }
    /**
     * 执行单次调用
     */
    async doCall(targetPlugin, method, params, timeout) {
        const requestId = this.generateId();
        const request = {
            id: requestId,
            method,
            params,
            timeout,
            metadata: {
                callerId: this.pluginId,
                timestamp: new Date()
            }
        };
        return new Promise((resolve, reject) => {
            // 设置超时
            const timeoutHandle = setTimeout(() => {
                this.pendingCalls.delete(requestId);
                reject(new Error(`RPC call timeout: ${targetPlugin}.${method}`));
            }, timeout);
            // 保存待处理调用
            this.pendingCalls.set(requestId, {
                resolve,
                reject,
                timeout: timeoutHandle
            });
            // 订阅响应事件
            const listenerId = this.eventBus.subscribe(`rpc:response:${requestId}`, (event) => {
                const response = event.data;
                const pending = this.pendingCalls.get(requestId);
                if (pending) {
                    clearTimeout(pending.timeout);
                    this.pendingCalls.delete(requestId);
                    this.eventBus.unsubscribe(listenerId);
                    if (response.error) {
                        reject(new Error(response.error.message));
                    }
                    else {
                        resolve(response.result);
                    }
                }
            }, this.pluginId);
            // 发送请求
            try {
                this.eventBus.publish(`rpc:request:${targetPlugin}:${method}`, request);
            }
            catch (error) {
                clearTimeout(timeoutHandle);
                this.pendingCalls.delete(requestId);
                this.eventBus.unsubscribe(listenerId);
                reject(error);
            }
        });
    }
    /**
     * 批量调用
     */
    async callBatch(calls) {
        return Promise.all(calls.map(call => this.call(call.plugin, call.method, call.params || [])));
    }
    /**
     * 生成唯一ID
     */
    generateId() {
        return `${this.pluginId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }
    /**
     * 清理资源
     */
    destroy() {
        // 取消所有待处理调用
        for (const [id, pending] of this.pendingCalls) {
            clearTimeout(pending.timeout);
            pending.reject(new Error('RPC client destroyed'));
        }
        this.pendingCalls.clear();
        this.logger.info(`RPC Client destroyed for plugin: ${this.pluginId}`);
    }
}
/**
 * RPC 管理器 - 简化 RPC 使用
 */
export class RpcManager {
    static instance;
    eventBus;
    servers;
    clients;
    logger;
    constructor(eventBus) {
        this.eventBus = eventBus;
        this.servers = new Map();
        this.clients = new Map();
        this.logger = createLogger('RpcManager');
    }
    /**
     * 获取单例实例
     */
    static getInstance(eventBus) {
        if (!RpcManager.instance) {
            RpcManager.instance = new RpcManager(eventBus);
        }
        return RpcManager.instance;
    }
    /**
     * 创建 RPC 服务器
     */
    createServer(pluginId, config) {
        if (this.servers.has(pluginId)) {
            throw new Error(`RPC server already exists for plugin: ${pluginId}`);
        }
        const server = new RpcServer(pluginId, this.eventBus, config);
        this.servers.set(pluginId, server);
        this.logger.info(`Created RPC server for plugin: ${pluginId}`);
        return server;
    }
    /**
     * 创建 RPC 客户端
     */
    createClient(pluginId, config) {
        if (this.clients.has(pluginId)) {
            return this.clients.get(pluginId);
        }
        const client = new RpcClient(pluginId, this.eventBus, config);
        this.clients.set(pluginId, client);
        this.logger.info(`Created RPC client for plugin: ${pluginId}`);
        return client;
    }
    /**
     * 获取所有可用的 RPC 方法
     */
    getAvailableMethods() {
        const methods = [];
        for (const server of this.servers.values()) {
            methods.push(...server.getMethods());
        }
        return methods;
    }
    /**
     * 清理资源
     */
    destroy() {
        for (const server of this.servers.values()) {
            server.destroy();
        }
        for (const client of this.clients.values()) {
            client.destroy();
        }
        this.servers.clear();
        this.clients.clear();
        this.logger.info('RPC Manager destroyed');
    }
}
// 导出默认管理器
export default RpcManager;
//# sourceMappingURL=plugin-rpc.js.map