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
        read?: string[] | undefined;
        write?: string[] | undefined;
        execute?: boolean | undefined;
    }, {
        read?: string[] | undefined;
        write?: string[] | undefined;
        execute?: boolean | undefined;
    }>>;
    http: z.ZodOptional<z.ZodObject<{
        internal: z.ZodOptional<z.ZodBoolean>;
        external: z.ZodOptional<z.ZodBoolean>;
        allowedDomains: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        internal?: boolean | undefined;
        external?: boolean | undefined;
        allowedDomains?: string[] | undefined;
    }, {
        internal?: boolean | undefined;
        external?: boolean | undefined;
        allowedDomains?: string[] | undefined;
    }>>;
    filesystem: z.ZodOptional<z.ZodObject<{
        read: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        write: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        temp: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        read?: string[] | undefined;
        write?: string[] | undefined;
        temp?: boolean | undefined;
    }, {
        read?: string[] | undefined;
        write?: string[] | undefined;
        temp?: boolean | undefined;
    }>>;
    events: z.ZodOptional<z.ZodObject<{
        emit: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        listen: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    }, "strip", z.ZodTypeAny, {
        emit?: string[] | undefined;
        listen?: string[] | undefined;
    }, {
        emit?: string[] | undefined;
        listen?: string[] | undefined;
    }>>;
    system: z.ZodOptional<z.ZodObject<{
        env: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
        spawn: z.ZodOptional<z.ZodBoolean>;
        network: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        env?: string[] | undefined;
        spawn?: boolean | undefined;
        network?: boolean | undefined;
    }, {
        env?: string[] | undefined;
        spawn?: boolean | undefined;
        network?: boolean | undefined;
    }>>;
    ui: z.ZodOptional<z.ZodObject<{
        views: z.ZodOptional<z.ZodBoolean>;
        modals: z.ZodOptional<z.ZodBoolean>;
        notifications: z.ZodOptional<z.ZodBoolean>;
    }, "strip", z.ZodTypeAny, {
        views?: boolean | undefined;
        modals?: boolean | undefined;
        notifications?: boolean | undefined;
    }, {
        views?: boolean | undefined;
        modals?: boolean | undefined;
        notifications?: boolean | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    database?: {
        read?: string[] | undefined;
        write?: string[] | undefined;
        execute?: boolean | undefined;
    } | undefined;
    http?: {
        internal?: boolean | undefined;
        external?: boolean | undefined;
        allowedDomains?: string[] | undefined;
    } | undefined;
    filesystem?: {
        read?: string[] | undefined;
        write?: string[] | undefined;
        temp?: boolean | undefined;
    } | undefined;
    events?: {
        emit?: string[] | undefined;
        listen?: string[] | undefined;
    } | undefined;
    system?: {
        env?: string[] | undefined;
        spawn?: boolean | undefined;
        network?: boolean | undefined;
    } | undefined;
    ui?: {
        views?: boolean | undefined;
        modals?: boolean | undefined;
        notifications?: boolean | undefined;
    } | undefined;
}, {
    database?: {
        read?: string[] | undefined;
        write?: string[] | undefined;
        execute?: boolean | undefined;
    } | undefined;
    http?: {
        internal?: boolean | undefined;
        external?: boolean | undefined;
        allowedDomains?: string[] | undefined;
    } | undefined;
    filesystem?: {
        read?: string[] | undefined;
        write?: string[] | undefined;
        temp?: boolean | undefined;
    } | undefined;
    events?: {
        emit?: string[] | undefined;
        listen?: string[] | undefined;
    } | undefined;
    system?: {
        env?: string[] | undefined;
        spawn?: boolean | undefined;
        network?: boolean | undefined;
    } | undefined;
    ui?: {
        views?: boolean | undefined;
        modals?: boolean | undefined;
        notifications?: boolean | undefined;
    } | undefined;
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