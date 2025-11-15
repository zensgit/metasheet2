/**
 * 插件管理器
 * 整合所有插件相关功能的顶层管理器
 */
import { EventEmitter } from 'eventemitter3';
import { PluginManifest, PluginRegistration, CoreAPI, PluginStatus, PluginCapability } from '../types/plugin';
import { type ServiceFactoryOptions } from './plugin-service-factory';
/**
 * 插件管理器配置
 */
export interface PluginManagerConfig {
    pluginDirectories?: string[];
    services?: ServiceFactoryOptions;
    configStorage?: 'file' | 'database';
    configPath?: string;
    security?: {
        enableSandbox?: boolean;
        allowUnsafePlugins?: boolean;
    };
    autoLoad?: boolean;
    autoStart?: boolean;
}
/**
 * 插件管理器
 */
export declare class PluginManager extends EventEmitter {
    private registry;
    private loader;
    private configManager;
    private serviceFactory;
    private services;
    private config;
    private logger;
    private initialized;
    constructor(coreAPI: CoreAPI, config?: PluginManagerConfig);
    /**
     * 初始化插件管理器
     */
    initialize(): Promise<void>;
    /**
     * 发现插件
     */
    discoverPlugins(): Promise<PluginRegistration[]>;
    /**
     * 启动已安装的插件
     */
    startInstalledPlugins(): Promise<void>;
    /**
     * 安装插件
     */
    installPlugin(manifest: PluginManifest): Promise<PluginRegistration>;
    /**
     * 启动插件
     */
    startPlugin(pluginName: string): Promise<void>;
    /**
     * 停止插件
     */
    stopPlugin(pluginName: string): Promise<void>;
    /**
     * 卸载插件
     */
    uninstallPlugin(pluginName: string): Promise<void>;
    /**
     * 更新插件配置
     */
    updatePluginConfig(pluginName: string, config: Record<string, any>, modifiedBy?: string): Promise<void>;
    /**
     * 获取插件配置
     */
    getPluginConfig(pluginName: string): Promise<Record<string, any> | null>;
    /**
     * 获取所有插件
     */
    getPlugins(): PluginRegistration[];
    /**
     * 获取特定插件
     */
    getPlugin(pluginName: string): PluginRegistration | null;
    /**
     * 按状态获取插件
     */
    getPluginsByStatus(status: PluginStatus): PluginRegistration[];
    /**
     * 按能力获取插件
     */
    getPluginsByCapability(capability: PluginCapability): PluginRegistration[];
    /**
     * 获取插件统计信息
     */
    getStats(): {
        total: number;
        enabled: number;
        disabled: number;
        error: number;
        capabilities: Record<PluginCapability, number>;
        services: Record<string, any>;
    };
    /**
     * 获取健康状态
     */
    getHealth(): Promise<Record<string, any>>;
    /**
     * 销毁插件管理器
     */
    destroy(): Promise<void>;
    /**
     * 设置事件监听器
     */
    private setupEventListeners;
    /**
     * 为插件创建CoreAPI实例
     */
    private createCoreAPIForPlugin;
}
/**
 * 创建插件管理器的便捷方法
 */
export declare function createPluginManager(coreAPI: CoreAPI, config?: PluginManagerConfig): Promise<PluginManager>;
//# sourceMappingURL=plugin-manager.d.ts.map