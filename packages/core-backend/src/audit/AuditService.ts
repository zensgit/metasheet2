import { EventEmitter } from 'events';
import {
  AuditRepository,
  AuditLogData,
  DataChangeData,
  SecurityEventData,
  ComplianceData
} from './AuditRepository';
import { Request, Response, NextFunction } from 'express';
import * as geoip from 'geoip-lite';

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

export class AuditService extends EventEmitter {
  private repository: AuditRepository;
  private context: AuditContext = {};
  private performanceStart: Map<string, number> = new Map();

  constructor(repository?: AuditRepository) {
    super();
    this.repository = repository || new AuditRepository();
  }

  /**
   * Set audit context for current operation
   */
  setContext(context: AuditContext): void {
    this.context = { ...this.context, ...context };
  }

  /**
   * Clear audit context
   */
  clearContext(): void {
    this.context = {};
  }

  /**
   * Express middleware for automatic audit logging
   */
  middleware(options: AuditOptions = {}) {
    return async (req: Request, res: Response, next: NextFunction) => {
      const startTime = Date.now();
      const requestId = req.headers['x-request-id'] as string || 
                       `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Extract user information from request
      const user = (req as any).user;
      const context: AuditContext = {
        userId: user?.id,
        userName: user?.name,
        userEmail: user?.email,
        userRoles: user?.roles,
        // Express 5 typings don't include session by default; keep it optional
        sessionId: (req as any).session?.id || (req.headers['x-session-id'] as string),
        requestId
      };

      // Set context for this request
      this.setContext(context);

      // Capture original send
      const originalSend = res.send;
      let responseBody: any;
      
      res.send = function(data: any) {
        responseBody = data;
        return originalSend.call(this, data);
      };

      // Log on response finish
      res.on('finish', async () => {
        if (options.skipLogging) return;

        try {
          // Extract geo information from IP
          const ip = req.ip || req.connection.remoteAddress;
          const geo = ip ? geoip.lookup(ip) : null;

          // Sanitize request body
          const sanitizedBody = this.sanitizeData(
            req.body,
            options.sensitiveFields || ['password', 'token', 'secret', 'key']
          );

          // Sanitize headers
          const sanitizedHeaders = this.sanitizeData(
            req.headers,
            ['authorization', 'cookie', 'x-api-key']
          );

          const auditData: AuditLogData = {
            eventType: this.mapMethodToEventType(req.method),
            eventCategory: 'USER',
            action: `${req.method} ${req.path}`,
            resourceType: this.extractResourceType(req.path),
            resourceId: this.extractResourceId(req.path),
            ...context,
            ipAddress: ip,
            userAgent: req.headers['user-agent'] as string,
            deviceType: this.detectDeviceType(req.headers['user-agent'] as string),
            geoCountry: geo?.country,
            geoRegion: geo?.region,
            geoCity: geo?.city,
            geoLatitude: geo?.ll?.[0],
            geoLongitude: geo?.ll?.[1],
            requestMethod: req.method,
            requestPath: req.path,
            requestQuery: req.query,
            requestBody: sanitizedBody,
            requestHeaders: sanitizedHeaders,
            responseStatus: res.statusCode,
            responseTimeMs: Date.now() - startTime,
            responseSizeBytes: Buffer.byteLength(JSON.stringify(responseBody || '')),
            complianceFlags: options.complianceFlags,
            dataClassification: options.dataClassification,
            retentionPeriod: options.retentionDays
          };

          // Add error information if response indicates error
          if (res.statusCode >= 400) {
            auditData.eventSeverity = res.statusCode >= 500 ? 'ERROR' : 'WARNING';
            if (responseBody?.error) {
              auditData.errorCode = responseBody.error.code;
              auditData.errorMessage = responseBody.error.message;
            }
          }

          await this.repository.createAuditLog(auditData);
        } catch (error) {
          console.error('Failed to create audit log:', error);
          this.emit('error', error);
        }
      });

      next();
    };
  }

  /**
   * Log a custom event
   */
  async logEvent(
    eventType: string,
    action: string,
    details: Partial<AuditLogData> = {}
  ): Promise<number> {
    const auditData: AuditLogData = {
      eventType,
      eventCategory: details.eventCategory || 'SYSTEM',
      action,
      ...this.context,
      ...details
    };

    const logId = await this.repository.createAuditLog(auditData);
    this.emit('logged', { logId, eventType, action });
    return logId;
  }

  /**
   * Log data changes with before/after values
   */
  async logDataChange(
    tableName: string,
    recordId: string,
    operation: 'INSERT' | 'UPDATE' | 'DELETE',
    changes: Array<{
      field: string;
      oldValue?: any;
      newValue?: any;
    }>,
    options: AuditOptions = {}
  ): Promise<void> {
    // Create main audit log
    const logId = await this.logEvent(
      operation,
      `${operation} ${tableName}`,
      {
        eventCategory: 'DATA',
        resourceType: tableName,
        resourceId: recordId,
        ...options
      }
    );

    // Log individual field changes
    const changeData: DataChangeData[] = changes.map(change => ({
      tableName,
      recordId,
      operation,
      fieldName: change.field,
      oldValue: change.oldValue,
      newValue: change.newValue,
      valueType: this.detectValueType(change.newValue || change.oldValue)
    }));

    await this.repository.logDataChanges(logId, changeData);
  }

  /**
   * Log security event
   */
  async logSecurityEvent(
    eventType: string,
    details: SecurityEventData & Partial<AuditLogData>
  ): Promise<void> {
    const { 
      securityEventType,
      threatLevel,
      authMethod,
      authProvider,
      mfaUsed,
      riskScore,
      riskFactors,
      actionTaken,
      alertSent,
      alertRecipients,
      ...auditDetails
    } = details;

    // Create main audit log
    const logId = await this.logEvent(
      eventType,
      securityEventType,
      {
        eventCategory: 'SECURITY',
        eventSeverity: this.mapThreatLevelToSeverity(threatLevel),
        ...auditDetails
      }
    );

    // Log security details
    await this.repository.logSecurityEvent(logId, {
      securityEventType,
      threatLevel,
      authMethod,
      authProvider,
      mfaUsed,
      riskScore,
      riskFactors,
      actionTaken,
      alertSent,
      alertRecipients
    });

    // Emit alert if needed
    if (alertSent && alertRecipients?.length) {
      this.emit('securityAlert', {
        eventType: securityEventType,
        threatLevel,
        recipients: alertRecipients
      });
    }
  }

  /**
   * Log compliance event
   */
  async logComplianceEvent(
    regulation: string,
    details: ComplianceData & Partial<AuditLogData>
  ): Promise<void> {
    const {
      requirement,
      dataSubjectId,
      dataSubjectType,
      processingPurpose,
      legalBasis,
      consentGiven,
      consentTimestamp,
      consentVersion,
      dataCategories,
      dataRetentionDays,
      dataEncrypted,
      dataAnonymized,
      dataTransferCountry,
      transferMechanism,
      ...auditDetails
    } = details;

    // Create main audit log
    const logId = await this.logEvent(
      'COMPLIANCE',
      `${regulation}_${requirement || 'GENERAL'}`,
      {
        eventCategory: 'COMPLIANCE',
        complianceFlags: [regulation],
        ...auditDetails
      }
    );

    // Log compliance details
    await this.repository.logComplianceEvent(logId, {
      regulation,
      requirement,
      dataSubjectId,
      dataSubjectType,
      processingPurpose,
      legalBasis,
      consentGiven,
      consentTimestamp,
      consentVersion,
      dataCategories,
      dataRetentionDays,
      dataEncrypted,
      dataAnonymized,
      dataTransferCountry,
      transferMechanism
    });
  }

  /**
   * Log authentication attempt
   */
  async logAuthAttempt(
    success: boolean,
    method: string,
    details: Partial<SecurityEventData & AuditLogData> = {}
  ): Promise<void> {
    await this.logSecurityEvent(
      success ? 'LOGIN_SUCCESS' : 'LOGIN_FAILED',
      {
        securityEventType: success ? 'LOGIN_SUCCESS' : 'LOGIN_FAILED',
        threatLevel: success ? undefined : 'LOW',
        authMethod: method,
        ...details
      }
    );
  }

  /**
   * Log permission check
   */
  async logPermissionCheck(
    resource: string,
    action: string,
    granted: boolean,
    reason?: string
  ): Promise<void> {
    await this.logEvent(
      granted ? 'PERMISSION_GRANTED' : 'PERMISSION_DENIED',
      `${action} on ${resource}`,
      {
        eventCategory: 'SECURITY',
        eventSeverity: granted ? 'INFO' : 'WARNING',
        resourceType: resource,
        actionDetails: { reason }
      }
    );
  }

  /**
   * Start performance tracking
   */
  startPerformanceTracking(operationId: string): void {
    this.performanceStart.set(operationId, Date.now());
  }

  /**
   * End performance tracking and log
   */
  async endPerformanceTracking(
    operationId: string,
    details: Partial<AuditLogData> = {}
  ): Promise<void> {
    const startTime = this.performanceStart.get(operationId);
    if (!startTime) return;

    const duration = Date.now() - startTime;
    this.performanceStart.delete(operationId);

    await this.logEvent(
      'PERFORMANCE',
      operationId,
      {
        eventCategory: 'SYSTEM',
        responseTimeMs: duration,
        ...details
      }
    );
  }

  /**
   * Query audit logs
   */
  async queryLogs(filters: any): Promise<any[]> {
    return this.repository.queryAuditLogs(filters);
  }

  /**
   * Get user activity summary
   */
  async getUserActivity(userId: number, days?: number): Promise<any> {
    return this.repository.getUserActivitySummary(userId, days);
  }

  /**
   * Get security events summary
   */
  async getSecuritySummary(days?: number): Promise<any[]> {
    return this.repository.getSecurityEventsSummary(days);
  }

  /**
   * Archive old logs
   */
  async archiveLogs(daysToKeep?: number): Promise<number> {
    const archived = await this.repository.archiveOldLogs(daysToKeep);
    this.emit('archived', { count: archived });
    return archived;
  }

  /**
   * Helper: Sanitize sensitive data
   */
  private sanitizeData(data: any, sensitiveFields: string[]): any {
    if (!data || typeof data !== 'object') return data;

    const sanitized = { ...data };
    for (const field of sensitiveFields) {
      if (field in sanitized) {
        sanitized[field] = '[REDACTED]';
      }
    }
    return sanitized;
  }

  /**
   * Helper: Map HTTP method to event type
   */
  private mapMethodToEventType(method: string): string {
    const mapping: Record<string, string> = {
      'GET': 'READ',
      'POST': 'CREATE',
      'PUT': 'UPDATE',
      'PATCH': 'UPDATE',
      'DELETE': 'DELETE'
    };
    return mapping[method] || method;
  }

  /**
   * Helper: Extract resource type from path
   */
  private extractResourceType(path: string): string | undefined {
    const match = path.match(/\/api\/(\w+)/);
    return match ? match[1] : undefined;
  }

  /**
   * Helper: Extract resource ID from path
   */
  private extractResourceId(path: string): string | undefined {
    const match = path.match(/\/api\/\w+\/(\d+|[a-f0-9-]+)/);
    return match ? match[1] : undefined;
  }

  /**
   * Helper: Detect device type from user agent
   */
  private detectDeviceType(userAgent?: string): string {
    if (!userAgent) return 'unknown';
    
    if (/mobile/i.test(userAgent)) return 'mobile';
    if (/tablet/i.test(userAgent)) return 'tablet';
    if (/bot/i.test(userAgent)) return 'bot';
    return 'desktop';
  }

  /**
   * Helper: Detect value type
   */
  private detectValueType(value: any): string {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'boolean') return 'BOOLEAN';
    if (typeof value === 'number') return 'NUMBER';
    if (typeof value === 'string') return 'STRING';
    if (value instanceof Date) return 'DATE';
    if (Array.isArray(value)) return 'ARRAY';
    return 'OBJECT';
  }

  /**
   * Helper: Map threat level to severity
   */
  private mapThreatLevelToSeverity(
    threatLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  ): string {
    const mapping = {
      'LOW': 'WARNING',
      'MEDIUM': 'WARNING',
      'HIGH': 'ERROR',
      'CRITICAL': 'CRITICAL'
    };
    return threatLevel ? mapping[threatLevel] : 'INFO';
  }
}
