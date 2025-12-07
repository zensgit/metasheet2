/**
 * Migration: Create Data Sources Table
 *
 * Purpose: Persistent storage for external data source configurations
 * Tables: data_sources, data_source_connections
 * Breaking: No
 */

import type { Kysely } from 'kysely'
import { sql } from 'kysely'
import { checkTableExists } from './_patterns'

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Create data_sources table
  const dataSourcesExists = await checkTableExists(db, 'data_sources')

  if (!dataSourcesExists) {
    console.log('[Migration] Creating table: data_sources')

    await db.schema
      .createTable('data_sources')
      .ifNotExists()
      .addColumn('id', 'text', col =>
        col.primaryKey().defaultTo(sql`gen_random_uuid()::text`)
      )
      .addColumn('name', 'text', col => col.notNull())
      .addColumn('type', 'text', col => col.notNull()) // postgres, mysql, mongodb, http, redis, elasticsearch
      .addColumn('description', 'text')
      // Connection config (encrypted sensitive fields like password)
      .addColumn('config', 'jsonb', col => col.notNull())
      // Connection status
      .addColumn('status', 'text', col =>
        col.notNull().defaultTo('disconnected')
      ) // connected, disconnected, error
      .addColumn('last_connected_at', 'timestamptz')
      .addColumn('last_error', 'text')
      // Ownership and access control
      .addColumn('owner_id', 'text', col => col.notNull())
      .addColumn('workspace_id', 'text')
      // Feature flags
      .addColumn('is_active', 'boolean', col => col.notNull().defaultTo(true))
      .addColumn('auto_connect', 'boolean', col =>
        col.notNull().defaultTo(false)
      )
      // Metadata
      .addColumn('metadata', 'jsonb')
      .addColumn('tags', 'jsonb') // Array of tags for filtering
      // Timestamps
      .addColumn('created_at', 'timestamptz', col =>
        col.notNull().defaultTo(sql`NOW()`)
      )
      .addColumn('updated_at', 'timestamptz', col =>
        col.notNull().defaultTo(sql`NOW()`)
      )
      .addColumn('deleted_at', 'timestamptz') // Soft delete
      .execute()

    console.log('[Migration] Table data_sources created')

    // Create indexes
    await db.schema
      .createIndex('idx_data_sources_type')
      .ifNotExists()
      .on('data_sources')
      .column('type')
      .execute()

    await db.schema
      .createIndex('idx_data_sources_owner_id')
      .ifNotExists()
      .on('data_sources')
      .column('owner_id')
      .execute()

    await db.schema
      .createIndex('idx_data_sources_workspace_id')
      .ifNotExists()
      .on('data_sources')
      .column('workspace_id')
      .execute()

    await db.schema
      .createIndex('idx_data_sources_status')
      .ifNotExists()
      .on('data_sources')
      .column('status')
      .execute()

    await db.schema
      .createIndex('idx_data_sources_active')
      .ifNotExists()
      .on('data_sources')
      .columns(['is_active', 'deleted_at'])
      .execute()

    console.log('[Migration] Indexes for data_sources created')
  } else {
    console.log('[Migration] Table data_sources already exists, skipping')
  }

  // 2. Create data_source_connections table (connection pool tracking)
  const connectionsExists = await checkTableExists(db, 'data_source_connections')

  if (!connectionsExists) {
    console.log('[Migration] Creating table: data_source_connections')

    await db.schema
      .createTable('data_source_connections')
      .ifNotExists()
      .addColumn('id', 'text', col =>
        col.primaryKey().defaultTo(sql`gen_random_uuid()::text`)
      )
      .addColumn('data_source_id', 'text', col =>
        col.notNull().references('data_sources.id').onDelete('cascade')
      )
      // Connection pool stats
      .addColumn('pool_size', 'integer', col => col.notNull().defaultTo(0))
      .addColumn('active_connections', 'integer', col =>
        col.notNull().defaultTo(0)
      )
      .addColumn('idle_connections', 'integer', col =>
        col.notNull().defaultTo(0)
      )
      .addColumn('waiting_requests', 'integer', col =>
        col.notNull().defaultTo(0)
      )
      // Performance metrics
      .addColumn('total_queries', 'bigint', col => col.notNull().defaultTo(0))
      .addColumn('failed_queries', 'bigint', col => col.notNull().defaultTo(0))
      .addColumn('avg_query_time_ms', 'real')
      .addColumn('last_query_at', 'timestamptz')
      // Health check
      .addColumn('health_status', 'text', col =>
        col.notNull().defaultTo('unknown')
      ) // healthy, degraded, unhealthy, unknown
      .addColumn('last_health_check_at', 'timestamptz')
      // Timestamps
      .addColumn('created_at', 'timestamptz', col =>
        col.notNull().defaultTo(sql`NOW()`)
      )
      .addColumn('updated_at', 'timestamptz', col =>
        col.notNull().defaultTo(sql`NOW()`)
      )
      .execute()

    console.log('[Migration] Table data_source_connections created')

    // Create indexes
    await db.schema
      .createIndex('idx_data_source_connections_source_id')
      .ifNotExists()
      .on('data_source_connections')
      .column('data_source_id')
      .execute()

    await db.schema
      .createIndex('idx_data_source_connections_health')
      .ifNotExists()
      .on('data_source_connections')
      .column('health_status')
      .execute()

    console.log('[Migration] Indexes for data_source_connections created')
  } else {
    console.log(
      '[Migration] Table data_source_connections already exists, skipping'
    )
  }

  // 3. Create data_source_query_logs table (audit trail)
  const logsExists = await checkTableExists(db, 'data_source_query_logs')

  if (!logsExists) {
    console.log('[Migration] Creating table: data_source_query_logs')

    await db.schema
      .createTable('data_source_query_logs')
      .ifNotExists()
      .addColumn('id', 'text', col =>
        col.primaryKey().defaultTo(sql`gen_random_uuid()::text`)
      )
      .addColumn('data_source_id', 'text', col =>
        col.notNull().references('data_sources.id').onDelete('cascade')
      )
      .addColumn('user_id', 'text', col => col.notNull())
      // Query details
      .addColumn('query_type', 'text', col => col.notNull()) // select, insert, update, delete, raw
      .addColumn('query_hash', 'text') // For deduplication/caching
      .addColumn('query_text', 'text') // Sanitized query (no sensitive data)
      .addColumn('parameters', 'jsonb') // Parameterized values (sanitized)
      // Results
      .addColumn('row_count', 'integer')
      .addColumn('execution_time_ms', 'real')
      .addColumn('status', 'text', col => col.notNull()) // success, error, timeout, cancelled
      .addColumn('error_message', 'text')
      // Context
      .addColumn('ip_address', sql`inet`)
      .addColumn('user_agent', 'text')
      .addColumn('request_id', 'text')
      // Timestamp
      .addColumn('executed_at', 'timestamptz', col =>
        col.notNull().defaultTo(sql`NOW()`)
      )
      .execute()

    console.log('[Migration] Table data_source_query_logs created')

    // Create indexes
    await db.schema
      .createIndex('idx_data_source_query_logs_source_id')
      .ifNotExists()
      .on('data_source_query_logs')
      .column('data_source_id')
      .execute()

    await db.schema
      .createIndex('idx_data_source_query_logs_user_id')
      .ifNotExists()
      .on('data_source_query_logs')
      .column('user_id')
      .execute()

    await db.schema
      .createIndex('idx_data_source_query_logs_executed_at')
      .ifNotExists()
      .on('data_source_query_logs')
      .column('executed_at')
      .execute()

    await db.schema
      .createIndex('idx_data_source_query_logs_status')
      .ifNotExists()
      .on('data_source_query_logs')
      .column('status')
      .execute()

    console.log('[Migration] Indexes for data_source_query_logs created')
  } else {
    console.log(
      '[Migration] Table data_source_query_logs already exists, skipping'
    )
  }

  console.log('[Migration] Data sources migration completed successfully')
}

export async function down(db: Kysely<unknown>): Promise<void> {
  console.log('[Migration] Rolling back data sources tables')

  // Drop in reverse order (dependencies first)
  await db.schema.dropTable('data_source_query_logs').ifExists().execute()
  console.log('[Migration] Dropped data_source_query_logs')

  await db.schema.dropTable('data_source_connections').ifExists().execute()
  console.log('[Migration] Dropped data_source_connections')

  await db.schema.dropTable('data_sources').ifExists().execute()
  console.log('[Migration] Dropped data_sources')

  console.log('[Migration] Rollback completed successfully')
}
