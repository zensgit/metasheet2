"use strict";
/**
 * Plugin Capability Manager
 * Manages and validates plugin capability declarations
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginCapabilityManager = exports.CAPABILITY_TEMPLATES = exports.CapabilityLevel = exports.PluginCapabilitiesSchema = void 0;
const zod_1 = require("zod");
const logger_1 = require("./logger");
// Capability validation schemas
const DatabaseCapabilitySchema = zod_1.z.object({
    read: zod_1.z.array(zod_1.z.string()).optional(),
    write: zod_1.z.array(zod_1.z.string()).optional(),
    execute: zod_1.z.boolean().optional()
}).optional();
const HttpCapabilitySchema = zod_1.z.object({
    internal: zod_1.z.boolean().optional(),
    external: zod_1.z.boolean().optional(),
    allowedDomains: zod_1.z.array(zod_1.z.string()).optional()
}).optional();
const FilesystemCapabilitySchema = zod_1.z.object({
    read: zod_1.z.array(zod_1.z.string()).optional(),
    write: zod_1.z.array(zod_1.z.string()).optional(),
    temp: zod_1.z.boolean().optional()
}).optional();
const EventsCapabilitySchema = zod_1.z.object({
    emit: zod_1.z.array(zod_1.z.string()).optional(),
    listen: zod_1.z.array(zod_1.z.string()).optional()
}).optional();
const SystemCapabilitySchema = zod_1.z.object({
    env: zod_1.z.array(zod_1.z.string()).optional(),
    spawn: zod_1.z.boolean().optional(),
    network: zod_1.z.boolean().optional()
}).optional();
const UICapabilitySchema = zod_1.z.object({
    views: zod_1.z.boolean().optional(),
    modals: zod_1.z.boolean().optional(),
    notifications: zod_1.z.boolean().optional()
}).optional();
exports.PluginCapabilitiesSchema = zod_1.z.object({
    database: DatabaseCapabilitySchema,
    http: HttpCapabilitySchema,
    filesystem: FilesystemCapabilitySchema,
    events: EventsCapabilitySchema,
    system: SystemCapabilitySchema,
    ui: UICapabilitySchema
});
// Capability levels for progressive enhancement
var CapabilityLevel;
(function (CapabilityLevel) {
    CapabilityLevel["MINIMAL"] = "minimal";
    CapabilityLevel["STANDARD"] = "standard";
    CapabilityLevel["ENHANCED"] = "enhanced";
    CapabilityLevel["PRIVILEGED"] = "privileged"; // Full system access
})(CapabilityLevel || (exports.CapabilityLevel = CapabilityLevel = {}));
// Predefined capability templates
exports.CAPABILITY_TEMPLATES = {
    [CapabilityLevel.MINIMAL]: {
        database: {
            read: ['spreadsheets', 'users']
        },
        http: {
            internal: true,
            external: false
        },
        events: {
            listen: ['spreadsheet:update', 'user:login']
        }
    },
    [CapabilityLevel.STANDARD]: {
        database: {
            read: ['spreadsheets', 'users', 'departments', 'workflows'],
            write: ['spreadsheets', 'spreadsheet_cells']
        },
        http: {
            internal: true,
            external: true,
            allowedDomains: ['api.metasheet.io']
        },
        filesystem: {
            temp: true
        },
        events: {
            emit: ['plugin:data', 'plugin:notification'],
            listen: ['spreadsheet:update', 'user:login', 'workflow:trigger']
        },
        ui: {
            views: true,
            notifications: true
        }
    },
    [CapabilityLevel.ENHANCED]: {
        database: {
            read: ['*'],
            write: ['spreadsheets', 'spreadsheet_cells', 'workflows', 'approvals'],
            execute: false
        },
        http: {
            internal: true,
            external: true
        },
        filesystem: {
            read: ['/tmp', '/var/metasheet/plugins'],
            write: ['/tmp'],
            temp: true
        },
        events: {
            emit: ['*'],
            listen: ['*']
        },
        system: {
            env: ['NODE_ENV', 'PLUGIN_CONFIG'],
            network: true
        },
        ui: {
            views: true,
            modals: true,
            notifications: true
        }
    },
    [CapabilityLevel.PRIVILEGED]: {
        database: {
            read: ['*'],
            write: ['*'],
            execute: true
        },
        http: {
            internal: true,
            external: true
        },
        filesystem: {
            read: ['*'],
            write: ['/tmp', '/var/metasheet'],
            temp: true
        },
        events: {
            emit: ['*'],
            listen: ['*']
        },
        system: {
            env: ['*'],
            spawn: true,
            network: true
        },
        ui: {
            views: true,
            modals: true,
            notifications: true
        }
    }
};
const DEFAULT_SECURITY_POLICY = {
    maxDatabaseTables: 10,
    maxHttpDomains: 5,
    maxFilePaths: 3,
    allowExecute: false,
    allowSpawn: false,
    allowNetworkAccess: true,
    requireSignature: true
};
class PluginCapabilityManager {
    logger;
    policy;
    capabilityCache = new Map();
    approvedCapabilities = new Map();
    constructor(policy) {
        this.logger = new logger_1.Logger('PluginCapabilityManager');
        this.policy = { ...DEFAULT_SECURITY_POLICY, ...policy };
    }
    /**
     * Validate plugin capabilities against schema and security policy
     */
    validateCapabilities(pluginId, capabilities, level) {
        try {
            // Parse with Zod schema
            const parsed = exports.PluginCapabilitiesSchema.parse(capabilities);
            // Apply security policy
            this.applySecurityPolicy(parsed);
            // If level specified, merge with template
            if (level) {
                const template = exports.CAPABILITY_TEMPLATES[level];
                const merged = this.mergeCapabilities(template, parsed);
                this.capabilityCache.set(pluginId, merged);
                return merged;
            }
            this.capabilityCache.set(pluginId, parsed);
            return parsed;
        }
        catch (error) {
            this.logger.error(`Invalid capabilities for plugin ${pluginId}: ${error}`);
            throw new Error(`Invalid plugin capabilities: ${error}`);
        }
    }
    /**
     * Apply security policy to capabilities
     */
    applySecurityPolicy(capabilities) {
        // Check database table limits
        if (capabilities.database) {
            const tableCount = (capabilities.database.read?.length || 0) +
                (capabilities.database.write?.length || 0);
            if (tableCount > this.policy.maxDatabaseTables) {
                throw new Error(`Plugin exceeds maximum table access limit (${this.policy.maxDatabaseTables})`);
            }
            if (capabilities.database.execute && !this.policy.allowExecute) {
                throw new Error('Database execute permission not allowed by security policy');
            }
        }
        // Check HTTP domain limits
        if (capabilities.http?.allowedDomains) {
            if (capabilities.http.allowedDomains.length > this.policy.maxHttpDomains) {
                throw new Error(`Plugin exceeds maximum HTTP domain limit (${this.policy.maxHttpDomains})`);
            }
        }
        // Check filesystem path limits
        if (capabilities.filesystem) {
            const pathCount = (capabilities.filesystem.read?.length || 0) +
                (capabilities.filesystem.write?.length || 0);
            if (pathCount > this.policy.maxFilePaths) {
                throw new Error(`Plugin exceeds maximum file path limit (${this.policy.maxFilePaths})`);
            }
        }
        // Check system capabilities
        if (capabilities.system) {
            if (capabilities.system.spawn && !this.policy.allowSpawn) {
                throw new Error('Process spawn permission not allowed by security policy');
            }
            if (capabilities.system.network && !this.policy.allowNetworkAccess) {
                throw new Error('Network access not allowed by security policy');
            }
        }
    }
    /**
     * Merge capabilities with template
     */
    mergeCapabilities(template, custom) {
        const merged = {};
        // Merge database capabilities
        if (template.database || custom.database) {
            merged.database = {
                read: this.mergeArrays(template.database?.read, custom.database?.read),
                write: this.mergeArrays(template.database?.write, custom.database?.write),
                execute: custom.database?.execute ?? template.database?.execute
            };
        }
        // Merge HTTP capabilities
        if (template.http || custom.http) {
            merged.http = {
                internal: custom.http?.internal ?? template.http?.internal,
                external: custom.http?.external ?? template.http?.external,
                allowedDomains: this.mergeArrays(template.http?.allowedDomains, custom.http?.allowedDomains)
            };
        }
        // Merge filesystem capabilities
        if (template.filesystem || custom.filesystem) {
            merged.filesystem = {
                read: this.mergeArrays(template.filesystem?.read, custom.filesystem?.read),
                write: this.mergeArrays(template.filesystem?.write, custom.filesystem?.write),
                temp: custom.filesystem?.temp ?? template.filesystem?.temp
            };
        }
        // Merge events capabilities
        if (template.events || custom.events) {
            merged.events = {
                emit: this.mergeArrays(template.events?.emit, custom.events?.emit),
                listen: this.mergeArrays(template.events?.listen, custom.events?.listen)
            };
        }
        // Merge system capabilities
        if (template.system || custom.system) {
            merged.system = {
                env: this.mergeArrays(template.system?.env, custom.system?.env),
                spawn: custom.system?.spawn ?? template.system?.spawn,
                network: custom.system?.network ?? template.system?.network
            };
        }
        // Merge UI capabilities
        if (template.ui || custom.ui) {
            merged.ui = {
                views: custom.ui?.views ?? template.ui?.views,
                modals: custom.ui?.modals ?? template.ui?.modals,
                notifications: custom.ui?.notifications ?? template.ui?.notifications
            };
        }
        return merged;
    }
    /**
     * Merge arrays with deduplication
     */
    mergeArrays(arr1, arr2) {
        if (!arr1 && !arr2)
            return undefined;
        if (!arr1)
            return arr2;
        if (!arr2)
            return arr1;
        const set = new Set([...arr1, ...arr2]);
        return Array.from(set);
    }
    /**
     * Request capability approval
     */
    async requestCapabilityApproval(pluginId, capability, reason) {
        // In production, this would trigger an approval workflow
        this.logger.info(`Plugin ${pluginId} requesting capability: ${capability}`);
        if (reason) {
            this.logger.info(`Reason: ${reason}`);
        }
        // For now, auto-approve in development
        if (process.env.NODE_ENV === 'development') {
            this.approveCapability(pluginId, capability);
            return true;
        }
        return false;
    }
    /**
     * Approve a capability for a plugin
     */
    approveCapability(pluginId, capability) {
        if (!this.approvedCapabilities.has(pluginId)) {
            this.approvedCapabilities.set(pluginId, new Set());
        }
        this.approvedCapabilities.get(pluginId).add(capability);
        this.logger.info(`Approved capability ${capability} for plugin ${pluginId}`);
    }
    /**
     * Check if a plugin has an approved capability
     */
    hasApprovedCapability(pluginId, capability) {
        return this.approvedCapabilities.get(pluginId)?.has(capability) || false;
    }
    /**
     * Get plugin capability level
     */
    getCapabilityLevel(capabilities) {
        // Determine level based on capabilities
        if (capabilities.database?.execute || capabilities.system?.spawn) {
            return CapabilityLevel.PRIVILEGED;
        }
        if (capabilities.database?.write && capabilities.database.write.length > 0) {
            return CapabilityLevel.ENHANCED;
        }
        if (capabilities.http?.external || capabilities.ui?.views) {
            return CapabilityLevel.STANDARD;
        }
        return CapabilityLevel.MINIMAL;
    }
    /**
     * Generate capability report for a plugin
     */
    generateCapabilityReport(pluginId) {
        const capabilities = this.capabilityCache.get(pluginId);
        if (!capabilities) {
            return null;
        }
        const level = this.getCapabilityLevel(capabilities);
        const approved = Array.from(this.approvedCapabilities.get(pluginId) || []);
        return {
            pluginId,
            level,
            capabilities,
            approved,
            summary: this.generateCapabilitySummary(capabilities)
        };
    }
    /**
     * Generate human-readable capability summary
     */
    generateCapabilitySummary(capabilities) {
        const summary = [];
        if (capabilities.database) {
            if (capabilities.database.execute) {
                summary.push('Can execute arbitrary SQL queries');
            }
            if (capabilities.database.read?.includes('*')) {
                summary.push('Can read all database tables');
            }
            else if (capabilities.database.read?.length) {
                summary.push(`Can read ${capabilities.database.read.length} tables`);
            }
            if (capabilities.database.write?.includes('*')) {
                summary.push('Can write to all database tables');
            }
            else if (capabilities.database.write?.length) {
                summary.push(`Can write to ${capabilities.database.write.length} tables`);
            }
        }
        if (capabilities.http) {
            if (capabilities.http.external) {
                summary.push('Can make external HTTP requests');
            }
            if (capabilities.http.allowedDomains?.length) {
                summary.push(`Can access ${capabilities.http.allowedDomains.length} external domains`);
            }
        }
        if (capabilities.filesystem) {
            if (capabilities.filesystem.read?.includes('*')) {
                summary.push('Can read all files');
            }
            else if (capabilities.filesystem.read?.length) {
                summary.push(`Can read from ${capabilities.filesystem.read.length} directories`);
            }
            if (capabilities.filesystem.write?.length) {
                summary.push(`Can write to ${capabilities.filesystem.write.length} directories`);
            }
        }
        if (capabilities.system) {
            if (capabilities.system.spawn) {
                summary.push('Can spawn child processes');
            }
            if (capabilities.system.network) {
                summary.push('Can create network connections');
            }
        }
        if (capabilities.ui) {
            const uiFeatures = [];
            if (capabilities.ui.views)
                uiFeatures.push('views');
            if (capabilities.ui.modals)
                uiFeatures.push('modals');
            if (capabilities.ui.notifications)
                uiFeatures.push('notifications');
            if (uiFeatures.length) {
                summary.push(`Can create UI: ${uiFeatures.join(', ')}`);
            }
        }
        return summary;
    }
    /**
     * Clear capability cache
     */
    clearCache() {
        this.capabilityCache.clear();
        this.approvedCapabilities.clear();
    }
}
exports.PluginCapabilityManager = PluginCapabilityManager;
exports.default = PluginCapabilityManager;
//# sourceMappingURL=PluginCapabilityManager.js.map