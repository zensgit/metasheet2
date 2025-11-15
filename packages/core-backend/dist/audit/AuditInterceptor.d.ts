import { AuditService } from './AuditService';
/**
 * Database query interceptor for automatic audit logging
 */
export declare class AuditInterceptor {
    private auditService;
    private enabledTables;
    private excludedOperations;
    constructor(auditService: AuditService, config?: {
        enabledTables?: string[];
        excludedOperations?: string[];
    });
    /**
     * Intercept database query for audit logging
     */
    interceptQuery(query: string, params: any[], result: any): Promise<void>;
    /**
     * Log INSERT operation
     */
    private logInsert;
    /**
     * Log UPDATE operation
     */
    private logUpdate;
    /**
     * Log DELETE operation
     */
    private logDelete;
    /**
     * Extract operation type from query
     */
    private extractOperation;
    /**
     * Extract table name from query
     */
    private extractTableName;
    /**
     * Extract record ID from query or result
     */
    private extractRecordId;
    /**
     * Extract updated fields from UPDATE query
     */
    private extractUpdateFields;
}
/**
 * Monkey patch pg Pool to add audit interceptor
 */
export declare function enableAuditInterceptor(pool: any, auditService: AuditService, config?: any): void;
/**
 * Decorator for methods that should trigger audit logging
 */
export declare function Audited(eventType: string, eventCategory?: string): (target: any, propertyKey: string, descriptor: PropertyDescriptor) => PropertyDescriptor;
/**
 * Decorator for compliance-sensitive operations
 */
export declare function Compliant(regulation: string, requirement?: string): (target: any, propertyKey: string, descriptor: PropertyDescriptor) => PropertyDescriptor;
//# sourceMappingURL=AuditInterceptor.d.ts.map