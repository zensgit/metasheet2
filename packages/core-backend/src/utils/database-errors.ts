/**
 * Shared database error handling utilities.
 * Provides consistent error detection for database schema errors across the codebase.
 */

/**
 * Extended Error interface for PostgreSQL database errors.
 * PostgreSQL adds a `code` property with SQLSTATE error codes.
 */
export interface DatabaseError extends Error {
  code?: string
}

/**
 * Checks if an error is a database schema error (missing table/relation).
 * Used for graceful degradation when optional tables don't exist.
 *
 * PostgreSQL error code 42P01: undefined_table (relation does not exist)
 *
 * @param error - The error to check
 * @returns true if the error indicates a missing table/relation
 */
export function isDatabaseSchemaError(error: unknown): boolean {
  const dbError = error as DatabaseError

  // PostgreSQL SQLSTATE code for "undefined_table"
  if (dbError?.code === '42P01') return true

  // Fallback: check error message for common schema error patterns
  if (dbError?.message && typeof dbError.message === 'string') {
    const msg = dbError.message.toLowerCase()
    return (msg.includes('relation') || msg.includes('table')) && msg.includes('does not exist')
  }

  return false
}
