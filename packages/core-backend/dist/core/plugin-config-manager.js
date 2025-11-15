"use strict";
/**
 * 插件配置管理器
 * 提供插件配置的统一管理、验证、持久化和变更通知功能
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DatabaseConfigStorage = exports.FileSystemConfigStorage = exports.PluginConfigManager = void 0;
const eventemitter3_1 = require("eventemitter3");
const path = __importStar(require("path"));
const fs = __importStar(require("fs/promises"));
const zod_1 = require("zod");
const logger_1 = require("./logger");
/**
 * 文件系统配置存储
 */
class FileSystemConfigStorage {
    basePath;
    backupPath;
    logger;
    constructor(basePath = './config/plugins') {
        this.basePath = basePath;
        this.backupPath = path.join(basePath, '.backups');
        this.logger = new logger_1.Logger('FileSystemConfigStorage');
    }
    async load(pluginName) {
        try {
            const configPath = path.join(this.basePath, `${pluginName}.json`);
            const content = await fs.readFile(configPath, 'utf-8');
            return JSON.parse(content);
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                return null;
            }
            this.logger.error(`Failed to load config for ${pluginName}`, error);
            throw error;
        }
    }
    async save(config) {
        try {
            // 确保目录存在
            await fs.mkdir(this.basePath, { recursive: true });
            const configPath = path.join(this.basePath, `${config.pluginName}.json`);
            const content = JSON.stringify(config, null, 2);
            await fs.writeFile(configPath, content, 'utf-8');
        }
        catch (error) {
            this.logger.error(`Failed to save config for ${config.pluginName}`, error);
            throw error;
        }
    }
    async delete(pluginName) {
        try {
            const configPath = path.join(this.basePath, `${pluginName}.json`);
            await fs.unlink(configPath);
        }
        catch (error) {
            if (error.code !== 'ENOENT') {
                this.logger.error(`Failed to delete config for ${pluginName}`, error);
                throw error;
            }
        }
    }
    async list() {
        try {
            const files = await fs.readdir(this.basePath);
            return files
                .filter(f => f.endsWith('.json') && !f.startsWith('.'))
                .map(f => f.replace('.json', ''));
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                return [];
            }
            this.logger.error('Failed to list plugin configs', error);
            throw error;
        }
    }
    async backup(pluginName) {
        try {
            const config = await this.load(pluginName);
            if (!config) {
                throw new Error(`Config not found for plugin: ${pluginName}`);
            }
            // 确保备份目录存在
            await fs.mkdir(this.backupPath, { recursive: true });
            const backupId = `${pluginName}_${Date.now()}`;
            const backupPath = path.join(this.backupPath, `${backupId}.json`);
            const backupContent = {
                ...config,
                backupId,
                backupTimestamp: new Date()
            };
            await fs.writeFile(backupPath, JSON.stringify(backupContent, null, 2), 'utf-8');
            return backupId;
        }
        catch (error) {
            this.logger.error(`Failed to backup config for ${pluginName}`, error);
            throw error;
        }
    }
    async restore(pluginName, backupId) {
        try {
            const backupPath = path.join(this.backupPath, `${backupId}.json`);
            const content = await fs.readFile(backupPath, 'utf-8');
            const backupConfig = JSON.parse(content);
            // 移除备份特定字段
            delete backupConfig.backupId;
            delete backupConfig.backupTimestamp;
            // 更新时间戳
            backupConfig.lastModified = new Date();
            backupConfig.modifiedBy = 'system:restore';
            await this.save(backupConfig);
        }
        catch (error) {
            this.logger.error(`Failed to restore config for ${pluginName} from ${backupId}`, error);
            throw error;
        }
    }
}
exports.FileSystemConfigStorage = FileSystemConfigStorage;
/**
 * 数据库配置存储
 */
class DatabaseConfigStorage {
    db; // 数据库连接
    logger;
    constructor(db) {
        this.db = db;
        this.logger = new logger_1.Logger('DatabaseConfigStorage');
    }
    async load(pluginName) {
        try {
            const result = await this.db.selectFrom('plugin_configs')
                .selectAll()
                .where('plugin_name', '=', pluginName)
                .executeTakeFirst();
            if (!result)
                return null;
            return {
                pluginName: result.plugin_name,
                config: result.config,
                schema: result.schema,
                version: result.version,
                lastModified: result.last_modified,
                modifiedBy: result.modified_by
            };
        }
        catch (error) {
            this.logger.error(`Failed to load config for ${pluginName}`, error);
            throw error;
        }
    }
    async save(config) {
        try {
            await this.db.insertInto('plugin_configs')
                .values({
                plugin_name: config.pluginName,
                config: config.config,
                schema: config.schema,
                version: config.version,
                last_modified: config.lastModified,
                modified_by: config.modifiedBy
            })
                .onConflict(oc => oc.column('plugin_name').doUpdateSet({
                config: config.config,
                schema: config.schema,
                version: config.version,
                last_modified: config.lastModified,
                modified_by: config.modifiedBy
            }))
                .execute();
        }
        catch (error) {
            this.logger.error(`Failed to save config for ${config.pluginName}`, error);
            throw error;
        }
    }
    async delete(pluginName) {
        try {
            await this.db.deleteFrom('plugin_configs')
                .where('plugin_name', '=', pluginName)
                .execute();
        }
        catch (error) {
            this.logger.error(`Failed to delete config for ${pluginName}`, error);
            throw error;
        }
    }
    async list() {
        try {
            const results = await this.db.selectFrom('plugin_configs')
                .select('plugin_name')
                .execute();
            return results.map((r) => r.plugin_name);
        }
        catch (error) {
            this.logger.error('Failed to list plugin configs', error);
            throw error;
        }
    }
    async backup(pluginName) {
        try {
            const config = await this.load(pluginName);
            if (!config) {
                throw new Error(`Config not found for plugin: ${pluginName}`);
            }
            const backupId = `${pluginName}_${Date.now()}`;
            await this.db.insertInto('plugin_config_backups')
                .values({
                backup_id: backupId,
                plugin_name: pluginName,
                config: config.config,
                schema: config.schema,
                version: config.version,
                backup_timestamp: new Date()
            })
                .execute();
            return backupId;
        }
        catch (error) {
            this.logger.error(`Failed to backup config for ${pluginName}`, error);
            throw error;
        }
    }
    async restore(pluginName, backupId) {
        try {
            const backup = await this.db.selectFrom('plugin_config_backups')
                .selectAll()
                .where('backup_id', '=', backupId)
                .executeTakeFirst();
            if (!backup) {
                throw new Error(`Backup not found: ${backupId}`);
            }
            const restoredConfig = {
                pluginName: backup.plugin_name,
                config: backup.config,
                schema: backup.schema,
                version: backup.version,
                lastModified: new Date(),
                modifiedBy: 'system:restore'
            };
            await this.save(restoredConfig);
        }
        catch (error) {
            this.logger.error(`Failed to restore config for ${pluginName} from ${backupId}`, error);
            throw error;
        }
    }
}
exports.DatabaseConfigStorage = DatabaseConfigStorage;
/**
 * 插件配置管理器
 */
class PluginConfigManager extends eventemitter3_1.EventEmitter {
    storage;
    validationService;
    logger;
    configCache = new Map();
    schemaCache = new Map();
    constructor(storage, validationService) {
        super();
        this.storage = storage || new FileSystemConfigStorage();
        this.validationService = validationService;
        this.logger = new logger_1.Logger('PluginConfigManager');
    }
    /**
     * 注册插件配置模式
     */
    registerSchema(pluginName, schema) {
        this.schemaCache.set(pluginName, schema);
        this.logger.debug(`Registered config schema for plugin: ${pluginName}`);
    }
    /**
     * 获取插件配置
     */
    async getConfig(pluginName, useCache = true) {
        try {
            // 检查缓存
            if (useCache && this.configCache.has(pluginName)) {
                return this.configCache.get(pluginName);
            }
            // 从存储加载
            const config = await this.storage.load(pluginName);
            if (config) {
                this.configCache.set(pluginName, config);
            }
            return config;
        }
        catch (error) {
            this.logger.error(`Failed to get config for plugin ${pluginName}`, error);
            throw error;
        }
    }
    /**
     * 设置插件配置
     */
    async setConfig(pluginName, config, modifiedBy) {
        try {
            // 获取当前配置
            const currentConfig = await this.getConfig(pluginName) || {
                pluginName,
                config: {},
                version: '1.0.0',
                lastModified: new Date()
            };
            // 验证配置
            await this.validateConfig(pluginName, config);
            // 创建配置变更事件
            const changeEvent = {
                pluginName,
                oldValue: currentConfig.config,
                newValue: config,
                timestamp: new Date(),
                modifiedBy
            };
            // 更新配置
            const updatedConfig = {
                ...currentConfig,
                config,
                lastModified: new Date(),
                modifiedBy
            };
            // 保存配置
            await this.storage.save(updatedConfig);
            // 更新缓存
            this.configCache.set(pluginName, updatedConfig);
            // 发出变更事件
            this.emit('config:changed', changeEvent);
            this.emit(`config:changed:${pluginName}`, changeEvent);
            this.logger.info(`Config updated for plugin: ${pluginName}`);
        }
        catch (error) {
            this.logger.error(`Failed to set config for plugin ${pluginName}`, error);
            throw error;
        }
    }
    /**
     * 更新配置项
     */
    async updateConfigValue(pluginName, key, value, modifiedBy) {
        try {
            const config = await this.getConfig(pluginName);
            if (!config) {
                throw new Error(`Config not found for plugin: ${pluginName}`);
            }
            const oldValue = config.config[key];
            const newConfig = { ...config.config, [key]: value };
            // 验证单个配置项
            await this.validateConfigValue(pluginName, key, value);
            // 创建变更事件
            const changeEvent = {
                pluginName,
                key,
                oldValue,
                newValue: value,
                timestamp: new Date(),
                modifiedBy
            };
            // 更新配置
            const updatedConfig = {
                ...config,
                config: newConfig,
                lastModified: new Date(),
                modifiedBy
            };
            // 保存配置
            await this.storage.save(updatedConfig);
            // 更新缓存
            this.configCache.set(pluginName, updatedConfig);
            // 发出变更事件
            this.emit('config:changed', changeEvent);
            this.emit(`config:changed:${pluginName}`, changeEvent);
            this.emit(`config:changed:${pluginName}:${key}`, changeEvent);
            this.logger.info(`Config value updated for plugin ${pluginName}: ${key}`);
        }
        catch (error) {
            this.logger.error(`Failed to update config value for plugin ${pluginName}`, error);
            throw error;
        }
    }
    /**
     * 删除插件配置
     */
    async deleteConfig(pluginName) {
        try {
            await this.storage.delete(pluginName);
            this.configCache.delete(pluginName);
            this.emit('config:deleted', { pluginName, timestamp: new Date() });
            this.logger.info(`Config deleted for plugin: ${pluginName}`);
        }
        catch (error) {
            this.logger.error(`Failed to delete config for plugin ${pluginName}`, error);
            throw error;
        }
    }
    /**
     * 获取所有插件配置
     */
    async listConfigs() {
        return this.storage.list();
    }
    /**
     * 备份插件配置
     */
    async backupConfig(pluginName) {
        try {
            const backupId = await this.storage.backup(pluginName);
            this.emit('config:backed_up', { pluginName, backupId, timestamp: new Date() });
            this.logger.info(`Config backed up for plugin ${pluginName}: ${backupId}`);
            return backupId;
        }
        catch (error) {
            this.logger.error(`Failed to backup config for plugin ${pluginName}`, error);
            throw error;
        }
    }
    /**
     * 恢复插件配置
     */
    async restoreConfig(pluginName, backupId) {
        try {
            await this.storage.restore(pluginName, backupId);
            // 清除缓存以强制重新加载
            this.configCache.delete(pluginName);
            this.emit('config:restored', { pluginName, backupId, timestamp: new Date() });
            this.logger.info(`Config restored for plugin ${pluginName} from ${backupId}`);
        }
        catch (error) {
            this.logger.error(`Failed to restore config for plugin ${pluginName}`, error);
            throw error;
        }
    }
    /**
     * 验证插件配置
     */
    async validateConfig(pluginName, config) {
        const schema = this.schemaCache.get(pluginName);
        if (!schema) {
            // 没有模式定义，跳过验证
            return;
        }
        if (this.validationService) {
            // 使用验证服务
            const zodSchema = this.convertToZodSchema(schema);
            const result = this.validationService.validateSync(config, zodSchema);
            if (!result.success) {
                throw new Error(`Config validation failed: ${result.errors?.map(e => e.message).join(', ')}`);
            }
        }
        else {
            // 简单的模式验证
            this.validateConfigWithSchema(config, schema);
        }
    }
    /**
     * 验证单个配置值
     */
    async validateConfigValue(pluginName, key, value) {
        const schema = this.schemaCache.get(pluginName);
        if (!schema || !schema.properties || !schema.properties[key]) {
            return;
        }
        const fieldSchema = schema.properties[key];
        this.validateValueWithSchema(value, fieldSchema, key);
    }
    /**
     * 使用模式验证配置
     */
    validateConfigWithSchema(config, schema) {
        if (schema.type !== 'object' || !schema.properties) {
            return;
        }
        // 检查必需字段
        if (schema.required) {
            for (const required of schema.required) {
                if (!(required in config)) {
                    throw new Error(`Required field missing: ${required}`);
                }
            }
        }
        // 验证每个字段
        for (const [key, value] of Object.entries(config)) {
            const fieldSchema = schema.properties[key];
            if (fieldSchema) {
                this.validateValueWithSchema(value, fieldSchema, key);
            }
        }
    }
    /**
     * 验证单个值
     */
    validateValueWithSchema(value, schema, fieldName) {
        // 类型检查
        if (schema.type) {
            const actualType = Array.isArray(value) ? 'array' : typeof value;
            if (actualType !== schema.type) {
                throw new Error(`Field ${fieldName}: expected ${schema.type}, got ${actualType}`);
            }
        }
        // 枚举检查
        if (schema.enum && !schema.enum.includes(value)) {
            throw new Error(`Field ${fieldName}: value must be one of ${schema.enum.join(', ')}`);
        }
        // 数字范围检查
        if (schema.type === 'number') {
            if (schema.minimum !== undefined && value < schema.minimum) {
                throw new Error(`Field ${fieldName}: value must be >= ${schema.minimum}`);
            }
            if (schema.maximum !== undefined && value > schema.maximum) {
                throw new Error(`Field ${fieldName}: value must be <= ${schema.maximum}`);
            }
        }
        // 字符串长度检查
        if (schema.type === 'string') {
            if (schema.minLength !== undefined && value.length < schema.minLength) {
                throw new Error(`Field ${fieldName}: length must be >= ${schema.minLength}`);
            }
            if (schema.maxLength !== undefined && value.length > schema.maxLength) {
                throw new Error(`Field ${fieldName}: length must be <= ${schema.maxLength}`);
            }
            if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
                throw new Error(`Field ${fieldName}: value does not match pattern`);
            }
        }
    }
    /**
     * 转换为 Zod 模式
     */
    convertToZodSchema(schema) {
        // 这里应该实现 ConfigSchema 到 Zod schema 的转换
        // 简化实现，返回一个基本的对象模式
        return zod_1.z.object({});
    }
    /**
     * 清除缓存
     */
    clearCache(pluginName) {
        if (pluginName) {
            this.configCache.delete(pluginName);
        }
        else {
            this.configCache.clear();
        }
    }
    /**
     * 获取配置管理器统计
     */
    getStats() {
        return {
            totalConfigs: this.configCache.size, // 这只是缓存大小，实际应该查询存储
            cachedConfigs: this.configCache.size,
            registeredSchemas: this.schemaCache.size
        };
    }
    /**
     * 创建数据库存储实例
     */
    static createDatabaseStorage(db) {
        return new DatabaseConfigStorage(db);
    }
    /**
     * 创建文件系统存储实例
     */
    static createFileSystemStorage(basePath) {
        return new FileSystemConfigStorage(basePath);
    }
}
exports.PluginConfigManager = PluginConfigManager;
//# sourceMappingURL=plugin-config-manager.js.map