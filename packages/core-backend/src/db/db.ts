/**
 * Database adapter for EventBusService
 * Provides Kysely instance for type-safe database queries
 */

import { Kysely, PostgresDialect, Generated, ColumnType } from 'kysely'
import { Pool } from 'pg'

// ============================================
// Type-safe Database Schema Definitions
// ============================================

// Common column types
type Timestamp = ColumnType<Date, Date | string, Date | string>
type JsonValue = ColumnType<Record<string, unknown>, string | Record<string, unknown>, string | Record<string, unknown>>

// Event System Tables
interface EventTypesTable {
  id: Generated<string>
  name: string
  description: string | null
  schema: JsonValue | null
  created_at: Timestamp
  updated_at: Timestamp
}

interface EventSubscriptionsTable {
  id: Generated<string>
  event_type: string
  subscriber_id: string
  subscriber_type: string
  filter: JsonValue | null
  priority: number
  enabled: boolean
  created_at: Timestamp
  updated_at: Timestamp
}

interface EventHistoryTable {
  id: Generated<string>
  event_id: string
  event_type: string
  payload: JsonValue
  source_id: string | null
  source_type: string | null
  correlation_id: string | null
  created_at: Timestamp
}

interface EventDeliveriesTable {
  id: Generated<string>
  event_id: string
  subscription_id: string
  status: 'pending' | 'delivered' | 'failed'
  attempts: number
  last_error: string | null
  delivered_at: Timestamp | null
  created_at: Timestamp
}

interface EventDlqTable {
  id: Generated<string>
  event_id: string
  subscription_id: string
  error: string
  payload: JsonValue
  created_at: Timestamp
}

interface PluginEventPermissionsTable {
  id: Generated<string>
  plugin_id: string
  event_pattern: string
  permission_type: 'subscribe' | 'emit'
  created_at: Timestamp
}

// Spreadsheet Tables
interface SpreadsheetTable {
  id: Generated<string>
  name: string
  description: string | null
  owner_id: string
  workspace_id: string | null
  is_template: boolean
  template_id: string | null
  settings: JsonValue
  metadata: JsonValue
  created_by: string
  created_at: Timestamp
  updated_at: Timestamp
}

interface SheetTable {
  id: Generated<string>
  spreadsheet_id: string
  name: string
  order_index: number
  row_count: number
  column_count: number
  frozen_rows: number
  frozen_columns: number
  hidden_rows: JsonValue
  hidden_columns: JsonValue
  row_heights: JsonValue
  column_widths: JsonValue
  config: JsonValue
  created_at: Timestamp
  updated_at: Timestamp
}

interface CellTable {
  id: Generated<string>
  sheet_id: string
  row_index: number
  column_index: number
  cell_ref: string
  value: string | number | boolean | null
  formula: string | null
  format: JsonValue
  data_type: string
  display_value: string | null
  locked: boolean
  metadata: JsonValue
  needs_recalc: boolean
  updated_at: Timestamp
}

interface CellVersionTable {
  id: Generated<string>
  cell_id: string
  sheet_id: string
  version_number: number
  value: string | number | boolean | null
  formula: string | null
  format: JsonValue
  change_type: string
  created_at: Timestamp
}

interface FormulaTable {
  id: Generated<string>
  cell_id: string
  sheet_id: string
  formula_text: string
  dependencies: string[]
  dependents: string[]
  is_volatile: boolean
  created_at: Timestamp
  updated_at: Timestamp
}

// View Tables
interface ViewTable {
  id: Generated<string>
  spreadsheet_id: string
  name: string
  type: string
  config: JsonValue
  created_at: Timestamp
  updated_at: Timestamp
}

interface FormResponseTable {
  id: Generated<string>
  form_id: string
  response_data: string
  submitted_at: Timestamp
  submitted_by: string | null
  ip_address: string | null
  status: string
}

// User Tables
interface UserTable {
  id: Generated<string>
  email: string
  password_hash: string
  name: string
  role: string
  permissions: string[]
  created_at: Timestamp
  updated_at: Timestamp
}

// Database interface with all tables
interface Database {
  // Event system
  event_types: EventTypesTable
  event_subscriptions: EventSubscriptionsTable
  event_history: EventHistoryTable
  event_deliveries: EventDeliveriesTable
  event_dlq: EventDlqTable
  plugin_event_permissions: PluginEventPermissionsTable

  // Spreadsheet system
  spreadsheets: SpreadsheetTable
  sheets: SheetTable
  cells: CellTable
  cell_versions: CellVersionTable
  formulas: FormulaTable

  // View system
  views: ViewTable
  form_responses: FormResponseTable

  // User system
  users: UserTable

  // Allow dynamic table access for extensibility
  [key: string]: unknown
}

// Export types for use in other modules
export type {
  Database,
  EventTypesTable,
  EventSubscriptionsTable,
  SpreadsheetTable,
  SheetTable,
  CellTable,
  CellVersionTable,
  FormulaTable,
  ViewTable,
  UserTable
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

export function isDatabaseConfigured(): boolean {
  return !!process.env.DATABASE_URL
}

export async function getDbHealth(): Promise<{ connected: boolean; pool?: any }> {
  if (!pool) {
    return { connected: false }
  }
  try {
    const client = await pool.connect()
    client.release()
    return { connected: true, pool }
  } catch (e) {
    return { connected: false }
  }
}
