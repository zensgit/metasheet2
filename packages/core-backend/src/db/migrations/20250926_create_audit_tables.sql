-- Comprehensive Audit Trail System
-- Tracks all system operations for compliance, security, and debugging

-- 1. Main Audit Log Table
CREATE TABLE audit_logs (
  id BIGSERIAL,

  -- Event Information
  event_id UUID DEFAULT gen_random_uuid(),
  event_type VARCHAR(100) NOT NULL, -- CREATE, READ, UPDATE, DELETE, LOGIN, LOGOUT, EXPORT, etc.
  event_category VARCHAR(50) NOT NULL, -- USER, SYSTEM, SECURITY, DATA, WORKFLOW, ADMIN
  event_severity VARCHAR(20) DEFAULT 'INFO', -- DEBUG, INFO, WARNING, ERROR, CRITICAL

  -- Resource Information
  resource_type VARCHAR(100), -- spreadsheet, workflow, user, role, etc.
  resource_id VARCHAR(255), -- ID of the affected resource
  resource_name VARCHAR(500), -- Human-readable name
  resource_path TEXT, -- Full path/hierarchy

  -- Action Details
  action VARCHAR(100) NOT NULL, -- Specific action performed
  action_details JSONB, -- Additional context

  -- User/Actor Information
  user_id INTEGER,
  user_name VARCHAR(255),
  user_email VARCHAR(255),
  user_roles TEXT[], -- Roles at time of action
  impersonated_by INTEGER, -- If action was performed via impersonation

  -- Session Information
  session_id VARCHAR(255),
  ip_address INET,
  user_agent TEXT,
  device_id VARCHAR(255),
  device_type VARCHAR(50), -- desktop, mobile, tablet, api

  -- Location Information
  geo_country VARCHAR(2), -- ISO country code
  geo_region VARCHAR(100),
  geo_city VARCHAR(100),
  geo_latitude DECIMAL(10, 8),
  geo_longitude DECIMAL(11, 8),

  -- Request Information
  request_id VARCHAR(100),
  request_method VARCHAR(10), -- GET, POST, PUT, DELETE, etc.
  request_path TEXT,
  request_query JSONB,
  request_body JSONB, -- Sanitized body (no sensitive data)
  request_headers JSONB, -- Sanitized headers

  -- Response Information
  response_status INTEGER,
  response_time_ms INTEGER,
  response_size_bytes BIGINT,

  -- Error Information
  error_code VARCHAR(100),
  error_message TEXT,
  error_stack TEXT,

  -- Compliance Fields
  compliance_flags TEXT[], -- GDPR, HIPAA, SOC2, etc.
  data_classification VARCHAR(50), -- PUBLIC, INTERNAL, CONFIDENTIAL, RESTRICTED
  retention_period INTEGER, -- Days to retain

  -- Metadata
  tags TEXT[],
  correlation_id VARCHAR(255), -- For tracking related events
  parent_event_id UUID, -- For hierarchical events

  -- Timestamps
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id, created_at)  -- Must include partition key created_at
) PARTITION BY RANGE (created_at);

-- Create monthly partitions for better performance
CREATE TABLE audit_logs_2025_01 PARTITION OF audit_logs
  FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');

CREATE TABLE audit_logs_2025_02 PARTITION OF audit_logs
  FOR VALUES FROM ('2025-02-01') TO ('2025-03-01');

CREATE TABLE audit_logs_2025_03 PARTITION OF audit_logs
  FOR VALUES FROM ('2025-03-01') TO ('2025-04-01');

-- Add more partitions as needed...

-- Add unique constraint for event_id including partition key (idempotent)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'audit_logs_event_id_key' AND conrelid = 'audit_logs'::regclass
  ) THEN
    ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_event_id_key UNIQUE (event_id, created_at);
  END IF;
END $$;

-- Note: Cannot add FK constraints to partitioned tables without including partition key
-- Child tables reference audit_logs(id) but this would require a unique constraint on (id, created_at)
-- For audit tables, referential integrity is maintained at application level

-- 2. Data Change Audit Table (for detailed field-level changes)
CREATE TABLE audit_data_changes (
  id BIGSERIAL PRIMARY KEY,
  audit_log_id BIGINT,

  -- Change Information
  table_name VARCHAR(255) NOT NULL,
  record_id VARCHAR(255) NOT NULL,
  operation VARCHAR(20) NOT NULL, -- INSERT, UPDATE, DELETE

  -- Field-level changes
  field_name VARCHAR(255),
  old_value JSONB,
  new_value JSONB,
  value_type VARCHAR(50), -- STRING, NUMBER, BOOLEAN, DATE, JSON, etc.

  -- Metadata
  change_reason TEXT,
  change_approved_by INTEGER,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP

);

-- 3. Security Events Table
CREATE TABLE audit_security_events (
  id BIGSERIAL PRIMARY KEY,
  audit_log_id BIGINT,

  -- Security Event Details
  security_event_type VARCHAR(100) NOT NULL, -- LOGIN_SUCCESS, LOGIN_FAILED, PERMISSION_DENIED, etc.
  threat_level VARCHAR(20), -- LOW, MEDIUM, HIGH, CRITICAL

  -- Authentication Details
  auth_method VARCHAR(50), -- PASSWORD, OAUTH, SSO, API_KEY, etc.
  auth_provider VARCHAR(100),
  mfa_used BOOLEAN DEFAULT false,

  -- Risk Assessment
  risk_score INTEGER, -- 0-100
  risk_factors JSONB, -- Suspicious patterns, unusual location, etc.

  -- Response Actions
  action_taken VARCHAR(100), -- BLOCKED, CHALLENGED, ALLOWED, LOGGED
  alert_sent BOOLEAN DEFAULT false,
  alert_recipients TEXT[],

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP

);

-- 4. Compliance Audit Table
CREATE TABLE audit_compliance (
  id BIGSERIAL PRIMARY KEY,
  audit_log_id BIGINT,

  -- Compliance Information
  regulation VARCHAR(50) NOT NULL, -- GDPR, CCPA, HIPAA, SOC2, etc.
  requirement VARCHAR(255), -- Specific requirement reference

  -- Data Subject Information
  data_subject_id VARCHAR(255),
  data_subject_type VARCHAR(50), -- USER, CUSTOMER, EMPLOYEE, etc.

  -- Purpose and Legal Basis
  processing_purpose TEXT,
  legal_basis VARCHAR(100), -- CONSENT, CONTRACT, LEGAL_OBLIGATION, etc.

  -- Consent Management
  consent_given BOOLEAN,
  consent_timestamp TIMESTAMP,
  consent_version VARCHAR(50),

  -- Data Handling
  data_categories TEXT[], -- Personal, sensitive, financial, etc.
  data_retention_days INTEGER,
  data_encrypted BOOLEAN DEFAULT true,
  data_anonymized BOOLEAN DEFAULT false,

  -- Cross-border Transfer
  data_transfer_country VARCHAR(2),
  transfer_mechanism VARCHAR(100), -- SCC, BCR, ADEQUACY, etc.

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP

);

-- 5. Performance Metrics Table
CREATE TABLE audit_performance (
  id BIGSERIAL PRIMARY KEY,
  audit_log_id BIGINT,

  -- Performance Metrics
  total_time_ms INTEGER,
  database_time_ms INTEGER,
  cache_time_ms INTEGER,
  external_api_time_ms INTEGER,

  -- Resource Usage
  cpu_usage_percent DECIMAL(5,2),
  memory_usage_mb INTEGER,
  disk_io_mb INTEGER,
  network_io_mb INTEGER,

  -- Database Metrics
  queries_executed INTEGER,
  rows_examined BIGINT,
  rows_affected BIGINT,

  -- Cache Metrics
  cache_hits INTEGER,
  cache_misses INTEGER,
  cache_hit_rate DECIMAL(5,2),

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP

);

-- 6. Export/Download Audit Table
CREATE TABLE audit_exports (
  id BIGSERIAL PRIMARY KEY,
  audit_log_id BIGINT,

  -- Export Details
  export_type VARCHAR(50) NOT NULL, -- CSV, EXCEL, PDF, JSON, etc.
  export_format VARCHAR(50),
  export_scope VARCHAR(50), -- FULL, PARTIAL, FILTERED

  -- Data Information
  records_exported INTEGER,
  file_size_bytes BIGINT,
  file_hash VARCHAR(64), -- SHA-256 hash

  -- Filters Applied
  filters_applied JSONB,
  columns_included TEXT[],

  -- Destination
  destination_type VARCHAR(50), -- DOWNLOAD, EMAIL, CLOUD, API
  destination_details JSONB,

  -- Compliance
  contains_pii BOOLEAN DEFAULT false,
  redactions_applied BOOLEAN DEFAULT false,
  watermark_applied BOOLEAN DEFAULT false,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP

);

-- 7. Audit Report Configuration
CREATE TABLE audit_report_configs (
  id SERIAL PRIMARY KEY,

  -- Report Information
  report_name VARCHAR(255) NOT NULL,
  report_type VARCHAR(50) NOT NULL, -- COMPLIANCE, SECURITY, ACTIVITY, CUSTOM
  description TEXT,

  -- Schedule
  is_scheduled BOOLEAN DEFAULT false,
  schedule_cron VARCHAR(100),
  next_run_at TIMESTAMP,

  -- Filters
  event_types TEXT[],
  event_categories TEXT[],
  resource_types TEXT[],
  severity_levels TEXT[],
  date_range_days INTEGER DEFAULT 30,

  -- Recipients
  email_recipients TEXT[],
  slack_channels TEXT[],
  webhook_urls TEXT[],

  -- Format
  output_format VARCHAR(20) DEFAULT 'PDF', -- PDF, CSV, EXCEL, HTML
  include_charts BOOLEAN DEFAULT true,

  -- Status
  is_active BOOLEAN DEFAULT true,
  last_run_at TIMESTAMP,
  last_run_status VARCHAR(50),

  created_by INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE(report_name)
);

-- 8. Audit Retention Policies
CREATE TABLE audit_retention_policies (
  id SERIAL PRIMARY KEY,

  -- Policy Information
  policy_name VARCHAR(255) NOT NULL UNIQUE,
  description TEXT,

  -- Criteria
  event_category VARCHAR(50),
  event_type VARCHAR(100),
  resource_type VARCHAR(100),
  severity_level VARCHAR(20),

  -- Retention Rules
  retention_days INTEGER NOT NULL,
  archive_after_days INTEGER, -- Move to cold storage
  delete_after_days INTEGER, -- Permanent deletion

  -- Compliance
  compliance_requirement VARCHAR(100),
  legal_hold BOOLEAN DEFAULT false,

  -- Status
  is_active BOOLEAN DEFAULT true,
  priority INTEGER DEFAULT 0, -- Higher priority policies apply first

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Views for common queries

-- Recent security events
CREATE VIEW v_recent_security_events AS
SELECT
  al.event_id,
  al.created_at,
  al.user_name,
  al.ip_address,
  se.security_event_type,
  se.threat_level,
  se.risk_score,
  se.action_taken
FROM audit_logs al
JOIN audit_security_events se ON al.id = se.audit_log_id
WHERE al.created_at > CURRENT_TIMESTAMP - INTERVAL '24 hours'
ORDER BY al.created_at DESC;

-- User activity summary
CREATE VIEW v_user_activity_summary AS
SELECT
  user_id,
  user_name,
  COUNT(*) as total_actions,
  COUNT(DISTINCT DATE(created_at)) as active_days,
  COUNT(DISTINCT resource_type) as resource_types_accessed,
  MAX(created_at) as last_activity
FROM audit_logs
WHERE created_at > CURRENT_TIMESTAMP - INTERVAL '30 days'
GROUP BY user_id, user_name;

-- Compliance overview
CREATE VIEW v_compliance_overview AS
SELECT
  regulation,
  COUNT(*) as total_events,
  COUNT(DISTINCT data_subject_id) as unique_subjects,
  SUM(CASE WHEN consent_given THEN 1 ELSE 0 END) as consents_given,
  AVG(data_retention_days) as avg_retention_days
FROM audit_compliance
WHERE created_at > CURRENT_TIMESTAMP - INTERVAL '90 days'
GROUP BY regulation;

-- Functions

-- Function to automatically create new partitions
CREATE OR REPLACE FUNCTION create_audit_partition()
RETURNS void AS $$
DECLARE
  partition_date DATE;
  partition_name TEXT;
  start_date DATE;
  end_date DATE;
BEGIN
  partition_date = DATE_TRUNC('month', CURRENT_DATE + INTERVAL '1 month');
  partition_name = 'audit_logs_' || TO_CHAR(partition_date, 'YYYY_MM');
  start_date = partition_date;
  end_date = partition_date + INTERVAL '1 month';

  -- Check if partition exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE tablename = partition_name
  ) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF audit_logs FOR VALUES FROM (%L) TO (%L)',
      partition_name, start_date, end_date
    );
    RAISE NOTICE 'Created partition %', partition_name;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Function to archive old audit logs
CREATE OR REPLACE FUNCTION archive_old_audit_logs()
RETURNS INTEGER AS $$
DECLARE
  archived_count INTEGER;
BEGIN
  -- Move old logs to archive table based on retention policies
  WITH archived AS (
    INSERT INTO audit_logs_archive
    SELECT * FROM audit_logs
    WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '90 days'
    AND NOT EXISTS (
      SELECT 1 FROM audit_retention_policies
      WHERE (event_category IS NULL OR event_category = audit_logs.event_category)
        AND (event_type IS NULL OR event_type = audit_logs.event_type)
        AND legal_hold = true
    )
    RETURNING id
  )
  SELECT COUNT(*) INTO archived_count FROM archived;

  -- Delete archived records from main table
  DELETE FROM audit_logs
  WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '90 days'
  AND id IN (SELECT id FROM audit_logs_archive);

  RETURN archived_count;
END;
$$ LANGUAGE plpgsql;

-- Trigger to set retention period based on policies
CREATE OR REPLACE FUNCTION set_retention_period()
RETURNS TRIGGER AS $$
BEGIN
  -- Find matching retention policy
  SELECT retention_days INTO NEW.retention_period
  FROM audit_retention_policies
  WHERE is_active = true
    AND (event_category IS NULL OR event_category = NEW.event_category)
    AND (event_type IS NULL OR event_type = NEW.event_type)
    AND (resource_type IS NULL OR resource_type = NEW.resource_type)
  ORDER BY priority DESC
  LIMIT 1;

  -- Default retention if no policy matches
  IF NEW.retention_period IS NULL THEN
    NEW.retention_period = 90; -- Default 90 days
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_set_retention
BEFORE INSERT ON audit_logs
FOR EACH ROW
EXECUTE FUNCTION set_retention_period();

-- Indexes for performance (create separately, not inline)
-- Indexes for audit_logs
CREATE INDEX IF NOT EXISTS idx_audit_logs_event_type ON audit_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_event_category ON audit_logs(event_category);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_session ON audit_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_correlation ON audit_logs(correlation_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_severity ON audit_logs(event_severity);
CREATE INDEX IF NOT EXISTS idx_audit_logs_composite ON audit_logs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource_composite ON audit_logs(resource_type, resource_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_session_time ON audit_logs(session_id, created_at DESC);

-- Indexes for audit_data_changes
CREATE INDEX IF NOT EXISTS idx_audit_data_changes_log ON audit_data_changes(audit_log_id);
CREATE INDEX IF NOT EXISTS idx_audit_data_changes_table ON audit_data_changes(table_name, record_id);
CREATE INDEX IF NOT EXISTS idx_audit_data_changes_created ON audit_data_changes(created_at DESC);

-- Indexes for audit_security_events
CREATE INDEX IF NOT EXISTS idx_audit_security_events_log ON audit_security_events(audit_log_id);
CREATE INDEX IF NOT EXISTS idx_audit_security_events_type ON audit_security_events(security_event_type);
CREATE INDEX IF NOT EXISTS idx_audit_security_events_threat ON audit_security_events(threat_level);

-- Indexes for audit_compliance
CREATE INDEX IF NOT EXISTS idx_audit_compliance_log ON audit_compliance(audit_log_id);
CREATE INDEX IF NOT EXISTS idx_audit_compliance_regulation ON audit_compliance(regulation);
CREATE INDEX IF NOT EXISTS idx_audit_compliance_subject ON audit_compliance(data_subject_id);

-- Indexes for audit_performance
CREATE INDEX IF NOT EXISTS idx_audit_performance_log ON audit_performance(audit_log_id);
CREATE INDEX IF NOT EXISTS idx_audit_performance_time ON audit_performance(total_time_ms);

-- Indexes for audit_exports
CREATE INDEX IF NOT EXISTS idx_audit_exports_log ON audit_exports(audit_log_id);
CREATE INDEX IF NOT EXISTS idx_audit_exports_type ON audit_exports(export_type);

-- Archive table (same structure as audit_logs)
CREATE TABLE audit_logs_archive (LIKE audit_logs INCLUDING ALL);

-- Grant appropriate permissions (conditional on role existence)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'readonly_role') THEN
    GRANT SELECT ON audit_logs TO readonly_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'application_role') THEN
    GRANT INSERT ON audit_logs TO application_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin_role') THEN
    GRANT ALL ON audit_logs TO admin_role;
  END IF;
END $$;