import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGSERIAL,
      event_id UUID DEFAULT gen_random_uuid(),
      event_type VARCHAR(100) NOT NULL,
      event_category VARCHAR(50) NOT NULL,
      event_severity VARCHAR(20) DEFAULT 'INFO',
      resource_type VARCHAR(100),
      resource_id VARCHAR(255),
      resource_name VARCHAR(500),
      resource_path TEXT,
      action VARCHAR(100) NOT NULL,
      action_details JSONB,
      user_id INTEGER,
      user_name VARCHAR(255),
      user_email VARCHAR(255),
      user_roles TEXT[],
      impersonated_by INTEGER,
      session_id VARCHAR(255),
      ip_address INET,
      user_agent TEXT,
      device_id VARCHAR(255),
      device_type VARCHAR(50),
      geo_country VARCHAR(2),
      geo_region VARCHAR(100),
      geo_city VARCHAR(100),
      geo_latitude DECIMAL(10, 8),
      geo_longitude DECIMAL(11, 8),
      request_id VARCHAR(100),
      request_method VARCHAR(10),
      request_path TEXT,
      request_query JSONB,
      request_body JSONB,
      request_headers JSONB,
      response_status INTEGER,
      response_time_ms INTEGER,
      response_size_bytes BIGINT,
      error_code VARCHAR(100),
      error_message TEXT,
      error_stack TEXT,
      compliance_flags TEXT[],
      data_classification VARCHAR(50),
      retention_period INTEGER,
      tags TEXT[],
      correlation_id VARCHAR(255),
      parent_event_id UUID,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id, created_at)
    ) PARTITION BY RANGE (created_at);
  `.execute(db)

  await sql`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'audit_logs_event_id_key' AND conrelid = 'audit_logs'::regclass
      ) THEN
        ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_event_id_key UNIQUE (event_id, created_at);
      END IF;
    END $$;
  `.execute(db)

  await sql`
    DO $$
    DECLARE
      partition_date DATE;
      partition_name TEXT;
      start_date DATE;
      end_date DATE;
    BEGIN
      partition_date := DATE_TRUNC('month', CURRENT_DATE);
      partition_name := 'audit_logs_' || TO_CHAR(partition_date, 'YYYY_MM');
      start_date := partition_date;
      end_date := partition_date + INTERVAL '1 month';
      IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = partition_name) THEN
        EXECUTE format(
          'CREATE TABLE %I PARTITION OF audit_logs FOR VALUES FROM (%L) TO (%L)',
          partition_name, start_date, end_date
        );
      END IF;
    END $$;
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS audit_data_changes (
      id BIGSERIAL PRIMARY KEY,
      audit_log_id BIGINT,
      table_name VARCHAR(255) NOT NULL,
      record_id VARCHAR(255) NOT NULL,
      operation VARCHAR(20) NOT NULL,
      field_name VARCHAR(255),
      old_value JSONB,
      new_value JSONB,
      value_type VARCHAR(50),
      change_reason TEXT,
      change_approved_by INTEGER,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS audit_security_events (
      id BIGSERIAL PRIMARY KEY,
      audit_log_id BIGINT,
      security_event_type VARCHAR(100) NOT NULL,
      threat_level VARCHAR(20),
      auth_method VARCHAR(50),
      auth_provider VARCHAR(100),
      mfa_used BOOLEAN DEFAULT false,
      risk_score INTEGER,
      risk_factors JSONB,
      action_taken VARCHAR(100),
      alert_sent BOOLEAN DEFAULT false,
      alert_recipients TEXT[],
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS audit_compliance (
      id BIGSERIAL PRIMARY KEY,
      audit_log_id BIGINT,
      regulation VARCHAR(50) NOT NULL,
      requirement VARCHAR(255),
      data_subject_id VARCHAR(255),
      data_subject_type VARCHAR(50),
      processing_purpose TEXT,
      legal_basis VARCHAR(100),
      consent_given BOOLEAN,
      consent_timestamp TIMESTAMPTZ,
      consent_version VARCHAR(50),
      data_categories TEXT[],
      data_retention_days INTEGER,
      data_encrypted BOOLEAN DEFAULT true,
      data_anonymized BOOLEAN DEFAULT false,
      data_transfer_country VARCHAR(2),
      transfer_mechanism VARCHAR(100),
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS audit_performance (
      id BIGSERIAL PRIMARY KEY,
      audit_log_id BIGINT,
      total_time_ms INTEGER,
      database_time_ms INTEGER,
      cache_time_ms INTEGER,
      external_api_time_ms INTEGER,
      cpu_usage_percent DECIMAL(5,2),
      memory_usage_mb INTEGER,
      disk_io_mb INTEGER,
      network_io_mb INTEGER,
      queries_executed INTEGER,
      rows_examined BIGINT,
      rows_affected BIGINT,
      cache_hits INTEGER,
      cache_misses INTEGER,
      cache_hit_rate DECIMAL(5,2),
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS audit_exports (
      id BIGSERIAL PRIMARY KEY,
      audit_log_id BIGINT,
      export_type VARCHAR(50) NOT NULL,
      export_format VARCHAR(50),
      export_scope VARCHAR(50),
      records_exported INTEGER,
      file_size_bytes BIGINT,
      file_hash VARCHAR(64),
      filters_applied JSONB,
      columns_included TEXT[],
      destination_type VARCHAR(50),
      destination_details JSONB,
      contains_pii BOOLEAN DEFAULT false,
      redactions_applied BOOLEAN DEFAULT false,
      watermark_applied BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS audit_report_configs (
      id SERIAL PRIMARY KEY,
      report_name VARCHAR(255) NOT NULL,
      report_type VARCHAR(50) NOT NULL,
      description TEXT,
      is_scheduled BOOLEAN DEFAULT false,
      schedule_cron VARCHAR(100),
      next_run_at TIMESTAMPTZ,
      event_types TEXT[],
      event_categories TEXT[],
      resource_types TEXT[],
      severity_levels TEXT[],
      date_range_days INTEGER DEFAULT 30,
      email_recipients TEXT[],
      slack_channels TEXT[],
      webhook_urls TEXT[],
      output_format VARCHAR(20) DEFAULT 'PDF',
      include_charts BOOLEAN DEFAULT true,
      is_active BOOLEAN DEFAULT true,
      last_run_at TIMESTAMPTZ,
      last_run_status VARCHAR(50),
      created_by INTEGER,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(report_name)
    );
  `.execute(db)

  await sql`
    CREATE TABLE IF NOT EXISTS audit_retention_policies (
      id SERIAL PRIMARY KEY,
      policy_name VARCHAR(255) NOT NULL UNIQUE,
      description TEXT,
      event_category VARCHAR(50),
      event_type VARCHAR(100),
      resource_type VARCHAR(100),
      severity_level VARCHAR(20),
      retention_days INTEGER NOT NULL,
      archive_after_days INTEGER,
      delete_after_days INTEGER,
      compliance_requirement VARCHAR(100),
      legal_hold BOOLEAN DEFAULT false,
      is_active BOOLEAN DEFAULT true,
      priority INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );
  `.execute(db)

  await sql`CREATE TABLE IF NOT EXISTS audit_logs_archive (LIKE audit_logs INCLUDING ALL);`.execute(db)

  await sql`
    CREATE OR REPLACE VIEW v_recent_security_events AS
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
  `.execute(db)

  await sql`
    CREATE OR REPLACE VIEW v_user_activity_summary AS
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
  `.execute(db)

  await sql`
    CREATE OR REPLACE VIEW v_compliance_overview AS
    SELECT
      regulation,
      COUNT(*) as total_events,
      COUNT(DISTINCT data_subject_id) as unique_subjects,
      SUM(CASE WHEN consent_given THEN 1 ELSE 0 END) as consents_given,
      AVG(data_retention_days) as avg_retention_days
    FROM audit_compliance
    WHERE created_at > CURRENT_TIMESTAMP - INTERVAL '90 days'
    GROUP BY regulation;
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION create_audit_partition()
    RETURNS void AS $$
    DECLARE
      partition_date DATE;
      partition_name TEXT;
      start_date DATE;
      end_date DATE;
    BEGIN
      partition_date := DATE_TRUNC('month', CURRENT_DATE + INTERVAL '1 month');
      partition_name := 'audit_logs_' || TO_CHAR(partition_date, 'YYYY_MM');
      start_date := partition_date;
      end_date := partition_date + INTERVAL '1 month';
      IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = partition_name) THEN
        EXECUTE format(
          'CREATE TABLE %I PARTITION OF audit_logs FOR VALUES FROM (%L) TO (%L)',
          partition_name, start_date, end_date
        );
      END IF;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION archive_old_audit_logs()
    RETURNS INTEGER AS $$
    DECLARE
      archived_count INTEGER;
    BEGIN
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

      DELETE FROM audit_logs
      WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '90 days'
      AND id IN (SELECT id FROM audit_logs_archive);

      RETURN archived_count;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db)

  await sql`
    CREATE OR REPLACE FUNCTION set_retention_period()
    RETURNS TRIGGER AS $$
    BEGIN
      SELECT retention_days INTO NEW.retention_period
      FROM audit_retention_policies
      WHERE is_active = true
        AND (event_category IS NULL OR event_category = NEW.event_category)
        AND (event_type IS NULL OR event_type = NEW.event_type)
        AND (resource_type IS NULL OR resource_type = NEW.resource_type)
      ORDER BY priority DESC
      LIMIT 1;

      IF NEW.retention_period IS NULL THEN
        NEW.retention_period = 90;
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db)

  await sql`DROP TRIGGER IF EXISTS trigger_set_retention ON audit_logs;`.execute(db)
  await sql`
    CREATE TRIGGER trigger_set_retention
    BEFORE INSERT ON audit_logs
    FOR EACH ROW
    EXECUTE FUNCTION set_retention_period();
  `.execute(db)

  await sql`CREATE INDEX IF NOT EXISTS idx_audit_logs_event_type ON audit_logs(event_type);`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_logs_event_category ON audit_logs(event_category);`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource_type, resource_id);`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_logs_session ON audit_logs(session_id);`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_logs_correlation ON audit_logs(correlation_id);`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_logs_severity ON audit_logs(event_severity);`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_logs_composite ON audit_logs(user_id, created_at DESC);`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_logs_resource_composite ON audit_logs(resource_type, resource_id, created_at DESC);`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_logs_session_time ON audit_logs(session_id, created_at DESC);`.execute(db)

  await sql`CREATE INDEX IF NOT EXISTS idx_audit_data_changes_log ON audit_data_changes(audit_log_id);`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_data_changes_table ON audit_data_changes(table_name, record_id);`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_data_changes_created ON audit_data_changes(created_at DESC);`.execute(db)

  await sql`CREATE INDEX IF NOT EXISTS idx_audit_security_events_log ON audit_security_events(audit_log_id);`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_security_events_type ON audit_security_events(security_event_type);`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_security_events_threat ON audit_security_events(threat_level);`.execute(db)

  await sql`CREATE INDEX IF NOT EXISTS idx_audit_compliance_log ON audit_compliance(audit_log_id);`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_compliance_regulation ON audit_compliance(regulation);`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_compliance_subject ON audit_compliance(data_subject_id);`.execute(db)

  await sql`CREATE INDEX IF NOT EXISTS idx_audit_performance_log ON audit_performance(audit_log_id);`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_performance_time ON audit_performance(total_time_ms);`.execute(db)

  await sql`CREATE INDEX IF NOT EXISTS idx_audit_exports_log ON audit_exports(audit_log_id);`.execute(db)
  await sql`CREATE INDEX IF NOT EXISTS idx_audit_exports_type ON audit_exports(export_type);`.execute(db)

  await sql`
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
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP VIEW IF EXISTS v_recent_security_events;`.execute(db)
  await sql`DROP VIEW IF EXISTS v_user_activity_summary;`.execute(db)
  await sql`DROP VIEW IF EXISTS v_compliance_overview;`.execute(db)

  await sql`DROP TRIGGER IF EXISTS trigger_set_retention ON audit_logs;`.execute(db)
  await sql`DROP FUNCTION IF EXISTS set_retention_period();`.execute(db)
  await sql`DROP FUNCTION IF EXISTS archive_old_audit_logs();`.execute(db)
  await sql`DROP FUNCTION IF EXISTS create_audit_partition();`.execute(db)

  await sql`DROP TABLE IF EXISTS audit_logs_archive;`.execute(db)
  await sql`DROP TABLE IF EXISTS audit_exports;`.execute(db)
  await sql`DROP TABLE IF EXISTS audit_performance;`.execute(db)
  await sql`DROP TABLE IF EXISTS audit_compliance;`.execute(db)
  await sql`DROP TABLE IF EXISTS audit_security_events;`.execute(db)
  await sql`DROP TABLE IF EXISTS audit_data_changes;`.execute(db)
  await sql`DROP TABLE IF EXISTS audit_retention_policies;`.execute(db)
  await sql`DROP TABLE IF EXISTS audit_report_configs;`.execute(db)
  await sql`DROP TABLE IF EXISTS audit_logs CASCADE;`.execute(db)
}
