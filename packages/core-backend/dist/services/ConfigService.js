"use strict";
/**
 * Configuration Management Service
 * Provides a unified interface for application configuration with multiple sources
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
exports.config = exports.ConfigService = exports.SecretManager = exports.DefaultConfigSource = exports.DatabaseConfigSource = exports.FileConfigSource = exports.EnvConfigSource = void 0;
const logger_1 = require("../core/logger");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const yaml = __importStar(require("js-yaml"));
const db_1 = require("../db/db");
const logger = new logger_1.Logger('ConfigService');
/**
 * Environment variables configuration source
 */
class EnvConfigSource {
    name = 'environment';
    priority = 100; // Highest priority
    async get(key) {
        const envKey = this.toEnvKey(key);
        const value = process.env[envKey];
        if (value === undefined)
            return undefined;
        // Try to parse JSON values
        try {
            return JSON.parse(value);
        }
        catch {
            return value;
        }
    }
    toEnvKey(key) {
        // Convert dot notation to underscore: app.port -> APP_PORT
        return key.toUpperCase().replace(/\./g, '_');
    }
    async getAll() {
        const config = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (key.startsWith('METASHEET_')) {
                const configKey = this.fromEnvKey(key);
                try {
                    config[configKey] = JSON.parse(value);
                }
                catch {
                    config[configKey] = value;
                }
            }
        }
        return config;
    }
    fromEnvKey(envKey) {
        return envKey
            .replace(/^METASHEET_/, '')
            .toLowerCase()
            .replace(/_/g, '.');
    }
}
exports.EnvConfigSource = EnvConfigSource;
/**
 * File-based configuration source (YAML/JSON)
 */
class FileConfigSource {
    filePath;
    name = 'file';
    priority = 50;
    config = {};
    loaded = false;
    constructor(filePath) {
        this.filePath = filePath;
    }
    async get(key) {
        await this.loadConfig();
        return this.getNestedValue(this.config, key);
    }
    async getAll() {
        await this.loadConfig();
        return { ...this.config };
    }
    async loadConfig() {
        if (this.loaded)
            return;
        try {
            if (!fs.existsSync(this.filePath)) {
                logger.warn(`Config file not found: ${this.filePath}`);
                this.loaded = true;
                return;
            }
            const content = fs.readFileSync(this.filePath, 'utf8');
            const ext = path.extname(this.filePath);
            if (ext === '.yaml' || ext === '.yml') {
                this.config = yaml.load(content);
            }
            else if (ext === '.json') {
                this.config = JSON.parse(content);
            }
            else {
                throw new Error(`Unsupported config file format: ${ext}`);
            }
            this.loaded = true;
            logger.info(`Loaded config from ${this.filePath}`);
        }
        catch (error) {
            logger.error(`Failed to load config file: ${error}`);
            this.loaded = true;
        }
    }
    getNestedValue(obj, key) {
        return key.split('.').reduce((curr, part) => curr?.[part], obj);
    }
}
exports.FileConfigSource = FileConfigSource;
/**
 * Database configuration source
 */
class DatabaseConfigSource {
    name = 'database';
    priority = 30;
    cache = new Map();
    cacheTTL = 60000; // 1 minute
    async get(key) {
        // Check cache
        const cached = this.cache.get(key);
        if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
            return cached.value;
        }
        if (!db_1.db)
            return undefined;
        try {
            const result = await db_1.db
                .selectFrom('system_configs')
                .select(['value', 'is_encrypted'])
                .where('key', '=', key)
                .executeTakeFirst();
            if (!result)
                return undefined;
            let value = result.value;
            // Decrypt if needed
            if (result.is_encrypted) {
                const secretManager = new SecretManager();
                value = await secretManager.decryptValue(value);
            }
            // Cache the value
            this.cache.set(key, { value, timestamp: Date.now() });
            return value;
        }
        catch (error) {
            logger.error(`Failed to get config from database: ${error}`);
            return undefined;
        }
    }
    async set(key, value) {
        if (!db_1.db)
            throw new Error('Database not available');
        const jsonValue = JSON.stringify(value);
        await db_1.db
            .insertInto('system_configs')
            .values({
            key,
            value: jsonValue,
            updated_at: new Date()
        })
            .onConflict((oc) => oc.column('key').doUpdateSet({
            value: jsonValue,
            updated_at: new Date()
        }))
            .execute();
        // Invalidate cache
        this.cache.delete(key);
    }
    async getAll() {
        if (!db_1.db)
            return {};
        try {
            const rows = await db_1.db
                .selectFrom('system_configs')
                .select(['key', 'value', 'is_encrypted'])
                .execute();
            const config = {};
            const secretManager = new SecretManager();
            for (const row of rows) {
                let value = row.value;
                if (row.is_encrypted) {
                    value = await secretManager.decryptValue(value);
                }
                config[row.key] = value;
            }
            return config;
        }
        catch (error) {
            logger.error(`Failed to get all configs from database: ${error}`);
            return {};
        }
    }
}
exports.DatabaseConfigSource = DatabaseConfigSource;
/**
 * Default configuration source
 */
class DefaultConfigSource {
    name = 'default';
    priority = 0; // Lowest priority
    defaults = {
        'app.port': 8900,
        'app.host': '0.0.0.0',
        'app.env': 'development',
        'database.pool.min': 2,
        'database.pool.max': 10,
        'cache.ttl': 3600,
        'session.secret': 'change-me-in-production',
        'session.ttl': 86400,
        'cors.enabled': true,
        'cors.origins': ['http://localhost:8899'],
        'logging.level': 'info',
        'logging.format': 'json',
        'metrics.enabled': true,
        'metrics.port': 9090,
        'security.rateLimit.enabled': true,
        'security.rateLimit.windowMs': 900000, // 15 minutes
        'security.rateLimit.max': 100,
        'uploads.maxSize': 10485760, // 10MB
        'uploads.allowedTypes': ['image/jpeg', 'image/png', 'image/gif', 'application/pdf'],
        'email.enabled': false,
        'email.from': 'noreply@metasheet.com',
        'workflow.maxRetries': 3,
        'workflow.retryDelay': 60000,
        'form.uploadLimit': 10485760,
        'form.responseRetention': 365,
        'gallery.imageCacheTTL': 3600
    };
    async get(key) {
        return this.getNestedValue(this.defaults, key);
    }
    async getAll() {
        return { ...this.defaults };
    }
    getNestedValue(obj, key) {
        return key.split('.').reduce((curr, part) => curr?.[part], obj);
    }
}
exports.DefaultConfigSource = DefaultConfigSource;
/**
 * Secret Manager for handling encrypted values
 */
class SecretManager {
    crypto = require('crypto');
    algorithm = 'aes-256-gcm';
    keyDerivationSalt;
    constructor() {
        // Use environment variable or generate a salt
        const salt = process.env.ENCRYPTION_SALT || 'default-salt-change-in-production';
        this.keyDerivationSalt = Buffer.from(salt);
    }
    getKey() {
        const masterKey = process.env.ENCRYPTION_KEY || 'default-key-change-in-production';
        return this.crypto.pbkdf2Sync(masterKey, this.keyDerivationSalt, 100000, 32, 'sha256');
    }
    async encrypt(plaintext) {
        try {
            const key = this.getKey();
            const iv = this.crypto.randomBytes(16);
            const cipher = this.crypto.createCipheriv(this.algorithm, key, iv);
            let encrypted = cipher.update(plaintext, 'utf8', 'hex');
            encrypted += cipher.final('hex');
            const authTag = cipher.getAuthTag();
            // Combine iv, authTag, and encrypted data
            const combined = Buffer.concat([
                iv,
                authTag,
                Buffer.from(encrypted, 'hex')
            ]);
            return combined.toString('base64');
        }
        catch (error) {
            logger.error(`Encryption failed: ${error}`);
            throw new Error('Failed to encrypt value');
        }
    }
    async decrypt(ciphertext) {
        try {
            const key = this.getKey();
            const combined = Buffer.from(ciphertext, 'base64');
            // Extract components
            const iv = combined.slice(0, 16);
            const authTag = combined.slice(16, 32);
            const encrypted = combined.slice(32);
            const decipher = this.crypto.createDecipheriv(this.algorithm, key, iv);
            decipher.setAuthTag(authTag);
            let decrypted = decipher.update(encrypted, null, 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        }
        catch (error) {
            logger.error(`Decryption failed: ${error}`);
            throw new Error('Failed to decrypt value');
        }
    }
    async decryptValue(value) {
        if (typeof value === 'string' && value.startsWith('enc:')) {
            return await this.decrypt(value.substring(4));
        }
        return value;
    }
    async rotateKey(oldKey, newKey) {
        // Implementation for key rotation
        logger.info('Key rotation initiated');
        if (!db_1.db)
            throw new Error('Database not available');
        // Get all encrypted configs
        const configs = await db_1.db
            .selectFrom('system_configs')
            .select(['id', 'key', 'value'])
            .where('is_encrypted', '=', true)
            .execute();
        // Re-encrypt with new key
        const originalKey = process.env.ENCRYPTION_KEY;
        for (const config of configs) {
            try {
                // Decrypt with old key
                process.env.ENCRYPTION_KEY = oldKey;
                const decrypted = await this.decrypt(config.value.toString());
                // Encrypt with new key
                process.env.ENCRYPTION_KEY = newKey;
                const encrypted = await this.encrypt(decrypted);
                // Update database
                await db_1.db
                    .updateTable('system_configs')
                    .set({ value: encrypted, updated_at: new Date() })
                    .where('id', '=', config.id)
                    .execute();
            }
            catch (error) {
                logger.error(`Failed to rotate key for config ${config.key}: ${error}`);
                process.env.ENCRYPTION_KEY = originalKey;
                throw error;
            }
        }
        process.env.ENCRYPTION_KEY = newKey;
        logger.info('Key rotation completed');
    }
}
exports.SecretManager = SecretManager;
/**
 * Main Configuration Service
 */
class ConfigService {
    sources = [];
    static instance;
    constructor() {
        // Initialize configuration sources in priority order
        this.sources = [
            new EnvConfigSource(),
            new FileConfigSource(process.env.CONFIG_FILE || './config.yaml'),
            new DatabaseConfigSource(),
            new DefaultConfigSource()
        ].sort((a, b) => b.priority - a.priority);
    }
    static getInstance() {
        if (!ConfigService.instance) {
            ConfigService.instance = new ConfigService();
        }
        return ConfigService.instance;
    }
    async get(key, defaultValue) {
        for (const source of this.sources) {
            const value = await source.get(key);
            if (value !== undefined) {
                logger.debug(`Config '${key}' loaded from ${source.name}`);
                return value;
            }
        }
        if (defaultValue !== undefined) {
            return defaultValue;
        }
        logger.warn(`Config key '${key}' not found in any source`);
        return undefined;
    }
    async set(key, value, sourceName = 'database') {
        const source = this.sources.find(s => s.name === sourceName);
        if (!source || !source.set) {
            throw new Error(`Cannot set config in source: ${sourceName}`);
        }
        await source.set(key, value);
        logger.info(`Config '${key}' saved to ${sourceName}`);
    }
    async getAll() {
        const allConfigs = {};
        // Merge configs from all sources (reverse order for priority)
        for (const source of [...this.sources].reverse()) {
            if (source.getAll) {
                const sourceConfigs = await source.getAll();
                Object.assign(allConfigs, sourceConfigs);
            }
        }
        return allConfigs;
    }
    async reload() {
        // Clear caches and reload configurations
        for (const source of this.sources) {
            if (source.name === 'database') {
                source['cache'].clear();
            }
            else if (source.name === 'file') {
                source['loaded'] = false;
            }
        }
        logger.info('Configuration reloaded');
    }
    async validate() {
        const errors = [];
        // Validate required configurations
        const required = [
            'app.port',
            'app.host',
            'database.url',
            'session.secret'
        ];
        for (const key of required) {
            const value = await this.get(key);
            if (value === undefined) {
                errors.push(`Missing required config: ${key}`);
            }
        }
        // Validate configuration values
        const port = await this.get('app.port');
        if (port && (port < 1 || port > 65535)) {
            errors.push(`Invalid port number: ${port}`);
        }
        return {
            valid: errors.length === 0,
            errors
        };
    }
}
exports.ConfigService = ConfigService;
// Export singleton instance
exports.config = ConfigService.getInstance();
//# sourceMappingURL=ConfigService.js.map