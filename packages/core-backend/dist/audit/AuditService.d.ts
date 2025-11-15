import { EventEmitter } from 'events';
import { AuditRepository, AuditLogData, SecurityEventData, ComplianceData } from './AuditRepository';
import { Request, Response, NextFunction } from 'express';
export interface AuditContext {
    userId?: number;
    userName?: string;
    userEmail?: string;
    userRoles?: string[];
    sessionId?: string;
    requestId?: string;
    correlationId?: string;
    impersonatedBy?: number;
}
export interface AuditOptions {
    skipLogging?: boolean;
    sensitiveFields?: string[];
    complianceFlags?: string[];
    dataClassification?: string;
    retentionDays?: number;
}
export declare class AuditService extends EventEmitter {
    private repository;
    private context;
    private performanceStart;
    constructor(repository?: AuditRepository);
    /**
     * Set audit context for current operation
     */
    setContext(context: AuditContext): void;
    /**
     * Clear audit context
     */
    clearContext(): void;
    /**
     * Express middleware for automatic audit logging
     */
    middleware(options?: AuditOptions): (req: Request, res: Response, next: NextFunction) => Promise<void>;
    /**
     * Log a custom event
     */
    logEvent(eventType: string, action: string, details?: Partial<AuditLogData>): Promise<number>;
    /**
     * Log data changes with before/after values
     */
    logDataChange(tableName: string, recordId: string, operation: 'INSERT' | 'UPDATE' | 'DELETE', changes: Array<{
        field: string;
        oldValue?: any;
        newValue?: any;
    }>, options?: AuditOptions): Promise<void>;
    /**
     * Log security event
     */
    logSecurityEvent(eventType: string, details: SecurityEventData & Partial<AuditLogData>): Promise<void>;
    /**
     * Log compliance event
     */
    logComplianceEvent(regulation: string, details: ComplianceData & Partial<AuditLogData>): Promise<void>;
    /**
     * Log authentication attempt
     */
    logAuthAttempt(success: boolean, method: string, details?: Partial<SecurityEventData & AuditLogData>): Promise<void>;
    /**
     * Log permission check
     */
    logPermissionCheck(resource: string, action: string, granted: boolean, reason?: string): Promise<void>;
    /**
     * Start performance tracking
     */
    startPerformanceTracking(operationId: string): void;
    /**
     * End performance tracking and log
     */
    endPerformanceTracking(operationId: string, details?: Partial<AuditLogData>): Promise<void>;
    /**
     * Query audit logs
     */
    queryLogs(filters: any): Promise<any[]>;
    /**
     * Get user activity summary
     */
    getUserActivity(userId: number, days?: number): Promise<any>;
    /**
     * Get security events summary
     */
    getSecuritySummary(days?: number): Promise<any[]>;
    /**
     * Archive old logs
     */
    archiveLogs(daysToKeep?: number): Promise<number>;
    /**
     * Helper: Sanitize sensitive data
     */
    private sanitizeData;
    /**
     * Helper: Map HTTP method to event type
     */
    private mapMethodToEventType;
    /**
     * Helper: Extract resource type from path
     */
    private extractResourceType;
    /**
     * Helper: Extract resource ID from path
     */
    private extractResourceId;
    /**
     * Helper: Detect device type from user agent
     */
    private detectDeviceType;
    /**
     * Helper: Detect value type
     */
    private detectValueType;
    /**
     * Helper: Map threat level to severity
     */
    private mapThreatLevelToSeverity;
}
//# sourceMappingURL=AuditService.d.ts.map