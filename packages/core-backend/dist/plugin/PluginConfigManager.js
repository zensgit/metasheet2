"use strict";
/**
 * 插件配置管理器
 * 提供插件特定的配置管理、环境变量注入、配置验证和动态更新
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
exports.PluginConfigManager = exports.ConfigType = void 0;
const crypto = __importStar(require("crypto"));
const eventemitter3_1 = require("eventemitter3");
const logger_1 = require("../core/logger");
/**
 * 配置项类型
 */
var ConfigType;
(function (ConfigType) {
    ConfigType["STRING"] = "string";
    ConfigType["NUMBER"] = "number";
    ConfigType["BOOLEAN"] = "boolean";
    ConfigType["ARRAY"] = "array";
    ConfigType["OBJECT"] = "object";
    ConfigType["SECRET"] = "secret";
    ConfigType["FILE_PATH"] = "file_path";
    ConfigType["URL"] = "url";
    ConfigType["EMAIL"] = "email";
})(ConfigType || (exports.ConfigType = ConfigType = {}));
/**
 * 插件配置管理器
 */
class PluginConfigManager extends eventemitter3_1.EventEmitter {
    schemas = new Map();
    configs = new Map(); // pluginName -> key -> ConfigValue
    encryptionKey;
    database;
    validationService;
    logger;
    constructor(encryptionKey, database, validationService) {
        super();
        this.encryptionKey = encryptionKey || this.generateEncryptionKey();
        this.database = database;
        this.validationService = validationService;
        this.logger = new logger_1.Logger('PluginConfigManager');
    }
    /**
     * 注册插件配置 Schema
     */
    async registerSchema(pluginName, schema) {
        try {
            // 验证 Schema
            this.validateSchema(schema);
            // 注册 Schema
            this.schemas.set(pluginName, schema);
            // 初始化配置映射
            if (!this.configs.has(pluginName)) {
                this.configs.set(pluginName, new Map());
            }
            // 持久化 Schema
            if (this.database) {
                await this.persistSchema(pluginName, schema);
            }
            // 应用默认值
            await this.applyDefaultValues(pluginName, schema);
            this.emit('schema:registered', { pluginName, schema });
            this.logger.info(`Registered config schema for plugin: ${pluginName}`);
        }
        catch (error) {
            this.logger.error(`Failed to register config schema for plugin ${pluginName}`, error);
            throw error;
        }
    }
    /**
     * 获取插件配置 Schema
     */
    getSchema(pluginName) {
        return this.schemas.get(pluginName);
    }
    /**
     * 设置配置值
     */
    async setConfig(pluginName, key, value, options = {}) {
        const schema = this.schemas.get(pluginName);
        if (!schema) {
            throw new Error(`No config schema found for plugin: ${pluginName}`);
        }
        const configItem = schema.items.find(item => item.key === key);
        if (!configItem) {
            throw new Error(`Config key '${key}' not found in schema for plugin: ${pluginName}`);
        }
        try {
            // 验证配置值
            const validatedValue = await this.validateConfigValue(configItem, value);
            // 检查依赖
            if (configItem.dependsOn) {
                await this.checkDependencies(pluginName, configItem.dependsOn, options);
            }
            const scope = options.scope || configItem.scope || 'global';
            const encrypted = configItem.sensitive || configItem.type === ConfigType.SECRET;
            // 获取旧值
            const oldValue = await this.getConfig(pluginName, key, options);
            // 加密敏感信息
            const finalValue = encrypted ? this.encrypt(validatedValue) : validatedValue;
            const configValue = {
                key,
                value: finalValue,
                encrypted,
                scope,
                userId: options.userId,
                tenantId: options.tenantId,
                updatedAt: new Date(),
                updatedBy: options.updatedBy
            };
            // 存储到内存
            const pluginConfigs = this.configs.get(pluginName);
            const configKey = this.buildConfigKey(key, scope, options.userId, options.tenantId);
            pluginConfigs.set(configKey, configValue);
            // 持久化到数据库
            if (this.database) {
                await this.persistConfigValue(pluginName, configValue);
            }
            // 发送变更事件
            this.emit('config:changed', {
                pluginName,
                key,
                oldValue,
                newValue: validatedValue,
                scope,
                userId: options.userId,
                updatedBy: options.updatedBy
            });
            this.logger.debug(`Set config ${pluginName}.${key} = ${encrypted ? '[ENCRYPTED]' : validatedValue}`);
        }
        catch (error) {
            this.logger.error(`Failed to set config ${pluginName}.${key}`, error);
            throw error;
        }
    }
    /**
     * 获取配置值
     */
    async getConfig(pluginName, key, options = {}) {
        const schema = this.schemas.get(pluginName);
        if (!schema) {
            throw new Error(`No config schema found for plugin: ${pluginName}`);
        }
        const configItem = schema.items.find(item => item.key === key);
        if (!configItem) {
            throw new Error(`Config key '${key}' not found in schema for plugin: ${pluginName}`);
        }
        const scope = options.scope || configItem.scope || 'global';
        const pluginConfigs = this.configs.get(pluginName);
        if (pluginConfigs) {
            // 尝试获取精确匹配的配置
            const exactKey = this.buildConfigKey(key, scope, options.userId, options.tenantId);
            let configValue = pluginConfigs.get(exactKey);
            // 如果没有找到，尝试查找更低级别的配置（作用域继承）
            if (!configValue) {
                configValue = this.findInheritedConfig(pluginConfigs, key, scope, options.userId, options.tenantId);
            }
            if (configValue) {
                return configValue.encrypted ? this.decrypt(configValue.value) : configValue.value;
            }
        }
        // 返回默认值
        if (options.includeDefaults !== false && configItem.defaultValue !== undefined) {
            return configItem.defaultValue;
        }
        return undefined;
    }
    /**
     * 获取所有配置
     */
    async getAllConfigs(pluginName, options = {}) {
        const schema = this.schemas.get(pluginName);
        if (!schema) {
            throw new Error(`No config schema found for plugin: ${pluginName}`);
        }
        const result = {};
        for (const item of schema.items) {
            // 跳过敏感信息（除非明确要求）
            if (item.sensitive && !options.includeSensitive) {
                continue;
            }
            try {
                const value = await this.getConfig(pluginName, item.key, options);
                if (value !== undefined) {
                    result[item.key] = value;
                }
            }
            catch (error) {
                this.logger.warn(`Failed to get config ${pluginName}.${item.key}`, error);
            }
        }
        return result;
    }
    /**
     * 删除配置值
     */
    async deleteConfig(pluginName, key, options = {}) {
        const schema = this.schemas.get(pluginName);
        if (!schema) {
            throw new Error(`No config schema found for plugin: ${pluginName}`);
        }
        const configItem = schema.items.find(item => item.key === key);
        if (!configItem) {
            throw new Error(`Config key '${key}' not found in schema for plugin: ${pluginName}`);
        }
        const scope = options.scope || configItem.scope || 'global';
        const configKey = this.buildConfigKey(key, scope, options.userId, options.tenantId);
        // 获取旧值
        const oldValue = await this.getConfig(pluginName, key, options);
        // 从内存中删除
        const pluginConfigs = this.configs.get(pluginName);
        if (pluginConfigs) {
            pluginConfigs.delete(configKey);
        }
        // 从数据库中删除
        if (this.database) {
            await this.removeConfigFromDatabase(pluginName, key, scope, options.userId, options.tenantId);
        }
        // 发送变更事件
        this.emit('config:changed', {
            pluginName,
            key,
            oldValue,
            newValue: undefined,
            scope,
            userId: options.userId
        });
        this.logger.debug(`Deleted config ${pluginName}.${key}`);
    }
    /**
     * 验证插件所有配置
     */
    async validateAllConfigs(pluginName, options = {}) {
        const schema = this.schemas.get(pluginName);
        if (!schema) {
            return { valid: false, errors: [{ key: '', error: `No config schema found for plugin: ${pluginName}` }] };
        }
        const errors = [];
        for (const item of schema.items) {
            try {
                const value = await this.getConfig(pluginName, item.key, options);
                // 检查必需配置
                if (item.required && (value === undefined || value === null)) {
                    errors.push({ key: item.key, error: 'Required configuration is missing' });
                    continue;
                }
                // 验证配置值
                if (value !== undefined) {
                    await this.validateConfigValue(item, value);
                }
            }
            catch (error) {
                errors.push({ key: item.key, error: error.message });
            }
        }
        return { valid: errors.length === 0, errors };
    }
    /**
     * 重置插件配置为默认值
     */
    async resetToDefaults(pluginName, options = {}) {
        const schema = this.schemas.get(pluginName);
        if (!schema) {
            throw new Error(`No config schema found for plugin: ${pluginName}`);
        }
        for (const item of schema.items) {
            if (item.defaultValue !== undefined) {
                await this.setConfig(pluginName, item.key, item.defaultValue, options);
            }
            else {
                // 删除没有默认值的配置
                try {
                    await this.deleteConfig(pluginName, item.key, options);
                }
                catch {
                    // 忽略删除不存在配置的错误
                }
            }
        }
        this.logger.info(`Reset configs to defaults for plugin: ${pluginName}`);
    }
    /**
     * 导出配置
     */
    async exportConfigs(pluginName, options = {}) {
        const schema = this.schemas.get(pluginName);
        if (!schema) {
            throw new Error(`No config schema found for plugin: ${pluginName}`);
        }
        const configs = await this.getAllConfigs(pluginName, options);
        return { schema, configs };
    }
    /**
     * 导入配置
     */
    async importConfigs(pluginName, data, options = {}) {
        // 如果提供了schema，先注册
        if (data.schema) {
            await this.registerSchema(pluginName, data.schema);
        }
        const schema = this.schemas.get(pluginName);
        if (!schema) {
            throw new Error(`No config schema found for plugin: ${pluginName}`);
        }
        for (const [key, value] of Object.entries(data.configs)) {
            const configItem = schema.items.find(item => item.key === key);
            if (!configItem) {
                this.logger.warn(`Skipping unknown config key: ${key}`);
                continue;
            }
            // 检查是否需要覆写
            if (!options.overwrite) {
                const existingValue = await this.getConfig(pluginName, key, { ...options, includeDefaults: false });
                if (existingValue !== undefined) {
                    continue; // 跳过已存在的配置
                }
            }
            await this.setConfig(pluginName, key, value, options);
        }
        this.logger.info(`Imported configs for plugin: ${pluginName}`);
    }
    /**
     * 获取环境变量映射
     */
    getEnvironmentVariables(pluginName) {
        const schema = this.schemas.get(pluginName);
        if (!schema)
            return {};
        const env = {};
        for (const item of schema.items) {
            try {
                const value = this.getConfig(pluginName, item.key, { includeDefaults: true });
                if (value !== undefined && !item.sensitive) {
                    const envKey = `PLUGIN_${pluginName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${item.key.toUpperCase()}`;
                    env[envKey] = value;
                }
            }
            catch {
                // 忽略获取失败的配置
            }
        }
        return env;
    }
    /**
     * 从数据库加载配置
     */
    async loadFromDatabase() {
        if (!this.database)
            return;
        try {
            // 加载schemas
            const schemas = await this.database.query('SELECT * FROM plugin_config_schemas');
            for (const row of schemas) {
                const schema = JSON.parse(row.schema);
                this.schemas.set(row.plugin_name, schema);
                if (!this.configs.has(row.plugin_name)) {
                    this.configs.set(row.plugin_name, new Map());
                }
            }
            // 加载配置值
            const configs = await this.database.query('SELECT * FROM plugin_configs');
            for (const row of configs) {
                const configValue = {
                    key: row.config_key,
                    value: row.value,
                    encrypted: row.encrypted,
                    scope: row.scope,
                    userId: row.user_id,
                    tenantId: row.tenant_id,
                    updatedAt: new Date(row.updated_at),
                    updatedBy: row.updated_by
                };
                const pluginConfigs = this.configs.get(row.plugin_name);
                const configKey = this.buildConfigKey(row.config_key, row.scope, row.user_id, row.tenant_id);
                pluginConfigs.set(configKey, configValue);
            }
            this.logger.info(`Loaded ${schemas.length} config schemas and ${configs.length} config values from database`);
        }
        catch (error) {
            this.logger.error('Failed to load configs from database', error);
        }
    }
    /**
     * 验证配置Schema
     */
    validateSchema(schema) {
        if (!schema.version) {
            throw new Error('Config schema version is required');
        }
        if (!Array.isArray(schema.items) || schema.items.length === 0) {
            throw new Error('Config schema must have at least one item');
        }
        const keys = new Set();
        for (const item of schema.items) {
            if (!item.key) {
                throw new Error('Config item key is required');
            }
            if (keys.has(item.key)) {
                throw new Error(`Duplicate config key: ${item.key}`);
            }
            keys.add(item.key);
            if (!Object.values(ConfigType).includes(item.type)) {
                throw new Error(`Invalid config type: ${item.type}`);
            }
        }
    }
    /**
     * 验证配置值
     */
    async validateConfigValue(item, value) {
        // 类型验证
        switch (item.type) {
            case ConfigType.STRING:
                if (typeof value !== 'string') {
                    throw new Error(`Config ${item.key} must be a string`);
                }
                if (item.min !== undefined && value.length < item.min) {
                    throw new Error(`Config ${item.key} must be at least ${item.min} characters`);
                }
                if (item.max !== undefined && value.length > item.max) {
                    throw new Error(`Config ${item.key} must be at most ${item.max} characters`);
                }
                if (item.pattern) {
                    const regex = new RegExp(item.pattern);
                    if (!regex.test(value)) {
                        throw new Error(`Config ${item.key} does not match required pattern`);
                    }
                }
                break;
            case ConfigType.NUMBER:
                const num = Number(value);
                if (isNaN(num)) {
                    throw new Error(`Config ${item.key} must be a number`);
                }
                if (item.min !== undefined && num < item.min) {
                    throw new Error(`Config ${item.key} must be at least ${item.min}`);
                }
                if (item.max !== undefined && num > item.max) {
                    throw new Error(`Config ${item.key} must be at most ${item.max}`);
                }
                return num;
            case ConfigType.BOOLEAN:
                if (typeof value !== 'boolean') {
                    // 尝试转换字符串
                    if (typeof value === 'string') {
                        const lower = value.toLowerCase();
                        if (lower === 'true' || lower === '1')
                            return true;
                        if (lower === 'false' || lower === '0')
                            return false;
                    }
                    throw new Error(`Config ${item.key} must be a boolean`);
                }
                break;
            case ConfigType.ARRAY:
                if (!Array.isArray(value)) {
                    throw new Error(`Config ${item.key} must be an array`);
                }
                break;
            case ConfigType.OBJECT:
                if (typeof value !== 'object' || value === null || Array.isArray(value)) {
                    throw new Error(`Config ${item.key} must be an object`);
                }
                break;
            case ConfigType.EMAIL:
                if (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
                    throw new Error(`Config ${item.key} must be a valid email address`);
                }
                break;
            case ConfigType.URL:
                if (typeof value !== 'string') {
                    throw new Error(`Config ${item.key} must be a string`);
                }
                try {
                    new URL(value);
                }
                catch {
                    throw new Error(`Config ${item.key} must be a valid URL`);
                }
                break;
        }
        // 选项验证
        if (item.options && !item.options.includes(value)) {
            throw new Error(`Config ${item.key} must be one of: ${item.options.join(', ')}`);
        }
        // 自定义验证器
        if (item.validator && this.validationService) {
            const validator = this.validationService.getValidator(item.validator);
            if (validator) {
                const result = validator(value);
                if (result !== true) {
                    throw new Error(`Config ${item.key} validation failed: ${result}`);
                }
            }
        }
        return value;
    }
    /**
     * 应用默认值
     */
    async applyDefaultValues(pluginName, schema) {
        for (const item of schema.items) {
            if (item.defaultValue !== undefined) {
                try {
                    // 检查是否已有配置
                    const existing = await this.getConfig(pluginName, item.key, { includeDefaults: false });
                    if (existing === undefined) {
                        await this.setConfig(pluginName, item.key, item.defaultValue, {
                            scope: item.scope || 'global'
                        });
                    }
                }
                catch {
                    // 忽略设置默认值失败的情况
                }
            }
        }
    }
    /**
     * 检查依赖配置
     */
    async checkDependencies(pluginName, dependencies, options) {
        for (const depKey of dependencies) {
            const depValue = await this.getConfig(pluginName, depKey, options);
            if (depValue === undefined || depValue === null) {
                throw new Error(`Dependent configuration '${depKey}' is not set`);
            }
        }
    }
    /**
     * 构建配置键
     */
    buildConfigKey(key, scope, userId, tenantId) {
        const parts = [key, scope];
        if (userId)
            parts.push(`user:${userId}`);
        if (tenantId)
            parts.push(`tenant:${tenantId}`);
        return parts.join('#');
    }
    /**
     * 查找继承的配置
     */
    findInheritedConfig(pluginConfigs, key, scope, userId, tenantId) {
        // 配置继承优先级：user > tenant > global
        const searchKeys = [];
        if (scope === 'user' && userId) {
            // 尝试用户级别配置
            searchKeys.push(this.buildConfigKey(key, 'user', userId, tenantId));
            if (tenantId) {
                searchKeys.push(this.buildConfigKey(key, 'tenant', undefined, tenantId));
            }
            searchKeys.push(this.buildConfigKey(key, 'global'));
        }
        else if (scope === 'tenant' && tenantId) {
            // 尝试租户级别配置
            searchKeys.push(this.buildConfigKey(key, 'tenant', undefined, tenantId));
            searchKeys.push(this.buildConfigKey(key, 'global'));
        }
        else {
            // 全局级别配置
            searchKeys.push(this.buildConfigKey(key, 'global'));
        }
        for (const searchKey of searchKeys) {
            const config = pluginConfigs.get(searchKey);
            if (config)
                return config;
        }
        return undefined;
    }
    /**
     * 加密敏感信息
     */
    encrypt(value) {
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        const cipher = crypto.createCipher('aes-256-cbc', this.encryptionKey);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return encrypted;
    }
    /**
     * 解密敏感信息
     */
    decrypt(encryptedValue) {
        try {
            const decipher = crypto.createDecipher('aes-256-cbc', this.encryptionKey);
            let decrypted = decipher.update(encryptedValue, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            // 尝试解析JSON，如果失败则返回字符串
            try {
                return JSON.parse(decrypted);
            }
            catch {
                return decrypted;
            }
        }
        catch (error) {
            this.logger.error('Failed to decrypt config value', error);
            throw new Error('Failed to decrypt sensitive configuration');
        }
    }
    /**
     * 生成加密键
     */
    generateEncryptionKey() {
        return crypto.randomBytes(32).toString('hex');
    }
    /**
     * 持久化Schema
     */
    async persistSchema(pluginName, schema) {
        if (!this.database)
            return;
        const sql = `
      INSERT INTO plugin_config_schemas (plugin_name, schema, created_at, updated_at)
      VALUES ($1, $2, NOW(), NOW())
      ON CONFLICT (plugin_name)
      DO UPDATE SET schema = EXCLUDED.schema, updated_at = NOW()
    `;
        await this.database.query(sql, [pluginName, JSON.stringify(schema)]);
    }
    /**
     * 持久化配置值
     */
    async persistConfigValue(pluginName, configValue) {
        if (!this.database)
            return;
        const sql = `
      INSERT INTO plugin_configs
      (plugin_name, config_key, value, encrypted, scope, user_id, tenant_id, updated_at, updated_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (plugin_name, config_key, scope, COALESCE(user_id, ''), COALESCE(tenant_id, ''))
      DO UPDATE SET
        value = EXCLUDED.value,
        encrypted = EXCLUDED.encrypted,
        updated_at = EXCLUDED.updated_at,
        updated_by = EXCLUDED.updated_by
    `;
        await this.database.query(sql, [
            pluginName,
            configValue.key,
            configValue.value,
            configValue.encrypted,
            configValue.scope,
            configValue.userId || null,
            configValue.tenantId || null,
            configValue.updatedAt,
            configValue.updatedBy || null
        ]);
    }
    /**
     * 从数据库删除配置
     */
    async removeConfigFromDatabase(pluginName, key, scope, userId, tenantId) {
        if (!this.database)
            return;
        const sql = `
      DELETE FROM plugin_configs
      WHERE plugin_name = $1 AND config_key = $2 AND scope = $3
        AND COALESCE(user_id, '') = $4 AND COALESCE(tenant_id, '') = $5
    `;
        await this.database.query(sql, [
            pluginName,
            key,
            scope,
            userId || '',
            tenantId || ''
        ]);
    }
}
exports.PluginConfigManager = PluginConfigManager;
//# sourceMappingURL=PluginConfigManager.js.map