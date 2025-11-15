/**
 * 插件注册中心
 * 提供插件的集中管理、生命周期控制、依赖管理等功能
 */
import { EventEmitter } from 'eventemitter3';
import { PluginManifest, PluginRegistration, PluginCapability, PluginStatus, CoreAPI } from '../types/plugin';
/**
 * 插件注册中心实现
 */
export declare class PluginRegistry extends EventEmitter {
    private registrations;
    private loader;
    private dependencyResolver;
    private logger;
    private capabilities;
    constructor(coreAPI: CoreAPI);
    private setupLoaderListeners;
    /**
     * 注册插件
     */
    registerPlugin(manifest: PluginManifest): Promise<PluginRegistration>;
    /**
     * 启用插件
     */
    enablePlugin(pluginName: string): Promise<void>;
    /**
     * 禁用插件
     */
    disablePlugin(pluginName: string): Promise<void>;
    /**
     * 卸载插件
     */
    uninstallPlugin(pluginName: string): Promise<void>;
    /**
     * 更新插件
     */
    updatePlugin(pluginName: string, newManifest: PluginManifest): Promise<void>;
    /**
     * 获取插件注册信息
     */
    getPlugin(pluginName: string): PluginRegistration | null;
    /**
     * 获取所有插件
     */
    getAllPlugins(): PluginRegistration[];
    /**
     * 按状态获取插件
     */
    getPluginsByStatus(status: PluginStatus): PluginRegistration[];
    /**
     * 按能力获取插件
     */
    getPluginsByCapability(capability: PluginCapability): PluginRegistration[];
    /**
     * 检查插件依赖
     */
    private checkDependencies;
    /**
     * 检查反向依赖
     */
    private checkReverseDependencies;
    /**
     * 验证插件清单
     */
    private validateManifest;
    /**
     * 提取插件能力
     */
    private extractCapabilities;
    /**
     * 提取插件依赖
     */
    private extractDependencies;
    /**
     * 验证权限
     */
    private validatePermissions;
    /**
     * 更新插件状态
     */
    private updatePluginStatus;
    /**
     * 获取统计信息
     */
    getStats(): {
        total: number;
        enabled: number;
        disabled: number;
        error: number;
        capabilities: Record<PluginCapability, number>;
    };
    /**
     * 获取依赖图
     */
    getDependencyGraph(): Record<string, string[]>;
}
//# sourceMappingURL=plugin-registry.d.ts.map