"use strict";
// @ts-nocheck
/**
 * 安全服务实现
 * 提供插件安全功能，包括权限验证、沙箱、加密、审计等
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RateLimiter = exports.PluginSandboxImpl = exports.SecurityServiceImpl = void 0;
const crypto_1 = require("crypto");
const eventemitter3_1 = require("eventemitter3");
const vm_1 = __importDefault(require("vm"));
const logger_1 = require("../core/logger");
const plugin_1 = require("../types/plugin");
/**
 * 插件沙箱实现
 */
class PluginSandboxImpl {
    pluginName;
    allowedAPIs;
    resourceLimits;
    environment;
    context;
    logger;
    constructor(pluginName, allowedAPIs, resourceLimits = {}, environment = {}) {
        this.pluginName = pluginName;
        this.allowedAPIs = allowedAPIs;
        this.resourceLimits = resourceLimits;
        this.environment = environment;
        this.logger = new logger_1.Logger(`Sandbox:${pluginName}`);
        // 创建受限的执行上下文
        this.context = this.createContext();
    }
    createContext() {
        const sandbox = {
            // 基础全局对象
            console: {
                log: (...args) => this.logger.info('Plugin log:', ...args),
                error: (...args) => this.logger.error('Plugin error:', ...args),
                warn: (...args) => this.logger.warn('Plugin warn:', ...args),
                info: (...args) => this.logger.info('Plugin info:', ...args),
                debug: (...args) => this.logger.debug('Plugin debug:', ...args)
            },
            // 安全的全局函数
            setTimeout: (callback, delay) => {
                if (delay < 0 || delay > 300000) { // 最大5分钟
                    throw new Error('Invalid timeout delay');
                }
                return setTimeout(callback, delay);
            },
            setInterval: (callback, delay) => {
                if (delay < 100 || delay > 60000) { // 最小100ms，最大1分钟
                    throw new Error('Invalid interval delay');
                }
                return setInterval(callback, delay);
            },
            clearTimeout,
            clearInterval,
            // JSON操作
            JSON: {
                parse: JSON.parse,
                stringify: JSON.stringify
            },
            // 数学函数
            Math,
            // 日期
            Date,
            // 正则表达式
            RegExp,
            // 基础类型
            String,
            Number,
            Boolean,
            Array,
            Object,
            // Promise
            Promise,
            // 插件环境变量
            ...this.environment
        };
        // 移除危险的全局对象
        const context = vm_1.default.createContext(sandbox);
        // 禁用对全局对象的访问
        vm_1.default.runInContext(`
      delete this.global;
      delete this.process;
      delete this.require;
      delete this.module;
      delete this.exports;
      delete this.Buffer;
    `, context);
        return context;
    }
    async execute(code, context) {
        try {
            // 检查代码威胁
            const threatScan = await this.scanCode(code);
            if (!threatScan.safe) {
                const criticalThreats = threatScan.threats.filter(t => t.severity === 'critical');
                if (criticalThreats.length > 0) {
                    throw new Error(`Critical security threats detected: ${criticalThreats.map(t => t.description).join(', ')}`);
                }
            }
            // 设置资源限制
            const options = {
                timeout: this.resourceLimits.cpu ? this.resourceLimits.cpu * 1000 : 30000, // 默认30秒
                displayErrors: true
            };
            // 如果有上下文，合并到沙箱环境
            if (context) {
                for (const [key, value] of Object.entries(context)) {
                    this.context[key] = value;
                }
            }
            // 执行代码
            const result = vm_1.default.runInContext(code, this.context, options);
            this.logger.debug(`Code executed successfully for plugin ${this.pluginName}`);
            return result;
        }
        catch (error) {
            this.logger.error(`Code execution failed for plugin ${this.pluginName}`, error);
            throw error;
        }
    }
    async scanCode(code) {
        const threats = [];
        // 检查危险模式
        const dangerousPatterns = [
            {
                pattern: /require\s*\(/g,
                type: 'module_access',
                severity: 'critical',
                description: 'Unauthorized require() usage'
            },
            {
                pattern: /process\./g,
                type: 'system_access',
                severity: 'critical',
                description: 'Unauthorized process access'
            },
            {
                pattern: /fs\./g,
                type: 'file_system',
                severity: 'high',
                description: 'Unauthorized file system access'
            },
            {
                pattern: /child_process/g,
                type: 'process_spawn',
                severity: 'critical',
                description: 'Unauthorized child process spawning'
            },
            {
                pattern: /eval\s*\(/g,
                type: 'code_execution',
                severity: 'high',
                description: 'Dynamic code evaluation detected'
            },
            {
                pattern: /Function\s*\(/g,
                type: 'code_generation',
                severity: 'medium',
                description: 'Dynamic function creation detected'
            },
            {
                pattern: /__proto__|prototype\s*=/g,
                type: 'prototype_pollution',
                severity: 'high',
                description: 'Potential prototype pollution'
            },
            {
                pattern: /fetch\s*\(|XMLHttpRequest/g,
                type: 'network_access',
                severity: 'medium',
                description: 'Network access detected'
            }
        ];
        for (const { pattern, type, severity, description } of dangerousPatterns) {
            let match;
            while ((match = pattern.exec(code)) !== null) {
                threats.push({
                    type,
                    severity,
                    description,
                    line: code.substring(0, match.index).split('\n').length,
                    column: match.index - code.lastIndexOf('\n', match.index) - 1
                });
            }
        }
        return {
            safe: threats.filter(t => t.severity === 'critical').length === 0,
            threats
        };
    }
}
exports.PluginSandboxImpl = PluginSandboxImpl;
/**
 * 速率限制器
 */
class RateLimiter {
    limits = new Map();
    check(key, maxRequests = 100, windowMs = 60000) {
        const now = Date.now();
        const existing = this.limits.get(key);
        if (existing && now < existing.resetTime) {
            if (existing.count >= maxRequests) {
                return {
                    allowed: false,
                    remaining: 0,
                    resetTime: new Date(existing.resetTime),
                    retryAfter: Math.ceil((existing.resetTime - now) / 1000)
                };
            }
            existing.count++;
            return {
                allowed: true,
                remaining: maxRequests - existing.count,
                resetTime: new Date(existing.resetTime)
            };
        }
        // 新窗口或过期
        this.limits.set(key, {
            count: 1,
            resetTime: now + windowMs,
            windowMs,
            maxRequests
        });
        return {
            allowed: true,
            remaining: maxRequests - 1,
            resetTime: new Date(now + windowMs)
        };
    }
    cleanup() {
        const now = Date.now();
        for (const [key, limit] of this.limits.entries()) {
            if (now >= limit.resetTime) {
                this.limits.delete(key);
            }
        }
    }
}
exports.RateLimiter = RateLimiter;
/**
 * 安全服务实现
 */
class SecurityServiceImpl extends eventemitter3_1.EventEmitter {
    sandboxes = new Map();
    auditLog = [];
    rateLimiter = new RateLimiter();
    resourceUsage = new Map();
    logger;
    encryptionKey;
    constructor(encryptionKey) {
        super();
        this.logger = new logger_1.Logger('SecurityService');
        // 生成或使用提供的加密密钥
        this.encryptionKey = encryptionKey ?
            (0, crypto_1.scryptSync)(encryptionKey, 'metasheet-salt', 32) :
            (0, crypto_1.randomBytes)(32);
        // 定期清理
        setInterval(() => {
            this.cleanup();
        }, 300000); // 每5分钟清理一次
    }
    async checkPermission(pluginName, permission) {
        try {
            // 检查权限是否在白名单中
            const allowed = plugin_1.PERMISSION_WHITELIST.includes(permission);
            await this.audit({
                id: `perm_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                pluginName,
                event: 'permission_check',
                resource: permission,
                action: 'check',
                timestamp: new Date(),
                metadata: { allowed },
                severity: allowed ? 'info' : 'warning'
            });
            return allowed;
        }
        catch (error) {
            this.logger.error(`Permission check failed for ${pluginName}`, error);
            return false;
        }
    }
    async checkPermissions(pluginName, permissions) {
        return Promise.all(permissions.map(permission => this.checkPermission(pluginName, permission)));
    }
    createSandbox(pluginName) {
        // 默认沙箱配置
        const defaultLimits = {
            memory: 100, // 100MB
            cpu: 30, // 30秒
            disk: 50, // 50MB
            network: 60, // 60 requests per minute
            database: 300 // 300 queries per minute
        };
        const defaultAPIs = ['console', 'setTimeout', 'clearTimeout', 'JSON', 'Math', 'Date'];
        const sandbox = new PluginSandboxImpl(pluginName, defaultAPIs, defaultLimits, { pluginName });
        this.sandboxes.set(pluginName, sandbox);
        this.logger.info(`Created sandbox for plugin: ${pluginName}`);
        return sandbox;
    }
    getSandbox(pluginName) {
        return this.sandboxes.get(pluginName) || null;
    }
    async validateAPIAccess(pluginName, apiPath, method) {
        try {
            const sandbox = this.getSandbox(pluginName);
            if (!sandbox) {
                return false;
            }
            // 检查API是否在允许列表中
            const allowed = sandbox.allowedAPIs.some(api => apiPath.startsWith(api));
            await this.audit({
                id: `api_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                pluginName,
                event: 'api_access',
                resource: apiPath,
                action: method,
                timestamp: new Date(),
                metadata: { allowed },
                severity: allowed ? 'info' : 'warning'
            });
            return allowed;
        }
        catch (error) {
            this.logger.error(`API access validation failed for ${pluginName}`, error);
            return false;
        }
    }
    async encrypt(data, key) {
        try {
            const encryptionKey = key ? (0, crypto_1.scryptSync)(key, 'metasheet-salt', 32) : this.encryptionKey;
            const iv = (0, crypto_1.randomBytes)(16);
            const cipher = (0, crypto_1.createCipheriv)('aes-256-gcm', encryptionKey, iv);
            let encrypted = cipher.update(data, 'utf8', 'hex');
            encrypted += cipher.final('hex');
            const authTag = cipher.getAuthTag();
            // 返回格式: iv:authTag:encryptedData
            return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
        }
        catch (error) {
            this.logger.error('Encryption failed', error);
            throw error;
        }
    }
    async decrypt(encryptedData, key) {
        try {
            const [ivHex, authTagHex, encrypted] = encryptedData.split(':');
            if (!ivHex || !authTagHex || !encrypted) {
                throw new Error('Invalid encrypted data format');
            }
            const encryptionKey = key ? (0, crypto_1.scryptSync)(key, 'metasheet-salt', 32) : this.encryptionKey;
            const iv = Buffer.from(ivHex, 'hex');
            const authTag = Buffer.from(authTagHex, 'hex');
            const decipher = (0, crypto_1.createDecipheriv)('aes-256-gcm', encryptionKey, iv);
            decipher.setAuthTag(authTag);
            let decrypted = decipher.update(encrypted, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        }
        catch (error) {
            this.logger.error('Decryption failed', error);
            throw error;
        }
    }
    async hash(data, algorithm = 'sha256') {
        try {
            const hash = (0, crypto_1.createHash)(algorithm);
            hash.update(data);
            return hash.digest('hex');
        }
        catch (error) {
            this.logger.error('Hashing failed', error);
            throw error;
        }
    }
    async verify(data, hash, algorithm = 'sha256') {
        try {
            const computedHash = await this.hash(data, algorithm);
            return computedHash === hash;
        }
        catch (error) {
            this.logger.error('Hash verification failed', error);
            return false;
        }
    }
    async audit(event) {
        try {
            this.auditLog.unshift(event);
            // 保持审计日志在合理大小
            const maxLogSize = 50000;
            if (this.auditLog.length > maxLogSize) {
                this.auditLog = this.auditLog.slice(0, maxLogSize);
            }
            // 发出审计事件
            this.emit('audit', event);
            // 记录严重事件
            if (event.severity === 'critical' || event.severity === 'error') {
                this.logger.warn(`Security audit [${event.severity}]: ${event.event} by ${event.pluginName}`);
            }
        }
        catch (error) {
            this.logger.error('Failed to record audit event', error);
        }
    }
    async getAuditLog(options = {}) {
        let filtered = [...this.auditLog];
        // 应用过滤器
        if (options.pluginName) {
            filtered = filtered.filter(e => e.pluginName === options.pluginName);
        }
        if (options.event) {
            filtered = filtered.filter(e => e.event === options.event);
        }
        if (options.severity) {
            filtered = filtered.filter(e => e.severity === options.severity);
        }
        if (options.userId) {
            filtered = filtered.filter(e => e.userId === options.userId);
        }
        if (options.dateFrom) {
            filtered = filtered.filter(e => e.timestamp >= options.dateFrom);
        }
        if (options.dateTo) {
            filtered = filtered.filter(e => e.timestamp <= options.dateTo);
        }
        // 分页
        const offset = options.offset || 0;
        const limit = options.limit || 1000;
        return filtered.slice(offset, offset + limit);
    }
    async scanForThreats(pluginName, code) {
        try {
            const sandbox = this.getSandbox(pluginName) || this.createSandbox(pluginName);
            const result = await sandbox['scanCode'](code);
            await this.audit({
                id: `scan_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                pluginName,
                event: 'threat_scan',
                timestamp: new Date(),
                metadata: {
                    safe: result.safe,
                    threatCount: result.threats.length,
                    criticalThreats: result.threats.filter(t => t.severity === 'critical').length
                },
                severity: result.safe ? 'info' : 'warning'
            });
            return result;
        }
        catch (error) {
            this.logger.error(`Threat scan failed for ${pluginName}`, error);
            return {
                safe: false,
                threats: [{
                        type: 'scan_error',
                        severity: 'high',
                        description: `Threat scan failed: ${error.message}`
                    }]
            };
        }
    }
    async checkRateLimit(pluginName, resource) {
        const key = `${pluginName}:${resource}`;
        return this.rateLimiter.check(key);
    }
    async monitorResource(pluginName, resource, usage) {
        try {
            const pluginUsage = this.resourceUsage.get(pluginName) || [];
            pluginUsage.push(usage);
            // 保持最近的使用记录
            const maxRecords = 1000;
            if (pluginUsage.length > maxRecords) {
                pluginUsage.splice(0, pluginUsage.length - maxRecords);
            }
            this.resourceUsage.set(pluginName, pluginUsage);
            // 检查是否超出限制
            if (usage.current > usage.limit) {
                await this.audit({
                    id: `resource_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                    pluginName,
                    event: 'resource_limit_exceeded',
                    resource,
                    timestamp: new Date(),
                    metadata: {
                        current: usage.current,
                        limit: usage.limit,
                        unit: usage.unit
                    },
                    severity: 'warning'
                });
            }
        }
        catch (error) {
            this.logger.error(`Resource monitoring failed for ${pluginName}`, error);
        }
    }
    async getResourceUsage(pluginName) {
        return this.resourceUsage.get(pluginName) || [];
    }
    cleanup() {
        try {
            // 清理速率限制器
            this.rateLimiter.cleanup();
            // 清理旧的资源使用记录
            const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24小时前
            for (const [pluginName, usage] of this.resourceUsage.entries()) {
                const filtered = usage.filter(u => u.timestamp >= cutoff);
                if (filtered.length !== usage.length) {
                    this.resourceUsage.set(pluginName, filtered);
                }
            }
            // 清理审计日志（保留最近7天）
            const auditCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            const originalSize = this.auditLog.length;
            this.auditLog = this.auditLog.filter(log => log.timestamp >= auditCutoff);
            const cleaned = originalSize - this.auditLog.length;
            if (cleaned > 0) {
                this.logger.debug(`Cleaned up ${cleaned} old audit log entries`);
            }
        }
        catch (error) {
            this.logger.error('Cleanup failed', error);
        }
    }
    /**
     * 获取安全服务统计信息
     */
    getStats() {
        return {
            sandboxes: this.sandboxes.size,
            auditEvents: this.auditLog.length,
            resourceMonitoring: Array.from(this.resourceUsage.values()).reduce((total, usage) => total + usage.length, 0),
            rateLimits: this.rateLimiter.limits.size
        };
    }
}
exports.SecurityServiceImpl = SecurityServiceImpl;
// @ts-nocheck
//# sourceMappingURL=SecurityService.js.map