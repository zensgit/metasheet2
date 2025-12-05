/**
 * Kysely type definitions
 * Shared types for Kysely query builder compatibility
 */

/**
 * Expression builder interface for Kysely where clauses
 * Used for complex query conditions like or/and
 */
export interface ExpressionBuilder {
  or: (conditions: unknown[]) => unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (column: string, operator: string, value: any): unknown
}

/**
 * OnConflict builder interface for upsert operations
 */
export interface OnConflictBuilder {
  columns: (cols: string[]) => {
    doUpdateSet: (updates: Record<string, unknown>) => unknown
  }
}
