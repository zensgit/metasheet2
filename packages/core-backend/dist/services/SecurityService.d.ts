/**
 * 安全服务实现
 * 提供插件安全功能，包括权限验证、沙箱、加密、审计等
 */
import { EventEmitter } from 'eventemitter3';
import type { SecurityService, PluginSandbox, ResourceLimits, SecurityAuditEvent, AuditLogOptions, ThreatScanResult, RateLimitResult, ResourceUsage } from '../types/plugin';
/**
 * 插件沙箱实现
 */
declare class PluginSandboxImpl implements PluginSandbox {
    pluginName: string;
    allowedAPIs: string[];
    resourceLimits: ResourceLimits;
    environment: Record<string, any>;
    private context;
    private logger;
    constructor(pluginName: string, allowedAPIs: string[], resourceLimits?: ResourceLimits, environment?: Record<string, any>);
    private createContext;
    execute<T>(code: string, context?: any): Promise<T>;
    private scanCode;
}
/**
 * 速率限制器
 */
declare class RateLimiter {
    private limits;
    check(key: string, maxRequests?: number, windowMs?: number): RateLimitResult;
    cleanup(): void;
}
/**
 * 安全服务实现
 */
export declare class SecurityServiceImpl extends EventEmitter implements SecurityService {
    private sandboxes;
    private auditLog;
    private rateLimiter;
    private resourceUsage;
    private logger;
    private encryptionKey;
    constructor(encryptionKey?: string);
    checkPermission(pluginName: string, permission: string): Promise<boolean>;
    checkPermissions(pluginName: string, permissions: string[]): Promise<boolean[]>;
    createSandbox(pluginName: string): PluginSandbox;
    getSandbox(pluginName: string): PluginSandbox | null;
    validateAPIAccess(pluginName: string, apiPath: string, method: string): Promise<boolean>;
    encrypt(data: string, key?: string): Promise<string>;
    decrypt(encryptedData: string, key?: string): Promise<string>;
    hash(data: string, algorithm?: string): Promise<string>;
    verify(data: string, hash: string, algorithm?: string): Promise<boolean>;
    audit(event: SecurityAuditEvent): Promise<void>;
    getAuditLog(options?: AuditLogOptions): Promise<SecurityAuditEvent[]>;
    scanForThreats(pluginName: string, code: string): Promise<ThreatScanResult>;
    checkRateLimit(pluginName: string, resource: string): Promise<RateLimitResult>;
    monitorResource(pluginName: string, resource: string, usage: ResourceUsage): Promise<void>;
    getResourceUsage(pluginName: string): Promise<ResourceUsage[]>;
    private cleanup;
    /**
     * 获取安全服务统计信息
     */
    getStats(): {
        sandboxes: number;
        auditEvents: number;
        resourceMonitoring: number;
        rateLimits: number;
    };
}
export { PluginSandboxImpl, RateLimiter };
//# sourceMappingURL=SecurityService.d.ts.map