/**
 * Type helpers for Kysely database operations
 *
 * These helpers solve common type issues when working with Kysely:
 * 1. Date type conversions for timestamp columns
 * 2. JSON value serialization for JSONB columns
 */

import { sql, type RawBuilder } from 'kysely'

/**
 * Converts a JavaScript Date to a Kysely-compatible SQL value for timestamp columns.
 *
 * Use this when updating timestamp columns that have UpdatedAt or NullableTimestamp types.
 *
 * @example
 * ```typescript
 * await db.updateTable('users')
 *   .set({ updated_at: toDateValue(new Date()) })
 *   .where('id', '=', userId)
 *   .execute()
 * ```
 */
export function toDateValue(date: Date): RawBuilder<Date>
export function toDateValue(date: null | undefined): null
export function toDateValue(date: Date | null | undefined): RawBuilder<Date> | null
export function toDateValue(date: Date | null | undefined): RawBuilder<Date> | null {
  if (date == null) return null
  return sql<Date>`${date.toISOString()}::timestamptz`
}

/**
 * Converts a JavaScript object to a Kysely-compatible SQL value for JSONB columns.
 *
 * Use this when inserting/updating JSONB columns that require explicit JSON casting.
 * Note: In most cases, Kysely handles JSON columns automatically via JSONColumnType.
 * Only use this if you encounter type errors with JSON columns.
 *
 * @example
 * ```typescript
 * await db.updateTable('configs')
 *   .set({ settings: toJsonValue({ theme: 'dark' }) })
 *   .where('id', '=', configId)
 *   .execute()
 * ```
 */
export function toJsonValue<T>(value: T): RawBuilder<T> {
  return sql<T>`${JSON.stringify(value)}::jsonb`
}

/**
 * Converts a value to an ISO date string for insertion into timestamp columns.
 *
 * Use this when inserting new records where the timestamp column expects a string.
 *
 * @example
 * ```typescript
 * await db.insertInto('events')
 *   .values({ created_at: toISOString(new Date()) })
 *   .execute()
 * ```
 */
export function toISOString(date: Date): string
export function toISOString(date: null | undefined): undefined
export function toISOString(date: Date | null | undefined): string | undefined
export function toISOString(date: Date | null | undefined): string | undefined {
  if (date == null) return undefined
  return date.toISOString()
}

/**
 * Creates a "now" timestamp for database operations.
 *
 * @example
 * ```typescript
 * await db.updateTable('users')
 *   .set({ last_login_at: nowTimestamp() })
 *   .execute()
 * ```
 */
export function nowTimestamp(): RawBuilder<Date> {
  return sql<Date>`now()`
}
