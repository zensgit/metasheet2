import type { Pool } from 'pg';
import { query, pool } from '../db/pg';

export interface AuditLogData {
  eventType: string;
  eventCategory: string;
  eventSeverity?: string;
  resourceType?: string;
  resourceId?: string;
  resourceName?: string;
  resourcePath?: string;
  action: string;
  actionDetails?: Record<string, unknown>;
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
  requestQuery?: Record<string, unknown>;
  requestBody?: Record<string, unknown>;
  requestHeaders?: Record<string, unknown>;
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
  oldValue?: unknown;
  newValue?: unknown;
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
  riskFactors?: Record<string, unknown>;
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

export interface AuditLogQueryFilters {
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
}

export interface UserActivitySummary {
  total_actions: string;
  active_days: string;
  resource_types_accessed: string;
  last_activity: Date | null;
  total_sessions: string;
  avg_response_time: string | null;
}

export interface SecurityEventSummary {
  security_event_type: string;
  threat_level: string | null;
  count: string;
  last_occurrence: Date;
}

/**
 * Represents a row from the audit_logs table
 */
export interface AuditLogRow {
  id: number;
  event_type: string;
  event_category: string;
  event_severity: string;
  resource_type: string | null;
  resource_id: string | null;
  resource_name: string | null;
  resource_path: string | null;
  action: string;
  action_details: Record<string, unknown> | null;
  user_id: number | null;
  user_name: string | null;
  user_email: string | null;
  user_roles: string[] | null;
  impersonated_by: number | null;
  session_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  device_id: string | null;
  device_type: string | null;
  geo_country: string | null;
  geo_region: string | null;
  geo_city: string | null;
  geo_latitude: number | null;
  geo_longitude: number | null;
  request_id: string | null;
  request_method: string | null;
  request_path: string | null;
  request_query: Record<string, unknown> | null;
  request_body: Record<string, unknown> | null;
  request_headers: Record<string, unknown> | null;
  response_status: number | null;
  response_time_ms: number | null;
  response_size_bytes: number | null;
  error_code: string | null;
  error_message: string | null;
  error_stack: string | null;
  compliance_flags: string[] | null;
  data_classification: string | null;
  retention_period: number | null;
  tags: string[] | null;
  correlation_id: string | null;
  parent_event_id: string | null;
  created_at: Date;
  updated_at: Date;
}

type QueryValue = string | number | boolean | Date | string[] | null | undefined;

export class AuditRepository {
  constructor(private dbPool: Pool = pool!) {
    if (!this.dbPool) {
      throw new Error('Database pool not initialized');
    }
  }

  /**
   * Create main audit log entry
   */
  async createAuditLog(data: AuditLogData): Promise<number> {
    const sql = `
      INSERT INTO audit_logs (
        event_type, event_category, event_severity,
        resource_type, resource_id, resource_name, resource_path,
        action, action_details,
        user_id, user_name, user_email, user_roles, impersonated_by,
        session_id, ip_address, user_agent, device_id, device_type,
        geo_country, geo_region, geo_city, geo_latitude, geo_longitude,
        request_id, request_method, request_path, request_query, request_body, request_headers,
        response_status, response_time_ms, response_size_bytes,
        error_code, error_message, error_stack,
        compliance_flags, data_classification, retention_period,
        tags, correlation_id, parent_event_id
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19,
        $20, $21, $22, $23, $24, $25, $26, $27, $28, $29,
        $30, $31, $32, $33, $34, $35, $36, $37, $38, $39,
        $40, $41
      ) RETURNING id
    `;

    const values: QueryValue[] = [
      data.eventType,
      data.eventCategory,
      data.eventSeverity || 'INFO',
      data.resourceType,
      data.resourceId,
      data.resourceName,
      data.resourcePath,
      data.action,
      data.actionDetails ? JSON.stringify(data.actionDetails) : null,
      data.userId,
      data.userName,
      data.userEmail,
      data.userRoles,
      data.impersonatedBy,
      data.sessionId,
      data.ipAddress,
      data.userAgent,
      data.deviceId,
      data.deviceType,
      data.geoCountry,
      data.geoRegion,
      data.geoCity,
      data.geoLatitude,
      data.geoLongitude,
      data.requestId,
      data.requestMethod,
      data.requestPath,
      data.requestQuery ? JSON.stringify(data.requestQuery) : null,
      data.requestBody ? JSON.stringify(data.requestBody) : null,
      data.requestHeaders ? JSON.stringify(data.requestHeaders) : null,
      data.responseStatus,
      data.responseTimeMs,
      data.responseSizeBytes,
      data.errorCode,
      data.errorMessage,
      data.errorStack,
      data.complianceFlags,
      data.dataClassification,
      data.retentionPeriod,
      data.tags,
      data.correlationId,
      data.parentEventId
    ];

    const result = await query<{ id: number }>(sql, values);
    return result.rows[0].id;
  }

  /**
   * Log data changes with field-level tracking
   */
  async logDataChanges(
    auditLogId: number,
    changes: DataChangeData[]
  ): Promise<void> {
    if (changes.length === 0) return;

    const sql = `
      INSERT INTO audit_data_changes (
        audit_log_id, table_name, record_id, operation,
        field_name, old_value, new_value, value_type,
        change_reason, change_approved_by
      ) VALUES
    `;

    const values: QueryValue[] = [];
    const placeholders: string[] = [];
    let paramIndex = 1;

    for (const change of changes) {
      placeholders.push(
        `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++},
          $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++},
          $${paramIndex++}, $${paramIndex++})`
      );

      values.push(
        auditLogId,
        change.tableName,
        change.recordId,
        change.operation,
        change.fieldName,
        change.oldValue !== undefined ? JSON.stringify(change.oldValue) : null,
        change.newValue !== undefined ? JSON.stringify(change.newValue) : null,
        change.valueType,
        change.changeReason,
        change.changeApprovedBy
      );
    }

    await query(sql + placeholders.join(', '), values);
  }

  /**
   * Log security events
   */
  async logSecurityEvent(
    auditLogId: number,
    data: SecurityEventData
  ): Promise<void> {
    const sql = `
      INSERT INTO audit_security_events (
        audit_log_id, security_event_type, threat_level,
        auth_method, auth_provider, mfa_used,
        risk_score, risk_factors,
        action_taken, alert_sent, alert_recipients
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `;

    const values: QueryValue[] = [
      auditLogId,
      data.securityEventType,
      data.threatLevel,
      data.authMethod,
      data.authProvider,
      data.mfaUsed,
      data.riskScore,
      data.riskFactors ? JSON.stringify(data.riskFactors) : null,
      data.actionTaken,
      data.alertSent,
      data.alertRecipients
    ];

    await query(sql, values);
  }

  /**
   * Log compliance-related events
   */
  async logComplianceEvent(
    auditLogId: number,
    data: ComplianceData
  ): Promise<void> {
    const sql = `
      INSERT INTO audit_compliance (
        audit_log_id, regulation, requirement,
        data_subject_id, data_subject_type,
        processing_purpose, legal_basis,
        consent_given, consent_timestamp, consent_version,
        data_categories, data_retention_days, data_encrypted, data_anonymized,
        data_transfer_country, transfer_mechanism
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16
      )
    `;

    const values: QueryValue[] = [
      auditLogId,
      data.regulation,
      data.requirement,
      data.dataSubjectId,
      data.dataSubjectType,
      data.processingPurpose,
      data.legalBasis,
      data.consentGiven,
      data.consentTimestamp,
      data.consentVersion,
      data.dataCategories,
      data.dataRetentionDays,
      data.dataEncrypted,
      data.dataAnonymized,
      data.dataTransferCountry,
      data.transferMechanism
    ];

    await query(sql, values);
  }

  /**
   * Query audit logs with filters
   */
  async queryAuditLogs(filters: AuditLogQueryFilters): Promise<AuditLogRow[]> {
    let sql = 'SELECT * FROM audit_logs WHERE 1=1';
    const values: QueryValue[] = [];
    let paramIndex = 1;

    if (filters.eventType) {
      sql += ` AND event_type = $${paramIndex++}`;
      values.push(filters.eventType);
    }

    if (filters.eventCategory) {
      sql += ` AND event_category = $${paramIndex++}`;
      values.push(filters.eventCategory);
    }

    if (filters.resourceType) {
      sql += ` AND resource_type = $${paramIndex++}`;
      values.push(filters.resourceType);
    }

    if (filters.resourceId) {
      sql += ` AND resource_id = $${paramIndex++}`;
      values.push(filters.resourceId);
    }

    if (filters.userId) {
      sql += ` AND user_id = $${paramIndex++}`;
      values.push(filters.userId);
    }

    if (filters.startDate) {
      sql += ` AND created_at >= $${paramIndex++}`;
      values.push(filters.startDate);
    }

    if (filters.endDate) {
      sql += ` AND created_at <= $${paramIndex++}`;
      values.push(filters.endDate);
    }

    if (filters.severity) {
      sql += ` AND event_severity = $${paramIndex++}`;
      values.push(filters.severity);
    }

    sql += ' ORDER BY created_at DESC';

    if (filters.limit) {
      sql += ` LIMIT $${paramIndex++}`;
      values.push(filters.limit);
    }

    if (filters.offset) {
      sql += ` OFFSET $${paramIndex++}`;
      values.push(filters.offset);
    }

    const result = await query<AuditLogRow>(sql, values);
    return result.rows;
  }

  /**
   * Get user activity summary
   */
  async getUserActivitySummary(
    userId: number,
    days: number = 30
  ): Promise<UserActivitySummary> {
    const sql = `
      SELECT
        COUNT(*) as total_actions,
        COUNT(DISTINCT DATE(created_at)) as active_days,
        COUNT(DISTINCT resource_type) as resource_types_accessed,
        MAX(created_at) as last_activity,
        COUNT(DISTINCT session_id) as total_sessions,
        AVG(response_time_ms) as avg_response_time
      FROM audit_logs
      WHERE user_id = $1
        AND created_at > CURRENT_TIMESTAMP - INTERVAL '${days} days'
    `;

    const result = await query<UserActivitySummary>(sql, [userId]);
    return result.rows[0];
  }

  /**
   * Get security events summary
   */
  async getSecurityEventsSummary(days: number = 7): Promise<SecurityEventSummary[]> {
    const sql = `
      SELECT
        se.security_event_type,
        se.threat_level,
        COUNT(*) as count,
        MAX(al.created_at) as last_occurrence
      FROM audit_security_events se
      JOIN audit_logs al ON se.audit_log_id = al.id
      WHERE al.created_at > CURRENT_TIMESTAMP - INTERVAL '${days} days'
      GROUP BY se.security_event_type, se.threat_level
      ORDER BY count DESC
    `;

    const result = await query<SecurityEventSummary>(sql);
    return result.rows;
  }

  /**
   * Archive old audit logs
   */
  async archiveOldLogs(daysToKeep: number = 90): Promise<number> {
    const sql = `
      WITH archived AS (
        INSERT INTO audit_logs_archive
        SELECT * FROM audit_logs
        WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '${daysToKeep} days'
        AND NOT EXISTS (
          SELECT 1 FROM audit_retention_policies
          WHERE (event_category IS NULL OR event_category = audit_logs.event_category)
            AND (event_type IS NULL OR event_type = audit_logs.event_type)
            AND legal_hold = true
        )
        RETURNING id
      )
      DELETE FROM audit_logs
      WHERE id IN (SELECT id FROM archived)
      RETURNING id
    `;

    const result = await query(sql);
    return result.rowCount || 0;
  }

  /**
   * Create new partition for next month
   */
  async createMonthlyPartition(): Promise<void> {
    await query('SELECT create_audit_partition()');
  }
}
