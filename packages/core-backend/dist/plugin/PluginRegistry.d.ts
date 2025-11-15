/**
 * 插件注册表
 * 提供中心化的插件注册、发现和管理功能
 */
import { EventEmitter } from 'eventemitter3';
import type { PluginManifest, PluginRegistration, DatabaseAPI } from '../types/plugin';
import { PluginStatus, PluginCapability } from '../types/plugin';
/**
 * 插件查询选项
 */
export interface PluginQuery {
    name?: string;
    status?: PluginStatus;
    capability?: PluginCapability;
    tag?: string;
    author?: string;
    version?: string;
    enabled?: boolean;
}
/**
 * 插件搜索结果
 */
export interface PluginSearchResult {
    plugin: PluginRegistration;
    score: number;
    matchedFields: string[];
}
/**
 * 插件依赖图
 */
export interface DependencyGraph {
    nodes: Array<{
        id: string;
        plugin: PluginRegistration;
    }>;
    edges: Array<{
        from: string;
        to: string;
        type: 'dependency' | 'peer';
    }>;
    cycles: string[][];
}
/**
 * 插件注册表实现
 */
export declare class PluginRegistry extends EventEmitter {
    private plugins;
    private pluginsByCapability;
    private pluginsByAuthor;
    private pluginTags;
    private dependencyGraph;
    private capabilityManager;
    private database?;
    private logger;
    constructor(database?: DatabaseAPI);
    /**
     * 注册插件
     */
    register(manifest: PluginManifest, capabilities?: PluginCapability[]): Promise<PluginRegistration>;
    /**
     * 卸载插件
     */
    unregister(pluginName: string): Promise<void>;
    /**
     * 启用插件
     */
    enable(pluginName: string): Promise<void>;
    /**
     * 禁用插件
     */
    disable(pluginName: string): Promise<void>;
    /**
     * 获取插件
     */
    get(pluginName: string): PluginRegistration | undefined;
    /**
     * 检查插件是否存在
     */
    has(pluginName: string): boolean;
    /**
     * 获取所有插件
     */
    getAll(): PluginRegistration[];
    /**
     * 查询插件
     */
    query(options?: PluginQuery): PluginRegistration[];
    /**
     * 搜索插件
     */
    search(keyword: string, limit?: number): PluginSearchResult[];
    /**
     * 获取具有特定能力的插件
     */
    getByCapability(capability: PluginCapability): PluginRegistration[];
    /**
     * 获取作者的所有插件
     */
    getByAuthor(author: string): PluginRegistration[];
    /**
     * 获取依赖图
     */
    getDependencyGraph(): DependencyGraph;
    /**
     * 获取插件的依赖
     */
    getDependencies(pluginName: string): PluginRegistration[];
    /**
     * 获取依赖于指定插件的插件
     */
    getDependents(pluginName: string): PluginRegistration[];
    /**
     * 检查循环依赖
     */
    findCircularDependencies(): string[][];
    /**
     * 获取插件统计信息
     */
    getStats(): {
        total: number;
        enabled: number;
        disabled: number;
        error: number;
        byCapability: {
            [k: string]: number;
        };
        authors: number;
        dependencies: number;
    };
    /**
     * 验证插件清单
     */
    private validateManifest;
    /**
     * 检查版本兼容性
     */
    private checkVersionCompatibility;
    /**
     * 检查依赖
     */
    private checkDependencies;
    /**
     * 检查已启用的依赖
     */
    private checkEnabledDependencies;
    /**
     * 解析依赖信息
     */
    private parseDependencies;
    /**
     * 查找依赖于指定插件的插件
     */
    private findDependents;
    /**
     * 查找启用的依赖插件
     */
    private findEnabledDependents;
    /**
     * 更新索引
     */
    private updateIndexes;
    /**
     * 从索引中移除
     */
    private removeFromIndexes;
    /**
     * 重新构建依赖图
     */
    private rebuildDependencyGraph;
    /**
     * 检测循环依赖
     */
    private detectCycles;
    /**
     * 持久化到数据库
     */
    private persistToDatabase;
    /**
     * 从数据库中删除
     */
    private removeFromDatabase;
    /**
     * 更新插件状态
     */
    private updatePluginStatus;
    /**
     * 从数据库加载插件
     */
    loadFromDatabase(): Promise<void>;
}
export { PluginQuery, PluginSearchResult, DependencyGraph };
//# sourceMappingURL=PluginRegistry.d.ts.map