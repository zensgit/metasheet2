# Audit Trail System Documentation

## Overview

The Audit Trail System provides comprehensive logging and tracking of all system operations for compliance, security monitoring, and debugging purposes. It captures detailed information about user actions, system events, data changes, and security incidents.

## Architecture

### Components

1. **AuditRepository** - Data access layer for audit logs
2. **AuditService** - Business logic and API for audit operations
3. **AuditInterceptor** - Automatic database query interception
4. **Audit API Routes** - REST endpoints for querying and managing logs
5. **Database Schema** - PostgreSQL tables with partitioning

### Database Design

#### Main Tables

- **audit_logs** - Core audit log entries (partitioned by month)
- **audit_data_changes** - Field-level change tracking
- **audit_security_events** - Security-specific events
- **audit_compliance** - Compliance and regulatory tracking
- **audit_performance** - Performance metrics
- **audit_exports** - Export and download tracking
- **audit_report_configs** - Scheduled report configurations
- **audit_retention_policies** - Data retention rules

#### Partitioning Strategy

```sql
-- Monthly partitions for performance
CREATE TABLE audit_logs_2025_01 PARTITION OF audit_logs
  FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
```

## Features

### 1. Automatic Request Logging

```typescript
// Express middleware for automatic audit
app.use(auditService.middleware({
  skipLogging: false,
  sensitiveFields: ['password', 'token'],
  complianceFlags: ['GDPR', 'SOC2']
}));
```

### 2. Data Change Tracking

```typescript
// Log field-level changes
await auditService.logDataChange(
  'users',
  '123',
  'UPDATE',
  [
    { field: 'email', oldValue: 'old@example.com', newValue: 'new@example.com' },
    { field: 'role', oldValue: 'user', newValue: 'admin' }
  ]
);
```

### 3. Security Event Monitoring

```typescript
// Log authentication attempts
await auditService.logAuthAttempt(
  false, // success
  'password', // method
  {
    threatLevel: 'MEDIUM',
    riskScore: 75,
    actionTaken: 'BLOCKED'
  }
);
```

### 4. Compliance Tracking

```typescript
// Log GDPR compliance events
await auditService.logComplianceEvent('GDPR', {
  requirement: 'Article 17',
  dataSubjectId: 'user_123',
  processingPurpose: 'Right to erasure',
  legalBasis: 'USER_REQUEST'
});
```

### 5. Performance Monitoring

```typescript
// Track operation performance
auditService.startPerformanceTracking('data_export');
// ... perform operation
await auditService.endPerformanceTracking('data_export', {
  resourceType: 'spreadsheet',
  responseTimeMs: 1234
});
```

## API Endpoints

### Query Audit Logs

```http
GET /api/audit/logs?eventType=UPDATE&userId=123&limit=50
```

**Query Parameters:**
- `eventType` - Filter by event type (CREATE, UPDATE, DELETE, etc.)
- `eventCategory` - Filter by category (USER, SYSTEM, SECURITY, DATA)
- `resourceType` - Filter by resource type
- `resourceId` - Filter by resource ID
- `userId` - Filter by user ID
- `startDate` - Start date for date range
- `endDate` - End date for date range
- `severity` - Filter by severity (INFO, WARNING, ERROR, CRITICAL)
- `limit` - Maximum results (default: 100)
- `offset` - Pagination offset

### User Activity Summary

```http
GET /api/audit/users/123/activity?days=30
```

**Response:**
```json
{
  "total_actions": 1523,
  "active_days": 25,
  "resource_types_accessed": 8,
  "last_activity": "2025-09-26T10:30:00Z",
  "total_sessions": 45,
  "avg_response_time": 234
}
```

### Security Events Summary

```http
GET /api/audit/security/summary?days=7
```

### Export Audit Logs

```http
POST /api/audit/export
{
  "format": "csv",
  "filters": {
    "eventCategory": "SECURITY",
    "startDate": "2025-09-01"
  }
}
```

### Archive Old Logs

```http
POST /api/audit/archive
{
  "daysToKeep": 90
}
```

## Decorators

### @Audited Decorator

```typescript
class UserService {
  @Audited('USER_UPDATE', 'USER')
  async updateUser(id: string, data: any) {
    // Method automatically logged
  }
}
```

### @Compliant Decorator

```typescript
class DataService {
  @Compliant('GDPR', 'Article 17')
  async deleteUserData(userId: string) {
    // Compliance automatically tracked
  }
}
```

## Database Query Interception

```typescript
// Enable automatic database audit
enableAuditInterceptor(pool, auditService, {
  enabledTables: ['users', 'spreadsheets', 'workflows'],
  excludedOperations: ['SELECT']
});
```

## Event Categories

- **USER** - User-initiated actions
- **SYSTEM** - System automated processes
- **SECURITY** - Security-related events
- **DATA** - Data manipulation events
- **WORKFLOW** - Workflow execution events
- **ADMIN** - Administrative actions
- **COMPLIANCE** - Compliance-related events

## Event Severity Levels

- **DEBUG** - Detailed debugging information
- **INFO** - Informational messages
- **WARNING** - Warning messages
- **ERROR** - Error events
- **CRITICAL** - Critical system failures

## Security Event Types

- `LOGIN_SUCCESS` - Successful authentication
- `LOGIN_FAILED` - Failed authentication attempt
- `LOGOUT` - User logout
- `PERMISSION_DENIED` - Access denied
- `PERMISSION_GRANTED` - Access granted
- `PASSWORD_RESET` - Password reset request
- `MFA_ENABLED` - Multi-factor auth enabled
- `SUSPICIOUS_ACTIVITY` - Anomaly detected

## Compliance Regulations

- **GDPR** - General Data Protection Regulation
- **CCPA** - California Consumer Privacy Act
- **HIPAA** - Health Insurance Portability Act
- **SOC2** - Service Organization Control 2
- **PCI-DSS** - Payment Card Industry Standard

## Retention Policies

### Default Retention

- Standard logs: 90 days
- Security events: 180 days
- Compliance logs: 7 years
- Performance metrics: 30 days

### Custom Policies

```sql
INSERT INTO audit_retention_policies (
  policy_name,
  event_category,
  retention_days,
  archive_after_days
) VALUES (
  'security_critical',
  'SECURITY',
  365,
  90
);
```

## Performance Optimization

### Indexing Strategy

```sql
-- Composite indexes for common queries
CREATE INDEX idx_audit_logs_user_time 
  ON audit_logs(user_id, created_at DESC);

CREATE INDEX idx_audit_logs_resource_time 
  ON audit_logs(resource_type, resource_id, created_at DESC);
```

### Partitioning Benefits

- Faster queries on recent data
- Efficient archival of old partitions
- Reduced index maintenance overhead
- Parallel query execution

## Monitoring and Alerts

### Event Listeners

```typescript
auditService.on('securityAlert', (alert) => {
  // Send notification
  notificationService.send({
    type: 'SECURITY_ALERT',
    severity: alert.threatLevel,
    recipients: alert.recipients
  });
});

auditService.on('error', (error) => {
  // Handle audit failures
  logger.error('Audit system error:', error);
});
```

### Scheduled Reports

```sql
-- Create weekly security report
INSERT INTO audit_report_configs (
  report_name,
  report_type,
  schedule_cron,
  event_categories,
  email_recipients
) VALUES (
  'Weekly Security Report',
  'SECURITY',
  '0 0 * * MON',
  ARRAY['SECURITY'],
  ARRAY['security@company.com']
);
```

## Best Practices

### 1. Sensitive Data Handling

- Automatically redact passwords, tokens, and keys
- Use field-level encryption for PII
- Apply data classification tags

### 2. Performance Considerations

- Use batch inserts for bulk operations
- Implement async logging to avoid blocking
- Archive old data regularly

### 3. Compliance Requirements

- Enable legal hold for litigation
- Maintain chain of custody
- Implement tamper detection

### 4. Error Handling

- Never let audit failures break operations
- Use fallback logging mechanisms
- Monitor audit system health

## Integration Examples

### With Authentication System

```typescript
class AuthController {
  async login(req: Request, res: Response) {
    const success = await authenticate(req.body);
    
    // Log authentication attempt
    await auditService.logAuthAttempt(
      success,
      'password',
      {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent']
      }
    );
    
    if (!success) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    // ...
  }
}
```

### With Data Export

```typescript
class ExportService {
  async exportSpreadsheet(id: string, format: string) {
    // Log export event
    const auditId = await auditService.logEvent(
      'EXPORT',
      'Export spreadsheet',
      {
        resourceType: 'spreadsheet',
        resourceId: id,
        actionDetails: { format }
      }
    );
    
    // Perform export
    const data = await performExport(id, format);
    
    // Log export details
    await auditService.repository.logExport(auditId, {
      export_type: format,
      records_exported: data.recordCount,
      file_size_bytes: data.size
    });
    
    return data;
  }
}
```

## Troubleshooting

### Common Issues

1. **High storage usage**
   - Solution: Implement aggressive archival policies
   - Use compression for archived data

2. **Slow queries**
   - Solution: Add appropriate indexes
   - Query specific partitions when possible

3. **Missing audit logs**
   - Check retention policies
   - Verify audit middleware is enabled
   - Check for errors in audit service

## Future Enhancements

1. **Machine Learning Integration**
   - Anomaly detection
   - Predictive threat analysis
   - User behavior analytics

2. **Real-time Streaming**
   - Kafka integration for event streaming
   - Real-time dashboards
   - Instant alert notifications

3. **Advanced Analytics**
   - Custom report builder
   - Trend analysis
   - Compliance scoring

4. **External Integration**
   - SIEM system integration
   - Cloud logging services
   - Third-party compliance tools