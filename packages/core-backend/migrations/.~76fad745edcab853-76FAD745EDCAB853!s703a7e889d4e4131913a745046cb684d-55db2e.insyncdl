-- Migration: 040_data_sources.sql
-- Description: Create tables for external data source configuration and management
-- Author: Claude
-- Date: 2024

-- Data source configurations
CREATE TABLE IF NOT EXISTS data_sources (
    id VARCHAR(100) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL, -- postgresql, mysql, mongodb, http, graphql, etc.
    status VARCHAR(20) DEFAULT 'active', -- active, inactive, error
    connection JSONB NOT NULL, -- Connection configuration
    credentials JSONB, -- Encrypted credentials
    options JSONB, -- Additional options
    pool_config JSONB, -- Connection pool settings

    -- Metadata
    created_by VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_by VARCHAR(100),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_connected_at TIMESTAMP WITH TIME ZONE,
    last_error TEXT,

    -- Indexes
    CONSTRAINT unique_data_source_name UNIQUE (name)
);

CREATE INDEX IF NOT EXISTS idx_data_sources_type ON data_sources(type);
CREATE INDEX IF NOT EXISTS idx_data_sources_status ON data_sources(status);
CREATE INDEX IF NOT EXISTS idx_data_sources_created_at ON data_sources(created_at);

-- Data source schemas cache
CREATE TABLE IF NOT EXISTS data_source_schemas (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    data_source_id VARCHAR(100) REFERENCES data_sources(id) ON DELETE CASCADE,
    schema_name VARCHAR(255),
    table_name VARCHAR(255),
    columns JSONB, -- Array of column definitions
    indexes JSONB, -- Array of index definitions
    foreign_keys JSONB, -- Array of foreign key definitions
    metadata JSONB, -- Additional metadata

    -- Cache management
    cached_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE,

    CONSTRAINT unique_schema_table UNIQUE (data_source_id, schema_name, table_name)
);

CREATE INDEX IF NOT EXISTS idx_data_source_schemas_source ON data_source_schemas(data_source_id);
CREATE INDEX IF NOT EXISTS idx_data_source_schemas_expires ON data_source_schemas(expires_at);

-- Query templates for reusable queries
CREATE TABLE IF NOT EXISTS query_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    data_source_id VARCHAR(100) REFERENCES data_sources(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    query_type VARCHAR(50), -- select, insert, update, delete, custom
    template TEXT NOT NULL, -- SQL or query template
    parameters JSONB, -- Parameter definitions
    options JSONB, -- Query options

    -- Usage tracking
    use_count INTEGER DEFAULT 0,
    last_used_at TIMESTAMP WITH TIME ZONE,

    -- Metadata
    created_by VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_by VARCHAR(100),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    CONSTRAINT unique_template_name UNIQUE (data_source_id, name)
);

CREATE INDEX IF NOT EXISTS idx_query_templates_source ON query_templates(data_source_id);
CREATE INDEX IF NOT EXISTS idx_query_templates_type ON query_templates(query_type);

-- Query execution history
CREATE TABLE IF NOT EXISTS query_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    data_source_id VARCHAR(100) REFERENCES data_sources(id) ON DELETE CASCADE,
    template_id UUID REFERENCES query_templates(id) ON DELETE SET NULL,
    query TEXT NOT NULL,
    parameters JSONB,

    -- Execution details
    executed_by VARCHAR(100),
    executed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    duration_ms INTEGER,
    row_count INTEGER,
    error TEXT,

    -- Result caching
    result_cached BOOLEAN DEFAULT FALSE,
    cache_key VARCHAR(255),
    cache_expires_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_query_history_source ON query_history(data_source_id);
CREATE INDEX IF NOT EXISTS idx_query_history_template ON query_history(template_id);
CREATE INDEX IF NOT EXISTS idx_query_history_executed_at ON query_history(executed_at);
CREATE INDEX IF NOT EXISTS idx_query_history_cache_key ON query_history(cache_key);

-- Data synchronization jobs
CREATE TABLE IF NOT EXISTS data_sync_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    source_id VARCHAR(100) REFERENCES data_sources(id) ON DELETE CASCADE,
    source_query TEXT,
    target_id VARCHAR(100) REFERENCES data_sources(id) ON DELETE CASCADE,
    target_table VARCHAR(255),

    -- Sync configuration
    sync_type VARCHAR(50), -- full, incremental, upsert
    sync_mode VARCHAR(50), -- manual, scheduled, realtime
    schedule_cron VARCHAR(100), -- Cron expression for scheduled syncs
    transform_script TEXT, -- Optional transformation script
    conflict_resolution VARCHAR(50), -- ignore, update, error

    -- State
    status VARCHAR(20) DEFAULT 'inactive', -- active, inactive, running, error
    last_sync_at TIMESTAMP WITH TIME ZONE,
    last_sync_rows INTEGER,
    last_sync_duration_ms INTEGER,
    last_error TEXT,

    -- Metadata
    created_by VARCHAR(100),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_by VARCHAR(100),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_data_sync_jobs_source ON data_sync_jobs(source_id);
CREATE INDEX IF NOT EXISTS idx_data_sync_jobs_target ON data_sync_jobs(target_id);
CREATE INDEX IF NOT EXISTS idx_data_sync_jobs_status ON data_sync_jobs(status);

-- Data sync history
CREATE TABLE IF NOT EXISTS data_sync_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id UUID REFERENCES data_sync_jobs(id) ON DELETE CASCADE,

    -- Execution details
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE,
    status VARCHAR(20), -- running, completed, failed, cancelled

    -- Statistics
    rows_read INTEGER DEFAULT 0,
    rows_inserted INTEGER DEFAULT 0,
    rows_updated INTEGER DEFAULT 0,
    rows_deleted INTEGER DEFAULT 0,
    rows_failed INTEGER DEFAULT 0,

    -- Error tracking
    errors JSONB, -- Array of error details
    warning_count INTEGER DEFAULT 0,

    -- Performance
    duration_ms INTEGER,
    avg_row_processing_ms DECIMAL(10, 2)
);

CREATE INDEX IF NOT EXISTS idx_data_sync_history_job ON data_sync_history(job_id);
CREATE INDEX IF NOT EXISTS idx_data_sync_history_started ON data_sync_history(started_at);
CREATE INDEX IF NOT EXISTS idx_data_sync_history_status ON data_sync_history(status);

-- Connection pool metrics
CREATE TABLE IF NOT EXISTS connection_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    data_source_id VARCHAR(100) REFERENCES data_sources(id) ON DELETE CASCADE,
    recorded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Pool statistics
    active_connections INTEGER,
    idle_connections INTEGER,
    waiting_requests INTEGER,
    total_connections INTEGER,

    -- Performance metrics
    avg_connection_time_ms DECIMAL(10, 2),
    avg_query_time_ms DECIMAL(10, 2),
    queries_per_second DECIMAL(10, 2),

    -- Error metrics
    connection_errors INTEGER DEFAULT 0,
    query_errors INTEGER DEFAULT 0,
    timeout_errors INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_connection_metrics_source ON connection_metrics(data_source_id);
CREATE INDEX IF NOT EXISTS idx_connection_metrics_recorded ON connection_metrics(recorded_at);

-- Create update trigger for updated_at
CREATE OR REPLACE FUNCTION update_data_source_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_data_sources_updated_at
    BEFORE UPDATE ON data_sources
    FOR EACH ROW
    EXECUTE FUNCTION update_data_source_timestamp();

CREATE TRIGGER update_query_templates_updated_at
    BEFORE UPDATE ON query_templates
    FOR EACH ROW
    EXECUTE FUNCTION update_data_source_timestamp();

CREATE TRIGGER update_data_sync_jobs_updated_at
    BEFORE UPDATE ON data_sync_jobs
    FOR EACH ROW
    EXECUTE FUNCTION update_data_source_timestamp();
