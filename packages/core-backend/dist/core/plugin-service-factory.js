"use strict";
/**
 * 插件服务工厂
 * 负责创建和管理所有插件相关服务的实例
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.pluginServiceFactory = exports.PluginServiceFactory = void 0;
exports.getPluginServices = getPluginServices;
exports.configurePluginServices = configurePluginServices;
const logger_1 = require("./logger");
// 导入服务实现
const CacheService_1 = require("../services/CacheService");
const QueueService_1 = require("../services/QueueService");
const StorageService_1 = require("../services/StorageService");
const SchedulerService_1 = require("../services/SchedulerService");
const NotificationService_1 = require("../services/NotificationService");
// 类型宽容：某些实现可能缺少类型声明，使用 any 断言避免编译阻塞
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
const WebSocketService_1 = require("../services/WebSocketService");
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
const SecurityService_1 = require("../services/SecurityService");
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
const ValidationService_1 = require("../services/ValidationService");
/**
 * 插件服务工厂
 */
class PluginServiceFactory {
    services = null;
    options;
    logger;
    constructor(options = {}) {
        this.options = options;
        this.logger = new logger_1.Logger('PluginServiceFactory');
    }
    /**
     * 创建所有服务实例
     */
    async createServices() {
        if (this.services) {
            return this.services;
        }
        this.logger.info('Creating plugin services...');
        try {
            const services = {
                cache: await this.createCacheService(),
                queue: await this.createQueueService(),
                storage: await this.createStorageService(),
                scheduler: await this.createSchedulerService(),
                notification: await this.createNotificationService(),
                websocket: await this.createWebSocketService(),
                security: await this.createSecurityService(),
                validation: await this.createValidationService()
            };
            // 设置服务间的相互引用
            this.setupServiceInterconnections(services);
            this.services = services;
            this.logger.info('All plugin services created successfully');
            return services;
        }
        catch (error) {
            this.logger.error('Failed to create plugin services', error);
            throw error;
        }
    }
    /**
     * 创建缓存服务
     */
    async createCacheService() {
        const config = this.options.cache || {};
        switch (config.provider) {
            case 'redis':
                try {
                    // 动态导入Redis客户端（软依赖）
                    // eslint-disable-next-line @typescript-eslint/no-var-requires
                    const Redis = require('ioredis');
                    const redis = new Redis(config.redis || {});
                    return CacheService_1.CacheServiceImpl.createRedisService(redis);
                }
                catch (error) {
                    this.logger.warn('Redis not available, falling back to memory cache', error);
                    return CacheService_1.CacheServiceImpl.createMemoryService();
                }
            case 'memory':
            default:
                return CacheService_1.CacheServiceImpl.createMemoryService();
        }
    }
    /**
     * 创建队列服务
     */
    async createQueueService() {
        const config = this.options.queue || {};
        switch (config.provider) {
            case 'bull':
            case 'bullmq':
                try {
                    // 动态导入Bull队列（软依赖）
                    // eslint-disable-next-line @typescript-eslint/no-var-requires
                    require('bull');
                    const queueService = new QueueService_1.QueueServiceImpl();
                    return queueService;
                }
                catch (error) {
                    this.logger.warn('Bull not available, falling back to memory queue', error);
                    return new QueueService_1.QueueServiceImpl();
                }
            case 'memory':
            default:
                return new QueueService_1.QueueServiceImpl();
        }
    }
    /**
     * 创建存储服务
     */
    async createStorageService() {
        const config = this.options.storage || {};
        const service = new StorageService_1.StorageServiceImpl();
        switch (config.provider) {
            case 's3':
                try {
                    // 动态导入AWS SDK（软依赖）
                    // eslint-disable-next-line @typescript-eslint/no-var-requires
                    const AWS = require('aws-sdk');
                    const s3 = new AWS.S3(config.s3 || {});
                    // 配置S3存储（存在性检查）
                    if (typeof service.configureProvider === 'function') {
                        service.configureProvider('s3', s3);
                    }
                }
                catch (error) {
                    this.logger.warn('AWS SDK not available, using local storage', error);
                }
                break;
            case 'local':
            default:
                // 使用本地文件存储
                if (typeof service.configureProvider === 'function') {
                    service.configureProvider('local', config.local || {});
                }
                break;
        }
        return service;
    }
    /**
     * 创建调度服务
     */
    async createSchedulerService() {
        const config = this.options.scheduler || {};
        const service = new SchedulerService_1.SchedulerServiceImpl();
        // 可以在这里配置调度器的存储后端
        if (config.provider === 'database') {
            // 配置数据库存储
        }
        return service;
    }
    /**
     * 创建通知服务
     */
    async createNotificationService() {
        const config = this.options.notification || {};
        const service = new NotificationService_1.NotificationServiceImpl();
        // 注册额外的通知渠道
        if (config.channels) {
            for (const channel of config.channels) {
                try {
                    switch (channel) {
                        case 'dingtalk':
                            // 注册钉钉渠道
                            break;
                        case 'teams':
                            // 注册Teams渠道
                            break;
                        case 'slack':
                            // 注册Slack渠道
                            break;
                    }
                }
                catch (error) {
                    this.logger.warn(`Failed to register notification channel: ${channel}`, error);
                }
            }
        }
        return service;
    }
    /**
     * 创建WebSocket服务
     */
    async createWebSocketService() {
        const config = this.options.websocket || {};
        const service = new WebSocketService_1.WebSocketServiceImpl(config.io);
        return service;
    }
    /**
     * 创建安全服务
     */
    async createSecurityService() {
        const config = this.options.security || {};
        const service = new SecurityService_1.SecurityServiceImpl(config.encryptionKey);
        return service;
    }
    /**
     * 创建验证服务
     */
    async createValidationService() {
        const config = this.options.validation || {};
        const service = new ValidationService_1.ValidationServiceImpl();
        return service;
    }
    /**
     * 设置服务间的相互连接
     */
    setupServiceInterconnections(services) {
        // 调度服务使用队列服务执行任务
        ;
        services.scheduler.on?.('job:execute', async (job) => {
            await services.queue.add('scheduled', job.name, job.data, {
                delay: 0,
                attempts: 1
            });
        });
        services.notification.on?.('notification:batch', async (notifications) => {
            for (const notification of notifications) {
                await services.queue.add('notifications', 'send', notification, {
                    attempts: 3,
                    backoff: 'exponential'
                });
            }
        });
        // 安全服务使用缓存服务缓存权限检查结果
        const originalCheckPermission = services.security.checkPermission;
        services.security.checkPermission = async (pluginName, permission) => {
            const cacheKey = `perm:${pluginName}:${permission}`;
            let cached = await services.cache.get(cacheKey);
            if (cached !== null) {
                return cached;
            }
            const result = await originalCheckPermission.call(services.security, pluginName, permission);
            await services.cache.set(cacheKey, result, { ttl: 300 }); // 5分钟缓存
            return result;
        };
        services.storage.on?.('file:uploaded', async (event) => {
            const cacheKey = `file:${event.fileId}`;
            await services.cache.set(cacheKey, event.metadata, { ttl: 3600 }); // 1小时缓存
        });
        this.logger.debug('Service interconnections established');
    }
    /**
     * 获取服务实例（单例模式）
     */
    async getServices() {
        if (!this.services) {
            return await this.createServices();
        }
        return this.services;
    }
    /**
     * 销毁所有服务
     */
    async destroy() {
        if (!this.services)
            return;
        this.logger.info('Destroying plugin services...');
        try {
            // 清理缓存
            await this.services.cache.clear();
            // 停止调度器
            const scheduledJobs = await this.services.scheduler.listJobs();
            for (const job of scheduledJobs) {
                await this.services.scheduler.unschedule(job.name);
            }
            // 清理WebSocket连接
            this.services.websocket.cleanup?.();
            // 清理队列
            // 注意: 这里可能需要等待正在运行的任务完成
            this.services = null;
            this.logger.info('All plugin services destroyed');
        }
        catch (error) {
            this.logger.error('Error during service destruction', error);
            throw error;
        }
    }
    /**
     * 获取服务健康状态
     */
    async getHealth() {
        if (!this.services) {
            return { status: 'not_initialized' };
        }
        const health = {};
        try {
            // 缓存健康检查
            health.cache = {
                status: 'healthy',
                size: await this.services.cache.size()
            };
        }
        catch (error) {
            health.cache = { status: 'unhealthy', error: error.message };
        }
        try {
            // 队列健康检查
            health.queue = {
                status: 'healthy',
                stats: await this.services.queue.getQueueStatus('default')
            };
        }
        catch (error) {
            health.queue = { status: 'unhealthy', error: error.message };
        }
        try {
            // WebSocket健康检查
            health.websocket = {
                status: 'healthy',
                stats: this.services.websocket.getStats?.()
            };
        }
        catch (error) {
            health.websocket = { status: 'unhealthy', error: error.message };
        }
        try {
            // 调度器健康检查
            const jobs = await this.services.scheduler.listJobs();
            health.scheduler = {
                status: 'healthy',
                jobCount: jobs.length,
                activeJobs: jobs.filter(j => !j.isPaused).length
            };
        }
        catch (error) {
            health.scheduler = { status: 'unhealthy', error: error.message };
        }
        return health;
    }
}
exports.PluginServiceFactory = PluginServiceFactory;
// 导出单例工厂实例
exports.pluginServiceFactory = new PluginServiceFactory();
// 导出便捷方法
async function getPluginServices() {
    return exports.pluginServiceFactory.getServices();
}
async function configurePluginServices(options) {
    const factory = new PluginServiceFactory(options);
    return factory.createServices();
}
//# sourceMappingURL=plugin-service-factory.js.map