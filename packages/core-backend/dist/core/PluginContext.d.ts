/**
 * Enhanced Plugin Context Manager
 * Provides isolated execution context and capability management for plugins
 */
import { EventEmitter } from 'eventemitter3';
import { CoreAPI } from '../types/plugin';
export interface PluginCapability {
    name: string;
    version: string;
    required: boolean;
}
export interface PluginCapabilities {
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
    filesystem?: {
        read?: string[];
        write?: string[];
        temp?: boolean;
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
    ui?: {
        views?: boolean;
        modals?: boolean;
        notifications?: boolean;
    };
}
export interface PluginSandboxOptions {
    timeout?: number;
    memory?: number;
    cpuQuota?: number;
    capabilities: PluginCapabilities;
}
export interface PluginMetrics {
    executionCount: number;
    totalExecutionTime: number;
    errorCount: number;
    lastExecution?: Date;
    memoryUsage?: number;
    cpuUsage?: number;
}
export declare class PluginContext extends EventEmitter {
    private pluginId;
    private coreAPI;
    private vm?;
    private logger;
    private capabilities;
    private metrics;
    private resourceLimits;
    constructor(pluginId: string, coreAPI: CoreAPI, options: PluginSandboxOptions);
    /**
     * Initialize VM2 sandbox with security restrictions
     */
    private initializeSandbox;
    /**
     * Create sandboxed API based on declared capabilities
     */
    private createSandboxedAPI;
    /**
     * Create sandboxed console for logging
     */
    private createSandboxedConsole;
    /**
     * Create sandboxed environment variables
     */
    private createSandboxedEnv;
    /**
     * Create sandboxed database API
     */
    private createSandboxedDatabase;
    /**
     * Create sandboxed HTTP client
     */
    private createSandboxedHttp;
    /**
     * Create sandboxed event emitter
     */
    private createSandboxedEvents;
    /**
     * Create sandboxed filesystem API
     */
    private createSandboxedFilesystem;
    /**
     * Create sandboxed MetaSheet-specific API
     */
    private createSandboxedMetaSheetAPI;
    /**
     * Execute code in sandbox
     */
    execute(code: string, context?: any): Promise<any>;
    /**
     * Execute a function in sandbox
     */
    private executeInSandbox;
    /**
     * Extract table names from SQL query
     */
    private extractTablesFromSQL;
    /**
     * Check if URL is internal
     */
    private isInternalURL;
    /**
     * Get plugin metrics
     */
    getMetrics(): PluginMetrics;
    /**
     * Check if plugin has a specific capability
     */
    hasCapability(capability: string): boolean;
    /**
     * Destroy the context and clean up resources
     */
    destroy(): void;
}
export default PluginContext;
//# sourceMappingURL=PluginContext.d.ts.map