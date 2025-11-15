/**
 * Plugin Capability Manager
 * Manages and validates plugin capability declarations
 */
import { z } from 'zod';
import { PluginCapabilities } from './PluginContext';
export declare const PluginCapabilitiesSchema: z.ZodObject<{
    database: z.ZodOptional<z.ZodObject<{
        read: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        write: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        execute: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        read?: string[];
        write?: string[];
        execute?: boolean;
    }, {
        read?: string[];
        write?: string[];
        execute?: boolean;
    }>>;
    http: z.ZodOptional<z.ZodObject<{
        internal: z.ZodOptional<z.ZodBoolean>;
        external: z.ZodOptional<z.ZodBoolean>;
        allowedDomains: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        internal?: boolean;
        external?: boolean;
        allowedDomains?: string[];
    }, {
        internal?: boolean;
        external?: boolean;
        allowedDomains?: string[];
    }>>;
    filesystem: z.ZodOptional<z.ZodObject<{
        read: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        write: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        temp: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        read?: string[];
        write?: string[];
        temp?: boolean;
    }, {
        read?: string[];
        write?: string[];
        temp?: boolean;
    }>>;
    events: z.ZodOptional<z.ZodObject<{
        emit: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        listen: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        emit?: string[];
        listen?: string[];
    }, {
        emit?: string[];
        listen?: string[];
    }>>;
    system: z.ZodOptional<z.ZodObject<{
        env: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        spawn: z.ZodOptional<z.ZodBoolean>;
        network: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        env?: string[];
        spawn?: boolean;
        network?: boolean;
    }, {
        env?: string[];
        spawn?: boolean;
        network?: boolean;
    }>>;
    ui: z.ZodOptional<z.ZodObject<{
        views: z.ZodOptional<z.ZodBoolean>;
        modals: z.ZodOptional<z.ZodBoolean>;
        notifications: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        views?: boolean;
        modals?: boolean;
        notifications?: boolean;
    }, {
        views?: boolean;
        modals?: boolean;
        notifications?: boolean;
    }>>;
}, "strip", z.ZodTypeAny, {
    database?: {
        read?: string[];
        write?: string[];
        execute?: boolean;
    };
    http?: {
        internal?: boolean;
        external?: boolean;
        allowedDomains?: string[];
    };
    events?: {
        emit?: string[];
        listen?: string[];
    };
    system?: {
        env?: string[];
        spawn?: boolean;
        network?: boolean;
    };
    filesystem?: {
        read?: string[];
        write?: string[];
        temp?: boolean;
    };
    ui?: {
        views?: boolean;
        modals?: boolean;
        notifications?: boolean;
    };
}, {
    database?: {
        read?: string[];
        write?: string[];
        execute?: boolean;
    };
    http?: {
        internal?: boolean;
        external?: boolean;
        allowedDomains?: string[];
    };
    events?: {
        emit?: string[];
        listen?: string[];
    };
    system?: {
        env?: string[];
        spawn?: boolean;
        network?: boolean;
    };
    filesystem?: {
        read?: string[];
        write?: string[];
        temp?: boolean;
    };
    ui?: {
        views?: boolean;
        modals?: boolean;
        notifications?: boolean;
    };
}>;
export declare enum CapabilityLevel {
    MINIMAL = "minimal",// Basic read-only access
    STANDARD = "standard",// Standard read/write access
    ENHANCED = "enhanced",// Enhanced features like transactions
    PRIVILEGED = "privileged"
}
export declare const CAPABILITY_TEMPLATES: Record<CapabilityLevel, PluginCapabilities>;
export interface SecurityPolicy {
    maxDatabaseTables?: number;
    maxHttpDomains?: number;
    maxFilePaths?: number;
    allowExecute?: boolean;
    allowSpawn?: boolean;
    allowNetworkAccess?: boolean;
    requireSignature?: boolean;
}
export declare class PluginCapabilityManager {
    private logger;
    private policy;
    private capabilityCache;
    private approvedCapabilities;
    constructor(policy?: SecurityPolicy);
    /**
     * Validate plugin capabilities against schema and security policy
     */
    validateCapabilities(pluginId: string, capabilities: any, level?: CapabilityLevel): PluginCapabilities;
    /**
     * Apply security policy to capabilities
     */
    private applySecurityPolicy;
    /**
     * Merge capabilities with template
     */
    private mergeCapabilities;
    /**
     * Merge arrays with deduplication
     */
    private mergeArrays;
    /**
     * Request capability approval
     */
    requestCapabilityApproval(pluginId: string, capability: string, reason?: string): Promise<boolean>;
    /**
     * Approve a capability for a plugin
     */
    approveCapability(pluginId: string, capability: string): void;
    /**
     * Check if a plugin has an approved capability
     */
    hasApprovedCapability(pluginId: string, capability: string): boolean;
    /**
     * Get plugin capability level
     */
    getCapabilityLevel(capabilities: PluginCapabilities): CapabilityLevel;
    /**
     * Generate capability report for a plugin
     */
    generateCapabilityReport(pluginId: string): any;
    /**
     * Generate human-readable capability summary
     */
    private generateCapabilitySummary;
    /**
     * Clear capability cache
     */
    clearCache(): void;
}
export default PluginCapabilityManager;
//# sourceMappingURL=PluginCapabilityManager.d.ts.map