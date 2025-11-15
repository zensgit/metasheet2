/**
 * 插件加载器
 */
import { EventEmitter } from 'eventemitter3';
import type { PluginInstance, CoreAPI } from '../types/plugin';
export declare class PluginLoader extends EventEmitter {
    private plugins;
    private loadOrder;
    private coreAPI;
    private logger;
    private manifestValidator;
    constructor(coreAPI: CoreAPI);
    /**
     * 加载所有插件
     */
    loadPlugins(): Promise<void>;
    /**
     * 扫描插件目录
     */
    private scanPluginDirectories;
    /**
     * 加载插件配置文件
     */
    private loadManifests;
    /**
     * 验证插件配置
     */
    private validateManifest;
    /**
     * 拓扑排序（处理依赖关系）
     */
    private topologicalSort;
    /**
     * 加载单个插件
     */
    private loadPlugin;
    /**
     * 检查权限
     */
    private checkPermissions;
    /**
     * 激活所有插件
     */
    private activatePlugins;
    /**
     * 停用插件
     */
    deactivatePlugin(name: string): Promise<void>;
    /**
     * 卸载插件
     */
    unloadPlugin(name: string): Promise<void>;
    /**
     * 获取所有插件
     */
    getPlugins(): Map<string, PluginInstance>;
    /**
     * 获取单个插件
     */
    getPlugin(name: string): PluginInstance | undefined;
    /**
     * 重新加载插件
     */
    reloadPlugin(name: string): Promise<void>;
}
//# sourceMappingURL=plugin-loader.d.ts.map