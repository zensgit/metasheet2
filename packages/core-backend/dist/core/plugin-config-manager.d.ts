/**
 * 插件配置管理器
 * 提供插件配置的统一管理、验证、持久化和变更通知功能
 */
import { EventEmitter } from 'eventemitter3';
import type { ValidationService } from '../types/plugin';
/**
 * 配置模式定义
 */
export interface ConfigSchema {
    type: 'object' | 'array' | 'string' | 'number' | 'boolean';
    properties?: Record<string, ConfigSchema>;
    items?: ConfigSchema;
    required?: string[];
    default?: any;
    enum?: any[];
    minimum?: number;
    maximum?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    description?: string;
    title?: string;
}
/**
 * 插件配置项
 */
export interface PluginConfig {
    pluginName: string;
    config: Record<string, any>;
    schema?: ConfigSchema;
    version: string;
    lastModified: Date;
    modifiedBy?: string;
}
/**
 * 配置变更事件
 */
export interface ConfigChangeEvent {
    pluginName: string;
    key?: string;
    oldValue: any;
    newValue: any;
    timestamp: Date;
    modifiedBy?: string;
}
/**
 * 配置存储接口
 */
export interface ConfigStorage {
    load(pluginName: string): Promise<PluginConfig | null>;
    save(config: PluginConfig): Promise<void>;
    delete(pluginName: string): Promise<void>;
    list(): Promise<string[]>;
    backup(pluginName: string): Promise<string>;
    restore(pluginName: string, backupId: string): Promise<void>;
}
/**
 * 文件系统配置存储
 */
declare class FileSystemConfigStorage implements ConfigStorage {
    private basePath;
    private backupPath;
    private logger;
    constructor(basePath?: string);
    load(pluginName: string): Promise<PluginConfig | null>;
    save(config: PluginConfig): Promise<void>;
    delete(pluginName: string): Promise<void>;
    list(): Promise<string[]>;
    backup(pluginName: string): Promise<string>;
    restore(pluginName: string, backupId: string): Promise<void>;
}
/**
 * 数据库配置存储
 */
declare class DatabaseConfigStorage implements ConfigStorage {
    private db;
    private logger;
    constructor(db: any);
    load(pluginName: string): Promise<PluginConfig | null>;
    save(config: PluginConfig): Promise<void>;
    delete(pluginName: string): Promise<void>;
    list(): Promise<string[]>;
    backup(pluginName: string): Promise<string>;
    restore(pluginName: string, backupId: string): Promise<void>;
}
/**
 * 插件配置管理器
 */
export declare class PluginConfigManager extends EventEmitter {
    private storage;
    private validationService?;
    private logger;
    private configCache;
    private schemaCache;
    constructor(storage?: ConfigStorage, validationService?: ValidationService);
    /**
     * 注册插件配置模式
     */
    registerSchema(pluginName: string, schema: ConfigSchema): void;
    /**
     * 获取插件配置
     */
    getConfig(pluginName: string, useCache?: boolean): Promise<PluginConfig | null>;
    /**
     * 设置插件配置
     */
    setConfig(pluginName: string, config: Record<string, any>, modifiedBy?: string): Promise<void>;
    /**
     * 更新配置项
     */
    updateConfigValue(pluginName: string, key: string, value: any, modifiedBy?: string): Promise<void>;
    /**
     * 删除插件配置
     */
    deleteConfig(pluginName: string): Promise<void>;
    /**
     * 获取所有插件配置
     */
    listConfigs(): Promise<string[]>;
    /**
     * 备份插件配置
     */
    backupConfig(pluginName: string): Promise<string>;
    /**
     * 恢复插件配置
     */
    restoreConfig(pluginName: string, backupId: string): Promise<void>;
    /**
     * 验证插件配置
     */
    private validateConfig;
    /**
     * 验证单个配置值
     */
    private validateConfigValue;
    /**
     * 使用模式验证配置
     */
    private validateConfigWithSchema;
    /**
     * 验证单个值
     */
    private validateValueWithSchema;
    /**
     * 转换为 Zod 模式
     */
    private convertToZodSchema;
    /**
     * 清除缓存
     */
    clearCache(pluginName?: string): void;
    /**
     * 获取配置管理器统计
     */
    getStats(): {
        totalConfigs: number;
        cachedConfigs: number;
        registeredSchemas: number;
    };
    /**
     * 创建数据库存储实例
     */
    static createDatabaseStorage(db: any): ConfigStorage;
    /**
     * 创建文件系统存储实例
     */
    static createFileSystemStorage(basePath?: string): ConfigStorage;
}
export { FileSystemConfigStorage, DatabaseConfigStorage };
//# sourceMappingURL=plugin-config-manager.d.ts.map