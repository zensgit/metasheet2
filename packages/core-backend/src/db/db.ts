/**
 * Database adapter for EventBusService
 * Provides Kysely instance for type-safe database queries
 */

import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'

// Database interface (can be extended as needed)
interface Database {
  event_types?: any
  event_subscriptions?: any
  event_history?: any
  event_deliveries?: any
  event_dlq?: any
  plugin_event_permissions?: any
  // Add other tables as needed
  [key: string]: any
}

// Create pg pool
const connectionString = process.env.DATABASE_URL || ''
const pool = connectionString
  ? new Pool({ connectionString })
  : undefined

// Create Kysely instance with PostgreSQL dialect
export const db = pool ? new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: pool
  })
}) : undefined as any

// Export pool for direct access if needed
export { pool }
