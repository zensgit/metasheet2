/**
 * 插件配置管理器
 * 提供插件特定的配置管理、环境变量注入、配置验证和动态更新
 */
import { EventEmitter } from 'eventemitter3';
import type { DatabaseAPI, ValidationService } from '../types/plugin';
/**
 * 配置项类型
 */
export declare enum ConfigType {
    STRING = "string",
    NUMBER = "number",
    BOOLEAN = "boolean",
    ARRAY = "array",
    OBJECT = "object",
    SECRET = "secret",// 加密存储的敏感信息
    FILE_PATH = "file_path",
    URL = "url",
    EMAIL = "email"
}
/**
 * 配置项定义
 */
export interface ConfigItem {
    key: string;
    type: ConfigType;
    required: boolean;
    defaultValue?: any;
    description?: string;
    validator?: string;
    sensitive?: boolean;
    options?: any[];
    min?: number;
    max?: number;
    pattern?: string;
    dependsOn?: string[];
    scope?: 'global' | 'user' | 'tenant';
}
/**
 * 配置 Schema
 */
export interface ConfigSchema {
    version: string;
    items: ConfigItem[];
    groups?: Array<{
        name: string;
        title: string;
        description?: string;
        items: string[];
    }>;
}
/**
 * 配置值
 */
export interface ConfigValue {
    key: string;
    value: any;
    encrypted: boolean;
    scope: string;
    userId?: string;
    tenantId?: string;
    updatedAt: Date;
    updatedBy?: string;
}
/**
 * 配置更改事件
 */
export interface ConfigChangeEvent {
    pluginName: string;
    key: string;
    oldValue: any;
    newValue: any;
    scope: string;
    userId?: string;
    updatedBy?: string;
}
/**
 * 插件配置管理器
 */
export declare class PluginConfigManager extends EventEmitter {
    private schemas;
    private configs;
    private encryptionKey;
    private database?;
    private validationService?;
    private logger;
    constructor(encryptionKey?: string, database?: DatabaseAPI, validationService?: ValidationService);
    /**
     * 注册插件配置 Schema
     */
    registerSchema(pluginName: string, schema: ConfigSchema): Promise<void>;
    /**
     * 获取插件配置 Schema
     */
    getSchema(pluginName: string): ConfigSchema | undefined;
    /**
     * 设置配置值
     */
    setConfig(pluginName: string, key: string, value: any, options?: {
        scope?: 'global' | 'user' | 'tenant';
        userId?: string;
        tenantId?: string;
        updatedBy?: string;
    }): Promise<void>;
    /**
     * 获取配置值
     */
    getConfig(pluginName: string, key: string, options?: {
        scope?: 'global' | 'user' | 'tenant';
        userId?: string;
        tenantId?: string;
        includeDefaults?: boolean;
    }): Promise<any>;
    /**
     * 获取所有配置
     */
    getAllConfigs(pluginName: string, options?: {
        scope?: 'global' | 'user' | 'tenant';
        userId?: string;
        tenantId?: string;
        includeDefaults?: boolean;
        includeSensitive?: boolean;
    }): Promise<Record<string, any>>;
    /**
     * 删除配置值
     */
    deleteConfig(pluginName: string, key: string, options?: {
        scope?: 'global' | 'user' | 'tenant';
        userId?: string;
        tenantId?: string;
    }): Promise<void>;
    /**
     * 验证插件所有配置
     */
    validateAllConfigs(pluginName: string, options?: {
        scope?: 'global' | 'user' | 'tenant';
        userId?: string;
        tenantId?: string;
    }): Promise<{
        valid: boolean;
        errors: Array<{
            key: string;
            error: string;
        }>;
    }>;
    /**
     * 重置插件配置为默认值
     */
    resetToDefaults(pluginName: string, options?: {
        scope?: 'global' | 'user' | 'tenant';
        userId?: string;
        tenantId?: string;
    }): Promise<void>;
    /**
     * 导出配置
     */
    exportConfigs(pluginName: string, options?: {
        scope?: 'global' | 'user' | 'tenant';
        userId?: string;
        tenantId?: string;
        includeSensitive?: boolean;
    }): Promise<{
        schema: ConfigSchema;
        configs: Record<string, any>;
    }>;
    /**
     * 导入配置
     */
    importConfigs(pluginName: string, data: {
        schema?: ConfigSchema;
        configs: Record<string, any>;
    }, options?: {
        scope?: 'global' | 'user' | 'tenant';
        userId?: string;
        tenantId?: string;
        overwrite?: boolean;
    }): Promise<void>;
    /**
     * 获取环境变量映射
     */
    getEnvironmentVariables(pluginName: string): Record<string, any>;
    /**
     * 从数据库加载配置
     */
    loadFromDatabase(): Promise<void>;
    /**
     * 验证配置Schema
     */
    private validateSchema;
    /**
     * 验证配置值
     */
    private validateConfigValue;
    /**
     * 应用默认值
     */
    private applyDefaultValues;
    /**
     * 检查依赖配置
     */
    private checkDependencies;
    /**
     * 构建配置键
     */
    private buildConfigKey;
    /**
     * 查找继承的配置
     */
    private findInheritedConfig;
    /**
     * 加密敏感信息
     */
    private encrypt;
    /**
     * 解密敏感信息
     */
    private decrypt;
    /**
     * 生成加密键
     */
    private generateEncryptionKey;
    /**
     * 持久化Schema
     */
    private persistSchema;
    /**
     * 持久化配置值
     */
    private persistConfigValue;
    /**
     * 从数据库删除配置
     */
    private removeConfigFromDatabase;
}
export { ConfigType, ConfigItem, ConfigSchema, ConfigValue, ConfigChangeEvent };
//# sourceMappingURL=PluginConfigManager.d.ts.map