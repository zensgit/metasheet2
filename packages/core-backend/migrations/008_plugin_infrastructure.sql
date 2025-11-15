-- Migration: Plugin Infrastructure Tables
-- Description: Creates tables for comprehensive plugin management, configuration, and lifecycle
-- Date: 2024-09-24

-- Plugin Registry Table
-- Stores plugin registration information, metadata, and status
CREATE TABLE IF NOT EXISTS plugin_registry (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    version VARCHAR(50) NOT NULL,
    display_name VARCHAR(255),
    description TEXT,
    author VARCHAR(255),
    license VARCHAR(100),
    manifest JSONB NOT NULL,
    capabilities TEXT[] DEFAULT '{}',
    permissions TEXT[] DEFAULT '{}',
    dependencies JSONB DEFAULT '{}',
    status VARCHAR(50) NOT NULL DEFAULT 'installed' CHECK (status IN ('installed', 'enabled', 'disabled', 'error', 'loading', 'updating')),
    error_message TEXT,
    installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_activated TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Plugin Key-Value Storage Table
-- Provides persistent storage for plugin data
CREATE TABLE IF NOT EXISTS plugin_kv (
    plugin VARCHAR(255) NOT NULL,
    key VARCHAR(255) NOT NULL,
    value JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (plugin, key)
);

-- Plugin Configuration Schemas Table
-- Stores configuration schemas for plugins
CREATE TABLE IF NOT EXISTS plugin_config_schemas (
    id SERIAL PRIMARY KEY,
    plugin_name VARCHAR(255) NOT NULL UNIQUE,
    schema JSONB NOT NULL,
    version VARCHAR(50) NOT NULL DEFAULT '1.0.0',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (plugin_name) REFERENCES plugin_registry(name) ON DELETE CASCADE
);

-- Plugin Configuration Values Table
-- Stores actual configuration values with scope support
CREATE TABLE IF NOT EXISTS plugin_configs (
    id SERIAL PRIMARY KEY,
    plugin_name VARCHAR(255) NOT NULL,
    config_key VARCHAR(255) NOT NULL,
    value TEXT, -- Can be encrypted
    encrypted BOOLEAN NOT NULL DEFAULT FALSE,
    scope VARCHAR(50) NOT NULL DEFAULT 'global' CHECK (scope IN ('global', 'user', 'tenant')),
    user_id VARCHAR(255),
    tenant_id VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by VARCHAR(255),
    FOREIGN KEY (plugin_name) REFERENCES plugin_registry(name) ON DELETE CASCADE
);

-- Unique constraints using partial indexes for each scope
-- Global scope: only plugin_name and config_key matter
CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_configs_global
ON plugin_configs (plugin_name, config_key)
WHERE scope = 'global';

-- User scope: include user_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_configs_user
ON plugin_configs (plugin_name, config_key, user_id)
WHERE scope = 'user';

-- Tenant scope: include tenant_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_configs_tenant
ON plugin_configs (plugin_name, config_key, tenant_id)
WHERE scope = 'tenant';

-- Plugin Capabilities Table
-- Tracks capability registrations and implementations
CREATE TABLE IF NOT EXISTS plugin_capabilities (
    id SERIAL PRIMARY KEY,
    plugin_name VARCHAR(255) NOT NULL,
    capability VARCHAR(100) NOT NULL,
    implementation_class VARCHAR(255),
    priority INTEGER NOT NULL DEFAULT 0,
    metadata JSONB DEFAULT '{}',
    status VARCHAR(50) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'error')),
    registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (plugin_name, capability),
    FOREIGN KEY (plugin_name) REFERENCES plugin_registry(name) ON DELETE CASCADE
);

-- Plugin Events/Audit Log Table
-- Tracks plugin lifecycle events and API calls for auditing
CREATE TABLE IF NOT EXISTS plugin_events (
    id SERIAL PRIMARY KEY,
    plugin_name VARCHAR(255) NOT NULL,
    event_type VARCHAR(100) NOT NULL, -- installed, enabled, disabled, uninstalled, api_call, error
    event_data JSONB DEFAULT '{}',
    user_id VARCHAR(255),
    ip_address INET,
    user_agent TEXT,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plugin_events_plugin_name ON plugin_events(plugin_name);
CREATE INDEX IF NOT EXISTS idx_plugin_events_event_type ON plugin_events(event_type);
CREATE INDEX IF NOT EXISTS idx_plugin_events_timestamp ON plugin_events(timestamp);

-- Plugin Dependencies Table
-- Explicit tracking of plugin dependencies
CREATE TABLE IF NOT EXISTS plugin_dependencies (
    id SERIAL PRIMARY KEY,
    plugin_name VARCHAR(255) NOT NULL,
    dependency_name VARCHAR(255) NOT NULL,
    dependency_version VARCHAR(100) NOT NULL,
    dependency_type VARCHAR(50) NOT NULL DEFAULT 'required' CHECK (dependency_type IN ('required', 'optional', 'peer')),
    required_capabilities TEXT[] DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (plugin_name, dependency_name),
    FOREIGN KEY (plugin_name) REFERENCES plugin_registry(name) ON DELETE CASCADE
);

-- Plugin Metrics Table
-- Stores plugin usage and performance metrics
CREATE TABLE IF NOT EXISTS plugin_metrics (
    id SERIAL PRIMARY KEY,
    plugin_name VARCHAR(255) NOT NULL,
    metric_name VARCHAR(100) NOT NULL,
    metric_value NUMERIC,
    metric_data JSONB DEFAULT '{}',
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (plugin_name) REFERENCES plugin_registry(name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_plugin_metrics_plugin_name ON plugin_metrics(plugin_name);
CREATE INDEX IF NOT EXISTS idx_plugin_metrics_metric_name ON plugin_metrics(metric_name);
CREATE INDEX IF NOT EXISTS idx_plugin_metrics_timestamp ON plugin_metrics(timestamp);

-- Plugin Scheduled Jobs Table
-- Tracks scheduled jobs created by plugins
CREATE TABLE IF NOT EXISTS plugin_scheduled_jobs (
    id SERIAL PRIMARY KEY,
    plugin_name VARCHAR(255) NOT NULL,
    job_name VARCHAR(255) NOT NULL,
    cron_expression VARCHAR(100),
    delay_ms BIGINT,
    last_run TIMESTAMPTZ,
    next_run TIMESTAMPTZ,
    run_count INTEGER NOT NULL DEFAULT 0,
    is_running BOOLEAN NOT NULL DEFAULT FALSE,
    is_paused BOOLEAN NOT NULL DEFAULT FALSE,
    job_data JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (plugin_name, job_name),
    FOREIGN KEY (plugin_name) REFERENCES plugin_registry(name) ON DELETE CASCADE
);

-- Plugin Cache Entries Table
-- Optional: For plugins that need persistent cache storage
CREATE TABLE IF NOT EXISTS plugin_cache (
    cache_key VARCHAR(500) PRIMARY KEY,
    plugin_name VARCHAR(255) NOT NULL,
    value JSONB,
    tags TEXT[] DEFAULT '{}',
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plugin_cache_plugin_name ON plugin_cache(plugin_name);
CREATE INDEX IF NOT EXISTS idx_plugin_cache_expires_at ON plugin_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_plugin_cache_tags ON plugin_cache USING GIN(tags);

-- Plugin File Storage Table
-- Tracks files uploaded/managed by plugins
CREATE TABLE IF NOT EXISTS plugin_files (
    id VARCHAR(50) PRIMARY KEY, -- UUID or similar
    plugin_name VARCHAR(255) NOT NULL,
    filename VARCHAR(500) NOT NULL,
    original_filename VARCHAR(500) NOT NULL,
    content_type VARCHAR(200),
    size_bytes BIGINT NOT NULL,
    file_path TEXT NOT NULL,
    storage_provider VARCHAR(100) NOT NULL DEFAULT 'local', -- local, s3, etc.
    metadata JSONB DEFAULT '{}',
    tags JSONB DEFAULT '{}',
    is_public BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (plugin_name) REFERENCES plugin_registry(name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_plugin_files_plugin_name ON plugin_files(plugin_name);
CREATE INDEX IF NOT EXISTS idx_plugin_files_content_type ON plugin_files(content_type);
CREATE INDEX IF NOT EXISTS idx_plugin_files_created_at ON plugin_files(created_at);

-- Plugin Queue Jobs Table
-- Tracks background jobs queued by plugins
CREATE TABLE IF NOT EXISTS plugin_queue_jobs (
    id VARCHAR(50) PRIMARY KEY,
    plugin_name VARCHAR(255) NOT NULL,
    queue_name VARCHAR(255) NOT NULL,
    job_name VARCHAR(255) NOT NULL,
    job_data JSONB DEFAULT '{}',
    status VARCHAR(50) NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'active', 'completed', 'failed', 'delayed', 'paused')),
    progress INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 1,
    priority INTEGER NOT NULL DEFAULT 0,
    delay_ms BIGINT DEFAULT 0,
    timeout_ms BIGINT,
    return_value JSONB,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    FOREIGN KEY (plugin_name) REFERENCES plugin_registry(name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_plugin_queue_jobs_plugin_name ON plugin_queue_jobs(plugin_name);
CREATE INDEX IF NOT EXISTS idx_plugin_queue_jobs_status ON plugin_queue_jobs(status);
CREATE INDEX IF NOT EXISTS idx_plugin_queue_jobs_queue_name ON plugin_queue_jobs(queue_name);
CREATE INDEX IF NOT EXISTS idx_plugin_queue_jobs_created_at ON plugin_queue_jobs(created_at);

-- Plugin Notifications Table
-- Tracks notifications sent by plugins
CREATE TABLE IF NOT EXISTS plugin_notifications (
    id SERIAL PRIMARY KEY,
    plugin_name VARCHAR(255) NOT NULL,
    notification_id VARCHAR(100) NOT NULL,
    channel VARCHAR(100) NOT NULL, -- email, sms, webhook, etc.
    recipient_type VARCHAR(50) NOT NULL, -- user, email, phone, webhook
    recipient_id VARCHAR(255) NOT NULL,
    subject VARCHAR(500),
    content TEXT,
    status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'cancelled')),
    metadata JSONB DEFAULT '{}',
    sent_at TIMESTAMPTZ,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (plugin_name) REFERENCES plugin_registry(name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_plugin_notifications_plugin_name ON plugin_notifications(plugin_name);
CREATE INDEX IF NOT EXISTS idx_plugin_notifications_status ON plugin_notifications(status);
CREATE INDEX IF NOT EXISTS idx_plugin_notifications_channel ON plugin_notifications(channel);
CREATE INDEX IF NOT EXISTS idx_plugin_notifications_created_at ON plugin_notifications(created_at);

-- Plugin Security Audit Table
-- Enhanced security audit log for plugin operations
CREATE TABLE IF NOT EXISTS plugin_security_audit (
    id SERIAL PRIMARY KEY,
    plugin_name VARCHAR(255) NOT NULL,
    operation VARCHAR(100) NOT NULL, -- api_call, permission_check, resource_access, etc.
    resource_type VARCHAR(100), -- database, file, http, websocket, etc.
    resource_id VARCHAR(255),
    action VARCHAR(100) NOT NULL, -- read, write, execute, etc.
    result VARCHAR(50) NOT NULL CHECK (result IN ('allowed', 'denied', 'error')), -- allowed, denied, error
    user_id VARCHAR(255),
    ip_address INET,
    user_agent TEXT,
    request_data JSONB DEFAULT '{}',
    response_data JSONB DEFAULT '{}',
    error_message TEXT,
    severity VARCHAR(50) NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'error', 'critical')),
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plugin_security_audit_plugin_name ON plugin_security_audit(plugin_name);
CREATE INDEX IF NOT EXISTS idx_plugin_security_audit_operation ON plugin_security_audit(operation);
CREATE INDEX IF NOT EXISTS idx_plugin_security_audit_result ON plugin_security_audit(result);
CREATE INDEX IF NOT EXISTS idx_plugin_security_audit_severity ON plugin_security_audit(severity);
CREATE INDEX IF NOT EXISTS idx_plugin_security_audit_timestamp ON plugin_security_audit(timestamp);

-- Plugin WebSocket Connections Table
-- Tracks WebSocket connections managed by plugins
CREATE TABLE IF NOT EXISTS plugin_websocket_connections (
    id SERIAL PRIMARY KEY,
    plugin_name VARCHAR(255) NOT NULL,
    socket_id VARCHAR(100) NOT NULL,
    user_id VARCHAR(255),
    rooms TEXT[] DEFAULT '{}',
    connection_data JSONB DEFAULT '{}',
    connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_activity TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (plugin_name) REFERENCES plugin_registry(name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_plugin_websocket_connections_plugin_name ON plugin_websocket_connections(plugin_name);
CREATE INDEX IF NOT EXISTS idx_plugin_websocket_connections_socket_id ON plugin_websocket_connections(socket_id);
CREATE INDEX IF NOT EXISTS idx_plugin_websocket_connections_user_id ON plugin_websocket_connections(user_id);

-- Add indexes for better performance
CREATE INDEX IF NOT EXISTS idx_plugin_registry_status ON plugin_registry(status);
CREATE INDEX IF NOT EXISTS idx_plugin_registry_capabilities ON plugin_registry USING GIN(capabilities);
CREATE INDEX IF NOT EXISTS idx_plugin_registry_installed_at ON plugin_registry(installed_at);
CREATE INDEX IF NOT EXISTS idx_plugin_registry_last_activated ON plugin_registry(last_activated);

CREATE INDEX IF NOT EXISTS idx_plugin_kv_plugin ON plugin_kv(plugin);
CREATE INDEX IF NOT EXISTS idx_plugin_kv_updated_at ON plugin_kv(updated_at);

CREATE INDEX IF NOT EXISTS idx_plugin_configs_plugin_name ON plugin_configs(plugin_name);
CREATE INDEX IF NOT EXISTS idx_plugin_configs_scope ON plugin_configs(scope);
CREATE INDEX IF NOT EXISTS idx_plugin_configs_user_id ON plugin_configs(user_id) WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_plugin_capabilities_capability ON plugin_capabilities(capability);
CREATE INDEX IF NOT EXISTS idx_plugin_capabilities_status ON plugin_capabilities(status);

-- Add constraints and triggers for data integrity
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Add update triggers
DROP TRIGGER IF EXISTS update_plugin_registry_updated_at ON plugin_registry;
CREATE TRIGGER update_plugin_registry_updated_at BEFORE UPDATE ON plugin_registry FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_plugin_kv_updated_at ON plugin_kv;
CREATE TRIGGER update_plugin_kv_updated_at BEFORE UPDATE ON plugin_kv FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_plugin_config_schemas_updated_at ON plugin_config_schemas;
CREATE TRIGGER update_plugin_config_schemas_updated_at BEFORE UPDATE ON plugin_config_schemas FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_plugin_configs_updated_at ON plugin_configs;
CREATE TRIGGER update_plugin_configs_updated_at BEFORE UPDATE ON plugin_configs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_plugin_capabilities_updated_at ON plugin_capabilities;
CREATE TRIGGER update_plugin_capabilities_updated_at BEFORE UPDATE ON plugin_capabilities FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_plugin_scheduled_jobs_updated_at ON plugin_scheduled_jobs;
CREATE TRIGGER update_plugin_scheduled_jobs_updated_at BEFORE UPDATE ON plugin_scheduled_jobs FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_plugin_cache_updated_at ON plugin_cache;
CREATE TRIGGER update_plugin_cache_updated_at BEFORE UPDATE ON plugin_cache FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_plugin_files_updated_at ON plugin_files;
CREATE TRIGGER update_plugin_files_updated_at BEFORE UPDATE ON plugin_files FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Add cache cleanup function (can be called by a scheduled job)
CREATE OR REPLACE FUNCTION cleanup_expired_plugin_cache()
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM plugin_cache WHERE expires_at < NOW();
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Add plugin statistics view
CREATE OR REPLACE VIEW plugin_statistics AS
SELECT
    pr.name,
    pr.status,
    pr.version,
    pr.author,
    array_length(pr.capabilities, 1) as capability_count,
    array_length(pr.permissions, 1) as permission_count,
    pr.installed_at,
    pr.last_activated,
    COALESCE(config_count.count, 0) as config_count,
    COALESCE(kv_count.count, 0) as kv_storage_count,
    COALESCE(job_count.count, 0) as scheduled_job_count,
    COALESCE(file_count.count, 0) as file_count,
    COALESCE(file_size.total_size, 0) as total_file_size
FROM plugin_registry pr
LEFT JOIN (
    SELECT plugin_name, COUNT(*) as count
    FROM plugin_configs
    GROUP BY plugin_name
) config_count ON pr.name = config_count.plugin_name
LEFT JOIN (
    SELECT plugin, COUNT(*) as count
    FROM plugin_kv
    GROUP BY plugin
) kv_count ON pr.name = kv_count.plugin
LEFT JOIN (
    SELECT plugin_name, COUNT(*) as count
    FROM plugin_scheduled_jobs
    GROUP BY plugin_name
) job_count ON pr.name = job_count.plugin_name
LEFT JOIN (
    SELECT plugin_name, COUNT(*) as count
    FROM plugin_files
    GROUP BY plugin_name
) file_count ON pr.name = file_count.plugin_name
LEFT JOIN (
    SELECT plugin_name, SUM(size_bytes) as total_size
    FROM plugin_files
    GROUP BY plugin_name
) file_size ON pr.name = file_size.plugin_name;

-- Add plugin health check view
CREATE OR REPLACE VIEW plugin_health AS
SELECT
    pr.name,
    pr.status,
    pr.error_message,
    CASE
        WHEN pr.status = 'error' THEN 'unhealthy'
        WHEN pr.status = 'enabled' AND pr.last_activated > NOW() - INTERVAL '24 hours' THEN 'healthy'
        WHEN pr.status = 'enabled' AND pr.last_activated < NOW() - INTERVAL '24 hours' THEN 'stale'
        WHEN pr.status = 'disabled' THEN 'disabled'
        ELSE 'unknown'
    END as health_status,
    pr.last_activated,
    COALESCE(error_count.count, 0) as recent_errors
FROM plugin_registry pr
LEFT JOIN (
    SELECT plugin_name, COUNT(*) as count
    FROM plugin_events
    WHERE event_type = 'error'
    AND timestamp > NOW() - INTERVAL '1 hour'
    GROUP BY plugin_name
) error_count ON pr.name = error_count.plugin_name;

-- Insert initial system plugins if they don't exist
INSERT INTO plugin_registry (name, version, manifest, capabilities, permissions, status) VALUES
('system-core', '1.0.0', '{"name": "system-core", "version": "1.0.0", "description": "Core system plugin"}', '{"auth_provider", "permission_provider"}', '{"database.*", "http.*"}', 'enabled'),
('system-audit', '1.0.0', '{"name": "system-audit", "version": "1.0.0", "description": "System audit plugin"}', '{"background_task"}', '{"database.write", "events.emit"}', 'enabled')
ON CONFLICT (name) DO NOTHING;

-- Migration metadata
COMMENT ON TABLE plugin_registry IS 'Central registry for all plugins with metadata and status tracking';
COMMENT ON TABLE plugin_kv IS 'Key-value storage for plugin data with automatic namespacing';
COMMENT ON TABLE plugin_config_schemas IS 'Configuration schemas defining structure and validation for plugin configs';
COMMENT ON TABLE plugin_configs IS 'Actual configuration values with scope and encryption support';
COMMENT ON TABLE plugin_capabilities IS 'Registry of plugin capabilities and their implementations';
COMMENT ON TABLE plugin_events IS 'Audit trail of plugin lifecycle events and operations';
COMMENT ON TABLE plugin_dependencies IS 'Explicit plugin dependency relationships';
COMMENT ON TABLE plugin_metrics IS 'Performance and usage metrics for plugins';
COMMENT ON TABLE plugin_scheduled_jobs IS 'Scheduled jobs created and managed by plugins';
COMMENT ON TABLE plugin_cache IS 'Persistent cache storage for plugins with expiration support';
COMMENT ON TABLE plugin_files IS 'File storage tracking with metadata and provider abstraction';
COMMENT ON TABLE plugin_queue_jobs IS 'Background job queue with status tracking';
COMMENT ON TABLE plugin_notifications IS 'Multi-channel notification tracking';
COMMENT ON TABLE plugin_security_audit IS 'Security-focused audit log for plugin operations';
COMMENT ON TABLE plugin_websocket_connections IS 'WebSocket connection tracking for real-time features';