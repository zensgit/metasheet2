/**
 * 插件能力系统
 * 定义和管理插件的各种能力，提供能力验证和权限检查
 */
import { EventEmitter } from 'eventemitter3';
import { PluginCapability, PluginManifest } from '../types/plugin';
/**
 * 能力依赖关系定义
 */
export declare const CAPABILITY_DEPENDENCIES: Record<any, any[]>;
/**
 * 能力冲突定义（互斥的能力）
 */
export declare const CAPABILITY_CONFLICTS: Record<any, any[]>;
/**
 * 能力优先级定义（用于解决冲突时的选择）
 */
export declare const CAPABILITY_PRIORITY: Record<any, number>;
/**
 * 能力描述
 */
export declare const CAPABILITY_DESCRIPTIONS: Record<any, string>;
/**
 * 能力验证结果
 */
export interface CapabilityValidationResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
    missingDependencies: PluginCapability[];
    conflicts: PluginCapability[];
    requiredPermissions: string[];
}
/**
 * 能力注册信息
 */
export interface CapabilityRegistration {
    pluginName: string;
    capability: PluginCapability;
    implementation: any;
    priority: number;
    metadata: Record<string, any>;
    registeredAt: Date;
}
/**
 * 插件能力管理器
 */
export declare class PluginCapabilityManager extends EventEmitter {
    private registrations;
    private pluginCapabilities;
    private logger;
    constructor();
    /**
     * 验证插件能力
     */
    validateCapabilities(manifest: PluginManifest, requestedCapabilities: PluginCapability[]): CapabilityValidationResult;
    /**
     * 注册能力实现
     */
    registerCapability(pluginName: string, capability: PluginCapability, implementation: any, metadata?: Record<string, any>): void;
    /**
     * 取消注册能力
     */
    unregisterCapability(pluginName: string, capability: PluginCapability): void;
    /**
     * 取消注册插件的所有能力
     */
    unregisterPluginCapabilities(pluginName: string): void;
    /**
     * 获取能力的实现
     */
    getCapabilityImplementations(capability: PluginCapability): CapabilityRegistration[];
    /**
     * 获取最高优先级的能力实现
     */
    getPrimaryImplementation(capability: PluginCapability): CapabilityRegistration | null;
    /**
     * 获取插件的能力
     */
    getPluginCapabilities(pluginName: string): PluginCapability[];
    /**
     * 检查插件是否具有某个能力
     */
    hasCapability(pluginName: string, capability: PluginCapability): boolean;
    /**
     * 获取所有已注册的能力
     */
    getAllRegisteredCapabilities(): PluginCapability[];
    /**
     * 获取能力统计信息
     */
    getCapabilityStats(): Record<PluginCapability, number>;
    /**
     * 解析能力依赖
     */
    private resolveDependencies;
    /**
     * 查找能力冲突
     */
    private findConflicts;
    /**
     * 获取能力所需的权限
     */
    private getRequiredPermissions;
    /**
     * 验证能力的实现要求
     */
    private validateCapabilityImplementation;
    /**
     * 生成能力兼容性报告
     */
    generateCompatibilityReport(capabilities: PluginCapability[]): {
        compatible: boolean;
        issues: Array<{
            type: 'error' | 'warning';
            message: string;
        }>;
        suggestions: string[];
    };
    /**
     * 清理所有注册
     */
    clear(): void;
}
/**
 * 能力工具函数
 */
export declare const CapabilityUtils: {
    /**
     * 获取能力的描述
     */
    getDescription(capability: PluginCapability): string;
    /**
     * 获取能力的优先级
     */
    getPriority(capability: PluginCapability): number;
    /**
     * 检查两个能力是否冲突
     */
    areConflicting(cap1: PluginCapability, cap2: PluginCapability): boolean;
    /**
     * 获取能力的依赖
     */
    getDependencies(capability: PluginCapability): PluginCapability[];
    /**
     * 获取能力所需的权限
     */
    getRequiredPermissions(capability: PluginCapability): string[];
    /**
     * 按优先级排序能力
     */
    sortByPriority(capabilities: PluginCapability[]): PluginCapability[];
};
//# sourceMappingURL=PluginCapabilities.d.ts.map