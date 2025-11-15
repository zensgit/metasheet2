"use strict";
/**
 * Enhanced Plugin Context Manager
 * Provides isolated execution context and capability management for plugins
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
exports.PluginContext = void 0;
const eventemitter3_1 = require("eventemitter3");
const vm2_1 = require("vm2");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const logger_1 = require("./logger");
const metrics_1 = require("../metrics/metrics");
class PluginContext extends eventemitter3_1.EventEmitter {
    pluginId;
    coreAPI;
    vm;
    logger;
    capabilities;
    metrics = {
        executionCount: 0,
        totalExecutionTime: 0,
        errorCount: 0
    };
    resourceLimits;
    constructor(pluginId, coreAPI, options) {
        super();
        this.pluginId = pluginId;
        this.coreAPI = coreAPI;
        this.logger = new logger_1.Logger(`PluginContext:${pluginId}`);
        this.capabilities = options.capabilities;
        this.resourceLimits = {
            memory: options.memory || 128,
            timeout: options.timeout || 10000,
            cpuQuota: options.cpuQuota || 50
        };
        this.initializeSandbox();
    }
    /**
     * Initialize VM2 sandbox with security restrictions
     */
    initializeSandbox() {
        try {
            this.vm = new vm2_1.VM({
                timeout: this.resourceLimits.timeout,
                sandbox: this.createSandboxedAPI(),
                fixAsync: true,
                eval: false,
                wasm: false,
                compiler: 'javascript',
                // wrapper may not exist in some vm2 versions; keep compile-time leniency
                // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                // @ts-ignore
                wrapper: 'none'
            });
            this.logger.info(`Sandbox initialized for plugin: ${this.pluginId}`);
        }
        catch (error) {
            this.logger.error(`Failed to initialize sandbox: ${error}`);
            throw error;
        }
    }
    /**
     * Create sandboxed API based on declared capabilities
     */
    createSandboxedAPI() {
        const sandboxAPI = {
            console: this.createSandboxedConsole(),
            setTimeout: undefined,
            setInterval: undefined,
            setImmediate: undefined,
            process: {
                env: this.createSandboxedEnv(),
                version: process.version,
                platform: process.platform
            }
        };
        // Add database API if capability declared
        if (this.capabilities.database) {
            sandboxAPI.database = this.createSandboxedDatabase();
        }
        // Add HTTP API if capability declared
        if (this.capabilities.http) {
            sandboxAPI.http = this.createSandboxedHttp();
        }
        // Add events API if capability declared
        if (this.capabilities.events) {
            sandboxAPI.events = this.createSandboxedEvents();
        }
        // Add filesystem API if capability declared
        if (this.capabilities.filesystem) {
            sandboxAPI.fs = this.createSandboxedFilesystem();
        }
        // Add core MetaSheet API
        sandboxAPI.metasheet = this.createSandboxedMetaSheetAPI();
        return sandboxAPI;
    }
    /**
     * Create sandboxed console for logging
     */
    createSandboxedConsole() {
        return {
            log: (...args) => this.logger.info(`[${this.pluginId}]`, ...args),
            error: (...args) => this.logger.error(`[${this.pluginId}]`, ...args),
            warn: (...args) => this.logger.warn(`[${this.pluginId}]`, ...args),
            info: (...args) => this.logger.info(`[${this.pluginId}]`, ...args),
            debug: (...args) => this.logger.debug(`[${this.pluginId}]`, ...args)
        };
    }
    /**
     * Create sandboxed environment variables
     */
    createSandboxedEnv() {
        const env = {};
        if (this.capabilities.system?.env) {
            for (const key of this.capabilities.system.env) {
                if (process.env[key]) {
                    env[key] = process.env[key];
                }
            }
        }
        return env;
    }
    /**
     * Create sandboxed database API
     */
    createSandboxedDatabase() {
        const { database } = this.capabilities;
        return {
            query: async (sql, params) => {
                // Check if plugin has execute permission
                if (!database?.execute) {
                    // Parse SQL to check table access
                    const tables = this.extractTablesFromSQL(sql);
                    const isRead = /^\s*(SELECT|WITH)/i.test(sql);
                    const isWrite = /^\s*(INSERT|UPDATE|DELETE)/i.test(sql);
                    if (isRead) {
                        const allowed = tables.every(table => database.read?.includes(table));
                        if (!allowed) {
                            throw new Error(`Plugin ${this.pluginId} does not have read access to requested tables`);
                        }
                    }
                    if (isWrite) {
                        const allowed = tables.every(table => database.write?.includes(table));
                        if (!allowed) {
                            throw new Error(`Plugin ${this.pluginId} does not have write access to requested tables`);
                        }
                    }
                }
                try {
                    const result = await this.coreAPI.database.query(sql, params);
                    metrics_1.metrics.pluginDatabaseQueries?.inc?.({ plugin: this.pluginId, operation: 'query' });
                    return result;
                }
                catch (error) {
                    ;
                    metrics_1.metrics.pluginErrors?.inc?.({ plugin: this.pluginId, type: 'database' });
                    throw error;
                }
            },
            transaction: async (callback) => {
                if (!database?.write || database.write.length === 0) {
                    throw new Error(`Plugin ${this.pluginId} does not have transaction capability`);
                }
                return await this.coreAPI.database.transaction(async (tx) => {
                    return await callback(tx);
                });
            }
        };
    }
    /**
     * Create sandboxed HTTP client
     */
    createSandboxedHttp() {
        const { http } = this.capabilities;
        return {
            request: async (url, options) => {
                const urlObj = new URL(url);
                // Check domain restrictions
                if (!http?.external && !this.isInternalURL(urlObj)) {
                    throw new Error(`Plugin ${this.pluginId} cannot access external URLs`);
                }
                if (http?.allowedDomains && !http.allowedDomains.includes(urlObj.hostname)) {
                    throw new Error(`Plugin ${this.pluginId} cannot access domain: ${urlObj.hostname}`);
                }
                try {
                    const result = await this.coreAPI.http.request({
                        url,
                        ...options,
                        headers: {
                            ...options?.headers,
                            'X-Plugin-ID': this.pluginId
                        }
                    });
                    metrics_1.metrics.pluginHttpRequests?.inc?.({ plugin: this.pluginId, domain: urlObj.hostname });
                    return result;
                }
                catch (error) {
                    ;
                    metrics_1.metrics.pluginErrors?.inc?.({ plugin: this.pluginId, type: 'http' });
                    throw error;
                }
            }
        };
    }
    /**
     * Create sandboxed event emitter
     */
    createSandboxedEvents() {
        const { events } = this.capabilities;
        return {
            emit: (event, data) => {
                if (!events?.emit?.includes(event)) {
                    throw new Error(`Plugin ${this.pluginId} cannot emit event: ${event}`);
                }
                this.emit('plugin:event', {
                    pluginId: this.pluginId,
                    event,
                    data
                });
                metrics_1.metrics.pluginEvents?.inc?.({ plugin: this.pluginId, event, type: 'emit' });
            },
            on: (event, handler) => {
                if (!events?.listen?.includes(event)) {
                    throw new Error(`Plugin ${this.pluginId} cannot listen to event: ${event}`);
                }
                this.on(event, (data) => {
                    this.executeInSandbox(handler, [data]);
                });
                metrics_1.metrics.pluginEvents?.inc?.({ plugin: this.pluginId, event, type: 'listen' });
            }
        };
    }
    /**
     * Create sandboxed filesystem API
     */
    createSandboxedFilesystem() {
        const { filesystem } = this.capabilities;
        return {
            readFile: async (filePath) => {
                const resolvedPath = path.resolve(filePath);
                // Check if path is allowed
                const allowed = filesystem?.read?.some(allowedPath => resolvedPath.startsWith(path.resolve(allowedPath)));
                if (!allowed) {
                    throw new Error(`Plugin ${this.pluginId} cannot read file: ${filePath}`);
                }
                try {
                    const content = await fs.promises.readFile(resolvedPath, 'utf-8');
                    metrics_1.metrics.pluginFileOperations?.inc?.({ plugin: this.pluginId, operation: 'read' });
                    return content;
                }
                catch (error) {
                    ;
                    metrics_1.metrics.pluginErrors?.inc?.({ plugin: this.pluginId, type: 'filesystem' });
                    throw error;
                }
            },
            writeFile: async (filePath, content) => {
                const resolvedPath = path.resolve(filePath);
                // Check if path is allowed
                const allowed = filesystem?.write?.some(allowedPath => resolvedPath.startsWith(path.resolve(allowedPath)));
                if (!allowed) {
                    throw new Error(`Plugin ${this.pluginId} cannot write file: ${filePath}`);
                }
                try {
                    await fs.promises.writeFile(resolvedPath, content, 'utf-8');
                    metrics_1.metrics.pluginFileOperations?.inc?.({ plugin: this.pluginId, operation: 'write' });
                }
                catch (error) {
                    ;
                    metrics_1.metrics.pluginErrors?.inc?.({ plugin: this.pluginId, type: 'filesystem' });
                    throw error;
                }
            }
        };
    }
    /**
     * Create sandboxed MetaSheet-specific API
     */
    createSandboxedMetaSheetAPI() {
        return {
            getSpreadsheet: async (id) => {
                // Check if plugin has database read access to spreadsheets table
                if (!this.capabilities.database?.read?.includes('spreadsheets')) {
                    throw new Error(`Plugin ${this.pluginId} cannot access spreadsheets`);
                }
                return await this.coreAPI.database.query('SELECT * FROM spreadsheets WHERE id = $1', [id]);
            },
            updateCell: async (spreadsheetId, cellRef, value) => {
                // Check if plugin has database write access
                if (!this.capabilities.database?.write?.includes('spreadsheet_cells')) {
                    throw new Error(`Plugin ${this.pluginId} cannot update cells`);
                }
                // Implementation would update the cell
                this.emit('cell:update', { spreadsheetId, cellRef, value, pluginId: this.pluginId });
            },
            registerView: async (viewConfig) => {
                if (!this.capabilities.ui?.views) {
                    throw new Error(`Plugin ${this.pluginId} cannot register views`);
                }
                this.emit('view:register', { ...viewConfig, pluginId: this.pluginId });
            }
        };
    }
    /**
     * Execute code in sandbox
     */
    async execute(code, context) {
        if (!this.vm) {
            throw new Error('Sandbox not initialized');
        }
        const startTime = Date.now();
        try {
            // Set execution context
            if (context) {
                this.vm.setGlobal('__context', context);
            }
            // Execute with timeout
            const result = await Promise.race([
                this.vm.run(code),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Execution timeout')), this.resourceLimits.timeout))
            ]);
            // Update metrics
            this.metrics.executionCount++;
            this.metrics.totalExecutionTime += Date.now() - startTime;
            this.metrics.lastExecution = new Date();
            metrics_1.metrics.pluginExecutions?.inc?.({ plugin: this.pluginId, status: 'success' });
            return result;
        }
        catch (error) {
            this.metrics.errorCount++;
            metrics_1.metrics.pluginExecutions?.inc?.({ plugin: this.pluginId, status: 'error' });
            metrics_1.metrics.pluginErrors?.inc?.({ plugin: this.pluginId, type: 'execution' });
            this.logger.error(`Plugin execution error: ${error}`);
            throw error;
        }
    }
    /**
     * Execute a function in sandbox
     */
    async executeInSandbox(fn, args) {
        const fnCode = `
      (function() {
        const fn = ${fn.toString()};
        return fn.apply(null, ${JSON.stringify(args)});
      })()
    `;
        return await this.execute(fnCode);
    }
    /**
     * Extract table names from SQL query
     */
    extractTablesFromSQL(sql) {
        const tables = [];
        // Simple regex patterns for table extraction
        const patterns = [
            /FROM\s+["']?(\w+)["']?/gi,
            /JOIN\s+["']?(\w+)["']?/gi,
            /INTO\s+["']?(\w+)["']?/gi,
            /UPDATE\s+["']?(\w+)["']?/gi,
            /DELETE\s+FROM\s+["']?(\w+)["']?/gi
        ];
        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(sql)) !== null) {
                if (match[1] && !tables.includes(match[1])) {
                    tables.push(match[1]);
                }
            }
        }
        return tables;
    }
    /**
     * Check if URL is internal
     */
    isInternalURL(url) {
        return url.hostname === 'localhost' ||
            url.hostname === '127.0.0.1' ||
            url.hostname.endsWith('.local');
    }
    /**
     * Get plugin metrics
     */
    getMetrics() {
        return { ...this.metrics };
    }
    /**
     * Check if plugin has a specific capability
     */
    hasCapability(capability) {
        const parts = capability.split('.');
        let current = this.capabilities;
        for (const part of parts) {
            if (!current[part]) {
                return false;
            }
            current = current[part];
        }
        return true;
    }
    /**
     * Destroy the context and clean up resources
     */
    destroy() {
        if (this.vm) {
            // VM2 doesn't have a destroy method, but we can clear references
            this.vm = undefined;
        }
        this.removeAllListeners();
        this.logger.info(`Plugin context destroyed: ${this.pluginId}`);
    }
}
exports.PluginContext = PluginContext;
exports.default = PluginContext;
//# sourceMappingURL=PluginContext.js.map