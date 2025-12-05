/**
 * Event Bus System Tables Migration
 * Creates all tables required for the Event Bus system (Phase 1)
 */

import type { Kysely} from 'kysely';
import { sql } from 'kysely'

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. event_types - Event type definitions
  await db.schema
    .createTable('event_types')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`)
    )
    .addColumn('event_name', 'varchar(255)', (col) => col.notNull().unique())
    .addColumn('version', 'varchar(50)', (col) => col.notNull())
    .addColumn('payload_schema', 'jsonb')
    .addColumn('description', 'text')
    .addColumn('is_system', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('is_active', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('retention_days', 'integer', (col) => col.notNull().defaultTo(30))
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`)
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`)
    )
    .execute()

  // Index for active event types
  await db.schema
    .createIndex('idx_event_types_active')
    .on('event_types')
    .column('is_active')
    .execute()

  // 2. event_subscriptions - Event subscription registrations
  await db.schema
    .createTable('event_subscriptions')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`)
    )
    .addColumn('subscriber_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('event_pattern', 'varchar(500)', (col) => col.notNull())
    .addColumn('handler_config', 'jsonb', (col) => col.notNull())
    .addColumn('filter_expression', 'jsonb')
    .addColumn('retry_policy', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('priority', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('is_active', 'boolean', (col) => col.notNull().defaultTo(true))
    .addColumn('is_paused', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`)
    )
    .addColumn('updated_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`)
    )
    .execute()

  // Index for active subscriptions
  await db.schema
    .createIndex('idx_event_subscriptions_active')
    .on('event_subscriptions')
    .columns(['is_active', 'is_paused'])
    .execute()

  // Index for event pattern matching
  await db.schema
    .createIndex('idx_event_subscriptions_pattern')
    .on('event_subscriptions')
    .column('event_pattern')
    .execute()

  // 3. event_store - Event sourcing store
  await db.schema
    .createTable('event_store')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`)
    )
    .addColumn('event_id', 'varchar(255)', (col) => col.notNull().unique())
    .addColumn('event_name', 'varchar(255)', (col) => col.notNull())
    .addColumn('event_version', 'varchar(50)', (col) => col.notNull())
    .addColumn('payload', 'jsonb', (col) => col.notNull())
    .addColumn('source_id', 'varchar(255)')
    .addColumn('source_type', 'varchar(100)')
    .addColumn('correlation_id', 'varchar(255)')
    .addColumn('causation_id', 'varchar(255)')
    .addColumn('metadata', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('published_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`)
    )
    .addColumn('partition_key', 'varchar(255)')
    .addColumn('sequence_number', 'bigserial')
    .execute()

  // Indexes for event store queries
  await db.schema
    .createIndex('idx_event_store_name_published')
    .on('event_store')
    .columns(['event_name', 'published_at'])
    .execute()

  await db.schema
    .createIndex('idx_event_store_source')
    .on('event_store')
    .columns(['source_type', 'source_id'])
    .execute()

  await db.schema
    .createIndex('idx_event_store_correlation')
    .on('event_store')
    .column('correlation_id')
    .where('correlation_id', 'is not', null)
    .execute()

  // 4. event_deliveries - Event delivery tracking
  await db.schema
    .createTable('event_deliveries')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`)
    )
    .addColumn('event_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('subscription_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('subscriber_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('attempt_number', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('status', 'varchar(50)', (col) => col.notNull())
    .addColumn('error_message', 'text')
    .addColumn('delivered_at', 'timestamptz')
    .addColumn('retry_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`)
    )
    .execute()

  // Index for pending deliveries
  await db.schema
    .createIndex('idx_event_deliveries_pending')
    .on('event_deliveries')
    .columns(['status', 'retry_at'])
    .where('status', '=', sql`'PENDING'`)
    .execute()

  // Index for event delivery history
  await db.schema
    .createIndex('idx_event_deliveries_event')
    .on('event_deliveries')
    .column('event_id')
    .execute()

  // 5. event_replays - Event replay tracking
  await db.schema
    .createTable('event_replays')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`)
    )
    .addColumn('replay_name', 'varchar(255)', (col) => col.notNull())
    .addColumn('event_pattern', 'varchar(500)', (col) => col.notNull())
    .addColumn('start_time', 'timestamptz', (col) => col.notNull())
    .addColumn('end_time', 'timestamptz', (col) => col.notNull())
    .addColumn('status', 'varchar(50)', (col) => col.notNull())
    .addColumn('events_processed', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('events_total', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('created_by', 'varchar(255)', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`)
    )
    .addColumn('completed_at', 'timestamptz')
    .execute()

  // Index for active replays
  await db.schema
    .createIndex('idx_event_replays_status')
    .on('event_replays')
    .column('status')
    .execute()

  // 6. event_aggregates - Event aggregation metrics
  await db.schema
    .createTable('event_aggregates')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`)
    )
    .addColumn('event_name', 'varchar(255)', (col) => col.notNull())
    .addColumn('window_type', 'varchar(50)', (col) => col.notNull())
    .addColumn('window_start', 'timestamptz', (col) => col.notNull())
    .addColumn('window_end', 'timestamptz', (col) => col.notNull())
    .addColumn('count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('unique_sources', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('error_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('avg_payload_size', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('metadata', 'jsonb', (col) => col.notNull().defaultTo(sql`'{}'::jsonb`))
    .addColumn('created_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`)
    )
    .execute()

  // Unique constraint on aggregation window
  await db.schema
    .createIndex('idx_event_aggregates_unique')
    .unique()
    .on('event_aggregates')
    .columns(['event_name', 'window_type', 'window_start'])
    .execute()

  // 7. plugin_event_permissions - Plugin event access control
  await db.schema
    .createTable('plugin_event_permissions')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`)
    )
    .addColumn('plugin_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('event_name', 'varchar(255)', (col) => col.notNull())
    .addColumn('permission_type', 'varchar(50)', (col) => col.notNull())
    .addColumn('is_granted', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('granted_by', 'varchar(255)', (col) => col.notNull())
    .addColumn('granted_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`)
    )
    .execute()

  // Unique constraint on plugin-event-permission combination
  await db.schema
    .createIndex('idx_plugin_event_permissions_unique')
    .unique()
    .on('plugin_event_permissions')
    .columns(['plugin_id', 'event_name', 'permission_type'])
    .execute()

  // 8. dead_letter_events - Failed event delivery queue
  await db.schema
    .createTable('dead_letter_events')
    .addColumn('id', 'uuid', (col) =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()`)
    )
    .addColumn('event_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('subscription_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('subscriber_id', 'varchar(255)', (col) => col.notNull())
    .addColumn('event_data', 'jsonb', (col) => col.notNull())
    .addColumn('failure_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('last_error', 'text', (col) => col.notNull())
    .addColumn('moved_to_dlq_at', 'timestamptz', (col) =>
      col.notNull().defaultTo(sql`CURRENT_TIMESTAMP`)
    )
    .addColumn('resolved_at', 'timestamptz')
    .addColumn('resolved_by', 'varchar(255)')
    .execute()

  // Index for unresolved dead letter events
  await db.schema
    .createIndex('idx_dead_letter_events_unresolved')
    .on('dead_letter_events')
    .column('resolved_at')
    .where('resolved_at', 'is', null)
    .execute()

  console.log('✅ Event Bus tables created successfully')
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('dead_letter_events').ifExists().execute()
  await db.schema.dropTable('plugin_event_permissions').ifExists().execute()
  await db.schema.dropTable('event_aggregates').ifExists().execute()
  await db.schema.dropTable('event_replays').ifExists().execute()
  await db.schema.dropTable('event_deliveries').ifExists().execute()
  await db.schema.dropTable('event_store').ifExists().execute()
  await db.schema.dropTable('event_subscriptions').ifExists().execute()
  await db.schema.dropTable('event_types').ifExists().execute()

  console.log('✅ Event Bus tables dropped successfully')
}
