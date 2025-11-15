export type AuditMeta = Record<string, any>;
export declare function auditLog(params: {
    actorId?: string;
    actorType: 'user' | 'system' | 'service';
    action: string;
    resourceType: string;
    resourceId?: string;
    requestId?: string;
    ip?: string;
    userAgent?: string;
    meta?: AuditMeta;
}): Promise<void>;
//# sourceMappingURL=audit.d.ts.map