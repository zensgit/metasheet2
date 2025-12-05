import type { Kysely} from 'kysely';
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  // Plugin registry table for plugin metadata and status
  await db.schema
    .createTable('plugin_registry')
    .ifNotExists()
    .addColumn('id', 'serial', col => col.primaryKey())
    .addColumn('name', 'text', col => col.notNull().unique())
    .addColumn('display_name', 'text')
    .addColumn('description', 'text')
    .addColumn('version', 'text', col => col.notNull())
    .addColumn('author', 'text')
    .addColumn('license', 'text')
    .addColumn('manifest', 'jsonb', col => col.notNull())
    .addColumn('capabilities', 'jsonb', col => col.notNull().defaultTo(JSON.stringify([])))
    .addColumn('dependencies', 'jsonb', col => col.notNull().defaultTo(JSON.stringify([])))
    .addColumn('permissions', 'jsonb', col => col.notNull().defaultTo(JSON.stringify([])))
    .addColumn('status', 'text', col => col.notNull().defaultTo('installed'))
    .addColumn('error_message', 'text')
    .addColumn('installed_at', 'timestamptz', col => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('last_activated', 'timestamptz')
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`NOW()`))
    .execute()

  // Index on status for efficient filtering (conditional to avoid conflict with migration 008)
  await sql`CREATE INDEX IF NOT EXISTS idx_plugin_registry_status ON plugin_registry(status)`.execute(db)

  // Index on capabilities for capability-based queries (conditional to avoid conflict with migration 008)
  await sql`CREATE INDEX IF NOT EXISTS idx_plugin_registry_capabilities ON plugin_registry USING gin(capabilities)`.execute(db)

  // Plugin configurations table
  await db.schema
    .createTable('plugin_configs')
    .ifNotExists()
    .addColumn('id', 'serial', col => col.primaryKey())
    .addColumn('plugin_name', 'text', col => col.notNull().unique())
    .addColumn('config', 'jsonb', col => col.notNull().defaultTo(JSON.stringify({})))
    .addColumn('schema', 'jsonb')
    .addColumn('version', 'text', col => col.notNull().defaultTo('1.0.0'))
    .addColumn('last_modified', 'timestamptz', col => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('modified_by', 'text')
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`NOW()`))
    .execute()

  // Plugin configuration backups table
  await db.schema
    .createTable('plugin_config_backups')
    .ifNotExists()
    .addColumn('id', 'serial', col => col.primaryKey())
    .addColumn('backup_id', 'text', col => col.notNull().unique())
    .addColumn('plugin_name', 'text', col => col.notNull())
    .addColumn('config', 'jsonb', col => col.notNull())
    .addColumn('schema', 'jsonb')
    .addColumn('version', 'text', col => col.notNull())
    .addColumn('backup_timestamp', 'timestamptz', col => col.notNull().defaultTo(sql`NOW()`))
    .execute()

  // Index on plugin_name for efficient lookups
  await sql`CREATE INDEX IF NOT EXISTS idx_plugin_config_backups_plugin_name ON plugin_config_backups(plugin_name)`.execute(db)

  // Plugin security audit log table
  await db.schema
    .createTable('plugin_security_audit')
    .ifNotExists()
    .addColumn('id', 'serial', col => col.primaryKey())
    .addColumn('event_id', 'text', col => col.notNull().unique())
    .addColumn('plugin_name', 'text', col => col.notNull())
    .addColumn('event_type', 'text', col => col.notNull())
    .addColumn('resource', 'text')
    .addColumn('action', 'text')
    .addColumn('user_id', 'text')
    .addColumn('severity', 'text', col => col.notNull().defaultTo('info'))
    .addColumn('metadata', 'jsonb', col => col.notNull().defaultTo(JSON.stringify({})))
    .addColumn('timestamp', 'timestamptz', col => col.notNull().defaultTo(sql`NOW()`))
    .execute()

  // Indexes for efficient audit log queries
  await sql`CREATE INDEX IF NOT EXISTS idx_plugin_security_audit_plugin_name ON plugin_security_audit(plugin_name)`.execute(db)

  await sql`CREATE INDEX IF NOT EXISTS idx_plugin_security_audit_timestamp ON plugin_security_audit(timestamp)`.execute(db)

  await sql`CREATE INDEX IF NOT EXISTS idx_plugin_security_audit_severity ON plugin_security_audit(severity)`.execute(db)

  // Plugin resource usage table
  await db.schema
    .createTable('plugin_resource_usage')
    .ifNotExists()
    .addColumn('id', 'serial', col => col.primaryKey())
    .addColumn('plugin_name', 'text', col => col.notNull())
    .addColumn('resource_type', 'text', col => col.notNull())
    .addColumn('current_usage', 'real', col => col.notNull())
    .addColumn('limit_value', 'real', col => col.notNull())
    .addColumn('unit', 'text', col => col.notNull())
    .addColumn('timestamp', 'timestamptz', col => col.notNull().defaultTo(sql`NOW()`))
    .execute()

  // Index for efficient resource usage queries
  await sql`CREATE INDEX IF NOT EXISTS idx_plugin_resource_usage_plugin_name_timestamp ON plugin_resource_usage(plugin_name, timestamp)`.execute(db)

  // Plugin notification history table
  await db.schema
    .createTable('plugin_notification_history')
    .ifNotExists()
    .addColumn('id', 'serial', col => col.primaryKey())
    .addColumn('notification_id', 'text', col => col.notNull().unique())
    .addColumn('plugin_name', 'text')
    .addColumn('channel', 'text', col => col.notNull())
    .addColumn('recipients', 'jsonb', col => col.notNull())
    .addColumn('subject', 'text', col => col.notNull())
    .addColumn('content', 'text', col => col.notNull())
    .addColumn('data', 'jsonb')
    .addColumn('metadata', 'jsonb')
    .addColumn('status', 'text', col => col.notNull())
    .addColumn('sent_at', 'timestamptz')
    .addColumn('failed_reason', 'text')
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`NOW()`))
    .execute()

  // Index for efficient notification history queries
  await sql`CREATE INDEX IF NOT EXISTS idx_plugin_notification_history_plugin_name ON plugin_notification_history(plugin_name)`.execute(db)

  await sql`CREATE INDEX IF NOT EXISTS idx_plugin_notification_history_channel_status ON plugin_notification_history(channel, status)`.execute(db)

  // Plugin notification subscriptions table
  await db.schema
    .createTable('plugin_notification_subscriptions')
    .ifNotExists()
    .addColumn('id', 'serial', col => col.primaryKey())
    .addColumn('user_id', 'text', col => col.notNull())
    .addColumn('channel', 'text', col => col.notNull())
    .addColumn('preferences', 'jsonb', col => col.notNull().defaultTo(JSON.stringify({ enabled: true })))
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`NOW()`))
    .execute()

  // Unique constraint on user_id and channel
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_notification_subscriptions_user_channel ON plugin_notification_subscriptions(user_id, channel)`.execute(db)

  // Plugin job queue table (for enhanced queue service)
  await db.schema
    .createTable('plugin_job_queue')
    .ifNotExists()
    .addColumn('id', 'serial', col => col.primaryKey())
    .addColumn('job_id', 'text', col => col.notNull().unique())
    .addColumn('queue_name', 'text', col => col.notNull())
    .addColumn('job_name', 'text', col => col.notNull())
    .addColumn('plugin_name', 'text')
    .addColumn('data', 'jsonb', col => col.notNull())
    .addColumn('options', 'jsonb', col => col.notNull().defaultTo(JSON.stringify({})))
    .addColumn('status', 'text', col => col.notNull().defaultTo('waiting'))
    .addColumn('progress', 'integer', col => col.notNull().defaultTo(0))
    .addColumn('result', 'jsonb')
    .addColumn('error_message', 'text')
    .addColumn('attempts_made', 'integer', col => col.notNull().defaultTo(0))
    .addColumn('max_attempts', 'integer', col => col.notNull().defaultTo(3))
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('processed_at', 'timestamptz')
    .addColumn('finished_at', 'timestamptz')
    .addColumn('next_run_at', 'timestamptz')
    .execute()

  // Indexes for efficient job queue operations
  await sql`CREATE INDEX IF NOT EXISTS idx_plugin_job_queue_status_next_run ON plugin_job_queue(status, next_run_at)`.execute(db)

  await sql`CREATE INDEX IF NOT EXISTS idx_plugin_job_queue_queue_name ON plugin_job_queue(queue_name)`.execute(db)

  // Plugin scheduled jobs table
  await db.schema
    .createTable('plugin_scheduled_jobs')
    .ifNotExists()
    .addColumn('id', 'serial', col => col.primaryKey())
    .addColumn('job_name', 'text', col => col.notNull().unique())
    .addColumn('plugin_name', 'text', col => col.notNull())
    .addColumn('cron_expression', 'text')
    .addColumn('delay', 'integer')
    .addColumn('handler_code', 'text', col => col.notNull())
    .addColumn('options', 'jsonb', col => col.notNull().defaultTo(JSON.stringify({})))
    .addColumn('is_paused', 'boolean', col => col.notNull().defaultTo(false))
    .addColumn('run_count', 'integer', col => col.notNull().defaultTo(0))
    .addColumn('last_run', 'timestamptz')
    .addColumn('next_run', 'timestamptz')
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`NOW()`))
    .execute()

  // Index for scheduled job execution
  await sql`CREATE INDEX IF NOT EXISTS idx_plugin_scheduled_jobs_next_run ON plugin_scheduled_jobs(is_paused, next_run)`.execute(db)

  // Plugin file storage metadata table
  await db.schema
    .createTable('plugin_file_storage')
    .ifNotExists()
    .addColumn('id', 'serial', col => col.primaryKey())
    .addColumn('file_id', 'text', col => col.notNull().unique())
    .addColumn('plugin_name', 'text', col => col.notNull())
    .addColumn('filename', 'text', col => col.notNull())
    .addColumn('original_name', 'text', col => col.notNull())
    .addColumn('content_type', 'text', col => col.notNull())
    .addColumn('size', 'bigint', col => col.notNull())
    .addColumn('path', 'text', col => col.notNull())
    .addColumn('storage_provider', 'text', col => col.notNull().defaultTo('local'))
    .addColumn('metadata', 'jsonb', col => col.notNull().defaultTo(JSON.stringify({})))
    .addColumn('tags', 'jsonb', col => col.notNull().defaultTo(JSON.stringify({})))
    .addColumn('is_public', 'boolean', col => col.notNull().defaultTo(false))
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`NOW()`))
    .execute()

  // Index for plugin file queries
  await sql`CREATE INDEX IF NOT EXISTS idx_plugin_file_storage_plugin_name ON plugin_file_storage(plugin_name)`.execute(db)

  // Plugin rate limiting table
  await db.schema
    .createTable('plugin_rate_limits')
    .ifNotExists()
    .addColumn('id', 'serial', col => col.primaryKey())
    .addColumn('key', 'text', col => col.notNull().unique())
    .addColumn('plugin_name', 'text', col => col.notNull())
    .addColumn('resource', 'text', col => col.notNull())
    .addColumn('current_count', 'integer', col => col.notNull().defaultTo(0))
    .addColumn('max_requests', 'integer', col => col.notNull())
    .addColumn('window_ms', 'integer', col => col.notNull())
    .addColumn('reset_time', 'timestamptz', col => col.notNull())
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamptz', col => col.notNull().defaultTo(sql`NOW()`))
    .execute()

  // Index for rate limit checks
  await sql`CREATE INDEX IF NOT EXISTS idx_plugin_rate_limits_reset_time ON plugin_rate_limits(reset_time)`.execute(db)

  // Plugin cache entries table (for persistent cache)
  await db.schema
    .createTable('plugin_cache')
    .ifNotExists()
    .addColumn('id', 'serial', col => col.primaryKey())
    .addColumn('key', 'text', col => col.notNull().unique())
    .addColumn('plugin_name', 'text', col => col.notNull())
    .addColumn('value', 'jsonb', col => col.notNull())
    .addColumn('tags', 'jsonb', col => col.notNull().defaultTo(JSON.stringify([])))
    .addColumn('expires_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', col => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('accessed_at', 'timestamptz', col => col.notNull().defaultTo(sql`NOW()`))
    .execute()

  // Indexes for cache operations
  await sql`CREATE INDEX IF NOT EXISTS idx_plugin_cache_plugin_name ON plugin_cache(plugin_name)`.execute(db)

  await sql`CREATE INDEX IF NOT EXISTS idx_plugin_cache_expires_at ON plugin_cache(expires_at)`.execute(db)

  await sql`CREATE INDEX IF NOT EXISTS idx_plugin_cache_tags ON plugin_cache USING gin(tags)`.execute(db)

  // Add foreign key constraints where appropriate
  await db.schema
    .alterTable('plugin_configs')
    .addForeignKeyConstraint(
      'fk_plugin_configs_registry',
      ['plugin_name'],
      'plugin_registry',
      ['name']
    )
    .onDelete('cascade')
    .execute()

  await db.schema
    .alterTable('plugin_config_backups')
    .addForeignKeyConstraint(
      'fk_plugin_config_backups_registry',
      ['plugin_name'],
      'plugin_registry',
      ['name']
    )
    .onDelete('cascade')
    .execute()

  await db.schema
    .alterTable('plugin_security_audit')
    .addForeignKeyConstraint(
      'fk_plugin_security_audit_registry',
      ['plugin_name'],
      'plugin_registry',
      ['name']
    )
    .onDelete('cascade')
    .execute()

  await db.schema
    .alterTable('plugin_scheduled_jobs')
    .addForeignKeyConstraint(
      'fk_plugin_scheduled_jobs_registry',
      ['plugin_name'],
      'plugin_registry',
      ['name']
    )
    .onDelete('cascade')
    .execute()

  // Create trigger to update updated_at columns
  await sql`
    CREATE OR REPLACE FUNCTION update_updated_at_column()
    RETURNS TRIGGER AS $$
    BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
    END;
    $$ language 'plpgsql';
  `.execute(db)

  // Add triggers for tables that need updated_at maintenance (drop first to ensure idempotency)
  const tablesWithUpdatedAt = [
    'plugin_registry',
    'plugin_configs',
    'plugin_notification_subscriptions',
    'plugin_scheduled_jobs',
    'plugin_file_storage',
    'plugin_rate_limits'
  ]

  for (const table of tablesWithUpdatedAt) {
    await sql`DROP TRIGGER IF EXISTS update_${sql.raw(table)}_updated_at ON ${sql.raw(table)}`.execute(db)
    await sql`CREATE TRIGGER update_${sql.raw(table)}_updated_at BEFORE UPDATE ON ${sql.raw(table)} FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()`.execute(db)
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop triggers first
  const tablesWithUpdatedAt = [
    'plugin_registry',
    'plugin_configs',
    'plugin_notification_subscriptions',
    'plugin_scheduled_jobs',
    'plugin_file_storage',
    'plugin_rate_limits'
  ]

  for (const table of tablesWithUpdatedAt) {
    await sql`DROP TRIGGER IF EXISTS update_${sql.raw(table)}_updated_at ON ${sql.raw(table)}`.execute(db)
  }

  await sql`DROP FUNCTION IF EXISTS update_updated_at_column()`.execute(db)

  // Drop tables in reverse order to handle foreign key constraints
  await db.schema.dropTable('plugin_cache').ifExists().execute()
  await db.schema.dropTable('plugin_rate_limits').ifExists().execute()
  await db.schema.dropTable('plugin_file_storage').ifExists().execute()
  await db.schema.dropTable('plugin_scheduled_jobs').ifExists().execute()
  await db.schema.dropTable('plugin_job_queue').ifExists().execute()
  await db.schema.dropTable('plugin_notification_subscriptions').ifExists().execute()
  await db.schema.dropTable('plugin_notification_history').ifExists().execute()
  await db.schema.dropTable('plugin_resource_usage').ifExists().execute()
  await db.schema.dropTable('plugin_security_audit').ifExists().execute()
  await db.schema.dropTable('plugin_config_backups').ifExists().execute()
  await db.schema.dropTable('plugin_configs').ifExists().execute()
  await db.schema.dropTable('plugin_registry').ifExists().execute()
}
