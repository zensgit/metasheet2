/**
 * 插件服务工厂
 * 负责创建和管理所有插件相关服务的实例
 */
import type { PluginServices } from '../types/plugin';
/**
 * 服务配置选项
 */
export interface ServiceFactoryOptions {
    cache?: {
        provider?: 'memory' | 'redis';
        redis?: {
            host?: string;
            port?: number;
            password?: string;
            db?: number;
        };
    };
    queue?: {
        provider?: 'memory' | 'bull' | 'bullmq';
        redis?: {
            host?: string;
            port?: number;
            password?: string;
            db?: number;
        };
    };
    storage?: {
        provider?: 'local' | 's3';
        local?: {
            basePath?: string;
        };
        s3?: {
            region?: string;
            bucket?: string;
            accessKeyId?: string;
            secretAccessKey?: string;
        };
    };
    scheduler?: {
        provider?: 'memory' | 'database';
    };
    notification?: {
        channels?: string[];
        email?: {
            provider?: 'smtp' | 'sendgrid' | 'ses';
            config?: any;
        };
        webhook?: {
            timeout?: number;
        };
    };
    websocket?: {
        io?: any;
    };
    security?: {
        encryptionKey?: string;
        sandbox?: {
            memoryLimit?: number;
            timeoutLimit?: number;
        };
    };
    validation?: {
        strict?: boolean;
    };
}
/**
 * 插件服务工厂
 */
export declare class PluginServiceFactory {
    private services;
    private options;
    private logger;
    constructor(options?: ServiceFactoryOptions);
    /**
     * 创建所有服务实例
     */
    createServices(): Promise<PluginServices>;
    /**
     * 创建缓存服务
     */
    private createCacheService;
    /**
     * 创建队列服务
     */
    private createQueueService;
    /**
     * 创建存储服务
     */
    private createStorageService;
    /**
     * 创建调度服务
     */
    private createSchedulerService;
    /**
     * 创建通知服务
     */
    private createNotificationService;
    /**
     * 创建WebSocket服务
     */
    private createWebSocketService;
    /**
     * 创建安全服务
     */
    private createSecurityService;
    /**
     * 创建验证服务
     */
    private createValidationService;
    /**
     * 设置服务间的相互连接
     */
    private setupServiceInterconnections;
    /**
     * 获取服务实例（单例模式）
     */
    getServices(): Promise<PluginServices>;
    /**
     * 销毁所有服务
     */
    destroy(): Promise<void>;
    /**
     * 获取服务健康状态
     */
    getHealth(): Promise<Record<string, any>>;
}
export declare const pluginServiceFactory: PluginServiceFactory;
export declare function getPluginServices(): Promise<PluginServices>;
export declare function configurePluginServices(options: ServiceFactoryOptions): Promise<PluginServices>;
//# sourceMappingURL=plugin-service-factory.d.ts.map