import { Pool } from 'pg';
export interface AuditLogData {
    eventType: string;
    eventCategory: string;
    eventSeverity?: string;
    resourceType?: string;
    resourceId?: string;
    resourceName?: string;
    resourcePath?: string;
    action: string;
    actionDetails?: Record<string, any>;
    userId?: number;
    userName?: string;
    userEmail?: string;
    userRoles?: string[];
    impersonatedBy?: number;
    sessionId?: string;
    ipAddress?: string;
    userAgent?: string;
    deviceId?: string;
    deviceType?: string;
    geoCountry?: string;
    geoRegion?: string;
    geoCity?: string;
    geoLatitude?: number;
    geoLongitude?: number;
    requestId?: string;
    requestMethod?: string;
    requestPath?: string;
    requestQuery?: Record<string, any>;
    requestBody?: Record<string, any>;
    requestHeaders?: Record<string, any>;
    responseStatus?: number;
    responseTimeMs?: number;
    responseSizeBytes?: number;
    errorCode?: string;
    errorMessage?: string;
    errorStack?: string;
    complianceFlags?: string[];
    dataClassification?: string;
    retentionPeriod?: number;
    tags?: string[];
    correlationId?: string;
    parentEventId?: string;
}
export interface DataChangeData {
    tableName: string;
    recordId: string;
    operation: 'INSERT' | 'UPDATE' | 'DELETE';
    fieldName?: string;
    oldValue?: any;
    newValue?: any;
    valueType?: string;
    changeReason?: string;
    changeApprovedBy?: number;
}
export interface SecurityEventData {
    securityEventType: string;
    threatLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    authMethod?: string;
    authProvider?: string;
    mfaUsed?: boolean;
    riskScore?: number;
    riskFactors?: Record<string, any>;
    actionTaken?: string;
    alertSent?: boolean;
    alertRecipients?: string[];
}
export interface ComplianceData {
    regulation: string;
    requirement?: string;
    dataSubjectId?: string;
    dataSubjectType?: string;
    processingPurpose?: string;
    legalBasis?: string;
    consentGiven?: boolean;
    consentTimestamp?: Date;
    consentVersion?: string;
    dataCategories?: string[];
    dataRetentionDays?: number;
    dataEncrypted?: boolean;
    dataAnonymized?: boolean;
    dataTransferCountry?: string;
    transferMechanism?: string;
}
export declare class AuditRepository {
    private dbPool;
    constructor(dbPool?: Pool);
    /**
     * Create main audit log entry
     */
    createAuditLog(data: AuditLogData): Promise<number>;
    /**
     * Log data changes with field-level tracking
     */
    logDataChanges(auditLogId: number, changes: DataChangeData[]): Promise<void>;
    /**
     * Log security events
     */
    logSecurityEvent(auditLogId: number, data: SecurityEventData): Promise<void>;
    /**
     * Log compliance-related events
     */
    logComplianceEvent(auditLogId: number, data: ComplianceData): Promise<void>;
    /**
     * Query audit logs with filters
     */
    queryAuditLogs(filters: {
        eventType?: string;
        eventCategory?: string;
        resourceType?: string;
        resourceId?: string;
        userId?: number;
        startDate?: Date;
        endDate?: Date;
        severity?: string;
        limit?: number;
        offset?: number;
    }): Promise<any[]>;
    /**
     * Get user activity summary
     */
    getUserActivitySummary(userId: number, days?: number): Promise<any>;
    /**
     * Get security events summary
     */
    getSecurityEventsSummary(days?: number): Promise<any[]>;
    /**
     * Archive old audit logs
     */
    archiveOldLogs(daysToKeep?: number): Promise<number>;
    /**
     * Create new partition for next month
     */
    createMonthlyPartition(): Promise<void>;
}
//# sourceMappingURL=AuditRepository.d.ts.map